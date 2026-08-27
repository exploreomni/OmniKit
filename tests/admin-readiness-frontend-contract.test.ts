import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fetchAdminReadiness,
  parseAdminReadinessReport,
  type AdminReadinessRequest,
} from '../src/services/adminReadiness';

const CHECKED_AT = '2026-08-09T12:00:00.000Z';
const ORDINARY_IDS = {
  fleet: [
    'fleet.folder_read',
    'fleet.api_tokens',
    'fleet.organization_api_key_confirmation',
    'fleet.current_token_introspection',
  ],
  identity: ['identity.scim_users', 'identity.scim_groups', 'identity.user_attributes'],
  content: ['content.schedules'],
  developer: [
    'developer.embed_users',
    'developer.sso_configuration',
    'developer.audit_configuration',
    'developer.api_explorer',
  ],
} as const;

function capability(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fleet.folder_read',
    label: 'Folder read access',
    evidenceState: 'available',
    readinessState: 'ready',
    reason: { code: 'ok', message: 'Documented read evidence is available.' },
    source: {
      kind: 'omni_api',
      scope: 'collection',
      method: 'GET',
      path: '/api/v1/folders',
    },
    checkedAt: CHECKED_AT,
    coverage: { included: 1, total: 1, complete: true, unit: 'endpoints' },
    exclusions: [],
    documentation: [],
    ...overrides,
  };
}

function report(
  capabilities: unknown[] = [capability()],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    instanceId: 'instance-neutral',
    workspace: 'fleet',
    checkedAt: CHECKED_AT,
    servedFromCache: false,
    capabilities,
    ...overrides,
  };
}

function ordinaryCapabilities(workspace: keyof typeof ORDINARY_IDS): unknown[] {
  return ORDINARY_IDS[workspace].map((id) => capability({ id }));
}

function accessPosture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity.user_model_roles',
    principalType: 'user',
    requestScope: { principalId: 'user / 1', modelId: 'model?1', connectionId: 'connection&1' },
    roles: [],
    evidenceState: 'available',
    readinessState: 'not_configured',
    reason: { code: 'not_configured', message: 'No role evidence exists for the requested scope.' },
    source: { kind: 'omni_api', scope: 'resource', method: 'GET', path: '/api/v1/users/:id/model-roles' },
    checkedAt: CHECKED_AT,
    coverage: { included: 0, total: 0, complete: true, unit: 'roles' },
    exclusions: [],
    documentation: [],
    ...overrides,
  };
}

test('frontend parser preserves every exact evidence and readiness state', () => {
  const evidenceStates = [
    'not_checked',
    'available',
    'partial',
    'unauthorized',
    'unsupported',
    'unavailable',
    'failed',
    'stale',
  ] as const;
  const readinessStates = ['ready', 'action_required', 'not_configured', 'unknown'] as const;

  const parsed = evidenceStates.map((evidenceState, index) => parseAdminReadinessReport(report([capability({
    label: `State ${evidenceState}`,
    evidenceState,
    readinessState: readinessStates[index % readinessStates.length],
    reason: { code: evidenceState === 'available' ? 'ok' : 'upstream_failure', message: `Exact ${evidenceState}` },
  })])).capabilities[0]);

  assert.deepEqual(parsed.map((entry) => entry.evidenceState), evidenceStates);
  assert.deepEqual(
    parsed.map((entry) => entry.readinessState),
    evidenceStates.map((_, index) => readinessStates[index % readinessStates.length]),
  );
});

