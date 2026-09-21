import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { buildMigrationPlan } from '../server/services/migrationJobs';
import {
  OmniClient,
  resetOmniClientRateLimitStateForTests,
  type OmniDocumentAccessPrincipal,
} from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { clearReadThroughCache } from '../server/services/readThroughCache';

let temporaryRoot = '';

function clientLabel(client: OmniClient): string {
  return (client as unknown as { instance: { label: string } }).instance.label;
}

function emptyMetricFilter() {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

beforeEach(() => {
  resetOmniClientRateLimitStateForTests();
  clearReadThroughCache();
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-safe-copy-access-policy-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  unlockVault('safe-copy access-policy test passphrase');
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access in access-policy fixture'); });

  upsertInstance({
    id: 'source-instance',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-credential',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'destination-instance',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://destination.example.omniapp.co',
    apiKey: 'destination-credential',
    defaultFolderPath: 'Shared/Migrated',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
});

afterEach(() => {
  mock.restoreAll();
  resetOmniClientRateLimitStateForTests();
  clearReadThroughCache();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

test('destination-default access policy skips source access and identity reads while undefined preserves the legacy path', async () => {
  const calls = {
    documentAccess: 0,
    documentState: 0,
    identityUsers: 0,
    userGroups: 0,
    userAttributes: 0,
    userModelRoles: 0,
    groupModelRoles: 0,
  };
  const sourceAccess: OmniDocumentAccessPrincipal = {
    id: 'source-user-1',
    name: 'Source analyst',
    email: 'source.analyst@example.com',
    type: 'user',
    role: 'VIEWER',
    accessBoost: false,
    accessSource: 'direct',
    isOwner: false,
  };

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-dashboard',
          identifier: 'source-dashboard',
          name: 'Source Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    modelId: 'source-model',
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n',
  }));
  mock.method(OmniClient.prototype, 'getModelYaml', async (_modelId, options) => ({
    files: options?.mode === 'extension' ? {} : { 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n' },
    checksums: {}, raw: {},
  }));
  mock.method(OmniClient.prototype, 'listDocumentAccess', async function listDocumentAccess() {
    calls.documentAccess += 1;
    return clientLabel(this) === 'Source' ? [sourceAccess] : [];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => {
    calls.documentState += 1;
    return { modelId: 'source-model', workbookModelId: 'source-workbook' };
  });
  mock.method(OmniClient.prototype, 'listIdentityUsers', async function listIdentityUsers() {
    calls.identityUsers += 1;
    return clientLabel(this) === 'Destination'
      ? [{
          id: 'destination-user-1',
          displayName: 'Source analyst',
          userName: 'source.analyst@example.com',
          email: 'source.analyst@example.com',
          active: true,
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listUserGroups', async () => {
    calls.userGroups += 1;
    return [];
  });
  mock.method(OmniClient.prototype, 'listUserAttributes', async () => {
    calls.userAttributes += 1;
    return [];
  });
  mock.method(OmniClient.prototype, 'listUserModelRoles', async function listUserModelRoles() {
    calls.userModelRoles += 1;
    return [{
      roleName: 'QUERIER',
      modelId: clientLabel(this) === 'Source' ? 'source-model' : 'target-model',
      resolved: false,
      from: { type: 'User Role', id: clientLabel(this) === 'Source' ? 'source-user-1' : 'destination-user-1' },
    }];
  });
  mock.method(OmniClient.prototype, 'listUserGroupModelRoles', async () => {
    calls.groupModelRoles += 1;
    return [];
  });

  const baseInput = {
    sourceId: 'source-instance',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'destination-instance',
      targetConnectionId: 'destination-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Shared/Migrated',
    }],
    documentIds: ['source-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
  };

  const destinationDefaults = await buildMigrationPlan({
    ...baseInput,
    documentAccessPolicy: 'destination_defaults',
  });

  assert.deepEqual(calls, {
    documentAccess: 0,
    // Source binding is still read for provenance, not to copy access settings.
    documentState: 1,
    identityUsers: 0,
    userGroups: 0,
    userAttributes: 0,
    userModelRoles: 0,
    groupModelRoles: 0,
  });
  assert.equal(destinationDefaults.steps.some((step) => step.kind === 'permission_apply'), false);

  const legacy = await buildMigrationPlan(baseInput);

  assert.equal(calls.documentAccess, 1);
  assert.equal(calls.identityUsers, 1);
  assert.equal(calls.userGroups, 1);
  assert.equal(calls.userAttributes, 0);
  assert.equal(calls.userModelRoles, 2);
  assert.equal(calls.groupModelRoles, 0);
  assert.equal(calls.documentState, 2, 'each plan independently verifies the published source binding');
  assert.equal(legacy.steps.some((step) => step.kind === 'permission_apply'), true);
  const permissionKinds = (legacy.steps
    .find((step) => step.kind === 'permission_prepare')
    ?.details?.permissionDependencies as Array<{ kind?: string }> | undefined)
    ?.map((dependency) => dependency.kind);
  assert.ok(permissionKinds?.includes('document_access'));
  assert.ok(permissionKinds?.includes('document_settings'));
});

test('safe-copy planning rejects ambiguous source topic catalog matches instead of choosing the first file', async () => {
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => ({
    modelId: 'source-model', workbookModelId: 'source-workbook',
  }));
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-dashboard',
          identifier: 'source-dashboard',
          name: 'Source Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['Daily Operations'],
          topicIds: ['daily-operations'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    modelId: 'source-model',
    dashboard: { topicName: 'Daily Operations', topicId: 'daily-operations' },
    tiles: [],
  }));
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n' }
      : { 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => []);
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => []);
  // The planner now projects the topic catalog from authored YAML, not a separate list call.
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(_modelId, options) {
    return {
      files: options?.mode === 'extension' ? {} : {
        'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n',
        ...(clientLabel(this) === 'Source' ? {
          'folder-a/daily.topic': 'label: Daily Operations\nviews:\n  orders: {}\n',
          'folder-b/daily.topic': 'label: Daily Operations\nviews:\n  orders: {}\n',
        } : {}),
      },
      checksums: {}, raw: {},
    };
  });

  const plan = await buildMigrationPlan({
    sourceId: 'source-instance',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'destination-instance',
      targetConnectionId: 'destination-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Shared/Migrated',
      topicMappings: [{
        sourceTopicName: 'Daily Operations',
        sourceTopicId: 'daily-operations',
        action: 'copy_source',
        targetTopicName: 'Daily Operations',
      }],
    }],
    documentIds: ['source-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    documentAccessPolicy: 'destination_defaults',
  });

  const topicPreparation = plan.steps.find((step) => step.kind === 'topic_prepare');
  assert.equal(topicPreparation?.blocked, true);
  assert.match(topicPreparation?.error || '', /one exact authored source topic file is required.*labels alone cannot establish source identity/i);
  const topics = topicPreparation?.details?.sourceTopics as Array<{ fileName?: string }>;
  assert.ok(topics.every((topic) => topic.fileName === undefined));
});
