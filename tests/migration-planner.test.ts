import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instancesHandler from '../server/handlers/instances';
import migrationJobsHandler from '../server/handlers/migration-jobs';
import { buildMigrationPlan, createMigrationJob, extractQueryViewReferences, getJob, mergeSemanticPatchCandidates, retryMigrationJob, validateDashboardMigrationPatches } from '../server/services/migrationJobs';
import { OmniClient, OmniClientError, type OmniDocumentQueryRecord, type OmniDocumentRecord, type OmniQueryExecutionSummary, type OmniValidationIssue } from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { clearReadThroughCache } from '../server/services/readThroughCache';

const realRunQuery = OmniClient.prototype.runQuery;
const realUpdateModelYamlFiles = OmniClient.prototype.updateModelYamlFiles;
let tempDir = '';
let documentQueriesMock: (documentId: string) => Promise<OmniDocumentQueryRecord[]>;
let queryExecutionMock: (query: Record<string, unknown>) => Promise<OmniQueryExecutionSummary>;
let modelValidationMock: (modelId: string, branchId?: string) => Promise<OmniValidationIssue[]>;
let contentValidationMock: (modelId: string, options?: string | { branchId?: string }) => Promise<Record<string, unknown>>;

beforeEach(() => {
  clearReadThroughCache();
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-planner-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(tempDir, 'omnikit-jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(tempDir, 'jobs.json');
  unlockVault('planner passphrase');
  documentQueriesMock = async () => [];
  queryExecutionMock = async () => ({ status: 'COMPLETE', rowCount: 1 });
  modelValidationMock = async () => [];
  contentValidationMock = async () => ({ issues: [] });
  mock.method(OmniClient.prototype, 'getDocumentQueries', async (documentId: string) => documentQueriesMock(documentId));
  mock.method(OmniClient.prototype, 'runQuery', async (query: Record<string, unknown>) => queryExecutionMock(query));
  mock.method(OmniClient.prototype, 'validateModel', async (modelId: string, branchId?: string) => modelValidationMock(modelId, branchId));
  mock.method(OmniClient.prototype, 'validateModelContent', async (modelId: string, options?: string | { branchId?: string }) => contentValidationMock(modelId, options));
});

afterEach(() => {
  clearReadThroughCache();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

function clientLabel(client: OmniClient): string {
  return (client as unknown as { instance: { label: string } }).instance.label;
}

function emptyMetricFilter() {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

test('query-view dependency extraction ignores prose while preserving executable references', () => {
  const references = extractQueryViewReferences([
    'description: Location type (e.g., standalone or strip mall).',
    'ai_context: Compare U.S. regions in business-friendly language.',
    'sql: SELECT * FROM ${orders}',
    'dimensions:',
    '  revenue_ratio:',
    '    sql: ${orders.revenue} / NULLIF(${targets.revenue}, 0)',
  ].join('\n'));

  assert.deepEqual(references, ['orders', 'targets']);
});

test('semantic patch refresh recognizes YAML already applied by an earlier failed run', () => {
  const acceptedYaml = [
    'dimensions:',
    '  order_key:',
    '    sql: ${orders.id}',
    '    primary_key: true',
    '',
  ].join('\n');
  const [patch] = mergeSemanticPatchCandidates([{
    id: 'topic:orders:orders.topic',
    artifactType: 'topic',
    sourceName: 'orders',
    targetFileName: 'orders.topic',
    currentYaml: acceptedYaml.replace(/\n/g, '\r\n'),
    sourceYaml: acceptedYaml,
    recommendedYaml: acceptedYaml,
    previousChecksum: 'destination-checksum-after-write',
    resolution: 'unresolved',
    status: 'warning',
    safetyCategory: 'manual_review',
    recommendedAction: 'Review the topic patch.',
    warnings: [],
  }], [{
    id: 'topic:orders:orders.topic',
    artifactType: 'topic',
    sourceName: 'orders',
    targetFileName: 'orders.topic',
    acceptedYaml,
    previousChecksum: 'destination-checksum-before-write',
    resolution: 'custom_edit',
    status: 'ready',
    safetyCategory: 'safe_update',
    recommendedAction: 'Apply the accepted topic patch.',
    warnings: [],
  }]);

  assert.equal(patch.resolution, 'keep_target');
  assert.equal(patch.acceptedYaml, undefined);
  assert.equal(patch.checksumStale, false);
  assert.equal(patch.status, 'ready');
  assert.equal(patch.safetyCategory, 'safe_map');
  assert.equal(patch.destructive, false);
  assert.match(patch.recommendedAction, /already present on the destination/i);
});

async function waitForJob(id: string) {
  const terminal = new Set(['succeeded', 'partial', 'failed', 'canceled']);
  for (let i = 0; i < 50; i += 1) {
    const job = getJob(id);
    if (job && terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const job = getJob(id);
  const itemSummary = job?.items.map((item) => `${item.kind}:${item.status}${item.error ? `:${item.error}` : ''}`).join(', ');
  throw new Error(`Job ${id} did not finish in time. Status: ${job?.status || 'missing'}. Items: ${itemSummary || 'none'}`);
}

test('omni client polls timed-out query jobs and preserves zero-row success', async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method });
    if (url.includes('/api/v1/query/run')) {
      return new Response(JSON.stringify({
        remaining_job_ids: ['11111111-1111-4111-8111-111111111111'],
        timed_out: 'true',
      }), { status: 408, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      job_id: '11111111-1111-4111-8111-111111111111',
      status: 'COMPLETE',
      summary: { total_rows: 0 },
      result: '[]',
      remaining_job_ids: [],
      timed_out: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
  });
  const result = await realRunQuery.call(client, {
    modelId: 'model-1',
    table: 'orders',
    fields: ['orders.count'],
  }, { maxWaitAttempts: 2 });

  assert.deepEqual(result, {
    jobId: '11111111-1111-4111-8111-111111111111',
    status: 'COMPLETE',
    rowCount: 0,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[1].method, 'GET');
  assert.equal(
    new URL(requests[1].url).searchParams.get('job_ids'),
    '["11111111-1111-4111-8111-111111111111"]',
  );
});

test('omni client rejects timed-out query responses without pollable job ids', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    timed_out: true,
  }), { status: 408, headers: { 'content-type': 'application/json' } }));
  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
  });

  await assert.rejects(
    realRunQuery.call(client, { modelId: 'model-1', table: 'orders', fields: ['orders.count'] }),
    /without a pollable Omni job ID/i,
  );
});

test('omni client writes model YAML files through the documented single-file API contract', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
  });

  await realUpdateModelYamlFiles.call(client, {
    modelId: 'model-1',
    branchId: 'branch-1',
    commitMessage: 'Validate dependency patches',
    files: [
      { fileName: 'orders.view', yaml: 'dimensions: {}', previousChecksum: 'checksum-1' },
      { fileName: 'finance.topic', yaml: 'base_view: orders' },
    ],
  });

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], {
    fileName: 'orders.view',
    yaml: 'dimensions: {}',
    mode: 'combined',
    branchId: 'branch-1',
    previousChecksum: 'checksum-1',
    commitMessage: 'Validate dependency patches',
  });
  assert.deepEqual(bodies[1], {
    fileName: 'finance.topic',
    yaml: 'base_view: orders',
    mode: 'combined',
    branchId: 'branch-1',
    commitMessage: 'Validate dependency patches',
  });
  assert.equal('files' in bodies[0], false);
});

test('omni client lists query views from authored model yaml', async () => {
  mock.method(OmniClient.prototype, 'getModelYaml', async () => ({
    files: {
      'model': 'label: Model\n',
      'orders.view': 'dimensions:\n  id:\n',
      'topics/executive.topic': 'label: Executive\n',
      'views/northstar_metrics.query.view': 'label: "Northstar Metrics"\ndescription: Demo query view\nquery:\n  base_view: orders\n',
      'views/traffic.query.view': 'description: Traffic rollup\nsql: select 1\n',
    },
    raw: {},
  }));

  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://test.example.omniapp.co',
    apiKey: 'test-key',
  });

  const queryViews = await client.listModelQueryViews('model-1');

  assert.deepEqual(queryViews, [
    {
      name: 'northstar_metrics',
      label: 'Northstar Metrics',
      description: 'Demo query view',
      fileName: 'views/northstar_metrics.query.view',
    },
    {
      name: 'traffic',
      description: 'Traffic rollup',
      fileName: 'views/traffic.query.view',
    },
  ]);
});

test('omni client includes query view yaml and checksums only when requested', async () => {
  mock.method(OmniClient.prototype, 'getModelYaml', async (_modelId: string, options: { includeChecksums?: boolean }) => ({
    files: {
      'northstar_metrics.query.view': 'label: Northstar Metrics\nquery:\n  base_view: orders\n',
    },
    checksums: options.includeChecksums ? {
      'northstar_metrics.query.view': 'checksum-1',
    } : undefined,
    raw: {},
  }));

  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://test.example.omniapp.co',
    apiKey: 'test-key',
  });

  const withoutYaml = await client.listModelQueryViews('model-1');
  assert.equal(withoutYaml[0].yaml, undefined);
  assert.equal(withoutYaml[0].checksum, undefined);

  const withYaml = await client.listModelQueryViews('model-1', { includeYaml: true, includeChecksums: true });
  assert.equal(withYaml[0].yaml, 'label: Northstar Metrics\nquery:\n  base_view: orders\n');
  assert.equal(withYaml[0].checksum, 'checksum-1');
});

test('instance API lists model query views with requested metadata', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  let captured: { modelId: string; includeYaml?: boolean; includeChecksums?: boolean } | null = null;
  mock.method(OmniClient.prototype, 'listModelQueryViews', async (
    modelId: string,
    options: { includeYaml?: boolean; includeChecksums?: boolean },
  ) => {
    captured = { modelId, ...options };
    return [{
      name: 'northstar_metrics',
      fileName: 'northstar_metrics.query.view',
      yaml: 'query:\n  base_view: orders\n',
      checksum: 'checksum-1',
    }];
  });

  const response = await instancesHandler(
    new Request('http://localhost/api/instances/source-1/models/model-1/query-views?includeYaml=true&includeChecksums=true'),
  );
  const body = await response.json() as { queryViews: unknown[] };

  assert.equal(response.status, 200);
  assert.deepEqual(captured, { modelId: 'model-1', includeYaml: true, includeChecksums: true });
  assert.deepEqual(body.queryViews, [{
    name: 'northstar_metrics',
    fileName: 'northstar_metrics.query.view',
    yaml: 'query:\n  base_view: orders\n',
    checksum: 'checksum-1',
  }]);
});

test('migration job handler parses route target query view mappings', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Mapped Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const response = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceId: 'source-1',
      documentIds: ['source-doc-1'],
      emptyFirst: false,
      replaceSameNamed: false,
      routeGroups: [{
        id: 'route-1',
        name: 'Route 1',
        documentIds: ['source-doc-1'],
        targets: [{
          id: 'target-1',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'target-connection',
          targetModelId: 'target-model',
          queryViewMappings: [
            {
              sourceQueryViewName: 'northstar_metrics',
              sourceFileName: 'northstar_metrics.query.view',
              action: 'copy_source',
              targetQueryViewName: 'northstar_metrics',
              targetFileName: 'northstar_metrics.query.view',
              targetQueryViewLabel: 'Northstar Metrics',
            },
            {
              sourceQueryViewName: 'ignored_metric',
              action: 'unresolved',
              targetQueryViewName: '',
            },
          ],
        }],
      }],
    }),
  }));
  const body = await response.json() as { plan: { routeGroups?: Array<{ targets: Array<{ queryViewMappings?: unknown[] }> }> } };

  assert.equal(response.status, 200);
  assert.deepEqual(body.plan.routeGroups?.[0]?.targets[0]?.queryViewMappings, [{
    sourceQueryViewName: 'northstar_metrics',
    sourceFileName: 'northstar_metrics.query.view',
    action: 'copy_source',
    targetQueryViewName: 'northstar_metrics',
    targetFileName: 'northstar_metrics.query.view',
    targetQueryViewLabel: 'Northstar Metrics',
  }]);
});

test('planner classifies dashboard query-view requirements per target route', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination Exact',
    role: 'destination',
    baseUrl: 'https://dest-a.example.omniapp.co',
    apiKey: 'dest-a-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-2',
    label: 'Destination Missing',
    role: 'destination',
    baseUrl: 'https://dest-b.example.omniapp.co',
    apiKey: 'dest-b-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
      };
    }
    return {
      'orders.view': 'dimensions:\n  id:\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [{
        name: 'northstar_metrics',
        label: 'Northstar Metrics',
        fileName: 'northstar_metrics.query.view',
        yaml: 'label: Northstar Metrics\nquery:\n  base_view: orders\n',
      }];
    }
    if (clientLabel(this) === 'Destination Exact') {
      return [{
        name: 'northstar_metrics',
        fileName: 'northstar_metrics.query.view',
      }];
    }
    return [];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-exact',
        destinationInstanceId: 'dest-1',
        targetModelId: 'target-model-a',
      },
      {
        id: 'target-missing',
        destinationInstanceId: 'dest-2',
        targetModelId: 'target-model-b',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const importByTarget = new Map(plan.steps
    .filter((step) => step.kind === 'import')
    .map((step) => [step.targetId, step]));
  const prepByTarget = new Map(plan.steps
    .filter((step) => step.kind === 'query_view_prepare')
    .map((step) => [step.targetId, step]));
  const exactQueryViews = importByTarget.get('target-exact')?.details?.requiredQueryViews as Array<Record<string, unknown>>;
  const missingQueryViews = importByTarget.get('target-missing')?.details?.requiredQueryViews as Array<Record<string, unknown>>;
  const exactMappings = prepByTarget.get('target-exact')?.details?.queryViewMappings as Array<Record<string, unknown>>;

  assert.equal(exactQueryViews[0].name, 'northstar_metrics');
  assert.equal(exactQueryViews[0].status, 'exact_target_match');
  assert.deepEqual(exactQueryViews[0].sources, ['dashboard']);
  assert.deepEqual(exactQueryViews[0].referencedBy, ['Northstar Dashboard']);
  assert.equal(exactMappings[0].action, 'map_existing');
  assert.equal(exactMappings[0].targetQueryViewName, 'northstar_metrics');
  assert.equal(missingQueryViews[0].status, 'missing_copyable');
  assert.equal(missingQueryViews[0].sourceFileName, 'northstar_metrics.query.view');
});

test('planner records copied query-view missing fields as resolved notices instead of import warnings', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'northstar__existing.query.view': 'dimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        'northstar__created.query.view': 'dimensions: {"revenue": {}}\nquery:\n  base_view: orders\n',
      };
    }
    return {
      'northstar__existing.query.view': 'dimensions:\n  revenue:\nquery:\n  base_view: orders\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [
        {
          name: 'northstar__existing',
          fileName: 'northstar__existing.query.view',
          yaml: 'dimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        },
        {
          name: 'northstar__created',
          fileName: 'northstar__created.query.view',
          yaml: 'dimensions: {"revenue": {}}\nquery:\n  base_view: orders\n',
        },
      ];
    }
    return [{
      name: 'northstar__existing',
      fileName: 'northstar__existing.query.view',
      yaml: 'dimensions:\n  revenue:\nquery:\n  base_view: orders\n',
    }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{
      fields: [
        'northstar__existing.revenue',
        'northstar__created.revenue',
      ],
    }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar__created',
        sourceFileName: 'northstar__created.query.view',
        action: 'copy_source',
        targetQueryViewName: 'northstar__created',
        targetFileName: 'northstar__created.query.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const prepStep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const mappings = prepStep?.details?.queryViewMappings as Array<Record<string, unknown>>;

  assert.equal(mappings.some((mapping) => mapping.sourceQueryViewName === 'northstar__created' && mapping.action === 'copy_source'), true);
	  assert.equal(importStep?.blocked, false);
	  assert.equal(importStep?.warnings?.some((warning) => warning.includes('referenced fields were not found')), undefined);
	  assert.equal(importStep?.notices?.some((notice) => notice.includes('were verified in the planned query-view YAML')), true);

	  const renamedPlan = await buildMigrationPlan({
	    sourceId: 'source-1',
	    targets: [{
	      id: 'target-1',
	      destinationInstanceId: 'dest-1',
	      targetModelId: 'target-model',
	      queryViewMappings: [{
	        sourceQueryViewName: 'northstar__created',
	        sourceFileName: 'northstar__created.query.view',
	        action: 'copy_source',
	        targetQueryViewName: 'northstar__created_copy',
	        targetFileName: 'northstar__created_copy.query.view',
	      }],
	    }],
	    documentIds: ['source-doc-1'],
	    emptyFirst: false,
	    replaceSameNamed: false,
	  });
	  const renamedPrepStep = renamedPlan.steps.find((step) => step.kind === 'query_view_prepare');

	  assert.equal(renamedPrepStep?.blocked, true);
	  assert.match(renamedPrepStep?.error || '', /different name/);
	});

