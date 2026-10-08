import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { parse, stringify } from 'yaml';
import type { DashboardSafeCopyIntent } from '../shared/dashboardSafeCopyContract';
import { packageBoundary, packageHash, prepareDashboardPackageTarget, type DashboardPackageCollection } from '../server/services/dashboardPackagePlan';
import type { DashboardPackage } from '../server/services/dashboardPackageTransport';
import { OmniClient, type OmniModelYamlResponse, resetOmniClientRateLimitStateForTests } from '../server/services/omniClient';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';

// Fictional packages only. All network methods are mocked; the vault is isolated.
const intent: DashboardSafeCopyIntent = {
  profile: 'safe_copy_v1', requestId: '0c039ae8-921c-4c49-b456-f491899b2137',
  source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['example-document'] },
  destinations: [{ targetId: 'destination', instanceId: 'destination', connectionId: 'destination-connection', modelId: 'destination-model', folderId: 'example-folder' }],
};
const field = (name: string) => ({ sql: name.startsWith('TABLE.') ? '${TABLE}.' + name.slice(6) : '${' + name + '}' });
const view = (dimensions: Record<string, unknown>) => stringify({ table_name: 'example_records', dimensions });
const snapshot = (files: Record<string, string>): OmniModelYamlResponse => {
  const checksums = Object.fromEntries(Object.keys(files).map(name => [name, 'example-checksum-' + name]));
  return { files, checksums, raw: { files, checksums } };
};
const tile = (miniUuid: string, fields: string[], extension?: string) => ({ queryPresentation: { miniUuid,
  query: { queryJson: { fields, ...(extension ? { model_extension_id: extension } : {}) } } } });
function pkg(tiles = [tile('shared-tile', ['records.id'])]): DashboardPackage {
  return { documentId: 'example-document', name: 'Example dashboard', sharedModelId: 'source-model', connectionId: 'source-connection',
    workbookModelId: 'workbook', localModels: [{ sourceModelId: 'workbook', scope: 'workbook', files: {} }],
    topicNames: [], fieldRefs: ['ignored.aggregate'], fingerprint: 'example-source-fingerprint',
    exportPayload: { dashboard: { queryPresentationCollection: { queryPresentationCollectionMemberships: tiles } } } };
}
const shared = { 'records.view': view({ id: field('TABLE.id'), first: field('TABLE.first'), second: field('TABLE.second') }) };
function collection(pack = pkg(), source = snapshot(shared)): DashboardPackageCollection {
  return { packages: [pack], shared: new Map([['source-model', source]]), sourceHashes: { 'example-document': pack.fingerprint },
    sourceModelHashes: { 'source-model': packageHash(source.files) }, dialect: 'snowflake', boundary: packageBoundary(intent) };
}
let temporaryRoot = '';
let previousVaultPath: string | undefined;
let target: OmniModelYamlResponse;
beforeEach(() => {
  previousVaultPath = process.env.OMNIKIT_VAULT_PATH;
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-package-plan-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  unlockVault('fictional package test passphrase');
  for (const role of ['source', 'destination'] as const) upsertInstance({ id: role, label: role, role,
    baseUrl: `https://${role}.example.invalid`, apiKey: 'fictional-test-credential' });
  target = snapshot({});
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in fictional package test'); });
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'destination-model', name: 'Example model',
    connectionId: 'destination-connection', kind: 'SHARED' }]);
  mock.method(OmniClient.prototype, 'listConnections', async () => [{ id: 'destination-connection', name: 'Example connection', dialect: 'snowflake' }]);
  mock.method(OmniClient.prototype, 'listFolderInventory', async () => ({ folders: [{ id: 'example-folder', name: 'Example', path: '/Example' }],
    pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 1 } }));
  mock.method(OmniClient.prototype, 'getModelYaml', async () => structuredClone(target));
});
afterEach(() => {
  mock.restoreAll(); resetOmniClientRateLimitStateForTests(); resetVault(); lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (previousVaultPath === undefined) delete process.env.OMNIKIT_VAULT_PATH;
  else process.env.OMNIKIT_VAULT_PATH = previousVaultPath;
});
const prepare = (value = collection()) => prepareDashboardPackageTarget(intent, intent.destinations[0], value);

