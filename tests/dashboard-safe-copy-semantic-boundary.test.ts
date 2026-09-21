import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';

import {
  executeDashboardSafeCopy,
} from '../server/services/dashboardSafeCopyExecutor';
import { dashboardSafeCopyIntentHash } from '../server/services/dashboardSafeCopyJobs';
import type { DashboardSafeCopyPreparedTarget } from '../server/services/dashboardSafeCopyPreparation';
import {
  createDashboardSafeCopyRuntimeAdapterForTests,
  type DashboardSafeCopyRuntimeServices,
} from '../server/services/dashboardSafeCopyRuntime';
import type {
  MigrationJob,
  MigrationPlan,
  MigrationSemanticPatch,
  MigrationTarget,
} from '../server/services/migrationJobs';
import { clearMigrationDestinationModelReservations } from '../server/services/migrationScopeReservation';
import type { SavedInstance } from '../server/services/nativeVault';
import {
  DASHBOARD_SAFE_COPY_PROFILE,
  type DashboardSafeCopyIntent,
} from '../shared/dashboardSafeCopyContract';

const SOURCE_INSTANCE_ID = 'semantic-source-instance';
const DESTINATION_INSTANCE_ID = 'semantic-destination-instance';
const SOURCE_CONNECTION_ID = 'semantic-source-connection';
const DESTINATION_CONNECTION_ID = 'semantic-destination-connection';
const SOURCE_MODEL_ID = 'semantic-source-model';
const SOURCE_WORKBOOK_MODEL_ID = 'semantic-source-workbook-model';
const DESTINATION_MODEL_ID = 'semantic-destination-model';
const SOURCE_DOCUMENT_ID = 'fictional-operations-dashboard';
const TARGET_ID = 'semantic-target';
const BASE_TIME = Date.UTC(2026, 7, 16, 12, 0, 0);

afterEach(() => {
  clearMigrationDestinationModelReservations();
});

type SemanticMode = 'none' | 'one' | 'new-file' | 'multi-file' | 'drift';
type AccessMode = 'owner-only' | 'non-owner-direct' | 'incomplete';

interface SemanticWriteInput {
  modelId: string;
  fileName: string;
  yaml: string;
  previousChecksum?: string;
  commitMessage: string;
}

function instance(id: string, role: SavedInstance['role']): SavedInstance {
  return {
    id,
    label: id === SOURCE_INSTANCE_ID ? 'Semantic source' : 'Semantic destination',
    baseUrl: `https://${id}.example.test`,
    apiKey: `${id}-credential`,
    role,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  };
}

function intent(requestId: string): DashboardSafeCopyIntent {
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId,
    source: {
      instanceId: SOURCE_INSTANCE_ID,
      connectionId: SOURCE_CONNECTION_ID,
      documentIds: [SOURCE_DOCUMENT_ID],
    },
    destinations: [{
      targetId: TARGET_ID,
      instanceId: DESTINATION_INSTANCE_ID,
      connectionId: DESTINATION_CONNECTION_ID,
      modelId: DESTINATION_MODEL_ID,
    }],
  };
}

function target(): MigrationTarget {
  return {
    id: TARGET_ID,
    destinationInstanceId: DESTINATION_INSTANCE_ID,
    destinationLabel: 'Semantic destination',
    targetConnectionId: DESTINATION_CONNECTION_ID,
    targetModelId: DESTINATION_MODEL_ID,
  };
}

function planFor(safeIntent: DashboardSafeCopyIntent, selected: MigrationTarget): MigrationPlan {
  return {
    sourceId: safeIntent.source.instanceId,
    sourceLabel: 'Semantic source',
    sourceConnectionId: safeIntent.source.connectionId,
    destinationIds: [selected.destinationInstanceId],
    targets: [selected],
    documentIds: [...safeIntent.source.documentIds],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    sourceAllFolders: true,
    steps: [],
  };
}

function updatePatch(patch: Partial<MigrationSemanticPatch> = {}): MigrationSemanticPatch {
  return {
    id: 'field:fictional_orders.net_sales',
    artifactType: 'field',
    sourceName: 'fictional_orders.net_sales',
    sourceFileName: 'fictional_orders.view',
    targetFileName: 'fictional_orders.view',
    targetModelId: DESTINATION_MODEL_ID,
    acceptedYaml: [
      'dimensions:',
      '  order_id:',
      '    sql: ${TABLE}.order_id',
      '  net_sales:',
      '    sql: ${TABLE}.net_sales',
    ].join('\n'),
    previousChecksum: 'checksum-before',
    resolution: 'recommended',
    status: 'ready',
    safetyCategory: 'safe_update',
    ...patch,
  };
}

