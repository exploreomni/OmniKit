import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executeDashboardSafeCopy,
  retryDashboardSafeCopyTarget,
  type DashboardSafeCopyAttemptEvidence,
  type DashboardSafeCopyExecutionInput,
  type DashboardSafeCopyExecutionTarget,
  type DashboardSafeCopyExecutorDependencies,
  type DashboardSafeCopyLiveDocument,
  type DashboardSafeCopyPreparedDocument,
  type DashboardSafeCopyReprovedTarget,
  type DashboardSafeCopyTargetState,
  type DashboardSafeCopyVerifiedProvenance,
} from '../server/services/dashboardSafeCopyExecutor';

function executionTarget(targetId = 'target-b'): DashboardSafeCopyExecutionTarget {
  return {
    targetId,
    sourceInstanceId: 'source-instance',
    sourceConnectionId: 'source-connection',
    destinationInstanceId: `destination-${targetId}`,
    connectionId: `connection-${targetId}`,
    modelId: `model-${targetId}`,
    folderId: `folder-${targetId}`,
    folderPath: 'Shared/Safe copies',
    sourceDocumentIds: ['dashboard-1'],
  };
}

function executionInput(targets = [executionTarget()]): DashboardSafeCopyExecutionInput {
  return { jobId: 'safe-copy-job', targets };
}

function reprovedTarget(
  target: DashboardSafeCopyExecutionTarget,
  patch: Partial<DashboardSafeCopyReprovedTarget> = {},
): DashboardSafeCopyReprovedTarget {
  return {
    targetId: target.targetId,
    scope: {
      destinationInstanceId: target.destinationInstanceId,
      connectionId: target.connectionId,
      modelId: target.modelId,
      folderId: target.folderId,
      folderPath: target.folderPath,
      scopeVerified: true,
    },
    semanticChange: { mode: 'none' },
    ...patch,
  };
}

function preparedDocument(sourceDocumentId = 'dashboard-1'): DashboardSafeCopyPreparedDocument {
  return {
    sourceDocumentId,
    documentName: 'Example dashboard',
    sourceExportHash: `source-hash-${sourceDocumentId}`,
    expectedPayloadHash: `payload-hash-${sourceDocumentId}`,
    content: {
      name: 'Example dashboard',
      queryPresentations: {
        data: {
          '1': {
            type: 'query',
            name: 'Example tile',
            query: { fields: ['orders.order_id'] },
            visConfig: { type: 'table' },
          },
        },
        order: ['1'],
      },
      containers: [],
    },
  };
}

function liveDocument(
  target: DashboardSafeCopyExecutionTarget,
  patch: Partial<DashboardSafeCopyLiveDocument> = {},
): DashboardSafeCopyLiveDocument {
  return {
    destinationInstanceId: target.destinationInstanceId,
    connectionId: target.connectionId,
    documentId: 'created-dashboard-1',
    identifier: 'created-dashboard-slug-1',
    name: 'Example dashboard',
    modelId: target.modelId,
    folderId: target.folderId,
    folderPath: target.folderPath,
    fingerprint: 'payload-hash-dashboard-1',
    ...patch,
  };
}

interface Harness {
  dependencies: DashboardSafeCopyExecutorDependencies;
  attempts: DashboardSafeCopyAttemptEvidence[];
  createCalls: Array<{ targetId: string; chosenName: string }>;
  applyCalls: string[];
  reproveCalls: string[];
  provenance: DashboardSafeCopyVerifiedProvenance[];
  setTargetState(targetId: string, state: DashboardSafeCopyTargetState): void;
  setLiveRows(targetId: string, rows: DashboardSafeCopyLiveDocument[]): void;
}

