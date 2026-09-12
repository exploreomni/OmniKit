import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/services/omniApi';
import { readInstanceDocumentsStream, type InstanceDocumentsProgress } from '../src/services/instanceDocumentsStream';
import { listInstanceDocuments, lookupInstanceDocument, streamInstanceDocuments, type InstanceDocument, type InstanceDocumentsResponse } from '../src/services/opsConsole';
import { hasVerifiedDashboardSelection, mergeVerifiedDashboardDocuments, sourceConnectionEmptyLabel, sourceConnectionLoadError } from '../src/components/dashboardMigration/dashboardSourceSelection';

const dashboard = (id: string, connectionId = 'example-connection'): InstanceDocument => ({ id, identifier: id, name: `Example dashboard ${id}`, connectionId });
const complete = (): InstanceDocumentsResponse => ({
  documents: [dashboard('example-dashboard')],
  inventory: { complete: true, scope: 'credential', cache: { status: 'hit', fetchedAt: '2026-09-10T12:00:00Z', expiresAt: '2026-09-10T12:15:00Z', ageMs: 1000, fresh: true }, pagination: { pages: 2, pageSize: 100, returnedRecords: 101, reportedTotalRecords: 101 }, sourceRecordCount: 101, matchedRecordCount: 1, excluded: { missingConnectionId: 0, otherConnection: 100, missingDashboardEvidence: 0 } },
});

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('source connection timeout feedback distinguishes a failed read from a verified empty catalog', () => {
  for (const code of ['MODEL_MIGRATOR_READINESS_TIMEOUT', 'MODEL_MIGRATOR_UPSTREAM_TIMEOUT']) {
    const message = sourceConnectionLoadError(new ApiError(504, 'Model Migrator readiness exceeded its deadline.', undefined, code));
    assert.match(message, /Loading source connections timed out/);
    assert.match(message, /waiting for API capacity or a response from Omni/);
    assert.match(message, /does not require a page refresh/);
    assert.doesNotMatch(message, /readiness/i);
    for (const loaded of [false, true]) {
      const label = sourceConnectionEmptyLabel({ error: message, loaded });
      assert.match(label, /could not be loaded/);
      assert.doesNotMatch(label, /No active/);
    }
  }
  assert.equal(sourceConnectionEmptyLabel({ error: '', loaded: true }), 'No active source connections found');
  assert.equal(sourceConnectionEmptyLabel({ error: '', loaded: false }), 'Source connections have not been loaded yet');
});

test('source connection feedback preserves credential and other errors without treating them as timeouts', () => {
  const rejected = new ApiError(403, 'The saved Omni credential was rejected.', undefined, 'MODEL_MIGRATOR_CREDENTIAL_REJECTED');
  assert.equal(sourceConnectionLoadError(rejected), rejected.message);
  assert.equal(sourceConnectionLoadError(new Error('Example catalog failure')), 'Example catalog failure');
  assert.equal(sourceConnectionLoadError(undefined), 'Could not load source connections.');
});

test('direct choices merge without duplicates or loss of previously supplied metadata', () => {
  const first = { ...dashboard('one'), folderPath: 'Example folder' };
  const existing = [first];
  const merged = mergeVerifiedDashboardDocuments(existing, [dashboard('one'), dashboard('two')], 'example-connection');
  assert.deepEqual(merged.map((document) => document.identifier), ['one', 'two']);
  assert.equal(merged[0].folderPath, 'Example folder');
  assert.deepEqual(existing, [first]);
  assert.equal(hasVerifiedDashboardSelection(merged, ['one', 'two'], 'example-connection'), true);
  assert.equal(hasVerifiedDashboardSelection(merged, ['one', 'missing'], 'example-connection'), false);
  assert.equal(hasVerifiedDashboardSelection(merged, [], 'example-connection'), false);
  assert.equal(hasVerifiedDashboardSelection(merged, ['one'], 'another-connection'), false);
  assert.throws(() => mergeVerifiedDashboardDocuments(existing, [dashboard('two', 'another-connection')], 'example-connection'), /did not match/);
});

