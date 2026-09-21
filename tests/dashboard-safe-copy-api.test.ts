import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';

import { migrationJobsHandler } from '../server/handlers/migration-jobs';
import {
  cancelDashboardSafeCopyJob,
  createDashboardSafeCopyJob,
  dashboardSafeCopyIntentHash,
  resumePendingDashboardSafeCopyJobs,
} from '../server/services/dashboardSafeCopyJobs';
import { prepareDashboardSafeCopyJob } from '../server/services/dashboardSafeCopyPreparation';
import { runDashboardSafeCopyJob } from '../server/services/dashboardSafeCopyRuntime';
import {
  closeJobStoreForTests,
  getJob,
  insertJob,
  updateJobStatus,
} from '../server/services/jobStore';
import type {
  DashboardMigrationJobInput,
  MigrationJob,
  MigrationPlan,
} from '../server/services/migrationJobs';
import { retryMigrationJob, runMigrationJob } from '../server/services/migrationJobs';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import {
  OmniClient,
  resetOmniClientRateLimitStateForTests,
} from '../server/services/omniClient';
import { parseDashboardSafeCopyIntent } from '../shared/dashboardSafeCopyContract';

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
let temporaryRoot = '';

function saveInstance(id: string): void {
  upsertInstance({
    id,
    label: `Example ${id}`,
    role: 'both',
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey: `${id}-credential`,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

function intent(requestId = REQUEST_ID) {
  return {
    profile: 'safe_copy_v1',
    requestId,
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: ['dashboard-1'],
    },
    destinations: [{
      targetId: 'target-1',
      instanceId: 'destination-instance',
      connectionId: 'destination-connection',
      modelId: 'destination-model',
      folderPath: 'Shared/Migrated',
    }],
  };
}

function threeDestinationIntent(requestId: string) {
  for (const instanceId of ['destination-b', 'destination-c', 'destination-d']) saveInstance(instanceId);
  const raw = intent(requestId);
  raw.destinations = ['b', 'c', 'd'].map((suffix) => ({
    targetId: `target-${suffix}`,
    instanceId: `destination-${suffix}`,
    connectionId: `connection-${suffix}`,
    modelId: `model-${suffix}`,
    folderPath: 'Shared/Migrated',
  }));
  return parseDashboardSafeCopyIntent(raw);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function preparationSummaryTargetIds(job: MigrationJob): string[] {
  return job.items.flatMap((item) => (
    item.details?.safeCopyPreparationSummary === true && item.targetId ? [item.targetId] : []
  )).sort();
}

function durableJob(jobId: string): MigrationJob | undefined {
  const raw = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8')) as unknown;
  const jobs = Array.isArray(raw) ? raw as MigrationJob[] : [];
  return jobs.find((job) => job.id === jobId);
}

function resolvedPlan(input: DashboardMigrationJobInput): MigrationPlan {
  const target = input.targets![0];
  return {
    sourceId: input.sourceId,
    sourceLabel: 'Source',
    sourceConnectionId: input.sourceConnectionId,
    destinationIds: [target.destinationInstanceId],
    targets: [target],
    documentIds: input.documentIds,
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    sourceAllFolders: true,
    steps: ([
      'export',
      'semantic_validate',
      'query_validate',
      'import',
      'metadata',
      'document_verify',
    ] as const).map((kind) => ({
      targetId: target.id,
      destinationId: target.destinationInstanceId,
      destinationLabel: target.destinationLabel || target.destinationInstanceId,
      targetConnectionId: target.targetConnectionId,
      targetModelId: target.targetModelId,
      targetFolderPath: target.targetFolderPath,
      kind,
      documentId: input.documentIds[0],
      documentName: 'Dashboard 1',
    })),
  };
}

async function waitForJob(
  jobId: string,
  predicate: (job: MigrationJob) => boolean,
): Promise<MigrationJob> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const job = getJob(jobId);
    if (job && predicate(job)) return job;
  }
  assert.fail(`Timed out waiting for safe-copy job ${jobId}.`);
}

async function postSafeCopy(body: unknown): Promise<Response> {
  return migrationJobsHandler(new Request('http://localhost/api/migration-jobs/safe-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { safeCopyPreparation: null });
}

function completePagination(count: number) {
  return {
    complete: true as const,
    pages: 1,
    pageSize: 100,
    returnedRecords: count,
    reportedTotalRecords: count,
  };
}

function blankDashboardState(name: string, workbookModelId: string): Record<string, unknown> {
  return {
    name,
    description: `${name} content-only copy.`,
    modelId: 'source-model',
    workbookModelId,
    queryPresentations: {
      data: {
        '1': {
          type: 'blank',
          name: 'Context',
          visConfig: { type: 'text', text: 'No query required.' },
        },
      },
      order: ['1'],
    },
    controls: [],
    settings: { interactionMode: 'cross-filter' },
    containers: [{ type: 'grid', queryPresentationKeys: ['1'] }],
  };
}

interface ProductionSafeCopyHarness {
  createCalls: Array<{
    destinationInstanceId: string;
    documentId: string;
    identifier: string;
    modelId: string;
    name: string;
  }>;
  queryCalls: number;
}

function installProductionSafeCopyOmniHarness(
  t: TestContext,
  input: {
    sourceDocumentIds: string[];
    destinations: Array<{
      instanceId: string;
      connectionId: string;
      modelId: string;
      folderId: string;
      folderPath: string;
    }>;
  },
): ProductionSafeCopyHarness {
  const sourceStates = new Map(input.sourceDocumentIds.map((documentId, index) => [
    documentId,
    blankDashboardState(`Dashboard ${index + 1}`, `${documentId}-workbook-model`),
  ]));
  const createdStates = new Map<string, Record<string, unknown>>();
  const createdRows = new Map<string, Array<{
    id: string;
    identifier: string;
    name: string;
    connectionId: string;
    baseModelId: string;
    folderId: string;
    folderPath: string;
    hasDashboard: true;
  }>>();
  const harness: ProductionSafeCopyHarness = { createCalls: [], queryCalls: 0 };
  const instanceId = (client: OmniClient): string => (
    (client as unknown as { instance: { id: string } }).instance.id
  );
  const destinationFor = (id: string) => input.destinations.find((destination) => destination.instanceId === id);

  t.mock.method(OmniClient.prototype, 'listFolderInventory', async function listFolderInventory() {
    const destination = destinationFor(instanceId(this));
    const folders = destination ? [{
      id: destination.folderId,
      name: destination.folderPath.split('/').at(-1) || destination.folderPath,
      identifier: destination.folderPath,
      path: destination.folderPath,
    }] : [];
    return { folders, pagination: completePagination(folders.length) };
  });
  t.mock.method(OmniClient.prototype, 'listDocumentInventory', async function listDocumentInventory() {
    const documents = createdRows.get(instanceId(this)) || [];
    return { documents, pagination: completePagination(documents.length) };
  });
  t.mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (instanceId(this) === 'source-instance') {
      return input.sourceDocumentIds.map((documentId, index) => ({
        id: documentId,
        identifier: documentId,
        name: `Dashboard ${index + 1}`,
        connectionId: 'source-connection',
        baseModelId: 'source-model',
        folderPath: 'Source',
        hasDashboard: true,
      }));
    }
    return createdRows.get(instanceId(this)) || [];
  });
  t.mock.method(OmniClient.prototype, 'listModels', async function listModels() {
    if (instanceId(this) === 'source-instance') {
      return [{ id: 'source-model', name: 'Source model', connectionId: 'source-connection' }];
    }
    const destination = destinationFor(instanceId(this));
    return destination
      ? [{ id: destination.modelId, name: destination.modelId, connectionId: destination.connectionId }]
      : [];
  });
  t.mock.method(OmniClient.prototype, 'getDocumentStateV2', async function getDocumentStateV2(documentId: string) {
    const state = sourceStates.get(documentId) || createdStates.get(documentId);
    if (!state) throw new Error(`Unknown fictional document ${documentId}.`);
    return structuredClone(state);
  });
  t.mock.method(OmniClient.prototype, 'exportDocument', async function exportDocument(documentId: string) {
    const state = sourceStates.get(documentId);
    if (!state) throw new Error(`Unknown fictional source document ${documentId}.`);
    return structuredClone(state);
  });
  t.mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  t.mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options?: {
    mode?: string;
    fullyResolved?: boolean;
    includeChecksums?: boolean;
  }) {
    if (instanceId(this) === 'source-instance' && options?.mode === 'extension') {
      assert.ok(input.sourceDocumentIds.some((documentId) => modelId === `${documentId}-workbook-model`));
      assert.equal(options.fullyResolved, false);
      assert.equal(options.includeChecksums, true);
    }
    // These content-only fixtures have a verified empty workbook extension, not missing identity/evidence.
    return { files: {}, checksums: {}, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'listModelTopics', async () => []);
  t.mock.method(OmniClient.prototype, 'listModelQueryViews', async () => []);
  t.mock.method(OmniClient.prototype, 'listLabels', async () => []);
  t.mock.method(OmniClient.prototype, 'listDocumentAccess', async () => []);
  t.mock.method(OmniClient.prototype, 'listDocumentAccessInventory', async () => ({
    principals: [],
    pagination: completePagination(0),
  }));
  t.mock.method(OmniClient.prototype, 'listIdentityUsers', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserGroups', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserAttributes', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserModelRoles', async () => []);
  t.mock.method(OmniClient.prototype, 'runQuery', async () => {
    harness.queryCalls += 1;
    return { status: 'COMPLETE', rowCount: 0 };
  });
  t.mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    throw new Error('A content-only safe copy must not write model YAML.');
  });
  t.mock.method(OmniClient.prototype, 'createDashboardSafeCopyDocument', async function createDashboardSafeCopyDocument(
    createInput: { modelId: string; name: string; folderId?: string; content: Record<string, unknown> },
  ) {
    const destinationInstanceId = instanceId(this);
    const destination = destinationFor(destinationInstanceId);
    if (!destination) throw new Error('Safe-copy create was sent to an unknown fictional destination.');
    const ordinal = harness.createCalls.length + 1;
    const documentId = `verified-copy-${ordinal}`;
    const identifier = `verified-copy-${ordinal}`;
    const state = {
      modelId: createInput.modelId,
      ...structuredClone(createInput.content),
      name: createInput.name,
    };
    createdStates.set(documentId, state);
    const row = {
      id: documentId,
      identifier,
      name: createInput.name,
      connectionId: destination.connectionId,
      baseModelId: createInput.modelId,
      folderId: destination.folderId,
      folderPath: destination.folderPath,
      hasDashboard: true as const,
    };
    createdRows.set(destinationInstanceId, [...(createdRows.get(destinationInstanceId) || []), row]);
    harness.createCalls.push({
      destinationInstanceId,
      documentId,
      identifier,
      modelId: createInput.modelId,
      name: createInput.name,
    });
    return { id: documentId, identifier, raw: {} };
  });
  return harness;
}

