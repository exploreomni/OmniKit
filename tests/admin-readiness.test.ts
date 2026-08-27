import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import handler from '../server/handlers/admin-readiness';
import {
  clearAdminReadinessCacheForTests,
  getAdminReadinessReport,
  type AdminReadinessInput,
} from '../server/services/adminReadiness';
import { resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';

const testRoot = mkdtempSync(join(tmpdir(), 'omnikit-admin-readiness-'));
const originalFetch = globalThis.fetch;
process.env.OMNIKIT_VAULT_PATH = join(testRoot, 'vault.enc');

const instance: AdminReadinessInput['instance'] = {
  id: 'saved-instance',
  baseUrl: 'https://1.1.1.1',
  apiKey: 'readiness-secret-key',
  updatedAt: '2026-08-09T12:00:00.000Z',
  organizationApiKeyConfirmed: true,
};

beforeEach(() => {
  globalThis.fetch = originalFetch;
  clearAdminReadinessCacheForTests();
  resetVault();
});

after(() => {
  globalThis.fetch = originalFetch;
  clearAdminReadinessCacheForTests();
  resetVault();
  rmSync(testRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cursorPage(records: unknown[], totalRecords = records.length, nextCursor: string | null = null) {
  return {
    records,
    pageInfo: {
      hasNextPage: nextCursor !== null,
      nextCursor,
      pageSize: Math.max(1, records.length),
      totalRecords,
    },
  };
}

function scimPage(resources: unknown[], totalResults = resources.length, startIndex = 1) {
  return {
    Resources: resources,
    itemsPerPage: resources.length,
    startIndex,
    totalResults,
  };
}

test('fleet readiness returns aggregate-only folder, token, and current-caller evidence using GET', async () => {
  const calls: Array<{ url: URL; method: string }> = [];
  const report = await getAdminReadinessReport({ instance, workspace: 'fleet' }, {
    assertSafeUrl: async () => undefined,
    now: () => new Date('2026-08-09T12:30:00.000Z'),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, method: String(init?.method) });
      if (url.pathname === '/api/v1/folders') {
        return response(cursorPage([{
          id: 'folder-secret-id',
          name: 'Sensitive folder name',
          url: 'https://signed.example/folder?signature=secret',
        }], 14));
      }
      if (url.pathname === '/api/v1/api-keys' && !url.searchParams.has('cursor')) {
        return response(cursorPage([
          { id: 'token-id-1', name: 'Production credential', type: 'organization', enabled: true },
          { id: 'token-id-2', name: 'Operator PAT', type: 'personal', enabled: false },
        ], 3, 'next-token-cursor'));
      }
      if (url.pathname === '/api/v1/whoami') {
        return response({
          keyScope: 'organization',
          orgRole: 'ORG_ADMIN',
          user: {
            id: 'private-caller-user-id',
            membershipId: 'private-caller-membership-id',
          },
          rolesByModel: {
            'private-finance-model-id': {
              roleName: 'Private Finance Modeler',
              baseRole: 'MODELER',
              connectionId: 'private-warehouse-connection-id',
              permissions: ['QUERY_TOPICS', 'VIEW_SQL'],
            },
            'private-sales-model-id': {
              roleName: 'Private Sales Querier',
              baseRole: 'QUERIER',
              connectionId: 'private-sales-connection-id',
              permissions: ['QUERY_TOPICS'],
            },
          },
          rolesByModelTruncated: false,
        });
      }
      return response(cursorPage([
        { id: 'token-id-3', name: 'MCP OAuth grant', type: 'mcp', enabled: true },
      ], 3));
    }) as typeof fetch,
  });

  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.method === 'GET'));
  const folder = report.capabilities.find((entry) => entry.id === 'fleet.folder_read');
  assert.deepEqual(folder?.data, { readable: true, visibleFoldersLowerBound: 1 });
  assert.equal(folder?.coverage.complete, false);
  const tokens = report.capabilities.find((entry) => entry.id === 'fleet.api_tokens');
  assert.deepEqual(tokens?.data, {
    total: 3,
    organization: 1,
    personal: 1,
    mcp: 1,
    other: 0,
    enabled: 2,
    disabled: 1,
  });
  assert.equal(tokens?.evidenceState, 'available');
  assert.equal(report.capabilities.find((entry) => entry.id === 'fleet.organization_api_key_confirmation')?.source.kind, 'operator_confirmation');
  const currentCaller = report.capabilities.find((entry) => entry.id === 'fleet.current_token_introspection');
  assert.equal(currentCaller?.evidenceState, 'available');
  assert.equal(currentCaller?.source.path, '/api/v1/whoami');
  assert.deepEqual(currentCaller?.data, {
    keyScope: 'organization',
    orgRole: 'ORG_ADMIN',
    returnedModelCount: 2,
    returnedPermissionCount: 3,
    rolesByModelTruncated: false,
  });
  assert.deepEqual(currentCaller?.coverage, {
    included: 2,
    total: 2,
    complete: true,
    unit: 'model_permission_sets',
  });

  const serialized = JSON.stringify(report);
  for (const prohibited of [
    instance.apiKey,
    instance.baseUrl,
    'folder-secret-id',
    'Sensitive folder name',
    'signature=secret',
    'token-id-1',
    'Production credential',
    'Operator PAT',
    'MCP OAuth grant',
    'private-caller-user-id',
    'private-caller-membership-id',
    'private-finance-model-id',
    'Private Finance Modeler',
    'private-warehouse-connection-id',
    'private-sales-model-id',
    'Private Sales Querier',
    'private-sales-connection-id',
    'QUERY_TOPICS',
    'VIEW_SQL',
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test('fleet current-caller evidence fails closed on malformed private permission rows', async () => {
  const privateMarker = 'private-caller-contract-marker';
  const report = await getAdminReadinessReport({ instance, workspace: 'fleet' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/folders') return response(cursorPage([], 0));
      if (url.pathname === '/api/v1/api-keys') return response(cursorPage([], 0));
      return response({
        keyScope: 'user',
        orgRole: 'MEMBER',
        user: { id: privateMarker, membershipId: 'membership-private' },
        rolesByModel: {
          'model-private': { permissions: [privateMarker, 42] },
        },
        rolesByModelTruncated: false,
      });
    }) as typeof fetch,
  });

  const currentCaller = report.capabilities.find((entry) => entry.id === 'fleet.current_token_introspection');
  assert.equal(currentCaller?.evidenceState, 'failed');
  assert.equal(currentCaller?.reason.code, 'invalid_response_shape');
  assert.equal(currentCaller?.data, undefined);
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
});

