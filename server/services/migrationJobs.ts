import { createHash, randomUUID } from 'node:crypto';
import { assertAdditiveDashboardRepairDispatch, dashboardRepairInstanceBoundaryHash } from './dashboardRepairRuntime';
import type { ReviewedReconstructedTopics } from './dashboardTopicRepairEvidence';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  OmniClient,
  OmniClientError,
  type DocumentV2Patch,
  type OmniDocumentQueryRecord,
  type OmniDocumentAccessPrincipal,
  type OmniDocumentRecord,
  type OmniIdentityUserRecord,
  type OmniModelBranchResult,
  type OmniModelQueryViewRecord,
  type OmniModelRoleRecord,
  type OmniModelYamlResponse,
  type OmniUserGroupRecord,
  type OmniValidationIssue,
} from './omniClient';
import {
  getInstance,
  isVaultUnlocked,
  type PostMigrationAction,
  type SavedInstance,
} from './nativeVault';
import {
  clearJobs as clearStoredJobs,
  getJob as getStoredJob,
  insertJob,
  listJobs as listStoredJobs,
  updateJobAtomically,
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
import { clearReadThroughCache, readThroughCache } from './readThroughCache';
import { dashboardSafeCopyDependencyPatchCandidates } from './dashboardSafeCopyResolver';
import { readDashboardSourceEvidence, type DashboardSourceEvidence, type DashboardSourceFieldProvenance, type DashboardSourceYamlReadOptions } from './dashboardSourceEvidence';
import {
  materializeDashboardSafeCopyDocumentContent,
  type DashboardSafeCopyDocumentContent,
} from './dashboardSafeCopyContent';
import { dashboardSafeCopyHasUnresolvedDestinationModelOverlap } from './dashboardSafeCopyJobs';
import {
  hasUnresolvedMigrationDestinationModelMutation,
  migrationDestinationModelMutationLease,
  MigrationScopeReservationError,
  releaseMigrationDestinationModel,
  reserveMigrationDestinationModels,
  type MigrationDestinationModelMutationState,
  type MigrationDestinationModelScope,
} from './migrationScopeReservation';
import {
  compileMigrationPermissionPatches,
  discoverMigrationContentAccessDependencies,
  discoverMigrationDocumentSettingsDependency,
  discoverMigrationModelRoleDependency,
  discoverMigrationPermissionDependencies,
  migrationContentAccessValue,
  migrationFilesHavePermissionEvidence,
  migrationModelRoleValue,
  migrationPermissionDecisionBlockers,
  migrationPermissionUserGroupNames,
  type MigrationPermissionDecision,
  type MigrationPermissionDependency,
  type MigrationPermissionFieldTarget,
  type MigrationPermissionFileMapping,
} from './dashboardMigrationPermissions';

export { redactSensitiveText, sanitizeJobHistory } from './jobSanitizer';
export type {
  MigrationPermissionCandidate,
  MigrationPermissionDecision,
  MigrationPermissionDecisionAction,
  MigrationPermissionDependency,
  MigrationPermissionKind,
  MigrationPermissionStatus,
} from './dashboardMigrationPermissions';

const DEFAULT_DESTINATION_CONCURRENCY = 10;
const DESTINATION_MODEL_MUTATION_UNCERTAIN_ERROR = 'A destination-model write outcome requires reconciliation before another workflow can use this model.';
const MUTATION_ADJUDICATION_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MUTATION_ADJUDICATION_OPERATIONS = new Set(['model_job', 'model_merge', 'legacy_dashboard_job', 'schema_refresh', 'scratch_validation']);
const MUTATION_ADJUDICATION_OUTCOMES = new Set(['verified_applied', 'verified_not_applied', 'verified_partial_terminal']);
const MUTATION_ADJUDICATION_SOURCES = new Set(['omni_ui', 'omni_api', 'external_system']);

function invalidateDocumentInventory(instanceId: string): void {
  clearReadThroughCache(`instance:${instanceId}:documents:`);
}

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'canceled';
export type JobItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'warning' | 'skipped';
export type MigrationWorkflow = 'dashboard' | 'model';
export type JobItemKind =
  | 'delete'
  | 'export'
  | 'update'
  | 'import'
  | 'metadata'
  | 'permission_prepare'
  | 'permission_apply'
  | 'permission_verify'
  | 'field_prepare'
  | 'query_view_prepare'
  | 'relationship_prepare'
  | 'topic_prepare'
  | 'semantic_validate'
  | 'query_validate'
  | 'document_verify'
  | 'post_action'
  | 'source_delete'
  | 'model_fast_path'
  | 'model_translate'
  | 'model_branch_create'
  | 'model_branch_delete'
  | 'model_yaml_write'
  | 'model_validate'
  | 'model_merge'
  | 'model_pr'
  | 'destination_model_mutation'
  | 'model_impact_report'
  | 'content_repair'
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

export interface DestinationModelMutationAdjudicationInput {
  requestId: string;
  itemId: string;
  expectedRevision: number;
  expectedUpdatedAt: number;
  destinationInstanceId: string;
  targetModelId: string;
  operation: string;
  dispatchItemId: string;
  dispatchItemKind: string;
  dispatchFingerprint: string;
  outcome: 'verified_applied' | 'verified_not_applied' | 'verified_partial_terminal';
  evidenceSource: 'omni_ui' | 'omni_api' | 'external_system';
  note: string;
  confirmCurrentStateInspected: true;
  confirmNoOperationInFlight: true;
}

export interface DestinationModelMutationAdjudicationResult {
  job: MigrationJob;
  item: MigrationJobItem;
  replayed: boolean;
}

export class DestinationModelMutationAdjudicationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = 'DestinationModelMutationAdjudicationError';
    this.code = code;
    this.statusCode = statusCode;
  }
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
  /** Reviewed deployment resolves defaults in the UI; absence means top level. */
  exactFolder?: boolean;
  destinationInstanceId: string;
  destinationLabel?: string;
  targetConnectionId?: string;
  targetModelId: string;
  targetModelName?: string;
  targetFolderId?: string;
  targetFolderPath?: string;
  sameNamedStrategy?: SameNamedStrategy;
  topicMappings?: MigrationTopicMapping[];
  queryViewMappings?: MigrationQueryViewMapping[];
  fieldMappings?: MigrationFieldMapping[];
  permissionDecisions?: MigrationPermissionDecision[];
  semanticPatches?: MigrationSemanticPatch[];
  queryValidationWaivers?: MigrationQueryValidationWaiver[];
  workbookCopy?: { stagingFolderId: string };
}

export interface MigrationQueryValidationWaiver {
  documentId: string;
  queryId: string;
  reason: string;
  acknowledgedAt?: string;
}

export type SameNamedStrategy = 'update' | 'replace';

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
  documentAccessPolicy?: 'migrate_explicit' | 'destination_defaults';
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
  modelValidation?: { issueCount: number; errorCount: number };
  contentValidation?: { issueCount: number; errorCount: number };
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
  requiredFieldRefs?: string[];
  suppliedFieldRefs?: string[];
  fieldEvidence?: {
    source: 'source_yaml' | 'target_yaml' | 'accepted_patch';
    fileName: string;
    verified: boolean;
  };
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
  sourceProvenance?: DashboardSourceFieldProvenance;
  sourceDocumentId?: string;
  fieldKind: MigrationFieldDependencyKind;
  sourceYaml?: string;
  targetCandidates: MigrationFieldCandidate[];
  status: MigrationFieldDependencyStatus;
  reason?: string;
  warnings?: string[];
}

export interface MigrationDependencyProposalWithheld {
  artifact: 'field' | 'query_view' | 'topic' | 'relationship';
  reference: string;
  reason: string;
  sourceDocumentId: string;
}

export interface MigrationFieldMapping {
  sourceFieldRef: string;
  action: MigrationFieldMappingAction;
  targetFieldRef?: string;
  targetFileName?: string;
  sourceFileName?: string;
}

export type MigrationSemanticPatchArtifact = 'permission' | 'field' | 'query_view' | 'topic' | 'relationship';
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

export type MigrationSemanticDependencyKind = 'dashboard' | 'permission' | 'topic' | 'query_view' | 'model_field' | 'relationship' | 'model_file';

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
  reviewToken?: string;
}

export interface ModelMigrationSemanticDecision {
  id: string;
  kind: 'view' | 'field' | 'topic' | 'relationship' | 'file';
  sourceName: string;
  targetName?: string;
  sourceFileName?: string;
  targetFileName?: string;
  action: 'map_existing' | 'create_from_source' | 'keep_target' | 'ignore' | 'custom_edit';
  required?: boolean;
  acceptedYaml?: string;
}

export interface ModelMigrationContentRepairAction {
  id: string;
  kind: 'field' | 'view' | 'topic';
  find: string;
  replacement: string;
  approved: boolean;
  includePersonalFolders?: boolean;
}

export interface ModelMigrationModelInput {
  sourceModelId: string;
  sourceModelName?: string;
  targetModelId: string;
  targetModelName?: string;
  targetConnectionId: string;
  mode: 'fast' | 'translate' | 'impact_report';
  branchName: string;
  gitRef?: string;
  fastPathSchemaConfirmed?: boolean;
  orgApiKeyConfirmed?: boolean;
  mergeHandoffRequired?: boolean;
  acceptedFiles?: ModelMigrationAcceptedFile[];
  semanticDecisions?: ModelMigrationSemanticDecision[];
  contentRepairActions?: ModelMigrationContentRepairAction[];
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
  dashboardRepair?: { planId: string; targetId: string; revision: number; additiveOnly?: true;
    targetModelHash?: string; sourceModelHashes?: Record<string, string>; approvedFilesHash?: string;
    sourceRelationEvidence?: Record<string, Record<string, string>>; targetRelationEvidence?: Record<string, string>;
    targetRelationInventoryHash?: string;
    sourceRelationInventoryHashes?: Record<string, string>;
    sourceDocumentHashes?: Record<string, string>; sourceWorkbookHashes?: Record<string, string>; instanceBoundaryHash?: string };
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
const activeDashboardTargets = new Map<string, MigrationTarget[]>();
const activeDestinationModelMutationJobs = new Map<string, MigrationJob>();
const activeSchemaRefreshReconciliations = new Set<string>();
const SCHEMA_REFRESH_SUCCESS_STATUSES = new Set(['COMPLETED']);
const SCHEMA_REFRESH_FAILED_STATUSES = new Set(['FAILED']);
const SCHEMA_REFRESH_MAX_POLL_ATTEMPTS = 120;
const SCHEMA_REFRESH_POLL_INTERVAL_MS = 1_000;
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

function requireModelMigrationInstance(id: string, usage: 'source' | 'destination'): SavedInstance {
  const instance = requireInstance(id);
  if (instance.role !== 'both' && instance.role !== usage) {
    throw Object.assign(
      new Error(`The saved instance is not authorized for Model Migrator ${usage} operations.`),
      {
        statusCode: 403,
        code: usage === 'source'
          ? 'MODEL_MIGRATOR_SOURCE_ROLE_REQUIRED'
          : 'MODEL_MIGRATOR_DESTINATION_ROLE_REQUIRED',
      },
    );
  }
  return instance;
}

function assertNoUnresolvedSafeCopyModelOverlap(
  destinationInstanceId: string,
  targetModelIds: readonly string[],
  excludeItemIds: ReadonlySet<string> = new Set(),
): void {
  const scopes = targetModelIds.map((targetModelId) => ({ destinationInstanceId, targetModelId }));
  if (
    !dashboardSafeCopyHasUnresolvedDestinationModelOverlap(destinationInstanceId, targetModelIds)
    && !hasUnresolvedMigrationDestinationModelMutation(
      listStoredJobs(Number.MAX_SAFE_INTEGER),
      scopes,
      { excludeItemIds },
    )
  ) return;
  throw Object.assign(
    new Error('A dashboard copy in this destination model still requires reconciliation before Model Migrator can write or publish.'),
    { statusCode: 409, code: 'MODEL_MIGRATOR_SAFE_COPY_SCOPE_CONFLICT' },
  );
}

const DESTINATION_MODEL_MUTATION_KINDS = new Set<JobItemKind>([
  'delete',
  'update',
  'import',
  'metadata',
  'permission_prepare',
  'permission_apply',
  'field_prepare',
  'query_view_prepare',
  'relationship_prepare',
  'topic_prepare',
  'model_fast_path',
  'model_branch_create',
  'model_branch_delete',
  'model_yaml_write',
  'content_repair',
  'model_merge',
  'model_pr',
  'workbook_create',
  'post_action',
  'source_delete',
]);

function normalizedDestinationModelScopes(
  scopes: readonly MigrationDestinationModelScope[],
): MigrationDestinationModelScope[] {
  const unique = new Map<string, MigrationDestinationModelScope>();
  for (const scope of scopes) {
    const destinationInstanceId = scope.destinationInstanceId.trim();
    const targetModelId = scope.targetModelId.trim();
    if (!destinationInstanceId || !targetModelId) continue;
    unique.set(`${destinationInstanceId}\u0000${targetModelId}`, { destinationInstanceId, targetModelId });
  }
  return [...unique.values()].sort((left, right) => (
    left.destinationInstanceId.localeCompare(right.destinationInstanceId)
    || left.targetModelId.localeCompare(right.targetModelId)
  ));
}

function destinationModelMutationScopes(job: MigrationJob): MigrationDestinationModelScope[] {
  return normalizedDestinationModelScopes(job.items.flatMap((item) => (
    DESTINATION_MODEL_MUTATION_KINDS.has(item.kind)
    && item.details?.noMutation !== true
    && item.targetModelId
      ? [{ destinationInstanceId: item.destinationId, targetModelId: item.targetModelId }]
      : []
  )));
}

function destinationModelMutationLeaseId(
  jobId: string,
  operation: string,
  scope: MigrationDestinationModelScope,
): string {
  const digest = createHash('sha256')
    .update(`${jobId}\u0000${operation}\u0000${scope.destinationInstanceId}\u0000${scope.targetModelId}`)
    .digest('hex');
  return `destination-model-mutation:${digest}`;
}

function destinationModelMutationLeaseItem(
  job: MigrationJob,
  scope: MigrationDestinationModelScope,
  operation: string,
  state: MigrationDestinationModelMutationState,
  now: number,
  previous?: MigrationJobItem,
  externalJobId?: string,
  dispatchItem?: MigrationJobItem,
): MigrationJobItem {
  const terminal = state === 'resolved' || state === 'failed_prewrite';
  const retainedExternalJobId = externalJobId
    || (!dispatchItem && state !== 'claimed' && typeof previous?.details?.migrationMutationExternalJobId === 'string'
      ? previous.details.migrationMutationExternalJobId
      : undefined);
  const previousRevision = typeof previous?.details?.migrationMutationRevision === 'number'
    && Number.isSafeInteger(previous.details.migrationMutationRevision)
    && previous.details.migrationMutationRevision > 0
    ? previous.details.migrationMutationRevision
    : 0;
  const retainedDispatchItemId = dispatchItem?.id
    || (state !== 'claimed' && typeof previous?.details?.migrationMutationDispatchItemId === 'string'
      ? previous.details.migrationMutationDispatchItemId
      : undefined);
  const retainedDispatchItemKind = dispatchItem?.kind
    || (state !== 'claimed' && typeof previous?.details?.migrationMutationDispatchItemKind === 'string'
      ? previous.details.migrationMutationDispatchItemKind
      : undefined);
  const retainedDispatchedAt = dispatchItem
    ? now
    : state !== 'claimed' && typeof previous?.details?.migrationMutationDispatchedAt === 'number'
      && Number.isSafeInteger(previous.details.migrationMutationDispatchedAt)
      && previous.details.migrationMutationDispatchedAt > 0
      ? previous.details.migrationMutationDispatchedAt
      : undefined;
  const retainedDispatchFingerprint = dispatchItem
    ? createHash('sha256').update(JSON.stringify({
      jobId: dispatchItem.jobId,
      itemId: dispatchItem.id,
      kind: dispatchItem.kind,
      destinationId: dispatchItem.destinationId,
      targetModelId: dispatchItem.targetModelId || null,
      targetId: dispatchItem.targetId || null,
      routeGroupId: dispatchItem.routeGroupId || null,
      documentId: dispatchItem.documentId || null,
      targetFolderId: dispatchItem.targetFolderId || null,
      targetFolderPath: dispatchItem.targetFolderPath || null,
      replacement: dispatchItem.replacement === true,
      details: dispatchItem.details || null,
    })).digest('hex')
    : state !== 'claimed' && typeof previous?.details?.migrationMutationDispatchFingerprint === 'string'
      ? previous.details.migrationMutationDispatchFingerprint
      : undefined;
  return {
    ...(previous || {}),
    id: destinationModelMutationLeaseId(job.id, operation, scope),
    jobId: job.id,
    destinationId: scope.destinationInstanceId,
    destinationLabel: job.targets?.find((target) => (
      target.destinationInstanceId === scope.destinationInstanceId
      && target.targetModelId === scope.targetModelId
    ))?.destinationLabel || previous?.destinationLabel || 'Destination model',
    targetModelId: scope.targetModelId,
    targetModelName: job.targets?.find((target) => (
      target.destinationInstanceId === scope.destinationInstanceId
      && target.targetModelId === scope.targetModelId
    ))?.targetModelName || previous?.targetModelName,
    kind: 'destination_model_mutation',
    status: state === 'claimed' ? 'pending' : state === 'dispatched' || state === 'remote_pending' ? 'running' : state === 'uncertain' ? 'warning' : state === 'resolved' ? 'succeeded' : 'failed',
    error: state === 'uncertain'
      ? DESTINATION_MODEL_MUTATION_UNCERTAIN_ERROR
      : state === 'failed_prewrite'
        ? 'The destination-model operation stopped before an external write was dispatched.'
        : undefined,
    startedAt: previous?.startedAt || now,
    endedAt: terminal || state === 'uncertain' ? now : undefined,
    details: {
      migrationDestinationModelMutation: true,
      migrationMutationState: state,
      migrationMutationOperation: operation,
      migrationMutationUpdatedAt: now,
      migrationMutationRevision: previousRevision + 1,
      ...(retainedExternalJobId ? { migrationMutationExternalJobId: retainedExternalJobId } : {}),
      ...(retainedDispatchItemId ? { migrationMutationDispatchItemId: retainedDispatchItemId } : {}),
      ...(retainedDispatchItemKind ? { migrationMutationDispatchItemKind: retainedDispatchItemKind } : {}),
      ...(retainedDispatchedAt ? { migrationMutationDispatchedAt: retainedDispatchedAt } : {}),
      ...(retainedDispatchFingerprint ? { migrationMutationDispatchFingerprint: retainedDispatchFingerprint } : {}),
    },
  };
}

function syncMutationLeaseItems(job: MigrationJob, stored: MigrationJob, itemIds: ReadonlySet<string>): void {
  const retained = job.items.filter((item) => !itemIds.has(item.id));
  const leases = stored.items.filter((item) => itemIds.has(item.id));
  job.items = [...retained, ...leases];
}

function beginDestinationModelMutation(
  job: MigrationJob,
  scopes: readonly MigrationDestinationModelScope[],
  operation: string,
): ReadonlySet<string> {
  const normalized = normalizedDestinationModelScopes(scopes);
  if (normalized.length === 0) return new Set();
  const itemIds = new Set(normalized.map((scope) => destinationModelMutationLeaseId(job.id, operation, scope)));
  if (operation !== 'scratch_validation' && hasUnresolvedMigrationDestinationModelMutation(
    listStoredJobs(Number.MAX_SAFE_INTEGER),
    normalized,
    { excludeItemIds: itemIds },
  )) throw new MigrationScopeReservationError();
  const now = Date.now();
  const updated = updateJobAtomically(job.id, (current) => {
    const items = [...current.items];
    for (const scope of normalized) {
      const itemId = destinationModelMutationLeaseId(current.id, operation, scope);
      const index = items.findIndex((item) => item.id === itemId);
      const previous = index >= 0 ? items[index] : undefined;
      const parsed = previous ? migrationDestinationModelMutationLease(previous) : undefined;
      if (parsed?.state === 'claimed' || parsed?.state === 'dispatched' || parsed?.state === 'remote_pending' || parsed?.state === 'uncertain') {
        throw new MigrationScopeReservationError();
      }
      const next = destinationModelMutationLeaseItem(current, scope, operation, 'claimed', now, previous);
      if (index >= 0) items[index] = next;
      else items.push(next);
    }
    return { ...current, items };
  });
  if (!updated) throw new Error('Migration job disappeared before destination-model ownership was persisted.');
  syncMutationLeaseItems(job, updated, itemIds);
  activeDestinationModelMutationJobs.set(job.id, job);
  return itemIds;
}

function dispatchDestinationModelMutationForItem(item: MigrationJobItem): void {
  if (
    !DESTINATION_MODEL_MUTATION_KINDS.has(item.kind)
    || item.details?.noMutation === true
    || !item.targetModelId
  ) return;
  const now = Date.now();
  const changedItemIds = new Set<string>();
  const updated = updateJobAtomically(item.jobId, (current) => {
    const matching = current.items.flatMap((candidate) => {
      const lease = migrationDestinationModelMutationLease(candidate);
      return lease
        && lease.destinationInstanceId === item.destinationId
        && lease.targetModelId === item.targetModelId
        ? [{ candidate, lease }]
        : [];
    });
    const active = matching.filter(({ lease }) => (
      lease.state === 'claimed'
      || lease.state === 'dispatched'
      || lease.state === 'remote_pending'
      || lease.state === 'uncertain'
    ));
    const selected = active.length === 1
      ? active[0]
      : active.length === 0 && matching.length === 1
        ? matching[0]
        : undefined;
    if (!selected) {
      throw new MigrationScopeReservationError();
    }
    const { candidate: matchingItem, lease: matchingLease } = selected;
    if (matchingLease.state === 'uncertain' || matchingLease.state === 'remote_pending') {
      throw new MigrationScopeReservationError();
    }
    if (matchingLease.state === 'dispatched') {
      if (matchingLease.dispatchItemId === item.id && matchingLease.dispatchItemKind === item.kind) return current;
      const previousDispatchItem = matchingLease.dispatchItemId
        ? current.items.find((candidate) => candidate.id === matchingLease.dispatchItemId)
        : undefined;
      if (
        matchingLease.operation !== 'scratch_validation'
        || !previousDispatchItem
        || previousDispatchItem.kind !== matchingLease.dispatchItemKind
        || previousDispatchItem.status !== 'succeeded'
      ) throw new MigrationScopeReservationError();
    }
    changedItemIds.add(matchingItem.id);
    return {
      ...current,
      items: current.items.map((candidate) => candidate.id === matchingItem.id
        ? destinationModelMutationLeaseItem(current, matchingLease, matchingLease.operation, 'dispatched', now, candidate, undefined, item)
        : candidate),
    };
  });
  if (!updated) throw new Error('Migration job disappeared before destination-model write dispatch.');
  if (changedItemIds.size === 0) return;
  const activeJob = activeDestinationModelMutationJobs.get(item.jobId);
  if (activeJob) syncMutationLeaseItems(activeJob, updated, changedItemIds);
}

function settleDestinationModelMutationForItem(item: MigrationJobItem): void {
  if (
    !DESTINATION_MODEL_MUTATION_KINDS.has(item.kind)
    || item.details?.noMutation === true
    || !item.targetModelId
    || item.status === 'pending'
    || item.status === 'running'
  ) return;
  if (
    item.details?.migrationMutationRetainUntilCleanup === true
    && item.status !== 'failed'
  ) return;
  const nextState: MigrationDestinationModelMutationState = (
    (item.status === 'failed' || item.status === 'warning')
    && item.details?.migrationMutationTerminal !== true
  ) ? 'uncertain' : 'resolved';
  const changedItemIds = new Set<string>();
  const updated = updateJobAtomically(item.jobId, (current) => ({
    ...current,
    items: current.items.map((candidate) => {
      const lease = migrationDestinationModelMutationLease(candidate);
      if (
        !lease
        || lease.destinationInstanceId !== item.destinationId
        || lease.targetModelId !== item.targetModelId
        || (lease.state !== 'claimed' && (
          lease.dispatchItemId !== item.id
          || lease.dispatchItemKind !== item.kind
        ))
        || (lease.state !== 'claimed' && lease.state !== 'dispatched' && lease.state !== 'remote_pending')
      ) return candidate;
      changedItemIds.add(candidate.id);
      const settledState: MigrationDestinationModelMutationState = lease.state === 'claimed'
        ? 'failed_prewrite'
        : nextState;
      return destinationModelMutationLeaseItem(current, lease, lease.operation, settledState, Date.now(), candidate);
    }),
  }));
  if (!updated || changedItemIds.size === 0) return;
  const activeJob = activeDestinationModelMutationJobs.get(item.jobId);
  if (activeJob) syncMutationLeaseItems(activeJob, updated, changedItemIds);
}

function attachExternalJobToDestinationModelMutation(
  job: MigrationJob,
  scope: MigrationDestinationModelScope,
  externalJobId: string,
  dispatchItemId: string,
): void {
  const boundedExternalJobId = externalJobId.trim();
  if (!boundedExternalJobId || boundedExternalJobId.length > 1_024) {
    throw new Error('Schema refresh did not return a bounded external job identifier.');
  }
  const changedItemIds = new Set<string>();
  const updated = updateJobAtomically(job.id, (current) => ({
    ...current,
    items: current.items.map((item) => {
      const lease = migrationDestinationModelMutationLease(item);
      if (
        !lease
        || lease.destinationInstanceId !== scope.destinationInstanceId
        || lease.targetModelId !== scope.targetModelId
        || lease.dispatchItemId !== dispatchItemId
        || lease.dispatchItemKind !== 'post_action'
        || lease.state !== 'dispatched'
      ) return item;
      changedItemIds.add(item.id);
      return destinationModelMutationLeaseItem(
        current,
        lease,
        lease.operation,
        'remote_pending',
        Date.now(),
        item,
        boundedExternalJobId,
      );
    }),
  }));
  if (!updated || changedItemIds.size === 0) {
    throw new Error('Schema refresh ownership was unavailable before remote job tracking.');
  }
  syncMutationLeaseItems(job, updated, changedItemIds);
}

function finishDestinationModelMutation(
  job: MigrationJob,
  itemIds: ReadonlySet<string>,
  state: MigrationDestinationModelMutationState,
  externalJobId?: string,
): void {
  if (itemIds.size === 0) return;
  const now = Date.now();
  const updated = updateJobAtomically(job.id, (current) => ({
    ...current,
    items: current.items.map((item) => {
      if (!itemIds.has(item.id)) return item;
      const parsed = migrationDestinationModelMutationLease(item);
      if (!parsed) return item;
      return destinationModelMutationLeaseItem(current, parsed, parsed.operation, state, now, item, externalJobId);
    }),
  }));
  if (!updated) throw new Error('Migration job disappeared before destination-model ownership was finalized.');
  syncMutationLeaseItems(job, updated, itemIds);
  if (state !== 'claimed' && state !== 'dispatched' && state !== 'remote_pending') {
    activeDestinationModelMutationJobs.delete(job.id);
  }
}

function finalizeDestinationModelMutations(
  job: MigrationJob,
  itemIds: ReadonlySet<string>,
): boolean {
  if (itemIds.size === 0) return false;
  const changedItemIds = new Set<string>();
  const updated = updateJobAtomically(job.id, (current) => ({
    ...current,
    items: current.items.map((item) => {
      if (!itemIds.has(item.id)) return item;
      const lease = migrationDestinationModelMutationLease(item);
      if (!lease || (lease.state !== 'claimed' && lease.state !== 'dispatched' && lease.state !== 'remote_pending')) {
        return item;
      }
      changedItemIds.add(item.id);
      return destinationModelMutationLeaseItem(
        current,
        lease,
        lease.operation,
        lease.state === 'claimed' ? 'failed_prewrite' : 'uncertain',
        Date.now(),
        item,
      );
    }),
  }));
  if (!updated) throw new Error('Migration job disappeared before destination-model ownership was finalized.');
  if (changedItemIds.size > 0) syncMutationLeaseItems(job, updated, changedItemIds);
  activeDestinationModelMutationJobs.delete(job.id);
  return updated.items.some((item) => {
    if (!itemIds.has(item.id)) return false;
    const lease = migrationDestinationModelMutationLease(item);
    return lease?.state === 'dispatched' || lease?.state === 'remote_pending' || lease?.state === 'uncertain';
  });
}

function boundedMutationAdjudicationText(value: string, maximum = 1_024): string | undefined {
  if (!value || value !== value.trim() || value.length > maximum) return undefined;
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) ? undefined : value;
}

function mutationAdjudicationRequestHash(input: DestinationModelMutationAdjudicationInput): string {
  return createHash('sha256').update(JSON.stringify({
    requestId: input.requestId,
    itemId: input.itemId,
    expectedRevision: input.expectedRevision,
    expectedUpdatedAt: input.expectedUpdatedAt,
    destinationInstanceId: input.destinationInstanceId,
    targetModelId: input.targetModelId,
    operation: input.operation,
    dispatchItemId: input.dispatchItemId,
    dispatchItemKind: input.dispatchItemKind,
    dispatchFingerprint: input.dispatchFingerprint,
    outcome: input.outcome,
    evidenceSource: input.evidenceSource,
    note: input.note,
    confirmCurrentStateInspected: input.confirmCurrentStateInspected,
    confirmNoOperationInFlight: input.confirmNoOperationInFlight,
  })).digest('hex');
}

function assertMutationAdjudicationInput(input: DestinationModelMutationAdjudicationInput): void {
  const allowedKeys = new Set([
    'requestId',
    'itemId',
    'expectedRevision',
    'expectedUpdatedAt',
    'destinationInstanceId',
    'targetModelId',
    'operation',
    'dispatchItemId',
    'dispatchItemKind',
    'dispatchFingerprint',
    'outcome',
    'evidenceSource',
    'note',
    'confirmCurrentStateInspected',
    'confirmNoOperationInFlight',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_INVALID',
      'Mutation adjudication contains an unsupported field.',
      400,
    );
  }
  if (!MUTATION_ADJUDICATION_REQUEST_ID.test(input.requestId) || input.requestId !== input.requestId.toLowerCase()) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_INVALID',
      'Mutation adjudication requires a canonical idempotency request ID.',
      400,
    );
  }
  if (
    !boundedMutationAdjudicationText(input.itemId)
    || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1
    || !Number.isSafeInteger(input.expectedUpdatedAt)
    || input.expectedUpdatedAt < 1
    || !boundedMutationAdjudicationText(input.destinationInstanceId)
    || !boundedMutationAdjudicationText(input.targetModelId)
    || !boundedMutationAdjudicationText(input.operation, 64)
    || !MUTATION_ADJUDICATION_OPERATIONS.has(input.operation)
    || !boundedMutationAdjudicationText(input.dispatchItemId)
    || !boundedMutationAdjudicationText(input.dispatchItemKind, 64)
    || !/^[0-9a-f]{64}$/i.test(input.dispatchFingerprint)
    || !MUTATION_ADJUDICATION_OUTCOMES.has(input.outcome)
    || !MUTATION_ADJUDICATION_SOURCES.has(input.evidenceSource)
    || !boundedMutationAdjudicationText(input.note, 500)
    || input.confirmCurrentStateInspected !== true
    || input.confirmNoOperationInFlight !== true
  ) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_INVALID',
      'Mutation adjudication evidence is incomplete or malformed.',
      400,
    );
  }
}

/**
 * Transfers the missing external fact for a non-trackable mutation outcome to
 * the unlocked local operator. This is an exact, audited adjudication; it does
 * not retry a write, infer an outcome, or turn the original failed work item
 * into success.
 */
