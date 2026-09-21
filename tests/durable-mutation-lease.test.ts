import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';

import vaultHandler from '../server/handlers/vault';
import migrationJobsHandler from '../server/handlers/migration-jobs';
import {
  cancelDashboardSafeCopyJob,
  createDashboardSafeCopyJob,
} from '../server/services/dashboardSafeCopyJobs';
import {
  createMigrationJob,
  createModelMigrationJob,
  getJob,
  listJobs,
  mergeModelMigrationJob,
  resumeDestinationModelMutationReconciliation,
  runTrackedSchemaRefresh,
  validateDashboardMigrationPatches,
  type MigrationJob,
  type MigrationJobItem,
  type MigrationWorkflow,
  type ModelMigrationJobInput,
} from '../server/services/migrationJobs';
import {
  closeJobStoreForTests,
  insertJob,
} from '../server/services/jobStore';
import {
  hasUnresolvedMigrationDestinationModelMutation,
  migrationDestinationModelMutationLease,
  reserveMigrationDestinationModels,
} from '../server/services/migrationScopeReservation';
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
import {
  DASHBOARD_SAFE_COPY_PROFILE,
  DashboardSafeCopyError,
  type DashboardSafeCopyIntent,
} from '../shared/dashboardSafeCopyContract';

const DESTINATION_ID = 'durable-destination';
const TARGET_MODEL_ID = 'durable-target-model';
const EXTERNAL_JOB_ID = 'remote-refresh-417';

let temporaryRoot = '';

beforeEach(() => {
  resetOmniClientRateLimitStateForTests();
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-durable-mutation-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  closeJobStoreForTests();
  resetVault();
  unlockVault('durable mutation test passphrase');
});

afterEach(() => {
  resetOmniClientRateLimitStateForTests();
  resetVault();
  lockVault();
  closeJobStoreForTests();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

function saveInstances() {
  const source = upsertInstance({
    id: 'durable-source',
    label: 'Durable source',
    role: 'source',
    baseUrl: 'https://durable-source.example.omniapp.co',
    apiKey: 'fictional-source-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const destination = upsertInstance({
    id: DESTINATION_ID,
    label: 'Durable destination',
    role: 'destination',
    baseUrl: 'https://durable-destination.example.omniapp.co',
    apiKey: 'fictional-destination-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  return { source, destination };
}

function leaseItem(input: {
  jobId: string;
  operation: 'model_job' | 'legacy_dashboard_job' | 'schema_refresh';
  state: 'claimed' | 'dispatched' | 'remote_pending' | 'uncertain';
  externalJobId?: string;
}): MigrationJobItem {
  return {
    id: `${input.jobId}-lease`,
    jobId: input.jobId,
    destinationId: DESTINATION_ID,
    destinationLabel: 'Durable destination',
    targetModelId: TARGET_MODEL_ID,
    targetModelName: 'Durable target model',
    kind: 'destination_model_mutation',
    status: input.state === 'claimed' ? 'pending' : input.state === 'uncertain' ? 'warning' : 'running',
    startedAt: 1,
    details: {
      migrationDestinationModelMutation: true,
      migrationMutationState: input.state,
      migrationMutationOperation: input.operation,
      migrationMutationUpdatedAt: 1,
      ...(input.externalJobId ? { migrationMutationExternalJobId: input.externalJobId } : {}),
    },
  };
}

function interruptedMutationJob(input: {
  id: string;
  workflow: MigrationWorkflow;
  operation: 'model_job' | 'legacy_dashboard_job';
  state: 'claimed' | 'dispatched';
}): MigrationJob {
  const workItem: MigrationJobItem = {
    id: `${input.id}-work`,
    jobId: input.id,
    destinationId: DESTINATION_ID,
    destinationLabel: 'Durable destination',
    targetModelId: TARGET_MODEL_ID,
    targetModelName: 'Durable target model',
    kind: input.workflow === 'model' ? 'model_yaml_write' : 'import',
    status: 'running',
    startedAt: 1,
  };
  const mutationLease = leaseItem({
    jobId: input.id,
    operation: input.operation,
    state: input.state,
  });
  mutationLease.details = {
    ...(mutationLease.details || {}),
    migrationMutationRevision: 7,
    ...(input.state === 'dispatched' ? {
      migrationMutationDispatchItemId: workItem.id,
      migrationMutationDispatchItemKind: workItem.kind,
      migrationMutationDispatchedAt: 1,
      migrationMutationDispatchFingerprint: 'a'.repeat(64),
    } : {}),
  };
  return {
    id: input.id,
    workflow: input.workflow,
    sourceId: 'durable-source',
    sourceLabel: 'Durable source',
    destinationIds: [DESTINATION_ID],
    targets: [{
      id: `${input.id}-target`,
      destinationInstanceId: DESTINATION_ID,
      destinationLabel: 'Durable destination',
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
    }],
    documentIds: input.workflow === 'dashboard' ? ['fictional-dashboard'] : [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'running',
    createdAt: 1,
    startedAt: 1,
    details: input.workflow === 'model'
      ? { targetId: DESTINATION_ID, retryInput: {} }
      : { operationMode: 'copy_import' },
    items: [workItem, mutationLease],
  };
}

function exactScope(targetModelId = TARGET_MODEL_ID, destinationInstanceId = DESTINATION_ID) {
  return [{ destinationInstanceId, targetModelId }];
}

function safeCopyIntent(
  requestId: string,
  targetModelId = TARGET_MODEL_ID,
  destinationInstanceId = DESTINATION_ID,
): DashboardSafeCopyIntent {
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId,
    source: {
      instanceId: 'durable-source',
      connectionId: 'fictional-source-connection',
      documentIds: ['fictional-source-dashboard'],
    },
    destinations: [{
      targetId: `${destinationInstanceId}:${targetModelId}`,
      instanceId: destinationInstanceId,
      connectionId: 'fictional-destination-connection',
      modelId: targetModelId,
    }],
  };
}

function scratchValidationInput(destinationInstanceId = DESTINATION_ID) {
  return {
    sourceId: 'durable-source',
    targets: [{
      id: 'scratch-target',
      destinationInstanceId,
      targetConnectionId: 'fictional-destination-connection',
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
      semanticPatches: [{
        id: 'field:fictional_orders.fictional_total:fictional_orders.view',
        artifactType: 'field' as const,
        sourceName: 'fictional_orders.fictional_total',
        targetFileName: 'fictional_orders.view',
        acceptedYaml: 'measures:\n  fictional_total:\n    sql: ${fictional_orders.amount}\n    aggregate_type: sum\n',
        resolution: 'custom_edit' as const,
        status: 'ready' as const,
      }],
    }],
    documentIds: ['fictional-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  };
}

async function waitForTerminalJob(jobId: string): Promise<MigrationJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = getJob(jobId);
    if (current && ['succeeded', 'partial', 'failed', 'canceled'].includes(current.status)) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const current = getJob(jobId);
  throw new Error(`Job did not become terminal: ${current?.status || 'missing'}`);
}

async function waitForLeaseState(jobId: string, expected: 'resolved' | 'uncertain'): Promise<MigrationJobItem> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const item = getJob(jobId)?.items.find((candidate) => candidate.kind === 'destination_model_mutation');
    if (item && migrationDestinationModelMutationLease(item)?.state === expected) return item;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const current = getJob(jobId);
  const item = current?.items.find((candidate) => candidate.kind === 'destination_model_mutation');
  throw new Error(`Mutation lease did not become ${expected}: ${item ? migrationDestinationModelMutationLease(item)?.state || 'malformed' : 'missing'}; job=${JSON.stringify(current)}`);
}

function mockLegacyDashboardHappyPath(t: TestContext, input: {
  sourceId: string;
  sourceLabel: string;
  sourceModelId: string;
  description?: string;
}): void {
  const unexpectedUrls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (request: string | URL | Request) => {
    unexpectedUrls.push(String(request));
    throw new Error(`Unexpected fictional tenant request: ${String(request)}`);
  });
  t.after(() => assert.deepEqual(unexpectedUrls, []));
  const workbookModelId = `${input.sourceModelId}-workbook`;
  t.mock.method(OmniClient.prototype, 'getDocumentStateV2', async (documentId: string) => {
    assert.equal(documentId, 'fictional-dashboard');
    return { modelId: input.sourceModelId, workbookModelId };
  });
  t.mock.method(OmniClient.prototype, 'getModelYaml', async (
    modelId: string,
    options: { fullyResolved?: boolean; mode?: string } = {},
  ) => {
    assert.equal(options.fullyResolved, false);
    assert.equal(modelId, options.mode === 'extension' ? workbookModelId : input.sourceModelId);
    return { files: {}, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    const instance = (this as unknown as { instance: { id: string; label: string } }).instance;
    return instance.id === input.sourceId || instance.label === input.sourceLabel
      ? [{
          id: 'fictional-dashboard-id',
          identifier: 'fictional-dashboard',
          name: 'Fictional dashboard',
          baseModelId: input.sourceModelId,
          ...(input.description ? { description: input.description } : {}),
        }]
      : [];
  });
  t.mock.method(OmniClient.prototype, 'listDocumentAccess', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserAttributes', async () => []);
  t.mock.method(OmniClient.prototype, 'listIdentityUsers', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserGroups', async () => []);
  t.mock.method(OmniClient.prototype, 'listModelTopics', async () => []);
  t.mock.method(OmniClient.prototype, 'listModelQueryViews', async () => []);
  t.mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));
  t.mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  t.mock.method(OmniClient.prototype, 'validateModel', async () => []);
  t.mock.method(OmniClient.prototype, 'validateModelContent', async () => ({ issues: [] }));
  t.mock.method(OmniClient.prototype, 'listLabels', async () => []);
  t.mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: input.sourceModelId,
    tiles: [],
  }));
  t.mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'fictional-imported-dashboard',
    documentId: 'fictional-imported-dashboard-id',
  }));
}

