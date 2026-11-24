import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import { DASHBOARD_READINESS_EVIDENCE_VERSION, type DashboardDeploymentPlan, type DashboardTopicChoice } from '../shared/dashboardDeploymentPlan';
import type { BranchVerificationRecord, TopicMigrationPlan, TopicMigrationRequest } from '../shared/topicMigration';
import { createTopicMigrationBranchName, isTopicMigrationBranchName, isTopicMigrationBranchNameForPlan } from '../shared/topicMigrationBranchNames';
import { buildTopicMigrationAnalysis } from '../server/services/topicMigrationPlanner';
import handler from '../server/handlers/model-migrator';
import historyHandler from '../server/handlers/migration-jobs';
import { createTopicMigrationPlan, getTopicMigrationPlan, stageApprovedDashboardBranchPreparation, stageTopicMigrationPlan, verifyTopicMigrationBranch } from '../server/services/topicMigrationPlans';
import { adjudicateDestinationModelMutation, cancelMigrationJob, createModelMigrationJob, mergeModelMigrationJob, retryMigrationJob, type MigrationJob, type ModelMigrationJobInput } from '../server/services/migrationJobs';
import { closeJobStoreForTests, getJob, insertJob, listJobs } from '../server/services/jobStore';
import { getInstance, lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient, OmniClientError } from '../server/services/omniClient';
import { dashboardSafeCopyStateHash as hash } from '../server/services/dashboardSafeCopyRuntime';
import { dashboardRepairInstanceBoundaryHash } from '../server/services/dashboardRepairRuntime';
import { sanitizeJob } from '../server/services/jobSanitizer';
import { subscribeMigrationJobEvents, type MigrationJobEvent } from '../server/services/jobEvents';
import { applyTopicBranchCorrection, getTopicBranchCorrection, prepareTopicBranchCorrection, reconcileTopicBranchCorrection } from '../server/services/topicBranchCorrections';
import { readTopicMigrationTableNameEvidence } from '../server/services/topicMigrationTableNameEvidence';

let temporaryRoot: string;
const envKeys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH'] as const;
let oldEnvironment: Array<string | undefined>;
let sourceFiles: Record<string, string>;
let targetFiles: Record<string, string>;
let wrongConnection: boolean;
let targetFollower: boolean;
let namespaceReads: number;
let cancelAtBranchRead: boolean;
let injectUnrelatedFile: boolean;
let partialWrite: boolean;
let driftDuringCreate: boolean;
let branchCreates: number;
let yamlWrites: number;
let forbiddenWrites: string[];
let branches: Map<string, { name: string; files: Record<string, string> }>;
let tableNameSchemas: Map<string, Record<string, string>>;
let tableNameReads: string[];
const state = { modelId: 'source-model', workbookModelId: 'source-workbook', name: 'Example dashboard', queries: [] };
const workbookFiles = { model: '{}\n' };
const checksum = (yaml: string) => createHash('sha256').update(yaml).digest('hex');
const request = (): TopicMigrationRequest => ({
  sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model',
  targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model',
  topicIds: ['example.topic'], schemaMapText: '',
});
beforeEach((t) => {
  oldEnvironment = envKeys.map((key) => process.env[key]);
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-branch-prep-test-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy.json');
  closeJobStoreForTests(); resetVault(); unlockVault('fictional branch preparation passphrase');
  for (const [id, role] of [['source', 'source'], ['target', 'destination']] as const) {
    upsertInstance({ id, role, label: 'Example ' + id, baseUrl: 'https://' + id + '.example.omniapp.co',
      apiKey: 'fictional-secret-' + id, metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] }, postMigrationActions: [] });
  }
  sourceFiles = { model: '{}\n', 'example.topic': 'base_view: records\nfields: [records.id]\njoins: {}\n',
    'records.view': 'catalog: SOURCE\nschema: PUBLIC\ntable_name: records\ndimensions:\n  id:\n    sql: ${TABLE}."ID"\n' };
  targetFiles = { model: '{}\n' };
  wrongConnection = false; cancelAtBranchRead = false; injectUnrelatedFile = false; partialWrite = false; driftDuringCreate = false;
  targetFollower = false; namespaceReads = 0;
  branchCreates = 0; yamlWrites = 0; forbiddenWrites = []; branches = new Map();
  tableNameSchemas = new Map(); tableNameReads = [];
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in fictional branch tests.'); });
  t.mock.method(OmniClient.prototype, 'listConnections', async () => [
    { id: 'source-connection', name: 'Example source', dialect: 'snowflake' },
    { id: 'target-connection', name: 'Example destination', dialect: 'databricks' },
  ]);
  t.mock.method(OmniClient.prototype, 'listModels', async (options: { connectionId?: string; modelKind?: string } = {}) => {
    assert.notEqual(options.modelKind, 'SCHEMA', 'Branch preparation must not require physical schema reads.');
    return ['source', 'target'].filter((side) => !options.connectionId || options.connectionId === side + '-connection').map((side) => ({
      id: side + '-model', name: 'Example ' + side, connectionId: wrongConnection ? 'unrelated' : side + '-connection',
      pullRequestRequired: side === 'target',
      gitProtected: side === 'target', gitFollower: side === 'target' && targetFollower,
    }));
  });
  t.mock.method(OmniClient.prototype, 'listModelSchemas', async () => { namespaceReads += 1; throw new Error('Optional namespace suggestions unavailable'); });
  t.mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => structuredClone(state));
  t.mock.method(OmniClient.prototype, 'getModelYaml', async (modelId: string, options: { branchId?: string; fullyResolved?: boolean; includeSchemas?: string } = {}) => {
    if (options.includeSchemas !== undefined) {
      assert.equal(modelId, 'target-model'); assert.equal(options.fullyResolved, true);
      assert.equal(options.branchId, undefined, 'Names must come from the selected destination, not an unrelated working branch.');
      tableNameReads.push(options.includeSchemas);
      const files = tableNameSchemas.get(options.includeSchemas);
      if (!files) throw new Error('Fictional optional schema inventory unavailable');
      return { files: structuredClone(files), raw: { files: structuredClone(files) } };
    }
    assert.notEqual(options.fullyResolved, true);
    if (options.branchId && cancelAtBranchRead) {
      cancelAtBranchRead = false;
      const job = listJobs().find((candidate) => candidate.status === 'running');
      if (job) cancelMigrationJob(job.id);
    }
    const files = options.branchId ? branches.get(options.branchId)!.files
      : modelId === 'source-model' ? sourceFiles : modelId === 'source-workbook' ? workbookFiles : targetFiles;
    const raw = { files: structuredClone(files), viewNames: Object.fromEntries(Object.keys(files).map((name) => [name, name.endsWith('.view') ? name.slice(0, -5) : ''])) };
    return { files: structuredClone(files), raw, checksums: Object.fromEntries(Object.entries(files).map(([name, yaml]) => [name, checksum(yaml)])) };
  });
  t.mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }) => {
    const id = 'branch-' + ++branchCreates;
    branches.set(id, { name: input.branchName, files: structuredClone(targetFiles) });
    if (driftDuringCreate) sourceFiles['records.view'] += '# source changed\n';
    return { id, name: input.branchName, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async (input: { branchId?: string; files: Array<{ fileName: string; yaml: string }> }) => {
    yamlWrites += 1;
    const branch = branches.get(input.branchId!)!;
    for (const file of input.files) {
      branch.files[file.fileName] = file.yaml;
      if (partialWrite) throw new Error('Fictional lost response after one write');
    }
    if (injectUnrelatedFile) branch.files['unrelated.view'] = 'dimensions: {}\n';
    return {};
  });
  t.mock.method(OmniClient.prototype, 'findModelBranch', async (_modelId: string, name: string) => {
    const found = [...branches].find(([, branch]) => branch.name === name);
    return found ? { id: found[0], name, raw: {} } : null;
  });
  for (const name of ['mergeModelBranch', 'createOrUpdateModelBranchPullRequest', 'deleteModelBranch', 'validateModel', 'validateModelContent',
    'migrateModel', 'findAndReplaceModelContent', 'createWorkbook'] as const) {
    if (typeof OmniClient.prototype[name] === 'function') t.mock.method(OmniClient.prototype, name, async () => {
      forbiddenWrites.push(name); throw new Error('Forbidden branch-preparation operation: ' + name);
    });
  }
});
afterEach(() => {
  assert.deepEqual(forbiddenWrites, []);
  lockVault(); closeJobStoreForTests(); resetVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  envKeys.forEach((key, index) => oldEnvironment[index] === undefined ? delete process.env[key] : process.env[key] = oldEnvironment[index]);
});
const post = (route: string, body: unknown) => handler(new Request('http://localhost/api/model-migrator/' + route,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
async function ready(): Promise<TopicMigrationPlan> {
  const plan = await createTopicMigrationPlan(request());
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.equal(plan.version, 2);
  assert.equal(plan.executionProfile, 'branch_preparation_v1');
  return plan;
}
async function finished(id: string): Promise<MigrationJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = getJob(id)!;
    if (!['pending', 'running'].includes(job.status)) return job;
    await setImmediate();
  }
  assert.fail('Mocked branch preparation did not finish');
}
const stage = (plan: TopicMigrationPlan) => stageTopicMigrationPlan(plan.id, { revision: plan.revision, approve: true }, createModelMigrationJob);

