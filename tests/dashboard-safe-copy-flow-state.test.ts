import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DASHBOARD_SAFE_COPY_DRAFT_STORAGE_KEY,
  createDashboardSafeCopyDraft,
  dashboardSafeCopyDraftReducer,
  dashboardSafeCopyIntentFromDraft,
  dashboardSafeCopyJobEvidenceClock,
  dashboardSafeCopyJobProgress,
  dashboardSafeCopyTargetActions,
  isDashboardSafeCopyTerminal,
  isDashboardSafeCopyJobForRequest,
  readDashboardSafeCopyDraft,
  resolveDashboardSafeCopyDestinationDefaults,
  shouldApplyDashboardSafeCopyJobSnapshot,
  writeDashboardSafeCopyDraft,
  type DashboardSafeCopyDraft,
} from '../src/components/dashboardMigration/dashboardSafeCopyFlowState';
import { sha256Text } from '../src/services/contentHash';
import type {
  InstanceModel,
  MigrationJob,
  ModelMigratorConnection,
  SavedInstancePublic,
} from '../src/services/opsConsole';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_HASH = 'a'.repeat(64);
const PAYLOAD_HASH = 'b'.repeat(64);
const ATTEMPT_CREATED_AT = Date.UTC(2026, 0, 1);
const VERIFICATION_STARTED_AT = ATTEMPT_CREATED_AT + 10;
const VERIFIED_AT = ATTEMPT_CREATED_AT + 20;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
  );
}

function stampAttemptFingerprint(item: MigrationJob['items'][number]): MigrationJob['items'][number] {
  const details = item.details!;
  const preexistingDocumentIds = Array.isArray(details.safeCopyPreexistingDocumentIds)
    ? [...details.safeCopyPreexistingDocumentIds].sort()
    : [];
  details.safeCopyAttemptFingerprint = sha256Text(JSON.stringify(stableValue({
    attemptId: details.safeCopyAttemptId,
    jobId: item.jobId,
    targetId: item.targetId,
    operation: details.safeCopyAttemptOperation,
    destinationInstanceId: details.safeCopyDestinationInstanceId,
    connectionId: details.safeCopyConnectionId,
    modelId: details.safeCopyModelId,
    folderId: item.targetFolderId || '',
    folderPath: (item.targetFolderPath || '').normalize('NFKC').trim().toLocaleLowerCase('en-US'),
    sourceDocumentId: details.safeCopySourceDocumentId || '',
    chosenName: details.safeCopyChosenName || '',
    sourceExportHash: details.safeCopySourceExportHash || '',
    expectedPayloadHash: details.safeCopyExpectedPayloadHash || '',
    fileName: details.safeCopyFileName || '',
    previousChecksum: details.safeCopyPreviousChecksum || '',
    expectedYamlHash: details.safeCopyExpectedYamlHash || '',
    preexistingDocumentIds,
    createdAt: details.safeCopyAttemptCreatedAt,
  })));
  return item;
}

function attestJob(
  job: MigrationJob,
  patch: Partial<{
    evidenceRevision: number;
    invalidTargetIds: string[];
    validatedAttemptIds: string[];
    verifiedDocuments: Array<{
      targetId: string;
      sourceDocumentId: string;
      importedDocumentId: string;
      importedIdentifier: string;
      chosenTargetName: string;
      verifiedAt: number;
    }>;
  }> = {},
): MigrationJob {
  const evidenceRevision = patch.evidenceRevision ?? 1;
  const validatedAttemptIds = patch.validatedAttemptIds ?? job.items.flatMap((item) => {
    const attemptId = item.details?.safeCopyAttemptId;
    return item.details?.safeCopyAttempt === true && typeof attemptId === 'string' ? [attemptId] : [];
  });
  const verifiedDocuments = patch.verifiedDocuments ?? job.items.flatMap((item) => {
    const provenance = item.details?.safeCopyDocumentProvenance;
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return [];
    const row = provenance as Record<string, unknown>;
    return typeof row.targetId === 'string'
      && typeof row.sourceDocumentId === 'string'
      && typeof row.importedDocumentId === 'string'
      && typeof row.importedIdentifier === 'string'
      && typeof row.chosenName === 'string'
      && typeof row.verifiedAt === 'number'
      ? [{
        targetId: row.targetId,
        sourceDocumentId: row.sourceDocumentId,
        importedDocumentId: row.importedDocumentId,
        importedIdentifier: row.importedIdentifier,
        chosenTargetName: row.chosenName,
        verifiedAt: row.verifiedAt,
      }]
      : [];
  });
  job.details = {
    ...(job.details || {}),
    safeCopyEvidenceRevision: evidenceRevision,
    safeCopyClientEvidence: {
      version: 1,
      jobId: job.id,
      evidenceRevision,
      complete: true,
      invalidTargetIds: patch.invalidTargetIds ?? [],
      validatedAttemptIds,
      verifiedDocuments,
    },
  };
  return job;
}

function storage(initial?: unknown) {
  let value = initial === undefined ? null : JSON.stringify(initial);
  return {
    getItem(key: string) {
      assert.equal(key, DASHBOARD_SAFE_COPY_DRAFT_STORAGE_KEY);
      return value;
    },
    setItem(key: string, next: string) {
      assert.equal(key, DASHBOARD_SAFE_COPY_DRAFT_STORAGE_KEY);
      value = next;
    },
    value: () => value,
  };
}

function instance(defaultModelId?: string): Pick<SavedInstancePublic, 'defaultModelId'> {
  return { defaultModelId };
}

