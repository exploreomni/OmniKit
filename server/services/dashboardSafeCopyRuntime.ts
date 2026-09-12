import { createHash, randomUUID } from 'node:crypto';

import {
  DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS,
  DASHBOARD_SAFE_COPY_PROFILE,
  DashboardSafeCopyError,
  type DashboardSafeCopyDestination,
  type DashboardSafeCopyIntent,
  canonicalDashboardSafeCopyIntent,
  parseDashboardSafeCopyIntent,
  scopeDashboardSafeCopyIntent,
} from '../../shared/dashboardSafeCopyContract';
import {
  executeDashboardSafeCopy,
  retryDashboardSafeCopyTarget,
  type DashboardSafeCopyAttemptEvidence,
  type DashboardSafeCopyAttemptReconciliation,
  type DashboardSafeCopyDocumentResult,
  type DashboardSafeCopyDispatchGuard,
  type DashboardSafeCopyExecutionInput,
  type DashboardSafeCopyExecutionResult,
  type DashboardSafeCopyExecutionException,
  type DashboardSafeCopyExecutionExceptionCode,
  type DashboardSafeCopyExecutionTarget,
  type DashboardSafeCopyExecutorDependencies,
  type DashboardSafeCopyLiveDocument,
  type DashboardSafeCopyPersistedDocumentReconciliation,
  type DashboardSafeCopyPreparedDocument,
  type DashboardSafeCopyReprovedTarget,
  type DashboardSafeCopyScopeInventory,
  type DashboardSafeCopyTargetResult,
  type DashboardSafeCopyTargetState,
  type DashboardSafeCopyVerifiedProvenance,
  type DashboardSafeCopyWriteFailure,
} from './dashboardSafeCopyExecutor';
import {
  releaseMigrationDestinationModels,
  releaseMigrationDestinationModelsByPrefix,
  reserveMigrationDestinationModels,
  hasUnresolvedMigrationDestinationModelMutation,
} from './migrationScopeReservation';
import {
  assertDashboardSafeCopyInstanceRoles,
  isDashboardSafeCopyJob,
  dashboardSafeCopyIntentHash,
} from './dashboardSafeCopyJobs';
import {
  dashboardSafeCopySemanticPatchProofHash,
  dashboardSafeCopyTargetDecisionFingerprint,
  prepareDashboardSafeCopyJob,
  prepareDashboardSafeCopyTargets,
  type DashboardSafeCopyPreparedTarget,
} from './dashboardSafeCopyPreparation';
import { materializeDashboardSafeCopyDocumentContent } from './dashboardSafeCopyContent';
import {
  assertDashboardSafeCopyLiveQuerySet,
  deriveDashboardSafeCopyExecutableQuerySet,
  proveDashboardSafeCopyQueryExecutions,
  type DashboardSafeCopyExecutableQuerySet,
} from './dashboardSafeCopyQueryProof';
import { publishMigrationJobEvent } from './jobEvents';
import { redactSensitiveText } from './jobSanitizer';
import {
  getJob,
  listJobs as listStoredJobs,
  updateJobAtomically,
} from './jobStore';
import {
  materializeDashboardSafeCopyDocument,
  type MigrationJob,
  type MigrationJobItem,
  type MigrationSemanticPatch,
  type MigrationTarget,
} from './migrationJobs';
import {
  OmniClient,
  OmniClientError,
  OmniWriteNotDispatchedError,
  type OmniDocumentAccessInventoryResult,
  type OmniDocumentInventoryResult,
  type OmniQueryExecutionSummary,
} from './omniClient';
import { getInstance, type SavedInstance } from './nativeVault';
import { dashboardWorkbookHasAuthoredDefinitions, getDashboardWorkbookCopyCapability } from './dashboardWorkbookCopy';

const SAFE_COPY_RUNTIME_VERSION = 1;
const SAFE_COPY_VERIFIER_VERSION = 1;
const MAX_SCOPE_DOCUMENTS = 1_000;
const MAX_ATTEMPT_PREEXISTING_DOCUMENT_IDS = 32;
const MAX_CLIENT_EVIDENCE_ATTEMPTS = 3_000;
const MAX_CLIENT_EVIDENCE_ITEMS = 6_000;
const DOCUMENT_STATE_CONCURRENCY = 4;
const DEFAULT_RUNTIME_TARGET_DEADLINE_MS = 120_000;
const SAFE_COPY_VERIFIED_PROVENANCE_KEYS = new Set([
  'profile',
  'resolverVersion',
  'verifierVersion',
  'jobId',
  'attemptId',
  'targetId',
  'sourceInstanceId',
  'sourceConnectionId',
  'sourceDocumentId',
  'sourceExportHash',
  'destinationInstanceId',
  'connectionId',
  'modelId',
  'folderId',
  'folderPath',
  'importedDocumentId',
  'importedIdentifier',
  'chosenName',
  'expectedPayloadHash',
  'publishedFingerprint',
  'finalVerification',
  'documentWriteMode',
  'verifiedAt',
]);
const SAFE_COPY_ATTEMPT_DETAIL_KEYS = new Set([
  'safeCopyAttempt',
  'safeCopyAttemptId',
  'safeCopyAttemptState',
  'safeCopyAttemptOperation',
  'safeCopyAttemptFingerprint',
  'safeCopyDestinationInstanceId',
  'safeCopyConnectionId',
  'safeCopyModelId',
  'safeCopyFolderId',
  'safeCopyFolderPath',
  'safeCopySourceDocumentId',
  'safeCopyChosenName',
  'safeCopySourceExportHash',
  'safeCopyExpectedPayloadHash',
  'safeCopyFileName',
  'safeCopyPreviousChecksum',
  'safeCopyExpectedYamlHash',
  'safeCopyPreexistingDocumentIds',
  'safeCopyImportedDocumentId',
  'safeCopyImportedIdentifier',
  'safeCopyPublishedFingerprint',
  'safeCopyVerificationStartedAt',
  'safeCopyVerifierVersion',
  'safeCopyVerifiedAt',
  'safeCopyAttemptCreatedAt',
  'safeCopyAttemptUpdatedAt',
]);

type SafeCopyRuntimeClient = Pick<OmniClient,
  | 'listFolderInventory'
  | 'listDocumentInventory'
  | 'getDocumentStateV2'
  | 'runQuery'
  | 'getModelYaml'
  | 'updateModelYamlFile'
  | 'listDocumentAccessInventory'
  | 'createDashboardSafeCopyDocument'
>;

export interface DashboardSafeCopyRuntimeServices {
  getJob?: typeof getJob;
  updateJobAtomically?: (
    jobId: string,
    reducer: (current: MigrationJob) => MigrationJob,
  ) => MigrationJob | undefined;
  publishMigrationJobEvent?: typeof publishMigrationJobEvent;
  getInstance?: typeof getInstance;
  createClient?: (instance: SavedInstance) => SafeCopyRuntimeClient;
  prepareJob?: typeof prepareDashboardSafeCopyJob;
  prepareTargets?: typeof prepareDashboardSafeCopyTargets;
  execute?: typeof executeDashboardSafeCopy;
  retryTarget?: typeof retryDashboardSafeCopyTarget;
  now?: () => number;
  randomId?: () => string;
  targetDeadlineMs?: number;
}

export interface DashboardSafeCopyRuntimeResult {
  job: MigrationJob;
  execution?: DashboardSafeCopyExecutionResult;
}

interface RuntimeAuthorization {
  intent: DashboardSafeCopyIntent;
  jobId: string;
  prepared: DashboardSafeCopyPreparedTarget;
  targetInput: DashboardSafeCopyExecutionTarget;
  sourceInstance: SavedInstance;
  destinationInstance: SavedInstance;
}

interface RuntimeContext {
  intent: DashboardSafeCopyIntent;
  jobId: string;
  job: MigrationJob;
  services: Required<Pick<DashboardSafeCopyRuntimeServices,
    | 'getJob'
    | 'updateJobAtomically'
    | 'publishMigrationJobEvent'
    | 'getInstance'
    | 'createClient'
    | 'prepareTargets'
    | 'execute'
    | 'retryTarget'
    | 'now'
    | 'randomId'
  >> & Pick<DashboardSafeCopyRuntimeServices, 'targetDeadlineMs'>;
  clients: Map<string, SafeCopyRuntimeClient>;
  expectedQuerySets: Map<string, DashboardSafeCopyExecutableQuerySet>;
}

class SafeCopyRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly writeFailure: DashboardSafeCopyWriteFailure = 'uncertain',
  ) {
    super(message);
    this.name = 'SafeCopyRuntimeError';
  }
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalText(value: string | undefined): string {
  return (value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
  );
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

/** Hash the complete JSON snapshot, sorting object keys and preserving array order. */
export function dashboardSafeCopyStateHash(value: unknown): string {
  return sha256(value);
}

function contentFingerprint(value: unknown): string {
  const content = materializeDashboardSafeCopyDocumentContent(value);
  const contentWithoutName = Object.fromEntries(
    Object.entries(content).filter(([key]) => key !== 'name'),
  );
  return sha256(contentWithoutName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detailsString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return clean(value?.[key]);
}

function detailsNumber(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function boundedEvidenceText(value: string | undefined, maxLength = 256): boolean {
  return Boolean(value)
    && (value?.length || 0) <= maxLength
    && ![...(value || '')].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

function boundedExceptionDetails(result: DashboardSafeCopyTargetResult): Record<string, unknown> {
  const exceptionCodes = result.exceptions.map((issue) => issue.code);
  const canSelectTargetModel = exceptionCodes.includes('SEMANTIC_CHANGE_UNSAFE');
  const canOpenModelMigrator = exceptionCodes.some((code) => (
    code === 'SEMANTIC_CHANGE_UNSAFE' || code === 'SEMANTIC_APPLY_FAILED'
  ));
  return {
    safeCopyTargetExecutionSummary: true,
    safeCopyTargetStatus: result.status,
    safeCopyExceptionCodes: exceptionCodes,
    safeCopyRecommendedActions: [
      ...(canSelectTargetModel ? ['select_target_model'] : []),
      ...(canOpenModelMigrator ? ['open_model_migrator'] : []),
    ],
    safeCopyDocuments: result.documents.map((document) => ({
      sourceDocumentId: document.sourceDocumentId,
      status: document.status,
      ...(document.chosenName ? { chosenName: document.chosenName } : {}),
      ...(document.importedDocumentId ? { importedDocumentId: document.importedDocumentId } : {}),
      ...(document.importedIdentifier ? { importedIdentifier: document.importedIdentifier } : {}),
      ...(document.sourceExportHash ? { sourceExportHash: document.sourceExportHash } : {}),
      ...(document.expectedPayloadHash ? { expectedPayloadHash: document.expectedPayloadHash } : {}),
      ...(document.publishedFingerprint ? { publishedFingerprint: document.publishedFingerprint } : {}),
      ...(document.exception ? { exceptionCode: document.exception.code } : {}),
    })),
  };
}

const SAFE_COPY_EXCEPTION_MESSAGES: Record<DashboardSafeCopyExecutionExceptionCode, string> = {
  DUPLICATE_DESTINATION_SCOPE: 'The destination was selected more than once.',
  TARGET_REPROOF_FAILED: 'The destination could not be revalidated against its saved scope.',
  TARGET_EXECUTION_FAILED: 'The destination stopped before its next write could be safely dispatched.',
  SOURCE_SNAPSHOT_CHANGED: 'The source dashboard changed after approval. Rerun compatibility checks.',
  SOURCE_MODEL_SNAPSHOT_CHANGED: 'A source model changed after approval. Rerun compatibility checks.',
  MODEL_SNAPSHOT_CHANGED: 'The destination model changed after approval. Rerun compatibility checks.',
  REPAIR_REQUIRED: 'Repair dependencies in Model Migrator, then rerun compatibility checks.',
  WORKBOOK_COPY_CAPABILITY_UNVERIFIED: 'Workbook-local copying is blocked until complete staging-folder access and a production adapter are verified. Keep local definitions in their source workbook; do not promote them to the shared model.',
  SEMANTIC_CHANGE_UNSAFE: 'The destination model requires a change outside the automatic safe-copy policy.',
  SEMANTIC_APPLY_FAILED: 'The checksum-protected model update could not be completed safely.',
  SEMANTIC_OUTCOME_UNCERTAIN: 'A previous model update still requires exact reconciliation.',
  DOCUMENT_PREPARATION_FAILED: 'The source dashboard could not be prepared as a content-only copy.',
  CONTENT_SECURITY_UNSAFE: 'The dashboard contains content outside the safe-copy allowlist.',
  IMPORT_FAILED: 'The destination did not accept a safely verified dashboard copy.',
  IMPORT_UNCERTAIN: 'A dashboard create outcome requires exact reconciliation.',
  FINAL_VERIFICATION_FAILED: 'The copied dashboard did not pass final verification.',
  TARGET_DEADLINE_EXCEEDED: 'The destination exceeded its bounded execution deadline.',
  TARGET_ALREADY_COMPLETE: 'This destination is already complete.',
  RETRY_EVIDENCE_MISSING: 'The destination retry evidence is incomplete or no longer matches.',
  RETRY_REQUEST_DUPLICATE: 'This destination retry request was already accepted.',
  RETRY_REQUEST_CONFLICT: 'This destination retry conflicts with existing retry evidence.',
  RETRY_REQUEST_INVALID: 'The destination retry request was not accepted.',
};

function sanitizeExecutionException(
  issue: DashboardSafeCopyExecutionException,
  targetId: string,
): DashboardSafeCopyExecutionException {
  const code = Object.hasOwn(SAFE_COPY_EXCEPTION_MESSAGES, issue.code)
    ? issue.code
    : 'TARGET_EXECUTION_FAILED';
  return {
    code,
    targetId,
    message: SAFE_COPY_EXCEPTION_MESSAGES[code],
    retryable: code === 'TARGET_EXECUTION_FAILED' ? true : issue.retryable === true,
    ...(clean(issue.sourceDocumentId) ? { sourceDocumentId: clean(issue.sourceDocumentId) } : {}),
  };
}

function sanitizeTargetResult(result: DashboardSafeCopyTargetResult): DashboardSafeCopyTargetResult {
  const exceptions = result.exceptions.map((issue) => sanitizeExecutionException(issue, result.targetId));
  return {
    ...result,
    exceptions,
    documents: result.documents.map((document) => ({
      ...document,
      ...(document.exception
        ? { exception: sanitizeExecutionException(document.exception, result.targetId) }
        : {}),
    })),
  };
}

function defaultServices(
  services: DashboardSafeCopyRuntimeServices,
): RuntimeContext['services'] {
  return {
    getJob: services.getJob || getJob,
    updateJobAtomically: services.updateJobAtomically || updateJobAtomically,
    publishMigrationJobEvent: services.publishMigrationJobEvent || publishMigrationJobEvent,
    getInstance: services.getInstance || getInstance,
    createClient: services.createClient || ((instance) => new OmniClient(instance)),
    prepareTargets: services.prepareTargets || prepareDashboardSafeCopyTargets,
    execute: services.execute || executeDashboardSafeCopy,
    retryTarget: services.retryTarget || retryDashboardSafeCopyTarget,
    now: services.now || Date.now,
    randomId: services.randomId || randomUUID,
    targetDeadlineMs: services.targetDeadlineMs,
  };
}

function publishStoredJob(context: RuntimeContext, jobId: string): MigrationJob | undefined {
  const stored = context.services.getJob(jobId);
  if (!stored) return undefined;
  context.services.publishMigrationJobEvent({
    type: 'job',
    jobId,
    status: stored.status,
    at: context.services.now(),
    job: stored,
  });
  return stored;
}

function publishStoredItem(context: RuntimeContext, itemId: string): void {
  const stored = context.services.getJob(context.jobId);
  const item = stored?.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  context.services.publishMigrationJobEvent({
    type: 'item',
    jobId: context.jobId,
    itemId,
    destinationId: item.destinationId,
    status: item.status,
    error: item.error,
    at: context.services.now(),
    item,
  });
}

function clientFor(context: RuntimeContext, instance: SavedInstance): SafeCopyRuntimeClient {
  const key = `${instance.id}\u0000${sha256({ baseUrl: instance.baseUrl, apiKey: instance.apiKey })}`;
  const existing = context.clients.get(key);
  if (existing) return existing;
  const client = context.services.createClient(instance);
  context.clients.set(key, client);
  return client;
}

function requiredInstance(
  context: RuntimeContext,
  instanceId: string,
): SavedInstance {
  const instance = context.services.getInstance(instanceId);
  if (!instance) throw new SafeCopyRuntimeError('SAFE_COPY_INSTANCE_NOT_FOUND', 'A selected saved instance is no longer available.');
  return instance;
}

function sameCredentialBoundary(left: SavedInstance, right: SavedInstance): boolean {
  return left.id === right.id
    && left.baseUrl === right.baseUrl
    && left.apiKey === right.apiKey;
}

function assertCurrentWriteAuthority(
  context: RuntimeContext,
  auth: RuntimeAuthorization,
): SavedInstance {
  try {
    const scopedIntent = intentForTarget(context.intent, auth.targetInput.targetId);
    assertDashboardSafeCopyInstanceRoles(scopedIntent, context.services.getInstance);
    const currentSource = requiredInstance(context, auth.sourceInstance.id);
    const currentDestination = requiredInstance(context, auth.destinationInstance.id);
    if (
      !sameCredentialBoundary(currentSource, auth.sourceInstance)
      || !sameCredentialBoundary(currentDestination, auth.destinationInstance)
    ) {
      throw new Error('saved instance credential boundary changed');
    }
    return currentDestination;
  } catch {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_WRITE_AUTHORITY_CHANGED',
      'Saved-instance authority changed before the destination write.',
      'definitely_not_committed',
    );
  }
}

function folderPathMatches(expected: string | undefined, actual: string | undefined): boolean {
  return canonicalText(expected) === canonicalText(actual);
}

async function canonicalDestination(
  context: RuntimeContext,
  destination: DashboardSafeCopyDestination,
): Promise<DashboardSafeCopyExecutionTarget> {
  const scopedIntent = intentForTarget(context.intent, destination.targetId);
  assertDashboardSafeCopyInstanceRoles(scopedIntent, context.services.getInstance);
  const destinationInstance = requiredInstance(context, destination.instanceId);
  const client = clientFor(context, destinationInstance);
  let folderId = clean(destination.folderId);
  let folderPath = clean(destination.folderPath);
  if (folderId || folderPath) {
    const inventory = await client.listFolderInventory();
    if (inventory.pagination.complete !== true) {
      throw new SafeCopyRuntimeError('SAFE_COPY_FOLDER_INVENTORY_INCOMPLETE', 'Destination folder inventory is incomplete.');
    }
    const matches = inventory.folders.filter((folder) => (
      (!folderId || folder.id === folderId)
      && (!folderPath || folderPathMatches(folderPath, folder.path || folder.identifier || folder.name))
    ));
    if (matches.length !== 1) {
      throw new SafeCopyRuntimeError('SAFE_COPY_FOLDER_SCOPE_UNRESOLVED', 'Destination folder scope could not be resolved exactly.');
    }
    folderId = matches[0].id;
    folderPath = clean(matches[0].path || matches[0].identifier || folderPath);
    if (folderPath && redactSensitiveText(folderPath) !== folderPath) {
      throw new SafeCopyRuntimeError(
        'SAFE_COPY_FOLDER_SCOPE_UNSAFE',
        'Destination folder scope cannot be stored as exact non-secret reconciliation evidence.',
        'definitely_not_committed',
      );
    }
  }
  return {
    targetId: destination.targetId,
    sourceInstanceId: context.intent.source.instanceId,
    sourceConnectionId: context.intent.source.connectionId,
    destinationInstanceId: destination.instanceId,
    connectionId: destination.connectionId,
    modelId: destination.modelId,
    ...(folderId ? { folderId } : {}),
    ...(folderPath ? { folderPath } : {}),
    sourceDocumentIds: [...context.intent.source.documentIds],
    ...(context.intent.deployment ? { contentOnly: true as const } : {}),
    ...(destination.workbookCopy ? { workbookCopy: { ...destination.workbookCopy } } : {}),
  };
}

function preparationSummary(
  job: MigrationJob,
  targetId: string,
): MigrationJobItem | undefined {
  const matches = job.items.filter((item) => (
    item.targetId === targetId
    && item.details?.safeCopyPreparationSummary === true
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

function intentForTarget(
  intent: DashboardSafeCopyIntent,
  targetId: string,
): DashboardSafeCopyIntent {
  const destination = intent.destinations.find((candidate) => candidate.targetId === targetId);
  if (!destination) {
    throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_MISSING', 'The destination is outside the canonical safe-copy request.');
  }
  return scopeDashboardSafeCopyIntent(intent, new Set([targetId]));
}

function preparedTargetScopeMatches(
  prepared: DashboardSafeCopyPreparedTarget,
  target: DashboardSafeCopyExecutionTarget,
): boolean {
  return prepared.targetId === target.targetId
    && prepared.target.id === target.targetId
    && prepared.target.destinationInstanceId === target.destinationInstanceId
    && prepared.target.targetConnectionId === target.connectionId
    && prepared.target.targetModelId === target.modelId
    && (clean(prepared.target.targetFolderId) || '') === (clean(target.folderId) || '')
    && canonicalText(prepared.target.targetFolderPath) === canonicalText(target.folderPath);
}

function writePatches(target: MigrationTarget): MigrationSemanticPatch[] {
  return (target.semanticPatches || []).filter((patch) => patch.resolution !== 'keep_target');
}

function semanticChangeForPreparedTarget(
  prepared: DashboardSafeCopyPreparedTarget,
): DashboardSafeCopyReprovedTarget['semanticChange'] {
  const patches = writePatches(prepared.target);
  if (patches.length === 0) return { mode: 'none' };
  if (patches.length !== 1) return { mode: 'unsafe', reason: 'multiple_files' };
  const patch = patches[0];
  const acceptedYaml = clean(patch.acceptedYaml);
  const previousChecksum = clean(patch.previousChecksum);
  const fileName = clean(patch.targetFileName);
  if (patch.safetyCategory === 'safe_create') return { mode: 'unsafe', reason: 'new_file' };
  if (!acceptedYaml || !fileName || redactSensitiveText(fileName) !== fileName) {
    return { mode: 'unsafe', reason: 'unsupported' };
  }
  if (!previousChecksum) return { mode: 'unsafe', reason: 'missing_checksum' };
  return {
    mode: 'existing_file_update',
    fileName,
    previousChecksum,
    expectedYamlHash: sha256(acceptedYaml),
  };
}

function preparedTargetMatchesPersistedSummary(
  context: RuntimeContext,
  prepared: DashboardSafeCopyPreparedTarget,
): boolean {
  const latest = context.services.getJob(context.jobId);
  const summary = latest && preparationSummary(latest, prepared.targetId);
  return Boolean(
    latest
    && isDashboardSafeCopyJob(latest)
    && summary
    && summary.status === 'succeeded'
    && summary.details?.safeCopyTargetStatus === 'ready'
    && detailsString(summary.details, 'safeCopyDecisionFingerprint') === prepared.decisionFingerprint
    && detailsString(summary.details, 'safeCopyPlanFingerprint') === prepared.planFingerprint
    && detailsNumber(summary.details, 'safeCopyPatchCount') === prepared.patchCount,
  );
}

async function freshPreparedTarget(
  context: RuntimeContext,
  targetInput: DashboardSafeCopyExecutionTarget,
  verifiedSemanticChangeApplied = false,
): Promise<DashboardSafeCopyPreparedTarget> {
  const persistedTarget = context.job.targets?.find((target) => target.id === targetInput.targetId);
  if (!persistedTarget) throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_MISSING', 'The persisted destination target is unavailable.');
  const scopedIntent = intentForTarget(context.intent, targetInput.targetId);
  assertDashboardSafeCopyInstanceRoles(scopedIntent, context.services.getInstance);
  const results = await context.services.prepareTargets(scopedIntent, [persistedTarget]);
  const result = results.length === 1 ? results[0] : undefined;
  if (
    !result
    || result.status !== 'ready'
    || !preparedTargetScopeMatches(result, targetInput)
    || (
      verifiedSemanticChangeApplied
        ? writePatches(result.target).length !== 0
        : !preparedTargetMatchesPersistedSummary(context, result)
    )
  ) {
    throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_REPROOF_FAILED', 'Fresh preparation no longer matches the persisted safe-copy proof.');
  }
  return result;
}

async function reproveImmediatelyBeforeDocumentWrite(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
): Promise<SavedInstance> {
  const auth = runtimeAuthorization(target);
  const semanticRecovery = verifiedSemanticRecoveryForExecution(context, auth.targetInput);
  const persistedTarget = context.job.targets?.find((candidate) => candidate.id === auth.targetInput.targetId);
  if (!persistedTarget) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_TARGET_MISSING',
      'The destination disappeared before the dashboard write.',
      'definitely_not_committed',
    );
  }
  const scopedIntent = intentForTarget(context.intent, auth.targetInput.targetId);
  assertDashboardSafeCopyInstanceRoles(scopedIntent, context.services.getInstance);
  const results = await context.services.prepareTargets(scopedIntent, [persistedTarget]);
  const fresh = results.length === 1 ? results[0] : undefined;
  if (!fresh || fresh.status !== 'ready' || !preparedTargetScopeMatches(fresh, auth.targetInput)) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_DOCUMENT_REPROOF_FAILED',
      'The destination changed before the dashboard write.',
      'definitely_not_committed',
    );
  }
  const originalWrites = writePatches(auth.prepared.target);
  const freshWrites = writePatches(fresh.target);
  const semanticPostconditionIsVerified = semanticRecovery
    ? await reconcileSemanticChange(context, target, semanticRecovery.attempt) === 'verified'
    : false;
  const proofIsStable = semanticRecovery
    ? originalWrites.length === 0
      && freshWrites.length === 0
      && sameSemanticProof(auth.prepared, fresh)
      && semanticPostconditionIsVerified
    : originalWrites.length === 0
      ? sameSemanticProof(auth.prepared, fresh) && preparedTargetMatchesPersistedSummary(context, fresh)
      : originalWrites.length === 1 && freshWrites.length === 0;
  if (!proofIsStable) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_DOCUMENT_REPROOF_CHANGED',
      'The destination dependency proof changed before the dashboard write.',
      'definitely_not_committed',
    );
  }
  return assertCurrentWriteAuthority(context, auth);
}

function authorization(
  context: RuntimeContext,
  targetInput: DashboardSafeCopyExecutionTarget,
  prepared: DashboardSafeCopyPreparedTarget,
): RuntimeAuthorization {
  return {
    intent: context.intent,
    jobId: context.jobId,
    prepared,
    targetInput,
    sourceInstance: requiredInstance(context, context.intent.source.instanceId),
    destinationInstance: requiredInstance(context, targetInput.destinationInstanceId),
  };
}

function runtimeAuthorization(target: DashboardSafeCopyReprovedTarget): RuntimeAuthorization {
  const value = target.authorization;
  if (!isRecord(value) || !('prepared' in value) || !('targetInput' in value)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_AUTHORIZATION_MISSING', 'In-memory safe-copy authorization is unavailable.');
  }
  return value as unknown as RuntimeAuthorization;
}

function documentModelBinding(state: Record<string, unknown>): string | undefined {
  for (const key of ['modelId', 'workbookModelId', 'baseModelId', 'model_id', 'workbook_model_id', 'base_model_id']) {
    const value = clean(state[key]);
    if (value) return value;
  }
  if (isRecord(state.model)) {
    return clean(state.model.id) || clean(state.model.identifier) || clean(state.model.baseModelId);
  }
  return undefined;
}

export const dashboardSafeCopyDocumentModelBinding = documentModelBinding;

/** Legacy/frozen jobs must not bypass workbook scope just because they lack new evidence. */
async function assertWorkbookCopyRuntimeBoundary(
  context: RuntimeContext,
  target: DashboardSafeCopyExecutionTarget,
  documentIds: readonly string[] = target.sourceDocumentIds,
): Promise<void> {
  function unavailable(): never {
    const capability = getDashboardWorkbookCopyCapability();
    throw new SafeCopyRuntimeError(capability.code, capability.message, 'definitely_not_committed');
  }
  if (target.workbookCopy || Object.keys(context.intent.deployment?.workbookCopies || {}).length) {
    unavailable();
  }
  const sourceClient = clientFor(context, requiredInstance(context, context.intent.source.instanceId));
  const signal = AbortSignal.timeout(Math.max(1, Math.min(DEFAULT_RUNTIME_TARGET_DEADLINE_MS,
    (target.deadlineAt ?? context.services.now() + DEFAULT_RUNTIME_TARGET_DEADLINE_MS) - context.services.now())));
  await mapWithConcurrency([...documentIds], DOCUMENT_STATE_CONCURRENCY, async (documentId) => {
    const state = await sourceClient.getDocumentStateV2(documentId, signal).catch(() => unavailable());
    const workbookModelId = clean(state.workbookModelId) || clean(state.workbook_model_id);
    if (!workbookModelId) unavailable(); // Missing identity is not evidence of an empty workbook layer.
    const sharedModelId = clean(state.modelId) || clean(state.baseModelId);
    if (!sharedModelId || workbookModelId === sharedModelId) unavailable();
    try {
      const snapshot = await sourceClient.getModelYaml(workbookModelId, {
        mode: 'extension', fullyResolved: false, includeChecksums: true, signal,
      });
      if (dashboardWorkbookHasAuthoredDefinitions(snapshot.files)) unavailable();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED') throw error;
      // An unreadable extension is not proof that no local definitions exist.
      unavailable();
    }
  });
}

function exactFolderDocument(
  target: DashboardSafeCopyExecutionTarget,
  document: { folderId?: string; folderPath?: string },
): boolean {
  const targetFolderId = clean(target.folderId);
  const documentFolderId = clean(document.folderId);
  if (targetFolderId) return documentFolderId === targetFolderId;
  if (documentFolderId) return false;
  return canonicalText(target.folderPath) === canonicalText(document.folderPath);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return results;
}

async function withRuntimeDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SafeCopyRuntimeError('SAFE_COPY_TARGET_DEADLINE', 'Destination preparation exceeded its bounded deadline.')),
      Math.max(1_000, milliseconds),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function queryProofKey(targetId: string, sourceDocumentId: string): string {
  return `${targetId}\u0000${sourceDocumentId}`;
}

async function proveQueryExecutions(
  client: SafeCopyRuntimeClient,
  querySet: DashboardSafeCopyExecutableQuerySet,
): Promise<void> {
  const evidence: Array<{
    queryId: string;
    queryHash: string;
    summary: OmniQueryExecutionSummary;
  }> = [];
  for (const query of querySet.queries) {
    const summary = await client.runQuery(query.query, {
      cache: 'SkipCache',
      maxWaitAttempts: 12,
      requireExplicitTerminalStatus: true,
    });
    evidence.push({ queryId: query.id, queryHash: query.hash, summary });
  }
  proveDashboardSafeCopyQueryExecutions(querySet, evidence);
}