test('stable review snapshot completes discovery before two explicit combined YAML reads', async (t) => {
  const discovered = new Set<string>();
  t.mock.method(OmniClient.prototype, 'listModelSchemas', async (modelId: string) => {
    await setImmediate();
    if (modelId === 'target-model') targetFiles['available.view'] = 'table_name: available\ndimensions: {}\n';
    discovered.add(modelId);
    return ['PUBLIC'];
  });
  const originalRead = OmniClient.prototype.getModelYaml;
  const counts = new Map<string, number>();
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    assert.equal(discovered.size, 2, 'Optional discovery completes before either approval snapshot starts.');
    assert.equal(args[1]?.mode, 'combined');
    assert.equal(args[1]?.fullyResolved, false); assert.equal(args[1]?.includeChecksums, true);
    counts.set(args[0], (counts.get(args[0]) || 0) + 1);
    return originalRead.apply(this, args);
  });
  const plan = await ready();
  assert.equal(counts.get('source-model'), 2); assert.equal(counts.get('target-model'), 2);
  const rows = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  assert.equal(rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id).targetFiles['available.view'], targetFiles['available.view']);
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('stable review snapshot rejects changing files or checksums without polling or writes', async (t) => {
  const originalRead = OmniClient.prototype.getModelYaml;
  for (const change of ['files', 'checksums'] as const) {
    let destinationReads = 0;
    const read = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
      const response = await originalRead.apply(this, args);
      if (args[0] === 'target-model' && ++destinationReads === 2) {
        if (change === 'files') {
          response.files = { ...response.files, 'available.view': 'table_name: available\n' };
          response.raw = { files: response.files };
        } else response.checksums = { ...response.checksums, model: 'changed-checksum' };
      }
      return response;
    });
    await assert.rejects(ready(), /Destination model files or checksums changed while being read/);
    assert.equal(destinationReads, 2, 'No retries or polling after an unstable snapshot.');
    read.mock.restore();
  }
  assert.equal(listJobs().length, 0); assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('destination preservation stages sanitizes and dispatches only approved missing fields while keeping target SQL and table', async () => {
  sourceFiles['example.topic'] = 'base_view: records\nfields: [records.id, records.extra]\njoins: {}\n';
  sourceFiles['records.view'] += '  extra:\n    sql: ${records.id} + 1\n    label: Source addition\n';
  targetFiles['records.view'] = '# destination comment\ncatalog: SOURCE\nschema: PUBLIC\ntable_name: destination_records\ndimensions:\n  id:\n    sql: "`id`"\n    label: Retained destination\n';
  const initial = await createTopicMigrationPlan(request());
  const option = initial.files.find(file => file.sourceFileName === 'records.view')?.preservationOption;
  assert.ok(option); assert.equal(initial.status, 'blocked');
  const plan = await createTopicMigrationPlan({ ...request(), keepDestinationDefinitions: { 'records.view': option } });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  const changed = plan.files.find(file => file.sourceFileName === 'records.view')!;
  assert.deepEqual(changed.destinationPreservation?.addedPaths, ['dimensions.extra']);
  const staged = await stage(plan);
  assert.deepEqual(sanitizeJob(staged.job), staged.job, 'typed preservation choice and hashes must survive job history protection');
  const job = await finished(staged.job.id); assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  const actual = parse(branches.get('branch-1')!.files['records.view']);
  assert.equal(actual.table_name, 'destination_records'); assert.equal(actual.dimensions.id.sql, '`id`');
  assert.equal(actual.dimensions.id.label, 'Retained destination'); assert.equal(actual.dimensions.extra.sql, '${records.id} + 1');
  assert.equal(targetFiles['records.view'], changed.before); assert.equal(yamlWrites, 1);
});

async function correctionFixture(t: TestContext, recovered = false) {
  const plan = await ready();
  injectUnrelatedFile = recovered;
  const job = await finished((await stage(plan)).job.id);
  if (recovered) {
    assert.equal(job.status, 'partial');
    delete branches.get('branch-1')!.files['unrelated.view'];
    const verification = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
    assert.equal(verification.verification.verified, true);
  } else assert.equal(job.status, 'succeeded');
  const oldJob = structuredClone(getJob(job.id));
  const models = OmniClient.prototype.listModels;
  t.mock.method(OmniClient.prototype, 'listModels', async function (options: Parameters<OmniClient['listModels']>[0]) {
    if (options === 'BRANCH') return [...branches].map(([id, branch]) => ({ id, name: branch.name,
      baseModelId: 'target-model', connectionId: 'target-connection' }));
    return models.call(this, options);
  });
  const getYaml = OmniClient.prototype.getModelYaml;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (modelId: string, options: Parameters<OmniClient['getModelYaml']>[1] = {}) {
    if (options.includeSchemas) {
      const files = { 'SOURCE.PUBLIC/records.view': 'catalog: SOURCE\nschema: PUBLIC\ntable_name: records\ndimensions:\n  id:\n    sql: "`ID`"\n' };
      return { files, raw: { files } };
    }
    return getYaml.call(this, modelId, options);
  });
  t.mock.method(OmniClient.prototype, 'getModelValidationRaw', async () => []);
  let writes = 0;
  t.mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: Parameters<OmniClient['updateModelYamlFile']>[0], guard?: Parameters<OmniClient['updateModelYamlFile']>[1]) => {
    guard?.assertCanDispatch();
    assert.equal(input.branchId, 'branch-1'); assert.equal(input.modelId, 'target-model');
    const branch = branches.get(input.branchId!)!;
    assert.equal(input.previousChecksum, checksum(branch.files[input.fileName]));
    writes++; branch.files[input.fileName] = input.yaml; return { success: true, fileName: input.fileName };
  });
  return { plan, job, oldJob, writes: () => writes };
}
async function correctionFinished(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = getTopicBranchCorrection(id);
    if (result.status !== 'running') return result;
    await setImmediate();
  }
  assert.fail('Mocked correction did not finish');
}

test('branch correction lifecycle uses exact branch, preserves native edits, consumes approval, and rechecks to no-op', async t => {
  const fixture = await correctionFixture(t), main = structuredClone(targetFiles);
  branches.get('branch-1')!.files['records.view'] += 'label: Human maintained label\n';
  const response = await post(`topic-plan/${fixture.plan.id}/corrections`, {});
  assert.equal(response.status, 200);
  const { correction } = await response.json();
  assert.equal(correction.status, 'ready', JSON.stringify(correction.issues));
  assert.equal(correction.files[0].before, branches.get('branch-1')!.files['records.view']);
  await applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true });
  const result = await correctionFinished(correction.id);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.equal(result.filesVerified, true); assert.equal(result.validation.status, 'passed');
  assert.equal(result.mainUnchanged, true); assert.equal(fixture.writes(), 1); assert.equal(branchCreates, 1);
  assert.match(branches.get('branch-1')!.files['records.view'], /Human maintained label/);
  assert.equal(parse(branches.get('branch-1')!.files['records.view']).dimensions.id.sql, '${TABLE}.`ID`');
  assert.deepEqual(targetFiles, main); assert.deepEqual(getJob(fixture.job.id), fixture.oldJob);
  await applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true });
  assert.equal(fixture.writes(), 1);
  const next = await prepareTopicBranchCorrection(fixture.plan.id, { predecessorId: correction.id });
  assert.equal(next.status, 'unchanged', JSON.stringify(next.issues));
});

test('branch correction rejects stale branch, source, and comparison-only origins without writes', async t => {
  const fixture = await correctionFixture(t);
  const correction = await prepareTopicBranchCorrection(fixture.plan.id, {});
  branches.get('branch-1')!.files['records.view'] += '# native edit after approval\n';
  await assert.rejects(applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true }), /evidence changed/);
  const fresh = await prepareTopicBranchCorrection(fixture.plan.id, { predecessorId: correction.id });
  sourceFiles['records.view'] += '# source edit after review\n';
  await assert.rejects(applyTopicBranchCorrection(fresh.id, { revision: fresh.revision, approve: true }), /evidence changed/);
  const comparison = await createTopicMigrationPlan({ ...request(), comparisonOfPlanId: fixture.plan.id });
  await assert.rejects(prepareTopicBranchCorrection(comparison.id, {}), /read-only/);
  assert.equal(fixture.writes(), 0);
});

test('branch correction lost response is reconciled read-only when the exact proposed bytes exist', async t => {
  const fixture = await correctionFixture(t), correction = await prepareTopicBranchCorrection(fixture.plan.id, {});
  t.mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: Parameters<OmniClient['updateModelYamlFile']>[0], guard?: Parameters<OmniClient['updateModelYamlFile']>[1]) => {
    guard?.assertCanDispatch(); branches.get('branch-1')!.files[input.fileName] = input.yaml; throw new Error('Fictional lost response');
  });
  await applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true });
  assert.equal((await correctionFinished(correction.id)).status, 'uncertain');
  const checked = await reconcileTopicBranchCorrection(correction.id);
  assert.equal(checked.status, 'applied'); assert.equal(checked.filesVerified, true);
  assert.equal(checked.validation.status, 'not_run');
  assert.equal((await prepareTopicBranchCorrection(fixture.plan.id, { predecessorId: correction.id })).status, 'unchanged');
});

test('branch correction negative read cannot clear a possibly delayed write', async t => {
  const fixture = await correctionFixture(t), correction = await prepareTopicBranchCorrection(fixture.plan.id, {});
  t.mock.method(OmniClient.prototype, 'updateModelYamlFile', async (_input: unknown, guard?: Parameters<OmniClient['updateModelYamlFile']>[1]) => {
    guard?.assertCanDispatch(); throw new Error('Fictional response timeout');
  });
  await applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true });
  await correctionFinished(correction.id);
  const result = await reconcileTopicBranchCorrection(correction.id);
  assert.equal(result.status, 'uncertain'); assert.equal(result.outcomes[0].status, 'unapplied');
  await assert.rejects(prepareTopicBranchCorrection(fixture.plan.id, { predecessorId: correction.id }), /reconcile/);
  await assert.rejects(prepareTopicBranchCorrection(fixture.plan.id, {}), /reconciliation|owns/);
});

test('branch correction never retains a green validation when native edits arrive during validation', async t => {
  const fixture = await correctionFixture(t), correction = await prepareTopicBranchCorrection(fixture.plan.id, {});
  t.mock.method(OmniClient.prototype, 'getModelValidationRaw', async () => {
    branches.get('branch-1')!.files['records.view'] += '# changed during validation\n'; return [];
  });
  await applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true });
  const result = await correctionFinished(correction.id);
  assert.equal(result.status, 'partial'); assert.equal(result.filesVerified, false); assert.equal(result.validation.status, 'unavailable');
});

test('branch correction accepts recovered historical origin but rejects a later failed verification', async t => {
  const fixture = await correctionFixture(t, true);
  assert.equal((await prepareTopicBranchCorrection(fixture.plan.id, {})).status, 'ready');
  branches.get('branch-1')!.files['unrelated.view'] = 'dimensions: {}\n';
  const later = await verifyTopicMigrationBranch(fixture.plan.id, { revision: fixture.plan.revision, requestId: randomUUID() });
  assert.equal(later.verification.verified, false);
  await assert.rejects(prepareTopicBranchCorrection(fixture.plan.id, {}), /latest|verification|audit/i);
});

test('branch correction does not call acknowledged writes rejected when readback is forbidden', async t => {
  const fixture = await correctionFixture(t), correction = await prepareTopicBranchCorrection(fixture.plan.id, {});
  const read = OmniClient.prototype.getModelYaml;
  let forbiddenRead = false;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (modelId: string, options: Parameters<OmniClient['getModelYaml']>[1] = {}) {
    if (forbiddenRead && options.branchId && !options.includeSchemas) { forbiddenRead = false; throw new OmniClientError(403, 'https://target.example.omniapp.co', 'Fictional denied read'); }
    return read.call(this, modelId, options);
  });
  t.mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: Parameters<OmniClient['updateModelYamlFile']>[0], guard?: Parameters<OmniClient['updateModelYamlFile']>[1]) => {
    guard?.assertCanDispatch(); branches.get('branch-1')!.files[input.fileName] = input.yaml; forbiddenRead = true; return { success: true };
  });
  await applyTopicBranchCorrection(correction.id, { revision: correction.revision, approve: true });
  const result = await correctionFinished(correction.id);
  assert.equal(result.status, 'uncertain'); assert.equal(result.outcomes[0].status, 'unknown');
  assert.equal((await reconcileTopicBranchCorrection(correction.id)).status, 'applied');
});

