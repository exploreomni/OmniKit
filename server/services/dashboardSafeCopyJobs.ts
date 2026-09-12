import { createHash, randomUUID } from 'node:crypto';

import {
  DASHBOARD_SAFE_COPY_RESOLVER_VERSION,
  DashboardSafeCopyError,
  type DashboardSafeCopyIntent,
  canonicalDashboardSafeCopyIntent,
  parseDashboardSafeCopyIntent,
} from '../../shared/dashboardSafeCopyContract';
import {
  getJob,
  insertJob,
  listJobs,
  updateJobAtomically,
  updateJobStatus,
} from './jobStore';
import { publishMigrationJobEvent } from './jobEvents';
import { isDashboardSafeCopyV1Enabled } from './dashboardMigrationFeatureFlags';
import { redactSensitiveText } from './jobSanitizer';
import type { MigrationJob, MigrationTarget } from './migrationJobs';
import { getInstance, type SavedInstance } from './nativeVault';
import { hasUnresolvedMigrationDestinationModelMutation } from './migrationScopeReservation';

export type DashboardSafeCopyPreparationRunner = (
  jobId: string,
  intent: DashboardSafeCopyIntent,
) => Promise<void> | void;

export interface CreateDashboardSafeCopyJobOptions {
  prepare?: DashboardSafeCopyPreparationRunner;
}

export interface CreateDashboardSafeCopyJobResult {
  job: MigrationJob;
  replayed: boolean;
  resumed: boolean;
}

function canonicalIntentPayload(intent: DashboardSafeCopyIntent): string {
  return JSON.stringify({
    profile: intent.profile,
    source: intent.source,
    destinations: intent.destinations,
    ...(intent.deployment ? { deployment: intent.deployment } : {}),
  });
}

export function dashboardSafeCopyIntentHash(intent: DashboardSafeCopyIntent): string {
  const canonical = canonicalDashboardSafeCopyIntent(intent);
  return createHash('sha256').update(canonicalIntentPayload(canonical)).digest('hex');
}

function assertPersistenceStableIntent(intent: DashboardSafeCopyIntent): void {
  const evidenceText = intent.destinations.flatMap((destination) => [
    ...(destination.folderPath ? [destination.folderPath] : []),
    ...(destination.topicMappings || []).flatMap((mapping) => [mapping.sourceTopicName, mapping.targetTopicName]),
    ...(destination.queryViewMappings || []).flatMap((mapping) => [mapping.sourceQueryViewName, mapping.targetQueryViewName]),
  ]);
  if (intent.deployment) evidenceText.push(intent.deployment.planId);
  if (evidenceText.some((value) => redactSensitiveText(value) !== value)) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_INVALID_DESTINATION',
      'Safe-copy scope contains a value that cannot be stored as exact non-secret reconciliation evidence.',
    );
  }
}

