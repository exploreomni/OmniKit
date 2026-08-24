import type {
  DashboardSafeCopyIntentInput,
  InstanceModel,
  MigrationJob,
  ModelMigratorConnection,
  SavedInstancePublic,
} from '@/services/opsConsole';
import { DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS } from '../../../shared/dashboardSafeCopyContract';

export { DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS };

export const DASHBOARD_SAFE_COPY_DRAFT_STORAGE_KEY = 'omnikit:dashboardSafeCopyDraft:v1';
const CANONICAL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DashboardSafeCopyStep = 0 | 1 | 2 | 3;

export interface DashboardSafeCopyTopicMappingDraft {
  sourceTopicName: string;
  sourceTopicId?: string;
  action: 'map_existing' | 'copy_source' | 'unresolved';
  targetTopicName: string;
}

export interface DashboardSafeCopyQueryViewMappingDraft {
  sourceQueryViewName: string;
  sourceFileName?: string;
  action: 'map_existing' | 'copy_source' | 'unresolved';
  targetQueryViewName: string;
  targetFileName?: string;
}

type DashboardSafeCopyExecutableTopicMapping = Omit<DashboardSafeCopyTopicMappingDraft, 'action'> & {
  action: 'map_existing' | 'copy_source';
};

type DashboardSafeCopyExecutableQueryViewMapping = Omit<DashboardSafeCopyQueryViewMappingDraft, 'action'> & {
  action: 'map_existing' | 'copy_source';
};

function isExecutableTopicMapping(
  mapping: DashboardSafeCopyTopicMappingDraft,
): mapping is DashboardSafeCopyExecutableTopicMapping {
  return mapping.action === 'map_existing' || mapping.action === 'copy_source';
}

function isExecutableQueryViewMapping(
  mapping: DashboardSafeCopyQueryViewMappingDraft,
): mapping is DashboardSafeCopyExecutableQueryViewMapping {
  return mapping.action === 'map_existing' || mapping.action === 'copy_source';
}

export interface DashboardSafeCopyDestinationDraft {
  targetId: string;
  instanceId: string;
  connectionId: string;
  modelId: string;
  requiresModelChoice?: boolean;
  topicMappings?: DashboardSafeCopyTopicMappingDraft[];
  queryViewMappings?: DashboardSafeCopyQueryViewMappingDraft[];
}

export interface DashboardSafeCopyDraft {
  version: 1;
  step: DashboardSafeCopyStep;
  requestId: string;
  jobId?: string;
  sourceId: string;
  sourceConnectionId: string;
  selectedDocumentIds: string[];
  destinations: DashboardSafeCopyDestinationDraft[];
  emptyFirst?: boolean;
  deleteSourceOnSuccess?: boolean;
  refreshSchemaOnComplete?: boolean;
}

export interface DashboardSafeCopyDestinationResolution {
  connectionId: string;
  modelId: string;
  needsConnection: boolean;
  needsModel: boolean;
}

export type DashboardSafeCopyTargetPhase =
  | 'preparing'
  | 'ready'
  | 'copying'
  | 'verifying'
  | 'reconciliation_required'
  | 'succeeded'
  | 'canceled'
  | 'needs_attention';

export type DashboardSafeCopyTargetStage = 'prepare' | 'copy' | 'verify' | 'complete';

export type DashboardSafeCopyDocumentPhase =
  | 'waiting'
  | 'copying'
  | 'verifying'
  | 'complete'
  | 'reconciliation_required'
  | 'canceled'
  | 'needs_attention';

export interface DashboardSafeCopyDocumentProgress {
  sourceDocumentId: string;
  sourceLabel: string;
  chosenTargetName?: string;
  phase: DashboardSafeCopyDocumentPhase;
  exceptionCode?: string;
  importedDocumentId?: string;
  verifiedDestinationIdentifier?: string;
  verifiedAt?: number;
}

export interface DashboardSafeCopyTargetProgress {
  targetId: string;
  destinationId: string;
  destinationLabel: string;
  modelId?: string;
  modelName?: string;
  phase: DashboardSafeCopyTargetPhase;
  globalHold: boolean;
  blocksNewScope: boolean;
  activeStage: DashboardSafeCopyTargetStage;
  completedStages: DashboardSafeCopyTargetStage[];
  documentCount: number;
  documents: DashboardSafeCopyDocumentProgress[];
  exceptionCodes: string[];
  recommendedActions: string[];
  message?: string;
}

export interface DashboardSafeCopyProgressProjectionOptions {
  defaultDocumentLimit?: number;
  documentLimitByTarget?: Readonly<Record<string, number>>;
  sourceLabelByDocumentId?: Readonly<Record<string, string>>;
}

