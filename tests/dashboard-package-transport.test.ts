import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadDashboardPackage, listDashboardPackageTiles, restoreDashboardPackageLocals, retargetDashboardPackage,
  verifyDashboardPackageContent } from '../server/services/dashboardPackageTransport';
import { OmniClient, OmniWriteNotDispatchedError, resetOmniClientRateLimitStateForTests, type OmniWriteDispatchGuard } from '../server/services/omniClient';

// Fictional native package fixtures only; no tenant, vault, or history access.
const source = {
  exportVersion: '0.1', document: { name: 'Example dashboard', description: 'source-model is a literal label' },
  workbookModel: { id: 'source-workbook', base_model_id: 'source-model', connection_id: 'source-connection' },
  queryModels: { 'source-query': { id: 'source-query', base_model_id: 'source-workbook', connection_id: 'source-connection', model_kind: 'QUERY', views: [] } },
  dashboard: { id: 'source-dashboard', queryPresentationCollection: { id: 'source-collection', queryPresentationCollectionMemberships: [
    { id: 'source-membership', queryPresentation: { id: 'source-presentation', miniUuid: 'source-tile', name: 'Example tile', query: {
      id: 'source-query-record', queryJson: { model_id: 'source-model', connection_id: 'source-connection', model_extension_id: 'source-query',
        topic: 'example_topic', fields: ['orders.amount'], filters: { 'orders.label': { value: 'source-model' } }, sql: "SELECT 'source-connection'" },
    }, visualization: { description: 'source-model' } } },
  ] } },
  colorPalettes: {},
};
const sourceFiles = {
  'source-workbook': { 'orders.view': 'dimensions:\n  amount:\n    sql: ${TABLE}.amount\n' },
  'source-query': { 'a.view': 'dimensions:\n  derived:\n    sql: ${z.amount}\n',
    'z.query.view': 'query:\n  fields:\n    orders.amount: amount\n', 'relationships': '[]\n', 'example.topic': 'base_view: a\n' },
};
const target = { modelId: 'target-model', connectionId: 'target-connection', name: 'Example review copy', identifier: 'example-review-copy', folderPath: '/Example' };
const tileMap = { 'source-tile': 'target-tile' };
const snapshot = (value: Record<string, string>) => ({ files: structuredClone(value), checksums: Object.fromEntries(Object.keys(value).map(name => [name, 'checksum-' + name])), raw: { files: structuredClone(value) } });
function sourceClient(native: unknown = source) {
  return {
    getDocumentStateV2: async () => ({ name: 'Example dashboard', modelId: 'source-model', workbookModelId: 'source-workbook' }),
    exportDocument: async () => structuredClone(native),
    listModels: async ({ modelId }: { modelId: string }) => [{ id: modelId, name: modelId, kind: modelId === 'source-model' ? 'SHARED' : modelId === 'source-workbook' ? 'WORKBOOK' : 'QUERY',
      connectionId: 'source-connection', baseModelId: modelId === 'source-query' ? 'source-workbook' : 'source-model' }],
    getModelYaml: async (modelId: keyof typeof sourceFiles, options: { mode?: string; fullyResolved?: boolean }) => {
      assert.equal(options.mode, 'extension'); assert.equal(options.fullyResolved, false); return snapshot(sourceFiles[modelId]);
    },
  } as unknown as OmniClient;
}
async function fixture() {
  const pkg = await loadDashboardPackage(sourceClient(), 'source-document');
  const imported = retargetDashboardPackage(pkg, target);
  imported.workbookModel = { id: 'target-workbook', base_model_id: 'target-model', connection_id: 'target-connection' };
  imported.queryModels = { 'target-query': { id: 'target-query', base_model_id: 'target-workbook', connection_id: 'target-connection', model_kind: 'QUERY', views: [] } };
  const dashboard = imported.dashboard as typeof source.dashboard;
  dashboard.id = 'target-dashboard'; dashboard.queryPresentationCollection.id = 'target-collection';
  const membership = dashboard.queryPresentationCollection.queryPresentationCollectionMemberships[0];
  membership.id = 'target-membership'; membership.queryPresentation.id = 'target-presentation'; membership.queryPresentation.miniUuid = 'target-tile';
  membership.queryPresentation.query.id = 'target-query-record'; membership.queryPresentation.query.queryJson.model_extension_id = 'target-query';
  return { pkg, imported };
}
function destination(initial: Record<string, Record<string, string>> = { 'target-workbook': {}, 'target-query': {} }) {
  const stored = structuredClone(initial), writes: Array<{ modelId: string; fileName: string; yaml: string; mode?: string; previousChecksum?: string }> = [];
  let reads = 0;
  const client = {
    listModels: async ({ modelId }: { modelId: string }) => [{ id: modelId, name: modelId, kind: modelId === 'target-workbook' ? 'WORKBOOK' : 'QUERY',
      connectionId: 'target-connection', baseModelId: modelId === 'target-workbook' ? 'target-model' : 'target-workbook' }],
    getModelYaml: async (modelId: string) => { reads++; return snapshot(stored[modelId]); },
    updateModelYamlFile: async (input: typeof writes[number], guard: OmniWriteDispatchGuard) => {
      guard.signal?.throwIfAborted(); guard.assertCanDispatch(); writes.push(input); stored[input.modelId][input.fileName] = input.yaml;
    },
  } as unknown as OmniClient;
  return { client, writes, stored, reads: () => reads };
}
const guard = { assertCanDispatch() { /* Synthetic exclusive newly-imported-artifact authority. */ } };
afterEach(resetOmniClientRateLimitStateForTests);