test('restart releases claimed pre-dispatch leases for Model Migrator and legacy dashboard jobs', () => {
  saveInstances();
  for (const fixture of [
    { id: 'claimed-model-job', workflow: 'model', operation: 'model_job' },
    { id: 'claimed-dashboard-job', workflow: 'dashboard', operation: 'legacy_dashboard_job' },
  ] as const) {
    insertJob(interruptedMutationJob({ ...fixture, state: 'claimed' }));
  }

  closeJobStoreForTests();

  for (const jobId of ['claimed-model-job', 'claimed-dashboard-job']) {
    const recovered = getJob(jobId);
    const lease = recovered?.items.find((item) => item.kind === 'destination_model_mutation');
    assert.equal(recovered?.status, 'failed');
    assert.equal(migrationDestinationModelMutationLease(lease!)?.state, 'failed_prewrite');
  }
  assert.equal(
    hasUnresolvedMigrationDestinationModelMutation(
      [getJob('claimed-model-job')!, getJob('claimed-dashboard-job')!],
      exactScope(),
    ),
    false,
  );
  const admitted = createDashboardSafeCopyJob(
    safeCopyIntent('10000000-0000-4000-8000-000000000101'),
    { prepare: () => undefined },
  );
  assert.equal(admitted.replayed, false);
  assert.equal(admitted.job.targets?.[0]?.targetModelId, TARGET_MODEL_ID);
  assert.equal(cancelDashboardSafeCopyJob(admitted.job.id).status, 'canceled');
});