function detailString(job: MigrationJob, key: string): string | undefined {
  const value = job.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function itemDetailString(item: MigrationJob['items'][number], key: string): string | undefined {
  const value = item.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function isDashboardSafeCopyJob(job: MigrationJob): boolean {
  return job.workflow === 'dashboard'
    && detailString(job, 'safeCopyProfile') === 'safe_copy_v1'
    && detailString(job, 'operationMode') === 'safe_copy';
}

export function dashboardSafeCopyJobHasActiveOrUncertainEvidence(job: MigrationJob): boolean {
  if (!isDashboardSafeCopyJob(job)) return false;
  if (job.status === 'pending' || job.status === 'running') return true;
  return job.items.some((item) => {
    const state = itemDetailString(item, 'safeCopyAttemptState');
    return state === 'dispatched' || state === 'uncertain';
  });
}

export type DashboardSafeCopyCancelResult =
  | { status: 'not_found' }
  | { status: 'not_safe_copy'; job: MigrationJob }
  | { status: 'blocked'; job: MigrationJob }
  | { status: 'canceled'; job: MigrationJob };

export function cancelDashboardSafeCopyJob(jobId: string): DashboardSafeCopyCancelResult {
  const outcome: { value: 'not_safe_copy' | 'blocked' | 'canceled' } = { value: 'canceled' };
  let didCancel = false;
  const updated = updateJobAtomically(jobId, (latest) => {
    if (!isDashboardSafeCopyJob(latest)) {
      outcome.value = 'not_safe_copy';
      return latest;
    }
    const activeOrUnprovenWriteEvidence = latest.items.some((item) => {
      if (item.details?.safeCopyAttempt !== true) return false;
      const state = itemDetailString(item, 'safeCopyAttemptState');
      return state !== 'verified' && state !== 'failed_prewrite';
    });
    if (activeOrUnprovenWriteEvidence) {
      outcome.value = 'blocked';
      return latest;
    }
    if (['succeeded', 'partial', 'failed', 'canceled'].includes(latest.status)) return latest;
    const now = Date.now();
    didCancel = true;
    return {
      ...latest,
      status: 'canceled',
      endedAt: now,
      details: {
        ...(latest.details || {}),
        safeCopyPreparationState: 'canceled',
      },
      items: latest.items.map((item) => (
        item.status === 'pending'
          ? { ...item, status: 'skipped', error: 'Canceled before a write was dispatched.', endedAt: now }
          : item
      )),
    };
  });
  if (!updated) return { status: 'not_found' };
  if (outcome.value === 'not_safe_copy') return { status: 'not_safe_copy', job: updated };
  if (outcome.value === 'blocked') return { status: 'blocked', job: updated };
  if (didCancel) {
    publishMigrationJobEvent({
      type: 'job',
      jobId: updated.id,
      status: updated.status,
      at: Date.now(),
      job: updated,
    });
  }
  return { status: 'canceled', job: updated };
}

function findExistingRequest(requestId: string): MigrationJob | undefined {
  return listJobs(Number.MAX_SAFE_INTEGER).find((job) => (
    detailString(job, 'safeCopyProfile') === 'safe_copy_v1'
      && detailString(job, 'safeCopyRequestId') === requestId
  ));
}

function storedIntent(job: MigrationJob): DashboardSafeCopyIntent | undefined {
  if (!isDashboardSafeCopyJob(job) || !job.sourceConnectionId || !job.targets) return undefined;
  const requestId = detailString(job, 'safeCopyRequestId');
  if (!requestId) return undefined;
  try {
    return parseDashboardSafeCopyIntent({
      profile: 'safe_copy_v1',
      requestId,
      source: {
        instanceId: job.sourceId,
        connectionId: job.sourceConnectionId,
        documentIds: job.documentIds,
      },
      destinations: job.targets.map((target) => ({
        targetId: target.id,
        instanceId: target.destinationInstanceId,
        connectionId: target.targetConnectionId || '',
        modelId: target.targetModelId || '',
        ...(target.targetFolderId ? { folderId: target.targetFolderId } : {}),
        ...(target.targetFolderPath ? { folderPath: target.targetFolderPath } : {}),
        ...(target.workbookCopy ? { workbookCopy: { ...target.workbookCopy } } : {}),
        ...(target.topicMappings?.length ? { topicMappings: target.topicMappings.map((mapping) => ({
          sourceTopicName: mapping.sourceTopicName, action: mapping.action, targetTopicName: mapping.targetTopicName,
        })) } : {}),
        ...(target.queryViewMappings?.length ? { queryViewMappings: target.queryViewMappings.map((mapping) => ({
          sourceQueryViewName: mapping.sourceQueryViewName, action: mapping.action, targetQueryViewName: mapping.targetQueryViewName,
        })) } : {}),
      })),
      ...(job.details?.safeCopyDeployment ? { deployment: job.details.safeCopyDeployment } : {}),
    });
  } catch {
    return undefined;
  }
}

function isPreparedForExecution(job: MigrationJob): boolean {
  const preparationState = detailString(job, 'safeCopyPreparationState');
  if (
    job.status !== 'pending'
    || (preparationState !== 'prepared' && preparationState !== 'needs_attention')
    || !job.targets?.length
  ) return false;
  const hasExactPreparationLedger = job.targets.every((target) => (
      job.items.filter((item) => (
        item.targetId === target.id && item.details?.safeCopyPreparationSummary === true
      )).length === 1
    ));
  if (!hasExactPreparationLedger) return false;
  const allowedLedger = job.items.every((item) => {
    if (item.details?.safeCopyPreparationSummary === true) return true;
    if (item.details?.safeCopyTargetExecutionSummary === true) return true;
    if (item.details?.safeCopyDocumentProvenance !== undefined) return true;
    if (item.details?.safeCopyAttempt === true) {
      const state = itemDetailString(item, 'safeCopyAttemptState');
      return state === 'verified' || state === 'failed_prewrite';
    }
    return false;
  });
  if (!allowedLedger || detailString(job, 'safeCopyExecutionState') === 'reconciliation_required') return false;
  return job.targets.some((target) => {
    const result = job.items.find((item) => (
      item.targetId === target.id && item.details?.safeCopyTargetExecutionSummary === true
    ));
    const preparation = job.items.find((item) => (
      item.targetId === target.id && item.details?.safeCopyPreparationSummary === true
    ));
    return !result
      && preparation?.status === 'succeeded'
      && preparation.details?.safeCopyTargetStatus === 'ready';
  });
}

function unresolvedAttemptOverlapsIntent(
  job: MigrationJob,
  item: MigrationJob['items'][number],
  intent: DashboardSafeCopyIntent,
): boolean {
  if (item.details?.safeCopyAttempt !== true) return false;
  const state = itemDetailString(item, 'safeCopyAttemptState');
  if (state === 'verified' || state === 'failed_prewrite') return false;
  if (job.sourceId !== intent.source.instanceId || job.sourceConnectionId !== intent.source.connectionId) return false;
  const sourceDocumentId = itemDetailString(item, 'safeCopySourceDocumentId');
  if (sourceDocumentId && !intent.source.documentIds.includes(sourceDocumentId)) return false;
  const persistedTarget = job.targets?.find((target) => target.id === item.targetId);
  const destinationInstanceId = itemDetailString(item, 'safeCopyDestinationInstanceId')
    || persistedTarget?.destinationInstanceId;
  const connectionId = itemDetailString(item, 'safeCopyConnectionId')
    || persistedTarget?.targetConnectionId;
  const modelId = itemDetailString(item, 'safeCopyModelId')
    || persistedTarget?.targetModelId;
  const folderId = itemDetailString(item, 'safeCopyFolderId')
    || persistedTarget?.targetFolderId;
  const folderPath = itemDetailString(item, 'safeCopyFolderPath')
    || persistedTarget?.targetFolderPath;
  return intent.destinations.some((destination) => (
    (!destinationInstanceId || destinationInstanceId === destination.instanceId)
    && (!connectionId || connectionId === destination.connectionId)
    && (!modelId || modelId === destination.modelId)
    && (folderId || destination.folderId ? (folderId || '') === (destination.folderId || '') : true)
    && (folderPath || destination.folderPath ? (folderPath || '') === (destination.folderPath || '') : true)
  ));
}

export function dashboardSafeCopyIntentHasUnresolvedScopeOverlap(
  intent: DashboardSafeCopyIntent,
  jobs: readonly MigrationJob[] = listJobs(Number.MAX_SAFE_INTEGER),
): boolean {
  return jobs.some((job) => (
    isDashboardSafeCopyJob(job)
    && job.items.some((item) => unresolvedAttemptOverlapsIntent(job, item, intent))
  ));
}

export function dashboardSafeCopyHasUnresolvedDestinationModelOverlap(
  destinationInstanceId: string,
  targetModelIds: readonly string[],
  jobs: readonly MigrationJob[] = listJobs(Number.MAX_SAFE_INTEGER),
): boolean {
  const models = new Set(targetModelIds.map((value) => value.trim()).filter(Boolean));
  if (!destinationInstanceId.trim() || models.size === 0) return false;
  return jobs.some((job) => (
    isDashboardSafeCopyJob(job)
    && job.items.some((item) => {
      if (item.details?.safeCopyAttempt !== true) return false;
      const state = itemDetailString(item, 'safeCopyAttemptState');
      if (state === 'verified' || state === 'failed_prewrite') return false;
      const persistedTarget = job.targets?.find((target) => target.id === item.targetId);
      const instanceId = itemDetailString(item, 'safeCopyDestinationInstanceId')
        || persistedTarget?.destinationInstanceId;
      const modelId = itemDetailString(item, 'safeCopyModelId')
        || persistedTarget?.targetModelId;
      return instanceId === destinationInstanceId && Boolean(modelId && models.has(modelId));
    })
  ));
}

function assertNoUnresolvedScopeOverlap(intent: DashboardSafeCopyIntent): void {
  const destinationModelConflict = hasUnresolvedMigrationDestinationModelMutation(
    listJobs(Number.MAX_SAFE_INTEGER),
    intent.destinations.map((destination) => ({
      destinationInstanceId: destination.instanceId,
      targetModelId: destination.modelId,
    })),
  );
  if (!dashboardSafeCopyIntentHasUnresolvedScopeOverlap(intent) && !destinationModelConflict) return;
  throw new DashboardSafeCopyError(
    'SAFE_COPY_SCOPE_CONFLICT',
    'An earlier destination-model write still requires reconciliation before this safe copy can start.',
    409,
  );
}

function isInterruptedPreparationSkeleton(job: MigrationJob): boolean {
  const preparationState = detailString(job, 'safeCopyPreparationState');
  if (
    (job.status !== 'failed' && job.status !== 'pending')
    || (
      preparationState !== 'queued'
      && preparationState !== 'awaiting_resolver'
      && preparationState !== 'resolving'
    )
    || !job.targets?.length
    || job.items.some((item) => item.details?.safeCopyPreparationSummary !== true)
  ) return false;
  const targetIds = new Set(job.targets.map((target) => target.id));
  const summaryTargetIds = job.items.flatMap((item) => item.targetId ? [item.targetId] : []);
  return summaryTargetIds.every((targetId) => targetIds.has(targetId))
    && new Set(summaryTargetIds).size === summaryTargetIds.length;
}

function requireSavedInstance(instanceId: string, role: 'source' | 'destination') {
  const instance = getInstance(instanceId);
  if (!instance) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_INSTANCE_NOT_FOUND',
      `The selected ${role} instance is no longer available in the unlocked vault.`,
    );
  }
  return instance;
}