function connection(id: string, deletedAt?: string): ModelMigratorConnection {
  return { id, name: id, dialect: 'postgres', database: id, deletedAt };
}

function model(id: string, connectionId: string, deletedAt?: string): InstanceModel {
  return { id, name: id, connectionId, deletedAt };
}

function draft(patch: Partial<DashboardSafeCopyDraft> = {}): DashboardSafeCopyDraft {
  return {
    version: 1,
    step: 1,
    requestId: REQUEST_ID,
    sourceId: 'source-a',
    sourceConnectionId: 'source-connection',
    selectedDocumentIds: ['dashboard-2', 'dashboard-1'],
    destinations: [{
      targetId: 'B',
      instanceId: 'destination-b',
      connectionId: 'connection-b',
      modelId: 'model-b',
    }],
    ...patch,
  };
}

function attemptItem(
  jobId: string,
  targetId: string,
  state: 'dispatched' | 'failed_prewrite' | 'uncertain' | 'verified',
  updatedAt: number,
  patch: Partial<MigrationJob['items'][number]> = {},
): MigrationJob['items'][number] {
  const lower = targetId.toLowerCase();
  const attemptId = `attempt-${lower}`;
  return stampAttemptFingerprint({
    id: `safe-copy-attempt:${attemptId}`,
    jobId,
    targetId,
    destinationId: `destination-${lower}`,
    destinationLabel: `Destination ${targetId}`,
    targetModelId: `model-${lower}`,
    kind: 'import',
    documentId: 'dashboard-1',
    documentName: 'Dashboard 1 copy',
    status: state === 'verified' ? 'succeeded'
      : state === 'uncertain' ? 'warning'
        : state === 'failed_prewrite' ? 'failed' : 'running',
    details: {
      safeCopyAttempt: true,
      safeCopyAttemptId: attemptId,
      safeCopyAttemptOperation: 'document_create',
      safeCopyAttemptState: state,
      safeCopyAttemptCreatedAt: 1,
      safeCopyAttemptUpdatedAt: updatedAt,
      safeCopyDestinationInstanceId: `destination-${lower}`,
      safeCopyConnectionId: `connection-${lower}`,
      safeCopyModelId: `model-${lower}`,
      safeCopySourceDocumentId: 'dashboard-1',
      safeCopyChosenName: 'Dashboard 1 copy',
    },
    ...patch,
  });
}

