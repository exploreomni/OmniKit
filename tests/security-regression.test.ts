import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

import {
  decryptVaultBlob,
  getVaultIdleTimeoutMs,
  listDeckRecipes,
  listInstances,
  lockVault,
  markInstanceValidated,
  purgeRetiredBiMigrationCredentials,
  resetUnlockThrottleForTests,
  resetVault,
  touchVaultSession,
  unlockVault,
  upsertDeckRecipe,
  upsertInstance,
  vaultStatus,
} from '../server/services/nativeVault';
import { importLegacyVault } from '../server/services/legacyVaultImport';
import {
  clearJobs,
  createModelMigrationJob,
  mergeModelMigrationJob,
  redactSensitiveText,
  runMigrationJob,
  runPostMigrationAction,
  sanitizeJobHistory,
  type MigrationJob,
} from '../server/services/migrationJobs';
import {
  closeJobStoreForTests,
  getJob,
  getJobsDbPath,
  insertJob,
} from '../server/services/jobStore';
import migrationJobsHandler from '../server/handlers/migration-jobs';
import modelMigratorHandler from '../server/handlers/model-migrator';
import instancesHandler from '../server/handlers/instances';
import omniProxyHandler from '../server/handlers/omni-proxy';
import instanceDashboardHandler from '../server/handlers/instance-dashboard';
import {
  publishMigrationJobEvent,
  subscribeMigrationJobEvents,
  type MigrationJobEvent,
} from '../server/services/jobEvents';
import {
  apiMiddleware,
  apiRouteFromUrl,
  apiWebRequestUrl,
  hydrateVaultCredentialReferences,
  localApiRequestOriginError,
} from '../server/apiMiddleware';
import {
  validateBaseUrl,
  validateOutboundUrl,
} from '../server/security';
import {
  dashboardMigrationDraftContainsForbiddenKeys,
  sanitizeDashboardMigrationDraftForStorage,
} from '../src/components/dashboardMigration/dashboardMigrationStorage';
import {
  getConnectionCacheKey,
  hasActiveSavedVaultConnection,
  hasSavedVaultConnection,
} from '../src/services/connectionGuards';
import {
  modelMigratorDraftContainsForbiddenKeys,
  sanitizeModelMigratorDraftForStorage,
} from '../src/services/modelMigratorDraft';
import { buildRecipe } from '../src/services/deckBuilder/deckRecipe';
import {
  RECIPE_STORAGE_KEY,
  recipeRecordContainsForbiddenKeys,
  saveRecipe,
} from '../src/services/deckBuilder/recipeStore';
import { DEFAULT_BRAND } from '../src/services/deckBuilder/types';
import { OmniClient } from '../server/services/omniClient';
import { sanitizeHistoryExportPayload } from '../src/services/historyExport';
import { csvEscapeCell, csvRowsToText } from '../src/utils/csvExport';
import { handleManageAi } from '../server/handlers/manage-ai';
import adminReadinessHandler from '../server/handlers/admin-readiness';
import {
  clearAdminReadinessCacheForTests,
  getAdminReadinessReport,
} from '../server/services/adminReadiness';

let tempDir = '';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function emptyMetricFilter() {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

test('api middleware preserves query params for handler requests while stripping them for route matching', () => {
  const rawUrl = '/api/instances/source-1/documents?folderPath=just-for-fun&connectionId=nfl-connection&includeModelDetails=true';
  const route = apiRouteFromUrl(rawUrl);
  const webUrl = new URL(apiWebRequestUrl(rawUrl, '127.0.0.1:5175'));

  assert.equal(route, 'instances/source-1/documents');
  assert.equal(webUrl.pathname, '/api/instances/source-1/documents');
  assert.equal(webUrl.searchParams.get('folderPath'), 'just-for-fun');
  assert.equal(webUrl.searchParams.get('connectionId'), 'nfl-connection');
  assert.equal(webUrl.searchParams.get('includeModelDetails'), 'true');
});

test('local API rejects cross-site browser origins while preserving local and non-browser clients', () => {
  assert.match(localApiRequestOriginError({
    origin: 'https://attacker.example',
    'sec-fetch-site': 'cross-site',
  }) || '', /Cross-site/);
  assert.match(localApiRequestOriginError({
    origin: 'https://attacker.example',
    'sec-fetch-site': 'same-site',
  }) || '', /not permitted/);
  assert.equal(localApiRequestOriginError({
    origin: 'http://127.0.0.1:5176',
    'sec-fetch-site': 'same-origin',
  }), null);
  assert.equal(localApiRequestOriginError({
    origin: 'http://localhost:5176',
  }), null);
  assert.equal(localApiRequestOriginError({}), null);
});

test('AI proxy rejects secret-shaped prompts before any outbound request', async () => {
  let outboundCalls = 0;
  const invokeManageAi = (request: Request) => handleManageAi(request, {
    validateOutbound: async () => undefined,
    request: async () => {
      outboundCalls += 1;
      return { status: 200, data: { id: 'job-a' } };
    },
  });

  const response = await invokeManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'vault-hydrated-server-side',
      action: 'create-job',
      model_id: 'model-a',
      prompt: 'Review this YAML:\nprivate_key: |\n  -----BEGIN PRIVATE KEY-----\n  secret-body\n  -----END PRIVATE KEY-----',
    }),
  }));
  const payload = await response.json() as { error?: string };

  assert.equal(response.status, 400);
  assert.match(payload.error || '', /secret-shaped content/);
  assert.equal(outboundCalls, 0);

  const safeResponse = await invokeManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'vault-hydrated-server-side',
      action: 'create-job',
      model_id: 'model-a',
      prompt: 'Review this already-sanitized evidence: api_key: [redacted]',
    }),
  }));
  assert.equal(safeResponse.status, 200);
  assert.equal(outboundCalls, 1);

  const safeBlockResponse = await invokeManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'vault-hydrated-server-side',
      action: 'create-job',
      model_id: 'model-a',
      prompt: 'Review sanitized YAML:\napiToken: |-\n  [redacted]\n',
    }),
  }));
  assert.equal(safeBlockResponse.status, 200);
  assert.equal(outboundCalls, 2);

  const googleApiKey = ['AIza', '1234567890abcdefghijklmnopqrst'].join('');
  const googleOauthToken = ['ya29', 'abcdefghijklmnopqrstuvwxyz123456'].join('.');
  const stripeLiveToken = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_');
  const omniLiveToken = ['omni', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
  const npmToken = ['npm', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');

  for (const secretPrompt of [
    'apiToken: |-\n  browser-secret-value-1234567890\n',
    'oauth_token: |\n  oauth-secret-value-1234567890\n',
    'secret_key: >\n  secret-value-that-must-not-leave-1234567890\n',
    `google_api_key: ${googleApiKey}\n`,
    `google_oauth: ${googleOauthToken}\n`,
    `stripe_key: ${stripeLiveToken}\n`,
    `api_key: "[redacted ${stripeLiveToken}]"\n`,
    `api_key: [redacted ${omniLiveToken}]\n`,
    `apiToken: |-\n  [redacted ${npmToken}]\n`,
  ]) {
    const secretResponse = await invokeManageAi(new Request('http://127.0.0.1/api/manage-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: 'https://example.omniapp.co',
        api_key: 'vault-hydrated-server-side',
        action: 'create-job',
        model_id: 'model-a',
        prompt: secretPrompt,
      }),
    }));
    assert.equal(secretResponse.status, 400);
  }
  assert.equal(outboundCalls, 2);

  const oversizedResponse = await invokeManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'vault-hydrated-server-side',
      action: 'create-job',
      model_id: 'model-a',
      prompt: 'a'.repeat(96_001),
    }),
  }));
  const oversizedPayload = await oversizedResponse.json() as { error?: string };
  assert.equal(oversizedResponse.status, 413);
  assert.match(oversizedPayload.error || '', /96,000 character server limit/);
  assert.equal(outboundCalls, 2);

  const oversizedBodyResponse = await invokeManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'vault-hydrated-server-side',
      action: 'get-job',
      job_id: 'job-a',
      padding: 'a'.repeat(110_001),
    }),
  }));
  assert.equal(oversizedBodyResponse.status, 413);
  assert.equal(outboundCalls, 2);
});

test('retired BI Migration Studio API returns a no-store tombstone without reading the request body', async () => {
  let bodyRead = false;
  const request = new Readable({
    read() {
      bodyRead = true;
      this.push(JSON.stringify({
        base_url: 'https://retired.example.omniapp.co',
        api_key: '__omnikit_vault_instance__:must-not-be-hydrated',
      }));
      this.push(null);
    },
  }) as IncomingMessage;
  request.method = 'POST';
  request.url = '/api/migration-studio/providers?legacy-client=true';
  request.headers = {
    host: '127.0.0.1:5175',
    origin: 'http://127.0.0.1:5175',
    'content-type': 'application/json',
  };

  const responseChunks: Buffer[] = [];
  const responseHeaders = new Map<string, string>();
  const response = new Writable({
    write(chunk, _encoding, callback) {
      responseChunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse;
  response.statusCode = 200;
  response.setHeader = ((name, value) => {
    responseHeaders.set(String(name).toLowerCase(), String(value));
    return response;
  }) as ServerResponse['setHeader'];

  const finished = once(response, 'finish');
  await apiMiddleware()(request, response);
  await finished;

  assert.equal(bodyRead, false, 'the retired route consumed or hydrated its request body');
  assert.equal(response.statusCode, 410);
  assert.equal(responseHeaders.get('cache-control'), 'no-store');
  assert.equal(responseHeaders.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(JSON.parse(Buffer.concat(responseChunks).toString('utf8')), {
    error: 'BI Migration Studio has been retired from OmniKit.',
    code: 'BI_MIGRATION_STUDIO_RETIRED',
  });
});

test('CSV export helpers neutralize spreadsheet formula cells', () => {
  assert.equal(csvEscapeCell('=IMPORTXML("https://evil.example")'), `"'=IMPORTXML(""https://evil.example"")"`);
  assert.equal(csvEscapeCell(' +SUM(1,1)'), `"' +SUM(1,1)"`);
  assert.equal(csvEscapeCell('-10'), `"'-10"`);
  assert.equal(csvEscapeCell('@cmd'), `"'@cmd"`);
  assert.equal(csvEscapeCell('safe, quoted'), '"safe, quoted"');
  assert.equal(
    csvRowsToText([['name', 'value'], ['Entity', '=1+1']]),
    `"name","value"\n"Entity","'=1+1"`,
  );
});

test('outbound URL validation blocks alternate private address forms and private DNS resolution', async () => {
  assert.match(validateBaseUrl('https://2130706433') || '', /local or private/);
  assert.match(validateBaseUrl('https://0177.0.0.1') || '', /local or private/);
  assert.match(validateBaseUrl('https://[::ffff:127.0.0.1]') || '', /local or private/);

  const dnsError = await validateOutboundUrl('https://omni-private.example.com/api/v1/folders', {
    label: 'test URL',
    resolveHost: async () => [{ address: '10.1.2.3' }],
  });
  assert.match(dnsError || '', /resolves to a local or private network address/);
});

function makeStoredJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  const createdAt = Date.now();
  return {
    id: 'job-test',
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination',
      targetModelId: 'model-1',
    }],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'running',
    createdAt,
    startedAt: createdAt,
    items: [{
      id: 'item-1',
      jobId: overrides.id || 'job-test',
      targetId: 'target-1',
      destinationId: 'dest-1',
      destinationLabel: 'Destination',
      targetModelId: 'model-1',
      kind: 'import',
      documentId: 'doc-1',
      documentName: 'Dashboard',
      status: 'pending',
    }],
    ...overrides,
  };
}

function writeLegacyVault(filePath: string, passphrase: string, payload: unknown): void {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase.normalize('NFKC'), salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 128 * (1 << 15) * 8 * 2,
  });
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileSync(filePath, Buffer.concat([salt, iv, tag, ciphertext]), { mode: 0o600 });
  } finally {
    key.fill(0);
  }
}

