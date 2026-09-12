import { jsonHeaders, sseHeaders } from '../security';
import { previewDashboardTopicRepair, approveDashboardTopicRepair } from '../services/dashboardTopicRepair';
import { createDashboardDeploymentPlan, getDashboardDeploymentPlan, recheckDashboardDeploymentPlan, deployDashboardDeploymentPlan, linkDashboardModelRepair, updateDashboardDeploymentPlan } from '../services/dashboardDeploymentPlans';
import { createDashboardReadinessContext, dashboardReadinessStream, type DashboardReadinessRunContext } from '../services/dashboardReadinessControl';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import {
  adjudicateDestinationModelMutation,
  buildMigrationPlan,
  cancelMigrationJob,
  clearJobs,
  createMigrationJob,
  DestinationModelMutationAdjudicationError,
  type DestinationModelMutationAdjudicationInput,
  type DashboardMigrationJobInput,
  getJob,
  listJobs,
  type MigrationPermissionDecision,
  type MigrationJob,
  retryMigrationJob,
  runPostMigrationAction,
  validateDashboardMigrationPatches,
  type MigrationRouteGroup,
  type MigrationSemanticDependencyNode,
  type MigrationSemanticPatchSafetyCategory,
  type MigrationTarget,
} from '../services/migrationJobs';
import { subscribeMigrationJobEvents } from '../services/jobEvents';
import { listJobs as listStoredJobs } from '../services/jobStore';
import {
  isVaultUnlocked,
  type PostMigrationAction,
} from '../services/nativeVault';
import { redactSensitiveText } from '../services/jobSanitizer';
import { migrationJobHasUnresolvedDestinationModelMutation } from '../services/migrationScopeReservation';
import { createPerformanceTracker } from '../services/performanceTimings';
import {
  DashboardSafeCopyError,
  isDashboardSafeCopyError,
  parseDashboardSafeCopyIntent,
} from '../../shared/dashboardSafeCopyContract';
import {
  cancelDashboardSafeCopyJob,
  createDashboardSafeCopyJob,
  dashboardSafeCopyJobHasActiveOrUncertainEvidence,
  isDashboardSafeCopyJob,
  type DashboardSafeCopyPreparationRunner,
} from '../services/dashboardSafeCopyJobs';
import {
  prepareAndRunDashboardSafeCopyJob,
  retryDashboardSafeCopyJobTarget,
  type DashboardSafeCopyRuntimeResult,
  withDashboardSafeCopyClientEvidence,
} from '../services/dashboardSafeCopyRuntime';
import {
  isDashboardSafeCopyV1Enabled,
  isLegacyDashboardMigratorInternalEnabled,
} from '../services/dashboardMigrationFeatureFlags';

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'partial', 'failed', 'canceled']);
const SAFE_COPY_RETRY_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function safeCopyBodyJson(req: Request): Promise<unknown> {
  try {
    return await req.json() as unknown;
  } catch {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_BODY', 'Safe-copy request body must be valid JSON.');
  }
}

function parseSafeCopyRetryRequest(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_BODY', 'Safe-copy retry body must be a JSON object.');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'requestId')) {
    throw new DashboardSafeCopyError('SAFE_COPY_UNKNOWN_FIELD', 'Safe-copy retry contains an unsupported field.');
  }
  const requestId = cleanString(body.requestId)?.toLowerCase();
  if (!requestId || !SAFE_COPY_RETRY_REQUEST_ID.test(requestId)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_REQUEST_ID', 'Safe-copy retry requestId must be a canonical UUID.');
  }
  return requestId;
}

