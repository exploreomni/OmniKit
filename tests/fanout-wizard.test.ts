import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  estimateDurationSeconds,
  summarizePlanByTarget,
} from '../src/components/migrateFanout/fanoutUtils';
import { targetDraftToMigrationTarget, type FanoutDraft } from '../src/components/migrateFanout/fanoutTypes';
import { sanitizeFanoutDraftForStorage } from '../src/components/migrateFanout/fanoutStorage';
import type { MigrationPlan, SavedInstancePublic } from '../src/services/opsConsole';

const destination: SavedInstancePublic = {
  id: 'dest-1',
  label: 'Destination One',
  role: 'destination',
  baseUrl: 'https://dest.example.omniapp.co',
  apiKeyMasked: 'omni****1234',
  metricFilter: {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  },
  postMigrationActions: [],
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

test('target drafts convert to migration targets without secrets', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    selectedActionIndexes: [0],
  }, [destination]);

  assert.equal(target.destinationLabel, 'Destination One');
  assert.equal(target.targetModelId, 'model-1');
  assert.equal(target.targetFolderPath, 'Executive/Migrated');
  assert.equal(JSON.stringify(target).includes('omni****1234'), false);
});

test('preflight summaries stay target-scoped when one destination has multiple targets', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [
      {
        id: 'target-a',
        destinationInstanceId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
      },
      {
        id: 'target-b',
        destinationInstanceId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-b',
        targetModelName: 'Model B',
      },
    ],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'import',
        documentId: 'doc-1',
        warnings: ['Model A warning'],
      },
      {
        targetId: 'target-b',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-b',
        kind: 'import',
        documentId: 'doc-1',
      },
    ],
  };

  const summaries = summarizePlanByTarget(plan);

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].steps.length, 1);
  assert.equal(summaries[0].warningCount, 1);
  assert.equal(summaries[1].steps.length, 1);
  assert.equal(summaries[1].warningCount, 0);
});

test('duration estimator uses one source export lane plus the slowest destination lane', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1', 'dest-2'],
    documentIds: ['doc-1', 'doc-2'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [],
    steps: [
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'export', documentId: 'doc-1' },
      { destinationId: 'dest-2', destinationLabel: 'D2', kind: 'export', documentId: 'doc-1' },
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'export', documentId: 'doc-2' },
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'import', documentId: 'doc-1' },
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'metadata', documentId: 'doc-1' },
      { destinationId: 'dest-2', destinationLabel: 'D2', kind: 'import', documentId: 'doc-1' },
    ],
  };

  assert.equal(estimateDurationSeconds(plan), 5);
});

test('preflight summaries count same-name replacements separately from deletes', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
    }],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'delete',
        documentId: 'doc-existing',
        documentName: 'Executive Scorecard',
        replacement: true,
      },
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'import',
        documentId: 'doc-1',
        documentName: 'Executive Scorecard',
      },
    ],
  };

  const [summary] = summarizePlanByTarget(plan);

  assert.equal(summary.deleteCount, 1);
  assert.equal(summary.replaceCount, 1);
});

test('fan-out draft persists schema refresh option without credential fields', () => {
  const draft: FanoutDraft = {
    step: 1,
    sourceId: 'source-1',
    sourceModelId: 'model-source',
    selectedDocumentIds: ['doc-1'],
    sourceFolderId: 'source-folder-1',
    sourceFolderPath: 'Shared/Dashboards',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'model-target',
      targetModelName: 'Target Model',
      targetFolderPath: 'Shared/Migrated',
      targetFolderId: 'folder-1',
      selectedActionIndexes: [0],
    }],
    emptyFirst: false,
    replaceSameNamed: true,
    metadataOnly: false,
    refreshSchemaAfterImport: true,
  };

  const sanitized = sanitizeFanoutDraftForStorage(draft);

  assert.equal(sanitized.refreshSchemaAfterImport, true);
  assert.equal(sanitized.replaceSameNamed, true);
  assert.equal(sanitized.sourceFolderPath, 'Shared/Dashboards');
  assert.equal(JSON.stringify(sanitized).includes('apiKey'), false);
});
