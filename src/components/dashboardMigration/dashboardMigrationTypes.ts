import type {
  InstanceDocument,
  InstanceFolder,
  InstanceModel,
  MigrationJob,
  MigrationPlan,
  MigrationPlanStep,
  MigrationRouteGroup,
  MigrationTarget,
  ModelMigratorConnection,
  SavedInstancePublic,
} from '@/services/opsConsole';

export const DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY = 'omnikit:dashboardMigrationDraft:v1';

export type DashboardMigrationStep = 0 | 1 | 2 | 3 | 4;

export type DashboardMigrationTopicAction = 'map_existing' | 'copy_source' | 'unresolved';
export type DashboardMigrationQueryViewAction = 'map_existing' | 'copy_source' | 'use_existing_unverified' | 'update_existing' | 'unresolved';

export interface DashboardMigrationSourceTopic {
  name: string;
  id?: string;
}

export interface DashboardMigrationTopicMappingDraft {
  sourceTopicName: string;
  sourceTopicId?: string;
  action: DashboardMigrationTopicAction;
  targetTopicName: string;
  targetTopicLabel?: string;
  status?: 'ready' | 'warning' | 'blocked';
  warnings?: string[];
}

export interface DashboardMigrationQueryViewMappingDraft {
  sourceQueryViewName: string;
  sourceFileName?: string;
  action: DashboardMigrationQueryViewAction;
  targetQueryViewName: string;
  targetFileName?: string;
  targetQueryViewLabel?: string;
  status?: 'ready' | 'warning' | 'blocked';
  warnings?: string[];
}

export interface DashboardMigrationTopicCatalogItem {
  name: string;
  label?: string;
  description?: string;
  fileName?: string;
}

export interface DashboardMigrationQueryViewCatalogItem {
  name: string;
  label?: string;
  description?: string;
  fileName?: string;
}

export interface DashboardMigrationTargetDraft {
  id: string;
  destinationInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
  targetModelName: string;
  targetFolderPath: string;
  targetFolderId: string;
  topicMappings?: DashboardMigrationTopicMappingDraft[];
  queryViewMappings?: DashboardMigrationQueryViewMappingDraft[];
}

export function createDashboardMigrationTargetDraft(
  id: string,
  destinationInstance: Pick<SavedInstancePublic, 'id' | 'defaultFolderId' | 'defaultFolderPath'>,
): DashboardMigrationTargetDraft {
  return {
    id,
    destinationInstanceId: destinationInstance.id,
    targetConnectionId: '',
    targetModelId: '',
    targetModelName: '',
    targetFolderPath: destinationInstance.defaultFolderPath || '',
    targetFolderId: destinationInstance.defaultFolderId || '',
    topicMappings: [],
    queryViewMappings: [],
  };
}

export interface DashboardMigrationRouteGroupDraft {
  id: string;
  name: string;
  documentIds: string[];
  targetRowIds: string[];
  topicMappingsByTargetId?: Record<string, DashboardMigrationTopicMappingDraft[]>;
  queryViewMappingsByTargetId?: Record<string, DashboardMigrationQueryViewMappingDraft[]>;
}

export interface DashboardMigrationTargetCatalog {
  connections: ModelMigratorConnection[];
  models: InstanceModel[];
  folders: InstanceFolder[];
  loading: boolean;
  loaded: boolean;
  foldersLoading?: boolean;
  foldersLoaded?: boolean;
  folderError?: string;
  error: string;
}