function harness(options: {
  targets?: DashboardSafeCopyExecutionTarget[];
  semanticChange?: DashboardSafeCopyReprovedTarget['semanticChange'];
  createFailure?: unknown;
  classifyWriteFailure?: DashboardSafeCopyExecutorDependencies['classifyWriteFailure'];
} = {}): Harness {
  const targets = options.targets || [executionTarget()];
  const byId = new Map(targets.map((target) => [target.targetId, target]));
  const attempts: DashboardSafeCopyAttemptEvidence[] = [];
  const createCalls: Array<{ targetId: string; chosenName: string }> = [];
  const applyCalls: string[] = [];
  const reproveCalls: string[] = [];
  const provenance: DashboardSafeCopyVerifiedProvenance[] = [];
  const liveRows = new Map(targets.map((target) => [target.targetId, [] as DashboardSafeCopyLiveDocument[]]));
  const targetStates = new Map<string, DashboardSafeCopyTargetState>();
  let nextAttempt = 0;

  const dependencies: DashboardSafeCopyExecutorDependencies = {
    async reproveTarget(target) {
      reproveCalls.push(target.targetId);
      return reprovedTarget(target, {
        semanticChange: options.semanticChange || { mode: 'none' },
      });
    },
    async applySemanticChange(target) {
      applyCalls.push(target.targetId);
    },
    async reconcileSemanticChange() {
      return 'verified';
    },
    async prepareDocument(_target, sourceDocumentId) {
      return preparedDocument(sourceDocumentId);
    },
    async readDestinationScope(target) {
      return {
        complete: true,
        destinationInstanceId: target.scope.destinationInstanceId,
        connectionId: target.scope.connectionId,
        modelId: target.scope.modelId,
        folderId: target.scope.folderId,
        folderPath: target.scope.folderPath,
        documents: [...(liveRows.get(target.targetId) || [])],
      };
    },
    async createDocument(target, document, chosenName) {
      createCalls.push({ targetId: target.targetId, chosenName });
      assert.ok(
        attempts.some((attempt) => (
          attempt.targetId === target.targetId
          && attempt.sourceDocumentId === document.sourceDocumentId
          && attempt.operation === 'document_create'
          && attempt.state === 'dispatched'
        )),
        'the durable dispatched attempt must exist before createDocument is called',
      );
      if (options.createFailure !== undefined) throw options.createFailure;
      const targetInput = byId.get(target.targetId)!;
      const created = liveDocument(targetInput, {
        name: chosenName,
        documentId: `created-${target.targetId}-${document.sourceDocumentId}-${createCalls.length}`,
        identifier: `created-${target.targetId}-${document.sourceDocumentId}-${createCalls.length}-slug`,
        fingerprint: document.expectedPayloadHash,
      });
      liveRows.set(target.targetId, [...(liveRows.get(target.targetId) || []), created]);
      return { documentId: created.documentId, identifier: created.identifier };
    },
    async verifyDocument() {
      return true;
    },
    async persistVerifiedProvenance(record) {
      provenance.push(structuredClone(record));
    },
    async persistAttempt(attempt) {
      attempts.push(structuredClone(attempt));
    },
    async loadTargetState(_jobId, targetId) {
      if (targetStates.has(targetId)) return targetStates.get(targetId)!;
      const latestAttempts = new Map<string, DashboardSafeCopyAttemptEvidence>();
      for (const attempt of attempts) {
        if (attempt.targetId === targetId) latestAttempts.set(attempt.attemptId, attempt);
      }
      return { status: 'needs_attention', attempts: [...latestAttempts.values()] };
    },
    async reconcilePersistedAttempt() {
      return { status: 'uncertain' };
    },
    async claimRetryRequest() {
      return 'claimed';
    },
    classifyWriteFailure: options.classifyWriteFailure,
    randomId() {
      nextAttempt += 1;
      return `attempt-${nextAttempt}`;
    },
    targetDeadlineMs: 1_000,
  };

  return {
    dependencies,
    attempts,
    createCalls,
    applyCalls,
    reproveCalls,
    provenance,
    setTargetState(targetId, state) {
      targetStates.set(targetId, state);
    },
    setLiveRows(targetId, rows) {
      liveRows.set(targetId, rows);
    },
  };
}

test('content-only deployment rejects even a checksum-protected model update', async () => {
  const target = { ...executionTarget(), contentOnly: true as const };
  const state = harness({ targets: [target], semanticChange: {
    mode: 'existing_file_update', fileName: 'orders.view', previousChecksum: 'checksum', expectedYamlHash: 'hash',
  } });
  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.equal(result.targets[0].exceptions[0].code, 'SEMANTIC_CHANGE_UNSAFE');
  assert.equal(state.applyCalls.length, 0);
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.attempts.length, 0);
});

test('folder routes on one destination model serialize their writes', async () => {
  const first = executionTarget('first');
  const second = { ...first, targetId: 'second', folderId: 'second-folder' };
  const state = harness({ targets: [first, second] });
  const create = state.dependencies.createDocument;
  let active = 0;
  let peak = 0;
  state.dependencies.createDocument = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try { return await create(...args); } finally { active -= 1; }
  };
  const result = await executeDashboardSafeCopy(executionInput([first, second]), state.dependencies);
  assert.equal(result.status, 'succeeded');
  assert.equal(state.createCalls.length, 2);
  assert.equal(peak, 1);
});

