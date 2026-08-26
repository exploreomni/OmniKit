import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import instancesHandlerImplementation, {
  type InstanceHandlerDependencies,
  InstanceValidationDeadlineError,
  runWithInstanceValidationDeadline,
} from '../server/handlers/instances';
import {
  getInstance,
  lockVault,
  markInstanceValidated,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';

let tempDir = '';

beforeEach(() => {
  lockVault();
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-instance-connect-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = String(30 * 60 * 1_000);
  unlockVault('instance connect test passphrase');
});

afterEach(() => {
  resetVault();
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
  rmSync(tempDir, { recursive: true, force: true });
});

function saveInstance(apiKey = 'fixture-connect-key-one') {
  return upsertInstance({
    label: 'Connect test instance',
    role: 'both',
    baseUrl: 'https://93.184.216.34',
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

function instanceRequest(id: string, action: 'connect' | 'test', signal?: AbortSignal): Request {
  return new Request(`http://localhost/api/instances/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    signal,
  });
}

function validIdentityProbeResponse(): Response {
  return new Response(JSON.stringify({
    keyScope: 'user',
    orgRole: 'MEMBER',
    rolesByModel: {},
    user: { id: 'user-1', membershipId: 'membership-1' },
    rolesByModelTruncated: false,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function instancesHandler(
  request: Request,
  dependencies: InstanceHandlerDependencies = {},
): Promise<Response> {
  return instancesHandlerImplementation(request, {
    probeFetch: globalThis.fetch,
    validateProbeOutbound: async () => undefined,
    ...dependencies,
  });
}

test('recent saved-instance connect reuses exact credential validation without outbound work or timestamp refresh', async (t) => {
  const saved = saveInstance();
  const validated = markInstanceValidated(saved.id);
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return validIdentityProbeResponse();
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  const body = await response.json() as {
    instance: { lastValidatedAt?: string };
    validationSource: string;
  };

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 0);
  assert.equal(body.validationSource, 'recent');
  assert.equal(body.instance.lastValidatedAt, validated.lastValidatedAt);
});

test('unvalidated saved-instance connect makes exactly one cancellable live probe and marks validation', async (t) => {
  const saved = saveInstance();
  const requests: Array<{ url: string; authorization?: string; signal?: AbortSignal | null }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      signal: init?.signal,
    });
    return validIdentityProbeResponse();
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  const body = await response.json() as {
    instance: { lastValidatedAt?: string };
    validationSource: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.validationSource, 'live');
  assert.ok(body.instance.lastValidatedAt);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.url).pathname, '/api/v1/whoami');
  assert.equal(new URL(requests[0]!.url).search, '');
  assert.equal(requests[0]!.authorization, 'Bearer fixture-connect-key-one');
  assert.ok(requests[0]!.signal instanceof AbortSignal);
});

test('connection probe resolves once at connection time and blocks a private address', async () => {
  const saved = upsertInstance({
    label: 'DNS change test instance',
    role: 'both',
    baseUrl: 'https://dns-change-test.omniapp.co',
    apiKey: 'fixture-connect-dns-change-key',
  });
  type LookupCallback = (error: NodeJS.ErrnoException | null, addresses?: unknown) => void;
  let connectionLookups = 0;
  let redundantPreflightLookups = 0;
  const privateLookup = ((...args: unknown[]) => {
    connectionLookups += 1;
    (args[2] as LookupCallback)(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as unknown as typeof import('node:dns').lookup;

  const response = await instancesHandlerImplementation(instanceRequest(saved.id, 'connect'), {
    validateProbeOutbound: async () => { redundantPreflightLookups += 1; },
    probeLookup: privateLookup,
  });
  const body = await response.json() as { code?: string };

  assert.equal(connectionLookups, 1);
  assert.equal(redundantPreflightLookups, 0);
  assert.equal(response.status, 502);
  assert.equal(body.code, 'INSTANCE_VALIDATION_FAILED');
  assert.equal(getInstance(saved.id)?.lastValidatedAt, undefined);
});

test('connection probe rejects redirects without following them or exposing redirect data', async (t) => {
  const saved = saveInstance('fixture-connect-redirect-key');
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://private-redirect.example/raw-secret' },
    });
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  const body = await response.json() as { code?: string };

  assert.equal(fetchCalls, 1);
  assert.equal(response.status, 400);
  assert.equal(body.code, 'INSTANCE_VALIDATION_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /private-redirect|raw-secret/i);
  assert.equal(getInstance(saved.id)?.lastValidatedAt, undefined);
});

test('connection probe rejects empty, HTML, malformed, and arbitrary 2xx identity bodies', async (t) => {
  const saved = saveInstance('fixture-connect-invalid-success-key');
  const responses = [
    new Response('', { status: 200 }),
    new Response('<html>not Omni JSON</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      records: [{ id: 'folder-1' }],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[responseIndex++]!);

  for (let index = 0; index < responses.length; index += 1) {
    const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 502);
    assert.equal(body.code, 'INSTANCE_INVALID_RESPONSE');
  }
  assert.equal(responseIndex, responses.length);
  assert.equal(getInstance(saved.id)?.lastValidatedAt, undefined);
});

test('saved-instance connect performs one live probe when validation is older than fifteen minutes', async (t) => {
  const saved = saveInstance('fixture-connect-stale-validation-key');
  const staleValidatedAt = new Date(Date.now() - 16 * 60 * 1_000).toISOString();
  const stale = upsertInstance({
    id: saved.id,
    baseUrl: saved.baseUrl,
    lastValidatedAt: staleValidatedAt,
  });
  assert.equal(stale.lastValidatedAt, staleValidatedAt);

  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return validIdentityProbeResponse();
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  const body = await response.json() as {
    instance: { lastValidatedAt?: string };
    validationSource: string;
  };

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(body.validationSource, 'live');
  assert.ok(Date.parse(body.instance.lastValidatedAt!) > Date.parse(staleValidatedAt));
});

test('explicit saved-instance test always performs one live probe even after recent validation', async (t) => {
  const saved = saveInstance('fixture-connect-explicit-test-key');
  const firstValidation = markInstanceValidated(saved.id);
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return validIdentityProbeResponse();
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'test'));
  const body = await response.json() as { instance: { lastValidatedAt?: string } };

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.ok(body.instance.lastValidatedAt);
  assert.ok(Date.parse(body.instance.lastValidatedAt!) >= Date.parse(firstValidation.lastValidatedAt!));
});

test('rotating the saved credential invalidates recent validation and forces a live connect probe', async (t) => {
  const saved = saveInstance();
  markInstanceValidated(saved.id);
  const rotated = upsertInstance({
    id: saved.id,
    baseUrl: saved.baseUrl,
    apiKey: 'fixture-connect-key-two',
  });
  assert.equal(rotated.lastValidatedAt, undefined);

  const authorizations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push((init?.headers as Record<string, string> | undefined)?.Authorization || '');
    return validIdentityProbeResponse();
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  assert.equal(response.status, 200);
  assert.deepEqual(authorizations, ['Bearer fixture-connect-key-two']);
});

test('interactive connection failures are not retried and never expose the upstream response body', async (t) => {
  const saved = saveInstance('fixture-connect-upstream-failure-key');
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ message: 'raw upstream detail fixture-secret' }), { status: 503 });
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  const body = await response.json() as { error?: string; code?: string };

  assert.equal(response.status, 502);
  assert.equal(fetchCalls, 1);
  assert.equal(body.code, 'INSTANCE_UPSTREAM_UNAVAILABLE');
  assert.match(body.error || '', /temporarily unavailable/i);
  assert.doesNotMatch(JSON.stringify(body), /raw upstream detail|fixture-secret/i);
});

test('caller cancellation aborts the live probe and returns a safe cancellation response', async (t) => {
  const saved = saveInstance('fixture-connect-cancellation-key');
  const controller = new AbortController();
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });

  const responsePromise = instancesHandler(instanceRequest(saved.id, 'connect', controller.signal));
  setTimeout(() => controller.abort(), 10);
  const response = await responsePromise;
  const body = await response.json() as { error?: string; code?: string };

  assert.equal(response.status, 499);
  assert.equal(fetchCalls, 1);
  assert.equal(body.code, 'INSTANCE_VALIDATION_CANCELLED');
  assert.match(body.error || '', /cancelled/i);
});

test('a credential rotation during a live probe cannot validate the replacement credential', async (t) => {
  const saved = saveInstance('fixture-connect-cas-key');
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    upsertInstance({
      id: saved.id,
      baseUrl: saved.baseUrl,
      apiKey: 'fixture-connect-key-rotated-during-probe',
    });
    return validIdentityProbeResponse();
  });

  const response = await instancesHandler(instanceRequest(saved.id, 'connect'));
  const body = await response.json() as { error?: string; code?: string };

  assert.equal(response.status, 409);
  assert.equal(fetchCalls, 1);
  assert.equal(body.code, 'INSTANCE_CREDENTIAL_CHANGED');
  assert.match(body.error || '', /changed during validation/i);
});

test('the outer validation deadline returns even when the underlying operation ignores abort', async () => {
  let operationSignal: AbortSignal | undefined;
  const startedAt = Date.now();

  await assert.rejects(
    runWithInstanceValidationDeadline(
      (signal) => {
        operationSignal = signal;
        return new Promise<never>(() => undefined);
      },
      { timeoutMs: 20 },
    ),
    InstanceValidationDeadlineError,
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(operationSignal?.aborted, true);
});