function caseMappedInput() {
  sourceFiles['records.view'] = sourceFiles['records.view'].replace('table_name: records', 'table_name: RECORDS');
  tableNameSchemas.set('example.data', { 'example.data/records.view': 'catalog: example\nschema: data\ntable_name: records\ndimensions: {}\n' });
  return { ...request(), schemaMapText: 'SOURCE.PUBLIC -> example.data' };
}

function dialectMappedInput() {
  const input = caseMappedInput();
  tableNameSchemas.set('example.data', { 'example.data/records.view': 'catalog: example\nschema: data\ntable_name: records\ndimensions:\n  id:\n    sql: "`ID`"\n' });
  return input;
}

/** Recreate an already-saved legacy review; new reviews deliberately do not translate SQL. */
async function legacyCompatibilityPlan(input: TopicMigrationRequest, includeColumns = true) {
  const plan = await createTopicMigrationPlan(input);
  const client = new OmniClient(getInstance('target')!);
  const inventories = await readTopicMigrationTableNameEvidence(plan.files, namespace => client.getModelYaml('target-model', {
    includeSchemas: namespace, fullyResolved: true,
  }), undefined, { includeColumns });
  const analysis = buildTopicMigrationAnalysis({ request: input, sourceFiles, targetFiles,
    targetChecksums: Object.fromEntries(Object.entries(targetFiles).map(([name, yaml]) => [name, checksum(yaml)])),
    sourceDialect: 'snowflake', targetDialect: 'databricks', targetTableNames: inventories, enableSqlDialectReview: includeColumns });
  const location = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(location, 'utf8'));
  const row = rows.find((candidate: { plan: TopicMigrationPlan }) => candidate.plan.id === plan.id);
  Object.assign(row.plan, analysis, { tableNameEvidenceHash: 'sha256:' + createHash('sha256').update(JSON.stringify(inventories)).digest('hex') });
  const proofPlan = Object.fromEntries(Object.entries(row.plan).filter(([key]) => !['revision', 'status', 'jobId', 'branchReceipt'].includes(key)));
  row.plan.revision = createHash('sha256').update(JSON.stringify({ plan: proofPlan, boundaryHash: row.boundaryHash, targetFiles: row.targetFiles,
    requiresPr: row.requiresPr, branchName: row.branchName })).digest('hex');
  writeFileSync(location, JSON.stringify(rows));
  return getTopicMigrationPlan(plan.id);
}

test('new topic plans leave SQL and physical spelling for branch-bound Blobby repair', async () => {
  const input = dialectMappedInput(), sourceBefore = structuredClone(sourceFiles), mainBefore = structuredClone(targetFiles);
  const plan = await createTopicMigrationPlan(input);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(tableNameReads, [], 'Do not fetch column inventories for the retired custom converter.');
  assert.equal(plan.sqlDialectPolicy, undefined);
  assert.equal(plan.tableNameEvidenceHash, undefined);
  const file = plan.files.find(file => file.kind === 'view')!;
  assert.equal(parse(file.proposed).table_name, 'RECORDS');
  assert.equal(parse(file.proposed).dimensions.id.sql, '${TABLE}."ID"');
  assert.equal(parse(file.proposed).catalog, 'example');
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(parse(branches.get('branch-1')!.files[file.fileName]).dimensions.id.sql, '${TABLE}."ID"');
  assert.deepEqual(sourceFiles, sourceBefore); assert.deepEqual(targetFiles, mainBefore);
});

test('legacy sql dialect backend binds metadata, executes approved conversions, and preserves source and main', async () => {
  const input = dialectMappedInput(), sourceBefore = structuredClone(sourceFiles), mainBefore = structuredClone(targetFiles);
  const plan = await legacyCompatibilityPlan(input);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(tableNameReads, ['example.data'], 'Columns reuse the same namespace read as table names.');
  assert.equal(plan.sqlDialectPolicy?.targetDialect, 'databricks');
  const file = plan.files.find(file => file.kind === 'view')!;
  assert.equal(parse(file.proposed).dimensions.id.sql, '${TABLE}.`ID`');
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(parse(branches.get('branch-1')!.files[file.fileName]).dimensions.id.sql, '${TABLE}.`ID`');
  assert.deepEqual(sourceFiles, sourceBefore); assert.deepEqual(targetFiles, mainBefore);
});