function readNativeVaultPayload(filePath: string, passphrase: string): Record<string, unknown> {
  const parsed = JSON.parse(decryptVaultBlob(passphrase, readFileSync(filePath))) as unknown;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function waitForJob(id: string, timeoutMs = 1000): Promise<MigrationJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (job && ['succeeded', 'partial', 'failed', 'canceled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const job = getJob(id);
  if (!job) throw new Error(`Job ${id} was not stored.`);
  return job;
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-security-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_JOBS_PATH = path.join(tempDir, 'jobs.json');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(tempDir, 'omnikit-jobs.json');
  process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = String(30 * 60 * 1000);
  closeJobStoreForTests();
  clearAdminReadinessCacheForTests();
  resetVault();
  delete process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS;
  delete process.env.OMNIKIT_POST_ACTION_ALLOWLIST;
  delete process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL;
});

afterEach(() => {
  clearAdminReadinessCacheForTests();
  resetVault();
  closeJobStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
  delete process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS;
  delete process.env.OMNIKIT_POST_ACTION_ALLOWLIST;
  delete process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL;
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
});

test('native vault stores encrypted secrets, masks API keys, and uses 0600 permissions', () => {
  const apiKey = 'omni_live_secret_key_1234567890';
  unlockVault('correct horse battery staple');
  const saved = upsertInstance({
    label: 'Security Test',
    role: 'both',
    baseUrl: 'https://example.omniapp.co',
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  assert.equal(saved.apiKeyMasked, 'omni••••7890');
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  assert.equal(JSON.stringify(listInstances()).includes(apiKey), false);

  const vaultPath = process.env.OMNIKIT_VAULT_PATH || '';
  const mode = statSync(vaultPath).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(readFileSync(vaultPath, 'utf8').includes(apiKey), false);
});

test('saved instance credential boundaries invalidate readiness and require a replacement key for repointing', () => {
  unlockVault('correct horse battery staple');
  const saved = upsertInstance({
    label: 'Credential Boundary',
    role: 'both',
    baseUrl: 'https://first.example.omniapp.co',
    apiKey: 'first_private_api_key_1234567890',
    organizationApiKeyConfirmed: true,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const validated = markInstanceValidated(saved.id);
  assert.ok(validated.lastValidatedAt);
  assert.equal(validated.organizationApiKeyConfirmed, true);

  assert.throws(() => upsertInstance({
    id: saved.id,
    baseUrl: 'https://second.example.omniapp.co',
    organizationApiKeyConfirmed: true,
  }), /requires a replacement API key/);

  const repointed = upsertInstance({
    id: saved.id,
    baseUrl: 'https://second.example.omniapp.co',
    apiKey: 'fixture-key-for-repointing',
    organizationApiKeyConfirmed: true,
  });
  assert.equal(repointed.lastValidatedAt, undefined);
  assert.equal(repointed.organizationApiKeyConfirmed, false);

  const revalidated = markInstanceValidated(saved.id);
  assert.ok(revalidated.lastValidatedAt);
  const rotated = upsertInstance({
    id: saved.id,
    baseUrl: 'https://second.example.omniapp.co',
    apiKey: 'fixture-key-for-rotation',
    organizationApiKeyConfirmed: true,
  });
  assert.equal(rotated.lastValidatedAt, undefined);
  assert.equal(rotated.organizationApiKeyConfirmed, false);
  assert.equal(JSON.stringify(rotated).includes('fixture-key-for-rotation'), false);
});

test('vault-backed browser connections hydrate server-side without exposing plaintext keys in session payloads', () => {
  const apiKey = 'omni_live_secret_key_abcdef123456';
  unlockVault('correct horse battery staple');
  const saved = upsertInstance({
    label: 'Hydration Test',
    role: 'both',
    baseUrl: 'https://hydration.example.omniapp.co',
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const browserPayload = {
    source: {
      base_url: 'https://placeholder.example',
      api_key: `__omnikit_vault_instance__:${saved.id}`,
    },
    api_key: 'manual_key_should_stay_manual',
  };

  const hydrated = hydrateVaultCredentialReferences(browserPayload) as {
    source: { base_url: string; api_key: string };
    api_key: string;
  };

  assert.equal(JSON.stringify(browserPayload).includes(apiKey), false);
  assert.equal(hydrated.source.base_url, 'https://hydration.example.omniapp.co');
  assert.equal(hydrated.source.api_key, apiKey);
  assert.equal(hydrated.api_key, 'manual_key_should_stay_manual');
});

test('workflow connection guard rejects manual, plaintext, and mismatched vault-reference sessions', () => {
  assert.equal(hasSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'omni_live_plaintext_key_123',
    connectionMode: 'manual',
    instanceId: undefined,
  }), false);

  assert.equal(hasSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'omni_live_plaintext_key_123',
    connectionMode: 'vault',
    instanceId: 'inst-1',
  }), false);

  assert.equal(hasSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-1',
    connectionMode: 'vault',
    instanceId: 'inst-1',
  }), true);

  assert.equal(hasSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-2',
    connectionMode: 'vault',
    instanceId: 'inst-1',
  }), false);

  assert.equal(hasActiveSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-1',
    connectionMode: 'vault',
    instanceId: 'inst-1',
    status: 'untested',
  }), false);

  assert.equal(hasActiveSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-1',
    connectionMode: 'vault',
    instanceId: 'inst-1',
    status: 'success',
  }), true);

  assert.equal(hasActiveSavedVaultConnection({
    baseUrl: 'https://example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-2',
    connectionMode: 'vault',
    instanceId: 'inst-1',
    status: 'success',
  }), false);
});

test('connection cache key isolates saved instances that share one base URL', () => {
  const first = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-1',
    instanceId: 'inst-1',
  });
  const second = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-2',
    instanceId: 'inst-2',
  });
  const manualFallback = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co',
    apiKey: '',
  });
  const manualKeyA = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co',
    apiKey: 'manual-secret-a',
  });
  const manualKeyANormalized = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co/',
    apiKey: 'manual-secret-a',
  });
  const manualKeyB = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co',
    apiKey: 'manual-secret-b',
  });
  const repointed = getConnectionCacheKey({
    baseUrl: 'https://different.example.omniapp.co',
    apiKey: '__omnikit_vault_instance__:inst-1',
    instanceId: 'inst-1',
  });
  const normalizedTrailingSlash = getConnectionCacheKey({
    baseUrl: 'https://shared.example.omniapp.co/',
    apiKey: '__omnikit_vault_instance__:inst-1',
    instanceId: 'inst-1',
  });

  assert.notEqual(first, second);
  assert.notEqual(first, repointed);
  assert.equal(first, normalizedTrailingSlash);
  assert.equal(first, '["inst-1","https://shared.example.omniapp.co","saved-instance"]');
  assert.equal(second, '["inst-2","https://shared.example.omniapp.co","saved-instance"]');
  assert.equal(manualFallback, '["manual","https://shared.example.omniapp.co","no-key"]');
  assert.equal(manualKeyA, manualKeyANormalized);
  assert.notEqual(manualKeyA, manualKeyB);
  assert.doesNotMatch(manualKeyA, /manual-secret-a|manual-secret-b/);
  assert.doesNotMatch(manualKeyB, /manual-secret-a|manual-secret-b/);
});

test('native vault enforces idle auto-lock on the next status check', async () => {
  process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = '5';
  unlockVault('short lived');
  assert.equal(vaultStatus().unlocked, true);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(vaultStatus().unlocked, false);
});

test('explicit vault touch extends an unlocked native-vault session', async () => {
  process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = '40';
  unlockVault('touch me');
  const before = vaultStatus().lastActivityAt || 0;

  await new Promise((resolve) => setTimeout(resolve, 20));
  const touched = touchVaultSession();
  assert.equal(touched.unlocked, true);
  assert.ok((touched.lastActivityAt || 0) > before);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(vaultStatus().unlocked, true);
});

test('deprecated browser-vault module is not shipped', () => {
  const browserVaultPath = path.resolve(process.cwd(), 'src/services/instanceVault.ts');
  assert.equal(existsSync(browserVaultPath), false);
});

test('legacy vault import requires the native vault to be unlocked before reading legacy data', () => {
  const legacyPath = path.join(tempDir, 'legacy-vault.enc');
  writeLegacyVault(legacyPath, 'legacy-passphrase', { version: 1, instances: [] });

  assert.throws(
    () => importLegacyVault({
      path: legacyPath,
      passphrase: 'legacy-passphrase',
      confirmAbsolutePath: true,
      dryRun: true,
    }),
    /vault locked/,
  );
});