export type DashboardSafeCopyInstanceRoleLookup = (
  instanceId: string,
) => Pick<SavedInstance, 'role'> | undefined;

function instanceSupportsRole(
  instance: Pick<SavedInstance, 'role'>,
  requiredRole: 'source' | 'destination',
): boolean {
  return instance.role === 'both' || instance.role === requiredRole;
}

/**
 * Reusable server-side authority check for safe-copy creation and every fresh
 * runtime/retry boundary. UI filtering is not write authorization.
 */
export function assertDashboardSafeCopyInstanceRoles(
  intent: DashboardSafeCopyIntent,
  lookupInstance: DashboardSafeCopyInstanceRoleLookup = getInstance,
): void {
  const source = lookupInstance(intent.source.instanceId);
  if (!source) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_INSTANCE_NOT_FOUND',
      'The selected source instance is no longer available in the unlocked vault.',
    );
  }
  if (!instanceSupportsRole(source, 'source')) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_INVALID_SOURCE',
      'The selected source instance is not authorized for source operations.',
    );
  }

  for (const destination of intent.destinations) {
    const instance = lookupInstance(destination.instanceId);
    if (!instance) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_INSTANCE_NOT_FOUND',
        'A selected destination instance is no longer available in the unlocked vault.',
      );
    }
    if (!instanceSupportsRole(instance, 'destination')) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_INVALID_DESTINATION',
        'A selected destination instance is not authorized for destination operations.',
      );
    }
  }
}

