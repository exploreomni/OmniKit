import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSemanticStudioRepairPrompt,
  reconcileSemanticStudioPostWriteFileScope,
  reconcileSemanticStudioRegeneratedPackage,
  reconcileSemanticStudioReviewedFileScope,
  resolveSemanticStudioTopicWriteIntent,
  sanitizeSemanticStudioRepairEvidence,
  semanticStudioTopicNameFromFileName,
  semanticStudioReviewedBranchSessionIssues,
  semanticStudioRepairIssueScope,
  validateSemanticStudioRepairFileSet,
  validateSemanticStudioReviewedPackageFileSet,
} from '../src/services/semanticStudioRepair';
import {
  buildSemanticStudioContextPackage,
  semanticStudioUnexpectedBranchChanges,
} from '../src/services/semanticStudioContext';
import {
  applyStudioConnectionNames,
  createSemanticStudioOperationCoordinator,
  createTopicsInventoryRequestCoordinator,
  loadStudioModelInventory,
  parseStudioConnectionNamesResponse,
  parseTopicInventoryResponse,
  STUDIO_MODEL_KINDS,
  type TopicsInventoryRequestToken,
  type TopicsInventoryResource,
} from '../src/services/topicsRequestState';
import { listModels } from '../src/services/omniApi';

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function verifiedStudioModels<T extends { id: string; kind?: string }>(models: readonly T[]) {
  return {
    models,
    pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: models.length },
    pagesFetched: 1,
    complete: true,
    loadedResults: models.length,
    totalResults: models.length,
  } as const;
}

test('topic inventory parser preserves verified records and rejects malformed success as zero', () => {
  assert.deepEqual(parseTopicInventoryResponse({
    topics: [{ name: 'orders', label: 'Orders', description: 'Governed orders' }],
  }), [{ name: 'orders', label: 'Orders', description: 'Governed orders' }]);
  assert.deepEqual(parseTopicInventoryResponse({ topics: [] }), []);

  const invalid = [
    {},
    { error: '', topics: [] },
    { errors: null, topics: [] },
    { topics: null },
    { topics: [{}] },
    { topics: [{ name: ' orders' }] },
    { topics: [{ name: 'orders' }, { name: 'orders' }] },
    { topics: [{ name: 'orders', label: { unsafe: true } }] },
  ];
  for (const payload of invalid) {
    assert.throws(() => parseTopicInventoryResponse(payload), /Topic inventory response was invalid/);
  }
});

test('Semantic Studio loads only complete governed model-kind inventories', async () => {
  const calls: string[] = [];
  const records = {
    SHARED: [{ id: 'shared-model', kind: 'SHARED', name: 'Shared model' }],
    SHARED_EXTENSION: [{ id: 'extension-model', kind: 'SHARED_EXTENSION', name: 'Extension model' }],
    BRANCH: [{ id: 'branch-model', kind: 'BRANCH', name: 'Branch model' }],
  } as const;

  const inventory = await loadStudioModelInventory(async (kind) => {
    calls.push(kind);
    return {
      models: records[kind],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: records[kind].length },
      pagesFetched: 1,
      complete: true,
      loadedResults: records[kind].length,
      totalResults: records[kind].length,
    };
  });
  assert.deepEqual(calls, [...STUDIO_MODEL_KINDS]);
  assert.deepEqual(
    inventory.map((model) => [model.id, model.kind]),
    [
      ['shared-model', 'SHARED'],
      ['extension-model', 'SHARED_EXTENSION'],
      ['branch-model', 'BRANCH'],
    ],
  );

  await assert.rejects(
    () => loadStudioModelInventory(async (kind) => (
      verifiedStudioModels(kind === 'SHARED' ? [{ id: 'wrong-kind', kind: 'QUERY' }] : [])
    )),
    /Studio model inventory response was invalid/,
  );
  await assert.rejects(
    () => loadStudioModelInventory(async (kind) => (
      verifiedStudioModels(kind === 'SHARED'
        ? [{ id: 'duplicate-model', kind }]
        : kind === 'BRANCH'
          ? [{ id: 'duplicate-model', kind }]
          : [])
    )),
    /Studio model inventory response was invalid/,
  );
  await assert.rejects(
    () => loadStudioModelInventory(async (kind) => (
      verifiedStudioModels(kind === 'SHARED' ? [{ id: ' padded-model ', kind }] : [])
    )),
    /Studio model inventory response was invalid/,
  );
  await assert.rejects(
    () => loadStudioModelInventory(async (kind) => ({
      ...verifiedStudioModels(kind === 'SHARED' ? [{ id: 'partial-model', kind }] : []),
      complete: false,
      loadedResults: kind === 'SHARED' ? 1 : 0,
      totalResults: kind === 'SHARED' ? 2 : 0,
      ...(kind === 'SHARED' ? { reasonCode: 'PAGINATION_SAFETY_LIMIT_REACHED' } : {}),
    })),
    /Studio model inventory response was invalid/,
  );
  await assert.rejects(
    () => loadStudioModelInventory(async (kind) => ({
      ...verifiedStudioModels(kind === 'SHARED' ? [{ id: 'count-mismatch', kind }] : []),
      loadedResults: kind === 'SHARED' ? 1 : 0,
      totalResults: kind === 'SHARED' ? 2 : 0,
    })),
    /Studio model inventory response was invalid/,
  );
});

test('post-refresh model loads never join a pre-invalidation request or cache its stale result', async (t) => {
  const queuedRequests: Array<{
    response: ReturnType<typeof deferred<Response>>;
    started: ReturnType<typeof deferred<void>>;
  }> = [];
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    const request = queuedRequests.shift();
    assert.ok(request, `Unexpected model inventory fetch ${fetchCalls}`);
    request.started.resolve();
    return request.response.promise;
  });

  const options = { modelKind: 'SHARED', allPages: true, pageSize: 100 } as const;
  const responseFor = (id: string) => new Response(JSON.stringify(verifiedStudioModels([
    { id, kind: 'SHARED', name: id },
  ])), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  for (const completionOrder of ['stale-first', 'fresh-first'] as const) {
    const staleRequest = { response: deferred<Response>(), started: deferred<void>() };
    const freshRequest = { response: deferred<Response>(), started: deferred<void>() };
    queuedRequests.push(staleRequest, freshRequest);
    const baseUrl = `https://metadata-cache-${completionOrder}.example`;
    const apiKey = `cache-generation-${completionOrder}`;
    const callCountBeforeScenario = fetchCalls;

    const staleLoad = listModels(baseUrl, apiKey, options);
    await staleRequest.started.promise;
    const forcedLoad = listModels(baseUrl, apiKey, { ...options, forceRefresh: true });
    await freshRequest.started.promise;
    const postRefreshNormalLoad = listModels(baseUrl, apiKey, options);
    assert.equal(fetchCalls, callCountBeforeScenario + 2, 'the post-refresh normal load must join current-generation work');

    if (completionOrder === 'stale-first') {
      staleRequest.response.resolve(responseFor(`${completionOrder}-stale`));
      assert.equal((await staleLoad).models[0]?.id, `${completionOrder}-stale`);
      freshRequest.response.resolve(responseFor(`${completionOrder}-fresh`));
    } else {
      freshRequest.response.resolve(responseFor(`${completionOrder}-fresh`));
      staleRequest.response.resolve(responseFor(`${completionOrder}-stale`));
    }

    assert.equal((await forcedLoad).models[0]?.id, `${completionOrder}-fresh`);
    assert.equal((await postRefreshNormalLoad).models[0]?.id, `${completionOrder}-fresh`);
    assert.equal((await staleLoad).models[0]?.id, `${completionOrder}-stale`);
    assert.equal((await listModels(baseUrl, apiKey, options)).models[0]?.id, `${completionOrder}-fresh`);
  }

  assert.equal(fetchCalls, 4);
  assert.equal(queuedRequests.length, 0);
});

test('Semantic Studio resolves model groups to verified connection names', () => {
  const connections = parseStudioConnectionNamesResponse({
    connections: [
      { id: 'connection-a', name: 'Primary warehouse' },
      { id: 'connection-b', name: 'Verified replacement', dialect: null },
    ],
  });
  const models = applyStudioConnectionNames(
    [
      { id: 'model-a', kind: 'SHARED', connectionId: 'connection-a' },
      { id: 'model-b', kind: 'SHARED', connectionId: 'connection-b', connectionName: 'Existing name' },
      { id: 'model-c', kind: 'SHARED', connectionId: 'connection-c' },
      { id: 'model-d', kind: 'SHARED', connectionId: 'connection-d', connectionName: 'Unverified name' },
    ],
    connections,
  );

  assert.equal(models[0].connectionName, 'Primary warehouse');
  assert.equal(models[1].connectionName, 'Verified replacement');
  assert.equal(models[2].connectionName, undefined);
  assert.equal(models[3].connectionName, undefined);

  for (const invalid of [
    {},
    { error: '', connections: [] },
    { errors: null, connections: [] },
    { connections: null },
    { connections: [{}] },
    { connections: [{ id: ' padded ', name: 'Warehouse' }] },
    { connections: [{ id: 'connection-a', name: '' }] },
    { connections: [
      { id: 'connection-a', name: 'Warehouse A' },
      { id: 'connection-a', name: 'Warehouse B' },
    ] },
  ]) {
    assert.throws(
      () => parseStudioConnectionNamesResponse(invalid),
      /Studio connection inventory response was invalid/,
    );
  }
});

async function applyInventoryResult<T>(
  coordinator: ReturnType<typeof createTopicsInventoryRequestCoordinator>,
  token: TopicsInventoryRequestToken,
  resource: TopicsInventoryResource,
  promise: Promise<T>,
  applied: T[],
) {
  try {
    const value = await promise;
    if (!coordinator.isCurrent(token)) return;
    applied.push(value);
    coordinator.settle(token, resource, 'succeeded');
  } catch {
    if (!coordinator.isCurrent(token)) return;
    coordinator.settle(token, resource, 'failed');
  }
}

test('Semantic Studio clears loading synchronously and ignores a completion after scope clear', async () => {
  const states: Array<{ phase: string; topics: string; modelFiles: string }> = [];
  const coordinator = createTopicsInventoryRequestCoordinator((state) => states.push(state));
  const pending = deferred<string>();
  const applied: string[] = [];
  const token = coordinator.begin('connection-a:model-a:topic', ['topics', 'modelFiles']);
  assert.ok(token);
  const completion = applyInventoryResult(coordinator, token, 'topics', pending.promise, applied);

  coordinator.clear();
  assert.deepEqual(coordinator.snapshot(), {
    scopeKey: '',
    phase: 'idle',
    topics: 'idle',
    modelFiles: 'idle',
  });
  assert.equal(states.at(-1)?.phase, 'idle');

  pending.resolve('stale topics');
  await completion;
  assert.deepEqual(applied, []);
  assert.equal(coordinator.snapshot().phase, 'idle');
});

