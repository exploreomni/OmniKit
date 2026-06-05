export type ConnectionStatus = 'untested' | 'testing' | 'success' | 'error';

export interface ConnectionConfig {
  baseUrl: string;
  apiKey: string;
  status: ConnectionStatus;
  errorMessage: string;
  connectionMode?: 'manual' | 'vault';
  instanceId?: string;
  instanceLabel?: string;
  apiKeyMasked?: string;
}

export interface OmniFolder {
  id: string;
  name: string;
  identifier?: string;
  path?: string;
  labels?: Array<string | { name?: string }>;
  children?: OmniFolder[];
}

export interface OmniDocument {
  id: string;
  name: string;
  identifier?: string;
  baseModelId?: string;
  baseModelName?: string;
  topicNames?: string[];
  connectionName?: string;
  connectionId?: string;
  enrichmentError?: string | null;
  folderPath?: string;
  folderId?: string;
  type?: string;
  labels?: Array<string | { name?: string }>;
}

export interface OmniModel {
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
  branches?: OmniModel[];
}

export interface OmniUser {
  id: string;
  userName: string;
  displayName: string;
  active?: boolean;
  attributes?: Record<string, string>;
  groups?: Array<{ value: string; display: string }>;
}

export interface OmniGroup {
  id: string;
  displayName: string;
  members: Array<{ value: string; display: string }>;
}

export interface OmniTopic {
  name: string;
  label?: string;
  description?: string;
  baseViewName?: string;
  views?: Array<{
    name: string;
    label?: string;
    dimensions?: Array<{ field_name: string; data_type: string; sql?: string }>;
    measures?: Array<{ field_name: string; aggregate_type?: string; data_type: string; sql?: string }>;
  }>;
  relationships?: Array<{
    id: string;
    left_view_name: string;
    right_view_name: string;
    join_type: string;
    sql: string;
  }>;
}

export interface ModelMapping {
  sourceModelId: string;
  targetModelId: string;
  dashboardCount: number;
}

export interface DashboardSelection extends OmniDocument {
  selected: boolean;
}

export type MigrationItemStatus = 'pending' | 'in_progress' | 'success' | 'failed' | 'skipped' | 'ready' | 'warning';

export interface MigrationResult {
  id: string;
  name: string;
  status: MigrationItemStatus;
  error?: string;
  warnings?: string[];
  sourceModel?: string;
  targetModel?: string;
}

export interface MigrationSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  total: number;
}

export type BulkOperationStatus = 'idle' | 'running' | 'complete';

export interface BulkOperationResult {
  id: string;
  name: string;
  status: 'success' | 'failed' | 'skipped' | 'pending' | 'in_progress';
  error?: string;
  detail?: string;
  requestPayload?: Record<string, unknown>;
  responseBody?: unknown;
  responseStatus?: number;
  verificationBody?: unknown;
  steps?: Record<string, unknown>;
}

export interface BulkOperationSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  total: number;
}

export type WizardStep = 0 | 1 | 2 | 3;

export const STEP_LABELS = ['Select', 'Map', 'Review', 'Done'] as const;

export interface WizardState {
  currentStep: WizardStep;
  source: ConnectionConfig;
  target: ConnectionConfig;
  sameInstance: boolean;
  folders: OmniFolder[];
  documents: OmniDocument[];
  selectedDashboards: OmniDocument[];
  sourceModels: OmniModel[];
  targetModels: OmniModel[];
  modelMappings: Record<string, string>;
  targetFolder: string;
  dryRun: boolean;
  dryRunCompleted: boolean;
  migrationInProgress: boolean;
  migrationResults: MigrationResult[];
  migrationSummary: MigrationSummary | null;
  currentMigrationIndex: number;
}

export interface OmniConnection {
  id: string;
  name: string;
  dialect: string;
  database?: string;
  defaultSchema?: string;
  baseRole?: string;
  deletedAt?: string | null;
}

export interface OmniConnectionDbt {
  sshUrl?: string;
  branch?: string;
  dbtVersion?: string;
  projectRootPath?: string;
  semanticLayer?: boolean;
  virtualSchemas?: boolean;
  autoGenerateRelationships?: boolean;
}

