import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { migrationJobsHandler } from '../server/handlers/migration-jobs';
import type {
  DashboardSafeCopyAttemptEvidence,
  DashboardSafeCopyExecutionInput,
  DashboardSafeCopyExecutionResult,
  DashboardSafeCopyPreparedDocument,
} from '../server/services/dashboardSafeCopyExecutor';
import {
  cancelDashboardSafeCopyJob,
  createDashboardSafeCopyJob,
  dashboardSafeCopyIntentHash,
  resumePendingDashboardSafeCopyJobs,
} from '../server/services/dashboardSafeCopyJobs';
import {
  dashboardSafeCopySemanticPatchProofHash,
  type DashboardSafeCopyPreparedTarget,
} from '../server/services/dashboardSafeCopyPreparation';
import {
  createDashboardSafeCopyRuntimeAdapterForTests,
  dashboardSafeCopyIntentFromJob,
  dashboardSafeCopyStateHash,
  retryDashboardSafeCopyJobTarget,
  runDashboardSafeCopyJob,
  withDashboardSafeCopyClientEvidence,
  type DashboardSafeCopyClientEvidence,
  type DashboardSafeCopyRuntimeServices,
} from '../server/services/dashboardSafeCopyRuntime';
import {
  publishMigrationJobEvent,
  subscribeMigrationJobEvents,
  type MigrationJobEvent,
} from '../server/services/jobEvents';
import {
  clearJobs,
  closeJobStoreForTests,
  getJob,
  insertJob,
  listJobs,
  updateJobAtomically,
} from '../server/services/jobStore';
import {
  materializeDashboardSafeCopyDocument,
  type MigrationJob,
  type MigrationPlan,
  type MigrationTarget,
} from '../server/services/migrationJobs';
import {
  OmniClientError,
  OmniClient,
  acquireOmniRequestSlot,
  resetOmniClientRateLimitStateForTests,
  type OmniDocumentAccessPrincipal,
  type OmniDocumentRecord,
  type OmniFolderRecord,
  type OmniQueryExecutionSummary,
} from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
  type InstanceRole,
} from '../server/services/nativeVault';
import {
  DASHBOARD_SAFE_COPY_PROFILE,
  DashboardSafeCopyError,
  type DashboardSafeCopyIntent,
} from '../shared/dashboardSafeCopyContract';

const SOURCE_ID = 'source-instance';
const SOURCE_CONNECTION = 'source-connection';
const SOURCE_DOCUMENT = 'dashboard-1';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RETRY_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_RETRY_ID = '33333333-3333-4333-8333-333333333333';
const FIXED_NOW = 1_750_000_000_000;

let temporaryRoot = '';

function saveInstance(
  id: string,
  role: InstanceRole = 'both',
  apiKey: string = `${id}-credential`,
): void {
  upsertInstance({
    id,
    label: `Instance ${id}`,
    role,
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

function destination(targetId: string) {
  return {
    targetId,
    instanceId: `destination-${targetId.toLowerCase()}`,
    connectionId: `connection-${targetId.toLowerCase()}`,
    modelId: `model-${targetId.toLowerCase()}`,
  };
}

function intent(targetIds: string[] = ['B']): DashboardSafeCopyIntent {
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId: REQUEST_ID,
    source: {
      instanceId: SOURCE_ID,
      connectionId: SOURCE_CONNECTION,
      documentIds: [SOURCE_DOCUMENT],
    },
    destinations: targetIds.map(destination),
  };
}

function migrationTarget(row: DashboardSafeCopyIntent['destinations'][number]): MigrationTarget {
  return {
    id: row.targetId,
    destinationInstanceId: row.instanceId,
    destinationLabel: `Destination ${row.targetId}`,
    targetConnectionId: row.connectionId,
    targetModelId: row.modelId,
    ...(row.folderId ? { targetFolderId: row.folderId } : {}),
    ...(row.folderPath ? { targetFolderPath: row.folderPath } : {}),
    ...(row.topicMappings ? { topicMappings: row.topicMappings } : {}),
    ...(row.queryViewMappings ? { queryViewMappings: row.queryViewMappings } : {}),
    ...(row.workbookCopy ? { workbookCopy: { ...row.workbookCopy } } : {}),
  };
}

function planFor(
  safeIntent: DashboardSafeCopyIntent,
  target: MigrationTarget,
): MigrationPlan {
  return {
    sourceId: safeIntent.source.instanceId,
    sourceLabel: 'Source',
    sourceConnectionId: safeIntent.source.connectionId,
    destinationIds: [target.destinationInstanceId],
    targets: [target],
    documentIds: [...safeIntent.source.documentIds],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    sourceAllFolders: true,
    steps: [],
  };
}

function preparedTarget(
  safeIntent: DashboardSafeCopyIntent,
  target: MigrationTarget,
): DashboardSafeCopyPreparedTarget {
  return {
    status: 'ready',
    targetId: target.id,
    target,
    plan: planFor(safeIntent, target),
    decisionFingerprint: `decision-${target.id}`,
    planFingerprint: `plan-${target.id}`,
    patchCount: 0,
    scratchValidation: 'not_required',
  };
}

function semanticPreparedTarget(
  safeIntent: DashboardSafeCopyIntent,
  target: MigrationTarget,
): DashboardSafeCopyPreparedTarget {
  const semanticTarget: MigrationTarget = {
    ...target,
    semanticPatches: [{
      id: `field:${target.id}:orders.net_sales`,
      artifactType: 'field',
      sourceName: 'orders.net_sales',
      sourceFileName: 'orders.view',
      targetFileName: 'orders.view',
      targetModelId: target.targetModelId,
      currentYaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id',
      acceptedYaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id\n  net_sales:\n    sql: ${TABLE}.net_sales',
      previousChecksum: 'checksum-current',
      latestChecksum: 'checksum-current',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_update',
    }],
  };
  return {
    status: 'ready',
    targetId: target.id,
    target: semanticTarget,
    plan: planFor(safeIntent, semanticTarget),
    decisionFingerprint: `semantic-decision-${target.id}`,
    planFingerprint: `semantic-plan-${target.id}`,
    patchCount: 1,
    scratchValidation: 'passed',
  };
}

function safeCopyJob(safeIntent: DashboardSafeCopyIntent): MigrationJob {
  const targets = safeIntent.destinations.map(migrationTarget);
  return {
    id: `safe-copy-job-${safeIntent.destinations.map((row) => row.targetId).join('-')}`,
    workflow: 'dashboard',
    sourceId: safeIntent.source.instanceId,
    sourceLabel: 'Source',
    sourceConnectionId: safeIntent.source.connectionId,
    destinationIds: safeIntent.destinations.map((row) => row.instanceId),
    targets,
    documentIds: [...safeIntent.source.documentIds],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'pending',
    createdAt: FIXED_NOW,
    details: {
      operationMode: 'safe_copy',
      safeCopyProfile: DASHBOARD_SAFE_COPY_PROFILE,
      safeCopyRequestId: safeIntent.requestId,
      safeCopyIntentHash: dashboardSafeCopyIntentHash(safeIntent),
      safeCopyPreparationState: 'prepared',
      ...(safeIntent.deployment ? { safeCopyDeployment: safeIntent.deployment } : {}),
    },
    items: targets.map((target) => {
      const prepared = preparedTarget(safeIntent, target);
      return {
        id: `safe-copy-preparation:${target.id}`,
        jobId: `safe-copy-job-${safeIntent.destinations.map((row) => row.targetId).join('-')}`,
        targetId: target.id,
        destinationId: target.destinationInstanceId,
        destinationLabel: target.destinationLabel || target.destinationInstanceId,
        targetModelId: target.targetModelId,
        kind: 'semantic_validate',
        status: 'succeeded',
        startedAt: FIXED_NOW,
        endedAt: FIXED_NOW,
        details: {
          safeCopyPreparationSummary: true,
          safeCopyTargetStatus: 'ready',
          safeCopyDecisionFingerprint: prepared.decisionFingerprint,
          safeCopyPlanFingerprint: prepared.planFingerprint,
          safeCopyPatchCount: prepared.patchCount,
        },
      };
    }),
  };
}

function safeCopySemanticJob(safeIntent: DashboardSafeCopyIntent): MigrationJob {
  const job = safeCopyJob(safeIntent);
  const target = job.targets?.[0];
  const summary = job.items[0];
  if (!target || !summary) throw new Error('Semantic safe-copy test job is incomplete.');
  const prepared = semanticPreparedTarget(safeIntent, target);
  const semanticProofHash = dashboardSafeCopySemanticPatchProofHash(prepared.target);
  if (!semanticProofHash) throw new Error('Semantic safe-copy test job is missing its exact patch proof.');
  summary.details = {
    ...summary.details,
    safeCopyDecisionFingerprint: prepared.decisionFingerprint,
    safeCopyPlanFingerprint: prepared.planFingerprint,
    safeCopyPatchCount: prepared.patchCount,
    safeCopySemanticProofHash: semanticProofHash,
  };
  return job;
}

function attemptFor(
  jobId: string,
  targetId: string,
  state: DashboardSafeCopyAttemptEvidence['state'] = 'dispatched',
  prepared?: DashboardSafeCopyPreparedDocument,
): DashboardSafeCopyAttemptEvidence {
  const row = destination(targetId);
  return {
    attemptId: `attempt-${targetId.toLowerCase()}`,
    jobId,
    targetId,
    operation: 'document_create',
    state,
    destinationInstanceId: row.instanceId,
    connectionId: row.connectionId,
    modelId: row.modelId,
    sourceDocumentId: SOURCE_DOCUMENT,
    chosenName: 'Safe copy example',
    sourceExportHash: prepared?.sourceExportHash || `source-hash-${targetId}`,
    expectedPayloadHash: prepared?.expectedPayloadHash || `payload-hash-${targetId}`,
    preexistingDocumentIds: [],
    createdAt: FIXED_NOW + 1,
    updatedAt: FIXED_NOW + 1,
  };
}

function sourceDashboard(): Record<string, unknown> {
  return {
    name: 'Safe copy example',
    description: 'Content-only dashboard copy.',
    modelId: 'source-model',
    workbookModelId: 'source-workbook-model',
    queryPresentations: {
      data: {
        '1': {
          type: 'query',
          name: 'Revenue',
          query: {
            modelId: 'source-model',
            baseModelId: 'source-model',
            fields: ['orders.revenue'],
          },
          visConfig: { type: 'table' },
        },
      },
      order: ['1'],
    },
    controls: [],
    settings: { interactionMode: 'cross-filter' },
    containers: [{ type: 'grid', queryPresentationKeys: ['1'] }],
  };
}

function completePagination(count: number) {
  return {
    complete: true as const,
    pages: 1,
    pageSize: 100,
    returnedRecords: count,
    reportedTotalRecords: count,
  };
}

interface ClientHarness {
  candidateVisible: boolean;
  createCalls: number;
  createdInstanceIds?: string[];
  showCreatedDocumentAfterCreate?: boolean;
  semanticWriteCalls?: number;
  prepareCalls?: number;
  assertBeforeCreate?: () => void;
  createError?: Error;
  folders?: OmniFolderRecord[];
  accessPrincipals?: OmniDocumentAccessPrincipal[];
  onListFolderInventory?: (instanceId: string) => void | Promise<void>;
  sourceDashboard?: Record<string, unknown>;
  liveDocumentState?: Record<string, unknown>;
  legacyQueryReads?: number;
  legacyQueries?: unknown;
  runQueryCalls?: Array<Record<string, unknown>>;
  runQuerySummary?: unknown;
  modelFiles?: Record<string, string>;
  sourceModelFiles?: Record<string, string>;
  sourceWorkbookFiles?: Record<string, string>;
  sourceWorkbookReadError?: Error;
}

function runtimeServices(
  safeIntent: DashboardSafeCopyIntent,
  harness: ClientHarness,
  overrides: DashboardSafeCopyRuntimeServices = {},
): DashboardSafeCopyRuntimeServices {
  const createdInstances = new Set<string>();
  const targetStates = new Map(safeIntent.destinations.map((row) => {
    const materialized = materializeDashboardSafeCopyDocument({
      sourceState: harness.sourceDashboard || sourceDashboard(),
      targetModelId: row.modelId,
      topicMappings: [],
      queryViewMappings: [],
    });
    return [`copied-${row.targetId.toLowerCase()}`, { modelId: row.modelId, ...materialized.content }] as const;
  }));
  const createClient: NonNullable<DashboardSafeCopyRuntimeServices['createClient']> = (instance) => ({
    async listFolderInventory() {
      await harness.onListFolderInventory?.(instance.id);
      const folders = harness.folders || [];
      return { folders, pagination: completePagination(folders.length) };
    },
    async listDocumentInventory() {
      const target = safeIntent.destinations.find((row) => row.instanceId === instance.id);
      const documents: OmniDocumentRecord[] = target && (
        harness.candidateVisible
        || (harness.showCreatedDocumentAfterCreate === true && createdInstances.has(instance.id))
      )
        ? [{
          id: `copied-${target.targetId.toLowerCase()}`,
          identifier: `copied-${target.targetId.toLowerCase()}`,
          name: 'Safe copy example',
          connectionId: target.connectionId,
          baseModelId: target.modelId,
          ...(target.folderId ? { folderId: target.folderId } : {}),
          ...(target.folderPath ? { folderPath: target.folderPath } : {}),
          hasDashboard: true,
        }]
        : [];
      return { documents, pagination: completePagination(documents.length) };
    },
    async getDocumentStateV2(documentId) {
      if (instance.id === SOURCE_ID && documentId === SOURCE_DOCUMENT) {
        return harness.sourceDashboard || sourceDashboard();
      }
      if (harness.liveDocumentState) return harness.liveDocumentState;
      const state = targetStates.get(documentId);
      if (!state) throw new Error('Document state unavailable.');
      return state;
    },
    async getDocumentQueries() {
      harness.legacyQueryReads = (harness.legacyQueryReads || 0) + 1;
      return (harness.legacyQueries || []) as never;
    },
    async runQuery(query) {
      harness.runQueryCalls ||= [];
      harness.runQueryCalls.push(structuredClone(query));
      return (harness.runQuerySummary || {
        status: 'COMPLETE',
        rowCount: 1,
      }) as OmniQueryExecutionSummary;
    },
    async getModelYaml(_modelId, options) {
      if (instance.id === SOURCE_ID && options?.mode === 'extension') {
        if (harness.sourceWorkbookReadError) throw harness.sourceWorkbookReadError;
        assert.equal(options.fullyResolved, false);
        assert.ok(options.signal, 'workbook evidence reads must have a bounded abort signal');
        return { files: harness.sourceWorkbookFiles || {}, checksums: {}, raw: {} };
      }
      return { files: (instance.id === SOURCE_ID ? harness.sourceModelFiles : harness.modelFiles) || {}, checksums: {}, raw: {} };
    },
    async updateModelYamlFile() {
      harness.semanticWriteCalls = (harness.semanticWriteCalls || 0) + 1;
      return {} as never;
    },
    async listDocumentAccessInventory() {
      const principals = harness.accessPrincipals || [];
      return { principals, pagination: completePagination(principals.length) };
    },
    async createDashboardSafeCopyDocument() {
      harness.assertBeforeCreate?.();
      harness.createCalls += 1;
      harness.createdInstanceIds ||= [];
      harness.createdInstanceIds.push(instance.id);
      if (harness.createError) throw harness.createError;
      const target = safeIntent.destinations.find((row) => row.instanceId === instance.id);
      const createdId = target && harness.showCreatedDocumentAfterCreate === true
        ? `copied-${target.targetId.toLowerCase()}`
        : 'created-id';
      if (target && harness.showCreatedDocumentAfterCreate === true) createdInstances.add(instance.id);
      return { id: createdId, identifier: createdId, raw: {} };
    },
  });
  return {
    createClient,
    prepareJob: async () => undefined,
    prepareTargets: async (_intent, targets) => {
      harness.prepareCalls = (harness.prepareCalls || 0) + 1;
      return targets.map((target) => preparedTarget(safeIntent, target));
    },
    now: () => FIXED_NOW + 10,
    randomId: () => 'runtime-attempt',
    ...overrides,
  };
}

test('frozen jobs cannot bypass workbook safety through missing evidence, missing identity, or unreadable extension', async () => {
  for (const scenario of ['authored', 'missing-identity', 'unreadable'] as const) {
    const safeIntent = intent();
    const job = safeCopyJob(safeIntent);
    insertJob(job);
    const sourceState = sourceDashboard();
    if (scenario === 'missing-identity') delete sourceState.workbookModelId;
    const harness: ClientHarness = {
      candidateVisible: false, createCalls: 0, sourceDashboard: sourceState,
      ...(scenario === 'authored' ? { sourceWorkbookFiles: { 'example.view': 'dimensions:\n  local_field:\n    sql: 1' } } : {}),
      ...(scenario === 'unreadable' ? { sourceWorkbookReadError: new Error('Unavailable authored evidence') } : {}),
    };
    let preparationCalls = 0;
    const result = await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness, {
      async prepareJob() { preparationCalls += 1; },
    }));
    assert.equal(result.execution?.targets[0].exceptions[0]?.code, 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED');
    assert.equal(preparationCalls, 0, 'block before any legacy scratch/shared preparation');
    assert.equal(harness.createCalls, 0);
    assert.equal(harness.semanticWriteCalls || 0, 0);
    assert.equal(harness.runQueryCalls?.length || 0, 0, 'do not query local fields against shared model');
  }
});

test('content-only fast path remains available when the identified workbook has only empty authored roots', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0, showCreatedDocumentAfterCreate: true,
    sourceWorkbookFiles: { model: '# nothing authored', relationships: '{}', 'empty.view': '' } };
  const result = await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness));
  assert.equal(result.execution?.status, 'succeeded');
  assert.equal(harness.createCalls, 1);
});

