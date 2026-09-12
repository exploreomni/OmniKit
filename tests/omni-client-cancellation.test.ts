import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { acquireOmniRequestSlot, OmniClient, OmniWriteNotDispatchedError, resetOmniClientRateLimitStateForTests, type OmniWriteDispatchGuard } from '../server/services/omniClient';

let sequence = 0;
afterEach(resetOmniClientRateLimitStateForTests);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function client(signal: AbortSignal, fetchImpl: typeof fetch, apiKey = `synthetic-readiness-key-${++sequence}`) {
  return new OmniClient({ baseUrl: 'https://93.184.216.34', label: 'Example workspace', apiKey }, { signal, fetchImpl, maxReadRetries: 3 });
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

for (const operation of ['document', 'yaml'] as const) {
  const write = (api: OmniClient, guard: OmniWriteDispatchGuard) => operation === 'document'
    ? api.createDashboardSafeCopyDocument({ modelId: 'example-model', name: 'Example copy',
      content: { name: 'Example copy', queryPresentations: { data: {}, order: [] }, containers: [] } }, guard)
    : api.updateModelYamlFile({ modelId: 'example-model', fileName: 'example.view', yaml: 'dimensions: {}', previousChecksum: 'example-checksum' }, guard);
  for (const change of ['deadline', 'canceled', 'credential'] as const) {
    test(`guarded write ${operation} cannot dispatch after queued ${change} change`, async (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
      const apiKey = `synthetic-guarded-${operation}-${change}`;
      await Promise.all(Array.from({ length: 55 }, () => acquireOmniRequestSlot(apiKey)));
      const controller = new AbortController();
      const reason = new Error(`Example ${change} authority change`);
      let valid = true;
      let calls = 0;
      const api = new OmniClient({ apiKey, baseUrl: 'https://93.184.216.34', label: 'Example guarded write' }, {
        maxReadRetries: 5, fetchImpl: async () => { calls++; return response({ identifier: 'example-copy' }); },
      });
      const pending = assert.rejects(write(api, { signal: controller.signal, assertCanDispatch() { if (!valid) throw reason; } }), (error) => {
        assert.ok(error instanceof OmniWriteNotDispatchedError);
        assert.equal(error.reason, reason);
        return true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
      if (change === 'deadline') {
        setTimeout(() => controller.abort(reason), 1_000);
        t.mock.timers.tick(1_000);
      } else {
        valid = false;
        t.mock.timers.tick(60_000);
      }
      await pending;
      t.mock.timers.tick(120_000);
      assert.equal(calls, 0, 'a later rollover must not revive a rejected write');
    });
  }
  test(`guarded write ${operation} succeeds when current and never retries an ambiguous dispatched failure`, async () => {
    let calls = 0;
    let checks = 0;
    const guard = { assertCanDispatch() { checks++; } };
    const api = new OmniClient({ apiKey: `synthetic-guarded-positive-${operation}`, baseUrl: 'https://93.184.216.34', label: 'Example guarded write' }, {
      maxReadRetries: 5, fetchImpl: async () => { calls++; return response({ identifier: 'example-copy', modelId: 'example-model',
        queryPresentations: { data: {}, order: [] }, containers: [] }); },
    });
    await write(api, guard);
    assert.equal(checks, 1);
    const successfulCalls = operation === 'document' ? 2 : 1;
    assert.equal(calls, successfulCalls, 'document creation retains its published-state readback');
    const uncertain = new Error('Example response lost after dispatch');
    const failed = new OmniClient({ apiKey: `synthetic-guarded-uncertain-${operation}`, baseUrl: 'https://93.184.216.34', label: 'Example guarded write' }, {
      maxReadRetries: 5, fetchImpl: async () => { calls++; throw uncertain; },
    });
    await assert.rejects(write(failed, guard), (error) => error === uncertain && !(error instanceof OmniWriteNotDispatchedError));
    assert.equal(calls, successfulCalls + 1, 'writes must not inherit read retries');
  });
}

for (const operation of ['branch', 'batch', 'pr', 'merge'] as const) {
  test(`repair policy blocks queued ${operation} writes after authority changes`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const apiKey = `synthetic-repair-policy-${operation}`;
    await Promise.all(Array.from({ length: 55 }, () => acquireOmniRequestSlot(apiKey)));
    let authorized = true;
    let calls = 0;
    const reason = new Error('Example repair authority changed');
    const api = new OmniClient({ apiKey, baseUrl: 'https://93.184.216.34', label: 'Example repair' }, {
      maxReadRetries: 5,
      writeGuard: { assertCanDispatch() { if (!authorized) throw reason; } },
      fetchImpl: async () => { calls++; return response({ id: 'example-branch' }); },
    });
    const write = operation === 'branch'
      ? api.createModelBranch({ connectionId: 'example-connection', baseModelId: 'example-model', branchName: 'example-branch' })
      : operation === 'batch'
        ? api.updateModelYamlFiles({ modelId: 'example-model', branchId: 'example-branch', files: [
          { fileName: 'first.view', yaml: 'dimensions: {}', previousChecksum: 'first-checksum' },
          { fileName: 'second.view', yaml: 'dimensions: {}', previousChecksum: 'second-checksum' },
        ] })
        : operation === 'pr'
          ? api.createOrUpdateModelBranchPullRequest({ modelId: 'example-model', branchId: 'example-branch', commitMessage: 'Example reviewed repair' })
          : api.mergeModelBranch('example-model', 'example-branch', { publishDrafts: false, deleteBranch: false });
    const rejected = assert.rejects(write, (error) => error instanceof OmniWriteNotDispatchedError && error.reason === reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    authorized = false;
    t.mock.timers.tick(60_000);
    await rejected;
    assert.equal(calls, 0, 'neither rollover nor read-retry policy may dispatch a revoked repair');
  });
}

test('repair policy rechecks every file in a batch without replaying a completed write', async () => {
  const calls: string[] = [];
  let authorized = true;
  const api = new OmniClient({ apiKey: 'synthetic-repair-policy-batch-progress', baseUrl: 'https://93.184.216.34', label: 'Example repair' }, {
    maxReadRetries: 5,
    writeGuard: { assertCanDispatch() { if (!authorized) throw new Error('Example repair canceled after first file'); } },
    fetchImpl: async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)).fileName);
      authorized = false;
      return response({});
    },
  });
  await assert.rejects(api.updateModelYamlFiles({ modelId: 'example-model', branchId: 'example-branch', files: [
    { fileName: 'first.view', yaml: 'dimensions: {}' }, { fileName: 'second.view', yaml: 'dimensions: {}' },
  ] }), OmniWriteNotDispatchedError);
  assert.deepEqual(calls, ['first.view'], 'the first write remains committed; only the second request was prevented');
});