function migrationTargets(intent: DashboardSafeCopyIntent): MigrationTarget[] {
  return intent.destinations.map((destination) => {
    const instance = requireSavedInstance(destination.instanceId, 'destination');
    return {
      id: destination.targetId,
      destinationInstanceId: destination.instanceId,
      destinationLabel: instance.label,
      targetConnectionId: destination.connectionId,
      targetModelId: destination.modelId,
      targetFolderId: destination.folderId,
      targetFolderPath: destination.folderPath,
      ...(destination.workbookCopy ? { workbookCopy: { ...destination.workbookCopy } } : {}),
      ...(destination.topicMappings ? { topicMappings: destination.topicMappings.map((mapping) => ({ ...mapping })) } : {}),
      ...(destination.queryViewMappings ? { queryViewMappings: destination.queryViewMappings.map((mapping) => ({ ...mapping })) } : {}),
    };
  });
}

function markPreparationFailure(jobId: string): void {
  try {
    const current = getJob(jobId);
    if (!current || current.status !== 'pending') return;
    const failed: MigrationJob = {
      ...current,
      status: 'failed',
      endedAt: Date.now(),
      details: {
        ...(current.details || {}),
        safeCopyPreparationState: 'failed',
        safeCopyPreparationErrorCode: 'SAFE_COPY_PREPARATION_FAILED',
        safeCopyPreparationError: 'Safe-copy preparation could not be completed.',
      },
    };
    updateJobStatus(failed);
    const stored = getJob(jobId);
    if (stored) publishMigrationJobEvent({
      type: 'job',
      jobId,
      status: stored.status,
      at: Date.now(),
      job: stored,
    });
  } catch {
    // The durable store is already unavailable. Contain the background failure;
    // a later idempotent replay will recover only a zero-item interrupted skeleton.
  }
}

