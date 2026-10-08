import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../server/handlers/model-migrator';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import { DASHBOARD_READINESS_EVIDENCE_VERSION } from '../shared/dashboardDeploymentPlan';
import type { MigrationJob, ModelMigrationJobInput } from '../server/services/migrationJobs';
import { closeJobStoreForTests } from '../server/services/jobStore';
import { getInstance, lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';
import { dashboardRepairSnapshotHash as hash, issueDashboardRepairApproval, verifyDashboardRepairApproval } from '../server/services/dashboardRepairApproval';
import { assertAdditiveDashboardRepairDispatch, dashboardRepairInstanceBoundaryHash, readDashboardRepairSourceBinding } from '../server/services/dashboardRepairRuntime';

let directory: string;
let planPath: string;
let plan: DashboardDeploymentPlan;
let state: Record<string, unknown>;
let workbookFiles: Record<string, string>;
let readCount: number;
const sourceFiles = { 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n' };
const targetFiles = { model: '{}\n' };
const envKeys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH'];
let oldEnvironment: Array<string | undefined>;

beforeEach(() => {
  oldEnvironment = envKeys.map((key) => process.env[key]);
  directory = mkdtempSync(join(tmpdir(), 'omnikit-dependency-binding-'));
  process.env.OMNIKIT_VAULT_PATH = join(directory, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = join(directory, 'jobs.json');
  planPath = `${process.env.OMNIKIT_JOB_HISTORY_PATH}.deployment-plans.json`;
  closeJobStoreForTests();
  resetVault(); unlockVault('synthetic-only-binding-passphrase');
  for (const [id, role] of [['source', 'source'], ['target', 'destination']] as const) upsertInstance({ id, role, label: id,
    baseUrl: 'https://example.omniapp.co', apiKey: `${id}-synthetic-key`, postMigrationActions: [],
    metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] } });
  state = { modelId: 'source-model', workbookModelId: 'workbook', name: 'Example dashboard', containers: [] };
  workbookFiles = {};
  readCount = 0;
  plan = { version: 2, evidenceVersion: DASHBOARD_READINESS_EVIDENCE_VERSION, id: 'repair-plan', revision: 1, createdAt: 1, updatedAt: 1,
    intent: { profile: 'safe_copy_v1', requestId: '11111111-1111-4111-8111-111111111111',
      source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] },
      destinations: [{ targetId: 'route', instanceId: 'target', connectionId: 'target-connection', modelId: 'target-model' }] },
    sourceHashes: { dashboard: hash(state) }, sourceModelHashes: { 'source-model': hash(sourceFiles) },
    readinessRun: { id: 'ready', startedAt: 1, status: 'complete' },
    targets: [{ targetId: 'route', status: 'model_changes_required', modelHash: hash(targetFiles), checkedAt: 1,
      sourceModelIds: ['source-model'], requiredFiles: ['orders.view'], requiredFilesByModelId: { 'source-model': ['orders.view'] }, findings: [] }] };
  savePlan();
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => { readCount += 1; return structuredClone(state); });
  mock.method(OmniClient.prototype, 'getModelYaml', async (id: string) => {
    readCount += 1;
    return { files: structuredClone(id === 'workbook' ? workbookFiles : id === 'source-model' ? sourceFiles : targetFiles), checksums: {} };
  });
});

afterEach(() => {
  mock.restoreAll(); closeJobStoreForTests(); resetVault(); lockVault();
  envKeys.forEach((key, index) => oldEnvironment[index] === undefined ? delete process.env[key] : process.env[key] = oldEnvironment[index]);
  rmSync(directory, { recursive: true, force: true });
});

