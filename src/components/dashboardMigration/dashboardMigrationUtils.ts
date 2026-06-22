import type {
  InstanceDocument,
  InstanceFolder,
  InstanceModel,
  InstanceTopic,
  MigrationJobInput,
  MigrationJob,
  MigrationJobItem,
  MigrationPlan,
  MigrationPlanStep,
  MigrationQueryViewMapping,
  MigrationRouteGroup,
  MigrationTopicMapping,
  MigrationTarget,
  PostMigrationAction,
  SavedInstancePublic,
} from '@/services/opsConsole';
import type { ComboBoxOption } from '@/components/ui/comboBoxUtils';
import { compareCatalogText, folderDisplayLabel, modelDisplayLabel, sortModels } from '../../utils/catalogSort';
import type {
  DashboardMigrationRouteGroupDraft,
  DashboardMigrationQueryViewCatalogItem,
  DashboardMigrationQueryViewMappingDraft,
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

export interface RouteQueryViewActionSummary {
  routeGroupId?: string;
  routeGroupName?: string;
  documentId?: string;
  documentName?: string;
  queryViewMappings: MigrationQueryViewMapping[];
  warnings: string[];
  blocked: boolean;
}

export interface DashboardMigrationRelationshipEdge {
  joinFromView: string;
  joinToView: string;
  joinType?: string;
  relationshipType?: string;
}

export interface RouteRelationshipActionSummary {
  routeGroupId?: string;
  routeGroupName?: string;
  documentId?: string;
  documentName?: string;
  relationshipEdges: DashboardMigrationRelationshipEdge[];
  warnings: string[];
  blocked: boolean;
}

export type DashboardMigrationRequiredQueryViewStatus = 'exact_target_match' | 'missing_copyable' | 'missing_source_yaml' | 'blocked';
export type DashboardMigrationQueryViewCompatibilityStatus = 'compatible' | 'missing_required_fields' | 'missing_required_dependencies' | 'unknown';

export interface DashboardMigrationQueryViewCompatibility {
  status: DashboardMigrationQueryViewCompatibilityStatus;
  targetQueryViewName?: string;
  targetFileName?: string;
  targetChecksum?: string;
  missingRequiredFields?: string[];
  missingRequiredDependencies?: string[];
  reason?: string;
}

export interface DashboardMigrationRequiredQueryView {
  name: string;
  sourceFileName?: string;
  targetFileName?: string;
  label?: string;
  description?: string;
  status: DashboardMigrationRequiredQueryViewStatus;
  sources: string[];
  referencedBy: string[];
  reason?: string;
  compatibility?: DashboardMigrationQueryViewCompatibility;
}

export type DashboardMigrationQueryViewRequirementsByRouteTarget = Record<string, Record<string, DashboardMigrationRequiredQueryView[]>>;

export interface PreflightRouteTargetRow {
  target: MigrationTarget;
  steps: MigrationPlanStep[];
  sourceDocumentIds: string[];
  dashboardCount: number;
  queryViewActions: RouteQueryViewActionSummary[];
  queryViewActionCount: number;
  relationshipActions: RouteRelationshipActionSummary[];
  relationshipActionCount: number;
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
  queryViewActionCount: number;
  relationshipActionCount: number;
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
  queryViewActionCount: number;
  relationshipActionCount: number;
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
  const firstIndex = new Map<string, number>();
  for (const [index, rawMessage] of messages.entries()) {
    const message = friendlyDashboardMigrationReviewMessage(rawMessage.trim());
    if (!message) continue;
    if (!firstIndex.has(message)) firstIndex.set(message, index);
    counts.set(message, (counts.get(message) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => (firstIndex.get(a.message) || 0) - (firstIndex.get(b.message) || 0));
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
  const queryViewActionCount = routeGroups.reduce((sum, route) => sum + route.queryViewActionCount, 0);
  const relationshipActionCount = routeGroups.reduce((sum, route) => sum + route.relationshipActionCount, 0);
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
    impactStatements.push(queryViewActionCount > 0
      ? `${pluralize(queryViewActionCount, 'query-view mapping')} will be prepared before topic mapping.`
      : 'No query-view actions are needed for this migration.');
    impactStatements.push(relationshipActionCount > 0
      ? `${pluralize(relationshipActionCount, 'relationship edge')} will be prepared before topic mapping.`
      : 'No relationship actions are needed for this migration.');
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
    queryViewActionCount,
    relationshipActionCount,
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

function queryViewNameFromFileName(fileName?: string | null) {
  const leaf = cleanDashboardModelMetadata(fileName)?.split('/').pop();
  return leaf?.replace(/\.query\.view$/i, '');
}

function queryViewKey(value?: string | null) {
  return cleanDashboardModelMetadata(value)?.toLowerCase();
}

function queryViewKeys(queryView: Pick<DashboardMigrationQueryViewCatalogItem, 'name' | 'label' | 'fileName'>): string[] {
  return [queryView.name, queryView.label, queryViewNameFromFileName(queryView.fileName)]
    .map(queryViewKey)
    .filter((value): value is string => Boolean(value));
}

function exactQueryViewMatch(
  requiredQueryView: Pick<DashboardMigrationRequiredQueryView, 'name' | 'sourceFileName' | 'label'>,
  targetQueryViews: DashboardMigrationQueryViewCatalogItem[],
): DashboardMigrationQueryViewCatalogItem | undefined {
  const sourceKeys = [requiredQueryView.name, requiredQueryView.label, queryViewNameFromFileName(requiredQueryView.sourceFileName)]
    .map(queryViewKey)
    .filter((value): value is string => Boolean(value));
  return targetQueryViews.find((queryView) => queryViewKeys(queryView).some((key) => sourceKeys.includes(key)));
}

function targetQueryViewNameExists(
  targetQueryViewName: string,
  targetQueryViews: DashboardMigrationQueryViewCatalogItem[],
): boolean {
  const targetKey = queryViewKey(targetQueryViewName);
  if (!targetKey) return false;
  return targetQueryViews.some((queryView) => queryViewKeys(queryView).includes(targetKey));
}

function defaultCreatedQueryViewName(requiredQueryView: Pick<DashboardMigrationRequiredQueryView, 'name' | 'sourceFileName'>) {
  return queryViewNameFromFileName(requiredQueryView.sourceFileName) || requiredQueryView.name;
}

function queryViewMappingRenamesSource(input: {
  sourceQueryViewName: string;
  sourceFileName?: string;
  targetQueryViewName: string;
  targetFileName?: string;
}): boolean {
  const sourceKey = queryViewKey(input.sourceQueryViewName) || queryViewKey(queryViewNameFromFileName(input.sourceFileName));
  const targetKey = queryViewKey(input.targetQueryViewName) || queryViewKey(queryViewNameFromFileName(input.targetFileName));
  return Boolean(sourceKey && targetKey && sourceKey !== targetKey);
}

function requiredQueryViewWarning(requiredQueryView: DashboardMigrationRequiredQueryView): string {
  if (requiredQueryView.reason) return requiredQueryView.reason;
  if (requiredQueryView.compatibility?.status === 'missing_required_fields') {
    return `Existing target query view is missing required fields: ${requiredQueryView.compatibility.missingRequiredFields?.slice(0, 4).join(', ') || requiredQueryView.name}.`;
  }
  if (requiredQueryView.compatibility?.status === 'missing_required_dependencies') {
    return `Existing target query view is missing required dependencies: ${requiredQueryView.compatibility.missingRequiredDependencies?.slice(0, 4).join(', ') || requiredQueryView.name}.`;
  }
  if (requiredQueryView.status === 'missing_source_yaml') return `Source query-view YAML was not found for ${requiredQueryView.name}.`;
  if (requiredQueryView.status === 'blocked') return `Query view ${requiredQueryView.name} needs attention before dashboard import.`;
  return `Choose how to prepare query view ${requiredQueryView.name}.`;
}

function queryViewCompatibilityNeedsChoice(requiredQueryView: DashboardMigrationRequiredQueryView): boolean {
  return requiredQueryView.compatibility?.status === 'missing_required_fields'
    || requiredQueryView.compatibility?.status === 'missing_required_dependencies';
}

export function buildDashboardQueryViewMappings(
  requiredQueryViews: DashboardMigrationRequiredQueryView[],
  targetQueryViews: DashboardMigrationQueryViewCatalogItem[],
  existingMappings: DashboardMigrationQueryViewMappingDraft[] = [],
): DashboardMigrationQueryViewMappingDraft[] {
  const existingByKey = new Map(existingMappings.map((mapping) => [
    queryViewKey(mapping.sourceFileName) || queryViewKey(mapping.sourceQueryViewName) || mapping.sourceQueryViewName,
    mapping,
  ]));

  return requiredQueryViews.map((requiredQueryView) => {
    const sourceKey = queryViewKey(requiredQueryView.sourceFileName) || queryViewKey(requiredQueryView.name) || requiredQueryView.name;
    const current = existingByKey.get(sourceKey);
    const targetMatch = current?.targetQueryViewName
      ? targetQueryViews.find((queryView) => queryView.name === current.targetQueryViewName)
      : undefined;

	    if (current?.action === 'copy_source') {
	      const targetQueryViewName = typeof current.targetQueryViewName === 'string'
	        ? current.targetQueryViewName.trim()
	        : defaultCreatedQueryViewName(requiredQueryView);
	      const exists = targetQueryViewNameExists(targetQueryViewName, targetQueryViews);
	      const renamesSource = queryViewMappingRenamesSource({
	        sourceQueryViewName: requiredQueryView.name,
	        sourceFileName: requiredQueryView.sourceFileName,
	        targetQueryViewName,
	        targetFileName: current.targetFileName,
	      });
	      return {
	        ...current,
	        sourceQueryViewName: requiredQueryView.name,
	        sourceFileName: requiredQueryView.sourceFileName,
	        targetQueryViewName,
	        targetFileName: current.targetFileName || `${targetQueryViewName}.query.view`,
	        targetQueryViewLabel: undefined,
	        status: exists || renamesSource ? 'blocked' : targetQueryViewName ? 'ready' : 'blocked',
	        warnings: exists
	          ? [`Target query view ${targetQueryViewName} already exists. Use the existing query view or enter a new query-view name.`]
	          : renamesSource
	            ? [`Create-new query views must keep the source query-view name ${requiredQueryView.name} until query-view reference rewriting is supported.`]
	            : targetQueryViewName ? undefined : ['Enter a target query-view name to create.'],
	      };
	    }

    if ((current?.action === 'map_existing' || current?.action === 'use_existing_unverified' || current?.action === 'update_existing') && targetMatch) {
      const needsChoice = queryViewCompatibilityNeedsChoice(requiredQueryView);
      if (current.action === 'map_existing' && needsChoice) {
        return {
          ...current,
          sourceQueryViewName: requiredQueryView.name,
          sourceFileName: requiredQueryView.sourceFileName,
          targetQueryViewName: targetMatch.name,
          targetFileName: targetMatch.fileName,
          targetQueryViewLabel: targetMatch.label,
          status: 'blocked',
          warnings: [requiredQueryViewWarning(requiredQueryView)],
        };
      }
      return {
        ...current,
        sourceQueryViewName: requiredQueryView.name,
        sourceFileName: requiredQueryView.sourceFileName,
        targetQueryViewName: targetMatch.name,
        targetFileName: targetMatch.fileName,
        targetQueryViewLabel: targetMatch.label,
        status: current.action === 'use_existing_unverified' ? 'warning' : 'ready',
        warnings: current.action === 'use_existing_unverified'
          ? ['Using this existing query view as-is even though compatibility checks found a mismatch.']
          : undefined,
      };
    }

    if ((current?.action === 'map_existing' || current?.action === 'use_existing_unverified' || current?.action === 'update_existing') && current.targetQueryViewName && targetQueryViews.length > 0 && !targetMatch) {
      return {
        ...current,
        sourceQueryViewName: requiredQueryView.name,
        sourceFileName: requiredQueryView.sourceFileName,
        status: 'blocked',
        warnings: [`Target query view ${current.targetQueryViewName} was not found in the destination model.`],
      };
    }

    const exact = exactQueryViewMatch(requiredQueryView, targetQueryViews);
    if (exact || requiredQueryView.status === 'exact_target_match') {
      const needsChoice = queryViewCompatibilityNeedsChoice(requiredQueryView);
      return {
        sourceQueryViewName: requiredQueryView.name,
        sourceFileName: requiredQueryView.sourceFileName,
        action: needsChoice ? 'unresolved' : 'map_existing',
        targetQueryViewName: exact?.name || requiredQueryView.name,
        targetFileName: exact?.fileName || requiredQueryView.targetFileName,
        targetQueryViewLabel: exact?.label || requiredQueryView.label,
        status: needsChoice ? 'blocked' : 'ready',
        warnings: needsChoice ? [requiredQueryViewWarning(requiredQueryView)] : undefined,
      };
    }

    if (requiredQueryView.status === 'missing_copyable') {
      const targetQueryViewName = defaultCreatedQueryViewName(requiredQueryView);
      const exists = targetQueryViewNameExists(targetQueryViewName, targetQueryViews);
      return {
        sourceQueryViewName: requiredQueryView.name,
        sourceFileName: requiredQueryView.sourceFileName,
        action: 'copy_source',
        targetQueryViewName,
        targetFileName: `${targetQueryViewName}.query.view`,
        targetQueryViewLabel: undefined,
        status: exists ? 'blocked' : 'ready',
        warnings: exists ? [`Target query view ${targetQueryViewName} already exists. Use the existing query view or enter a new query-view name.`] : undefined,
      };
    }

    return {
      sourceQueryViewName: requiredQueryView.name,
      sourceFileName: requiredQueryView.sourceFileName,
      action: 'unresolved',
      targetQueryViewName: '',
      targetFileName: requiredQueryView.targetFileName,
      targetQueryViewLabel: requiredQueryView.label,
      status: 'blocked',
      warnings: [requiredQueryViewWarning(requiredQueryView)],
    };
  });
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
    queryViewMappingsByTargetId: {},
  }));
}

function uniqueNonEmptyStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function uniqueRouteGroupId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) return baseId;
  let index = 2;
  while (usedIds.has(`${baseId}-${index}`)) index += 1;
  return `${baseId}-${index}`;
}

