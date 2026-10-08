import assert from 'node:assert/strict';
import { beforeEach, afterEach, mock, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeJobStoreForTests, getJob, insertJob, updateJobAtomically } from '../server/services/jobStore';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient, type OmniWriteDispatchGuard } from '../server/services/omniClient';
import { createDashboardDeploymentPlan, deployDashboardDeploymentPlan, previewDashboardDeploymentPackage } from '../server/services/dashboardDeploymentPlans';
import { dashboardSafeCopyIntentFromJob } from '../server/services/dashboardSafeCopyRuntime';
import { runDashboardPackageJob, verifyDashboardPackageImport, withDashboardPackageRecoveryEvidence } from '../server/services/dashboardPackageRuntime';
import { migrationJobsHandler } from '../server/handlers/migration-jobs';
import { sanitizeJob } from '../server/services/jobSanitizer';
import type { DashboardSafeCopyIntent } from '../shared/dashboardSafeCopyContract';

// Fictional in-memory Omni surfaces. Never connect to a saved tenant or real history.
const view = 'table_name: example_orders\ndimensions:\n  id:\n    sql: ${TABLE}.id\n';
const source = {
  exportVersion: '0.1', document: { name: 'Example dashboard' },
  workbookModel: { id: 'source-workbook', base_model_id: 'source-model', connection_id: 'source-connection' },
  queryModels: {}, dashboard: { id: 'source-dashboard', queryPresentationCollection: { id: 'source-collection',
    queryPresentationCollectionMemberships: [{ id: 'source-membership', queryPresentation: { id: 'source-presentation', miniUuid: 'source-tile', name: 'Orders',
      query: { id: 'source-query-record', queryJson: { model_id: 'source-model', model_extension_id: 'source-workbook', connection_id: 'source-connection', fields: ['orders.id'] } } } }] } },
};
const initialIntent: DashboardSafeCopyIntent = { profile: 'safe_copy_v1', requestId: 'f2d936cb-5433-4d56-99ee-75697fe29f78',
  source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['source-document'] },
  destinations: [{ targetId: 'target', instanceId: 'target', connectionId: 'target-connection', modelId: 'target-model', folderId: 'example-folder', folderPath: '/Example' }] };
