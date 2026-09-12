import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import type { DashboardReadinessProgressEvent } from '../shared/dashboardReadiness';
import { createDashboardDeploymentPlan, readDashboardReadinessStream, recheckDashboardDeploymentPlan } from '../src/services/dashboardDeploymentPlans';

function plan(): DashboardDeploymentPlan {
  return { version: 2, id: 'example-plan', revision: 1, createdAt: 1, updatedAt: 1, sourceHashes: {}, sourceModelHashes: {},
    intent: { profile: 'safe_copy_v1', requestId: 'example-request', source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] }, destinations: [{ targetId: 'target', instanceId: 'destination', connectionId: 'destination-connection', modelId: 'destination-model' }] },
    targets: [{ targetId: 'target', status: 'unverified', findings: [], checkedAt: 1, sourceModelIds: [], requiredFiles: [], requiredFilesByModelId: {} }],
  };
}
const progress: DashboardReadinessProgressEvent = { type: 'progress', runId: 'example-run', stage: 'source_dashboard', elapsedMs: 25, completed: 1, total: 2 };
function stream(events: unknown[]) {
  const raw = events.map((event) => JSON.stringify(event)).join('\n');
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < raw.length; offset += 17) controller.enqueue(new TextEncoder().encode(raw.slice(offset, offset + 17)));
    controller.close();
  } }), { headers: { 'content-type': 'application/x-ndjson' } });
}

test('chunked progress is reported but only an explicit complete terminal provides a plan', async () => {
  const seen: DashboardReadinessProgressEvent[] = [];
  const value = plan();
  value.readinessRun = { id: 'previous-completed-run', status: 'complete', startedAt: 1 };
  const response = await readDashboardReadinessStream(stream([progress, { type: 'complete', runId: progress.runId, plan: value }]), undefined, (event) => seen.push(event));
  assert.deepEqual(seen, [progress]);
  assert.deepEqual(response.plan, value, 'An identical cached create may retain the prior completed run identity.');
});

test('truncated, malformed, mismatched, or extra terminal records fail closed', async () => {
  for (const events of [
    [progress],
    [{ ...progress, total: 0 }],
    [progress, { type: 'complete', runId: 'different-run', plan: plan() }],
    [progress, { type: 'complete', runId: progress.runId, plan: {} }],
    [progress, { type: 'complete', runId: progress.runId, plan: plan() }, progress],
    [{ type: 'unknown', runId: progress.runId }],
  ]) await assert.rejects(readDashboardReadinessStream(stream(events)), /incomplete|invalid|before completion/);
});

test('error events cannot return a plan, including an error after a complete record', async () => {
  const error = { type: 'error', runId: progress.runId, code: 'DASHBOARD_READINESS_DEADLINE_EXCEEDED', error: 'The readiness deadline was exceeded.', stage: 'source_models', elapsedMs: 10_000 };
  await assert.rejects(readDashboardReadinessStream(stream([progress, error])), /deadline was exceeded/);
  await assert.rejects(readDashboardReadinessStream(stream([{ type: 'complete', runId: progress.runId, plan: plan() }, error])), /invalid/);
});

test('abort cancels the stream and rejects any queued completion', async () => {
  const controller = new AbortController();
  await assert.rejects(readDashboardReadinessStream(stream([progress, { type: 'complete', runId: progress.runId, plan: plan() }]), controller.signal, () => controller.abort()), { name: 'AbortError' });
  await assert.rejects(readDashboardReadinessStream(stream([]), controller.signal), { name: 'AbortError' });
});

test('ordinary JSON success and errors are supported without accepting an unfinished plan', async () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await readDashboardReadinessStream(response({ plan: plan() })), { plan: plan() });
  await assert.rejects(readDashboardReadinessStream(response({ error: 'Scope could not be read.' }, 403)), /Scope could not be read/);
  await assert.rejects(readDashboardReadinessStream(response({ plan: { ...plan(), readinessRun: { id: 'incomplete-run', status: 'canceled', startedAt: 1 } } })), /incomplete/);
});

test('runaway NDJSON allocation is bounded', async () => {
  const response = new Response(' '.repeat(10 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(readDashboardReadinessStream(response), /exceeded the supported size/);
});

test('create and recheck request streamed readiness with the caller signal and reject wrong identities', async (t) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return stream([{ type: 'complete', runId: progress.runId, plan: plan() }]);
  });
  const signal = new AbortController().signal;
  await createDashboardDeploymentPlan(plan().intent, signal);
  await recheckDashboardDeploymentPlan('example-plan', signal);
  assert.equal(calls[0].path, '/api/migration-jobs/deployment-plans?stream=1');
  assert.equal(calls[1].path, '/api/migration-jobs/deployment-plans/example-plan/recheck?stream=1');
  for (const call of calls) { assert.equal(call.init?.signal, signal); assert.equal(call.init?.method, 'POST'); }
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), plan().intent);
  await assert.rejects(recheckDashboardDeploymentPlan('other-plan'), /different deployment plan/);
  await assert.rejects(createDashboardDeploymentPlan({ ...plan().intent, requestId: 'other-request' }), /different dashboard request/);
});
