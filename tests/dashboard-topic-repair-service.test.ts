import assert from 'node:assert/strict';
import { test, beforeEach, afterEach, mock } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import { approveDashboardTopicRepair, previewDashboardTopicRepair } from '../server/services/dashboardTopicRepair';
import { readReviewedReconstructedTopics } from '../server/services/dashboardTopicRepairEvidence';
import { dashboardRepairSnapshotHash as hash, issueDashboardRepairApproval, verifyDashboardRepairApproval } from '../server/services/dashboardRepairApproval';
import { assertAdditiveDashboardRepairDispatch, dashboardRepairInstanceBoundaryHash } from '../server/services/dashboardRepairRuntime';
import { getDashboardDeploymentPlan } from '../server/services/dashboardDeploymentPlans';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';
import type { MigrationJob, ModelMigrationJobInput } from '../server/services/migrationJobs';
import { dashboardTopicRelationInventory, dashboardTopicRelationEvidence, assertDashboardTopicRelationInventory, readDashboardTopicRelationInventory, dashboardTopicInventoryDiagnostics } from '../server/services/dashboardTopicRelationInventory';

let sourceFiles: Record<string, string>;
let targetFiles: Record<string, string>;
let sourceRelations: Record<string, unknown>;
let targetRelations: Record<string, unknown>;
let workbookFiles: Record<string, string>;
let state: Record<string, unknown>;
let plan: DashboardDeploymentPlan;
let directory: string;
let history: string;
const envKeys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH'];
let oldEnvironment: Array<string | undefined>;
beforeEach(() => {
  oldEnvironment = envKeys.map((key) => process.env[key]);
  directory = mkdtempSync(join(tmpdir(), 'omnikit-topic-review-'));
  history = join(directory, 'jobs.json');
  process.env.OMNIKIT_VAULT_PATH = join(directory, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = history;
  unlockVault('synthetic-test-only-passphrase');
  for (const [id, role] of [['source', 'source'], ['target', 'destination']] as const) upsertInstance({ id, role, label: id,
    baseUrl: 'https://93.184.216.34', apiKey: 'synthetic-key', postMigrationActions: [],
    metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] } });
  sourceFiles = { model: '{}\n', 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n' };
  sourceRelations = {}; targetRelations = {};
  targetFiles = { model: '{}\n' };
  workbookFiles = {};
  state = { name: 'Example dashboard', modelId: 'source-model', workbookModelId: 'workbook', containers: [],
    queryPresentations: { data: { q: { topicName: 'missing_topic', query: { fields: ['orders.id'] } } }, order: ['q'] } };
  plan = { version: 2, evidenceVersion: 4, id: 'example-plan', revision: 1, createdAt: 1, updatedAt: 1,
    intent: { profile: 'safe_copy_v1', requestId: '11111111-1111-4111-8111-111111111111',
      source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] },
      destinations: [{ targetId: 'route', instanceId: 'target', connectionId: 'target-connection', modelId: 'target-model' }] },
    sourceHashes: { dashboard: hash(state) }, sourceModelHashes: { 'source-model': hash(sourceFiles) },
    readinessRun: { id: 'run', startedAt: 1, status: 'complete' },
    targets: [{ targetId: 'route', status: 'unverified', checkedAt: 1, modelHash: hash(targetFiles), sourceModelIds: ['source-model'],
      requiredFiles: ['orders.view'], requiredFilesByModelId: { 'source-model': ['orders.view'] }, findings: [],
      topicChoices: [{ sourceTopicName: 'missing_topic', candidates: [], documentIds: ['dashboard'] }] }] };
  writeFileSync(`${history}.deployment-plans.json`, JSON.stringify([plan]));
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => structuredClone(state));
  mock.method(OmniClient.prototype, 'listModels', async (options: { modelId: string; connectionId: string }) => [
    { id: options.modelId, name: 'Example model', connectionId: options.connectionId, kind: 'SHARED' },
  ]);
  mock.method(OmniClient.prototype, 'getModelYaml', async (modelId: string) => ({
    files: structuredClone(modelId === 'source-model' ? sourceFiles : modelId === 'workbook' ? workbookFiles : targetFiles), checksums: {},
    raw: { viewNames: structuredClone(modelId === 'source-model' ? sourceRelations : modelId === 'workbook' ? {} : targetRelations) } }));
});
afterEach(() => {
  mock.restoreAll(); resetVault(); lockVault();
  envKeys.forEach((key, i) => oldEnvironment[i] === undefined ? delete process.env[key] : process.env[key] = oldEnvironment[i]);
  rmSync(directory, { recursive: true, force: true });
});
const request = () => ({ revision: plan.revision, targetId: 'route', sourceTopicName: 'missing_topic', targetTopicName: 'new_topic' });
const approval = (preview: Awaited<ReturnType<typeof previewDashboardTopicRepair>>) => ({ revision: preview.revision, targetId: 'route',
  reviewId: preview.reviewId, reviewHash: preview.reviewHash, confirmAdditiveOnly: true, confirmNewTopicSemantics: true });

