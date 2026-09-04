import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import manageGroups from '../server/handlers/manage-groups';
import manageUsers from '../server/handlers/manage-users';
import {
  buildGroupMembershipPatch,
  executeIdentityImport,
  identityImportPreflightProgressTotal,
  parseIdentityImportCsv,
  preflightIdentityImport,
} from '../src/services/userManagement/bulkIdentityImport';

type IdentityImportTestModel = {
  id: string;
  name: string;
  connectionId: string;
  kind: 'SHARED' | 'SHARED_EXTENSION';
  deletedAt: null;
};

type IdentityImportTestRole = {
  roleName: string;
  baseRole: string;
  connectionId: string;
  modelId: string;
  priority: number;
  resolved: boolean;
  from: { type: string };
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installIdentityImportApiMock(t: TestContext, options: {
  baseUrl: string;
  connections: Array<{ id: string; name: string; deletedAt: null }>;
  models: IdentityImportTestModel[];
  currentDirectRoleName?: string;
  effectiveBaseRoleName?: string;
  effectiveRoleName?: string;
}) {
  const user = {
    id: 'user-casey',
    userName: 'casey@example.com',
    displayName: 'Casey Doe',
    active: true,
  };
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    requests.push({ url, body });
    assert.equal(body.base_url, options.baseUrl);

    if (url === '/api/manage-users' && body.action === 'list') {
      return jsonResponse({ Resources: [user], totalResults: 1, itemsPerPage: 1, startIndex: body.start_index });
    }
    if (url === '/api/manage-groups' && body.action === 'list') {
      return jsonResponse({ Resources: [], totalResults: 0, itemsPerPage: 0, startIndex: body.start_index });
    }
    if (url === '/api/omni-proxy' && body.endpoint === '/v1/connections') {
      return jsonResponse({ connections: options.connections });
    }
    if (url === '/api/list-models') {
      const models = options.models.filter((model) => model.kind === body.model_kind);
      return jsonResponse({
        models,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
      });
    }
    if (url === '/api/manage-users' && body.action === 'list_model_roles') {
      const effectiveRoleName = options.effectiveRoleName;
      const matchingModels = options.models.filter((model) => (
        model.connectionId === body.connection_id
        && (body.model_id === undefined || model.id === body.model_id)
      ));
      const directRoles: IdentityImportTestRole[] = options.currentDirectRoleName
        ? matchingModels.map((model) => ({
            roleName: options.currentDirectRoleName!,
            baseRole: options.currentDirectRoleName!,
            connectionId: model.connectionId,
            modelId: model.id,
            priority: 20,
            resolved: !effectiveRoleName,
            from: { type: 'User Role' },
          }))
        : [];
      const inheritedRoles: IdentityImportTestRole[] = effectiveRoleName
        ? matchingModels.map((model) => ({
            roleName: effectiveRoleName,
            baseRole: options.effectiveBaseRoleName || effectiveRoleName,
            connectionId: model.connectionId,
            modelId: model.id,
            priority: 10,
            resolved: true,
            from: { type: 'GROUP' },
          }))
        : [];
      const results = [...directRoles, ...inheritedRoles];
      return jsonResponse({ membershipId: body.user_id, results });
    }
    if (url === '/api/manage-users' && body.action === 'assign_model_role') {
      const directRole: IdentityImportTestRole = {
        roleName: String(body.role_name),
        baseRole: String(body.role_name),
        connectionId: String(body.connection_id),
        modelId: String(body.model_id),
        priority: 20,
        resolved: !options.effectiveRoleName,
        from: { type: 'USER' },
      };
      const effectiveRole: IdentityImportTestRole | null = options.effectiveRoleName
        ? {
            roleName: options.effectiveRoleName,
            baseRole: options.effectiveBaseRoleName || options.effectiveRoleName,
            connectionId: directRole.connectionId,
            modelId: directRole.modelId,
            priority: 10,
            resolved: true,
            from: { type: 'GROUP' },
          }
        : null;
      return jsonResponse({
        membershipId: body.user_id,
        results: effectiveRole ? [directRole, effectiveRole] : [directRole],
        assignment: {
          userId: body.user_id,
          roleName: body.role_name,
          connectionId: body.connection_id,
          modelId: body.model_id,
        },
        role: directRole,
        verified: true,
      });
    }

    throw new Error(`Unexpected identity-import request: ${url} ${JSON.stringify(body)}`);
  });

  return requests;
}