export interface DashboardSafeCopyTargetActions {
  canRetry: boolean;
  canChooseAnotherModel: boolean;
  canOpenModelMigrator: boolean;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requestId(): string {
  const secureCrypto = globalThis.crypto;
  if (secureCrypto?.randomUUID) return secureCrypto.randomUUID();
  if (!secureCrypto?.getRandomValues) {
    throw new Error('Secure request IDs are unavailable in this browser, so a safe dashboard move cannot start.');
  }
  const bytes = secureCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newDashboardSafeCopyRequestId(): string {
  return requestId();
}

export function createDashboardSafeCopyDraft(): DashboardSafeCopyDraft {
  return {
    version: 1,
    step: 0,
    requestId: requestId(),
    sourceId: '',
    sourceConnectionId: '',
    selectedDocumentIds: [],
    destinations: [],
  };
}

export function readDashboardSafeCopyDraft(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.sessionStorage,
): DashboardSafeCopyDraft {
  if (!storage) return createDashboardSafeCopyDraft();
  try {
    const raw = storage.getItem(DASHBOARD_SAFE_COPY_DRAFT_STORAGE_KEY);
    if (!raw) return createDashboardSafeCopyDraft();
    const value = JSON.parse(raw) as Partial<DashboardSafeCopyDraft>;
    const storedRequestId = typeof value.requestId === 'string' ? value.requestId : '';
    const restoredRequestId = storedRequestId.toLowerCase();
    if (
      value.version !== 1
      || storedRequestId !== storedRequestId.trim()
      || !CANONICAL_REQUEST_ID.test(restoredRequestId)
    ) {
      return createDashboardSafeCopyDraft();
    }
    const jobId = typeof value.jobId === 'string' ? value.jobId : '';
    if (jobId && !CANONICAL_REQUEST_ID.test(jobId)) return createDashboardSafeCopyDraft();
    return {
      version: 1,
      step: jobId ? 3 : 0,
      requestId: restoredRequestId,
      ...(jobId ? { jobId } : {}),
      sourceId: '',
      sourceConnectionId: '',
      selectedDocumentIds: [],
      destinations: [],
    };
  } catch {
    return createDashboardSafeCopyDraft();
  }
}

export function writeDashboardSafeCopyDraft(
  draft: DashboardSafeCopyDraft,
  storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.sessionStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(DASHBOARD_SAFE_COPY_DRAFT_STORAGE_KEY, JSON.stringify({
      version: 1,
      requestId: draft.requestId,
      ...(draft.jobId ? { jobId: draft.jobId } : {}),
    }));
  } catch {
    // Session recovery is a convenience. The server job remains authoritative.
  }
}

export function resolveDashboardSafeCopyDestinationDefaults(input: {
  instance: Pick<SavedInstancePublic, 'defaultModelId'>;
  connections: ModelMigratorConnection[];
  models: InstanceModel[];
  current?: Pick<DashboardSafeCopyDestinationDraft, 'connectionId' | 'modelId'>;
}): DashboardSafeCopyDestinationResolution {
  const connections = input.connections.filter((row) => !row.deletedAt);
  const models = input.models.filter((row) => !row.deletedAt);
  const connectionIds = new Set(connections.map((row) => row.id));
  let connectionId = connectionIds.has(input.current?.connectionId || '') ? input.current?.connectionId || '' : '';
  const currentModel = models.find((row) => row.id === input.current?.modelId);
  let modelId = currentModel && (!connectionId || currentModel.connectionId === connectionId)
    ? currentModel.id
    : '';

  if (!connectionId && currentModel?.connectionId && connectionIds.has(currentModel.connectionId)) {
    connectionId = currentModel.connectionId;
  }

  const defaultModel = models.find((row) => row.id === input.instance.defaultModelId);
  if (!modelId && defaultModel) {
    if (connectionId) {
      if (defaultModel.connectionId === connectionId) modelId = defaultModel.id;
    } else if (defaultModel.connectionId && connectionIds.has(defaultModel.connectionId)) {
      connectionId = defaultModel.connectionId;
      modelId = defaultModel.id;
    }
  }
  if (!connectionId && connections.length === 1) connectionId = connections[0].id;

  const modelsForConnection = connectionId
    ? models.filter((row) => row.connectionId === connectionId)
    : models;
  if (!modelId && modelsForConnection.length === 1) modelId = modelsForConnection[0].id;

  return {
    connectionId,
    modelId,
    needsConnection: !connectionId,
    needsModel: !modelId,
  };
}

export function isDashboardSafeCopyTerminal(status: MigrationJob['status'] | undefined): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'canceled';
}

function isDashboardSafeCopyJob(job: MigrationJob): boolean {
  return job.workflow === 'dashboard'
    && job.details?.safeCopyProfile === 'safe_copy_v1'
    && job.details?.operationMode === 'safe_copy';
}

export function isDashboardSafeCopyJobForRequest(job: MigrationJob, requestId: string): boolean {
  return isDashboardSafeCopyJob(job)
    && CANONICAL_REQUEST_ID.test(job.id)
    && CANONICAL_REQUEST_ID.test(requestId)
    && job.details?.safeCopyRequestId === requestId;
}

export function dashboardSafeCopyJobEvidenceClock(job: MigrationJob): number {
  const revision = job.details?.safeCopyEvidenceRevision;
  if (
    typeof revision === 'number'
    && Number.isSafeInteger(revision)
    && revision > 0
    && revision <= Number.MAX_SAFE_INTEGER - SAFE_COPY_REVISION_CLOCK_BASE
  ) return SAFE_COPY_REVISION_CLOCK_BASE + revision;
  const timestamps: number[] = [job.createdAt, job.startedAt || 0, job.endedAt || 0];
  for (const item of job.items) {
    timestamps.push(item.startedAt || 0, item.endedAt || 0);
    const attemptId = typeof item.details?.safeCopyAttemptId === 'string'
      ? item.details.safeCopyAttemptId
      : '';
    const createdAt = item.details?.safeCopyAttemptCreatedAt;
    const updatedAt = item.details?.safeCopyAttemptUpdatedAt;
    if (
      item.details?.safeCopyAttempt === true
      && attemptId
      && item.id === `safe-copy-attempt:${attemptId}`
      && item.jobId === job.id
      && typeof createdAt === 'number'
      && Number.isSafeInteger(createdAt)
      && typeof updatedAt === 'number'
      && Number.isSafeInteger(updatedAt)
      && updatedAt >= createdAt
      && updatedAt <= Date.now() + MAX_FUTURE_CLOCK_SKEW_MS
    ) {
      timestamps.push(updatedAt);
    }
  }
  return Math.max(...timestamps);
}

export function shouldApplyDashboardSafeCopyJobSnapshot(
  current: MigrationJob,
  next: MigrationJob,
  options: { allowTerminalReopen?: boolean } = {},
): boolean {
  if (
    !isDashboardSafeCopyJob(current)
    || !isDashboardSafeCopyJob(next)
    || current.id !== next.id
    || current.details?.safeCopyRequestId !== next.details?.safeCopyRequestId
  ) return false;
  if (
    !options.allowTerminalReopen
    && isDashboardSafeCopyTerminal(current.status)
    && !isDashboardSafeCopyTerminal(next.status)
  ) return false;
  return dashboardSafeCopyJobEvidenceClock(next) > dashboardSafeCopyJobEvidenceClock(current);
}

