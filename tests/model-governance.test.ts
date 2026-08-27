import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import {
  applyLabelPatches,
  buildLabelPatternValue,
  buildStaleViewCandidates,
  countContentReferences,
  findFilesChangedSinceLoad,
  normalizeContentReferences,
  parseSemanticInventory,
} from '../src/services/modelGovernance';
import {
  countContentValidationIssues,
  createReviewedModelPullRequestHandoff,
  discardReviewedModelBranch,
  normalizeModelGitCapability,
  prepareReviewedModelHandoff,
  ReviewedPullRequestVerificationError,
  validateReviewedModelBranch,
  type ReviewedModelBranch,
} from '../src/services/reviewedModelWrite';
import {
  approveReleaseGate,
  collectTargetedAffectedContent,
  collectReleaseGateEvidence,
  reconcileReleaseGateApproval,
  type ReleaseGateEvidenceApi,
} from '../src/services/releaseGateEvidence';
import { ApiError, deleteModelYamlFile } from '../src/services/omniApi';
import { apiMiddleware } from '../server/apiMiddleware';
import { OmniClient, normalizeOmniAiJobResult } from '../server/services/omniClient';

const fixtureFiles = {
  'topics/sales.topic': `base_view: orders
label: Sales Topic
description: Revenue reporting
`,
  'views/orders.view': `label: Orders
# keep this model context
dimensions:
  city:
    sql: city
  state:
    group_label: Location
    sql: state
measures:
  total_sales:
    group_label: Revenue
    aggregate_type: sum
`,
  'views/stale_orders.view': `label: Stale Orders
dimensions:
  order_id:
    sql: order_id
`,
};

const browserConnection = {
  baseUrl: 'https://example.omniapp.co',
  apiKey: 'vault-ref-governance',
  status: 'success' as const,
  errorMessage: '',
};

function reviewedBranch(pullRequestRequired = false, gitConfigured = pullRequestRequired): ReviewedModelBranch {
  return {
    modelId: 'model-a',
    branchId: 'branch-a',
    branchName: 'governance-review',
    capability: {
      editable: true,
      gitConfigured,
      gitConfigurationKnown: true,
      gitFollower: false,
      pullRequestRequired,
    },
  };
}

test('model governance parses topics, views, and field group labels', () => {
  const inventory = parseSemanticInventory(fixtureFiles);

  assert.deepEqual(inventory.topics.map((topic) => [topic.name, topic.label]), [['sales', 'Sales Topic']]);
  assert.deepEqual(inventory.views.map((view) => [view.name, view.label]), [
    ['orders', 'Orders'],
    ['stale_orders', 'Stale Orders'],
  ]);
  assert.equal(inventory.fields.find((field) => field.name === 'state')?.groupLabel, 'Location');
  assert.equal(inventory.fields.find((field) => field.name === 'total_sales')?.kind, 'measure');
});

