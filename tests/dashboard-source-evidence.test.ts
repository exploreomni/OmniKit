import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dashboardSourceFieldReferences, readDashboardSourceEvidence, type DashboardSourceYamlReadOptions } from '../server/services/dashboardSourceEvidence';

const sharedModelId = 'example-shared-model';
const workbookModelId = 'example-workbook-model';
const field = (sql = '${TABLE}.id') => ({ sql });
const view = (dimensions: Record<string, unknown>) => JSON.stringify({ dimensions });

function evidence(shared: Record<string, string>, workbook: Record<string, string>, references: string[]) {
  return readDashboardSourceEvidence({ sharedModelId, workbookModelId, references,
    loadYaml: async (modelId) => modelId === sharedModelId ? shared : workbook });
}

test('source evidence reads shared authored YAML and workbook extension separately without promoting local fields', async () => {
  const reads: Array<{ modelId: string; options: DashboardSourceYamlReadOptions }> = [];
  const shared = { 'nested/orders.query.view': view({ id: field() }) };
  const workbook = { 'nested/orders.query.view': view({ local_label: field('${orders.id}') }) };
  const result = await readDashboardSourceEvidence({ sharedModelId, workbookModelId, references: ['orders.local_label'],
    loadYaml: async (modelId, options) => { reads.push({ modelId, options }); return modelId === sharedModelId ? shared : workbook; } });
  assert.deepEqual(reads, [
    { modelId: sharedModelId, options: { fullyResolved: false } },
    { modelId: workbookModelId, options: { fullyResolved: false, mode: 'extension' } },
  ]);
  assert.equal(result.sharedFiles, shared);
  assert.equal(result.sharedFiles['nested/orders.query.view'].includes('local_label'), false);
  assert.deepEqual(result.fields.map(({ reference, provenance, sharedWriteAllowed }) => ({ reference, provenance, sharedWriteAllowed })), [
    { reference: 'orders.id', provenance: 'shared_authored', sharedWriteAllowed: true },
    { reference: 'orders.local_label', provenance: 'workbook_local', sharedWriteAllowed: false },
  ]);
  assert.deepEqual(result.requiredSharedFiles, ['nested/orders.query.view']);
  assert.deepEqual(result.requiredWorkbookFiles, ['nested/orders.query.view']);
  assert.equal(result.unverified, false, 'known local provenance is not a failed source read');
});

test('source evidence retains partial overrides and closes unqualified references without treating TABLE as a field', async () => {
  const result = await evidence({ 'orders.view': view({ id: field(), total: field('${id} + 1') }) },
    { 'orders.view': view({ total: { label: 'Workbook label' } }) }, ['orders.total']);
  const total = result.fields.find((entry) => entry.reference === 'orders.total')!;
  assert.equal(total.provenance, 'workbook_override');
  assert.deepEqual(total.definition, { sql: '${id} + 1', label: 'Workbook label' });
  assert.deepEqual(total.dependencies, ['orders.id']);
  assert.deepEqual(result.fields.map((entry) => entry.reference), ['orders.id', 'orders.total']);
});

test('source evidence taints shared parents when a dependency is workbook-local or overridden, including cycles', async () => {
  const result = await evidence({ 'orders.view': view({
    total: field('${local_value}'), local_value: field('${orders.total}'),
  }) }, { 'orders.view': view({ local_value: field('${orders.total} + 1') }) }, ['orders.total']);
  assert.deepEqual(result.blockedSharedWriteReferences, ['orders.local_value', 'orders.total']);
  assert.equal(result.fields.find((entry) => entry.reference === 'orders.total')?.provenance, 'shared_authored');
});

test('source reference extraction includes filter object keys, output field keys, and query.field values', async () => {
  const state = { query: { field: 'orders.id', filters: { 'orders.region': { is: 'Example region' } }, fields: { 'orders.total': {} } } };
  assert.deepEqual(dashboardSourceFieldReferences(state), ['orders.id', 'orders.region', 'orders.total']);
  const result = await readDashboardSourceEvidence({ sharedModelId, states: [state], loadYaml: async () => ({
    'orders.view': view({ id: field(), region: field(), total: field() }),
  }) });
  assert.equal(result.fields.length, 3);
  assert.equal(result.unverified, false);
});

test('missing authored fields remain inherited-unverified rather than being synthesized from query SQL', async () => {
  const result = await evidence({ 'orders.query.view': 'sql: SELECT category AS generated_label FROM example_table\n' }, {}, ['orders.generated_label']);
  assert.equal(result.fields[0].provenance, 'inherited_unverified');
  assert.equal(result.fields[0].definition, undefined);
  assert.equal(result.fields[0].sharedWriteAllowed, false);
  assert.equal(result.unverified, true);
});