const queuedPreparationJobs = new Set<string>();

function queuePreparation(
  jobId: string,
  intent: DashboardSafeCopyIntent,
  prepare?: DashboardSafeCopyPreparationRunner,
): void {
  if (queuedPreparationJobs.has(jobId)) return;
  queuedPreparationJobs.add(jobId);
  queueMicrotask(() => {
    void Promise.resolve()
      .then(() => {
        if (prepare) return prepare(jobId, intent);
        const current = getJob(jobId);
        if (!current || current.status !== 'pending') return;
        const awaiting: MigrationJob = {
          ...current,
          details: {
            ...(current.details || {}),
            safeCopyPreparationState: 'awaiting_resolver',
          },
        };
        updateJobStatus(awaiting);
        const stored = getJob(jobId);
        if (stored) publishMigrationJobEvent({
          type: 'job',
          jobId,
          status: stored.status,
          at: Date.now(),
          job: stored,
        });
      })
      .catch(() => markPreparationFailure(jobId))
      .finally(() => queuedPreparationJobs.delete(jobId));
  });
}

export function resumePendingDashboardSafeCopyJobs(
  prepare: DashboardSafeCopyPreparationRunner,
): string[] {
  if (!isDashboardSafeCopyV1Enabled()) return [];
  const resumed: string[] = [];
  for (const candidate of listJobs(Number.MAX_SAFE_INTEGER)) {
    try {
      const intent = storedIntent(candidate);
      if (!intent || detailString(candidate, 'safeCopyIntentHash') !== dashboardSafeCopyIntentHash(intent)) continue;
      let resumable = candidate;
      if (isInterruptedPreparationSkeleton(candidate)) {
        const updated = updateJobAtomically(candidate.id, (latest) => ({
          ...latest,
          status: 'pending',
          endedAt: undefined,
          details: { ...(latest.details || {}), safeCopyPreparationState: 'queued' },
        }));
        if (!updated) continue;
        resumable = updated;
      } else if (!isPreparedForExecution(candidate)) {
        continue;
      }
      queuePreparation(resumable.id, intent, prepare);
      resumed.push(resumable.id);
    } catch {
      // One malformed or unavailable ledger must not prevent other exact jobs from resuming.
    }
  }
  return resumed;
}