test('model governance applies topic, view, and field label patches by file', () => {
  const result = applyLabelPatches(fixtureFiles, [
    { kind: 'topic', fileName: 'topics/sales.topic', name: 'sales', before: 'Sales Topic', after: 'Executive Sales' },
    { kind: 'view', fileName: 'views/orders.view', name: 'orders', before: 'Orders', after: 'Order Facts' },
    { kind: 'field', fileName: 'views/orders.view', viewName: 'orders', fieldName: 'city', fieldKind: 'dimension', before: '', after: 'Location > Address' },
    { kind: 'field', fileName: 'views/orders.view', viewName: 'orders', fieldName: 'state', fieldKind: 'dimension', before: 'Location', after: '' },
  ]);

  assert.equal(result.changedFiles.length, 2);
  const topicYaml = result.changedFiles.find((file) => file.fileName === 'topics/sales.topic')?.yaml || '';
  const viewYaml = result.changedFiles.find((file) => file.fileName === 'views/orders.view')?.yaml || '';
  assert.match(topicYaml, /^label: Executive Sales/m);
  assert.match(viewYaml, /^label: Order Facts/m);
  assert.match(viewYaml, /city:\n {4}sql: city\n {4}group_label: Location > Address/m);
  assert.doesNotMatch(viewYaml, /state:\n {4}group_label:/m);
  assert.match(viewYaml, /# keep this model context/);
});

test('model governance stale candidates require zero-reference content signal for safe select', () => {
  const inventory = parseSemanticInventory(fixtureFiles);
  const contentCounts = countContentReferences({ dashboards: [{ query: 'orders.total_sales' }] }, ['orders', 'stale_orders']);
  const candidates = buildStaleViewCandidates({
    inventory,
    validationIssues: [{
      message: 'View stale_orders does not exist in the source database',
      yaml_path: 'views/stale_orders.view',
    }, {
      message: 'View orders has a referenced field warning',
      yaml_path: 'views/orders.view',
      is_warning: true,
    }],
    contentReferenceCounts: contentCounts,
  });

  const stale = candidates.find((candidate) => candidate.viewName === 'stale_orders');
  const orders = candidates.find((candidate) => candidate.viewName === 'orders');
  assert.equal(stale?.confidence, 'high');
  assert.equal(stale?.safeByDefault, true);
  assert.equal(orders?.safeByDefault, false);
  assert.equal(orders?.referencedByCount, 1);
});

test('model governance label patterns support bulk transforms', () => {
  assert.equal(buildLabelPatternValue({ name: 'total_sales', current: '', mode: 'title-case', value: '' }), 'Total Sales');
  assert.equal(buildLabelPatternValue({ name: 'orders', current: 'Orders', mode: 'prefix', value: 'Demo - ' }), 'Demo - Orders');
  assert.equal(buildLabelPatternValue({ name: 'orders', current: 'Old Orders', mode: 'find-replace', find: 'Old', value: 'New' }), 'New Orders');
  assert.equal(buildLabelPatternValue({ name: 'orders', current: 'Orders', mode: 'clear', value: '' }), '');
});

test('stale view matching is exact for similarly named views', () => {
  const inventory = parseSemanticInventory(fixtureFiles);
  const candidates = buildStaleViewCandidates({
    inventory,
    validationIssues: [{
      message: 'View stale_orders does not exist in the source database',
      yaml_path: 'views/stale_orders.view',
    }],
    contentReferences: { stale_orders: [] },
  });

  assert.deepEqual(candidates.map((candidate) => candidate.viewName), ['stale_orders']);
  assert.equal(candidates[0]?.safeByDefault, true);
});

test('stale view candidates fail closed until exact content references are verified', () => {
  const inventory = parseSemanticInventory(fixtureFiles);
  const unknown = buildStaleViewCandidates({
    inventory,
    validationIssues: [{ message: 'No view "stale_orders"', yaml_path: 'views/stale_orders.view' }],
  });
  const failed = buildStaleViewCandidates({
    inventory,
    validationIssues: [{ message: 'No view "stale_orders"', yaml_path: 'views/stale_orders.view' }],
    referenceErrors: { stale_orders: 'Forbidden' },
  });

  assert.equal(unknown[0]?.referenceStatus, 'unknown');
  assert.equal(unknown[0]?.safeByDefault, false);
  assert.equal(failed[0]?.referenceStatus, 'failed');
  assert.equal(failed[0]?.safeByDefault, false);
});

test('content validator results normalize into concrete referenced content', () => {
  const references = normalizeContentReferences({
    content: [{
      document_id: 'doc-1',
      identifier: 'sales-dashboard',
      name: 'Sales Dashboard',
      type: 'Published',
      folder: { path: '/Finance' },
      owner: { name: 'Analyst' },
      queries_and_issues: [{ query_name: 'Revenue' }, { query_name: 'Margin' }],
    }],
  });

  assert.deepEqual(references, [{
    documentId: 'doc-1',
    identifier: 'sales-dashboard',
    name: 'Sales Dashboard',
    type: 'Published',
    updatedAt: undefined,
    folderPath: '/Finance',
    ownerName: 'Analyst',
    queryNames: ['Revenue', 'Margin'],
  }]);
});

test('model governance capabilities block schema and follower writes and preserve PR handoff', () => {
  const schema = normalizeModelGitCapability({ id: 'schema', name: 'Schema', kind: 'SCHEMA' });
  const follower = normalizeModelGitCapability(
    { id: 'shared', name: 'Follower', kind: 'SHARED' },
    { gitFollower: true, requirePullRequest: 'always' },
  );
  const protectedShared = normalizeModelGitCapability(
    { id: 'shared', name: 'Shared', kind: 'SHARED' },
    { gitFollower: false, requirePullRequest: 'users-only' },
  );

  assert.equal(schema.editable, false);
  assert.equal(follower.editable, false);
  assert.equal(protectedShared.editable, true);
  assert.equal(protectedShared.pullRequestRequired, true);
});

test('OmniClient deletes a branch through the documented model branch route', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://example.omniapp.co', apiKey: 'governance-delete-token' });
  await client.deleteModelBranch('model-a', 'cleanup branch');

  assert.equal(new URL(requestedUrl).pathname, '/api/v1/models/model-a/branch/cleanup%20branch');
});