test('native package captures complete exact local bindings, authored bytes, and selected dependencies', async () => {
  const pkg = await loadDashboardPackage(sourceClient(), 'source-document');
  assert.equal(pkg.sharedModelId, 'source-model'); assert.equal(pkg.connectionId, 'source-connection');
  assert.deepEqual(pkg.topicNames, ['example_topic']); assert.deepEqual(pkg.fieldRefs, ['orders.amount', 'orders.label']);
  assert.deepEqual(pkg.localModels.map(model => model.files), Object.values(sourceFiles));
  assert.match(pkg.fingerprint, /^sha256:[a-f0-9]{64}$/); assert.deepEqual(pkg.exportPayload, source);
});

test('topic metadata from presentation or query wrapper reaches inventory without changing native query JSON', async () => {
  for (const location of ['presentation', 'wrapper', 'query']) {
    const native = structuredClone(source);
    const presentation = native.dashboard.queryPresentationCollection.queryPresentationCollectionMemberships[0].queryPresentation;
    const query = presentation.query.queryJson as Record<string, unknown>;
    delete query.topic;
    Object.assign(location === 'presentation' ? presentation : location === 'wrapper' ? presentation.query : query,
      { topicName: 'Example topics/exact_topic' });
    const before = structuredClone(native), beforeQuery = structuredClone(query);
    const tiles = listDashboardPackageTiles(native);
    assert.equal(tiles[0].topicName, 'Example topics/exact_topic');
    assert.equal(tiles[0].query, query);
    assert.deepEqual(query, beforeQuery);
    const pkg = await loadDashboardPackage(sourceClient(native), 'source-document');
    assert.deepEqual(pkg.topicNames, ['Example topics/exact_topic']);
    assert.deepEqual(pkg.exportPayload, before);
    assert.deepEqual(native, before);
  }
});

test('topic metadata rejects conflicting or malformed declarations on the same tile', () => {
  for (const location of ['presentation', 'wrapper', 'query']) {
    const native = structuredClone(source);
    const presentation = native.dashboard.queryPresentationCollection.queryPresentationCollectionMemberships[0].queryPresentation;
    Object.assign(location === 'presentation' ? presentation : location === 'wrapper' ? presentation.query : presentation.query.queryJson,
      { topicName: 'different_topic' });
    assert.throws(() => listDashboardPackageTiles(native), /conflicting topic identities/);
  }
  for (const value of ['', ' ', '../topic', 'topic\n', 'x'.repeat(513), ['topic'], { name: 'topic' }, 123]) {
    const native = structuredClone(source);
    Object.assign(native.dashboard.queryPresentationCollection.queryPresentationCollectionMemberships[0].queryPresentation, { topicName: value });
    assert.throws(() => listDashboardPackageTiles(native), /bounded exact authored name or path/);
  }
});

test('topic metadata never borrows from another tile or dashboard-wide declarations', () => {
  const native = structuredClone(source);
  const rows = native.dashboard.queryPresentationCollection.queryPresentationCollectionMemberships;
  const sibling = structuredClone(rows[0]);
  sibling.queryPresentation.miniUuid = 'other-tile';
  delete (sibling.queryPresentation.query.queryJson as Record<string, unknown>).topic;
  rows.push(sibling);
  Object.assign(native.dashboard, { topicName: 'dashboard_wide_topic' });
  const tiles = listDashboardPackageTiles(native);
  assert.equal(tiles[0].topicName, 'example_topic');
  assert.equal(tiles[1].topicName, undefined);
  assert.equal(Object.hasOwn(tiles[1].query, 'topic'), false);
});

