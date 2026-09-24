import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';

import { migrationJobsHandler } from '../server/handlers/migration-jobs';
import {
  adjudicateDestinationModelMutation,
  DestinationModelMutationAdjudicationError,
  getJob,
  retryMigrationJob,
  runTrackedSchemaRefresh,
  type DestinationModelMutationAdjudicationInput,
  type MigrationJob,
  type MigrationJobItem,
  type ModelMigrationJobInput,
} from '../server/services/migrationJobs';
import { closeJobStoreForTests, insertJob } from '../server/services/jobStore';
import {
  migrationDestinationModelMutationLease,
  reserveMigrationDestinationModels,
  type MigrationDestinationModelMutationLease,
} from '../server/services/migrationScopeReservation';
import {
  lockVault,
  deleteInstance,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import {
  OmniClient,
  resetOmniClientRateLimitStateForTests,
} from '../server/services/omniClient';

const DESTINATION_ID = 'adjudication-destination';
const TARGET_MODEL_ID = 'adjudication-target-model';
const SIBLING_MODEL_ID = 'adjudication-sibling-model';
const SOURCE_ID = 'adjudication-source';
const SOURCE_MODEL_ID = 'adjudication-source-model';
const REQUEST_ID = 'a1000000-0000-4000-8000-000000000001';
const SENSITIVE_NOTE = 'Inspected bearer rawSecretToken and api_key=rawApiSecret for operator@example.com.';

let temporaryRoot = '';

beforeEach(() => {
  resetOmniClientRateLimitStateForTests();
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-mutation-adjudication-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  closeJobStoreForTests();
  resetVault();
  unlockVault('mutation adjudication test passphrase');
  upsertInstance({
    id: SOURCE_ID,
    label: 'Adjudication source',
    role: 'source',
    baseUrl: 'https://adjudication-source.example.omniapp.co',
    apiKey: 'fictional-source-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: DESTINATION_ID,
    label: 'Adjudication destination',
    role: 'destination',
    baseUrl: 'https://adjudication-destination.example.omniapp.co',
    apiKey: 'fictional-destination-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
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

function uncertainLease(job: MigrationJob): MigrationDestinationModelMutationLease {
  const item = job.items.find((candidate) => candidate.kind === 'destination_model_mutation');
  assert.ok(item);
  const lease = migrationDestinationModelMutationLease(item);
  assert.ok(lease);
  assert.equal(lease.state, 'uncertain');
  assert.equal(typeof lease.revision, 'number');
  assert.equal(typeof lease.dispatchItemId, 'string');
  assert.equal(typeof lease.dispatchItemKind, 'string');
  assert.match(lease.dispatchFingerprint || '', /^[0-9a-f]{64}$/);
  return lease;
}

function adjudicationInput(
  lease: MigrationDestinationModelMutationLease,
  requestId = REQUEST_ID,
): DestinationModelMutationAdjudicationInput {
  return {
    requestId,
    itemId: lease.itemId,
    expectedRevision: lease.revision!,
    expectedUpdatedAt: lease.updatedAt,
    destinationInstanceId: lease.destinationInstanceId,
    targetModelId: lease.targetModelId,
    operation: lease.operation,
    dispatchItemId: lease.dispatchItemId!,
    dispatchItemKind: lease.dispatchItemKind!,
    dispatchFingerprint: lease.dispatchFingerprint!,
    outcome: 'verified_applied',
    evidenceSource: 'omni_ui',
    note: SENSITIVE_NOTE,
    confirmCurrentStateInspected: true,
    confirmNoOperationInFlight: true,
  };
}

function syntheticMutationJob(input: {
  id: string;
  workflow?: 'dashboard' | 'model';
  operation?: 'legacy_dashboard_job' | 'model_job';
  destinationInstanceId?: string;
  targetModelId?: string;
  dispatchKind?: MigrationJobItem['kind'];
  dispatchStatus?: MigrationJobItem['status'];
  leaseState?: 'dispatched' | 'uncertain';
  jobStatus?: MigrationJob['status'];
  retryInput?: ModelMigrationJobInput;
}): MigrationJob {
  const workflow = input.workflow || 'dashboard';
  const destinationInstanceId = input.destinationInstanceId || DESTINATION_ID;
  const targetModelId = input.targetModelId || TARGET_MODEL_ID;
  const dispatchKind = input.dispatchKind || (workflow === 'model' ? 'model_yaml_write' : 'import');
  const operation = input.operation || (workflow === 'model' ? 'model_job' : 'legacy_dashboard_job');
  const dispatchItemId = `${input.id}-dispatch`;
  const leaseItemId = `destination-model-mutation:${createHash('sha256')
    .update(`${input.id}\u0000${operation}\u0000${destinationInstanceId}\u0000${targetModelId}`)
    .digest('hex')}`;
  const updatedAt = 1_800_000_000_000;
  const dispatch: MigrationJobItem = {
    id: dispatchItemId,
    jobId: input.id,
    targetId: `${destinationInstanceId}:${targetModelId}`,
    destinationId: destinationInstanceId,
    destinationLabel: 'Synthetic mutation destination',
    targetModelId,
    targetModelName: 'Synthetic target model',
    kind: dispatchKind,
    documentId: workflow === 'dashboard' ? 'synthetic-dashboard' : undefined,
    documentName: workflow === 'dashboard' ? 'Synthetic dashboard' : undefined,
    status: input.dispatchStatus || 'failed',
    startedAt: updatedAt - 10,
    endedAt: input.dispatchStatus === 'running' ? undefined : updatedAt,
    error: input.dispatchStatus === 'running' ? undefined : 'Fictional lost mutation response.',
    details: { targetConnectionId: 'fictional-target-connection' },
  };
  const lease: MigrationJobItem = {
    id: leaseItemId,
    jobId: input.id,
    destinationId: destinationInstanceId,
    destinationLabel: 'Synthetic mutation destination',
    targetModelId,
    targetModelName: 'Synthetic target model',
    kind: 'destination_model_mutation',
    status: input.leaseState === 'dispatched' ? 'running' : 'warning',
    startedAt: updatedAt - 10,
    endedAt: input.leaseState === 'dispatched' ? undefined : updatedAt,
    error: input.leaseState === 'dispatched'
      ? undefined
      : 'A destination-model write outcome requires reconciliation before another workflow can use this model.',
    details: {
      migrationDestinationModelMutation: true,
      migrationMutationState: input.leaseState || 'uncertain',
      migrationMutationOperation: operation,
      migrationMutationUpdatedAt: updatedAt,
      migrationMutationRevision: 3,
      migrationMutationDispatchItemId: dispatchItemId,
      migrationMutationDispatchItemKind: dispatchKind,
      migrationMutationDispatchedAt: updatedAt - 5,
      migrationMutationDispatchFingerprint: 'd'.repeat(64),
    },
  };
  return {
    id: input.id,
    workflow,
    sourceId: SOURCE_ID,
    sourceLabel: 'Adjudication source',
    destinationIds: [DESTINATION_ID],
    targets: [{
      id: `${destinationInstanceId}:${targetModelId}`,
      destinationInstanceId,
      destinationLabel: 'Synthetic mutation destination',
      targetConnectionId: 'fictional-target-connection',
      targetModelId,
      targetModelName: 'Synthetic target model',
    }],
    documentIds: workflow === 'dashboard' ? ['synthetic-dashboard'] : [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: dispatchKind === 'source_delete',
    postMigrationActions: [],
    status: input.jobStatus || 'failed',
    createdAt: updatedAt - 20,
    startedAt: updatedAt - 15,
    endedAt: input.jobStatus === 'running' ? undefined : updatedAt,
    details: {
      operationMode: workflow === 'model' ? 'model_migration' : 'copy_import',
      ...(input.retryInput ? { retryInput: input.retryInput } : {}),
    },
    items: [dispatch, lease],
  };
}

async function waitForTerminalJob(jobId: string): Promise<MigrationJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = getJob(jobId);
    if (current && ['succeeded', 'partial', 'failed', 'canceled'].includes(current.status)) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job did not become terminal: ${getJob(jobId)?.status || 'missing'}`);
}

function mockLegacyRetryDependencies(t: TestContext): void {
  const workbookModelId = `${SOURCE_MODEL_ID}-workbook`;
  t.mock.method(OmniClient.prototype, 'getDocumentStateV2', async (documentId: string) => {
    assert.equal(documentId, 'synthetic-dashboard');
    return { modelId: SOURCE_MODEL_ID, workbookModelId };
  });
  t.mock.method(OmniClient.prototype, 'getModelYaml', async (
    modelId: string,
    options: { fullyResolved?: boolean; mode?: string } = {},
  ) => {
    assert.equal(options.fullyResolved, false);
    assert.equal(modelId, options.mode === 'extension' ? workbookModelId : SOURCE_MODEL_ID);
    return { files: {}, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    const instanceId = (this as unknown as { instance: { id: string } }).instance.id;
    return instanceId === SOURCE_ID
      ? [{
          id: 'synthetic-dashboard-id',
          identifier: 'synthetic-dashboard',
          name: 'Synthetic dashboard',
          baseModelId: SOURCE_MODEL_ID,
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
    sharedModelId: SOURCE_MODEL_ID,
    tiles: [],
  }));
  t.mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'retried-dashboard',
    documentId: 'retried-dashboard-id',
  }));
}

function modelRetryInput(): ModelMigrationJobInput {
  return {
    sourceId: SOURCE_ID,
    targetId: DESTINATION_ID,
    models: [{
      sourceModelId: SOURCE_MODEL_ID,
      sourceModelName: 'Synthetic source model',
      targetModelId: TARGET_MODEL_ID,
      targetModelName: 'Synthetic target model',
      targetConnectionId: 'fictional-target-connection',
      mode: 'fast',
      branchName: 'synthetic-retry-branch',
      fastPathSchemaConfirmed: true,
      orgApiKeyConfirmed: true,
    }],
    content: [],
    replaceSameNamed: false,
    mergeAfterValidation: false,
    publishDrafts: false,
    deleteBranch: false,
    postMigrationActions: [],
  };
}

function assertAdjudicationError(
  action: () => unknown,
  code: string,
  statusCode: number,
): void {
  assert.throws(action, (error: unknown) => (
    error instanceof DestinationModelMutationAdjudicationError
    && error.code === code
    && error.statusCode === statusCode
  ));
}

async function postAdjudication(jobId: string, body: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${jobId}/mutation-adjudications`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ));
  return { response, body: await response.json() as Record<string, unknown> };
}

test('service adjudication rejects unknown runtime fields before changing the lease or calling Omni', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });

  const refresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const before = getJob(refresh.trackingJobId)!;
  const input = adjudicationInput(uncertainLease(before));
  const inputWithUnknownField = {
    ...input,
    unsupportedField: 'reject-me',
  } as DestinationModelMutationAdjudicationInput;

  assertAdjudicationError(
    () => adjudicateDestinationModelMutation(before.id, inputWithUnknownField),
    'MIGRATION_MUTATION_ADJUDICATION_INVALID',
    400,
  );
  assert.equal(uncertainLease(getJob(before.id)!).itemId, input.itemId);
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);
});