export function normalizeDashboardRouteGroups(input: {
  groups: DashboardMigrationRouteGroupDraft[];
  selectedDocumentIds: string[];
  targetRowIds: string[];
  defaultGroupId: string;
  defaultGroupName?: string;
  remainingGroupName?: string;
  preserveTargetAssignments?: boolean;
}): DashboardMigrationRouteGroupDraft[] {
  const selectedDocumentIds = uniqueNonEmptyStrings(input.selectedDocumentIds);
  const selectedDocumentIdSet = new Set(selectedDocumentIds);
  const targetRowIds = uniqueNonEmptyStrings(input.targetRowIds);
  const targetRowIdSet = new Set(targetRowIds);
  const defaultGroup = (): DashboardMigrationRouteGroupDraft => ({
    id: input.defaultGroupId,
    name: input.defaultGroupName || 'All selected dashboards',
    documentIds: selectedDocumentIds,
    targetRowIds,
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
  });

  const candidateGroups = input.preserveTargetAssignments
    ? input.groups
    : input.groups.filter((group) => group.id !== input.defaultGroupId);
  if (candidateGroups.length === 0) return [defaultGroup()];

  const usedIds = new Set<string>();
  const normalized = candidateGroups.map((group, index) => {
    const documentIds = uniqueNonEmptyStrings(group.documentIds).filter((documentId) => selectedDocumentIdSet.has(documentId));
    const groupTargetRowIds = uniqueNonEmptyStrings(group.targetRowIds).filter((targetRowId) => targetRowIdSet.has(targetRowId));
    const assignedTargetRowIds = input.preserveTargetAssignments ? groupTargetRowIds : targetRowIds;
    const assignedTargetRowIdSet = new Set(assignedTargetRowIds);
    const topicMappingsByTargetId = Object.fromEntries(
      Object.entries(group.topicMappingsByTargetId || {})
        .filter(([targetRowId]) => assignedTargetRowIdSet.has(targetRowId)),
    );
    const queryViewMappingsByTargetId = Object.fromEntries(
      Object.entries(group.queryViewMappingsByTargetId || {})
        .filter(([targetRowId]) => assignedTargetRowIdSet.has(targetRowId)),
    );
    const id = uniqueRouteGroupId(group.id || `dashboard-group-${index + 1}`, usedIds);
    usedIds.add(id);
    return {
      ...group,
      id,
      name: group.name || `Dashboard group ${index + 1}`,
      documentIds,
      targetRowIds: assignedTargetRowIds,
      topicMappingsByTargetId,
      queryViewMappingsByTargetId,
    };
  }).filter((group) => group.documentIds.length > 0);

  if (normalized.length === 0) return [defaultGroup()];

  const coveredDocumentIds = new Set(normalized.flatMap((group) => group.documentIds));
  const missingDocumentIds = selectedDocumentIds.filter((documentId) => !coveredDocumentIds.has(documentId));
  if (missingDocumentIds.length > 0) {
    const remainingId = uniqueRouteGroupId(`${input.defaultGroupId}-remaining`, usedIds);
    normalized.push({
      id: remainingId,
      name: input.remainingGroupName || 'Remaining dashboards',
      documentIds: missingDocumentIds,
      targetRowIds,
      topicMappingsByTargetId: {},
      queryViewMappingsByTargetId: {},
    });
  }

  return normalized;
}