test('browser model YAML delete preserves branch-scoped query parameters through the proxy', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await deleteModelYamlFile('https://example.omniapp.co', 'vault-ref', {
    modelId: 'model-a',
    fileName: 'topics/orders.topic',
    branchId: 'branch-a',
    mode: 'combined',
    commitMessage: 'Stage reviewed topic removal',
  });

  assert.equal(requestBody.method, 'DELETE');
  assert.equal(requestBody.endpoint, '/v1/models/model-a/yaml');
  assert.deepEqual(requestBody.query_params, {
    fileName: 'topics/orders.topic',
    branchId: 'branch-a',
    mode: 'combined',
    commitMessage: 'Stage reviewed topic removal',
  });
});

test('local API middleware and Omni proxy preserve model YAML delete query parameters end to end', async (t) => {
  let requestedUrl = '';
  let requestedMethod = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedMethod = String(init?.method || 'GET');
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const requestBody = JSON.stringify({
    base_url: 'https://example.omniapp.co',
    api_key: 'server-side-test-reference',
    method: 'DELETE',
    endpoint: '/v1/models/model-a/yaml',
    query_params: {
      fileName: 'topics/orders.topic',
      branchId: 'branch-a',
      mode: 'combined',
      commitMessage: 'Stage reviewed topic removal',
    },
  });
  const request = Readable.from([Buffer.from(requestBody)]) as IncomingMessage;
  request.method = 'POST';
  request.url = '/api/omni-proxy';
  request.headers = {
    host: '127.0.0.1:5175',
    origin: 'http://127.0.0.1:5175',
    'content-type': 'application/json',
  };

  const responseChunks: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      responseChunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse;
  response.statusCode = 200;
  response.setHeader = (() => response) as ServerResponse['setHeader'];

  const finished = once(response, 'finish');
  await apiMiddleware()(request, response);
  await finished;

  const outbound = new URL(requestedUrl);
  assert.equal(requestedMethod, 'DELETE');
  assert.equal(outbound.pathname, '/api/v1/models/model-a/yaml');
  assert.equal(outbound.searchParams.get('fileName'), 'topics/orders.topic');
  assert.equal(outbound.searchParams.get('branchId'), 'branch-a');
  assert.equal(outbound.searchParams.get('mode'), 'combined');
  assert.equal(outbound.searchParams.get('commitMessage'), 'Stage reviewed topic removal');
  assert.deepEqual(JSON.parse(Buffer.concat(responseChunks).toString('utf8')), { success: true });
});

test('OmniClient sends branch_id for reviewed schema refreshes', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ status: 'running' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://example.omniapp.co', apiKey: 'governance-refresh-token' });
  await client.refreshModel('model-a', 'branch-a');
  const url = new URL(requestedUrl);

  assert.equal(url.pathname, '/api/v1/models/model-a/refresh');
  assert.equal(url.searchParams.get('branch_id'), 'branch-a');
});

test('Omni AI job normalization accepts documented state responses and legacy status responses', () => {
  assert.deepEqual(normalizeOmniAiJobResult({
    id: 'job-state',
    state: 'COMPLETE',
    resultSummary: 'Finished',
  }), {
    id: 'job-state',
    status: 'COMPLETE',
    result: undefined,
    raw: {
      id: 'job-state',
      state: 'COMPLETE',
      resultSummary: 'Finished',
    },
  });
  assert.equal(normalizeOmniAiJobResult({
    job: { id: 'job-nested', status: 'RUNNING' },
  }).status, 'RUNNING');
  assert.equal(normalizeOmniAiJobResult({}, 'job-fallback').id, 'job-fallback');
});

test('checksum comparison rejects files changed after the labeling inventory loaded', () => {
  assert.deepEqual(findFilesChangedSinceLoad({
    affectedFiles: ['orders.view', 'customers.view'],
    originalFiles: { 'orders.view': 'label: Orders', 'customers.view': 'label: Customers' },
    originalChecksums: { 'orders.view': 'old-orders', 'customers.view': 'same-customers' },
    branchFiles: { 'orders.view': 'label: New Orders', 'customers.view': 'label: Customers' },
    branchChecksums: { 'orders.view': 'new-orders', 'customers.view': 'same-customers' },
  }), ['orders.view']);
});