test('simple identity CSV supports BOM, CRLF, escaped comma lists, and role aliases', () => {
  const plan = parseIdentityImportCsv([
    '\uFEFFaction,display_name,email,group,role,connection,model',
    'ADD,Casey Doe,casey@example.com,"Analytics\\, Central, Finance Users",Restricted Querier,"Warehouse A, Warehouse B","Core A, Core B"',
  ].join('\r\n'));

  assert.equal(plan.format, 'simple');
  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.deepEqual(
    plan.records.filter((record) => record.type === 'group').map((record) => record.groupName),
    ['Analytics, Central', 'Finance Users'],
  );
  const role = plan.records.find((record) => record.type === 'role');
  assert.ok(role && role.type === 'role');
  assert.equal(role.roleName, 'QUERY_TOPICS');
  assert.deepEqual(role.connectionNames, ['Warehouse A', 'Warehouse B']);
  assert.deepEqual(role.modelNames, ['Core A', 'Core B']);
});

test('simple identity CSV treats No assignment as a non-destructive export marker', () => {
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,Analytics Users,No assignment,,',
  ].join('\n'));

  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(plan.records.filter((record) => record.type === 'role').length, 0);
  assert.equal(plan.records.filter((record) => record.type === 'user').length, 1);
  assert.equal(plan.records.filter((record) => record.type === 'membership').length, 1);
  assert.equal(plan.previewRows[0].role, 'No assignment');
  assert.equal(plan.previewRows[0].destructive, false);
  assert.ok(plan.issues.some((issue) => issue.severity === 'warning' && /no model-role change/i.test(issue.message)));
});

test('simple identity CSV blocks destructive or scoped use of No assignment', () => {
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'remove,Casey Doe,casey@example.com,,No assignment,,',
    'add,Casey Doe,casey@example.com,,No assignment,Warehouse A,',
  ].join('\n'));

  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 2);
  assert.equal(plan.records.length, 0);
});

test('simple identity CSV accepts a blank model for Restricted Querier adds', () => {
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,"Warehouse A, Warehouse B",',
  ].join('\n'));

  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  const role = plan.records.find((record) => record.type === 'role');
  assert.ok(role && role.type === 'role');
  assert.equal(role.roleName, 'QUERY_TOPICS');
  assert.deepEqual(role.connectionNames, ['Warehouse A', 'Warehouse B']);
  assert.deepEqual(role.modelNames, []);
});

test('simple identity CSV ignores model values for connection-scoped Connection Admin assignments', () => {
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Connection Admin,"Warehouse A, Warehouse B","Core A, Core B"',
  ].join('\n'));

  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  const warning = plan.issues.find((issue) => issue.severity === 'warning' && issue.rowNumber === 2);
  assert.ok(warning);
  assert.match(warning.message, /2 model values were ignored/i);
  assert.match(warning.message, /named connections remain the target/i);

  const role = plan.records.find((record) => record.type === 'role');
  assert.ok(role && role.type === 'role');
  assert.equal(role.roleName, 'CONNECTION_ADMIN');
  assert.deepEqual(role.connectionNames, ['Warehouse A', 'Warehouse B']);
  assert.deepEqual(role.modelNames, []);

  assert.equal(plan.previewRows.length, 1);
  assert.deepEqual(plan.previewRows[0].connections, ['Warehouse A', 'Warehouse B']);
  assert.deepEqual(plan.previewRows[0].models, []);
});

