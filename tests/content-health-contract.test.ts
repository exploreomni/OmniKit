import assert from 'node:assert/strict';
import { test } from 'node:test';

import listDocumentsHandler from '../server/handlers/list-documents';
import listFoldersHandler from '../server/handlers/list-folders';
import omniProxyHandler from '../server/handlers/omni-proxy';

const BASE_URL = 'https://neutral-content.omniapp.co';
const API_KEY = 'private-test-key';
const TEST_REQUEST_POLICY = {
  validateOutbound: async () => undefined,
  acquireRequestSlot: async () => undefined,
};

function localRequest(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1/api/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: BASE_URL, api_key: API_KEY, ...body }),
  });
}

test('content collection handlers preserve legitimate empty reads and fail closed on malformed or hostile responses', async (t) => {
  const privateMarker = 'raw-upstream-private-marker';
  const upstreamResponses = [
    new Response(JSON.stringify({ errors: [] }), { status: 200 }),
    new Response(JSON.stringify({ errors: [] }), { status: 200 }),
    new Response(`${privateMarker}:${API_KEY}`, { status: 403 }),
    new Response(JSON.stringify({
      records: [],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }), { status: 200 }),
    new Response(JSON.stringify({
      records: [],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }), { status: 200 }),
  ];
  let requestIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => upstreamResponses[requestIndex++]);

  const malformedFolders = await listFoldersHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY);
  const malformedDocuments = await listDocumentsHandler(localRequest({ folder_id: 'folder-1', all_pages: true }), TEST_REQUEST_POLICY);
  const deniedFolders = await listFoldersHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY);
  const emptyFolders = await listFoldersHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY);
  const emptyDocuments = await listDocumentsHandler(localRequest({ folder_id: 'folder-1', all_pages: true }), TEST_REQUEST_POLICY);

  assert.equal(malformedFolders.status, 502);
  assert.equal(malformedDocuments.status, 502);
  assert.equal(deniedFolders.status, 403);
  for (const response of [malformedFolders, malformedDocuments, deniedFolders]) {
    const serialized = JSON.stringify(await response.json());
    assert.equal(serialized.includes(privateMarker), false);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes('rawResponse'), false);
    assert.equal(serialized.includes('detail'), false);
  }

  assert.equal(emptyFolders.status, 200);
  assert.equal(emptyDocuments.status, 200);
  const emptyFolderBody = await emptyFolders.json() as { folders: unknown[]; complete: boolean; loadedResults: number; totalResults: number };
  const emptyDocumentBody = await emptyDocuments.json() as { documents: unknown[]; complete: boolean; loadedResults: number; totalResults: number };
  assert.deepEqual(emptyFolderBody.folders, []);
  assert.deepEqual(emptyDocumentBody.documents, []);
  assert.deepEqual(
    [emptyFolderBody.complete, emptyFolderBody.loadedResults, emptyFolderBody.totalResults],
    [true, 0, 0],
  );
  assert.deepEqual(
    [emptyDocumentBody.complete, emptyDocumentBody.loadedResults, emptyDocumentBody.totalResults],
    [true, 0, 0],
  );
  assert.equal(requestIndex, upstreamResponses.length);
});