test('preview is read-only; exact approval stages only additions, consumes review and records new binding', async () => {
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert.deepEqual(preview.blockers, []);
  assert.equal(getDashboardDeploymentPlan(plan.id).revision, 1);
  let submitted: ModelMigrationJobInput | undefined;
  const result = await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async (input) => {
    submitted = input; return { id: 'staged-job' } as MigrationJob;
  } });
  assert.equal(submitted?.mergeAfterValidation, false);
  assert.equal(submitted?.publishDrafts, false);
  assert.deepEqual(submitted?.content, []);
  assert.equal(submitted?.models[0].acceptedFiles?.length, 2);
  assert.equal(result.plan.targets[0].status, 'needs_recheck');
  assert.deepEqual(result.plan.intent.destinations[0].topicMappings, [{ sourceTopicName: 'missing_topic', targetTopicName: 'new_topic', action: 'map_existing' }]);
  assert.equal(result.plan.topicRepairReceipts?.[0].jobId, 'staged-job');
  assert(!JSON.stringify(result.plan.topicRepairReceipts).includes('base_view:'), 'receipt never persists raw YAML');
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /missing|expired|reviewed/);
});

test('tampered approval and stale model or workbook cannot submit a repair', async () => {
  const preview = await previewDashboardTopicRepair(plan.id, request());
  await assert.rejects(approveDashboardTopicRepair(plan.id, { ...approval(preview), reviewHash: 'tampered' }), /approval/);
  workbookFiles = { 'unrelated.view': 'label: Changed\n' };
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /evidence changed/);
  workbookFiles = {};
  targetFiles = { model: '{}\n', 'unrelated.view': 'label: Changed\n' };
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /model changed/);
  assert.equal(getDashboardDeploymentPlan(plan.id).revision, 1);
});

function joinedSourceForReview() {
  const relation = (from: string, to: string) => ({ join_from_view: from, join_to_view: to, join_type: 'always_left', relationship_type: 'many_to_one', on_sql: `\${${from}.id} = \${${to}.id}` });
  sourceFiles = { ...sourceFiles, 'customers.view': sourceFiles['orders.view'], 'bridge.view': sourceFiles['orders.view'],
    relationships: stringify([relation('orders', 'customers'), relation('orders', 'bridge'), relation('bridge', 'customers')]) };
  state = { ...state, queryPresentations: { data: { q: { topicName: 'missing_topic', query: { fields: ['orders.id', 'customers.id'] } } }, order: ['q'] } };
  plan.sourceHashes.dashboard = hash(state); plan.sourceModelHashes['source-model'] = hash(sourceFiles);
  writeFileSync(`${history}.deployment-plans.json`, JSON.stringify([plan]));
}

test('topic approval replays the cached exact authored path and cannot replace it in the approval request', async () => {
  joinedSourceForReview();
  const initial = await previewDashboardTopicRepair(plan.id, { ...request(), baseView: 'orders' });
  assert(initial.blockers.some((message) => /Multiple authored join paths/.test(message)));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(initial)), /conflicts/);
  const path = initial.joinPathChoices![0].paths.find((candidate) => candidate.views.includes('bridge'))!;
  const preview = await previewDashboardTopicRepair(plan.id, { ...request(), baseView: 'orders', selectedJoinPaths: { customers: path.id } });
  assert.deepEqual(preview.blockers, []);
  await assert.rejects(approveDashboardTopicRepair(plan.id, { ...approval(preview), selectedJoinPaths: {} }), /request is invalid/);
  // Returned previews are clones: mutating one cannot change the approved server snapshot.
  preview.selectedJoinPaths!.customers = `sha256:${'0'.repeat(64)}`;
  let submitted: ModelMigrationJobInput | undefined;
  await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async (input) => { submitted = input; return { id: 'reviewed-path-job' } as MigrationJob; } });
  const topic = submitted!.models[0].acceptedFiles!.find((file) => file.fileName === 'new_topic.topic')!;
  assert.deepEqual(parse(topic.yaml).joins, { bridge: { customers: {} } });
  assert.equal(submitted!.mergeAfterValidation, false);
  assert.equal(submitted!.publishDrafts, false);
});

