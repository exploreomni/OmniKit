import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import manageGroupsHandler from '../server/handlers/manage-groups';
import manageUsersHandler from '../server/handlers/manage-users';
import {
  buildIdentityAccessEvidence,
  listIdentityAccessUsers,
  type IdentityAccessEvidenceReader,
} from '../server/services/identityAccessEvidence';
import type { SavedInstance } from '../server/services/nativeVault';
import {
  assignUserModelRole,
  cloneScimUserAttributes,
  findUserByEmail,
  getGroup,
  hasAvailableScimGroupMembershipEvidence,
  listAllGroups,
  listAllUsers,
  listUserModelRoles,
  parseScimListResponse,
  parseScimGroupMembers,
  SCIM_USER_ATTRIBUTE_LIMITS,
  type ScimListResponse,
} from '../src/services/omniApi';
import {
  fetchIdentityAccessEvidence,
  parseIdentityAccessEvidenceReport,
  serializeIdentityAccessEvidence,
} from '../src/services/identityAccessEvidence';

const BASE_URL = 'https://tenant.example.invalid';
const API_KEY = 'vault-reference-only';
const PRIVATE_MARKER = 'raw-private-response-marker';

test('available list membership evidence avoids a redundant detail read and survives absent detail data', () => {
  const listedMembers = [{ value: 'user-1', display: 'User One' }];
  assert.deepEqual(parseScimGroupMembers(listedMembers), listedMembers);
  assert.equal(hasAvailableScimGroupMembershipEvidence('available', undefined, listedMembers), true);
  assert.equal(hasAvailableScimGroupMembershipEvidence('available', undefined, [{ display: 'Missing ID' }]), false);
  assert.equal(hasAvailableScimGroupMembershipEvidence('failed', undefined, listedMembers), false);
});