function parseMutationAdjudication(value: unknown): DestinationModelMutationAdjudicationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_INVALID',
      'Mutation adjudication body must be a JSON object.',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    'requestId',
    'itemId',
    'expectedRevision',
    'expectedUpdatedAt',
    'destinationInstanceId',
    'targetModelId',
    'operation',
    'dispatchItemId',
    'dispatchItemKind',
    'dispatchFingerprint',
    'outcome',
    'evidenceSource',
    'note',
    'confirmCurrentStateInspected',
    'confirmNoOperationInFlight',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new DestinationModelMutationAdjudicationError(
      'MIGRATION_MUTATION_ADJUDICATION_INVALID',
      'Mutation adjudication contains an unsupported field.',
      400,
    );
  }
  return {
    requestId: (cleanString(body.requestId) || '').toLowerCase(),
    itemId: cleanString(body.itemId) || '',
    expectedRevision: body.expectedRevision as number,
    expectedUpdatedAt: body.expectedUpdatedAt as number,
    destinationInstanceId: cleanString(body.destinationInstanceId) || '',
    targetModelId: cleanString(body.targetModelId) || '',
    operation: cleanString(body.operation) || '',
    dispatchItemId: cleanString(body.dispatchItemId) || '',
    dispatchItemKind: cleanString(body.dispatchItemKind) || '',
    dispatchFingerprint: cleanString(body.dispatchFingerprint) || '',
    outcome: body.outcome as DestinationModelMutationAdjudicationInput['outcome'],
    evidenceSource: body.evidenceSource as DestinationModelMutationAdjudicationInput['evidenceSource'],
    note: cleanString(body.note) || '',
    confirmCurrentStateInspected: body.confirmCurrentStateInspected as true,
    confirmNoOperationInFlight: body.confirmNoOperationInFlight as true,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function clientJob(job: MigrationJob): MigrationJob {
  return withDashboardSafeCopyClientEvidence(job);
}

function safeCopyHistoryIdentity(job: MigrationJob): MigrationJob {
  if (!isDashboardSafeCopyJob(job)) return job;
  return {
    id: job.id,
    workflow: 'dashboard',
    sourceId: '',
    sourceLabel: 'Dashboard move',
    destinationIds: [],
    documentIds: [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: job.status,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.endedAt ? { endedAt: job.endedAt } : {}),
    details: {
      safeCopyProfile: 'safe_copy_v1',
      operationMode: 'safe_copy',
      safeCopyRequestId: job.details?.safeCopyRequestId,
      safeCopyEvidenceRevision: job.details?.safeCopyEvidenceRevision,
    },
    items: [],
  };
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseSemanticSafetyCategory(value: unknown): MigrationSemanticPatchSafetyCategory | undefined {
  return value === 'safe_ignore'
    || value === 'safe_map'
    || value === 'safe_create'
    || value === 'safe_update'
    || value === 'destructive_update'
    || value === 'blocked'
    ? value
    : value === 'manual_review'
      ? 'manual_review'
      : undefined;
}

function parseSemanticDependencyPath(value: unknown): MigrationSemanticDependencyNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes = value
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && !Array.isArray(node))
    .map((node) => {
      const kind = node.kind === 'dashboard'
        || node.kind === 'permission'
        || node.kind === 'topic'
        || node.kind === 'query_view'
        || node.kind === 'model_field'
        || node.kind === 'relationship'
        || node.kind === 'model_file'
        ? node.kind
        : undefined;
	      const label = cleanString(node.label);
	      if (!kind || !label) return null;
	      const next: MigrationSemanticDependencyNode = { kind, label };
	      const ref = cleanString(node.ref);
	      const detail = cleanString(node.detail);
	      if (ref) next.ref = ref;
	      if (detail) next.detail = detail;
	      return next;
	    })
    .filter((node): node is MigrationSemanticDependencyNode => Boolean(node));
  return nodes.length > 0 ? nodes : undefined;
}

function parseMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function parseActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      kind: action.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
      name: cleanString(action.name) || 'Post-migration action',
      method: parseMethod(action.method),
      url: cleanString(action.url) || '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
      destinationInstanceId: cleanString(action.destinationInstanceId),
      targetModelId: cleanString(action.targetModelId),
      targetModelName: cleanString(action.targetModelName),
    }))
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.targetModelId) : Boolean(action.url));
}

function parseTopicMappings(value: unknown): MigrationTarget['topicMappings'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => {
      const action = mapping.action === 'copy_source' ? 'copy_source' as const : 'map_existing' as const;
      return {
        sourceTopicName: cleanString(mapping.sourceTopicName) || '',
        sourceTopicId: cleanString(mapping.sourceTopicId),
        action,
        targetTopicName: cleanString(mapping.targetTopicName) || '',
        targetTopicLabel: cleanString(mapping.targetTopicLabel),
      };
    })
    .filter((mapping) => mapping.sourceTopicName && mapping.targetTopicName);
}