test('stream counters never expose partial documents and completion works across split chunks', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const progress: InstanceDocumentsProgress[] = [];
  let progressReceived!: () => void;
  const firstProgress = new Promise<void>((resolve) => { progressReceived = resolve; });
  let settled = false;
  const result = readInstanceDocumentsStream(response, (event) => { progress.push(event); progressReceived(); }).then((value) => { settled = true; return value; });
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'progress', pages: 1, returnedRecords: 100, reportedTotalRecords: 101, documents: [dashboard('not-usable-yet')] })}\n`));
  await firstProgress;
  assert.equal(settled, false);
  assert.deepEqual(progress, [{ pages: 1, returnedRecords: 100, reportedTotalRecords: 101 }]);
  const terminal = encoder.encode(JSON.stringify({ type: 'complete', ...complete() }));
  controller.enqueue(terminal.slice(0, 29));
  controller.enqueue(terminal.slice(29));
  controller.close();
  assert.deepEqual((await result).documents, complete().documents);
});

test('missing completion, incomplete completion, and terminal errors never return partial lists', async () => {
  await assert.rejects(readInstanceDocumentsStream(ndjson([{ type: 'progress', pages: 1, returnedRecords: 100 }])), /before completion/);
  await assert.rejects(readInstanceDocumentsStream(ndjson([{ type: 'complete', ...complete(), inventory: { ...complete().inventory, complete: false } }])), /incomplete/);
  await assert.rejects(readInstanceDocumentsStream(ndjson([{ type: 'progress', pages: 1, returnedRecords: 100 }, { type: 'error', error: 'Example deadline reached', code: 'EXAMPLE_DEADLINE' }])), (error: unknown) => error instanceof ApiError && error.message === 'Example deadline reached' && error.code === 'EXAMPLE_DEADLINE');
});

test('ordinary JSON errors preserve their status and JSON complete cache responses are usable', async () => {
  await assert.rejects(readInstanceDocumentsStream(new Response(JSON.stringify({ error: 'Example rate limit', code: 'EXAMPLE_RATE_LIMIT' }), { status: 429, headers: { 'Content-Type': 'application/json' } })), (error: unknown) => error instanceof ApiError && error.status === 429 && error.code === 'EXAMPLE_RATE_LIMIT');
  const cached = await readInstanceDocumentsStream(new Response(JSON.stringify(complete()), { headers: { 'Content-Type': 'application/json' } }));
  assert.equal(cached.inventory.cache.status, 'hit');
  assert.equal(cached.inventory.cache.fetchedAt, '2026-09-10T12:00:00Z');
});

test('canceling while a stream is pending cancels its reader and rejects late completion', async () => {
  const abort = new AbortController();
  let canceled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const result = readInstanceDocumentsStream(response, undefined, abort.signal);
  abort.abort();
  await assert.rejects(result, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(canceled, true);
});

test('lookup, selected-ID hydration, and streaming use distinct scoped requests without forced refresh', async (t) => {
  const calls: Array<{ url: URL; signal: AbortSignal | null | undefined }> = [];
  const abort = new AbortController();
  const reference = 'https://source.example.test/dashboards/example-dashboard?view=one';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'https://local.example.test');
    calls.push({ url, signal: init?.signal });
    if (url.pathname.endsWith('/document-lookup')) return new Response(JSON.stringify({ document: dashboard('example-dashboard') }), { headers: { 'Content-Type': 'application/json' } });
    if (url.searchParams.has('stream')) return ndjson([{ type: 'complete', ...complete() }]);
    return new Response(JSON.stringify({ ...complete(), inventory: { ...complete().inventory, scope: 'explicit_documents' } }), { headers: { 'Content-Type': 'application/json' } });
  });
  await lookupInstanceDocument('source instance', { connectionId: 'example-connection', reference, signal: abort.signal });
  await listInstanceDocuments('source instance', { connectionId: 'example-connection', documentIds: ['example-dashboard'], allFolders: true, signal: abort.signal });
  await streamInstanceDocuments('source instance', { connectionId: 'example-connection', allFolders: true, signal: abort.signal });
  assert.equal(calls[0].url.pathname, '/api/instances/source%20instance/document-lookup');
  assert.equal(calls[0].url.searchParams.get('reference'), reference);
  assert.equal(calls[1].url.searchParams.get('documentIds'), 'example-dashboard');
  assert.equal(calls[1].url.searchParams.has('stream'), false);
  assert.equal(calls[2].url.searchParams.get('stream'), 'true');
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('connectionId'), 'example-connection');
    assert.equal(call.url.searchParams.has('forceRefresh'), false);
    assert.equal(call.signal, abort.signal);
  }
});

test('a lookup returned for another connection cannot become a verified selection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ document: dashboard('example-dashboard', 'another-connection') }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(lookupInstanceDocument('source', { connectionId: 'example-connection', reference: 'example-dashboard' }), /did not match the selected source connection/);
});
