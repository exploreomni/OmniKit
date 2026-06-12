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
  redactSensitiveText,
  runPostMigrationAction,
  sanitizeJobHistory,
  type MigrationJob,
} from '../server/services/migrationJobs';
import {
  closeJobStoreForTests,
  getJobsDbPath,
  insertJob,
} from '../server/services/jobStore';
import { hydrateVaultCredentialReferences } from '../server/apiMiddleware';
import {
  draftContainsForbiddenKeys,
  sanitizeFanoutDraftForStorage,
} from '../src/components/migrateFanout/fanoutStorage';

let tempDir = '';

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

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-security-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_JOBS_PATH = path.join(tempDir, 'jobs.json');
  process.env.OMNIKIT_DB_PATH = path.join(tempDir, 'omnikit.db');
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
  delete process.env.OMNIKIT_DB_PATH;
  delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
  delete process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS;
  delete process.env.OMNIKIT_POST_ACTION_ALLOWLIST;
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

test('fan-out wizard draft stores only non-secret IDs and paths', () => {
  const sanitized = sanitizeFanoutDraftForStorage({
    step: 1,
    sourceId: 'source-instance',
    sourceModelId: 'model-1',
    selectedDocumentIds: ['doc-1', 'doc-1', 'doc-2'],
    emptyFirst: false,
    metadataOnly: true,
    refreshSchemaAfterImport: true,
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'destination-instance',
      targetModelId: 'model-2',
      targetModelName: 'Target Model',
      targetFolderPath: 'Executive Dashboards/Migrated',
      targetFolderId: 'folder-1',
      selectedActionIndexes: [0, 1],
      apiKey: 'omni_live_secret',
      baseUrl: 'https://secret.example.omniapp.co',
    } as never],
    passphrase: 'do not store me',
  } as never);

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('omni_live_secret'), false);
  assert.equal(serialized.includes('secret.example'), false);
  assert.equal(serialized.includes('do not store me'), false);
  assert.deepEqual(sanitized.selectedDocumentIds, ['doc-1', 'doc-2']);
  assert.equal(sanitized.refreshSchemaAfterImport, true);
  assert.equal(draftContainsForbiddenKeys(sanitized), false);
  assert.equal(draftContainsForbiddenKeys({ ...sanitized, apiKey: 'secret' }), true);
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
    }],
    documentIds: ['doc-1'],
    emptyFirst: false,
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
    }],
  };

  const serialized = JSON.stringify(sanitizeJobHistory([job]));
  assert.equal(serialized.includes('secret-token-value'), false);
  assert.equal(serialized.includes('customer@example.com'), false);
  assert.equal(serialized.includes('212-555-0199'), false);
  assert.equal(serialized.includes('4111 1111 1111 1111'), false);
  assert.equal(serialized.includes('abc123'), false);
});

test('local job database is created with 0600 permissions', () => {
  clearJobs();
  for (const filePath of [getJobsDbPath(), `${getJobsDbPath()}-wal`, `${getJobsDbPath()}-shm`]) {
    if (!existsSync(filePath)) continue;
    const mode = statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('local job database does not store plaintext secrets or common sensitive data', () => {
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

  const dbContents = [getJobsDbPath(), `${getJobsDbPath()}-wal`, `${getJobsDbPath()}-shm`]
    .filter(existsSync)
    .map((filePath) => readFileSync(filePath).toString('utf8'))
    .join('\n');
  assert.equal(dbContents.includes('raw-secret-token-value'), false);
  assert.equal(dbContents.includes(email), false);
  assert.equal(dbContents.includes('212-555-0199'), false);
  assert.equal(dbContents.includes('supersecret'), false);
  assert.equal(dbContents.includes('abc123'), false);
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

test('redactSensitiveText keeps non-sensitive text useful', () => {
  assert.equal(
    redactSensitiveText('Folder placement mismatch for Finance Dashboard'),
    'Folder placement mismatch for Finance Dashboard',
  );
});