test('legacy vault import maps fields, drops unsafe actions, and is idempotent', () => {
  const legacyPath = path.join(tempDir, 'legacy-vault.enc');
  const existingApiKey = 'omni_live_existing_secret_1234';
  const importedApiKey = 'omni_live_imported_secret_5678';
  unlockVault('native passphrase');
  upsertInstance({
    label: 'Existing',
    role: 'both',
    baseUrl: 'https://existing.example.omniapp.co',
    apiKey: existingApiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  writeLegacyVault(legacyPath, 'legacy-passphrase', {
    version: 1,
    instances: [
      {
        id: 'legacy-new',
        label: 'Legacy New',
        role: 'source',
        baseUrl: 'https://new.example.omniapp.co',
        apiKey: importedApiKey,
        userId: 'legacy-user',
        modelId: 'model-1',
        folderId: 'folder-1',
        folderPath: 'Shared/Migrated',
        dashboardEnabled: true,
        dashboardFilter: {
          databaseContains: ['internal'],
          databaseExact: ['test_db'],
          externalIdContains: ['@example.com'],
          externalIdExact: ['test-user'],
        },
        entityGroupSeparator: ' - ',
        postMigrationActions: [
          { name: 'Safe hook', method: 'POST', url: 'https://hooks.example.com/refresh', headers: { 'X-Test': 'yes' }, body: '{"ok":true}' },
          { name: 'Unsafe hook', method: 'POST', url: 'http://localhost:3000/refresh' },
        ],
      },
      {
        label: 'Legacy Duplicate',
        role: 'destination',
        baseUrl: 'https://existing.example.omniapp.co',
        apiKey: 'omni_live_duplicate_secret',
      },
      {
        label: 'Legacy Invalid',
        role: 'destination',
        baseUrl: 'http://insecure.example.com',
        apiKey: 'omni_live_invalid_secret',
      },
    ],
  });

  const dryRun = importLegacyVault({
    path: legacyPath,
    passphrase: 'legacy-passphrase',
    confirmAbsolutePath: true,
    dryRun: true,
  });
  assert.equal(dryRun.imported, 0);
  assert.equal(dryRun.wouldImport, 1);
  assert.equal(dryRun.skipped.length, 2);
  assert.equal(JSON.stringify(dryRun).includes(importedApiKey), false);

  const imported = importLegacyVault({
    path: legacyPath,
    passphrase: 'legacy-passphrase',
    confirmAbsolutePath: true,
    dryRun: false,
  });
  assert.equal(imported.imported, 1);
  assert.match(imported.warnings.join('\n'), /Unsafe hook/);
  assert.equal(JSON.stringify(imported).includes(importedApiKey), false);

  const saved = listInstances().find((instance) => instance.label === 'Legacy New');
  assert.ok(saved);
  assert.equal(saved.role, 'source');
  assert.equal(saved.defaultModelId, 'model-1');
  assert.equal(saved.defaultFolderPath, 'Shared/Migrated');
  assert.deepEqual(saved.metricFilter.connectionDatabaseContains, ['internal']);
  assert.deepEqual(saved.metricFilter.embedExternalIdExact, ['test-user']);
  assert.equal(saved.postMigrationActions.length, 1);

  const secondRun = importLegacyVault({
    path: legacyPath,
    passphrase: 'legacy-passphrase',
    confirmAbsolutePath: true,
    dryRun: false,
  });
  assert.equal(secondRun.imported, 0);
  assert.equal(secondRun.wouldImport, 0);
  assert.equal(secondRun.skipped.length, 3);
});

test('legacy vault import reports wrong passphrases as a safe validation error', () => {
  const legacyPath = path.join(tempDir, 'legacy-wrong-passphrase.enc');
  unlockVault('native passphrase');
  writeLegacyVault(legacyPath, 'legacy-passphrase', { version: 1, instances: [] });

  assert.throws(
    () => importLegacyVault({
      path: legacyPath,
      passphrase: 'incorrect passphrase',
      confirmAbsolutePath: true,
      dryRun: true,
    }),
    /Could not decrypt or parse the legacy vault/,
  );
});

test('legacy vault import rejects unsafe paths before file reads', () => {
  unlockVault('native passphrase');
  assert.throws(
    () => importLegacyVault({
      path: '../vault.enc',
      passphrase: 'legacy-passphrase',
      dryRun: true,
    }),
    /inside the OmniKit workspace/,
  );
  assert.throws(
    () => importLegacyVault({
      path: path.join(tempDir, 'legacy-vault.enc'),
      passphrase: 'legacy-passphrase',
      dryRun: true,
      confirmAbsolutePath: false,
    }),
    /Confirm absolute-path import/,
  );
});

test('dashboard migration draft stores only non-secret IDs and paths', () => {
  const sanitized = sanitizeDashboardMigrationDraftForStorage({
    step: 1,
    sourceId: 'source-instance',
    sourceConnectionId: 'source-connection',
    sourceFolderId: 'source-folder-1',
    sourceFolderPath: 'Executive Dashboards',
    selectedDocumentIds: ['doc-1', 'doc-1', 'doc-2'],
    replaceSameNamed: true,
    emptyFirst: false,
    refreshSchemaOnComplete: true,
    deleteSourceOnSuccess: true,
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'destination-instance',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-2',
      targetModelName: 'Target Model',
      targetFolderPath: 'Executive Dashboards/Migrated',
      targetFolderId: 'folder-1',
      apiKey: 'omni_live_secret',
      baseUrl: 'https://secret.example.omniapp.co',
      queryViewMappings: [{
        sourceQueryViewName: 'orders_metric',
        sourceFileName: 'orders_metric.query.view',
        action: 'copy_source',
        targetQueryViewName: 'orders_metric_copy',
        warnings: [''],
      }],
      fieldMappings: [{
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'map_existing',
        targetFieldRef: 'orders.total_sales',
        warnings: [''],
      }],
      semanticPatches: [{
        id: 'field:orders.semantic_total_sales:orders.view',
        artifactType: 'field',
        sourceName: 'orders.semantic_total_sales',
        targetFileName: 'orders.view',
        currentYaml: 'dimensions:\n  api_key: omni_live_secret\n',
        sourceYaml: '  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        recommendedYaml: 'dimensions:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
	        acceptedYaml: 'dimensions:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
	        resolution: 'custom_edit',
	        status: 'ready',
	        safetyCategory: 'safe_update',
	        recommendedAction: 'Create semantic_total_sales from source model YAML.',
	        dependencyPath: [
	          { kind: 'model_field', label: 'orders.semantic_total_sales', ref: 'orders.semantic_total_sales' },
	          { kind: 'model_file', label: 'orders.view', ref: 'orders.view' },
	        ],
	      }],
    } as never],
    routeGroups: [{
      id: 'route-1',
      name: 'Route 1',
      documentIds: ['doc-1'],
      targetRowIds: ['target-1'],
      queryViewMappingsByTargetId: {
        'target-1': [{
          sourceQueryViewName: 'orders_metric',
          action: 'copy_source',
          targetQueryViewName: 'orders_metric_copy',
          warnings: [''],
        }],
      },
      fieldMappingsByTargetId: {
        'target-1': [{
          sourceFieldRef: 'orders.semantic_total_sales',
          action: 'map_existing',
          targetFieldRef: 'orders.total_sales',
          warnings: [''],
        }],
      },
      semanticPatchesByTargetId: {
        'target-1': [{
          id: 'topic:orders:orders.topic',
          artifactType: 'topic',
          sourceName: 'orders',
          targetFileName: 'orders.topic',
	          sourceYaml: 'views:\n  secret: omni_live_secret\n',
	          acceptedYaml: 'views:\n  orders: {}\n',
	          resolution: 'recommended',
	          safetyCategory: 'destructive_update',
	          recommendedAction: 'Update existing target topic from source topic YAML.',
	          dependencyPath: [
	            { kind: 'topic', label: 'orders', ref: 'orders.topic' },
	            { kind: 'model_file', label: 'orders.topic', ref: 'orders.topic' },
	          ],
	        }],
	      },
    }],
    passphrase: 'do not store me',
  } as never);

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('omni_live_secret'), false);
  assert.equal(serialized.includes('secret.example'), false);
  assert.equal(serialized.includes('do not store me'), false);
  assert.deepEqual(sanitized.selectedDocumentIds, ['doc-1', 'doc-2']);
  assert.equal(sanitized.replaceSameNamed, true);
  assert.equal(sanitized.emptyFirst, false);
  assert.equal(sanitized.refreshSchemaOnComplete, true);
  assert.equal(sanitized.deleteSourceOnSuccess, true);
  assert.equal(sanitized.sourceFolderPath, 'Executive Dashboards');
  assert.equal(sanitized.targets[0].queryViewMappings?.[0].targetQueryViewName, 'orders_metric_copy');
  assert.deepEqual(sanitized.targets[0].queryViewMappings?.[0].warnings, []);
  assert.equal(sanitized.targets[0].fieldMappings?.[0].targetFieldRef, 'orders.total_sales');
  assert.deepEqual(sanitized.targets[0].fieldMappings?.[0].warnings, []);
	  assert.equal(sanitized.targets[0].semanticPatches?.[0].targetFileName, 'orders.view');
	  assert.equal(sanitized.targets[0].semanticPatches?.[0].safetyCategory, 'safe_update');
	  assert.equal(sanitized.targets[0].semanticPatches?.[0].status, 'blocked');
	  assert.equal(sanitized.targets[0].semanticPatches?.[0].warnings?.some((warning) => /Custom YAML is not stored/i.test(warning)), true);
	  assert.equal(sanitized.targets[0].semanticPatches?.[0].dependencyPath?.[0].label, 'orders.semantic_total_sales');
	  assert.equal('acceptedYaml' in (sanitized.targets[0].semanticPatches?.[0] || {}), false);
  assert.equal(sanitized.routeGroups?.[0].queryViewMappingsByTargetId?.['target-1']?.[0].targetQueryViewName, 'orders_metric_copy');
  assert.equal(sanitized.routeGroups?.[0].fieldMappingsByTargetId?.['target-1']?.[0].targetFieldRef, 'orders.total_sales');
	  assert.equal(sanitized.routeGroups?.[0].semanticPatchesByTargetId?.['target-1']?.[0].targetFileName, 'orders.topic');
	  assert.equal(sanitized.routeGroups?.[0].semanticPatchesByTargetId?.['target-1']?.[0].safetyCategory, 'destructive_update');
  assert.equal(serialized.includes('${orders.total_sales}'), false);
  assert.equal(dashboardMigrationDraftContainsForbiddenKeys(sanitized), false);
  assert.equal(dashboardMigrationDraftContainsForbiddenKeys({ ...sanitized, apiKey: 'secret' }), true);
});

test('model migrator review draft stores translation state without plaintext secrets', () => {
  const draft = sanitizeModelMigratorDraftForStorage({
    selectedPostActionIndexes: [0, 2, 99],
    schemaMapText: 'ANALYTICS.PUBLIC -> main.analytics',
    translationsByModelId: {
      'model-1': {
        files: [{
          fileName: 'orders.view',
          original: 'api_key: omni_live_source_secret_123456\nsql: SELECT 1',
          deterministic: 'api_key: omni_live_source_secret_123456\nsql: SELECT 1',
          translated: 'sql: SELECT 1',
          aiDraft: 'authorization: Bearer abc123\nsql: SELECT 1',
          aiJobId: 'ai-job-1',
          aiRefusal: 'token: abc123 failed',
          changed: true,
          promptVersion: 'v1',
          reviewRequired: true,
          warnings: ['Bearer abc123 failed for admin@example.com'],
        }],
        checksums: { 'orders.view': 'sha256:abc' },
        prompts: [{ fileName: 'orders.view', prompt: 'Do not use token: abc123' }],
      },
    },
    acceptedFilesByModelId: {
      'model-1': {
        'orders.view': 'password: hunter2\nsql: SELECT 1',
      },
    },
  });

  assert.equal(modelMigratorDraftContainsForbiddenKeys(draft), false);
  assert.deepEqual(draft.selectedPostActionIndexes, []);
  const raw = JSON.stringify(draft);
  assert.equal(raw.includes('omni_live_source_secret_123456'), false);
  assert.equal(raw.includes('Bearer abc123'), false);
  assert.equal(raw.includes('hunter2'), false);
  assert.match(raw, /\[redacted\]/);
});

test('deck recipe storage removes secret-shaped keys before persisting locally', () => {
  const localStorage = new MemoryStorage();
  (globalThis as typeof globalThis & { window: { localStorage: MemoryStorage } }).window = { localStorage };
  const recipe = {
    ...buildRecipe({
      dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
      dashboardId: 'dash-1',
      dashboardName: 'Security Dashboard',
      selectedTileIds: ['tile-1'],
      insights: {},
      brand: DEFAULT_BRAND,
      includeAppendix: true,
      generatedFrom: 'https://example.omniapp.co',
    }),
    apiKey: 'omni_live_recipe_secret_123456',
    token: 'session-token',
    brand: {
      ...DEFAULT_BRAND,
      secret: 'brand-secret',
    },
  };

  saveRecipe({
    name: 'Security recipe',
    savedForHost: 'Example Omni (example.omniapp.co)',
    recipe,
  });

  const stored = localStorage.getItem(RECIPE_STORAGE_KEY);
  assert.ok(stored);
  assert.equal(stored.includes('omni_live_recipe_secret_123456'), false);
  assert.equal(stored.includes('session-token'), false);
  assert.equal(stored.includes('brand-secret'), false);
  assert.equal(recipeRecordContainsForbiddenKeys(JSON.parse(stored)), false);
});

