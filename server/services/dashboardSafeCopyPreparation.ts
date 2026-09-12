import { createHash } from 'node:crypto';
import { getDashboardDeploymentPlan } from './dashboardDeploymentPlans';
import { readReviewedReconstructedTopics } from './dashboardTopicRepairEvidence';

import {
  DASHBOARD_SAFE_COPY_RESOLVER_VERSION,
  type DashboardSafeCopyDestination,
  type DashboardSafeCopyIntent,
  scopeDashboardSafeCopyIntent,
} from '../../shared/dashboardSafeCopyContract';
import { publishMigrationJobEvent } from './jobEvents';
import { getJob, updateJobAtomically, updateJobStatus } from './jobStore';
import { getInstance } from './nativeVault';
import { OmniClient } from './omniClient';
import {
  buildMigrationPlan,
  type DashboardMigrationJobInput,
  type DashboardPatchValidationResult,
  type MigrationJob,
  type MigrationJobItem,
  type MigrationPlan,
  type MigrationTarget,
  validateDashboardMigrationPatches,
} from './migrationJobs';
import {
  type DashboardSafeCopyResolverResult,
  type DashboardSafeCopyTargetException,
  resolveDashboardSafeCopyTarget,
} from './dashboardSafeCopyResolver';
import {
  assertDashboardSafeCopyInstanceRoles,
  dashboardSafeCopyIntentHash,
} from './dashboardSafeCopyJobs';
import {
  type DashboardSafeCopyPatchSafetyExceptionCode,
  type DashboardSafeCopyPatchSafetyResult,
  validateAdditiveDashboardSafeCopyPatches,
} from './dashboardSafeCopyPatchSafety';

const MAX_RESOLUTION_PASSES = 4;
const TARGET_PREPARATION_CONCURRENCY = 3;

const SAFE_DASHBOARD_PLAN_KINDS = new Set<MigrationPlan['steps'][number]['kind']>([
  'export',
  'import',
  'metadata',
  'permission_prepare',
  'permission_verify',
  'field_prepare',
  'query_view_prepare',
  'relationship_prepare',
  'topic_prepare',
  'semantic_validate',
  'query_validate',
  'document_verify',
]);

const REQUIRED_PLAN_KINDS_PER_DOCUMENT = [
  'export',
  'semantic_validate',
  'query_validate',
  'import',
  'metadata',
  'document_verify',
] as const;

export type DashboardSafeCopyPreparationExceptionCode =
  | DashboardSafeCopyTargetException['code']
  | DashboardSafeCopyPatchSafetyExceptionCode
  | 'PLAN_DID_NOT_CONVERGE'
  | 'PLAN_BLOCKED'
  | 'SCRATCH_VALIDATION_FAILED'
  | 'TARGET_SCOPE_MISMATCH'
  | 'REPAIR_REQUIRED'
  | 'PREPARATION_FAILED';

export interface DashboardSafeCopyPreparationException {
  targetId: string;
  code: DashboardSafeCopyPreparationExceptionCode;
  artifact: DashboardSafeCopyTargetException['artifact'];
  reference: string;
  message: string;
}

export interface DashboardSafeCopyPreparedTarget {
  status: 'ready';
  targetId: string;
  target: MigrationTarget;
  plan: MigrationPlan;
  decisionFingerprint: string;
  planFingerprint: string;
  patchCount: number;
  scratchValidation: 'not_required' | 'passed';
}

export interface DashboardSafeCopyPreparationTargetException {
  status: 'needs_attention';
  targetId: string;
  exceptions: DashboardSafeCopyPreparationException[];
}

export type DashboardSafeCopyTargetPreparation =
  | DashboardSafeCopyPreparedTarget
  | DashboardSafeCopyPreparationTargetException;