test('service adjudication uses exact CAS, replays once, releases only its scope, redacts audit evidence, and performs no Omni write', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });

  const refresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const before = getJob(refresh.trackingJobId)!;
  const lease = uncertainLease(before);
  const input = adjudicationInput(lease);
  const owner = `schema-refresh:${before.id}`;
  const siblingScope = [{ destinationInstanceId: DESTINATION_ID, targetModelId: SIBLING_MODEL_ID }];
  const releaseSibling = reserveMigrationDestinationModels(owner, siblingScope);

  assertAdjudicationError(
    () => adjudicateDestinationModelMutation(before.id, { ...input, itemId: `${input.itemId}-other` }),
    'MIGRATION_MUTATION_ADJUDICATION_SCOPE_MISMATCH',
    409,
  );
  const alternateFingerprint = `${input.dispatchFingerprint[0] === 'a' ? 'b' : 'a'}${input.dispatchFingerprint.slice(1)}`;
  for (const changed of [
    { expectedRevision: input.expectedRevision + 1 },
    { expectedUpdatedAt: input.expectedUpdatedAt + 1 },
    { destinationInstanceId: 'other-destination' },
    { targetModelId: SIBLING_MODEL_ID },
    { operation: 'model_job' },
    { dispatchItemId: `${input.dispatchItemId}-other` },
    { dispatchItemKind: 'metadata' },
    { dispatchFingerprint: alternateFingerprint },
  ]) {
    assertAdjudicationError(
      () => adjudicateDestinationModelMutation(before.id, { ...input, ...changed }),
      'MIGRATION_MUTATION_ADJUDICATION_CAS_MISMATCH',
      409,
    );
    assert.equal(uncertainLease(getJob(before.id)!).revision, input.expectedRevision);
  }
  assertAdjudicationError(
    () => adjudicateDestinationModelMutation(before.id, {
      ...input,
      confirmNoOperationInFlight: false as true,
    }),
    'MIGRATION_MUTATION_ADJUDICATION_INVALID',
    400,
  );

  assert.throws(
    () => reserveMigrationDestinationModels('pre-adjudication-exact-probe', [lease]),
    /currently owns this destination model/,
  );
  assert.throws(
    () => reserveMigrationDestinationModels('pre-adjudication-sibling-probe', siblingScope),
    /currently owns this destination model/,
  );

  const resolved = adjudicateDestinationModelMutation(before.id, input);
  assert.equal(resolved.replayed, false);
  assert.equal(migrationDestinationModelMutationLease(resolved.item)?.state, 'resolved');
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);

  const exactProbe = reserveMigrationDestinationModels('post-adjudication-exact-probe', [lease]);
  exactProbe();
  assert.throws(
    () => reserveMigrationDestinationModels('post-adjudication-sibling-probe', siblingScope),
    /currently owns this destination model/,
  );

  const adjudications = resolved.job.details?.migrationMutationAdjudications as Array<Record<string, unknown>>;
  assert.equal(adjudications.length, 1);
  assert.equal(adjudications[0]?.requestId, REQUEST_ID);

  const replay = adjudicateDestinationModelMutation(before.id, input);
  assert.equal(replay.replayed, true);
  assert.equal((replay.job.details?.migrationMutationAdjudications as unknown[]).length, 1);
  assertAdjudicationError(
    () => adjudicateDestinationModelMutation(before.id, {
      ...input,
      outcome: 'verified_not_applied',
    }),
    'MIGRATION_MUTATION_ADJUDICATION_IDEMPOTENCY_CONFLICT',
    409,
  );
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);
  releaseSibling();
  assert.equal(adjudications[0]?.note, 'Inspected bearer [redacted] and api_key=[redacted] for [redacted-email].');
  assert.equal(JSON.stringify(resolved.job).includes('rawSecretToken'), false);
  assert.equal(JSON.stringify(resolved.job).includes('rawApiSecret'), false);
  assert.equal(JSON.stringify(resolved.job).includes('operator@example.com'), false);
});