test('a safe copy persists a content-only create attempt before import and verifies one exact candidate', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  state.dependencies.verifyDocument = async (_reproved, document, candidate) => {
    const verificationEvidence = state.attempts.at(-1);
    assert.ok(verificationEvidence, 'verification must have durable candidate evidence');
    assert.equal(verificationEvidence.state, 'dispatched');
    assert.equal(verificationEvidence.sourceDocumentId, document.sourceDocumentId);
    assert.equal(verificationEvidence.importedDocumentId, candidate.documentId);
    assert.equal(verificationEvidence.importedIdentifier, candidate.identifier);
    assert.equal(verificationEvidence.publishedFingerprint, candidate.fingerprint);
    assert.equal(verificationEvidence.publishedFingerprint, verificationEvidence.expectedPayloadHash);
    assert.ok(Number.isSafeInteger(verificationEvidence.verificationStartedAt));
    assert.ok(verificationEvidence.verificationStartedAt! >= verificationEvidence.createdAt);
    assert.ok(verificationEvidence.verificationStartedAt! <= verificationEvidence.updatedAt);
    return true;
  };
  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.targets[0].documents[0].importedDocumentId, 'created-target-b-dashboard-1-1');
  assert.equal(state.provenance.length, 1);
  assert.equal(state.provenance[0].connectionId, target.connectionId);
  assert.deepEqual(state.attempts.map((attempt) => attempt.state), ['dispatched', 'dispatched', 'verified']);
  assert.equal(state.attempts[0].verificationStartedAt, undefined);
  assert.equal(state.attempts[1].importedDocumentId, result.targets[0].documents[0].importedDocumentId);
  assert.equal(state.attempts[2].verificationStartedAt, state.attempts[1].verificationStartedAt);
  const persisted = JSON.stringify(state.attempts);
  assert.doesNotMatch(persisted, /dashboard\s*:/i);
  assert.doesNotMatch(persisted, /authorization|acceptedYaml|apiKey|password/i);
});

test('same-name unrelated dashboards allocate a deterministic suffix and never become update or Trash authority', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  state.setLiveRows(target.targetId, [
    liveDocument(target, { documentId: 'unrelated-1', identifier: 'unrelated-1', name: 'Example dashboard' }),
    liveDocument(target, { documentId: 'unrelated-2', identifier: 'unrelated-2', name: 'example dashboard (copy)' }),
  ]);

  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.equal(result.status, 'succeeded');
  assert.equal(state.createCalls[0].chosenName, 'Example dashboard (Copy 2)');
  assert.equal(result.targets[0].documents[0].importedDocumentId, 'created-target-b-dashboard-1-1');
});

test('even exact prior safe-copy provenance remains lineage-only and a name collision creates a suffixed copy', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  const first = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.equal(first.status, 'succeeded');
  assert.equal(state.provenance.length, 1);

  const second = await executeDashboardSafeCopy(
    { jobId: 'safe-copy-job-rerun', targets: [target] },
    state.dependencies,
  );
  assert.equal(second.status, 'succeeded');
  assert.deepEqual(state.createCalls.map((call) => call.chosenName), [
    'Example dashboard',
    'Example dashboard (Copy)',
  ]);
  assert.equal(state.provenance.length, 2);
  assert.notEqual(
    second.targets[0].documents[0].importedDocumentId,
    first.targets[0].documents[0].importedDocumentId,
  );
});

test('fresh reproof cannot redirect the immutable destination folder', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  state.dependencies.reproveTarget = async (requested) => reprovedTarget(requested, {
    scope: {
      destinationInstanceId: requested.destinationInstanceId,
      connectionId: requested.connectionId,
      modelId: requested.modelId,
      folderId: 'different-folder',
      folderPath: 'Shared/Other',
      scopeVerified: true,
    },
  });

  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.targets[0].exceptions[0]?.code, 'TARGET_REPROOF_FAILED');
  assert.equal(state.createCalls.length, 0);
});