test('Connection Admin-only preflight resolves supplied models to connection scope without model inventory reads', async (t) => {
  const baseUrl = 'https://connection-admin-scope.example.omniapp.co';
  const requests = installIdentityImportApiMock(t, {
    baseUrl,
    connections: [{ id: 'connection-a', name: 'Warehouse A', deletedAt: null }],
    models: [],
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Connection Admin,Warehouse A,Core Analytics',
  ].join('\n'));

  const preflight = await preflightIdentityImport(baseUrl, 'connection-admin-scope-key', plan, {
    key: 'connection-admin-scope',
    label: 'Connection Admin scope',
  });

  assert.equal(preflight.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(preflight.changes.roleAdds, 1);
  assert.deepEqual(preflight.roleChanges.map((change) => ({
    connectionId: change.connectionId,
    modelId: change.modelId,
    roleName: change.roleName,
  })), [{
    connectionId: 'connection-a',
    modelId: undefined,
    roleName: 'CONNECTION_ADMIN',
  }]);
  assert.equal(requests.filter((request) => request.url === '/api/list-models').length, 0);
});

test('preflight expands a blank Restricted Querier model to every current permission model on selected connections', async (t) => {
  const baseUrl = 'https://blank-model-expansion.example.omniapp.co';
  const requests = installIdentityImportApiMock(t, {
    baseUrl,
    connections: [
      { id: 'connection-a', name: 'Warehouse A', deletedAt: null },
      { id: 'connection-b', name: 'Warehouse B', deletedAt: null },
    ],
    models: [
      { id: 'model-shared-a', name: 'Core Analytics', connectionId: 'connection-a', kind: 'SHARED', deletedAt: null },
      { id: 'model-extension-a', name: 'Finance Extension', connectionId: 'connection-a', kind: 'SHARED_EXTENSION', deletedAt: null },
      { id: 'model-shared-b', name: 'Other Connection Model', connectionId: 'connection-b', kind: 'SHARED', deletedAt: null },
    ],
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,',
  ].join('\n'));

  const preflight = await preflightIdentityImport(baseUrl, 'blank-model-expansion-key', plan, {
    key: 'blank-model-expansion',
    label: 'Blank model expansion',
  });

  assert.equal(preflight.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(preflight.changes.roleAdds, 2);
  assert.deepEqual(
    preflight.roleChanges
      .map((change) => ({
        connectionId: change.connectionId,
        disposition: change.disposition,
        modelId: change.modelId,
        roleName: change.roleName,
        rowNumbers: change.rowNumbers,
      }))
      .sort((left, right) => String(left.modelId).localeCompare(String(right.modelId))),
    [
      { connectionId: 'connection-a', disposition: 'add', modelId: 'model-extension-a', roleName: 'QUERY_TOPICS', rowNumbers: [2] },
      { connectionId: 'connection-a', disposition: 'add', modelId: 'model-shared-a', roleName: 'QUERY_TOPICS', rowNumbers: [2] },
    ],
  );
  const roleReads = requests.filter((request) => request.url === '/api/manage-users' && request.body.action === 'list_model_roles');
  assert.equal(roleReads.length, 1);
  assert.equal(roleReads[0].body.connection_id, 'connection-a');
  assert.equal(roleReads[0].body.model_id, undefined);
});

test('preflight blocks a blank-model role when a selected connection has no eligible permission model', async (t) => {
  const baseUrl = 'https://blank-model-empty.example.omniapp.co';
  installIdentityImportApiMock(t, {
    baseUrl,
    connections: [
      { id: 'connection-a', name: 'Warehouse A', deletedAt: null },
      { id: 'connection-b', name: 'Warehouse B', deletedAt: null },
    ],
    models: [
      { id: 'model-shared-b', name: 'Warehouse B Model', connectionId: 'connection-b', kind: 'SHARED', deletedAt: null },
    ],
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,',
  ].join('\n'));

  const preflight = await preflightIdentityImport(baseUrl, 'blank-model-empty-key', plan, {
    key: 'blank-model-empty',
    label: 'Blank model empty inventory',
  });

  const error = preflight.issues.find((issue) => issue.severity === 'error' && issue.rowNumber === 2);
  assert.ok(error);
  assert.match(error.message, /Warehouse A/i);
  assert.match(error.message, /eligible|permission-bearing/i);
  assert.equal(preflight.roleChanges.length, 0);
});

test('preflight preserves every source row when wildcard and explicit role targets overlap', async (t) => {
  const baseUrl = 'https://blank-model-attribution.example.omniapp.co';
  installIdentityImportApiMock(t, {
    baseUrl,
    connections: [{ id: 'connection-a', name: 'Warehouse A', deletedAt: null }],
    models: [
      { id: 'model-shared-a', name: 'Core Analytics', connectionId: 'connection-a', kind: 'SHARED', deletedAt: null },
      { id: 'model-extension-a', name: 'Finance Extension', connectionId: 'connection-a', kind: 'SHARED_EXTENSION', deletedAt: null },
    ],
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,Core Analytics',
  ].join('\n'));

  const preflight = await preflightIdentityImport(baseUrl, 'blank-model-attribution-key', plan, {
    key: 'blank-model-attribution',
    label: 'Blank model attribution',
  });

  assert.equal(preflight.issues.filter((issue) => issue.severity === 'error').length, 0);
  const core = preflight.roleChanges.find((change) => change.modelId === 'model-shared-a');
  const extension = preflight.roleChanges.find((change) => change.modelId === 'model-extension-a');
  assert.ok(core);
  assert.ok(extension);
  assert.deepEqual(core.rowNumbers, [2, 3]);
  assert.deepEqual(extension.rowNumbers, [2]);
});

test('execution fails closed when a direct Restricted Querier assignment leaves broader access effective', async (t) => {
  const baseUrl = 'https://blank-model-effective-role.example.omniapp.co';
  const requests = installIdentityImportApiMock(t, {
    baseUrl,
    connections: [{ id: 'connection-a', name: 'Warehouse A', deletedAt: null }],
    models: [
      { id: 'model-shared-a', name: 'Core Analytics', connectionId: 'connection-a', kind: 'SHARED', deletedAt: null },
    ],
    effectiveRoleName: 'QUERIER',
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,',
  ].join('\n'));
  const scope = {
    key: 'blank-model-effective-role',
    label: 'Blank model effective role',
  };
  const preflight = await preflightIdentityImport(baseUrl, 'blank-model-effective-role-key', plan, scope);

  const results = await executeIdentityImport(baseUrl, 'blank-model-effective-role-key', preflight, undefined, scope);

  const roleResult = results.find((result) => result.stage === 'role');
  assert.ok(roleResult);
  assert.equal(roleResult.status, 'failed');
  assert.match(roleResult.message, /accepted the direct Restricted Querier/i);
  assert.match(roleResult.message, /broader inherited or base access/i);
  assert.match(roleResult.message, /QUERIER/);
  assert.match(roleResult.message, /do not retry automatically/i);
  assert.deepEqual(roleResult.rowNumbers, [2]);
  const assignmentRequests = requests.filter((request) => request.url === '/api/manage-users' && request.body.action === 'assign_model_role');
  assert.equal(assignmentRequests.length, 1);
  assert.equal(assignmentRequests[0].body.role_name, 'QUERY_TOPICS');
  assert.equal(assignmentRequests[0].body.connection_id, 'connection-a');
  assert.equal(assignmentRequests[0].body.model_id, 'model-shared-a');
});

test('preflight exposes broader effective access when the requested direct role already exists', async (t) => {
  const baseUrl = 'https://same-direct-broader-effective.example.omniapp.co';
  const requests = installIdentityImportApiMock(t, {
    baseUrl,
    connections: [{ id: 'connection-a', name: 'Warehouse A', deletedAt: null }],
    models: [
      { id: 'model-shared-a', name: 'Core Analytics', connectionId: 'connection-a', kind: 'SHARED', deletedAt: null },
    ],
    currentDirectRoleName: 'QUERY_TOPICS',
    effectiveRoleName: 'QUERIER',
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,Core Analytics',
  ].join('\n'));
  const scope = {
    key: 'same-direct-broader-effective',
    label: 'Same direct broader effective',
  };

  const preflight = await preflightIdentityImport(baseUrl, 'same-direct-broader-effective-key', plan, scope);

  assert.equal(preflight.roleChanges.length, 1);
  assert.equal(preflight.roleChanges[0].disposition, 'noop');
  assert.match(preflight.roleChanges[0].message, /already assigned directly/i);
  assert.match(preflight.roleChanges[0].message, /more permissive than Restricted Querier/i);
  assert.ok(preflight.issues.some((issue) => issue.severity === 'warning' && /more permissive than Restricted Querier/i.test(issue.message)));

  const results = await executeIdentityImport(baseUrl, 'same-direct-broader-effective-key', preflight, undefined, scope);
  const roleResult = results.find((result) => result.stage === 'role');
  assert.ok(roleResult);
  assert.equal(roleResult.status, 'skipped');
  assert.match(roleResult.message, /more permissive than Restricted Querier/i);
  const assignmentRequests = requests.filter((request) => request.url === '/api/manage-users' && request.body.action === 'assign_model_role');
  assert.equal(assignmentRequests.length, 0);
});

test('execution overwrites an existing direct No Access role with Restricted Querier', async (t) => {
  const baseUrl = 'https://blank-model-no-access.example.omniapp.co';
  const requests = installIdentityImportApiMock(t, {
    baseUrl,
    connections: [{ id: 'connection-a', name: 'Warehouse A', deletedAt: null }],
    models: [
      { id: 'model-shared-a', name: 'Core Analytics', connectionId: 'connection-a', kind: 'SHARED', deletedAt: null },
    ],
    currentDirectRoleName: 'NO_ACCESS',
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,',
  ].join('\n'));
  const scope = {
    key: 'blank-model-no-access',
    label: 'Blank model No Access elevation',
  };
  const preflight = await preflightIdentityImport(baseUrl, 'blank-model-no-access-key', plan, scope);

  assert.equal(preflight.roleChanges.length, 1);
  assert.equal(preflight.roleChanges[0].disposition, 'add');
  assert.match(preflight.roleChanges[0].message, /Overwrite existing NO_ACCESS with Restricted Querier/i);

  const progress: Array<{ completed: number; total: number; stage: string; message: string }> = [];
  const results = await executeIdentityImport(
    baseUrl,
    'blank-model-no-access-key',
    preflight,
    (next) => progress.push(next),
    scope,
  );

  const roleResult = results.find((result) => result.stage === 'role');
  assert.ok(roleResult);
  assert.equal(roleResult.status, 'succeeded');
  assert.match(roleResult.message, /verified both direct and effective access/i);
  const assignmentRequests = requests.filter((request) => request.url === '/api/manage-users' && request.body.action === 'assign_model_role');
  assert.equal(assignmentRequests.length, 1);
  assert.equal(assignmentRequests[0].body.role_name, 'QUERY_TOPICS');
  assert.equal(assignmentRequests[0].body.model_id, 'model-shared-a');
  assert.equal(progress[0]?.completed, 0);
  assert.ok((progress[0]?.total || 0) > 1);
  assert.equal(new Set(progress.map((entry) => entry.total)).size, 1);
  assert.ok(progress.some((entry) => entry.stage === 'Revalidating'));
  assert.ok(progress.some((entry) => entry.stage === 'Applying roles' && /Applying role change/i.test(entry.message)));
  progress.slice(1).forEach((entry, index) => {
    assert.ok(entry.completed >= progress[index].completed, 'progress must never move backward');
  });
  assert.equal(progress.at(-1)?.completed, progress.at(-1)?.total);
});

test('execution does not report a same-base custom role as exact Restricted Querier verification', async (t) => {
  const baseUrl = 'https://blank-model-custom-role.example.omniapp.co';
  installIdentityImportApiMock(t, {
    baseUrl,
    connections: [{ id: 'connection-a', name: 'Warehouse A', deletedAt: null }],
    models: [
      { id: 'model-shared-a', name: 'Core Analytics', connectionId: 'connection-a', kind: 'SHARED', deletedAt: null },
    ],
    effectiveRoleName: 'CUSTOM_RESTRICTED',
    effectiveBaseRoleName: 'QUERY_TOPICS',
  });
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,,Restricted Querier,Warehouse A,',
  ].join('\n'));
  const scope = {
    key: 'blank-model-custom-role',
    label: 'Blank model custom role',
  };
  const preflight = await preflightIdentityImport(baseUrl, 'blank-model-custom-role-key', plan, scope);

  const results = await executeIdentityImport(baseUrl, 'blank-model-custom-role-key', preflight, undefined, scope);

  const roleResult = results.find((result) => result.stage === 'role');
  assert.ok(roleResult);
  assert.equal(roleResult.status, 'failed');
  assert.doesNotMatch(roleResult.message, /verified both direct and effective access/i);
  assert.match(roleResult.message, /CUSTOM_RESTRICTED \(base QUERY_TOPICS\)/);
  assert.match(roleResult.message, /custom effective policy remains in force/i);
  assert.match(roleResult.message, /do not retry automatically/i);
});

