import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { buildMigrationPlan } from '../server/services/migrationJobs';
import { OmniClient, resetOmniClientRateLimitStateForTests } from '../server/services/omniClient';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { clearReadThroughCache } from '../server/services/readThroughCache';

let directory = '';
let networkCalls = 0;
const sharedFiles = { 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.id\n', 'nested/example_topic.topic': 'label: ExampleTopicLabel\nbase_view: orders\n' };
const clientLabel = (client: OmniClient) => (client as unknown as { instance: { label: string } }).instance.label;
const target = { id: 'example-route', destinationInstanceId: 'example-target', targetModelId: 'example-target-model' };
const input = { sourceId: 'example-source', targets: [target], documentIds: ['example-document'], emptyFirst: false,
  replaceSameNamed: false, documentAccessPolicy: 'destination_defaults' as const, prepareDependencyPatchCandidates: true };

beforeEach(() => {
  resetOmniClientRateLimitStateForTests();
  clearReadThroughCache();
  directory = mkdtempSync(path.join(tmpdir(), 'omnikit-source-evidence-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(directory, 'vault.enc');
  process.env.OMNIKIT_JOBS_PATH = path.join(directory, 'jobs.json');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(directory, 'history.json');
  unlockVault('example-source-evidence-test-passphrase');
  for (const [id, label, role] of [['example-source', 'Source', 'source'], ['example-target', 'Target', 'destination']] as const) {
    upsertInstance({ id, label, role, baseUrl: 'https://93.184.216.34', apiKey: `${id}-test-key`,
      metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] },
      postMigrationActions: [] });
  }
  networkCalls = 0;
  mock.method(globalThis, 'fetch', async () => { networkCalls += 1; throw new Error('External requests are forbidden in this isolated test'); });
  mock.method(OmniClient.prototype, 'listFolderDocuments', async () => [{ id: 'example-document', identifier: 'example-document', name: 'Example dashboard', baseModelId: 'example-shared-model' }]);
  mock.method(OmniClient.prototype, 'listModels', async () => [{ id: 'example-target-model', name: 'Example target model' }]);
  mock.method(OmniClient.prototype, 'getDocumentQueries', async () => []);
  mock.method(OmniClient.prototype, 'listModelQueryViews', async () => []);
  mock.method(OmniClient.prototype, 'listModelTopics', async function () {
    return clientLabel(this) === 'Source' ? [{ name: 'example_topic', label: 'ExampleTopicLabel', fileName: 'nested/example_topic.topic', yaml: 'label: ExampleTopicLabel\nbase_view: orders\n' }] : [];
  });
  mock.method(OmniClient.prototype, 'getModelYamlFiles', async () => sharedFiles);
  mock.method(OmniClient.prototype, 'getModelYaml', async (modelId: string) => ({ files: modelId === 'example-workbook-model' ? {} : sharedFiles, raw: {} }));
  mock.method(OmniClient.prototype, 'listDocumentAccess', async () => []);
  mock.method(OmniClient.prototype, 'listUserAttributes', async () => []);
  mock.method(OmniClient.prototype, 'listUserGroups', async () => []);
  mock.method(OmniClient.prototype, 'listIdentityUsers', async () => []);
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({ query: { fields: ['orders.id'], topic: { name: 'example_topic' } } }));
});

afterEach(() => {
  resetOmniClientRateLimitStateForTests();
  clearReadThroughCache();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
});

test('source topic filenames are enriched before an unmapped destination topic exits planning', async () => {
  const stateRead = mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => { throw new Error('Trusted state should be reused'); });
  const plan = await buildMigrationPlan(input, { sourceDocumentStates: new Map([
    ['example-document', { modelId: 'example-shared-model', workbookModelId: 'example-workbook-model', queryPresentations: { data: {}, order: [] } }],
  ]) });
  const topicStep = plan.steps.find((step) => step.kind === 'topic_prepare')!;
  const topics = topicStep.details?.sourceTopics as Array<{ name: string; fileName?: string }>;
  assert.ok(topicStep.blocked, 'the topic still needs a destination decision');
  assert.deepEqual(topics, [{ name: 'example_topic', id: 'example_topic', fileName: 'nested/example_topic.topic' }]);
  assert.equal(stateRead.mock.callCount(), 0);
  assert.equal(networkCalls, 0);
});

