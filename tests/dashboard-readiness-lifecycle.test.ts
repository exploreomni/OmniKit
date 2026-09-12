import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiMiddleware } from '../server/apiMiddleware';
import { getDashboardDeploymentPlan, recheckDashboardDeploymentPlan, deployDashboardDeploymentPlan } from '../server/services/dashboardDeploymentPlans';
import { createDashboardReadinessContext } from '../server/services/dashboardReadinessControl';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';

let directory = '';
let historyPath = '';
const environmentKeys = ['OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_VAULT_PATH', 'OMNIKIT_SAFE_COPY_V1_INTERNAL'] as const;
let previousEnvironment: Array<string | undefined>;
const plan = (): DashboardDeploymentPlan => ({ version: 2, evidenceVersion: 4, id: 'example-plan', revision: 4, createdAt: 1, updatedAt: 1,
  intent: { profile: 'safe_copy_v1', requestId: '11111111-1111-4111-8111-111111111111',
    source: { instanceId: 'example-source', connectionId: 'example-source-connection', documentIds: ['example-dashboard'] },
    destinations: [{ targetId: 'example-route', instanceId: 'example-target', connectionId: 'example-target-connection', modelId: 'example-target-model' }] },
  sourceHashes: { 'example-dashboard': 'previous-evidence' }, sourceModelHashes: {},
  targets: [{ targetId: 'example-route', status: 'ready', findings: [], sourceModelIds: [], requiredFiles: [], requiredFilesByModelId: {}, checkedAt: 1 }],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
};
beforeEach(() => {
  previousEnvironment = environmentKeys.map((key) => process.env[key]);
  directory = mkdtempSync(join(tmpdir(), 'omnikit-readiness-lifecycle-'));
  historyPath = join(directory, 'jobs.json');
  process.env.OMNIKIT_JOB_HISTORY_PATH = historyPath;
  process.env.OMNIKIT_VAULT_PATH = join(directory, 'vault.enc');
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'true';
  unlockVault('fictional-readiness-passphrase');
  for (const [id, role] of [['example-source', 'source'], ['example-target', 'destination']] as const) {
    upsertInstance({ id, label: id, role, baseUrl: 'https://93.184.216.34', apiKey: `${id}-fictional-key`,
      postMigrationActions: [], metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] } });
  }
  writeFileSync(`${historyPath}.deployment-plans.json`, JSON.stringify([plan()]));
  mock.method(globalThis, 'fetch', async () => { throw new Error('No live network allowed.'); });
});
afterEach(() => {
  mock.restoreAll();
  resetVault(); lockVault();
  environmentKeys.forEach((key, index) => { if (previousEnvironment[index] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[index]; });
  rmSync(directory, { recursive: true, force: true });
});

test('canceling a recheck revokes prior approval and refuses a late source response', async () => {
  const started = deferred<void>();
  const late = deferred<Record<string, unknown>>();
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => { started.resolve(); return late.promise; });
  const cancel = new AbortController();
  const run = createDashboardReadinessContext({ signal: cancel.signal });
  try {
    const pending = recheckDashboardDeploymentPlan('example-plan', run);
    await started.promise;
    const checking = getDashboardDeploymentPlan('example-plan');
    assert.equal(checking.targets[0].status, 'needs_recheck');
    assert.equal(checking.readinessRun?.status, 'running');
    cancel.abort();
    late.resolve({ name: 'Example', containers: [], modelId: 'example-model', workbookModelId: 'example-workbook' });
    await assert.rejects(pending, /canceled/);
    const stored = getDashboardDeploymentPlan('example-plan');
    assert.equal(stored.readinessRun?.status, 'canceled');
    assert.equal(stored.targets[0].status, 'needs_recheck');
    assert.equal(stored.sourceHashes['example-dashboard'], 'previous-evidence');
    await assert.rejects(deployDashboardDeploymentPlan(stored.id, { revision: stored.revision, targetIds: ['example-route'], requestId: '22222222-2222-4222-8222-222222222222' }, null), /Only ready/);
  } finally { run.dispose(); }
});

test('overall timeout records its failed stage without accepting partial evidence', async () => {
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async function (this: OmniClient) {
    const signal = (this as unknown as { operationSignal: AbortSignal }).operationSignal;
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const run = createDashboardReadinessContext({ deadlineMs: 10 });
  try {
    await assert.rejects(recheckDashboardDeploymentPlan('example-plan', run), /time limit/);
    const stored = getDashboardDeploymentPlan('example-plan');
    assert.equal(stored.readinessRun?.status, 'timed_out');
    assert.equal(stored.readinessRun?.stage, 'source_dashboard');
    assert.equal(stored.targets[0].status, 'needs_recheck');
  } finally { run.dispose(); }
});

test('middleware preserves streaming query and propagates browser disconnect to readiness and upstream reads', async () => {
  const started = deferred<void>();
  let upstream: AbortSignal | undefined;
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async function (this: OmniClient) {
    upstream = (this as unknown as { operationSignal: AbortSignal }).operationSignal;
    started.resolve();
    return new Promise<never>((_resolve, reject) => {
      if (upstream!.aborted) reject(upstream!.reason);
      else upstream!.addEventListener('abort', () => reject(upstream!.reason), { once: true });
    });
  });
  const request = Readable.from([]);
  Object.assign(request, { url: '/api/migration-jobs/deployment-plans/example-plan/recheck?stream=1',
    method: 'POST', headers: { host: 'localhost' }, complete: true });
  const chunks: string[] = [];
  const headers = new Map<string, string>();
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
  Object.assign(response, { setHeader(key: string, value: string) { headers.set(key.toLowerCase(), value); } });
  const handling = apiMiddleware()(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  await started.promise;
  await new Promise<void>((done) => setImmediate(done));
  assert.match(headers.get('content-type') || '', /ndjson/);
  assert.match(chunks.join(''), /source_dashboard/);
  response.destroy();
  await handling;
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(upstream?.aborted, true);
  const stored = JSON.parse(readFileSync(`${historyPath}.deployment-plans.json`, 'utf8')) as DashboardDeploymentPlan[];
  assert.equal(stored[0].readinessRun?.status, 'canceled');
  assert(!chunks.join('').includes('"type":"complete"'));
});