test('identity readiness completes SCIM pagination, strips attribute values, and returns sanitized exact role provenance', async () => {
  const methods: string[] = [];
  const paths: string[] = [];
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(String(init?.method));
      paths.push(url.pathname);
      if (url.pathname === '/api/scim/v2/users') {
        const startIndex = Number(url.searchParams.get('startIndex'));
        return startIndex === 1
          ? response(scimPage([{ id: 'user-1', userName: 'private@example.com', active: true }], 2, 1))
          : response(scimPage([{ id: 'user-2', userName: 'other@example.com', active: false }], 2, 2));
      }
      if (url.pathname === '/api/scim/v2/groups') {
        return response(scimPage([{ id: 'group-1', displayName: 'Private group' }], 1, 1));
      }
      if (url.pathname === '/api/v1/user-attributes') {
        return response({
          records: [{
            id: 'attribute-id',
            name: 'region_access',
            label: 'Region access',
            type: 'String',
            multiple_values: true,
            default_value: 'super-secret-default',
            description: 'Sensitive access design text',
            system: false,
          }],
        });
      }
      if (url.pathname === '/api/v1/users/principal-user-id/model-roles') {
        return response({
          membershipId: 'membership-secret',
          results: [{
            baseRole: 'QUERIER',
            roleName: 'MODELER',
            connectionId: 'connection-1',
            modelId: 'model-1',
            priority: 250,
            resolved: true,
            from: { type: 'Group Role', name: 'Analysts', miniUuid: 'hidden-group-id', depth: 1 },
          }],
        });
      }
      return response({}, 404);
    }) as typeof fetch,
  };
  const report = await getAdminReadinessReport({ instance, workspace: 'identity' }, dependencies);

  assert.ok(methods.every((method) => method === 'GET'));
  assert.deepEqual(report.capabilities.find((entry) => entry.id === 'identity.scim_users')?.data, {
    total: 2,
    active: 1,
    inactive: 1,
    statusUnknown: 0,
  });
  assert.deepEqual(report.capabilities.find((entry) => entry.id === 'identity.scim_groups')?.data, { total: 1 });
  assert.deepEqual(report.capabilities.find((entry) => entry.id === 'identity.user_attributes')?.data, [{
    name: 'region_access',
    label: 'Region access',
    type: 'String',
    multiple: true,
    system: false,
    hasDefault: true,
    hasDescription: true,
  }]);
  const callsBeforePosture = paths.length;
  const postureReport = await getAdminReadinessReport({
    instance,
    workspace: 'identity',
    accessPosture: {
      principalType: 'user',
      principalId: 'principal-user-id',
      modelId: 'model-1',
    },
  }, dependencies);
  assert.deepEqual(paths.slice(callsBeforePosture), ['/api/v1/users/principal-user-id/model-roles']);
  assert.deepEqual(postureReport.capabilities, []);
  assert.deepEqual(postureReport.accessPosture?.requestScope, {
    principalId: 'principal-user-id',
    modelId: 'model-1',
  });
  assert.deepEqual(postureReport.accessPosture?.roles, [{
    baseRole: 'QUERIER',
    roleName: 'MODELER',
    connectionId: 'connection-1',
    modelId: 'model-1',
    priority: 250,
    resolved: true,
    provenance: { type: 'Group Role', name: 'Analysts', depth: 1 },
  }]);
  assert.equal(postureReport.accessPosture?.source.path, '/api/v1/users/:userId/model-roles');

  const serialized = JSON.stringify({ report, postureReport });
  for (const prohibited of [
    'private@example.com',
    'other@example.com',
    'attribute-id',
    'super-secret-default',
    'Sensitive access design text',
    'membership-secret',
    'hidden-group-id',
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test('access posture rejects hostile role and provenance strings and marks the result partial', async () => {
  const paths: string[] = [];
  const report = await getAdminReadinessReport({
    instance,
    workspace: 'identity',
    accessPosture: { principalType: 'user', principalId: 'principal-2' },
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(`${String(init?.method)} ${url.pathname}`);
      return response({
        membershipId: 'not-returned',
        results: [
          {
            baseRole: 'QUERIER',
            roleName: 'MODELER',
            connectionId: 'connection-safe',
            modelId: 'model-safe',
            from: { type: 'Group Role', name: 'Safe Analysts', depth: 1 },
          },
          { roleName: 'leak@example.com' },
          { roleName: 'VIEWER', connectionId: 'https://attacker.example/path?token=sneaky' },
          { roleName: 'VIEWER', modelId: 'secret=do-not-return' },
          { roleName: 'VIEWER', from: { type: 'Group Role', name: 'Bearer top-secret-value' } },
        ],
      });
    }) as typeof fetch,
  });

  assert.deepEqual(paths, ['GET /api/v1/users/principal-2/model-roles']);
  assert.deepEqual(report.capabilities, []);
  assert.deepEqual(report.accessPosture?.requestScope, { principalId: 'principal-2' });
  assert.equal(report.accessPosture?.evidenceState, 'partial');
  assert.equal(report.accessPosture?.coverage.included, 1);
  assert.equal(report.accessPosture?.coverage.total, 5);
  assert.deepEqual(report.accessPosture?.roles, [{
    baseRole: 'QUERIER',
    roleName: 'MODELER',
    connectionId: 'connection-safe',
    modelId: 'model-safe',
    provenance: { type: 'Group Role', name: 'Safe Analysts', depth: 1 },
  }]);
  const serialized = JSON.stringify(report);
  for (const prohibited of ['leak@example.com', 'attacker.example', 'sneaky', 'do-not-return', 'top-secret-value']) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test('access posture does not claim assignment provenance when Omni omits it', async () => {
  const report = await getAdminReadinessReport({
    instance,
    workspace: 'identity',
    accessPosture: { principalType: 'group', principalId: 'group-without-provenance' },
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => response({
      results: [{ roleName: 'VIEWER', connectionId: 'connection-1', modelId: 'model-1' }],
    })) as typeof fetch,
  });

  assert.equal(report.accessPosture?.evidenceState, 'available');
  assert.equal(report.accessPosture?.roles[0]?.provenance, undefined);
  assert.equal(
    report.accessPosture?.reason.message,
    'Model-role assignments were returned by the documented role endpoint; assignment provenance was not returned and is not claimed.',
  );
  assert.doesNotMatch(report.accessPosture?.reason.message || '', /direct|inherited|base-role provenance/i);
});

test('access posture rejects non-opaque or secret-bearing request scope before outbound work', async () => {
  let calls = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => {
      calls += 1;
      return response({ results: [] });
    }) as typeof fetch,
  };
  const invalidScopes = [
    { principalType: 'user' as const, principalId: 'person@example.com' },
    { principalType: 'user' as const, principalId: 'Bearer raw-credential-value' },
    { principalType: 'user' as const, principalId: 'user-1', modelId: 'api_key=raw-secret' },
    { principalType: 'group' as const, principalId: 'group-1', connectionId: 'https://tenant.invalid/connection' },
  ];

  for (const accessPosture of invalidScopes) {
    await assert.rejects(
      getAdminReadinessReport({ instance, workspace: 'identity', accessPosture }, dependencies),
      /bounded opaque resource identifiers/,
    );
  }
  assert.equal(calls, 0);
});