test('workbook routing and extension hashes survive durable job reconstruction without authorizing production copying', async () => {
  const safeIntent = intent();
  safeIntent.destinations[0].folderId = 'delivery-folder';
  safeIntent.destinations[0].workbookCopy = { stagingFolderId: 'staging-folder' };
  safeIntent.deployment = { version: 2, planId: 'reviewed-workbook-plan',
    sourceHashes: { [SOURCE_DOCUMENT]: dashboardSafeCopyStateHash(sourceDashboard()) },
    modelHashes: { B: dashboardSafeCopyStateHash({}) },
    workbookCopies: { [SOURCE_DOCUMENT]: {
      sourceSharedModelId: 'source-model', sourceWorkbookModelId: 'source-workbook-model',
      authoredModelHash: '1'.repeat(64), authoredFileHashes: { 'example.view': '2'.repeat(64) },
    } },
  };
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const reconstructed = dashboardSafeCopyIntentFromJob(getJob(job.id)!);
  assert.deepEqual(reconstructed.deployment?.workbookCopies, safeIntent.deployment.workbookCopies);
  assert.deepEqual(reconstructed.destinations[0].workbookCopy, safeIntent.destinations[0].workbookCopy);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const result = await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness));
  assert.equal(result.execution?.targets[0].exceptions[0]?.code, 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED');
  assert.equal(harness.createCalls, 0);
});

async function persistExactVerifiedDocument(
  adapter: Awaited<ReturnType<typeof createDashboardSafeCopyRuntimeAdapterForTests>>,
  targetId: string,
  attemptId?: string,
): Promise<{
  attempt: DashboardSafeCopyAttemptEvidence;
  importedDocumentId: string;
  importedIdentifier: string;
  verifiedAt: number;
}> {
  const target = adapter.input.targets.find((candidate) => candidate.targetId === targetId);
  if (!target) throw new Error(`Missing test target ${targetId}.`);
  const reproved = await adapter.dependencies.reproveTarget(target);
  const prepared = await adapter.dependencies.prepareDocument(reproved, SOURCE_DOCUMENT);
  const dispatched = {
    ...attemptFor(adapter.input.jobId, targetId, 'dispatched', prepared),
    ...(attemptId ? { attemptId } : {}),
  };
  await adapter.dependencies.persistAttempt(dispatched);

  const importedDocumentId = `copied-${targetId.toLowerCase()}`;
  const importedIdentifier = `copied-${targetId.toLowerCase()}`;
  const verificationStartedAt = FIXED_NOW + 2;
  const candidate: DashboardSafeCopyAttemptEvidence = {
    ...dispatched,
    importedDocumentId,
    importedIdentifier,
    publishedFingerprint: prepared.expectedPayloadHash,
    verificationStartedAt,
    updatedAt: verificationStartedAt,
  };
  await adapter.dependencies.persistAttempt(candidate);

  const verifiedAt = FIXED_NOW + 3;
  await adapter.dependencies.persistVerifiedProvenance({
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    resolverVersion: 1,
    verifierVersion: 1,
    jobId: adapter.input.jobId,
    attemptId: candidate.attemptId,
    targetId,
    sourceInstanceId: target.sourceInstanceId,
    sourceConnectionId: target.sourceConnectionId,
    sourceDocumentId: SOURCE_DOCUMENT,
    sourceExportHash: prepared.sourceExportHash,
    destinationInstanceId: target.destinationInstanceId,
    connectionId: target.connectionId,
    modelId: target.modelId,
    ...(target.folderId ? { folderId: target.folderId } : {}),
    ...(target.folderPath ? { folderPath: target.folderPath } : {}),
    importedDocumentId,
    importedIdentifier,
    chosenName: candidate.chosenName!,
    expectedPayloadHash: prepared.expectedPayloadHash,
    publishedFingerprint: prepared.expectedPayloadHash,
    verifiedAt,
  });
  const attempt: DashboardSafeCopyAttemptEvidence = {
    ...candidate,
    state: 'verified',
    verifierVersion: 1,
    verifiedAt,
    updatedAt: verifiedAt,
  };
  await adapter.dependencies.persistAttempt(attempt);
  return { attempt, importedDocumentId, importedIdentifier, verifiedAt };
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-safe-copy-runtime-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'true';
  closeJobStoreForTests();
  unlockVault('safe copy runtime test passphrase');
  saveInstance(SOURCE_ID);
  for (const targetId of ['B', 'C', 'D']) saveInstance(destination(targetId).instanceId);
});

afterEach(() => {
  closeJobStoreForTests();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
});

test('safe-copy evidence revisions order same-millisecond writes and no-op reducers do not rewrite history', () => {
  const job = safeCopyJob(intent());
  insertJob(job);
  assert.equal(getJob(job.id)?.details?.safeCopyEvidenceRevision, 1);

  const first = updateJobAtomically(job.id, (current) => ({
    ...current,
    status: 'running',
    startedAt: FIXED_NOW,
  }));
  const second = updateJobAtomically(job.id, (current) => ({
    ...current,
    details: {
      ...(current.details || {}),
      safeCopyExecutionState: 'running',
    },
  }));
  assert.equal(first?.startedAt, FIXED_NOW);
  assert.equal(second?.startedAt, FIXED_NOW);
  assert.equal(first?.details?.safeCopyEvidenceRevision, 2);
  assert.equal(second?.details?.safeCopyEvidenceRevision, 3);

  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const bytesBeforeNoop = readFileSync(historyPath, 'utf8');
  const inodeBeforeNoop = statSync(historyPath).ino;
  const unchanged = updateJobAtomically(job.id, (current) => ({
    ...current,
    details: { ...(current.details || {}) },
  }));

  assert.equal(unchanged?.details?.safeCopyEvidenceRevision, 3);
  assert.equal(readFileSync(historyPath, 'utf8'), bytesBeforeNoop);
  assert.equal(statSync(historyPath).ino, inodeBeforeNoop);
});

test('failed durable history replacement leaves the stored and handler evidence revision authoritative', async () => {
  const job = safeCopyJob(intent());
  insertJob(job);
  const initialResponse = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}`,
  ));
  assert.equal(initialResponse.status, 200);
  const initialBody = await initialResponse.json() as { job: MigrationJob };
  const initialEvidence = initialBody.job.details?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
  assert.equal(initialEvidence.evidenceRevision, 1);
  assert.equal(initialEvidence.complete, true);

  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const durableBytes = readFileSync(historyPath, 'utf8');
  const blockedNow = 1_750_000_123_456;
  const blockedTempPath = `${historyPath}.${process.pid}.${blockedNow}.tmp`;
  mkdirSync(blockedTempPath);
  const realDateNow = Date.now;
  Date.now = () => blockedNow;
  try {
    assert.throws(
      () => updateJobAtomically(job.id, (current) => ({
        ...current,
        status: 'running',
        startedAt: FIXED_NOW,
      })),
      /EISDIR|illegal operation on a directory/i,
    );
  } finally {
    Date.now = realDateNow;
    rmSync(blockedTempPath, { recursive: true, force: true });
  }

  const authoritative = getJob(job.id)!;
  assert.equal(authoritative.status, 'pending');
  assert.equal(authoritative.details?.safeCopyEvidenceRevision, 1);
  assert.equal(readFileSync(historyPath, 'utf8'), durableBytes);

  const response = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}`,
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as { job: MigrationJob };
  const evidence = body.job.details?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
  assert.equal(body.job.status, 'pending');
  assert.equal(body.job.details?.safeCopyEvidenceRevision, 1);
  assert.equal(evidence.evidenceRevision, 1);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.validatedAttemptIds, []);
  assert.deepEqual(evidence.verifiedDocuments, []);
});

