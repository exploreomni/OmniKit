import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  acquireOmniRequestSlot,
  OmniClient,
  OmniPaginationError,
  resetOmniClientRateLimitStateForTests,
  type OmniDocumentInventoryProgress,
} from '../server/services/omniClient';

beforeEach(resetOmniClientRateLimitStateForTests);
afterEach(resetOmniClientRateLimitStateForTests);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('background saturation preserves five interactive starts within the same rolling budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const key = 'fictional-reserved-priority-key';
  await Promise.all(Array.from({ length: 50 }, () => acquireOmniRequestSlot(key, undefined, 'background')));
  const started: string[] = [];
  const background = [
    acquireOmniRequestSlot(key, undefined, 'background').then(() => started.push('background-a')),
    acquireOmniRequestSlot(key, undefined, 'background').then(() => started.push('background-b')),
  ];
  await flush();
  assert.deepEqual(started, [], 'background must stop after 50 total starts');
  await Promise.all(Array.from({ length: 5 }, (_, index) => acquireOmniRequestSlot(key).then(() => started.push(`interactive-${index}`))));
  assert.deepEqual(started, ['interactive-0', 'interactive-1', 'interactive-2', 'interactive-3', 'interactive-4']);
  const finalInteractive = acquireOmniRequestSlot(key).then(() => started.push('interactive-5'));
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(started.length, 5, 'the reserved starts do not raise the overall limit above 55');
  t.mock.timers.tick(1);
  await Promise.all([...background, finalInteractive]);
  assert.deepEqual(started.slice(5), ['interactive-5', 'background-a', 'background-b']);
});

test('background quota includes interactive starts and retains cancellation, credential isolation, and exact rollover', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const key = 'fictional-mixed-priority-key';
  await Promise.all(Array.from({ length: 5 }, () => acquireOmniRequestSlot(key)));
  t.mock.timers.tick(10_000);
  await Promise.all(Array.from({ length: 45 }, () => acquireOmniRequestSlot(key, undefined, 'background')));
  const controller = new AbortController();
  const reason = new Error('Example background request canceled');
  const canceled = assert.rejects(acquireOmniRequestSlot(key, controller.signal, 'background'), (error) => error === reason);
  let backgroundStarted = false;
  const background = acquireOmniRequestSlot(key, undefined, 'background').then(() => { backgroundStarted = true; });
  controller.abort(reason);
  await canceled;
  await acquireOmniRequestSlot('fictional-unrelated-background-key', undefined, 'background');
  await Promise.all(Array.from({ length: 5 }, () => acquireOmniRequestSlot(key)));
  t.mock.timers.tick(50_000);
  await flush();
  assert.equal(backgroundStarted, false, 'five expired starts still leave 50; background needs total starts below 50');
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(backgroundStarted, false);
  t.mock.timers.tick(1);
  await background;
  assert.equal(backgroundStarted, true);
});

test('listConnections uses reserved interactive capacity before its overall deadline while background waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const instance = {
    apiKey: 'fictional-connections-reserve-key', baseUrl: 'https://93.184.216.34', label: 'Example connection picker',
  };
  await Promise.all(Array.from({ length: 50 }, () => acquireOmniRequestSlot(instance.apiKey, undefined, 'background')));
  const calls: Array<{ priority: string; path: string }> = [];
  const fetchFor = (priority: string): typeof fetch => async (input) => {
    calls.push({ priority, path: new URL(String(input)).pathname });
    return new Response(JSON.stringify({ records: [{ id: 'example-connection', name: 'Example connection' }] }), { status: 200 });
  };
  const background = new OmniClient(instance, { requestPriority: 'background', maxReadRetries: 0, fetchImpl: fetchFor('background') }).listConnections();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Example source picker deadline')), 30_000);
  const interactive = new OmniClient(instance, {
    signal: controller.signal, requestTimeoutMs: 10_000, maxReadRetries: 0, fetchImpl: fetchFor('interactive'),
  }).listConnections();
  await flush();
  assert.deepEqual(calls, [{ priority: 'interactive', path: '/api/v1/connections' }]);
  assert.equal((await interactive)[0]?.id, 'example-connection');
  assert.equal(Date.now(), 0, 'the connection GET does not wait for the rolling window or overall timeout');
  clearTimeout(timeout);
  t.mock.timers.tick(60_000);
  await background;
  assert.deepEqual(calls.map((call) => call.priority), ['interactive', 'background']);
});

test('interactive requests overtake waiting background requests without bypassing the rolling budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const key = 'fictional-priority-window-key';
  await acquireOmniRequestSlot(key);
  t.mock.timers.tick(10_000);
  await Promise.all(Array.from({ length: 54 }, () => acquireOmniRequestSlot(key)));
  const started: string[] = [];
  const pending = [
    acquireOmniRequestSlot(key, undefined, 'background').then(() => started.push('background-a')),
    acquireOmniRequestSlot(key, undefined, 'background').then(() => started.push('background-b')),
    acquireOmniRequestSlot(key).then(() => started.push('interactive-a')),
    acquireOmniRequestSlot(key).then(() => started.push('interactive-b')),
  ];
  t.mock.timers.tick(49_999);
  await flush();
  assert.deepEqual(started, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(started, ['interactive-a'], 'only the one expired slot is available');
  t.mock.timers.tick(9_999);
  await flush();
  assert.deepEqual(started, ['interactive-a'], 'priority does not grant an extra slot');
  t.mock.timers.tick(1);
  await Promise.all(pending);
  assert.deepEqual(started, ['interactive-a', 'interactive-b', 'background-a', 'background-b']);
});

