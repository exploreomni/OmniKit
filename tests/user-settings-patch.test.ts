import assert from 'node:assert/strict';
import { test } from 'node:test';
import manageUsers from '../server/handlers/manage-users';
import { findOmniApiContract } from '../server/services/omniApiContracts';

const USER_ATTRIBUTES = 'urn:omni:params:1.0:UserAttribute';
const PERSONAL_CONTENT = 'omni_allows_personal_content';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

function request(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request('http://localhost/api/manage-users', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co', api_key: 'synthetic-key',
      action: 'update', user_id: 'user-1', ...body,
    }),
  });
}

test('partial user updates become targeted SCIM PATCH operations without omitted attributes or active', async () => {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  const response = await manageUsers(request({
    user_data: { displayName: 'Updated name', [USER_ATTRIBUTES]: { department: 'Engineering', [PERSONAL_CONTENT]: false } },
  }), {
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    url: 'https://example.omniapp.co/api/scim/v2/users/user-1', method: 'PATCH',
    body: { schemas: [PATCH_SCHEMA], Operations: [
      { op: 'replace', path: 'displayName', value: 'Updated name' },
      { op: 'replace', path: `${USER_ATTRIBUTES}:department`, value: 'Engineering' },
      { op: 'replace', path: `${USER_ATTRIBUTES}:${PERSONAL_CONTENT}`, value: 'false' },
    ] },
  }]);
});

