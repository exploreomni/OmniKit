import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  OmniClient,
  resetOmniClientRateLimitStateForTests,
} from '../server/services/omniClient';

interface CapturedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: unknown;
}

let clientSequence = 0;

afterEach(() => {
  resetOmniClientRateLimitStateForTests();
});

function capturingClient(requests: CapturedRequest[]): OmniClient {
  clientSequence += 1;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: new URL(String(input)),
      method: String(init?.method || 'GET'),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return new Response(JSON.stringify({ labels: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return new OmniClient({
    label: 'Fictional label workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: `fictional-label-key-${clientSequence}`,
  }, {
    fetchImpl,
    maxReadRetries: 0,
  });
}

test('setFolderLabels sends one PATCH containing both add and remove arrays', async () => {
  const requests: CapturedRequest[] = [];
  const client = capturingClient(requests);

  await client.setFolderLabels(
    '11111111-1111-4111-8111-111111111111',
    ['Production', 'Reviewed'],
    ['Draft'],
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'PATCH');
  assert.equal(
    requests[0]?.url.pathname,
    '/api/v1/folders/11111111-1111-4111-8111-111111111111/labels',
  );
  assert.equal(requests[0]?.headers.get('content-type'), 'application/json');
  assert.deepEqual(requests[0]?.body, {
    add: ['Production', 'Reviewed'],
    remove: ['Draft'],
  });
});

test('setDocumentLabels preserves add-only callers and supports removals', async () => {
  const addRequests: CapturedRequest[] = [];
  const removeRequests: CapturedRequest[] = [];

  await capturingClient(addRequests).setDocumentLabels('example-document', ['Production']);
  await capturingClient(removeRequests).setDocumentLabels('example-document', [], ['Draft']);

  assert.equal(addRequests.length, 1);
  assert.deepEqual(addRequests[0]?.body, { add: ['Production'], remove: [] });
  assert.equal(removeRequests.length, 1);
  assert.deepEqual(removeRequests[0]?.body, { add: [], remove: ['Draft'] });
});

test('label setters retain their no-op behavior when both arrays are empty', async () => {
  const requests: CapturedRequest[] = [];
  const client = capturingClient(requests);

  await client.setDocumentLabels('example-document', []);
  await client.setFolderLabels('11111111-1111-4111-8111-111111111111', [], []);

  assert.deepEqual(requests, []);
});