async function readScopeInventory(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
): Promise<DashboardSafeCopyScopeInventory> {
  const auth = runtimeAuthorization(target);
  const client = clientFor(context, auth.destinationInstance);
  const inventory: OmniDocumentInventoryResult = await client.listDocumentInventory(
    auth.targetInput.folderId ? { folderId: auth.targetInput.folderId } : {},
  );
  if (inventory.pagination.complete !== true || inventory.documents.length > MAX_SCOPE_DOCUMENTS) {
    throw new SafeCopyRuntimeError('SAFE_COPY_DOCUMENT_INVENTORY_INCOMPLETE', 'Destination document inventory is incomplete or exceeds the bounded scope.');
  }
  const scopedRows = inventory.documents.filter((document) => (
    !document.deleted && exactFolderDocument(auth.targetInput, document)
  ));
  const documents = await mapWithConcurrency(
    scopedRows,
    DOCUMENT_STATE_CONCURRENCY,
    async (document): Promise<DashboardSafeCopyLiveDocument> => {
      let modelId = clean(document.baseModelId) || '';
      let fingerprint = sha256({ documentId: document.id, modelId, metadataOnly: true });
      if (!modelId || modelId === auth.targetInput.modelId) {
        try {
          const state = await client.getDocumentStateV2(document.id);
          modelId = documentModelBinding(state) || modelId;
          if (modelId) {
            const materialized = materializeDashboardSafeCopyDocument({
              sourceState: state,
              targetModelId: modelId,
              topicMappings: [],
              queryViewMappings: [],
            });
            fingerprint = contentFingerprint(materialized.content);
          }
        } catch {
          // Metadata remains useful for collision allocation. A row whose state
          // cannot be materialized can never satisfy exact candidate adoption.
        }
      }
      const connectionId = clean(document.connectionId)
        || (modelId === auth.targetInput.modelId ? auth.targetInput.connectionId : 'unknown-connection');
      return {
        destinationInstanceId: auth.targetInput.destinationInstanceId,
        connectionId,
        documentId: document.id,
        identifier: document.identifier,
        name: document.name,
        modelId: modelId || 'unknown-model',
        ...(clean(document.folderId) ? { folderId: document.folderId } : {}),
        ...(clean(document.folderPath) ? { folderPath: document.folderPath } : {}),
        fingerprint,
      };
    },
  );
  return {
    complete: true,
    destinationInstanceId: auth.targetInput.destinationInstanceId,
    connectionId: auth.targetInput.connectionId,
    modelId: auth.targetInput.modelId,
    ...(auth.targetInput.folderId ? { folderId: auth.targetInput.folderId } : {}),
    ...(auth.targetInput.folderPath ? { folderPath: auth.targetInput.folderPath } : {}),
    documents,
  };
}

function acceptedSemanticPatch(prepared: DashboardSafeCopyPreparedTarget): MigrationSemanticPatch | undefined {
  const patches = writePatches(prepared.target);
  return patches.length === 1 ? patches[0] : undefined;
}

function sameSemanticProof(
  left: DashboardSafeCopyPreparedTarget,
  right: DashboardSafeCopyPreparedTarget,
): boolean {
  return left.decisionFingerprint === right.decisionFingerprint
    && left.planFingerprint === right.planFingerprint
    && dashboardSafeCopyTargetDecisionFingerprint(left.target)
      === dashboardSafeCopyTargetDecisionFingerprint(right.target);
}

async function applySemanticChange(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
  guard?: DashboardSafeCopyDispatchGuard,
): Promise<void> {
  if (context.intent.deployment) {
    throw new SafeCopyRuntimeError('SAFE_COPY_REPAIR_REQUIRED', 'Content-only dashboard deployment cannot change model dependencies.', 'definitely_not_committed');
  }
  const auth = runtimeAuthorization(target);
  const fresh = await freshPreparedTarget(context, auth.targetInput);
  if (!sameSemanticProof(auth.prepared, fresh)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_SEMANTIC_REPROOF_CHANGED', 'The destination model changed before the checksum-protected write.');
  }
  const patch = acceptedSemanticPatch(fresh);
  if (
    !patch
    || target.semanticChange.mode !== 'existing_file_update'
    || attempt.operation !== 'semantic_update'
    || attempt.fileName !== target.semanticChange.fileName
    || attempt.previousChecksum !== target.semanticChange.previousChecksum
    || attempt.expectedYamlHash !== target.semanticChange.expectedYamlHash
    || patch.targetFileName !== target.semanticChange.fileName
    || patch.previousChecksum !== target.semanticChange.previousChecksum
    || !clean(patch.acceptedYaml)
    || sha256(patch.acceptedYaml) !== target.semanticChange.expectedYamlHash
  ) {
    throw new SafeCopyRuntimeError('SAFE_COPY_SEMANTIC_PROOF_MISMATCH', 'The checksum-protected model write proof no longer matches.');
  }
  const dispatchDestination = assertCurrentWriteAuthority(context, auth);
  const client = clientFor(context, dispatchDestination);
  assertDispatchIsCurrent(context, auth, guard);
  try {
    await client.updateModelYamlFile({
      modelId: auth.targetInput.modelId,
      fileName: patch.targetFileName,
      yaml: patch.acceptedYaml!,
      previousChecksum: patch.previousChecksum,
      commitMessage: 'Apply verified additive dashboard safe-copy dependency',
    }, { signal: guard?.signal, assertCanDispatch: () => assertDispatchIsCurrent(context, auth, guard) });
  } catch (error) {
    if (error instanceof OmniWriteNotDispatchedError && error.reason instanceof SafeCopyRuntimeError) throw error.reason;
    const definitelyNotCommitted = error instanceof OmniWriteNotDispatchedError || error instanceof OmniClientError
      && [400, 401, 403, 404, 409, 412, 422].includes(error.httpStatus);
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_SEMANTIC_WRITE_FAILED',
      'The checksum-protected model write did not return a verified response.',
      definitelyNotCommitted ? 'definitely_not_committed' : 'uncertain',
    );
  }
}

function assertDispatchIsCurrent(
  context: RuntimeContext,
  auth: RuntimeAuthorization,
  guard?: DashboardSafeCopyDispatchGuard,
): void {
  assertCurrentWriteAuthority(context, auth);
  const current = context.services.getJob(context.jobId);
  if (!current || current.status === 'canceled') {
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_NOT_WRITABLE', 'This deployment no longer permits writes.', 'definitely_not_committed');
  }
  try {
    guard?.assertCanDispatch();
    if (auth.targetInput.deadlineAt !== undefined && context.services.now() >= auth.targetInput.deadlineAt) {
      throw new Error('deadline expired');
    }
  } catch {
    throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_DEADLINE', 'The deployment deadline expired before dispatch.', 'definitely_not_committed');
  }
}

async function recheckDeploymentSnapshots(
  context: RuntimeContext,
  auth: RuntimeAuthorization,
  sourceDocumentId: string,
): Promise<void> {
  const deployment = context.intent.deployment;
  await assertWorkbookCopyRuntimeBoundary(context, auth.targetInput, [sourceDocumentId]);
  if (!deployment) return;
  const [sourceState, targetModel] = await Promise.all([
    clientFor(context, auth.sourceInstance).getDocumentStateV2(sourceDocumentId),
    clientFor(context, auth.destinationInstance).getModelYaml(auth.targetInput.modelId, { includeChecksums: true }),
    mapWithConcurrency(Object.entries(deployment.sourceModelHashes || {}), DOCUMENT_STATE_CONCURRENCY, async ([modelId, expectedHash]) => {
      const snapshot = await clientFor(context, auth.sourceInstance).getModelYaml(modelId, { includeChecksums: true });
      if (dashboardSafeCopyStateHash(snapshot.files) !== expectedHash) {
        throw new SafeCopyRuntimeError('SAFE_COPY_SOURCE_MODEL_DRIFT', 'A source model changed after preflight. Rerun compatibility checks.', 'definitely_not_committed');
      }
    }),
  ]);
  if (dashboardSafeCopyStateHash(sourceState) !== deployment.sourceHashes[sourceDocumentId]) {
    throw new SafeCopyRuntimeError('SAFE_COPY_SOURCE_DRIFT', 'The source dashboard changed after preflight. Rerun compatibility checks.', 'definitely_not_committed');
  }
  if (dashboardSafeCopyStateHash(targetModel.files) !== deployment.modelHashes[auth.targetInput.targetId]) {
    throw new SafeCopyRuntimeError('SAFE_COPY_MODEL_DRIFT', 'The destination model changed after preflight. Rerun compatibility checks.', 'definitely_not_committed');
  }
}

async function reconcileSemanticChange(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
): Promise<DashboardSafeCopyAttemptReconciliation> {
  const auth = runtimeAuthorization(target);
  const fileName = clean(attempt.fileName);
  if (!fileName || !attempt.previousChecksum || !attempt.expectedYamlHash) return 'uncertain';
  try {
    const response = await clientFor(context, auth.destinationInstance).getModelYaml(
      auth.targetInput.modelId,
      { fileName, includeChecksums: true },
    );
    const yaml = response.files[fileName];
    const checksum = response.checksums?.[fileName];
    if (typeof yaml !== 'string' || !clean(checksum)) return 'uncertain';
    if (checksum !== attempt.previousChecksum && sha256(yaml) === attempt.expectedYamlHash) return 'verified';
    if (checksum === attempt.previousChecksum) return 'not_committed';
    return 'uncertain';
  } catch {
    return 'uncertain';
  }
}

async function prepareDocument(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
  sourceDocumentId: string,
): Promise<DashboardSafeCopyPreparedDocument> {
  const auth = runtimeAuthorization(target);
  await assertWorkbookCopyRuntimeBoundary(context, auth.targetInput, [sourceDocumentId]);
  const sourceClient = clientFor(context, auth.sourceInstance);
  const destinationClient = clientFor(context, auth.destinationInstance);
  const state = await sourceClient.getDocumentStateV2(sourceDocumentId);
  if (context.intent.deployment && dashboardSafeCopyStateHash(state) !== context.intent.deployment.sourceHashes[sourceDocumentId]) {
    throw new SafeCopyRuntimeError('SAFE_COPY_SOURCE_DRIFT', 'The source dashboard changed after preflight. Rerun compatibility checks.', 'definitely_not_committed');
  }
  const sourceModelId = documentModelBinding(state);
  if (!sourceModelId) {
    throw new SafeCopyRuntimeError('SAFE_COPY_SOURCE_MODEL_MISSING', 'The source dashboard model binding is unavailable.');
  }
  const sourceMaterialization = materializeDashboardSafeCopyDocument({
    sourceState: state,
    targetModelId: sourceModelId,
    topicMappings: [],
    queryViewMappings: [],
  });
  const targetMaterialization = materializeDashboardSafeCopyDocument({
    sourceState: state,
    targetModelId: auth.targetInput.modelId,
    topicMappings: auth.prepared.target.topicMappings || [],
    queryViewMappings: auth.prepared.target.queryViewMappings || [],
  });
  if (redactSensitiveText(targetMaterialization.content.name) !== targetMaterialization.content.name) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_DOCUMENT_NAME_UNSAFE',
      'The dashboard name cannot be stored as exact non-secret reconciliation evidence.',
      'definitely_not_committed',
    );
  }
  const expectedQuerySet = deriveDashboardSafeCopyExecutableQuerySet(targetMaterialization.content);
  await proveQueryExecutions(destinationClient, expectedQuerySet);
  context.expectedQuerySets.set(queryProofKey(target.targetId, sourceDocumentId), expectedQuerySet);
  return {
    sourceDocumentId,
    documentName: targetMaterialization.content.name,
    sourceExportHash: sha256({ modelId: sourceModelId, content: sourceMaterialization.content }),
    expectedPayloadHash: contentFingerprint(targetMaterialization.content),
    content: targetMaterialization.content,
  };
}

async function verifyDocument(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
  document: DashboardSafeCopyPreparedDocument,
  live: DashboardSafeCopyLiveDocument,
): Promise<boolean> {
  const auth = runtimeAuthorization(target);
  if (
    live.destinationInstanceId !== auth.targetInput.destinationInstanceId
    || live.connectionId !== auth.targetInput.connectionId
    || live.modelId !== auth.targetInput.modelId
    || !exactFolderDocument(auth.targetInput, live)
    || live.fingerprint !== document.expectedPayloadHash
  ) return false;
  const client = clientFor(context, auth.destinationInstance);
  try {
    const state = await client.getDocumentStateV2(live.documentId);
    if (documentModelBinding(state) !== auth.targetInput.modelId) return false;
    const materialized = materializeDashboardSafeCopyDocument({
      sourceState: state,
      targetModelId: auth.targetInput.modelId,
      topicMappings: [],
      queryViewMappings: [],
    });
    if (contentFingerprint(materialized.content) !== document.expectedPayloadHash) return false;
    const expectedQuerySet = context.expectedQuerySets.get(
      queryProofKey(target.targetId, document.sourceDocumentId),
    );
    if (!expectedQuerySet) return false;
    const liveQuerySet = assertDashboardSafeCopyLiveQuerySet(
      expectedQuerySet,
      materialized.content,
    );
    const access: OmniDocumentAccessInventoryResult = await client.listDocumentAccessInventory(
      live.documentId,
      { accessSource: 'direct' },
    );
    if (
      access.pagination.complete !== true
      || access.principals.some((principal) => (
        principal.accessSource === 'direct'
        && (principal.isOwner !== true || principal.accessBoost === true)
      ))
    ) return false;
    await proveQueryExecutions(client, liveQuerySet);
    return true;
  } catch {
    return false;
  }
}

function attemptItemId(attemptId: string): string {
  return `safe-copy-attempt:${attemptId}`;
}

function verificationItemId(attemptId: string): string {
  return `safe-copy-verification:${attemptId}`;
}

function targetResultItemId(targetId: string): string {
  return `safe-copy-target-result:${targetId}`;
}

function retryClaimItemId(targetId: string): string {
  return `safe-copy-retry-target:${sha256(targetId)}`;
}

function targetForJob(job: MigrationJob, targetId: string): MigrationTarget | undefined {
  const matches = job.targets?.filter((target) => target.id === targetId) || [];
  return matches.length === 1 ? matches[0] : undefined;
}

function attemptMatchesPersistedScope(
  job: MigrationJob,
  intent: DashboardSafeCopyIntent,
  attempt: DashboardSafeCopyAttemptEvidence,
): boolean {
  const target = targetForJob(job, attempt.targetId);
  return attempt.jobId === job.id
    && Boolean(target)
    && attempt.destinationInstanceId === target?.destinationInstanceId
    && attempt.connectionId === target?.targetConnectionId
    && attempt.modelId === target?.targetModelId
    && attempt.folderId === target?.targetFolderId
    && attempt.folderPath === target?.targetFolderPath
    && (
      attempt.operation !== 'document_create'
      || Boolean(attempt.sourceDocumentId && intent.source.documentIds.includes(attempt.sourceDocumentId))
    );
}

