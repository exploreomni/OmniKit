import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { OmniClient } from '../server/services/omniClient';
import { compareTopicMigrationBranch } from '../server/services/topicMigrationVerification';
import type { TopicMigrationRequest } from '../shared/topicMigration';
import { buildTopicMigrationAnalysis, inventoryMigrationTopics, topicMigrationSnapshotHash } from '../server/services/topicMigrationPlanner';

// Fictional authored definitions prove preservation, not customer or warehouse acceptance.
const ref = (name: string) => '$' + '{' + name + '}';
const request: TopicMigrationRequest = {
  sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model',
  targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model',
  topicIds: ['example.topic'], schemaMapText: '',
};
const view = (table: string, dimensions: Record<string, unknown> = { id: { sql: '"ID"' } }) => stringify({
  catalog: 'SOURCE', schema: 'PUBLIC', table_name: table, dimensions,
});
const baseSource = () => ({
  model: '{}\n', 'example.topic': '# topic note\nbase_view: records\njoins: {}\n',
  'records.view': '# view note\n' + view('records'),
});
const analyze = (patch: Partial<Parameters<typeof buildTopicMigrationAnalysis>[0]> = {}) => buildTopicMigrationAnalysis({
  request, sourceFiles: baseSource(), targetFiles: { model: '{}\n' }, sourceDialect: 'snowflake', targetDialect: 'databricks', ...patch,
});
const blockers = (plan: ReturnType<typeof analyze>) => plan.issues.filter((issue) => issue.severity === 'blocker');
const titles = (plan: ReturnType<typeof analyze>) => plan.issues.map((issue) => issue.title).join('\n');

test('grouped topic keeps the export path on review and readback while writing the basename with group_label', async () => {
  const file = 'Example Domain/example.topic';
  const { 'example.topic': topic, ...otherFiles } = baseSource();
  const selected = { ...request, topicIds: [file] };
  const baseline = { ...otherFiles };
  const plan = analyze({ sourceFiles: { ...otherFiles, [file]: topic }, targetFiles: baseline, request: selected });
  assert.deepEqual(blockers(plan), []);
  const approved = plan.files.find(item => item.sourceFileName === file)!;
  assert.equal(approved.status, 'create');
  assert.equal(approved.writeFileName, 'example.topic');
  assert.equal(parse(approved.proposed).group_label, 'Example Domain');

  const branch: Record<string, string> = { ...baseline };
  let writes = 0;
  const client = new OmniClient({ baseUrl: 'https://93.184.216.34', label: 'Example destination', apiKey: 'fictional-group-test' }, {
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/v1/models/target/yaml');
      if (init?.method === 'GET') {
        const pattern = new RegExp(url.searchParams.get('fileName')!);
        const files = Object.fromEntries(Object.entries(branch).filter(([key]) => pattern.test(key)));
        return Response.json({ files, checksums: {} });
      }
      const body = JSON.parse(String(init?.body));
      assert.equal(body.fileName, 'example.topic');
      assert.equal(body.previousChecksum, undefined);
      branch[parse(body.yaml).group_label + '/' + body.fileName] = body.yaml;
      writes++;
      return Response.json({ success: true, fileName: body.fileName });
    },
  });
  const submit = () => client.updateModelYamlFiles({ modelId: 'target', branchId: 'branch', reviewedDestinationFiles: baseline,
    files: [{ fileName: approved.fileName, yaml: approved.proposed, previousChecksum: approved.previousChecksum }] });
  await submit();
  const compare = () => compareTopicMigrationBranch({ files: plan.files, schemaMapText: '', baseline, actual: branch });
  assert.equal(compare().verified, true);
  assert.equal(compare().files.find(item => item.sourceFileName === file)?.submittedFileName, 'example.topic');
  delete branch[file];
  branch['Another Group/EXAMPLE.topic'] = topic;
  await assert.rejects(submit(), /same topic name/);
  assert.equal(writes, 1);
  assert.equal(compare().verified, false);
});

