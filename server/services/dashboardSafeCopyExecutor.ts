import { randomUUID } from 'node:crypto';

import { materializeDashboardSafeCopyDocumentContent } from './dashboardSafeCopyContent';
import { allocateDashboardSafeCopyName } from './dashboardSafeCopyProvenance';

const DEFAULT_TARGET_CONCURRENCY = 2;
const DEFAULT_TARGET_DEADLINE_MS = 120_000;

export type DashboardSafeCopyExecutionExceptionCode =
  | 'DUPLICATE_DESTINATION_SCOPE'
  | 'TARGET_REPROOF_FAILED'
  | 'TARGET_EXECUTION_FAILED'
  | 'SOURCE_SNAPSHOT_CHANGED'
  | 'SOURCE_MODEL_SNAPSHOT_CHANGED'
  | 'MODEL_SNAPSHOT_CHANGED'
  | 'REPAIR_REQUIRED'
  | 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED'
  | 'SEMANTIC_CHANGE_UNSAFE'
  | 'SEMANTIC_APPLY_FAILED'
  | 'SEMANTIC_OUTCOME_UNCERTAIN'
  | 'DOCUMENT_PREPARATION_FAILED'
  | 'CONTENT_SECURITY_UNSAFE'
  | 'IMPORT_FAILED'
  | 'IMPORT_UNCERTAIN'
  | 'FINAL_VERIFICATION_FAILED'
  | 'TARGET_DEADLINE_EXCEEDED'
  | 'TARGET_ALREADY_COMPLETE'
  | 'RETRY_EVIDENCE_MISSING'
  | 'RETRY_REQUEST_DUPLICATE'
  | 'RETRY_REQUEST_CONFLICT'
  | 'RETRY_REQUEST_INVALID';

export interface DashboardSafeCopyExecutionException {
  code: DashboardSafeCopyExecutionExceptionCode;
  targetId: string;
  sourceDocumentId?: string;
  message: string;
  retryable: boolean;
}

export interface DashboardSafeCopyExecutionTarget {
  targetId: string;
  sourceInstanceId: string;
  sourceConnectionId: string;
  destinationInstanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  sourceDocumentIds: string[];
  /** Version 2 dashboard deployments may never mutate model dependencies. */
  contentOnly?: true;
  workbookCopy?: { stagingFolderId: string };
  /** Exact durable document proofs that the runtime has already revalidated for this target. */
  skipDocumentIds?: string[];
  /**
   * Exact durable proof for one checksum-protected semantic update that the runtime has
   * revalidated after restart. This is in-memory execution authority, not caller input.
   */
  skipSemanticChange?: {
    fileName: string;
    previousChecksum: string;
    expectedYamlHash: string;
  };
  /** In-memory absolute deadline that may include pre-executor scope resolution. */
  deadlineAt?: number;
}

export interface DashboardSafeCopyVerifiedScope {
  destinationInstanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  scopeVerified: true;
}

export type DashboardSafeCopySemanticChange =
  | { mode: 'none' }
  | {
    mode: 'existing_file_update';
    fileName: string;
    previousChecksum: string;
    expectedYamlHash: string;
  }
  | {
    mode: 'unsafe';
    reason: 'new_file' | 'multiple_files' | 'missing_checksum' | 'unsupported';
  };

export interface DashboardSafeCopyReprovedTarget {
  targetId: string;
  scope: DashboardSafeCopyVerifiedScope;
  semanticChange: DashboardSafeCopySemanticChange;
  /** In-memory authorization material. Implementations must never persist it. */
  authorization?: unknown;
}

export interface DashboardSafeCopyPreparedDocument {
  sourceDocumentId: string;
  documentName: string;
  sourceExportHash: string;
  expectedPayloadHash: string;
  /** In-memory content-only payload. Implementations must never persist it. */
  content: unknown;
}

export interface DashboardSafeCopyLiveDocument {
  destinationInstanceId: string;
  connectionId: string;
  documentId: string;
  identifier: string;
  name: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  fingerprint: string;
}

export interface DashboardSafeCopyScopeInventory {
  complete: true;
  destinationInstanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  documents: DashboardSafeCopyLiveDocument[];
}

export interface DashboardSafeCopyVerifiedProvenance {
  profile: 'safe_copy_v1';
  resolverVersion: number;
  verifierVersion: number;
  jobId: string;
  attemptId: string;
  targetId: string;
  sourceInstanceId: string;
  sourceConnectionId: string;
  sourceDocumentId: string;
  sourceExportHash: string;
  destinationInstanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  importedDocumentId: string;
  importedIdentifier: string;
  chosenName: string;
  expectedPayloadHash: string;
  publishedFingerprint: string;
  verifiedAt: number;
}

export type DashboardSafeCopyAttemptOperation = 'semantic_update' | 'document_create';
export type DashboardSafeCopyAttemptState =
  | 'dispatched'
  | 'failed_prewrite'
  | 'uncertain'
  | 'verified';