test('mutation adjudication route rejects unknown or malformed fields, enforces CAS, and returns strict replay semantics without an Omni write', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });

  const refresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const before = getJob(refresh.trackingJobId)!;
  const input = adjudicationInput(uncertainLease(before), 'a2000000-0000-4000-8000-000000000002');

  const unknown = await postAdjudication(before.id, { ...input, unsupportedField: 'reject-me' });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.code, 'MIGRATION_MUTATION_ADJUDICATION_INVALID');

  const malformed = await postAdjudication(before.id, { ...input, expectedRevision: String(input.expectedRevision) });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.code, 'MIGRATION_MUTATION_ADJUDICATION_INVALID');

  const stale = await postAdjudication(before.id, { ...input, expectedUpdatedAt: input.expectedUpdatedAt + 1 });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, 'MIGRATION_MUTATION_ADJUDICATION_CAS_MISMATCH');
  assert.equal(uncertainLease(getJob(before.id)!).updatedAt, input.expectedUpdatedAt);

  const created = await postAdjudication(before.id, input);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.replayed, false);
  assert.equal(created.body.itemId, input.itemId);
  const createdText = JSON.stringify(created.body);

  const replay = await postAdjudication(before.id, input);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);

  const conflict = await postAdjudication(before.id, {
    ...input,
    evidenceSource: 'omni_api',
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, 'MIGRATION_MUTATION_ADJUDICATION_IDEMPOTENCY_CONFLICT');
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);
  assert.equal(createdText.includes('rawSecretToken'), false);
  assert.equal(createdText.includes('rawApiSecret'), false);
  assert.equal(createdText.includes('operator@example.com'), false);
  assert.match(createdText, /\[redacted\]/);
});