test('queued cancellation settles promptly and does not consume a slot or disturb FIFO peers', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const key = 'fictional-priority-abort-key';
  await Promise.all(Array.from({ length: 55 }, () => acquireOmniRequestSlot(key)));
  const started: string[] = [];
  const background = acquireOmniRequestSlot(key, undefined, 'background').then(() => started.push('background'));
  const controller = new AbortController();
  const reason = new Error('Example inventory cancelled');
  const cancelled = assert.rejects(acquireOmniRequestSlot(key, controller.signal), (error) => error === reason);
  const interactive = acquireOmniRequestSlot(key).then(() => started.push('interactive'));
  controller.abort(reason);
  await cancelled;
  await acquireOmniRequestSlot('fictional-independent-key');
  assert.deepEqual(started, [], 'a different key can proceed without releasing this key');
  t.mock.timers.tick(60_000);
  await Promise.all([background, interactive]);
  assert.deepEqual(started, ['interactive', 'background']);
  await Promise.all(Array.from({ length: 53 }, () => acquireOmniRequestSlot(key)));
  const lastController = new AbortController();
  const lastWaiter = assert.rejects(acquireOmniRequestSlot(key, lastController.signal), { name: 'AbortError' });
  lastController.abort();
  await lastWaiter;
  // Removing the final waiter cleans its timer, but retains the consumed budget.
  let resumed = false;
  const resumedWaiter = acquireOmniRequestSlot(key).then(() => { resumed = true; });
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(resumed, false);
  t.mock.timers.tick(1);
  await resumedWaiter;
});

test('OmniClient defaults to interactive and honors an explicit background request policy', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const instance = {
    apiKey: 'fictional-client-priority-key',
    baseUrl: 'https://93.184.216.34',
    label: 'Example inventory instance',
  };
  await Promise.all(Array.from({ length: 55 }, () => acquireOmniRequestSlot(instance.apiKey)));
  const started: string[] = [];
  const fetchFor = (name: string): typeof fetch => async () => {
    started.push(name);
    return new Response(JSON.stringify({ records: [] }), { status: 200 });
  };
  const background = new OmniClient(instance, {
    requestPriority: 'background',
    maxReadRetries: 0,
    fetchImpl: fetchFor('background'),
  });
  const interactive = new OmniClient(instance, { maxReadRetries: 0, fetchImpl: fetchFor('interactive') });
  const pending = [background.test(), interactive.test()];
  await flush();
  assert.deepEqual(started, []);
  t.mock.timers.tick(60_000);
  await Promise.all(pending);
  assert.deepEqual(started, ['interactive', 'background']);
});

function inventoryPage(index: number, totalRecords: number, nextCursor: string | null): Response {
  return new Response(JSON.stringify({
    records: [{ id: `example-document-${index}`, identifier: `example-document-${index}`, name: 'Example dashboard' }],
    pageInfo: { totalRecords, hasNextPage: nextCursor !== null, nextCursor },
  }), { status: 200 });
}

for (const mode of ['stable', 'remaining'] as const) {
  test(`inventory emits detached counter-only progress for each valid ${mode}-total page`, async () => {
    let requests = 0;
    const progress: OmniDocumentInventoryProgress[] = [];
    const client = new OmniClient({
      apiKey: `fictional-progress-${mode}-key`,
      baseUrl: 'https://93.184.216.34',
      label: 'Example inventory instance',
    }, {
      maxReadRetries: 0,
      fetchImpl: async () => {
        requests += 1;
        return inventoryPage(requests, mode === 'remaining' && requests === 2 ? 1 : 2, requests === 1 ? 'example-next' : null);
      },
    });
    const result = await client.listDocumentInventory({ onProgress: (update) => {
      progress.push({ ...update });
      update.pages = -1;
      if (requests === 1) throw new Error('Example observer failure');
    } });
    assert.equal(requests, 2, 'progress observers must not trigger additional reads');
    assert.deepEqual(progress, [
      { pages: 1, returnedRecords: 1, reportedTotalRecords: 2 },
      { pages: 2, returnedRecords: 2, reportedTotalRecords: 2 },
    ]);
    assert.equal(result.pagination.pages, 2);
    assert.equal(result.documents.length, 2);
  });
}

for (const invalidPage of ['missing-cursor', 'inconsistent-total', 'short-terminal'] as const) {
  test(`inventory does not report progress for a ${invalidPage} page`, async () => {
    let requests = 0;
    const progress: OmniDocumentInventoryProgress[] = [];
    const client = new OmniClient({
      apiKey: `fictional-invalid-progress-${invalidPage}-key`,
      baseUrl: 'https://93.184.216.34',
      label: 'Example inventory instance',
    }, {
      maxReadRetries: 0,
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) return inventoryPage(1, 3, 'example-next');
        if (invalidPage === 'missing-cursor') {
          return new Response(JSON.stringify({
            records: [{ id: 'example-document-2' }],
            pageInfo: { totalRecords: 3, hasNextPage: true, nextCursor: null },
          }), { status: 200 });
        }
        return inventoryPage(2, invalidPage === 'inconsistent-total' ? 9 : 3, null);
      },
    });
    await assert.rejects(client.listDocumentInventory({ onProgress: (update) => progress.push(update) }), OmniPaginationError);
    assert.equal(requests, 2);
    assert.deepEqual(progress, [{ pages: 1, returnedRecords: 1, reportedTotalRecords: 3 }]);
  });
}
