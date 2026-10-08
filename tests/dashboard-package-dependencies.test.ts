import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { planDashboardPackageDependencies as plan } from '../server/services/dashboardPackageDependencies';
import { dashboardPackageBindingKey, isDashboardPackageBindingMapping } from '../shared/dashboardPackageBindings';

// Fictional authored evidence only; these fixtures are not runtime model defaults.
const ref = (name: string) => '${' + name + '}';
const view = (dimensions: Record<string, unknown>) => stringify({ table_name: 'example_records', dimensions });
const field = (sql = ref('TABLE') + '.id') => ({ sql });

test('package topics close only required prefixed views and alias joins while preserving target-only entries', () => {
  const edge = { join_from_view: 'records', join_to_view: 'regions', join_to_view_as: 'shipping_region', on_sql: ref('records.region_id') + ' = ' + ref('shipping_region.id') };
  const unrelated = { join_from_view: 'unrelated', join_to_view: 'unrelated_detail', on_sql: '1=1' };
  const sourceFiles = {
    model: '{}\n',
    'Example topics/summary.topic': stringify({ base_view: 'records', joins: { shipping_region: {} }, fields: ['records.total', 'shipping_region.id'] }),
    'SOURCE.PUBLIC/records.view': view({ id: field(), region_id: field(ref('TABLE') + '.region_id'), total: field(ref('records.id') + ' + 1'), unused: field('unused_sql') }),
    'SOURCE.PUBLIC/regions.view': view({ id: field(), unused: field('other_unused_sql') }),
    'SOURCE.PUBLIC/unrelated.view': view({ id: field() }),
    'model/relationships': stringify([edge, unrelated]),
  };
  const before = '# destination comment\n' + view({ id: field(), native_only: field('native_expression') });
  const targetFiles = { model: '{}\n', 'TARGET.PUBLIC/records.view': before, 'target/relationships': stringify([unrelated]) };
  const result = plan({ sourceFiles, targetFiles, topicNames: ['summary'] });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.files.map(file => file.fileName), ['Example topics/summary.topic', 'SOURCE.PUBLIC/regions.view', 'target/relationships', 'TARGET.PUBLIC/records.view'].sort((a, b) => a.localeCompare(b)));
  const records = result.files.find(file => file.sourceFileName === 'SOURCE.PUBLIC/records.view')!;
  assert.equal(records.fileName, 'TARGET.PUBLIC/records.view');
  assert.equal(records.action, 'add');
  assert.equal(records.before, before);
  assert.match(records.after, /# destination comment/);
  assert.deepEqual(Object.keys(parse(records.after).dimensions).sort(), ['id', 'native_only', 'region_id', 'total']);
  assert.equal(parse(records.after).dimensions.native_only.sql, 'native_expression');
  const relationships = result.files.find(file => file.sourceFileName === 'model/relationships')!;
  assert.deepEqual(parse(relationships.after), [unrelated, edge]);
  assert.equal(sourceFiles['SOURCE.PUBLIC/records.view'].includes('unused_sql'), true, 'source strings are not mutated');
  assert.equal(targetFiles['TARGET.PUBLIC/records.view'], before, 'target strings are not mutated');
});

test('semantic equality ignores YAML formatting and keeps destination bytes unchanged', () => {
  const source = 'table_name: example_records\ndimensions:\n  id:\n    sql: ${TABLE}.id\n';
  const before = '# retain this comment\n{dimensions: {id: {sql: "${TABLE}.id"}}, table_name: example_records}\n';
  const result = plan({ sourceFiles: { 'source/records.view': source }, targetFiles: { 'target/records.view': before }, topicNames: [], fieldRefs: ['records.id'] });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.files, [{ fileName: 'target/records.view', sourceFileName: 'source/records.view', before, after: before, action: 'reuse' }]);
});