const envKeys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH'];
let originalEnv: Array<string | undefined>, root: string;
let targetFiles: Record<string, string>, branch: Record<string, string>, imported: Record<string, unknown> | undefined;
let importIdentity: string, importName: string, protectedModel: boolean, importLost: boolean, queryFails: boolean;
let calls: string[];
const nativeInventory = OmniClient.prototype.listDocumentInventory;
let retained: Map<string, { payload: Record<string, unknown>; name: string; documentId: string }>;
let brokenPlacements: Set<string>, failPlacementOnImport: boolean;
const snapshot = (files: Record<string, string>) => {
  const value = structuredClone(files), checksums = Object.fromEntries(Object.keys(value).map(name => [name, `checksum-${name}`]));
  return { files: value, checksums, raw: { files: value, checksums } };
};
beforeEach(() => {
  originalEnv = envKeys.map(key => process.env[key]); root = mkdtempSync(join(tmpdir(), 'omnikit-package-runtime-'));
  envKeys.forEach((key, index) => { process.env[key] = join(root, `isolated-${index}.json`); });
  closeJobStoreForTests(); resetVault(); unlockVault('fictional package integration passphrase');
  upsertInstance({ id: 'source', label: 'Example source', baseUrl: 'https://source.example.invalid', apiKey: 'fictional-test', role: 'source' });
  upsertInstance({ id: 'target', label: 'Example target', baseUrl: 'https://target.example.invalid', apiKey: 'fictional-test', role: 'destination' });
  targetFiles = { 'orders.view': view }; branch = {}; imported = undefined;
  calls = []; protectedModel = false; importLost = false; queryFails = false; importIdentity = ''; importName = '';
  retained = new Map(); brokenPlacements = new Set(); failPlacementOnImport = false;
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request from fictional test'); });
  mock.method(OmniClient.prototype, 'listConnections', async () => ['source', 'target'].map(side => ({ id: `${side}-connection`, name: side, dialect: 'snowflake' })));
  mock.method(OmniClient.prototype, 'listModels', async ({ modelId }: { modelId: string }) => {
    const side = modelId.startsWith('source-') ? 'source' : 'target';
    return [{ id: modelId, name: modelId, connectionId: `${side}-connection`, kind: modelId.endsWith('-workbook') ? 'WORKBOOK' : 'SHARED',
      baseModelId: `${side}-model`, pullRequestRequired: modelId === 'target-model' && protectedModel }];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async (id: string) => id.startsWith('source-document')
    ? { name: 'Example dashboard', modelId: 'source-model', workbookModelId: 'source-workbook' }
    : { name: retained.get(id)?.name, modelId: 'target-model', workbookModelId: 'target-workbook' });
  mock.method(OmniClient.prototype, 'exportDocument', async (id: string) => structuredClone(id.startsWith('source-document') ? source : retained.get(id)?.payload));
  mock.method(OmniClient.prototype, 'getModelYaml', async (id: string, options?: { branchId?: string }) => snapshot(id === 'source-model'
    ? { 'orders.view': view } : id === 'target-model' ? options?.branchId ? branch : targetFiles : {}));
  mock.method(OmniClient.prototype, 'listFolderInventory', async () => ({ folders: [{ id: 'example-folder', name: 'Example', path: '/Example' }], pagination: { complete: true } }));
  // Production id remains the slug. Optional model/connection fields are deliberately absent.
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => ({ documents: [...retained].map(([identifier, row]) => ({ id: identifier, identifier,
    documentId: brokenPlacements.has(identifier) ? 'wrong-document' : row.documentId,
    name: row.name, folderId: 'example-folder', folderPath: '/Example' })), pagination: { complete: true } }));
  mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }, guard: OmniWriteDispatchGuard) => {
    guard.assertCanDispatch(); calls.push('branch'); branch = { ...targetFiles }; return { id: 'example-branch', name: input.branchName, raw: {} };
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: { fileName: string; yaml: string }, guard: OmniWriteDispatchGuard) => {
    guard.assertCanDispatch(); calls.push('yaml'); branch[input.fileName] = input.yaml; return {};
  });
  mock.method(OmniClient.prototype, 'getModelValidationRaw', async () => { calls.push('validate'); return []; });
  mock.method(OmniClient.prototype, 'mergeModelBranch', async (_id: string, _name: string, options: Record<string, boolean>, guard: OmniWriteDispatchGuard) => {
    assert.equal(options.forceOverrideGitSettings, false); guard.assertCanDispatch(); calls.push('merge'); targetFiles = { ...branch }; return {};
  });
  mock.method(OmniClient.prototype, 'importDocument', async (input: { exportPayload: Record<string, unknown>; identifier: string; documentName: string }, guard: OmniWriteDispatchGuard) => {
    guard.assertCanDispatch(); calls.push('import'); importIdentity = input.identifier; importName = input.documentName;
    imported = structuredClone(input.exportPayload);
    imported.workbookModel = { id: 'target-workbook', base_model_id: 'target-model', connection_id: 'target-connection' };
    const dashboard = imported.dashboard as typeof source.dashboard;
    dashboard.id = 'target-dashboard'; dashboard.queryPresentationCollection.id = 'target-collection';
    const membership = dashboard.queryPresentationCollection.queryPresentationCollectionMemberships[0];
    membership.id = 'target-membership'; membership.queryPresentation.id = 'target-presentation'; membership.queryPresentation.miniUuid = 'target-tile';
    membership.queryPresentation.query.id = 'target-query-record'; membership.queryPresentation.query.queryJson.model_extension_id = 'target-workbook';
    const documentId = `target-document-${calls.filter(call => call === 'import').length}`;
    retained.set(importIdentity, { payload: imported, name: importName, documentId });
    if (failPlacementOnImport) brokenPlacements.add(importIdentity);
    if (importLost) throw new Error('Synthetic response lost after import');
    return { identifier: importIdentity, documentId, miniUuidMap: { 'source-tile': 'target-tile' }, raw: {} };
  });
  mock.method(OmniClient.prototype, 'runQuery', async () => { calls.push('query'); if (queryFails) throw new Error('Synthetic query error'); return { status: 'COMPLETE', rowCount: 0 }; });
});
afterEach(() => {
  mock.restoreAll(); lockVault(); closeJobStoreForTests(); resetVault(); rmSync(root, { recursive: true, force: true });
  envKeys.forEach((key, index) => { if (originalEnv[index] === undefined) delete process.env[key]; else process.env[key] = originalEnv[index]; });
});
async function approved(intent = initialIntent) {
  const plan = await createDashboardDeploymentPlan(intent);
  assert.equal(plan.targets[0].status, 'ready', JSON.stringify(plan.targets[0].findings));
  const preview = await previewDashboardDeploymentPackage(plan.id, { revision: plan.revision, targetId: 'target' });
  assert.equal(preview.fingerprint, plan.targets[0].package?.fingerprint);
  const { job } = await deployDashboardDeploymentPlan(plan.id, { revision: plan.revision, targetIds: ['target'], requestId: 'd9d3f96b-6b7c-4a13-a41c-6bf08033cbb8',
    confirmDependencies: true, confirmDestinationAudience: true }, null);
  return { job, intent: dashboardSafeCopyIntentFromJob(job) };
}
test('one package flows from saved review to exact verified copy without a model handoff', async () => {
  const { job, intent } = await approved(); const done = await runDashboardPackageJob(job.id, intent);
  assert.equal(done.job.status, 'succeeded', JSON.stringify(done.job.details?.dashboardPackageResults));
  assert.deepEqual(calls, ['import', 'query']);
  await runDashboardPackageJob(job.id, intent); assert.equal(calls.filter(call => call === 'import').length, 1);
});