async function waitForTerminalSafeCopyJob(jobId: string): Promise<MigrationJob> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = getJob(jobId);
    if (job && ['succeeded', 'partial', 'failed'].includes(job.status)) return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for production-default safe-copy job ${jobId}.`);
}

beforeEach(() => {
  resetOmniClientRateLimitStateForTests();
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-safe-copy-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;
  delete process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL;
  closeJobStoreForTests();
  unlockVault('safe copy test passphrase');
  saveInstance('source-instance');
  saveInstance('destination-instance');
});

afterEach(() => {
  resetOmniClientRateLimitStateForTests();
  closeJobStoreForTests();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;
  delete process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL;
});

test('safe-copy service persists a zero-write skeleton before preparation starts', async () => {
  const parsed = parseDashboardSafeCopyIntent(intent());
  let persistedInsidePreparation = false;
  const result = createDashboardSafeCopyJob(parsed, {
    prepare(jobId) {
      const persisted = getJob(jobId);
      assert.ok(persisted);
      persistedInsidePreparation = true;
      assert.equal(persisted.status, 'pending');
      assert.equal(persisted.emptyFirst, false);
      assert.equal(persisted.replaceSameNamed, false);
      assert.equal(persisted.deleteSourceOnSuccess, false);
      assert.deepEqual(persisted.postMigrationActions, []);
      assert.deepEqual(persisted.items, []);
      assert.equal(persisted.details?.safeCopyPreparationState, 'queued');
    },
  });
  assert.equal(result.replayed, false);
  assert.equal(result.resumed, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(persistedInsidePreparation, true);

  const disk = readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8');
  assert.doesNotMatch(disk, /credential|apiKey|semanticPatches|acceptedYaml|sourceYaml/);
  assert.match(disk, /safe_copy_v1/);
});

test('safe-copy service contains synchronous preparation failures in the persisted job', async () => {
  const parsed = parseDashboardSafeCopyIntent(intent('33333333-3333-4333-8333-333333333333'));
  const result = createDashboardSafeCopyJob(parsed, {
    prepare() {
      throw new Error('api_key: should-not-reach-history\nviews:\n  secret: true');
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const persisted = getJob(result.job.id);
  assert.ok(persisted);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.details?.safeCopyPreparationState, 'failed');
  assert.equal(persisted.details?.safeCopyPreparationErrorCode, 'SAFE_COPY_PREPARATION_FAILED');
  assert.equal(persisted.details?.safeCopyPreparationError, 'Safe-copy preparation could not be completed.');
  const disk = readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8');
  assert.doesNotMatch(disk, /should-not-reach-history|secret: true/);
});

test('safe-copy preparation persists only target readiness and typed exceptions', async () => {
  saveInstance('destination-c');
  saveInstance('destination-d');
  const raw = intent('77777777-7777-4777-8777-777777777777');
  raw.destinations = [
    raw.destinations[0],
    {
      targetId: 'target-c',
      instanceId: 'destination-c',
      connectionId: 'connection-c',
      modelId: 'model-c',
      folderPath: 'Shared/Migrated',
    },
    {
      targetId: 'target-d',
      instanceId: 'destination-d',
      connectionId: 'connection-d',
      modelId: 'model-d',
      folderPath: 'Shared/Migrated',
    },
  ];
  const parsed = parseDashboardSafeCopyIntent(raw);
  const result = createDashboardSafeCopyJob(parsed, {
    prepare(jobId, safeIntent) {
      return prepareDashboardSafeCopyJob(jobId, safeIntent, {
        async buildPlan(input): Promise<MigrationPlan> {
          const target = input.targets![0];
          return {
            sourceId: input.sourceId,
            sourceLabel: 'Source',
            sourceConnectionId: input.sourceConnectionId,
            destinationIds: [target.destinationInstanceId],
            targets: [target],
            documentIds: input.documentIds,
            emptyFirst: false,
            replaceSameNamed: false,
            deleteSourceOnSuccess: false,
            sourceAllFolders: true,
            steps: ([
              'export',
              'semantic_validate',
              'query_validate',
              'import',
              'metadata',
              'document_verify',
            ] as const).map((kind) => ({
              targetId: target.id,
              destinationId: target.destinationInstanceId,
              destinationLabel: target.destinationLabel || target.destinationInstanceId,
              targetConnectionId: target.targetConnectionId,
              targetModelId: target.targetModelId,
              targetFolderPath: target.targetFolderPath,
              kind,
              documentId: 'dashboard-1',
              documentName: 'Dashboard 1',
            })),
          };
        },
        resolveTarget(_plan, target) {
          if (target.id !== 'target-c') return { status: 'resolved', target };
          return {
            status: 'exception',
            targetId: target.id,
            exceptions: [{
              targetId: target.id,
              code: 'AMBIGUOUS_MAPPING',
              artifact: 'field',
              reference: 'orders.amount',
              message: 'More than one strong field match is available.',
            }],
          };
        },
      });
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prepared = getJob(result.job.id);
  assert.ok(prepared);
  assert.equal(prepared.status, 'pending');
  assert.equal(prepared.details?.safeCopyPreparationState, 'needs_attention');
  assert.equal(prepared.details?.safeCopyReadyTargetCount, 2);
  assert.equal(prepared.details?.safeCopyExceptionTargetCount, 1);
  assert.deepEqual(prepared.items.map((item) => [item.targetId, item.status]), [
    ['target-1', 'succeeded'],
    ['target-c', 'failed'],
    ['target-d', 'succeeded'],
  ]);
  const disk = readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8');
  assert.doesNotMatch(disk, /acceptedYaml|recommendedYaml|sourceYaml|currentYaml/);
  assert.match(disk, /AMBIGUOUS_MAPPING/);

  closeJobStoreForTests();
  const restored = getJob(result.job.id);
  assert.ok(restored);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.details?.safeCopyPreparationState, 'needs_attention');
  assert.deepEqual(restored.items.map((item) => [item.targetId, item.status]), [
    ['target-1', 'succeeded'],
    ['target-c', 'failed'],
    ['target-d', 'succeeded'],
  ]);
});

test('B and D preparation summaries are durably visible while C is still resolving', async () => {
  const parsed = threeDestinationIntent('61616161-6161-4161-8161-616161616161');
  const created = createDashboardSafeCopyJob(parsed, { prepare() {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cGate = deferred();

  const preparation = prepareDashboardSafeCopyJob(created.job.id, parsed, {
    async buildPlan(input) {
      if (input.targets?.[0]?.id === 'target-c') await cGate.promise;
      return resolvedPlan(input);
    },
    resolveTarget(_plan, target) {
      return { status: 'resolved', target };
    },
  });

  try {
    const incremental = await waitForJob(created.job.id, (job) => (
      preparationSummaryTargetIds(job).join(',') === 'target-b,target-d'
    ));
    assert.equal(incremental.status, 'pending');
    assert.equal(incremental.details?.safeCopyPreparationState, 'resolving');
    assert.equal(incremental.details?.safeCopyReadyTargetCount, 2);
    assert.equal(incremental.details?.safeCopyExceptionTargetCount, 0);
    assert.deepEqual(preparationSummaryTargetIds(incremental), ['target-b', 'target-d']);
    assert.deepEqual(preparationSummaryTargetIds(durableJob(created.job.id)!), ['target-b', 'target-d']);
  } finally {
    cGate.resolve();
    await preparation;
  }

  const completed = getJob(created.job.id)!;
  assert.equal(completed.details?.safeCopyPreparationState, 'prepared');
  assert.deepEqual(preparationSummaryTargetIds(completed), ['target-b', 'target-c', 'target-d']);
});

test('restart after exact B preparation resumes only missing C and D without rebuilding B', async () => {
  const parsed = threeDestinationIntent('62626262-6262-4262-8262-626262626262');
  const created = createDashboardSafeCopyJob(parsed, { prepare() {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cGate = deferred();
  const dGate = deferred();
  const initialBuildTargetIds: string[] = [];

  const interruptedPreparation = prepareDashboardSafeCopyJob(created.job.id, parsed, {
    async buildPlan(input) {
      const targetId = input.targets![0].id;
      initialBuildTargetIds.push(targetId);
      if (targetId === 'target-c') await cGate.promise;
      if (targetId === 'target-d') await dGate.promise;
      return resolvedPlan(input);
    },
    resolveTarget(_plan, target) {
      return { status: 'resolved', target };
    },
  });

  await waitForJob(created.job.id, (job) => (
    preparationSummaryTargetIds(job).join(',') === 'target-b'
  ));
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const blockedNow = 1_760_000_000_002;
  const blockedTempPath = `${historyPath}.${process.pid}.${blockedNow}.tmp`;
  const realDateNow = Date.now;
  mkdirSync(blockedTempPath);
  Date.now = () => blockedNow;
  try {
    cGate.resolve();
    dGate.resolve();
    await assert.rejects(interruptedPreparation);
  } finally {
    Date.now = realDateNow;
    rmSync(blockedTempPath, { recursive: true, force: true });
  }

  assert.deepEqual(preparationSummaryTargetIds(getJob(created.job.id)!), ['target-b']);
  closeJobStoreForTests();
  const recovered = getJob(created.job.id)!;
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.details?.safeCopyPreparationState, 'resolving');
  assert.deepEqual(preparationSummaryTargetIds(recovered), ['target-b']);

  const resumedBuildTargetIds: string[] = [];
  let finishResume!: () => void;
  const resumeFinished = new Promise<void>((resolve) => {
    finishResume = resolve;
  });
  const resumed = resumePendingDashboardSafeCopyJobs(async (jobId, safeIntent) => {
    try {
      await prepareDashboardSafeCopyJob(jobId, safeIntent, {
        async buildPlan(input) {
          resumedBuildTargetIds.push(input.targets![0].id);
          return resolvedPlan(input);
        },
        resolveTarget(_plan, target) {
          return { status: 'resolved', target };
        },
      });
    } finally {
      finishResume();
    }
  });

  assert.deepEqual(resumed, [created.job.id]);
  await resumeFinished;
  assert.ok(initialBuildTargetIds.includes('target-b'));
  assert.deepEqual(resumedBuildTargetIds.sort(), ['target-c', 'target-d']);
  const completed = getJob(created.job.id)!;
  assert.equal(completed.details?.safeCopyPreparationState, 'prepared');
  assert.deepEqual(preparationSummaryTargetIds(completed), ['target-b', 'target-c', 'target-d']);
});

test('one preparation-summary store failure is retried without suppressing independent targets', async () => {
  const parsed = threeDestinationIntent('63636363-6363-4363-8363-636363636363');
  const created = createDashboardSafeCopyJob(parsed, { prepare() {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const bGate = deferred();
  const cGate = deferred();
  const dGate = deferred();
  const bResolved = deferred();
  const buildCounts = new Map<string, number>();

  const preparation = prepareDashboardSafeCopyJob(created.job.id, parsed, {
    async buildPlan(input) {
      const targetId = input.targets![0].id;
      buildCounts.set(targetId, (buildCounts.get(targetId) || 0) + 1);
      if (targetId === 'target-b') await bGate.promise;
      if (targetId === 'target-c') await cGate.promise;
      if (targetId === 'target-d') await dGate.promise;
      return resolvedPlan(input);
    },
    resolveTarget(_plan, target) {
      if (target.id === 'target-b') bResolved.resolve();
      return { status: 'resolved', target };
    },
  });

  await waitForJob(created.job.id, (job) => job.details?.safeCopyPreparationState === 'resolving');
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const blockedNow = 1_760_000_000_003;
  const blockedTempPath = `${historyPath}.${process.pid}.${blockedNow}.tmp`;
  const realDateNow = Date.now;
  mkdirSync(blockedTempPath);
  Date.now = () => blockedNow;
  try {
    bGate.resolve();
    await bResolved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(preparationSummaryTargetIds(getJob(created.job.id)!), []);
  } finally {
    Date.now = realDateNow;
    rmSync(blockedTempPath, { recursive: true, force: true });
  }

  dGate.resolve();
  const independent = await waitForJob(created.job.id, (job) => (
    preparationSummaryTargetIds(job).join(',') === 'target-d'
  ));
  assert.deepEqual(preparationSummaryTargetIds(independent), ['target-d']);
  assert.deepEqual(preparationSummaryTargetIds(durableJob(created.job.id)!), ['target-d']);

  cGate.resolve();
  await preparation;
  const completed = getJob(created.job.id)!;
  assert.equal(completed.details?.safeCopyPreparationState, 'prepared');
  assert.deepEqual(preparationSummaryTargetIds(completed), ['target-b', 'target-c', 'target-d']);
  assert.deepEqual(Object.fromEntries(buildCounts), {
    'target-b': 1,
    'target-c': 1,
    'target-d': 1,
  });
});

test('safe-copy background preparation contains durable-store write failures', async () => {
  const parsed = parseDashboardSafeCopyIntent(intent('77777777-7777-4777-8777-777777777777'));
  const created = createDashboardSafeCopyJob(parsed);
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  rmSync(historyPath);
  mkdirSync(historyPath);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(created.job.status, 'pending');
});

test('restart resume schedules only the exact prepared ledger and does not re-prepare it', async () => {
  const parsed = parseDashboardSafeCopyIntent(intent('11111111-1111-4111-8111-111111111111'));
  let initialPlanReads = 0;
  let finishInitialPreparation!: () => void;
  const initialPreparation = new Promise<void>((resolve) => {
    finishInitialPreparation = resolve;
  });
  const created = createDashboardSafeCopyJob(parsed, {
    async prepare(jobId, safeIntent) {
      try {
        await prepareDashboardSafeCopyJob(jobId, safeIntent, {
          async buildPlan(input) {
            initialPlanReads += 1;
            return resolvedPlan(input);
          },
          resolveTarget(_plan, target) {
            return { status: 'resolved', target };
          },
        });
      } finally {
        finishInitialPreparation();
      }
    },
  });
  await initialPreparation;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(initialPlanReads, 1);

  const prepared = getJob(created.job.id);
  assert.ok(prepared);
  assert.equal(prepared.status, 'pending');
  assert.equal(prepared.details?.safeCopyPreparationState, 'prepared');
  assert.equal(prepared.items.length, 1);

  const malformed: MigrationJob = {
    ...structuredClone(prepared),
    id: 'malformed-safe-copy-job',
    sourceConnectionId: undefined,
    createdAt: prepared.createdAt + 1,
    details: {
      ...(prepared.details || {}),
      safeCopyRequestId: '12121212-1212-4121-8121-121212121212',
    },
    items: prepared.items.map((item) => ({
      ...structuredClone(item),
      id: `malformed-${item.id}`,
      jobId: 'malformed-safe-copy-job',
    })),
  };
  const extraLedger: MigrationJob = {
    ...structuredClone(prepared),
    id: 'extra-ledger-safe-copy-job',
    createdAt: prepared.createdAt + 2,
    details: {
      ...(prepared.details || {}),
      safeCopyRequestId: '13131313-1313-4131-8131-131313131313',
    },
    items: [
      ...prepared.items.map((item) => ({
        ...structuredClone(item),
        id: `extra-${item.id}`,
        jobId: 'extra-ledger-safe-copy-job',
      })),
      {
        ...structuredClone(prepared.items[0]),
        id: 'unexpected-extra-preparation-summary',
        jobId: 'extra-ledger-safe-copy-job',
      },
    ],
  };
  insertJob(malformed);
  insertJob(extraLedger);
  closeJobStoreForTests();

  let scheduled = 0;
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  assert.deepEqual(resumePendingDashboardSafeCopyJobs(() => {
    scheduled += 1;
  }), []);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scheduled, 0);

  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;
  let resumedJobId = '';
  let resumedIntent: typeof parsed | undefined;
  let resumedPlanReads = 0;
  let resumedYamlReads = 0;
  let finishResume!: () => void;
  const resumeFinished = new Promise<void>((resolve) => {
    finishResume = resolve;
  });
  const resumedIds = resumePendingDashboardSafeCopyJobs(async (jobId, safeIntent) => {
    scheduled += 1;
    resumedJobId = jobId;
    resumedIntent = safeIntent;
    try {
      await prepareDashboardSafeCopyJob(jobId, safeIntent, {
        async buildPlan(input) {
          resumedPlanReads += 1;
          return resolvedPlan(input);
        },
        resolveTarget(_plan, target) {
          return { status: 'resolved', target };
        },
        async loadTargetYamlSnapshot() {
          resumedYamlReads += 1;
          return { files: {}, checksums: {} };
        },
      });
    } finally {
      finishResume();
    }
  });

  assert.deepEqual(resumedIds, [created.job.id]);
  await resumeFinished;
  assert.equal(scheduled, 1);
  assert.equal(resumedJobId, created.job.id);
  assert.deepEqual(resumedIntent, parsed);
  assert.equal(dashboardSafeCopyIntentHash(resumedIntent!), prepared.details?.safeCopyIntentHash);
  assert.equal(resumedPlanReads, 0);
  assert.equal(resumedYamlReads, 0);
  const afterResume = getJob(created.job.id);
  assert.ok(afterResume);
  assert.equal(afterResume.id, created.job.id);
  assert.equal(afterResume.details?.safeCopyPreparationState, 'prepared');
  assert.equal(afterResume.items.length, 1);
});

for (const roleChange of [
  {
    label: 'source',
    requestId: '14141414-1414-4141-8141-141414141414',
    instanceId: 'source-instance',
    role: 'destination' as const,
  },
  {
    label: 'destination',
    requestId: '15151515-1515-4151-8151-151515151515',
    instanceId: 'destination-instance',
    role: 'source' as const,
  },
]) test(`queued safe-copy preparation fails closed when the ${roleChange.label} role changes`, async () => {
  const parsed = parseDashboardSafeCopyIntent(intent(roleChange.requestId));
  let planReads = 0;
  let yamlReads = 0;
  const created = createDashboardSafeCopyJob(parsed, {
    prepare(jobId, safeIntent) {
      return prepareDashboardSafeCopyJob(jobId, safeIntent, {
        async buildPlan(input) {
          planReads += 1;
          return resolvedPlan(input);
        },
        resolveTarget(_plan, target) {
          return { status: 'resolved', target };
        },
        async loadTargetYamlSnapshot() {
          yamlReads += 1;
          return { files: {}, checksums: {} };
        },
      });
    },
  });

  upsertInstance({ id: roleChange.instanceId, role: roleChange.role });
  const failed = await waitForJob(created.job.id, (job) => job.status === 'failed');
  assert.equal(planReads, 0);
  assert.equal(yamlReads, 0);
  assert.deepEqual(failed.items, []);
  assert.equal(failed.details?.safeCopyPreparationState, 'failed');
  assert.equal(failed.details?.safeCopyPreparationErrorCode, 'SAFE_COPY_PREPARATION_FAILED');
  assert.equal(failed.details?.safeCopyPreparationError, 'Safe-copy preparation could not be completed.');
  const disk = readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8');
  assert.doesNotMatch(disk, /not authorized for (source|destination) operations/i);
});

for (const preparationState of ['awaiting_resolver', 'resolving'] as const) test(`safe-copy replay resumes an interrupted ${preparationState} skeleton without changing its job ID`, async () => {
  const parsed = parseDashboardSafeCopyIntent(intent('44444444-4444-4444-8444-444444444444'));
  const created = createDashboardSafeCopyJob(parsed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getJob(created.job.id)?.details?.safeCopyPreparationState, 'awaiting_resolver');

  if (preparationState === 'resolving') {
    const persisted = getJob(created.job.id);
    assert.ok(persisted);
    updateJobStatus({
      ...persisted,
      details: {
        ...(persisted.details || {}),
        safeCopyPreparationState: 'resolving',
      },
    });
  }

  closeJobStoreForTests();
  let observedPendingJob = false;
  const replay = createDashboardSafeCopyJob(parsed, {
    prepare(jobId) {
      const persisted = getJob(jobId);
      observedPendingJob = persisted?.status === 'pending';
    },
  });

  assert.equal(replay.job.id, created.job.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.resumed, true);
  assert.equal(replay.job.status, 'pending');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observedPendingJob, true);
});

test('safe-copy replay does not retry a preparation that already failed', async () => {
  const parsed = parseDashboardSafeCopyIntent(intent('55555555-5555-4555-8555-555555555555'));
  const created = createDashboardSafeCopyJob(parsed, {
    prepare() {
      throw new Error('Deterministic preparation failure.');
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  closeJobStoreForTests();

  let retried = false;
  const replay = createDashboardSafeCopyJob(parsed, {
    prepare() {
      retried = true;
    },
  });
  assert.equal(replay.job.id, created.job.id);
  assert.equal(replay.job.status, 'failed');
  assert.equal(replay.resumed, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retried, false);
});

test('safe-copy jobs cannot enter the legacy migration runner or retry paths', async () => {
  const parsed = parseDashboardSafeCopyIntent(intent('66666666-6666-4666-8666-666666666666'));
  const created = createDashboardSafeCopyJob(parsed);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(() => runMigrationJob(created.job.id), /cannot use the legacy migration runner/);
  await assert.rejects(() => retryMigrationJob(created.job.id), /cannot use the legacy migration retry path/);
  const persisted = getJob(created.job.id);
  assert.ok(persisted);
  assert.equal(persisted.details?.safeCopyPreparationState, 'awaiting_resolver');
  assert.deepEqual(persisted.items, []);
});

test('default safe-copy handler runs production preparation and runtime to one verified artifact', async (t) => {
  const destination = {
    instanceId: 'destination-instance',
    connectionId: 'destination-connection',
    modelId: 'destination-model',
    folderId: 'destination-folder',
    folderPath: 'Shared/Migrated',
  };
  const harness = installProductionSafeCopyOmniHarness(t, {
    sourceDocumentIds: ['dashboard-1'],
    destinations: [destination],
  });
  const request = {
    profile: 'safe_copy_v1',
    requestId: '10000000-0000-4000-8000-000000000201',
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: ['dashboard-1'],
    },
    destinations: [{
      targetId: 'target-1',
      ...destination,
    }],
  };

  const response = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs/safe-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }));
  assert.equal(response.status, 202);
  const accepted = await response.json() as { job: MigrationJob };
  const completed = await waitForTerminalSafeCopyJob(accepted.job.id);

  assert.equal(completed.status, 'succeeded', JSON.stringify({ details: completed.details, items: completed.items }, null, 2));
  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.queryCalls, 0);
  assert.equal(completed.items.filter((item) => item.details?.safeCopyAttemptState === 'verified').length, 1);
  assert.equal(completed.items.filter((item) => item.details?.safeCopyDocumentProvenance !== undefined).length, 1);
  assert.equal(completed.items.filter((item) => item.details?.safeCopyTargetExecutionSummary === true).length, 1);

  const detail = await migrationJobsHandler(new Request(`http://localhost/api/migration-jobs/${completed.id}`));
  assert.equal(detail.status, 200);
  const body = await detail.json() as { job: MigrationJob };
  const evidence = body.job.details?.safeCopyClientEvidence as { complete?: boolean; verifiedDocuments?: unknown[] } | undefined;
  assert.equal(evidence?.complete, true);
  assert.equal(evidence?.verifiedDocuments?.length, 1);
});