test('grouped topic review rejects duplicate semantic identities and contradictory grouping', () => {
  const file = 'Example Domain/example.topic';
  const { 'example.topic': topic, ...otherFiles } = baseSource();
  const selected = { ...request, topicIds: [file] };
  const source = { ...otherFiles, [file]: topic };
  const conflicts = [
    analyze({ request: selected, sourceFiles: { ...source, 'Elsewhere/example.topic': topic } }),
    analyze({ request: selected, sourceFiles: source, targetFiles: { 'example.topic': topic } }),
    analyze({ request: selected, sourceFiles: { ...source, [file]: topic + 'group_label: Another Group\n' } }),
  ];
  for (const plan of conflicts) {
    assert.ok(blockers(plan).some(issue => /same topic name|group_label disagree/.test(issue.message)));
    assert.equal(plan.files.find(item => item.kind === 'topic')?.status, 'blocked');
  }
});

test('destination preservation keeps complete destination definitions and adds complete missing source dependency fields', () => {
  const source = baseSource();
  source['records.view'] = view('SOURCE_TABLE', { id: { sql: '"ID"', label: 'Source id', filters: { state: 'source' } },
    extra: { sql: '${records.id} + 1', label: 'Complete source field', filters: { state: 'new' } } });
  source['records.view'] += 'default_filters:\n  id: 1\n';
  const target = '# keep this destination comment\n' + stringify({ catalog: 'DEST', schema: 'CURATED', table_name: 'target_records',
    filters: { state: 'destination' }, dimensions: { id: { sql: '`id`', label: 'Destination id', filters: { state: 'kept' } },
      destination_only: { sql: 'native_value' } } });
  const input = { sourceFiles: source, targetFiles: { model: '{}\n', 'records.view': target }, targetChecksums: { 'records.view': 'exact-checksum' } };
  const initial = analyze(input), candidate = initial.files.find(file => file.sourceFileName === 'records.view')!;
  assert.equal(candidate.status, 'blocked'); assert.ok(candidate.preservationOption);
  const plan = analyze({ ...input, request: { ...request, keepDestinationDefinitions: { 'records.view': candidate.preservationOption! } } });
  assert.deepEqual(blockers(plan), []);
  const preserved = plan.files.find(file => file.sourceFileName === 'records.view')!;
  const value = parse(preserved.proposed), before = parse(target);
  for (const key of ['catalog', 'schema', 'table_name', 'filters']) assert.deepEqual(value[key], before[key]);
  assert.deepEqual(value.dimensions.id, before.dimensions.id); assert.deepEqual(value.dimensions.destination_only, before.dimensions.destination_only);
  assert.deepEqual(value.dimensions.extra, parse(source['records.view']).dimensions.extra);
  assert.ok(preserved.proposed.includes('# keep this destination comment'));
  assert.deepEqual(preserved.destinationPreservation?.addedPaths, ['dimensions.extra']);
  assert.ok(preserved.destinationPreservation?.keptPaths.includes('dimensions.id'));
  assert.deepEqual(preserved.destinationPreservation?.omittedSourcePaths, ['default_filters']);
  assert.equal(value.default_filters, undefined);
  assert.equal(preserved.previousChecksum, 'exact-checksum');
  assert.ok(plan.dependencies.some(dependency => dependency.fileName === 'records.view' && dependency.reasons.some(reason => reason.includes('id'))));
});

test('destination preservation rejects stale unknown and path-forged choices without changing old default conflict behavior', () => {
  const source = baseSource(), targetFiles = { model: '{}\n', 'records.view': view('different') };
  const input = { sourceFiles: source, targetFiles, targetChecksums: { 'records.view': 'sum' } };
  const option = analyze(input).files.find(file => file.kind === 'view')!.preservationOption!;
  assert.ok(option); assert.equal(option.sourceHash, topicMigrationSnapshotHash(source)); assert.equal(option.targetHash, topicMigrationSnapshotHash(targetFiles));
  for (const choices of [ { 'records.view': { ...option, sourceHash: 'sha256:' + '0'.repeat(64) } },
    { 'unselected.view': option }, { 'records.view': { ...option, destinationFileName: 'other.view' } },
    { 'records.view': { ...option, unsupported: true } } ]) {
    const plan = analyze({ ...input, request: { ...request, keepDestinationDefinitions: choices } }); assert.ok(blockers(plan).length);
  }
  assert.ok(blockers(analyze(input)).length);
});