test('planner resolves only fields proven by updated query-view YAML', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? {
          'stale_metric.query.view': 'dimensions:\n  old_value:\n  new_value:\nquery:\n  base_view: orders\n',
        }
      : {
          'stale_metric.query.view': 'dimensions:\n  old_value:\nquery:\n  base_view: orders\n',
        };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'stale_metric',
          fileName: 'stale_metric.query.view',
          yaml: 'dimensions:\n  old_value:\n  new_value:\nquery:\n  base_view: orders\n',
        }]
      : [{
          name: 'stale_metric',
          fileName: 'stale_metric.query.view',
          yaml: 'dimensions:\n  old_value:\nquery:\n  base_view: orders\n',
        }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['stale_metric.new_value', 'stale_metric.field_not_in_yaml'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      queryViewMappings: [{
        sourceQueryViewName: 'stale_metric',
        sourceFileName: 'stale_metric.query.view',
        action: 'update_existing',
        targetQueryViewName: 'stale_metric',
        targetFileName: 'stale_metric.query.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const prepStep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const mappings = prepStep?.details?.queryViewMappings as Array<Record<string, unknown>>;
  const fieldDependencies = importStep?.details?.fieldDependencies as Array<Record<string, unknown>>;

  assert.equal(mappings.some((mapping) => mapping.sourceQueryViewName === 'stale_metric' && mapping.action === 'update_existing'), true);
  assert.deepEqual(mappings[0].suppliedFieldRefs, ['stale_metric.new_value']);
  assert.equal((mappings[0].fieldEvidence as Record<string, unknown>).verified, true);
  assert.equal(prepStep?.blocked, false);
  assert.equal(importStep?.blocked, true);
  assert.equal(fieldDependencies.some((dependency) => dependency.sourceFieldRef === 'stale_metric.field_not_in_yaml'), true);
  assert.equal(importStep?.notices?.some((notice) => notice.includes('stale_metric.new_value') && notice.includes('verified in the planned query-view YAML')), true);
});

test('planner recovers query-view field definitions when the accepted decision keeps target YAML', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceYaml = 'dimensions: {"new_value": {"label": "New Value"}}\nquery:\n  base_view: orders\n';
  const targetYaml = 'dimensions:\n  old_value: {}\nquery:\n  base_view: orders\n';
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'metrics/derived_metric.query.view': sourceYaml }
      : { 'metrics/derived_metric.query.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: sourceYaml }]
      : [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: targetYaml, checksum: 'target-checksum' }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['derived_metric.new_value'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      queryViewMappings: [{
        sourceQueryViewName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        action: 'update_existing',
        targetQueryViewName: 'derived_metric',
        targetFileName: 'metrics/derived_metric.query.view',
      }],
      semanticPatches: [{
        id: 'query_view:derived_metric:metrics/derived_metric.query.view',
        artifactType: 'query_view',
        sourceName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        targetFileName: 'metrics/derived_metric.query.view',
        resolution: 'keep_target',
        status: 'warning',
        safetyCategory: 'manual_review',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const prepStep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const mappings = prepStep?.details?.queryViewMappings as Array<Record<string, unknown>>;
  const fieldPrep = plan.steps.find((step) => step.kind === 'field_prepare');
  const dependencies = fieldPrep?.details?.fieldDependencies as Array<Record<string, unknown>>;

  assert.deepEqual(mappings[0].suppliedFieldRefs, []);
  assert.equal((mappings[0].fieldEvidence as Record<string, unknown>).source, 'target_yaml');
  assert.equal(dependencies[0].sourceFieldRef, 'derived_metric.new_value');
  assert.equal(dependencies[0].sourceFileName, 'metrics/derived_metric.query.view');
  assert.equal(dependencies[0].fieldKind, 'dimension');
  assert.match(String(dependencies[0].sourceYaml), /new_value/);
});

test('planner does not block validation when a blocked overwrite is explicitly resolved by keeping target YAML', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceYaml = 'dimensions:\n  required_value: {}\nquery:\n  base_view: orders\n';
  const targetYaml = 'dimensions:\n  required_value: {}\n  target_only: {}\nquery:\n  base_view: orders\n';
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Keep Target Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'metrics/derived_metric.query.view': sourceYaml }
      : { 'metrics/derived_metric.query.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: sourceYaml }]
      : [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: targetYaml, checksum: 'target-checksum' }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['derived_metric.required_value'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      queryViewMappings: [{
        sourceQueryViewName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        action: 'update_existing',
        targetQueryViewName: 'derived_metric',
        targetFileName: 'metrics/derived_metric.query.view',
      }],
      semanticPatches: [{
        id: 'query_view:derived_metric:metrics/derived_metric.query.view',
        artifactType: 'query_view',
        sourceName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        targetFileName: 'metrics/derived_metric.query.view',
        resolution: 'keep_target',
        status: 'warning',
        safetyCategory: 'blocked',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const queryValidate = plan.steps.find((step) => step.kind === 'query_validate');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(queryValidate?.blocked, false);
  assert.equal(importStep?.blocked, false);
  assert.doesNotMatch(String(queryValidate?.error || ''), /semantic code decisions are refreshed/i);
});

test('planner uses accepted custom query-view YAML to satisfy dashboard field dependencies', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceYaml = 'dimensions:\n  base_value: {}\nquery:\n  base_view: orders\n';
  const targetYaml = 'dimensions:\n  base_value: {}\n  target_only: {}\nquery:\n  base_view: orders\n';
  const acceptedYaml = 'dimensions:\n  base_value: {}\n  compatibility_alias:\n    sql: ${derived_metric.base_value}\n  target_only: {}\nquery:\n  base_view: orders\n';
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Custom Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'metrics/derived_metric.query.view': sourceYaml }
      : { 'metrics/derived_metric.query.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: sourceYaml }]
      : [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: targetYaml, checksum: 'target-checksum' }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['derived_metric.compatibility_alias'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      queryViewMappings: [{
        sourceQueryViewName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        action: 'update_existing',
        targetQueryViewName: 'derived_metric',
        targetFileName: 'metrics/derived_metric.query.view',
      }],
      semanticPatches: [{
        id: 'query_view:derived_metric:metrics/derived_metric.query.view',
        artifactType: 'query_view',
        sourceName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        targetFileName: 'metrics/derived_metric.query.view',
        acceptedYaml,
        previousChecksum: 'target-checksum',
        resolution: 'custom_edit',
        destructive: true,
        confirmedDestructive: true,
        status: 'warning',
        safetyCategory: 'destructive_update',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const prepStep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const mappings = prepStep?.details?.queryViewMappings as Array<Record<string, unknown>>;
  const dependencies = importStep?.details?.fieldDependencies as Array<Record<string, unknown>> | undefined;

  assert.deepEqual(mappings[0].suppliedFieldRefs, ['derived_metric.compatibility_alias']);
  assert.equal((mappings[0].fieldEvidence as Record<string, unknown>).source, 'accepted_patch');
  assert.equal(dependencies?.some((dependency) => dependency.sourceFieldRef === 'derived_metric.compatibility_alias') ?? false, false);
  assert.equal(importStep?.blocked, false);
});

test('dashboard migration creates a recovered field in query-view YAML without overwriting a kept target query view', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceQueryViewYaml = 'dimensions: {"new_value": {"label": "New Value"}}\nquery:\n  base_view: orders\n';
  const targetQueryViewYaml = 'dimensions:\n  old_value: {}\nquery:\n  base_view: orders\n';
  const writes: Array<{ fileName: string; yaml: string; previousChecksum?: string }> = [];
  let imported = false;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (clientLabel(this) === 'Source') {
      return [{
        id: 'source-doc-1',
        identifier: 'source-doc-1',
        name: 'Query View Field Dashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }];
    }
    return imported
      ? [{
          id: 'imported-doc-1',
          identifier: 'imported-doc-1',
          name: 'Query View Field Dashboard',
          baseModelId: 'target-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'target-model', name: 'Target Model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'metrics/derived_metric.query.view': sourceQueryViewYaml }
      : { 'metrics/derived_metric.query.view': targetQueryViewYaml };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    return {
      files: {},
      checksums: options.includeChecksums ? {} : undefined,
      raw: { modelId },
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'derived_metric', fileName: 'metrics/derived_metric.query.view', yaml: sourceQueryViewYaml }]
      : [{
          name: 'derived_metric',
          label: 'Derived Metric',
          fileName: 'metrics/derived_metric.query.view',
          yaml: targetQueryViewYaml,
          checksum: 'target-query-checksum',
        }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['derived_metric.new_value'] }],
  }));
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: { fileName: string; yaml: string; previousChecksum?: string }) => {
    writes.push(input);
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    imported = true;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      queryViewMappings: [{
        sourceQueryViewName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        action: 'update_existing',
        targetQueryViewName: 'derived_metric',
        targetFileName: 'metrics/derived_metric.query.view',
      }],
      fieldMappings: [{
        sourceFieldRef: 'derived_metric.new_value',
        action: 'create_from_source',
        sourceFileName: 'metrics/derived_metric.query.view',
        targetFileName: 'metrics/derived_metric.query.view',
      }],
      semanticPatches: [{
        id: 'query_view:derived_metric:metrics/derived_metric.query.view',
        artifactType: 'query_view',
        sourceName: 'derived_metric',
        sourceFileName: 'metrics/derived_metric.query.view',
        targetFileName: 'metrics/derived_metric.query.view',
        resolution: 'keep_target',
        status: 'warning',
        safetyCategory: 'manual_review',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const fieldPrep = job.items.find((item) => item.kind === 'field_prepare');
  const queryViewPrep = job.items.find((item) => item.kind === 'query_view_prepare');

  assert.equal(job.status, 'partial');
  assert.equal(fieldPrep?.status, 'succeeded');
  assert.equal(queryViewPrep?.status, 'warning');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fileName, 'metrics/derived_metric.query.view');
  assert.equal(writes[0].previousChecksum, 'target-query-checksum');
  assert.match(writes[0].yaml, /old_value/);
  assert.match(writes[0].yaml, /new_value/);
  assert.match(queryViewPrep?.warnings?.join(' ') || '', /kept unchanged by the accepted code decision/i);
});

test('planner blocks exact target query views that are missing required field coverage', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Stale Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? {
          'stale_metric.query.view': 'dimensions:\n  old_value:\n  new_value:\nquery:\n  base_view: orders\n',
        }
      : {
          'stale_metric.query.view': 'dimensions:\n  old_value:\nquery:\n  base_view: orders\n',
        };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'stale_metric',
          fileName: 'stale_metric.query.view',
          yaml: 'dimensions:\n  old_value:\n  new_value:\nquery:\n  base_view: orders\n',
        }]
      : [{
          name: 'stale_metric',
          fileName: 'stale_metric.query.view',
          yaml: 'dimensions:\n  old_value:\nquery:\n  base_view: orders\n',
        }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['stale_metric.new_value'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const prepStep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const mappings = prepStep?.details?.queryViewMappings as Array<Record<string, unknown>>;
  const required = importStep?.details?.requiredQueryViews as Array<Record<string, unknown>>;

  assert.equal(required[0].status, 'exact_target_match');
  assert.equal((required[0].compatibility as Record<string, unknown>).status, 'missing_required_fields');
  assert.deepEqual((required[0].compatibility as Record<string, unknown>).missingRequiredFields, ['stale_metric.new_value']);
  assert.equal(mappings.length, 0);
  assert.equal(prepStep?.blocked, true);
  assert.match(prepStep?.error || '', /missing required fields/i);
  const fieldPrep = plan.steps.find((step) => step.kind === 'field_prepare');
  const fieldDependencies = fieldPrep?.details?.fieldDependencies as Array<Record<string, unknown>>;
  assert.equal(fieldPrep?.blocked, true);
  assert.equal(fieldDependencies[0].sourceFieldRef, 'stale_metric.new_value');
  assert.equal(fieldDependencies[0].status, 'unresolved');
  assert.equal(importStep?.blocked, true);
  assert.match(importStep?.error || '', /query-view mappings/);
});

test('planner detects query views referenced by source topic yaml', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['northstar_topic'],
          topicIds: ['northstar_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'northstar_metrics.query.view': 'dimensions:\n  revenue:\nquery:\n  base_view: orders\n',
      };
    }
    return {
      'orders.view': 'dimensions:\n  id:\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [{
        name: 'northstar_metrics',
        fileName: 'northstar_metrics.query.view',
        yaml: 'query:\n  base_view: orders\n',
      }];
    }
    return [];
  });
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    if (clientLabel(this) === 'Source') {
      return [{
        name: 'northstar_topic',
        label: 'Northstar Topic',
        yaml: 'label: Northstar Topic\nbase_view_name: northstar_metrics\n',
      }];
    }
    return [{ name: 'northstar_topic', label: 'Northstar Topic' }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'northstar_topic' },
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      topicMappings: [{
        sourceTopicName: 'northstar_topic',
        sourceTopicId: 'northstar_topic',
        action: 'map_existing',
        targetTopicName: 'northstar_topic',
        targetTopicLabel: 'Northstar Topic',
      }],
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'copy_source',
        targetQueryViewName: 'northstar_metrics',
        targetFileName: 'northstar_metrics.query.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const stepKinds = plan.steps.map((step) => step.kind);
  const queryViewPrepIndex = stepKinds.indexOf('query_view_prepare');
  const topicPrepIndex = stepKinds.indexOf('topic_prepare');
  const importIndex = stepKinds.indexOf('import');
  const queryViewPrep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const preparedQueryViews = queryViewPrep?.details?.queryViewMappings as Array<Record<string, unknown>>;
  const requiredQueryViews = importStep?.details?.requiredQueryViews as Array<Record<string, unknown>>;

  assert.ok(queryViewPrepIndex >= 0);
  assert.ok(topicPrepIndex > queryViewPrepIndex);
  assert.ok(importIndex > topicPrepIndex);
  assert.equal(preparedQueryViews[0].targetQueryViewName, 'northstar_metrics');
  assert.equal(requiredQueryViews[0].name, 'northstar_metrics');
  assert.equal(requiredQueryViews[0].status, 'missing_copyable');
  assert.deepEqual(requiredQueryViews[0].sources, ['topic']);
  assert.deepEqual(requiredQueryViews[0].referencedBy, ['northstar_topic']);
});

