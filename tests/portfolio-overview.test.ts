import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { mockPublicDns } from './helpers/publicDns';

beforeEach(mockPublicDns);

import {
  clearPortfolioOverviewCache,
  getPortfolioOverview,
} from '../server/services/portfolioOverview';
import portfolioOverviewHandler from '../server/handlers/portfolio-overview';
import {
  decryptVaultBlob,
  getPortfolioOverviewHistory,
  getPortfolioOverviewSnapshot,
  markInstanceValidated,
  normalizeVaultPayload,
  resetVault,
  setPortfolioOverviewSnapshot,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { OmniClient, OmniPaginationError } from '../server/services/omniClient';
import { parsePortfolioOverview } from '../src/services/portfolioOverview';

const testRoot = mkdtempSync(join(tmpdir(), 'omnikit-portfolio-overview-'));
const originalFetch = globalThis.fetch;
const PORTFOLIO_PASSPHRASE = 'portfolio-overview-regression-passphrase';

process.env.OMNIKIT_VAULT_PATH = join(testRoot, 'vault.enc');

beforeEach(() => {
  globalThis.fetch = originalFetch;
  clearPortfolioOverviewCache();
  resetVault();
  delete process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS;
  delete process.env.OMNIKIT_PORTFOLIO_STALE_TTL_MS;
  delete process.env.OMNIKIT_PORTFOLIO_SCAN_DEADLINE_MS;
  delete process.env.OMNIKIT_PORTFOLIO_REQUEST_RETRIES;
});

after(() => {
  globalThis.fetch = originalFetch;
  clearPortfolioOverviewCache();
  resetVault();
  rmSync(testRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metric(value: number | null, status: string, reasonCode: string | null = null) {
  return {
    value,
    status,
    source: 'derived_instance_aggregate',
    asOf: '2026-08-06T15:00:00.000Z',
    coverage: { included: value === null ? 0 : 1, total: 2, unit: 'instances', ratio: value === null ? 0 : 0.5 },
    exclusions: [],
    reasonCode,
  };
}

function metricSet(overrides: Record<string, ReturnType<typeof metric>> = {}) {
  return {
    internalMemberships: metric(0, 'available'),
    estimatedUniquePeople: metric(0, 'available', 'ESTIMATED_FROM_NORMALIZED_EMAIL'),
    embedUsers: metric(0, 'available'),
    embedEntities: metric(0, 'available'),
    active7d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    active30d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    active90d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    staleUsers90d: metric(0, 'available', 'ACTIVE_USER_RECORDS_STALE_90D'),
    neverLoggedInUsers: metric(0, 'available', 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN'),
    dashboards: metric(0, 'available'),
    models: metric(0, 'available'),
    topics: metric(0, 'available', 'TOPIC_MODEL_RECORDS'),
    aiChats: metric(null, 'not_configured', 'AI_CONVERSATIONS_ORG_KEY_CONFIRMATION_REQUIRED'),
    apps: metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED'),
    ...overrides,
  };
}

function storedOverview(instanceId: string, instanceLabel = 'Example workspace') {
  const generatedAt = '2026-08-06T15:00:00.000Z';
  const metrics = metricSet();
  return {
    schemaVersion: 1,
    generatedAt,
    servedAt: generatedAt,
    cache: { state: 'fresh', cachedAt: generatedAt },
    refresh: {
      state: 'idle',
      completedInstances: 1,
      totalInstances: 1,
      completedAt: generatedAt,
    },
    coverage: {
      totalInstances: 1,
      reportingInstances: 1,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
      savedInstances: 1,
      duplicateSavedOrigins: 0,
    },
    metrics: {
      reportingInstances: metric(1, 'available'),
      ...metrics,
    },
    instances: [{
      id: instanceId,
      label: instanceLabel,
      health: 'healthy',
      statusLabel: 'Healthy',
      freshness: 'available',
      asOf: generatedAt,
      duplicateSavedOrigin: false,
      duplicateSavedOriginCount: 1,
      duplicateInstanceLabels: [],
      metrics,
      connections: [],
    }],
    connections: [],
    duplicateSavedOrigins: [],
    failures: [] as Array<Record<string, unknown>>,
    warnings: [],
    partial: false,
    stale: false,
  };
}

function instanceInventoryFingerprint(instances: Array<{
  id: string;
  baseUrl: string;
  updatedAt: string;
  lastValidatedAt?: string;
}>): string {
  const stable = instances.map((instance) => ({
    id: instance.id,
    origin: new URL(instance.baseUrl).origin.toLowerCase(),
    updatedAt: instance.updatedAt,
    lastValidatedAt: instance.lastValidatedAt || null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify({
    collectorVersion: 5,
    instances: stable,
  })).digest('hex');
}

function abortablePendingFetch(onSignal?: (signal: AbortSignal | undefined) => void): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal || undefined;
    onSignal?.(signal);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  })) as typeof fetch;
}

type PortfolioBody = Record<string, unknown> & {
  cache?: { state?: string };
  coverage?: Record<string, unknown>;
  generatedAt?: string;
  instances?: Array<Record<string, unknown>>;
  metrics?: Record<string, Record<string, unknown>>;
  failures?: Array<Record<string, unknown>>;
  partial?: boolean;
  stale?: boolean;
  warnings?: string[];
  refresh?: {
    state?: string;
    startedAt?: string;
    completedAt?: string;
    completedInstances?: number;
    totalInstances?: number;
  };
};

async function responseBody(response: Response): Promise<PortfolioBody> {
  return await response.json() as PortfolioBody;
}

async function waitForPortfolio(
  predicate: (body: PortfolioBody) => boolean,
  timeoutMs = 20_000,
): Promise<PortfolioBody> {
  const deadline = Date.now() + timeoutMs;
  let latest: PortfolioBody = {};
  while (Date.now() < deadline) {
    const response = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
    assert.equal(response.status, 200);
    latest = await responseBody(response);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Portfolio condition was not met before timeout. Latest refresh: ${JSON.stringify(latest.refresh)}`);
}

async function waitForPersistedPortfolio(
  predicate: (body: PortfolioBody) => boolean,
  timeoutMs = 5_000,
): Promise<PortfolioBody> {
  const deadline = Date.now() + timeoutMs;
  let latest: PortfolioBody = {};
  while (Date.now() < deadline) {
    latest = (getPortfolioOverviewSnapshot()?.overview || {}) as PortfolioBody;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Persisted portfolio condition was not met before timeout. Latest refresh: ${JSON.stringify(latest.refresh)}`);
}

function failPortfolioCompletionOnce(instanceId: string): {
  triggered: () => boolean;
  restore: () => void;
} {
  const originalAdd = Set.prototype.add;
  let didThrow = false;
  Set.prototype.add = function addWithInjectedPortfolioFailure(value: unknown) {
    if (!didThrow && value === instanceId) {
      didThrow = true;
      throw new Error('INJECTED_PORTFOLIO_SCAN_FAILURE');
    }
    return Reflect.apply(originalAdd, this, [value]) as Set<unknown>;
  } as typeof Set.prototype.add;
  return {
    triggered: () => didThrow,
    restore: () => {
      Set.prototype.add = originalAdd;
    },
  };
}

function emptyInventoryResponse(url: URL): Response {
  if (url.pathname.endsWith('/api/v1/connections')) return json({ connections: [] });
  if (url.pathname.endsWith('/api/scim/v2/users') || url.pathname.endsWith('/api/scim/v2/embed/users')) {
    return json({ Resources: [], totalResults: 0, startIndex: 1, itemsPerPage: 0 });
  }
  if (url.pathname.endsWith('/api/v1/models')) return json({ models: [] });
  if (url.pathname.endsWith('/api/v1/documents')) return json({ documents: [] });
  return json({ message: 'Unexpected request' }, 404);
}

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

test('portfolio endpoint is read-only, vault-gated, and rejects ambiguous refresh input', async () => {
  resetVault();
  clearPortfolioOverviewCache();

  const locked = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  assert.equal(locked.status, 423);
  assert.deepEqual(await locked.json(), { error: 'VAULT_LOCKED', reasonCode: 'VAULT_LOCKED' });

  unlockVault('portfolio-overview-handler-passphrase');
  const wrongMethod = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview', { method: 'POST' }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'GET');

  const invalidQuery = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview?refresh=1'));
  assert.equal(invalidQuery.status, 400);

  const empty = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview?refresh=true'));
  assert.equal(empty.status, 200);
  const body = await empty.json() as { coverage?: { totalInstances?: number }; metrics?: { dashboards?: { value?: number | null } } };
  assert.equal(body.coverage?.totalInstances, 0);
  assert.equal(body.metrics?.dashboards?.value, null);
});

test('portfolio endpoint returns an explicit first-snapshot refresh state without waiting for upstream reads', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example first workspace',
    role: 'both',
    baseUrl: 'https://portfolio-first.omniapp.co',
    apiKey: 'omni-first-snapshot-key-not-real',
  });
  markInstanceValidated(saved.id);
  globalThis.fetch = abortablePendingFetch();

  const startedAt = performance.now();
  const response = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  const elapsedMs = performance.now() - startedAt;
  const body = await responseBody(response);

  assert.equal(response.status, 200);
  assert.ok(elapsedMs < 500, `first portfolio response took ${elapsedMs.toFixed(1)}ms`);
  assert.deepEqual(body.refresh, {
    state: 'running',
    startedAt: body.refresh?.startedAt,
    completedInstances: 0,
    totalInstances: 1,
  });
  assert.equal(typeof body.refresh?.startedAt, 'string');
  assert.equal(body.coverage?.totalInstances, 1);
  assert.deepEqual(body.instances, []);
  assert.equal(body.metrics?.dashboards?.value, null);
  assert.ok(['fresh', 'stale'].includes(body.cache?.state || ''));

  clearPortfolioOverviewCache();
});

