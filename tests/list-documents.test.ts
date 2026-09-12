import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import listDocumentsHandler from '../server/handlers/list-documents';

afterEach(() => mock.restoreAll());

test('list documents requests labels and preserves known-empty versus unavailable label state', async () => {
  const requestedUrls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
      records: [
        {
          identifier: 'known-empty',
          name: 'Known empty',
          url: 'https://example.omniapp.co/dashboards/known-empty',
          labels: [],
          hasDashboard: true,
          connectionId: 'connection-123',
          baseModelId: 'model-456',
        },
        { identifier: 'known-labels', name: 'Known labels', labels: ['Finance'], hasDashboard: true },
        { identifier: 'unavailable', name: 'Unavailable', hasDashboard: true },
        { identifier: 'workbook-only', name: 'Workbook only', hasDashboard: false, type: 'workbook' },
      ],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 4, totalRecords: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const invoke = (includeAllDocuments = false) => listDocumentsHandler(
    new Request('http://localhost/api/list-documents', {
      method: 'POST',
      body: JSON.stringify({
        base_url: 'https://8.8.8.8',
        api_key: 'test-key',
        all_pages: true,
        include_all_documents: includeAllDocuments,
      }),
    }),
    {
      fetch: fetch as typeof globalThis.fetch,
      validateOutbound: async () => undefined,
      acquireRequestSlot: async () => undefined,
    },
  );

  const response = await invoke();
  const body = await response.json() as {
    documents: Array<{
      id: string;
      url?: string;
      labels?: string[];
      connectionId?: string;
      baseModelId?: string;
    }>;
  };
  const allDocumentsResponse = await invoke(true);
  const allDocumentsBody = await allDocumentsResponse.json() as { documents: Array<{ id: string }> };

  assert.equal(response.status, 200);
  assert.equal(new URL(requestedUrls[0]!).searchParams.get('include'), 'labels');
  assert.deepEqual(body.documents.find((doc) => doc.id === 'known-empty')?.labels, []);
  assert.equal(body.documents.find((doc) => doc.id === 'known-empty')?.url, 'https://example.omniapp.co/dashboards/known-empty');
  assert.equal(body.documents.find((doc) => doc.id === 'known-empty')?.connectionId, 'connection-123');
  assert.equal(body.documents.find((doc) => doc.id === 'known-empty')?.baseModelId, 'model-456');
  assert.deepEqual(body.documents.find((doc) => doc.id === 'known-labels')?.labels, ['Finance']);
  assert.equal('labels' in (body.documents.find((doc) => doc.id === 'unavailable') || {}), false);
  assert.equal(body.documents.some((doc) => doc.id === 'workbook-only'), false);
  assert.equal(allDocumentsResponse.status, 200);
  assert.equal(allDocumentsBody.documents.some((doc) => doc.id === 'workbook-only'), true);
});