test('detail API attaches one exact revision-bound client ledger without persisting derived evidence', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, { candidateVisible: false, createCalls: 0 }),
  );
  const verified = await persistExactVerifiedDocument(adapter, 'B');
  const stored = getJob(job.id)!;
  const evidenceRevision = stored.details?.safeCopyEvidenceRevision as number;

  const attached = withDashboardSafeCopyClientEvidence(stored);
  const directEvidence = attached.details?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
  const expectedEvidence: DashboardSafeCopyClientEvidence = {
    version: 1,
    jobId: job.id,
    evidenceRevision,
    complete: true,
    invalidTargetIds: [],
    validatedAttemptIds: [verified.attempt.attemptId],
    verifiedDocuments: [{
      targetId: 'B',
      sourceDocumentId: SOURCE_DOCUMENT,
      importedDocumentId: verified.importedDocumentId,
      importedIdentifier: verified.importedIdentifier,
      chosenTargetName: verified.attempt.chosenName!,
      verifiedAt: verified.verifiedAt,
    }],
  };
  assert.deepEqual(directEvidence, expectedEvidence);

  const response = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}`,
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as { job: MigrationJob };
  assert.deepEqual(body.job.details?.safeCopyClientEvidence, expectedEvidence);
  assert.equal(body.job.details?.safeCopyEvidenceRevision, evidenceRevision);

  assert.equal(getJob(job.id)?.details?.safeCopyClientEvidence, undefined);
  assert.doesNotMatch(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8'), /safeCopyClientEvidence/);
});

test('client evidence quarantines malformed target B attempt or provenance without suppressing exact target C', async () => {
  const safeIntent = intent(['B', 'C']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, { candidateVisible: false, createCalls: 0 }),
  );
  const verifiedB = await persistExactVerifiedDocument(adapter, 'B');
  const verifiedC = await persistExactVerifiedDocument(adapter, 'C');
  const stored = getJob(job.id)!;
  const baseRevision = stored.details?.safeCopyEvidenceRevision as number;

  const mutations: Array<[string, (mutated: MigrationJob) => void]> = [
    ['attempt fingerprint', (mutated) => {
      const attempt = mutated.items.find((item) => item.id === `safe-copy-attempt:${verifiedB.attempt.attemptId}`)!;
      attempt.details = { ...(attempt.details || {}), safeCopyAttemptFingerprint: 'tampered' };
    }],
    ['verified provenance', (mutated) => {
      const verification = mutated.items.find((item) => item.id === `safe-copy-verification:${verifiedB.attempt.attemptId}`)!;
      const provenance = structuredClone(verification.details?.safeCopyDocumentProvenance) as Record<string, unknown>;
      provenance.importedIdentifier = 'tampered-identifier';
      verification.details = { ...(verification.details || {}), safeCopyDocumentProvenance: provenance };
    }],
  ];

  for (const [index, [label, mutate]] of mutations.entries()) {
    const malformed = structuredClone(stored);
    malformed.details = {
      ...(malformed.details || {}),
      safeCopyEvidenceRevision: baseRevision + index + 1,
    };
    mutate(malformed);
    const evidence = withDashboardSafeCopyClientEvidence(malformed).details
      ?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
    assert.equal(evidence.complete, true, label);
    assert.deepEqual(evidence.invalidTargetIds, ['B'], label);
    assert.deepEqual(evidence.validatedAttemptIds, [verifiedC.attempt.attemptId], label);
    assert.deepEqual(evidence.verifiedDocuments, [{
      targetId: 'C',
      sourceDocumentId: SOURCE_DOCUMENT,
      importedDocumentId: verifiedC.importedDocumentId,
      importedIdentifier: verifiedC.importedIdentifier,
      chosenTargetName: verifiedC.attempt.chosenName!,
      verifiedAt: verifiedC.verifiedAt,
    }], label);
  }
});

test('client evidence rejects noncanonical attempt envelopes and non-unique verified candidates per target', async () => {
  const safeIntent = intent(['B', 'C']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, { candidateVisible: false, createCalls: 0 }),
  );
  const verifiedB = await persistExactVerifiedDocument(adapter, 'B');
  const verifiedC = await persistExactVerifiedDocument(adapter, 'C');
  const stored = getJob(job.id)!;
  const baseRevision = stored.details?.safeCopyEvidenceRevision as number;

  const noncanonicalEnvelope = structuredClone(stored);
  noncanonicalEnvelope.details = {
    ...(noncanonicalEnvelope.details || {}),
    safeCopyEvidenceRevision: baseRevision + 1,
  };
  const targetBAttempt = noncanonicalEnvelope.items.find(
    (item) => item.id === `safe-copy-attempt:${verifiedB.attempt.attemptId}`,
  )!;
  targetBAttempt.destinationId = 'different-destination-envelope';
  const envelopeEvidence = withDashboardSafeCopyClientEvidence(noncanonicalEnvelope).details
    ?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
  assert.equal(envelopeEvidence.complete, true);
  assert.deepEqual(envelopeEvidence.invalidTargetIds, ['B']);
  assert.deepEqual(envelopeEvidence.validatedAttemptIds, [verifiedC.attempt.attemptId]);

  await persistExactVerifiedDocument(adapter, 'B', 'attempt-b-second');
  const duplicateCandidate = getJob(job.id)!;
  assert.ok((duplicateCandidate.details?.safeCopyEvidenceRevision as number) > baseRevision);
  const duplicateEvidence = withDashboardSafeCopyClientEvidence(duplicateCandidate).details
    ?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
  assert.equal(duplicateEvidence.complete, true);
  assert.deepEqual(duplicateEvidence.invalidTargetIds, ['B']);
  assert.deepEqual(duplicateEvidence.validatedAttemptIds, [verifiedC.attempt.attemptId]);
  assert.equal(duplicateEvidence.verifiedDocuments.some((document) => document.targetId === 'B'), false);
  assert.equal(duplicateEvidence.verifiedDocuments.some((document) => document.targetId === 'C'), true);
});

test('client evidence fails closed with compact output above the 6,000-item evidence bound', () => {
  const job = safeCopyJob(intent(['B', 'C']));
  job.details = { ...(job.details || {}), safeCopyEvidenceRevision: 1 };
  job.items.push(...Array.from({ length: 6_001 }, (_, index) => ({
    id: `oversized-proof-${index + 1}`,
    jobId: job.id,
    targetId: index % 2 === 0 ? 'B' : 'C',
    destinationId: index % 2 === 0 ? destination('B').instanceId : destination('C').instanceId,
    destinationLabel: index % 2 === 0 ? 'Destination B' : 'Destination C',
    targetModelId: index % 2 === 0 ? destination('B').modelId : destination('C').modelId,
    kind: 'document_verify' as const,
    status: 'succeeded' as const,
    details: { safeCopyDocumentProvenance: {} },
  })));

  const attached = withDashboardSafeCopyClientEvidence(job);
  const evidence = attached.details?.safeCopyClientEvidence as DashboardSafeCopyClientEvidence;
  assert.equal(evidence.complete, false);
  assert.deepEqual(evidence.invalidTargetIds, ['B', 'C']);
  assert.deepEqual(evidence.validatedAttemptIds, []);
  assert.deepEqual(evidence.verifiedDocuments, []);
  assert.equal(job.details?.safeCopyClientEvidence, undefined);
});

test('runtime persists a dispatched attempt and event before the injected document write', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const events: MigrationJobEvent[] = [];
  const unsubscribe = subscribeMigrationJobEvents(job.id, (event) => {
    events.push(event);
    if (event.type === 'item' && event.item?.details?.safeCopyAttempt === true) {
      assert.ok(getJob(job.id)?.items.some((item) => item.id === event.itemId));
    }
  });
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    assertBeforeCreate() {
      const stored = getJob(job.id)?.items.find((item) => item.details?.safeCopyAttempt === true);
      assert.equal(stored?.details?.safeCopyAttemptState, 'dispatched');
      assert.equal(stored?.status, 'running');
      assert.equal(existsSync(process.env.OMNIKIT_JOB_HISTORY_PATH!), true);
    },
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const reproved = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared: DashboardSafeCopyPreparedDocument = {
    sourceDocumentId: SOURCE_DOCUMENT,
    documentName: 'Safe copy example',
    sourceExportHash: 'source-hash',
    expectedPayloadHash: 'payload-hash',
    content: materializeDashboardSafeCopyDocument({
      sourceState: sourceDashboard(),
      targetModelId: destination('B').modelId,
      topicMappings: [],
      queryViewMappings: [],
    }).content,
  };
  const attempt = attemptFor(job.id, 'B', 'dispatched', prepared);

  await adapter.dependencies.persistAttempt(attempt);
  await adapter.dependencies.createDocument(reproved, prepared, attempt.chosenName!, attempt);
  unsubscribe();

  assert.equal(harness.createCalls, 1);
  assert.ok(events.some((event) => event.type === 'item' && event.item?.details?.safeCopyAttemptState === 'dispatched'));
  const disk = readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8');
  assert.doesNotMatch(disk, /queryPresentations|orders\.revenue|Content-only dashboard copy/);
});

test('atomic attempt persistence rejects canceled and missing jobs before any write can dispatch', async () => {
  const safeIntent = intent();
  const canceledJob = safeCopyJob(safeIntent);
  insertJob(canceledJob);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const canceledAdapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    canceledJob.id,
    runtimeServices(safeIntent, harness),
  );
  assert.equal(cancelDashboardSafeCopyJob(canceledJob.id).status, 'canceled');
  await assert.rejects(
    canceledAdapter.dependencies.persistAttempt(attemptFor(canceledJob.id, 'B')),
    /canceled safe-copy job no longer accepts attempt evidence/,
  );
  assert.equal(harness.createCalls, 0);

  const canceledWithAttempt = safeCopyJob(safeIntent);
  const dispatched = attemptFor(canceledWithAttempt.id, 'B');
  insertJob(canceledWithAttempt);
  const canceledExistingAdapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    canceledWithAttempt.id,
    runtimeServices(safeIntent, harness),
  );
  await canceledExistingAdapter.dependencies.persistAttempt(dispatched);
  updateJobAtomically(canceledWithAttempt.id, (current) => ({
    ...current,
    status: 'canceled',
    endedAt: FIXED_NOW,
  }));
  await assert.rejects(
    canceledExistingAdapter.dependencies.persistAttempt({
      ...dispatched,
      state: 'uncertain',
      updatedAt: dispatched.updatedAt + 1,
    }),
    /canceled safe-copy job no longer accepts attempt evidence/,
  );
  assert.equal(getJob(canceledWithAttempt.id)?.status, 'canceled');

  const missingJob = { ...safeCopyJob(safeIntent), id: 'safe-copy-job-missing' };
  missingJob.items = missingJob.items.map((item) => ({ ...item, jobId: missingJob.id }));
  insertJob(missingJob);
  const missingAdapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    missingJob.id,
    runtimeServices(safeIntent, harness),
  );
  clearJobs();
  await assert.rejects(
    missingAdapter.dependencies.persistAttempt(attemptFor(missingJob.id, 'B')),
    /disappeared before attempt persistence/,
  );
  assert.equal(harness.createCalls, 0);
});

test('runtime re-proves the exact target immediately before each document create', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    prepareCalls: 0,
    assertBeforeCreate() {
      assert.ok(
        (harness.prepareCalls || 0) >= 2,
        'target proof must be refreshed after document preparation and immediately before the write',
      );
    },
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const reproved = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared: DashboardSafeCopyPreparedDocument = {
    sourceDocumentId: SOURCE_DOCUMENT,
    documentName: 'Safe copy example',
    sourceExportHash: 'source-hash',
    expectedPayloadHash: 'payload-hash',
    content: materializeDashboardSafeCopyDocument({
      sourceState: sourceDashboard(),
      targetModelId: destination('B').modelId,
      topicMappings: [],
      queryViewMappings: [],
    }).content,
  };
  const attempt = attemptFor(job.id, 'B', 'dispatched', prepared);
  await adapter.dependencies.persistAttempt(attempt);
  await adapter.dependencies.createDocument(reproved, prepared, attempt.chosenName!, attempt);
  assert.equal(harness.createCalls, 1);
});

test('approved deployment evidence and explicit mappings survive persisted request reconstruction', () => {
  const safeIntent = intent();
  safeIntent.destinations[0].topicMappings = [{ sourceTopicName: 'source_topic', action: 'map_existing', targetTopicName: 'target_topic' }];
  safeIntent.destinations[0].queryViewMappings = [{ sourceQueryViewName: 'source_view', action: 'map_existing', targetQueryViewName: 'target_view' }];
  safeIntent.deployment = {
    version: 2, planId: 'reviewed-plan',
    sourceHashes: { [SOURCE_DOCUMENT]: 'a'.repeat(64) }, modelHashes: { B: 'b'.repeat(64) },
  };
  const created = createDashboardSafeCopyJob(safeIntent);
  assert.deepEqual(dashboardSafeCopyIntentFromJob(getJob(created.job.id)!), safeIntent);
  assert.equal(createDashboardSafeCopyJob(safeIntent).replayed, true);
  assert.throws(() => createDashboardSafeCopyJob({
    ...safeIntent, deployment: { ...safeIntent.deployment!, planId: 'different-plan' },
  }), (error) => error instanceof DashboardSafeCopyError && error.code === 'SAFE_COPY_IDEMPOTENCY_CONFLICT');
});

test('snapshot hashing ignores object key order but includes nested content and array order', () => {
  assert.equal(dashboardSafeCopyStateHash({ b: [{ z: 1, a: 2 }], a: 'x' }), dashboardSafeCopyStateHash({ a: 'x', b: [{ a: 2, z: 1 }] }));
  assert.notEqual(dashboardSafeCopyStateHash({ data: [1, 2] }), dashboardSafeCopyStateHash({ data: [2, 1] }));
});

for (const drift of ['source', 'source-model', 'model', 'none'] as const) {
  test(`v2 deployment rechecks approved source and model snapshots at dispatch: ${drift}`, async () => {
    const safeIntent = intent();
    safeIntent.deployment = {
      version: 2, planId: 'reviewed-plan',
      sourceHashes: { [SOURCE_DOCUMENT]: dashboardSafeCopyStateHash(sourceDashboard()) },
      modelHashes: { B: dashboardSafeCopyStateHash({}) },
      sourceModelHashes: { 'source-model': dashboardSafeCopyStateHash({}) },
    };
    const job = safeCopyJob(safeIntent);
    insertJob(job);
    const harness: ClientHarness = { candidateVisible: false, showCreatedDocumentAfterCreate: true, createCalls: 0 };
    let proofCalls = 0;
    const services = runtimeServices(safeIntent, harness, {
      async prepareTargets(_scopedIntent, targets) {
        proofCalls += 1;
        if (proofCalls === 2) {
          if (drift === 'source') harness.sourceDashboard = { ...sourceDashboard(), name: 'Changed after approval' };
          if (drift === 'model') harness.modelFiles = { 'changed.view': 'dimensions: {}' };
          if (drift === 'source-model') harness.sourceModelFiles = { 'changed.view': 'dimensions: {}' };
        }
        return targets.map((target) => preparedTarget(safeIntent, target));
      },
    });
    const result = await runDashboardSafeCopyJob(job.id, safeIntent, services);
    assert.equal(proofCalls, 2, 'the deployment must reach final pre-dispatch reproof');
    assert.equal(harness.createCalls, drift === 'none' ? 1 : 0);
    assert.equal(harness.semanticWriteCalls || 0, 0);
    if (drift === 'none') assert.equal(result.execution?.status, 'succeeded');
    else {
      const expectedCode = drift === 'source' ? 'SOURCE_SNAPSHOT_CHANGED'
        : drift === 'source-model' ? 'SOURCE_MODEL_SNAPSHOT_CHANGED' : 'MODEL_SNAPSHOT_CHANGED';
      assert.equal(result.execution?.targets[0].exceptions[0]?.code, expectedCode);
      assert.equal(result.execution?.targets[0].exceptions[0]?.retryable, false);
    }
  });
}

test('runtime refuses a late create after asynchronous reproof exhausts the dispatch deadline', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  let clock = FIXED_NOW;
  let proofCalls = 0;
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness, {
    now: () => clock,
    targetDeadlineMs: 1_000,
    async prepareTargets(_scopedIntent, targets) {
      proofCalls += 1;
      if (proofCalls === 2) clock += 1_001;
      return targets.map((target) => preparedTarget(safeIntent, target));
    },
  }));
  assert.equal(proofCalls, 2);
  assert.equal(harness.createCalls, 0);
});

test('bounded pre-write Documents V2 rejection remains safely retryable', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    createError: new OmniClientError(422, '/api/v1/documents', 'Rejected before create.', undefined, 422),
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const reproved = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared: DashboardSafeCopyPreparedDocument = {
    sourceDocumentId: SOURCE_DOCUMENT,
    documentName: 'Safe copy example',
    sourceExportHash: 'source-hash',
    expectedPayloadHash: 'payload-hash',
    content: materializeDashboardSafeCopyDocument({
      sourceState: sourceDashboard(),
      targetModelId: destination('B').modelId,
      topicMappings: [],
      queryViewMappings: [],
    }).content,
  };
  const attempt = attemptFor(job.id, 'B', 'dispatched', prepared);
  await adapter.dependencies.persistAttempt(attempt);

  let rejected: unknown;
  try {
    await adapter.dependencies.createDocument(reproved, prepared, attempt.chosenName!, attempt);
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected);
  assert.equal(adapter.dependencies.classifyWriteFailure?.(rejected), 'definitely_not_committed');
});

test('one absolute target deadline includes canonical folder resolution and is not restarted for execution', async () => {
  const safeIntent = intent();
  safeIntent.destinations[0] = {
    ...safeIntent.destinations[0],
    folderId: 'folder-b',
    folderPath: 'Shared/Finance',
  };
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  let clock = FIXED_NOW;
  let capturedInput: DashboardSafeCopyExecutionInput | undefined;
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    folders: [{ id: 'folder-b', name: 'Finance', path: 'Shared/Finance' }],
    onListFolderInventory() {
      clock += 900;
    },
  };

  await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness, {
    now: () => clock,
    targetDeadlineMs: 1_000,
    execute: async (input) => {
      capturedInput = input;
      return {
        jobId: input.jobId,
        status: 'succeeded',
        targets: input.targets.map((target) => ({
          targetId: target.targetId,
          status: 'succeeded',
          documents: [],
          exceptions: [],
        })),
      };
    },
  }));

  assert.ok(capturedInput);
  assert.equal(capturedInput.targets[0].folderId, 'folder-b');
  assert.equal(capturedInput.targets[0].folderPath, 'Shared/Finance');
  assert.equal(capturedInput.targets[0].deadlineAt, FIXED_NOW + 1_000);
  assert.equal(capturedInput.targets[0].deadlineAt! - clock, 100);
});

test('one slow destination setup cannot consume the execution deadlines of independent destinations', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  for (const target of safeIntent.destinations) {
    target.folderId = `folder-${target.targetId.toLowerCase()}`;
    target.folderPath = `Shared/${target.targetId}`;
  }
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    showCreatedDocumentAfterCreate: true,
    createCalls: 0,
    folders: safeIntent.destinations.map((target) => ({
      id: target.folderId!,
      name: target.targetId,
      path: target.folderPath!,
    })),
    async onListFolderInventory(instanceId) {
      if (instanceId === destination('C').instanceId) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      }
    },
  };
  let nextAttempt = 0;

  const result = await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness, {
    now: Date.now,
    randomId: () => `runtime-attempt-${++nextAttempt}`,
    targetDeadlineMs: 1_000,
  }));

  const resultByTarget = new Map(result.execution?.targets.map((target) => [target.targetId, target]));
  assert.equal(resultByTarget.get('B')?.status, 'succeeded', JSON.stringify(result.execution));
  assert.equal(resultByTarget.get('D')?.status, 'succeeded', JSON.stringify(result.execution));
  assert.deepEqual(
    [...new Set(harness.createdInstanceIds || [])].sort(),
    [destination('B').instanceId, destination('D').instanceId].sort(),
  );
  assert.equal(resultByTarget.has('C'), false, 'setup failures are not executor target results');
  const storedTargetC = result.job.items.find((item) => item.id === 'safe-copy-target-result:C');
  assert.equal(storedTargetC?.details?.safeCopyTargetStatus, 'needs_attention');
  assert.deepEqual(storedTargetC?.details?.safeCopyExceptionCodes, ['TARGET_REPROOF_FAILED']);
});

test('final verification rejects an owner whose direct access is boosted', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: true,
    createCalls: 0,
    accessPrincipals: [{
      id: 'owner-user',
      name: 'Owner',
      type: 'user',
      role: 'MANAGER',
      accessBoost: true,
      accessSource: 'direct',
      isOwner: true,
    }],
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
  const inventory = await adapter.dependencies.readDestinationScope(target, { forceRefresh: true });

  assert.equal(inventory.documents.length, 1);
  assert.equal(
    await adapter.dependencies.verifyDocument(target, prepared, inventory.documents[0]),
    false,
  );
  assert.equal(harness.createCalls, 0);
});

test('source and destination role drift fail closed at the actual document write boundary', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
  const attempt = attemptFor(job.id, 'B', 'dispatched', prepared);
  await adapter.dependencies.persistAttempt(attempt);

  saveInstance(destination('B').instanceId, 'source');
  await assert.rejects(
    adapter.dependencies.createDocument(target, prepared, attempt.chosenName!, attempt),
    /authority changed before the (?:dashboard|destination) write/,
  );
  assert.equal(harness.createCalls, 0);

  saveInstance(destination('B').instanceId, 'both');
  saveInstance(SOURCE_ID, 'destination');
  await assert.rejects(
    adapter.dependencies.createDocument(target, prepared, attempt.chosenName!, attempt),
    /authority changed before the (?:dashboard|destination) write/,
  );
  assert.equal(harness.createCalls, 0);
});

for (const mutation of ['deadline', 'canceled', 'credential'] as const) {
  test(`queued transport rechecks runtime ${mutation} authority before the actual document POST`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FIXED_NOW + 10 });
    resetOmniClientRateLimitStateForTests();
    t.after(resetOmniClientRateLimitStateForTests);
    const safeIntent = intent();
    const job = safeCopyJob(safeIntent);
    insertJob(job);
    const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
    const services = runtimeServices(safeIntent, harness, { now: () => Date.now() });
    let entered = false;
    const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, {
      ...services,
      createClient(instance) {
        const base = services.createClient!(instance);
        const transport = new OmniClient({ ...instance, baseUrl: 'https://93.184.216.34' }, {
          maxReadRetries: 5, fetchImpl: async () => { harness.createCalls++; return new Response(JSON.stringify({ identifier: 'example-copy' })); },
        });
        return { ...base, async createDashboardSafeCopyDocument(input, guard) {
          assert.ok(guard, 'runtime must forward its fresh authority check to the transport');
          entered = true;
          return transport.createDashboardSafeCopyDocument(input, guard);
        } };
      },
    });
    const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
    const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
    const attempt = attemptFor(job.id, 'B', 'dispatched', prepared);
    await adapter.dependencies.persistAttempt(attempt);
    await Promise.all(Array.from({ length: 55 }, () => acquireOmniRequestSlot(`${destination('B').instanceId}-credential`)));
    let expired = false;
    const pending = assert.rejects(adapter.dependencies.createDocument(target, prepared, attempt.chosenName!, attempt, {
      assertCanDispatch() { if (expired) throw new Error('Example deadline expired'); },
    }), (error) => {
      assert.equal(adapter.dependencies.classifyWriteFailure?.(error), 'definitely_not_committed');
      return true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(entered, true);
    assert.equal(harness.createCalls, 0);
    if (mutation === 'deadline') expired = true;
    else if (mutation === 'canceled') updateJobAtomically(job.id, (current) => ({ ...current, status: 'canceled' }));
    else saveInstance(destination('B').instanceId, 'both', 'example-rotated-credential');
    t.mock.timers.tick(60_000);
    await pending;
    assert.equal(harness.createCalls, 0);
  });
}

for (const mutation of [
  {
    label: 'destination role drift',
    apply: () => saveInstance(destination('B').instanceId, 'source'),
  },
  {
    label: 'source credential drift',
    apply: () => saveInstance(SOURCE_ID, 'both', 'rotated-source-credential'),
  },
] as const) {
  test(`document dispatch rejects ${mutation.label} inside final target preparation`, async () => {
    const safeIntent = intent();
    const job = safeCopyJob(safeIntent);
    insertJob(job);
    const harness: ClientHarness = { candidateVisible: false, createCalls: 0, prepareCalls: 0 };
    const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
      job.id,
      runtimeServices(safeIntent, harness, {
        prepareTargets: async (scopedIntent, targets) => {
          harness.prepareCalls = (harness.prepareCalls || 0) + 1;
          const results = targets.map((target) => preparedTarget(scopedIntent, target));
          if (harness.prepareCalls === 2) mutation.apply();
          return results;
        },
      }),
    );
    const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
    const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
    const attempt = attemptFor(job.id, 'B', 'dispatched', prepared);
    await adapter.dependencies.persistAttempt(attempt);

    await assert.rejects(
      adapter.dependencies.createDocument(target, prepared, attempt.chosenName!, attempt),
      /authority changed before the destination write/,
    );
    assert.equal(harness.prepareCalls, 2);
    assert.equal(harness.createCalls, 0);
  });
}

for (const mutation of [
  {
    label: 'source role drift',
    apply: () => saveInstance(SOURCE_ID, 'destination'),
  },
  {
    label: 'destination credential drift',
    apply: () => saveInstance(destination('B').instanceId, 'both', 'rotated-destination-credential'),
  },
] as const) {
  test(`semantic dispatch rejects ${mutation.label} inside final target preparation`, async () => {
    const safeIntent = intent();
    const job = safeCopySemanticJob(safeIntent);
    insertJob(job);
    const harness: ClientHarness = {
      candidateVisible: false,
      createCalls: 0,
      semanticWriteCalls: 0,
      prepareCalls: 0,
    };
    const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
      job.id,
      runtimeServices(safeIntent, harness, {
        prepareTargets: async (scopedIntent, targets) => {
          harness.prepareCalls = (harness.prepareCalls || 0) + 1;
          const results = targets.map((target) => semanticPreparedTarget(scopedIntent, target));
          if (harness.prepareCalls === 2) mutation.apply();
          return results;
        },
      }),
    );
    const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
    assert.equal(target.semanticChange.mode, 'existing_file_update');
    if (target.semanticChange.mode !== 'existing_file_update') {
      throw new Error('Expected one checksum-protected semantic update.');
    }
    const row = destination('B');
    const attempt: DashboardSafeCopyAttemptEvidence = {
      attemptId: `semantic-attempt-${mutation.label.replaceAll(' ', '-')}`,
      jobId: job.id,
      targetId: 'B',
      operation: 'semantic_update',
      state: 'dispatched',
      destinationInstanceId: row.instanceId,
      connectionId: row.connectionId,
      modelId: row.modelId,
      fileName: target.semanticChange.fileName,
      previousChecksum: target.semanticChange.previousChecksum,
      expectedYamlHash: target.semanticChange.expectedYamlHash,
      createdAt: FIXED_NOW + 1,
      updatedAt: FIXED_NOW + 1,
    };
    await adapter.dependencies.persistAttempt(attempt);

    await assert.rejects(
      adapter.dependencies.applySemanticChange(target, attempt),
      /authority changed before the destination write/,
    );
    assert.equal(harness.prepareCalls, 2);
    assert.equal(harness.semanticWriteCalls, 0);
    assert.equal(harness.createCalls, 0);
  });
}

test('multi-target reproof always receives a single-target scoped intent', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const observedTargetIds: string[][] = [];
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness, {
      prepareTargets: async (scopedIntent, targets) => {
        observedTargetIds.push(scopedIntent.destinations.map((row) => row.targetId));
        return targets.map((target) => preparedTarget(scopedIntent, target));
      },
    }),
  );

  for (const target of adapter.input.targets) {
    await adapter.dependencies.reproveTarget(target);
  }

  assert.deepEqual(observedTargetIds, [['B'], ['C'], ['D']]);
});

test('resumed execution reasserts role authority before its first destination inventory read', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  let folderInventoryReads = 0;
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    onListFolderInventory() {
      folderInventoryReads += 1;
    },
  };
  saveInstance(SOURCE_ID, 'destination');

  const result = await runDashboardSafeCopyJob(
    job.id,
    safeIntent,
    runtimeServices(safeIntent, harness),
  );

  assert.equal(result.job.status, 'failed');
  assert.equal(folderInventoryReads, 0);
  assert.equal(harness.createCalls, 0);
});

test('runtime persists B, C, and D outcomes in isolated target ledgers', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const services = runtimeServices(safeIntent, harness, {
    execute: async (input, dependencies): Promise<DashboardSafeCopyExecutionResult> => {
      const statuses = new Map<string, DashboardSafeCopyAttemptEvidence['state']>([
        ['B', 'verified'],
        ['C', 'failed_prewrite'],
        ['D', 'uncertain'],
      ]);
      for (const target of input.targets) {
        const attempt = attemptFor(input.jobId, target.targetId);
        await dependencies.persistAttempt(attempt);
        if (target.targetId === 'B') {
          const verificationStartedAt = FIXED_NOW + 2;
          const candidate: DashboardSafeCopyAttemptEvidence = {
            ...attempt,
            importedDocumentId: 'copied-b',
            importedIdentifier: 'copied-b',
            publishedFingerprint: attempt.expectedPayloadHash,
            verificationStartedAt,
            updatedAt: verificationStartedAt,
          };
          await dependencies.persistAttempt(candidate);
          const verifiedAt = FIXED_NOW + 3;
          await dependencies.persistVerifiedProvenance({
            profile: DASHBOARD_SAFE_COPY_PROFILE,
            resolverVersion: 1,
            verifierVersion: 1,
            jobId: input.jobId,
            attemptId: candidate.attemptId,
            targetId: target.targetId,
            sourceInstanceId: target.sourceInstanceId,
            sourceConnectionId: target.sourceConnectionId,
            sourceDocumentId: SOURCE_DOCUMENT,
            sourceExportHash: candidate.sourceExportHash!,
            destinationInstanceId: target.destinationInstanceId,
            connectionId: target.connectionId,
            modelId: target.modelId,
            ...(target.folderId ? { folderId: target.folderId } : {}),
            ...(target.folderPath ? { folderPath: target.folderPath } : {}),
            importedDocumentId: candidate.importedDocumentId!,
            importedIdentifier: candidate.importedIdentifier!,
            chosenName: candidate.chosenName!,
            expectedPayloadHash: candidate.expectedPayloadHash!,
            publishedFingerprint: candidate.publishedFingerprint!,
            verifiedAt,
          });
          await dependencies.persistAttempt({
            ...candidate,
            state: 'verified',
            verifierVersion: 1,
            verifiedAt,
            updatedAt: verifiedAt,
          });
          continue;
        }
        await dependencies.persistAttempt({
          ...attempt,
          state: statuses.get(target.targetId)!,
          updatedAt: FIXED_NOW + 2,
        });
      }
      return {
        jobId: input.jobId,
        status: 'partial',
        targets: input.targets.map((target) => ({
          targetId: target.targetId,
          status: target.targetId === 'B' ? 'succeeded' : target.targetId === 'D' ? 'partial' : 'needs_attention',
          documents: [],
          exceptions: target.targetId === 'B' ? [] : [{
            code: target.targetId === 'D' ? 'IMPORT_UNCERTAIN' : 'IMPORT_FAILED',
            targetId: target.targetId,
            message: `Target ${target.targetId} requires attention.`,
            retryable: target.targetId === 'C',
          }],
        })),
      };
    },
  });

  const result = await runDashboardSafeCopyJob(job.id, safeIntent, services);
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.details?.safeCopyExecutionState, 'reconciliation_required');
  const stored = getJob(job.id)!;
  for (const [targetId, expectedState] of [['B', 'verified'], ['C', 'failed_prewrite'], ['D', 'uncertain']] as const) {
    const items = stored.items.filter((item) => item.targetId === targetId && item.details?.safeCopyAttempt === true);
    assert.equal(items.length, 1);
    assert.equal(items[0].details?.safeCopyAttemptState, expectedState);
    assert.equal(items[0].destinationId, destination(targetId).instanceId);
  }
  assert.equal(stored.items.filter((item) => item.id.startsWith('safe-copy-target-result:')).length, 3);

  const overlappingIntent: DashboardSafeCopyIntent = {
    ...safeIntent,
    requestId: SECOND_RETRY_ID,
  };
  assert.throws(
    () => createDashboardSafeCopyJob(overlappingIntent),
    (error: unknown) => (
      error instanceof DashboardSafeCopyError
      && error.code === 'SAFE_COPY_SCOPE_CONFLICT'
      && error.statusCode === 409
    ),
  );
  assert.equal(listJobs(Number.MAX_SAFE_INTEGER).length, 1);
});

test('runtime exposes completed B and D target summaries while target C is still waiting', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  let releaseTargetC!: () => void;
  const targetCGate = new Promise<void>((resolve) => {
    releaseTargetC = resolve;
  });
  let signalFastTargets!: () => void;
  const fastTargetsVisible = new Promise<void>((resolve) => {
    signalFastTargets = resolve;
  });

  const services = runtimeServices(safeIntent, harness, {
    execute: async (input, dependencies): Promise<DashboardSafeCopyExecutionResult> => {
      assert.ok(dependencies.onTargetResult, 'runtime must bind incremental target-result persistence');
      const results: DashboardSafeCopyExecutionResult['targets'] = [];
      const completeTarget = async (target: DashboardSafeCopyExecutionInput['targets'][number]) => {
        const reproved = await dependencies.reproveTarget(target);
        const prepared = await dependencies.prepareDocument(reproved, SOURCE_DOCUMENT);
        const dispatched = attemptFor(input.jobId, target.targetId, 'dispatched', prepared);
        await dependencies.persistAttempt(dispatched);
        const verificationStartedAt = FIXED_NOW + 2;
        const importedDocumentId = `copied-${target.targetId.toLowerCase()}`;
        const importedIdentifier = importedDocumentId;
        const candidate: DashboardSafeCopyAttemptEvidence = {
          ...dispatched,
          importedDocumentId,
          importedIdentifier,
          publishedFingerprint: prepared.expectedPayloadHash,
          verificationStartedAt,
          updatedAt: verificationStartedAt,
        };
        await dependencies.persistAttempt(candidate);
        const verifiedAt = FIXED_NOW + 3;
        await dependencies.persistVerifiedProvenance({
          profile: DASHBOARD_SAFE_COPY_PROFILE,
          resolverVersion: 1,
          verifierVersion: 1,
          jobId: input.jobId,
          attemptId: candidate.attemptId,
          targetId: target.targetId,
          sourceInstanceId: target.sourceInstanceId,
          sourceConnectionId: target.sourceConnectionId,
          sourceDocumentId: SOURCE_DOCUMENT,
          sourceExportHash: prepared.sourceExportHash,
          destinationInstanceId: target.destinationInstanceId,
          connectionId: target.connectionId,
          modelId: target.modelId,
          ...(target.folderId ? { folderId: target.folderId } : {}),
          ...(target.folderPath ? { folderPath: target.folderPath } : {}),
          importedDocumentId,
          importedIdentifier,
          chosenName: candidate.chosenName!,
          expectedPayloadHash: prepared.expectedPayloadHash,
          publishedFingerprint: prepared.expectedPayloadHash,
          verifiedAt,
        });
        await dependencies.persistAttempt({
          ...candidate,
          state: 'verified',
          verifierVersion: 1,
          verifiedAt,
          updatedAt: verifiedAt,
        });
        const result: DashboardSafeCopyExecutionResult['targets'][number] = {
          targetId: target.targetId,
          status: 'succeeded',
          documents: [{
            sourceDocumentId: SOURCE_DOCUMENT,
            status: 'succeeded',
            chosenName: candidate.chosenName!,
            importedDocumentId,
            importedIdentifier,
            sourceExportHash: prepared.sourceExportHash,
            expectedPayloadHash: prepared.expectedPayloadHash,
            publishedFingerprint: prepared.expectedPayloadHash,
          }],
          exceptions: [],
        };
        results.push(result);
        await dependencies.onTargetResult!(result);
      };

      await completeTarget(input.targets.find((target) => target.targetId === 'B')!);
      await completeTarget(input.targets.find((target) => target.targetId === 'D')!);
      signalFastTargets();
      await targetCGate;
      await completeTarget(input.targets.find((target) => target.targetId === 'C')!);
      return { jobId: input.jobId, status: 'succeeded', targets: results };
    },
  });

  let settled = false;
  const running = runDashboardSafeCopyJob(job.id, safeIntent, services).finally(() => {
    settled = true;
  });
  await fastTargetsVisible;

  assert.equal(settled, false);
  const incremental = getJob(job.id)!;
  assert.equal(incremental.status, 'running');
  assert.ok(incremental.items.some((item) => item.id === 'safe-copy-target-result:B'));
  assert.ok(incremental.items.some((item) => item.id === 'safe-copy-target-result:D'));
  assert.equal(incremental.items.some((item) => item.id === 'safe-copy-target-result:C'), false);
  const clientEvidence = withDashboardSafeCopyClientEvidence(incremental).details?.safeCopyClientEvidence as
    | DashboardSafeCopyClientEvidence
    | undefined;
  assert.deepEqual(clientEvidence?.verifiedDocuments.map((row) => row.targetId).sort(), ['B', 'D']);

  releaseTargetC();
  const completed = await running;
  assert.equal(completed.job.status, 'succeeded');
  assert.deepEqual(
    completed.job.items
      .filter((item) => item.id.startsWith('safe-copy-target-result:'))
      .map((item) => item.targetId)
      .sort(),
    ['B', 'C', 'D'],
  );
});

test('cancel during target C pre-write work preserves completed B and D and prevents a late C write', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    showCreatedDocumentAfterCreate: true,
    createCalls: 0,
  };
  let releaseTargetC!: () => void;
  const targetCGate = new Promise<void>((resolve) => {
    releaseTargetC = resolve;
  });
  const visibleTargetResults = new Set<string>();
  let signalFastTargets!: () => void;
  const fastTargetsVisible = new Promise<void>((resolve) => {
    signalFastTargets = resolve;
  });
  let nextAttempt = 0;
  const services = runtimeServices(safeIntent, harness, {
    async prepareTargets(scopedIntent, targets) {
      if (scopedIntent.destinations[0]?.targetId === 'C') await targetCGate;
      return targets.map((target) => preparedTarget(scopedIntent, target));
    },
    randomId: () => `cancel-race-attempt-${++nextAttempt}`,
    publishMigrationJobEvent(event) {
      if (event.type === 'item' && event.item.id.startsWith('safe-copy-target-result:')) {
        visibleTargetResults.add(event.item.targetId || '');
        if (visibleTargetResults.has('B') && visibleTargetResults.has('D')) signalFastTargets();
      }
    },
  });

  const running = runDashboardSafeCopyJob(job.id, safeIntent, services);
  await fastTargetsVisible;
  assert.equal(getJob(job.id)?.items.some((item) => item.id === 'safe-copy-target-result:C'), false);

  const canceled = cancelDashboardSafeCopyJob(job.id);
  assert.equal(canceled?.status, 'canceled');
  releaseTargetC();
  const completed = await running;

  assert.equal(completed.job.status, 'canceled');
  assert.deepEqual(
    getJob(job.id)?.items
      .filter((item) => item.id.startsWith('safe-copy-target-result:'))
      .map((item) => item.targetId)
      .sort(),
    ['B', 'D'],
  );
  assert.deepEqual(
    [...new Set(harness.createdInstanceIds || [])].sort(),
    [destination('B').instanceId, destination('D').instanceId].sort(),
  );
  assert.equal(getJob(job.id)?.items.some((item) => (
    item.targetId === 'C' && item.details?.safeCopyAttempt === true
  )), false);
});

test('one target-result store failure cannot suppress later destination evidence', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  let injectedFailure = false;
  const services = runtimeServices(safeIntent, harness, {
    updateJobAtomically(jobId, reducer) {
      const before = getJob(jobId);
      if (!before) return undefined;
      const preview = reducer(before);
      const introducesC = !before.items.some((item) => item.id === 'safe-copy-target-result:C')
        && preview.items.some((item) => item.id === 'safe-copy-target-result:C');
      if (introducesC && !injectedFailure) {
        injectedFailure = true;
        throw new Error('Injected target C durable-store failure.');
      }
      return updateJobAtomically(jobId, reducer);
    },
    execute: async (input) => ({
      jobId: input.jobId,
      status: 'partial',
      targets: input.targets.map((target) => ({
        targetId: target.targetId,
        status: target.targetId === 'B' ? 'succeeded' as const : 'needs_attention' as const,
        documents: [],
        exceptions: target.targetId === 'B' ? [] : [{
          code: 'IMPORT_FAILED' as const,
          targetId: target.targetId,
          message: 'The destination did not accept the dashboard copy.',
          retryable: true,
        }],
      })),
    }),
  });

  await runDashboardSafeCopyJob(job.id, safeIntent, services);
  const stored = getJob(job.id)!;
  assert.equal(injectedFailure, true);
  assert.ok(stored.items.some((item) => item.id === 'safe-copy-target-result:B'));
  assert.ok(stored.items.some((item) => item.id === 'safe-copy-target-result:D'));
});

test('restart recovery makes a dispatched attempt uncertain and exact target retry reconciles without creating again', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const services = runtimeServices(safeIntent, harness);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const reproved = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(reproved, SOURCE_DOCUMENT);
  const baseline = await adapter.dependencies.readDestinationScope(reproved, { forceRefresh: true });
  const attempt = {
    ...attemptFor(job.id, 'B', 'dispatched', prepared),
    preexistingDocumentIds: baseline.documents.map((row) => row.documentId),
  };
  await adapter.dependencies.persistAttempt(attempt);

  closeJobStoreForTests();
  const recovered = getJob(job.id)!;
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.details?.safeCopyExecutionState, 'reconciliation_required');
  assert.equal(
    recovered.items.find((item) => item.details?.safeCopyAttempt === true)?.details?.safeCopyAttemptState,
    'uncertain',
  );

  harness.candidateVisible = true;
  const retried = await retryDashboardSafeCopyJobTarget(job.id, 'B', RETRY_ID, services);
  assert.equal(
    retried.execution?.targets[0].status,
    'succeeded',
    JSON.stringify(retried.execution?.targets[0]),
  );
  assert.equal(retried.job.status, 'succeeded');
  assert.equal(harness.createCalls, 0);
  const verified = getJob(job.id)!.items.find((item) => item.details?.safeCopyAttempt === true);
  assert.equal(verified?.details?.safeCopyAttemptState, 'verified');
  assert.equal(verified?.importedDocumentId, 'copied-b');
});

test('mixed restart materializes verified B and D before reconciling uncertain C without another write', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const services = runtimeServices(safeIntent, harness);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);

  await persistExactVerifiedDocument(adapter, 'B');
  await persistExactVerifiedDocument(adapter, 'D');
  const targetC = adapter.input.targets.find((target) => target.targetId === 'C')!;
  const reprovedC = await adapter.dependencies.reproveTarget(targetC);
  const preparedC = await adapter.dependencies.prepareDocument(reprovedC, SOURCE_DOCUMENT);
  await adapter.dependencies.persistAttempt(attemptFor(job.id, 'C', 'dispatched', preparedC));
  assert.equal(getJob(job.id)?.items.some((item) => item.id.startsWith('safe-copy-target-result:')), false);

  closeJobStoreForTests();
  const recovered = getJob(job.id)!;
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.details?.safeCopyExecutionState, 'reconciliation_required');
  assert.equal(
    recovered.items.find((item) => item.targetId === 'C' && item.details?.safeCopyAttempt === true)
      ?.details?.safeCopyAttemptState,
    'uncertain',
  );

  harness.candidateVisible = true;
  const retried = await retryDashboardSafeCopyJobTarget(job.id, 'C', RETRY_ID, services);

  assert.equal(retried.execution?.targets[0].status, 'succeeded');
  assert.equal(harness.createCalls, 0);
  assert.equal(retried.job.status, 'succeeded');
  assert.deepEqual(
    retried.job.items
      .filter((item) => item.id.startsWith('safe-copy-target-result:'))
      .map((item) => item.targetId)
      .sort(),
    ['B', 'C', 'D'],
  );
});

test('restart after durable target success but before finalization repairs the terminal job state', () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  job.status = 'running';
  job.startedAt = FIXED_NOW + 1;
  job.details = { ...job.details, safeCopyExecutionState: 'copying' };
  job.items.push({
    id: 'safe-copy-target-result:B',
    jobId: job.id,
    targetId: 'B',
    destinationId: destination('B').instanceId,
    destinationLabel: 'Destination B',
    targetModelId: destination('B').modelId,
    kind: 'document_verify',
    status: 'succeeded',
    startedAt: FIXED_NOW + 2,
    endedAt: FIXED_NOW + 2,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'succeeded',
      safeCopyExceptionCodes: [],
      safeCopyDocuments: [],
    },
  });
  insertJob(job);

  closeJobStoreForTests();
  const recovered = getJob(job.id)!;

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.details?.safeCopyExecutionState, 'complete');
  assert.equal(recovered.details?.safeCopySucceededTargetCount, 1);
  assert.equal(recovered.details?.safeCopyNeedsAttentionTargetCount, 0);
  assert.equal(
    recovered.items.find((item) => item.id === 'safe-copy-target-result:B')?.status,
    'succeeded',
  );
});

test('restart resumes only untouched targets after one destination result was durably verified', async () => {
  const safeIntent = intent(['B', 'C', 'D']);
  const job = safeCopyJob(safeIntent);
  job.status = 'running';
  job.startedAt = FIXED_NOW + 1;
  job.details = { ...job.details, safeCopyExecutionState: 'copying' };
  const verified = attemptFor(job.id, 'B');
  job.items.push(
    {
      id: 'verified-attempt-b',
      jobId: job.id,
      targetId: 'B',
      destinationId: destination('B').instanceId,
      destinationLabel: 'Destination B',
      kind: 'import',
      status: 'succeeded',
      startedAt: FIXED_NOW + 1,
      endedAt: FIXED_NOW + 2,
      details: {
        safeCopyAttempt: true,
        safeCopyAttemptState: 'verified',
        safeCopyAttemptId: verified.attemptId,
        safeCopyAttemptUpdatedAt: FIXED_NOW + 2,
      },
    },
    {
      id: 'safe-copy-target-result:B',
      jobId: job.id,
      targetId: 'B',
      destinationId: destination('B').instanceId,
      destinationLabel: 'Destination B',
      kind: 'document_verify',
      status: 'succeeded',
      startedAt: FIXED_NOW + 2,
      endedAt: FIXED_NOW + 2,
      details: {
        safeCopyTargetExecutionSummary: true,
        safeCopyTargetStatus: 'succeeded',
        safeCopyExceptionCodes: [],
        safeCopyDocuments: [],
      },
    },
  );
  insertJob(job);
  closeJobStoreForTests();
  assert.equal(getJob(job.id)?.status, 'pending');
  assert.equal(getJob(job.id)?.details?.safeCopyExecutionState, 'resume_required');

  const executedTargetIds: string[][] = [];
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const resumed = resumePendingDashboardSafeCopyJobs(async (jobId, resumedIntent) => {
    await runDashboardSafeCopyJob(jobId, resumedIntent, runtimeServices(resumedIntent, harness, {
      execute: async (input) => {
        executedTargetIds.push(input.targets.map((target) => target.targetId));
        return {
          jobId: input.jobId,
          status: 'succeeded',
          targets: input.targets.map((target) => ({
            targetId: target.targetId,
            status: 'succeeded',
            documents: [],
            exceptions: [],
          })),
        };
      },
    }));
  });
  assert.deepEqual(resumed, [job.id]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(executedTargetIds, [['C', 'D']]);
  assert.equal(getJob(job.id)?.status, 'succeeded');
  assert.equal(getJob(job.id)?.items.filter((item) => item.id === 'safe-copy-target-result:B').length, 1);
});

test('restart materializes a missing target result from exact verified attempt provenance without repeating the write', async () => {
  const safeIntent = intent(['B', 'C']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0, semanticWriteCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const reproved = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(reproved, SOURCE_DOCUMENT);
  const dispatched = attemptFor(job.id, 'B', 'dispatched', prepared);
  await adapter.dependencies.persistAttempt(dispatched);
  const verificationStartedAt = FIXED_NOW + 2;
  const candidate: DashboardSafeCopyAttemptEvidence = {
    ...dispatched,
    importedDocumentId: 'copied-b',
    importedIdentifier: 'copied-b',
    publishedFingerprint: prepared.expectedPayloadHash,
    verificationStartedAt,
    updatedAt: verificationStartedAt,
  };
  await adapter.dependencies.persistAttempt(candidate);
  const verifiedAt = FIXED_NOW + 3;
  await adapter.dependencies.persistVerifiedProvenance({
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    resolverVersion: 1,
    verifierVersion: 1,
    jobId: job.id,
    attemptId: dispatched.attemptId,
    targetId: 'B',
    sourceInstanceId: SOURCE_ID,
    sourceConnectionId: SOURCE_CONNECTION,
    sourceDocumentId: SOURCE_DOCUMENT,
    sourceExportHash: prepared.sourceExportHash,
    destinationInstanceId: destination('B').instanceId,
    connectionId: destination('B').connectionId,
    modelId: destination('B').modelId,
    importedDocumentId: 'copied-b',
    importedIdentifier: 'copied-b',
    chosenName: dispatched.chosenName!,
    expectedPayloadHash: prepared.expectedPayloadHash,
    publishedFingerprint: prepared.expectedPayloadHash,
    verifiedAt,
  });
  await adapter.dependencies.persistAttempt({
    ...candidate,
    state: 'verified',
    verifierVersion: 1,
    verifiedAt,
    updatedAt: verifiedAt,
  });
  assert.equal(getJob(job.id)?.items.some((item) => item.id === 'safe-copy-target-result:B'), false);

  closeJobStoreForTests();
  assert.equal(getJob(job.id)?.status, 'pending');
  assert.equal(getJob(job.id)?.details?.safeCopyExecutionState, 'resume_required');

  const executedTargetIds: string[][] = [];
  const resumed = resumePendingDashboardSafeCopyJobs(async (jobId, resumedIntent) => {
    await runDashboardSafeCopyJob(jobId, resumedIntent, runtimeServices(resumedIntent, harness, {
      execute: async (input) => {
        executedTargetIds.push(input.targets.map((target) => target.targetId));
        return {
          jobId: input.jobId,
          status: 'succeeded',
          targets: input.targets.map((target) => ({
            targetId: target.targetId,
            status: 'succeeded',
            documents: [],
            exceptions: [],
          })),
        };
      },
    }));
  });
  assert.deepEqual(resumed, [job.id]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(executedTargetIds, [['C']]);
  assert.equal(harness.createCalls, 0);
  assert.equal(harness.semanticWriteCalls, 0);
  const recoveredResult = getJob(job.id)?.items.find((item) => item.id === 'safe-copy-target-result:B');
  assert.equal(recoveredResult?.details?.safeCopyTargetStatus, 'succeeded');
  assert.deepEqual(recoveredResult?.details?.safeCopyDocuments, [{
    sourceDocumentId: SOURCE_DOCUMENT,
    status: 'succeeded',
    chosenName: dispatched.chosenName,
    importedDocumentId: 'copied-b',
    importedIdentifier: 'copied-b',
    sourceExportHash: prepared.sourceExportHash,
    expectedPayloadHash: prepared.expectedPayloadHash,
    publishedFingerprint: prepared.expectedPayloadHash,
  }]);
  assert.equal(getJob(job.id)?.status, 'succeeded');
});

test('production runtime restart reuses a verified semantic update and creates only the remaining dashboards', async () => {
  const secondSourceDocument = 'dashboard-2';
  const safeIntent: DashboardSafeCopyIntent = {
    ...intent(),
    source: {
      ...intent().source,
      documentIds: [SOURCE_DOCUMENT, secondSourceDocument],
    },
  };
  const job = safeCopySemanticJob(safeIntent);
  job.status = 'running';
  job.startedAt = FIXED_NOW + 1;
  job.details = { ...job.details, safeCopyExecutionState: 'copying' };
  insertJob(job);

  const sourceStates = new Map<string, Record<string, unknown>>([
    [SOURCE_DOCUMENT, sourceDashboard()],
    [secondSourceDocument, {
      ...sourceDashboard(),
      name: 'Safe copy example two',
    }],
  ]);
  const destinationStates = new Map<string, Record<string, unknown>>();
  const destinationRows: OmniDocumentRecord[] = [];
  const documentCreateCalls: string[] = [];
  let semanticWriteCalls = 0;
  let semanticApplied = false;
  let currentYaml = 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id';
  let currentChecksum = 'checksum-current';
  let clock = FIXED_NOW + 10;
  let randomSequence = 0;

  const services: DashboardSafeCopyRuntimeServices = {
    prepareJob: async () => undefined,
    prepareTargets: async (_intent, targets) => targets.map((selected) => (
      semanticApplied
        ? preparedTarget(safeIntent, selected)
        : semanticPreparedTarget(safeIntent, selected)
    )),
    createClient(instance) {
      return {
        async listFolderInventory() {
          return { folders: [], pagination: completePagination(0) };
        },
        async listDocumentInventory() {
          const documents = instance.id === destination('B').instanceId ? destinationRows : [];
          return { documents, pagination: completePagination(documents.length) };
        },
        async getDocumentStateV2(documentId) {
          const state = instance.id === SOURCE_ID
            ? sourceStates.get(documentId)
            : destinationStates.get(documentId);
          if (!state) throw new Error(`Document ${documentId} is unavailable.`);
          return structuredClone(state);
        },
        async getDocumentQueries() {
          return [];
        },
        async runQuery() {
          return { status: 'COMPLETE', rowCount: 1 } as OmniQueryExecutionSummary;
        },
        async getModelYaml(_modelId, options) {
          if (instance.id === SOURCE_ID && options?.mode === 'extension') return { files: {}, checksums: {}, raw: {} };
          return {
            files: { 'orders.view': currentYaml },
            checksums: { 'orders.view': currentChecksum },
            raw: {},
          };
        },
        async updateModelYamlFile(input) {
          semanticWriteCalls += 1;
          semanticApplied = true;
          currentYaml = input.yaml;
          currentChecksum = 'checksum-after-semantic-update';
          return {} as never;
        },
        async listDocumentAccessInventory() {
          return { principals: [], pagination: completePagination(0) };
        },
        async createDashboardSafeCopyDocument(input) {
          const documentId = `resumed-copy-${documentCreateCalls.length + 1}`;
          documentCreateCalls.push(input.name);
          destinationStates.set(documentId, {
            modelId: input.modelId,
            ...structuredClone(input.content),
            name: input.name,
          });
          destinationRows.push({
            id: documentId,
            identifier: documentId,
            name: input.name,
            connectionId: destination('B').connectionId,
            baseModelId: input.modelId,
            hasDashboard: true,
          });
          return { id: documentId, identifier: documentId, raw: {} };
        },
      };
    },
    now: () => {
      clock += 1;
      return clock;
    },
    randomId: () => {
      randomSequence += 1;
      return `semantic-restart-attempt-${randomSequence}`;
    },
  };

  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const targetInput = adapter.input.targets[0];
  const reproved = await adapter.dependencies.reproveTarget(targetInput);
  assert.equal(reproved.semanticChange.mode, 'existing_file_update');
  if (reproved.semanticChange.mode !== 'existing_file_update') {
    throw new Error('Expected one checksum-protected semantic update.');
  }
  const semanticAttempt: DashboardSafeCopyAttemptEvidence = {
    attemptId: 'semantic-update-before-restart',
    jobId: job.id,
    targetId: targetInput.targetId,
    operation: 'semantic_update',
    state: 'dispatched',
    destinationInstanceId: targetInput.destinationInstanceId,
    connectionId: targetInput.connectionId,
    modelId: targetInput.modelId,
    fileName: reproved.semanticChange.fileName,
    previousChecksum: reproved.semanticChange.previousChecksum,
    expectedYamlHash: reproved.semanticChange.expectedYamlHash,
    createdAt: FIXED_NOW + 20,
    updatedAt: FIXED_NOW + 20,
  };
  await adapter.dependencies.persistAttempt(semanticAttempt);
  await adapter.dependencies.applySemanticChange(reproved, semanticAttempt);
  assert.equal(
    await adapter.dependencies.reconcileSemanticChange(reproved, semanticAttempt),
    'verified',
  );
  await adapter.dependencies.persistAttempt({
    ...semanticAttempt,
    state: 'verified',
    updatedAt: FIXED_NOW + 21,
  });

  assert.equal(semanticWriteCalls, 1);
  assert.deepEqual(documentCreateCalls, []);
  assert.equal(getJob(job.id)?.items.filter((item) => (
    item.details?.safeCopyAttemptOperation === 'semantic_update'
    && item.details?.safeCopyAttemptState === 'verified'
  )).length, 1);

  closeJobStoreForTests();
  const recovered = getJob(job.id)!;
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.details?.safeCopyExecutionState, 'resume_required');

  const resumed = await runDashboardSafeCopyJob(job.id, safeIntent, services);
  assert.equal(resumed.job.status, 'succeeded', JSON.stringify({
    details: resumed.job.details,
    items: resumed.job.items,
  }, null, 2));
  assert.equal(semanticWriteCalls, 1, 'resume must not dispatch the verified semantic update again');
  assert.deepEqual(documentCreateCalls.sort(), ['Safe copy example', 'Safe copy example two']);
  assert.equal(resumed.job.items.filter((item) => (
    item.details?.safeCopyAttemptOperation === 'semantic_update'
  )).length, 1);
  assert.equal(resumed.job.items.filter((item) => (
    item.details?.safeCopyAttemptOperation === 'document_create'
    && item.details?.safeCopyAttemptState === 'verified'
  )).length, 2);
  assert.equal(resumed.job.items.filter((item) => (
    item.details?.safeCopyTargetExecutionSummary === true
  )).length, 1);
});

test('retry request claims are durable, target-scoped, and idempotent across reload', async () => {
  const safeIntent = intent(['B', 'C']);
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );

  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', RETRY_ID), 'claimed');
  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', RETRY_ID), 'duplicate');
  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'C', RETRY_ID), 'conflict');
  closeJobStoreForTests();
  const reloaded = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  assert.equal(await reloaded.dependencies.claimRetryRequest(job.id, 'B', RETRY_ID), 'duplicate');
  assert.equal(getJob(job.id)!.items.filter((item) => item.details?.safeCopyRetryClaim === true).length, 1);
});

test('unique completed no-write retries reuse one bounded per-target claim slot', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  let adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const requestId = (index: number) => `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;

  for (let index = 1; index <= 12; index += 1) {
    const currentRequestId = requestId(index);
    const concurrentRequestId = requestId(index + 100);
    assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', currentRequestId), 'claimed');
    assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', currentRequestId), 'duplicate');
    assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', concurrentRequestId), 'conflict');

    const claims = getJob(job.id)!.items.filter((item) => item.details?.safeCopyRetryClaim === true);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].targetId, 'B');
    assert.equal(claims[0].details?.safeCopyRetryRequestId, currentRequestId);

    updateJobAtomically(job.id, (current) => ({
      ...current,
      status: 'partial',
      endedAt: FIXED_NOW + index,
      details: { ...(current.details || {}), safeCopyExecutionState: 'needs_attention' },
    }));
  }

  closeJobStoreForTests();
  adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', requestId(12)), 'duplicate');
  const claims = getJob(job.id)!.items.filter((item) => item.details?.safeCopyRetryClaim === true);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].details?.safeCopyRetryRequestId, requestId(12));
});