test('developer readiness uses the live embed-user docs route and safe API Explorer actions', async () => {
  const report = await getAdminReadinessReport({ instance, workspace: 'developer' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => response(scimPage([], 0, 1))) as typeof fetch,
  });

  const embedUsers = report.capabilities.find((entry) => entry.id === 'developer.embed_users');
  assert.deepEqual(embedUsers?.documentation, [{
    label: 'List embed users',
    url: 'https://docs.omni.co/api/users/list-embed-users',
  }]);
  const explorer = report.capabilities.find((entry) => entry.id === 'developer.api_explorer');
  assert.deepEqual(explorer?.actions, [
    { kind: 'tenant_deep_link', label: 'Open API Explorer', url: 'https://1.1.1.1/api-explorer' },
    { kind: 'documentation', label: 'Review API Explorer documentation', url: 'https://docs.omni.co/api/api-explorer' },
  ]);
});

test('status semantics distinguish 401, 403, collection 404, and resource 404', async () => {
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/scim/v2/users') return response({}, 401);
      if (pathname === '/api/scim/v2/groups') return response({}, 403);
      return response({}, 404);
    }) as typeof fetch,
  };
  const report = await getAdminReadinessReport({ instance, workspace: 'identity' }, dependencies);
  const postureReport = await getAdminReadinessReport({
    instance,
    workspace: 'identity',
    accessPosture: { principalType: 'group', principalId: 'missing-group' },
  }, dependencies);

  const users = report.capabilities.find((entry) => entry.id === 'identity.scim_users');
  const groups = report.capabilities.find((entry) => entry.id === 'identity.scim_groups');
  const attributes = report.capabilities.find((entry) => entry.id === 'identity.user_attributes');
  assert.deepEqual([users?.evidenceState, users?.reason.code], ['unauthorized', 'authentication_required']);
  assert.deepEqual([groups?.evidenceState, groups?.reason.code], ['unauthorized', 'permission_denied']);
  assert.equal(groups?.reason.message, 'Omni denied permission for this documented read; credential type is not inferred.');
  assert.deepEqual([attributes?.evidenceState, attributes?.reason.code], ['unsupported', 'collection_not_found']);
  assert.deepEqual([postureReport.accessPosture?.evidenceState, postureReport.accessPosture?.reason.code], ['unavailable', 'resource_not_found']);
  assert.deepEqual(postureReport.accessPosture?.requestScope, { principalId: 'missing-group' });
});

