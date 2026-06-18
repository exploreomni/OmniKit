import { createHash, randomUUID } from 'node:crypto';
import { OmniClient, OmniClientError } from './omniClient';
import {
  getInstance,
  type PostMigrationAction,
  type SavedInstance,
} from './nativeVault';
import {
  clearJobs as clearStoredJobs,
  getJob as getStoredJob,
  insertJob,
  listJobs as listStoredJobs,
  updateJobItem,
  updateJobStatus,
} from './jobStore';
import {
  publishMigrationJobEvent,
} from './jobEvents';
import {
  sanitizeJob,
  sanitizePostMigrationAction,
} from './jobSanitizer';
import {
  buildFieldUniverseFromYaml,
  buildWorkbookTabResultDetails,
  collectFieldReferences,
  normalizeContentValidationIssues,
  preflightWorkbookQueryFields,
  rewriteQueryModelReferences,
} from './modelMigration/helpers';
import { validatePostMigrationActionTarget } from './postMigrationActions';

export { redactSensitiveText, sanitizeJobHistory } from './jobSanitizer';

const DEFAULT_DESTINATION_CONCURRENCY = 10;

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'canceled';
export type JobItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'warning' | 'skipped';
export type MigrationWorkflow = 'dashboard' | 'model';
export type JobItemKind =
  | 'delete'
  | 'export'
  | 'import'
  | 'metadata'
  | 'post_action'
  | 'model_fast_path'
  | 'model_translate'
  | 'model_branch_create'
  | 'model_yaml_write'
  | 'model_validate'
  | 'model_merge'
  | 'content_validate'
  | 'workbook_queries'
  | 'workbook_preflight'
  | 'workbook_create'
  | 'dashboard_handoff';

export interface MigrationJobItem {
  id: string;
  jobId: string;
  targetId?: string;
  destinationId: string;
  destinationLabel: string;
  targetModelId?: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
  kind: JobItemKind;
  documentId?: string;
  documentName?: string;
  replacement?: boolean;
  status: JobItemStatus;
  error?: string;
  warnings?: string[];
  startedAt?: number;
  endedAt?: number;
  exportHash?: string;
  importedIdentifier?: string;
  importedDocumentId?: string;
  details?: Record<string, unknown>;
}

export interface MigrationJob {
  id: string;
  workflow?: MigrationWorkflow;
  sourceId: string;
  sourceLabel: string;
  destinationIds: string[];
  targets?: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  postMigrationActions: PostMigrationAction[];
  status: JobStatus;
  parentJobId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  details?: Record<string, unknown>;
  items: MigrationJobItem[];
}

export interface MigrationPlanStep {
  targetId?: string;
  destinationId: string;
  destinationLabel: string;
  targetModelId?: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
  kind: JobItemKind;
  documentId?: string;
  documentName?: string;
  replacement?: boolean;
  warnings?: string[];
}

export interface MigrationPlan {
  sourceId: string;
  sourceLabel: string;
  destinationIds: string[];
  targets: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  steps: MigrationPlanStep[];
}

export interface MigrationTarget {
  id: string;
  destinationInstanceId: string;
  destinationLabel?: string;
  targetModelId: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
}

interface SourceMeta {
  description?: string | null;
  labels: string[];
}

export interface ModelMigrationAcceptedFile {
  fileName: string;
  yaml: string;
  previousChecksum?: string;
}

export interface ModelMigrationModelInput {
  sourceModelId: string;
  sourceModelName?: string;
  targetModelId: string;
  targetModelName?: string;
  targetConnectionId: string;
  mode: 'fast' | 'translate';
  branchName: string;
  gitRef?: string;
  fastPathSchemaConfirmed?: boolean;
  mergeHandoffRequired?: boolean;
  acceptedFiles?: ModelMigrationAcceptedFile[];
}

export interface ModelMigrationContentInput {
  documentId: string;
  documentName: string;
  kind: 'dashboard' | 'workbook';
  sourceModelId: string;
  targetModelId: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
}

export interface ModelMigrationJobInput {
  sourceId: string;
  targetId: string;
  targetLabel?: string;
  models: ModelMigrationModelInput[];
  content: ModelMigrationContentInput[];
  replaceSameNamed: boolean;
  mergeAfterValidation?: boolean;
  publishDrafts?: boolean;
  deleteBranch?: boolean;
  postMigrationActions: PostMigrationAction[];
  parentJobId?: string;
}

const runningJobs = new Set<string>();
const canceledJobs = new Set<string>();
const activePostMigrationActions = new Map<string, PostMigrationAction[]>();
const FIELD_REF_KEYS = new Set([
  'field',
  'fieldName',
  'field_name',
  'column_name',
  'columnName',
  'fields',
  'pivots',
  'sorts',
  'filters',
  'filter',
  'measures',
  'dimensions',
  'x',
  'y',
  'series',
]);
const FIELD_REF_PATTERN = /\b([A-Za-z_][\w/]*\.[A-Za-z_][\w]*(?:\[[A-Za-z_][\w]*\])?)\b/g;

function requireInstance(id: string): SavedInstance {
  const instance = getInstance(id);
  if (!instance) throw new Error(`Instance not found: ${id}`);
  return instance;
}

function createItem(jobId: string, destination: SavedInstance, step: Omit<MigrationPlanStep, 'destinationLabel'>): MigrationJobItem {
  return {
    id: randomUUID(),
    jobId,
    targetId: step.targetId,
    destinationId: destination.id,
    destinationLabel: destination.label,
    targetModelId: step.targetModelId,
    targetModelName: step.targetModelName,
    targetFolderId: step.targetFolderId,
    targetFolderPath: step.targetFolderPath,
    kind: step.kind,
    documentId: step.documentId,
    documentName: step.documentName,
    replacement: step.replacement,
    status: 'pending',
    warnings: step.warnings,
  };
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function markItem(item: MigrationJobItem, status: JobItemStatus, patch: Partial<MigrationJobItem> = {}): void {
  item.status = status;
  if (status === 'running') item.startedAt = Date.now();
  if (status !== 'running' && status !== 'pending') item.endedAt = Date.now();
  Object.assign(item, patch);
}

function computeJobStatus(items: MigrationJobItem[]): JobStatus {
  if (items.length === 0) return 'succeeded';
  const failed = items.filter((item) => item.status === 'failed').length;
  const succeeded = items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length;
  if (failed === 0) return 'succeeded';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'canceled';
}

function destinationConcurrency(): number {
  const parsed = Number.parseInt(process.env.OMNIKIT_MIGRATION_DEST_CONCURRENCY || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DESTINATION_CONCURRENCY;
  return Math.min(parsed, 25);
}

async function runWithConcurrency<T>(
  rows: T[],
  limit: number,
  worker: (row: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (index < rows.length) {
      const row = rows[index];
      index += 1;
      await worker(row);
    }
  });
  await Promise.all(workers);
}

function persistJobStatus(job: MigrationJob): void {
  updateJobStatus(job);
  publishMigrationJobEvent({
    type: 'job',
    jobId: job.id,
    status: job.status,
    at: Date.now(),
    job,
  });
}

function persistItem(item: MigrationJobItem): void {
  updateJobItem(item);
  publishMigrationJobEvent({
    type: 'item',
    jobId: item.jobId,
    itemId: item.id,
    destinationId: item.destinationId,
    status: item.status,
    error: item.error,
    at: Date.now(),
    item,
  });
}

function markAndPersistItem(
  item: MigrationJobItem,
  status: JobItemStatus,
  patch: Partial<MigrationJobItem> = {},
): void {
  markItem(item, status, patch);
  persistItem(item);
}

function markPendingItemsSkipped(job: MigrationJob, reason: string): void {
  for (const item of job.items) {
    if (item.status === 'pending') markAndPersistItem(item, 'skipped', { error: reason });
  }
}

function normalizeFolderPath(value: string | undefined): string {
  return (value || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

async function listDocumentsForFolder(
  client: OmniClient,
  folderId?: string,
  folderPath?: string,
  includeLabels = false,
) {
  if (folderId) return client.listFolderDocuments(folderId, includeLabels);
  if (!folderPath) return client.listFolderDocuments(undefined, includeLabels);
  const requestedPath = normalizeFolderPath(folderPath);
  const docs = await client.listFolderDocuments(undefined, includeLabels);
  return docs.filter((doc) => {
    const actualPath = normalizeFolderPath(doc.folderPath);
    return actualPath === requestedPath || actualPath.endsWith(`/${requestedPath}`);
  });
}

function normalizeFieldRef(value: string): string {
  return value.trim().replace(/\[[^\]]+\]$/, '');
}

function isOmniFormulaFunctionRef(value: string): boolean {
  const [namespace, member] = normalizeFieldRef(value).split('.');
  return namespace?.toLowerCase() === 'omni' && /^OMNI_FX_/i.test(member || '');
}

function isLikelyFieldRef(value: string): boolean {
  const normalized = normalizeFieldRef(value);
  return !isOmniFormulaFunctionRef(normalized) && /^[A-Za-z_][\w/]*\.[A-Za-z_][\w]*$/.test(normalized);
}

function extractFieldRefsFromString(value: string, onlyIfFieldLike = false): string[] {
  const refs = new Set<string>();
  const candidates = onlyIfFieldLike ? [value] : Array.from(value.matchAll(FIELD_REF_PATTERN)).map((match) => match[1]);
  for (const candidate of candidates) {
    const normalized = normalizeFieldRef(candidate);
    if (isLikelyFieldRef(normalized)) refs.add(normalized);
  }
  return [...refs];
}

function extractDashboardFieldRefs(payload: unknown, maxDepth = 14): string[] {
  const refs = new Set<string>();
  function walk(node: unknown, keyHint = '', depth = maxDepth): void {
    if (node === null || node === undefined || depth <= 0) return;
    if (typeof node === 'string') {
      const keyLooksFieldLike = FIELD_REF_KEYS.has(keyHint) || /field|column|sort|pivot|filter|measure|dimension/i.test(keyHint);
      for (const ref of extractFieldRefsFromString(node, !keyLooksFieldLike)) refs.add(ref);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint, depth - 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, key, depth - 1);
      }
    }
  }
  walk(payload);
  return [...refs].sort();
}