function attemptImmutableFingerprint(attempt: DashboardSafeCopyAttemptEvidence): string {
  return sha256({
    attemptId: attempt.attemptId,
    jobId: attempt.jobId,
    targetId: attempt.targetId,
    operation: attempt.operation,
    destinationInstanceId: attempt.destinationInstanceId,
    connectionId: attempt.connectionId,
    modelId: attempt.modelId,
    folderId: attempt.folderId || '',
    folderPath: canonicalText(attempt.folderPath),
    sourceDocumentId: attempt.sourceDocumentId || '',
    chosenName: attempt.chosenName || '',
    sourceExportHash: attempt.sourceExportHash || '',
    expectedPayloadHash: attempt.expectedPayloadHash || '',
    fileName: attempt.fileName || '',
    previousChecksum: attempt.previousChecksum || '',
    expectedYamlHash: attempt.expectedYamlHash || '',
    preexistingDocumentIds: [...(attempt.preexistingDocumentIds || [])].sort(),
    createdAt: attempt.createdAt,
  });
}

function attemptDetails(attempt: DashboardSafeCopyAttemptEvidence): Record<string, unknown> {
  return {
    safeCopyAttempt: true,
    safeCopyAttemptId: attempt.attemptId,
    safeCopyAttemptState: attempt.state,
    safeCopyAttemptOperation: attempt.operation,
    safeCopyAttemptFingerprint: attemptImmutableFingerprint(attempt),
    safeCopyDestinationInstanceId: attempt.destinationInstanceId,
    safeCopyConnectionId: attempt.connectionId,
    safeCopyModelId: attempt.modelId,
    ...(attempt.folderId ? { safeCopyFolderId: attempt.folderId } : {}),
    ...(attempt.folderPath ? { safeCopyFolderPath: attempt.folderPath } : {}),
    ...(attempt.sourceDocumentId ? { safeCopySourceDocumentId: attempt.sourceDocumentId } : {}),
    ...(attempt.chosenName ? { safeCopyChosenName: attempt.chosenName } : {}),
    ...(attempt.sourceExportHash ? { safeCopySourceExportHash: attempt.sourceExportHash } : {}),
    ...(attempt.expectedPayloadHash ? { safeCopyExpectedPayloadHash: attempt.expectedPayloadHash } : {}),
    ...(attempt.fileName ? { safeCopyFileName: attempt.fileName } : {}),
    ...(attempt.previousChecksum ? { safeCopyPreviousChecksum: attempt.previousChecksum } : {}),
    ...(attempt.expectedYamlHash ? { safeCopyExpectedYamlHash: attempt.expectedYamlHash } : {}),
    ...(attempt.preexistingDocumentIds ? { safeCopyPreexistingDocumentIds: [...attempt.preexistingDocumentIds] } : {}),
    ...(attempt.importedDocumentId ? { safeCopyImportedDocumentId: attempt.importedDocumentId } : {}),
    ...(attempt.importedIdentifier ? { safeCopyImportedIdentifier: attempt.importedIdentifier } : {}),
    ...(attempt.publishedFingerprint ? { safeCopyPublishedFingerprint: attempt.publishedFingerprint } : {}),
    ...(attempt.verificationStartedAt ? { safeCopyVerificationStartedAt: attempt.verificationStartedAt } : {}),
    ...(attempt.verifierVersion ? { safeCopyVerifierVersion: attempt.verifierVersion } : {}),
    ...(attempt.verifiedAt ? { safeCopyVerifiedAt: attempt.verifiedAt } : {}),
    safeCopyAttemptCreatedAt: attempt.createdAt,
    safeCopyAttemptUpdatedAt: attempt.updatedAt,
  };
}

function attemptItemStatus(attempt: DashboardSafeCopyAttemptEvidence): MigrationJobItem['status'] {
  if (attempt.state === 'verified') return 'succeeded';
  if (attempt.state === 'failed_prewrite') return 'failed';
  if (attempt.state === 'uncertain') return 'warning';
  return 'running';
}

function attemptItemError(attempt: DashboardSafeCopyAttemptEvidence): string | undefined {
  if (attempt.state === 'failed_prewrite') {
    return 'The write did not begin and may be retried after fresh validation.';
  }
  if (attempt.state === 'uncertain') {
    return 'The write outcome requires exact reconciliation before retry.';
  }
  return undefined;
}

function attemptItem(
  job: MigrationJob,
  attempt: DashboardSafeCopyAttemptEvidence,
): MigrationJobItem {
  const target = targetForJob(job, attempt.targetId);
  if (!target) throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_MISSING', 'The safe-copy attempt target is no longer persisted.');
  return {
    id: attemptItemId(attempt.attemptId),
    jobId: job.id,
    targetId: attempt.targetId,
    destinationId: attempt.destinationInstanceId,
    destinationLabel: target.destinationLabel || 'Destination',
    targetModelId: attempt.modelId,
    targetModelName: target.targetModelName,
    targetFolderId: attempt.folderId,
    targetFolderPath: attempt.folderPath,
    kind: attempt.operation === 'semantic_update' ? 'model_yaml_write' : 'import',
    documentId: attempt.sourceDocumentId,
    documentName: attempt.chosenName,
    status: attemptItemStatus(attempt),
    ...(attemptItemError(attempt) ? { error: attemptItemError(attempt) } : {}),
    startedAt: attempt.createdAt,
    ...(attempt.state !== 'dispatched' ? { endedAt: attempt.updatedAt } : {}),
    importedDocumentId: attempt.importedDocumentId,
    importedIdentifier: attempt.importedIdentifier,
    details: attemptDetails(attempt),
  };
}

function parseAttemptItem(item: MigrationJobItem): DashboardSafeCopyAttemptEvidence | undefined {
  const details = item.details;
  if (details?.safeCopyAttempt !== true) return undefined;
  if (Object.keys(details).some((key) => !SAFE_COPY_ATTEMPT_DETAIL_KEYS.has(key))) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted safe-copy attempt details contain unsupported fields.');
  }
  const operation = details.safeCopyAttemptOperation;
  const state = details.safeCopyAttemptState;
  const attemptId = detailsString(details, 'safeCopyAttemptId');
  const destinationInstanceId = detailsString(details, 'safeCopyDestinationInstanceId');
  const connectionId = detailsString(details, 'safeCopyConnectionId');
  const modelId = detailsString(details, 'safeCopyModelId');
  const createdAt = detailsNumber(details, 'safeCopyAttemptCreatedAt');
  const updatedAt = detailsNumber(details, 'safeCopyAttemptUpdatedAt');
  const verificationStartedAt = detailsNumber(details, 'safeCopyVerificationStartedAt');
  if (
    !attemptId
    || !item.targetId
    || !destinationInstanceId
    || !connectionId
    || !modelId
    || ![attemptId, destinationInstanceId, connectionId, modelId].every((value) => boundedEvidenceText(value))
    || !createdAt
    || !updatedAt
    || !Number.isSafeInteger(createdAt)
    || !Number.isSafeInteger(updatedAt)
    || updatedAt < createdAt
    || (operation !== 'semantic_update' && operation !== 'document_create')
    || !['dispatched', 'failed_prewrite', 'uncertain', 'verified'].includes(String(state))
  ) throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted safe-copy attempt evidence is incomplete.');
  const ids = details.safeCopyPreexistingDocumentIds;
  if (
    ids !== undefined
    && (
      !Array.isArray(ids)
      || ids.length > MAX_ATTEMPT_PREEXISTING_DOCUMENT_IDS
      || ids.some((value) => !boundedEvidenceText(clean(value)))
      || new Set(ids).size !== ids.length
    )
  ) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted safe-copy attempt baseline is malformed.');
  }
  const attempt: DashboardSafeCopyAttemptEvidence = {
    attemptId,
    jobId: item.jobId,
    targetId: item.targetId,
    operation,
    state: state as DashboardSafeCopyAttemptEvidence['state'],
    destinationInstanceId,
    connectionId,
    modelId,
    ...(detailsString(details, 'safeCopyFolderId') ? { folderId: detailsString(details, 'safeCopyFolderId') } : {}),
    ...(detailsString(details, 'safeCopyFolderPath') ? { folderPath: detailsString(details, 'safeCopyFolderPath') } : {}),
    ...(detailsString(details, 'safeCopySourceDocumentId') ? { sourceDocumentId: detailsString(details, 'safeCopySourceDocumentId') } : {}),
    ...(detailsString(details, 'safeCopyChosenName') ? { chosenName: detailsString(details, 'safeCopyChosenName') } : {}),
    ...(detailsString(details, 'safeCopySourceExportHash') ? { sourceExportHash: detailsString(details, 'safeCopySourceExportHash') } : {}),
    ...(detailsString(details, 'safeCopyExpectedPayloadHash') ? { expectedPayloadHash: detailsString(details, 'safeCopyExpectedPayloadHash') } : {}),
    ...(detailsString(details, 'safeCopyFileName') ? { fileName: detailsString(details, 'safeCopyFileName') } : {}),
    ...(detailsString(details, 'safeCopyPreviousChecksum') ? { previousChecksum: detailsString(details, 'safeCopyPreviousChecksum') } : {}),
    ...(detailsString(details, 'safeCopyExpectedYamlHash') ? { expectedYamlHash: detailsString(details, 'safeCopyExpectedYamlHash') } : {}),
    ...(Array.isArray(ids) ? { preexistingDocumentIds: ids.map((value) => String(value)) } : {}),
    ...(detailsString(details, 'safeCopyImportedDocumentId') ? { importedDocumentId: detailsString(details, 'safeCopyImportedDocumentId') } : {}),
    ...(detailsString(details, 'safeCopyImportedIdentifier') ? { importedIdentifier: detailsString(details, 'safeCopyImportedIdentifier') } : {}),
    ...(detailsString(details, 'safeCopyPublishedFingerprint') ? { publishedFingerprint: detailsString(details, 'safeCopyPublishedFingerprint') } : {}),
    ...(verificationStartedAt ? { verificationStartedAt } : {}),
    ...(detailsNumber(details, 'safeCopyVerifierVersion') ? { verifierVersion: detailsNumber(details, 'safeCopyVerifierVersion') } : {}),
    ...(detailsNumber(details, 'safeCopyVerifiedAt') ? { verifiedAt: detailsNumber(details, 'safeCopyVerifiedAt') } : {}),
    createdAt,
    updatedAt,
  };
  const boundedOptionalEvidence = [
    attempt.folderId,
    attempt.sourceDocumentId,
    attempt.chosenName,
    attempt.sourceExportHash,
    attempt.expectedPayloadHash,
    attempt.fileName,
    attempt.previousChecksum,
    attempt.expectedYamlHash,
    attempt.importedDocumentId,
    attempt.importedIdentifier,
    attempt.publishedFingerprint,
  ].every((value) => value === undefined || boundedEvidenceText(value));
  if (!boundedOptionalEvidence || (attempt.folderPath !== undefined && !boundedEvidenceText(attempt.folderPath, 1_024))) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted safe-copy attempt evidence exceeds bounded text limits.');
  }
  if (
    verificationStartedAt !== undefined
    && (
      operation !== 'document_create'
      || state === 'failed_prewrite'
      || !Number.isSafeInteger(verificationStartedAt)
      || verificationStartedAt < createdAt
      || verificationStartedAt > updatedAt
      || !attempt.importedDocumentId
      || !attempt.importedIdentifier
      || !attempt.publishedFingerprint
      || !attempt.expectedPayloadHash
      || attempt.publishedFingerprint !== attempt.expectedPayloadHash
    )
  ) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted verification-start evidence is incomplete.');
  }
  if (detailsString(details, 'safeCopyAttemptFingerprint') !== attemptImmutableFingerprint(attempt)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted safe-copy attempt evidence does not match its immutable fingerprint.');
  }
  const documentFieldsAreValid = operation !== 'document_create' || (
    Boolean(attempt.sourceDocumentId)
    && Boolean(attempt.chosenName)
    && Boolean(attempt.sourceExportHash)
    && Boolean(attempt.expectedPayloadHash)
    && Array.isArray(ids)
    && !attempt.fileName
    && !attempt.previousChecksum
    && !attempt.expectedYamlHash
    && (
      verificationStartedAt !== undefined
        ? Boolean(attempt.importedDocumentId && attempt.importedIdentifier && attempt.publishedFingerprint)
        : !attempt.importedDocumentId && !attempt.importedIdentifier && !attempt.publishedFingerprint
    )
    && (
      state === 'verified'
        ? verificationStartedAt !== undefined
          && Number.isSafeInteger(attempt.verifierVersion)
          && (attempt.verifierVersion || 0) > 0
          && Number.isSafeInteger(attempt.verifiedAt)
          && (attempt.verifiedAt || 0) >= verificationStartedAt
          && (attempt.verifiedAt || 0) <= updatedAt
        : attempt.verifierVersion === undefined && attempt.verifiedAt === undefined
    )
  );
  const semanticFieldsAreValid = operation !== 'semantic_update' || (
    Boolean(attempt.fileName)
    && Boolean(attempt.previousChecksum)
    && Boolean(attempt.expectedYamlHash)
    && !attempt.sourceDocumentId
    && !attempt.chosenName
    && !attempt.sourceExportHash
    && !attempt.expectedPayloadHash
    && ids === undefined
    && !attempt.importedDocumentId
    && !attempt.importedIdentifier
    && !attempt.publishedFingerprint
    && verificationStartedAt === undefined
    && attempt.verifierVersion === undefined
    && attempt.verifiedAt === undefined
  );
  const expectedKind: MigrationJobItem['kind'] = operation === 'semantic_update' ? 'model_yaml_write' : 'import';
  if (
    !documentFieldsAreValid
    || !semanticFieldsAreValid
    || item.id !== attemptItemId(attemptId)
    || item.kind !== expectedKind
    || item.status !== attemptItemStatus(attempt)
    || item.destinationId !== destinationInstanceId
    || item.targetModelId !== modelId
    || (item.targetFolderId || '') !== (attempt.folderId || '')
    || (item.targetFolderPath || '') !== (attempt.folderPath || '')
    || (item.documentId || '') !== (attempt.sourceDocumentId || '')
    || (item.documentName || '') !== (attempt.chosenName || '')
    || (item.importedDocumentId || '') !== (attempt.importedDocumentId || '')
    || (item.importedIdentifier || '') !== (attempt.importedIdentifier || '')
    || item.startedAt !== createdAt
    || (state === 'dispatched' ? item.endedAt !== undefined : item.endedAt !== updatedAt)
    || item.error !== attemptItemError(attempt)
    || item.replacement !== undefined
    || item.details?.updateInPlace !== undefined
    || item.warnings !== undefined
    || item.notices !== undefined
  ) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted safe-copy attempt envelope is inconsistent.');
  }
  return attempt;
}