test('transient partial scans are persisted and served without starting another scan', async () => {
  process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS = '600000';
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example partial workspace',
    role: 'both',
    baseUrl: 'https://portfolio-partial.omniapp.co',
    apiKey: 'omni-partial-key-not-real',
  });
  markInstanceValidated(saved.id);

  let requestCount = 0;
  globalThis.fetch = (async (input) => {
    requestCount += 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({ message: 'Temporary upstream failure' }, 503);
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const first = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  assert.equal(first.status, 200);
  assert.equal((await responseBody(first)).refresh.state, 'running');

  const completed = await waitForPortfolio((body) => body.refresh?.state === 'idle');
  assert.equal(completed.partial, true);
  assert.equal(completed.metrics?.embedUsers?.value, null);
  assert.equal(completed.metrics?.embedUsers?.status, 'failed');
  assert.equal(completed.metrics?.embedUsers?.source, 'derived_instance_aggregate');
  assert.deepEqual(
    {
      value: completed.metrics?.staleUsers90d?.value,
      status: completed.metrics?.staleUsers90d?.status,
      included: completed.metrics?.staleUsers90d?.coverage
        && (completed.metrics.staleUsers90d.coverage as Record<string, unknown>).included,
      total: completed.metrics?.staleUsers90d?.coverage
        && (completed.metrics.staleUsers90d.coverage as Record<string, unknown>).total,
      reasonCode: completed.metrics?.staleUsers90d?.reasonCode,
    },
    {
      value: 0,
      status: 'partial',
      included: 1,
      total: 1,
      reasonCode: 'PARTIAL_INSTANCE_COVERAGE',
    },
    'a successful empty identity read remains an explicit partial minimum when the embed endpoint fails',
  );
  const failedEmbedRead = completed.failures?.find((failure) => failure.metric === 'embedUsers');
  assert.deepEqual(failedEmbedRead && {
    instanceId: failedEmbedRead.instanceId,
    instanceLabel: failedEmbedRead.instanceLabel,
    metric: failedEmbedRead.metric,
    status: failedEmbedRead.status,
    reasonCode: failedEmbedRead.reasonCode,
    exclusions: failedEmbedRead.exclusions,
    asOf: failedEmbedRead.asOf,
    source: failedEmbedRead.source,
    coverage: failedEmbedRead.coverage,
  }, {
    instanceId: saved.id,
    instanceLabel: 'Example partial workspace',
    metric: 'embedUsers',
    status: 'failed',
    reasonCode: 'UPSTREAM_REQUEST_FAILED',
    exclusions: [],
    asOf: completed.generatedAt,
    source: 'omni_embed_users_api',
    coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
  });
  const completedInstance = completed.instances?.[0];
  assert.equal(
    completedInstance?.metrics
      && (completedInstance.metrics as Record<string, Record<string, unknown>>).embedUsers?.source,
    'omni_embed_users_api',
  );
  assert.equal(completed.refresh?.completedInstances, 1);
  assert.equal(completed.refresh?.totalInstances, 1);
  const lifecycleEvidence = completedInstance?.metrics
    && (completedInstance.metrics as Record<string, Record<string, unknown>>).staleUsers90d;
  assert.deepEqual(lifecycleEvidence && {
    value: lifecycleEvidence.value,
    status: lifecycleEvidence.status,
    source: lifecycleEvidence.source,
    coverage: lifecycleEvidence.coverage,
    reasonCode: lifecycleEvidence.reasonCode,
  }, {
    value: 0,
    status: 'partial',
    source: 'derived_identity_activity',
    coverage: { included: 1, total: 2, unit: 'endpoints', ratio: 0.5 },
    reasonCode: 'PARTIAL_STALE_USER_RECORD_COVERAGE',
  });
  assert.ok(getPortfolioOverviewSnapshot(), 'partial scan was not persisted to the encrypted vault');

  const requestsAfterCompletion = requestCount;
  const startedAt = performance.now();
  const cachedResponse = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  const elapsedMs = performance.now() - startedAt;
  const cached = await responseBody(cachedResponse);
  assert.ok(elapsedMs < 500, `cached partial response took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(cached.generatedAt, completed.generatedAt);
  assert.equal(cached.refresh?.state, 'idle');
  assert.equal(requestCount, requestsAfterCompletion, 'cached partial result unexpectedly started another scan');
});

test('user lifecycle metrics count active source records without implying unique people and persist only compact evidence', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example lifecycle workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-lifecycle-key-not-real',
  });
  markInstanceValidated(saved.id);

  const duplicateIdentity = 'same-source-record@example.invalid';
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/scim/v2/users')) {
      return json({
        Resources: [
          { id: 'internal-stale', userName: duplicateIdentity, active: true, lastLogin: isoDaysAgo(120) },
          { id: 'internal-recent', userName: 'recent@example.invalid', active: true, lastLogin: isoDaysAgo(10) },
          { id: 'internal-never', userName: 'never@example.invalid', active: true },
          { id: 'internal-inactive', userName: 'inactive@example.invalid', active: false, lastLogin: isoDaysAgo(200) },
        ],
        totalResults: 4,
        startIndex: 1,
        itemsPerPage: 4,
      });
    }
    if (url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({
        Resources: [
          {
            id: 'embed-stale',
            userName: duplicateIdentity,
            active: true,
            embedExternalId: 'embed-stale-external',
            embedEntity: 'Example entity',
            'urn:omni:params:scim:schemas:extension:user:2.0': { lastLogin: isoDaysAgo(120) },
          },
          {
            id: 'embed-never',
            userName: 'embed-never@example.invalid',
            active: true,
            embedExternalId: 'embed-never-external',
            embedEntity: 'Example entity',
          },
        ],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
      });
    }
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({ data: [], pageInfo: { totalRecords: 0 } });
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  const instance = overview.instances[0];
  assert.ok(instance);
  assert.deepEqual(
    {
      value: instance.metrics.staleUsers90d.value,
      status: instance.metrics.staleUsers90d.status,
      source: instance.metrics.staleUsers90d.source,
      coverage: instance.metrics.staleUsers90d.coverage,
      reasonCode: instance.metrics.staleUsers90d.reasonCode,
    },
    {
      value: 2,
      status: 'available',
      source: 'derived_identity_activity',
      coverage: { included: 2, total: 2, unit: 'endpoints', ratio: 1 },
      reasonCode: 'ACTIVE_USER_RECORDS_STALE_90D',
    },
  );
  assert.ok(instance.metrics.staleUsers90d.exclusions.includes('ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE'));
  assert.ok(instance.metrics.staleUsers90d.exclusions.includes('USERS_WITHOUT_LAST_LOGIN'));
  assert.deepEqual(
    {
      value: instance.metrics.neverLoggedInUsers.value,
      status: instance.metrics.neverLoggedInUsers.status,
      source: instance.metrics.neverLoggedInUsers.source,
      reasonCode: instance.metrics.neverLoggedInUsers.reasonCode,
    },
    {
      value: 2,
      status: 'available',
      source: 'derived_identity_activity',
      reasonCode: 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN',
    },
  );
  assert.equal(overview.metrics.staleUsers90d.value, 2, 'cross-endpoint source records were incorrectly deduplicated');
  assert.equal(overview.metrics.neverLoggedInUsers.value, 2);
  assert.equal(instance.metrics.active30d.status, 'partial');
  assert.equal(instance.health, 'healthy', 'partial adoption evidence downgraded collection readiness');

  const history = getPortfolioOverviewHistory();
  assert.equal(history.length, 1);
  assert.deepEqual(
    {
      value: history[0]?.metrics.staleUsers90d?.value,
      status: history[0]?.metrics.staleUsers90d?.status,
      source: history[0]?.metrics.staleUsers90d?.source,
      reasonCode: history[0]?.metrics.staleUsers90d?.reasonCode,
      exclusions: history[0]?.metrics.staleUsers90d?.exclusions,
    },
    {
      value: 2,
      status: 'available',
      source: 'derived_instance_aggregate',
      reasonCode: 'ACTIVE_USER_RECORDS_STALE_90D',
      exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS', 'USERS_WITHOUT_LAST_LOGIN'],
    },
  );
  assert.equal(history[0]?.metrics.neverLoggedInUsers?.value, 2);

  const decrypted = decryptVaultBlob(PORTFOLIO_PASSPHRASE, readFileSync(process.env.OMNIKIT_VAULT_PATH!));
  assert.equal(decrypted.includes(duplicateIdentity), false);
  assert.equal(decrypted.includes('embed-never@example.invalid'), false);
  assert.equal(decrypted.includes('embed-stale-external'), false);
});

test('unparseable lifecycle evidence stays partial without downgrading otherwise complete collection readiness', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example malformed lifecycle workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-malformed-lifecycle-key-not-real',
  });
  markInstanceValidated(saved.id);

  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/scim/v2/users')) {
      return json({
        Resources: [{ id: 'malformed-login', userName: 'malformed@example.invalid', active: true, lastLogin: 'not-a-timestamp' }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      });
    }
    if (url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({ Resources: [], totalResults: 0, startIndex: 1, itemsPerPage: 0 });
    }
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({ data: [], pageInfo: { totalRecords: 0 } });
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  const instance = overview.instances[0];
  assert.ok(instance);
  assert.equal(instance.metrics.staleUsers90d.status, 'partial');
  assert.equal(instance.metrics.staleUsers90d.reasonCode, 'PARTIAL_STALE_USER_RECORD_COVERAGE');
  assert.equal(instance.metrics.staleUsers90d.value, 0);
  assert.equal(instance.metrics.neverLoggedInUsers.status, 'partial');
  assert.equal(instance.metrics.neverLoggedInUsers.reasonCode, 'PARTIAL_NEVER_LOGGED_IN_USER_RECORD_COVERAGE');
  assert.equal(instance.metrics.neverLoggedInUsers.value, 0);
  assert.ok(instance.metrics.staleUsers90d.exclusions.includes('USERS_WITH_UNPARSEABLE_LAST_LOGIN'));
  assert.equal(instance.health, 'healthy');
  assert.equal(instance.statusLabel, 'Healthy');
});

test('failed identity endpoints keep lifecycle metrics unavailable instead of manufacturing zeroes', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example unavailable lifecycle workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-unavailable-lifecycle-key-not-real',
  });
  markInstanceValidated(saved.id);

  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/scim/v2/users') || url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({ message: 'Temporary lifecycle inventory failure' }, 503);
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  const instance = overview.instances[0];
  assert.ok(instance);
  for (const key of ['staleUsers90d', 'neverLoggedInUsers'] as const) {
    assert.equal(instance.metrics[key].value, null);
    assert.equal(instance.metrics[key].status, 'failed');
    assert.equal(instance.metrics[key].source, 'derived_identity_activity');
    assert.equal(instance.metrics[key].reasonCode, 'UPSTREAM_REQUEST_FAILED');
    assert.deepEqual(instance.metrics[key].coverage, { included: 0, total: 2, unit: 'endpoints', ratio: 0 });
    assert.equal(overview.metrics[key].value, null);
    assert.equal(overview.metrics[key].status, 'failed');
    assert.ok(overview.failures.some((failure) => (
      failure.instanceId === instance.id
      && failure.metric === key
      && failure.status === 'failed'
      && failure.reasonCode === 'UPSTREAM_REQUEST_FAILED'
    )));
  }
});

test('refresh preserves the previous snapshot and request cancellation does not abort the shared background flight', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example retained workspace',
    role: 'both',
    baseUrl: 'https://portfolio-retained.omniapp.co',
    apiKey: 'omni-retained-key-not-real',
  });
  const validated = markInstanceValidated(saved.id);
  const fingerprint = instanceInventoryFingerprint([validated]);
  const persisted = storedOverview(validated.id, validated.label);
  setPortfolioOverviewSnapshot({ fingerprint, storedAt: Date.now(), overview: persisted });

  let backgroundSignal: AbortSignal | undefined;
  globalThis.fetch = abortablePendingFetch((signal) => {
    backgroundSignal ||= signal;
  });

  const requestController = new AbortController();
  const response = await portfolioOverviewHandler(new Request(
    'http://localhost/api/portfolio-overview?refresh=true',
    { signal: requestController.signal },
  ));
  const refreshing = await responseBody(response);
  assert.equal(response.status, 200);
  assert.equal(refreshing.generatedAt, persisted.generatedAt);
  assert.equal(refreshing.instances?.[0]?.label, 'Example retained workspace');
  assert.equal(refreshing.refresh?.state, 'running');
  assert.equal(refreshing.refresh?.completedInstances, 0);

  const signalDeadline = Date.now() + 1_000;
  while (!backgroundSignal && Date.now() < signalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(backgroundSignal, 'background collection did not start');
  requestController.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(backgroundSignal!.aborted, false, 'HTTP request cancellation aborted shared background collection');

  const followUp = await responseBody(await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview')));
  assert.equal(followUp.generatedAt, persisted.generatedAt);
  assert.equal(followUp.refresh?.state, 'running');
  assert.equal(followUp.instances?.[0]?.label, 'Example retained workspace');

  clearPortfolioOverviewCache();
});

test('a superseded origin flight cannot overwrite or leak evidence into the current inventory', async () => {
  process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS = '600000';
  process.env.OMNIKIT_PORTFOLIO_REQUEST_RETRIES = '0';
  unlockVault(PORTFOLIO_PASSPHRASE);
  const savedA = upsertInstance({
    label: 'Example origin A workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-origin-a-key-not-real',
  });
  const validatedA = markInstanceValidated(savedA.id);
  const persistedA = storedOverview(validatedA.id, validatedA.label);
  persistedA.metrics.dashboards = metric(9, 'available');
  persistedA.instances[0]!.metrics.dashboards = {
    ...metric(9, 'available'),
    source: 'omni_documents_api',
    coverage: { included: 1, total: 1, unit: 'endpoints', ratio: 1 },
  };
  setPortfolioOverviewSnapshot({
    fingerprint: instanceInventoryFingerprint([validatedA]),
    storedAt: Date.now(),
    overview: persistedA,
  });

  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let originAReleased = false;
  let originARequests = 0;
  let originAResponses = 0;
  let originBRequests = 0;
  let originBConnectionRequests = 0;
  const inventoryResponse = (url: URL, dashboardCount: number, prefix: string): Response => {
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({
        data: [],
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 0 },
      });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      return json({
        documents: Array.from({ length: dashboardCount }, (_entry, index) => ({
          identifier: `${prefix}-dashboard-${index + 1}`,
          name: `${prefix} dashboard ${index + 1}`,
          hasDashboard: true,
        })),
      });
    }
    return emptyInventoryResponse(url);
  };
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '1.1.1.1') {
      originARequests += 1;
      if (!originAReleased) await gateA;
      originAResponses += 1;
      return inventoryResponse(url, 7, 'origin-a');
    }
    assert.equal(url.hostname, '8.8.8.8');
    originBRequests += 1;
    if (url.pathname.endsWith('/api/v1/connections')) originBConnectionRequests += 1;
    return inventoryResponse(url, 1, 'origin-b');
  }) as typeof fetch;

  try {
    const originAResponse = await getPortfolioOverview({ forceRefresh: true });
    assert.equal(originAResponse.metrics.dashboards.value, 9);
    assert.equal(originAResponse.instances[0]?.label, 'Example origin A workspace');
    const originADeadline = Date.now() + 1_000;
    while (originARequests < 1 && Date.now() < originADeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(originARequests > 0, 'origin A flight did not start');

    const repointedB = upsertInstance({
      id: validatedA.id,
      label: 'Example origin B workspace',
      role: 'both',
      baseUrl: 'https://8.8.8.8',
      apiKey: 'omni-origin-b-key-not-real',
    });
    const fingerprintB = instanceInventoryFingerprint([repointedB]);
    const initialB = await getPortfolioOverview();
    assert.equal(initialB.cache.state, 'stale');
    assert.equal(initialB.refresh.state, 'running');
    assert.equal(initialB.metrics.dashboards.value, null, 'origin A metric evidence was served under origin B');
    assert.deepEqual(initialB.instances, [], 'origin A instance evidence was served under origin B');

    const completedB = await waitForPortfolio(
      (body) => body.refresh?.state === 'idle'
        && body.metrics?.dashboards?.value === 1
        && body.instances?.[0]?.label === 'Example origin B workspace',
      15_000,
    );
    assert.equal(originBConnectionRequests, 1, 'origin B started a duplicate collection flight');
    const storedB = getPortfolioOverviewSnapshot();
    assert.ok(storedB);
    assert.equal(storedB.fingerprint, fingerprintB);
    const completedBGeneratedAt = completedB.generatedAt;
    const originBRequestsAfterCompletion = originBRequests;

    originAReleased = true;
    releaseA!();

    // Repointing the instance rotated the vault session boundary, and that
    // aborts in-flight reads still holding the superseded credential — see
    // VAULT_SESSION_ABORT_SIGNAL in services/nativeVault.ts and its use in
    // services/omniClient.ts. So the released origin A flight resumes and then
    // terminates early instead of completing all five reads.
    //
    // The exact read count was only ever a precondition for the assertions
    // below; what this test proves is that a superseded flight cannot touch the
    // current evidence, and every one of those assertions is unchanged. Assert
    // that origin A genuinely resumed and then settled, rather than pinning a
    // count that the abort makes wrong.
    const originAResponsesAtRelease = originAResponses;
    const originASettleDeadline = Date.now() + 2_000;
    let previousOriginAResponses = -1;
    while (Date.now() < originASettleDeadline) {
      previousOriginAResponses = originAResponses;
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (originAResponses === previousOriginAResponses) break;
    }
    assert.equal(originAResponses, previousOriginAResponses, 'origin A flight never settled after release');
    assert.ok(
      originAResponses > originAResponsesAtRelease,
      'origin A flight never resumed after its gate was released',
    );
    assert.ok(
      originAResponses <= 5,
      `origin A flight exceeded its read budget: ${originAResponses}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const storedAfterA = getPortfolioOverviewSnapshot();
    assert.ok(storedAfterA);
    assert.equal(storedAfterA.fingerprint, fingerprintB, 'origin A overwrote the current durable fingerprint');
    const storedAfterAOverview = storedAfterA.overview as PortfolioBody;
    assert.equal(storedAfterAOverview.generatedAt, completedBGeneratedAt);
    assert.equal(storedAfterAOverview.metrics?.dashboards?.value, 1);
    assert.equal(storedAfterAOverview.instances?.[0]?.label, 'Example origin B workspace');

    const servedAfterA = await getPortfolioOverview();
    assert.equal(servedAfterA.generatedAt, completedBGeneratedAt);
    assert.equal(servedAfterA.metrics.dashboards.value, 1);
    assert.equal(servedAfterA.instances[0]?.label, 'Example origin B workspace');
    assert.equal(originBRequests, originBRequestsAfterCompletion, 'origin B cache started an unnecessary duplicate flight');
  } finally {
    originAReleased = true;
    releaseA?.();
  }
});

