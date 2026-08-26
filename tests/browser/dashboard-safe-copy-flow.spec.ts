import { expect, test, type Page, type Route } from '@playwright/test';
import { sha256Text } from '../../src/services/contentHash';
import type { MigrationJob } from '../../src/services/opsConsole';

const DRAFT_KEY = 'omnikit:dashboardSafeCopyDraft:v1';
const CONNECTION_KEY = 'omnikit:activeConnection:v1';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_HASH = 'a'.repeat(64);
const PAYLOAD_HASH = 'b'.repeat(64);
const ATTEMPT_CREATED_AT = 1;
const VERIFIED_AT = Date.UTC(2026, 0, 1);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
  );
}

const instances = [
  savedInstance('A', 'Source A', 'both'),
  savedInstance('X', 'Other Source', 'source'),
  savedInstance('B', 'Destination B', 'destination'),
  savedInstance('C', 'Destination C', 'destination'),
  savedInstance('D', 'Destination D', 'destination'),
];

function savedInstance(id: string, label: string, role: 'source' | 'destination' | 'both') {
  return {
    id,
    label,
    role,
    baseUrl: `https://${id.toLowerCase()}.example.test`,
    apiKeyMasked: 'omni_••••test',
    defaultModelId: `model-${id.toLowerCase()}`,
    defaultFolderPath: `/Safe copies/${id}`,
    metricFilter: { mode: 'all', values: [] },
    postMigrationActions: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    lastValidatedAt: '2026-08-16T00:00:00.000Z',
  };
}

function connection(id: string) {
  return { id: `connection-${id.toLowerCase()}`, name: `${id} connection`, dialect: 'postgres', database: id };
}

function model(id: string) {
  return {
    id: `model-${id.toLowerCase()}`,
    name: `${id} shared model`,
    connectionId: `connection-${id.toLowerCase()}`,
    connectionName: `${id} connection`,
    kind: 'SHARED',
  };
}

function documents(count = 220) {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, '0');
    return {
      id: `document-${ordinal}`,
      identifier: `dashboard-${ordinal}`,
      name: `Dashboard ${ordinal}`,
      connectionId: 'connection-a',
      folderId: 'folder-source',
      folderPath: '/Source dashboards',
      baseModelId: 'model-a',
      baseModelName: 'A shared model',
      labels: ['safe-copy-test'],
    };
  });
}

function inventory(documentCount: number) {
  return {
    complete: true,
    scope: 'credential',
    cache: {
      status: 'miss',
      fetchedAt: '2026-08-16T00:00:00.000Z',
      expiresAt: '2026-08-16T00:05:00.000Z',
      ageMs: 0,
      fresh: true,
    },
    pagination: { pages: 3, pageSize: 100, returnedRecords: documentCount, reportedTotalRecords: documentCount },
    sourceRecordCount: documentCount,
    matchedRecordCount: documentCount,
    excluded: { missingConnectionId: 0, otherConnection: 0, missingDashboardEvidence: 0 },
  };
}

type SafeCopyPayload = {
  profile: string;
  requestId: string;
  source: { instanceId: string; connectionId: string; documentIds: string[] };
  destinations: Array<{
    targetId: string;
    instanceId: string;
    connectionId: string;
    modelId: string;
    folderPath?: string;
  }>;
};

function safeCopyJob(
  payload: SafeCopyPayload,
  status: 'pending' | 'running' | 'succeeded' | 'partial' = 'pending',
): MigrationJob {
  return attestJob({
    id: JOB_ID,
    workflow: 'dashboard',
    sourceId: payload.source.instanceId,
    sourceLabel: 'Source A',
    sourceConnectionId: payload.source.connectionId,
    destinationIds: payload.destinations.map((row) => row.instanceId),
    targets: payload.destinations.map((row) => ({
      id: row.targetId,
      destinationInstanceId: row.instanceId,
      destinationLabel: `Destination ${row.instanceId}`,
      targetConnectionId: row.connectionId,
      targetModelId: row.modelId,
      targetFolderPath: row.folderPath,
    })),
    documentIds: payload.source.documentIds,
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status,
    createdAt: 1,
    details: {
      safeCopyProfile: 'safe_copy_v1',
      operationMode: 'safe_copy',
      safeCopyRequestId: payload.requestId,
    },
    items: [],
  });
}

function successfulJob(destinationIds: string[]) {
  const payload: SafeCopyPayload = {
    profile: 'safe_copy_v1',
    requestId: REQUEST_ID,
    source: { instanceId: 'A', connectionId: 'connection-a', documentIds: ['dashboard-001'] },
    destinations: destinationIds.map((id) => ({
      targetId: id,
      instanceId: id,
      connectionId: `connection-${id.toLowerCase()}`,
      modelId: `model-${id.toLowerCase()}`,
      folderPath: `/Safe copies/${id}`,
    })),
  };
  const job = safeCopyJob(payload, 'succeeded');
  job.items = destinationIds.flatMap((id) => [
    ...verifiedBundle(id),
    targetResult(id, 'succeeded'),
  ]);
  return attestJob(job, { evidenceRevision: 2 });
}

function partialJob() {
  const payload: SafeCopyPayload = {
    profile: 'safe_copy_v1',
    requestId: REQUEST_ID,
    source: { instanceId: 'A', connectionId: 'connection-a', documentIds: ['dashboard-001'] },
    destinations: ['B', 'C', 'D'].map((id) => ({
      targetId: id,
      instanceId: id,
      connectionId: `connection-${id.toLowerCase()}`,
      modelId: `model-${id.toLowerCase()}`,
      folderPath: `/Safe copies/${id}`,
    })),
  };
  const job = safeCopyJob(payload, 'partial');
  job.items = [
    ...verifiedBundle('B'),
    targetResult('B', 'succeeded'),
    targetResult('C', 'needs_attention', ['SEMANTIC_CHANGE_UNSAFE']),
    ...verifiedBundle('D'),
    targetResult('D', 'succeeded'),
  ];
  return attestJob(job, { evidenceRevision: 2 });
}