test('invalid path IDs and changed authored path evidence never stage a repair', async () => {
  joinedSourceForReview();
  const initial = await previewDashboardTopicRepair(plan.id, { ...request(), baseView: 'orders' });
  const path = initial.joinPathChoices![0].paths.find((candidate) => candidate.views.includes('bridge'))!;
  for (const selectedJoinPaths of [null, [], { customers: 'fabricated' }]) {
    await assert.rejects(previewDashboardTopicRepair(plan.id, { ...request(), baseView: 'orders', selectedJoinPaths }), /Join-path selections/);
  }
  const invalid = await previewDashboardTopicRepair(plan.id, { ...request(), baseView: 'orders', selectedJoinPaths: { customers: `sha256:${'0'.repeat(64)}` } });
  assert(invalid.blockers.some((message) => /invalid or stale/.test(message)));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(invalid)), /conflicts/);
  const preview = await previewDashboardTopicRepair(plan.id, { ...request(), baseView: 'orders', selectedJoinPaths: { customers: path.id } });
  sourceFiles.relationships = sourceFiles.relationships.replace('always_left', 'inner');
  let creates = 0;
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async () => { creates += 1; return { id: 'must-not-stage' } as MigrationJob; } }), /model changed|evidence changed/);
  assert.equal(creates, 0);
  assert.equal(getDashboardDeploymentPlan(plan.id).revision, 1);
});

test('signed file approvals bind YAML, destination snapshot and plan revision', () => {
  const evidence = { planId: 'p', revision: 1, targetId: 't', sourceModelId: 's', sourceModelHash: 's-hash', targetModelHash: 't-hash', fileName: 'new.topic', yaml: 'base_view: orders\n',
    instanceBoundaryHash: hash('instances'), sourceDocumentHashes: { dashboard: hash(state) }, sourceWorkbookHashes: { workbook: hash(workbookFiles) } };
  const token = issueDashboardRepairApproval(evidence);
  verifyDashboardRepairApproval(token, evidence);
  assert.throws(() => verifyDashboardRepairApproval(`${token}.extra`, evidence), /reviewed diff/);
  for (const patch of [{ yaml: 'base_view: another\n' }, { revision: 2 }, { targetModelHash: 'changed' }]) assert.throws(() => verifyDashboardRepairApproval(token, { ...evidence, ...patch }), /reviewed diff/);
});

test('topic review rejects changed model binding and aliases of the source model', async () => {
  mock.method(OmniClient.prototype, 'listModels', async (options: { modelId: string }) => [
    { id: options.modelId, name: 'Example model', connectionId: 'changed-connection', kind: 'SHARED' },
  ]);
  await assert.rejects(previewDashboardTopicRepair(plan.id, request()), /connection binding/);
  plan.intent.destinations[0].modelId = 'source-model';
  writeFileSync(`${history}.deployment-plans.json`, JSON.stringify([plan]));
  await assert.rejects(previewDashboardTopicRepair(plan.id, request()), /must not modify the source model/);
});

test('staging alone does not authorize topic binding; shared-model readback and workbook hashes must match', async () => {
  const preview = await previewDashboardTopicRepair(plan.id, request());
  const result = await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async () => ({ id: 'staged-job' } as MigrationJob) });
  const read = () => readReviewedReconstructedTopics(result.plan, async () => sourceFiles, async () => targetFiles, async () => workbookFiles,
    async (instance) => ({ viewNames: instance === 'source' ? sourceRelations : targetRelations }));
  assert.deepEqual(await read(), {});
  for (const file of preview.files) targetFiles[file.fileName] = file.proposed;
  assert.equal((await read()).route[0].targetTopicName, 'new_topic');
  workbookFiles = { model: 'label: changed\n' };
  assert.deepEqual(await read(), {});
});