test('planner detects query views declared as topic joins and views map keys', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const topicYaml = [
    'base_view: northstar__daily_grill_report',
    'label: NorthstarTopic',
    'joins:',
    '  northstar__northstar_locations: {}',
    '  northstar__bag_tickets:',
    '    northstar__grill_slips:',
    '      northstar__menu_board: {}',
    'views:',
    '  northstar__daily_grill_report:',
    '    display_order: 1',
    '  northstar__northstar_locations:',
    '    display_order: 2',
    '  northstar__menu_item_pnl:',
    '    display_order: 3',
    'sample_queries:',
    '  Texas_Locations:',
    '    query:',
    '      fields: [northstar__northstar_locations.texas_city]',
  ].join('\n');

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['NorthstarTopic'],
          topicIds: ['NorthstarTopic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'NorthstarTopic.topic': topicYaml,
        'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
        'northstar/northstar__northstar_locations.query.view': 'label: Northstar Locations\nsql: select 1\n',
        'northstar/northstar__bag_tickets.query.view': 'label: Bag Tickets\nsql: select 1\n',
        'northstar/northstar__grill_slips.query.view': 'label: Grill Slips\nsql: select 1\n',
        'northstar/northstar__menu_board.query.view': 'label: Menu Board\nsql: select 1\n',
        'northstar/northstar__menu_item_pnl.query.view': 'label: Menu Item P&L\nsql: select 1\n',
      };
    }
    return {
      'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [
        'northstar__daily_grill_report',
        'northstar__northstar_locations',
        'northstar__bag_tickets',
        'northstar__grill_slips',
        'northstar__menu_board',
        'northstar__menu_item_pnl',
      ].map((name) => ({
        name,
        fileName: `northstar/${name}.query.view`,
        yaml: `label: ${name}\nsql: select 1\n`,
      }));
    }
    return [{
      name: 'northstar__daily_grill_report',
      fileName: 'northstar/northstar__daily_grill_report.query.view',
    }];
  });
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    if (clientLabel(this) === 'Source') {
      return [{ name: 'NorthstarTopic', label: 'NorthstarTopic', yaml: topicYaml }];
    }
    return [{ name: 'NorthstarTopic', label: 'NorthstarTopic' }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'NorthstarTopic' },
    tiles: [{ fields: ['northstar__daily_grill_report.total_revenue'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      topicMappings: [{
        sourceTopicName: 'NorthstarTopic',
        sourceTopicId: 'NorthstarTopic',
        action: 'map_existing',
        targetTopicName: 'NorthstarTopic',
        targetTopicLabel: 'NorthstarTopic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const queryViewPrep = plan.steps.find((step) => step.kind === 'query_view_prepare');
  const requiredQueryViews = queryViewPrep?.details?.requiredQueryViews as Array<Record<string, unknown>>;
  const requiredNames = requiredQueryViews.map((row) => row.name).sort();

  assert.deepEqual(requiredNames, [
    'northstar__bag_tickets',
    'northstar__daily_grill_report',
    'northstar__grill_slips',
    'northstar__menu_board',
    'northstar__menu_item_pnl',
    'northstar__northstar_locations',
  ]);
  assert.equal(requiredQueryViews.find((row) => row.name === 'northstar__northstar_locations')?.status, 'missing_copyable');
});

test('planner adds relationship preparation for missing reusable query-view relationships', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const topicYaml = [
    'base_view: northstar__daily_grill_report',
    'label: NorthstarTopic',
    'joins:',
    '  northstar__menu_item_pnl: {}',
    'views:',
    '  northstar__daily_grill_report: {}',
    '  northstar__menu_item_pnl: {}',
  ].join('\n');
  const relationshipsYaml = [
    '- join_from_view: northstar__daily_grill_report',
    '  join_to_view: northstar__menu_item_pnl',
    '  join_type: always_left',
    '  on_sql: ${northstar__daily_grill_report.store_number} IS NOT NULL AND',
    '    ${northstar__menu_item_pnl.plu_code} IS NOT NULL',
    '  relationship_type: many_to_many',
  ].join('\n');

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['NorthstarTopic'],
          topicIds: ['NorthstarTopic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    if (clientLabel(this) === 'Source') {
      return {
        files: {
          'NorthstarTopic.topic': topicYaml,
          relationships: relationshipsYaml,
          'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
          'northstar/northstar__menu_item_pnl.query.view': 'label: Menu Item P&L\nsql: select 1\n',
        },
        checksums: options.includeChecksums ? { relationships: 'source-relationships-checksum' } : undefined,
        raw: { modelId },
      };
    }
    return {
      files: {
        relationships: '[]\n',
        'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
      },
      checksums: options.includeChecksums ? { relationships: 'target-relationships-checksum' } : undefined,
      raw: { modelId },
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [
        {
          name: 'northstar__daily_grill_report',
          fileName: 'northstar/northstar__daily_grill_report.query.view',
          yaml: 'label: Daily Grill Report\nsql: select 1\n',
        },
        {
          name: 'northstar__menu_item_pnl',
          fileName: 'northstar/northstar__menu_item_pnl.query.view',
          yaml: 'label: Menu Item P&L\nsql: select 1\n',
        },
      ];
    }
    return [{
      name: 'northstar__daily_grill_report',
      fileName: 'northstar/northstar__daily_grill_report.query.view',
    }];
  });
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    if (clientLabel(this) === 'Source') {
      return [{ name: 'NorthstarTopic', label: 'NorthstarTopic', yaml: topicYaml }];
    }
    return [{ name: 'NorthstarTopic', label: 'NorthstarTopic' }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'NorthstarTopic' },
    tiles: [{ fields: ['northstar__menu_item_pnl.estimated_margin_pct'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      topicMappings: [{
        sourceTopicName: 'NorthstarTopic',
        sourceTopicId: 'NorthstarTopic',
        action: 'map_existing',
        targetTopicName: 'NorthstarTopic',
        targetTopicLabel: 'NorthstarTopic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const relationshipPrep = plan.steps.find((step) => (step.kind as string) === 'relationship_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const relationshipPrepIndex = plan.steps.findIndex((step) => (step.kind as string) === 'relationship_prepare');
  const importIndex = plan.steps.findIndex((step) => step.kind === 'import');
  const edges = relationshipPrep?.details?.relationshipEdges as Array<Record<string, unknown>>;

  assert.ok(relationshipPrep, 'relationship_prepare step should be planned');
  assert.ok(relationshipPrepIndex >= 0 && relationshipPrepIndex < importIndex);
  assert.equal(edges[0].joinFromView, 'northstar__daily_grill_report');
  assert.equal(edges[0].joinToView, 'northstar__menu_item_pnl');
  assert.deepEqual(importStep?.details?.relationshipEdges, edges);
});

test('planner exposes conflicting relationship YAML for review and accepts an explicit keep-target decision', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const topicYaml = [
    'base_view: northstar__daily_grill_report',
    'label: NorthstarTopic',
    'views:',
    '  northstar__daily_grill_report: {}',
    '  northstar__menu_item_pnl: {}',
  ].join('\n');
  const sourceRelationshipsYaml = [
    '- join_from_view: northstar__daily_grill_report',
    '  join_to_view: northstar__menu_item_pnl',
    '  join_type: always_left',
    '  on_sql: ${northstar__daily_grill_report.store_number} = ${northstar__menu_item_pnl.store_number}',
    '  relationship_type: many_to_one',
  ].join('\n');
  const targetRelationshipsYaml = sourceRelationshipsYaml.replace('always_left', 'inner');
  const queryViewFiles = {
    'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\ndimensions:\n  store_number:\n',
    'northstar/northstar__menu_item_pnl.query.view': 'label: Menu Item P&L\nsql: select 1\ndimensions:\n  store_number:\n  estimated_margin_pct:\n',
  };

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['NorthstarTopic'],
          topicIds: ['NorthstarTopic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    const source = clientLabel(this) === 'Source';
    return {
      files: {
        'NorthstarTopic.topic': topicYaml,
        relationships: source ? sourceRelationshipsYaml : targetRelationshipsYaml,
        ...queryViewFiles,
      },
      checksums: options.includeChecksums
        ? { relationships: source ? 'source-relationships-checksum' : 'target-relationships-checksum' }
        : undefined,
      raw: { modelId },
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => [
    {
      name: 'northstar__daily_grill_report',
      fileName: 'northstar/northstar__daily_grill_report.query.view',
      yaml: queryViewFiles['northstar/northstar__daily_grill_report.query.view'],
    },
    {
      name: 'northstar__menu_item_pnl',
      fileName: 'northstar/northstar__menu_item_pnl.query.view',
      yaml: queryViewFiles['northstar/northstar__menu_item_pnl.query.view'],
    },
  ]);
  mock.method(OmniClient.prototype, 'listModelTopics', async () => [{
    name: 'NorthstarTopic',
    label: 'NorthstarTopic',
    fileName: 'NorthstarTopic.topic',
    yaml: topicYaml,
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'NorthstarTopic' },
    tiles: [{ fields: ['northstar__menu_item_pnl.estimated_margin_pct'] }],
  }));

  const baseTarget = {
    id: 'target-1',
    destinationInstanceId: 'dest-1',
    targetModelId: 'target-model',
    topicMappings: [{
      sourceTopicName: 'NorthstarTopic',
      sourceTopicId: 'NorthstarTopic',
      action: 'map_existing' as const,
      targetTopicName: 'NorthstarTopic',
      targetTopicLabel: 'NorthstarTopic',
    }],
  };
  const blockedPlan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [baseTarget],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });
  const blockedRelationshipPrep = blockedPlan.steps.find((step) => step.kind === 'relationship_prepare');
  const relationshipPatches = blockedRelationshipPrep?.details?.semanticPatches as Array<Record<string, unknown>>;
  const relationshipPatch = relationshipPatches.find((patch) => patch.artifactType === 'relationship');

  assert.equal(blockedRelationshipPrep?.blocked, true);
  assert.equal(relationshipPatch?.safetyCategory, 'manual_review');
  assert.match(String(relationshipPatch?.recommendedAction), /Keep the target YAML/);
  assert.equal(relationshipPatch?.recommendedYaml, targetRelationshipsYaml);

  const resolvedPlan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      ...baseTarget,
      semanticPatches: [{
        id: 'relationship:relationships:relationships',
        artifactType: 'relationship',
        sourceName: 'relationships',
        targetFileName: 'relationships',
        resolution: 'keep_target',
        status: 'warning',
        safetyCategory: 'manual_review',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });
  const resolvedImport = resolvedPlan.steps.find((step) => step.kind === 'import');

  assert.equal(resolvedPlan.steps.some((step) => step.kind === 'relationship_prepare'), false);
  assert.equal(resolvedImport?.blocked, false);
});

test('planner blocks mapped existing topics that are missing required source topic scope', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceTopicYaml = [
    'base_view: northstar__daily_grill_report',
    'label: NorthstarTopic',
    'joins:',
    '  northstar__northstar_locations: {}',
    'views:',
    '  northstar__daily_grill_report: {}',
    '  northstar__northstar_locations: {}',
  ].join('\n');
  const targetTopicYaml = [
    'base_view: northstar__daily_grill_report',
    'label: NorthstarTopic',
    'views:',
    '  northstar__daily_grill_report: {}',
  ].join('\n');

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['NorthstarTopic'],
          topicIds: ['NorthstarTopic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'NorthstarTopic.topic': sourceTopicYaml,
        'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
        'northstar/northstar__northstar_locations.query.view': 'label: Locations\nsql: select 1\n',
      };
    }
    return {
      'NorthstarTopic.topic': targetTopicYaml,
      'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
      'northstar/northstar__northstar_locations.query.view': 'label: Locations\nsql: select 1\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => [
    {
      name: 'northstar__daily_grill_report',
      fileName: 'northstar/northstar__daily_grill_report.query.view',
      yaml: 'label: Daily Grill Report\nsql: select 1\n',
    },
    {
      name: 'northstar__northstar_locations',
      fileName: 'northstar/northstar__northstar_locations.query.view',
      yaml: 'label: Locations\nsql: select 1\n',
    },
  ]);
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    if (clientLabel(this) === 'Source') {
      return [{ name: 'NorthstarTopic', label: 'NorthstarTopic', yaml: sourceTopicYaml }];
    }
    return [{ name: 'NorthstarTopic', label: 'NorthstarTopic', yaml: targetTopicYaml }];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'NorthstarTopic' },
    tiles: [{ fields: ['northstar__northstar_locations.texas_city'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      topicMappings: [{
        sourceTopicName: 'NorthstarTopic',
        sourceTopicId: 'NorthstarTopic',
        action: 'map_existing',
        targetTopicName: 'NorthstarTopic',
        targetTopicLabel: 'NorthstarTopic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const topicPrep = plan.steps.find((step) => step.kind === 'topic_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');

  assert.equal(topicPrep?.blocked, true);
  assert.match(topicPrep?.error || '', /missing required source topic views/i);
  assert.match(JSON.stringify(topicPrep?.details?.topicCompatibilityBlockers || []), /missing required source topic views/i);
  assert.equal(importStep?.blocked, true);
  assert.match(importStep?.error || '', /topic mappings/i);
});

test('planner detects query-view dependencies from source query-view yaml', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Dependency Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'main_metric.query.view': 'dimensions:\n  revenue:\nquery:\n  fields:\n    - helper_metric.score\n',
        'helper_metric.query.view': 'dimensions:\n  score:\nquery:\n  base_view: orders\n',
      };
    }
    return {
      'orders.view': 'dimensions:\n  id:\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [
        {
          name: 'main_metric',
          fileName: 'main_metric.query.view',
          yaml: 'query:\n  fields:\n    - helper_metric.score\n',
        },
        {
          name: 'helper_metric',
          fileName: 'helper_metric.query.view',
          yaml: 'query:\n  base_view: orders\n',
        },
      ];
    }
    return [];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['main_metric.revenue'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const importStep = plan.steps.find((step) => step.kind === 'import');
  const requiredQueryViews = importStep?.details?.requiredQueryViews as Array<Record<string, unknown>>;
  const byName = new Map(requiredQueryViews.map((queryView) => [queryView.name, queryView]));

  assert.equal(byName.get('main_metric')?.status, 'missing_copyable');
  assert.deepEqual(byName.get('main_metric')?.sources, ['dashboard']);
  assert.equal(byName.get('helper_metric')?.status, 'missing_copyable');
  assert.deepEqual(byName.get('helper_metric')?.sources, ['query_view_dependency']);
  assert.deepEqual(byName.get('helper_metric')?.referencedBy, ['main_metric']);
});

test('planner classifies query views with missing authored source yaml', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Missing YAML Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'no_yaml.query.view': 'dimensions:\n  value:\nquery:\n  base_view: orders\n',
      };
    }
    return {
      'orders.view': 'dimensions:\n  id:\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [{ name: 'no_yaml', fileName: 'no_yaml.query.view' }];
    }
    return [];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['no_yaml.value'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const importStep = plan.steps.find((step) => step.kind === 'import');
  const requiredQueryViews = importStep?.details?.requiredQueryViews as Array<Record<string, unknown>>;

  assert.equal(requiredQueryViews[0].name, 'no_yaml');
  assert.equal(requiredQueryViews[0].status, 'missing_source_yaml');
  assert.match(String(requiredQueryViews[0].reason), /Source query-view YAML was not found/);
});

test('planner classifies query-view requirements as blocked when target catalog fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Blocked Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    if (clientLabel(this) === 'Source') {
      return {
        'blocked_metric.query.view': 'dimensions:\n  value:\nquery:\n  base_view: orders\n',
      };
    }
    return {
      'orders.view': 'dimensions:\n  id:\n',
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [{
        name: 'blocked_metric',
        fileName: 'blocked_metric.query.view',
        yaml: 'query:\n  base_view: orders\n',
      }];
    }
    throw new Error('Target query view API failed.');
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['blocked_metric.value'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const importStep = plan.steps.find((step) => step.kind === 'import');
  const requiredQueryViews = importStep?.details?.requiredQueryViews as Array<Record<string, unknown>>;

  assert.equal(requiredQueryViews[0].name, 'blocked_metric');
  assert.equal(requiredQueryViews[0].status, 'blocked');
  assert.match(String(requiredQueryViews[0].reason), /Target query-view catalog could not be loaded/);
  assert.equal(importStep?.warnings?.some((warning) => warning.includes('Target query-view catalog could not be loaded')), true);
});

test('planner blocks create-new query views on protected models and warns for git-configured direct writes', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-protected',
    label: 'Protected Destination',
    role: 'destination',
    baseUrl: 'https://protected.example.omniapp.co',
    apiKey: 'protected-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-git',
    label: 'Git Destination',
    role: 'destination',
    baseUrl: 'https://git.example.omniapp.co',
    apiKey: 'git-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async function listModels() {
    if (clientLabel(this) === 'Protected Destination') {
      return [{ id: 'target-model-protected', name: 'Protected Model', pullRequestRequired: true }];
    }
    if (clientLabel(this) === 'Git Destination') {
      return [{ id: 'target-model-git', name: 'Git Model', gitConfigured: true }];
    }
    return [];
  });
	  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
	    return clientLabel(this) === 'Source'
	      ? [{
	          name: 'northstar_metrics',
	          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\nquery:\n  base_view: orders\n',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));

  const queryViewMapping = {
    sourceQueryViewName: 'northstar_metrics',
    sourceFileName: 'northstar_metrics.query.view',
    action: 'copy_source' as const,
    targetQueryViewName: 'northstar_metrics',
    targetFileName: 'northstar_metrics.query.view',
  };
  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-protected',
        destinationInstanceId: 'dest-protected',
        targetConnectionId: 'protected-connection',
        targetModelId: 'target-model-protected',
        targetModelName: 'Protected Model',
        queryViewMappings: [queryViewMapping],
      },
      {
        id: 'target-git',
        destinationInstanceId: 'dest-git',
        targetConnectionId: 'git-connection',
        targetModelId: 'target-model-git',
        targetModelName: 'Git Model',
        queryViewMappings: [queryViewMapping],
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const protectedPrep = plan.steps.find((step) => step.kind === 'query_view_prepare' && step.targetId === 'target-protected');
  const gitPrep = plan.steps.find((step) => step.kind === 'query_view_prepare' && step.targetId === 'target-git');

  assert.equal(protectedPrep?.blocked, true);
  assert.match(protectedPrep?.error || '', /requires protected branch or pull-request YAML changes/);
  assert.equal(gitPrep?.blocked === true, false);
  assert.equal(gitPrep?.warnings?.some((warning) => /git configured/i.test(warning)), true);
});

test('planner replaces same-named dashboards without emptying unrelated target docs', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const sourceDocs: OmniDocumentRecord[] = [
    {
      id: 'source-doc-1',
      identifier: 'source-doc-1',
      name: 'Executive Scorecard',
      folderPath: 'Source Dashboards',
      baseModelId: 'source-model',
    },
  ];
  const destinationDocs: OmniDocumentRecord[] = [
    {
      id: 'dest-existing-1',
      identifier: 'dest-existing-1',
      name: 'Executive Scorecard',
      folderPath: 'Migrated Dashboards',
    },
    {
      id: 'dest-existing-2',
      identifier: 'dest-existing-2',
      name: 'Do Not Touch',
      folderPath: 'Migrated Dashboards',
    },
  ];

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source' ? sourceDocs : destinationDocs;
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deletes = plan.steps.filter((step) => step.kind === 'delete');

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].documentId, 'dest-existing-1');
  assert.equal(deletes[0].replacement, true);
  assert.equal(plan.steps.some((step) => step.documentId === 'dest-existing-2'), false);
});

test('planner replaces same-named default target dashboards without deleting selected same-instance source', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
    {
      id: 'my-docs-existing',
      identifier: 'my-docs-existing',
      name: 'NFL MVP Analytics',
      folderPath: '',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
      sameNamedStrategy: 'replace',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deletes = plan.steps.filter((step) => step.kind === 'delete');

  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].documentId, 'my-docs-existing');
  assert.equal(deletes[0].replacement, true);
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(importStep?.warnings, undefined);
  assert.equal(importStep?.notices, undefined);
});

test('planner updates same-named dashboards in place by default when Documents V2 is available', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultFolderPath: 'Target Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
        id: 'source-doc',
        identifier: 'source-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }]
      : [{
        id: 'target-doc',
        identifier: 'target-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Target Dashboards',
        baseModelId: 'target-model',
      }];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => ({ queryPresentations: { data: {} } }));
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-row',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'dest-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Target Dashboards',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const updateStep = plan.steps.find((step) => step.kind === 'update');

  assert.equal(plan.steps.some((step) => step.kind === 'delete'), false);
  assert.equal(plan.steps.some((step) => step.kind === 'import'), false);
  assert.equal(updateStep?.documentId, 'source-doc');
  assert.equal(updateStep?.details?.destinationDocumentId, 'target-doc');
  assert.equal(updateStep?.details?.sameNamedStrategy, 'update');
  assert.equal(updateStep?.warnings, undefined);
});

test('planner falls back to replacement when same-name update support is unavailable', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultFolderPath: 'Target Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
        id: 'source-doc',
        identifier: 'source-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }]
      : [{
        id: 'target-doc',
        identifier: 'target-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Target Dashboards',
        baseModelId: 'target-model',
      }];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => {
    throw new OmniClientError(404, 'https://dest.example.omniapp.co/api/v2/documents/target-doc/state', 'missing');
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-row',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'dest-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Target Dashboards',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deleteStep = plan.steps.find((step) => step.kind === 'delete');
  const importStep = plan.steps.find((step) => step.kind === 'import');

  assert.equal(plan.steps.some((step) => step.kind === 'update'), false);
  assert.equal(deleteStep?.documentId, 'target-doc');
  assert.equal(deleteStep?.replacement, true);
  assert.equal(importStep?.details?.sameNamedStrategy, 'update');
  assert.match(importStep?.warnings?.join('\n') || '', /does not support in-place dashboard updates/i);
});

