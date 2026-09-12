import type { MigrationJob, SavedInstancePublic } from './opsConsole';
import type { DashboardDeploymentHandoff, DashboardDeploymentPlan, DashboardDeploymentTargetReadiness } from '../../shared/dashboardDeploymentPlan';

const MAX_HANDOFF_VALUE_LENGTH = 256;
const CANONICAL_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF_KEYS = new Set([
  'version',
  'source',
  'jobId',
  'targetId',
  'sourceInstanceId',
  'sourceConnectionId',
  'targetInstanceId',
  'targetConnectionId',
  'targetModelId',
]);

export interface DashboardSafeCopyModelMigratorHandoff {
  version: 1;
  source: 'dashboard_safe_copy_v1';
  jobId: string;
  targetId: string;
  sourceInstanceId: string;
  sourceConnectionId: string;
  targetInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
}

export interface ModelMigratorHandoffResolution {
  status: 'ready' | 'invalid';
  handoff?: DashboardSafeCopyModelMigratorHandoff;
  message?: string;
}

export interface DashboardModelRepairScope {
  handoff: DashboardDeploymentHandoff;
  revision: number;
  sourceInstanceId: string;
  sourceConnectionId: string;
  sourceModelIds: string[];
  documentIds: string[];
  targetInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
  readiness: DashboardDeploymentTargetReadiness;
  scopeReviewRequired?: string;
}

function exactString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HANDOFF_VALUE_LENGTH) return '';
  if (value !== value.trim() || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return '';
  return value;
}

/** Enough evidence to inspect a bounded source scope, without authorizing a repair. */
export function canReviewUnverifiedDashboardDependencies(readiness: DashboardDeploymentTargetReadiness): boolean {
  return readiness.status === 'unverified'
    && readiness.sourceModelIds.length > 0
    && readiness.sourceModelIds.every((id) => Boolean(exactString(id)))
    && readiness.requiredFiles.length > 0
    && readiness.requiredFiles.every((file) => Boolean(exactString(file)));
}

export function parseDashboardDeploymentModelMigratorHandoff(value: unknown): DashboardDeploymentHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['version', 'source', 'planId', 'targetId'].includes(key))) return null;
  if (row.version !== 2 || row.source !== 'dashboard_deployment_plan') return null;
  const planId = exactString(row.planId);
  const targetId = exactString(row.targetId);
  if (!CANONICAL_JOB_ID.test(planId) || !targetId) return null;
  return { version: 2, source: 'dashboard_deployment_plan', planId, targetId };
}

export function dashboardDeploymentModelMigratorHandoffFromSearch(search: string): DashboardDeploymentHandoff | null {
  const params = new URLSearchParams(search);
  if (params.getAll('planId').length !== 1 || params.getAll('targetId').length !== 1) return null;
  return parseDashboardDeploymentModelMigratorHandoff({
    version: 2,
    source: 'dashboard_deployment_plan',
    planId: params.get('planId'),
    targetId: params.get('targetId'),
  });
}