test('default runtime verifies two dashboards across three models and restart never recopies six artifacts', async (t) => {
  const destinations = ['b', 'c', 'd'].map((suffix) => ({
    instanceId: `destination-${suffix}`,
    connectionId: `connection-${suffix}`,
    modelId: `model-${suffix}`,
    folderId: `folder-${suffix}`,
    folderPath: `Shared/${suffix.toUpperCase()}`,
  }));
  destinations.forEach((destination) => saveInstance(destination.instanceId));
  const sourceDocumentIds = ['dashboard-1', 'dashboard-2'];
  const harness = installProductionSafeCopyOmniHarness(t, { sourceDocumentIds, destinations });
  const request = {
    profile: 'safe_copy_v1',
    requestId: '10000000-0000-4000-8000-000000000202',
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: sourceDocumentIds,
    },
    destinations: destinations.map((destination, index) => ({
      targetId: `target-${index + 1}`,
      ...destination,
    })),
  };

  const response = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs/safe-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }));
  assert.equal(response.status, 202);
  const accepted = await response.json() as { job: MigrationJob };
  const completed = await waitForTerminalSafeCopyJob(accepted.job.id);

  assert.equal(completed.status, 'succeeded', JSON.stringify({ details: completed.details, items: completed.items }, null, 2));
  assert.equal(harness.createCalls.length, 6);
  assert.equal(new Set(harness.createCalls.map((call) => call.documentId)).size, 6);
  assert.deepEqual(
    harness.createCalls.map((call) => `${call.destinationInstanceId}:${call.modelId}:${call.name}`).sort(),
    destinations.flatMap((destination) => sourceDocumentIds.map((_, index) => (
      `${destination.instanceId}:${destination.modelId}:Dashboard ${index + 1}`
    ))).sort(),
  );
  assert.equal(harness.queryCalls, 0);
  assert.equal(completed.items.filter((item) => item.details?.safeCopyAttemptState === 'verified').length, 6);
  assert.equal(completed.items.filter((item) => item.details?.safeCopyDocumentProvenance !== undefined).length, 6);
  assert.equal(completed.items.filter((item) => (
    item.id.startsWith('safe-copy-verification:')
    && item.kind === 'document_verify'
    && item.status === 'succeeded'
  )).length, 6);
  assert.equal(completed.items.filter((item) => item.details?.safeCopyTargetExecutionSummary === true).length, 3);

  const detail = await migrationJobsHandler(new Request(`http://localhost/api/migration-jobs/${completed.id}`));
  const body = await detail.json() as { job: MigrationJob };
  const evidence = body.job.details?.safeCopyClientEvidence as {
    complete?: boolean;
    invalidTargetIds?: string[];
    verifiedDocuments?: Array<{ targetId: string; sourceDocumentId: string; importedDocumentId: string }>;
  } | undefined;
  assert.equal(evidence?.complete, true);
  assert.deepEqual(evidence?.invalidTargetIds, []);
  assert.equal(evidence?.verifiedDocuments?.length, 6);
  assert.equal(new Set(evidence?.verifiedDocuments?.map((document) => (
    `${document.targetId}:${document.sourceDocumentId}:${document.importedDocumentId}`
  ))).size, 6);

  const createCountBeforeRestart = harness.createCalls.length;
  closeJobStoreForTests();
  const recovered = getJob(completed.id)!;
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.items.filter((item) => item.details?.safeCopyAttemptState === 'verified').length, 6);
  let resumeCalls = 0;
  assert.deepEqual(resumePendingDashboardSafeCopyJobs(async () => { resumeCalls += 1; }), []);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumeCalls, 0);
  assert.equal(harness.createCalls.length, createCountBeforeRestart);
  const restartedDetail = await migrationJobsHandler(new Request(`http://localhost/api/migration-jobs/${completed.id}`));
  assert.equal(restartedDetail.status, 200);
  const restartedBody = await restartedDetail.json() as { job: MigrationJob };
  const restartedEvidence = restartedBody.job.details?.safeCopyClientEvidence as {
    complete?: boolean;
    verifiedDocuments?: unknown[];
  } | undefined;
  assert.equal(restartedEvidence?.complete, true);
  assert.equal(restartedEvidence?.verifiedDocuments?.length, 6);
});