test('planner can source selected dashboards across all folders for a connection-scoped job', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Default Only',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (clientLabel(this) === 'Source') {
      return [
        {
          id: 'default-doc',
          identifier: 'default-doc',
          name: 'Default Dashboard',
          connectionId: 'source-connection',
          folderPath: 'Default Only',
          baseModelId: 'source-model',
        },
        {
          id: 'selected-doc',
          identifier: 'selected-doc',
          name: 'Connection Dashboard',
          connectionId: 'source-connection',
          folderPath: 'Shared/Team Dashboards',
          baseModelId: 'source-model',
        },
      ];
    }
    return [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({}));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['selected-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
    sourceAllFolders: true,
  });

  assert.equal(plan.sourceAllFolders, true);
  assert.equal(plan.sourceFolderPath, undefined);
  assert.equal(plan.steps.some((step) => step.kind === 'import' && step.documentId === 'selected-doc'), true);
});

test('planner never queues selected source dashboard as a same-instance replacement delete', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-same-folder',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Just For Fun',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  assert.equal(plan.steps.some((step) => step.kind === 'delete'), false);
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(importStep?.warnings, undefined);
  assert.match(importStep?.notices?.join(' ') || '', /same Omni instance/i);
});

test('same-instance default replacement scan without a root match does not turn a successful import into warning', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let deleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'imported-nfl-dashboard',
    documentId: 'imported-nfl-dashboard',
  }));
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async () => {
    deleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
      sameNamedStrategy: 'replace',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(job.status, 'succeeded');
  assert.equal(importItem?.status, 'succeeded');
  assert.equal(importItem?.warnings, undefined);
  assert.equal(importItem?.notices, undefined);
  assert.equal(deleteCalls, 0);
});

test('same-instance default replacement deletes exact-name root target before import', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const deleteCalls: string[] = [];
  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
    {
      id: 'my-docs-existing',
      identifier: 'my-docs-existing',
      name: 'NFL MVP Analytics',
      folderPath: '',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'imported-nfl-dashboard',
    documentId: 'imported-nfl-dashboard',
  }));
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async (documentId: string) => {
    deleteCalls.push(documentId);
  });

  const created = await createMigrationJob({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
      sameNamedStrategy: 'replace',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const deleteItem = job.items.find((item) => item.kind === 'delete');
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(deleteCalls, ['my-docs-existing']);
  assert.equal(deleteItem?.status, 'succeeded');
  assert.equal(deleteItem?.replacement, true);
  assert.equal(importItem?.status, 'succeeded');
});

test('dashboard migration updates same-named destination document through Documents V2 draft publish', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultFolderPath: 'Target Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourcePresentations = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [
    `tile_${index}`,
    {
      type: 'bar',
      query: {
        modelId: 'source-model',
        topicName: 'source_topic',
        queryViewName: 'source_view',
        fields: ['orders.id'],
      },
    },
  ]));
  const sourceState = {
    name: 'NorthstarDashboard',
    description: 'Source description',
    queryPresentations: { data: sourcePresentations },
    controls: { region: 'Texas' },
    settings: { theme: 'northstar' },
    containers: { root: ['tile_0'] },
  };
  const destinationState = {
    name: 'NorthstarDashboard',
    queryPresentations: {
      data: {
        tile_0: {
          type: 'table',
          query: { modelId: 'target-model', topicName: 'old_topic', queryViewName: 'old_view' },
        },
        stale_tile: {
          type: 'table',
          query: { modelId: 'target-model' },
        },
      },
    },
  };
  const firstPatches: Array<Record<string, unknown>> = [];
  const draftPatches: Array<Record<string, unknown>> = [];
  const publishedDocuments: string[] = [];
  const imports: string[] = [];
  const deletes: string[] = [];

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
        id: 'source-doc',
        identifier: 'source-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }]
      : [{
        id: 'target-doc',
        identifier: 'target-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Target Dashboards',
        baseModelId: 'target-model',
      }];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async function getDocumentStateV2(documentId: string) {
    return clientLabel(this) === 'Source' || documentId === 'source-doc' ? sourceState : destinationState;
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async () => [{
    name: 'target_topic',
    label: 'Target Topic',
  }]);
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => [{
    name: 'target_view',
    label: 'Target View',
  }]);
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async (input: { documentName?: string }) => {
    imports.push(input.documentName || 'unknown');
    throw new Error('import should not run for update-in-place');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async (documentId: string) => {
    deletes.push(documentId);
  });
  mock.method(OmniClient.prototype, 'createDocumentDraft', async (documentId: string, patch: Record<string, unknown>) => {
    firstPatches.push(patch);
    return { identifier: documentId, draftIdentifier: 'draft-target-doc', raw: {} };
  });
  mock.method(OmniClient.prototype, 'patchDocumentDraft', async (_documentId: string, _draftId: string, patch: Record<string, unknown>) => {
    draftPatches.push(patch);
  });
  mock.method(OmniClient.prototype, 'publishDocumentDraft', async (documentId: string) => {
    publishedDocuments.push(documentId);
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-row',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'dest-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Target Dashboards',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'map_existing',
        targetTopicName: 'target_topic',
      }],
      queryViewMappings: [{
        sourceQueryViewName: 'source_view',
        action: 'map_existing',
        targetQueryViewName: 'target_view',
      }],
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const updateItem = job.items.find((item) => item.kind === 'update');
  const presentationPatches = [firstPatches[0], ...draftPatches]
    .map((patch) => patch?.queryPresentations as { data?: Record<string, unknown | null> } | undefined)
    .filter((patch): patch is { data: Record<string, unknown | null> } => Boolean(patch?.data));
  const firstTile = presentationPatches[0].data.tile_0 as { query?: Record<string, unknown> };
  const staleTilePatch = presentationPatches.find((patch) => Object.hasOwn(patch.data, 'stale_tile'));

  assert.equal(job.status, 'succeeded');
  assert.equal(updateItem?.status, 'succeeded');
  assert.equal(updateItem?.importedDocumentId, 'target-doc');
  assert.equal(updateItem?.details?.updateInPlace, true);
  assert.equal(updateItem?.details?.tileCount, 50);
  assert.equal(updateItem?.details?.deletedTileCount, 1);
  assert.equal(updateItem?.details?.modelRewriteCount, 50);
  assert.equal(updateItem?.details?.topicRewriteCount, 50);
  assert.equal(updateItem?.details?.queryViewRewriteCount, 50);
  assert.deepEqual(imports, []);
  assert.deepEqual(deletes, []);
  assert.deepEqual(publishedDocuments, ['target-doc']);
  assert.equal(firstPatches[0].name, 'NorthstarDashboard');
  assert.equal(firstPatches[0].description, 'Source description');
  assert.equal(firstTile.query?.modelId, 'target-model');
  assert.equal(firstTile.query?.topicName, 'target_topic');
  assert.equal(firstTile.query?.queryViewName, 'target_view');
  assert.equal(staleTilePatch?.data.stale_tile, null);
  assert.equal(draftPatches.some((patch) => patch.controls && patch.settings && patch.containers), true);
  for (const patch of presentationPatches) {
    const nonNullCount = Object.values(patch.data).filter((value) => value !== null && value !== undefined).length;
    assert.ok(nonNullCount <= 48);
  }
});

test('dashboard migration retry reruns failed update-in-place items', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultFolderPath: 'Target Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let failDraft = true;
  let draftCalls = 0;

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
        id: 'source-doc',
        identifier: 'source-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }]
      : [{
        id: 'target-doc',
        identifier: 'target-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Target Dashboards',
        baseModelId: 'target-model',
      }];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async function getDocumentStateV2(documentId: string) {
    if (clientLabel(this) === 'Source' || documentId === 'source-doc') {
      return {
        name: 'NorthstarDashboard',
        queryPresentations: {
          data: {
            tile_1: { query: { modelId: 'source-model', fields: ['orders.id'] } },
          },
        },
      };
    }
    return {
      name: 'NorthstarDashboard',
      queryPresentations: { data: {} },
    };
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'createDocumentDraft', async (documentId: string) => {
    draftCalls += 1;
    if (failDraft) throw new Error('Draft create failed.');
    return { identifier: documentId, draftIdentifier: 'draft-target-doc', raw: {} };
  });
  mock.method(OmniClient.prototype, 'patchDocumentDraft', async () => undefined);
  mock.method(OmniClient.prototype, 'publishDocumentDraft', async () => undefined);
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    throw new Error('import should not run for update retry');
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-row',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'dest-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Target Dashboards',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const failedJob = await waitForJob(created.id);
  const failedUpdate = failedJob.items.find((item) => item.kind === 'update');
  failDraft = false;

  const retry = await retryMigrationJob(failedJob.id);
  const retriedJob = await waitForJob(retry.id);

  assert.equal(failedUpdate?.status, 'failed');
  assert.match(failedUpdate?.error || '', /Draft create failed/);
  assert.equal(retry.items.some((item) => item.kind === 'update'), true);
  assert.equal(retry.items.some((item) => item.kind === 'import'), false);
  assert.equal(retriedJob.items.find((item) => item.kind === 'update')?.status, 'succeeded');
  assert.ok(draftCalls >= 2);
});

test('dashboard migration update-in-place reports unpublished draft conflicts clearly', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultFolderPath: 'Target Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
        id: 'source-doc',
        identifier: 'source-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }]
      : [{
        id: 'target-doc',
        identifier: 'target-doc',
        name: 'NorthstarDashboard',
        folderPath: 'Target Dashboards',
        baseModelId: 'target-model',
      }];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async function getDocumentStateV2(documentId: string) {
    if (clientLabel(this) === 'Source' || documentId === 'source-doc') {
      return {
        name: 'NorthstarDashboard',
        queryPresentations: {
          data: {
            tile_1: { query: { modelId: 'source-model', fields: ['orders.id'] } },
          },
        },
      };
    }
    return {
      name: 'NorthstarDashboard',
      queryPresentations: { data: {} },
    };
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'createDocumentDraft', async () => {
    throw new OmniClientError(409, 'https://dest.example.omniapp.co/api/v2/documents/target-doc/drafts', 'draft exists');
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-row',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'dest-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Target Dashboards',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const updateItem = job.items.find((item) => item.kind === 'update');

  assert.equal(updateItem?.status, 'failed');
  assert.equal(updateItem?.error, 'The destination dashboard has an unpublished draft. Publish or discard it in Omni, then retry this destination.');
});

test('planner still skips empty-first cleanup when target folder is unscoped', async () => {
  upsertInstance({
    id: 'atx',
    label: 'ATX Demo',
    role: 'source',
    baseUrl: 'https://atx.example.omniapp.co',
    apiKey: 'atx-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'Just For Fun',
      baseModelId: 'target-model',
    },
    {
      id: 'my-docs-existing',
      identifier: 'my-docs-existing',
      name: 'NFL MVP Analytics',
      folderPath: '',
      baseModelId: 'target-model',
    },
  ]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'plays.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['plays.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'atx',
    sourceConnectionId: 'atx-connection',
    sourceFolderPath: 'Just For Fun',
    targets: [{
      id: 'target-my-docs',
      destinationInstanceId: 'atx',
      targetConnectionId: 'atx-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['nfl-superstar-team-motion-lab-v34'],
    emptyFirst: true,
    replaceSameNamed: true,
  });

  assert.equal(plan.steps.some((step) => step.kind === 'delete'), false);
  const importStep = plan.steps.find((step) => step.kind === 'import');
  assert.equal(importStep?.warnings, undefined);
  assert.match(importStep?.notices?.join(' ') || '', /cleanup was skipped/i);
});

test('planner treats Omni formula helpers as functions instead of missing destination fields', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Formula Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': [
      'dimensions:',
      '  id:',
      'measures:',
      '  total_revenue:',
    ].join('\n'),
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{
      fields: ['orders.id', 'orders.total_revenue'],
      formula: 'SqlStdOperatorTable.CAST(orders.id) + SqlStdOperatorTable.ROUND(orders.total_revenue) + Omni.OMNI_FX_SUM(orders.total_revenue)',
    }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const importStep = plan.steps.find((step) => step.kind === 'import');
  const warnings = importStep?.warnings || [];

  assert.equal(warnings.some((warning) => warning.includes('OMNI_FX')), false);
  assert.equal(warnings.some((warning) => warning.includes('SqlStdOperatorTable')), false);
  assert.equal(warnings.some((warning) => warning.includes('referenced fields were not found')), false);
});

