import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { mockPublicDns } from './helpers/publicDns';

beforeEach(mockPublicDns);

import modelMigratorHandler from '../server/handlers/model-migrator';
import {
  clearModelMigratorCatalogCache,
  loadModelMigratorConnections,
  loadModelMigratorInstanceCatalogs,
  ModelMigratorRequestError,
  normalizeModelMigratorRequestError,
  runModelMigratorInteractiveOperation,
} from '../server/services/modelMigratorCatalog';
import {
  getInstance,
  lockVault,
  resetVault,
  type SavedInstance,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import {
  OmniClient,
  OmniClientError,
  type OmniDocumentRecord,
  OmniPaginationError,
  resetOmniClientRateLimitStateForTests,
  type OmniConnectionRecord,
  type OmniModelRecord,
} from '../server/services/omniClient';

let temporaryRoot = '';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function saveInstance(id: string, apiKey = `${id}-credential`): SavedInstance {
  upsertInstance({
    id,
    label: `Example ${id}`,
    role: 'both',
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const saved = getInstance(id);
  assert.ok(saved);
  return saved;
}

function saveRoleInstance(id: string, role: 'source' | 'destination'): SavedInstance {
  upsertInstance({
    id,
    label: `Example ${id}`,
    role,
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey: `${id}-credential`,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const saved = getInstance(id);
  assert.ok(saved);
  return saved;
}

function connection(id = 'example-connection'): OmniConnectionRecord {
  return {
    id,
    name: `Example ${id}`,
    dialect: 'snowflake',
    database: 'EXAMPLE',
    deletedAt: null,
  };
}

function model(id: string, kind: string): OmniModelRecord {
  return {
    id,
    name: `Example ${id}`,
    identifier: id,
    connectionId: 'example-connection',
    kind,
    gitConfigured: true,
    deletedAt: null,
  };
}

function clientInstance(client: OmniClient): Pick<SavedInstance, 'id' | 'apiKey'> {
  return (client as unknown as { instance: SavedInstance }).instance;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

beforeEach(() => {
  clearModelMigratorCatalogCache();
  resetOmniClientRateLimitStateForTests();
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-model-migrator-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  unlockVault('model migrator test passphrase');
});

afterEach(() => {
  clearModelMigratorCatalogCache();
  resetOmniClientRateLimitStateForTests();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
});

test('same-instance readiness reuses one catalog and de-duplicates selected schema reads', async () => {
  const instance = saveInstance('same-instance');
  let connectionCalls = 0;
  const modelKinds: string[] = [];
  const schemaCalls: string[] = [];

  mock.method(OmniClient.prototype, 'listConnections', async () => {
    connectionCalls += 1;
    return [connection()];
  });
  mock.method(OmniClient.prototype, 'listModels', async (options: string | { modelKind?: string }) => {
    const kind = typeof options === 'string' ? options : options.modelKind || 'SHARED';
    modelKinds.push(kind);
    return kind === 'SCHEMA'
      ? [model('example-schema-model', 'SCHEMA')]
      : [model('example-shared-model', 'SHARED')];
  });
  mock.method(OmniClient.prototype, 'listModelSchemas', async (modelId: string) => {
    schemaCalls.push(modelId);
    return ['EXAMPLE_SCHEMA'];
  });

  const response = await modelMigratorHandler(new Request(
    'http://localhost/api/model-migrator/readiness',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceInstanceId: instance.id,
        targetInstanceId: instance.id,
        sourceModelIds: ['example-shared-model'],
        targetModelBySourceId: {
          'example-shared-model': 'example-shared-model',
        },
      }),
    },
  ));
  const body = await response.json() as {
    readiness?: { source: { instanceId: string }; target?: { instanceId: string } };
  };

  assert.equal(response.status, 200);
  assert.equal(body.readiness?.source.instanceId, instance.id);
  assert.equal(body.readiness?.target?.instanceId, instance.id);
  assert.equal(connectionCalls, 1);
  assert.deepEqual(modelKinds.sort(), ['SCHEMA', 'SHARED']);
  assert.deepEqual(schemaCalls, ['example-shared-model']);
});

test('every Model Migrator planning and write seam rejects ineligible saved-instance roles before outbound work', async (t) => {
  const source = saveRoleInstance('role-source', 'source');
  const destination = saveRoleInstance('role-destination', 'destination');
  let outboundReads = 0;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async () => {
    outboundReads += 1;
    return { files: {}, checksums: {} };
  });
  t.mock.method(OmniClient.prototype, 'listFolderDocuments', async () => {
    outboundReads += 1;
    return [];
  });

  const post = (pathName: string, body: Record<string, unknown>) => modelMigratorHandler(new Request(
    `http://localhost/api/model-migrator/${pathName}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ));
  const expectRoleFailure = async (response: Response, usage: 'source' | 'destination') => {
    assert.equal(response.status, 403);
    const payload = await response.json() as { code?: string };
    assert.equal(payload.code, usage === 'source'
      ? 'MODEL_MIGRATOR_SOURCE_ROLE_REQUIRED'
      : 'MODEL_MIGRATOR_DESTINATION_ROLE_REQUIRED');
  };

  for (const pathName of ['readiness', 'translate', 'preflight']) {
    const common = pathName === 'readiness'
      ? { sourceModelIds: [], targetModelBySourceId: {} }
      : pathName === 'translate'
        ? { modelId: 'source-model', targetModelId: 'target-model' }
        : { sourceModelId: 'source-model', targetModelId: 'target-model', documentIds: [] };
    await expectRoleFailure(await post(pathName, {
      ...common,
      sourceInstanceId: destination.id,
      targetInstanceId: destination.id,
    }), 'source');
    await expectRoleFailure(await post(pathName, {
      ...common,
      sourceInstanceId: source.id,
      targetInstanceId: source.id,
    }), 'destination');
  }

  const modelInput = [{
    sourceModelId: 'source-model',
    targetModelId: 'target-model',
    targetConnectionId: 'target-connection',
    mode: 'impact_report',
    branchName: 'safe-copy-role-check',
  }];
  await expectRoleFailure(await post('jobs', {
    sourceId: destination.id,
    targetId: destination.id,
    models: modelInput,
  }), 'source');
  await expectRoleFailure(await post('jobs', {
    sourceId: source.id,
    targetId: source.id,
    models: modelInput,
  }), 'destination');

  await expectRoleFailure(await modelMigratorHandler(new Request(
    `http://localhost/api/model-migrator/${destination.id}/inventory?modelIds=source-model`,
  )), 'source');

  assert.equal(outboundReads, 0, 'role-ineligible requests must fail before any tenant catalog or YAML read');
});

test('inventory requests for different model selections share one tenant crawl and refresh explicitly', async () => {
  const instance = saveInstance('inventory-instance');
  const documents: OmniDocumentRecord[] = [{
    id: 'example-dashboard-a',
    identifier: 'example-dashboard-a',
    name: 'Example dashboard A',
    baseModelId: 'example-model-a',
    hasDashboard: true,
  }, {
    id: 'example-workbook-b',
    identifier: 'example-workbook-b',
    name: 'Example workbook B',
    baseModelId: 'example-model-b',
    hasDashboard: false,
  }];
  let crawlCalls = 0;

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => {
    crawlCalls += 1;
    return documents;
  });

  const readInventory = async (query: string) => {
    const response = await modelMigratorHandler(new Request(
      `http://localhost/api/model-migrator/${instance.id}/inventory?${query}`,
    ));
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      models: Array<{ modelId: string; documents: Array<{ id: string }> }>;
    }>;
  };

  const first = await readInventory('modelIds=example-model-a');
  const second = await readInventory('modelIds=example-model-b');
  assert.deepEqual(first.models[0].documents.map((row) => row.id), ['example-dashboard-a']);
  assert.deepEqual(second.models[0].documents.map((row) => row.id), ['example-workbook-b']);
  assert.equal(crawlCalls, 1, 'selection changes should filter one cached tenant crawl locally');

  await readInventory('modelIds=example-model-a&forceRefresh=true');
  assert.equal(crawlCalls, 2, 'explicit refresh should start one new tenant crawl');
});