function parseQueryViewMappings(value: unknown): MigrationTarget['queryViewMappings'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => {
      const action = mapping.action === 'copy_source'
        ? 'copy_source' as const
        : mapping.action === 'use_existing_unverified'
          ? 'use_existing_unverified' as const
          : mapping.action === 'update_existing'
            ? 'update_existing' as const
            : 'map_existing' as const;
      return {
        sourceQueryViewName: cleanString(mapping.sourceQueryViewName) || '',
        sourceFileName: cleanString(mapping.sourceFileName),
        action,
        targetQueryViewName: cleanString(mapping.targetQueryViewName) || '',
        targetFileName: cleanString(mapping.targetFileName),
        targetQueryViewLabel: cleanString(mapping.targetQueryViewLabel),
      };
    })
    .filter((mapping) => mapping.sourceQueryViewName && mapping.targetQueryViewName);
}

function parseFieldMappings(value: unknown): MigrationTarget['fieldMappings'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => {
      const action = mapping.action === 'create_from_source'
        ? 'create_from_source' as const
        : mapping.action === 'ignore'
          ? 'ignore' as const
          : 'map_existing' as const;
      return {
        sourceFieldRef: cleanString(mapping.sourceFieldRef) || '',
        action,
        targetFieldRef: cleanString(mapping.targetFieldRef),
        sourceFileName: cleanString(mapping.sourceFileName),
        targetFileName: cleanString(mapping.targetFileName),
      };
    })
    .filter((mapping) => mapping.sourceFieldRef);
}

function parsePermissionDecisions(value: unknown): MigrationPermissionDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((decision): decision is Record<string, unknown> => Boolean(decision) && typeof decision === 'object' && !Array.isArray(decision))
    .map((decision): MigrationPermissionDecision => {
      const action = decision.action === 'map_existing'
        || decision.action === 'create_from_source'
        || decision.action === 'preserve_target'
        || decision.action === 'ignore_with_waiver'
        || decision.action === 'manual_prerequisite'
        ? decision.action
        : 'manual_prerequisite';
      return {
        dependencyId: cleanString(decision.dependencyId) || '',
        action,
        targetRef: cleanString(decision.targetRef),
        waiverReason: cleanString(decision.waiverReason),
        confirmed: decision.confirmed === true,
      };
    })
    .filter((decision) => decision.dependencyId);
}

function parseSemanticPatches(value: unknown): MigrationTarget['semanticPatches'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((patch): patch is Record<string, unknown> => Boolean(patch) && typeof patch === 'object' && !Array.isArray(patch))
    .map((patch) => {
      const artifactType = patch.artifactType === 'query_view'
        ? 'query_view' as const
        : patch.artifactType === 'topic'
          ? 'topic' as const
          : patch.artifactType === 'relationship'
            ? 'relationship' as const
            : patch.artifactType === 'permission'
              ? 'permission' as const
              : 'field' as const;
      const resolution = patch.resolution === 'custom_edit'
        ? 'custom_edit' as const
        : patch.resolution === 'keep_target'
          ? 'keep_target' as const
          : patch.resolution === 'use_source'
            ? 'use_source' as const
            : 'recommended' as const;
      return {
        id: cleanString(patch.id) || '',
        artifactType,
        sourceName: cleanString(patch.sourceName),
        sourceFileName: cleanString(patch.sourceFileName),
        targetFileName: cleanString(patch.targetFileName) || '',
        targetModelId: cleanString(patch.targetModelId),
        acceptedYaml: rawString(patch.acceptedYaml),
        recommendedYaml: rawString(patch.recommendedYaml),
        previousChecksum: cleanString(patch.previousChecksum),
        resolution,
        destructive: patch.destructive === true,
        confirmedDestructive: patch.confirmedDestructive === true,
        status: patch.status === 'blocked' ? 'blocked' as const : patch.status === 'warning' ? 'warning' as const : patch.status === 'ready' ? 'ready' as const : undefined,
        safetyCategory: parseSemanticSafetyCategory(patch.safetyCategory),
        recommendedAction: cleanString(patch.recommendedAction),
        dependencyPath: parseSemanticDependencyPath(patch.dependencyPath),
        warnings: parseStringArray(patch.warnings),
      };
    })
    .filter((patch) => patch.id && patch.targetFileName && (patch.resolution === 'keep_target' || Boolean(patch.acceptedYaml)));
}