test('sql dialect backend rejects changed connection dialect even when generated SQL could be identical', async (t) => {
  const plan = await legacyCompatibilityPlan(dialectMappedInput());
  t.mock.method(OmniClient.prototype, 'listConnections', async () => [
    { id: 'source-connection', name: 'Example source', dialect: 'snowflake' },
    { id: 'target-connection', name: 'Example destination', dialect: 'bigquery' },
  ]);
  await assert.rejects(stage(plan), /changed after review/);
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('sql dialect backend rejects changed column evidence before any write', async () => {
  const plan = await legacyCompatibilityPlan(dialectMappedInput());
  const files = tableNameSchemas.get('example.data')!;
  files['example.data/records.view'] = files['example.data/records.view'].replace('`ID`', '`OTHER_ID`');
  await assert.rejects(stage(plan), /changed after review/);
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('sql dialect backend leaves historical spelling-only approvals unchanged', async () => {
  const plan = await legacyCompatibilityPlan(request(), false), location = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(location, 'utf8'));
  const row = rows.find((candidate: { plan: TopicMigrationPlan }) => candidate.plan.id === plan.id);
  const oldAnalysis = buildTopicMigrationAnalysis({ request: request(), sourceFiles, targetFiles,
    sourceDialect: 'snowflake', targetDialect: 'databricks', targetTableNames: [{ namespace: 'SOURCE.PUBLIC', status: 'unavailable', tableNames: [] }] });
  row.plan.files = oldAnalysis.files; row.plan.issues = oldAnalysis.issues; delete row.plan.sqlDialectPolicy;
  const proofPlan = Object.fromEntries(Object.entries(row.plan).filter(([key]) => !['revision', 'status', 'jobId', 'branchReceipt'].includes(key)));
  row.plan.revision = createHash('sha256').update(JSON.stringify({ plan: proofPlan, boundaryHash: row.boundaryHash, targetFiles: row.targetFiles,
    requiresPr: row.requiresPr, branchName: row.branchName })).digest('hex');
  writeFileSync(location, JSON.stringify(rows));
  const historical = await getTopicMigrationPlan(plan.id);
  const job = await finished((await stage(historical)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(parse(branches.get('branch-1')!.files['records.view']).dimensions.id.sql, '${TABLE}."ID"');
  assert.equal((await getTopicMigrationPlan(plan.id)).sqlDialectPolicy, undefined);
});

test('table-name planning reviews and executes schema-backed spelling without SQL or main changes', async () => {
  const input = caseMappedInput(), sourceBefore = structuredClone(sourceFiles), mainBefore = structuredClone(targetFiles);
  const plan = await legacyCompatibilityPlan(input, false);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.match(plan.tableNameEvidenceHash || '', /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(tableNameReads, ['example.data']);
  const file = plan.files.find(file => file.kind === 'view')!;
  assert.deepEqual(file.tableNameCorrection, { namespace: 'example.data', from: 'RECORDS', to: 'records' });
  assert.equal(parse(file.proposed).table_name, 'records');
  assert.equal(parse(file.proposed).dimensions.id.sql, parse(sourceFiles['records.view']).dimensions.id.sql);
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(parse(branches.get('branch-1')!.files[file.fileName]).table_name, 'records');
  assert.deepEqual(targetFiles, mainBefore); assert.deepEqual(sourceFiles, sourceBefore);
  assert.ok(tableNameReads.length > 1, 'Fresh metadata is required at write boundaries.');
});

test('table-name planning rejects changed schema evidence before dispatch', async () => {
  const plan = await legacyCompatibilityPlan(caseMappedInput(), false);
  const files = tableNameSchemas.get('example.data')!;
  files['example.data/ambiguous.view'] = files['example.data/records.view'].replace('table_name: records', 'table_name: RECORDS');
  await assert.rejects(stage(plan), /changed after review/);
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('table-name planning leaves uncertain names unchanged instead of guessing', async () => {
  const input = caseMappedInput(); tableNameSchemas.clear();
  const plan = await legacyCompatibilityPlan(input, false);
  assert.equal(plan.status, 'ready');
  const file = plan.files.find(file => file.kind === 'view')!;
  assert.equal(parse(file.proposed).table_name, 'RECORDS'); assert.equal(file.tableNameCorrection, undefined);
  assert.ok(plan.issues.some(issue => issue.title === 'Destination table-name metadata unavailable' && issue.severity === 'review'));
});

test('table-name planning stops before YAML when metadata changes after branch creation', async (t) => {
  const plan = await legacyCompatibilityPlan(caseMappedInput(), false);
  t.mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }) => {
    branchCreates++;
    branches.set('branch-1', { name: input.branchName, files: structuredClone(targetFiles) });
    tableNameSchemas.clear();
    return { id: 'branch-1', name: input.branchName, raw: {} };
  });
  const job = await finished((await stage(plan)).job.id);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 0);
  assert.equal(job.items.find(item => item.kind === 'model_yaml_write')?.status, 'failed');
  assert.deepEqual(branches.get('branch-1')!.files, targetFiles);
});

test('topic branch naming validates UTC calendar names, legacy identities and readable collisions', () => {
  const at = Date.parse('2024-02-29T13:04:05.006Z'), base = 'omnikit-topics-2024-02-29-13-04-05-006-utc';
  assert.equal(createTopicMigrationBranchName(at), base);
  assert.equal(createTopicMigrationBranchName(at, [base.toUpperCase(), base + '-2']), base + '-3');
  for (const name of [base, base + '-2', base + '-1000', 'omnikit-topics-11111111-1111-4111-8111-111111111111']) assert.equal(isTopicMigrationBranchName(name), true);
  for (const name of [base + '-1', base + '-02', base + '-0', base + '-100000', base + '-Bearer-fictional-secret',
    base.replace('2024-02-29', '2025-02-29'), base.replace('-13-', '-24-'), base.replace('-05-', '-60-'),
    base.replace('-006-', '-06-'), base.replace('-utc', '-UTC'), 'omnikit-topics-token-fictional-secret']) assert.equal(isTopicMigrationBranchName(name), false, name);
  assert.equal(isTopicMigrationBranchNameForPlan('omnikit-topics-11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isTopicMigrationBranchNameForPlan('omnikit-topics-11111111-1111-4111-8111-111111111111', randomUUID()), false);
  for (const invalid of [NaN, Infinity, -1, 1.5, 253402300800000]) assert.throws(() => createTopicMigrationBranchName(invalid));
});

test('topic branch naming gives new plans UTC names without changing UUIDs or same-millisecond predecessors', async (t) => {
  const at = Date.parse('2026-03-04T05:06:07.008Z'); t.mock.method(Date, 'now', () => at);
  sourceFiles['SOURCE.PUBLIC/records.view'] = sourceFiles['records.view']; delete sourceFiles['records.view'];
  const input = { ...request(), schemaMapText: 'SOURCE.PUBLIC -> omni_example.data' };
  const first = await createTopicMigrationPlan(input);
  sourceFiles['example.topic'] += 'label: Another reviewed source snapshot\n';
  const second = await createTopicMigrationPlan(input);
  assert.equal(first.status, 'ready'); assert.equal(second.status, 'ready', JSON.stringify(second.issues));
  assert.match(first.id, /^[a-f0-9-]{36}$/); assert.notEqual(first.id, second.id);
  const rows = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  const firstName = rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === first.id).branchName;
  const secondName = rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === second.id).branchName;
  assert.equal(firstName, 'omnikit-topics-2026-03-04-05-06-07-008-utc'); assert.equal(secondName, firstName + '-2');
  assert.equal(secondName.includes(second.id), false);
  assert.equal((await createTopicMigrationPlan(input)).id, second.id, 'An existing review is not renamed.');
  const job = await finished((await stage(second)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal((job.details?.branchReceipt as { branchName: string }).branchName, secondName);
  assert.deepEqual(sanitizeJob(job), job, 'Date names and approved mapped file paths survive exact history sanitization.');
  const after = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  assert.deepEqual(after.find((row: { plan: TopicMigrationPlan }) => row.plan.id === first.id), rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === first.id));
});

test('topic branch naming preserves legacy saved names, exact proofs and verification audits', async () => {
  const plan = await ready(), location = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(location, 'utf8'));
  const row = rows.find((candidate: { plan: TopicMigrationPlan }) => candidate.plan.id === plan.id);
  row.branchName = 'omnikit-topics-' + plan.id;
  const proofPlan = Object.fromEntries(Object.entries(row.plan).filter(([key]) => !['revision', 'status', 'jobId', 'branchReceipt'].includes(key)));
  row.plan.revision = createHash('sha256').update(JSON.stringify({ plan: proofPlan, boundaryHash: row.boundaryHash, targetFiles: row.targetFiles,
    sourceSchemaHash: row.sourceSchemaHash, targetSchemaHash: row.targetSchemaHash, sourceSchemaEvidenceHash: row.sourceSchemaEvidenceHash,
    targetSchemaEvidenceHash: row.targetSchemaEvidenceHash, tableMappingsHash: row.tableMappingsHash, requiresPr: row.requiresPr,
    branchName: row.branchName, dashboardRepair: row.dashboardRepair, ...(row.supersedes ? { supersedes: row.supersedes } : {}) })).digest('hex');
  writeFileSync(location, JSON.stringify(rows));
  const legacy = getTopicMigrationPlan(plan.id);
  assert.equal((await createTopicMigrationPlan(request())).revision, legacy.revision);
  injectUnrelatedFile = true;
  const job = await finished((await stage(legacy)).job.id);
  assert.equal(job.items.find(item => item.kind === 'model_branch_create')?.details?.branchName, row.branchName);
  assert.equal(job.items.find(item => item.kind === 'model_yaml_write')?.status, 'succeeded');
  delete branches.get('branch-1')!.files['unrelated.view'];
  const result = await verifyTopicMigrationBranch(legacy.id, { revision: legacy.revision, requestId: randomUUID() });
  assert.equal(result.verification.verified, true); assert.equal(result.verification.branchName, row.branchName);
  assert.deepEqual(sanitizeJob(result.job).details?.branchVerifications, result.job.details?.branchVerifications);
  const dirtyName = 'omnikit-topics-2026-03-04-05-06-07-008-utc Bearer fictional-secret';
  assert.doesNotMatch(JSON.stringify(sanitizeJob({ ...job, details: { ...job.details, branchName: dirtyName } }).details), /fictional-secret/);
});

test('topic branch naming rejects a preexisting remote name before any dispatch or write', async () => {
  const plan = await ready();
  const rows = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  const name = rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id).branchName;
  branches.set('preexisting', { name, files: structuredClone(targetFiles) });
  const job = await finished((await stage(plan)).job.id);
  const create = job.items.find(item => item.kind === 'model_branch_create')!, lease = job.items.find(item => item.kind === 'destination_model_mutation')!;
  assert.equal(create.status, 'failed'); assert.match(create.error || '', /already exists/);
  assert.equal(lease.details?.migrationMutationState, 'failed_prewrite');
  assert.equal(lease.details?.migrationMutationDispatchedAt, undefined);
  assert.equal(lease.details?.migrationMutationDispatchItemId, undefined);
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
  assert.deepEqual(branches.get('preexisting'), { name, files: targetFiles });
  assert.equal(job.details?.branchReceipt, undefined);
});

async function failedBranchReadback(reviewRequest?: TopicMigrationRequest) {
  injectUnrelatedFile = true;
  const plan = reviewRequest ? await createTopicMigrationPlan(reviewRequest) : await ready();
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.items.find(item => item.kind === 'model_yaml_write')?.status, 'succeeded');
  assert.equal(job.items.find(item => item.kind === 'model_branch_verify')?.status, 'failed');
  delete branches.get('branch-1')!.files['unrelated.view'];
  injectUnrelatedFile = false;
  return { plan, job };
}

test('fresh comparison preserves authored SQL for Blobby without replaying a verified submitted run', async () => {
  const { plan, job } = await failedBranchReadback();
  await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  const oldPlan = structuredClone(getTopicMigrationPlan(plan.id)), oldJob = structuredClone(getJob(job.id));
  const input = dialectMappedInput();
  // The purpose of a new comparison can be a changed source or destination snapshot.
  targetFiles.model = '# current target snapshot\n{}\n';
  const response = await post('topic-plan', { ...input, comparisonOfPlanId: plan.id });
  assert.equal(response.status, 200, await response.clone().text());
  const fresh = (await response.json()).plan as TopicMigrationPlan;
  assert.notEqual(fresh.id, plan.id); assert.equal(fresh.status, 'blocked');
  assert.equal(fresh.jobId, undefined); assert.equal(fresh.branchReceipt, undefined);
  assert.equal(fresh.comparisonOnly?.ofPlanId, plan.id);
  assert.deepEqual(fresh.comparisonOnly?.priorRuns.map(run => [run.planId, run.jobId]), [[plan.id, job.id]]);
  assert.equal(parse(fresh.files.find(file => file.kind === 'view')!.proposed).dimensions.id.sql, '${TABLE}."ID"');
  assert.equal((await createTopicMigrationPlan({ ...input, comparisonOfPlanId: plan.id })).id, fresh.id, 'Repeated comparisons reuse unchanged evidence.');
  await assert.rejects(stage(fresh), /comparison is read-only/);
  assert.deepEqual(getTopicMigrationPlan(plan.id), oldPlan); assert.deepEqual(getJob(job.id), oldJob);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('fresh comparison preserves ordinary retry behavior and rejects status-only approval tampering', async () => {
  const plan = await ready(), job = await finished((await stage(plan)).job.id);
  const fresh = await createTopicMigrationPlan({ ...request(), comparisonOfPlanId: plan.id });
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(historyPath, 'utf8'));
  rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === fresh.id).plan.status = 'ready';
  writeFileSync(historyPath, JSON.stringify(rows));
  await assert.rejects(stage(fresh), /comparison is read-only/);
  assert.equal((await stage(plan)).job.id, job.id);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('fresh comparison requires a submitted exact-scope standalone reference', async () => {
  const plan = await ready();
  await assert.rejects(createTopicMigrationPlan({ ...request(), comparisonOfPlanId: plan.id }), /submitted standalone run/);
  await finished((await stage(plan)).job.id);
  for (const input of [
    { ...request(), topicIds: ['different.topic'] },
    { ...request(), targetModelId: 'other-model' },
    { ...request(), sourceInstanceId: 'target' },
  ]) await assert.rejects(createTopicMigrationPlan({ ...input, comparisonOfPlanId: plan.id }), /submitted standalone run|unavailable|no longer authorize/);
  await assert.rejects(createTopicMigrationPlan({ ...request(), comparisonOfPlanId: 'missing-plan' }), /submitted standalone run/);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('fresh comparison stays read-only when a prior job is missing or an uncertain submission exists', async () => {
  const plan = await ready();
  await assert.rejects(stageTopicMigrationPlan(plan.id, { revision: plan.revision, approve: true }, async () => { throw new Error('Fictional lost submission'); }), /lost submission/);
  const fresh = await createTopicMigrationPlan({ ...request(), comparisonOfPlanId: plan.id });
  assert.equal(fresh.comparisonOnly?.priorRuns[0].planId, plan.id);
  assert.equal(fresh.comparisonOnly?.priorRuns[0].jobId, undefined);
  await assert.rejects(stage(fresh), /comparison is read-only/);
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('branch verification recovery appends independent evidence without replay or changing original outcomes', async (t) => {
  const { plan, job } = await failedBranchReadback();
  const read = t.mock.method(OmniClient.prototype, 'getModelYaml', OmniClient.prototype.getModelYaml);
  const requestId = randomUUID();
  const response = await post(`topic-plan/${plan.id}/verify`, { revision: plan.revision, requestId });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { job: MigrationJob; verification: BranchVerificationRecord };
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.actualHash, result.verification.expectedHash);
  assert.equal(result.verification.planRevision, plan.revision);
  assert.equal(result.job.status, job.status); assert.deepEqual(result.job.items, JSON.parse(JSON.stringify(job.items)));
  assert.equal(result.job.details?.branchReceipt, undefined);
  assert.equal(result.job.endedAt, job.endedAt);
  const readCount = read.mock.callCount();
  const duplicate = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId });
  assert.equal(read.mock.callCount(), readCount, 'An idempotent request does not re-read or replay anything.');
  assert.deepEqual(duplicate.verification, result.verification);
  assert.equal((duplicate.job.details?.branchVerifications as unknown[]).length, 1);
  branches.get('branch-1')!.files['records.view'] += 'hidden: true\n';
  const failed = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(failed.verification.verified, false);
  assert.equal((failed.job.details?.branchVerifications as BranchVerificationRecord[]).at(-1)?.verified, false);
  assert.deepEqual(failed.job.items, job.items);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
  assert.deepEqual(sanitizeJob(failed.job).details?.branchVerifications, failed.job.details?.branchVerifications);
});

test('branch verification recovery rejects incomplete, uncertain, adjudicated, active and dashboard jobs', async () => {
  const { plan, job } = await failedBranchReadback();
  const owner = (value: MigrationJob) => value.items.find(item => item.kind === 'destination_model_mutation')!;
  const changes: Array<(value: MigrationJob) => void> = [
    value => { value.status = 'running'; }, value => { value.status = 'canceled'; },
    value => { value.items.find(item => item.kind === 'model_yaml_write')!.status = 'failed'; },
    value => { value.items.find(item => item.kind === 'model_yaml_write')!.details!.branchId = 'other'; },
    value => { value.items.find(item => item.kind === 'model_branch_verify')!.status = 'running'; },
    value => { owner(value).details!.migrationMutationState = 'uncertain'; },
    value => { owner(value).details!.migrationMutationDispatchItemId = 'other'; },
    value => { owner(value).details!.migrationMutationResolutionKind = 'operator_adjudication'; },
    value => { owner(value).details!.migrationMutationExternalJobId = 'external'; },
    value => { value.details!.migrationMutationAdjudications = []; },
    value => { value.details!.dashboardRepair = { planId: 'other' }; },
    value => { value.items.push({ ...owner(value), id: 'duplicate' }); },
  ];
  for (const change of changes) {
    const invalid = structuredClone(job); change(invalid); insertJob(invalid);
    await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }));
    assert.equal(getJob(job.id)?.details?.branchVerifications, undefined);
  }
  insertJob(job);
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: 'stale', requestId: randomUUID() }));
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: 'invalid' }));
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID(), approve: true }));
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch verification recovery records unavailable evidence honestly and rejects source or main drift', async (t) => {
  const { plan, job } = await failedBranchReadback();
  for (const files of [sourceFiles, targetFiles]) {
    const original = files.model; files.model += '# drift\n';
    const result = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
    assert.equal(result.verification.verified, false); assert.ok(result.verification.actualHash);
    assert.ok(result.verification.files.length > 0);
    assert.ok(result.verification.files.every(file => file.classification !== 'mismatch'));
    assert.ok(result.verification.findings.some(finding => finding.code === (files === sourceFiles ? 'SOURCE_MODEL_CHANGED' : 'DESTINATION_FILE_CHANGED')));
    files.model = original;
  }
  const name = branches.get('branch-1')!.name;
  branches.get('branch-1')!.name = 'different';
  const missing = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(missing.verification.actualHash, null);
  assert.equal(missing.verification.findings[0].code, 'BRANCH_IDENTITY_CHANGED');
  branches.get('branch-1')!.name = name;
  const originalRead = OmniClient.prototype.getModelYaml;
  const read = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    if (args[1]?.branchId) throw new Error('Bearer fictional-untrusted-read-error');
    return originalRead.apply(this, args);
  });
  const unavailable = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(unavailable.verification.actualHash, null); assert.equal(unavailable.verification.verified, false);
  assert.deepEqual(unavailable.verification.files, [], 'Unread files must not be reported as mismatches.');
  assert.doesNotMatch(JSON.stringify(unavailable.verification), /fictional-untrusted/);
  read.mock.restore();
  const recovered = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(recovered.verification.verified, true); assert.deepEqual(recovered.job.items, job.items);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch drift review reads copied files after destination additions without changing approval or replaying writes', async (t) => {
  const write = OmniClient.prototype.updateModelYamlFiles;
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async function (this: OmniClient, ...args: Parameters<OmniClient['updateModelYamlFiles']>) {
    const result = await write.apply(this, args);
    targetFiles['physical_records.view'] = 'table_name: physical_records\ndimensions: {}\n';
    branches.get(args[0].branchId)!.files['physical_records.view'] = targetFiles['physical_records.view'];
    return result;
  });
  const plan = await ready(), job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'partial');
  assert.match(job.items.find(item => item.kind === 'model_branch_verify')!.error || '', /DESTINATION_FILE_ADDED: physical_records.view/);
  const savedPlan = structuredClone(getTopicMigrationPlan(plan.id));
  const result = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(result.verification.verified, false); assert.ok(result.verification.actualHash);
  assert.ok(result.verification.files.length > 0);
  assert.ok(result.verification.files.every(file => file.classification !== 'mismatch'));
  assert.ok(result.verification.findings.some(finding => finding.code === 'DESTINATION_FILE_ADDED' && finding.fileName === 'physical_records.view'));
  assert.ok(result.verification.findings.some(finding => finding.code === 'UNEXPECTED_FILE'));
  assert.deepEqual(getTopicMigrationPlan(plan.id), savedPlan);
  assert.deepEqual(result.job.items, job.items); assert.equal(result.job.status, job.status);
  assert.equal(result.job.details?.branchReceipt, undefined);
  assert.deepEqual(sanitizeJob(result.job).details?.branchVerifications, result.job.details?.branchVerifications);
  assert.equal((await stage(plan)).job.id, job.id, 'Consumed approval only returns its original run.');
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch drift review reports removed files and bounds added-file diagnostics without inventing causes', async () => {
  const { plan, job } = await failedBranchReadback();
  delete targetFiles.model;
  const removed = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.ok(removed.verification.findings.some(finding => finding.code === 'DESTINATION_FILE_REMOVED' && finding.fileName === 'model'));
  assert.equal(removed.verification.verified, false); assert.ok(removed.verification.actualHash);
  targetFiles.model = '{}\n';
  for (let i = 0; i < 60; i++) targetFiles[`new_${i}.view`] = 'table_name: available\n';
  const added = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(added.verification.findings.filter(finding => finding.code === 'DESTINATION_FILE_ADDED').length, 50);
  assert.match(added.verification.findings.find(finding => finding.code === 'DESTINATION_CHANGES_TRUNCATED')!.message, /10 additional/);
  assert.equal(added.verification.verified, false);
  assert.deepEqual(added.job.items, job.items); assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch drift review refuses changed authority and unstable branch reads without placeholder mismatches', async (t) => {
  const { plan } = await failedBranchReadback();
  const list = t.mock.method(OmniClient.prototype, 'listModels', async () => [
    { id: 'source-model', connectionId: 'source-connection' },
    { id: 'target-model', connectionId: 'target-connection', pullRequestRequired: false, gitProtected: false },
  ]);
  const authority = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(authority.verification.actualHash, null); assert.deepEqual(authority.verification.files, []);
  assert.equal(authority.verification.findings[0].code, 'APPROVED_AUTHORITY_CHANGED');
  list.mock.restore();
  const originalRead = OmniClient.prototype.getModelYaml;
  let branchReads = 0;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await originalRead.apply(this, args);
    if (args[1]?.branchId && ++branchReads === 1) branches.get(args[1].branchId)!.files['records.view'] += '# concurrent edit\n';
    return response;
  });
  const unstable = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(unstable.verification.actualHash, null); assert.deepEqual(unstable.verification.files, []);
  assert.equal(unstable.verification.findings[0].code, 'BRANCH_SNAPSHOT_UNSTABLE');
  assert.equal(branchReads, 2); assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch verification recovery guards same-origin writers and rereads authority after awaited evidence', async (t) => {
  const { plan, job } = await failedBranchReadback();
  upsertInstance({ id: 'target-alias', role: 'destination', label: 'Example alias', baseUrl: 'https://target.example.omniapp.co',
    apiKey: 'fictional-alias-secret', metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] }, postMigrationActions: [] });
  const competing = structuredClone(job); competing.id = randomUUID(); competing.details = {}; competing.status = 'running';
  competing.destinationIds = ['target-alias'];
  competing.targets = competing.targets?.map(target => ({ ...target, destinationInstanceId: 'target-alias' }));
  competing.items = competing.items.map(item => ({ ...item, jobId: competing.id, destinationId: 'target-alias' }));
  insertJob(competing);
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /active/);
  competing.status = 'failed';
  competing.items.find(item => item.kind === 'destination_model_mutation')!.details!.migrationMutationState = 'uncertain';
  insertJob(competing);
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /unresolved/);
  competing.items.find(item => item.kind === 'destination_model_mutation')!.details!.migrationMutationState = 'resolved';
  insertJob(competing);
  const originalRead = OmniClient.prototype.getModelYaml;
  const read = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await originalRead.apply(this, args);
    if (args[1]?.branchId) { competing.status = 'running'; insertJob(competing); }
    return response;
  });
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /active/);
  assert.equal(getJob(job.id)?.details?.branchVerifications, undefined);
  read.mock.restore(); competing.status = 'failed'; insertJob(competing);
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await originalRead.apply(this, args);
    if (args[1]?.branchId) { const changed = getJob(job.id)!; changed.details = { ...changed.details, changedDuringRead: true }; insertJob(changed); }
    return response;
  });
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /changed during/);
  assert.equal(getJob(job.id)?.details?.branchVerifications, undefined);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch verification recovery audit sanitization preserves typed evidence but never arbitrary secrets', async () => {
  const { plan } = await failedBranchReadback();
  const { job, verification } = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  const numeric = { ...verification, expectedHash: 'sha256:' + '1234567890'.repeat(6) + '1234', actualHash: 'sha256:' + '9'.repeat(64),
    jobEvidenceHash: 'sha256:' + '1'.repeat(64) };
  const typed = { ...job, details: { ...job.details, branchVerifications: [numeric] } };
  assert.deepEqual(sanitizeJob(typed).details?.branchVerifications, [numeric]);
  for (const invalid of [{ ...numeric, expectedHash: 'Bearer fictional-secret' }, { ...numeric, apiKey: 'fictional-secret' },
    { ...numeric, findings: [{ code: 'READ_FAILURE', message: 'Bearer fictional-secret' }] },
    { ...numeric, files: [{ sourceFileName: 'omni_fictionalCredential.view', submittedFileName: 'omni_fictionalCredential.view', destinationFileName: 'omni_fictionalCredential.view', classification: 'exact' }] }]) {
    const sanitized = sanitizeJob({ ...job, details: { ...job.details, branchVerifications: [invalid], description: 'Bearer fictional-secret' } });
    assert.doesNotMatch(JSON.stringify(sanitized.details), /fictional-secret|omni_fictionalCredential/);
  }
});