test('an attempt-cap retry reconciles one exact uncertain write without inserting or creating again', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const services = runtimeServices(safeIntent, harness);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const reproved = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(reproved, SOURCE_DOCUMENT);
  await adapter.dependencies.persistAttempt(attemptFor(job.id, 'B', 'dispatched', prepared));
  closeJobStoreForTests();

  updateJobAtomically(job.id, (current) => ({
    ...current,
    items: [
      ...current.items,
      ...Array.from({ length: 2_999 }, (_, index) => ({
        id: `reconciliation-cap-padding:${index + 1}`,
        jobId: current.id,
        targetId: 'capacity-padding',
        destinationId: 'capacity-padding',
        destinationLabel: 'Capacity padding',
        targetModelId: 'capacity-padding',
        kind: 'import' as const,
        status: 'failed' as const,
        details: { safeCopyAttempt: true },
      })),
    ],
  }));
  assert.equal(
    getJob(job.id)!.items.filter((item) => item.details?.safeCopyAttempt === true).length,
    3_000,
  );

  harness.candidateVisible = true;
  const retried = await retryDashboardSafeCopyJobTarget(job.id, 'B', RETRY_ID, services);
  assert.equal(
    retried.execution?.targets[0].status,
    'succeeded',
    JSON.stringify({ target: retried.execution?.targets[0], job: getJob(job.id) }),
  );
  assert.equal(retried.job.status, 'pending', 'malformed capacity-only padding remains a separate global hold');
  assert.equal(harness.createCalls, 0);
  const attempts = getJob(job.id)!.items.filter((item) => item.details?.safeCopyAttempt === true);
  assert.equal(attempts.length, 3_000);
  const reconciled = attempts.find((item) => item.targetId === 'B');
  assert.equal(reconciled?.details?.safeCopyAttemptState, 'verified');
  assert.equal(reconciled?.importedDocumentId, 'copied-b');
});

