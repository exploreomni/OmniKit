import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import type { DashboardTopicRepairDraftInput } from '../shared/dashboardTopicRepair';
import { buildDashboardTopicRepairDraft } from '../server/services/dashboardTopicRepairDraft';

const view = (dimensions: Record<string, unknown>) => stringify({ dimensions });
const field = (name: string) => ({ sql: `\${TABLE}.${name}` });
const sourceFiles = { model: '{}\n', 'orders.view': view({ id: field('id'), customer_id: field('customer_id'), amount: field('amount') }) };
const state = (fields: string[], topicName = 'missing_topic') => ({ queryPresentations: { data: { '1': { topicName, query: { fields } } }, order: ['1'] } });
const input = (override: Partial<DashboardTopicRepairDraftInput> = {}): DashboardTopicRepairDraftInput => ({ sourceTopicName: 'missing_topic', targetTopicName: 'new_topic', states: [state(['orders.id'])], sourceFiles, targetFiles: { model: '{}\n' }, ...override });
const edge = (from: string, to: string) => ({ join_from_view: from, join_to_view: to, join_type: 'always_left', relationship_type: 'many_to_one', on_sql: `\${${from}.customer_id} = \${${to}.id}` });
const joinedFiles = { ...sourceFiles, 'customers.view': view({ id: field('id'), name: field('name'), customer_id: field('customer_id') }), relationships: stringify([edge('orders', 'customers')]) };

test('missing source topic creates a review draft from one exact authored view', () => {
  const original = input();
  const before = JSON.stringify(original);
  const draft = buildDashboardTopicRepairDraft(original);
  assert.deepEqual(draft.blockers, []);
  assert.equal(draft.baseView, 'orders');
  assert.deepEqual(draft.requiredViews, ['orders']);
  assert.deepEqual(parse(draft.files.find((file) => file.kind === 'topic')!.proposed), { base_view: 'orders' });
  assert.equal(draft.files.find((file) => file.kind === 'view')?.proposed, sourceFiles['orders.view']);
  assert.equal(JSON.stringify(original), before, 'the pure builder does not change source states or snapshots');
});

test('existing authored source topics route to ordinary copy, while labels are not source identity', () => {
  const existing = buildDashboardTopicRepairDraft(input({ sourceFiles: { ...sourceFiles, 'nested/missing_topic.topic': 'base_view: orders\n' } }));
  assert.ok(existing.blockers.some((message) => /ordinary topic-copy/.test(message)));
  assert.deepEqual(existing.files, []);
  const labelOnly = buildDashboardTopicRepairDraft(input({ sourceFiles: { ...sourceFiles, 'unrelated.topic': 'label: missing_topic\nbase_view: orders\n' } }));
  assert.deepEqual(labelOnly.blockers, []);
});

test('only queries tied to the exact source identity contribute views and filter dependencies', () => {
  const selected = state(['orders.id']);
  Object.assign(selected.queryPresentations.data['1'].query, { filters: { 'orders.amount': { kind: 'GREATER_THAN', values: [1] } } });
  const draft = buildDashboardTopicRepairDraft(input({ states: [selected, state(['unrelated.missing'], 'other_topic')] }));
  assert.deepEqual(draft.blockers, []);
  assert.deepEqual(draft.requiredViews, ['orders']);
  const topic = parse(draft.files.find((file) => file.kind === 'topic')!.proposed);
  assert.equal(topic.default_filters, undefined, 'query filters are not silently lifted into topic defaults');
  assert.ok(draft.files.find((file) => file.kind === 'topic')?.message?.includes('remain on the dashboard'));
  const noIdentity = buildDashboardTopicRepairDraft(input({ states: [{ query: { fields: ['orders.id'] } }] }));
  assert.ok(noIdentity.blockers.some((message) => /No selected dashboard query/.test(message)));
});