test('branch verification recovery preserves authored topic paths with spaces', async () => {
  sourceFiles['Example Domain/example.topic'] = sourceFiles['example.topic']; delete sourceFiles['example.topic'];
  const { plan, job } = await failedBranchReadback({ ...request(), topicIds: ['Example Domain/example.topic'] });
  const result = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(result.verification.verified, true);
  assert.ok(result.verification.files.some(file => file.sourceFileName === 'Example Domain/example.topic'
    && file.submittedFileName === 'example.topic' && file.destinationFileName === 'Example Domain/example.topic'));
  assert.deepEqual(result.job.items, job.items);
});

test('branch verification normal afterWrite accepts formatting only but rejects untouched baseline changes', async (t) => {
  const write = OmniClient.prototype.updateModelYamlFiles;
  let alterBaseline = false;
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async function (this: OmniClient, ...args: Parameters<OmniClient['updateModelYamlFiles']>) {
    const result = await write.apply(this, args);
    const files = branches.get(args[0].branchId)!.files;
    for (const file of args[0].files) files[file.fileName] = stringify(parse(files[file.fileName]));
    if (alterBaseline) files.model += '# unrelated change\n';
    return result;
  });
  const first = await ready(), prepared = await finished((await stage(first)).job.id);
  assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared.items));
  assert.equal(prepared.items.find(item => item.kind === 'model_branch_verify')?.status, 'succeeded');
  // A different current authored snapshot creates a separately approved plan.
  sourceFiles['example.topic'] += 'label: Example changed review\n'; alterBaseline = true;
  const second = await ready(), failed = await finished((await stage(second)).job.id);
  assert.equal(failed.items.find(item => item.kind === 'model_yaml_write')?.status, 'succeeded');
  assert.equal(failed.items.find(item => item.kind === 'model_branch_verify')?.status, 'failed');
  assert.equal(failed.details?.branchReceipt, undefined);
});