test('OmniClient content validation supports exact view-reference queries', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ content: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://example.omniapp.co', apiKey: 'governance-content-token' });
  await client.validateModelContent('model-a', {
    find: 'orders',
    findType: 'VIEW',
    includePersonalFolders: true,
  });
  const url = new URL(requestedUrl);

  assert.equal(url.searchParams.get('find'), 'orders');
  assert.equal(url.searchParams.get('find_type'), 'VIEW');
  assert.equal(url.searchParams.get('include_personal_folders'), 'true');
});

test('reviewed model validation counts query and dashboard-filter issues', () => {
  assert.equal(countContentValidationIssues({
    content: [{
      queries_and_issues: [{ issues: ['Missing field', 'Missing view'] }],
      dashboard_filter_issues: ['Missing filter'],
    }],
  }), 3);
});

test('reviewed model handoff leaves an unprotected validated branch for manual Omni sign-off without an API mutation', async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await prepareReviewedModelHandoff(browserConnection, reviewedBranch(false), 'Review labels');

  assert.equal(result.mode, 'manual_handoff');
  assert.match(result.message, /did not merge or publish/i);
  assert.equal(result.url, browserConnection.baseUrl);
  assert.equal(fetchCalls, 0);
});

test('reviewed governance UI paths do not import or call an automatic branch merge helper', () => {
  const paths = [
    '../src/components/modelGovernance/ModelLabelingPanel.tsx',
    '../src/components/modelGovernance/ViewCleanupPanel.tsx',
    '../src/components/semanticStudio/ReviewedTopicDeletePanel.tsx',
    '../src/services/reviewedModelWrite.ts',
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /mergeModelBranch|publishReviewedModelBranch|\/branch\/[^\s'"`]+\/merge/);
  }
});

test('governed release UI callers provide explicit scoped impact evidence', () => {
  const labeling = readFileSync(new URL('../src/components/modelGovernance/ModelLabelingPanel.tsx', import.meta.url), 'utf8');
  const cleanup = readFileSync(new URL('../src/components/modelGovernance/ViewCleanupPanel.tsx', import.meta.url), 'utf8');
  const topicDelete = readFileSync(new URL('../src/components/semanticStudio/ReviewedTopicDeletePanel.tsx', import.meta.url), 'utf8');
  const evidencePanel = readFileSync(new URL('../src/components/modelGovernance/ReleaseGateEvidencePanel.tsx', import.meta.url), 'utf8');

  assert.match(labeling, /basis:\s*'metadata_only_label_change'/);
  assert.ok((cleanup.match(/collectTargetedAffectedContent\(/g) || []).length >= 4);
  assert.ok((topicDelete.match(/collectTargetedAffectedContent\(/g) || []).length >= 2);
  assert.doesNotMatch(evidencePanel, /No affected content items were returned/);
});

test('reviewed model handoff creates a PR for protected models', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      pr_url: 'https://github.example/pr/12',
      git_sha: 'abc123def456',
      in_sync: true,
      did_sync: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await prepareReviewedModelHandoff(browserConnection, reviewedBranch(true), 'Review labels');

  assert.equal(result.mode, 'pull_request');
  assert.equal(result.url, 'https://github.example/pr/12');
  assert.equal(result.commitRef, 'abc123def456');
  assert.equal(result.inSync, true);
  assert.equal(result.didSync, false);
  assert.equal(requestBody.endpoint, '/v1/models/model-a/git/commit');
  assert.equal((requestBody.body as Record<string, unknown>).require_branch_exists, false);
});

function releaseEvidenceApi(input: {
  branchYaml?: string;
  branchChecksum?: string;
  requirePullRequest?: 'always' | 'never';
  extraBranchFile?: boolean;
  gitNotConfigured?: boolean;
  callerHasModelAccess?: boolean;
  modelValidationResponse?: unknown;
  mainContentValidationResponse?: unknown;
  branchContentValidationResponse?: unknown;
  dbtConfigResponse?: unknown;
  dbtEnvironmentsResponse?: unknown;
} = {}): ReleaseGateEvidenceApi {
  const branchYaml = input.branchYaml || 'label: Reviewed orders';
  const branchChecksum = input.branchChecksum || 'branch-checksum-1';
  const requirePullRequest = input.requirePullRequest || 'never';
  return {
    getModelYaml: async (_baseUrl, _apiKey, _modelId, options) => options?.branchId
      ? {
          files: {
            'orders.view': branchYaml,
            ...(input.extraBranchFile ? { 'unreviewed.view': 'label: Unreviewed' } : {}),
          },
          checksums: {
            'orders.view': branchChecksum,
            ...(input.extraBranchFile ? { 'unreviewed.view': 'unreviewed-checksum' } : {}),
          },
        }
      : { files: { 'orders.view': 'label: Orders' }, checksums: { 'orders.view': 'main-checksum-1' } },
    getModelGitConfiguration: async () => {
      if (input.gitNotConfigured) throw new ApiError(404, 'Git configuration not found');
      return { requirePullRequest };
    },
    validateModel: async () => (
      input.modelValidationResponse === undefined ? [] : input.modelValidationResponse
    ) as Awaited<ReturnType<ReleaseGateEvidenceApi['validateModel']>>,
    validateModelContent: async (_baseUrl, _apiKey, _modelId, options) => {
      const branchId = typeof options === 'string' ? options : options?.branchId;
      return (
        branchId
          ? input.branchContentValidationResponse ?? { content: [] }
          : input.mainContentValidationResponse ?? { content: [] }
      ) as Awaited<ReturnType<ReleaseGateEvidenceApi['validateModelContent']>>;
    },
    getCurrentCaller: async () => ({
      keyScope: 'user',
      orgRole: 'MEMBER',
      user: { id: 'caller-user', membershipId: 'caller-membership' },
      rolesByModel: input.callerHasModelAccess === false
        ? {}
        : { 'model-a': { permissions: ['EDIT_MODEL'] } },
      rolesByModelTruncated: false,
    }),
    getConnectionDbt: async () => input.dbtConfigResponse === undefined
      ? {
          supportsDbt: true,
          autogenRelationships: true,
          branch: 'main',
          dbtVersion: 'Auto',
          enableSemanticLayer: false,
          enableVirtualSchemas: true,
          projectRootPath: 'dbt_project',
          sshUrl: 'git@example.invalid:example/dbt.git',
        }
      : input.dbtConfigResponse,
    getConnectionDbtEnvironments: async () => input.dbtEnvironmentsResponse === undefined
      ? [{
          id: 'environment-a',
          name: 'Production',
          isDefaultEnvironment: true,
          ownerId: 'owner-a',
          variables: [{ name: 'PRIVATE_TOKEN', value: 'fixture-secret-value', isSecret: true }],
        }]
      : input.dbtEnvironmentsResponse,
  };
}

const releaseAffectedContent = [{
  documentId: 'example-document-a',
  identifier: 'example-document',
  name: 'Example document',
  type: 'Workbook',
  queryNames: ['Example query'],
}];

const releaseAffectedContentScope = {
  state: 'verified' as const,
  basis: 'targeted_content_validator' as const,
  targets: [{ type: 'VIEW' as const, name: 'orders' }],
};

test('release-gate approval is invalidated by checksum, fingerprint, or Git handoff state drift', async () => {
  const model = {
    id: 'model-a',
    name: 'Example shared model',
    kind: 'SHARED',
    connectionId: 'connection-a',
    connectionName: 'Example warehouse',
  };
  const initial = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi());
  const approval = approveReleaseGate(initial);

  assert.equal(initial.status, 'ready_for_manual_handoff');
  assert.deepEqual(initial.checks.map((check) => check.id), [
    'connection',
    'caller',
    'dbt',
    'dbt_environments',
    'git',
    'branch',
    'checksums',
    'model_validation',
    'content_validation',
    'affected_content',
    'diff',
    'handoff',
  ]);
  assert.ok(approval);
  assert.equal(reconcileReleaseGateApproval(approval, initial), approval);
  const unchangedRefresh = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi());
  assert.equal(unchangedRefresh.fingerprint, initial.fingerprint);
  assert.equal(reconcileReleaseGateApproval(approval, unchangedRefresh), approval);

  const callerWithoutModelAccess = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi({ callerHasModelAccess: false }));
  assert.equal(callerWithoutModelAccess.status, 'blocked');
  assert.match(callerWithoutModelAccess.blockers.join(' '), /did not return effective permissions for this model/i);

  const noGitConfiguration = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi({ gitNotConfigured: true }));
  assert.equal(noGitConfiguration.status, 'ready_for_manual_handoff');
  assert.equal(noGitConfiguration.git?.configured, false);

  const checksumDrift = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi({ branchYaml: 'label: Changed after approval', branchChecksum: 'branch-checksum-2' }));
  assert.notEqual(checksumDrift.fingerprint, initial.fingerprint);
  assert.equal(reconcileReleaseGateApproval(approval, checksumDrift), null);

  const unreviewedBranchDrift = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi({ extraBranchFile: true }));
  assert.equal(unreviewedBranchDrift.status, 'blocked');
  assert.match(unreviewedBranchDrift.blockers.join(' '), /outside the reviewed scope: unreviewed\.view/i);
  assert.equal(reconcileReleaseGateApproval(approval, unreviewedBranchDrift), null);

  const protectedState = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi({ requirePullRequest: 'always' }));
  assert.equal(protectedState.status, 'ready_for_pull_request');
  assert.equal(reconcileReleaseGateApproval(approval, protectedState), null);
});