const SAFE_COPY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_COPY_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_COPY_REVISION_CLOCK_BASE = 1_000_000_000_000_000;
const MAX_PROJECTED_CODES = 32;
const MAX_PROJECTED_TEXT = 1_024;
const MIN_VERIFIED_AT = Date.UTC(2000, 0, 1);
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_CLIENT_EVIDENCE_ATTEMPTS = 3_000;
const SAFE_COPY_CLIENT_EVIDENCE_KEYS = new Set([
  'version',
  'jobId',
  'evidenceRevision',
  'complete',
  'invalidTargetIds',
  'validatedAttemptIds',
  'verifiedDocuments',
]);
const SAFE_COPY_CLIENT_DOCUMENT_KEYS = new Set([
  'targetId',
  'sourceDocumentId',
  'importedDocumentId',
  'importedIdentifier',
  'chosenTargetName',
  'verifiedAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength = MAX_PROJECTED_TEXT): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) return '';
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) ? '' : value;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function detailStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((row) => {
    const candidate = boundedText(row, 64);
    return candidate && SAFE_COPY_CODE_PATTERN.test(candidate) ? [candidate] : [];
  }))].slice(0, MAX_PROJECTED_CODES);
}

function recommendedActionArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((row): row is string => (
    row === 'select_target_model' || row === 'open_model_migrator'
  )))];
}

function preparationExceptionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((row) => {
    if (!isRecord(row)) return [];
    const code = boundedText(row.code, 64);
    return code && SAFE_COPY_CODE_PATTERN.test(code) ? [code] : [];
  }))].slice(0, MAX_PROJECTED_CODES);
}

interface ProjectedAttempt {
  attemptId: string;
  operation: 'semantic_update' | 'document_create';
  state: 'dispatched' | 'failed_prewrite' | 'uncertain' | 'verified';
  sourceDocumentId?: string;
  chosenTargetName?: string;
  importedDocumentId?: string;
  importedIdentifier?: string;
  expectedPayloadHash?: string;
  publishedFingerprint?: string;
  verificationStartedAt?: number;
  updatedAt: number;
}

interface ProjectedResultDocument {
  sourceDocumentId: string;
  status: 'succeeded' | 'needs_attention';
  chosenTargetName?: string;
  exceptionCode?: string;
}

interface VerifiedDocumentProof {
  importedDocumentId: string;
  importedIdentifier: string;
  chosenTargetName: string;
  verifiedAt: number;
}

interface ProjectedClientEvidence {
  invalidTargetIds: Set<string>;
  validatedAttemptIds: Set<string>;
  verifiedDocuments: Map<string, VerifiedDocumentProof>;
}

function scopedAttempt(
  job: MigrationJob,
  target: NonNullable<MigrationJob['targets']>[number],
  value: MigrationJob['items'][number],
  sourceDocumentIds: ReadonlySet<string>,
): ProjectedAttempt | undefined {
  const details = value.details;
  if (!details || details.safeCopyAttempt !== true) return undefined;
  const attemptId = boundedText(details.safeCopyAttemptId);
  const operation = details.safeCopyAttemptOperation;
  const state = details.safeCopyAttemptState;
  const updatedAt = boundedNumber(details.safeCopyAttemptUpdatedAt);
  if (
    !attemptId
    || value.id !== `safe-copy-attempt:${attemptId}`
    || value.jobId !== job.id
    || value.targetId !== target.id
    || value.destinationId !== target.destinationInstanceId
    || value.targetModelId !== target.targetModelId
    || (value.targetFolderId || '') !== (target.targetFolderId || '')
    || (value.targetFolderPath || '') !== (target.targetFolderPath || '')
    || boundedText(details.safeCopyDestinationInstanceId) !== target.destinationInstanceId
    || boundedText(details.safeCopyConnectionId) !== target.targetConnectionId
    || boundedText(details.safeCopyModelId) !== target.targetModelId
    || (boundedText(details.safeCopyFolderId) || '') !== (target.targetFolderId || '')
    || (boundedText(details.safeCopyFolderPath) || '') !== (target.targetFolderPath || '')
    || (operation !== 'semantic_update' && operation !== 'document_create')
    || (state !== 'dispatched' && state !== 'failed_prewrite' && state !== 'uncertain' && state !== 'verified')
    || !updatedAt
  ) return undefined;
  const sourceDocumentId = boundedText(details.safeCopySourceDocumentId);
  if (sourceDocumentId && !sourceDocumentIds.has(sourceDocumentId)) return undefined;
  const chosenTargetName = boundedText(details.safeCopyChosenName, 256);
  const importedDocumentId = boundedText(details.safeCopyImportedDocumentId);
  const importedIdentifier = boundedText(details.safeCopyImportedIdentifier);
  const expectedPayloadHash = boundedText(details.safeCopyExpectedPayloadHash, 64);
  const publishedFingerprint = boundedText(details.safeCopyPublishedFingerprint, 64);
  const createdAt = boundedNumber(details.safeCopyAttemptCreatedAt);
  const verificationStartedAtCandidate = boundedNumber(details.safeCopyVerificationStartedAt);
  const verificationStartedAt = verificationStartedAtCandidate
    && createdAt
    && verificationStartedAtCandidate >= createdAt
    && verificationStartedAtCandidate <= updatedAt
    && operation === 'document_create'
    && state !== 'failed_prewrite'
    && importedDocumentId
    && importedIdentifier
    && SAFE_COPY_DIGEST_PATTERN.test(expectedPayloadHash)
    && publishedFingerprint === expectedPayloadHash
    ? verificationStartedAtCandidate
    : undefined;
  if (
    (sourceDocumentId && value.documentId !== sourceDocumentId)
    || (chosenTargetName && value.documentName !== chosenTargetName)
  ) return undefined;
  return {
    attemptId,
    operation,
    state,
    ...(sourceDocumentId ? { sourceDocumentId } : {}),
    ...(chosenTargetName ? { chosenTargetName } : {}),
    ...(importedDocumentId ? { importedDocumentId } : {}),
    ...(importedIdentifier ? { importedIdentifier } : {}),
    ...(expectedPayloadHash ? { expectedPayloadHash } : {}),
    ...(publishedFingerprint ? { publishedFingerprint } : {}),
    ...(verificationStartedAt ? { verificationStartedAt } : {}),
    updatedAt,
  };
}