test('locked vault rejects service and route adjudication without changing the exact lease or calling Omni', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });

  const refresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const before = getJob(refresh.trackingJobId)!;
  const input = adjudicationInput(uncertainLease(before), 'a3000000-0000-4000-8000-000000000003');
  lockVault();

  assertAdjudicationError(
    () => adjudicateDestinationModelMutation(before.id, input),
    'MIGRATION_MUTATION_ADJUDICATION_LOCKED',
    423,
  );
  const route = await postAdjudication(before.id, input);
  assert.equal(route.response.status, 423);
  assert.equal(route.body.error, 'vault locked');
  assert.equal(uncertainLease(getJob(before.id)!).revision, input.expectedRevision);
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);
});

test('deleted and role-drifted instances do not invalidate exact durable adjudication evidence or trigger tenant calls', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });

  const deletedRefresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const deletedJob = getJob(deletedRefresh.trackingJobId)!;
  const deletedInput = adjudicationInput(
    uncertainLease(deletedJob),
    'a4000000-0000-4000-8000-000000000004',
  );
  deleteInstance(DESTINATION_ID);
  const deletedResult = adjudicateDestinationModelMutation(deletedJob.id, deletedInput);
  assert.equal(migrationDestinationModelMutationLease(deletedResult.item)?.state, 'resolved');

  const driftedDestinationId = 'role-drifted-destination';
  upsertInstance({
    id: driftedDestinationId,
    label: 'Role drift destination',
    role: 'destination',
    baseUrl: 'https://role-drifted-destination.example.omniapp.co',
    apiKey: 'fictional-role-drift-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const driftedRefresh = await runTrackedSchemaRefresh(driftedDestinationId, SIBLING_MODEL_ID);
  const driftedJob = getJob(driftedRefresh.trackingJobId)!;
  const driftedInput = adjudicationInput(
    uncertainLease(driftedJob),
    'a5000000-0000-4000-8000-000000000005',
  );
  upsertInstance({ id: driftedDestinationId, role: 'source' });
  const driftedResult = adjudicateDestinationModelMutation(driftedJob.id, driftedInput);
  assert.equal(migrationDestinationModelMutationLease(driftedResult.item)?.state, 'resolved');
  assert.equal(refreshCalls, 2);
  assert.equal(unexpectedFetches, 0);
});