test('automatic semantic work permits only one checksum-CAS existing-file update', async () => {
  const target = executionTarget();
  const safe = harness({
    targets: [target],
    semanticChange: {
      mode: 'existing_file_update',
      fileName: 'orders.view',
      previousChecksum: 'checksum-1',
      expectedYamlHash: 'yaml-hash-1',
    },
  });
  const safeResult = await executeDashboardSafeCopy(executionInput([target]), safe.dependencies);
  assert.equal(safeResult.status, 'succeeded');
  assert.deepEqual(safe.applyCalls, [target.targetId]);
  assert.equal(safe.attempts[0]?.operation, 'semantic_update');
  assert.equal(safe.attempts[0]?.state, 'dispatched');

  for (const reason of ['new_file', 'multiple_files', 'missing_checksum', 'unsupported'] as const) {
    const unsafe = harness({ targets: [target], semanticChange: { mode: 'unsafe', reason } });
    const result = await executeDashboardSafeCopy(executionInput([target]), unsafe.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.targets[0].exceptions[0]?.code, 'SEMANTIC_CHANGE_UNSAFE');
    assert.equal(unsafe.applyCalls.length, 0);
    assert.equal(unsafe.createCalls.length, 0);
  }
});

test('prepared content containing access-control material is rejected before any destination write', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  state.dependencies.prepareDocument = async () => ({
    ...preparedDocument(),
    content: {
      ...(preparedDocument().content as Record<string, unknown>),
      permissions: [{ principalId: 'group-everyone', access: 'MANAGE' }],
      owner: { id: 'source-owner' },
    },
  });

  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.targets[0].exceptions[0]?.code, 'CONTENT_SECURITY_UNSAFE');
  assert.equal(state.createCalls.length, 0);
});

test('validated content is detached before later awaits so post-validation mutation cannot broaden access', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  const prepared = preparedDocument();
  state.dependencies.prepareDocument = async () => prepared;
  const read = state.dependencies.readDestinationScope;
  state.dependencies.readDestinationScope = async (reproved, options) => {
    (prepared.content as Record<string, unknown>).permissions = [{ access: 'MANAGE' }];
    return read(reproved, options);
  };
  const create = state.dependencies.createDocument;
  state.dependencies.createDocument = async (reproved, document, chosenName, attempt) => {
    assert.equal(Object.hasOwn(document.content as object, 'permissions'), false);
    return create(reproved, document, chosenName, attempt);
  };

  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.equal(result.status, 'succeeded');
  assert.equal(state.createCalls.length, 1);
});

test('one destination persistence failure is contained and cannot block independent destinations', async () => {
  const targets = ['target-b', 'target-c', 'target-d'].map(executionTarget);
  const state = harness({ targets });
  const persist = state.dependencies.persistAttempt;
  state.dependencies.persistAttempt = async (attempt) => {
    if (attempt.targetId === 'target-c') throw new Error('durable store unavailable');
    await persist(attempt);
  };

  const result = await executeDashboardSafeCopy(executionInput(targets), state.dependencies);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.targets.map((target) => [target.targetId, target.status]), [
    ['target-b', 'succeeded'],
    ['target-c', 'needs_attention'],
    ['target-d', 'succeeded'],
  ]);
  assert.deepEqual(state.createCalls.map((call) => call.targetId).sort(), ['target-b', 'target-d']);
});

test('completed destinations persist verified evidence while another destination is still waiting', async () => {
  const targets = ['target-b', 'target-c', 'target-d'].map(executionTarget);
  const state = harness({ targets });
  state.dependencies.targetConcurrency = 2;
  let releaseTargetC!: () => void;
  const targetCGate = new Promise<void>((resolve) => {
    releaseTargetC = resolve;
  });
  let targetDVerified!: () => void;
  const targetDVisible = new Promise<void>((resolve) => {
    targetDVerified = resolve;
  });
  const create = state.dependencies.createDocument;
  state.dependencies.createDocument = async (target, document, chosenName, attempt) => {
    if (target.targetId === 'target-c') await targetCGate;
    return create(target, document, chosenName, attempt);
  };
  const persistAttempt = state.dependencies.persistAttempt;
  state.dependencies.persistAttempt = async (attempt) => {
    await persistAttempt(attempt);
    if (attempt.targetId === 'target-d' && attempt.state === 'verified') targetDVerified();
  };

  let settled = false;
  const execution = executeDashboardSafeCopy(executionInput(targets), state.dependencies)
    .finally(() => {
      settled = true;
    });
  await targetDVisible;

  assert.equal(settled, false, 'target C must still own its delayed operation');
  assert.deepEqual(
    state.provenance.map((record) => record.targetId).sort(),
    ['target-b', 'target-d'],
  );
  for (const targetId of ['target-b', 'target-d']) {
    assert.equal(state.attempts.some((attempt) => (
      attempt.targetId === targetId && attempt.state === 'verified'
    )), true);
  }
  assert.equal(state.attempts.some((attempt) => (
    attempt.targetId === 'target-c' && attempt.state === 'dispatched'
  )), true);

  releaseTargetC();
  const result = await execution;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.targets.map((target) => target.status), ['succeeded', 'succeeded', 'succeeded']);
});