export interface DashboardSafeCopyAttemptEvidence {
  attemptId: string;
  jobId: string;
  targetId: string;
  operation: DashboardSafeCopyAttemptOperation;
  state: DashboardSafeCopyAttemptState;
  destinationInstanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  sourceDocumentId?: string;
  chosenName?: string;
  sourceExportHash?: string;
  expectedPayloadHash?: string;
  fileName?: string;
  previousChecksum?: string;
  expectedYamlHash?: string;
  preexistingDocumentIds?: string[];
  importedDocumentId?: string;
  importedIdentifier?: string;
  publishedFingerprint?: string;
  verificationStartedAt?: number;
  verifierVersion?: number;
  verifiedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardSafeCopyDocumentResult {
  sourceDocumentId: string;
  status: 'succeeded' | 'needs_attention';
  chosenName?: string;
  importedDocumentId?: string;
  importedIdentifier?: string;
  sourceExportHash?: string;
  expectedPayloadHash?: string;
  publishedFingerprint?: string;
  exception?: DashboardSafeCopyExecutionException;
}

export interface DashboardSafeCopyTargetResult {
  targetId: string;
  status: 'succeeded' | 'partial' | 'needs_attention';
  documents: DashboardSafeCopyDocumentResult[];
  exceptions: DashboardSafeCopyExecutionException[];
}

export interface DashboardSafeCopyExecutionResult {
  jobId: string;
  status: 'succeeded' | 'partial' | 'needs_attention';
  targets: DashboardSafeCopyTargetResult[];
}

export interface DashboardSafeCopyExecutionInput {
  jobId: string;
  targets: DashboardSafeCopyExecutionTarget[];
}

export type DashboardSafeCopyWriteFailure = 'definitely_not_committed' | 'uncertain';
export type DashboardSafeCopyAttemptReconciliation = 'verified' | 'not_committed' | 'uncertain';
export type DashboardSafeCopyPersistedDocumentReconciliation =
  | {
    status: 'candidate';
    liveDocument: DashboardSafeCopyLiveDocument;
    preparedDocument: DashboardSafeCopyPreparedDocument;
  }
  | { status: 'not_committed' }
  | { status: 'uncertain' };

export interface DashboardSafeCopyTargetState {
  status: 'unknown' | 'running' | 'succeeded' | 'needs_attention';
  attempts: DashboardSafeCopyAttemptEvidence[];
}

export interface DashboardSafeCopyDispatchGuard {
  /** Abort queued transport when this write's bounded execution window closes. */
  signal?: AbortSignal;
  /** Must be checked after asynchronous preparation and immediately before the external write. */
  assertCanDispatch(): void;
}

export interface DashboardSafeCopyExecutorDependencies {
  reproveTarget(target: DashboardSafeCopyExecutionTarget): Promise<DashboardSafeCopyReprovedTarget>;
  applySemanticChange(
    target: DashboardSafeCopyReprovedTarget,
    attempt: DashboardSafeCopyAttemptEvidence,
    guard?: DashboardSafeCopyDispatchGuard,
  ): Promise<void>;
  reconcileSemanticChange(
    target: DashboardSafeCopyReprovedTarget,
    attempt: DashboardSafeCopyAttemptEvidence,
  ): Promise<DashboardSafeCopyAttemptReconciliation>;
  prepareDocument(
    target: DashboardSafeCopyReprovedTarget,
    sourceDocumentId: string,
  ): Promise<DashboardSafeCopyPreparedDocument>;
  readDestinationScope(
    target: DashboardSafeCopyReprovedTarget,
    options: { forceRefresh: true },
  ): Promise<DashboardSafeCopyScopeInventory>;
  createDocument(
    target: DashboardSafeCopyReprovedTarget,
    document: DashboardSafeCopyPreparedDocument,
    chosenName: string,
    attempt: DashboardSafeCopyAttemptEvidence,
    guard?: DashboardSafeCopyDispatchGuard,
  ): Promise<{ documentId?: string; identifier?: string }>;
  verifyDocument(
    target: DashboardSafeCopyReprovedTarget,
    document: DashboardSafeCopyPreparedDocument,
    live: DashboardSafeCopyLiveDocument,
  ): Promise<boolean>;
  persistVerifiedProvenance(provenance: DashboardSafeCopyVerifiedProvenance): Promise<void>;
  persistAttempt(attempt: DashboardSafeCopyAttemptEvidence): Promise<void>;
  loadTargetState(jobId: string, targetId: string): Promise<DashboardSafeCopyTargetState>;
  claimRetryRequest(
    jobId: string,
    targetId: string,
    retryRequestId: string,
  ): Promise<'claimed' | 'duplicate' | 'conflict'>;
  reconcilePersistedAttempt(
    target: DashboardSafeCopyReprovedTarget,
    attempt: DashboardSafeCopyAttemptEvidence,
  ): Promise<DashboardSafeCopyPersistedDocumentReconciliation>;
  onTargetResult?(result: DashboardSafeCopyTargetResult): void | Promise<void>;
  classifyWriteFailure?(error: unknown): DashboardSafeCopyWriteFailure;
  allocateName?(originalName: string, occupiedNames: Iterable<string>): string;
  randomId?(): string;
  now?(): number;
  targetConcurrency?: number;
  targetDeadlineMs?: number;
  resolverVersion?: number;
  verifierVersion?: number;
}

class TargetDeadlineError extends Error {
  constructor() {
    super('Safe-copy target deadline exceeded.');
    this.name = 'TargetDeadlineError';
  }
}

function clean(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function deploymentFailure(error: unknown): { code: DashboardSafeCopyExecutionExceptionCode; message: string } | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  if (error.code === 'SAFE_COPY_SOURCE_DRIFT') return { code: 'SOURCE_SNAPSHOT_CHANGED', message: 'The source dashboard changed after approval. Rerun compatibility checks.' };
  if (error.code === 'SAFE_COPY_SOURCE_MODEL_DRIFT') return { code: 'SOURCE_MODEL_SNAPSHOT_CHANGED', message: 'A source model changed after approval. Rerun compatibility checks.' };
  if (error.code === 'SAFE_COPY_MODEL_DRIFT') return { code: 'MODEL_SNAPSHOT_CHANGED', message: 'The destination model changed after approval. Rerun compatibility checks.' };
  if (error.code === 'SAFE_COPY_REPAIR_REQUIRED') return { code: 'REPAIR_REQUIRED', message: 'Repair dependencies in Model Migrator, then rerun compatibility checks.' };
  if (error.code === 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED') return { code: 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED', message: 'Workbook-local copying requires proven access-restricted staging and a reviewed production adapter. No dashboard or shared-model write was dispatched.' };
  return undefined;
}

function canonicalText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function inputScopeKey(target: DashboardSafeCopyExecutionTarget): string {
  return JSON.stringify({
    destinationInstanceId: target.destinationInstanceId,
    connectionId: target.connectionId,
    modelId: target.modelId,
    folderId: clean(target.folderId) || '',
    folderPath: canonicalText(clean(target.folderPath) || ''),
  });
}

function folderScopeMatches(
  expected: Pick<DashboardSafeCopyExecutionTarget, 'folderId' | 'folderPath'>,
  actual: Pick<DashboardSafeCopyVerifiedScope, 'folderId' | 'folderPath'>,
): boolean {
  return (clean(expected.folderId) || '') === (clean(actual.folderId) || '')
    && canonicalText(clean(expected.folderPath) || '') === canonicalText(clean(actual.folderPath) || '');
}

function targetMatchesReproof(
  target: DashboardSafeCopyExecutionTarget,
  reproved: DashboardSafeCopyReprovedTarget,
): boolean {
  return reproved.targetId === target.targetId
    && reproved.scope.scopeVerified === true
    && reproved.scope.destinationInstanceId === target.destinationInstanceId
    && reproved.scope.connectionId === target.connectionId
    && reproved.scope.modelId === target.modelId
    && folderScopeMatches(target, reproved.scope);
}

function semanticChangeIsSafe(change: DashboardSafeCopySemanticChange): boolean {
  if (change.mode === 'none') return true;
  return change.mode === 'existing_file_update'
    && Boolean(clean(change.fileName))
    && Boolean(clean(change.previousChecksum))
    && Boolean(clean(change.expectedYamlHash));
}

function exception(
  targetId: string,
  code: DashboardSafeCopyExecutionExceptionCode,
  message: string,
  retryable: boolean,
  sourceDocumentId?: string,
): DashboardSafeCopyExecutionException {
  return {
    code,
    targetId,
    ...(sourceDocumentId ? { sourceDocumentId } : {}),
    message,
    retryable,
  };
}

function failedTarget(
  targetId: string,
  issue: DashboardSafeCopyExecutionException,
): DashboardSafeCopyTargetResult {
  return { targetId, status: 'needs_attention', documents: [], exceptions: [issue] };
}

function withDeadline<T>(promise: Promise<T>, deadlineAt: number, now: () => number): Promise<T> {
  const remaining = deadlineAt - now();
  if (remaining <= 0) return Promise.reject(new TargetDeadlineError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TargetDeadlineError()), remaining);
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

function withWriteDeadline<T>(
  dispatch: (guard: DashboardSafeCopyDispatchGuard) => Promise<T>,
  deadlineAt: number,
  now: () => number,
): Promise<T> {
  const remaining = deadlineAt - now();
  if (remaining <= 0) return Promise.reject(new TargetDeadlineError());
  let expired = false;
  const controller = new AbortController();
  const guard: DashboardSafeCopyDispatchGuard = {
    signal: controller.signal,
    assertCanDispatch() {
      if (expired || now() >= deadlineAt) throw new TargetDeadlineError();
    },
  };
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      expired = true;
      const error = new TargetDeadlineError();
      controller.abort(error);
      reject(error);
    }, remaining);
    Promise.resolve().then(() => {
      guard.assertCanDispatch();
      return dispatch(guard);
    }).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function persistAttempt(
  dependencies: DashboardSafeCopyExecutorDependencies,
  attempt: DashboardSafeCopyAttemptEvidence,
  state: DashboardSafeCopyAttemptState,
  patch: Partial<DashboardSafeCopyAttemptEvidence> = {},
  deadlineAt?: number,
): Promise<DashboardSafeCopyAttemptEvidence> {
  const now = (dependencies.now || Date.now)();
  const next = { ...attempt, ...patch, state, updatedAt: now };
  const persistence = dependencies.persistAttempt(next);
  if (deadlineAt === undefined) {
    await persistence;
  } else {
    await withDeadline(persistence, deadlineAt, dependencies.now || Date.now);
  }
  return next;
}