test('runtime refuses stale target, modified file bytes, and changed source document before dispatch', async () => {
  const writes = [{ fileName: 'new.topic', yaml: 'base_view: orders\n', previousChecksum: undefined }];
  const job = { sourceId: 'source', destinationIds: ['target'], details: { dashboardRepair: { additiveOnly: true, targetModelHash: hash(targetFiles), sourceModelHashes: { 'source-model': hash(sourceFiles) },
    instanceBoundaryHash: dashboardRepairInstanceBoundaryHash('source', 'target', 'target-model', ['source-model']),
    sourceDocumentHashes: { dashboard: hash(state) }, sourceWorkbookHashes: { workbook: hash(workbookFiles) }, approvedFilesHash: hash(writes) } },
    items: [{ kind: 'model_yaml_write', details: { files: writes } }] } as unknown as MigrationJob;
  const source = { getModelYaml: async (id: string) => ({ files: id === 'workbook' ? workbookFiles : sourceFiles }), getDocumentStateV2: async () => state } as unknown as OmniClient;
  const target = { getModelYaml: async () => ({ files: targetFiles, checksums: {} }) } as unknown as OmniClient;
  await assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target);
  state = { ...state, name: 'Changed' };
  await assert.rejects(assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target), /dashboard changed/);
  writes[0].yaml = 'base_view: altered\n';
  await assert.rejects(assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target), /approved diff/);
});

test('inherited relation evidence is selected, normalized and invalidated by definition drift', () => {
  const raw = { viewNames: { warehouse_orders: { sql_table_name: 'analytics.orders' }, unrelated: {} } };
  const inventory = dashboardTopicRelationInventory(raw);
  const selected = dashboardTopicRelationEvidence(['warehouse_orders'], inventory, inventory);
  assert.deepEqual(Object.keys(selected.source), ['warehouse_orders']);
  assertDashboardTopicRelationInventory(raw, selected.target, 'Destination');
  assert.throws(() => assertDashboardTopicRelationInventory({ viewNames: { warehouse_orders: { sql_table_name: 'analytics.changed' } } }, selected.target, 'Destination'), /evidence changed/);
  assert.throws(() => dashboardTopicRelationInventory({ viewNames: { orders: {}, ORDERS: {} } }), /ambiguous/);
  assert.throws(() => dashboardTopicRelationInventory({ viewNames: { orders: null } }), /unsupported/);
});

test('file-to-view indexes use exact semantic names and fingerprint their authored evidence', () => {
  const raw = { viewNames: {
    'warehouse/orders.view': 'warehouse__orders',
    'order_summary.query.view': 'order_summary',
    inherited_inventory: { sql_table_name: 'example.inventory' },
  }, files: { 'warehouse/orders.view': 'dimensions:\n  id: {}\n' } };
  const inventory = dashboardTopicRelationInventory(raw);
  assert.deepEqual(Object.keys(inventory).sort(), ['inherited_inventory', 'order_summary', 'warehouse__orders']);
  assert(!Object.hasOwn(inventory, 'warehouse/orders.view'));
  const selected = dashboardTopicRelationEvidence(['warehouse__orders'], inventory, inventory);
  assertDashboardTopicRelationInventory(raw, selected.target, 'Destination');
  assert.throws(() => assertDashboardTopicRelationInventory({ ...raw,
    files: { 'warehouse/orders.view': 'dimensions:\n  different: {}\n' },
  }, selected.target, 'Destination'), /evidence changed/);
  assert.throws(() => assertDashboardTopicRelationInventory({ ...raw,
    viewNames: { 'another/orders.view': 'warehouse__orders' },
  }, selected.target, 'Destination'), /evidence changed/);
  assert.throws(() => assertDashboardTopicRelationInventory({ viewNames: raw.viewNames }, selected.target, 'Destination'), /evidence changed/);
  assert.match(inventory.warehouse__orders, /^[a-f0-9]{64}$/);
});

test('unsupported mappings and duplicate canonical names remain fail-closed without raw payload errors', () => {
  const rejected = [
    { 'orders.view': 'orders', 'second.view': 'ORDERS' },
    { 'orders.view': 'orders', orders: {} },
    { 'orders.view': null },
    { 'orders.view': { name: 'orders' } },
    { 'orders.view': 'unsupported.value' },
    { '../orders.view': 'orders' },
    { 'orders.view': '__proto__' },
  ];
  for (const viewNames of rejected) assert.throws(() => dashboardTopicRelationInventory({ viewNames }), /ambiguous|unsupported/);
  for (const viewNames of [null, [], 'invalid', Object.fromEntries(Array.from({ length: 5_001 }, (_, i) => [`v${i}`, {}]))]) {
    assert.throws(() => dashboardTopicRelationInventory({ viewNames }), /incomplete|limit/);
  }
  assert.throws(() => dashboardTopicRelationInventory({ viewNames: { 'example.view': 'sensitive-invalid-value.example' } }),
    (error: Error) => !error.message.includes('sensitive-invalid-value') && /unsupported/.test(error.message));
});