function resultDocuments(
  sourceDocumentIds: ReadonlySet<string>,
  result: MigrationJob['items'][number] | undefined,
): Map<string, ProjectedResultDocument> | undefined {
  if (!result) return new Map();
  const raw = result.details?.safeCopyDocuments;
  if (raw === undefined) return new Map();
  if (!Array.isArray(raw) || raw.length > sourceDocumentIds.size) return undefined;
  const projected = new Map<string, ProjectedResultDocument>();
  for (const value of raw) {
    if (!isRecord(value)) return undefined;
    const sourceDocumentId = boundedText(value.sourceDocumentId);
    const status = value.status;
    if (
      !sourceDocumentId
      || !sourceDocumentIds.has(sourceDocumentId)
      || projected.has(sourceDocumentId)
      || (status !== 'succeeded' && status !== 'needs_attention')
    ) return undefined;
    const chosenTargetName = boundedText(value.chosenName, 256);
    const exceptionCode = boundedText(value.exceptionCode, 64);
    projected.set(sourceDocumentId, {
      sourceDocumentId,
      status,
      ...(chosenTargetName ? { chosenTargetName } : {}),
      ...(exceptionCode && SAFE_COPY_CODE_PATTERN.test(exceptionCode) ? { exceptionCode } : {}),
    });
  }
  return projected;
}

function clientEvidence(
  job: MigrationJob,
  targetIds: ReadonlySet<string>,
  sourceDocumentIds: ReadonlySet<string>,
): ProjectedClientEvidence | undefined {
  const raw = job.details?.safeCopyClientEvidence;
  const revision = job.details?.safeCopyEvidenceRevision;
  if (
    !isRecord(raw)
    || Object.keys(raw).some((key) => !SAFE_COPY_CLIENT_EVIDENCE_KEYS.has(key))
    || raw.version !== 1
    || raw.jobId !== job.id
    || raw.complete !== true
    || typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 1
    || raw.evidenceRevision !== revision
    || !Array.isArray(raw.invalidTargetIds)
    || raw.invalidTargetIds.length > 100
    || !Array.isArray(raw.validatedAttemptIds)
    || raw.validatedAttemptIds.length > MAX_CLIENT_EVIDENCE_ATTEMPTS
    || !Array.isArray(raw.verifiedDocuments)
    || raw.verifiedDocuments.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS
  ) return undefined;

  const invalidTargetIds = new Set<string>();
  for (const value of raw.invalidTargetIds) {
    const targetId = boundedText(value, 256);
    if (!targetId || !targetIds.has(targetId) || invalidTargetIds.has(targetId)) return undefined;
    invalidTargetIds.add(targetId);
  }
  const validatedAttemptIds = new Set<string>();
  for (const value of raw.validatedAttemptIds) {
    const attemptId = boundedText(value, 256);
    if (!attemptId || validatedAttemptIds.has(attemptId)) return undefined;
    validatedAttemptIds.add(attemptId);
  }
  const verifiedDocuments = new Map<string, VerifiedDocumentProof>();
  for (const value of raw.verifiedDocuments) {
    if (!isRecord(value) || Object.keys(value).some((key) => !SAFE_COPY_CLIENT_DOCUMENT_KEYS.has(key))) {
      return undefined;
    }
    const targetId = boundedText(value.targetId, 256);
    const sourceDocumentId = boundedText(value.sourceDocumentId, 256);
    const importedDocumentId = boundedText(value.importedDocumentId);
    const importedIdentifier = boundedText(value.importedIdentifier);
    const chosenTargetName = boundedText(value.chosenTargetName, 256);
    const verifiedAt = boundedNumber(value.verifiedAt);
    const scope = `${targetId}\u0000${sourceDocumentId}`;
    if (
      !targetIds.has(targetId)
      || !sourceDocumentIds.has(sourceDocumentId)
      || !importedDocumentId
      || !importedIdentifier
      || !chosenTargetName
      || !verifiedAt
      || verifiedAt < MIN_VERIFIED_AT
      || verifiedAt > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS
      || verifiedDocuments.has(scope)
      || invalidTargetIds.has(targetId)
    ) return undefined;
    verifiedDocuments.set(scope, {
      importedDocumentId,
      importedIdentifier,
      chosenTargetName,
      verifiedAt,
    });
  }
  return { invalidTargetIds, validatedAttemptIds, verifiedDocuments };
}

function targetMessage(phase: DashboardSafeCopyTargetPhase, exceptionCodes: string[]): string | undefined {
  if (phase === 'reconciliation_required') {
    return 'A previous write outcome must be reconciled before this destination can continue.';
  }
  if (phase !== 'needs_attention') return undefined;
  if (exceptionCodes.includes('SEMANTIC_CHANGE_UNSAFE')) {
    return 'The selected destination model needs a change outside the automatic safe-copy boundary.';
  }
  if (exceptionCodes.includes('FINAL_VERIFICATION_FAILED')) {
    return 'A copied dashboard did not pass final content, access, and query verification.';
  }
  if (exceptionCodes.includes('TARGET_DEADLINE_EXCEEDED')) {
    return 'This destination exceeded its bounded execution window.';
  }
  return 'This destination needs attention before the move can finish.';
}

function completedStages(
  phase: DashboardSafeCopyTargetPhase,
  activeStage: DashboardSafeCopyTargetStage,
): DashboardSafeCopyTargetStage[] {
  const stages: DashboardSafeCopyTargetStage[] = ['prepare', 'copy', 'verify', 'complete'];
  if (phase === 'succeeded') return stages;
  return stages.slice(0, Math.max(0, stages.indexOf(activeStage)));
}

export function dashboardSafeCopyTargetActions(
  target: Pick<DashboardSafeCopyTargetProgress, 'phase' | 'globalHold' | 'exceptionCodes' | 'recommendedActions'>,
): DashboardSafeCopyTargetActions {
  if (target.phase === 'reconciliation_required') {
    return {
      canRetry: true,
      canChooseAnotherModel: false,
      canOpenModelMigrator: false,
    };
  }
  if (target.phase !== 'needs_attention') {
    return {
      canRetry: false,
      canChooseAnotherModel: false,
      canOpenModelMigrator: false,
    };
  }
  if (target.globalHold) {
    return {
      canRetry: false,
      canChooseAnotherModel: false,
      canOpenModelMigrator: false,
    };
  }
  const legacyModelDecision = target.exceptionCodes.includes('MODEL_DECISION_REQUIRED');
  return {
    canRetry: true,
    canChooseAnotherModel: legacyModelDecision || target.recommendedActions.includes('select_target_model'),
    canOpenModelMigrator: legacyModelDecision || target.recommendedActions.includes('open_model_migrator'),
  };
}