test('the unique directed base is selected and shared joins use a separate relationships diff', () => {
  const selected = [state(['orders.amount', 'customers.name'])];
  const missingBase = buildDashboardTopicRepairDraft(input({ states: selected, sourceFiles: joinedFiles }));
  assert.deepEqual(missingBase.baseViewCandidates, ['customers', 'orders']);
  assert.equal(missingBase.baseView, 'orders');
  assert.match(missingBase.baseViewReason || '', /only verified candidate/i);
  assert.deepEqual(missingBase.blockers, []);
  const draft = buildDashboardTopicRepairDraft(input({ states: selected, sourceFiles: joinedFiles, baseView: 'orders' }));
  assert.deepEqual(draft.blockers, []);
  const topic = parse(draft.files.find((file) => file.kind === 'topic')!.proposed);
  assert.deepEqual(topic.joins, { customers: {} });
  assert.equal(topic.relationships, undefined);
  assert.deepEqual(parse(draft.files.find((file) => file.fileName === 'relationships')!.proposed), [edge('orders', 'customers')]);
});

test('multiple viable directed bases retain an explicit choice and reversible does not infer reverse edges', () => {
  const states = [state(['orders.amount', 'customers.name'])];
  const ambiguous = buildDashboardTopicRepairDraft(input({ states, sourceFiles: { ...joinedFiles,
    relationships: stringify([edge('orders', 'customers'), edge('customers', 'orders')]),
  } }));
  assert.equal(ambiguous.baseView, undefined);
  assert.ok(ambiguous.blockers.some((message) => /Multiple base-view candidates/.test(message)));
  const reversible = buildDashboardTopicRepairDraft(input({ states, sourceFiles: { ...joinedFiles,
    relationships: stringify([{ ...edge('orders', 'customers'), reversible: true }]),
  } }));
  assert.equal(reversible.baseView, 'orders');
  assert.deepEqual(reversible.blockers, []);
});

test('global relationship additions preserve unrelated target edges and exact existing rows are no-ops', () => {
  const unrelated = edge('other_orders', 'other_customers');
  const selected = { ...edge('orders', 'customers'), reversible: false, where_sql: '${orders.amount} > 0', documentation: 'Example edge documentation', label: 'Example edge' };
  const states = [state(['orders.amount', 'customers.name'])];
  const original = '# unrelated destination comment\n' + stringify([unrelated]);
  const source = { ...joinedFiles, relationships: stringify([selected]) };
  const draft = buildDashboardTopicRepairDraft(input({ states, sourceFiles: source, targetFiles: { model: '{}\n', relationships: original } }));
  assert.deepEqual(draft.blockers, []);
  const file = draft.files.find((candidate) => candidate.kind === 'relationship')!;
  assert.equal(file.status, 'additive');
  assert.equal(file.original, original);
  assert.ok(file.proposed.includes('unrelated destination comment'));
  assert.deepEqual(parse(file.proposed), [unrelated, selected]);
  const noop = buildDashboardTopicRepairDraft(input({ states, sourceFiles: source, targetFiles: { model: '{}\n', relationships: file.proposed } }));
  assert.equal(noop.files.find((candidate) => candidate.kind === 'relationship')?.status, 'unchanged');
  assert.deepEqual(noop.blockers, []);
});

test('global relationship conflicts block and preserve unrelated destination rows in the review diff', () => {
  const unrelated = edge('other_orders', 'other_customers');
  const conflict = { ...edge('orders', 'customers'), on_sql: '${orders.id} = ${customers.id}' };
  const original = '# unrelated destination comment\n' + stringify([unrelated, conflict]);
  const draft = buildDashboardTopicRepairDraft(input({ states: [state(['orders.amount', 'customers.name'])], sourceFiles: joinedFiles, targetFiles: { model: '{}\n', relationships: original } }));
  const file = draft.files.find((candidate) => candidate.kind === 'relationship')!;
  assert.equal(file.status, 'conflict');
  assert.equal(file.original, original);
  assert.ok(file.proposed.includes('unrelated destination comment'));
  assert.deepEqual(parse(file.proposed), [unrelated, edge('orders', 'customers')]);
  assert.ok(draft.blockers.some((message) => /relationships conflict/.test(message)));
  assert.ok(draft.files.some((candidate) => candidate.kind === 'topic'), 'established base still yields a blocked topic preview');
});