export interface DashboardSafeCopyPreparationDependencies {
  buildPlan?: typeof buildMigrationPlan;
  resolveTarget?: (
    plan: MigrationPlan,
    target: MigrationTarget,
  ) => DashboardSafeCopyResolverResult;
  validatePatches?: (
    input: DashboardMigrationJobInput,
  ) => Promise<DashboardPatchValidationResult>;
  validatePatchSafety?: typeof validateAdditiveDashboardSafeCopyPatches;
  loadTargetYamlSnapshot?: (
    target: MigrationTarget,
  ) => Promise<DashboardSafeCopyTargetYamlSnapshot>;
}

export interface DashboardSafeCopyTargetYamlSnapshot {
  files: Readonly<Record<string, string>>;
  checksums: Readonly<Record<string, string>>;
}

export type DashboardSafeCopyTargetPreparationListener = (
  result: DashboardSafeCopyTargetPreparation,
) => void | Promise<void>;

const preparingJobs = new Set<string>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
  );
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function patchFingerprint(target: MigrationTarget): Array<Record<string, unknown>> {
  return (target.semanticPatches || []).map((patch) => ({
    id: patch.id,
    artifactType: patch.artifactType,
    sourceName: patch.sourceName,
    sourceFileName: patch.sourceFileName,
    targetFileName: patch.targetFileName,
    targetModelId: patch.targetModelId,
    previousChecksum: patch.previousChecksum,
    resolution: patch.resolution,
    status: patch.status,
    safetyCategory: patch.safetyCategory,
    acceptedYamlHash: patch.acceptedYaml ? sha256(patch.acceptedYaml) : undefined,
  }));
}

export function dashboardSafeCopyTargetDecisionFingerprint(target: MigrationTarget): string {
  return sha256({
    id: target.id,
    destinationInstanceId: target.destinationInstanceId,
    targetConnectionId: target.targetConnectionId,
    targetModelId: target.targetModelId,
    targetFolderId: target.targetFolderId,
    targetFolderPath: target.targetFolderPath,
    fieldMappings: target.fieldMappings || [],
    queryViewMappings: target.queryViewMappings || [],
    topicMappings: target.topicMappings || [],
    permissionDecisions: target.permissionDecisions || [],
    semanticPatches: patchFingerprint(target),
  });
}

function planFingerprint(plan: MigrationPlan, target: MigrationTarget): string {
  return sha256({
    targetDecisionFingerprint: dashboardSafeCopyTargetDecisionFingerprint(target),
    sourceId: plan.sourceId,
    sourceConnectionId: plan.sourceConnectionId,
    documentIds: plan.documentIds,
    steps: plan.steps.map((step) => ({
      targetId: step.targetId,
      destinationId: step.destinationId,
      targetConnectionId: step.targetConnectionId,
      targetModelId: step.targetModelId,
      targetFolderId: step.targetFolderId,
      targetFolderPath: step.targetFolderPath,
      kind: step.kind,
      documentId: step.documentId,
      replacement: step.replacement === true,
      blocked: step.blocked === true,
      hasError: Boolean(step.error),
    })),
  });
}

function fixedException(
  targetId: string,
  code: DashboardSafeCopyPreparationExceptionCode,
  artifact: DashboardSafeCopyTargetException['artifact'],
  message: string,
  reference: string = artifact,
): DashboardSafeCopyPreparationTargetException {
  return {
    status: 'needs_attention',
    targetId,
    exceptions: [{ targetId, code, artifact, reference, message }],
  };
}

function targetMatchesDestination(
  target: MigrationTarget,
  destination: DashboardSafeCopyDestination,
): boolean {
  return target.id === destination.targetId
    && target.destinationInstanceId === destination.instanceId
    && (target.targetConnectionId || '') === destination.connectionId
    && target.targetModelId === destination.modelId
    && (target.targetFolderId || '') === (destination.folderId || '')
    && (target.targetFolderPath || '') === (destination.folderPath || '');
}

function inputForTarget(
  intent: DashboardSafeCopyIntent,
  target: MigrationTarget,
): DashboardMigrationJobInput {
  return {
    sourceId: intent.source.instanceId,
    sourceConnectionId: intent.source.connectionId,
    targets: [{ ...target, ...(intent.deployment ? { exactFolder: true } : {}) }],
    documentIds: [...intent.source.documentIds],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    sourceAllFolders: true,
    documentAccessPolicy: 'destination_defaults',
    postMigrationActions: [],
  };
}