export function dashboardSafeCopyJobProgress(
  job: MigrationJob,
  options: DashboardSafeCopyProgressProjectionOptions = {},
): DashboardSafeCopyTargetProgress[] {
  if (!isDashboardSafeCopyJob(job)) return [];
  const rawTargets = job.targets || [];
  const targets = rawTargets.slice(0, 100);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const targetScopeKeys = rawTargets.map((target) => [
    target.destinationInstanceId,
    target.targetConnectionId || '',
    target.targetModelId,
    target.targetFolderId || '',
    target.targetFolderPath || '',
  ].join('\u0000'));
  const targetIdsAreValid = rawTargets.length > 0
    && rawTargets.length <= 100
    && rawTargets.every((target) => (
      boundedText(target.id, 256) === target.id
      && boundedText(target.destinationInstanceId, 256) === target.destinationInstanceId
      && boundedText(target.targetConnectionId, 256) === target.targetConnectionId
      && boundedText(target.targetModelId, 256) === target.targetModelId
      && (!target.targetFolderId || boundedText(target.targetFolderId, 256) === target.targetFolderId)
      && (!target.targetFolderPath || boundedText(target.targetFolderPath) === target.targetFolderPath)
    ))
    && rawTargets.length === new Set(rawTargets.map((target) => target.id)).size
    && targetScopeKeys.length === new Set(targetScopeKeys).size;
  const normalizedSourceDocumentIds = job.documentIds.map((value) => boundedText(value, 256));
  const sourceDocumentScopeIsValid = normalizedSourceDocumentIds.length > 0
    && normalizedSourceDocumentIds.length <= 500
    && normalizedSourceDocumentIds.every(Boolean)
    && normalizedSourceDocumentIds.length === new Set(normalizedSourceDocumentIds).size;
  const matrixScopeIsValid = rawTargets.length * normalizedSourceDocumentIds.length
    <= DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS;
  const sourceDocumentIds = [...new Set(normalizedSourceDocumentIds.filter(Boolean))].slice(0, 500);
  const sourceDocumentIdSet = new Set(sourceDocumentIds);
  const projectedClientEvidence = clientEvidence(job, new Set(targetById.keys()), sourceDocumentIdSet);
  const attemptsByTarget = new Map<string, ProjectedAttempt[]>();
  const attemptsByTargetDocument = new Map<string, Map<string, ProjectedAttempt[]>>();
  const preparationByTarget = new Map<string, MigrationJob['items'][number]>();
  const resultByTarget = new Map<string, MigrationJob['items'][number]>();
  const invalidEvidenceTargets = new Set<string>();
  const seenItemIds = new Set<string>();
  const attemptScopeById = new Map<string, string>();
  const jobReconciliationState = clean(job.details?.safeCopyExecutionState) === 'reconciliation_required';
  const invalidJobEvidence = !targetIdsAreValid
    || !sourceDocumentScopeIsValid
    || !matrixScopeIsValid
    || !projectedClientEvidence;
  let unscopedWriteHold = false;
  for (const targetId of projectedClientEvidence?.invalidTargetIds || []) invalidEvidenceTargets.add(targetId);

  const appendNested = <T,>(map: Map<string, Map<string, T[]>>, targetId: string, documentId: string, value: T) => {
    let byDocument = map.get(targetId);
    if (!byDocument) {
      byDocument = new Map();
      map.set(targetId, byDocument);
    }
    const values = byDocument.get(documentId) || [];
    values.push(value);
    byDocument.set(documentId, values);
  };

  for (const item of job.items) {
    const target = item.targetId ? targetById.get(item.targetId) : undefined;
    const rawAttemptState = item.details?.safeCopyAttemptState;
    const rawActiveAttempt = item.details?.safeCopyAttempt === true
      && (rawAttemptState === 'dispatched' || rawAttemptState === 'uncertain');
    if (seenItemIds.has(item.id)) {
      if (rawActiveAttempt) unscopedWriteHold = true;
      if (target) invalidEvidenceTargets.add(target.id);
      else unscopedWriteHold = true;
    }
    seenItemIds.add(item.id);
    if (!target || item.jobId !== job.id) {
      if (rawActiveAttempt) unscopedWriteHold = true;
      continue;
    }
    const exactTargetScope = item.destinationId === target.destinationInstanceId
      && (item.targetModelId || '') === target.targetModelId
      && (item.targetFolderId || '') === (target.targetFolderId || '')
      && (item.targetFolderPath || '') === (target.targetFolderPath || '');
    if (exactTargetScope && item.details?.safeCopyPreparationSummary === true) {
      if (preparationByTarget.has(target.id)) invalidEvidenceTargets.add(target.id);
      const previous = preparationByTarget.get(target.id);
      if (!previous || (item.endedAt || item.startedAt || 0) >= (previous.endedAt || previous.startedAt || 0)) {
        preparationByTarget.set(target.id, item);
      }
    }
    if (
      exactTargetScope
      && item.id === `safe-copy-target-result:${target.id}`
      && item.details?.safeCopyTargetExecutionSummary === true
    ) {
      if (resultByTarget.has(target.id)) invalidEvidenceTargets.add(target.id);
      resultByTarget.set(target.id, item);
    }
    const attempt = scopedAttempt(job, target, item, sourceDocumentIdSet);
    const serverValidatedAttempt = attempt && projectedClientEvidence?.validatedAttemptIds.has(attempt.attemptId)
      ? attempt
      : undefined;
    if (attempt && !serverValidatedAttempt) invalidEvidenceTargets.add(target.id);
    if (rawActiveAttempt && !serverValidatedAttempt) unscopedWriteHold = true;
    if (serverValidatedAttempt) {
      const attemptScope = `${target.id}\u0000${serverValidatedAttempt.sourceDocumentId || ''}`;
      const priorScope = attemptScopeById.get(serverValidatedAttempt.attemptId);
      if (priorScope !== undefined) {
        invalidEvidenceTargets.add(target.id);
        const priorTargetId = priorScope.split('\u0000', 1)[0];
        if (priorTargetId) invalidEvidenceTargets.add(priorTargetId);
      } else attemptScopeById.set(serverValidatedAttempt.attemptId, attemptScope);
      const targetAttempts = attemptsByTarget.get(target.id) || [];
      targetAttempts.push(serverValidatedAttempt);
      attemptsByTarget.set(target.id, targetAttempts);
      if (serverValidatedAttempt.sourceDocumentId) {
        appendNested(
          attemptsByTargetDocument,
          target.id,
          serverValidatedAttempt.sourceDocumentId,
          serverValidatedAttempt,
        );
      }
    }
  }

  const latestAttempt = (attempts: ProjectedAttempt[]): ProjectedAttempt | undefined => attempts.reduce<ProjectedAttempt | undefined>(
    (latest, attempt) => !latest || attempt.updatedAt > latest.updatedAt ? attempt : latest,
    undefined,
  );
  const isActiveVerification = (attempt: ProjectedAttempt): boolean => (
    attempt.operation === 'document_create'
    && attempt.state === 'dispatched'
    && Boolean(attempt.verificationStartedAt)
    && Boolean(attempt.importedDocumentId)
    && Boolean(attempt.importedIdentifier)
    && Boolean(attempt.expectedPayloadHash)
    && Boolean(attempt.publishedFingerprint)
    && attempt.publishedFingerprint === attempt.expectedPayloadHash
  );
  const sourceLabel = (sourceDocumentId: string, documentIndex: number): string => (
    boundedText(options.sourceLabelByDocumentId?.[sourceDocumentId], 256) || `Dashboard ${documentIndex + 1}`
  );
  const requestedDefaultLimit = options.defaultDocumentLimit ?? 20;
  const defaultDocumentLimit = Number.isSafeInteger(requestedDefaultLimit)
    ? Math.max(0, Math.min(500, requestedDefaultLimit))
    : 20;
  const hasScopedUnresolvedAttempt = [...attemptsByTarget.values()].some((attempts) => (
    attempts.some((attempt) => attempt.state === 'dispatched' || attempt.state === 'uncertain')
  ));
  if (jobReconciliationState && !hasScopedUnresolvedAttempt) unscopedWriteHold = true;
  const blocksNewScope = jobReconciliationState || unscopedWriteHold;
  const globalHold = blocksNewScope || invalidJobEvidence;

  return [...targetById.values()].map((target) => {
    const invalidTargetEvidence = invalidJobEvidence || invalidEvidenceTargets.has(target.id);
    const preparation = preparationByTarget.get(target.id);
    const result = resultByTarget.get(target.id);
    const attempts = attemptsByTarget.get(target.id) || [];
    const resultStatus = clean(result?.details?.safeCopyTargetStatus);
    const preparationStatus = clean(preparation?.details?.safeCopyTargetStatus);
    const projectedResultDocuments = resultDocuments(sourceDocumentIdSet, result);
    const requestedTargetLimit = options.documentLimitByTarget?.[target.id] ?? defaultDocumentLimit;
    const documentLimit = Number.isSafeInteger(requestedTargetLimit)
      ? Math.max(0, Math.min(sourceDocumentIds.length, requestedTargetLimit))
      : defaultDocumentLimit;
    const documentRows: DashboardSafeCopyDocumentProgress[] = [];
    let everyDocumentVerified = sourceDocumentIds.length > 0;
    let anyDocumentVerified = false;
    for (const [documentIndex, sourceDocumentId] of sourceDocumentIds.entries()) {
      const resultDocument = projectedResultDocuments?.get(sourceDocumentId);
      const documentAttempts = attemptsByTargetDocument.get(target.id)?.get(sourceDocumentId) || [];
      const latestDocumentAttempt = latestAttempt(documentAttempts);
      const proof = invalidTargetEvidence
        ? undefined
        : projectedClientEvidence?.verifiedDocuments.get(`${target.id}\u0000${sourceDocumentId}`);
      const uncertain = documentAttempts.some((attempt) => attempt.state === 'uncertain');
      const dispatched = documentAttempts.filter((attempt) => attempt.state === 'dispatched');
      let documentPhase: DashboardSafeCopyDocumentPhase = 'waiting';
      if (uncertain) documentPhase = 'reconciliation_required';
      else if (jobReconciliationState && dispatched.length > 0) documentPhase = 'reconciliation_required';
      else if (proof) documentPhase = 'complete';
      else if (dispatched.length > 0) {
        documentPhase = dispatched.every(isActiveVerification) ? 'verifying' : 'copying';
      } else if (job.status === 'canceled') documentPhase = 'canceled';
      else if (
        resultDocument
        || documentAttempts.some((attempt) => attempt.state === 'failed_prewrite' || attempt.state === 'verified')
        || (result && (!projectedResultDocuments || !resultDocument))
        || job.status === 'failed'
        || job.status === 'succeeded'
      ) documentPhase = 'needs_attention';
      if (documentPhase === 'complete') anyDocumentVerified = true;
      else everyDocumentVerified = false;
      if (documentIndex < documentLimit) {
        const chosenTargetName = proof?.chosenTargetName
          || resultDocument?.chosenTargetName
          || latestDocumentAttempt?.chosenTargetName;
        documentRows.push({
          sourceDocumentId,
          sourceLabel: sourceLabel(sourceDocumentId, documentIndex),
          ...(chosenTargetName ? { chosenTargetName } : {}),
          phase: documentPhase,
          ...(resultDocument?.exceptionCode ? { exceptionCode: resultDocument.exceptionCode } : {}),
          ...(proof ? {
            importedDocumentId: proof.importedDocumentId,
            verifiedDestinationIdentifier: proof.importedIdentifier,
            verifiedAt: proof.verifiedAt,
          } : {}),
        });
      }
    }
    const uncertainAttempts = attempts.filter((attempt) => attempt.state === 'uncertain');
    const dispatchedAttempts = attempts.filter((attempt) => attempt.state === 'dispatched');
    const dispatchedDocumentAttempts = attempts.filter((attempt) => (
      attempt.operation === 'document_create' && attempt.state === 'dispatched'
    ));
    const targetResultProvesSuccess = Boolean(
      result
      && resultStatus === 'succeeded'
      && result.status === 'succeeded'
      && !clean(result.error)
      && (result.warnings?.length || 0) === 0
      && result.replacement !== true
      && result.details?.updateInPlace !== true
      && Array.isArray(result.details?.safeCopyExceptionCodes)
      && result.details.safeCopyExceptionCodes.length === 0
      && Array.isArray(result.details?.safeCopyRecommendedActions)
      && result.details.safeCopyRecommendedActions.length === 0
      && Array.isArray(result.details?.safeCopyDocuments)
      && projectedResultDocuments
      && [...projectedResultDocuments.values()].every((document) => document.status === 'succeeded')
      && everyDocumentVerified
    );
    let phase: DashboardSafeCopyTargetPhase = 'preparing';
    if (uncertainAttempts.length > 0 || (jobReconciliationState && dispatchedAttempts.length > 0)) {
      phase = 'reconciliation_required';
    }
    else if (invalidTargetEvidence) phase = 'needs_attention';
    else if (dispatchedAttempts.length > 0) {
      phase = dispatchedAttempts.length === dispatchedDocumentAttempts.length
        && dispatchedDocumentAttempts.every(isActiveVerification)
        ? 'verifying'
        : 'copying';
    } else if (job.status === 'canceled') phase = 'canceled';
    else if (targetResultProvesSuccess && !invalidTargetEvidence) phase = 'succeeded';
    else if (resultStatus === 'succeeded') phase = 'needs_attention';
    else if (attempts.some((attempt) => attempt.state === 'failed_prewrite')) phase = 'needs_attention';
    else if (result) phase = 'needs_attention';
    else if (preparationStatus === 'needs_attention' || preparation?.status === 'failed') phase = 'needs_attention';
    else if (job.status === 'failed') phase = 'needs_attention';
    else if (attempts.some((attempt) => attempt.state === 'verified') && !everyDocumentVerified) phase = 'needs_attention';
    else if (anyDocumentVerified) phase = 'copying';
    else if (preparationStatus === 'ready') phase = 'ready';
    const exceptionCodes = result
      ? detailStringArray(result.details?.safeCopyExceptionCodes)
      : preparationExceptionCodes(preparation?.details?.safeCopyExceptions);
    const recommendedActions = result
      ? recommendedActionArray(result.details?.safeCopyRecommendedActions)
      : recommendedActionArray(preparation?.details?.safeCopyRecommendedActions);
    let activeStage: DashboardSafeCopyTargetStage = 'prepare';
    if (phase === 'succeeded') activeStage = 'complete';
    else if (phase === 'verifying') activeStage = 'verify';
    else if (phase === 'copying' || phase === 'ready') activeStage = 'copy';
    else if (phase === 'reconciliation_required') {
      const reconciliationAttempts = uncertainAttempts.length > 0 ? uncertainAttempts : dispatchedDocumentAttempts;
      activeStage = reconciliationAttempts.some((attempt) => attempt.operation === 'document_create' && attempt.verificationStartedAt)
        ? 'verify'
        : reconciliationAttempts.some((attempt) => attempt.operation === 'document_create') ? 'copy' : 'prepare';
    } else if (phase === 'needs_attention') {
      activeStage = exceptionCodes.includes('FINAL_VERIFICATION_FAILED') ? 'verify'
        : attempts.some((attempt) => attempt.operation === 'document_create') ? 'copy'
          : 'prepare';
    }
    return {
      targetId: target.id,
      destinationId: target.destinationInstanceId,
      destinationLabel: boundedText(target.destinationLabel, 256) || target.destinationInstanceId,
      modelId: boundedText(target.targetModelId),
      modelName: boundedText(target.targetModelName, 256) || undefined,
      phase,
      globalHold,
      blocksNewScope,
      activeStage,
      completedStages: completedStages(phase, activeStage),
      documentCount: sourceDocumentIds.length,
      documents: documentRows,
      exceptionCodes,
      recommendedActions,
      message: targetMessage(phase, exceptionCodes),
    };
  });
}