function verifiedDocumentFromDurableAttempt(
  job: MigrationJob,
  intent: DashboardSafeCopyIntent,
  target: MigrationTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
  verificationItem?: MigrationJobItem,
): DashboardSafeCopyDocumentResult | undefined {
  if (
    attempt.operation !== 'document_create'
    || attempt.state !== 'verified'
    || attempt.targetId !== target.id
    || attempt.destinationInstanceId !== target.destinationInstanceId
    || attempt.connectionId !== target.targetConnectionId
    || attempt.modelId !== target.targetModelId
    || attempt.folderId !== target.targetFolderId
    || attempt.folderPath !== target.targetFolderPath
    || !attempt.sourceDocumentId
    || !intent.source.documentIds.includes(attempt.sourceDocumentId)
    || !attempt.sourceExportHash
    || !attempt.expectedPayloadHash
    || !attempt.chosenName
    || !attempt.importedDocumentId
    || !attempt.importedIdentifier
    || attempt.publishedFingerprint !== attempt.expectedPayloadHash
    || !Number.isSafeInteger(attempt.verifierVersion)
    || (attempt.verifierVersion || 0) < 1
    || !Number.isSafeInteger(attempt.verifiedAt)
    || (attempt.verifiedAt || 0) < 1
    || (
      intent.source.instanceId === target.destinationInstanceId
      && attempt.importedDocumentId === attempt.sourceDocumentId
    )
  ) return undefined;
  const verification = verificationItem
    || job.items.find((item) => item.id === verificationItemId(attempt.attemptId));
  const provenance = verification?.details?.safeCopyDocumentProvenance;
  if (
    verification?.kind !== 'document_verify'
    || verification.status !== 'succeeded'
    || verification.targetId !== target.id
    || verification.destinationId !== target.destinationInstanceId
    || verification.targetModelId !== target.targetModelId
    || verification.targetFolderId !== target.targetFolderId
    || verification.targetFolderPath !== target.targetFolderPath
    || verification.documentId !== attempt.sourceDocumentId
    || verification.documentName !== attempt.chosenName
    || verification.importedDocumentId !== attempt.importedDocumentId
    || verification.importedIdentifier !== attempt.importedIdentifier
    || verification.endedAt !== attempt.verifiedAt
    || !isRecord(provenance)
    || Object.keys(provenance).some((key) => !SAFE_COPY_VERIFIED_PROVENANCE_KEYS.has(key))
    || provenance.profile !== DASHBOARD_SAFE_COPY_PROFILE
    || !Number.isSafeInteger(provenance.resolverVersion)
    || Number(provenance.resolverVersion) < 1
    || provenance.jobId !== job.id
    || provenance.attemptId !== attempt.attemptId
    || provenance.targetId !== target.id
    || provenance.sourceInstanceId !== intent.source.instanceId
    || provenance.sourceConnectionId !== intent.source.connectionId
    || provenance.sourceDocumentId !== attempt.sourceDocumentId
    || provenance.sourceExportHash !== attempt.sourceExportHash
    || provenance.destinationInstanceId !== target.destinationInstanceId
    || provenance.connectionId !== target.targetConnectionId
    || provenance.modelId !== target.targetModelId
    || provenance.folderId !== target.targetFolderId
    || provenance.folderPath !== target.targetFolderPath
    || provenance.importedDocumentId !== attempt.importedDocumentId
    || provenance.importedIdentifier !== attempt.importedIdentifier
    || provenance.chosenName !== attempt.chosenName
    || provenance.expectedPayloadHash !== attempt.expectedPayloadHash
    || provenance.publishedFingerprint !== attempt.expectedPayloadHash
    || provenance.verifierVersion !== attempt.verifierVersion
    || provenance.verifiedAt !== attempt.verifiedAt
    || provenance.finalVerification !== 'passed'
    || provenance.documentWriteMode !== 'created'
  ) return undefined;
  return {
    sourceDocumentId: attempt.sourceDocumentId,
    status: 'succeeded',
    chosenName: attempt.chosenName,
    importedDocumentId: attempt.importedDocumentId,
    importedIdentifier: attempt.importedIdentifier,
    sourceExportHash: attempt.sourceExportHash,
    expectedPayloadHash: attempt.expectedPayloadHash,
    publishedFingerprint: attempt.publishedFingerprint,
  };
}

interface VerifiedAttemptRecoveryState {
  result?: DashboardSafeCopyTargetResult;
  verifiedDocumentIds: string[];
  verifiedSemanticChange?: NonNullable<DashboardSafeCopyExecutionTarget['skipSemanticChange']>;
}

interface VerifiedSemanticRecovery {
  attempt: DashboardSafeCopyAttemptEvidence;
  proof: NonNullable<DashboardSafeCopyExecutionTarget['skipSemanticChange']>;
}

function verifiedSemanticRecoveryFromAttempts(
  job: MigrationJob,
  intent: DashboardSafeCopyIntent,
  target: MigrationTarget,
  attempts: readonly DashboardSafeCopyAttemptEvidence[],
): VerifiedSemanticRecovery | undefined {
  const candidates = attempts.filter((attempt) => (
    attempt.operation === 'semantic_update' && attempt.state === 'verified'
  ));
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_SEMANTIC_EVIDENCE_INVALID',
      'Persisted model-change evidence is ambiguous.',
    );
  }
  const attempt = candidates[0];
  const destination = intent.destinations.find((candidate) => candidate.targetId === target.id);
  const summary = preparationSummary(job, target.id);
  const proof = {
    fileName: attempt.fileName || '',
    previousChecksum: attempt.previousChecksum || '',
    expectedYamlHash: attempt.expectedYamlHash || '',
  };
  const summaryProofHash = detailsString(summary?.details, 'safeCopySemanticProofHash');
  const persistedTargetProofHash = dashboardSafeCopySemanticPatchProofHash(target);
  if (
    !destination
    || !summary
    || summary.status !== 'succeeded'
    || summary.details?.safeCopyTargetStatus !== 'ready'
    || detailsNumber(summary.details, 'safeCopyPatchCount') !== 1
    || !summaryProofHash
    || summaryProofHash !== sha256(proof)
    || (persistedTargetProofHash !== undefined && persistedTargetProofHash !== summaryProofHash)
    || attempt.jobId !== job.id
    || attempt.targetId !== target.id
    || attempt.destinationInstanceId !== destination.instanceId
    || attempt.connectionId !== destination.connectionId
    || attempt.modelId !== destination.modelId
    || (clean(attempt.folderId) || '') !== (clean(destination.folderId) || '')
    || canonicalText(attempt.folderPath) !== canonicalText(destination.folderPath)
    || target.destinationInstanceId !== destination.instanceId
    || target.targetConnectionId !== destination.connectionId
    || target.targetModelId !== destination.modelId
    || (clean(target.targetFolderId) || '') !== (clean(destination.folderId) || '')
    || canonicalText(target.targetFolderPath) !== canonicalText(destination.folderPath)
    || !proof.fileName
    || !proof.previousChecksum
    || !proof.expectedYamlHash
  ) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_SEMANTIC_EVIDENCE_INVALID',
      'Persisted model-change evidence does not match the exact prepared destination scope.',
    );
  }
  return { attempt, proof };
}

function verifiedSemanticRecoveryForExecution(
  context: RuntimeContext,
  targetInput: DashboardSafeCopyExecutionTarget,
): VerifiedSemanticRecovery | undefined {
  if (!targetInput.skipSemanticChange) return undefined;
  const job = context.services.getJob(context.jobId);
  const target = job?.targets?.find((candidate) => candidate.id === targetInput.targetId);
  if (
    !job
    || !isDashboardSafeCopyJob(job)
    || job.details?.safeCopyIntentHash !== dashboardSafeCopyIntentHash(context.intent)
    || !target
    || targetInput.sourceInstanceId !== context.intent.source.instanceId
    || targetInput.sourceConnectionId !== context.intent.source.connectionId
  ) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_SEMANTIC_EVIDENCE_INVALID',
      'The durable model-change scope changed before resumed execution.',
    );
  }
  const attempts = job.items
    .filter((item) => item.targetId === target.id && item.details?.safeCopyAttempt === true)
    .map((item) => {
      const parsed = parseAttemptItem(item);
      if (!parsed || parsed.jobId !== job.id) {
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_SEMANTIC_EVIDENCE_INVALID',
          'The durable model-change attempt envelope is invalid.',
        );
      }
      return parsed;
    });
  if (attempts.some((attempt) => (
    attempt.operation === 'semantic_update'
    && (attempt.state === 'dispatched' || attempt.state === 'uncertain')
  ))) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_SEMANTIC_EVIDENCE_INVALID',
      'An unresolved write must be reconciled before resumed execution.',
    );
  }
  const recovery = verifiedSemanticRecoveryFromAttempts(job, context.intent, target, attempts);
  if (
    !recovery
    || recovery.proof.fileName !== targetInput.skipSemanticChange.fileName
    || recovery.proof.previousChecksum !== targetInput.skipSemanticChange.previousChecksum
    || recovery.proof.expectedYamlHash !== targetInput.skipSemanticChange.expectedYamlHash
  ) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_SEMANTIC_EVIDENCE_INVALID',
      'The in-memory model-change skip does not match the durable verified attempt.',
    );
  }
  return recovery;
}

function verifiedAttemptRecoveryState(
  job: MigrationJob,
  intent: DashboardSafeCopyIntent,
  target: MigrationTarget,
): VerifiedAttemptRecoveryState | undefined {
  if (job.items.some((item) => item.id === targetResultItemId(target.id))) return undefined;
  const storedAttemptItems = job.items.filter((item) => (
    item.targetId === target.id && item.details?.safeCopyAttempt === true
  ));
  if (storedAttemptItems.length === 0) return undefined;
  let attempts: DashboardSafeCopyAttemptEvidence[];
  try {
    attempts = storedAttemptItems.map((item) => {
      const parsed = parseAttemptItem(item);
      if (!parsed || parsed.jobId !== job.id) throw new Error('Missing safe-copy attempt evidence.');
      return parsed;
    });
  } catch {
    return { result: setupFailure(target.id), verifiedDocumentIds: [] };
  }
  if (attempts.some((attempt) => attempt.state === 'dispatched' || attempt.state === 'uncertain')) {
    return { result: setupFailure(target.id), verifiedDocumentIds: [] };
  }
  let semanticRecovery: VerifiedSemanticRecovery | undefined;
  try {
    semanticRecovery = verifiedSemanticRecoveryFromAttempts(job, intent, target, attempts);
  } catch {
    return { result: setupFailure(target.id), verifiedDocumentIds: [] };
  }
  const verifiedAttempts = attempts.filter((attempt) => (
    attempt.operation === 'document_create' && attempt.state === 'verified'
  ));
  if (verifiedAttempts.length === 0) {
    return {
      verifiedDocumentIds: [],
      ...(semanticRecovery ? { verifiedSemanticChange: semanticRecovery.proof } : {}),
    };
  }
  const documents: DashboardSafeCopyDocumentResult[] = [];
  for (const sourceDocumentId of intent.source.documentIds) {
    const candidates = verifiedAttempts.filter((attempt) => attempt.sourceDocumentId === sourceDocumentId);
    if (candidates.length === 0) continue;
    if (candidates.length !== 1) {
      return { result: setupFailure(target.id), verifiedDocumentIds: [] };
    }
    const recovered = verifiedDocumentFromDurableAttempt(job, intent, target, candidates[0]);
    if (!recovered) return { result: setupFailure(target.id), verifiedDocumentIds: [] };
    documents.push(recovered);
  }
  if (documents.length !== verifiedAttempts.length) {
    return { result: setupFailure(target.id), verifiedDocumentIds: [] };
  }
  const verifiedDocumentIds = documents.map((document) => document.sourceDocumentId);
  return documents.length === intent.source.documentIds.length
    ? {
      result: { targetId: target.id, status: 'succeeded', documents, exceptions: [] },
      verifiedDocumentIds,
    }
    : {
      verifiedDocumentIds,
      ...(semanticRecovery ? { verifiedSemanticChange: semanticRecovery.proof } : {}),
    };
}

function materializeVerifiedAttemptResults(context: RuntimeContext): {
  persisted: boolean;
  verifiedDocumentIdsByTarget: Map<string, string[]>;
  verifiedSemanticChangesByTarget: Map<string, NonNullable<DashboardSafeCopyExecutionTarget['skipSemanticChange']>>;
} {
  const job = context.services.getJob(context.jobId);
  if (!job || !isDashboardSafeCopyJob(job)) {
    return {
      persisted: false,
      verifiedDocumentIdsByTarget: new Map(),
      verifiedSemanticChangesByTarget: new Map(),
    };
  }
  const results: DashboardSafeCopyTargetResult[] = [];
  const verifiedDocumentIdsByTarget = new Map<string, string[]>();
  const verifiedSemanticChangesByTarget = new Map<
    string,
    NonNullable<DashboardSafeCopyExecutionTarget['skipSemanticChange']>
  >();
  for (const target of job.targets || []) {
    const recovery = verifiedAttemptRecoveryState(job, context.intent, target);
    if (!recovery) continue;
    if (recovery.result) results.push(recovery.result);
    else {
      if (recovery.verifiedDocumentIds.length > 0) {
        verifiedDocumentIdsByTarget.set(target.id, recovery.verifiedDocumentIds);
      }
      if (recovery.verifiedSemanticChange) {
        verifiedSemanticChangesByTarget.set(target.id, recovery.verifiedSemanticChange);
      }
    }
  }
  return {
    persisted: persistTargetResultsIndependently(context, results),
    verifiedDocumentIdsByTarget,
    verifiedSemanticChangesByTarget,
  };
}

function transitionAllowed(
  previous: DashboardSafeCopyAttemptEvidence['state'],
  next: DashboardSafeCopyAttemptEvidence['state'],
): boolean {
  if (previous === 'verified') return next === 'verified';
  if (previous === 'failed_prewrite') return next === 'failed_prewrite';
  if (previous === 'uncertain') return next === 'uncertain' || next === 'verified' || next === 'failed_prewrite';
  return true;
}

function verificationStartEvidenceIsValid(attempt: DashboardSafeCopyAttemptEvidence): boolean {
  if (attempt.verificationStartedAt === undefined) return true;
  return attempt.operation === 'document_create'
    && attempt.state !== 'failed_prewrite'
    && Number.isSafeInteger(attempt.verificationStartedAt)
    && attempt.verificationStartedAt >= attempt.createdAt
    && attempt.verificationStartedAt <= attempt.updatedAt
    && Boolean(attempt.importedDocumentId)
    && Boolean(attempt.importedIdentifier)
    && Boolean(attempt.publishedFingerprint)
    && Boolean(attempt.expectedPayloadHash)
    && attempt.publishedFingerprint === attempt.expectedPayloadHash;
}

function verificationCandidateEvidenceIsStable(
  previous: DashboardSafeCopyAttemptEvidence,
  next: DashboardSafeCopyAttemptEvidence,
): boolean {
  if (previous.verificationStartedAt === undefined) return true;
  return next.verificationStartedAt === previous.verificationStartedAt
    && next.importedDocumentId === previous.importedDocumentId
    && next.importedIdentifier === previous.importedIdentifier
    && next.publishedFingerprint === previous.publishedFingerprint;
}