test('a genuinely new attempt at the cap fails before durable mutation or a document write', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  job.items = [
    ...job.items,
    ...Array.from({ length: 3_000 }, (_, index) => ({
      id: `cap-attempt:${index}`,
      jobId: job.id,
      targetId: 'capacity-padding',
      destinationId: 'capacity-padding',
      destinationLabel: 'Capacity padding',
      targetModelId: 'capacity-padding',
      kind: 'import' as const,
      status: 'failed' as const,
      details: { safeCopyAttempt: true },
    })),
  ];
  insertJob(job);
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const durableBytes = readFileSync(historyPath, 'utf8');
  const durableInode = statSync(historyPath).ino;
  const before = getJob(job.id)!;
  const beforeRevision = before.details?.safeCopyEvidenceRevision;
  const beforeAttemptCount = before.items.filter((item) => item.details?.safeCopyAttempt === true).length;
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );

  await assert.rejects(
    adapter.dependencies.persistAttempt(attemptFor(job.id, 'B')),
    (error: unknown) => (error as { code?: unknown })?.code === 'SAFE_COPY_ATTEMPT_LIMIT_EXCEEDED',
  );

  const after = getJob(job.id)!;
  assert.equal(beforeAttemptCount, 3_000);
  assert.equal(after.items.filter((item) => item.details?.safeCopyAttempt === true).length, beforeAttemptCount);
  assert.equal(after.items.some((item) => item.details?.safeCopyRetryClaim === true), false);
  assert.equal(after.items.some((item) => item.details?.safeCopyTargetExecutionSummary === true), false);
  assert.equal(after.details?.safeCopyEvidenceRevision, beforeRevision);
  assert.equal(after.status, 'pending');
  assert.equal(harness.createCalls, 0);
  assert.equal(readFileSync(historyPath, 'utf8'), durableBytes);
  assert.equal(statSync(historyPath).ino, durableInode);
});