function savePlan() { writeFileSync(planPath, JSON.stringify([plan])); }
const scope = () => ({ planId: plan.id, targetId: 'route', revision: plan.revision });
const request = (route: string, body: unknown) => new Request(`http://localhost/api/model-migrator/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function binding() {
  return readDashboardRepairSourceBinding({ sourceId: 'source', targetId: 'target', targetModelId: 'target-model', sourceModelIds: ['source-model'],
    instanceBoundaryHash: dashboardRepairInstanceBoundaryHash('source', 'target', 'target-model', ['source-model']), sourceDocumentHashes: plan.sourceHashes }, new OmniClient(getInstance('source')!));
}
async function runtimeJob(): Promise<MigrationJob> {
  const writes = [{ fileName: 'orders.view', yaml: sourceFiles['orders.view'], previousChecksum: undefined }];
  return { sourceId: 'source', destinationIds: ['target'], details: { dashboardRepair: { planId: plan.id, targetId: 'route', revision: 1,
    ...(await binding()), additiveOnly: true, sourceModelHashes: plan.sourceModelHashes, targetModelHash: hash(targetFiles), approvedFilesHash: hash(writes) } },
    items: [{ kind: 'model_yaml_write', details: { files: writes } }] } as unknown as MigrationJob;
}
const dispatch = (job: MigrationJob) => assertAdditiveDashboardRepairDispatch(job, 'target-model', new OmniClient(getInstance('source')!), new OmniClient(getInstance('target')!));

test('branch retirement dashboard preview and direct submission reject before reads or job creation', async () => {
  let creates = 0;
  const createJob = async () => { creates += 1; return { id: 'must-not-create' } as MigrationJob; };
  for (const route of ['translate', 'jobs']) {
    const response = await handler(request(route, { dashboardRepair: scope(), sourceInstanceId: 'source', targetInstanceId: 'target',
      modelId: 'source-model', targetModelId: 'target-model', acceptedFiles: [{ fileName: 'orders.view', yaml: sourceFiles['orders.view'] }] }), { createJob });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, 'MODEL_MIGRATOR_BRANCH_REVIEW_ONLY');
  }
  assert.equal(creates, 0);
  assert.equal(readCount, 0);
});

test('branch retirement retains exact dashboard workbook and credential approval binding helpers', async () => {
  const original = await binding();
  assert.deepEqual(original.sourceDocumentHashes, plan.sourceHashes);
  assert.deepEqual(original.sourceWorkbookHashes, { workbook: hash({}) });
  const approved = { planId: plan.id, revision: plan.revision, targetId: 'route',
    sourceModelId: 'source-model', sourceModelHash: hash(sourceFiles), targetModelHash: hash(targetFiles),
    fileName: 'orders.view', yaml: sourceFiles['orders.view'], ...original };
  const token = issueDashboardRepairApproval(approved);
  verifyDashboardRepairApproval(token, approved);
  workbookFiles = { model: '{}\n' };
  await assert.rejects(async () => verifyDashboardRepairApproval(token, { ...approved, ...(await binding()) }), /reviewed diff/);
  workbookFiles = {};
  upsertInstance({ ...getInstance('target')!, apiKey: 'rotated-synthetic-key' });
  await assert.rejects(async () => verifyDashboardRepairApproval(token, { ...approved, ...(await binding()) }), /reviewed diff/);
});

test('branch retirement retains canonical tenant alias exclusion for every source model', () => {
  plan.sourceModelHashes['target-model'] = hash(targetFiles);
  assert.throws(() => dashboardRepairInstanceBoundaryHash('source', 'target', 'target-model', Object.keys(plan.sourceModelHashes)), /source model/);
  assert.equal(readCount, 0);
  assert.throws(() => dashboardRepairInstanceBoundaryHash('source', 'target', 'source-model', ['source-model']), /source model/);
  assert.doesNotThrow(() => dashboardRepairInstanceBoundaryHash('source', 'target', 'different-model', ['source-model']));
});

test('legacy unsigned bindings and partially bound repair jobs require a fresh review before any read', async () => {
  const job = await runtimeJob();
  const evidence = job.details!.dashboardRepair as NonNullable<ModelMigrationJobInput['dashboardRepair']>;
  for (const key of ['instanceBoundaryHash', 'sourceDocumentHashes', 'sourceWorkbookHashes', 'sourceModelHashes'] as const) {
    const old = structuredClone(job);
    delete (old.details!.dashboardRepair as NonNullable<ModelMigrationJobInput['dashboardRepair']>)[key];
    readCount = 0;
    await assert.rejects(dispatch(old), /fresh differences/);
    assert.equal(readCount, 0);
  }
  for (const key of ['sourceDocumentHashes', 'sourceWorkbookHashes'] as const) {
    const partial = structuredClone(job);
    (partial.details!.dashboardRepair as NonNullable<ModelMigrationJobInput['dashboardRepair']>)[key] = {};
    await assert.rejects(dispatch(partial), /fresh differences/);
  }
  const unbound = { planId: 'p', revision: 1, targetId: 't', sourceModelId: 's', sourceModelHash: 's', targetModelHash: 't', fileName: 'x.view', yaml: '{}' };
  assert.throws(() => issueDashboardRepairApproval(unbound as Parameters<typeof issueDashboardRepairApproval>[0]), /missing.*binding/);
  const approved = { ...unbound, instanceBoundaryHash: evidence.instanceBoundaryHash!, sourceDocumentHashes: evidence.sourceDocumentHashes!, sourceWorkbookHashes: evidence.sourceWorkbookHashes! };
  const token = issueDashboardRepairApproval(approved);
  verifyDashboardRepairApproval(token, approved);
  assert.throws(() => verifyDashboardRepairApproval(token, { ...approved, sourceWorkbookHashes: { other: hash({}) } }), /reviewed diff/);
});

test('dispatch blocks workbook drift, missing workbook coverage and changed credentials before repair writes', async () => {
  const job = await runtimeJob();
  await dispatch(job);
  workbookFiles = { model: '{}\n' };
  await assert.rejects(dispatch(job), /source workbook changed/);
  workbookFiles = {};
  const missingWorkbook = structuredClone(job);
  (missingWorkbook.details!.dashboardRepair as NonNullable<ModelMigrationJobInput['dashboardRepair']>).sourceWorkbookHashes = { unrelated: hash({}) };
  await assert.rejects(dispatch(missingWorkbook), /binding evidence is incomplete/);
  state = { ...state, name: 'Changed dashboard' };
  await assert.rejects(dispatch(job), /source dashboard changed/);
  upsertInstance({ ...getInstance('target')!, apiKey: 'rotated-synthetic-key' });
  readCount = 0;
  await assert.rejects(dispatch(job), /saved instance changed/);
  assert.equal(readCount, 0);
});

test('dispatch rejects a fully bound source-model alias and rechecks credentials changed during reads', async () => {
  const job = await runtimeJob();
  const repair = job.details!.dashboardRepair as NonNullable<ModelMigrationJobInput['dashboardRepair']>;
  repair.sourceModelHashes = { ...repair.sourceModelHashes, 'target-model': hash(targetFiles) };
  readCount = 0;
  await assert.rejects(dispatch(job), /source model.*alias/);
  assert.equal(readCount, 0);
  delete repair.sourceModelHashes['target-model'];
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => {
    upsertInstance({ ...getInstance('source')!, apiKey: 'changed-during-read' });
    return state;
  });
  await assert.rejects(dispatch(job), /saved instance changed/);
});
