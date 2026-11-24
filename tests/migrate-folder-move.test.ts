import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import migrate from '../server/handlers/migrate';

const internalId = 'e87ac93e-1ffd-457c-8850-c6cb03189052';
const slug = 'quarterly-results-copy';

async function run(importResult: unknown, { importStatus = 200, moveStatus = 200 } = {}) {
  const calls: string[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const { hostname, pathname } = new URL(url);
    calls.push(init.method + ' ' + pathname);
    if (init.method === 'GET') {
      assert.equal(hostname, 'from.example.invalid');
      return Response.json({ name: 'Quarterly results', baseModelId: 'source-model' });
    }
    assert.equal(hostname, 'to.example.invalid');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer target-test-key');
    if (init.method === 'POST') return Response.json(importResult, { status: importStatus });
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init.body)), { folderPath: '/reports' });
    return Response.json({ success: moveStatus === 200 }, { status: moveStatus });
  });
  try {
    const response = await migrate(new Request('http://localhost/api/migrate', {
      method: 'POST',
      body: JSON.stringify({
        dashboards: [{ id: 'original', name: 'Quarterly results', base_model_id: 'source-model' }],
        source: { base_url: 'https://from.example.invalid', api_key: 'source-test-key' },
        target: { base_url: 'https://to.example.invalid', api_key: 'target-test-key' },
        model_mapping: { 'source-model': 'target-model' }, target_folder: '/reports', dry_run: false,
      }),
    }));
    const events = (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    return { calls, result: events.at(-1).results[0] };
  } finally {
    fetchMock.mock.restore();
  }
}

test('legacy migration moves the new workbook using its published identifier', async () => {
  for (const response of [
    { dashboard: { id: internalId }, workbook: { id: internalId, documentId: internalId, identifier: slug } },
    { id: internalId, identifier: slug },
    { id: internalId, result: { document: { identifier: slug } } },
  ]) {
    const { calls, result } = await run(response);
    assert.equal(result.status, 'success');
    assert.deepEqual(calls.filter(call => call.startsWith('PUT')), ['PUT /api/v1/documents/' + slug + '/move']);
  }
});

test('legacy migration holds the move when the import has conflicting or missing identifiers', async () => {
  for (const response of [
    { dashboard: { id: internalId }, workbook: { documentId: internalId } },
    { identifier: 'unrelated-document', workbook: { identifier: slug } },
    { workbook: { identifier: '../../different-document' } },
  ]) {
    const { calls, result } = await run(response);
    assert.equal(result.status, 'warning');
    assert.ok(calls.every(call => !call.startsWith('PUT')));
  }
});

test('legacy migration sends each write once when a response is ambiguous', async () => {
  const imported = await run({ identifier: slug }, { importStatus: 503 });
  assert.equal(imported.result.status, 'failed');
  assert.match(imported.result.error, /Inspect the destination/);
  assert.equal(imported.calls.filter(call => call.startsWith('POST')).length, 1);
  assert.ok(imported.calls.every(call => !call.startsWith('PUT')));
  const moved = await run({ identifier: slug }, { moveStatus: 503 });
  assert.equal(moved.result.status, 'warning');
  assert.deepEqual(moved.calls.filter(call => call.startsWith('PUT')), ['PUT /api/v1/documents/' + slug + '/move']);
});
