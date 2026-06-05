import { ApiError } from '@/services/omniApi';

const defaultHeaders = {
  'Content-Type': 'application/json',
};
const METRIC_CACHE_KEY = 'omnikit:instanceDashboardCache:v1';
export const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';

export type InstanceRole = 'source' | 'destination' | 'both';
export type PostMigrationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed';
export type JobItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'warning' | 'skipped';
export type JobItemKind = 'delete' | 'export' | 'import' | 'metadata' | 'post_action';

export interface InstanceMetricFilter {
  connectionDatabaseContains: string[];
  connectionDatabaseExact: string[];
  embedExternalIdContains: string[];
  embedExternalIdExact: string[];
}

export interface PostMigrationAction {
  name: string;
  method: PostMigrationMethod;
  url: string;
  headers: Record<string, string>;
  body: string;
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
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
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
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface InstanceFolder {
  id: string;
  name: string;
  identifier?: string;
  path?: string;
  parentId?: string;
  children?: InstanceFolder[];
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

export interface MigrationJobItem {
  id: string;
  jobId: string;
  destinationId: string;
  destinationLabel: string;
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
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  items: MigrationJobItem[];
}

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
  destinationIds?: string[];
  targets: MigrationTarget[];
  documentIds: string[];
  emptyFirst: boolean;
  postMigrationActions: PostMigrationAction[];
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
    throw new ApiError(res.status, message, detail || undefined);
  }
  return await res.json() as T;
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
  return apiFetch<{ status: VaultStatus }>('/api/vault/unlock', {
    method: 'POST',
    body: JSON.stringify({ passphrase }),
  });
}

export async function lockNativeVault() {
  return apiFetch<{ status: VaultStatus }>('/api/vault/lock', { method: 'POST' });
}

export async function changeNativeVaultPassphrase(currentPassphrase: string, nextPassphrase: string) {
  return apiFetch<{ status: VaultStatus }>('/api/vault/change-passphrase', {
    method: 'POST',
    body: JSON.stringify({ currentPassphrase, nextPassphrase }),
  });
}

export async function resetNativeVault() {
  return apiFetch<{ status: VaultStatus }>('/api/vault/reset', { method: 'DELETE' });
}

export async function listSavedInstances() {
  return apiFetch<{ instances: SavedInstancePublic[] }>('/api/instances');
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

export async function importBrowserVaultInstances(instances: unknown[]) {
  return apiFetch<{ imported: SavedInstancePublic[] }>('/api/instances/import-browser', {
    method: 'POST',
    body: JSON.stringify({ instances }),
  });
}

export async function listInstanceDocuments(id: string) {
  return apiFetch<{ documents: InstanceDocument[] }>(`/api/instances/${encodeURIComponent(id)}/documents`);
}

export async function listInstanceModels(id: string) {
  return apiFetch<{ models: InstanceModel[] }>(`/api/instances/${encodeURIComponent(id)}/models?modelKind=SHARED`);
}

export async function listInstanceFolders(id: string) {
  return apiFetch<{ folders: InstanceFolder[] }>(`/api/instances/${encodeURIComponent(id)}/folders`);
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

export async function previewMigrationJob(input: MigrationJobInput) {
  return apiFetch<{ plan: MigrationPlan }>('/api/migration-jobs/preview', {
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

export async function retryOpsMigrationJob(id: string) {
  return apiFetch<{ job: MigrationJob }>(`/api/migration-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}