test('restart makes dispatched Model Migrator and legacy dashboard writes uncertain and blocks only their exact scope', () => {
  saveInstances();
  for (const fixture of [
    { id: 'dispatched-model-job', workflow: 'model', operation: 'model_job' },
    { id: 'dispatched-dashboard-job', workflow: 'dashboard', operation: 'legacy_dashboard_job' },
  ] as const) {
    insertJob(interruptedMutationJob({ ...fixture, state: 'dispatched' }));
  }

  closeJobStoreForTests();

  const recovered = ['dispatched-model-job', 'dispatched-dashboard-job'].map((jobId) => getJob(jobId)!);
  for (const job of recovered) {
    const lease = job.items.find((item) => item.kind === 'destination_model_mutation');
    assert.equal(job.status, 'failed');
    assert.equal(job.details?.migrationMutationState, 'reconciliation_required');
    const recoveredLease = migrationDestinationModelMutationLease(lease!);
    assert.equal(recoveredLease?.state, 'uncertain');
    assert.equal(recoveredLease?.revision, 8);
    assert.equal(recoveredLease?.dispatchItemId, `${job.id}-work`);
    assert.equal(recoveredLease?.dispatchItemKind, job.workflow === 'model' ? 'model_yaml_write' : 'import');
    assert.equal(recoveredLease?.dispatchFingerprint, 'a'.repeat(64));
    assert.equal(recoveredLease?.externalJobId, undefined);
  }
  assert.equal(hasUnresolvedMigrationDestinationModelMutation(recovered, exactScope()), true);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation(recovered, exactScope('sibling-model')), false);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation(recovered, exactScope(TARGET_MODEL_ID, 'sibling-destination')), false);

  assert.throws(
    () => createDashboardSafeCopyJob(
      safeCopyIntent('10000000-0000-4000-8000-000000000102'),
      { prepare: () => undefined },
    ),
    (error: unknown) => (
      error instanceof DashboardSafeCopyError
      && error.code === 'SAFE_COPY_SCOPE_CONFLICT'
      && error.statusCode === 409
    ),
  );
  const siblingModel = createDashboardSafeCopyJob(
    safeCopyIntent('10000000-0000-4000-8000-000000000103', 'sibling-model'),
    { prepare: () => undefined },
  );
  assert.equal(siblingModel.replayed, false);

  upsertInstance({
    id: 'sibling-destination',
    label: 'Sibling destination',
    role: 'destination',
    baseUrl: 'https://sibling-destination.example.omniapp.co',
    apiKey: 'fictional-sibling-destination-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const siblingDestination = createDashboardSafeCopyJob(
    safeCopyIntent('10000000-0000-4000-8000-000000000104', TARGET_MODEL_ID, 'sibling-destination'),
    { prepare: () => undefined },
  );
  assert.equal(siblingDestination.replayed, false);
  assert.equal(cancelDashboardSafeCopyJob(siblingModel.job.id).status, 'canceled');
  assert.equal(cancelDashboardSafeCopyJob(siblingDestination.job.id).status, 'canceled');
});

test('restart advances a terminal dispatched lease to uncertain without losing its exact dispatch identity', () => {
  saveInstances();
  const fixture = interruptedMutationJob({
    id: 'terminal-dispatched-model-job',
    workflow: 'model',
    operation: 'model_job',
    state: 'dispatched',
  });
  fixture.status = 'failed';
  fixture.endedAt = 2;
  fixture.items[0]!.status = 'failed';
  fixture.items[0]!.endedAt = 2;
  insertJob(fixture);

  closeJobStoreForTests();

  const recovered = getJob(fixture.id)!;
  const lease = migrationDestinationModelMutationLease(
    recovered.items.find((item) => item.kind === 'destination_model_mutation')!,
  );
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.details?.migrationMutationState, 'reconciliation_required');
  assert.equal(lease?.state, 'uncertain');
  assert.equal(lease?.revision, 8);
  assert.equal(lease?.dispatchItemId, `${fixture.id}-work`);
  assert.equal(lease?.dispatchItemKind, 'model_yaml_write');
  assert.equal(lease?.dispatchedAt, 1);
  assert.equal(lease?.dispatchFingerprint, 'a'.repeat(64));
  assert.ok((lease?.updatedAt || 0) > 1);
});