test('planner suppresses best-effort missing-field warnings for same target model copies', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Same Model Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'target-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'target-model',
    tiles: [{ fields: ['omni_dbt_marts__mart_play_motion_replay_frames.actor_color'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const warnings = plan.steps.flatMap((step) => step.warnings || []);

  assert.equal(warnings.some((warning) => warning.includes('referenced fields were not found')), false);
});

test('planner turns missing model fields into resolvable field dependencies', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Semantic Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? {
          'orders.view': [
            'measures:',
            '  semantic_total_sales:',
            '    sql: ${orders.total_sales}',
            '    aggregate_type: sum',
          ].join('\n'),
        }
      : {
          'orders.view': [
            'measures:',
            '  total_sales:',
            '    sql: ${orders.amount}',
            '    aggregate_type: sum',
          ].join('\n'),
        };
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const fieldPrep = plan.steps.find((step) => step.kind === 'field_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const dependencies = fieldPrep?.details?.fieldDependencies as Array<Record<string, unknown>>;
  const candidates = dependencies[0].targetCandidates as Array<Record<string, unknown>>;

  assert.equal(fieldPrep?.blocked, true);
  assert.equal(dependencies[0].sourceFieldRef, 'orders.semantic_total_sales');
  assert.equal(dependencies[0].fieldKind, 'measure');
  assert.equal(dependencies[0].status, 'unresolved');
  assert.equal(candidates[0].fieldRef, 'orders.total_sales');
  assert.equal(importStep?.warnings?.some((warning) => warning.includes('referenced fields were not found')), undefined);
  assert.match(importStep?.error || '', /field dependencies/);
});

test('planner classifies semantic field patch candidates with dependency metadata', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceYaml = [
    'measures:',
    '  semantic_total_sales:',
    '    sql: ${orders.total_sales}',
    '    aggregate_type: sum',
  ].join('\n');
  const targetYaml = [
    'measures:',
    '  total_sales:',
    '    sql: ${orders.amount}',
    '    aggregate_type: sum',
  ].join('\n');

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Semantic Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'target-model', name: 'Target Model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'orders.view': sourceYaml }
      : { 'orders.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    return clientLabel(this) === 'Source'
      ? {
          files: { 'orders.view': sourceYaml },
          checksums: options.includeChecksums ? { 'orders.view': 'source-orders' } : undefined,
          raw: { modelId },
        }
      : {
          files: { 'orders.view': targetYaml },
          checksums: options.includeChecksums ? { 'orders.view': 'target-orders' } : undefined,
          raw: { modelId },
        };
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
      fieldMappings: [{
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'create_from_source',
        sourceFileName: 'orders.view',
        targetFileName: 'orders.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const fieldPrep = plan.steps.find((step) => step.kind === 'field_prepare');
  const semanticPatches = fieldPrep?.details?.semanticPatches as Array<Record<string, unknown>>;
  const patch = semanticPatches[0];
  const dependencyPath = patch.dependencyPath as Array<Record<string, unknown>>;

  assert.equal(fieldPrep?.blocked, false);
  assert.equal(patch.artifactType, 'field');
  assert.equal(patch.safetyCategory, 'safe_update');
  assert.equal(patch.status, 'ready');
  assert.equal(patch.previousChecksum, 'target-orders');
  assert.match(String(patch.recommendedAction), /Create orders\.semantic_total_sales/);
  assert.equal(dependencyPath[0].kind, 'model_field');
  assert.equal(dependencyPath[0].ref, 'orders.semantic_total_sales');
  assert.equal(dependencyPath[1].kind, 'model_file');
  assert.equal(dependencyPath[1].ref, 'orders.view');
});

test('planner blocks accepted semantic patches when destination checksum is stale', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const sourceYaml = [
    'measures:',
    '  semantic_total_sales:',
    '    sql: ${orders.total_sales}',
    '    aggregate_type: sum',
  ].join('\n');
  const targetYaml = [
    'measures:',
    '  total_sales:',
    '    sql: ${orders.amount}',
    '    aggregate_type: sum',
  ].join('\n');
  const acceptedYaml = [
    targetYaml,
    '  semantic_total_sales:',
    '    sql: ${orders.total_sales}',
    '    aggregate_type: sum',
  ].join('\n');

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Semantic Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'target-model', name: 'Target Model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'orders.view': sourceYaml }
      : { 'orders.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    return clientLabel(this) === 'Source'
      ? {
          files: { 'orders.view': sourceYaml },
          checksums: options.includeChecksums ? { 'orders.view': 'source-orders' } : undefined,
          raw: { modelId },
        }
      : {
          files: { 'orders.view': targetYaml },
          checksums: options.includeChecksums ? { 'orders.view': 'target-orders-new' } : undefined,
          raw: { modelId },
        };
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
      fieldMappings: [{
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'create_from_source',
        sourceFileName: 'orders.view',
        targetFileName: 'orders.view',
      }],
      semanticPatches: [{
        id: 'field:orders.semantic_total_sales:orders.view',
        artifactType: 'field',
        sourceName: 'orders.semantic_total_sales',
        targetFileName: 'orders.view',
        acceptedYaml,
        previousChecksum: 'target-orders-old',
        resolution: 'recommended',
        status: 'ready',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const fieldPrep = plan.steps.find((step) => step.kind === 'field_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const semanticPatches = fieldPrep?.details?.semanticPatches as Array<Record<string, unknown>>;
  const patch = semanticPatches[0];

  assert.equal(fieldPrep?.blocked, true);
  assert.match(fieldPrep?.error || '', /needs resolution/i);
  assert.equal(importStep?.blocked, true);
  assert.equal(patch.checksumStale, true);
  assert.equal(patch.previousChecksum, 'target-orders-old');
  assert.equal(patch.latestChecksum, 'target-orders-new');
  assert.equal(patch.status, 'blocked');
  assert.equal(patch.safetyCategory, 'blocked');
  assert.equal((patch.warnings as string[]).some((warning) => /Destination YAML changed/i.test(warning)), true);
});

test('planner surfaces missing dependencies inside fields created from source YAML', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Dependent Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? {
          'orders.view': [
            'measures:',
            '  semantic_total_sales:',
            '    sql: ${orders.net_sales}',
            '    aggregate_type: sum',
            '  net_sales:',
            '    sql: ${orders.gross_sales} - ${orders.discounts}',
            '    aggregate_type: sum',
          ].join('\n'),
        }
      : {
          'orders.view': [
            'measures:',
            '  gross_sales:',
            '    sql: ${orders.amount}',
            '    aggregate_type: sum',
            '  discounts:',
            '    sql: ${orders.discount_amount}',
            '    aggregate_type: sum',
          ].join('\n'),
        };
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
      fieldMappings: [{
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'create_from_source',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const fieldPrep = plan.steps.find((step) => step.kind === 'field_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');
  const dependencies = fieldPrep?.details?.fieldDependencies as Array<Record<string, unknown>>;
  const semanticDependency = dependencies.find((dependency) => dependency.sourceFieldRef === 'orders.semantic_total_sales');
  const nestedDependency = dependencies.find((dependency) => dependency.sourceFieldRef === 'orders.net_sales');

  assert.equal(fieldPrep?.blocked, true);
  assert.equal(semanticDependency?.status, 'warning');
  assert.match((semanticDependency?.warnings as string[] | undefined)?.join(' ') || '', /orders\.net_sales/);
  assert.equal(nestedDependency?.status, 'unresolved');
  assert.match(nestedDependency?.reason as string, /required by orders\.semantic_total_sales/);
  assert.match(importStep?.error || '', /field dependencies/);
});

test('dashboard migration creates selected source fields before dashboard import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const writes: Array<{ fileName: string; yaml: string }> = [];
  let importedCreated = false;

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (clientLabel(this) === 'Source') {
      return [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Semantic Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }];
    }
    return importedCreated
      ? [{
          id: 'imported-doc-1',
          identifier: 'imported-doc-1',
          name: 'Semantic Field Dashboard',
          folderPath: 'Migrated Dashboards',
          baseModelId: 'target-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? {
          'orders.view': [
            'dimensions:',
            '  id:',
            'measures:',
            '  semantic_total_sales:',
            '    sql: ${orders.total_sales}',
            '    aggregate_type: sum',
          ].join('\n'),
        }
      : {
          'orders.view': 'dimensions:\n  id:\nmeasures:\n  total_sales:\n',
        };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    if (clientLabel(this) === 'Source') {
      return {
        files: {
          'orders.view': [
            'dimensions:',
            '  id:',
            'measures:',
            '  semantic_total_sales:',
            '    sql: ${orders.total_sales}',
            '    aggregate_type: sum',
          ].join('\n'),
        },
        checksums: options.includeChecksums ? { 'orders.view': 'source-orders' } : undefined,
        raw: { modelId },
      };
    }
    return {
      files: {
        'orders.view': 'dimensions:\n  id:\nmeasures:\n  total_sales:\n',
      },
      checksums: options.includeChecksums ? { 'orders.view': 'target-orders' } : undefined,
      raw: { modelId },
    };
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: { fileName: string; yaml: string }) => {
    writes.push({ fileName: input.fileName, yaml: input.yaml });
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importedCreated = true;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });
  mock.method(OmniClient.prototype, 'moveDocument', async () => ({}));

	  const created = await createMigrationJob({
	    sourceId: 'source-1',
	    targets: [{
	      id: 'target-1',
	      destinationInstanceId: 'dest-1',
	      targetConnectionId: 'target-connection-1',
	      targetModelId: 'target-model',
	      fieldMappings: [{
	        sourceFieldRef: 'orders.semantic_total_sales',
	        action: 'create_from_source',
        sourceFileName: 'orders.view',
        targetFileName: 'orders.view',
      }],
    }],
    documentIds: ['source-doc-1'],
	    emptyFirst: false,
	    replaceSameNamed: false,
	    postMigrationActions: [],
	  });

  const job = await waitForJob(created.id);
  const fieldPrep = job.items.find((item) => item.kind === 'field_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(job.status, 'succeeded');
  assert.equal(fieldPrep?.status, 'succeeded');
  assert.equal(importItem?.status, 'succeeded');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fileName, 'orders.view');
  assert.match(writes[0].yaml, /semantic_total_sales:/);
  assert.match(writes[0].yaml, /aggregate_type: sum/);
});

test('dashboard migration applies accepted semantic field code patches before import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const writes: Array<{ fileName: string; yaml: string; previousChecksum?: string }> = [];
  let importedCreated = false;
  const sourceYaml = [
    'dimensions:',
    '  id:',
    'measures:',
    '  semantic_total_sales:',
    '    sql: ${orders.total_sales}',
    '    aggregate_type: sum',
  ].join('\n');
  const targetYaml = 'dimensions:\n  id:\nmeasures:\n  total_sales:\n';
  const customYaml = [
    'dimensions:',
    '  id:',
    'measures:',
    '  semantic_total_sales:',
    '    sql: ${orders.total_sales}',
    '    label: Custom reviewed field',
  ].join('\n');

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (clientLabel(this) === 'Source') {
      return [{
        id: 'source-doc-1',
        identifier: 'source-doc-1',
        name: 'Semantic Field Dashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }];
    }
    return importedCreated
      ? [{
        id: 'imported-doc-1',
        identifier: 'imported-doc-1',
        name: 'Semantic Field Dashboard',
        folderPath: 'Migrated Dashboards',
        baseModelId: 'target-model',
      }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'target-model', name: 'Target Model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'orders.view': sourceYaml }
      : { 'orders.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    return clientLabel(this) === 'Source'
      ? {
        files: { 'orders.view': sourceYaml },
        checksums: options.includeChecksums ? { 'orders.view': 'source-orders' } : undefined,
        raw: { modelId },
      }
      : {
        files: { 'orders.view': targetYaml },
        checksums: options.includeChecksums ? { 'orders.view': 'target-orders' } : undefined,
        raw: { modelId },
      };
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: { fileName: string; yaml: string; previousChecksum?: string }) => {
    writes.push({ fileName: input.fileName, yaml: input.yaml, previousChecksum: input.previousChecksum });
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importedCreated = true;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });
  mock.method(OmniClient.prototype, 'moveDocument', async () => ({}));

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model',
      fieldMappings: [{
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'create_from_source',
        sourceFileName: 'orders.view',
        targetFileName: 'orders.view',
      }],
      semanticPatches: [{
        id: 'field:orders.semantic_total_sales:orders.view',
        artifactType: 'field',
        sourceName: 'orders.semantic_total_sales',
        targetFileName: 'orders.view',
        acceptedYaml: customYaml,
        previousChecksum: 'target-orders',
        resolution: 'custom_edit',
        status: 'ready',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const fieldPrep = job.items.find((item) => item.kind === 'field_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(job.status, 'succeeded');
  assert.equal(fieldPrep?.status, 'succeeded');
  assert.equal(importItem?.status, 'succeeded');
  assert.deepEqual(writes, [{
    fileName: 'orders.view',
    yaml: customYaml,
    previousChecksum: 'target-orders',
  }]);
});

test('dashboard migration retry reruns failed field preparation with updated patches', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const writes: Array<{ fileName: string; yaml: string; previousChecksum?: string }> = [];
  let importedCreated = false;
  const sourceYaml = 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n    aggregate_type: sum\n';
  const targetYaml = 'measures:\n  total_sales:\n    sql: ${orders.amount}\n';
  const brokenYaml = 'measures:\n  semantic_total_sales:\n    sql: ${orders.broken_total_sales}\n';
  const fixedYaml = 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n    aggregate_type: sum\n';

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    if (clientLabel(this) === 'Source') {
      return [{
        id: 'source-doc-1',
        identifier: 'source-doc-1',
        name: 'Semantic Field Dashboard',
        folderPath: 'Source Dashboards',
        baseModelId: 'source-model',
      }];
    }
    return importedCreated
      ? [{
        id: 'imported-doc-1',
        identifier: 'imported-doc-1',
        name: 'Semantic Field Dashboard',
        folderPath: 'Migrated Dashboards',
        baseModelId: 'target-model',
      }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'target-model', name: 'Target Model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'orders.view': sourceYaml }
      : { 'orders.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    return clientLabel(this) === 'Source'
      ? {
        files: { 'orders.view': sourceYaml },
        checksums: options.includeChecksums ? { 'orders.view': 'source-orders' } : undefined,
        raw: { modelId },
      }
      : {
        files: { 'orders.view': targetYaml },
        checksums: options.includeChecksums ? { 'orders.view': 'target-orders' } : undefined,
        raw: { modelId },
      };
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: { fileName: string; yaml: string; previousChecksum?: string }) => {
    if (input.yaml.includes('broken_total_sales')) throw new Error('Omni validation rejected broken field YAML.');
    writes.push({ fileName: input.fileName, yaml: input.yaml, previousChecksum: input.previousChecksum });
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importedCreated = true;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });
  mock.method(OmniClient.prototype, 'moveDocument', async () => ({}));

  const baseTarget = {
    id: 'target-1',
    destinationInstanceId: 'dest-1',
    targetConnectionId: 'target-connection-1',
    targetModelId: 'target-model',
    targetFolderPath: 'Migrated Dashboards',
    fieldMappings: [{
      sourceFieldRef: 'orders.semantic_total_sales',
      action: 'create_from_source' as const,
      sourceFileName: 'orders.view',
      targetFileName: 'orders.view',
    }],
  };
  const initialInput = {
    sourceId: 'source-1',
    routeGroups: [{
      id: 'route-fields',
      name: 'Field route',
      documentIds: ['source-doc-1'],
      targets: [{
        ...baseTarget,
        semanticPatches: [{
          id: 'field:orders.semantic_total_sales:orders.view',
          artifactType: 'field' as const,
          sourceName: 'orders.semantic_total_sales',
          targetFileName: 'orders.view',
          acceptedYaml: brokenYaml,
          previousChecksum: 'target-orders',
          resolution: 'custom_edit' as const,
          status: 'ready' as const,
        }],
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  };

  const created = await createMigrationJob(initialInput);
  const failedJob = await waitForJob(created.id);
  const fieldPrep = failedJob.items.find((item) => item.kind === 'field_prepare');
  const importItem = failedJob.items.find((item) => item.kind === 'import');

  assert.equal(failedJob.status, 'partial');
  assert.equal(fieldPrep?.status, 'failed');
  assert.match(fieldPrep?.error || '', /broken field YAML/);
  assert.equal(importItem?.status, 'skipped');
  assert.match(importItem?.error || '', /import skipped|dependent step skipped/i);

  const retry = await retryMigrationJob(failedJob.id, {
    retryInput: {
      ...initialInput,
      routeGroups: [{
        id: 'route-fields',
        name: 'Field route',
        documentIds: ['source-doc-1'],
        targets: [{
          ...baseTarget,
          semanticPatches: [{
            id: 'field:orders.semantic_total_sales:orders.view',
            artifactType: 'field',
            sourceName: 'orders.semantic_total_sales',
            targetFileName: 'orders.view',
            acceptedYaml: fixedYaml,
            previousChecksum: 'target-orders',
            resolution: 'custom_edit',
            status: 'ready',
          }],
        }],
      }],
    },
  });
  const retriedJob = await waitForJob(retry.id);
  const retriedFieldPrep = retriedJob.items.find((item) => item.kind === 'field_prepare');
  const retriedImport = retriedJob.items.find((item) => item.kind === 'import');

  assert.equal(retriedJob.status, 'succeeded');
  assert.deepEqual(retriedJob.routeGroups?.map((group) => group.id), ['route-fields']);
  assert.deepEqual(retriedJob.documentIds, ['source-doc-1']);
  assert.equal(retriedFieldPrep?.status, 'succeeded');
  assert.equal(retriedImport?.status, 'succeeded');
  assert.deepEqual(writes, [{
    fileName: 'orders.view',
    yaml: fixedYaml,
    previousChecksum: 'target-orders',
  }]);
});

test('dashboard patch validation uses scratch branch lifecycle and maps errors to artifacts', async () => {
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const calls: string[] = [];
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model',
    name: 'Target Model',
    connectionId: 'target-connection-1',
    gitConfigured: false,
  }]);
  mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }) => {
    calls.push(`create:${input.branchName.startsWith('omnikit-validate-')}`);
    return { id: 'branch-model-id', name: input.branchName, raw: {} };
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFiles', async (input: { branchId: string; files: Array<{ fileName: string }> }) => {
    calls.push(`write:${input.branchId}:${input.files.map((file) => file.fileName).join(',')}`);
  });
  modelValidationMock = async (_modelId: string, branchId?: string) => {
    calls.push(`validate:${branchId}`);
    return [{ message: 'Bad field definition', yaml_path: 'orders.view.measures.semantic_total_sales' }];
  };
  contentValidationMock = async (_modelId: string, options?: string | { branchId?: string }) => {
    calls.push(`content:${typeof options === 'string' ? options : options?.branchId}`);
    return { issues: [{ severity: 'error', field: 'semantic_total_sales', message: 'Dashboard query still references an invalid field.' }] };
  };
  mock.method(OmniClient.prototype, 'deleteModelBranch', async (modelId: string, branchName: string) => {
    calls.push(`delete:${modelId}:${branchName.startsWith('omnikit-validate-')}`);
  });

  const validation = await validateDashboardMigrationPatches({
    sourceId: 'source-1',
    routeGroups: [{
      id: 'route-fields',
      name: 'Field route',
      documentIds: ['source-doc-1'],
      targets: [{
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
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
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  assert.equal(validation.status, 'failed');
  assert.equal(validation.results[0].mode, 'branch');
  assert.equal(validation.results[0].artifacts[0].status, 'failed');
  assert.match(validation.results[0].artifacts[0].messages.join(' '), /Bad field definition/);
  assert.match(validation.results[0].artifacts[0].messages.join(' '), /Dashboard query still references an invalid field/);
  assert.deepEqual(validation.results[0].modelValidation, { issueCount: 1, errorCount: 1 });
  assert.deepEqual(validation.results[0].contentValidation, { issueCount: 1, errorCount: 1 });
  assert.deepEqual(calls, [
    'create:true',
    'write:branch-model-id:orders.view',
    'validate:branch-model-id',
    'content:branch-model-id',
    'delete:target-model:true',
  ]);
});

test('dashboard patch validation falls back to structural checks only when branch creation is unsupported', async () => {
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  let branchCreated = false;
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model',
    name: 'Target Model',
    connectionId: 'target-connection-1',
    gitConfigured: false,
  }]);
  mock.method(OmniClient.prototype, 'createModelBranch', async () => {
    branchCreated = true;
    throw new OmniClientError(404, 'https://dest.example.omniapp.co/api/v1/models', 'Branch model kind is not supported.');
  });

  const validation = await validateDashboardMigrationPatches({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
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
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  assert.equal(branchCreated, true);
  assert.equal(validation.status, 'passed');
  assert.equal(validation.results[0].mode, 'structural');
  assert.match(validation.results[0].artifacts[0].messages.join(' '), /isolated branch validation is unavailable/);
});

test('dashboard migration blocks unsafe accepted semantic field patches before import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  const writes: Array<{ fileName: string; yaml: string }> = [];
  let importCalled = false;
  const sourceYaml = 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n';
  const targetYaml = 'measures:\n  total_sales:\n    sql: ${orders.amount}\n';

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Semantic Field Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'target-model', name: 'Target Model' }]);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'orders.view': sourceYaml }
      : { 'orders.view': targetYaml };
  });
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    return clientLabel(this) === 'Source'
      ? {
          files: { 'orders.view': sourceYaml },
          checksums: options.includeChecksums ? { 'orders.view': 'source-orders' } : undefined,
          raw: { modelId },
        }
      : {
          files: { 'orders.view': targetYaml },
          checksums: options.includeChecksums ? { 'orders.view': 'target-orders' } : undefined,
          raw: { modelId },
        };
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async (input: { fileName: string; yaml: string }) => {
    writes.push({ fileName: input.fileName, yaml: input.yaml });
  });
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.semantic_total_sales'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importCalled = true;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  await assert.rejects(() => createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model',
      fieldMappings: [{
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'create_from_source',
        sourceFileName: 'orders.view',
        targetFileName: 'orders.view',
      }],
      semanticPatches: [{
        id: 'field:orders.semantic_total_sales:orders.view',
        artifactType: 'field',
        sourceName: 'orders.semantic_total_sales',
        targetFileName: 'orders.view',
        acceptedYaml: 'blocked yaml',
        previousChecksum: 'target-orders',
        resolution: 'custom_edit',
        status: 'blocked',
        safetyCategory: 'blocked',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  }), /needs resolution before dashboard import/);

  assert.equal(importCalled, false);
  assert.deepEqual(writes, []);
});

test('planner blocks topic-backed imports when mapped target model is missing required fields', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'source_topic' },
    tiles: [{ fields: ['orders.missing_field'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async () => [{ name: 'source_topic', label: 'Source Topic' }]);

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'map_existing',
        targetTopicName: 'source_topic',
        targetTopicLabel: 'Source Topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const topicPrep = plan.steps.find((step) => step.kind === 'topic_prepare');
  const importStep = plan.steps.find((step) => step.kind === 'import');

  assert.equal(topicPrep?.warnings?.some((warning) => warning.includes('referenced fields were not found')), undefined);
  assert.equal(topicPrep?.blocked, true);
  assert.match(topicPrep?.error || '', /field dependencies/);
  assert.equal(importStep?.warnings?.some((warning) => warning.includes('referenced fields were not found')), undefined);
  assert.equal(importStep?.blocked, true);
  assert.match(importStep?.error || '', /field dependencies/);
  const details = importStep?.details as Record<string, unknown> | undefined;
  assert.deepEqual(details?.unresolvedSemanticFieldRefs, ['orders.missing_field']);
  const fieldDependencies = details?.fieldDependencies as Array<Record<string, unknown>>;
  assert.equal(fieldDependencies[0].sourceFieldRef, 'orders.missing_field');
  assert.equal(fieldDependencies[0].status, 'unresolved');
});

test('planner adds source delete only after copy import steps when requested', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultModelId: 'target-model',
    defaultFolderPath: 'Migrated Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Migrated Dashboards',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
  });

  assert.equal(plan.sourceConnectionId, 'source-connection');
  assert.equal(plan.deleteSourceOnSuccess, true);
  assert.equal(plan.targets[0].targetConnectionId, 'target-connection');
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    'export',
    'semantic_validate',
    'query_validate',
    'import',
    'metadata',
    'document_verify',
    'source_delete',
  ]);
  assert.equal(plan.steps.at(-1)?.destinationId, 'source-1');
  assert.equal(plan.steps.at(-1)?.documentId, 'source-doc-1');
});