test('Semantic Studio connection switching invalidates old tenant results', async () => {
  const coordinator = createTopicsInventoryRequestCoordinator();
  const oldPending = deferred<string>();
  const newPending = deferred<string>();
  const applied: string[] = [];
  const oldToken = coordinator.begin('connection-a:model-a:topic', ['topics']);
  assert.ok(oldToken);
  const oldCompletion = applyInventoryResult(coordinator, oldToken, 'topics', oldPending.promise, applied);

  const newToken = coordinator.begin('connection-b:model-a:topic', ['topics']);
  assert.ok(newToken);
  const newCompletion = applyInventoryResult(coordinator, newToken, 'topics', newPending.promise, applied);

  oldPending.resolve('old tenant');
  newPending.resolve('new tenant');
  await Promise.all([oldCompletion, newCompletion]);
  assert.deepEqual(applied, ['new tenant']);
  assert.equal(coordinator.snapshot().scopeKey, 'connection-b:model-a:topic');
  assert.equal(coordinator.snapshot().phase, 'healthy');
});

test('Semantic Studio operation tokens reject stale A to B to A completions', () => {
  const coordinator = createSemanticStudioOperationCoordinator();
  const original = coordinator.begin('apply', 'connection-a', 'model-a');
  assert.equal(coordinator.owns(original), true);
  coordinator.invalidate();
  assert.equal(coordinator.owns(original), false);

  const tenantB = coordinator.begin('apply', 'connection-b', 'model-a');
  assert.equal(coordinator.owns(tenantB), true);
  const returnedTenantA = coordinator.begin('apply', 'connection-a', 'model-a');
  assert.equal(coordinator.owns(original), false);
  assert.equal(coordinator.owns(tenantB), false);
  assert.equal(coordinator.owns(returnedTenantA), true);
  assert.equal(coordinator.settle(original), false);
  assert.equal(coordinator.settle(returnedTenantA), true);
  assert.equal(coordinator.owns(returnedTenantA), false);

  const discard = coordinator.begin('discard', 'connection-a', 'model-a');
  assert.equal(coordinator.owns(discard), true);
  coordinator.invalidate();
  assert.equal(coordinator.owns(discard), false);
  assert.equal(coordinator.settle(discard), false);
});

test('Semantic Studio accepts only the current model completion when requests finish out of order', async () => {
  const coordinator = createTopicsInventoryRequestCoordinator();
  const firstPending = deferred<string>();
  const secondPending = deferred<string>();
  const applied: string[] = [];
  const firstToken = coordinator.begin('connection-a:model-a:topic', ['modelFiles']);
  assert.ok(firstToken);
  const firstCompletion = applyInventoryResult(coordinator, firstToken, 'modelFiles', firstPending.promise, applied);
  const secondToken = coordinator.begin('connection-a:model-b:topic', ['modelFiles']);
  assert.ok(secondToken);
  const secondCompletion = applyInventoryResult(coordinator, secondToken, 'modelFiles', secondPending.promise, applied);

  secondPending.resolve('model b');
  await secondCompletion;
  firstPending.resolve('model a');
  await firstCompletion;
  assert.deepEqual(applied, ['model b']);
  assert.equal(coordinator.snapshot().phase, 'healthy');
});

test('Semantic Studio allows retry after transient failure and suppresses healthy duplicates', async () => {
  const coordinator = createTopicsInventoryRequestCoordinator();
  const failedPending = deferred<string>();
  const applied: string[] = [];
  const scopeKey = 'connection-a:model-a:topic';
  const firstToken = coordinator.begin(scopeKey, ['topics']);
  assert.ok(firstToken);
  assert.equal(coordinator.begin(scopeKey, ['topics']), null, 'in-flight duplicate must be suppressed');
  const failedCompletion = applyInventoryResult(coordinator, firstToken, 'topics', failedPending.promise, applied);
  failedPending.reject(new Error('temporary upstream failure'));
  await failedCompletion;
  assert.equal(coordinator.snapshot().phase, 'failed');

  const retryToken = coordinator.begin(scopeKey, ['topics']);
  assert.ok(retryToken, 'failed scope must be retryable');
  const retryPending = deferred<string>();
  const retryCompletion = applyInventoryResult(coordinator, retryToken, 'topics', retryPending.promise, applied);
  retryPending.resolve('recovered topics');
  await retryCompletion;
  assert.deepEqual(applied, ['recovered topics']);
  assert.equal(coordinator.snapshot().phase, 'healthy');
  assert.equal(coordinator.begin(scopeKey, ['topics']), null, 'healthy duplicate must be suppressed');
});

test('Blobby repair prompts are bounded to reviewed files and sanitize validation evidence', () => {
  const files = [{ fileName: 'views/orders.view', yaml: 'schema: analytics\nname: orders\n' }];
  assert.equal(semanticStudioRepairIssueScope({
    source: 'model',
    yamlPath: 'views/orders.view.dimensions.total_sales',
    message: 'Invalid field',
  }, files), 'current_package');
  assert.equal(semanticStudioRepairIssueScope({
    source: 'model',
    yamlPath: 'views/customers.view.dimensions.email',
    message: 'Invalid field',
  }, files), 'outside_package');
  assert.equal(semanticStudioRepairIssueScope({ source: 'content', message: 'Query failed' }, files), 'unknown');

  const request = buildSemanticStudioRepairPrompt({
    workflowPath: 'model',
    modelName: 'Example model',
    branchName: 'omnikit/example',
    files,
    issues: [
      {
        source: 'model',
        yamlPath: 'views/orders.view.dimensions.total_sales',
        message: 'Authorization: Bearer sk-live-example and api_key="not-for-the-model"',
      },
      { source: 'model', yamlPath: 'views/customers.view', message: 'Outside reviewed scope' },
      { source: 'content', message: 'A dashboard query still needs review' },
    ],
  });

  assert.equal(request.currentPackageIssueCount, 1);
  assert.equal(request.outsidePackageIssueCount, 1);
  assert.equal(request.unknownScopeIssueCount, 1);
  assert.match(request.prompt, /complete replacement YAML for every allowed target file/i);
  assert.match(request.prompt, /Do not create or modify a branch, call write APIs, merge, publish/i);
  assert.match(request.prompt, /views\/orders\.view/);
  assert.match(request.prompt, /Authorization: \[redacted\]/);
  assert.match(request.prompt, /api_key=.*\[redacted\]/);
  assert.doesNotMatch(request.prompt, /sk-live-example|not-for-the-model/);
  assert.equal(
    sanitizeSemanticStudioRepairEvidence('password: hunter2'),
    'password: [redacted]',
  );
});

test('Blobby repair rejects scope expansion, incomplete responses, and secret-bearing YAML', () => {
  const fileSetIssues = validateSemanticStudioRepairFileSet(
    ['model', 'views/orders.view'],
    ['model', 'views/customers.view', 'views/customers.view'],
  );
  assert.match(fileSetIssues.join('\n'), /duplicate target files/i);
  assert.match(fileSetIssues.join('\n'), /did not return complete replacement YAML.*views\/orders\.view/i);
  assert.match(fileSetIssues.join('\n'), /attempted to expand.*views\/customers\.view/i);
  assert.match(validateSemanticStudioRepairFileSet(
    ['views/orders.view'],
    ['/views/orders.view'],
  ).join('\n'), /unsafe file paths/i);

  assert.throws(() => buildSemanticStudioRepairPrompt({
    workflowPath: 'model',
    modelName: 'Example model',
    branchName: 'omnikit/example',
    files: [{ fileName: '../orders.view', yaml: 'schema: analytics\n' }],
    issues: [{ source: 'model', message: 'Invalid field' }],
  }), /safe relative file names/i);
  assert.throws(() => buildSemanticStudioRepairPrompt({
    workflowPath: 'model',
    modelName: 'Example model',
    branchName: 'omnikit/example',
    files: [{ fileName: 'orders.view', yaml: 'schema: analytics\napi_key: secret-value\n' }],
    issues: [{ source: 'model', message: 'Invalid field' }],
  }), /secret-shaped content/i);
});

test('reviewed topic leaves reconcile only to unique Omni-authoritative canonical paths', () => {
  assert.deepEqual(reconcileSemanticStudioReviewedFileScope(
    ['model', 'relationships', 'regional_sales.topic'],
    ['model', 'relationships', 'Sales/regional_sales.topic'],
    ['Sales/regional_sales.topic'],
  ), {
    fileNames: ['model', 'relationships', 'Sales/regional_sales.topic'],
    issues: [],
  });

  assert.match(reconcileSemanticStudioReviewedFileScope(
    ['regional_sales.topic'],
    ['Sales/regional_sales.topic'],
    [],
  ).issues.join('\n'), /no unique Omni-resolved canonical path/i);
  assert.match(reconcileSemanticStudioReviewedFileScope(
    ['regional_sales.topic'],
    ['Sales/regional_sales.topic', 'Finance/regional_sales.topic'],
    ['Sales/regional_sales.topic', 'Finance/regional_sales.topic'],
  ).issues.join('\n'), /multiple authoritative paths matched/i);
  assert.match(reconcileSemanticStudioReviewedFileScope(
    ['Regional_sales.topic'],
    ['Sales/regional_sales.topic'],
    ['Sales/regional_sales.topic'],
  ).issues.join('\n'), /could not be reconciled/i);
  assert.match(reconcileSemanticStudioReviewedFileScope(
    ['Legacy/regional_sales.topic'],
    ['Sales/regional_sales.topic'],
    ['Sales/regional_sales.topic'],
  ).issues.join('\n'), /no longer contains the reviewed target/i);
  assert.match(reconcileSemanticStudioReviewedFileScope(
    ['model'],
    ['Food Service/model'],
    ['Food Service/model'],
  ).issues.join('\n'), /no longer contains the reviewed target/i);
});

test('immutable package validation uses neutral staged-file errors', () => {
  const issues = validateSemanticStudioReviewedPackageFileSet(
    ['model', 'Sales/regional_sales.topic'],
    ['model', 'Finance/regional_sales.topic'],
  ).join('\n');
  assert.match(issues, /missing reviewed target files.*Sales\/regional_sales\.topic/i);
  assert.match(issues, /outside the immutable reviewed scope.*Finance\/regional_sales\.topic/i);
  assert.doesNotMatch(issues, /Blobby/i);
});