test('a Model Migrator parent refresh polls its external job to terminal before releasing the mutation lease', async (t) => {
  const { source, destination } = saveInstances();
  const observedStatusJobIds: string[] = [];
  t.mock.method(OmniClient.prototype, 'migrateModel', async () => ({ status: 'ok' }));
  t.mock.method(OmniClient.prototype, 'findModelBranch', async () => ({
    id: 'fictional-branch-id',
    name: 'fictional-branch',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'validateModel', async () => []);
  t.mock.method(OmniClient.prototype, 'validateModelContent', async () => ({ issues: [] }));
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => ({
    jobId: EXTERNAL_JOB_ID,
    status: 'RUNNING',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    observedStatusJobIds.push(jobId);
    return { jobId, status: 'COMPLETED', raw: {} };
  });

  const input: ModelMigrationJobInput = {
    sourceId: source.id,
    targetId: destination.id,
    models: [{
      sourceModelId: 'fictional-source-model',
      targetModelId: TARGET_MODEL_ID,
      targetConnectionId: 'fictional-target-connection',
      mode: 'fast',
      branchName: 'fictional-branch',
      fastPathSchemaConfirmed: true,
      orgApiKeyConfirmed: true,
    }],
    content: [],
    replaceSameNamed: false,
    mergeAfterValidation: false,
    publishDrafts: false,
    deleteBranch: false,
    postMigrationActions: [{
      kind: 'refresh-schema',
      name: 'Refresh fictional target model',
      method: 'POST',
      url: '',
      headers: {},
      body: '',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
    }],
  };

  const created = await createModelMigrationJob(input);
  const completed = await waitForTerminalJob(created.id);
  const refresh = completed.items.find((item) => item.kind === 'post_action');
  const lease = completed.items.find((item) => item.kind === 'destination_model_mutation');

  assert.deepEqual(
    observedStatusJobIds,
    [EXTERNAL_JOB_ID],
    completed.items.map((item) => `${item.kind}:${item.status}:${item.error || ''}`).join(' | '),
  );
  assert.equal(refresh?.status, 'succeeded');
  assert.equal(refresh?.details?.migrationMutationTerminal, true);
  assert.equal(refresh?.details?.migrationMutationExternalJobId, EXTERNAL_JOB_ID);
  assert.equal(migrationDestinationModelMutationLease(lease!)?.state, 'resolved');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([completed], exactScope()), false);
});

test('a validated Model Migrator job can merge the same scope while retaining resolved model-job history', async (t) => {
  const { source, destination } = saveInstances();
  let mergeCalls = 0;
  t.mock.method(OmniClient.prototype, 'migrateModel', async () => ({ status: 'ok' }));
  t.mock.method(OmniClient.prototype, 'findModelBranch', async () => ({
    id: 'fictional-branch-id',
    name: 'fictional-branch',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'validateModel', async () => []);
  t.mock.method(OmniClient.prototype, 'validateModelContent', async () => ({ issues: [] }));
  t.mock.method(OmniClient.prototype, 'mergeModelBranch', async () => {
    mergeCalls += 1;
    return { status: 'COMPLETED', raw: {} };
  });

  const created = await createModelMigrationJob({
    sourceId: source.id,
    targetId: destination.id,
    models: [{
      sourceModelId: 'fictional-source-model',
      targetModelId: TARGET_MODEL_ID,
      targetConnectionId: 'fictional-target-connection',
      mode: 'fast',
      branchName: 'fictional-branch',
      fastPathSchemaConfirmed: true,
      orgApiKeyConfirmed: true,
    }],
    content: [],
    replaceSameNamed: false,
    mergeAfterValidation: false,
    publishDrafts: false,
    deleteBranch: false,
    postMigrationActions: [],
  });
  const validated = await waitForTerminalJob(created.id);
  const beforeMergeLeases = validated.items
    .map(migrationDestinationModelMutationLease)
    .filter((lease) => lease !== undefined);
  assert.deepEqual(beforeMergeLeases.map((lease) => [lease.operation, lease.state]), [
    ['model_job', 'resolved'],
  ]);

  const merged = await mergeModelMigrationJob(validated.id, {
    publishDrafts: false,
    deleteBranch: false,
  });
  const afterMergeLeases = merged.items
    .map(migrationDestinationModelMutationLease)
    .filter((lease) => lease !== undefined)
    .sort((left, right) => left.operation.localeCompare(right.operation));

  assert.equal(mergeCalls, 1);
  assert.equal(merged.items.find((item) => item.kind === 'model_merge')?.status, 'succeeded');
  assert.deepEqual(afterMergeLeases.map((lease) => [lease.operation, lease.state]), [
    ['model_job', 'resolved'],
    ['model_merge', 'resolved'],
  ]);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([merged], exactScope()), false);
});

test('a running refresh without an external job id stays uncertain and retains its exact scope', async (t) => {
  const { destination } = saveInstances();
  let statusReads = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => ({
    status: 'RUNNING',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    statusReads += 1;
    return { jobId, status: 'COMPLETED', raw: {} };
  });

  const result = await runTrackedSchemaRefresh(destination.id, TARGET_MODEL_ID);
  const stored = getJob(result.trackingJobId)!;
  const lease = stored.items.find((item) => item.kind === 'destination_model_mutation');

  assert.equal(result.ok, false);
  assert.equal(result.terminal, false);
  assert.equal(result.externalJobId, undefined);
  assert.equal(statusReads, 0);
  assert.equal(migrationDestinationModelMutationLease(lease!)?.state, 'uncertain');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([stored], exactScope()), true);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([stored], exactScope('sibling-model')), false);
});

test('a tracked refresh persistence failure dispatches no Omni write, leaves no orphan, and releases its reservation', async (t) => {
  const { destination } = saveInstances();
  let refreshCalls = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { jobId: EXTERNAL_JOB_ID, status: 'RUNNING', raw: {} };
  });

  const healthyHistoryPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const readOnlyHistoryDirectory = path.join(temporaryRoot, 'read-only-history');
  mkdirSync(readOnlyHistoryDirectory);
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(readOnlyHistoryDirectory, 'jobs.json');
  closeJobStoreForTests();
  assert.deepEqual(listJobs(), []);
  chmodSync(readOnlyHistoryDirectory, 0o500);

  try {
    await assert.rejects(
      () => runTrackedSchemaRefresh(destination.id, TARGET_MODEL_ID),
      /EACCES|permission denied|operation not permitted/i,
    );
    assert.equal(refreshCalls, 0);
    const releaseProbe = reserveMigrationDestinationModels('refresh-insert-failure-probe', exactScope());
    releaseProbe();
  } finally {
    chmodSync(readOnlyHistoryDirectory, 0o700);
    process.env.OMNIKIT_JOB_HISTORY_PATH = healthyHistoryPath;
    closeJobStoreForTests();
  }

  assert.deepEqual(listJobs(), []);
});

test('a schema status response for a different job id leaves the exact tracked refresh uncertain', async (t) => {
  const { destination } = saveInstances();
  const statusReads: string[] = [];
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => ({
    jobId: EXTERNAL_JOB_ID,
    status: 'RUNNING',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    statusReads.push(jobId);
    return { jobId: 'different-remote-job', status: 'COMPLETED', raw: {} };
  });

  const result = await runTrackedSchemaRefresh(destination.id, TARGET_MODEL_ID);
  const stored = getJob(result.trackingJobId)!;
  const action = stored.items.find((item) => item.kind === 'post_action');
  const leaseItem = stored.items.find((item) => item.kind === 'destination_model_mutation');
  const lease = migrationDestinationModelMutationLease(leaseItem!);

  assert.deepEqual(statusReads, [EXTERNAL_JOB_ID]);
  assert.equal(result.ok, false);
  assert.equal(result.terminal, false);
  assert.equal(result.externalJobId, EXTERNAL_JOB_ID);
  assert.match(result.error || '', /did not match the tracked job/);
  assert.equal(action?.status, 'failed');
  assert.equal(action?.details?.migrationMutationTerminal, false);
  assert.equal(lease?.state, 'uncertain');
  assert.equal(lease?.externalJobId, EXTERNAL_JOB_ID);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([stored], exactScope()), true);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([stored], exactScope('sibling-model')), false);
});

