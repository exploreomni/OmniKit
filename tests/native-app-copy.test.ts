import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

import { apiMiddleware } from '../server/apiMiddleware';
import { handleNativeAppCopy } from '../server/handlers/native-app-copy';
import type { SavedInstance } from '../server/services/nativeVault';
import { readBoundedJson, type OmniJsonRequest, type OmniJsonResponse } from '../server/services/omniJsonTransport';

const sourceModel = 'b81e4679-1234-4abc-9def-000000000001';
const workbook = 'b81e4679-1234-4abc-9def-000000000002';
const destinationModel = 'b81e4679-1234-4abc-9def-000000000003';
const destinationWorkbook = 'b81e4679-1234-4abc-9def-000000000004';
const sourceQuery = 'b81e4679-1234-4abc-9def-000000000005';
const destinationQuery = 'b81e4679-1234-4abc-9def-000000000006';
const emptyExtension = { model: '{}\n', relationships: '[]\n' };
const scope = {
  sourceInstanceId: 'source', destinationInstanceId: 'target', sourceIdentifier: 'source-app',
  destinationIdentifier: 'target-app', destinationModelId: destinationModel,
};
const profile = (id: string): SavedInstance => ({
  id, baseUrl: 'https://' + id + '.example.invalid', apiKey: 'test-only-key-' + id, role: 'both', updatedAt: '1',
} as SavedInstance);

function scenario() {
  const app = { html: '<html>Example App</html>', settings: { allowDownloads: false, safeDomains: [] } };
  const source = {
    name: 'Test app', modelId: sourceModel, workbookModelId: workbook, app: { url: '/api/v2/documents/source-app/app' },
    queryPresentations: { data: { '3': { type: 'query', name: 'My query', query: {
      model_extension_id: sourceQuery, fields: ['example.count'],
    } } }, order: ['3'] },
  };
  const state = {
    app, source, files: { ...emptyExtension } as Record<string, string>, queryFiles: { ...emptyExtension } as Record<string, string>,
    exists: false, mismatch: false, writes: [] as OmniJsonRequest[], ambiguous: false, timedOut: false,
  };
  async function request(req: OmniJsonRequest): Promise<OmniJsonResponse> {
    const { hostname, pathname } = new URL(req.url);
    assert.equal(req.headers.Authorization, 'Bearer test-only-key-' + hostname.split('.')[0]);
    if (hostname === 'source.example.invalid') {
      assert.equal(req.method, 'GET');
      if (pathname.endsWith('/yaml')) {
        assert.ok([sourceQuery, workbook].includes(pathname.split('/')[4]));
        return { status: 200, data: { files: pathname.includes(sourceQuery) ? state.queryFiles : state.files } };
      }
      return { status: 200, data: pathname.endsWith('/app') ? state.app : state.source };
    }
    if (req.method === 'POST') {
      assert.equal(pathname, '/api/v2/documents');
      state.writes.push(req);
      state.exists = true;
      if (state.ambiguous) throw new Error('Simulated response loss');
      if (state.timedOut) return { status: 408 };
      return { status: 201, data: { identifier: scope.destinationIdentifier } };
    }
    if (!state.exists) return { status: 404 };
    if (pathname.endsWith('/yaml')) {
      assert.ok([destinationQuery, destinationWorkbook].includes(pathname.split('/')[4]));
      return { status: 200, data: { files: emptyExtension } };
    }
    if (pathname.endsWith('/app')) return { status: 200, data: { ...state.app, html: state.mismatch ? 'different' : state.app.html } };
    return { status: 200, data: {
      ...state.source, app: { url: '/api/v2/documents/target-app/app' }, modelId: destinationModel, workbookModelId: destinationWorkbook,
      queryPresentations: { data: { '3': { type: 'query', name: 'My query', query: { model_extension_id: destinationQuery, fields: ['example.count'] } } }, order: ['3'] },
    } };
  }
  const run = (action: string, extra = {}) => handleNativeAppCopy(new Request('http://localhost/api/native-app-copy', {
    method: 'POST', body: JSON.stringify({ ...scope, action, ...extra }),
  }), { profile, request });
  return { state, run };
}