test('destination preservation never offers security policy query-view or semantic collision overrides', () => {
  const source = baseSource(); source['records.view'] = view('records', { id: { sql: '"ID"', mask_unless_access_grants: [] } });
  for (const target of [view('different'), view('different', { ID: { sql: '"ID"' } }),
    'sql: SELECT 1\ndimensions:\n  id:\n    sql: id\n']) {
    const plan = analyze({ sourceFiles: source, targetFiles: { model: '{}\n', 'records.view': target }, targetChecksums: { 'records.view': 'sum' } });
    assert.ok(blockers(plan).length); assert.equal(plan.files.find(file => file.kind === 'view')?.preservationOption, undefined);
  }
});

test('sql dialect planning proposes only reviewed column conversions and preserves complex SQL', () => {
  const source = { ...baseSource(), 'records.view': view('records', { id: { sql: '"ID"' }, total: { sql: 'SUM("AMOUNT")' } }) };
  const input = { sourceFiles: source, enableSqlDialectReview: true,
    targetTableNames: [{ namespace: 'SOURCE.PUBLIC', status: 'available' as const, tableNames: ['records'], columnsByTable: [{ tableName: 'records', columns: ['ID', 'AMOUNT'] }] }] };
  const plan = analyze(input), file = plan.files.find(file => file.kind === 'view')!;
  assert.deepEqual(blockers(plan), []);
  assert.equal(parse(file.proposed).dimensions.id.sql, '`ID`');
  assert.equal(parse(file.proposed).dimensions.total.sql, 'SUM("AMOUNT")');
  assert.equal(file.sqlDialectReview?.corrections.length, 1);
  assert.ok(file.sqlDialectReview?.findings.some(item => item.path.includes('total')));
  assert.deepEqual(plan.sqlDialectPolicy, { version: 'column_identifiers_v1', sourceDialect: 'snowflake', targetDialect: 'databricks' });
  const legacy = analyze({ ...input, enableSqlDialectReview: false });
  assert.equal(parse(legacy.files.find(file => file.kind === 'view')!.proposed).dimensions.id.sql, '"ID"');
  assert.equal(legacy.sqlDialectPolicy, undefined);
});

test('sql dialect planning never replaces an existing destination SQL definition', () => {
  const source = baseSource();
  const plan = analyze({ sourceFiles: source, targetFiles: { model: '{}\n', 'records.view': source['records.view'] },
    targetChecksums: { 'records.view': 'fictional-checksum' }, enableSqlDialectReview: true,
    targetTableNames: [{ namespace: 'SOURCE.PUBLIC', status: 'available', tableNames: ['records'], columnsByTable: [{ tableName: 'records', columns: ['ID'] }] }] });
  assert.ok(blockers(plan).length > 0);
  assert.equal(plan.files.find(file => file.kind === 'view')?.status, 'blocked');
});

test('table-name reconciliation is reviewed after namespace mapping and preserves existing definitions', () => {
  const source = { ...baseSource(), 'records.view': view('RECORDS') };
  const input = { sourceFiles: source, request: { ...request, schemaMapText: 'SOURCE.PUBLIC -> example.data' },
    targetTableNames: [{ namespace: 'example.data', status: 'available' as const, tableNames: ['records'] }] };
  const plan = analyze(input);
  assert.deepEqual(blockers(plan), []);
  const file = plan.files.find(file => file.kind === 'view')!;
  assert.equal(parse(file.proposed).table_name, 'records');
  assert.deepEqual(file.tableNameCorrection, { namespace: 'example.data', from: 'RECORDS', to: 'records' });
  assert.equal(parse(file.proposed).dimensions.id.sql, parse(source['records.view']).dimensions.id.sql);
  const target = 'catalog: example\nschema: data\ntable_name: RECORDS\ndimensions: {}\n';
  const conflict = analyze({ ...input, targetFiles: { model: '{}\n', [file.fileName]: target }, targetChecksums: { [file.fileName]: 'checksum' } });
  assert.ok(blockers(conflict).length > 0, 'Automatic spelling must not overwrite an existing authored destination table binding.');
});