function reconciliationJob() {
  const job = partialJob();
  job.status = 'running';
  job.details = { ...(job.details || {}), safeCopyExecutionState: 'reconciliation_required' };
  job.items = [
    ...verifiedBundle('B'),
    targetResult('B', 'succeeded'),
    attemptItem('C', 'uncertain', { updatedAt: 20 }),
    ...verifiedBundle('D'),
    targetResult('D', 'succeeded'),
  ];
  return attestJob(job, { evidenceRevision: 3 });
}

function attemptItem(
  targetId: string,
  state: 'dispatched' | 'failed_prewrite' | 'uncertain' | 'verified',
  options: { verificationStartedAt?: number; updatedAt?: number } = {},
) {
  const lower = targetId.toLowerCase();
  const attemptId = `attempt-${lower}`;
  const chosenName = `Dashboard 001 copy ${targetId}`;
  const importedDocumentId = `imported-document-${lower}`;
  const importedIdentifier = `dashboard-001-copy-${lower}`;
  const hasCandidate = options.verificationStartedAt !== undefined || state === 'verified';
  const updatedAt = options.updatedAt ?? (state === 'verified' ? VERIFIED_AT : 8);
  const details: Record<string, unknown> = {
    safeCopyAttempt: true,
    safeCopyAttemptId: attemptId,
    safeCopyAttemptOperation: 'document_create',
    safeCopyAttemptState: state,
    safeCopyAttemptCreatedAt: ATTEMPT_CREATED_AT,
    safeCopyAttemptUpdatedAt: updatedAt,
    safeCopyDestinationInstanceId: targetId,
    safeCopyConnectionId: `connection-${lower}`,
    safeCopyModelId: `model-${lower}`,
    safeCopyFolderPath: `/Safe copies/${targetId}`,
    safeCopySourceDocumentId: 'dashboard-001',
    safeCopyChosenName: chosenName,
    safeCopySourceExportHash: SOURCE_HASH,
    safeCopyExpectedPayloadHash: PAYLOAD_HASH,
    ...(hasCandidate ? {
      safeCopyImportedDocumentId: importedDocumentId,
      safeCopyImportedIdentifier: importedIdentifier,
      safeCopyPublishedFingerprint: PAYLOAD_HASH,
    } : {}),
    ...(options.verificationStartedAt !== undefined
      ? { safeCopyVerificationStartedAt: options.verificationStartedAt }
      : state === 'verified' ? { safeCopyVerificationStartedAt: 8 } : {}),
    ...(state === 'verified' ? { safeCopyVerifierVersion: 1, safeCopyVerifiedAt: VERIFIED_AT } : {}),
  };
  details.safeCopyAttemptFingerprint = sha256Text(JSON.stringify(stableValue({
    attemptId,
    jobId: JOB_ID,
    targetId,
    operation: 'document_create',
    destinationInstanceId: targetId,
    connectionId: `connection-${lower}`,
    modelId: `model-${lower}`,
    folderId: '',
    folderPath: `/Safe copies/${targetId}`.normalize('NFKC').trim().toLocaleLowerCase('en-US'),
    sourceDocumentId: 'dashboard-001',
    chosenName,
    sourceExportHash: SOURCE_HASH,
    expectedPayloadHash: PAYLOAD_HASH,
    fileName: '',
    previousChecksum: '',
    expectedYamlHash: '',
    preexistingDocumentIds: [],
    createdAt: ATTEMPT_CREATED_AT,
  })));
  return {
    id: `safe-copy-attempt:${attemptId}`,
    jobId: JOB_ID,
    targetId,
    destinationId: targetId,
    destinationLabel: `Destination ${targetId}`,
    targetModelId: `model-${lower}`,
    targetFolderPath: `/Safe copies/${targetId}`,
    kind: 'import' as const,
    documentId: 'dashboard-001',
    documentName: chosenName,
    error: undefined as string | undefined,
    status: state === 'verified' ? 'succeeded' as const
      : state === 'uncertain' ? 'warning' as const
        : state === 'failed_prewrite' ? 'failed' as const : 'running' as const,
    ...(hasCandidate ? { importedDocumentId, importedIdentifier } : {}),
    startedAt: 5,
    ...(state !== 'dispatched' ? { endedAt: updatedAt } : {}),
    details,
  };
}

function verifiedBundle(targetId: string) {
  const lower = targetId.toLowerCase();
  const attempt = attemptItem(targetId, 'verified');
  const attemptId = `attempt-${lower}`;
  const importedDocumentId = `imported-document-${lower}`;
  const importedIdentifier = `dashboard-001-copy-${lower}`;
  const chosenName = `Dashboard 001 copy ${targetId}`;
  return [attempt, {
    id: `safe-copy-verification:${attemptId}`,
    jobId: JOB_ID,
    targetId,
    destinationId: targetId,
    destinationLabel: `Destination ${targetId}`,
    targetModelId: `model-${lower}`,
    targetFolderPath: `/Safe copies/${targetId}`,
    kind: 'document_verify' as const,
    documentId: 'dashboard-001',
    documentName: chosenName,
    status: 'succeeded' as const,
    importedDocumentId,
    importedIdentifier,
    startedAt: VERIFIED_AT,
    endedAt: VERIFIED_AT,
    details: {
      safeCopyDocumentProvenance: {
        profile: 'safe_copy_v1',
        resolverVersion: 1,
        jobId: JOB_ID,
        attemptId,
        targetId,
        sourceInstanceId: 'A',
        sourceConnectionId: 'connection-a',
        sourceDocumentId: 'dashboard-001',
        sourceExportHash: SOURCE_HASH,
        destinationInstanceId: targetId,
        connectionId: `connection-${lower}`,
        modelId: `model-${lower}`,
        folderPath: `/Safe copies/${targetId}`,
        importedDocumentId,
        importedIdentifier,
        chosenName,
        expectedPayloadHash: PAYLOAD_HASH,
        publishedFingerprint: PAYLOAD_HASH,
        verifierVersion: 1,
        verifiedAt: VERIFIED_AT,
        finalVerification: 'passed',
        documentWriteMode: 'created',
      },
    },
  }];
}