test('two tracked refreshes clear prior external job identity and never poll the old job again', async (t) => {
  const { destination } = saveInstances();
  const externalJobIds = ['refresh-job-j1', 'refresh-job-j2'];
  const statusPolls: string[] = [];
  let refreshCall = 0;

  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    const externalJobId = externalJobIds[refreshCall]!;
    refreshCall += 1;
    const active = listJobs().find((job) => (
      job.status === 'running'
      && job.details?.operationMode === 'schema_refresh'
    ));
    assert.ok(active);
    const lease = migrationDestinationModelMutationLease(
      active.items.find((item) => item.kind === 'destination_model_mutation')!,
    );
    assert.equal(lease?.state, 'dispatched');
    assert.equal(lease?.externalJobId, undefined, 'a new dispatch must not inherit the prior refresh job id');
    return { jobId: externalJobId, status: 'RUNNING', raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    statusPolls.push(jobId);
    return { jobId, status: 'COMPLETED', raw: {} };
  });

  const first = await runTrackedSchemaRefresh(destination.id, TARGET_MODEL_ID, 'Durable target model');
  const second = await runTrackedSchemaRefresh(destination.id, TARGET_MODEL_ID, 'Durable target model');

  assert.equal(first.externalJobId, 'refresh-job-j1');
  assert.equal(second.externalJobId, 'refresh-job-j2');
  assert.deepEqual(statusPolls, ['refresh-job-j1', 'refresh-job-j2']);
  assert.equal(refreshCall, 2);
});

test('scratch lost-create evidence never authorizes name-only deletion and does not block main safe-copy admission', async (t) => {
  saveInstances();
  let branchInventoryCalls = 0;
  let deleteCalls = 0;
  t.mock.method(OmniClient.prototype, 'listModels', async (kind?: unknown) => {
    if (kind === 'BRANCH') {
      branchInventoryCalls += 1;
      return [];
    }
    return [{
      id: TARGET_MODEL_ID,
      name: 'Durable target model',
      connectionId: 'fictional-destination-connection',
    }];
  });
  t.mock.method(OmniClient.prototype, 'createModelBranch', async () => {
    throw new Error('Fictional branch-create response was lost.');
  });
  t.mock.method(OmniClient.prototype, 'deleteModelBranch', async () => {
    deleteCalls += 1;
  });

  const validation = await validateDashboardMigrationPatches(scratchValidationInput());
  assert.equal(validation.status, 'failed');
  const scratch = listJobs().find((job) => job.details?.operationMode === 'scratch_validation');
  assert.ok(scratch);
  const lease = migrationDestinationModelMutationLease(
    scratch.items.find((item) => item.kind === 'destination_model_mutation')!,
  );
  const branchCreate = scratch.items.find((item) => item.kind === 'model_branch_create');
  assert.equal(lease?.state, 'uncertain');
  assert.match(String(scratch.details?.migrationMutationBranchName || ''), /^omnikit-validate-[0-9a-f-]{36}$/i);
  assert.equal(branchCreate?.details?.migrationMutationBranchId, undefined);
  assert.equal(deleteCalls, 0);

  const admitted = createDashboardSafeCopyJob(
    safeCopyIntent('10000000-0000-4000-8000-000000000106'),
    { prepare: () => undefined },
  );
  assert.equal(admitted.replayed, false);
  assert.equal(cancelDashboardSafeCopyJob(admitted.job.id).status, 'canceled');

  const historyClear = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs', {
    method: 'DELETE',
  }));
  assert.equal(historyClear.status, 409);
  assert.equal((await historyClear.json() as { code?: string }).code, 'MIGRATION_LEDGER_ACTIVE');
  const vaultReset = await vaultHandler(new Request('http://localhost/api/vault/reset', { method: 'DELETE' }));
  assert.equal(vaultReset.status, 409);
  assert.equal((await vaultReset.json() as { code?: string }).code, 'MIGRATION_LEDGER_ACTIVE');

  closeJobStoreForTests();
  const resumed = resumeDestinationModelMutationReconciliation();
  assert.deepEqual(resumed, [`${scratch.id}:${lease!.itemId}`]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(branchInventoryCalls, 0, 'no branch lookup is safe without the exact persisted branch id');
  assert.equal(deleteCalls, 0, 'the persisted branch name alone must never authorize deletion');
  assert.equal(migrationDestinationModelMutationLease(
    getJob(scratch.id)!.items.find((item) => item.kind === 'destination_model_mutation')!,
  )?.state, 'uncertain');
});

test('scratch validation remains isolated when a main safe-copy scope was admitted first', async (t) => {
  saveInstances();
  const admitted = createDashboardSafeCopyJob(
    safeCopyIntent('10000000-0000-4000-8000-000000000107'),
    { prepare: () => undefined },
  );
  assert.equal(admitted.replayed, false);
  t.mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: TARGET_MODEL_ID,
    name: 'Durable target model',
    connectionId: 'fictional-destination-connection',
  }]);
  t.mock.method(OmniClient.prototype, 'createModelBranch', async () => {
    throw new Error('Fictional branch-create response was lost.');
  });

  const validation = await validateDashboardMigrationPatches(scratchValidationInput());
  assert.equal(validation.status, 'failed');
  assert.match(validation.results[0]?.error || '', /branch-create response was lost/i);
  assert.equal(listJobs().filter((job) => job.details?.operationMode === 'scratch_validation').length, 1);
  assert.equal(cancelDashboardSafeCopyJob(admitted.job.id).status, 'canceled');
});