test('table-name reconciliation does not guess missing or ambiguous identities', () => {
  for (const tableNames of [[], ['unrelated'], ['records', 'RECORDS']]) {
    const plan = analyze({ sourceFiles: { ...baseSource(), 'records.view': view('RECORDS') },
      targetTableNames: [{ namespace: 'SOURCE.PUBLIC', status: 'available', tableNames }] });
    assert.deepEqual(blockers(plan), []);
    const file = plan.files.find(file => file.kind === 'view')!;
    assert.equal(parse(file.proposed).table_name, 'RECORDS'); assert.equal(file.tableNameCorrection, undefined);
    assert.ok(plan.issues.some(issue => /Destination table name was not matched|Ambiguous destination table spelling/.test(issue.title)));
  }
});

test('branch review preserves authored bytes with SQL and physical uncertainty as warnings', () => {
  const source = baseSource(), snapshot = JSON.stringify(source);
  const plan = analyze({ sourceFiles: source, sourceDialect: '', targetDialect: '' });
  assert.deepEqual(blockers(plan), []);
  assert.deepEqual(plan.files.map((file) => [file.fileName, file.status]), [['example.topic', 'create'], ['records.view', 'create']]);
  for (const file of plan.files) assert.equal(file.proposed, source[file.sourceFileName as keyof typeof source]);
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(plan.physical, undefined);
  assert.ok(plan.files.every((file) => file.sqlReviewDraft === undefined));
  assert.ok(plan.issues.every((issue) => issue.severity === 'review'));
  assert.match(titles(plan), /Authored SQL requires native review/);
  assert.match(titles(plan), /Warehouse bindings are unvalidated/);
  assert.equal(inventoryMigrationTopics({ 'invalid.topic': 'base_view: [invalid]\n' })[0].unavailableReason, 'An explicit base_view is required.');
});

test('branch review closes nested role aliases and shared formulas but scopes relationship edges', () => {
  const edge = (from: string, to: string, alias?: string) => ({
    join_from_view: from, join_to_view: to, ...(alias ? { join_to_view_as: alias, join_to_view_as_label: alias + ' label' } : {}),
    on_sql: ref(from + '.id') + ' = ' + ref((alias || to) + '.id'), relationship_type: 'many_to_one', join_type: 'always_left',
  });
  const owners = parse(view('owners')); owners.measures = { total: { sql: ref('owners.id'), aggregate_type: 'count' } };
  const topicFile = 'Example Domain/example.topic', recordsFile = 'SOURCE.PUBLIC/records.view';
  const relationships = [edge('records', 'details'), edge('records', 'owners', 'primary_owner'), edge('records', 'owners', 'secondary_owner'),
    edge('details', 'owners', 'first_owner'), edge('details', 'owners', 'second_owner'), edge('unrelated', 'other')];
  const source = {
    model: '{}\n', [topicFile]: stringify({ base_view: 'records', joins: { details: { first_owner: {}, second_owner: {} }, primary_owner: {}, secondary_owner: {} } }),
    [recordsFile]: view('records'), 'SOURCE.PUBLIC/details.view': view('details'), 'SOURCE.PUBLIC/owners.view': stringify(owners),
    'unrelated.view': view('unrelated'), relationships: '# relationship note\n' + stringify(relationships),
  };
  const selected = { ...request, topicIds: [topicFile] };
  const plan = analyze({ sourceFiles: source, request: selected });
  assert.deepEqual(blockers(plan), []);
  assert.deepEqual(plan.dependencies.map((file) => file.fileName).sort(), [topicFile, recordsFile, 'SOURCE.PUBLIC/details.view', 'SOURCE.PUBLIC/owners.view', 'relationships'].sort());
  assert.deepEqual(parse(plan.files.find((file) => file.fileName === 'relationships')!.proposed), relationships.slice(0, 5));
  assert.equal(plan.files.find((file) => file.fileName === 'SOURCE.PUBLIC/owners.view')!.proposed, source['SOURCE.PUBLIC/owners.view']);
  const topic = parse(source[topicFile]); topic.always_where_sql = ref('owners.id') + ' > 0';
  assert.match(titles(analyze({ sourceFiles: { ...source, [topicFile]: stringify(topic) }, request: selected })), /Field dependency unresolved: owners.id/);
  const duplicate = { ...source, relationships: stringify([...relationships, { ...relationships[1], on_sql: '1=1' }]) };
  assert.match(titles(analyze({ sourceFiles: duplicate, request: selected })), /Join definition unresolved/);
});