function targetResult(targetId: string, status: 'succeeded' | 'needs_attention', exceptionCodes: string[] = []) {
  const lower = targetId.toLowerCase();
  return {
    id: `safe-copy-target-result:${targetId}`,
    jobId: JOB_ID,
    targetId,
    destinationId: targetId,
    destinationLabel: `Destination ${targetId}`,
    targetModelId: `model-${lower}`,
    targetFolderPath: `/Safe copies/${targetId}`,
    kind: 'document_verify' as const,
    status: status === 'succeeded' ? 'succeeded' : 'failed',
    error: status === 'needs_attention' ? `Destination ${targetId} needs a model decision.` : undefined,
    endedAt: 10,
    details: {
      safeCopyTargetExecutionSummary: true,
      safeCopyTargetStatus: status,
      safeCopyExceptionCodes: exceptionCodes,
      safeCopyRecommendedActions: exceptionCodes.includes('SEMANTIC_CHANGE_UNSAFE')
        ? ['select_target_model', 'open_model_migrator']
        : [],
      safeCopyDocuments: [{
        sourceDocumentId: 'dashboard-001',
        status,
        chosenName: `Dashboard 001 copy ${targetId}`,
        ...(exceptionCodes[0] ? { exceptionCode: exceptionCodes[0] } : {}),
      }],
    },
  };
}

function attestJob(
  job: MigrationJob,
  patch: Partial<{
    evidenceRevision: number;
    invalidTargetIds: string[];
    validatedAttemptIds: string[];
    verifiedDocuments: Array<{
      targetId: string;
      sourceDocumentId: string;
      importedDocumentId: string;
      importedIdentifier: string;
      chosenTargetName: string;
      verifiedAt: number;
    }>;
  }> = {},
): MigrationJob {
  const evidenceRevision = patch.evidenceRevision ?? 1;
  const validatedAttemptIds = patch.validatedAttemptIds ?? job.items.flatMap((item) => {
    const attemptId = item.details?.safeCopyAttemptId;
    return item.details?.safeCopyAttempt === true && typeof attemptId === 'string' ? [attemptId] : [];
  });
  const verifiedDocuments = patch.verifiedDocuments ?? job.items.flatMap((item) => {
    const provenance = item.details?.safeCopyDocumentProvenance;
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return [];
    const row = provenance as Record<string, unknown>;
    return typeof row.targetId === 'string'
      && typeof row.sourceDocumentId === 'string'
      && typeof row.importedDocumentId === 'string'
      && typeof row.importedIdentifier === 'string'
      && typeof row.chosenName === 'string'
      && typeof row.verifiedAt === 'number'
      ? [{
        targetId: row.targetId,
        sourceDocumentId: row.sourceDocumentId,
        importedDocumentId: row.importedDocumentId,
        importedIdentifier: row.importedIdentifier,
        chosenTargetName: row.chosenName,
        verifiedAt: row.verifiedAt,
      }]
      : [];
  });
  job.details = {
    ...(job.details || {}),
    safeCopyEvidenceRevision: evidenceRevision,
    safeCopyClientEvidence: {
      version: 1,
      jobId: job.id,
      evidenceRevision,
      complete: true,
      invalidTargetIds: patch.invalidTargetIds ?? [],
      validatedAttemptIds,
      verifiedDocuments,
    },
  };
  return job;
}

function mixedScreen3Job() {
  const job = partialJob();
  job.status = 'running';
  const verifying = attemptItem('C', 'dispatched', {
    verificationStartedAt: VERIFIED_AT + 100,
    updatedAt: VERIFIED_AT + 100,
  });
  verifying.error = 'Bearer omni_browsersecret owner@example.test raw dashboard yaml';
  const uncertain = attemptItem('D', 'uncertain', { updatedAt: 20 });
  uncertain.error = 'password=do-not-render';
  job.items = [
    ...verifiedBundle('B'),
    targetResult('B', 'succeeded'),
    verifying,
    uncertain,
  ];
  job.details = {
    ...(job.details || {}),
    safeCopyRuntimeError: 'Bearer omni_jobsecret owner@example.test raw job prose',
  };
  return attestJob(job, { evidenceRevision: 3 });
}

async function seedActiveConnection(page: Page, draft?: { requestId: string; jobId?: string }) {
  await page.addInitScript(({ connectionKey, draftKey, storedDraft }) => {
    window.sessionStorage.setItem(connectionKey, JSON.stringify({
      baseUrl: 'https://a.example.test',
      apiKey: '__omnikit_vault_instance__:A',
      status: 'success',
      connectionMode: 'vault',
      instanceId: 'A',
      instanceLabel: 'Source A',
      apiKeyMasked: 'omni_••••test',
    }));
    const seedMarker = 'omnikit:safe-copy-browser-seeded:v1';
    if (!window.sessionStorage.getItem(seedMarker)) {
      window.sessionStorage.removeItem(draftKey);
      if (storedDraft) {
        window.sessionStorage.setItem(draftKey, JSON.stringify({ version: 1, ...storedDraft }));
      }
      window.sessionStorage.setItem(seedMarker, 'true');
    }
    window.localStorage.setItem('omnikit:walkthrough:dismissed:v1', 'true');
  }, { connectionKey: CONNECTION_KEY, draftKey: DRAFT_KEY, storedDraft: draft });
}

interface MockOptions {
  createFirstResponseLost?: boolean;
  createJobId?: string;
  restoredJob?: ReturnType<typeof safeCopyJob>;
  missingRestoredJob?: boolean;
  streamJobs?: Array<ReturnType<typeof safeCopyJob>>;
  retryResponseJob?: ReturnType<typeof safeCopyJob>;
  recoveryJobs?: Array<ReturnType<typeof safeCopyJob>>;
  handoffJobReadGate?: Promise<void>;
  connectionCatalogByInstance?: Record<string, Array<ReturnType<typeof connection>>>;
  modelCatalogByInstance?: Record<string, Array<ReturnType<typeof model>>>;
  streamGate?: Promise<void>;
  retryDelayMs?: number;
}