test('simple identity CSV requires quoted list cells and exact display identity for deprovisioning', () => {
  const unquoted = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,Casey Doe,casey@example.com,Analytics, Finance,,,',
  ].join('\n'));
  const unsafeDelete = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'remove,,casey@example.com,,,,',
  ].join('\n'));

  assert.match(unquoted.issues.find((issue) => issue.severity === 'error')?.message || '', /exactly seven CSV fields/i);
  assert.match(unsafeDelete.issues.find((issue) => issue.severity === 'error')?.message || '', /requires display_name/i);
});

test('unified identity CSV supports quoted values, CRLF, and explicit attribute columns', () => {
  const plan = parseIdentityImportCsv([
    'record_type,action,email,display_name,group_name,attribute_department',
    'user,upsert,casey@example.com,"Doe, Casey",,Analytics',
    'group,ensure,,,"Analytics, Central",',
    'membership,add,casey@example.com,,"Analytics, Central",',
  ].join('\r\n'));

  assert.equal(plan.format, 'unified');
  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.deepEqual(plan.summary, {
    userUpserts: 1,
    userDeletes: 0,
    groupsEnsured: 1,
    membershipsAdded: 1,
    membershipsRemoved: 0,
    rolesAdded: 0,
    rolesRemoved: 0,
  });
  assert.deepEqual(plan.records[0], {
    type: 'user',
    action: 'upsert',
    rowNumber: 2,
    rowNumbers: [2],
    email: 'casey@example.com',
    displayName: 'Doe, Casey',
    attributes: { department: 'Analytics' },
  });
});