test('branch review additive scoped fields preserve destination-only bytes and source formulas', () => {
  const source = { ...baseSource(), 'example.topic': stringify({ base_view: 'records', joins: {}, fields: ['records.calculated'] }),
    'records.view': '# source comment\n' + view('records', { id: { sql: '"ID"' }, calculated: { sql: 'IFF(' + ref('records.id') + ' > 0, 1, 0)' }, unused: {} }) };
  const target = '# destination note\n' + view('records', { id: { sql: '"ID"' }, destination_only: { sql: '"OTHER"' } });
  const settings = { sourceFiles: source, targetFiles: { model: '{}\n', 'records.view': target } };
  const plan = analyze({ ...settings, targetChecksums: { 'records.view': 'checksum' } });
  assert.deepEqual(blockers(plan), []);
  const file = plan.files.find((row) => row.fileName === 'records.view')!;
  assert.equal(file.status, 'add'); assert.equal(file.previousChecksum, 'checksum'); assert.ok(file.proposed.startsWith('# destination note'));
  const output = parse(file.proposed);
  assert.deepEqual(Object.keys(output.dimensions).sort(), ['calculated', 'destination_only', 'id']);
  assert.equal(output.dimensions.calculated.sql, parse(source['records.view']).dimensions.calculated.sql);
  assert.equal(output.dimensions.destination_only.sql, '"OTHER"');
  assert.match(titles(analyze(settings)), /Destination checksum unavailable/);
  const local = { ...source, 'example.topic': stringify({ base_view: 'records', joins: {}, fields: ['records.calculated'], views: { records: { dimensions: { calculated: { sql: '1' } } } } }) };
  const localPlan = analyze({ sourceFiles: local });
  assert.deepEqual(blockers(localPlan), []);
  assert.deepEqual(Object.keys(parse(localPlan.files.find((row) => row.fileName === 'records.view')!.proposed).dimensions).sort(), ['calculated', 'id']);
  assert.equal(localPlan.files.find((row) => row.fileName === 'example.topic')!.proposed, local['example.topic']);
});

test('branch review rejects deprecated correction inputs and permits explicit namespace substitution only', () => {
  for (const key of ['fileMappings', 'reviewedSqlFiles', 'tableMappings']) {
    const plan = analyze({ request: { ...request, [key]: {} } });
    assert.match(titles(plan), new RegExp('Unsupported branch-review input: ' + key));
    assert.equal(plan.files.length, 0);
  }
  const source = { ...baseSource(), 'records.view': '# comment SOURCE.PUBLIC\n' + view('records', {
    id: { sql: '"ID"', label: 'SOURCE.PUBLIC' },
    formula: { sql: 'IFF(' + ref('records.id') + ' > 0, 1, 0)' }, literal: { sql: "'SOURCE.PUBLIC.rows'" },
  }) };
  const plan = analyze({ sourceFiles: source, request: { ...request, schemaMapText: 'SOURCE.PUBLIC -> target.public' } });
  assert.deepEqual(blockers(plan), []);
  const file = plan.files.find((row) => row.fileName === 'records.view')!, output = parse(file.proposed);
  assert.equal(output.catalog, 'target'); assert.equal(output.schema, 'public');
  assert.equal(output.dimensions.id.sql, '"ID"'); assert.equal(output.dimensions.id.label, 'SOURCE.PUBLIC');
  assert.equal(output.dimensions.literal.sql, "'SOURCE.PUBLIC.rows'");
  assert.equal(output.dimensions.formula.sql, 'IFF(' + ref('records.id') + ' > 0, 1, 0)');
  assert.ok(file.proposed.startsWith('# comment SOURCE.PUBLIC'));
  assert.match(titles(plan), /Explicit namespace substitutions need review/);
  assert.match(titles(analyze({ request: { ...request, schemaMapText: 'SOURCE.PUBLIC -> target.public\nSOURCE.PUBLIC -> other.public' } })), /Ambiguous data-location mapping/);
});