/** Route identifiers locate a durable plan; all migration identities come from the reread plan. */
export function resolveDashboardDeploymentModelMigratorHandoff(
  value: unknown,
  plan: DashboardDeploymentPlan,
  instances: Array<Pick<SavedInstancePublic, 'id' | 'role'>>,
): DashboardModelRepairScope {
  const handoff = parseDashboardDeploymentModelMigratorHandoff(value);
  if (!handoff || plan.version !== 2 || plan.id !== handoff.planId) {
    throw new Error('The dashboard dependency repair plan does not match this handoff.');
  }
  const destination = plan.intent.destinations.find((target) => target.targetId === handoff.targetId);
  const readiness = plan.targets.find((target) => target.targetId === handoff.targetId);
  if (!destination || !readiness) throw new Error('The selected dashboard deployment target is no longer in this plan.');
  const source = instances.find((instance) => instance.id === plan.intent.source.instanceId);
  const target = instances.find((instance) => instance.id === destination.instanceId);
  if (!source || !target) throw new Error('The dashboard repair instances are no longer available.');
  if (source.role !== 'source' && source.role !== 'both') throw new Error('The dashboard repair source is not authorized for source operations.');
  if (target.role !== 'destination' && target.role !== 'both') throw new Error('The dashboard repair target is not authorized for destination operations.');
  const sourceModelIds = [...new Set(readiness.sourceModelIds.filter((id) => exactString(id)))];
  const requiredFiles = [...new Set(readiness.requiredFiles.filter((file) => exactString(file)))];
  const filesByModel = sourceModelIds.flatMap((modelId) => readiness.requiredFilesByModelId?.[modelId] || []);
  let scopeReviewRequired: string | undefined;
  if (readiness.status === 'unverified') {
    scopeReviewRequired = 'Deployment and automatic model repair are blocked because dependency evidence is incomplete or ambiguous. Inspect the identified source model and dashboard workbook, including workbook-local definitions and inherited semantics, to establish the required fields and their source files. Missing source evidence does not establish that the target is missing those fields. Restore source access or resolve the definitions manually in Omni, review any target changes through the normal model review process, then return to recheck dashboard readiness.';
  } else if (readiness.status !== 'model_changes_required') {
    scopeReviewRequired = 'Return to dashboard deployment and recheck dependencies before preparing model changes.';
  } else if (sourceModelIds.length === 0 || sourceModelIds.length !== readiness.sourceModelIds.length || sourceModelIds.some((modelId) => (
    !readiness.requiredFilesByModelId?.[modelId]?.length
    || readiness.requiredFilesByModelId[modelId].some((name) => !exactString(name) || !requiredFiles.includes(name))
  ))) {
    scopeReviewRequired = 'Dependency scope needs review: the plan must identify required files for every source model before this repair can run.';
  } else if (requiredFiles.length === 0 || requiredFiles.length !== readiness.requiredFiles.length) {
    scopeReviewRequired = 'Dependency scope needs review: this plan has no complete set of required model files. Return to dashboard deployment and recheck.';
  } else if (filesByModel.length !== new Set(filesByModel).size || requiredFiles.some((name) => !filesByModel.includes(name))) {
    scopeReviewRequired = 'Dependency scope needs review: required files have missing or conflicting source model ownership.';
  } else if (source.id === target.id && sourceModelIds.includes(destination.modelId)) {
    scopeReviewRequired = 'The source and target refer to the same model. Review its dependencies directly before rechecking dashboard deployment.';
  }
  return {
    handoff,
    revision: plan.revision,
    sourceInstanceId: source.id,
    sourceConnectionId: plan.intent.source.connectionId,
    sourceModelIds,
    documentIds: [...plan.intent.source.documentIds],
    targetInstanceId: target.id,
    targetConnectionId: destination.connectionId,
    targetModelId: destination.modelId,
    readiness: { ...readiness, requiredFiles },
    ...(scopeReviewRequired ? { scopeReviewRequired } : {}),
  };
}

export function scopeDashboardModelRepairTranslation<T extends {
  files: Array<{ fileName: string }>;
  checksums: Record<string, string>;
  semanticDecisions: Array<{ sourceFileName?: string; targetFileName?: string }>;
  prompts: Array<{ fileName: string; prompt: string }>;
}>(translation: T, scope: DashboardModelRepairScope, sourceModelId: string): T {
  if (scope.scopeReviewRequired) throw new Error(scope.scopeReviewRequired);
  const required = new Set(scope.readiness.requiredFilesByModelId?.[sourceModelId] || []);
  const files = translation.files.filter((file) => required.has(file.fileName));
  const available = new Set(files.map((file) => file.fileName));
  if (required.size === 0 || [...required].some((fileName) => !available.has(fileName))) {
    throw new Error('Dependency scope needs review: required files were not returned for this source model. No whole-model repair was selected.');
  }
  return {
    ...translation,
    files,
    checksums: Object.fromEntries(Object.entries(translation.checksums).filter(([name]) => required.has(name))),
    semanticDecisions: translation.semanticDecisions.filter((decision) => (
      Boolean(decision.sourceFileName && required.has(decision.sourceFileName))
      && (!decision.targetFileName || required.has(decision.targetFileName))
    )),
    prompts: translation.prompts.filter((prompt) => required.has(prompt.fileName)),
  };
}

export function createDashboardSafeCopyModelMigratorHandoff(
  input: Omit<DashboardSafeCopyModelMigratorHandoff, 'version' | 'source'>,
): DashboardSafeCopyModelMigratorHandoff {
  const parsed = parseDashboardSafeCopyModelMigratorHandoff({
    version: 1,
    source: 'dashboard_safe_copy_v1',
    ...input,
  });
  if (!parsed) throw new Error('The Model Migrator repair scope is incomplete or invalid.');
  return parsed;
}