function parseTargets(value: unknown): MigrationTarget[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((target): target is Record<string, unknown> => Boolean(target) && typeof target === 'object' && !Array.isArray(target))
    .map((target, index) => {
      const destinationInstanceId = cleanString(target.destinationInstanceId) || cleanString(target.destinationId) || '';
      const targetModelId = cleanString(target.targetModelId) || '';
      return {
        id: cleanString(target.id) || `${destinationInstanceId}:${targetModelId}:${index}`,
        destinationInstanceId,
        destinationLabel: cleanString(target.destinationLabel),
        targetConnectionId: cleanString(target.targetConnectionId),
        targetModelId,
        targetModelName: cleanString(target.targetModelName),
        targetFolderId: cleanString(target.targetFolderId),
        targetFolderPath: cleanString(target.targetFolderPath),
        sameNamedStrategy: target.sameNamedStrategy === 'replace' ? 'replace' as const : 'update' as const,
        topicMappings: parseTopicMappings(target.topicMappings),
        queryViewMappings: parseQueryViewMappings(target.queryViewMappings),
        fieldMappings: parseFieldMappings(target.fieldMappings),
        permissionDecisions: parsePermissionDecisions(target.permissionDecisions),
        semanticPatches: parseSemanticPatches(target.semanticPatches),
      };
    })
    .filter((target) => target.destinationInstanceId);
}

function parseRouteGroups(value: unknown): MigrationRouteGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((group): group is Record<string, unknown> => Boolean(group) && typeof group === 'object' && !Array.isArray(group))
    .map((group, index) => ({
      id: cleanString(group.id) || `route-group-${index + 1}`,
      name: cleanString(group.name) || `Route group ${index + 1}`,
      documentIds: parseStringArray(group.documentIds),
      targets: parseTargets(group.targets),
    }))
    .filter((group) => group.documentIds.length > 0 && group.targets.length > 0);
}

function parseSourceDocumentHints(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((document): document is Record<string, unknown> => Boolean(document) && typeof document === 'object' && !Array.isArray(document))
    .map((document) => ({
      id: cleanString(document.id) || '',
      identifier: cleanString(document.identifier) || cleanString(document.id) || '',
      name: cleanString(document.name) || '',
      connectionId: cleanString(document.connectionId),
      folderId: cleanString(document.folderId),
      folderPath: cleanString(document.folderPath),
      baseModelId: cleanString(document.baseModelId),
      baseModelName: cleanString(document.baseModelName),
      topicNames: parseStringArray(document.topicNames),
      topicIds: parseStringArray(document.topicIds),
      description: cleanString(document.description) || null,
      labels: parseStringArray(document.labels),
      updatedAt: cleanString(document.updatedAt),
    }))
    .filter((document) => document.identifier && document.name);
}

function parseJobInput(body: Record<string, unknown>): DashboardMigrationJobInput {
  const targets = parseTargets(body.targets);
  return {
    sourceId: cleanString(body.sourceId) || '',
    sourceConnectionId: cleanString(body.sourceConnectionId),
    destinationIds: parseStringArray(body.destinationIds),
    targets,
    routeGroups: parseRouteGroups(body.routeGroups),
    documentIds: parseStringArray(body.documentIds),
    sourceDocumentHints: parseSourceDocumentHints(body.sourceDocumentHints),
    emptyFirst: body.emptyFirst === true,
    replaceSameNamed: body.replaceSameNamed !== false,
    deleteSourceOnSuccess: body.deleteSourceOnSuccess === true,
    sourceFolderId: cleanString(body.sourceFolderId),
    sourceFolderPath: cleanString(body.sourceFolderPath),
    sourceAllFolders: body.sourceAllFolders === true,
    postMigrationActions: parseActions(body.postMigrationActions),
  };
}