test('native App copy verifies published HTML, sandbox settings, named query keys/order and destination binding', async () => {
  const { state, run } = scenario();
  const preview = await (await run('preview')).json();
  assert.equal(preview.status, 'preview');
  assert.equal(preview.queryModelCount, 0);
  assert.equal(preview.queryModelFileCount, 0);
  assert.deepEqual(preview.queryNames, ['My query']);
  assert.equal(state.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(preview), /<html>|example\.count|test-only-key/);
  const applied = await run('apply', { previewDigest: preview.previewDigest });
  assert.equal((await applied.json()).status, 'verified');
  assert.equal(state.writes.length, 1);
  const sent = JSON.parse(state.writes[0].body!);
  assert.deepEqual(sent.app, state.app);
  assert.deepEqual(sent.queryPresentations.order, ['3']);
  assert.equal(sent.queryPresentations.data['3'].name, 'My query');
  assert.deepEqual(sent.queryPresentations.data['3'].query, { fields: ['example.count'] });
  assert.equal(sent.modelId, destinationModel);
  assert.equal(sent.identifier, scope.destinationIdentifier);
  assert.equal(await run('apply', { previewDigest: preview.previewDigest }).then(res => res.status), 409);
  assert.equal(state.writes.length, 1);
});

test('App previews invalidate on source or destination scope change and block unmapped dependencies', async () => {
  const { state, run } = scenario();
  const preview = await (await run('preview')).json();
  assert.equal((await run('apply', { previewDigest: preview.previewDigest, destinationIdentifier: 'different' })).status, 409);
  state.app.settings.allowDownloads = true;
  assert.equal((await run('apply', { previewDigest: preview.previewDigest })).status, 409);
  state.files = { 'example.view': 'dimensions:\n  extra: {}' };
  assert.equal((await run('preview')).status, 422);
  state.files = { ...emptyExtension, relationships: '- {join_from_view: orders}' };
  assert.equal((await run('preview')).status, 422);
  state.files = {};
  state.queryFiles = { relationships: '- {join_from_view: orders}' };
  assert.equal((await run('preview')).status, 422);
  state.queryFiles = { 'other.view': '[]' };
  assert.equal((await run('preview')).status, 422);
  state.queryFiles = { 'model': 'access_grants: [unknown]' };
  assert.equal((await run('preview')).status, 422);
  state.queryFiles = {};
  Object.assign(state.source.queryPresentations.data['3'].query, { modelId: destinationModel });
  assert.equal((await run('preview')).status, 422);
  assert.equal(state.writes.length, 0);
});