test('available zero remains zero while partial and unavailable evidence stay distinct', () => {
  const parsed = parseAdminReadinessReport(report([
    capability({
      id: 'identity.scim_groups',
      label: 'Groups',
      data: { total: 0 },
      coverage: { included: 0, total: 0, complete: true, unit: 'groups' },
    }),
    capability({
      id: 'identity.scim_users',
      label: 'Users',
      evidenceState: 'partial',
      readinessState: 'action_required',
      reason: { code: 'partial_coverage', message: '250 of 300 users were read.' },
      data: { total: 250, active: 200, inactive: 40, statusUnknown: 10 },
      coverage: { included: 250, total: 300, complete: false, unit: 'users' },
      exclusions: ['50 users were outside the readable page window.'],
    }),
    capability({
      id: 'identity.user_attributes',
      label: 'User attributes',
      evidenceState: 'unavailable',
      readinessState: 'unknown',
      reason: { code: 'network_unavailable', message: 'No evidence was collected.' },
      data: undefined,
      coverage: { included: 0, total: 1, complete: false, unit: 'endpoints' },
    }),
  ], { workspace: 'identity' }));

  assert.equal((parsed.capabilities[0].data as { total?: number } | undefined)?.total, 0);
  assert.equal(parsed.capabilities[0].evidenceState, 'available');
  assert.equal((parsed.capabilities[1].data as { total?: number } | undefined)?.total, 250);
  assert.deepEqual(parsed.capabilities[1].coverage, {
    included: 250,
    total: 300,
    complete: false,
    unit: 'users',
  });
  assert.equal(parsed.capabilities[2].data, undefined);
  assert.equal(parsed.capabilities[2].evidenceState, 'unavailable');
});

test('frontend contract accepts only the sanitized current-caller projection and reconciles truncation', () => {
  const capabilities = ordinaryCapabilities('fleet').map((entry) => {
    const row = entry as Record<string, unknown>;
    if (row.id !== 'fleet.current_token_introspection') return entry;
    return capability({
      id: 'fleet.current_token_introspection',
      label: 'Current caller permissions',
      evidenceState: 'partial',
      readinessState: 'unknown',
      reason: { code: 'partial_coverage', message: 'The documented model-permission projection was truncated.' },
      source: { kind: 'omni_api', scope: 'resource', method: 'GET', path: '/api/v1/whoami' },
      coverage: { included: 200, total: null, complete: false, unit: 'model_permission_sets' },
      exclusions: ['model_permission_sets_outside_response_limit'],
      data: {
        keyScope: 'organization',
        orgRole: 'ORG_ADMIN',
        returnedModelCount: 200,
        returnedPermissionCount: 417,
        rolesByModelTruncated: true,
      },
    });
  });
  const parsed = parseAdminReadinessReport(report(capabilities));
  assert.deepEqual(parsed.capabilities[3].data, {
    keyScope: 'organization',
    orgRole: 'ORG_ADMIN',
    returnedModelCount: 200,
    returnedPermissionCount: 417,
    rolesByModelTruncated: true,
  });

  const malformed = structuredClone(report(capabilities)) as { capabilities: Array<Record<string, unknown>> };
  const caller = malformed.capabilities[3];
  caller.data = {
    ...(caller.data as Record<string, unknown>),
    privateMembershipId: 'must-not-cross-the-contract',
  };
  assert.throws(
    () => parseAdminReadinessReport(malformed),
    /data contains an unknown field/,
  );
});

test('authentication, permission, resource-missing, and unexpected-redirect reasons do not collapse', () => {
  const reasons = [
    { id: 'auth', evidenceState: 'unauthorized', code: 'authentication_required' },
    { id: 'permission', evidenceState: 'unauthorized', code: 'permission_denied' },
    { id: 'missing', evidenceState: 'unavailable', code: 'resource_not_found' },
    { id: 'redirect', evidenceState: 'failed', code: 'unexpected_redirect' },
  ];
  const capabilityIds = [
    'fleet.folder_read',
    'fleet.api_tokens',
    'fleet.organization_api_key_confirmation',
    'fleet.current_token_introspection',
  ];
  const parsed = parseAdminReadinessReport(report(reasons.map(({ evidenceState, code }, index) => capability({
      id: capabilityIds[index],
    evidenceState,
    readinessState: 'unknown',
    reason: { code, message: code },
    data: undefined,
  }))));

  assert.deepEqual(parsed.capabilities.map((entry) => entry.reason.code), reasons.map(({ code }) => code));
  assert.equal(parsed.capabilities.some((entry) => entry.evidenceState === 'unsupported'), false);
  assert.equal(parsed.capabilities.some((entry) => (entry.data as { total?: number } | undefined)?.total === 0), false);
});