test('ambiguous source basenames fail closed while explicit authored paths remain usable', async () => {
  const files = { 'first/orders.view': view({ id: field() }), 'second/orders.view': view({ id: field() }) };
  assert.equal((await evidence(files, {}, ['orders.id'])).fields[0].provenance, 'unverified');
  const exact = await evidence(files, {}, ['first/orders.id']);
  assert.equal(exact.fields[0].sharedWriteAllowed, true);
  assert.equal(exact.fields[0].sourceFileName, 'first/orders.view');
});

test('a failed workbook extension read blocks shared repair without leaking upstream error details', async () => {
  const result = await readDashboardSourceEvidence({ sharedModelId, workbookModelId, references: ['orders.id'], loadYaml: async (modelId) => {
    if (modelId === workbookModelId) throw new Error('private upstream diagnostic');
    return { 'orders.view': view({ id: field() }) };
  } });
  assert.equal(result.fields[0].sharedWriteAllowed, false);
  assert.equal(result.unverified, true);
  assert.equal(JSON.stringify(result.findings).includes('private upstream diagnostic'), false);
});

for (const [fileName, yaml] of [
  ['model', 'access_grants:\n  example_access:\n    user_attribute: example_attribute\n'],
  ['relationships', '- join_from_view: orders\n  join_to_view: regions\n'],
  ['orders.view', 'always_where: ${orders.id} > 0\n'],
  ['orders.view', 'dimensions: [unsupported]\n'],
  ['orders.view', 'dimensions: {broken: [\n'],
] as const) {
  test(`unsupported workbook overlay is an explicit prerequisite: ${fileName} ${yaml.slice(0, 18)}`, async () => {
    const result = await evidence({ 'orders.view': view({ id: field() }) }, { [fileName]: yaml }, ['orders.id']);
    assert.ok(result.findings.some((finding) => finding.reference === 'workbook_overlay' && finding.sourceFileName === fileName));
    assert.equal(result.fields[0].sharedWriteAllowed, !yaml.startsWith('dimensions:'), 'a file-level prerequisite does not invalidate otherwise authored field evidence');
    assert.equal(result.unverified, true);
  });
}

test('invalid or identical model bindings cannot authorize a source read or a shared repair', async () => {
  let reads = 0;
  const result = await readDashboardSourceEvidence({ sharedModelId, workbookModelId: sharedModelId, references: ['orders.id'],
    loadYaml: async () => { reads += 1; return {}; } });
  assert.equal(reads, 0);
  assert.equal(result.unverified, true);
  assert.equal(result.fields[0].sharedWriteAllowed, false);
});

test('known relation macros add required files without inventing containing-view fields', async () => {
  const result = await evidence({
    'summary.query.view': JSON.stringify({ sql: 'SELECT ${orders.id} FROM ${orders}', dimensions: { id: field() } }),
    'orders.view': view({ id: field() }),
  }, {}, ['summary.id']);
  assert.deepEqual(result.fields.map((entry) => entry.reference), ['orders.id', 'summary.id']);
  assert.deepEqual(result.requiredSharedFiles, ['orders.view', 'summary.query.view']);
  assert.equal(result.unverified, false);
});

test('unknown or ambiguous macros stay unresolved rather than becoming fabricated fields', async () => {
  const result = await evidence({
    'summary.query.view': JSON.stringify({ sql: 'SELECT ${orders} FROM ${unproven_relation}', dimensions: { id: field(), orders: field() } }),
    'orders.view': view({ id: field() }),
  }, {}, ['summary.id']);
  assert.deepEqual(result.fields.map((entry) => entry.reference), ['summary.id']);
  assert.equal(result.fields[0].sharedWriteAllowed, false);
  assert.equal(result.findings.filter((finding) => finding.reference === 'source_macro').length, 2);
  const formula = await evidence({ 'orders.view': view({ id: field('${unproven_field}') }) }, {}, ['orders.id']);
  assert.deepEqual(formula.fields.map((entry) => entry.reference), ['orders.id']);
  assert.equal(formula.unverified, true);
});

test('workbook presentation scalars are supported but unknown shapes and security remain prerequisites', async () => {
  const shared = { 'orders.view': view({ id: field() }) };
  const supported = await evidence(shared, { 'orders.view': JSON.stringify({ label: 'Example label', description: '${display_text}', group_label: 'Example group', folder: 'Example folder', schema_label: 'Example schema', display_order: 2, hidden: true }) }, ['orders.id']);
  assert.equal(supported.unverified, false);
  assert.equal(supported.fields[0].sharedWriteAllowed, true);
  assert.deepEqual(supported.findings, []);
  for (const properties of [{ folder: ['not a scalar'] }, { display_order: { unsupported: true } }, { required_access_grants: ['example'] }]) {
    const result = await evidence(shared, { 'orders.view': JSON.stringify(properties) }, ['orders.id']);
    assert.equal(result.unverified, true);
    assert.equal(result.fields[0].sharedWriteAllowed, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].reference, 'workbook_overlay');
  }
});