test('a create retry accepts only the exact canonical topic path returned on the reviewed branch', () => {
  const reviewedFileNames = ['model', 'subway_analytics.topic'];
  const stagedFiles = [
    { fileName: 'model', yaml: 'access_grants: {}\n' },
    { fileName: 'Store Analytics/subway_analytics.topic', yaml: 'base_view: orders\n' },
  ];

  assert.deepEqual(reconcileSemanticStudioPostWriteFileScope({
    operation: 'create_new',
    reviewedFileNames,
    stagedFiles,
    branchFiles: {
      model: 'access_grants: {}\n',
      'Store Analytics/subway_analytics.topic': 'base_view: orders\n',
    },
  }), {
    fileNames: ['model', 'Store Analytics/subway_analytics.topic'],
    issues: [],
  });

  assert.match(reconcileSemanticStudioPostWriteFileScope({
    operation: 'create_new',
    reviewedFileNames,
    stagedFiles,
    branchFiles: {
      model: 'access_grants: {}\n',
      'Finance/subway_analytics.topic': 'base_view: orders\n',
    },
  }).issues.join('\n'), /missing reviewed target files/i);
  assert.match(reconcileSemanticStudioPostWriteFileScope({
    operation: 'create_new',
    reviewedFileNames,
    stagedFiles,
    branchFiles: {
      model: 'access_grants: {}\n',
      'Store Analytics/subway_analytics.topic': 'base_view: customers\n',
    },
  }).issues.join('\n'), /missing reviewed target files/i);
  assert.match(reconcileSemanticStudioPostWriteFileScope({
    operation: 'update_existing',
    reviewedFileNames,
    stagedFiles,
    branchFiles: {
      model: 'access_grants: {}\n',
      'Store Analytics/subway_analytics.topic': 'base_view: orders\n',
    },
  }).issues.join('\n'), /missing reviewed target files/i);
});

test('a validated resave keeps changed YAML on the exact canonical reviewed branch path', () => {
  const mainYaml = {
    files: {
      'coffee_training.analytics_marts/fact_order_items.view': 'dimensions: {}\n',
      relationships: '[]\n',
    },
    checksums: {},
    viewNames: {},
  };
  const branchYaml = {
    files: {
      'coffee_training.analytics_marts/fact_order_items.view': 'dimensions: {}\nmeasures:\n  total_sales: {}\n',
      relationships: '- join_from_view: fact_order_items\n  join_to_view: dim_store\n',
      'Omni Training/coffee_shop_revenue.topic': 'base_view: fact_order_items\ndescription: Original audience\n',
    },
    checksums: {},
    viewNames: {},
  };
  const context = buildSemanticStudioContextPackage({
    workflowPath: 'topic',
    operation: 'create_new',
    modelId: 'coffee-model',
    modelName: 'Coffee Shop Demo',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    topicName: 'coffee_shop_revenue',
    editableFiles: Object.entries(branchYaml.files).map(([fileName, yaml]) => ({ fileName, yaml })),
    mainYaml,
    branchYaml,
  });
  const session = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'topic' as const,
    operation: 'create_new' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    canonicalTopicFileName: 'Omni Training/coffee_shop_revenue.topic',
  };
  const current = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'topic' as const,
    operation: 'create_new' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    handoffLocked: false,
  };
  const regeneratedFiles = [
    {
      id: 'topic-file',
      fileName: 'coffee_shop_revenue.topic',
      yaml: 'base_view: fact_order_items\ndescription: Updated audience\n',
    },
    {
      id: 'view-file',
      fileName: 'coffee_training.analytics_marts/fact_order_items.view',
      yaml: 'dimensions: {}\nmeasures:\n  total_sales: {}\n',
    },
    {
      id: 'relationships-file',
      fileName: 'relationships',
      yaml: '- join_from_view: fact_order_items\n  join_to_view: dim_store\n',
    },
  ];

  assert.deepEqual(semanticStudioReviewedBranchSessionIssues({
    session,
    context,
    current: { ...current, branchYamlLoaded: true },
  }), []);
  const resolution = reconcileSemanticStudioRegeneratedPackage({
    session,
    context,
    current,
    branchFiles: branchYaml.files,
    files: regeneratedFiles,
  });
  assert.deepEqual(resolution.issues, []);
  assert.equal(resolution.canonicalTopicFileName, 'Omni Training/coffee_shop_revenue.topic');
  assert.equal(resolution.files[0].fileName, 'Omni Training/coffee_shop_revenue.topic');
  assert.match(resolution.files[0].yaml, /Updated audience/);
  assert.deepEqual(semanticStudioUnexpectedBranchChanges(
    mainYaml,
    branchYaml,
    resolution.files.map((file) => file.fileName),
  ), []);
});

test('reviewed branch reuse fails closed across handoff, tenant, model, scope, and ambiguous paths', () => {
  const branchFiles = {
    'Omni Training/coffee_shop_revenue.topic': 'base_view: fact_order_items\n',
    relationships: '[]\n',
  };
  const context = buildSemanticStudioContextPackage({
    workflowPath: 'topic',
    operation: 'create_new',
    modelId: 'coffee-model',
    modelName: 'Coffee Shop Demo',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    topicName: 'coffee_shop_revenue',
    editableFiles: Object.entries(branchFiles).map(([fileName, yaml]) => ({ fileName, yaml })),
    mainYaml: { files: { relationships: '[]\n' }, checksums: {}, viewNames: {} },
    branchYaml: { files: branchFiles, checksums: {}, viewNames: {} },
  });
  const session = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'topic' as const,
    operation: 'create_new' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    canonicalTopicFileName: 'Omni Training/coffee_shop_revenue.topic',
  };
  const current = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'topic' as const,
    operation: 'create_new' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    branchYamlLoaded: true,
    handoffLocked: false,
  };

  assert.match(semanticStudioReviewedBranchSessionIssues({
    session,
    context,
    current: { ...current, handoffLocked: true },
  }).join('\n'), /handoff is locked/i);
  assert.match(semanticStudioReviewedBranchSessionIssues({
    session,
    context,
    current: { ...current, connectionKey: 'tenant-b' },
  }).join('\n'), /different active connection/i);
  assert.match(semanticStudioReviewedBranchSessionIssues({
    session,
    context,
    current: { ...current, modelId: 'other-model' },
  }).join('\n'), /different model/i);
  assert.match(semanticStudioReviewedBranchSessionIssues({
    session,
    context,
    current: { ...current, operation: 'update_existing' },
  }).join('\n'), /different topic operation/i);
  assert.match(semanticStudioReviewedBranchSessionIssues({
    session,
    context,
    current: { ...current, topicName: 'another_topic' },
  }).join('\n'), /different logical topic/i);

  const generatedFiles = [
    { fileName: 'coffee_shop_revenue.topic', yaml: 'base_view: fact_order_items\n' },
    { fileName: 'relationships', yaml: '[]\n' },
  ];
  assert.match(reconcileSemanticStudioRegeneratedPackage({
    session,
    context,
    current: {
      connectionKey: current.connectionKey,
      modelId: current.modelId,
      connectionId: current.connectionId,
      workflowPath: current.workflowPath,
      operation: current.operation,
      topicName: current.topicName,
      branchId: current.branchId,
      branchName: current.branchName,
      handoffLocked: false,
    },
    branchFiles: {
      ...branchFiles,
      'Other/coffee_shop_revenue.topic': 'base_view: fact_order_items\n',
    },
    files: generatedFiles,
  }).issues.join('\n'), /one exact reviewed branch path/i);
  assert.match(reconcileSemanticStudioRegeneratedPackage({
    session,
    context,
    current: {
      connectionKey: current.connectionKey,
      modelId: current.modelId,
      connectionId: current.connectionId,
      workflowPath: current.workflowPath,
      operation: current.operation,
      topicName: current.topicName,
      branchId: current.branchId,
      branchName: current.branchName,
      handoffLocked: false,
    },
    branchFiles,
    files: [...generatedFiles, { fileName: 'extra.view', yaml: 'dimensions: {}\n' }],
  }).issues.join('\n'), /outside the immutable reviewed scope/i);
});

test('canonical create-new resave updates the reviewed authored topic instead of recreating it', () => {
  const canonicalTopicFileName = 'Omni Training/coffee_shop_revenue.topic';
  const branchFiles = {
    [canonicalTopicFileName]: 'base_view: fact_order_items\ndescription: First save\n',
  };
  const topicName = semanticStudioTopicNameFromFileName(canonicalTopicFileName);
  assert.equal(topicName, 'coffee_shop_revenue');
  const context = buildSemanticStudioContextPackage({
    workflowPath: 'topic',
    operation: 'create_new',
    modelId: 'coffee-model',
    modelName: 'Coffee Shop Demo',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    topicName,
    editableFiles: [{
      fileName: canonicalTopicFileName,
      yaml: branchFiles[canonicalTopicFileName],
    }],
    mainYaml: { files: {}, checksums: {}, viewNames: {} },
    branchYaml: { files: branchFiles, checksums: {}, viewNames: {} },
  });
  const intent = resolveSemanticStudioTopicWriteIntent({
    operation: 'create_new',
    stagedTopic: {
      fileName: canonicalTopicFileName,
      yaml: 'base_view: fact_order_items\ndescription: Second save\n',
    },
    branchFiles,
    reviewedContext: context,
  });

  assert.deepEqual(intent.issues, []);
  assert.equal(intent.topicName, 'coffee_shop_revenue');
  assert.equal(intent.action, 'update');
  assert.equal(intent.authoredTopic?.fileName, canonicalTopicFileName);
  assert.equal(Boolean(intent.authoredTopic), true);
});