test('unsupported static configuration and stale retained evidence preserve their source freshness', () => {
  const staleAt = '2026-08-01T08:30:00.000Z';
  const parsed = parseAdminReadinessReport(report([
    capability({
      id: 'developer.sso_configuration',
      label: 'SSO configuration',
      evidenceState: 'unsupported',
      readinessState: 'not_configured',
      reason: { code: 'no_documented_read_api', message: 'No documented read API is available.' },
      source: { kind: 'official_documentation', scope: 'manual_action' },
      checkedAt: CHECKED_AT,
      coverage: { included: 0, total: 0, complete: true, unit: 'endpoints' },
    }),
    capability({
      id: 'developer.embed_users',
      label: 'Embed users',
      evidenceState: 'stale',
      readinessState: 'unknown',
      reason: { code: 'cached_refresh_failed', message: 'Retained evidence could not be refreshed.' },
      source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/scim/v2/embed/users' },
      checkedAt: staleAt,
      coverage: { included: 250, total: 250, complete: true, unit: 'users' },
      data: { total: 250, active: 200, inactive: 40, statusUnknown: 10 },
    }),
  ], { workspace: 'developer' }));

  assert.equal(parsed.capabilities[0].evidenceState, 'unsupported');
  assert.equal(parsed.capabilities[0].reason.code, 'no_documented_read_api');
  assert.equal(parsed.capabilities[1].evidenceState, 'stale');
  assert.equal(parsed.capabilities[1].checkedAt, staleAt);
  assert.equal((parsed.capabilities[1].data as { total?: number }).total, 250);
});

test('frontend parser fails closed for malformed or invented evidence', () => {
  const documentation = Array.from({ length: 21 }, (_, index) => ({
    label: `Documentation ${index + 1}`,
    url: 'https://docs.omni.co/api/authentication',
  }));
  const actions = Array.from({ length: 21 }, (_, index) => ({
    kind: 'documentation',
    label: `Action ${index + 1}`,
    url: 'https://docs.omni.co/api/authentication',
  }));
  const malformed = [
    null,
    {},
    report([], { schemaVersion: 99 }),
    report([capability({ evidenceState: 'healthy' })]),
    report([capability({ readinessState: 'configured' })]),
    report([capability({ reason: { code: '', message: '' } })]),
    report([capability({ coverage: { included: 2, total: 1, complete: true, unit: 'endpoints' } })]),
    report([capability({ coverage: { included: 1, total: 2, complete: true, unit: 'endpoints' } })]),
    report([capability({ coverage: { included: 0, total: null, complete: true, unit: 'endpoints' } })]),
    report([capability({ source: { kind: 'omni_api', scope: 'collection', method: 'POST', path: '/api/v1/folders' } })]),
    report([capability({ actions: [{ kind: 'tenant_deep_link', label: 'Open API Explorer', url: 'https://neutral.invalid/%2e%2e/api-explorer' }] })]),
    report([capability({ documentation })]),
    report([capability({ actions })]),
  ];

  for (const value of malformed) {
    assert.throws(() => parseAdminReadinessReport(value), undefined, `expected malformed fixture to be rejected: ${JSON.stringify(value)}`);
  }
});

test('frontend parser rejects contradictory aggregate partitions and coverage', () => {
  const inconsistentCapabilities = [
    capability({
      id: 'fleet.api_tokens',
      data: { total: 2, organization: 1, personal: 0, mcp: 0, other: 0, enabled: 2, disabled: 0 },
      coverage: { included: 2, total: 2, complete: true, unit: 'tokens' },
    }),
    capability({
      id: 'identity.scim_users',
      data: { total: 3, active: 0, inactive: 0, statusUnknown: 0 },
      coverage: { included: 3, total: 3, complete: true, unit: 'users' },
    }),
    capability({
      id: 'identity.scim_groups',
      data: { total: 0 },
      coverage: { included: 1, total: 1, complete: true, unit: 'groups' },
    }),
    capability({
      id: 'content.schedules',
      data: {
        total: 2,
        active: 2,
        paused: 0,
        systemDisabled: 0,
        lastStatus: { success: 1, error: 0, canceled: 0, none: 0, unknown: 0 },
        latestObservedAt: null,
      },
      coverage: { included: 2, total: 2, complete: true, unit: 'schedules' },
    }),
  ];

  for (const value of inconsistentCapabilities) {
    const workspace = String((value as { id: string }).id).split('.')[0];
    assert.throws(() => parseAdminReadinessReport(report([value], { workspace })));
  }
});