test('planner supports multiple target instances in one dashboard migration', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
        targetModelId: 'target-model-1',
      },
      {
        id: 'target-2',
        destinationInstanceId: 'dest-2',
        targetConnectionId: 'target-connection-2',
        targetModelId: 'target-model-2',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  assert.deepEqual(plan.destinationIds, ['dest-1', 'dest-2']);
  assert.deepEqual(plan.targets.map((target) => target.targetConnectionId), ['target-connection-1', 'target-connection-2']);
  assert.equal(plan.steps.filter((step) => step.kind === 'import').length, 2);
});

test('planner supports multiple target rows in the same instance across connections', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-connection-a',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'connection-a',
        targetModelId: 'target-model-a',
      },
      {
        id: 'target-connection-b',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'connection-b',
        targetModelId: 'target-model-b',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  assert.deepEqual(plan.destinationIds, ['dest-1']);
  assert.deepEqual(plan.targets.map((target) => target.id), ['target-connection-a', 'target-connection-b']);
  assert.deepEqual(plan.steps.filter((step) => step.kind === 'import').map((step) => step.targetConnectionId), ['connection-a', 'connection-b']);
});

test('planner routes one dashboard to repeated same-instance target folders with scoped replacements', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const sourceDocs: OmniDocumentRecord[] = [{
    id: 'source-doc-1',
    identifier: 'source-doc-1',
    name: 'Executive Scorecard',
    folderPath: 'Source Dashboards',
    baseModelId: 'source-model',
  }];
  const destinationDocs: OmniDocumentRecord[] = [
    {
      id: 'dest-folder-a-existing',
      identifier: 'dest-folder-a-existing',
      name: 'Executive Scorecard',
      folderPath: 'Team A',
    },
    {
      id: 'dest-folder-b-existing',
      identifier: 'dest-folder-b-existing',
      name: 'Executive Scorecard',
      folderPath: 'Team B',
    },
    {
      id: 'dest-folder-c-existing',
      identifier: 'dest-folder-c-existing',
      name: 'Executive Scorecard',
      folderPath: 'Team C',
    },
  ];

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source' ? sourceDocs : destinationDocs;
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    routeGroups: [{
      id: 'route-executive',
      name: 'Executive route',
      documentIds: ['source-doc-1'],
      targets: [
        {
          id: 'target-team-a',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-a',
          targetModelId: 'target-model-a',
          targetFolderPath: 'Team A',
        },
        {
          id: 'target-team-b',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-b',
          targetModelId: 'target-model-b',
          targetFolderPath: 'Team B',
        },
      ],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
  });

  const deletes = plan.steps.filter((step) => step.kind === 'delete');
  const imports = plan.steps.filter((step) => step.kind === 'import');

  assert.deepEqual(deletes.map((step) => `${step.targetId}:${step.documentId}:${step.targetFolderPath}`), [
    'target-team-a:dest-folder-a-existing:Team A',
    'target-team-b:dest-folder-b-existing:Team B',
  ]);
  assert.equal(deletes.every((step) => step.replacement === true), true);
  assert.equal(deletes.some((step) => step.documentId === 'dest-folder-c-existing'), false);
  assert.deepEqual(imports.map((step) => `${step.routeGroupId}:${step.targetId}:${step.documentId}`), [
    'route-executive:target-team-a:source-doc-1',
    'route-executive:target-team-b:source-doc-1',
  ]);
});

test('planner route groups only create dashboard-target pairs declared by each group', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [
          {
            id: 'source-doc-a',
            identifier: 'source-doc-a',
            name: 'Orders Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-a',
          },
          {
            id: 'source-doc-b',
            identifier: 'source-doc-b',
            name: 'Finance Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-b',
          },
        ]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));

  const plan = await buildMigrationPlan({
    sourceId: 'source-1',
    routeGroups: [
      {
        id: 'route-orders',
        name: 'Orders route',
        documentIds: ['source-doc-a'],
        targets: [{
          id: 'target-orders',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-orders',
          targetModelId: 'target-model-orders',
        }],
      },
      {
        id: 'route-finance',
        name: 'Finance route',
        documentIds: ['source-doc-b'],
        targets: [{
          id: 'target-finance',
          destinationInstanceId: 'dest-2',
          targetConnectionId: 'connection-finance',
          targetModelId: 'target-model-finance',
        }],
      },
    ],
    documentIds: ['source-doc-a', 'source-doc-b'],
    emptyFirst: false,
    replaceSameNamed: false,
  });

  const imports = plan.steps.filter((step) => step.kind === 'import');

  assert.deepEqual(plan.routeGroups?.map((group) => group.id), ['route-orders', 'route-finance']);
  assert.deepEqual(imports.map((step) => `${step.routeGroupId}:${step.documentId}:${step.destinationId}`), [
    'route-orders:source-doc-a:dest-1',
    'route-finance:source-doc-b:dest-2',
  ]);
  assert.equal(imports.some((step) => step.documentId === 'source-doc-a' && step.destinationId === 'dest-2'), false);
  assert.equal(imports.some((step) => step.documentId === 'source-doc-b' && step.destinationId === 'dest-1'), false);
});

test('dashboard route-group retry preserves failed route audit metadata only', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [
          {
            id: 'source-doc-a',
            identifier: 'source-doc-a',
            name: 'Orders Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-a',
          },
          {
            id: 'source-doc-b',
            identifier: 'source-doc-b',
            name: 'Finance Dashboard',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model-b',
          },
        ]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    if (clientLabel(this) === 'Destination Two') throw new Error('Route import failed.');
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    routeGroups: [
      {
        id: 'route-orders',
        name: 'Orders route',
        documentIds: ['source-doc-a'],
        targets: [{
          id: 'target-orders',
          destinationInstanceId: 'dest-1',
          targetConnectionId: 'connection-orders',
          targetModelId: 'target-model-orders',
        }],
      },
      {
        id: 'route-finance',
        name: 'Finance route',
        documentIds: ['source-doc-b'],
        targets: [{
          id: 'target-finance',
          destinationInstanceId: 'dest-2',
          targetConnectionId: 'connection-finance',
          targetModelId: 'target-model-finance',
        }],
      },
    ],
    documentIds: ['source-doc-a', 'source-doc-b'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const routeKinds = job.items
    .filter((item) => item.routeGroupId)
    .map((item) => `${item.routeGroupId}:${item.kind}:${item.documentId}`);

  assert.ok(routeKinds.includes('route-orders:import:source-doc-a'));
  assert.ok(routeKinds.includes('route-finance:import:source-doc-b'));
  assert.equal(job.items.some((item) => item.routeGroupId === 'route-orders' && item.documentId === 'source-doc-b'), false);

  const retry = await retryMigrationJob(job.id);

  assert.deepEqual(retry.routeGroups?.map((group) => group.id), ['route-finance']);
  assert.deepEqual(retry.documentIds, ['source-doc-b']);
  assert.deepEqual(retry.targets?.map((target) => target.destinationInstanceId), ['dest-2']);
  assert.equal(retry.items.some((item) => item.routeGroupId === 'route-orders'), false);
  assert.equal(retry.items.some((item) => item.documentId === 'source-doc-a'), false);
  assert.ok(retry.items
    .filter((item) => item.kind === 'export' || item.kind === 'import' || item.kind === 'metadata')
    .every((item) => item.routeGroupId === 'route-finance' && item.routeGroupName === 'Finance route'));
});

test('source delete is skipped when any target import fails', async () => {
  for (const [id, label, role] of [
    ['source-1', 'Source', 'source'],
    ['dest-1', 'Destination One', 'destination'],
    ['dest-2', 'Destination Two', 'destination'],
  ] as const) {
    upsertInstance({
      id,
      label,
      role,
      baseUrl: `https://${id}.example.omniapp.co`,
      apiKey: `${id}-key`,
      defaultFolderPath: role === 'source' ? 'Source Dashboards' : undefined,
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }

  const sourceDoc = {
    id: 'source-doc-1',
    identifier: 'source-doc-1',
    name: 'Executive Scorecard',
    folderPath: 'Source Dashboards',
    baseModelId: 'source-model',
  };
  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source' ? [sourceDoc] : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    if (clientLabel(this) === 'Destination Two') throw new Error('Import failed.');
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [
      {
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
        targetModelId: 'target-model-1',
      },
      {
        id: 'target-2',
        destinationInstanceId: 'dest-2',
        targetConnectionId: 'target-connection-2',
        targetModelId: 'target-model-2',
      },
    ],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(sourceDelete?.status, 'skipped');
  assert.match(sourceDelete?.error || '', /import did not complete successfully/);
  assert.equal(sourceDeleteCalls, 0);
});

test('source delete is skipped when schema refresh fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Executive Scorecard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({
    identifier: 'imported-doc-1',
    documentId: 'imported-doc-1',
  }));
  mock.method(OmniClient.prototype, 'refreshModel', async () => {
    throw new Error('Refresh queue failed.');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [{
      kind: 'refresh-schema',
      name: 'Destination: refresh schema target-model-1',
      method: 'POST',
      url: '',
      headers: {},
      body: '',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model-1',
      targetModelName: 'Target Model',
    }],
  });

  const job = await waitForJob(created.id);
  const refresh = job.items.find((item) => item.kind === 'post_action');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(refresh?.status, 'failed');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.match(sourceDelete?.error || '', /post-migration action failed/);
  assert.equal(sourceDeleteCalls, 0);
});

test('dashboard migration maps existing target topics and rewrites dashboard payload before import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let importedPayload: Record<string, unknown> | null = null;
  let yamlWriteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      topicName: 'source_topic',
    },
    workbookModel: {
      topics: [{ name: 'unrelated_topic', label: 'Unrelated Topic' }],
    },
    queries: [{
      query: {
        topicName: 'source_topic',
        join_paths_from_topic_name: 'unrelated_topic',
      },
    }],
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    return clientLabel(this) === 'Destination'
      ? [{ name: 'target_topic', label: 'Target Topic' }]
      : [{ name: 'source_topic', label: 'Source Topic', fileName: 'source_topic.topic', yaml: 'label: Source Topic\nbase_view_name: orders\n' }];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    yamlWriteCalls += 1;
  });
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument(input: { exportPayload: Record<string, unknown> }) {
    importedPayload = input.exportPayload;
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'map_existing',
        targetTopicName: 'target_topic',
        targetTopicLabel: 'Target Topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const topicPrep = job.items.find((item) => item.kind === 'topic_prepare');
  const importedDashboard = importedPayload?.dashboard as Record<string, unknown> | undefined;
  const importedQueries = importedPayload?.queries as Array<{ query: Record<string, unknown> }> | undefined;

  assert.equal(job.status, 'succeeded');
  assert.equal(topicPrep?.status, 'succeeded');
  assert.equal(yamlWriteCalls, 0);
  assert.equal(importedDashboard?.topicName, 'target_topic');
  assert.equal(importedQueries?.[0]?.query.topicName, 'target_topic');
  assert.equal(importedQueries?.[0]?.query.join_paths_from_topic_name, 'unrelated_topic');
});

test('dashboard migration verifies mapped query views without writing YAML', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let yamlWriteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [{
          name: 'target_metrics',
          label: 'Target Metrics',
          fileName: 'target_metrics.query.view',
          yaml: 'label: Target Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    yamlWriteCalls += 1;
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => ({ identifier: 'imported-doc-1', documentId: 'imported-doc-1' }));

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'map_existing',
        targetQueryViewName: 'target_metrics',
        targetFileName: 'target_metrics.query.view',
        targetQueryViewLabel: 'Target Metrics',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const queryViewPrep = job.items.find((item) => item.kind === 'query_view_prepare');
  const details = queryViewPrep?.details as { mappedQueryViews?: string[] } | undefined;

  assert.equal(job.status, 'succeeded');
  assert.equal(queryViewPrep?.status, 'succeeded');
  assert.equal(yamlWriteCalls, 0);
  assert.deepEqual(details?.mappedQueryViews, ['northstar_metrics->Target Metrics']);
});

test('dashboard migration copies source query-view YAML before dashboard import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const calls: string[] = [];
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async function updateModelYamlFile(input: { fileName: string; yaml: string }) {
    calls.push(`write:${input.fileName}:${input.yaml.includes('Northstar Metrics')}`);
  });
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    calls.push('import');
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'copy_source',
        targetQueryViewName: 'northstar_metrics',
        targetFileName: 'northstar_metrics.query.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const queryViewPrep = job.items.find((item) => item.kind === 'query_view_prepare');
  const details = queryViewPrep?.details as { createdQueryViews?: string[] } | undefined;

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(calls, ['write:northstar_metrics.query.view:true', 'import']);
  assert.deepEqual(details?.createdQueryViews, ['northstar_metrics']);
});

test('dashboard migration updates existing query-view YAML only on explicit update action', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const updateCalls: Array<{ fileName: string; previousChecksum?: string; yaml: string }> = [];
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [{
          name: 'northstar_metrics',
          label: 'Northstar Metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
          checksum: 'target-checksum-1',
        }];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async function updateModelYamlFile(input: { fileName: string; previousChecksum?: string; yaml: string }) {
    updateCalls.push(input);
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => ({ identifier: 'imported-doc-1', documentId: 'imported-doc-1' }));

	  const created = await createMigrationJob({
	    sourceId: 'source-1',
	    targets: [{
	      id: 'target-1',
	      destinationInstanceId: 'dest-1',
	      targetConnectionId: 'target-connection-1',
	      targetModelId: 'target-model-1',
	      queryViewMappings: [{
	        sourceQueryViewName: 'northstar_metrics',
	        sourceFileName: 'northstar_metrics.query.view',
	        action: 'update_existing',
	        targetQueryViewName: 'northstar_metrics',
	        targetFileName: 'northstar_metrics.query.view',
	      }],
	    }],
	    documentIds: ['source-doc-1'],
	    emptyFirst: false,
	    replaceSameNamed: false,
	    postMigrationActions: [],
	  });

  const job = await waitForJob(created.id);
  const queryViewPrep = job.items.find((item) => item.kind === 'query_view_prepare');
  const details = queryViewPrep?.details as { updatedQueryViews?: string[]; createdQueryViews?: string[] } | undefined;

  assert.equal(job.status, 'succeeded');
  assert.equal(queryViewPrep?.status, 'succeeded');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].fileName, 'northstar_metrics.query.view');
  assert.equal(updateCalls[0].previousChecksum, 'target-checksum-1');
  assert.match(updateCalls[0].yaml, /Northstar Metrics/);
  assert.deepEqual(details?.updatedQueryViews, ['northstar_metrics->northstar_metrics']);
  assert.deepEqual(details?.createdQueryViews, []);

  const keptTarget = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'update_existing',
        targetQueryViewName: 'northstar_metrics',
        targetFileName: 'northstar_metrics.query.view',
      }],
      semanticPatches: [{
        id: 'query_view:northstar_metrics:northstar_metrics.query.view',
        artifactType: 'query_view',
        sourceName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        targetFileName: 'northstar_metrics.query.view',
        resolution: 'keep_target',
        status: 'warning',
        safetyCategory: 'manual_review',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });
  const keptTargetJob = await waitForJob(keptTarget.id);
  const keptTargetPrep = keptTargetJob.items.find((item) => item.kind === 'query_view_prepare');
  const keptTargetDetails = keptTargetPrep?.details as { mappedQueryViews?: string[]; updatedQueryViews?: string[] } | undefined;

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(keptTargetDetails?.updatedQueryViews, []);
  assert.deepEqual(keptTargetDetails?.mappedQueryViews, ['northstar_metrics->Northstar Metrics']);
  assert.match(keptTargetPrep?.warnings?.join(' ') || '', /kept unchanged by the accepted code decision/i);
});