test('branch review preserves authored query views without generated dependencies or SQL rewrites', () => {
  const query = '# exact authored query\n' + stringify({ sql: 'SELECT ID FROM SOURCE.PUBLIC.rows\nWHERE ID > 0\n', dimensions: { id: { sql: '"ID"' } } });
  const source = { model: '{}\n', 'example.topic': 'base_view: records\njoins: {}\n', 'records.query.view': query };
  const plan = analyze({ sourceFiles: source });
  assert.deepEqual(blockers(plan), []);
  assert.equal(plan.files.find((file) => file.fileName === 'records.query.view')!.proposed, query);
  assert.deepEqual(plan.dependencies.map((file) => file.fileName), ['example.topic', 'records.query.view']);
  assert.match(titles(plan), /Authored query view is unvalidated/);
  const templated = analyze({ sourceFiles: { ...source, 'records.query.view': stringify({ sql: 'SELECT {{ user_attributes.region }} FROM SOURCE.PUBLIC.rows', dimensions: { id: { sql: '"ID"' } } }) } });
  assert.deepEqual(blockers(templated), []);
  assert.match(titles(templated), /Dynamic expression requires native review/);
});

test('branch review submits mapped namespace paths and binds the actual destination checksum', () => {
  const source = { model: '{}\n', 'example.topic': 'base_view: records\njoins: {}\n',
    'SOURCE.PUBLIC/records.view': view('records', { id: { sql: '"ID"' }, added: { sql: '"ADDED"' } }) };
  const mappedRequest = { ...request, schemaMapText: 'SOURCE.PUBLIC -> target.public' };
  const plan = analyze({ sourceFiles: source, request: mappedRequest });
  assert.deepEqual(blockers(plan), []);
  const file = plan.files.find(file => file.kind === 'view')!;
  assert.equal(file.sourceFileName, 'SOURCE.PUBLIC/records.view');
  assert.equal(file.fileName, 'target.public/records.view'); assert.equal(file.destinationFileName, file.fileName);
  const target = '# keep destination note\n' + view('records', { id: { sql: '"ID"' }, destination_only: { sql: '"OTHER"' } }).replace('catalog: SOURCE', 'catalog: target').replace('schema: PUBLIC', 'schema: public');
  const updated = analyze({ sourceFiles: source, request: mappedRequest, targetFiles: { model: '{}\n', [file.fileName]: target }, targetChecksums: { [file.fileName]: 'destination-checksum' } });
  assert.deepEqual(blockers(updated), []);
  const addition = updated.files.find(file => file.kind === 'view')!;
  assert.equal(addition.status, 'add'); assert.equal(addition.before, target); assert.equal(addition.previousChecksum, 'destination-checksum');
  assert.match(addition.proposed, /destination_only/); assert.match(addition.proposed, /keep destination note/);
  const oldPath = analyze({ sourceFiles: source, request: mappedRequest, targetFiles: { model: '{}\n', 'SOURCE.PUBLIC/records.view': source['SOURCE.PUBLIC/records.view'] } });
  assert.match(titles(oldPath), /Destination semantic identity exists at another path/);
  const mismatch = analyze({ sourceFiles: { ...source, 'SOURCE.PUBLIC/records.view': view('records').replace('catalog: SOURCE', 'catalog: OTHER') }, request: mappedRequest });
  assert.match(titles(mismatch), /Dependency cannot be merged safely/);
});

test('branch review preserves source security and blocks absent conflicting or overwritten grants and policies', () => {
  const grant = { user_attribute: 'role', allowed_values: ['reviewer'] };
  const source = { ...baseSource(), model: stringify({ access_grants: { selected_grant: grant, unrelated_grant: { user_attribute: 'unused', allowed_values: ['unused'] } } }),
    'example.topic': stringify({ base_view: 'records', joins: {}, required_access_grants: ['selected_grant'], access_filters: [{ field: 'records.id', user_attribute: 'row_id' }] }) };
  const targetModel = stringify({ access_grants: { selected_grant: grant, destination_only: { user_attribute: 'other', allowed_values: ['other'] } } });
  const plan = analyze({ sourceFiles: source, targetFiles: { model: targetModel } });
  assert.deepEqual(blockers(plan), []);
  assert.equal(plan.files.find((file) => file.fileName === 'example.topic')!.proposed, source['example.topic']);
  assert.ok(!plan.files.some((file) => file.kind === 'model'));
  assert.match(titles(plan), /effective-access review/);
  assert.match(titles(analyze({ sourceFiles: source })), /Required access grant not preserved/);
  assert.match(titles(analyze({ sourceFiles: { ...source, model: '{}\n' }, targetFiles: { model: targetModel } })), /Required access grant unavailable/);
  const conflict = stringify({ access_grants: { selected_grant: { ...grant, allowed_values: ['different'] } } });
  assert.match(titles(analyze({ sourceFiles: source, targetFiles: { model: conflict } })), /Required access grant not preserved/);
  assert.match(titles(analyze({ sourceFiles: source, targetFiles: { model: targetModel, 'example.topic': baseSource()['example.topic'] }, targetChecksums: { 'example.topic': 'checksum' } })), /Dependency cannot be merged safely/);
});