test('redirects and malformed 2xx payloads never become available or zero-valued evidence', async () => {
  const report = await getAdminReadinessReport({ instance, workspace: 'fleet' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === '/api/v1/folders'
        ? response({}, 302)
        : response({ unexpected: [] }, 200);
    }) as typeof fetch,
  });

  const folder = report.capabilities.find((entry) => entry.id === 'fleet.folder_read');
  const tokens = report.capabilities.find((entry) => entry.id === 'fleet.api_tokens');
  assert.deepEqual([folder?.evidenceState, folder?.reason.code, folder?.data], ['failed', 'unexpected_redirect', undefined]);
  assert.deepEqual([tokens?.evidenceState, tokens?.reason.code, tokens?.data], ['failed', 'invalid_response_shape', undefined]);
});

test('bounded schedule reads preserve successful counts as partial when a later page fails', async () => {
  const calls: URL[] = [];
  const report = await getAdminReadinessReport({ instance, workspace: 'content' }, {
    assertSafeUrl: async () => undefined,
    maxCollectionPages: 2,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      return url.searchParams.get('cursor') === '1'
        ? response(cursorPage([{
            id: 'schedule-1',
            disabledAt: null,
            systemDisabledAt: null,
            lastStatus: 'error',
            lastCompletedAt: '2026-08-08T12:00:00.000Z',
          }], 2, '2'))
        : response({}, 503);
    }) as typeof fetch,
  });

  assert.equal(calls.length, 2);
  const schedules = report.capabilities[0];
  assert.equal(schedules.evidenceState, 'partial');
  assert.equal(schedules.readinessState, 'unknown');
  assert.equal(schedules.coverage.included, 1);
  assert.equal(schedules.coverage.total, 2);
  assert.deepEqual(schedules.data, {
    total: 1,
    active: 1,
    paused: 0,
    systemDisabled: 0,
    lastStatus: { success: 0, error: 1, canceled: 0, none: 0, unknown: 0 },
    latestObservedAt: '2026-08-08T12:00:00.000Z',
  });
});