function viewNameVariants(fileName: string): string[] {
  const withoutSuffix = fileName.replace(/\.view$/, '');
  const leaf = withoutSuffix.includes('/') ? withoutSuffix.split('/').pop() || withoutSuffix : withoutSuffix;
  const withoutQuerySuffix = leaf.replace(/\.query$/, '');
  return [...new Set([withoutSuffix, leaf, withoutQuerySuffix].filter(Boolean))];
}

function extractFieldsFromViewYaml(fileName: string, yaml: string): string[] {
  const refs = new Set<string>();
  if (!fileName.endsWith('.view')) return [];
  const viewNames = viewNameVariants(fileName);
  let activeSection = false;
  let sectionIndent = -1;

  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const sectionMatch = line.match(/^(\s*)(dimensions|measures):\s*$/);
    if (sectionMatch) {
      activeSection = true;
      sectionIndent = sectionMatch[1].length;
      continue;
    }
    if (!activeSection) continue;
    if (indent <= sectionIndent) {
      activeSection = false;
      continue;
    }
    if (indent === sectionIndent + 2) {
      const fieldMatch = line.trim().match(/^([A-Za-z_][\w]*):/);
      if (fieldMatch) {
        for (const viewName of viewNames) refs.add(`${viewName}.${fieldMatch[1]}`);
      }
    }
  }
  return [...refs];
}