export function parseDashboardSafeCopyModelMigratorHandoff(
  value: unknown,
): DashboardSafeCopyModelMigratorHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !HANDOFF_KEYS.has(key))) return null;
  if (record.version !== 1 || record.source !== 'dashboard_safe_copy_v1') return null;
  const jobId = exactString(record.jobId);
  const targetId = exactString(record.targetId);
  const sourceInstanceId = exactString(record.sourceInstanceId);
  const sourceConnectionId = exactString(record.sourceConnectionId);
  const targetInstanceId = exactString(record.targetInstanceId);
  const targetConnectionId = exactString(record.targetConnectionId);
  const targetModelId = exactString(record.targetModelId);
  if (
    !CANONICAL_JOB_ID.test(jobId)
    || !targetId
    || !sourceInstanceId
    || !sourceConnectionId
    || !targetInstanceId
    || !targetConnectionId
    || !targetModelId
  ) return null;
  return {
    version: 1,
    source: 'dashboard_safe_copy_v1',
    jobId,
    targetId,
    sourceInstanceId,
    sourceConnectionId,
    targetInstanceId,
    targetConnectionId,
    targetModelId,
  };
}

export function resolveDashboardSafeCopyModelMigratorHandoff(
  value: unknown,
  instances: Array<Pick<SavedInstancePublic, 'id' | 'role'>>,
): ModelMigratorHandoffResolution {
  const handoff = parseDashboardSafeCopyModelMigratorHandoff(value);
  if (!handoff) {
    return { status: 'invalid', message: 'The dashboard repair handoff was invalid and was not applied.' };
  }
  const source = instances.find((instance) => instance.id === handoff.sourceInstanceId);
  const target = instances.find((instance) => instance.id === handoff.targetInstanceId);
  if (!source || !target) {
    return { status: 'invalid', message: 'The dashboard repair instances are no longer available.' };
  }
  if (source.role !== 'source' && source.role !== 'both') {
    return { status: 'invalid', message: 'The dashboard repair source is not authorized for source operations.' };
  }
  if (target.role !== 'destination' && target.role !== 'both') {
    return { status: 'invalid', message: 'The dashboard repair target is not authorized for destination operations.' };
  }
  return { status: 'ready', handoff };
}

export function dashboardSafeCopyModelMigratorHandoffMatchesJob(
  handoff: DashboardSafeCopyModelMigratorHandoff,
  job: MigrationJob,
): boolean {
  if (
    job.id !== handoff.jobId
    || job.workflow !== 'dashboard'
    || job.details?.safeCopyProfile !== 'safe_copy_v1'
    || job.details?.operationMode !== 'safe_copy'
    || job.sourceId !== handoff.sourceInstanceId
    || job.sourceConnectionId !== handoff.sourceConnectionId
    || job.status === 'succeeded'
    || job.status === 'canceled'
  ) return false;
  const target = job.targets?.find((row) => row.id === handoff.targetId);
  if (
    !target
    || target.destinationInstanceId !== handoff.targetInstanceId
    || target.targetConnectionId !== handoff.targetConnectionId
    || target.targetModelId !== handoff.targetModelId
  ) return false;
  const targetItems = job.items.filter((item) => item.targetId === handoff.targetId);
  const hasUnresolvedWrite = targetItems.some((item) => {
    if (item.details?.safeCopyAttempt !== true) return false;
    const state = item.details.safeCopyAttemptState;
    return state === 'dispatched' || state === 'uncertain';
  });
  if (hasUnresolvedWrite) return false;
  const executionSummary = targetItems
    .filter((item) => item.details?.safeCopyTargetExecutionSummary === true)
    .sort((left, right) => Number(right.endedAt || right.startedAt || 0) - Number(left.endedAt || left.startedAt || 0))[0];
  if (executionSummary) {
    return executionSummary.details?.safeCopyTargetStatus === 'needs_attention'
      && Array.isArray(executionSummary.details.safeCopyRecommendedActions)
      && executionSummary.details.safeCopyRecommendedActions.includes('open_model_migrator');
  }
  const preparationSummary = targetItems.find((item) => item.details?.safeCopyPreparationSummary === true);
  return preparationSummary?.details?.safeCopyTargetStatus === 'needs_attention'
    && Array.isArray(preparationSummary.details.safeCopyRecommendedActions)
    && preparationSummary.details.safeCopyRecommendedActions.includes('open_model_migrator');
}
