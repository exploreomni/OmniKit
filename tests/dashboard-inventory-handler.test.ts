import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instancesHandler from '../server/handlers/instances';
import {
  OmniClient,
  OmniPaginationError,
  type OmniDocumentInventoryResult,
  type OmniDocumentRecord,
  type OmniFolderInventoryResult,
} from '../server/services/omniClient';
import type { InstanceFolderInventoryResponse } from '../src/services/opsConsole';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { clearReadThroughCache } from '../server/services/readThroughCache';

let tempDir = '';

function saveSource(apiKey = 'source-key') {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clearReadThroughCache();
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-dashboard-inventory-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  unlockVault('inventory passphrase');
  saveSource();
});

afterEach(() => {
  clearReadThroughCache();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(tempDir, { recursive: true, force: true });
});

test('direct lookup verifies dashboard layout and exact connection without scanning the catalog', async () => {
  let stateCalls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => { throw new Error('Must not scan.'); });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async (identifier: string, signal: AbortSignal) => {
    assert.equal(identifier, 'example-dashboard');
    assert.ok(signal instanceof AbortSignal);
    stateCalls += 1;
    return { name: 'Example dashboard', modelId: 'model-a', containers: [], queryPresentations: { data: { secretQuery: {} } } };
  });
  mock.method(OmniClient.prototype, 'listModels', async (options: { modelId: string; connectionId: string }) => {
    assert.equal(options.modelId, 'model-a');
    assert.equal(options.connectionId, 'connection-a');
    return [{ id: 'model-a', name: 'Example model', connectionId: 'connection-a' }];
  });
  const lookup = (reference: string) => instancesHandler(new Request(`http://localhost/api/instances/source-1/document-lookup?connectionId=connection-a&reference=${encodeURIComponent(reference)}`));
  const response = await lookup('https://source.example.omniapp.co/dashboards/example-dashboard?tab=1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.document.identifier, 'example-dashboard');
  assert.equal(body.document.connectionId, 'connection-a');
  assert.equal(body.document.folderPath, undefined, 'unknown is not top level');
  assert.equal(body.document.queryPresentations, undefined, 'do not return query payloads');
  assert.equal((await lookup('example-dashboard')).status, 200);
  assert.equal(stateCalls, 1, 'exact selection metadata can be reused');
  for (const reference of ['https://other.example.omniapp.co/dashboards/example-dashboard', 'https://user:secret@source.example.omniapp.co/dashboards/example-dashboard', 'https://source.example.omniapp.co/workbooks/example-dashboard', '../example-dashboard']) {
    assert.equal((await lookup(reference)).status, 422);
  }
  assert.equal(stateCalls, 1, 'invalid targets never reach Omni');
  saveSource('rotated-fictional-key');
  assert.equal((await lookup('example-dashboard')).status, 200);
  assert.equal(stateCalls, 2, 'credential rotation cannot reuse old lookup evidence');
});

test('direct lookup rejects workbook-only and mismatched ownership and accepts verified extension models', async () => {
  let withLayout = false;
  let connectionId = 'connection-b';
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => ({ name: 'Example', modelId: 'model-a', ...(withLayout ? { containers: [] } : {}) }));
  mock.method(OmniClient.prototype, 'listModels', async (options: { modelKind: string }) => options.modelKind === 'SHARED' ? [] : [{ id: 'model-a', name: 'Example extension', connectionId }]);
  const lookup = () => instancesHandler(new Request('http://localhost/api/instances/source-1/document-lookup?connectionId=connection-a&reference=example-dashboard&forceRefresh=true'));
  assert.equal((await lookup()).status, 422);
  withLayout = true;
  assert.equal((await lookup()).status, 422);
  connectionId = 'connection-a';
  assert.equal((await lookup()).status, 200);
});