test('branch verification canonical mapped submission writes approved paths and stores only the file count', async () => {
  sourceFiles['SOURCE.PUBLIC/records.view'] = sourceFiles['records.view']; delete sourceFiles['records.view'];
  const plan = await createTopicMigrationPlan({ ...request(), schemaMapText: 'SOURCE.PUBLIC -> omni_example.data' });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.ok(plan.files.some(file => file.sourceFileName === 'SOURCE.PUBLIC/records.view' && file.fileName === 'omni_example.data/records.view'));
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.ok(Object.hasOwn(branches.get('branch-1')!.files, 'omni_example.data/records.view'));
  const write = job.items.find(item => item.kind === 'model_yaml_write')!;
  assert.equal(write.details?.acceptedFileCount, plan.files.filter(file => ['create', 'add'].includes(file.status)).length);
  assert.equal(write.details?.files, undefined);
  assert.deepEqual(sanitizeJob(job).items, job.items);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

function dashboardFixture(requiredFiles = ['example.topic', 'records.view'], topicChoices?: DashboardTopicChoice[]) {
  const id = 'example-deployment';
  const targetId = 'example-destination';
  const repair = { planId: id, targetId, revision: 1, additiveOnly: true as const,
    sourceDocumentHashes: { 'example-document': hash(state) }, sourceWorkbookHashes: { 'source-workbook': hash(workbookFiles) },
    instanceBoundaryHash: dashboardRepairInstanceBoundaryHash('source', 'target', 'target-model', ['source-model']),
    sourceModelHashes: { 'source-model': hash(sourceFiles) }, targetModelHash: hash(targetFiles) };
  const plan: DashboardDeploymentPlan = {
    version: 2, id, revision: 1, evidenceVersion: DASHBOARD_READINESS_EVIDENCE_VERSION, createdAt: Date.now(), updatedAt: Date.now(),
    intent: { profile: 'safe_copy_v1', requestId: randomUUID(),
      source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['example-document'] },
      destinations: [{ targetId, instanceId: 'target', connectionId: 'target-connection', modelId: 'target-model', folderId: 'example-folder' }] },
    sourceHashes: repair.sourceDocumentHashes, sourceModelHashes: repair.sourceModelHashes, workbookCopies: {},
    targets: [{ targetId, status: 'model_changes_required', checkedAt: Date.now(), sourceModelIds: ['source-model'],
      requiredFiles, requiredFilesByModelId: { 'source-model': requiredFiles }, topicChoices, modelHash: hash(targetFiles), findings: [] }],
  };
  writeFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.deployment-plans.json', JSON.stringify([plan]));
  return repair;
}

test('branch review prepares exact additive bytes and a verified receipt, without validation or publication', async () => {
  const plan = await ready();
  assert.equal(plan.files.find((file) => file.fileName === 'records.view')?.proposed, sourceFiles['records.view']);
  const { job: submitted } = await stage(plan);
  const job = await finished(submitted.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.deepEqual(job.items.filter((item) => item.kind !== 'destination_model_mutation').map((item) => item.kind),
    ['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify']);
  const verify = job.items.find((item) => item.kind === 'model_branch_verify')!;
  assert.equal(verify.status, 'succeeded');
  const ownership = job.items.find((item) => item.kind === 'destination_model_mutation')!;
  assert.equal(ownership.status, 'succeeded');
  assert.equal(ownership.details?.migrationMutationState, 'resolved');
  assert.deepEqual(job.details?.branchReceipt, { modelId: 'target-model', branchId: 'branch-1', branchName: verify.details?.branchName });
  assert.deepEqual(getTopicMigrationPlan(plan.id).branchReceipt, job.details?.branchReceipt);
  assert.deepEqual(targetFiles, { model: '{}\n' });
  const duplicate = await stage(plan);
  assert.equal(duplicate.job.id, job.id);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('timestamp drift while saving YAML dispatch intent does not replay branch creation or file writes', async (t) => {
  const plan = await ready();
  const read = fs.readFileSync;
  let timestampChanged = false;
  const reader = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    const result = Reflect.apply(read, fs, args);
    if (!timestampChanged && branchCreates === 1 && yamlWrites === 0 && typeof args[0] === 'number' && Buffer.isBuffer(result)) {
      const rows = JSON.parse(result.toString('utf8')) as MigrationJob[];
      if (rows.some(row => row.items.some(item => item.details?.migrationMutationDispatchItemKind === 'model_yaml_write'
        && item.details?.migrationMutationState === 'dispatched'))) {
        timestampChanged = true;
        const date = new Date('2025-01-02T03:04:05.000Z');
        utimesSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, date, date);
      }
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const submitted = await stage(plan);
    const job = await finished(submitted.job.id);
    assert.equal(timestampChanged, true);
    assert.equal(job.status, 'succeeded');
    assert.ok(job.details?.branchReceipt);
    assert.equal(branchCreates, 1);
    assert.equal(yamlWrites, 1);
    assert.deepEqual(targetFiles, { model: '{}\n' });
    assert.equal((await stage(plan)).job.id, job.id);
    assert.equal(branchCreates, 1);
    assert.equal(yamlWrites, 1);
  } finally {
    reader.mock.restore(); syncBuiltinESMExports();
  }
});

test('history guard stops before dispatch and reports an unverified outcome to current and late subscribers', { timeout: 5_000 }, async (t) => {
  const plan = await ready();
  const originalRead = OmniClient.prototype.getModelYaml;
  let releaseRead = () => {};
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  let announcePaused = () => {};
  const readPaused = new Promise<void>(resolve => { announcePaused = resolve; });
  let paused = false;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    if (!paused && listJobs().some(job => job.status === 'running')) {
      paused = true;
      announcePaused();
      await readGate;
    }
    return originalRead.apply(this, args);
  });
  let unsubscribe = () => {};
  try {
    const { job } = await stage(plan);
    await readPaused;
    assert.equal(paused, true);
    const blocked = new Promise<MigrationJobEvent>(resolve => {
      unsubscribe = subscribeMigrationJobEvents(job.id, event => {
        if (event.type === 'history-unavailable') resolve(event);
      });
    });
    const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
    const changedBytes = readFileSync(historyPath, 'utf8') + '\n';
    writeFileSync(historyPath, changedBytes);
    releaseRead();
    const event = await blocked;
    assert.equal(event.type, 'history-unavailable');
    if (event.type === 'history-unavailable') {
      assert.equal(event.code, 'MIGRATION_HISTORY_UNAVAILABLE');
      assert.equal(event.diagnostic, 'content_changed');
    }
    assert.equal(branchCreates, 0);
    assert.equal(yamlWrites, 0);
    assert.equal(readFileSync(historyPath, 'utf8'), changedBytes, 'The rejected journal must not be overwritten.');
    const saved = await historyHandler(new Request('http://localhost/api/migration-jobs/' + job.id));
    assert.equal(saved.status, 503);
    const savedError = await saved.json();
    assert.equal(savedError.code, 'MIGRATION_HISTORY_UNAVAILABLE');
    assert.equal(savedError.diagnostic, 'content_changed');
    const stream = await historyHandler(new Request('http://localhost/api/migration-jobs/' + job.id + '/events'));
    assert.equal(stream.status, 200);
    const body = await stream.text();
    assert.match(body, /event: history-unavailable/);
    assert.match(body, /MIGRATION_HISTORY_UNAVAILABLE/);
    assert.match(body, /"diagnostic":"content_changed"/);
    assert.doesNotMatch(body, /event: snapshot|fictional-secret|base_view/);
    // Model the supported restart recovery; never repair or clear the live store.
    closeJobStoreForTests();
    const recovered = getJob(job.id)!;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.items.find(item => item.kind === 'destination_model_mutation')?.details?.migrationMutationState, 'failed_prewrite');
    const oldPlan = getTopicMigrationPlan(plan.id);
    const fresh = await ready();
    assert.notEqual(fresh.id, plan.id);
    assert.notEqual(fresh.revision, plan.revision);
    assert.equal(fresh.jobId, undefined);
    assert.deepEqual(getTopicMigrationPlan(plan.id), oldPlan, 'The old one-use approval is preserved.');
    assert.equal((await stage(plan)).job.id, job.id, 'The old approval never starts a replacement job.');
    assert.equal(branchCreates, 0);
    await assert.rejects(stageTopicMigrationPlan(fresh.id, { revision: fresh.revision, approve: false }, createModelMigrationJob), /approv/i);
    const replacement = await finished((await stage(fresh)).job.id);
    assert.equal(replacement.status, 'succeeded');
    assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
    assert.equal((await createTopicMigrationPlan(request())).id, fresh.id, 'An older safe failure must not hide a later completed claim.');
  } finally {
    releaseRead();
    unsubscribe();
  }
});

test('prewrite recovery keeps ambiguous, active, malformed, and remotely written jobs as tombstones', async (t) => {
  const plan = await ready();
  const originalRead = OmniClient.prototype.getModelYaml;
  let readFailed = false;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    if (!readFailed && listJobs().some(job => job.status === 'running')) {
      readFailed = true;
      throw new Error('Fictional evidence read failed before dispatch.');
    }
    return originalRead.apply(this, args);
  });
  const stopped = await finished((await stage(plan)).job.id);
  assert.equal(stopped.items.find(item => item.kind === 'destination_model_mutation')?.details?.migrationMutationState, 'failed_prewrite');
  const owner = (job: MigrationJob) => job.items.find(item => item.kind === 'destination_model_mutation')!;
  const mutations: Array<(job: MigrationJob) => void> = [
    job => { job.status = 'running'; },
    job => { owner(job).details!.migrationMutationState = 'uncertain'; },
    job => { owner(job).details!.migrationMutationState = 'resolved'; },
    job => { owner(job).details!.migrationMutationDispatchItemId = ''; },
    job => { owner(job).details!.migrationMutationDispatchedAt = 0; },
    job => { owner(job).details!.migrationMutationBranchId = ''; },
    job => { owner(job).details!.migrationMutationResolutionKind = 'operator_adjudication'; },
    job => { job.details!.migrationMutationAdjudications = []; },
    job => { job.items.find(item => item.kind === 'model_branch_create')!.status = 'succeeded'; },
    job => { job.items.find(item => item.kind === 'model_branch_create')!.details!.branchId = 'recorded-branch'; },
    job => { owner(job).jobId = 'different-job'; },
    job => { job.items = job.items.filter(item => item.kind !== 'destination_model_mutation'); },
    job => { job.items.push({ ...owner(job), id: 'duplicate-owner' }); },
    job => { job.items.find(item => item.kind === 'model_translate')!.details!.migrationDestinationModelMutation = true; },
    job => {
      const translate = job.items.find(item => item.kind === 'model_translate')!;
      translate.details = { ...translate.details, ...owner(job).details }; translate.status = 'failed';
      job.items = job.items.filter(item => item.kind !== 'destination_model_mutation');
    },
    job => { (job.details!.topicMigration as { revision: string }).revision = 'different-review'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(stopped); mutate(changed); insertJob(changed);
    assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  }
  insertJob(stopped);
  const fresh = await ready();
  readFailed = false;
  const otherStopped = await finished((await stage(fresh)).job.id);
  assert.equal(otherStopped.items.find(item => item.kind === 'destination_model_mutation')?.details?.migrationMutationState, 'failed_prewrite');
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(store, 'utf8'));
  rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id).plan.jobId = otherStopped.id;
  writeFileSync(store, JSON.stringify(rows));
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id, 'A different plan cannot borrow another job\'s prewrite proof.');
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