function authoredScenario() {
  const connectionId = 'a91b0957-abf6-450b-8620-400000000000';
  const uuid = (i: number) => 'a91b0957-abf6-450b-8620-' + String(i).padStart(12, '0');
  const sourceFiles = {
    '5': { 'sales.view': 'measures:\n  total: {aggregate_type: sum, sql: amount}' },
    '2': { 'units.view': 'measures:\n  total_units: {aggregate_type: sum, sql: units}' },
  };
  const ids = { source: ['5', '2'].map(k => uuid(Number(k))), draft: [uuid(15), uuid(12)], published: [uuid(25), uuid(22)] };
  const draftId = 'draft-test', draftWorkbook = uuid(101), mainWorkbook = uuid(102);
  const app = { html: '<html>Two workbook queries</html>', settings: { allowDownloads: false } };
  const target = '/api/v2/documents/target-app', draft = target + '/draft/' + draftId;
  const owned = new Map<string, Record<string, string>>([[ids.draft[0], {}]]);
  const bindings: Record<string, string> = { '5': ids.draft[0] };
  const stages = { exists: false, initialized: false, attached: false, published: false, wrongOwner: false,
    unsupported: false, changedDraft: false, changedPublishedYaml: false, dropBindResponse: false, rebindDuringSave: false };
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const order = ['5', '2'];
  function content(type: 'source' | 'draft' | 'published' | 'scaffold') {
    const modelIds = type === 'source' ? ids.source : type === 'published' ? ids.published
      : type === 'scaffold' ? [] : order.map(k => bindings[k]);
    return {
      name: 'Two queries', description: null, modelId: type === 'source' ? sourceModel : destinationModel,
      workbookModelId: type === 'source' ? workbook : type === 'draft' ? draftWorkbook : mainWorkbook,
      ...(type === 'source' || type === 'published' || (type === 'draft' && stages.attached)
        ? { app: { url: (type === 'source' ? '/api/v2/documents/source-app' : type === 'draft' ? draft : target) + '/app' } } : {}),
      queryPresentations: { order, data: Object.fromEntries(order.map((k, i) => [k, {
        type: 'query', name: ['Sales', 'Units'][i], query: { fields: [['sales.total', 'units.total_units'][i]],
          ...(modelIds[i] ? { model_extension_id: modelIds[i] } : {}) },
      }])) },
    };
  }
  async function transport(req: OmniJsonRequest): Promise<OmniJsonResponse> {
    const { hostname, pathname: path, searchParams } = new URL(req.url);
    const ok = (data: unknown, status = 200) => ({ data, status });
    if (path === '/openapi.json') {
      assert.equal(req.headers.Authorization, undefined);
      const d = '/api/v2/documents/{identifier}/draft';
      return ok({ paths: {
        [d + '/{draft}/queries/{key}/query-model']: stages.unsupported ? {} : { put: {} }, [d + '/{draft}/app']: { put: {} },
        '/api/v1/models': { post: {} }, '/api/v1/models/{id}/yaml': { post: {} },
        '/api/v1/documents/{id}/drafts': { get: {} }, [d]: { patch: {} }, [d + '/publish']: { post: {} },
      } });
    }
    assert.equal(req.headers.Authorization, 'Bearer test-only-key-' + hostname.split('.')[0]);
    const from = hostname.startsWith('source.');
    if (from) assert.equal(req.method, 'GET');
    const body = req.body ? JSON.parse(req.body) : {};
    if (req.method !== 'GET') writes.push({ method: req.method, path, body });
    if (path === '/api/v1/models' && req.method === 'GET') {
      if (searchParams.get('baseModelId')) {
        assert.equal(searchParams.get('baseModelId'), draftWorkbook);
        assert.equal(searchParams.get('modelKind'), 'QUERY');
        const records = Array.from(owned.keys(), id => ({
          id, deletedAt: null, modelKind: 'QUERY', baseModelId: draftWorkbook, connectionId,
        }));
        return ok({ records, pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: records.length } });
      }
      const id = searchParams.get('modelId')!;
      const modelKind = id === destinationModel ? 'SHARED' : [draftWorkbook, mainWorkbook].includes(id) ? 'WORKBOOK' : 'QUERY';
      const baseModelId = modelKind === 'WORKBOOK' ? destinationModel : from ? workbook : ids.published.includes(id)
        ? mainWorkbook : stages.wrongOwner ? destinationModel : draftWorkbook;
      return ok({ records: [{ id, deletedAt: null, modelKind, baseModelId, connectionId }] });
    }
    if (path.endsWith('/yaml')) {
      const id = path.split('/')[4];
      if (req.method === 'POST') {
        assert.ok(owned.has(id));
        owned.get(id)![body.fileName] = body.yaml;
        if (stages.rebindDuringSave) bindings['2'] = uuid(200);
        return ok({ success: true, fileName: body.fileName });
      }
      if (id === workbook || id === draftWorkbook || id === mainWorkbook) return ok({ files: emptyExtension });
      const sourceIndex = ids.source.indexOf(id), pubIndex = ids.published.indexOf(id);
      if (sourceIndex >= 0) return ok({ files: { ...emptyExtension, ...sourceFiles[order[sourceIndex] as keyof typeof sourceFiles] } });
      if (pubIndex >= 0) return ok({ files: { ...emptyExtension, ...(stages.changedPublishedYaml ? {} : owned.get(ids.draft[pubIndex])) } });
      assert.ok(owned.has(id));
      const files = { ...emptyExtension, ...owned.get(id) };
      const checksums = Object.fromEntries(Object.entries(files).map(([name, yaml]) => [name, 'file-revision-' + yaml.length]));
      return ok({ files, checksums });
    }
    if (from) return ok(path.endsWith('/app') ? app : content('source'));
    if (req.method === 'GET' && path === target) return stages.exists ? ok(content(stages.published ? 'published' : 'scaffold')) : ok(null, 404);
    if (req.method === 'POST' && path === '/api/v2/documents') {
      assert.equal(body.containers, null); assert.equal(body.app, undefined);
      assert.deepEqual(body.queryPresentations.order, order);
      stages.exists = true; return ok({ identifier: 'target-app' }, 201);
    }
    if (req.method === 'PATCH' && path === target + '/draft') {
      stages.initialized = true; return ok({ draftIdentifier: draftId, identifier: 'target-app' });
    }
    if (req.method === 'PUT' && path === draft + '/app') {
      assert.ok(stages.initialized); assert.deepEqual(body, app); stages.attached = true;
      return ok({ draftIdentifier: draftId, identifier: 'target-app' });
    }
    if (path === draft && req.method === 'GET') return ok(content('draft'));
    if (path.endsWith('/app') && req.method === 'GET') return ok(app);
    if (path === '/api/v1/models' && req.method === 'POST') {
      assert.deepEqual(body, { baseModelId: draftWorkbook, connectionId, modelKind: 'QUERY' });
      owned.set(ids.draft[1], {}); return ok({ success: true, model: { id: ids.draft[1], modelKind: 'QUERY' } });
    }
    if (path.startsWith(draft + '/queries/') && path.endsWith('/query-model') && req.method === 'PUT') {
      const key = path.split('/').at(-2)!;
      const id = ids.draft[order.indexOf(key)];
      assert.deepEqual(body, { queryModelId: id }); bindings[key] = id;
      if (stages.dropBindResponse) throw new Error('Simulated response loss');
      return ok({ draftIdentifier: draftId, identifier: 'target-app' });
    }
    if (path.endsWith('/drafts')) {
      const rows = [{ status: 'active', branch: null, identifier: stages.changedDraft ? 'different' : draftId,
        publishedIdentifier: 'target-app', workbookModelId: draftWorkbook, draftOutOfDate: false }];
      const message = Object.assign(Readable.from([JSON.stringify(rows)]), { headers: { 'content-type': 'application/json' } });
      return ok(await readBoundedJson(message as IncomingMessage, req.maximumResponseBytes, false, req.expectedRoot));
    }
    if (path === target + '/draft/publish' && req.method === 'POST') {
      stages.published = true; return ok({ identifier: 'target-app' });
    }
    throw new Error('Unexpected route ' + path);
  }
  const run = (action: string, previewDigest?: string, extra = {}) => handleNativeAppCopy(new Request('http://localhost/api/native-app-copy', {
    method: 'POST', body: JSON.stringify({ ...scope, action, previewDigest, ...extra }),
  }), { profile, request: transport });
  function partialCopy() {
    Object.assign(stages, { exists: true, initialized: true, attached: true });
    delete bindings['5'];
    owned.set(ids.draft[0], { ...sourceFiles['5'] });
    return { recovery: {
      draftIdentifier: draftId, draftWorkbookModelId: draftWorkbook, publishedWorkbookModelId: mainWorkbook,
      queryModelIdsByKey: { '5': ids.draft[0] },
    } };
  }
  return { writes, stages, run, sourceFiles, partialCopy };
}