test('successful, certain-failure, and uncertain B/C/D outcomes remain isolated by exact target scope', async () => {
  const targets = ['target-b', 'target-c', 'target-d'].map(executionTarget);
  const state = harness({ targets });
  const create = state.dependencies.createDocument;
  state.dependencies.createDocument = async (target, document, chosenName, attempt) => {
    if (target.targetId === 'target-c') {
      state.createCalls.push({ targetId: target.targetId, chosenName });
      throw new Error('definitely-not-committed');
    }
    if (target.targetId === 'target-d') {
      state.createCalls.push({ targetId: target.targetId, chosenName });
      throw new Error('response-lost-after-dispatch');
    }
    return create(target, document, chosenName, attempt);
  };
  state.dependencies.classifyWriteFailure = (error) => (
    error instanceof Error && error.message === 'definitely-not-committed'
      ? 'definitely_not_committed'
      : 'uncertain'
  );

  const result = await executeDashboardSafeCopy(executionInput(targets), state.dependencies);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.targets.map((target) => [target.targetId, target.status]), [
    ['target-b', 'succeeded'],
    ['target-c', 'needs_attention'],
    ['target-d', 'needs_attention'],
  ]);
  assert.equal(result.targets[1].exceptions[0]?.code, 'IMPORT_FAILED');
  assert.equal(result.targets[1].exceptions[0]?.retryable, true);
  assert.equal(result.targets[2].exceptions[0]?.code, 'IMPORT_UNCERTAIN');
  assert.equal(result.targets[2].exceptions[0]?.retryable, false);
  for (const target of targets) {
    assert.ok(state.attempts.some((attempt) => (
      attempt.targetId === target.targetId
      && attempt.destinationInstanceId === target.destinationInstanceId
      && attempt.connectionId === target.connectionId
      && attempt.modelId === target.modelId
      && attempt.folderId === target.folderId
    )));
  }
});

test('the per-target deadline covers fresh reproof and fails closed before any write', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  state.dependencies.targetDeadlineMs = 1_000;
  state.dependencies.reproveTarget = async (requested) => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return reprovedTarget(requested);
  };

  const startedAt = Date.now();
  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  assert.ok(Date.now() - startedAt < 1_080, 'reproof must be bounded by the target deadline');
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.targets[0].exceptions[0]?.code, 'TARGET_DEADLINE_EXCEEDED');
  assert.equal(state.createCalls.length, 0);
});

test('a certain pre-write import failure is retryable, while an uncertain attempt never dispatches a duplicate', async () => {
  const target = executionTarget();
  const certain = harness({
    targets: [target],
    createFailure: new Error('request rejected before write'),
    classifyWriteFailure: () => 'definitely_not_committed',
  });
  const first = await executeDashboardSafeCopy(executionInput([target]), certain.dependencies);
  assert.equal(first.targets[0].exceptions[0]?.code, 'IMPORT_FAILED');
  assert.equal(first.targets[0].exceptions[0]?.retryable, true);
  assert.equal(certain.attempts.at(-1)?.state, 'failed_prewrite');

  certain.dependencies.createDocument = async (reproved, document, chosenName) => {
    certain.createCalls.push({ targetId: reproved.targetId, chosenName });
    const created = liveDocument(target, {
      name: chosenName,
      documentId: 'retry-created',
      identifier: 'retry-created-slug',
      fingerprint: document.expectedPayloadHash,
    });
    certain.setLiveRows(target.targetId, [created]);
    return { documentId: created.documentId, identifier: created.identifier };
  };
  const retry = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '11111111-1111-4111-8111-111111111111',
    certain.dependencies,
  );
  assert.equal(retry.status, 'succeeded');
  assert.equal(certain.createCalls.length, 2);

  const uncertain = harness({
    targets: [target],
    createFailure: new Error('socket closed after request dispatch'),
    classifyWriteFailure: () => 'uncertain',
  });
  const uncertainFirst = await executeDashboardSafeCopy(executionInput([target]), uncertain.dependencies);
  assert.equal(uncertainFirst.targets[0].exceptions[0]?.code, 'IMPORT_UNCERTAIN');
  assert.equal(uncertain.createCalls.length, 1);
  const uncertainRetry = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '22222222-2222-4222-8222-222222222222',
    uncertain.dependencies,
  );
  assert.equal(uncertainRetry.exceptions[0]?.code, 'IMPORT_UNCERTAIN');
  assert.equal(uncertain.createCalls.length, 1);
});

