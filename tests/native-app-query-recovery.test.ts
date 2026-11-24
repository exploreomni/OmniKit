import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import {
  inspectNewQueryDestination, inspectQueryRecovery, readQueryIntentEvidence, restoreQueryFiles,
  type AppRead, type AppWrite, type QueryFiles,
} from '../server/services/nativeAppQueryModels';

const uuid = (n: number) => '5d64d17b-8537-46fa-b387-' + String(n).padStart(12, '0');
const [connection, model, workbook, orphan, source] = [1, 2, 3, 4, 5].map(uuid);
const name = 'orders.view', header = '# Reference this view as warehouse__orders\n';
const measure = { aggregate_type: 'max', sql: '${orders.order_date}' };
const approved = { measures: { max_date: { ...measure, ignored_props: { filters: true } } } };
const partial = { ignored_props: { renamed_from: true }, measures: { max_date: measure } };
const unrelated = { dimensions: { region: { sql: 'region' } }, table_name: 'ORDERS' };
const parent = { ...unrelated, renamed_from: 'previous_orders' };
const effective = { ...parent, measures: { max_date: measure } };
const draftPath = '/api/v2/documents/example/draft/review-me';
const byKey: QueryFiles = { '2': { [name]: header + stringify(approved) } };

function fixture() {
  const initial = { extension: header + stringify(partial), composed: header + stringify({ ...unrelated, measures: { max_date: measure } }),
    parent: header + stringify(parent), kind: 'QUERY', children: [orphan], total: 1, retainedSuppression: true, divergentResolved: false };
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const owner = (id: string) => ({ id, deletedAt: null, modelKind: id === workbook ? 'WORKBOOK' : initial.kind,
    baseModelId: id === workbook ? model : workbook, connectionId: connection });
  const read: AppRead = async (path) => {
    const url = new URL(path, 'https://example.invalid'), params = url.searchParams;
    if (url.pathname === '/api/v1/models') {
      if (params.has('modelId')) return { records: [owner(params.get('modelId')!)] };
      assert.deepEqual([params.get('baseModelId'), params.get('connectionId'), params.get('modelKind')], [workbook, connection, 'QUERY']);
      return { records: initial.children.map(owner), pageInfo: { nextCursor: null, hasNextPage: false, totalRecords: initial.total } };
    }
    const id = url.pathname.split('/')[4];
    assert.ok([model, workbook, orphan, source].includes(id));
    if (params.get('mode') === 'extension') return { files: { [name]: initial.extension }, checksums: { [name]: 'extension-cas' } };
    assert.equal(params.get('fileName'), '^orders\\.view$');
    const resolved = params.get('fullyResolved') === 'true';
    const text = id === source ? header + stringify(effective) : id === workbook || id === model ? initial.parent : initial.composed;
    const yaml = resolved && id === orphan && initial.divergentResolved ? header + stringify({ ...effective,
      measures: { max_date: { ...measure, filters: { status: 'active' } } } }) : text;
    return { files: { [name]: yaml }, ...(resolved ? {} : { checksums: { [name]: (id === workbook ? 'parent:' : 'child:') + text.length } }),
      viewNames: { [name]: 'warehouse__orders' } };
  };
  const write: AppWrite = async (method, path, body) => {
    writes.push({ method, path, body });
    if (method === 'PUT') return { identifier: 'example', draftIdentifier: 'review-me' };
    assert.equal(path, '/api/v1/models/' + orphan + '/yaml');
    const data = body as Record<string, unknown>;
    assert.equal(data.previousChecksum, 'child:' + initial.composed.length);
    assert.equal(data.mode, 'combined');
    assert.equal(data.fullyResolved, false);
    assert.ok(String(data.yaml).startsWith(header));
    assert.deepEqual(parse(String(data.yaml)), { ...parent, ...approved });
    if (initial.retainedSuppression) initial.extension = header + stringify(approved);
    initial.composed = header + stringify(effective);
    return { success: true, fileName: name };
  };
  async function options() {
    return { read, write, draftPath, draftWorkbookId: workbook, destinationModelId: model, connectionId: connection,
      bindings: {}, byKey, evidenceByKey: { '2': await readQueryIntentEvidence(read, source, byKey['2']) },
      queryModelIdsByKey: { '2': orphan } };
  }
  return { initial, writes, options };
}