test('content collection handlers preserve partial evidence at the pagination safety limit', async (t) => {
  const requestCounts = { folders: 0, documents: 0 };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const kind = url.pathname.endsWith('/folders') ? 'folders' : 'documents';
    requestCounts[kind] += 1;
    const ordinal = requestCounts[kind];
    const record = kind === 'folders'
      ? {
          id: `folder-${ordinal}`,
          name: `Folder ${ordinal}`,
          url: `https://neutral-content.omniapp.co/folders/folder-${ordinal}`,
        }
      : {
          identifier: `document-${ordinal}`,
          name: `Document ${ordinal}`,
          url: `https://neutral-content.omniapp.co/dashboards/document-${ordinal}`,
          hasDashboard: true,
        };
    return new Response(JSON.stringify({
      records: [record],
      pageInfo: {
        hasNextPage: ordinal < 51,
        nextCursor: ordinal < 51 ? `cursor-${ordinal + 1}` : null,
        pageSize: 1,
        totalRecords: 51,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const folderResponse = await listFoldersHandler(localRequest({ all_pages: true, page_size: 1 }), TEST_REQUEST_POLICY);
  const documentResponse = await listDocumentsHandler(localRequest({ all_pages: true, page_size: 1 }), TEST_REQUEST_POLICY);
  const folderBody = await folderResponse.json() as Record<string, unknown>;
  const documentBody = await documentResponse.json() as Record<string, unknown>;

  for (const body of [folderBody, documentBody]) {
    assert.equal(body.complete, false);
    assert.equal(body.loadedResults, 50);
    assert.equal(body.totalResults, 51);
    assert.equal(body.pagesFetched, 50);
    assert.equal(body.reasonCode, 'PAGINATION_SAFETY_LIMIT_REACHED');
  }
  assert.equal(
    (folderBody.folders as Array<{ url?: string }>)[0]?.url,
    'https://neutral-content.omniapp.co/folders/folder-1',
  );
  assert.equal(
    (documentBody.documents as Array<{ url?: string }>)[0]?.url,
    'https://neutral-content.omniapp.co/dashboards/document-1',
  );
  assert.deepEqual(requestCounts, { folders: 50, documents: 50 });
});

test('content collection handlers reject malformed and duplicate record identities', async (t) => {
  const responses = [
    { records: [{ id: 7 }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ identifier: { unsafe: true } }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ id: 'folder-bad-name', name: { unsafe: true } }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ identifier: 'document-bad-name', name: { unsafe: true } }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ identifier: 'document-bad-label', name: 'Document bad label', labels: [{ unsafe: true }] }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ id: 'folder-repeat', name: 'Folder repeat' }], pageInfo: { hasNextPage: true, nextCursor: 'folder-next', pageSize: 1, totalRecords: 2 } },
    { records: [{ id: 'folder-repeat', name: 'Folder repeat' }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 2 } },
    { records: [{ identifier: 'document-repeat', name: 'Document repeat' }], pageInfo: { hasNextPage: true, nextCursor: 'document-next', pageSize: 1, totalRecords: 2 } },
    { records: [{ identifier: 'document-repeat', name: 'Document repeat' }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 2 } },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(responses[responseIndex++]), { status: 200 }));

  assert.equal((await listFoldersHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal((await listFoldersHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal((await listFoldersHandler(localRequest({ all_pages: true, page_size: 1 }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true, page_size: 1 }), TEST_REQUEST_POLICY)).status, 502);
  assert.equal(responseIndex, responses.length);
});

test('content collection handlers accept coherent stable and remaining total pagination modes', async () => {
  const page = (kind: 'folder' | 'document', ordinal: number, totalRecords: number) => ({
    records: [kind === 'folder'
      ? { id: `folder-${ordinal}`, name: `Folder ${ordinal}` }
      : { identifier: `document-${ordinal}`, name: `Document ${ordinal}`, hasDashboard: true }],
    pageInfo: {
      hasNextPage: ordinal < 3,
      nextCursor: ordinal < 3 ? `cursor-${ordinal + 1}` : null,
      pageSize: 1,
      totalRecords,
    },
  });
  let folderPage = 0;
  let documentPage = 0;
  const policy = {
    validateOutbound: async () => undefined,
    acquireRequestSlot: async () => undefined,
  };

  const folderResponse = await listFoldersHandler(localRequest({ all_pages: true, page_size: 1 }), {
    ...policy,
    fetch: async () => {
      folderPage += 1;
      return new Response(JSON.stringify(page('folder', folderPage, 3)));
    },
  });
  const documentResponse = await listDocumentsHandler(localRequest({ all_pages: true, page_size: 1 }), {
    ...policy,
    fetch: async () => {
      documentPage += 1;
      return new Response(JSON.stringify(page('document', documentPage, 4 - documentPage)));
    },
  });

  assert.equal(folderResponse.status, 200);
  assert.equal(documentResponse.status, 200);
  assert.deepEqual(
    [(await folderResponse.json() as { complete: boolean; loadedResults: number }).complete, folderPage],
    [true, 3],
  );
  const documentBody = await documentResponse.json() as { complete: boolean; loadedResults: number; totalResults: number };
  assert.deepEqual(
    [documentBody.complete, documentBody.loadedResults, documentBody.totalResults, documentPage],
    [true, 3, 3, 3],
  );
});

test('content collection handlers reject pagination that changes total semantics midstream', async () => {
  let ordinal = 0;
  const response = await listDocumentsHandler(localRequest({ all_pages: true, page_size: 1 }), {
    validateOutbound: async () => undefined,
    acquireRequestSlot: async () => undefined,
    fetch: async () => {
      ordinal += 1;
      const totals = [3, 2, 3];
      return new Response(JSON.stringify({
        records: [{ identifier: `document-${ordinal}`, name: `Document ${ordinal}`, hasDashboard: true }],
        pageInfo: {
          hasNextPage: ordinal < 3,
          nextCursor: ordinal < 3 ? `cursor-${ordinal + 1}` : null,
          pageSize: 1,
          totalRecords: totals[ordinal - 1],
        },
      }));
    },
  });

  assert.equal(response.status, 502);
  assert.equal(ordinal, 3);
});

test('content inventory validates before using credentials, shares rate slots, and rejects redirects', async () => {
  const events: string[] = [];
  let observedInit: RequestInit | undefined;
  const request = localRequest({ all_pages: true });
  const response = await listFoldersHandler(request, {
    validateOutbound: async () => {
      events.push('validate');
    },
    acquireRequestSlot: async (apiKey, signal) => {
      assert.equal(apiKey, API_KEY);
      assert.equal(signal, request.signal);
      events.push('rate-limit');
    },
    fetch: async (_input, init) => {
      events.push('fetch');
      observedInit = init;
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://untrusted.example.invalid/private' },
      });
    },
  });

  assert.deepEqual(events, ['validate', 'rate-limit', 'fetch']);
  assert.equal(observedInit?.redirect, 'manual');
  assert.ok(observedInit?.signal instanceof AbortSignal);
  assert.equal(response.status, 502);

  let blockedFetches = 0;
  const blocked = await listDocumentsHandler(localRequest({ all_pages: true }), {
    validateOutbound: async () => {
      throw new Error('unsafe private resolution details');
    },
    acquireRequestSlot: async () => {
      assert.fail('blocked destinations must not consume a rate-limit slot');
    },
    fetch: async () => {
      blockedFetches += 1;
      return new Response('{}');
    },
  });
  assert.equal(blocked.status, 400);
  assert.equal(blockedFetches, 0);
  assert.doesNotMatch(JSON.stringify(await blocked.json()), /private resolution details/);
});

test('omni proxy joins the shared per-key limiter before its credentialed request', async () => {
  const events: string[] = [];
  const request = new Request('http://127.0.0.1/api/omni-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: BASE_URL,
      api_key: API_KEY,
      method: 'PATCH',
      endpoint: '/v1/folders/folder-1/labels',
      body: { add: ['Reviewed'], remove: [] },
    }),
  });
  let observedSignal: AbortSignal | null | undefined;
  const response = await omniProxyHandler(request, {
    validateOutbound: async () => {
      events.push('validate');
    },
    acquireRequestSlot: async (apiKey, signal) => {
      assert.equal(apiKey, API_KEY);
      assert.equal(signal, request.signal);
      events.push('rate-limit');
    },
    fetch: async (_input, init) => {
      events.push('fetch');
      observedSignal = init?.signal;
      return new Response(JSON.stringify({ labels: ['Reviewed'] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(events, ['validate', 'rate-limit', 'fetch']);
  assert.equal(observedSignal, request.signal);
});