export function adjudicateDestinationModelMutation(
  jobId: string,
  input: DestinationModelMutationAdjudicationInput,
): DestinationModelMutationAdjudicationResult {
  if (!isVaultUnlocked()) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_LOCKED',
      'Unlock the local vault before adjudicating an uncertain mutation.',
      423,
    );
  }
  assertMutationAdjudicationInput(input);
  const requestHash = mutationAdjudicationRequestHash(input);
  let replayed = false;
  let resolvedLeaseOperation = '';
  let resolvedScope: MigrationDestinationModelScope | undefined;
  const updated = updateJobAtomically(jobId, (current) => {
    if (!isTerminalJobStatus(current.status) || runningJobs.has(current.id)) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_ACTIVE',
        'The migration must be stopped before an uncertain mutation can be adjudicated.',
      );
    }
    const matches = current.items.filter((candidate) => candidate.id === input.itemId);
    if (matches.length !== 1) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_SCOPE_MISMATCH',
        'The exact mutation lease could not be identified.',
      );
    }
    const leaseItem = matches[0];
    const lease = migrationDestinationModelMutationLease(leaseItem);
    if (!lease || lease.jobId !== current.id || lease.itemId !== leaseItem.id) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_EVIDENCE_INVALID',
        'The mutation lease evidence is malformed.',
      );
    }
    const existingRequestId = leaseItem.details?.migrationMutationResolutionRequestId;
    const existingRequestHash = leaseItem.details?.migrationMutationResolutionRequestHash;
    const priorAdjudications = Array.isArray(current.details?.migrationMutationAdjudications)
      ? current.details.migrationMutationAdjudications
      : [];
    const priorRequestMatches = priorAdjudications.filter((candidate) => (
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).requestId === input.requestId
    )) as Array<Record<string, unknown>>;
    if (priorRequestMatches.length > 1) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_EVIDENCE_INVALID',
        'The adjudication idempotency history is ambiguous.',
      );
    }
    if (priorRequestMatches.length === 1 && (
      lease.state !== 'resolved'
      || existingRequestId !== input.requestId
      || existingRequestHash !== requestHash
      || priorRequestMatches[0].requestHash !== requestHash
    )) {
      throw new DestinationModelMutationAdjudicationError(
        priorRequestMatches[0].requestHash === requestHash
          ? 'MIGRATION_MUTATION_ADJUDICATION_STALE_REPLAY'
          : 'MIGRATION_MUTATION_ADJUDICATION_IDEMPOTENCY_CONFLICT',
        'This adjudication request ID was already used for different or superseded mutation evidence.',
      );
    }
    if (lease.state === 'resolved') {
      if (
        priorRequestMatches.length === 1
        && existingRequestId === input.requestId
        && existingRequestHash === requestHash
        && priorRequestMatches[0].requestHash === requestHash
      ) {
        replayed = true;
        resolvedLeaseOperation = lease.operation;
        resolvedScope = lease;
        return current;
      }
      throw new DestinationModelMutationAdjudicationError(
        existingRequestId === input.requestId
          ? 'MIGRATION_MUTATION_ADJUDICATION_IDEMPOTENCY_CONFLICT'
          : 'MIGRATION_MUTATION_ALREADY_ADJUDICATED',
        'This mutation lease has already been adjudicated with different evidence.',
      );
    }
    if (
      lease.state !== 'uncertain'
      || leaseItem.kind !== 'destination_model_mutation'
      || leaseItem.status !== 'warning'
      || leaseItem.endedAt !== lease.updatedAt
      || leaseItem.error !== DESTINATION_MODEL_MUTATION_UNCERTAIN_ERROR
      || lease.revision !== input.expectedRevision
      || lease.updatedAt !== input.expectedUpdatedAt
      || lease.destinationInstanceId !== input.destinationInstanceId
      || lease.targetModelId !== input.targetModelId
      || lease.operation !== input.operation
      || lease.dispatchItemId !== input.dispatchItemId
      || lease.dispatchItemKind !== input.dispatchItemKind
      || lease.dispatchFingerprint !== input.dispatchFingerprint
    ) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_CAS_MISMATCH',
        'The mutation evidence changed before adjudication; reload and inspect the current external state again.',
      );
    }
    if (activeSchemaRefreshReconciliations.has(`${current.id}:${leaseItem.id}`)) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_ACTIVE',
        'Automatic reconciliation is still reading the tracked external job.',
      );
    }
    const dispatchedItems = current.items.filter((candidate) => candidate.id === lease.dispatchItemId);
    if (dispatchedItems.length !== 1) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_EVIDENCE_INVALID',
        'The exact dispatched business item could not be identified.',
      );
    }
    const dispatchedItem = dispatchedItems[0];
    if (
      dispatchedItem.jobId !== current.id
      || dispatchedItem.kind !== lease.dispatchItemKind
      || dispatchedItem.destinationId !== lease.destinationInstanceId
      || dispatchedItem.targetModelId !== lease.targetModelId
      || dispatchedItem.status === 'pending'
      || dispatchedItem.status === 'running'
    ) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_EVIDENCE_INVALID',
        'The dispatched business-item evidence is not terminal or does not match the lease.',
      );
    }
    const now = Date.now();
    const resolvedItem = destinationModelMutationLeaseItem(
      current,
      lease,
      lease.operation,
      'resolved',
      now,
      leaseItem,
    );
    resolvedItem.notices = [
      ...(leaseItem.notices || []),
      'An unlocked local operator confirmed that the external mutation is terminal after inspecting its current state.',
    ];
    resolvedItem.details = {
      ...(resolvedItem.details || {}),
      migrationMutationResolutionKind: 'operator_adjudication',
      migrationMutationResolutionActor: 'local_unlocked_operator',
      migrationMutationResolutionRequestId: input.requestId,
      migrationMutationResolutionRequestHash: requestHash,
      migrationMutationResolutionOutcome: input.outcome,
      migrationMutationResolutionEvidenceSource: input.evidenceSource,
      migrationMutationResolutionConfirmedAt: now,
      migrationMutationResolutionExpectedRevision: input.expectedRevision,
      migrationMutationResolutionExpectedUpdatedAt: input.expectedUpdatedAt,
    };
    if (priorAdjudications.length >= 1_000) {
      throw new DestinationModelMutationAdjudicationError(
        'MIGRATION_MUTATION_ADJUDICATION_CAPACITY',
        'This migration has reached its bounded adjudication-history capacity.',
      );
    }
    const adjudication = {
      requestId: input.requestId,
      requestHash,
      leaseItemId: lease.itemId,
      priorRevision: lease.revision,
      resolvedRevision: (lease.revision || 0) + 1,
      priorUpdatedAt: lease.updatedAt,
      destinationInstanceId: lease.destinationInstanceId,
      targetModelId: lease.targetModelId,
      operation: lease.operation,
      dispatchItemId: lease.dispatchItemId,
      dispatchItemKind: lease.dispatchItemKind,
      dispatchFingerprint: lease.dispatchFingerprint,
      outcome: input.outcome,
      evidenceSource: input.evidenceSource,
      note: redactSensitiveText(input.note),
      actor: 'local_unlocked_operator',
      adjudicatedAt: now,
    };
    resolvedLeaseOperation = lease.operation;
    resolvedScope = lease;
    return {
      ...current,
      details: {
        ...(current.details || {}),
        migrationMutationAdjudications: [...priorAdjudications, adjudication],
      },
      items: current.items.map((candidate) => candidate.id === leaseItem.id ? resolvedItem : candidate),
    };
  });
  if (!updated || !resolvedScope || !resolvedLeaseOperation) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_NOT_FOUND',
      'The migration job was not found.',
      404,
    );
  }
  releaseMigrationDestinationModel(mutationReservationOwner(updated, resolvedLeaseOperation), resolvedScope);
  const resolvedItem = updated.items.find((candidate) => candidate.id === input.itemId);
  if (!resolvedItem) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_EVIDENCE_INVALID',
      'The adjudicated mutation item disappeared after persistence.',
    );
  }
  if (!replayed) {
    try {
      publishMigrationJobEvent({
        type: 'item',
        jobId: updated.id,
        itemId: resolvedItem.id,
        destinationId: resolvedItem.destinationId,
        status: resolvedItem.status,
        at: Date.now(),
        item: resolvedItem,
      });
      publishMigrationJobEvent({
        type: 'job',
        jobId: updated.id,
        status: updated.status,
        at: Date.now(),
        job: updated,
      });
    } catch {
      // Durable adjudication remains authoritative if a process-local listener fails.
    }
  }
  return { job: updated, item: resolvedItem, replayed };
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
  const warnings = items.filter((item) => item.status === 'warning').length;
  const succeeded = items.filter((item) => item.status === 'succeeded').length;
  if (failed === 0 && warnings === 0) return 'succeeded';
  if (failed === 0 && warnings > 0) return 'partial';
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
  if (status !== 'running') settleDestinationModelMutationForItem(item);
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
  if (fileName.endsWith('.query.view')) return [withoutQuerySuffix];
  return [...new Set([withoutSuffix, leaf, withoutQuerySuffix].filter(Boolean))];
}

function semanticYamlFileForViewName(files: Record<string, string>, viewName: string): string | undefined {
  const normalizedViewName = viewName.trim().toLowerCase();
  return Object.keys(files).find((fileName) => (
    fileName.endsWith('.view')
    && viewNameVariants(fileName).some((candidate) => candidate.toLowerCase() === normalizedViewName)
  ));
}

function semanticYamlFileByLeaf(files: Record<string, string>, sourceFileName: string): string | undefined {
  if (files[sourceFileName] !== undefined) return sourceFileName;
  const leaf = sourceFileName.split('/').pop()?.toLowerCase();
  if (!leaf) return undefined;
  const matches = Object.keys(files).filter((fileName) => fileName.split('/').pop()?.toLowerCase() === leaf);
  return matches.length === 1 ? matches[0] : undefined;
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

  // Omni accepts inline and quoted object maps in query-view YAML. Preserve the
  // line-oriented parser above for source formatting, then fill any missed
  // definitions from a structured parse so readiness and execution agree.
  try {
    const parsed = parseYaml(yaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const parsedRecord = parsed as Record<string, unknown>;
      const existingKeys = new Set(definitions.map((definition) => definition.fieldRef.toLowerCase()));
      for (const [sectionName, fieldKind] of [
        ['dimensions', 'dimension'],
        ['measures', 'measure'],
      ] as const) {
        const section = parsedRecord[sectionName];
        if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
        for (const [fieldName, rawDefinition] of Object.entries(section as Record<string, unknown>)) {
          if (!/^[A-Za-z_][\w]*$/.test(fieldName)) continue;
          const serialized = stringifyYaml({
            [fieldName]: rawDefinition && typeof rawDefinition === 'object' ? rawDefinition : {},
          }, { lineWidth: 0 }).trimEnd();
          const sourceYaml = serialized.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
          const label = rawDefinition
            && typeof rawDefinition === 'object'
            && !Array.isArray(rawDefinition)
            && typeof (rawDefinition as Record<string, unknown>).label === 'string'
            ? String((rawDefinition as Record<string, unknown>).label)
            : undefined;
          for (const viewName of viewNames) {
            const fieldRef = `${viewName}.${fieldName}`;
            if (existingKeys.has(fieldRef.toLowerCase())) continue;
            definitions.push({
              fieldRef,
              sourceViewName: viewName,
              sourceFieldName: fieldName,
              sourceFileName: fileName,
              fieldKind,
              sourceYaml,
              ...(label ? { label } : {}),
            });
            existingKeys.add(fieldRef.toLowerCase());
          }
        }
      }
    }
  } catch {
    // Invalid YAML remains a readiness concern elsewhere; field extraction is
    // intentionally best effort and must not hide the original validation path.
  }

  return definitions;
}