function parseOptionalRetryInput(value: unknown): DashboardMigrationJobInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return parseJobInput(value as Record<string, unknown>);
}

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jobEventsResponse(jobId: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        controller.close();
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEncode(event, data)));
      };
      const keepalive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 15_000);

      const buffered: Parameters<Parameters<typeof subscribeMigrationJobEvents>[1]>[0][] = [];
      let snapshotSent = false;
      const deliver = (event: (typeof buffered)[number]) => {
        send(event.type, event.type === 'job' && event.job
          ? { ...event, job: clientJob(event.job) }
          : event);
        if (event.type === 'job' && TERMINAL_JOB_STATUSES.has(event.status)) {
          setTimeout(close, 250);
        }
      };
      unsubscribe = subscribeMigrationJobEvents(jobId, (event) => {
        if (!snapshotSent) {
          buffered.push(event);
          return;
        }
        deliver(event);
      });
      signal.addEventListener('abort', close, { once: true });

      const snapshot = getJob(jobId);
      if (!snapshot) {
        send('error', { error: 'Job not found.' });
        close();
        return;
      }
      send('snapshot', { job: clientJob(snapshot) });
      snapshotSent = true;
      for (const event of buffered) deliver(event);
      if (TERMINAL_JOB_STATUSES.has(snapshot.status)) {
        close();
        return;
      }
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

export interface MigrationJobsHandlerDependencies {
  safeCopyPreparation?: DashboardSafeCopyPreparationRunner | null;
  safeCopyRetry?: (
    jobId: string,
    targetId: string,
    retryRequestId: string,
  ) => Promise<DashboardSafeCopyRuntimeResult>;
}