test('native inventory retains distinct UUID and slug without changing legacy id semantics', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ records: [
    { id: 'native-document-uuid', identifier: '123456abcdef', name: 'Example dashboard' },
    { identifier: 'abcdef123456', name: 'Identifier only' },
  ], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 2 } }), { headers: { 'Content-Type': 'application/json' } }));
  const client = new OmniClient({ label: 'Fictional inventory', baseUrl: 'https://93.184.216.34', apiKey: 'fictional-inventory' });
  const observed = await nativeInventory.call(client);
  assert.equal(observed.documents[0].id, '123456abcdef');
  assert.equal(observed.documents[0].identifier, '123456abcdef');
  assert.equal(observed.documents[0].documentId, 'native-document-uuid');
  assert.equal(observed.documents[1].documentId, undefined);
});

const recoveryId = '01ab2345-1111-4111-8111-112233445566';
async function retainedFailure(intent = initialIntent) {
  failPlacementOnImport = true;
  const approvedJob = await approved(intent);
  await runDashboardPackageJob(approvedJob.job.id, approvedJob.intent);
  brokenPlacements.delete(importIdentity);
  return approvedJob;
}
const recoveryRequest = (jobId: string, target = 'target', body: unknown = { requestId: recoveryId, sourceDocumentId: 'source-document' }, query = '') =>
  new Request(`http://localhost/api/migration-jobs/${jobId}/targets/${target}/verify-import${query}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('verify-import handler rechecks retained identity and resumes without another import; original failure is audited', async () => {
  const { job, intent } = await retainedFailure();
  const pending = withDashboardPackageRecoveryEvidence(getJob(job.id)!, intent);
  const documents = (pending.details!.dashboardPackageResults as Array<{ documents: Array<Record<string, unknown>> }>)[0].documents;
  assert.equal(documents[0].created, true); assert.equal(documents[0].canVerifyExistingCopy, true);
  assert.match(String(documents[0].url), /\/dashboards\/[a-f0-9]{12}$/);
  const item = getJob(job.id)!.items.find(item => item.details?.packageOperation === 'import:source-document')!;
  const response = await migrationJobsHandler(recoveryRequest(job.id));
  assert.equal(response.status, 200, await response.clone().text());
  const done = getJob(job.id)!;
  assert.equal(done.status, 'succeeded', JSON.stringify(done.details?.dashboardPackageResults));
  assert.deepEqual(calls, ['import', 'query']);
  const original = done.items.find(row => row.id === item.id)!;
  assert.equal(original.status, 'failed'); assert.equal(original.error, item.error); assert.equal(original.endedAt, item.endedAt);
  assert.equal(original.details?.safeCopyAttemptState, 'verified');
  const audits = done.details!.dashboardPackageImportRecoveries as Array<Record<string, unknown>>;
  assert.equal(audits.length, 1); assert.equal(audits[0].itemId, item.id); assert.match(String(audits[0].contentHash), /^[a-f0-9]{64}$/);
  await migrationJobsHandler(recoveryRequest(job.id)); assert.deepEqual(calls, ['import', 'query']);
  const bad = structuredClone(done); (bad.details!.dashboardPackageImportRecoveries as Array<Record<string, unknown>>)[0].contentHash = 'omni_credential_like_secret';
  assert.equal(sanitizeJob(bad).details!.dashboardPackageImportRecoveries, undefined);
});

test('verify-import handler rejects locked, unsupported, wrong-target and query-routed recovery without writes', async () => {
  const { job } = await retainedFailure();
  lockVault(); assert.equal((await migrationJobsHandler(recoveryRequest(job.id))).status, 423);
  unlockVault('fictional package integration passphrase');
  assert.equal((await migrationJobsHandler(recoveryRequest(job.id, 'target', { requestId: recoveryId, sourceDocumentId: 'source-document', approveAll: true }))).status, 400);
  assert.equal((await migrationJobsHandler(recoveryRequest(job.id, 'target', { requestId: 'bad', sourceDocumentId: 'source-document' }))).status, 400);
  assert.equal((await migrationJobsHandler(recoveryRequest(job.id, 'other'))).status, 409);
  assert.equal((await migrationJobsHandler(recoveryRequest(job.id, 'target', undefined, '?targetId=other'))).status, 400);
  assert.deepEqual(calls, ['import']);
  assert.equal(getJob(job.id)!.items.find(item => item.details?.packageOperation === 'import:source-document')?.details?.safeCopyAttemptState, 'uncertain');
});

test('retained import recovery refuses source, destination, artifact and concurrent-ledger drift', async () => {
  const { job, intent } = await retainedFailure();
  const recover = () => verifyDashboardPackageImport(job.id, intent, 'target', 'source-document', recoveryId);
  const read = OmniClient.prototype.getModelYaml;
  const sourceChange = mock.method(OmniClient.prototype, 'getModelYaml', async function(this: OmniClient, id: string, options?: Parameters<OmniClient['getModelYaml']>[1]) {
    return id === 'source-model' ? snapshot({ 'changed.view': view }) : read.call(this, id, options);
  });
  await assert.rejects(recover, /source package changed/); sourceChange.mock.restore();
  targetFiles['unrelated.view'] = view; await assert.rejects(recover); delete targetFiles['unrelated.view'];
  brokenPlacements.add(importIdentity); await assert.rejects(recover); brokenPlacements.delete(importIdentity);
  const saved = retained.get(importIdentity)!; const document = saved.payload.document as Record<string, unknown>;
  document.description = 'Changed native content'; await assert.rejects(recover, /content requires review/); delete document.description;
  const exportRead = OmniClient.prototype.exportDocument;
  let changed = false;
  mock.method(OmniClient.prototype, 'exportDocument', async function(this: OmniClient, id: string) {
    if (id === importIdentity && !changed) { changed = true; updateJobAtomically(job.id, row => ({ ...row, details: { ...row.details, concurrentChange: true } })); }
    return exportRead.call(this, id);
  });
  await assert.rejects(recover); assert.deepEqual(calls, ['import']);
  assert.equal(getJob(job.id)!.details?.dashboardPackageImportRecoveries, undefined);
});

test('retained import recovery never admits missing receipts', async () => {
  importLost = true; const { job, intent } = await approved(); await runDashboardPackageJob(job.id, intent);
  await assert.rejects(() => verifyDashboardPackageImport(job.id, intent, 'target', 'source-document', recoveryId));
  assert.deepEqual(calls, ['import']);
  const cloned = structuredClone(getJob(job.id)!);
  assert.equal((withDashboardPackageRecoveryEvidence(cloned, intent).details!.dashboardPackageResults as Array<{ documents: Array<{ canVerifyExistingCopy: boolean }> }>)[0].documents[0].canVerifyExistingCopy, false);
});

test('retained import recovery cannot bypass another same-origin uncertain write', async () => {
  const { job, intent } = await retainedFailure();
  upsertInstance({ id: 'target-alias', label: 'Same example target', baseUrl: 'https://target.example.invalid', apiKey: 'fictional-alias', role: 'destination' });
  const saved = getJob(job.id)!;
  const conflictingId = '1baa2345-2222-4222-8222-112233445566';
  const item = saved.items.find(row => row.details?.packageOperation === 'import:source-document')!;
  insertJob({ ...saved, id: conflictingId, items: [{ ...item, id: 'another-dispatch', jobId: conflictingId,
    destinationId: 'target-alias', details: { ...item.details, safeCopyDestinationInstanceId: 'target-alias', packageOperation: 'restore_local:other:file' } }] });
  await assert.rejects(() => verifyDashboardPackageImport(job.id, intent, 'target', 'source-document', recoveryId));
  assert.deepEqual(calls, ['import']);
  assert.equal(getJob(job.id)!.details?.dashboardPackageImportRecoveries, undefined);
  assert.equal(getJob(job.id)!.items.find(row => row.id === item.id)?.details?.safeCopyAttemptState, 'uncertain');
});

test('a later retained import can reconcile after an explicitly audited earlier import', async () => {
  const { job, intent } = await retainedFailure({ ...initialIntent, source: { ...initialIntent.source, documentIds: ['source-document', 'source-document-two'] } });
  const secondFailure = await verifyDashboardPackageImport(job.id, intent, 'target', 'source-document', recoveryId);
  assert.equal(secondFailure.job.status, 'partial');
  assert.equal(calls.filter(call => call === 'import').length, 2);
  brokenPlacements.delete(importIdentity);
  const done = await verifyDashboardPackageImport(job.id, intent, 'target', 'source-document-two', '01ab2345-2222-4222-8222-112233445566');
  assert.equal(done.job.status, 'succeeded', JSON.stringify(done.job.details?.dashboardPackageResults));
  assert.equal(calls.filter(call => call === 'import').length, 2);
  assert.equal((done.job.details!.dashboardPackageImportRecoveries as unknown[]).length, 2);
});
test('missing shared dependency is branch-written, validated and merged before importing', async () => {
  targetFiles = {}; const { job, intent } = await approved(); const done = await runDashboardPackageJob(job.id, intent);
  assert.equal(done.job.status, 'succeeded', JSON.stringify(done.job.details?.dashboardPackageResults));
  assert.deepEqual(calls, ['branch', 'yaml', 'validate', 'merge', 'import', 'query']);
});
test('protected model pauses on its reviewed branch and continues only after exact external merge', async () => {
  targetFiles = {}; protectedModel = true; const { job, intent } = await approved(); await runDashboardPackageJob(job.id, intent);
  assert.equal((getJob(job.id)!.details?.dashboardPackageResults as Array<{ status: string }>)[0].status, 'waiting_approval');
  assert.deepEqual(calls, ['branch', 'yaml', 'validate']);
  targetFiles = { ...branch }; const done = await runDashboardPackageJob(job.id, intent, 'target');
  assert.equal(done.job.status, 'succeeded', JSON.stringify(done.job.details?.dashboardPackageResults));
  assert.equal(calls.includes('merge'), false); assert.equal(calls.filter(call => call === 'import').length, 1);
});
test('unknown import outcome is retained and never automatically imported again', async () => {
  importLost = true; const { job, intent } = await approved(); await runDashboardPackageJob(job.id, intent);
  const again = await runDashboardPackageJob(job.id, intent, 'target');
  assert.equal((again.job.details?.dashboardPackageResults as Array<{ status: string }>)[0].status, 'uncertain');
  assert.equal(calls.filter(call => call === 'import').length, 1);
});
test('query failure resumes verification of the same document without another import', async () => {
  queryFails = true; const { job, intent } = await approved(); await runDashboardPackageJob(job.id, intent);
  queryFails = false; const done = await runDashboardPackageJob(job.id, intent, 'target');
  assert.equal(done.job.status, 'succeeded', JSON.stringify(done.job.details?.dashboardPackageResults));
  assert.equal(calls.filter(call => call === 'import').length, 1);
});
test('destination drift after approval prevents every write', async () => {
  const { job, intent } = await approved(); targetFiles['unrelated.view'] = view;
  const done = await runDashboardPackageJob(job.id, intent);
  assert.equal(done.job.status, 'failed'); assert.deepEqual(calls, []);
});
test('a dashboard moved during query checks cannot receive placement verification', async () => {
  const { job, intent } = await approved();
  mock.method(OmniClient.prototype, 'runQuery', async () => {
    mock.method(OmniClient.prototype, 'listDocumentInventory', async () => ({ documents: [], pagination: { complete: true } }));
    return { status: 'COMPLETE', rowCount: 0 };
  });
  const done = await runDashboardPackageJob(job.id, intent);
  assert.equal(done.job.status, 'failed');
  assert.equal((done.job.details?.dashboardPackageResults as Array<{ documents: Array<{ status: string }> }>)[0].documents[0].status, 'needs_review');
});
test('changed local formulas are detected by final readback, without overwriting them', async () => {
  const { job, intent } = await approved();
  const read = OmniClient.prototype.getModelYaml;
  mock.method(OmniClient.prototype, 'runQuery', async () => {
    mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, id: string, options?: Parameters<OmniClient['getModelYaml']>[1]) {
      return id === 'target-workbook' ? snapshot({ 'changed.view': view }) : read.call(this, id, options);
    });
    return { status: 'COMPLETE', rowCount: 0 };
  });
  const done = await runDashboardPackageJob(job.id, intent);
  assert.equal(done.job.status, 'failed'); assert.equal(calls.includes('yaml'), false);
  assert.match(JSON.stringify(done.job.details?.dashboardPackageResults), /differing authored definitions/);
});
test('approving a subset preserves its pair-bound fingerprint and excludes other destinations', async () => {
  upsertInstance({ id: 'other-target', label: 'Another example target', baseUrl: 'https://other.example.invalid', apiKey: 'fictional-test', role: 'destination' });
  const plan = await createDashboardDeploymentPlan({ ...initialIntent, destinations: [initialIntent.destinations[0],
    { ...initialIntent.destinations[0], targetId: 'second-target', instanceId: 'other-target' }] });
  const { job } = await deployDashboardDeploymentPlan(plan.id, { revision: plan.revision, targetIds: ['target'],
    requestId: 'd9d3f96b-6b7c-4a13-a41c-6bf08033cbb8', confirmDependencies: true, confirmDestinationAudience: true }, null);
  const done = await runDashboardPackageJob(job.id, dashboardSafeCopyIntentFromJob(job));
  assert.equal(done.job.status, 'succeeded', JSON.stringify(done.job.details?.dashboardPackageResults));
  assert.equal((done.job.details?.dashboardPackageResults as unknown[]).length, 1);
});