test('malformed schedule status and timestamp fields are excluded as partial evidence', async () => {
  const report = await getAdminReadinessReport({ instance, workspace: 'content' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => response(cursorPage([
      {
        id: 'schedule-valid',
        disabledAt: null,
        systemDisabledAt: null,
        lastStatus: null,
        lastCompletedAt: null,
      },
      {
        id: 'schedule-bad-status',
        disabledAt: null,
        systemDisabledAt: null,
        lastStatus: 42,
        lastCompletedAt: null,
      },
      {
        id: 'schedule-bad-disabled-time',
        disabledAt: 'not-a-timestamp',
        systemDisabledAt: null,
        lastStatus: 'success',
        lastCompletedAt: null,
      },
      {
        id: 'schedule-bad-completion-time',
        disabledAt: null,
        systemDisabledAt: null,
        lastStatus: 'success',
        lastCompletedAt: 'not-a-timestamp',
      },
    ], 4))) as typeof fetch,
  });

  const schedules = report.capabilities[0];
  assert.equal(schedules.evidenceState, 'partial');
  assert.equal(schedules.readinessState, 'unknown');
  assert.deepEqual(schedules.coverage, { included: 1, total: 4, complete: false, unit: 'records' });
  assert.ok(schedules.exclusions.includes('invalid_records_excluded'));
  assert.deepEqual(schedules.data, {
    total: 1,
    active: 1,
    paused: 0,
    systemDisabled: 0,
    lastStatus: { success: 0, error: 0, canceled: 0, none: 1, unknown: 0 },
    latestObservedAt: null,
  });
});