test('catalog single-flight preserves the remaining subscriber and force refresh bypasses a completed value', async () => {
  const instance = saveInstance('shared-instance');
  const upstream = deferred<OmniConnectionRecord[]>();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;

  mock.method(OmniClient.prototype, 'listConnections', async (signal?: AbortSignal) => {
    calls += 1;
    upstreamSignal = signal;
    if (calls === 1) return upstream.promise;
    return [connection('refreshed-connection')];
  });

  const first = loadModelMigratorConnections(instance, { signal: firstController.signal });
  const second = loadModelMigratorConnections(instance, { signal: secondController.signal });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);

  firstController.abort(new DOMException('First screen left.', 'AbortError'));
  await assert.rejects(first, isAbortError);
  assert.equal(upstreamSignal?.aborted, false);

  upstream.resolve([connection()]);
  assert.deepEqual((await second).map((row) => row.id), ['example-connection']);
  assert.deepEqual((await loadModelMigratorConnections(instance)).map((row) => row.id), ['example-connection']);
  assert.equal(calls, 1);

  const refreshed = await loadModelMigratorConnections(instance, { forceRefresh: true });
  assert.deepEqual(refreshed.map((row) => row.id), ['refreshed-connection']);
  assert.equal(calls, 2);
});

test('catalog cache identity includes the saved credential boundary', async () => {
  const original = saveInstance('credential-boundary', 'credential-a');
  const rotated: SavedInstance = { ...original, apiKey: 'credential-b' };
  const observedCredentials: string[] = [];

  mock.method(OmniClient.prototype, 'listConnections', async function (this: OmniClient) {
    const credential = clientInstance(this).apiKey;
    observedCredentials.push(credential);
    return [connection(`connection-${credential}`)];
  });

  const [first, second] = await Promise.all([
    loadModelMigratorConnections(original),
    loadModelMigratorConnections(rotated),
  ]);

  assert.deepEqual(observedCredentials.sort(), ['credential-a', 'credential-b']);
  assert.equal(first[0].id, 'connection-credential-a');
  assert.equal(second[0].id, 'connection-credential-b');
});