test('release gate fails closed on malformed successful validation responses', async () => {
  const model = {
    id: 'model-a',
    name: 'Example shared model',
    kind: 'SHARED',
    connectionId: 'connection-a',
    connectionName: 'Example warehouse',
  };
  const input = {
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  };

  const malformedModelValidation = await collectReleaseGateEvidence(
    input,
    releaseEvidenceApi({ modelValidationResponse: { success: true } }),
  );
  assert.equal(malformedModelValidation.status, 'blocked');
  assert.equal(malformedModelValidation.validation.blocking, true);
  assert.equal(malformedModelValidation.checks.find((check) => check.id === 'model_validation')?.status, 'blocked');
  assert.equal(malformedModelValidation.checks.find((check) => check.id === 'content_validation')?.status, 'ready');
  assert.match(malformedModelValidation.blockers.join(' '), /expected issue-array contract/i);

  const malformedContentValidation = await collectReleaseGateEvidence(
    input,
    releaseEvidenceApi({ branchContentValidationResponse: { ok: true } }),
  );
  assert.equal(malformedContentValidation.status, 'blocked');
  assert.equal(malformedContentValidation.validation.blocking, true);
  assert.equal(malformedContentValidation.checks.find((check) => check.id === 'model_validation')?.status, 'ready');
  assert.equal(malformedContentValidation.checks.find((check) => check.id === 'content_validation')?.status, 'blocked');
  assert.match(malformedContentValidation.blockers.join(' '), /expected content-array contract/i);

  const contentErrorEnvelope = await collectReleaseGateEvidence(
    input,
    releaseEvidenceApi({
      branchContentValidationResponse: { content: [], error: { message: 'Upstream failure' } },
    }),
  );
  assert.equal(contentErrorEnvelope.status, 'blocked');
  assert.equal(contentErrorEnvelope.checks.find((check) => check.id === 'content_validation')?.status, 'blocked');
  assert.match(contentErrorEnvelope.blockers.join(' '), /error envelope/i);
});