test('public target retry rejects a new write at the cap before claim or result mutation', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  job.items.push(...Array.from({ length: 3_000 }, (_, index) => ({
    id: `public-cap-attempt:${index + 1}`,
    jobId: job.id,
    targetId: 'capacity-padding',
    destinationId: 'capacity-padding',
    destinationLabel: 'Capacity padding',
    targetModelId: 'capacity-padding',
    kind: 'import' as const,
    status: 'failed' as const,
    details: { safeCopyAttempt: true },
  })));
  insertJob(job);
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const durableBytes = readFileSync(historyPath, 'utf8');
  const durableInode = statSync(historyPath).ino;
  const before = getJob(job.id)!;
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };

  await assert.rejects(
    retryDashboardSafeCopyJobTarget(
      job.id,
      'B',
      RETRY_ID,
      runtimeServices(safeIntent, harness),
    ),
    (error: unknown) => (
      error instanceof DashboardSafeCopyError
      && error.code === 'SAFE_COPY_IDEMPOTENCY_CONFLICT'
      && error.statusCode === 409
    ),
  );

  const after = getJob(job.id)!;
  assert.deepEqual(after, before);
  assert.equal(after.items.some((item) => item.details?.safeCopyRetryClaim === true), false);
  assert.equal(after.items.some((item) => item.details?.safeCopyTargetExecutionSummary === true), false);
  assert.equal(harness.createCalls, 0);
  assert.equal(readFileSync(historyPath, 'utf8'), durableBytes);
  assert.equal(statSync(historyPath).ino, durableInode);
});