export function createDashboardSafeCopyJob(
  rawIntent: DashboardSafeCopyIntent,
  options: CreateDashboardSafeCopyJobOptions = {},
): CreateDashboardSafeCopyJobResult {
  const intent = canonicalDashboardSafeCopyIntent(rawIntent);
  assertPersistenceStableIntent(intent);
  const intentHash = dashboardSafeCopyIntentHash(intent);

  // There is deliberately no await before this lookup-and-insert sequence.
  // The synchronous job store makes request-id ownership atomic in this process.
  const existing = findExistingRequest(intent.requestId);
  if (existing) {
    if (detailString(existing, 'safeCopyIntentHash') !== intentHash) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_IDEMPOTENCY_CONFLICT',
        'This safe-copy request ID was already used for a different migration intent.',
        409,
      );
    }
    if (isInterruptedPreparationSkeleton(existing)) {
      const resumed: MigrationJob = {
        ...existing,
        status: 'pending',
        endedAt: undefined,
        details: {
          ...(existing.details || {}),
          safeCopyPreparationState: 'queued',
        },
      };
      updateJobStatus(resumed);
      queuePreparation(resumed.id, intent, options.prepare);
      return { job: getJob(resumed.id) || resumed, replayed: true, resumed: true };
    }
    if (options.prepare && isPreparedForExecution(existing)) {
      queuePreparation(existing.id, intent, options.prepare);
      return { job: getJob(existing.id) || existing, replayed: true, resumed: true };
    }
    return { job: existing, replayed: true, resumed: false };
  }

  assertNoUnresolvedScopeOverlap(intent);
  assertDashboardSafeCopyInstanceRoles(intent);
  const source = requireSavedInstance(intent.source.instanceId, 'source');
  const targets = migrationTargets(intent);
  const jobId = randomUUID();
  const job: MigrationJob = {
    id: jobId,
    workflow: 'dashboard',
    sourceId: intent.source.instanceId,
    sourceLabel: source.label,
    sourceConnectionId: intent.source.connectionId,
    destinationIds: [...new Set(intent.destinations.map((destination) => destination.instanceId))].sort(),
    targets,
    documentIds: [...intent.source.documentIds],
    emptyFirst: intent.options?.emptyFirst || false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: intent.options?.deleteSourceOnSuccess || false,
    postMigrationActions: intent.options?.refreshSchemaOnComplete
      ? intent.destinations.map((destination) => ({
        kind: 'refresh-schema' as const,
        name: `Refresh schema for ${destination.modelId}`,
        method: 'POST' as const,
        url: '',
        headers: {},
        body: '',
        destinationInstanceId: destination.instanceId,
        targetModelId: destination.modelId,
      }))
      : [],
    status: 'pending',
    createdAt: Date.now(),
    details: {
      operationMode: 'safe_copy',
      safeCopyProfile: intent.profile,
      safeCopyRequestId: intent.requestId,
      safeCopyIntentHash: intentHash,
      safeCopyResolverVersion: DASHBOARD_SAFE_COPY_RESOLVER_VERSION,
      safeCopyPreparationState: 'queued',
      safeCopyTargetCount: targets.length,
      ...(intent.deployment ? { safeCopyDeployment: intent.deployment } : {}),
    },
    items: [],
  };

  insertJob(job);
  queuePreparation(job.id, intent, options.prepare);
  return { job: getJob(job.id) || job, replayed: false, resumed: false };
}