test('release gate requires scoped affected-content evidence independently of validator cleanliness', async () => {
  const model = {
    id: 'model-a',
    name: 'Example shared model',
    kind: 'SHARED',
    connectionId: 'connection-a',
    connectionName: 'Example warehouse',
  };
  const withoutInventory = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
  }, releaseEvidenceApi());

  assert.equal(withoutInventory.status, 'blocked');
  assert.equal(withoutInventory.checks.find((check) => check.id === 'content_validation')?.status, 'ready');
  assert.equal(withoutInventory.checks.find((check) => check.id === 'affected_content')?.status, 'unavailable');
  assert.deepEqual(withoutInventory.affectedContent, []);
  assert.match(withoutInventory.blockers.join(' '), /independent affected-content inventory or impact-scope evidence/i);

  const explicitZeroInventory = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: [],
  }, releaseEvidenceApi());
  assert.equal(explicitZeroInventory.status, 'blocked');
  assert.equal(explicitZeroInventory.checks.find((check) => check.id === 'affected_content')?.status, 'unavailable');
  assert.match(
    explicitZeroInventory.checks.find((check) => check.id === 'affected_content')?.detail || '',
    /valid independent scope and basis/i,
  );

  const scopedZeroInventory = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: [],
    affectedContentScope: releaseAffectedContentScope,
  }, releaseEvidenceApi());
  assert.equal(scopedZeroInventory.status, 'ready_for_manual_handoff');
  assert.equal(scopedZeroInventory.checks.find((check) => check.id === 'affected_content')?.status, 'ready');
  assert.match(
    scopedZeroInventory.checks.find((check) => check.id === 'affected_content')?.detail || '',
    /zero matching content items across 1 exact semantic target/i,
  );
  assert.match(
    scopedZeroInventory.checks.find((check) => check.id === 'affected_content')?.detail || '',
    /not a model-wide zero-impact claim/i,
  );

  const metadataOnlyScope = await collectReleaseGateEvidence({
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContentScope: {
      state: 'metadata_only',
      basis: 'metadata_only_label_change',
      targets: [{ type: 'FIELD_GROUP', name: 'orders.order_id' }],
    },
  }, releaseEvidenceApi());
  assert.equal(metadataOnlyScope.status, 'ready_for_manual_handoff');
  assert.deepEqual(metadataOnlyScope.affectedContent, []);
  assert.match(
    metadataOnlyScope.checks.find((check) => check.id === 'affected_content')?.detail || '',
    /consumer content was not inventoried, and no zero-impact claim is made/i,
  );
});