test('job history sanitizer removes secrets and common sensitive data', () => {
  const job: MigrationJob = {
    id: 'job-1',
    sourceId: 'source-1',
    sourceLabel: 'source-admin@example.com',
    destinationIds: ['dest-1'],
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'dest-admin@example.com',
      targetModelId: 'model-1',
      targetModelName: 'Finance model for customer@example.com',
      targetFolderPath: 'Customers/212-555-0199',
      queryViewMappings: [{
        sourceQueryViewName: 'customer@example.com_metric',
        sourceFileName: 'customer@example.com_metric.query.view',
        action: 'copy_source',
        targetQueryViewName: 'phone_212-555-0199_metric',
        targetFileName: 'phone_212-555-0199_metric.query.view',
        targetQueryViewLabel: '4111 1111 1111 1111',
      }],
      semanticPatches: [{
        id: 'field:orders.revenue:orders.view',
        artifactType: 'field',
        sourceName: 'orders.revenue',
        targetFileName: 'orders.view',
        currentYaml: 'dimensions:\n  revenue:\n    sql: ${TABLE}.private_revenue\n',
        acceptedYaml: 'measures:\n  revenue:\n    sql: ${orders.private_revenue}\n',
        resolution: 'custom_edit',
      }],
      queryValidationWaivers: [{
        documentId: 'doc-1',
        queryId: 'tile-1',
        reason: 'Approved while token=secret-waiver-token-value is rotated.',
      }],
    }],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [{
      name: 'Notify 4111 1111 1111 1111',
      method: 'POST',
      url: 'https://hooks.example.com/path?token=supersecret',
      headers: { Authorization: 'Bearer secret-token-value' },
      body: '{"email":"customer@example.com","phone":"212-555-0199"}',
    }],
    status: 'failed',
    createdAt: Date.now(),
    items: [
      {
        id: 'item-1',
        jobId: 'job-1',
        destinationId: 'dest-1',
        destinationLabel: 'dest-admin@example.com',
        targetModelId: 'model-1',
        targetModelName: 'Finance model for customer@example.com',
        targetFolderPath: 'Customers/212-555-0199',
        kind: 'import',
        documentName: 'Finance 4111-1111-1111-1111',
        status: 'failed',
        error: 'Bearer secret-token-value for customer@example.com at 212-555-0199',
        warnings: ['api_key:abc123'],
        details: {
          relationshipEdges: [{
            joinFromView: 'customer@example.com_orders',
            joinToView: 'phone_212-555-0199_metrics',
            relationshipType: 'many_to_one',
            yaml: 'on_sql: ${customer@example.com_orders.id} = ${phone_212-555-0199_metrics.id}',
            on_sql: 'select * from private_customer_table',
          }],
        },
      },
      {
        id: 'item-update',
        jobId: 'job-1',
        destinationId: 'dest-1',
        destinationLabel: 'dest-admin@example.com',
        targetModelId: 'model-1',
        kind: 'update',
        documentName: 'Finance 4111-1111-1111-1111',
        status: 'warning',
        warnings: ['Published draft with token=secret-token-value'],
        details: {
          draftIdentifier: 'draft-customer@example.com-212-555-0199',
          summary: 'OmniKit migration for customer@example.com using Bearer secret-token-value',
          publishedAt: '2026-06-25T00:00:00.000Z',
          tileCount: 2,
          deletedTileCount: 1,
          updateInPlace: true,
        },
      },
    ],
  };

  const serialized = JSON.stringify(sanitizeJobHistory([job]));
  assert.equal(serialized.includes('secret-token-value'), false);
  assert.equal(serialized.includes('customer@example.com'), false);
  assert.equal(serialized.includes('212-555-0199'), false);
  assert.equal(serialized.includes('4111 1111 1111 1111'), false);
  assert.equal(serialized.includes('abc123'), false);
  assert.equal(serialized.includes('on_sql'), false);
  assert.equal(serialized.includes('private_customer_table'), false);
  assert.equal(serialized.includes('private_revenue'), false);
  assert.equal(serialized.includes('secret-waiver-token-value'), false);
  assert.equal(serialized.includes('draft-customer'), false);
  assert.equal(serialized.includes('relationshipType'), true);
  assert.equal(serialized.includes('updateInPlace'), true);
});

test('model migration job details are redacted before history persistence', () => {
  const job = makeStoredJob({
    workflow: 'model',
    details: {
      branchName: 'omnikit-model-migration',
      api_key: 'secret-token',
      contact: 'owner@example.com',
    },
    items: [{
      id: 'model-item',
      jobId: 'job-test',
      destinationId: 'dest-1',
      destinationLabel: 'Destination',
      targetModelId: 'model-1',
      kind: 'model_yaml_write',
      status: 'failed',
      details: {
        authorization: 'Bearer abc123',
        fileName: 'orders.view',
      },
    }],
  });

  const serialized = JSON.stringify(sanitizeJobHistory([job]));
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('owner@example.com'), false);
  assert.equal(serialized.includes('Bearer abc123'), false);
  assert.equal(serialized.includes('orders.view'), true);
});

test('local job history file is created with 0600 permissions', () => {
  clearJobs();
  const mode = statSync(getJobsDbPath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('local job history file does not store plaintext secrets or common sensitive data', () => {
  const secret = 'Bearer raw-secret-token-value';
  const email = 'customer@example.com';
  insertJob({
    id: 'job-store-redaction',
    sourceId: 'source-1',
    sourceLabel: email,
    destinationIds: ['dest-1'],
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      destinationLabel: email,
      targetModelId: 'model-1',
      targetModelName: `Finance ${email}`,
      targetFolderPath: 'Customers/212-555-0199',
      semanticPatches: [{
        id: 'field:orders.revenue:orders.view',
        artifactType: 'field',
        sourceName: 'orders.revenue',
        targetFileName: 'orders.view',
        acceptedYaml: 'measures:\n  revenue:\n    sql: ${orders.private_revenue}\n',
        resolution: 'custom_edit',
      }],
      queryValidationWaivers: [{
        documentId: 'doc-1',
        queryId: 'tile-1',
        reason: 'Approved while api_key=waiver-persistence-secret is rotated.',
      }],
    }],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [{
      name: 'Notify',
      method: 'POST',
      url: 'https://hooks.example.com/path?api_key=supersecret',
      headers: { Authorization: secret },
      body: `{"email":"${email}"}`,
    }],
    status: 'failed',
    createdAt: Date.now(),
    items: [{
      id: 'item-1',
      jobId: 'job-store-redaction',
      destinationId: 'dest-1',
      destinationLabel: email,
      kind: 'import',
      documentName: `Finance ${email}`,
      status: 'failed',
      error: `${secret} for ${email}`,
      warnings: ['password:abc123'],
    }],
  });

  const dbContents = existsSync(getJobsDbPath()) ? readFileSync(getJobsDbPath(), 'utf8') : '';
  assert.equal(dbContents.includes('raw-secret-token-value'), false);
  assert.equal(dbContents.includes(email), false);
  assert.equal(dbContents.includes('212-555-0199'), false);
  assert.equal(dbContents.includes('supersecret'), false);
  assert.equal(dbContents.includes('abc123'), false);
  assert.equal(dbContents.includes('private_revenue'), false);
  assert.equal(dbContents.includes('waiver-persistence-secret'), false);
});

test('model migration job reload preserves details and retry lineage', () => {
  const job = makeStoredJob({
    id: 'model-reload-lineage',
    workflow: 'model',
    parentJobId: 'parent-model-job',
    details: {
      modelCount: 1,
      workbookCount: 1,
      retryInput: {
        sourceId: 'source-1',
        targetId: 'target-1',
        models: [{
          sourceModelId: 'source-model',
          targetModelId: 'target-model',
          targetConnectionId: 'target-connection',
          mode: 'translate',
          branchName: 'reload-branch',
          acceptedFiles: [{ fileName: 'orders.view', yaml: 'dimensions: {}' }],
        }],
        content: [{ documentId: 'workbook-1', documentName: 'Workbook', kind: 'workbook', sourceModelId: 'source-model', targetModelId: 'target-model' }],
        postMigrationActions: [],
      },
    },
    items: [{
      id: 'workbook-create-reload',
      jobId: 'model-reload-lineage',
      destinationId: 'target-1',
      destinationLabel: 'Target',
      targetModelId: 'target-model',
      kind: 'workbook_create',
      documentId: 'workbook-1',
      documentName: 'Workbook',
      status: 'failed',
      details: {
        tabs: [{ name: 'Revenue', status: 'not_created', retryBoundary: 'document', carried: ['query', 'visConfig'] }],
      },
    }],
  });
  insertJob(job);
  closeJobStoreForTests();

  const reloaded = getJob(job.id);
  assert.equal(reloaded?.workflow, 'model');
  assert.equal(reloaded?.parentJobId, 'parent-model-job');
  assert.equal(reloaded?.details?.modelCount, 1);
  assert.deepEqual(reloaded?.items[0].details?.tabs, [
    { name: 'Revenue', status: 'not_created', retryBoundary: 'document', carried: ['query', 'visConfig'] },
  ]);
});

test('job store recovery fails interrupted pending jobs and items after restart', () => {
  const job = makeStoredJob({
    id: 'pending-recovery',
    status: 'pending',
    startedAt: undefined,
    items: [{
      id: 'pending-recovery-item',
      jobId: 'pending-recovery',
      targetId: 'target-1',
      destinationId: 'dest-1',
      destinationLabel: 'Destination',
      targetModelId: 'model-1',
      kind: 'import',
      documentId: 'doc-1',
      documentName: 'Dashboard',
      status: 'pending',
    }],
  });
  insertJob(job);
  closeJobStoreForTests();

  const reloaded = getJob(job.id);
  assert.equal(reloaded?.status, 'failed');
  assert.equal(reloaded?.items[0].status, 'failed');
  assert.match(reloaded?.items[0].error || '', /Interrupted by server restart/);
});

test('migration job cancel works while vault is locked but retry still requires unlock', async () => {
  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  const job = makeStoredJob({ id: 'cancel-while-locked' });
  insertJob(job);
  lockVault();

  const cancelResponse = await migrationJobsHandler(new Request(
    'http://127.0.0.1/api/migration-jobs/cancel-while-locked/cancel',
    { method: 'POST' },
  ));
  assert.equal(cancelResponse.status, 200);
  const cancelPayload = await cancelResponse.json() as { job: MigrationJob };
  assert.equal(cancelPayload.job.status, 'canceled');
  assert.equal(cancelPayload.job.items[0].status, 'skipped');

  const retryResponse = await migrationJobsHandler(new Request(
    'http://127.0.0.1/api/migration-jobs/cancel-while-locked/retry',
    { method: 'POST', body: '{}' },
  ));
  assert.equal(retryResponse.status, 423);
});

test('migration job handler redacts secret-shaped immediate errors', async () => {
  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  unlockVault('native passphrase');
  const response = await migrationJobsHandler(new Request('http://127.0.0.1/api/migration-jobs/preview', {
    method: 'POST',
    body: JSON.stringify({
      sourceId: 'omni_live_response_secret_123456',
      documentIds: ['doc-1'],
      targets: [{
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'connection-1',
        targetModelId: 'model-1',
      }],
    }),
  }));
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(body).includes('omni_live_response_secret_123456'), false);
  assert.match(body.error || '', /\[redacted\]/);
});