type DashboardSafeCopyPlanningPatch = Omit<Partial<DashboardSafeCopyDraft>, 'version' | 'requestId' | 'jobId'>;

export type DashboardSafeCopyDraftAction =
  | { type: 'choose_source'; sourceId: string; requestId: string }
  | { type: 'resolve_source_connections'; sourceId: string; connectionIds: string[]; requestId: string }
  | { type: 'choose_source_connection'; connectionId: string; requestId: string }
  | {
    type: 'prune_documents';
    sourceId: string;
    sourceConnectionId: string;
    availableDocumentIds: string[];
    requestId: string;
  }
  | { type: 'toggle_document'; documentId: string; limit: number; requestId: string }
  | { type: 'patch_plan'; patch: DashboardSafeCopyPlanningPatch; requestId: string }
  | { type: 'toggle_destination'; instanceId: string; limit: number; requestId: string }
  | {
    type: 'resolve_destination';
    instanceId: string;
    connectionId: string;
    modelId: string;
    requestId: string;
    manual?: boolean;
  }
  | { type: 'set_step'; step: DashboardSafeCopyStep }
  | { type: 'attach_job'; jobId: string }
  | { type: 'reset'; draft: DashboardSafeCopyDraft }
  | { type: 'reject_restored_job'; draft: DashboardSafeCopyDraft }
  | { type: 'replan_target'; job: MigrationJob; targetId: string; requestId: string };

