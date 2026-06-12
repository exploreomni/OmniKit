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

export { redactSensitiveText, sanitizeJobHistory } from './jobSanitizer';

const PRIVATE_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|fc00:|fd[0-9a-f]{2}:)/i;
const LOOPBACK_NAMES = new Set(['localhost', '0.0.0.0']);
const DEFAULT_DESTINATION_CONCURRENCY = 10;

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'canceled';
export type JobItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'warning' | 'skipped';
export type JobItemKind = 'delete' | 'export' | 'import' | 'metadata' | 'post_action';

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
  status: JobItemStatus;
  error?: string;
  warnings?: string[];
  startedAt?: number;
  endedAt?: number;
  exportHash?: string;
  importedIdentifier?: string;
  importedDocumentId?: string;
}

export interface MigrationJob {
  id: string;
  sourceId: string;
  sourceLabel: string;
  destinationIds: string[];
  targets?: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
  postMigrationActions: PostMigrationAction[];
  status: JobStatus;
  parentJobId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
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
  warnings?: string[];
}

export interface MigrationPlan {
  sourceId: string;
  sourceLabel: string;
  destinationIds: string[];
  targets: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
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

function isLikelyFieldRef(value: string): boolean {
  return /^[A-Za-z_][\w/]*\.[A-Za-z_][\w]*$/.test(normalizeFieldRef(value));
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
}): Promise<MigrationPlan> {
  const source = requireInstance(input.sourceId);
  const targets = normalizeTargets(input);
  const sourceClient = new OmniClient(source);
  const sourceDocs = await listDocumentsForFolder(sourceClient, source.defaultFolderId, source.defaultFolderPath, true);
  const selected = sourceDocs.filter((doc) => input.documentIds.includes(doc.identifier));
  const missing = input.documentIds.filter((id) => !selected.some((doc) => doc.identifier === id));
  if (missing.length > 0) throw new Error(`Source documents not found: ${missing.join(', ')}`);

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
      if (input.emptyFirst) {
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
        });
      }
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
    steps,
  };
}

export async function createMigrationJob(input: {
  sourceId: string;
  destinationIds?: string[];
  targets?: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
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

export async function retryMigrationJob(id: string, options: { destinationId?: string } = {}): Promise<MigrationJob> {
  const parent = getJob(id);
  if (!parent) throw new Error('Job not found.');
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
    postMigrationActions: [],
    parentJobId: parent.id,
  });
}

export async function runMigrationJob(id: string): Promise<void> {
  if (runningJobs.has(id)) return;
  const job = getJob(id);
  if (!job) return;
  if (isTerminalJobStatus(job.status)) return;
  runningJobs.add(id);
  try {
    await executeJob(job);
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
    const docs = await listDocumentsForFolder(sourceClient, source.defaultFolderId, source.defaultFolderPath, true);
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

  async function runExportStage(): Promise<void> {
    const exportItemsByDocument = new Map<string, MigrationJobItem[]>();
    for (const item of job.items) {
      if (item.kind !== 'export' || !item.documentId) continue;
      const rows = exportItemsByDocument.get(item.documentId) || [];
      rows.push(item);
      exportItemsByDocument.set(item.documentId, rows);
    }

    for (const [documentId, exportItems] of exportItemsByDocument.entries()) {
      if (canceledJobs.has(job.id)) break;
      for (const item of exportItems) {
        if (item.status === 'pending') markAndPersistItem(item, 'running');
      }
      try {
        const payload = await sourceClient.exportDocument(documentId);
        const cached = { payload, hash: hashPayload(payload) };
        exports.set(documentId, cached);
        for (const item of exportItems) markAndPersistItem(item, 'succeeded', { exportHash: cached.hash });
      } catch (error) {
        const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
        for (const item of exportItems) markAndPersistItem(item, 'failed', { error: message });
        skipDependentItems(documentId, `Export failed; dependent step skipped. ${message}`);
      }
    }
  }

  async function processDestinationItem(item: MigrationJobItem): Promise<void> {
    if (canceledJobs.has(job.id)) {
      markAndPersistItem(item, 'skipped', { error: 'Canceled by user.' });
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

  async function runDestinationStage(): Promise<void> {
    for (const item of job.items) {
      if (item.kind === 'import' && item.status === 'pending' && item.documentId) {
        importConsumers.set(item.documentId, (importConsumers.get(item.documentId) || 0) + 1);
      }
    }
    const groups = new Map<string, MigrationJobItem[]>();
    for (const item of job.items) {
      if (item.kind === 'export' || item.status !== 'pending') continue;
      const rows = groups.get(item.destinationId) || [];
      rows.push(item);
      groups.set(item.destinationId, rows);
    }
    await runWithConcurrency([...groups.values()], destinationConcurrency(), async (items) => {
      for (const item of items) {
        if (canceledJobs.has(job.id)) {
          markAndPersistItem(item, 'skipped', { error: 'Canceled by user.' });
          continue;
        }
        await processDestinationItem(item);
      }
    });
  }

  await runExportStage();
  if (!canceledJobs.has(job.id)) await runDestinationStage();

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
  let url: URL;
  try {
    url = new URL(action.url);
  } catch {
    return { ok: false, error: 'Post-migration action URL is invalid.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Post-migration actions must use HTTPS.' };
  }
  const allowPrivate = process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS === 'true';
  const hostname = url.hostname.toLowerCase();
  if (!allowPrivate && (LOOPBACK_NAMES.has(hostname) || PRIVATE_HOST_RE.test(hostname))) {
    return { ok: false, error: 'Private-network post-migration actions are blocked by default.' };
  }
  const allowlist = (process.env.OMNIKIT_POST_ACTION_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return { ok: false, error: `Post-migration action host is not allowlisted: ${hostname}.` };
  }
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