async function loadTargetFieldUniverse(client: OmniClient, modelId: string): Promise<{ fields: Set<string>; warning?: string }> {
  try {
    const files = await client.getModelYamlFiles(modelId);
    const fields = new Set<string>();
    for (const [fileName, yaml] of Object.entries(files)) {
      for (const fieldRef of extractFieldsFromViewYaml(fileName, yaml)) fields.add(fieldRef);
    }
    return { fields };
  } catch (error) {
    return {
      fields: new Set<string>(),
      warning: `Target model YAML inspection failed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

function formatFieldList(fields: string[], limit = 8): string {
  const shown = fields.slice(0, limit).join(', ');
  const remaining = fields.length - limit;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function normalizeTargets(input: {
  targets?: MigrationTarget[];
  destinationIds?: string[];
}): MigrationTarget[] {
  if (Array.isArray(input.targets) && input.targets.length > 0) {
    return input.targets.map((target, index) => {
      const destination = requireInstance(target.destinationInstanceId);
      const targetModelId = (target.targetModelId || destination.defaultModelId || '').trim();
      const explicitFolderId = target.targetFolderId?.trim();
      const explicitFolderPath = target.targetFolderPath?.trim();
      if (!targetModelId) {
        throw new Error(`Choose a target model for ${destination.label}.`);
      }
      if (explicitFolderId && !explicitFolderPath) {
        throw new Error(`Choose a target folder path for ${destination.label}, or clear the folder to use the default destination.`);
      }
      return {
        id: target.id || `${destination.id}:${targetModelId}:${index}`,
        destinationInstanceId: destination.id,
        destinationLabel: destination.label,
        targetModelId,
        targetModelName: target.targetModelName?.trim() || targetModelId,
        targetFolderId: explicitFolderId || (explicitFolderPath ? undefined : destination.defaultFolderId),
        targetFolderPath: explicitFolderPath || destination.defaultFolderPath,
      };
    });
  }

  return (input.destinationIds || []).map((destinationId) => {
    const destination = requireInstance(destinationId);
    if (!destination.defaultModelId) {
      throw new Error(`Choose a target model for ${destination.label}.`);
    }
    return {
      id: `${destination.id}:${destination.defaultModelId}`,
      destinationInstanceId: destination.id,
      destinationLabel: destination.label,
      targetModelId: destination.defaultModelId,
      targetModelName: destination.defaultModelId,
      targetFolderId: destination.defaultFolderId,
      targetFolderPath: destination.defaultFolderPath,
    };
  });
}

export function listJobs(): MigrationJob[] {
  return listStoredJobs();
}

export function getJob(id: string): MigrationJob | undefined {
  return getStoredJob(id);
}

export function clearJobs(): void {
  clearStoredJobs();
}

export async function buildMigrationPlan(input: {
  sourceId: string;
  destinationIds?: string[];
  targets?: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
}): Promise<MigrationPlan> {
  const source = requireInstance(input.sourceId);
  const targets = normalizeTargets(input);
  const sourceClient = new OmniClient(source);
  const sourceFolderId = input.sourceFolderId?.trim() || source.defaultFolderId;
  const sourceFolderPath = input.sourceFolderPath?.trim() || source.defaultFolderPath;
  const replaceSameNamed = input.replaceSameNamed !== false;
  const sourceDocs = await listDocumentsForFolder(sourceClient, sourceFolderId, sourceFolderPath, true);
  const selected = sourceDocs.filter((doc) => input.documentIds.includes(doc.identifier));
  const missing = input.documentIds.filter((id) => !selected.some((doc) => doc.identifier === id));
  if (missing.length > 0) throw new Error(`Source documents not found: ${missing.join(', ')}`);
  const selectedNames = new Set(selected.map((doc) => doc.name).filter(Boolean));

  const steps: MigrationPlanStep[] = [];
  const deleteStepKeys = new Set<string>();
  const exportCache = new Map<string, Record<string, unknown>>();
  const fieldRefCache = new Map<string, string[]>();
  for (const target of targets) {
    const destination = requireInstance(target.destinationInstanceId);
    const destinationClient = new OmniClient(destination);
    const existing = await listDocumentsForFolder(
      destinationClient,
      target.targetFolderId,
      target.targetFolderPath || destination.defaultFolderPath,
    );
    const destinationWarnings: string[] = [];
    const targetFields = await loadTargetFieldUniverse(destinationClient, target.targetModelId);
    if (targetFields.warning) destinationWarnings.push(targetFields.warning);

    for (const existingDoc of existing) {
      const replacingExistingDoc = !input.emptyFirst && replaceSameNamed && selectedNames.has(existingDoc.name);
      if (!input.emptyFirst && !replacingExistingDoc) continue;
      const deleteKey = `${destination.id}:${existingDoc.identifier}`;
      if (deleteStepKeys.has(deleteKey)) continue;
      deleteStepKeys.add(deleteKey);
      steps.push({
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId,
        targetFolderPath: target.targetFolderPath,
        kind: 'delete',
        documentId: existingDoc.identifier,
        documentName: existingDoc.name,
        replacement: replacingExistingDoc,
      });
    }

    for (const doc of selected) {
      let compatibilityWarnings = [...destinationWarnings];
      try {
        let refs = fieldRefCache.get(doc.identifier);
        if (!refs) {
          let payload = exportCache.get(doc.identifier);
          if (!payload) {
            payload = await sourceClient.exportDocument(doc.identifier);
            exportCache.set(doc.identifier, payload);
          }
          refs = extractDashboardFieldRefs(payload);
          fieldRefCache.set(doc.identifier, refs);
        }
        if (refs.length === 0) {
          compatibilityWarnings.push('No dashboard field references were detected in the export payload. Review the imported dashboard in Omni before publishing.');
        } else if (targetFields.fields.size > 0) {
          const missingFields = refs.filter((field) => !targetFields.fields.has(field));
          if (missingFields.length > 0) {
            compatibilityWarnings.push(`${missingFields.length} referenced fields were not found in the destination model: ${formatFieldList(missingFields)}.`);
          }
        }
      } catch (error) {
        compatibilityWarnings.push(`Compatibility preflight could not inspect ${doc.name}: ${error instanceof Error ? error.message : String(error)}.`);
      }
      compatibilityWarnings = [...new Set(compatibilityWarnings)];
      steps.push({
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId,
        targetFolderPath: target.targetFolderPath,
        kind: 'export',
        documentId: doc.identifier,
        documentName: doc.name,
      });
      steps.push({
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId,
        targetFolderPath: target.targetFolderPath,
        kind: 'import',
        documentId: doc.identifier,
        documentName: doc.name,
        warnings: compatibilityWarnings.length > 0 ? compatibilityWarnings : undefined,
      });
      steps.push({
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId,
        targetFolderPath: target.targetFolderPath,
        kind: 'metadata',
        documentId: doc.identifier,
        documentName: doc.name,
      });
    }
  }

  return {
    sourceId: input.sourceId,
    sourceLabel: source.label,
    destinationIds: [...new Set(targets.map((target) => target.destinationInstanceId))],
    targets,
    documentIds: input.documentIds,
    emptyFirst: input.emptyFirst,
    replaceSameNamed,
    sourceFolderId,
    sourceFolderPath,
    steps,
  };
}

export async function createMigrationJob(input: {
  sourceId: string;
  destinationIds?: string[];
  targets?: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  postMigrationActions: PostMigrationAction[];
  parentJobId?: string;
}): Promise<MigrationJob> {
  const source = requireInstance(input.sourceId);
  const plan = await buildMigrationPlan(input);
  const jobId = randomUUID();
  const items = plan.steps.map((step) => createItem(jobId, requireInstance(step.destinationId), step));
  const job: MigrationJob = {
    id: jobId,
    sourceId: input.sourceId,
    sourceLabel: source.label,
    destinationIds: plan.destinationIds,
    targets: plan.targets,
    documentIds: input.documentIds,
    emptyFirst: input.emptyFirst,
    replaceSameNamed: input.replaceSameNamed !== false,
    sourceFolderId: plan.sourceFolderId,
    sourceFolderPath: plan.sourceFolderPath,
    postMigrationActions: input.postMigrationActions.map(sanitizePostMigrationAction),
    status: 'pending',
    parentJobId: input.parentJobId,
    createdAt: Date.now(),
    items,
  };
  activePostMigrationActions.set(jobId, input.postMigrationActions);
  insertJob(job);
  void runMigrationJob(job.id).catch(() => undefined);
  return getJob(job.id) || sanitizeJob(job);
}

export async function createModelMigrationJob(input: ModelMigrationJobInput): Promise<MigrationJob> {
  const source = requireInstance(input.sourceId);
  const target = requireInstance(input.targetId);
  if (input.models.length === 0) throw new Error('Select at least one source model before starting Model Migrator.');
  const jobId = randomUUID();
  const items: MigrationJobItem[] = [];
  const contentIds = input.content.map((row) => row.documentId);

  for (const model of input.models) {
    const baseDetails = {
      sourceModelId: model.sourceModelId,
      sourceModelName: model.sourceModelName,
      targetModelId: model.targetModelId,
      targetModelName: model.targetModelName,
      targetConnectionId: model.targetConnectionId,
      branchName: model.branchName,
      mode: model.mode,
    };
    if (model.mode === 'fast') {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        kind: 'model_fast_path',
        status: 'pending',
        details: {
          ...baseDetails,
          gitRef: model.gitRef,
          fastPathSchemaConfirmed: model.fastPathSchemaConfirmed === true,
        },
      });
    } else {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        kind: 'model_translate',
        status: 'pending',
        details: { ...baseDetails, acceptedFileCount: model.acceptedFiles?.length || 0 },
      });
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        kind: 'model_branch_create',
        status: 'pending',
        details: baseDetails,
      });
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        kind: 'model_yaml_write',
        status: 'pending',
        details: { ...baseDetails, files: model.acceptedFiles || [] },
      });
    }
    items.push({
      id: randomUUID(),
      jobId,
      destinationId: target.id,
      destinationLabel: target.label,
      targetModelId: model.targetModelId,
      targetModelName: model.targetModelName,
      kind: 'model_validate',
      status: 'pending',
      details: baseDetails,
    });
    items.push({
      id: randomUUID(),
      jobId,
      destinationId: target.id,
      destinationLabel: target.label,
      targetModelId: model.targetModelId,
      targetModelName: model.targetModelName,
      kind: 'content_validate',
      status: 'pending',
      details: baseDetails,
    });
  }

  for (const content of input.content) {
    if (content.kind === 'dashboard') {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: content.targetModelId,
        targetModelName: content.targetModelName,
        targetFolderId: content.targetFolderId,
        targetFolderPath: content.targetFolderPath,
        kind: 'export',
        documentId: content.documentId,
        documentName: content.documentName,
        status: 'pending',
        details: { ...content, workflow: 'model' },
      });
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: content.targetModelId,
        targetModelName: content.targetModelName,
        targetFolderId: content.targetFolderId,
        targetFolderPath: content.targetFolderPath,
        kind: 'import',
        documentId: content.documentId,
        documentName: content.documentName,
        status: 'pending',
        details: { ...content },
      });
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: content.targetModelId,
        targetModelName: content.targetModelName,
        targetFolderId: content.targetFolderId,
        targetFolderPath: content.targetFolderPath,
        kind: 'metadata',
        documentId: content.documentId,
        documentName: content.documentName,
        status: 'pending',
        details: { ...content },
      });
      continue;
    }
    for (const kind of ['workbook_queries', 'workbook_preflight', 'workbook_create'] as const) {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: content.targetModelId,
        targetModelName: content.targetModelName,
        targetFolderId: content.targetFolderId,
        targetFolderPath: content.targetFolderPath,
        kind,
        documentId: content.documentId,
        documentName: content.documentName,
        status: 'pending',
        details: { ...content },
      });
    }
  }

  const job: MigrationJob = {
    id: jobId,
    workflow: 'model',
    sourceId: input.sourceId,
    sourceLabel: source.label,
    destinationIds: [target.id],
    targets: input.models.map((model) => ({
      id: `${target.id}:${model.targetModelId}`,
      destinationInstanceId: target.id,
      destinationLabel: target.label,
      targetModelId: model.targetModelId,
      targetModelName: model.targetModelName,
    })),
    documentIds: contentIds,
    emptyFirst: false,
    replaceSameNamed: input.replaceSameNamed !== false,
    postMigrationActions: input.postMigrationActions.map(sanitizePostMigrationAction),
    status: 'pending',
    parentJobId: input.parentJobId,
    createdAt: Date.now(),
    details: {
      targetId: target.id,
      targetLabel: input.targetLabel || target.label,
      modelCount: input.models.length,
      dashboardCount: input.content.filter((row) => row.kind === 'dashboard').length,
      workbookCount: input.content.filter((row) => row.kind === 'workbook').length,
      mergeAfterValidation: false,
      retryInput: {
        sourceId: input.sourceId,
        targetId: input.targetId,
        targetLabel: input.targetLabel,
        models: input.models,
        content: input.content,
        replaceSameNamed: false,
        mergeAfterValidation: false,
        publishDrafts: input.publishDrafts,
        deleteBranch: input.deleteBranch,
        postMigrationActions: input.postMigrationActions,
      },
    },
    items,
  };
  activePostMigrationActions.set(jobId, input.postMigrationActions);
  insertJob(job);
  void runMigrationJob(job.id).catch(() => undefined);
  return getJob(job.id) || sanitizeJob(job);
}

export async function retryMigrationJob(id: string, options: { destinationId?: string } = {}): Promise<MigrationJob> {
  const parent = getJob(id);
  if (!parent) throw new Error('Job not found.');
  if (parent.workflow === 'model') {
    const retryInput = parent.details?.retryInput;
    if (!retryInput || typeof retryInput !== 'object' || Array.isArray(retryInput)) {
      throw new Error('Model migration retry details are unavailable.');
    }
    const input = retryInput as ModelMigrationJobInput;
    const failedModelIds = new Set(parent.items
      .filter((item) => item.status === 'failed' && item.targetModelId)
      .map((item) => item.targetModelId as string));
    const failedDocumentIds = new Set(parent.items
      .filter((item) => item.status === 'failed' && item.documentId)
      .map((item) => item.documentId as string));
    const retryModels = input.models.filter((model) => failedModelIds.has(model.targetModelId));
    const retryContent = input.content.filter((content) => failedDocumentIds.has(content.documentId) || failedModelIds.has(content.targetModelId));
    if (retryModels.length === 0 && retryContent.length === 0) {
      throw new Error('No failed model migration items are available to retry.');
    }
    return createModelMigrationJob({
      ...input,
      models: retryModels.length > 0 ? retryModels : input.models.filter((model) => retryContent.some((content) => content.targetModelId === model.targetModelId)),
      content: retryContent,
      parentJobId: parent.id,
      postMigrationActions: input.postMigrationActions || [],
      replaceSameNamed: false,
    });
  }
  const failedImports = parent.items.filter((item) => {
    if (options.destinationId && item.destinationId !== options.destinationId) return false;
    return item.status === 'failed' && (item.kind === 'import' || item.kind === 'export');
  });
  const targetsById = new Map<string, MigrationTarget>();
  for (const item of failedImports) {
    const destination = requireInstance(item.destinationId);
    const targetId = item.targetId || `${item.destinationId}:${item.targetModelId || destination.defaultModelId || ''}`;
    if (!targetsById.has(targetId)) {
      const parentTarget = parent.targets?.find((target) => target.id === item.targetId);
      targetsById.set(targetId, parentTarget || {
        id: targetId,
        destinationInstanceId: item.destinationId,
        destinationLabel: item.destinationLabel,
        targetModelId: item.targetModelId || destination.defaultModelId || '',
        targetModelName: item.targetModelName,
        targetFolderPath: item.targetFolderPath || destination.defaultFolderPath,
        targetFolderId: item.targetFolderId || destination.defaultFolderId,
      });
    }
  }
  const targets = [...targetsById.values()].filter((target) => target.targetModelId);
  const documentIds = [...new Set(failedImports.map((item) => item.documentId).filter((item): item is string => Boolean(item)))];
  if (targets.length === 0 || documentIds.length === 0) throw new Error('No failed import/export items to retry.');
  return createMigrationJob({
    sourceId: parent.sourceId,
    targets,
    documentIds,
    emptyFirst: false,
    replaceSameNamed: parent.replaceSameNamed,
    sourceFolderId: parent.sourceFolderId,
    sourceFolderPath: parent.sourceFolderPath,
    postMigrationActions: [],
    parentJobId: parent.id,
  });
}

function modelMigrationInputFromJob(job: MigrationJob): ModelMigrationJobInput {
  const retryInput = job.details?.retryInput;
  if (!retryInput || typeof retryInput !== 'object' || Array.isArray(retryInput)) {
    throw new Error('Model migration details are unavailable.');
  }
  return retryInput as ModelMigrationJobInput;
}

function branchNameForModel(job: MigrationJob, model: ModelMigrationModelInput): string {
  const branchItem = job.items.find((item) => (
    item.targetModelId === model.targetModelId
    && (item.kind === 'model_branch_create' || item.kind === 'model_fast_path')
    && (item.status === 'succeeded' || item.status === 'warning')
  ));
  return detailString(branchItem?.details, 'branchName') || model.branchName;
}

export async function mergeModelMigrationJob(id: string, options: { publishDrafts?: boolean; deleteBranch?: boolean } = {}): Promise<MigrationJob> {
  const job = getJob(id);
  if (!job) throw new Error('Job not found.');
  if (job.workflow !== 'model') throw new Error('Only Model Migrator jobs can be merged from this endpoint.');
  if (job.status === 'running' || job.status === 'pending') throw new Error('Wait for model validation to finish before merging.');
  if (job.items.some((item) => item.kind === 'model_merge' && (item.status === 'succeeded' || item.status === 'running'))) {
    throw new Error('This model migration job already has a merge in progress or completed.');
  }

  const input = modelMigrationInputFromJob(job);
  const validationByModel = new Map(job.items
    .filter((item) => item.kind === 'model_validate' && item.targetModelId)
    .map((item) => [item.targetModelId as string, item]));
  const blockers = input.models.filter((model) => validationByModel.get(model.targetModelId)?.status !== 'succeeded');
  if (blockers.length > 0) {
    throw new Error(`Cannot merge until every target model validates successfully: ${blockers.map((model) => model.targetModelName || model.targetModelId).join(', ')}`);
  }

  const targetId = typeof job.details?.targetId === 'string' ? job.details.targetId : job.destinationIds[0];
  const target = requireInstance(targetId);
  const targetClient = new OmniClient(target);
  job.status = 'running';
  job.endedAt = undefined;
  persistJobStatus(job);

  for (const model of input.models) {
    const branchName = branchNameForModel(job, model);
    const item: MigrationJobItem = {
      id: randomUUID(),
      jobId: job.id,
      destinationId: target.id,
      destinationLabel: target.label,
      targetModelId: model.targetModelId,
      targetModelName: model.targetModelName,
      kind: 'model_merge',
      status: 'running',
      startedAt: Date.now(),
      details: {
        sourceModelId: model.sourceModelId,
        sourceModelName: model.sourceModelName,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        branchName,
        publishDrafts: options.publishDrafts === true,
        deleteBranch: options.deleteBranch !== false,
        mergeHandoffRequired: model.mergeHandoffRequired === true,
      },
    };
    job.items.push(item);
    persistItem(item);
    try {
      if (model.mergeHandoffRequired) {
        markAndPersistItem(item, 'warning', {
          warnings: ['This model appears to require a git/PR handoff. Open the target branch in Omni and complete review there; OmniKit did not force merge settings.'],
        });
        continue;
      }
      await targetClient.mergeModelBranch(model.targetModelId, branchName, {
        publishDrafts: options.publishDrafts === true,
        deleteBranch: options.deleteBranch !== false,
        forceOverrideGitSettings: false,
      });
      markAndPersistItem(item, 'succeeded');
    } catch (error) {
      const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
      markAndPersistItem(item, 'failed', { error: message });
    }
  }

  job.status = computeJobStatus(job.items);
  job.endedAt = Date.now();
  persistJobStatus(job);
  return getJob(job.id) || sanitizeJob(job);
}

export async function runMigrationJob(id: string): Promise<void> {
  if (runningJobs.has(id)) return;
  const job = getJob(id);
  if (!job) return;
  if (isTerminalJobStatus(job.status)) return;
  runningJobs.add(id);
  try {
    if (job.workflow === 'model') await executeModelJob(job);
    else await executeJob(job);
  } catch {
    const latest = getJob(id) || job;
    markPendingItemsSkipped(latest, 'Job failed before this step could run.');
    latest.status = 'failed';
    latest.endedAt = Date.now();
    persistJobStatus(latest);
  } finally {
    activePostMigrationActions.delete(id);
    canceledJobs.delete(id);
    runningJobs.delete(id);
  }
}

export function cancelMigrationJob(id: string): MigrationJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (isTerminalJobStatus(job.status)) return job;
  canceledJobs.add(id);
  if (!runningJobs.has(id)) {
    markPendingItemsSkipped(job, 'Canceled by user.');
    job.status = 'canceled';
    job.endedAt = Date.now();
    persistJobStatus(job);
  }
  return getJob(id) || sanitizeJob(job);
}

function detailString(details: Record<string, unknown> | undefined, key: string): string {
  const value = details?.[key];
  return typeof value === 'string' ? value : '';
}

function detailFiles(details: Record<string, unknown> | undefined): ModelMigrationAcceptedFile[] {
  const files = details?.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((file): file is Record<string, unknown> => Boolean(file) && typeof file === 'object' && !Array.isArray(file))
    .map((file) => ({
      fileName: typeof file.fileName === 'string' ? file.fileName : '',
      yaml: typeof file.yaml === 'string' ? file.yaml : '',
      previousChecksum: typeof file.previousChecksum === 'string' ? file.previousChecksum : undefined,
    }))
    .filter((file) => file.fileName && file.yaml);
}

function detailBoolean(details: Record<string, unknown> | undefined, key: string): boolean {
  return details?.[key] === true;
}

function nestedString(value: unknown, path: string[]): string {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return '';
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : '';
}

function branchFromMigrationResult(result: Record<string, unknown>, fallbackName: string): { branchId: string; branchName: string } | null {
  const branchId = [
    result.branchId,
    result.branch_id,
    result.modelId,
    result.model_id,
    nestedString(result, ['branch', 'id']),
    nestedString(result, ['model', 'id']),
  ].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const branchName = [
    result.branchName,
    result.branch_name,
    result.modelName,
    result.model_name,
    nestedString(result, ['branch', 'name']),
    nestedString(result, ['model', 'name']),
  ].find((value): value is string => typeof value === 'string' && Boolean(value.trim())) || fallbackName;
  return branchId ? { branchId, branchName } : null;
}

async function executeModelJob(job: MigrationJob): Promise<void> {
  const source = requireInstance(job.sourceId);
  const targetId = typeof job.details?.targetId === 'string' ? job.details.targetId : job.destinationIds[0];
  const target = requireInstance(targetId);
  const sourceClient = new OmniClient(source);
  const targetClient = new OmniClient(target);
  const branchByTargetModel = new Map<string, { branchId: string; branchName: string }>();
  const targetYamlByModel = new Map<string, Record<string, string>>();
  const workbookQueries = new Map<string, Array<{ id: string; name: string; query: Record<string, unknown>; visConfig?: Record<string, unknown>; description?: string }>>();
  const workbookRewrites = new Map<string, Array<{ name: string; query: Record<string, unknown>; visConfig?: Record<string, unknown>; description?: string; blockers: string[] }>>();
  const blockedTargetModels = new Set<string>();
  const blockedWorkbooks = new Set<string>();
  const dashboardExports = new Map<string, { payload: Record<string, unknown>; hash: string }>();
  const importedDashboards = new Map<string, { identifier: string; documentId: string }>();
  let sourceDocuments: Array<{ id: string; identifier: string; name: string; description?: string | null; labels?: string[] }> | null = null;
  let sourceLabels: Map<string, { color?: string | null; description?: string | null }> | null = null;
  let targetLabelSet: Set<string> | null = null;

  job.status = 'running';
  job.startedAt = Date.now();
  persistJobStatus(job);

  async function targetYaml(targetModelId: string, branchId?: string): Promise<Record<string, string>> {
    const key = `${targetModelId}:${branchId || 'main'}`;
    const cached = targetYamlByModel.get(key);
    if (cached) return cached;
    const yaml = (await targetClient.getModelYaml(targetModelId, { branchId, includeChecksums: true })).files;
      targetYamlByModel.set(key, yaml);
      return yaml;
  }

  async function sourceDocument(documentId: string) {
    if (!sourceDocuments) {
      sourceDocuments = await sourceClient.listFolderDocuments(undefined, true);
    }
    return sourceDocuments.find((doc) => doc.id === documentId || doc.identifier === documentId);
  }

  async function sourceLabelMeta(name: string) {
    if (!sourceLabels) {
      sourceLabels = new Map((await sourceClient.listLabels()).map((label) => [label.name, { color: label.color, description: label.description }]));
    }
    return sourceLabels.get(name);
  }

  async function ensureTargetLabels(labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    if (!targetLabelSet) {
      targetLabelSet = new Set((await targetClient.listLabels()).map((label) => label.name));
    }
    for (const label of labels) {
      if (targetLabelSet.has(label)) continue;
      const sourceLabel = await sourceLabelMeta(label);
      await targetClient.createLabel({ name: label, color: sourceLabel?.color, description: sourceLabel?.description });
      targetLabelSet.add(label);
    }
  }

  function isDownstreamOfModel(item: MigrationJobItem): boolean {
    return [
      'content_validate',
      'model_merge',
      'export',
      'import',
      'metadata',
      'workbook_queries',
      'workbook_preflight',
      'workbook_create',
    ].includes(item.kind);
  }

  for (const item of job.items) {
    if (canceledJobs.has(job.id)) {
      if (item.status === 'pending') markAndPersistItem(item, 'skipped', { error: 'Canceled by user.' });
      continue;
    }
    if (item.status !== 'pending') continue;
    const details = item.details || {};
    const sourceModelId = detailString(details, 'sourceModelId');
    const targetModelId = item.targetModelId || detailString(details, 'targetModelId');
    const branchName = detailString(details, 'branchName');
    if (targetModelId && blockedTargetModels.has(targetModelId) && isDownstreamOfModel(item)) {
      markAndPersistItem(item, 'skipped', { error: 'Skipped because target model validation failed.' });
      continue;
    }
    if (item.documentId && blockedWorkbooks.has(item.documentId) && item.kind === 'workbook_create') {
      markAndPersistItem(item, 'skipped', { error: 'Skipped because workbook preflight failed.' });
      continue;
    }

    try {
      markAndPersistItem(item, 'running');
      if (item.kind === 'model_fast_path') {
        if (detailBoolean(details, 'fastPathSchemaConfirmed') !== true) throw new Error('Fast path requires explicit schema identity confirmation.');
        const migrated = await sourceClient.migrateModel({
          sourceModelId,
          targetModelId,
          gitRef: detailString(details, 'gitRef') || undefined,
          branchName,
          commitMessage: `OmniKit Model Migrator fast path for ${item.targetModelName || targetModelId}`,
        });
        let branch = branchFromMigrationResult(migrated, branchName);
        if (!branch) {
          const resolvedBranch = await targetClient.findModelBranch(targetModelId, branchName);
          branch = resolvedBranch ? { branchId: resolvedBranch.id, branchName: resolvedBranch.name } : null;
        }
        if (!branch?.branchId) {
          throw new Error('Fast path completed but OmniKit could not resolve the target branch id for validation. Open the branch in Omni or retry after the branch is visible.');
        }
        branchByTargetModel.set(targetModelId, branch);
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchId: branch.branchId, branchName: branch.branchName } });
      } else if (item.kind === 'model_translate') {
        const acceptedFileCount = typeof details.acceptedFileCount === 'number' ? details.acceptedFileCount : 0;
        if (acceptedFileCount === 0) {
          markAndPersistItem(item, 'warning', { warnings: ['No accepted YAML files were provided; validation will run against the current target model.'] });
        } else {
          markAndPersistItem(item, 'succeeded');
        }
      } else if (item.kind === 'model_branch_create') {
        const branch = await targetClient.createModelBranch({
          connectionId: detailString(details, 'targetConnectionId'),
          baseModelId: targetModelId,
          branchName,
        });
        branchByTargetModel.set(targetModelId, { branchId: branch.id, branchName: branch.name });
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchId: branch.id, branchName: branch.name } });
      } else if (item.kind === 'model_yaml_write') {
        const branch = branchByTargetModel.get(targetModelId);
        if (!branch?.branchId) throw new Error('Target branch was not created before YAML write.');
        const files = detailFiles(details);
        await targetClient.updateModelYamlFiles({
          modelId: targetModelId,
          branchId: branch.branchId,
          files,
          commitMessage: `OmniKit Model Migrator update ${files.length} YAML file${files.length === 1 ? '' : 's'}`,
        });
        targetYamlByModel.delete(`${targetModelId}:${branch.branchId}`);
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchId: branch.branchId, writtenFiles: files.map((file) => file.fileName) } });
      } else if (item.kind === 'model_validate') {
        const branch = branchByTargetModel.get(targetModelId);
        const issues = await targetClient.validateModel(targetModelId, branch?.branchId);
        const errors = issues.filter((issue) => issue.is_warning !== true);
        if (errors.length > 0) blockedTargetModels.add(targetModelId);
        markAndPersistItem(item, errors.length > 0 ? 'failed' : 'succeeded', {
          error: errors.length > 0 ? `${errors.length} model validation error${errors.length === 1 ? '' : 's'} returned.` : undefined,
          details: { ...details, branchId: branch?.branchId, issueCount: issues.length, errorCount: errors.length, issues },
        });
      } else if (item.kind === 'content_validate') {
        const branch = branchByTargetModel.get(targetModelId);
        const result = await targetClient.validateModelContent(targetModelId, branch?.branchId);
        const issues = normalizeContentValidationIssues(result);
        const errorCount = issues.filter((issue) => issue.severity === 'error').length;
        if (errorCount > 0) blockedTargetModels.add(targetModelId);
        markAndPersistItem(item, errorCount > 0 ? 'failed' : 'succeeded', {
          error: errorCount > 0 ? `${errorCount} content validation error${errorCount === 1 ? '' : 's'} returned.` : undefined,
          details: { ...details, branchId: branch?.branchId, result, issues },
        });
      } else if (item.kind === 'model_merge') {
        const branch = branchByTargetModel.get(targetModelId);
        if (!branch?.branchName) throw new Error('Target branch was not available for merge.');
        if (detailBoolean(details, 'mergeHandoffRequired')) {
          markAndPersistItem(item, 'warning', {
            warnings: ['This model appears to require a git/PR handoff. Open the target branch in Omni and complete review there; OmniKit did not force merge settings.'],
            details: { ...details, branchName: branch.branchName },
          });
          continue;
        }
        await targetClient.mergeModelBranch(targetModelId, branch.branchName, {
          publishDrafts: detailBoolean(details, 'publishDrafts'),
          deleteBranch: detailBoolean(details, 'deleteBranch'),
          forceOverrideGitSettings: false,
        });
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchName: branch.branchName } });
      } else if (item.kind === 'workbook_queries') {
        if (!item.documentId) throw new Error('Workbook query item missing document id.');
        const queries = await sourceClient.getDocumentQueries(item.documentId);
        workbookQueries.set(item.documentId, queries);
        markAndPersistItem(item, queries.length === 0 ? 'warning' : 'succeeded', {
          warnings: queries.length === 0 ? ['No query tabs were returned for this workbook.'] : undefined,
          details: { ...details, tabCount: queries.length, tabs: queries.map((query) => query.name) },
        });
      } else if (item.kind === 'workbook_preflight') {
        if (!item.documentId) throw new Error('Workbook preflight item missing document id.');
        const queries = workbookQueries.get(item.documentId) || [];
        const branch = branchByTargetModel.get(targetModelId);
        const universe = buildFieldUniverseFromYaml(await targetYaml(targetModelId, branch?.branchId));
        const rewrites = queries.map((query) => {
          const rewritten = rewriteQueryModelReferences(query.query, detailString(details, 'sourceModelId'), targetModelId);
          const preflight = preflightWorkbookQueryFields(rewritten, universe);
          return {
            name: query.name,
            description: query.description,
            query: preflight.query,
            visConfig: query.visConfig,
            blockers: preflight.blockers,
          };
        });
        workbookRewrites.set(item.documentId, rewrites);
        const blockers = rewrites.flatMap((rewrite) => rewrite.blockers.map((blocker) => `${rewrite.name}: ${blocker}`));
        if (blockers.length > 0) blockedWorkbooks.add(item.documentId);
        markAndPersistItem(item, blockers.length > 0 ? 'failed' : 'succeeded', {
          error: blockers.length > 0 ? `${blockers.length} workbook query blocker${blockers.length === 1 ? '' : 's'} found.` : undefined,
          details: { ...details, blockers, tabCount: rewrites.length },
        });
      } else if (item.kind === 'workbook_create') {
        if (!item.documentId) throw new Error('Workbook create item missing document id.');
        const rewrites = workbookRewrites.get(item.documentId) || [];
        if (rewrites.some((rewrite) => rewrite.blockers.length > 0)) throw new Error('Workbook has unresolved preflight blockers.');
        if (rewrites.length === 0) throw new Error('No workbook tabs were available to create.');
        const pendingTabDetails = buildWorkbookTabResultDetails(rewrites, 'pending');
        try {
          if (job.replaceSameNamed && item.documentName) {
            const existingDocs = await targetClient.listFolderDocuments(item.targetFolderId, true);
            const match = existingDocs.find((doc) => doc.name === item.documentName && doc.hasDashboard === false);
            if (match) await targetClient.requestDeleteDocument(match.identifier || match.id);
          }
          const created = await targetClient.createWorkbookDocument({
            modelId: targetModelId,
            name: item.documentName || 'Migrated workbook',
            folderId: item.targetFolderId,
            folderPath: item.targetFolderPath,
            queryPresentations: rewrites.map((rewrite) => ({
              name: rewrite.name,
              description: rewrite.description,
              query: rewrite.query,
              visConfig: rewrite.visConfig,
            })),
          });
          markAndPersistItem(item, 'succeeded', {
            importedIdentifier: created.identifier,
            importedDocumentId: created.id,
            details: {
              ...details,
              url: created.url,
              tabCount: rewrites.length,
              tabs: buildWorkbookTabResultDetails(rewrites, 'created'),
              ported: ['queryPresentations', 'tab names', 'tab descriptions when present', 'visConfig when present'],
              limitations: ['Workbook-level filters, parameters, schedules, permissions, sharing, favorites, and artifacts not exposed by Omni document-query APIs are not ported automatically.'],
            },
          });
        } catch (error) {
          const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
          markAndPersistItem(item, 'failed', {
            error: message,
            details: {
              ...details,
              tabCount: rewrites.length,
              tabs: pendingTabDetails.map((tab) => ({ ...tab, status: 'not_created' })),
              retryBoundary: 'document',
              ported: ['queryPresentations', 'tab names', 'tab descriptions when present', 'visConfig when present'],
              limitations: ['Omni workbook creation is document-level here; retry reruns this workbook document rather than an individual tab.'],
            },
          });
        }
      } else if (item.kind === 'export') {
        if (!item.documentId) throw new Error('Dashboard export item missing document id.');
        const payload = await sourceClient.exportDocument(item.documentId);
        const branch = branchByTargetModel.get(targetModelId);
        const universe = buildFieldUniverseFromYaml(await targetYaml(targetModelId, branch?.branchId));
        const fieldReferences = [...collectFieldReferences(payload)].sort();
        const blockers = fieldReferences
          .filter((field) => universe.size > 0 && !universe.has(field))
          .map((field) => `Dashboard field is not available on the target model: ${field}`);
        if (blockers.length > 0) {
          markAndPersistItem(item, 'failed', {
            error: `${blockers.length} dashboard field blocker${blockers.length === 1 ? '' : 's'} found before import.`,
            details: { ...details, blockers, fieldReferences },
          });
          continue;
        }
        const cached = { payload, hash: hashPayload(payload) };
        dashboardExports.set(item.documentId, cached);
        markAndPersistItem(item, 'succeeded', { exportHash: cached.hash, details: { ...details, fieldReferences } });
      } else if (item.kind === 'import') {
        if (!item.documentId) throw new Error('Dashboard import item missing document id.');
        const cached = dashboardExports.get(item.documentId);
        if (!cached) {
          markAndPersistItem(item, 'skipped', { error: 'Export payload unavailable; dashboard import skipped.' });
          continue;
        }
        if (job.replaceSameNamed && item.documentName) {
          const existingDocs = await targetClient.listFolderDocuments(item.targetFolderId, true);
          const match = existingDocs.find((doc) => doc.name === item.documentName && doc.hasDashboard !== false);
          if (match) await targetClient.requestDeleteDocument(match.identifier || match.id);
        }
        const imported = await targetClient.importDocument({
          exportPayload: cached.payload,
          baseModelId: targetModelId,
          folderPath: item.targetFolderPath,
          documentName: item.documentName || 'Migrated dashboard',
        });
        let identifier = imported.identifier;
        let documentId = imported.documentId;
        if (!identifier || !documentId) {
          const docs = await targetClient.listFolderDocuments(item.targetFolderId, true);
          const match = docs
            .filter((doc) => doc.name === item.documentName)
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
          identifier ||= match?.identifier ?? '';
          documentId ||= match?.id ?? '';
        }
        if (!identifier && !documentId) throw new Error('Dashboard import succeeded but destination document could not be identified.');
        const warnings: string[] = [];
        if (item.targetFolderPath && documentId) {
          try {
            await targetClient.moveDocument(documentId, item.targetFolderPath);
          } catch (error) {
            warnings.push(`Folder move failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (item.targetFolderPath && identifier) {
          try {
            const docsAfterImport = await targetClient.listFolderDocuments(undefined);
            const importedDoc = docsAfterImport.find((doc) => doc.identifier === identifier || doc.id === documentId);
            const requestedPath = normalizeFolderPath(item.targetFolderPath);
            const actualPath = normalizeFolderPath(importedDoc?.folderPath);
            if (!actualPath) {
              warnings.push(`Folder placement could not be verified for imported dashboard ${identifier}.`);
            } else if (actualPath !== requestedPath && !actualPath.endsWith(`/${requestedPath}`)) {
              warnings.push(`Folder placement mismatch for imported dashboard ${identifier}: expected ${item.targetFolderPath}, found ${importedDoc?.folderPath}.`);
            }
          } catch (error) {
            warnings.push(`Folder placement verification failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        importedDashboards.set(item.documentId, { identifier, documentId });
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          importedIdentifier: identifier,
          importedDocumentId: documentId,
          warnings: warnings.length > 0 ? warnings : undefined,
          details: { ...details, exportHash: cached.hash },
        });
      } else if (item.kind === 'metadata') {
        if (!item.documentId) throw new Error('Dashboard metadata item missing document id.');
        const imported = importedDashboards.get(item.documentId);
        if (!imported?.identifier) {
          markAndPersistItem(item, 'skipped', { error: 'No imported dashboard identifier available for metadata preservation.' });
          continue;
        }
        const sourceDoc = await sourceDocument(item.documentId);
        const warnings: string[] = [];
        if (sourceDoc?.description) {
          try {
            await targetClient.patchDocument(imported.identifier, { description: sourceDoc.description, clearExistingDraft: true });
          } catch (error) {
            warnings.push(`Description copy failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (sourceDoc?.labels?.length) {
          try {
            await ensureTargetLabels(sourceDoc.labels);
            await targetClient.setDocumentLabels(imported.identifier, sourceDoc.labels);
          } catch (error) {
            warnings.push(`Label copy failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: { ...details, copiedDescription: Boolean(sourceDoc?.description), labelCount: sourceDoc?.labels?.length || 0 },
        });
      }
    } catch (error) {
      const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
      markAndPersistItem(item, 'failed', { error: message });
    }
  }

  if (canceledJobs.has(job.id)) {
    markPendingItemsSkipped(job, 'Canceled by user.');
    job.status = 'canceled';
    job.endedAt = Date.now();
    persistJobStatus(job);
    return;
  }

  await runJobPostActions(job);
  job.status = computeJobStatus(job.items);
  job.endedAt = Date.now();
  persistJobStatus(job);
}

async function executeJob(job: MigrationJob): Promise<void> {
  const source = requireInstance(job.sourceId);
  const sourceClient = new OmniClient(source);
  job.status = 'running';
  job.startedAt = Date.now();
  persistJobStatus(job);

  const exports = new Map<string, { payload: Record<string, unknown>; hash: string }>();
  const importConsumers = new Map<string, number>();
  const sourceMeta = new Map<string, SourceMeta>();
  const sourceLabels = new Map<string, { color?: string | null; description?: string | null }>();
  const destinationClientCache = new Map<string, OmniClient>();
  const importedByDestinationAndSource = new Map<string, { identifier: string; documentId: string }>();
  const destinationLabelCache = new Map<string, Set<string>>();

  try {
    const docs = await listDocumentsForFolder(
      sourceClient,
      job.sourceFolderId || source.defaultFolderId,
      job.sourceFolderPath || source.defaultFolderPath,
      true,
    );
    for (const doc of docs) {
      sourceMeta.set(doc.identifier, {
        description: doc.description ?? null,
        labels: doc.labels ?? [],
      });
    }
    const labels = await sourceClient.listLabels();
    for (const label of labels) sourceLabels.set(label.name, { color: label.color, description: label.description });
  } catch {
    // Metadata preservation is best-effort and should not block core imports.
  }

  function destinationClientFor(destination: SavedInstance): OmniClient {
    const cached = destinationClientCache.get(destination.id);
    if (cached) return cached;
    const client = new OmniClient(destination);
    destinationClientCache.set(destination.id, client);
    return client;
  }

  function releaseExportConsumer(documentId: string | undefined): void {
    if (!documentId) return;
    const remaining = (importConsumers.get(documentId) || 0) - 1;
    if (remaining <= 0) {
      importConsumers.delete(documentId);
      exports.delete(documentId);
    } else {
      importConsumers.set(documentId, remaining);
    }
  }

  function skipDependentItems(documentId: string, reason: string): void {
    for (const item of job.items) {
      if (item.documentId !== documentId) continue;
      if ((item.kind === 'import' || item.kind === 'metadata') && item.status === 'pending') {
        markAndPersistItem(item, 'skipped', { error: reason });
      }
    }
  }

  function exportItemsByDocument(): Map<string, MigrationJobItem[]> {
    const exportItemsByDocument = new Map<string, MigrationJobItem[]>();
    for (const item of job.items) {
      if (item.kind !== 'export' || !item.documentId) continue;
      const rows = exportItemsByDocument.get(item.documentId) || [];
      rows.push(item);
      exportItemsByDocument.set(item.documentId, rows);
    }
    return exportItemsByDocument;
  }

  async function exportDocumentOnce(documentId: string, exportItems: MigrationJobItem[]): Promise<boolean> {
    if (canceledJobs.has(job.id)) return false;
    for (const item of exportItems) {
      if (item.status === 'pending') markAndPersistItem(item, 'running');
    }
    try {
      const payload = await sourceClient.exportDocument(documentId);
      const cached = { payload, hash: hashPayload(payload) };
      exports.set(documentId, cached);
      for (const item of exportItems) markAndPersistItem(item, 'succeeded', { exportHash: cached.hash });
      return true;
    } catch (error) {
      const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
      for (const item of exportItems) markAndPersistItem(item, 'failed', { error: message });
      skipDependentItems(documentId, `Export failed; dependent step skipped. ${message}`);
      return false;
    }
  }

  async function processDestinationItem(item: MigrationJobItem): Promise<void> {
    if (canceledJobs.has(job.id)) {
      markAndPersistItem(item, 'skipped', { error: 'Canceled by user.' });
      if (item.kind === 'import') releaseExportConsumer(item.documentId);
      return;
    }
    const destination = requireInstance(item.destinationId);
    const destinationClient = destinationClientFor(destination);
    markAndPersistItem(item, 'running');

    try {
      if (item.kind === 'delete') {
        if (!item.documentId) throw new Error('Delete item missing document id.');
        await destinationClient.requestDeleteDocument(item.documentId);
        markAndPersistItem(item, 'succeeded');
      } else if (item.kind === 'import') {
        if (!item.documentId) throw new Error('Import item missing document id.');
        const cached = exports.get(item.documentId);
        if (!cached) {
          markAndPersistItem(item, 'skipped', { error: 'Export payload unavailable; import skipped.' });
          releaseExportConsumer(item.documentId);
          return;
        }
        const targetModelId = item.targetModelId || destination.defaultModelId;
        const targetFolderPath = item.targetFolderPath || destination.defaultFolderPath;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const imported = await destinationClient.importDocument({
          exportPayload: cached.payload,
          baseModelId: targetModelId,
          folderPath: targetFolderPath,
          documentName: item.documentName || 'Untitled',
        });
        let identifier = imported.identifier;
        let documentId = imported.documentId;
        if (!identifier || !documentId) {
          const docs = await listDocumentsForFolder(
            destinationClient,
            item.targetFolderId,
            targetFolderPath || destination.defaultFolderPath,
          );
          const match = docs
            .filter((doc) => doc.name === item.documentName)
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
          identifier ||= match?.identifier ?? '';
          documentId ||= match?.id ?? '';
        }
        if (!identifier && !documentId) throw new Error(`Import succeeded but destination document could not be identified.`);

        const warnings: string[] = [...(item.warnings ?? [])];
        if (targetFolderPath && documentId) {
          try {
            await destinationClient.moveDocument(documentId, targetFolderPath);
          } catch (error) {
            warnings.push(`Folder move failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (targetFolderPath && identifier) {
          try {
            const docsAfterImport = await destinationClient.listFolderDocuments(undefined);
            const importedDoc = docsAfterImport.find((doc) => doc.identifier === identifier || doc.id === documentId);
            const requestedPath = normalizeFolderPath(targetFolderPath);
            const actualPath = normalizeFolderPath(importedDoc?.folderPath);
            if (!actualPath) {
              warnings.push(`Folder placement could not be verified for imported document ${identifier}.`);
            } else if (actualPath !== requestedPath && !actualPath.endsWith(`/${requestedPath}`)) {
              warnings.push(`Folder placement mismatch for imported document ${identifier}: expected ${targetFolderPath}, found ${importedDoc?.folderPath}.`);
            }
          } catch (error) {
            warnings.push(`Folder placement verification failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        importedByDestinationAndSource.set(`${item.targetId || destination.id}:${item.documentId}`, { identifier, documentId });
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          importedIdentifier: identifier,
          importedDocumentId: documentId,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
        releaseExportConsumer(item.documentId);
      } else if (item.kind === 'metadata') {
        if (!item.documentId) throw new Error('Metadata item missing document id.');
        const imported = importedByDestinationAndSource.get(`${item.targetId || destination.id}:${item.documentId}`);
        if (!imported?.identifier) {
          markAndPersistItem(item, 'skipped', { error: 'No imported document identifier available for metadata preservation.' });
          return;
        }
        const meta = sourceMeta.get(item.documentId);
        const warnings: string[] = [];
        if (meta?.description) {
          try {
            await destinationClient.patchDocument(imported.identifier, { description: meta.description, clearExistingDraft: true });
          } catch (error) {
            warnings.push(`Description copy failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (meta?.labels?.length) {
          try {
            let labelSet = destinationLabelCache.get(destination.id);
            if (!labelSet) {
              labelSet = new Set((await destinationClient.listLabels()).map((label) => label.name));
              destinationLabelCache.set(destination.id, labelSet);
            }
            for (const label of meta.labels) {
              if (!labelSet.has(label)) {
                const sourceLabel = sourceLabels.get(label);
                await destinationClient.createLabel({ name: label, color: sourceLabel?.color, description: sourceLabel?.description });
                labelSet.add(label);
              }
            }
            await destinationClient.setDocumentLabels(imported.identifier, meta.labels);
          } catch (error) {
            warnings.push(`Label copy failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', { warnings: warnings.length > 0 ? warnings : undefined });
      }
    } catch (error) {
      const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
      markAndPersistItem(item, 'failed', { error: message });
      if (item.kind === 'import') releaseExportConsumer(item.documentId);
    }
  }

  async function runGroupedDestinationItems(itemsToRun: MigrationJobItem[]): Promise<void> {
    const groups = new Map<string, MigrationJobItem[]>();
    for (const item of itemsToRun) {
      if (item.kind === 'export' || item.status !== 'pending') continue;
      const rows = groups.get(item.destinationId) || [];
      rows.push(item);
      groups.set(item.destinationId, rows);
    }
    await runWithConcurrency([...groups.values()], destinationConcurrency(), async (items) => {
      for (const item of items) {
        if (canceledJobs.has(job.id)) {
          markAndPersistItem(item, 'skipped', { error: 'Canceled by user.' });
          if (item.kind === 'import') releaseExportConsumer(item.documentId);
          continue;
        }
        await processDestinationItem(item);
      }
    });
  }

  async function runDeleteStage(): Promise<void> {
    await runGroupedDestinationItems(job.items.filter((item) => item.kind === 'delete' && item.status === 'pending'));
  }

  async function runDocumentStage(documentId: string, exportItems: MigrationJobItem[]): Promise<void> {
    const exported = await exportDocumentOnce(documentId, exportItems);
    if (!exported) return;
    if (canceledJobs.has(job.id)) {
      exports.delete(documentId);
      return;
    }

    const pendingImports = job.items.filter((item) => (
      item.kind === 'import'
      && item.status === 'pending'
      && item.documentId === documentId
    ));
    if (pendingImports.length > 0) importConsumers.set(documentId, pendingImports.length);

    const documentItems = job.items.filter((item) => (
      item.status === 'pending'
      && item.documentId === documentId
      && item.kind !== 'export'
      && item.kind !== 'delete'
    ));
    await runGroupedDestinationItems(documentItems);
    importConsumers.delete(documentId);
    exports.delete(documentId);
  }

  async function runRemainingDestinationStage(): Promise<void> {
    await runGroupedDestinationItems(job.items.filter((item) => (
      item.status === 'pending'
      && item.kind !== 'export'
      && item.kind !== 'delete'
    )));
  }

  await runDeleteStage();
  const exportsByDocument = exportItemsByDocument();
  for (const [documentId, exportItems] of exportsByDocument.entries()) {
    if (canceledJobs.has(job.id)) break;
    await runDocumentStage(documentId, exportItems);
  }
  if (!canceledJobs.has(job.id)) await runRemainingDestinationStage();

  if (canceledJobs.has(job.id)) {
    markPendingItemsSkipped(job, 'Canceled by user.');
    job.status = 'canceled';
    job.endedAt = Date.now();
    persistJobStatus(job);
    return;
  }

  await runJobPostActions(job);
  job.status = computeJobStatus(job.items);
  job.endedAt = Date.now();
  persistJobStatus(job);
}

async function runJobPostActions(job: MigrationJob): Promise<void> {
  const actions = activePostMigrationActions.get(job.id) ?? [];
  for (const action of actions) {
    if (canceledJobs.has(job.id)) return;
    const destination = action.kind === 'refresh-schema' && action.destinationInstanceId
      ? requireInstance(action.destinationInstanceId)
      : null;
    const item: MigrationJobItem = {
      id: randomUUID(),
      jobId: job.id,
      destinationId: destination?.id || 'post-actions',
      destinationLabel: destination?.label || 'Post-migration',
      targetModelId: action.targetModelId,
      targetModelName: action.targetModelName,
      kind: 'post_action',
      documentName: action.name,
      status: 'running',
      startedAt: Date.now(),
    };
    job.items.push(item);
    updateJobItem(item);
    const result = action.kind === 'refresh-schema'
      ? await runSchemaRefreshAction(action)
      : await runPostMigrationAction(action);
    markAndPersistItem(item, result.ok ? 'succeeded' : 'failed', {
      error: result.ok ? undefined : result.error,
      warnings: result.ok && result.warning ? [result.warning] : undefined,
    });
    publishMigrationJobEvent({
      type: 'post-migration',
      jobId: job.id,
      results: { action: action.name, ...result },
      at: Date.now(),
    });
  }
}

async function runSchemaRefreshAction(action: PostMigrationAction): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (!action.destinationInstanceId) return { ok: false, error: 'Schema refresh action is missing a destination instance.' };
  if (!action.targetModelId) return { ok: false, error: 'Schema refresh action is missing a target model.' };
  try {
    const destination = requireInstance(action.destinationInstanceId);
    const result = await new OmniClient(destination).refreshModel(action.targetModelId);
    const detail = [
      result.jobId ? `job ${result.jobId}` : '',
      result.status ? `status ${result.status}` : '',
    ].filter(Boolean).join(', ');
    return { ok: true, warning: detail ? `Schema refresh queued (${detail}).` : 'Schema refresh queued.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runPostMigrationAction(action: PostMigrationAction): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (action.kind === 'refresh-schema') return runSchemaRefreshAction(action);
  const validationError = validatePostMigrationActionTarget(action);
  if (validationError) return { ok: false, error: validationError };

  const url = new URL(action.url);
  try {
    const response = await fetch(url, {
      method: action.method,
      headers: action.headers,
      body: action.method === 'GET' ? undefined : action.body || undefined,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      error: response.ok ? undefined : `Action returned ${response.status}: ${text.slice(0, 300)}`,
      warning: response.ok ? `Action returned ${response.status}` : undefined,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