test('repairs the exact reconciled child with a composed CAS, verifies latent suppression and resolved semantics, then binds it', async () => {
  const f = fixture(), options = await f.options(), reviewedRecovery = await inspectQueryRecovery(options);
  assert.deepEqual(f.writes, []);
  const result = await restoreQueryFiles({ ...options, reviewedRecovery });
  assert.deepEqual(result, { '2': orphan });
  assert.deepEqual(f.writes.map(w => w.path), ['/api/v1/models/' + orphan + '/yaml', draftPath + '/queries/2/query-model']);
  const bound = { ...options, bindings: { '2': orphan }, queryModelIdsByKey: {} };
  await restoreQueryFiles({ ...bound, reviewedRecovery: await inspectQueryRecovery(bound) });
  assert.equal(f.writes.length, 2);
});

test('checks a fresh target before creating a workbook when source and destination view identities differ', async () => {
  const f = fixture(), options = await f.options();
  const plan = await inspectNewQueryDestination(options.read, model, byKey, options.evidenceByKey);
  assert.ok(plan['2'][name]);
  f.initial.parent = header + stringify({ ...parent, table_name: 'OTHER_TABLE' });
  await assert.rejects(inspectNewQueryDestination(options.read, model, byKey, options.evidenceByKey), /cannot reproduce/);
  assert.deepEqual(f.writes, []);
});

test('refuses missing, changed, unaccounted or incorrectly owned recovery children before writing', async () => {
  const f = fixture(), options = await f.options();
  await assert.rejects(inspectQueryRecovery({ ...options, queryModelIdsByKey: {} }), /unexpected/);
  await assert.rejects(inspectQueryRecovery({ ...options, queryModelIdsByKey: { '2': uuid(12) } }), /unexpected/);
  f.initial.kind = 'SHARED';
  await assert.rejects(inspectQueryRecovery(options), /expected workbook/);
  f.initial.kind = 'QUERY';
  f.initial.total = 2;
  await assert.rejects(inspectQueryRecovery(options), /truncated/);
  f.initial.total = 1;
  const reviewedRecovery = await inspectQueryRecovery(options);
  f.initial.parent += '\n# newer revision';
  await assert.rejects(restoreQueryFiles({ ...options, reviewedRecovery }), /reviewed query recovery changed/);
  f.initial.extension = stringify({ measures: { max_date: { ...measure, sql: 'other' } } });
  await assert.rejects(inspectQueryRecovery(options), /conflicts/);
  assert.deepEqual(f.writes, []);
});

test('allows explicit placement of a complete shared definition and refuses ambiguity between different incomplete definitions', async () => {
  const f = fixture(), base = await f.options();
  const both = { ...base, byKey: { ...byKey, '5': byKey['2'] }, evidenceByKey: { ...base.evidenceByKey, '5': base.evidenceByKey['2'] } };
  assert.deepEqual((await inspectQueryRecovery(both)).queryModelIdsByKey, { '2': orphan });
  const different = { ...both, byKey: { ...both.byKey, '5': { ...byKey['2'], 'another.view': 'measures: {another: {}}' } } };
  await assert.rejects(inspectQueryRecovery(different), /cannot be uniquely/);
  const mismatched = { ...both, evidenceByKey: { ...both.evidenceByKey, '5': {} } };
  await assert.rejects(inspectQueryRecovery(mismatched), /cannot be uniquely/);
  assert.deepEqual(f.writes, []);
});

test('never binds a child when Omni drops the filters marker again or the fully resolved field differs', async () => {
  for (const variant of ['suppression', 'resolved']) {
    const f = fixture(), options = await f.options();
    const reviewedRecovery = await inspectQueryRecovery(options);
    if (variant === 'suppression') f.initial.retainedSuppression = false;
    else f.initial.divergentResolved = true;
    await assert.rejects(restoreQueryFiles({ ...options, reviewedRecovery }), /differ/);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].method, 'POST');
  }
});

test('rereads the tab binding before attaching a reconciled child and leaves a concurrent binding alone', async () => {
  const f = fixture(), options = await f.options();
  const reviewedRecovery = await inspectQueryRecovery(options);
  const verifyBindings = async (expected: Record<string, string>) => {
    assert.deepEqual(expected, {});
    throw new Error('The draft binding changed');
  };
  await assert.rejects(restoreQueryFiles({ ...options, reviewedRecovery, verifyBindings }), /draft binding changed/);
  assert.deepEqual(f.writes.map(w => w.path), ['/api/v1/models/' + orphan + '/yaml']);
});