test('repair policy composes with a per-call guard instead of allowing it to replace policy', async () => {
  const checked: string[] = [];
  let authorized = true;
  let calls = 0;
  const api = new OmniClient({ apiKey: 'synthetic-repair-policy-composition', baseUrl: 'https://93.184.216.34', label: 'Example repair' }, {
    writeGuard: { assertCanDispatch() { checked.push('policy'); if (!authorized) throw new Error('Example policy revoked'); } },
    fetchImpl: async () => { calls++; return response({}); },
  });
  const file = { modelId: 'example-model', fileName: 'example.view', yaml: 'dimensions: {}' };
  await api.updateModelYamlFile(file, { assertCanDispatch() { checked.push('call'); } });
  assert.deepEqual(checked, ['policy', 'call']);
  authorized = false;
  await assert.rejects(api.updateModelYamlFile(file, { assertCanDispatch() { checked.push('replacement'); } }), OmniWriteNotDispatchedError);
  assert.equal(calls, 1);
  assert.deepEqual(checked, ['policy', 'call', 'policy']);
});

for (const owner of ['policy', 'call'] as const) {
  test(`repair policy composes ${owner} cancellation with the other guard signal`, async () => {
    const apiKey = `synthetic-repair-policy-signal-${owner}`;
    await Promise.all(Array.from({ length: 55 }, () => acquireOmniRequestSlot(apiKey)));
    const policy = new AbortController();
    const call = new AbortController();
    const reason = new Error(`Example ${owner} canceled`);
    let calls = 0;
    const api = new OmniClient({ apiKey, baseUrl: 'https://93.184.216.34', label: 'Example repair' }, {
      writeGuard: { signal: policy.signal, assertCanDispatch() {} },
      fetchImpl: async () => { calls++; return response({}); },
    });
    const pending = assert.rejects(api.updateModelYamlFile({ modelId: 'example-model', fileName: 'example.view', yaml: 'dimensions: {}' }, {
      signal: call.signal, assertCanDispatch() {},
    }), (error) => error instanceof OmniWriteNotDispatchedError && error.reason === reason);
    (owner === 'policy' ? policy : call).abort(reason);
    await pending;
    assert.equal(calls, 0);
  });
}