function patchesFor(mode: SemanticMode, prepareCall: number, semanticApplied: boolean): MigrationSemanticPatch[] {
  if (mode === 'none') return [];
  if (mode === 'one') return semanticApplied ? [] : [updatePatch()];
  if (mode === 'new-file') {
    return [updatePatch({
      id: 'topic:fictional_orders_new',
      artifactType: 'topic',
      targetFileName: 'fictional_orders_new.topic',
      acceptedYaml: 'label: Fictional orders\nviews:\n  fictional_orders: {}',
      previousChecksum: undefined,
      safetyCategory: 'safe_create',
    })];
  }
  if (mode === 'multi-file') {
    return [
      updatePatch(),
      updatePatch({
        id: 'query_view:fictional_orders_daily',
        artifactType: 'query_view',
        sourceName: 'fictional_orders_daily',
        targetFileName: 'fictional_orders_daily.query.view',
        acceptedYaml: 'base_view: fictional_orders\nfields:\n  [fictional_orders.order_id]',
        previousChecksum: 'second-checksum-before',
      }),
    ];
  }
  return prepareCall === 1
    ? [updatePatch()]
    : [updatePatch({
        previousChecksum: 'checksum-drifted',
        acceptedYaml: [
          'dimensions:',
          '  order_id:',
          '    sql: ${TABLE}.order_id',
          '  changed_after_reproof:',
          '    sql: ${TABLE}.changed_after_reproof',
        ].join('\n'),
      })];
}

function preparedTarget(
  safeIntent: DashboardSafeCopyIntent,
  baseTarget: MigrationTarget,
  patches: MigrationSemanticPatch[],
): DashboardSafeCopyPreparedTarget {
  const preparedTargetValue = { ...baseTarget, semanticPatches: patches };
  const proof = JSON.stringify(patches.map((patch) => ({
    id: patch.id,
    targetFileName: patch.targetFileName,
    previousChecksum: patch.previousChecksum || '',
    acceptedYaml: patch.acceptedYaml || '',
  })));
  const fingerprint = (kind: string) => createHash('sha256').update(`${kind}:${proof}`).digest('hex');
  return {
    status: 'ready',
    targetId: baseTarget.id,
    target: preparedTargetValue,
    plan: planFor(safeIntent, preparedTargetValue),
    decisionFingerprint: fingerprint('decision'),
    planFingerprint: fingerprint('plan'),
    patchCount: patches.filter((patch) => patch.resolution !== 'keep_target').length,
    scratchValidation: patches.length === 0 ? 'not_required' : 'passed',
  };
}

function sourceDashboard(): Record<string, unknown> {
  return {
    name: 'Fictional Operations Dashboard',
    modelId: SOURCE_MODEL_ID,
    workbookModelId: SOURCE_WORKBOOK_MODEL_ID,
    queryPresentations: { data: {}, order: [] },
    controls: [],
    settings: { interactionMode: 'cross-filter' },
    containers: [],
  };
}

function pagination(count: number, complete = true) {
  return {
    complete,
    pages: 1,
    pageSize: 100,
    returnedRecords: count,
    reportedTotalRecords: count,
  };
}

function jobFor(
  safeIntent: DashboardSafeCopyIntent,
  prepared: DashboardSafeCopyPreparedTarget,
): MigrationJob {
  const selected = target();
  return {
    id: `semantic-boundary-${safeIntent.requestId}`,
    workflow: 'dashboard',
    sourceId: safeIntent.source.instanceId,
    sourceLabel: 'Semantic source',
    sourceConnectionId: safeIntent.source.connectionId,
    destinationIds: [selected.destinationInstanceId],
    targets: [selected],
    documentIds: [...safeIntent.source.documentIds],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'pending',
    createdAt: BASE_TIME,
    details: {
      operationMode: 'safe_copy',
      safeCopyProfile: DASHBOARD_SAFE_COPY_PROFILE,
      safeCopyRequestId: safeIntent.requestId,
      safeCopyIntentHash: dashboardSafeCopyIntentHash(safeIntent),
      safeCopyPreparationState: 'prepared',
    },
    items: [{
      id: `safe-copy-preparation:${TARGET_ID}`,
      jobId: `semantic-boundary-${safeIntent.requestId}`,
      targetId: TARGET_ID,
      destinationId: selected.destinationInstanceId,
      destinationLabel: selected.destinationLabel,
      targetModelId: selected.targetModelId,
      kind: 'semantic_validate',
      status: 'succeeded',
      startedAt: BASE_TIME,
      endedAt: BASE_TIME,
      details: {
        safeCopyPreparationSummary: true,
        safeCopyTargetStatus: 'ready',
        safeCopyDecisionFingerprint: prepared.decisionFingerprint,
        safeCopyPlanFingerprint: prepared.planFingerprint,
        safeCopyPatchCount: prepared.patchCount,
      },
    }],
  };
}