test('scratch restart cleanup requires the exact persisted branch id before releasing its lease', async (t) => {
  saveInstances();
  const branchId = 'fictional-exact-scratch-branch-id';
  let branchName = '';
  let branchExists = true;
  let cleanupPhase = false;
  const deleteCalls: Array<{ modelId: string; branchName: string }> = [];
  t.mock.method(OmniClient.prototype, 'listModels', async (kind?: unknown) => {
    if (kind === 'BRANCH') {
      return branchExists
        ? [{ id: branchId, name: branchName, baseModelId: TARGET_MODEL_ID }]
        : [];
    }
    return [{
      id: TARGET_MODEL_ID,
      name: 'Durable target model',
      connectionId: 'fictional-destination-connection',
    }];
  });
  t.mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }) => {
    branchName = input.branchName;
    return { id: branchId, name: branchName, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async () => undefined);
  t.mock.method(OmniClient.prototype, 'validateModel', async () => []);
  t.mock.method(OmniClient.prototype, 'validateModelContent', async () => ({ issues: [] }));
  t.mock.method(OmniClient.prototype, 'deleteModelBranch', async (modelId: string, name: string) => {
    deleteCalls.push({ modelId, branchName: name });
    if (!cleanupPhase) throw new Error('Fictional scratch cleanup response was lost.');
    branchExists = false;
  });

  const validation = await validateDashboardMigrationPatches(scratchValidationInput());
  assert.equal(validation.status, 'failed');
  const scratch = listJobs().find((job) => job.details?.operationMode === 'scratch_validation');
  assert.ok(scratch);
  const branchCreate = scratch.items.find((item) => item.kind === 'model_branch_create');
  const lease = migrationDestinationModelMutationLease(
    scratch.items.find((item) => item.kind === 'destination_model_mutation')!,
  );
  assert.equal(branchCreate?.details?.migrationMutationBranchId, branchId);
  assert.equal(lease?.state, 'uncertain');
  assert.deepEqual(deleteCalls, [{ modelId: TARGET_MODEL_ID, branchName }]);

  closeJobStoreForTests();
  const recovered = getJob(scratch.id)!;
  assert.equal(
    recovered.items.find((item) => item.kind === 'model_branch_create')?.details?.migrationMutationBranchId,
    branchId,
  );
  cleanupPhase = true;
  const resumed = resumeDestinationModelMutationReconciliation();
  assert.deepEqual(resumed, [`${scratch.id}:${lease!.itemId}`]);
  await waitForLeaseState(scratch.id, 'resolved');

  assert.deepEqual(deleteCalls, [
    { modelId: TARGET_MODEL_ID, branchName },
    { modelId: TARGET_MODEL_ID, branchName },
  ]);
  assert.equal(branchExists, false);
  assert.equal(getJob(scratch.id)?.details?.scratchCleanupState, 'resolved_after_restart');
});

test('vault unlock resumes one exact external refresh and resolves its durable lease', async (t) => {
  const { destination } = saveInstances();
  let reconciliationPhase = false;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => ({
    jobId: EXTERNAL_JOB_ID,
    status: 'RUNNING',
    raw: {},
  }));
  const observedStatusJobIds: string[] = [];
  t.mock.method(OmniClient.prototype, 'getJobStatus', async (externalJobId: string) => {
    observedStatusJobIds.push(externalJobId);
    if (!reconciliationPhase) throw new Error('Fictional transient status read failure.');
    return { jobId: externalJobId, status: 'COMPLETED', raw: {} };
  });

  const initial = await runTrackedSchemaRefresh(destination.id, TARGET_MODEL_ID, 'Durable target model');
  const jobId = initial.trackingJobId;
  const uncertainLease = await waitForLeaseState(jobId, 'uncertain');
  assert.equal(initial.terminal, false);
  assert.equal(migrationDestinationModelMutationLease(uncertainLease)?.externalJobId, EXTERNAL_JOB_ID);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([getJob(jobId)!], exactScope()), true);

  lockVault();
  reconciliationPhase = true;

  const response = await vaultHandler(new Request('http://localhost/api/vault/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'durable mutation test passphrase' }),
  }));
  assert.equal(response.status, 200);
  const resolvedLease = await waitForLeaseState(jobId, 'resolved');
  const reconciled = getJob(jobId)!;
  const reconciledAction = reconciled.items.find((item) => item.kind === 'post_action');

  assert.deepEqual(observedStatusJobIds, [EXTERNAL_JOB_ID, EXTERNAL_JOB_ID]);
  assert.equal(migrationDestinationModelMutationLease(resolvedLease)?.externalJobId, EXTERNAL_JOB_ID);
  assert.equal(reconciledAction?.status, 'succeeded');
  assert.equal(reconciledAction?.details?.migrationMutationTerminal, true);
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([reconciled], exactScope()), false);
});