test('source-delete adjudication resolves only the source instance and exact base-model scope without a tenant call', (t) => {
  let unexpectedFetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });
  const job = syntheticMutationJob({
    id: 'source-delete-adjudication-job',
    destinationInstanceId: SOURCE_ID,
    targetModelId: SOURCE_MODEL_ID,
    dispatchKind: 'source_delete',
  });
  insertJob(job);
  const stored = getJob(job.id)!;
  const lease = uncertainLease(stored);
  const releaseOriginal = reserveMigrationDestinationModels(`legacy-dashboard-job:${job.id}`, [lease]);
  const result = adjudicateDestinationModelMutation(
    job.id,
    {
      ...adjudicationInput(lease, 'a6000000-0000-4000-8000-000000000006'),
      outcome: 'verified_not_applied',
    },
  );

  assert.equal(result.item.destinationId, SOURCE_ID);
  assert.equal(result.item.targetModelId, SOURCE_MODEL_ID);
  assert.equal(migrationDestinationModelMutationLease(result.item)?.state, 'resolved');
  const audit = result.job.details?.migrationMutationAdjudications as Array<Record<string, unknown>>;
  assert.equal(audit[0]?.destinationInstanceId, SOURCE_ID);
  assert.equal(audit[0]?.targetModelId, SOURCE_MODEL_ID);
  const exactProbe = reserveMigrationDestinationModels('source-delete-exact-probe', [lease]);
  exactProbe();
  releaseOriginal();
  assert.equal(unexpectedFetches, 0);
});

test('adjudication persistence failure retains the exact hold, appends no audit, and performs no tenant call', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });
  const refresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const before = getJob(refresh.trackingJobId)!;
  const lease = uncertainLease(before);
  const input = adjudicationInput(lease, 'a7000000-0000-4000-8000-000000000007');

  chmodSync(temporaryRoot, 0o500);
  try {
    assert.throws(
      () => adjudicateDestinationModelMutation(before.id, input),
      /EACCES|permission denied|operation not permitted/i,
    );
    const unchanged = getJob(before.id)!;
    assert.equal(uncertainLease(unchanged).revision, input.expectedRevision);
    assert.equal(unchanged.details?.migrationMutationAdjudications, undefined);
    assert.throws(
      () => reserveMigrationDestinationModels('failed-adjudication-exact-probe', [lease]),
      /currently owns this destination model/,
    );
  } finally {
    chmodSync(temporaryRoot, 0o700);
  }
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);
});