test('attempt persistence is bound to the exact job, target, intent, and source-document scope', async () => {
  const mutations: Array<[string, (attempt: DashboardSafeCopyAttemptEvidence) => void]> = [
    ['job', (attempt) => { attempt.jobId = 'different-job'; }],
    ['target', (attempt) => { attempt.targetId = 'different-target'; }],
    ['destination', (attempt) => { attempt.destinationInstanceId = 'different-destination'; }],
    ['connection', (attempt) => { attempt.connectionId = 'different-connection'; }],
    ['model', (attempt) => { attempt.modelId = 'different-model'; }],
    ['folder id', (attempt) => { attempt.folderId = 'different-folder'; }],
    ['folder path', (attempt) => { attempt.folderPath = '/different-folder'; }],
    ['source document', (attempt) => { attempt.sourceDocumentId = 'different-dashboard'; }],
  ];

  for (const [label, mutate] of mutations) {
    clearJobs();
    const safeIntent = intent();
    const job = safeCopyJob(safeIntent);
    insertJob(job);
    const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
    const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
      job.id,
      runtimeServices(safeIntent, harness),
    );
    const attempt = attemptFor(job.id, 'B');
    mutate(attempt);
    const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
    const beforeBytes = readFileSync(historyPath, 'utf8');
    const beforeRevision = getJob(job.id)?.details?.safeCopyEvidenceRevision;

    await assert.rejects(
      adapter.dependencies.persistAttempt(attempt),
      (error: unknown) => (error as { code?: unknown })?.code === 'SAFE_COPY_ATTEMPT_SCOPE_CHANGED',
      label,
    );

    const stored = getJob(job.id)!;
    assert.equal(stored.items.some((item) => item.details?.safeCopyAttempt === true), false, label);
    assert.equal(stored.details?.safeCopyEvidenceRevision, beforeRevision, label);
    assert.equal(readFileSync(historyPath, 'utf8'), beforeBytes, label);
  }
});

test('attempt persistence recomputes the durable job intent instead of trusting a stale stored hash', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );

  updateJobAtomically(job.id, (current) => ({
    ...current,
    destinationIds: ['drifted-destination'],
    targets: current.targets?.map((target) => target.id === 'B' ? {
      ...target,
      destinationInstanceId: 'drifted-destination',
      targetConnectionId: 'drifted-connection',
      targetModelId: 'drifted-model',
    } : target),
  }));
  const driftedAttempt = attemptFor(job.id, 'B');
  driftedAttempt.destinationInstanceId = 'drifted-destination';
  driftedAttempt.connectionId = 'drifted-connection';
  driftedAttempt.modelId = 'drifted-model';
  const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
  const beforeBytes = readFileSync(historyPath, 'utf8');
  const beforeRevision = getJob(job.id)?.details?.safeCopyEvidenceRevision;

  await assert.rejects(
    adapter.dependencies.persistAttempt(driftedAttempt),
    (error: unknown) => (error as { code?: unknown })?.code === 'SAFE_COPY_JOB_SCOPE_CHANGED',
  );

  assert.equal(getJob(job.id)?.items.some((item) => item.details?.safeCopyAttempt === true), false);
  assert.equal(getJob(job.id)?.details?.safeCopyEvidenceRevision, beforeRevision);
  assert.equal(readFileSync(historyPath, 'utf8'), beforeBytes);
  assert.equal(harness.createCalls, 0);
});

test('an ordinary needs-attention target reaches the target-scoped retry executor', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  job.status = 'failed';
  job.endedAt = FIXED_NOW + 2;
  job.details = { ...job.details, safeCopyExecutionState: 'needs_attention' };
  job.items.push({
    id: 'safe-copy-target-result:B',
    jobId: job.id,
    targetId: 'B',
    destinationId: destination('B').instanceId,
    destinationLabel: 'Destination B',
    targetModelId: destination('B').modelId,
    kind: 'document_verify',
    status: 'failed',
    error: 'The destination did not accept the dashboard copy.',
    startedAt: FIXED_NOW + 1,
    endedAt: FIXED_NOW + 2,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'needs_attention',
      safeCopyExceptionCodes: ['IMPORT_FAILED'],
      safeCopyDocuments: [],
    },
  });
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  let retryCalls = 0;
  const result = await retryDashboardSafeCopyJobTarget(
    job.id,
    'B',
    RETRY_ID,
    runtimeServices(safeIntent, harness, {
      retryTarget: async (input, targetId, retryRequestId) => {
        retryCalls += 1;
        assert.deepEqual(input.targets.map((target) => target.targetId), ['B']);
        assert.equal(targetId, 'B');
        assert.equal(retryRequestId, RETRY_ID);
        return { targetId: 'B', status: 'succeeded', documents: [], exceptions: [] };
      },
    }),
  );

  assert.equal(retryCalls, 1);
  assert.equal(result.job.status, 'succeeded');
  assert.equal(
    getJob(job.id)?.items.find((item) => item.id === 'safe-copy-target-result:B')?.details?.safeCopyTargetStatus,
    'succeeded',
  );
});

test('duplicate retry replay returns the authoritative job without persisting a target result', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const services = runtimeServices(safeIntent, harness);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', RETRY_ID), 'claimed');
  const before = getJob(job.id)!;

  const replay = await retryDashboardSafeCopyJobTarget(job.id, 'B', RETRY_ID, services);

  assert.deepEqual(replay.job, before);
  assert.equal(replay.execution, undefined);
  assert.equal(getJob(job.id)?.items.some((item) => item.id === 'safe-copy-target-result:B'), false);
  assert.equal(harness.createCalls, 0);
});

test('conflicting retry claim returns typed 409 without mutating the authoritative job', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const services = runtimeServices(safeIntent, harness);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', RETRY_ID), 'claimed');
  const before = getJob(job.id)!;

  await assert.rejects(
    retryDashboardSafeCopyJobTarget(job.id, 'B', SECOND_RETRY_ID, services),
    (error: unknown) => (
      error instanceof DashboardSafeCopyError
      && error.code === 'SAFE_COPY_IDEMPOTENCY_CONFLICT'
      && error.statusCode === 409
    ),
  );

  assert.deepEqual(getJob(job.id), before);
  assert.equal(harness.createCalls, 0);
});

test('distinct retry requests cannot concurrently own the same target write scope', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );

  assert.equal(await adapter.dependencies.claimRetryRequest(job.id, 'B', RETRY_ID), 'claimed');
  assert.equal(
    await adapter.dependencies.claimRetryRequest(job.id, 'B', SECOND_RETRY_ID),
    'conflict',
    'one durable target/source operation owner must exclude a second retry request',
  );
  assert.equal(getJob(job.id)!.items.filter((item) => item.details?.safeCopyRetryClaim === true).length, 1);
});

test('retrying an already successful target is a no-op and cannot overwrite its durable result', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  job.status = 'succeeded';
  job.endedAt = FIXED_NOW + 2;
  job.items.push({
    id: 'safe-copy-target-result:B',
    jobId: job.id,
    targetId: 'B',
    destinationId: destination('B').instanceId,
    destinationLabel: 'Destination B',
    targetModelId: destination('B').modelId,
    kind: 'document_verify',
    status: 'succeeded',
    startedAt: FIXED_NOW + 2,
    endedAt: FIXED_NOW + 2,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: 'succeeded',
      safeCopyExceptionCodes: [],
      safeCopyDocuments: [],
    },
  });
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };

  const result = await retryDashboardSafeCopyJobTarget(
    job.id,
    'B',
    RETRY_ID,
    runtimeServices(safeIntent, harness),
  );

  assert.equal(result.job.status, 'succeeded');
  assert.equal(getJob(job.id)?.items.find((item) => item.id === 'safe-copy-target-result:B')?.status, 'succeeded');
  assert.equal(harness.createCalls, 0);
});

test('API exposes only target-scoped retry, stays dark when disabled, and never enters legacy retry', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  let targetRetryCalls = 0;
  const targetRetry = async (jobId: string, targetId: string, requestId: string) => {
    targetRetryCalls += 1;
    assert.equal(jobId, job.id);
    assert.equal(targetId, 'B');
    assert.equal(requestId, RETRY_ID);
    return { job: getJob(job.id)! };
  };

  const targetResponse = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}/targets/B/retry`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: RETRY_ID }) },
  ), { safeCopyRetry: targetRetry });
  assert.equal(targetResponse.status, 202);
  assert.equal(targetRetryCalls, 1);

  const genericResponse = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}/retry`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  ), { safeCopyRetry: targetRetry });
  assert.equal(genericResponse.status, 409);
  assert.equal((await genericResponse.json() as { code?: string }).code, 'SAFE_COPY_TARGET_RETRY_REQUIRED');
  assert.equal(targetRetryCalls, 1);

  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  lockVault();
  const darkResponse = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}/targets/B/retry`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: RETRY_ID }) },
  ), { safeCopyRetry: targetRetry });
  assert.equal(darkResponse.status, 404);
  assert.equal(targetRetryCalls, 1);
});

test('cancel and history deletion remain isolated around dispatched and uncertain writes', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  await adapter.dependencies.persistAttempt(attemptFor(job.id, 'B'));

  const cancel = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}/cancel`,
    { method: 'POST' },
  ));
  assert.equal(cancel.status, 409);
  const deletion = await migrationJobsHandler(new Request(
    'http://localhost/api/migration-jobs',
    { method: 'DELETE' },
  ));
  assert.equal(deletion.status, 409);
  assert.ok(getJob(job.id));
});

test('cancel permits terminal attempt evidence but fails closed on missing or malformed attempt state', () => {
  for (const state of ['verified', 'failed_prewrite'] as const) {
    const safeIntent = intent(['B', 'C']);
    const job = safeCopyJob(safeIntent);
    job.status = 'running';
    job.items.push({
      id: `terminal-attempt-${state}`,
      jobId: job.id,
      targetId: 'B',
      destinationId: destination('B').instanceId,
      destinationLabel: 'Destination B',
      kind: 'import',
      status: state === 'verified' ? 'succeeded' : 'failed',
      details: { safeCopyAttempt: true, safeCopyAttemptState: state },
    });
    insertJob(job);
    assert.equal(cancelDashboardSafeCopyJob(job.id).status, 'canceled');
    assert.equal(getJob(job.id)?.status, 'canceled');
  }

  for (const state of [undefined, 'invented']) {
    const safeIntent = intent(['B', 'C']);
    const job = safeCopyJob(safeIntent);
    job.id = `malformed-cancel-${state || 'missing'}`;
    job.items = job.items.map((item) => ({ ...item, jobId: job.id }));
    job.items.push({
      id: `malformed-attempt-${state || 'missing'}`,
      jobId: job.id,
      targetId: 'B',
      destinationId: destination('B').instanceId,
      destinationLabel: 'Destination B',
      kind: 'import',
      status: 'warning',
      details: {
        safeCopyAttempt: true,
        ...(state ? { safeCopyAttemptState: state } : {}),
      },
    });
    insertJob(job);
    assert.equal(cancelDashboardSafeCopyJob(job.id).status, 'blocked');
    assert.notEqual(getJob(job.id)?.status, 'canceled');
  }
});