test('recovery reuses the reviewed draft and its unbound query model without recreating the App', async () => {
  const { run, writes, partialCopy } = authoredScenario();
  const target = partialCopy();
  assert.equal((await run('preview')).status, 409);
  const preview = await (await run('preview', undefined, target)).json();
  assert.equal(preview.status, 'preview', preview.error);
  assert.deepEqual(preview.recovery, target.recovery);
  assert.deepEqual(Object.fromEntries(preview.recoveryTabs.map((tab: { key: string; modelAction: string }) => [tab.key, tab.modelAction])),
    { '5': 'bind_existing', '2': 'create_and_bind' });
  assert.equal(writes.length, 0);
  const result = await (await run('apply', preview.previewDigest, target)).json();
  assert.equal(result.status, 'verified', result.error);
  assert.equal(writes.filter(w => w.path === '/api/v1/models').length, 1);
  assert.equal(writes.filter(w => w.path.endsWith('/yaml')).length, 1);
  assert.equal(writes.filter(w => w.path.endsWith('/query-model')).length, 2);
  assert.equal(writes.filter(w => w.path === '/api/v2/documents' || w.path.endsWith('/app') || w.path.endsWith('/draft')).length, 0);
  assert.equal(writes.filter(w => w.path.endsWith('/draft/publish')).length, 1);
  const count = writes.length;
  assert.equal((await run('apply', preview.previewDigest, target)).status, 422);
  assert.equal(writes.length, count);
});

test('recovery refuses a different published workbook, unreviewed query child or stale draft before writing', async () => {
  const { run, writes, partialCopy, stages } = authoredScenario();
  const target = partialCopy();
  const preview = await (await run('preview', undefined, target)).json();
  assert.equal(preview.status, 'preview', preview.error);
  for (const changes of [{ publishedWorkbookModelId: workbook }, { queryModelIdsByKey: {} }]) {
    assert.equal((await run('preview', undefined, { recovery: { ...target.recovery, ...changes } })).status, 422);
  }
  stages.changedDraft = true;
  assert.equal((await run('apply', preview.previewDigest, target)).status, 422);
  assert.equal(writes.length, 0);
});

test('a tab rebound during restoration keeps its new binding and the draft stays unpublished', async () => {
  const { run, stages, writes } = authoredScenario();
  const { previewDigest } = await (await run('preview')).json();
  stages.rebindDuringSave = true;
  const result = await run('apply', previewDigest);
  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /bindings changed/);
  assert.equal(writes.some(w => w.path.endsWith('/query-model') || w.path.endsWith('/publish')), false);
});