async function installApiMocks(page: Page, options: MockOptions = {}) {
  const createdPayloads: SafeCopyPayload[] = [];
  const retriedTargets: Array<{ jobId: string; targetId: string; requestId: string }> = [];
  const migrationPostPaths: string[] = [];
  let currentJob = options.restoredJob;
  let jobReadCount = 0;
  let handoffJobReadGateArmed = false;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method === 'POST' && path.startsWith('/api/migration-jobs')) migrationPostPaths.push(path);

    if (path === '/api/vault/status') {
      return json(route, { unlocked: true, exists: true, path: '/isolated/test-vault', instanceCount: instances.length });
    }
    if (path === '/api/instances' && method === 'GET') return json(route, { instances });

    const catalogMatch = path.match(/^\/api\/model-migrator\/([^/]+)\/(connections|models)$/);
    if (catalogMatch) {
      const id = decodeURIComponent(catalogMatch[1]);
      return json(route, catalogMatch[2] === 'connections'
        ? { connections: options.connectionCatalogByInstance?.[id] ?? [connection(id)] }
        : { models: options.modelCatalogByInstance?.[id] ?? [model(id)] });
    }

    if (path === '/api/instances/A/documents') {
      const rows = documents();
      return json(route, { documents: rows, inventory: inventory(rows.length) });
    }

    if (path === '/api/migration-jobs/safe-copy' && method === 'POST') {
      const payload = request.postDataJSON() as SafeCopyPayload;
      createdPayloads.push(payload);
      currentJob = safeCopyJob(payload);
      if (options.createJobId) currentJob.id = options.createJobId;
      if (options.createFirstResponseLost && createdPayloads.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return json(route, { error: 'The server accepted the request but the response was lost.' }, 503);
      }
      return json(route, { job: currentJob, replayed: createdPayloads.length > 1, resumed: false });
    }

    if (path === '/api/migration-jobs' && method === 'GET') {
      return json(route, { jobs: options.recoveryJobs || (currentJob ? [currentJob] : []) });
    }

    const retryMatch = path.match(/^\/api\/migration-jobs\/([^/]+)\/targets\/([^/]+)\/retry$/);
    if (retryMatch && method === 'POST') {
      const body = request.postDataJSON() as { requestId: string };
      retriedTargets.push({
        jobId: decodeURIComponent(retryMatch[1]),
        targetId: decodeURIComponent(retryMatch[2]),
        requestId: body.requestId,
      });
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 80));
      if (options.retryResponseJob) currentJob = options.retryResponseJob;
      return json(route, { job: currentJob });
    }

    const eventMatch = path.match(/^\/api\/migration-jobs\/([^/]+)\/events$/);
    if (eventMatch) {
      if (options.streamGate) await options.streamGate;
      const jobs = options.streamJobs || (currentJob ? [currentJob] : []);
      const body = jobs.map((streamJob, index) => (
        `${index === 0 ? 'event: snapshot' : 'event: job'}\ndata: ${JSON.stringify(index === 0
          ? { job: streamJob }
          : { jobId: streamJob.id, status: streamJob.status, at: index + 1, job: streamJob })}\n\n`
      )).join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }

    const jobMatch = path.match(/^\/api\/migration-jobs\/([^/]+)$/);
    if (jobMatch && method === 'GET') {
      jobReadCount += 1;
      if (options.handoffJobReadGate && handoffJobReadGateArmed) await options.handoffJobReadGate;
      if (options.missingRestoredJob || !currentJob) return json(route, { error: 'Migration job not found.' }, 404);
      return json(route, { job: currentJob });
    }

    return json(route, {});
  });

  return {
    createdPayloads,
    retriedTargets,
    migrationPostPaths,
    getJobReadCount: () => jobReadCount,
    armHandoffJobReadGate: () => { handoffJobReadGateArmed = true; },
    getCurrentJob: () => currentJob,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openFlow(page: Page) {
  await page.goto('/dashboards/migrate');
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function chooseDashboardsAndDestinations(page: Page, destinationIds: string[]) {
  await expect(page.getByRole('combobox', { name: 'Source instance' })).toHaveValue('Source A');
  // Connection pickers show "name — database" once selected so two connections
  // that share a name stay distinguishable. See buildConnectionComboBoxOptions.
  await expect(page.getByRole('combobox', { name: 'Source connection' })).toHaveValue('A connection — A');
  await page.getByRole('checkbox', { name: /Dashboard 001/ }).check();
  await page.getByRole('button', { name: 'Choose destinations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose destinations', exact: true })).toBeFocused();
  const stepNavigation = page.getByRole('navigation', { name: 'Dashboard move steps' });
  const steps = stepNavigation.getByRole('button');
  await expect(stepNavigation.locator('button[aria-current="step"]')).toHaveCount(1);
  await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step');
  for (const destinationId of destinationIds) {
    await page.getByRole('checkbox', { name: new RegExp(`Destination ${destinationId}`) }).check();
  }
  await expect(page.getByRole('button', { name: 'Review move' })).toBeEnabled();
  await page.getByRole('button', { name: 'Review move' }).click();
  await expect(page.getByRole('heading', { name: 'Move & track', exact: true })).toBeFocused();
  await expect(stepNavigation.locator('button[aria-current="step"]')).toHaveCount(1);
  await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step');
}

test('three-screen A→B,C,D move is progressive, accessible, idempotent after a lost response, and storage-minimal', async ({ page }) => {
  await seedActiveConnection(page);
  const mock = await installApiMocks(page, { createFirstResponseLost: true });
  await openFlow(page);

  const steps = page.getByRole('navigation', { name: 'Dashboard move steps' }).getByRole('button');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('heading', { name: 'Choose dashboards', exact: true })).toBeFocused();
  await expect(page.getByRole('checkbox', { name: /Dashboard \d{3}/ })).toHaveCount(100);
  await page.getByRole('button', { name: 'Show 100 more' }).click();
  await expect(page.getByRole('checkbox', { name: /Dashboard \d{3}/ })).toHaveCount(200);

  await chooseDashboardsAndDestinations(page, ['B', 'C', 'D']);
  for (const forbidden of [
    'Advanced',
    'Dependency decisions',
    'Edit YAML',
    'Cleanup source',
    'Delete source',
    'Replace same-name',
    'Waive validation',
  ]) {
    await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Move dashboards' }).dblclick();
  await expect.poll(() => mock.createdPayloads.length).toBe(1);
  await expect(page.getByRole('alert')).toContainText('response was lost');
  await page.getByRole('button', { name: 'Move dashboards' }).click();
  await expect.poll(() => mock.createdPayloads.length).toBe(2);
  expect(mock.migrationPostPaths).toEqual([
    '/api/migration-jobs/safe-copy',
    '/api/migration-jobs/safe-copy',
  ]);

  expect(mock.createdPayloads[0].requestId).toBe(mock.createdPayloads[1].requestId);
  expect(mock.createdPayloads[1]).toEqual({
    profile: 'safe_copy_v1',
    requestId: mock.createdPayloads[1].requestId,
    source: { instanceId: 'A', connectionId: 'connection-a', documentIds: ['dashboard-001'] },
    destinations: ['B', 'C', 'D'].map((id) => ({
      targetId: id,
      instanceId: id,
      connectionId: `connection-${id.toLowerCase()}`,
      modelId: `model-${id.toLowerCase()}`,
      folderPath: `/Safe copies/${id}`,
    })),
  });

  await expect.poll(() => page.evaluate((key) => (
    JSON.parse(window.sessionStorage.getItem(key) || '{}') as { jobId?: string }
  ).jobId, DRAFT_KEY)).toBe(JOB_ID);
  const storedDraft = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}'), DRAFT_KEY);
  expect(Object.keys(storedDraft).sort()).toEqual(['jobId', 'requestId', 'version']);
  expect(JSON.stringify(storedDraft)).not.toMatch(/source|dashboard|destination|connection|model|folder|credential|secret/i);

  await page.reload();
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.getByRole('heading', { name: 'Move & track', exact: true })).toBeFocused();
  await expect(page.getByText(`Job ${JOB_ID}`, { exact: true })).not.toBeVisible();
  await page.locator('details').filter({ hasText: `Job ${JOB_ID}` }).getByText('Technical details').click();
  await expect(page.getByText(`Job ${JOB_ID}`, { exact: true })).toBeVisible();
});