test('unified identity CSV preserves multiline quoted display names', () => {
  const plan = parseIdentityImportCsv([
    'record_type,action,email,display_name,group_name',
    'user,upsert,casey@example.com,"Casey\nDoe",',
  ].join('\n'));

  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(plan.records[0].type, 'user');
  if (plan.records[0].type === 'user') assert.equal(plan.records[0].displayName, 'Casey\nDoe');
});

test('legacy user and membership templates remain importable', () => {
  const users = parseIdentityImportCsv([
    'email,display_name,op,department',
    'analyst@example.com,Example Analyst,upsert,Finance',
  ].join('\n'));
  const memberships = parseIdentityImportCsv([
    'email,group_name,op',
    'analyst@example.com,Finance Users,add',
  ].join('\n'));

  assert.equal(users.format, 'legacy-users');
  assert.deepEqual(users.records[0], {
    type: 'user',
    action: 'upsert',
    rowNumber: 2,
    rowNumbers: [2],
    email: 'analyst@example.com',
    displayName: 'Example Analyst',
    attributes: { department: 'Finance' },
  });
  assert.equal(memberships.format, 'legacy-memberships');
  assert.equal(memberships.records[0].type, 'membership');
});

test('conflicting operations block an identity import while exact duplicates are ignored', () => {
  const plan = parseIdentityImportCsv([
    'record_type,action,email,display_name,group_name',
    'membership,add,analyst@example.com,,Finance Users',
    'membership,add,analyst@example.com,,Finance Users',
    'membership,remove,analyst@example.com,,Finance Users',
  ].join('\n'));

  assert.equal(plan.records.length, 1);
  assert.match(plan.issues.find((issue) => issue.severity === 'warning')?.message || '', /Duplicate membership add/);
  assert.match(plan.issues.find((issue) => issue.severity === 'error')?.message || '', /Conflicting membership actions/);
});