test('instance catalog loading starts no more than two instances at once', async () => {
  const instances = [
    saveInstance('bounded-a'),
    saveInstance('bounded-b'),
    saveInstance('bounded-c'),
  ];
  const barriers = new Map(instances.map((instance) => [instance.id, deferred<void>()]));
  const started = new Set<string>();

  mock.method(OmniClient.prototype, 'listConnections', async function (this: OmniClient) {
    const { id } = clientInstance(this);
    started.add(id);
    await barriers.get(id)!.promise;
    return [connection(`${id}-connection`)];
  });
  mock.method(OmniClient.prototype, 'listModels', async function (
    this: OmniClient,
    options: string | { modelKind?: string },
  ) {
    const { id } = clientInstance(this);
    started.add(id);
    await barriers.get(id)!.promise;
    const kind = typeof options === 'string' ? options : options.modelKind || 'SHARED';
    return [model(`${id}-${kind.toLowerCase()}`, kind)];
  });

  const loading = loadModelMigratorInstanceCatalogs(instances);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ['bounded-a', 'bounded-b']);

  barriers.get('bounded-a')!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ['bounded-a', 'bounded-b', 'bounded-c']);

  barriers.get('bounded-b')!.resolve();
  barriers.get('bounded-c')!.resolve();
  const catalogs = await loading;
  assert.equal(catalogs.size, 3);
});