test('incompatible destination formulas or physical meanings are conflicts, never overwritten', () => {
  for (const before of [view({ id: field('different_sql') }), stringify({ table_name: 'different_table', dimensions: { id: field() } })]) {
    const result = plan({ sourceFiles: { 'records.view': view({ id: field() }) }, targetFiles: { 'records.view': before }, topicNames: [], fieldRefs: ['records.id'] });
    assert.equal(result.files[0].action, 'conflict');
    assert.equal(result.files[0].after, before);
    assert.equal(result.files[0].sourceComparison, view({ id: field() }));
    assert.match(result.files[0].reason!, /Only new definitions may be added/);
    assert.match(result.files[0].reason!, /\$\["(?:dimensions|table_name)"\]/);
    assert.ok(result.issues.some(issue => issue.code === 'DESTINATION_DEFINITION_CONFLICT'));
  }
});

test('conflict comparison exposes physical catalog differences without changing the destination', () => {
  const source = stringify({ catalog: 'SOURCE_EXAMPLE', schema: 'PUBLIC', table_name: 'example_records', dimensions: { id: field() } });
  const before = stringify({ catalog: 'TARGET_EXAMPLE', schema: 'PUBLIC', table_name: 'example_records', dimensions: { id: field(), target_only: field('42') } });
  const result = plan({ sourceFiles: { 'source/records.view': source }, targetFiles: { 'target/records.view': before }, topicNames: [], fieldRefs: ['records.id'] });
  assert.equal(result.files[0].after, before);
  assert.equal(result.files[0].sourceComparison, source);
  assert.match(result.files[0].reason!, /\$\["catalog"\]/);
  assert.equal(parse(result.files[0].after).dimensions.target_only.sql, '42');
  assert.equal(result.files[0].action, 'conflict');
});

test('ambiguous and case-only semantic identities never select a destination or fabricate a source', () => {
  const text = view({ id: field() });
  const ambiguous = plan({ sourceFiles: { 'records.view': text }, targetFiles: { 'a/records.view': text, 'b/records.view': text }, topicNames: [], fieldRefs: ['records.id'] });
  assert.ok(ambiguous.issues.some(issue => issue.code === 'DESTINATION_IDENTITY_AMBIGUOUS'));
  const caseOnly = plan({ sourceFiles: { 'records.view': text }, targetFiles: { 'RECORDS.view': text }, topicNames: [], fieldRefs: ['records.id'] });
  assert.ok(caseOnly.issues.some(issue => issue.code === 'DESTINATION_IDENTITY_COLLISION'));
  const duplicate = plan({ sourceFiles: { 'a/records.view': text, 'b/records.view': text }, targetFiles: {}, topicNames: [], fieldRefs: ['records.id'] });
  assert.ok(duplicate.issues.some(issue => issue.code === 'AMBIGUOUS_SOURCE_IDENTITY'));
  assert.deepEqual(duplicate.files, []);
  const exact = plan({ sourceFiles: { 'a/records.view': text, 'b/records.view': text }, targetFiles: {}, topicNames: [], fieldRefs: ['a/records.id'] });
  assert.deepEqual(exact.issues, []);
  assert.equal(exact.files[0].fileName, 'a/records.view');
});

test('workbook and query-local fields close shared dependencies but are never promoted', () => {
  const local = stringify({ sql: 'SELECT id FROM example_records', dimensions: { calculated: field(ref('records.id') + ' + 1') } });
  const result = plan({ sourceFiles: { 'records.view': view({ id: field(), unrelated: field() }) }, targetFiles: {},
    localFiles: { 'workbook/local.query.view': local }, topicNames: [], fieldRefs: ['local.calculated'] });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.files.map(file => file.fileName), ['records.view']);
  assert.deepEqual(Object.keys(parse(result.files[0].after).dimensions), ['id']);
  assert.equal(result.files.some(file => file.after.includes('calculated')), false);
  const unknown = plan({ sourceFiles: {}, targetFiles: {}, localFiles: { 'local.query.view': 'sql: SELECT id FROM example_records\n' }, topicNames: [], fieldRefs: ['local.id'] });
  assert.ok(unknown.issues.some(issue => issue.code === 'LOCAL_FIELD_UNVERIFIED'));
  assert.deepEqual(unknown.files, []);
});

test('partial workbook overrides preserve local provenance and never replace the shared formula', () => {
  const shared = view({ id: field(), total: field(ref('records.id') + ' + 1') });
  const result = plan({ sourceFiles: { 'records.view': shared }, targetFiles: {}, localFiles: { 'records.view': stringify({ dimensions: { total: { label: 'Workbook-only label' } } }) }, topicNames: [], fieldRefs: ['records.total'] });
  assert.deepEqual(result.issues, []);
  assert.equal(result.files[0].after, shared);
  assert.equal(result.files[0].after.includes('Workbook-only label'), false);
});