test('default cancellation rejects before any request dispatch and while waiting for response headers', async () => {
  const preCanceled = new AbortController();
  preCanceled.abort(new Error('Readiness canceled'));
  let calls = 0;
  await assert.rejects(client(preCanceled.signal, async () => { calls += 1; return response({}); }).getModelYaml('model'), /Readiness canceled/);
  assert.equal(calls, 0);
  const parent = new AbortController();
  const started = deferred<void>();
  const never = deferred<Response>();
  const pending = client(parent.signal, async () => { started.resolve(); return never.promise; }).getModelYaml('model');
  await started.promise;
  parent.abort(new Error('Header wait canceled'));
  await assert.rejects(pending, /Header wait canceled/);
  never.resolve(response({ files: {} }));
});

for (const method of ['model', 'optional-json', 'document'] as const) {
  test(`default cancellation stops a hanging ${method} response body even if fetch ignores abort`, async () => {
    const parent = new AbortController();
    const started = deferred<void>();
    let bodyCanceled = false;
    let calls = 0;
    const api = client(parent.signal, async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); started.resolve(); },
        cancel() { bodyCanceled = true; },
      }));
    });
    const pending = method === 'model' ? api.getModelYaml('model') : method === 'optional-json'
      ? api.listModelTopicSummaries('model') : api.getDocumentStateV2('document');
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    parent.abort(new Error('Body wait canceled'));
    await assert.rejects(pending, /Body wait canceled/);
    assert.equal(bodyCanceled, true);
    assert.equal(calls, 1, 'body cancellation must not become a read retry');
  });
}

test('default cancellation stops Retry-After waiting without a second fetch', async () => {
  const parent = new AbortController();
  const waiting = deferred<void>();
  let calls = 0;
  const api = client(parent.signal, async () => {
    calls += 1;
    return new Response(new ReadableStream({ cancel() { waiting.resolve(); } }), { status: 429, headers: { 'retry-after': '86400' } });
  });
  const pending = api.getModelYaml('model');
  await waiting.promise;
  parent.abort(new Error('Retry canceled'));
  await assert.rejects(pending, /Retry canceled/);
  assert.equal(calls, 1);
});

test('default cancellation exits rate-limit slot waiting without dispatch', async () => {
  const parent = new AbortController();
  const apiKey = 'synthetic-saturated-readiness-key';
  for (let count = 0; count < 55; count += 1) await acquireOmniRequestSlot(apiKey);
  let calls = 0;
  const pending = client(parent.signal, async () => { calls += 1; return response({ files: {} }); }, apiKey).getModelYaml('model');
  parent.abort(new Error('Slot wait canceled'));
  await assert.rejects(pending, /Slot wait canceled/);
  assert.equal(calls, 0);
});

test('default cancellation stops pagination and prevents a terminal page from becoming a completed catalog', async () => {
  for (const hasNextPage of [true, false]) {
    const parent = new AbortController();
    let calls = 0;
    const api = client(parent.signal, async () => {
      calls += 1;
      return response({ records: [{ id: 'document-a', identifier: 'document-a', name: 'Source dashboard' }],
        pageInfo: { totalRecords: hasNextPage ? 2 : 1, pageSize: 100, hasNextPage, nextCursor: hasNextPage ? 'page-two' : null } });
    });
    await assert.rejects(api.listDocumentInventory({ onProgress() { parent.abort(new Error('Pagination canceled')); } }), /Pagination canceled/);
    assert.equal(calls, 1);
  }
});