test('duplicate group setup is summarized once per group with all source rows', () => {
  const plan = parseIdentityImportCsv([
    'action,display_name,email,group,role,connection,model',
    'add,User One,one@example.com,Operations,,,',
    'add,User Two,two@example.com,operations,,,',
    'add,User Three,three@example.com,Operations,,,',
    'add,User Four,four@example.com,Product,,,',
    'add,User Five,five@example.com,Product,,,',
  ].join('\n'));

  const groupRecords = plan.records.filter((record) => record.type === 'group');
  assert.equal(groupRecords.length, 2);
  assert.equal(plan.summary.groupsEnsured, 2);
  assert.deepEqual(groupRecords.map((record) => ({
    groupName: record.groupName,
    rowNumbers: record.rowNumbers,
  })), [
    { groupName: 'Operations', rowNumbers: [2, 3, 4] },
    { groupName: 'Product', rowNumbers: [5, 6] },
  ]);

  const groupWarnings = plan.issues.filter((issue) => /merged into one group operation/i.test(issue.message));
  assert.equal(groupWarnings.length, 2);
  assert.deepEqual(groupWarnings.map((issue) => ({
    rowNumber: issue.rowNumber,
    rowNumbers: issue.rowNumbers,
    message: issue.message,
  })), [
    {
      rowNumber: 2,
      rowNumbers: [2, 3, 4],
      message: '3 rows referencing group Operations were merged into one group operation.',
    },
    {
      rowNumber: 5,
      rowNumbers: [5, 6],
      message: '2 rows referencing group Product were merged into one group operation.',
    },
  ]);
  assert.equal(plan.records.filter((record) => record.type === 'membership').length, 5);
  assert.equal(identityImportPreflightProgressTotal(plan), 3);
});