test('terminal restart makes a dispatched lease uncertain and normalizes its running business-item sibling', () => {
  const job = syntheticMutationJob({
    id: 'terminal-restart-normalization-job',
    leaseState: 'dispatched',
    dispatchStatus: 'running',
    jobStatus: 'failed',
  });
  insertJob(job);
  closeJobStoreForTests();

  const recovered = getJob(job.id)!;
  const recoveredLease = uncertainLease(recovered);
  const dispatch = recovered.items.find((item) => item.id === recoveredLease.dispatchItemId);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.details?.migrationMutationState, 'reconciliation_required');
  assert.equal(recoveredLease.revision, 4);
  assert.equal(dispatch?.status, 'failed');
  assert.match(dispatch?.error || '', /Interrupted by server restart/);
  assert.equal(typeof dispatch?.endedAt, 'number');
});

test('reusing an adjudicated lease slot rejects the old idempotency request as a stale replay', async (t) => {
  let refreshCalls = 0;
  let unexpectedFetches = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { status: 'RUNNING', raw: {} };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Adjudication must not call Omni.');
  });
  const refresh = await runTrackedSchemaRefresh(DESTINATION_ID, TARGET_MODEL_ID);
  const before = getJob(refresh.trackingJobId)!;
  const originalLease = uncertainLease(before);
  const originalInput = adjudicationInput(
    originalLease,
    'a8000000-0000-4000-8000-000000000008',
  );
  const resolved = adjudicateDestinationModelMutation(before.id, originalInput);
  const resolvedLease = migrationDestinationModelMutationLease(resolved.item)!;

  const reused = structuredClone(resolved.job);
  const reusedItem = reused.items.find((item) => item.id === originalLease.itemId)!;
  const nextUpdatedAt = resolvedLease.updatedAt + 10;
  reusedItem.status = 'warning';
  reusedItem.error = 'A destination-model write outcome requires reconciliation before another workflow can use this model.';
  reusedItem.endedAt = nextUpdatedAt;
  reusedItem.details = {
    migrationDestinationModelMutation: true,
    migrationMutationState: 'uncertain',
    migrationMutationOperation: resolvedLease.operation,
    migrationMutationUpdatedAt: nextUpdatedAt,
    migrationMutationRevision: (resolvedLease.revision || 0) + 1,
    migrationMutationDispatchItemId: resolvedLease.dispatchItemId,
    migrationMutationDispatchItemKind: resolvedLease.dispatchItemKind,
    migrationMutationDispatchedAt: resolvedLease.dispatchedAt,
    migrationMutationDispatchFingerprint: resolvedLease.dispatchFingerprint,
  };
  insertJob(reused);
  const releaseReused = reserveMigrationDestinationModels(`schema-refresh:${reused.id}`, [resolvedLease]);

  assertAdjudicationError(
    () => adjudicateDestinationModelMutation(reused.id, originalInput),
    'MIGRATION_MUTATION_ADJUDICATION_STALE_REPLAY',
    409,
  );
  const unchanged = getJob(reused.id)!;
  assert.equal(uncertainLease(unchanged).updatedAt, nextUpdatedAt);
  assert.equal((unchanged.details?.migrationMutationAdjudications as unknown[]).length, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(unexpectedFetches, 0);
  releaseReused();
});