test('partial two-dashboard restart materializes exact proof and copies only untouched cells across three models', async (t) => {
  const destinations = ['b', 'c', 'd'].map((suffix) => ({
    instanceId: `destination-${suffix}`,
    connectionId: `connection-${suffix}`,
    modelId: `model-${suffix}`,
    folderId: `folder-${suffix}`,
    folderPath: `Shared/${suffix.toUpperCase()}`,
  }));
  destinations.forEach((destination) => saveInstance(destination.instanceId));
  const allSourceDocumentIds = ['dashboard-1', 'dashboard-2'];
  const harness = installProductionSafeCopyOmniHarness(t, {
    sourceDocumentIds: allSourceDocumentIds,
    destinations,
  });
  const requestId = '10000000-0000-4000-8000-000000000203';
  const firstDocumentIntent = parseDashboardSafeCopyIntent({
    profile: 'safe_copy_v1',
    requestId,
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: ['dashboard-1'],
    },
    destinations: destinations.map((destination, index) => ({
      targetId: `target-${index + 1}`,
      ...destination,
    })),
  });
  const initialResponse = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs/safe-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(firstDocumentIntent),
  }));
  assert.equal(initialResponse.status, 202);
  const initialAccepted = await initialResponse.json() as { job: MigrationJob };
  const firstDocumentComplete = await waitForTerminalSafeCopyJob(initialAccepted.job.id);
  assert.equal(firstDocumentComplete.status, 'succeeded');
  assert.equal(harness.createCalls.length, 3);

  const expandedIntent = parseDashboardSafeCopyIntent({
    ...firstDocumentIntent,
    source: { ...firstDocumentIntent.source, documentIds: allSourceDocumentIds },
  });
  const preparationIntent = parseDashboardSafeCopyIntent({
    ...expandedIntent,
    requestId: '10000000-0000-4000-8000-000000000204',
  });
  const prepared = createDashboardSafeCopyJob(preparationIntent, {
    prepare: prepareDashboardSafeCopyJob,
  });
  const preparationJob = await waitForJob(prepared.job.id, (job) => (
    job.details?.safeCopyPreparationState === 'prepared'
  ));
  const preparationSummaries = preparationJob.items.filter((item) => (
    item.details?.safeCopyPreparationSummary === true
  ));
  assert.equal(preparationSummaries.length, 3);
  assert.equal(cancelDashboardSafeCopyJob(preparationJob.id).status, 'canceled');

  const firstDocumentEvidence = firstDocumentComplete.items.filter((item) => (
    item.details?.safeCopyAttempt === true
    || item.details?.safeCopyDocumentProvenance !== undefined
  ));
  assert.equal(firstDocumentEvidence.filter((item) => item.details?.safeCopyAttemptState === 'verified').length, 3);
  assert.equal(firstDocumentEvidence.filter((item) => item.details?.safeCopyDocumentProvenance !== undefined).length, 3);
  updateJobStatus({
    ...firstDocumentComplete,
    documentIds: allSourceDocumentIds,
    status: 'pending',
    endedAt: undefined,
    details: {
      ...(firstDocumentComplete.details || {}),
      safeCopyIntentHash: dashboardSafeCopyIntentHash(expandedIntent),
      safeCopyPreparationState: 'prepared',
      safeCopyExecutionState: 'resume_required',
      safeCopyReadyTargetCount: 3,
      safeCopyExceptionTargetCount: 0,
      safeCopySucceededTargetCount: 0,
      safeCopyNeedsAttentionTargetCount: 0,
    },
    items: [
      ...preparationSummaries.map((item) => ({ ...item, jobId: firstDocumentComplete.id })),
      ...firstDocumentEvidence,
    ],
  });

  closeJobStoreForTests();
  const partial = getJob(firstDocumentComplete.id)!;
  assert.equal(partial.status, 'pending');
  assert.equal(partial.items.filter((item) => item.details?.safeCopyAttemptState === 'verified').length, 3);
  assert.equal(partial.items.some((item) => item.details?.safeCopyTargetExecutionSummary === true), false);

  const resumed = await runDashboardSafeCopyJob(partial.id, expandedIntent);
  assert.equal(resumed.job.status, 'succeeded', JSON.stringify({
    details: resumed.job.details,
    items: resumed.job.items,
  }, null, 2));
  assert.equal(harness.createCalls.length, 6, 'restart must create only the three untouched dashboard cells');
  assert.deepEqual(
    harness.createCalls.map((call) => `${call.destinationInstanceId}:${call.name}`).sort(),
    destinations.flatMap((destination) => [
      `${destination.instanceId}:Dashboard 1`,
      `${destination.instanceId}:Dashboard 2`,
    ]).sort(),
  );
  const final = getJob(partial.id)!;
  assert.equal(final.items.filter((item) => item.details?.safeCopyAttemptState === 'verified').length, 6);
  assert.equal(final.items.filter((item) => item.details?.safeCopyDocumentProvenance !== undefined).length, 6);
});

