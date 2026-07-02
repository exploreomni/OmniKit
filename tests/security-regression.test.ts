import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

import {
  listInstances,
  lockVault,
  resetVault,
  touchVaultSession,
  unlockVault,
  upsertInstance,
  vaultStatus,
} from '../server/services/nativeVault';
import { importLegacyVault } from '../server/services/legacyVaultImport';
import {
  clearJobs,
  createModelMigrationJob,
  mergeModelMigrationJob,
  redactSensitiveText,
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
import instanceDashboardHandler from '../server/handlers/instance-dashboard';
import {
  publishMigrationJobEvent,
  subscribeMigrationJobEvents,
  type MigrationJobEvent,
} from '../server/services/jobEvents';
import {
  apiRouteFromUrl,
  apiWebRequestUrl,
  hydrateVaultCredentialReferences,
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
  delete process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS;
  delete process.env.OMNIKIT_POST_ACTION_ALLOWLIST;
  lockVault();
});

afterEach(() => {
  resetVault();
  closeJobStoreForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
  delete process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS;
  delete process.env.OMNIKIT_POST_ACTION_ALLOWLIST;
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

test('workflow connection guard rejects manual and plaintext sessions', () => {
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

  assert.notEqual(first, second);
  assert.equal(first, 'inst-1|key-present');
  assert.equal(second, 'inst-2|key-present');
  assert.equal(manualFallback, 'https://shared.example.omniapp.co|no-key');
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
    items: [{
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
    }],
  };

  const serialized = JSON.stringify(sanitizeJobHistory([job]));
  assert.equal(serialized.includes('secret-token-value'), false);
  assert.equal(serialized.includes('customer@example.com'), false);
  assert.equal(serialized.includes('212-555-0199'), false);
  assert.equal(serialized.includes('4111 1111 1111 1111'), false);
  assert.equal(serialized.includes('abc123'), false);
  assert.equal(serialized.includes('on_sql'), false);
  assert.equal(serialized.includes('private_customer_table'), false);
  assert.equal(serialized.includes('relationshipType'), true);
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
    method: 'POST' as const,
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
      method: 'POST',
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
  const refreshedModels: string[] = [];
  OmniClient.prototype.refreshModel = async (modelId: string) => {
    refreshedModels.push(modelId);
    return { jobId: 'refresh-job-1', status: 'queued', raw: {} };
  };
  try {
    const response = await instanceDashboardHandler(new Request(`http://localhost/api/instance-dashboard/${saved.id}/refresh-schema`, {
      method: 'POST',
      body: JSON.stringify({ modelId: 'model-1' }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { ok?: boolean; instanceId?: string; modelId?: string; jobId?: string; status?: string };
    assert.deepEqual(body, {
      ok: true,
      instanceId: saved.id,
      modelId: 'model-1',
      jobId: 'refresh-job-1',
      status: 'queued',
    });
    assert.deepEqual(refreshedModels, ['model-1']);
  } finally {
    OmniClient.prototype.refreshModel = originalRefreshModel;
  }
});

test('history JSON export redacts operations, jobs, actions, and nested details', () => {
  const payload = sanitizeHistoryExportPayload({
    operations: [{
      id: 'op-1',
      type: 'migration',
      description: 'Sent migration summary for owner@example.com with Bearer history-secret-token at 212-555-0199',
      timestamp: Date.now(),
      itemCount: 1,
      successCount: 1,
      failureCount: 0,
      durationMs: 42,
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
  assert.equal(serialized.includes('212-555-0199'), false);
  assert.equal(serialized.includes('Finance Dashboard'), true);
});

test('redactSensitiveText keeps non-sensitive text useful', () => {
  assert.equal(
    redactSensitiveText('Folder placement mismatch for Finance Dashboard'),
    'Folder placement mismatch for Finance Dashboard',
  );
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
  assert.match(unsafeText, /schema identity confirmation/);
});

test('model migration merge requires successful validation before branch merge', async () => {
  unlockVault('native passphrase');
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
      }],
      content: [],
      replaceSameNamed: false,
      mergeAfterValidation: false,
      publishDrafts: false,
      deleteBranch: true,
      postMigrationActions: [],
    });
    const completed = await waitForJob(job.id);

    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(validateBranchIds, ['branch-fast-123']);
    assert.deepEqual(contentValidateBranchIds, ['branch-fast-123']);
    assert.equal(completed.items.find((item) => item.kind === 'model_fast_path')?.details?.branchId, 'branch-fast-123');
  } finally {
    OmniClient.prototype.migrateModel = originalMigrateModel;
    OmniClient.prototype.findModelBranch = originalFindModelBranch;
    OmniClient.prototype.validateModel = originalValidateModel;
    OmniClient.prototype.validateModelContent = originalValidateModelContent;
  }
});

test('model migration merge records PR handoff without forcing protected git settings', async () => {
  unlockVault('native passphrase');
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

  const merged = await mergeModelMigrationJob(job.id, { publishDrafts: true, deleteBranch: true });
  const mergeItem = merged.items.find((item) => item.kind === 'model_merge');
  assert.equal(mergeItem?.status, 'warning');
  assert.match(mergeItem?.warnings?.join('\n') || '', /git\/PR handoff/);
});