test('a failed refresh before a completed-instance checkpoint preserves the original snapshot and remains retryable', async () => {
  process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS = '600000';
  process.env.OMNIKIT_PORTFOLIO_REQUEST_RETRIES = '0';
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example failed refresh workspace',
    role: 'both',
    baseUrl: 'https://portfolio-failed-before-progress.omniapp.co',
    apiKey: 'omni-failed-before-progress-key-not-real',
  });
  const validated = markInstanceValidated(saved.id);
  const persisted = storedOverview(validated.id, validated.label);
  persisted.metrics.dashboards = metric(7, 'available');
  persisted.instances[0]!.metrics.dashboards = {
    ...metric(7, 'available'),
    source: 'omni_documents_api',
    coverage: { included: 1, total: 1, unit: 'endpoints', ratio: 1 },
  };
  persisted.metrics.models = metric(null, 'failed', 'PRIOR_MODEL_READ_FAILED');
  persisted.instances[0]!.metrics.models = {
    ...metric(null, 'failed', 'PRIOR_MODEL_READ_FAILED'),
    source: 'omni_models_api',
    coverage: { included: 0, total: 2, unit: 'model_kinds', ratio: 0 },
    exclusions: ['PRIOR_MODEL_EVIDENCE_UNAVAILABLE'],
  };
  setPortfolioOverviewSnapshot({
    fingerprint: instanceInventoryFingerprint([validated]),
    storedAt: Date.now(),
    overview: persisted,
  });

  const injectedFailure = failPortfolioCompletionOnce(validated.id);
  let failedScanRequests = 0;
  globalThis.fetch = (async (input) => {
    failedScanRequests += 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return emptyInventoryResponse(url);
  }) as typeof fetch;
  try {
    await getPortfolioOverview({ forceRefresh: true });
    const injectionDeadline = Date.now() + 15_000;
    while (!injectedFailure.triggered() && Date.now() < injectionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      injectedFailure.triggered(),
      true,
      `the scan-level failure was not exercised after ${failedScanRequests} upstream requests`,
    );
    await waitForPersistedPortfolio((body) => body.warnings?.includes('STALE_IF_ERROR') === true);
  } finally {
    injectedFailure.restore();
  }

  const failed = await getPortfolioOverviewSnapshot();
  const failedOverview = failed?.overview as PortfolioBody | undefined;
  assert.ok(failedOverview);
  assert.equal(failedOverview.generatedAt, persisted.generatedAt);
  assert.equal(failedOverview.cache?.state, 'stale');
  assert.equal(failedOverview.stale, true);
  assert.equal(failedOverview.partial, true);
  assert.deepEqual(failedOverview.refresh, {
    state: 'running',
    startedAt: failedOverview.refresh?.startedAt,
    completedInstances: 0,
    totalInstances: 1,
  });
  assert.equal(typeof failedOverview.refresh?.startedAt, 'string');
  assert.deepEqual(
    {
      value: failedOverview.metrics?.dashboards?.value,
      status: failedOverview.metrics?.dashboards?.status,
      asOf: failedOverview.metrics?.dashboards?.asOf,
      coverage: failedOverview.metrics?.dashboards?.coverage,
    },
    {
      value: 7,
      status: 'stale',
      asOf: persisted.generatedAt,
      coverage: persisted.metrics.dashboards.coverage,
    },
  );
  const priorFailure = failedOverview.failures?.find((failure) => failure.metric === 'models');
  assert.deepEqual(priorFailure && {
    status: priorFailure.status,
    reasonCode: priorFailure.reasonCode,
    exclusions: priorFailure.exclusions,
    asOf: priorFailure.asOf,
    source: priorFailure.source,
    coverage: priorFailure.coverage,
  }, {
    status: 'failed',
    reasonCode: 'PRIOR_MODEL_READ_FAILED',
    exclusions: ['PRIOR_MODEL_EVIDENCE_UNAVAILABLE'],
    asOf: persisted.generatedAt,
    source: 'omni_models_api',
    coverage: { included: 0, total: 2, unit: 'model_kinds', ratio: 0 },
  });
  assert.equal(getPortfolioOverviewHistory().length, 1, 'failed fallback polluted completed daily history');

  let releaseRetry: (() => void) | undefined;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let connectionRequests = 0;
  let retryRequests = 0;
  globalThis.fetch = (async (input) => {
    retryRequests += 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/connections')) connectionRequests += 1;
    await retryGate;
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  try {
    const failedStartedAt = failedOverview.refresh?.startedAt;
    const flightDeadline = Date.now() + 1_000;
    let retrying = await getPortfolioOverview();
    while (retrying.refresh.startedAt === failedStartedAt && Date.now() < flightDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      retrying = await getPortfolioOverview();
    }
    const sameFlight = await getPortfolioOverview();
    assert.equal(retrying.cache.state, 'stale');
    assert.equal(retrying.refresh.state, 'running');
    assert.notEqual(retrying.refresh.startedAt, failedStartedAt, 'the next eligible request did not start a replacement flight');
    assert.equal(retrying.generatedAt, persisted.generatedAt);
    assert.equal(retrying.metrics.dashboards.value, 7);
    assert.equal(retrying.metrics.dashboards.asOf, persisted.generatedAt);
    assert.equal(sameFlight.refresh.startedAt, retrying.refresh.startedAt);
    const retryDeadline = Date.now() + 5_000;
    while (connectionRequests < 1 && Date.now() < retryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      connectionRequests,
      1,
      `concurrent callers started duplicate replacement flights (${retryRequests} total retry requests)`,
    );
  } finally {
    releaseRetry!();
  }

  const recovered = await waitForPortfolio(
    (body) => body.refresh?.state === 'idle' && body.generatedAt !== persisted.generatedAt,
    15_000,
  );
  assert.equal(recovered.cache?.state, 'fresh');
  assert.equal(recovered.stale, false);
  assert.equal(recovered.metrics?.dashboards?.value, 0);
  assert.equal(recovered.metrics?.dashboards?.status, 'available');
  assert.equal(recovered.warnings?.includes('STALE_IF_ERROR'), false);
  const requestsAfterRecovery = retryRequests;
  await getPortfolioOverview();
  assert.equal(retryRequests, requestsAfterRecovery, 'a normal complete cache started another refresh inside TTL');
});