test('source field closure is recursive and scoped; unknown, cyclic, or unsupported source evidence blocks', () => {
  const source = view({ id: field(), total: field(ref('records.id') + ' + 1'), unrelated: field('not_selected') });
  const result = plan({ sourceFiles: { 'records.view': source }, targetFiles: {}, topicNames: [], fieldRefs: ['records.total'] });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(Object.keys(parse(result.files[0].after).dimensions), ['id', 'total']);
  for (const text of [view({ id: field(ref('records.missing')) }), view({ id: field(ref('records.id')) }), 'dimensions: [\n', 'dimensions: &fields {id: {sql: id}}\n']) {
    const failed = plan({ sourceFiles: { 'records.view': text }, targetFiles: {}, topicNames: [], fieldRefs: ['records.id'] });
    assert.ok(failed.issues.length);
    assert.ok(failed.files.every(file => file.action === 'conflict' || file.action === 'reuse'));
  }
});

test('required grants and model filter fields are verified without changing unrelated destination policy', () => {
  const grant = { user_attribute: 'example_region', allowed_values: ['example_value'] };
  const sourceModel = stringify({ access_grants: { selected: grant, unrelated: { user_attribute: 'unused' } }, default_topic_access_filters: [{ field: 'records.region', user_attribute: 'example_region' }] });
  const targetModel = stringify({ access_grants: { selected: grant, native_only: { user_attribute: 'native' } }, default_topic_access_filters: [{ field: 'records.region', user_attribute: 'example_region' }] });
  const sourceFiles = { model: sourceModel, 'records.view': view({ id: { sql: ref('TABLE') + '.id', required_access_grants: ['selected'] }, region: field(ref('TABLE') + '.region') }) };
  const result = plan({ sourceFiles, targetFiles: { model: targetModel }, topicNames: [], fieldRefs: ['records.id'] });
  assert.deepEqual(result.issues, []);
  const model = result.files.find(file => file.fileName === 'model')!;
  assert.equal(model.action, 'reuse');
  assert.equal(model.after, targetModel);
  assert.deepEqual(Object.keys(parse(result.files.find(file => file.fileName === 'records.view')!.after).dimensions).sort(), ['id', 'region']);
  const blocked = plan({ sourceFiles, targetFiles: { model: '{}\n' }, topicNames: [], fieldRefs: ['records.id'] });
  assert.ok(blocked.issues.some(issue => issue.code === 'SECURITY_REQUIREMENT_CONFLICT'));
  assert.ok(blocked.issues.some(issue => issue.code === 'MODEL_REQUIREMENT_CONFLICT'));
  assert.equal(blocked.files.find(file => file.fileName === 'model')!.after, '{}\n');
  assert.ok(blocked.files.every(file => file.action === 'conflict'));
});

test('multiple field-only views need an explicit topic join context instead of a guessed path', () => {
  const result = plan({ sourceFiles: { 'records.view': view({ id: field() }), 'regions.view': view({ id: field() }), relationships: '- join_from_view: records\n  join_to_view: regions\n  on_sql: 1=1\n' },
    targetFiles: {}, topicNames: [], fieldRefs: ['records.id', 'regions.id'] });
  assert.ok(result.issues.some(issue => issue.code === 'TOPIC_CONTEXT_REQUIRED'));
  assert.equal(result.files.some(file => file.fileName === 'relationships'), false);
  assert.ok(result.files.every(file => file.action === 'conflict'));
  const outside = plan({ sourceFiles: { 'summary.topic': 'base_view: records\njoins: {}\n', 'records.view': view({ id: field() }), 'regions.view': view({ id: field() }) },
    targetFiles: {}, topicNames: ['summary'], fieldRefs: ['regions.id'] });
  assert.ok(outside.issues.some(issue => issue.code === 'TOPIC_CONTEXT_REQUIRED' && issue.reference === 'regions.view'));
  assert.ok(outside.files.every(file => file.action === 'conflict'));
  assert.deepEqual(plan({ sourceFiles: { model: 'unsupported: value\n' }, targetFiles: {}, topicNames: [] }), { files: [], issues: [] });
});

