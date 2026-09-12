import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listDocuments, omniProxy } from '../src/services/omniApi';

test('content-label API transport forwards all-document intent and cancellation without serializing the signal', async (t) => {
  const controller = new AbortController();
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    requests.push({ url: String(input), init, body });
    return new Response(JSON.stringify(
      String(input).endsWith('/api/list-documents')
        ? { documents: [], complete: true, loadedResults: 0, totalResults: 0 }
        : { records: [] },
    ), { headers: { 'Content-Type': 'application/json' } });
  });

  await listDocuments(
    'https://transport-fixture.omniapp.co',
    'transport-fixture-key',
    undefined,
    {
      allPages: true,
      pageSize: 100,
      includeAllDocuments: true,
      forceRefresh: true,
      signal: controller.signal,
    },
  );
  await omniProxy(
    'https://transport-fixture.omniapp.co',
    'transport-fixture-key',
    'GET',
    '/v1/labels',
    { signal: controller.signal },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body.include_all_documents, true);
  assert.equal(requests[0]?.init?.signal, controller.signal);
  assert.equal(requests[1]?.init?.signal, controller.signal);
  assert.equal('signal' in requests[1]!.body, false);
});