function mergeFieldDefinitions(
  target: Map<string, ModelFieldDefinition>,
  files: Iterable<Pick<OmniModelQueryViewRecord, 'fileName' | 'yaml'>>,
): void {
  for (const file of files) {
    if (!file.yaml) continue;
    for (const definition of extractFieldDefinitionsFromViewYaml(file.fileName, file.yaml)) {
      if (!target.has(definition.fieldRef.toLowerCase())) {
        target.set(definition.fieldRef.toLowerCase(), definition);
      }
    }
  }
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
      const unresolvedReason = sourceDefinition
        ? `Choose how to resolve ${fieldRef} before importing this dashboard.${parentReason}`
        : `OmniKit could not verify the source definition for ${fieldRef}. Review its query-view decision, map it manually to a compatible target field, or intentionally ignore it.${parentReason}`;
      fieldDependencies.push(dependencyFromFieldRef({
        fieldRef,
        sourceDefinitions: input.sourceDefinitions,
        targetDefinitions: input.targetDefinitions,
        status: 'unresolved',
        reason: unresolvedReason,
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
      const targetDefinition = input.targetDefinitions.get(targetFieldRef.toLowerCase());
      if (
        sourceDefinition?.fieldKind
        && sourceDefinition.fieldKind !== 'unknown'
        && targetDefinition?.fieldKind
        && targetDefinition.fieldKind !== 'unknown'
        && sourceDefinition.fieldKind !== targetDefinition.fieldKind
      ) {
        fieldDependencies.push(dependencyFromFieldRef({
          fieldRef,
          sourceDefinitions: input.sourceDefinitions,
          targetDefinitions: input.targetDefinitions,
          status: 'blocked',
          reason: `Cannot map source ${sourceDefinition.fieldKind} ${fieldRef} to target ${targetDefinition.fieldKind} ${targetFieldRef}.`,
        }));
        fieldBlockers.push(`Field kind mismatch: ${fieldRef} is a ${sourceDefinition.fieldKind}, but ${targetFieldRef} is a ${targetDefinition.fieldKind}.`);
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
	  const baseSafety = updatePatchSafety({
	    currentYaml: targetQueryView?.yaml,
	    previousChecksum: targetQueryView?.checksum,
	    destructive: input.mapping.action === 'update_existing',
	    createCategory: 'safe_create',
	    updateCategory: 'safe_update',
	  });
	  const targetOnlyFields = input.mapping.action === 'update_existing'
	    ? targetOnlyQueryViewFields(sourceQueryView, targetQueryView)
	    : [];
	  const targetOnlyWarning = targetOnlyFields.length > 0
	    ? `Target query view ${targetQueryView?.label || targetQueryView?.name || input.mapping.targetQueryViewName} has fields not present in the source copy: ${formatFieldList(targetOnlyFields)}. Use Code review to merge those target-only fields intentionally, or choose Use existing unchanged.`
	    : undefined;
	  const safety = targetOnlyWarning
	    ? {
	      ...baseSafety,
	      status: 'blocked' as const,
	      safetyCategory: 'blocked' as const,
	      warnings: [...baseSafety.warnings, targetOnlyWarning],
	    }
	    : baseSafety;
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
	    recommendedAction: targetOnlyWarning
	      ? `Review and merge destination query view ${targetQueryView?.label || targetQueryView?.name || input.mapping.targetQueryViewName}; the source copy would remove target-only fields.`
	      : input.mapping.action === 'update_existing'
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
  conflictingRelationshipEdges: RelationshipEdgeReference[];
}): MigrationSemanticPatch | undefined {
  if (input.relationshipEdges.length === 0 && input.conflictingRelationshipEdges.length === 0) return undefined;
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
	  const conflictingEdges = input.conflictingRelationshipEdges
	    .map((edge) => sourceEdgesByKey.get(relationshipEdgeKey(edge)))
	    .filter((edge): edge is RelationshipEdgeDetail => Boolean(edge));
	  if (edgesToWrite.length === 0 && conflictingEdges.length === 0) return undefined;
	  const recommendedYaml = mergeRelationshipYaml(input.targetFiles.relationships, edgesToWrite);
	  const safety = updatePatchSafety({
	    currentYaml: input.targetFiles.relationships,
	    previousChecksum: input.targetChecksums?.relationships,
	    createCategory: 'safe_create',
	    updateCategory: 'safe_update',
	  });
	  const hasConflicts = conflictingEdges.length > 0;
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
	    status: hasConflicts ? 'warning' : safety.status,
	    safetyCategory: hasConflicts ? 'manual_review' : safety.safetyCategory,
	    recommendedAction: hasConflicts
	      ? `Review ${conflictingEdges.length} relationship conflict${conflictingEdges.length === 1 ? '' : 's'}. Keep the target YAML when its join logic is intentional, or edit the YAML before migration.`
	      : `Add ${edgesToWrite.length} relationship edge${edgesToWrite.length === 1 ? '' : 's'} required by query views.`,
	    dependencyPath: [
	      { kind: 'query_view', label: 'Required query views', detail: 'Copied or updated query views require this join path.' },
	      { kind: 'relationship', label: `${edgesToWrite.length} relationship edge${edgesToWrite.length === 1 ? '' : 's'}`, ref: 'relationships', detail: 'Destination relationships YAML will be updated.' },
	      { kind: 'model_file', label: 'relationships', ref: 'relationships', detail: input.targetFiles.relationships ? 'Destination relationships file will be updated.' : 'Destination relationships file will be created.' },
	    ],
	    warnings: [
	      ...(edgesToWrite.length > 0
	        ? [`Adds ${edgesToWrite.length} missing relationship edge${edgesToWrite.length === 1 ? '' : 's'} required by query views.`]
	        : []),
	      ...conflictingEdges.map((edge) => `Target relationship ${relationshipEdgeSummary(edge)} differs from the source. Choose which YAML to preserve before migration.`),
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
  fileName?: string;
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
  requiredFieldRefs: string[];
  suppliedFieldRefs?: string[];
  fieldEvidence?: MigrationQueryViewMapping['fieldEvidence'];
  reason?: string;
  compatibility?: QueryViewCompatibilityDetail;
}

export interface PlannedQueryViewTargetReferenceIssue {
  sourceQueryViewName: string;
  targetQueryViewName: string;
  targetFileName: string;
  missingTargetViewNames: string[];
}

export interface PlannedQueryViewTargetReferenceValidation {
  issues: PlannedQueryViewTargetReferenceIssue[];
  blockers: string[];
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

function normalizeQueryViewMappings(value: MigrationQueryViewMapping[] | undefined): MigrationQueryViewMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((mapping) => {
      const sourceQueryViewName = normalizeTopicValue(mapping.sourceQueryViewName) || '';
      const sourceFileName = normalizeTopicValue(mapping.sourceFileName);
      const targetQueryViewName = normalizeTopicValue(mapping.targetQueryViewName) || '';
      const targetFileName = normalizeTopicValue(mapping.targetFileName);
      const targetQueryViewLabel = normalizeTopicValue(mapping.targetQueryViewLabel);
      const requiredFieldRefs = Array.isArray(mapping.requiredFieldRefs)
        ? mapping.requiredFieldRefs.filter((fieldRef): fieldRef is string => typeof fieldRef === 'string').map(normalizeFieldRef).filter(Boolean)
        : [];
      const suppliedFieldRefs = Array.isArray(mapping.suppliedFieldRefs)
        ? mapping.suppliedFieldRefs.filter((fieldRef): fieldRef is string => typeof fieldRef === 'string').map(normalizeFieldRef).filter(Boolean)
        : [];
      const evidenceSource = mapping.fieldEvidence?.source;
      const evidenceFileName = normalizeTopicValue(mapping.fieldEvidence?.fileName);
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
        ...(requiredFieldRefs.length > 0 ? { requiredFieldRefs } : {}),
        ...(suppliedFieldRefs.length > 0 ? { suppliedFieldRefs } : {}),
        ...(
          evidenceFileName
          && (evidenceSource === 'source_yaml' || evidenceSource === 'target_yaml' || evidenceSource === 'accepted_patch')
            ? { fieldEvidence: { source: evidenceSource, fileName: evidenceFileName, verified: mapping.fieldEvidence?.verified === true } }
            : {}
        ),
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

function normalizePermissionDecisions(value: MigrationPermissionDecision[] | undefined): MigrationPermissionDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((decision): MigrationPermissionDecision => {
      const action = decision.action === 'map_existing'
        || decision.action === 'create_from_source'
        || decision.action === 'preserve_target'
        || decision.action === 'ignore_with_waiver'
        || decision.action === 'manual_prerequisite'
        ? decision.action
        : 'manual_prerequisite';
      return {
        dependencyId: normalizeTopicValue(decision.dependencyId) || '',
        action,
        ...(normalizeTopicValue(decision.targetRef) ? { targetRef: normalizeTopicValue(decision.targetRef) } : {}),
        ...(normalizeTopicValue(decision.waiverReason) ? { waiverReason: normalizeTopicValue(decision.waiverReason) } : {}),
        ...(decision.confirmed === true ? { confirmed: true } : {}),
      };
    })
    .filter((decision) => decision.dependencyId);
}

function normalizeQueryValidationWaivers(
  value: MigrationQueryValidationWaiver[] | undefined,
): MigrationQueryValidationWaiver[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((waiver) => {
      const documentId = normalizeTopicValue(waiver.documentId) || '';
      const queryId = normalizeTopicValue(waiver.queryId) || '';
      const reason = normalizeTopicValue(waiver.reason) || '';
      const acknowledgedAt = normalizeTopicValue(waiver.acknowledgedAt);
      return {
        documentId,
        queryId,
        reason: reason.slice(0, 500),
        ...(acknowledgedAt ? { acknowledgedAt } : {}),
      };
    })
    .filter((waiver) => waiver.documentId && waiver.queryId && waiver.reason.length >= 10);
  return [...new Map(normalized.map((waiver) => [`${waiver.documentId}:${waiver.queryId}`, waiver])).values()];
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
        || node.kind === 'permission'
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
            : patch.artifactType === 'permission'
              ? 'permission'
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
  if (artifactType === 'permission') return 'Security permission';
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

function comparableYamlText(value: string | undefined): string {
  return (value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function mergeSemanticPatchCandidates(
  candidates: MigrationSemanticPatch[],
  accepted: MigrationSemanticPatch[] | undefined,
): MigrationSemanticPatch[] {
  const acceptedByKey = semanticPatchLookup(accepted);
  return candidates.map((candidate) => {
    const acceptedPatch = acceptedByKey.get(candidate.id) || acceptedByKey.get(semanticPatchId(candidate));
    const alreadyApplied = Boolean(
      acceptedPatch?.acceptedYaml
      && candidate.currentYaml
      && comparableYamlText(acceptedPatch.acceptedYaml) === comparableYamlText(candidate.currentYaml),
    );
    const checksumStale = Boolean(
      !alreadyApplied
      && acceptedPatch?.previousChecksum
      && candidate.previousChecksum
      && acceptedPatch.previousChecksum !== candidate.previousChecksum,
    );
    const proposalChanged = Boolean(
      acceptedPatch?.recommendedYaml
      && candidate.recommendedYaml
      && acceptedPatch.recommendedYaml !== candidate.recommendedYaml,
    );
    const dependencyPath = acceptedPatch
      ? [...new Map([
          ...(candidate.dependencyPath || []),
          ...(acceptedPatch.dependencyPath || []),
        ].map((dependency) => [
          `${dependency.kind}:${dependency.ref || dependency.label}`,
          dependency,
        ])).values()]
      : candidate.dependencyPath;
    return acceptedPatch ? {
      ...candidate,
      ...acceptedPatch,
      currentYaml: candidate.currentYaml,
      sourceYaml: candidate.sourceYaml,
      recommendedYaml: candidate.recommendedYaml || acceptedPatch.recommendedYaml,
      acceptedYaml: alreadyApplied ? undefined : acceptedPatch.acceptedYaml,
      resolution: alreadyApplied ? 'keep_target' : acceptedPatch.resolution,
      destructive: alreadyApplied ? false : acceptedPatch.destructive ?? candidate.destructive,
      confirmedDestructive: alreadyApplied ? false : acceptedPatch.confirmedDestructive,
      dependencyPath,
      latestChecksum: candidate.previousChecksum,
      checksumStale,
      status: alreadyApplied ? 'ready' : checksumStale || proposalChanged ? 'blocked' : acceptedPatch.status || candidate.status,
      safetyCategory: alreadyApplied ? 'safe_map' : checksumStale || proposalChanged ? 'blocked' : acceptedPatch.safetyCategory || candidate.safetyCategory,
      recommendedAction: alreadyApplied
        ? `${semanticPatchArtifactLabel(candidate.artifactType)} YAML is already present on the destination; no additional write is required.`
        : candidate.recommendedAction || acceptedPatch.recommendedAction,
      warnings: [...new Set([
        ...(candidate.warnings || []),
        ...(acceptedPatch.warnings || []),
        ...(checksumStale ? ['Destination YAML changed since this decision was accepted. Refresh and re-apply the recommendation before running.'] : []),
        ...(proposalChanged ? ['The generated patch changed after a dependency decision was updated. Review and re-apply the recommendation before running.'] : []),
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
  const candidates = topics.filter((candidate): candidate is typeof candidate & { yaml: string } => (
    Boolean(candidate.yaml?.trim())
  ));
  const exactFileName = (value: string | undefined): string => (
    value?.normalize('NFKC').trim().toLowerCase() || ''
  );
  const uniqueAtTier = (
    predicate: (candidate: typeof candidates[number]) => boolean,
  ): typeof candidates[number] | null | undefined => {
    const matches = candidates.filter(predicate);
    if (matches.length > 1) return null;
    return matches[0];
  };
  const tiers: Array<(candidate: typeof candidates[number]) => boolean> = [];
  if (topic.fileName?.trim()) {
    const expectedFileName = exactFileName(topic.fileName);
    tiers.push((candidate) => exactFileName(candidate.fileName) === expectedFileName);
  }
  const topicId = topicKey(topic.id);
  if (topicId) tiers.push((candidate) => topicKey(candidate.name) === topicId);
  const topicName = topicKey(topic.name);
  if (topicName) tiers.push((candidate) => topicKey(candidate.name) === topicName);
  const sourceKeys = [topicId, topicName].filter((value): value is string => Boolean(value));
  tiers.push((candidate) => sourceKeys.includes(topicKey(candidate.fileName) || ''));
  tiers.push((candidate) => sourceKeys.includes(topicKey(
    candidate.fileName?.split('/').pop()?.replace(/\.topic$/, ''),
  ) || ''));
  tiers.push((candidate) => {
    const yamlLabel = candidate.yaml ? topicYamlLabel(candidate.yaml) : undefined;
    return [candidate.label, yamlLabel]
      .map(topicKey)
      .some((key) => Boolean(key && sourceKeys.includes(key)));
  });

  let match: typeof candidates[number] | undefined;
  for (const tier of tiers) {
    const candidate = uniqueAtTier(tier);
    if (candidate === null) return undefined;
    if (candidate) {
      match = candidate;
      break;
    }
  }
  return match ? { name: match.name, yaml: match.yaml, fileName: match.fileName, checksum: match.checksum } : undefined;
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
	      queryViewBlockers.push(`Target query view ${mapping.targetQueryViewName} already exists. Use existing unchanged or update target from source.`);
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
  const normalized = normalizeFieldRef(fieldRef).toLowerCase();
  return mapping.fieldEvidence?.verified === true
    && (mapping.suppliedFieldRefs || []).some((suppliedFieldRef) => normalizeFieldRef(suppliedFieldRef).toLowerCase() === normalized);
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

function queryViewMappingFieldCoverage(input: {
  mapping: MigrationQueryViewMapping;
  requiredFieldRefs: string[];
  sourceQueryViews: OmniModelQueryViewRecord[];
  targetQueryViews: OmniModelQueryViewRecord[];
  acceptedSemanticPatches: MigrationSemanticPatch[];
}): Pick<MigrationQueryViewMapping, 'requiredFieldRefs' | 'suppliedFieldRefs' | 'fieldEvidence'> {
  const requiredFieldRefs = [...new Set(input.requiredFieldRefs.map(normalizeFieldRef).filter(Boolean))].sort();
  const sourceQueryView = sourceQueryViewForMapping(input.sourceQueryViews, input.mapping);
  const targetQueryView = queryViewFromCatalogByValue(input.targetQueryViews, input.mapping.targetQueryViewName)
    || queryViewFromCatalogByValue(input.targetQueryViews, input.mapping.targetFileName);
  const targetFileName = input.mapping.targetFileName
    || targetQueryView?.fileName
    || `${input.mapping.targetQueryViewName}.query.view`;
  const acceptedPatch = activeSemanticPatchFor(
    input.acceptedSemanticPatches,
    'query_view',
    targetFileName,
    input.mapping.sourceQueryViewName,
  );

  let yaml: string | undefined;
  let fileName: string | undefined;
  let evidenceSource: NonNullable<MigrationQueryViewMapping['fieldEvidence']>['source'] | undefined;
  if (acceptedPatch?.resolution === 'keep_target') {
    yaml = targetQueryView?.yaml;
    fileName = targetQueryView?.fileName || targetFileName;
    evidenceSource = 'target_yaml';
  } else {
    const acceptedYaml = semanticPatchWriteYaml(acceptedPatch);
    if (acceptedYaml) {
      yaml = acceptedYaml;
      fileName = targetFileName;
      evidenceSource = 'accepted_patch';
    } else if (input.mapping.action === 'copy_source' || input.mapping.action === 'update_existing') {
      yaml = sourceQueryView?.yaml;
      fileName = targetFileName;
      evidenceSource = 'source_yaml';
    } else {
      yaml = targetQueryView?.yaml;
      fileName = targetQueryView?.fileName || targetFileName;
      evidenceSource = 'target_yaml';
    }
  }

  if (!yaml || !fileName || !evidenceSource) return { requiredFieldRefs, suppliedFieldRefs: [] };
  const availableFields = new Set(queryViewFieldRefs({ fileName, yaml }).map((fieldRef) => normalizeFieldRef(fieldRef).toLowerCase()));
  const sourceViewKey = queryViewKey(input.mapping.sourceQueryViewName)
    || (input.mapping.sourceFileName ? queryViewKey(queryViewNameFromFilePath(input.mapping.sourceFileName)) : undefined);
  const targetViewName = queryViewKey(input.mapping.targetQueryViewName)
    || queryViewKey(queryViewNameFromFilePath(fileName));
  const suppliedFieldRefs = requiredFieldRefs.filter((fieldRef) => {
    const normalized = normalizeFieldRef(fieldRef);
    const separatorIndex = normalized.indexOf('.');
    if (separatorIndex < 1) return availableFields.has(normalized.toLowerCase());
    const viewName = normalized.slice(0, separatorIndex);
    const fieldName = normalized.slice(separatorIndex + 1);
    const candidate = sourceViewKey
      && targetViewName
      && queryViewKey(viewName) === sourceViewKey
      ? `${targetViewName}.${fieldName}`
      : normalized;
    return availableFields.has(candidate.toLowerCase());
  });
  return {
    requiredFieldRefs,
    suppliedFieldRefs,
    fieldEvidence: {
      source: evidenceSource,
      fileName,
      verified: true,
    },
  };
}

function targetOnlyQueryViewFields(
  sourceQueryView: Pick<OmniModelQueryViewRecord, 'fileName' | 'yaml'> | undefined,
  targetQueryView: Pick<OmniModelQueryViewRecord, 'fileName' | 'yaml'> | undefined,
): string[] {
  const sourceFields = new Set(queryViewFieldRefs(sourceQueryView).map((field) => field.toLowerCase()));
  if (sourceFields.size === 0) return [];
  return queryViewFieldRefs(targetQueryView).filter((field) => !sourceFields.has(field.toLowerCase()));
}

function queryViewPrepFailureDetails(message: string): Record<string, unknown> | undefined {
  const targetOnlyMatch = message.match(/^Target query view\s+(.+?)\s+has fields not present in the source copy:\s+(.+?)\.\s+/);
  if (targetOnlyMatch) {
    const [, targetQueryViewName, fieldList] = targetOnlyMatch;
    return {
      recoveryCode: 'target_query_view_has_extra_fields',
      targetQueryViewName,
      targetOnlyFields: fieldList.split(',').map((field) => field.trim()).filter(Boolean),
      recommendedAction: 'use_existing_unchanged',
      recoveryHint: `Target query view ${targetQueryViewName} has fields the source copy does not include. Choose Use existing unchanged in Step 4 to preserve those target-only fields, or use Code review to merge the YAML intentionally.`,
    };
  }

  const renameMatch = message.match(/^Cannot create target query view\s+(.+?)\s+with a different name from\s+(.+?);/);
  if (renameMatch) {
    const [, targetQueryViewName, sourceQueryViewName] = renameMatch;
    return {
      recoveryCode: 'query_view_reference_rewrite_unsupported',
      sourceQueryViewName,
      targetQueryViewName,
      recommendedAction: 'keep_source_name_or_update_existing',
      recoveryHint: 'Query-view creation must keep the source query-view name until dashboard and topic reference rewriting is supported. Use the same name, update the existing target, or review the target model manually.',
    };
  }

  const missingSourceYamlMatch = message.match(/^Source query-view YAML was not found for\s+(.+?)\s+in model\s+(.+?)\./);
  if (missingSourceYamlMatch) {
    const [, sourceQueryViewName, sourceModelId] = missingSourceYamlMatch;
    return {
      recoveryCode: 'source_query_view_yaml_missing',
      sourceQueryViewName,
      sourceModelId,
      recommendedAction: 'use_existing_or_manual_review',
      recoveryHint: `Source YAML was not available for ${sourceQueryViewName}. Use an existing target query view unchanged or review the source model manually before retrying.`,
    };
  }

  return undefined;
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

function topicsFromModelYamlFiles(files: Record<string, string>, checksums?: Record<string, string>) {
  return Object.entries(files).filter(([fileName]) => fileName.endsWith('.topic'))
    .map(([fileName, yaml]) => ({ name: (fileName.split('/').pop() || fileName).replace(/\.topic$/, ''),
      fileName, yaml, label: yamlScalar(yaml, 'label'), ...(checksums?.[fileName] ? { checksum: checksums[fileName] } : {}) }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

const QUERY_VIEW_HUMAN_TEXT_KEYS = new Set([
  'ai_context',
  'description',
  'display_name',
  'label',
  'synonyms',
  'tags',
]);

const QUERY_VIEW_SCALAR_REFERENCE_KEYS = new Set([
  'base_view',
  'base_view_name',
  'join_from_view',
  'join_to_view',
  'join_via_view',
  'left_view_name',
  'right_view_name',
  'view',
  'view_name',
]);

const QUERY_VIEW_TEMPLATE_REFERENCE_NAMES = new Set(['table']);
const QUERY_VIEW_SQL_RELATION_REFERENCE_PATTERN = /\b(?:from|join)\s+\$\{([A-Za-z_][\w/]*)\}/gi;

function isQueryViewReferenceName(value: string | undefined): value is string {
  return isSemanticViewName(value)
    && !QUERY_VIEW_TEMPLATE_REFERENCE_NAMES.has(value.toLowerCase());
}

export function extractQueryViewReferences(yaml: string): string[] {
  const refs = new Set<string>();

  function addReferences(value: string, keyHint: string): void {
    const normalizedKey = keyHint.toLowerCase();
    if (QUERY_VIEW_HUMAN_TEXT_KEYS.has(normalizedKey)) return;

    if (QUERY_VIEW_SCALAR_REFERENCE_KEYS.has(normalizedKey)) {
      const scalar = yamlScalarValue(value);
      if (isQueryViewReferenceName(scalar)) refs.add(scalar);
    }

    for (const fieldRef of extractFieldRefsFromString(value)) {
      const [viewName] = fieldRef.split('.');
      if (isQueryViewReferenceName(viewName)) refs.add(viewName);
    }
    for (const match of value.matchAll(/\$\{([A-Za-z_][\w/]*)\.[A-Za-z_][\w]*(?:\[[^\]]+\])?\}/g)) {
      if (isQueryViewReferenceName(match[1])) refs.add(match[1]);
    }
    for (const match of value.matchAll(QUERY_VIEW_SQL_RELATION_REFERENCE_PATTERN)) {
      if (isQueryViewReferenceName(match[1])) refs.add(match[1]);
    }
  }

  function walk(node: unknown, keyHint = ''): void {
    if (typeof node === 'string') {
      addReferences(node, keyHint);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (QUERY_VIEW_HUMAN_TEXT_KEYS.has(key.toLowerCase())) continue;
      if (/field|filter|sort|pivot|column|measure|dimension/i.test(keyHint)) {
        addReferences(key, keyHint);
      }
      walk(value, key);
    }
  }

  try {
    walk(parseYaml(yaml));
  } catch {
    const scalarPattern = /^\s*(?:base_view|base_view_name|view|view_name|left_view_name|right_view_name|join_via_view|join_from_view|join_to_view):\s*["']?([A-Za-z_][\w/]*)["']?\s*$/gm;
    for (const match of yaml.matchAll(scalarPattern)) {
      if (isQueryViewReferenceName(match[1])) refs.add(match[1]);
    }
    for (const match of yaml.matchAll(/\$\{([A-Za-z_][\w/]*)\.[A-Za-z_][\w]*(?:\[[^\]]+\])?\}/g)) {
      if (isQueryViewReferenceName(match[1])) refs.add(match[1]);
    }
    for (const match of yaml.matchAll(QUERY_VIEW_SQL_RELATION_REFERENCE_PATTERN)) {
      if (isQueryViewReferenceName(match[1])) refs.add(match[1]);
    }
  }

  return [...refs].sort();
}

/**
 * Verifies that query-view YAML planned for a destination model only references
 * semantic views that are already present in that model or are query views in
 * the same planned write set. This is deliberately a presence check, not a
 * mapping heuristic: a similarly named destination view is never substituted
 * for a missing source dependency.
 */
export function validatePlannedQueryViewTargetReferences(input: {
  queryViewMappings: MigrationQueryViewMapping[];
  sourceQueryViews: OmniModelQueryViewRecord[];
  targetQueryViews: OmniModelQueryViewRecord[];
  targetViewNames: Iterable<string>;
  targetModelName: string;
  acceptedSemanticPatches?: MigrationSemanticPatch[];
}): PlannedQueryViewTargetReferenceValidation {
  const availableTargetViewKeys = new Set<string>();
  const addAvailableTargetView = (value: string | undefined): void => {
    const key = queryViewKey(value);
    if (key) availableTargetViewKeys.add(key);
  };

  for (const targetViewName of input.targetViewNames) addAvailableTargetView(targetViewName);
  for (const targetQueryView of input.targetQueryViews) {
    for (const key of queryViewKeys(targetQueryView)) availableTargetViewKeys.add(key);
  }
  for (const mapping of input.queryViewMappings) {
    if (mapping.action !== 'copy_source' && mapping.action !== 'update_existing') continue;
    addAvailableTargetView(mapping.targetQueryViewName);
    if (mapping.targetFileName) {
      for (const variant of viewNameVariants(mapping.targetFileName)) addAvailableTargetView(variant);
    }
  }

  const issues: PlannedQueryViewTargetReferenceIssue[] = [];
  for (const mapping of input.queryViewMappings) {
    if (mapping.action !== 'copy_source' && mapping.action !== 'update_existing') continue;
    const sourceQueryView = sourceQueryViewForMapping(input.sourceQueryViews, mapping);
    const targetQueryView = queryViewFromCatalogByValue(
      input.targetQueryViews,
      mapping.targetQueryViewName,
    ) || queryViewFromCatalogByValue(
      input.targetQueryViews,
      mapping.targetFileName,
    );
    const targetFileName = mapping.targetFileName
      || targetQueryView?.fileName
      || `${mapping.targetQueryViewName}.query.view`;
    const acceptedPatch = activeSemanticPatchFor(
      input.acceptedSemanticPatches,
      'query_view',
      targetFileName,
      mapping.sourceQueryViewName,
    );
    const plannedYaml = acceptedPatch?.resolution === 'keep_target'
      ? targetQueryView?.yaml
      : acceptedPatch?.acceptedYaml?.trim()
        ? acceptedPatch.acceptedYaml
        : sourceQueryView?.yaml;
    if (!plannedYaml) continue;

    const missingTargetViewNames = [...new Set(
      extractQueryViewReferences(plannedYaml)
        .filter((viewName) => !availableTargetViewKeys.has(queryViewKey(viewName) || '')),
    )].sort((a, b) => a.localeCompare(b));
    if (missingTargetViewNames.length === 0) continue;
    issues.push({
      sourceQueryViewName: mapping.sourceQueryViewName,
      targetQueryViewName: mapping.targetQueryViewName,
      targetFileName,
      missingTargetViewNames,
    });
  }

  issues.sort((a, b) => (
    a.targetQueryViewName.localeCompare(b.targetQueryViewName)
    || a.sourceQueryViewName.localeCompare(b.sourceQueryViewName)
  ));
  const blockers = issues.map((issue) => (
    `Planned query view ${issue.targetQueryViewName} cannot be prepared for ${input.targetModelName} because its YAML references destination views that are not available: ${formatFieldList(issue.missingTargetViewNames)}. Choose a target model that contains those views or edit the query-view YAML to use verified destination views.`
  ));
  return { issues, blockers };
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
        requiredFieldRefs: requiredFieldRefsForQueryView(sourceQueryView?.name || reference.name, input.missingDashboardFieldRefs),
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
  conflictingRelationshipEdges: RelationshipEdgeReference[];
  relationshipBlockers: string[];
  warnings: string[];
}> {
  if (!input.sourceModelId || input.requiredQueryViews.length < 2) {
    return { relationshipEdges: [], existingRelationshipEdges: [], conflictingRelationshipEdges: [], relationshipBlockers: [], warnings: [] };
  }

  const requiredViewKeys = new Set(input.requiredQueryViews.map((queryView) => queryViewKey(queryView.name)).filter((value): value is string => Boolean(value)));
  if (requiredViewKeys.size < 2) return { relationshipEdges: [], existingRelationshipEdges: [], conflictingRelationshipEdges: [], relationshipBlockers: [], warnings: [] };

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
  if (warnings.length > 0) return { relationshipEdges: [], existingRelationshipEdges: [], conflictingRelationshipEdges: [], relationshipBlockers: [], warnings };

  const sourceEdges = extractRelationshipEdges(sourceFiles.relationships);
  const targetEdges = extractRelationshipEdges(targetFiles.relationships);
  const targetByKey = new Map(targetEdges.map((edge) => [relationshipEdgeKey(edge), edge]));
  const relationshipEdges: RelationshipEdgeReference[] = [];
  const existingRelationshipEdges: RelationshipEdgeReference[] = [];
  const conflictingRelationshipEdges: RelationshipEdgeReference[] = [];
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
    conflictingRelationshipEdges.push(relationshipEdgeReference(sourceEdge));
    relationshipBlockers.push(`Target relationship ${relationshipEdgeSummary(sourceEdge)} already exists with different YAML. Review the target relationships file before importing this dashboard.`);
  }

  return {
    relationshipEdges: [...new Map(relationshipEdges.map((edge) => [relationshipEdgeKey(edge), edge])).values()],
    existingRelationshipEdges: [...new Map(existingRelationshipEdges.map((edge) => [relationshipEdgeKey(edge), edge])).values()],
    conflictingRelationshipEdges: [...new Map(conflictingRelationshipEdges.map((edge) => [relationshipEdgeKey(edge), edge])).values()],
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

const DOCUMENT_V2_PRESENTATION_CHUNK_LIMIT = 48;
const DOCUMENT_V2_NONPORTABLE_PRESENTATION_TYPES = new Set(['csv', 'spreadsheet', 'dbt', 'app']);
const QUERY_VIEW_REFERENCE_KEYS = new Set([
  'editingmodelobjectname',
  'modelobjectname',
  'view',
  'viewname',
  'view_name',
  'queryview',
  'queryviewname',
  'query_view_name',
  'queryviewname',
  'table',
  'baseview',
  'base_view',
]);

interface DocumentV2UpdatePatchPlan {
  patches: DocumentV2Patch[];
  tileCount: number;
  deletedTileCount: number;
  modelRewriteCount: number;
  modelExtensionRemovalCount: number;
  topicRewriteCount: number;
  queryViewRewriteCount: number;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface DocumentV2PresentationState {
  data: Record<string, unknown>;
  order: string[];
  unknownState: Record<string, unknown>;
}

function documentV2PresentationState(state: Record<string, unknown>): DocumentV2PresentationState {
  const raw = state.queryPresentations;
  if (isRecord(raw) && isRecord(raw.data)) {
    const data = raw.data;
    const dataKeys = new Set(Object.keys(data));
    const order: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(raw.order)) {
      for (const value of raw.order) {
        if (typeof value !== 'string' || !dataKeys.has(value) || seen.has(value)) continue;
        seen.add(value);
        order.push(value);
      }
    }
    for (const key of dataKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(key);
    }
    return {
      data,
      order,
      unknownState: Object.fromEntries(
        Object.entries(raw).filter(([key]) => key !== 'data' && key !== 'order'),
      ),
    };
  }
  if (isRecord(raw)) {
    return {
      data: raw,
      order: Object.keys(raw),
      unknownState: {},
    };
  }
  return { data: {}, order: [], unknownState: {} };
}

function documentV2PresentationPatch(entries: Array<[string, unknown | null]>): Record<string, unknown> {
  return { data: Object.fromEntries(entries) };
}

function documentV2PresentationStatePatch(input: {
  source: DocumentV2PresentationState;
  destination: DocumentV2PresentationState;
}): Record<string, unknown> {
  return {
    ...input.destination.unknownState,
    ...input.source.unknownState,
    order: input.source.order,
  };
}

function documentV2ModelBinding(state: Record<string, unknown>): string | undefined {
  for (const key of ['modelId', 'workbookModelId', 'baseModelId', 'model_id', 'workbook_model_id', 'base_model_id']) {
    const value = state[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (isRecord(state.model)) {
    for (const key of ['id', 'identifier', 'baseModelId', 'base_model_id']) {
      const value = state.model[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function documentV2MetadataString(state: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = state[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function documentV2Summary(sourceLabel: string, jobId: string): string {
  return redactSensitiveText(`OmniKit migration from ${sourceLabel} · job ${jobId}`).slice(0, 255);
}

function buildQueryViewRewriteMap(mappings: MigrationQueryViewMapping[]): Map<string, string> {
  const rewriteMap = new Map<string, string>();
  for (const mapping of mappings) {
    const target = normalizeTopicValue(mapping.targetQueryViewName)
      || (mapping.targetFileName ? queryViewNameFromFilePath(mapping.targetFileName) : undefined);
    if (!target) continue;
    for (const source of [
      mapping.sourceQueryViewName,
      mapping.sourceFileName,
      mapping.sourceFileName ? queryViewNameFromFilePath(mapping.sourceFileName) : undefined,
    ]) {
      const sourceKey = queryViewKey(source);
      if (sourceKey && sourceKey !== queryViewKey(target)) rewriteMap.set(sourceKey, target);
    }
  }
  return rewriteMap;
}

const DASHBOARD_MODEL_REFERENCE_KEYS = new Set([
  'modelId',
  'model_id',
  'baseModelId',
  'base_model_id',
  'sharedModelId',
  'shared_model_id',
]);
const DASHBOARD_MODEL_EXTENSION_KEYS = new Set([
  'modelExtensionId',
  'model_extension_id',
]);

function retargetDashboardModelReferences(
  value: unknown,
  targetModelId: string,
  stats = { replacements: 0, extensionRemovals: 0 },
  maxDepth = 24,
): unknown {
  if (maxDepth <= 0 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => retargetDashboardModelReferences(item, targetModelId, stats, maxDepth - 1));
  }
  if (!isRecord(value)) return value;
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (DASHBOARD_MODEL_EXTENSION_KEYS.has(key)) {
      stats.extensionRemovals += 1;
      continue;
    }
    if (DASHBOARD_MODEL_REFERENCE_KEYS.has(key) && typeof item === 'string') {
      if (item !== targetModelId) stats.replacements += 1;
      entries.push([key, targetModelId]);
      continue;
    }
    entries.push([key, retargetDashboardModelReferences(item, targetModelId, stats, maxDepth - 1)]);
  }
  return Object.fromEntries(entries);
}

function rewriteQueryViewReferences(value: unknown, rewriteMap: Map<string, string>, keyHint = '', stats = { replacements: 0 }, maxDepth = 16): unknown {
  if (rewriteMap.size === 0 || maxDepth <= 0) return value;
  const normalizedKey = keyHint.toLowerCase();
  if (typeof value === 'string') {
    if (!QUERY_VIEW_REFERENCE_KEYS.has(normalizedKey)) return value;
    const target = rewriteMap.get(queryViewKey(value) || '');
    if (!target) return value;
    stats.replacements += 1;
    return target;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteQueryViewReferences(item, rewriteMap, keyHint, stats, maxDepth - 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    rewriteQueryViewReferences(item, rewriteMap, key, stats, maxDepth - 1),
  ]));
}

function rewriteDashboardQueryForTarget(input: {
  query: Record<string, unknown>;
  sourceModelId?: string;
  targetModelId: string;
  topicMappings: MigrationTopicMapping[];
  queryViewMappings: MigrationQueryViewMapping[];
}): {
  query: Record<string, unknown>;
  modelRewriteCount: number;
  modelExtensionRemovalCount: number;
  topicRewriteCount: number;
  queryViewRewriteCount: number;
} {
  const modelRewrite = input.sourceModelId
    ? rewriteQueryModelReferences(input.query, input.sourceModelId, input.targetModelId)
    : { query: { ...input.query }, replacements: 0 };
  const modelStats = { replacements: 0, extensionRemovals: 0 };
  let query = retargetDashboardModelReferences(
    modelRewrite.query,
    input.targetModelId,
    modelStats,
  ) as Record<string, unknown>;
  if (!('modelId' in query) && !('model_id' in query)) query.modelId = input.targetModelId;
  const topicRewrite = rewriteDashboardTopicReferences(query, input.topicMappings);
  query = topicRewrite.payload;
  const queryViewStats = { replacements: 0 };
  query = rewriteQueryViewReferences(
    query,
    buildQueryViewRewriteMap(input.queryViewMappings),
    '',
    queryViewStats,
  ) as Record<string, unknown>;
  return {
    query,
    modelRewriteCount: modelRewrite.replacements + modelStats.replacements,
    modelExtensionRemovalCount: modelStats.extensionRemovals,
    topicRewriteCount: topicRewrite.replacementCount,
    queryViewRewriteCount: queryViewStats.replacements,
  };
}

function rewriteDocumentV2Presentation(input: {
  presentationKey: string;
  presentation: unknown;
  sourceModelId?: string;
  targetModelId: string;
  topicMappings: MigrationTopicMapping[];
  queryViewMappings: MigrationQueryViewMapping[];
}): { presentation: unknown; modelRewriteCount: number; modelExtensionRemovalCount: number; topicRewriteCount: number; queryViewRewriteCount: number; warnings: string[] } {
  if (!isRecord(input.presentation)) {
    return {
      presentation: input.presentation,
      modelRewriteCount: 0,
      modelExtensionRemovalCount: 0,
      topicRewriteCount: 0,
      queryViewRewriteCount: 0,
      warnings: [`Presentation ${input.presentationKey} is not an object; it was copied without reference rewrites.`],
    };
  }

  const warnings: string[] = [];
  const presentationType = normalizeTopicValue(
    input.presentation.type
      || input.presentation.presentationType
      || input.presentation.presentation_type
      || input.presentation.kind,
  )?.toLowerCase();
  if (presentationType && DOCUMENT_V2_NONPORTABLE_PRESENTATION_TYPES.has(presentationType)) {
    warnings.push(`Presentation ${input.presentationKey} uses non-portable type ${presentationType}; it was copied but may need review in Omni.`);
  }

  let nextPresentation: Record<string, unknown> = { ...input.presentation };
  let modelRewriteCount = 0;
  let modelExtensionRemovalCount = 0;
  if (input.sourceModelId && input.targetModelId && isRecord(nextPresentation.query)) {
    const rewritten = rewriteQueryModelReferences(nextPresentation.query, input.sourceModelId, input.targetModelId);
    const modelStats = { replacements: 0, extensionRemovals: 0 };
    const retargetedQuery = retargetDashboardModelReferences(rewritten.query, input.targetModelId, modelStats);
    nextPresentation = { ...nextPresentation, query: retargetedQuery };
    modelRewriteCount += rewritten.replacements + modelStats.replacements;
    modelExtensionRemovalCount += modelStats.extensionRemovals;
  } else if (!input.sourceModelId && isRecord(nextPresentation.query)) {
    const modelStats = { replacements: 0, extensionRemovals: 0 };
    const retargetedQuery = retargetDashboardModelReferences(nextPresentation.query, input.targetModelId, modelStats);
    nextPresentation = { ...nextPresentation, query: retargetedQuery };
    modelRewriteCount += modelStats.replacements;
    modelExtensionRemovalCount += modelStats.extensionRemovals;
  }

  const topicRewrite = rewriteDashboardTopicReferences(nextPresentation, input.topicMappings);
  nextPresentation = topicRewrite.payload;
  const queryViewStats = { replacements: 0 };
  nextPresentation = rewriteQueryViewReferences(
    nextPresentation,
    buildQueryViewRewriteMap(input.queryViewMappings),
    '',
    queryViewStats,
  ) as Record<string, unknown>;

  return {
    presentation: nextPresentation,
    modelRewriteCount,
    modelExtensionRemovalCount,
    topicRewriteCount: topicRewrite.replacementCount,
    queryViewRewriteCount: queryViewStats.replacements,
    warnings,
  };
}

export interface DashboardSafeCopyDocumentMaterialization {
  content: DashboardSafeCopyDocumentContent;
  sourceModelId?: string;
  modelRewriteCount: number;
  modelExtensionRemovalCount: number;
  topicRewriteCount: number;
  queryViewRewriteCount: number;
}

function requireDashboardSafeCopyTargetModelId(value: string): string {
  const targetModelId = value.trim();
  if (!targetModelId) throw new Error('Target model ID is required for safe dashboard copy.');
  return targetModelId;
}

export function materializeDashboardSafeCopyDocument(input: {
  sourceState: Record<string, unknown>;
  targetModelId: string;
  topicMappings: MigrationTopicMapping[];
  queryViewMappings: MigrationQueryViewMapping[];
}): DashboardSafeCopyDocumentMaterialization {
  const targetModelId = requireDashboardSafeCopyTargetModelId(input.targetModelId);
  const presentations = documentV2PresentationState(input.sourceState);
  const name = documentV2MetadataString(input.sourceState, 'name', 'title');
  if (!name) throw new Error('Source dashboard state did not return a name.');
  const sourceContent = materializeDashboardSafeCopyDocumentContent({
    name,
    ...('description' in input.sourceState ? { description: input.sourceState.description } : {}),
    queryPresentations: { data: presentations.data, order: presentations.order },
    ...('controls' in input.sourceState ? { controls: input.sourceState.controls } : {}),
    ...('settings' in input.sourceState ? { settings: input.sourceState.settings } : {}),
    containers: input.sourceState.containers,
  });
  const sourceModelId = documentV2ModelBinding(input.sourceState);
  const data: Record<string, unknown> = {};
  let modelRewriteCount = 0;
  let modelExtensionRemovalCount = 0;
  let topicRewriteCount = 0;
  let queryViewRewriteCount = 0;
  for (const key of sourceContent.queryPresentations.order) {
    if (!(key in sourceContent.queryPresentations.data)) {
      throw new Error('Source dashboard presentation order is incomplete.');
    }
    const rewritten = rewriteDocumentV2Presentation({
      presentationKey: key,
      presentation: sourceContent.queryPresentations.data[key],
      sourceModelId,
      targetModelId,
      topicMappings: input.topicMappings,
      queryViewMappings: input.queryViewMappings,
    });
    if (rewritten.warnings.length > 0) {
      throw new Error('Source dashboard contains a presentation that is not safe for automatic copy.');
    }
    data[key] = rewritten.presentation;
    modelRewriteCount += rewritten.modelRewriteCount;
    modelExtensionRemovalCount += rewritten.modelExtensionRemovalCount;
    topicRewriteCount += rewritten.topicRewriteCount;
    queryViewRewriteCount += rewritten.queryViewRewriteCount;
  }
  const content = materializeDashboardSafeCopyDocumentContent({
    ...sourceContent,
    queryPresentations: { data, order: sourceContent.queryPresentations.order },
  });
  return {
    content,
    sourceModelId,
    modelRewriteCount,
    modelExtensionRemovalCount,
    topicRewriteCount,
    queryViewRewriteCount,
  };
}

export function rewriteDashboardSafeCopyQueryForTarget(input: {
  query: Record<string, unknown>;
  sourceModelId?: string;
  targetModelId: string;
  topicMappings: MigrationTopicMapping[];
  queryViewMappings: MigrationQueryViewMapping[];
}): ReturnType<typeof rewriteDashboardQueryForTarget> {
  return rewriteDashboardQueryForTarget({
    ...input,
    targetModelId: requireDashboardSafeCopyTargetModelId(input.targetModelId),
  });
}

function chunkDocumentV2PresentationEntries(entries: Array<[string, unknown | null]>): Array<Array<[string, unknown | null]>> {
  const chunks: Array<Array<[string, unknown | null]>> = [];
  let current: Array<[string, unknown | null]> = [];
  let nonNullCount = 0;
  for (const entry of entries) {
    const isNonNull = entry[1] !== null && entry[1] !== undefined;
    if (isNonNull && nonNullCount >= DOCUMENT_V2_PRESENTATION_CHUNK_LIMIT) {
      chunks.push(current);
      current = [];
      nonNullCount = 0;
    }
    current.push(entry);
    if (isNonNull) nonNullCount += 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildDocumentV2UpdatePatchPlan(input: {
  sourceState: Record<string, unknown>;
  destinationState: Record<string, unknown>;
  sourceModelId?: string;
  targetModelId: string;
  topicMappings: MigrationTopicMapping[];
  queryViewMappings: MigrationQueryViewMapping[];
  sourceLabel: string;
  jobId: string;
}): DocumentV2UpdatePatchPlan {
  const sourcePresentationState = documentV2PresentationState(input.sourceState);
  const destinationPresentationState = documentV2PresentationState(input.destinationState);
  const sourcePresentations = sourcePresentationState.data;
  const destinationPresentations = destinationPresentationState.data;
  const sourceKeys = new Set(Object.keys(sourcePresentations));
  const entries: Array<[string, unknown | null]> = [];
  const warnings: string[] = [];
  let modelRewriteCount = 0;
  let modelExtensionRemovalCount = 0;
  let topicRewriteCount = 0;
  let queryViewRewriteCount = 0;

  for (const [key, presentation] of Object.entries(sourcePresentations)) {
    const rewritten = rewriteDocumentV2Presentation({
      presentationKey: key,
      presentation,
      sourceModelId: input.sourceModelId,
      targetModelId: input.targetModelId,
      topicMappings: input.topicMappings,
      queryViewMappings: input.queryViewMappings,
    });
    entries.push([key, rewritten.presentation]);
    modelRewriteCount += rewritten.modelRewriteCount;
    modelExtensionRemovalCount += rewritten.modelExtensionRemovalCount;
    topicRewriteCount += rewritten.topicRewriteCount;
    queryViewRewriteCount += rewritten.queryViewRewriteCount;
    warnings.push(...rewritten.warnings);
  }

  for (const key of Object.keys(destinationPresentations)) {
    if (!sourceKeys.has(key)) entries.push([key, null]);
  }

  const chunks = chunkDocumentV2PresentationEntries(entries);
  const patches: DocumentV2Patch[] = [];
  const firstPatch: DocumentV2Patch = {
    summary: documentV2Summary(input.sourceLabel, input.jobId),
  };
  const name = documentV2MetadataString(input.sourceState, 'name', 'title');
  if (name) firstPatch.name = name;
  if ('description' in input.sourceState) {
    firstPatch.description = typeof input.sourceState.description === 'string' ? input.sourceState.description : null;
  }
  if (chunks[0]?.length) firstPatch.queryPresentations = documentV2PresentationPatch(chunks[0]);
  patches.push(firstPatch);
  for (const chunk of chunks.slice(1)) {
    patches.push({ queryPresentations: documentV2PresentationPatch(chunk) });
  }

  const finalPatch: DocumentV2Patch = {};
  finalPatch.queryPresentations = documentV2PresentationStatePatch({
    source: sourcePresentationState,
    destination: destinationPresentationState,
  });
  for (const key of ['controls', 'settings', 'containers'] as const) {
    if (key in input.sourceState) finalPatch[key] = input.sourceState[key];
  }
  if (Object.keys(finalPatch).length > 0) patches.push(finalPatch);

  return {
    patches,
    tileCount: Object.keys(sourcePresentations).length,
    deletedTileCount: Math.max(0, Object.keys(destinationPresentations).filter((key) => !sourceKeys.has(key)).length),
    modelRewriteCount,
    modelExtensionRemovalCount,
    topicRewriteCount,
    queryViewRewriteCount,
    warnings: [...new Set(warnings)],
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
      if (explicitFolderId && !explicitFolderPath && !target.exactFolder) {
        throw new Error(`Choose a target folder path for ${destination.label}, or clear the folder to use the default destination.`);
      }
      return {
        id: target.id || `${destination.id}:${targetModelId}:${index}`,
        destinationInstanceId: destination.id,
        destinationLabel: destination.label,
        targetConnectionId: target.targetConnectionId?.trim(),
        targetModelId,
        targetModelName: target.targetModelName?.trim() || targetModelId,
        ...(target.exactFolder ? { exactFolder: true } : {}),
        targetFolderId: target.exactFolder ? explicitFolderId : explicitFolderId || (explicitFolderPath ? undefined : destination.defaultFolderId),
        targetFolderPath: target.exactFolder ? explicitFolderPath : explicitFolderPath || destination.defaultFolderPath,
        sameNamedStrategy: target.sameNamedStrategy === 'replace' ? 'replace' : 'update',
        topicMappings: normalizeTopicMappings(target.topicMappings),
        queryViewMappings: normalizeQueryViewMappings(target.queryViewMappings),
        fieldMappings: normalizeFieldMappings(target.fieldMappings),
        permissionDecisions: normalizePermissionDecisions(target.permissionDecisions),
        semanticPatches: normalizeSemanticPatches(target.semanticPatches),
        queryValidationWaivers: normalizeQueryValidationWaivers(target.queryValidationWaivers),
        ...(target.workbookCopy?.stagingFolderId?.trim()
          ? { workbookCopy: { stagingFolderId: target.workbookCopy.stagingFolderId.trim() } }
          : {}),
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
      sameNamedStrategy: 'update',
      topicMappings: [],
      queryViewMappings: [],
      fieldMappings: [],
      permissionDecisions: [],
      semanticPatches: [],
      queryValidationWaivers: [],
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

export interface MigrationSourceEvidenceContext {
  /** Server-only approvals verified against current source and destination snapshots. */
  reconstructedTopics?: ReviewedReconstructedTopics;
  /** Trusted server reads only; never populated from a request-body field. */
  signal?: AbortSignal;
  sourceDocuments?: ReadonlyMap<string, OmniDocumentRecord>;
  sourceDocumentStates?: ReadonlyMap<string, Record<string, unknown>>;
  loadSourceYaml?: (modelId: string, options: DashboardSourceYamlReadOptions) => Promise<Record<string, string>>;
  /** Authored fullyResolved:false, includeChecksums:true destination snapshot. */
  loadDestinationYaml?: (instanceId: string, modelId: string) => Promise<OmniModelYamlResponse>;
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
  documentAccessPolicy?: 'migrate_explicit' | 'destination_defaults';
  usePreviewCache?: boolean;
  /** Read-only dashboard readiness: prepare proposals without selecting writes. */
  prepareDependencyPatchCandidates?: boolean;
}, evidenceContext: MigrationSourceEvidenceContext = {}): Promise<MigrationPlan> {
  const source = requireInstance(input.sourceId);
  const routeGroups = normalizeRouteGroups(input);
  const targetsById = new Map<string, MigrationTarget>();
  for (const target of routeGroups.flatMap((group) => group.targets)) {
    if (!targetsById.has(target.id)) targetsById.set(target.id, target);
  }
  const targets = [...targetsById.values()];
  const sourceDocumentIds = [...new Set(routeGroups.flatMap((group) => group.documentIds))];
  evidenceContext.signal?.throwIfAborted();
  const sourceClient = new OmniClient(source, { signal: evidenceContext.signal });
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
  const trustedDocuments = sourceDocumentIds.map((id) => evidenceContext.sourceDocuments?.get(id)
    || [...(evidenceContext.sourceDocuments?.values() || [])].find((document) => document.id === id || document.identifier === id));
  const trustedDocumentsCoverSelection = sourceDocumentIds.length > 0 && trustedDocuments.every((document) => document
    && (evidenceContext.sourceDocumentStates?.has(document.identifier) || evidenceContext.sourceDocumentStates?.has(document.id)));
  const sourceDocs = trustedDocumentsCoverSelection
    ? [...new Map((trustedDocuments as OmniDocumentRecord[]).map((document) => [document.identifier, document])).values()]
    : hintsCoverSelection
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
  const sourceDocumentQueryCache = new Map<string, Promise<OmniDocumentQueryRecord[]>>();
  const sourceTopicCatalogCache = new Map<string, Promise<Array<{ name: string; label?: string; yaml?: string; fileName?: string; checksum?: string }>>>();
  const sourceQueryViewUniverseCache = new Map<string, Promise<QueryViewCatalogResult>>();
  const sourceQueryViewCatalogCache = new Map<string, Promise<OmniModelQueryViewRecord[]>>();
  const sourceModelYamlFilesCache = new Map<string, Promise<Record<string, string>>>();
  const sourceAuthoredYamlFilesCache = new Map<string, Promise<Record<string, string>>>();
  const sourceWorkbookYamlFilesCache = new Map<string, Promise<Record<string, string>>>();
  const sourceDocumentStateCache = new Map<string, Promise<Record<string, unknown>>>();
  const sourceEvidenceCache = new Map<string, Promise<DashboardSourceEvidence>>();
  const targetModelYamlFilesCache = new Map<string, Promise<Record<string, string>>>();
  const targetUserAttributeCache = new Map<string, Promise<{
    names: string[];
    definitions: Array<{
      name: string;
      system?: boolean;
      hasDefaultValue?: boolean;
    }>;
    status: 'available' | 'unauthorized' | 'unavailable';
    warning?: string;
  }>>();
  const sourceDocumentAccessCache = new Map<string, Promise<{
    principals: OmniDocumentAccessPrincipal[];
    status: 'available' | 'unauthorized' | 'unavailable';
    warning?: string;
  }>>();
  const targetIdentityCache = new Map<string, Promise<{
    users: OmniIdentityUserRecord[];
    groups: OmniUserGroupRecord[];
    status: 'available' | 'unauthorized' | 'unavailable';
    warning?: string;
  }>>();
  const sourceIdentityCache = new Map<string, Promise<{
    users: OmniIdentityUserRecord[];
    groups: OmniUserGroupRecord[];
    status: 'available' | 'unauthorized' | 'unavailable';
    warning?: string;
  }>>();
  const referencedGroupCache = new Map<string, Promise<{
    groups: OmniUserGroupRecord[];
    status: 'available' | 'unauthorized' | 'unavailable';
    warning?: string;
  }>>();
  const modelRoleCache = new Map<string, Promise<{
    roles: OmniModelRoleRecord[];
    status: 'available' | 'unauthorized' | 'unavailable';
    warning?: string;
  }>>();
  const documentV2ProbeCache = new Map<string, Promise<{ supported: boolean; warning?: string }>>();

  function cachedInstanceRead<T>(instanceId: string, key: string, loader: () => Promise<T>) {
    return readThroughCache(
      `migration-preview:${instanceId}:${key}`,
      loader,
      { enabled: previewCacheEnabled },
    );
  }

  function probeDocumentV2Support(destination: SavedInstance, client: OmniClient, documentId: string) {
    const key = `${destination.id}:${documentId}`;
    const cached = documentV2ProbeCache.get(key);
    if (cached) return cached;
    const next = cachedInstanceRead(
      destination.id,
      `document-v2-probe:${documentId}`,
      async () => {
        try {
          await client.getDocumentStateV2(documentId);
          return { supported: true };
        } catch (error) {
          const status = error instanceof OmniClientError ? error.status : undefined;
          const reason = error instanceof Error ? error.message : String(error);
          if (status === 405 || status === 501) {
            return {
              supported: false,
              warning: 'This Omni instance explicitly reported that Documents V2 update-in-place is unsupported; falling back to replace.',
            };
          }
          throw new Error(
            `In-place dashboard update support could not be verified for ${destination.label}; replacement was not attempted. ${reason}`,
          );
        }
      },
    );
    documentV2ProbeCache.set(key, next);
    return next;
  }

  function originalSourceTopicCatalog(modelId: string) {
    const cached = sourceTopicCatalogCache.get(modelId);
    if (cached) return cached;
    // listModelTopics is a projection of authored model YAML. Reuse that exact
    // representation; resolved/inherited YAML remains a separate cache.
    const next = sourceAuthoredYamlFiles(modelId).then((files) => topicsFromModelYamlFiles(files));
    sourceTopicCatalogCache.set(modelId, next);
    return next;
  }

  function sourceDocumentQueries(documentId: string) {
    const cached = sourceDocumentQueryCache.get(documentId);
    if (cached) return cached;
    const next = cachedPreviewRead(
      `source-document-queries:${documentId}`,
      () => sourceClient.getDocumentQueries(documentId),
    );
    sourceDocumentQueryCache.set(documentId, next);
    return next;
  }

  function sourceQueryViewUniverse(modelId: string) {
    const cached = sourceQueryViewUniverseCache.get(modelId);
    if (cached) return cached;
    const next = (async (): Promise<QueryViewCatalogResult> => {
      try {
        const files = await sourceModelYamlFiles(modelId);
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
    const next = sourceAuthoredYamlFiles(modelId).then(queryViewsFromModelYamlFiles);
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

  function sourceAuthoredYamlFiles(modelId: string) {
    const cached = sourceAuthoredYamlFilesCache.get(modelId);
    if (cached) return cached;
    const next = evidenceContext.loadSourceYaml?.(modelId, { fullyResolved: false }) || cachedPreviewRead(`source-authored-yaml-files:${modelId}`, async () => (
      await sourceClient.getModelYaml(modelId, { fullyResolved: false, includeChecksums: true })
    ).files);
    sourceAuthoredYamlFilesCache.set(modelId, next);
    return next;
  }

  function sourceWorkbookYamlFiles(modelId: string) {
    const cached = sourceWorkbookYamlFilesCache.get(modelId);
    if (cached) return cached;
    const next = evidenceContext.loadSourceYaml?.(modelId, { fullyResolved: false, mode: 'extension' }) || cachedPreviewRead(`source-workbook-extension:${modelId}`, async () => (
      await sourceClient.getModelYaml(modelId, { fullyResolved: false, mode: 'extension', includeChecksums: true })
    ).files);
    sourceWorkbookYamlFilesCache.set(modelId, next);
    return next;
  }

  function sourceDocumentState(document: OmniDocumentRecord) {
    const trusted = evidenceContext.sourceDocumentStates?.get(document.identifier)
      || evidenceContext.sourceDocumentStates?.get(document.id);
    if (trusted) return Promise.resolve(trusted);
    const cached = sourceDocumentStateCache.get(document.identifier);
    if (cached) return cached;
    // A planner-local read, not preview-cache or request-body provenance.
    const next = sourceClient.getDocumentStateV2(document.identifier, evidenceContext.signal);
    sourceDocumentStateCache.set(document.identifier, next);
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

  function targetUserAttributes(destination: SavedInstance, client: OmniClient) {
    const cached = targetUserAttributeCache.get(destination.id);
    if (cached) return cached;
    const next = cachedInstanceRead(
      destination.id,
      'target-user-attributes',
      async () => {
        try {
          const attributes = await client.listUserAttributes();
          return {
            names: attributes.map((attribute) => attribute.name),
            definitions: attributes.map((attribute) => ({
              name: attribute.name,
              system: attribute.system,
              hasDefaultValue: attribute.defaultValue !== undefined && attribute.defaultValue !== null,
            })),
            status: 'available' as const,
          };
        } catch (error) {
          const unauthorized = error instanceof OmniClientError && (error.status === 401 || error.status === 403);
          return {
            names: [],
            definitions: [],
            status: unauthorized ? 'unauthorized' as const : 'unavailable' as const,
            warning: unauthorized
              ? 'The saved target credential cannot inventory organization user attributes. Use an Organization API key or confirm the prerequisite manually.'
              : `Target user-attribute inventory failed: ${error instanceof Error ? error.message : String(error)}.`,
          };
        }
      },
    );
    targetUserAttributeCache.set(destination.id, next);
    return next;
  }

  function sourceDocumentAccess(documentId: string) {
    const cached = sourceDocumentAccessCache.get(documentId);
    if (cached) return cached;
    const next = cachedPreviewRead(
      `source-document-access:${documentId}`,
      async () => {
        try {
          return {
            principals: await sourceClient.listDocumentAccess(documentId),
            status: 'available' as const,
          };
        } catch (error) {
          const unauthorized = error instanceof OmniClientError && (error.status === 401 || error.status === 403);
          return {
            principals: [],
            status: unauthorized ? 'unauthorized' as const : 'unavailable' as const,
            warning: unauthorized
              ? 'The saved source credential cannot inspect dashboard access. Confirm source sharing manually before migration.'
              : `Source dashboard access inventory failed: ${error instanceof Error ? error.message : String(error)}.`,
          };
        }
      },
    );
    sourceDocumentAccessCache.set(documentId, next);
    return next;
  }

  function targetIdentityInventory(destination: SavedInstance, client: OmniClient) {
    const cached = targetIdentityCache.get(destination.id);
    if (cached) return cached;
    const next = cachedInstanceRead(
      destination.id,
      'target-content-identities',
      async () => {
        const [usersResult, groupsResult] = await Promise.allSettled([
          client.listIdentityUsers(),
          client.listUserGroups(),
        ]);
        const failures = [usersResult, groupsResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        const unauthorized = failures.some((error) => (
          error instanceof OmniClientError && (error.status === 401 || error.status === 403)
        ));
        return {
          users: usersResult.status === 'fulfilled' ? usersResult.value : [],
          groups: groupsResult.status === 'fulfilled' ? groupsResult.value : [],
          status: failures.length === 0
            ? 'available' as const
            : unauthorized
              ? 'unauthorized' as const
              : 'unavailable' as const,
          ...(failures.length > 0 ? {
            warning: unauthorized
              ? 'The saved target credential cannot inventory users and groups. An Organization API key is required to map cross-instance content principals automatically.'
              : `Target user/group inventory failed: ${failures.map((error) => error instanceof Error ? error.message : String(error)).join(' ')}`,
          } : {}),
        };
      },
    );
    targetIdentityCache.set(destination.id, next);
    return next;
  }

  function sourceIdentityInventory() {
    const cached = sourceIdentityCache.get(source.id);
    if (cached) return cached;
    const next = cachedPreviewRead(
      'source-content-identities',
      async () => {
        const [usersResult, groupsResult] = await Promise.allSettled([
          sourceClient.listIdentityUsers(),
          sourceClient.listUserGroups(),
        ]);
        const failures = [usersResult, groupsResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        const unauthorized = failures.some((error) => (
          error instanceof OmniClientError && (error.status === 401 || error.status === 403)
        ));
        return {
          users: usersResult.status === 'fulfilled' ? usersResult.value : [],
          groups: groupsResult.status === 'fulfilled' ? groupsResult.value : [],
          status: failures.length === 0
            ? 'available' as const
            : unauthorized
              ? 'unauthorized' as const
              : 'unavailable' as const,
          ...(failures.length > 0 ? {
            warning: unauthorized
              ? 'The saved source credential cannot inventory users and groups. An Organization API key is required to validate source group membership.'
              : `Source user/group inventory failed: ${failures.map((error) => error instanceof Error ? error.message : String(error)).join(' ')}`,
          } : {}),
        };
      },
    );
    sourceIdentityCache.set(source.id, next);
    return next;
  }

  function referencedGroups(
    instance: SavedInstance,
    client: OmniClient,
    groups: OmniUserGroupRecord[],
    names: string[],
    inventoryStatus: 'available' | 'unauthorized' | 'unavailable',
  ) {
    const normalizedNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const key = `${instance.id}:${normalizedNames.map((name) => name.toLowerCase()).join('|')}`;
    const cached = referencedGroupCache.get(key);
    if (cached) return cached;
    const next = (async () => {
      if (inventoryStatus !== 'available' || normalizedNames.length === 0) {
        return { groups, status: inventoryStatus };
      }
      const groupsByName = new Map(groups.map((group) => [group.displayName.trim().toLowerCase(), group]));
      const requested = normalizedNames
        .map((name) => groupsByName.get(name.toLowerCase()))
        .filter((group): group is OmniUserGroupRecord => Boolean(group));
      const results = await Promise.allSettled(requested.map((group) => client.getUserGroup(group.id)));
      const detailedGroups = results
        .filter((result): result is PromiseFulfilledResult<OmniUserGroupRecord> => result.status === 'fulfilled')
        .map((result) => result.value);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      const unauthorized = failures.some((error) => (
        error instanceof OmniClientError && (error.status === 401 || error.status === 403)
      ));
      const merged = new Map(groups.map((group) => [group.id, group]));
      detailedGroups.forEach((group) => merged.set(group.id, group));
      return {
        groups: [...merged.values()],
        status: failures.length === 0
          ? 'available' as const
          : unauthorized
            ? 'unauthorized' as const
            : 'unavailable' as const,
        ...(failures.length > 0 ? {
          warning: unauthorized
            ? `Group membership for ${normalizedNames.join(', ')} could not be inspected; retrieve-group access requires an Organization API key.`
            : `Group membership inspection failed: ${failures.map((error) => error instanceof Error ? error.message : String(error)).join(' ')}`,
        } : {}),
      };
    })();
    referencedGroupCache.set(key, next);
    return next;
  }

  function modelRoleInventory(input: {
    instance: SavedInstance;
    client: OmniClient;
    principalType: 'user' | 'userGroup';
    principalId: string;
    modelId: string;
    connectionId?: string;
  }) {
    const key = [
      input.instance.id,
      input.principalType,
      input.principalId,
      input.modelId,
      input.connectionId || '',
    ].join(':');
    const cached = modelRoleCache.get(key);
    if (cached) return cached;
    const next = cachedInstanceRead(
      input.instance.id,
      `model-role:${input.principalType}:${input.principalId}:${input.modelId}:${input.connectionId || ''}`,
      async () => {
        try {
          const roles = input.principalType === 'user'
            ? await input.client.listUserModelRoles(input.principalId, {
              modelId: input.modelId,
              connectionId: input.connectionId,
            })
            : await input.client.listUserGroupModelRoles(input.principalId, {
              modelId: input.modelId,
              connectionId: input.connectionId,
            });
          return { roles, status: 'available' as const };
        } catch (error) {
          const unauthorized = error instanceof OmniClientError && (error.status === 401 || error.status === 403);
          return {
            roles: [],
            status: unauthorized ? 'unauthorized' as const : 'unavailable' as const,
            warning: unauthorized
              ? 'The saved credential cannot inspect model-role assignments. Use an Organization API key or confirm roles manually.'
              : `Model-role inventory failed: ${error instanceof Error ? error.message : String(error)}.`,
          };
        }
      },
    );
    modelRoleCache.set(key, next);
    return next;
  }

  function roleForModel(
    roles: OmniModelRoleRecord[],
    modelId: string,
    principalType: 'user' | 'userGroup',
  ): OmniModelRoleRecord | undefined {
    const modelRoles = roles
      .filter((role) => !role.modelId || role.modelId === modelId)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (principalType === 'user') {
      return modelRoles.find((role) => role.from?.type === 'User Role')
        || modelRoles.find((role) => role.resolved === true)
        || modelRoles[0];
    }
    return modelRoles[0];
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
    const sourceTopicCatalog = async (modelId: string) => {
      const original = await originalSourceTopicCatalog(modelId);
      const reviewed = (evidenceContext.reconstructedTopics?.[target.id] || []).filter((row) => row.sourceModelId === modelId);
      return [...original, ...reviewed.map((row) => ({ name: row.sourceTopicName,
        fileName: row.sourceFileName, yaml: row.yaml }))];
    };
    const destination = requireInstance(target.destinationInstanceId);
    evidenceContext.signal?.throwIfAborted();
    const destinationClient = new OmniClient(destination, { signal: evidenceContext.signal });
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
    let targetYamlSnapshot: Promise<OmniModelYamlResponse> | null = null;
    const reuseDestinationSnapshot = Boolean(input.prepareDependencyPatchCandidates && evidenceContext.loadDestinationYaml);
    async function loadTargetYamlSnapshot(): Promise<OmniModelYamlResponse> {
      if (targetYamlSnapshot) return targetYamlSnapshot;
      targetYamlSnapshot = reuseDestinationSnapshot
        ? evidenceContext.loadDestinationYaml!(destination.id, target.targetModelId)
        : cachedInstanceRead(
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
    const hasPermissionWrites = (target.permissionDecisions || []).some((decision) => decision.action === 'create_from_source');
    let targetModelRecord: { gitConfigured?: boolean; pullRequestRequired?: boolean; gitProtected?: boolean } | undefined;
    if (hasCreateTopicMappings || hasCreateQueryViewMappings || hasCreateFieldMappings || hasPermissionWrites) {
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
	      if (reuseDestinationSnapshot) {
            const snapshot = await loadTargetYamlSnapshot();
            targetTopics = topicsFromModelYamlFiles(snapshot.files, snapshot.checksums);
            return targetTopics;
          }
	      targetTopics = await cachedInstanceRead(
	        destination.id,
	        `target-topics:${target.targetModelId}`,
	        () => destinationClient.listModelTopics(target.targetModelId, { includeYaml: true, includeChecksums: true }),
	      );
	      return targetTopics;
	    }

    async function loadTargetQueryViewsForPreflight(): Promise<OmniModelQueryViewRecord[]> {
      if (targetQueryViews) return targetQueryViews;
      if (reuseDestinationSnapshot) {
        const snapshot = await loadTargetYamlSnapshot();
        targetQueryViews = queryViewsFromModelYamlFiles(snapshot.files).map((view) => ({ ...view,
          ...(view.fileName && snapshot.checksums?.[view.fileName] ? { checksum: snapshot.checksums[view.fileName] } : {}),
        }));
        return targetQueryViews;
      }
      targetQueryViews = await cachedInstanceRead(
        destination.id,
        `target-query-views:${target.targetModelId}`,
        () => destinationClient.listModelQueryViews(target.targetModelId, { includeYaml: true, includeChecksums: true }),
      );
      return targetQueryViews;
    }

    const updateMatchesBySourceIdentifier = new Map<string, {
      destinationDocumentId: string;
      destinationDocumentName: string;
    }>();
    const replacementDocumentKeys = new Set<string>();
    const replacementFallbackWarningsBySourceIdentifier = new Map<string, string>();

    function markReplacementDocument(document: OmniDocumentRecord): void {
      if (document.identifier) replacementDocumentKeys.add(document.identifier);
      if (document.id) replacementDocumentKeys.add(document.id);
    }

    function isReplacementDocument(document: OmniDocumentRecord): boolean {
      return Boolean(
        (document.identifier && replacementDocumentKeys.has(document.identifier))
        || (document.id && replacementDocumentKeys.has(document.id)),
      );
    }

    if (!input.emptyFirst && replaceSameNamed) {
      const existingByName = new Map<string, OmniDocumentRecord>();
      for (const existingDoc of existing) {
        if (selectedNames.has(existingDoc.name) && !existingByName.has(existingDoc.name)) {
          existingByName.set(existingDoc.name, existingDoc);
        }
      }
      for (const doc of groupSelected) {
        const existingDoc = existingByName.get(doc.name);
        if (!existingDoc) continue;
        if (destination.id === source.id && documentKeyMatches(existingDoc, selectedSourceDocumentKeys)) {
          cleanupNotices.push(`Skipped target cleanup for selected source dashboard ${existingDoc.name} because source and target are the same Omni instance.`);
          continue;
        }
        if ((target.sameNamedStrategy || 'update') === 'replace') {
          markReplacementDocument(existingDoc);
          continue;
        }
        const probe = await probeDocumentV2Support(destination, destinationClient, existingDoc.identifier || existingDoc.id);
        if (probe.supported) {
          updateMatchesBySourceIdentifier.set(doc.identifier, {
            destinationDocumentId: existingDoc.identifier || existingDoc.id,
            destinationDocumentName: existingDoc.name,
          });
          continue;
        }
        markReplacementDocument(existingDoc);
        if (probe.warning) replacementFallbackWarningsBySourceIdentifier.set(doc.identifier, probe.warning);
      }
    }

    for (const existingDoc of existing) {
      const replacingExistingDoc = !input.emptyFirst && replaceSameNamed && isReplacementDocument(existingDoc);
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
      const updateMatch = updateMatchesBySourceIdentifier.get(doc.identifier);
      let compatibilityWarnings = [...destinationWarnings];
      let compatibilityNotices: string[] = [];
      let queryViewWarnings = [...targetQueryViewWarnings];
      let relationshipWarnings: string[] = [];
      let topicWarnings = [...targetTopicWarnings];
      let resolvedQueryViewMappings: MigrationQueryViewMapping[] = [];
      let resolvedFieldMappings: MigrationFieldMapping[] = [];
      let resolvedTopicMappings: MigrationTopicMapping[] = [];
      let sourceTopics: SourceTopicRef[] = [];
      let sourceQueryViewRows: OmniModelQueryViewRecord[] = [];
      let requiredQueryViews: RequiredQueryViewDetail[] = [];
      let fieldDependencies: MigrationFieldDependency[] = [];
      let relationshipEdges: RelationshipEdgeReference[] = [];
      let existingRelationshipEdges: RelationshipEdgeReference[] = [];
      let sourceModelId: string | undefined;
      let sourceEvidence: DashboardSourceEvidence | undefined;
      let sourceProvenanceUnavailable = false;
      const dependencyProposalsWithheld: MigrationDependencyProposalWithheld[] = [];
      let unresolvedMissingFields: string[] = [];
      let semanticPatches: MigrationSemanticPatch[] = [];
      let permissionDependencies: MigrationPermissionDependency[] = [];
      const permissionDecisions = normalizePermissionDecisions(target.permissionDecisions);
      let queryRequirements: Array<{ queryId: string; name: string; kind: 'query' | 'non_query' }> = [];
      const queryValidationBlockers: string[] = [];
      const queryViewBlockers: string[] = [];
      const fieldBlockers: string[] = [];
      const relationshipBlockers: string[] = [];
      const topicBlockers: string[] = [];
      const permissionBlockers: string[] = [];
      const permissionWarnings: string[] = [];
      const topicCompatibilityBlockers: string[] = [];
      const fallbackWarning = replacementFallbackWarningsBySourceIdentifier.get(doc.identifier);
      if (fallbackWarning) compatibilityWarnings.push(fallbackWarning);
      try {
        queryRequirements = (await sourceDocumentQueries(doc.identifier)).map((queryRecord) => ({
          queryId: queryRecord.id,
          name: queryRecord.name,
          kind: queryRecord.query && Object.keys(queryRecord.query).length > 0 ? 'query' : 'non_query',
        }));
      } catch (error) {
        queryValidationBlockers.push(`Dashboard query inventory could not be loaded for ${doc.name}: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}.`);
      }
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
        try {
          const rawState = await sourceDocumentState(doc);
          const state = isRecord(rawState.document) ? rawState.document : isRecord(rawState.state) ? rawState.state : rawState;
          if (typeof state.modelId !== 'string' || !state.modelId.trim()) throw new Error('Shared model binding unavailable.');
          if (typeof state.workbookModelId !== 'string' || !state.workbookModelId.trim()) throw new Error('Workbook model binding unavailable.');
          sourceModelId = state.modelId.trim();
          const workbookModelId = state.workbookModelId.trim();
          let evidence = sourceEvidenceCache.get(doc.identifier);
          if (!evidence) {
            evidence = readDashboardSourceEvidence({
              sharedModelId: sourceModelId,
              workbookModelId,
              references: refs,
              states: [state],
              loadYaml: (modelId, options) => options.mode === 'extension'
                ? sourceWorkbookYamlFiles(modelId)
                : sourceAuthoredYamlFiles(modelId),
            });
            sourceEvidenceCache.set(doc.identifier, evidence);
          }
          sourceEvidence = await evidence;
          refs = [...new Set([...refs, ...sourceEvidence.fields.map((field) => field.reference)])];
        } catch {
          sourceProvenanceUnavailable = true;
          fieldBlockers.push('Published source-model provenance could not be verified; shared-model changes are blocked.');
        }
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
                queryViewWarnings.push(`Using existing query view ${mapping.targetQueryViewName} unchanged even though compatibility checks need review.`);
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
            const queryViewPatchMappings = [...resolvedQueryViewMappings];
            if (input.prepareDependencyPatchCandidates) {
              const candidates = dashboardSafeCopyDependencyPatchCandidates({
                queryViews: requiredQueryViews,
                configuredQueryViewMappings: target.queryViewMappings || [],
              });
              queryViewPatchMappings.push(...candidates.queryViewMappings.filter((mapping) => (
                !mappingForSourceQueryView({ name: mapping.sourceQueryViewName }, queryViewPatchMappings)
              )));
            }
            if (sourceModelId && queryViewPatchMappings.length > 0) {
              try {
                sourceQueryViewRows = await sourceQueryViewCatalog(sourceModelId);
                const queryViewPatches = queryViewPatchMappings
                  .map((mapping) => semanticPatchForQueryViewMapping({
                    mapping,
                    sourceQueryViews: sourceQueryViewRows,
                    targetQueryViews: targetQueryViewRows,
                  }))
                  .filter((patch): patch is MigrationSemanticPatch => Boolean(patch));
                semanticPatches.push(...queryViewPatches);
                resolvedQueryViewMappings = resolvedQueryViewMappings.map((mapping) => {
                  const requiredQueryView = requiredQueryViews.find((queryView) => (
                    mappingForSourceQueryView(queryView, [mapping]) === mapping
                  ));
                  return {
                    ...mapping,
                    ...queryViewMappingFieldCoverage({
                      mapping,
                      requiredFieldRefs: requiredQueryView?.requiredFieldRefs || [],
                      sourceQueryViews: sourceQueryViewRows,
                      targetQueryViews: targetQueryViewRows,
                      acceptedSemanticPatches,
                    }),
                  };
                });
                requiredQueryViews = requiredQueryViews.map((queryView) => {
                  const mapping = mappingForSourceQueryView(queryView, resolvedQueryViewMappings);
                  return mapping ? {
                    ...queryView,
                    suppliedFieldRefs: mapping.suppliedFieldRefs || [],
                    fieldEvidence: mapping.fieldEvidence,
                  } : queryView;
                });
                if (!targetFields.warning) {
                  const targetYamlFiles = await targetModelYamlFiles(
                    destination,
                    destinationClient,
                    target.targetModelId,
                  );
                  const targetSemanticViewNames = new Set(targetViewNames);
                  for (const fileName of Object.keys(targetYamlFiles)) {
                    if (!fileName.endsWith('.view')) continue;
                    for (const variant of viewNameVariants(fileName)) targetSemanticViewNames.add(variant);
                  }
                  const targetReferenceValidation = validatePlannedQueryViewTargetReferences({
                    queryViewMappings: resolvedQueryViewMappings,
                    sourceQueryViews: sourceQueryViewRows,
                    targetQueryViews: targetQueryViewRows,
                    targetViewNames: targetSemanticViewNames,
                    targetModelName: target.targetModelName || target.targetModelId,
                    acceptedSemanticPatches,
                  });
                  queryViewBlockers.push(...targetReferenceValidation.blockers);
                  if (targetReferenceValidation.issues.length > 0) {
                    requiredQueryViews = requiredQueryViews.map((queryView) => {
                      const issue = targetReferenceValidation.issues.find((candidate) => (
                        queryViewKey(candidate.sourceQueryViewName) === queryViewKey(queryView.name)
                      ));
                      return issue ? {
                        ...queryView,
                        compatibility: {
                          status: 'missing_required_dependencies',
                          targetQueryViewName: issue.targetQueryViewName,
                          targetFileName: issue.targetFileName,
                          missingRequiredDependencies: issue.missingTargetViewNames,
                          reason: `The planned query-view YAML references views that are not available in ${target.targetModelName || target.targetModelId}.`,
                        },
                      } : queryView;
                    });
                  }
                }
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
            compatibilityNotices.push(`${resolvedByQueryViewPrep.length} referenced field${resolvedByQueryViewPrep.length === 1 ? '' : 's'} were verified in the planned query-view YAML: ${formatFieldList(resolvedByQueryViewPrep)}.`);
          }
        }
        if (unresolvedMissingFields.length > 0) {
          let sourceDefinitions = new Map<string, ModelFieldDefinition>();
          try {
            if (!sourceModelId) {
              fieldBlockers.push(`Cannot inspect source field definitions for ${doc.name} because the source model ID could not be detected.`);
            } else {
              // Runtime/inherited definitions can inform compatibility, but
              // readiness proposals must retain an authored source definition.
              sourceDefinitions = fieldDefinitionIndex(await (input.prepareDependencyPatchCandidates
                ? sourceAuthoredYamlFiles(sourceModelId)
                : sourceModelYamlFiles(sourceModelId)));
              if (sourceQueryViewRows.length === 0) {
                sourceQueryViewRows = await sourceQueryViewCatalog(sourceModelId);
              }
              mergeFieldDefinitions(sourceDefinitions, sourceQueryViewRows);
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
          const fieldPatchMappings = [...resolvedFieldMappings];
          if (input.prepareDependencyPatchCandidates) {
            const candidates = dashboardSafeCopyDependencyPatchCandidates({ fieldDependencies });
            fieldPatchMappings.push(...candidates.fieldMappings.filter((mapping) => (
              !mappingForSourceField(mapping.sourceFieldRef, target.fieldMappings || [])
              && !mappingForSourceField(mapping.sourceFieldRef, fieldPatchMappings)
            )));
          }
          if (fieldPatchMappings.length > 0) {
            try {
              const targetYaml = await loadTargetYamlSnapshot();
              semanticPatches.push(...fieldPatchMappings
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
              conflictingRelationshipEdges: relationshipDetection.conflictingRelationshipEdges,
            });
            if (relationshipPatch) semanticPatches.push(relationshipPatch);
            const acceptedRelationshipPatch = activeSemanticPatchFor(
              acceptedSemanticPatches,
              'relationship',
              'relationships',
              'relationships',
            );
            if (acceptedRelationshipPatch?.resolution === 'keep_target') {
              relationshipBlockers.length = 0;
              relationshipWarnings.push('Existing target relationship YAML will be kept by explicit user choice.');
            } else if (semanticPatchWriteYaml(acceptedRelationshipPatch)) {
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
            // Resolve source identity before destination choices. Otherwise an
            // unmapped topic loses a known authored filename at the early exit.
            let exactAuthoredTopic = false;
            if (sourceModelId) {
              try {
                const identity = (value: string) => value.normalize('NFKC').trim().toLowerCase();
                const sourceKeys = new Set([topic.name, topic.id].filter((value): value is string => Boolean(value)).map(identity));
                const exactTopics = (await sourceTopicCatalog(sourceModelId)).filter((candidate) => {
                  if (!candidate.fileName?.endsWith('.topic')) return false;
                  const stem = identity(candidate.fileName.replace(/\.topic$/, ''));
                  const leaf = stem.split('/').pop()!;
                  return (sourceKeys.has(stem) || sourceKeys.has(leaf))
                    && identity(candidate.name) === leaf
                    && (!topic.fileName || identity(topic.fileName) === identity(candidate.fileName));
                });
                if (exactTopics.length === 1) {
                  topic.fileName = exactTopics[0].fileName;
                  exactAuthoredTopic = true;
                }
              } catch {
                topicWarnings.push(`Authored source topic identity could not be verified for ${topic.name}.`);
              }
            }
            if (!exactAuthoredTopic) {
              topicBlockers.push(`One exact authored source topic file is required for ${topic.name}; labels alone cannot establish source identity.`);
              continue;
            }
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
	                  if (sourceTopicYaml?.fileName?.trim()) topic.fileName = sourceTopicYaml.fileName;
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
                        topicCompatibilityBlockers.push(...compatibilityBlockers);
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
              if (sourceTopicYaml.fileName?.trim()) topic.fileName = sourceTopicYaml.fileName;
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
        if (sourceModelId) {
          try {
            const sourceFiles = await sourceModelYamlFiles(sourceModelId);
            if (migrationFilesHavePermissionEvidence(sourceFiles)) {
            const targetYaml = await loadTargetYamlSnapshot();
            const targetFiles = targetYaml.files;
            const permissionFileMappings: MigrationPermissionFileMapping[] = [];
            const permissionFieldTargets: MigrationPermissionFieldTarget[] = [];
            const fileMappingKeys = new Set<string>();
            const addPermissionFileMapping = (sourceFileName?: string, targetFileName?: string) => {
              if (!sourceFileName || !targetFileName) return;
              const key = `${sourceFileName}:${targetFileName}`;
              if (fileMappingKeys.has(key)) return;
              fileMappingKeys.add(key);
              permissionFileMappings.push({ sourceFileName, targetFileName });
            };

            addPermissionFileMapping('model', 'model');
            const sourceDefinitions = fieldDefinitionIndex(sourceFiles);
            const configuredFieldMappings = new Map(
              normalizeFieldMappings(target.fieldMappings)
                .map((mapping) => [mapping.sourceFieldRef.toLowerCase(), mapping]),
            );
            for (const mapping of resolvedFieldMappings) {
              configuredFieldMappings.set(mapping.sourceFieldRef.toLowerCase(), mapping);
            }

            for (const sourceFieldRef of refs) {
              const sourceDefinition = sourceDefinitions.get(sourceFieldRef.toLowerCase());
              const fieldMapping = configuredFieldMappings.get(sourceFieldRef.toLowerCase());
              if (fieldMapping?.action === 'ignore') continue;
              const targetFieldRef = fieldMapping?.targetFieldRef || sourceFieldRef;
              const targetDefinition = targetFields.definitions.get(targetFieldRef.toLowerCase());
              const sourceViewName = fieldRefParts(sourceFieldRef).viewName;
              const targetViewName = fieldRefParts(targetFieldRef).viewName || sourceViewName;
              const sourceFileName = fieldMapping?.sourceFileName
                || sourceDefinition?.sourceFileName
                || semanticYamlFileForViewName(sourceFiles, sourceViewName);
              const targetFileName = fieldMapping?.targetFileName
                || targetDefinition?.sourceFileName
                || semanticYamlFileForViewName(targetFiles, targetViewName)
                || (sourceFileName ? semanticYamlFileByLeaf(targetFiles, sourceFileName) : undefined);
              if (!sourceFileName || !targetFileName) continue;
              addPermissionFileMapping(sourceFileName, targetFileName);
              permissionFieldTargets.push({
                sourceFieldRef,
                targetFieldRef,
                sourceFileName,
                targetFileName,
              });
            }

            const sourceTopicRows = sourceTopics.length > 0 ? await sourceTopicCatalog(sourceModelId) : [];
            const targetTopicRows = sourceTopics.length > 0 ? await loadTargetTopicsForPreflight() : [];
            for (const topic of sourceTopics) {
              const mapping = mappingForSourceTopic(topic, resolvedTopicMappings);
              const sourceTopic = findSourceTopicYaml(sourceTopicRows, topic);
              if (!mapping || !sourceTopic?.fileName) continue;
              const targetTopic = findSourceTopicYaml(targetTopicRows, {
                name: mapping.targetTopicName,
                id: mapping.targetTopicName,
              });
              const targetFileName = targetTopic?.fileName
                || semanticYamlFileByLeaf(targetFiles, sourceTopic.fileName)
                || `${mapping.targetTopicName}.topic`;
              addPermissionFileMapping(sourceTopic.fileName, targetFileName);

              for (const sourceViewName of extractTopicViewReferences(sourceTopic.yaml)) {
                const sourceFileName = semanticYamlFileForViewName(sourceFiles, sourceViewName);
                if (!sourceFileName) continue;
                const mappedField = [...configuredFieldMappings.values()].find((fieldMapping) => (
                  fieldRefParts(fieldMapping.sourceFieldRef).viewName.toLowerCase() === sourceViewName.toLowerCase()
                  && fieldMapping.targetFieldRef
                ));
                const targetViewName = mappedField?.targetFieldRef
                  ? fieldRefParts(mappedField.targetFieldRef).viewName
                  : sourceViewName;
                const targetFileNameForView = semanticYamlFileForViewName(targetFiles, targetViewName)
                  || semanticYamlFileByLeaf(targetFiles, sourceFileName);
                addPermissionFileMapping(sourceFileName, targetFileNameForView);
              }
            }

            const sourceQueryViewRows = requiredQueryViews.length > 0 ? await sourceQueryViewCatalog(sourceModelId) : [];
            const targetQueryViewRows = requiredQueryViews.length > 0 ? await loadTargetQueryViewsForPreflight() : [];
            for (const mapping of resolvedQueryViewMappings) {
              const sourceQueryView = sourceQueryViewForMapping(sourceQueryViewRows, mapping);
              if (!sourceQueryView?.fileName) continue;
              const targetQueryView = queryViewFromCatalogByValue(targetQueryViewRows, mapping.targetQueryViewName)
                || queryViewFromCatalogByValue(targetQueryViewRows, mapping.targetFileName);
              addPermissionFileMapping(
                sourceQueryView.fileName,
                mapping.targetFileName
                  || targetQueryView?.fileName
                  || semanticYamlFileByLeaf(targetFiles, sourceQueryView.fileName)
                  || `${mapping.targetQueryViewName}.query.view`,
              );
            }

            const attributeInventory = await targetUserAttributes(destination, destinationClient);
            if (attributeInventory.warning) permissionWarnings.push(attributeInventory.warning);
            const referencedGroupNames = migrationPermissionUserGroupNames(sourceFiles);
            let sourceGroups: OmniUserGroupRecord[] = [];
            let targetGroups: OmniUserGroupRecord[] = [];
            let sourceGroupInventoryStatus: 'available' | 'unauthorized' | 'unavailable' = 'available';
            let targetGroupInventoryStatus: 'available' | 'unauthorized' | 'unavailable' = 'available';
            if (referencedGroupNames.length > 0) {
              const sourceIdentities = await sourceIdentityInventory();
              const targetIdentities = destination.id === source.id
                ? sourceIdentities
                : await targetIdentityInventory(destination, destinationClient);
              if (sourceIdentities.warning) permissionWarnings.push(sourceIdentities.warning);
              if (targetIdentities.warning) permissionWarnings.push(targetIdentities.warning);
              const [sourceGroupDetails, targetGroupDetails] = await Promise.all([
                referencedGroups(
                  source,
                  sourceClient,
                  sourceIdentities.groups,
                  referencedGroupNames,
                  sourceIdentities.status,
                ),
                referencedGroups(
                  destination,
                  destinationClient,
                  targetIdentities.groups,
                  referencedGroupNames,
                  targetIdentities.status,
                ),
              ]);
              if (sourceGroupDetails.warning) permissionWarnings.push(sourceGroupDetails.warning);
              if (targetGroupDetails.warning) permissionWarnings.push(targetGroupDetails.warning);
              sourceGroups = sourceGroupDetails.groups;
              targetGroups = targetGroupDetails.groups;
              sourceGroupInventoryStatus = sourceGroupDetails.status;
              targetGroupInventoryStatus = targetGroupDetails.status;
            }
            permissionDependencies.push(...discoverMigrationPermissionDependencies({
              sourceFiles: {
                ...sourceFiles,
                model: sourceFiles.model || '',
              },
              targetFiles: {
                ...targetFiles,
                model: targetFiles.model || '',
              },
              fileMappings: permissionFileMappings,
              fieldTargets: permissionFieldTargets,
              targetUserAttributes: attributeInventory.names,
              targetUserAttributeDefinitions: attributeInventory.definitions,
              userAttributeInventoryStatus: attributeInventory.status,
              sourceGroups,
              targetGroups,
              sourceGroupInventoryStatus,
              targetGroupInventoryStatus,
              affectedRoutes: [`${routeGroup.name} -> ${destination.label}`],
            }));
            permissionBlockers.push(...migrationPermissionDecisionBlockers(permissionDependencies, permissionDecisions));
            if (
              permissionDecisions.some((decision) => decision.action === 'create_from_source')
              && (targetModelRecord?.pullRequestRequired || targetModelRecord?.gitProtected)
            ) {
              permissionBlockers.push(`Permission YAML cannot be written directly because ${target.targetModelName || target.targetModelId} requires a protected branch or pull request.`);
            }
            if (
              permissionDecisions.some((decision) => decision.action === 'create_from_source')
              && targetModelRecord?.gitConfigured
            ) {
              permissionWarnings.push(`Permission YAML for ${target.targetModelName || target.targetModelId} is git configured and may require Omni-side review after preparation.`);
            }

            if (permissionDependencies.length > 0 && permissionBlockers.length === 0) {
              const effectiveTargetFiles = { ...targetFiles };
              for (const patch of semanticPatches) {
                if (patch.recommendedYaml?.trim()) effectiveTargetFiles[patch.targetFileName] = patch.recommendedYaml;
              }
              const compiledPermissionPatches = compileMigrationPermissionPatches({
                dependencies: permissionDependencies,
                decisions: permissionDecisions,
                targetFiles: effectiveTargetFiles,
                fieldTargets: permissionFieldTargets,
              });
              for (const compiled of compiledPermissionPatches) {
                const existingPatchIndex = semanticPatches.findIndex((patch) => patch.targetFileName === compiled.targetFileName);
                if (existingPatchIndex >= 0) {
                  const existingPatch = semanticPatches[existingPatchIndex];
                  semanticPatches[existingPatchIndex] = {
                    ...existingPatch,
                    recommendedYaml: compiled.recommendedYaml,
                    recommendedAction: `${existingPatch.recommendedAction || 'Apply the semantic update'} Include the approved security and access rules.`,
                    dependencyPath: [
                      {
                        kind: 'permission',
                        label: `${compiled.dependencyIds.length} approved security rule${compiled.dependencyIds.length === 1 ? '' : 's'}`,
                        detail: 'Security dependencies are compiled into this same full-file patch.',
                      },
                      ...(existingPatch.dependencyPath || []),
                    ],
                    warnings: [...new Set([...(existingPatch.warnings || []), ...compiled.warnings])],
                  };
                  continue;
                }
                const currentYaml = targetFiles[compiled.targetFileName];
                const safety = updatePatchSafety({
                  currentYaml,
                  previousChecksum: targetYaml.checksums?.[compiled.targetFileName],
                  createCategory: 'safe_create',
                  updateCategory: 'safe_update',
                });
                semanticPatches.push({
                  id: semanticPatchId({
                    artifactType: 'permission',
                    sourceName: compiled.sourceFileNames.join(', ') || compiled.targetFileName,
                    targetFileName: compiled.targetFileName,
                  }),
                  artifactType: 'permission',
                  sourceName: compiled.sourceFileNames.join(', ') || compiled.targetFileName,
                  sourceFileName: compiled.sourceFileNames[0],
                  targetFileName: compiled.targetFileName,
                  targetModelId: target.targetModelId,
                  currentYaml,
                  recommendedYaml: compiled.recommendedYaml,
                  previousChecksum: targetYaml.checksums?.[compiled.targetFileName],
                  resolution: 'recommended',
                  status: safety.status,
                  safetyCategory: safety.safetyCategory,
                  recommendedAction: `Add ${compiled.dependencyIds.length} approved security rule${compiled.dependencyIds.length === 1 ? '' : 's'} without removing target-only YAML.`,
                  dependencyPath: [
                    {
                      kind: 'permission',
                      label: `${compiled.dependencyIds.length} approved security rule${compiled.dependencyIds.length === 1 ? '' : 's'}`,
                      detail: 'Dashboard security depends on these model controls.',
                    },
                    {
                      kind: 'model_file',
                      label: compiled.targetFileName,
                      ref: compiled.targetFileName,
                      detail: currentYaml ? 'Destination YAML will be updated additively.' : 'Destination YAML will be created.',
                    },
                  ],
                  warnings: [...new Set([...compiled.warnings, ...safety.warnings])],
                });
              }
            }
            }
          } catch (error) {
            permissionBlockers.push(`Security and access dependencies could not be inspected: ${error instanceof Error ? error.message : String(error)}.`);
          }
        }
        if (input.documentAccessPolicy === 'destination_defaults') {
          permissionWarnings.push('Source dashboard sharing, ownership, roles, and ability settings are intentionally not copied. The selected destination folder and its governed defaults remain authoritative.');
        } else try {
          const sourceAccess = await sourceDocumentAccess(doc.identifier);
          if (sourceAccess.warning) permissionWarnings.push(sourceAccess.warning);
          if (sourceAccess.status !== 'available') {
            const accessInventoryDependency: MigrationPermissionDependency = {
              id: `permission:document_access_inventory:${doc.identifier}`,
              kind: 'document_access',
              sourceRef: `${doc.name} access inventory`,
              sourceValue: {
                documentId: doc.identifier,
                inventoryStatus: sourceAccess.status,
              },
              targetCandidates: [],
              status: 'blocked',
              risk: 'high',
              reason: 'OmniKit could not inspect the source dashboard access list. Review source sharing manually and confirm that the target permissions are safe before continuing.',
              recommendedAction: 'manual_prerequisite',
              affectedRoutes: [`${routeGroup.name} -> ${destination.label}`],
            };
            permissionDependencies.push(accessInventoryDependency);
            permissionBlockers.push(
              ...migrationPermissionDecisionBlockers([accessInventoryDependency], permissionDecisions),
            );
          } else {
            if (sourceAccess.principals.some((principal) => principal.isOwner)) {
              permissionWarnings.push('Source document ownership is not transferred. The imported dashboard remains owned by the migration actor.');
            }
            let identityInventory: {
              users: OmniIdentityUserRecord[];
              groups: OmniUserGroupRecord[];
              status: 'available' | 'unauthorized' | 'unavailable';
              warning?: string;
            };
            if (destination.id === source.id) {
              identityInventory = {
                users: sourceAccess.principals
                  .filter((principal) => principal.type === 'user')
                  .map((principal) => ({
                    id: principal.id,
                    displayName: principal.name,
                    userName: principal.email || principal.name,
                    email: principal.email,
                    active: true,
                  })),
                groups: sourceAccess.principals
                  .filter((principal) => principal.type === 'userGroup')
                  .map((principal) => ({
                    id: principal.id,
                    displayName: principal.name,
                  })),
                status: 'available',
              };
            } else {
              identityInventory = await targetIdentityInventory(destination, destinationClient);
            }
            if (identityInventory.warning) permissionWarnings.push(identityInventory.warning);
            const contentDependencies = discoverMigrationContentAccessDependencies({
              documentId: doc.identifier,
              documentName: doc.name,
              sourcePrincipals: sourceAccess.principals,
              targetUsers: identityInventory.users,
              targetGroups: identityInventory.groups,
              targetIdentityInventoryStatus: identityInventory.status,
              affectedRoutes: [`${routeGroup.name} -> ${destination.label}`],
            });
            permissionDependencies.push(...contentDependencies);
            permissionBlockers.push(...migrationPermissionDecisionBlockers(contentDependencies, permissionDecisions));
            if (sourceModelId && target.targetModelId) {
              const resolvedSourceModelId = sourceModelId;
              const resolvedTargetModelId = target.targetModelId;
              const directPrincipals = sourceAccess.principals.filter((principal) => (
                principal.accessSource === 'direct' && !principal.isOwner
              ));
              const modelRoleDependencies = await Promise.all(directPrincipals.map(async (principal) => {
                const accessDependency = contentDependencies.find((dependency) => (
                  dependency.kind === 'document_access'
                  && migrationContentAccessValue(dependency.sourceValue)?.sourcePrincipalId === principal.id
                ));
                const targetRef = accessDependency?.targetCandidates.find((candidate) => (
                  candidate.compatibility !== 'conflict'
                ))?.targetRef;
                const separator = targetRef?.indexOf(':') ?? -1;
                const targetPrincipalId = separator > 0 ? targetRef?.slice(separator + 1) : undefined;
                const sourceRoleInventory = await modelRoleInventory({
                  instance: source,
                  client: sourceClient,
                  principalType: principal.type,
                  principalId: principal.id,
                  modelId: resolvedSourceModelId,
                  connectionId: input.sourceConnectionId,
                });
                const targetRoleInventory = targetPrincipalId
                  ? await modelRoleInventory({
                    instance: destination,
                    client: destinationClient,
                    principalType: principal.type,
                    principalId: targetPrincipalId,
                    modelId: resolvedTargetModelId,
                    connectionId: target.targetConnectionId,
                  })
                  : {
                    roles: [] as OmniModelRoleRecord[],
                    status: identityInventory.status,
                    warning: identityInventory.warning,
                  };
                if (sourceRoleInventory.warning) permissionWarnings.push(sourceRoleInventory.warning);
                if (targetRoleInventory.warning) permissionWarnings.push(targetRoleInventory.warning);
                const sourceRole = roleForModel(sourceRoleInventory.roles, resolvedSourceModelId, principal.type);
                const targetRole = roleForModel(targetRoleInventory.roles, resolvedTargetModelId, principal.type);
                return discoverMigrationModelRoleDependency({
                  principalType: principal.type,
                  principalLabel: principal.email || principal.name,
                  sourcePrincipalId: principal.id,
                  targetPrincipalId,
                  sourceRole: sourceRole ? {
                    baseRole: sourceRole.baseRole,
                    roleName: sourceRole.roleName,
                    connectionId: sourceRole.connectionId,
                    modelId: sourceRole.modelId,
                    resolved: sourceRole.resolved,
                    sourceType: sourceRole.from?.type,
                  } : undefined,
                  targetRole: targetRole ? {
                    baseRole: targetRole.baseRole,
                    roleName: targetRole.roleName,
                    connectionId: targetRole.connectionId,
                    modelId: targetRole.modelId,
                    resolved: targetRole.resolved,
                    sourceType: targetRole.from?.type,
                  } : undefined,
                  sourceInventoryStatus: sourceRoleInventory.status,
                  targetInventoryStatus: targetRoleInventory.status,
                  sourceConnectionId: input.sourceConnectionId,
                  sourceModelId: resolvedSourceModelId,
                  targetConnectionId: target.targetConnectionId,
                  targetModelId: resolvedTargetModelId,
                  affectedRoutes: [`${routeGroup.name} -> ${destination.label}`],
                });
              }));
              const resolvedRoleDependencies = modelRoleDependencies.filter(
                (dependency): dependency is MigrationPermissionDependency => Boolean(dependency),
              );
              permissionDependencies.push(...resolvedRoleDependencies);
              permissionBlockers.push(
                ...migrationPermissionDecisionBlockers(resolvedRoleDependencies, permissionDecisions),
              );
            }
          }
          const documentSettingsDependency = discoverMigrationDocumentSettingsDependency({
            documentId: doc.identifier,
            documentName: doc.name,
            updateInPlace: Boolean(updateMatch),
            hasSecurityDependencies: permissionDependencies.length > 0,
            affectedRoutes: [`${routeGroup.name} -> ${destination.label}`],
          });
          if (documentSettingsDependency) {
            permissionDependencies.push(documentSettingsDependency);
            permissionBlockers.push(
              ...migrationPermissionDecisionBlockers([documentSettingsDependency], permissionDecisions),
            );
          }
        } catch (error) {
          permissionBlockers.push(`Dashboard access dependencies could not be inspected: ${error instanceof Error ? error.message : String(error)}.`);
        }
      } catch (error) {
        compatibilityWarnings.push(`Compatibility preflight could not inspect ${doc.name}: ${error instanceof Error ? error.message : String(error)}.`);
      }
      const blockedSourceFields = sourceEvidence?.fields.filter((field) => !field.sharedWriteAllowed) || [];
      if (sourceProvenanceUnavailable || sourceEvidence?.unverified || blockedSourceFields.length > 0) {
        // No authored workbook definition or override may become a shared-model
        // field/query-view/alias proposal, even when a target field already exists.
        const blockedRefs = new Set(blockedSourceFields.map((field) => field.reference.toLowerCase()));
        fieldDependencies = fieldDependencies.filter((field) => !blockedRefs.has(field.sourceFieldRef.toLowerCase()));
        for (const field of blockedSourceFields) {
          const local = field.provenance === 'workbook_local' || field.provenance === 'workbook_override';
          const reason = local
            ? 'This workbook-local field or override must be preserved in the workbook; shared-model repair is not authorized.'
            : sourceEvidence?.findings.find((finding) => finding.reference === field.reference)?.message
              || 'The full authored source dependency closure could not authorize a shared-model repair.';
          const parts = fieldRefParts(field.reference);
          fieldDependencies.push({
            sourceFieldRef: field.reference,
            sourceViewName: parts.viewName,
            sourceFieldName: parts.fieldName,
            sourceFileName: field.sourceFileName,
            sourceProvenance: field.provenance,
            sourceDocumentId: doc.identifier,
            fieldKind: 'unknown',
            status: 'blocked',
            reason,
            targetCandidates: [],
          });
          fieldBlockers.push(`${field.reference}: ${reason}`);
        }
        if (sourceEvidence?.unverified) fieldBlockers.push('Workbook/source evidence requires explicit review before shared-model changes.');
        const unsafeWholeSource = sourceProvenanceUnavailable || sourceEvidence?.findings.some((finding) => (
          ['shared_model', 'workbook_model', 'source_binding', 'source_references', 'workbook_overlay'].includes(finding.reference)
        ));
        const blockedViews = new Set(blockedSourceFields.map((field) => fieldRefParts(field.reference).viewName.toLowerCase()));
        const withheldReason = unsafeWholeSource
          ? 'Authored source/workbook prerequisites must be resolved before shared-model proposals can be prepared.'
          : 'Workbook-local or unverified source dependencies cannot authorize shared-model proposals.';
        const withhold = (artifact: MigrationDependencyProposalWithheld['artifact'], reference: string) => dependencyProposalsWithheld.push({ artifact, reference, reason: withheldReason, sourceDocumentId: doc.identifier });
        for (const field of fieldDependencies) if (unsafeWholeSource) withhold('field', field.sourceFieldRef);
        for (const queryView of requiredQueryViews) if (queryView.status === 'missing_copyable' && (unsafeWholeSource || blockedViews.has(queryView.name.toLowerCase()))) withhold('query_view', queryView.name);
        if (unsafeWholeSource) {
          for (const topic of sourceTopics) withhold('topic', topic.name);
          if (relationshipEdges.length) withhold('relationship', 'relationship');
        }
        semanticPatches = unsafeWholeSource ? [] : semanticPatches.filter((patch) => (
          patch.artifactType === 'field' ? !blockedRefs.has((patch.sourceName || '').toLowerCase())
            : patch.artifactType === 'query_view' ? !blockedViews.has((patch.sourceName || '').toLowerCase()) : true
        ));
        resolvedFieldMappings = unsafeWholeSource ? [] : resolvedFieldMappings.filter((mapping) => !blockedRefs.has(mapping.sourceFieldRef.toLowerCase()));
        resolvedQueryViewMappings = unsafeWholeSource ? [] : resolvedQueryViewMappings.filter((mapping) => !blockedViews.has(mapping.sourceQueryViewName.toLowerCase()));
        if (unsafeWholeSource) resolvedTopicMappings = [];
      }
      const sourceFieldEvidence = new Map(sourceEvidence?.fields.map((field) => [field.reference.toLowerCase(), field]));
      fieldDependencies = fieldDependencies.map((field) => {
        const provenance = sourceFieldEvidence.get(field.sourceFieldRef.toLowerCase())?.provenance;
        return { ...field, sourceDocumentId: doc.identifier, ...(provenance ? { sourceProvenance: provenance } : {}) };
      });
      compatibilityWarnings = [...new Set(compatibilityWarnings)];
      compatibilityNotices = [...new Set(compatibilityNotices)];
      queryViewWarnings = [...new Set(queryViewWarnings)];
      relationshipWarnings = [...new Set(relationshipWarnings)];
      topicWarnings = [...new Set(topicWarnings)];
      permissionDependencies = [...new Map(permissionDependencies.map((dependency) => [
        dependency.id,
        dependency,
      ])).values()];
      const normalizedPermissionWarnings = [...new Set(permissionWarnings)];
      const normalizedPermissionBlockers = [...new Set(permissionBlockers)];
      semanticPatches = mergeSemanticPatchCandidates(
        [...new Map(semanticPatches.map((patch) => [patch.id, patch])).values()],
        acceptedSemanticPatches,
      );
      const blockedSemanticPatchMessages = semanticPatches
        .filter((patch) => patch.resolution !== 'keep_target' && (patch.status === 'blocked' || patch.safetyCategory === 'blocked'))
        .map((patch) => `${semanticPatchArtifactLabel(patch.artifactType)} ${patch.sourceName || patch.targetFileName} needs resolution before dashboard import.`);
      const semanticDetails: Record<string, unknown> = {};
      if (dependencyProposalsWithheld.length) semanticDetails.dependencyProposalsWithheld = dependencyProposalsWithheld;
      if (sourceModelId) semanticDetails.sourceModelId = sourceModelId;
      if (requiredQueryViews.length > 0) semanticDetails.requiredQueryViews = requiredQueryViews;
      if (resolvedQueryViewMappings.length > 0) semanticDetails.queryViewMappings = resolvedQueryViewMappings;
      if (fieldDependencies.length > 0) semanticDetails.fieldDependencies = fieldDependencies;
      if (resolvedFieldMappings.length > 0) semanticDetails.fieldMappings = resolvedFieldMappings;
      if (relationshipEdges.length > 0) semanticDetails.relationshipEdges = relationshipEdges;
      if (existingRelationshipEdges.length > 0) semanticDetails.existingRelationshipEdges = existingRelationshipEdges;
      if (relationshipBlockers.length > 0) semanticDetails.relationshipBlockers = relationshipBlockers;
      if (topicCompatibilityBlockers.length > 0) semanticDetails.topicCompatibilityBlockers = topicCompatibilityBlockers;
      if (permissionDependencies.length > 0) semanticDetails.permissionDependencies = permissionDependencies;
      if (permissionDecisions.length > 0) semanticDetails.permissionDecisions = permissionDecisions;
      if (sourceModelId) semanticDetails.sourceModelId = sourceModelId;
      if (normalizedPermissionBlockers.length > 0) semanticDetails.permissionBlockers = normalizedPermissionBlockers;
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
      if (permissionDependencies.length > 0 || normalizedPermissionBlockers.length > 0) {
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
          kind: 'permission_prepare',
          documentId: doc.identifier,
          documentName: doc.name,
          blocked: normalizedPermissionBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
          error: normalizedPermissionBlockers.length > 0
            ? normalizedPermissionBlockers.join(' ')
            : blockedSemanticPatchMessages.length > 0
              ? blockedSemanticPatchMessages.join(' ')
              : undefined,
          warnings: normalizedPermissionWarnings.length > 0 ? normalizedPermissionWarnings : undefined,
          details: {
            permissionDependencies,
            permissionDecisions,
            permissionBlockers: normalizedPermissionBlockers,
            semanticPatches,
            sourceModelId,
          },
        });
      }
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
          blocked: normalizedPermissionBlockers.length > 0 || queryViewBlockers.length > 0 || fieldBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
          error: normalizedPermissionBlockers.length > 0
            ? 'Field preparation is blocked until security and access dependencies are resolved.'
            : queryViewBlockers.length > 0
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
          blocked: normalizedPermissionBlockers.length > 0 || queryViewBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
          error: normalizedPermissionBlockers.length > 0
            ? 'Query-view preparation is blocked until security and access dependencies are resolved.'
            : queryViewBlockers.length > 0
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
	          blocked: normalizedPermissionBlockers.length > 0 || queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
	          error: normalizedPermissionBlockers.length > 0
              ? 'Relationship preparation is blocked until security and access dependencies are resolved.'
              : queryViewBlockers.length > 0
	            ? 'Relationship preparation is blocked until query-view mappings are resolved.'
              : fieldBlockers.length > 0 ? 'Relationship preparation is blocked until field dependencies are resolved.'
	            : relationshipBlockers.length > 0 ? relationshipBlockers.join(' ')
	              : blockedSemanticPatchMessages.length > 0 ? blockedSemanticPatchMessages.join(' ') : undefined,
	          warnings: relationshipWarnings.length > 0 ? relationshipWarnings : undefined,
	          details: {
	            sourceModelId,
	            relationshipEdges,
	            existingRelationshipEdges,
              relationshipBlockers,
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
	          blocked: normalizedPermissionBlockers.length > 0 || queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || topicBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
	          error: normalizedPermissionBlockers.length > 0
              ? 'Topic preparation is blocked until security and access dependencies are resolved.'
              : queryViewBlockers.length > 0
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
      if (updateMatch) {
        importDetails.sameNamedStrategy = 'update';
        importDetails.destinationDocumentId = updateMatch.destinationDocumentId;
        importDetails.destinationDocumentName = updateMatch.destinationDocumentName;
      } else {
        importDetails.sameNamedStrategy = target.sameNamedStrategy || 'update';
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
        kind: 'semantic_validate',
        documentId: doc.identifier,
        documentName: doc.name,
        blocked: queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || topicBlockers.length > 0 || blockedSemanticPatchMessages.length > 0 || queryValidationBlockers.length > 0,
        error: queryViewBlockers.length > 0
          ? 'Semantic validation is blocked until query-view mappings are resolved.'
          : fieldBlockers.length > 0 ? 'Semantic validation is blocked until field dependencies are resolved.'
          : relationshipBlockers.length > 0 ? 'Semantic validation is blocked until relationship mappings are resolved.'
          : topicBlockers.length > 0 ? 'Semantic validation is blocked until topic mappings are resolved.'
          : blockedSemanticPatchMessages.length > 0 ? 'Semantic validation is blocked until semantic code decisions are refreshed.' : undefined,
        details: importDetails,
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
        kind: 'query_validate',
        documentId: doc.identifier,
        documentName: doc.name,
        blocked: queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || topicBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
        error: queryViewBlockers.length > 0
          ? 'Query validation is blocked until query-view mappings are resolved.'
          : fieldBlockers.length > 0 ? 'Query validation is blocked until field dependencies are resolved.'
          : relationshipBlockers.length > 0 ? 'Query validation is blocked until relationship mappings are resolved.'
          : topicBlockers.length > 0 ? 'Query validation is blocked until topic mappings are resolved.'
          : blockedSemanticPatchMessages.length > 0 ? 'Query validation is blocked until semantic code decisions are refreshed.'
          : queryValidationBlockers.length > 0 ? queryValidationBlockers.join(' ') : undefined,
        details: {
          ...importDetails,
          queryRequirements,
          queryValidationWaivers: normalizeQueryValidationWaivers(target.queryValidationWaivers),
          validationPolicy: {
            queryBackedTilesRequired: true,
            zeroRowsAllowed: true,
            nonQueryTiles: 'not_applicable',
          },
        },
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
        kind: updateMatch ? 'update' : 'import',
        documentId: doc.identifier,
        documentName: doc.name,
        warnings: compatibilityWarnings.length > 0 ? compatibilityWarnings : undefined,
        notices: [...cleanupStepNotices, ...compatibilityNotices].length > 0 ? [...cleanupStepNotices, ...compatibilityNotices] : undefined,
	        blocked: normalizedPermissionBlockers.length > 0 || queryViewBlockers.length > 0 || fieldBlockers.length > 0 || relationshipBlockers.length > 0 || topicBlockers.length > 0 || blockedSemanticPatchMessages.length > 0,
	        error: normalizedPermissionBlockers.length > 0
            ? 'Dashboard import is blocked until security and access dependencies are resolved.'
            : queryViewBlockers.length > 0
	          ? 'Dashboard import is blocked until query-view mappings are resolved.'
            : fieldBlockers.length > 0 ? 'Dashboard import is blocked until field dependencies are resolved.'
	          : relationshipBlockers.length > 0 ? 'Dashboard import is blocked until relationship mappings are resolved.'
	          : topicBlockers.length > 0 ? 'Dashboard import is blocked until topic mappings are resolved.'
	            : blockedSemanticPatchMessages.length > 0 ? 'Dashboard import is blocked until semantic code decisions are refreshed.' : undefined,
        details: Object.keys(importDetails).length > 0 ? importDetails : undefined,
      });
      const contentPermissionDependencies = permissionDependencies.filter((dependency) => (
        dependency.kind === 'document_access'
        || dependency.kind === 'document_settings'
        || dependency.kind === 'folder_access'
      ));
      if (contentPermissionDependencies.length > 0) {
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
          kind: 'permission_apply',
          documentId: doc.identifier,
          documentName: doc.name,
          blocked: normalizedPermissionBlockers.length > 0,
          error: normalizedPermissionBlockers.length > 0
            ? 'Dashboard access application is blocked until content permission decisions are resolved.'
            : undefined,
          warnings: normalizedPermissionWarnings.length > 0 ? normalizedPermissionWarnings : undefined,
          details: {
            permissionDependencies: contentPermissionDependencies,
            permissionDecisions,
          },
        });
      }
      if (permissionDependencies.length > 0) {
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
          kind: 'permission_verify',
          documentId: doc.identifier,
          documentName: doc.name,
          blocked: normalizedPermissionBlockers.length > 0,
          error: normalizedPermissionBlockers.length > 0
            ? 'Security verification is blocked until permission decisions are resolved.'
            : undefined,
          warnings: normalizedPermissionWarnings.length > 0 ? normalizedPermissionWarnings : undefined,
          details: {
            permissionDependencies,
            permissionDecisions,
            sourceModelId,
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
        kind: 'metadata',
        documentId: doc.identifier,
        documentName: doc.name,
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
        kind: 'document_verify',
        documentId: doc.identifier,
        documentName: doc.name,
        details: {
          verificationPolicy: {
            queryBackedTilesRequired: true,
            zeroRowsAllowed: true,
            nonQueryTiles: 'not_applicable',
          },
        },
      });
    }
    }
  }

  if (input.deleteSourceOnSuccess) {
    for (const doc of selected) {
      if (!doc.baseModelId?.trim()) {
        throw new Error(`Source deletion cannot be planned safely for ${doc.name} because its exact source model scope is unavailable.`);
      }
      steps.push({
        destinationId: source.id,
        destinationLabel: source.label,
        targetModelId: doc.baseModelId,
        targetModelName: doc.baseModelName,
        kind: 'source_delete',
        documentId: doc.identifier,
        documentName: doc.name,
      });
    }
  }

  evidenceContext.signal?.throwIfAborted();
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
  if (patch.artifactType === 'permission') {
    if (!/(access_grants|required_access_grants|access_filters|mask_unless_access_grants|default_topic_required_access_grants|default_topic_access_filters)\s*:/m.test(yaml)) {
      messages.push('Security patches must include an access grant, access filter, masking rule, or default topic security rule.');
    }
  } else if (patch.artifactType === 'field') {
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

function contentValidationIssueFingerprint(issue: {
  severity?: string;
  message?: string;
  documentId?: string;
  documentName?: string;
  field?: string;
  view?: string;
  status?: string;
}): string {
  return hashPayload({
    severity: issue.severity,
    message: redactSensitiveText(issue.message || ''),
    documentId: issue.documentId,
    documentName: issue.documentName,
    field: issue.field,
    view: issue.view,
    status: issue.status,
  });
}

function issueMatchesPatch(issue: OmniValidationIssue, patch: MigrationSemanticPatch): boolean {
  const text = validationIssueText(issue).toLowerCase();
  return [patch.targetFileName, patch.sourceFileName, patch.sourceName]
    .filter((value): value is string => Boolean(value))
    .some((value) => text.includes(value.toLowerCase()));
}

function contentValidationIssueText(issue: ReturnType<typeof normalizeContentValidationIssues>[number]): string {
  return redactSensitiveText([
    issue.documentName,
    issue.documentId,
    issue.view,
    issue.field,
    issue.message,
  ].filter(Boolean).join(' '));
}

function contentIssueMatchesPatch(
  issue: ReturnType<typeof normalizeContentValidationIssues>[number],
  patch: MigrationSemanticPatch,
): boolean {
  const text = contentValidationIssueText(issue).toLowerCase();
  return [patch.targetFileName, patch.sourceFileName, patch.sourceName]
    .filter((value): value is string => Boolean(value))
    .some((value) => text.includes(value.toLowerCase()) || text.includes(value.split('.').pop()?.toLowerCase() || ''));
}

function branchValidationUnsupported(error: unknown): boolean {
  if (!(error instanceof OmniClientError)) return false;
  if (![400, 404, 405, 422].includes(error.status)) return false;
  return /branch|modelkind|model kind|base model|unsupported|not found/i.test(error.message);
}

function structuralPatchValidationResult(
  baseResult: Omit<DashboardPatchValidationModelResult, 'mode' | 'status' | 'artifacts'>,
  patches: MigrationSemanticPatch[],
  branchMessage?: string,
): DashboardPatchValidationModelResult {
  const artifacts = patches.map((patch) => {
    if (patch.resolution === 'keep_target') return artifactResultFromPatch(patch, 'skipped', ['No YAML write selected.']);
    const messages = structuralPatchMessages(patch);
    return artifactResultFromPatch(patch, messages.length > 0 ? 'failed' : 'passed', messages.length > 0
      ? messages
      : [branchMessage || 'Structural check passed; isolated branch validation is unavailable for this model.']);
  });
  return {
    ...baseResult,
    mode: 'structural',
    status: artifacts.some((artifact) => artifact.status === 'failed') ? 'failed' : artifacts.every((artifact) => artifact.status === 'skipped') ? 'skipped' : 'passed',
    artifacts,
  };
}

function summarizeValidationResults(results: DashboardPatchValidationModelResult[]): DashboardPatchValidationStatus {
  if (results.length === 0) return 'skipped';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.every((result) => result.status === 'skipped')) return 'skipped';
  return 'passed';
}

interface ScratchValidationTracking {
  job: MigrationJob;
  branchName: string;
  branchCreateItem: MigrationJobItem;
  yamlWriteItem: MigrationJobItem;
  branchDeleteItem: MigrationJobItem;
  leaseIds: ReadonlySet<string>;
}

function beginScratchValidationTracking(input: {
  destination: SavedInstance;
  targetModelId: string;
  targetModelName?: string;
  targetConnectionId: string;
}): ScratchValidationTracking {
  const jobId = randomUUID();
  const branchName = `omnikit-validate-${jobId}`;
  const scope = {
    destinationInstanceId: input.destination.id,
    targetModelId: input.targetModelId,
  };
  const item = (kind: 'model_branch_create' | 'model_yaml_write' | 'model_branch_delete'): MigrationJobItem => ({
    id: randomUUID(),
    jobId,
    destinationId: input.destination.id,
    destinationLabel: input.destination.label,
    targetModelId: input.targetModelId,
    targetModelName: input.targetModelName,
    kind,
    status: 'pending',
    details: {
      targetConnectionId: input.targetConnectionId,
      migrationMutationBranchName: branchName,
      ...(kind === 'model_branch_delete' ? {} : { migrationMutationRetainUntilCleanup: true }),
    },
  });
  const branchCreateItem = item('model_branch_create');
  const yamlWriteItem = item('model_yaml_write');
  const branchDeleteItem = item('model_branch_delete');
  const job: MigrationJob = {
    id: jobId,
    workflow: 'model',
    sourceId: input.destination.id,
    sourceLabel: input.destination.label,
    destinationIds: [input.destination.id],
    targets: [{
      id: `${input.destination.id}:${input.targetModelId}`,
      destinationInstanceId: input.destination.id,
      destinationLabel: input.destination.label,
      targetConnectionId: input.targetConnectionId,
      targetModelId: input.targetModelId,
      targetModelName: input.targetModelName,
    }],
    documentIds: [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'pending',
    createdAt: Date.now(),
    details: {
      operationMode: 'scratch_validation',
      targetId: input.destination.id,
      targetModelId: input.targetModelId,
      migrationMutationBranchName: branchName,
    },
    items: [branchCreateItem, yamlWriteItem, branchDeleteItem],
  };
  insertJob(job);
  const leaseIds = beginDestinationModelMutation(job, [scope], 'scratch_validation');
  job.status = 'running';
  job.startedAt = Date.now();
  persistJobStatus(job);
  return {
    job,
    branchName,
    branchCreateItem,
    yamlWriteItem,
    branchDeleteItem,
    leaseIds,
  };
}

function finishScratchValidationTracking(
  tracking: ScratchValidationTracking,
  status: 'succeeded' | 'failed',
): void {
  const retain = finalizeDestinationModelMutations(tracking.job, tracking.leaseIds);
  tracking.job.status = retain ? 'failed' : status;
  tracking.job.endedAt = Date.now();
  persistJobStatus(tracking.job);
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

    let branchName = `omnikit-validate-${randomUUID()}`;
    let branch: OmniModelBranchResult | undefined;
    let tracking: ScratchValidationTracking | undefined;
    let scratchMutationError: unknown;
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
      tracking = beginScratchValidationTracking({
        destination,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetConnectionId: target.targetConnectionId,
      });
      branchName = tracking.branchName;
      try {
        markAndPersistItem(tracking.branchCreateItem, 'running');
        dispatchDestinationModelMutationForItem(tracking.branchCreateItem);
        branch = await client.createModelBranch({
          connectionId: target.targetConnectionId,
          baseModelId: target.targetModelId,
          branchName,
        });
        markAndPersistItem(tracking.branchCreateItem, 'succeeded', {
          details: {
            ...(tracking.branchCreateItem.details || {}),
            migrationMutationBranchId: branch.id,
          },
        });
      } catch (error) {
        const unsupported = branchValidationUnsupported(error);
        if (tracking.branchCreateItem.status === 'running') {
          markAndPersistItem(tracking.branchCreateItem, 'failed', {
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            details: {
              ...(tracking.branchCreateItem.details || {}),
              migrationMutationTerminal: unsupported,
            },
          });
        }
        if (!unsupported) throw error;
        results.push(structuralPatchValidationResult(
          baseResult,
          patches,
          `Structural check passed; Omni reported that isolated branch validation is unavailable for ${validationTargetLabel(target)}.`,
        ));
        continue;
      }
      const files = patches
        .filter((patch) => patch.resolution !== 'keep_target' && patch.acceptedYaml?.trim())
        .map((patch) => ({
          fileName: patch.targetFileName,
          yaml: patch.acceptedYaml as string,
          previousChecksum: patch.previousChecksum,
        }));
      try {
        markAndPersistItem(tracking.yamlWriteItem, 'running');
        dispatchDestinationModelMutationForItem(tracking.yamlWriteItem);
        await client.updateModelYamlFiles({
          modelId: target.targetModelId,
          branchId: branch.id,
          files,
          commitMessage: 'Validate Dashboard Migrator dependency patches',
        });
        markAndPersistItem(tracking.yamlWriteItem, 'succeeded');
      } catch (error) {
        scratchMutationError = error;
        throw error;
      }
      const issues = await client.validateModel(target.targetModelId, branch.id);
      const blockingIssues = issues.filter((issue) => issue.is_warning !== true);
      const contentResult = await client.validateModelContent(target.targetModelId, {
        branchId: branch.id,
        includePersonalFolders: true,
      });
      const contentIssues = normalizeContentValidationIssues(contentResult);
      const blockingContentIssues = contentIssues.filter((issue) => issue.severity === 'error');
      const artifacts = patches.map((patch) => {
        if (patch.resolution === 'keep_target') return artifactResultFromPatch(patch, 'skipped', ['No YAML write selected.']);
        const patchIssues = blockingIssues.filter((issue) => issueMatchesPatch(issue, patch));
        const patchContentIssues = blockingContentIssues.filter((issue) => contentIssueMatchesPatch(issue, patch));
        return artifactResultFromPatch(
          patch,
          patchIssues.length > 0 || patchContentIssues.length > 0 ? 'failed' : 'passed',
          patchIssues.length > 0 || patchContentIssues.length > 0
            ? [...patchIssues.map(validationIssueText), ...patchContentIssues.map(contentValidationIssueText)]
            : ['Omni model and content validation passed on the isolated branch.'],
        );
      });
      const unmatchedIssues = blockingIssues.filter((issue) => !patches.some((patch) => issueMatchesPatch(issue, patch)));
      const unmatchedContentIssues = blockingContentIssues.filter((issue) => !patches.some((patch) => contentIssueMatchesPatch(issue, patch)));
      results.push({
        ...baseResult,
        mode: 'branch',
        status: blockingIssues.length > 0 || blockingContentIssues.length > 0 ? 'failed' : 'passed',
        branchName,
        artifacts,
        modelValidation: { issueCount: issues.length, errorCount: blockingIssues.length },
        contentValidation: { issueCount: contentIssues.length, errorCount: blockingContentIssues.length },
        ...(unmatchedIssues.length > 0 || unmatchedContentIssues.length > 0 ? {
          error: [
            ...unmatchedIssues.map(validationIssueText),
            ...unmatchedContentIssues.map(contentValidationIssueText),
          ].join(' '),
        } : {}),
      });
    } catch (error) {
      if (tracking?.branchCreateItem.status === 'running') {
        markAndPersistItem(tracking.branchCreateItem, 'failed', {
          error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        });
      }
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
          if (tracking) markAndPersistItem(tracking.branchDeleteItem, 'running');
          if (tracking) dispatchDestinationModelMutationForItem(tracking.branchDeleteItem);
          await client.deleteModelBranch(target.targetModelId, branch.name);
          if (tracking) markAndPersistItem(tracking.branchDeleteItem, 'succeeded');
        } catch (error) {
          cleanupError = redactSensitiveText(error instanceof Error ? error.message : String(error));
          if (tracking?.branchDeleteItem.status === 'running') {
            markAndPersistItem(tracking.branchDeleteItem, 'failed', { error: cleanupError });
          }
        }
      }
      if (tracking) {
        const cleanupTerminal = branch?.id !== undefined && !cleanupError;
        if (tracking.yamlWriteItem.status === 'running') {
          markAndPersistItem(tracking.yamlWriteItem, 'failed', {
            error: redactSensitiveText(
              scratchMutationError instanceof Error
                ? scratchMutationError.message
                : String(scratchMutationError || 'Scratch YAML validation did not finish.'),
            ),
            details: {
              ...(tracking.yamlWriteItem.details || {}),
              migrationMutationTerminal: cleanupTerminal,
            },
          });
        } else if (tracking.yamlWriteItem.status === 'pending') {
          markAndPersistItem(tracking.yamlWriteItem, 'skipped', {
            error: 'Scratch YAML validation did not run.',
            details: {
              ...(tracking.yamlWriteItem.details || {}),
              migrationMutationTerminal: true,
            },
          });
        }
        if (tracking.branchDeleteItem.status === 'pending') {
          markAndPersistItem(tracking.branchDeleteItem, 'skipped', {
            error: branch?.id ? 'Scratch branch cleanup did not run.' : 'No scratch branch required cleanup.',
            details: {
              ...(tracking.branchDeleteItem.details || {}),
              migrationMutationTerminal: branch?.id === undefined,
            },
          });
        }
        const unresolved = tracking.job.items.some((item) => {
          const lease = migrationDestinationModelMutationLease(item);
          return lease?.state === 'dispatched' || lease?.state === 'remote_pending' || lease?.state === 'uncertain';
        });
        const trackingFailed = tracking.job.items.some((item) => item.status === 'failed');
        finishScratchValidationTracking(tracking, unresolved || cleanupError || trackingFailed ? 'failed' : 'succeeded');
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
  const mutationScopes = destinationModelMutationScopes(job);
  if (hasUnresolvedMigrationDestinationModelMutation(
    listStoredJobs(Number.MAX_SAFE_INTEGER),
    mutationScopes,
  )) throw new MigrationScopeReservationError();
  activePostMigrationActions.set(jobId, input.postMigrationActions);
  activeDashboardTargets.set(jobId, plan.targets);
  try {
    insertJob(job);
  } catch (error) {
    activePostMigrationActions.delete(jobId);
    activeDashboardTargets.delete(jobId);
    throw error;
  }
  void runMigrationJob(job.id).catch(() => undefined);
  return getJob(job.id) || sanitizeJob(job);
}

export async function createModelMigrationJob(input: ModelMigrationJobInput): Promise<MigrationJob> {
  const source = requireModelMigrationInstance(input.sourceId, 'source');
  const target = requireModelMigrationInstance(input.targetId, 'destination');
  if (input.models.length === 0) throw new Error('Select at least one source model before starting Model Migrator.');
  const targetModelIds = new Set(input.models.map((model) => model.targetModelId));
  const mutatingTargetModelIds = new Set(input.models
    .filter((model) => model.mode !== 'impact_report')
    .map((model) => model.targetModelId));
  const invalidPostAction = input.postMigrationActions.find((action) => (
    action.destinationInstanceId !== target.id
    || (action.targetModelId !== undefined && !targetModelIds.has(action.targetModelId))
    || (action.kind === 'refresh-schema' && !action.targetModelId)
    || (action.kind === 'refresh-schema' && !mutatingTargetModelIds.has(action.targetModelId || ''))
  ));
  if (invalidPostAction) {
    throw Object.assign(
      new Error('Every Model Migrator post-action must be bound to this job\'s exact destination and target model scope.'),
      { statusCode: 400, code: 'MODEL_MIGRATOR_POST_ACTION_SCOPE_INVALID' },
    );
  }
  assertNoUnresolvedSafeCopyModelOverlap(target.id, input.models.map((model) => model.targetModelId));
  const jobId = randomUUID();
  const items: MigrationJobItem[] = [];
  const contentIds = input.content.map((row) => row.documentId);
  const impactOnlyModelIds = new Set(input.models.filter((model) => model.mode === 'impact_report').map((model) => model.sourceModelId));
  const allImpactReport = input.models.length > 0 && input.models.every((model) => model.mode === 'impact_report');

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
    if (model.mode === 'impact_report') {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        kind: 'model_impact_report',
        status: 'pending',
        details: {
          ...baseDetails,
          semanticDecisions: model.semanticDecisions || [],
          contentRepairActions: model.contentRepairActions || [],
          noMutation: true,
        },
      });
    } else if (model.mode === 'fast') {
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
          orgApiKeyConfirmed: model.orgApiKeyConfirmed === true,
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
        details: { ...baseDetails, acceptedFileCount: model.acceptedFiles?.length || 0, semanticDecisions: model.semanticDecisions || [] },
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
    for (const repair of model.mode === 'impact_report' ? [] : model.contentRepairActions || []) {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: model.targetModelId,
        targetModelName: model.targetModelName,
        kind: 'content_repair',
        status: 'pending',
        details: { ...baseDetails, repair },
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
      details: { ...baseDetails, impactOnly: model.mode === 'impact_report' },
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
    if (impactOnlyModelIds.has(content.sourceModelId)) {
      items.push({
        id: randomUUID(),
        jobId,
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: content.targetModelId,
        targetModelName: content.targetModelName,
        targetFolderId: content.targetFolderId,
        targetFolderPath: content.targetFolderPath,
        kind: content.kind === 'workbook' ? 'workbook_preflight' : 'dashboard_handoff',
        documentId: content.documentId,
        documentName: content.documentName,
        status: 'pending',
        details: { ...content, impactOnly: true, noMutation: true },
      });
      continue;
    }
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
    postMigrationActions: allImpactReport ? [] : input.postMigrationActions.map(sanitizePostMigrationAction),
    status: 'pending',
    parentJobId: input.parentJobId,
    createdAt: Date.now(),
    details: {
      targetId: target.id,
      targetLabel: input.targetLabel || target.label,
      modelCount: input.models.length,
      ...(input.dashboardRepair ? { dashboardRepair: input.dashboardRepair } : {}),
      dashboardCount: input.content.filter((row) => row.kind === 'dashboard').length,
      workbookCount: input.content.filter((row) => row.kind === 'workbook').length,
      mergeAfterValidation: false,
      retryInput: {
        sourceId: input.sourceId,
        targetId: input.targetId,
        targetLabel: input.targetLabel,
        ...(input.dashboardRepair ? { dashboardRepair: input.dashboardRepair } : {}),
        models: input.models,
        content: input.content,
        replaceSameNamed: false,
        mergeAfterValidation: false,
        publishDrafts: input.publishDrafts,
        deleteBranch: input.deleteBranch,
        postMigrationActions: allImpactReport ? [] : input.postMigrationActions,
      },
    },
    items,
  };
  activePostMigrationActions.set(jobId, allImpactReport ? [] : input.postMigrationActions);
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
  return kind === 'permission_prepare'
    || kind === 'field_prepare'
    || kind === 'query_view_prepare'
    || kind === 'relationship_prepare'
    || kind === 'topic_prepare'
    || kind === 'semantic_validate'
    || kind === 'query_validate';
}

function isDashboardRetryItem(item: MigrationJobItem, destinationId?: string): boolean {
  if (destinationId && item.destinationId !== destinationId) return false;
  if (item.status === 'failed') {
    return item.kind === 'import'
      || item.kind === 'update'
      || item.kind === 'export'
      || item.kind === 'permission_apply'
      || item.kind === 'permission_verify'
      || item.kind === 'document_verify'
      || isDashboardPrepKind(item.kind);
  }
  if (item.status !== 'skipped' || (item.kind !== 'import' && item.kind !== 'update')) return false;
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
  if (parent.details?.safeCopyProfile === 'safe_copy_v1') {
    throw Object.assign(new Error('Safe-copy targets cannot use the legacy migration retry path.'), { statusCode: 409 });
  }
  const mutationAdjudications = Array.isArray(parent.details?.migrationMutationAdjudications)
    ? parent.details.migrationMutationAdjudications
    : [];
  if (mutationAdjudications.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true;
    const outcome = (candidate as Record<string, unknown>).outcome;
    return outcome !== 'verified_not_applied';
  })) {
    throw Object.assign(
      new Error('This migration contains an operator-adjudicated mutation that may have applied. Create a fresh plan from current destination state instead of retrying the old job.'),
      { statusCode: 409, code: 'MIGRATION_MUTATION_FRESH_PLAN_REQUIRED' },
    );
  }
  if (parent.workflow === 'model') {
    const retryInput = parent.details?.retryInput;
    if (!retryInput || typeof retryInput !== 'object' || Array.isArray(retryInput)) {
      throw new Error('Model migration retry details are unavailable.');
    }
    const input = retryInput as ModelMigrationJobInput;
    const failedModelIds = new Set(parent.items
      .filter((item) => (
        item.status === 'failed'
        && item.targetModelId
        && item.kind !== 'post_action'
        && item.kind !== 'destination_model_mutation'
      ))
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
      // Older stored retry inputs may predate this field. Never lose the review guard on retry.
      ...(parent.details?.dashboardRepair ? { dashboardRepair: parent.details.dashboardRepair as ModelMigrationJobInput['dashboardRepair'] } : {}),
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

/** Full asynchronous repair proof remains upstream; this closes the final transport wait gap. */
function modelMigrationTargetClient(job: MigrationJob, target: SavedInstance, targetModelIds: string[]): OmniClient {
  const repair = job.details?.dashboardRepair as ModelMigrationJobInput['dashboardRepair'];
  if (!repair) return new OmniClient(target);
  const expectedBoundary = repair.instanceBoundaryHash;
  const sourceModelIds = Object.keys(repair.sourceModelHashes || {}).sort();
  return new OmniClient(target, { writeGuard: { assertCanDispatch() {
    const current = getJob(job.id);
    const currentRepair = current?.details?.dashboardRepair as ModelMigrationJobInput['dashboardRepair'];
    if (!current || current.status !== 'running' || canceledJobs.has(job.id)) {
      throw new Error('The dashboard repair is no longer running; no further write is authorized.');
    }
    if (!expectedBoundary || !sourceModelIds.length || !targetModelIds.length
      || current.sourceId !== job.sourceId || current.destinationIds.length !== 1 || current.destinationIds[0] !== target.id
      || !currentRepair || currentRepair.instanceBoundaryHash !== expectedBoundary
      || JSON.stringify(Object.keys(currentRepair.sourceModelHashes || {}).sort()) !== JSON.stringify(sourceModelIds)) {
      throw new Error('The saved dashboard repair authority is missing or changed. Prepare a fresh review.');
    }
    for (const modelId of targetModelIds) {
      if (dashboardRepairInstanceBoundaryHash(job.sourceId, target.id, modelId, sourceModelIds) !== expectedBoundary) {
        throw new Error('A saved instance changed after repair approval. No further write is authorized.');
      }
    }
  } } });
}

export async function mergeModelMigrationJob(id: string, options: { publishDrafts?: boolean; deleteBranch?: boolean } = {}): Promise<MigrationJob> {
  const job = getJob(id);
  if (!job) throw new Error('Job not found.');
  if (job.workflow !== 'model') throw new Error('Only Model Migrator jobs can be merged from this endpoint.');
  if (job.status === 'running' || job.status === 'pending') throw new Error('Wait for model validation to finish before merging.');
  if (job.items.some((item) => (item.kind === 'model_merge' || item.kind === 'model_pr') && (item.status === 'succeeded' || item.status === 'running'))) {
    throw new Error('This model migration job already has a publish or pull-request step in progress or completed.');
  }

  const input = modelMigrationInputFromJob(job);
  requireModelMigrationInstance(input.sourceId, 'source');
  const validationByModel = new Map(job.items
    .filter((item) => item.kind === 'model_validate' && item.targetModelId)
    .map((item) => [item.targetModelId as string, item]));
  const blockers = input.models.filter((model) => validationByModel.get(model.targetModelId)?.status !== 'succeeded');
  if (blockers.length > 0) {
    throw new Error(`Cannot merge until every target model validates successfully: ${blockers.map((model) => model.targetModelName || model.targetModelId).join(', ')}`);
  }

  const targetId = typeof job.details?.targetId === 'string' ? job.details.targetId : job.destinationIds[0];
  const target = requireModelMigrationInstance(targetId, 'destination');
  assertNoUnresolvedSafeCopyModelOverlap(target.id, input.models.map((model) => model.targetModelId));
  const mergeScopes = input.models.map((model) => ({
    destinationInstanceId: target.id,
    targetModelId: model.targetModelId,
  }));
  const releaseModelReservation = reserveMigrationDestinationModels(
    `model-merge:${job.id}`,
    mergeScopes,
  );
  let retainReservationForReconciliation = false;
  let mutationLeaseIds: ReadonlySet<string> = new Set();
  try {
  mutationLeaseIds = beginDestinationModelMutation(job, mergeScopes, 'model_merge');
  const targetClient = modelMigrationTargetClient(job, target, input.models.map((model) => model.targetModelId));
  job.status = 'running';
  job.endedAt = undefined;
  persistJobStatus(job);

  for (const model of input.models) {
    const branchName = branchNameForModel(job, model);
    const requiresPr = model.mergeHandoffRequired === true;
    const item: MigrationJobItem = {
      id: randomUUID(),
      jobId: job.id,
      destinationId: target.id,
      destinationLabel: target.label,
      targetModelId: model.targetModelId,
      targetModelName: model.targetModelName,
      kind: requiresPr ? 'model_pr' : 'model_merge',
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
        mergeHandoffRequired: requiresPr,
      },
    };
    job.items.push(item);
    persistItem(item);
    try {
      if (job.details?.dashboardRepair) {
        if (options.publishDrafts === true || options.deleteBranch === true) throw new Error('Additive dashboard repair does not publish dashboards or delete branches.');
        const reviewedBranch = await targetClient.findModelBranch(model.targetModelId, branchName);
        if (!reviewedBranch?.id) throw new Error('The approved working branch is unavailable.');
        await assertAdditiveDashboardRepairDispatch(job, model.targetModelId,
          new OmniClient(requireModelMigrationInstance(input.sourceId, 'source')), targetClient,
          { branchId: reviewedBranch.id, beforeMerge: true });
      }
      if (requiresPr) {
        const branch = await targetClient.findModelBranch(model.targetModelId, branchName);
        if (!branch?.id) throw new Error('Target branch was not found for pull request creation.');
        dispatchDestinationModelMutationForItem(item);
        const result = await targetClient.createOrUpdateModelBranchPullRequest({
          modelId: model.targetModelId,
          branchId: branch.id,
          commitMessage: `OmniKit Model Migrator review for ${model.targetModelName || model.targetModelId}`,
        });
        markAndPersistItem(item, 'succeeded', {
          details: { ...item.details, branchId: branch.id, branchName: branch.name, result },
        });
        continue;
      }
      dispatchDestinationModelMutationForItem(item);
      await targetClient.mergeModelBranch(model.targetModelId, branchName, {
        publishDrafts: options.publishDrafts === true,
        deleteBranch: job.details?.dashboardRepair ? false : options.deleteBranch !== false,
        forceOverrideGitSettings: false,
      });
      if (options.publishDrafts === true) invalidateDocumentInventory(target.id);
      markAndPersistItem(item, 'succeeded');
    } catch (error) {
      const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
      markAndPersistItem(item, 'failed', { error: message });
    }
  }

  job.status = computeJobStatus(job.items);
  job.endedAt = Date.now();
  persistJobStatus(job);
  retainReservationForReconciliation = finalizeDestinationModelMutations(job, mutationLeaseIds);
  return getJob(job.id) || sanitizeJob(job);
  } catch (error) {
    if (mutationLeaseIds.size > 0) {
      try {
        retainReservationForReconciliation = finalizeDestinationModelMutations(job, mutationLeaseIds);
      } catch {
        // The in-memory reservation remains held when durable finalization fails.
        retainReservationForReconciliation = true;
      }
    }
    throw error;
  } finally {
    if (!retainReservationForReconciliation) releaseModelReservation();
  }
}

export async function runMigrationJob(id: string): Promise<void> {
  if (runningJobs.has(id)) return;
  const job = getJob(id);
  if (!job) return;
  if (job.details?.safeCopyProfile === 'safe_copy_v1') {
    throw Object.assign(new Error('Safe-copy jobs cannot use the legacy migration runner.'), { statusCode: 409 });
  }
  if (isTerminalJobStatus(job.status)) return;
  runningJobs.add(id);
  let releaseModelReservation: (() => void) | undefined;
  let mutationLeaseIds: ReadonlySet<string> = new Set();
  let retainReservationForReconciliation = false;
  try {
    const mutationScopes = destinationModelMutationScopes(job);
    if (mutationScopes.length > 0) {
      releaseModelReservation = reserveMigrationDestinationModels(
        `${job.workflow === 'model' ? 'model-job' : 'legacy-dashboard-job'}:${job.id}`,
        mutationScopes,
      );
      mutationLeaseIds = beginDestinationModelMutation(
        job,
        mutationScopes,
        job.workflow === 'model' ? 'model_job' : 'legacy_dashboard_job',
      );
    }
    if (job.workflow === 'model') {
      await executeModelJob(job);
    } else await executeJob(job);
    if (mutationLeaseIds.size > 0) {
      retainReservationForReconciliation = finalizeDestinationModelMutations(job, mutationLeaseIds);
    }
  } catch (error) {
    const latest = getJob(id) || job;
    const safeReason = redactSensitiveText(error instanceof Error ? error.message : 'Unexpected migration runner failure.')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    markPendingItemsSkipped(latest, `Job failed before this step could run.${safeReason ? ` ${safeReason}` : ''}`);
    latest.status = 'failed';
    latest.endedAt = Date.now();
    persistJobStatus(latest);
    if (mutationLeaseIds.size > 0) {
      try {
        retainReservationForReconciliation = finalizeDestinationModelMutations(latest, mutationLeaseIds);
      } catch {
        retainReservationForReconciliation = true;
      }
    }
  } finally {
    if (!retainReservationForReconciliation) releaseModelReservation?.();
    activePostMigrationActions.delete(id);
    activeDashboardTargets.delete(id);
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

function detailRepairAction(details: Record<string, unknown> | undefined): ModelMigrationContentRepairAction | null {
  const repair = details?.repair;
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) return null;
  const row = repair as Record<string, unknown>;
  const kind = row.kind === 'view' || row.kind === 'topic' ? row.kind : 'field';
  const find = typeof row.find === 'string' ? row.find : '';
  const replacement = typeof row.replacement === 'string' ? row.replacement : '';
  if (!find || !replacement) return null;
  return {
    id: typeof row.id === 'string' ? row.id : `${kind}:${find}`,
    kind,
    find,
    replacement,
    approved: row.approved === true,
    includePersonalFolders: row.includePersonalFolders === true,
  };
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
  const source = requireModelMigrationInstance(job.sourceId, 'source');
  const targetId = typeof job.details?.targetId === 'string' ? job.details.targetId : job.destinationIds[0];
  const target = requireModelMigrationInstance(targetId, 'destination');
  const input = modelMigrationInputFromJob(job);
  assertNoUnresolvedSafeCopyModelOverlap(target.id, input.models.map((model) => model.targetModelId));
  const sourceClient = new OmniClient(source);
  const targetClient = modelMigrationTargetClient(job, target, input.models.map((model) => model.targetModelId));
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
      'permission_prepare',
      'field_prepare',
      'query_view_prepare',
      'import',
      'metadata',
      'workbook_queries',
      'workbook_preflight',
      'workbook_create',
      'content_repair',
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
      if (item.kind === 'model_impact_report') {
        markAndPersistItem(item, 'succeeded', {
          warnings: ['Impact report only: no branch, YAML write, content import, merge, or post-action was performed.'],
          details: {
            ...details,
            noMutation: true,
            semanticDecisionCount: Array.isArray(details.semanticDecisions) ? details.semanticDecisions.length : 0,
            repairActionCount: Array.isArray(details.contentRepairActions) ? details.contentRepairActions.length : 0,
          },
        });
      } else if (item.kind === 'model_fast_path') {
        if (detailBoolean(details, 'fastPathSchemaConfirmed') !== true) throw new Error('Fast path requires explicit schema identity confirmation.');
        if (detailBoolean(details, 'orgApiKeyConfirmed') !== true) throw new Error('Fast path requires confirmation that the saved credential is an Omni Organization API key.');
        dispatchDestinationModelMutationForItem(item);
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
        await assertAdditiveDashboardRepairDispatch(job, targetModelId, sourceClient, targetClient);
        dispatchDestinationModelMutationForItem(item);
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
        await assertAdditiveDashboardRepairDispatch(job, targetModelId, sourceClient, targetClient, { branchId: branch.branchId });
        dispatchDestinationModelMutationForItem(item);
        await targetClient.updateModelYamlFiles({
          modelId: targetModelId,
          branchId: branch.branchId,
          files,
          commitMessage: `OmniKit Model Migrator update ${files.length} YAML file${files.length === 1 ? '' : 's'}`,
        });
        targetYamlByModel.delete(`${targetModelId}:${branch.branchId}`);
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchId: branch.branchId, writtenFiles: files.map((file) => file.fileName) } });
      } else if (item.kind === 'content_repair') {
        const repair = detailRepairAction(details);
        if (!repair) throw new Error('Content repair item is missing a valid find/replacement action.');
        if (repair.approved !== true) throw new Error('Content repair requires explicit approval before running.');
        const branch = branchByTargetModel.get(targetModelId);
        dispatchDestinationModelMutationForItem(item);
        const result = await targetClient.findAndReplaceModelContent({
          modelId: targetModelId,
          find: repair.find,
          replacement: repair.replacement,
          type: repair.kind.toUpperCase() as 'VIEW' | 'FIELD' | 'TOPIC',
          branchId: branch?.branchId,
          includePersonalFolders: repair.includePersonalFolders,
        });
        targetYamlByModel.delete(`${targetModelId}:${branch?.branchId || 'main'}`);
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchId: branch?.branchId, result } });
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
      } else if (item.kind === 'model_pr') {
        const branch = branchByTargetModel.get(targetModelId);
        if (!branch?.branchId) throw new Error('Target branch was not available for pull request creation.');
        dispatchDestinationModelMutationForItem(item);
        const result = await targetClient.createOrUpdateModelBranchPullRequest({
          modelId: targetModelId,
          branchId: branch.branchId,
          commitMessage: `OmniKit Model Migrator review for ${item.targetModelName || targetModelId}`,
        });
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchId: branch.branchId, branchName: branch.branchName, result } });
      } else if (item.kind === 'model_merge') {
        const branch = branchByTargetModel.get(targetModelId);
        if (!branch?.branchName) throw new Error('Target branch was not available for merge.');
        if (detailBoolean(details, 'mergeHandoffRequired')) {
          markAndPersistItem(item, 'warning', {
            warnings: ['This model appears to require a git/PR handoff. Use Publish validated to create or update a pull request; OmniKit did not force merge settings.'],
            details: { ...details, branchName: branch.branchName },
          });
          continue;
        }
        dispatchDestinationModelMutationForItem(item);
        await targetClient.mergeModelBranch(targetModelId, branch.branchName, {
          publishDrafts: detailBoolean(details, 'publishDrafts'),
          deleteBranch: detailBoolean(details, 'deleteBranch'),
          forceOverrideGitSettings: false,
        });
        if (detailBoolean(details, 'publishDrafts')) invalidateDocumentInventory(target.id);
        markAndPersistItem(item, 'succeeded', { details: { ...details, branchName: branch.branchName } });
      } else if (item.kind === 'dashboard_handoff') {
        markAndPersistItem(item, 'succeeded', {
          warnings: ['Impact report only: dashboard was included in scope but was not exported or imported.'],
          details: { ...details, noMutation: true },
        });
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
        if (detailBoolean(details, 'impactOnly')) {
          markAndPersistItem(item, 'succeeded', {
            warnings: ['Impact report only: workbook was included in scope but was not copied. Run the publishing path to preflight and create workbook documents.'],
            details: { ...details, noMutation: true },
          });
          continue;
        }
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
          const resolvedTargetFolderId = await targetClient.resolveDocumentFolderId(
            item.targetFolderId,
            item.targetFolderPath,
          );
          if (job.replaceSameNamed && item.documentName) {
            const existingDocs = await targetClient.listFolderDocuments(resolvedTargetFolderId, true);
            const match = existingDocs.find((doc) => doc.name === item.documentName && doc.hasDashboard === false);
            if (match) {
              dispatchDestinationModelMutationForItem(item);
              await targetClient.requestDeleteDocument(match.identifier || match.id);
              invalidateDocumentInventory(target.id);
            }
          }
          dispatchDestinationModelMutationForItem(item);
          const created = await targetClient.createWorkbookDocument({
            modelId: targetModelId,
            name: item.documentName || 'Migrated workbook',
            folderId: resolvedTargetFolderId,
            folderPath: item.targetFolderPath,
            queryPresentations: rewrites.map((rewrite) => ({
              name: rewrite.name,
              description: rewrite.description,
              query: rewrite.query,
              visConfig: rewrite.visConfig,
            })),
          });
          invalidateDocumentInventory(target.id);
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
          if (match) {
            dispatchDestinationModelMutationForItem(item);
            await targetClient.requestDeleteDocument(match.identifier || match.id);
            invalidateDocumentInventory(target.id);
          }
        }
        dispatchDestinationModelMutationForItem(item);
        const imported = await targetClient.importDocument({
          exportPayload: cached.payload,
          baseModelId: targetModelId,
          folderPath: item.targetFolderPath,
          documentName: item.documentName || 'Migrated dashboard',
        });
        invalidateDocumentInventory(target.id);
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
            invalidateDocumentInventory(target.id);
          } catch (error) {
            throw new Error(`Folder move outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
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
          details: { ...details, exportHash: cached.hash, migrationMutationTerminal: true },
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
            dispatchDestinationModelMutationForItem(item);
            await targetClient.patchDocument(imported.identifier, { description: sourceDoc.description });
            invalidateDocumentInventory(target.id);
          } catch (error) {
            throw new Error(`Description copy outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (sourceDoc?.labels?.length) {
          try {
            dispatchDestinationModelMutationForItem(item);
            await ensureTargetLabels(sourceDoc.labels);
            await targetClient.setDocumentLabels(imported.identifier, sourceDoc.labels);
            invalidateDocumentInventory(target.id);
          } catch (error) {
            throw new Error(`Label copy outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: {
            ...details,
            copiedDescription: Boolean(sourceDoc?.description),
            labelCount: sourceDoc?.labels?.length || 0,
            ...(!sourceDoc?.description && !sourceDoc?.labels?.length ? { noMutation: true } : {}),
            migrationMutationTerminal: true,
          },
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
  const importedByDestinationAndSource = new Map<string, { identifier: string; documentId: string; updatedInPlace?: boolean }>();
  const destinationLabelCache = new Map<string, Set<string>>();
  const preparedTopicKeys = new Set<string>();
  const preparedQueryViewKeys = new Set<string>();
  const preparedRelationshipKeys = new Set<string>();
  const preparedFieldKeys = new Set<string>();
  const preparedSemanticPatchKeys = new Set<string>();
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
    const runtimeTargets = activeDashboardTargets.get(job.id) || job.targets || [];
    return runtimeTargets.find((target) => target.id === item.targetId);
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

  function detailPermissionDependencies(details: Record<string, unknown> | undefined): MigrationPermissionDependency[] {
    const raw = details?.permissionDependencies;
    if (!Array.isArray(raw)) return [];
    return raw.filter((dependency): dependency is MigrationPermissionDependency => (
      Boolean(dependency)
      && typeof dependency === 'object'
      && !Array.isArray(dependency)
      && typeof (dependency as MigrationPermissionDependency).id === 'string'
    ));
  }

  function detailPermissionDecisions(details: Record<string, unknown> | undefined): MigrationPermissionDecision[] {
    const raw = details?.permissionDecisions;
    if (!Array.isArray(raw)) return [];
    return normalizePermissionDecisions(raw as MigrationPermissionDecision[]);
  }

  function detailStringValues(details: Record<string, unknown> | undefined, key: string): string[] {
    const raw = details?.[key];
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  function detailSemanticPatches(details: Record<string, unknown> | undefined): MigrationSemanticPatch[] {
    const raw = details?.semanticPatches;
    if (!Array.isArray(raw)) return [];
    return normalizeSemanticPatches(raw as MigrationSemanticPatch[]);
  }

  function patchIncludesPermissionDecision(patch: MigrationSemanticPatch): boolean {
    return patch.artifactType === 'permission'
      || Boolean(patch.dependencyPath?.some((dependency) => dependency.kind === 'permission'));
  }

  function permissionPatchOrder(fileName: string): number {
    const normalized = fileName.toLowerCase();
    if (normalized === 'model' || normalized.endsWith('/model')) return 0;
    if (normalized.endsWith('.view') || normalized.endsWith('.query.view')) return 1;
    if (normalized.endsWith('.topic')) return 2;
    return 3;
  }

  function semanticPatchExecutionKey(input: {
    destinationId: string;
    targetModelId: string;
    fileName: string;
    yaml: string;
  }): string {
    return [
      input.destinationId,
      input.targetModelId,
      input.fileName,
      hashPayload({ yaml: input.yaml }),
    ].join(':');
  }

  async function writeSemanticYamlFile(input: {
    item: MigrationJobItem;
    destinationId: string;
    destinationClient: OmniClient;
    targetModelId: string;
    fileName: string;
    yaml: string;
    previousChecksum?: string;
    commitMessage: string;
  }): Promise<'written' | 'already_applied'> {
    const writeKey = semanticPatchExecutionKey(input);
    if (preparedSemanticPatchKeys.has(writeKey)) return 'already_applied';
    dispatchDestinationModelMutationForItem(input.item);
    await input.destinationClient.updateModelYamlFile({
      modelId: input.targetModelId,
      fileName: input.fileName,
      yaml: input.yaml,
      previousChecksum: input.previousChecksum,
      commitMessage: input.commitMessage,
    });
    preparedSemanticPatchKeys.add(writeKey);
    return 'written';
  }

  async function prepareDashboardPermissionsForImport(
    item: MigrationJobItem,
    destination: SavedInstance,
    destinationClient: OmniClient,
    targetModelId: string,
  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
    const target = targetForItem(item);
    const dependencies = detailPermissionDependencies(item.details);
    const decisions = [
      ...detailPermissionDecisions(item.details),
      ...normalizePermissionDecisions(target?.permissionDecisions),
    ];
    const uniqueDecisions = [...new Map(decisions.map((decision) => [decision.dependencyId, decision])).values()];
    const blockers = migrationPermissionDecisionBlockers(dependencies, uniqueDecisions);
    if (blockers.length > 0) throw new Error(blockers.join(' '));
    const patches = [...detailSemanticPatches(item.details), ...(target?.semanticPatches || [])]
      .filter(patchIncludesPermissionDecision);
    const uniquePatches = [...new Map(patches.map((patch) => [
      `${patch.targetFileName}:${patch.acceptedYaml || patch.resolution}`,
      patch,
    ])).values()]
      .sort((a, b) => permissionPatchOrder(a.targetFileName) - permissionPatchOrder(b.targetFileName)
        || a.targetFileName.localeCompare(b.targetFileName));
    const targetYaml = uniquePatches.length > 0
      ? await destinationClient.getModelYaml(targetModelId, { includeChecksums: true })
      : undefined;
    const baselineValidationErrors = dependencies.length > 0
      ? (await destinationClient.validateModel(targetModelId)).filter((issue) => issue.is_warning !== true)
      : [];
    const baselineValidationErrorKeys = new Set(
      baselineValidationErrors.map((issue) => hashPayload({ issue: validationIssueText(issue) })),
    );
    const writtenFiles: string[] = [];
    const preservedFiles: string[] = [];
    const warnings: string[] = [];
    const roleAssignmentsApplied: string[] = [];
    const roleAssignmentsAlreadyApplied: string[] = [];

    for (const patch of uniquePatches) {
      if (patch.resolution === 'keep_target') {
        preservedFiles.push(patch.targetFileName);
        continue;
      }
      const write = semanticPatchWriteInput(patch, targetYaml?.checksums?.[patch.targetFileName]);
      if (!write) continue;
      const writeResult = await writeSemanticYamlFile({
        item,
        destinationId: destination.id,
        destinationClient,
        targetModelId,
        fileName: patch.targetFileName,
        yaml: write.yaml,
        previousChecksum: write.previousChecksum,
        commitMessage: `OmniKit Dashboard Migrator apply security dependencies to ${patch.targetFileName}`,
      });
      if (writeResult === 'already_applied') {
        preservedFiles.push(patch.targetFileName);
        continue;
      }
      writtenFiles.push(patch.targetFileName);
    }

    if (writtenFiles.length > 0) {
      targetTopicCatalogCache.delete(`${destination.id}:${targetModelId}`);
      targetQueryViewCatalogCache.delete(`${destination.id}:${targetModelId}`);
      const issues = await destinationClient.validateModel(targetModelId);
      const errors = issues.filter((issue) => issue.is_warning !== true);
      const newErrors = errors.filter((issue) => (
        !baselineValidationErrorKeys.has(hashPayload({ issue: validationIssueText(issue) }))
      ));
      if (newErrors.length > 0) {
        throw new Error(
          `Security preparation produced ${newErrors.length} new model validation error${newErrors.length === 1 ? '' : 's'}: `
          + newErrors.slice(0, 5).map(validationIssueText).join(' '),
        );
      }
    }

    for (const dependency of dependencies.filter((candidate) => candidate.kind === 'model_role')) {
      const decision = uniqueDecisions.find((candidate) => candidate.dependencyId === dependency.id);
      if (!decision) continue;
      if (decision.action === 'ignore_with_waiver') {
        warnings.push(`${dependency.sourceRef} model access was waived: ${decision.waiverReason?.trim() || 'no reason recorded'}.`);
        continue;
      }
      if (decision.action === 'manual_prerequisite') {
        warnings.push(`${dependency.sourceRef} model access was confirmed as a manual prerequisite; OmniKit did not change the role.`);
        continue;
      }
      if (decision.action === 'preserve_target') {
        roleAssignmentsAlreadyApplied.push(dependency.sourceRef);
        continue;
      }
      if (decision.action !== 'create_from_source' || !decision.targetRef) continue;
      const value = migrationModelRoleValue(dependency.sourceValue);
      if (!value) throw new Error(`Model-role dependency ${dependency.sourceRef} has invalid execution metadata.`);
      const separator = decision.targetRef.indexOf(':');
      const principalType = decision.targetRef.slice(0, separator);
      const principalId = decision.targetRef.slice(separator + 1);
      if (
        separator <= 0
        || !principalId
        || (principalType !== 'user' && principalType !== 'userGroup')
        || principalType !== value.principalType
      ) {
        throw new Error(`Destination principal mapping for model role ${dependency.sourceRef} is invalid.`);
      }
      const currentRoles = principalType === 'user'
        ? await destinationClient.listUserModelRoles(principalId, {
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        })
        : await destinationClient.listUserGroupModelRoles(principalId, {
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        });
      const alreadyApplied = currentRoles.some((role) => (
        (!role.modelId || role.modelId === targetModelId)
        && role.roleName.toLowerCase() === value.sourceRole.toLowerCase()
      ));
      if (alreadyApplied) {
        roleAssignmentsAlreadyApplied.push(dependency.sourceRef);
        continue;
      }
      dispatchDestinationModelMutationForItem(item);
      if (principalType === 'user') {
        await destinationClient.assignUserModelRole(principalId, {
          roleName: value.sourceRole,
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        });
      } else {
        await destinationClient.assignUserGroupModelRole(principalId, {
          roleName: value.sourceRole,
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        });
      }
      const verifiedRoles = principalType === 'user'
        ? await destinationClient.listUserModelRoles(principalId, {
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        })
        : await destinationClient.listUserGroupModelRoles(principalId, {
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        });
      if (!verifiedRoles.some((role) => (
        (!role.modelId || role.modelId === targetModelId)
        && role.roleName.toLowerCase() === value.sourceRole.toLowerCase()
      ))) {
        throw new Error(`Model role ${value.sourceRole} for ${value.principalLabel} could not be verified after assignment.`);
      }
      roleAssignmentsApplied.push(dependency.sourceRef);
    }

    const baselineContentValidation = dependencies.length > 0
      ? normalizeContentValidationIssues(await destinationClient.validateModelContent(targetModelId))
      : [];
    const baselineContentErrors = baselineContentValidation.filter((issue) => issue.severity === 'error');
    return {
      warnings,
      details: {
        permissionDecisions: uniqueDecisions,
        permissionPatchesApplied: [...new Set(writtenFiles)],
        permissionPatchesAlreadyApplied: [...new Set(preservedFiles)],
        permissionModelValidation: writtenFiles.length > 0 ? 'passed' : 'not_required',
        permissionModelValidationBaselineErrorCount: baselineValidationErrors.length,
        permissionModelValidationBaselineFingerprints: baselineValidationErrors.map((issue) => (
          hashPayload({ issue: validationIssueText(issue) })
        )),
        permissionContentValidationBaselineErrorCount: baselineContentErrors.length,
        permissionContentValidationBaselineFingerprints: baselineContentErrors.map(contentValidationIssueFingerprint),
        permissionModelRolesApplied: [...new Set(roleAssignmentsApplied)],
        permissionModelRolesAlreadyApplied: [...new Set(roleAssignmentsAlreadyApplied)],
      },
    };
  }

  async function applyDashboardContentPermissions(
    item: MigrationJobItem,
    destinationClient: OmniClient,
  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
    if (!item.documentId) throw new Error('Dashboard access item missing source document id.');
    const imported = importedByDestinationAndSource.get(`${item.targetId || item.destinationId}:${item.documentId}`);
    const targetDocumentId = imported?.identifier || imported?.documentId;
    if (!targetDocumentId) throw new Error('Dashboard access could not be applied because the imported document was not identified.');
    const destinationDocumentId = targetDocumentId;

    const permissionInput = resolvedDashboardContentPermissionInput(item);
    const { dependencies, expected, warnings } = permissionInput;

    const existing = await destinationClient.listDocumentAccess(destinationDocumentId, { accessSource: 'direct' });
    const existingByPrincipal = new Map(existing.map((principal) => [`${principal.type}:${principal.id}`, principal]));
    const grantBuckets = new Map<string, typeof expected>();
    const updateBuckets = new Map<string, typeof expected>();
    for (const permission of expected) {
      const existingPermission = existingByPrincipal.get(`${permission.principalType}:${permission.principalId}`);
      if (
        existingPermission
        && existingPermission.role === permission.role
        && existingPermission.accessBoost === permission.accessBoost
      ) continue;
      const bucketMap = existingPermission ? updateBuckets : grantBuckets;
      const key = `${permission.principalType}:${permission.role}:${permission.accessBoost ? 'boost' : 'standard'}`;
      const bucket = bucketMap.get(key) || [];
      bucket.push(permission);
      bucketMap.set(key, bucket);
    }

    async function writeBuckets(
      buckets: Map<string, typeof expected>,
      mode: 'grant' | 'update',
    ) {
      for (const permissions of buckets.values()) {
        const first = permissions[0];
        const body = {
          role: first.role,
          accessBoost: first.accessBoost,
          ...(first.principalType === 'user'
            ? { userIds: permissions.map((permission) => permission.principalId) }
            : { userGroupIds: permissions.map((permission) => permission.principalId) }),
        };
        dispatchDestinationModelMutationForItem(item);
        if (mode === 'grant') await destinationClient.grantDocumentPermissions(destinationDocumentId, body);
        else await destinationClient.updateDocumentPermissions(destinationDocumentId, body);
      }
    }
    await writeBuckets(grantBuckets, 'grant');
    await writeBuckets(updateBuckets, 'update');

    const verified = await destinationClient.listDocumentAccess(destinationDocumentId, { accessSource: 'direct' });
    const verifiedByPrincipal = new Map(verified.map((principal) => [`${principal.type}:${principal.id}`, principal]));
    const verificationFailures = expected
      .filter((permission) => {
        const actual = verifiedByPrincipal.get(`${permission.principalType}:${permission.principalId}`);
        return !actual || actual.role !== permission.role || actual.accessBoost !== permission.accessBoost;
      })
      .map((permission) => permission.dependencyId);
    if (verificationFailures.length > 0) {
      throw new Error(`${verificationFailures.length} direct dashboard permission${verificationFailures.length === 1 ? '' : 's'} could not be verified after write.`);
    }

    return {
      warnings,
      details: {
        targetDocumentId: destinationDocumentId,
        directPermissionsRequested: expected.length,
        directPermissionsGranted: [...grantBuckets.values()].reduce((sum, permissions) => sum + permissions.length, 0),
        directPermissionsUpdated: [...updateBuckets.values()].reduce((sum, permissions) => sum + permissions.length, 0),
        directPermissionsVerified: expected.length,
        inheritedPermissionGroupsPreserved: dependencies.filter((dependency) => dependency.kind === 'folder_access').length,
      },
    };
  }

  type ExpectedDashboardDirectPermission = {
    dependencyId: string;
    principalId: string;
    principalType: 'user' | 'userGroup';
    role: 'NO_ACCESS' | 'VIEWER' | 'EDITOR' | 'MANAGER';
    accessBoost: boolean;
  };

  function resolvedDashboardContentPermissionInput(item: MigrationJobItem): {
    dependencies: MigrationPermissionDependency[];
    decisions: MigrationPermissionDecision[];
    expected: ExpectedDashboardDirectPermission[];
    warnings: string[];
  } {
    const target = targetForItem(item);
    const dependencies = detailPermissionDependencies(item.details)
      .filter((dependency) => (
        dependency.kind === 'document_access'
        || dependency.kind === 'document_settings'
        || dependency.kind === 'folder_access'
      ));
    const decisions = [
      ...detailPermissionDecisions(item.details),
      ...normalizePermissionDecisions(target?.permissionDecisions),
    ];
    const uniqueDecisions = [...new Map(decisions.map((decision) => [decision.dependencyId, decision])).values()];
    const blockers = migrationPermissionDecisionBlockers(dependencies, uniqueDecisions);
    if (blockers.length > 0) throw new Error(blockers.join(' '));

    const warnings: string[] = [];
    const expected: ExpectedDashboardDirectPermission[] = [];
    for (const dependency of dependencies) {
      const decision = uniqueDecisions.find((itemDecision) => itemDecision.dependencyId === dependency.id);
      if (!decision) continue;
      if (decision.action === 'ignore_with_waiver') {
        warnings.push(`${dependency.sourceRef} was not applied: ${decision.waiverReason?.trim() || 'waived in Step 4'}.`);
        continue;
      }
      if (decision.action === 'manual_prerequisite') {
        warnings.push(`${dependency.sourceRef} was confirmed as a manual permission prerequisite; OmniKit made no content-access change.`);
        continue;
      }
      if (decision.action === 'preserve_target') {
        warnings.push(`${dependency.sourceRef} was left unchanged on the target dashboard.`);
        continue;
      }
      if (dependency.kind !== 'document_access' || decision.action !== 'map_existing' || !decision.targetRef) continue;
      const value = migrationContentAccessValue(dependency.sourceValue);
      if (!value || value.accessSource !== 'direct' || value.isOwner) {
        throw new Error(`Direct dashboard permission ${dependency.sourceRef} has invalid execution metadata.`);
      }
      const separator = decision.targetRef.indexOf(':');
      const principalType = decision.targetRef.slice(0, separator);
      const principalId = decision.targetRef.slice(separator + 1);
      if (
        separator <= 0
        || !principalId
        || (principalType !== 'user' && principalType !== 'userGroup')
        || principalType !== value.principalType
      ) {
        throw new Error(`Destination principal mapping for ${dependency.sourceRef} is invalid.`);
      }
      expected.push({
        dependencyId: dependency.id,
        principalId,
        principalType,
        role: value.role,
        accessBoost: value.accessBoost,
      });
    }
    return { dependencies, decisions: uniqueDecisions, expected, warnings };
  }

  function plannedQueryFailureMessage(value: Record<string, unknown>): string | undefined {
    const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
    const directError = typeof value.error === 'string'
      ? value.error
      : value.error && typeof value.error === 'object' && !Array.isArray(value.error)
        ? JSON.stringify(value.error)
        : undefined;
    const errors = Array.isArray(value.errors)
      ? value.errors.map((error) => typeof error === 'string' ? error : JSON.stringify(error)).filter(Boolean)
      : [];
    if (directError) return redactSensitiveText(directError);
    if (errors.length > 0) return redactSensitiveText(errors.join(' '));
    if (status === 'failed' || status === 'error') {
      return redactSensitiveText(typeof value.message === 'string' ? value.message : `Query planning returned ${status}.`);
    }
    return undefined;
  }

  async function verifyDashboardPermissions(
    item: MigrationJobItem,
    destinationClient: OmniClient,
    targetModelId: string,
  ): Promise<{ warnings: string[]; details: Record<string, unknown> }> {
    if (!item.documentId) throw new Error('Security verification item missing source document id.');
    const imported = importedByDestinationAndSource.get(`${item.targetId || item.destinationId}:${item.documentId}`);
    const targetDocumentId = imported?.identifier || imported?.documentId;
    if (!targetDocumentId) throw new Error('Security verification could not identify the imported dashboard.');

    const preparation = job.items.find((candidate) => (
      candidate.kind === 'permission_prepare'
      && itemMatchesDependencyScope(item, candidate)
    ));
    if (!preparation || (preparation.status !== 'succeeded' && preparation.status !== 'warning')) {
      throw new Error('Security verification could not find a successful security preparation result for this route.');
    }
    const application = job.items.find((candidate) => (
      candidate.kind === 'permission_apply'
      && itemMatchesDependencyScope(item, candidate)
    ));
    if (application && application.status !== 'succeeded' && application.status !== 'warning') {
      throw new Error('Security verification cannot continue because dashboard access application did not complete.');
    }

    const warnings: string[] = [];
    const dependencies = detailPermissionDependencies(item.details);
    const decisions = [
      ...detailPermissionDecisions(item.details),
      ...normalizePermissionDecisions(targetForItem(item)?.permissionDecisions),
    ];
    const uniqueDecisions = [...new Map(decisions.map((decision) => [decision.dependencyId, decision])).values()];
    const blockers = migrationPermissionDecisionBlockers(dependencies, uniqueDecisions);
    if (blockers.length > 0) throw new Error(blockers.join(' '));

    const baselineModelFingerprints = new Set(detailStringValues(
      preparation.details,
      'permissionModelValidationBaselineFingerprints',
    ));
    const currentModelErrors = (await destinationClient.validateModel(targetModelId))
      .filter((issue) => issue.is_warning !== true);
    const newModelErrors = currentModelErrors.filter((issue) => (
      !baselineModelFingerprints.has(hashPayload({ issue: validationIssueText(issue) }))
    ));
    if (newModelErrors.length > 0) {
      throw new Error(
        `Security verification found ${newModelErrors.length} new model validation error${newModelErrors.length === 1 ? '' : 's'}: `
        + newModelErrors.slice(0, 5).map(validationIssueText).join(' '),
      );
    }

    const baselineContentFingerprints = new Set(detailStringValues(
      preparation.details,
      'permissionContentValidationBaselineFingerprints',
    ));
    const currentContentErrors = normalizeContentValidationIssues(
      await destinationClient.validateModelContent(targetModelId),
    ).filter((issue) => issue.severity === 'error');
    const newContentErrors = currentContentErrors.filter((issue) => (
      !baselineContentFingerprints.has(contentValidationIssueFingerprint(issue))
    ));
    if (newContentErrors.length > 0) {
      throw new Error(
        `Security verification found ${newContentErrors.length} new content validation error${newContentErrors.length === 1 ? '' : 's'}: `
        + newContentErrors.slice(0, 5).map((issue) => redactSensitiveText(issue.message)).join(' '),
      );
    }

    const permissionInput = resolvedDashboardContentPermissionInput(item);
    warnings.push(...permissionInput.warnings);
    let directPermissionsVerified = 0;
    if (permissionInput.expected.length > 0) {
      const actual = await destinationClient.listDocumentAccess(targetDocumentId, { accessSource: 'direct' });
      const actualByPrincipal = new Map(actual.map((principal) => [`${principal.type}:${principal.id}`, principal]));
      const failures = permissionInput.expected.filter((permission) => {
        const principal = actualByPrincipal.get(`${permission.principalType}:${permission.principalId}`);
        return !principal
          || principal.role !== permission.role
          || principal.accessBoost !== permission.accessBoost;
      });
      if (failures.length > 0) {
        throw new Error(`${failures.length} direct dashboard permission${failures.length === 1 ? '' : 's'} failed final verification.`);
      }
      directPermissionsVerified = permissionInput.expected.length;
    }

    let modelRolesVerified = 0;
    for (const dependency of dependencies.filter((candidate) => candidate.kind === 'model_role')) {
      const decision = uniqueDecisions.find((candidate) => candidate.dependencyId === dependency.id);
      if (decision?.action !== 'create_from_source' || !decision.targetRef) continue;
      const value = migrationModelRoleValue(dependency.sourceValue);
      if (!value) throw new Error(`Model-role verification metadata for ${dependency.sourceRef} is invalid.`);
      const separator = decision.targetRef.indexOf(':');
      const principalType = decision.targetRef.slice(0, separator);
      const principalId = decision.targetRef.slice(separator + 1);
      if (
        separator <= 0
        || !principalId
        || (principalType !== 'user' && principalType !== 'userGroup')
        || principalType !== value.principalType
      ) {
        throw new Error(`Destination principal mapping for model role ${dependency.sourceRef} is invalid.`);
      }
      const roles = principalType === 'user'
        ? await destinationClient.listUserModelRoles(principalId, {
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        })
        : await destinationClient.listUserGroupModelRoles(principalId, {
          modelId: targetModelId,
          connectionId: value.targetConnectionId,
        });
      if (!roles.some((role) => (
        (!role.modelId || role.modelId === targetModelId)
        && role.roleName.toLowerCase() === value.sourceRole.toLowerCase()
      ))) {
        throw new Error(`Model role ${value.sourceRole} for ${value.principalLabel} failed final verification.`);
      }
      modelRolesVerified += 1;
    }

    const personaUserIds = [...new Set(permissionInput.expected
      .filter((permission) => permission.principalType === 'user' && permission.role !== 'NO_ACCESS')
      .map((permission) => permission.principalId))]
      .slice(0, 3);
    let personaValidationStatus: 'passed' | 'not_configured' | 'unavailable' = 'not_configured';
    let personaPlansAttempted = 0;
    let personaPlansPassed = 0;
    if (personaUserIds.length > 0) {
      const queries = await destinationClient.getDocumentQueries(targetDocumentId);
      const sampledQueries = queries.slice(0, 3);
      if (sampledQueries.length === 0) {
        warnings.push('Persona query validation was not run because the imported dashboard exposed no reusable query payloads.');
      } else {
        personaValidationStatus = 'passed';
        const sourceModelId = detailString(item.details, 'sourceModelId')
          || detailString(preparation.details, 'sourceModelId');
        let personaUnavailable = false;
        for (const userId of personaUserIds) {
          for (const query of sampledQueries) {
            const plannedQuery = sourceModelId
              ? rewriteQueryModelReferences(query.query, sourceModelId, targetModelId).query
              : { ...query.query, modelId: targetModelId };
            personaPlansAttempted += 1;
            try {
              const result = await destinationClient.planQueryAsUser(plannedQuery, { userId });
              const failure = plannedQueryFailureMessage(result);
              if (failure) throw new Error(failure);
              personaPlansPassed += 1;
            } catch (error) {
              if (error instanceof OmniClientError && (error.status === 401 || error.status === 403)) {
                personaValidationStatus = 'unavailable';
                personaUnavailable = true;
                warnings.push('Persona query validation requires an Omni credential authorized to run plan-only queries as another user; static, model, content, role, and direct-access checks still passed.');
                break;
              }
              throw new Error(`Persona query validation failed for a mapped destination user: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
            }
          }
          if (personaUnavailable) break;
        }
      }
    } else {
      warnings.push('Persona query validation was not configured because this route has no mapped direct user with query access; group-only, denied-user, and row-filter persona cases remain explicit validation limitations.');
    }

    return {
      warnings: [...new Set(warnings)],
      details: {
        targetDocumentId,
        permissionVerification: 'passed',
        modelValidationErrorCount: currentModelErrors.length,
        newModelValidationErrorCount: 0,
        contentValidationErrorCount: currentContentErrors.length,
        newContentValidationErrorCount: 0,
        directPermissionsVerified,
        modelRolesVerified,
        personaValidationStatus,
        personaPlansAttempted,
        personaPlansPassed,
        limitations: [
          'Source document ability settings are not copied because the documented source access-list response does not expose the complete document settings payload.',
          'Inherited folder permissions remain governed by the selected target folder and are never recreated as direct dashboard grants.',
          'Group-only, denied-user, and row-filter persona validation requires separately selected test personas.',
        ],
      },
    };
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
      if ((item.kind === 'permission_prepare' || item.kind === 'field_prepare' || item.kind === 'query_view_prepare' || item.kind === 'relationship_prepare' || item.kind === 'topic_prepare' || item.kind === 'semantic_validate' || item.kind === 'query_validate' || item.kind === 'import' || item.kind === 'update' || item.kind === 'permission_apply' || item.kind === 'permission_verify' || item.kind === 'metadata' || item.kind === 'document_verify' || item.kind === 'source_delete') && item.status === 'pending') {
        markAndPersistItem(item, 'skipped', { error: reason });
      }
    }
  }

  function itemMatchesDependencyScope(candidate: MigrationJobItem, dependency: MigrationJobItem): boolean {
    if (!candidate.documentId || candidate.documentId !== dependency.documentId) return false;
    if (candidate.destinationId !== dependency.destinationId) return false;
    if (candidate.targetId && dependency.targetId && candidate.targetId === dependency.targetId) return true;
    if (!candidate.routeGroupId || !dependency.routeGroupId || candidate.routeGroupId !== dependency.routeGroupId) return false;
    const candidateModel = candidate.targetModelId || '';
    const dependencyModel = dependency.targetModelId || '';
    return Boolean(candidateModel && dependencyModel && candidateModel === dependencyModel);
  }

  function dashboardPrepLabel(kind: JobItemKind): string {
    if (kind === 'permission_prepare') return 'Security and access preparation';
    if (kind === 'permission_apply') return 'Dashboard access application';
    if (kind === 'permission_verify') return 'Security verification';
    if (kind === 'field_prepare') return 'Field preparation';
    if (kind === 'query_view_prepare') return 'Query-view preparation';
    if (kind === 'relationship_prepare') return 'Relationship preparation';
    if (kind === 'topic_prepare') return 'Topic preparation';
    if (kind === 'semantic_validate') return 'Semantic model validation';
    if (kind === 'query_validate') return 'Functional query validation';
    return 'Dependency preparation';
  }

  function blockingPrepForWrite(item: MigrationJobItem): MigrationJobItem | undefined {
    if (item.kind !== 'import' && item.kind !== 'update') return undefined;
    return job.items.find((candidate) => (
      isDashboardPrepKind(candidate.kind)
      && itemMatchesDependencyScope(item, candidate)
      && candidate.status !== 'succeeded'
      && candidate.status !== 'warning'
    ));
  }

  function skipWriteForBlockingPrep(item: MigrationJobItem, blockingPrep: MigrationJobItem): void {
    const writeLabel = item.kind === 'update' ? 'dashboard update' : 'dashboard import';
    const reason = `${dashboardPrepLabel(blockingPrep.kind)} did not complete; ${writeLabel} skipped.${blockingPrep.error ? ` ${blockingPrep.error}` : ''}`;
    markAndPersistItem(item, 'skipped', { error: reason });
    if (item.kind === 'import') releaseExportConsumer(item.documentId);
  }

  function skipDestinationDocumentItems(failedItem: MigrationJobItem, reason: string): void {
    if (!failedItem.documentId) return;
    for (const item of job.items) {
      if (item.status !== 'pending') continue;
      if (item.documentId !== failedItem.documentId) continue;
      if (!itemMatchesDependencyScope(item, failedItem)) continue;
      if (item.kind !== 'permission_prepare' && item.kind !== 'field_prepare' && item.kind !== 'query_view_prepare' && item.kind !== 'relationship_prepare' && item.kind !== 'topic_prepare' && item.kind !== 'semantic_validate' && item.kind !== 'query_validate' && item.kind !== 'import' && item.kind !== 'update' && item.kind !== 'permission_apply' && item.kind !== 'permission_verify' && item.kind !== 'metadata' && item.kind !== 'document_verify') continue;
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
    const needsSourceQueryViewDefinitions = mappings.some((mapping) => (
      mapping.sourceFileName?.endsWith('.query.view')
      || !sourceDefinitions.has(normalizeFieldRef(mapping.sourceFieldRef).toLowerCase())
    ));
    if (needsSourceQueryViewDefinitions) {
      mergeFieldDefinitions(sourceDefinitions, await sourceQueryViewCatalog(sourceModelId));
    }
    const queryViewTargetFileNames = new Set(mappings
      .map((mapping) => mapping.targetFileName || mapping.sourceFileName)
      .filter((fileName): fileName is string => Boolean(fileName?.endsWith('.query.view'))));
    const targetQueryViewsWithYaml = queryViewTargetFileNames.size > 0
      ? await destinationClient.listModelQueryViews(targetModelId, { includeYaml: true, includeChecksums: true })
      : [];
    mergeFieldDefinitions(targetDefinitions, targetQueryViewsWithYaml);
    const targetQueryViewsByFileName = new Map(targetQueryViewsWithYaml.map((queryView) => [queryView.fileName, queryView]));
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
      const targetQueryView = targetQueryViewsByFileName.get(targetFileName);
      const targetChecksum = targetYaml.checksums?.[targetFileName] || targetQueryView?.checksum;
      const targetFieldKey = `${destination.id}:${targetModelId}:${targetFileName}:${sourceFieldRef.toLowerCase()}`;
      if (preparedFieldKeys.has(targetFieldKey)) {
        mappedFields.push(sourceFieldRef);
        continue;
      }

      const acceptedPatch = activeSemanticPatchFor(semanticPatches, 'field', targetFileName, sourceFieldRef);
      const acceptedWrite = semanticPatchWriteInput(acceptedPatch, targetChecksum);
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

      const currentFile = writtenFiles.get(targetFileName)?.yaml
        ?? targetYaml.files[targetFileName]
        ?? targetQueryView?.yaml;
      const nextYaml = mergeFieldDefinitionIntoViewYaml({
        existingYaml: currentFile,
        fieldKind,
        fieldYaml,
      });
      writtenFiles.set(targetFileName, {
        yaml: nextYaml,
        previousChecksum: targetChecksum,
      });
      preparedFieldKeys.add(targetFieldKey);
      if (mapping.action === 'map_existing') mappedFields.push(`${sourceFieldRef}->${mapping.targetFieldRef}`);
      else createdFields.push(sourceFieldRef);
    }

    for (const [fileName, file] of writtenFiles) {
      await writeSemanticYamlFile({
        item,
        destinationId: destination.id,
        destinationClient,
        targetModelId,
        fileName,
        yaml: file.yaml,
        previousChecksum: file.previousChecksum,
        commitMessage: `OmniKit Dashboard Migrator prepare ${createdFields.length + mappedFields.length} field${createdFields.length + mappedFields.length === 1 ? '' : 's'}`,
      });
      if (fileName.endsWith('.query.view')) {
        targetQueryViewCatalogCache.delete(`${destination.id}:${targetModelId}`);
      }
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
		              await writeSemanticYamlFile({
		                item,
		                destinationId: destination.id,
		                destinationClient,
		                targetModelId,
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
	        await writeSemanticYamlFile({
	          item,
	          destinationId: destination.id,
	          destinationClient,
	          targetModelId,
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
	      await writeSemanticYamlFile({
	        item,
	        destinationId: destination.id,
	        destinationClient,
	        targetModelId,
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
	      await writeSemanticYamlFile({
	        item,
	        destinationId: destination.id,
	        destinationClient,
	        targetModelId,
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
	          if (acceptedPatch?.resolution === 'keep_target') {
	            warnings.push(`Target query view ${latestTargetQueryView.name} was kept unchanged by the accepted code decision.`);
	            mappedQueryViews.push(`${mapping.sourceQueryViewName}->${latestTargetQueryView.label || latestTargetQueryView.name}`);
	            appliedMappings.push({
	              ...appliedMapping,
	              action: 'map_existing',
	              sourceFileName: mapping.sourceFileName || sourceQueryView.fileName,
	              targetFileName: latestTargetQueryView.fileName,
	              targetQueryViewName: latestTargetQueryView.name,
	            });
	            continue;
	          }
	          const acceptedWrite = semanticPatchWriteInput(acceptedPatch, latestTargetQueryView.checksum);
	          if (acceptedWrite) {
	            await writeSemanticYamlFile({
	              item,
	              destinationId: destination.id,
	              destinationClient,
	              targetModelId,
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
		          const targetOnlyFields = targetOnlyQueryViewFields(sourceQueryView, latestTargetQueryView);
		          if (targetOnlyFields.length > 0) {
		            throw new Error(`Target query view ${latestTargetQueryView.name} has fields not present in the source copy: ${formatFieldList(targetOnlyFields)}. Choose Use existing unchanged in Step 4 to preserve target-only fields, or manually merge the target query view before retrying.`);
		          }
	          await writeSemanticYamlFile({
	            item,
	            destinationId: destination.id,
		            destinationClient,
		            targetModelId,
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
        throw new Error(`Target query view ${mapping.targetQueryViewName} already exists. Use existing unchanged or update target from source.`);
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
          throw new Error(`Target query view ${mapping.targetQueryViewName} already exists. Use existing unchanged or update target from source.`);
        }
	        const acceptedPatch = activeSemanticPatchFor(
	          semanticPatches,
	          'query_view',
		          targetFileName,
		          mapping.sourceQueryViewName,
		        );
		        const acceptedWrite = semanticPatchWriteInput(acceptedPatch);
	        await writeSemanticYamlFile({
	          item,
	          destinationId: destination.id,
		          destinationClient,
		          targetModelId,
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

  async function validateDashboardQueriesForTarget(
    item: MigrationJobItem,
    destinationClient: OmniClient,
    targetModelId: string,
    options: {
      documentClient?: OmniClient;
      documentId?: string;
      rewrite?: boolean;
    } = {},
  ): Promise<{
    queryCount: number;
    executableCount: number;
    passedCount: number;
    failedCount: number;
    waivedCount: number;
    notApplicableCount: number;
    zeroRowCount: number;
    results: Array<Record<string, unknown>>;
  }> {
    if (!item.documentId) throw new Error('Functional query validation item missing document id.');
    const queries = await (options.documentClient || sourceClient).getDocumentQueries(options.documentId || item.documentId);
    const sourceDoc = sourceDocumentDetails.get(item.documentId);
    const cached = exports.get(item.documentId);
    const sourceModelId = sourceDoc?.baseModelId
      || detailString(item.details, 'sourceModelId')
      || (cached ? extractDashboardModelId(cached.payload) : undefined);
    const topicMappings = detailTopicMappings(item.details).length > 0
      ? detailTopicMappings(item.details)
      : targetForItem(item)?.topicMappings || [];
    const queryViewMappings = detailQueryViewMappings(item.details).length > 0
      ? detailQueryViewMappings(item.details)
      : targetForItem(item)?.queryViewMappings || [];
    const results: Array<Record<string, unknown>> = [];
    let passedCount = 0;
    let failedCount = 0;
    let waivedCount = 0;
    let notApplicableCount = 0;
    let zeroRowCount = 0;
    const waivers = normalizeQueryValidationWaivers(targetForItem(item)?.queryValidationWaivers)
      .filter((waiver) => waiver.documentId === item.documentId);

    for (const queryRecord of queries) {
      if (!queryRecord.query || Object.keys(queryRecord.query).length === 0) {
        notApplicableCount += 1;
        results.push({
          queryId: queryRecord.id,
          name: queryRecord.name,
          status: 'not_applicable',
          reason: 'No query payload was returned for this tile.',
        });
        continue;
      }
      const rewritten = options.rewrite === false
        ? {
            query: { ...queryRecord.query },
            modelRewriteCount: 0,
            modelExtensionRemovalCount: 0,
            topicRewriteCount: 0,
            queryViewRewriteCount: 0,
          }
        : rewriteDashboardQueryForTarget({
            query: queryRecord.query,
            sourceModelId,
            targetModelId,
            topicMappings,
            queryViewMappings,
          });
      try {
        const execution = await destinationClient.runQuery(rewritten.query, { cache: 'SkipCache' });
        passedCount += 1;
        if (execution.rowCount === 0) zeroRowCount += 1;
        results.push({
          queryId: queryRecord.id,
          name: queryRecord.name,
          status: 'passed',
          executionStatus: execution.status,
          ...(execution.jobId ? { jobId: execution.jobId } : {}),
          ...(execution.rowCount !== undefined ? { rowCount: execution.rowCount } : {}),
          modelRewriteCount: rewritten.modelRewriteCount,
          modelExtensionRemovalCount: rewritten.modelExtensionRemovalCount,
          topicRewriteCount: rewritten.topicRewriteCount,
          queryViewRewriteCount: rewritten.queryViewRewriteCount,
        });
      } catch (error) {
        const waiver = waivers.find((candidate) => candidate.queryId === queryRecord.id);
        if (waiver) waivedCount += 1;
        else failedCount += 1;
        results.push({
          queryId: queryRecord.id,
          name: queryRecord.name,
          status: waiver ? 'waived' : 'failed',
          error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500),
          ...(waiver ? {
            waiver: {
              reason: redactSensitiveText(waiver.reason).slice(0, 500),
              ...(waiver.acknowledgedAt ? { acknowledgedAt: waiver.acknowledgedAt } : {}),
            },
          } : {}),
          modelRewriteCount: rewritten.modelRewriteCount,
          modelExtensionRemovalCount: rewritten.modelExtensionRemovalCount,
          topicRewriteCount: rewritten.topicRewriteCount,
          queryViewRewriteCount: rewritten.queryViewRewriteCount,
        });
      }
    }

    return {
      queryCount: queries.length,
      executableCount: queries.length - notApplicableCount,
      passedCount,
      failedCount,
      waivedCount,
      notApplicableCount,
      zeroRowCount,
      results,
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
        dispatchDestinationModelMutationForItem(item);
        await destinationClient.requestDeleteDocument(item.documentId);
        invalidateDocumentInventory(destination.id);
        markAndPersistItem(item, 'succeeded');
      } else if (item.kind === 'permission_prepare') {
        if (!item.documentId) throw new Error('Security preparation item missing document id.');
        if (item.error) {
          markAndPersistItem(item, 'failed');
          skipDestinationDocumentItems(item, `Security and access preparation failed; dependent step skipped. ${item.error}`);
          return;
        }
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const prepared = await prepareDashboardPermissionsForImport(item, destination, destinationClient, targetModelId);
        const warnings = [...(item.warnings || []), ...prepared.warnings];
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: { ...(item.details || {}), ...prepared.details, migrationMutationTerminal: true },
        });
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
          details: { ...(item.details || {}), ...prepared.details, migrationMutationTerminal: true },
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
	          details: { ...(item.details || {}), ...prepared.details, migrationMutationTerminal: true },
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
	          details: { ...(item.details || {}), ...prepared.details, migrationMutationTerminal: true },
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
          details: { ...(item.details || {}), ...prepared.details, migrationMutationTerminal: true },
        });
      } else if (item.kind === 'semantic_validate') {
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const issues = await destinationClient.validateModel(targetModelId);
        const errorCount = issues.filter((issue) => issue.is_warning !== true).length;
        const warningCount = issues.length - errorCount;
        const issueEvidence = issues.slice(0, 50).map((issue) => ({
          severity: issue.is_warning === true ? 'warning' : 'error',
          message: redactSensitiveText(issue.message || 'Omni model validation issue.').slice(0, 500),
          ...(issue.yaml_path ? { yamlPath: issue.yaml_path } : {}),
        }));
        const details = {
          ...(item.details || {}),
          semanticValidation: {
            issueCount: issues.length,
            errorCount,
            warningCount,
            issues: issueEvidence,
          },
        };
        if (errorCount > 0) {
          const error = `${errorCount} semantic model validation error${errorCount === 1 ? '' : 's'} must be resolved before dashboard publication.`;
          markAndPersistItem(item, 'failed', { error, details });
          skipDestinationDocumentItems(item, `Semantic model validation failed; dashboard publication skipped. ${error}`);
          return;
        }
        markAndPersistItem(item, warningCount > 0 ? 'warning' : 'succeeded', {
          warnings: warningCount > 0 ? [`Omni returned ${warningCount} non-blocking semantic model validation warning${warningCount === 1 ? '' : 's'}.`] : undefined,
          details,
        });
      } else if (item.kind === 'query_validate') {
        if (!item.documentId) throw new Error('Functional query validation item missing document id.');
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const validation = await validateDashboardQueriesForTarget(item, destinationClient, targetModelId);
        const validationDetails = {
          ...(item.details || {}),
          functionalValidation: validation,
        };
        if (validation.failedCount > 0) {
          const error = `${validation.failedCount} of ${validation.queryCount} query-backed dashboard tile${validation.queryCount === 1 ? '' : 's'} failed functional validation.`;
          markAndPersistItem(item, 'failed', { error, details: validationDetails });
          skipDestinationDocumentItems(item, `Functional query validation failed; dashboard publication skipped. ${error}`);
          return;
        }
        markAndPersistItem(item, validation.waivedCount > 0 ? 'warning' : 'succeeded', {
          warnings: validation.waivedCount > 0
            ? [`${validation.waivedCount} query failure${validation.waivedCount === 1 ? '' : 's'} proceeded under an explicit user waiver. Source cleanup will remain disabled.`]
            : item.warnings,
          notices: validation.queryCount === 0
            ? [...(item.notices || []), 'No query-backed tiles were returned; functional query validation is not applicable.']
            : item.notices,
          details: validationDetails,
        });
      } else if (item.kind === 'update') {
        if (!item.documentId) throw new Error('Update item missing source document id.');
        const blockingPrep = blockingPrepForWrite(item);
        if (blockingPrep) {
          skipWriteForBlockingPrep(item, blockingPrep);
          return;
        }
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const destinationDocumentId = detailString(item.details, 'destinationDocumentId');
        if (!destinationDocumentId) throw new Error('Update item missing destination document id.');
        const topicMappings = detailTopicMappings(item.details).length > 0
          ? detailTopicMappings(item.details)
          : targetForItem(item)?.topicMappings || [];
        const queryViewMappings = detailQueryViewMappings(item.details).length > 0
          ? detailQueryViewMappings(item.details)
          : targetForItem(item)?.queryViewMappings || [];
        const cached = exports.get(item.documentId);
        const sourceDoc = sourceDocumentDetails.get(item.documentId);
        const sourceModelId = sourceDoc?.baseModelId
          || detailString(item.details, 'sourceModelId')
          || (cached ? extractDashboardModelId(cached.payload) : undefined);
        let sourceState: Record<string, unknown>;
        let destinationState: Record<string, unknown>;
        try {
          [sourceState, destinationState] = await Promise.all([
            sourceClient.getDocumentStateV2(item.documentId),
            destinationClient.getDocumentStateV2(destinationDocumentId),
          ]);
        } catch (error) {
          if (error instanceof OmniClientError && error.status === 404) {
            throw new Error(`Documents V2 state could not be loaded for update-in-place. Falling back requires rerunning with Replace selected for this destination. ${error.message}`);
          }
          throw error;
        }
        const destinationModelId = documentV2ModelBinding(destinationState);
        if (!destinationModelId) {
          throw new Error('Destination Documents V2 state did not report its target model binding; update-in-place was stopped before opening a draft.');
        }
        if (destinationModelId !== targetModelId) {
          throw new Error(
            `Destination Documents V2 state is bound to model ${destinationModelId}, expected ${targetModelId}; update-in-place was stopped before opening a draft.`,
          );
        }
        const patchPlan = buildDocumentV2UpdatePatchPlan({
          sourceState,
          destinationState,
          sourceModelId,
          targetModelId,
          topicMappings,
          queryViewMappings,
          sourceLabel: job.sourceLabel,
          jobId: job.id,
        });
        let draftIdentifier = '';
        try {
          const [firstPatch, ...remainingPatches] = patchPlan.patches;
          if (!firstPatch) throw new Error('No Documents V2 patch was prepared for update-in-place.');
          dispatchDestinationModelMutationForItem(item);
          const draft = await destinationClient.createDocumentDraft(destinationDocumentId, firstPatch);
          draftIdentifier = draft.draftIdentifier;
          if (!draftIdentifier) throw new Error('Documents V2 did not return a draft identifier.');
          for (const patch of remainingPatches) {
            await destinationClient.patchDocumentDraft(destinationDocumentId, draftIdentifier, patch);
          }
          await destinationClient.publishDocumentDraft(destinationDocumentId);
          invalidateDocumentInventory(destination.id);
          const publishedState = await destinationClient.getDocumentStateV2(destinationDocumentId);
          const publishedModelId = documentV2ModelBinding(publishedState);
          if (!publishedModelId) {
            throw new Error('Published Documents V2 state did not report its target model binding; update-in-place verification failed.');
          }
          if (publishedModelId !== targetModelId) {
            throw new Error(
              `Published Documents V2 state is bound to model ${publishedModelId}, expected ${targetModelId}; update-in-place verification failed.`,
            );
          }
        } catch (error) {
          if (error instanceof OmniClientError && error.status === 409) {
            throw new Error('The destination dashboard has an unpublished draft. Publish or discard it in Omni, then retry this destination.');
          }
          throw error;
        }
        const warnings = [...(item.warnings || []), ...patchPlan.warnings];
        importedByDestinationAndSource.set(`${item.targetId || destination.id}:${item.documentId}`, {
          identifier: destinationDocumentId,
          documentId: destinationDocumentId,
          updatedInPlace: true,
        });
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          importedIdentifier: destinationDocumentId,
          importedDocumentId: destinationDocumentId,
          warnings: warnings.length > 0 ? warnings : undefined,
          details: {
            ...(item.details || {}),
            draftIdentifier,
            publishedAt: new Date().toISOString(),
            tileCount: patchPlan.tileCount,
            deletedTileCount: patchPlan.deletedTileCount,
            modelRewriteCount: patchPlan.modelRewriteCount,
            modelExtensionRemovalCount: patchPlan.modelExtensionRemovalCount,
            topicRewriteCount: patchPlan.topicRewriteCount,
            queryViewRewriteCount: patchPlan.queryViewRewriteCount,
            updateInPlace: true,
            migrationMutationTerminal: true,
          },
        });
      } else if (item.kind === 'import') {
        if (!item.documentId) throw new Error('Import item missing document id.');
        const blockingPrep = blockingPrepForWrite(item);
        if (blockingPrep) {
          skipWriteForBlockingPrep(item, blockingPrep);
          return;
        }
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
        const queryViewMappings = detailQueryViewMappings(item.details).length > 0
          ? detailQueryViewMappings(item.details)
          : targetForItem(item)?.queryViewMappings || [];
        const modelStats = { replacements: 0, extensionRemovals: 0 };
        const modelRetargeted = retargetDashboardModelReferences(
          cached.payload,
          targetModelId,
          modelStats,
        ) as Record<string, unknown>;
        const topicRewritten = rewriteDashboardTopicReferences(modelRetargeted, topicMappings);
        const queryViewStats = { replacements: 0 };
        const importPayload = rewriteQueryViewReferences(
          topicRewritten.payload,
          buildQueryViewRewriteMap(queryViewMappings),
          '',
          queryViewStats,
        ) as Record<string, unknown>;
        dispatchDestinationModelMutationForItem(item);
        const imported = await destinationClient.importDocument({
          exportPayload: importPayload,
          baseModelId: targetModelId,
          folderPath: targetFolderPath,
          documentName: item.documentName || 'Untitled',
        });
        invalidateDocumentInventory(destination.id);
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
            invalidateDocumentInventory(destination.id);
          } catch (error) {
            throw new Error(`Folder move outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
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
            modelRewriteCount: modelStats.replacements,
            modelExtensionRemovalCount: modelStats.extensionRemovals,
            topicRewriteCount: topicRewritten.replacementCount,
            topicRewrites: topicRewritten.replacements,
            queryViewRewriteCount: queryViewStats.replacements,
            migrationMutationTerminal: true,
          },
        });
        releaseExportConsumer(item.documentId);
      } else if (item.kind === 'permission_apply') {
        if (item.error) throw new Error(item.error);
        if (
          !item.documentId
          || !importedByDestinationAndSource.has(`${item.targetId || destination.id}:${item.documentId}`)
        ) {
          markAndPersistItem(item, 'skipped', {
            error: 'Dashboard access was not applied because the dashboard import or update did not complete.',
          });
          return;
        }
        const applied = await applyDashboardContentPermissions(item, destinationClient);
        const warnings = [...(item.warnings || []), ...applied.warnings];
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: { ...(item.details || {}), ...applied.details, migrationMutationTerminal: true },
        });
      } else if (item.kind === 'permission_verify') {
        if (item.error) throw new Error(item.error);
        if (!item.targetModelId) throw new Error('Security verification item missing target model id.');
        if (
          !item.documentId
          || !importedByDestinationAndSource.has(`${item.targetId || destination.id}:${item.documentId}`)
        ) {
          markAndPersistItem(item, 'skipped', {
            error: 'Security verification was skipped because the dashboard import or update did not complete.',
          });
          return;
        }
        const verified = await verifyDashboardPermissions(item, destinationClient, item.targetModelId);
        const warnings = [...(item.warnings || []), ...verified.warnings];
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
          details: { ...(item.details || {}), ...verified.details },
        });
      } else if (item.kind === 'metadata') {
        if (!item.documentId) throw new Error('Metadata item missing document id.');
        const imported = importedByDestinationAndSource.get(`${item.targetId || destination.id}:${item.documentId}`);
        if (!imported?.identifier) {
          markAndPersistItem(item, 'skipped', { error: 'No imported document identifier available for metadata preservation.' });
          return;
        }
        const meta = sourceMeta.get(item.documentId);
        const warnings: string[] = [];
        if (meta?.description && !imported.updatedInPlace) {
          try {
            dispatchDestinationModelMutationForItem(item);
            await destinationClient.patchDocument(imported.identifier, { description: meta.description });
            invalidateDocumentInventory(destination.id);
          } catch (error) {
            throw new Error(`Description copy outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (meta?.labels?.length) {
          try {
            let labelSet = destinationLabelCache.get(destination.id);
            if (!labelSet) {
              labelSet = new Set((await destinationClient.listLabels()).map((label) => label.name));
              destinationLabelCache.set(destination.id, labelSet);
            }
            dispatchDestinationModelMutationForItem(item);
            for (const label of meta.labels) {
              if (!labelSet.has(label)) {
                const sourceLabel = sourceLabels.get(label);
                await destinationClient.createLabel({ name: label, color: sourceLabel?.color, description: sourceLabel?.description });
                labelSet.add(label);
              }
            }
            await destinationClient.setDocumentLabels(imported.identifier, meta.labels);
            invalidateDocumentInventory(destination.id);
          } catch (error) {
            throw new Error(`Label copy outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        markAndPersistItem(item, warnings.length > 0 ? 'warning' : 'succeeded', {
          warnings: warnings.length > 0 ? warnings : undefined,
          details: {
            ...(item.details || {}),
            ...(!meta?.description && !meta?.labels?.length ? { noMutation: true } : {}),
            migrationMutationTerminal: true,
          },
        });
      } else if (item.kind === 'document_verify') {
        if (!item.documentId) throw new Error('Published document verification item missing source document id.');
        const targetModelId = item.targetModelId || destination.defaultModelId;
        if (!targetModelId) throw new Error(`${destination.label} has no target model selected.`);
        const imported = importedByDestinationAndSource.get(`${item.targetId || destination.id}:${item.documentId}`);
        const destinationDocumentId = imported?.documentId || imported?.identifier;
        if (!destinationDocumentId) {
          markAndPersistItem(item, 'skipped', { error: 'Published document verification skipped because no destination document was created or updated.' });
          return;
        }
        const validation = await validateDashboardQueriesForTarget(item, destinationClient, targetModelId, {
          documentClient: destinationClient,
          documentId: destinationDocumentId,
          rewrite: false,
        });
        const details = {
          ...(item.details || {}),
          destinationDocumentId,
          functionalValidation: validation,
        };
        if (validation.failedCount > 0) {
          markAndPersistItem(item, 'failed', {
            error: `${validation.failedCount} published dashboard query tile${validation.failedCount === 1 ? '' : 's'} failed final verification.`,
            details,
          });
          return;
        }
        markAndPersistItem(item, validation.waivedCount > 0 ? 'warning' : 'succeeded', {
          warnings: validation.waivedCount > 0
            ? [`${validation.waivedCount} published query failure${validation.waivedCount === 1 ? '' : 's'} remained under an explicit user waiver. Source cleanup will remain disabled.`]
            : item.warnings,
          notices: validation.queryCount === 0
            ? [...(item.notices || []), 'The published document contains no query-backed tiles; final query verification is not applicable.']
            : item.notices,
          details,
        });
      }
    } catch (error) {
	      const message = error instanceof OmniClientError || error instanceof Error ? error.message : String(error);
      const failureDetails = item.kind === 'query_view_prepare' ? queryViewPrepFailureDetails(message) : undefined;
	      markAndPersistItem(item, 'failed', {
        error: message,
        ...(failureDetails ? { details: { ...(item.details || {}), ...failureDetails } } : {}),
      });
		      if (item.kind === 'permission_prepare') {
		        skipDestinationDocumentItems(item, `Security and access preparation failed; dependent step skipped. ${message}`);
		      }
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
      if (item.kind === 'permission_verify') {
        skipDestinationDocumentItems(item, `Security verification failed; dependent metadata step skipped. ${message}`);
      }
      if (item.kind === 'semantic_validate') {
        skipDestinationDocumentItems(item, `Semantic model validation failed; dashboard publication skipped. ${redactSensitiveText(message)}`);
      }
      if (item.kind === 'query_validate') {
        skipDestinationDocumentItems(item, `Functional query validation failed; dashboard publication skipped. ${redactSensitiveText(message)}`);
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
        if (item.status !== 'pending') continue;
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
    const imports = job.items.filter((item) => (item.kind === 'import' || item.kind === 'update') && item.documentId === documentId);
    const permissionApplications = job.items.filter((item) => item.kind === 'permission_apply' && item.documentId === documentId);
    const permissionVerifications = job.items.filter((item) => item.kind === 'permission_verify' && item.documentId === documentId);
    const validations = job.items.filter((item) => (
      (item.kind === 'semantic_validate' || item.kind === 'query_validate' || item.kind === 'document_verify')
      && item.documentId === documentId
    ));
    return imports.length > 0
      && imports.every((item) => item.status === 'succeeded' || item.status === 'warning')
      && permissionApplications.every((item) => item.status === 'succeeded' || item.status === 'warning')
      && permissionVerifications.every((item) => item.status === 'succeeded' || item.status === 'warning')
      && validations.length > 0
      && validations.every((item) => item.status === 'succeeded' || item.status === 'warning')
      && validations.every((item) => {
        const functionalValidation = item.details?.functionalValidation;
        if (!functionalValidation || typeof functionalValidation !== 'object' || Array.isArray(functionalValidation)) return true;
        const validationDetails = functionalValidation as Record<string, unknown>;
        return typeof validationDetails.waivedCount !== 'number' || validationDetails.waivedCount === 0;
      });
  }

  function sourceDocumentMetadataSucceeded(documentId: string | undefined): boolean {
    if (!documentId) return false;
    const metadataItems = job.items.filter((item) => item.kind === 'metadata' && item.documentId === documentId);
    return metadataItems.length > 0 && metadataItems.every((item) => item.status === 'succeeded');
  }

  function sourceDocumentSecuritySucceeded(documentId: string | undefined): boolean {
    if (!documentId) return false;
    const securityItems = job.items.filter((item) => (
      (item.kind === 'permission_apply' || item.kind === 'permission_verify')
      && item.documentId === documentId
    ));
    return securityItems.every((item) => item.status === 'succeeded' || item.status === 'warning');
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
        markAndPersistItem(item, 'skipped', {
          error: sourceDocumentSecuritySucceeded(item.documentId)
            ? 'Source delete skipped because the dashboard import did not complete successfully.'
            : 'Source delete skipped because security verification or access application did not complete successfully.',
        });
        continue;
      }
      if (!sourceDocumentMetadataSucceeded(item.documentId)) {
        markAndPersistItem(item, 'skipped', {
          error: 'Source delete skipped because dashboard metadata preservation did not complete successfully.',
        });
        continue;
      }
      markAndPersistItem(item, 'running');
      try {
        if (!item.documentId) throw new Error('Source delete item missing document id.');
        dispatchDestinationModelMutationForItem(item);
        await sourceClient.requestDeleteDocument(item.documentId);
        invalidateDocumentInventory(source.id);
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
    const destination = action.destinationInstanceId
      ? (job.workflow === 'model'
        ? requireModelMigrationInstance(action.destinationInstanceId, 'destination')
        : requireInstance(action.destinationInstanceId))
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
      details: action.kind === 'refresh-schema'
        ? { migrationMutationActionKind: 'refresh-schema' }
        : undefined,
    };
    job.items.push(item);
    updateJobItem(item);
    if (action.kind !== 'refresh-schema' && action.method.toUpperCase() !== 'GET') {
      markAndPersistItem(item, 'skipped', {
        error: 'Mutating webhook post-actions are disabled because their remote outcome cannot be reconciled safely after a lost response.',
        details: { ...(item.details || {}), noMutation: true },
      });
      continue;
    }
    if (job.workflow === 'model') {
      const modelInput = modelMigrationInputFromJob(job);
      const canonicalTargetModelIds = new Set(modelInput.models.map((model) => model.targetModelId));
      if (!destination) {
        markAndPersistItem(item, 'skipped', { error: 'Model post-action skipped because its exact destination scope was unavailable.' });
        continue;
      }
      if (
        action.destinationInstanceId !== modelInput.targetId
        || (action.targetModelId !== undefined && !canonicalTargetModelIds.has(action.targetModelId))
      ) {
        markAndPersistItem(item, 'skipped', { error: 'Model post-action skipped because its persisted scope did not match this job.' });
        continue;
      }
      const actionTargetModelIds = action.targetModelId
        ? [action.targetModelId]
        : [...canonicalTargetModelIds];
      if (actionTargetModelIds.length === 0) {
        markAndPersistItem(item, 'skipped', { error: 'Model post-action skipped because no exact target model scope was available.' });
        continue;
      }
      const ownedMutationLeaseIds = new Set(job.items.flatMap((candidate) => {
        const lease = migrationDestinationModelMutationLease(candidate);
        return lease
          && lease.destinationInstanceId === destination.id
          && actionTargetModelIds.includes(lease.targetModelId)
            ? [candidate.id]
            : [];
      }));
      assertNoUnresolvedSafeCopyModelOverlap(destination.id, actionTargetModelIds, ownedMutationLeaseIds);
      const failedModelWork = job.items.some((jobItem) => (
        jobItem.id !== item.id
        && (!action.targetModelId || jobItem.targetModelId === action.targetModelId)
        && (jobItem.kind === 'model_validate' || jobItem.kind === 'content_validate')
        && jobItem.status !== 'succeeded'
        && jobItem.status !== 'warning'
      ));
      if (failedModelWork) {
        markAndPersistItem(item, 'skipped', { error: 'Post-migration action skipped because model or content validation did not complete successfully.' });
        continue;
      }
    }
    const unresolvedDestinationMutation = job.items.some((jobItem) => (
      jobItem.id !== item.id
      && DESTINATION_MODEL_MUTATION_KINDS.has(jobItem.kind)
      && jobItem.details?.noMutation !== true
      && (!action.destinationInstanceId || jobItem.destinationId === action.destinationInstanceId)
      && (!action.targetModelId || jobItem.targetModelId === action.targetModelId)
      && (jobItem.status === 'failed' || jobItem.status === 'running')
    ));
    if (unresolvedDestinationMutation) {
      markAndPersistItem(item, 'skipped', {
        error: 'Post-migration action skipped because an earlier destination-model write did not finish cleanly.',
      });
      continue;
    }
    const mandatoryValidations = job.items.filter((jobItem) => (
      (jobItem.kind === 'semantic_validate' || jobItem.kind === 'query_validate' || jobItem.kind === 'document_verify')
      && (!action.destinationInstanceId || jobItem.destinationId === action.destinationInstanceId)
      && (!action.targetModelId || (jobItem.targetModelId || '') === action.targetModelId)
    ));
    if (mandatoryValidations.some((jobItem) => jobItem.status !== 'succeeded' && jobItem.status !== 'warning')) {
      markAndPersistItem(item, 'skipped', {
        error: 'Post-migration action skipped because mandatory semantic or dashboard validation did not complete successfully.',
      });
      continue;
    }
    if (action.kind === 'refresh-schema' && action.destinationInstanceId && action.targetModelId) {
      const writes = job.items.filter((jobItem) => (
        (jobItem.kind === 'import' || jobItem.kind === 'update')
        && jobItem.destinationId === action.destinationInstanceId
        && (jobItem.targetModelId || '') === action.targetModelId
      ));
      if (writes.length > 0 && writes.some((jobItem) => jobItem.status !== 'succeeded' && jobItem.status !== 'warning')) {
        markAndPersistItem(item, 'skipped', {
          error: 'Schema refresh skipped because a dashboard write for this destination model did not complete successfully.',
        });
        continue;
      }
    }
    if (action.kind === 'refresh-schema') dispatchDestinationModelMutationForItem(item);
    const schemaResult = action.kind === 'refresh-schema'
      ? await runSchemaRefreshAction(action, (externalJobId) => {
        if (!action.destinationInstanceId || !action.targetModelId) return;
        attachExternalJobToDestinationModelMutation(job, {
          destinationInstanceId: action.destinationInstanceId,
          targetModelId: action.targetModelId,
        }, externalJobId, item.id);
      })
      : undefined;
    const result = schemaResult || await runPostMigrationAction(action);
    markAndPersistItem(item, result.ok ? 'succeeded' : 'failed', {
      error: result.ok ? undefined : result.error,
      warnings: result.ok && result.warning ? [result.warning] : undefined,
      details: schemaResult
        ? {
          ...(item.details || {}),
          migrationMutationTerminal: schemaResult.terminal === true,
          ...(schemaResult.externalJobId ? { migrationMutationExternalJobId: schemaResult.externalJobId } : {}),
        }
        : item.details,
    });
    publishMigrationJobEvent({
      type: 'post-migration',
      jobId: job.id,
      results: { action: action.name, ...result },
      at: Date.now(),
    });
  }
}

interface SchemaRefreshActionResult {
  ok: boolean;
  error?: string;
  warning?: string;
  terminal: boolean;
  externalJobId?: string;
}

function normalizedSchemaRefreshStatus(value?: string): string {
  return (value || 'UNKNOWN').trim().toUpperCase();
}

async function waitForSchemaRefreshJob(
  client: OmniClient,
  externalJobId: string,
): Promise<SchemaRefreshActionResult> {
  const requestedJobId = externalJobId.trim();
  if (!requestedJobId || requestedJobId.length > 1_024) {
    return {
      ok: false,
      terminal: false,
      error: 'The destination schema refresh returned an invalid job identifier; its outcome requires reconciliation.',
    };
  }
  try {
    for (let attempt = 0; attempt < SCHEMA_REFRESH_MAX_POLL_ATTEMPTS; attempt += 1) {
      const statusResult = await client.getJobStatus(requestedJobId);
      if (statusResult.jobId.trim() !== requestedJobId) {
        return {
          ok: false,
          terminal: false,
          externalJobId: requestedJobId,
          error: 'The destination schema refresh status did not match the tracked job; its outcome requires reconciliation.',
        };
      }
      const status = normalizedSchemaRefreshStatus(statusResult.status);
      if (SCHEMA_REFRESH_SUCCESS_STATUSES.has(status)) {
        return {
          ok: true,
          terminal: true,
          externalJobId: requestedJobId,
          warning: `Schema refresh completed (job ${requestedJobId}).`,
        };
      }
      if (SCHEMA_REFRESH_FAILED_STATUSES.has(status)) {
        return {
          ok: false,
          terminal: true,
          externalJobId: requestedJobId,
          error: 'The destination schema refresh finished unsuccessfully.',
        };
      }
      if (attempt + 1 < SCHEMA_REFRESH_MAX_POLL_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, SCHEMA_REFRESH_POLL_INTERVAL_MS));
      }
    }
    return {
      ok: false,
      terminal: false,
      externalJobId: requestedJobId,
      error: 'The destination schema refresh did not reach a terminal state before the bounded monitoring deadline.',
    };
  } catch (error) {
    return {
      ok: false,
      terminal: false,
      externalJobId: requestedJobId,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function runSchemaRefreshAction(
  action: PostMigrationAction,
  onRemotePending?: (externalJobId: string) => void | Promise<void>,
): Promise<SchemaRefreshActionResult> {
  if (!action.destinationInstanceId) return { ok: false, terminal: false, error: 'Schema refresh action is missing a destination instance.' };
  if (!action.targetModelId) return { ok: false, terminal: false, error: 'Schema refresh action is missing a target model.' };
  try {
    const destination = requireModelMigrationInstance(action.destinationInstanceId, 'destination');
    const client = new OmniClient(destination);
    const result = await client.refreshModel(action.targetModelId);
    const initialStatus = normalizedSchemaRefreshStatus(result.status);
    if (SCHEMA_REFRESH_SUCCESS_STATUSES.has(initialStatus)) {
      return {
        ok: true,
        terminal: true,
        externalJobId: result.jobId,
        warning: result.jobId ? `Schema refresh completed (job ${result.jobId}).` : 'Schema refresh completed.',
      };
    }
    if (SCHEMA_REFRESH_FAILED_STATUSES.has(initialStatus)) {
      return {
        ok: false,
        terminal: true,
        externalJobId: result.jobId,
        error: 'The destination schema refresh finished unsuccessfully.',
      };
    }
    if (!result.jobId?.trim()) {
      return {
        ok: false,
        terminal: false,
        error: 'The destination schema refresh was accepted without a trackable job identifier; its outcome requires reconciliation.',
      };
    }
    await onRemotePending?.(result.jobId);
    return waitForSchemaRefreshJob(client, result.jobId);
  } catch (error) {
    return {
      ok: false,
      terminal: false,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function runTrackedSchemaRefresh(
  destinationInstanceId: string,
  targetModelId: string,
  targetModelName?: string,
): Promise<SchemaRefreshActionResult & { trackingJobId: string }> {
  const destination = requireModelMigrationInstance(destinationInstanceId, 'destination');
  const scope = { destinationInstanceId: destination.id, targetModelId: targetModelId.trim() };
  if (!scope.targetModelId) {
    throw Object.assign(new Error('Schema refresh requires an exact target model id.'), { statusCode: 400 });
  }
  if (hasUnresolvedMigrationDestinationModelMutation(listStoredJobs(Number.MAX_SAFE_INTEGER), [scope])) {
    throw new MigrationScopeReservationError();
  }
  const jobId = randomUUID();
  const owner = `schema-refresh:${jobId}`;
  const release = reserveMigrationDestinationModels(owner, [scope]);
  let retainReservation = false;
  const action: PostMigrationAction = {
    kind: 'refresh-schema',
    name: `Refresh ${targetModelName || scope.targetModelId}`,
    method: 'POST',
    url: '',
    headers: {},
    body: '',
    destinationInstanceId: destination.id,
    targetModelId: scope.targetModelId,
    targetModelName,
  };
  const item: MigrationJobItem = {
    id: randomUUID(),
    jobId,
    destinationId: destination.id,
    destinationLabel: destination.label,
    targetModelId: scope.targetModelId,
    targetModelName,
    kind: 'post_action',
    documentName: action.name,
    status: 'pending',
    details: { migrationMutationActionKind: 'refresh-schema' },
  };
  const job: MigrationJob = {
    id: jobId,
    workflow: 'model',
    sourceId: destination.id,
    sourceLabel: destination.label,
    destinationIds: [destination.id],
    targets: [{
      id: `${destination.id}:${scope.targetModelId}`,
      destinationInstanceId: destination.id,
      destinationLabel: destination.label,
      targetModelId: scope.targetModelId,
      targetModelName,
    }],
    documentIds: [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [sanitizePostMigrationAction(action)],
    status: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
    details: {
      operationMode: 'schema_refresh',
      targetId: destination.id,
      targetModelId: scope.targetModelId,
    },
    items: [item],
  };
  let leaseIds: ReadonlySet<string> = new Set();
  try {
    insertJob(job);
    leaseIds = beginDestinationModelMutation(job, [scope], 'schema_refresh');
    markAndPersistItem(item, 'running');
    dispatchDestinationModelMutationForItem(item);
    const result = await runSchemaRefreshAction(action, async (externalJobId) => {
      attachExternalJobToDestinationModelMutation(job, scope, externalJobId, item.id);
    });
    markAndPersistItem(item, result.ok ? 'succeeded' : 'failed', {
      error: result.ok ? undefined : result.error,
      warnings: result.ok && result.warning ? [result.warning] : undefined,
      details: {
        ...(item.details || {}),
        migrationMutationTerminal: result.terminal,
        ...(result.externalJobId ? { migrationMutationExternalJobId: result.externalJobId } : {}),
      },
    });
    const state: MigrationDestinationModelMutationState = result.terminal ? 'resolved' : 'uncertain';
    finishDestinationModelMutation(job, leaseIds, state, result.externalJobId);
    retainReservation = state === 'uncertain';
    job.status = result.ok ? 'succeeded' : 'failed';
    job.endedAt = Date.now();
    persistJobStatus(job);
    return { ...result, trackingJobId: job.id };
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    if (item.status === 'pending') {
      markItem(item, 'failed', { error: message, details: { migrationMutationTerminal: true } });
      persistItem(item);
    } else {
      markAndPersistItem(item, 'failed', {
        error: message,
        details: { ...(item.details || {}), migrationMutationTerminal: false },
      });
    }
    if (leaseIds.size > 0) {
      retainReservation = finalizeDestinationModelMutations(job, leaseIds);
    }
    job.status = 'failed';
    job.endedAt = Date.now();
    persistJobStatus(job);
    return { ok: false, terminal: false, error: message, trackingJobId: job.id };
  } finally {
    if (!retainReservation) release();
  }
}

function mutationReservationOwner(job: MigrationJob, operation: string): string {
  if (operation === 'schema_refresh') return `schema-refresh:${job.id}`;
  if (operation === 'scratch_validation') return `scratch-validation:${job.id}`;
  if (operation === 'model_merge') return `model-merge:${job.id}`;
  return `${job.workflow === 'model' ? 'model-job' : 'legacy-dashboard-job'}:${job.id}`;
}

function scratchValidationBranchName(job: MigrationJob): string | undefined {
  const value = job.details?.migrationMutationBranchName;
  return typeof value === 'string' && /^omnikit-validate-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function scratchValidationBranchId(job: MigrationJob): string | undefined {
  const branchCreateItems = job.items.filter((item) => item.kind === 'model_branch_create');
  if (branchCreateItems.length !== 1) return undefined;
  const value = branchCreateItems[0].details?.migrationMutationBranchId;
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 1_024
    && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value
    : undefined;
}

async function reconcileScratchValidationLease(jobId: string, itemId: string): Promise<void> {
  const reconciliationKey = `${jobId}:${itemId}`;
  if (activeSchemaRefreshReconciliations.has(reconciliationKey)) return;
  activeSchemaRefreshReconciliations.add(reconciliationKey);
  try {
    const job = getJob(jobId);
    const item = job?.items.find((candidate) => candidate.id === itemId);
    const lease = item ? migrationDestinationModelMutationLease(item) : undefined;
    const branchName = job ? scratchValidationBranchName(job) : undefined;
    const branchId = job ? scratchValidationBranchId(job) : undefined;
    if (
      !job
      || !lease
      || lease.operation !== 'scratch_validation'
      || !branchName
      || !branchId
      || (lease.state !== 'dispatched' && lease.state !== 'uncertain')
    ) return;
    const destination = requireModelMigrationInstance(lease.destinationInstanceId, 'destination');
    const client = new OmniClient(destination);
    const branches = await client.listModels('BRANCH');
    const exactBranches = branches.filter((branch) => branch.id === branchId);
    if (exactBranches.length > 1) return;
    const branch = exactBranches[0];
    if (branch) {
      if (branch.baseModelId !== lease.targetModelId || branch.name !== branchName) return;
      const sameNameBranches = branches.filter((candidate) => (
        candidate.baseModelId === lease.targetModelId
        && candidate.name === branchName
      ));
      if (sameNameBranches.length !== 1 || sameNameBranches[0].id !== branchId) return;
      await client.deleteModelBranch(lease.targetModelId, branch.name);
    }
    const remaining = (await client.listModels('BRANCH')).filter((candidate) => candidate.id === branchId);
    if (remaining.length !== 0) return;
    const latest = getJob(jobId) || job;
    for (const workItem of latest.items) {
      if (
        workItem.kind !== 'model_branch_create'
        && workItem.kind !== 'model_yaml_write'
        && workItem.kind !== 'model_branch_delete'
      ) continue;
      if (workItem.status !== 'pending' && workItem.status !== 'running') continue;
      markItem(workItem, workItem.kind === 'model_branch_delete' ? 'succeeded' : 'failed', {
        error: workItem.kind === 'model_branch_delete'
          ? undefined
          : 'Scratch validation was interrupted; its exact branch was removed during reconciliation.',
        details: {
          ...(workItem.details || {}),
          migrationMutationTerminal: true,
        },
      });
      persistItem(workItem);
    }
    latest.status = 'failed';
    latest.endedAt = Date.now();
    latest.details = {
      ...(latest.details || {}),
      scratchCleanupState: 'resolved_after_restart',
    };
    persistJobStatus(latest);
    finishDestinationModelMutation(latest, new Set([itemId]), 'resolved');
  } catch {
    // Exact scratch cleanup remains owned and can be retried on the next unlock.
  } finally {
    activeSchemaRefreshReconciliations.delete(reconciliationKey);
  }
}

async function reconcileTrackedSchemaRefreshLease(jobId: string, itemId: string): Promise<void> {
  const reconciliationKey = `${jobId}:${itemId}`;
  if (activeSchemaRefreshReconciliations.has(reconciliationKey)) return;
  activeSchemaRefreshReconciliations.add(reconciliationKey);
  let release: (() => void) | undefined;
  let retainReservation = true;
  try {
    const job = getJob(jobId);
    const item = job?.items.find((candidate) => candidate.id === itemId);
    const lease = item ? migrationDestinationModelMutationLease(item) : undefined;
    const dispatchItem = job && lease?.dispatchItemId
      ? job.items.find((candidate) => candidate.id === lease.dispatchItemId)
      : undefined;
    if (
      !job
      || !lease?.externalJobId
      || lease.dispatchItemKind !== 'post_action'
      || !dispatchItem
      || dispatchItem.kind !== 'post_action'
      || dispatchItem.details?.migrationMutationActionKind !== 'refresh-schema'
      || dispatchItem.destinationId !== lease.destinationInstanceId
      || dispatchItem.targetModelId !== lease.targetModelId
      || (lease.state !== 'dispatched' && lease.state !== 'remote_pending' && lease.state !== 'uncertain')
    ) return;
    const destination = requireModelMigrationInstance(lease.destinationInstanceId, 'destination');
    release = reserveMigrationDestinationModels(mutationReservationOwner(job, lease.operation), [lease]);
    const result = await waitForSchemaRefreshJob(new OmniClient(destination), lease.externalJobId);
    const latest = getJob(jobId) || job;
    if (!result.terminal) {
      finishDestinationModelMutation(latest, new Set([itemId]), 'uncertain', lease.externalJobId);
      return;
    }
    const latestActionItem = latest.items.find((candidate) => candidate.id === dispatchItem.id);
    if (!latestActionItem) return;
    markItem(latestActionItem, result.ok ? 'succeeded' : 'failed', {
      error: result.ok ? undefined : result.error,
      warnings: result.ok && result.warning ? [result.warning] : undefined,
      details: {
        ...(latestActionItem.details || {}),
        migrationMutationTerminal: true,
        migrationMutationExternalJobId: lease.externalJobId,
      },
    });
    persistItem(latestActionItem);
    if (latest.details?.operationMode === 'schema_refresh') {
      latest.status = result.ok ? 'succeeded' : 'failed';
      latest.endedAt = Date.now();
      persistJobStatus(latest);
    }
    const persistedLatest = getJob(jobId) || latest;
    finishDestinationModelMutation(persistedLatest, new Set([itemId]), 'resolved', lease.externalJobId);
    retainReservation = false;
  } catch {
    // The durable lease remains unresolved; another unlock can retry the exact remote job read.
  } finally {
    if (!retainReservation) release?.();
    activeSchemaRefreshReconciliations.delete(reconciliationKey);
  }
}

export function resumeDestinationModelMutationReconciliation(): string[] {
  const resumed: string[] = [];
  for (const job of listStoredJobs(Number.MAX_SAFE_INTEGER)) {
    for (const item of job.items) {
      const lease = migrationDestinationModelMutationLease(item);
      if (
        lease?.operation === 'scratch_validation'
        && (lease.state === 'dispatched' || lease.state === 'uncertain')
      ) {
        resumed.push(`${job.id}:${item.id}`);
        void reconcileScratchValidationLease(job.id, item.id);
        continue;
      }
      if (
        !lease?.externalJobId
        || (lease.state !== 'dispatched' && lease.state !== 'remote_pending' && lease.state !== 'uncertain')
      ) continue;
      resumed.push(`${job.id}:${item.id}`);
      void reconcileTrackedSchemaRefreshLease(job.id, item.id);
    }
  }
  return resumed;
}

export async function runPostMigrationAction(action: PostMigrationAction): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (action.kind === 'refresh-schema') {
    if (!action.destinationInstanceId || !action.targetModelId) {
      return { ok: false, error: 'Schema refresh action is missing its exact destination model scope.' };
    }
    return runTrackedSchemaRefresh(action.destinationInstanceId, action.targetModelId, action.targetModelName);
  }
  if (action.method.toUpperCase() !== 'GET') {
    return {
      ok: false,
      error: 'Mutating webhook post-actions are disabled because their remote outcome cannot be reconciled safely after a lost response.',
    };
  }
  const validationError = await validatePostMigrationActionTargetForRequest(action);
  if (validationError) return { ok: false, error: validationError };
  if (action.destinationInstanceId) {
    try {
      requireModelMigrationInstance(action.destinationInstanceId, 'destination');
    } catch {
      return { ok: false, error: 'Post-migration action skipped because destination authority changed.' };
    }
  }

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
