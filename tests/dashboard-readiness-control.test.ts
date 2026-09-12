import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import type { DashboardReadinessEvent, DashboardReadinessProgressEvent, DashboardReadinessStage } from '../shared/dashboardReadiness';
import { createDashboardReadinessContext, dashboardReadinessStream } from '../server/services/dashboardReadinessControl';

const plan: DashboardDeploymentPlan = { version: 2, id: 'example-plan', revision: 1, createdAt: 1, updatedAt: 1,
  intent: { profile: 'safe_copy_v1', requestId: '11111111-1111-4111-8111-111111111111',
    source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['source-document'] },
    destinations: [{ targetId: 'target', instanceId: 'destination', connectionId: 'target-connection', modelId: 'target-model' }] },
  sourceHashes: {}, sourceModelHashes: {}, targets: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const events = async (response: Response): Promise<DashboardReadinessEvent[]> => (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('readiness progress uses fixed stages and sanitized bounded counters only', () => {
  const progress: DashboardReadinessProgressEvent[] = [];
  const context = createDashboardReadinessContext({ runId: 'example-run', onProgress: (event) => progress.push(event) });
  const { report } = context;
  report('source_models', { completed: 1, total: 2, targetId: 'target' });
  report('comparison', { completed: Number.NaN, total: -1, targetId: 'omni_secret_token' });
  report('secret upstream text' as DashboardReadinessStage, { total: 4 });
  assert.equal(progress.length, 2);
  assert.deepEqual(Object.keys(progress[1]).sort(), ['elapsedMs', 'runId', 'stage', 'type']);
  assert.equal(progress[0].runId, 'example-run');
  context.dispose();
  report('complete');
  assert.equal(progress.length, 2);
  assert.equal(context.signal.aborted, true, 'dispose must stop outstanding sibling reads');
});

test('readiness stream emits progress then one complete plan and cleans up sibling reads', async () => {
  const parent = new AbortController();
  let childSignal: AbortSignal | undefined;
  const response = dashboardReadinessStream(parent.signal, async (context) => {
    childSignal = context.signal;
    context.report('source_models', { completed: 2, total: 2 });
    context.report('comparison', { completed: 1, total: 1, targetId: 'target' });
    context.throwIfAborted();
    return plan;
  }, { runId: 'example-run' });
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const received = await events(response);
  assert.deepEqual(received.map((event) => event.type), ['progress', 'progress', 'progress', 'progress', 'complete']);
  assert.deepEqual(received.at(-1), { type: 'complete', runId: 'example-run', plan });
  assert.equal(childSignal?.aborted, true);
  assert.equal(parent.signal.aborted, false);
});

test('readiness deadline closes a noncooperative load and never accepts its late result', async () => {
  const pending = deferred<DashboardDeploymentPlan>();
  let saved = false;
  const response = dashboardReadinessStream(new AbortController().signal, async (context) => {
    context.report('destination_evidence', { completed: 0, total: 1 });
    const value = await pending.promise;
    context.throwIfAborted();
    saved = true;
    return value;
  }, { deadlineMs: 10 });
  const received = await events(response);
  assert.equal(received.at(-1)?.type, 'error');
  const terminal = received.at(-1);
  if (terminal?.type === 'error') {
    assert.equal(terminal.code, 'DASHBOARD_READINESS_DEADLINE_EXCEEDED');
    assert.equal(terminal.stage, 'destination_evidence');
  }
  pending.resolve(plan);
  await tick();
  assert.equal(saved, false);
  assert.equal(received.filter((event) => event.type === 'complete').length, 0);
});

test('request cancellation and body disconnect abort work and suppress late progress/success', async () => {
  for (const disconnectBody of [false, true]) {
    const parent = new AbortController();
    const pending = deferred<DashboardDeploymentPlan>();
    const started = deferred<AbortSignal>();
    const response = dashboardReadinessStream(parent.signal, async (context) => {
      started.resolve(context.signal);
      const result = await pending.promise;
      context.report('complete');
      context.throwIfAborted();
      return result;
    });
    const signal = await started.promise;
    const reader = response.body!.getReader();
    await reader.read();
    if (disconnectBody) await reader.cancel();
    else {
      parent.abort(new Error('Secret upstream cancellation reason'));
      const terminal = await reader.read();
      const decoded = new TextDecoder().decode(terminal.value);
      assert.ok(decoded.includes('DASHBOARD_READINESS_CANCELED'));
      assert.ok(!decoded.includes('Secret upstream'));
    }
    assert.equal(signal.aborted, true);
    pending.resolve(plan);
    await tick();
    assert.equal((await reader.read()).done, true);
  }
});

test('already canceled requests do not invoke readiness and upstream errors are never streamed verbatim', async () => {
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  const canceled = await events(dashboardReadinessStream(parent.signal, async () => { calls += 1; return plan; }));
  assert.equal(calls, 0);
  assert.equal(canceled[0]?.type, 'error');
  const failed = await events(dashboardReadinessStream(new AbortController().signal, async () => {
    throw new Error('Bearer secret customer-payload');
  }));
  assert.ok(!JSON.stringify(failed).includes('customer-payload'));
  const terminal = failed.at(-1);
  assert.equal(terminal?.type === 'error' && terminal.code, 'DASHBOARD_READINESS_FAILED');
});