test('readiness rejects oversized JSON before parsing with and without content-length', async () => {
  const oversizedHeader = await getAdminReadinessReport({ instance, workspace: 'content' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String((2 * 1024 * 1024) + 1) },
    })) as typeof fetch,
  });
  assert.deepEqual(
    [oversizedHeader.capabilities[0].evidenceState, oversizedHeader.capabilities[0].reason.code],
    ['failed', 'invalid_response_shape'],
  );

  clearAdminReadinessCacheForTests();
  const oversizedBody = await getAdminReadinessReport({ instance, workspace: 'content' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => new Response(`{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });
  assert.deepEqual(
    [oversizedBody.capabilities[0].evidenceState, oversizedBody.capabilities[0].reason.code],
    ['failed', 'invalid_response_shape'],
  );
});

test('cursor pagination rejects missing or contradictory pageInfo before counting records', async () => {
  const invalidPages = [
    { records: [], pageInfo: { hasNextPage: false, nextCursor: null, totalRecords: 0 } },
    { records: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 0, totalRecords: 0 } },
    { records: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 101, totalRecords: 0 } },
    { records: [{ id: 'one' }, { id: 'two' }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 2 } },
    { records: [{ id: 'one' }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 0 } },
    { records: [{ id: 'one' }], pageInfo: { hasNextPage: false, nextCursor: 'unexpected', pageSize: 1, totalRecords: 1 } },
    { records: [{ id: 'one' }], pageInfo: { hasNextPage: true, nextCursor: null, pageSize: 1, totalRecords: 2 } },
    { records: [], pageInfo: { hasNextPage: true, nextCursor: 'next', pageSize: 1, totalRecords: 1 } },
    { records: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
  ];

  for (const payload of invalidPages) {
    clearAdminReadinessCacheForTests();
    const report = await getAdminReadinessReport({ instance, workspace: 'content' }, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => response(payload)) as typeof fetch,
    });
    const schedules = report.capabilities[0];
    assert.deepEqual([schedules.evidenceState, schedules.reason.code, schedules.data], [
      'failed',
      'invalid_response_shape',
      undefined,
    ]);
  }
});

test('SCIM pagination rejects count and remaining-total contradictions', async () => {
  const invalidPages = [
    { Resources: [], itemsPerPage: 1, startIndex: 1, totalResults: 0 },
    { Resources: [{ id: 'user-1' }], itemsPerPage: 0, startIndex: 1, totalResults: 1 },
    { Resources: Array.from({ length: 101 }, (_, index) => ({ id: `user-${index + 1}` })), itemsPerPage: 101, startIndex: 1, totalResults: 101 },
    { Resources: [{ id: 'user-1' }], itemsPerPage: 1, startIndex: 0, totalResults: 1 },
    { Resources: [{ id: 'user-2' }, { id: 'user-3' }], itemsPerPage: 2, startIndex: 2, totalResults: 2 },
    { Resources: [], itemsPerPage: 0, startIndex: 1, totalResults: 1 },
  ];

  for (const payload of invalidPages) {
    clearAdminReadinessCacheForTests();
    const report = await getAdminReadinessReport({ instance, workspace: 'developer' }, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => response(payload)) as typeof fetch,
    });
    const embedUsers = report.capabilities.find((entry) => entry.id === 'developer.embed_users');
    assert.deepEqual([embedUsers?.evidenceState, embedUsers?.reason.code, embedUsers?.data], [
      'failed',
      'invalid_response_shape',
      undefined,
    ]);
  }
});

test('direct attribute and model-role arrays are rejected above the fixed cap', async () => {
  const attributes = await getAdminReadinessReport({ instance, workspace: 'identity' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/user-attributes') {
        return response({
          records: Array.from({ length: 1_001 }, (_, index) => ({
            name: `attribute_${index}`,
            multiple_values: false,
            system: false,
          })),
        });
      }
      return response(scimPage([], 0, 1));
    }) as typeof fetch,
  });
  const attributeCapability = attributes.capabilities.find((entry) => entry.id === 'identity.user_attributes');
  assert.deepEqual([attributeCapability?.evidenceState, attributeCapability?.reason.code, attributeCapability?.data], [
    'failed',
    'invalid_response_shape',
    undefined,
  ]);

  clearAdminReadinessCacheForTests();
  const roles = await getAdminReadinessReport({
    instance,
    workspace: 'identity',
    accessPosture: { principalType: 'user', principalId: 'bounded-user' },
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => response({
      results: Array.from({ length: 1_001 }, () => ({ roleName: 'VIEWER' })),
    })) as typeof fetch,
  });
  assert.deepEqual(
    [roles.accessPosture?.evidenceState, roles.accessPosture?.reason.code, roles.accessPosture?.roles],
    ['failed', 'invalid_response_shape', []],
  );
});

test('attribute metadata strings are bounded without exposing oversized values', async () => {
  const report = await getAdminReadinessReport({ instance, workspace: 'identity' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/user-attributes') {
        return response({
          records: [{ name: 'x'.repeat(201), multiple_values: false, system: false }],
        });
      }
      return response(scimPage([], 0, 1));
    }) as typeof fetch,
  });
  const attributes = report.capabilities.find((entry) => entry.id === 'identity.user_attributes');
  assert.equal(attributes?.evidenceState, 'partial');
  assert.deepEqual(attributes?.coverage, { included: 0, total: 1, complete: false, unit: 'attribute_definitions' });
  assert.deepEqual(attributes?.data, []);
  assert.equal(JSON.stringify(report).includes('x'.repeat(201)), false);
});

test('readiness cache prunes expired entries and never exceeds its fixed entry cap', async () => {
  let calls = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    freshCacheMs: 60_000,
    staleCacheMs: 60_000,
    fetchImpl: (async () => {
      calls += 1;
      return response(cursorPage([], 0));
    }) as typeof fetch,
  };
  const scopedInstance = (index: number): AdminReadinessInput['instance'] => ({
    ...instance,
    id: `cache-instance-${index}`,
  });

  for (let index = 0; index < 201; index += 1) {
    await getAdminReadinessReport({ instance: scopedInstance(index), workspace: 'content' }, dependencies);
  }
  assert.equal(calls, 201);
  await getAdminReadinessReport({ instance: scopedInstance(200), workspace: 'content' }, dependencies);
  assert.equal(calls, 201, 'the newest entry remains cached');
  await getAdminReadinessReport({ instance: scopedInstance(0), workspace: 'content' }, dependencies);
  assert.equal(calls, 202, 'the oldest entry was evicted at the fixed cap');

  clearAdminReadinessCacheForTests();
  let nowMs = Date.parse('2026-08-09T12:00:00.000Z');
  const expiringDependencies = {
    ...dependencies,
    now: () => new Date(nowMs),
    freshCacheMs: 1,
    staleCacheMs: 2,
  };
  await getAdminReadinessReport({ instance: scopedInstance(999), workspace: 'content' }, expiringDependencies);
  nowMs += 3;
  await getAdminReadinessReport({ instance: scopedInstance(999), workspace: 'content' }, expiringDependencies);
  assert.equal(calls, 204, 'an entry beyond its stale TTL is pruned and read again');
});

test('concurrent expired-stale callers share the same stale fallback decision', async () => {
  let nowMs = Date.parse('2026-08-09T12:00:00.000Z');
  let calls = 0;
  let available = true;
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const dependencies = {
    assertSafeUrl: async () => undefined,
    now: () => new Date(nowMs),
    freshCacheMs: 10,
    staleCacheMs: 1_000,
    fetchImpl: (async () => {
      calls += 1;
      if (!available) {
        await refreshGate;
        return response({}, 503);
      }
      return response(cursorPage([], 0));
    }) as typeof fetch,
  };

  const original = await getAdminReadinessReport({ instance, workspace: 'content' }, dependencies);
  available = false;
  nowMs += 20;
  const firstRequest = getAdminReadinessReport({ instance, workspace: 'content' }, dependencies);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const concurrentRequest = getAdminReadinessReport({ instance, workspace: 'content' }, dependencies);
  assert.equal(calls, 2);
  releaseRefresh?.();

  const [first, concurrent] = await Promise.all([firstRequest, concurrentRequest]);
  for (const report of [first, concurrent]) {
    assert.equal(report.servedFromCache, true);
    assert.equal(report.checkedAt, original.checkedAt);
    assert.equal(report.capabilities[0].evidenceState, 'stale');
    assert.equal(report.capabilities[0].reason.code, 'cached_refresh_failed');
  }
  assert.deepEqual(first, concurrent);
  assert.equal(calls, 2, 'one refresh decision is shared by all concurrent callers');
});

test('concurrent callers share one live readiness read without claiming a durable cache hit', async () => {
  let calls = 0;
  let releaseFetch: (() => void) | undefined;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const dependencies = {
    assertSafeUrl: async () => undefined,
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    fetchImpl: (async () => {
      calls += 1;
      await fetchGate;
      return response(cursorPage([], 0));
    }) as typeof fetch,
  };

  const firstRequest = getAdminReadinessReport({ instance, workspace: 'content' }, dependencies);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const concurrentRequest = getAdminReadinessReport({ instance, workspace: 'content' }, dependencies);

  assert.equal(calls, 1);
  releaseFetch?.();
  const [first, concurrent] = await Promise.all([firstRequest, concurrentRequest]);
  assert.equal(first.servedFromCache, false);
  assert.equal(concurrent.servedFromCache, false);
  assert.equal(first.checkedAt, concurrent.checkedAt);

  const durableCacheHit = await getAdminReadinessReport({ instance, workspace: 'content' }, dependencies);
  assert.equal(durableCacheHit.servedFromCache, true);
  assert.equal(calls, 1);
});

test('fresh cache is idempotent and failed refreshes preserve original checkedAt as stale evidence', async () => {
  let nowMs = Date.parse('2026-08-09T12:00:00.000Z');
  let available = true;
  let calls = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    now: () => new Date(nowMs),
    freshCacheMs: 10,
    staleCacheMs: 1_000,
    fetchImpl: (async (input: string | URL | Request) => {
      calls += 1;
      if (!available) return response({}, 503);
      const pathname = new URL(String(input)).pathname;
      return pathname === '/api/v1/folders'
        ? response(cursorPage([], 0))
        : response(cursorPage([], 0));
    }) as typeof fetch,
  };

  const first = await getAdminReadinessReport({ instance, workspace: 'fleet' }, dependencies);
  const callsAfterFirst = calls;
  const cached = await getAdminReadinessReport({ instance, workspace: 'fleet' }, dependencies);
  assert.equal(cached.servedFromCache, true);
  assert.equal(calls, callsAfterFirst);

  available = false;
  nowMs += 20;
  const stale = await getAdminReadinessReport({ instance, workspace: 'fleet' }, dependencies);
  assert.equal(stale.servedFromCache, true);
  assert.equal(stale.checkedAt, first.checkedAt);
  assert.equal(stale.capabilities.find((entry) => entry.id === 'fleet.folder_read')?.evidenceState, 'stale');
  assert.equal(stale.capabilities.find((entry) => entry.id === 'fleet.api_tokens')?.reason.code, 'cached_refresh_failed');
});

test('vault-backed handler is GET-only, rejects browser credentials, and never returns saved secrets', async () => {
  const methodResponse = await handler(new Request('http://localhost/api/admin-readiness', { method: 'POST' }));
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('allow'), 'GET');

  const lockedResponse = await handler(new Request('http://localhost/api/admin-readiness?instanceId=missing&workspace=fleet'));
  assert.equal(lockedResponse.status, 423);

  const browserCredentialResponse = await handler(new Request('http://localhost/api/admin-readiness?instanceId=missing&workspace=fleet&api_key=browser-secret'));
  assert.equal(browserCredentialResponse.status, 400);
  assert.equal(JSON.stringify(await browserCredentialResponse.json()).includes('browser-secret'), false);
  const hostileKeyResponse = await handler(new Request('http://localhost/api/admin-readiness?instanceId=missing&workspace=fleet&secret-key-material=secret-value'));
  assert.equal(hostileKeyResponse.status, 400);
  const hostileKeyBody = JSON.stringify(await hostileKeyResponse.json());
  assert.equal(hostileKeyBody.includes('secret-key-material'), false);
  assert.equal(hostileKeyBody.includes('secret-value'), false);

  unlockVault('admin-readiness-test-passphrase');
  const saved = upsertInstance({
    label: 'Readiness test instance',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'saved-handler-secret',
    organizationApiKeyConfirmed: true,
  });
  const calls: Array<{ method: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: String(init?.method),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return url.pathname === '/api/v1/folders'
      ? response(cursorPage([], 0))
      : response(cursorPage([], 0));
  }) as typeof fetch;

  const successful = await handler(new Request(`http://localhost/api/admin-readiness?instanceId=${saved.id}&workspace=fleet`));
  assert.equal(successful.status, 200);
  const report = await successful.json() as Record<string, unknown>;
  assert.equal(report.workspace, 'fleet');
  assert.ok(Array.isArray(report.capabilities));
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(calls.every((call) => call.authorization === 'Bearer saved-handler-secret'));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('saved-handler-secret'), false);
  assert.equal(serialized.includes('https://1.1.1.1'), false);

  const invalidPosture = await handler(new Request(`http://localhost/api/admin-readiness?instanceId=${saved.id}&workspace=fleet&principalType=user&principalId=user-1`));
  assert.equal(invalidPosture.status, 400);
});