function progressJob(): MigrationJob {
  const targets = ['B', 'C', 'D', 'E'].map((id) => ({
    id,
    destinationInstanceId: `destination-${id.toLowerCase()}`,
    destinationLabel: `Destination ${id}`,
    targetConnectionId: `connection-${id.toLowerCase()}`,
    targetModelId: `model-${id.toLowerCase()}`,
  }));
  return attestJob({
    id: JOB_ID,
    workflow: 'dashboard',
    sourceId: 'source-a',
    sourceLabel: 'Source A',
    sourceConnectionId: 'source-connection',
    destinationIds: targets.map((target) => target.destinationInstanceId),
    targets,
    documentIds: ['dashboard-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'running',
    createdAt: 1,
    details: {
      safeCopyProfile: 'safe_copy_v1',
      operationMode: 'safe_copy',
      safeCopyRequestId: REQUEST_ID,
    },
    items: [
      attemptItem(JOB_ID, 'B', 'dispatched', 4),
      {
        id: 'preparation-c',
        jobId: JOB_ID,
        targetId: 'C',
        destinationId: 'destination-c',
        destinationLabel: 'Destination C',
        kind: 'semantic_validate',
        status: 'failed',
        error: 'Destination C requires one decision.',
        details: {
          safeCopyPreparationSummary: true,
          safeCopyTargetStatus: 'needs_attention',
        },
      },
      attemptItem(JOB_ID, 'D', 'failed_prewrite', 3),
      attemptItem(JOB_ID, 'E', 'verified', 2),
    ],
  });
}

function verifiedDocumentItems(
  job: MigrationJob,
  targetId: string,
  sourceDocumentId: string,
  suffix = sourceDocumentId,
): MigrationJob['items'] {
  const lower = targetId.toLowerCase();
  const target = job.targets!.find((row) => row.id === targetId)!;
  const attemptId = `verified-${lower}-${suffix}`;
  const importedDocumentId = `imported-${lower}-${suffix}`;
  const importedIdentifier = `verified-${lower}-${suffix}`;
  const chosenName = `Dashboard ${suffix} copy`;
  const verificationStartedAt = VERIFICATION_STARTED_AT;
  const verifiedAt = VERIFIED_AT;
  const attempt = stampAttemptFingerprint({
    id: `safe-copy-attempt:${attemptId}`,
    jobId: job.id,
    targetId,
    destinationId: target.destinationInstanceId,
    destinationLabel: target.destinationLabel || target.destinationInstanceId,
    targetModelId: target.targetModelId,
    kind: 'import',
    documentId: sourceDocumentId,
    documentName: chosenName,
    status: 'succeeded',
    importedDocumentId,
    importedIdentifier,
    startedAt: ATTEMPT_CREATED_AT,
    endedAt: verifiedAt,
    details: {
      safeCopyAttempt: true,
      safeCopyAttemptId: attemptId,
      safeCopyAttemptOperation: 'document_create',
      safeCopyAttemptState: 'verified',
      safeCopyAttemptCreatedAt: ATTEMPT_CREATED_AT,
      safeCopyAttemptUpdatedAt: verifiedAt,
      safeCopyDestinationInstanceId: target.destinationInstanceId,
      safeCopyConnectionId: target.targetConnectionId,
      safeCopyModelId: target.targetModelId,
      safeCopySourceDocumentId: sourceDocumentId,
      safeCopyChosenName: chosenName,
      safeCopySourceExportHash: SOURCE_HASH,
      safeCopyExpectedPayloadHash: PAYLOAD_HASH,
      safeCopyImportedDocumentId: importedDocumentId,
      safeCopyImportedIdentifier: importedIdentifier,
      safeCopyPublishedFingerprint: PAYLOAD_HASH,
      safeCopyVerificationStartedAt: verificationStartedAt,
      safeCopyVerifierVersion: 1,
      safeCopyVerifiedAt: verifiedAt,
    },
  });
  return [
    attempt,
    {
      id: `safe-copy-verification:${attemptId}`,
      jobId: job.id,
      targetId,
      destinationId: target.destinationInstanceId,
      destinationLabel: target.destinationLabel || target.destinationInstanceId,
      targetModelId: target.targetModelId,
      kind: 'document_verify',
      documentId: sourceDocumentId,
      documentName: chosenName,
      status: 'succeeded',
      importedDocumentId,
      importedIdentifier,
      startedAt: verifiedAt,
      endedAt: verifiedAt,
      details: {
        safeCopyDocumentProvenance: {
          profile: 'safe_copy_v1',
          resolverVersion: 1,
          jobId: job.id,
          attemptId,
          targetId,
          sourceInstanceId: job.sourceId,
          sourceConnectionId: job.sourceConnectionId,
          sourceDocumentId,
          sourceExportHash: SOURCE_HASH,
          destinationInstanceId: target.destinationInstanceId,
          connectionId: target.targetConnectionId,
          modelId: target.targetModelId,
          importedDocumentId,
          importedIdentifier,
          chosenName,
          expectedPayloadHash: PAYLOAD_HASH,
          publishedFingerprint: PAYLOAD_HASH,
          verifierVersion: 1,
          verifiedAt,
          finalVerification: 'passed',
          documentWriteMode: 'created',
        },
      },
    },
  ];
}

test('session recovery persists only version, requestId, and optional jobId', () => {
  const memory = storage();
  writeDashboardSafeCopyDraft(draft(), memory);
  assert.deepEqual(JSON.parse(memory.value()!), {
    version: 1,
    requestId: REQUEST_ID,
  });

  writeDashboardSafeCopyDraft(draft({ step: 2, jobId: JOB_ID }), memory);
  assert.deepEqual(JSON.parse(memory.value()!), {
    version: 1,
    requestId: REQUEST_ID,
    jobId: JOB_ID,
  });
  assert.doesNotMatch(memory.value()!, /source-a|dashboard-1|destination-b|connection-b|model-b/);
});

test('reload resumes a server-owned job without restoring migration scope from browser storage', () => {
  const recovered = readDashboardSafeCopyDraft(storage({
    version: 1,
    requestId: REQUEST_ID,
    jobId: JOB_ID,
    sourceId: 'must-not-return',
    selectedDocumentIds: ['must-not-return'],
    destinations: [{ instanceId: 'must-not-return' }],
  }));

  assert.equal(recovered.step, 2);
  assert.equal(recovered.jobId, JOB_ID);
  assert.equal(recovered.sourceId, '');
  assert.equal(recovered.sourceConnectionId, '');
  assert.deepEqual(recovered.selectedDocumentIds, []);
  assert.deepEqual(recovered.destinations, []);
});

test('tampered noncanonical persisted job identity fails closed to a fresh Screen 1 draft', () => {
  const recovered = readDashboardSafeCopyDraft(storage({
    version: 1,
    requestId: REQUEST_ID,
    jobId: 'legacy-or-tampered-job-id',
  }));

  assert.equal(recovered.step, 0);
  assert.equal(recovered.jobId, undefined);
  assert.notEqual(recovered.requestId, REQUEST_ID);
  assert.match(recovered.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('destination defaults resolve deterministic values and prompt only for unresolved choices', () => {
  assert.deepEqual(resolveDashboardSafeCopyDestinationDefaults({
    instance: instance(),
    connections: [connection('connection-b')],
    models: [model('model-b', 'connection-b')],
  }), {
    connectionId: 'connection-b',
    modelId: 'model-b',
    needsConnection: false,
    needsModel: false,
  });

  assert.deepEqual(resolveDashboardSafeCopyDestinationDefaults({
    instance: instance('model-c'),
    connections: [connection('connection-b'), connection('connection-c')],
    models: [model('model-b', 'connection-b'), model('model-c', 'connection-c')],
  }), {
    connectionId: 'connection-c',
    modelId: 'model-c',
    needsConnection: false,
    needsModel: false,
  });

  assert.deepEqual(resolveDashboardSafeCopyDestinationDefaults({
    instance: instance('model-c'),
    connections: [connection('connection-b'), connection('connection-c')],
    models: [model('model-b', 'connection-b'), model('model-c', 'connection-c')],
    current: { connectionId: 'connection-b', modelId: '' },
  }), {
    connectionId: 'connection-b',
    modelId: 'model-b',
    needsConnection: false,
    needsModel: false,
  });

  assert.deepEqual(resolveDashboardSafeCopyDestinationDefaults({
    instance: instance(),
    connections: [connection('connection-b'), connection('connection-c')],
    models: [model('model-b', 'connection-b'), model('model-c', 'connection-c')],
  }), {
    connectionId: '',
    modelId: '',
    needsConnection: true,
    needsModel: true,
  });

  assert.deepEqual(resolveDashboardSafeCopyDestinationDefaults({
    instance: instance(),
    connections: [connection('connection-b')],
    models: [model('model-b-1', 'connection-b'), model('model-b-2', 'connection-b')],
  }), {
    connectionId: 'connection-b',
    modelId: '',
    needsConnection: false,
    needsModel: true,
  });
});

test('A→B and A→B,C,D drafts project only the shared safe_copy_v1 intent', () => {
  const destinations = ['B', 'C', 'D'].map((id) => ({
    targetId: id,
    instanceId: id,
    connectionId: `connection-${id.toLowerCase()}`,
    modelId: `model-${id.toLowerCase()}`,
  }));
  const saved = ['B', 'C', 'D'].map((id) => ({ id, defaultFolderPath: `/Safe/${id}` }));

  const minimal = dashboardSafeCopyIntentFromDraft(draft({ destinations: destinations.slice(0, 1) }), saved);
  const fanout = dashboardSafeCopyIntentFromDraft(draft({ destinations }), saved);

  assert.deepEqual(minimal.destinations.map((row) => row.instanceId), ['B']);
  assert.deepEqual(fanout.destinations.map((row) => row.instanceId), ['B', 'C', 'D']);
  assert.deepEqual(Object.keys(fanout).sort(), ['destinations', 'profile', 'requestId', 'source']);
  assert.deepEqual(Object.keys(fanout.source).sort(), ['connectionId', 'documentIds', 'instanceId']);
  for (const destination of fanout.destinations) {
    assert.deepEqual(Object.keys(destination).sort(), [
      'connectionId',
      'folderPath',
      'instanceId',
      'modelId',
      'targetId',
    ]);
  }
  assert.doesNotMatch(JSON.stringify(fanout), /mapping|patch|permission|waiver|cleanup|delete|replace|postMigration/i);
});

test('job profile validation and progress fail closed for legacy or cross-workflow jobs', () => {
  const valid = progressJob();
  assert.equal(isDashboardSafeCopyJobForRequest(valid, REQUEST_ID), true);

  for (const invalid of [
    { ...valid, workflow: 'model' as const },
    { ...valid, details: { ...valid.details, safeCopyProfile: 'legacy' } },
    { ...valid, details: { ...valid.details, operationMode: 'legacy' } },
  ]) {
    assert.equal(isDashboardSafeCopyJobForRequest(invalid, REQUEST_ID), false);
    assert.deepEqual(dashboardSafeCopyJobProgress(invalid), []);
  }

  const wrongRequest = {
    ...valid,
    details: { ...valid.details, safeCopyRequestId: '33333333-3333-4333-8333-333333333333' },
  };
  assert.equal(isDashboardSafeCopyJobForRequest(wrongRequest, REQUEST_ID), false);
  assert.equal(isDashboardSafeCopyJobForRequest({ ...valid, id: 'malformed-job-id' }, REQUEST_ID), false);
});

test('Choose another model replans only one failed target and never recopies successful destinations', () => {
  const job = progressJob();
  job.items = job.items.filter((item) => item.targetId !== 'C');
  job.items.push({
    id: 'safe-copy-target-result:C',
    jobId: job.id,
    targetId: 'C',
    destinationId: 'destination-c',
    destinationLabel: 'Destination C',
    targetModelId: 'model-c',
    kind: 'document_verify',
    status: 'failed',
    error: 'Destination C needs a different target model.',
    endedAt: 5,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'needs_attention',
      safeCopyExceptionCodes: ['MODEL_DECISION_REQUIRED'],
    },
  });
  attestJob(job);
  const state = draft({ step: 2, jobId: JOB_ID });
  const replanned = dashboardSafeCopyDraftReducer(state, {
    type: 'replan_target',
    job,
    targetId: 'C',
    requestId: '33333333-3333-4333-8333-333333333333',
  });

  assert.equal(replanned.step, 1);
  assert.equal(replanned.jobId, undefined);
  assert.equal(replanned.requestId, '33333333-3333-4333-8333-333333333333');
  assert.equal(replanned.sourceId, job.sourceId);
  assert.equal(replanned.sourceConnectionId, job.sourceConnectionId);
  assert.deepEqual(replanned.selectedDocumentIds, job.documentIds);
  assert.deepEqual(replanned.destinations, [{
    targetId: 'C',
    instanceId: 'destination-c',
    connectionId: 'connection-c',
    modelId: '',
    requiresModelChoice: true,
  }]);

  assert.equal(dashboardSafeCopyDraftReducer(state, {
    type: 'replan_target',
    job,
    targetId: 'B',
    requestId: '44444444-4444-4444-8444-444444444444',
  }), state);
});

test('reconciliation-required and generic failures cannot escape into model replanning', () => {
  const state = draft({ step: 2, jobId: JOB_ID });

  const reconciliationJob = progressJob();
  reconciliationJob.items = [attemptItem(reconciliationJob.id, 'C', 'uncertain', 10)];
  attestJob(reconciliationJob);
  assert.equal(dashboardSafeCopyJobProgress(reconciliationJob).find((row) => row.targetId === 'C')?.phase, 'reconciliation_required');
  assert.equal(dashboardSafeCopyDraftReducer(state, {
    type: 'replan_target',
    job: reconciliationJob,
    targetId: 'C',
    requestId: '33333333-3333-4333-8333-333333333333',
  }), state);

  const genericFailureJob = progressJob();
  genericFailureJob.items = [{
    id: 'safe-copy-target-result:C',
    jobId: genericFailureJob.id,
    targetId: 'C',
    destinationId: 'destination-c',
    destinationLabel: 'Destination C',
    targetModelId: 'model-c',
    kind: 'document_verify',
    status: 'failed',
    error: 'Destination C needs attention without a model decision.',
    endedAt: 10,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'needs_attention',
      safeCopyExceptionCodes: ['IMPORT_FAILED'],
    },
  }];
  attestJob(genericFailureJob);
  assert.equal(dashboardSafeCopyDraftReducer(state, {
    type: 'replan_target',
    job: genericFailureJob,
    targetId: 'C',
    requestId: '44444444-4444-4444-8444-444444444444',
  }), state);
});

test('target exception actions never widen reconciliation or unrelated failures', () => {
  assert.deepEqual(dashboardSafeCopyTargetActions({
    phase: 'reconciliation_required',
    globalHold: false,
    exceptionCodes: ['MODEL_DECISION_REQUIRED'],
    recommendedActions: ['select_target_model', 'open_model_migrator'],
  }), {
    canRetry: true,
    canChooseAnotherModel: false,
    canOpenModelMigrator: false,
  });
  assert.deepEqual(dashboardSafeCopyTargetActions({
    phase: 'needs_attention',
    globalHold: false,
    exceptionCodes: ['MODEL_DECISION_REQUIRED'],
    recommendedActions: [],
  }), {
    canRetry: true,
    canChooseAnotherModel: true,
    canOpenModelMigrator: true,
  });
  assert.deepEqual(dashboardSafeCopyTargetActions({
    phase: 'needs_attention',
    globalHold: false,
    exceptionCodes: ['SECURITY_REVIEW_REQUIRED'],
    recommendedActions: ['open_model_migrator'],
  }), {
    canRetry: true,
    canChooseAnotherModel: false,
    canOpenModelMigrator: true,
  });
  assert.deepEqual(dashboardSafeCopyTargetActions({
    phase: 'needs_attention',
    globalHold: false,
    exceptionCodes: ['IMPORT_FAILED'],
    recommendedActions: [],
  }), {
    canRetry: true,
    canChooseAnotherModel: false,
    canOpenModelMigrator: false,
  });
  assert.deepEqual(dashboardSafeCopyTargetActions({
    phase: 'succeeded',
    globalHold: false,
    exceptionCodes: ['MODEL_DECISION_REQUIRED'],
    recommendedActions: ['select_target_model', 'open_model_migrator'],
  }), {
    canRetry: false,
    canChooseAnotherModel: false,
    canOpenModelMigrator: false,
  });
});

test('target progress is target-scoped and truthful while the overall job is running', () => {
  const job = progressJob();
  job.items.push(
    {
      id: 'stale-result-b',
      jobId: job.id,
      targetId: 'B',
      destinationId: 'destination-b',
      destinationLabel: 'Destination B',
      kind: 'document_verify',
      status: 'failed',
      startedAt: 3,
      endedAt: 3,
      details: {
        safeCopyTargetExecutionSummary: true,
        safeCopyTargetStatus: 'needs_attention',
      },
    },
    attemptItem(job.id, 'C', 'uncertain', 5),
    {
      id: 'safe-copy-target-result:E',
      jobId: job.id,
      targetId: 'E',
      destinationId: 'destination-e',
      destinationLabel: 'Destination E',
      kind: 'document_verify',
      status: 'failed',
      startedAt: 10,
      endedAt: 10,
      details: {
        safeCopyTargetExecutionSummary: true,
        safeCopyTargetStatus: 'needs_attention',
      },
    },
  );
  attestJob(job);
  const progress = Object.fromEntries(dashboardSafeCopyJobProgress(job).map((row) => [row.targetId, row]));

  assert.equal(progress.B.phase, 'copying');
  assert.equal(progress.C.phase, 'reconciliation_required');
  assert.equal(progress.C.message, 'A previous write outcome must be reconciled before this destination can continue.');
  assert.equal(progress.D.phase, 'needs_attention');
  assert.equal(progress.E.phase, 'needs_attention');
});

test('per-document projection proves exact verified lineage and keeps B, C, and D phases isolated', () => {
  const job = progressJob();
  job.targets = job.targets!.filter((target) => ['B', 'C', 'D'].includes(target.id));
  job.destinationIds = job.targets.map((target) => target.destinationInstanceId);
  job.documentIds = ['dashboard-1', 'dashboard-2'];
  job.details = {
    ...job.details,
    safeCopyRuntimeError: 'Bearer omni_rawsecret owner@example.test dashboard: raw-yaml',
  };
  const bProofs = [
    ...verifiedDocumentItems(job, 'B', 'dashboard-1', 'one'),
    ...verifiedDocumentItems(job, 'B', 'dashboard-2', 'two'),
  ];
  const bResult: MigrationJob['items'][number] = {
    id: 'safe-copy-target-result:B',
    jobId: job.id,
    targetId: 'B',
    destinationId: 'destination-b',
    destinationLabel: 'Destination B',
    targetModelId: 'model-b',
    kind: 'document_verify',
    status: 'succeeded',
    startedAt: 22,
    endedAt: 22,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'succeeded',
      safeCopyExceptionCodes: [],
      safeCopyRecommendedActions: [],
      safeCopyDocuments: [
        { sourceDocumentId: 'dashboard-1', status: 'succeeded', chosenName: 'Dashboard one copy' },
        { sourceDocumentId: 'dashboard-2', status: 'succeeded', chosenName: 'Dashboard two copy' },
      ],
    },
  };
  const cAttempt = attemptItem(job.id, 'C', 'dispatched', 30);
  cAttempt.error = 'Bearer omni_attemptsecret raw source yaml';
  cAttempt.importedDocumentId = 'candidate-c';
  cAttempt.importedIdentifier = 'candidate-c-slug';
  cAttempt.details = {
    ...cAttempt.details,
    safeCopyExpectedPayloadHash: PAYLOAD_HASH,
    safeCopyImportedDocumentId: 'candidate-c',
    safeCopyImportedIdentifier: 'candidate-c-slug',
    safeCopyPublishedFingerprint: PAYLOAD_HASH,
    safeCopyVerificationStartedAt: 29,
  };
  const dAttempt = attemptItem(job.id, 'D', 'uncertain', 31);
  job.items = [...bProofs, bResult, cAttempt, dAttempt];
  attestJob(job);

  const progress = Object.fromEntries(dashboardSafeCopyJobProgress(job).map((row) => [row.targetId, row]));
  assert.equal(progress.B.phase, 'succeeded');
  assert.equal(progress.B.activeStage, 'complete');
  assert.deepEqual(progress.B.completedStages, ['prepare', 'copy', 'verify', 'complete']);
  assert.deepEqual(progress.B.documents.map((document) => ({
    sourceDocumentId: document.sourceDocumentId,
    phase: document.phase,
    importedDocumentId: document.importedDocumentId,
    verifiedDestinationIdentifier: document.verifiedDestinationIdentifier,
  })), [
    {
      sourceDocumentId: 'dashboard-1',
      phase: 'complete',
      importedDocumentId: 'imported-b-one',
      verifiedDestinationIdentifier: 'verified-b-one',
    },
    {
      sourceDocumentId: 'dashboard-2',
      phase: 'complete',
      importedDocumentId: 'imported-b-two',
      verifiedDestinationIdentifier: 'verified-b-two',
    },
  ]);

  assert.equal(progress.C.phase, 'verifying');
  assert.equal(progress.C.activeStage, 'verify');
  assert.deepEqual(progress.C.completedStages, ['prepare', 'copy']);
  assert.deepEqual(progress.C.documents.map((document) => document.phase), ['verifying', 'waiting']);

  assert.equal(progress.D.phase, 'reconciliation_required');
  assert.equal(progress.D.activeStage, 'copy');
  assert.deepEqual(progress.D.completedStages, ['prepare']);
  assert.deepEqual(progress.D.documents.map((document) => document.phase), ['reconciliation_required', 'waiting']);

  const projected = JSON.stringify(progress);
  assert.doesNotMatch(projected, /omni_rawsecret|omni_resultsecret|omni_attemptsecret|owner@example\.test|raw-yaml|raw source yaml/i);
});

test('one exact C reconciliation preserves verified B and D without exposing their retry controls', () => {
  const job = progressJob();
  job.targets = job.targets!.filter((target) => ['B', 'C', 'D'].includes(target.id));
  job.destinationIds = job.targets.map((target) => target.destinationInstanceId);
  job.documentIds = ['dashboard-1'];
  job.details = { ...job.details, safeCopyExecutionState: 'reconciliation_required' };
  const succeededResult = (targetId: 'B' | 'D'): MigrationJob['items'][number] => ({
    id: `safe-copy-target-result:${targetId}`,
    jobId: job.id,
    targetId,
    destinationId: `destination-${targetId.toLowerCase()}`,
    destinationLabel: `Destination ${targetId}`,
    targetModelId: `model-${targetId.toLowerCase()}`,
    kind: 'document_verify',
    status: 'succeeded',
    startedAt: VERIFIED_AT,
    endedAt: VERIFIED_AT,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'succeeded',
      safeCopyExceptionCodes: [],
      safeCopyRecommendedActions: [],
      safeCopyDocuments: [{
        sourceDocumentId: 'dashboard-1',
        status: 'succeeded',
        chosenName: 'Dashboard one copy',
      }],
    },
  });
  job.items = [
    ...verifiedDocumentItems(job, 'B', 'dashboard-1', 'one'),
    succeededResult('B'),
    attemptItem(job.id, 'C', 'uncertain', VERIFIED_AT + 1),
    ...verifiedDocumentItems(job, 'D', 'dashboard-1', 'one'),
    succeededResult('D'),
  ];
  attestJob(job, { evidenceRevision: 9 });

  const progress = Object.fromEntries(dashboardSafeCopyJobProgress(job).map((target) => [target.targetId, target]));
  assert.equal(progress.B.phase, 'succeeded');
  assert.equal(progress.D.phase, 'succeeded');
  assert.equal(progress.C.phase, 'reconciliation_required');
  assert.equal(dashboardSafeCopyTargetActions(progress.B).canRetry, false);
  assert.equal(dashboardSafeCopyTargetActions(progress.D).canRetry, false);
  assert.equal(dashboardSafeCopyTargetActions(progress.C).canRetry, true);
});