test('frontend parser rejects numeric data attached to unavailable evidence states', () => {
  for (const evidenceState of ['unauthorized', 'unsupported', 'unavailable', 'failed'] as const) {
    assert.throws(() => parseAdminReadinessReport(report([
      capability({
        id: 'fleet.api_tokens',
        evidenceState,
        readinessState: 'unknown',
        reason: { code: 'upstream_failure', message: 'No verified token inventory was collected.' },
        data: { total: 0, organization: 0, personal: 0, mcp: 0, other: 0, enabled: 0, disabled: 0 },
        coverage: { included: 0, total: 0, complete: false, unit: 'tokens' },
      }),
    ])));
  }
});

test('frontend parser rejects role assignments attached to unavailable posture evidence', () => {
  for (const evidenceState of ['unauthorized', 'unsupported', 'unavailable', 'failed'] as const) {
    assert.throws(() => parseAdminReadinessReport(report([], {
      workspace: 'identity',
      accessPosture: {
        id: 'identity.user_model_roles',
        principalType: 'user',
        requestScope: { principalId: 'user-1' },
        roles: [{ roleName: 'Viewer' }],
        evidenceState,
        readinessState: 'unknown',
        reason: { code: 'upstream_failure', message: 'No verified role evidence was collected.' },
        source: { kind: 'omni_api', scope: 'resource', method: 'GET', path: '/api/v1/users/:id/model-roles' },
        checkedAt: CHECKED_AT,
        coverage: { included: 1, total: 1, complete: false, unit: 'roles' },
        exclusions: [],
        documentation: [],
      },
    })));
  }
});

test('frontend parser requires exact bounded opaque posture request scope', () => {
  const malformedScopes = [
    undefined,
    {},
    { principalId: 'user-1', unexpected: 'extra' },
    { principalId: ' user-1' },
    { principalId: 'user\u0000-1' },
    { principalId: 'person@example.com' },
    { principalId: 'Bearer raw-credential-value' },
    { principalId: 'user-1', modelId: 'https://tenant.invalid/model' },
  ];
  for (const requestScope of malformedScopes) {
    assert.throws(() => parseAdminReadinessReport(report([], {
      workspace: 'identity',
      accessPosture: accessPosture({ requestScope }),
    })));
  }
});

test('fetch uses one encoded local GET for large identity summaries and never sends a body', async (t) => {
  const identityReport = report([
    capability({
      id: 'identity.scim_users',
      label: 'Users',
      data: { total: 250, active: 200, inactive: 40, statusUnknown: 10 },
      coverage: { included: 250, total: 250, complete: true, unit: 'users' },
    }),
    capability({
      id: 'identity.scim_groups',
      label: 'Groups',
      data: { total: 100 },
      coverage: { included: 100, total: 100, complete: true, unit: 'groups' },
    }),
    capability({
      id: 'identity.user_attributes',
      label: 'User attributes',
      data: [],
      coverage: { included: 0, total: 0, complete: true, unit: 'attribute_definitions' },
    }),
  ], { workspace: 'identity', instanceId: 'instance / neutral' });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(identityReport), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const parsed = await fetchAdminReadiness('instance / neutral', 'identity');
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url, 'http://127.0.0.1');
  assert.equal(requestUrl.pathname, '/api/admin-readiness');
  assert.equal(requestUrl.searchParams.get('instanceId'), 'instance / neutral');
  assert.equal(requestUrl.searchParams.get('workspace'), 'identity');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.body, undefined);
  assert.deepEqual(parsed.capabilities.slice(0, 2).map((entry) => (entry.data as { total?: number }).total), [250, 100]);
});