test('blank, empty, unrelated, and semantically equivalent workbook relationships do not block', () => {
  for (const relationships of ['', ' \n', '[]\n', '{}\n', '# no local relationships\n', stringify([edge('orders', 'unrelated_view')]), '# equivalent authored edge\n' + stringify([edge('orders', 'customers')])]) {
    const selected = { ...state(['orders.amount', 'customers.name']), __topicRepairWorkbookFiles: { relationships } };
    const draft = buildDashboardTopicRepairDraft(input({ states: [selected], sourceFiles: joinedFiles }));
    assert.deepEqual(draft.blockers, [], relationships);
    assert.deepEqual(parse(draft.files.find((file) => file.kind === 'relationship')!.proposed), [edge('orders', 'customers')]);
  }
});

test('relevant differing or workbook-only edges block without promoting local relationship bytes', () => {
  for (const local of [{ ...edge('orders', 'customers'), on_sql: '${orders.id} = ${customers.customer_id}' }, edge('customers', 'orders')]) {
    const selected = { ...state(['orders.amount', 'customers.name']), __topicRepairWorkbookFiles: { relationships: stringify([local]) } };
    const draft = buildDashboardTopicRepairDraft(input({ states: [selected], sourceFiles: joinedFiles }));
    assert.ok(draft.blockers.some((message) => /Workbook-local relationship/.test(message)));
    assert.deepEqual(parse(draft.files.find((file) => file.kind === 'relationship')!.proposed), [edge('orders', 'customers')]);
  }
});

test('multiple directed paths and incomplete or assumed relationships stay blocked', () => {
  const selected = [state(['orders.amount', 'customers.name'])];
  const ambiguous = buildDashboardTopicRepairDraft(input({ states: selected, baseView: 'orders', sourceFiles: {
    ...joinedFiles, 'bridge.view': view({ id: field('id'), customer_id: field('customer_id') }),
    relationships: stringify([edge('orders', 'customers'), edge('orders', 'bridge'), edge('bridge', 'customers')]),
  } }));
  assert.ok(ambiguous.blockers.some((message) => /Multiple authored join paths/.test(message)));
  for (const override of [{ relationship_type: 'assumed_many_to_one' }, { join_to_view_as: 'customer_alias' }, { on_sql: '' }, { unknown_where: 'id > 0' }, { join_type: 'invented_type' }]) {
    const draft = buildDashboardTopicRepairDraft(input({ states: selected, baseView: 'orders', sourceFiles: { ...joinedFiles, relationships: stringify([{ ...edge('orders', 'customers'), ...override }]) } }));
    assert.ok(draft.blockers.some((message) => /incomplete, assumed, aliased, or unsupported/.test(message)));
  }
});

test('an explicit authored path resolves ambiguity and preserves the selected bridge and exact edge values', () => {
  const options = input({ states: [state(['orders.amount', 'customers.name'])], baseView: 'orders', sourceFiles: {
    ...joinedFiles, 'bridge.view': view({ id: field('id'), customer_id: field('customer_id') }),
    relationships: stringify([edge('orders', 'customers'), edge('orders', 'bridge'), edge('bridge', 'customers')]),
  } });
  const initial = buildDashboardTopicRepairDraft(options);
  const choice = initial.joinPathChoices!.find((row) => row.requiredView === 'customers')!;
  assert.equal(choice.complete, true);
  assert.equal(choice.paths.length, 2);
  assert.equal(choice.selectedPathId, undefined);
  const path = choice.paths.find((candidate) => candidate.views.includes('bridge'))!;
  assert.match(path.id, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parse(path.edges[0].authoredYaml), edge('orders', 'bridge'));
  const selected = { customers: path.id };
  const draft = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths: selected });
  assert.deepEqual(draft.blockers, []);
  assert.deepEqual(draft.selectedJoinPaths, selected);
  assert.equal(draft.joinPathChoices![0].selectedPathId, path.id);
  assert.deepEqual(parse(draft.files.find((file) => file.kind === 'topic')!.proposed).joins, { bridge: { customers: {} } });
  assert.deepEqual(parse(draft.files.find((file) => file.kind === 'relationship')!.proposed), [edge('orders', 'bridge'), edge('bridge', 'customers')]);
  assert(draft.files.some((file) => file.fileName === 'bridge.view'));
  const reordered = buildDashboardTopicRepairDraft({ ...options, sourceFiles: { ...options.sourceFiles,
    relationships: stringify([edge('bridge', 'customers'), edge('orders', 'bridge'), edge('orders', 'customers'), edge('orders', 'customers')]),
  } });
  assert.deepEqual(reordered.joinPathChoices![0].paths.map((row) => row.id).sort(), choice.paths.map((row) => row.id).sort(), 'row order and duplicate identical rows do not change authored path identities');
  const independentBlocker = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths: selected, targetFiles: { model: 'access_grants: {}\n' } });
  assert(independentBlocker.blockers.some((message) => /settings\/security differ/.test(message)), 'path approval cannot bypass an independent safety blocker');
});