test('uncertain imports reconcile only to one exact new candidate; ambiguous and mismatched candidates fail closed', async () => {
  const target = executionTarget();
  const exact = harness({
    targets: [target],
    createFailure: new Error('response lost'),
    classifyWriteFailure: () => 'uncertain',
  });
  let reads = 0;
  exact.dependencies.readDestinationScope = async () => {
    reads += 1;
    return {
      complete: true,
      destinationInstanceId: target.destinationInstanceId,
      connectionId: target.connectionId,
      modelId: target.modelId,
      folderId: target.folderId,
      folderPath: target.folderPath,
      documents: reads === 1 ? [] : [liveDocument(target)],
    };
  };
  const exactResult = await executeDashboardSafeCopy(executionInput([target]), exact.dependencies);
  assert.equal(exactResult.status, 'succeeded');
  assert.deepEqual(exact.attempts.map((attempt) => attempt.state), ['dispatched', 'uncertain', 'uncertain', 'verified']);
  const verificationEvidence = exact.attempts.at(-2)!;
  assert.equal(verificationEvidence.importedDocumentId, 'created-dashboard-1');
  assert.equal(verificationEvidence.importedIdentifier, 'created-dashboard-slug-1');
  assert.equal(verificationEvidence.publishedFingerprint, verificationEvidence.expectedPayloadHash);
  assert.ok(Number.isSafeInteger(verificationEvidence.verificationStartedAt));

  const cases: Array<[string, DashboardSafeCopyLiveDocument[]]> = [
    ['ambiguous', [liveDocument(target), liveDocument(target, { documentId: 'created-dashboard-2', identifier: 'created-dashboard-2' })]],
    ['wrong model', [liveDocument(target, { modelId: 'wrong-model' })]],
    ['wrong folder', [liveDocument(target, { folderId: 'wrong-folder' })]],
    ['wrong fingerprint', [liveDocument(target, { fingerprint: 'wrong-hash' })]],
  ];
  for (const [label, candidates] of cases) {
    const state = harness({
      targets: [target],
      createFailure: new Error('response lost'),
      classifyWriteFailure: () => 'uncertain',
    });
    let call = 0;
    state.dependencies.readDestinationScope = async () => {
      call += 1;
      return {
        complete: true,
        destinationInstanceId: target.destinationInstanceId,
        connectionId: target.connectionId,
        modelId: target.modelId,
        folderId: target.folderId,
        folderPath: target.folderPath,
        documents: call === 1 ? [] : candidates,
      };
    };
    const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
    assert.equal(result.targets[0].exceptions[0]?.code, 'IMPORT_UNCERTAIN', label);
  }
});

test('successful targets and verified semantic attempts are excluded from target retry', async () => {
  const target = executionTarget();
  const complete = harness({ targets: [target] });
  complete.setTargetState(target.targetId, { status: 'succeeded', attempts: [] });
  const completeResult = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '33333333-3333-4333-8333-333333333333',
    complete.dependencies,
  );
  assert.equal(completeResult.exceptions[0]?.code, 'TARGET_ALREADY_COMPLETE');
  assert.equal(complete.reproveCalls.length, 0);
  assert.equal(complete.createCalls.length, 0);

  const semantic = harness({
    targets: [target],
    semanticChange: {
      mode: 'existing_file_update',
      fileName: 'orders.view',
      previousChecksum: 'checksum-1',
      expectedYamlHash: 'yaml-hash-1',
    },
  });
  semantic.setTargetState(target.targetId, {
    status: 'needs_attention',
    attempts: [{
      attemptId: 'verified-semantic-attempt',
      jobId: 'safe-copy-job',
      targetId: target.targetId,
      operation: 'semantic_update',
      state: 'verified',
      destinationInstanceId: target.destinationInstanceId,
      connectionId: target.connectionId,
      modelId: target.modelId,
      folderId: target.folderId,
      folderPath: target.folderPath,
      fileName: 'orders.view',
      previousChecksum: 'checksum-1',
      expectedYamlHash: 'yaml-hash-1',
      createdAt: 1,
      updatedAt: 2,
    }],
  });
  const retry = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '44444444-4444-4444-8444-444444444444',
    semantic.dependencies,
  );
  assert.equal(retry.status, 'succeeded');
  assert.equal(semantic.applyCalls.length, 0, 'verified semantic work must not be dispatched again');
});