test('targeted affected-content collection is exact, bounded, and fail closed', async () => {
  const calls: Array<{ find?: string; findType?: string; includePersonalFolders?: boolean }> = [];
  const verified = await collectTargetedAffectedContent(
    browserConnection,
    'model-a',
    [{ type: 'TOPIC', name: 'Example topic' }],
    {
      validateModelContent: async (_baseUrl, _apiKey, _modelId, options) => {
        if (typeof options === 'object') calls.push(options);
        return {
          content: [{
            document_id: 'document-a',
            identifier: 'example-document',
            name: 'Example document',
            type: 'Workbook',
            dashboard_filter_issues: [],
            queries_and_issues: [],
          }],
        };
      },
    },
  );
  assert.deepEqual(calls, [{ find: 'Example topic', findType: 'TOPIC', includePersonalFolders: true }]);
  assert.equal(verified.affectedContentScope.state, 'verified');
  assert.equal(verified.affectedContent?.length, 1);

  let oversizedCalls = 0;
  const oversized = await collectTargetedAffectedContent(
    browserConnection,
    'model-a',
    Array.from({ length: 26 }, (_, index) => ({ type: 'VIEW', name: `view_${index}` })),
    {
      validateModelContent: async () => {
        oversizedCalls += 1;
        return { content: [] };
      },
    },
  );
  assert.equal(oversizedCalls, 0);
  assert.equal(oversized.affectedContentScope.state, 'unavailable');
  assert.match(oversized.affectedContentScope.reason || '', /bounded 25-lookup limit/i);

  const malformed = await collectTargetedAffectedContent(
    browserConnection,
    'model-a',
    [{ type: 'VIEW', name: 'orders' }],
    { validateModelContent: async () => ({ content: [], error: { message: 'Upstream failure' } }) },
  );
  assert.equal(malformed.affectedContentScope.state, 'unavailable');
  assert.match(malformed.affectedContentScope.reason || '', /did not match the expected contract/i);
});

test('release gate verifies dbt environments with aggregate-only evidence', async () => {
  const model = {
    id: 'model-a',
    name: 'Example shared model',
    kind: 'SHARED',
    connectionId: 'connection-a',
    connectionName: 'Example warehouse',
  };
  const input = {
    connection: browserConnection,
    model,
    branch: reviewedBranch(false, true),
    affectedFiles: ['orders.view'],
    affectedContent: releaseAffectedContent,
    affectedContentScope: releaseAffectedContentScope,
  };
  const verified = await collectReleaseGateEvidence(input, releaseEvidenceApi());
  assert.deepEqual(verified.dbtEnvironments, {
    state: 'verified',
    environmentCount: 1,
    defaultEnvironmentCount: 1,
  });
  assert.equal(verified.checks.find((check) => check.id === 'dbt_environments')?.status, 'ready');
  const serialized = JSON.stringify(verified);
  assert.doesNotMatch(serialized, /fixture-secret-value|PRIVATE_TOKEN|owner-a|environment-a/);

  const malformed = await collectReleaseGateEvidence(
    input,
    releaseEvidenceApi({ dbtEnvironmentsResponse: { environments: [] } }),
  );
  assert.equal(malformed.status, 'blocked');
  assert.equal(malformed.dbtEnvironments, null);
  assert.match(malformed.blockers.join(' '), /environment inventory was unavailable or did not match/i);

  const duplicateDefaults = await collectReleaseGateEvidence(
    input,
    releaseEvidenceApi({
      dbtEnvironmentsResponse: [
        { id: 'environment-a', name: 'Production', isDefaultEnvironment: true },
        { id: 'environment-b', name: 'Development', isDefaultEnvironment: true },
      ],
    }),
  );
  assert.equal(duplicateDefaults.status, 'blocked');
  assert.match(duplicateDefaults.blockers.join(' '), /2 defaults; exactly one default is required/i);

  const notConfigured = await collectReleaseGateEvidence(
    input,
    releaseEvidenceApi({
      dbtConfigResponse: { message: 'dbt not configured for this connection', supportsDbt: true },
      dbtEnvironmentsResponse: { error: 'not applicable' },
    }),
  );
  assert.equal(notConfigured.status, 'ready_for_manual_handoff');
  assert.deepEqual(notConfigured.dbtEnvironments, { state: 'not_applicable' });
  assert.match(
    notConfigured.checks.find((check) => check.id === 'dbt_environments')?.detail || '',
    /not applicable because dbt is not configured/i,
  );
});