export async function migrationJobsHandler(
  req: Request,
  dependencies: MigrationJobsHandlerDependencies = {},
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/migration-jobs\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (parts[0] === 'deployment-plans') {
      const locked = requireUnlocked();
      if (locked) return locked;
      if (!isDashboardSafeCopyV1Enabled()) return json({ error: 'Dashboard deployment is not enabled.' }, 404);
      const id = parts[1];
      const readinessResponse = async (work: (run: DashboardReadinessRunContext) => Promise<DashboardDeploymentPlan>) => {
        if (url.searchParams.get('stream') === '1') return dashboardReadinessStream(req.signal, work);
        const run = createDashboardReadinessContext({ signal: req.signal });
        try {
          const plan = await work(run);
          run.throwIfAborted();
          return json({ plan });
        }
        finally { run.dispose(); }
      };
      if (req.method === 'POST' && parts.length === 1) {
        const body = await safeCopyBodyJson(req);
        return await readinessResponse((run) => createDashboardDeploymentPlan(body, run));
      }
      if (req.method === 'GET' && parts.length === 2) return json({ plan: getDashboardDeploymentPlan(id) });
      if (req.method === 'PATCH' && parts.length === 2) return json({ plan: await updateDashboardDeploymentPlan(id, await safeCopyBodyJson(req)) });
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'recheck') {
        return await readinessResponse((run) => recheckDashboardDeploymentPlan(id, run));
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'deploy') {
        const body = await bodyJson(req);
        const result = await deployDashboardDeploymentPlan(id, {
          revision: Number(body.revision), targetIds: body.targetIds as string[], requestId: String(body.requestId || ''),
        }, dependencies.safeCopyPreparation === undefined ? prepareAndRunDashboardSafeCopyJob : dependencies.safeCopyPreparation, req.signal);
        return json({ ...result, job: clientJob(result.job) });
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'repair') {
        const body = await bodyJson(req);
        return json({ plan: linkDashboardModelRepair(id, String(body.targetId || ''), String(body.jobId || '')) });
      }
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'topic-repair') {
        const body = await safeCopyBodyJson(req);
        if (parts[3] === 'preview') return json(await previewDashboardTopicRepair(id, body, req.signal));
        if (parts[3] === 'approve') {
          const { plan, job } = await approveDashboardTopicRepair(id, body);
          return json({ plan, job });
        }
      }
      return json({ error: 'Unknown deployment plan route.' }, 404);
    }

    if (req.method === 'GET' && parts.length === 0) {
      // History recovery needs identity only; exact UI proof is derived on the
      // detail/SSE surfaces to avoid revalidating every large ledger at once.
      return json({ jobs: listJobs().map(safeCopyHistoryIdentity) });
    }

    if (req.method === 'DELETE' && parts.length === 0) {
      const locked = requireUnlocked();
      if (locked) return locked;
      const storedJobs = listStoredJobs(Number.MAX_SAFE_INTEGER);
      if (storedJobs.some(dashboardSafeCopyJobHasActiveOrUncertainEvidence)) {
        return json({
          error: 'Safe-copy history cannot be cleared while a destination is active or awaiting reconciliation.',
          code: 'SAFE_COPY_LEDGER_ACTIVE',
        }, 409);
      }
      if (storedJobs.some(migrationJobHasUnresolvedDestinationModelMutation)) {
        return json({
          error: 'Migration history cannot be cleared while a destination model is active or awaiting reconciliation.',
          code: 'MIGRATION_LEDGER_ACTIVE',
        }, 409);
      }
      clearJobs();
      return json({ ok: true });
    }

    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'events') {
      const job = getJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return jobEventsResponse(parts[0], req.signal);
    }

    if (req.method === 'GET' && parts.length === 1) {
      const job = getJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return json({ job: clientJob(job) });
    }

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'cancel') {
      const existing = getJob(parts[0]);
      if (existing && isDashboardSafeCopyJob(existing)) {
        const result = cancelDashboardSafeCopyJob(parts[0]);
        if (result.status === 'blocked') {
          return json({
            error: 'This safe-copy destination has an in-flight or uncertain write. It must be reconciled before cancellation.',
            code: 'SAFE_COPY_RECONCILIATION_REQUIRED',
            job: clientJob(result.job),
          }, 409);
        }
        if (result.status === 'not_found') return json({ error: 'Job not found.' }, 404);
        if (result.status === 'canceled') return json({ job: clientJob(result.job) });
      }
      const job = cancelMigrationJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return json({ job: clientJob(job) });
    }

    const isSafeCopyStart = req.method === 'POST' && parts.length === 1 && parts[0] === 'safe-copy';
    const isSafeCopyTargetRetry = req.method === 'POST'
      && parts.length === 4
      && parts[1] === 'targets'
      && parts[3] === 'retry';
    if (
      (isSafeCopyStart || isSafeCopyTargetRetry)
      && !isDashboardSafeCopyV1Enabled()
    ) {
      return json({ error: 'Safe-copy workflow is not enabled.' }, 404);
    }
    const isLegacyDashboardPreview = req.method === 'POST'
      && parts.length === 1
      && parts[0] === 'preview';
    const isLegacyDashboardPatchValidation = req.method === 'POST'
      && parts.length === 1
      && parts[0] === 'validate-patches';
    const isLegacyDashboardCreate = req.method === 'POST' && parts.length === 0;
    const retryCandidate = req.method === 'POST' && parts.length === 2 && parts[1] === 'retry'
      ? getJob(parts[0])
      : undefined;
    // Legacy dashboard history predates the explicit workflow discriminator.
    // Treat every non-model, non-safe-copy job as legacy dashboard work.
    const isLegacyDashboardRetry = Boolean(
      retryCandidate
      && retryCandidate.workflow !== 'model'
      && !isDashboardSafeCopyJob(retryCandidate),
    );
    if (
      (
        isLegacyDashboardPreview
        || isLegacyDashboardPatchValidation
        || isLegacyDashboardCreate
        || isLegacyDashboardRetry
      )
      && !isLegacyDashboardMigratorInternalEnabled()
    ) {
      return json({ error: 'Legacy dashboard migration workflow is not enabled.' }, 404);
    }

    const locked = requireUnlocked();
    if (locked) return locked;

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'mutation-adjudications') {
      try {
        const result = adjudicateDestinationModelMutation(
          parts[0],
          parseMutationAdjudication(await bodyJson(req)),
        );
        return json({
          replayed: result.replayed,
          itemId: result.item.id,
          job: clientJob(result.job),
        }, result.replayed ? 200 : 201);
      } catch (error) {
        if (error instanceof DestinationModelMutationAdjudicationError) {
          return json({ error: error.message, code: error.code }, error.statusCode);
        }
        throw error;
      }
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'safe-copy') {
      try {
        const intent = parseDashboardSafeCopyIntent(await safeCopyBodyJson(req));
        if (intent.deployment) return json({ error: 'Reviewed deployment must be submitted through its saved plan.', code: 'SAFE_COPY_INVALID_DEPLOYMENT' }, 400);
        const prepare = dependencies.safeCopyPreparation === undefined
          ? prepareAndRunDashboardSafeCopyJob
          : dependencies.safeCopyPreparation || undefined;
        const result = createDashboardSafeCopyJob(intent, { prepare });
        return json({ ...result, job: clientJob(result.job) }, result.replayed ? 200 : 202);
      } catch (error) {
        if (isDashboardSafeCopyError(error)) {
          return json({ error: error.message, code: error.code }, error.statusCode);
        }
        throw error;
      }
    }

    if (isSafeCopyTargetRetry) {
      const job = getJob(parts[0]);
      if (!job || !isDashboardSafeCopyJob(job)) return json({ error: 'Safe-copy job not found.' }, 404);
      try {
        const requestId = parseSafeCopyRetryRequest(await safeCopyBodyJson(req));
        const retry = dependencies.safeCopyRetry || retryDashboardSafeCopyJobTarget;
        const result = await retry(parts[0], parts[2], requestId);
        return json({ ...result, job: clientJob(result.job) }, 202);
      } catch (error) {
        if (isDashboardSafeCopyError(error)) {
          return json({ error: error.message, code: error.code }, error.statusCode);
        }
        throw error;
      }
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'preview') {
      const input = parseJobInput(await bodyJson(req));
      const requestTargets = [
        ...(input.targets || []),
        ...((input.routeGroups || []).flatMap((group) => group.targets)),
      ];
      if (!input.sourceId || (requestTargets.length === 0 && (input.destinationIds || []).length === 0) || input.documentIds.length === 0) {
        return json({ error: 'Select one source, at least one migration target, and at least one dashboard.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetConnectionId)) {
        return json({ error: 'Choose a target connection for every migration target before running preflight.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetModelId)) {
        return json({ error: 'Choose a target model for every migration target before running preflight.' }, 400);
      }
      const timings = createPerformanceTracker();
      const plan = await timings.time(
        'build-migration-plan',
        () => buildMigrationPlan({ ...input, usePreviewCache: true }),
        (result) => ({
          stepCount: result?.steps.length || 0,
          targetCount: requestTargets.length,
          documentCount: input.documentIds.length,
        }),
      );
      return json({ plan, performance: timings.snapshot() });
    }

    if (req.method === 'POST' && parts.length === 2 && parts[0] === 'actions' && parts[1] === 'run') {
      const body = await bodyJson(req);
      const actions = parseActions(body.actions);
      const results = [];
      for (const action of actions) {
        results.push({ action: action.name, ...(await runPostMigrationAction(action)) });
      }
      return json({ results });
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'validate-patches') {
      const input = parseJobInput(await bodyJson(req));
      const requestTargets = [
        ...(input.targets || []),
        ...((input.routeGroups || []).flatMap((group) => group.targets)),
      ];
      if (!input.sourceId || input.documentIds.length === 0 || requestTargets.length === 0) {
        return json({ error: 'Select a source, at least one dashboard, and at least one migration target before validating dependency patches.' }, 400);
      }
      const result = await validateDashboardMigrationPatches(input);
      return json({ validation: result });
    }

    if (req.method === 'POST' && parts.length === 0) {
      const input = parseJobInput(await bodyJson(req));
      const requestTargets = [
        ...(input.targets || []),
        ...((input.routeGroups || []).flatMap((group) => group.targets)),
      ];
      if (!input.sourceId || (requestTargets.length === 0 && (input.destinationIds || []).length === 0) || input.documentIds.length === 0) {
        return json({ error: 'Select one source, at least one migration target, and at least one dashboard.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetConnectionId)) {
        return json({ error: 'Choose a target connection for every migration target before starting the import.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetModelId)) {
        return json({ error: 'Choose a target model for every migration target before starting the import.' }, 400);
      }
      const job = await createMigrationJob(input);
      return json({ job });
    }

    const id = parts[0];
    if (!id) return json({ error: 'Job id required.' }, 400);

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'retry') {
      const existing = getJob(id);
      if (existing && isDashboardSafeCopyJob(existing)) {
        return json({
          error: 'Safe-copy retries are destination-scoped and require an explicit retry request ID.',
          code: 'SAFE_COPY_TARGET_RETRY_REQUIRED',
        }, 409);
      }
      const body = await bodyJson(req);
      const job = await retryMigrationJob(id, {
        destinationId: cleanString(body.destinationId),
        retryInput: parseOptionalRetryInput(body.retryInput),
      });
      return json({ job });
    }

    return json({ error: `Unknown migration jobs route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Migration job operation failed.' }, statusCode);
  }
}

export default function handler(req: Request): Promise<Response> {
  return migrationJobsHandler(req);
}