test('legacy source deletion dispatches durable ownership for the exact source base-model scope', async (t) => {
  const { source, destination } = saveInstances();
  const sourceModelId = 'fictional-source-base-model';
  mockLegacyDashboardHappyPath(t, {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceModelId,
  });

  let observedDeleteLease: ReturnType<typeof migrationDestinationModelMutationLease>;
  t.mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument(documentId: string) {
    const instanceId = (this as unknown as { instance: { id: string } }).instance.id;
    assert.equal(instanceId, source.id);
    assert.equal(documentId, 'fictional-dashboard');
    const running = listJobs().find((job) => job.details?.operationMode === 'copy_import');
    const leaseItem = running?.items.find((item) => {
      const lease = migrationDestinationModelMutationLease(item);
      return lease?.destinationInstanceId === source.id && lease.targetModelId === sourceModelId;
    });
    observedDeleteLease = leaseItem ? migrationDestinationModelMutationLease(leaseItem) : undefined;
  });

  const created = await createMigrationJob({
    sourceId: source.id,
    targets: [{
      id: 'fictional-target',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
    }],
    documentIds: ['fictional-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    documentAccessPolicy: 'destination_defaults',
    postMigrationActions: [],
  });
  const completed = await waitForTerminalJob(created.id);
  const sourceDelete = completed.items.find((item) => item.kind === 'source_delete');
  const sourceLeaseItem = completed.items.find((item) => {
    const lease = migrationDestinationModelMutationLease(item);
    return lease?.destinationInstanceId === source.id && lease.targetModelId === sourceModelId;
  });

  assert.equal(sourceDelete?.status, 'succeeded');
  assert.equal(observedDeleteLease?.state, 'dispatched');
  assert.equal(observedDeleteLease?.destinationInstanceId, source.id);
  assert.equal(observedDeleteLease?.targetModelId, sourceModelId);
  assert.equal(migrationDestinationModelMutationLease(sourceLeaseItem!)?.state, 'resolved');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation(
    [completed],
    exactScope(sourceModelId, source.id),
  ), false);
});

test('an ambiguous destination folder move leaves the exact durable lease uncertain', async (t) => {
  const { source, destination } = saveInstances();
  mockLegacyDashboardHappyPath(t, {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceModelId: 'fictional-source-model',
  });
  let observedMoveState: string | undefined;
  t.mock.method(OmniClient.prototype, 'moveDocument', async () => {
    const running = listJobs().find((job) => job.details?.operationMode === 'copy_import');
    const leaseItem = running?.items.find((item) => {
      const lease = migrationDestinationModelMutationLease(item);
      return lease?.destinationInstanceId === destination.id && lease.targetModelId === TARGET_MODEL_ID;
    });
    observedMoveState = leaseItem ? migrationDestinationModelMutationLease(leaseItem)?.state : undefined;
    throw new Error('Fictional lost move response.');
  });

  const created = await createMigrationJob({
    sourceId: source.id,
    targets: [{
      id: 'fictional-target',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
      targetFolderPath: 'Exact target folder',
    }],
    documentIds: ['fictional-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    documentAccessPolicy: 'destination_defaults',
    postMigrationActions: [],
  });
  const completed = await waitForTerminalJob(created.id);
  const importItem = completed.items.find((item) => item.kind === 'import');
  const leaseItem = completed.items.find((item) => item.kind === 'destination_model_mutation');

  assert.equal(observedMoveState, 'dispatched');
  assert.equal(importItem?.status, 'failed');
  assert.match(importItem?.error || '', /Folder move outcome is uncertain/);
  assert.equal(migrationDestinationModelMutationLease(leaseItem!)?.state, 'uncertain');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([completed], exactScope()), true);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([completed], exactScope('sibling-model')), false);
});

test('an ambiguous metadata write re-dispatches a resolved import lease and leaves it uncertain', async (t) => {
  const { source, destination } = saveInstances();
  mockLegacyDashboardHappyPath(t, {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceModelId: 'fictional-source-model',
    description: 'Fictional source dashboard description',
  });
  let observedMetadataState: string | undefined;
  t.mock.method(OmniClient.prototype, 'patchDocument', async () => {
    const running = listJobs().find((job) => job.details?.operationMode === 'copy_import');
    const leaseItem = running?.items.find((item) => {
      const lease = migrationDestinationModelMutationLease(item);
      return lease?.destinationInstanceId === destination.id && lease.targetModelId === TARGET_MODEL_ID;
    });
    observedMetadataState = leaseItem ? migrationDestinationModelMutationLease(leaseItem)?.state : undefined;
    throw new Error('Fictional lost metadata response.');
  });

  const created = await createMigrationJob({
    sourceId: source.id,
    targets: [{
      id: 'fictional-target',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
    }],
    documentIds: ['fictional-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    documentAccessPolicy: 'destination_defaults',
    postMigrationActions: [],
  });
  const completed = await waitForTerminalJob(created.id);
  const importItem = completed.items.find((item) => item.kind === 'import');
  const metadataItem = completed.items.find((item) => item.kind === 'metadata');
  const leaseItem = completed.items.find((item) => item.kind === 'destination_model_mutation');

  assert.equal(importItem?.status === 'succeeded' || importItem?.status === 'warning', true);
  assert.equal(importItem?.importedIdentifier, 'fictional-imported-dashboard');
  assert.equal(importItem?.importedDocumentId, 'fictional-imported-dashboard-id');
  assert.equal(observedMetadataState, 'dispatched');
  assert.equal(metadataItem?.status, 'failed');
  assert.match(metadataItem?.error || '', /Description copy outcome is uncertain/);
  assert.equal(migrationDestinationModelMutationLease(leaseItem!)?.state, 'uncertain');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([completed], exactScope()), true);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([completed], exactScope('sibling-model')), false);
});

