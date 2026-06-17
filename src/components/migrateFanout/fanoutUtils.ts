import type {
  InstanceDocument,
  InstanceFolder,
  InstanceModel,
  MigrationJob,
  MigrationJobItem,
  MigrationPlan,
  MigrationPlanStep,
  MigrationTarget,
} from '@/services/opsConsole';
import type { ComboBoxOption } from '@/components/ui/comboBoxUtils';
import type { DestinationProgress, PreflightTargetRow } from './fanoutTypes';

const MODEL_PLACEHOLDER_VALUES = new Set(['unknown', 'model unknown', 'model not detected', 'not detected', 'n/a', 'none', '-']);

export const TARGET_MODEL_COMBOBOX_CONFIG = {
  allowFreeText: false,
  emptyLabel: 'No models found',
} as const;

export const TARGET_FOLDER_COMBOBOX_CONFIG = {
  allowFreeText: true,
  emptyLabel: 'No folders found; type a new folder path',
} as const;

export function cleanFanoutModelMetadata(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return MODEL_PLACEHOLDER_VALUES.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

export function fanoutDocumentModelLabel(
  document: { baseModelId?: string | null; baseModelName?: string | null },
  sourceModelNameById: Map<string, string> = new Map(),
) {
  const baseModelName = cleanFanoutModelMetadata(document.baseModelName);
  const baseModelId = cleanFanoutModelMetadata(document.baseModelId);
  if (baseModelName) return { label: baseModelName, detected: true };
  if (baseModelId) return { label: sourceModelNameById.get(baseModelId) || baseModelId, detected: true };
  return { label: 'Model unavailable from export', detected: false };
}

function sourceModelDisplayName(model: Pick<InstanceModel, 'id' | 'name' | 'identifier' | 'baseModelId'>) {
  return cleanFanoutModelMetadata(model.name)
    || cleanFanoutModelMetadata(model.identifier)
    || cleanFanoutModelMetadata(model.baseModelId)
    || model.id;
}

function documentMatchesSelectedFolderScope(
  document: Pick<InstanceDocument, 'folderId' | 'folderPath'>,
  sourceFolderId?: string | null,
  sourceFolderPath?: string | null,
  documentCount = 0,
) {
  const sourceFolderKeys = [sourceFolderPath, sourceFolderId]
    .map(cleanFanoutModelMetadata)
    .filter((value): value is string => Boolean(value));
  if (sourceFolderKeys.length === 0) return documentCount === 1;

  const documentFolderKeys = [document.folderPath, document.folderId]
    .map(cleanFanoutModelMetadata)
    .filter((value): value is string => Boolean(value));
  if (documentFolderKeys.length === 0) return documentCount === 1;

  return documentFolderKeys.some((key) => sourceFolderKeys.includes(key));
}

export function applySelectedSourceModelFallback(
  documents: InstanceDocument[],
  options: {
    sourceModelId?: string | null;
    sourceModels: Array<Pick<InstanceModel, 'id' | 'name' | 'identifier' | 'baseModelId'>>;
    sourceFolderId?: string | null;
    sourceFolderPath?: string | null;
  },
): InstanceDocument[] {
  const sourceModelId = cleanFanoutModelMetadata(options.sourceModelId);
  if (!sourceModelId) return documents;

  const sourceModel = options.sourceModels.find((model) => (
    [model.id, model.identifier, model.baseModelId, model.name]
      .map(cleanFanoutModelMetadata)
      .some((value) => value === sourceModelId)
  ));
  if (!sourceModel) return documents;

  const fallbackName = sourceModelDisplayName(sourceModel);
  return documents.map((document) => {
    const existingModelId = cleanFanoutModelMetadata(document.baseModelId);
    const existingModelName = cleanFanoutModelMetadata(document.baseModelName);
    if (existingModelId || existingModelName) return document;
    if (!documentMatchesSelectedFolderScope(document, options.sourceFolderId, options.sourceFolderPath, documents.length)) {
      return document;
    }
    return {
      ...document,
      baseModelId: sourceModel.id,
      baseModelName: fallbackName,
    };
  });
}

export function getFanoutPreflightBlockReason(input: {
  sourceId?: string | null;
  selectedDocumentIds: string[];
  targets: Array<Pick<MigrationTarget, 'destinationInstanceId' | 'destinationLabel' | 'targetModelId' | 'targetFolderId' | 'targetFolderPath'>>;
  hasLoadingTargets: boolean;
  hasUnresolvedFolderTargets: boolean;
  preflightLoading: boolean;
  jobBusy: boolean;
}) {
  if (input.jobBusy) return 'Wait for the current migration action to finish.';
  if (input.preflightLoading) return 'Preflight is already running.';
  if (!input.sourceId) return 'Choose a source instance before running preflight.';
  if (input.selectedDocumentIds.length === 0) return 'Select at least one source dashboard before running preflight.';
  if (input.targets.length === 0) return 'Select at least one destination instance before running preflight.';
  const missingDestinationIndex = input.targets.findIndex((target) => !target.destinationInstanceId);
  if (missingDestinationIndex >= 0) return `Choose a destination instance for target ${missingDestinationIndex + 1}.`;
  if (input.hasLoadingTargets) return 'Wait for destination model and folder catalogs to finish loading.';
  const missingModel = input.targets.find((target) => !target.targetModelId);
  if (missingModel) return `Choose a target model for ${missingModel.destinationLabel || missingModel.destinationInstanceId}.`;
  if (input.hasUnresolvedFolderTargets) return 'Choose a folder path for saved folder IDs before running preflight.';
  return '';
}

export function buildTargetModelOptions(
  models: Array<Pick<InstanceModel, 'id' | 'name' | 'identifier' | 'kind'>>,
): ComboBoxOption[] {
  return models.map((model) => ({
    value: model.id,
    label: model.name || model.identifier || model.id,
    subtitle: model.kind || undefined,
  }));
}

export function buildTargetFolderOptions(
  folders: Array<Pick<InstanceFolder, 'id' | 'name' | 'identifier' | 'path'>>,
): ComboBoxOption[] {
  return folders
    .map((folder) => {
      const value = folder.path || folder.identifier || folder.id;
      return value ? { value, label: folder.path || folder.identifier || folder.name || value } : null;
    })
    .filter((option): option is ComboBoxOption => Boolean(option));
}

export function preserveSelectedDocumentIds(
  previousIds: string[],
  documents: Array<Pick<InstanceDocument, 'identifier'>>,
): string[] {
  const availableIds = new Set(documents.map((document) => document.identifier));
  return previousIds.filter((identifier) => availableIds.has(identifier));
}

export function canContinueFromSourceStep(selectedDocumentIds: string[], fixPanelOpen: boolean): boolean {
  return selectedDocumentIds.length > 0 && !fixPanelOpen;
}

export function isTerminalJobStatus(status: string) {
  return status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'canceled';
}

export function statusClass(status: string) {
  if (status === 'succeeded' || status === 'success') return 'bg-green-100 text-green-700';
  if (status === 'warning' || status === 'partial') return 'bg-yellow-100 text-yellow-800';
  if (status === 'failed') return 'bg-red-100 text-red-700';
  if (status === 'canceled') return 'bg-surface-secondary text-content-secondary';
  if (status === 'running') return 'bg-omni-50 text-omni-700';
  return 'bg-surface-secondary text-content-secondary';
}

export function completedItem(item: MigrationJobItem) {
  return item.status === 'succeeded' || item.status === 'warning' || item.status === 'failed' || item.status === 'skipped';
}

export function estimateDurationSeconds(plan: MigrationPlan | null): number {
  if (!plan) return 0;
  const uniqueExports = new Set(plan.steps.filter((step) => step.kind === 'export').map((step) => step.documentId).filter(Boolean));
  const byDestination = new Map<string, number>();
  for (const step of plan.steps) {
    if (step.kind === 'export') continue;
    byDestination.set(step.destinationId, (byDestination.get(step.destinationId) || 0) + 1);
  }
  const slowestDestinationItems = Math.max(0, ...byDestination.values());
  return Math.ceil((uniqueExports.size + slowestDestinationItems) * 1.2);
}

export function summarizePlanByTarget(plan: MigrationPlan | null) {
  if (!plan) return [];
  return plan.targets.map((target) => {
    const steps = plan.steps.filter((step) => (
      step.targetId ? step.targetId === target.id : step.destinationId === target.destinationInstanceId
    ));
    const warnings = steps.flatMap((step) => step.warnings || []);
    const deletes = steps.filter((step) => step.kind === 'delete').length;
    const replacements = steps.filter((step) => step.kind === 'delete' && step.replacement).length;
    return {
      target,
      steps,
      warningCount: warnings.length,
      warnings,
      deleteCount: deletes,
      replaceCount: replacements,
      status: warnings.length > 0 ? 'warning' : 'ready',
    };
  });
}

export function preflightRowsFromPlan(plan: MigrationPlan | null): PreflightTargetRow[] {
  return summarizePlanByTarget(plan).map((summary) => ({
    target: summary.target,
    status: summary.status as PreflightTargetRow['status'],
    steps: summary.steps,
    warnings: summary.warnings,
    warningCount: summary.warningCount,
    deleteCount: summary.deleteCount,
    replaceCount: summary.replaceCount,
  }));
}

export function combineMigrationPlans(plans: MigrationPlan[]): MigrationPlan | null {
  const validPlans = plans.filter((plan) => plan.targets.length > 0);
  if (validPlans.length === 0) return null;
  const [first] = validPlans;
  const targets = validPlans.flatMap((plan) => plan.targets);
  const targetIds = new Set<string>();
  const uniqueTargets = targets.filter((target) => {
    if (targetIds.has(target.id)) return false;
    targetIds.add(target.id);
    return true;
  });
  const destinationIds = [...new Set(uniqueTargets.map((target) => target.destinationInstanceId))];
  const documentIds = [...new Set(validPlans.flatMap((plan) => plan.documentIds))];
  return {
    ...first,
    destinationIds,
    targets: uniqueTargets,
    documentIds,
    steps: validPlans.flatMap((plan) => plan.steps),
  };
}

export function removeTargetFromMigrationPlan(plan: MigrationPlan | null, targetId: string): MigrationPlan | null {
  if (!plan) return null;
  const targets = plan.targets.filter((target) => target.id !== targetId);
  if (targets.length === 0) return null;
  const remainingTargetIds = new Set(targets.map((target) => target.id));
  const remainingDestinations = new Set(targets.map((target) => target.destinationInstanceId));
  return {
    ...plan,
    destinationIds: [...remainingDestinations],
    targets,
    steps: plan.steps.filter((step) => (
      step.targetId ? remainingTargetIds.has(step.targetId) : remainingDestinations.has(step.destinationId)
    )),
  };
}

export function summarizeJobByDestination(job: MigrationJob | null): DestinationProgress[] {
  if (!job) return [];
  const groups = new Map<string, MigrationJobItem[]>();
  for (const item of job.items) {
    if (item.kind === 'export') continue;
    const rows = groups.get(item.destinationId) || [];
    rows.push(item);
    groups.set(item.destinationId, rows);
  }
  return [...groups.entries()].map(([destinationId, items]) => {
    const done = items.filter(completedItem).length;
    const failed = items.filter((item) => item.status === 'failed').length;
    const warning = items.filter((item) => item.status === 'warning').length;
    const skipped = items.filter((item) => item.status === 'skipped').length;
    const running = items.filter((item) => item.status === 'running').length;
    const current = items.find((item) => item.status === 'running') || items.find((item) => item.status === 'pending');
    let status: DestinationProgress['status'] = 'pending';
    if (job.status === 'canceled') status = 'canceled';
    else if (running > 0) status = 'running';
    else if (done === items.length && failed === 0 && warning === 0) status = 'succeeded';
    else if (done === items.length && failed === 0 && warning > 0) status = 'warning';
    else if (failed > 0) status = 'failed';
    return {
      destinationId,
      destinationLabel: items[0]?.destinationLabel || destinationId,
      targetIds: [...new Set(items.map((item) => item.targetId).filter((item): item is string => Boolean(item)))],
      total: items.length,
      done,
      failed,
      warning,
      skipped,
      running,
      status,
      currentItem: current?.documentName || current?.documentId || current?.kind,
    };
  });
}

export function targetStepKey(step: MigrationPlanStep, index: number) {
  return `${step.targetId || step.destinationId}:${step.kind}:${step.documentId || 'cleanup'}:${index}`;
}