test('branch review holds security defaults and leaves differing nonsecurity model settings untouched', () => {
  const plan = analyze({ sourceFiles: { ...baseSource(), model: 'query_timezone: UTC\n' }, targetFiles: { model: 'query_timezone: America/Chicago\n' } });
  assert.deepEqual(blockers(plan), []);
  assert.match(titles(plan), /Model requirement differs: query_timezone/);
  assert.ok(!plan.files.some((file) => file.kind === 'model'));
  const security = analyze({ sourceFiles: { ...baseSource(), model: 'default_topic_access_filters:\n  - field: records.id\n    user_attribute: row_id\n' } });
  assert.ok(blockers(security).some((issue) => issue.title === 'Model requirement differs: default_topic_access_filters'));
});

test('branch review missing structural dependencies unsafe merges and exact identity collisions still block', () => {
  const cases: Array<[Partial<Parameters<typeof buildTopicMigrationAnalysis>[0]>, RegExp]> = [
    [{ sourceFiles: { ...baseSource(), 'records.view': view('records', { id: { sql: ref('records.other') }, other: { sql: ref('records.id') } }) } }, /Recursive field dependency cycle/],
    [{ sourceFiles: { ...baseSource(), 'records.view': view('records', { id: { sql: ref('missing.id') } }) } }, /Field dependency unresolved/],
    [{ sourceFiles: { ...baseSource(), 'records.view': 'dimensions: [\n' } }, /Source definition unavailable/],
    [{ sourceFiles: { ...baseSource(), 'folder/records.view': view('records') } }, /Exact view unresolved/],
    [{ sourceFiles: { ...baseSource(), 'example.topic': 'base_view: Records\njoins: {}\n' } }, /Exact view unresolved/],
    [{ targetFiles: { model: '{}\n', 'folder/records.view': view('records') } }, /Destination semantic identity exists at another path/],
    [{ targetFiles: { model: '{}\n', 'records.view': view('records', { id: { sql: '"DIFFERENT"' } }) }, targetChecksums: { 'records.view': 'checksum' } }, /Dependency cannot be merged safely/],
  ];
  for (const [settings, title] of cases) {
    const plan = analyze(settings);
    assert.match(titles(plan), title);
    assert.ok(blockers(plan).length);
  }
});

test('branch review isolates topic blockers reuses unchanged files and hashes full authored snapshots', () => {
  const source = { ...baseSource(), 'held.topic': 'base_view: missing\njoins: {}\n' };
  const plan = analyze({ sourceFiles: source, request: { ...request, topicIds: ['example.topic', 'held.topic'] } });
  assert.equal(plan.files.find((file) => file.fileName === 'example.topic')!.status, 'create');
  assert.ok(blockers(plan).every((issue) => !issue.topicIds.includes('example.topic')));
  assert.equal(topicMigrationSnapshotHash({ b: 'two', a: 'one' }), topicMigrationSnapshotHash({ a: 'one', b: 'two' }));
  const baseline = analyze(), changed = analyze({ targetFiles: { model: '{}\n', 'unrelated.view': 'dimensions: {}\n' } });
  assert.notEqual(baseline.targetHash, changed.targetHash); assert.equal(baseline.sourceHash, changed.sourceHash);
  const reuse = analyze({ targetFiles: baseSource() });
  assert.deepEqual(blockers(reuse), []);
  assert.ok(reuse.files.every((file) => file.status === 'reuse'));
});