test('exact restored IDs return explicit scope and do not imply a complete instance inventory', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => { throw new Error('Must not scan.'); });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async (identifier: string) => {
    calls += 1;
    return { name: identifier, modelId: 'model-a', containers: [] };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'model-a', name: 'Example', connectionId: 'connection-a' }]);
  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?connectionId=connection-a&allFolders=true&documentIds=example-one,example-two,example-one'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls, 2);
  assert.equal(body.inventory.scope, 'explicit_documents');
  assert.equal(body.documents.length, 2);
  assert.equal(Date.parse(body.inventory.cache.expiresAt) - Date.parse(body.inventory.cache.fetchedAt), 900_000);
});

test('streamed browsing shares one inventory, emits real counters, and isolates subscriber cancellation', async () => {
  const pending = deferred<OmniDocumentInventoryResult>();
  const started = deferred<void>();
  let upstreamSignal: AbortSignal | undefined;
  let calls = 0;
  let progress: ((value: { pages: number; returnedRecords: number }) => void) | undefined;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options: { onProgress: typeof progress }, signal: AbortSignal) => {
    calls += 1;
    upstreamSignal = signal;
    progress = options.onProgress;
    started.resolve();
    return pending.promise;
  });
  const request = () => instancesHandler(new Request('http://localhost/api/instances/source-1/documents?connectionId=connection-a&allFolders=true&stream=true'));
  const first = await request();
  const firstReader = first.body!.getReader();
  await firstReader.read();
  await started.promise;
  const second = await request();
  const secondReader = second.body!.getReader();
  await secondReader.read();
  progress?.({ pages: 1, returnedRecords: 1 });
  const update = JSON.parse(new TextDecoder().decode((await secondReader.read()).value));
  assert.deepEqual(update, { type: 'progress', pages: 1, returnedRecords: 1 });
  await firstReader.cancel();
  assert.equal(upstreamSignal?.aborted, false);
  pending.resolve(completeInventory([{ id: 'example-dashboard', identifier: 'example-dashboard', name: 'Example', connectionId: 'connection-a', hasDashboard: true }]));
  const terminal = JSON.parse(new TextDecoder().decode((await secondReader.read()).value));
  assert.equal(terminal.type, 'complete');
  assert.equal(terminal.documents.length, 1);
  assert.equal(terminal.inventory.cache.status, 'shared');
  assert.equal(terminal.inventory.cache.expiresAt && Date.parse(terminal.inventory.cache.expiresAt) - Date.parse(terminal.inventory.cache.fetchedAt), 900_000);
  assert.equal((await secondReader.read()).done, true);
  assert.equal(calls, 1);
  const cached = await request();
  const events = (await cached.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).inventory.cache.status, 'hit');
  assert.equal(calls, 1);
});

test('streamed failure never returns partial documents or caches failed inventory', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options: { onProgress: (value: { pages: number; returnedRecords: number }) => void }) => {
    calls += 1;
    options.onProgress({ pages: 1, returnedRecords: 1 });
    throw new OmniPaginationError();
  });
  const request = () => instancesHandler(new Request('http://localhost/api/instances/source-1/documents?allFolders=true&stream=true'));
  const events = (await (await request()).text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).inventory.complete, false);
  assert.ok(events.every((event) => !event.documents));
  await (await request()).text();
  assert.equal(calls, 2);
});