test('a failed refresh after a durable checkpoint survives reload and immediately starts one replacement flight', async () => {
  process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS = '600000';
  process.env.OMNIKIT_PORTFOLIO_REQUEST_RETRIES = '0';
  unlockVault(PORTFOLIO_PASSPHRASE);
  const validatedInstances = [] as Array<ReturnType<typeof markInstanceValidated>>;
  for (const [label, host] of [
    ['Example completed checkpoint workspace', 'portfolio-checkpoint-complete.omniapp.co'],
    ['Example interrupted checkpoint workspace', 'portfolio-checkpoint-interrupted.omniapp.co'],
  ] as const) {
    const saved = upsertInstance({
      label,
      role: 'both',
      baseUrl: `https://${host}`,
      apiKey: `omni-${host}-key-not-real`,
    });
    validatedInstances.push(markInstanceValidated(saved.id));
  }
  const persisted = storedOverview(validatedInstances[0]!.id, validatedInstances[0]!.label);
  persisted.coverage.totalInstances = 2;
  persisted.coverage.reportingInstances = 2;
  persisted.coverage.savedInstances = 2;
  persisted.refresh.completedInstances = 2;
  persisted.refresh.totalInstances = 2;
  persisted.metrics.reportingInstances = metric(2, 'available');
  persisted.metrics.dashboards = metric(10, 'available');
  persisted.instances[0]!.metrics.dashboards = metric(5, 'available');
  persisted.instances.push({
    ...structuredClone(persisted.instances[0]!),
    id: validatedInstances[1]!.id,
    label: validatedInstances[1]!.label,
  });
  setPortfolioOverviewSnapshot({
    fingerprint: instanceInventoryFingerprint(validatedInstances),
    storedAt: Date.now(),
    overview: persisted,
  });

  let releaseInterrupted: (() => void) | undefined;
  const interruptedGate = new Promise<void>((resolve) => {
    releaseInterrupted = resolve;
  });
  let interruptedReleased = false;
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'portfolio-checkpoint-interrupted.omniapp.co' && !interruptedReleased) {
      await interruptedGate;
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;
  const injectedFailure = failPortfolioCompletionOnce(validatedInstances[1]!.id);
  let failedRefreshStartedAt: string | undefined;
  try {
    await getPortfolioOverview({ forceRefresh: true });
    const checkpoint = await waitForPersistedPortfolio(
      (body) => body.refresh?.state === 'running' && body.refresh.completedInstances === 1,
      15_000,
    );
    const checkpointGeneratedAt = checkpoint.generatedAt;
    interruptedReleased = true;
    releaseInterrupted!();
    const failed = await waitForPersistedPortfolio(
      (body) => body.warnings?.includes('STALE_IF_ERROR') === true,
      15_000,
    );
    assert.equal(injectedFailure.triggered(), true, 'the post-checkpoint scan failure was not exercised');
    assert.equal(failed.generatedAt, checkpointGeneratedAt);
    assert.equal(failed.cache?.state, 'stale');
    assert.equal(failed.refresh?.state, 'running');
    assert.equal(failed.refresh?.completedInstances, 1);
    failedRefreshStartedAt = failed.refresh?.startedAt;
    assert.equal(failed.metrics?.dashboards?.value, 5, 'successful checkpoint totals were not retained');
    assert.equal(failed.metrics?.dashboards?.status, 'stale');
    assert.equal(failed.metrics?.dashboards?.asOf, persisted.generatedAt);
  } finally {
    interruptedReleased = true;
    releaseInterrupted?.();
    injectedFailure.restore();
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
  const durableFallback = getPortfolioOverviewSnapshot();
  assert.ok(durableFallback);

  let sameProcessConnectionRequests = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/connections')) sameProcessConnectionRequests += 1;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const replacementDeadline = Date.now() + 1_000;
    let sameProcessRetry = await getPortfolioOverview();
    while (sameProcessRetry.refresh.startedAt === failedRefreshStartedAt && Date.now() < replacementDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sameProcessRetry = await getPortfolioOverview();
    }
    const sameProcessFollower = await getPortfolioOverview();
    assert.equal(sameProcessRetry.refresh.state, 'running');
    assert.equal(sameProcessRetry.cache.state, 'stale');
    assert.notEqual(
      sameProcessRetry.refresh.startedAt,
      failedRefreshStartedAt,
      'the next eligible request did not start a same-process replacement flight',
    );
    assert.equal(sameProcessFollower.refresh.startedAt, sameProcessRetry.refresh.startedAt);
    const sameProcessDeadline = Date.now() + 5_000;
    while (sameProcessConnectionRequests < 2 && Date.now() < sameProcessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sameProcessConnectionRequests, 2, 'failed checkpoint started duplicate same-process replacement flights');
  } finally {
    clearPortfolioOverviewCache();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  setPortfolioOverviewSnapshot(durableFallback!);

  let restartConnectionRequests = 0;
  let restartRequests = 0;
  globalThis.fetch = (async (input) => {
    restartRequests += 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/connections')) restartConnectionRequests += 1;
    return emptyInventoryResponse(url);
  }) as typeof fetch;
  const hydrated = await getPortfolioOverview();
  assert.equal(hydrated.cache.state, 'stale');
  assert.equal(hydrated.refresh.state, 'running');
  assert.equal(hydrated.metrics.dashboards.value, 5);
  assert.equal(hydrated.metrics.dashboards.status, 'stale');
  assert.equal(hydrated.metrics.dashboards.asOf, persisted.generatedAt);

  const recovered = await waitForPortfolio(
    (body) => body.refresh?.state === 'idle' && body.refresh.completedInstances === 2,
    15_000,
  );
  assert.equal(restartConnectionRequests, 2);
  assert.equal(recovered.cache?.state, 'fresh');
  assert.equal(recovered.stale, false);
  assert.equal(recovered.metrics?.dashboards?.value, 0);
  assert.equal(recovered.metrics?.dashboards?.status, 'available');
  assert.equal(recovered.warnings?.includes('STALE_IF_ERROR'), false);
  const requestsAfterRecovery = restartRequests;
  await getPortfolioOverview();
  assert.equal(restartRequests, requestsAfterRecovery, 'recovered complete cache did not honor the fresh TTL');
});

test('restart hydration marks running and incomplete checkpoints stale and forces a new refresh', async () => {
  for (const checkpoint of [
    { state: 'running' as const, completedInstances: 1 },
    { state: 'idle' as const, completedInstances: 0 },
  ]) {
    clearPortfolioOverviewCache();
    resetVault();
    unlockVault(PORTFOLIO_PASSPHRASE);
    const saved = upsertInstance({
      label: `Example interrupted ${checkpoint.state} workspace`,
      role: 'both',
      baseUrl: `https://portfolio-interrupted-${checkpoint.state}.omniapp.co`,
      apiKey: `omni-interrupted-${checkpoint.state}-key-not-real`,
    });
    const validated = markInstanceValidated(saved.id);
    const persisted = storedOverview(validated.id, validated.label);
    persisted.refresh = {
      state: checkpoint.state,
      startedAt: '2026-08-06T14:59:00.000Z',
      ...(checkpoint.state === 'idle' ? { completedAt: persisted.generatedAt } : {}),
      completedInstances: checkpoint.completedInstances,
      totalInstances: 1,
    };
    setPortfolioOverviewSnapshot({
      fingerprint: instanceInventoryFingerprint([validated]),
      storedAt: Date.now(),
      overview: persisted,
    });

    let upstreamStarted = false;
    globalThis.fetch = abortablePendingFetch(() => {
      upstreamStarted = true;
    });

    const hydrated = await responseBody(await portfolioOverviewHandler(
      new Request('http://localhost/api/portfolio-overview'),
    ));
    assert.equal(hydrated.generatedAt, persisted.generatedAt);
    assert.equal(hydrated.metrics?.dashboards?.asOf, persisted.generatedAt);
    assert.equal(hydrated.metrics?.dashboards?.source, 'derived_instance_aggregate');
    assert.equal(hydrated.metrics?.dashboards?.status, 'stale');
    assert.equal(hydrated.cache?.state, 'stale');
    assert.equal(hydrated.partial, true);
    assert.equal(hydrated.refresh?.state, 'running');
    assert.ok(
      Array.isArray(hydrated.warnings) && hydrated.warnings.includes('INTERRUPTED_REFRESH_CHECKPOINT'),
      `${checkpoint.state} checkpoint did not expose the exact interrupted-refresh warning`,
    );

    const requestDeadline = Date.now() + 1_000;
    while (!upstreamStarted && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(upstreamStarted, true, `${checkpoint.state} checkpoint did not force a background refresh`);
    clearPortfolioOverviewCache();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
});

test('legacy portfolio snapshots hydrate with explicitly unknown provenance', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example legacy snapshot workspace',
    role: 'both',
    baseUrl: 'https://portfolio-legacy-snapshot.omniapp.co',
    apiKey: 'omni-legacy-snapshot-key-not-real',
  });
  const validated = markInstanceValidated(saved.id);
  const legacyOverview = structuredClone(storedOverview(validated.id, validated.label));
  delete (legacyOverview as typeof legacyOverview & { failures?: unknown }).failures;
  for (const evidence of Object.values(legacyOverview.metrics)) delete evidence.source;
  for (const instance of legacyOverview.instances) {
    for (const evidence of Object.values(instance.metrics)) delete evidence.source;
  }
  setPortfolioOverviewSnapshot({
    fingerprint: instanceInventoryFingerprint([validated]),
    storedAt: Date.now(),
    overview: legacyOverview,
  });

  let upstreamRequests = 0;
  globalThis.fetch = (async () => {
    upstreamRequests += 1;
    return json({ message: 'Unexpected request' }, 500);
  }) as typeof fetch;
  const hydrated = await getPortfolioOverview();

  assert.equal(hydrated.refresh.state, 'idle');
  assert.equal(hydrated.metrics.dashboards.source, 'legacy_snapshot_unknown');
  assert.equal(hydrated.instances[0]?.metrics.dashboards.source, 'legacy_snapshot_unknown');
  assert.ok(hydrated.warnings.includes('LEGACY_SNAPSHOT_PROVENANCE_UNKNOWN'));
  assert.ok(hydrated.failures.every((failure) => failure.source === 'legacy_snapshot_unknown'));
  assert.equal(upstreamRequests, 0, 'a fresh complete legacy snapshot unexpectedly started a refresh');
});