test('SSE always delivers its initial snapshot and an immediately following sanitized event', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const controller = new AbortController();
  const response = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${job.id}/events`,
    { signal: controller.signal },
  ));
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body!.getReader();

  publishMigrationJobEvent({
    type: 'item',
    jobId: job.id,
    itemId: 'event-item',
    destinationId: destination('B').instanceId,
    status: 'failed',
    error: 'token omni_eventsecret owner@example.test',
    at: FIXED_NOW + 1,
  });

  const decoder = new TextDecoder();
  let text = '';
  for (let index = 0; index < 3 && (!text.includes('event: snapshot') || !text.includes('event: item')); index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);

  assert.match(text, /event: snapshot/);
  assert.match(text, /event: item/);
  assert.doesNotMatch(text, /omni_eventsecret|owner@example\.test/);
  assert.match(text, /\[redacted\]|\[redacted-email\]/);
});

test('safe-copy identifiers round-trip exactly even when generic text redaction would match them', () => {
  const safeIntent: DashboardSafeCopyIntent = {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId: REQUEST_ID,
    source: {
      instanceId: 'omni_sourceidentifier',
      connectionId: 'source-owner@example.test',
      documentIds: ['token abcdefghijk'],
    },
    destinations: [{
      targetId: 'B',
      instanceId: 'omni_destinationidentifier',
      connectionId: 'destination-owner@example.test',
      modelId: 'omni_modelidentifier',
    }],
  };
  saveInstance(safeIntent.source.instanceId);
  saveInstance(safeIntent.destinations[0].instanceId);
  const job = safeCopyJob(safeIntent);
  insertJob(job);

  const stored = getJob(job.id)!;
  assert.deepEqual(dashboardSafeCopyIntentFromJob(stored), safeIntent);
  assert.equal(stored.sourceId, safeIntent.source.instanceId);
  assert.deepEqual(stored.documentIds, safeIntent.source.documentIds);
  assert.equal(stored.targets?.[0].destinationInstanceId, safeIntent.destinations[0].instanceId);
  assert.equal(stored.targets?.[0].targetConnectionId, safeIntent.destinations[0].connectionId);
  assert.equal(stored.targets?.[0].targetModelId, safeIntent.destinations[0].modelId);
});

test('persisted attempt identifiers survive transition and restart without weakening prose redaction', async () => {
  const safeIntent: DashboardSafeCopyIntent = {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId: REQUEST_ID,
    source: {
      instanceId: 'omni_sourceidentifier',
      connectionId: 'source-owner@example.test',
      documentIds: ['token source-document-abcdefgh'],
    },
    destinations: [{
      targetId: 'B',
      instanceId: 'omni_destinationidentifier',
      connectionId: 'destination-owner@example.test',
      modelId: 'token destination-model-abcdefgh',
      folderId: 'owner-folder@example.test',
    }],
  };
  saveInstance(safeIntent.source.instanceId);
  saveInstance(safeIntent.destinations[0].instanceId);
  const job = safeCopyJob(safeIntent);
  job.sourceLabel = 'Credential credential-owner@secret.example token omni_realsecret12345';
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    folders: [{
      id: safeIntent.destinations[0].folderId!,
      name: 'Exact folder identity',
    }],
  };
  const services = runtimeServices(safeIntent, harness);
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const attempt: DashboardSafeCopyAttemptEvidence = {
    attemptId: 'token attempt-abcdefgh',
    jobId: job.id,
    targetId: 'B',
    operation: 'document_create',
    state: 'dispatched',
    destinationInstanceId: safeIntent.destinations[0].instanceId,
    connectionId: safeIntent.destinations[0].connectionId,
    modelId: safeIntent.destinations[0].modelId,
    folderId: safeIntent.destinations[0].folderId,
    sourceDocumentId: safeIntent.source.documentIds[0],
    chosenName: 'Safe copy example',
    sourceExportHash: 'a'.repeat(64),
    expectedPayloadHash: 'b'.repeat(64),
    preexistingDocumentIds: [
      'owner-preexisting@example.test',
      'token preexisting-document-abcdefgh',
    ],
    createdAt: FIXED_NOW + 1,
    updatedAt: FIXED_NOW + 1,
  };

  await adapter.dependencies.persistAttempt(attempt);
  const firstItem = getJob(job.id)!.items.find((item) => item.details?.safeCopyAttempt === true)!;
  const immutableFingerprint = firstItem.details?.safeCopyAttemptFingerprint;
  assert.equal(firstItem.details?.safeCopyDestinationInstanceId, attempt.destinationInstanceId);
  assert.equal(firstItem.details?.safeCopyConnectionId, attempt.connectionId);
  assert.equal(firstItem.details?.safeCopyModelId, attempt.modelId);
  assert.equal(firstItem.details?.safeCopyFolderId, attempt.folderId);
  assert.equal(firstItem.details?.safeCopySourceDocumentId, attempt.sourceDocumentId);
  assert.deepEqual(firstItem.details?.safeCopyPreexistingDocumentIds, attempt.preexistingDocumentIds);
  assert.doesNotMatch(getJob(job.id)!.sourceLabel, /credential-owner@secret\.example|omni_realsecret12345/);

  const uncertain: DashboardSafeCopyAttemptEvidence = {
    ...attempt,
    state: 'uncertain',
    importedDocumentId: 'owner-imported@example.test',
    importedIdentifier: 'token imported-identifier-abcdefgh',
    publishedFingerprint: attempt.expectedPayloadHash,
    verificationStartedAt: FIXED_NOW + 2,
    updatedAt: FIXED_NOW + 2,
  };
  await adapter.dependencies.persistAttempt(uncertain);
  assert.equal(
    getJob(job.id)!.items.find((item) => item.details?.safeCopyAttempt === true)?.details?.safeCopyAttemptFingerprint,
    immutableFingerprint,
  );

  closeJobStoreForTests();
  const reloaded = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const state = await reloaded.dependencies.loadTargetState(job.id, 'B');

  assert.equal(state.attempts.length, 1);
  assert.deepEqual(state.attempts[0], uncertain);
  const stored = getJob(job.id)!.items.find((item) => item.details?.safeCopyAttempt === true)!;
  assert.equal(stored.details?.safeCopyAttemptFingerprint, immutableFingerprint);
  assert.equal(stored.importedDocumentId, uncertain.importedDocumentId);
  assert.equal(stored.importedIdentifier, uncertain.importedIdentifier);
});

test('verification-start evidence round-trips only with one exact candidate and matching payload fingerprint', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const services = runtimeServices(safeIntent, { candidateVisible: false, createCalls: 0 });
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const base = attemptFor(job.id, 'B');
  const exactCandidate: DashboardSafeCopyAttemptEvidence = {
    ...base,
    importedDocumentId: 'candidate-document-id',
    importedIdentifier: 'candidate-document-slug',
    publishedFingerprint: base.expectedPayloadHash,
    verificationStartedAt: FIXED_NOW + 2,
    updatedAt: FIXED_NOW + 2,
  };

  await adapter.dependencies.persistAttempt(exactCandidate);
  const item = getJob(job.id)!.items.find((row) => row.details?.safeCopyAttempt === true)!;
  assert.equal(item.importedDocumentId, exactCandidate.importedDocumentId);
  assert.equal(item.importedIdentifier, exactCandidate.importedIdentifier);
  assert.equal(item.details?.safeCopyPublishedFingerprint, exactCandidate.expectedPayloadHash);
  assert.equal(item.details?.safeCopyVerificationStartedAt, exactCandidate.verificationStartedAt);

  for (const [label, patch, expected] of [
    ['marker removal', { verificationStartedAt: undefined }, /attempt evidence conflicts with the durable ledger/],
    ['candidate document mutation', { importedDocumentId: 'different-candidate' }, /attempt evidence conflicts with the durable ledger/],
    ['candidate identifier mutation', { importedIdentifier: 'different-candidate-slug' }, /attempt evidence conflicts with the durable ledger/],
    ['candidate fingerprint mutation', { publishedFingerprint: 'different-payload-hash' }, /verification-start evidence is incomplete/],
  ] satisfies Array<[string, Partial<DashboardSafeCopyAttemptEvidence>, RegExp]>) {
    await assert.rejects(
      adapter.dependencies.persistAttempt({ ...exactCandidate, updatedAt: FIXED_NOW + 3, ...patch }),
      expected,
      label,
    );
  }

  const uncertainCandidate: DashboardSafeCopyAttemptEvidence = {
    ...exactCandidate,
    state: 'uncertain',
    updatedAt: FIXED_NOW + 3,
  };
  await adapter.dependencies.persistAttempt(uncertainCandidate);
  await assert.rejects(
    adapter.dependencies.persistAttempt({
      ...uncertainCandidate,
      state: 'failed_prewrite',
      updatedAt: FIXED_NOW + 4,
    }),
    /verification-start evidence is incomplete/,
  );

  closeJobStoreForTests();
  const reloaded = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
  const reloadedState = await reloaded.dependencies.loadTargetState(job.id, 'B');
  assert.deepEqual(reloadedState.attempts, [uncertainCandidate]);

  const invalidEvidence: Array<[string, Partial<DashboardSafeCopyAttemptEvidence>]> = [
    ['missing document ID', { importedDocumentId: undefined }],
    ['missing identifier', { importedIdentifier: undefined }],
    ['missing published fingerprint', { publishedFingerprint: undefined }],
    ['mismatched published fingerprint', { publishedFingerprint: 'different-payload-hash' }],
    ['timestamp before attempt creation', { verificationStartedAt: FIXED_NOW }],
    ['timestamp after attempt update', { verificationStartedAt: FIXED_NOW + 3 }],
  ];
  for (const [label, patch] of invalidEvidence) {
    await assert.rejects(
      reloaded.dependencies.persistAttempt({
        ...exactCandidate,
        attemptId: `invalid-${label.replaceAll(' ', '-')}`,
        ...patch,
      }),
      /verification-start evidence is incomplete/,
      label,
    );
  }
});

test('sensitive-looking requested and runtime-resolved folder paths fail before dispatch', async () => {
  const requestedPathIntent = intent();
  requestedPathIntent.destinations[0] = {
    ...requestedPathIntent.destinations[0],
    folderId: 'folder-b',
    folderPath: 'Shared/owner@example.test',
  };
  assert.throws(
    () => createDashboardSafeCopyJob(requestedPathIntent, { prepare: async () => undefined }),
    /cannot be stored as exact non-secret reconciliation evidence/,
  );
  assert.equal(listJobs().length, 0);

  const resolvedPathIntent = intent();
  resolvedPathIntent.destinations[0] = {
    ...resolvedPathIntent.destinations[0],
    folderId: 'folder-b',
  };
  const job = safeCopyJob(resolvedPathIntent);
  insertJob(job);
  let executionCalls = 0;
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    folders: [{ id: 'folder-b', name: 'Owner', path: 'Shared/owner@example.test' }],
  };

  const result = await runDashboardSafeCopyJob(job.id, resolvedPathIntent, runtimeServices(
    resolvedPathIntent,
    harness,
    {
      execute: async (input) => {
        executionCalls += 1;
        return { jobId: input.jobId, status: 'succeeded', targets: [] };
      },
    },
  ));

  assert.equal(executionCalls, 0);
  assert.equal(harness.createCalls, 0);
  assert.equal(result.job.status, 'failed');
  assert.equal(
    getJob(job.id)?.items.find((item) => item.id === 'safe-copy-target-result:B')?.details?.safeCopyTargetStatus,
    'needs_attention',
  );
});

test('a source dashboard name that would be redacted fails before attempt persistence or create', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    sourceDashboard: {
      ...sourceDashboard(),
      name: 'Owner owner@example.test dashboard',
    },
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);

  await assert.rejects(
    adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT),
    /dashboard name cannot be stored as exact non-secret reconciliation evidence/,
  );
  assert.equal(harness.createCalls, 0);
  assert.equal(
    getJob(job.id)?.items.filter((item) => item.details?.safeCopyAttempt === true).length,
    0,
  );
});

test('preparation executes the exact rewritten Documents V2 query and never trusts legacy query metadata', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    legacyQueries: { malformed: 'legacy query metadata must not be read' },
    legacyQueryReads: 0,
    runQueryCalls: [],
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
  const rewritten = prepared.content.queryPresentations.data['1'].query;

  assert.ok(rewritten);
  assert.equal(harness.legacyQueryReads, 0);
  assert.equal(harness.runQueryCalls?.length, 1);
  assert.deepEqual(harness.runQueryCalls?.[0], rewritten);
  assert.equal(harness.runQueryCalls?.[0].modelId, destination('B').modelId);
  assert.equal(harness.runQueryCalls?.[0].baseModelId, destination('B').modelId);
});

test('final verification rejects missing, extra, or changed live Documents V2 queries', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: true,
    createCalls: 0,
    runQueryCalls: [],
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
  const canonicalLive = {
    modelId: destination('B').modelId,
    ...materializeDashboardSafeCopyDocument({
      sourceState: sourceDashboard(),
      targetModelId: destination('B').modelId,
      topicMappings: [],
      queryViewMappings: [],
    }).content,
  };
  const liveEvidence = {
    documentId: 'copied-b',
    identifier: 'copied-b',
    name: 'Safe copy example',
    destinationInstanceId: destination('B').instanceId,
    connectionId: destination('B').connectionId,
    modelId: destination('B').modelId,
    fingerprint: prepared.expectedPayloadHash,
  };

  const missing = structuredClone(canonicalLive);
  delete missing.queryPresentations.data['1'].query;
  const extra = structuredClone(canonicalLive);
  extra.queryPresentations.data['2'] = {
    type: 'query',
    name: 'Unexpected query',
    query: { modelId: destination('B').modelId, fields: ['orders.count'] },
    visConfig: { type: 'table' },
  };
  extra.queryPresentations.order.push('2');
  const changed = structuredClone(canonicalLive);
  changed.queryPresentations.data['1'].query!.fields = ['orders.count'];

  for (const state of [missing, extra, changed]) {
    harness.liveDocumentState = state;
    assert.equal(
      await adapter.dependencies.verifyDocument(target, prepared, liveEvidence),
      false,
    );
  }
  assert.equal(harness.runQueryCalls?.length, 1, 'only the prepared canonical query may run');
});

test('a query execution summary without an explicit terminal status fails closed before write', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: false,
    createCalls: 0,
    legacyQueryReads: 0,
    runQueryCalls: [],
    runQuerySummary: { rowCount: 1 },
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);

  await assert.rejects(
    adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT),
    /execution evidence is missing, malformed, duplicated, or outside the expected query set/,
  );
  assert.equal(harness.runQueryCalls?.length, 1);
  assert.equal(harness.legacyQueryReads, 0);
  assert.equal(harness.createCalls, 0);
  assert.equal(
    getJob(job.id)?.items.filter((item) => item.details?.safeCopyAttempt === true).length,
    0,
  );
});

test('blank-only dashboards pass preparation and final verification with zero query executions', async () => {
  const blankDashboard = {
    ...sourceDashboard(),
    queryPresentations: {
      data: {
        '1': {
          type: 'blank',
          name: 'Context',
          visConfig: { type: 'text', text: 'No query required.' },
        },
      },
      order: ['1'],
    },
  };
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = {
    candidateVisible: true,
    createCalls: 0,
    sourceDashboard: blankDashboard,
    legacyQueryReads: 0,
    runQueryCalls: [],
  };
  const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(
    job.id,
    runtimeServices(safeIntent, harness),
  );
  const target = await adapter.dependencies.reproveTarget(adapter.input.targets[0]);
  const prepared = await adapter.dependencies.prepareDocument(target, SOURCE_DOCUMENT);
  const inventory = await adapter.dependencies.readDestinationScope(target, { forceRefresh: true });

  assert.equal(inventory.documents.length, 1);
  assert.equal(await adapter.dependencies.verifyDocument(target, prepared, inventory.documents[0]), true);
  assert.equal(harness.runQueryCalls?.length, 0);
  assert.equal(harness.legacyQueryReads, 0);
});

test('runtime stores and publishes only sanitized fixed evidence', async () => {
  const safeIntent = intent();
  const job = safeCopyJob(safeIntent);
  insertJob(job);
  const harness: ClientHarness = { candidateVisible: false, createCalls: 0 };
  const events: MigrationJobEvent[] = [];
  const unsubscribe = subscribeMigrationJobEvents(job.id, (event) => events.push(event));
  await runDashboardSafeCopyJob(job.id, safeIntent, runtimeServices(safeIntent, harness, {
    execute: async (input) => ({
      jobId: input.jobId,
      status: 'needs_attention',
      targets: input.targets.map((target) => ({
        targetId: target.targetId,
        status: 'needs_attention',
        documents: [],
        exceptions: [{
          code: 'IMPORT_FAILED',
          targetId: target.targetId,
          message: 'api_key: omni_supersecret owner@example.test\nviews:\n  private: true',
          retryable: true,
        }],
      })),
    }),
  }));
  unsubscribe();

  const disk = readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, 'utf8');
  const eventText = JSON.stringify(events);
  assert.doesNotMatch(disk, /omni_supersecret|owner@example\.test|private: true/);
  assert.doesNotMatch(eventText, /omni_supersecret|owner@example\.test|private: true/);
  assert.match(disk, /The destination did not accept a safely verified dashboard copy\./);
  assert.ok(events.some((event) => (
    event.type === 'item'
    && event.item?.error === 'The destination did not accept a safely verified dashboard copy.'
  )));
});