test('saved-instance folder inventory is complete, credential-bound, refreshable, and never caches partial failures', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listFolders', async () => {
    throw new Error('The complete inventory must not use the legacy folder listing.');
  });
  mock.method(OmniClient.prototype, 'listFolderInventory', async (signal?: AbortSignal): Promise<OmniFolderInventoryResult> => {
    assert.ok(signal instanceof AbortSignal);
    calls += 1;
    if (calls === 4) throw new OmniPaginationError();
    const folders = calls === 5 ? [] : [{ id: `folder-${calls}`, name: 'Folder', path: '/Folder' }];
    return {
      folders,
      pagination: {
        complete: true,
        pages: 1,
        pageSize: 100,
        returnedRecords: folders.length,
        reportedTotalRecords: folders.length,
      },
    };
  });
  const load = (suffix = '', signal?: AbortSignal) => instancesHandler(new Request(
    `http://localhost/api/instances/source-1/folder-inventory${suffix}`,
    { signal },
  ));

  const first = await load();
  assert.equal(first.status, 200);
  const firstBody = await first.json() as InstanceFolderInventoryResponse;
  assert.equal(firstBody.pagination.complete, true);
  assert.equal(firstBody.pagination.returnedRecords, 1);
  assert.equal(firstBody.cache.status, 'miss');
  assert.equal(firstBody.cache.fresh, true);
  assert.ok(firstBody.cache.fetchedAt);
  assert.ok(firstBody.cache.expiresAt);

  const cached = await (await load()).json() as InstanceFolderInventoryResponse;
  assert.equal(cached.cache.status, 'hit');
  assert.equal(calls, 1);
  const refreshed = await (await load('?forceRefresh=true')).json() as InstanceFolderInventoryResponse;
  assert.equal(refreshed.cache.status, 'miss');
  assert.equal(refreshed.folders[0].id, 'folder-2');

  saveSource('replacement-source-key');
  const replacement = await (await load()).json() as InstanceFolderInventoryResponse;
  assert.equal(replacement.cache.status, 'miss');
  assert.equal(replacement.folders[0].id, 'folder-3');

  const incomplete = await load('?forceRefresh=true');
  assert.equal(incomplete.status, 502);
  const incompleteBody = await incomplete.json() as { code: string; folders?: unknown; pagination: { complete: boolean } };
  assert.equal(incompleteBody.code, 'OMNI_PAGINATION_INCOMPLETE');
  assert.equal(incompleteBody.pagination.complete, false);
  assert.equal(incompleteBody.folders, undefined);
  const recovered = await (await load()).json() as InstanceFolderInventoryResponse;
  assert.equal(recovered.cache.status, 'miss');
  assert.equal(recovered.pagination.complete, true);
  assert.deepEqual(recovered.folders, []);
  assert.equal(calls, 5);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await load('', controller.signal);
  assert.equal(cancelled.status, 499);
  const cancelledBody = await cancelled.json() as { code: string; pagination: { complete: boolean } };
  assert.equal(cancelledBody.code, 'FOLDER_INVENTORY_CANCELLED');
  assert.equal(cancelledBody.pagination.complete, false);
  assert.equal(calls, 5);
});

test('dashboard inventory is shared across connections and filters ownership and dashboard evidence fail closed', async () => {
  let calls = 0;
  const requestedOptions: unknown[] = [];
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options?: unknown) => {
    calls += 1;
    requestedOptions.push(options);
    return completeInventory([
      { id: 'a-dashboard', identifier: 'a-dashboard', name: 'A', connectionId: 'connection-a', hasDashboard: true },
      { id: 'b-dashboard', identifier: 'b-dashboard', name: 'B', connectionId: 'connection-b', hasDashboard: true },
      { id: 'unknown-owner', identifier: 'unknown-owner', name: 'Unknown', hasDashboard: true },
      { id: 'not-dashboard', identifier: 'not-dashboard', name: 'Workbook', connectionId: 'connection-a', hasDashboard: false },
    ]);
  });

  const first = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as {
    documents: Array<{ id: string }>;
    inventory: {
      complete: boolean;
      cache: { status: string };
      excluded: Record<string, number>;
    };
  };
  assert.deepEqual(firstBody.documents.map((document) => document.id), ['a-dashboard']);
  assert.equal(firstBody.inventory.complete, true);
  assert.equal(firstBody.inventory.cache.status, 'miss');
  assert.deepEqual(firstBody.inventory.excluded, {
    missingConnectionId: 1,
    otherConnection: 1,
    missingDashboardEvidence: 1,
  });

  const second = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
  ));
  const secondBody = await second.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.equal(second.status, 200);
  assert.deepEqual(secondBody.documents.map((document) => document.id), ['b-dashboard']);
  assert.equal(secondBody.inventory.cache.status, 'hit');
  assert.equal(calls, 1);
  assert.equal(typeof (requestedOptions[0] as { onProgress: unknown }).onProgress, 'function');
  assert.deepEqual(requestedOptions.map((options) => ({ ...(options as object), onProgress: undefined })), [{ includeLabels: true, folderId: undefined, onProgress: undefined }]);
});

