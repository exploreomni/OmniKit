import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instanceDashboardHandler from '../server/handlers/instance-dashboard';
import migrationJobsHandler from '../server/handlers/migration-jobs';
import vaultHandler from '../server/handlers/vault';
import {
  createDashboardSafeCopyJob,
} from '../server/services/dashboardSafeCopyJobs';
import { sanitizeJobHistory } from '../server/services/jobSanitizer';
import {
  createMigrationJob,
  type MigrationJob,
} from '../server/services/migrationJobs';
import {
  closeJobStoreForTests,
  getJob,
  insertJob,
  listJobs,
} from '../server/services/jobStore';
import {
  migrationDestinationModelMutationLease,
  migrationJobHasUnresolvedDestinationModelMutation,
} from '../server/services/migrationScopeReservation';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
  vaultStatus,
} from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';
import { parseDashboardSafeCopyIntent } from '../shared/dashboardSafeCopyContract';

const PASSPHRASE = 'migration mutation action test passphrase';
const DESTINATION_ID = 'mutation-destination';
const MODEL_ID = 'mutation-model';
let temporaryRoot = '';

function emptyMetricFilter() {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

function saveInstance(id: string, role: 'source' | 'destination' | 'both'): void {
  upsertInstance({
    id,
    label: `Example ${id}`,
    role,
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey: `${id}-credential`,
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForJob(
  jobId: string,
  predicate: (job: MigrationJob) => boolean,
): Promise<MigrationJob> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = getJob(jobId);
    if (job && predicate(job)) return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const latest = getJob(jobId);
  throw new Error(`Timed out waiting for migration job ${jobId}: ${JSON.stringify({
    status: latest?.status,
    items: latest?.items.map((item) => ({ kind: item.kind, status: item.status, error: item.error })),
  })}`);
}

function mutationLease(job: MigrationJob) {
  const leases = job.items
    .map(migrationDestinationModelMutationLease)
    .filter((lease): lease is NonNullable<typeof lease> => Boolean(lease));
  assert.equal(leases.length, 1);
  return leases[0];
}

function refreshAction() {
  return {
    kind: 'refresh-schema',
    name: 'Refresh example target model',
    method: 'POST',
    url: '',
    headers: {},
    body: '',
    destinationInstanceId: DESTINATION_ID,
    targetModelId: MODEL_ID,
    targetModelName: 'Example target model',
  };
}

function actionRunRequest(): Request {
  return new Request('http://localhost/api/migration-jobs/actions/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions: [refreshAction()] }),
  });
}

function instanceRefreshRequest(): Request {
  return new Request(`http://localhost/api/instance-dashboard/${DESTINATION_ID}/refresh-schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: MODEL_ID }),
  });
}

function mutationFixture(externalJobId: string): MigrationJob {
  const now = 1_760_000_000_000;
  return {
    id: 'mutation-sanitizer-job',
    workflow: 'model',
    sourceId: DESTINATION_ID,
    sourceLabel: 'Example destination owner@example.test',
    destinationIds: [DESTINATION_ID],
    targets: [{
      id: `${DESTINATION_ID}:${MODEL_ID}`,
      destinationInstanceId: DESTINATION_ID,
      destinationLabel: 'Example destination owner@example.test',
      targetModelId: MODEL_ID,
    }],
    documentIds: [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'failed',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    details: { operationMode: 'schema_refresh' },
    items: [{
      id: 'destination-model-mutation:exact-external-job-id',
      jobId: 'mutation-sanitizer-job',
      destinationId: DESTINATION_ID,
      destinationLabel: 'Example destination owner@example.test',
      targetModelId: MODEL_ID,
      kind: 'destination_model_mutation',
      status: 'warning',
      startedAt: now,
      endedAt: now,
      details: {
        migrationDestinationModelMutation: true,
        migrationMutationState: 'uncertain',
        migrationMutationOperation: 'schema_refresh',
        migrationMutationUpdatedAt: now,
        migrationMutationExternalJobId: externalJobId,
      },
    }],
  };
}

function unresolvedSafeCopyJob(): MigrationJob {
  const now = 1_760_000_000_100;
  return {
    id: 'safe-copy-source-a-job',
    workflow: 'dashboard',
    sourceId: 'safe-copy-source-a',
    sourceLabel: 'Safe-copy source A',
    sourceConnectionId: 'source-connection-a',
    destinationIds: [DESTINATION_ID],
    targets: [{
      id: 'safe-copy-target-a',
      destinationInstanceId: DESTINATION_ID,
      destinationLabel: 'Example destination',
      targetConnectionId: 'destination-connection',
      targetModelId: MODEL_ID,
      targetFolderId: 'destination-folder',
    }],
    documentIds: ['source-document-a'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'failed',
    createdAt: now,
    endedAt: now,
    details: {
      operationMode: 'safe_copy',
      safeCopyProfile: 'safe_copy_v1',
      safeCopyRequestId: '11111111-1111-4111-8111-111111111111',
      safeCopyIntentHash: 'a'.repeat(64),
      safeCopyPreparationState: 'failed',
    },
    items: [{
      id: 'safe-copy-attempt:source-a-attempt',
      jobId: 'safe-copy-source-a-job',
      targetId: 'safe-copy-target-a',
      destinationId: DESTINATION_ID,
      destinationLabel: 'Example destination',
      targetModelId: MODEL_ID,
      targetFolderId: 'destination-folder',
      kind: 'import',
      documentId: 'source-document-a',
      status: 'warning',
      startedAt: now,
      endedAt: now,
      details: {
        safeCopyAttempt: true,
        safeCopyAttemptState: 'uncertain',
        safeCopyAttemptUpdatedAt: now,
        safeCopySourceDocumentId: 'source-document-a',
        safeCopyDestinationInstanceId: DESTINATION_ID,
        safeCopyConnectionId: 'destination-connection',
        safeCopyModelId: MODEL_ID,
        safeCopyFolderId: 'destination-folder',
      },
    }],
  };
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-mutation-actions-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  closeJobStoreForTests();
  resetVault();
  unlockVault(PASSPHRASE);
  saveInstance(DESTINATION_ID, 'destination');
});

afterEach(() => {
  mock.restoreAll();
  resetVault();
  lockVault();
  closeJobStoreForTests();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

test('direct actions persist the mutation claim before Omni, track RUNNING to COMPLETE, and release only at terminal', async () => {
  const externalJobId = 'refresh-job-running-to-complete';
  const firstPollEntered = deferred();
  const allowFirstPoll = deferred();
  let refreshCalls = 0;
  let statusCalls = 0;

  mock.method(OmniClient.prototype, 'refreshModel', async (modelId: string) => {
    refreshCalls += 1;
    assert.equal(modelId, MODEL_ID);
    const active = listJobs(Number.MAX_SAFE_INTEGER).find((job) => job.details?.operationMode === 'schema_refresh');
    assert.ok(active, 'tracking job must be durable before the Omni mutation call');
    assert.equal(active.status, 'running');
    assert.equal(active.items.find((item) => item.kind === 'post_action')?.status, 'running');
    assert.equal(mutationLease(active).state, 'dispatched');
    return refreshCalls === 1
      ? { jobId: externalJobId, status: 'RUNNING', raw: {} }
      : { jobId: 'refresh-job-after-terminal', status: 'COMPLETED', raw: {} };
  });
  mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    statusCalls += 1;
    assert.equal(jobId, externalJobId);
    if (statusCalls === 1) {
      const active = listJobs(Number.MAX_SAFE_INTEGER).find((job) => (
        mutationDestinationExternalId(job) === externalJobId
      ));
      assert.ok(active);
      assert.equal(mutationLease(active).state, 'remote_pending');
      firstPollEntered.resolve();
      await allowFirstPoll.promise;
      return { jobId, status: 'RUNNING', raw: {} };
    }
    return { jobId, status: 'COMPLETED', raw: {} };
  });

  const request = migrationJobsHandler(actionRunRequest());
  await firstPollEntered.promise;

  const inFlight = listJobs(Number.MAX_SAFE_INTEGER).find((job) => (
    mutationDestinationExternalId(job) === externalJobId
  ));
  assert.ok(inFlight);
  assert.equal(mutationLease(inFlight).state, 'remote_pending');
  assert.equal(mutationLease(inFlight).externalJobId, externalJobId);

  const competing = await instanceDashboardHandler(instanceRefreshRequest());
  assert.equal(competing.status, 409, 'the exact destination-model scope remains reserved while Omni is RUNNING');

  allowFirstPoll.resolve();
  const response = await request;
  assert.equal(response.status, 200);
  const body = await response.json() as {
    results: Array<{ ok: boolean; terminal: boolean; externalJobId?: string; trackingJobId: string }>;
  };
  assert.equal(body.results[0]?.ok, true);
  assert.equal(body.results[0]?.terminal, true);
  assert.equal(body.results[0]?.externalJobId, externalJobId);
  assert.equal(statusCalls, 2);

  const completed = getJob(body.results[0]!.trackingJobId)!;
  assert.equal(completed.status, 'succeeded');
  assert.equal(mutationLease(completed).state, 'resolved');
  assert.equal(mutationLease(completed).externalJobId, externalJobId);
  assert.equal(completed.items.find((item) => item.kind === 'post_action')?.details?.migrationMutationTerminal, true);

  const afterTerminal = await instanceDashboardHandler(instanceRefreshRequest());
  assert.equal(afterTerminal.status, 200, 'the exact scope is released only after a terminal result is persisted');
  const afterTerminalBody = await afterTerminal.json() as { status: string };
  assert.equal(afterTerminalBody.status, 'COMPLETE');
});

function mutationDestinationExternalId(job: MigrationJob): string | undefined {
  return job.items.find((item) => item.details?.migrationDestinationModelMutation === true)
    ?.details?.migrationMutationExternalJobId as string | undefined;
}

test('instance refresh accepted as RUNNING without a job id stays uncertain and blocks history clear', async () => {
  let statusCalls = 0;
  mock.method(OmniClient.prototype, 'refreshModel', async () => {
    const active = listJobs(Number.MAX_SAFE_INTEGER).find((job) => job.details?.operationMode === 'schema_refresh');
    assert.ok(active, 'claim must be persisted before calling refreshModel');
    assert.equal(mutationLease(active).state, 'dispatched');
    return { status: 'RUNNING', raw: {} };
  });
  mock.method(OmniClient.prototype, 'getJobStatus', async () => {
    statusCalls += 1;
    return { jobId: 'unexpected', status: 'COMPLETED', raw: {} };
  });

  const response = await instanceDashboardHandler(instanceRefreshRequest());
  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    status: string;
    jobId?: string;
    trackingJobId: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.status, 'RECONCILIATION_REQUIRED');
  assert.equal(body.jobId, undefined);
  assert.equal(statusCalls, 0);

  const uncertain = getJob(body.trackingJobId)!;
  assert.equal(uncertain.status, 'failed');
  assert.equal(mutationLease(uncertain).state, 'uncertain');
  assert.equal(mutationLease(uncertain).externalJobId, undefined);
  assert.equal(migrationJobHasUnresolvedDestinationModelMutation(uncertain), true);

  const clear = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs', {
    method: 'DELETE',
  }));
  assert.equal(clear.status, 409);
  const clearBody = await clear.json() as { code: string };
  assert.equal(clearBody.code, 'MIGRATION_LEDGER_ACTIVE');
  assert.ok(getJob(body.trackingJobId), 'unresolved history must remain durable');
});

test('vault unlock reconciles the exact durable external job id before releasing the destination model', async () => {
  const externalJobId = 'refresh-job-reconciled-after-unlock';
  let reconciliationMayComplete = false;
  const polledJobIds: string[] = [];
  mock.method(OmniClient.prototype, 'refreshModel', async () => ({
    jobId: externalJobId,
    status: 'RUNNING',
    raw: {},
  }));
  mock.method(OmniClient.prototype, 'getJobStatus', async (jobId: string) => {
    polledJobIds.push(jobId);
    if (!reconciliationMayComplete) throw new Error('Temporary job-status read failure.');
    return { jobId, status: 'COMPLETED', raw: {} };
  });

  const first = await instanceDashboardHandler(instanceRefreshRequest());
  const firstBody = await first.json() as { status: string; jobId?: string; trackingJobId: string };
  assert.equal(firstBody.status, 'RECONCILIATION_REQUIRED');
  assert.equal(firstBody.jobId, externalJobId);
  assert.equal(mutationLease(getJob(firstBody.trackingJobId)!).state, 'uncertain');
  assert.equal(mutationLease(getJob(firstBody.trackingJobId)!).externalJobId, externalJobId);

  closeJobStoreForTests();
  const durable = getJob(firstBody.trackingJobId)!;
  assert.equal(mutationLease(durable).externalJobId, externalJobId);
  lockVault();
  reconciliationMayComplete = true;

  const unlock = await vaultHandler(new Request('http://localhost/api/vault/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASSPHRASE }),
  }));
  assert.equal(unlock.status, 200);

  const reconciled = await waitForJob(firstBody.trackingJobId, (job) => (
    mutationLease(job).state === 'resolved' && job.status === 'succeeded'
  ));
  assert.equal(mutationLease(reconciled).externalJobId, externalJobId);
  assert.equal(reconciled.items.find((item) => item.kind === 'post_action')?.details?.migrationMutationExternalJobId, externalJobId);
  assert.equal(reconciled.items.find((item) => item.kind === 'post_action')?.details?.migrationMutationTerminal, true);
  assert.deepEqual(polledJobIds, [externalJobId, externalJobId]);

  const afterReconciliation = await instanceDashboardHandler(instanceRefreshRequest());
  assert.equal(afterReconciliation.status, 200);
});

test('mutation external job identifiers survive sanitizer and durable-store round trips exactly', () => {
  const externalJobId = 'external-job::646-555-0101::owner@example.test';
  const fixture = mutationFixture(externalJobId);
  const sanitized = sanitizeJobHistory([fixture])[0]!;
  assert.equal(mutationLease(sanitized).externalJobId, externalJobId);

  insertJob(fixture);
  closeJobStoreForTests();
  const restored = getJob(fixture.id)!;
  assert.equal(mutationLease(restored).externalJobId, externalJobId);
});

test('safe copy rejects an unresolved destination-model attempt owned by a different source', () => {
  saveInstance('safe-copy-source-a', 'source');
  saveInstance('safe-copy-source-b', 'source');
  insertJob(unresolvedSafeCopyJob());

  const secondSourceIntent = parseDashboardSafeCopyIntent({
    profile: 'safe_copy_v1',
    requestId: '22222222-2222-4222-8222-222222222222',
    source: {
      instanceId: 'safe-copy-source-b',
      connectionId: 'source-connection-b',
      documentIds: ['source-document-b'],
    },
    destinations: [{
      targetId: 'safe-copy-target-b',
      instanceId: DESTINATION_ID,
      connectionId: 'destination-connection',
      modelId: MODEL_ID,
      folderId: 'destination-folder',
    }],
  });

  assert.throws(
    () => createDashboardSafeCopyJob(secondSourceIntent, { prepare() {} }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'SAFE_COPY_SCOPE_CONFLICT'
      && (error as { statusCode?: unknown }).statusCode === 409
    ),
  );
  assert.deepEqual(listJobs(Number.MAX_SAFE_INTEGER).map((job) => job.id), ['safe-copy-source-a-job']);
});

test('vault reset refuses an unresolved durable migration mutation lease', async () => {
  const fixture = mutationFixture('refresh-job-awaiting-reconciliation');
  insertJob(fixture);

  const response = await vaultHandler(new Request('http://localhost/api/vault/reset', {
    method: 'DELETE',
  }));
  assert.equal(response.status, 409);
  const body = await response.json() as { code?: string };
  assert.equal(body.code, 'MIGRATION_LEDGER_ACTIVE');
  assert.equal(vaultStatus().unlocked, true);
  assert.equal(vaultStatus().instanceCount, 1);
  assert.equal(mutationLease(getJob(fixture.id)!).state, 'uncertain');
});

test('vault reset refuses an unresolved durable safe-copy attempt lease', async () => {
  const fixture = unresolvedSafeCopyJob();
  insertJob(fixture);

  const response = await vaultHandler(new Request('http://localhost/api/vault/reset', {
    method: 'DELETE',
  }));
  assert.equal(response.status, 409);
  const body = await response.json() as { code?: string };
  assert.equal(body.code, 'MIGRATION_LEDGER_ACTIVE');
  assert.equal(vaultStatus().unlocked, true);
  assert.equal(vaultStatus().instanceCount, 1);
  assert.equal(getJob(fixture.id)?.items[0]?.details?.safeCopyAttemptState, 'uncertain');
});

test('standalone actions reject mutating webhooks before fetch or job creation', async () => {
  let fetchCalls = 0;
  mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  });

  const response = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs/actions/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: [{
        kind: 'webhook',
        name: 'Mutating example hook',
        method: 'POST',
        url: 'https://93.184.216.34/example-hook',
        headers: { 'X-Example': 'yes' },
        body: '{"run":true}',
      }],
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json() as { results: Array<{ ok: boolean; error?: string }> };
  assert.equal(body.results[0]?.ok, false);
  assert.equal(
    body.results[0]?.error,
    'Mutating webhook post-actions are disabled because their remote outcome cannot be reconciled safely after a lost response.',
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(listJobs(Number.MAX_SAFE_INTEGER), []);
});

test('automatic parent jobs record mutating webhooks as skipped before fetch', async () => {
  saveInstance('mutation-source', 'source');
  let fetchCalls = 0;
  let imported = false;
  mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async (documentId: string) => {
    assert.equal(documentId, 'mutation-source-document');
    return { modelId: 'mutation-source-model', workbookModelId: 'mutation-source-workbook' };
  });
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    const instanceId = (this as unknown as { instance: { id: string } }).instance.id;
    if (instanceId === 'mutation-source') {
      return [{
        id: 'mutation-source-document',
        identifier: 'mutation-source-document',
        name: 'Example source dashboard',
        folderPath: 'Source',
        baseModelId: 'mutation-source-model',
      }];
    }
    return imported
      ? [{
          id: 'mutation-imported-document',
          identifier: 'mutation-imported-document',
          name: 'Example source dashboard',
          folderPath: 'Destination',
          baseModelId: MODEL_ID,
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: MODEL_ID, name: 'Example target model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'example.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'getModelYaml', async (
    modelId: string,
    options: { fullyResolved?: boolean; mode?: string } = {},
  ) => {
    if (modelId === 'mutation-source-workbook') {
      assert.equal(options.fullyResolved, false);
      assert.equal(options.mode, 'extension');
      return { files: {}, checksums: {}, raw: {} };
    }
    return {
      files: { 'example.view': 'dimensions:\n  id:\n' },
      checksums: {},
      raw: {},
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => []);
  mock.method(OmniClient.prototype, 'listDocumentAccess', async () => []);
  mock.method(OmniClient.prototype, 'listUserAttributes', async () => []);
  mock.method(OmniClient.prototype, 'listIdentityUsers', async () => []);
  mock.method(OmniClient.prototype, 'listUserGroups', async () => []);
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'validateModel', async () => []);
  mock.method(OmniClient.prototype, 'validateModelContent', async () => ({ issues: [] }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'mutation-source-model',
    tiles: [{ fields: ['example.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    imported = true;
    return {
      identifier: 'mutation-imported-document',
      documentId: 'mutation-imported-document',
    };
  });
  mock.method(OmniClient.prototype, 'moveDocument', async () => undefined);

  const created = await createMigrationJob({
    sourceId: 'mutation-source',
    sourceConnectionId: 'mutation-source-connection',
    targets: [{
      id: 'mutation-target',
      destinationInstanceId: DESTINATION_ID,
      targetConnectionId: 'mutation-destination-connection',
      targetModelId: MODEL_ID,
      targetFolderPath: 'Destination',
    }],
    documentIds: ['mutation-source-document'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [{
      kind: 'webhook',
      name: 'Mutating automatic example hook',
      method: 'PATCH',
      url: 'https://93.184.216.34/example-hook',
      headers: { 'X-Example': 'yes' },
      body: '{"run":true}',
      destinationInstanceId: DESTINATION_ID,
    }],
  });
  const completed = await waitForJob(created.id, (job) => (
    ['succeeded', 'partial', 'failed', 'canceled'].includes(job.status)
  ));
  const actionItems = completed.items.filter((item) => item.kind === 'post_action');
  assert.equal(actionItems.length, 1);
  assert.equal(actionItems[0]?.jobId, completed.id);
  assert.equal(actionItems[0]?.status, 'skipped');
  assert.equal(
    actionItems[0]?.error,
    'Mutating webhook post-actions are disabled because their remote outcome cannot be reconciled safely after a lost response.',
  );
  assert.equal(actionItems[0]?.details?.noMutation, true);
  assert.equal(fetchCalls, 0);
});