function unsafePlanException(
  plan: MigrationPlan,
  target: MigrationTarget,
  intent: DashboardSafeCopyIntent,
  destination: DashboardSafeCopyDestination,
): DashboardSafeCopyPreparationTargetException | undefined {
  const expectedDocumentIds = [...intent.source.documentIds].sort();
  const actualDocumentIds = [...plan.documentIds].sort();
  if (
    plan.emptyFirst
    || plan.replaceSameNamed
    || plan.deleteSourceOnSuccess
    || plan.sourceId !== intent.source.instanceId
    || (plan.sourceConnectionId || '') !== intent.source.connectionId
    || JSON.stringify(actualDocumentIds) !== JSON.stringify(expectedDocumentIds)
    || plan.destinationIds.length !== 1
    || plan.destinationIds[0] !== destination.instanceId
    || plan.targets.length !== 1
    || !targetMatchesDestination(plan.targets[0], destination)
  ) {
    return fixedException(
      target.id,
      'TARGET_SCOPE_MISMATCH',
      'target',
      'The prepared plan no longer matches the selected non-destructive target scope.',
      target.id,
    );
  }
  const selectedDocumentIds = new Set(expectedDocumentIds);
  const unsafeStep = plan.steps.find((step) => (
    step.blocked === true
    || Boolean(step.error)
    || step.replacement === true
    || !SAFE_DASHBOARD_PLAN_KINDS.has(step.kind)
    || step.targetId !== target.id
    || step.destinationId !== target.destinationInstanceId
    || (step.targetConnectionId || '') !== (target.targetConnectionId || '')
    || step.targetModelId !== target.targetModelId
    || (step.targetFolderId || '') !== (target.targetFolderId || '')
    || (step.targetFolderPath || '') !== (target.targetFolderPath || '')
    || typeof step.documentId !== 'string'
    || !selectedDocumentIds.has(step.documentId)
  ));
  const incompleteDocument = expectedDocumentIds.find((documentId) => (
    REQUIRED_PLAN_KINDS_PER_DOCUMENT.some((kind) => (
      plan.steps.filter((step) => step.documentId === documentId && step.kind === kind).length !== 1
    ))
  ));
  if (!unsafeStep && !incompleteDocument) return undefined;
  return fixedException(
    target.id,
    'PLAN_BLOCKED',
    'target',
    'Automatic preparation found a target-scoped conflict that must be resolved before copying.',
    target.id,
  );
}

function writeBearingPatches(target: MigrationTarget) {
  return (target.semanticPatches || []).filter((patch) => patch.resolution !== 'keep_target');
}