test('legacy snapshots missing lifecycle metrics hydrate as unsupported evidence while a replacement refresh starts', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example pre-lifecycle snapshot workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-pre-lifecycle-key-not-real',
  });
  const validated = markInstanceValidated(saved.id);
  const legacyOverview = structuredClone(storedOverview(validated.id, validated.label));
  delete (legacyOverview.metrics as Partial<typeof legacyOverview.metrics>).staleUsers90d;
  delete (legacyOverview.metrics as Partial<typeof legacyOverview.metrics>).neverLoggedInUsers;
  delete (legacyOverview.instances[0]!.metrics as Partial<typeof legacyOverview.instances[0]['metrics']>).staleUsers90d;
  delete (legacyOverview.instances[0]!.metrics as Partial<typeof legacyOverview.instances[0]['metrics']>).neverLoggedInUsers;
  setPortfolioOverviewSnapshot({
    fingerprint: instanceInventoryFingerprint([validated]),
    storedAt: Date.now(),
    overview: legacyOverview,
  });

  let refreshStarted = false;
  globalThis.fetch = abortablePendingFetch(() => {
    refreshStarted = true;
  });
  const hydrated = await getPortfolioOverview();

  assert.equal(hydrated.metrics.staleUsers90d.value, null);
  assert.equal(hydrated.metrics.staleUsers90d.status, 'unsupported');
  assert.equal(hydrated.metrics.staleUsers90d.source, 'legacy_snapshot_unknown');
  assert.equal(hydrated.metrics.staleUsers90d.reasonCode, 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE');
  assert.equal(hydrated.instances[0]?.metrics.neverLoggedInUsers.value, null);
  assert.equal(hydrated.instances[0]?.metrics.neverLoggedInUsers.status, 'unsupported');
  assert.equal(hydrated.instances[0]?.metrics.neverLoggedInUsers.source, 'legacy_snapshot_unknown');
  assert.ok(hydrated.warnings.includes('LEGACY_SNAPSHOT_METRICS_UNAVAILABLE'));
  assert.ok(hydrated.failures.some((failure) => failure.metric === 'staleUsers90d'));
  assert.equal(hydrated.cache.state, 'stale');
  assert.equal(hydrated.refresh.state, 'running');

  const deadline = Date.now() + 1_000;
  while (!refreshStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(refreshStarted, true);
  clearPortfolioOverviewCache();
});

test('portfolio refresh reports progressive canonical-instance completion', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const validatedInstances: Array<ReturnType<typeof markInstanceValidated>> = [];
  for (const [label, host] of [
    ['Example fast workspace', 'portfolio-progress-fast.omniapp.co'],
    ['Example gated workspace', 'portfolio-progress-gated.omniapp.co'],
  ] as const) {
    const saved = upsertInstance({
      label,
      role: 'both',
      baseUrl: `https://${host}`,
      apiKey: `omni-${label.toLowerCase().replace(/\s+/g, '-')}-key-not-real`,
    });
    validatedInstances.push(markInstanceValidated(saved.id));
  }

  const persisted = storedOverview(validatedInstances[0]!.id, validatedInstances[0]!.label);
  persisted.coverage.totalInstances = 2;
  persisted.coverage.reportingInstances = 2;
  persisted.coverage.savedInstances = 2;
  persisted.refresh.completedInstances = 2;
  persisted.refresh.totalInstances = 2;
  persisted.metrics.reportingInstances = metric(2, 'available');
  persisted.instances.push({
    ...structuredClone(persisted.instances[0]!),
    id: validatedInstances[1]!.id,
    label: validatedInstances[1]!.label,
  });
  setPortfolioOverviewSnapshot({
    fingerprint: instanceInventoryFingerprint(validatedInstances),
    storedAt: Date.now() - 11 * 60_000,
    overview: persisted,
  });

  let releaseGated: (() => void) | undefined;
  let gatedReleased = false;
  const gated = new Promise<void>((resolve) => {
    releaseGated = () => {
      gatedReleased = true;
      resolve();
    };
  });
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'portfolio-progress-gated.omniapp.co' && !gatedReleased) await gated;
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await responseBody(await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview')));
  assert.equal(initial.refresh?.state, 'running');
  assert.equal(initial.refresh?.totalInstances, 2);

  const midway = await waitForPortfolio(
    (body) => body.refresh?.state === 'running' && body.refresh?.completedInstances === 1,
    15_000,
  );
  assert.equal(midway.coverage?.totalInstances, 2);
  assert.equal(midway.instances?.length, 2);
  const retained = midway.instances?.find((instance) => instance.label === 'Example gated workspace');
  assert.equal(retained?.metrics && (retained.metrics as Record<string, Record<string, unknown>>).dashboards?.asOf, persisted.generatedAt);
  assert.equal(midway.metrics?.dashboards?.asOf, persisted.generatedAt);
  releaseGated!();

  const completed = await waitForPortfolio(
    (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 2,
    15_000,
  );
  assert.equal(completed.instances?.length, 2);
  assert.equal(completed.coverage?.reportingInstances, 2);
});