function persistAttempt(
  context: RuntimeContext,
  attempt: DashboardSafeCopyAttemptEvidence,
): void {
  if (!verificationStartEvidenceIsValid(attempt)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Persisted verification-start evidence is incomplete.');
  }
  const itemId = attemptItemId(attempt.attemptId);
  const reservationOwner = `safe-copy:${context.jobId}:${attempt.attemptId}`;
  if (attempt.state === 'dispatched' && hasUnresolvedMigrationDestinationModelMutation(
    listStoredJobs(Number.MAX_SAFE_INTEGER),
    [{
      destinationInstanceId: attempt.destinationInstanceId,
      targetModelId: attempt.modelId,
    }],
    { excludeItemIds: new Set([itemId]) },
  )) {
    throw new SafeCopyRuntimeError(
      'SAFE_COPY_TARGET_WRITE_IN_FLIGHT',
      'Another workflow still owns this destination model and must be reconciled first.',
      'definitely_not_committed',
    );
  }
  const releaseReservation = attempt.state === 'dispatched'
    ? reserveMigrationDestinationModels(reservationOwner, [{
      destinationInstanceId: attempt.destinationInstanceId,
      targetModelId: attempt.modelId,
    }])
    : undefined;
  let updated: MigrationJob | undefined;
  try {
    updated = context.services.updateJobAtomically(context.jobId, (current) => {
      let currentIntent: DashboardSafeCopyIntent;
      try {
        currentIntent = dashboardSafeCopyIntentFromJob(current);
      } catch {
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_JOB_SCOPE_CHANGED',
          'The safe-copy job scope changed before attempt persistence.',
          'definitely_not_committed',
        );
      }
      if (dashboardSafeCopyIntentHash(currentIntent) !== dashboardSafeCopyIntentHash(context.intent)) {
        throw new SafeCopyRuntimeError('SAFE_COPY_JOB_SCOPE_CHANGED', 'The safe-copy job scope changed before attempt persistence.');
      }
      if (current.status === 'canceled') {
        throw new SafeCopyRuntimeError('SAFE_COPY_JOB_NOT_WRITABLE', 'The canceled safe-copy job no longer accepts attempt evidence.');
      }
      if (!attemptMatchesPersistedScope(current, currentIntent, attempt)) {
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_ATTEMPT_SCOPE_CHANGED',
          'The safe-copy attempt no longer matches its persisted destination scope.',
          'definitely_not_committed',
        );
      }
      const existingIndex = current.items.findIndex((item) => item.id === itemId);
      const existingAttempt = existingIndex >= 0 ? parseAttemptItem(current.items[existingIndex]) : undefined;
      const competingActiveAttempt = current.items
        .filter((item) => (
          item.id !== itemId
          && item.targetId === attempt.targetId
          && item.details?.safeCopyAttempt === true
        ))
        .map((item) => parseAttemptItem(item))
        .find((candidate) => (
          candidate?.targetId === attempt.targetId
          && (candidate.state === 'dispatched' || candidate.state === 'uncertain')
        ));
      if (competingActiveAttempt) {
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_TARGET_WRITE_IN_FLIGHT',
          'Another write attempt already owns this destination and must be reconciled first.',
        );
      }
      if (!existingAttempt && ['succeeded', 'failed'].includes(current.status)) {
        throw new SafeCopyRuntimeError('SAFE_COPY_JOB_NOT_WRITABLE', 'The safe-copy job no longer accepts a new write attempt.');
      }
      if (
        !existingAttempt
        && current.items.filter((item) => item.details?.safeCopyAttempt === true).length >= MAX_CLIENT_EVIDENCE_ATTEMPTS
      ) {
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_ATTEMPT_LIMIT_EXCEEDED',
          'The bounded safe-copy attempt ledger cannot accept another write.',
          'definitely_not_committed',
        );
      }
      if (
        existingAttempt
        && (
          attemptImmutableFingerprint(existingAttempt) !== attemptImmutableFingerprint(attempt)
          || !verificationCandidateEvidenceIsStable(existingAttempt, attempt)
          || !transitionAllowed(existingAttempt.state, attempt.state)
          || attempt.updatedAt < existingAttempt.updatedAt
        )
      ) throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_CONFLICT', 'Safe-copy attempt evidence conflicts with the durable ledger.');
      const nextItem = attemptItem(current, attempt);
      const canonicalAttempt = parseAttemptItem(nextItem);
      if (!canonicalAttempt || canonicalAttempt.attemptId !== attempt.attemptId || canonicalAttempt.jobId !== current.id) {
        throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'Safe-copy attempt evidence was not canonical before persistence.');
      }
      const items = [...current.items];
      if (existingIndex >= 0) items[existingIndex] = nextItem;
      else items.push(nextItem);
      return {
        ...current,
        status: 'running',
        startedAt: current.startedAt || context.services.now(),
        endedAt: undefined,
        details: {
          ...(current.details || {}),
          safeCopyExecutionState: attempt.state === 'uncertain' ? 'reconciliation_required' : 'copying',
        },
        items,
      };
    });
  } catch (error) {
    releaseReservation?.();
    if (attempt.state === 'verified' || attempt.state === 'failed_prewrite') {
      releaseMigrationDestinationModels(reservationOwner);
    }
    throw error;
  }
  if (!updated) {
    releaseReservation?.();
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job disappeared before attempt persistence.');
  }
  if (attempt.state === 'verified' || attempt.state === 'failed_prewrite') {
    releaseMigrationDestinationModels(reservationOwner);
  }
  publishStoredItem(context, itemId);
  publishStoredJob(context, context.jobId);
}

function persistVerifiedProvenance(
  context: RuntimeContext,
  provenance: DashboardSafeCopyVerifiedProvenance,
): void {
  const itemId = verificationItemId(provenance.attemptId);
  const updated = context.services.updateJobAtomically(context.jobId, (current) => {
    if (!isDashboardSafeCopyJob(current)) {
      throw new SafeCopyRuntimeError('SAFE_COPY_JOB_SCOPE_CHANGED', 'The verification ledger is unavailable.');
    }
    const target = targetForJob(current, provenance.targetId);
    if (!target) throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_MISSING', 'The verification target is unavailable.');
    const item: MigrationJobItem = {
      id: itemId,
      jobId: current.id,
      targetId: provenance.targetId,
      destinationId: provenance.destinationInstanceId,
      destinationLabel: target.destinationLabel || 'Destination',
      targetModelId: provenance.modelId,
      targetModelName: target.targetModelName,
      targetFolderId: provenance.folderId,
      targetFolderPath: provenance.folderPath,
      kind: 'document_verify',
      documentId: provenance.sourceDocumentId,
      documentName: provenance.chosenName,
      status: 'succeeded',
      startedAt: provenance.verifiedAt,
      endedAt: provenance.verifiedAt,
      importedDocumentId: provenance.importedDocumentId,
      importedIdentifier: provenance.importedIdentifier,
      details: {
        safeCopyDocumentProvenance: {
          ...provenance,
          finalVerification: 'passed',
          documentWriteMode: 'created',
        },
      },
    };
    const existing = current.items.find((candidate) => candidate.id === itemId);
    if (existing && sha256(existing.details) !== sha256(item.details)) {
      throw new SafeCopyRuntimeError('SAFE_COPY_PROVENANCE_CONFLICT', 'Verified provenance conflicts with the durable ledger.');
    }
    return existing ? current : { ...current, items: [...current.items, item] };
  });
  if (!updated) throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job disappeared before verification persistence.');
  publishStoredItem(context, itemId);
}

function targetResultStatus(result: DashboardSafeCopyTargetResult): MigrationJobItem['status'] {
  if (result.status === 'succeeded') return 'succeeded';
  if (result.status === 'partial') return 'warning';
  return 'failed';
}

function persistTargetResult(context: RuntimeContext, result: DashboardSafeCopyTargetResult): void {
  const itemId = targetResultItemId(result.targetId);
  const updated = context.services.updateJobAtomically(context.jobId, (current) => {
    if (!isDashboardSafeCopyJob(current)) {
      throw new SafeCopyRuntimeError('SAFE_COPY_JOB_SCOPE_CHANGED', 'The safe-copy result target is unavailable.');
    }
    if (current.status === 'canceled') {
      throw new SafeCopyRuntimeError('SAFE_COPY_JOB_NOT_WRITABLE', 'The canceled safe-copy job no longer accepts target results.');
    }
    const target = targetForJob(current, result.targetId);
    if (!target) throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_MISSING', 'The safe-copy result target is unavailable.');
    const now = context.services.now();
    const item: MigrationJobItem = {
      id: itemId,
      jobId: current.id,
      targetId: result.targetId,
      destinationId: target.destinationInstanceId,
      destinationLabel: target.destinationLabel || 'Destination',
      targetModelId: target.targetModelId,
      targetModelName: target.targetModelName,
      targetFolderId: target.targetFolderId,
      targetFolderPath: target.targetFolderPath,
      kind: 'document_verify',
      status: targetResultStatus(result),
      ...(result.exceptions[0] ? { error: result.exceptions[0].message } : {}),
      startedAt: now,
      endedAt: now,
      details: boundedExceptionDetails(result),
    };
    const index = current.items.findIndex((candidate) => candidate.id === itemId);
    const items = [...current.items];
    if (index >= 0) items[index] = item;
    else items.push(item);
    return { ...current, items };
  });
  if (!updated) throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job disappeared before target result persistence.');
  publishStoredItem(context, itemId);
}

function persistTargetResultsIndependently(
  context: RuntimeContext,
  results: readonly DashboardSafeCopyTargetResult[],
): boolean {
  let failed = false;
  for (const result of results) {
    try {
      persistTargetResult(context, result);
    } catch {
      failed = true;
    }
  }
  return !failed;
}

function storedTargetResultMatches(
  context: RuntimeContext,
  result: DashboardSafeCopyTargetResult,
): boolean {
  const item = context.services.getJob(context.jobId)?.items.find((candidate) => (
    candidate.id === targetResultItemId(result.targetId)
  ));
  return item?.status === targetResultStatus(result)
    && sha256(item.details) === sha256(boundedExceptionDetails(result));
}

function jobTargetStatus(job: MigrationJob, targetId: string): 'succeeded' | 'needs_attention' | 'pending' {
  const result = job.items.find((item) => item.id === targetResultItemId(targetId));
  if (result?.details?.safeCopyTargetStatus === 'succeeded') return 'succeeded';
  if (result) return 'needs_attention';
  const preparation = preparationSummary(job, targetId);
  if (preparation?.details?.safeCopyTargetStatus === 'needs_attention' || preparation?.status === 'failed') {
    return 'needs_attention';
  }
  return 'pending';
}

function finalizeJob(context: RuntimeContext): MigrationJob {
  const updated = context.services.updateJobAtomically(context.jobId, (current) => {
    if (!isDashboardSafeCopyJob(current)) return current;
    if (current.status === 'canceled') return current;
    const hasUnresolvedAttempt = current.items.some((item) => {
      if (item.details?.safeCopyAttempt !== true) return false;
      const state = detailsString(item.details, 'safeCopyAttemptState');
      return state !== 'verified' && state !== 'failed_prewrite';
    });
    if (hasUnresolvedAttempt) {
      return {
        ...current,
        status: 'pending',
        endedAt: undefined,
        details: {
          ...(current.details || {}),
          safeCopyExecutionState: 'reconciliation_required',
        },
      };
    }
    const states = (current.targets || []).map((target) => jobTargetStatus(current, target.id));
    const succeeded = states.filter((state) => state === 'succeeded').length;
    const pending = states.filter((state) => state === 'pending').length;
    if (pending > 0) return current;
    const status: MigrationJob['status'] = succeeded === states.length
      ? 'succeeded'
      : succeeded > 0
        ? 'partial'
        : 'failed';
    return {
      ...current,
      status,
      endedAt: context.services.now(),
      details: {
        ...(current.details || {}),
        safeCopyExecutionState: status === 'succeeded' ? 'complete' : 'needs_attention',
        safeCopySucceededTargetCount: succeeded,
        safeCopyNeedsAttentionTargetCount: states.length - succeeded,
      },
    };
  });
  if (!updated) throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job disappeared before finalization.');
  return publishStoredJob(context, context.jobId) || updated;
}

function parseTargetState(context: RuntimeContext, targetId: string): DashboardSafeCopyTargetState {
  const job = context.services.getJob(context.jobId);
  if (!job || !isDashboardSafeCopyJob(job)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy retry ledger is unavailable.');
  }
  const attempts = job.items
    .filter((item) => item.targetId === targetId && item.details?.safeCopyAttempt === true)
    .map((item) => parseAttemptItem(item));
  if (attempts.some((attempt) => !attempt)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_ATTEMPT_EVIDENCE_INVALID', 'The safe-copy retry ledger contains malformed evidence.');
  }
  const status = jobTargetStatus(job, targetId);
  return {
    status: status === 'pending'
      ? job.status === 'running' ? 'running' : 'unknown'
      : status,
    attempts: attempts as DashboardSafeCopyAttemptEvidence[],
  };
}

function claimRetryRequest(
  context: RuntimeContext,
  targetId: string,
  retryRequestId: string,
): 'claimed' | 'duplicate' | 'conflict' {
  const itemId = retryClaimItemId(targetId);
  const outcome: { value: 'claimed' | 'duplicate' | 'conflict' } = { value: 'conflict' };
  const updated = context.services.updateJobAtomically(context.jobId, (current) => {
    if (!isDashboardSafeCopyJob(current) || current.status === 'canceled') return current;
    const requestMatch = current.items.find((item) => (
      item.details?.safeCopyRetryClaim === true
      && item.details?.safeCopyRetryRequestId === retryRequestId
    ));
    if (requestMatch) {
      outcome.value = requestMatch.targetId === targetId ? 'duplicate' : 'conflict';
      return current;
    }
    if (current.status === 'running') return current;
    const target = targetForJob(current, targetId);
    if (!target || jobTargetStatus(current, targetId) === 'succeeded') return current;
    const now = context.services.now();
    const item: MigrationJobItem = {
      id: itemId,
      jobId: current.id,
      targetId,
      destinationId: target.destinationInstanceId,
      destinationLabel: target.destinationLabel || 'Destination',
      targetModelId: target.targetModelId,
      targetFolderId: target.targetFolderId,
      targetFolderPath: target.targetFolderPath,
      kind: 'document_verify',
      status: 'succeeded',
      startedAt: now,
      endedAt: now,
      details: {
        safeCopyRetryClaim: true,
        safeCopyRetryRequestId: retryRequestId,
      },
    };
    outcome.value = 'claimed';
    return {
      ...current,
      status: 'running',
      endedAt: undefined,
      details: { ...(current.details || {}), safeCopyExecutionState: 'retrying' },
      items: [
        ...current.items.filter((candidate) => !(
          candidate.targetId === targetId
          && candidate.details?.safeCopyRetryClaim === true
        )),
        item,
      ],
    };
  });
  if (!updated) return 'conflict';
  if (outcome.value === 'claimed') {
    publishStoredItem(context, itemId);
    publishStoredJob(context, context.jobId);
  }
  return outcome.value;
}

function retryCanReconcileAtAttemptCapacity(
  job: MigrationJob,
  intent: DashboardSafeCopyIntent,
  targetId: string,
): boolean {
  const attemptCount = job.items.filter((item) => item.details?.safeCopyAttempt === true).length;
  if (attemptCount < MAX_CLIENT_EVIDENCE_ATTEMPTS) return true;
  if (attemptCount !== MAX_CLIENT_EVIDENCE_ATTEMPTS) return false;
  const targetItems = job.items.filter((item) => (
    item.targetId === targetId && item.details?.safeCopyAttempt === true
  ));
  let attempts: DashboardSafeCopyAttemptEvidence[];
  try {
    attempts = targetItems.map((item) => {
      const parsed = parseAttemptItem(item);
      if (!parsed || !attemptMatchesPersistedScope(job, intent, parsed)) {
        throw new Error('The retry attempt scope is invalid.');
      }
      return parsed;
    });
  } catch {
    return false;
  }
  const reusableStates = new Set<DashboardSafeCopyAttemptEvidence['state']>([
    'dispatched',
    'uncertain',
    'verified',
  ]);
  const everyDocumentHasReusableEvidence = intent.source.documentIds.every((sourceDocumentId) => (
    attempts.some((attempt) => (
      attempt.operation === 'document_create'
      && attempt.sourceDocumentId === sourceDocumentId
      && reusableStates.has(attempt.state)
    ))
  ));
  if (!everyDocumentHasReusableEvidence) return false;
  const summary = preparationSummary(job, targetId);
  const patchCount = detailsNumber(summary?.details, 'safeCopyPatchCount');
  if (!Number.isSafeInteger(patchCount) || (patchCount || 0) < 0) return false;
  if (patchCount === 0) return true;
  return attempts.some((attempt) => (
    attempt.operation === 'semantic_update' && reusableStates.has(attempt.state)
  ));
}