function createHarness(options: {
  mode: SemanticMode;
  requestId: string;
  accessMode?: AccessMode;
}) {
  const safeIntent = intent(options.requestId);
  const selected = target();
  let prepareCalls = 0;
  let semanticApplied = false;
  let currentYaml = 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id';
  let currentChecksum = 'checksum-before';
  let createdDocumentState: Record<string, unknown> | undefined;
  let clock = BASE_TIME;
  let randomSequence = 0;
  let semanticAttemptObserved = false;
  const writes: SemanticWriteInput[] = [];
  const writeOrder: string[] = [];
  let documentCreateCalls = 0;
  const initialPatches = patchesFor(options.mode, 1, false);
  const initialPrepared = preparedTarget(safeIntent, selected, initialPatches);
  let storedJob = jobFor(safeIntent, initialPrepared);

  const source = instance(SOURCE_INSTANCE_ID, 'source');
  const destination = instance(DESTINATION_INSTANCE_ID, 'destination');
  const services: DashboardSafeCopyRuntimeServices = {
    getJob(jobId) {
      return jobId === storedJob.id ? storedJob : undefined;
    },
    updateJobAtomically(jobId, reducer) {
      if (jobId !== storedJob.id) return undefined;
      const priorItems = storedJob.items;
      storedJob = reducer(storedJob);
      if (!semanticAttemptObserved && storedJob.items.some((item) => (
        item.details?.safeCopyAttempt === true
        && item.details.safeCopyAttemptOperation === 'semantic_update'
        && item.details.safeCopyAttemptState === 'dispatched'
      ))) {
        semanticAttemptObserved = true;
        writeOrder.push('semantic-attempt-persisted');
      }
      assert.ok(storedJob.items.length >= priorItems.length);
      return storedJob;
    },
    publishMigrationJobEvent() {},
    getInstance(instanceId) {
      if (instanceId === source.id) return source;
      if (instanceId === destination.id) return destination;
      return undefined;
    },
    createClient(saved) {
      return {
        async listFolderInventory() {
          return { folders: [], pagination: pagination(0) };
        },
        async listDocumentInventory() {
          const documents = saved.id === DESTINATION_INSTANCE_ID && createdDocumentState
            ? [{
                id: 'created-fictional-dashboard',
                identifier: 'created-fictional-dashboard',
                name: 'Fictional Operations Dashboard',
                connectionId: DESTINATION_CONNECTION_ID,
                baseModelId: DESTINATION_MODEL_ID,
                hasDashboard: true,
              }]
            : [];
          return { documents, pagination: pagination(documents.length) };
        },
        async getDocumentStateV2(documentId) {
          if (saved.id === SOURCE_INSTANCE_ID && documentId === SOURCE_DOCUMENT_ID) {
            return sourceDashboard();
          }
          if (saved.id === DESTINATION_INSTANCE_ID && documentId === 'created-fictional-dashboard' && createdDocumentState) {
            return createdDocumentState;
          }
          throw new Error('Fictional document state is unavailable.');
        },
        async runQuery() {
          return { status: 'COMPLETE', rowCount: 0 };
        },
        async getModelYaml(modelId, options) {
          if (saved.id === SOURCE_INSTANCE_ID && options?.mode === 'extension') {
            assert.equal(modelId, SOURCE_WORKBOOK_MODEL_ID);
            assert.equal(options.fullyResolved, false);
            assert.equal(options.includeChecksums, true);
            // Shared-model semantic cases must establish that no workbook-local definitions need copying.
            return { files: {}, checksums: {}, raw: {} };
          }
          return {
            files: { 'fictional_orders.view': currentYaml },
            checksums: { 'fictional_orders.view': currentChecksum },
            raw: {},
          };
        },
        async updateModelYamlFile(input) {
          writes.push({ ...input });
          writeOrder.push('checksum-cas');
          semanticApplied = true;
          currentYaml = input.yaml;
          currentChecksum = 'checksum-after';
          return {} as never;
        },
        async listDocumentAccessInventory() {
          if (options.accessMode === 'non-owner-direct') {
            return {
              principals: [{
                id: 'fictional-viewer',
                name: 'Fictional viewer',
                type: 'user' as const,
                role: 'VIEWER' as const,
                accessBoost: false,
                accessSource: 'direct' as const,
                isOwner: false,
              }],
              pagination: pagination(1),
            };
          }
          if (options.accessMode === 'incomplete') {
            return { principals: [], pagination: pagination(0, false) };
          }
          return { principals: [], pagination: pagination(0) };
        },
        async createDashboardSafeCopyDocument(input) {
          documentCreateCalls += 1;
          createdDocumentState = {
            modelId: input.modelId,
            ...input.content,
            name: input.name,
          };
          return {
            id: 'created-fictional-dashboard',
            identifier: 'created-fictional-dashboard',
            raw: {},
          };
        },
      };
    },
    prepareTargets: async () => {
      prepareCalls += 1;
      const patches = patchesFor(options.mode, prepareCalls, semanticApplied);
      return [preparedTarget(safeIntent, selected, patches)];
    },
    now: () => {
      clock += 1;
      return clock;
    },
    randomId: () => {
      randomSequence += 1;
      return `semantic-boundary-attempt-${randomSequence}`;
    },
  };

  return {
    safeIntent,
    services,
    get storedJob() {
      return storedJob;
    },
    get prepareCalls() {
      return prepareCalls;
    },
    get documentCreateCalls() {
      return documentCreateCalls;
    },
    writes,
    writeOrder,
  };
}