test('safe-copy endpoint is enabled by default, explicitly disableable, and durably idempotent', async () => {
  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;
  const created = await postSafeCopy(intent());
  assert.equal(created.status, 202);
  const createdBody = await created.json() as { job: { id: string; details?: Record<string, unknown> }; replayed: boolean; resumed: boolean };
  assert.equal(createdBody.replayed, false);
  assert.equal(createdBody.resumed, false);
  assert.equal(createdBody.job.details?.safeCopyProfile, 'safe_copy_v1');

  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  const disabled = await postSafeCopy(intent('67676767-6767-4676-8676-676767676767'));
  assert.equal(disabled.status, 404);
  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;

  const replay = await postSafeCopy(intent());
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { job: { id: string }; replayed: boolean };
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.job.id, createdBody.job.id);

  closeJobStoreForTests();
  const replayAfterReload = await postSafeCopy(intent());
  assert.equal(replayAfterReload.status, 200);
  const replayAfterReloadBody = await replayAfterReload.json() as { job: { id: string; status: string }; replayed: boolean; resumed: boolean };
  assert.equal(replayAfterReloadBody.job.id, createdBody.job.id);
  assert.equal(replayAfterReloadBody.job.status, 'pending');
  assert.equal(replayAfterReloadBody.resumed, true);
});