test('an aborted queued Omni read returns promptly without letting the next caller bypass its predecessor', async (context) => {
  let now = 0;
  mock.method(Date, 'now', () => now);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let fetchCalls = 0;
  const client = new OmniClient({
    label: 'Example rate-limited instance',
    baseUrl: 'https://rate-limit.example.omniapp.co',
    apiKey: 'rate-limit-ordering-credential',
  }, {
    maxReadRetries: 0,
    requestTimeoutMs: 120_000,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  try {
    for (let index = 0; index < 55; index += 1) await client.test();
    assert.equal(fetchCalls, 55);

    const livePredecessor = client.test();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 55, 'the next request should be waiting for the rate-limit window');

    const queuedController = new AbortController();
    const cancelled = client.test(queuedController.signal);
    await Promise.resolve();
    queuedController.abort(new DOMException('The queued screen left.', 'AbortError'));
    const cancellationOutcome = await Promise.race([
      cancelled.then(
        () => 'resolved',
        (error: unknown) => isAbortError(error) ? 'aborted' : 'unexpected-error',
      ),
      new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
    ]);
    assert.equal(cancellationOutcome, 'aborted', 'the abandoned queued caller should reject before its predecessor settles');

    const laterCaller = client.test();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 55, 'a later caller must remain behind the live predecessor and cancelled queue entry');

    now = 60_001;
    context.mock.timers.tick(60_000);
    await Promise.all([livePredecessor, laterCaller]);
    assert.equal(fetchCalls, 57, 'only the live predecessor and later caller should reach fetch, in queue order');
  } finally {
    context.mock.timers.reset();
  }
});

test('interactive readiness deadline returns the documented retryable timeout', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runModelMigratorInteractiveOperation(
      async () => new Promise<never>(() => undefined),
      { timeoutMs: 15 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModelMigratorRequestError);
      assert.equal(error.code, 'MODEL_MIGRATOR_READINESS_TIMEOUT');
      assert.equal(error.statusCode, 504);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 500, 'the interactive deadline should reject promptly');
});

test('upstream rate limits and incomplete pagination normalize to actionable retry contracts', () => {
  const rateLimited = normalizeModelMigratorRequestError(new OmniClientError(
    429,
    'https://example.invalid/api/v1/models',
    'Too many requests.',
  ));
  assert.equal(rateLimited.code, 'MODEL_MIGRATOR_UPSTREAM_RATE_LIMITED');
  assert.equal(rateLimited.statusCode, 429);
  assert.equal(rateLimited.retryable, true);

  const incomplete = normalizeModelMigratorRequestError(new OmniPaginationError());
  assert.equal(incomplete.code, 'MODEL_MIGRATOR_CATALOG_INCOMPLETE');
  assert.equal(incomplete.statusCode, 502);
  assert.equal(incomplete.retryable, true);
});

test('readiness handler exposes a structured rate-limit response instead of a generic 500', async () => {
  const instance = saveInstance('rate-limited-instance');
  mock.method(OmniClient.prototype, 'listConnections', async () => {
    throw new OmniClientError(429, 'https://example.invalid/api/v1/connections', 'Too many requests.');
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [model('example-shared-model', 'SHARED')]);

  const response = await modelMigratorHandler(new Request(
    'http://localhost/api/model-migrator/readiness',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceInstanceId: instance.id,
        targetInstanceId: instance.id,
        sourceModelIds: ['example-shared-model'],
        targetModelBySourceId: { 'example-shared-model': 'example-shared-model' },
      }),
    },
  ));
  const body = await response.json() as { error?: string; code?: string; retryable?: boolean };

  assert.equal(response.status, 429);
  assert.equal(body.code, 'MODEL_MIGRATOR_UPSTREAM_RATE_LIMITED');
  assert.equal(body.retryable, true);
  assert.match(body.error || '', /rate limiting/i);
});
