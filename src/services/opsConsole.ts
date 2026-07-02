import { ApiError } from '@/services/omniApi';
import type { DashboardDownloadDetails } from '@/services/dashboardDownloads';
import { emitVaultChanged, emitVaultLocked } from '@/services/vaultEvents';

const defaultHeaders = {
  'Content-Type': 'application/json',
};
const METRIC_CACHE_KEY = 'omnikit:instanceDashboardCache:v1';
export const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';

export type InstanceRole = 'source' | 'destination' | 'both';
export type PostMigrationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type PostMigrationActionKind = 'webhook' | 'refresh-schema';
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

export interface InstanceMetricFilter {
  connectionDatabaseContains: string[];
  connectionDatabaseExact: string[];
  embedExternalIdContains: string[];
  embedExternalIdExact: string[];
}

export interface PostMigrationAction {
  kind?: PostMigrationActionKind;
  name: string;
  method: PostMigrationMethod;
  url: string;
  headers: Record<string, string>;
  body: string;
  destinationInstanceId?: string;
  targetModelId?: string;
  targetModelName?: string;
}

export interface SavedInstancePublic {
  id: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKeyMasked: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
  entityGroupSeparator?: string;
  metricFilter: InstanceMetricFilter;
  postMigrationActions: PostMigrationAction[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

export interface VaultStatus {
  unlocked: boolean;
  exists: boolean;
  path: string;
  idleTimeoutMs?: number;
  lastActivityAt?: number;
  instanceCount: number;
}

export interface LegacyVaultImportResult {
  dryRun: boolean;
  imported: number;
  wouldImport: number;
  skipped: Array<{ label: string; reason: string }>;
  warnings: string[];
}

export interface SavedInstanceConnection {
  baseUrl: string;
  apiKey: string;
  status: 'success';
  connectionMode: 'vault';
  instanceId: string;
  instanceLabel: string;
  apiKeyMasked: string;
}

export interface InstanceDocument {
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

export interface InstanceModel {
  id: string;
  name: string;
  identifier?: string;
  connectionId?: string;
  connectionName?: string;
  baseModelId?: string;
  kind?: string;
  gitConfigured?: boolean;
  pullRequestRequired?: boolean;
  gitProtected?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface InstanceTopic {
  name: string;
  label?: string;
  description?: string;
  fileName?: string;
}

export interface InstanceQueryView {
  name: string;
  label?: string;
  description?: string;
  fileName: string;
  yaml?: string;
  checksum?: string;
}

export interface ApiPerformanceTimingEntry {
  name: string;
  durationMs: number;
  detail?: Record<string, unknown>;
}

export interface ApiPerformanceTimings {
  totalMs: number;
  timings: ApiPerformanceTimingEntry[];
}

export interface ModelMigratorConnection {
  id: string;
  name: string;
  dialect: string;
  database: string;
  defaultSchema?: string;
  deletedAt?: string | null;
}

export type ModelMigratorDocumentKind = 'dashboard' | 'workbook' | 'unknown';

export interface ModelMigratorInventoryDocument {
  id: string;
  identifier: string;
  name: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  type?: string;
  kind: ModelMigratorDocumentKind;
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface ModelMigratorInventoryRow {
  modelId: string;
  dashboardCount: number;
  workbookCount: number;
  unknownCount: number;
  documents: ModelMigratorInventoryDocument[];
}

export interface ModelMigratorTranslatedFile {
  fileName: string;
  original: string;
  deterministic: string;
  translated: string;
  aiDraft?: string;
  aiJobId?: string;
  aiRefusal?: string;
  blocked?: boolean;
  changed: boolean;
  promptVersion: string;
  reviewRequired: boolean;
  warnings: string[];
}

export interface ModelMigratorWorkbookPreflight {
  documentId: string;
  tabCount: number;
  blockerCount: number;
  tabs: Array<{
    id: string;
    name: string;
    fieldReferences: string[];
    blockers: string[];
    replacementCount: number;
  }>;
}

export interface ModelMigratorAcceptedFile {
  fileName: string;
  yaml: string;
  previousChecksum?: string;
}

export interface ModelMigratorJobModelInput {
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
  acceptedFiles?: ModelMigratorAcceptedFile[];
}

export interface ModelMigratorJobContentInput {
  documentId: string;
  documentName: string;
  kind: 'dashboard' | 'workbook';
  sourceModelId: string;
  targetModelId: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
}

export interface InstanceFolder {
  id: string;
  name: string;
  identifier?: string;
  path?: string;
  parentId?: string;
  children?: InstanceFolder[];
}

export interface InstanceLabel {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface ConnectionMetricRecord {
  id: string;
  name: string;
  dialect: string;
  database: string;
  defaultSchema?: string;
  filtered: boolean;
  hasSchemaModel: boolean;
  schemaModelGenerated: boolean;
  schemaModelId: string | null;
  schemaModelCreatedAt?: string | null;
  schemaModelUpdatedAt: string | null;
  readiness: 'missing_schema_model' | 'schema_model_stuck' | 'ready';
}

export interface InstanceConnectionStats {
  instanceId: string;
  instanceLabel: string;
  instanceRole: InstanceRole;
  baseUrl: string;
  totalConnections: number;
  filteredCount: number;
  missingSchemaModelCount: number;
  stuckSchemaModelCount: number;
  connections: ConnectionMetricRecord[];
  error?: string;
}

export interface EmbedUserMetricRecord {
  id: string;
  displayName: string;
  userName: string;
  active: boolean;
  embedExternalId: string;
  entityName: string;
  filtered: boolean;
  lastLogin?: string | null;
}

export interface InstanceEmbedUserStats {
  instanceId: string;
  instanceLabel: string;
  instanceRole: InstanceRole;
  baseUrl: string;
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  filteredCount: number;
  entityCount: number;
  activity: {
    active7d: number;
    active30d: number;
    active90d: number;
    neverLoggedIn: number;
    weeklyLogins: Array<{ weekStart: string; count: number }>;
    monthlySignups: Array<{ month: string; count: number }>;
  };
  users: EmbedUserMetricRecord[];
  error?: string;
}

interface MetricCache {
  version: 1;
  connections?: {
    savedAt: string;
    instances: InstanceConnectionStats[];
  };
  embedUsers?: {
    savedAt: string;
    instances: InstanceEmbedUserStats[];
  };
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

export interface MigrationJobItem {
  id: string;
  jobId: string;
  destinationId: string;
  destinationLabel: string;
  routeGroupId?: string;
  routeGroupName?: string;
  targetId?: string;
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
  notices?: string[];
  startedAt?: number;
  endedAt?: number;
  exportHash?: string;
  importedIdentifier?: string;
  importedDocumentId?: string;
  replacement?: boolean;
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

export type MigrationJobStreamEvent =
  | { type: 'snapshot'; job: MigrationJob }
  | { type: 'job'; jobId: string; status: JobStatus; at: number; job?: MigrationJob }
  | { type: 'item'; jobId: string; itemId: string; destinationId: string; status: JobItemStatus; error?: string; at: number; item?: MigrationJobItem }
  | { type: 'post-migration'; jobId: string; results: unknown; at: number };

export interface SaveInstanceInput {
  id?: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey?: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
  entityGroupSeparator?: string;
  metricFilter: InstanceMetricFilter;
  postMigrationActions: PostMigrationAction[];
}

export function vaultApiKeyReference(instanceId: string): string {
  return `${VAULT_API_KEY_REFERENCE_PREFIX}${instanceId}`;
}

export function isVaultApiKeyReference(value: string): boolean {
  return value.startsWith(VAULT_API_KEY_REFERENCE_PREFIX);
}

export interface MigrationJobInput {
  sourceId: string;
  sourceConnectionId?: string;
  destinationIds?: string[];
  targets: MigrationTarget[];
  routeGroups?: MigrationRouteGroup[];
  documentIds: string[];
  sourceDocumentHints?: InstanceDocument[];
  emptyFirst: boolean;
  replaceSameNamed?: boolean;
  deleteSourceOnSuccess?: boolean;
  sourceFolderId?: string;
  sourceFolderPath?: string;
  sourceAllFolders?: boolean;
  postMigrationActions: PostMigrationAction[];
}

export type DashboardPatchValidationStatus = 'passed' | 'failed' | 'skipped';
export type DashboardPatchValidationMode = 'branch' | 'structural' | 'skipped';

export interface DashboardPatchValidationArtifact {
  id: string;
  artifactType: MigrationSemanticPatch['artifactType'];
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

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options?.body ? defaultHeaders : {}),
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `${path} failed (HTTP ${res.status})`;
    let detail = '';
    try {
      const body = await res.json() as { error?: string; message?: string; detail?: string };
      message = body.error || body.message || message;
      detail = body.detail || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    if (res.status === 423) emitVaultLocked(message);
    throw new ApiError(res.status, message, detail || undefined);
  }
  return await res.json() as T;
}

async function apiFetchBlob(path: string, options?: RequestInit): Promise<{ blob: Blob; filename?: string; contentType?: string }> {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options?.body ? defaultHeaders : {}),
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `${path} failed (HTTP ${res.status})`;
    let detail = '';
    try {
      const body = await res.json() as { error?: string; message?: string; detail?: string };
      message = body.error || body.message || message;
      detail = body.detail || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    if (res.status === 423) emitVaultLocked(message);
    throw new ApiError(res.status, message, detail || undefined);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1];
  return {
    blob: await res.blob(),
    filename,
    contentType: res.headers.get('content-type') || undefined,
  };
}

export function emptyMetricFilter(): InstanceMetricFilter {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

function readMetricCache(): MetricCache {
  if (typeof window === 'undefined') return { version: 1 };
  try {
    const raw = window.localStorage.getItem(METRIC_CACHE_KEY);
    if (!raw) return { version: 1 };
    const parsed = JSON.parse(raw) as Partial<MetricCache>;
    return parsed.version === 1 ? parsed as MetricCache : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

function writeMetricCache(next: MetricCache): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(METRIC_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Metric cache is a convenience only.
  }
}

export function getCachedConnectionMetrics() {
  return readMetricCache().connections ?? null;
}

export function getCachedEmbedUserMetrics() {
  return readMetricCache().embedUsers ?? null;
}

export async function getVaultStatus() {
  return apiFetch<VaultStatus>('/api/vault/status');
}

export async function unlockNativeVault(passphrase: string) {
  const result = await apiFetch<{ status: VaultStatus }>('/api/vault/unlock', {
    method: 'POST',
    body: JSON.stringify({ passphrase }),
  });
  emitVaultChanged();
  return result;
}

export async function lockNativeVault() {
  const result = await apiFetch<{ status: VaultStatus }>('/api/vault/lock', { method: 'POST' });
  emitVaultChanged();
  return result;
}

export async function touchNativeVault() {
  const result = await apiFetch<{ status: VaultStatus }>('/api/vault/touch', { method: 'POST' });
  emitVaultChanged();
  return result;
}

export async function changeNativeVaultPassphrase(currentPassphrase: string, nextPassphrase: string) {
  return apiFetch<{ status: VaultStatus }>('/api/vault/change-passphrase', {
    method: 'POST',
    body: JSON.stringify({ currentPassphrase, nextPassphrase }),
  });
}

export async function resetNativeVault() {
  const result = await apiFetch<{ status: VaultStatus }>('/api/vault/reset', { method: 'DELETE' });
  emitVaultChanged();
  return result;
}

export async function listSavedInstances() {
  return apiFetch<{ instances: SavedInstancePublic[] }>('/api/instances');
}

export async function importLegacyVault(input: {
  path: string;
  passphrase: string;
  dryRun: boolean;
  confirmAbsolutePath: boolean;
}) {
  return apiFetch<LegacyVaultImportResult>('/api/instances/import-legacy', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function saveSavedInstance(input: SaveInstanceInput) {
  const path = input.id ? `/api/instances/${encodeURIComponent(input.id)}` : '/api/instances';
  const { id: _id, ...payload } = input;
  void _id;
  return apiFetch<{ instance: SavedInstancePublic }>(path, {
    method: input.id ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteSavedInstance(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function testSavedInstance(id: string) {
  return apiFetch<{ instance: SavedInstancePublic }>(`/api/instances/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

export async function connectSavedInstance(id: string) {
  return apiFetch<{ instance: SavedInstancePublic; connection: SavedInstanceConnection }>(
    `/api/instances/${encodeURIComponent(id)}/connect`,
    { method: 'POST' },
  );
}

export async function listInstanceDocuments(
  id: string,
  options: {
    folderId?: string;
    folderPath?: string;
    connectionId?: string;
    allFolders?: boolean;
    includeModelDetails?: boolean;
    documentIds?: string[];
  } = {},
) {
  const params = new URLSearchParams();
  if (options.folderId) params.set('folderId', options.folderId);
  if (options.folderPath) params.set('folderPath', options.folderPath);
  if (options.connectionId) params.set('connectionId', options.connectionId);
  if (options.allFolders) params.set('allFolders', 'true');
  if (options.includeModelDetails) params.set('includeModelDetails', 'true');
  if (options.documentIds?.length) params.set('documentIds', options.documentIds.join(','));
  const query = params.toString();
  return apiFetch<{ documents: InstanceDocument[]; performance?: ApiPerformanceTimings }>(
    `/api/instances/${encodeURIComponent(id)}/documents${query ? `?${query}` : ''}`,
  );
}

export async function listInstanceModels(id: string, options: { connectionId?: string } = {}) {
  const params = new URLSearchParams({ modelKind: 'SHARED' });
  if (options.connectionId) params.set('connectionId', options.connectionId);
  return apiFetch<{ models: InstanceModel[] }>(`/api/instances/${encodeURIComponent(id)}/models?${params.toString()}`);
}

export async function listInstanceModelTopics(id: string, modelId: string) {
  return apiFetch<{ topics: InstanceTopic[] }>(
    `/api/instances/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}/topics`,
  );
}

export async function listInstanceModelQueryViews(
  id: string,
  modelId: string,
  options: { includeYaml?: boolean; includeChecksums?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.includeYaml) params.set('includeYaml', 'true');
  if (options.includeChecksums) params.set('includeChecksums', 'true');
  const query = params.toString();
  return apiFetch<{ queryViews: InstanceQueryView[] }>(
    `/api/instances/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}/query-views${query ? `?${query}` : ''}`,
  );
}

export async function listModelMigratorConnections(instanceId: string) {
  return apiFetch<{ connections: ModelMigratorConnection[] }>(
    `/api/model-migrator/${encodeURIComponent(instanceId)}/connections`,
  );
}

export async function listModelMigratorModels(instanceId: string, options: { connectionId?: string } = {}) {
  const params = new URLSearchParams({ modelKind: 'SHARED' });
  if (options.connectionId) params.set('connectionId', options.connectionId);
  return apiFetch<{ models: InstanceModel[] }>(
    `/api/model-migrator/${encodeURIComponent(instanceId)}/models?${params.toString()}`,
  );
}

export async function loadModelMigratorInventory(instanceId: string, modelIds: string[]) {
  const params = new URLSearchParams();
  if (modelIds.length > 0) params.set('modelIds', modelIds.join(','));
  return apiFetch<{ models: ModelMigratorInventoryRow[] }>(
    `/api/model-migrator/${encodeURIComponent(instanceId)}/inventory?${params.toString()}`,
  );
}

export async function translateModelMigratorYaml(input: {
  sourceInstanceId: string;
  modelId: string;
  schemaMapText: string;
  sourceDialect?: string;
  targetDialect?: string;
  runAi?: boolean;
}) {
  return apiFetch<{
    files: ModelMigratorTranslatedFile[];
    checksums: Record<string, string>;
    prompts: Array<{ fileName: string; prompt: string }>;
  }>('/api/model-migrator/translate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function preflightModelMigratorWorkbooks(input: {
  sourceInstanceId: string;
  targetInstanceId: string;
  sourceModelId: string;
  targetModelId: string;
  documentIds: string[];
}) {
  return apiFetch<{ workbooks: ModelMigratorWorkbookPreflight[] }>('/api/model-migrator/preflight', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createModelMigratorJob(input: {
  sourceId: string;
  targetId: string;
  targetLabel?: string;
  models: ModelMigratorJobModelInput[];
  content: ModelMigratorJobContentInput[];
  replaceSameNamed: boolean;
  mergeAfterValidation?: boolean;
  publishDrafts?: boolean;
  deleteBranch?: boolean;
  postMigrationActions?: PostMigrationAction[];
}) {
  return apiFetch<{ job: MigrationJob }>('/api/model-migrator/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function mergeModelMigratorJob(jobId: string, input: { publishDrafts?: boolean; deleteBranch?: boolean }) {
  return apiFetch<{ job: MigrationJob }>(`/api/model-migrator/jobs/${encodeURIComponent(jobId)}/merge`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listInstanceFolders(id: string) {
  return apiFetch<{ folders: InstanceFolder[] }>(`/api/instances/${encodeURIComponent(id)}/folders`);
}

export async function listInstanceLabels(id: string) {
  return apiFetch<{ labels: InstanceLabel[] }>(`/api/instances/${encodeURIComponent(id)}/labels`);
}

export async function updateInstanceDocumentMetadata(
  instanceId: string,
  documentId: string,
  input: { description?: string; labels?: string[]; createLabels?: string[]; clearExistingDraft?: boolean },
) {
  return apiFetch<{ ok: boolean }>(
    `/api/instances/${encodeURIComponent(instanceId)}/documents/${encodeURIComponent(documentId)}/metadata`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

export async function loadConnectionMetrics() {
  const result = await apiFetch<{ instances: InstanceConnectionStats[] }>('/api/instance-dashboard/connections');
  writeMetricCache({
    ...readMetricCache(),
    connections: { savedAt: new Date().toISOString(), instances: result.instances },
  });
  return result;
}

export async function loadEmbedUserMetrics() {
  const result = await apiFetch<{ instances: InstanceEmbedUserStats[] }>('/api/instance-dashboard/embed-users');
  writeMetricCache({
    ...readMetricCache(),
    embedUsers: { savedAt: new Date().toISOString(), instances: result.instances },
  });
  return result;
}

export async function refreshInstanceSchemaModel(instanceId: string, modelId: string) {
  return apiFetch<{ ok: boolean; instanceId: string; modelId: string; jobId?: string; status?: string }>(
    `/api/instance-dashboard/${encodeURIComponent(instanceId)}/refresh-schema`,
    {
      method: 'POST',
      body: JSON.stringify({ modelId }),
    },
  );
}

export async function getDashboardDownloadDetails(instanceId: string, dashboardId: string) {
  return apiFetch<{ details: DashboardDownloadDetails }>(
    `/api/dashboard-downloads/${encodeURIComponent(instanceId)}/dashboards/${encodeURIComponent(dashboardId)}/details`,
  );
}

export async function startDashboardDownloadJob(
  instanceId: string,
  dashboardId: string,
  input: { request: Record<string, unknown>; format: string; scope: string },
) {
  return apiFetch<{ jobId: string; attached: boolean }>(
    `/api/dashboard-downloads/${encodeURIComponent(instanceId)}/dashboards/${encodeURIComponent(dashboardId)}/jobs`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export async function getDashboardDownloadJobStatus(instanceId: string, dashboardId: string, jobId: string) {
  return apiFetch<{ status: 'processing' | 'complete' | 'error'; rawStatus?: string; error?: string }>(
    `/api/dashboard-downloads/${encodeURIComponent(instanceId)}/dashboards/${encodeURIComponent(dashboardId)}/jobs/${encodeURIComponent(jobId)}/status`,
  );
}

export async function fetchDashboardDownloadFile(
  instanceId: string,
  dashboardId: string,
  jobId: string,
  filename: string,
) {
  const params = new URLSearchParams();
  if (filename) params.set('filename', filename);
  const query = params.toString();
  return apiFetchBlob(
    `/api/dashboard-downloads/${encodeURIComponent(instanceId)}/dashboards/${encodeURIComponent(dashboardId)}/jobs/${encodeURIComponent(jobId)}/file${query ? `?${query}` : ''}`,
  );
}

export async function previewMigrationJob(input: MigrationJobInput) {
  return apiFetch<{ plan: MigrationPlan; performance?: ApiPerformanceTimings }>('/api/migration-jobs/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createOpsMigrationJob(input: MigrationJobInput) {
  return apiFetch<{ job: MigrationJob }>('/api/migration-jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getMigrationJob(id: string) {
  return apiFetch<{ job: MigrationJob }>(`/api/migration-jobs/${encodeURIComponent(id)}`);
}

export async function listMigrationJobs() {
  return apiFetch<{ jobs: MigrationJob[] }>('/api/migration-jobs');
}

export async function clearMigrationJobs() {
  return apiFetch<{ ok: boolean }>('/api/migration-jobs', { method: 'DELETE' });
}

export async function runPostMigrationActions(actions: PostMigrationAction[]) {
  return apiFetch<{ results: Array<{ action: string; ok: boolean; error?: string; warning?: string }> }>(
    '/api/migration-jobs/actions/run',
    {
      method: 'POST',
      body: JSON.stringify({ actions }),
    },
  );
}

export async function validateMigrationPatches(input: MigrationJobInput) {
  return apiFetch<{ validation: DashboardPatchValidationResult }>('/api/migration-jobs/validate-patches', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function retryOpsMigrationJob(id: string, options: { destinationId?: string; retryInput?: MigrationJobInput } = {}) {
  return apiFetch<{ job: MigrationJob }>(`/api/migration-jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body: JSON.stringify({
      ...(options.destinationId ? { destinationId: options.destinationId } : {}),
      ...(options.retryInput ? { retryInput: options.retryInput } : {}),
    }),
  });
}

export async function cancelOpsMigrationJob(id: string) {
  return apiFetch<{ job: MigrationJob }>(`/api/migration-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export function subscribeMigrationJob(
  id: string,
  onEvent: (event: MigrationJobStreamEvent) => void,
  onError?: (error: Event) => void,
): () => void {
  const source = new EventSource(`/api/migration-jobs/${encodeURIComponent(id)}/events`);
  const parse = (type: MigrationJobStreamEvent['type']) => (event: MessageEvent<string>) => {
    try {
      onEvent({ type, ...JSON.parse(event.data) } as MigrationJobStreamEvent);
    } catch {
      // Ignore malformed stream events; the fallback job-list refresh can recover.
    }
  };
  source.addEventListener('snapshot', parse('snapshot'));
  source.addEventListener('job', parse('job'));
  source.addEventListener('item', parse('item'));
  source.addEventListener('post-migration', parse('post-migration'));
  source.onerror = (error) => {
    onError?.(error);
    source.close();
  };
  return () => source.close();
}