test('database/schema approval is exact, fingerprinted, and revalidated across tile scopes', async () => {
  const source = snapshot({ 'source/records.view': 'catalog: EXAMPLE_SOURCE\nschema: REPORTING\n' + view({ id: field('TABLE.id') }) });
  const targetText = '# Keep destination formatting\ncatalog: EXAMPLE_TARGET\nschema: REPORTING\n' + view({ id: field('TABLE.id') });
  target = snapshot({ 'destination/records.view': targetText });
  const context = collection(pkg([tile('one', ['records.id']), tile('two', ['records.id'])]), source);
  const held = await prepare(context);
  assert.equal(held.preview.bindingMappings?.length, 1);
  assert.ok(held.preview.issues.length > 0);
  const destination = { ...intent.destinations[0], bindingMappings: held.preview.bindingMappings };
  const approvedIntent = { ...intent, destinations: [destination] };
  const approved = await prepareDashboardPackageTarget(approvedIntent, destination, context);
  assert.deepEqual(approved.preview.issues, []);
  assert.equal(approved.preview.files[0].action, 'reuse');
  assert.equal(approved.preview.files[0].after, targetText);
  assert.notEqual(approved.preview.fingerprint, held.preview.fingerprint);
  assert.deepEqual(approved.preview.bindingMappings, held.preview.bindingMappings);
  target = snapshot({ 'destination/records.view': targetText.replace('EXAMPLE_TARGET', 'EXAMPLE_CHANGED') });
  const stale = await prepareDashboardPackageTarget(approvedIntent, destination, context);
  assert.ok(stale.preview.issues.some(issue => /MAPPING_STALE/.test(issue.code)));
  target = snapshot({ 'destination/records.view': targetText });
  const unused = { ...destination, bindingMappings: [{ ...destination.bindingMappings![0], sourceFileName: 'unused.view' }] };
  const unmatched = await prepareDashboardPackageTarget({ ...intent, destinations: [unused] }, unused, context);
  assert.ok(unmatched.preview.issues.some(issue => issue.code === 'DATABASE_SCHEMA_MAPPING_STALE'));
});

test('topic metadata on the presentation or query wrapper supplies only that tile’s authored join scope', async () => {
  const sourceFiles = snapshot({
    'example_topic.topic': 'base_view: records\njoins:\n  regions: {}\nfields: [records.id, regions.id]\n',
    'records.view': view({ id: field('TABLE.id') }), 'regions.view': view({ id: field('TABLE.id') }),
    relationships: stringify([{ join_from_view: 'records', join_to_view: 'regions', on_sql: '${records.id} = ${regions.id}' }]),
  });
  for (const location of ['presentation', 'wrapper']) {
    const scoped = tile('scoped-tile', ['records.id', 'regions.id']);
    Object.assign(location === 'presentation' ? scoped.queryPresentation : scoped.queryPresentation.query, { topicName: 'example_topic' });
    const source = pkg([scoped]);
    const before = structuredClone(source.exportPayload);
    const planned = await prepare(collection(source, sourceFiles));
    assert.deepEqual(planned.preview.issues, []);
    assert.ok(planned.preview.files.some(file => file.fileName === 'example_topic.topic'));
    assert.ok(planned.preview.files.some(file => file.fileName === 'relationships'));
    assert.deepEqual(source.exportPayload, before);

    const withoutTopic = tile('topic-less-tile', ['records.id', 'regions.id']);
    const isolated = pkg([scoped, withoutTopic]);
    isolated.topicNames = ['example_topic']; // Aggregate inventory is not another tile's authority.
    const held = await prepare(collection(isolated, sourceFiles));
    assert.ok(held.preview.issues.some(issue => issue.code === 'TOPIC_CONTEXT_REQUIRED' && issue.reference.includes('/topic-less-tile/')));
    assert.equal(held.preview.issues.some(issue => issue.code === 'TOPIC_CONTEXT_REQUIRED' && issue.reference.includes('/scoped-tile/')), false);
  }
});

test('package planning keeps sibling query scopes separate and unions only shared dependencies', async () => {
  const source = pkg([tile('first-tile', ['local.calculated'], 'query-first'), tile('second-tile', ['local.calculated'], 'query-second'), tile('shared-tile', ['records.id'])]);
  source.localModels.push({ sourceModelId: 'query-first', scope: 'query', files: { 'local.view': stringify({ dimensions: { calculated: field('records.first') } }) } },
    { sourceModelId: 'query-second', scope: 'query', files: { 'local.view': stringify({ dimensions: { calculated: field('records.second') } }) } });
  const result = await prepare(collection(source));
  assert.deepEqual(result.preview.issues, []);
  assert.deepEqual(result.preview.files.map(file => file.fileName), ['records.view']);
  assert.deepEqual(Object.keys(parse(result.preview.files[0].after).dimensions).sort(), ['first', 'id', 'second']);
  assert.equal(result.preview.files[0].action, 'create');
  assert.equal(result.preview.files[0].after.includes('calculated'), false);
});