test('migration patch validation redacts Omni validation issue details', async () => {
  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  unlockVault('native passphrase');
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const originalListModels = OmniClient.prototype.listModels;
  const originalCreateModelBranch = OmniClient.prototype.createModelBranch;
  const originalUpdateModelYamlFiles = OmniClient.prototype.updateModelYamlFiles;
  const originalValidateModel = OmniClient.prototype.validateModel;
  const originalValidateModelContent = OmniClient.prototype.validateModelContent;
  const originalDeleteModelBranch = OmniClient.prototype.deleteModelBranch;
  try {
    OmniClient.prototype.listModels = async () => [{
      id: 'target-model',
      name: 'Target Model',
      connectionId: 'connection-1',
      gitConfigured: true,
    }];
    OmniClient.prototype.createModelBranch = async () => ({ id: 'branch-model-id', name: 'omnikit-validate-test', raw: {} });
    OmniClient.prototype.updateModelYamlFiles = async () => ({ ok: true });
    OmniClient.prototype.validateModel = async () => [{
      message: 'Validation failed with token omni_secret_live_123456 and admin@example.com',
      yaml_path: 'orders.view',
    }];
    OmniClient.prototype.validateModelContent = async () => ({ issues: [] });
    OmniClient.prototype.deleteModelBranch = async () => ({ ok: true });

    const response = await migrationJobsHandler(new Request('http://127.0.0.1/api/migration-jobs/validate-patches', {
      method: 'POST',
      body: JSON.stringify({
        sourceId: 'source-1',
        documentIds: ['doc-1'],
        targets: [{
          id: 'target-1',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-1',
          targetModelId: 'target-model',
          semanticPatches: [{
            id: 'field:orders.semantic_total_sales:orders.view',
            artifactType: 'field',
            sourceName: 'orders.semantic_total_sales',
            targetFileName: 'orders.view',
            acceptedYaml: 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
            resolution: 'custom_edit',
            status: 'ready',
          }],
        }],
        emptyFirst: false,
        replaceSameNamed: false,
        postMigrationActions: [],
      }),
    }));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(serialized.includes('omni_secret_live_123456'), false);
    assert.equal(serialized.includes('admin@example.com'), false);
    assert.match(serialized, /\[redacted\]/);
  } finally {
    OmniClient.prototype.listModels = originalListModels;
    OmniClient.prototype.createModelBranch = originalCreateModelBranch;
    OmniClient.prototype.updateModelYamlFiles = originalUpdateModelYamlFiles;
    OmniClient.prototype.validateModel = originalValidateModel;
    OmniClient.prototype.validateModelContent = originalValidateModelContent;
    OmniClient.prototype.deleteModelBranch = originalDeleteModelBranch;
  }
});

test('migration job SSE item events redact bare errors without item payloads', () => {
  let received: MigrationJobEvent | null = null;
  const unsubscribe = subscribeMigrationJobEvents('redaction-event-job', (event) => {
    received = event;
  });
  try {
    publishMigrationJobEvent({
      type: 'item',
      jobId: 'redaction-event-job',
      itemId: 'item-1',
      destinationId: 'dest-1',
      status: 'failed',
      error: 'Bearer abc123 failed for admin@corp.com',
      at: Date.now(),
    });
  } finally {
    unsubscribe();
  }

  assert.ok(received);
  assert.equal(received.type, 'item');
  assert.equal(received.error?.includes('abc123'), false);
  assert.equal(received.error?.includes('admin@corp.com'), false);
  assert.match(received.error || '', /\[redacted\]/);
  assert.match(received.error || '', /\[redacted-email\]/);
});

test('migration job SSE post-migration events redact nested result payloads', () => {
  let received: MigrationJobEvent | null = null;
  const unsubscribe = subscribeMigrationJobEvents('post-redaction-event-job', (event) => {
    received = event;
  });
  try {
    publishMigrationJobEvent({
      type: 'post-migration',
      jobId: 'post-redaction-event-job',
      results: {
        action: 'Notify admin@corp.com',
        error: 'Bearer abc123 failed for admin@corp.com with apiKey=omni_live_secret_123456',
        nested: { token: 'plain-token-value', phone: '212-555-0199' },
      },
      at: Date.now(),
    });
  } finally {
    unsubscribe();
  }

  assert.ok(received);
  assert.equal(received.type, 'post-migration');
  const serialized = JSON.stringify(received.results);
  assert.equal(serialized.includes('abc123'), false);
  assert.equal(serialized.includes('admin@corp.com'), false);
  assert.equal(serialized.includes('omni_live_secret_123456'), false);
  assert.equal(serialized.includes('plain-token-value'), false);
  assert.equal(serialized.includes('212-555-0199'), false);
});

test('post-migration actions block unsafe targets before network execution', async () => {
  const baseAction = {
    name: 'Unsafe',
    method: 'GET' as const,
    headers: {},
    body: '',
  };

  assert.match(
    (await runPostMigrationAction({ ...baseAction, url: 'http://example.com/hook' })).error || '',
    /HTTPS/,
  );
  assert.match(
    (await runPostMigrationAction({ ...baseAction, url: 'https://127.0.0.1/hook' })).error || '',
    /Private-network/,
  );

  process.env.OMNIKIT_POST_ACTION_ALLOWLIST = 'hooks.example.com';
  assert.match(
    (await runPostMigrationAction({ ...baseAction, url: 'https://evil.example/hook' })).error || '',
    /not allowlisted/,
  );
});

test('post-migration actions validate redirect targets before following them', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    assert.equal(init?.redirect, 'manual');
    return new Response('', {
      status: 302,
      headers: { location: 'https://127.0.0.1/internal-hook' },
    });
  }) as typeof fetch;

  try {
    const result = await runPostMigrationAction({
      name: 'Redirect',
      method: 'GET',
      url: 'https://93.184.216.34/hook',
      headers: {},
      body: '',
    });
    assert.equal(result.ok, false);
    assert.match(result.error || '', /Private-network/);
    assert.deepEqual(calls, ['https://93.184.216.34/hook']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('instance save rejects unsafe post-migration webhook targets before vault persistence', async () => {
  unlockVault('native passphrase');
  const createResponse = await instancesHandler(new Request('http://localhost/api/instances', {
    method: 'POST',
    body: JSON.stringify({
      label: 'Unsafe Hook',
      role: 'both',
      baseUrl: 'https://unsafe-hook.example.omniapp.co',
      apiKey: 'omni_live_unsafe_hook_secret_123456',
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [{
        name: 'Notify',
        method: 'POST',
        url: 'http://hooks.example.com/migration-complete',
        headers: {},
        body: '',
      }],
    }),
  }));
  assert.equal(createResponse.status, 400);
  const createBody = await createResponse.json() as { error?: string };
  assert.match(createBody.error || '', /HTTPS/);
  assert.equal(listInstances().some((instance) => instance.label === 'Unsafe Hook'), false);

  const saved = upsertInstance({
    id: 'safe-existing-instance',
    label: 'Safe Existing',
    role: 'both',
    baseUrl: 'https://safe-existing.example.omniapp.co',
    apiKey: 'omni_live_safe_existing_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const updateResponse = await instancesHandler(new Request(`http://localhost/api/instances/${saved.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      label: saved.label,
      role: saved.role,
      baseUrl: saved.baseUrl,
      metricFilter: saved.metricFilter,
      postMigrationActions: [{
        name: 'Private notify',
        method: 'POST',
        url: 'https://127.0.0.1/migration-complete',
        headers: {},
        body: '',
      }],
    }),
  }));
  assert.equal(updateResponse.status, 400);
  const updateBody = await updateResponse.json() as { error?: string };
  assert.match(updateBody.error || '', /Private-network/);
  assert.deepEqual(listInstances().find((instance) => instance.id === saved.id)?.postMigrationActions, []);
});

test('refresh-schema endpoint requires unlocked vault, saved instance ownership, and model id', async () => {
  const locked = await instanceDashboardHandler(new Request('http://localhost/api/instance-dashboard/missing/refresh-schema', {
    method: 'POST',
    body: JSON.stringify({ modelId: 'model-1' }),
  }));
  assert.equal(locked.status, 423);

  unlockVault('native passphrase');
  const missing = await instanceDashboardHandler(new Request('http://localhost/api/instance-dashboard/missing/refresh-schema', {
    method: 'POST',
    body: JSON.stringify({ modelId: 'model-1' }),
  }));
  assert.equal(missing.status, 404);

  const saved = upsertInstance({
    id: 'refresh-instance',
    label: 'Refresh Instance',
    role: 'both',
    baseUrl: 'https://refresh.example.omniapp.co',
    apiKey: 'omni_live_refresh_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const missingModel = await instanceDashboardHandler(new Request(`http://localhost/api/instance-dashboard/${saved.id}/refresh-schema`, {
    method: 'POST',
    body: JSON.stringify({}),
  }));
  assert.equal(missingModel.status, 400);

  const originalRefreshModel = OmniClient.prototype.refreshModel;
  const originalGetJobStatus = OmniClient.prototype.getJobStatus;
  const refreshedModels: string[] = [];
  const polledJobs: string[] = [];
  OmniClient.prototype.refreshModel = async (modelId: string) => {
    refreshedModels.push(modelId);
    return { jobId: 'refresh-job-1', status: 'RUNNING', raw: {} };
  };
  OmniClient.prototype.getJobStatus = async (jobId: string) => {
    polledJobs.push(jobId);
    return { jobId, status: 'COMPLETED', raw: {} };
  };
  try {
    const response = await instanceDashboardHandler(new Request(`http://localhost/api/instance-dashboard/${saved.id}/refresh-schema`, {
      method: 'POST',
      body: JSON.stringify({ modelId: 'model-1' }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok?: boolean;
      instanceId?: string;
      modelId?: string;
      jobId?: string;
      trackingJobId?: string;
      status?: string;
    };
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.instanceId, saved.id);
    assert.equal(body.modelId, 'model-1');
    assert.equal(body.jobId, 'refresh-job-1');
    assert.equal(body.status, 'COMPLETE');
    assert.match(body.trackingJobId || '', /^[0-9a-f-]{36}$/i);
    assert.deepEqual(refreshedModels, ['model-1']);
    assert.deepEqual(polledJobs, ['refresh-job-1']);
  } finally {
    OmniClient.prototype.refreshModel = originalRefreshModel;
    OmniClient.prototype.getJobStatus = originalGetJobStatus;
  }
});

test('history JSON export redacts operations, jobs, actions, and nested details', () => {
  const payload = sanitizeHistoryExportPayload({
    operations: [{
      id: 'op-1',
      type: 'model_governance',
      description: 'Sent migration summary for owner@example.com with Bearer history-secret-token at 212-555-0199',
      timestamp: Date.now(),
      itemCount: 1,
      successCount: 1,
      failureCount: 0,
      durationMs: 42,
      details: {
        modelId: 'model-1',
        modelName: 'Finance Model',
        operation: 'view_cleanup',
        apiKey: 'omni_live_operation_secret_123456',
        nested: {
          authorization: 'Bearer operation-secret-token',
          outcome: 'merged',
        },
      },
    }],
    migrationJobs: [makeStoredJob({
      id: 'history-export-job',
      sourceLabel: 'owner@example.com',
      postMigrationActions: [{
        name: 'Notify owner@example.com',
        method: 'POST',
        url: 'https://hooks.example.com/notify?api_key=omni_live_export_secret_123456',
        headers: { Authorization: 'Bearer export-secret-token' },
        body: '{"apiKey":"omni_live_export_secret_123456"}',
      }],
      details: {
        apiKey: 'omni_live_export_secret_123456',
        nested: {
          token: 'plain-export-token',
          note: 'Finance Dashboard remains useful',
        },
      },
      items: [{
        id: 'history-export-item',
        jobId: 'history-export-job',
        destinationId: 'dest-1',
        destinationLabel: 'owner@example.com',
        targetModelId: 'model-1',
        kind: 'import',
        documentName: 'Finance Dashboard',
        status: 'failed',
        error: 'Bearer export-secret-token failed for owner@example.com at 212-555-0199',
      }],
    })],
  });

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('owner@example.com'), false);
  assert.equal(serialized.includes('history-secret-token'), false);
  assert.equal(serialized.includes('export-secret-token'), false);
  assert.equal(serialized.includes('omni_live_export_secret_123456'), false);
  assert.equal(serialized.includes('plain-export-token'), false);
  assert.equal(serialized.includes('omni_live_operation_secret_123456'), false);
  assert.equal(serialized.includes('operation-secret-token'), false);
  assert.equal(serialized.includes('212-555-0199'), false);
  assert.equal(serialized.includes('Finance Dashboard'), true);
  assert.equal(serialized.includes('Finance Model'), true);
  assert.equal(serialized.includes('view_cleanup'), true);
});