test('advanced Topic Builder regeneration stays on the reviewed branch and canonical topic path', () => {
  const canonicalTopicFileName = 'Omni Training/coffee_shop_revenue.topic';
  const mainYaml = { files: { model: 'name: coffee_shop\n' }, checksums: {}, viewNames: {} };
  const branchYaml = {
    files: {
      ...mainYaml.files,
      [canonicalTopicFileName]: 'base_view: fact_order_items\ndescription: First save\n',
    },
    checksums: {},
    viewNames: {},
  };
  const context = buildSemanticStudioContextPackage({
    workflowPath: 'topic',
    operation: 'create_new',
    modelId: 'coffee-model',
    modelName: 'Coffee Shop Demo',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    topicName: 'coffee_shop_revenue',
    editableFiles: [{
      fileName: canonicalTopicFileName,
      yaml: branchYaml.files[canonicalTopicFileName],
    }],
    mainYaml,
    branchYaml,
  });
  const session = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'topic' as const,
    operation: 'create_new' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    canonicalTopicFileName,
  };
  const current = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'topic' as const,
    operation: 'create_new' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    handoffLocked: false,
  };
  const regenerated = reconcileSemanticStudioRegeneratedPackage({
    session,
    context,
    current,
    branchFiles: branchYaml.files,
    files: [{
      id: 'advanced-topic',
      fileName: 'coffee_shop_revenue.topic',
      yaml: 'base_view: fact_order_items\ndescription: Second save\n',
    }],
  });

  assert.deepEqual(regenerated.issues, []);
  assert.equal(regenerated.files.length, 1);
  assert.equal(regenerated.files[0].fileName, canonicalTopicFileName);
  assert.match(regenerated.files[0].yaml, /Second save/);
  const regeneratedContext = buildSemanticStudioContextPackage({
    workflowPath: 'topic',
    operation: 'create_new',
    modelId: 'coffee-model',
    modelName: 'Coffee Shop Demo',
    branchId: session.branchId,
    branchName: session.branchName,
    topicName: session.topicName,
    editableFiles: regenerated.files,
    mainYaml,
    branchYaml,
  });
  assert.equal(regeneratedContext.model.branchId, session.branchId);
  assert.equal(regeneratedContext.target.resolvedBranchFileName, canonicalTopicFileName);
  assert.equal(regeneratedContext.target.existsOnBranch, true);
  const intent = resolveSemanticStudioTopicWriteIntent({
    operation: 'create_new',
    stagedTopic: regenerated.files[0],
    branchFiles: branchYaml.files,
    reviewedContext: regeneratedContext,
  });
  assert.deepEqual(intent.issues, []);
  assert.equal(intent.action, 'update');
  assert.equal(intent.authoredTopic?.fileName, canonicalTopicFileName);
});

test('Permission Builder regeneration keeps its governed topic on the reviewed canonical branch path', () => {
  const canonicalTopicFileName = 'Omni Training/coffee_shop_revenue.topic';
  const mainYaml = { files: { model: 'name: coffee_shop\n' }, checksums: {}, viewNames: {} };
  const branchYaml = {
    files: {
      ...mainYaml.files,
      [canonicalTopicFileName]: 'base_view: fact_order_items\naccess_grants: [shop_users]\n',
    },
    checksums: {},
    viewNames: {},
  };
  const context = buildSemanticStudioContextPackage({
    workflowPath: 'permissions',
    operation: 'update_existing',
    modelId: 'coffee-model',
    modelName: 'Coffee Shop Demo',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    topicName: 'coffee_shop_revenue',
    editableFiles: [{
      fileName: canonicalTopicFileName,
      yaml: branchYaml.files[canonicalTopicFileName],
    }],
    mainYaml,
    branchYaml,
  });
  const session = {
    connectionKey: 'tenant-a',
    modelId: 'coffee-model',
    connectionId: 'warehouse-a',
    workflowPath: 'permissions' as const,
    operation: 'update_existing' as const,
    topicName: 'coffee_shop_revenue',
    branchId: 'review-branch-id',
    branchName: 'omnikit/review-coffee',
    canonicalTopicFileName,
  };
  const regenerated = reconcileSemanticStudioRegeneratedPackage({
    session,
    context,
    current: {
      connectionKey: 'tenant-a',
      modelId: 'coffee-model',
      connectionId: 'warehouse-a',
      workflowPath: 'permissions',
      operation: 'update_existing',
      topicName: 'coffee_shop_revenue',
      branchId: 'review-branch-id',
      branchName: 'omnikit/review-coffee',
      handoffLocked: false,
    },
    branchFiles: branchYaml.files,
    files: [{
      id: 'permission-topic',
      fileName: 'coffee_shop_revenue.topic',
      yaml: 'base_view: fact_order_items\naccess_grants: [shop_users, finance_users]\n',
    }],
  });

  assert.deepEqual(regenerated.issues, []);
  assert.equal(regenerated.files[0].fileName, canonicalTopicFileName);
  assert.match(regenerated.files[0].yaml, /finance_users/);
});

test('pre-write Blueprint validation uses the reconciled authoritative topic target', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const handlerStart = topicsPage.indexOf('async function handleApplyToDevBranch()');
  const handlerEnd = topicsPage.indexOf('async function handleAskBlobbyToRepair()', handlerStart);
  const handler = topicsPage.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /const reviewedTargetTopicFileNames = reviewedTargetFiles\.filter/);
  assert.match(handler, /reviewedTargetTopicFileNames\.length !== 1/);
  assert.match(handler, /approvedTargetTopicFileName: reviewedTargetTopicFileName/);
  assert.doesNotMatch(handler, /approvedTargetTopicFileName: solutionPlan\?\.topicFileName/);
});

test('first save propagates Omni canonical topic evidence before branch validation and context refresh', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const handlerStart = topicsPage.indexOf('async function handleApplyToDevBranch()');
  const handlerEnd = topicsPage.indexOf('async function handleAskBlobbyToRepair()', handlerStart);
  const handler = topicsPage.slice(handlerStart, handlerEnd);
  const evidenceIndex = handler.indexOf('const evidence = await runSemanticOperationStep');
  const canonicalPathIndex = handler.indexOf('if (evidence.fileName !== file.fileName)', evidenceIndex);
  const updateFilesIndex = handler.indexOf('setDeployFiles(filesToSave)', canonicalPathIndex);
  const readbackIndex = handler.indexOf('const branchYamlAfter = await runSemanticOperationStep', updateFilesIndex);
  const packageValidationIndex = handler.indexOf('semanticBlueprintBranchPackageIssues', readbackIndex);
  const contextRefreshIndex = handler.indexOf('const refreshedContext = buildSemanticStudioContextPackage', packageValidationIndex);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(evidenceIndex >= 0);
  assert.match(handler.slice(evidenceIndex, canonicalPathIndex), /stageGovernedTopicMutation/);
  assert.match(handler.slice(canonicalPathIndex, updateFilesIndex), /candidate\.id === file\.id[\s\S]+fileName: evidence\.fileName/);
  assert.ok(canonicalPathIndex > evidenceIndex);
  assert.ok(updateFilesIndex > canonicalPathIndex);
  assert.ok(readbackIndex > updateFilesIndex);
  assert.ok(packageValidationIndex > readbackIndex);
  assert.ok(contextRefreshIndex > packageValidationIndex);
  assert.match(
    handler.slice(packageValidationIndex, contextRefreshIndex),
    /semanticBlueprintBranchPackageIssues\([\s\S]*?branchYamlAfter,[\s\S]*?filesToSave[\s\S]*?\)/,
  );
  assert.match(
    handler.slice(contextRefreshIndex),
    /semanticStudioEditableFilesAtSnapshot\([\s\S]*?filesToSave\.map[\s\S]*?branchYamlAfter[\s\S]*?\)/,
  );
});

test('guidance edits invalidate approval without clearing explicit solution actions', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const handlerStart = topicsPage.indexOf('function handleSemanticBlueprintDraftChange(');
  const handlerEnd = topicsPage.indexOf('function semanticBlueprintMutationBoundaryForDraft(', handlerStart);
  const handler = topicsPage.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /reviewedAndApproved:\s*Object\.prototype\.hasOwnProperty/);
  assert.match(handler, /semanticBlueprintActionOverridesAfterDraftPatch\(current, patch\)/);
  assert.match(handler, /resetAiConversation\(\{[\s\S]*?preservePermissionContract: true,[\s\S]*?preserveDeployBranch: true,[\s\S]*?\}\)/);
  assert.doesNotMatch(handler, /if \(!approvalOnly\) setSolutionActionOverrides\(\{\}\)/);
});