async function reconciledNoWrite(t: TestContext) {
  const plan = await ready();
  const writer = t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async () => {
    yamlWrites += 1;
    throw new Error('Fictional request failed without applying files.');
  });
  const stopped = await finished((await stage(plan)).job.id);
  writer.mock.restore();
  const owner = stopped.items.find(item => item.kind === 'destination_model_mutation')!;
  const details = owner.details!;
  assert.equal(details.migrationMutationState, 'uncertain');
  const result = adjudicateDestinationModelMutation(stopped.id, {
    requestId: randomUUID(), itemId: owner.id, expectedRevision: details.migrationMutationRevision as number,
    expectedUpdatedAt: details.migrationMutationUpdatedAt as number, destinationInstanceId: owner.destinationId,
    targetModelId: owner.targetModelId!, operation: details.migrationMutationOperation as string,
    dispatchItemId: details.migrationMutationDispatchItemId as string, dispatchItemKind: details.migrationMutationDispatchItemKind as string,
    dispatchFingerprint: details.migrationMutationDispatchFingerprint as string,
    outcome: 'verified_not_applied', evidenceSource: 'omni_api', note: 'Fictional branch readback matches baseline; no request remains in flight.',
    confirmCurrentStateInspected: true, confirmNoOperationInFlight: true,
  });
  return { plan, resolved: result.job };
}

test('reconciled not-applied YAML permits a separately approved new plan without changing or replaying the original', async (t) => {
  const { plan, resolved } = await reconciledNoWrite(t);
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const original = JSON.parse(readFileSync(store, 'utf8')).find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id);
  const fresh = await ready();
  assert.notEqual(fresh.id, plan.id); assert.notEqual(fresh.revision, plan.revision);
  assert.equal(fresh.jobId, undefined);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1, 'A new preview must not dispatch any write.');
  const rows = JSON.parse(readFileSync(store, 'utf8'));
  assert.deepEqual(rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id), original);
  assert.deepEqual(rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === fresh.id).supersedes, [{ planId: plan.id, jobId: resolved.id }]);
  assert.deepEqual(getJob(resolved.id), resolved);
  await assert.rejects(stageTopicMigrationPlan(fresh.id, { revision: plan.revision, approve: true }, createModelMigrationJob), /revision changed/);
  await assert.rejects(stageTopicMigrationPlan(fresh.id, { revision: fresh.revision, approve: false }, createModelMigrationJob), /Approve/);
  assert.equal((await stage(plan)).job.id, resolved.id);
  assert.equal(branchCreates, 1);
  const completed = await finished((await stage(fresh)).job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(branchCreates, 2); assert.equal(yamlWrites, 2);
  assert.deepEqual(branches.get('branch-1')!.files, targetFiles, 'The retained branch stays untouched.');
  assert.deepEqual(getJob(resolved.id), resolved);
  assert.deepEqual(targetFiles, { model: '{}\n' });
  assert.equal((await createTopicMigrationPlan(request())).id, fresh.id, 'The later successful approval must not be superseded by older recovery evidence.');
});

test('reconciled recovery rejects missing, partial, mismatched, active and ambiguous audit evidence', async (t) => {
  const { plan, resolved } = await reconciledNoWrite(t);
  const owner = (job: MigrationJob) => job.items.find(item => item.kind === 'destination_model_mutation')!;
  const audit = (job: MigrationJob) => (job.details!.migrationMutationAdjudications as Array<Record<string, unknown>>)[0];
  const mutations: Array<(job: MigrationJob) => void> = [
    job => { job.status = 'running'; },
    job => { owner(job).details!.migrationMutationState = 'uncertain'; },
    job => { owner(job).details!.migrationMutationResolutionOutcome = 'verified_applied'; },
    job => { owner(job).details!.migrationMutationResolutionOutcome = 'verified_partial_terminal'; audit(job).outcome = 'verified_partial_terminal'; },
    job => { delete job.details!.migrationMutationAdjudications; },
    job => { audit(job).dispatchFingerprint = '0'.repeat(64); },
    job => { audit(job).resolvedRevision = 999; },
    job => { audit(job).targetModelId = 'different-model'; },
    job => { audit(job).requestHash = 'invalid'; },
    job => { owner(job).details!.migrationMutationResolutionActor = 'unknown'; },
    job => { job.items.find(item => item.kind === 'model_yaml_write')!.status = 'succeeded'; },
    job => { job.items.find(item => item.kind === 'model_branch_verify')!.status = 'succeeded'; },
    job => { job.items.push({ ...owner(job), id: 'duplicate-owner' }); },
    job => { (job.details!.migrationMutationAdjudications as unknown[]).push(structuredClone(audit(job))); },
    job => { (job.details!.topicMigration as { revision: string }).revision = 'wrong-review'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(resolved); mutate(changed); insertJob(changed);
    assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  }
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('reconciled recovery rechecks branch identity, exact files and audit stability before issuing a new approval', async (t) => {
  const { plan, resolved } = await reconciledNoWrite(t);
  const retained = branches.get('branch-1')!;
  retained.files['unexpected.view'] = 'dimensions: {}\n';
  await assert.rejects(createTopicMigrationPlan(request()), /retained branch has changes/);
  retained.files = structuredClone(targetFiles);
  branches.delete('branch-1');
  await assert.rejects(createTopicMigrationPlan(request()), /branch could not be identified/);
  branches.set('branch-1', retained);
  const original = OmniClient.prototype.getModelYaml;
  const reader = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await original.apply(this, args);
    if (args[1]?.branchId === 'branch-1') {
      const changed = structuredClone(resolved);
      (changed.details!.migrationMutationAdjudications as Array<Record<string, unknown>>)[0].outcome = 'verified_partial_terminal';
      insertJob(changed);
    }
    return response;
  });
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  reader.mock.restore();
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch review rejects drift, ownership changes, and deprecated correction request fields before writes', async () => {
  for (const key of ['reviewedSqlFiles', 'tableMappings', 'fileMappings']) await assert.rejects(createTopicMigrationPlan({ ...request(), [key]: {} }), /manually in Omni/);
  const plan = await ready();
  targetFiles['changed.view'] = 'dimensions: {}\n';
  await assert.rejects(stage(plan), /changed/);
  wrongConnection = true;
  await assert.rejects(createTopicMigrationPlan(request()), /uniquely bind/);
  assert.equal(branchCreates, 0);
});

test('branch review retains partial/unrelated branches without a success receipt or replay', async () => {
  const plan = await ready();
  partialWrite = true;
  const job = await finished((await stage(plan)).job.id);
  assert.notEqual(job.status, 'succeeded');
  assert.equal(job.details?.branchReceipt, undefined);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
  assert.equal(job.items.find((item) => item.kind === 'model_branch_verify')?.status, 'skipped');
  await assert.rejects(retryMigrationJob(job.id), /one-use|replay/);
  await assert.rejects(mergeModelMigrationJob(job.id), /no longer available/);
  assert.equal(branches.size, 1);
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
});

test('a successful write response for an incomplete file set cannot produce a prepared branch receipt', async t => {
  const plan = await ready();
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async (input: Parameters<OmniClient['updateModelYamlFiles']>[0]) => {
    const completed = input.files.find(file => file.fileName === 'records.view')!;
    branches.get(input.branchId)!.files[completed.fileName] = completed.yaml;
    return { success: true };
  });
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.items.find(item => item.kind === 'model_yaml_write')?.status, 'succeeded');
  assert.equal(job.items.find(item => item.kind === 'model_branch_verify')?.status, 'failed');
  assert.notEqual(job.status, 'succeeded');
  assert.equal(job.details?.branchReceipt, undefined);
  assert.equal(getTopicMigrationPlan(plan.id).branchReceipt, undefined);
});

test('branch review exact readback rejects unrelated edits and source drift after branch creation', async () => {
  injectUnrelatedFile = true;
  const job = await finished((await stage(await ready())).job.id);
  assert.notEqual(job.status, 'succeeded');
  assert.equal(job.details?.branchReceipt, undefined);
  assert.equal(job.items.find((item) => item.kind === 'model_branch_verify')?.status, 'failed');
});

test('branch review cancellation prevents YAML dispatch and never deletes its created branch', async () => {
  cancelAtBranchRead = true;
  const job = await finished((await stage(await ready())).job.id);
  assert.equal(job.status, 'canceled');
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 0);
  assert.equal(job.details?.branchReceipt, undefined);
});

test('branch review legacy plans and jobs are readable but cannot publish, stage, replay, or clear history', async () => {
  const plan = await ready();
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(store, 'utf8'));
  const row = rows[0];
  row.plan.version = 1; delete row.plan.executionProfile;
  const proofPlan = Object.fromEntries(Object.entries(row.plan).filter(([key]) => !['revision', 'status', 'jobId'].includes(key)));
  row.plan.revision = checksum(JSON.stringify({ plan: proofPlan, boundaryHash: row.boundaryHash, targetFiles: row.targetFiles,
    sourceSchemaHash: row.sourceSchemaHash, targetSchemaHash: row.targetSchemaHash,
    sourceSchemaEvidenceHash: row.sourceSchemaEvidenceHash, targetSchemaEvidenceHash: row.targetSchemaEvidenceHash,
    tableMappingsHash: row.tableMappingsHash, requiresPr: row.requiresPr, branchName: row.branchName }));
  writeFileSync(store, JSON.stringify(rows));
  assert.equal(getTopicMigrationPlan(plan.id).status, 'blocked');
  await assert.rejects(stage({ ...plan, revision: row.plan.revision }), /Historical/);
  row.claim = randomUUID();
  writeFileSync(store, JSON.stringify(rows));
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id, 'A legacy claim remains a deduplication tombstone.');
  const legacy: MigrationJob = { id: 'legacy-job', workflow: 'model', sourceId: 'source', sourceLabel: 'Example source', destinationIds: ['target'],
    documentIds: [], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], status: 'failed', createdAt: Date.now(), items: [], details: {} };
  insertJob(legacy);
  assert.equal(getJob(legacy.id)?.id, legacy.id);
  await assert.rejects(retryMigrationJob(legacy.id), /cannot be replayed/);
  await assert.rejects(mergeModelMigrationJob(legacy.id), /no longer available/);
  assert.equal((await post('jobs/' + legacy.id + '/merge', {})).status, 410);
  assert.equal((await post('jobs', { sourceId: 'source', targetId: 'target' })).status, 410);
  const cleared = await historyHandler(new Request('http://localhost/api/migration-jobs', { method: 'DELETE' }));
  assert.equal(cleared.status, 409); assert.ok(getJob(legacy.id));
});