test('invalid, stale, unrelated, and unsupported path selections cannot authorize a topic', () => {
  const options = input({ states: [state(['orders.amount', 'customers.name'])], baseView: 'orders', sourceFiles: joinedFiles });
  const initial = buildDashboardTopicRepairDraft(options);
  const id = initial.joinPathChoices![0].paths[0].id;
  for (const selectedJoinPaths of [{ customers: `sha256:${'0'.repeat(64)}` }, { unrelated: id }, { customers: 'invented-path' }]) {
    const draft = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths });
    assert(draft.blockers.some((message) => /invalid or stale|outside this base|IDs from the current preview/.test(message)));
  }
  const changed = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths: { customers: id }, sourceFiles: { ...joinedFiles,
    relationships: stringify([{ ...edge('orders', 'customers'), join_type: 'inner' }]),
  } });
  assert(changed.blockers.some((message) => /invalid or stale/.test(message)));
  assert.notEqual(changed.joinPathChoices![0].paths[0].id, id, 'authored condition/type changes invalidate the immutable path ID');
  assert(!changed.files.some((file) => file.kind === 'topic'), 'a stale path cannot produce an approvable partial topic');
  const unsupported = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths: { customers: id }, sourceFiles: { ...joinedFiles,
    relationships: stringify([{ ...edge('orders', 'customers'), join_to_view_as: 'alias' }]),
  } });
  assert.deepEqual(unsupported.joinPathChoices![0].paths, []);
  assert(unsupported.blockers.length > 0);
});

test('individually authored paths cannot silently substitute conflicting incoming joins', () => {
  const options = input({ states: [state(['orders.amount', 'bridge.id', 'customers.name'])], baseView: 'orders', sourceFiles: {
    ...joinedFiles,
    'bridge.view': view({ id: field('id'), customer_id: field('customer_id') }),
    'alternate.view': view({ id: field('id'), customer_id: field('customer_id') }),
    relationships: stringify([edge('orders', 'bridge'), edge('orders', 'alternate'), edge('alternate', 'bridge'), edge('bridge', 'customers')]),
  } });
  const initial = buildDashboardTopicRepairDraft(options);
  const bridgePath = initial.joinPathChoices!.find((choice) => choice.requiredView === 'bridge')!.paths.find((path) => path.views.length === 2)!;
  const customerPath = initial.joinPathChoices!.find((choice) => choice.requiredView === 'customers')!.paths.find((path) => path.views.includes('alternate'))!;
  const draft = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths: { bridge: bridgePath.id, customers: customerPath.id } });
  assert(draft.blockers.some((message) => /incompatible incoming relationships for bridge/.test(message)));
  assert(!draft.files.some((file) => file.kind === 'topic'));
});

test('excessive path sets stay bounded and cannot be cleared with a partial selection', () => {
  const options = input({ states: [state(['orders.amount', 'customers.name'])], baseView: 'orders', sourceFiles: { ...joinedFiles,
    relationships: stringify(Array.from({ length: 13 }, (_, index) => [edge('orders', `bridge_${index}`), edge(`bridge_${index}`, 'customers')]).flat()),
  } });
  const initial = buildDashboardTopicRepairDraft(options);
  const choice = initial.joinPathChoices![0];
  assert.equal(choice.paths.length, 12);
  assert.equal(choice.complete, false);
  const draft = buildDashboardTopicRepairDraft({ ...options, selectedJoinPaths: { customers: choice.paths[0].id } });
  assert(draft.blockers.some((message) => /bounded review limit/.test(message)));
  assert.equal(draft.joinPathChoices![0].selectedPathId, undefined);
  assert(!draft.files.some((file) => file.kind === 'topic'));
});