test('vault normalizes legacy payloads and rejects sensitive portfolio snapshot material', () => {
  const legacy = normalizeVaultPayload({
    version: 1,
    instances: [],
    deckRecipes: [],
  }) as unknown as {
    portfolioOverviewSnapshot?: unknown;
    portfolioOverviewHistory: unknown[];
  };
  assert.equal(legacy.portfolioOverviewSnapshot, undefined);
  assert.deepEqual(legacy.portfolioOverviewHistory, []);

  const legacyHistoryMetric = {
    value: 1,
    status: 'available',
    asOf: '2026-08-06T15:00:00.000Z',
    coverage: { included: 1, total: 1 },
    reasonCode: null,
  };
  const legacyHistoryMetricKeys = [
    'reportingInstances',
    'internalMemberships',
    'estimatedUniquePeople',
    'embedUsers',
    'embedEntities',
    'active7d',
    'active30d',
    'active90d',
    'dashboards',
    'models',
    'topics',
    'aiChats',
    'apps',
  ];
  const normalizedLegacyHistory = normalizeVaultPayload({
    version: 1,
    instances: [],
    deckRecipes: [],
    portfolioOverviewHistory: [{
      day: '2026-08-06',
      storedAt: Date.UTC(2026, 7, 6, 15),
      generatedAt: '2026-08-06T15:00:00.000Z',
      coverage: {
        totalInstances: 1,
        reportingInstances: 1,
        partialInstances: 0,
        staleInstances: 0,
        unavailableInstances: 0,
        savedInstances: 1,
        duplicateSavedOrigins: 0,
      },
      metrics: Object.fromEntries(legacyHistoryMetricKeys.map((key) => [key, legacyHistoryMetric])),
      partial: false,
      stale: false,
    }],
  }) as unknown as {
    portfolioOverviewHistory: Array<{
      metrics: Record<string, {
        value: number | null;
        status: string;
        source: string;
        reasonCode: string | null;
        exclusions: string[];
      }>;
    }>;
  };
  assert.equal(normalizedLegacyHistory.portfolioOverviewHistory.length, 1);
  assert.deepEqual(normalizedLegacyHistory.portfolioOverviewHistory[0]?.metrics.staleUsers90d, {
    value: null,
    status: 'unsupported',
    source: 'legacy_snapshot_unknown',
    asOf: '2026-08-06T15:00:00.000Z',
    coverage: { included: 0, total: 1 },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'LEGACY_HISTORY_METRIC_UNAVAILABLE'],
    reasonCode: 'LEGACY_HISTORY_METRIC_UNAVAILABLE',
    reasonLabel: 'This legacy history entry predates the source-record lifecycle metric',
  });
  assert.equal(
    normalizedLegacyHistory.portfolioOverviewHistory[0]?.metrics.dashboards?.source,
    'legacy_snapshot_unknown',
  );

  unlockVault(PORTFOLIO_PASSPHRASE);
  const safeOverview = storedOverview('opaque-instance-id');
  const failedDashboardMetric = {
    ...metric(null, 'failed', 'UPSTREAM_REQUEST_FAILED'),
    source: 'omni_documents_api',
  };
  safeOverview.metrics.dashboards = failedDashboardMetric;
  safeOverview.instances[0]!.metrics.dashboards = failedDashboardMetric;
  safeOverview.failures = [{
    id: 'opaque-failure-id',
    message: 'A portfolio metric could not be collected for this instance.',
    instanceId: 'opaque-instance-id',
    instanceLabel: 'Example workspace',
    metric: 'dashboards',
    status: 'failed',
    reasonCode: 'UPSTREAM_REQUEST_FAILED',
    exclusions: [],
    asOf: failedDashboardMetric.asOf,
    source: 'omni_documents_api',
    coverage: failedDashboardMetric.coverage,
  }];
  const safeSnapshot = {
    fingerprint: createHash('sha256').update('safe-snapshot').digest('hex'),
    storedAt: Date.now(),
    overview: safeOverview,
  };
  setPortfolioOverviewSnapshot(safeSnapshot);
  assert.deepEqual(getPortfolioOverviewSnapshot()?.overview, safeOverview);
  const safePersistedOverview = getPortfolioOverviewSnapshot()?.overview as {
    metrics?: { dashboards?: { source?: string } };
    failures?: Array<{ metric?: string; source?: string }>;
  };
  assert.equal(safePersistedOverview.metrics?.dashboards?.source, 'omni_documents_api');
  assert.deepEqual(safePersistedOverview.failures?.[0], {
    id: 'opaque-failure-id',
    message: 'A portfolio metric could not be collected for this instance.',
    instanceId: 'opaque-instance-id',
    instanceLabel: 'Example workspace',
    metric: 'dashboards',
    status: 'failed',
    reasonCode: 'UPSTREAM_REQUEST_FAILED',
    exclusions: [],
    asOf: failedDashboardMetric.asOf,
    source: 'omni_documents_api',
    coverage: failedDashboardMetric.coverage,
  });

  const legacyOverview = structuredClone(storedOverview('legacy-opaque-instance'));
  delete (legacyOverview as typeof legacyOverview & { failures?: unknown }).failures;
  for (const evidence of Object.values(legacyOverview.metrics)) delete evidence.source;
  for (const instance of legacyOverview.instances) {
    for (const evidence of Object.values(instance.metrics)) delete evidence.source;
  }
  assert.doesNotThrow(() => setPortfolioOverviewSnapshot({
    fingerprint: createHash('sha256').update('legacy-safe-snapshot').digest('hex'),
    storedAt: Date.now(),
    overview: legacyOverview,
  }));

  const prohibitedSnapshots: Array<[string, Record<string, unknown>]> = [
    ['apiKey', { apiKey: 'omni-sensitive-key' }],
    ['email', { label: 'person@example.invalid' }],
    ['base URL', { label: 'https://private.example.invalid' }],
    ['raw users', { users: [{ id: 'raw-user' }] }],
    ['credentials', { credentials: { token: 'sensitive-token' } }],
    ['raw upstream response', { rawResponse: { records: [] } }],
  ];
  for (const [label, unsafeOverview] of prohibitedSnapshots) {
    assert.throws(
      () => setPortfolioOverviewSnapshot({ ...safeSnapshot, overview: unsafeOverview }),
      undefined,
      `${label} was accepted into the portfolio snapshot`,
    );
  }

  const decrypted = JSON.parse(decryptVaultBlob(PORTFOLIO_PASSPHRASE, readFileSync(process.env.OMNIKIT_VAULT_PATH!))) as {
    portfolioOverviewSnapshot?: { overview?: unknown };
    portfolioOverviewHistory?: unknown[];
  };
  const serializedSnapshot = JSON.stringify(decrypted.portfolioOverviewSnapshot?.overview);
  for (const prohibited of [
    'omni-sensitive-key',
    'person@example.invalid',
    'https://private.example.invalid',
    'raw-user',
    'sensitive-token',
    'rawResponse',
  ]) {
    assert.equal(serializedSnapshot.includes(prohibited), false, `encrypted snapshot payload retained ${prohibited}`);
  }
  assert.equal(Array.isArray(decrypted.portfolioOverviewHistory), true);
});

test('vault retains compact idempotent daily history only for completed scans', () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const fingerprint = createHash('sha256').update('daily-history').digest('hex');
  const firstOverview = storedOverview('history-instance-id', 'History workspace');
  firstOverview.metrics.dashboards = metric(3, 'available');
  setPortfolioOverviewSnapshot({
    fingerprint,
    storedAt: Date.UTC(2026, 0, 10, 1),
    overview: firstOverview,
  });

  const sameDayOverview = storedOverview('history-instance-id', 'History workspace');
  sameDayOverview.metrics.dashboards = metric(7, 'available');
  setPortfolioOverviewSnapshot({
    fingerprint,
    storedAt: Date.UTC(2026, 0, 10, 23),
    overview: sameDayOverview,
  });

  const inProgressOverview = storedOverview('history-instance-id', 'History workspace');
  inProgressOverview.refresh.state = 'running';
  setPortfolioOverviewSnapshot({
    fingerprint,
    storedAt: Date.UTC(2026, 0, 11, 12),
    overview: inProgressOverview,
  });

  const history = getPortfolioOverviewHistory();
  assert.equal(history.length, 1, 'same-day or incomplete snapshots created duplicate history entries');
  assert.equal(history[0]?.day, '2026-01-10');
  assert.equal(history[0]?.metrics.dashboards?.value, 7);
  assert.equal(history[0]?.metrics.staleUsers90d?.value, 0);
  assert.equal(history[0]?.metrics.staleUsers90d?.source, 'derived_instance_aggregate');
  assert.equal(history[0]?.metrics.staleUsers90d?.reasonCode, 'ACTIVE_USER_RECORDS_STALE_90D');
  assert.equal(history[0]?.metrics.neverLoggedInUsers?.value, 0);
  assert.equal(history[0]?.metrics.neverLoggedInUsers?.source, 'derived_instance_aggregate');
  assert.equal(history[0]?.metrics.neverLoggedInUsers?.reasonCode, 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN');
  assert.equal(history[0]?.coverage.totalInstances, 1);
  assert.equal(Object.hasOwn(history[0] || {}, 'instances'), false);
  assert.equal(Object.hasOwn(history[0] || {}, 'connections'), false);
  assert.equal(Object.hasOwn(history[0] || {}, 'overview'), false);
  assert.equal(Object.hasOwn(history[0] || {}, 'fingerprint'), false);

  const encryptedBlob = readFileSync(process.env.OMNIKIT_VAULT_PATH!);
  assert.equal(encryptedBlob.includes(Buffer.from('portfolioOverviewHistory', 'utf8')), false);
  const decrypted = JSON.parse(decryptVaultBlob(PORTFOLIO_PASSPHRASE, encryptedBlob)) as {
    portfolioOverviewHistory?: unknown[];
  };
  const serializedHistory = JSON.stringify(decrypted.portfolioOverviewHistory);
  assert.equal(serializedHistory.includes('history-instance-id'), false);
  assert.equal(serializedHistory.includes('History workspace'), false);
});