test('group membership patches batch additions and targeted removals without replacing unrelated members', () => {
  const patch = buildGroupMembershipPatch(
    [{ value: '11111111-1111-4111-8111-111111111111', display: 'new@example.com' }],
    ['22222222-2222-4222-8222-222222222222'],
  );

  assert.deepEqual(patch, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [
      { op: 'add', path: 'members', value: [{ value: '11111111-1111-4111-8111-111111111111', display: 'new@example.com' }] },
      { op: 'remove', path: 'members[value eq "22222222-2222-4222-8222-222222222222"]' },
    ],
  });
});

function groupRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/manage-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'test-vault-reference',
      ...body,
    }),
  });
}

test('group handler creates groups through the SCIM v2 endpoint', async (t) => {
  let requestMethod = '';
  let requestUrl = '';
  let requestBody: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestMethod = init?.method || '';
    requestBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ id: 'group-1', displayName: 'Finance Users', members: [] }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await manageGroups(groupRequest({
    action: 'create',
    group_data: { displayName: 'Finance Users', members: [] },
  }));

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'POST');
  assert.equal(new URL(requestUrl).pathname, '/api/scim/v2/groups');
  assert.deepEqual(requestBody, { displayName: 'Finance Users', members: [] });
});

test('group handler applies SCIM patch operations instead of replacing the group', async (t) => {
  let requestMethod = '';
  let requestBody: unknown;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestMethod = init?.method || '';
    requestBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ id: 'group-1', displayName: 'Finance Users', members: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const patch = buildGroupMembershipPatch([{ value: 'user-1' }], []);

  const response = await manageGroups(groupRequest({ action: 'patch', group_id: 'group-1', group_data: patch }));

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'PATCH');
  assert.deepEqual(requestBody, patch);
});

test('user attribute preflight uses the documented attribute inventory endpoint', async (t) => {
  let requestMethod = '';
  let requestUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestMethod = init?.method || '';
    return new Response(JSON.stringify({ userAttributes: [{ name: 'department', system: false }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await manageUsers(new Request('http://localhost/api/manage-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'test-vault-reference',
      action: 'list_attributes',
    }),
  }));

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'GET');
  assert.equal(new URL(requestUrl).pathname, '/api/v1/user-attributes');
});