test('package planning composes additive local layers but holds conflicting overrides and non-view security scopes', async () => {
  const source = pkg([tile('local-tile', ['local.calculated'], 'query')]);
  source.localModels[0].files = { 'local.view': stringify({ dimensions: { base: field('records.first') } }) };
  source.localModels.push({ sourceModelId: 'query', scope: 'query', files: { 'local.view': stringify({ dimensions: { calculated: field('local.base') } }) } });
  const additive = await prepare(collection(source));
  assert.deepEqual(additive.preview.issues, []);
  assert.deepEqual(Object.keys(parse(additive.preview.files[0].after).dimensions), ['first']);
  source.localModels[1].files['local.view'] = stringify({ dimensions: { base: field('records.second'), calculated: field('local.base') } });
  const conflicting = await prepare(collection(source));
  assert.ok(conflicting.preview.issues.some(issue => issue.code === 'LOCAL_LAYER_CONFLICT' && issue.reference.endsWith('/local-tile/local.view')));
  assert.deepEqual(conflicting.preview.files, []);
  source.localModels[1].files = { model: 'default_topic_required_access_grants: [restricted]\n' };
  const policy = await prepare(collection(source));
  assert.ok(policy.preview.issues.some(issue => issue.code === 'LOCAL_DEPENDENCY_SCOPE_UNSUPPORTED'));
});

test('package planning rejects normalized-away shared and destination evidence and wrong model kinds', async () => {
  target = { files: {}, raw: { files: { 'invalid.view': null } } };
  await assert.rejects(prepare(), /Complete authored model YAML evidence/);
  target = snapshot({});
  await assert.rejects(prepare(collection(pkg(), { files: {}, raw: { files: [] } })), /Complete authored model YAML evidence/);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'destination-model', name: 'Example query model', connectionId: 'destination-connection', kind: 'QUERY' }]);
  await assert.rejects(prepare(), /selected model does not resolve/);
});

test('package fingerprint binds all destination bytes and checksums with stable catalog order', async () => {
  target = snapshot({ 'unrelated.view': 'dimensions: {}\n', model: '{}\n' });
  const baseline = await prepare();
  target = snapshot({ model: '{}\n', 'unrelated.view': 'dimensions: {}\n' });
  assert.equal((await prepare()).preview.fingerprint, baseline.preview.fingerprint);
  target = snapshot({ model: '{}\n', 'unrelated.view': 'dimensions: {native: {sql: native_column}}\n' });
  assert.notEqual((await prepare()).preview.fingerprint, baseline.preview.fingerprint);
  target = snapshot({ model: '{}\n', 'unrelated.view': 'dimensions: {}\n' });
  target.checksums!['unrelated.view'] = 'changed-checksum';
  assert.notEqual((await prepare()).preview.fingerprint, baseline.preview.fingerprint);
});

test('package planning holds missing destination checksums and ambiguous native folder paths', async () => {
  const files = { 'records.view': view({ native: field('TABLE.native') }) };
  target = { files, raw: { files } };
  assert.ok((await prepare()).preview.issues.some(issue => issue.code === 'DESTINATION_CHECKSUM_UNAVAILABLE'));
  mock.method(OmniClient.prototype, 'listFolderInventory', async () => ({ folders: [
    { id: 'example-folder', name: 'Example', path: '/Example' }, { id: 'duplicate-folder', name: 'Example', path: 'Example/' },
  ], pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 2 } }));
  await assert.rejects(prepare(), /unique native path/);
});

test('package planning rejects stale credential boundaries and preserves cancellation', async () => {
  const collected = collection();
  upsertInstance({ id: 'destination', apiKey: 'different-fictional-credential' });
  await assert.rejects(prepare(collected), /saved connection changed/);
  const controller = new AbortController(); controller.abort(new Error('Example canceled request'));
  await assert.rejects(prepareDashboardPackageTarget(intent, intent.destinations[0], collection(), controller.signal), /Example canceled request/);
});
