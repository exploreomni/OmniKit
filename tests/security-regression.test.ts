import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  listInstances,
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
  vaultStatus,
} from '../server/services/nativeVault';
import {
  clearJobs,
  getJobsPath,
  redactSensitiveText,
  runPostMigrationAction,
  sanitizeJobHistory,
  type MigrationJob,
} from '../server/services/migrationJobs';
import { hydrateVaultCredentialReferences } from '../server/apiMiddleware';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-security-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_JOBS_PATH = path.join(tempDir, 'jobs.json');
  process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = String(30 * 60 * 1000);
  delete process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS;
  delete process.env.OMNIKIT_POST_ACTION_ALLOWLIST;
  lockVault();
});

afterEach(() => {
  resetVault();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
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

test('job history file is created with 0600 permissions', () => {
  clearJobs();
  const mode = statSync(getJobsPath()).mode & 0o777;
  assert.equal(mode, 0o600);
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