export function dashboardSafeCopySemanticPatchProofHash(target: MigrationTarget): string | undefined {
  const patches = writeBearingPatches(target);
  if (patches.length !== 1) return undefined;
  const patch = patches[0];
  const fileName = patch.targetFileName?.trim();
  const previousChecksum = patch.previousChecksum?.trim();
  const acceptedYaml = patch.acceptedYaml?.trim();
  if (!fileName || !previousChecksum || !acceptedYaml) return undefined;
  return sha256({
    fileName,
    previousChecksum,
    expectedYamlHash: sha256(acceptedYaml),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function loadFreshTargetYamlSnapshot(
  target: MigrationTarget,
): Promise<DashboardSafeCopyTargetYamlSnapshot> {
  const modelId = target.targetModelId?.trim();
  const destination = getInstance(target.destinationInstanceId);
  if (!destination || !modelId) throw new Error('Target model snapshot is unavailable.');
  const response = await new OmniClient(destination).getModelYaml(modelId, { includeChecksums: true });
  if (!isRecord(response.raw)) throw new Error('Target model snapshot is incomplete.');
  const rawFiles = response.raw.files;
  const rawChecksums = response.raw.checksums;
  if (!isRecord(rawFiles) || !isRecord(rawChecksums)) {
    throw new Error('Target model snapshot is incomplete.');
  }
  if (
    Object.values(rawFiles).some((value) => typeof value !== 'string')
    || Object.values(rawChecksums).some((value) => typeof value !== 'string')
  ) {
    throw new Error('Target model snapshot is malformed.');
  }
  return {
    files: rawFiles as Record<string, string>,
    checksums: rawChecksums as Record<string, string>,
  };
}

function validateTargetPatchSafety(
  target: MigrationTarget,
  snapshot: DashboardSafeCopyTargetYamlSnapshot,
  validator: typeof validateAdditiveDashboardSafeCopyPatches,
): DashboardSafeCopyPatchSafetyResult {
  const currentFiles = Object.fromEntries(Object.entries(snapshot.files).map(([fileName, yaml]) => [
    fileName,
    { yaml, checksum: snapshot.checksums[fileName] },
  ]));
  return validator({
    patches: target.semanticPatches || [],
    currentFiles,
  });
}

function scratchValidationPassed(
  result: DashboardPatchValidationResult,
  target: MigrationTarget,
): boolean {
  if (result.status !== 'passed') return false;
  if (result.results.length !== 1) return false;
  const targetResult = result.results[0];
  if (
    targetResult.targetId !== target.id
    || targetResult.destinationId !== target.destinationInstanceId
    || targetResult.targetModelId !== target.targetModelId
    || targetResult.mode !== 'branch'
    || targetResult.status !== 'passed'
    || Boolean(targetResult.cleanupError)
  ) return false;
  const writePatches = writeBearingPatches(target);
  if (writePatches.length === 0) return false;
  const artifactKey = (value: {
    id: string;
    artifactType: string;
    targetFileName: string;
  }): string => `${value.id}\u0000${value.artifactType}\u0000${value.targetFileName}`;
  const expectedArtifacts = (target.semanticPatches || []).map((patch) => (
    `${artifactKey(patch)}\u0000${patch.resolution === 'keep_target' ? 'skipped' : 'passed'}`
  )).sort();
  const actualArtifacts = targetResult.artifacts.map((artifact) => (
    `${artifactKey(artifact)}\u0000${artifact.status}`
  )).sort();
  return JSON.stringify(actualArtifacts) === JSON.stringify(expectedArtifacts);
}

async function resolveOneTarget(
  intent: DashboardSafeCopyIntent,
  destination: DashboardSafeCopyDestination,
  persistedTarget: MigrationTarget,
  dependencies: DashboardSafeCopyPreparationDependencies,
): Promise<DashboardSafeCopyTargetPreparation> {
  if (!targetMatchesDestination(persistedTarget, destination)) {
    return fixedException(
      destination.targetId,
      'TARGET_SCOPE_MISMATCH',
      'target',
      'The persisted target does not match the canonical safe-copy request.',
      destination.targetId,
    );
  }
  const buildPlan = dependencies.buildPlan || buildMigrationPlan;
  const resolveTarget = dependencies.resolveTarget || resolveDashboardSafeCopyTarget;
  const validatePatches = dependencies.validatePatches || validateDashboardMigrationPatches;
  const validatePatchSafety = dependencies.validatePatchSafety || validateAdditiveDashboardSafeCopyPatches;
  const loadTargetYamlSnapshot = dependencies.loadTargetYamlSnapshot || loadFreshTargetYamlSnapshot;
  let target = { ...persistedTarget };
  const repairRequired = (candidate: MigrationTarget) => intent.deployment && writeBearingPatches(candidate).length > 0
    ? fixedException(
      candidate.id,
      'REPAIR_REQUIRED',
      'semantic_patch',
      'Repair model dependencies in Model Migrator, then rerun compatibility checks before deploying dashboards.',
      candidate.id,
    )
    : undefined;
  const initialRepair = repairRequired(target);
  if (initialRepair) return initialRepair;
  const evidenceContext: Parameters<typeof buildMigrationPlan>[1] = {};
  if (intent.deployment) {
    const reviewedPlan = getDashboardDeploymentPlan(intent.deployment.planId);
    if (reviewedPlan.intent.source.instanceId !== intent.source.instanceId
      || !reviewedPlan.intent.destinations.some((row) => row.targetId === destination.targetId && row.instanceId === destination.instanceId && row.modelId === destination.modelId)) {
      throw new Error('The reconstructed-topic review does not match this deployment.');
    }
    if (reviewedPlan.topicRepairReceipts?.length) {
      const snapshots = new Map<string, ReturnType<OmniClient['getModelYaml']>>();
      const snapshot = (instanceId: string, modelId: string, mode?: 'extension') => {
        const key = JSON.stringify([instanceId, modelId, mode]);
        if (!snapshots.has(key)) snapshots.set(key, new OmniClient(getInstance(instanceId)!).getModelYaml(modelId, { fullyResolved: false, ...(mode ? { mode } : {}) }));
        return snapshots.get(key)!;
      };
      evidenceContext.reconstructedTopics = await readReviewedReconstructedTopics(reviewedPlan,
        async (modelId) => (await snapshot(intent.source.instanceId, modelId)).files,
        async (instanceId, modelId) => (await snapshot(instanceId, modelId)).files,
        async (modelId) => (await snapshot(intent.source.instanceId, modelId, 'extension')).files,
        async (instanceId, modelId) => (await snapshot(instanceId, modelId)).raw);
    }
  }
  let plan = await buildPlan(inputForTarget(intent, target), evidenceContext);
  let converged = false;

  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass += 1) {
    const resolved = resolveTarget(plan, target);
    if (resolved.status === 'exception') {
      return {
        status: 'needs_attention',
        targetId: target.id,
        exceptions: resolved.exceptions,
      };
    }
    const nextTarget = resolved.target;
    const requiredRepair = repairRequired(nextTarget);
    if (requiredRepair) return requiredRepair;
    if (!targetMatchesDestination(nextTarget, destination)) {
      return fixedException(
        target.id,
        'TARGET_SCOPE_MISMATCH',
        'target',
        'Automatic resolution attempted to change the immutable destination scope.',
        target.id,
      );
    }
    const priorFingerprint = dashboardSafeCopyTargetDecisionFingerprint(target);
    const nextFingerprint = dashboardSafeCopyTargetDecisionFingerprint(nextTarget);
    target = nextTarget;
    if (priorFingerprint === nextFingerprint) {
      converged = true;
      break;
    }
    plan = await buildPlan(inputForTarget(intent, target), evidenceContext);
  }

  if (!converged) {
    return fixedException(
      target.id,
      'PLAN_DID_NOT_CONVERGE',
      'target',
      'Automatic preparation did not converge on one deterministic target plan.',
      target.id,
    );
  }

  const unsafe = unsafePlanException(plan, target, intent, destination);
  if (unsafe) return unsafe;

  let targetSnapshot: DashboardSafeCopyTargetYamlSnapshot = { files: {}, checksums: {} };
  if (writeBearingPatches(target).length > 0) {
    try {
      targetSnapshot = await loadTargetYamlSnapshot(target);
    } catch {
      return fixedException(
        target.id,
        'MISSING_EVIDENCE',
        'semantic_patch',
        'A fresh checksum-bearing destination model snapshot is required for automatic changes.',
        target.id,
      );
    }
  }

  const patchSafety = validateTargetPatchSafety(target, targetSnapshot, validatePatchSafety);
  if (patchSafety.status !== 'passed') {
    return {
      status: 'needs_attention',
      targetId: target.id,
      exceptions: patchSafety.exceptions.map((exception) => ({
        targetId: target.id,
        code: exception.code,
        artifact: 'semantic_patch',
        reference: exception.targetFileName,
        message: exception.message,
      })),
    };
  }

  const patches = writeBearingPatches(target);
  let scratchValidation: DashboardSafeCopyPreparedTarget['scratchValidation'] = 'not_required';
  if (patches.length > 0) {
    const validation = await validatePatches(inputForTarget(intent, target));
    if (!scratchValidationPassed(validation, target)) {
      return fixedException(
        target.id,
        'SCRATCH_VALIDATION_FAILED',
        'semantic_patch',
        'The generated additive model changes did not pass exact isolated-branch validation.',
        target.id,
      );
    }
    scratchValidation = 'passed';
  }

  return {
    status: 'ready',
    targetId: target.id,
    target,
    plan,
    decisionFingerprint: dashboardSafeCopyTargetDecisionFingerprint(target),
    planFingerprint: planFingerprint(plan, target),
    patchCount: patches.length,
    scratchValidation,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return results;
}

export async function prepareDashboardSafeCopyTargets(
  intent: DashboardSafeCopyIntent,
  persistedTargets: readonly MigrationTarget[],
  dependencies: DashboardSafeCopyPreparationDependencies = {},
  onTargetPrepared?: DashboardSafeCopyTargetPreparationListener,
): Promise<DashboardSafeCopyTargetPreparation[]> {
  const byId = new Map(persistedTargets.map((target) => [target.id, target]));
  return mapWithConcurrency(
    intent.destinations,
    TARGET_PREPARATION_CONCURRENCY,
    async (destination) => {
      const persistedTarget = byId.get(destination.targetId);
      let result: DashboardSafeCopyTargetPreparation;
      if (!persistedTarget) {
        result = fixedException(
          destination.targetId,
          'TARGET_SCOPE_MISMATCH',
          'target',
          'The persisted job does not contain this canonical destination target.',
          destination.targetId,
        );
      } else {
        try {
          result = await resolveOneTarget(intent, destination, persistedTarget, dependencies);
        } catch {
          result = fixedException(
            destination.targetId,
            'PREPARATION_FAILED',
            'target',
            'Automatic preparation could not safely inspect this destination.',
            destination.targetId,
          );
        }
      }
      await onTargetPrepared?.(result);
      return result;
    },
  );
}

function summaryItem(
  job: MigrationJob,
  result: DashboardSafeCopyTargetPreparation,
): MigrationJobItem {
  const target = job.targets?.find((candidate) => candidate.id === result.targetId);
  const common: MigrationJobItem = {
    id: `safe-copy-preparation:${sha256(result.targetId)}`,
    jobId: job.id,
    targetId: result.targetId,
    destinationId: target?.destinationInstanceId || '',
    destinationLabel: target?.destinationLabel || 'Destination',
    targetModelId: target?.targetModelId,
    targetModelName: target?.targetModelName,
    targetFolderId: target?.targetFolderId,
    targetFolderPath: target?.targetFolderPath,
    kind: 'semantic_validate',
    status: result.status === 'ready' ? 'succeeded' : 'failed',
    startedAt: Date.now(),
    endedAt: Date.now(),
    details: {
      safeCopyPreparationSummary: true,
      safeCopyTargetStatus: result.status,
      safeCopyResolverVersion: DASHBOARD_SAFE_COPY_RESOLVER_VERSION,
    },
  };
  if (result.status === 'ready') {
    const semanticProofHash = dashboardSafeCopySemanticPatchProofHash(result.target);
    return {
      ...common,
      details: {
        ...common.details,
        safeCopyDecisionFingerprint: result.decisionFingerprint,
        safeCopyPlanFingerprint: result.planFingerprint,
        safeCopyPatchCount: result.patchCount,
        safeCopyScratchValidation: result.scratchValidation,
        ...(semanticProofHash ? { safeCopySemanticProofHash: semanticProofHash } : {}),
      },
    };
  }
  const semanticArtifacts = new Set(['field', 'query_view', 'topic', 'relationship', 'semantic_patch']);
  const modelChoiceCodes = new Set([
    'UNSAFE_TARGET_CONFIGURATION',
    'AMBIGUOUS_MAPPING',
    'MISSING_EVIDENCE',
    'BLOCKED_DEPENDENCY',
    'MANUAL_REVIEW_REQUIRED',
    'PLAN_DID_NOT_CONVERGE',
    'PLAN_BLOCKED',
    'SCRATCH_VALIDATION_FAILED',
  ]);
  const canSelectTargetModel = result.exceptions.some((issue) => (
    modelChoiceCodes.has(issue.code) && semanticArtifacts.has(issue.artifact)
  ));
  const canOpenModelMigrator = result.exceptions.some((issue) => (
    semanticArtifacts.has(issue.artifact)
    || (issue.artifact === 'permission' && issue.code === 'SECURITY_REVIEW_REQUIRED')
  ));
  const recommendedActions = [
    ...(canSelectTargetModel ? ['select_target_model'] : []),
    ...(canOpenModelMigrator ? ['open_model_migrator'] : []),
  ];
  return {
    ...common,
    error: result.exceptions[0]?.message || 'This destination needs attention.',
    details: {
      ...common.details,
      safeCopyExceptions: result.exceptions,
      safeCopyRecommendedActions: recommendedActions,
    },
  };
}

function publishJob(job: MigrationJob): void {
  publishMigrationJobEvent({
    type: 'job',
    jobId: job.id,
    status: job.status,
    at: Date.now(),
    job,
  });
}

function preparationSummaryForTarget(job: MigrationJob, targetId: string): MigrationJobItem | undefined {
  const matches = job.items.filter((item) => (
    item.targetId === targetId && item.details?.safeCopyPreparationSummary === true
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

function persistPreparationSummary(
  jobId: string,
  intent: DashboardSafeCopyIntent,
  result: DashboardSafeCopyTargetPreparation,
): void {
  const destinationsById = new Map(intent.destinations.map((destination) => [destination.targetId, destination]));
  const updated = updateJobAtomically(jobId, (current) => {
    const target = current.targets?.find((candidate) => candidate.id === result.targetId);
    const destination = destinationsById.get(result.targetId);
    if (
      current.status !== 'pending'
      || current.details?.safeCopyProfile !== 'safe_copy_v1'
      || current.details?.safeCopyIntentHash !== dashboardSafeCopyIntentHash(intent)
      || current.details?.safeCopyPreparationState !== 'resolving'
      || !target
      || !destination
      || !targetMatchesDestination(target, destination)
      || current.items.some((item) => item.details?.safeCopyPreparationSummary !== true)
    ) throw new Error('Safe-copy preparation scope changed before target persistence.');
    const existing = current.items.filter((item) => (
      item.targetId === result.targetId && item.details?.safeCopyPreparationSummary === true
    ));
    if (existing.length > 1) throw new Error('Safe-copy preparation contains duplicate target evidence.');
    if (existing.length === 1) return current;
    const items = [...current.items, summaryItem(current, result)];
    const readyCount = items.filter((item) => (
      item.details?.safeCopyPreparationSummary === true
      && item.details.safeCopyTargetStatus === 'ready'
      && item.status === 'succeeded'
    )).length;
    const summaryCount = items.filter((item) => item.details?.safeCopyPreparationSummary === true).length;
    return {
      ...current,
      details: {
        ...(current.details || {}),
        safeCopyReadyTargetCount: readyCount,
        safeCopyExceptionTargetCount: summaryCount - readyCount,
      },
      items,
    };
  });
  if (!updated) throw new Error('Safe-copy preparation job disappeared before target persistence.');
  const stored = getJob(jobId);
  if (!stored) throw new Error('Safe-copy preparation job disappeared after target persistence.');
  publishJob(stored);
}

export async function prepareDashboardSafeCopyJob(
  jobId: string,
  intent: DashboardSafeCopyIntent,
  dependencies: DashboardSafeCopyPreparationDependencies = {},
): Promise<void> {
  if (preparingJobs.has(jobId)) return;
  preparingJobs.add(jobId);
  try {
    const existing = getJob(jobId);
    if (
      !existing
      || existing.status !== 'pending'
      || existing.details?.safeCopyProfile !== 'safe_copy_v1'
      || existing.details?.safeCopyIntentHash !== dashboardSafeCopyIntentHash(intent)
      || !existing.targets
    ) return;

    const preparationState = existing.details?.safeCopyPreparationState;
    const hasCompletePreparationLedger = (
      (preparationState === 'prepared' || preparationState === 'needs_attention')
      && existing.targets.every((target) => (
        existing.items.filter((item) => (
          item.targetId === target.id && item.details?.safeCopyPreparationSummary === true
        )).length === 1
      ))
    );
    if (hasCompletePreparationLedger) return;

    updateJobStatus({
      ...existing,
      details: {
        ...(existing.details || {}),
        safeCopyPreparationState: 'resolving',
      },
    });
    const resolving = getJob(jobId);
    if (resolving) publishJob(resolving);

    const destinationsById = new Map(intent.destinations.map((destination) => [destination.targetId, destination]));
    const resolvingJob = getJob(jobId);
    if (!resolvingJob?.targets) return;
    const existingSummaryTargetIds = new Set(resolvingJob.items.flatMap((item) => (
      item.details?.safeCopyPreparationSummary === true && item.targetId ? [item.targetId] : []
    )));
    if (
      resolvingJob.items.some((item) => item.details?.safeCopyPreparationSummary !== true)
      || existingSummaryTargetIds.size !== resolvingJob.items.length
    ) return;
    const pendingDestinations = intent.destinations.filter((destination) => !existingSummaryTargetIds.has(destination.targetId));
    if (pendingDestinations.length > 0) {
      // Creation-time role checks are not authority for later queued reads.
      assertDashboardSafeCopyInstanceRoles(intent);
      const pendingTargetIds = new Set(pendingDestinations.map((destination) => destination.targetId));
      const pendingIntent = scopeDashboardSafeCopyIntent(intent, pendingTargetIds);
      const pendingTargets = resolvingJob.targets.filter((target) => pendingTargetIds.has(target.id));
      const results = await prepareDashboardSafeCopyTargets(
        pendingIntent,
        pendingTargets,
        dependencies,
        async (result) => {
          try {
            persistPreparationSummary(jobId, intent, result);
          } catch {
            // The final exact-ledger pass below retries a transient per-target store failure.
          }
        },
      );
      for (const result of results) {
        const current = getJob(jobId);
        if (!current || preparationSummaryForTarget(current, result.targetId)) continue;
        persistPreparationSummary(jobId, intent, result);
      }
    }
    const latest = getJob(jobId);
    if (
      !latest
      || latest.status !== 'pending'
      || latest.details?.safeCopyProfile !== 'safe_copy_v1'
      || latest.details?.safeCopyIntentHash !== dashboardSafeCopyIntentHash(intent)
      || latest.details?.safeCopyPreparationState !== 'resolving'
      || latest.targets?.length !== intent.destinations.length
      || latest.items.some((item) => item.details?.safeCopyPreparationSummary !== true)
      || latest.targets.some((target) => !preparationSummaryForTarget(latest, target.id))
      || latest.targets.some((target) => {
        const destination = destinationsById.get(target.id);
        return !destination || !targetMatchesDestination(target, destination);
      })
    ) return;
    const readyCount = latest.items.filter((item) => (
      item.details?.safeCopyPreparationSummary === true
      && item.details.safeCopyTargetStatus === 'ready'
      && item.status === 'succeeded'
    )).length;
    const exceptionCount = latest.targets.length - readyCount;
    const next: MigrationJob = {
      ...latest,
      status: readyCount > 0 ? 'pending' : 'failed',
      ...(readyCount === 0 ? { endedAt: Date.now() } : {}),
      details: {
        ...(latest.details || {}),
        safeCopyPreparationState: readyCount === 0
          ? 'failed'
          : exceptionCount > 0
            ? 'needs_attention'
            : 'prepared',
        safeCopyReadyTargetCount: readyCount,
        safeCopyExceptionTargetCount: exceptionCount,
      },
      items: latest.items,
    };
    updateJobStatus(next);
    const stored = getJob(jobId);
    if (stored) publishJob(stored);
  } finally {
    preparingJobs.delete(jobId);
  }
}
