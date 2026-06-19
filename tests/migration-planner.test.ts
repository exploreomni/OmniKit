import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instancesHandler from '../server/handlers/instances';
import { buildMigrationPlan, createMigrationJob, getJob, retryMigrationJob } from '../server/services/migrationJobs';
import { OmniClient, type OmniDocumentRecord } from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-planner-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(tempDir, 'omnikit-jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(tempDir, 'jobs.json');
  unlockVault('planner passphrase');
});

afterEach(() => {
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

function clientLabel(client: OmniClient): string {
  return (client as unknown as { instance: { label: string } }).instance.label;
}

async function waitForJob(id: string) {
  const terminal = new Set(['succeeded', 'partial', 'failed', 'canceled']);
  for (let i = 0; i < 50; i += 1) {
    const job = getJob(id);
    if (job && terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job ${id} did not finish in time.`);
}

test('planner replaces same-named dashboards without emptying unrelated target docs', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const sourceDocs: OmniDocumentRecord[] = [
    {
      id: 'source-doc-1',
      identifier: 'source-doc-1',
      name: 'Executive Scorecard',
      folderPath: 'Source Dashboards',
      baseModelId: 'source-model',
    },
  ];
  const destinationDocs: OmniDocumentRecord[] = [
    {
      id: 'dest-existing-1',
      identifier: 'dest-existing-1',
      name: 'Executive Scorecard',
      folderPath: 'Migrated Dashboards',
    },
    {
      id: 'dest-existing-2',
      identifier: 'dest-existing-2',
      name: 'Do Not Touch',
      folderPath: 'Migrated Dashboards',
    },
  ];

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source' ? sourceDocs : destinationDocs;
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deletes = plan.steps.filter((step) => step.kind === 'delete');

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].documentId, 'dest-existing-1');
  assert.equal(deletes[0].replacement, true);
  assert.equal(plan.steps.some((step) => step.documentId === 'dest-existing-2'), false);
});

test('planner replaces same-named default target dashboards without deleting selected same-instance source', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
    {
      id: 'my-docs-existing',
      identifier: 'my-docs-existing',
      name: 'NFL MVP Analytics',
      folderPath: '',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deletes = plan.steps.filter((step) => step.kind === 'delete');

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].documentId, 'my-docs-existing');
  assert.equal(deletes[0].replacement, true);
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(importStep?.warnings, undefined);
  assert.equal(importStep?.notices, undefined);
});

test('planner can source selected dashboards across all folders for a connection-scoped job', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Default Only',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (clientLabel(this) === 'Source') {
      return [
        {
          id: 'default-doc',
          identifier: 'default-doc',
          name: 'Default Dashboard',
          connectionId: 'source-connection',
          folderPath: 'Default Only',
          baseModelId: 'source-model',
        },
        {
          id: 'selected-doc',
          identifier: 'selected-doc',
          name: 'Connection Dashboard',
          connectionId: 'source-connection',
          folderPath: 'Shared/Team Dashboards',
          baseModelId: 'source-model',
        },
      ];
    }
    return [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({}));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['selected-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
    sourceAllFolders: true,
  });

  assert.equal(plan.sourceAllFolders, true);
  assert.equal(plan.sourceFolderPath, undefined);
  assert.equal(plan.steps.some((step) => step.kind === 'import' && step.documentId === 'selected-doc'), true);
});

test('planner never queues selected source dashboard as a same-instance replacement delete', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-same-folder',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Just For Fun',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  assert.equal(plan.steps.some((step) => step.kind === 'delete'), false);
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(importStep?.warnings, undefined);
  assert.match(importStep?.notices?.join(' ') || '', /same Omni instance/i);
});

test('same-instance default replacement scan without a root match does not turn a successful import into warning', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let deleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'imported-nfl-dashboard',
    documentId: 'imported-nfl-dashboard',
  }));
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async () => {
    deleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(job.status, 'succeeded');
  assert.equal(importItem?.status, 'succeeded');
  assert.equal(importItem?.warnings, undefined);
  assert.equal(importItem?.notices, undefined);
  assert.equal(deleteCalls, 0);
});

test('same-instance default replacement deletes exact-name root target before import', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const deleteCalls: string[] = [];
  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
    {
      id: 'my-docs-existing',
      identifier: 'my-docs-existing',
      name: 'NFL MVP Analytics',
      folderPath: '',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'imported-nfl-dashboard',
    documentId: 'imported-nfl-dashboard',
  }));
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async (documentId: string) => {
    deleteCalls.push(documentId);
  });

  const created = await createMigrationJob({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const deleteItem = job.items.find((item) => item.kind === 'delete');
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(deleteCalls, ['my-docs-existing']);
  assert.equal(deleteItem?.status, 'succeeded');
  assert.equal(deleteItem?.replacement, true);
  assert.equal(importItem?.status, 'succeeded');
});

test('planner still skips empty-first cleanup when target folder is unscoped', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
    {
      id: 'my-docs-existing',
      identifier: 'my-docs-existing',
      name: 'NFL MVP Analytics',
      folderPath: '',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: true,
    replaceSameNamed: true,
  });

  assert.equal(plan.steps.some((step) => step.kind === 'delete'), false);
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(importStep?.warnings, undefined);
  assert.match(importStep?.notices?.join(' ') || '', /cleanup was skipped/i);
});

test('planner treats Omni formula helpers as functions instead of missing destination fields', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Formula Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': [
      'dimensions:',
      '  id:',
      'measures:',
      '  total_revenue:',
    ].join('\n'),
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{
      fields: ['orders.id', 'orders.total_revenue'],
      formula: 'SqlStdOperatorTable.CAST(orders.id) + SqlStdOperatorTable.ROUND(orders.total_revenue) + Omni.OMNI_FX_SUM(orders.total_revenue)',
    }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const importStep = plan.steps.find((step) => step.kind === 'import');
  const warnings = importStep?.warnings || [];

  assert.equal(warnings.some((warning) => warning.includes('OMNI_FX')), false);
  assert.equal(warnings.some((warning) => warning.includes('SqlStdOperatorTable')), false);
  assert.equal(warnings.some((warning) => warning.includes('referenced fields were not found')), false);
});

test('planner suppresses best-effort missing-field warnings for same target model copies', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Same Model Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'target-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['omni_dbt_marts__mart_play_motion_replay_frames.actor_color'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const warnings = plan.steps.flatMap((step) => step.warnings || []);

  assert.equal(warnings.some((warning) => warning.includes('referenced fields were not found')), false);
});

test('planner keeps field compatibility warnings on import instead of duplicating them onto topic prep', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'source_topic' },
    tiles: [{ fields: ['orders.missing_field'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async () => [{ name: 'source_topic', label: 'Source Topic' }]);

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'map_existing',
        targetTopicName: 'source_topic',
        targetTopicLabel: 'Source Topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const topicPrep = plan.steps.find((step) => step.kind === 'topic_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');

  assert.equal(topicPrep?.warnings?.some((warning) => warning.includes('referenced fields were not found')), undefined);
  assert.equal(importStep?.warnings?.some((warning) => warning.includes('referenced fields were not found')), true);
});

test('planner adds source delete only after copy import steps when requested', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
  });

  assert.equal(plan.sourceConnectionId, 'source-connection');
  assert.equal(plan.deleteSourceOnSuccess, true);
  assert.equal(plan.targets[0].targetConnectionId, 'target-connection');
  assert.deepEqual(plan.steps.map((step) => step.kind), ['export', 'import', 'metadata', 'source_delete']);
  assert.equal(plan.steps.at(-1)?.destinationId, 'source-1');
  assert.equal(plan.steps.at(-1)?.documentId, 'source-doc-1');
});

test('planner supports multiple target instances in one dashboard migration', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
        targetModelId: 'target-model-1',
      },
      {
        id: 'target-2',
        destinationInstanceId: 'dest-2',
        targetConnectionId: 'target-connection-2',
        targetModelId: 'target-model-2',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  assert.deepEqual(plan.destinationIds, ['dest-1', 'dest-2']);
  assert.deepEqual(plan.targets.map((target) => target.targetConnectionId), ['target-connection-1', 'target-connection-2']);
  assert.equal(plan.steps.filter((step) => step.kind === 'import').length, 2);
});

test('planner supports multiple target rows in the same instance across connections', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-connection-a',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'connection-a',
        targetModelId: 'target-model-a',
      },
      {
        id: 'target-connection-b',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'connection-b',
        targetModelId: 'target-model-b',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  assert.deepEqual(plan.destinationIds, ['dest-1']);
  assert.deepEqual(plan.targets.map((target) => target.id), ['target-connection-a', 'target-connection-b']);
  assert.deepEqual(plan.steps.filter((step) => step.kind === 'import').map((step) => step.targetConnectionId), ['connection-a', 'connection-b']);
});

test('planner routes one dashboard to repeated same-instance target folders with scoped replacements', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const sourceDocs: OmniDocumentRecord[] = [{
    id: 'source-doc-1',
    identifier: 'source-doc-1',
    name: 'Executive Scorecard',
    folderPath: 'Source Dashboards',
    baseModelId: 'source-model',
  }];
  const destinationDocs: OmniDocumentRecord[] = [
    {
      id: 'dest-folder-a-existing',
      identifier: 'dest-folder-a-existing',
      name: 'Executive Scorecard',
      folderPath: 'Team A',
    },
    {
      id: 'dest-folder-b-existing',
      identifier: 'dest-folder-b-existing',
      name: 'Executive Scorecard',
      folderPath: 'Team B',
    },
    {
      id: 'dest-folder-c-existing',
      identifier: 'dest-folder-c-existing',
      name: 'Executive Scorecard',
      folderPath: 'Team C',
    },
  ];

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source' ? sourceDocs : destinationDocs;
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    routeGroups: [{
      id: 'route-executive',
      name: 'Executive route',
      documentIds: ['source-doc-1'],
      targets: [
        {
          id: 'target-team-a',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-a',
          targetModelId: 'target-model-a',
          targetFolderPath: 'Team A',
        },
        {
          id: 'target-team-b',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-b',
          targetModelId: 'target-model-b',
          targetFolderPath: 'Team B',
        },
      ],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deletes = plan.steps.filter((step) => step.kind === 'delete');
  const imports = plan.steps.filter((step) => step.kind === 'import');

  assert.deepEqual(deletes.map((step) => `${step.targetId}:${step.documentId}:${step.targetFolderPath}`), [
    'target-team-a:dest-folder-a-existing:Team A',
    'target-team-b:dest-folder-b-existing:Team B',
  ]);
  assert.equal(deletes.every((step) => step.replacement === true), true);
  assert.equal(deletes.some((step) => step.documentId === 'dest-folder-c-existing'), false);
  assert.deepEqual(imports.map((step) => `${step.routeGroupId}:${step.targetId}:${step.documentId}`), [
    'route-executive:target-team-a:source-doc-1',
    'route-executive:target-team-b:source-doc-1',
  ]);
});

test('planner route groups only create dashboard-target pairs declared by each group', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [
          {
            id: 'source-doc-a',
            identifier: 'source-doc-a',
            name: 'Orders Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-a',
          },
          {
            id: 'source-doc-b',
            identifier: 'source-doc-b',
            name: 'Finance Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-b',
          },
        ]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    routeGroups: [
      {
        id: 'route-orders',
        name: 'Orders route',
        documentIds: ['source-doc-a'],
        targets: [{
          id: 'target-orders',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-orders',
          targetModelId: 'target-model-orders',
        }],
      },
      {
        id: 'route-finance',
        name: 'Finance route',
        documentIds: ['source-doc-b'],
        targets: [{
          id: 'target-finance',
          destinationInstanceId: 'dest-2',
          targetConnectionId: 'connection-finance',
          targetModelId: 'target-model-finance',
        }],
      },
    ],
    documentIds: ['source-doc-a', 'source-doc-b'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const imports = plan.steps.filter((step) => step.kind === 'import');

  assert.deepEqual(plan.routeGroups?.map((group) => group.id), ['route-orders', 'route-finance']);
  assert.deepEqual(imports.map((step) => `${step.routeGroupId}:${step.documentId}:${step.destinationId}`), [
    'route-orders:source-doc-a:dest-1',
    'route-finance:source-doc-b:dest-2',
  ]);
  assert.equal(imports.some((step) => step.documentId === 'source-doc-a' && step.destinationId === 'dest-2'), false);
  assert.equal(imports.some((step) => step.documentId === 'source-doc-b' && step.destinationId === 'dest-1'), false);
});

test('dashboard route-group retry preserves failed route audit metadata only', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [
          {
            id: 'source-doc-a',
            identifier: 'source-doc-a',
            name: 'Orders Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-a',
          },
          {
            id: 'source-doc-b',
            identifier: 'source-doc-b',
            name: 'Finance Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-b',
          },
        ]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    if (clientLabel(this) === 'Destination Two') throw new Error('Route import failed.');
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    routeGroups: [
      {
        id: 'route-orders',
        name: 'Orders route',
        documentIds: ['source-doc-a'],
        targets: [{
          id: 'target-orders',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-orders',
          targetModelId: 'target-model-orders',
        }],
      },
      {
        id: 'route-finance',
        name: 'Finance route',
        documentIds: ['source-doc-b'],
        targets: [{
          id: 'target-finance',
          destinationInstanceId: 'dest-2',
          targetConnectionId: 'connection-finance',
          targetModelId: 'target-model-finance',
        }],
      },
    ],
    documentIds: ['source-doc-a', 'source-doc-b'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const routeKinds = job.items
    .filter((item) => item.routeGroupId)
    .map((item) => `${item.routeGroupId}:${item.kind}:${item.documentId}`);

  assert.ok(routeKinds.includes('route-orders:import:source-doc-a'));
  assert.ok(routeKinds.includes('route-finance:import:source-doc-b'));
  assert.equal(job.items.some((item) => item.routeGroupId === 'route-orders' && item.documentId === 'source-doc-b'), false);

  const retry = await retryMigrationJob(job.id);

  assert.deepEqual(retry.routeGroups?.map((group) => group.id), ['route-finance']);
  assert.deepEqual(retry.documentIds, ['source-doc-b']);
  assert.deepEqual(retry.targets?.map((target) => target.destinationInstanceId), ['dest-2']);
  assert.equal(retry.items.some((item) => item.routeGroupId === 'route-orders'), false);
  assert.equal(retry.items.some((item) => item.documentId === 'source-doc-a'), false);
  assert.ok(retry.items
    .filter((item) => item.kind === 'export' || item.kind === 'import' || item.kind === 'metadata')
    .every((item) => item.routeGroupId === 'route-finance' && item.routeGroupName === 'Finance route'));
});

test('source delete is skipped when any target import fails', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  const sourceDoc = {
    id: 'source-doc-1',
    identifier: 'source-doc-1',
    name: 'Executive Scorecard',
    folderPath: 'Source Dashboards',
    baseModelId: 'source-model',
  };
  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source' ? [sourceDoc] : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    if (clientLabel(this) === 'Destination Two') throw new Error('Import failed.');
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
        targetModelId: 'target-model-1',
      },
      {
        id: 'target-2',
        destinationInstanceId: 'dest-2',
        targetConnectionId: 'target-connection-2',
        targetModelId: 'target-model-2',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(sourceDelete?.status, 'skipped');
  assert.match(sourceDelete?.error || '', /import did not complete successfully/);
  assert.equal(sourceDeleteCalls, 0);
});

test('source delete is skipped when schema refresh fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'imported-doc-1',
    documentId: 'imported-doc-1',
  }));
  mock.method(OmniClient.prototype, 'refreshModel', async () => {
    throw new Error('Refresh queue failed.');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [{
      kind: 'refresh-schema',
      name: 'Destination: refresh schema target-model-1',
      method: 'POST',
      url: '',
      headers: {},
      body: '',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model-1',
      targetModelName: 'Target Model',
    }],
  });

  const job = await waitForJob(created.id);
  const refresh = job.items.find((item) => item.kind === 'post_action');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(refresh?.status, 'failed');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.match(sourceDelete?.error || '', /post-migration action failed/);
  assert.equal(sourceDeleteCalls, 0);
});

test('dashboard migration maps existing target topics and rewrites dashboard payload before import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let importedPayload: Record<string, unknown> | null = null;
  let yamlWriteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      topicName: 'source_topic',
    },
    queries: [{
      query: {
        topicName: 'source_topic',
      },
    }],
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    return clientLabel(this) === 'Destination'
      ? [{ name: 'target_topic', label: 'Target Topic' }]
      : [{ name: 'source_topic', label: 'Source Topic', fileName: 'source_topic.topic', yaml: 'label: Source Topic\nbase_view_name: orders\n' }];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    yamlWriteCalls += 1;
  });
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument(input: { exportPayload: Record<string, unknown> }) {
    importedPayload = input.exportPayload;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'map_existing',
        targetTopicName: 'target_topic',
        targetTopicLabel: 'Target Topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const topicPrep = job.items.find((item) => item.kind === 'topic_prepare');
  const importedDashboard = importedPayload?.dashboard as Record<string, unknown> | undefined;
  const importedQueries = importedPayload?.queries as Array<{ query: Record<string, unknown> }> | undefined;

  assert.equal(job.status, 'succeeded');
  assert.equal(topicPrep?.status, 'succeeded');
  assert.equal(yamlWriteCalls, 0);
  assert.equal(importedDashboard?.topicName, 'target_topic');
  assert.equal(importedQueries?.[0]?.query.topicName, 'target_topic');
});

test('dashboard migration copies source topic YAML before dashboard import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const calls: string[] = [];
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      topicName: 'source_topic',
    },
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'source_topic', label: 'Source Topic', fileName: 'source_topic.topic', yaml: 'label: Source Topic\nbase_view_name: orders\n' }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async function updateModelYamlFile(input: { fileName: string; yaml: string }) {
    calls.push(`write:${input.fileName}:${input.yaml.includes('Source Topic')}`);
  });
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    calls.push('import');
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'copy_source',
        targetTopicName: 'source_topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(calls, ['write:source_topic.topic:true', 'import']);
});

test('source delete is skipped when topic preparation fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      topicName: 'source_topic',
    },
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'source_topic', label: 'Source Topic', fileName: 'source_topic.topic', yaml: 'label: Source Topic\nbase_view_name: orders\n' }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    throw new Error('Topic write failed.');
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    throw new Error('Import should have been skipped.');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'copy_source',
        targetTopicName: 'source_topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const topicPrep = job.items.find((item) => item.kind === 'topic_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(topicPrep?.status, 'failed');
  assert.equal(importItem?.status, 'skipped');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(sourceDeleteCalls, 0);
});

test('saved-instance document listing enriches missing dashboard model details on request', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Coffee Shop Demo',
    folderPath: 'Source Dashboards',
    baseModelId: 'Unknown',
    baseModelName: 'Unknown',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-1',
    name: 'Coffee Model',
    identifier: 'coffee-model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      sharedModelId: 'model-1',
    },
  }));
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string }> };

  assert.equal(body.documents[0].baseModelId, 'model-1');
  assert.equal(body.documents[0].baseModelName, 'Coffee Model');
});

test('saved-instance document listing extracts model details from nested document model payloads', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Nested Model Dashboard',
    folderPath: 'Source Dashboards',
    baseModelId: 'Unknown',
    baseModelName: 'Unknown',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-2',
    name: 'Nested Model',
    identifier: 'nested-model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    document: {
      model: {
        id: 'model-2',
        name: 'Nested Model',
      },
    },
  }));
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string }> };

  assert.equal(body.documents[0].baseModelId, 'model-2');
  assert.equal(body.documents[0].baseModelName, 'Nested Model');
});

test('saved-instance document listing extracts workbook model and topic metadata from export payloads', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Topic Dashboard',
    folderPath: 'Source Dashboards',
    baseModelId: 'Unknown',
    baseModelName: 'Unknown',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-3',
    name: 'Workbook Model',
    identifier: 'workbook-model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    workbookModel: {
      id: 'model-3',
      name: 'Workbook Model',
    },
    dashboard: {
      topicNames: [{ id: 'topic-1', name: 'nfl_mvp' }],
    },
    queries: [{
      query: {
        topicName: 'nfl_mvp',
        topicId: 'topic-1',
      },
    }],
  }));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string; topicNames?: string[]; topicIds?: string[] }> };

  assert.equal(body.documents[0].baseModelId, 'model-3');
  assert.equal(body.documents[0].baseModelName, 'Workbook Model');
  assert.deepEqual(body.documents[0].topicNames, ['nfl_mvp']);
  assert.deepEqual(body.documents[0].topicIds, ['topic-1']);
});

test('saved-instance document listing applies selected connection model fallback when export omits model metadata', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'coffee-shop-demo',
      identifier: 'coffee-shop-demo',
      name: 'Coffee Shop Demo',
      connectionId: 'coffee-connection',
      folderPath: 'omni-training',
      description: 'Demo dashboard',
      labels: [],
    },
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      connectionId: 'nfl-connection',
      folderPath: 'just-for-fun',
      description: 'Demo dashboard',
      labels: [],
    },
  ]);
  mock.method(OmniClient.prototype, 'listModels', async () => [
    {
      id: 'model-nfl',
      name: 'ATX - NFL Big Data Bowl Demo',
      identifier: 'nfl-big-data-bowl',
      connectionId: 'nfl-connection',
    },
  ]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({}));
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?folderPath=just-for-fun&connectionId=nfl-connection&includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ id: string; baseModelId?: string; baseModelName?: string }> };

  assert.deepEqual(body.documents.map((document) => document.id), ['nfl-superstar-team-motion-lab-v34']);
  assert.equal(body.documents[0].baseModelId, 'model-nfl');
  assert.equal(body.documents[0].baseModelName, 'ATX - NFL Big Data Bowl Demo');
});

test('saved-instance document listing can load all folders scoped by selected connection', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Default Only',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let requestedFolderId: string | undefined;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async (folderId?: string) => {
    requestedFolderId = folderId;
    return [
      {
        id: 'default-doc',
        identifier: 'default-doc',
        name: 'Default Dashboard',
        connectionId: 'nfl-connection',
        folderPath: 'Default Only',
        description: 'Default dashboard',
        labels: [],
      },
      {
        id: 'team-doc',
        identifier: 'team-doc',
        name: 'Team Dashboard',
        connectionId: 'nfl-connection',
        folderPath: 'Shared/Team Dashboards',
        description: 'Team dashboard',
        labels: [],
      },
      {
        id: 'coffee-doc',
        identifier: 'coffee-doc',
        name: 'Coffee Dashboard',
        connectionId: 'coffee-connection',
        folderPath: 'Default Only',
        description: 'Other connection dashboard',
        labels: [],
      },
    ];
  });

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=nfl-connection'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ id: string; folderPath?: string }> };

  assert.equal(requestedFolderId, undefined);
  assert.deepEqual(body.documents.map((document) => document.id), ['default-doc', 'team-doc']);
  assert.deepEqual(body.documents.map((document) => document.folderPath), ['Default Only', 'Shared/Team Dashboards']);
});

test('saved-instance document listing extracts topic metadata from document queries when export is sparse', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Topic Dashboard',
    connectionId: 'connection-1',
    folderPath: 'Source Dashboards',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-1',
    name: 'Topic Model',
    identifier: 'topic-model',
    connectionId: 'connection-1',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({}));
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => [{
    id: 'query-1',
    name: 'Query 1',
    query: {
      topicName: 'nfl_mvp',
    },
  }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?connectionId=connection-1&includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string; topicNames?: string[]; topicIds?: string[] }> };

  assert.equal(body.documents[0].baseModelId, 'model-1');
  assert.equal(body.documents[0].baseModelName, 'Topic Model');
  assert.deepEqual(body.documents[0].topicNames, ['nfl_mvp']);
  assert.deepEqual(body.documents[0].topicIds, ['nfl_mvp']);
});
