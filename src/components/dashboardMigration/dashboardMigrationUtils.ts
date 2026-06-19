import type {
  InstanceDocument,
  InstanceFolder,
  InstanceModel,
  InstanceTopic,
  MigrationJob,
  MigrationJobItem,
  MigrationPlan,
  MigrationPlanStep,
  MigrationTopicMapping,
  MigrationTarget,
  PostMigrationAction,
  SavedInstancePublic,
} from '@/services/opsConsole';
import type { ComboBoxOption } from '@/components/ui/comboBoxUtils';
import { compareCatalogText, folderDisplayLabel, modelDisplayLabel, sortModels } from '../../utils/catalogSort';
import type {
  DashboardMigrationRouteGroupDraft,
  DashboardMigrationSourceTopic,
  DashboardMigrationTopicMappingDraft,
  DestinationProgress,
  PreflightTargetRow,
} from './dashboardMigrationTypes';

const MODEL_PLACEHOLDER_VALUES = new Set(['unknown', 'model unknown', 'model not detected', 'not detected', 'n/a', 'none', '-']);

export const TARGET_MODEL_COMBOBOX_CONFIG = {
  allowFreeText: false,
  emptyLabel: 'No models found',
} as const;

export const TARGET_FOLDER_COMBOBOX_CONFIG = {
  allowFreeText: true,
  emptyLabel: 'No folders found; type a new folder path',
} as const;

export interface RouteTopicActionSummary {
  routeGroupId?: string;
  routeGroupName?: string;
  documentId?: string;
  documentName?: string;
  topicMappings: MigrationTopicMapping[];
  warnings: string[];
  blocked: boolean;
}

export interface PreflightRouteTargetRow {
  target: MigrationTarget;
  steps: MigrationPlanStep[];
  sourceDocumentIds: string[];
  dashboardCount: number;
  topicActions: RouteTopicActionSummary[];
  topicActionCount: number;
  warningCount: number;
  warnings: string[];
  noticeCount: number;
  notices: string[];
  deleteCount: number;
  replaceCount: number;
  status: PreflightTargetRow['status'];
  error?: string;
}

export interface PreflightRouteGroupRow {
  id: string;
  name: string;
  documentIds: string[];
  dashboardCount: number;
  targets: PreflightRouteTargetRow[];
  targetCount: number;
  topicActionCount: number;
  warningCount: number;
  noticeCount: number;
  deleteCount: number;
  replaceCount: number;
  status: PreflightTargetRow['status'];
  error?: string;
}

export interface DashboardMigrationReviewMessageGroup {
  message: string;
  count: number;
}

export interface DashboardMigrationReviewImpactSummary {
  dashboardCount: number;
  destinationCount: number;
  dashboardGroupCount: number;
  replacementCount: number;
  targetDeleteCount: number;
  topicActionCount: number;
  warningGroups: DashboardMigrationReviewMessageGroup[];
  noticeGroups: DashboardMigrationReviewMessageGroup[];
  blockerGroups: DashboardMigrationReviewMessageGroup[];
  impactStatements: string[];
}

export function dashboardSelectionAriaLabel(
  document: Pick<InstanceDocument, 'name' | 'identifier' | 'folderPath' | 'baseModelName' | 'baseModelId'>,
) {
  const folder = cleanDashboardModelMetadata(document.folderPath) || 'My Documents/default';
  const model = cleanDashboardModelMetadata(document.baseModelName)
    || cleanDashboardModelMetadata(document.baseModelId)
    || 'model not detected';
  return `Select dashboard ${document.name} from ${folder} using ${model}`;
}