function identityHandlerRequest(
  route: 'manage-users' | 'manage-groups',
  body: Record<string, unknown>,
) {
  return new Request(`http://localhost/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'private-api-key-marker',
      ...body,
    }),
  });
}

type CollectionKind = 'user' | 'group';

const collectionContracts = {
  user: {
    endpoint: '/api/manage-users',
    listAll: listAllUsers,
  },
  group: {
    endpoint: '/api/manage-groups',
    listAll: listAllGroups,
  },
} satisfies Record<CollectionKind, {
  endpoint: string;
  listAll: typeof listAllUsers;
}>;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function scimRecord(kind: CollectionKind, id: unknown) {
  return kind === 'user'
    ? { id, userName: `${String(id)}@example.invalid` }
    : { id, displayName: `Group ${String(id)}` };
}

function mockCollectionResponses(
  t: TestContext,
  kind: CollectionKind,
  payloads: unknown[],
  requestedStartIndexes?: number[],
) {
  let responseIndex = 0;
  const starts: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), collectionContracts[kind].endpoint);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.action, 'list');
    starts.push(body.start_index as number);
    if (responseIndex >= payloads.length) throw new Error('Unexpected extra SCIM request in test.');
    return json(payloads[responseIndex++]);
  });
  t.after(() => {
    assert.equal(responseIndex, payloads.length);
    if (requestedStartIndexes) assert.deepEqual(starts, requestedStartIndexes);
  });
}

test('user attributes preserve documented strings, finite numbers, system booleans, homogeneous arrays, empty arrays, order, and duplicates', async (t) => {
  const attributes = {
    department: 'Architecture',
    quota: 12.5,
    omni_is_org_admin: true,
    omni_allows_personal_content: false,
    regions: ['Central', 'West', 'Central'],
    thresholds: [2, 1.5, 2],
    unassigned: [],
  };
  mockCollectionResponses(t, 'user', [{
    Resources: [{
      ...scimRecord('user', 'user-supported-attributes'),
      active: false,
      'urn:omni:params:1.0:UserAttribute': attributes,
    }],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
  }], [1]);

  const result = await listAllUsers(BASE_URL, API_KEY);

  assert.equal(result.Resources?.[0]?.active, false);
  assert.deepEqual(result.Resources?.[0]?.['urn:omni:params:1.0:UserAttribute'], attributes);
});

test('user attribute cloning is prototype-safe, structurally exact, and rejects dangerous own keys', () => {
  const source = {
    department: 'Architecture',
    quota: 12.5,
    omni_is_org_admin: true,
    regions: ['Central', 'West', 'Central'],
    thresholds: [2, 1.5, 2],
    unassigned: [],
  };
  const cloned = cloneScimUserAttributes(source);

  assert.equal(Object.getPrototypeOf(cloned), null);
  assert.deepEqual(Object.entries(cloned), Object.entries(source));
  assert.notEqual(cloned.regions, source.regions);
  assert.notEqual(cloned.thresholds, source.thresholds);

  const dangerous = JSON.parse('{"__proto__":["polluted"],"department":"Architecture"}') as typeof source;
  assert.throws(() => cloneScimUserAttributes(dangerous), /invalid user attributes/i);
  assert.equal(Object.prototype.hasOwnProperty.call(dangerous, '__proto__'), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('user attributes and active state reject unsafe values and every local safety-cap violation', () => {
  const sparse = new Array<string>(2);
  sparse[1] = 'second';
  const oversizedSerialized = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `attribute_${index}`,
      'x'.repeat(SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength),
    ]),
  );
  const invalidResources = [
    { active: 'true' },
    { active: undefined },
    { 'urn:omni:params:1.0:UserAttribute': null },
    { 'urn:omni:params:1.0:UserAttribute': { department: undefined } },
    { 'urn:omni:params:1.0:UserAttribute': { department: { value: 'Architecture' } } },
    { 'urn:omni:params:1.0:UserAttribute': { department: [['Architecture']] } },
    { 'urn:omni:params:1.0:UserAttribute': { department: sparse } },
    { 'urn:omni:params:1.0:UserAttribute': { department: ['Architecture', 7] } },
    { 'urn:omni:params:1.0:UserAttribute': { enabled: [true] } },
    { 'urn:omni:params:1.0:UserAttribute': { quota: Number.NaN } },
    { 'urn:omni:params:1.0:UserAttribute': { quota: Number.POSITIVE_INFINITY } },
    { 'urn:omni:params:1.0:UserAttribute': { '   ': 'blank key' } },
    JSON.parse('{"urn:omni:params:1.0:UserAttribute":{"__proto__":"dangerous"}}'),
    JSON.parse('{"urn:omni:params:1.0:UserAttribute":{"ConStructor":"dangerous"}}'),
    JSON.parse('{"urn:omni:params:1.0:UserAttribute":{"PROTOTYPE":"dangerous"}}'),
    { 'urn:omni:params:1.0:UserAttribute': { ' padded': 'leading whitespace' } },
    { 'urn:omni:params:1.0:UserAttribute': { 'padded ': 'trailing whitespace' } },
    { 'urn:omni:params:1.0:UserAttribute': { 'control\u0000key': 'control character' } },
    { 'urn:omni:params:1.0:UserAttribute': { ['k'.repeat(SCIM_USER_ATTRIBUTE_LIMITS.maxKeyLength + 1)]: 'oversized key' } },
    { 'urn:omni:params:1.0:UserAttribute': { note: 'x'.repeat(SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength + 1) } },
    { 'urn:omni:params:1.0:UserAttribute': { regions: Array.from({ length: SCIM_USER_ATTRIBUTE_LIMITS.maxArrayEntries + 1 }, () => 'x') } },
    {
      'urn:omni:params:1.0:UserAttribute': Object.fromEntries(
        Array.from({ length: SCIM_USER_ATTRIBUTE_LIMITS.maxAttributes + 1 }, (_, index) => [`key_${index}`, 'value']),
      ),
    },
    { 'urn:omni:params:1.0:UserAttribute': oversizedSerialized },
  ];
  for (const [index, invalid] of invalidResources.entries()) {
    assert.throws(
      () => parseScimListResponse({
        Resources: [{
          ...scimRecord('user', `user-invalid-attribute-${index}`),
          ...invalid,
          diagnostic: PRIVATE_MARKER,
        }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      }, 'user', 100, 1),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid SCIM user list response/i);
        assert.doesNotMatch(error.message, new RegExp(PRIVATE_MARKER, 'i'));
        return true;
      },
    );
  }
});

test('SCIM collection rejects an own error property even when the value is falsy or null', async (t) => {
  const payloads = ['', false, null].map((error) => ({
    Resources: [],
    totalResults: 0,
    startIndex: 1,
    itemsPerPage: 0,
    error,
  }));
  mockCollectionResponses(t, 'user', payloads);

  for (const payload of payloads) {
    void payload;
    await assert.rejects(
      listAllUsers(BASE_URL, API_KEY),
      /SCIM user list request/i,
    );
  }
});

async function rejectsWithoutRawValues(promise: Promise<unknown>, kind: CollectionKind) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`invalid SCIM ${kind} list response`, 'i'));
    assert.doesNotMatch(error.message, new RegExp(PRIVATE_MARKER, 'i'));
    return true;
  });
}

test('SCIM validation diagnostics identify only the rejected contract field', () => {
  const privateEmail = 'private-person@example.invalid';
  const privateAttributeKey = 'private_department';
  const cases: Array<{
    kind: CollectionKind;
    payload: unknown;
    code: string;
  }> = [
    {
      kind: 'user',
      payload: null,
      code: 'SCIM_USER_LIST_BODY_NOT_OBJECT',
    },
    {
      kind: 'user',
      payload: { totalResults: 0, startIndex: 1, itemsPerPage: 0, diagnostic: PRIVATE_MARKER },
      code: 'SCIM_USER_LIST_RESOURCES_NOT_ARRAY',
    },
    {
      kind: 'user',
      payload: { Resources: [], totalResults: '0', startIndex: 1, itemsPerPage: 0, diagnostic: PRIVATE_MARKER },
      code: 'SCIM_USER_LIST_TOTAL_RESULTS_INVALID',
    },
    {
      kind: 'user',
      payload: {
        Resources: [{ id: PRIVATE_MARKER, userName: privateEmail, active: 'true' }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      code: 'SCIM_USER_LIST_USER_ACTIVE_INVALID',
    },
    {
      kind: 'user',
      payload: {
        Resources: [{
          id: PRIVATE_MARKER,
          userName: privateEmail,
          'urn:omni:params:1.0:UserAttribute': {
            [privateAttributeKey]: { confidential: PRIVATE_MARKER },
          },
        }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      code: 'SCIM_USER_LIST_USER_ATTRIBUTE_VALUE_INVALID',
    },
    {
      kind: 'group',
      payload: {
        Resources: [{ id: PRIVATE_MARKER, displayName: 'Private group', members: [{}] }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      code: 'SCIM_GROUP_LIST_GROUP_MEMBERS_INVALID',
    },
  ];

  for (const { kind, payload, code } of cases) {
    assert.throws(
      () => parseScimListResponse(payload, kind, 100, 1),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: unknown }).code, code);
        assert.match(error.message, new RegExp(`Diagnostic code: ${code}\\.`));
        for (const privateValue of [PRIVATE_MARKER, privateEmail, privateAttributeKey, 'Private group']) {
          assert.doesNotMatch(`${error.message} ${(error as Error & { code?: unknown }).code || ''}`, new RegExp(privateValue, 'i'));
        }
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'payload'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
        return true;
      },
    );
  }
});

for (const kind of ['user', 'group'] as const) {
  test(`${kind} collection preserves a legitimate complete empty SCIM response`, async (t) => {
    mockCollectionResponses(t, kind, [{
      Resources: [],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
    }], [1]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY);

    assert.deepEqual(result.Resources, []);
    assert.equal(result.totalResults, 0);
    assert.equal(result.loadedResults, 0);
    assert.equal(result.truncated, false);
  });

  test(`${kind} collection rejects a successful response with missing Resources`, async (t) => {
    mockCollectionResponses(t, kind, [{
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      diagnostic: PRIVATE_MARKER,
    }]);

    await rejectsWithoutRawValues(
      collectionContracts[kind].listAll(BASE_URL, API_KEY),
      kind,
    );
  });

  test(`${kind} collection rejects explicit service errors without exposing response values`, async (t) => {
    mockCollectionResponses(t, kind, [{ error: PRIVATE_MARKER }]);

    await assert.rejects(
      collectionContracts[kind].listAll(BASE_URL, API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`SCIM ${kind} list request`, 'i'));
        assert.doesNotMatch(error.message, new RegExp(PRIVATE_MARKER, 'i'));
        return true;
      },
    );
  });

  test(`${kind} collection rejects missing, mistyped, or inconsistent pagination metadata`, async (t) => {
    const invalidResponses = [
      { Resources: [], totalResults: '0', startIndex: 1, itemsPerPage: 0 },
      { Resources: [], totalResults: -1, startIndex: 1, itemsPerPage: 0 },
      { Resources: [], totalResults: 0, itemsPerPage: 0 },
      { Resources: [], totalResults: 0, startIndex: 2, itemsPerPage: 0 },
      { Resources: [], totalResults: 0, startIndex: 1 },
      { Resources: [], totalResults: 0, startIndex: 1, itemsPerPage: 1 },
      { Resources: [], totalResults: 2, startIndex: 1, itemsPerPage: 0 },
    ];
    mockCollectionResponses(t, kind, invalidResponses);

    for (const payload of invalidResponses) {
      void payload;
      await rejectsWithoutRawValues(
        collectionContracts[kind].listAll(BASE_URL, API_KEY),
        kind,
      );
    }
  });

  test(`${kind} collection rejects malformed records and missing required identity fields`, async (t) => {
    const invalidResponses = [
      {
        Resources: [null],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        diagnostic: PRIVATE_MARKER,
      },
      {
        Resources: [{ ...scimRecord(kind, 7), diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        Resources: [{ ...scimRecord(kind, '   '), diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        Resources: [{ id: `${kind}-missing-required-name`, diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      ...(kind === 'group' ? [{
        Resources: [{ ...scimRecord('group', 'group-invalid-members'), members: [{}], diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      }] : []),
      ...(kind === 'user' ? [
        {
          Resources: [{ ...scimRecord('user', 'user-bad-display'), displayName: {} }],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
        },
        {
          Resources: [{ ...scimRecord('user', 'user-bad-groups'), groups: [null] }],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
        },
        {
          Resources: [{
            ...scimRecord('user', 'user-bad-attributes'),
            'urn:omni:params:1.0:UserAttribute': { department: {} },
          }],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
        },
      ] : []),
    ];
    mockCollectionResponses(t, kind, invalidResponses);

    for (const payload of invalidResponses) {
      void payload;
      await rejectsWithoutRawValues(
        collectionContracts[kind].listAll(BASE_URL, API_KEY),
        kind,
      );
    }
  });

  test(`${kind} collection advances by verified page evidence and completes exactly`, async (t) => {
    mockCollectionResponses(t, kind, [
      {
        Resources: [scimRecord(kind, `${kind}-1`)],
        totalResults: 3,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        Resources: [scimRecord(kind, `${kind}-2`), scimRecord(kind, `${kind}-3`)],
        totalResults: 3,
        startIndex: 2,
        itemsPerPage: 2,
      },
    ], [1, 2]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY, {
      pageSize: 3,
      maxPages: 2,
    });

    assert.deepEqual(result.Resources?.map((resource) => resource.id), [
      `${kind}-1`,
      `${kind}-2`,
      `${kind}-3`,
    ]);
    assert.equal(result.totalResults, 3);
    assert.equal(result.loadedResults, 3);
    assert.equal(result.truncated, false);
  });

  test(`${kind} collection reports a page-cap truncation explicitly`, async (t) => {
    mockCollectionResponses(t, kind, [{
      Resources: [scimRecord(kind, `${kind}-1`)],
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 1,
    }], [1]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY, {
      pageSize: 3,
      maxPages: 1,
    });

    assert.equal(result.loadedResults, 1);
    assert.equal(result.totalResults, 3);
    assert.equal(result.truncated, true);
  });

  test(`${kind} collection preserves verified earlier pages when a later page is invalid`, async (t) => {
    mockCollectionResponses(t, kind, [
      {
        Resources: [scimRecord(kind, `${kind}-1`)],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        totalResults: 2,
        startIndex: 2,
        itemsPerPage: 1,
        diagnostic: PRIVATE_MARKER,
      },
    ], [1, 2]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY, {
      pageSize: 2,
      maxPages: 2,
    });

    assert.deepEqual(result.Resources?.map((resource) => resource.id), [`${kind}-1`]);
    assert.equal(result.totalResults, 2);
    assert.equal(result.loadedResults, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.error, 'partial_collection_read_failed');
    assert.equal(result.validationReasonCode, `SCIM_${kind.toUpperCase()}_LIST_RESOURCES_NOT_ARRAY`);
    assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER), false);
  });

  test(`${kind} collection rejects repeated records or changing totals across pages`, async (t) => {
    mockCollectionResponses(t, kind, [
      {
        Resources: [scimRecord(kind, `${kind}-1`), scimRecord(kind, `${kind}-2`)],
        totalResults: 4,
        startIndex: 1,
        itemsPerPage: 2,
      },
      {
        Resources: [scimRecord(kind, `${kind}-2`), scimRecord(kind, `${kind}-3`)],
        totalResults: 4,
        startIndex: 3,
        itemsPerPage: 2,
      },
    ], [1, 3]);

    await rejectsWithoutRawValues(
      collectionContracts[kind].listAll(BASE_URL, API_KEY, { pageSize: 2, maxPages: 2 }),
      kind,
    );
  });
}

test('filtered user lookup requires an exact normalized identity match', async (t) => {
  const responses = [
    {
      Resources: [{ id: 'user-incomplete', userName: 'person@example.invalid' }],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 1,
    },
    {
      Resources: [{ id: 'user-wrong', userName: 'different@example.invalid' }],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    },
    {
      Resources: [{ id: 'user-exact', userName: 'Person@Example.Invalid' }],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), '/api/manage-users');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.action, 'find');
    return json(responses[responseIndex++]);
  });

  await assert.rejects(
    findUserByEmail(BASE_URL, API_KEY, 'person@example.invalid'),
    /invalid SCIM user list response/i,
  );
  await assert.rejects(
    findUserByEmail(BASE_URL, API_KEY, 'person@example.invalid'),
    /invalid SCIM user list response/i,
  );
  const exact = await findUserByEmail(BASE_URL, API_KEY, ' person@example.invalid ');
  assert.equal(exact.Resources?.[0]?.id, 'user-exact');
  assert.equal(responseIndex, 3);
});

test('group detail rejects mismatched identity and malformed membership records', async (t) => {
  const responses = [
    { id: 'different-group', displayName: 'Different', members: [] },
    { id: 'group-1', displayName: 'Group 1', members: [{}] },
    { id: 'group-1', displayName: 'Group 1', members: [{ value: 'user-1', display: 'person@example.invalid' }] },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => json(responses[responseIndex++]));

  await assert.rejects(getGroup(BASE_URL, API_KEY, 'group-1'), /invalid SCIM group list response/i);
  await assert.rejects(getGroup(BASE_URL, API_KEY, 'group-1'), /invalid SCIM group list response/i);
  const group = await getGroup(BASE_URL, API_KEY, 'group-1');
  assert.equal(group.members?.[0]?.value, 'user-1');
  assert.equal(responseIndex, 3);
});

test('changing totals across pages fail instead of completing a mixed snapshot', async (t) => {
  mockCollectionResponses(t, 'user', [
    {
      Resources: [scimRecord('user', 'user-1'), scimRecord('user', 'user-2')],
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 2,
    },
    {
      Resources: [scimRecord('user', 'user-3'), scimRecord('user', 'user-4')],
      totalResults: 4,
      startIndex: 3,
      itemsPerPage: 2,
    },
  ], [1, 3]);

  await rejectsWithoutRawValues(
    listAllUsers(BASE_URL, API_KEY, { pageSize: 2, maxPages: 2 }),
    'user',
  );
});

test('invalid local pagination options fail before any request', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return json({});
  });

  await assert.rejects(
    listAllGroups(BASE_URL, API_KEY, { pageSize: 0, maxPages: 1 }),
    /Invalid SCIM pagination configuration/,
  );
  await assert.rejects(
    listAllUsers(BASE_URL, API_KEY, { pageSize: 100, maxPages: 0 }),
    /Invalid SCIM pagination configuration/,
  );
  assert.equal(fetchCount, 0);
});

test('identity handlers encode opaque path IDs and never forward upstream error bodies', async (t) => {
  const requestedUrls: string[] = [];
  let responseIndex = 0;
  const privateUpstreamBody = `private-person@example.invalid ${PRIVATE_MARKER}`;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    responseIndex += 1;
    if (responseIndex <= 2) return new Response(null, { status: 204 });
    return new Response(privateUpstreamBody, {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });
  });

  const userId = 'user/../private?role=admin#fragment';
  const groupId = 'group/../private?role=admin#fragment';
  const updatedUser = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'update',
    user_id: userId,
    user_data: { displayName: 'Safe name' },
  }));
  const updatedGroup = await manageGroupsHandler(identityHandlerRequest('manage-groups', {
    action: 'patch',
    group_id: groupId,
    group_data: { Operations: [] },
  }));
  const failedUsers = await manageUsersHandler(identityHandlerRequest('manage-users', { action: 'list' }));
  const failedGroups = await manageGroupsHandler(identityHandlerRequest('manage-groups', { action: 'list' }));

  assert.equal(updatedUser.status, 200);
  assert.equal(updatedGroup.status, 200);
  assert.match(requestedUrls[0], /\/api\/scim\/v2\/users\/user%2F\.\.%2Fprivate%3Frole%3Dadmin%23fragment$/);
  assert.match(requestedUrls[1], /\/api\/scim\/v2\/groups\/group%2F\.\.%2Fprivate%3Frole%3Dadmin%23fragment$/);

  for (const response of [failedUsers, failedGroups]) {
    assert.equal(response.status, 403);
    const serialized = await response.text();
    assert.doesNotMatch(serialized, /private-person@example\.invalid/i);
    assert.doesNotMatch(serialized, new RegExp(PRIVATE_MARKER, 'i'));
    assert.doesNotMatch(serialized, /private-api-key-marker/i);
    assert.match(serialized, /failed with HTTP 403/i);
  }
  assert.equal(responseIndex, 4);
});

const ROLE_USER_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_MODEL_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';

test('user model-role handler performs a strictly scoped and sanitized list read', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const response = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'list_model_roles',
    user_id: ROLE_USER_ID,
    model_id: ROLE_MODEL_ID,
    connection_id: ROLE_CONNECTION_ID,
  }), {
    assertSafeUrl: async () => undefined,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return json({
        membershipId: ROLE_MEMBERSHIP_ID,
        privateMetadata: PRIVATE_MARKER,
        results: [{
          roleName: 'QUERIER',
          baseRole: 'VIEWER',
          modelId: ROLE_MODEL_ID,
          connectionId: ROLE_CONNECTION_ID,
          priority: 20,
          resolved: true,
          from: { type: 'User Role', name: PRIVATE_MARKER, miniUuid: PRIVATE_MARKER },
        }],
      });
    },
  });

  assert.equal(response.status, 200);
  const url = new URL(requestedUrl);
  assert.equal(url.pathname, `/api/v1/users/${ROLE_USER_ID}/model-roles`);
  assert.equal(url.searchParams.get('modelId'), ROLE_MODEL_ID);
  assert.equal(url.searchParams.get('connectionId'), ROLE_CONNECTION_ID);
  assert.equal(requestedInit?.method, 'GET');
  assert.equal(requestedInit?.redirect, 'manual');
  assert.ok(requestedInit?.signal instanceof AbortSignal);
  const payload = await response.json();
  assert.deepEqual(payload, {
    membershipId: ROLE_MEMBERSHIP_ID,
    results: [{
      roleName: 'QUERIER',
      baseRole: 'VIEWER',
      modelId: ROLE_MODEL_ID,
      connectionId: ROLE_CONNECTION_ID,
      priority: 20,
      resolved: true,
      from: { type: 'User Role' },
    }],
  });
  assert.equal(JSON.stringify(payload).includes(PRIVATE_MARKER), false);
});

test('user model-role handler never reflects malformed upstream field values in diagnostics', async () => {
  const response = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'list_model_roles',
    user_id: ROLE_USER_ID,
    model_id: ROLE_MODEL_ID,
    connection_id: ROLE_CONNECTION_ID,
  }), {
    assertSafeUrl: async () => undefined,
    fetchImpl: async () => json({
      membershipId: ROLE_MEMBERSHIP_ID,
      results: [{
        roleName: `token=${PRIVATE_MARKER}`,
        baseRole: 'VIEWER',
        modelId: ROLE_MODEL_ID,
        connectionId: ROLE_CONNECTION_ID,
        priority: 20,
        resolved: true,
        from: { type: 'User Role' },
      }],
    }),
  });

  assert.equal(response.status, 502);
  const serialized = await response.text();
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_MARKER, 'i'));
  assert.match(serialized, /invalid_fields=roleName/);
  assert.match(serialized, /INVALID_MODEL_ROLE_RESPONSE/);
});

test('user model-role handler validates assignment scope and verifies CONNECTION_ADMIN by exact post-read', async () => {
  const calls: Array<{ url: URL; method: string; body?: unknown }> = [];
  const response = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'assign_model_role',
    user_id: ROLE_USER_ID,
    role_name: 'CONNECTION_ADMIN',
    connection_id: ROLE_CONNECTION_ID,
  }), {
    assertSafeUrl: async () => undefined,
    fetchImpl: async (input, init) => {
      calls.push({
        url: new URL(String(input)),
        method: String(init?.method),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (init?.method === 'POST') {
        return json({
          userId: ROLE_USER_ID,
          roleName: 'CONNECTION_ADMIN',
          modelId: ROLE_MODEL_ID,
          connectionId: ROLE_CONNECTION_ID,
          untrusted: PRIVATE_MARKER,
        });
      }
      return json({
        membershipId: ROLE_MEMBERSHIP_ID,
        results: [
          {
            roleName: 'CONNECTION_ADMIN',
            baseRole: 'CONNECTION_ADMIN',
            modelId: ROLE_MODEL_ID,
            connectionId: ROLE_CONNECTION_ID,
            priority: 100,
            resolved: true,
            from: { type: 'GROUP' },
          },
          {
            roleName: 'CONNECTION_ADMIN',
            baseRole: 'CONNECTION_ADMIN',
            modelId: ROLE_MODEL_ID,
            connectionId: ROLE_CONNECTION_ID,
            priority: 90,
            resolved: false,
            from: { type: 'User Role' },
          },
        ],
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
  assert.equal(calls[0].url.pathname, `/api/v1/users/${ROLE_USER_ID}/model-roles`);
  assert.equal(calls[0].url.searchParams.has('connectionId'), false);
  assert.equal(calls[0].url.searchParams.has('modelId'), false);
  assert.equal(calls[1].url.searchParams.get('connectionId'), ROLE_CONNECTION_ID);
  assert.equal(calls[1].url.searchParams.get('modelId'), ROLE_MODEL_ID);
  assert.deepEqual(calls[0].body, {
    roleName: 'CONNECTION_ADMIN',
    connectionId: ROLE_CONNECTION_ID,
  });
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.deepEqual(payload.assignment, {
    userId: ROLE_USER_ID,
    roleName: 'CONNECTION_ADMIN',
    modelId: ROLE_MODEL_ID,
    connectionId: ROLE_CONNECTION_ID,
  });
  assert.equal(payload.role.roleName, 'CONNECTION_ADMIN');
  assert.equal(JSON.stringify(payload).includes(PRIVATE_MARKER), false);

  let outboundCalls = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: async () => {
      outboundCalls += 1;
      return json({ results: [] });
    },
  };
  for (const body of [
    { action: 'list_model_roles', user_id: 'not/a/valid-id', model_id: ROLE_MODEL_ID },
    { action: 'assign_model_role', user_id: ROLE_USER_ID, role_name: 'QUERIER', connection_id: ROLE_CONNECTION_ID },
    { action: 'assign_model_role', user_id: ROLE_USER_ID, role_name: 'CONNECTION_ADMIN', model_id: ROLE_MODEL_ID },
    { action: 'assign_model_role', user_id: ROLE_USER_ID, role_name: 'ADMIN', model_id: ROLE_MODEL_ID },
  ]) {
    const rejected = await manageUsersHandler(identityHandlerRequest('manage-users', body), dependencies);
    assert.equal(rejected.status, 400);
  }
  assert.equal(outboundCalls, 0);
});

test('user model-role handler posts once and retries only scoped reads until the direct role is visible', async () => {
  const calls: Array<{ url: URL; method: string; body?: unknown }> = [];
  let verificationReads = 0;
  const response = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'assign_model_role',
    user_id: ROLE_USER_ID,
    role_name: 'QUERY_TOPICS',
    model_id: ROLE_MODEL_ID,
    connection_id: ROLE_CONNECTION_ID,
  }), {
    assertSafeUrl: async () => undefined,
    verificationDelaysMs: [0, 0],
    fetchImpl: async (input, init) => {
      calls.push({
        url: new URL(String(input)),
        method: String(init?.method),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (init?.method === 'POST') {
        return json({
          userId: ROLE_USER_ID,
          roleName: 'QUERY_TOPICS',
          modelId: ROLE_MODEL_ID,
          connectionId: ROLE_CONNECTION_ID,
        });
      }
      verificationReads += 1;
      return json({
        membershipId: ROLE_MEMBERSHIP_ID,
        results: verificationReads === 1
          ? [{
              roleName: 'QUERY_TOPICS',
              baseRole: 'QUERY_TOPICS',
              modelId: ROLE_MODEL_ID,
              connectionId: ROLE_CONNECTION_ID,
              priority: 250,
              resolved: true,
              from: { type: 'Group Role' },
            }]
          : [{
              roleName: 'QUERY_TOPICS',
              baseRole: 'QUERY_TOPICS',
              modelId: ROLE_MODEL_ID,
              connectionId: ROLE_CONNECTION_ID,
              priority: 350,
              resolved: true,
              from: { type: 'User Role' },
            }],
      });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET']);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(calls[0].body, {
    roleName: 'QUERY_TOPICS',
    modelId: ROLE_MODEL_ID,
    connectionId: ROLE_CONNECTION_ID,
  });
  for (const call of calls.filter((entry) => entry.method === 'GET')) {
    assert.equal(call.url.searchParams.get('modelId'), ROLE_MODEL_ID);
    assert.equal(call.url.searchParams.get('connectionId'), ROLE_CONNECTION_ID);
  }
  const payload = await response.json();
  assert.equal(payload.membershipId, ROLE_MEMBERSHIP_ID);
  assert.equal(payload.verified, true);
  assert.equal(payload.role.roleName, 'QUERY_TOPICS');
  assert.equal(payload.role.from.type, 'User Role');
});

test('user model-role handler bounds retryable verification failures without replaying the successful post', async () => {
  const methods: string[] = [];
  const response = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'assign_model_role',
    user_id: ROLE_USER_ID,
    role_name: 'QUERY_TOPICS',
    model_id: ROLE_MODEL_ID,
    connection_id: ROLE_CONNECTION_ID,
  }), {
    assertSafeUrl: async () => undefined,
    verificationDelaysMs: [0, 0, 0],
    fetchImpl: async (_input, init) => {
      methods.push(String(init?.method));
      if (init?.method === 'POST') {
        return json({
          userId: ROLE_USER_ID,
          roleName: 'QUERY_TOPICS',
          modelId: ROLE_MODEL_ID,
          connectionId: ROLE_CONNECTION_ID,
        });
      }
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(response.status, 502);
  assert.deepEqual(methods, ['POST', 'GET', 'GET', 'GET']);
  assert.equal(methods.filter((method) => method === 'POST').length, 1);
  assert.deepEqual(await response.json(), {
    error: 'Omni did not verify the requested user model-role assignment.',
    code: 'MODEL_ROLE_ASSIGNMENT_NOT_VERIFIED',
  });
});

test('user model-role browser helpers preserve scope, cancellation, and validated assignment results', async (t) => {
  const requests: Array<{ body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), '/api/manage-users');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ body, signal: init?.signal });
    if (body.action === 'list_model_roles') {
      return json({
        membershipId: ROLE_MEMBERSHIP_ID,
        results: [{
          roleName: 'QUERIER',
          baseRole: 'QUERIER',
          modelId: ROLE_MODEL_ID,
          connectionId: ROLE_CONNECTION_ID,
          priority: 20,
          resolved: true,
          from: { type: 'User Role' },
        }],
      });
    }
    return json({
      membershipId: ROLE_MEMBERSHIP_ID,
      verified: true,
      assignment: {
        userId: ROLE_USER_ID,
        roleName: 'MODELER',
        modelId: ROLE_MODEL_ID,
        connectionId: ROLE_CONNECTION_ID,
      },
      role: {
        roleName: 'MODELER',
        baseRole: 'MODELER',
        modelId: ROLE_MODEL_ID,
        connectionId: ROLE_CONNECTION_ID,
        priority: 30,
        resolved: true,
        from: { type: 'User Role' },
      },
      results: [{
        roleName: 'MODELER',
        baseRole: 'MODELER',
        modelId: ROLE_MODEL_ID,
        connectionId: ROLE_CONNECTION_ID,
        priority: 30,
        resolved: true,
        from: { type: 'User Role' },
      }],
    });
  });

  const controller = new AbortController();
  const listed = await listUserModelRoles(BASE_URL, API_KEY, ROLE_USER_ID, {
    modelId: ROLE_MODEL_ID,
    connectionId: ROLE_CONNECTION_ID,
    signal: controller.signal,
  });
  const assigned = await assignUserModelRole(BASE_URL, API_KEY, ROLE_USER_ID, {
    roleName: 'MODELER',
    modelId: ROLE_MODEL_ID,
    connectionId: ROLE_CONNECTION_ID,
  }, { signal: controller.signal });

  assert.equal(listed.results[0]?.roleName, 'QUERIER');
  assert.equal(listed.membershipId, ROLE_MEMBERSHIP_ID);
  assert.equal(assigned.verified, true);
  assert.equal(assigned.membershipId, ROLE_MEMBERSHIP_ID);
  assert.equal(assigned.role.roleName, 'MODELER');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.action, 'list_model_roles');
  assert.equal(requests[1].body.action, 'assign_model_role');
  assert.equal(requests[1].body.role_name, 'MODELER');
  assert.equal(requests[0].signal, controller.signal);
  assert.equal(requests[1].signal, controller.signal);
});

function accessEvidenceReader(
  overrides: Partial<IdentityAccessEvidenceReader> = {},
): IdentityAccessEvidenceReader {
  return {
    listIdentityUsers: async () => [],
    listUserGroups: async () => [],
    getUserGroup: async (groupId) => ({ id: groupId, displayName: groupId, members: [] }),
    listUserModelRoles: async () => [],
    listUserGroupModelRoles: async () => [],
    listDocumentAccessInventory: async () => ({
      principals: [],
      pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 0, reportedTotalRecords: 0 },
    }),
    ...overrides,
  };
}

const ACCESS_EVIDENCE_INSTANCE: SavedInstance = {
  id: 'instance-1',
  label: 'Vault-selected tenant',
  role: 'both',
  baseUrl: 'https://vault-selected.example.invalid',
  apiKey: 'vault-selected-private-key',
  metricFilter: {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  },
  postMigrationActions: [],
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
};

test('access evidence SCIM reader preserves an omitted lifecycle state as unknown', async () => {
  const users = await listIdentityAccessUsers(async (count, startIndex) => ({
    Resources: [{ id: 'user-unknown', userName: 'unknown@example.invalid' }],
    totalResults: 1,
    itemsPerPage: 1,
    startIndex,
    requestedCount: count,
  }));

  assert.equal(users.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(users[0], 'active'), false);

  const report = await buildIdentityAccessEvidence({
    instanceId: 'instance-1',
    instanceLabel: 'Selected tenant',
    principalType: 'user',
    principalIdentifier: 'unknown@example.invalid',
    expectedAccess: { active: true },
  }, accessEvidenceReader({ listIdentityUsers: async () => users }));

  assert.equal(report.lifecycle.state, 'unknown');
  assert.equal(Object.prototype.hasOwnProperty.call(report.principal, 'active'), false);
  assert.equal(report.findings.find((finding) => finding.label === 'Standard-user lifecycle state was not returned')?.classification, 'unverified');
  assert.equal(report.findings.find((finding) => finding.label === 'Expected lifecycle cannot be compared')?.classification, 'unverified');
});

test('access evidence correlates inactive-user offboarding exposure without promoting it to runtime proof', async () => {
  const report = await buildIdentityAccessEvidence({
    instanceId: 'instance-1',
    instanceLabel: 'Selected tenant',
    principalType: 'user',
    principalIdentifier: 'analyst@example.invalid',
    connectionId: 'connection-1',
    modelId: 'model-1',
    folderId: 'Shared/Finance',
    documentId: 'document-1',
    expectedAccess: { active: false, modelRole: 'QUERIER', contentRole: 'MANAGER' },
  }, accessEvidenceReader({
    listIdentityUsers: async () => [{
      id: 'user-1',
      displayName: 'Finance Analyst',
      userName: 'analyst@example.invalid',
      email: 'analyst@example.invalid',
      active: false,
      lastLogin: '2026-08-20T12:00:00.000Z',
    }],
    listUserGroups: async () => [{
      id: 'group-1',
      displayName: 'Finance',
      members: [{ value: 'user-1', display: 'Finance Analyst' }],
    }],
    listUserModelRoles: async () => [{
      roleName: 'QUERIER',
      connectionId: 'connection-1',
      modelId: 'model-1',
      resolved: true,
      from: { type: 'User Role', name: 'Direct querier' },
    }],
    listUserGroupModelRoles: async () => [{
      roleName: 'QUERY_TOPICS',
      connectionId: 'connection-1',
      modelId: 'model-1',
      resolved: true,
      from: { type: 'Group Role', name: 'Finance' },
    }],
    listDocumentAccessInventory: async () => ({
      principals: [{
        id: 'user-1',
        name: 'Finance Analyst',
        email: 'analyst@example.invalid',
        type: 'user',
        role: 'MANAGER',
        accessBoost: false,
        accessSource: 'direct',
        isOwner: true,
        folderInfo: { id: 'folder-1', name: 'Finance', path: 'Shared/Finance' },
      }, {
        id: 'group-1',
        name: 'Finance',
        type: 'userGroup',
        role: 'VIEWER',
        accessBoost: false,
        accessSource: 'folder',
        isOwner: false,
        folderInfo: { id: 'folder-1', name: 'Finance', path: 'Shared/Finance' },
      }],
      pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 2, reportedTotalRecords: 2 },
    }),
  }));

  assert.equal(report.lifecycle.state, 'inactive');
  assert.deepEqual(report.lifecycle.offboardingExposure, [
    '2 observed model-role assignments',
    '2 selected-document access entries',
    'selected-document ownership',
  ]);
  assert.equal(report.coverage.find((entry) => entry.source === 'model_roles')?.state, 'complete');
  assert.equal(report.coverage.find((entry) => entry.source === 'document_access')?.state, 'complete');
  assert.equal(report.findings.find((finding) => finding.label === 'Inactive-user offboarding exposure')?.classification, 'inferred');
  assert.equal(report.findings.find((finding) => finding.label === 'Model-role expectation represented')?.classification, 'inferred');
  assert.ok(report.exclusions.some((value) => /not proof of row-level/i.test(value)));

  const parsed = parseIdentityAccessEvidenceReport(report);
  assert.equal(parsed.principal.id, 'user-1');
  const exported = serializeIdentityAccessEvidence({
    ...parsed,
    exclusions: [...parsed.exclusions, 'Authorization: Bearer private-token-marker'],
  });
  assert.doesNotMatch(exported, /analyst@example\.invalid/i);
  assert.doesNotMatch(exported, /private-token-marker/i);
  assert.match(exported, /\[redacted-email\]/);
  assert.match(exported, /Authorization: \[redacted\]/);
});

test('access evidence does not turn failed group detail into a no-access conclusion', async () => {
  const report = await buildIdentityAccessEvidence({
    instanceId: 'instance-1',
    instanceLabel: 'Selected tenant',
    principalType: 'user',
    principalIdentifier: 'user-1',
    documentId: 'document-1',
    expectedAccess: { contentRole: 'VIEWER' },
  }, accessEvidenceReader({
    listIdentityUsers: async () => [{ id: 'user-1', userName: 'analyst@example.invalid', active: true }],
    listUserGroups: async () => [{ id: 'group-unknown', displayName: 'Unknown members' }],
    getUserGroup: async () => { throw new Error('detail unavailable'); },
    listDocumentAccessInventory: async () => ({
      principals: [{
        id: 'group-unknown',
        name: 'Unknown members',
        type: 'userGroup',
        role: 'VIEWER',
        accessBoost: false,
        accessSource: 'direct',
        isOwner: false,
      }],
      pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 1, reportedTotalRecords: 1 },
    }),
  }));

  assert.equal(report.coverage.find((entry) => entry.source === 'group_membership')?.state, 'unavailable');
  assert.equal(report.coverage.find((entry) => entry.source === 'document_access')?.state, 'partial');
  const expectation = report.findings.find((finding) => finding.label === 'Content-role expectation not proven');
  assert.equal(expectation?.classification, 'unverified');
  assert.match(expectation?.message || '', /complete group membership evidence/i);
});

test('access evidence handler exposes only the read-only debug action contract', async () => {
  let capturedInput: Record<string, unknown> | undefined;
  let capturedInstance: SavedInstance | undefined;
  const response = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'debug_access',
    instance_id: 'instance-1',
    instance_label: 'Client-claimed tenant label',
    principal_type: 'user',
    principal_identifier: 'analyst@example.invalid',
    expected_access: { active: false },
  }), {
    getSavedInstance: (instanceId) => instanceId === ACCESS_EVIDENCE_INSTANCE.id ? ACCESS_EVIDENCE_INSTANCE : undefined,
    buildAccessEvidence: async (input, _signal, instance) => {
      capturedInput = input as unknown as Record<string, unknown>;
      capturedInstance = instance;
      return buildIdentityAccessEvidence(input, accessEvidenceReader({
        listIdentityUsers: async () => [{ id: 'user-1', userName: 'analyst@example.invalid', active: false }],
      }));
    },
  });

  assert.equal(response.status, 200);
  assert.equal(capturedInput?.instanceId, ACCESS_EVIDENCE_INSTANCE.id);
  assert.equal(capturedInput?.instanceLabel, ACCESS_EVIDENCE_INSTANCE.label);
  assert.equal(capturedInstance?.baseUrl, ACCESS_EVIDENCE_INSTANCE.baseUrl);
  assert.equal(capturedInstance?.apiKey, ACCESS_EVIDENCE_INSTANCE.apiKey);
  assert.notEqual(capturedInstance?.baseUrl, 'https://example.omniapp.co');
  assert.notEqual(capturedInstance?.apiKey, 'private-api-key-marker');
  assert.equal(capturedInput?.principalIdentifier, 'analyst@example.invalid');
  assert.deepEqual(capturedInput?.expectedAccess, { active: false });
  const payload = await response.json();
  assert.equal(payload.schemaVersion, 'omnikit.identity-access-evidence.v1');
  assert.deepEqual(payload.instance, { id: ACCESS_EVIDENCE_INSTANCE.id, label: ACCESS_EVIDENCE_INSTANCE.label });
  assert.equal(JSON.stringify(payload).includes('Client-claimed tenant label'), false);
  assert.equal(JSON.stringify(payload).includes('private-api-key-marker'), false);

  const malformed = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'debug_access',
    instance_id: 'instance-1',
    instance_label: 'Client-claimed tenant label',
    principal_type: 'user',
    principal_identifier: 'analyst@example.invalid',
    expected_access: 'active',
  }), {
    getSavedInstance: () => ACCESS_EVIDENCE_INSTANCE,
    buildAccessEvidence: async () => { throw new Error('must not run'); },
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Expected access must be an object.', code: 'INVALID_INPUT' });

  const missing = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'debug_access',
    instance_id: 'missing-instance',
    principal_type: 'user',
    principal_identifier: 'analyst@example.invalid',
  }), { getSavedInstance: () => undefined });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Saved Omni instance not found.', code: 'SAVED_INSTANCE_NOT_FOUND' });
});

test('access evidence browser request sends only the saved instance reference and scoped operator inputs', async (t) => {
  const report = await buildIdentityAccessEvidence({
    instanceId: ACCESS_EVIDENCE_INSTANCE.id,
    instanceLabel: ACCESS_EVIDENCE_INSTANCE.label,
    principalType: 'user',
    principalIdentifier: 'analyst@example.invalid',
  }, accessEvidenceReader({
    listIdentityUsers: async () => [{ id: 'user-1', userName: 'analyst@example.invalid', active: true }],
  }));
  let requestBody: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), '/api/manage-users');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return json(report);
  });

  const result = await fetchIdentityAccessEvidence({
    instanceId: ACCESS_EVIDENCE_INSTANCE.id,
    principalType: 'user',
    principalIdentifier: 'analyst@example.invalid',
    modelId: 'model-1',
  });

  assert.equal(result.instance.label, ACCESS_EVIDENCE_INSTANCE.label);
  assert.deepEqual(requestBody, {
    action: 'debug_access',
    instance_id: ACCESS_EVIDENCE_INSTANCE.id,
    principal_type: 'user',
    principal_identifier: 'analyst@example.invalid',
    model_id: 'model-1',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'base_url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'api_key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'instance_label'), false);
});

// Compile-time guard: aggregated list reads retain their documented response type.
const _responseContract: ScimListResponse = {
  Resources: [],
  totalResults: 0,
  startIndex: 1,
  itemsPerPage: 0,
  loadedResults: 0,
  truncated: false,
};
void _responseContract;
