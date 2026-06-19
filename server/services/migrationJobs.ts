import { createHash, randomUUID } from 'node:crypto';
import { OmniClient, OmniClientError, type OmniDocumentRecord } from './omniClient';
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
}

export interface MigrationRouteGroup {
  id: string;
  name: string;
  documentIds: string[];
  targets: MigrationTarget[];
}

export type MigrationTopicMappingAction = 'map_existing' | 'copy_source';

export interface MigrationTopicMapping {
  sourceTopicName: string;
  sourceTopicId?: string;
  action: MigrationTopicMappingAction;
  targetTopicName: string;
  targetTopicLabel?: string;
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
  'joinpathsfromtopicname',
  'join_paths_from_topic_name',
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
  const maxLength = Math.max(document?.topicNames?.length || 0, document?.topicIds?.length || 0);
  for (let index = 0; index < maxLength; index += 1) {
    addTopicRef(topics, document?.topicNames?.[index], document?.topicIds?.[index]);
  }

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
    addTopicRef(topics, record.join_paths_from_topic_name);
    addTopicRef(topics, record.joinPathsFromTopicName);
    if (record.topic && typeof record.topic === 'object' && !Array.isArray(record.topic)) {
      const topic = record.topic as Record<string, unknown>;
      addTopicRef(topics, topic.name || topic.label, topic.id || topic.identifier || topic.name);
    }
    for (const key of ['topicNames', 'topic_names', 'topicIds', 'topic_ids', 'topicIdentifiers', 'topic_identifiers', 'topics']) {
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

function targetTopicExists(targetTopics: Array<{ name: string; label?: string }>, targetTopicName: string): boolean {
  const targetKey = topicKey(targetTopicName);
  return Boolean(targetKey && targetTopics.some((topic) => [topic.name, topic.label].map(topicKey).includes(targetKey)));
}

function extractTopicViewReferences(yaml: string): string[] {
  const refs = new Set<string>();
  const fieldPattern = /\$\{([A-Za-z_][\w/]*)(?:\.[A-Za-z_][\w]*)/g;
  for (const match of yaml.matchAll(fieldPattern)) refs.add(match[1]);
  const scalarPattern = /^\s*(?:base_view_name|left_view_name|right_view_name|view_name):\s*["']?([A-Za-z_][\w/]*)["']?\s*$/gm;
  for (const match of yaml.matchAll(scalarPattern)) refs.add(match[1]);
  return [...refs].sort();
}

function targetViewNamesFromFieldUniverse(fields: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const field of fields) {
    const [viewName] = field.split('.');
    if (viewName) names.add(viewName);
  }
  return names;
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
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  deleteSourceOnSuccess?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
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
  const sourceDocs = await listDocumentsForFolder(sourceClient, sourceFolderId, sourceFolderPath, true);
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

  function sourceTopicCatalog(modelId: string) {
    const cached = sourceTopicCatalogCache.get(modelId);
    if (cached) return cached;
    const next = sourceClient.listModelTopics(modelId, { includeYaml: true, includeChecksums: true });
    sourceTopicCatalogCache.set(modelId, next);
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
        existing = await listDocumentsForFolder(
          destinationClient,
          target.targetFolderId,
          cleanupFolderPath,
        );
      } else if (canUseDefaultReplacementFallback) {
        existing = (await listDocumentsForFolder(destinationClient))
          .filter((document) => selectedNames.has(document.name) && documentLooksInDefaultFolder(document));
      } else {
        cleanupNotices.push('Target cleanup was skipped because the selected target folder is the default My Documents area and OmniKit cannot scope replacement deletes safely.');
      }
    }
    const destinationWarnings: string[] = [];
    const targetTopicWarnings: string[] = [];
    const targetFields = await loadTargetFieldUniverse(destinationClient, target.targetModelId);
    const targetViewNames = targetViewNamesFromFieldUniverse(targetFields.fields);
    if (targetFields.warning) destinationWarnings.push(targetFields.warning);
    const hasCreateTopicMappings = (target.topicMappings || []).some((mapping) => mapping.action === 'copy_source');
    let targetModelRecord: { gitConfigured?: boolean; pullRequestRequired?: boolean; gitProtected?: boolean } | undefined;
    if (hasCreateTopicMappings) {
      try {
        const targetModels = await destinationClient.listModels({ modelKind: 'SHARED', connectionId: target.targetConnectionId });
        targetModelRecord = targetModels.find((model) => (
          [model.id, model.identifier, model.baseModelId, model.name].some((value) => value === target.targetModelId)
        ));
      } catch (error) {
        targetTopicWarnings.push(`Target model editability could not be checked: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    let targetTopics: Array<{ name: string; label?: string }> | null = null;

    async function loadTargetTopicsForPreflight(): Promise<Array<{ name: string; label?: string }>> {
      if (targetTopics) return targetTopics;
      targetTopics = await destinationClient.listModelTopics(target.targetModelId);
      return targetTopics;
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
      let topicWarnings = [...targetTopicWarnings];
      let resolvedTopicMappings: MigrationTopicMapping[] = [];
      let sourceTopics: SourceTopicRef[] = [];
      const topicBlockers: string[] = [];
      try {
        let refs = fieldRefCache.get(doc.identifier);
        let payload = exportCache.get(doc.identifier);
        if (!refs) {
          if (!payload) {
            payload = await sourceClient.exportDocument(doc.identifier);
            exportCache.set(doc.identifier, payload);
          }
          refs = extractDashboardFieldRefs(payload);
          fieldRefCache.set(doc.identifier, refs);
        }
        if (!payload) {
          payload = await sourceClient.exportDocument(doc.identifier);
          exportCache.set(doc.identifier, payload);
        }
        const sourceModelId = doc.baseModelId || extractDashboardModelId(payload);
        const sameTargetModel = Boolean(sourceModelId && sourceModelId === target.targetModelId);
        if (!sameTargetModel && refs.length === 0) {
          compatibilityWarnings.push('No dashboard field references were detected in the export payload. Review the imported dashboard in Omni before publishing.');
        } else if (!sameTargetModel && targetFields.fields.size > 0) {
          const missingFields = refs.filter((field) => !targetFields.fields.has(field));
          if (missingFields.length > 0) {
            compatibilityWarnings.push(`${missingFields.length} referenced fields were not found in the destination model: ${formatFieldList(missingFields)}.`);
          }
        }
        sourceTopics = collectTopicRefs(payload, doc);
        if (sourceTopics.length > 0) {
          let targetTopicRows: Array<{ name: string; label?: string }> = [];
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
      topicWarnings = [...new Set(topicWarnings)];
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
          blocked: topicBlockers.length > 0,
          error: topicBlockers.length > 0 ? topicBlockers.join(' ') : undefined,
          warnings: topicWarnings.length > 0 ? topicWarnings : undefined,
          details: {
            sourceTopics,
            topicMappings: resolvedTopicMappings,
          },
        });
      }
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
        notices: cleanupStepNotices.length > 0 ? cleanupStepNotices : undefined,
        blocked: topicBlockers.length > 0,
        error: topicBlockers.length > 0 ? 'Dashboard import is blocked until topic mappings are resolved.' : undefined,
        details: resolvedTopicMappings.length > 0 ? { topicMappings: resolvedTopicMappings } : undefined,
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

export async function createMigrationJob(input: {
  sourceId: string;
  sourceConnectionId?: string;
  destinationIds?: string[];
  targets?: MigrationTarget[];
  routeGroups?: MigrationRouteGroup[];
  documentIds: string[];
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  deleteSourceOnSuccess?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
  postMigrationActions: PostMigrationAction[];
  parentJobId?: string;
}): Promise<MigrationJob> {
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
    return item.status === 'failed' && (item.kind === 'import' || item.kind === 'export' || item.kind === 'topic_prepare');
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
  const sourceDocumentDetails = new Map<string, { baseModelId?: string; topicNames?: string[]; topicIds?: string[] }>();
  const sourceLabels = new Map<string, { color?: string | null; description?: string | null }>();
  const destinationClientCache = new Map<string, OmniClient>();
  const importedByDestinationAndSource = new Map<string, { identifier: string; documentId: string }>();
  const destinationLabelCache = new Map<string, Set<string>>();
  const preparedTopicKeys = new Set<string>();
  const selectedSourceDocumentKeys = new Set(job.documentIds.filter(Boolean));
  const sourceTopicCatalogCache = new Map<string, Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>>>();
  const targetTopicCatalogCache = new Map<string, Promise<Array<{ name: string; label?: string }>>>();

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
    const next = client.listModelTopics(targetModelId);
    targetTopicCatalogCache.set(key, next);
    return next;
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
      if ((item.kind === 'import' || item.kind === 'metadata' || item.kind === 'source_delete') && item.status === 'pending') {
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
      if (item.kind !== 'import' && item.kind !== 'metadata') continue;
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
        await destinationClient.updateModelYamlFile({
          modelId: targetModelId,
          fileName: `${mapping.targetTopicName}.topic`,
          yaml: sourceTopicYaml.yaml,
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