function planningUpdate(
  state: DashboardSafeCopyDraft,
  requestId: string,
  patch: DashboardSafeCopyPlanningPatch,
): DashboardSafeCopyDraft {
  return {
    ...state,
    ...patch,
    requestId,
    jobId: undefined,
  };
}

export function dashboardSafeCopyDraftReducer(
  state: DashboardSafeCopyDraft,
  action: DashboardSafeCopyDraftAction,
): DashboardSafeCopyDraft {
  switch (action.type) {
    case 'choose_source':
      if (state.jobId || state.sourceId === action.sourceId) return state;
      return planningUpdate(state, action.requestId, {
        sourceId: action.sourceId,
        sourceConnectionId: '',
        selectedDocumentIds: [],
      });
    case 'resolve_source_connections': {
      if (state.jobId || state.sourceId !== action.sourceId) return state;
      const valid = action.connectionIds.includes(state.sourceConnectionId);
      const connectionId = valid
        ? state.sourceConnectionId
        : action.connectionIds.length === 1 ? action.connectionIds[0] : '';
      if (connectionId === state.sourceConnectionId) return state;
      return planningUpdate(state, action.requestId, {
        sourceConnectionId: connectionId,
        selectedDocumentIds: [],
      });
    }
    case 'choose_source_connection':
      if (state.jobId || state.sourceConnectionId === action.connectionId) return state;
      return planningUpdate(state, action.requestId, {
        sourceConnectionId: action.connectionId,
        selectedDocumentIds: [],
      });
    case 'prune_documents': {
      if (
        state.jobId
        || state.sourceId !== action.sourceId
        || state.sourceConnectionId !== action.sourceConnectionId
      ) return state;
      const available = new Set(action.availableDocumentIds);
      const selectedDocumentIds = state.selectedDocumentIds.filter((id) => available.has(id));
      if (selectedDocumentIds.length === state.selectedDocumentIds.length) return state;
      return planningUpdate(state, action.requestId, { selectedDocumentIds });
    }
    case 'toggle_document': {
      if (state.jobId) return state;
      const selected = new Set(state.selectedDocumentIds);
      if (selected.has(action.documentId)) selected.delete(action.documentId);
      else if (selected.size < action.limit) selected.add(action.documentId);
      else return state;
      return planningUpdate(state, action.requestId, { selectedDocumentIds: [...selected].sort() });
    }
    case 'patch_plan':
      if (state.jobId) return state;
      return planningUpdate(state, action.requestId, action.patch);
    case 'toggle_destination': {
      if (state.jobId) return state;
      const exists = state.destinations.some((row) => row.instanceId === action.instanceId);
      if (!exists && state.destinations.length >= action.limit) return state;
      const destinations = exists
        ? state.destinations.filter((row) => row.instanceId !== action.instanceId)
        : [...state.destinations, {
          targetId: action.instanceId,
          instanceId: action.instanceId,
          connectionId: '',
          modelId: '',
        }].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
      return planningUpdate(state, action.requestId, { destinations });
    }
    case 'resolve_destination': {
      if (state.jobId) return state;
      const destination = state.destinations.find((row) => row.instanceId === action.instanceId);
      if (!destination) return state;
      const requiresModelChoice = action.manual ? false : destination.requiresModelChoice;
      if (
        destination.connectionId === action.connectionId
        && destination.modelId === action.modelId
        && destination.requiresModelChoice === requiresModelChoice
      ) return state;
      return planningUpdate(state, action.requestId, {
        destinations: state.destinations.map((row) => row.instanceId === action.instanceId
          ? {
            ...row,
            connectionId: action.connectionId,
            modelId: action.modelId,
            ...(requiresModelChoice ? { requiresModelChoice: true } : { requiresModelChoice: undefined }),
          }
          : row),
      });
    }
    case 'set_step':
      return state.jobId || state.step === action.step ? state : { ...state, step: action.step };
    case 'attach_job':
      return { ...state, step: 3, jobId: action.jobId };
    case 'reset':
    case 'reject_restored_job':
      return action.draft;
    case 'replan_target': {
      const progress = dashboardSafeCopyJobProgress(action.job);
      const targetProgress = progress.find((row) => row.targetId === action.targetId);
      if (!targetProgress || !dashboardSafeCopyTargetActions(targetProgress).canChooseAnotherModel) {
        return state;
      }
      const target = action.job.targets?.find((row) => row.id === action.targetId);
      if (!target || !action.job.sourceConnectionId) return state;
      return {
        version: 1,
        step: 1,
        requestId: action.requestId,
        sourceId: action.job.sourceId,
        sourceConnectionId: action.job.sourceConnectionId,
        selectedDocumentIds: [...action.job.documentIds],
        destinations: [{
          targetId: target.id,
          instanceId: target.destinationInstanceId,
          connectionId: target.targetConnectionId || '',
          modelId: '',
          requiresModelChoice: true,
        }],
      };
    }
    default:
      return state;
  }
}

