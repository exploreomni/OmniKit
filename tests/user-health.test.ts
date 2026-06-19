import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildUserHealth, entityHealthKey, readExpectedInactiveEntityKeys, writeExpectedInactiveEntityKeys } from '../src/services/userHealth';
import type { InstanceConnectionStats, InstanceEmbedUserStats } from '../src/services/opsConsole';

const NOW = new Date('2026-06-18T00:00:00.000Z');

function connectionStats(): InstanceConnectionStats[] {
  return [{
    instanceId: 'prod',
    instanceLabel: 'Production',
    instanceRole: 'both',
    baseUrl: 'https://prod.omniapp.co',
    totalConnections: 3,
    filteredCount: 0,
    missingSchemaModelCount: 0,
    stuckSchemaModelCount: 0,
    connections: [
      {
        id: 'entity-empty',
        name: 'Acme Co',
        dialect: 'snowflake',
        database: 'ACME',
        filtered: false,
        hasSchemaModel: true,
        schemaModelGenerated: true,
        schemaModelId: 'model-acme',
        schemaModelUpdatedAt: '2026-06-01T00:00:00.000Z',
        readiness: 'ready',
      },
      {
        id: 'entity-inactive',
        name: 'Beta Co',
        dialect: 'snowflake',
        database: 'BETA',
        filtered: false,
        hasSchemaModel: true,
        schemaModelGenerated: true,
        schemaModelId: 'model-beta',
        schemaModelUpdatedAt: '2026-06-01T00:00:00.000Z',
        readiness: 'ready',
      },
      {
        id: 'internal',
        name: 'Internal',
        dialect: 'snowflake',
        database: 'INTERNAL',
        filtered: true,
        hasSchemaModel: true,
        schemaModelGenerated: true,
        schemaModelId: 'model-internal',
        schemaModelUpdatedAt: '2026-06-01T00:00:00.000Z',
        readiness: 'ready',
      },
    ],
  }];
}

function embedUserStats(): InstanceEmbedUserStats[] {
  return [{
    instanceId: 'prod',
    instanceLabel: 'Production',
    instanceRole: 'both',
    baseUrl: 'https://prod.omniapp.co',
    totalUsers: 3,
    activeUsers: 1,
    inactiveUsers: 2,
    filteredCount: 0,
    entityCount: 2,
    activity: {
      active7d: 0,
      active30d: 1,
      active90d: 1,
      neverLoggedIn: 1,
      weeklyLogins: [],
      monthlySignups: [],
    },
    users: [
      {
        id: 'beta-inactive',
        displayName: 'Beta Inactive',
        userName: 'beta-inactive@example.com',
        active: false,
        embedExternalId: 'beta-inactive',
        entityName: 'Beta Co',
        filtered: false,
        lastLogin: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'beta-never',
        displayName: 'Beta Never',
        userName: 'beta-never@example.com',
        active: false,
        embedExternalId: 'beta-never',
        entityName: 'Beta Co',
        filtered: false,
        lastLogin: null,
      },
      {
        id: 'filtered-user',
        displayName: 'Filtered',
        userName: 'filtered@example.com',
        active: false,
        embedExternalId: 'filtered',
        entityName: 'Internal',
        filtered: true,
        lastLogin: null,
      },
    ],
  }];
}

test('user health flags connection entities with no users', () => {
  const result = buildUserHealth(connectionStats(), embedUserStats(), new Set(), NOW);
  const acme = result.entities.find((row) => row.entityName === 'Acme Co');

  assert.ok(acme);
  assert.equal(acme.finding, 'no_users');
  assert.equal(acme.actionNeeded, true);
  assert.equal(result.summary.noUserEntities, 1);
});

test('user health flags entities with users but no active users', () => {
  const result = buildUserHealth(connectionStats(), embedUserStats(), new Set(), NOW);
  const beta = result.entities.find((row) => row.entityName === 'Beta Co');

  assert.ok(beta);
  assert.equal(beta.finding, 'no_active_users');
  assert.equal(beta.totalUsers, 2);
  assert.equal(beta.inactiveUsers, 2);
  assert.equal(beta.neverLoggedInUsers, 1);
  assert.equal(result.summary.noActiveUserEntities, 1);
  assert.equal(result.summary.inactiveUsers, 2);
  assert.equal(result.summary.neverLoggedInUsers, 1);
  assert.deepEqual(result.summary.lastLoginBuckets, {
    last30d: 0,
    last31To90d: 1,
    olderThan90d: 0,
    neverLoggedIn: 1,
  });
});

test('user health maps users to connection entities through unique external id aliases', () => {
  const users = embedUserStats();
  users[0].users = [{
    id: 'acme-active',
    displayName: 'Acme Active',
    userName: 'acme-active@example.com',
    active: true,
    embedExternalId: 'customer-acme-co-portal-user',
    entityName: '',
    filtered: false,
    lastLogin: '2026-06-10T00:00:00.000Z',
  }];

  const result = buildUserHealth(connectionStats(), users, new Set(), NOW);
  const acme = result.entities.find((row) => row.entityName === 'Acme Co');

  assert.ok(acme);
  assert.equal(acme.finding, 'healthy');
  assert.equal(acme.totalUsers, 1);
  assert.equal(acme.activeUsers, 1);
  assert.equal(result.summary.unmappedUsers, 0);
});

test('user health keeps ambiguous users in an unmapped bucket instead of assigning them to a connection', () => {
  const users = embedUserStats();
  users[0].users = [{
    id: 'unknown-active',
    displayName: 'Unknown Active',
    userName: 'unknown-active@example.com',
    active: true,
    embedExternalId: 'unknown-customer',
    entityName: '',
    filtered: false,
    lastLogin: '2026-06-10T00:00:00.000Z',
  }];

  const result = buildUserHealth(connectionStats(), users, new Set(), NOW);
  const unassigned = result.entities.find((row) => row.entityName === 'Unassigned');

  assert.ok(unassigned);
  assert.equal(unassigned.totalUsers, 1);
  assert.equal(unassigned.connectionCount, 0);
  assert.equal(result.summary.unmappedUsers, 1);
});

test('expected inactive markers keep rows visible but suppress action-needed counts', () => {
  const expected = new Set([entityHealthKey('prod', 'Acme Co'), entityHealthKey('prod', 'Beta Co')]);
  const result = buildUserHealth(connectionStats(), embedUserStats(), expected, NOW);

  assert.equal(result.summary.expectedInactiveEntities, 2);
  assert.equal(result.summary.actionNeededEntities, 0);
  assert.equal(result.entities.every((row) => row.expectedInactive), true);
});

test('expected inactive marker storage is stable and tolerant of invalid payloads', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const keys = new Set([entityHealthKey('prod', 'Acme Co')]);

  writeExpectedInactiveEntityKeys(keys, storage);
  assert.deepEqual(readExpectedInactiveEntityKeys(storage), keys);

  storage.setItem('omnikit:userHealthExpectedInactive:v1', '{not json');
  assert.deepEqual(readExpectedInactiveEntityKeys(storage), new Set());
});
