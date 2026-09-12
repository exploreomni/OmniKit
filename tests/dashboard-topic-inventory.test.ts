import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDashboardTopicRelationInventory, dashboardTopicInventoryDiagnostics, dashboardTopicViewMatches } from '../server/services/dashboardTopicRelationInventory';

function mixedInventory() {
  return {
    viewNames: { model: '', relationships: '', 'examples/summary.topic': '', 'warehouse/orders.view': 'warehouse__orders', 'summary.query.view': 'summary' },
    files: { model: '{}\n', relationships: '[]\n', 'examples/summary.topic': 'base_view: summary\n',
      'warehouse/orders.view': 'dimensions:\n  id: {}\n', 'summary.query.view': 'sql: SELECT * FROM ${warehouse__orders}\n' },
  };
}

test('returned non-view placeholders are classified without losing actual view identities', () => {
  const inventory = readDashboardTopicRelationInventory(mixedInventory());
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.issues, []);
  assert.deepEqual(inventory.observedNames, ['summary', 'warehouse__orders']);
  assert.deepEqual(Object.keys(inventory.fingerprints).sort(), inventory.observedNames);
  assert.deepEqual(inventory.nonViewEntries.map((entry) => entry.kind).sort(), ['model', 'relationship', 'topic']);
  const diagnostics = dashboardTopicInventoryDiagnostics(inventory, ['warehouse__orders'], 'source');
  assert.equal(diagnostics.reduce((sum, row) => sum + row.count, 0), 3);
  assert(diagnostics.every((row) => row.severity === 'warning' && row.code === 'NON_VIEW_INDEX_ENTRY'));
  assert.deepEqual(dashboardTopicViewMatches(mixedInventory().files, inventory.fileNames, 'warehouse__orders'), { matches: ['warehouse/orders.view'], conflict: false });
});

test('an empty actual view remains globally blocking even beside classified non-view entries', () => {
  const raw = mixedInventory();
  const inventory = readDashboardTopicRelationInventory({ ...raw, viewNames: { ...raw.viewNames, 'unknown.view': '' }, files: { ...raw.files, 'unknown.view': 'dimensions: {}\n' } });
  assert.equal(inventory.complete, false);
  assert.equal(inventory.nonViewEntries.length, 3);
  assert(dashboardTopicInventoryDiagnostics(inventory, ['summary'], 'destination').some((row) => row.severity === 'blocker' && row.code === 'VIEW_NAME_UNSUPPORTED'));
  assert(!Object.hasOwn(inventory.fingerprints, 'unknown'));
});

test('a returned composite-topic file is non-view metadata, not a view to create', () => {
  const inventory = readDashboardTopicRelationInventory({ viewNames: { 'example.composite_topic': '' }, files: { 'example.composite_topic': 'topics: []\n' } });
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.observedNames, []);
  assert.equal(inventory.nonViewEntries[0].kind, 'topic');
});

test('missing authored non-view evidence and unexpected value types cannot authorize exclusion', () => {
  for (const fileName of ['model', 'relationships', 'examples/summary.topic']) {
    for (const files of [undefined, {}, { [fileName]: null }, { [fileName]: {} }]) {
      const inventory = readDashboardTopicRelationInventory({ viewNames: { [fileName]: '' }, files });
      assert.equal(inventory.complete, false);
      assert.equal(inventory.nonViewEntries.length, 0);
    }
    for (const value of [null, {}, [], 0]) {
      const inventory = readDashboardTopicRelationInventory({ viewNames: { [fileName]: value }, files: { [fileName]: '{}\n' } });
      assert.equal(inventory.complete, false);
      assert.equal(inventory.nonViewEntries.length, 0);
    }
  }
});

test('unrecognized filenames and traversal cannot be treated as non-view placeholders', () => {
  for (const fileName of ['example.yaml', 'nested/model', '../example.topic', '/example.topic', 'example.TOPIC', 'example.topic.view', 'model.view', 'relationships.view']) {
    const inventory = readDashboardTopicRelationInventory({ viewNames: { [fileName]: '' }, files: { [fileName]: '{}\n' } });
    assert.equal(inventory.complete, false, fileName);
    assert.equal(inventory.nonViewEntries.length, 0, fileName);
  }
});

test('non-view evidence remains bound to the inventory snapshot', () => {
  const raw = mixedInventory();
  const inventory = readDashboardTopicRelationInventory(raw);
  for (const changed of [
    { ...raw, files: { ...raw.files, model: 'label: Changed\n' } },
    { ...raw, viewNames: { ...raw.viewNames, model: ' ' } },
    { ...raw, files: { ...raw.files, relationships: '- join_from_view: summary\n  join_to_view: warehouse__orders\n' } },
  ]) assert.notEqual(readDashboardTopicRelationInventory(changed).snapshotHash, inventory.snapshotHash);
});

test('non-view files cannot claim a view identity or override a duplicate mapping', () => {
  const inventory = readDashboardTopicRelationInventory({
    viewNames: { 'example.topic': 'orders', 'orders.view': 'orders' },
    files: { 'example.topic': 'base_view: orders\n', 'orders.view': 'dimensions: {}\n' },
  });
  assert(!Object.hasOwn(inventory.fingerprints, 'orders'));
  assert(inventory.issues.some((issue) => issue.code === 'VIEW_MAPPING_KIND_CONFLICT'));
  assert(dashboardTopicInventoryDiagnostics(inventory, ['orders'], 'source').every((row) => row.severity === 'blocker'));
});

test('diagnostics expose counts and file kinds, not names or authored contents', () => {
  const privateText = 'example-private-payload';
  const inventory = readDashboardTopicRelationInventory({ viewNames: { [`${privateText}.topic`]: '' }, files: { [`${privateText}.topic`]: `description: ${privateText}\n` } });
  assert(!JSON.stringify(dashboardTopicInventoryDiagnostics(inventory, [], 'source')).includes(privateText));
  assert.match(inventory.nonViewEntries[0].evidenceHash, /^[a-f0-9]{64}$/);
});