test('retry reconciles one exact persisted candidate without creating again and rejects mismatched evidence', async () => {
  const target = executionTarget();
  const exact = harness({ targets: [target] });
  const priorAttempt: DashboardSafeCopyAttemptEvidence = {
    attemptId: 'prior-create-attempt',
    jobId: 'safe-copy-job',
    targetId: target.targetId,
    operation: 'document_create',
    state: 'uncertain',
    destinationInstanceId: target.destinationInstanceId,
    connectionId: target.connectionId,
    modelId: target.modelId,
    folderId: target.folderId,
    folderPath: target.folderPath,
    sourceDocumentId: 'dashboard-1',
    chosenName: 'Example dashboard',
    sourceExportHash: 'source-hash-dashboard-1',
    expectedPayloadHash: 'payload-hash-dashboard-1',
    preexistingDocumentIds: [],
    createdAt: 1,
    updatedAt: 2,
  };
  exact.setTargetState(target.targetId, { status: 'needs_attention', attempts: [priorAttempt] });
  const reconciliationOrder: string[] = [];
  const persistAttempt = exact.dependencies.persistAttempt;
  exact.dependencies.persistAttempt = async (attempt) => {
    if (attempt.verificationStartedAt !== undefined && attempt.state !== 'verified') {
      reconciliationOrder.push('candidate');
    } else if (attempt.state === 'verified') {
      reconciliationOrder.push('verified');
    }
    await persistAttempt(attempt);
  };
  const persistVerifiedProvenance = exact.dependencies.persistVerifiedProvenance;
  exact.dependencies.persistVerifiedProvenance = async (provenance) => {
    reconciliationOrder.push('provenance');
    await persistVerifiedProvenance(provenance);
  };
  exact.dependencies.verifyDocument = async (_reproved, prepared, candidate) => {
    reconciliationOrder.push('verify');
    const marker = exact.attempts.at(-1);
    assert.equal(marker?.state, 'uncertain');
    assert.equal(marker?.sourceDocumentId, prepared.sourceDocumentId);
    assert.equal(marker?.importedDocumentId, candidate.documentId);
    assert.equal(marker?.importedIdentifier, candidate.identifier);
    assert.equal(marker?.publishedFingerprint, candidate.fingerprint);
    assert.ok(Number.isSafeInteger(marker?.verificationStartedAt));
    assert.equal(exact.provenance.length, 0);
    return true;
  };
  exact.dependencies.reconcilePersistedAttempt = async () => ({
    status: 'candidate',
    liveDocument: liveDocument(target),
    preparedDocument: preparedDocument(),
  });
  const reconciled = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '55555555-5555-4555-8555-555555555555',
    exact.dependencies,
  );
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(exact.createCalls.length, 0);
  assert.equal(exact.provenance.length, 1);
  assert.equal(exact.provenance[0].verifierVersion, 1);
  assert.equal(exact.attempts.at(-1)?.state, 'verified');
  assert.deepEqual(reconciliationOrder, ['candidate', 'verify', 'provenance', 'verified']);

  const mismatch = harness({ targets: [target] });
  mismatch.setTargetState(target.targetId, { status: 'needs_attention', attempts: [priorAttempt] });
  mismatch.dependencies.reconcilePersistedAttempt = async () => ({
    status: 'candidate',
    liveDocument: liveDocument(target, { connectionId: 'wrong-connection' }),
    preparedDocument: preparedDocument(),
  });
  const rejected = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '66666666-6666-4666-8666-666666666666',
    mismatch.dependencies,
  );
  assert.equal(rejected.exceptions[0]?.code, 'IMPORT_UNCERTAIN');
  assert.equal(mismatch.createCalls.length, 0);
  assert.equal(mismatch.provenance.length, 0);
});