test('explicit refresh replaces the completed canonical snapshot and remains credential bound', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    return completeInventory([{
      id: `dashboard-${calls}`,
      identifier: `dashboard-${calls}`,
      name: `Dashboard ${calls}`,
      connectionId: 'connection-a',
      hasDashboard: true,
    }]);
  });

  const load = (suffix = '') => instancesHandler(new Request(
    `http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a${suffix}`,
  ));
  await load();
  const refreshed = await load('&forceRefresh=true');
  const refreshedBody = await refreshed.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.deepEqual(refreshedBody.documents.map((document) => document.id), ['dashboard-2']);
  assert.equal(refreshedBody.inventory.cache.status, 'miss');

  saveSource('replacement-source-key');
  const replacementCredential = await load();
  const replacementBody = await replacementCredential.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.deepEqual(replacementBody.documents.map((document) => document.id), ['dashboard-3']);
  assert.equal(replacementBody.inventory.cache.status, 'miss');
  assert.equal(calls, 3);
});

test('documented folderId stays upstream scoped while connectionId stays local', async () => {
  let requestedOptions: unknown;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options?: unknown) => {
    requestedOptions = options;
    return completeInventory([{
      id: 'folder-dashboard',
      identifier: 'folder-dashboard',
      name: 'Folder dashboard',
      connectionId: 'connection-a',
      folderId: 'folder-1',
      hasDashboard: true,
    }]);
  });

  const response = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?folderId=folder-1&connectionId=connection-a',
  ));
  const body = await response.json() as {
    documents: Array<{ id: string }>;
    inventory: { folderScoped: boolean };
  };
  assert.equal(response.status, 200);
  assert.deepEqual(body.documents.map((document) => document.id), ['folder-dashboard']);
  assert.equal(body.inventory.folderScoped, true);
  assert.deepEqual({ ...(requestedOptions as object), onProgress: undefined }, { includeLabels: true, folderId: 'folder-1', onProgress: undefined });
});

test('a forced refresh coalesces concurrent normal readers onto one new canonical crawl', async () => {
  const refresh = deferred<OmniDocumentInventoryResult>();
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    if (calls === 2) return refresh.promise;
    return completeInventory([{
      id: 'initial-dashboard',
      identifier: 'initial-dashboard',
      name: 'Initial dashboard',
      connectionId: 'connection-a',
      hasDashboard: true,
    }]);
  });

  await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const forcedResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a&forceRefresh=true',
  ));
  const normalResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
  ));
  await Promise.resolve();
  assert.equal(calls, 2);

  refresh.resolve(completeInventory([{
    id: 'refreshed-dashboard-a',
    identifier: 'refreshed-dashboard-a',
    name: 'Refreshed dashboard A',
    connectionId: 'connection-a',
    hasDashboard: true,
  }, {
    id: 'refreshed-dashboard-b',
    identifier: 'refreshed-dashboard-b',
    name: 'Refreshed dashboard B',
    connectionId: 'connection-b',
    hasDashboard: true,
  }]));

  const [forced, normal] = await Promise.all([forcedResponse, normalResponse]);
  const forcedBody = await forced.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  const normalBody = await normal.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.equal(forcedBody.inventory.cache.status, 'miss');
  assert.equal(normalBody.inventory.cache.status, 'shared');
  assert.deepEqual(forcedBody.documents.map((document) => document.id), ['refreshed-dashboard-a']);
  assert.deepEqual(normalBody.documents.map((document) => document.id), ['refreshed-dashboard-b']);
  assert.equal(calls, 2);
});