function prepareInheritedFixture() {
  sourceFiles = { model: '{}\n', 'orders.query.view': 'sql: SELECT * FROM ${warehouse_orders}\ndimensions:\n  id:\n    sql: ${TABLE}.id\n' };
  sourceRelations = { 'warehouse/orders.view': 'warehouse_orders' };
  targetRelations = structuredClone(sourceRelations);
  plan.sourceModelHashes['source-model'] = hash(sourceFiles);
  writeFileSync(`${history}.deployment-plans.json`, JSON.stringify([plan]));
}

test('inherited dependencies are bound to approval, runtime and post-publication readback', async () => {
  prepareInheritedFixture();
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.reusedRelations, ['warehouse_orders']);
  let submitted: ModelMigrationJobInput | undefined;
  const result = await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async (input) => {
    submitted = input; return { id: 'staged-inherited-job' } as MigrationJob;
  } });
  const writes = submitted!.models[0].acceptedFiles!;
  const job = { sourceId: 'source', destinationIds: ['target'], details: { dashboardRepair: submitted!.dashboardRepair },
    items: [{ kind: 'model_yaml_write', details: { files: writes } }] } as unknown as MigrationJob;
  const source = { getModelYaml: async (id: string) => ({ files: id === 'workbook' ? workbookFiles : sourceFiles, raw: { viewNames: sourceRelations } }), getDocumentStateV2: async () => state } as unknown as OmniClient;
  const target = { getModelYaml: async () => ({ files: targetFiles, checksums: {}, raw: { viewNames: targetRelations } }) } as unknown as OmniClient;
  await assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target);
  targetRelations = { 'warehouse/changed.view': 'warehouse_orders' };
  await assert.rejects(assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target), /inherited view evidence changed/);
  targetRelations = structuredClone(sourceRelations);
  for (const file of writes) targetFiles[file.fileName] = file.yaml;
  const read = () => readReviewedReconstructedTopics(result.plan, async () => sourceFiles, async () => targetFiles,
    async () => workbookFiles, async (instance) => ({ viewNames: instance === 'source' ? sourceRelations : targetRelations }));
  assert.equal((await read()).route[0].targetTopicName, 'new_topic');
  targetRelations['unrelated_addition.view'] = 'unrelated_addition';
  assert.equal((await read()).route[0].targetTopicName, 'new_topic', 'Unrelated inventory additions do not invalidate the reviewed dependency.');
  targetRelations = { 'warehouse/changed.view': 'warehouse_orders' };
  assert.deepEqual(await read(), {});
});

test('changing only inherited inventory after preview invalidates approval', async () => {
  prepareInheritedFixture();
  const preview = await previewDashboardTopicRepair(plan.id, request());
  targetRelations = { 'warehouse/changed.view': 'warehouse_orders' };
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /Inherited view evidence changed/);
});

test('an indexed existing destination view cannot be shadowed by creating a duplicate', async () => {
  targetRelations = { 'schema/orders.view': 'orders' };
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert(preview.blockers.some((message) => /exists without a readable authored definition/.test(message)));
  assert.equal(preview.files.find((file) => file.kind === 'view')?.status, 'conflict');
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /conflicts/);
});