test('a minimal A→B move projects only the safe-copy intent contract', async ({ page }) => {
  await seedActiveConnection(page);
  const mock = await installApiMocks(page);
  await openFlow(page);
  await chooseDashboardsAndDestinations(page, ['B']);
  await expect(page.getByRole('list', { name: 'Destination folders' })).toContainText('Destination B: Folder /Safe copies/B');
  await expect(page.getByText(/Source sharing is not copied\. Inherited access follows the destination folder shown here/)).toBeVisible();
  await page.getByRole('button', { name: 'Move dashboards' }).click();
  await expect.poll(() => mock.createdPayloads.length).toBe(1);
  expect(mock.createdPayloads[0].destinations.map((row) => row.instanceId)).toEqual(['B']);
  expect(Object.keys(mock.createdPayloads[0]).sort()).toEqual(['destinations', 'profile', 'requestId', 'source']);
});

test('destination defaults render prompts only for choices the catalog cannot resolve', async ({ page }) => {
  const bModels = [
    { ...model('B-one'), connectionId: 'connection-b', connectionName: 'B connection' },
    { ...model('B-two'), connectionId: 'connection-b', connectionName: 'B connection' },
  ];
  const cConnections = [connection('C-one'), connection('C-two')];
  const cModels = [
    { ...model('C-one'), connectionId: 'connection-c-one', connectionName: 'C-one connection' },
    { ...model('C-two'), connectionId: 'connection-c-two', connectionName: 'C-two connection' },
  ];
  await seedActiveConnection(page);
  await installApiMocks(page, {
    connectionCatalogByInstance: { C: cConnections },
    modelCatalogByInstance: { B: bModels, C: cModels },
  });
  await openFlow(page);

  await page.getByRole('checkbox', { name: /Dashboard 001/ }).check();
  await page.getByRole('button', { name: 'Choose destinations', exact: true }).click();
  for (const destinationId of ['B', 'C', 'D']) {
    await page.getByRole('checkbox', { name: new RegExp(`Destination ${destinationId}`) }).check();
  }

  const destinationB = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination B' }) });
  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  const destinationD = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination D' }) });
  const reviewMove = page.getByRole('button', { name: 'Review move' });

  await expect(destinationB.getByText('B connection', { exact: true })).toBeVisible();
  await expect(destinationB.getByRole('combobox', { name: /Destination B destination \d+ connection/ })).toHaveCount(0);
  const destinationBModel = destinationB.getByRole('combobox', { name: 'Destination model for Destination B' });
  await expect(destinationBModel).toBeVisible();
  await expect(destinationB.getByText('Choice needed', { exact: true })).toBeVisible();

  const destinationCConnection = destinationC.getByRole('combobox', { name: /Destination C destination \d+ connection/ });
  await expect(destinationCConnection).toBeVisible();
  await expect(destinationC.getByRole('combobox', { name: 'Destination model for Destination C' })).toBeDisabled();
  await expect(destinationC.getByText('Choice needed', { exact: true })).toBeVisible();

  await expect(destinationD.getByText('D connection', { exact: true })).toBeVisible();
  await expect(destinationD.getByText('D connection - D shared model', { exact: true })).toBeVisible();
  await expect(destinationD.getByRole('combobox')).toHaveCount(0);
  await expect(destinationD.getByText('Ready', { exact: true })).toBeVisible();
  await expect(reviewMove).toBeDisabled();

  await destinationBModel.click();
  await page.getByRole('option', { name: /B-one shared model/ }).click();
  await expect(destinationB.getByRole('combobox')).toHaveCount(0);
  await expect(destinationB.getByText('Ready', { exact: true })).toBeVisible();
  await expect(reviewMove).toBeDisabled();

  await destinationCConnection.click();
  await page.getByRole('option', { name: /C-one connection/ }).click();
  await expect(destinationC.getByRole('combobox')).toHaveCount(0);
  await expect(destinationC.getByText('C-one connection - C-one shared model', { exact: true })).toBeVisible();
  await expect(destinationC.getByText('Ready', { exact: true })).toBeVisible();
  await expect(reviewMove).toBeEnabled();
});

test('full-success A→B completion exposes exactly one attested artifact and verified destination link', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: successfulJob(['B']) });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Move complete', exact: true })).toBeVisible();
  await expect(page.getByText(/Every destination passed content, query, and direct-access verification\./)).toBeVisible();
  const destinationB = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination B' }) });
  await expect(destinationB).toHaveCount(1);
  await expect(destinationB.getByText('Folder /Safe copies/B', { exact: true })).toBeVisible();
  await destinationB.getByText('Dashboard results (1)', { exact: true }).click();
  const results = destinationB.getByRole('list', { name: 'Dashboard progress for Destination B' });
  await expect(results.getByText('Copied as Dashboard 001 copy B', { exact: true })).toBeVisible();
  const links = results.getByRole('link');
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute('aria-label', 'Open Dashboard 001 copy B in Destination B');
  await expect(links).toHaveAttribute('href', 'https://b.example.test/dashboards/dashboard-001-copy-b');
  await expect(links).toHaveAttribute('target', '_blank');
  await expect(links).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByRole('button', { name: 'Retry destination' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start another move' })).toBeVisible();
});