export interface DashboardMigrationModelCatalog {
  models: InstanceModel[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

export interface DashboardMigrationTopicCatalog {
  topics: DashboardMigrationTopicCatalogItem[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

export interface DashboardMigrationQueryViewCatalog {
  queryViews: DashboardMigrationQueryViewCatalogItem[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

export interface DashboardMigrationDraft {
  step: DashboardMigrationStep;
  sourceId: string;
  sourceConnectionId: string;
  sourceFolderId: string;
  sourceFolderPath: string;
  selectedDocumentIds: string[];
  targets: DashboardMigrationTargetDraft[];
  routeGroups?: DashboardMigrationRouteGroupDraft[];
  routeAssignmentsCustomized?: boolean;
  replaceSameNamed: boolean;
  emptyFirst: boolean;
  refreshSchemaOnComplete: boolean;
  deleteSourceOnSuccess: boolean;
}

export interface DashboardMigrationRuntimeState {
  instances: SavedInstancePublic[];
  documents: InstanceDocument[];
  plan: MigrationPlan | null;
  job: MigrationJob | null;
}

export interface DestinationProgress {
  destinationId: string;
  destinationLabel: string;
  targetIds: string[];
  total: number;
  done: number;
  failed: number;
  warning: number;
  skipped: number;
  running: number;
  status: 'pending' | 'running' | 'succeeded' | 'warning' | 'failed' | 'canceled';
  currentItem?: string;
}

export interface PreflightTargetRow {
  target: MigrationTarget;
  status: 'ready' | 'warning' | 'blocked';
  steps: MigrationPlanStep[];
  warnings: string[];
  notices: string[];
  warningCount: number;
  noticeCount: number;
  deleteCount: number;
  replaceCount: number;
  error?: string;
}

export function targetDraftToMigrationTarget(
  target: DashboardMigrationTargetDraft,
  instances: SavedInstancePublic[],
  topicMappings: DashboardMigrationTopicMappingDraft[] = target.topicMappings || [],
  queryViewMappings: DashboardMigrationQueryViewMappingDraft[] = target.queryViewMappings || [],
): MigrationTarget {
  const destination = instances.find((instance) => instance.id === target.destinationInstanceId);
  return {
    id: target.id,
    destinationInstanceId: target.destinationInstanceId,
    destinationLabel: destination?.label,
    targetConnectionId: target.targetConnectionId || undefined,
    targetModelId: target.targetModelId,
    targetModelName: target.targetModelName || target.targetModelId,
    targetFolderId: target.targetFolderId || undefined,
    targetFolderPath: target.targetFolderPath || undefined,
    topicMappings: topicMappings
      .filter((mapping) => mapping.sourceTopicName && mapping.action !== 'unresolved')
      .map((mapping) => ({
        sourceTopicName: mapping.sourceTopicName,
        sourceTopicId: mapping.sourceTopicId || undefined,
        action: mapping.action === 'copy_source' ? 'copy_source' : 'map_existing',
        targetTopicName: mapping.targetTopicName || mapping.sourceTopicId || mapping.sourceTopicName,
        targetTopicLabel: mapping.targetTopicLabel || undefined,
      })),
    queryViewMappings: queryViewMappings
      .filter((mapping) => mapping.sourceQueryViewName && mapping.action !== 'unresolved')
      .map((mapping) => ({
        sourceQueryViewName: mapping.sourceQueryViewName,
        sourceFileName: mapping.sourceFileName || undefined,
        action: mapping.action === 'copy_source'
          ? 'copy_source'
          : mapping.action === 'use_existing_unverified'
            ? 'use_existing_unverified'
            : mapping.action === 'update_existing'
              ? 'update_existing'
              : 'map_existing',
        targetQueryViewName: mapping.targetQueryViewName || mapping.sourceQueryViewName,
        targetFileName: mapping.targetFileName || undefined,
        targetQueryViewLabel: mapping.targetQueryViewLabel || undefined,
      })),
  };
}

export function routeGroupDraftToMigrationRouteGroup(
  group: DashboardMigrationRouteGroupDraft,
  targets: DashboardMigrationTargetDraft[],
  instances: SavedInstancePublic[],
): MigrationRouteGroup {
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  return {
    id: group.id,
    name: group.name,
    documentIds: [...new Set(group.documentIds.filter(Boolean))],
    targets: group.targetRowIds
      .map((targetRowId) => {
        const target = targetsById.get(targetRowId);
        if (!target) return null;
        return targetDraftToMigrationTarget(
          target,
          instances,
          group.topicMappingsByTargetId?.[targetRowId] || [],
          group.queryViewMappingsByTargetId?.[targetRowId] || [],
        );
      })
      .filter((target): target is MigrationTarget => Boolean(target)),
  };
}