test('disabled safe-copy route stays dark even while the vault is locked', async () => {
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  lockVault();
  const response = await postSafeCopy(intent('66666666-6666-4666-8666-666666666666'));
  assert.equal(response.status, 404);
});

test('safe-copy endpoint returns a typed conflict when one request ID is reused for a different intent', async () => {
  assert.equal((await postSafeCopy(intent())).status, 202);
  const changed = intent();
  changed.source.documentIds = ['different-dashboard'];
  const conflict = await postSafeCopy(changed);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: 'This safe-copy request ID was already used for a different migration intent.',
    code: 'SAFE_COPY_IDEMPOTENCY_CONFLICT',
  });
});

test('safe-copy endpoint rejects malformed and destructive payloads without creating a job', async () => {
  const destructive = await postSafeCopy({ ...intent(), deleteSourceOnSuccess: true });
  assert.equal(destructive.status, 400);
  const destructiveBody = await destructive.json() as { code?: string };
  assert.equal(destructiveBody.code, 'SAFE_COPY_UNKNOWN_FIELD');

  const malformed = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs/safe-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { code?: string }).code, 'SAFE_COPY_INVALID_BODY');

  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  assert.equal(existsSync(historyPath), false);
});

test('legacy migration create is rollback-only and retains its prior validation behind the internal gate', async () => {
  const disabled = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
  assert.equal(disabled.status, 404);
  assert.deepEqual(await disabled.json(), {
    error: 'Legacy dashboard migration workflow is not enabled.',
  });

  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  const rollback = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
  assert.equal(rollback.status, 400);
  assert.deepEqual(await rollback.json(), {
    error: 'Select one source, at least one migration target, and at least one dashboard.',
  });
});