export interface OmniConnectionSchedule {
  id: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface OmniSchedule {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  identifier: string;
  dashboardName: string;
  ownerId: string;
  ownerName: string;
  lastCompletedAt?: string | null;
  lastStatus?: string | null;
  destinationType: string;
  format: string;
  recipientCount: number;
  content: string;
  disabledAt?: string | null;
  systemDisabledAt?: string | null;
  systemDisabledReason?: string | null;
  alert?: string | null;
}

export interface OmniLabel {
  id: string;
  name: string;
  color?: string;
  description?: string;
  usageCount?: number;
  verified?: boolean;
  homepage?: boolean;
}

export interface OmniUpload {
  id: string;
  file_name: string;
  view_name: string;
  connection_id: string;
  in_db_as_table_name?: string | null;
  model_id?: string | null;
  size_bytes?: number | null;
  created_at: string;
  updated_at: string;
  uploaded_by_user?: { id: string; name: string } | null;
}

export interface OmniUserAttribute {
  name: string;
  label: string;
  type: string;
  multipleValues?: boolean;
  defaultValue?: string;
  description?: string;
  system?: boolean;
}

export interface OmniModelRole {
  modelId: string;
  connectionId: string;
  roleName: string;
  baseRole?: string;
  priority?: number;
  resolved?: boolean;
  source?: string;
  groupName?: string;
}

export interface OmniGitConfig {
  baseBranch: string;
  branchPerPullRequest: boolean;
  gitFollower: boolean;
  gitServiceProvider: string;
  modelPath?: string | null;
  publicKey: string;
  requirePullRequest: string;
  sshUrl: string;
  webUrl?: string | null;
  webhookSecret?: string;
  webhookUrl: string;
}

export interface OmniModelBranch {
  name: string;
}

export interface OmniDashboardFilter {
  type: string;
  kind: string;
  values?: string[];
  label?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  left_side?: string;
  right_side?: string;
}

export interface OmniDashboardControl {
  id: string;
  type: string;
  kind: string;
  field?: string;
  options?: Array<{ label: string; value: string }>;
  label?: string;
  description?: string;
  hidden?: boolean;
}

export interface OmniContentValidationResult {
  documentId: string;
  documentName: string;
  documentType?: string;
  ownerName?: string;
  ownerEmail?: string;
  folderPath?: string;
  lastUpdated?: string;
  queries?: Array<{
    queryName: string;
    messages: string[];
  }>;
  dashboardFilterIssues?: string[];
}

export interface OmniEmailOnlyUser {
  email: string;
  user_id: string;
  user_attributes: Record<string, unknown>;
}

export interface OmniDocumentAccess {
  name: string;
  email?: string;
  type: string;
  role: string;
  accessSource: string;
  owner?: boolean;
  folderName?: string;
  folderPath?: string;
}

export interface OmniFolderPermission {
  name: string;
  description?: string;
  type: string;
  role: string;
  accessBoost?: boolean;
  owner?: boolean;
}

export interface OmniQueryField {
  fieldName: string;
  viewName?: string;
  dataType?: string;
  aggregateType?: string;
  fieldType: 'dimension' | 'measure';
}

export interface OmniQueryFilter {
  fieldName: string;
  operator: string;
  values: string[];
}

export interface OmniQuerySort {
  fieldName: string;
  direction: 'asc' | 'desc';
}

export interface OmniQueryConfig {
  modelId: string;
  topicName?: string;
  branchName?: string;
  fields: string[];
  filters?: Record<string, unknown>;
  sorts?: Array<{ fieldName: string; direction: string }>;
  limit?: number | null;
  cacheMode?: string;
  formatResults?: boolean;
  userId?: string;
}

export interface OmniQueryResult {
  data: Record<string, unknown>[];
  columns?: Array<{ name: string; type: string }>;
  sql?: string;
  cacheInfo?: { freshness?: string; ttl?: string };
  totalRows?: number;
}

export type OperationType =
  | 'migration'
  | 'bulk_move'
  | 'bulk_delete'
  | 'download'
  | 'label_change'
  | 'user_import'
  | 'query_run'
  | 'ai_query'
  | 'user_create'
  | 'user_update'
  | 'user_delete'
  | 'group_update'
  | 'model_create'
  | 'topic_create'
  | 'topic_update'
  | 'topic_delete'
  | 'branch_merge'
  | 'embed_generate';

export interface OperationLogEntry {
  id: string;
  type: OperationType;
  description: string;
  timestamp: number;
  itemCount: number;
  successCount: number;
  failureCount: number;
  durationMs: number;
}

export interface PageInfo {
  hasNextPage: boolean;
  nextCursor?: string | null;
  pageSize: number;
  totalRecords: number;
}

export type WizardAction =
  | { type: 'SET_STEP'; step: WizardStep }
  | { type: 'UPDATE_SOURCE'; payload: Partial<ConnectionConfig> }
  | { type: 'UPDATE_TARGET'; payload: Partial<ConnectionConfig> }
  | { type: 'SET_SAME_INSTANCE'; value: boolean }
  | { type: 'SET_FOLDERS'; folders: OmniFolder[] }
  | { type: 'SET_DOCUMENTS'; documents: OmniDocument[] }
  | { type: 'SET_SELECTED_DASHBOARDS'; dashboards: OmniDocument[] }
  | { type: 'SET_SOURCE_MODELS'; models: OmniModel[] }
  | { type: 'SET_TARGET_MODELS'; models: OmniModel[] }
  | { type: 'SET_MODEL_MAPPING'; sourceId: string; targetId: string }
  | { type: 'SET_ALL_MODEL_MAPPINGS'; mappings: Record<string, string> }
  | { type: 'SET_TARGET_FOLDER'; folder: string }
  | { type: 'SET_DRY_RUN'; value: boolean }
  | { type: 'SET_DRY_RUN_COMPLETED'; value: boolean }
  | { type: 'START_MIGRATION' }
  | { type: 'UPDATE_MIGRATION_PROGRESS'; index: number; result: MigrationResult }
  | { type: 'COMPLETE_MIGRATION'; summary: MigrationSummary; results: MigrationResult[] }
  | { type: 'ENRICH_DOCUMENTS'; enrichments: Record<string, { baseModelId: string | null; baseModelName: string | null; topicNames: string[] | null; connectionName: string | null; connectionId: string | null; enrichmentError: string | null }> }
  | { type: 'RESET_ALL' };