export function createDashboardRouteGroupsFromSelection(input: {
  currentGroups: DashboardMigrationRouteGroupDraft[];
  activeGroupId: string;
  selectedDocumentIds: string[];
  routeSelectionIds: string[];
  targetRowIds: string[];
  defaultGroupId: string;
  nextGroupId: string;
  remainingGroupId?: string;
  nextGroupName?: string;
  remainingGroupName?: string;
}): DashboardMigrationRouteGroupDraft[] {
  const selectedDocumentIds = uniqueNonEmptyStrings(input.selectedDocumentIds);
  const selectedDocumentIdSet = new Set(selectedDocumentIds);
  const routeSelectionIds = uniqueNonEmptyStrings(input.routeSelectionIds).filter((documentId) => selectedDocumentIdSet.has(documentId));
  if (routeSelectionIds.length === 0) return input.currentGroups;

  const activeGroup = input.currentGroups.find((group) => group.id === input.activeGroupId) || input.currentGroups[0];
  const targetIdsForGroup = activeGroup?.targetRowIds?.length ? activeGroup.targetRowIds : uniqueNonEmptyStrings(input.targetRowIds);
  const selected = new Set(routeSelectionIds);
  const nextGroup: DashboardMigrationRouteGroupDraft = {
    id: input.nextGroupId,
    name: input.nextGroupName || `Dashboard group ${input.currentGroups.length}`,
    documentIds: routeSelectionIds,
    targetRowIds: targetIdsForGroup,
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
  };

  if (activeGroup?.id && activeGroup.id !== input.defaultGroupId) {
    return [...input.currentGroups.filter((group) => group.id !== input.defaultGroupId), nextGroup];
  }

  const remainingDocumentIds = selectedDocumentIds.filter((documentId) => !selected.has(documentId));
  const remainingGroup: DashboardMigrationRouteGroupDraft | null = remainingDocumentIds.length > 0
    ? {
        id: input.remainingGroupId || `${input.nextGroupId}-remaining`,
        name: input.remainingGroupName || 'Remaining dashboards',
        documentIds: remainingDocumentIds,
        targetRowIds: targetIdsForGroup,
        topicMappingsByTargetId: {},
        queryViewMappingsByTargetId: {},
      }
    : null;
  return remainingGroup ? [nextGroup, remainingGroup] : [nextGroup];
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
    if (current?.action === 'map_existing') {
      return {
        ...current,
        sourceTopicName: sourceTopic.name,
        sourceTopicId: sourceTopic.id,
        targetTopicName: mappedTarget?.name || current.targetTopicName || '',
        targetTopicLabel: mappedTarget?.label,
        status: mappedTarget ? 'ready' : 'blocked',
        warnings: mappedTarget ? undefined : ['Choose an existing target topic.'],
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

export function dashboardMigrationRoutePathLabel(input: {
  groupName: string;
  destinationLabel?: string;
  connectionLabel?: string;
  modelLabel?: string;
  folderLabel?: string;
}): string {
  const destinationLabel = input.destinationLabel || 'Destination not selected';
  const details = [
    input.connectionLabel,
    input.modelLabel,
    input.folderLabel,
  ].filter((item): item is string => Boolean(item && item.trim()));
  return details.length > 0
    ? `${input.groupName} -> ${destinationLabel} (${details.join(' / ')})`
    : `${input.groupName} -> ${destinationLabel}`;
}

export function unresolvedTopicMappingRouteMessage(input: {
  sourceTopicName: string;
  groupName: string;
  destinationLabel?: string;
  connectionLabel?: string;
  modelLabel?: string;
  folderLabel?: string;
}): string {
  return `Resolve topic mapping for ${input.sourceTopicName} on route ${dashboardMigrationRoutePathLabel(input)}.`;
}

export function unresolvedQueryViewMappingRouteMessage(input: {
  sourceQueryViewName: string;
  groupName: string;
  destinationLabel?: string;
  connectionLabel?: string;
  modelLabel?: string;
  folderLabel?: string;
}): string {
  return `Resolve query-view mapping for ${input.sourceQueryViewName} on route ${dashboardMigrationRoutePathLabel(input)}.`;
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

function queryViewRequirementsFromStepDetails(details?: Record<string, unknown>): DashboardMigrationRequiredQueryView[] {
  const rawQueryViews = details?.requiredQueryViews;
  if (!Array.isArray(rawQueryViews)) return [];
  return rawQueryViews
    .filter((queryView): queryView is Record<string, unknown> => Boolean(queryView) && typeof queryView === 'object' && !Array.isArray(queryView))
    .map((queryView) => {
      const name = typeof queryView.name === 'string' ? queryView.name.trim() : '';
      const status = ['exact_target_match', 'missing_copyable', 'missing_source_yaml', 'blocked'].includes(String(queryView.status))
        ? queryView.status as DashboardMigrationRequiredQueryViewStatus
        : 'blocked';
      const rawCompatibility = queryView.compatibility && typeof queryView.compatibility === 'object' && !Array.isArray(queryView.compatibility)
        ? queryView.compatibility as Record<string, unknown>
        : undefined;
      const compatibilityStatus = ['compatible', 'missing_required_fields', 'missing_required_dependencies', 'unknown'].includes(String(rawCompatibility?.status))
        ? rawCompatibility?.status as DashboardMigrationQueryViewCompatibilityStatus
        : undefined;
      return {
        name,
        sourceFileName: typeof queryView.sourceFileName === 'string' ? queryView.sourceFileName : undefined,
        targetFileName: typeof queryView.targetFileName === 'string' ? queryView.targetFileName : undefined,
        label: typeof queryView.label === 'string' ? queryView.label : undefined,
        description: typeof queryView.description === 'string' ? queryView.description : undefined,
        status,
        sources: Array.isArray(queryView.sources) ? queryView.sources.filter((source): source is string => typeof source === 'string') : [],
        referencedBy: Array.isArray(queryView.referencedBy) ? queryView.referencedBy.filter((source): source is string => typeof source === 'string') : [],
        reason: typeof queryView.reason === 'string' ? queryView.reason : undefined,
        ...(compatibilityStatus ? {
          compatibility: {
            status: compatibilityStatus,
            targetQueryViewName: typeof rawCompatibility?.targetQueryViewName === 'string' ? rawCompatibility.targetQueryViewName : undefined,
            targetFileName: typeof rawCompatibility?.targetFileName === 'string' ? rawCompatibility.targetFileName : undefined,
            targetChecksum: typeof rawCompatibility?.targetChecksum === 'string' ? rawCompatibility.targetChecksum : undefined,
            missingRequiredFields: Array.isArray(rawCompatibility?.missingRequiredFields)
              ? rawCompatibility.missingRequiredFields.filter((field): field is string => typeof field === 'string')
              : undefined,
            missingRequiredDependencies: Array.isArray(rawCompatibility?.missingRequiredDependencies)
              ? rawCompatibility.missingRequiredDependencies.filter((dependency): dependency is string => typeof dependency === 'string')
              : undefined,
            reason: typeof rawCompatibility?.reason === 'string' ? rawCompatibility.reason : undefined,
          },
        } : {}),
      };
    })
    .filter((queryView) => queryView.name);
}

export function queryViewRequirementsByRouteTargetFromPlan(plan: MigrationPlan | null): DashboardMigrationQueryViewRequirementsByRouteTarget {
  if (!plan) return {};
  const byRouteTarget: DashboardMigrationQueryViewRequirementsByRouteTarget = {};
  for (const step of plan.steps) {
    if (step.kind !== 'import') continue;
    const requiredQueryViews = queryViewRequirementsFromStepDetails(step.details);
    if (requiredQueryViews.length === 0) continue;
    const routeGroupId = step.routeGroupId || 'default-route';
    const targetId = step.targetId || step.destinationId;
    byRouteTarget[routeGroupId] ||= {};
    const existing = byRouteTarget[routeGroupId][targetId] || [];
    const merged = new Map<string, DashboardMigrationRequiredQueryView>();
    for (const queryView of [...existing, ...requiredQueryViews]) {
      const key = queryViewKey(queryView.sourceFileName) || queryViewKey(queryView.name) || queryView.name;
      const current = merged.get(key);
      if (!current) {
        merged.set(key, queryView);
        continue;
      }
      merged.set(key, {
        ...current,
        sources: [...new Set([...current.sources, ...queryView.sources])].sort(),
        referencedBy: [...new Set([...current.referencedBy, ...queryView.referencedBy])].sort(),
        reason: current.reason || queryView.reason,
        compatibility: current.compatibility?.status === 'missing_required_fields' || current.compatibility?.status === 'missing_required_dependencies'
          ? current.compatibility
          : queryView.compatibility || current.compatibility,
      });
    }
    byRouteTarget[routeGroupId][targetId] = [...merged.values()].sort((a, b) => compareCatalogText(a.name, b.name));
  }
  return byRouteTarget;
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

function queryViewMappingsFromStepDetails(details?: Record<string, unknown>): MigrationQueryViewMapping[] {
  const rawMappings = details?.queryViewMappings;
  if (!Array.isArray(rawMappings)) return [];
  return rawMappings
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => ({
      sourceQueryViewName: typeof mapping.sourceQueryViewName === 'string' ? mapping.sourceQueryViewName : '',
      sourceFileName: typeof mapping.sourceFileName === 'string' ? mapping.sourceFileName : undefined,
      action: mapping.action === 'copy_source'
        ? 'copy_source' as const
        : mapping.action === 'use_existing_unverified'
          ? 'use_existing_unverified' as const
          : mapping.action === 'update_existing'
            ? 'update_existing' as const
            : 'map_existing' as const,
      targetQueryViewName: typeof mapping.targetQueryViewName === 'string' ? mapping.targetQueryViewName : '',
      targetFileName: typeof mapping.targetFileName === 'string' ? mapping.targetFileName : undefined,
      targetQueryViewLabel: typeof mapping.targetQueryViewLabel === 'string' ? mapping.targetQueryViewLabel : undefined,
    }))
    .filter((mapping) => mapping.sourceQueryViewName && mapping.targetQueryViewName);
}

function relationshipEdgesFromStepDetails(details?: Record<string, unknown>): DashboardMigrationRelationshipEdge[] {
  const rawEdges = details?.relationshipEdges;
  if (!Array.isArray(rawEdges)) return [];
  return rawEdges
    .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === 'object' && !Array.isArray(edge))
    .map((edge) => ({
      joinFromView: typeof edge.joinFromView === 'string' ? edge.joinFromView : '',
      joinToView: typeof edge.joinToView === 'string' ? edge.joinToView : '',
      ...(typeof edge.joinType === 'string' ? { joinType: edge.joinType } : {}),
      ...(typeof edge.relationshipType === 'string' ? { relationshipType: edge.relationshipType } : {}),
    }))
    .filter((edge) => edge.joinFromView && edge.joinToView);
}

export function routeQueryViewActionSummariesFromSteps(steps: MigrationPlanStep[]): RouteQueryViewActionSummary[] {
  const summaries = new Map<string, RouteQueryViewActionSummary>();
  for (const step of steps) {
    if (step.kind !== 'query_view_prepare' && step.kind !== 'import') continue;
    const queryViewMappings = queryViewMappingsFromStepDetails(step.details);
    if (queryViewMappings.length === 0) continue;
    const key = `${step.routeGroupId || 'default-route'}:${step.documentId || 'document'}:${step.targetId || step.destinationId}`;
    const existing = summaries.get(key);
    if (existing) {
      existing.queryViewMappings = [...new Map([...existing.queryViewMappings, ...queryViewMappings].map((mapping) => [
        `${mapping.sourceFileName || mapping.sourceQueryViewName}:${mapping.action}:${mapping.targetFileName || mapping.targetQueryViewName}`,
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
      queryViewMappings,
      warnings: [...new Set(step.warnings || [])],
      blocked: step.blocked === true || Boolean(step.error),
    });
  }
  return [...summaries.values()];
}

export function routeRelationshipActionSummariesFromSteps(steps: MigrationPlanStep[]): RouteRelationshipActionSummary[] {
  const summaries = new Map<string, RouteRelationshipActionSummary>();
  for (const step of steps) {
    if (step.kind !== 'relationship_prepare' && step.kind !== 'import') continue;
    const relationshipEdges = relationshipEdgesFromStepDetails(step.details);
    if (relationshipEdges.length === 0) continue;
    const key = `${step.routeGroupId || 'default-route'}:${step.documentId || 'document'}:${step.targetId || step.destinationId}`;
    const existing = summaries.get(key);
    if (existing) {
      existing.relationshipEdges = [...new Map([...existing.relationshipEdges, ...relationshipEdges].map((edge) => [
        `${edge.joinFromView.toLowerCase()}->${edge.joinToView.toLowerCase()}`,
        edge,
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
      relationshipEdges,
      warnings: [...new Set(step.warnings || [])],
      blocked: step.blocked === true || Boolean(step.error),
    });
  }
  return [...summaries.values()];
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
  return [...summaries.values()];
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
  hasUnresolvedQueryViewMappings?: boolean;
  unresolvedQueryViewMappingMessage?: string;
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
  if (input.hasUnresolvedQueryViewMappings) return input.unresolvedQueryViewMappingMessage || 'Resolve query-view mappings before checking readiness.';
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
  const targets = plan.targets.length > 0
    ? plan.targets
    : [...new Map((plan.routeGroups || []).flatMap((group) => group.targets).map((target) => [target.id, target])).values()];
  return targets.map((target) => {
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

export function buildDashboardMigrationJobInput(input: {
  sourceId: string;
  sourceConnectionId?: string;
  targets: MigrationTarget[];
  routeGroups: MigrationRouteGroup[];
  documentIds: string[];
  sourceDocumentHints?: InstanceDocument[];
  emptyFirst: boolean;
  replaceSameNamed: boolean;
  deleteSourceOnSuccess: boolean;
  postMigrationActions: PostMigrationAction[];
}): MigrationJobInput {
  if (input.targets.length === 0) throw new Error('Add at least one destination before continuing.');
  return {
    sourceId: input.sourceId,
    sourceConnectionId: input.sourceConnectionId,
    targets: input.targets,
    routeGroups: input.routeGroups,
    documentIds: input.documentIds,
    sourceDocumentHints: input.sourceDocumentHints,
    emptyFirst: input.emptyFirst,
    replaceSameNamed: input.replaceSameNamed,
    deleteSourceOnSuccess: input.deleteSourceOnSuccess,
    sourceAllFolders: true,
    postMigrationActions: input.postMigrationActions,
  };
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
      const queryViewActions = routeQueryViewActionSummariesFromSteps(steps);
      const relationshipActions = routeRelationshipActionSummariesFromSteps(steps);
      const topicActions = routeTopicActionSummariesFromSteps(steps);
      const blocker = steps.find((step) => step.blocked || step.error);
      return {
        target,
        steps,
        sourceDocumentIds: route.documentIds,
        dashboardCount: route.documentIds.length,
        queryViewActions,
        queryViewActionCount: queryViewActions.reduce((sum, action) => sum + action.queryViewMappings.length, 0),
        relationshipActions,
        relationshipActionCount: relationshipActions.reduce((sum, action) => sum + action.relationshipEdges.length, 0),
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
      queryViewActionCount: routeTargets.reduce((sum, target) => sum + target.queryViewActionCount, 0),
      relationshipActionCount: routeTargets.reduce((sum, target) => sum + target.relationshipActionCount, 0),
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