test('explicit attribute removals preserve other attributes and opaque user IDs remain encoded', async () => {
  let payload: unknown;
  let requestedUrl = '';
  const response = await manageUsers(request({
    user_id: 'user/../opaque?role=admin#fragment',
    user_data: { [USER_ATTRIBUTES]: { department: '' } },
    attribute_removals: ['region'],
  }), {
    fetchImpl: (async (url, init) => {
      requestedUrl = String(url);
      payload = JSON.parse(String(init?.body));
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(response.status, 200);
  assert.match(requestedUrl, /\/users\/user%2F\.\.%2Fopaque%3Frole%3Dadmin%23fragment$/);
  assert.deepEqual(payload, { schemas: [PATCH_SCHEMA], Operations: [
    { op: 'replace', path: `${USER_ATTRIBUTES}:department`, value: '' },
    { op: 'remove', path: `${USER_ATTRIBUTES}:region` },
  ] });
});

test('a removal-only update and explicit active value produce only their requested operations', async () => {
  const payloads: unknown[] = [];
  const dependencies = {
    fetchImpl: (async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };
  assert.equal((await manageUsers(request({ user_data: {}, attribute_removals: ['region'] }), dependencies)).status, 200);
  assert.equal((await manageUsers(request({ user_data: { active: false } }), dependencies)).status, 200);
  assert.deepEqual(payloads, [
    { schemas: [PATCH_SCHEMA], Operations: [{ op: 'remove', path: `${USER_ATTRIBUTES}:region` }] },
    { schemas: [PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] },
  ]);
});

test('create and update serialize only exact personal-content boolean values to engineering string form', async () => {
  for (const value of [true, false, 'true', 'false']) {
    for (const action of ['create', 'update']) {
      let payload: Record<string, unknown> = {};
      let method = '';
      const response = await manageUsers(request({
        action,
        user_data: { ...(action === 'create' ? { userName: 'person@example.invalid' } : {}), [USER_ATTRIBUTES]: { [PERSONAL_CONTENT]: value } },
      }), {
        fetchImpl: (async (_url, init) => {
          method = String(init?.method);
          payload = JSON.parse(String(init?.body));
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
      });
      assert.equal(response.status, 200);
      assert.equal(method, action === 'create' ? 'POST' : 'PATCH');
      if (action === 'create') assert.deepEqual(payload, { userName: 'person@example.invalid', [USER_ATTRIBUTES]: { [PERSONAL_CONTENT]: String(value) } });
      else assert.deepEqual(payload, { schemas: [PATCH_SCHEMA], Operations: [{ op: 'replace', path: `${USER_ATTRIBUTES}:${PERSONAL_CONTENT}`, value: String(value) }] });
    }
  }
});

test('malformed, unsafe, conflicting, and no-op user mutations are rejected before upstream dispatch', async () => {
  let calls = 0;
  const invalidBodies: Array<Record<string, unknown>> = [
    { user_id: '', user_data: { displayName: 'Name' } },
    { user_id: '..', user_data: { displayName: 'Name' } },
    { user_id: ' user-1 ', user_data: { displayName: 'Name' } },
    { user_id: 'user\n1', user_data: { displayName: 'Name' } },
    { user_id: '\ud800', user_data: { displayName: 'Name' } },
    { user_id: 123, user_data: { displayName: 'Name' } },
    { user_id: 'x'.repeat(257), user_data: { displayName: 'Name' } },
    { user_data: null }, { user_data: [] }, { user_data: 'invalid' }, { user_data: {} },
    { user_data: { [USER_ATTRIBUTES]: {} } },
    { user_data: { active: 'false' } },
    { user_data: { displayName: null } },
    { user_data: { userName: 'not-an-email' } },
    { user_data: { Operations: [{ op: 'remove', path: 'active' }] } },
    { user_data: { [USER_ATTRIBUTES]: null } },
    { user_data: { [USER_ATTRIBUTES]: [] } },
    { user_data: { [USER_ATTRIBUTES]: { 'region.value': 'x' } } },
    { user_data: { [USER_ATTRIBUTES]: { 'region:active': 'x' } } },
    { user_data: { [USER_ATTRIBUTES]: { 'region[value eq "x"]': 'x' } } },
    { user_data: { [USER_ATTRIBUTES]: JSON.parse('{"__proto__":"x"}') } },
    { user_data: { [USER_ATTRIBUTES]: { constructor: 'x' } } },
    { user_data: { [USER_ATTRIBUTES]: { department: { nested: 'x' } } } },
    { user_data: { [USER_ATTRIBUTES]: { department: ['x', 2] } } },
    { user_data: { [USER_ATTRIBUTES]: { department: 'x'.repeat(16 * 1024 + 1) } } },
    { user_data: { [USER_ATTRIBUTES]: { department: [], Department: [] } } },
    { user_data: {}, attribute_removals: 'region' },
    { user_data: {}, attribute_removals: ['region', 'Region'] },
    { user_data: {}, attribute_removals: ['region.value'] },
    { user_data: { [USER_ATTRIBUTES]: { region: 'x' } }, attribute_removals: ['Region'] },
    { action: 'create', user_data: {} },
    { action: 'create', user_data: { userName: 'person@example.invalid' }, attribute_removals: ['region'] },
    ...['TRUE', 'False', '', ' false ', 0, 1, null, [], {}].flatMap((value) => ['create', 'update'].map((action) => ({
      action, user_data: { ...(action === 'create' ? { userName: 'person@example.invalid' } : {}), [USER_ATTRIBUTES]: { [PERSONAL_CONTENT]: value } },
    }))),
  ];
  const dependencies = { fetchImpl: (async () => { calls += 1; return new Response('{}'); }) as typeof fetch };
  for (const body of invalidBodies) {
    const response = await manageUsers(request(body), dependencies);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const body of ['null', '[]', '{bad']) {
    const response = await manageUsers(new Request('http://localhost/api/manage-users', { method: 'POST', body }), dependencies);
    assert.equal(response.status, 400);
  }
  const inherited = request({});
  Object.defineProperty(inherited, 'json', { value: async () => ({
    base_url: 'https://example.omniapp.co', api_key: 'synthetic-key', action: 'update', user_id: 'user-1',
    user_data: { [USER_ATTRIBUTES]: Object.create({ department: 'inherited' }) },
  }) });
  assert.equal((await manageUsers(inherited, dependencies)).status, 400);
  assert.equal(calls, 0);
});

test('failed create or patch is never retried or replaced with another create', async () => {
  for (const action of ['create', 'update']) {
    const methods: string[] = [];
    const response = await manageUsers(request({
      action, user_data: { userName: 'person@example.invalid', [USER_ATTRIBUTES]: { [PERSONAL_CONTENT]: false } },
    }), {
      fetchImpl: (async (_url, init) => {
        methods.push(String(init?.method));
        return new Response('private upstream detail', { status: 409 });
      }) as typeof fetch,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(methods, [action === 'create' ? 'POST' : 'PATCH']);
    assert.doesNotMatch(await response.text(), /private upstream detail/);
  }
});

test('user mutation cancellation stops dispatch and PATCH is registered independently from PUT replacement', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const response = await manageUsers(request({ user_data: { displayName: 'Name' } }, controller.signal), {
    fetchImpl: (async () => { calls += 1; return new Response('{}'); }) as typeof fetch,
  });
  assert.equal(response.status, 499);
  assert.equal(calls, 0);
  assert.equal(findOmniApiContract('PATCH', '/api/scim/v2/users/user-1')?.docsUrl, 'https://docs.omni.co/api/users/update-user');
  assert.equal(findOmniApiContract('PUT', '/api/scim/v2/users/user-1')?.docsUrl, 'https://docs.omni.co/api/users/replace-user');
});

test('a timed-out PATCH remains a single uncertain write with no automatic create fallback', async () => {
  const methods: string[] = [];
  const response = await manageUsers(request({ user_data: { [USER_ATTRIBUTES]: { [PERSONAL_CONTENT]: false } } }), {
    timeoutMs: 1,
    fetchImpl: ((_url, init) => {
      methods.push(String(init?.method));
      return new Promise<Response>(() => undefined);
    }) as typeof fetch,
  });
  assert.equal(response.status, 504);
  assert.deepEqual(methods, ['PATCH']);
  assert.equal((await response.json() as { code: string }).code, 'USER_REQUEST_TIMEOUT');
});

test('exact-user GET is fresh, encodes the entire membership ID, and preserves user attributes', async () => {
  const userId = 'user/../opaque?role=admin#fragment';
  const user = { id: userId, userName: 'person@example.invalid', [USER_ATTRIBUTES]: { [PERSONAL_CONTENT]: 'false' } };
  let calls = 0;
  const response = await manageUsers(request({ action: 'get', user_id: userId }), {
    fetchImpl: (async (url, init) => {
      calls += 1;
      assert.equal(String(url), `https://example.omniapp.co/api/scim/v2/users/${encodeURIComponent(userId)}`);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).get('cache-control'), 'no-cache, no-store');
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(JSON.stringify(user), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), user);
  assert.equal(calls, 1);
  const contract = findOmniApiContract('GET', '/api/scim/v2/users/user-1');
  assert.equal(contract?.docsUrl, 'https://docs.omni.co/api/users/retrieve-user');
  assert.equal(contract?.probeMode, 'read_only');
});

test('exact-user GET rejects malformed IDs and cancelled requests without upstream reads', async () => {
  let calls = 0;
  const dependencies = { fetchImpl: (async () => { calls += 1; return new Response('{}'); }) as typeof fetch };
  for (const userId of [undefined, null, false, 12, {}, [], '', '.', '..', ' user-1', 'user-1 ', 'user\n1', '\ud800', 'x'.repeat(257)]) {
    assert.equal((await manageUsers(request({ action: 'get', user_id: userId }), dependencies)).status, 400);
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = await manageUsers(request({ action: 'get' }, controller.signal), dependencies);
  assert.equal(cancelled.status, 499);
  assert.equal((await cancelled.json() as { code: string }).code, 'USER_REQUEST_CANCELLED');
  assert.equal(calls, 0);
});

test('exact-user GET never retries errors, follows redirects, or falls back to the user collection', async () => {
  for (const status of [302, 403, 404, 429, 500, 503]) {
    let calls = 0;
    const response = await manageUsers(request({ action: 'get' }), {
      fetchImpl: (async (url, init) => {
        calls += 1;
        assert.equal(String(url), 'https://example.omniapp.co/api/scim/v2/users/user-1');
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'manual');
        return new Response('private upstream body', { status, headers: { location: 'https://redirect.example.invalid', 'retry-after': '1' } });
      }) as typeof fetch,
    });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private upstream body/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const timedOut = await manageUsers(request({ action: 'get' }), {
    timeoutMs: 1,
    fetchImpl: (() => { calls += 1; return new Promise<Response>(() => undefined); }) as typeof fetch,
  });
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json() as { code: string }).code, 'USER_REQUEST_TIMEOUT');
  assert.equal(calls, 1);
});