test('dashboard migration refuses query-view updates that would remove target-only fields', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdExact: [],
      embedExternalIdContains: [],
    },
    postMigrationActions: [],
  });

  let yamlWriteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [{
          name: 'northstar_metrics',
          label: 'Northstar Metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\n  legacy_margin:\nquery:\n  base_view: orders\n',
	          checksum: 'target-checksum-1',
	        }];
	  });
	  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
	    yamlWriteCalls += 1;
	  });
	  mock.method(OmniClient.prototype, 'importDocument', async () => {
	    throw new Error('Import should have been skipped.');
	  });

	  const plan = await buildMigrationPlan({
	    sourceId: 'source-1',
	    targets: [{
	      id: 'target-1',
	      destinationInstanceId: 'dest-1',
	      targetConnectionId: 'target-connection-1',
	      targetModelId: 'target-model-1',
	      queryViewMappings: [{
	        sourceQueryViewName: 'northstar_metrics',
	        sourceFileName: 'northstar_metrics.query.view',
	        action: 'update_existing',
	        targetQueryViewName: 'northstar_metrics',
	        targetFileName: 'northstar_metrics.query.view',
	      }],
	    }],
	    documentIds: ['source-doc-1'],
	    emptyFirst: false,
	    replaceSameNamed: false,
	  });
	  const plannedQueryViewPrep = plan.steps.find((step) => step.kind === 'query_view_prepare');
	  const plannedImport = plan.steps.find((step) => step.kind === 'import');
	  const plannedPatches = plannedQueryViewPrep?.details?.semanticPatches as Array<{
	    artifactType?: string;
	    sourceName?: string;
	    status?: string;
	    safetyCategory?: string;
	    recommendedAction?: string;
	    warnings?: string[];
	  }> | undefined;
	  const plannedQueryViewPatch = plannedPatches?.find((patch) => (
	    patch.artifactType === 'query_view' && patch.sourceName === 'northstar_metrics'
	  ));

	  assert.equal(plannedQueryViewPrep?.blocked, true);
	  assert.match(plannedQueryViewPrep?.error || '', /Query view northstar_metrics needs resolution/);
	  assert.equal(plannedImport?.blocked, true);
	  assert.equal(plannedQueryViewPatch?.status, 'blocked');
	  assert.equal(plannedQueryViewPatch?.safetyCategory, 'blocked');
	  assert.match(plannedQueryViewPatch?.recommendedAction || '', /Review and merge/);
	  assert.match((plannedQueryViewPatch?.warnings || []).join(' '), /legacy_margin/);

		  await assert.rejects(() => createMigrationJob({
		    sourceId: 'source-1',
		    targets: [{
		      id: 'target-1',
		      destinationInstanceId: 'dest-1',
		      targetConnectionId: 'target-connection-1',
		      targetModelId: 'target-model-1',
		      queryViewMappings: [{
		        sourceQueryViewName: 'northstar_metrics',
		        sourceFileName: 'northstar_metrics.query.view',
		        action: 'update_existing',
		        targetQueryViewName: 'northstar_metrics',
		        targetFileName: 'northstar_metrics.query.view',
		      }],
		    }],
		    documentIds: ['source-doc-1'],
		    emptyFirst: false,
		    replaceSameNamed: false,
		    postMigrationActions: [],
		  }), /Query view northstar_metrics needs resolution/);
	  assert.equal(yamlWriteCalls, 0);
	});

test('dashboard migration refuses to overwrite query views discovered after preflight', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let destinationQueryViewCalls = 0;
  let yamlWriteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    if (clientLabel(this) === 'Source') {
      return [{
        name: 'northstar_metrics',
        fileName: 'northstar_metrics.query.view',
        yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
      }];
    }
    destinationQueryViewCalls += 1;
    return destinationQueryViewCalls >= 3
      ? [{ name: 'northstar_metrics', fileName: 'northstar_metrics.query.view' }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    yamlWriteCalls += 1;
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    throw new Error('Import should have been skipped.');
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'copy_source',
        targetQueryViewName: 'northstar_metrics',
        targetFileName: 'northstar_metrics.query.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const queryViewPrep = job.items.find((item) => item.kind === 'query_view_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');

  assert.equal(queryViewPrep?.status, 'failed');
  assert.match(queryViewPrep?.error || '', /already exists/);
  assert.equal(importItem?.status, 'skipped');
  assert.equal(yamlWriteCalls, 0);
});

test('dashboard migration de-dupes copied query views per destination model and target file', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let yamlWriteCalls = 0;
  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [
          {
            id: 'source-doc-1',
            identifier: 'source-doc-1',
            name: 'Query View Dashboard One',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model',
          },
          {
            id: 'source-doc-2',
            identifier: 'source-doc-2',
            name: 'Query View Dashboard Two',
            folderPath: 'Source Dashboards',
            baseModelId: 'source-model',
          },
        ]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    yamlWriteCalls += 1;
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => ({ identifier: `imported-doc-${yamlWriteCalls}`, documentId: `imported-doc-${yamlWriteCalls}` }));
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'copy_source',
        targetQueryViewName: 'northstar_metrics',
        targetFileName: 'northstar_metrics.query.view',
      }],
    }],
    documentIds: ['source-doc-1', 'source-doc-2'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const queryViewPrepItems = job.items.filter((item) => item.kind === 'query_view_prepare');
  const sourceDeleteItems = job.items.filter((item) => item.kind === 'source_delete');

  assert.equal(yamlWriteCalls, 1);
  assert.equal(queryViewPrepItems.length, 2);
  assert.equal(queryViewPrepItems.some((item) => item.status === 'warning'), true);
  assert.equal(queryViewPrepItems.some((item) => item.warnings?.some((warning) => warning.includes('already prepared'))), true);
  assert.equal(sourceDeleteCalls, 2);
  assert.equal(sourceDeleteItems.every((item) => item.status === 'succeeded'), true);
});

test('source delete is skipped when query-view preparation fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Query View Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? { 'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n' }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    throw new Error('Query-view write failed.');
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    throw new Error('Import should have been skipped.');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      queryViewMappings: [{
        sourceQueryViewName: 'northstar_metrics',
        sourceFileName: 'northstar_metrics.query.view',
        action: 'copy_source',
        targetQueryViewName: 'northstar_metrics',
        targetFileName: 'northstar_metrics.query.view',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const queryViewPrep = job.items.find((item) => item.kind === 'query_view_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(queryViewPrep?.status, 'failed');
  assert.equal(importItem?.status, 'skipped');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(sourceDeleteCalls, 0);
});

test('query-view preparation blockers prevent sibling update-in-place jobs from starting', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    defaultFolderPath: 'Target Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let draftCalls = 0;
  let refreshCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [{
          id: 'target-doc-1',
          identifier: 'target-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Target Dashboards',
          baseModelId: 'target-model-1',
        }, {
          id: 'target-doc-2',
          identifier: 'target-doc-2',
          name: 'NorthstarDashboard',
          folderPath: 'Target Dashboards Copy',
          baseModelId: 'target-model-1',
        }];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async function getModelYamlFiles() {
    return clientLabel(this) === 'Source'
      ? {
          'northstar_metrics.query.view': 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }
      : { 'orders.view': 'dimensions:\n  id:\n' };
  });
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['northstar_metrics.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelQueryViews', async function listModelQueryViews() {
    return clientLabel(this) === 'Source'
      ? [{
          name: 'northstar_metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\nquery:\n  base_view: orders\n',
        }]
      : [{
          name: 'northstar_metrics',
          label: 'Northstar Metrics',
          fileName: 'northstar_metrics.query.view',
          yaml: 'label: Northstar Metrics\ndimensions:\n  revenue:\n  legacy_margin:\nquery:\n  base_view: orders\n',
          checksum: 'target-checksum-1',
        }];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => ({
    name: 'NorthstarDashboard',
    queryPresentations: {
      data: {
        tile_1: { query: { modelId: 'source-model', fields: ['northstar_metrics.revenue'] } },
      },
    },
  }));
  mock.method(OmniClient.prototype, 'createDocumentDraft', async () => {
    draftCalls += 1;
    throw new Error('Dashboard update should have been skipped.');
  });
  mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { jobId: 'refresh-1', status: 'running' };
  });

	  const plan = await buildMigrationPlan({
	    sourceId: 'source-1',
	    sourceConnectionId: 'source-connection',
	    routeGroups: [{
	      id: 'route-northstar',
	      name: 'Northstar route',
      documentIds: ['source-doc-1'],
      targets: [{
        id: 'target-query-view-owner',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
        targetModelId: 'target-model-1',
        targetFolderPath: 'Target Dashboards',
        queryViewMappings: [{
          sourceQueryViewName: 'northstar_metrics',
          sourceFileName: 'northstar_metrics.query.view',
          action: 'update_existing',
          targetQueryViewName: 'northstar_metrics',
          targetFileName: 'northstar_metrics.query.view',
        }],
      }, {
        id: 'target-sibling-folder',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection-1',
        targetModelId: 'target-model-1',
        targetFolderPath: 'Target Dashboards Copy',
      }],
    }],
    targets: [],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
	    replaceSameNamed: true,
	    deleteSourceOnSuccess: false,
	  });
	  const plannedQueryViewPrep = plan.steps.find((item) => item.kind === 'query_view_prepare');
	  const plannedUpdates = plan.steps.filter((item) => item.kind === 'update');

	  assert.equal(plannedQueryViewPrep?.blocked, true);
	  assert.match(plannedQueryViewPrep?.error || '', /Query view northstar_metrics needs resolution/);
	  assert.equal(plannedUpdates.length, 2);
	  assert.equal(plannedUpdates.some((item) => item.blocked), true);

	  await assert.rejects(() => createMigrationJob({
	    sourceId: 'source-1',
	    sourceConnectionId: 'source-connection',
	    routeGroups: [{
	      id: 'route-northstar',
	      name: 'Northstar route',
	      documentIds: ['source-doc-1'],
	      targets: [{
	        id: 'target-query-view-owner',
	        destinationInstanceId: 'dest-1',
	        targetConnectionId: 'target-connection-1',
	        targetModelId: 'target-model-1',
	        targetFolderPath: 'Target Dashboards',
	        queryViewMappings: [{
	          sourceQueryViewName: 'northstar_metrics',
	          sourceFileName: 'northstar_metrics.query.view',
	          action: 'update_existing',
	          targetQueryViewName: 'northstar_metrics',
	          targetFileName: 'northstar_metrics.query.view',
	        }],
	      }, {
	        id: 'target-sibling-folder',
	        destinationInstanceId: 'dest-1',
	        targetConnectionId: 'target-connection-1',
	        targetModelId: 'target-model-1',
	        targetFolderPath: 'Target Dashboards Copy',
	      }],
	    }],
	    targets: [],
	    documentIds: ['source-doc-1'],
	    emptyFirst: false,
	    replaceSameNamed: true,
	    deleteSourceOnSuccess: false,
	    postMigrationActions: [{
	      kind: 'refresh-schema',
	      name: 'Destination: refresh schema target-model-1',
	      method: 'POST',
	      url: '',
      headers: {},
      body: '',
      destinationInstanceId: 'dest-1',
	      targetModelId: 'target-model-1',
	      targetModelName: 'Target Model',
	    }],
	  }), /Query view northstar_metrics needs resolution/);
	  assert.equal(draftCalls, 0);
	  assert.equal(refreshCalls, 0);
	});

test('dashboard migration copies source topic YAML before dashboard import', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  const calls: string[] = [];
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      topicName: 'source_topic',
    },
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'source_topic', label: 'Source Topic', fileName: 'source_topic.topic', yaml: 'label: Source Topic\nbase_view_name: orders\n' }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async function updateModelYamlFile(input: { fileName: string; yaml: string }) {
    calls.push(`write:${input.fileName}:${input.yaml.includes('Source Topic')}`);
  });
  mock.method(OmniClient.prototype, 'importDocument', async function importDocument() {
    calls.push('import');
    return { identifier: 'imported-doc-1', documentId: 'imported-doc-1' };
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'copy_source',
        targetTopicName: 'source_topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(calls, ['write:source_topic.topic:true', 'import']);
});

test('source delete is skipped when topic preparation fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'Topic Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['source_topic'],
          topicIds: ['source_topic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  id:\n',
  }));
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      topicName: 'source_topic',
    },
    tiles: [{ fields: ['orders.id'] }],
  }));
  mock.method(OmniClient.prototype, 'listModelTopics', async function listModelTopics() {
    return clientLabel(this) === 'Source'
      ? [{ name: 'source_topic', label: 'Source Topic', fileName: 'source_topic.topic', yaml: 'label: Source Topic\nbase_view_name: orders\n' }]
      : [];
  });
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async () => {
    throw new Error('Topic write failed.');
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    throw new Error('Import should have been skipped.');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'source_topic',
        sourceTopicId: 'source_topic',
        action: 'copy_source',
        targetTopicName: 'source_topic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const topicPrep = job.items.find((item) => item.kind === 'topic_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(topicPrep?.status, 'failed');
  assert.equal(importItem?.status, 'skipped');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(sourceDeleteCalls, 0);
});

test('source delete is skipped when relationship preparation fails', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const topicYaml = [
    'label: NorthstarTopic',
    'base_view_name: northstar__daily_grill_report',
    'views:',
    '  northstar__daily_grill_report: {}',
    '  northstar__menu_item_pnl: {}',
  ].join('\n');
  const relationshipsYaml = [
    '- join_from_view: northstar__daily_grill_report',
    '  join_to_view: northstar__menu_item_pnl',
    '  join_type: always_left',
    '  on_sql: ${northstar__daily_grill_report.store_number} IS NOT NULL AND',
    '    ${northstar__menu_item_pnl.plu_code} IS NOT NULL',
    '  relationship_type: many_to_many',
  ].join('\n');

  let sourceDeleteCalls = 0;
  let relationshipWriteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc-1',
          identifier: 'source-doc-1',
          name: 'NorthstarDashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
          topicNames: ['NorthstarTopic'],
          topicIds: ['NorthstarTopic'],
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'target-model-1',
    name: 'Target Model',
  }]);
  mock.method(OmniClient.prototype, 'getModelYaml', async function getModelYaml(modelId: string, options: { includeChecksums?: boolean } = {}) {
    const queryViewFiles = {
      'northstar/northstar__daily_grill_report.query.view': 'label: Daily Grill Report\nsql: select 1\n',
      'northstar/northstar__menu_item_pnl.query.view': 'label: Menu Item P&L\nsql: select 1\n',
    };
    if (clientLabel(this) === 'Source') {
      return {
        files: {
          'NorthstarTopic.topic': topicYaml,
          relationships: relationshipsYaml,
          ...queryViewFiles,
        },
        checksums: options.includeChecksums ? { relationships: 'source-relationships-checksum' } : undefined,
        raw: { modelId },
      };
    }
    return {
      files: {
        relationships: '[]\n',
        ...queryViewFiles,
      },
      checksums: options.includeChecksums ? { relationships: 'target-relationships-checksum' } : undefined,
      raw: { modelId },
    };
  });
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => [
    {
      name: 'northstar__daily_grill_report',
      fileName: 'northstar/northstar__daily_grill_report.query.view',
      yaml: 'label: Daily Grill Report\nsql: select 1\n',
    },
    {
      name: 'northstar__menu_item_pnl',
      fileName: 'northstar/northstar__menu_item_pnl.query.view',
      yaml: 'label: Menu Item P&L\nsql: select 1\n',
    },
  ]);
  mock.method(OmniClient.prototype, 'listModelTopics', async () => [{
    name: 'NorthstarTopic',
    label: 'NorthstarTopic',
    fileName: 'NorthstarTopic.topic',
    yaml: topicYaml,
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: { topicName: 'NorthstarTopic' },
    tiles: [{ fields: ['northstar__menu_item_pnl.estimated_margin_pct'] }],
  }));
  mock.method(OmniClient.prototype, 'updateModelYamlFile', async function updateModelYamlFile(input: { fileName: string }) {
    if (input.fileName === 'relationships') relationshipWriteCalls += 1;
    throw new Error('Relationship write failed.');
  });
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    throw new Error('Import should have been skipped.');
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection-1',
      targetModelId: 'target-model-1',
      topicMappings: [{
        sourceTopicName: 'NorthstarTopic',
        sourceTopicId: 'NorthstarTopic',
        action: 'map_existing',
        targetTopicName: 'NorthstarTopic',
        targetTopicLabel: 'NorthstarTopic',
      }],
    }],
    documentIds: ['source-doc-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const relationshipPrep = job.items.find((item) => item.kind === 'relationship_prepare');
  const topicPrep = job.items.find((item) => item.kind === 'topic_prepare');
  const importItem = job.items.find((item) => item.kind === 'import');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(relationshipWriteCalls, 1);
  assert.equal(relationshipPrep?.status, 'failed');
  assert.equal(topicPrep?.status, 'skipped');
  assert.equal(importItem?.status, 'skipped');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(sourceDeleteCalls, 0);
  assert.equal(JSON.stringify(job).includes('on_sql'), false);
});

test('saved-instance document listing enriches missing dashboard model details on request', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Coffee Shop Demo',
    folderPath: 'Source Dashboards',
    baseModelId: 'Unknown',
    baseModelName: 'Unknown',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-1',
    name: 'Coffee Model',
    identifier: 'coffee-model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    dashboard: {
      sharedModelId: 'model-1',
    },
  }));
  documentQueriesMock = async () => [];
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string }> };

  assert.equal(body.documents[0].baseModelId, 'model-1');
  assert.equal(body.documents[0].baseModelName, 'Coffee Model');
});

test('saved-instance document listing extracts model details from nested document model payloads', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Nested Model Dashboard',
    folderPath: 'Source Dashboards',
    baseModelId: 'Unknown',
    baseModelName: 'Unknown',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-2',
    name: 'Nested Model',
    identifier: 'nested-model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    document: {
      model: {
        id: 'model-2',
        name: 'Nested Model',
      },
    },
  }));
  documentQueriesMock = async () => [];
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string }> };

  assert.equal(body.documents[0].baseModelId, 'model-2');
  assert.equal(body.documents[0].baseModelName, 'Nested Model');
});