async function reconcilePersistedAttempt(
  context: RuntimeContext,
  target: DashboardSafeCopyReprovedTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
): Promise<DashboardSafeCopyPersistedDocumentReconciliation> {
  if (!attempt.sourceDocumentId || !attempt.expectedPayloadHash || !attempt.chosenName) return { status: 'uncertain' };
  let document: DashboardSafeCopyPreparedDocument;
  try {
    document = await prepareDocument(context, target, attempt.sourceDocumentId);
  } catch {
    return { status: 'uncertain' };
  }
  if (
    document.sourceExportHash !== attempt.sourceExportHash
    || document.expectedPayloadHash !== attempt.expectedPayloadHash
  ) return { status: 'uncertain' };
  let inventory: DashboardSafeCopyScopeInventory;
  try {
    inventory = await readScopeInventory(context, target);
  } catch {
    return { status: 'uncertain' };
  }
  const baseline = new Set(attempt.preexistingDocumentIds || []);
  const auth = runtimeAuthorization(target);
  const candidates = inventory.documents.filter((row) => (
    !baseline.has(row.documentId)
    && canonicalText(row.name) === canonicalText(attempt.chosenName)
    && row.destinationInstanceId === auth.targetInput.destinationInstanceId
    && row.connectionId === auth.targetInput.connectionId
    && row.modelId === auth.targetInput.modelId
    && exactFolderDocument(auth.targetInput, row)
    && row.fingerprint === attempt.expectedPayloadHash
    && (!attempt.importedDocumentId || row.documentId === attempt.importedDocumentId)
    && (!attempt.importedIdentifier || row.identifier === attempt.importedIdentifier)
    && !(
      auth.targetInput.sourceInstanceId === auth.targetInput.destinationInstanceId
      && row.documentId === attempt.sourceDocumentId
    )
  ));
  if (candidates.length !== 1) return { status: 'uncertain' };
  return { status: 'candidate', liveDocument: candidates[0], preparedDocument: document };
}

function classifyWriteFailure(error: unknown): DashboardSafeCopyWriteFailure {
  return error instanceof SafeCopyRuntimeError ? error.writeFailure : 'uncertain';
}

function executorDependencies(
  context: RuntimeContext,
  onTargetResult?: DashboardSafeCopyExecutorDependencies['onTargetResult'],
): DashboardSafeCopyExecutorDependencies {
  return {
    reproveTarget: async (targetInput) => {
      // Gate before preparation (which can validate shared-model patches) or local queries.
      await assertWorkbookCopyRuntimeBoundary(context, targetInput);
      const semanticRecovery = verifiedSemanticRecoveryForExecution(context, targetInput);
      const prepared = await freshPreparedTarget(context, targetInput, Boolean(semanticRecovery));
      if (context.intent.deployment && (semanticRecovery || writePatches(prepared.target).length > 0)) {
        throw new SafeCopyRuntimeError('SAFE_COPY_REPAIR_REQUIRED', 'Model dependencies require a new Model Migrator repair and compatibility check.', 'definitely_not_committed');
      }
      const reproved: DashboardSafeCopyReprovedTarget = {
        targetId: targetInput.targetId,
        scope: {
          destinationInstanceId: targetInput.destinationInstanceId,
          connectionId: targetInput.connectionId,
          modelId: targetInput.modelId,
          ...(targetInput.folderId ? { folderId: targetInput.folderId } : {}),
          ...(targetInput.folderPath ? { folderPath: targetInput.folderPath } : {}),
          scopeVerified: true,
        },
        semanticChange: semanticRecovery
          ? { mode: 'existing_file_update', ...semanticRecovery.proof }
          : semanticChangeForPreparedTarget(prepared),
        authorization: authorization(context, targetInput, prepared),
      };
      if (
        semanticRecovery
        && await reconcileSemanticChange(context, reproved, semanticRecovery.attempt) !== 'verified'
      ) {
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_SEMANTIC_REPROOF_CHANGED',
          'The verified model-change postcondition is no longer present on the destination.',
        );
      }
      return reproved;
    },
    applySemanticChange: (target, attempt, guard) => applySemanticChange(context, target, attempt, guard),
    reconcileSemanticChange: (target, attempt) => reconcileSemanticChange(context, target, attempt),
    prepareDocument: (target, sourceDocumentId) => prepareDocument(context, target, sourceDocumentId),
    readDestinationScope: (target) => readScopeInventory(context, target),
    createDocument: async (target, document, chosenName, _attempt, guard) => {
      const auth = runtimeAuthorization(target);
      const content = materializeDashboardSafeCopyDocumentContent(document.content);
      let dispatchDestination: SavedInstance;
      try {
        dispatchDestination = await reproveImmediatelyBeforeDocumentWrite(context, target);
        await recheckDeploymentSnapshots(context, auth, document.sourceDocumentId);
        assertDispatchIsCurrent(context, auth, guard);
      } catch (error) {
        if (error instanceof SafeCopyRuntimeError) throw error;
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_DOCUMENT_REPROOF_FAILED',
          'The destination authority changed before the dashboard write.',
          'definitely_not_committed',
        );
      }
      let result: Awaited<ReturnType<SafeCopyRuntimeClient['createDashboardSafeCopyDocument']>>;
      try {
        result = await clientFor(context, dispatchDestination).createDashboardSafeCopyDocument({
          modelId: auth.targetInput.modelId,
          name: chosenName,
          ...(auth.targetInput.folderId ? { folderId: auth.targetInput.folderId } : {}),
          content,
        }, { signal: guard?.signal, assertCanDispatch: () => assertDispatchIsCurrent(context, auth, guard) });
      } catch (error) {
        if (error instanceof OmniWriteNotDispatchedError && error.reason instanceof SafeCopyRuntimeError) throw error.reason;
        const definitelyNotCommitted = error instanceof OmniWriteNotDispatchedError || error instanceof OmniClientError
          && [400, 401, 403, 404, 409, 412, 422].includes(error.httpStatus);
        throw new SafeCopyRuntimeError(
          'SAFE_COPY_DOCUMENT_CREATE_FAILED',
          'The content-only dashboard create did not return a verified response.',
          definitelyNotCommitted ? 'definitely_not_committed' : 'uncertain',
        );
      }
      return { documentId: result.id, identifier: result.identifier };
    },
    verifyDocument: (target, document, live) => verifyDocument(context, target, document, live),
    persistVerifiedProvenance: async (provenance) => persistVerifiedProvenance(context, provenance),
    persistAttempt: async (attempt) => persistAttempt(context, attempt),
    loadTargetState: async (_jobId, targetId) => parseTargetState(context, targetId),
    claimRetryRequest: async (_jobId, targetId, retryRequestId) => claimRetryRequest(context, targetId, retryRequestId),
    reconcilePersistedAttempt: (target, attempt) => reconcilePersistedAttempt(context, target, attempt),
    ...(onTargetResult ? { onTargetResult } : {}),
    classifyWriteFailure,
    randomId: context.services.randomId,
    now: context.services.now,
    targetConcurrency: 2,
    targetDeadlineMs: context.services.targetDeadlineMs,
    resolverVersion: SAFE_COPY_RUNTIME_VERSION,
    verifierVersion: SAFE_COPY_VERIFIER_VERSION,
  };
}

export function dashboardSafeCopyIntentFromJob(job: MigrationJob): DashboardSafeCopyIntent {
  if (!isDashboardSafeCopyJob(job) || !job.sourceConnectionId || !job.targets) {
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_INVALID', 'The stored job is not a canonical safe-copy job.');
  }
  const requestId = detailsString(job.details, 'safeCopyRequestId');
  if (!requestId || job.targets.length === 0) {
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_INVALID', 'The stored safe-copy request is incomplete.');
  }
  const intent = parseDashboardSafeCopyIntent({
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId,
    source: {
      instanceId: job.sourceId,
      connectionId: job.sourceConnectionId,
      documentIds: [...job.documentIds],
    },
    destinations: job.targets.map((target) => ({
      targetId: target.id,
      instanceId: target.destinationInstanceId,
      connectionId: target.targetConnectionId || '',
      modelId: target.targetModelId,
      ...(target.targetFolderId ? { folderId: target.targetFolderId } : {}),
      ...(target.targetFolderPath ? { folderPath: target.targetFolderPath } : {}),
      ...(target.workbookCopy ? { workbookCopy: { ...target.workbookCopy } } : {}),
      ...(target.topicMappings?.length ? { topicMappings: target.topicMappings.map((mapping) => ({
        sourceTopicName: mapping.sourceTopicName, action: mapping.action, targetTopicName: mapping.targetTopicName,
      })) } : {}),
      ...(target.queryViewMappings?.length ? { queryViewMappings: target.queryViewMappings.map((mapping) => ({
        sourceQueryViewName: mapping.sourceQueryViewName, action: mapping.action, targetQueryViewName: mapping.targetQueryViewName,
      })) } : {}),
    })),
    ...(job.details?.safeCopyDeployment ? { deployment: job.details.safeCopyDeployment } : {}),
  });
  if (detailsString(job.details, 'safeCopyIntentHash') !== dashboardSafeCopyIntentHash(intent)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_INVALID', 'The stored safe-copy request fingerprint does not match its canonical scope.');
  }
  return intent;
}

export interface DashboardSafeCopyClientVerifiedDocument {
  targetId: string;
  sourceDocumentId: string;
  importedDocumentId: string;
  importedIdentifier: string;
  chosenTargetName: string;
  verifiedAt: number;
}

export interface DashboardSafeCopyClientEvidence {
  version: 1;
  jobId: string;
  evidenceRevision: number;
  complete: boolean;
  invalidTargetIds: string[];
  validatedAttemptIds: string[];
  verifiedDocuments: DashboardSafeCopyClientVerifiedDocument[];
}

const safeCopyClientEvidenceCache = new Map<string, {
  revision: number;
  source: MigrationJob;
  evidence: DashboardSafeCopyClientEvidence;
}>();

function attachDashboardSafeCopyClientEvidence(
  job: MigrationJob,
  evidence: DashboardSafeCopyClientEvidence,
): MigrationJob {
  return {
    ...job,
    details: {
      ...(job.details || {}),
      safeCopyClientEvidence: evidence,
    },
  };
}

function cacheDashboardSafeCopyClientEvidence(
  job: MigrationJob,
  evidence: DashboardSafeCopyClientEvidence,
): MigrationJob {
  safeCopyClientEvidenceCache.delete(job.id);
  safeCopyClientEvidenceCache.set(job.id, { revision: evidence.evidenceRevision, source: job, evidence });
  while (safeCopyClientEvidenceCache.size > 100) {
    const oldest = safeCopyClientEvidenceCache.keys().next().value as string | undefined;
    if (!oldest) break;
    safeCopyClientEvidenceCache.delete(oldest);
  }
  return attachDashboardSafeCopyClientEvidence(job, evidence);
}

export function withDashboardSafeCopyClientEvidence(job: MigrationJob): MigrationJob {
  if (!isDashboardSafeCopyJob(job)) return job;
  const evidenceRevision = detailsNumber(job.details, 'safeCopyEvidenceRevision') || 0;
  const cached = safeCopyClientEvidenceCache.get(job.id);
  if (cached?.revision === evidenceRevision && cached.source === job) {
    return attachDashboardSafeCopyClientEvidence(job, cached.evidence);
  }
  const invalidTargetIds = new Set<string>();
  const verifiedDocuments: DashboardSafeCopyClientVerifiedDocument[] = [];
  const invalidateEveryTarget = (complete: boolean): MigrationJob => cacheDashboardSafeCopyClientEvidence(job, {
    version: 1,
    jobId: job.id,
    evidenceRevision,
    complete,
    invalidTargetIds: [...new Set((job.targets || []).map((target) => target.id))].sort().slice(0, 100),
    validatedAttemptIds: [],
    verifiedDocuments: [],
  });
  let intent: DashboardSafeCopyIntent;
  try {
    intent = dashboardSafeCopyIntentFromJob(job);
  } catch {
    return invalidateEveryTarget(false);
  }

  const safeEvidenceItems = job.items.filter((item) => (
    item.details?.safeCopyAttempt === true || isRecord(item.details?.safeCopyDocumentProvenance)
  ));
  if (
    intent.source.documentIds.length * intent.destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS
    || safeEvidenceItems.length > MAX_CLIENT_EVIDENCE_ITEMS
  ) return invalidateEveryTarget(false);
  const itemIds = new Set<string>();
  const itemById = new Map<string, MigrationJobItem>();
  let globallyInvalid = false;
  for (const item of safeEvidenceItems) {
    if (itemIds.has(item.id)) {
      globallyInvalid = true;
    }
    itemIds.add(item.id);
    itemById.set(item.id, item);
  }

  const attemptsByScope = new Map<string, DashboardSafeCopyAttemptEvidence[]>();
  const validatedAttempts: DashboardSafeCopyAttemptEvidence[] = [];
  for (const item of safeEvidenceItems) {
    if (item.details?.safeCopyAttempt !== true) continue;
    try {
      const attempt = parseAttemptItem(item);
      if (!attempt || attempt.jobId !== job.id) throw new Error('invalid attempt scope');
      const target = (job.targets || []).find((candidate) => candidate.id === attempt.targetId);
      if (
        !target
        || attempt.destinationInstanceId !== target.destinationInstanceId
        || attempt.connectionId !== target.targetConnectionId
        || attempt.modelId !== target.targetModelId
        || (attempt.folderId || '') !== (target.targetFolderId || '')
        || (attempt.folderPath || '') !== (target.targetFolderPath || '')
        || (
          attempt.operation === 'document_create'
          && (!attempt.sourceDocumentId || !intent.source.documentIds.includes(attempt.sourceDocumentId))
        )
      ) throw new Error('invalid attempt target scope');
      validatedAttempts.push(attempt);
      const scope = `${attempt.targetId}\u0000${attempt.sourceDocumentId || ''}`;
      const scopedAttempts = attemptsByScope.get(scope) || [];
      scopedAttempts.push(attempt);
      attemptsByScope.set(scope, scopedAttempts);
    } catch {
      const knownTarget = item.targetId && (job.targets || []).some((target) => target.id === item.targetId);
      if (knownTarget && item.targetId) invalidTargetIds.add(item.targetId);
      else globallyInvalid = true;
    }
  }
  if (globallyInvalid || validatedAttempts.length > MAX_CLIENT_EVIDENCE_ATTEMPTS) {
    return invalidateEveryTarget(validatedAttempts.length <= MAX_CLIENT_EVIDENCE_ATTEMPTS);
  }

  for (const target of job.targets || []) {
    if (invalidTargetIds.has(target.id)) continue;
    for (const sourceDocumentId of intent.source.documentIds) {
      const candidates = (attemptsByScope.get(`${target.id}\u0000${sourceDocumentId}`) || []).filter((attempt) => (
        attempt.operation === 'document_create'
        && attempt.state === 'verified'
      ));
      const proofs = candidates.flatMap((attempt) => {
        const proof = verifiedDocumentFromDurableAttempt(
          job,
          intent,
          target,
          attempt,
          itemById.get(verificationItemId(attempt.attemptId)),
        );
        return proof?.importedDocumentId
          && proof.importedIdentifier
          && proof.chosenName
          && attempt.verifiedAt
          ? [{
            targetId: target.id,
            sourceDocumentId,
            importedDocumentId: proof.importedDocumentId,
            importedIdentifier: proof.importedIdentifier,
            chosenTargetName: proof.chosenName,
            verifiedAt: attempt.verifiedAt,
          }]
          : [];
      });
      if (candidates.length === 1 && proofs.length === 1) verifiedDocuments.push(proofs[0]);
      else if (candidates.length > 0) invalidTargetIds.add(target.id);
    }
  }
  if (verifiedDocuments.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS) return invalidateEveryTarget(false);

  const evidence: DashboardSafeCopyClientEvidence = {
    version: 1,
    jobId: job.id,
    evidenceRevision,
    complete: true,
    invalidTargetIds: [...invalidTargetIds].filter((targetId) => (
      (job.targets || []).some((target) => target.id === targetId)
    )).sort().slice(0, 100),
    validatedAttemptIds: validatedAttempts
      .filter((attempt) => !invalidTargetIds.has(attempt.targetId))
      .map((attempt) => attempt.attemptId)
      .sort(),
    verifiedDocuments: verifiedDocuments
      .filter((document) => !invalidTargetIds.has(document.targetId))
      .sort((left, right) => (
        left.targetId.localeCompare(right.targetId)
        || left.sourceDocumentId.localeCompare(right.sourceDocumentId)
      )),
  };
  return cacheDashboardSafeCopyClientEvidence(job, evidence);
}