test('reviewed blueprint and action edits retain the validated branch for an exact-scope resave', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const resetStart = topicsPage.indexOf('function resetAiConversation(');
  const resetEnd = topicsPage.indexOf('function isModelEligibleForStudio(', resetStart);
  const resetHandler = topicsPage.slice(resetStart, resetEnd);
	  const generationStart = topicsPage.indexOf('async function handleGenerateFinalPackage(');
	  const generationEnd = topicsPage.indexOf('async function copyTextToClipboard(', generationStart);
	  const generationHandler = topicsPage.slice(generationStart, generationEnd);
	  const analysisStart = topicsPage.indexOf('async function handleRunDeepReview()');
	  const analysisEnd = topicsPage.indexOf('async function handleGenerateFinalPackage(', analysisStart);
	  const analysisHandler = topicsPage.slice(analysisStart, analysisEnd);
  const connectionResetStart = topicsPage.indexOf('useLayoutEffect(() => {');
  const connectionResetEnd = topicsPage.indexOf('}, [connectionKey, inventoryRequestCoordinator, semanticOperationCoordinator]);', connectionResetStart);
  const connectionReset = topicsPage.slice(connectionResetStart, connectionResetEnd);

  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  assert.match(resetHandler, /preserveDeployBranch\?: boolean/);
  assert.match(resetHandler, /reviewedDeployBranchSessionForCurrentScope\(\)/);
  assert.match(resetHandler, /const preserveDeployBranch = Boolean\(reviewedBranchSession\)/);
  assert.match(resetHandler, /if \(!preserveDeployBranch\) \{[\s\S]*?reviewedDeployBranchSessionRef\.current = null;[\s\S]*?setDeployBranchId\(''\);[\s\S]*?setDeployDevYaml\(null\);[\s\S]*?setDeploySemanticContext\(null\)/);
  assert.match(topicsPage, /function handleSemanticSolutionActionChange[\s\S]*?preserveDeployBranch: true/);
  assert.match(topicsPage, /resetAiConversation\(\{[\s\S]*?preservePermissionContract: true,[\s\S]*?preserveDeployBranch: true,[\s\S]*?\}\);[\s\S]*?setSemanticBlueprintApprovalNotice\('Your previous approval was cleared/);
  assert.match(topicsPage, /if \(deployHandoffStatusLocksBranch\(deployHandoffStatus, deployHandoffUrl\)\)[\s\S]*?Start a new reviewed run/);
  assert.match(topicsPage, /busy=\{loadingModelFiles \|\| deepReviewRunning \|\| deployMutationLocked\}/);
	  assert.ok(generationStart >= 0 && generationEnd > generationStart);
	  assert.ok(analysisStart >= 0 && analysisEnd > analysisStart);
	  assert.match(analysisHandler, /const reviewedBranchSessionForAnalysis = reviewedDeployBranchSessionForCurrentScope\(\)/);
	  assert.match(analysisHandler, /const reviewedAnalysisTargetView = reviewedBranchSessionForAnalysis\?\.session\.canonicalTopicFileName \|\| targetView/);
	  assert.match(analysisHandler, /branchId: reviewedBranchSessionForAnalysis\.session\.branchId[\s\S]*?semanticStudioYamlSnapshotChanges\([\s\S]*?reviewedBranchSessionForAnalysis\.branchYaml/);
	  assert.match(analysisHandler, /let authoredAnalysisYaml = modelYaml[\s\S]*?authoredAnalysisYaml = freshReviewedBranchYaml/);
	  assert.match(analysisHandler, /findAuthoredTopicYamlFile\(authoredAnalysisYaml, reviewedAnalysisTopicName\)/);
	  assert.match(analysisHandler, /buildTopicSourceContext\(reviewedAnalysisTopicName,[\s\S]*?currentTopicYaml: reviewedAnalysisTopicFile\?\.yaml \|\| ''[\s\S]*?includeCurrentYaml: Boolean\(reviewedAnalysisTopicFile \|\| topicName\)/);
	  assert.match(analysisHandler, /buildModelSourceContext\(authoredAnalysisYaml/);
	  assert.match(analysisHandler, /buildTopicBuilderModelDiscoveryContext\(authoredAnalysisYaml/);
	  assert.match(analysisHandler, /: reviewedBranchSessionForAnalysis\s*\? buildTopicBuilderModelDiscoveryContext\(authoredAnalysisYaml/);
	  assert.match(analysisHandler, /runAiPrompt\([\s\S]*?topicName:[\s\S]*?reviewedAnalysisTopicName[\s\S]*?branchId: reviewedBranchSessionForAnalysis\?\.session\.branchId/);
  assert.ok(
    generationHandler.indexOf('const reviewedBranchSessionForRegeneration = reviewedDeployBranchSessionForCurrentScope()')
      < generationHandler.indexOf('setDeploySemanticContext(null)'),
  );
  assert.match(generationHandler, /reconcileSemanticStudioRegeneratedPackage\([\s\S]*?branchFiles: reviewedBranchYamlForRegeneration\.files \|\| \{\}[\s\S]*?files: generatedFiles/);
  assert.match(generationHandler, /branchId: reviewedBranchSessionForRegeneration\?\.session\.branchId/);
  assert.match(generationHandler, /branchYaml: reviewedBranchYamlForRegeneration/);
  assert.match(generationHandler, /if \(reviewedBranchSessionForRegeneration\) \{\s*setDeploySemanticContext\(reviewedBranchSessionForRegeneration\.context\)/);
  assert.match(generationHandler, /const freshReviewedBranchYaml = await getModelYaml[\s\S]*?branchId: reviewedBranchSessionForRegeneration\.session\.branchId/);
  assert.match(generationHandler, /semanticStudioYamlSnapshotChanges\([\s\S]*?reviewedBranchSessionForRegeneration\.branchYaml,[\s\S]*?freshReviewedBranchYaml/);
  assert.match(generationHandler, /const authoredGenerationYaml = reviewedBranchYamlForRegeneration \|\| modelYaml/);
  assert.match(generationHandler, /const currentArtifactYaml = authoredGenerationYaml\.files\?\.\[artifactItem\.fileName\]/);
  assert.match(generationHandler, /buildRelationshipBuilderModelContext\(authoredGenerationYaml/);
  assert.match(generationHandler, /viewFieldPreservationLintIssues\([\s\S]*?authoredArtifactYaml/);
	  const genericGenerationStart = generationHandler.indexOf('const reviewedRegenerationTopicName');
	  const genericGeneration = generationHandler.slice(genericGenerationStart);
	  assert.ok(genericGenerationStart >= 0);
	  assert.match(genericGeneration, /findAuthoredTopicYamlFile\(authoredGenerationYaml, reviewedRegenerationTopicName\)/);
	  assert.match(genericGeneration, /const genericPackageTopicName = reviewedRegenerationTopicName \|\| contextTopicName/);
	  assert.match(generationHandler, /const reviewedGenerationTargetView = reviewedBranchSessionForRegeneration\?\.session\.canonicalTopicFileName \|\| targetView/);
	  assert.match(genericGeneration, /reviewedBranchSessionForRegeneration\?\.session\.canonicalTopicFileName \|\| targetView/);
	  assert.match(genericGeneration, /packageScopeForRepair[\s\S]*?: genericPackageTopicName \|\| 'new_topic_candidate'/);
	  assert.match(genericGeneration, /buildDeepReviewChunkPrompt\([\s\S]*?topicName: genericPackageTopicName/);
	  assert.match(genericGeneration, /runAiPrompt\([\s\S]*?topicName:[\s\S]*?genericPackageTopicName[\s\S]*?branchId: reviewedBranchSessionForRegeneration\?\.session\.branchId/);
	  assert.match(genericGeneration, /buildModelSourceContext\(authoredGenerationYaml/);
	  assert.match(genericGeneration, /buildTopicBuilderModelDiscoveryContext\(authoredGenerationYaml/);
	  assert.match(genericGeneration, /reconcileSemanticStudioRegeneratedPackage\([\s\S]*?branchFiles: reviewedBranchYamlForRegeneration\.files \|\| \{\}[\s\S]*?files: generatedFiles/);
	  assert.match(genericGeneration, /branchId: reviewedBranchSessionForRegeneration\?\.session\.branchId[\s\S]*?branchYaml: reviewedBranchYamlForRegeneration/);
	  assert.match(genericGeneration, /setDeploySemanticContext\(generatedContext\);\s*setDeployFiles\(generatedFiles\);\s*setDeployPreWriteAcknowledged\(false\)/);
	  assert.match(generationHandler, /let artifactOutcome = await runAiPrompt\([\s\S]*?topicName: artifactTopicName,[\s\S]*?branchId: reviewedBranchSessionForRegeneration\?\.session\.branchId/);
	  assert.match(generationHandler, /artifactOutcome = await runAiPrompt\([\s\S]*?prompt: repairPrompt,[\s\S]*?branchId: reviewedBranchSessionForRegeneration\?\.session\.branchId/);
	  assert.match(topicsPage, /const semanticSolutionPackageDrafts:[\s\S]*?deployFiles\.length > 0[\s\S]*?deployFiles\.map/);
	  assert.match(topicsPage, /const permissionTopicName = selectedStudioPath === 'permissions'[\s\S]*?topicNameFromTargetFile\(targetBaseViewName\.trim\(\)\)/);
	  assert.match(topicsPage, /function topicNameFromTargetFile\(fileName: string\)[\s\S]*?semanticStudioTopicNameFromFileName\(clean\)/);
	  const topicSourceBuilderStart = topicsPage.indexOf('function buildTopicSourceContext(');
	  const topicSourceBuilderEnd = topicsPage.indexOf('function compactYamlForPrompt(', topicSourceBuilderStart);
	  const topicSourceBuilder = topicsPage.slice(topicSourceBuilderStart, topicSourceBuilderEnd);
	  assert.ok(topicSourceBuilderStart >= 0 && topicSourceBuilderEnd > topicSourceBuilderStart);
	  assert.ok(topicSourceBuilder.indexOf("const currentTopicYaml = options.currentTopicYaml?.trim() || ''") < topicSourceBuilder.indexOf('if (!detail && !currentTopicYaml)'));
	  assert.match(topicSourceBuilder, /if \(!detail && !currentTopicYaml\)/);
	  assert.match(topicsPage, /const currentTopicName = permissionTopicName \|\| \(currentOperation === 'update_existing'[\s\S]*?deploySemanticContext\?\.target\.topicName \|\| solutionPlan\?\.topicName/);
	  assert.match(topicsPage, /const governedTopicPackage = Boolean\(topicFile\)[\s\S]*?selectedPathIncludesPermissions && targetBaseViewName\.trim\(\)\.endsWith\('\.topic'\)/);
	  assert.match(topicsPage, /if \(governedTopicPackage && topicFile\)[\s\S]*?workflowPath: currentGovernedSemanticContextPath\(\)[\s\S]*?reviewedDeployBranchSessionRef\.current = reviewedBranchSession/);
	  assert.match(topicsPage, /const governedTopicWrite = selectedPathIncludesTopic \|\| \([\s\S]*?selectedPathIncludesPermissions && targetSemanticFile\.endsWith\('\.topic'\)[\s\S]*?\)/);
	  assert.match(topicsPage, /const plannedReviewedTargetFiles =[\s\S]*?: governedTopicWrite\s*\? reviewedSemanticContextForWrite\?\.scope\.editableFiles \|\| \[\]/);
	  assert.match(topicsPage, /const reviewedScopeResolution = governedTopicWrite\s*\? reconcileSemanticStudioReviewedFileScope/);
	  assert.match(topicsPage, /function invalidateGeneratedPackageAfterDecisionChange\(\)[\s\S]*?setDeployFiles\(\[\]\)[\s\S]*?setDeployReviewAcknowledged\(false\)[\s\S]*?setDeployStatus\('idle'\)[\s\S]*?setDeployHandoffStatus\('idle'\)/);
	  assert.match(topicsPage, /function updateReadinessInputs[\s\S]*?invalidateGeneratedPackageAfterDecisionChange\(\)/);
	  assert.match(topicsPage, /function updatePermissionContractDraft[\s\S]*?reviewedAndConfirmed:[\s\S]*?false[\s\S]*?invalidateGeneratedPackageAfterDecisionChange\(\)/);
	  assert.match(topicsPage, /const deployReadyForOmniReview =[\s\S]*?!permissionContractRequiredForRun \|\| permissionConfirmIssues\.length === 0/);
	  assert.match(topicsPage, /async function handleCreateDeployPullRequest[\s\S]*?permissionContractRequiredForRun && permissionConfirmIssues\.length > 0[\s\S]*?return;/);
	  assert.match(topicsPage, /const governedTopicHandoff = selectedPathIncludesTopic \|\| \([\s\S]*?selectedPathIncludesPermissions && targetSemanticFile\.endsWith\('\.topic'\)/);
	  assert.match(topicsPage, /const governedTopicRepair = selectedPathIncludesTopic \|\| \([\s\S]*?selectedPathIncludesPermissions && targetSemanticFile\.endsWith\('\.topic'\)/);
	  assert.match(topicsPage, /if \(governedTopicRepair\)[\s\S]*?reconcileSemanticStudioReviewedFileScope/);
	  assert.match(topicsPage, /const permissionRepairTopicName = selectedPathIncludesPermissions[\s\S]*?deploySemanticContext\?\.target\.topicName \|\| topicNameFromTargetFile\(targetSemanticFile\)/);
	  assert.match(topicsPage, /sourceTopicYaml: governedTopicRepair/);
  assert.match(topicsPage, /const stagedDeployBaselineYaml = reviewedDeployBranchSessionForCurrentScope\(\)\?\.branchYaml[\s\S]*?\|\| deployReviewedMainYaml/);
  assert.match(topicsPage, /reviewedDeployBranchSessionRef\.current = reviewedBranchSession;[\s\S]*?setDeploySemanticContext\(refreshedContext\)/);
  assert.ok(connectionResetStart >= 0 && connectionResetEnd > connectionResetStart);
  assert.match(connectionReset, /semanticOperationCoordinator\.invalidate\(\)/);
  assert.doesNotMatch(connectionReset, /deployOperationRef\.current = null/);
  assert.match(connectionReset, /reviewedDeployBranchSessionRef\.current = null/);
  assert.match(connectionReset, /setDeployBranchId\(''\)/);
  assert.match(connectionReset, /setDeployDevYaml\(null\)/);
  assert.match(connectionReset, /setDeploySemanticContext\(null\)/);
  assert.match(topicsPage, /const reviewedBranchSessionAtWriteStart = reviewedDeployBranchSessionForCurrentScope\(\)/);
  assert.match(topicsPage, /const branchHadReviewedSnapshot = Boolean\(reviewedBranchSessionAtWriteStart\)/);
  assert.match(topicsPage, /if \(reviewedBranchSessionAtWriteStart\) \{[\s\S]*?exact reviewed dev branch no longer exists[\s\S]*?\}/);
  assert.match(topicsPage, /resolveSemanticStudioTopicWriteIntent\([\s\S]*?reviewedContext: reviewedSemanticContextForWrite/);
  assert.match(topicsPage, /setDeployBranchName\(resolvedBranchName\);\s*setDeployBranchNameEdited\(true\)/);
  assert.match(topicsPage, /const retainedReviewedBranch = reviewedDeployBranchSessionForCurrentScope\(\);[\s\S]*?if \(!retainedReviewedBranch && \(!deployBranchNameEdited \|\| !deployBranchName\.trim\(\)\)\)/);
  assert.match(topicsPage, /semanticStudioUnexpectedBranchChanges\([\s\S]*?branchYamlBefore,[\s\S]*?filesToSave\.map/);
  assert.match(topicsPage, /The dev branch changed after the last reviewed validation/);
  assert.match(topicsPage, /async function handleModelSelect[\s\S]*?semanticOperationCoordinator\.invalidate\(\)/);
  assert.match(generationHandler, /beginSemanticOperation\('generate', selectedModel\.id\)/);
  assert.match(generationHandler, /runAiPrompt\(\{\s*operationToken/);
  assert.match(generationHandler, /StaleSemanticStudioOperationError[\s\S]*?settleSemanticOperation\(operationToken\)/);
  assert.match(topicsPage, /async function handleCreateDeployPullRequest[\s\S]*?beginSemanticOperation\('handoff', selectedModel\.id\)[\s\S]*?runSemanticOperationStep\([\s\S]*?createReviewedModelPullRequestHandoff[\s\S]*?settleSemanticOperation\(operationToken\)/);
});

test('view currency formats are governed before any branch creation or YAML write', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const handlerStart = topicsPage.indexOf('async function handleApplyToDevBranch()');
  const handlerEnd = topicsPage.indexOf('async function handleAskBlobbyToRepair()', handlerStart);
  const handler = topicsPage.slice(handlerStart, handlerEnd);
  const lintIndex = handler.indexOf('validateDeployYamlFile');
  const branchIndex = handler.indexOf('ensureDeployBranch(operationToken)');
  const writeIndex = handler.indexOf('updateModelYamlFile');

  assert.match(topicsPage, /format: usdcurrency_2/);
  assert.match(topicsPage, /Never use a bare ISO currency code such as format: USD/);
  assert.match(topicsPage, /semanticStudioViewFormatIssues\(yaml\)/);
  assert.ok(lintIndex >= 0 && branchIndex > lintIndex && writeIndex > branchIndex);
});

test('AI Semantic Studio offers a governed post-validation Blobby repair loop', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const handlerStart = topicsPage.indexOf('async function handleAskBlobbyToRepair()');
  const handlerEnd = topicsPage.indexOf('async function handleCreateDeployPullRequest()', handlerStart);
  const handler = topicsPage.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /buildSemanticStudioRepairPrompt/);
  assert.match(handler, /branchId: deployBranchId/);
  assert.doesNotMatch(handler, /conversationId:/);
  assert.match(handler, /validateSemanticStudioRepairOutput/);
  assert.match(handler, /validateSemanticStudioRepairFileSet/);
  assert.match(handler, /reconcileSemanticStudioReviewedFileScope/);
  assert.match(handler, /validateSemanticStudioReviewedPackageFileSet/);
  assert.match(handler, /repairTargetTopicFileNames\.length !== 1/);
  assert.match(handler, /approvedTargetTopicFileName: repairTargetTopicFileNames\[0\]/);
  assert.match(handler, /Object\.prototype\.hasOwnProperty\.call\(freshBranchYaml\.files \|\| \{\}, file\.fileName\)/);
  assert.doesNotMatch(handler, /freshBranchYaml\.files\?\.\[file\.fileName\] \|\| file\.yaml/);
  assert.doesNotMatch(handler, /approvedTargetTopicFileName: solutionPlan\?\.topicFileName/);
  assert.match(handler, /validateDeployYamlFile/);
  assert.match(handler, /setDeployFiles\(nextFiles\)/);
  assert.match(handler, /setDeployValidation\(null\)/);
  assert.doesNotMatch(handler, /updateModelYamlFile|stageGovernedTopicMutation|publishReviewedModelBranch|createModelBranch/);

  assert.match(topicsPage, /Fix validation issues/);
  assert.match(topicsPage, /Ask Blobby to propose fixes/);
  assert.match(topicsPage, /Edit YAML myself/);
  assert.match(topicsPage, /Continue in Blobby chat/);
  assert.match(topicsPage, /No branch write has occurred/);
  assert.match(topicsPage, /Save to Review Branch to save and validate it again/);
});

test('AI Semantic Studio plans and stages one governed end-to-end topic solution', () => {
  const page = source('src/pages/TopicsPage.tsx');
  const panel = source('src/components/semanticStudio/SemanticSolutionPlanPanel.tsx');
  const blueprint = source('src/components/semanticStudio/SemanticBlueprintPanel.tsx');
  const blueprintService = source('src/services/semanticBlueprint.ts');
  const orchestrator = source('src/services/semanticSolutionOrchestrator.ts');

  assert.match(page, /useState<SemanticSolutionGoal>\('build_new_topic'\)/);
  assert.match(panel, /Build a topic end to end/);
  assert.match(panel, /Improve an existing topic/);
  assert.match(panel, /Advanced: edit one semantic file/);
  assert.match(panel, /Review or create connections/);
  assert.match(panel, /Use only the main data source/);
  assert.match(panel, /SemanticBlueprintPanel/);
  assert.match(panel, /goal !== 'advanced_single_file'/);
  assert.match(panel, /approvalNotice=\{approvalNotice\}/);
  assert.match(blueprint, /Build instructions/i);
  assert.match(blueprint, /Business outcome/);
  assert.match(blueprint, /Questions this topic must answer/);
  assert.match(blueprint, /What does one row represent\?/);
  assert.match(blueprint, /Focus schemas \(optional\)/);
  assert.match(blueprint, /Main data source/);
  assert.match(blueprint, /Related data/);
  assert.match(blueprint, /How the data connects/);
  assert.match(blueprint, /Blobby can propose each missing reusable relationship/);
  assert.match(blueprint, /create_reusable/);
  assert.match(blueprint, /Existing model relationship/);
  assert.match(blueprint, /existingRelationshipContracts/);
  assert.match(panel, /blueprintRelationshipContracts/);
  assert.match(page, /semanticBlueprintExistingRelationshipContracts\(selectedModelYaml\)/);
  assert.match(blueprint, /excluded automatically/);
  assert.doesNotMatch(blueprint, /Explicit exclusions \(optional\)/);
  assert.match(blueprint, /I approve these build instructions/);
  assert.match(blueprintService, /User-approved semantic blueprint \(immutable boundary\)/);
  assert.match(blueprintService, /Choose how supporting view/);
  assert.match(blueprintService, /semanticBlueprintPlanBindings/);
  assert.match(blueprintService, /If the solution requires broader scope, return a recommendation for user approval/);
  assert.match(panel, /goal !== 'advanced_single_file'/);
  assert.match(page, /useState<SemanticRelationshipIntent>\('required'\)/);
  assert.match(page, /relationshipIntent: solutionRelationshipIntent/);
  assert.match(panel, /Decision for \$\{item\.fileName\}/);
  assert.match(page, /blueprintPlanBindings\.actionOverrides/);
  assert.match(page, /\.\.\.solutionActionOverrides/);
  assert.match(page, /buildSemanticSolutionOrchestration/);
  assert.match(page, /resumableAcceptedSemanticSolutionFiles/);
  assert.match(page, /semanticSolutionGeneratedFileFingerprint/);
  assert.match(page, /validateDeployYamlFile\(file\)/);
  assert.match(page, /semanticModelReferenceIssues\(\[\.\.\.acceptedFiles, \.\.\.parsedFiles\], authoredGenerationYaml\)/);
  assert.match(page, /semanticBlueprintPackageIssues/);
  assert.match(page, /semanticBlueprintApprovalIssues/);
  assert.match(page, /targetTopicFileName: solutionPlan\?\.topicFileName/);
  assert.match(page, /solutionPlanFingerprint: semanticSolutionPlanApprovalFingerprint/);
  assert.match(page, /permissionContractFingerprint: solutionPermissionIntent === 'required'/);
  assert.match(page, /semanticPermissionContractFingerprint\(permissionContractDraft\)/);
  assert.match(page, /approvalNotice=\{semanticBlueprintApprovalNotice\}/);
  assert.match(page, /semanticBlueprintApproval: currentSemanticBlueprintContextApproval/);
  assert.match(page, /semanticBlueprintFingerprint/);
  assert.match(page, /formatSemanticBlueprintForAi/);
  assert.match(page, /return formatSemanticBlueprintForAi\(normalizedSemanticBlueprint\)/);
  assert.doesNotMatch(page, /formatBlueprintSupplementalInputs/);
  assert.match(page, /accessSetup=\{solutionPermissionIntent === 'required'/);
  assert.match(page, /permissionContractRequiredForRun && !requiresReviewedSourceScope/);
  assert.match(panel, /relationshipIntentSetup=\{\(/);
  assert.match(panel, /accessIntentSetup=\{\(/);
  assert.match(blueprint, /\{relationshipIntentSetup &&/);
  assert.match(blueprint, /\{accessIntentSetup &&/);
  assert.match(blueprint, /permissionIntent === 'required' && accessSetup/);
  assert.ok(blueprint.indexOf('Set the data boundary') < blueprint.indexOf('Configure the approved access boundary'));
  assert.ok(blueprint.indexOf('Configure the approved access boundary') < blueprint.indexOf('Approve the build instructions'));
  assert.match(page, /resetAiConversation\(\{ preservePermissionContract: true \}\)/);
  assert.match(page, /const packageChangeSummary = requiresReviewedSourceScope[\s\S]+\? ''[\s\S]+buildPackageChangeSummary/);
  assert.match(page, /Complete and approve the build instructions before Analyze/);
  assert.match(page, /Immutable data-scope rule: use only these existing model views/);
  assert.match(page, /Existing topic names for collision avoidance only/);
  assert.match(page, /you approved.*Generation is blocked/);
  assert.match(page, /newTopicSourceScopeReady/);
  assert.match(page, /Resolve semantic references before creating a dev branch/);
  assert.match(page, /const reviewedTargetTopicFileName = reviewedFiles\.find/);
  assert.match(page, /approvedTargetTopicFileName: reviewedTargetTopicFileName/);
  assert.match(page, /semanticModelViewNames\(modelYaml\)/);
  assert.match(page, /validateSemanticStudioRepairOutput\(\[file\]\)/);
  assert.match(page, /Never copy review-schema placeholders such as view\.field/);
  assert.match(page, /semanticStudioTopicNameFromFileName\(generatedTopic\.fileName\)/);
  assert.match(page, /semanticStudioTopicNameFromFileName\(generatedTopicFile\.fileName\)/);
  assert.match(page, /semanticStudioTopicNameFromFileName\(topicFile\.fileName\)/);
  assert.doesNotMatch(page, /topicNameStem\((?:topicItem|generatedTopic|generatedTopicFile|topicFile)\.fileName\)/);
  assert.match(page, /orderSemanticSolutionDeployDrafts/);
  assert.match(page, /approvedSemanticSolutionWriteTargets/);
  assert.match(page, /reconcileSemanticStudioReviewedFileScope/);
  assert.match(page, /validateSemanticStudioReviewedPackageFileSet/);
  assert.match(page, /const approvedTargets = new Set\(reviewedTargetFiles\)/);
  assert.match(page, /authoredSemanticYamlCommentIssues/);
  assert.match(page, /solutionGoal !== 'advanced_single_file'/);
  assert.match(page, /semanticSolutionPackageDrafts/);
  assert.match(page, /packageDisplayDrafts/);
  assert.match(page, /reviewed semantic files are ready for review/);
  assert.match(page, /Targets: \{packageDisplayDrafts/);
  assert.match(page, /Solution package scope/);
  assert.match(page, /Topic last/);
  assert.match(orchestrator, /A deployable semantic solution package must contain exactly one \.topic file/);
  assert.match(orchestrator, /return leftTopic \? 1 : -1/);
  assert.match(page, /setDeployPreWriteAcknowledged\(false\)[\s\S]+normalized the staged file names or YAML/);
  assert.match(page, /setStudioStep\('scope'\)/);
  assert.match(page, /Pull request quarantined/);
  assert.match(page, /Open quarantined pull request/);
  assert.match(page, /Pull-request outcome needs reconciliation/);
  assert.match(page, /Reconcile handoff in Omni/);
  assert.match(page, /function deployHandoffStatusLocksBranch[\s\S]+status === 'creating'[\s\S]+status === 'ready'[\s\S]+status === 'unknown'[\s\S]+status === 'failed' && Boolean\(reviewUrl\)/);
  assert.match(page, /const deployHandoffLocksBranch = deployHandoffStatusLocksBranch\(deployHandoffStatus, deployHandoffUrl\)/);
  assert.match(page, /function updateDeployFile[\s\S]+if \(deployHandoffLocksBranch \|\| deployOperationRef\.current \|\| deployInFlight\) return/);
  assert.match(page, /function handleSemanticBlueprintDraftChange[\s\S]+if \(deployOperationRef\.current \|\| deployInFlight\) return/);
  assert.match(page, /function handleSemanticSolutionActionChange[\s\S]+if \(deployOperationRef\.current \|\| deployInFlight\) return/);
  assert.match(page, /function updatePermissionContractDraft[\s\S]+deployOperationRef\.current \|\| deployInFlight/);
  assert.match(page, /busy=\{loadingModelFiles \|\| deepReviewRunning \|\| deployMutationLocked\}/);
  assert.match(blueprint, /<fieldset disabled=\{busy\} aria-disabled=\{busy\}>[\s\S]+\{accessSetup\}[\s\S]+<\/fieldset>/);
  assert.match(page, /async function handleDiscardDeployBranch[\s\S]+if \(deployHandoffLocksBranch \|\| deployOperationRef\.current \|\| deployInFlight\) return/);
  assert.match(page, /const operationToken = beginSemanticOperation\('discard', selectedModel\.id\)/);
  assert.match(page, /runSemanticOperationStep\([\s\S]+?discardReviewedModelBranch/);
  assert.match(page, /runSemanticOperationStep\([\s\S]+?getModelYaml/);
  assert.match(page, /rebaseError instanceof StaleSemanticStudioOperationError \|\| !semanticOperationIsCurrent\(operationToken\)/);
  assert.match(page, /finally \{\s*if \(settleSemanticOperation\(operationToken\)\) setDeployDiscardStatus\('idle'\)/);
  assert.match(page, /async function handleAskBlobbyToRepair[\s\S]+if \(deployHandoffLocksBranch \|\| deployOperationRef\.current\) return/);
  assert.match(page, /readOnly=\{deployMutationLocked\}/);
  assert.match(page, /disabled=\{deployMutationLocked/);
  assert.match(page, /knownQuarantinedHandoff \? 'failed' : outcomeUnknown \? 'unknown' : 'failed'/);
  assert.match(page, /Start a new reviewed run/);
  assert.match(page, /ReviewedPullRequestVerificationError/);
  assert.match(page, /preserveDeployHandoff: true/);
  assert.match(page, /postHandoffMainYaml/);
  assert.match(page, /postHandoffBranchYaml/);
  assert.match(page, /restored authored topic settings[\s\S]+approve it before saving/);
  assert.match(page, /createReviewedModelPullRequestHandoff/);
  assert.doesNotMatch(page, /publishReviewedModelBranch/);
});

test('AI Semantic Studio keeps large model scope usable and applies one Review gate', () => {
  const page = source('src/pages/TopicsPage.tsx');

  assert.match(page, /const eligibleStudioModels = models[\s\S]+\.sort\(\(left, right\) =>/);
  assert.match(page, /left\.name\.localeCompare\(right\.name/);
  assert.match(page, /xl:grid-cols-\[440px_minmax\(0,1fr\)\]/);
  assert.match(page, /max-h-\[420px\][^\n]+xl:max-h-\[520px\]/);
  assert.match(page, /\$\{topicModelOptions\.length\} of \$\{eligibleStudioModels\.length\} matches/);
  assert.match(page, /\$\{eligibleStudioModels\.length\} available/);
  assert.match(page, /ariaLabel="Search Omni models"/);
  assert.match(page, /Show development branch models/);
  assert.match(page, /const scopeReadyForReview = Boolean/);
  assert.match(page, /if \(stepId === 'baseline'\) return scopeReadyForReview/);
  assert.match(page, /disabled=\{!scopeReadyForReview\}/);
  assert.match(page, /Analysis focus/);
  assert.match(page, /At least one review focus must remain selected/);
  assert.match(page, /const onlySelectedFocus = selected && activeWorkstreams\.length === 1/);
  assert.match(page, /disabled=\{onlySelectedFocus\}/);
  assert.match(page, /selectedModelRequestRef\.current === modelId/);
  assert.match(page, /loadStudioModelInventory<OmniModel>\(async \(modelKind\) =>/);
  assert.match(page, /modelKind,[\s\S]+allPages: true,[\s\S]+pageSize: 100/);
  assert.match(page, /createTopicsInventoryRequestCoordinator/);
  assert.match(page, /inventoryRequestCoordinator\.isCurrent\(token\)/);
  assert.match(page, /inventoryRequestCoordinator\.begin\(inventoryScopeKey\(modelId, path\), resources\)/);
  assert.match(page, /if \(modelId && modelId === selectedModelRequestRef\.current\) \{[\s\S]+loadSelectedModelInventory/);
  assert.match(page, /inventoryRequestCoordinator\.clear\(\);[\s\S]+setSelectedModelId\(''\)/);
  assert.match(page, /!nextIncludeBranches && selectedModel\?\.kind === 'BRANCH'/);
  assert.doesNotMatch(page, />Building:<\/span>/);
});

test('AI Semantic Studio uses five novice workflow labels without legacy Confirm or Package steps', () => {
  const page = source('src/pages/TopicsPage.tsx');
  const stepsStart = page.indexOf('const STUDIO_STEPS');
  const stepsEnd = page.indexOf('];', stepsStart);

  assert.ok(stepsStart >= 0 && stepsEnd > stepsStart);
  const stepBlock = page.slice(stepsStart, stepsEnd);
  const labels = Array.from(stepBlock.matchAll(/label: '([^']+)'/g), (match) => match[1]);

  assert.deepEqual(labels, ['Choose & Define', 'Analyze', 'Decide', 'Review Changes', 'Stage Safely']);
  assert.doesNotMatch(stepBlock, /label: '(?:Confirm|Package)'/);
  assert.doesNotMatch(page, /\bDecisions\b/);
  assert.match(page, /Continue to Decide/);
});

test('AI Semantic Studio does not infer Shared when model kind evidence is missing', () => {
  const page = source('src/pages/TopicsPage.tsx');
  assert.match(page, /if \(!model\.kind\) return 'Model';/);
  assert.match(page, /if \(model\.kind === 'SHARED'\) return 'Shared';/);
  assert.doesNotMatch(page, /if \(!model\.kind \|\| model\.kind === 'SHARED'\) return 'Shared'/);
  assert.match(page, /Select the Omni model that will own this topic solution/);
  assert.doesNotMatch(page, /Select the shared Omni model that will own this topic solution/);
});

test('AI Semantic Studio groups model discovery by verified connection name', () => {
  const page = source('src/pages/TopicsPage.tsx');
  const groupsStart = page.indexOf('topicModelGroups.map((group)');
  const groupsEnd = page.indexOf('{selectedModel &&', groupsStart);

  assert.match(page, /const topicModelGroups = Array\.from\(topicModelOptions\.reduce/);
  assert.match(page, /model\.connectionName \|\| model\.connectionId \|\| 'Other models'/);
  assert.match(page, /omniProxy<unknown>\(connection\.baseUrl, connection\.apiKey, 'GET', '\/v1\/connections'\)/);
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /\.then\(parseStudioConnectionNamesResponse\)/);
  assert.match(page, /connectionResult\.status === 'fulfilled' \? connectionResult\.value : \[\]/);
  assert.match(page, /applyStudioConnectionNames\(/);
  assert.ok(groupsStart >= 0 && groupsEnd > groupsStart);

  const groupedModelList = page.slice(groupsStart, groupsEnd);
  assert.match(groupedModelList, /\{group\.label\}/);
  assert.match(groupedModelList, /group\.models\.map/);
  assert.ok(groupedModelList.indexOf('{group.label}') < groupedModelList.indexOf('group.models.map'));
  assert.match(groupedModelList, /<span[^>]+sr-only[^>]*>Model ID: \{model\.id\}/);
});

test('AI Semantic Studio explains safe staging without implying automatic publication', () => {
  const page = source('src/pages/TopicsPage.tsx');
  const stagingStart = page.indexOf("{studioStep === 'deploy'");

  assert.ok(stagingStart >= 0);
  const staging = page.slice(stagingStart);
  assert.match(staging, /Stage on a review branch/);
  assert.match(staging, /(?:nothing is|changes are not|they are not) (?:published or merged|merged or published) automatically/i);
});

test('AI Semantic Studio uses novice build labels while preserving scope and approval gates', () => {
  const blueprint = source('src/components/semanticStudio/SemanticBlueprintPanel.tsx');
  const panel = source('src/components/semanticStudio/SemanticSolutionPlanPanel.tsx');

  for (const label of ['Build instructions', 'What does one row represent?', 'Main data source', 'Related data', 'How the data connects']) {
    assert.match(blueprint, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(blueprint, /Select only the [^.]+ Blobby may use\.[\s\S]+Every [^.]+ you do not select stays outside this solution automatically\./);
  assert.match(blueprint, /All other existing views remain blocked/);
  assert.match(blueprint, /disabled=\{busy \|\| preApprovalIssues\.length > 0\}/);
  assert.match(blueprint, /I approve these build instructions[\s\S]+exact view allowlist/);
  assert.match(panel, /Requested artifact file/);
  assert.match(panel, /limits this run to one reviewed semantic file/);
  assert.doesNotMatch(panel, /\.slice\(0, 1\)/);
  assert.match(panel, /nextFileNames\.length <= 1 \? nextFileNames : \[\]/);
  assert.match(panel, /Enter exactly one artifact file/);
  assert.match(panel, /aria-invalid=\{Boolean\(artifactInputIssue\)\}/);
  assert.doesNotMatch(panel, /Separate file names with commas or new lines/);
});

test('AI Semantic Studio prevents duplicate branch writes and labels editable YAML', () => {
  const page = source('src/pages/TopicsPage.tsx');

  assert.match(page, /if \(deployHandoffLocksBranch \|\| deployOperationRef\.current \|\| deployInFlight\) return/);
  assert.match(page, /const operationToken = beginSemanticOperation\('apply', selectedModel\.id\)/);
  assert.match(page, /deployOperationRef\.current = token;\s*setDeployOperationActive\(true\)/);
  assert.match(page, /deployOperationRef\.current = null;[\s\S]+setDeployOperationActive\(false\)/);
  assert.match(page, /const reviewedBranchSessionAtWriteStart = reviewedDeployBranchSessionForCurrentScope\(\)/);
  assert.match(page, /const authoredPreWriteYaml = reviewedBranchSessionAtWriteStart\?\.branchYaml \|\| mainYaml/);
  const generationHandler = page.slice(
    page.indexOf('async function handleGenerateFinalPackage'),
    page.indexOf('async function copyTextToClipboard'),
  );
  assert.equal(
    [...generationHandler.matchAll(/baselineRelationshipsYaml: modelYaml\.files\?\.relationships \|\| ''/g)].length,
    5,
  );
  assert.doesNotMatch(generationHandler, /baselineRelationshipsYaml: authoredGenerationYaml/);
  const applyHandler = page.slice(
    page.indexOf('async function handleApplyToDevBranch'),
    page.indexOf('async function handleDiscardDeployBranch'),
  );
  assert.match(applyHandler, /baselineRelationshipsYaml: mainYaml\.files\?\.relationships \|\| ''/);
  assert.doesNotMatch(applyHandler, /baselineRelationshipsYaml: authoredPreWriteYaml/);
  const repairHandler = page.slice(
    page.indexOf('async function handleAskBlobbyToRepair'),
    page.indexOf('async function handleCreateDeployPullRequest'),
  );
  assert.match(repairHandler, /baselineRelationshipsYaml: freshMainYaml\.files\?\.relationships \|\| ''/);
  assert.doesNotMatch(repairHandler, /baselineRelationshipsYaml: freshBranchYaml/);
  assert.match(page, /authoredSemanticYamlCommentIssues\([\s\S]+?authoredPreWriteYaml\.files\?\.\[file\.fileName\] \|\| ''/);
  assert.match(page, /viewFieldPreservationLintIssues\([\s\S]+?authoredPreWriteYaml\.files\?\.\[file\.fileName\] \|\| ''/);
  assert.match(page, /const baselinePermissionTopic = permissionTopicFile[\s\S]+?authoredPreWriteYaml\.files\?\.\[permissionTopicFile\.fileName\][\s\S]+?findAuthoredTopicYamlFile\(authoredPreWriteYaml, permissionTopicName\)/);
  assert.match(page, /baselineModelYaml: authoredPreWriteYaml\.files\?\.model \|\| '\{\}'/);
  assert.match(page, /const permissionBaseline = freshBranchYaml/);
  assert.match(page, /async function handleModelSelect[\s\S]+?if \(deployOperationRef\.current\) return/);
  assert.match(page, /function handleSolutionGoalChange[\s\S]+?if \(deployOperationRef\.current\) return/);
  assert.match(page, /function handleStudioPathSelect[\s\S]+?if \(deployOperationRef\.current\) return/);
  assert.match(page, /function handleAiPromptChange[\s\S]+?if \(deployOperationRef\.current\) return/);
  assert.match(page, /function updateReadinessInputs[\s\S]+?if \(deployOperationRef\.current\) return/);
  assert.match(page, /function handleStartNewAiThread[\s\S]+?if \(deployOperationRef\.current\) return/);
  assert.match(page, /disabled=\{!reachable \|\| deployOperationActive\}/);
  assert.match(page, /onClick=\{handleStartNewAiThread\} disabled=\{deployOperationActive\}/);
  assert.match(page, /disabled=\{deployOperationActive\}[\s\S]+?placeholder="Optional notes/);
  assert.match(page, /finally \{\s*settleSemanticOperation\(operationToken\)/);
  assert.match(page, /runSemanticOperationStep\([\s\S]*?updateModelYamlFile/);
  assert.match(page, /runSemanticOperationStep\([\s\S]*?stageGovernedTopicMutation/);
  assert.match(page, /aria-label=\{`YAML for \$\{formatDeployReviewPath\(file\.fileName\)\}`\}/);
  assert.match(page, /semantic-studio-review-branch-name/);
  assert.match(page, /querySelector<HTMLTextAreaElement>\('#semantic-studio-deploy-files textarea'\)\?\.focus/);
});

test('AI Semantic Studio can retry only the failed package on the exact reviewed branch', () => {
  const page = source('src/pages/TopicsPage.tsx');
  const generationHandler = page.slice(
    page.indexOf('async function handleGenerateFinalPackage'),
    page.indexOf('async function copyTextToClipboard'),
  );

  assert.match(generationHandler, /options: \{ freshPackage\?: boolean \} = \{\}/);
  assert.match(generationHandler, /hadReviewedBranchSession[\s\S]+!reviewedBranchSessionForRegeneration[\s\S]+setDeepReviewError/);
  assert.match(generationHandler, /const checkpointForRun = options\.freshPackage \? null : solutionGenerationCheckpoint/);
  assert.match(generationHandler, /let workingConversationId = options\.freshPackage \? '' : aiPackageConversationId \|\| ''/);
  assert.match(generationHandler, /if \(options\.freshPackage\) \{[\s\S]+setAiPackageConversationId\(''\)[\s\S]+setSolutionGenerationCheckpoint\(null\)/);
  assert.match(generationHandler, /checkpointForRun\?\.runKey === generationRunKey[\s\S]+checkpointForRun\.files/);
  assert.match(generationHandler, /if \(sourceScopeIssues\.length > 0\) \{\s*setSolutionGenerationCheckpoint\(null\)/);
  assert.doesNotMatch(generationHandler, /solutionGenerationCheckpoint\?\.runKey === generationRunKey/);
  assert.match(page, /Retry package from reviewed decisions/);
  assert.match(page, /handleGenerateFinalPackage\(\{ freshPackage: true \}\)/);
  assert.match(page, /disabled=\{deepReviewRunning \|\| deployOperationActive \|\| deployInFlight \|\| deployHandoffLocksBranch \|\| !reviewChunksComplete/);
});

test('AI Semantic Studio remains independent while the legacy BI Migration route explains retirement', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const retiredPage = source('src/pages/RetiredBiMigrationPage.tsx');
  const app = source('src/App.tsx');
  const sidebar = source('src/components/layout/Sidebar.tsx');
  const connectionGuard = source('src/components/layout/RequireConnection.tsx');

  assert.doesNotMatch(topicsPage, /SemanticMigrationImportPanel|studioMode/);
  assert.match(retiredPage, /BI Migration Studio retired/);
  assert.match(retiredPage, /do not load source connectors, credentials, migration jobs, or the former migration engine/);
  assert.match(app, /path="\/semantic-migrations"[\s\S]+?<RetiredBiMigrationPage \/>/);
  assert.doesNotMatch(sidebar, /to: '\/semantic-migrations'/);
  assert.doesNotMatch(connectionGuard, /'\/semantic-migrations':/);
});

test('AI Semantic Studio revalidates preserved existing-topic relationships before writes', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');

  assert.match(topicsPage, /deferTopicRelationshipValidation: selectedPathIncludesTopic && Boolean\(selectedTopicName\)/);
  assert.match(topicsPage, /sourceTopicYaml: authoredTopicSourceYaml \|\| undefined/);
  assert.ok(
    topicsPage.indexOf('sourceTopicYaml: authoredTopicSourceYaml || undefined')
      < topicsPage.indexOf('stageGovernedTopicMutation(connection, governedTopicBranch'),
  );
});