test('native package rejects malformed export, ambiguous bindings, and normalized-away local YAML', async () => {
  await assert.rejects(loadDashboardPackage(sourceClient({ ...source, queryModels: [] }), 'source-document'), /complete native/);
  const wrong = structuredClone(source); wrong.workbookModel.base_model_id = 'other-model';
  await assert.rejects(loadDashboardPackage(sourceClient(wrong), 'source-document'), /bindings disagree/);
  const malformed = sourceClient(); malformed.getModelYaml = async () => ({ files: {}, raw: { files: { 'bad.view': null } } });
  await assert.rejects(loadDashboardPackage(malformed, 'source-document'), /Complete authored/);
  const missing = sourceClient(); missing.listModels = async () => [];
  await assert.rejects(loadDashboardPackage(missing, 'source-document'), /shared-model connection/);
});

test('retargeting changes known identities without rewriting SQL, labels, filters, or local identity', async () => {
  const pkg = await loadDashboardPackage(sourceClient(), 'source-document'), before = structuredClone(pkg);
  const next = retargetDashboardPackage(pkg, target), query = listDashboardPackageTiles(next)[0].query;
  assert.equal(next.identifier, target.identifier); assert.equal(next.baseModelId, target.modelId);
  assert.equal(query.model_id, target.modelId); assert.equal(query.connection_id, target.connectionId);
  assert.equal(query.model_extension_id, 'source-query'); assert.equal(query.sql, "SELECT 'source-connection'");
  assert.deepEqual(query.filters, { 'orders.label': { value: 'source-model' } });
  assert.equal((next.document as Record<string, unknown>).description, 'source-model is a literal label');
  assert.deepEqual(pkg, before);
});

test('local restoration pairs exact imported IDs, orders dependencies, and verifies every write', async () => {
  const { pkg, imported } = await fixture(), dest = destination();
  const receipts = await restoreDashboardPackageLocals(pkg, imported, tileMap, dest.client, guard);
  assert.deepEqual(dest.writes.map(write => write.fileName), ['orders.view', 'z.query.view', 'a.view', 'relationships', 'example.topic']);
  assert.ok(dest.writes.every(write => write.mode === 'extension' && write.modelId !== 'target-model'));
  assert.deepEqual(dest.stored['target-query'], sourceFiles['source-query']);
  assert.deepEqual(receipts.map(receipt => [receipt.scope, receipt.targetModelId, receipt.filesWritten]), [['workbook', 'target-workbook', 1], ['query', 'target-query', 4]]);
  assert.ok(dest.reads() >= 14); assert.match(receipts[0].fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('local restoration rejects missing tile maps, shared identities and nonempty conflicting targets before writing', async () => {
  const { pkg, imported } = await fixture(), dest = destination();
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, {}, dest.client, guard), /exact imported tile/);
  const reused = structuredClone(imported); (reused.workbookModel as Record<string, unknown>).id = pkg.sharedModelId;
  await assert.rejects(restoreDashboardPackageLocals(pkg, reused, tileMap, dest.client, guard), /identities/);
  const conflict = destination({ 'target-workbook': {}, 'target-query': { 'a.view': 'dimensions:\n  native:\n' } });
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, tileMap, conflict.client, guard), /differing authored/);
  assert.equal(dest.writes.length + conflict.writes.length, 0);
});

test('local restoration requires checksum for existing files and new-artifact authority for absent files', async () => {
  const { pkg, imported } = await fixture(), dest = destination();
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, tileMap, dest.client), /exclusive-job/);
  const existing = destination({ 'target-workbook': { 'orders.view': '{}\n' }, 'target-query': {} });
  const get = existing.client.getModelYaml.bind(existing.client);
  existing.client.getModelYaml = async (...args) => ({ ...await get(...args), checksums: {} });
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, tileMap, existing.client, guard), /conflict checksum/);
  assert.equal(dest.writes.length + existing.writes.length, 0);
});

