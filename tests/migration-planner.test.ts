import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instancesHandler from '../server/handlers/instances';
import { buildMigrationPlan } from '../server/services/migrationJobs';
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
      formula: 'Omni.OMNI_FX_SUM(orders.total_revenue) / Omni.OMNI_FX_EQUALS(orders.id, orders.id)',
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
  assert.equal(warnings.some((warning) => warning.includes('referenced fields were not found')), false);
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

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string }> };

  assert.equal(body.documents[0].baseModelId, 'model-2');
  assert.equal(body.documents[0].baseModelName, 'Nested Model');
});