test('a destination view appearing only in the index after approval blocks dispatch and merge', async () => {
  const preview = await previewDashboardTopicRepair(plan.id, request());
  let submitted: ModelMigrationJobInput | undefined;
  await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async (input) => {
    submitted = input; return { id: 'staged-job' } as MigrationJob;
  } });
  const job = { sourceId: 'source', destinationIds: ['target'], details: { dashboardRepair: submitted!.dashboardRepair },
    items: [{ kind: 'model_yaml_write', details: { files: submitted!.models[0].acceptedFiles } }] } as unknown as MigrationJob;
  const source = { getModelYaml: async (id: string) => ({ files: id === 'workbook' ? workbookFiles : sourceFiles, raw: { viewNames: sourceRelations } }), getDocumentStateV2: async () => state } as unknown as OmniClient;
  const target = { getModelYaml: async () => ({ files: targetFiles, checksums: {}, raw: { viewNames: targetRelations } }) } as unknown as OmniClient;
  await assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target);
  targetRelations = { 'schema/orders.view': 'orders' };
  await assert.rejects(assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target), /view inventory changed/);
  await assert.rejects(assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target, { branchId: 'review-branch', beforeMerge: true }), /view inventory changed/);
  targetRelations = {};
  sourceRelations = { 'different.view': 'orders' };
  await assert.rejects(assertAdditiveDashboardRepairDispatch(job, 'target-model', source, target), /source view inventory changed/);
});

test('known unrelated unsupported definitions become one warning without dropping occupancy', async () => {
  targetRelations = { unrelated_one: null, unrelated_two: null };
  const inventory = readDashboardTopicRelationInventory({ viewNames: targetRelations });
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.observedNames, ['unrelated_one', 'unrelated_two']);
  assert.deepEqual(inventory.fingerprints, {});
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.inventoryDiagnostics?.length, 1);
  assert.equal(preview.inventoryDiagnostics?.[0].severity, 'warning');
  assert.equal(preview.inventoryDiagnostics?.[0].count, 2);
  assert(!JSON.stringify(preview.inventoryDiagnostics).includes('unrelated_one'));
  await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async () => ({ id: 'staged-warning-job' } as MigrationJob) });
});

test('required invalid source and destination definitions block without hiding the other diffs', async () => {
  targetRelations = { orders: null };
  const targetPreview = await previewDashboardTopicRepair(plan.id, request());
  assert(targetPreview.files.some((file) => file.kind === 'topic'));
  assert.equal(targetPreview.files.find((file) => file.kind === 'view')?.status, 'conflict');
  assert(targetPreview.inventoryDiagnostics?.some((row) => row.side === 'destination' && row.severity === 'blocker'));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(targetPreview)), /conflicts/);
  targetRelations = {};
  sourceRelations = { orders: null };
  const sourcePreview = await previewDashboardTopicRepair(plan.id, request());
  assert(sourcePreview.inventoryDiagnostics?.some((row) => row.side === 'source' && row.severity === 'blocker'));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(sourcePreview)), /conflicts/);
});

test('unknown identities and missing containers remain globally blocking with private shape diagnostics', async () => {
  for (const viewNames of [{ 'example.view': 'private.invalid.identity' }, { 'example.view': '' }, { 'example.view': { opaque: 'private' } }]) {
    const inventory = readDashboardTopicRelationInventory({ viewNames });
    assert.equal(inventory.complete, false);
    const diagnostics = dashboardTopicInventoryDiagnostics(inventory, ['orders'], 'source');
    assert.equal(diagnostics[0].severity, 'blocker');
    assert(!JSON.stringify(diagnostics).includes('private'));
  }
  assert.equal(readDashboardTopicRelationInventory({}).complete, false);
  assert.equal(readDashboardTopicRelationInventory({ viewNames: {} }).complete, true);
  sourceRelations = { 'example.view': 'private.invalid.identity' };
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert(preview.files.some((file) => file.kind === 'topic'));
  assert(preview.inventoryDiagnostics?.some((row) => row.code === 'VIEW_NAME_UNSUPPORTED' && row.message.includes('periods')));
  assert(!JSON.stringify(preview.inventoryDiagnostics).includes('private.invalid.identity'));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /conflicts/);
});

test('ambiguous canonical names cannot authorize reuse or duplicate creation', async () => {
  targetRelations = { 'one.view': 'orders', 'two.view': 'ORDERS' };
  const inventory = readDashboardTopicRelationInventory({ viewNames: targetRelations });
  assert.deepEqual(inventory.observedNames, ['orders']);
  assert.deepEqual(inventory.fingerprints, {});
  assert.deepEqual(inventory.fileNames.orders, ['one.view', 'two.view']);
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert.equal(preview.files.find((file) => file.kind === 'view')?.status, 'conflict');
  assert(preview.inventoryDiagnostics?.some((row) => row.code === 'VIEW_NAME_AMBIGUOUS' && row.severity === 'blocker'));
});