test('PR-only reviewed handoff refuses an unprotected model without merging', async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await assert.rejects(
    createReviewedModelPullRequestHandoff(browserConnection, reviewedBranch(false), 'Review labels'),
    /PR-only\. No merge was attempted/,
  );
  assert.equal(fetchCalls, 0);
});

test('PR-only reviewed handoff commits a protected branch for review', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      pr_url: 'https://github.example/pr/13',
      git_sha: 'def456abc123',
      in_sync: true,
      did_sync: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await createReviewedModelPullRequestHandoff(
    browserConnection,
    reviewedBranch(true),
    'Review labels',
  );

  assert.equal(result.mode, 'pull_request');
  assert.equal(result.url, 'https://github.example/pr/13');
  assert.equal(result.commitRef, 'def456abc123');
  assert.equal(result.inSync, true);
  assert.equal(result.didSync, false);
  assert.equal(requestBody.endpoint, '/v1/models/model-a/git/commit');
  assert.equal((requestBody.body as Record<string, unknown>).require_branch_exists, false);
});

test('PR-only reviewed handoff rejects a success response without a review URL', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => (
    new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ));

  await assert.rejects(
    createReviewedModelPullRequestHandoff(
      browserConnection,
      reviewedBranch(true),
      'Review labels',
    ),
    (error: unknown) => (
      error instanceof ReviewedPullRequestVerificationError
      && /without complete, in-sync review evidence/i.test(error.message)
      && error.mutationMayHaveSucceeded
    ),
  );
});

test('PR-only reviewed handoff rejects unsafe or incomplete review evidence', async (t) => {
  const responses = [
    { pr_url: 'javascript:alert(1)', git_sha: 'abc1234', in_sync: true, did_sync: false },
    { pr_url: 'https://github.example/pr/14', in_sync: true, did_sync: false },
    { pr_url: 'https://github.example/pr/15', git_sha: 'abc1234', in_sync: false, did_sync: false },
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => (
    new Response(JSON.stringify(responses[index++]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ));

  for (const expectedUrl of [undefined, 'https://github.example/pr/14', 'https://github.example/pr/15']) {
    await assert.rejects(
      createReviewedModelPullRequestHandoff(
        browserConnection,
        reviewedBranch(true),
        'Review labels',
      ),
      (error: unknown) => (
        error instanceof ReviewedPullRequestVerificationError
        && error.reviewUrl === expectedUrl
        && error.mutationMayHaveSucceeded
      ),
    );
  }
});

test('PR-only reviewed handoff quarantines a response that reports model synchronization', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => (
    new Response(JSON.stringify({
      pr_url: 'https://github.example/pr/16',
      git_sha: 'abc123def456',
      in_sync: true,
      did_sync: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ));

  await assert.rejects(
    createReviewedModelPullRequestHandoff(browserConnection, reviewedBranch(true), 'Review labels'),
    (error: unknown) => (
      error instanceof ReviewedPullRequestVerificationError
      && /synchronization occurred/i.test(error.message)
      && error.reviewUrl === 'https://github.example/pr/16'
      && error.commitRef === 'abc123def456'
    ),
  );
});

test('reviewed branch validation blocks model and content errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { endpoint?: string };
    if (body.endpoint?.endsWith('/validate')) {
      return new Response(JSON.stringify([{ message: 'Broken relationship', is_warning: false }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ content: [{ queries_and_issues: [{ issues: ['Missing field'] }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const validation = await validateReviewedModelBranch(browserConnection, reviewedBranch(false));

  assert.equal(validation.blocking, true);
  assert.equal(validation.modelIssues.length, 1);
  assert.equal(validation.contentIssueCount, 1);
});

test('reviewed branch discard uses the base model and branch name', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await discardReviewedModelBranch(browserConnection, reviewedBranch(false));

  assert.equal(requestBody.method, 'DELETE');
  assert.equal(requestBody.endpoint, '/v1/models/model-a/branch/governance-review');
});
