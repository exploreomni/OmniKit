import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instancesHandler from '../server/handlers/instances';
import {
  OmniClient,
  type OmniDocumentInventoryResult,
  type OmniDocumentRecord,
} from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { clearReadThroughCache } from '../server/services/readThroughCache';

let tempDir = '';

function completeInventory(documents: OmniDocumentRecord[]): OmniDocumentInventoryResult {
  return {
    documents,
    pagination: {
      complete: true,
      pages: 1,
      pageSize: 100,
      returnedRecords: documents.length,
      reportedTotalRecords: documents.length,
      responseBytes: 512,
    },
  };
}

function saveInstance(): void {
  upsertInstance({
    id: 'source-metadata',
    label: 'Source metadata',
    role: 'source',
    baseUrl: 'https://source-metadata.example.omniapp.co',
    apiKey: 'source-metadata-key',
    defaultFolderId: 'saved-default-folder-id',
    defaultFolderPath: 'Saved default folder',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

beforeEach(() => {
  clearReadThroughCache();
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-dashboard-metadata-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  unlockVault('metadata passphrase');
  saveInstance();
});

afterEach(() => {
  clearReadThroughCache();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(tempDir, { recursive: true, force: true });
});

test('an explicit folder path overrides the saved default folder id', async () => {
  let inventoryOptions: Parameters<OmniClient['listDocumentInventory']>[0];
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options?: Parameters<OmniClient['listDocumentInventory']>[0]) => {
    inventoryOptions = options;
    return completeInventory([{
      id: 'explicit-path-dashboard',
      identifier: 'explicit-path-dashboard',
      name: 'Explicit path dashboard',
      connectionId: 'connection-a',
      folderPath: 'Explicit path',
      hasDashboard: true,
    }]);
  });

  const response = await instancesHandler(new Request(
    'http://localhost/api/instances/source-metadata/documents?folderPath=Explicit%20path&connectionId=connection-a',
  ));
  const body = await response.json() as { documents: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.deepEqual(body.documents.map((document) => document.id), ['explicit-path-dashboard']);
  assert.ok(inventoryOptions);
  const { onProgress, ...scopeOptions } = inventoryOptions;
  assert.equal(typeof onProgress, 'function');
  assert.deepEqual(scopeOptions, { includeLabels: true, folderId: undefined });
});

test('model-detail requests reject oversized identifier batches before starting an inventory crawl', async () => {
  let inventoryCalls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    inventoryCalls += 1;
    return completeInventory([]);
  });
  const ids = Array.from({ length: 51 }, (_, index) => `dashboard-${index}`).join(',');

  const response = await instancesHandler(new Request(
    `http://localhost/api/instances/source-metadata/documents?allFolders=true&connectionId=connection-a&includeModelDetails=true&documentIds=${ids}`,
  ));
  const body = await response.json() as { code: string; inventory: { complete: boolean } };

  assert.equal(response.status, 413);
  assert.equal(body.code, 'DOCUMENT_METADATA_BATCH_TOO_LARGE');
  assert.equal(body.inventory.complete, false);
  assert.equal(inventoryCalls, 0);
});

test('model-detail enrichment is ordered, cancellation-aware, bounded to two workers, and memoizes model YAML', async () => {
  const documents: OmniDocumentRecord[] = Array.from({ length: 3 }, (_, index) => ({
    id: `dashboard-${index}`,
    identifier: `dashboard-${index}`,
    name: `Dashboard ${index}`,
    connectionId: 'connection-a',
    hasDashboard: true,
  }));
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => completeInventory(documents));

  const observedSignals: AbortSignal[] = [];
  let activeDocumentReads = 0;
  let maxActiveDocumentReads = 0;
  let yamlCalls = 0;
  const boundedRead = async (signal?: AbortSignal) => {
    assert.ok(signal);
    observedSignals.push(signal);
    activeDocumentReads += 1;
    maxActiveDocumentReads = Math.max(maxActiveDocumentReads, activeDocumentReads);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeDocumentReads -= 1;
  };

  mock.method(OmniClient.prototype, 'listModels', async (_options, signal) => {
    assert.ok(signal);
    observedSignals.push(signal);
    return [{ id: 'model-a', name: 'Model A', connectionId: 'connection-a', deletedAt: null }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async (_identifier, signal) => {
    await boundedRead(signal);
    return { sharedModelId: 'model-a' };
  });
  mock.method(OmniClient.prototype, 'getDocumentQueries', async (_identifier, signal) => {
    await boundedRead(signal);
    return [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async (_modelId, signal) => {
    yamlCalls += 1;
    await boundedRead(signal);
    return { 'topic_a.topic': 'label: Topic A\n' };
  });

  const response = await instancesHandler(new Request(
    'http://localhost/api/instances/source-metadata/documents?allFolders=true&connectionId=connection-a&includeModelDetails=true&documentIds=dashboard-0,dashboard-1,dashboard-2',
  ));
  const body = await response.json() as {
    documents: Array<{ id: string; baseModelId?: string; topicIds?: string[] }>;
    inventory: { complete: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(body.inventory.complete, true);
  assert.deepEqual(body.documents.map((document) => document.id), [
    'dashboard-0',
    'dashboard-1',
    'dashboard-2',
  ]);
  assert.ok(body.documents.every((document) => document.baseModelId === 'model-a'));
  assert.ok(body.documents.every((document) => document.topicIds?.[0] === 'topic_a'));
  assert.equal(yamlCalls, 1);
  assert.equal(maxActiveDocumentReads, 2);
  assert.ok(observedSignals.length > 0);
  assert.equal(new Set(observedSignals).size, 1);
  assert.equal(observedSignals[0].aborted, false);
});

test('cancelling model-detail enrichment aborts its upstream work and returns a cancellation response', async () => {
  const document = {
    id: 'dashboard-cancel',
    identifier: 'dashboard-cancel',
    name: 'Dashboard cancel',
    connectionId: 'connection-a',
    hasDashboard: true,
  } satisfies OmniDocumentRecord;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => completeInventory([document]));
  mock.method(OmniClient.prototype, 'listModels', async () => []);
  let enrichmentSignal: AbortSignal | undefined;
  let enrichmentStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    enrichmentStarted = resolve;
  });
  mock.method(OmniClient.prototype, 'exportDocument', async (_identifier, signal) => {
    enrichmentSignal = signal;
    enrichmentStarted();
    return new Promise<Record<string, unknown>>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });

  const controller = new AbortController();
  const pending = instancesHandler(new Request(
    'http://localhost/api/instances/source-metadata/documents?allFolders=true&connectionId=connection-a&includeModelDetails=true&documentIds=dashboard-cancel',
    { signal: controller.signal },
  ));
  await started;
  controller.abort(new DOMException('The caller left.', 'AbortError'));

  const response = await pending;
  const body = await response.json() as { code: string };
  assert.equal(response.status, 499);
  assert.equal(body.code, 'INSTANCE_REQUEST_CANCELLED');
  assert.equal(enrichmentSignal?.aborted, true);
});