test('full-success A→B,C,D completion exposes one exact verified artifact per destination', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: successfulJob(['B', 'C', 'D']) });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Move complete', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(3);
  for (const destinationId of ['B', 'C', 'D']) {
    const destination = page.getByRole('article').filter({
      has: page.getByRole('heading', { name: `Destination ${destinationId}` }),
    });
    const stages = destination.getByRole('list', { name: `Destination ${destinationId} move stages` }).locator('li');
    await expect(stages).toHaveCount(4);
    for (const stage of await stages.all()) await expect(stage).toContainText('Complete');

    await destination.getByText('Dashboard results (1)', { exact: true }).click();
    const results = destination.getByRole('list', { name: `Dashboard progress for Destination ${destinationId}` });
    await expect(results.getByText(`Copied as Dashboard 001 copy ${destinationId}`, { exact: true })).toBeVisible();
    const verifiedLink = results.getByRole('link', {
      name: `Open Dashboard 001 copy ${destinationId} in Destination ${destinationId}`,
    });
    await expect(verifiedLink).toHaveCount(1);
    await expect(verifiedLink).toHaveAttribute(
      'href',
      `https://${destinationId.toLowerCase()}.example.test/dashboards/dashboard-001-copy-${destinationId.toLowerCase()}`,
    );
  }
  await expect(page.getByRole('button', { name: 'Retry destination' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start another move' })).toBeVisible();
});

test('Screen 3 projects exact per-dashboard proof with isolated B, C, and D stages and verified links', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: mixedScreen3Job() });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Move & track', exact: true })).toBeFocused();
  const targets = Object.fromEntries(['B', 'C', 'D'].map((targetId) => [
    targetId,
    page.getByRole('article').filter({ has: page.getByRole('heading', { name: `Destination ${targetId}` }) }),
  ]));

  for (const [targetId, expectedStage] of [['B', 'Complete'], ['C', 'Verify'], ['D', 'Copy']] as const) {
    const stages = targets[targetId].getByRole('list', { name: `Destination ${targetId} move stages` });
    await expect(stages.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(stages.locator('[aria-current="step"]')).toContainText(expectedStage);
  }

  await targets.B.getByText('Dashboard results (1)', { exact: true }).click();
  const bProgress = targets.B.getByRole('list', { name: 'Dashboard progress for Destination B' });
  await expect(bProgress.getByText('Complete', { exact: true })).toBeVisible();
  const verifiedLink = bProgress.getByRole('link', { name: 'Open Dashboard 001 copy B in Destination B' });
  await expect(verifiedLink).toHaveAttribute('href', 'https://b.example.test/dashboards/dashboard-001-copy-b');
  await expect(verifiedLink).toHaveAttribute('target', '_blank');
  await expect(verifiedLink).toHaveAttribute('rel', 'noopener noreferrer');

  await targets.C.getByText('Dashboard results (1)', { exact: true }).click();
  await expect(targets.C.getByRole('list', { name: 'Dashboard progress for Destination C' }).getByText('Verifying', { exact: true })).toBeVisible();
  await expect(targets.C.getByRole('link')).toHaveCount(0);

  await targets.D.getByText('Dashboard results (1)', { exact: true }).click();
  await expect(targets.D.getByRole('list', { name: 'Dashboard progress for Destination D' }).getByText('Reconciliation required', { exact: true })).toBeVisible();
  await expect(targets.D.getByRole('link')).toHaveCount(0);

  await expect(page.getByText(/omni_browsersecret|omni_jobsecret|owner@example\.test|raw dashboard yaml|raw job prose|do-not-render/i)).toHaveCount(0);
});

test('a mismatched revision-bound attestation never authorizes a destination link or Complete state', async ({ page }) => {
  const tampered = mixedScreen3Job();
  const evidence = tampered.details?.safeCopyClientEvidence as Record<string, unknown>;
  evidence.evidenceRevision = Number(tampered.details?.safeCopyEvidenceRevision) + 1;
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: tampered });
  await openFlow(page);

  const destinationB = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination B' }) });
  await expect(destinationB.getByRole('list', { name: 'Destination B move stages' }).locator('[aria-current="step"]')).not.toContainText('Complete');
  await destinationB.getByText('Dashboard results (1)', { exact: true }).click();
  await expect(destinationB.getByRole('link')).toHaveCount(0);
  await expect(destinationB.getByRole('list', { name: 'Dashboard progress for Destination B' }).getByText('Needs attention', { exact: true })).toBeVisible();
});

test('an accepted create whose response is lost is recovered by its exact request identity after reload', async ({ page }) => {
  await seedActiveConnection(page);
  const mock = await installApiMocks(page, { createFirstResponseLost: true });
  await openFlow(page);
  await chooseDashboardsAndDestinations(page, ['B']);
  await page.getByRole('button', { name: 'Move dashboards' }).click();
  await expect(page.getByRole('alert')).toContainText('response was lost');
  await expect.poll(() => mock.createdPayloads.length).toBe(1);

  await page.reload();
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.getByRole('heading', { name: 'Move & track', exact: true })).toBeFocused();
  const stored = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}'), DRAFT_KEY);
  expect(stored.requestId).toBe(mock.createdPayloads[0].requestId);
  expect(stored.jobId).toBe(JOB_ID);
});