test('verified-applied legacy and verified-partial model adjudications require a fresh plan instead of retry', async (t) => {
  let unexpectedFetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Blocked retry must not call Omni.');
  });
  const fixtures = [
    {
      job: syntheticMutationJob({ id: 'legacy-applied-retry-block' }),
      outcome: 'verified_applied' as const,
      requestId: 'a9000000-0000-4000-8000-000000000009',
      owner: 'legacy-dashboard-job:legacy-applied-retry-block',
    },
    {
      job: syntheticMutationJob({
        id: 'model-partial-retry-block',
        workflow: 'model',
        operation: 'model_job',
        dispatchKind: 'model_yaml_write',
        retryInput: modelRetryInput(),
      }),
      outcome: 'verified_partial_terminal' as const,
      requestId: 'aa000000-0000-4000-8000-000000000010',
      owner: 'model-job:model-partial-retry-block',
    },
  ];

  for (const fixture of fixtures) {
    insertJob(fixture.job);
    const stored = getJob(fixture.job.id)!;
    const lease = uncertainLease(stored);
    const releaseOriginal = reserveMigrationDestinationModels(fixture.owner, [lease]);
    adjudicateDestinationModelMutation(stored.id, {
      ...adjudicationInput(lease, fixture.requestId),
      outcome: fixture.outcome,
    });
    await assert.rejects(
      () => retryMigrationJob(stored.id),
      (error: unknown) => (
        typeof error === 'object'
        && error !== null
        && (error as { code?: unknown }).code === 'MIGRATION_MUTATION_FRESH_PLAN_REQUIRED'
        && (error as { statusCode?: unknown }).statusCode === 409
      ),
    );
    releaseOriginal();
  }
  assert.equal(unexpectedFetches, 0);
});

test('verified-not-applied legacy adjudication permits a scoped retry to complete', async (t) => {
  let unexpectedFetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Every retry tenant seam must be explicitly mocked.');
  });
  mockLegacyRetryDependencies(t);
  const parent = syntheticMutationJob({ id: 'legacy-not-applied-retry' });
  insertJob(parent);
  const stored = getJob(parent.id)!;
  const lease = uncertainLease(stored);
  const releaseOriginal = reserveMigrationDestinationModels(`legacy-dashboard-job:${parent.id}`, [lease]);
  adjudicateDestinationModelMutation(parent.id, {
    ...adjudicationInput(lease, 'ab000000-0000-4000-8000-000000000011'),
    outcome: 'verified_not_applied',
  });

  const retried = await retryMigrationJob(parent.id);
  const completed = await waitForTerminalJob(retried.id);
  assert.notEqual(retried.id, parent.id);
  assert.equal(retried.parentJobId, parent.id);
  const importItem = completed.items.find((item) => item.kind === 'import');
  assert.equal(importItem?.status === 'succeeded' || importItem?.status === 'warning', true);
  assert.equal(importItem?.importedIdentifier, 'retried-dashboard');
  assert.equal(importItem?.importedDocumentId, 'retried-dashboard-id');
  assert.equal(completed.status === 'succeeded' || completed.status === 'partial', true);
  assert.equal(unexpectedFetches, 0);
  releaseOriginal();
});

test('verified-not-applied model adjudication permits a scoped model retry to complete', async (t) => {
  let unexpectedFetches = 0;
  let migrateCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    unexpectedFetches += 1;
    throw new Error('Every retry tenant seam must be explicitly mocked.');
  });
  t.mock.method(OmniClient.prototype, 'migrateModel', async () => {
    migrateCalls += 1;
    return { status: 'ok' };
  });
  t.mock.method(OmniClient.prototype, 'findModelBranch', async () => ({
    id: 'retried-model-branch-id',
    name: 'synthetic-retry-branch',
    raw: {},
  }));
  t.mock.method(OmniClient.prototype, 'validateModel', async () => []);
  t.mock.method(OmniClient.prototype, 'validateModelContent', async () => ({ issues: [] }));

  const parent = syntheticMutationJob({
    id: 'model-not-applied-retry',
    workflow: 'model',
    operation: 'model_job',
    dispatchKind: 'model_yaml_write',
    retryInput: modelRetryInput(),
  });
  insertJob(parent);
  const stored = getJob(parent.id)!;
  const lease = uncertainLease(stored);
  const releaseOriginal = reserveMigrationDestinationModels(`model-job:${parent.id}`, [lease]);
  adjudicateDestinationModelMutation(parent.id, {
    ...adjudicationInput(lease, 'ac000000-0000-4000-8000-000000000012'),
    outcome: 'verified_not_applied',
  });

  const retried = await retryMigrationJob(parent.id);
  const completed = await waitForTerminalJob(retried.id);
  assert.notEqual(retried.id, parent.id);
  assert.equal(retried.parentJobId, parent.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(migrateCalls, 1);
  assert.equal(unexpectedFetches, 0);
  releaseOriginal();
});