test('saved-instance document listing extracts workbook model and topic metadata from export payloads', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Topic Dashboard',
    folderPath: 'Source Dashboards',
    baseModelId: 'Unknown',
    baseModelName: 'Unknown',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-3',
    name: 'Workbook Model',
    identifier: 'workbook-model',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    workbookModel: {
      id: 'model-3',
      name: 'Workbook Model',
    },
    dashboard: {
      topicNames: [{ id: 'topic-1', name: 'nfl_mvp' }],
    },
    queries: [{
      query: {
        topicName: 'nfl_mvp',
        topicId: 'topic-1',
      },
    }],
  }));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string; topicNames?: string[]; topicIds?: string[] }> };

  assert.equal(body.documents[0].baseModelId, 'model-3');
  assert.equal(body.documents[0].baseModelName, 'Workbook Model');
  assert.deepEqual(body.documents[0].topicNames, ['nfl_mvp']);
  assert.deepEqual(body.documents[0].topicIds, ['topic-1']);
});

test('saved-instance document listing applies selected connection model fallback when export omits model metadata', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [
    {
      id: 'coffee-shop-demo',
      identifier: 'coffee-shop-demo',
      name: 'Coffee Shop Demo',
      connectionId: 'coffee-connection',
      folderPath: 'omni-training',
      description: 'Demo dashboard',
      labels: [],
    },
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      connectionId: 'nfl-connection',
      folderPath: 'just-for-fun',
      description: 'Demo dashboard',
      labels: [],
    },
  ]);
  mock.method(OmniClient.prototype, 'listModels', async () => [
    {
      id: 'model-nfl',
      name: 'ATX - NFL Big Data Bowl Demo',
      identifier: 'nfl-big-data-bowl',
      connectionId: 'nfl-connection',
    },
  ]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({}));
  documentQueriesMock = async () => [];
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?folderPath=just-for-fun&connectionId=nfl-connection&includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ id: string; baseModelId?: string; baseModelName?: string }> };

  assert.deepEqual(body.documents.map((document) => document.id), ['nfl-superstar-team-motion-lab-v34']);
  assert.equal(body.documents[0].baseModelId, 'model-nfl');
  assert.equal(body.documents[0].baseModelName, 'ATX - NFL Big Data Bowl Demo');
});

test('saved-instance document listing can load all folders scoped by selected connection', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Default Only',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  let requestedOptions: unknown;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async (options?: unknown) => {
    requestedOptions = options;
    return [
      {
        id: 'default-doc',
        identifier: 'default-doc',
        name: 'Default Dashboard',
        connectionId: 'nfl-connection',
        folderPath: 'Default Only',
        description: 'Default dashboard',
        labels: [],
      },
      {
        id: 'team-doc',
        identifier: 'team-doc',
        name: 'Team Dashboard',
        connectionId: 'nfl-connection',
        folderPath: 'Shared/Team Dashboards',
        description: 'Team dashboard',
        labels: [],
      },
      {
        id: 'coffee-doc',
        identifier: 'coffee-doc',
        name: 'Coffee Dashboard',
        connectionId: 'coffee-connection',
        folderPath: 'Default Only',
        description: 'Other connection dashboard',
        labels: [],
      },
    ];
  });

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=nfl-connection'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ id: string; folderPath?: string }> };

  assert.deepEqual(requestedOptions, { folderId: undefined, includeLabels: true, connectionId: 'nfl-connection' });
  assert.deepEqual(body.documents.map((document) => document.id), ['default-doc', 'team-doc']);
  assert.deepEqual(body.documents.map((document) => document.folderPath), ['Default Only', 'Shared/Team Dashboards']);
});

test('saved-instance document listing extracts topic metadata from document queries when export is sparse', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Topic Dashboard',
    connectionId: 'connection-1',
    folderPath: 'Source Dashboards',
    description: 'Demo dashboard',
    labels: [],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-1',
    name: 'Topic Model',
    identifier: 'topic-model',
    connectionId: 'connection-1',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({}));
  documentQueriesMock = async () => [{
    id: 'query-1',
    name: 'Query 1',
    query: {
      topicName: 'nfl_mvp',
    },
  }];
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?connectionId=connection-1&includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ baseModelId?: string; baseModelName?: string; topicNames?: string[]; topicIds?: string[] }> };

  assert.equal(body.documents[0].baseModelId, 'model-1');
  assert.equal(body.documents[0].baseModelName, 'Topic Model');
  assert.deepEqual(body.documents[0].topicNames, ['nfl_mvp']);
  assert.deepEqual(body.documents[0].topicIds, ['nfl_mvp']);
});

test('saved-instance document listing ignores join-path topic names as dashboard topics', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });

  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{
    id: 'dash-1',
    identifier: 'dash-1',
    name: 'Northstar Dashboard',
    connectionId: 'connection-1',
    folderPath: 'Source Dashboards',
    description: 'Demo dashboard',
    labels: [],
    topicNames: ['Subway', 'NorthstarTopic'],
    topicIds: ['Subway'],
  }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{
    id: 'model-1',
    name: 'Food Service Model',
    identifier: 'food-service-model',
    connectionId: 'connection-1',
  }]);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    workbookModel: {
      id: 'model-1',
      name: 'Food Service Model',
      topics: [{ name: 'Subway', label: 'Subway' }],
    },
    queries: [{
      query: {
        topicName: 'NorthstarTopic',
        topicId: 'NorthstarTopic',
        join_paths_from_topic_name: 'Subway',
      },
    }],
  }));
  documentQueriesMock = async () => [];
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({}));

  const response = await instancesHandler(new Request('http://localhost/api/instances/source-1/documents?connectionId=connection-1&includeModelDetails=true'));
  assert.equal(response.status, 200);
  const body = await response.json() as { documents: Array<{ topicNames?: string[]; topicIds?: string[] }> };

  assert.deepEqual(body.documents[0].topicNames, ['NorthstarTopic']);
  assert.deepEqual(body.documents[0].topicIds, ['NorthstarTopic']);
});

test('functional query validation blocks update-in-place before any draft is created or published', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let draftCreateCalls = 0;
  let publishCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [{
          id: 'target-doc',
          identifier: 'target-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Target Dashboards',
          baseModelId: 'target-model',
        }];
  });
  mock.method(OmniClient.prototype, 'getDocumentStateV2', async function getDocumentStateV2(documentId: string) {
    return documentId === 'source-doc'
      ? { name: 'Northstar Dashboard', queryPresentations: { data: { tile_1: { query: { modelId: 'source-model', fields: ['orders.revenue'] } } } } }
      : { name: 'Northstar Dashboard', queryPresentations: { data: {} } };
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  revenue:\n',
  }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'createDocumentDraft', async () => {
    draftCreateCalls += 1;
    return { identifier: 'target-doc', draftIdentifier: 'draft-1', raw: {} };
  });
  mock.method(OmniClient.prototype, 'publishDocumentDraft', async () => {
    publishCalls += 1;
  });
  documentQueriesMock = async () => [{
    id: 'tile-1',
    name: 'Revenue',
    query: { modelId: 'source-model', table: 'orders', fields: ['orders.revenue'] },
  }];
  queryExecutionMock = async () => {
    throw new Error('Target query rejected orders.revenue.');
  };

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      targetFolderPath: 'Target Dashboards',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const validation = job.items.find((item) => item.kind === 'query_validate');
  const update = job.items.find((item) => item.kind === 'update');
  const details = validation?.details?.functionalValidation as { failedCount?: number; results?: Array<Record<string, unknown>> } | undefined;

  assert.equal(validation?.status, 'failed');
  assert.equal(details?.failedCount, 1);
  assert.equal(details?.results?.[0]?.status, 'failed');
  assert.equal(update?.status, 'skipped');
  assert.match(update?.error || '', /publication skipped/i);
  assert.equal(draftCreateCalls, 0);
  assert.equal(publishCalls, 0);
  assert.equal(JSON.stringify(validation?.details).includes('"query":'), false);
  assert.equal(JSON.stringify(validation?.details).includes('"result":'), false);
});

test('functional query validation accepts zero-row results and marks non-query records not applicable', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let queryRunCalls = 0;
  let importCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  revenue:\n',
  }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importCalls += 1;
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });
  documentQueriesMock = async () => [
    {
      id: 'tile-1',
      name: 'No matching rows',
      query: { modelId: 'source-model', table: 'orders', fields: ['orders.revenue'] },
    },
    {
      id: 'markdown-1',
      name: 'Commentary',
      query: {},
    },
  ];
  queryExecutionMock = async () => {
    queryRunCalls += 1;
    return { status: 'COMPLETE', rowCount: 0, jobId: 'query-job-1' };
  };

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const validation = job.items.find((item) => item.kind === 'query_validate');
  const details = validation?.details?.functionalValidation as {
    passedCount?: number;
    failedCount?: number;
    notApplicableCount?: number;
    zeroRowCount?: number;
  } | undefined;

  assert.equal(job.status, 'succeeded');
  assert.equal(validation?.status, 'succeeded');
  assert.equal(details?.passedCount, 1);
  assert.equal(details?.failedCount, 0);
  assert.equal(details?.notApplicableCount, 1);
  assert.equal(details?.zeroRowCount, 1);
  assert.deepEqual(validation?.details?.queryRequirements, [
    { queryId: 'tile-1', name: 'No matching rows', kind: 'query' },
    { queryId: 'markdown-1', name: 'Commentary', kind: 'non_query' },
  ]);
  assert.equal(JSON.stringify(validation?.details?.queryRequirements).includes('modelId'), false);
  assert.equal(queryRunCalls, 2);
  assert.equal(importCalls, 1);
});

test('dashboard migration removes source-only model extension ids from query proof and imported payloads', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  const executedQueries: Array<Record<string, unknown>> = [];
  let importedPayload: unknown;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  revenue:\n',
  }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{
      query: {
        modelId: 'source-query-model',
        model_extension_id: 'source-extension',
        fields: ['orders.revenue'],
      },
    }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async (input: { exportPayload: unknown }) => {
    importedPayload = input.exportPayload;
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });
  documentQueriesMock = async (documentId) => [{
    id: 'tile-1',
    name: 'Revenue',
    query: documentId === 'source-doc'
      ? {
          modelId: 'source-query-model',
          model_extension_id: 'source-extension',
          nested: { model_id: 'another-source-model' },
          fields: ['orders.revenue'],
        }
      : {
          modelId: 'target-model',
          nested: { model_id: 'target-model' },
          fields: ['orders.revenue'],
        },
  }];
  queryExecutionMock = async (query) => {
    executedQueries.push(query);
    return { status: 'COMPLETE', rowCount: 1 };
  };

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const validation = job.items.find((item) => item.kind === 'query_validate');
  const imported = job.items.find((item) => item.kind === 'import');
  const executedJson = JSON.stringify(executedQueries);
  const importedJson = JSON.stringify(importedPayload);

  assert.equal(job.status, 'succeeded');
  assert.equal(validation?.status, 'succeeded');
  assert.equal(imported?.status, 'succeeded');
  assert.equal(executedQueries[0]?.modelId, 'target-model');
  assert.equal((executedQueries[0]?.nested as Record<string, unknown> | undefined)?.model_id, 'target-model');
  assert.equal(executedJson.includes('model_extension_id'), false);
  assert.equal(executedJson.includes('source-extension'), false);
  assert.equal(importedJson.includes('model_extension_id'), false);
  assert.equal(importedJson.includes('source-extension'), false);
  assert.equal(importedJson.includes('source-model'), false);
  assert.equal(importedJson.includes('target-model'), true);
  assert.equal(Number(imported?.details?.modelExtensionRemovalCount) > 0, true);
});

test('an exact reasoned query waiver permits publication but never source deletion', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let importCalls = 0;
  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  revenue:\n',
  }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importCalls += 1;
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });
  documentQueriesMock = async () => [{
    id: 'tile-1',
    name: 'Delayed revenue tile',
    query: { modelId: 'source-model', table: 'orders', fields: ['orders.revenue'] },
  }];
  queryExecutionMock = async () => {
    throw new Error('The downstream table is intentionally delayed.');
  };

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      queryValidationWaivers: [{
        documentId: 'source-doc',
        queryId: 'tile-1',
        reason: 'The downstream load is approved to arrive after this dashboard migration.',
        acknowledgedAt: '2026-07-20T12:00:00.000Z',
      }],
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const prePublish = job.items.find((item) => item.kind === 'query_validate');
  const finalVerification = job.items.find((item) => item.kind === 'document_verify');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');
  const prePublishValidation = prePublish?.details?.functionalValidation as { waivedCount?: number; results?: Array<Record<string, unknown>> } | undefined;

  assert.equal(job.status, 'partial');
  assert.equal(prePublish?.status, 'warning');
  assert.equal(prePublishValidation?.waivedCount, 1);
  assert.equal(prePublishValidation?.results?.[0]?.status, 'waived');
  assert.equal(finalVerification?.status, 'warning');
  assert.equal(importCalls, 1);
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(sourceDeleteCalls, 0);
  assert.equal(JSON.stringify(prePublish?.details).includes('source-key'), false);
});

test('a short or mismatched query waiver cannot bypass the publish gate', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  let importCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({ 'orders.view': 'dimensions:\n  revenue:\n' }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({ sharedModelId: 'source-model', tiles: [{ fields: ['orders.revenue'] }] }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importCalls += 1;
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });
  documentQueriesMock = async () => [{
    id: 'tile-1',
    name: 'Revenue',
    query: { modelId: 'source-model', table: 'orders', fields: ['orders.revenue'] },
  }];
  queryExecutionMock = async () => {
    throw new Error('Query failed.');
  };

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      queryValidationWaivers: [
        { documentId: 'source-doc', queryId: 'tile-1', reason: 'short' },
        { documentId: 'source-doc', queryId: 'different-tile', reason: 'This waiver is scoped to a different query and must not apply.' },
      ],
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: false,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  assert.equal(job.items.find((item) => item.kind === 'query_validate')?.status, 'failed');
  assert.equal(importCalls, 0);
});

test('semantic validation failure suppresses query execution, import, post-actions, and source deletion', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let queryRunCalls = 0;
  let importCalls = 0;
  let refreshCalls = 0;
  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  revenue:\n',
  }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => {
    importCalls += 1;
    return { identifier: 'imported-doc', documentId: 'imported-doc' };
  });
  mock.method(OmniClient.prototype, 'refreshModel', async () => {
    refreshCalls += 1;
    return { jobId: 'refresh-1', status: 'running' };
  });
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });
  documentQueriesMock = async () => [{
    id: 'tile-1',
    name: 'Revenue',
    query: { modelId: 'source-model', table: 'orders', fields: ['orders.revenue'] },
  }];
  queryExecutionMock = async () => {
    queryRunCalls += 1;
    return { status: 'COMPLETE', rowCount: 1 };
  };
  modelValidationMock = async () => [{
    message: 'Target semantic model is invalid.',
    yaml_path: 'orders.view.dimensions.revenue',
  }];

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [{
      kind: 'refresh-schema',
      name: 'Refresh target model',
      method: 'POST',
      url: '',
      headers: {},
      body: '',
      destinationInstanceId: 'dest-1',
      targetModelId: 'target-model',
      targetModelName: 'Target model',
    }],
  });

  const job = await waitForJob(created.id);
  const semanticValidation = job.items.find((item) => item.kind === 'semantic_validate');
  const queryValidation = job.items.find((item) => item.kind === 'query_validate');
  const postAction = job.items.find((item) => item.kind === 'post_action');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(semanticValidation?.status, 'failed');
  assert.equal(queryValidation?.status, 'skipped');
  assert.equal(postAction?.status, 'skipped');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(queryRunCalls, 0);
  assert.equal(importCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(sourceDeleteCalls, 0);
});

test('failed final document verification prevents destructive source cleanup', async () => {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey: 'source-key',
    defaultFolderPath: 'Source Dashboards',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });
  upsertInstance({
    id: 'dest-1',
    label: 'Destination',
    role: 'destination',
    baseUrl: 'https://dest.example.omniapp.co',
    apiKey: 'dest-key',
    metricFilter: emptyMetricFilter(),
    postMigrationActions: [],
  });

  let queryRunCalls = 0;
  let sourceDeleteCalls = 0;
  mock.method(OmniClient.prototype, 'listFolderDocuments', async function listFolderDocuments() {
    return clientLabel(this) === 'Source'
      ? [{
          id: 'source-doc',
          identifier: 'source-doc',
          name: 'Northstar Dashboard',
          folderPath: 'Source Dashboards',
          baseModelId: 'source-model',
        }]
      : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => ({
    'orders.view': 'dimensions:\n  revenue:\n',
  }));
  mock.method(OmniClient.prototype, 'listLabels', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({
    sharedModelId: 'source-model',
    tiles: [{ fields: ['orders.revenue'] }],
  }));
  mock.method(OmniClient.prototype, 'importDocument', async () => ({ identifier: 'imported-doc', documentId: 'imported-doc' }));
  mock.method(OmniClient.prototype, 'requestDeleteDocument', async function requestDeleteDocument() {
    if (clientLabel(this) === 'Source') sourceDeleteCalls += 1;
  });
  documentQueriesMock = async () => [{
    id: 'tile-1',
    name: 'Revenue',
    query: { modelId: 'source-model', table: 'orders', fields: ['orders.revenue'] },
  }];
  queryExecutionMock = async () => {
    queryRunCalls += 1;
    if (queryRunCalls === 2) throw new Error('Published query could not execute.');
    return { status: 'COMPLETE', rowCount: 1 };
  };

  const created = await createMigrationJob({
    sourceId: 'source-1',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['source-doc'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: true,
    postMigrationActions: [],
  });

  const job = await waitForJob(created.id);
  const finalVerification = job.items.find((item) => item.kind === 'document_verify');
  const sourceDelete = job.items.find((item) => item.kind === 'source_delete');

  assert.equal(finalVerification?.status, 'failed');
  assert.equal(sourceDelete?.status, 'skipped');
  assert.equal(sourceDeleteCalls, 0);
});