test('local restoration stops on concurrent changes, readback differences, and cancellation without retry', async () => {
  const { pkg, imported } = await fixture(), concurrent = destination();
  const read = concurrent.client.getModelYaml.bind(concurrent.client);
  concurrent.client.getModelYaml = async (...args) => {
    if (concurrent.reads() === 2) concurrent.stored['target-workbook']['native.view'] = 'dimensions: {}\n';
    return read(...args);
  };
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, tileMap, concurrent.client, guard), /changed concurrently/);
  assert.equal(concurrent.writes.length, 0);
  const corrupt = destination(), write = corrupt.client.updateModelYamlFile.bind(corrupt.client);
  corrupt.client.updateModelYamlFile = async (...args) => { await write(...args); corrupt.stored[args[0].modelId][args[0].fileName] = 'altered: true\n'; };
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, tileMap, corrupt.client, guard), /not verified exactly/);
  assert.equal(corrupt.writes.length, 1);
  const canceled = new AbortController(); canceled.abort(new Error('Synthetic cancellation'));
  await assert.rejects(restoreDashboardPackageLocals(pkg, imported, tileMap, destination().client, { ...guard, signal: canceled.signal }), /Synthetic cancellation/);
});

test('native content verification normalizes paired IDs but preserves tile order, formulas, filters and destination binding', async () => {
  const { pkg, imported } = await fixture();
  const good = verifyDashboardPackageContent(pkg, imported, tileMap, target);
  assert.equal(good.verified, true, good.findings.join('; ')); assert.equal(good.checkedTiles, 1);
  assert.equal(good.queriesVerified, false); assert.equal(good.localModelsVerified, false);
  const altered = structuredClone(imported);
  listDashboardPackageTiles(altered)[0].query.filters = { 'orders.label': { value: 'different' } };
  assert.equal(verifyDashboardPackageContent(pkg, altered, tileMap, target).verified, false);
  const literalPkg = structuredClone(pkg), literalTarget = structuredClone(imported);
  listDashboardPackageTiles(literalPkg.exportPayload)[0].query.filters = { 'orders.label': { id: 'source-tile' } };
  listDashboardPackageTiles(literalTarget)[0].query.filters = { 'orders.label': { id: 'target-tile' } };
  assert.equal(verifyDashboardPackageContent(literalPkg, literalTarget, tileMap, target).verified, false, 'Identity normalization must not rewrite filter literals.');
  assert.equal(verifyDashboardPackageContent(pkg, imported, tileMap, { ...target, modelId: 'unapproved' }).verified, false);
  assert.equal(verifyDashboardPackageContent(pkg, imported, {}, target).verified, false);
});

test('guarded client import preserves approved identifier and parses nested identities without write retry', async () => {
  const calls: Array<{ method?: string; body: Record<string, unknown> }> = [];
  let checks = 0;
  const api = new OmniClient({ baseUrl: 'https://93.184.216.34', apiKey: 'synthetic-package-key', label: 'Example' }, {
    maxReadRetries: 3, fetchImpl: async (_url, init) => {
      calls.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ workbook: { id: 'target-document', miniUuid: 'example-review-copy', workbookModelId: 'target-workbook' }, miniUuidMap: tileMap }));
    },
  });
  const result = await api.importDocument({ exportPayload: source, baseModelId: target.modelId, documentName: target.name, identifier: target.identifier }, { assertCanDispatch() { checks++; } });
  assert.equal(calls[0].body.identifier, target.identifier); assert.equal(checks, 1);
  assert.equal(result.documentId, 'target-document'); assert.equal(result.workbookModelId, 'target-workbook'); assert.deepEqual(result.miniUuidMap, tileMap);
  let failedCalls = 0;
  const lost = new OmniClient({ baseUrl: 'https://93.184.216.34', apiKey: 'synthetic-package-lost', label: 'Example' }, {
    maxReadRetries: 3, fetchImpl: async () => { failedCalls++; throw new Error('Synthetic acknowledgement lost'); },
  });
  await assert.rejects(lost.importDocument({ exportPayload: source, baseModelId: target.modelId, documentName: target.name }, guard), /acknowledgement lost/);
  assert.equal(failedCalls, 1);
});

test('client extension writes and branch create/merge honor their immediate dispatch guard', async () => {
  let calls = 0;
  const api = new OmniClient({ baseUrl: 'https://93.184.216.34', apiKey: 'synthetic-package-revoked', label: 'Example' }, {
    fetchImpl: async () => { calls++; return new Response('{}'); },
  });
  const revoked = { assertCanDispatch() { throw new Error('Synthetic authority revoked'); } };
  for (const write of [
    () => api.updateModelYamlFile({ modelId: 'target-query', fileName: 'example.view', yaml: '{}', mode: 'extension' }, revoked),
    () => api.createModelBranch({ connectionId: 'target-connection', baseModelId: 'target-model', branchName: 'example-review' }, revoked),
    () => api.mergeModelBranch('target-model', 'example-review', { publishDrafts: false }, revoked),
  ]) await assert.rejects(write(), error => error instanceof OmniWriteNotDispatchedError);
  assert.equal(calls, 0);
});