function bindingFixture() {
  const source = stringify({ catalog: 'SOURCE_EXAMPLE', schema: 'RAW', table_name: 'example_records', dimensions: { id: field() } });
  const before = '# retain destination comment\r\ncatalog: "TARGET_EXAMPLE"\r\nschema: "CURATED"\r\ntable_name: "example_records"\r\ndimensions:\r\n  id:\r\n    sql: ${TABLE}.id\r\n  native_only:\r\n    sql: native_expression\r\n';
  return { sourceFiles: { 'source/records.view': source }, targetFiles: { 'target/records.view': before }, topicNames: [], fieldRefs: ['records.id'] };
}

test('physical binding suggestions require consent and never change destination metadata', () => {
  const input = bindingFixture(), result = plan(input);
  assert.deepEqual(result.bindingMappings, [{ sourceFileName: 'source/records.view', targetFileName: 'target/records.view',
    source: { catalog: 'SOURCE_EXAMPLE', schema: 'RAW' }, destination: { catalog: 'TARGET_EXAMPLE', schema: 'CURATED' } }]);
  assert.equal(result.files[0].action, 'conflict');
  assert.equal(result.files[0].after, input.targetFiles['target/records.view']);
  assert.equal(result.files[0].sourceComparison, input.sourceFiles['source/records.view']);
  assert.ok(result.issues.some(issue => issue.code === 'DESTINATION_DEFINITION_CONFLICT'));
});