test('identity access posture remains one explicit lazy GET with no secret-bearing parameters', async (t) => {
  const posture: AdminReadinessRequest = {
    principalType: 'user',
    principalId: 'user / 1',
    modelId: 'model?1',
    connectionId: 'connection&1',
  };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(report([], {
      workspace: 'identity',
      accessPosture: accessPosture(),
    })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const parsed = await fetchAdminReadiness('instance-neutral', 'identity', posture);
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0], 'http://127.0.0.1');
  assert.equal(requestUrl.searchParams.get('principalType'), 'user');
  assert.equal(requestUrl.searchParams.get('principalId'), 'user / 1');
  assert.equal(requestUrl.searchParams.get('modelId'), 'model?1');
  assert.equal(requestUrl.searchParams.get('connectionId'), 'connection&1');
  assert.equal(requestUrl.searchParams.has('base_url'), false);
  assert.equal(requestUrl.searchParams.has('api_key'), false);
  assert.equal(requestUrl.searchParams.has('token'), false);
  assert.deepEqual(parsed.capabilities, []);
  assert.deepEqual(parsed.accessPosture?.requestScope, {
    principalId: 'user / 1',
    modelId: 'model?1',
    connectionId: 'connection&1',
  });
});

test('fetch rejects empty, missing, duplicate, and extra ordinary workspace capability sets', async (t) => {
  const responses = [
    report([], { workspace: 'content' }),
    report([], { workspace: 'fleet' }),
    report([
      ...ordinaryCapabilities('content'),
      ...ordinaryCapabilities('content'),
    ], { workspace: 'content' }),
    report([
      ...ordinaryCapabilities('fleet'),
      capability({ id: 'identity.scim_users' }),
    ]),
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(responses[index++]), { status: 200 }));

  await assert.rejects(fetchAdminReadiness('instance-neutral', 'content'), /workspace capability set mismatch/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'fleet'), /workspace capability set mismatch/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'content'), /duplicate capability id/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'fleet'), /capability workspace mismatch/);
});

test('fetch binds posture type and exact requested scope and rejects wrong response shapes', async (t) => {
  const requested: AdminReadinessRequest = {
    principalType: 'user',
    principalId: 'user / 1',
    modelId: 'model?1',
    connectionId: 'connection&1',
  };
  const responses = [
    report(ordinaryCapabilities('identity'), { workspace: 'identity' }),
    report([capability({ id: 'identity.scim_users' })], {
      workspace: 'identity',
      accessPosture: accessPosture(),
    }),
    report([], {
      workspace: 'identity',
      accessPosture: accessPosture({
        id: 'identity.group_model_roles',
        principalType: 'group',
      }),
    }),
    report([], {
      workspace: 'identity',
      accessPosture: accessPosture({ requestScope: { principalId: 'different-user', modelId: 'model?1', connectionId: 'connection&1' } }),
    }),
    report(ordinaryCapabilities('identity'), {
      workspace: 'identity',
      accessPosture: accessPosture(),
    }),
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(responses[index++]), { status: 200 }));

  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', requested), /access posture response shape/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', requested), /access posture response shape/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', requested), /access posture request scope mismatch/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', requested), /access posture request scope mismatch/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity'), /unexpected access posture/);
});

test('fetch requires principal type and principal ID whenever any posture parameter is supplied', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });

  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', { modelId: 'model-1' }), /Both principal type and principal ID/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', { connectionId: 'connection-1' }), /Both principal type and principal ID/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', { principalType: 'user' }), /Both principal type and principal ID/);
  await assert.rejects(fetchAdminReadiness('instance-neutral', 'identity', { principalId: 'user-1' }), /Both principal type and principal ID/);
  assert.equal(calls, 0);
});

test('fetch rejects redirects, malformed JSON, malformed reports, and non-success responses', async (t) => {
  const responses = [
    () => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/' } }),
    () => new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify(report([capability({ evidenceState: 'invented' })])), { status: 200 }),
    () => new Response(JSON.stringify({ error: 'Readiness unavailable.' }), { status: 503 }),
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[index++]());

  for (let attempt = 0; attempt < responses.length; attempt += 1) {
    await assert.rejects(fetchAdminReadiness('instance-neutral', 'fleet'));
  }
});