test('reviewed user attributes use exact plan bytes while job history and events contain only a file receipt', async t => {
  sourceFiles['example.topic'] += 'access_filters: [{field: records.id, user_attribute: "omni_user_email"}]\n';
  const original = OmniClient.prototype.updateModelYamlFiles;
  const write = t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async function (this: OmniClient, ...args: Parameters<OmniClient['updateModelYamlFiles']>) {
    assert.deepEqual(args[0].reviewedDestinationFiles, targetFiles);
    return original.apply(this, args);
  });
  const plan = await ready();
  const { job: staged } = await stage(plan);
  const events: MigrationJobEvent[] = [];
  const unsubscribe = subscribeMigrationJobEvents(staged.id, event => events.push(event));
  try {
    const complete = await finished(staged.id);
    assert.equal(complete.status, 'succeeded', JSON.stringify(complete.items));
    assert.equal(write.mock.callCount(), 1);
    const expected = plan.files.find(file => file.fileName === 'example.topic')!.proposed;
    assert.equal(branches.get('branch-1')!.files['example.topic'], expected);
    assert.equal(parse(expected).access_filters[0].user_attribute, 'omni_user_email');
    assert.ok(complete.details?.branchReceipt);
    assert.ok(events.length);
    assert.doesNotMatch(JSON.stringify([staged, complete, events]) + readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8'),
      /omni_user_email|base_view|acceptedFiles|fictional-secret/);
  } finally { unsubscribe(); }
});

test('reviewed attribute references never authorize an opaque credential or sensitive adjacent text', async () => {
  const original = sourceFiles['example.topic'];
  for (const line of [
    'access_filters: [{field: records.id, user_attribute: omni_opaqueFixtureCredential}]',
    'access_filters: [{field: records.id, user_attribute: omni_user_email}] # password: fixture-value',
  ]) {
    sourceFiles['example.topic'] = original + line + '\n';
    const plan = await createTopicMigrationPlan(request());
    assert.equal(plan.status, 'blocked');
    assert.ok(plan.issues.some(issue => issue.id === 'history-redaction-integrity'));
    await assert.rejects(stage(plan), /blockers/);
  }
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

test('branch review history redaction blocks approval before a one-use claim exists', async () => {
  sourceFiles['records.view'] += 'description: example@example.invalid\n';
  const plan = await createTopicMigrationPlan(request());
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.issues.some((issue) => issue.id === 'history-redaction-integrity'));
  await assert.rejects(stage(plan), /blockers/);
  const rows = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  assert.equal(rows[0].claim, undefined); assert.equal(branchCreates, 0);
});

test('branch review dashboard handoff rejects historical readiness without upgrading or dispatching it', async () => {
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.deployment-plans.json';
  for (const evidenceVersion of [undefined, 4, DASHBOARD_READINESS_EVIDENCE_VERSION - 1]) {
    const repair = dashboardFixture();
    const plans = JSON.parse(readFileSync(store, 'utf8')) as DashboardDeploymentPlan[];
    plans[0].evidenceVersion = evidenceVersion;
    const saved = JSON.stringify(plans);
    writeFileSync(store, saved);
    const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /predates workbook-aware readiness/);
    assert.equal(readFileSync(store, 'utf8'), saved, 'Historical evidence must remain unchanged until a fresh readiness check.');
  }
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0); assert.deepEqual(listJobs(), []);
});

test('branch review dashboard authored handoff keeps provenance and stages through the same contract', async () => {
  const repair = dashboardFixture();
  const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(plan.dashboardRepair, { planId: repair.planId, targetId: repair.targetId, revision: 1 });
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal((job.details?.dashboardRepair as Record<string, unknown>)?.planId, repair.planId);
  const protectedProof = job.details!.dashboardRepair as Record<string, unknown>;
  assert.equal(protectedProof.targetModelHash, hash(targetFiles), 'A typed digest with a phone-like digit run must remain exact.');
  for (const bad of [{ ...protectedProof, targetModelHash: 'Bearer fictional-credential' }, { ...protectedProof, apiKey: 'fictional-credential' }]) {
    const sanitized = sanitizeJob({ ...job, details: { ...job.details, dashboardRepair: bad } }).details!.dashboardRepair as Record<string, unknown>;
    assert.ok(!JSON.stringify(sanitized).includes('fictional-credential'), 'Credential-like values are never preserved as typed digests.');
  }
  const dashboard = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.deployment-plans.json', 'utf8'))[0];
  assert.equal(dashboard.targets[0].repairJobId, job.id);
  assert.equal(dashboard.targets[0].status, 'needs_recheck');
  assert.equal(branchCreates, 1);
});

test('branch review proposed-topic packages retain exact approval hashes and do not replay', async () => {
  const repair = dashboardFixture();
  const files = ['records.view', 'example.topic'].map((fileName) => ({ fileName, yaml: sourceFiles[fileName], previousChecksum: undefined }));
  const input: ModelMigrationJobInput = { sourceId: 'source', targetId: 'target', models: [{ sourceModelId: 'source-model', targetModelId: 'target-model',
    targetConnectionId: 'target-connection', branchName: 'ignored-client-branch', mode: 'translate', acceptedFiles: files }],
    content: [], postMigrationActions: [], replaceSameNamed: false, mergeAfterValidation: false, publishDrafts: false, deleteBranch: false,
    dashboardRepair: { ...repair, approvedFilesHash: hash(files) } };
  const job = await finished((await stageApprovedDashboardBranchPreparation(input, createModelMigrationJob)).id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.match(String((job.details?.branchReceipt as Record<string, unknown>)?.branchName), /^omnikit-topics-/);
  assert.equal((await stageApprovedDashboardBranchPreparation(input, createModelMigrationJob)).id, job.id);
  assert.equal(branchCreates, 1);
});

test('branch review refuses a source change after creating a branch before YAML dispatch', async () => {
  driftDuringCreate = true;
  const job = await finished((await stage(await ready())).job.id);
  assert.notEqual(job.status, 'succeeded');
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 0);
  assert.equal(job.details?.branchReceipt, undefined);
});

test('branch review known Git followers block preparation while protected branches skip hint reads during execution', async () => {
  targetFollower = true;
  const blocked = await createTopicMigrationPlan(request());
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.issues.some((issue) => issue.id === 'git-follower-read-only'));
  await assert.rejects(stage(blocked), /blockers/);
  assert.equal(branchCreates, 0);
  targetFollower = false;
  const plan = await ready();
  const readsAtApproval = namespaceReads;
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(namespaceReads, readsAtApproval, 'Namespace suggestions are not execution authority and must not be refetched.');
});

test('branch review dashboard closure excludes unrelated relationships and preserves destination model settings', async () => {
  const edge = (from: string, to: string) => ({ join_from_view: from, join_to_view: to,
    on_sql: '${' + from + '.id} = ${' + to + '.id}', relationship_type: 'many_to_one', join_type: 'always_left' });
  const requiredEdge = edge('records', 'details');
  sourceFiles.model = 'query_timezone: UTC\n';
  targetFiles.model = '# destination setting\nquery_timezone: America/Chicago\n';
  sourceFiles['example.topic'] = 'base_view: records\nfields: [records.id, details.id]\njoins:\n  details: {}\n';
  sourceFiles['details.view'] = sourceFiles['records.view'].replace('table_name: records', 'table_name: details');
  sourceFiles['relationships'] = stringify([requiredEdge, edge('unrelated', 'other')]);
  const repair = dashboardFixture(['example.topic', 'records.view', 'details.view', 'relationships', 'model']);
  const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(parse(plan.files.find((file) => file.fileName === 'relationships')!.proposed), [requiredEdge]);
  assert.ok(!plan.files.some((file) => file.kind === 'model'));
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.deepEqual(parse(branches.get('branch-1')!.files.relationships), [requiredEdge]);
  assert.equal(branches.get('branch-1')!.files.model, targetFiles.model);
});

test('branch review dashboard closure proves field-only topics and rejects missing, ambiguous, or wider readiness scope', async () => {
  const topicChoice: DashboardTopicChoice = { sourceTopicName: 'example', documentIds: ['example-document'], candidates: [],
    sourceCandidates: [{ name: 'example', fileName: 'example.topic' }] };
  targetFiles['example.topic'] = sourceFiles['example.topic'];
  targetFiles['records.view'] = 'catalog: SOURCE\nschema: PUBLIC\ntable_name: records\ndimensions: {}\n';
  let repair = dashboardFixture(['records.view'], [topicChoice]);
  let response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(plan.request.topicIds, ['example.topic']);
  assert.deepEqual(plan.files.filter((file) => ['create', 'add'].includes(file.status)).map((file) => file.fileName), ['records.view']);
  for (const choices of [undefined, [{ ...topicChoice, sourceCandidates: [...topicChoice.sourceCandidates!, { name: 'example', fileName: 'other/example.topic' }] }]]) {
    repair = dashboardFixture(['records.view'], choices);
    response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /exact authored source topics/);
  }
  delete targetFiles['example.topic'];
  repair = dashboardFixture(['records.view'], [topicChoice]);
  response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /outside the saved dashboard readiness scope/);
  assert.equal(branchCreates, 0);
});

test('branch review dashboard closure retains Git follower blockers for authored and exact approved packages', async () => {
  targetFollower = true;
  const repair = dashboardFixture();
  const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.issues.some((issue) => issue.id === 'git-follower-read-only'));
  const files = ['records.view', 'example.topic'].map((fileName) => ({ fileName, yaml: sourceFiles[fileName], previousChecksum: undefined }));
  const input: ModelMigrationJobInput = { sourceId: 'source', targetId: 'target', models: [{ sourceModelId: 'source-model', targetModelId: 'target-model',
    targetConnectionId: 'target-connection', branchName: 'ignored-client-branch', mode: 'translate', acceptedFiles: files }],
    content: [], postMigrationActions: [], replaceSameNamed: false, mergeAfterValidation: false, publishDrafts: false, deleteBranch: false,
    dashboardRepair: { ...repair, approvedFilesHash: hash(files) } };
  await assert.rejects(stageApprovedDashboardBranchPreparation(input, createModelMigrationJob), /blockers/);
  const saved = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  assert.ok(saved.every((row: { claim?: string; plan: TopicMigrationPlan }) => !row.claim
    && row.plan.status === 'blocked' && row.plan.issues.some((issue) => issue.id === 'git-follower-read-only')));
  assert.equal(branchCreates, 0);
});