test('physical binding consent reuses exact destination bytes or adds only complete missing fields', () => {
  const input = bindingFixture(), bindingMappings = plan(input).bindingMappings!;
  const reuse = plan({ ...input, bindingMappings });
  assert.deepEqual(reuse.issues, []);
  assert.equal(reuse.files[0].action, 'reuse');
  assert.equal(reuse.files[0].after, input.targetFiles['target/records.view']);
  assert.deepEqual(reuse.bindingMappings, bindingMappings);
  const source = parse(input.sourceFiles['source/records.view']);
  source.dimensions.total = field('${records.id} + 1');
  input.sourceFiles['source/records.view'] = stringify(source);
  input.fieldRefs = ['records.total'];
  const add = plan({ ...input, bindingMappings });
  assert.deepEqual(add.issues, []);
  assert.equal(add.files[0].action, 'add');
  const after = parse(add.files[0].after), before = parse(input.targetFiles['target/records.view']);
  assert.equal(after.catalog, before.catalog); assert.equal(after.schema, before.schema);
  assert.equal(after.table_name, before.table_name);
  assert.deepEqual(after.dimensions.id, before.dimensions.id);
  assert.deepEqual(after.dimensions.native_only, before.dimensions.native_only);
  assert.deepEqual(after.dimensions.total, source.dimensions.total);
  assert.match(add.files[0].after, /^# retain destination comment\r\n/);
});

test('physical binding consent cannot mask formula or field security conflicts', () => {
  for (const changed of [field('different_formula'), { ...field(), required_access_grants: ['restricted'] }]) {
    const input = bindingFixture(), bindingMappings = plan(input).bindingMappings!;
    const source = parse(input.sourceFiles['source/records.view']); source.dimensions.id = changed;
    input.sourceFiles['source/records.view'] = stringify(source);
    const failed = plan({ ...input, bindingMappings });
    assert.equal(failed.files.find(file => file.sourceFileName === 'source/records.view')!.action, 'conflict');
    assert.equal(failed.files.find(file => file.sourceFileName === 'source/records.view')!.after, input.targetFiles['target/records.view']);
    assert.equal(failed.bindingMappings?.length || 0, 0);
    assert.ok(failed.issues.some(issue => issue.code === 'DESTINATION_DEFINITION_CONFLICT' && issue.message.includes('["dimensions"]')));
  }
});

test('physical binding mappings fail closed for malformed query ambiguous and stale evidence', () => {
  const initial = bindingFixture(), approved = plan(initial).bindingMappings!;
  for (const change of [
    (input: ReturnType<typeof bindingFixture>) => { input.sourceFiles['source/records.view'] = 'dimensions: [\n'; },
    (input: ReturnType<typeof bindingFixture>) => { input.sourceFiles['source/records.view'] += 'sql: SELECT id FROM example_records\n'; },
    (input: ReturnType<typeof bindingFixture>) => { input.targetFiles['target/records.view'] += 'sql_table_name: example_records\n'; },
    (input: ReturnType<typeof bindingFixture>) => { input.targetFiles['target/records.view'] = input.targetFiles['target/records.view'].replace('"example_records"', '"other_records"'); },
    (input: ReturnType<typeof bindingFixture>) => { Object.assign(input.targetFiles, { 'other/records.view': input.targetFiles['target/records.view'] }); },
    (input: ReturnType<typeof bindingFixture>) => { input.sourceFiles['source/records.view'] += 'database: CONFLICTING_EXAMPLE\n'; },
  ]) {
    const input = bindingFixture(); change(input);
    const failed = plan({ ...input, bindingMappings: approved });
    assert.ok(failed.issues.length);
    assert.equal(failed.bindingMappings?.length || 0, 0);
    assert.ok(failed.files.every(file => file.action === 'conflict' || file.action === 'reuse'));
  }
  for (const stale of [
    { ...approved[0], destination: { ...approved[0].destination, schema: 'OLD_SCHEMA' } },
    { ...approved[0], source: { ...approved[0].source, catalog: 'OLD_CATALOG' } },
    { ...approved[0], targetFileName: 'other/records.view' },
  ]) {
    const failed = plan({ ...initial, bindingMappings: [stale] });
    assert.ok(failed.issues.some(issue => issue.code === 'PHYSICAL_BINDING_MAPPING_STALE'));
    assert.equal(failed.files[0].after, initial.targetFiles['target/records.view']);
    assert.deepEqual(failed.bindingMappings, approved, 'fresh exact evidence remains available for a new explicit choice');
  }
});

test('physical binding shape and canonical identity reject unknown keys duplicates and unsafe namespaces', () => {
  const input = bindingFixture(), mapping = plan(input).bindingMappings![0];
  assert.equal(isDashboardPackageBindingMapping(mapping), true);
  assert.equal(dashboardPackageBindingKey(mapping), dashboardPackageBindingKey({ ...mapping,
    source: { schema: mapping.source.schema, catalog: mapping.source.catalog },
    destination: { schema: mapping.destination.schema, catalog: mapping.destination.catalog } }));
  for (const invalid of [
    { ...mapping, unexpected: true }, { ...mapping, destination: { ...mapping.destination, table_name: 'other' } },
    { ...mapping, source: { catalog: 'SOURCE_EXAMPLE', database: 'OTHER' } },
    { ...mapping, destination: { schema: '${dynamic}' } }, { ...mapping, sourceFileName: '../records.view' },
    { ...mapping, sourceFileName: 'source/records.query.view' }, { ...mapping, source: { schema: null } },
  ]) assert.equal(isDashboardPackageBindingMapping(invalid), false);
  assert.ok(plan({ ...input, bindingMappings: [mapping, mapping] }).issues.some(issue => issue.code === 'PHYSICAL_BINDING_MAPPING_INVALID'));
});

test('physical binding approval never rewrites workbook-local definitions or unrelated views', () => {
  const input = bindingFixture(), bindingMappings = plan(input).bindingMappings!;
  const localFiles = { 'local/records.view': stringify({ dimensions: { calculated: field('${records.id} + 2') } }) };
  const before = structuredClone({ ...input, localFiles });
  const result = plan({ ...input, localFiles, fieldRefs: ['records.calculated'], bindingMappings });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.files.map(file => file.fileName), ['target/records.view']);
  assert.equal(result.files[0].after, input.targetFiles['target/records.view']);
  assert.deepEqual({ ...input, localFiles }, before);
  const unrelated = { ...bindingMappings[0], sourceFileName: 'source/unrelated.view', targetFileName: 'target/unrelated.view' };
  const held = plan({ ...input, bindingMappings: [unrelated] });
  assert.equal(held.files[0].action, 'conflict', 'a different view approval cannot authorize this comparison');
});