test('a legacy field-preparation YAML write is dispatched before Omni and restart keeps the exact scope unresolved', async (t) => {
  const { source, destination } = saveInstances();
  const unexpectedUrls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    unexpectedUrls.push(String(input));
    throw new Error(`Unexpected fictional tenant request: ${String(input)}`);
  });
  const sourceYaml = [
    'dimensions:',
    '  amount:',
    '    sql: ${TABLE}.amount',
    'measures:',
    '  fictional_total:',
    '    sql: ${fictional_orders.amount}',
    '    aggregate_type: sum',
  ].join('\n');
  const targetYaml = [
    'dimensions:',
    '  amount:',
    '    sql: ${TABLE}.amount',
    'measures:',
    '  existing_total:',
    '    sql: ${fictional_orders.amount}',
    '    aggregate_type: sum',
  ].join('\n');
  t.mock.method(OmniClient.prototype, 'getDocumentStateV2', async (documentId: string) => {
    assert.equal(documentId, 'fictional-prep-dashboard');
    return { modelId: 'fictional-source-model', workbookModelId: 'fictional-source-workbook' };
  });
  t.mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    const label = (this as unknown as { instance: { label: string } }).instance.label;
    return label === source.label
      ? [{
          id: 'fictional-prep-dashboard-id',
          identifier: 'fictional-prep-dashboard',
          name: 'Fictional prep dashboard',
          baseModelId: 'fictional-source-model',
        }]
      : [];
  });
  t.mock.method(OmniClient.prototype, 'listDocumentAccess', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserAttributes', async () => []);
  t.mock.method(OmniClient.prototype, 'listIdentityUsers', async () => []);
  t.mock.method(OmniClient.prototype, 'listUserGroups', async () => []);
  t.mock.method(OmniClient.prototype, 'listModelTopics', async () => []);
  t.mock.method(OmniClient.prototype, 'listModelQueryViews', async () => []);
  t.mock.method(OmniClient.prototype, 'listLabels', async () => []);
  t.mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: TARGET_MODEL_ID,
    name: 'Durable target model',
  }]);
  t.mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    const label = (this as unknown as { instance: { label: string } }).instance.label;
    return label === source.label
      ? { 'fictional_orders.view': sourceYaml }
      : { 'fictional_orders.view': targetYaml };
  });
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(
    modelId: string,
    options: { includeChecksums?: boolean; fullyResolved?: boolean; mode?: string } = {},
  ) {
    const label = (this as unknown as { instance: { label: string } }).instance.label;
    if (modelId === 'fictional-source-workbook') {
      assert.equal(label, source.label);
      assert.equal(options.fullyResolved, false);
      assert.equal(options.mode, 'extension');
      return { files: {}, raw: { modelId } };
    }
    return label === source.label
      ? {
          files: { 'fictional_orders.view': sourceYaml },
          checksums: options.includeChecksums ? { 'fictional_orders.view': 'fictional-source-checksum' } : undefined,
          raw: { modelId },
        }
      : {
          files: { 'fictional_orders.view': targetYaml },
          checksums: options.includeChecksums ? { 'fictional_orders.view': 'fictional-target-checksum' } : undefined,
          raw: { modelId },
        };
  });
  t.mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  t.mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'fictional-source-model',
    tiles: [{ fields: ['fictional_orders.fictional_total'] }],
  }));

  let allowWriteFailure!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    allowWriteFailure = resolve;
  });
  let observedLeaseState: string | undefined;
  let observedExactHold = false;
  let signalWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  t.mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    const running = listJobs()[0];
    const lease = running?.items.find((item) => item.kind === 'destination_model_mutation');
    observedLeaseState = lease ? migrationDestinationModelMutationLease(lease)?.state : undefined;
    observedExactHold = Boolean(running && hasUnresolvedMigrationDestinationModelMutation([running], exactScope()));
    signalWriteStarted();
    await writeGate;
    throw new Error('Fictional process interruption after dispatch.');
  });

  const created = await createMigrationJob({
    sourceId: source.id,
    targets: [{
      id: 'fictional-prep-target',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
      fieldMappings: [{
        sourceFieldRef: 'fictional_orders.fictional_total',
        action: 'create_from_source',
        sourceFileName: 'fictional_orders.view',
        targetFileName: 'fictional_orders.view',
      }],
    }],
    documentIds: ['fictional-prep-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    documentAccessPolicy: 'destination_defaults',
    postMigrationActions: [],
  });

  await writeStarted;
  let recovered!: MigrationJob;
  try {
    closeJobStoreForTests();
    recovered = getJob(created.id)!;
  } finally {
    allowWriteFailure();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const recoveredLease = recovered.items.find((item) => item.kind === 'destination_model_mutation');
  assert.equal(observedLeaseState, 'dispatched');
  assert.equal(observedExactHold, true);
  assert.equal(migrationDestinationModelMutationLease(recoveredLease!)?.state, 'uncertain');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([recovered], exactScope()), true);
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([recovered], exactScope('sibling-model')), false);
  assert.deepEqual(unexpectedUrls, []);
});

test('a legacy dashboard parent refresh polls its external job before completing', async (t) => {
  const { source, destination } = saveInstances();
  const observedStatusJobIds: string[] = [];
  mockLegacyDashboardHappyPath(t, {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceModelId: 'fictional-source-model',
  });
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => ({
    jobId: EXTERNAL_JOB_ID,
    status: 'RUNNING',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    observedStatusJobIds.push(jobId);
    return { jobId, status: 'COMPLETED', raw: {} };
  });

  const created = await createMigrationJob({
    sourceId: source.id,
    targets: [{
      id: 'fictional-target',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
    }],
    documentIds: ['fictional-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    documentAccessPolicy: 'destination_defaults',
    postMigrationActions: [{
      kind: 'refresh-schema',
      name: 'Refresh fictional target model',
      method: 'POST',
      url: '',
      headers: {},
      body: '',
      destinationInstanceId: destination.id,
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Durable target model',
    }],
  });
  const completed = await waitForTerminalJob(created.id);
  const refresh = completed.items.find((item) => item.kind === 'post_action');
  const lease = completed.items.find((item) => item.kind === 'destination_model_mutation');

  assert.deepEqual(observedStatusJobIds, [EXTERNAL_JOB_ID]);
  assert.equal(refresh?.status, 'succeeded');
  assert.equal(refresh?.details?.migrationMutationTerminal, true);
  assert.equal(migrationDestinationModelMutationLease(lease!)?.state, 'resolved');
  assert.equal(hasUnresolvedMigrationDestinationModelMutation([completed], exactScope()), false);
});