async function executeHarness(harness: ReturnType<typeof createHarness>) {
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    harness.storedJob.id,
    harness.services,
  );
  return executeDashboardSafeCopy(adapter.input, adapter.dependencies);
}

test('runtime enforces zero or one exact checksum-CAS semantic write from real prepared patches', async () => {
  const none = createHarness({
    mode: 'none',
    requestId: '11111111-1111-4111-8111-111111111111',
  });
  const noneResult = await executeHarness(none);
  assert.equal(noneResult.status, 'succeeded');
  assert.equal(none.writes.length, 0);
  assert.equal(none.documentCreateCalls, 1);
  assert.equal(none.storedJob.items.some((item) => item.kind === 'model_yaml_write'), false);

  const one = createHarness({
    mode: 'one',
    requestId: '22222222-2222-4222-8222-222222222222',
  });
  const oneResult = await executeHarness(one);
  assert.equal(oneResult.status, 'succeeded');
  assert.deepEqual(one.writes, [{
    modelId: DESTINATION_MODEL_ID,
    fileName: 'fictional_orders.view',
    yaml: updatePatch().acceptedYaml,
    previousChecksum: 'checksum-before',
    commitMessage: 'Apply verified additive dashboard safe-copy dependency',
  }]);
  assert.deepEqual(one.writeOrder.slice(0, 2), ['semantic-attempt-persisted', 'checksum-cas']);
  assert.equal(one.documentCreateCalls, 1);
  assert.ok(one.storedJob.items.some((item) => (
    item.kind === 'model_yaml_write'
    && item.status === 'succeeded'
    && item.details?.safeCopyAttemptState === 'verified'
  )));
});

test('real new-file and multi-file semantic patches stop before every destination write', async () => {
  for (const [mode, requestId] of [
    ['new-file', '33333333-3333-4333-8333-333333333333'],
    ['multi-file', '44444444-4444-4444-8444-444444444444'],
  ] as const) {
    const harness = createHarness({ mode, requestId });
    const result = await executeHarness(harness);
    assert.equal(result.status, 'needs_attention', mode);
    assert.equal(result.targets[0].exceptions[0]?.code, 'SEMANTIC_CHANGE_UNSAFE', mode);
    assert.equal(harness.writes.length, 0, mode);
    assert.equal(harness.documentCreateCalls, 0, mode);
    assert.equal(harness.storedJob.items.some((item) => item.details?.safeCopyAttempt === true), false, mode);
  }
});

test('semantic checksum and YAML drift before final dispatch leaves the durable attempt uncertain and writes nothing', async () => {
  const harness = createHarness({
    mode: 'drift',
    requestId: '55555555-5555-4555-8555-555555555555',
  });
  const result = await executeHarness(harness);

  assert.equal(result.status, 'needs_attention');
  assert.equal(result.targets[0].exceptions[0]?.code, 'SEMANTIC_APPLY_FAILED');
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.documentCreateCalls, 0);
  const semanticAttempts = harness.storedJob.items.filter((item) => item.kind === 'model_yaml_write');
  assert.equal(semanticAttempts.length, 1);
  assert.equal(semanticAttempts[0].details?.safeCopyAttemptState, 'uncertain');
});

test('non-owner direct grants and incomplete access evidence cannot produce provenance or success', async () => {
  for (const [accessMode, requestId] of [
    ['non-owner-direct', '66666666-6666-4666-8666-666666666666'],
    ['incomplete', '77777777-7777-4777-8777-777777777777'],
  ] as const) {
    clearMigrationDestinationModelReservations();
    const harness = createHarness({ mode: 'none', accessMode, requestId });
    const result = await executeHarness(harness);
    assert.equal(result.status, 'needs_attention', accessMode);
    assert.equal(result.targets[0].exceptions[0]?.code, 'FINAL_VERIFICATION_FAILED', accessMode);
    assert.equal(harness.documentCreateCalls, 1, accessMode);
    assert.equal(harness.storedJob.items.some((item) => (
      item.details?.safeCopyDocumentProvenance !== undefined
    )), false, accessMode);
    assert.equal(harness.storedJob.items.some((item) => (
      item.details?.safeCopyAttemptState === 'verified'
    )), false, accessMode);
  }
});