test('base selection cannot pull an unrelated authored view into the topic', () => {
  const draft = buildDashboardTopicRepairDraft(input({ sourceFiles: joinedFiles, baseView: 'customers' }));
  assert.deepEqual(draft.baseViewCandidates, ['orders']);
  assert.equal(draft.baseView, undefined);
  assert.ok(draft.blockers.some((message) => /outside the verified selected-query candidates/.test(message)));
});

test('selected cross-view formulas require authored topic joins, unlike SQL relation dependencies', () => {
  const draft = buildDashboardTopicRepairDraft(input({ states: [state(['orders.customer_name'])], sourceFiles: {
    ...joinedFiles, 'orders.view': view({ id: field('id'), customer_id: field('customer_id'), customer_name: { sql: '${customers.name}' } }),
  } }));
  assert.deepEqual(draft.blockers, []);
  assert.deepEqual(parse(draft.files.find((file) => file.kind === 'topic')!.proposed).joins, { customers: {} });
});

test('target conflicts stay visible as blocked diffs, never silently overwritten', () => {
  const existing = '# destination comment\ndimensions:\n  id:\n    sql: ${TABLE}.different_id\n';
  const draft = buildDashboardTopicRepairDraft(input({ targetFiles: { model: '{}\n', 'orders.view': existing } }));
  const file = draft.files.find((file) => file.kind === 'view')!;
  assert.equal(file.status, 'conflict');
  assert.equal(file.original, existing);
  assert.equal(file.proposed, sourceFiles['orders.view']);
  assert.ok(draft.blockers.some((message) => /conflicts with authored source/.test(message)));
});

test('identical target topic and views are idempotent, while topic collisions block', () => {
  const topic = '# existing comment\nbase_view: orders\n';
  const draft = buildDashboardTopicRepairDraft(input({ targetFiles: { ...sourceFiles, 'new_topic.topic': topic } }));
  assert.deepEqual(draft.blockers, []);
  assert.equal(draft.files.find((file) => file.kind === 'topic')?.status, 'unchanged');
  assert.equal(draft.files.find((file) => file.kind === 'topic')?.proposed, topic);
  assert.equal(draft.files.find((file) => file.kind === 'view')?.status, 'unchanged');
  const collision = buildDashboardTopicRepairDraft(input({ targetFiles: { ...sourceFiles, 'new_topic.topic': 'base_view: different_view\n' } }));
  assert.ok(collision.blockers.some((message) => /destination topic name already exists/.test(message)));
  assert.equal(collision.files.find((file) => file.kind === 'topic')?.status, 'conflict');
});

test('missing views retain their authored type instead of always becoming query views', () => {
  for (const suffix of ['.view', '.query.view']) {
    const fileName = `orders${suffix}`;
    const source = { model: '{}\n', [fileName]: view({ id: field('id') }) };
    const draft = buildDashboardTopicRepairDraft(input({ sourceFiles: source }));
    assert.deepEqual(draft.blockers, []);
    const files = draft.files.filter((file) => file.kind === 'view');
    assert.equal(files.length, 1);
    assert.equal(files[0].fileName, fileName);
    assert.equal(files[0].status, 'new');
    assert.equal(files[0].proposed, source[fileName]);
    assert.match(files[0].message || '', /source type is preserved/);
  }
});