test('vault daily portfolio history is bounded to the latest 90 UTC days', () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const fingerprint = createHash('sha256').update('bounded-history').digest('hex');
  for (let dayOffset = 0; dayOffset < 95; dayOffset += 1) {
    const overview = storedOverview('bounded-history-instance');
    overview.metrics.dashboards = metric(dayOffset, 'available');
    setPortfolioOverviewSnapshot({
      fingerprint,
      storedAt: Date.UTC(2026, 0, 1 + dayOffset, 12),
      overview,
    });
  }

  const history = getPortfolioOverviewHistory();
  assert.equal(history.length, 90);
  assert.equal(history[0]?.day, '2026-04-05');
  assert.equal(history[0]?.metrics.dashboards?.value, 94);
  assert.equal(history.at(-1)?.day, '2026-01-06');
  assert.equal(history.at(-1)?.metrics.dashboards?.value, 5);
});

test('portfolio configuration rejects ambiguous app labels and preserves legacy instances', () => {
  const legacy = normalizeVaultPayload({
    version: 1,
    instances: [{
      id: 'legacy-instance',
      label: 'Legacy workspace',
      role: 'both',
      baseUrl: 'https://1.1.1.1',
      apiKey: 'omni-legacy-key-not-real',
      metricFilter: {},
      postMigrationActions: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }],
  }) as unknown as { instances: Array<{ organizationApiKeyConfirmed?: boolean; portfolioAppLabel?: string }> };
  assert.equal(legacy.instances[0]?.organizationApiKeyConfirmed, false);
  assert.equal(legacy.instances[0]?.portfolioAppLabel, undefined);

  unlockVault(PORTFOLIO_PASSPHRASE);
  assert.throws(() => upsertInstance({
    label: 'Invalid label workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-invalid-label-key-not-real',
    portfolioAppLabel: 'app,production',
  }), /cannot contain commas or control characters/i);
});

test('AI conversation totals reject malformed pagination evidence', async () => {
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.pathname, '/api/v1/ai/conversations');
    assert.equal(url.searchParams.get('pageSize'), '1');
    return json({ data: [], pageInfo: { totalRecords: 1.5 } });
  }) as typeof fetch;

  const client = new OmniClient({
    label: 'Malformed AI inventory',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-malformed-ai-key-not-real',
  }, { maxReadRetries: 0 });
  await assert.rejects(() => client.countAiConversations(), OmniPaginationError);
});

test('topic summaries use the model-scoped topic endpoint without reading authored YAML', async () => {
  let requestedPath = '';
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requestedPath = url.pathname;
    return json({
      success: true,
      topics: [
        { name: 'orders', label: 'Orders', description: 'Curated order analysis.' },
        { name: 'customers', ide_file_name: 'customers.topic' },
      ],
    });
  }) as typeof fetch;

  const client = new OmniClient({
    label: 'Topic inventory workspace',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-topic-inventory-key-not-real',
  }, { maxReadRetries: 0 });
  const topics = await client.listModelTopicSummaries('model-1');

  assert.equal(requestedPath, '/api/v1/models/model-1/topic');
  assert.deepEqual(topics, [
    { name: 'customers', fileName: 'customers.topic' },
    { name: 'orders', label: 'Orders', description: 'Curated order analysis.' },
  ]);
});

test('topic inventory preserves successful model counts when another model is unreadable', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Partial topic workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-partial-topic-key-not-real',
  });
  markInstanceValidated(saved.id);

  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/models')) {
      if (url.searchParams.get('modelKind') === 'SHARED') {
        return json({ models: [
          { id: 'readable-model', name: 'Readable Model', kind: 'SHARED', connectionId: 'connection-1' },
          { id: 'restricted-model', name: 'Restricted Model', kind: 'SHARED', connectionId: 'connection-1' },
        ] });
      }
      return json({ models: [] });
    }
    if (url.pathname.endsWith('/api/v1/models/readable-model/topic')) {
      return json({ success: true, topics: [{ name: 'orders' }, { name: 'customers' }] });
    }
    if (url.pathname.endsWith('/api/v1/models/restricted-model/topic')) {
      return json({ message: 'Topic access denied' }, 403);
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        20_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.deepEqual(
    {
      value: overview.metrics.topics.value,
      status: overview.metrics.topics.status,
      included: overview.metrics.topics.coverage.included,
      total: overview.metrics.topics.coverage.total,
      reasonCode: overview.metrics.topics.reasonCode,
    },
    { value: 2, status: 'partial', included: 1, total: 1, reasonCode: 'PARTIAL_INSTANCE_COVERAGE' },
  );
  const instanceTopics = overview.instances[0]?.metrics.topics;
  assert.equal(instanceTopics?.reasonCode, 'PARTIAL_TOPIC_MODEL_COVERAGE');
  assert.deepEqual(instanceTopics?.coverage, { included: 1, total: 2, unit: 'endpoints', ratio: 0.5 });
  assert.ok(instanceTopics?.exclusions.includes('MODELS_WITH_UNREADABLE_TOPICS'));
});

test('organization scope and App metadata are detected automatically', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Governed portfolio workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-governed-portfolio-key-not-real',
  });
  markInstanceValidated(saved.id);

  let aiRequests = 0;
  let appRequests = 0;
  const promptSentinel = 'CONFIDENTIAL_PROMPT_MUST_NOT_PERSIST';
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      aiRequests += 1;
      assert.equal(url.searchParams.get('pageSize'), '1');
      assert.equal(url.searchParams.has('cursor'), false);
      return json({
        data: [{ id: 'conversation-1', lastUserPrompt: promptSentinel }],
        pageInfo: { hasNextPage: true, nextCursor: 'must-not-be-read', pageSize: 1, totalRecords: 7 },
      });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      appRequests += 1;
      assert.equal(url.searchParams.has('labels'), false);
      return json({ documents: [
        { identifier: 'app-active', name: 'Operations App', hasApp: true, hasDashboard: false },
        { identifier: 'workbook-active', name: 'Operations Workbook', hasApp: false, hasDashboard: false },
        { identifier: 'app-deleted', name: 'Archived App', hasApp: true, hasDashboard: false, deleted: true },
      ] });
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.deepEqual(
    { value: overview.metrics.aiChats.value, status: overview.metrics.aiChats.status },
    { value: 7, status: 'available' },
  );
  assert.ok(overview.metrics.aiChats.exclusions.includes('PROMPT_CONTENT_NOT_RETAINED'));
  assert.deepEqual(
    { value: overview.metrics.apps.value, status: overview.metrics.apps.status },
    { value: 1, status: 'available' },
  );
  assert.ok(overview.metrics.apps.exclusions.includes('APPS_BETA_DOCUMENT_METADATA'));
  assert.equal(aiRequests, 1, 'AI conversation inventory paginated or retried unexpectedly');
  assert.equal(appRequests, 1, 'App inventory made an unexpected additional document read');

  const serialized = JSON.stringify(overview);
  assert.equal(serialized.includes(promptSentinel), false);
  const decrypted = decryptVaultBlob(PORTFOLIO_PASSPHRASE, readFileSync(process.env.OMNIKIT_VAULT_PATH!));
  assert.equal(decrypted.includes(promptSentinel), false);
});

test('App inventory falls back to an optional governed label when native metadata is absent', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Legacy App metadata workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-legacy-app-key-not-real',
    portfolioAppLabel: 'omnikit-app',
  });
  markInstanceValidated(saved.id);

  let appLabelRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({ data: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 0 } });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      if (url.searchParams.get('labels') === 'omnikit-app') {
        appLabelRequests += 1;
        return json({ documents: [
          { identifier: 'legacy-app', name: 'Legacy App', labels: ['omnikit-app'] },
          { identifier: 'legacy-app-deleted', name: 'Archived Legacy App', labels: ['omnikit-app'], deleted: true },
        ] });
      }
      return json({ documents: [
        { identifier: 'legacy-workbook', name: 'Legacy Workbook', hasDashboard: false },
      ] });
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.deepEqual(
    { value: overview.metrics.apps.value, status: overview.metrics.apps.status },
    { value: 1, status: 'available' },
  );
  assert.ok(overview.metrics.apps.exclusions.includes('APPS_DEFINED_BY_LEGACY_DOCUMENT_LABEL_FALLBACK'));
  assert.equal(appLabelRequests, 1);
});