test('verified destination links require an exact one-to-one attempt and provenance proof', () => {
  const exactJob = progressJob();
  exactJob.targets = exactJob.targets!.filter((target) => target.id === 'B');
  exactJob.destinationIds = ['destination-b'];
  exactJob.documentIds = ['dashboard-1'];
  exactJob.status = 'succeeded';
  exactJob.items = [
    ...verifiedDocumentItems(exactJob, 'B', 'dashboard-1', 'one'),
    {
      id: 'safe-copy-target-result:B',
      jobId: exactJob.id,
      targetId: 'B',
      destinationId: 'destination-b',
      destinationLabel: 'Destination B',
      targetModelId: 'model-b',
      kind: 'document_verify',
      status: 'succeeded',
      startedAt: 22,
      endedAt: 22,
      details: {
        safeCopyTargetExecutionSummary: true,
        safeCopyTargetStatus: 'succeeded',
        safeCopyExceptionCodes: [],
        safeCopyRecommendedActions: [],
        safeCopyDocuments: [{ sourceDocumentId: 'dashboard-1', status: 'succeeded', chosenName: 'Dashboard one copy' }],
      },
    },
  ];
  attestJob(exactJob);
  const exact = dashboardSafeCopyJobProgress(exactJob)[0];
  assert.equal(exact.phase, 'succeeded');
  assert.equal(exact.documents[0].phase, 'complete');
  assert.equal(exact.documents[0].verifiedDestinationIdentifier, 'verified-b-one');

  const evidence = (job: MigrationJob) => job.details!.safeCopyClientEvidence as {
    evidenceRevision: number;
    complete: boolean;
    invalidTargetIds: string[];
    validatedAttemptIds: string[];
    verifiedDocuments: Array<Record<string, unknown>>;
    unexpected?: boolean;
  };
  const mutations: Array<[string, (job: MigrationJob) => void]> = [
    ['revision mismatch', (job) => { evidence(job).evidenceRevision += 1; }],
    ['incomplete attestation', (job) => { evidence(job).complete = false; }],
    ['missing validated attempt', (job) => { evidence(job).validatedAttemptIds = []; }],
    ['duplicate validated attempt', (job) => { evidence(job).validatedAttemptIds.push(evidence(job).validatedAttemptIds[0]); }],
    ['duplicate verified document', (job) => { evidence(job).verifiedDocuments.push(structuredClone(evidence(job).verifiedDocuments[0])); }],
    ['unknown target scope', (job) => { evidence(job).verifiedDocuments[0].targetId = 'unknown-target'; }],
    ['unknown document scope', (job) => { evidence(job).verifiedDocuments[0].sourceDocumentId = 'unknown-document'; }],
    ['unknown attestation key', (job) => { evidence(job).unexpected = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const job = structuredClone(exactJob);
    mutate(job);
    const projected = dashboardSafeCopyJobProgress(job)[0];
    assert.notEqual(projected.phase, 'succeeded', label);
    assert.notEqual(projected.documents[0].phase, 'complete', label);
    assert.equal(projected.documents[0].verifiedDestinationIdentifier, undefined, label);
    assert.equal(projected.documents[0].importedDocumentId, undefined, label);
  }
});

test('verification-start evidence uses its atomic attempt clock and a future marker fails closed', () => {
  const job = progressJob();
  const attempt = attemptItem(job.id, 'B', 'dispatched', 41);
  attempt.importedDocumentId = 'candidate-b';
  attempt.importedIdentifier = 'candidate-b-slug';
  attempt.details = {
    ...attempt.details,
    safeCopyExpectedPayloadHash: PAYLOAD_HASH,
    safeCopyImportedDocumentId: attempt.importedDocumentId,
    safeCopyImportedIdentifier: attempt.importedIdentifier,
    safeCopyPublishedFingerprint: PAYLOAD_HASH,
    safeCopyVerificationStartedAt: 41,
  };
  job.items = [attempt];
  attestJob(job);
  assert.equal(dashboardSafeCopyJobProgress(job).find((row) => row.targetId === 'B')?.phase, 'verifying');

  job.items[0].details!.safeCopyAttemptUpdatedAt = 40;
  job.items[0].details!.safeCopyVerificationStartedAt = 42;
  job.items[0].details!.safeCopyNeedsAt = Number.NaN;
  assert.notEqual(dashboardSafeCopyJobProgress(job).find((row) => row.targetId === 'B')?.phase, 'verifying');
});

test('revision-bound clocks accept same-millisecond evidence and remain stable for a no-op snapshot', () => {
  const revisionTwo = attestJob(progressJob(), { evidenceRevision: 2 });
  const revisionThree = attestJob(structuredClone(revisionTwo), { evidenceRevision: 3 });
  const unchanged = structuredClone(revisionThree);

  assert.equal(revisionTwo.createdAt, revisionThree.createdAt);
  assert.deepEqual(revisionTwo.items.map((item) => item.endedAt), revisionThree.items.map((item) => item.endedAt));
  assert.equal(dashboardSafeCopyJobEvidenceClock(revisionThree), dashboardSafeCopyJobEvidenceClock(revisionTwo) + 1);
  assert.equal(dashboardSafeCopyJobEvidenceClock(unchanged), dashboardSafeCopyJobEvidenceClock(revisionThree));
});

test('explicit retry snapshots reject older concurrent responses and reopen terminal state only with newer evidence', () => {
  const terminal = attestJob(progressJob(), { evidenceRevision: 5 });
  terminal.status = 'partial';
  terminal.endedAt = 50;

  const olderRetryResponse = attestJob(structuredClone(terminal), { evidenceRevision: 4 });
  olderRetryResponse.status = 'running';
  olderRetryResponse.endedAt = undefined;
  assert.equal(shouldApplyDashboardSafeCopyJobSnapshot(
    terminal,
    olderRetryResponse,
    { allowTerminalReopen: true },
  ), false);

  const newerRetryResponse = attestJob(structuredClone(terminal), { evidenceRevision: 6 });
  newerRetryResponse.status = 'running';
  newerRetryResponse.endedAt = undefined;
  assert.equal(shouldApplyDashboardSafeCopyJobSnapshot(terminal, newerRetryResponse), false);
  assert.equal(shouldApplyDashboardSafeCopyJobSnapshot(
    terminal,
    newerRetryResponse,
    { allowTerminalReopen: true },
  ), true);
});

test('oversized or duplicate document and destination scopes create a global no-retry hold', () => {
  const oversizedDocuments = progressJob();
  oversizedDocuments.documentIds = Array.from({ length: 501 }, (_, index) => `dashboard-${index + 1}`);
  attestJob(oversizedDocuments);

  const duplicateDocuments = progressJob();
  duplicateDocuments.documentIds = ['dashboard-1', 'dashboard-1'];
  attestJob(duplicateDocuments);

  const oversizedTargets = progressJob();
  oversizedTargets.targets = Array.from({ length: 101 }, (_, index) => ({
    id: `target-${index + 1}`,
    destinationInstanceId: `destination-${index + 1}`,
    destinationLabel: `Destination ${index + 1}`,
    targetConnectionId: `connection-${index + 1}`,
    targetModelId: `model-${index + 1}`,
  }));
  oversizedTargets.destinationIds = oversizedTargets.targets.map((target) => target.destinationInstanceId);
  oversizedTargets.items = [];
  attestJob(oversizedTargets);

  const duplicateTargetScope = progressJob();
  duplicateTargetScope.targets = [
    {
      id: 'scope-one',
      destinationInstanceId: 'same-destination',
      destinationLabel: 'Destination scope one',
      targetConnectionId: 'same-connection',
      targetModelId: 'same-model',
      targetFolderPath: '/same-folder',
    },
    {
      id: 'scope-two',
      destinationInstanceId: 'same-destination',
      destinationLabel: 'Destination scope two',
      targetConnectionId: 'same-connection',
      targetModelId: 'same-model',
      targetFolderPath: '/same-folder',
    },
  ];
  duplicateTargetScope.destinationIds = ['same-destination'];
  duplicateTargetScope.items = [];
  attestJob(duplicateTargetScope);

  const matrixJob = (documentCount: number, targetCount: number) => {
    const job = progressJob();
    job.documentIds = Array.from({ length: documentCount }, (_, index) => `matrix-dashboard-${index + 1}`);
    job.targets = Array.from({ length: targetCount }, (_, index) => ({
      id: `matrix-target-${index + 1}`,
      destinationInstanceId: `matrix-destination-${index + 1}`,
      destinationLabel: `Matrix destination ${index + 1}`,
      targetConnectionId: `matrix-connection-${index + 1}`,
      targetModelId: `matrix-model-${index + 1}`,
    }));
    job.destinationIds = job.targets.map((target) => target.destinationInstanceId);
    job.items = [];
    return attestJob(job, { validatedAttemptIds: [], verifiedDocuments: [] });
  };
  const matrixAtLimit = matrixJob(500, 2);
  const oversizedMatrix = matrixJob(143, 7);

  const boundaryProgress = dashboardSafeCopyJobProgress(matrixAtLimit);
  assert.equal(boundaryProgress.length, 2);
  assert.ok(boundaryProgress.every((target) => !target.globalHold));

  for (const [label, job] of [
    ['501 documents', oversizedDocuments],
    ['duplicate documents', duplicateDocuments],
    ['101 targets', oversizedTargets],
    ['duplicate target scopes', duplicateTargetScope],
    ['1,001 copy matrix', oversizedMatrix],
  ] as const) {
    const progress = dashboardSafeCopyJobProgress(job);
    assert.ok(progress.length > 0, label);
    assert.ok(progress.every((target) => target.globalHold), label);
    assert.ok(progress.every((target) => target.phase === 'needs_attention'), label);
    assert.ok(progress.every((target) => !dashboardSafeCopyTargetActions(target).canRetry), label);
  }
});

test('an incomplete server attestation creates a global hold without links or retry actions', () => {
  const job = progressJob();
  attestJob(job);
  const evidence = job.details?.safeCopyClientEvidence as Record<string, unknown>;
  evidence.complete = false;

  const progress = dashboardSafeCopyJobProgress(job);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((target) => target.globalHold));
  assert.ok(progress.every((target) => target.phase === 'needs_attention'));
  assert.ok(progress.every((target) => target.documents.every((document) => (
    document.verifiedDestinationIdentifier === undefined && document.importedDocumentId === undefined
  ))));
  assert.ok(progress.every((target) => !dashboardSafeCopyTargetActions(target).canRetry));
});

test('terminal jobs never leave targets looking active without target-local evidence', () => {
  const failed = progressJob();
  failed.status = 'failed';
  failed.items = [];
  failed.details = {
    safeCopyRuntimeError: 'Safe-copy execution stopped before the next write could be safely dispatched.',
  };
  attestJob(failed);
  const failedProgress = dashboardSafeCopyJobProgress(failed);
  assert.ok(failedProgress.every((row) => row.phase === 'needs_attention'));
  assert.ok(failedProgress.every((row) => row.message === 'This destination needs attention before the move can finish.'));
  assert.doesNotMatch(JSON.stringify(failedProgress), /Safe-copy execution stopped/);

  const canceled = progressJob();
  canceled.status = 'canceled';
  canceled.items = [];
  attestJob(canceled);
  assert.ok(dashboardSafeCopyJobProgress(canceled).every((row) => row.phase === 'canceled'));
});

test('terminal detection is explicit and excludes active states', () => {
  for (const status of ['succeeded', 'partial', 'failed', 'canceled'] as const) {
    assert.equal(isDashboardSafeCopyTerminal(status), true);
  }
  assert.equal(isDashboardSafeCopyTerminal('pending'), false);
  assert.equal(isDashboardSafeCopyTerminal('running'), false);
  assert.equal(isDashboardSafeCopyTerminal(undefined), false);
  assert.equal(createDashboardSafeCopyDraft().step, 0);
});