function attemptBase(
  input: DashboardSafeCopyExecutionInput,
  target: DashboardSafeCopyReprovedTarget,
  operation: DashboardSafeCopyAttemptOperation,
  dependencies: DashboardSafeCopyExecutorDependencies,
): DashboardSafeCopyAttemptEvidence {
  const now = (dependencies.now || Date.now)();
  return {
    attemptId: (dependencies.randomId || randomUUID)(),
    jobId: input.jobId,
    targetId: target.targetId,
    operation,
    state: 'dispatched',
    destinationInstanceId: target.scope.destinationInstanceId,
    connectionId: target.scope.connectionId,
    modelId: target.scope.modelId,
    ...(target.scope.folderId ? { folderId: target.scope.folderId } : {}),
    ...(target.scope.folderPath ? { folderPath: target.scope.folderPath } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function provenanceFromAttempt(
  input: DashboardSafeCopyExecutionInput,
  targetInput: DashboardSafeCopyExecutionTarget,
  target: DashboardSafeCopyReprovedTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
  live: DashboardSafeCopyLiveDocument,
  resolverVersion: number,
  verifierVersion: number,
  verifiedAt: number,
): DashboardSafeCopyVerifiedProvenance | undefined {
  const sourceDocumentId = clean(attempt.sourceDocumentId);
  const sourceExportHash = clean(attempt.sourceExportHash);
  const chosenName = clean(attempt.chosenName);
  const expectedPayloadHash = clean(attempt.expectedPayloadHash);
  if (
    !sourceDocumentId
    || !sourceExportHash
    || !chosenName
    || !expectedPayloadHash
    || !targetInput.sourceDocumentIds.includes(sourceDocumentId)
    || !liveScopeMatches(target.scope, live)
    || canonicalText(live.name) !== canonicalText(chosenName)
    || live.fingerprint !== expectedPayloadHash
    || (
      targetInput.sourceInstanceId === targetInput.destinationInstanceId
      && live.documentId === sourceDocumentId
    )
  ) return undefined;
  return {
    profile: 'safe_copy_v1',
    resolverVersion,
    verifierVersion,
    jobId: input.jobId,
    attemptId: attempt.attemptId,
    targetId: target.targetId,
    sourceInstanceId: targetInput.sourceInstanceId,
    sourceConnectionId: targetInput.sourceConnectionId,
    sourceDocumentId,
    sourceExportHash,
    destinationInstanceId: target.scope.destinationInstanceId,
    connectionId: target.scope.connectionId,
    modelId: target.scope.modelId,
    ...(target.scope.folderId ? { folderId: target.scope.folderId } : {}),
    ...(target.scope.folderPath ? { folderPath: target.scope.folderPath } : {}),
    importedDocumentId: live.documentId,
    importedIdentifier: live.identifier,
    chosenName,
    expectedPayloadHash,
    publishedFingerprint: live.fingerprint,
    verifiedAt,
  };
}

function folderMatches(
  target: DashboardSafeCopyVerifiedScope,
  live: DashboardSafeCopyLiveDocument,
): boolean {
  if ((clean(target.folderId) || '') !== (clean(live.folderId) || '')) return false;
  return canonicalText(clean(target.folderPath) || '') === canonicalText(clean(live.folderPath) || '');
}

function liveScopeMatches(
  target: DashboardSafeCopyVerifiedScope,
  live: DashboardSafeCopyLiveDocument,
): boolean {
  return live.destinationInstanceId === target.destinationInstanceId
    && live.connectionId === target.connectionId
    && live.modelId === target.modelId
    && folderMatches(target, live);
}

function liveInventoryRowMatchesFolderScope(
  target: DashboardSafeCopyVerifiedScope,
  live: DashboardSafeCopyLiveDocument,
): boolean {
  return live.destinationInstanceId === target.destinationInstanceId
    && folderMatches(target, live);
}

function inventoryMatchesTarget(
  target: DashboardSafeCopyVerifiedScope,
  inventory: DashboardSafeCopyScopeInventory,
): boolean {
  if (
    inventory.complete !== true
    || inventory.destinationInstanceId !== target.destinationInstanceId
    || inventory.connectionId !== target.connectionId
    || inventory.modelId !== target.modelId
    || !folderScopeMatches(inventory, target)
  ) return false;
  const documentIds = new Set<string>();
  const identifiers = new Set<string>();
  for (const row of inventory.documents) {
    if (
      // Names are folder-scoped, so the collision baseline must retain
      // documents bound to other models in the same exact folder. Candidate
      // adoption still uses liveScopeMatches and therefore requires the exact
      // requested destination model.
      !liveInventoryRowMatchesFolderScope(target, row)
      || !clean(row.documentId)
      || !clean(row.identifier)
      || !clean(row.name)
      || !clean(row.fingerprint)
      || documentIds.has(row.documentId)
      || identifiers.has(row.identifier)
    ) return false;
    documentIds.add(row.documentId);
    identifiers.add(row.identifier);
  }
  return true;
}

function matchingCandidates(
  target: DashboardSafeCopyExecutionTarget,
  reproved: DashboardSafeCopyReprovedTarget,
  document: Pick<DashboardSafeCopyPreparedDocument, 'sourceDocumentId' | 'expectedPayloadHash'>,
  attempt: DashboardSafeCopyAttemptEvidence,
  rows: readonly DashboardSafeCopyLiveDocument[],
): DashboardSafeCopyLiveDocument[] {
  const baseline = new Set(attempt.preexistingDocumentIds || []);
  return rows.filter((row) => (
    canonicalText(row.name) === canonicalText(attempt.chosenName || '')
    && !baseline.has(row.documentId)
    && liveScopeMatches(reproved.scope, row)
    && row.fingerprint === document.expectedPayloadHash
    && !(
      target.sourceInstanceId === target.destinationInstanceId
      && row.documentId === document.sourceDocumentId
    )
  ));
}

async function applySemanticChange(
  input: DashboardSafeCopyExecutionInput,
  target: DashboardSafeCopyReprovedTarget,
  dependencies: DashboardSafeCopyExecutorDependencies,
  deadlineAt: number,
): Promise<DashboardSafeCopyExecutionException | undefined> {
  if (target.semanticChange.mode === 'none') return undefined;
  if (!semanticChangeIsSafe(target.semanticChange) || target.semanticChange.mode !== 'existing_file_update') {
    return exception(
      target.targetId,
      'SEMANTIC_CHANGE_UNSAFE',
      'Automatic copy supports only one checksum-protected update to an existing model file.',
      false,
    );
  }
  let attempt = attemptBase(input, target, 'semantic_update', dependencies);
  attempt = {
    ...attempt,
    fileName: target.semanticChange.fileName,
    previousChecksum: target.semanticChange.previousChecksum,
    expectedYamlHash: target.semanticChange.expectedYamlHash,
  };
  try {
    await withDeadline(
      dependencies.persistAttempt(attempt),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch (error) {
    return exception(
      target.targetId,
      error instanceof TargetDeadlineError ? 'TARGET_DEADLINE_EXCEEDED' : 'SEMANTIC_APPLY_FAILED',
      error instanceof TargetDeadlineError
        ? 'Persisting the model-write intent exceeded the bounded destination deadline.'
        : 'The model-write intent could not be persisted, so no model write was dispatched.',
      !(error instanceof TargetDeadlineError),
    );
  }
  try {
    await withWriteDeadline((guard) => dependencies.applySemanticChange(target, attempt, guard), deadlineAt, dependencies.now || Date.now);
    const reconciled = await withDeadline(
      dependencies.reconcileSemanticChange(target, attempt),
      deadlineAt,
      dependencies.now || Date.now,
    );
    if (reconciled !== 'verified') {
      await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
      return exception(
        target.targetId,
        'SEMANTIC_APPLY_FAILED',
        'The checksum-protected model update could not be verified.',
        false,
      );
    }
    await persistAttempt(dependencies, attempt, 'verified', {}, deadlineAt);
    return undefined;
  } catch (error) {
    const classification = dependencies.classifyWriteFailure?.(error) || 'uncertain';
    if (classification === 'definitely_not_committed') {
      await persistAttempt(dependencies, attempt, 'failed_prewrite', {}, deadlineAt);
      return exception(
        target.targetId,
        'SEMANTIC_APPLY_FAILED',
        'The checksum-protected model update did not begin.',
        true,
      );
    }
    let reconciled: DashboardSafeCopyAttemptReconciliation = 'uncertain';
    try {
      reconciled = await withDeadline(
        dependencies.reconcileSemanticChange(target, attempt),
        deadlineAt,
        dependencies.now || Date.now,
      );
    } catch {
      reconciled = 'uncertain';
    }
    await persistAttempt(
      dependencies,
      attempt,
      reconciled === 'verified' ? 'verified' : 'uncertain',
      {},
      deadlineAt,
    );
    if (reconciled === 'verified') return undefined;
    return exception(
      target.targetId,
      'SEMANTIC_APPLY_FAILED',
      'The model update has an uncertain outcome and will not be retried automatically.',
      false,
    );
  }
}

async function executeDocument(
  input: DashboardSafeCopyExecutionInput,
  targetInput: DashboardSafeCopyExecutionTarget,
  target: DashboardSafeCopyReprovedTarget,
  sourceDocumentId: string,
  dependencies: DashboardSafeCopyExecutorDependencies,
  deadlineAt: number,
): Promise<DashboardSafeCopyDocumentResult> {
  let document: DashboardSafeCopyPreparedDocument;
  try {
    document = await withDeadline(
      dependencies.prepareDocument(target, sourceDocumentId),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch (error) {
    const drift = deploymentFailure(error);
    const code = drift?.code || (error instanceof TargetDeadlineError ? 'TARGET_DEADLINE_EXCEEDED' : 'DOCUMENT_PREPARATION_FAILED');
    return {
      sourceDocumentId,
      status: 'needs_attention',
      exception: exception(
        target.targetId,
        code,
        drift?.message || (code === 'TARGET_DEADLINE_EXCEEDED'
          ? 'Preparation exceeded the bounded destination deadline.'
          : 'The source dashboard could not be prepared as content-only copy data.'),
        !drift && code !== 'TARGET_DEADLINE_EXCEEDED',
        sourceDocumentId,
      ),
    };
  }
  if (
    document.sourceDocumentId !== sourceDocumentId
    || !clean(document.documentName)
    || !clean(document.sourceExportHash)
    || !clean(document.expectedPayloadHash)
  ) {
    return {
      sourceDocumentId,
      status: 'needs_attention',
      exception: exception(
        target.targetId,
        'DOCUMENT_PREPARATION_FAILED',
        'Prepared dashboard evidence was incomplete.',
        false,
        sourceDocumentId,
      ),
    };
  }
  try {
    document = {
      ...document,
      content: materializeDashboardSafeCopyDocumentContent(document.content),
    };
  } catch {
    return {
      sourceDocumentId,
      status: 'needs_attention',
      exception: exception(
        target.targetId,
        'CONTENT_SECURITY_UNSAFE',
        'The prepared dashboard contained fields outside the content-only copy contract.',
        false,
        sourceDocumentId,
      ),
    };
  }

  let baselineInventory: DashboardSafeCopyScopeInventory;
  try {
    baselineInventory = await withDeadline(
      dependencies.readDestinationScope(target, { forceRefresh: true }),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch (error) {
    const code = error instanceof TargetDeadlineError ? 'TARGET_DEADLINE_EXCEEDED' : 'IMPORT_FAILED';
    return {
      sourceDocumentId,
      status: 'needs_attention',
      exception: exception(
        target.targetId,
        code,
        code === 'TARGET_DEADLINE_EXCEEDED'
          ? 'Destination inventory exceeded the bounded target deadline.'
          : 'A complete destination inventory is required before copying.',
        true,
        sourceDocumentId,
      ),
    };
  }
  if (!inventoryMatchesTarget(target.scope, baselineInventory)) {
    return {
      sourceDocumentId,
      status: 'needs_attention',
      exception: exception(
        target.targetId,
        'IMPORT_FAILED',
        'Destination inventory did not prove one complete canonical folder scope.',
        false,
        sourceDocumentId,
      ),
    };
  }
  const baseline = baselineInventory.documents;

  const allocateName = dependencies.allocateName || allocateDashboardSafeCopyName;
  const occupiedNames = baseline.map((row) => row.name);
  const originalName = document.documentName.trim();
  let chosenName: string;
  try {
    chosenName = occupiedNames.some((name) => canonicalText(name) === canonicalText(originalName))
      ? allocateName(originalName, occupiedNames)
      : originalName;
  } catch {
    return {
      sourceDocumentId,
      status: 'needs_attention',
      sourceExportHash: document.sourceExportHash,
      expectedPayloadHash: document.expectedPayloadHash,
      exception: exception(
        target.targetId,
        'IMPORT_FAILED',
        'A non-conflicting destination name could not be allocated safely.',
        false,
        sourceDocumentId,
      ),
    };
  }
  let attempt: DashboardSafeCopyAttemptEvidence = {
    ...attemptBase(input, target, 'document_create', dependencies),
    sourceDocumentId,
    chosenName,
    sourceExportHash: document.sourceExportHash,
    expectedPayloadHash: document.expectedPayloadHash,
    preexistingDocumentIds: baseline
      .filter((row) => canonicalText(row.name) === canonicalText(chosenName))
      .map((row) => row.documentId)
      .sort(),
  };
  try {
    await withDeadline(
      dependencies.persistAttempt(attempt),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch (error) {
    return {
      sourceDocumentId,
      status: 'needs_attention',
      chosenName,
      sourceExportHash: document.sourceExportHash,
      expectedPayloadHash: document.expectedPayloadHash,
      exception: exception(
        target.targetId,
        error instanceof TargetDeadlineError ? 'TARGET_DEADLINE_EXCEEDED' : 'IMPORT_FAILED',
        error instanceof TargetDeadlineError
          ? 'Persisting the create intent exceeded the bounded destination deadline.'
          : 'The create intent could not be persisted, so no dashboard write was dispatched.',
        !(error instanceof TargetDeadlineError),
        sourceDocumentId,
      ),
    };
  }

  let returned: { documentId?: string; identifier?: string } | undefined;
  try {
    returned = await withWriteDeadline(
      (guard) => dependencies.createDocument(target, document, chosenName, attempt, guard),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch (error) {
    const classification = dependencies.classifyWriteFailure?.(error) || 'uncertain';
    if (classification === 'definitely_not_committed') {
      attempt = await persistAttempt(dependencies, attempt, 'failed_prewrite', {}, deadlineAt);
      const drift = deploymentFailure(error);
      return {
        sourceDocumentId,
        status: 'needs_attention',
        chosenName,
        sourceExportHash: document.sourceExportHash,
        expectedPayloadHash: document.expectedPayloadHash,
        exception: exception(
          target.targetId,
          drift?.code || 'IMPORT_FAILED',
          drift?.message || 'The destination did not accept the dashboard create request.',
          !drift,
          sourceDocumentId,
        ),
      };
    }
    attempt = await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
  }

  let inventory: DashboardSafeCopyScopeInventory | undefined;
  try {
    inventory = await withDeadline(
      dependencies.readDestinationScope(target, { forceRefresh: true }),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch {
    inventory = undefined;
  }
  const rows = inventory && inventoryMatchesTarget(target.scope, inventory)
    ? inventory.documents
    : [];
  let candidates = matchingCandidates(targetInput, target, document, attempt, rows);
  if (returned?.documentId || returned?.identifier) {
    candidates = candidates.filter((row) => (
      (!returned?.documentId || row.documentId === returned.documentId)
      && (!returned?.identifier || row.identifier === returned.identifier)
    ));
  }
  if (candidates.length !== 1) {
    await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
    return {
      sourceDocumentId,
      status: 'needs_attention',
      chosenName,
      sourceExportHash: document.sourceExportHash,
      expectedPayloadHash: document.expectedPayloadHash,
      exception: exception(
        target.targetId,
        'IMPORT_UNCERTAIN',
        'The create request outcome could not be reconciled to exactly one verified dashboard.',
        false,
        sourceDocumentId,
      ),
    };
  }
  const candidate = candidates[0];
  attempt = await persistAttempt(dependencies, attempt, attempt.state, {
    importedDocumentId: candidate.documentId,
    importedIdentifier: candidate.identifier,
    publishedFingerprint: candidate.fingerprint,
    verificationStartedAt: (dependencies.now || Date.now)(),
  }, deadlineAt);
  let verified = false;
  try {
    verified = await withDeadline(
      dependencies.verifyDocument(target, document, candidate),
      deadlineAt,
      dependencies.now || Date.now,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    await persistAttempt(dependencies, attempt, 'uncertain', {
      importedDocumentId: candidate.documentId,
      importedIdentifier: candidate.identifier,
      publishedFingerprint: candidate.fingerprint,
    }, deadlineAt);
    return {
      sourceDocumentId,
      status: 'needs_attention',
      chosenName,
      importedDocumentId: candidate.documentId,
      importedIdentifier: candidate.identifier,
      sourceExportHash: document.sourceExportHash,
      expectedPayloadHash: document.expectedPayloadHash,
      publishedFingerprint: candidate.fingerprint,
      exception: exception(
        target.targetId,
        'FINAL_VERIFICATION_FAILED',
        'The created dashboard did not pass exact content, access, and query verification.',
        false,
        sourceDocumentId,
      ),
    };
  }
  const verifierVersion = Math.max(1, Math.floor(dependencies.verifierVersion || 1));
  const resolverVersion = Math.max(1, Math.floor(dependencies.resolverVersion || 1));
  const verifiedAt = (dependencies.now || Date.now)();
  const provenance = provenanceFromAttempt(
    input,
    targetInput,
    target,
    attempt,
    candidate,
    resolverVersion,
    verifierVersion,
    verifiedAt,
  );
  if (!provenance) {
    return {
      sourceDocumentId,
      status: 'needs_attention',
      chosenName,
      importedDocumentId: candidate.documentId,
      importedIdentifier: candidate.identifier,
      sourceExportHash: document.sourceExportHash,
      expectedPayloadHash: document.expectedPayloadHash,
      publishedFingerprint: candidate.fingerprint,
      exception: exception(
        target.targetId,
        'FINAL_VERIFICATION_FAILED',
        'The verified dashboard did not match the immutable provenance scope.',
        false,
        sourceDocumentId,
      ),
    };
  }
  try {
    await withDeadline(
      dependencies.persistVerifiedProvenance(provenance),
      deadlineAt,
      dependencies.now || Date.now,
    );
    attempt = await persistAttempt(dependencies, attempt, 'verified', {
      importedDocumentId: candidate.documentId,
      importedIdentifier: candidate.identifier,
      publishedFingerprint: candidate.fingerprint,
      verifierVersion,
      verifiedAt,
    }, deadlineAt);
  } catch {
    try {
      await persistAttempt(dependencies, attempt, 'uncertain', {
        importedDocumentId: candidate.documentId,
        importedIdentifier: candidate.identifier,
        publishedFingerprint: candidate.fingerprint,
      }, deadlineAt);
    } catch {
      // The durable dispatched attempt remains the reconciliation authority.
    }
    return {
      sourceDocumentId,
      status: 'needs_attention',
      chosenName,
      importedDocumentId: candidate.documentId,
      importedIdentifier: candidate.identifier,
      sourceExportHash: document.sourceExportHash,
      expectedPayloadHash: document.expectedPayloadHash,
      publishedFingerprint: candidate.fingerprint,
      exception: exception(
        target.targetId,
        'FINAL_VERIFICATION_FAILED',
        'The dashboard passed verification, but its durable provenance record could not be completed.',
        false,
        sourceDocumentId,
      ),
    };
  }
  return {
    sourceDocumentId,
    status: 'succeeded',
    chosenName,
    importedDocumentId: attempt.importedDocumentId,
    importedIdentifier: attempt.importedIdentifier,
    sourceExportHash: document.sourceExportHash,
    expectedPayloadHash: document.expectedPayloadHash,
    publishedFingerprint: candidate.fingerprint,
  };
}

async function executeTarget(
  input: DashboardSafeCopyExecutionInput,
  targetInput: DashboardSafeCopyExecutionTarget,
  target: DashboardSafeCopyReprovedTarget,
  dependencies: DashboardSafeCopyExecutorDependencies,
  deadlineAt: number,
  skipDocumentIds: ReadonlySet<string> = new Set(),
  skipSemanticChange = false,
): Promise<DashboardSafeCopyTargetResult> {
  const now = dependencies.now || Date.now;
  if (targetInput.contentOnly && (target.semanticChange.mode !== 'none' || skipSemanticChange)) {
    return failedTarget(target.targetId, exception(
      target.targetId,
      'SEMANTIC_CHANGE_UNSAFE',
      'Repair dependencies in Model Migrator before deploying dashboard content.',
      false,
    ));
  }
  if (!skipSemanticChange) {
    const semanticIssue = await applySemanticChange(input, target, dependencies, deadlineAt);
    if (semanticIssue) return failedTarget(target.targetId, semanticIssue);
  }

  const documents: DashboardSafeCopyDocumentResult[] = [];
  for (const sourceDocumentId of [...new Set(targetInput.sourceDocumentIds)]) {
    if (skipDocumentIds.has(sourceDocumentId)) continue;
    if (now() >= deadlineAt) {
      documents.push({
        sourceDocumentId,
        status: 'needs_attention',
        exception: exception(
          target.targetId,
          'TARGET_DEADLINE_EXCEEDED',
          'This destination exceeded its bounded execution deadline before another write was dispatched.',
          true,
          sourceDocumentId,
        ),
      });
      continue;
    }
    documents.push(await executeDocument(
      input,
      targetInput,
      target,
      sourceDocumentId,
      dependencies,
      deadlineAt,
    ));
  }
  const exceptions = documents.flatMap((document) => document.exception ? [document.exception] : []);
  const scopedSkipCount = targetInput.sourceDocumentIds.filter((id) => skipDocumentIds.has(id)).length;
  const successCount = documents.filter((document) => document.status === 'succeeded').length + scopedSkipCount;
  return {
    targetId: target.targetId,
    status: exceptions.length === 0
      ? 'succeeded'
      : successCount > 0
        ? 'partial'
        : 'needs_attention',
    documents,
    exceptions,
  };
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

function overallStatus(targets: readonly DashboardSafeCopyTargetResult[]): DashboardSafeCopyExecutionResult['status'] {
  const succeeded = targets.filter((target) => target.status === 'succeeded').length;
  if (succeeded === targets.length) return 'succeeded';
  if (succeeded > 0 || targets.some((target) => target.status === 'partial')) return 'partial';
  return 'needs_attention';
}

function targetDeadlineAt(
  dependencies: DashboardSafeCopyExecutorDependencies,
  target?: DashboardSafeCopyExecutionTarget,
): number {
  const now = (dependencies.now || Date.now)();
  const localDeadline = now + Math.max(1_000, dependencies.targetDeadlineMs || DEFAULT_TARGET_DEADLINE_MS);
  return typeof target?.deadlineAt === 'number' && Number.isFinite(target.deadlineAt)
    ? Math.min(localDeadline, target.deadlineAt)
    : localDeadline;
}

function deadlineFailure(targetId: string): DashboardSafeCopyTargetResult {
  return failedTarget(targetId, exception(
    targetId,
    'TARGET_DEADLINE_EXCEEDED',
    'This destination exceeded its bounded execution deadline.',
    true,
  ));
}

function containedFailure(targetId: string): DashboardSafeCopyTargetResult {
  return failedTarget(targetId, exception(
    targetId,
    'TARGET_EXECUTION_FAILED',
    'This destination stopped before its next write could be safely dispatched.',
    true,
  ));
}

async function executeTargetLifecycle(
  input: DashboardSafeCopyExecutionInput,
  targetInput: DashboardSafeCopyExecutionTarget,
  dependencies: DashboardSafeCopyExecutorDependencies,
): Promise<DashboardSafeCopyTargetResult> {
  const deadlineAt = targetDeadlineAt(dependencies, targetInput);
  try {
    const requestedSkips = targetInput.skipDocumentIds || [];
    const skipDocumentIds = new Set(requestedSkips);
    if (
      skipDocumentIds.size !== requestedSkips.length
      || [...skipDocumentIds].some((sourceDocumentId) => !targetInput.sourceDocumentIds.includes(sourceDocumentId))
    ) {
      return failedTarget(targetInput.targetId, exception(
        targetInput.targetId,
        'TARGET_EXECUTION_FAILED',
        'Persisted completed-dashboard evidence did not match the canonical source selection.',
        false,
      ));
    }
    const target = await withDeadline(
      dependencies.reproveTarget(targetInput),
      deadlineAt,
      dependencies.now || Date.now,
    );
    if (!targetMatchesReproof(targetInput, target)) {
      return failedTarget(targetInput.targetId, exception(
        targetInput.targetId,
        'TARGET_REPROOF_FAILED',
        'Fresh target evidence did not match the immutable safe-copy scope.',
        false,
      ));
    }
    const semanticSkip = targetInput.skipSemanticChange;
    if (
      semanticSkip
      && (
        target.semanticChange.mode !== 'existing_file_update'
        || target.semanticChange.fileName !== semanticSkip.fileName
        || target.semanticChange.previousChecksum !== semanticSkip.previousChecksum
        || target.semanticChange.expectedYamlHash !== semanticSkip.expectedYamlHash
      )
    ) {
      return failedTarget(targetInput.targetId, exception(
        targetInput.targetId,
        'TARGET_EXECUTION_FAILED',
        'Persisted completed model-change evidence did not match the freshly revalidated target.',
        false,
      ));
    }
    return await executeTarget(
      input,
      targetInput,
      target,
      dependencies,
      deadlineAt,
      skipDocumentIds,
      Boolean(semanticSkip),
    );
  } catch (error) {
    const drift = deploymentFailure(error);
    if (drift) return failedTarget(targetInput.targetId, exception(targetInput.targetId, drift.code, drift.message, false));
    return error instanceof TargetDeadlineError
      ? deadlineFailure(targetInput.targetId)
      : containedFailure(targetInput.targetId);
  }
}

export async function executeDashboardSafeCopy(
  input: DashboardSafeCopyExecutionInput,
  dependencies: DashboardSafeCopyExecutorDependencies,
): Promise<DashboardSafeCopyExecutionResult> {
  const scopeCounts = new Map<string, number>();
  for (const target of input.targets) {
    const key = inputScopeKey(target);
    scopeCounts.set(key, (scopeCounts.get(key) || 0) + 1);
  }
  const concurrency = Math.max(1, Math.min(4, dependencies.targetConcurrency || DEFAULT_TARGET_CONCURRENCY));
  const queuedAt = (dependencies.now || Date.now)();
  const byModel = new Map<string, DashboardSafeCopyExecutionTarget[]>();
  for (const target of input.targets) {
    const modelKey = JSON.stringify([target.destinationInstanceId, target.modelId]);
    byModel.set(modelKey, [...(byModel.get(modelKey) || []), target]);
  }
  const results = new Map<string, DashboardSafeCopyTargetResult>();
  const executeScheduledTarget = async (originalTarget: DashboardSafeCopyExecutionTarget): Promise<void> => {
    // Model-sharing folder routes serialize, without charging queue time to their work budget.
    const queuedFor = Math.max(0, (dependencies.now || Date.now)() - queuedAt);
    const target = originalTarget.deadlineAt === undefined ? originalTarget : {
      ...originalTarget, deadlineAt: originalTarget.deadlineAt + queuedFor,
    };
    let result: DashboardSafeCopyTargetResult;
    if ((scopeCounts.get(inputScopeKey(target)) || 0) > 1) {
      result = failedTarget(target.targetId, exception(
        target.targetId,
        'DUPLICATE_DESTINATION_SCOPE',
        'More than one target resolves to the same destination model and folder scope.',
        false,
      ));
    } else {
      result = await executeTargetLifecycle(input, target, dependencies);
    }
    try {
      await dependencies.onTargetResult?.(result);
    } catch {
      // Target execution remains isolated; the runtime performs a final exact-ledger retry.
    }
    results.set(target.targetId, result);
  };
  await mapWithConcurrency([...byModel.values()], concurrency, async (modelTargets) => {
    for (const target of modelTargets) await executeScheduledTarget(target);
  });
  const targets = input.targets.map((target) => results.get(target.targetId)!);
  return { jobId: input.jobId, status: overallStatus(targets), targets };
}

const RETRY_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function attemptMatchesTargetScope(
  target: DashboardSafeCopyReprovedTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
): boolean {
  return attempt.targetId === target.targetId
    && attempt.destinationInstanceId === target.scope.destinationInstanceId
    && attempt.connectionId === target.scope.connectionId
    && attempt.modelId === target.scope.modelId
    && folderScopeMatches(attempt, target.scope);
}

function semanticAttemptMatchesReproof(
  target: DashboardSafeCopyReprovedTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
): boolean {
  if (!attemptMatchesTargetScope(target, attempt)) return false;
  if (target.semanticChange.mode === 'none') {
    return Boolean(clean(attempt.fileName) && clean(attempt.previousChecksum) && clean(attempt.expectedYamlHash));
  }
  if (target.semanticChange.mode !== 'existing_file_update') return false;
  return attempt.fileName === target.semanticChange.fileName
    && attempt.previousChecksum === target.semanticChange.previousChecksum
    && attempt.expectedYamlHash === target.semanticChange.expectedYamlHash;
}

function documentAttemptHasVerifiedEvidence(
  targetInput: DashboardSafeCopyExecutionTarget,
  attempt: DashboardSafeCopyAttemptEvidence,
): boolean {
  return attempt.state === 'verified'
    && Boolean(clean(attempt.sourceDocumentId))
    && Boolean(clean(attempt.sourceExportHash))
    && Boolean(clean(attempt.expectedPayloadHash))
    && Boolean(clean(attempt.chosenName))
    && Boolean(clean(attempt.importedDocumentId))
    && Boolean(clean(attempt.importedIdentifier))
    && attempt.publishedFingerprint === attempt.expectedPayloadHash
    && Number.isInteger(attempt.verifierVersion)
    && (attempt.verifierVersion || 0) > 0
    && typeof attempt.verifiedAt === 'number'
    && Number.isFinite(attempt.verifiedAt)
    && !(
      targetInput.sourceInstanceId === targetInput.destinationInstanceId
      && attempt.importedDocumentId === attempt.sourceDocumentId
    );
}

async function reconcileRetryAttempts(
  input: DashboardSafeCopyExecutionInput,
  targetInput: DashboardSafeCopyExecutionTarget,
  target: DashboardSafeCopyReprovedTarget,
  state: DashboardSafeCopyTargetState,
  dependencies: DashboardSafeCopyExecutorDependencies,
  deadlineAt: number,
): Promise<{
  issue?: DashboardSafeCopyExecutionException;
  verifiedDocuments: Set<string>;
  semanticVerified: boolean;
}> {
  const verifiedDocuments = new Set<string>();
  let semanticVerified = false;
  const attempts = [...state.attempts].sort((left, right) => (
    left.createdAt - right.createdAt || left.attemptId.localeCompare(right.attemptId)
  ));
  for (const storedAttempt of attempts) {
    let attempt = storedAttempt;
    if (!attemptMatchesTargetScope(target, attempt)) {
      return {
        verifiedDocuments,
        semanticVerified,
        issue: exception(
          target.targetId,
          'RETRY_EVIDENCE_MISSING',
          'Persisted retry evidence did not match the immutable destination scope.',
          false,
          attempt.sourceDocumentId,
        ),
      };
    }
    if (attempt.operation === 'semantic_update') {
      if (!semanticAttemptMatchesReproof(target, attempt)) {
        return {
          verifiedDocuments,
          semanticVerified,
          issue: exception(
            target.targetId,
            'RETRY_EVIDENCE_MISSING',
            'Persisted model-write evidence did not match the fresh checksum proof.',
            false,
          ),
        };
      }
      if (attempt.state === 'verified') {
        semanticVerified = true;
        continue;
      }
      if (attempt.state === 'failed_prewrite') continue;
      const reconciliation = await withDeadline(
        dependencies.reconcileSemanticChange(target, attempt),
        deadlineAt,
        dependencies.now || Date.now,
      );
      if (reconciliation === 'verified') {
        await persistAttempt(dependencies, attempt, 'verified', {}, deadlineAt);
        semanticVerified = true;
        continue;
      }
      if (reconciliation === 'not_committed') {
        await persistAttempt(dependencies, attempt, 'failed_prewrite', {}, deadlineAt);
        continue;
      }
      await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
      return {
        verifiedDocuments,
        semanticVerified,
        issue: exception(
          target.targetId,
          'SEMANTIC_OUTCOME_UNCERTAIN',
          'A prior checksum-protected model write is still uncertain, so no retry was dispatched.',
          false,
        ),
      };
    }

    if (!attempt.sourceDocumentId || !targetInput.sourceDocumentIds.includes(attempt.sourceDocumentId)) {
      return {
        verifiedDocuments,
        semanticVerified,
        issue: exception(
          target.targetId,
          'RETRY_EVIDENCE_MISSING',
          'Persisted dashboard retry evidence did not match the canonical source selection.',
          false,
        ),
      };
    }
    const sourceDocumentId = attempt.sourceDocumentId;
    if (documentAttemptHasVerifiedEvidence(targetInput, attempt)) {
      verifiedDocuments.add(sourceDocumentId);
      continue;
    }
    if (attempt.state === 'failed_prewrite') continue;
    const reconciliation = await withDeadline(
      dependencies.reconcilePersistedAttempt(target, attempt),
      deadlineAt,
      dependencies.now || Date.now,
    );
    if (reconciliation.status === 'candidate') {
      const verifierVersion = Math.max(1, Math.floor(dependencies.verifierVersion || 1));
      const verificationStartedAt = attempt.verificationStartedAt || (dependencies.now || Date.now)();
      try {
        attempt = await persistAttempt(dependencies, attempt, attempt.state, {
          importedDocumentId: reconciliation.liveDocument.documentId,
          importedIdentifier: reconciliation.liveDocument.identifier,
          publishedFingerprint: reconciliation.liveDocument.fingerprint,
          verificationStartedAt,
        }, deadlineAt);
      } catch {
        await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
        return {
          verifiedDocuments,
          semanticVerified,
          issue: exception(
            target.targetId,
            'IMPORT_UNCERTAIN',
            'The reconciled candidate could not be durably recorded before verification.',
            false,
            attempt.sourceDocumentId,
          ),
        };
      }
      let verified = false;
      try {
        verified = await withDeadline(
          dependencies.verifyDocument(target, reconciliation.preparedDocument, reconciliation.liveDocument),
          deadlineAt,
          dependencies.now || Date.now,
        );
      } catch {
        verified = false;
      }
      if (!verified) {
        await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
        return {
          verifiedDocuments,
          semanticVerified,
          issue: exception(
            target.targetId,
            'IMPORT_UNCERTAIN',
            'The reconciled dashboard did not pass final verification.',
            false,
            attempt.sourceDocumentId,
          ),
        };
      }
      const verifiedAt = (dependencies.now || Date.now)();
      const provenance = provenanceFromAttempt(
        input,
        targetInput,
        target,
        attempt,
        reconciliation.liveDocument,
        Math.max(1, Math.floor(dependencies.resolverVersion || 1)),
        verifierVersion,
        verifiedAt,
      );
      if (!provenance) {
        await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
        return {
          verifiedDocuments,
          semanticVerified,
          issue: exception(
            target.targetId,
            'IMPORT_UNCERTAIN',
            'Reconciled dashboard evidence did not match the immutable provenance scope.',
            false,
            attempt.sourceDocumentId,
          ),
        };
      }
      await withDeadline(
        dependencies.persistVerifiedProvenance(provenance),
        deadlineAt,
        dependencies.now || Date.now,
      );
      await persistAttempt(dependencies, attempt, 'verified', {
        importedDocumentId: reconciliation.liveDocument.documentId,
        importedIdentifier: reconciliation.liveDocument.identifier,
        publishedFingerprint: reconciliation.liveDocument.fingerprint,
        verifierVersion,
        verifiedAt,
      }, deadlineAt);
      verifiedDocuments.add(sourceDocumentId);
      continue;
    }
    if (reconciliation.status === 'not_committed') {
      if (attempt.verificationStartedAt !== undefined) {
        await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
        return {
          verifiedDocuments,
          semanticVerified,
          issue: exception(
            target.targetId,
            'IMPORT_UNCERTAIN',
            'A previously observed dashboard candidate cannot be classified as not committed.',
            false,
            attempt.sourceDocumentId,
          ),
        };
      }
      await persistAttempt(dependencies, attempt, 'failed_prewrite', {}, deadlineAt);
      continue;
    }
    await persistAttempt(dependencies, attempt, 'uncertain', {}, deadlineAt);
    return {
      verifiedDocuments,
      semanticVerified,
      issue: exception(
        target.targetId,
        'IMPORT_UNCERTAIN',
        'A prior create attempt is still uncertain, so this destination will not be retried.',
        false,
        attempt.sourceDocumentId,
      ),
    };
  }
  return { verifiedDocuments, semanticVerified };
}

export async function retryDashboardSafeCopyTarget(
  input: DashboardSafeCopyExecutionInput,
  targetId: string,
  retryRequestId: string,
  dependencies: DashboardSafeCopyExecutorDependencies,
): Promise<DashboardSafeCopyTargetResult> {
  const targetInput = input.targets.find((target) => target.targetId === targetId);
  if (!targetInput) {
    return failedTarget(targetId, exception(
      targetId,
      'RETRY_EVIDENCE_MISSING',
      'The requested destination is not part of this safe-copy job.',
      false,
    ));
  }
  const canonicalRetryRequestId = clean(retryRequestId)?.toLowerCase();
  if (!canonicalRetryRequestId || !RETRY_REQUEST_ID_PATTERN.test(canonicalRetryRequestId)) {
    return failedTarget(targetId, exception(
      targetId,
      'RETRY_REQUEST_INVALID',
      'A canonical retry request ID is required.',
      false,
    ));
  }
  const deadlineAt = targetDeadlineAt(dependencies, targetInput);
  try {
    const claim = await withDeadline(
      dependencies.claimRetryRequest(input.jobId, targetId, canonicalRetryRequestId),
      deadlineAt,
      dependencies.now || Date.now,
    );
    if (claim !== 'claimed') {
      return failedTarget(targetId, exception(
        targetId,
        claim === 'duplicate' ? 'RETRY_REQUEST_DUPLICATE' : 'RETRY_REQUEST_CONFLICT',
        claim === 'duplicate'
          ? 'This retry request was already accepted; reload the existing job result.'
          : 'This retry request ID conflicts with previously persisted retry evidence.',
        false,
      ));
    }
    const state = await withDeadline(
      dependencies.loadTargetState(input.jobId, targetId),
      deadlineAt,
      dependencies.now || Date.now,
    );
    if (state.status === 'succeeded') {
      return failedTarget(targetId, exception(
        targetId,
        'TARGET_ALREADY_COMPLETE',
        'Successful destinations are immutable and are not retried.',
        false,
      ));
    }
    const target = await withDeadline(
      dependencies.reproveTarget(targetInput),
      deadlineAt,
      dependencies.now || Date.now,
    );
    if (!targetMatchesReproof(targetInput, target)) {
      return failedTarget(targetId, exception(
        targetId,
        'TARGET_REPROOF_FAILED',
        'Fresh target evidence did not match the persisted retry scope.',
        false,
      ));
    }
    const reconciled = await reconcileRetryAttempts(
      input,
      targetInput,
      target,
      state,
      dependencies,
      deadlineAt,
    );
    if (reconciled.issue) return failedTarget(targetId, reconciled.issue);
    return await executeTarget(
      input,
      targetInput,
      target,
      dependencies,
      deadlineAt,
      reconciled.verifiedDocuments,
      reconciled.semanticVerified,
    );
  } catch (error) {
    const drift = deploymentFailure(error);
    if (drift) return failedTarget(targetId, exception(targetId, drift.code, drift.message, false));
    return error instanceof TargetDeadlineError
      ? deadlineFailure(targetId)
      : containedFailure(targetId);
  }
}