test('organization scope failure prevents the AI conversation inventory request without manual configuration', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Unverified organization scope',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-unverified-org-key-not-real',
  });
  markInstanceValidated(saved.id);

  let aiRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      aiRequests += 1;
      return json({ data: [], pageInfo: { totalRecords: 99 } });
    }
    if (url.pathname.endsWith('/api/scim/v2/users')) return json({ message: 'Organization scope denied' }, 403);
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.equal(aiRequests, 0);
  assert.equal(overview.metrics.aiChats.value, null);
  assert.equal(overview.metrics.aiChats.reasonCode, 'AI_CONVERSATION_SCOPE_UNVERIFIED');
  assert.ok(overview.metrics.aiChats.exclusions.includes('AI_CONVERSATION_COUNT_NOT_REQUESTED_WITHOUT_ORG_SCOPE_EVIDENCE'));
});

test('portfolio aggregation preserves evidence, exclusions, duplicate origins, and privacy boundaries', async () => {
  resetVault();
  unlockVault('portfolio-overview-test-passphrase');

  upsertInstance({
    label: 'Regional Analytics Primary',
    role: 'both',
    baseUrl: 'https://1.1.1.1/tenant-primary',
    apiKey: 'omni-primary-secret-not-real',
  });
  const canonical = upsertInstance({
    label: 'Regional Analytics Canonical',
    role: 'both',
    baseUrl: 'https://1.1.1.1/tenant-canonical',
    apiKey: 'omni-canonical-secret-not-real',
  });
  markInstanceValidated(canonical.id);
  upsertInstance({
    label: 'Restricted Analytics',
    role: 'both',
    baseUrl: 'https://1.0.0.1/restricted',
    apiKey: 'omni-restricted-secret-not-real',
  });

  const requestedPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requestedPaths.push(url.pathname);

    if (url.pathname.startsWith('/restricted/')) {
      return json({ message: 'Access denied for user@example.invalid' }, 403);
    }
    assert.ok(url.pathname.startsWith('/tenant-canonical/'), `unexpected canonical path: ${url.pathname}`);

    if (url.pathname.endsWith('/api/v1/connections')) {
      return json({ connections: [{ id: 'connection-1', name: 'Primary Warehouse' }] });
    }
    if (url.pathname.endsWith('/api/scim/v2/users')) {
      return json({
        Resources: [
          { id: 'member-1', userName: 'analyst.one@example.invalid', active: true, emails: [{ value: 'analyst.one@example.invalid', primary: true }] },
          { id: 'member-2', userName: 'analyst.two@example.invalid', active: true, emails: [{ value: 'analyst.two@example.invalid', primary: true }] },
        ],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
      });
    }
    if (url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({
        Resources: [{
          id: 'embed-1',
          userName: 'embedded@example.invalid',
          active: true,
          embedExternalId: 'external-1',
          embedEntity: 'Entity Alpha',
        }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      });
    }
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({ data: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 3 } });
    }
    if (url.pathname.endsWith('/api/v1/models')) {
      const kind = url.searchParams.get('modelKind');
      if (kind === 'SHARED') {
        return json({ models: [
          { id: 'shared-active', name: 'Shared Model', kind: 'SHARED', connectionId: 'connection-1' },
          { id: 'wrong-schema', name: 'Schema Model', kind: 'SCHEMA', connectionId: 'connection-1' },
          { id: 'shared-deleted', name: 'Deleted Shared', kind: 'SHARED', deletedAt: '2026-08-01T00:00:00.000Z', connectionId: 'connection-1' },
        ] });
      }
      if (kind === 'SHARED_EXTENSION') {
        return json({ models: [
          { id: 'extension-active', name: 'Extension Model', kind: 'SHARED_EXTENSION', connectionId: 'connection-1' },
          { id: 'wrong-branch', name: 'Branch Model', kind: 'BRANCH', connectionId: 'connection-1' },
        ] });
      }
    }
    if (url.pathname.endsWith('/api/v1/models/shared-active/topic')) {
      return json({ success: true, topics: [{ name: 'operations', label: 'Operations Topic' }] });
    }
    if (url.pathname.endsWith('/api/v1/models/extension-active/topic')) {
      return json({ success: true, topics: [] });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      return json({ documents: [
        { id: 'dashboard-active', name: 'Executive Operations', hasApp: false, hasDashboard: true, connectionId: 'connection-1' },
        { id: 'app-active', name: 'Operations App', hasApp: true, hasDashboard: false, connectionId: 'connection-1' },
        { id: 'not-dashboard', name: 'Notebook', hasApp: false, hasDashboard: false, connectionId: 'connection-1' },
        { id: 'dashboard-deleted', name: 'Deleted Dashboard', hasApp: false, hasDashboard: true, deleted: true, connectionId: 'connection-1' },
      ] });
    }
    return json({ message: 'Unexpected request' }, 404);
  };

  clearPortfolioOverviewCache();
  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 2,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.equal(overview.coverage.savedInstances, 3);
  assert.equal(overview.coverage.totalInstances, 2);
  assert.equal(overview.coverage.duplicateSavedOrigins, 1);
  assert.equal(overview.duplicateSavedOrigins[0]?.savedInstanceCount, 2);
  assert.equal(overview.instances.length, 2);
  assert.ok(!requestedPaths.some((path) => path.startsWith('/tenant-primary/')));

  const canonicalInstance = overview.instances.find((instance) => instance.label === 'Regional Analytics Canonical');
  const restrictedInstance = overview.instances.find((instance) => instance.label === 'Restricted Analytics');
  assert.ok(canonicalInstance);
  assert.ok(restrictedInstance);

  assert.deepEqual(
    { value: canonicalInstance.metrics.dashboards.value, status: canonicalInstance.metrics.dashboards.status },
    { value: 1, status: 'available' },
  );
  assert.deepEqual(
    { value: canonicalInstance.metrics.models.value, status: canonicalInstance.metrics.models.status },
    { value: 2, status: 'available' },
  );
  assert.deepEqual(
    { value: canonicalInstance.metrics.topics.value, status: canonicalInstance.metrics.topics.status },
    { value: 1, status: 'available' },
  );
  assert.equal(canonicalInstance.metrics.active30d.value, null);
  assert.equal(canonicalInstance.metrics.active30d.status, 'unsupported');
  assert.equal(canonicalInstance.metrics.active30d.reasonCode, 'LAST_LOGIN_EVIDENCE_UNAVAILABLE');

  assert.equal(restrictedInstance.metrics.dashboards.value, null);
  assert.equal(restrictedInstance.metrics.dashboards.status, 'permission_denied');
  assert.equal(restrictedInstance.metrics.staleUsers90d.value, null);
  assert.equal(restrictedInstance.metrics.staleUsers90d.status, 'permission_denied');
  assert.equal(restrictedInstance.metrics.neverLoggedInUsers.value, null);
  assert.equal(restrictedInstance.metrics.neverLoggedInUsers.status, 'permission_denied');
  assert.ok(
    overview.failures.some((failure) => (
      failure.instanceId === restrictedInstance.id
      && failure.metric === 'staleUsers90d'
      && failure.status === 'permission_denied'
    )),
    'unavailable lifecycle evidence was not preserved in failure summaries',
  );
  assert.equal(overview.metrics.dashboards.value, 1);
  assert.equal(overview.metrics.dashboards.status, 'partial');
  assert.equal(overview.metrics.active30d.value, null);
  assert.notEqual(overview.metrics.active30d.status, 'available');

  assert.deepEqual(
    { value: overview.metrics.aiChats.value, status: overview.metrics.aiChats.status },
    { value: 3, status: 'partial' },
  );
  assert.deepEqual(
    { value: overview.metrics.apps.value, status: overview.metrics.apps.status, reasonCode: overview.metrics.apps.reasonCode },
    { value: 1, status: 'partial', reasonCode: 'PARTIAL_INSTANCE_COVERAGE' },
  );

  const serialized = JSON.stringify(overview);
  for (const secret of [
    'analyst.one@example.invalid',
    'analyst.two@example.invalid',
    'embedded@example.invalid',
    'omni-primary-secret-not-real',
    'omni-canonical-secret-not-real',
    'omni-restricted-secret-not-real',
    'https://1.1.1.1',
    'https://1.0.0.1',
  ]) {
    assert.equal(serialized.includes(secret), false, `aggregate leaked ${secret}`);
  }
});

test('frontend parser preserves partial, stale, not-configured, and estimated metrics', () => {
  const parsed = parsePortfolioOverview({
    generatedAt: '2026-08-06T15:00:00.000Z',
    coverage: {
      totalInstances: 2,
      reportingInstances: 1,
      partialInstances: 1,
      staleInstances: 1,
      unavailableInstances: 0,
    },
    metrics: {
      reportingInstances: metric(1, 'partial', 'PARTIAL_INSTANCE_COVERAGE'),
      internalMemberships: metric(12, 'stale', 'STALE_IF_ERROR'),
      estimatedUniquePeople: metric(7, 'partial', 'ESTIMATED_FROM_NORMALIZED_EMAIL'),
      embedUsers: metric(4, 'available'),
      embedEntities: metric(2, 'available'),
      active7d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
      active30d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
      active90d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
      dashboards: metric(5, 'partial', 'PARTIAL_INSTANCE_COVERAGE'),
      models: metric(3, 'available'),
      topics: metric(2, 'available'),
      aiChats: metric(null, 'not_configured', 'AI_CONVERSATIONS_ORG_KEY_CONFIRMATION_REQUIRED'),
      apps: metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED'),
    },
    partial: true,
    stale: true,
  });

  assert.equal(parsed.metrics.estimatedUniquePeople.value, 7);
  assert.equal(parsed.metrics.estimatedUniquePeople.state, 'partial');
  assert.equal(parsed.metrics.estimatedUniquePeople.asOf, '2026-08-06T15:00:00.000Z');
  assert.equal(parsed.metrics.internalMemberships.state, 'stale');
  assert.equal(parsed.metrics.active30d.value, null);
  assert.equal(parsed.metrics.active30d.state, 'unavailable');
  assert.equal(parsed.metrics.aiChats.state, 'not_configured');
  assert.equal(parsed.metrics.apps.state, 'not_configured');
  assert.equal(parsed.partial, true);
  assert.equal(parsed.stale, true);
});