export function destinationInstanceSelectionAriaLabel(
  instance: Pick<SavedInstancePublic, 'label' | 'baseUrl'>,
  existingDestinationCount = 0,
) {
  const host = instance.baseUrl.replace(/^https?:\/\//, '');
  const existing = existingDestinationCount > 0
    ? `, ${existingDestinationCount} destination${existingDestinationCount === 1 ? '' : 's'} already configured`
    : '';
  return `Select ${instance.label} as a destination${host ? ` on ${host}` : ''}${existing}`;
}

export function dashboardGroupSelectionAriaLabel(
  document: Pick<InstanceDocument, 'name' | 'folderPath'>,
  groupName: string,
) {
  const folder = cleanDashboardModelMetadata(document.folderPath) || 'My Documents/default';
  return `Select dashboard ${document.name} from ${folder} for dashboard group ${groupName}`;
}

export function dashboardSelectionEmptyState(input: {
  loading: boolean;
  hasSourceConnection: boolean;
  hasLoadedDashboards: boolean;
  totalCount: number;
  visibleCount: number;
}) {
  if (input.loading) return 'Finding dashboards for this connection...';
  if (!input.hasSourceConnection) return 'Choose a source instance and connection, then load dashboards.';
  if (!input.hasLoadedDashboards) return 'Load dashboards from the source step to choose what to migrate.';
  if (input.totalCount === 0) return 'No dashboards found for this connection. Try a different source connection.';
  if (input.visibleCount === 0) return 'No dashboards match the current filters. Clear filters or search for another dashboard.';
  return '';
}

export function dashboardDestinationsEmptyState(availableInstanceCount: number) {
  return availableInstanceCount === 0
    ? 'No destination instances are available. Add or unlock saved instances before continuing.'
    : 'No destinations selected yet. Choose one or more instances above, or add a blank destination.';
}

function cleanDashboardTopicValue(value?: string | null) {
  return cleanDashboardModelMetadata(value);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function friendlyDashboardMigrationReviewMessage(message: string) {
  if (/same Omni instance/i.test(message) && /(target cleanup|same-instance|selected source dashboard|matched a selected source dashboard)/i.test(message)) {
    return 'Same-instance replacement cleanup was skipped. OmniKit will not move same-name dashboards to Trash when source and destination are the same Omni instance unless it can safely distinguish the original source dashboard from the target copy.';
  }
  if (/default My Documents area/i.test(message) && /cleanup|replacement deletes/i.test(message)) {
    return 'Replacement cleanup was skipped in the default My Documents area because OmniKit cannot safely limit the Trash move to one selected target folder.';
  }
  return message;
}

function groupDashboardMigrationReviewMessages(messages: string[]): DashboardMigrationReviewMessageGroup[] {
  const counts = new Map<string, number>();
  for (const rawMessage of messages) {
    const message = friendlyDashboardMigrationReviewMessage(rawMessage.trim());
    if (!message) continue;
    counts.set(message, (counts.get(message) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
}

function messagesFromPlanSteps(steps: MigrationPlanStep[], key: 'warnings' | 'notices') {
  return steps.flatMap((step) => step[key] || []);
}

export function dashboardMigrationReviewImpactSummary(
  plan: MigrationPlan | null,
  options: {
    routeGroups?: PreflightRouteGroupRow[];
    selectedDashboardCount?: number;
    refreshSchemaOnComplete: boolean;
    deleteSourceOnSuccess: boolean;
  },
): DashboardMigrationReviewImpactSummary {
  const routeGroups = options.routeGroups || [];
  const dashboardCount = plan?.documentIds.length || options.selectedDashboardCount || 0;
  const destinationCount = plan?.targets.length || 0;
  const dashboardGroupCount = routeGroups.length || plan?.routeGroups?.length || (plan ? 1 : 0);
  const replacementCount = routeGroups.reduce((sum, route) => sum + route.replaceCount, 0);
  const targetDeleteCount = routeGroups.reduce((sum, route) => sum + route.deleteCount, 0);
  const topicActionCount = routeGroups.reduce((sum, route) => sum + route.topicActionCount, 0);
  const blockerGroups = groupDashboardMigrationReviewMessages((plan?.steps || [])
    .filter((step) => step.blocked || step.error)
    .map((step) => step.error || 'This migration route is blocked.'));
  const warningGroups = groupDashboardMigrationReviewMessages(messagesFromPlanSteps(plan?.steps || [], 'warnings'));
  const noticeGroups = groupDashboardMigrationReviewMessages(messagesFromPlanSteps(plan?.steps || [], 'notices'));

  const impactStatements: string[] = [];
  if (!plan) {
    impactStatements.push('Run the readiness check to preview what OmniKit will copy, replace, refresh, or clean up.');
  } else {
    const groupSuffix = dashboardGroupCount > 1 ? ` across ${pluralize(dashboardGroupCount, 'dashboard group')}` : '';
    impactStatements.push(`You are about to copy ${pluralize(dashboardCount, 'dashboard')} to ${pluralize(destinationCount, 'destination')}${groupSuffix}.`);
    if (targetDeleteCount > 0) {
      if (plan.emptyFirst) {
        impactStatements.push(`${pluralize(targetDeleteCount, 'existing target dashboard')} will be moved to Trash before import.`);
      } else if (replacementCount > 0) {
        impactStatements.push(`${pluralize(replacementCount, 'same-name target dashboard')} will be moved to Trash in the selected destination folder${destinationCount === 1 ? '' : 's'} before import.`);
      } else {
        impactStatements.push(`${pluralize(targetDeleteCount, 'target dashboard')} will be moved to Trash before import.`);
      }
    } else if (plan.replaceSameNamed) {
      impactStatements.push('Same-name replacement is on; no matching dashboards were found in the selected destination folders.');
    }
    impactStatements.push(options.deleteSourceOnSuccess
      ? `Source delete is on. ${pluralize(dashboardCount, 'original source dashboard')} will move to Trash only after every destination succeeds and selected post-actions do not fail.`
      : 'Source delete is off. Original source dashboards will stay where they are.');
    impactStatements.push(options.refreshSchemaOnComplete
      ? `Schema refresh is on for ${pluralize(destinationCount, 'destination')}.`
      : 'Schema refresh is off.');
    impactStatements.push(topicActionCount > 0
      ? `${pluralize(topicActionCount, 'topic mapping')} will be applied before dashboard import.`
      : 'No topic actions are needed for this migration.');
  }

  return {
    dashboardCount,
    destinationCount,
    dashboardGroupCount,
    replacementCount,
    targetDeleteCount,
    topicActionCount,
    warningGroups,
    noticeGroups,
    blockerGroups,
    impactStatements,
  };
}

export function cleanDashboardModelMetadata(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return MODEL_PLACEHOLDER_VALUES.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

function topicKey(value?: string | null) {
  return cleanDashboardTopicValue(value)?.toLowerCase();
}

export function collectDashboardSourceTopics(
  documents: Array<Pick<InstanceDocument, 'topicNames' | 'topicIds'>>,
): DashboardMigrationSourceTopic[] {
  const topicsByKey = new Map<string, DashboardMigrationSourceTopic>();
  for (const document of documents) {
    const maxLength = Math.max(document.topicNames?.length || 0, document.topicIds?.length || 0);
    for (let index = 0; index < maxLength; index += 1) {
      const name = cleanDashboardTopicValue(document.topicNames?.[index]);
      const id = cleanDashboardTopicValue(document.topicIds?.[index]);
      const topicName = name || id;
      if (!topicName) continue;
      const key = topicKey(id) || topicKey(topicName);
      if (!key || topicsByKey.has(key)) continue;
      topicsByKey.set(key, {
        name: topicName,
        ...(id && id !== topicName ? { id } : id ? { id } : {}),
      });
    }
  }
  return [...topicsByKey.values()].sort((a, b) => compareCatalogText(a.name, b.name));
}

function exactTopicMatch(
  sourceTopic: DashboardMigrationSourceTopic,
  targetTopics: Array<Pick<InstanceTopic, 'name' | 'label'>>,
): Pick<InstanceTopic, 'name' | 'label'> | undefined {
  const sourceKeys = [sourceTopic.id, sourceTopic.name]
    .map(topicKey)
    .filter((value): value is string => Boolean(value));
  return targetTopics.find((topic) => {
    const targetKeys = [topic.name, topic.label]
      .map(topicKey)
      .filter((value): value is string => Boolean(value));
    return targetKeys.some((key) => sourceKeys.includes(key));
  });
}

function targetTopicNameExists(
  targetTopicName: string,
  targetTopics: Array<Pick<InstanceTopic, 'name' | 'label'>>,
): boolean {
  const targetKey = topicKey(targetTopicName);
  if (!targetKey) return false;
  return targetTopics.some((topic) => [topic.name, topic.label].map(topicKey).includes(targetKey));
}

function defaultCreatedTopicName(sourceTopic: DashboardMigrationSourceTopic) {
  return sourceTopic.id || sourceTopic.name;
}

export function dashboardSourceScopeKey(document: Pick<InstanceDocument, 'baseModelId' | 'baseModelName' | 'topicIds' | 'topicNames'>): string {
  const modelKey = cleanDashboardModelMetadata(document.baseModelId)
    || cleanDashboardModelMetadata(document.baseModelName)
    || 'model:not-detected';
  const topicKeys = [...(document.topicIds || []), ...(document.topicNames || [])]
    .map(cleanDashboardModelMetadata)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b));
  return `${modelKey}::${topicKeys.length > 0 ? topicKeys.join('|') : 'topic:not-detected'}`;
}

export function dashboardSourceScopeLabel(document: Pick<InstanceDocument, 'baseModelId' | 'baseModelName' | 'topicIds' | 'topicNames'>): string {
  const modelLabel = cleanDashboardModelMetadata(document.baseModelName)
    || cleanDashboardModelMetadata(document.baseModelId)
    || 'Model not detected';
  const topicLabels = [...(document.topicNames || []), ...(document.topicIds || [])]
    .map(cleanDashboardModelMetadata)
    .filter((value): value is string => Boolean(value));
  return `${modelLabel} / ${topicLabels.length > 0 ? topicLabels.join(', ') : 'Topic not detected'}`;
}

export function buildRouteGroupsBySourceScope(
  documents: InstanceDocument[],
  selectedDocumentIds: string[],
  targetRowIds: string[],
): DashboardMigrationRouteGroupDraft[] {
  const selected = documents.filter((document) => selectedDocumentIds.includes(document.identifier));
  const groupsByScope = new Map<string, { label: string; documentIds: string[] }>();
  for (const document of selected) {
    const key = dashboardSourceScopeKey(document);
    const existing = groupsByScope.get(key) || { label: dashboardSourceScopeLabel(document), documentIds: [] };
    existing.documentIds.push(document.identifier);
    groupsByScope.set(key, existing);
  }
  return [...groupsByScope.entries()].map(([key, group], index) => ({
    id: `route-${index + 1}-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'source-scope'}`,
    name: group.label,
    documentIds: group.documentIds,
    targetRowIds,
    topicMappingsByTargetId: {},
  }));
}

export function mixedRouteGroupSourceScopeMessage(
  group: Pick<DashboardMigrationRouteGroupDraft, 'name' | 'documentIds'>,
  documents: InstanceDocument[],
): string {
  const docs = documents.filter((document) => group.documentIds.includes(document.identifier));
  const scopeKeys = new Set(docs.map(dashboardSourceScopeKey));
  if (scopeKeys.size <= 1) return '';
  return `Split dashboard group ${group.name} by source model/topic before review.`;
}

export function buildDashboardTopicMappings(
  sourceTopics: DashboardMigrationSourceTopic[],
  targetTopics: Array<Pick<InstanceTopic, 'name' | 'label'>>,
  existing: DashboardMigrationTopicMappingDraft[] = [],
): DashboardMigrationTopicMappingDraft[] {
  const existingByKey = new Map(existing.map((mapping) => [
    topicKey(mapping.sourceTopicId) || topicKey(mapping.sourceTopicName) || mapping.sourceTopicName,
    mapping,
  ]));
  return sourceTopics.map((sourceTopic) => {
    const key = topicKey(sourceTopic.id) || topicKey(sourceTopic.name) || sourceTopic.name;
    const current = existingByKey.get(key);
    const mappedTarget = current?.targetTopicName
      ? targetTopics.find((topic) => topic.name === current.targetTopicName)
      : undefined;
    if (current?.action === 'copy_source') {
      const targetTopicName = typeof current.targetTopicName === 'string'
        ? current.targetTopicName.trim()
        : defaultCreatedTopicName(sourceTopic);
      const exists = targetTopicNameExists(targetTopicName, targetTopics);
      return {
        ...current,
        sourceTopicName: sourceTopic.name,
        sourceTopicId: sourceTopic.id,
        targetTopicName,
        targetTopicLabel: undefined,
        status: exists ? 'blocked' : targetTopicName ? 'ready' : 'blocked',
        warnings: exists
          ? [`Target topic ${targetTopicName} already exists. Use the existing topic or enter a new topic name.`]
          : targetTopicName ? undefined : ['Enter a target topic name to create.'],
      };
    }
    if (current?.action === 'map_existing' && mappedTarget) {
      return {
        ...current,
        sourceTopicName: sourceTopic.name,
        sourceTopicId: sourceTopic.id,
        targetTopicName: mappedTarget.name,
        targetTopicLabel: mappedTarget.label,
        status: 'ready',
      };
    }
    const exact = exactTopicMatch(sourceTopic, targetTopics);
    if (exact) {
      return {
        sourceTopicName: sourceTopic.name,
        sourceTopicId: sourceTopic.id,
        action: 'map_existing',
        targetTopicName: exact.name,
        targetTopicLabel: exact.label,
        status: 'ready',
      };
    }
    return {
      sourceTopicName: sourceTopic.name,
      sourceTopicId: sourceTopic.id,
      action: 'copy_source',
      targetTopicName: defaultCreatedTopicName(sourceTopic),
      targetTopicLabel: undefined,
      status: 'ready',
    };
  });
}

export function unresolvedTopicMappingMessage(
  targets: Array<{
    destinationLabel?: string;
    destinationInstanceId: string;
    topicMappings?: Array<{ sourceTopicName: string; targetTopicName?: string; status?: string }>;
  }>,
): string {
  for (const target of targets) {
    const unresolved = target.topicMappings?.find((mapping) => !mapping.targetTopicName || mapping.status === 'blocked');
    if (unresolved) {
      return `Resolve topic mapping for ${unresolved.sourceTopicName} on ${target.destinationLabel || target.destinationInstanceId}.`;
    }
  }
  return '';
}

function topicMappingsFromStepDetails(details?: Record<string, unknown>): MigrationTopicMapping[] {
  const rawMappings = details?.topicMappings;
  if (!Array.isArray(rawMappings)) return [];
  return rawMappings
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => ({
      sourceTopicName: typeof mapping.sourceTopicName === 'string' ? mapping.sourceTopicName : '',
      sourceTopicId: typeof mapping.sourceTopicId === 'string' ? mapping.sourceTopicId : undefined,
      action: mapping.action === 'copy_source' ? 'copy_source' as const : 'map_existing' as const,
      targetTopicName: typeof mapping.targetTopicName === 'string' ? mapping.targetTopicName : '',
      targetTopicLabel: typeof mapping.targetTopicLabel === 'string' ? mapping.targetTopicLabel : undefined,
    }))
    .filter((mapping) => mapping.sourceTopicName && mapping.targetTopicName);
}

export function routeTopicActionSummariesFromSteps(steps: MigrationPlanStep[]): RouteTopicActionSummary[] {
  const summaries = new Map<string, RouteTopicActionSummary>();
  for (const step of steps) {
    if (step.kind !== 'topic_prepare' && step.kind !== 'import') continue;
    const topicMappings = topicMappingsFromStepDetails(step.details);
    if (topicMappings.length === 0) continue;
    const key = `${step.routeGroupId || 'default-route'}:${step.documentId || 'document'}:${step.targetId || step.destinationId}`;
    const existing = summaries.get(key);
    if (existing) {
      existing.topicMappings = [...new Map([...existing.topicMappings, ...topicMappings].map((mapping) => [
        `${mapping.sourceTopicId || mapping.sourceTopicName}:${mapping.action}:${mapping.targetTopicName}`,
        mapping,
      ])).values()];
      existing.warnings = [...new Set([...existing.warnings, ...(step.warnings || [])])];
      existing.blocked = existing.blocked || step.blocked === true || Boolean(step.error);
      continue;
    }
    summaries.set(key, {
      routeGroupId: step.routeGroupId,
      routeGroupName: step.routeGroupName,
      documentId: step.documentId,
      documentName: step.documentName,
      topicMappings,
      warnings: [...new Set(step.warnings || [])],
      blocked: step.blocked === true || Boolean(step.error),
    });
  }
  return [...summaries.values()].sort((a, b) => (
    (a.routeGroupName || '').localeCompare(b.routeGroupName || '')
    || (a.documentName || '').localeCompare(b.documentName || '')
  ));
}

export function dashboardDocumentModelLabel(
  document: { baseModelId?: string | null; baseModelName?: string | null },
  sourceModelNameById: Map<string, string> = new Map(),
) {
  const baseModelName = cleanDashboardModelMetadata(document.baseModelName);
  const baseModelId = cleanDashboardModelMetadata(document.baseModelId);
  if (baseModelName) return { label: baseModelName, detected: true };
  if (baseModelId) return { label: sourceModelNameById.get(baseModelId) || baseModelId, detected: true };
  return { label: 'Model unavailable from export', detected: false };
}

function sourceModelDisplayName(model: Pick<InstanceModel, 'id' | 'name' | 'identifier' | 'baseModelId'>) {
  return cleanDashboardModelMetadata(model.name)
    || cleanDashboardModelMetadata(model.identifier)
    || cleanDashboardModelMetadata(model.baseModelId)
    || model.id;
}

function documentMatchesSelectedFolderScope(
  document: Pick<InstanceDocument, 'folderId' | 'folderPath'>,
  sourceFolderId?: string | null,
  sourceFolderPath?: string | null,
  documentCount = 0,
) {
  const sourceFolderKeys = [sourceFolderPath, sourceFolderId]
    .map(cleanDashboardModelMetadata)
    .filter((value): value is string => Boolean(value));
  if (sourceFolderKeys.length === 0) return documentCount === 1;

  const documentFolderKeys = [document.folderPath, document.folderId]
    .map(cleanDashboardModelMetadata)
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
  const sourceModelId = cleanDashboardModelMetadata(options.sourceModelId);
  if (!sourceModelId) return documents;

  const sourceModel = options.sourceModels.find((model) => (
    [model.id, model.identifier, model.baseModelId, model.name]
      .map(cleanDashboardModelMetadata)
      .some((value) => value === sourceModelId)
  ));
  if (!sourceModel) return documents;

  const fallbackName = sourceModelDisplayName(sourceModel);
  return documents.map((document) => {
    const existingModelId = cleanDashboardModelMetadata(document.baseModelId);
    const existingModelName = cleanDashboardModelMetadata(document.baseModelName);
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

export function getDashboardMigrationPreflightBlockReason(input: {
  sourceId?: string | null;
  sourceConnectionId?: string | null;
  selectedDocumentIds: string[];
  targets: Array<Pick<MigrationTarget, 'destinationInstanceId' | 'destinationLabel' | 'targetConnectionId' | 'targetModelId' | 'targetFolderId' | 'targetFolderPath'>>;
  hasLoadingTargets: boolean;
  hasInvalidTargetModel: boolean;
  hasUnresolvedFolderTargets: boolean;
  routeGroupBlockReason?: string;
  hasUnresolvedTopicMappings: boolean;
  unresolvedTopicMappingMessage?: string;
  preflightLoading: boolean;
  jobBusy: boolean;
}) {
  if (input.jobBusy) return 'Wait for the current migration action to finish.';
  if (input.preflightLoading) return 'Readiness check is already running.';
  if (!input.sourceId) return 'Choose a source instance before checking readiness.';
  if (!input.sourceConnectionId) return 'Choose a source connection before checking readiness.';
  if (input.selectedDocumentIds.length === 0) return 'Select at least one source dashboard before checking readiness.';
  if (input.targets.length === 0) return 'Add at least one destination before checking readiness.';
  const missingDestinationIndex = input.targets.findIndex((target) => !target.destinationInstanceId);
  if (missingDestinationIndex >= 0) return `Choose a destination instance for destination ${missingDestinationIndex + 1}.`;
  if (input.hasLoadingTargets) return 'Wait for destination connection, model, and folder catalogs to finish loading.';
  if (input.routeGroupBlockReason) return input.routeGroupBlockReason;
  const missingConnection = input.targets.find((target) => !target.targetConnectionId);
  if (missingConnection) return `Choose a destination connection for ${missingConnection.destinationLabel || missingConnection.destinationInstanceId}.`;
  const missingModel = input.targets.find((target) => !target.targetModelId);
  if (missingModel) return `Choose a destination model for ${missingModel.destinationLabel || missingModel.destinationInstanceId}.`;
  if (input.hasInvalidTargetModel) return 'Choose a destination model from the selected connection catalog.';
  if (input.hasUnresolvedFolderTargets) return 'Choose a folder path for saved folder IDs before checking readiness.';
  if (input.hasUnresolvedTopicMappings) return input.unresolvedTopicMappingMessage || 'Resolve topic mappings before checking readiness.';
  return '';
}

export function getDashboardLoadBlockReason(input: {
  sourceId?: string | null;
  sourceConnectionId?: string | null;
  loadingDocuments: boolean;
  loadingSourceModels: boolean;
}) {
  if (input.loadingDocuments) return 'Dashboards are already loading.';
  if (input.loadingSourceModels) return 'Wait for source models to finish loading.';
  if (!input.sourceId) return 'Choose a source instance before loading dashboards.';
  if (!input.sourceConnectionId) return 'Choose a source connection before loading dashboards.';
  return '';
}

export function buildSchemaRefreshActionsForTargets(
  targets: MigrationTarget[],
  instances: SavedInstancePublic[],
  enabled: boolean,
): PostMigrationAction[] {
  if (!enabled) return [];
  return targets.flatMap((target) => {
    const destination = instances.find((instance) => instance.id === target.destinationInstanceId);
    if (!destination || !target.targetModelId) return [];
    return [{
      kind: 'refresh-schema' as const,
      name: `${destination.label}: refresh schema model ${target.targetModelName || target.targetModelId}`,
      method: 'POST' as const,
      url: '',
      headers: {},
      body: '',
      destinationInstanceId: destination.id,
      targetModelId: target.targetModelId,
      targetModelName: target.targetModelName || target.targetModelId,
    }];
  });
}

export function buildTargetModelOptions(
  models: Array<Pick<InstanceModel, 'id' | 'name' | 'identifier' | 'connectionName' | 'kind'>>,
): ComboBoxOption[] {
  return sortModels(models).map((model) => ({
    value: model.id,
    label: modelDisplayLabel(model),
    subtitle: model.kind || model.connectionName || undefined,
  }));
}

export function buildTargetFolderOptions(
  folders: Array<Pick<InstanceFolder, 'id' | 'name' | 'identifier' | 'path'>>,
): ComboBoxOption[] {
  return folders
    .map((folder) => {
      const value = folder.path || folder.identifier || folder.id;
      return value ? { value, label: folderDisplayLabel(folder) || value } : null;
    })
    .filter((option): option is ComboBoxOption => Boolean(option))
    .sort((a, b) => compareCatalogText(a.label, b.label) || compareCatalogText(a.value, b.value));
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
    const notices = steps.flatMap((step) => step.notices || []);
    const blocker = steps.find((step) => step.blocked || step.error);
    const deletes = steps.filter((step) => step.kind === 'delete').length;
    const replacements = steps.filter((step) => step.kind === 'delete' && step.replacement).length;
    return {
      target,
      steps,
      warningCount: warnings.length,
      warnings,
      noticeCount: notices.length,
      notices,
      deleteCount: deletes,
      replaceCount: replacements,
      status: blocker ? 'blocked' : warnings.length > 0 ? 'warning' : 'ready',
      error: blocker?.error,
    };
  });
}

export function preflightRowsFromPlan(plan: MigrationPlan | null): PreflightTargetRow[] {
  return summarizePlanByTarget(plan).map((summary) => ({
    target: summary.target,
    status: summary.status as PreflightTargetRow['status'],
    steps: summary.steps,
    warnings: summary.warnings,
    notices: summary.notices,
    warningCount: summary.warningCount,
    noticeCount: summary.noticeCount,
    deleteCount: summary.deleteCount,
    replaceCount: summary.replaceCount,
    error: summary.error,
  }));
}

function statusFromSteps(steps: MigrationPlanStep[]): PreflightTargetRow['status'] {
  if (steps.some((step) => step.blocked || step.error)) return 'blocked';
  if (steps.some((step) => (step.warnings || []).length > 0)) return 'warning';
  return 'ready';
}

function uniqueStepValues(steps: MigrationPlanStep[], key: 'warnings' | 'notices'): string[] {
  return [...new Set(steps.flatMap((step) => step[key] || []))];
}

function stepBelongsToRoute(step: MigrationPlanStep, routeId: string): boolean {
  return step.routeGroupId ? step.routeGroupId === routeId : routeId === 'default-route';
}

export function preflightRouteGroupsFromPlan(plan: MigrationPlan | null): PreflightRouteGroupRow[] {
  if (!plan) return [];
  const routes = plan.routeGroups?.length
    ? plan.routeGroups
    : [{
      id: 'default-route',
      name: 'All selected dashboards',
      documentIds: plan.documentIds,
      targets: plan.targets,
    }];

  return routes.map((route) => {
    const routeTargets = route.targets.map((target) => {
      const steps = plan.steps.filter((step) => (
        stepBelongsToRoute(step, route.id)
        && (step.targetId ? step.targetId === target.id : step.destinationId === target.destinationInstanceId)
      ));
      const warnings = uniqueStepValues(steps, 'warnings');
      const notices = uniqueStepValues(steps, 'notices');
      const topicActions = routeTopicActionSummariesFromSteps(steps);
      const blocker = steps.find((step) => step.blocked || step.error);
      return {
        target,
        steps,
        sourceDocumentIds: route.documentIds,
        dashboardCount: route.documentIds.length,
        topicActions,
        topicActionCount: topicActions.reduce((sum, action) => sum + action.topicMappings.length, 0),
        warningCount: warnings.length,
        warnings,
        noticeCount: notices.length,
        notices,
        deleteCount: steps.filter((step) => step.kind === 'delete').length,
        replaceCount: steps.filter((step) => step.kind === 'delete' && step.replacement).length,
        status: statusFromSteps(steps),
        error: blocker?.error,
      };
    });
    const routeWarnings = [...new Set(routeTargets.flatMap((target) => target.warnings))];
    const routeNotices = [...new Set(routeTargets.flatMap((target) => target.notices))];
    const blocker = routeTargets.find((target) => target.status === 'blocked');
    const hasWarning = routeTargets.some((target) => target.status === 'warning');
    return {
      id: route.id,
      name: route.name,
      documentIds: route.documentIds,
      dashboardCount: route.documentIds.length,
      targets: routeTargets,
      targetCount: routeTargets.length,
      topicActionCount: routeTargets.reduce((sum, target) => sum + target.topicActionCount, 0),
      warningCount: routeWarnings.length,
      noticeCount: routeNotices.length,
      deleteCount: routeTargets.reduce((sum, target) => sum + target.deleteCount, 0),
      replaceCount: routeTargets.reduce((sum, target) => sum + target.replaceCount, 0),
      status: blocker ? 'blocked' : hasWarning ? 'warning' : 'ready',
      error: blocker?.error,
    };
  });
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