test('source workbook-local fields and overrides block shared proposals even when a shared target field exists', async () => {
  mock.method(OmniClient.prototype, 'getModelYaml', async (modelId: string, options: { fullyResolved?: boolean; mode?: string } = {}) => {
    if (modelId === 'example-workbook-model') {
      assert.equal(options.mode, 'extension');
      assert.equal(options.fullyResolved, false);
      return { files: { 'orders.view': 'dimensions:\n  id:\n    sql: ${TABLE}.different_id\n  local_label:\n    sql: ${id}\n' }, raw: {} };
    }
    return { files: sharedFiles, raw: {} };
  });
  const plan = await buildMigrationPlan(input, { sourceDocumentStates: new Map([
    ['example-document', { modelId: 'example-shared-model', workbookModelId: 'example-workbook-model', query: { fields: ['orders.id', 'orders.local_label'] } }],
  ]) });
  const dependencies = plan.steps.flatMap((step) => step.details?.fieldDependencies as Array<Record<string, unknown>> || []);
  for (const reference of ['orders.id', 'orders.local_label']) {
    const dependency = dependencies.find((field) => field.sourceFieldRef === reference)!;
    assert.ok(dependency, reference);
    assert.equal(dependency.status, 'blocked');
    assert.equal(dependency.sourceYaml, undefined);
    assert.match(String(dependency.reason), /workbook-local/);
    assert.equal(dependency.sourceDocumentId, 'example-document');
    assert.ok(['workbook_local', 'workbook_override'].includes(String(dependency.sourceProvenance)));
  }
  const patches = plan.steps.flatMap((step) => step.details?.semanticPatches as Array<Record<string, unknown>> || []);
  assert.ok(!patches.some((patch) => ['orders.id', 'orders.local_label'].includes(String(patch.sourceName))));
  assert.equal(networkCalls, 0);
});

test('trusted selected documents and authored snapshots avoid inventory and equivalent catalog reads', async () => {
  const inventory = mock.method(OmniClient.prototype, 'listFolderDocuments', async () => { throw new Error('No whole-source inventory permitted'); });
  const sourceState = mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => { throw new Error('No repeated published state read permitted'); });
  const topicCatalog = mock.method(OmniClient.prototype, 'listModelTopics', async () => { throw new Error('Use the authored YAML snapshot'); });
  const queryCatalog = mock.method(OmniClient.prototype, 'listModelQueryViews', async () => { throw new Error('Use the authored YAML snapshot'); });
  const sourceReads: string[] = [];
  let destinationReads = 0;
  const plan = await buildMigrationPlan(input, {
    sourceDocuments: new Map([['example-document', { id: 'example-document', identifier: 'example-document', name: 'Example dashboard', baseModelId: 'example-shared-model' }]]),
    sourceDocumentStates: new Map([['example-document', { modelId: 'example-shared-model', workbookModelId: 'example-workbook-model' }]]),
    loadSourceYaml: async (modelId, options) => {
      sourceReads.push(`${modelId}:${options.mode || 'authored'}`);
      return modelId === 'example-workbook-model' ? {} : sharedFiles;
    },
    loadDestinationYaml: async (instanceId, modelId) => {
      destinationReads += 1;
      assert.equal(instanceId, 'example-target');
      assert.equal(modelId, 'example-target-model');
      return { files: sharedFiles, checksums: { 'nested/example_topic.topic': 'example-checksum' }, raw: {} };
    },
  });
  assert.deepEqual(sourceReads.sort(), ['example-shared-model:authored', 'example-workbook-model:extension']);
  assert.equal(destinationReads, 1);
  assert.equal(inventory.mock.callCount(), 0);
  assert.equal(sourceState.mock.callCount(), 0);
  assert.equal(topicCatalog.mock.callCount(), 0);
  assert.equal(queryCatalog.mock.callCount(), 0);
  assert.ok(plan.steps.length);
  assert.equal(networkCalls, 0);
});

test('label-only source topic matches do not authorize authored filename or proposals', async () => {
  mock.method(OmniClient.prototype, 'exportDocument', async () => ({ query: { fields: ['orders.id'], topic: { name: 'ExampleTopicLabel' } } }));
  const plan = await buildMigrationPlan(input, { sourceDocumentStates: new Map([
    ['example-document', { modelId: 'example-shared-model', workbookModelId: 'example-workbook-model' }],
  ]) });
  const topicStep = plan.steps.find((step) => step.kind === 'topic_prepare')!;
  assert.equal((topicStep.details?.sourceTopics as Array<{ fileName?: string }>)[0].fileName, undefined);
  assert.equal(topicStep.blocked, true);
  assert.equal(networkCalls, 0);
});

test('planner cancellation is not converted into a completed readiness plan', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Example operation cancelled'));
  await assert.rejects(buildMigrationPlan(input, { signal: controller.signal }), /Example operation cancelled/);
  assert.equal(networkCalls, 0);
});