export function dashboardSafeCopyIntentFromDraft(
  draft: DashboardSafeCopyDraft,
  instances: Array<Pick<SavedInstancePublic, 'id' | 'defaultFolderId' | 'defaultFolderPath'>>,
): DashboardSafeCopyIntentInput {
  return {
    profile: 'safe_copy_v1',
    requestId: draft.requestId,
    source: {
      instanceId: draft.sourceId,
      connectionId: draft.sourceConnectionId,
      documentIds: [...draft.selectedDocumentIds],
    },
    destinations: draft.destinations.map((row) => {
      const instance = instances.find((candidate) => candidate.id === row.instanceId);
      return {
        targetId: row.targetId,
        instanceId: row.instanceId,
        connectionId: row.connectionId,
        modelId: row.modelId,
        ...(instance?.defaultFolderId ? { folderId: instance.defaultFolderId } : {}),
        ...(instance?.defaultFolderPath ? { folderPath: instance.defaultFolderPath } : {}),
        ...(row.topicMappings?.length ? {
          topicMappings: row.topicMappings
            .filter(isExecutableTopicMapping)
            .map((m) => ({ sourceTopicName: m.sourceTopicName, action: m.action, targetTopicName: m.targetTopicName })),
        } : {}),
        ...(row.queryViewMappings?.length ? {
          queryViewMappings: row.queryViewMappings
            .filter(isExecutableQueryViewMapping)
            .map((m) => ({ sourceQueryViewName: m.sourceQueryViewName, action: m.action, targetQueryViewName: m.targetQueryViewName })),
        } : {}),
      };
    }),
    ...(draft.emptyFirst || draft.deleteSourceOnSuccess || draft.refreshSchemaOnComplete ? {
      options: {
        ...(draft.emptyFirst ? { emptyFirst: true } : {}),
        ...(draft.deleteSourceOnSuccess ? { deleteSourceOnSuccess: true } : {}),
        ...(draft.refreshSchemaOnComplete ? { refreshSchemaOnComplete: true } : {}),
      },
    } : {}),
  };
}