test('a persisted verified attempt with a mismatched published fingerprint is never skipped as successful', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  state.setTargetState(target.targetId, {
    status: 'needs_attention',
    attempts: [{
      attemptId: 'corrupt-verified-attempt',
      jobId: 'safe-copy-job',
      targetId: target.targetId,
      operation: 'document_create',
      state: 'verified',
      destinationInstanceId: target.destinationInstanceId,
      connectionId: target.connectionId,
      modelId: target.modelId,
      folderId: target.folderId,
      folderPath: target.folderPath,
      sourceDocumentId: 'dashboard-1',
      chosenName: 'Example dashboard',
      sourceExportHash: 'source-hash-dashboard-1',
      expectedPayloadHash: 'payload-hash-dashboard-1',
      importedDocumentId: 'created-dashboard-1',
      importedIdentifier: 'created-dashboard-1-slug',
      publishedFingerprint: 'different-payload-hash',
      verifierVersion: 2,
      verifiedAt: 3,
      createdAt: 1,
      updatedAt: 3,
    }],
  });

  const result = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '88888888-8888-4888-8888-888888888888',
    state.dependencies,
  );
  assert.equal(result.exceptions[0]?.code, 'IMPORT_UNCERTAIN');
  assert.equal(state.createCalls.length, 0);
});

test('same-tenant verified retry evidence cannot identify the source dashboard as its own copied artifact', async () => {
  const target = {
    ...executionTarget(),
    destinationInstanceId: 'source-instance',
  };
  const state = harness({ targets: [target] });
  state.setTargetState(target.targetId, {
    status: 'needs_attention',
    attempts: [{
      attemptId: 'source-self-reference',
      jobId: 'safe-copy-job',
      targetId: target.targetId,
      operation: 'document_create',
      state: 'verified',
      destinationInstanceId: target.destinationInstanceId,
      connectionId: target.connectionId,
      modelId: target.modelId,
      folderId: target.folderId,
      folderPath: target.folderPath,
      sourceDocumentId: 'dashboard-1',
      chosenName: 'Example dashboard',
      sourceExportHash: 'source-hash-dashboard-1',
      expectedPayloadHash: 'payload-hash-dashboard-1',
      importedDocumentId: 'dashboard-1',
      importedIdentifier: 'source-dashboard-slug',
      publishedFingerprint: 'payload-hash-dashboard-1',
      verifierVersion: 2,
      verifiedAt: 3,
      createdAt: 1,
      updatedAt: 3,
    }],
  });

  const result = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '99999999-9999-4999-8999-999999999999',
    state.dependencies,
  );
  assert.equal(result.exceptions[0]?.code, 'IMPORT_UNCERTAIN');
  assert.equal(state.createCalls.length, 0);
});

test('retry request IDs are claimed before target state is read and duplicate claims never dispatch', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  let stateReads = 0;
  state.dependencies.claimRetryRequest = async () => 'duplicate';
  state.dependencies.loadTargetState = async () => {
    stateReads += 1;
    return { status: 'needs_attention', attempts: [] };
  };
  const result = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '77777777-7777-4777-8777-777777777777',
    state.dependencies,
  );
  assert.equal(result.exceptions[0]?.code, 'RETRY_REQUEST_DUPLICATE');
  assert.equal(stateReads, 0);
  assert.equal(state.reproveCalls.length, 0);
  assert.equal(state.createCalls.length, 0);
});

test('conflicting retry claims are typed and never read or dispatch target state', async () => {
  const target = executionTarget();
  const state = harness({ targets: [target] });
  let stateReads = 0;
  state.dependencies.claimRetryRequest = async () => 'conflict';
  state.dependencies.loadTargetState = async () => {
    stateReads += 1;
    return { status: 'needs_attention', attempts: [] };
  };
  const result = await retryDashboardSafeCopyTarget(
    executionInput([target]),
    target.targetId,
    '77777777-7777-4777-8777-777777777777',
    state.dependencies,
  );
  assert.equal(result.exceptions[0]?.code, 'RETRY_REQUEST_CONFLICT');
  assert.equal(stateReads, 0);
  assert.equal(state.reproveCalls.length, 0);
  assert.equal(state.createCalls.length, 0);
});

test('raw dependency errors and in-memory content never leak into persisted attempt evidence', async () => {
  const target = executionTarget();
  const state = harness({
    targets: [target],
    createFailure: new Error('api_key: omni_super_secret\nviews:\n  confidential: true'),
    classifyWriteFailure: () => 'definitely_not_committed',
  });
  const result = await executeDashboardSafeCopy(executionInput([target]), state.dependencies);
  const serialized = JSON.stringify({ attempts: state.attempts, result });
  assert.doesNotMatch(serialized, /omni_super_secret|confidential: true|views:/);
  assert.match(serialized, /IMPORT_FAILED/);
});