test('canonical file bindings resolve authored fields even when paths and semantic names differ', async () => {
  sourceFiles = { model: '{}\n', 'warehouse/source_orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n' };
  targetFiles = { model: '{}\n', 'reporting/target_orders.view': sourceFiles['warehouse/source_orders.view'] };
  sourceRelations = { 'warehouse/source_orders.view': 'warehouse__orders' };
  targetRelations = { 'reporting/target_orders.view': 'warehouse__orders' };
  state = { ...state, queryPresentations: { data: { q: { topicName: 'missing_topic', query: { fields: ['warehouse__orders.id'] } } }, order: ['q'] } };
  plan.sourceHashes.dashboard = hash(state);
  plan.sourceModelHashes['source-model'] = hash(sourceFiles);
  plan.targets[0].modelHash = hash(targetFiles);
  writeFileSync(`${history}.deployment-plans.json`, JSON.stringify([plan]));
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert.deepEqual(preview.blockers, []);
  const view = preview.files.find((file) => file.kind === 'view')!;
  assert.equal(view.fileName, 'reporting/target_orders.view');
  assert.equal(view.status, 'unchanged');
  assert.equal(preview.baseView, 'warehouse__orders');
  assert(preview.files.find((file) => file.kind === 'topic')?.proposed.includes('warehouse__orders'));
});

test('invalid required upstream relation evidence cannot be mislabeled an unrelated warning', async () => {
  prepareInheritedFixture();
  targetRelations = { warehouse_orders: null };
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert(preview.requiredInventoryNames?.includes('warehouse_orders'));
  assert(preview.inventoryDiagnostics?.some((row) => row.side === 'destination' && row.severity === 'blocker'));
  assert(preview.blockers.some((message) => /exists but its inventory evidence is unverified/.test(message)));
  assert.deepEqual(preview.reusedRelations || [], []);
});

test('post-publication evidence tolerates only unrelated known issues and detects source index drift', async () => {
  prepareInheritedFixture();
  const preview = await previewDashboardTopicRepair(plan.id, request());
  const result = await approveDashboardTopicRepair(plan.id, approval(preview), { createJob: async () => ({ id: 'staged-readback-job' } as MigrationJob) });
  for (const file of preview.files) targetFiles[file.fileName] = file.proposed;
  const read = () => readReviewedReconstructedTopics(result.plan, async () => sourceFiles, async () => targetFiles, async () => workbookFiles,
    async (instance) => ({ viewNames: instance === 'source' ? sourceRelations : targetRelations }));
  targetRelations.unrelated = null;
  assert.equal((await read()).route[0].targetTopicName, 'new_topic');
  targetRelations['first.view'] = 'orders';
  targetRelations['second.view'] = 'orders';
  assert.deepEqual(await read(), {}, 'Ambiguous authored destination bindings invalidate readback even with unchanged topic bytes.');
  delete targetRelations['first.view'];
  delete targetRelations['second.view'];
  sourceRelations = { 'different/path.view': 'warehouse_orders' };
  assert.deepEqual(await read(), {});
});

test('mapped inherited relations still check workbook overrides at their actual file paths', async () => {
  prepareInheritedFixture();
  workbookFiles = { 'warehouse/orders.view': 'dimensions:\n  local_only:\n    sql: ${TABLE}.private_value\n' };
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert(preview.blockers.some((message) => /Workbook-local definitions or settings overlap required view warehouse_orders/.test(message)));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /conflicts/);
});

test('filename inference cannot override another semantic identity including ambiguous ownership', async () => {
  for (const bindings of [{ 'orders.view': 'another_view' }, { 'orders.view': 'another_view', 'second.view': 'ANOTHER_VIEW' }]) {
    sourceRelations = bindings;
    const preview = await previewDashboardTopicRepair(plan.id, request());
    assert(preview.blockers.some((message) => /Filename inference cannot override/.test(message)));
    await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /conflicts/);
  }
  sourceRelations = {};
  targetFiles['orders.view'] = sourceFiles['orders.view'];
  targetRelations = { 'orders.view': 'another_view' };
  plan.targets[0].modelHash = hash(targetFiles);
  writeFileSync(`${history}.deployment-plans.json`, JSON.stringify([plan]));
  const preview = await previewDashboardTopicRepair(plan.id, request());
  assert(preview.blockers.some((message) => /Filename inference cannot override/.test(message)));
  await assert.rejects(approveDashboardTopicRepair(plan.id, approval(preview)), /conflicts/);
});
