import { createHash, randomUUID } from 'node:crypto';
import { OmniClient, OmniClientError, type OmniDocumentRecord, type OmniModelBranchResult, type OmniModelQueryViewRecord, type OmniModelYamlResponse, type OmniValidationIssue } from './omniClient';
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
  redactSensitiveText,
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
import {
  fetchPostMigrationAction,
  validatePostMigrationActionTargetForRequest,
} from './postMigrationActions';
import { readThroughCache } from './readThroughCache';

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
  | 'field_prepare'
  | 'query_view_prepare'
  | 'relationship_prepare'
  | 'topic_prepare'
  | 'post_action'
  | 'source_delete'
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
  routeGroupId?: string;
  routeGroupName?: string;
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
  notices?: string[];
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
  sourceConnectionId?: string;
  destinationIds: string[];
  targets?: MigrationTarget[];
  routeGroups?: MigrationRouteGroup[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed: boolean;
  deleteSourceOnSuccess: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
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
  routeGroupId?: string;
  routeGroupName?: string;
  targetId?: string;
  destinationId: string;
  destinationLabel: string;
  targetConnectionId?: string;
  targetModelId?: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
  kind: JobItemKind;
  documentId?: string;
  documentName?: string;
  replacement?: boolean;
  warnings?: string[];
  notices?: string[];
  blocked?: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface MigrationPlan {
  sourceId: string;
  sourceLabel: string;
  sourceConnectionId?: string;
  destinationIds: string[];
  targets: MigrationTarget[];
  routeGroups?: MigrationRouteGroup[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed: boolean;
  deleteSourceOnSuccess: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
  steps: MigrationPlanStep[];
}

export interface MigrationTarget {
  id: string;
  destinationInstanceId: string;
  destinationLabel?: string;
  targetConnectionId?: string;
  targetModelId: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
  topicMappings?: MigrationTopicMapping[];
  queryViewMappings?: MigrationQueryViewMapping[];
  fieldMappings?: MigrationFieldMapping[];
  semanticPatches?: MigrationSemanticPatch[];
}

export interface MigrationRouteGroup {
  id: string;
  name: string;
  documentIds: string[];
  targets: MigrationTarget[];
}

export interface MigrationSourceDocumentHint {
  id: string;
  identifier: string;
  name: string;
  connectionId?: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  baseModelName?: string;
  topicNames?: string[];
  topicIds?: string[];
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface DashboardMigrationJobInput {
  sourceId: string;
  sourceConnectionId?: string;
  destinationIds?: string[];
  targets?: MigrationTarget[];
  routeGroups?: MigrationRouteGroup[];
  documentIds: string[];
  sourceDocumentHints?: MigrationSourceDocumentHint[];
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  deleteSourceOnSuccess?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
  postMigrationActions: PostMigrationAction[];
  parentJobId?: string;
}

export type DashboardPatchValidationMode = 'branch' | 'structural' | 'skipped';
export type DashboardPatchValidationStatus = 'passed' | 'failed' | 'skipped';

export interface DashboardPatchValidationArtifact {
  id: string;
  artifactType: MigrationSemanticPatchArtifact;
  sourceName?: string;
  targetFileName: string;
  status: DashboardPatchValidationStatus;
  messages: string[];
}

export interface DashboardPatchValidationModelResult {
  targetId: string;
  destinationId: string;
  destinationLabel?: string;
  targetModelId: string;
  targetModelName?: string;
  mode: DashboardPatchValidationMode;
  status: DashboardPatchValidationStatus;
  artifacts: DashboardPatchValidationArtifact[];
  branchName?: string;
  error?: string;
  cleanupError?: string;
}

export interface DashboardPatchValidationResult {
  status: DashboardPatchValidationStatus;
  results: DashboardPatchValidationModelResult[];
}

export type MigrationTopicMappingAction = 'map_existing' | 'copy_source';

export interface MigrationTopicMapping {
  sourceTopicName: string;
  sourceTopicId?: string;
  action: MigrationTopicMappingAction;
  targetTopicName: string;
  targetTopicLabel?: string;
}

export type MigrationQueryViewMappingAction = 'map_existing' | 'copy_source' | 'use_existing_unverified' | 'update_existing';

export interface MigrationQueryViewMapping {
  sourceQueryViewName: string;
  sourceFileName?: string;
  action: MigrationQueryViewMappingAction;
  targetQueryViewName: string;
  targetFileName?: string;
  targetQueryViewLabel?: string;
}

export type MigrationFieldDependencyKind = 'dimension' | 'measure' | 'unknown';
export type MigrationFieldMappingAction = 'map_existing' | 'create_from_source' | 'ignore';
export type MigrationFieldDependencyStatus = 'ready' | 'warning' | 'blocked' | 'unresolved';

export interface MigrationFieldCandidate {
  fieldRef: string;
  label?: string;
  fieldKind?: MigrationFieldDependencyKind;
  matchType: 'exact' | 'field_name' | 'normalized' | 'label';
}

export interface MigrationFieldDependency {
  sourceFieldRef: string;
  sourceViewName: string;
  sourceFieldName: string;
  sourceFileName?: string;
  fieldKind: MigrationFieldDependencyKind;
  sourceYaml?: string;
  targetCandidates: MigrationFieldCandidate[];
  status: MigrationFieldDependencyStatus;
  reason?: string;
  warnings?: string[];
}

export interface MigrationFieldMapping {
  sourceFieldRef: string;
  action: MigrationFieldMappingAction;
  targetFieldRef?: string;
  targetFileName?: string;
  sourceFileName?: string;
}

export type MigrationSemanticPatchArtifact = 'field' | 'query_view' | 'topic' | 'relationship';
export type MigrationSemanticPatchResolution = 'recommended' | 'custom_edit' | 'keep_target' | 'use_source';
export type MigrationSemanticPatchStatus = 'ready' | 'warning' | 'blocked';
export type MigrationSemanticPatchSafetyCategory =
  | 'safe_ignore'
  | 'safe_map'
  | 'safe_create'
  | 'safe_update'
  | 'destructive_update'
  | 'manual_review'
  | 'blocked';

export type MigrationSemanticDependencyKind = 'dashboard' | 'topic' | 'query_view' | 'model_field' | 'relationship' | 'model_file';

export interface MigrationSemanticDependencyNode {
  kind: MigrationSemanticDependencyKind;
  label: string;
  ref?: string;
  detail?: string;
}

export interface MigrationSemanticPatch {
  id: string;
  artifactType: MigrationSemanticPatchArtifact;
  sourceName?: string;
  sourceFileName?: string;
  targetFileName: string;
  targetModelId?: string;
  currentYaml?: string;
  sourceYaml?: string;
  recommendedYaml?: string;
  acceptedYaml?: string;
  previousChecksum?: string;
  latestChecksum?: string;
  checksumStale?: boolean;
  resolution: MigrationSemanticPatchResolution;
  destructive?: boolean;
  confirmedDestructive?: boolean;
  status?: MigrationSemanticPatchStatus;
  safetyCategory?: MigrationSemanticPatchSafetyCategory;
  recommendedAction?: string;
  dependencyPath?: MigrationSemanticDependencyNode[];
  warnings?: string[];
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
    routeGroupId: step.routeGroupId,
    routeGroupName: step.routeGroupName,
    targetId: step.targetId,
    destinationId: destination.id,
    destinationLabel: destination.label,
    targetModelId: step.targetModelId,
    targetModelName: step.targetModelName,
    details: step.targetConnectionId || step.details
      ? { ...(step.targetConnectionId ? { targetConnectionId: step.targetConnectionId } : {}), ...(step.details || {}) }
      : undefined,
    targetFolderId: step.targetFolderId,
    targetFolderPath: step.targetFolderPath,
    kind: step.kind,
    documentId: step.documentId,
    documentName: step.documentName,
    replacement: step.replacement,
    status: 'pending',
    warnings: step.warnings,
    notices: step.notices,
    error: step.error,
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

function isSqlOperatorFunctionRef(value: string): boolean {
  const [namespace] = normalizeFieldRef(value).split('.');
  return namespace?.toLowerCase() === 'sqlstdoperatortable';
}

function isLikelyFieldRef(value: string): boolean {
  const normalized = normalizeFieldRef(value);
  return !isOmniFormulaFunctionRef(normalized)
    && !isSqlOperatorFunctionRef(normalized)
    && /^[A-Za-z_][\w/]*\.[A-Za-z_][\w]*$/.test(normalized);
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

interface ModelFieldDefinition {
  fieldRef: string;
  sourceViewName: string;
  sourceFieldName: string;
  sourceFileName: string;
  fieldKind: MigrationFieldDependencyKind;
  sourceYaml: string;
  label?: string;
}

function fieldRefParts(fieldRef: string): { viewName: string; fieldName: string } {
  const normalized = normalizeFieldRef(fieldRef);
  const [viewName, ...fieldParts] = normalized.split('.');
  return {
    viewName: viewName || '',
    fieldName: fieldParts.join('.') || '',
  };
}

function extractFieldDefinitionsFromViewYaml(fileName: string, yaml: string): ModelFieldDefinition[] {
  if (!fileName.endsWith('.view')) return [];
  const lines = yaml.split(/\r?\n/);
  const definitions: ModelFieldDefinition[] = [];
  const viewNames = viewNameVariants(fileName);
  let activeKind: MigrationFieldDependencyKind | undefined;
  let sectionIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const sectionMatch = line.match(/^(\s*)(dimensions|measures):\s*$/);
    if (sectionMatch) {
      activeKind = sectionMatch[2] === 'measures' ? 'measure' : 'dimension';
      sectionIndent = sectionMatch[1].length;
      continue;
    }
    if (!activeKind) continue;
    if (indent <= sectionIndent) {
      activeKind = undefined;
      sectionIndent = -1;
      continue;
    }
    if (indent !== sectionIndent + 2) continue;
    const fieldMatch = line.trim().match(/^([A-Za-z_][\w]*):/);
    if (!fieldMatch) continue;
    let endIndex = index + 1;
    for (; endIndex < lines.length; endIndex += 1) {
      const nextLine = lines[endIndex];
      if (!nextLine.trim()) continue;
      const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent <= indent) break;
    }
    const sourceYaml = lines.slice(index, endIndex).join('\n');
    const labelMatch = sourceYaml.match(/^\s*label:\s*(.+?)\s*$/m);
    for (const viewName of viewNames) {
      definitions.push({
        fieldRef: `${viewName}.${fieldMatch[1]}`,
        sourceViewName: viewName,
        sourceFieldName: fieldMatch[1],
        sourceFileName: fileName,
        fieldKind: activeKind,
        sourceYaml,
        ...(labelMatch?.[1] ? { label: labelMatch[1].replace(/^['"]|['"]$/g, '') } : {}),
      });
    }
  }

  return definitions;
}

function extractFieldsFromViewYaml(fileName: string, yaml: string): string[] {
  const refs = new Set<string>();
  for (const definition of extractFieldDefinitionsFromViewYaml(fileName, yaml)) {
    refs.add(definition.fieldRef);
  }
  return [...refs];
}

async function loadTargetFieldUniverse(
  client: OmniClient,
  modelId: string,
  loadYamlFiles: () => Promise<Record<string, string>> = () => client.getModelYamlFiles(modelId),
): Promise<{ fields: Set<string>; definitions: Map<string, ModelFieldDefinition>; warning?: string }> {
  try {
    const files = await loadYamlFiles();
    const fields = new Set<string>();
    const definitions = new Map<string, ModelFieldDefinition>();
    for (const [fileName, yaml] of Object.entries(files)) {
      for (const definition of extractFieldDefinitionsFromViewYaml(fileName, yaml)) {
        fields.add(definition.fieldRef);
        definitions.set(definition.fieldRef.toLowerCase(), definition);
      }
    }
    return { fields, definitions };
  } catch (error) {
    return {
      fields: new Set<string>(),
      definitions: new Map<string, ModelFieldDefinition>(),
      warning: `Target model YAML inspection failed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

function fieldDefinitionIndex(files: Record<string, string>): Map<string, ModelFieldDefinition> {
  const definitions = new Map<string, ModelFieldDefinition>();
  for (const [fileName, yaml] of Object.entries(files)) {
    for (const definition of extractFieldDefinitionsFromViewYaml(fileName, yaml)) {
      definitions.set(definition.fieldRef.toLowerCase(), definition);
    }
  }
  return definitions;
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizedFieldNameVariants(value: string): Set<string> {
  const normalized = normalizedFieldName(value);
  const variants = new Set([normalized]);
  if (normalized.startsWith('semantic') && normalized.length > 'semantic'.length) {
    variants.add(normalized.slice('semantic'.length));
  }
  return variants;
}

function fieldCandidateKey(candidate: MigrationFieldCandidate): string {
  return `${candidate.fieldRef.toLowerCase()}:${candidate.matchType}`;
}

function targetFieldCandidates(
  sourceFieldRef: string,
  targetDefinitions: Map<string, ModelFieldDefinition>,
): MigrationFieldCandidate[] {
  const sourceParts = fieldRefParts(sourceFieldRef);
  const sourceFieldName = sourceParts.fieldName.toLowerCase();
  const normalizedSourceFieldNames = normalizedFieldNameVariants(sourceParts.fieldName);
  const candidates = new Map<string, MigrationFieldCandidate>();
  const exact = targetDefinitions.get(sourceFieldRef.toLowerCase());
  if (exact) {
    candidates.set(fieldCandidateKey({
      fieldRef: exact.fieldRef,
      label: exact.label,
      fieldKind: exact.fieldKind,
      matchType: 'exact',
    }), {
      fieldRef: exact.fieldRef,
      label: exact.label,
      fieldKind: exact.fieldKind,
      matchType: 'exact',
    });
  }
  for (const definition of targetDefinitions.values()) {
    const targetFieldName = definition.sourceFieldName.toLowerCase();
    const normalizedTargetFieldNames = normalizedFieldNameVariants(definition.sourceFieldName);
    const labelMatch = definition.label && [...normalizedFieldNameVariants(definition.label)]
      .some((variant) => normalizedSourceFieldNames.has(variant));
    const matchType: MigrationFieldCandidate['matchType'] | undefined = targetFieldName === sourceFieldName
      ? 'field_name'
      : [...normalizedTargetFieldNames].some((variant) => normalizedSourceFieldNames.has(variant))
        ? 'normalized'
        : labelMatch
          ? 'label'
          : undefined;
    if (!matchType) continue;
    const candidate: MigrationFieldCandidate = {
      fieldRef: definition.fieldRef,
      label: definition.label,
      fieldKind: definition.fieldKind,
      matchType,
    };
    candidates.set(fieldCandidateKey(candidate), candidate);
  }
  return [...candidates.values()].sort((a, b) => {
    const rank = { exact: 0, field_name: 1, normalized: 2, label: 3 } satisfies Record<MigrationFieldCandidate['matchType'], number>;
    return rank[a.matchType] - rank[b.matchType] || a.fieldRef.localeCompare(b.fieldRef);
  });
}

function dependencyFromFieldRef(input: {
  fieldRef: string;
  sourceDefinitions: Map<string, ModelFieldDefinition>;
  targetDefinitions: Map<string, ModelFieldDefinition>;
  status: MigrationFieldDependencyStatus;
  reason?: string;
  warnings?: string[];
}): MigrationFieldDependency {
  const sourceDefinition = input.sourceDefinitions.get(input.fieldRef.toLowerCase());
  const parts = fieldRefParts(input.fieldRef);
  return {
    sourceFieldRef: input.fieldRef,
    sourceViewName: sourceDefinition?.sourceViewName || parts.viewName,
    sourceFieldName: sourceDefinition?.sourceFieldName || parts.fieldName,
    sourceFileName: sourceDefinition?.sourceFileName,
    fieldKind: sourceDefinition?.fieldKind || 'unknown',
    sourceYaml: sourceDefinition?.sourceYaml,
    targetCandidates: targetFieldCandidates(input.fieldRef, input.targetDefinitions),
    status: input.status,
    reason: input.reason,
    warnings: input.warnings,
  };
}

function mappingForSourceField(
  sourceFieldRef: string,
  mappings: MigrationFieldMapping[],
): MigrationFieldMapping | undefined {
  const sourceKey = normalizeFieldRef(sourceFieldRef).toLowerCase();
  return mappings.find((mapping) => normalizeFieldRef(mapping.sourceFieldRef).toLowerCase() === sourceKey);
}

function validateFieldDependencies(input: {
  missingFields: string[];
  configuredMappings: MigrationFieldMapping[];
  sourceDefinitions: Map<string, ModelFieldDefinition>;
  targetDefinitions: Map<string, ModelFieldDefinition>;
  targetFields: Set<string>;
  targetModelName: string;
  targetModelProtected: boolean;
  targetModelGitConfigured: boolean;
}): {
  fieldDependencies: MigrationFieldDependency[];
  resolvedFieldMappings: MigrationFieldMapping[];
  fieldBlockers: string[];
  fieldWarnings: string[];
  ignoredFieldRefs: string[];
  createdFieldRefs: string[];
  mappedFieldRefs: string[];
} {
  const fieldDependencies: MigrationFieldDependency[] = [];
  const resolvedFieldMappings: MigrationFieldMapping[] = [];
  const fieldBlockers: string[] = [];
  const fieldWarnings: string[] = [];
  const ignoredFieldRefs: string[] = [];
  const createdFieldRefs: string[] = [];
  const mappedFieldRefs: string[] = [];
  const targetFieldKeys = new Set([...input.targetFields].map((fieldRef) => normalizeFieldRef(fieldRef).toLowerCase()));
  const plannedFieldKeys = new Set<string>();
  const processedFieldKeys = new Set<string>();
  const pendingFieldRefs = [...new Set(input.missingFields.map(normalizeFieldRef).filter(Boolean))];
  const queuedFieldKeys = new Set(pendingFieldRefs.map((fieldRef) => fieldRef.toLowerCase()));
  const dependencyParents = new Map<string, Set<string>>();

  function enqueueDependentField(fieldRef: string, parentFieldRef: string): void {
    const normalized = normalizeFieldRef(fieldRef);
    const parent = normalizeFieldRef(parentFieldRef);
    if (!normalized || normalized.toLowerCase() === parent.toLowerCase()) return;
    const key = normalized.toLowerCase();
    const parentSet = dependencyParents.get(key) || new Set<string>();
    parentSet.add(parent);
    dependencyParents.set(key, parentSet);
    if (targetFieldKeys.has(key) || plannedFieldKeys.has(key) || queuedFieldKeys.has(key)) return;
    pendingFieldRefs.push(normalized);
    queuedFieldKeys.add(key);
  }

  while (pendingFieldRefs.length > 0) {
    const fieldRef = pendingFieldRefs.shift();
    if (!fieldRef) continue;
    const fieldKey = fieldRef.toLowerCase();
    if (processedFieldKeys.has(fieldKey)) continue;
    processedFieldKeys.add(fieldKey);
    const mapping = mappingForSourceField(fieldRef, input.configuredMappings);
    const sourceDefinition = input.sourceDefinitions.get(fieldKey);
    const parentRefs = [...(dependencyParents.get(fieldKey) || [])];
    const parentReason = parentRefs.length > 0
      ? ` It is required by ${formatFieldList(parentRefs, 3)}.`
      : '';
    if (!mapping) {
      fieldDependencies.push(dependencyFromFieldRef({
        fieldRef,
        sourceDefinitions: input.sourceDefinitions,
        targetDefinitions: input.targetDefinitions,
        status: 'unresolved',
        reason: `Choose how to resolve ${fieldRef} before importing this dashboard.${parentReason}`,
      }));
      fieldBlockers.push(`Field ${fieldRef} is missing from the destination model and needs a resolution choice.`);
      continue;
    }

    if (mapping.action === 'ignore') {
      const warning = `Field ${fieldRef} will be ignored for this migration. Dashboard tiles that reference it may still fail after import.`;
      fieldDependencies.push(dependencyFromFieldRef({
        fieldRef,
        sourceDefinitions: input.sourceDefinitions,
        targetDefinitions: input.targetDefinitions,
        status: 'warning',
        reason: warning,
        warnings: [warning],
      }));
      resolvedFieldMappings.push(mapping);
      ignoredFieldRefs.push(fieldRef);
      fieldWarnings.push(warning);
      continue;
    }

    if (mapping.action === 'map_existing') {
      const targetFieldRef = mapping.targetFieldRef ? normalizeFieldRef(mapping.targetFieldRef) : '';
      if (!targetFieldRef) {
        fieldDependencies.push(dependencyFromFieldRef({
          fieldRef,
          sourceDefinitions: input.sourceDefinitions,
          targetDefinitions: input.targetDefinitions,
          status: 'blocked',
          reason: `Select an existing target field for ${fieldRef}.`,
        }));
        fieldBlockers.push(`Field ${fieldRef} is mapped to an empty target field.`);
        continue;
      }
      if (!targetFieldKeys.has(targetFieldRef.toLowerCase())) {
        fieldDependencies.push(dependencyFromFieldRef({
          fieldRef,
          sourceDefinitions: input.sourceDefinitions,
          targetDefinitions: input.targetDefinitions,
          status: 'blocked',
          reason: `Mapped target field ${targetFieldRef} was not found in the destination model.`,
        }));
        fieldBlockers.push(`Mapped target field ${targetFieldRef} for ${fieldRef} was not found in the destination model.`);
        continue;
      }
      if (input.targetModelProtected) {
        fieldDependencies.push(dependencyFromFieldRef({
          fieldRef,
          sourceDefinitions: input.sourceDefinitions,
          targetDefinitions: input.targetDefinitions,
          status: 'blocked',
          reason: `${input.targetModelName} requires protected branch or pull-request YAML changes.`,
        }));
        fieldBlockers.push(`Cannot create compatibility alias ${fieldRef} directly because ${input.targetModelName} requires protected branch or pull-request YAML changes.`);
        continue;
      }
      fieldDependencies.push(dependencyFromFieldRef({
        fieldRef,
        sourceDefinitions: input.sourceDefinitions,
        targetDefinitions: input.targetDefinitions,
        status: 'ready',
        reason: `Will map ${fieldRef} to ${targetFieldRef}.`,
      }));
      const sourceParts = fieldRefParts(fieldRef);
      resolvedFieldMappings.push({
        ...mapping,
        targetFieldRef,
        sourceFileName: mapping.sourceFileName || sourceDefinition?.sourceFileName,
        targetFileName: mapping.targetFileName || sourceDefinition?.sourceFileName || `${sourceParts.viewName}.view`,
      });
      plannedFieldKeys.add(fieldKey);
      mappedFieldRefs.push(fieldRef);
      continue;
    }

    if (!sourceDefinition?.sourceYaml) {
      fieldDependencies.push(dependencyFromFieldRef({
        fieldRef,
        sourceDefinitions: input.sourceDefinitions,
        targetDefinitions: input.targetDefinitions,
        status: 'blocked',
        reason: `Source YAML was not found for ${fieldRef}.${parentReason}`,
      }));
      fieldBlockers.push(`Cannot create field ${fieldRef} because source YAML was not found.`);
      continue;
    }
    if (input.targetModelProtected) {
      fieldDependencies.push(dependencyFromFieldRef({
        fieldRef,
        sourceDefinitions: input.sourceDefinitions,
        targetDefinitions: input.targetDefinitions,
        status: 'blocked',
        reason: `${input.targetModelName} requires protected branch or pull-request YAML changes.`,
      }));
      fieldBlockers.push(`Cannot create field ${fieldRef} directly because ${input.targetModelName} requires protected branch or pull-request YAML changes.`);
      continue;
    }
    const warnings = input.targetModelGitConfigured
      ? [`Target model ${input.targetModelName} is git configured; created field YAML may require Omni-side review after import.`]
      : [];
    const dependentMissingFields = extractFieldRefsFromString(sourceDefinition.sourceYaml)
      .map(normalizeFieldRef)
      .filter((ref) => ref && ref.toLowerCase() !== fieldKey)
      .filter((ref) => !targetFieldKeys.has(ref.toLowerCase()) && !plannedFieldKeys.has(ref.toLowerCase()));
    for (const dependentFieldRef of dependentMissingFields) {
      enqueueDependentField(dependentFieldRef, fieldRef);
    }
    if (dependentMissingFields.length > 0) {
      warnings.push(`Created field ${fieldRef} depends on missing target fields: ${formatFieldList(dependentMissingFields)}.`);
    }
    fieldDependencies.push(dependencyFromFieldRef({
      fieldRef,
      sourceDefinitions: input.sourceDefinitions,
      targetDefinitions: input.targetDefinitions,
      status: warnings.length > 0 ? 'warning' : 'ready',
      reason: `Will create ${fieldRef} from the source model before import.`,
      warnings,
    }));
    resolvedFieldMappings.push({
      ...mapping,
      sourceFileName: mapping.sourceFileName || sourceDefinition.sourceFileName,
      targetFileName: mapping.targetFileName || sourceDefinition.sourceFileName,
    });
    plannedFieldKeys.add(fieldKey);
    createdFieldRefs.push(fieldRef);
    fieldWarnings.push(...warnings);
  }

  return {
    fieldDependencies,
    resolvedFieldMappings,
    fieldBlockers: [...new Set(fieldBlockers)],
    fieldWarnings: [...new Set(fieldWarnings)],
    ignoredFieldRefs: [...new Set(ignoredFieldRefs)],
    createdFieldRefs: [...new Set(createdFieldRefs)],
    mappedFieldRefs: [...new Set(mappedFieldRefs)],
  };
}

function fieldSectionName(kind: MigrationFieldDependencyKind): 'dimensions' | 'measures' {
  return kind === 'measure' ? 'measures' : 'dimensions';
}

function fieldDefinitionBlockForAlias(input: {
  sourceFieldRef: string;
  targetFieldRef: string;
  sourceDefinition?: ModelFieldDefinition;
}): string {
  const parts = fieldRefParts(input.sourceFieldRef);
  const firstLine = `  ${parts.fieldName}:`;
  const aliasSql = `    sql: \${${input.targetFieldRef}}`;
  if (!input.sourceDefinition?.sourceYaml) return `${firstLine}\n${aliasSql}`;
  const lines = input.sourceDefinition.sourceYaml.split(/\r?\n/);
  const preserved = lines.slice(1).filter((line) => !/^\s*sql:\s*/.test(line));
  return [firstLine, aliasSql, ...preserved].join('\n');
}

function mergeFieldDefinitionIntoViewYaml(input: {
  existingYaml?: string;
  fieldKind: MigrationFieldDependencyKind;
  fieldYaml: string;
}): string {
  const sectionName = fieldSectionName(input.fieldKind);
  const fieldYaml = input.fieldYaml.trimEnd();
  const existingYaml = input.existingYaml?.trimEnd();
  if (!existingYaml) return `${sectionName}:\n${fieldYaml}\n`;

  const lines = existingYaml.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => new RegExp(`^\\s*${sectionName}:\\s*$`).test(line));
  if (sectionIndex === -1) {
    return `${existingYaml}\n${sectionName}:\n${fieldYaml}\n`;
  }
  const sectionIndent = lines[sectionIndex].match(/^\s*/)?.[0].length ?? 0;
  let insertIndex = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= sectionIndent) {
      insertIndex = index;
      break;
    }
  }
  return [
    ...lines.slice(0, insertIndex),
    fieldYaml,
    ...lines.slice(insertIndex),
  ].join('\n').trimEnd() + '\n';
}

function semanticPatchForFieldMapping(input: {
  mapping: MigrationFieldMapping;
  sourceDefinitions: Map<string, ModelFieldDefinition>;
  targetYamlFiles: Record<string, string>;
  targetChecksums?: Record<string, string>;
}): MigrationSemanticPatch | undefined {
  const sourceFieldRef = normalizeFieldRef(input.mapping.sourceFieldRef);
  if (!sourceFieldRef || input.mapping.action === 'ignore') return undefined;
  const sourceDefinition = input.sourceDefinitions.get(sourceFieldRef.toLowerCase());
  const sourceParts = fieldRefParts(sourceFieldRef);
  const targetFileName = input.mapping.targetFileName || sourceDefinition?.sourceFileName || `${sourceParts.viewName}.view`;
  const fieldKind = sourceDefinition?.fieldKind || 'dimension';
  const fieldYaml = input.mapping.action === 'map_existing'
    ? fieldDefinitionBlockForAlias({
      sourceFieldRef,
      targetFieldRef: input.mapping.targetFieldRef || '',
      sourceDefinition,
    })
    : sourceDefinition?.sourceYaml;
  if (!fieldYaml) return undefined;
	  const currentYaml = input.targetYamlFiles[targetFileName];
	  const recommendedYaml = mergeFieldDefinitionIntoViewYaml({
	    existingYaml: currentYaml,
	    fieldKind,
	    fieldYaml,
	  });
	  const safety = input.mapping.action === 'map_existing'
	    ? {
	      safetyCategory: 'safe_map' as const,
	      status: 'ready' as const,
	      warnings: [] as string[],
	    }
	    : updatePatchSafety({
	      currentYaml,
	      previousChecksum: input.targetChecksums?.[targetFileName],
	      createCategory: 'safe_create',
	      updateCategory: 'safe_update',
	    });
	  const warnings = [
	    ...(input.mapping.action === 'map_existing'
	      ? [`Creates a compatibility alias for ${sourceFieldRef} pointing to ${input.mapping.targetFieldRef}.`]
	      : []),
	    ...safety.warnings,
	  ];
	  return {
	    id: semanticPatchId({ artifactType: 'field', sourceName: sourceFieldRef, targetFileName }),
	    artifactType: 'field',
	    sourceName: sourceFieldRef,
    sourceFileName: input.mapping.sourceFileName || sourceDefinition?.sourceFileName,
    targetFileName,
    currentYaml,
    sourceYaml: fieldYaml,
    recommendedYaml,
	    previousChecksum: input.targetChecksums?.[targetFileName],
	    resolution: 'recommended',
	    status: safety.status,
	    safetyCategory: safety.safetyCategory,
	    recommendedAction: input.mapping.action === 'map_existing'
	      ? `Map ${sourceFieldRef} to ${input.mapping.targetFieldRef} by adding a compatibility alias.`
	      : `Create ${sourceFieldRef} from source model YAML.`,
	    dependencyPath: [
	      { kind: 'model_field', label: sourceFieldRef, ref: sourceFieldRef, detail: 'Dashboard references this source field.' },
	      { kind: 'model_file', label: targetFileName, ref: targetFileName, detail: currentYaml ? 'Destination model file will be updated.' : 'Destination model file will be created.' },
	    ],
	    warnings: warnings.length > 0 ? warnings : undefined,
	  };
	}

function semanticPatchForQueryViewMapping(input: {
  mapping: MigrationQueryViewMapping;
  sourceQueryViews: OmniModelQueryViewRecord[];
  targetQueryViews: OmniModelQueryViewRecord[];
}): MigrationSemanticPatch | undefined {
  if (input.mapping.action !== 'copy_source' && input.mapping.action !== 'update_existing') return undefined;
  const sourceQueryView = sourceQueryViewForMapping(input.sourceQueryViews, input.mapping);
  if (!sourceQueryView?.yaml) return undefined;
  const targetQueryView = queryViewFromCatalogByValue(input.targetQueryViews, input.mapping.targetQueryViewName)
    || queryViewFromCatalogByValue(input.targetQueryViews, input.mapping.targetFileName);
	  const targetFileName = input.mapping.targetFileName
	    || targetQueryView?.fileName
	    || `${input.mapping.targetQueryViewName}.query.view`;
	  const safety = updatePatchSafety({
	    currentYaml: targetQueryView?.yaml,
	    previousChecksum: targetQueryView?.checksum,
	    destructive: input.mapping.action === 'update_existing',
	    createCategory: 'safe_create',
	    updateCategory: 'safe_update',
	  });
	  const warnings = [
	    ...(input.mapping.action === 'update_existing'
	      ? [`Updates existing query view ${targetQueryView?.label || targetQueryView?.name || input.mapping.targetQueryViewName}.`]
	      : []),
	    ...safety.warnings,
	  ];
	  return {
    id: semanticPatchId({
      artifactType: 'query_view',
      sourceName: input.mapping.sourceQueryViewName,
      targetFileName,
    }),
    artifactType: 'query_view',
    sourceName: input.mapping.sourceQueryViewName,
    sourceFileName: input.mapping.sourceFileName || sourceQueryView.fileName,
    targetFileName,
    currentYaml: targetQueryView?.yaml,
    sourceYaml: sourceQueryView.yaml,
    recommendedYaml: sourceQueryView.yaml,
	    previousChecksum: targetQueryView?.checksum,
	    resolution: 'recommended',
	    destructive: input.mapping.action === 'update_existing',
	    status: safety.status,
	    safetyCategory: safety.safetyCategory,
	    recommendedAction: input.mapping.action === 'update_existing'
	      ? `Update existing destination query view ${targetQueryView?.label || targetQueryView?.name || input.mapping.targetQueryViewName} from the source query-view YAML.`
	      : `Create destination query view ${input.mapping.targetQueryViewName} from source query-view YAML.`,
	    dependencyPath: [
	      { kind: 'query_view', label: input.mapping.sourceQueryViewName, ref: input.mapping.sourceFileName || input.mapping.sourceQueryViewName, detail: 'Topic or dashboard references this query view.' },
	      { kind: 'model_file', label: targetFileName, ref: targetFileName, detail: targetQueryView?.yaml ? 'Destination query-view file will be updated.' : 'Destination query-view file will be created.' },
	    ],
	    warnings: warnings.length > 0 ? warnings : undefined,
	  };
	}

function semanticPatchForTopicMapping(input: {
  topic: SourceTopicRef;
  mapping: MigrationTopicMapping;
  sourceTopics: Array<{ name: string; fileName?: string; yaml?: string }>;
  targetTopics: Array<{ name: string; fileName?: string; yaml?: string; checksum?: string }>;
}): MigrationSemanticPatch | undefined {
  const sourceTopic = findSourceTopicYaml(input.sourceTopics, input.topic);
  if (!sourceTopic?.yaml) return undefined;
	  const targetTopic = findSourceTopicYaml(input.targetTopics, {
	    name: input.mapping.targetTopicName,
	    id: input.mapping.targetTopicName,
	  });
	  const targetFileName = targetTopic?.fileName || `${input.mapping.targetTopicName}.topic`;
	  const safety = updatePatchSafety({
	    currentYaml: targetTopic?.yaml,
	    previousChecksum: targetTopic?.checksum,
	    destructive: input.mapping.action === 'map_existing' && Boolean(targetTopic?.yaml),
	    createCategory: 'safe_create',
	    updateCategory: 'safe_update',
	  });
	  const warnings = [
	    ...(input.mapping.action === 'map_existing' && targetTopic?.yaml
	      ? [`Updates existing target topic ${input.mapping.targetTopicName}.`]
	      : []),
	    ...safety.warnings,
	  ];
	  return {
    id: semanticPatchId({
      artifactType: 'topic',
      sourceName: input.mapping.sourceTopicName || input.topic.name,
      targetFileName,
    }),
    artifactType: 'topic',
    sourceName: input.mapping.sourceTopicName || input.topic.name,
    sourceFileName: sourceTopic.fileName,
    targetFileName,
    currentYaml: targetTopic?.yaml,
    sourceYaml: sourceTopic.yaml,
    recommendedYaml: sourceTopic.yaml,
	    previousChecksum: targetTopic?.checksum,
	    resolution: 'recommended',
	    destructive: input.mapping.action === 'map_existing' && Boolean(targetTopic?.yaml),
	    status: safety.status,
	    safetyCategory: safety.safetyCategory,
	    recommendedAction: input.mapping.action === 'map_existing' && targetTopic?.yaml
	      ? `Update existing target topic ${input.mapping.targetTopicName} from source topic YAML.`
	      : `Create target topic ${input.mapping.targetTopicName} from source topic YAML.`,
	    dependencyPath: [
	      { kind: 'topic', label: input.mapping.sourceTopicName || input.topic.name, ref: sourceTopic.fileName || input.topic.name, detail: 'Dashboard is built on this source topic.' },
	      { kind: 'model_file', label: targetFileName, ref: targetFileName, detail: targetTopic?.yaml ? 'Destination topic file will be updated.' : 'Destination topic file will be created.' },
	    ],
	    warnings: warnings.length > 0 ? warnings : undefined,
	  };
	}

function semanticPatchForRelationshipEdges(input: {
  sourceFiles: Record<string, string>;
  targetFiles: Record<string, string>;
  targetChecksums?: Record<string, string>;
  relationshipEdges: RelationshipEdgeReference[];
}): MigrationSemanticPatch | undefined {
  if (input.relationshipEdges.length === 0) return undefined;
  const sourceEdgesByKey = new Map(extractRelationshipEdges(input.sourceFiles.relationships).map((edge) => [relationshipEdgeKey(edge), edge]));
  const targetEdgesByKey = new Map(extractRelationshipEdges(input.targetFiles.relationships).map((edge) => [relationshipEdgeKey(edge), edge]));
  const edgesToWrite: RelationshipEdgeDetail[] = [];
  for (const requestedEdge of input.relationshipEdges) {
    const key = relationshipEdgeKey(requestedEdge);
    const sourceEdge = sourceEdgesByKey.get(key);
    if (!sourceEdge) continue;
    const targetEdge = targetEdgesByKey.get(key);
    if (targetEdge && relationshipEdgeYamlFingerprint(targetEdge) === relationshipEdgeYamlFingerprint(sourceEdge)) continue;
    edgesToWrite.push(sourceEdge);
  }
	  if (edgesToWrite.length === 0) return undefined;
	  const recommendedYaml = mergeRelationshipYaml(input.targetFiles.relationships, edgesToWrite);
	  const safety = updatePatchSafety({
	    currentYaml: input.targetFiles.relationships,
	    previousChecksum: input.targetChecksums?.relationships,
	    createCategory: 'safe_create',
	    updateCategory: 'safe_update',
	  });
	  return {
    id: semanticPatchId({ artifactType: 'relationship', sourceName: 'relationships', targetFileName: 'relationships' }),
    artifactType: 'relationship',
    sourceName: 'relationships',
    sourceFileName: 'relationships',
    targetFileName: 'relationships',
    currentYaml: input.targetFiles.relationships,
    sourceYaml: input.sourceFiles.relationships,
    recommendedYaml,
	    previousChecksum: input.targetChecksums?.relationships,
	    resolution: 'recommended',
	    status: safety.status,
	    safetyCategory: safety.safetyCategory,
	    recommendedAction: `Add or reconcile ${edgesToWrite.length} relationship edge${edgesToWrite.length === 1 ? '' : 's'} required by query views.`,
	    dependencyPath: [
	      { kind: 'query_view', label: 'Required query views', detail: 'Copied or updated query views require this join path.' },
	      { kind: 'relationship', label: `${edgesToWrite.length} relationship edge${edgesToWrite.length === 1 ? '' : 's'}`, ref: 'relationships', detail: 'Destination relationships YAML will be updated.' },
	      { kind: 'model_file', label: 'relationships', ref: 'relationships', detail: input.targetFiles.relationships ? 'Destination relationships file will be updated.' : 'Destination relationships file will be created.' },
	    ],
	    warnings: [
	      `Adds or reconciles ${edgesToWrite.length} relationship edge${edgesToWrite.length === 1 ? '' : 's'} required by query views.`,
	      ...safety.warnings,
	    ],
	  };
	}

function formatFieldList(fields: string[], limit = 8): string {
  const shown = fields.slice(0, limit).join(', ');
  const remaining = fields.length - limit;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function folderScopeAvailable(folderId?: string, folderPath?: string): boolean {
  return Boolean(folderId?.trim() || folderPath?.trim());
}

function documentLooksInDefaultFolder(document: Pick<OmniDocumentRecord, 'folderId' | 'folderPath'>): boolean {
  const folderPath = normalizeFolderPath(document.folderPath);
  if (folderPath) return folderPath === 'default' || folderPath === 'my documents' || folderPath === 'my documents/default';
  return !document.folderId?.trim();
}

function documentKeyMatches(document: Pick<OmniDocumentRecord, 'id' | 'identifier'>, keys: Set<string>): boolean {
  return [document.id, document.identifier].some((value) => Boolean(value && keys.has(value)));
}

interface SourceTopicRef {
  name: string;
  id?: string;
}

type RequiredQueryViewSource = 'dashboard' | 'topic' | 'query_view_dependency';
type RequiredQueryViewStatus = 'exact_target_match' | 'missing_copyable' | 'missing_source_yaml' | 'blocked';
type QueryViewCompatibilityStatus = 'compatible' | 'missing_required_fields' | 'missing_required_dependencies' | 'unknown';

interface QueryViewCompatibilityDetail {
  status: QueryViewCompatibilityStatus;
  targetQueryViewName?: string;
  targetFileName?: string;
  targetChecksum?: string;
  missingRequiredFields?: string[];
  missingRequiredDependencies?: string[];
  reason?: string;
}

interface RequiredQueryViewDetail {
  name: string;
  sourceFileName?: string;
  targetFileName?: string;
  label?: string;
  description?: string;
  status: RequiredQueryViewStatus;
  sources: RequiredQueryViewSource[];
  referencedBy: string[];
  reason?: string;
  compatibility?: QueryViewCompatibilityDetail;
}

interface RelationshipEdgeReference {
  joinFromView: string;
  joinToView: string;
  joinType?: string;
  relationshipType?: string;
}

interface RelationshipEdgeDetail extends RelationshipEdgeReference {
  yaml: string;
}

interface QueryViewReferenceAccumulator {
  name: string;
  sources: Set<RequiredQueryViewSource>;
  referencedBy: Set<string>;
}

interface QueryViewCatalogResult {
  queryViews: OmniModelQueryViewRecord[];
  warning?: string;
}

interface TopicRewriteResult {
  payload: Record<string, unknown>;
  replacementCount: number;
  replacements: Array<{ from: string; to: string }>;
}

const TOPIC_SCALAR_KEYS = new Set([
  'topic',
  'topicname',
  'topic_name',
  'topicid',
  'topic_id',
  'topicidentifier',
  'topic_identifier',
  'topickey',
  'topic_key',
]);

const TOPIC_ARRAY_KEYS = new Set([
  'topicnames',
  'topic_names',
  'topicids',
  'topic_ids',
  'topicidentifiers',
  'topic_identifiers',
  'topics',
]);

function normalizeTopicValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function topicKey(value: unknown): string | undefined {
  return normalizeTopicValue(value)?.toLowerCase();
}

function normalizeTopicMappings(value: MigrationTopicMapping[] | undefined): MigrationTopicMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((mapping) => {
      const sourceTopicName = normalizeTopicValue(mapping.sourceTopicName) || '';
      const sourceTopicId = normalizeTopicValue(mapping.sourceTopicId);
      const targetTopicName = normalizeTopicValue(mapping.targetTopicName) || '';
      const action: MigrationTopicMappingAction = mapping.action === 'copy_source' ? 'copy_source' : 'map_existing';
      return {
        sourceTopicName,
        ...(sourceTopicId ? { sourceTopicId } : {}),
        action,
        targetTopicName,
        ...(normalizeTopicValue(mapping.targetTopicLabel) ? { targetTopicLabel: normalizeTopicValue(mapping.targetTopicLabel) } : {}),
      };
    })
    .filter((mapping) => mapping.sourceTopicName && mapping.targetTopicName);
}

function normalizeQueryViewMappings(value: MigrationQueryViewMapping[] | undefined): MigrationQueryViewMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((mapping) => {
      const sourceQueryViewName = normalizeTopicValue(mapping.sourceQueryViewName) || '';
      const sourceFileName = normalizeTopicValue(mapping.sourceFileName);
      const targetQueryViewName = normalizeTopicValue(mapping.targetQueryViewName) || '';
      const targetFileName = normalizeTopicValue(mapping.targetFileName);
      const targetQueryViewLabel = normalizeTopicValue(mapping.targetQueryViewLabel);
      const action: MigrationQueryViewMappingAction = mapping.action === 'copy_source'
        ? 'copy_source'
        : mapping.action === 'use_existing_unverified'
          ? 'use_existing_unverified'
          : mapping.action === 'update_existing'
            ? 'update_existing'
            : 'map_existing';
      return {
        sourceQueryViewName,
        ...(sourceFileName ? { sourceFileName } : {}),
        action,
        targetQueryViewName,
        ...(targetFileName ? { targetFileName } : {}),
        ...(targetQueryViewLabel ? { targetQueryViewLabel } : {}),
      };
    })
    .filter((mapping) => mapping.sourceQueryViewName && mapping.targetQueryViewName);
}

function normalizeFieldMappings(value: MigrationFieldMapping[] | undefined): MigrationFieldMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((mapping) => {
      const sourceFieldRef = normalizeTopicValue(mapping.sourceFieldRef) || '';
      const targetFieldRef = normalizeTopicValue(mapping.targetFieldRef);
      const action: MigrationFieldMappingAction = mapping.action === 'create_from_source'
        ? 'create_from_source'
        : mapping.action === 'ignore'
          ? 'ignore'
          : 'map_existing';
      return {
        sourceFieldRef,
        action,
        ...(targetFieldRef ? { targetFieldRef } : {}),
        ...(normalizeTopicValue(mapping.sourceFileName) ? { sourceFileName: normalizeTopicValue(mapping.sourceFileName) } : {}),
        ...(normalizeTopicValue(mapping.targetFileName) ? { targetFileName: normalizeTopicValue(mapping.targetFileName) } : {}),
      };
    })
    .filter((mapping) => mapping.sourceFieldRef);
}

function normalizeSemanticPatchSafetyCategory(value: unknown): MigrationSemanticPatchSafetyCategory {
  return value === 'safe_ignore'
    || value === 'safe_map'
    || value === 'safe_create'
    || value === 'safe_update'
    || value === 'destructive_update'
    || value === 'blocked'
    ? value
    : 'manual_review';
}

function normalizeSemanticDependencyPath(value: unknown): MigrationSemanticDependencyNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes = value
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && !Array.isArray(node))
    .map((node): MigrationSemanticDependencyNode | null => {
      const kind: MigrationSemanticDependencyKind | undefined = node.kind === 'dashboard'
        || node.kind === 'topic'
        || node.kind === 'query_view'
        || node.kind === 'model_field'
        || node.kind === 'relationship'
        || node.kind === 'model_file'
        ? node.kind
        : undefined;
      const label = normalizeTopicValue(node.label);
      if (!kind || !label) return null;
      return {
        kind,
        label,
        ...(normalizeTopicValue(node.ref) ? { ref: normalizeTopicValue(node.ref) } : {}),
        ...(normalizeTopicValue(node.detail) ? { detail: normalizeTopicValue(node.detail) } : {}),
      };
    })
    .filter((node): node is MigrationSemanticDependencyNode => Boolean(node));
  return nodes.length > 0 ? nodes : undefined;
}

function normalizeSemanticPatches(value: MigrationSemanticPatch[] | undefined): MigrationSemanticPatch[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((patch) => {
      const id = normalizeTopicValue(patch.id) || '';
      const artifactType: MigrationSemanticPatchArtifact = patch.artifactType === 'query_view'
        ? 'query_view'
        : patch.artifactType === 'topic'
          ? 'topic'
          : patch.artifactType === 'relationship'
            ? 'relationship'
            : 'field';
      const targetFileName = normalizeTopicValue(patch.targetFileName) || '';
      const resolution: MigrationSemanticPatchResolution = patch.resolution === 'custom_edit'
        ? 'custom_edit'
        : patch.resolution === 'keep_target'
          ? 'keep_target'
          : patch.resolution === 'use_source'
            ? 'use_source'
            : 'recommended';
      return {
        id,
        artifactType,
        ...(normalizeTopicValue(patch.sourceName) ? { sourceName: normalizeTopicValue(patch.sourceName) } : {}),
        ...(normalizeTopicValue(patch.sourceFileName) ? { sourceFileName: normalizeTopicValue(patch.sourceFileName) } : {}),
        targetFileName,
        ...(normalizeTopicValue(patch.targetModelId) ? { targetModelId: normalizeTopicValue(patch.targetModelId) } : {}),
        ...(typeof patch.currentYaml === 'string' ? { currentYaml: patch.currentYaml } : {}),
        ...(typeof patch.sourceYaml === 'string' ? { sourceYaml: patch.sourceYaml } : {}),
        ...(typeof patch.recommendedYaml === 'string' ? { recommendedYaml: patch.recommendedYaml } : {}),
        ...(typeof patch.acceptedYaml === 'string' ? { acceptedYaml: patch.acceptedYaml } : {}),
        ...(normalizeTopicValue(patch.previousChecksum) ? { previousChecksum: normalizeTopicValue(patch.previousChecksum) } : {}),
        resolution,
        ...(patch.destructive === true ? { destructive: true } : {}),
        ...(patch.confirmedDestructive === true ? { confirmedDestructive: true } : {}),
        ...(patch.status === 'blocked' || patch.status === 'warning' || patch.status === 'ready' ? { status: patch.status } : {}),
        safetyCategory: normalizeSemanticPatchSafetyCategory(patch.safetyCategory),
        ...(normalizeTopicValue(patch.recommendedAction) ? { recommendedAction: normalizeTopicValue(patch.recommendedAction) } : {}),
        ...(normalizeSemanticDependencyPath(patch.dependencyPath) ? { dependencyPath: normalizeSemanticDependencyPath(patch.dependencyPath) } : {}),
        ...(Array.isArray(patch.warnings) ? { warnings: patch.warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0) } : {}),
      };
    })
    .filter((patch) => patch.id && patch.targetFileName && (patch.resolution === 'keep_target' || Boolean(patch.acceptedYaml)));
}

function semanticPatchId(input: {
  artifactType: MigrationSemanticPatchArtifact;
  targetFileName: string;
  sourceName?: string;
}): string {
  return [
    input.artifactType,
    input.sourceName || input.targetFileName,
    input.targetFileName,
  ].map((value) => value.trim().toLowerCase()).join(':');
}

function semanticPatchArtifactLabel(artifactType: MigrationSemanticPatchArtifact): string {
  if (artifactType === 'query_view') return 'Query view';
  if (artifactType === 'topic') return 'Topic';
  if (artifactType === 'relationship') return 'Relationship';
  return 'Field or measure';
}

function updatePatchSafety(input: {
  currentYaml?: string;
  previousChecksum?: string;
  destructive?: boolean;
  createCategory?: MigrationSemanticPatchSafetyCategory;
  updateCategory?: MigrationSemanticPatchSafetyCategory;
}): {
  safetyCategory: MigrationSemanticPatchSafetyCategory;
  status: MigrationSemanticPatchStatus;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!input.currentYaml) {
    return {
      safetyCategory: input.createCategory || 'safe_create',
      status: 'ready',
      warnings,
    };
  }
  if (!input.previousChecksum) {
    warnings.push('Destination file exists but OmniKit could not read a checksum during readiness. Recheck readiness before running if this file may have changed.');
    return {
      safetyCategory: 'manual_review',
      status: 'warning',
      warnings,
    };
  }
  return {
    safetyCategory: input.destructive ? 'destructive_update' : input.updateCategory || 'safe_update',
    status: input.destructive ? 'warning' : 'ready',
    warnings,
  };
}

function semanticPatchWriteYaml(patch: MigrationSemanticPatch | undefined): string | undefined {
  if (!patch || patch.resolution === 'keep_target') return undefined;
  if (patch.resolution === 'use_source' && patch.destructive && !patch.confirmedDestructive) return undefined;
  return patch.acceptedYaml;
}

function semanticPatchWriteInput(
  patch: MigrationSemanticPatch | undefined,
  fallbackChecksum?: string,
): { yaml: string; previousChecksum?: string } | undefined {
  if (!patch || patch.resolution === 'keep_target') return undefined;
  if (patch.status === 'blocked' || patch.safetyCategory === 'blocked') {
    throw new Error(`Semantic code decision for ${patch.targetFileName} is blocked and cannot be applied.`);
  }
  if (patch.destructive && !patch.confirmedDestructive) {
    throw new Error(`Semantic code decision for ${patch.targetFileName} is destructive and must be confirmed before it can be applied.`);
  }
  const yaml = patch.acceptedYaml;
  if (!yaml?.trim()) return undefined;
  return {
    yaml,
    previousChecksum: patch.previousChecksum || fallbackChecksum,
  };
}

function semanticPatchLookup(patches: MigrationSemanticPatch[] | undefined): Map<string, MigrationSemanticPatch> {
  const rows = normalizeSemanticPatches(patches);
  const out = new Map<string, MigrationSemanticPatch>();
  for (const patch of rows) {
    out.set(patch.id, patch);
    out.set(semanticPatchId({
      artifactType: patch.artifactType,
      sourceName: patch.sourceName,
      targetFileName: patch.targetFileName,
    }), patch);
  }
  return out;
}

function mergeSemanticPatchCandidates(
  candidates: MigrationSemanticPatch[],
  accepted: MigrationSemanticPatch[] | undefined,
): MigrationSemanticPatch[] {
  const acceptedByKey = semanticPatchLookup(accepted);
  return candidates.map((candidate) => {
    const acceptedPatch = acceptedByKey.get(candidate.id) || acceptedByKey.get(semanticPatchId(candidate));
    const checksumStale = Boolean(
      acceptedPatch?.previousChecksum
      && candidate.previousChecksum
      && acceptedPatch.previousChecksum !== candidate.previousChecksum,
    );
    return acceptedPatch ? {
      ...candidate,
      ...acceptedPatch,
      currentYaml: candidate.currentYaml,
      sourceYaml: candidate.sourceYaml,
      recommendedYaml: acceptedPatch.recommendedYaml || candidate.recommendedYaml,
      latestChecksum: candidate.previousChecksum,
      checksumStale,
      status: checksumStale ? 'blocked' : acceptedPatch.status || candidate.status,
      safetyCategory: checksumStale ? 'blocked' : acceptedPatch.safetyCategory || candidate.safetyCategory,
      warnings: [...new Set([
        ...(candidate.warnings || []),
        ...(acceptedPatch.warnings || []),
        ...(checksumStale ? ['Destination YAML changed since this decision was accepted. Refresh and re-apply the recommendation before running.'] : []),
      ])],
    } : candidate;
  });
}

function activeSemanticPatchFor(
  patches: MigrationSemanticPatch[] | undefined,
  artifactType: MigrationSemanticPatchArtifact,
  targetFileName: string | undefined,
  sourceName?: string,
): MigrationSemanticPatch | undefined {
  if (!targetFileName) return undefined;
  const lookup = semanticPatchLookup(patches);
  return lookup.get(semanticPatchId({ artifactType, targetFileName, sourceName }))
    || lookup.get(semanticPatchId({ artifactType, targetFileName }));
}

function addTopicRef(topics: Map<string, SourceTopicRef>, name?: unknown, id?: unknown): void {
  const cleanName = normalizeTopicValue(name);
  const cleanId = normalizeTopicValue(id);
  const topicName = cleanName || cleanId;
  if (!topicName) return;
  const key = topicKey(cleanId) || topicKey(topicName);
  if (!key || topics.has(key)) return;
  topics.set(key, {
    name: topicName,
    ...(cleanId ? { id: cleanId } : {}),
  });
}

function collectTopicRefs(payload: unknown, document?: { topicNames?: string[]; topicIds?: string[] }): SourceTopicRef[] {
  const topics = new Map<string, SourceTopicRef>();

  function walk(value: unknown, maxDepth = 10): void {
    if (maxDepth <= 0 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, maxDepth - 1);
      return;
    }
    const record = value as Record<string, unknown>;
    addTopicRef(topics, record.topicName, record.topicId);
    addTopicRef(topics, record.topic_name, record.topic_id);
    addTopicRef(topics, record.topic, record.topicIdentifier || record.topic_identifier || record.topicKey || record.topic_key);
    if (record.topic && typeof record.topic === 'object' && !Array.isArray(record.topic)) {
      const topic = record.topic as Record<string, unknown>;
      addTopicRef(topics, topic.name || topic.label, topic.id || topic.identifier || topic.name);
    }
    for (const key of ['topicNames', 'topic_names', 'topicIds', 'topic_ids', 'topicIdentifiers', 'topic_identifiers']) {
      const raw = record[key];
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item === 'string') addTopicRef(topics, item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const topic = item as Record<string, unknown>;
          addTopicRef(topics, topic.name || topic.label, topic.id || topic.identifier || topic.name);
        }
      }
    }
    for (const child of Object.values(record)) walk(child, maxDepth - 1);
  }

  walk(payload);
  if (topics.size === 0) {
    const maxLength = Math.max(document?.topicNames?.length || 0, document?.topicIds?.length || 0);
    for (let index = 0; index < maxLength; index += 1) {
      addTopicRef(topics, document?.topicNames?.[index], document?.topicIds?.[index]);
    }
  }
  return [...topics.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findStringByKey(obj: unknown, keys: string[], maxDepth = 8): string | undefined {
  if (maxDepth <= 0) return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findStringByKey(item, keys, maxDepth - 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = normalizeTopicValue(record[key]);
    if (value) return value;
  }
  for (const value of Object.values(record)) {
    const found = findStringByKey(value, keys, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function extractDashboardModelId(payload: unknown): string | undefined {
  return findStringByKey(payload, [
    'sharedModelId',
    'shared_model_id',
    'baseModelId',
    'base_model_id',
    'modelId',
    'model_id',
  ]);
}

function mappingForSourceTopic(topic: SourceTopicRef, mappings: MigrationTopicMapping[]): MigrationTopicMapping | undefined {
  const sourceKeys = [topic.id, topic.name].map(topicKey).filter((value): value is string => Boolean(value));
  return mappings.find((mapping) => {
    const mappingKeys = [mapping.sourceTopicId, mapping.sourceTopicName].map(topicKey).filter((value): value is string => Boolean(value));
    return mappingKeys.some((key) => sourceKeys.includes(key));
  });
}

function exactTargetTopic(
  topic: SourceTopicRef,
  targetTopics: Array<{ name: string; label?: string }>,
): { name: string; label?: string } | undefined {
  const sourceKeys = [topic.id, topic.name].map(topicKey).filter((value): value is string => Boolean(value));
  return targetTopics.find((target) => [target.name, target.label].map(topicKey).some((key) => key && sourceKeys.includes(key)));
}

function topicYamlLabel(yaml: string): string | undefined {
  return normalizeTopicValue(yaml.match(/^label:\s*["']?(.+?)["']?\s*$/m)?.[1]);
}

function findSourceTopicYaml(
  topics: Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>,
  topic: SourceTopicRef,
): { name: string; yaml: string; fileName?: string; checksum?: string } | undefined {
  const sourceKeys = [topic.id, topic.name].map(topicKey).filter((value): value is string => Boolean(value));
  const match = topics.find((candidate) => {
    const label = candidate.yaml ? topicYamlLabel(candidate.yaml) : candidate.label;
    const candidateKeys = [candidate.name, candidate.label, label, candidate.fileName?.split('/').pop()?.replace(/\.topic$/, '')]
      .map(topicKey)
      .filter((value): value is string => Boolean(value));
    return candidateKeys.some((key) => sourceKeys.includes(key));
  });
  return match?.yaml ? { name: match.name, yaml: match.yaml, fileName: match.fileName, checksum: match.checksum } : undefined;
}

function mappedTopicCompatibilityBlockers(input: {
  sourceTopicName: string;
  targetTopicName: string;
  sourceYaml?: string;
  targetYaml?: string;
}): string[] {
  if (!input.sourceYaml || !input.targetYaml) return [];
  const blockers: string[] = [];
  const sourceRefs = extractTopicViewReferences(input.sourceYaml);
  const targetRefs = new Set(extractTopicViewReferences(input.targetYaml).map((ref) => ref.toLowerCase()));
  const missingRefs = sourceRefs.filter((ref) => !targetRefs.has(ref.toLowerCase()));
  if (missingRefs.length > 0) {
    blockers.push(`Mapped target topic ${input.targetTopicName} is missing required source topic views from ${input.sourceTopicName}: ${formatFieldList(missingRefs)}.`);
  }

  const targetEdgesByKey = new Map(extractRelationshipEdges(input.targetYaml).map((edge) => [relationshipEdgeKey(edge), edge]));
  const missingEdges: string[] = [];
  const conflictingEdges: string[] = [];
  for (const sourceEdge of extractRelationshipEdges(input.sourceYaml)) {
    const targetEdge = targetEdgesByKey.get(relationshipEdgeKey(sourceEdge));
    if (!targetEdge) {
      missingEdges.push(relationshipEdgeSummary(sourceEdge));
    } else if (relationshipEdgeYamlFingerprint(targetEdge) !== relationshipEdgeYamlFingerprint(sourceEdge)) {
      conflictingEdges.push(relationshipEdgeSummary(sourceEdge));
    }
  }
  if (missingEdges.length > 0) {
    blockers.push(`Mapped target topic ${input.targetTopicName} is missing required source topic relationship edges from ${input.sourceTopicName}: ${formatFieldList(missingEdges)}.`);
  }
  if (conflictingEdges.length > 0) {
    blockers.push(`Mapped target topic ${input.targetTopicName} has conflicting topic relationship edges from ${input.sourceTopicName}: ${formatFieldList(conflictingEdges)}.`);
  }
  return blockers;
}

function targetTopicExists(targetTopics: Array<{ name: string; label?: string }>, targetTopicName: string): boolean {
  const targetKey = topicKey(targetTopicName);
  return Boolean(targetKey && targetTopics.some((topic) => [topic.name, topic.label].map(topicKey).includes(targetKey)));
}

function queryViewNameFromFilePath(filePath: string): string {
  const leaf = filePath.split('/').pop() || filePath;
  return leaf.replace(/\.query\.view$/, '');
}

function queryViewKey(value: unknown): string | undefined {
  return normalizeTopicValue(value)?.toLowerCase();
}

function queryViewKeys(queryView: Pick<OmniModelQueryViewRecord, 'name' | 'fileName'> & { label?: string }): string[] {
  return [queryView.name, queryView.label, queryViewNameFromFilePath(queryView.fileName)]
    .map(queryViewKey)
    .filter((value): value is string => Boolean(value));
}

function queryViewFromCatalogByValue(queryViews: OmniModelQueryViewRecord[], value?: string): OmniModelQueryViewRecord | undefined {
  const key = queryViewKey(value);
  if (!key) return undefined;
  return queryViews.find((queryView) => queryViewKeys(queryView).includes(key));
}

function sourceQueryViewForMapping(
  queryViews: OmniModelQueryViewRecord[],
  mapping: MigrationQueryViewMapping,
): OmniModelQueryViewRecord | undefined {
  const sourceKeys = [
    mapping.sourceQueryViewName,
    mapping.sourceFileName,
    mapping.sourceFileName ? queryViewNameFromFilePath(mapping.sourceFileName) : undefined,
  ].map(queryViewKey).filter((value): value is string => Boolean(value));
  return queryViews.find((queryView) => queryViewKeys(queryView).some((key) => sourceKeys.includes(key)));
}

function queryViewCatalogMap(queryViews: OmniModelQueryViewRecord[]): Map<string, OmniModelQueryViewRecord> {
  const map = new Map<string, OmniModelQueryViewRecord>();
  for (const queryView of queryViews) {
    for (const key of queryViewKeys(queryView)) {
      if (!map.has(key)) map.set(key, queryView);
    }
  }
  return map;
}

function queryViewSourceKeys(queryView: Pick<RequiredQueryViewDetail, 'name' | 'sourceFileName'>): string[] {
  return [queryView.name, queryView.sourceFileName, queryView.sourceFileName ? queryViewNameFromFilePath(queryView.sourceFileName) : undefined]
    .map(queryViewKey)
    .filter((value): value is string => Boolean(value));
}

function mappingForSourceQueryView(
  queryView: Pick<RequiredQueryViewDetail, 'name' | 'sourceFileName'>,
  mappings: MigrationQueryViewMapping[],
): MigrationQueryViewMapping | undefined {
  const sourceKeys = queryViewSourceKeys(queryView);
  return mappings.find((mapping) => {
    const mappingKeys = [mapping.sourceQueryViewName, mapping.sourceFileName, mapping.sourceFileName ? queryViewNameFromFilePath(mapping.sourceFileName) : undefined]
      .map(queryViewKey)
      .filter((value): value is string => Boolean(value));
    return mappingKeys.some((key) => sourceKeys.includes(key));
  });
}

function exactTargetQueryView(
  queryView: Pick<RequiredQueryViewDetail, 'name' | 'sourceFileName' | 'label'>,
  targetQueryViews: OmniModelQueryViewRecord[],
): OmniModelQueryViewRecord | undefined {
  const sourceKeys = [
    queryView.name,
    queryView.label,
    queryView.sourceFileName,
    queryView.sourceFileName ? queryViewNameFromFilePath(queryView.sourceFileName) : undefined,
  ].map(queryViewKey).filter((value): value is string => Boolean(value));
  return targetQueryViews.find((target) => queryViewKeys(target).some((key) => sourceKeys.includes(key)));
}

function targetQueryViewExists(targetQueryViews: OmniModelQueryViewRecord[], targetQueryViewName: string): boolean {
  const targetKey = queryViewKey(targetQueryViewName);
  return Boolean(targetKey && targetQueryViews.some((queryView) => queryViewKeys(queryView).includes(targetKey)));
}

function validateQueryViewMappingsForPreflight(input: {
  requiredQueryViews: RequiredQueryViewDetail[];
  configuredMappings: MigrationQueryViewMapping[];
  targetQueryViews: OmniModelQueryViewRecord[];
}): {
  resolvedQueryViewMappings: MigrationQueryViewMapping[];
  queryViewBlockers: string[];
} {
  const resolvedQueryViewMappings: MigrationQueryViewMapping[] = [];
  const queryViewBlockers: string[] = [];
  for (const requiredQueryView of input.requiredQueryViews) {
    const explicitMapping = mappingForSourceQueryView(requiredQueryView, input.configuredMappings);
    const exact = exactTargetQueryView(requiredQueryView, input.targetQueryViews);
    const mapping = explicitMapping || (exact ? {
      sourceQueryViewName: requiredQueryView.name,
      sourceFileName: requiredQueryView.sourceFileName,
      action: 'map_existing' as const,
      targetQueryViewName: exact.name,
      targetFileName: exact.fileName,
      targetQueryViewLabel: exact.label,
    } : undefined);
    if (!mapping) {
      queryViewBlockers.push(`Query view ${requiredQueryView.name} is required but is not mapped for the destination model.`);
      continue;
    }
    if (mapping.action === 'map_existing' || mapping.action === 'use_existing_unverified' || mapping.action === 'update_existing') {
      if (!targetQueryViewExists(input.targetQueryViews, mapping.targetQueryViewName)) {
        queryViewBlockers.push(`Mapped target query view ${mapping.targetQueryViewName} was not found in the destination model.`);
        continue;
      }
      const compatibility = requiredQueryView.compatibility;
      if (mapping.action === 'map_existing' && (
        compatibility
        && (
          compatibility.targetQueryViewName === mapping.targetQueryViewName
          || queryViewKey(compatibility.targetFileName) === queryViewKey(mapping.targetFileName)
        )
      )) {
        if (compatibility.status === 'missing_required_fields') {
          queryViewBlockers.push(`Mapped target query view ${mapping.targetQueryViewName} is missing required fields from ${requiredQueryView.name}: ${formatFieldList(compatibility.missingRequiredFields || [])}.`);
          continue;
        }
        if (compatibility.status === 'missing_required_dependencies') {
          queryViewBlockers.push(`Mapped target query view ${mapping.targetQueryViewName} is missing required dependencies from ${requiredQueryView.name}: ${formatFieldList(compatibility.missingRequiredDependencies || [])}.`);
          continue;
        }
      }
      resolvedQueryViewMappings.push(mapping);
      continue;
    }
	    if (!requiredQueryView.sourceFileName && !mapping.sourceFileName) {
	      queryViewBlockers.push(`Cannot create target query view ${mapping.targetQueryViewName} because source query-view YAML was not found for ${requiredQueryView.name}.`);
	      continue;
	    }
	    if (mapping.action === 'copy_source' && queryViewMappingRenamesSource(mapping)) {
	      queryViewBlockers.push(`Cannot create target query view ${mapping.targetQueryViewName} with a different name from ${mapping.sourceQueryViewName}; dashboard and topic query-view reference rewriting is not yet supported. Use the same query-view name, update the existing query view, or review the target model manually.`);
	      continue;
	    }
	    if (targetQueryViewExists(input.targetQueryViews, mapping.targetQueryViewName)) {
	      queryViewBlockers.push(`Target query view ${mapping.targetQueryViewName} already exists. Use the existing query view or enter a new query-view name.`);
	      continue;
	    }
    resolvedQueryViewMappings.push({
      ...mapping,
      sourceQueryViewName: requiredQueryView.name,
      sourceFileName: mapping.sourceFileName || requiredQueryView.sourceFileName,
      targetFileName: mapping.targetFileName || `${mapping.targetQueryViewName}.query.view`,
    });
  }
  return {
    resolvedQueryViewMappings: [...new Map(resolvedQueryViewMappings.map((mapping) => [
      `${mapping.sourceFileName || mapping.sourceQueryViewName}:${mapping.action}:${mapping.targetQueryViewName}`,
      mapping,
    ])).values()],
    queryViewBlockers: [...new Set(queryViewBlockers)],
  };
}

function fieldRefViewNames(fieldRefs: string[]): string[] {
  const names = new Set<string>();
  for (const fieldRef of fieldRefs) {
    const [viewName] = normalizeFieldRef(fieldRef).split('.');
    if (viewName) names.add(viewName);
  }
  return [...names].sort();
}

function queryViewMappingResolvesFieldRef(mapping: MigrationQueryViewMapping, fieldRef: string): boolean {
  const [viewName] = normalizeFieldRef(fieldRef).split('.');
  const sourceKey = queryViewKey(mapping.sourceQueryViewName) || queryViewKey(mapping.sourceFileName);
  const fieldViewKey = queryViewKey(viewName);
  return Boolean(sourceKey && fieldViewKey && sourceKey === fieldViewKey);
}

function queryViewMappingRenamesSource(mapping: MigrationQueryViewMapping): boolean {
  const sourceKey = queryViewKey(mapping.sourceQueryViewName)
    || (mapping.sourceFileName ? queryViewKey(queryViewNameFromFilePath(mapping.sourceFileName)) : undefined);
  const targetKey = queryViewKey(mapping.targetQueryViewName)
    || (mapping.targetFileName ? queryViewKey(queryViewNameFromFilePath(mapping.targetFileName)) : undefined);
  return Boolean(sourceKey && targetKey && sourceKey !== targetKey);
}

function queryViewFieldRefs(queryView: Pick<OmniModelQueryViewRecord, 'fileName' | 'yaml'> | undefined): string[] {
  if (!queryView?.fileName || !queryView.yaml) return [];
  return extractFieldsFromViewYaml(queryView.fileName, queryView.yaml).sort();
}

function requiredFieldRefsForQueryView(queryViewName: string, fieldRefs: string[]): string[] {
  const queryViewNameKey = queryViewKey(queryViewName);
  if (!queryViewNameKey) return [];
  return fieldRefs.filter((fieldRef) => {
    const [viewName] = normalizeFieldRef(fieldRef).split('.');
    return queryViewKey(viewName) === queryViewNameKey;
  }).sort();
}

function compareQueryViewCompatibility(input: {
  sourceQueryView?: OmniModelQueryViewRecord;
  targetQueryView?: OmniModelQueryViewRecord;
  requiredFieldRefs: string[];
}): QueryViewCompatibilityDetail {
  const targetQueryViewName = input.targetQueryView?.name;
  const targetFileName = input.targetQueryView?.fileName;
  const targetChecksum = input.targetQueryView?.checksum;
  if (!input.sourceQueryView?.yaml || !input.sourceQueryView.fileName) {
    return {
      status: 'unknown',
      targetQueryViewName,
      targetFileName,
      targetChecksum,
      reason: `Source query-view YAML was not available for ${input.sourceQueryView?.name || 'the required query view'}.`,
    };
  }
  if (!input.targetQueryView?.yaml || !input.targetQueryView.fileName) {
    return {
      status: 'unknown',
      targetQueryViewName,
      targetFileName,
      targetChecksum,
      reason: `Target query-view YAML was not available for ${input.targetQueryView?.name || 'the mapped query view'}.`,
    };
  }

  const targetFields = new Set(queryViewFieldRefs(input.targetQueryView).map((field) => field.toLowerCase()));
  const missingRequiredFields = input.requiredFieldRefs.filter((field) => !targetFields.has(field.toLowerCase()));
  if (missingRequiredFields.length > 0) {
    return {
      status: 'missing_required_fields',
      targetQueryViewName,
      targetFileName,
      targetChecksum,
      missingRequiredFields,
    };
  }

  const sourceDependencies = extractQueryViewReferences(input.sourceQueryView.yaml)
    .filter((dependency) => queryViewKey(dependency) !== queryViewKey(input.sourceQueryView?.name));
  const targetDependencies = new Set(extractQueryViewReferences(input.targetQueryView.yaml).map((dependency) => dependency.toLowerCase()));
  const missingRequiredDependencies = sourceDependencies.filter((dependency) => !targetDependencies.has(dependency.toLowerCase()));
  if (missingRequiredDependencies.length > 0) {
    return {
      status: 'missing_required_dependencies',
      targetQueryViewName,
      targetFileName,
      targetChecksum,
      missingRequiredDependencies,
    };
  }

  return {
    status: 'compatible',
    targetQueryViewName,
    targetFileName,
    targetChecksum,
  };
}

function yamlScalar(yaml: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = yaml.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return undefined;
  const raw = match[1].trim();
  if (!raw || raw === '|' || raw === '>') return undefined;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return normalizeTopicValue(raw.slice(1, -1));
  }
  return normalizeTopicValue(raw);
}

function yamlScalarValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const withoutComment = raw.replace(/\s+#.*$/, '').trim();
  if (!withoutComment || withoutComment === '{}' || withoutComment === '[]' || withoutComment === '|' || withoutComment === '>') return undefined;
  const cleaned = withoutComment.replace(/,$/, '').trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    return normalizeTopicValue(cleaned.slice(1, -1));
  }
  return normalizeTopicValue(cleaned);
}

function isSemanticViewName(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z_][\w/]*$/.test(value));
}

function yamlLineIndent(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function yamlSectionLines(yaml: string, sectionName: string): Array<{ indent: number; text: string }> {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(`^(\\s*)${escaped}:\\s*(?:#.*)?$`);
  const rows: Array<{ indent: number; text: string }> = [];
  let active = false;
  let sectionIndent = -1;

  for (const line of yaml.split(/\r?\n/)) {
    if (!active) {
      const sectionMatch = line.match(sectionPattern);
      if (!sectionMatch) continue;
      active = true;
      sectionIndent = sectionMatch[1].length;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      rows.push({ indent: yamlLineIndent(line), text: line });
      continue;
    }

    const indent = yamlLineIndent(line);
    if (indent <= sectionIndent) break;
    rows.push({ indent, text: line });
  }

  return rows;
}

function extractYamlMapKeysFromSection(
  yaml: string,
  sectionName: string,
  options: { directOnly?: boolean } = {},
): string[] {
  const rows = yamlSectionLines(yaml, sectionName)
    .filter((row) => row.text.trim() && !row.text.trimStart().startsWith('#'));
  if (rows.length === 0) return [];
  const directIndent = Math.min(...rows.map((row) => row.indent));
  const refs = new Set<string>();

  for (const row of rows) {
    if (options.directOnly && row.indent !== directIndent) continue;
    const match = row.text.trim().match(/^([A-Za-z_][\w/]*):(?:\s|$)/);
    if (isSemanticViewName(match?.[1])) refs.add(match[1]);
  }

  return [...refs].sort();
}

function extractPlainFieldViewReferences(yaml: string): string[] {
  const refs = new Set<string>();
  for (const fieldRef of extractFieldRefsFromString(yaml)) {
    const [viewName] = fieldRef.split('.');
    if (isSemanticViewName(viewName)) refs.add(viewName);
  }
  return [...refs].sort();
}

function queryViewsFromModelYamlFiles(files: Record<string, string>): OmniModelQueryViewRecord[] {
  return Object.entries(files)
    .filter(([fileName]) => fileName.split('/').pop()?.endsWith('.query.view'))
    .map(([fileName, yaml]) => {
      const label = yamlScalar(yaml, 'label');
      const description = yamlScalar(yaml, 'description');
      return {
        name: queryViewNameFromFilePath(fileName),
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        fileName,
        yaml,
      };
    })
    .filter((queryView) => queryView.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractTopicViewReferences(yaml: string): string[] {
  const refs = new Set<string>();
  const fieldPattern = /\$\{([A-Za-z_][\w/]*)(?:\.[A-Za-z_][\w]*)/g;
  for (const match of yaml.matchAll(fieldPattern)) refs.add(match[1]);
  for (const viewName of extractPlainFieldViewReferences(yaml)) refs.add(viewName);
  const scalarPattern = /^\s*(?:base_view|base_view_name|left_view_name|right_view_name|view|view_name|join_from_view|join_to_view):\s*(.+?)\s*$/gm;
  for (const match of yaml.matchAll(scalarPattern)) {
    const viewName = yamlScalarValue(match[1]);
    if (isSemanticViewName(viewName)) refs.add(viewName);
  }
  for (const viewName of extractYamlMapKeysFromSection(yaml, 'joins')) refs.add(viewName);
  for (const viewName of extractYamlMapKeysFromSection(yaml, 'views', { directOnly: true })) refs.add(viewName);
  return [...refs].sort();
}

function extractQueryViewReferences(yaml: string): string[] {
  const refs = new Set<string>();
  for (const fieldRef of extractFieldRefsFromString(yaml)) {
    const [viewName] = fieldRef.split('.');
    if (viewName) refs.add(viewName);
  }
  const scalarPattern = /^\s*(?:base_view|base_view_name|view|view_name|left_view_name|right_view_name|join_via_view|join_from_view|join_to_view):\s*["']?([A-Za-z_][\w/]*)["']?\s*$/gm;
  for (const match of yaml.matchAll(scalarPattern)) refs.add(match[1]);
  return [...refs].sort();
}

function extractRelationshipEdges(yaml: string | undefined): RelationshipEdgeDetail[] {
  if (!yaml?.trim()) return [];
  if (yaml.trim() === '[]') return [];
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*-\s+join_from_view\s*:/.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n').trimEnd());
      current = [line];
      continue;
    }
    if (current.length > 0) current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n').trimEnd());

  return blocks
    .map((block) => {
      const joinFromView = yamlScalarValue(block.match(/^\s*-\s+join_from_view\s*:\s*(.+?)\s*$/m)?.[1]);
      const joinToView = yamlScalarValue(block.match(/^\s*join_to_view\s*:\s*(.+?)\s*$/m)?.[1]);
      if (!isSemanticViewName(joinFromView) || !isSemanticViewName(joinToView)) return null;
      const joinType = yamlScalarValue(block.match(/^\s*join_type\s*:\s*(.+?)\s*$/m)?.[1]);
      const relationshipType = yamlScalarValue(block.match(/^\s*relationship_type\s*:\s*(.+?)\s*$/m)?.[1]);
      return {
        joinFromView,
        joinToView,
        ...(joinType ? { joinType } : {}),
        ...(relationshipType ? { relationshipType } : {}),
        yaml: block,
      };
    })
    .filter((edge): edge is RelationshipEdgeDetail => Boolean(edge));
}

function relationshipEdgeKey(edge: Pick<RelationshipEdgeDetail, 'joinFromView' | 'joinToView'>): string {
  return `${edge.joinFromView.toLowerCase()}->${edge.joinToView.toLowerCase()}`;
}

function relationshipEdgeYamlFingerprint(edge: RelationshipEdgeDetail): string {
  return edge.yaml.replace(/\s+/g, ' ').trim().toLowerCase();
}

function relationshipEdgeSummary(edge: Pick<RelationshipEdgeDetail, 'joinFromView' | 'joinToView'>): string {
  return `${edge.joinFromView} -> ${edge.joinToView}`;
}

function relationshipEdgeReference(edge: RelationshipEdgeReference): RelationshipEdgeReference {
  return {
    joinFromView: edge.joinFromView,
    joinToView: edge.joinToView,
    ...(edge.joinType ? { joinType: edge.joinType } : {}),
    ...(edge.relationshipType ? { relationshipType: edge.relationshipType } : {}),
  };
}

function detailRelationshipEdges(details: Record<string, unknown> | undefined): RelationshipEdgeReference[] {
  const raw = details?.relationshipEdges;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === 'object' && !Array.isArray(edge))
    .map((edge) => ({
      joinFromView: typeof edge.joinFromView === 'string' ? edge.joinFromView : '',
      joinToView: typeof edge.joinToView === 'string' ? edge.joinToView : '',
      ...(typeof edge.joinType === 'string' ? { joinType: edge.joinType } : {}),
      ...(typeof edge.relationshipType === 'string' ? { relationshipType: edge.relationshipType } : {}),
    }))
    .filter((edge) => isSemanticViewName(edge.joinFromView) && isSemanticViewName(edge.joinToView));
}

function mergeRelationshipYaml(existingYaml: string | undefined, edges: RelationshipEdgeDetail[]): string {
  const additions = edges.map((edge) => edge.yaml.trim()).filter(Boolean).join('\n\n');
  if (!additions) return existingYaml || '';
  const existing = existingYaml?.trim();
  if (!existing || existing === '[]') return `${additions}\n`;
  return `${existingYaml?.trimEnd()}\n\n${additions}\n`;
}

function targetViewNamesFromFieldUniverse(fields: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const field of fields) {
    const [viewName] = field.split('.');
    if (viewName) names.add(viewName);
  }
  return names;
}

function addQueryViewReference(
  refs: Map<string, QueryViewReferenceAccumulator>,
  queryViewName: string,
  source: RequiredQueryViewSource,
  referencedBy: string,
): boolean {
  const key = queryViewKey(queryViewName);
  if (!key) return false;
  const existing = refs.get(key);
  if (existing) {
    const before = existing.sources.size + existing.referencedBy.size;
    existing.sources.add(source);
    if (referencedBy) existing.referencedBy.add(referencedBy);
    return existing.sources.size + existing.referencedBy.size !== before;
  }
  refs.set(key, {
    name: queryViewName,
    sources: new Set([source]),
    referencedBy: new Set(referencedBy ? [referencedBy] : []),
  });
  return true;
}

async function detectRequiredQueryViews(input: {
  documentName: string;
  sourceModelId?: string;
  missingDashboardFieldRefs: string[];
  sourceTopics: SourceTopicRef[];
  sourceQueryViewUniverse: (modelId: string) => Promise<QueryViewCatalogResult>;
  sourceQueryViewCatalog: (modelId: string) => Promise<OmniModelQueryViewRecord[]>;
  targetQueryViewCatalog: () => Promise<OmniModelQueryViewRecord[]>;
  sourceTopicCatalog: (modelId: string) => Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>>;
}): Promise<{ requiredQueryViews: RequiredQueryViewDetail[]; warnings: string[] }> {
  if (!input.sourceModelId) return { requiredQueryViews: [], warnings: [] };

  const warnings: string[] = [];
  const universe = await input.sourceQueryViewUniverse(input.sourceModelId);
  if (universe.warning) warnings.push(universe.warning);
  if (universe.queryViews.length === 0) return { requiredQueryViews: [], warnings };

  const universeByKey = queryViewCatalogMap(universe.queryViews);
  const required = new Map<string, QueryViewReferenceAccumulator>();

  for (const viewName of fieldRefViewNames(input.missingDashboardFieldRefs)) {
    const sourceQueryView = universeByKey.get(queryViewKey(viewName) || '');
    if (sourceQueryView) addQueryViewReference(required, sourceQueryView.name, 'dashboard', input.documentName);
  }

  if (input.sourceTopics.length > 0) {
    try {
      const sourceTopics = await input.sourceTopicCatalog(input.sourceModelId);
      for (const topic of input.sourceTopics) {
        const sourceTopicYaml = findSourceTopicYaml(sourceTopics, topic);
        if (!sourceTopicYaml) continue;
        for (const viewName of extractTopicViewReferences(sourceTopicYaml.yaml)) {
          const sourceQueryView = universeByKey.get(queryViewKey(viewName) || '');
          if (sourceQueryView) addQueryViewReference(required, sourceQueryView.name, 'topic', sourceTopicYaml.name || topic.name);
        }
      }
    } catch (error) {
      warnings.push(`Source topic YAML could not be inspected for query-view references: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  if (required.size === 0) return { requiredQueryViews: [], warnings };

  let sourceCatalogError: string | undefined;
  let sourceCatalog: OmniModelQueryViewRecord[] = [];
  try {
    sourceCatalog = await input.sourceQueryViewCatalog(input.sourceModelId);
  } catch (error) {
    sourceCatalogError = `Source query-view catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}.`;
    warnings.push(sourceCatalogError);
  }
  const sourceCatalogByKey = queryViewCatalogMap(sourceCatalog);
  let dependencyScanChanged = true;
  while (dependencyScanChanged) {
    dependencyScanChanged = false;
    for (const reference of [...required.values()]) {
      const queryView = sourceCatalogByKey.get(queryViewKey(reference.name) || '') || universeByKey.get(queryViewKey(reference.name) || '');
      if (!queryView?.yaml) continue;
      for (const dependencyName of extractQueryViewReferences(queryView.yaml)) {
        const dependency = universeByKey.get(queryViewKey(dependencyName) || '');
        if (!dependency || queryViewKey(dependency.name) === queryViewKey(reference.name)) continue;
        dependencyScanChanged = addQueryViewReference(required, dependency.name, 'query_view_dependency', reference.name) || dependencyScanChanged;
      }
    }
  }

  let targetCatalogError: string | undefined;
  let targetCatalog: OmniModelQueryViewRecord[] = [];
  try {
    targetCatalog = await input.targetQueryViewCatalog();
  } catch (error) {
    targetCatalogError = `Target query-view catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}.`;
    warnings.push(targetCatalogError);
  }
  const targetCatalogByKey = queryViewCatalogMap(targetCatalog);

  const requiredQueryViews: RequiredQueryViewDetail[] = [...required.values()]
    .map((reference) => {
      const sourceQueryView = sourceCatalogByKey.get(queryViewKey(reference.name) || '') || universeByKey.get(queryViewKey(reference.name) || '');
      const targetQueryView = targetCatalogByKey.get(queryViewKey(reference.name) || '');
      let status: RequiredQueryViewStatus;
      let reason: string | undefined;
      let compatibility: QueryViewCompatibilityDetail | undefined;
      if (sourceCatalogError || targetCatalogError) {
        status = 'blocked';
        reason = sourceCatalogError || targetCatalogError;
      } else if (targetQueryView) {
        status = 'exact_target_match';
        compatibility = compareQueryViewCompatibility({
          sourceQueryView,
          targetQueryView,
          requiredFieldRefs: requiredFieldRefsForQueryView(sourceQueryView?.name || reference.name, input.missingDashboardFieldRefs),
        });
      } else if (sourceQueryView?.yaml) {
        status = 'missing_copyable';
      } else {
        status = 'missing_source_yaml';
        reason = `Source query-view YAML was not found for ${reference.name}.`;
      }
      return {
        name: sourceQueryView?.name || reference.name,
        ...(sourceQueryView?.fileName ? { sourceFileName: sourceQueryView.fileName } : {}),
        ...(targetQueryView?.fileName ? { targetFileName: targetQueryView.fileName } : {}),
        ...(sourceQueryView?.label ? { label: sourceQueryView.label } : {}),
        ...(sourceQueryView?.description ? { description: sourceQueryView.description } : {}),
        status,
        sources: [...reference.sources].sort(),
        referencedBy: [...reference.referencedBy].sort(),
        ...(reason ? { reason } : {}),
        ...(compatibility ? { compatibility } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { requiredQueryViews, warnings };
}

async function detectRequiredRelationships(input: {
  sourceModelId?: string;
  requiredQueryViews: RequiredQueryViewDetail[];
  sourceModelYamlFiles: (modelId: string) => Promise<Record<string, string>>;
  targetModelYamlFiles: () => Promise<Record<string, string>>;
}): Promise<{
  relationshipEdges: RelationshipEdgeReference[];
  existingRelationshipEdges: RelationshipEdgeReference[];
  relationshipBlockers: string[];
  warnings: string[];
}> {
  if (!input.sourceModelId || input.requiredQueryViews.length < 2) {
    return { relationshipEdges: [], existingRelationshipEdges: [], relationshipBlockers: [], warnings: [] };
  }

  const requiredViewKeys = new Set(input.requiredQueryViews.map((queryView) => queryViewKey(queryView.name)).filter((value): value is string => Boolean(value)));
  if (requiredViewKeys.size < 2) return { relationshipEdges: [], existingRelationshipEdges: [], relationshipBlockers: [], warnings: [] };

  const warnings: string[] = [];
  let sourceFiles: Record<string, string> = {};
  let targetFiles: Record<string, string> = {};
  try {
    sourceFiles = await input.sourceModelYamlFiles(input.sourceModelId);
  } catch (error) {
    warnings.push(`Source relationship YAML could not be inspected: ${error instanceof Error ? error.message : String(error)}.`);
  }
  try {
    targetFiles = await input.targetModelYamlFiles();
  } catch (error) {
    warnings.push(`Target relationship YAML could not be inspected: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (warnings.length > 0) return { relationshipEdges: [], existingRelationshipEdges: [], relationshipBlockers: [], warnings };

  const sourceEdges = extractRelationshipEdges(sourceFiles.relationships);
  const targetEdges = extractRelationshipEdges(targetFiles.relationships);
  const targetByKey = new Map(targetEdges.map((edge) => [relationshipEdgeKey(edge), edge]));
  const relationshipEdges: RelationshipEdgeReference[] = [];
  const existingRelationshipEdges: RelationshipEdgeReference[] = [];
  const relationshipBlockers: string[] = [];

  for (const sourceEdge of sourceEdges) {
    const fromRequired = requiredViewKeys.has(queryViewKey(sourceEdge.joinFromView) || '');
    const toRequired = requiredViewKeys.has(queryViewKey(sourceEdge.joinToView) || '');
    if (!fromRequired || !toRequired) continue;
    const targetEdge = targetByKey.get(relationshipEdgeKey(sourceEdge));
    if (!targetEdge) {
      relationshipEdges.push(relationshipEdgeReference(sourceEdge));
      continue;
    }
    if (relationshipEdgeYamlFingerprint(targetEdge) === relationshipEdgeYamlFingerprint(sourceEdge)) {
      existingRelationshipEdges.push(relationshipEdgeReference(sourceEdge));
      continue;
    }
    relationshipBlockers.push(`Target relationship ${relationshipEdgeSummary(sourceEdge)} already exists with different YAML. Review the target relationships file before importing this dashboard.`);
  }

  return {
    relationshipEdges: [...new Map(relationshipEdges.map((edge) => [relationshipEdgeKey(edge), edge])).values()],
    existingRelationshipEdges: [...new Map(existingRelationshipEdges.map((edge) => [relationshipEdgeKey(edge), edge])).values()],
    relationshipBlockers: [...new Set(relationshipBlockers)],
    warnings,
  };
}

function buildTopicRewriteMap(mappings: MigrationTopicMapping[]): Map<string, string> {
  const rewriteMap = new Map<string, string>();
  for (const mapping of mappings) {
    const target = normalizeTopicValue(mapping.targetTopicName);
    if (!target) continue;
    for (const source of [mapping.sourceTopicName, mapping.sourceTopicId]) {
      const cleanSource = normalizeTopicValue(source);
      if (cleanSource && cleanSource !== target) rewriteMap.set(cleanSource, target);
    }
  }
  return rewriteMap;
}

function rewriteDashboardTopicReferences(payload: Record<string, unknown>, mappings: MigrationTopicMapping[]): TopicRewriteResult {
  const rewriteMap = buildTopicRewriteMap(mappings);
  if (rewriteMap.size === 0) return { payload, replacementCount: 0, replacements: [] };
  let replacementCount = 0;
  const replacements: Array<{ from: string; to: string }> = [];

  function replaceString(value: string): string {
    const target = rewriteMap.get(value);
    if (!target) return value;
    replacementCount += 1;
    replacements.push({ from: value, to: target });
    return target;
  }

  function walk(value: unknown, keyHint = '', maxDepth = 16): unknown {
    if (maxDepth <= 0) return value;
    const normalizedKey = keyHint.toLowerCase();
    const isTopicScalar = TOPIC_SCALAR_KEYS.has(normalizedKey);
    const isTopicArray = TOPIC_ARRAY_KEYS.has(normalizedKey);
    if (typeof value === 'string') return isTopicScalar || isTopicArray ? replaceString(value) : value;
    if (Array.isArray(value)) {
      return value.map((item) => (
        typeof item === 'string' && isTopicArray ? replaceString(item) : walk(item, keyHint, maxDepth - 1)
      ));
    }
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [
      key,
      walk(item, key, maxDepth - 1),
    ]));
  }

  return {
    payload: walk(payload) as Record<string, unknown>,
    replacementCount,
    replacements,
  };
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
        targetConnectionId: target.targetConnectionId?.trim(),
        targetModelId,
        targetModelName: target.targetModelName?.trim() || targetModelId,
        targetFolderId: explicitFolderId || (explicitFolderPath ? undefined : destination.defaultFolderId),
        targetFolderPath: explicitFolderPath || destination.defaultFolderPath,
        topicMappings: normalizeTopicMappings(target.topicMappings),
        queryViewMappings: normalizeQueryViewMappings(target.queryViewMappings),
        fieldMappings: normalizeFieldMappings(target.fieldMappings),
        semanticPatches: normalizeSemanticPatches(target.semanticPatches),
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
      targetConnectionId: undefined,
      targetModelId: destination.defaultModelId,
      targetModelName: destination.defaultModelId,
      targetFolderId: destination.defaultFolderId,
      targetFolderPath: destination.defaultFolderPath,
      topicMappings: [],
      queryViewMappings: [],
      fieldMappings: [],
      semanticPatches: [],
    };
  });
}

function normalizeRouteGroups(input: {
  routeGroups?: MigrationRouteGroup[];
  targets?: MigrationTarget[];
  destinationIds?: string[];
  documentIds: string[];
}): MigrationRouteGroup[] {
  if (Array.isArray(input.routeGroups) && input.routeGroups.length > 0) {
    return input.routeGroups.map((group, index) => {
      const documentIds = [...new Set((group.documentIds || []).map((id) => id.trim()).filter(Boolean))];
      const targets = normalizeTargets({ targets: group.targets });
      if (documentIds.length === 0) throw new Error(`Choose at least one dashboard for route group ${group.name || index + 1}.`);
      if (targets.length === 0) throw new Error(`Choose at least one target for route group ${group.name || index + 1}.`);
      return {
        id: group.id?.trim() || `route-group-${index + 1}`,
        name: group.name?.trim() || `Route group ${index + 1}`,
        documentIds,
        targets,
      };
    });
  }
  return [{
    id: 'default-route',
    name: 'All selected dashboards',
    documentIds: [...new Set(input.documentIds.map((id) => id.trim()).filter(Boolean))],
    targets: normalizeTargets(input),
  }];
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
  sourceConnectionId?: string;
  destinationIds?: string[];
  targets?: MigrationTarget[];
  routeGroups?: MigrationRouteGroup[];
  documentIds: string[];
  sourceDocumentHints?: MigrationSourceDocumentHint[];
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  deleteSourceOnSuccess?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
  usePreviewCache?: boolean;
}): Promise<MigrationPlan> {
  const source = requireInstance(input.sourceId);
  const routeGroups = normalizeRouteGroups(input);
  const targetsById = new Map<string, MigrationTarget>();
  for (const target of routeGroups.flatMap((group) => group.targets)) {
    if (!targetsById.has(target.id)) targetsById.set(target.id, target);
  }
  const targets = [...targetsById.values()];
  const sourceDocumentIds = [...new Set(routeGroups.flatMap((group) => group.documentIds))];
  const sourceClient = new OmniClient(source);
  const sourceAllFolders = input.sourceAllFolders === true;
  const sourceFolderId = sourceAllFolders ? undefined : input.sourceFolderId?.trim() || source.defaultFolderId;
  const sourceFolderPath = sourceAllFolders ? undefined : input.sourceFolderPath?.trim() || source.defaultFolderPath;
  const replaceSameNamed = input.replaceSameNamed !== false;
  const previewCacheEnabled = input.usePreviewCache === true;
  const cacheScope = `migration-preview:${input.sourceId}:${input.sourceConnectionId || ''}`;
  const cachedPreviewRead = <T>(key: string, loader: () => Promise<T>) => readThroughCache(
    `${cacheScope}:${key}`,
    loader,
    { enabled: previewCacheEnabled },
  );
  const sourceDocumentHints = previewCacheEnabled
    ? (input.sourceDocumentHints || [])
      .filter((document) => sourceDocumentIds.includes(document.identifier) || sourceDocumentIds.includes(document.id))
      .map((document) => ({ ...document }))
    : [];
  const hintKeys = new Set(sourceDocumentHints.flatMap((document) => [document.id, document.identifier]).filter(Boolean));
  const hintsCoverSelection = sourceDocumentIds.length > 0 && sourceDocumentIds.every((documentId) => hintKeys.has(documentId));
  const sourceDocs = hintsCoverSelection
    ? sourceDocumentHints as OmniDocumentRecord[]
    : await cachedPreviewRead(
      `source-documents:${JSON.stringify({ sourceFolderId, sourceFolderPath })}`,
      () => listDocumentsForFolder(sourceClient, sourceFolderId, sourceFolderPath, true),
    );
  const selected = sourceDocs.filter((doc) => sourceDocumentIds.includes(doc.identifier) || sourceDocumentIds.includes(doc.id));
  const selectedByKey = new Map<string, OmniDocumentRecord>();
  for (const doc of selected) {
    selectedByKey.set(doc.identifier, doc);
    selectedByKey.set(doc.id, doc);
  }
  const missing = sourceDocumentIds.filter((id) => !selectedByKey.has(id));
  if (missing.length > 0) throw new Error(`Source documents not found: ${missing.join(', ')}`);
  const selectedSourceDocumentKeys = new Set(selected.flatMap((doc) => [doc.id, doc.identifier]).filter(Boolean));

  const steps: MigrationPlanStep[] = [];
  const deleteStepKeys = new Set<string>();
  const exportCache = new Map<string, Record<string, unknown>>();
  const fieldRefCache = new Map<string, string[]>();
  const sourceTopicCatalogCache = new Map<string, Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>>>();
  const sourceQueryViewUniverseCache = new Map<string, Promise<QueryViewCatalogResult>>();
  const sourceQueryViewCatalogCache = new Map<string, Promise<OmniModelQueryViewRecord[]>>();
  const sourceModelYamlFilesCache = new Map<string, Promise<Record<string, string>>>();
  const targetModelYamlFilesCache = new Map<string, Promise<Record<string, string>>>();

  function cachedInstanceRead<T>(instanceId: string, key: string, loader: () => Promise<T>) {
    return readThroughCache(
      `migration-preview:${instanceId}:${key}`,
      loader,
      { enabled: previewCacheEnabled },
    );
  }

  function sourceTopicCatalog(modelId: string) {
    const cached = sourceTopicCatalogCache.get(modelId);
    if (cached) return cached;
    const next = cachedPreviewRead(
      `source-topics:${modelId}`,
      () => sourceClient.listModelTopics(modelId, { includeYaml: true, includeChecksums: true }),
    );
    sourceTopicCatalogCache.set(modelId, next);
    return next;
  }

  function sourceQueryViewUniverse(modelId: string) {
    const cached = sourceQueryViewUniverseCache.get(modelId);
    if (cached) return cached;
    const next = (async (): Promise<QueryViewCatalogResult> => {
      try {
        const files = await cachedPreviewRead(
          `source-model-yaml-files:${modelId}`,
          () => sourceClient.getModelYamlFiles(modelId),
        );
        return { queryViews: queryViewsFromModelYamlFiles(files) };
      } catch (error) {
        return {
          queryViews: [],
          warning: `Source query-view YAML inspection failed: ${error instanceof Error ? error.message : String(error)}.`,
        };
      }
    })();
    sourceQueryViewUniverseCache.set(modelId, next);
    return next;
  }

  function sourceQueryViewCatalog(modelId: string) {
    const cached = sourceQueryViewCatalogCache.get(modelId);
    if (cached) return cached;
    const next = cachedPreviewRead(
      `source-query-views:${modelId}`,
      () => sourceClient.listModelQueryViews(modelId, { includeYaml: true, includeChecksums: true }),
    );
    sourceQueryViewCatalogCache.set(modelId, next);
    return next;
  }

  function sourceModelYamlFiles(modelId: string) {
    const cached = sourceModelYamlFilesCache.get(modelId);
    if (cached) return cached;
    const next = cachedPreviewRead(`source-model-yaml-files:${modelId}`, () => sourceClient.getModelYamlFiles(modelId));
    sourceModelYamlFilesCache.set(modelId, next);
    return next;
  }

  function targetModelYamlFiles(destination: SavedInstance, client: OmniClient, targetModelId: string) {
    const key = `${destination.id}:${targetModelId}`;
    const cached = targetModelYamlFilesCache.get(key);
    if (cached) return cached;
    const next = cachedInstanceRead(destination.id, `target-model-yaml-files:${targetModelId}`, () => client.getModelYamlFiles(targetModelId));
    targetModelYamlFilesCache.set(key, next);
    return next;
  }

  for (const routeGroup of routeGroups) {
    const groupSelectedByIdentifier = new Map<string, OmniDocumentRecord>();
    for (const documentId of routeGroup.documentIds) {
      const doc = selectedByKey.get(documentId);
      if (doc) groupSelectedByIdentifier.set(doc.identifier, doc);
    }
    const groupSelected = [...groupSelectedByIdentifier.values()];
    const selectedNames = new Set(groupSelected.map((doc) => doc.name).filter(Boolean));

    for (const target of routeGroup.targets) {
    const destination = requireInstance(target.destinationInstanceId);
    const destinationClient = new OmniClient(destination);
    const cleanupNotices: string[] = [];
    const cleanupFolderPath = target.targetFolderPath || destination.defaultFolderPath;
    const cleanupCanBeScoped = folderScopeAvailable(target.targetFolderId, cleanupFolderPath);
    const canUseDefaultReplacementFallback = !input.emptyFirst && replaceSameNamed && !cleanupCanBeScoped;
    let existing: OmniDocumentRecord[] = [];
    if (input.emptyFirst || replaceSameNamed) {
      if (cleanupCanBeScoped) {
        existing = await cachedInstanceRead(
          destination.id,
          `target-documents:${JSON.stringify({ folderId: target.targetFolderId, folderPath: cleanupFolderPath })}`,
          () => listDocumentsForFolder(
            destinationClient,
            target.targetFolderId,
            cleanupFolderPath,
          ),
        );
      } else if (canUseDefaultReplacementFallback) {
        existing = (await cachedInstanceRead(
          destination.id,
          'target-documents:default-fallback',
          () => listDocumentsForFolder(destinationClient),
        ))
          .filter((document) => selectedNames.has(document.name) && documentLooksInDefaultFolder(document));
      } else {
        cleanupNotices.push('Target cleanup was skipped because the selected target folder is the default My Documents area and OmniKit cannot scope replacement deletes safely.');
      }
    }
    const destinationWarnings: string[] = [];
    const targetTopicWarnings: string[] = [];
    const targetQueryViewWarnings: string[] = [];
    const targetFields = await loadTargetFieldUniverse(
      destinationClient,
      target.targetModelId,
      () => targetModelYamlFiles(destination, destinationClient, target.targetModelId),
    );
    let targetYamlSnapshot: OmniModelYamlResponse | null = null;
    async function loadTargetYamlSnapshot(): Promise<OmniModelYamlResponse> {
      if (targetYamlSnapshot) return targetYamlSnapshot;
      targetYamlSnapshot = await cachedInstanceRead(
        destination.id,
        `target-model-yaml:${target.targetModelId}:checksums`,
        () => destinationClient.getModelYaml(target.targetModelId, { includeChecksums: true }),
      );
      return targetYamlSnapshot;
    }
    const targetViewNames = targetViewNamesFromFieldUniverse(targetFields.fields);
    if (targetFields.warning) destinationWarnings.push(targetFields.warning);
    const hasCreateTopicMappings = (target.topicMappings || []).some((mapping) => mapping.action === 'copy_source');
    const hasCreateQueryViewMappings = (target.queryViewMappings || []).some((mapping) => mapping.action === 'copy_source' || mapping.action === 'update_existing');
    const hasCreateFieldMappings = (target.fieldMappings || []).some((mapping) => mapping.action === 'create_from_source' || mapping.action === 'map_existing');
    let targetModelRecord: { gitConfigured?: boolean; pullRequestRequired?: boolean; gitProtected?: boolean } | undefined;
    if (hasCreateTopicMappings || hasCreateQueryViewMappings || hasCreateFieldMappings) {
      try {
        const targetModels = await cachedInstanceRead(
          destination.id,
          `target-models:${JSON.stringify({ modelKind: 'SHARED', connectionId: target.targetConnectionId })}`,
          () => destinationClient.listModels({ modelKind: 'SHARED', connectionId: target.targetConnectionId }),
        );
        targetModelRecord = targetModels.find((model) => (
          [model.id, model.identifier, model.baseModelId, model.name].some((value) => value === target.targetModelId)
        ));
      } catch (error) {
        const warning = `Target model editability could not be checked: ${error instanceof Error ? error.message : String(error)}.`;
        if (hasCreateTopicMappings) targetTopicWarnings.push(warning);
        if (hasCreateQueryViewMappings) targetQueryViewWarnings.push(warning);
        if (hasCreateFieldMappings) destinationWarnings.push(warning);
      }
    }
	    let targetTopics: Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }> | null = null;
    let targetQueryViews: OmniModelQueryViewRecord[] | null = null;
    const acceptedSemanticPatches = normalizeSemanticPatches(target.semanticPatches);

	    async function loadTargetTopicsForPreflight(): Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>> {
	      if (targetTopics) return targetTopics;
	      targetTopics = await cachedInstanceRead(
	        destination.id,
	        `target-topics:${target.targetModelId}`,
	        () => destinationClient.listModelTopics(target.targetModelId, { includeYaml: true, includeChecksums: true }),
	      );
	      return targetTopics;
	    }

    async function loadTargetQueryViewsForPreflight(): Promise<OmniModelQueryViewRecord[]> {
      if (targetQueryViews) return targetQueryViews;
      targetQueryViews = await cachedInstanceRead(
        destination.id,
        `target-query-views:${target.targetModelId}`,
        () => destinationClient.listModelQueryViews(target.targetModelId, { includeYaml: true, includeChecksums: true }),
      );
      return targetQueryViews;
    }

    for (const existingDoc of existing) {
      const replacingExistingDoc = !input.emptyFirst && replaceSameNamed && selectedNames.has(existingDoc.name);
      if (!input.emptyFirst && !replacingExistingDoc) continue;
      if (destination.id === source.id && documentKeyMatches(existingDoc, selectedSourceDocumentKeys)) {
        cleanupNotices.push(`Skipped target cleanup for selected source dashboard ${existingDoc.name} because source and target are the same Omni instance.`);
        continue;
      }
      const deleteKey = `${destination.id}:${existingDoc.identifier}`;
      if (deleteStepKeys.has(deleteKey)) continue;
      deleteStepKeys.add(deleteKey);
      steps.push({
        routeGroupId: routeGroup.id,
        routeGroupName: routeGroup.name,
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetConnectionId: target.targetConnectionId,
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

    for (const doc of groupSelected) {
      const cleanupStepNotices = [...new Set(cleanupNotices)];
      let compatibilityWarnings = [...destinationWarnings];
      let compatibilityNotices: string[] = [];
      let queryViewWarnings = [...targetQueryViewWarnings];
      let relationshipWarnings: string[] = [];
      let topicWarnings = [...targetTopicWarnings];
      let resolvedQueryViewMappings: MigrationQueryViewMapping[] = [];
      let resolvedFieldMappings: MigrationFieldMapping[] = [];
      let resolvedTopicMappings: MigrationTopicMapping[] = [];
      let sourceTopics: SourceTopicRef[] = [];
      let requiredQueryViews: RequiredQueryViewDetail[] = [];
      let fieldDependencies: MigrationFieldDependency[] = [];
      let relationshipEdges: RelationshipEdgeReference[] = [];
      let existingRelationshipEdges: RelationshipEdgeReference[] = [];
      let sourceModelId: string | undefined;
      let unresolvedMissingFields: string[] = [];
      let semanticPatches: MigrationSemanticPatch[] = [];
      const queryViewBlockers: string[] = [];
      const fieldBlockers: string[] = [];
      const relationshipBlockers: string[] = [];
      const topicBlockers: string[] = [];
      try {
        let refs = fieldRefCache.get(doc.identifier);
        let payload = exportCache.get(doc.identifier);
        if (!refs) {
          if (!payload) {
            payload = await cachedPreviewRead(
              `source-export:${doc.identifier}`,
              () => sourceClient.exportDocument(doc.identifier),
            );
            exportCache.set(doc.identifier, payload);
          }
          refs = extractDashboardFieldRefs(payload);
          fieldRefCache.set(doc.identifier, refs);
        }
        if (!payload) {
          payload = await cachedPreviewRead(
            `source-export:${doc.identifier}`,
            () => sourceClient.exportDocument(doc.identifier),
          );
          exportCache.set(doc.identifier, payload);
        }
        sourceModelId = doc.baseModelId || extractDashboardModelId(payload);
        const sameTargetModel = Boolean(sourceModelId && sourceModelId === target.targetModelId);
        let missingFields: string[] = [];
        if (!sameTargetModel && refs.length === 0) {
          compatibilityWarnings.push('No dashboard field references were detected in the export payload. Review the imported dashboard in Omni before publishing.');
        } else if (!sameTargetModel && targetFields.fields.size > 0) {
          missingFields = refs.filter((field) => !targetFields.fields.has(field));
        }
        sourceTopics = collectTopicRefs(payload, doc);
        const queryViewDetection = await detectRequiredQueryViews({
          documentName: doc.name,
          sourceModelId,
          missingDashboardFieldRefs: missingFields,
          sourceTopics,
          sourceQueryViewUniverse,
          sourceQueryViewCatalog,
          targetQueryViewCatalog: loadTargetQueryViewsForPreflight,
          sourceTopicCatalog,
        });
        requiredQueryViews = queryViewDetection.requiredQueryViews;
        compatibilityWarnings.push(...queryViewDetection.warnings);
        if (requiredQueryViews.length > 0) {
          try {
            const targetQueryViewRows = await loadTargetQueryViewsForPreflight();
            const queryViewPreflight = validateQueryViewMappingsForPreflight({
              requiredQueryViews,
              configuredMappings: target.queryViewMappings || [],
              targetQueryViews: targetQueryViewRows,
            });
            resolvedQueryViewMappings = queryViewPreflight.resolvedQueryViewMappings;
            queryViewBlockers.push(...queryViewPreflight.queryViewBlockers);
            for (const mapping of resolvedQueryViewMappings) {
              if (mapping.action === 'use_existing_unverified') {
                queryViewWarnings.push(`Using existing query view ${mapping.targetQueryViewName} as-is even though compatibility checks need review.`);
              }
              if (mapping.action !== 'copy_source') continue;
              if (targetModelRecord?.pullRequestRequired || targetModelRecord?.gitProtected) {
                queryViewBlockers.push(`Cannot create target query view ${mapping.targetQueryViewName} directly because ${target.targetModelName || target.targetModelId} requires protected branch or pull-request YAML changes.`);
                continue;
              }
              if (targetModelRecord?.gitConfigured) {
                queryViewWarnings.push(`Target model ${target.targetModelName || target.targetModelId} is git configured; created query-view YAML may require Omni-side review after import.`);
              }
            }
            if (sourceModelId && resolvedQueryViewMappings.length > 0) {
              try {
                const sourceQueryViewRows = await sourceQueryViewCatalog(sourceModelId);
                const queryViewPatches = resolvedQueryViewMappings
                  .map((mapping) => semanticPatchForQueryViewMapping({
                    mapping,
                    sourceQueryViews: sourceQueryViewRows,
                    targetQueryViews: targetQueryViewRows,
                  }))
                  .filter((patch): patch is MigrationSemanticPatch => Boolean(patch));
                semanticPatches.push(...queryViewPatches);
              } catch (error) {
                queryViewWarnings.push(`Query-view code patches could not be prepared: ${error instanceof Error ? error.message : String(error)}.`);
              }
            }
          } catch (error) {
            queryViewBlockers.push(`Target query-view catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}.`);
          }
        }
        if (missingFields.length > 0) {
          const resolvedByQueryViewPrep = missingFields.filter((field) => (
            resolvedQueryViewMappings.some((mapping) => queryViewMappingResolvesFieldRef(mapping, field))
          ));
          unresolvedMissingFields = missingFields.filter((field) => !resolvedByQueryViewPrep.includes(field));
          if (resolvedByQueryViewPrep.length > 0) {
            compatibilityNotices.push(`${resolvedByQueryViewPrep.length} referenced field${resolvedByQueryViewPrep.length === 1 ? '' : 's'} will be supplied by query-view preparation: ${formatFieldList(resolvedByQueryViewPrep)}.`);
          }
        }
        if (unresolvedMissingFields.length > 0) {
          let sourceDefinitions = new Map<string, ModelFieldDefinition>();
          try {
            if (!sourceModelId) {
              fieldBlockers.push(`Cannot inspect source field definitions for ${doc.name} because the source model ID could not be detected.`);
            } else {
              sourceDefinitions = fieldDefinitionIndex(await sourceModelYamlFiles(sourceModelId));
            }
          } catch (error) {
            fieldBlockers.push(`Source model fields could not be inspected for ${doc.name}: ${error instanceof Error ? error.message : String(error)}.`);
          }
          const fieldPreflight = validateFieldDependencies({
            missingFields: unresolvedMissingFields,
            configuredMappings: normalizeFieldMappings(target.fieldMappings),
            sourceDefinitions,
            targetDefinitions: targetFields.definitions,
            targetFields: targetFields.fields,
            targetModelName: target.targetModelName || target.targetModelId,
            targetModelProtected: Boolean(targetModelRecord?.pullRequestRequired || targetModelRecord?.gitProtected),
            targetModelGitConfigured: Boolean(targetModelRecord?.gitConfigured),
          });
          fieldDependencies = fieldPreflight.fieldDependencies;
          resolvedFieldMappings = fieldPreflight.resolvedFieldMappings;
          fieldBlockers.push(...fieldPreflight.fieldBlockers);
          compatibilityWarnings.push(...fieldPreflight.fieldWarnings);
          if (fieldPreflight.mappedFieldRefs.length > 0) {
            compatibilityNotices.push(`${fieldPreflight.mappedFieldRefs.length} referenced field${fieldPreflight.mappedFieldRefs.length === 1 ? '' : 's'} will be mapped to selected destination fields: ${formatFieldList(fieldPreflight.mappedFieldRefs)}.`);
          }
          if (fieldPreflight.createdFieldRefs.length > 0) {
            compatibilityNotices.push(`${fieldPreflight.createdFieldRefs.length} referenced field${fieldPreflight.createdFieldRefs.length === 1 ? '' : 's'} will be created from source model YAML: ${formatFieldList(fieldPreflight.createdFieldRefs)}.`);
          }
          if (fieldPreflight.ignoredFieldRefs.length > 0) {
            compatibilityWarnings.push(`${fieldPreflight.ignoredFieldRefs.length} referenced field${fieldPreflight.ignoredFieldRefs.length === 1 ? '' : 's'} will be ignored by user choice: ${formatFieldList(fieldPreflight.ignoredFieldRefs)}.`);
          }
          if (resolvedFieldMappings.length > 0) {
            try {
              const targetYaml = await loadTargetYamlSnapshot();
              semanticPatches.push(...resolvedFieldMappings
                .map((mapping) => semanticPatchForFieldMapping({
                  mapping,
                  sourceDefinitions,
                  targetYamlFiles: targetYaml.files,
                  targetChecksums: targetYaml.checksums,
                }))
                .filter((patch): patch is MigrationSemanticPatch => Boolean(patch)));
            } catch (error) {
              compatibilityWarnings.push(`Field code patches could not be prepared: ${error instanceof Error ? error.message : String(error)}.`);
            }
          }
        }
        const relationshipDetection = await detectRequiredRelationships({
          sourceModelId,
          requiredQueryViews,
          sourceModelYamlFiles,
          targetModelYamlFiles: () => targetModelYamlFiles(destination, destinationClient, target.targetModelId),
        });
        relationshipEdges = relationshipDetection.relationshipEdges;
        existingRelationshipEdges = relationshipDetection.existingRelationshipEdges;
        relationshipWarnings.push(...relationshipDetection.warnings);
        relationshipBlockers.push(...relationshipDetection.relationshipBlockers);
        if ((relationshipEdges.length > 0 || relationshipBlockers.length > 0) && sourceModelId) {
          try {
            const sourceFiles = await sourceModelYamlFiles(sourceModelId);
            const targetYaml = await loadTargetYamlSnapshot();
            const relationshipPatch = semanticPatchForRelationshipEdges({
              sourceFiles,
              targetFiles: targetYaml.files,
              targetChecksums: targetYaml.checksums,
              relationshipEdges,
            });
            if (relationshipPatch) semanticPatches.push(relationshipPatch);
            const acceptedRelationshipPatch = activeSemanticPatchFor(
              acceptedSemanticPatches,
              'relationship',
              'relationships',
              'relationships',
            );
            if (semanticPatchWriteYaml(acceptedRelationshipPatch)) {
              relationshipBlockers.length = 0;
              relationshipWarnings.push('Relationship YAML will be applied from the accepted code review patch.');
            }
          } catch (error) {
            relationshipWarnings.push(`Relationship code patch could not be prepared: ${error instanceof Error ? error.message : String(error)}.`);
          }
        }
        if (sourceTopics.length > 0) {
          let targetTopicRows: Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }> = [];
          try {
            targetTopicRows = await loadTargetTopicsForPreflight();
          } catch (error) {
            topicBlockers.push(`Target topic catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}.`);
          }
          for (const topic of sourceTopics) {
            const explicitMapping = mappingForSourceTopic(topic, target.topicMappings || []);
            const exact = exactTargetTopic(topic, targetTopicRows);
            const mapping = explicitMapping || (exact ? {
              sourceTopicName: topic.name,
              sourceTopicId: topic.id,
              action: 'map_existing' as const,
              targetTopicName: exact.name,
              targetTopicLabel: exact.label,
            } : undefined);
            if (!mapping) {
              topicBlockers.push(`Topic ${topic.name} is used by ${doc.name} but is not mapped for ${destination.label}.`);
              continue;
            }
	            if (mapping.action === 'map_existing') {
	              if (!targetTopicExists(targetTopicRows, mapping.targetTopicName)) {
	                topicBlockers.push(`Mapped target topic ${mapping.targetTopicName} was not found in ${target.targetModelName || target.targetModelId}.`);
	                continue;
	              }
	              if (sourceModelId) {
	                try {
	                  const sourceTopicRows = await sourceTopicCatalog(sourceModelId);
	                  const sourceTopicYaml = findSourceTopicYaml(sourceTopicRows, topic);
	                  const targetTopicYaml = findSourceTopicYaml(targetTopicRows, { name: mapping.targetTopicName, id: mapping.targetTopicName });
                    const topicPatch = semanticPatchForTopicMapping({
                      topic,
                      mapping,
                      sourceTopics: sourceTopicRows,
                      targetTopics: targetTopicRows,
                    });
                    if (topicPatch) semanticPatches.push(topicPatch);
	                  if (sourceTopicYaml?.yaml && targetTopicYaml?.yaml) {
	                    const compatibilityBlockers = mappedTopicCompatibilityBlockers({
	                      sourceTopicName: sourceTopicYaml.name || topic.name,
	                      targetTopicName: targetTopicYaml.name || mapping.targetTopicName,
	                      sourceYaml: sourceTopicYaml.yaml,
	                      targetYaml: targetTopicYaml.yaml,
	                    });
                      const acceptedTopicPatch = activeSemanticPatchFor(
                        acceptedSemanticPatches,
                        'topic',
                        topicPatch?.targetFileName || targetTopicYaml.fileName || `${mapping.targetTopicName}.topic`,
                        mapping.sourceTopicName || topic.name,
                      );
                      if (compatibilityBlockers.length > 0 && semanticPatchWriteYaml(acceptedTopicPatch)) {
                        topicWarnings.push(`Mapped target topic ${mapping.targetTopicName} will be updated from the accepted code review patch.`);
                      } else {
                        topicBlockers.push(...compatibilityBlockers);
                      }
	                  }
	                } catch (error) {
	                  topicWarnings.push(`Mapped target topic ${mapping.targetTopicName} compatibility could not be inspected: ${error instanceof Error ? error.message : String(error)}.`);
	                }
	              }
	              resolvedTopicMappings.push(mapping);
	              continue;
	            }
            if (!sourceModelId) {
              topicBlockers.push(`Cannot create target topic ${mapping.targetTopicName} because the source model ID could not be detected.`);
              continue;
            }
            if (targetModelRecord?.pullRequestRequired || targetModelRecord?.gitProtected) {
              topicBlockers.push(`Cannot create target topic ${mapping.targetTopicName} directly because ${target.targetModelName || target.targetModelId} requires protected branch or pull-request YAML changes.`);
              continue;
            }
            if (targetModelRecord?.gitConfigured) {
              topicWarnings.push(`Target model ${target.targetModelName || target.targetModelId} is git configured; created topic YAML may require Omni-side review after import.`);
            }
            if (targetTopicExists(targetTopicRows, mapping.targetTopicName)) {
              topicBlockers.push(`Target topic ${mapping.targetTopicName} already exists. Use the existing topic or enter a new topic name.`);
              continue;
            }
            try {
              const sourceTopicRows = await sourceTopicCatalog(sourceModelId);
              const sourceTopicYaml = findSourceTopicYaml(sourceTopicRows, topic);
              if (!sourceTopicYaml) {
                topicBlockers.push(`Source topic YAML was not found for ${topic.name} in model ${sourceModelId}.`);
                continue;
              }
              const viewRefs = extractTopicViewReferences(sourceTopicYaml.yaml);
              if (viewRefs.length > 0 && targetViewNames.size > 0) {
                const missingViews = viewRefs.filter((viewName) => !targetViewNames.has(viewName));
                if (missingViews.length > 0) {
                  topicWarnings.push(`Copied topic ${topic.name} references target views that were not detected: ${formatFieldList(missingViews)}.`);
                }
              }
              const topicPatch = semanticPatchForTopicMapping({
                topic,
                mapping,
                sourceTopics: sourceTopicRows,
                targetTopics: targetTopicRows,
              });
              if (topicPatch) semanticPatches.push(topicPatch);
              resolvedTopicMappings.push(mapping);
            } catch (error) {
              topicBlockers.push(`Source topic ${topic.name} could not be inspected: ${error instanceof Error ? error.message : String(error)}.`);
            }
          }
          resolvedTopicMappings = [...new Map(resolvedTopicMappings.map((mapping) => [
            `${mapping.sourceTopicId || mapping.sourceTopicName}:${mapping.targetTopicName}`,
            mapping,
          ])).values()];
        }
      } catch (error) {
        compatibilityWarnings.push(`Compatibility preflight could not inspect ${doc.name}: ${error instanceof Error ? error.message : String(error)}.`);
      }
      compatibilityWarnings = [...new Set(compatibilityWarnings)];
      compatibilityNotices = [...new Set(compatibilityNotices)];
      queryViewWarnings = [...new Set(queryViewWarnings)];
      relationshipWarnings = [...new Set(relationshipWarnings)];
      topicWarnings = [...new Set(topicWarnings)];
      semanticPatches = mergeSemanticPatchCandidates(
        [...new Map(semanticPatches.map((patch) => [patch.id, patch])).values()],
        acceptedSemanticPatches,
      );
      const blockedSemanticPatchMessages = semanticPatches
        .filter((patch) => patch.status === 'blocked' || patch.safetyCategory === 'blocked')
        .map((patch) => `${semanticPatchArtifactLabel(patch.artifactType)} ${patch.sourceName || patch.targetFileName} needs resolution before dashboard import.`);
      const semanticDetails: Record<string, unknown> = {};
      if (requiredQueryViews.length > 0) semanticDetails.requiredQueryViews = requiredQueryViews;
      if (resolvedQueryViewMappings.length > 0) semanticDetails.queryViewMappings = resolvedQueryViewMappings;
      if (fieldDependencies.length > 0) semanticDetails.fieldDependencies = fieldDependencies;
      if (resolvedFieldMappings.length > 0) semanticDetails.fieldMappings = resolvedFieldMappings;
      if (relationshipEdges.length > 0) semanticDetails.relationshipEdges = relationshipEdges;
      if (existingRelationshipEdges.length > 0) semanticDetails.existingRelationshipEdges = existingRelationshipEdges;
      if (semanticPatches.length > 0) semanticDetails.semanticPatches = semanticPatches;
      if (unresolvedMissingFields.length > 0) semanticDetails.unresolvedSemanticFieldRefs = unresolvedMissingFields;
      steps.push({
        routeGroupId: routeGroup.id,
        routeGroupName: routeGroup.name,
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetConnectionId: target.targetConnectionId,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId,
        targetFolderPath: target.targetFolderPath,
        kind: 'export',
        documentId: doc.identifier,
        documentName: doc.name,
      });
      if (fieldDependencies.length > 0 || fieldBlockers.length > 0) {
        steps.push({
          routeGroupId: routeGroup.id,
          routeGroupName: routeGroup.name,
          targetId: target.id,
          destinationId: destination.id,
          destinationLabel: destination.label,
          targetConnectionId: target.targetConnectionId,
          targetModelId: target.targetModelId,
          targetModelName: target.targetModelName,
          targetFolderId: target.targetFolderId,
          targetFolderPath: target.targetFolderPath,
          kind: 'field_prepare',
          documentId: doc.identifier,
          documentName: doc.name,
          blocked: queryViewBlockers.length > 0 || fieldBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
          error: queryViewBlockers.length > 0
            ? 'Field preparation is blocked until query-view mappings are resolved.'
            : fieldBlockers.length > 0 ? fieldBlockers.join(' ')
              : blockedSemanticPatchMessages.length > 0 ? blockedSemanticPatchMessages.join(' ') : undefined,
          warnings: compatibilityWarnings.length > 0 ? compatibilityWarnings : undefined,
          notices: compatibilityNotices.length > 0 ? compatibilityNotices : undefined,
          details: {
            fieldDependencies,
            fieldMappings: resolvedFieldMappings,
            semanticPatches,
          },
        });
      }
      if (requiredQueryViews.length > 0 || queryViewBlockers.length > 0) {
        steps.push({
          routeGroupId: routeGroup.id,
          routeGroupName: routeGroup.name,
          targetId: target.id,
          destinationId: destination.id,
          destinationLabel: destination.label,
          targetConnectionId: target.targetConnectionId,
          targetModelId: target.targetModelId,
          targetModelName: target.targetModelName,
          targetFolderId: target.targetFolderId,
          targetFolderPath: target.targetFolderPath,
          kind: 'query_view_prepare',
          documentId: doc.identifier,
          documentName: doc.name,
          blocked: queryViewBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
          error: queryViewBlockers.length > 0
            ? queryViewBlockers.join(' ')
            : blockedSemanticPatchMessages.length > 0 ? blockedSemanticPatchMessages.join(' ') : undefined,
          warnings: queryViewWarnings.length > 0 ? queryViewWarnings : undefined,
          details: {
            requiredQueryViews,
            queryViewMappings: resolvedQueryViewMappings,
            semanticPatches,
          },
	        });
	      }
	      if (relationshipEdges.length > 0 || relationshipBlockers.length > 0) {
	        steps.push({
	          routeGroupId: routeGroup.id,
	          routeGroupName: routeGroup.name,
	          targetId: target.id,
	          destinationId: destination.id,
	          destinationLabel: destination.label,
	          targetConnectionId: target.targetConnectionId,
	          targetModelId: target.targetModelId,
	          targetModelName: target.targetModelName,
	          targetFolderId: target.targetFolderId,
	          targetFolderPath: target.targetFolderPath,
	          kind: 'relationship_prepare',
	          documentId: doc.identifier,
	          documentName: doc.name,
	          blocked: queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
	          error: queryViewBlockers.length > 0
	            ? 'Relationship preparation is blocked until query-view mappings are resolved.'
              : fieldBlockers.length > 0 ? 'Relationship preparation is blocked until field dependencies are resolved.'
	            : relationshipBlockers.length > 0 ? relationshipBlockers.join(' ')
	              : blockedSemanticPatchMessages.length > 0 ? blockedSemanticPatchMessages.join(' ') : undefined,
	          warnings: relationshipWarnings.length > 0 ? relationshipWarnings : undefined,
	          details: {
	            sourceModelId,
	            relationshipEdges,
	            existingRelationshipEdges,
              semanticPatches,
	          },
	        });
	      }
	      if (sourceTopics.length > 0 || topicBlockers.length > 0) {
	        steps.push({
          routeGroupId: routeGroup.id,
          routeGroupName: routeGroup.name,
          targetId: target.id,
          destinationId: destination.id,
          destinationLabel: destination.label,
          targetConnectionId: target.targetConnectionId,
          targetModelId: target.targetModelId,
          targetModelName: target.targetModelName,
          targetFolderId: target.targetFolderId,
          targetFolderPath: target.targetFolderPath,
          kind: 'topic_prepare',
          documentId: doc.identifier,
          documentName: doc.name,
	          blocked: queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || topicBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
	          error: queryViewBlockers.length > 0
	            ? 'Topic preparation is blocked until query-view mappings are resolved.'
              : fieldBlockers.length > 0 ? 'Topic preparation is blocked until field dependencies are resolved.'
	            : relationshipBlockers.length > 0 ? 'Topic preparation is blocked until relationship mappings are resolved.'
	            : topicBlockers.length > 0 ? topicBlockers.join(' ')
	              : blockedSemanticPatchMessages.length > 0 ? blockedSemanticPatchMessages.join(' ') : undefined,
          warnings: topicWarnings.length > 0 ? topicWarnings : undefined,
          details: {
            sourceTopics,
            topicMappings: resolvedTopicMappings,
            ...semanticDetails,
          },
        });
      }
      const importDetails: Record<string, unknown> = {
        ...semanticDetails,
      };
      if (resolvedTopicMappings.length > 0) importDetails.topicMappings = resolvedTopicMappings;
      steps.push({
        routeGroupId: routeGroup.id,
        routeGroupName: routeGroup.name,
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetConnectionId: target.targetConnectionId,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId,
        targetFolderPath: target.targetFolderPath,
        kind: 'import',
        documentId: doc.identifier,
        documentName: doc.name,
        warnings: compatibilityWarnings.length > 0 ? compatibilityWarnings : undefined,
        notices: [...cleanupStepNotices, ...compatibilityNotices].length > 0 ? [...cleanupStepNotices, ...compatibilityNotices] : undefined,
	        blocked: queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || topicBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
	        error: queryViewBlockers.length > 0
	          ? 'Dashboard import is blocked until query-view mappings are resolved.'
            : fieldBlockers.length > 0 ? 'Dashboard import is blocked until field dependencies are resolved.'
	          : relationshipBlockers.length > 0 ? 'Dashboard import is blocked until relationship mappings are resolved.'
	          : topicBlockers.length > 0 ? 'Dashboard import is blocked until topic mappings are resolved.'
	            : blockedSemanticPatchMessages.length > 0 ? 'Dashboard import is blocked until semantic code decisions are refreshed.' : undefined,
        details: Object.keys(importDetails).length > 0 ? importDetails : undefined,
      });
      steps.push({
        routeGroupId: routeGroup.id,
        routeGroupName: routeGroup.name,
        targetId: target.id,
        destinationId: destination.id,
        destinationLabel: destination.label,
        targetConnectionId: target.targetConnectionId,
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
  }

  if (input.deleteSourceOnSuccess) {
    for (const doc of selected) {
      steps.push({
        destinationId: source.id,
        destinationLabel: source.label,
        kind: 'source_delete',
        documentId: doc.identifier,
        documentName: doc.name,
      });
    }
  }

  return {
    sourceId: input.sourceId,
    sourceLabel: source.label,
    sourceConnectionId: input.sourceConnectionId?.trim(),
    destinationIds: [...new Set(targets.map((target) => target.destinationInstanceId))],
    targets,
    routeGroups,
    documentIds: sourceDocumentIds,
    emptyFirst: input.emptyFirst,
    replaceSameNamed,
    deleteSourceOnSuccess: input.deleteSourceOnSuccess === true,
    sourceFolderId,
    sourceFolderPath,
    sourceAllFolders,
    steps,
  };
}

function validationTargetLabel(target: MigrationTarget): string {
  return target.targetModelName || target.targetModelId || target.id;
}

function artifactResultFromPatch(
  patch: MigrationSemanticPatch,
  status: DashboardPatchValidationStatus,
  messages: string[] = [],
): DashboardPatchValidationArtifact {
  return {
    id: patch.id,
    artifactType: patch.artifactType,
    sourceName: patch.sourceName,
    targetFileName: patch.targetFileName,
    status,
    messages: messages.map(redactSensitiveText),
  };
}

function targetPatchValidationKey(target: MigrationTarget): string {
  return `${target.destinationInstanceId}:${target.targetModelId}`;
}

function collectSemanticPatchValidationTargets(input: DashboardMigrationJobInput): MigrationTarget[] {
  const byKey = new Map<string, MigrationTarget>();
  for (const group of normalizeRouteGroups(input)) {
    for (const target of group.targets) {
      const semanticPatches = normalizeSemanticPatches(target.semanticPatches);
      if (semanticPatches.length === 0) continue;
      const key = targetPatchValidationKey(target);
      const existing = byKey.get(key);
      byKey.set(key, {
        ...(existing || target),
        semanticPatches: [
          ...(existing?.semanticPatches || []),
          ...semanticPatches,
        ],
      });
    }
  }
  return [...byKey.values()].map((target) => ({
    ...target,
    semanticPatches: [...new Map((target.semanticPatches || []).map((patch) => [patch.id, patch])).values()],
  }));
}

function fieldNameFromPatch(patch: MigrationSemanticPatch): string {
  return (patch.sourceName || patch.id).split('.').pop() || patch.sourceName || patch.id;
}

function structuralPatchMessages(patch: MigrationSemanticPatch): string[] {
  if (patch.resolution === 'keep_target') return [];
  const messages: string[] = [];
  const yaml = patch.acceptedYaml?.trim() || '';
  if (!yaml) messages.push('Accepted YAML is empty.');
  if (patch.status === 'blocked' || patch.safetyCategory === 'blocked') messages.push('Patch is still marked blocked in Step 4.');
  if (patch.destructive && !patch.confirmedDestructive) messages.push('Destructive patch must be confirmed before validation or run.');
  if (!yaml) return messages;
  if (/\t/.test(yaml)) messages.push('YAML contains tab indentation; use spaces before running.');
  if (patch.artifactType === 'field') {
    const fieldName = fieldNameFromPatch(patch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!/^\s*(dimensions|measures)\s*:/m.test(yaml)) {
      messages.push('Field patches must include a dimensions: or measures: section.');
    }
    if (fieldName && !new RegExp(`^\\s{2,}${fieldName}\\s*:`, 'm').test(yaml)) {
      messages.push(`Field patch does not define ${fieldNameFromPatch(patch)}.`);
    }
  } else if (patch.artifactType === 'query_view') {
    if (!/^\s*(query|sql)\s*:/m.test(yaml)) {
      messages.push('Query-view patches must include query: or sql:.');
    }
  } else if (patch.artifactType === 'topic') {
    if (!/^\s*(base_view|base_view_name|views)\s*:/m.test(yaml)) {
      messages.push('Topic patches must include base_view, base_view_name, or views.');
    }
  } else if (patch.artifactType === 'relationship') {
    if (!/join_from_view\s*:/m.test(yaml) || !/join_to_view\s*:/m.test(yaml)) {
      messages.push('Relationship patches must include join_from_view and join_to_view.');
    }
  }
  return messages;
}

function validationIssueText(issue: OmniValidationIssue): string {
  return redactSensitiveText([
    issue.yaml_path,
    issue.message,
    JSON.stringify(issue),
  ].filter(Boolean).join(' '));
}

function issueMatchesPatch(issue: OmniValidationIssue, patch: MigrationSemanticPatch): boolean {
  const text = validationIssueText(issue).toLowerCase();
  return [patch.targetFileName, patch.sourceFileName, patch.sourceName]
    .filter((value): value is string => Boolean(value))
    .some((value) => text.includes(value.toLowerCase()));
}

function summarizeValidationResults(results: DashboardPatchValidationModelResult[]): DashboardPatchValidationStatus {
  if (results.length === 0) return 'skipped';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.every((result) => result.status === 'skipped')) return 'skipped';
  return 'passed';
}

export async function validateDashboardMigrationPatches(input: DashboardMigrationJobInput): Promise<DashboardPatchValidationResult> {
  const targets = collectSemanticPatchValidationTargets(input);
  const results: DashboardPatchValidationModelResult[] = [];
  for (const target of targets) {
    const destination = requireInstance(target.destinationInstanceId);
    const client = new OmniClient(destination);
    const patches = normalizeSemanticPatches(target.semanticPatches);
    const baseResult: Omit<DashboardPatchValidationModelResult, 'mode' | 'status' | 'artifacts'> = {
      targetId: target.id,
      destinationId: destination.id,
      destinationLabel: destination.label,
      targetModelId: target.targetModelId,
      targetModelName: target.targetModelName,
    };
    if (patches.length === 0) {
      results.push({ ...baseResult, mode: 'skipped', status: 'skipped', artifacts: [] });
      continue;
    }

    let targetModelRecord = (await client.listModels({ modelId: target.targetModelId, include: 'git' }).catch(() => []))
      .find((model) => model.id === target.targetModelId);
    if (!targetModelRecord) {
      targetModelRecord = (await client.listModels('SHARED').catch(() => []))
        .find((model) => model.id === target.targetModelId);
    }

    if (targetModelRecord?.pullRequestRequired || targetModelRecord?.gitProtected) {
      results.push({
        ...baseResult,
        mode: 'skipped',
        status: 'skipped',
        artifacts: patches.map((patch) => artifactResultFromPatch(patch, 'skipped', [
          `${validationTargetLabel(target)} requires pull-request or protected-branch changes; OmniKit will validate at run/handoff time.`,
        ])),
      });
      continue;
    }

    if (!targetModelRecord?.gitConfigured) {
      const artifacts = patches.map((patch) => {
        if (patch.resolution === 'keep_target') return artifactResultFromPatch(patch, 'skipped', ['No YAML write selected.']);
        const messages = structuralPatchMessages(patch);
        return artifactResultFromPatch(patch, messages.length > 0 ? 'failed' : 'passed', messages.length > 0
          ? messages
          : ['Structural check passed; Omni validates fully at run.']);
      });
      results.push({
        ...baseResult,
        mode: 'structural',
        status: artifacts.some((artifact) => artifact.status === 'failed') ? 'failed' : artifacts.every((artifact) => artifact.status === 'skipped') ? 'skipped' : 'passed',
        artifacts,
      });
      continue;
    }

    const branchName = `omnikit-validate-${randomUUID().slice(0, 8)}`;
    let branch: OmniModelBranchResult | undefined;
    let cleanupError = '';
    try {
      const structuralFailures = patches
        .map((patch) => ({ patch, messages: structuralPatchMessages(patch) }))
        .filter((row) => row.patch.resolution !== 'keep_target' && row.messages.length > 0);
      if (structuralFailures.length > 0) {
        results.push({
          ...baseResult,
          mode: 'structural',
          status: 'failed',
          branchName,
          artifacts: patches.map((patch) => {
            const failure = structuralFailures.find((row) => row.patch.id === patch.id);
            if (patch.resolution === 'keep_target') return artifactResultFromPatch(patch, 'skipped', ['No YAML write selected.']);
            return artifactResultFromPatch(patch, failure ? 'failed' : 'passed', failure?.messages || ['Structural check passed.']);
          }),
        });
        continue;
      }

      if (!target.targetConnectionId) throw new Error(`Cannot validate ${validationTargetLabel(target)} because the target connection is missing.`);
      branch = await client.createModelBranch({
        connectionId: target.targetConnectionId,
        baseModelId: target.targetModelId,
        branchName,
      });
      const files = patches
        .filter((patch) => patch.resolution !== 'keep_target' && patch.acceptedYaml?.trim())
        .map((patch) => ({
          fileName: patch.targetFileName,
          yaml: patch.acceptedYaml as string,
          previousChecksum: patch.previousChecksum,
        }));
      await client.updateModelYamlFiles({
        modelId: target.targetModelId,
        branchId: branch.id,
        files,
        commitMessage: 'Validate Dashboard Migrator dependency patches',
      });
      const issues = await client.validateModel(target.targetModelId, branch.id);
      const blockingIssues = issues.filter((issue) => issue.is_warning !== true);
      const artifacts = patches.map((patch) => {
        if (patch.resolution === 'keep_target') return artifactResultFromPatch(patch, 'skipped', ['No YAML write selected.']);
        const patchIssues = blockingIssues.filter((issue) => issueMatchesPatch(issue, patch));
        return artifactResultFromPatch(
          patch,
          patchIssues.length > 0 ? 'failed' : 'passed',
          patchIssues.length > 0 ? patchIssues.map(validationIssueText) : ['Omni validation passed on scratch branch.'],
        );
      });
      const unmatchedIssues = blockingIssues.filter((issue) => !patches.some((patch) => issueMatchesPatch(issue, patch)));
      results.push({
        ...baseResult,
        mode: 'branch',
        status: blockingIssues.length > 0 ? 'failed' : 'passed',
        branchName,
        artifacts,
        ...(unmatchedIssues.length > 0 ? { error: unmatchedIssues.map(validationIssueText).join(' ') } : {}),
      });
    } catch (error) {
      results.push({
        ...baseResult,
        mode: branch ? 'branch' : 'structural',
        status: 'failed',
        branchName,
        artifacts: patches.map((patch) => artifactResultFromPatch(patch, patch.resolution === 'keep_target' ? 'skipped' : 'failed', [
          error instanceof Error ? error.message : String(error),
        ])),
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      if (branch?.id) {
        try {
          await client.deleteModelBranch(branch.id);
        } catch (error) {
          cleanupError = redactSensitiveText(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (cleanupError) {
      const last = results[results.length - 1];
      if (last && last.targetId === target.id && last.targetModelId === target.targetModelId) {
        last.status = 'failed';
        last.cleanupError = cleanupError;
        last.error = [last.error, `Scratch branch cleanup failed: ${cleanupError}`].filter(Boolean).join(' ');
      }
    }
  }
  return {
    status: summarizeValidationResults(results),
    results,
  };
}

export async function createMigrationJob(input: DashboardMigrationJobInput): Promise<MigrationJob> {
  const source = requireInstance(input.sourceId);
  const plan = await buildMigrationPlan(input);
  const blockedStep = plan.steps.find((step) => step.blocked || step.error);
  if (blockedStep) {
    throw new Error(blockedStep.error || 'Migration plan has unresolved blockers.');
  }
  const jobId = randomUUID();
  const items = plan.steps.map((step) => createItem(jobId, requireInstance(step.destinationId), step));
  const job: MigrationJob = {
    id: jobId,
    sourceId: input.sourceId,
    sourceLabel: source.label,
    sourceConnectionId: plan.sourceConnectionId,
    destinationIds: plan.destinationIds,
    targets: plan.targets,
    routeGroups: plan.routeGroups,
    documentIds: plan.documentIds,
    emptyFirst: input.emptyFirst,
    replaceSameNamed: input.replaceSameNamed !== false,
    deleteSourceOnSuccess: input.deleteSourceOnSuccess === true,
    sourceFolderId: plan.sourceFolderId,
    sourceFolderPath: plan.sourceFolderPath,
    sourceAllFolders: plan.sourceAllFolders,
    postMigrationActions: input.postMigrationActions.map(sanitizePostMigrationAction),
    status: 'pending',
    parentJobId: input.parentJobId,
    createdAt: Date.now(),
    details: {
      operationMode: 'copy_import',
      sourceConnectionId: plan.sourceConnectionId,
      sourceAllFolders: plan.sourceAllFolders === true,
      routeGroupCount: plan.routeGroups?.length || 0,
      deleteSourceOnSuccess: input.deleteSourceOnSuccess === true,
    },
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
    deleteSourceOnSuccess: false,
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

function retryTargetKey(target: Pick<MigrationTarget, 'destinationInstanceId' | 'targetModelId'>): string {
  return `${target.destinationInstanceId}:${target.targetModelId || ''}`;
}

function retryItemTargetKey(item: MigrationJobItem): string {
  return `${item.destinationId}:${item.targetModelId || ''}`;
}

function isDashboardPrepKind(kind: JobItemKind): boolean {
  return kind === 'field_prepare'
    || kind === 'query_view_prepare'
    || kind === 'relationship_prepare'
    || kind === 'topic_prepare';
}

function isDashboardRetryItem(item: MigrationJobItem, destinationId?: string): boolean {
  if (destinationId && item.destinationId !== destinationId) return false;
  if (item.status === 'failed') {
    return item.kind === 'import' || item.kind === 'export' || isDashboardPrepKind(item.kind);
  }
  if (item.status !== 'skipped' || item.kind !== 'import') return false;
  return /preparation (failed|skipped).*dependent (step|import) skipped/i.test(item.error || '');
}

function scopeDashboardRetryInput(
  parent: MigrationJob,
  retryItems: MigrationJobItem[],
  input: DashboardMigrationJobInput,
): DashboardMigrationJobInput {
  if (input.sourceId !== parent.sourceId) {
    throw new Error('Retry input must use the same source instance as the failed migration job.');
  }
  if ((input.sourceConnectionId || '') !== (parent.sourceConnectionId || '')) {
    throw new Error('Retry input must use the same source connection as the failed migration job.');
  }

  const documentIds = new Set(retryItems.map((item) => item.documentId).filter((value): value is string => Boolean(value)));
  const targetIds = new Set(retryItems.map((item) => item.targetId).filter((value): value is string => Boolean(value)));
  const targetKeys = new Set(retryItems.map(retryItemTargetKey));
  const routeScopes = new Map<string, { documentIds: Set<string>; targetIds: Set<string>; targetKeys: Set<string> }>();

  for (const item of retryItems) {
    if (!item.routeGroupId || !item.documentId) continue;
    const scope = routeScopes.get(item.routeGroupId) || {
      documentIds: new Set<string>(),
      targetIds: new Set<string>(),
      targetKeys: new Set<string>(),
    };
    scope.documentIds.add(item.documentId);
    if (item.targetId) scope.targetIds.add(item.targetId);
    scope.targetKeys.add(retryItemTargetKey(item));
    routeScopes.set(item.routeGroupId, scope);
  }

  const scopedDocumentIds = input.documentIds.filter((documentId) => documentIds.has(documentId));
  if (scopedDocumentIds.length === 0) {
    throw new Error('Retry input no longer contains the failed dashboard selection.');
  }

  if (input.routeGroups && input.routeGroups.length > 0 && routeScopes.size > 0) {
    const routeGroups = input.routeGroups
      .map((group) => {
        const scope = routeScopes.get(group.id);
        if (!scope) return null;
        const groupDocumentIds = group.documentIds.filter((documentId) => scope.documentIds.has(documentId));
        const groupTargets = group.targets.filter((target) => (
          scope.targetIds.has(target.id) || scope.targetKeys.has(retryTargetKey(target))
        ));
        if (groupDocumentIds.length === 0 || groupTargets.length === 0) return null;
        return {
          ...group,
          documentIds: groupDocumentIds,
          targets: groupTargets,
        };
      })
      .filter((group): group is MigrationRouteGroup => Boolean(group));
    if (routeGroups.length === 0) {
      throw new Error('Retry input no longer contains the failed route and destination selection.');
    }
    return {
      ...input,
      targets: undefined,
      routeGroups,
      documentIds: [...new Set(routeGroups.flatMap((group) => group.documentIds))],
      emptyFirst: false,
      deleteSourceOnSuccess: false,
      postMigrationActions: [],
      parentJobId: parent.id,
    };
  }

  const targets = (input.targets || []).filter((target) => targetIds.has(target.id) || targetKeys.has(retryTargetKey(target)));
  if (targets.length === 0) {
    throw new Error('Retry input no longer contains the failed destination selection.');
  }
  return {
    ...input,
    targets,
    routeGroups: undefined,
    documentIds: scopedDocumentIds,
    emptyFirst: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    parentJobId: parent.id,
  };
}

export async function retryMigrationJob(id: string, options: { destinationId?: string; retryInput?: DashboardMigrationJobInput } = {}): Promise<MigrationJob> {
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
  const failedImports = parent.items.filter((item) => isDashboardRetryItem(item, options.destinationId));
  if (options.retryInput) {
    if (failedImports.length === 0) throw new Error('No failed prep, export, or import items to retry.');
    return createMigrationJob(scopeDashboardRetryInput(parent, failedImports, options.retryInput));
  }
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
  const routeGroupsById = new Map<string, {
    id: string;
    name: string;
    documentIds: Set<string>;
    targetsById: Map<string, MigrationTarget>;
  }>();
  for (const item of failedImports) {
    if (!item.routeGroupId || !item.documentId) continue;
    const route = parent.routeGroups?.find((group) => group.id === item.routeGroupId);
    const target = route?.targets.find((candidate) => candidate.id === item.targetId)
      || parent.targets?.find((candidate) => candidate.id === item.targetId);
    if (!target?.targetModelId) continue;
    const group = routeGroupsById.get(item.routeGroupId) || {
      id: item.routeGroupId,
      name: item.routeGroupName || route?.name || item.routeGroupId,
      documentIds: new Set<string>(),
      targetsById: new Map<string, MigrationTarget>(),
    };
    group.documentIds.add(item.documentId);
    group.targetsById.set(target.id, target);
    routeGroupsById.set(item.routeGroupId, group);
  }
  const routeGroups = [...routeGroupsById.values()].map((group) => ({
    id: group.id,
    name: group.name,
    documentIds: [...group.documentIds],
    targets: [...group.targetsById.values()],
  }));
  return createMigrationJob({
    sourceId: parent.sourceId,
    sourceConnectionId: parent.sourceConnectionId,
    targets: routeGroups.length > 0 ? undefined : targets,
    routeGroups: routeGroups.length > 0 ? routeGroups : undefined,
    documentIds,
    emptyFirst: false,
    replaceSameNamed: parent.replaceSameNamed,
    sourceFolderId: parent.sourceFolderId,
    sourceFolderPath: parent.sourceFolderPath,
    sourceAllFolders: parent.sourceAllFolders,
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
      'field_prepare',
      'query_view_prepare',
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
            const docsAfterImport = await listDocumentsForFolder(targetClient, item.targetFolderId, item.targetFolderPath);
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
  const sourceDocumentDetails = new Map<string, { baseModelId?: string; topicNames?: string[]; topicIds?: string[] }>();
  const sourceLabels = new Map<string, { color?: string | null; description?: string | null }>();
  const destinationClientCache = new Map<string, OmniClient>();
  const importedByDestinationAndSource = new Map<string, { identifier: string; documentId: string }>();
  const destinationLabelCache = new Map<string, Set<string>>();
  const preparedTopicKeys = new Set<string>();
  const preparedQueryViewKeys = new Set<string>();
  const preparedRelationshipKeys = new Set<string>();
  const preparedFieldKeys = new Set<string>();
  const selectedSourceDocumentKeys = new Set(job.documentIds.filter(Boolean));
  const sourceTopicCatalogCache = new Map<string, Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>>>();
	  const targetTopicCatalogCache = new Map<string, Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>>>();
  const sourceQueryViewCatalogCache = new Map<string, Promise<OmniModelQueryViewRecord[]>>();
  const targetQueryViewCatalogCache = new Map<string, Promise<OmniModelQueryViewRecord[]>>();

  try {
    const sourceFolderId = job.sourceAllFolders ? undefined : job.sourceFolderId || source.defaultFolderId;
    const sourceFolderPath = job.sourceAllFolders ? undefined : job.sourceFolderPath || source.defaultFolderPath;
    const docs = await listDocumentsForFolder(
      sourceClient,
      sourceFolderId,
      sourceFolderPath,
      true,
    );
    for (const doc of docs) {
      sourceMeta.set(doc.identifier, {
        description: doc.description ?? null,
        labels: doc.labels ?? [],
      });
      sourceDocumentDetails.set(doc.identifier, {
        baseModelId: doc.baseModelId,
        topicNames: doc.topicNames,
        topicIds: doc.topicIds,
      });
      if (selectedSourceDocumentKeys.has(doc.identifier) || selectedSourceDocumentKeys.has(doc.id)) {
        selectedSourceDocumentKeys.add(doc.identifier);
        selectedSourceDocumentKeys.add(doc.id);
      }
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

  function targetForItem(item: MigrationJobItem): MigrationTarget | undefined {
    return job.targets?.find((target) => target.id === item.targetId);
  }

  function detailTopicMappings(details: Record<string, unknown> | undefined): MigrationTopicMapping[] {
    const raw = details?.topicMappings;
    if (!Array.isArray(raw)) return [];
    return normalizeTopicMappings(raw as MigrationTopicMapping[]);
  }

  function detailQueryViewMappings(details: Record<string, unknown> | undefined): MigrationQueryViewMapping[] {
    const raw = details?.queryViewMappings;
    if (!Array.isArray(raw)) return [];
    return normalizeQueryViewMappings(raw as MigrationQueryViewMapping[]);
  }

  function detailFieldMappings(details: Record<string, unknown> | undefined): MigrationFieldMapping[] {
    const raw = details?.fieldMappings;
    if (!Array.isArray(raw)) return [];
    return normalizeFieldMappings(raw as MigrationFieldMapping[]);
  }

  function detailSemanticPatches(details: Record<string, unknown> | undefined): MigrationSemanticPatch[] {
    const raw = details?.semanticPatches;
    if (!Array.isArray(raw)) return [];
    return normalizeSemanticPatches(raw as MigrationSemanticPatch[]);
  }

  function sourceTopicCatalog(modelId: string) {
    const cached = sourceTopicCatalogCache.get(modelId);
    if (cached) return cached;
    const next = sourceClient.listModelTopics(modelId, { includeYaml: true, includeChecksums: true });
    sourceTopicCatalogCache.set(modelId, next);
    return next;
  }

	  function targetTopicCatalog(destination: SavedInstance, client: OmniClient, targetModelId: string) {
	    const key = `${destination.id}:${targetModelId}`;
	    const cached = targetTopicCatalogCache.get(key);
	    if (cached) return cached;
	    const next = client.listModelTopics(targetModelId, { includeYaml: true, includeChecksums: true });
	    targetTopicCatalogCache.set(key, next);
	    return next;
	  }

  function sourceQueryViewCatalog(modelId: string) {
    const cached = sourceQueryViewCatalogCache.get(modelId);
    if (cached) return cached;
    const next = sourceClient.listModelQueryViews(modelId, { includeYaml: true, includeChecksums: true });
    sourceQueryViewCatalogCache.set(modelId, next);
    return next;
  }

  function targetQueryViewCatalog(destination: SavedInstance, client: OmniClient, targetModelId: string) {
    const key = `${destination.id}:${targetModelId}`;
    const cached = targetQueryViewCatalogCache.get(key);
    if (cached) return cached;
    const next = client.listModelQueryViews(targetModelId);
    targetQueryViewCatalogCache.set(key, next);
    return next;
  }

  function queryViewFromCatalogByValue(queryViews: OmniModelQueryViewRecord[], value?: string): OmniModelQueryViewRecord | undefined {
    const key = queryViewKey(value);
    if (!key) return undefined;
    return queryViews.find((queryView) => queryViewKeys(queryView).includes(key));
  }

  function sourceQueryViewForMapping(
    queryViews: OmniModelQueryViewRecord[],
    mapping: MigrationQueryViewMapping,
  ): OmniModelQueryViewRecord | undefined {
    const sourceKeys = [
      mapping.sourceQueryViewName,
      mapping.sourceFileName,
      mapping.sourceFileName ? queryViewNameFromFilePath(mapping.sourceFileName) : undefined,
    ].map(queryViewKey).filter((value): value is string => Boolean(value));
    return queryViews.find((queryView) => queryViewKeys(queryView).some((key) => sourceKeys.includes(key)));
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
      if ((item.kind === 'field_prepare' || item.kind === 'query_view_prepare' || item.kind === 'relationship_prepare' || item.kind === 'topic_prepare' || item.kind === 'import' || item.kind === 'metadata' || item.kind === 'source_delete') && item.status === 'pending') {
        markAndPersistItem(item, 'skipped', { error: reason });
      }
    }
  }

  function skipDestinationDocumentItems(failedItem: MigrationJobItem, reason: string): void {
    if (!failedItem.documentId) return;
    for (const item of job.items) {
      if (item.status !== 'pending') continue;
      if (item.documentId !== failedItem.documentId) continue;
      if (item.targetId !== failedItem.targetId || item.destinationId !== failedItem.destinationId) continue;
      if (item.kind !== 'field_prepare' && item.kind !== 'query_view_prepare' && item.kind !== 'relationship_prepare' && item.kind !== 'topic_prepare' && item.kind !== 'import' && item.kind !== 'metadata') continue;
      markAndPersistItem(item, 'skipped', { error: reason });
      if (item.kind === 'import') releaseExportConsumer(item.documentId);
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

  async function prepareDashboardFieldsForImport(
    item: MigrationJobItem,
    destination: SavedInstance,
    destinationClient: OmniClient,
    payload: Record<string, unknown>,
    targetModelId: string,
  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
    const mappings = detailFieldMappings(item.details);
    const target = targetForItem(item);
    const semanticPatches = [...detailSemanticPatches(item.details), ...(target?.semanticPatches || [])];
    const warnings: string[] = [];
    const createdFields: string[] = [];
    const mappedFields: string[] = [];
    const ignoredFields: string[] = [];
    if (mappings.length === 0) {
      return { warnings, details: { fieldMappings: [] } };
    }

    const sourceDoc = item.documentId ? sourceDocumentDetails.get(item.documentId) : undefined;
    const sourceModelId = sourceDoc?.baseModelId || extractDashboardModelId(payload);
    if (!sourceModelId) {
      throw new Error('Cannot prepare fields because the source model ID could not be detected.');
    }
    const sourceYaml = await sourceClient.getModelYaml(sourceModelId, { includeChecksums: true });
    const targetYaml = await destinationClient.getModelYaml(targetModelId, { includeChecksums: true });
    const sourceDefinitions = fieldDefinitionIndex(sourceYaml.files);
    const targetDefinitions = fieldDefinitionIndex(targetYaml.files);
    const writtenFiles = new Map<string, { yaml: string; previousChecksum?: string }>();

    for (const mapping of mappings) {
      const sourceFieldRef = normalizeFieldRef(mapping.sourceFieldRef);
      if (!sourceFieldRef) continue;
      if (mapping.action === 'ignore') {
        ignoredFields.push(sourceFieldRef);
        warnings.push(`Field ${sourceFieldRef} was ignored by user choice; dependent dashboard tiles may need manual repair after import.`);
        continue;
      }

      if (targetDefinitions.has(sourceFieldRef.toLowerCase())) {
        mappedFields.push(sourceFieldRef);
        continue;
      }

      const sourceDefinition = sourceDefinitions.get(sourceFieldRef.toLowerCase());
      const sourceParts = fieldRefParts(sourceFieldRef);
      const targetFileName = mapping.targetFileName || sourceDefinition?.sourceFileName || `${sourceParts.viewName}.view`;
      const targetFieldKey = `${destination.id}:${targetModelId}:${targetFileName}:${sourceFieldRef.toLowerCase()}`;
      if (preparedFieldKeys.has(targetFieldKey)) {
        mappedFields.push(sourceFieldRef);
        continue;
      }

      const acceptedPatch = activeSemanticPatchFor(semanticPatches, 'field', targetFileName, sourceFieldRef);
      const acceptedWrite = semanticPatchWriteInput(acceptedPatch, targetYaml.checksums?.[targetFileName]);
      if (acceptedWrite) {
        writtenFiles.set(targetFileName, {
          yaml: acceptedWrite.yaml,
          previousChecksum: acceptedWrite.previousChecksum,
        });
        preparedFieldKeys.add(targetFieldKey);
        if (mapping.action === 'map_existing') mappedFields.push(`${sourceFieldRef}->${mapping.targetFieldRef}`);
        else createdFields.push(sourceFieldRef);
        continue;
      }

      const fieldKind = sourceDefinition?.fieldKind || 'dimension';
      const fieldYaml = mapping.action === 'map_existing'
        ? fieldDefinitionBlockForAlias({
          sourceFieldRef,
          targetFieldRef: mapping.targetFieldRef || '',
          sourceDefinition,
        })
        : sourceDefinition?.sourceYaml;
      if (mapping.action === 'map_existing' && !mapping.targetFieldRef) {
        throw new Error(`Cannot map field ${sourceFieldRef} because no target field was selected.`);
      }
      if (!fieldYaml) {
        throw new Error(`Cannot create field ${sourceFieldRef} because source YAML was not found.`);
      }

      const currentFile = writtenFiles.get(targetFileName)?.yaml ?? targetYaml.files[targetFileName];
      const nextYaml = mergeFieldDefinitionIntoViewYaml({
        existingYaml: currentFile,
        fieldKind,
        fieldYaml,
      });
      writtenFiles.set(targetFileName, {
        yaml: nextYaml,
        previousChecksum: targetYaml.checksums?.[targetFileName],
      });
      preparedFieldKeys.add(targetFieldKey);
      if (mapping.action === 'map_existing') mappedFields.push(`${sourceFieldRef}->${mapping.targetFieldRef}`);
      else createdFields.push(sourceFieldRef);
    }

    for (const [fileName, file] of writtenFiles) {
      await destinationClient.updateModelYamlFile({
        modelId: targetModelId,
        fileName,
        yaml: file.yaml,
        previousChecksum: file.previousChecksum,
        commitMessage: `OmniKit Dashboard Migrator prepare ${createdFields.length + mappedFields.length} field${createdFields.length + mappedFields.length === 1 ? '' : 's'}`,
      });
    }

    return {
      warnings,
      details: {
        fieldMappings: mappings,
        createdFields,
        mappedFields,
        ignoredFields,
      },
    };
  }

	  async function prepareDashboardTopicsForImport(
    item: MigrationJobItem,
    destination: SavedInstance,
    destinationClient: OmniClient,
    payload: Record<string, unknown>,
    targetModelId: string,
  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
    const sourceDoc = item.documentId ? sourceDocumentDetails.get(item.documentId) : undefined;
    const sourceTopics = collectTopicRefs(payload, sourceDoc);
    const target = targetForItem(item);
    const configuredMappings = detailTopicMappings(item.details).length > 0
      ? detailTopicMappings(item.details)
      : target?.topicMappings || [];
    const semanticPatches = [...detailSemanticPatches(item.details), ...(target?.semanticPatches || [])];
    const targetTopics = await targetTopicCatalog(destination, destinationClient, targetModelId);
    const warnings: string[] = [];
    const appliedMappings: MigrationTopicMapping[] = [];
    const createdTopics: string[] = [];
    const mappedTopics: string[] = [];

    for (const topic of sourceTopics) {
      const explicitMapping = mappingForSourceTopic(topic, configuredMappings);
      const exact = exactTargetTopic(topic, targetTopics);
      const mapping = explicitMapping || (exact ? {
        sourceTopicName: topic.name,
        sourceTopicId: topic.id,
        action: 'map_existing' as const,
        targetTopicName: exact.name,
        targetTopicLabel: exact.label,
      } : undefined);
      if (!mapping) {
        throw new Error(`Topic ${topic.name} is used by ${item.documentName || item.documentId} but is not mapped for ${destination.label}.`);
      }
	      if (mapping.action === 'map_existing') {
	        if (!targetTopicExists(targetTopics, mapping.targetTopicName)) {
	          throw new Error(`Mapped target topic ${mapping.targetTopicName} was not found in ${targetModelId}.`);
	        }
	        const sourceModelId = sourceDoc?.baseModelId || extractDashboardModelId(payload);
	        if (sourceModelId) {
	          const sourceTopicRows = await sourceTopicCatalog(sourceModelId);
	          const sourceTopicYaml = findSourceTopicYaml(sourceTopicRows, topic);
	          const targetTopicYaml = findSourceTopicYaml(targetTopics, { name: mapping.targetTopicName, id: mapping.targetTopicName });
	          const targetFileName = targetTopicYaml?.fileName || `${mapping.targetTopicName}.topic`;
	          const acceptedPatch = activeSemanticPatchFor(
	            semanticPatches,
	            'topic',
	            targetFileName,
	            mapping.sourceTopicName || topic.name,
	          );
	          const acceptedWrite = semanticPatchWriteInput(acceptedPatch, targetTopicYaml?.checksum);
	          if (acceptedWrite) {
	            const prepareKey = `${destination.id}:${targetModelId}:${targetFileName}`;
	            if (!preparedTopicKeys.has(prepareKey)) {
	              await destinationClient.updateModelYamlFile({
	                modelId: targetModelId,
	                fileName: targetFileName,
	                yaml: acceptedWrite.yaml,
	                previousChecksum: acceptedWrite.previousChecksum,
	                commitMessage: `OmniKit Dashboard Migrator update topic ${mapping.targetTopicName}`,
	              });
	              preparedTopicKeys.add(prepareKey);
	            } else {
	              warnings.push(`Topic ${mapping.targetTopicName} was already prepared for this job.`);
	            }
	            mappedTopics.push(`${topic.name}->${mapping.targetTopicName}`);
	            appliedMappings.push(mapping);
	            continue;
	          }
	          const compatibilityBlockers = mappedTopicCompatibilityBlockers({
	            sourceTopicName: sourceTopicYaml?.name || topic.name,
	            targetTopicName: targetTopicYaml?.name || mapping.targetTopicName,
	            sourceYaml: sourceTopicYaml?.yaml,
	            targetYaml: targetTopicYaml?.yaml,
	          });
	          if (compatibilityBlockers.length > 0) throw new Error(compatibilityBlockers.join(' '));
	        }
	        mappedTopics.push(`${topic.name}->${mapping.targetTopicName}`);
	        appliedMappings.push(mapping);
	        continue;
	      }

      if (targetTopicExists(targetTopics, mapping.targetTopicName)) {
        throw new Error(`Target topic ${mapping.targetTopicName} already exists. Use the existing topic or enter a new topic name.`);
      }
      const sourceModelId = sourceDoc?.baseModelId || extractDashboardModelId(payload);
      if (!sourceModelId) {
        throw new Error(`Cannot create target topic ${mapping.targetTopicName} because the source model ID could not be detected.`);
      }
      const sourceTopicRows = await sourceTopicCatalog(sourceModelId);
      const sourceTopicYaml = findSourceTopicYaml(sourceTopicRows, topic);
      if (!sourceTopicYaml) {
        throw new Error(`Source topic YAML was not found for ${topic.name} in model ${sourceModelId}.`);
      }
      const prepareKey = `${destination.id}:${targetModelId}:${mapping.targetTopicName}`;
      if (!preparedTopicKeys.has(prepareKey)) {
        const acceptedPatch = activeSemanticPatchFor(
          semanticPatches,
          'topic',
          `${mapping.targetTopicName}.topic`,
          mapping.sourceTopicName || topic.name,
        );
	        const acceptedWrite = semanticPatchWriteInput(acceptedPatch);
	        await destinationClient.updateModelYamlFile({
	          modelId: targetModelId,
	          fileName: `${mapping.targetTopicName}.topic`,
	          yaml: acceptedWrite?.yaml || sourceTopicYaml.yaml,
	          previousChecksum: acceptedWrite?.previousChecksum,
	          commitMessage: `OmniKit Dashboard Migrator create topic ${mapping.targetTopicName}`,
	        });
        preparedTopicKeys.add(prepareKey);
        createdTopics.push(mapping.targetTopicName);
      } else {
        warnings.push(`Topic ${mapping.targetTopicName} was already prepared for this job.`);
      }
      appliedMappings.push(mapping);
    }

    return {
      warnings,
      details: {
        sourceTopics,
        topicMappings: appliedMappings,
        mappedTopics,
        createdTopics,
      },
	    };
	  }

	  async function prepareDashboardRelationshipsForImport(
	    item: MigrationJobItem,
	    destination: SavedInstance,
	    destinationClient: OmniClient,
	    targetModelId: string,
	  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
	    const requestedEdges = detailRelationshipEdges(item.details);
	    const target = targetForItem(item);
	    const semanticPatches = [...detailSemanticPatches(item.details), ...(target?.semanticPatches || [])];
	    if (requestedEdges.length === 0) {
	      return { warnings: [], details: { relationshipEdges: [] } };
	    }
	    const sourceDoc = item.documentId ? sourceDocumentDetails.get(item.documentId) : undefined;
	    const sourceModelId = detailString(item.details, 'sourceModelId') || sourceDoc?.baseModelId;
	    if (!sourceModelId) {
	      throw new Error('Cannot prepare relationships because the source model ID could not be detected.');
	    }

	    const sourceYaml = await sourceClient.getModelYaml(sourceModelId, { includeChecksums: true });
	    const targetYaml = await destinationClient.getModelYaml(targetModelId, { includeChecksums: true });
	    const sourceEdgesByKey = new Map(extractRelationshipEdges(sourceYaml.files.relationships).map((edge) => [relationshipEdgeKey(edge), edge]));
	    const targetEdgesByKey = new Map(extractRelationshipEdges(targetYaml.files.relationships).map((edge) => [relationshipEdgeKey(edge), edge]));
	    const warnings: string[] = [];
	    const edgesToWrite: RelationshipEdgeDetail[] = [];
	    const existingRelationshipEdges: RelationshipEdgeReference[] = [];
	    const acceptedPatch = activeSemanticPatchFor(semanticPatches, 'relationship', 'relationships', 'relationships');
	    const acceptedWrite = semanticPatchWriteInput(acceptedPatch, targetYaml.checksums?.relationships);
	    if (acceptedWrite) {
	      await destinationClient.updateModelYamlFile({
	        modelId: targetModelId,
	        fileName: 'relationships',
	        yaml: acceptedWrite.yaml,
	        previousChecksum: acceptedWrite.previousChecksum,
	        commitMessage: `OmniKit Dashboard Migrator update relationships for ${requestedEdges.length} edge${requestedEdges.length === 1 ? '' : 's'}`,
	      });
	      for (const edge of requestedEdges) {
	        preparedRelationshipKeys.add(`${destination.id}:${targetModelId}:${relationshipEdgeKey(edge)}`);
	      }
	      return {
	        warnings,
	        details: {
	          relationshipEdges: requestedEdges,
	          addedRelationshipEdges: requestedEdges,
	          existingRelationshipEdges,
	        },
	      };
	    }

	    for (const requestedEdge of requestedEdges) {
	      const key = relationshipEdgeKey(requestedEdge);
	      const sourceEdge = sourceEdgesByKey.get(key);
	      if (!sourceEdge) {
	        warnings.push(`Source relationship ${relationshipEdgeSummary(requestedEdge)} was no longer found; it was not written to the target model.`);
	        continue;
	      }
	      const targetEdge = targetEdgesByKey.get(key);
	      if (targetEdge) {
	        if (relationshipEdgeYamlFingerprint(targetEdge) !== relationshipEdgeYamlFingerprint(sourceEdge)) {
	          throw new Error(`Target relationship ${relationshipEdgeSummary(sourceEdge)} already exists with different YAML. Review the target relationships file before retrying.`);
	        }
	        existingRelationshipEdges.push(relationshipEdgeReference(sourceEdge));
	        continue;
	      }
	      const prepareKey = `${destination.id}:${targetModelId}:${key}`;
	      if (preparedRelationshipKeys.has(prepareKey)) {
	        existingRelationshipEdges.push(relationshipEdgeReference(sourceEdge));
	        continue;
	      }
	      edgesToWrite.push(sourceEdge);
	    }

	    if (edgesToWrite.length > 0) {
	      const nextRelationshipsYaml = mergeRelationshipYaml(targetYaml.files.relationships, edgesToWrite);
	      await destinationClient.updateModelYamlFile({
	        modelId: targetModelId,
	        fileName: 'relationships',
	        yaml: nextRelationshipsYaml,
	        previousChecksum: targetYaml.checksums?.relationships,
	        commitMessage: `OmniKit Dashboard Migrator add ${edgesToWrite.length} relationship edge${edgesToWrite.length === 1 ? '' : 's'}`,
	      });
	      for (const edge of edgesToWrite) {
	        preparedRelationshipKeys.add(`${destination.id}:${targetModelId}:${relationshipEdgeKey(edge)}`);
	      }
	    }

	    return {
	      warnings,
	      details: {
	        relationshipEdges: requestedEdges,
	        addedRelationshipEdges: edgesToWrite.map(relationshipEdgeReference),
	        existingRelationshipEdges,
	      },
	    };
	  }

	  async function prepareDashboardQueryViewsForImport(
    item: MigrationJobItem,
    destination: SavedInstance,
    destinationClient: OmniClient,
    payload: Record<string, unknown>,
    targetModelId: string,
  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
    const target = targetForItem(item);
    const configuredMappings = detailQueryViewMappings(item.details).length > 0
      ? detailQueryViewMappings(item.details)
      : target?.queryViewMappings || [];
    const semanticPatches = [...detailSemanticPatches(item.details), ...(target?.semanticPatches || [])];
    const targetQueryViews = await targetQueryViewCatalog(destination, destinationClient, targetModelId);
    const warnings: string[] = [];
	    const appliedMappings: MigrationQueryViewMapping[] = [];
	    const createdQueryViews: string[] = [];
	    const mappedQueryViews: string[] = [];
	    const updatedQueryViews: string[] = [];
	    let sourceQueryViews: OmniModelQueryViewRecord[] | undefined;

	    for (const mapping of configuredMappings) {
	      if (mapping.action === 'map_existing' || mapping.action === 'use_existing_unverified' || mapping.action === 'update_existing') {
	        const targetQueryView = queryViewFromCatalogByValue(targetQueryViews, mapping.targetQueryViewName)
	          || queryViewFromCatalogByValue(targetQueryViews, mapping.targetFileName);
	        if (!targetQueryView) {
	          throw new Error(`Mapped target query view ${mapping.targetQueryViewName} was not found in ${targetModelId}.`);
	        }
	        const appliedMapping = {
	          ...mapping,
	          targetQueryViewName: targetQueryView.name,
	          targetFileName: mapping.targetFileName || targetQueryView.fileName,
	          ...(mapping.targetQueryViewLabel || targetQueryView.label
	            ? { targetQueryViewLabel: mapping.targetQueryViewLabel || targetQueryView.label }
	            : {}),
	        };
	        if (mapping.action === 'update_existing') {
	          const sourceDoc = item.documentId ? sourceDocumentDetails.get(item.documentId) : undefined;
	          const sourceModelId = sourceDoc?.baseModelId || extractDashboardModelId(payload);
	          if (!sourceModelId) {
	            throw new Error(`Cannot update target query view ${mapping.targetQueryViewName} because the source model ID could not be detected.`);
	          }
	          sourceQueryViews ||= await sourceQueryViewCatalog(sourceModelId);
	          const sourceQueryView = sourceQueryViewForMapping(sourceQueryViews, mapping);
	          if (!sourceQueryView?.yaml) {
	            throw new Error(`Source query-view YAML was not found for ${mapping.sourceQueryViewName} in model ${sourceModelId}.`);
	          }
	          const latestTargetQueryViews = await destinationClient.listModelQueryViews(targetModelId, { includeYaml: true, includeChecksums: true });
	          const latestTargetQueryView = queryViewFromCatalogByValue(latestTargetQueryViews, targetQueryView.fileName)
	            || queryViewFromCatalogByValue(latestTargetQueryViews, targetQueryView.name);
	          if (!latestTargetQueryView) {
	            throw new Error(`Mapped target query view ${mapping.targetQueryViewName} was not found in ${targetModelId}.`);
	          }
	          const expectedFileName = mapping.targetFileName || targetQueryView.fileName;
	          if (expectedFileName && latestTargetQueryView.fileName !== expectedFileName) {
	            throw new Error(`Target query view ${mapping.targetQueryViewName} moved from ${expectedFileName} to ${latestTargetQueryView.fileName}; review the target model before retrying.`);
	          }
	          const acceptedPatch = activeSemanticPatchFor(
	            semanticPatches,
	            'query_view',
	            latestTargetQueryView.fileName,
	            mapping.sourceQueryViewName,
	          );
	          const acceptedWrite = semanticPatchWriteInput(acceptedPatch, latestTargetQueryView.checksum);
	          if (acceptedWrite) {
	            await destinationClient.updateModelYamlFile({
	              modelId: targetModelId,
	              fileName: latestTargetQueryView.fileName,
	              yaml: acceptedWrite.yaml,
	              previousChecksum: acceptedWrite.previousChecksum,
	              commitMessage: `OmniKit Dashboard Migrator update query view ${latestTargetQueryView.name}`,
	            });
	            targetQueryViewCatalogCache.delete(`${destination.id}:${targetModelId}`);
	            updatedQueryViews.push(`${mapping.sourceQueryViewName}->${latestTargetQueryView.name}`);
	            appliedMappings.push({
	              ...appliedMapping,
	              sourceFileName: mapping.sourceFileName || sourceQueryView.fileName,
	              targetFileName: latestTargetQueryView.fileName,
	              targetQueryViewName: latestTargetQueryView.name,
	            });
	            continue;
	          }
	          const sourceFields = new Set(queryViewFieldRefs(sourceQueryView).map((field) => field.toLowerCase()));
	          const targetOnlyFields = queryViewFieldRefs(latestTargetQueryView).filter((field) => !sourceFields.has(field.toLowerCase()));
	          if (targetOnlyFields.length > 0) {
	            throw new Error(`Target query view ${latestTargetQueryView.name} has fields not present in the source copy: ${formatFieldList(targetOnlyFields)}. Create a new query-view copy or manually merge the target query view before retrying.`);
	          }
	          await destinationClient.updateModelYamlFile({
	            modelId: targetModelId,
	            fileName: latestTargetQueryView.fileName,
	            yaml: sourceQueryView.yaml,
	            previousChecksum: latestTargetQueryView.checksum,
	            commitMessage: `OmniKit Dashboard Migrator update query view ${latestTargetQueryView.name}`,
	          });
	          targetQueryViewCatalogCache.delete(`${destination.id}:${targetModelId}`);
	          updatedQueryViews.push(`${mapping.sourceQueryViewName}->${latestTargetQueryView.name}`);
	          appliedMappings.push({
	            ...appliedMapping,
	            sourceFileName: mapping.sourceFileName || sourceQueryView.fileName,
	            targetFileName: latestTargetQueryView.fileName,
	            targetQueryViewName: latestTargetQueryView.name,
	          });
	          continue;
	        }
	        mappedQueryViews.push(`${mapping.sourceQueryViewName}->${targetQueryView.label || targetQueryView.name}`);
	        appliedMappings.push(appliedMapping);
	        continue;
	      }

	      const targetFileName = mapping.targetFileName || `${mapping.targetQueryViewName}.query.view`;
	      if (mapping.action === 'copy_source' && queryViewMappingRenamesSource(mapping)) {
	        throw new Error(`Cannot create target query view ${mapping.targetQueryViewName} with a different name from ${mapping.sourceQueryViewName}; dashboard and topic query-view reference rewriting is not yet supported.`);
	      }
	      if (
	        queryViewFromCatalogByValue(targetQueryViews, mapping.targetQueryViewName)
	        || queryViewFromCatalogByValue(targetQueryViews, targetFileName)
      ) {
        throw new Error(`Target query view ${mapping.targetQueryViewName} already exists. Use the existing query view or enter a new query-view name.`);
      }

      const sourceDoc = item.documentId ? sourceDocumentDetails.get(item.documentId) : undefined;
      const sourceModelId = sourceDoc?.baseModelId || extractDashboardModelId(payload);
      if (!sourceModelId) {
        throw new Error(`Cannot create target query view ${mapping.targetQueryViewName} because the source model ID could not be detected.`);
      }
      sourceQueryViews ||= await sourceQueryViewCatalog(sourceModelId);
      const sourceQueryView = sourceQueryViewForMapping(sourceQueryViews, mapping);
      if (!sourceQueryView?.yaml) {
        throw new Error(`Source query-view YAML was not found for ${mapping.sourceQueryViewName} in model ${sourceModelId}.`);
      }

      const prepareKey = `${destination.id}:${targetModelId}:${targetFileName.toLowerCase()}`;
      if (!preparedQueryViewKeys.has(prepareKey)) {
        const latestTargetQueryViews = await destinationClient.listModelQueryViews(targetModelId);
        if (
          queryViewFromCatalogByValue(latestTargetQueryViews, mapping.targetQueryViewName)
          || queryViewFromCatalogByValue(latestTargetQueryViews, targetFileName)
        ) {
          throw new Error(`Target query view ${mapping.targetQueryViewName} already exists. Use the existing query view or enter a new query-view name.`);
        }
	        const acceptedPatch = activeSemanticPatchFor(
	          semanticPatches,
	          'query_view',
	          targetFileName,
	          mapping.sourceQueryViewName,
	        );
	        const acceptedWrite = semanticPatchWriteInput(acceptedPatch);
	        await destinationClient.updateModelYamlFile({
	          modelId: targetModelId,
	          fileName: targetFileName,
	          yaml: acceptedWrite?.yaml || sourceQueryView.yaml,
	          previousChecksum: acceptedWrite?.previousChecksum,
	          commitMessage: `OmniKit Dashboard Migrator create query view ${mapping.targetQueryViewName}`,
	        });
        preparedQueryViewKeys.add(prepareKey);
        targetQueryViewCatalogCache.delete(`${destination.id}:${targetModelId}`);
        createdQueryViews.push(mapping.targetQueryViewName);
      } else {
        warnings.push(`Query view ${mapping.targetQueryViewName} was already prepared for this job.`);
      }
      appliedMappings.push({
        ...mapping,
        sourceFileName: mapping.sourceFileName || sourceQueryView.fileName,
        targetFileName,
      });
    }

    return {
      warnings,
      details: {
	        queryViewMappings: appliedMappings,
	        mappedQueryViews,
	        createdQueryViews,
	        updatedQueryViews,
	      },
	    };
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
        if (destination.id === source.id && selectedSourceDocumentKeys.has(item.documentId)) {
          markAndPersistItem(item, 'skipped', {
            error: 'Target cleanup skipped because it matched a selected source dashboard in the same Omni instance.',
          });
          return;
        }
        await destinationClient.requestDeleteDocument(item.documentId);
        markAndPersistItem(item, 'succeeded');
      } else if (item.kind === 'field_prepare') {
        if (!item.documentId) throw new Error('Field preparation item missing document id.');
        if (item.error) {
          markAndPersistItem(item, 'failed');
          skipDestinationDocumentItems(item, `Field preparation failed; dependent step skipped. ${item.error}`);
          return;
        }
        const cached = exports.get(item.documentId);
        if (!cached) {
          markAndPersistItem(item, 'skipped', { error: 'Export payload unavailable; field preparation skipped.' });
          skipDestinationDocumentItems(item, 'Field preparation skipped because export payload was unavailable.');
          return;
        }
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const prepared = await prepareDashboardFieldsForImport(item, destination, destinationClient, cached.payload, targetModelId);
        const warnings = [...(item.warnings || []), ...prepared.warnings];
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: { ...(item.details || {}), ...prepared.details },
        });
      } else if (item.kind === 'query_view_prepare') {
        if (!item.documentId) throw new Error('Query-view preparation item missing document id.');
        if (item.error) {
          markAndPersistItem(item, 'failed');
          skipDestinationDocumentItems(item, `Query-view preparation failed; dependent step skipped. ${item.error}`);
          return;
        }
        const cached = exports.get(item.documentId);
        if (!cached) {
          markAndPersistItem(item, 'skipped', { error: 'Export payload unavailable; query-view preparation skipped.' });
          skipDestinationDocumentItems(item, 'Query-view preparation skipped because export payload was unavailable.');
          return;
        }
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const prepared = await prepareDashboardQueryViewsForImport(item, destination, destinationClient, cached.payload, targetModelId);
        const warnings = [...(item.warnings || []), ...prepared.warnings];
	        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
	          warnings: warnings.length > 0 ? warnings : undefined,
	          details: { ...(item.details || {}), ...prepared.details },
	        });
	      } else if (item.kind === 'relationship_prepare') {
	        if (!item.documentId) throw new Error('Relationship preparation item missing document id.');
	        if (item.error) {
	          markAndPersistItem(item, 'failed');
	          skipDestinationDocumentItems(item, `Relationship preparation failed; dependent step skipped. ${item.error}`);
	          return;
	        }
	        const targetModelId = item.targetModelId || destination.defaultModelId;
	        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
	        const prepared = await prepareDashboardRelationshipsForImport(item, destination, destinationClient, targetModelId);
	        const warnings = [...(item.warnings || []), ...prepared.warnings];
	        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
	          warnings: warnings.length > 0 ? warnings : undefined,
	          details: { ...(item.details || {}), ...prepared.details },
	        });
	      } else if (item.kind === 'topic_prepare') {
        if (!item.documentId) throw new Error('Topic preparation item missing document id.');
        const cached = exports.get(item.documentId);
        if (!cached) {
          markAndPersistItem(item, 'skipped', { error: 'Export payload unavailable; topic preparation skipped.' });
          skipDestinationDocumentItems(item, 'Topic preparation skipped because export payload was unavailable.');
          return;
        }
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const prepared = await prepareDashboardTopicsForImport(item, destination, destinationClient, cached.payload, targetModelId);
        const warnings = [...(item.warnings || []), ...prepared.warnings];
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: { ...(item.details || {}), ...prepared.details },
        });
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
        const topicMappings = detailTopicMappings(item.details).length > 0
          ? detailTopicMappings(item.details)
          : targetForItem(item)?.topicMappings || [];
        const rewritten = rewriteDashboardTopicReferences(cached.payload, topicMappings);
        const imported = await destinationClient.importDocument({
          exportPayload: rewritten.payload,
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
            const docsAfterImport = await listDocumentsForFolder(destinationClient, item.targetFolderId, targetFolderPath);
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
          details: {
            ...(item.details || {}),
            topicRewriteCount: rewritten.replacementCount,
            topicRewrites: rewritten.replacements,
          },
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
		      if (item.kind === 'field_prepare') {
		        skipDestinationDocumentItems(item, `Field preparation failed; dependent step skipped. ${message}`);
		      }
		      if (item.kind === 'query_view_prepare') {
		        skipDestinationDocumentItems(item, `Query-view preparation failed; dependent step skipped. ${message}`);
		      }
	      if (item.kind === 'relationship_prepare') {
	        skipDestinationDocumentItems(item, `Relationship preparation failed; dependent import skipped. ${message}`);
	      }
	      if (item.kind === 'topic_prepare') {
	        skipDestinationDocumentItems(item, `Topic preparation failed; dependent import skipped. ${message}`);
	      }
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
      && item.kind !== 'source_delete'
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
      && item.kind !== 'source_delete'
    )));
  }

  function sourceDocumentImportSucceeded(documentId: string | undefined): boolean {
    if (!documentId) return false;
    const imports = job.items.filter((item) => item.kind === 'import' && item.documentId === documentId);
    return imports.length > 0 && imports.every((item) => item.status === 'succeeded' || item.status === 'warning');
  }

  function hasFailedPostMigrationAction(): boolean {
    return job.items.some((item) => item.kind === 'post_action' && item.status === 'failed');
  }

  async function runSourceDeleteStage(): Promise<void> {
    const sourceDeleteItems = job.items.filter((item) => item.kind === 'source_delete' && item.status === 'pending');
    if (sourceDeleteItems.length === 0) return;
    const postActionFailed = hasFailedPostMigrationAction();
    for (const item of sourceDeleteItems) {
      if (canceledJobs.has(job.id)) {
        markAndPersistItem(item, 'skipped', { error: 'Canceled by user.' });
        continue;
      }
      if (postActionFailed) {
        markAndPersistItem(item, 'skipped', { error: 'Source delete skipped because a post-migration action failed.' });
        continue;
      }
      if (!sourceDocumentImportSucceeded(item.documentId)) {
        markAndPersistItem(item, 'skipped', { error: 'Source delete skipped because the dashboard import did not complete successfully.' });
        continue;
      }
      markAndPersistItem(item, 'running');
      try {
        if (!item.documentId) throw new Error('Source delete item missing document id.');
        await sourceClient.requestDeleteDocument(item.documentId);
        markAndPersistItem(item, 'succeeded', {
          details: {
            operation: 'move_source_to_trash',
            verifiedAfterImport: true,
          },
        });
      } catch (error) {
        const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
        markAndPersistItem(item, 'failed', { error: message });
      }
    }
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
  await runSourceDeleteStage();
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
    return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
  }
}

export async function runPostMigrationAction(action: PostMigrationAction): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (action.kind === 'refresh-schema') return runSchemaRefreshAction(action);
  const validationError = await validatePostMigrationActionTargetForRequest(action);
  if (validationError) return { ok: false, error: validationError };

  try {
    const response = await fetchPostMigrationAction(action);
    const text = await response.text();
    return {
      ok: response.ok,
      error: response.ok ? undefined : redactSensitiveText(`Action returned ${response.status}: ${text.slice(0, 300)}`),
      warning: response.ok ? `Action returned ${response.status}` : undefined,
    };
  } catch (error) {
    return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
  }
}