test('multiple server jobs matching one request identity never attach during reload recovery', async ({ page }) => {
  const payload: SafeCopyPayload = {
    profile: 'safe_copy_v1',
    requestId: REQUEST_ID,
    source: { instanceId: 'A', connectionId: 'connection-a', documentIds: ['dashboard-001'] },
    destinations: [{
      targetId: 'B',
      instanceId: 'B',
      connectionId: 'connection-b',
      modelId: 'model-b',
      folderPath: '/Safe copies/B',
    }],
  };
  const first = safeCopyJob(payload);
  const second = { ...safeCopyJob(payload), id: '33333333-3333-4333-8333-333333333333' };
  await seedActiveConnection(page, { requestId: REQUEST_ID });
  await installApiMocks(page, { recoveryJobs: [first, second] });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Choose dashboards', exact: true })).toBeFocused();
  await expect(page.getByText(JOB_ID, { exact: false })).toHaveCount(0);
  const stored = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}'), DRAFT_KEY);
  expect(stored.jobId).toBeUndefined();
});

test('a malformed create-job identifier is rejected and never attached to browser recovery state', async ({ page }) => {
  await seedActiveConnection(page);
  await installApiMocks(page, { createJobId: 'malformed-job-id' });
  await openFlow(page);
  await chooseDashboardsAndDestinations(page, ['B']);
  await page.getByRole('button', { name: 'Move dashboards' }).click();

  await expect(page.getByRole('alert')).toContainText('did not match this safe dashboard move');
  await expect(page.getByRole('button', { name: 'Move dashboards' })).toBeVisible();
  const stored = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}'), DRAFT_KEY);
  expect(stored.jobId).toBeUndefined();
});

test('a cross-workflow or wrong-request restored job fails closed to Screen 1', async ({ page }) => {
  const wrongJob = partialJob();
  wrongJob.workflow = 'model';
  wrongJob.details.safeCopyRequestId = '33333333-3333-4333-8333-333333333333';
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: wrongJob });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Choose dashboards', exact: true })).toBeFocused();
  const storedAfterMismatch = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}'), DRAFT_KEY);
  expect(storedAfterMismatch.jobId).toBeUndefined();
  expect(storedAfterMismatch.requestId).not.toBe(REQUEST_ID);
});

test('a missing restored job clears its identity and returns to Screen 1', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { missingRestoredJob: true });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Choose dashboards', exact: true })).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('no longer exists');
  const stored = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}'), DRAFT_KEY);
  expect(stored.jobId).toBeUndefined();
  expect(stored.requestId).not.toBe(REQUEST_ID);
});

test('partial completion retries only the failed target once and keeps exception codes collapsed', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  const mock = await installApiMocks(page, { restoredJob: partialJob() });
  await openFlow(page);

  await expect(page.getByText('Destination B', { exact: true })).toBeVisible();
  await expect(page.getByText('Destination C', { exact: true })).toBeVisible();
  await expect(page.getByText('Destination D', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry destination' })).toHaveCount(1);
  await expect(page.getByText('SEMANTIC_CHANGE_UNSAFE', { exact: true })).not.toBeVisible();
  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  await destinationC.getByText('Technical details', { exact: true }).click();
  await expect(page.getByText('SEMANTIC_CHANGE_UNSAFE', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Retry destination' }).dblclick();
  await expect.poll(() => mock.retriedTargets.length).toBe(1);
  expect(mock.retriedTargets[0]).toMatchObject({ jobId: JOB_ID, targetId: 'C' });

  await page.getByRole('button', { name: 'Choose another model' }).click();
  await expect(page.getByRole('heading', { name: 'Choose destinations', exact: true })).toBeFocused();
  await expect(page.getByRole('checkbox', { name: /Destination B/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Destination C/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Destination D/ })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Destination model for Destination C' })).toBeVisible();
});

test('reconciliation-required evidence cannot escape through model replanning or Model Migrator', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: reconciliationJob() });
  await openFlow(page);

  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  const destinationB = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination B' }) });
  const destinationD = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination D' }) });
  await expect(destinationB.getByText('Complete', { exact: true }).first()).toBeVisible();
  await expect(destinationD.getByText('Complete', { exact: true }).first()).toBeVisible();
  await expect(destinationB.getByRole('button', { name: 'Retry destination' })).toHaveCount(0);
  await expect(destinationD.getByRole('button', { name: 'Retry destination' })).toHaveCount(0);
  await expect(destinationC.getByText('Reconciliation required', { exact: true })).toBeVisible();
  await expect(destinationC.getByRole('button', { name: 'Retry destination' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry destination' })).toHaveCount(1);
  await expect(destinationC.getByRole('button', { name: 'Choose another model' })).toHaveCount(0);
  await expect(destinationC.getByRole('button', { name: 'Open Model Migrator' })).toHaveCount(0);
});

test('Model Migrator consumes the exact actionable safe-copy target scope', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: partialJob() });
  await openFlow(page);

  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  await destinationC.getByRole('button', { name: 'Open Model Migrator' }).click();
  await expect(page).toHaveURL('/models/migrate');
  await expect(page.getByRole('heading', { name: 'Model Migrator', exact: true })).toBeVisible();
  await expect(page.getByText('Loaded the failed dashboard target as a non-destructive Model Migrator planning scope.', { exact: false })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Source instance', exact: true })).toHaveValue('A');
  await expect(page.getByRole('combobox', { name: 'Source connection', exact: true })).toHaveValue('connection-a');
  await expect(page.getByRole('combobox', { name: 'Target instance', exact: true })).toHaveValue('C');
  await expect(page.getByRole('combobox', { name: 'Target connection', exact: true })).toHaveValue('connection-c');

  await page.getByRole('button', { name: /A shared model/ }).click();
  const targetSection = page.locator('section').filter({ hasText: 'Match each source model to the destination model' });
  await expect(targetSection.locator('select').nth(2)).toHaveValue('model-c');
});

test('a stale handoff target model fails closed instead of silently choosing another model', async ({ page }) => {
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, {
    restoredJob: partialJob(),
    modelCatalogByInstance: { C: [] },
  });
  await openFlow(page);

  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  await destinationC.getByRole('button', { name: 'Open Model Migrator' }).click();
  await expect(page).toHaveURL('/models/migrate');
  await expect(page.getByRole('alert')).toContainText('target model is no longer available on its expected connection');
  await page.getByRole('button', { name: /A shared model/ }).click();
  const targetSection = page.locator('section').filter({ hasText: 'Match each source model to the destination model' });
  await expect(targetSection.locator('select').nth(2)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Stage and validate migration' })).toBeDisabled();
});

test('a later human instance choice wins over a delayed safe-copy handoff read', async ({ page }) => {
  let releaseJobRead!: () => void;
  const jobReadGate = new Promise<void>((resolve) => { releaseJobRead = resolve; });
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  const mock = await installApiMocks(page, { restoredJob: partialJob(), handoffJobReadGate: jobReadGate });
  await openFlow(page);

  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  await expect(destinationC.getByRole('button', { name: 'Open Model Migrator' })).toBeVisible();
  const initialJobReadCount = mock.getJobReadCount();
  mock.armHandoffJobReadGate();
  await destinationC.getByRole('button', { name: 'Open Model Migrator' }).click();
  await expect(page).toHaveURL('/models/migrate');
  await expect.poll(() => mock.getJobReadCount()).toBeGreaterThan(initialJobReadCount);

  const sourceInstance = page.getByRole('combobox', { name: 'Source instance', exact: true });
  const targetInstance = page.getByRole('combobox', { name: 'Target instance', exact: true });
  await sourceInstance.selectOption('X');
  await targetInstance.selectOption('D');
  releaseJobRead();

  await page.waitForTimeout(200);
  await expect(sourceInstance).toHaveValue('X');
  await expect(targetInstance).toHaveValue('D');
  await expect(page.getByText('Loaded the failed dashboard target as a non-destructive Model Migrator planning scope.', { exact: false })).toHaveCount(0);
});

test('passive stream refresh cannot reopen terminal progress even when a nonterminal snapshot has a newer clock', async ({ page }) => {
  const terminal = attestJob({ ...partialJob(), endedAt: 20 }, { evidenceRevision: 3 });
  const initial = attestJob({
    ...partialJob(),
    details: { ...partialJob().details },
    status: 'running' as const,
    endedAt: undefined,
    items: [],
  }, {
    evidenceRevision: 2,
    validatedAttemptIds: [],
    verifiedDocuments: [],
  });
  const passiveNonterminal = attestJob({
    ...initial,
    details: { ...initial.details },
    items: [attemptItem('C', 'dispatched', { updatedAt: 30 })],
  }, { evidenceRevision: 4 });
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: initial, streamJobs: [initial, terminal, passiveNonterminal] });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Completed with exceptions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start another move' })).toBeVisible();
  await expect(page.getByText('Copying and verifying', { exact: true })).toHaveCount(0);
});

