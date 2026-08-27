import assert from 'node:assert/strict';
import { test } from 'node:test';

import { omniApiContractRadarHandlerImplementation } from '../server/handlers/omni-api-contract-radar';
import {
  clearOmniApiContractRadarBaselinesForTests,
  fetchTenantOpenApiSnapshot,
  getOmniApiContractRadarReport,
} from '../server/services/omniApiContractRadar';
import type { SavedInstance } from '../server/services/nativeVault';

const instance: SavedInstance = {
  id: 'radar-instance',
  label: 'Neutral Radar Fixture',
  role: 'both',
  baseUrl: 'https://radar-neutral.example.com',
  apiKey: 'private-radar-api-key',
  metricFilter: {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  },
  postMigrationActions: [],
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function openApiDocument(type: 'string' | 'integer' = 'string', includeExternalReference = false) {
  const privateMarker = 'private-upstream-openapi-marker';
  return {
    openapi: '3.1.0',
    info: { title: privateMarker, version: '1.0.0' },
    paths: {
      '/api/v1/whoami': {
        get: {
          summary: privateMarker,
          responses: {
            200: {
              description: privateMarker,
              content: {
                'application/json': {
                  schema: includeExternalReference
                    ? { $ref: `https://${privateMarker}.invalid/schema.json` }
                    : { $ref: '#/components/schemas/Caller' },
                },
              },
            },
          },
        },
      },
      '/api/v1/radar-neutral/{resourceId}': {
        get: {
          parameters: [{ in: 'path', name: 'resourceId', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type } } } } },
        },
      },
    },
    components: {
      schemas: {
        Caller: {
          type: 'object',
          properties: {
            privateUpstreamProperty: { type, description: privateMarker },
          },
        },
      },
    },
  };
}

test('tenant OpenAPI fetch is exact-origin, credential-free, bounded, read-only, normalized, and sanitized', async () => {
  clearOmniApiContractRadarBaselinesForTests();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const safeUrls: string[] = [];
  const snapshot = await fetchTenantOpenApiSnapshot(instance, {
    assertSafeUrl: async (url) => { safeUrls.push(url); },
    now: () => new Date('2026-08-26T12:30:00.000Z'),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response(openApiDocument('string', true));
    }) as typeof fetch,
  });

  assert.deepEqual(safeUrls, ['https://radar-neutral.example.com/openapi.json']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://radar-neutral.example.com/openapi.json');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.redirect, 'manual');
  const requestHeaders = new Headers(calls[0].init?.headers);
  assert.equal(requestHeaders.has('Authorization'), false);
  assert.equal(requestHeaders.has('apiKey'), false);
  assert.equal(requestHeaders.has('x-api-key'), false);
  assert.equal(snapshot.tenantOrigin, 'https://radar-neutral.example.com');
  assert.equal(snapshot.externalReferenceCount, 1);
  assert.equal(snapshot.unresolvedLocalReferenceCount, 0);
  assert.deepEqual(snapshot.operations.map(({ key }) => key), [
    'GET /api/v1/radar-neutral/:param',
    'GET /api/v1/whoami',
  ]);
  assert.ok(snapshot.operations.every((operation) => /^[a-f0-9]{64}$/.test(operation.schemaFingerprint)));

  const report = await getOmniApiContractRadarReport(instance, {
    assertSafeUrl: async () => undefined,
    now: () => new Date('2026-08-26T12:31:00.000Z'),
    fetchImpl: (async () => response(openApiDocument('string', true))) as typeof fetch,
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.complete, false);
  assert.equal(report.tenantOrigin, 'https://radar-neutral.example.com');
  assert.equal(report.summary.tenantOnly, 1);
  assert.equal(report.operations.find(({ path }) => path === '/api/v1/whoami')?.registry?.id, 'whoami');
  for (const prohibited of [
    instance.apiKey,
    'private-upstream-openapi-marker',
    'privateUpstreamProperty',
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test('Contract Radar reports unresolved local references separately and never calls that coverage complete', async () => {
  clearOmniApiContractRadarBaselinesForTests();
  const document = openApiDocument();
  const whoAmI = document.paths['/api/v1/whoami'].get.responses[200];
  whoAmI.content['application/json'].schema = { $ref: '#/components/schemas/MissingCaller' };

  const report = await getOmniApiContractRadarReport(instance, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => response(document)) as typeof fetch,
  });

  assert.equal(report.externalReferenceCount, 0);
  assert.equal(report.unresolvedLocalReferenceCount, 1);
  assert.equal(report.complete, false);
});

test('Contract Radar compares only normalized local schema fingerprints to the prior saved-instance snapshot', async () => {
  clearOmniApiContractRadarBaselinesForTests();
  let call = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => {
      call += 1;
      return response(openApiDocument(call === 1 ? 'string' : 'integer'));
    }) as typeof fetch,
    now: () => new Date(`2026-08-26T12:${call === 0 ? '40' : '41'}:00.000Z`),
  };

  const first = await getOmniApiContractRadarReport(instance, dependencies);
  const second = await getOmniApiContractRadarReport({
    ...instance,
    apiKey: 'rotated-private-radar-api-key',
  }, dependencies);
  assert.equal(call, 2);
  assert.deepEqual(first.baseline, { available: false });
  assert.equal(second.baseline.available, true);
  assert.ok(second.findings.some((finding) => (
    finding.category === 'schema_changed'
    && finding.path === '/api/v1/whoami'
  )));
});

test('Contract Radar handler uses a saved instance and never reflects malformed upstream values', async () => {
  clearOmniApiContractRadarBaselinesForTests();
  const privateMarker = 'private-malformed-openapi-value';
  const handlerResponse = await omniApiContractRadarHandlerImplementation(
    new Request('http://localhost/api/omni-api-contract-radar?instanceId=radar-instance'),
    {
      getSavedInstance: () => instance,
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => response({ openapi: privateMarker, paths: {} })) as typeof fetch,
    },
  );
  assert.equal(handlerResponse.status, 502);
  const body = await handlerResponse.text();
  assert.match(body, /supported OpenAPI 3 document/);
  assert.equal(body.includes(privateMarker), false);

  const methodResponse = await omniApiContractRadarHandlerImplementation(
    new Request('http://localhost/api/omni-api-contract-radar?instanceId=radar-instance', { method: 'POST' }),
  );
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('Allow'), 'GET');
});