test('redactSensitiveText keeps non-sensitive text useful', () => {
  assert.equal(
    redactSensitiveText('Folder placement mismatch for Finance Dashboard'),
    'Folder placement mismatch for Finance Dashboard',
  );
});

test('redactSensitiveText removes credentials embedded in URL userinfo', () => {
  const redacted = redactSensitiveText('Request failed at https://operator:super-secret@example.com/api');
  assert.equal(redacted.includes('operator'), false);
  assert.equal(redacted.includes('super-secret'), false);
  assert.equal(redacted, 'Request failed at https://[redacted]:[redacted]@example.com/api');
});

test('redactSensitiveText removes Looker token authorization credentials', () => {
  const redacted = redactSensitiveText('Authorization: token looker-short-lived-secret');
  assert.doesNotMatch(redacted, /looker-short-lived-secret/);
  assert.match(redacted, /Authorization:.*\[redacted\]/i);
});

test('model migrator handler requires unlocked vault and rejects incomplete starts without leaking secrets', async () => {
  const locked = await modelMigratorHandler(new Request('http://localhost/api/model-migrator/source/connections'));
  assert.equal(locked.status, 423);

  const apiKey = 'omni_live_model_migrator_secret_123456';
  unlockVault('native passphrase');
  const source = upsertInstance({
    label: 'Model Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const target = upsertInstance({
    label: 'Model Target',
    role: 'destination',
    baseUrl: 'https://target.example.omniapp.co',
    apiKey: 'omni_live_model_migrator_target_abcdef',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const missingModels = await modelMigratorHandler(new Request('http://localhost/api/model-migrator/jobs', {
    method: 'POST',
    body: JSON.stringify({ sourceId: source.id, targetId: target.id, models: [] }),
  }));
  const missingText = await missingModels.text();
  assert.equal(missingModels.status, 400);
  assert.equal(missingText.includes(apiKey), false);
  assert.match(missingText, /At least one model migration target/);

  const unsafeFastPath = await modelMigratorHandler(new Request('http://localhost/api/model-migrator/jobs', {
    method: 'POST',
    body: JSON.stringify({
      sourceId: source.id,
      targetId: target.id,
      models: [{
        sourceModelId: 'source-model',
        targetModelId: 'target-model',
        targetConnectionId: 'target-connection',
        mode: 'fast',
        branchName: 'migration-branch',
      }],
    }),
  }));
  const unsafeText = await unsafeFastPath.text();
  assert.equal(unsafeFastPath.status, 400);
  assert.equal(unsafeText.includes(apiKey), false);
  assert.match(unsafeText, /Organization API key confirmation/);
});

test('migration runner preserves a bounded redacted root cause when setup fails before item execution', async () => {
  unlockVault('native passphrase');
  const job = makeStoredJob({
    id: 'model-runner-setup-failure',
    workflow: 'model',
    sourceId: 'missing-source-secret=omni_live_runner_secret_123456',
    destinationIds: ['missing-target'],
    status: 'pending',
    items: [{
      id: 'model-runner-pending-item',
      jobId: 'model-runner-setup-failure',
      destinationId: 'missing-target',
      destinationLabel: 'Missing target',
      targetModelId: 'target-model',
      kind: 'model_fast_path',
      status: 'pending',
    }],
  });
  insertJob(job);

  await runMigrationJob(job.id);
  const completed = getJob(job.id);
  assert.equal(completed?.status, 'failed');
  const error = completed?.items[0]?.error || '';
  assert.match(error, /Job failed before this step could run/);
  assert.match(error, /Instance not found/);
  assert.doesNotMatch(error, /omni_live_runner_secret_123456/);
  assert.ok(error.length <= 550);
});

test('model migration merge requires successful validation before branch merge', async () => {
  unlockVault('native passphrase');
  upsertInstance({
    id: 'source-1',
    label: 'Merge Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'omni_live_merge_source_secret_123456',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const target = upsertInstance({
    label: 'Merge Target',
    role: 'destination',
    baseUrl: 'https://target.example.omniapp.co',
    apiKey: 'omni_live_merge_target_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const job = makeStoredJob({
    id: 'model-merge-blocked',
    workflow: 'model',
    destinationIds: [target.id],
    status: 'failed',
    details: {
      targetId: target.id,
      retryInput: {
        sourceId: 'source-1',
        targetId: target.id,
        models: [{
          sourceModelId: 'source-model',
          targetModelId: 'target-model',
          targetConnectionId: 'target-connection',
          mode: 'translate',
          branchName: 'blocked-branch',
          acceptedFiles: [{ fileName: 'orders.view', yaml: 'dimensions: {}' }],
        }],
        content: [],
        replaceSameNamed: false,
    deleteSourceOnSuccess: false,
        postMigrationActions: [],
      },
    },
    items: [{
      id: 'validate-failed',
      jobId: 'model-merge-blocked',
      destinationId: target.id,
      destinationLabel: target.label,
      targetModelId: 'target-model',
      kind: 'model_validate',
      status: 'failed',
      error: 'Validation failed.',
    }],
  });
  insertJob(job);

  await assert.rejects(
    () => mergeModelMigrationJob(job.id, { publishDrafts: true, deleteBranch: true }),
    /Cannot merge until every target model validates successfully/,
  );
});

test('model fast path validates the migrated branch instead of main', async () => {
  unlockVault('native passphrase');
  const source = upsertInstance({
    id: 'fb123456-7890-49a5-a50d-245a6c4141ea',
    label: 'Fast Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'omni_live_fast_source_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const target = upsertInstance({
    id: 'ac987654-3210-4cde-8123-abcdefabcdef',
    label: 'Fast Target',
    role: 'destination',
    baseUrl: 'https://target.example.omniapp.co',
    apiKey: 'omni_live_fast_target_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const originalMigrateModel = OmniClient.prototype.migrateModel;
  const originalFindModelBranch = OmniClient.prototype.findModelBranch;
  const originalValidateModel = OmniClient.prototype.validateModel;
  const originalValidateModelContent = OmniClient.prototype.validateModelContent;
  const validateBranchIds: Array<string | undefined> = [];
  const contentValidateBranchIds: Array<string | undefined> = [];

  OmniClient.prototype.migrateModel = async () => ({ status: 'ok' });
  OmniClient.prototype.findModelBranch = async () => ({ id: 'branch-fast-123', name: 'fast-branch', raw: {} });
  OmniClient.prototype.validateModel = async (_modelId: string, branchId?: string) => {
    validateBranchIds.push(branchId);
    return [];
  };
  OmniClient.prototype.validateModelContent = async (_modelId: string, branchId?: string) => {
    contentValidateBranchIds.push(branchId);
    return {};
  };

  try {
    const job = await createModelMigrationJob({
      sourceId: source.id,
      targetId: target.id,
      models: [{
        sourceModelId: 'source-model',
        targetModelId: 'target-model',
        targetConnectionId: 'target-connection',
        mode: 'fast',
        branchName: 'fast-branch',
        fastPathSchemaConfirmed: true,
        orgApiKeyConfirmed: true,
      }],
      content: [],
      replaceSameNamed: false,
      mergeAfterValidation: false,
      publishDrafts: false,
      deleteBranch: true,
      postMigrationActions: [],
    });
    const completed = await waitForJob(job.id);

    assert.equal(
      completed.status,
      'succeeded',
      completed.items.map((item) => `${item.kind}:${item.status}:${item.error || ''}`).join(' | '),
    );
    assert.deepEqual(validateBranchIds, ['branch-fast-123']);
    assert.deepEqual(contentValidateBranchIds, ['branch-fast-123']);
    assert.equal(completed.items.find((item) => item.kind === 'model_fast_path')?.details?.branchId, 'branch-fast-123');
    const retryInput = completed.details?.retryInput as { sourceId?: string; targetId?: string } | undefined;
    assert.equal(retryInput?.sourceId, source.id);
    assert.equal(retryInput?.targetId, target.id);
  } finally {
    OmniClient.prototype.migrateModel = originalMigrateModel;
    OmniClient.prototype.findModelBranch = originalFindModelBranch;
    OmniClient.prototype.validateModel = originalValidateModel;
    OmniClient.prototype.validateModelContent = originalValidateModelContent;
  }
});

test('model migration merge records PR handoff without forcing protected git settings', async () => {
  unlockVault('native passphrase');
  upsertInstance({
    id: 'source-1',
    label: 'PR Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'omni_live_pr_source_secret_123456',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const target = upsertInstance({
    label: 'PR Target',
    role: 'destination',
    baseUrl: 'https://target.example.omniapp.co',
    apiKey: 'omni_live_pr_target_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const job = makeStoredJob({
    id: 'model-merge-pr-handoff',
    workflow: 'model',
    destinationIds: [target.id],
    status: 'succeeded',
    details: {
      targetId: target.id,
      retryInput: {
        sourceId: 'source-1',
        targetId: target.id,
        models: [{
          sourceModelId: 'source-model',
          targetModelId: 'target-model',
          targetConnectionId: 'target-connection',
          mode: 'translate',
          branchName: 'protected-branch',
          mergeHandoffRequired: true,
          acceptedFiles: [{ fileName: 'orders.view', yaml: 'dimensions: {}' }],
        }],
        content: [],
        replaceSameNamed: false,
        deleteSourceOnSuccess: false,
        postMigrationActions: [],
      },
    },
    items: [
      {
        id: 'branch-created',
        jobId: 'model-merge-pr-handoff',
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: 'target-model',
        kind: 'model_branch_create',
        status: 'succeeded',
        details: { branchName: 'protected-branch' },
      },
      {
        id: 'validate-succeeded',
        jobId: 'model-merge-pr-handoff',
        destinationId: target.id,
        destinationLabel: target.label,
        targetModelId: 'target-model',
        kind: 'model_validate',
        status: 'succeeded',
      },
    ],
  });
  insertJob(job);

  const originalFindModelBranch = OmniClient.prototype.findModelBranch;
  const originalCreateOrUpdateModelBranchPullRequest = OmniClient.prototype.createOrUpdateModelBranchPullRequest;
  const originalMergeModelBranch = OmniClient.prototype.mergeModelBranch;
  const originalDeleteModelBranch = OmniClient.prototype.deleteModelBranch;
  const requestedPullRequests: Array<{ branchId: string; commitMessage: string }> = [];
  let mergeCalled = false;

  OmniClient.prototype.findModelBranch = async () => ({ id: 'branch-protected-123', name: 'protected-branch', raw: {} });
  OmniClient.prototype.createOrUpdateModelBranchPullRequest = async (input) => {
    requestedPullRequests.push({ branchId: input.branchId, commitMessage: input.commitMessage });
    return { pr_url: 'https://github.example/pull/42' };
  };
  OmniClient.prototype.mergeModelBranch = async () => {
    mergeCalled = true;
    return { ok: true };
  };
  OmniClient.prototype.deleteModelBranch = async () => ({ ok: true });

  try {
    const merged = await mergeModelMigrationJob(job.id, { publishDrafts: true, deleteBranch: true });
    const prItem = merged.items.find((item) => item.kind === 'model_pr');
    assert.equal(prItem?.status, 'succeeded');
    assert.equal(mergeCalled, false);
    assert.deepEqual(requestedPullRequests, [{
      branchId: 'branch-protected-123',
      commitMessage: 'OmniKit Model Migrator review for target-model',
    }]);
  } finally {
    OmniClient.prototype.findModelBranch = originalFindModelBranch;
    OmniClient.prototype.createOrUpdateModelBranchPullRequest = originalCreateOrUpdateModelBranchPullRequest;
    OmniClient.prototype.mergeModelBranch = originalMergeModelBranch;
    OmniClient.prototype.deleteModelBranch = originalDeleteModelBranch;
  }
});

test('admin readiness is GET-only, bounded at scale, lazy for roles, and excludes hostile upstream values from JSON and logs', async (t) => {
  clearAdminReadinessCacheForTests();
  unlockVault('admin readiness security passphrase');
  const apiKey = 'omni_live_admin_readiness_secret_1234567890';
  const saved = upsertInstance({
    label: 'Admin readiness security fixture',
    role: 'both',
    baseUrl: 'https://8.8.8.8',
    apiKey,
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const hostileValues = [
    apiKey,
    'Bearer upstream-bearer-secret-1234567890',
    'https://user:password@tenant.invalid/private',
    'sensitive-person@example.com',
    'RAW_RESPONSE_MARKER_ADMIN_READINESS',
  ];
  const calls: Array<{ method: string; redirect?: RequestRedirect; url: string }> = [];
  const logs: string[] = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(' '));
    });
  }

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    calls.push({ method, redirect: init?.redirect, url: url.toString() });
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${apiKey}`);

    const hostileRecord = {
      email: hostileValues[3],
      authorization: hostileValues[1],
      credentialUrl: hostileValues[2],
      rawResponse: hostileValues[4],
      apiKey,
    };
    if (url.pathname === '/api/scim/v2/users') {
      const startIndex = Number(url.searchParams.get('startIndex') || '1');
      const remaining = Math.max(0, 250 - startIndex + 1);
      const count = Math.min(100, remaining);
      return new Response(JSON.stringify({
        Resources: Array.from({ length: count }, (_, index) => ({
          id: `user-${startIndex + index}`,
          active: index % 2 === 0,
          ...hostileRecord,
        })),
        itemsPerPage: count,
        startIndex,
        totalResults: 250,
        rawResponse: hostileValues[4],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/scim/v2/groups') {
      return new Response(JSON.stringify({
        Resources: Array.from({ length: 100 }, (_, index) => ({ id: `group-${index + 1}`, ...hostileRecord })),
        itemsPerPage: 100,
        startIndex: 1,
        totalResults: 100,
        rawResponse: hostileValues[4],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/v1/user-attributes') {
      return new Response(JSON.stringify({
        records: [{
          name: 'department',
          multiple_values: false,
          system: false,
          default_value: apiKey,
          description: hostileValues[4],
          ownerEmail: hostileValues[3],
          authorization: hostileValues[1],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/\/api\/v1\/users\/[^/]+\/model-roles$/.test(url.pathname)) {
      return new Response(JSON.stringify({
        results: [{
          roleName: 'Viewer',
          modelId: 'model-safe',
          connectionId: 'connection-safe',
          resolved: true,
          from: { type: 'group', name: 'Safe group', depth: 1 },
          ...hostileRecord,
        }],
        rawResponse: hostileValues[4],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/scim/v2/embed/users') {
      return new Response(JSON.stringify({
        Resources: [{ id: 'embed-safe', active: true, ...hostileRecord }],
        itemsPerPage: 1,
        startIndex: 1,
        totalResults: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected readiness request: ${url.pathname}`);
  });

  const identityResponse = await adminReadinessHandler(new Request(
    `http://127.0.0.1/api/admin-readiness?instanceId=${encodeURIComponent(saved.id)}&workspace=identity`,
  ));
  assert.equal(identityResponse.status, 200);
  const identityJson = await identityResponse.text();
  const identityReport = JSON.parse(identityJson) as {
    capabilities: Array<{ id: string; data?: { total?: number } }>;
  };
  assert.equal(identityReport.capabilities.find(({ id }) => id === 'identity.scim_users')?.data?.total, 250);
  assert.equal(identityReport.capabilities.find(({ id }) => id === 'identity.scim_groups')?.data?.total, 100);
  assert.equal(calls.some(({ url }) => url.includes('/model-roles')), false, 'roles must not be fetched during collection summary reads');

  const developerCallStart = calls.length;
  const developerResponse = await adminReadinessHandler(new Request(
    `http://127.0.0.1/api/admin-readiness?instanceId=${encodeURIComponent(saved.id)}&workspace=developer`,
  ));
  assert.equal(developerResponse.status, 200);
  const developerJson = await developerResponse.text();
  const developerCalls = calls.slice(developerCallStart);
  assert.deepEqual(developerCalls.map(({ url }) => new URL(url).pathname), ['/api/scim/v2/embed/users']);
  assert.equal(developerCalls.some(({ url }) => /sso|audit|api-explorer/i.test(url)), false);

  const postureResponse = await adminReadinessHandler(new Request(
    `http://127.0.0.1/api/admin-readiness?instanceId=${encodeURIComponent(saved.id)}&workspace=identity&principalType=user&principalId=${encodeURIComponent('user / 1')}&modelId=model-safe&connectionId=connection-safe`,
  ));
  assert.equal(postureResponse.status, 200);
  const postureJson = await postureResponse.text();
  assert.equal(calls.filter(({ url }) => url.includes('/model-roles')).length, 1, 'one explicit principal must produce one lazy role read');

  assert.ok(calls.every(({ method }) => method === 'GET'));
  assert.ok(calls.every(({ redirect }) => redirect === 'manual'));
  assert.ok(calls.every(({ url }) => !hostileValues.some((value) => url.includes(value))));
  const serializedEvidence = [identityJson, developerJson, postureJson, logs.join('\n')].join('\n');
  for (const value of hostileValues) {
    assert.equal(serializedEvidence.includes(value), false, `readiness evidence leaked hostile marker: ${value}`);
  }
  clearAdminReadinessCacheForTests();
});

test('admin readiness maps status and malformed-response evidence exactly without reading error bodies', async () => {
  const instance = {
    id: 'readiness-status-instance',
    baseUrl: 'https://8.8.4.4',
    apiKey: 'omni_live_status_mapping_secret_1234567890',
    updatedAt: '2026-08-09T12:00:00.000Z',
    organizationApiKeyConfirmed: false,
  };
  const cases = [
    { status: 401, evidenceState: 'unauthorized', reasonCode: 'authentication_required' },
    { status: 403, evidenceState: 'unauthorized', reasonCode: 'permission_denied' },
    { status: 404, evidenceState: 'unsupported', reasonCode: 'collection_not_found' },
    { status: 302, evidenceState: 'failed', reasonCode: 'unexpected_redirect' },
  ];

  for (const expected of cases) {
    clearAdminReadinessCacheForTests();
    const methods: string[] = [];
    const report = await getAdminReadinessReport({ instance, workspace: 'fleet' }, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        methods.push(String(init?.method || 'GET'));
        if (url.pathname === '/api/v1/folders') {
          return new Response('RAW_ERROR_BODY_MUST_NOT_ESCAPE', { status: expected.status });
        }
        return new Response(JSON.stringify({
          records: [],
          pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
      now: () => new Date('2026-08-09T12:00:00.000Z'),
      freshCacheMs: 0,
    });
    const folder = report.capabilities.find(({ id }) => id === 'fleet.folder_read');
    assert.equal(folder?.evidenceState, expected.evidenceState);
    assert.equal(folder?.reason.code, expected.reasonCode);
    assert.equal(JSON.stringify(report).includes('RAW_ERROR_BODY_MUST_NOT_ESCAPE'), false);
    assert.ok(methods.every((method) => method === 'GET'));
  }

  clearAdminReadinessCacheForTests();
  const malformedJson = await getAdminReadinessReport({ instance, workspace: 'fleet' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v1/folders') return new Response('{not-json', { status: 200 });
      return new Response(JSON.stringify({
        records: [],
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
      }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(malformedJson.capabilities.find(({ id }) => id === 'fleet.folder_read')?.reason.code, 'invalid_json');

  clearAdminReadinessCacheForTests();
  const malformedShape = await getAdminReadinessReport({ instance, workspace: 'fleet' }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v1/folders') return new Response(JSON.stringify({ raw: [] }), { status: 200 });
      return new Response(JSON.stringify({
        records: [],
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
      }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(malformedShape.capabilities.find(({ id }) => id === 'fleet.folder_read')?.reason.code, 'invalid_response_shape');

  clearAdminReadinessCacheForTests();
  const resourceMissing = await getAdminReadinessReport({
    instance,
    workspace: 'identity',
    accessPosture: { principalType: 'user', principalId: 'missing-user' },
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/model-roles')) return new Response('RAW_404_BODY', { status: 404 });
      if (url.pathname === '/api/v1/user-attributes') return new Response(JSON.stringify({ records: [] }), { status: 200 });
      return new Response(JSON.stringify({
        Resources: [],
        itemsPerPage: 0,
        startIndex: 1,
        totalResults: 0,
      }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(resourceMissing.accessPosture?.evidenceState, 'unavailable');
  assert.equal(resourceMissing.accessPosture?.reason.code, 'resource_not_found');
  assert.equal(JSON.stringify(resourceMissing).includes('RAW_404_BODY'), false);
  clearAdminReadinessCacheForTests();
});

test('admin readiness handler rejects writes and secret-bearing or out-of-scope query parameters before outbound work', async (t) => {
  let outboundCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    outboundCalls += 1;
    return new Response('{}', { status: 200 });
  });

  const postResponse = await adminReadinessHandler(new Request(
    'http://127.0.0.1/api/admin-readiness?instanceId=missing&workspace=fleet',
    { method: 'POST' },
  ));
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get('Allow'), 'GET');

  for (const query of [
    'instanceId=missing&workspace=fleet&api_key=secret',
    'instanceId=missing&workspace=fleet&base_url=https%3A%2F%2Ftenant.invalid',
    'instanceId=missing&workspace=fleet&principalType=user&principalId=user-1',
    'instanceId=one&instanceId=two&workspace=fleet',
  ]) {
    const response = await adminReadinessHandler(new Request(`http://127.0.0.1/api/admin-readiness?${query}`));
    assert.equal(response.status, 400);
  }
  assert.equal(outboundCalls, 0);
});

test('vault persistence is atomic and keeps one recoverable backup generation', () => {
  const vaultPath = process.env.OMNIKIT_VAULT_PATH!;
  unlockVault('atomic write passphrase');
  upsertInstance({
    label: 'Atomic write workspace',
    role: 'both',
    baseUrl: 'https://atomic-write.example.omniapp.co',
    apiKey: 'omni-atomic-write-key-not-real',
  });

  // No temp file may survive a completed write, and the vault itself must stay
  // operator-only.
  const leftoverTemp = readdirSync(tempDir).filter((entry) => entry.endsWith('.tmp'));
  assert.deepEqual(leftoverTemp, [], 'an interrupted-write temp file was left behind');
  assert.equal(statSync(vaultPath).mode & 0o777, 0o600);

  // A second write creates the backup generation that makes an interrupted
  // passphrase change recoverable.
  const firstCiphertext = readFileSync(vaultPath);
  upsertInstance({
    label: 'Second atomic workspace',
    role: 'both',
    baseUrl: 'https://atomic-write-two.example.omniapp.co',
    apiKey: 'omni-atomic-write-two-key-not-real',
  });
  const backupPath = `${vaultPath}.bak`;
  assert.ok(existsSync(backupPath), 'no backup generation was retained');
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(backupPath), firstCiphertext, 'the backup is not the prior ciphertext');
  assert.notDeepEqual(readFileSync(vaultPath), firstCiphertext);

  // Reset must leave no recoverable ciphertext, backup included.
  resetVault();
  assert.equal(existsSync(vaultPath), false);
  assert.equal(existsSync(backupPath), false, 'reset left the backup ciphertext on disk');
});

test('retired BI migration credential purge rewrites both vault generations and preserves current records', () => {
  const vaultPath = process.env.OMNIKIT_VAULT_PATH!;
  const backupPath = `${vaultPath}.bak`;
  const passphrase = 'retired credential purge passphrase';
  const providerSecret = 'retired-provider-secret-not-real';
  const sourceSecret = 'retired-source-secret-not-real';

  unlockVault(passphrase);
  const instance = upsertInstance({
    label: 'Retained Omni workspace',
    role: 'both',
    baseUrl: 'https://retained.example.omniapp.co',
    apiKey: 'retained-omni-key-not-real',
  });
  const recipe = upsertDeckRecipe({
    name: 'Retained deck recipe',
    savedForInstanceId: instance.id,
    savedForInstanceLabel: instance.label,
    savedForBaseUrlHost: 'retained.example.omniapp.co',
    recipe: buildRecipe({
      dashboardUrl: 'https://retained.example.omniapp.co/dashboards/retained-dashboard',
      dashboardId: 'retained-dashboard',
      dashboardName: 'Retained dashboard',
      selectedTileIds: ['tile-1'],
      insights: {},
      brand: DEFAULT_BRAND,
      includeAppendix: false,
    }),
  });
  lockVault();

  const legacyPayload = readNativeVaultPayload(vaultPath, passphrase);
  legacyPayload.llmProviders = [{ id: 'retired-provider', credential: providerSecret }];
  legacyPayload.platformConnections = [{ id: 'retired-source', credential: sourceSecret }];
  writeLegacyVault(vaultPath, passphrase, legacyPayload);
  writeLegacyVault(backupPath, passphrase, legacyPayload);

  unlockVault(passphrase);
  assert.equal(vaultStatus().retiredBiMigrationProviderCount, 1);
  assert.equal(vaultStatus().retiredBiMigrationSourceCount, 1);
  assert.deepEqual(purgeRetiredBiMigrationCredentials(), {
    removedProviderProfiles: 1,
    removedSourceConnections: 1,
  });
  assert.ok(listInstances().some((record) => record.id === instance.id));
  assert.ok(listDeckRecipes().some((record) => record.id === recipe.id));

  for (const generationPath of [vaultPath, backupPath]) {
    assert.ok(existsSync(generationPath), `${generationPath} was not rewritten`);
    assert.equal(statSync(generationPath).mode & 0o777, 0o600);
    const payload = readNativeVaultPayload(generationPath, passphrase);
    assert.deepEqual(payload.llmProviders, []);
    assert.deepEqual(payload.platformConnections, []);
    assert.ok(
      (payload.instances as Array<{ id?: string }>).some((record) => record.id === instance.id),
      `${generationPath} lost the saved instance`,
    );
    assert.ok(
      (payload.deckRecipes as Array<{ id?: string }>).some((record) => record.id === recipe.id),
      `${generationPath} lost the deck recipe`,
    );
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(providerSecret), false);
    assert.equal(serialized.includes(sourceSecret), false);
  }
});

test('retired credential purge replaces the recovery generation before the active vault', () => {
  const vaultPath = process.env.OMNIKIT_VAULT_PATH!;
  const backupPath = `${vaultPath}.bak`;
  const passphrase = 'purge ordering test passphrase';
  const providerFixture = 'fixture-provider-value-not-sensitive';
  const sourceFixture = 'fixture-source-value-not-sensitive';

  unlockVault(passphrase);
  upsertInstance({
    label: 'Purge ordering workspace',
    role: 'both',
    baseUrl: 'https://purge-ordering.example.omniapp.co',
    apiKey: 'omni-purge-ordering-key-not-real',
  });
  lockVault();

  const legacyPayload = readNativeVaultPayload(vaultPath, passphrase);
  legacyPayload.llmProviders = [{ id: 'retired-provider', credential: providerFixture }];
  legacyPayload.platformConnections = [{ id: 'retired-source', credential: sourceFixture }];
  writeLegacyVault(vaultPath, passphrase, legacyPayload);
  writeLegacyVault(backupPath, passphrase, legacyPayload);

  unlockVault(passphrase);
  const replacedPaths: string[] = [];
  assert.throws(() => purgeRetiredBiMigrationCredentials({
    renameFile: (sourcePath, destinationPath) => {
      replacedPaths.push(String(destinationPath));
      if (destinationPath === vaultPath) throw new Error('simulated active-generation replacement failure');
      renameSync(sourcePath, destinationPath);
    },
  }), /simulated active-generation replacement failure/);

  assert.deepEqual(replacedPaths, [backupPath, vaultPath]);
  assert.equal(vaultStatus().retiredBiMigrationProviderCount, 0);
  assert.equal(vaultStatus().retiredBiMigrationSourceCount, 0);

  const activeAfterFailure = readNativeVaultPayload(vaultPath, passphrase);
  const backupAfterFailure = readNativeVaultPayload(backupPath, passphrase);
  assert.equal(activeAfterFailure.llmProviders.length, 1, 'the failed active replacement must remain visible for reconciliation');
  assert.equal(activeAfterFailure.platformConnections.length, 1, 'the failed active replacement must remain visible for reconciliation');
  assert.deepEqual(backupAfterFailure.llmProviders, []);
  assert.deepEqual(backupAfterFailure.platformConnections, []);
  assert.deepEqual(readdirSync(tempDir).filter((entry) => entry.endsWith('.tmp')), []);

  // A bounded retry starts from the already-purged in-memory authority and
  // finishes both generations without reintroducing the retired values.
  assert.deepEqual(purgeRetiredBiMigrationCredentials(), {
    removedProviderProfiles: 0,
    removedSourceConnections: 0,
  });
  for (const generationPath of [vaultPath, backupPath]) {
    const payload = readNativeVaultPayload(generationPath, passphrase);
    assert.deepEqual(payload.llmProviders, []);
    assert.deepEqual(payload.platformConnections, []);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(providerFixture), false);
    assert.equal(serialized.includes(sourceFixture), false);
  }
});

test('vault unlock throttles repeated wrong passphrases and clears on success', () => {
  resetUnlockThrottleForTests();
  unlockVault('correct horse battery');
  upsertInstance({
    label: 'Throttle workspace',
    role: 'both',
    baseUrl: 'https://throttle.example.omniapp.co',
    apiKey: 'omni-throttle-key-not-real',
  });
  lockVault();

  // The free attempts fail on the passphrase itself, not on the throttle.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => unlockVault('wrong passphrase'), (error: Error & { statusCode?: number }) => {
      assert.notEqual(error.statusCode, 429, `attempt ${attempt + 1} was throttled before the free budget ran out`);
      return true;
    });
  }

  // The next failure arms the backoff, and further attempts are refused
  // outright rather than being allowed to keep guessing.
  assert.throws(() => unlockVault('wrong passphrase'));
  assert.throws(() => unlockVault('wrong passphrase'), (error: Error & { statusCode?: number; retryAfterSeconds?: number }) => {
    assert.equal(error.statusCode, 429);
    assert.ok((error.retryAfterSeconds ?? 0) > 0);
    assert.match(error.message, /Too many failed unlock attempts/);
    return true;
  });
  // A refused attempt must not leak whether the passphrase was right.
  assert.throws(() => unlockVault('correct horse battery'), (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 429);
    return true;
  });
  assert.equal(vaultStatus().unlocked, false);

  // Clearing the throttle restores normal behaviour, and a success resets it.
  resetUnlockThrottleForTests();
  unlockVault('correct horse battery');
  assert.equal(vaultStatus().unlocked, true);
  assert.equal(listInstances().length, 1);
});

test('vault idle timeout ignores blank configuration and requires an explicit off', () => {
  const original = process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
  try {
    // A declared-but-empty variable is the footgun: Number('') is 0, which used
    // to disable auto-lock entirely instead of falling back to the default.
    for (const blank of ['', '   ', 'not-a-number', '0', '-5']) {
      process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = blank;
      assert.equal(getVaultIdleTimeoutMs(), 30 * 60 * 1000, `"${blank}" must fall back to the default timeout`);
    }
    delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
    assert.equal(getVaultIdleTimeoutMs(), 30 * 60 * 1000);

    // Small values stay honoured; only an explicit sentinel disables the lock.
    process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = '5';
    assert.equal(getVaultIdleTimeoutMs(), 5);
    process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = 'off';
    assert.equal(getVaultIdleTimeoutMs(), 0);
    process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = 'OFF';
    assert.equal(getVaultIdleTimeoutMs(), 0);

    // An enormous value disables the lock without saying so, so it is capped.
    process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);
    assert.equal(getVaultIdleTimeoutMs(), 24 * 60 * 60 * 1000);
  } finally {
    if (original === undefined) delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
    else process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = original;
  }
});

test('omni-proxy screens outbound targets and refuses to follow credentialed redirects', async () => {
  // Literal addresses skip DNS, so this stays deterministic. The DNS-resolution
  // path itself is covered by the resolveHost-injected validateOutboundUrl test
  // above; what matters here is that omni-proxy now routes through it at all,
  // and that it pins redirect handling like every other outbound call.
  let outboundCalls = 0;
  let observedRedirect: RequestRedirect | undefined;
  let nextStatus = 200;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    outboundCalls += 1;
    observedRedirect = init?.redirect;
    if (nextStatus >= 300 && nextStatus < 400) {
      return new Response(null, { status: nextStatus, headers: { Location: 'https://10.0.0.9/api/v1/folders' } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: nextStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const proxy = (baseUrl: string) => omniProxyHandler(new Request('http://127.0.0.1/api/omni-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: baseUrl,
      api_key: 'omni-proxy-key-not-real',
      method: 'GET',
      endpoint: '/v1/folders',
    }),
  }));

  try {
    const blocked = await proxy('https://10.0.0.9');
    assert.equal(blocked.status, 400);
    assert.match(String(((await blocked.json()) as { error?: string }).error), /local or private network address/);
    assert.equal(outboundCalls, 0, 'a blocked target must not reach the network');

    const allowed = await proxy('https://8.8.8.8');
    assert.equal(allowed.status, 200);
    assert.equal(outboundCalls, 1);
    assert.equal(observedRedirect, 'manual', 'omni-proxy must pin redirect handling');

    // A redirect is reported rather than followed, and rather than surfacing as
    // an uninterpretable empty 3xx body.
    nextStatus = 302;
    const redirected = await proxy('https://8.8.8.8');
    assert.equal(redirected.status, 502);
    assert.match(String(((await redirected.json()) as { error?: string }).error), /redirected the request/);
    assert.equal(outboundCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('outbound URL validation fails closed when DNS resolution hangs', async () => {
  // getaddrinfo cannot be cancelled and holds a libuv threadpool slot, so a
  // blackholing resolver must not be allowed to stall the request that is
  // waiting on it.
  const started = Date.now();
  let lookupCalls = 0;
  const error = await validateOutboundUrl('https://omni-blackholed.example.com/api/v1/folders', {
    label: 'test URL',
    // Never settles, exactly as a blackholed resolver behaves.
    resolveHost: () => {
      lookupCalls += 1;
      return new Promise<Array<{ address: string }>>(() => {});
    },
    resolveTimeoutMs: 40,
  });
  const elapsed = Date.now() - started;
  assert.equal(lookupCalls, 1);
  assert.match(error || '', /host could not be resolved safely/);
  assert.ok(elapsed >= 30, `validation returned substantially before the timeout elapsed (${elapsed}ms)`);
  assert.ok(elapsed < 5_000, `validation waited on the hung lookup (${elapsed}ms)`);

  // A resolver that answers in time is unaffected.
  assert.equal(
    await validateOutboundUrl('https://omni-public.example.com/api/v1/folders', {
      label: 'test URL',
      resolveHost: async () => [{ address: '203.0.114.7' }],
      resolveTimeoutMs: 5_000,
    }),
    null,
  );
});