test('an explicit validated target retry may transition terminal progress back to active', async ({ page }) => {
  const running = attestJob({
    ...partialJob(),
    details: { ...partialJob().details },
    status: 'running' as const,
    endedAt: undefined,
    items: [attemptItem('C', 'dispatched', { updatedAt: 30 })],
  }, { evidenceRevision: 3 });
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  const mock = await installApiMocks(page, { restoredJob: partialJob(), retryResponseJob: running });
  await openFlow(page);

  await page.getByRole('button', { name: 'Retry destination' }).click();
  await expect.poll(() => mock.retriedTargets.length).toBe(1);
  await expect(page.getByText('Copying and verifying', { exact: true }).first()).toBeVisible();
});

test('Screen 3 announces one semantic progress transition and deduplicates an identical live event', async ({ page }) => {
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
  const copying = mixedScreen3Job();
  copying.items = copying.items.map((item) => item.id === 'safe-copy-attempt:attempt-c'
    ? attemptItem('C', 'dispatched', { updatedAt: VERIFIED_AT + 100 })
    : item);
  attestJob(copying, { evidenceRevision: 4 });
  const verifying = attestJob(mixedScreen3Job(), { evidenceRevision: 5 });

  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, {
    restoredJob: copying,
    streamJobs: [copying, verifying, structuredClone(verifying)],
    streamGate,
  });
  await openFlow(page);

  const destinationC = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination C' }) });
  await destinationC.getByText('Dashboard results (1)', { exact: true }).click();
  await expect(destinationC.getByRole('list', { name: 'Dashboard progress for Destination C' }).getByText('Copying', { exact: true })).toBeVisible();
  const liveRegion = page.locator(
    'section[aria-labelledby="safe-copy-track-heading"] > p[role="status"][aria-live="polite"][aria-atomic="true"]',
  );
  await expect(liveRegion).toHaveCount(1);
  await page.evaluate(() => {
    const region = document.querySelector(
      'section[aria-labelledby="safe-copy-track-heading"] > p[role="status"][aria-live="polite"][aria-atomic="true"]',
    );
    if (!region) throw new Error('Safe-copy progress live region was not rendered.');
    const observed: string[] = [];
    (window as typeof window & { __safeCopyAnnouncements?: string[] }).__safeCopyAnnouncements = observed;
    new MutationObserver(() => {
      const value = region.textContent?.trim() || '';
      if (value) observed.push(value);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });

  releaseStream();
  await expect(liveRegion).toContainText('Destination C: Verifying dashboards.');
  await expect(liveRegion).toContainText('Destination C, dashboard Dashboard 001 copy C: Verifying.');
  await page.waitForTimeout(100);
  const announcements = await page.evaluate(() => (
    (window as typeof window & { __safeCopyAnnouncements?: string[] }).__safeCopyAnnouncements || []
  ));
  expect(announcements).toHaveLength(1);
  expect(announcements[0]).toContain('Destination C: Verifying dashboards.');
});

test('Screen 3 fits 320px and reduced motion disables the active reconciliation spinner', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedActiveConnection(page, { requestId: REQUEST_ID, jobId: JOB_ID });
  await installApiMocks(page, { restoredJob: mixedScreen3Job(), retryDelayMs: 500 });
  await openFlow(page);

  await expect(page.getByRole('heading', { name: 'Move & track', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const destinationB = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination B' }) });
  await destinationB.getByText('Dashboard results (1)', { exact: true }).click();
  await expect(destinationB.getByRole('link', { name: 'Open Dashboard 001 copy B in Destination B' })).toBeVisible();

  const destinationD = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Destination D' }) });
  const technicalDetails = destinationD.getByText('Technical details', { exact: true });
  if (await technicalDetails.count()) await technicalDetails.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await destinationD.getByRole('button', { name: 'Retry destination' }).click();
  const reconciling = destinationD.getByRole('button', { name: 'Reconciling...' });
  await expect(reconciling).toBeVisible();
  await expect(reconciling.locator('svg')).toHaveCount(1);
  expect(await reconciling.locator('svg').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