function createContext(
  job: MigrationJob,
  intent: DashboardSafeCopyIntent,
  services: DashboardSafeCopyRuntimeServices,
): RuntimeContext {
  return {
    intent,
    jobId: job.id,
    job,
    services: defaultServices(services),
    clients: new Map(),
    expectedQuerySets: new Map(),
  };
}

function setupFailure(targetId: string): DashboardSafeCopyTargetResult {
  return {
    targetId,
    status: 'needs_attention',
    documents: [],
    exceptions: [{
      code: 'TARGET_REPROOF_FAILED',
      targetId,
      message: 'The destination folder and model scope could not be resolved exactly.',
      retryable: true,
    }],
  };
}

async function executableTargets(
  context: RuntimeContext,
  targetIds?: ReadonlySet<string>,
  options: {
    allowNeedsAttention?: boolean;
    verifiedDocumentIdsByTarget?: ReadonlyMap<string, readonly string[]>;
    verifiedSemanticChangesByTarget?: ReadonlyMap<
      string,
      NonNullable<DashboardSafeCopyExecutionTarget['skipSemanticChange']>
    >;
  } = {},
): Promise<{ targets: DashboardSafeCopyExecutionTarget[]; failures: DashboardSafeCopyTargetResult[] }> {
  const destinations = context.intent.destinations.filter((destination) => (
    !targetIds || targetIds.has(destination.targetId)
  ));
  const results = await mapWithConcurrency(destinations, 2, async (destination) => {
    const deadlineMs = Math.max(1_000, context.services.targetDeadlineMs || DEFAULT_RUNTIME_TARGET_DEADLINE_MS);
    const setupStartedAt = context.services.now();
    const summary = preparationSummary(context.services.getJob(context.jobId) || context.job, destination.targetId);
    const targetState = jobTargetStatus(context.services.getJob(context.jobId) || context.job, destination.targetId);
    if (
      targetState !== 'pending'
      && !(options.allowNeedsAttention === true && targetState === 'needs_attention')
    ) return { type: 'skip' as const };
    if (!summary || summary.status !== 'succeeded' || summary.details?.safeCopyTargetStatus !== 'ready') {
      return { type: 'skip' as const };
    }
    try {
      const canonical = await withRuntimeDeadline(canonicalDestination(context, destination), deadlineMs);
      const verifiedDocumentIds = options.verifiedDocumentIdsByTarget?.get(destination.targetId) || [];
      const verifiedSemanticChange = options.verifiedSemanticChangesByTarget?.get(destination.targetId);
      return {
        type: 'target' as const,
        target: {
          ...canonical,
          ...(verifiedDocumentIds.length > 0 ? { skipDocumentIds: [...verifiedDocumentIds] } : {}),
          ...(verifiedSemanticChange ? { skipSemanticChange: { ...verifiedSemanticChange } } : {}),
        },
        remainingDeadlineMs: Math.max(0, deadlineMs - Math.max(0, context.services.now() - setupStartedAt)),
      };
    } catch {
      return { type: 'failure' as const, failure: setupFailure(destination.targetId) };
    }
  });
  return {
    targets: results.flatMap((result) => result.type === 'target' ? [{
      ...result.target,
      // Scheduler wait behind an unrelated target is not charged to this target's own work budget.
      deadlineAt: context.services.now() + result.remainingDeadlineMs,
    }] : []),
    failures: results.flatMap((result) => result.type === 'failure' ? [result.failure] : []),
  };
}

function markExecutionStarting(context: RuntimeContext): MigrationJob {
  const updated = context.services.updateJobAtomically(context.jobId, (current) => {
    if (!isDashboardSafeCopyJob(current) || current.status === 'canceled') return current;
    return {
      ...current,
      status: 'running',
      startedAt: current.startedAt || context.services.now(),
      endedAt: undefined,
      details: { ...(current.details || {}), safeCopyExecutionState: 'preparing_to_copy' },
    };
  });
  if (!updated) throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job disappeared before execution.');
  publishStoredJob(context, context.jobId);
  return updated;
}

const activeRuntimeJobs = new Set<string>();

function recordRuntimeFailure(
  jobId: string,
  services: DashboardSafeCopyRuntimeServices,
): MigrationJob | undefined {
  const resolved = defaultServices(services);
  const updated = resolved.updateJobAtomically(jobId, (current) => {
    if (!isDashboardSafeCopyJob(current) || current.status === 'canceled') return current;
    const hasUncertainWrite = current.items.some((item) => {
      const state = item.details?.safeCopyAttemptState;
      return state === 'dispatched' || state === 'uncertain';
    });
    return {
      ...current,
      status: hasUncertainWrite ? 'pending' : 'failed',
      ...(hasUncertainWrite ? { endedAt: undefined } : { endedAt: resolved.now() }),
      details: {
        ...(current.details || {}),
        safeCopyExecutionState: hasUncertainWrite ? 'reconciliation_required' : 'needs_attention',
        safeCopyRuntimeErrorCode: 'SAFE_COPY_RUNTIME_FAILED',
        safeCopyRuntimeError: 'Safe-copy execution stopped before the next write could be safely dispatched.',
      },
    };
  });
  if (updated) resolved.publishMigrationJobEvent({
    type: 'job',
    jobId,
    status: updated.status,
    at: resolved.now(),
    job: updated,
  });
  return updated;
}

export async function runDashboardSafeCopyJob(
  jobId: string,
  rawIntent: DashboardSafeCopyIntent,
  services: DashboardSafeCopyRuntimeServices = {},
): Promise<DashboardSafeCopyRuntimeResult> {
  if (activeRuntimeJobs.has(jobId)) {
    const existing = (services.getJob || getJob)(jobId);
    if (!existing) throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job is unavailable.');
    return { job: existing };
  }
  activeRuntimeJobs.add(jobId);
  try {
    const intent = canonicalDashboardSafeCopyIntent(rawIntent);
    const beforePreparation = (services.getJob || getJob)(jobId);
    if (beforePreparation && isDashboardSafeCopyJob(beforePreparation)
      && !['canceled', 'succeeded', 'partial'].includes(beforePreparation.status)
      && beforePreparation.details?.safeCopyExecutionState !== 'reconciliation_required') {
      const boundaryContext = createContext(beforePreparation, intent, services);
      try {
        // Legacy preparation can use scratch branches. Inspect workbook scope before it.
        // Source extension evidence is target-independent; do not reread it once per instance here.
        const destination = intent.destinations.find((candidate) => candidate.workbookCopy) || intent.destinations[0];
        await assertWorkbookCopyRuntimeBoundary(boundaryContext, {
          targetId: destination.targetId, sourceInstanceId: intent.source.instanceId,
          sourceConnectionId: intent.source.connectionId, destinationInstanceId: destination.instanceId,
          connectionId: destination.connectionId, modelId: destination.modelId,
          sourceDocumentIds: intent.source.documentIds,
          ...(destination.workbookCopy ? { workbookCopy: destination.workbookCopy } : {}),
        });
      } catch (error) {
        if (!(error instanceof SafeCopyRuntimeError) || error.code !== 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED') throw error;
        const execution: DashboardSafeCopyExecutionResult = {
          jobId, status: 'needs_attention', targets: intent.destinations.map((destination) => ({
            targetId: destination.targetId, status: 'needs_attention', documents: [],
            exceptions: [{ code: 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED', targetId: destination.targetId,
              retryable: false, message: SAFE_COPY_EXCEPTION_MESSAGES.WORKBOOK_COPY_CAPABILITY_UNVERIFIED }],
          })),
        };
        if (!persistTargetResultsIndependently(boundaryContext, execution.targets)) {
          return { job: recordRuntimeFailure(jobId, services) || beforePreparation, execution };
        }
        return { job: finalizeJob(boundaryContext), execution };
      }
    }
    await (services.prepareJob || prepareDashboardSafeCopyJob)(jobId, intent);
    const job = (services.getJob || getJob)(jobId);
    if (!job || !isDashboardSafeCopyJob(job)) {
      throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job is unavailable after preparation.');
    }
    if (job.status === 'canceled' || ['succeeded', 'partial'].includes(job.status)) return { job };
    if (job.details?.safeCopyExecutionState === 'reconciliation_required') return { job };
    const context = createContext(job, intent, services);
    const latest = markExecutionStarting(context);
    if (latest.status === 'canceled') return { job: latest };
    const recovery = materializeVerifiedAttemptResults(context);
    if (!recovery.persisted) {
      return { job: recordRuntimeFailure(jobId, services) || context.services.getJob(jobId) || job };
    }
    const prepared = await executableTargets(context, undefined, {
      verifiedDocumentIdsByTarget: recovery.verifiedDocumentIdsByTarget,
      verifiedSemanticChangesByTarget: recovery.verifiedSemanticChangesByTarget,
    });
    const setupResultsPersisted = persistTargetResultsIndependently(context, prepared.failures);
    if (prepared.targets.length === 0) {
      if (!setupResultsPersisted) {
        return { job: recordRuntimeFailure(jobId, services) || context.services.getJob(jobId) || job };
      }
      return { job: finalizeJob(context) };
    }
    const input: DashboardSafeCopyExecutionInput = { jobId, targets: prepared.targets };
    const rawExecution = await context.services.execute(input, executorDependencies(context, async (rawResult) => {
      try {
        persistTargetResult(context, sanitizeTargetResult(rawResult));
      } catch {
        // A final exact-ledger pass retries this result without delaying independent targets.
      }
    }));
    const execution: DashboardSafeCopyExecutionResult = {
      ...rawExecution,
      targets: rawExecution.targets.map(sanitizeTargetResult),
    };
    const remainingResults = execution.targets.filter((result) => !storedTargetResultMatches(context, result));
    const executionResultsPersisted = persistTargetResultsIndependently(context, remainingResults)
      && execution.targets.every((result) => storedTargetResultMatches(context, result));
    if (!setupResultsPersisted || !executionResultsPersisted) {
      return {
        job: recordRuntimeFailure(jobId, services) || context.services.getJob(jobId) || job,
        execution,
      };
    }
    return { job: finalizeJob(context), execution };
  } finally {
    activeRuntimeJobs.delete(jobId);
    releaseMigrationDestinationModelsByPrefix(`safe-copy:${jobId}:`);
  }
}

export async function prepareAndRunDashboardSafeCopyJob(
  jobId: string,
  intent: DashboardSafeCopyIntent,
): Promise<void> {
  try {
    await runDashboardSafeCopyJob(jobId, intent);
  } catch {
    recordRuntimeFailure(jobId, {});
  }
}

export async function retryDashboardSafeCopyJobTarget(
  jobId: string,
  targetId: string,
  retryRequestId: string,
  services: DashboardSafeCopyRuntimeServices = {},
): Promise<DashboardSafeCopyRuntimeResult> {
  try {
  const job = (services.getJob || getJob)(jobId);
  if (!job || !isDashboardSafeCopyJob(job)) {
    throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy retry job is unavailable.');
  }
  if (jobTargetStatus(job, targetId) === 'succeeded') return { job };
  const intent = dashboardSafeCopyIntentFromJob(job);
  const context = createContext(job, intent, services);
  const recovery = materializeVerifiedAttemptResults(context);
  if (!recovery.persisted) {
    return { job: recordRuntimeFailure(jobId, services) || context.services.getJob(jobId) || job };
  }
  const materializedJob = context.services.getJob(jobId) || job;
  if (!retryCanReconcileAtAttemptCapacity(materializedJob, intent, targetId)) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_IDEMPOTENCY_CONFLICT',
      'This destination retry would exceed the bounded write-attempt ledger.',
      409,
    );
  }
  const prepared = await executableTargets(
    context,
    new Set([targetId]),
    {
      allowNeedsAttention: true,
      verifiedDocumentIdsByTarget: recovery.verifiedDocumentIdsByTarget,
      verifiedSemanticChangesByTarget: recovery.verifiedSemanticChangesByTarget,
    },
  );
  if (prepared.failures.length > 0 || prepared.targets.length !== 1) {
    const result = prepared.failures[0] || setupFailure(targetId);
    persistTargetResult(context, result);
    return { job: finalizeJob(context) };
  }
  const input: DashboardSafeCopyExecutionInput = { jobId, targets: prepared.targets };
  const rawResult = await context.services.retryTarget(
    input,
    targetId,
    retryRequestId,
    executorDependencies(context),
  );
  const retryOutcome = rawResult.exceptions[0]?.code;
  if (retryOutcome === 'RETRY_REQUEST_DUPLICATE') {
    return { job: context.services.getJob(jobId) || job };
  }
  if (retryOutcome === 'RETRY_REQUEST_CONFLICT') {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_IDEMPOTENCY_CONFLICT',
      'This destination retry conflicts with an existing retry request.',
      409,
    );
  }
  const result = sanitizeTargetResult(rawResult);
  if (!persistTargetResultsIndependently(context, [result])) {
    return {
      job: recordRuntimeFailure(jobId, services) || context.services.getJob(jobId) || job,
      execution: { jobId, status: 'needs_attention', targets: [result] },
    };
  }
  return {
    job: finalizeJob(context),
    execution: { jobId, status: result.status === 'succeeded' ? 'succeeded' : result.status === 'partial' ? 'partial' : 'needs_attention', targets: [result] },
  };
  } finally {
    releaseMigrationDestinationModelsByPrefix(`safe-copy:${jobId}:`);
  }
}

export async function createDashboardSafeCopyRuntimeAdapterForTests(
  jobId: string,
  services: DashboardSafeCopyRuntimeServices = {},
): Promise<{
  input: DashboardSafeCopyExecutionInput;
  dependencies: DashboardSafeCopyExecutorDependencies;
}> {
  // Test adapters invoke dependency callbacks outside the production run/retry finally blocks.
  releaseMigrationDestinationModelsByPrefix(`safe-copy:${jobId}:`);
  const job = (services.getJob || getJob)(jobId);
  if (!job) throw new SafeCopyRuntimeError('SAFE_COPY_JOB_MISSING', 'The safe-copy job is unavailable.');
  const intent = dashboardSafeCopyIntentFromJob(job);
  const context = createContext(job, intent, services);
  const prepared = await executableTargets(context);
  if (prepared.failures.length > 0) throw new SafeCopyRuntimeError('SAFE_COPY_TARGET_REPROOF_FAILED', 'A destination could not be canonicalized.');
  return {
    input: { jobId, targets: prepared.targets },
    dependencies: executorDependencies(context),
  };
}
