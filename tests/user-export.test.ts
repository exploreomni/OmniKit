import assert from 'node:assert/strict';
import test from 'node:test';

import type { OmniUser } from '../src/types';
import type { UserModelRoleRecord } from '../src/services/omniApi';
import { csvRowsToText } from '../src/utils/csvExport';
import { parseIdentityImportCsv } from '../src/services/userManagement/bulkIdentityImport';
import {
  buildIdentityExportRows,
  IdentityExportError,
} from '../src/services/userManagement/userExport';

const HEADER = ['action', 'display_name', 'email', 'group', 'role', 'connection', 'model'];

type ExportConnection = { id: string; name: string };
type ExportModel = {
  id: string;
  name: string;
  connectionId: string;
  kind: 'SHARED' | 'SHARED_EXTENSION';
};

const CONNECTIONS: ExportConnection[] = [
  { id: 'connection-a', name: 'Warehouse A' },
  { id: 'connection-b', name: 'Warehouse B' },
];

const MODELS: ExportModel[] = [
  { id: 'model-a', name: 'Core Model', connectionId: 'connection-a', kind: 'SHARED' },
  { id: 'model-b', name: 'Finance Extension', connectionId: 'connection-a', kind: 'SHARED_EXTENSION' },
  { id: 'model-c', name: 'Operations Model', connectionId: 'connection-b', kind: 'SHARED' },
];

function user(overrides: Partial<OmniUser> = {}): OmniUser {
  return {
    id: 'user-1',
    userName: 'analyst@example.invalid',
    displayName: 'Example Analyst',
    groups: [{ value: 'group-1', display: 'Analytics Users' }],
    ...overrides,
  };
}

function role(overrides: Partial<UserModelRoleRecord> = {}): UserModelRoleRecord {
  return {
    roleName: 'QUERY_TOPICS',
    baseRole: 'QUERY_TOPICS',
    connectionId: 'connection-a',
    modelId: 'model-a',
    priority: 20,
    resolved: false,
    from: { type: 'User Role' },
    ...overrides,
  };
}