test('an incomplete crawl fails closed and its next request starts a fresh inventory', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    if (calls === 1) throw new OmniPaginationError();
    return completeInventory([{
      id: 'dashboard-after-retry',
      identifier: 'dashboard-after-retry',
      name: 'Dashboard after retry',
      connectionId: 'connection-a',
      hasDashboard: true,
    }]);
  });

  const incomplete = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const incompleteBody = await incomplete.json() as {
    documents?: unknown[];
    inventory: { complete: boolean };
  };
  assert.equal(incomplete.status, 502);
  assert.equal(incompleteBody.inventory.complete, false);
  assert.equal(incompleteBody.documents, undefined);

  const retry = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const retryBody = await retry.json() as {
    documents: Array<{ id: string }>;
    inventory: { complete: boolean; cache: { status: string } };
  };
  assert.equal(retry.status, 200);
  assert.equal(retryBody.inventory.complete, true);
  assert.equal(retryBody.inventory.cache.status, 'miss');
  assert.deepEqual(retryBody.documents.map((document) => document.id), ['dashboard-after-retry']);
  assert.equal(calls, 2);
});

test('cancelling one endpoint subscriber preserves the shared upstream crawl for the remaining reader', async () => {
  const crawl = deferred<OmniDocumentInventoryResult>();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (_options, signal) => {
    calls += 1;
    upstreamSignal = signal;
    return crawl.promise;
  });

  const firstResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
    { signal: firstController.signal },
  ));
  const secondResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
    { signal: secondController.signal },
  ));
  await Promise.resolve();
  assert.equal(calls, 1);

  firstController.abort(new DOMException('The first reader left.', 'AbortError'));
  const cancelled = await firstResponse;
  assert.equal(cancelled.status, 499);
  assert.equal(upstreamSignal?.aborted, false);

  crawl.resolve(completeInventory([{
    id: 'shared-dashboard-b',
    identifier: 'shared-dashboard-b',
    name: 'Shared dashboard B',
    connectionId: 'connection-b',
    hasDashboard: true,
  }]));
  const shared = await secondResponse;
  const sharedBody = await shared.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.equal(shared.status, 200);
  assert.equal(sharedBody.inventory.cache.status, 'shared');
  assert.deepEqual(sharedBody.documents.map((document) => document.id), ['shared-dashboard-b']);
  assert.equal(calls, 1);
});

test('large catalogs are indexed once and reused across connections without exposing credentials', async () => {
  const documents: OmniDocumentRecord[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `example-dashboard-${index}`,
    identifier: `example-dashboard-${index}`,
    name: `Example dashboard ${index}`,
    connectionId: index % 2 === 0 ? 'connection-a' : 'connection-b',
    hasDashboard: true,
  }));
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    return completeInventory(documents);
  });

  const first = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const firstText = await first.text();
  const firstBody = JSON.parse(firstText) as {
    documents: Array<{ connectionId?: string }>;
    performance: { timings: Array<{ name: string }> };
  };
  const second = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
  ));
  const secondText = await second.text();
  const secondBody = JSON.parse(secondText) as {
    documents: Array<{ connectionId?: string }>;
    inventory: { cache: { status: string } };
  };

  assert.equal(calls, 1);
  assert.equal(firstBody.documents.length, 5_000);
  assert.equal(secondBody.documents.length, 5_000);
  assert.ok(firstBody.documents.every((document) => document.connectionId === 'connection-a'));
  assert.ok(secondBody.documents.every((document) => document.connectionId === 'connection-b'));
  assert.equal(secondBody.inventory.cache.status, 'hit');
  assert.ok(firstBody.performance.timings.some((timing) => timing.name === 'select-connection-partition'));
  assert.equal(firstBody.performance.timings.some((timing) => timing.name === 'filter-connection'), false);
  assert.equal(firstText.includes('source-key'), false);
  assert.equal(secondText.includes('source-key'), false);
});