test('existing regular and query views gain only missing fields without duplicate files or lost content', () => {
  for (const suffix of ['.view', '.query.view']) {
    const sourceFile = `source_folder/orders${suffix}`;
    const targetFile = `target_folder/orders${suffix}`;
    const base = suffix === '.query.view' ? { sql: 'SELECT id, amount FROM analytics.orders' } : { sql_table_name: 'analytics.orders' };
    const original = '# destination comment\n' + stringify({ ...base, dimensions: { id: field('id'), destination_only: field('destination_only') } });
    const draft = buildDashboardTopicRepairDraft(input({ states: [state(['orders.amount'])],
      sourceFiles: { model: '{}\n', [sourceFile]: stringify({ ...base, dimensions: { id: field('id'), amount: field('amount') } }) },
      targetFiles: { model: '{}\n', [targetFile]: original },
    }));
    assert.deepEqual(draft.blockers, []);
    const files = draft.files.filter((file) => file.kind === 'view');
    assert.equal(files.length, 1);
    assert.equal(files[0].fileName, targetFile);
    assert.equal(files[0].status, 'additive');
    assert.equal(files[0].original, original);
    assert.match(files[0].proposed, /# destination comment/);
    assert.deepEqual(parse(files[0].proposed), { ...base, dimensions: { id: field('id'), destination_only: field('destination_only'), amount: field('amount') } });
    assert.match(files[0].message || '', /only missing dimensions and measures/);
  }
});

test('compatible destination supersets are reused byte-for-byte for both view types', () => {
  for (const suffix of ['.view', '.query.view']) {
    const fileName = `orders${suffix}`;
    const original = '# retained destination\n' + view({ id: field('id'), extra: field('extra') });
    const draft = buildDashboardTopicRepairDraft(input({ sourceFiles: { model: '{}\n', [fileName]: view({ id: field('id') }) }, targetFiles: { model: '{}\n', [fileName]: original } }));
    assert.deepEqual(draft.blockers, []);
    const file = draft.files.find((file) => file.kind === 'view')!;
    assert.equal(file.status, 'unchanged');
    assert.equal(file.proposed, original);
    assert.match(file.message || '', /No view write is required/);
  }
});

test('same-name regular and query views conflict instead of being converted or duplicated', () => {
  for (const [sourceSuffix, targetSuffix] of [['.view', '.query.view'], ['.query.view', '.view']]) {
    const original = '# preserve destination type\n' + view({ id: field('id') });
    const targetFile = `orders${targetSuffix}`;
    const draft = buildDashboardTopicRepairDraft(input({ sourceFiles: { model: '{}\n', [`orders${sourceSuffix}`]: view({ id: field('id') }) }, targetFiles: { model: '{}\n', [targetFile]: original } }));
    assert(draft.blockers.some((message) => /view type mismatch/.test(message)));
    const files = draft.files.filter((file) => file.kind === 'view');
    assert.equal(files.length, 1);
    assert.equal(files[0].fileName, targetFile);
    assert.equal(files[0].status, 'conflict');
    assert.equal(files[0].proposed, original);
    assert(!draft.files.some((file) => file.kind === 'view' && file.status === 'new'));
  }
});

test('destination inventory presence without authored YAML cannot be treated as an absent view', () => {
  for (const suffix of ['.view', '.query.view']) {
    const draft = buildDashboardTopicRepairDraft(input({ sourceFiles: { model: '{}\n', [`orders${suffix}`]: view({ id: field('id') }) }, targetRelationNames: ['ORDERS'] }));
    assert(draft.blockers.some((message) => /cannot be treated as missing/.test(message)));
    assert.equal(draft.files.find((file) => file.kind === 'view')?.status, 'conflict');
    assert(!draft.files.some((file) => file.kind === 'view' && file.status === 'new'));
  }
});

test('different existing query SQL cannot be worked around by creating another query view', () => {
  const source = stringify({ sql: 'SELECT id FROM analytics.orders', dimensions: { id: field('id') } });
  const target = stringify({ sql: 'SELECT id FROM analytics.restricted_orders', dimensions: { id: field('id') } });
  const draft = buildDashboardTopicRepairDraft(input({ sourceFiles: { model: '{}\n', 'orders.query.view': source }, targetFiles: { model: '{}\n', 'orders.query.view': target } }));
  const files = draft.files.filter((file) => file.kind === 'view');
  assert.equal(files.length, 1);
  assert.equal(files[0].status, 'conflict');
  assert.equal(files[0].original, target);
  assert(draft.blockers.some((message) => /conflicts with authored source semantics/.test(message)));
});

test('workbook-local fields and overrides cannot become shared reconstruction definitions', () => {
  for (const fields of [['orders.local_value'], ['orders.id']]) {
    const selected = { ...state(fields), __topicRepairWorkbookFiles: { 'orders.view': view({ id: field('workbook_id'), local_value: field('local_value') }) } };
    const draft = buildDashboardTopicRepairDraft(input({ states: [selected] }));
    assert.ok(draft.blockers.some((message) => /Workbook-local definitions/.test(message)));
    assert.equal(draft.files.filter((file) => file.kind === 'view').some((file) => file.proposed.includes('workbook_id')), false);
  }
});

test('missing model snapshots and differing security require explicit reconciliation', () => {
  const missing = buildDashboardTopicRepairDraft(input({ targetFiles: {} }));
  assert.ok(missing.blockers.some((message) => /model security snapshots/.test(message)));
  const security = buildDashboardTopicRepairDraft(input({ sourceFiles: { ...sourceFiles, model: 'access_grants:\n  example_grant:\n    user_attribute: example_attribute\n' } }));
  assert.ok(security.blockers.some((message) => /settings\/security differ/.test(message)));
  assert.equal(security.files.some((file) => file.fileName === 'model'), false);
});

test('relation macros include authored SQL dependencies without fabricating fields or topic joins', () => {
  const draft = buildDashboardTopicRepairDraft(input({ states: [state(['summary.id'])], sourceFiles: { ...sourceFiles,
    'summary.query.view': stringify({ sql: 'SELECT ${orders.id} FROM ${orders}', dimensions: { id: field('id') } }),
  } }));
  assert.deepEqual(draft.blockers, []);
  assert.deepEqual(draft.requiredViews, ['orders', 'summary']);
  assert.deepEqual(parse(draft.files.find((file) => file.kind === 'topic')!.proposed), { base_view: 'summary' });
  const unresolved = buildDashboardTopicRepairDraft(input({ states: [state(['summary.id'])], sourceFiles: { ...sourceFiles,
    'summary.query.view': stringify({ sql: 'SELECT * FROM ${unproven_relation}', dimensions: { id: field('id') } }),
  } }));
  assert.ok(unresolved.blockers.some((message) => /unresolved macro unproven_relation/.test(message)));
  assert.equal(unresolved.requiredViews.includes('unproven_relation'), false);
});

test('inherited relation macros are read-only reuse only when both exact inventories contain the name', () => {
  const source = { ...sourceFiles, 'summary.query.view': stringify({ sql: 'SELECT id FROM ${warehouse_orders}', dimensions: { id: field('id') } }) };
  const draft = buildDashboardTopicRepairDraft(input({ states: [state(['summary.id'])], sourceFiles: source,
    sourceRelationNames: ['warehouse_orders'], targetRelationNames: ['warehouse_orders'],
  }));
  assert.deepEqual(draft.blockers, []);
  assert.deepEqual(draft.reusedRelations, ['warehouse_orders']);
  assert.deepEqual(draft.requiredViews, ['summary']);
  assert.equal(draft.files.some((file) => file.fileName.includes('warehouse_orders')), false);
  const missing = buildDashboardTopicRepairDraft(input({ states: [state(['summary.id'])], sourceFiles: source,
    sourceRelationNames: ['warehouse_orders'], targetRelationNames: ['other_warehouse_orders'],
  }));
  assert.ok(missing.blockers.some((message) => /not the destination inventory/.test(message)));
  assert.equal(missing.reusedRelations, undefined);
  assert.ok(missing.files.some((file) => file.kind === 'topic'));
});

test('inherited inventory reuse cannot conceal an authored view conflict or workbook override', () => {
  const source = { ...sourceFiles, 'summary.query.view': stringify({ sql: 'SELECT id FROM ${warehouse_orders}', dimensions: { id: field('id') } }) };
  const selected = { ...state(['summary.id']), __topicRepairWorkbookFiles: { 'warehouse_orders.view': view({ id: field('local_id') }) } };
  const draft = buildDashboardTopicRepairDraft(input({ states: [selected], sourceFiles: source,
    sourceRelationNames: ['warehouse_orders'], targetRelationNames: ['warehouse_orders'],
  }));
  assert.ok(draft.blockers.some((message) => /Workbook-local definitions/.test(message)));
  assert.equal(draft.files.some((file) => file.proposed.includes('local_id')), false);
});

test('ambiguous authored view filenames and oversized YAML are explicit blockers', () => {
  const ambiguous = buildDashboardTopicRepairDraft(input({ sourceFiles: { model: '{}\n', 'first/orders.view': sourceFiles['orders.view'], 'second/orders.view': sourceFiles['orders.view'] } }));
  assert.ok(ambiguous.blockers.some((message) => /ambiguous authored files/.test(message)));
  const oversized = buildDashboardTopicRepairDraft(input({ sourceFiles: { ...sourceFiles, 'orders.view': ' '.repeat(250_001) } }));
  assert.ok(oversized.blockers.some((message) => /review limit/.test(message)));
});