function sortedDataRows(rows: ReturnType<typeof buildIdentityExportRows>) {
  assert.deepEqual(rows[0], HEADER);
  return [...rows.slice(1)].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

test('user export includes direct Restricted Querier scope and excludes inherited or effective roles', () => {
  const directRestricted = role();
  const inheritedModeler = role({
    roleName: 'MODELER',
    baseRole: 'MODELER',
    resolved: true,
    from: { type: 'GROUP' },
  });

  const rows = buildIdentityExportRows({
    users: [user()],
    rolesByUserId: new Map([['user-1', [directRestricted, inheritedModeler]]]),
    connections: CONNECTIONS,
    models: MODELS,
  });

  assert.deepEqual(rows, [
    HEADER,
    ['add', 'Example Analyst', 'analyst@example.invalid', 'Analytics Users', 'Restricted Querier', 'Warehouse A', 'Core Model'],
  ]);
});

test('user export preserves users without direct roles as base rows', () => {
  const inheritedOnly = role({
    roleName: 'QUERIER',
    baseRole: 'QUERIER',
    resolved: true,
    from: { type: 'Group Role' },
  });

  const rows = buildIdentityExportRows({
    users: [user()],
    rolesByUserId: new Map([['user-1', [inheritedOnly]]]),
    connections: CONNECTIONS,
    models: MODELS,
  });

  assert.deepEqual(rows, [
    HEADER,
    ['add', 'Example Analyst', 'analyst@example.invalid', 'Analytics Users', '', '', ''],
  ]);
});

test('user export does not turn absent role evidence into a blank-role row', () => {
  assert.throws(
    () => buildIdentityExportRows({
      users: [user()],
      rolesByUserId: new Map(),
      connections: CONNECTIONS,
      models: MODELS,
    }),
    (error: unknown) => (
      error instanceof IdentityExportError
      && /role|evidence|complete/i.test(error.message)
    ),
  );
});

test('user export groups model assignments and keeps Connection Admin connection-scoped', () => {
  const rows = buildIdentityExportRows({
    users: [user({ groups: [] })],
    rolesByUserId: new Map([['user-1', [
      role({ roleName: 'VIEWER', baseRole: 'VIEWER', modelId: 'model-a', from: { type: 'USER' } }),
      role({ roleName: 'VIEWER', baseRole: 'VIEWER', modelId: 'model-b' }),
      role({
        roleName: 'CONNECTION_ADMIN',
        baseRole: 'CONNECTION_ADMIN',
        connectionId: 'connection-b',
        modelId: 'model-c',
        from: { type: 'USER' },
      }),
    ]]]),
    connections: CONNECTIONS,
    models: MODELS,
  });

  assert.deepEqual(sortedDataRows(rows), [
    ['add', 'Example Analyst', 'analyst@example.invalid', '', 'Connection Admin', 'Warehouse B', ''],
    ['add', 'Example Analyst', 'analyst@example.invalid', '', 'Viewer', 'Warehouse A', 'Core Model, Finance Extension'],
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
});

test('user export splits a grouped role after the import list limit', () => {
  const models: ExportModel[] = Array.from({ length: 51 }, (_, index) => ({
    id: `model-${String(index + 1).padStart(2, '0')}`,
    name: `Model ${String(index + 1).padStart(2, '0')}`,
    connectionId: 'connection-a',
    kind: 'SHARED',
  }));
  const roles = models.map((model) => role({ modelId: model.id }));

  const rows = buildIdentityExportRows({
    users: [user({ groups: [] })],
    rolesByUserId: new Map([['user-1', roles]]),
    connections: CONNECTIONS,
    models,
  });

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], HEADER);
  assert.equal(String(rows[1][6]).split(', ').length, 50);
  assert.equal(rows[2][6], 'Model 51');
});

test('exported identity rows round-trip through the bulk-import contract with exact role scopes', () => {
  const connections: ExportConnection[] = [
    ...CONNECTIONS,
    { id: 'connection-c', name: 'Warehouse C' },
  ];
  const models: ExportModel[] = [
    ...MODELS,
    { id: 'model-d', name: 'Executive Model', connectionId: 'connection-c', kind: 'SHARED' },
  ];
  const exportedRows = buildIdentityExportRows({
    users: [user({
      groups: [
        { value: 'group-1', display: 'Analytics Users' },
        { value: 'group-2', display: 'Finance Users' },
      ],
    })],
    rolesByUserId: new Map([['user-1', [
      role(),
      role({
        roleName: 'QUERIER',
        baseRole: 'QUERIER',
        connectionId: 'connection-b',
        modelId: 'model-c',
        from: { type: 'USER' },
      }),
      role({
        roleName: 'CONNECTION_ADMIN',
        baseRole: 'CONNECTION_ADMIN',
        connectionId: 'connection-c',
        modelId: 'model-d',
      }),
    ]]]),
    connections,
    models,
  });

  const parsed = parseIdentityImportCsv(csvRowsToText(exportedRows));
  assert.equal(parsed.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.deepEqual(
    parsed.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
    ['3 compatible rows for analyst@example.invalid were merged into one user operation.'],
  );
  assert.deepEqual(
    parsed.records
      .filter((record) => record.type === 'role')
      .map((record) => ({
        roleName: record.roleName,
        connections: record.connectionNames,
        models: record.modelNames,
      }))
      .sort((left, right) => left.roleName.localeCompare(right.roleName)),
    [
      { roleName: 'CONNECTION_ADMIN', connections: ['Warehouse C'], models: [] },
      { roleName: 'QUERIER', connections: ['Warehouse B'], models: ['Operations Model'] },
      { roleName: 'QUERY_TOPICS', connections: ['Warehouse A'], models: ['Core Model'] },
    ],
  );
  assert.deepEqual(
    parsed.records
      .filter((record) => record.type === 'membership')
      .map((record) => record.groupName)
      .sort((left, right) => left.localeCompare(right)),
    ['Analytics Users', 'Finance Users'],
  );
});

test('exported identity values preserve spreadsheet-sensitive and escaped names', () => {
  const connections: ExportConnection[] = [{ id: 'connection-a', name: 'Warehouse, East' }];
  const models: ExportModel[] = [{
    id: 'model-a',
    name: '=Core \\ Model',
    connectionId: 'connection-a',
    kind: 'SHARED',
  }];
  const exportedRows = buildIdentityExportRows({
    users: [user({
      userName: '+analyst@example.invalid',
      displayName: '- Example Analyst',
      groups: [{ value: 'group-1', display: '@Executive, Team' }],
    })],
    rolesByUserId: new Map([['user-1', [role()]]]),
    connections,
    models,
  });

  const parsed = parseIdentityImportCsv(csvRowsToText(exportedRows));
  assert.equal(parsed.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(parsed.previewRows[0].email, '+analyst@example.invalid');
  assert.equal(parsed.previewRows[0].displayName, '- Example Analyst');
  assert.deepEqual(parsed.previewRows[0].groups, ['@Executive, Team']);
  assert.deepEqual(parsed.previewRows[0].connections, ['Warehouse, East']);
  assert.deepEqual(parsed.previewRows[0].models, ['=Core \\ Model']);
});

test('user export requires explicit group evidence', () => {
  assert.throws(
    () => buildIdentityExportRows({
      users: [user({ groups: undefined })],
      rolesByUserId: new Map([['user-1', []]]),
      connections: CONNECTIONS,
      models: MODELS,
    }),
    (error: unknown) => error instanceof IdentityExportError && /group|evidence|complete/i.test(error.message),
  );
});

test('user export omits a no-assignment marker when a known direct role exists', () => {
  const rows = buildIdentityExportRows({
    users: [user()],
    rolesByUserId: new Map([['user-1', [
      role(),
      role({ roleName: 'NO_ACCESS', baseRole: 'NO_ACCESS', from: { type: 'Future Role Source' } }),
    ]]]),
    connections: CONNECTIONS,
    models: MODELS,
  });

  assert.deepEqual(rows, [
    HEADER,
    ['add', 'Example Analyst', 'analyst@example.invalid', 'Analytics Users', 'Restricted Querier', 'Warehouse A', 'Core Model'],
  ]);

  const parsed = parseIdentityImportCsv(csvRowsToText(rows));
  assert.equal(parsed.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.deepEqual(
    parsed.records
      .filter((record) => record.type === 'role')
      .map((record) => record.roleName),
    ['QUERY_TOPICS'],
  );
  assert.equal(parsed.issues.some((issue) => /No assignment/i.test(issue.message)), false);
});

test('user export marks no assignment only when all role evidence has an unknown source', () => {
  const rows = buildIdentityExportRows({
    users: [user()],
    rolesByUserId: new Map([['user-1', [
      role({ roleName: 'NO_ACCESS', baseRole: 'NO_ACCESS', from: { type: 'Future Role Source' } }),
    ]]]),
    connections: CONNECTIONS,
    models: MODELS,
  });

  assert.deepEqual(rows, [
    HEADER,
    ['add', 'Example Analyst', 'analyst@example.invalid', 'Analytics Users', 'No assignment', '', ''],
  ]);

  const parsed = parseIdentityImportCsv(csvRowsToText(rows));
  assert.equal(parsed.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(parsed.records.filter((record) => record.type === 'user' && record.action === 'upsert').length, 1);
  assert.equal(parsed.records.filter((record) => record.type === 'role').length, 0);
  assert.ok(parsed.issues.some((issue) => issue.severity === 'warning' && /No assignment/i.test(issue.message)));
});

test('user export splits group memberships at the bulk-import list limit', () => {
  const groups = Array.from({ length: 51 }, (_, index) => ({
    value: `group-${index + 1}`,
    display: `Group ${String(index + 1).padStart(2, '0')}`,
  }));
  const exportedRows = buildIdentityExportRows({
    users: [user({ groups })],
    rolesByUserId: new Map([['user-1', []]]),
    connections: CONNECTIONS,
    models: MODELS,
  });

  assert.equal(exportedRows.length, 3);
  const parsed = parseIdentityImportCsv(csvRowsToText(exportedRows));
  assert.equal(parsed.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(parsed.records.filter((record) => record.type === 'membership').length, 51);
});

test('user export fails closed for custom roles and unresolved or ambiguous catalog identities', () => {
  const cases: Array<{ name: string; roles: UserModelRoleRecord[]; connections?: ExportConnection[]; models?: ExportModel[]; pattern: RegExp }> = [
    {
      name: 'custom role',
      roles: [role({ roleName: 'CUSTOM_ANALYST' })],
      pattern: /unsupported|custom role/i,
    },
    {
      name: 'unknown model id',
      roles: [role({ modelId: 'model-missing' })],
      pattern: /model|resolve/i,
    },
    {
      name: 'missing model scope',
      roles: [role({ modelId: null })],
      pattern: /model|scope/i,
    },
    {
      name: 'missing connection scope',
      roles: [role({ connectionId: null })],
      pattern: /connection|scope/i,
    },
    {
      name: 'ambiguous connection name',
      roles: [role()],
      connections: [...CONNECTIONS, { id: 'connection-c', name: 'warehouse a' }],
      pattern: /connection|ambiguous/i,
    },
    {
      name: 'ambiguous model name within one connection',
      roles: [role()],
      models: [...MODELS, { id: 'model-d', name: 'core model', connectionId: 'connection-a', kind: 'SHARED' }],
      pattern: /model|ambiguous/i,
    },
  ];

  for (const current of cases) {
    assert.throws(
      () => buildIdentityExportRows({
        users: [user()],
        rolesByUserId: new Map([['user-1', current.roles]]),
        connections: current.connections || CONNECTIONS,
        models: current.models || MODELS,
      }),
      (error: unknown) => (
        error instanceof IdentityExportError
        && current.pattern.test(error.message)
      ),
      current.name,
    );
  }
});