test('App copy restores two independent query-local measures and checks published bindings by stable key', async () => {
  const { writes, stages, run } = authoredScenario();
  const pre = await (await run('preview')).json();
  assert.equal(pre.queryModelCount, 2);
  assert.equal(pre.queryModelFileCount, 2); assert.equal(writes.length, 0);
  const result = await (await run('apply', pre.previewDigest)).json();
  assert.equal(result.status, 'verified');
  assert.equal(stages.published, true);
  assert.deepEqual(result.queryNames, ['Sales', 'Units']);
  assert.equal(writes.filter(w => w.path === '/api/v1/models').length, 1);
  assert.equal(writes.filter(w => w.path.endsWith('/yaml')).length, 2);
});

test('App copy gates authored files on destination capability, ownership, unchanged draft and final published YAML', async () => {
  const incapable = authoredScenario(); incapable.stages.unsupported = true;
  assert.equal((await incapable.run('preview')).status, 422); assert.equal(incapable.writes.length, 0);
  const changed = authoredScenario();
  const initial = await (await changed.run('preview')).json();
  changed.sourceFiles['2']['units.view'] = 'measures:\n  total_units: {aggregate_type: max, sql: units}';
  assert.equal((await changed.run('apply', initial.previewDigest)).status, 409);
  changed.sourceFiles['2']['units.view'] = 'measures:\n  total_units: {required_access_grants: [private]}';
  assert.equal((await changed.run('preview')).status, 422);
  assert.equal(changed.writes.length, 0);
  for (const issue of ['wrongOwner', 'changedDraft', 'dropBindResponse', 'changedPublishedYaml'] as const) {
    const { run, writes, stages } = authoredScenario();
    const pre = await (await run('preview')).json();
    stages[issue] = true;
    const response = await run('apply', pre.previewDigest);
    assert.equal(response.status, 502);
    const failure = await response.json();
    assert.equal(failure.draftIdentifier, 'draft-test');
    assert.equal(failure.code, 'APP_COPY_UNVERIFIED');
    assert.ok(failure.error.includes(failure.stage));
    assert.match(failure.error, /destination target-app, draft draft-test/);
    assert.doesNotMatch(failure.error, /Simulated response loss|test-only-key/);
    assert.equal(stages.published, issue === 'changedPublishedYaml');
    assert.equal((await run('apply', pre.previewDigest)).status, 409);
    assert.equal(writes.filter(w => w.path === '/api/v2/documents').length, 1);
    if (issue === 'wrongOwner') assert.equal(writes.filter(w => w.path.endsWith('/yaml')).length, 0);
  }
});

test('App copy reports a potentially created identifier after transport loss or divergent readback', async () => {
  for (const issue of ['ambiguous', 'mismatch', 'timedOut'] as const) {
    const { state, run } = scenario();
    const { previewDigest } = await (await run('preview')).json();
    state[issue] = true;
    const result = await run('apply', { previewDigest });
    assert.equal(result.status, 502);
    assert.equal((await result.json()).destinationIdentifier, scope.destinationIdentifier);
    assert.equal((await run('apply', { previewDigest })).status, 409);
    assert.equal(state.writes.length, 1);
  }
});

test('App copy only accepts saved profiles and omits saved credential material from responses', async () => {
  const { state, run } = scenario();
  assert.equal((await run('preview', { apiKey: 'raw-key' })).status, 400);
  assert.equal((await run('apply')).status, 400);
  state.app.html += profile('source').apiKey;
  const result = await run('preview');
  assert.equal(result.status, 422);
  assert.doesNotMatch(await result.text(), /test-only-key-source/);
  assert.equal(state.writes.length, 0);
});

test('native App copy is reachable through same-origin middleware with a strict saved-profile body', async () => {
  async function dispatch(origin: string, body: unknown) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    req.url = '/api/native-app-copy';
    req.method = 'POST';
    req.headers = { host: 'localhost:5174', origin, 'content-type': 'application/json' };
    const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as unknown as ServerResponse;
    res.setHeader = (() => res) as ServerResponse['setHeader'];
    const done = once(res, 'finish');
    await apiMiddleware()(req, res);
    await done;
    return res.statusCode;
  }
  assert.equal(await dispatch('https://unrelated.example', { ...scope, action: 'preview' }), 403);
  assert.equal(await dispatch('http://localhost:5174', { ...scope, action: 'preview', apiKey: 'inline-key' }), 400);
});
