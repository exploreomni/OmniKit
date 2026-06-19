import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Database,
  FileText,
  FolderInput,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  cancelOpsMigrationJob,
  createOpsMigrationJob,
  getMigrationJob,
  getVaultStatus,
  listInstanceDocuments,
  listInstanceFolders,
  listInstanceModelTopics,
  listModelMigratorConnections,
  listModelMigratorModels,
  listSavedInstances,
  previewMigrationJob,
  retryOpsMigrationJob,
  subscribeMigrationJob,
  unlockNativeVault,
  type InstanceDocument,
  type InstanceFolder,
  type InstanceModel,
  type MigrationJob,
  type MigrationJobInput,
  type MigrationJobItem,
  type MigrationPlan,
  type MigrationTarget,
  type ModelMigratorConnection,
  type PostMigrationAction,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { SearchInput } from '@/components/ui/SearchInput';
import { ComboBox } from '@/components/ui/ComboBox';
import { PassphraseInput } from '@/components/ui/PassphraseInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useConfetti } from '@/hooks/useConfetti';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { DashboardMigrationLaunchScene } from './DashboardMigrationLaunchScene';
import {
  dashboardMatchesSearch,
  modelDisplayLabel,
  sortDocuments,
  sortModels,
  sortSavedInstances,
} from '@/utils/catalogSort';
import {
  applySelectedSourceModelFallback,
  buildDashboardTopicMappings,
  buildRouteGroupsBySourceScope,
  buildTargetFolderOptions,
  buildSchemaRefreshActionsForTargets,
  cleanDashboardModelMetadata,
  collectDashboardSourceTopics,
  completedItem,
  dashboardDocumentModelLabel,
  dashboardDestinationsEmptyState,
  dashboardGroupSelectionAriaLabel,
  dashboardMigrationReviewImpactSummary,
  dashboardSelectionAriaLabel,
  dashboardSelectionEmptyState,
  dashboardSourceScopeLabel,
  destinationInstanceSelectionAriaLabel,
  getDashboardLoadBlockReason,
  getDashboardMigrationPreflightBlockReason,
  isTerminalJobStatus,
  mixedRouteGroupSourceScopeMessage,
  preflightRowsFromPlan,
  preflightRouteGroupsFromPlan,
  statusClass,
  TARGET_FOLDER_COMBOBOX_CONFIG,
  TARGET_MODEL_COMBOBOX_CONFIG,
} from './dashboardMigrationUtils';
import {
  routeGroupDraftToMigrationRouteGroup,
  type DashboardMigrationRouteGroupDraft,
  createDashboardMigrationTargetDraft,
  type DashboardMigrationModelCatalog,
  type DashboardMigrationTargetCatalog,
  type DashboardMigrationTargetDraft,
  type DashboardMigrationTopicCatalog,
  type DashboardMigrationTopicMappingDraft,
  type PreflightTargetRow,
} from './dashboardMigrationTypes';

type WizardStep = 0 | 1 | 2 | 3 | 4;
type ConfirmAction = 'start-with-cleanup' | 'cancel' | null;

const STEP_LABELS = ['Source', 'Dashboards', 'Destinations', 'Review', 'Run'];
const PREFLIGHT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_FOLDER_FILTER = '__omnikit_default_source_folder__';
const MISSING_MODEL_FILTER = '__omnikit_missing_model__';
const MISSING_TOPIC_FILTER = '__omnikit_missing_topic__';
const DEFAULT_ROUTE_GROUP_ID = 'default-route';

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function flattenFolders(folders: InstanceFolder[], prefix = ''): InstanceFolder[] {
  const rows: InstanceFolder[] = [];
  for (const folder of folders) {
    const displayPath = folder.path || folder.identifier || (prefix ? `${prefix}/${folder.name}` : folder.name);
    rows.push({ ...folder, path: displayPath });
    if (folder.children?.length) rows.push(...flattenFolders(folder.children, displayPath));
  }
  return rows;
}

function formatDate(value?: string | number) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function connectionLabel(connection: ModelMigratorConnection) {
  return [connection.name, connection.database].filter(Boolean).join(' - ') || connection.id;
}

function connectionSubtitle(connection: ModelMigratorConnection) {
  return [connection.dialect, connection.defaultSchema].filter(Boolean).join(' / ') || undefined;
}

function metadataList(values?: string[]) {
  return values?.length ? values.join(', ') : 'not detected';
}

function cleanFilterValue(value?: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringFilterOptions(values: Array<string | undefined | null>, allLabel: string) {
  const uniqueValues = [...new Set(values.map(cleanFilterValue).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return [
    { value: '', label: allLabel },
    ...uniqueValues.map((value) => ({ value, label: value })),
  ];
}

function makeTargetRowId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeRouteGroupId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `route-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyTargetRow(): DashboardMigrationTargetDraft {
  return {
    id: makeTargetRowId(),
    destinationInstanceId: '',
    targetConnectionId: '',
    targetModelId: '',
    targetModelName: '',
    targetFolderPath: '',
    targetFolderId: '',
    topicMappings: [],
  };
}

function defaultRouteGroup(documentIds: string[], targetRowIds: string[]): DashboardMigrationRouteGroupDraft {
  return {
    id: DEFAULT_ROUTE_GROUP_ID,
    name: 'All selected dashboards',
    documentIds,
    targetRowIds,
    topicMappingsByTargetId: {},
  };
}

function targetModelCatalogKey(instanceId: string, connectionId: string) {
  return `${instanceId}::${connectionId}`;
}

function targetTopicCatalogKey(instanceId: string, modelId: string) {
  return `${instanceId}::${modelId}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function terminalCount(items: MigrationJobItem[]) {
  return items.filter(completedItem).length;
}

function kindLabel(kind: MigrationJobItem['kind']) {
  if (kind === 'source_delete') return 'SOURCE DELETE';
  if (kind === 'post_action') return 'POST ACTION';
  if (kind === 'topic_prepare') return 'TOPIC PREP';
  return kind.toUpperCase();
}

export function DashboardMigrationWizard() {
  const [step, setStep] = useState<WizardStep>(0);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [sourceConnections, setSourceConnections] = useState<ModelMigratorConnection[]>([]);
  const [sourceModels, setSourceModels] = useState<InstanceModel[]>([]);
  const [documents, setDocuments] = useState<InstanceDocument[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [dashboardFolderFilter, setDashboardFolderFilter] = useState('');
  const [dashboardModelFilter, setDashboardModelFilter] = useState('');
  const [dashboardTopicFilter, setDashboardTopicFilter] = useState('');
  const [dashboardLabelFilter, setDashboardLabelFilter] = useState('');
  const [targetRows, setTargetRows] = useState<DashboardMigrationTargetDraft[]>([]);
  const [routeGroups, setRouteGroups] = useState<DashboardMigrationRouteGroupDraft[]>([]);
  const [activeRouteGroupId, setActiveRouteGroupId] = useState(DEFAULT_ROUTE_GROUP_ID);
  const [routeSelectionIds, setRouteSelectionIds] = useState<string[]>([]);
  const [targetInstanceSelectionIds, setTargetInstanceSelectionIds] = useState<string[]>([]);
  const [advancedGroupingOpen, setAdvancedGroupingOpen] = useState(false);
  const [targetCatalogs, setTargetCatalogs] = useState<Record<string, DashboardMigrationTargetCatalog>>({});
  const [targetModelCatalogs, setTargetModelCatalogs] = useState<Record<string, DashboardMigrationModelCatalog>>({});
  const [targetTopicCatalogs, setTargetTopicCatalogs] = useState<Record<string, DashboardMigrationTopicCatalog>>({});
  const [replaceSameNamed, setReplaceSameNamed] = useState(true);
  const [emptyFirst, setEmptyFirst] = useState(false);
  const [refreshSchemaOnComplete, setRefreshSchemaOnComplete] = useState(false);
  const [deleteSourceOnSuccess, setDeleteSourceOnSuccess] = useState(false);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [planRows, setPlanRows] = useState<PreflightTargetRow[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [loadingSourceCatalog, setLoadingSourceCatalog] = useState(false);
  const [loadingSourceModels, setLoadingSourceModels] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [dashboardLoadAttempted, setDashboardLoadAttempted] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fireConfetti = useConfetti();
  const logOperation = useLogOperation();

  const creatingVault = vaultStatus?.exists === false;
  const passphraseMatches = !creatingVault || passphrase === passphraseConfirm;
  const passphraseMeetsMinimum = !creatingVault || passphrase.trim().length >= 8;
  const canUnlockVault = Boolean(passphrase.trim()) && !unlocking && passphraseMatches && passphraseMeetsMinimum;

  const sourceInstances = useMemo(
    () => sortSavedInstances(instances.filter((instance) => instance.role === 'source' || instance.role === 'both')),
    [instances],
  );
  const targetInstances = useMemo(
    () => sortSavedInstances(instances.filter((instance) => instance.role === 'destination' || instance.role === 'both')),
    [instances],
  );
  const sourceInstance = instances.find((instance) => instance.id === sourceId);
  const selectedDocuments = documents.filter((document) => selectedDocumentIds.includes(document.identifier));
  const sourceTopics = useMemo(() => collectDashboardSourceTopics(selectedDocuments), [selectedDocuments]);
  const targetRowIds = useMemo(() => targetRows.map((row) => row.id), [targetRows]);
  const hasAdvancedDashboardGroups = useMemo(() => routeGroups.some((group) => group.id !== DEFAULT_ROUTE_GROUP_ID), [routeGroups]);

  useEffect(() => {
    const validDocumentIds = new Set(selectedDocumentIds);
    const validTargetRowIds = new Set(targetRowIds);
    setRouteGroups((current) => {
      const preservedGroups = current
        .filter((group) => group.id !== DEFAULT_ROUTE_GROUP_ID)
        .map((group) => ({
          ...group,
          documentIds: group.documentIds.filter((documentId) => validDocumentIds.has(documentId)),
          targetRowIds: group.targetRowIds.filter((targetRowId) => validTargetRowIds.has(targetRowId)),
          topicMappingsByTargetId: Object.fromEntries(
            Object.entries(group.topicMappingsByTargetId || {}).filter(([targetRowId]) => validTargetRowIds.has(targetRowId)),
          ),
        }))
        .filter((group) => group.documentIds.length > 0 && group.targetRowIds.length > 0);
      return preservedGroups.length > 0
        ? preservedGroups
        : [defaultRouteGroup(selectedDocumentIds, targetRowIds)];
    });
    setRouteSelectionIds((current) => current.filter((documentId) => validDocumentIds.has(documentId)));
  }, [selectedDocumentIds, targetRowIds]);

  useEffect(() => {
    if (routeGroups.some((group) => group.id === activeRouteGroupId)) return;
    setActiveRouteGroupId(routeGroups[0]?.id || DEFAULT_ROUTE_GROUP_ID);
  }, [activeRouteGroupId, routeGroups]);

  useEffect(() => {
    if (hasAdvancedDashboardGroups) setAdvancedGroupingOpen(true);
  }, [hasAdvancedDashboardGroups]);

  const sourceInstanceOptions = useMemo(() => sourceInstances.map((instance) => ({
    value: instance.id,
    label: instance.label,
    subtitle: instance.baseUrl.replace(/^https?:\/\//, ''),
  })), [sourceInstances]);

  const targetInstanceOptions = useMemo(() => targetInstances.map((instance) => ({
    value: instance.id,
    label: instance.label,
    subtitle: instance.baseUrl.replace(/^https?:\/\//, ''),
  })), [targetInstances]);

  const sourceConnectionOptions = useMemo(() => sourceConnections.map((connection) => ({
    value: connection.id,
    label: connectionLabel(connection),
    subtitle: connectionSubtitle(connection),
  })), [sourceConnections]);

  const sourceModelNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const model of sourceModels) {
      const label = cleanDashboardModelMetadata(model.name) || cleanDashboardModelMetadata(model.identifier) || model.id;
      for (const key of [model.id, model.identifier, model.baseModelId, model.name]) {
        const cleaned = cleanDashboardModelMetadata(key);
        if (cleaned && !names.has(cleaned)) names.set(cleaned, label);
      }
    }
    return names;
  }, [sourceModels]);

  const sourceModelKeys = useMemo(() => new Set([...sourceModelNameById.keys()]), [sourceModelNameById]);

  useEffect(() => {
    if (!sourceConnectionId || sourceModels.length !== 1) return;
    setDocuments((current) => {
      const next = applySelectedSourceModelFallback(current, {
        sourceModelId: sourceModels[0].id,
        sourceModels,
      });
      const changed = next.some((document, index) => (
        document.baseModelId !== current[index]?.baseModelId
        || document.baseModelName !== current[index]?.baseModelName
      ));
      return changed ? next : current;
    });
  }, [sourceConnectionId, sourceModels]);

  const dashboardFolderOptions = useMemo(() => {
    const hasDefaultFolder = documents.some((document) => !cleanFilterValue(document.folderPath));
    const options = stringFilterOptions(documents.map((document) => document.folderPath), 'All folders');
    if (hasDefaultFolder) {
      options.push({ value: DEFAULT_SOURCE_FOLDER_FILTER, label: 'My Documents/default' });
    }
    return options;
  }, [documents]);

  const dashboardModelOptions = useMemo(() => {
    const options = new Map<string, { value: string; label: string; subtitle?: string }>();
    options.set('', { value: '', label: 'All models' });
    for (const document of documents) {
      const model = dashboardDocumentModelLabel(document, sourceModelNameById);
      const id = cleanDashboardModelMetadata(document.baseModelId);
      const name = cleanDashboardModelMetadata(document.baseModelName);
      const value = id || name || MISSING_MODEL_FILTER;
      if (!options.has(value)) {
        options.set(value, {
          value,
          label: model.detected ? model.label : 'Model unavailable',
          subtitle: id && id !== model.label ? id : undefined,
        });
      }
    }
    return [...options.values()].sort((a, b) => (a.value ? a.label.localeCompare(b.label) : -1));
  }, [documents, sourceModelNameById]);

  const dashboardTopicOptions = useMemo(() => {
    const options = new Map<string, { value: string; label: string; subtitle?: string }>();
    options.set('', { value: '', label: 'All topics' });
    for (const document of documents) {
      const topicNames = (document.topicNames || []).map(cleanFilterValue).filter(Boolean);
      const topicIds = (document.topicIds || []).map(cleanFilterValue).filter(Boolean);
      if (topicNames.length === 0 && topicIds.length === 0) {
        options.set(MISSING_TOPIC_FILTER, { value: MISSING_TOPIC_FILTER, label: 'Topic not detected' });
        continue;
      }
      const count = Math.max(topicNames.length, topicIds.length);
      for (let index = 0; index < count; index += 1) {
        const value = topicIds[index] || topicNames[index];
        const label = topicNames[index] || topicIds[index];
        if (value && label && !options.has(value)) {
          options.set(value, { value, label, subtitle: topicIds[index] && topicIds[index] !== label ? topicIds[index] : undefined });
        }
      }
    }
    return [...options.values()].sort((a, b) => (a.value ? a.label.localeCompare(b.label) : -1));
  }, [documents]);

  const dashboardLabelOptions = useMemo(() => (
    stringFilterOptions(documents.flatMap((document) => document.labels || []), 'All labels')
  ), [documents]);

  const filteredDocuments = useMemo(() => {
    return sortDocuments(documents).filter((document) => {
      if (sourceConnectionId && document.connectionId && document.connectionId !== sourceConnectionId) return false;
      if (sourceConnectionId && sourceModelKeys.size > 0) {
        const keys = [cleanDashboardModelMetadata(document.baseModelId), cleanDashboardModelMetadata(document.baseModelName)]
          .filter((value): value is string => Boolean(value));
        if (keys.length > 0 && !keys.some((key) => sourceModelKeys.has(key))) return false;
      }
      if (dashboardFolderFilter) {
        const folderKey = cleanFilterValue(document.folderPath) || DEFAULT_SOURCE_FOLDER_FILTER;
        if (folderKey !== dashboardFolderFilter) return false;
      }
      if (dashboardModelFilter) {
        const modelKeys = [cleanDashboardModelMetadata(document.baseModelId), cleanDashboardModelMetadata(document.baseModelName)]
          .filter((value): value is string => Boolean(value));
        if (dashboardModelFilter === MISSING_MODEL_FILTER) {
          if (modelKeys.length > 0) return false;
        } else if (!modelKeys.includes(dashboardModelFilter)) {
          return false;
        }
      }
      if (dashboardTopicFilter) {
        const topicKeys = [...(document.topicNames || []), ...(document.topicIds || [])]
          .map(cleanFilterValue)
          .filter(Boolean);
        if (dashboardTopicFilter === MISSING_TOPIC_FILTER) {
          if (topicKeys.length > 0) return false;
        } else if (!topicKeys.includes(dashboardTopicFilter)) {
          return false;
        }
      }
      if (dashboardLabelFilter && !(document.labels || []).includes(dashboardLabelFilter)) return false;
      return dashboardMatchesSearch(document, search);
    });
  }, [
    dashboardFolderFilter,
    dashboardLabelFilter,
    dashboardModelFilter,
    dashboardTopicFilter,
    documents,
    search,
    sourceConnectionId,
    sourceModelKeys,
  ]);
  const dashboardEmptyState = dashboardSelectionEmptyState({
    loading: loadingDocuments,
    hasSourceConnection: Boolean(sourceConnectionId),
    hasLoadedDashboards: dashboardLoadAttempted,
    totalCount: documents.length,
    visibleCount: filteredDocuments.length,
  });

  const activeRouteGroup = routeGroups.find((group) => group.id === activeRouteGroupId) || routeGroups[0] || defaultRouteGroup(selectedDocumentIds, targetRowIds);
  const activeRouteDocuments = documents.filter((document) => activeRouteGroup.documentIds.includes(document.identifier));
  const activeRouteSourceTopics = useMemo(() => collectDashboardSourceTopics(activeRouteDocuments), [activeRouteDocuments]);

  const activeTargetRowsWithTopicMappings = useMemo<DashboardMigrationTargetDraft[]>(() => (
    targetRows.map((row) => {
      const existingMappings = activeRouteGroup.topicMappingsByTargetId?.[row.id] || [];
      if (!activeRouteGroup.targetRowIds.includes(row.id)) return { ...row, topicMappings: existingMappings };
      if (activeRouteSourceTopics.length === 0) return { ...row, topicMappings: [] };
      if (!row.destinationInstanceId || !row.targetModelId) return { ...row, topicMappings: existingMappings };
      const topicCatalog = targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)];
      if (!topicCatalog?.loaded) return { ...row, topicMappings: existingMappings };
      return {
        ...row,
        topicMappings: buildDashboardTopicMappings(activeRouteSourceTopics, topicCatalog.topics, existingMappings),
      };
    })
  ), [activeRouteGroup, activeRouteSourceTopics, targetRows, targetTopicCatalogs]);

  const compiledRouteGroups = useMemo(() => (
    routeGroups
      .map((group) => {
        const groupDocuments = documents.filter((document) => group.documentIds.includes(document.identifier));
        const groupTopics = collectDashboardSourceTopics(groupDocuments);
        const groupRows: DashboardMigrationTargetDraft[] = [];
        const topicMappingsByTargetId: DashboardMigrationRouteGroupDraft['topicMappingsByTargetId'] = {};
        for (const row of targetRows) {
          const existingMappings = group.topicMappingsByTargetId?.[row.id] || [];
          if (!group.targetRowIds.includes(row.id)) continue;
          if (groupTopics.length === 0 || !row.destinationInstanceId || !row.targetModelId) {
            topicMappingsByTargetId[row.id] = existingMappings;
            groupRows.push(row);
            continue;
          }
          const topicCatalog = targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)];
          topicMappingsByTargetId[row.id] = topicCatalog?.loaded
            ? buildDashboardTopicMappings(groupTopics, topicCatalog.topics, existingMappings)
            : existingMappings;
          groupRows.push(row);
        }
        return routeGroupDraftToMigrationRouteGroup({
          ...group,
          documentIds: group.documentIds.filter((documentId) => selectedDocumentIds.includes(documentId)),
          topicMappingsByTargetId,
        }, groupRows, instances);
      })
      .filter((group) => group.documentIds.length > 0 && group.targets.length > 0)
  ), [documents, instances, routeGroups, selectedDocumentIds, targetRows, targetTopicCatalogs]);

  const migrationTargets = useMemo<MigrationTarget[]>(() => {
    const targetsById = new Map<string, MigrationTarget>();
    for (const target of compiledRouteGroups.flatMap((group) => group.targets)) {
      if (!targetsById.has(target.id)) targetsById.set(target.id, target);
    }
    return [...targetsById.values()];
  }, [compiledRouteGroups]);

  const postMigrationActions = useMemo<PostMigrationAction[]>(
    () => buildSchemaRefreshActionsForTargets(migrationTargets, instances, refreshSchemaOnComplete),
    [instances, migrationTargets, refreshSchemaOnComplete],
  );

  const routedTargetRowIds = useMemo(() => new Set(routeGroups.flatMap((group) => group.targetRowIds)), [routeGroups]);
  const routeGroupBlockReason = useMemo(() => {
    if (routeGroups.length === 0) return 'Create at least one dashboard group before checking readiness.';
    const groupWithoutDocuments = routeGroups.find((group) => group.documentIds.length === 0);
    if (groupWithoutDocuments) return `Choose at least one dashboard for dashboard group ${groupWithoutDocuments.name}.`;
    const groupWithoutTargets = routeGroups.find((group) => group.targetRowIds.length === 0);
    if (groupWithoutTargets) return `Choose at least one destination for dashboard group ${groupWithoutTargets.name}.`;
    for (const group of routeGroups) {
      const mixedMessage = mixedRouteGroupSourceScopeMessage(group, documents);
      if (mixedMessage) return mixedMessage;
    }
    return '';
  }, [documents, routeGroups]);

  const topicMappingBlockMessage = useMemo(() => {
    for (const group of routeGroups) {
      const groupDocuments = documents.filter((document) => group.documentIds.includes(document.identifier));
      const groupTopics = collectDashboardSourceTopics(groupDocuments);
      if (groupTopics.length === 0) continue;
      for (const targetRowId of group.targetRowIds) {
        const row = targetRows.find((targetRow) => targetRow.id === targetRowId);
        if (!row?.destinationInstanceId || !row.targetModelId) continue;
        const topicCatalog = targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)];
        if (!topicCatalog?.loaded) continue;
        const mappings = buildDashboardTopicMappings(groupTopics, topicCatalog.topics, group.topicMappingsByTargetId?.[targetRowId] || []);
        const unresolved = mappings.find((mapping) => !mapping.targetTopicName || mapping.status === 'blocked' || mapping.action === 'unresolved');
        if (unresolved) {
          const destinationLabel = instances.find((instance) => instance.id === row.destinationInstanceId)?.label || row.destinationInstanceId;
          return `Resolve topic mapping for ${unresolved.sourceTopicName} in ${group.name} on ${destinationLabel}.`;
        }
      }
    }
    return '';
  }, [documents, instances, routeGroups, targetRows, targetTopicCatalogs]);

  const hasLoadingTargets = targetRows.some((row) => {
    if (!routedTargetRowIds.has(row.id)) return false;
    const targetCatalog = row.destinationInstanceId ? targetCatalogs[row.destinationInstanceId] : null;
    const modelCatalog = row.destinationInstanceId && row.targetConnectionId
      ? targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)]
      : null;
    const topicCatalog = row.destinationInstanceId && row.targetModelId
      ? targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
    return targetCatalog?.loading || modelCatalog?.loading || topicCatalog?.loading;
  });
  const hasUnresolvedFolderTargets = targetRows.some((row) => routedTargetRowIds.has(row.id) && Boolean(row.targetFolderId && !row.targetFolderPath));
  const hasInvalidTargetModel = targetRows.some((row) => {
    if (!routedTargetRowIds.has(row.id)) return false;
    if (!row.destinationInstanceId || !row.targetConnectionId || !row.targetModelId) return false;
    const modelCatalog = targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)];
    if (!modelCatalog?.loaded) return false;
    return !modelCatalog.models.some((model) => model.id === row.targetModelId);
  });
  const hasUnresolvedTopicMappings = Boolean(topicMappingBlockMessage);
  const dashboardLoadBlockReason = getDashboardLoadBlockReason({
    sourceId,
    sourceConnectionId,
    loadingDocuments,
    loadingSourceModels,
  });
  const preflightBlockReason = getDashboardMigrationPreflightBlockReason({
    sourceId,
    sourceConnectionId,
    selectedDocumentIds,
    targets: migrationTargets,
    hasLoadingTargets,
    hasInvalidTargetModel,
    hasUnresolvedFolderTargets,
    routeGroupBlockReason,
    hasUnresolvedTopicMappings,
    unresolvedTopicMappingMessage: topicMappingBlockMessage,
    preflightLoading,
    jobBusy,
  });

  const canLoadDashboards = !dashboardLoadBlockReason;
  const canPreflight = !preflightBlockReason;
  const routeReviewGroups = useMemo(() => preflightRouteGroupsFromPlan(plan), [plan]);
  const reviewImpactSummary = useMemo(() => dashboardMigrationReviewImpactSummary(plan, {
    routeGroups: routeReviewGroups,
    selectedDashboardCount: selectedDocumentIds.length,
    refreshSchemaOnComplete,
    deleteSourceOnSuccess,
  }), [deleteSourceOnSuccess, plan, refreshSchemaOnComplete, routeReviewGroups, selectedDocumentIds.length]);
  const blockedRows = planRows.filter((row) => row.status === 'blocked');
  const targetDeleteCount = planRows.reduce((sum, row) => sum + row.deleteCount, 0);
  const replacementCount = planRows.reduce((sum, row) => sum + row.replaceCount, 0);
  const requiresStartConfirmation = deleteSourceOnSuccess || (targetDeleteCount > 0 && (emptyFirst || replaceSameNamed));
  const startConfirmationMessage = [
    targetDeleteCount > 0
      ? emptyFirst
        ? `move ${targetDeleteCount} existing target dashboard${targetDeleteCount === 1 ? '' : 's'} to Trash before import`
        : `replace ${replacementCount} same-named target dashboard${replacementCount === 1 ? '' : 's'} before import`
      : '',
    deleteSourceOnSuccess
      ? `move ${selectedDocumentIds.length} source dashboard${selectedDocumentIds.length === 1 ? '' : 's'} to Trash only after every target succeeds and selected post-actions do not fail`
      : '',
  ].filter(Boolean).join(' and ');
  const canRun = planRows.length > 0 && blockedRows.length === 0 && !preflightBlockReason && !jobBusy;
  const jobDone = job ? isTerminalJobStatus(job.status) : false;
  const exportItems = job?.items.filter((item) => item.kind === 'export') || [];
  const importItems = job?.items.filter((item) => item.kind === 'import') || [];
  const topicPrepareItems = job?.items.filter((item) => item.kind === 'topic_prepare') || [];
  const refreshItems = job?.items.filter((item) => item.kind === 'post_action') || [];
  const sourceDeleteItems = job?.items.filter((item) => item.kind === 'source_delete') || [];
  const totalItems = job?.items.length || 0;
  const completedItems = job ? terminalCount(job.items) : 0;

  const refresh = useCallback(async () => {
    setError('');
    try {
      const status = await getVaultStatus();
      setVaultStatus(status);
      if (!status.unlocked) {
        setInstances([]);
        return;
      }
      const res = await listSavedInstances();
      setInstances(res.instances);
    } catch (err) {
      setError(errorText(err, 'Could not load migration state.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const activeJobId = job?.id;
    const activeJobStatus = job?.status;
    if (!activeJobId || !activeJobStatus || isTerminalJobStatus(activeJobStatus)) return undefined;
    let closed = false;
    const unsubscribe = subscribeMigrationJob(
      activeJobId,
      async (event) => {
        if (closed) return;
        if (event.type === 'snapshot' && event.job) {
          setJob(event.job);
        } else if (event.type === 'job' && event.job) {
          setJob(event.job);
          if (event.job.status === 'succeeded') fireConfetti({ count: 90, originY: 0.28 });
          if (isTerminalJobStatus(event.job.status)) {
            const successful = event.job.items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length;
            const failed = event.job.items.filter((item) => item.status === 'failed').length;
            logOperation('migration', `Dashboard migration ${event.job.status}`, {
              itemCount: event.job.items.length,
              successCount: successful,
              failureCount: failed,
              durationMs: event.job.startedAt ? Date.now() - event.job.startedAt : 0,
            });
          }
        } else if (event.type === 'item' && event.item) {
          setJob((prev) => {
            if (!prev || prev.id !== event.item?.jobId) return prev;
            return {
              ...prev,
              items: prev.items.map((item) => item.id === event.item?.id ? event.item : item),
            };
          });
        }
      },
      async () => {
        if (closed) return;
        try {
          const res = await getMigrationJob(activeJobId);
          setJob(res.job);
        } catch {
          // Manual refresh/retry can recover if the stream is interrupted.
        }
      },
    );
    return () => {
      closed = true;
      unsubscribe();
    };
  }, [fireConfetti, job?.id, job?.status, logOperation]);

  function resetPlan() {
    setPlan(null);
    setPlanRows([]);
    setJob(null);
  }

  function resetDashboardSelection() {
    setDocuments([]);
    setSelectedDocumentIds([]);
    setSearch('');
    setDashboardFolderFilter('');
    setDashboardModelFilter('');
    setDashboardTopicFilter('');
    setDashboardLabelFilter('');
    setDashboardLoadAttempted(false);
  }

  async function unlockVault() {
    setUnlocking(true);
    setError('');
    setMessage('');
    try {
      const res = await unlockNativeVault(passphrase);
      setVaultStatus(res.status);
      setPassphrase('');
      setPassphraseConfirm('');
      setMessage('Native vault unlocked. Choose a source instance to begin.');
      await refresh();
    } catch (err) {
      setError(errorText(err, 'Could not unlock the native vault.'));
    } finally {
      setUnlocking(false);
    }
  }

  async function loadSourceCatalog(instanceId: string) {
    if (!instanceId) return;
    setLoadingSourceCatalog(true);
    setError('');
    try {
      const connectionsRes = await listModelMigratorConnections(instanceId);
      const activeConnections = connectionsRes.connections.filter((connection) => !connection.deletedAt);
      setSourceConnections(activeConnections);
      if (activeConnections.length === 1) setSourceConnectionId(activeConnections[0].id);
    } catch (err) {
      setError(errorText(err, 'Could not load source connections.'));
    } finally {
      setLoadingSourceCatalog(false);
    }
  }

  async function loadTargetCatalog(instanceId: string): Promise<DashboardMigrationTargetCatalog | null> {
    if (!instanceId) return null;
    const current = targetCatalogs[instanceId];
    if (current?.loaded && !current.loading) return current;
    setTargetCatalogs((prev) => ({
      ...prev,
      [instanceId]: {
        connections: prev[instanceId]?.connections || [],
        models: prev[instanceId]?.models || [],
        folders: prev[instanceId]?.folders || [],
        loading: true,
        loaded: prev[instanceId]?.loaded || false,
        error: '',
      },
    }));
    try {
      const [connectionsRes, foldersRes] = await Promise.all([
        listModelMigratorConnections(instanceId),
        listInstanceFolders(instanceId),
      ]);
      const catalog: DashboardMigrationTargetCatalog = {
        connections: connectionsRes.connections.filter((connection) => !connection.deletedAt),
        models: [],
        folders: flattenFolders(foldersRes.folders),
        loading: false,
        loaded: true,
        error: '',
      };
      setTargetCatalogs((prev) => ({ ...prev, [instanceId]: catalog }));
      return catalog;
    } catch (err) {
      const catalog: DashboardMigrationTargetCatalog = {
        connections: current?.connections || [],
        models: [],
        folders: current?.folders || [],
        loading: false,
        loaded: false,
        error: errorText(err, 'Could not load target connections and folders.'),
      };
      setTargetCatalogs((prev) => ({ ...prev, [instanceId]: catalog }));
      setError(catalog.error);
      return catalog;
    }
  }

  async function loadTargetModels(instanceId: string, connectionId: string): Promise<DashboardMigrationModelCatalog | null> {
    if (!instanceId || !connectionId) return null;
    const key = targetModelCatalogKey(instanceId, connectionId);
    const current = targetModelCatalogs[key];
    if (current?.loaded && !current.loading) return current;
    setTargetModelCatalogs((prev) => ({
      ...prev,
      [key]: {
        models: prev[key]?.models || [],
        loading: true,
        loaded: prev[key]?.loaded || false,
        error: '',
      },
    }));
    try {
      const res = await listModelMigratorModels(instanceId, { connectionId });
      const catalog: DashboardMigrationModelCatalog = {
        models: sortModels(res.models),
        loading: false,
        loaded: true,
        error: '',
      };
      setTargetModelCatalogs((prev) => ({ ...prev, [key]: catalog }));
      return catalog;
    } catch (err) {
      const catalog: DashboardMigrationModelCatalog = {
        models: current?.models || [],
        loading: false,
        loaded: false,
        error: errorText(err, 'Could not load target models for the selected connection.'),
      };
      setTargetModelCatalogs((prev) => ({ ...prev, [key]: catalog }));
      setError(catalog.error);
      return catalog;
    }
  }

  async function loadTargetTopics(instanceId: string, modelId: string): Promise<DashboardMigrationTopicCatalog | null> {
    if (!instanceId || !modelId) return null;
    const key = targetTopicCatalogKey(instanceId, modelId);
    const current = targetTopicCatalogs[key];
    if (current?.loaded && !current.loading) return current;
    setTargetTopicCatalogs((prev) => ({
      ...prev,
      [key]: {
        topics: prev[key]?.topics || [],
        loading: true,
        loaded: prev[key]?.loaded || false,
        error: '',
      },
    }));
    try {
      const res = await listInstanceModelTopics(instanceId, modelId);
      const catalog: DashboardMigrationTopicCatalog = {
        topics: [...res.topics].sort((a, b) => a.name.localeCompare(b.name)),
        loading: false,
        loaded: true,
        error: '',
      };
      setTargetTopicCatalogs((prev) => ({ ...prev, [key]: catalog }));
      return catalog;
    } catch (err) {
      const catalog: DashboardMigrationTopicCatalog = {
        topics: current?.topics || [],
        loading: false,
        loaded: false,
        error: errorText(err, 'Could not load target topics for the selected model.'),
      };
      setTargetTopicCatalogs((prev) => ({ ...prev, [key]: catalog }));
      setError(catalog.error);
      return catalog;
    }
  }

  useEffect(() => {
    if (!sourceId || !sourceConnectionId) {
      setSourceModels([]);
      return;
    }
    let canceled = false;
    setLoadingSourceModels(true);
    void listModelMigratorModels(sourceId, { connectionId: sourceConnectionId })
      .then((res) => {
        if (!canceled) setSourceModels(res.models);
      })
      .catch((err) => {
        if (!canceled) setError(errorText(err, 'Could not load source models for the selected connection.'));
      })
      .finally(() => {
        if (!canceled) setLoadingSourceModels(false);
      });
    return () => {
      canceled = true;
    };
  }, [sourceConnectionId, sourceId]);

  function chooseSource(nextSourceId: string) {
    setSourceId(nextSourceId);
    setSourceConnectionId('');
    setSourceConnections([]);
    setSourceModels([]);
    resetDashboardSelection();
    resetPlan();
    if (nextSourceId) void loadSourceCatalog(nextSourceId);
  }

  function addTargetRow() {
    setTargetRows((prev) => [...prev, emptyTargetRow()]);
    resetPlan();
  }

  function toggleTargetInstanceSelection(instanceId: string) {
    setTargetInstanceSelectionIds((current) => current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId]);
  }

  async function hydrateTargetRowDefaults(rowId: string, destinationInstanceId: string) {
    const catalog = await loadTargetCatalog(destinationInstanceId);
    if (catalog?.connections.length === 1) {
      await chooseTargetConnection(rowId, destinationInstanceId, catalog.connections[0].id);
    }
  }

  async function addSelectedTargetInstances() {
    const selectedInstances = targetInstanceSelectionIds
      .map((instanceId) => instances.find((instance) => instance.id === instanceId))
      .filter((instance): instance is SavedInstancePublic => Boolean(instance));
    if (selectedInstances.length === 0) {
      setMessage('Choose one or more destination instances before adding destinations.');
      return;
    }
    const nextRows = selectedInstances.map((instance) => createDashboardMigrationTargetDraft(makeTargetRowId(), instance));
    setTargetRows((prev) => [...prev, ...nextRows]);
    setTargetInstanceSelectionIds([]);
    resetPlan();
    await Promise.all(nextRows.map((row) => hydrateTargetRowDefaults(row.id, row.destinationInstanceId)));
  }

  async function duplicateTargetRow(row: DashboardMigrationTargetDraft) {
    const duplicate: DashboardMigrationTargetDraft = {
      ...row,
      id: makeTargetRowId(),
      topicMappings: [],
    };
    setTargetRows((prev) => [...prev, duplicate]);
    resetPlan();
    if (duplicate.destinationInstanceId) await loadTargetCatalog(duplicate.destinationInstanceId);
    if (duplicate.destinationInstanceId && duplicate.targetConnectionId) {
      await loadTargetModels(duplicate.destinationInstanceId, duplicate.targetConnectionId);
    }
    if (duplicate.destinationInstanceId && duplicate.targetModelId) {
      void loadTargetTopics(duplicate.destinationInstanceId, duplicate.targetModelId);
    }
  }

  function removeTargetRow(rowId: string) {
    setTargetRows((prev) => prev.filter((row) => row.id !== rowId));
    resetPlan();
  }

  function patchTargetRow(rowId: string, patch: Partial<DashboardMigrationTargetDraft>) {
    setTargetRows((prev) => prev.map((row) => row.id === rowId ? { ...row, ...patch } : row));
    resetPlan();
  }

  function clearRouteTopicMappingsForTarget(rowId: string) {
    setRouteGroups((current) => current.map((group) => {
      if (!group.topicMappingsByTargetId?.[rowId]) return group;
      const topicMappingsByTargetId = { ...group.topicMappingsByTargetId };
      delete topicMappingsByTargetId[rowId];
      return { ...group, topicMappingsByTargetId };
    }));
  }

  async function chooseTargetInstance(rowId: string, destinationInstanceId: string) {
    const destination = instances.find((instance) => instance.id === destinationInstanceId);
    patchTargetRow(rowId, {
      destinationInstanceId,
      targetConnectionId: '',
      targetModelId: '',
      targetModelName: '',
      targetFolderId: destination?.defaultFolderId || '',
      targetFolderPath: destination?.defaultFolderPath || '',
      topicMappings: [],
    });
    clearRouteTopicMappingsForTarget(rowId);
    const catalog = await loadTargetCatalog(destinationInstanceId);
    if (catalog?.connections.length === 1) {
      await chooseTargetConnection(rowId, destinationInstanceId, catalog.connections[0].id);
    }
  }

  async function chooseTargetConnection(rowId: string, destinationInstanceId: string, targetConnectionId: string) {
    patchTargetRow(rowId, {
      targetConnectionId,
      targetModelId: '',
      targetModelName: '',
      topicMappings: [],
    });
    clearRouteTopicMappingsForTarget(rowId);
    const catalog = await loadTargetModels(destinationInstanceId, targetConnectionId);
    if (!catalog) return;
    const destination = instances.find((instance) => instance.id === destinationInstanceId);
    const defaultModel = destination?.defaultModelId
      ? catalog.models.find((model) => model.id === destination.defaultModelId)
      : null;
    const model = defaultModel || (catalog.models.length === 1 ? catalog.models[0] : null);
    if (model) {
      patchTargetRow(rowId, {
        targetModelId: model.id,
        targetModelName: modelDisplayLabel(model),
        topicMappings: [],
      });
      void loadTargetTopics(destinationInstanceId, model.id);
    }
  }

  function chooseTargetModel(row: DashboardMigrationTargetDraft, targetModelId: string) {
    const modelCatalog = row.destinationInstanceId && row.targetConnectionId
      ? targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)]
      : null;
    const model = modelCatalog?.models.find((item) => item.id === targetModelId);
    if (targetModelId && modelCatalog?.loaded && !model) {
      patchTargetRow(row.id, {
        targetModelId: '',
        targetModelName: '',
        topicMappings: [],
      });
      clearRouteTopicMappingsForTarget(row.id);
      setError('Choose a target model from the selected connection catalog.');
      return;
    }
    setError('');
    patchTargetRow(row.id, {
      targetModelId,
      targetModelName: model ? modelDisplayLabel(model) : targetModelId,
      topicMappings: [],
    });
    clearRouteTopicMappingsForTarget(row.id);
    if (row.destinationInstanceId && targetModelId) void loadTargetTopics(row.destinationInstanceId, targetModelId);
  }

  function chooseTargetFolder(row: DashboardMigrationTargetDraft, value: string) {
    const catalog = targetCatalogs[row.destinationInstanceId];
    const folder = catalog?.folders.find((item) => item.path === value || item.identifier === value || item.id === value);
    patchTargetRow(row.id, {
      targetFolderId: folder?.id || '',
      targetFolderPath: folder?.path || value || '',
    });
  }

  function updateTopicMapping(row: DashboardMigrationTargetDraft, nextMapping: DashboardMigrationTopicMappingDraft) {
    const keyFor = (mapping: Pick<DashboardMigrationTopicMappingDraft, 'sourceTopicName' | 'sourceTopicId'>) => (
      (mapping.sourceTopicId || mapping.sourceTopicName).toLowerCase()
    );
    const nextKey = keyFor(nextMapping);
    setRouteGroups((current) => current.map((group) => {
      if (group.id !== activeRouteGroup.id) return group;
      const currentMappings = group.topicMappingsByTargetId?.[row.id] || [];
      const nextMappings = currentMappings.some((mapping) => keyFor(mapping) === nextKey)
        ? currentMappings.map((mapping) => keyFor(mapping) === nextKey ? nextMapping : mapping)
        : [...currentMappings, nextMapping];
      return {
        ...group,
        topicMappingsByTargetId: {
          ...(group.topicMappingsByTargetId || {}),
          [row.id]: nextMappings,
        },
      };
    }));
    resetPlan();
  }

  function toggleRouteSelection(documentId: string) {
    setRouteSelectionIds((current) => current.includes(documentId)
      ? current.filter((id) => id !== documentId)
      : [...current, documentId]);
  }

  function createRouteGroupFromSelection() {
    if (routeSelectionIds.length === 0) {
      setMessage('Choose dashboards in the routing panel before creating a group.');
      return;
    }
    const nextGroup: DashboardMigrationRouteGroupDraft = {
      id: makeRouteGroupId(),
      name: `Route group ${routeGroups.length}`,
      documentIds: routeSelectionIds,
      targetRowIds: activeRouteGroup.targetRowIds.length > 0 ? activeRouteGroup.targetRowIds : targetRowIds,
      topicMappingsByTargetId: {},
    };
    setRouteGroups((current) => [...current.filter((group) => group.id !== DEFAULT_ROUTE_GROUP_ID), nextGroup]);
    setActiveRouteGroupId(nextGroup.id);
    setRouteSelectionIds([]);
    resetPlan();
  }

  function moveSelectionToActiveRouteGroup() {
    if (routeSelectionIds.length === 0) {
      setMessage('Choose dashboards in the routing panel before moving them.');
      return;
    }
    if (activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID) {
      setMessage('The default route already includes every selected dashboard. Choose or create an advanced group before moving dashboards.');
      return;
    }
    const selected = new Set(routeSelectionIds);
    setRouteGroups((current) => current.map((group) => {
      if (group.id === DEFAULT_ROUTE_GROUP_ID) return group;
      if (group.id === activeRouteGroup.id) {
        return { ...group, documentIds: [...new Set([...group.documentIds, ...routeSelectionIds])] };
      }
      return { ...group, documentIds: group.documentIds.filter((documentId) => !selected.has(documentId)) };
    }).filter((group) => group.id === DEFAULT_ROUTE_GROUP_ID || group.documentIds.length > 0));
    setRouteSelectionIds([]);
    resetPlan();
  }

  function duplicateActiveRouteGroup() {
    const duplicate: DashboardMigrationRouteGroupDraft = {
      ...activeRouteGroup,
      id: makeRouteGroupId(),
      name: `${activeRouteGroup.name} copy`,
      documentIds: [...activeRouteGroup.documentIds],
      targetRowIds: [...activeRouteGroup.targetRowIds],
      topicMappingsByTargetId: Object.fromEntries(
        Object.entries(activeRouteGroup.topicMappingsByTargetId || {}).map(([targetRowId, mappings]) => [
          targetRowId,
          mappings.map((mapping) => ({ ...mapping })),
        ]),
      ),
    };
    setRouteGroups((current) => [...current.filter((group) => group.id !== DEFAULT_ROUTE_GROUP_ID), duplicate]);
    setActiveRouteGroupId(duplicate.id);
    resetPlan();
  }

  function removeActiveRouteGroup() {
    if (activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID) {
      setMessage('The default dashboard group cannot be removed.');
      return;
    }
    setRouteGroups((current) => {
      const remaining = current.filter((group) => group.id !== activeRouteGroup.id);
      return remaining.length > 0 ? remaining : [defaultRouteGroup(selectedDocumentIds, targetRowIds)];
    });
    setActiveRouteGroupId(DEFAULT_ROUTE_GROUP_ID);
    resetPlan();
  }

  function autoGroupBySourceScope() {
    const grouped = buildRouteGroupsBySourceScope(documents, selectedDocumentIds, targetRowIds)
      .map((group) => ({ ...group, id: makeRouteGroupId() }));
    setRouteGroups(grouped.length > 0 ? grouped : [defaultRouteGroup(selectedDocumentIds, targetRowIds)]);
    setActiveRouteGroupId(grouped[0]?.id || DEFAULT_ROUTE_GROUP_ID);
    setRouteSelectionIds([]);
    resetPlan();
  }

  function setActiveRouteTargetMembership(rowId: string, included: boolean) {
    if (activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID) return;
    setRouteGroups((current) => current.map((group) => {
      if (group.id !== activeRouteGroup.id) return group;
      const targetRowIds = included
        ? [...new Set([...group.targetRowIds, rowId])]
        : group.targetRowIds.filter((targetRowId) => targetRowId !== rowId);
      const topicMappingsByTargetId = { ...(group.topicMappingsByTargetId || {}) };
      if (!included) delete topicMappingsByTargetId[rowId];
      return { ...group, targetRowIds, topicMappingsByTargetId };
    }));
    resetPlan();
  }

  async function loadDashboards() {
    const blocked = getDashboardLoadBlockReason({
      sourceId,
      sourceConnectionId,
      loadingDocuments,
      loadingSourceModels,
    });
    if (blocked) {
      setError(blocked);
      return;
    }
    setLoadingDocuments(true);
    setDashboardLoadAttempted(true);
    setError('');
    setMessage('');
    resetPlan();
    try {
      const res = await listInstanceDocuments(sourceId, {
        connectionId: sourceConnectionId || undefined,
        allFolders: true,
        includeModelDetails: true,
      });
      const connectionScopedDocuments = sourceConnectionId
        ? res.documents.filter((document) => !document.connectionId || document.connectionId === sourceConnectionId)
        : res.documents;
      let modelRows = sourceModels;
      if (sourceConnectionId && modelRows.length === 0) {
        const modelsRes = await listModelMigratorModels(sourceId, { connectionId: sourceConnectionId });
        modelRows = modelsRes.models;
        setSourceModels(modelsRes.models);
      }
      const fallbackSourceModelId = sourceConnectionId && modelRows.length === 1 ? modelRows[0].id : undefined;
      const nextDocuments = applySelectedSourceModelFallback(connectionScopedDocuments, {
        sourceModelId: fallbackSourceModelId,
        sourceModels: modelRows,
      });
      setDocuments(nextDocuments);
      setSelectedDocumentIds([]);
      setDashboardFolderFilter('');
      setDashboardModelFilter('');
      setDashboardTopicFilter('');
      setDashboardLabelFilter('');
      setMessage(`Loaded ${nextDocuments.length} dashboard document${nextDocuments.length === 1 ? '' : 's'} from the selected connection.`);
      setStep(1);
    } catch (err) {
      setDocuments([]);
      setSelectedDocumentIds([]);
      setError(errorText(err, 'Could not load source dashboards.'));
    } finally {
      setLoadingDocuments(false);
    }
  }

  function toggleDocument(identifier: string) {
    setSelectedDocumentIds((prev) => prev.includes(identifier) ? prev.filter((item) => item !== identifier) : [...prev, identifier]);
    resetPlan();
  }

  function selectAllVisibleDocuments() {
    setSelectedDocumentIds([...new Set([...selectedDocumentIds, ...filteredDocuments.map((document) => document.identifier)])]);
    resetPlan();
  }

  function buildJobInput(): MigrationJobInput {
    if (migrationTargets.length === 0) throw new Error('Add at least one destination before continuing.');
    return {
      sourceId,
      sourceConnectionId,
      targets: migrationTargets,
      routeGroups: compiledRouteGroups,
      documentIds: selectedDocumentIds,
      emptyFirst,
      replaceSameNamed,
      deleteSourceOnSuccess,
      sourceAllFolders: true,
      postMigrationActions,
    };
  }

  async function runPreflight() {
    if (preflightBlockReason) {
      setMessage(preflightBlockReason);
      return;
    }
    setPreflightLoading(true);
    setError('');
    setMessage('Checking that destinations are ready before import.');
    setPlan(null);
    setPlanRows([]);
    try {
      const res = await withTimeout(
        previewMigrationJob(buildJobInput()),
        PREFLIGHT_TIMEOUT_MS,
        'Destination readiness check timed out before OmniKit received a response. No changes were applied.',
      );
      setPlan(res.plan);
      setPlanRows(preflightRowsFromPlan(res.plan));
      setStep(3);
      setMessage('Review is ready. Check warnings before starting the migration.');
    } catch (err) {
      setMessage('');
      setError(errorText(err, 'Could not check destination readiness.'));
    } finally {
      setPreflightLoading(false);
    }
  }

  async function startJob(confirmedCleanup = false) {
    if (requiresStartConfirmation && !confirmedCleanup) {
      setConfirmAction('start-with-cleanup');
      return;
    }
    setJobBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await createOpsMigrationJob(buildJobInput());
      setJob(res.job);
      setStep(4);
      setMessage('Dashboard migration job started.');
    } catch (err) {
      setError(errorText(err, 'Could not start dashboard migration job.'));
    } finally {
      setJobBusy(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    setJobBusy(true);
    setError('');
    try {
      const res = await cancelOpsMigrationJob(job.id);
      setJob(res.job);
      setMessage('Cancellation requested.');
    } catch (err) {
      setError(errorText(err, 'Could not cancel job.'));
    } finally {
      setJobBusy(false);
    }
  }

  async function retryFailed() {
    if (!job) return;
    setJobBusy(true);
    setError('');
    try {
      const res = await retryOpsMigrationJob(job.id);
      setJob(res.job);
      setMessage('Retry job started for failed export/import steps.');
    } catch (err) {
      setError(errorText(err, 'Could not retry failed items.'));
    } finally {
      setJobBusy(false);
    }
  }

  function startNewMigration() {
    setSelectedDocumentIds([]);
    setPlan(null);
    setPlanRows([]);
    setJob(null);
    setStep(0);
    setMessage('Ready for a new dashboard migration.');
  }

  function canOpenStep(index: number) {
    if (index === 0) return true;
    if (index === 1) return documents.length > 0;
    if (index === 2) return selectedDocumentIds.length > 0;
    if (index === 3) return planRows.length > 0;
    if (index === 4) return Boolean(job);
    return false;
  }

  function targetConnectionOptions(row: DashboardMigrationTargetDraft) {
    return (targetCatalogs[row.destinationInstanceId]?.connections || []).map((connection) => ({
      value: connection.id,
      label: connectionLabel(connection),
      subtitle: connectionSubtitle(connection),
    }));
  }

  function targetModelOptions(row: DashboardMigrationTargetDraft) {
    const catalog = row.destinationInstanceId && row.targetConnectionId
      ? targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)]
      : null;
    return (catalog?.models || []).map((model) => ({
      value: model.id,
      label: modelDisplayLabel(model),
      subtitle: model.kind || model.connectionName || undefined,
    }));
  }

  function targetFolderOptions(row: DashboardMigrationTargetDraft) {
    const options = [
      { value: '', label: 'My Documents/default' },
      ...buildTargetFolderOptions(targetCatalogs[row.destinationInstanceId]?.folders || []),
    ];
    const currentValue = row.targetFolderPath || row.targetFolderId;
    if (currentValue && !options.some((option) => option.value === currentValue)) {
      options.push({ value: currentValue, label: currentValue });
    }
    return options;
  }

  function targetTopicOptions(row: DashboardMigrationTargetDraft) {
    const catalog = row.destinationInstanceId && row.targetModelId
      ? targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
    return (catalog?.topics || []).map((topic) => ({
      value: topic.name,
      label: topic.label && topic.label !== topic.name ? `${topic.label} (${topic.name})` : topic.name,
      subtitle: topic.fileName || topic.description,
    }));
  }

  function targetTopicCatalog(row: DashboardMigrationTargetDraft) {
    return row.destinationInstanceId && row.targetModelId
      ? targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
  }

  function targetTopicNameExists(row: DashboardMigrationTargetDraft, value: string) {
    const cleanValue = cleanDashboardModelMetadata(value)?.toLowerCase();
    if (!cleanValue) return false;
    return (targetTopicCatalog(row)?.topics || []).some((topic) => (
      [topic.name, topic.label]
        .map((candidate) => cleanDashboardModelMetadata(candidate)?.toLowerCase())
        .includes(cleanValue)
    ));
  }

  function generatedTopicName(row: DashboardMigrationTargetDraft, mapping: DashboardMigrationTopicMappingDraft) {
    const base = cleanDashboardModelMetadata(mapping.sourceTopicId)
      || cleanDashboardModelMetadata(mapping.sourceTopicName)
      || 'created_topic';
    if (!targetTopicNameExists(row, base)) return base;
    for (let index = 1; index < 100; index += 1) {
      const candidate = index === 1 ? `${base}_copy` : `${base}_copy_${index}`;
      if (!targetTopicNameExists(row, candidate)) return candidate;
    }
    return `${base}_copy_${Date.now()}`;
  }

  function createdTopicMapping(
    row: DashboardMigrationTargetDraft,
    mapping: DashboardMigrationTopicMappingDraft,
    targetTopicName: string,
  ): DashboardMigrationTopicMappingDraft {
    const cleanName = targetTopicName.trim();
    const exists = Boolean(cleanName && targetTopicNameExists(row, cleanName));
    return {
      ...mapping,
      action: 'copy_source',
      targetTopicName: cleanName,
      targetTopicLabel: undefined,
      status: !cleanName || exists ? 'blocked' : 'ready',
      warnings: !cleanName
        ? ['Enter a target topic name to create.']
        : exists
          ? [`Target topic ${cleanName} already exists. Use the existing topic or enter a new topic name.`]
          : undefined,
    };
  }

  function topicMappingIsExactMatch(mapping: DashboardMigrationTopicMappingDraft) {
    if (mapping.action !== 'map_existing' || !mapping.targetTopicName) return false;
    const sourceKeys = [mapping.sourceTopicName, mapping.sourceTopicId]
      .map((value) => cleanDashboardModelMetadata(value)?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const targetKeys = [mapping.targetTopicName, mapping.targetTopicLabel]
      .map((value) => cleanDashboardModelMetadata(value)?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    return sourceKeys.some((sourceKey) => targetKeys.includes(sourceKey));
  }

  function topicMappingStatus(mapping: DashboardMigrationTopicMappingDraft) {
    if (mapping.status === 'blocked' || !mapping.targetTopicName) {
      return {
        label: 'Needs choice',
        className: 'bg-red-50 text-red-700',
      };
    }
    if (mapping.action === 'copy_source') {
      return {
        label: 'Will create before import',
        className: 'bg-blue-50 text-blue-700',
      };
    }
    if (topicMappingIsExactMatch(mapping)) {
      return {
        label: 'Already matched',
        className: 'bg-green-50 text-green-700',
      };
    }
    return {
      label: 'Will use existing',
      className: 'bg-green-50 text-green-700',
    };
  }

  function targetInstanceLabel(instanceId: string) {
    return instances.find((instance) => instance.id === instanceId)?.label || instanceId || 'Not selected';
  }

  function targetConnectionLabel(instanceId: string, connectionId?: string) {
    if (!connectionId) return 'Not selected';
    const connection = targetCatalogs[instanceId]?.connections.find((item) => item.id === connectionId);
    return connection ? connectionLabel(connection) : connectionId;
  }

  if (loading) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary">
        <Loader2 size={18} className="animate-spin" />
        Preparing dashboard migration workspace...
      </div>
    );
  }

  if (!vaultStatus?.unlocked) {
    return (
      <div className="card p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck size={22} className="mt-0.5 text-omni-600" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-content-primary">Unlock native vault</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Dashboard Migrator uses saved source and target profiles from the native encrypted vault.
            </p>
            {error && <div role="alert" className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            {creatingVault && (
              <div className="mt-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                This passphrase cannot be recovered. Store it in your password manager before saving credentials.
              </div>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="grid gap-3">
                <PassphraseInput
                  value={passphrase}
                  onChange={setPassphrase}
                  placeholder={vaultStatus?.exists ? 'Enter vault passphrase' : 'Create vault passphrase'}
                  autoComplete={creatingVault ? 'new-password' : 'current-password'}
                  onSubmit={() => {
                    if (canUnlockVault) void unlockVault();
                  }}
                />
                {creatingVault && (
                  <PassphraseInput
                    value={passphraseConfirm}
                    onChange={setPassphraseConfirm}
                    placeholder="Confirm vault passphrase"
                    autoComplete="new-password"
                    onSubmit={() => {
                      if (canUnlockVault) void unlockVault();
                    }}
                  />
                )}
                {creatingVault && passphraseConfirm && !passphraseMatches && (
                  <div className="text-xs font-medium text-red-700">Passphrases do not match.</div>
                )}
                {creatingVault && passphrase && !passphraseMeetsMinimum && (
                  <div className="text-xs font-medium text-amber-700">Use at least 8 characters.</div>
                )}
              </div>
              <button type="button" onClick={unlockVault} disabled={!canUnlockVault} className="btn-primary inline-flex items-center justify-center gap-2">
                {unlocking ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                {vaultStatus?.exists ? 'Unlock vault' : 'Create vault'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div aria-live="polite" className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

      <div className="card p-3">
        <div className="grid gap-2 md:grid-cols-5">
          {STEP_LABELS.map((label, index) => {
            const enabled = index === step || canOpenStep(index);
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (enabled) setStep(index as WizardStep);
                }}
                disabled={!enabled}
                className={`rounded-button px-3 py-2 text-left text-sm transition ${step === index ? 'bg-omni-600 text-white' : enabled ? 'bg-surface-secondary text-content-secondary hover:bg-omni-50' : 'bg-surface-secondary text-content-tertiary opacity-60'}`}
              >
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">Step {index + 1}</div>
                <div className="font-semibold">{label}</div>
              </button>
            );
          })}
        </div>
      </div>

      {step === 0 && (
        <section className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="card p-5">
            <h2 className="text-base font-semibold text-content-primary">1. Source instance and connection</h2>
            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source instance</label>
                <ComboBox
                  options={sourceInstanceOptions}
                  value={sourceId}
                  onChange={chooseSource}
                  placeholder="Select source instance"
                  allowFreeText={false}
                  emptyLabel="No source instances found. Add or unlock saved instances before starting."
                  ariaLabel="Source instance"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source connection</label>
                <ComboBox
                  options={sourceConnectionOptions}
                  value={sourceConnectionId}
                  onChange={(value) => {
                    setSourceConnectionId(value);
                    resetDashboardSelection();
                    resetPlan();
                  }}
                  disabled={!sourceId || loadingSourceCatalog}
                  placeholder={loadingSourceCatalog ? 'Loading source connections...' : 'Select source connection'}
                  allowFreeText={false}
                  emptyLabel="No source connections found for this instance"
                  ariaLabel="Source connection"
                />
              </div>
              <button
                type="button"
                onClick={() => void loadDashboards()}
                disabled={!canLoadDashboards}
                title={dashboardLoadBlockReason || undefined}
                className="btn-primary inline-flex w-full items-center justify-center gap-2"
              >
                {loadingDocuments ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
                Load dashboards
              </button>
            </div>
          </div>
          <div className="card p-5">
            <h3 className="text-base font-semibold text-content-primary">Source summary</h3>
            <div className="mt-4 grid gap-3 text-sm">
              <div className="rounded-card bg-surface-secondary p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Instance</div>
                <div className="mt-1 text-content-primary">{sourceInstance?.label || 'Not selected'}</div>
              </div>
              <div className="rounded-card bg-surface-secondary p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Connection</div>
                <div className="mt-1 text-content-primary">{sourceConnections.find((connection) => connection.id === sourceConnectionId)?.name || 'Not selected'}</div>
              </div>
              <div className="rounded-card bg-surface-secondary p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Dashboard scope</div>
                <div className="mt-1 text-content-primary">{sourceConnectionId ? 'All folders in selected connection' : 'Choose a connection'}</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="card p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-base font-semibold text-content-primary">2. Select dashboards</h2>
              <p className="mt-1 text-sm text-content-secondary">{selectedDocumentIds.length} selected from {filteredDocuments.length} visible dashboards</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={selectAllVisibleDocuments} disabled={filteredDocuments.length === 0} className="btn-secondary text-xs">Select visible</button>
              <button type="button" onClick={() => { setSelectedDocumentIds([]); resetPlan(); }} disabled={selectedDocumentIds.length === 0} className="btn-secondary text-xs">Clear</button>
            </div>
          </div>
          <div className="mt-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search dashboard names, model IDs, labels, or folders" />
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <ComboBox
              options={dashboardFolderOptions}
              value={dashboardFolderFilter}
              onChange={setDashboardFolderFilter}
              placeholder="All folders"
              allowFreeText={false}
              emptyLabel="No folder filters found"
              ariaLabel="Filter dashboards by folder"
            />
            <ComboBox
              options={dashboardModelOptions}
              value={dashboardModelFilter}
              onChange={setDashboardModelFilter}
              placeholder="All models"
              allowFreeText={false}
              emptyLabel="No model filters found"
              ariaLabel="Filter dashboards by model"
            />
            <ComboBox
              options={dashboardTopicOptions}
              value={dashboardTopicFilter}
              onChange={setDashboardTopicFilter}
              placeholder="All topics"
              allowFreeText={false}
              emptyLabel="No topic filters found"
              ariaLabel="Filter dashboards by topic"
            />
            <ComboBox
              options={dashboardLabelOptions}
              value={dashboardLabelFilter}
              onChange={setDashboardLabelFilter}
              placeholder="All labels"
              allowFreeText={false}
              emptyLabel="No label filters found"
              ariaLabel="Filter dashboards by label"
            />
          </div>
          <div className="mt-4 max-h-[520px] overflow-auto rounded-card border border-border-subtle">
            {filteredDocuments.map((document) => {
              const selected = selectedDocumentIds.includes(document.identifier);
              const model = dashboardDocumentModelLabel(document, sourceModelNameById);
              return (
                <label key={document.identifier} className={`grid gap-3 border-b border-border-subtle px-3 py-3 text-sm last:border-b-0 hover:bg-surface-secondary md:grid-cols-[auto_minmax(0,1fr)_minmax(220px,0.75fr)_minmax(220px,0.75fr)_0.5fr] ${selected ? 'bg-omni-50/50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleDocument(document.identifier)}
                    aria-label={dashboardSelectionAriaLabel(document)}
                    className="mt-1 accent-omni-600"
                  />
                  <span>
                    <span className="block font-semibold text-content-primary">{document.name}</span>
                    <span className="block font-mono text-xs text-content-secondary">{document.identifier}</span>
                    <span className="mt-1 block text-xs text-content-secondary">{document.folderPath || 'My Documents/default'}</span>
                  </span>
                  <span className="text-xs text-content-secondary" title={model.detected ? undefined : 'No model metadata was available from the dashboard export.'}>
                    <span className="block font-semibold text-content-primary">Model: {model.label}</span>
                    <span className="block font-mono">ID: {document.baseModelId || 'not detected'}</span>
                  </span>
                  <span className="text-xs text-content-secondary">
                    <span className="block font-semibold text-content-primary">Topic: {metadataList(document.topicNames)}</span>
                    <span className="block font-mono">ID: {metadataList(document.topicIds)}</span>
                  </span>
                  <span className="text-xs text-content-secondary">Updated<br />{formatDate(document.updatedAt)}</span>
                </label>
              );
            })}
            {filteredDocuments.length === 0 && (
              <div className="p-6 text-sm text-content-secondary">{dashboardEmptyState}</div>
            )}
          </div>
          <div className="mt-5 flex justify-between gap-3">
            <button type="button" onClick={() => setStep(0)} className="btn-secondary">Back</button>
            <button type="button" onClick={() => setStep(2)} disabled={selectedDocumentIds.length === 0} className="btn-primary">Continue to destinations</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-5">
          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">3. Choose destinations</h2>
                <p className="mt-1 text-sm text-content-secondary">
                  By default, all selected dashboards go to every destination you add below.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-card bg-surface-secondary p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Dashboards selected</div>
                <div className="mt-1 text-content-primary">{selectedDocumentIds.length}</div>
              </div>
              <div className="rounded-card bg-surface-secondary p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Destinations</div>
                <div className="mt-1 text-content-primary">{targetRows.length}</div>
              </div>
              <div className="rounded-card bg-surface-secondary p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Dashboard grouping</div>
                <div className="mt-1 text-content-primary">{hasAdvancedDashboardGroups ? `${routeGroups.length} groups` : 'Simple path'}</div>
              </div>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">Destinations</h2>
                <p className="mt-1 text-sm text-content-secondary">{targetRows.length} destination{targetRows.length === 1 ? '' : 's'} configured</p>
              </div>
              <button type="button" onClick={addTargetRow} className="btn-secondary inline-flex items-center gap-2">
                <Plus size={15} />
                Add blank destination
              </button>
            </div>

            <div className="mt-5 rounded-card border border-border-subtle bg-surface-secondary/40 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-sm font-semibold text-content-primary">Add destination instances</div>
                  <div className="mt-1 text-xs text-content-secondary">{targetInstanceSelectionIds.length} selected</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={addSelectedTargetInstances}
                    disabled={targetInstanceSelectionIds.length === 0}
                    className="btn-primary inline-flex items-center gap-2 text-xs"
                  >
                    <Plus size={14} />
                    Add selected as destinations
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetInstanceSelectionIds([])}
                    disabled={targetInstanceSelectionIds.length === 0}
                    className="btn-secondary text-xs"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {targetInstances.map((instance) => {
                  const selected = targetInstanceSelectionIds.includes(instance.id);
                  const existingRows = targetRows.filter((row) => row.destinationInstanceId === instance.id).length;
                  return (
                    <label key={instance.id} className={`flex items-start gap-3 rounded-card border px-3 py-2 text-xs ${selected ? 'border-omni-300 bg-omni-50 text-omni-800' : 'border-border-subtle bg-white text-content-secondary'}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleTargetInstanceSelection(instance.id)}
                        aria-label={destinationInstanceSelectionAriaLabel(instance, existingRows)}
                        className="mt-1 accent-omni-600"
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-content-primary">{instance.label}</span>
                        <span className="block truncate">{instance.baseUrl.replace(/^https?:\/\//, '')}</span>
                        <span className="mt-1 block">{existingRows} destination{existingRows === 1 ? '' : 's'}</span>
                      </span>
                    </label>
                  );
                })}
                {targetInstances.length === 0 && (
                  <div className="rounded-card border border-dashed border-border-subtle p-3 text-xs text-content-secondary">
                    {dashboardDestinationsEmptyState(0)}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 space-y-4">
              {activeTargetRowsWithTopicMappings.map((row, index) => {
                const targetCatalog = targetCatalogs[row.destinationInstanceId];
                const modelCatalog = row.destinationInstanceId && row.targetConnectionId
                  ? targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)]
                  : null;
                const topicCatalog = targetTopicCatalog(row);
                return (
                  <div key={row.id} className="rounded-card border border-border-subtle p-4">
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">Destination {index + 1}</div>
                        <div className="mt-0.5 text-xs text-content-secondary">
                          {targetInstanceLabel(row.destinationInstanceId)} · {targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId)}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {advancedGroupingOpen && (
                          <label className={`inline-flex items-center gap-1 rounded-chip px-2 py-1 text-xs font-semibold ${activeRouteGroup.targetRowIds.includes(row.id) ? 'bg-green-50 text-green-700' : 'bg-surface-secondary text-content-secondary'}`}>
                            <input
                              type="checkbox"
                              checked={activeRouteGroup.targetRowIds.includes(row.id)}
                              disabled={activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID}
                              onChange={(event) => setActiveRouteTargetMembership(row.id, event.target.checked)}
                              aria-label={`Assign destination ${index + 1} to dashboard group ${activeRouteGroup.name}`}
                              className="accent-omni-600"
                            />
                            Selected group
                          </label>
                        )}
                        <button type="button" onClick={() => removeTargetRow(row.id)} className="btn-secondary inline-flex items-center gap-1 text-xs text-red-700">
                          <Trash2 size={13} />
                          Remove
                        </button>
                        <button type="button" onClick={() => void duplicateTargetRow(row)} className="btn-secondary inline-flex items-center gap-1 text-xs">
                          <Plus size={13} />
                          Duplicate
                        </button>
                      </div>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-4">
                      <div>
                        <label className="mb-1.5 block text-sm font-semibold text-content-primary">Destination instance</label>
                        <ComboBox
                          options={targetInstanceOptions}
                          value={row.destinationInstanceId}
                          onChange={(value) => void chooseTargetInstance(row.id, value)}
                          placeholder="Select destination instance"
                          allowFreeText={false}
                          emptyLabel="No destination instances found"
                          ariaLabel={`Destination ${index + 1} instance`}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-semibold text-content-primary">Destination connection</label>
                        <ComboBox
                          options={targetConnectionOptions(row)}
                          value={row.targetConnectionId}
                          onChange={(value) => void chooseTargetConnection(row.id, row.destinationInstanceId, value)}
                          disabled={!row.destinationInstanceId || targetCatalog?.loading}
                          placeholder={targetCatalog?.loading ? 'Loading destination connections...' : 'Select destination connection'}
                          allowFreeText={false}
                          emptyLabel={targetCatalog?.error || 'No destination connections found'}
                          ariaLabel={`Destination ${index + 1} connection`}
                        />
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-sm font-semibold text-content-primary"><Database size={14} /> Destination model</label>
                        <ComboBox
                          options={targetModelOptions(row)}
                          value={row.targetModelId}
                          onChange={(value) => chooseTargetModel(row, value)}
                          disabled={!row.targetConnectionId || modelCatalog?.loading}
                          placeholder={modelCatalog?.loading ? 'Loading destination models...' : 'Select destination model'}
                          emptyLabel={modelCatalog?.error || TARGET_MODEL_COMBOBOX_CONFIG.emptyLabel}
                          allowFreeText={TARGET_MODEL_COMBOBOX_CONFIG.allowFreeText}
                          ariaLabel={`Destination ${index + 1} model`}
                        />
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-sm font-semibold text-content-primary"><FolderInput size={14} /> Destination folder</label>
                        <ComboBox
                          options={targetFolderOptions(row)}
                          value={row.targetFolderPath || row.targetFolderId}
                          disabled={!row.destinationInstanceId || targetCatalog?.loading}
                          onChange={(value) => chooseTargetFolder(row, value)}
                          placeholder={targetCatalog?.loading ? 'Loading destination folders...' : 'My Documents/default'}
                          emptyLabel={TARGET_FOLDER_COMBOBOX_CONFIG.emptyLabel}
                          allowFreeText={TARGET_FOLDER_COMBOBOX_CONFIG.allowFreeText}
                          ariaLabel={`Destination ${index + 1} folder`}
                        />
                      </div>
                    </div>
                    {activeRouteGroup.targetRowIds.includes(row.id) && activeRouteSourceTopics.length > 0 && row.targetModelId && (
                      <div className="mt-4 rounded-card border border-border-subtle bg-surface-secondary/50 p-4">
                        <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                          <div>
                            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                              <BookOpen size={14} />
                              Topic mappings
                            </div>
                            <div className="mt-1 text-xs text-content-secondary">
                              {activeRouteSourceTopics.length} source topic{activeRouteSourceTopics.length === 1 ? '' : 's'} detected in {activeRouteGroup.name}.
                            </div>
                          </div>
                          {topicCatalog?.loading && (
                            <div className="inline-flex items-center gap-1 text-xs text-content-secondary">
                              <Loader2 size={13} className="animate-spin" />
                              Checking destination topics
                            </div>
                          )}
                        </div>
                        <div className="mt-3 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                          Some dashboards are built on topics. Keep the matching destination topic when OmniKit finds one, or create a new topic before the dashboard is copied.
                        </div>
                        {topicCatalog?.error && (
                          <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            {topicCatalog.error}
                          </div>
                        )}
                        <div className="mt-3 space-y-3">
                          {(row.topicMappings || []).map((mapping) => (
                            <div key={`${mapping.sourceTopicId || mapping.sourceTopicName}`} className="grid gap-3 rounded-card border border-border-subtle bg-white p-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,0.8fr)_minmax(0,1.1fr)]">
                              <div className="min-w-0">
                                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Source topic</div>
                                <div className="mt-1 truncate text-sm font-semibold text-content-primary">{mapping.sourceTopicName}</div>
                                <div className="truncate font-mono text-xs text-content-secondary">{mapping.sourceTopicId || mapping.sourceTopicName}</div>
                                <span className={`mt-2 inline-flex rounded-chip px-2 py-0.5 text-[11px] font-semibold ${topicMappingStatus(mapping).className}`}>
                                  {topicMappingStatus(mapping).label}
                                </span>
                              </div>
                              <div>
                                <div className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Action</div>
                                <div className="inline-flex rounded-card border border-border-subtle bg-surface-primary p-1 text-xs">
                                  <button
                                    type="button"
                                    onClick={() => updateTopicMapping(row, {
                                      ...mapping,
                                      action: 'map_existing',
                                      targetTopicName: '',
                                      targetTopicLabel: undefined,
                                      status: 'blocked',
                                      warnings: ['Choose an existing target topic.'],
                                    })}
                                    disabled={!topicCatalog?.loaded || targetTopicOptions(row).length === 0}
                                    className={`rounded-card px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${mapping.action === 'map_existing' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
                                  >
                                    Use existing
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => updateTopicMapping(row, createdTopicMapping(row, mapping, generatedTopicName(row, mapping)))}
                                    className={`rounded-card px-3 py-1 font-semibold ${mapping.action === 'copy_source' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
                                  >
                                    Create new
                                  </button>
                                </div>
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
                                  {mapping.action === 'copy_source' ? 'New topic name' : 'Target topic'}
                                </label>
                                {mapping.action === 'copy_source' ? (
                                  <>
                                    <input
                                      type="text"
                                      value={mapping.targetTopicName}
                                      onChange={(event) => updateTopicMapping(row, createdTopicMapping(row, mapping, event.target.value))}
                                      className="input-field text-sm"
                                      placeholder={mapping.sourceTopicId || mapping.sourceTopicName}
                                      aria-label={`New topic name for ${mapping.sourceTopicName}`}
                                    />
                                    <div className="mt-1 text-xs text-content-secondary">
                                      OmniKit will create this topic in the destination model before dashboard import.
                                    </div>
                                  </>
                                ) : (
                                  <ComboBox
                                    options={targetTopicOptions(row)}
                                    value={mapping.targetTopicName}
                                    onChange={(value) => {
                                      const topic = topicCatalog?.topics.find((item) => item.name === value);
                                      updateTopicMapping(row, {
                                        ...mapping,
                                        action: 'map_existing',
                                        targetTopicName: value,
                                        targetTopicLabel: topic?.label,
                                        status: value ? 'ready' : 'blocked',
                                        warnings: value ? undefined : ['Choose an existing target topic.'],
                                      });
                                    }}
                                    disabled={!topicCatalog?.loaded || topicCatalog.loading}
                                    placeholder={topicCatalog?.loading ? 'Checking destination topics...' : 'Select existing topic'}
                                    allowFreeText={false}
                                    emptyLabel={topicCatalog?.loaded ? 'No destination topics found for this model' : 'Choose a destination model first'}
                                    ariaLabel={`Destination ${index + 1} topic for ${mapping.sourceTopicName}`}
                                  />
                                )}
                              </div>
                              <div className="lg:col-span-3">
                                {mapping.action === 'map_existing' && mapping.targetTopicName && topicMappingIsExactMatch(mapping) && (
                                  <div className="text-xs text-green-700">
                                    Already matched to destination topic {mapping.targetTopicLabel || mapping.targetTopicName}. No action is needed unless you want a different topic.
                                  </div>
                                )}
                                {mapping.action === 'map_existing' && mapping.targetTopicName && !topicMappingIsExactMatch(mapping) && (
                                  <div className="text-xs text-green-700">Will use existing destination topic {mapping.targetTopicLabel || mapping.targetTopicName} for this dashboard.</div>
                                )}
                                {mapping.action === 'copy_source' && mapping.status !== 'blocked' && (
                                  <div className="text-xs text-green-700">Will create destination topic {mapping.targetTopicName} before dashboard import, then point the dashboard to it.</div>
                                )}
                                {mapping.action === 'unresolved' && (
                                  <div className="text-xs text-red-700">Choose an existing destination topic or create a new one before review.</div>
                                )}
                                {mapping.warnings?.map((warning) => (
                                  <div key={warning} className="mt-1 text-xs text-red-700">{warning}</div>
                                ))}
                              </div>
                            </div>
                          ))}
                          {topicCatalog?.loaded && (row.topicMappings || []).length === 0 && (
                            <div className="rounded-card border border-dashed border-border-subtle p-3 text-xs text-content-secondary">
                              No topic mappings are needed for the selected dashboards. Continue to readiness when the destination is configured.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {targetRows.length === 0 && (
                <div className="rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
                  {dashboardDestinationsEmptyState(targetInstances.length)}
                </div>
              )}
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">Advanced dashboard grouping</h2>
                <p className="mt-1 text-sm text-content-secondary">
                  Use this only when selected dashboards need to go to different destinations.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdvancedGroupingOpen((current) => !current)}
                aria-expanded={advancedGroupingOpen}
                className="btn-secondary inline-flex items-center justify-center gap-2 text-xs"
              >
                {advancedGroupingOpen ? 'Hide grouping controls' : 'Show grouping controls'}
              </button>
            </div>
            <div className="mt-4 rounded-card border border-border-subtle bg-surface-secondary/50 px-3 py-2 text-xs text-content-secondary">
              {hasAdvancedDashboardGroups
                ? `${routeGroups.length} dashboard groups are configured. Review assignments before checking readiness.`
                : 'Simple path is active: all selected dashboards will go to every destination above.'}
            </div>
            {advancedGroupingOpen && (
              <div className="mt-5 space-y-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-content-primary">Dashboard groups</div>
                    <div className="mt-1 text-xs text-content-secondary">
                      {routeGroups.length} group{routeGroups.length === 1 ? '' : 's'} assigning {selectedDocumentIds.length} dashboard{selectedDocumentIds.length === 1 ? '' : 's'}.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={autoGroupBySourceScope} disabled={selectedDocumentIds.length === 0 || targetRows.length === 0} className="btn-secondary text-xs">
                      Auto-group by model/topic
                    </button>
                    <button type="button" onClick={duplicateActiveRouteGroup} disabled={activeRouteGroup.documentIds.length === 0} className="btn-secondary text-xs">
                      Duplicate dashboard group
                    </button>
                    <button type="button" onClick={removeActiveRouteGroup} disabled={activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID} className="btn-secondary text-xs text-red-700">
                      Remove dashboard group
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {routeGroups.map((group) => {
                    const mixedMessage = mixedRouteGroupSourceScopeMessage(group, documents);
                    const active = group.id === activeRouteGroup.id;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        onClick={() => setActiveRouteGroupId(group.id)}
                        className={`rounded-card border px-3 py-2 text-left text-xs ${active ? 'border-omni-300 bg-omni-50 text-omni-800' : 'border-border-subtle bg-white text-content-secondary'}`}
                      >
                        <span className="block font-semibold">{group.name}</span>
                        <span className="block">{group.documentIds.length} dashboards · {group.targetRowIds.length} destinations</span>
                        {mixedMessage && <span className="mt-1 block text-red-700">Mixed model/topic</span>}
                      </button>
                    );
                  })}
                </div>
                {routeGroupBlockReason && (
                  <div className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
                    <AlertTriangle size={13} className="mr-1 inline-block" />
                    {routeGroupBlockReason}
                  </div>
                )}
                <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                  <div>
                    <div className="text-sm font-semibold text-content-primary">Dashboards in selected group</div>
                    <div className="mt-2 max-h-60 overflow-auto rounded-card border border-border-subtle">
                      {selectedDocuments.map((document) => {
                        const checked = routeSelectionIds.includes(document.identifier);
                        const included = activeRouteGroup.documentIds.includes(document.identifier);
                        return (
                          <label key={document.identifier} className={`flex gap-3 border-b border-border-subtle px-3 py-2 text-xs last:border-b-0 ${included ? 'bg-omni-50/40' : 'bg-white'}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRouteSelection(document.identifier)}
                              aria-label={dashboardGroupSelectionAriaLabel(document, activeRouteGroup.name)}
                              className="mt-1 accent-omni-600"
                            />
                            <span className="min-w-0">
                              <span className="block font-semibold text-content-primary">{document.name}</span>
                              <span className="block truncate text-content-secondary">{dashboardSourceScopeLabel(document)}</span>
                              <span className={included ? 'text-green-700' : 'text-content-secondary'}>{included ? 'Included in selected group' : 'Not in selected group'}</span>
                            </span>
                          </label>
                        );
                      })}
                      {selectedDocuments.length === 0 && (
                        <div className="p-4 text-xs text-content-secondary">Select dashboards in Step 2 before configuring dashboard groups.</div>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-content-primary">Dashboard group actions</div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <button type="button" onClick={createRouteGroupFromSelection} disabled={routeSelectionIds.length === 0} className="btn-secondary text-xs">
                        Create group from selected
                      </button>
                      <button type="button" onClick={moveSelectionToActiveRouteGroup} disabled={routeSelectionIds.length === 0 || activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID} className="btn-secondary text-xs">
                        Move selected to this group
                      </button>
                    </div>
                    <div className="mt-3 rounded-card bg-surface-secondary p-3 text-xs text-content-secondary">
                      Selected dashboard group: <span className="font-semibold text-content-primary">{activeRouteGroup.name}</span><br />
                      {activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID
                        ? 'By default, all selected dashboards go to every destination.'
                        : 'Use destination assignments below to send this dashboard group to specific destinations.'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-5 lg:grid-cols-[1fr_0.82fr]">
            <div className="card p-5">
              <h3 className="text-base font-semibold text-content-primary">Migration options</h3>
              <div className="mt-4 space-y-5">
                <section>
                  <div className="flex items-start gap-2">
                    <ShieldCheck size={15} className="mt-0.5 text-green-700" />
                    <div>
                      <div className="text-sm font-semibold text-content-primary">Recommended rerun behavior</div>
                      <p className="mt-1 text-xs text-content-secondary">
                        Keep this on when you want reruns to update the chosen destination folder cleanly.
                      </p>
                    </div>
                  </div>
                  <label className="mt-3 flex items-start gap-2 rounded-card border border-border-subtle bg-surface-secondary/40 p-4">
                    <input
                      type="checkbox"
                      checked={replaceSameNamed}
                      onChange={(event) => {
                        setReplaceSameNamed(event.target.checked);
                        resetPlan();
                      }}
                      disabled={emptyFirst}
                      aria-label="Replace same-named target dashboards"
                      className="mt-1 accent-omni-600"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-content-primary">Replace same-named target dashboards</span>
                      <span className="mt-1 block text-xs text-content-secondary">
                        Looks only in each selected destination folder and moves same-name dashboards there to Trash before import. If target-folder scope is unsafe, OmniKit skips the cleanup and explains why in Review.
                      </span>
                      {emptyFirst && (
                        <span className="mt-1 block text-xs text-content-secondary">
                          Disabled while empty-folder cleanup is selected.
                        </span>
                      )}
                    </span>
                  </label>
                </section>

                <section className="border-t border-border-subtle pt-4">
                  <div className="flex items-start gap-2">
                    <RefreshCw size={15} className="mt-0.5 text-omni-700" />
                    <div>
                      <div className="text-sm font-semibold text-content-primary">After migration</div>
                      <p className="mt-1 text-xs text-content-secondary">
                        Optional follow-up action after imports complete.
                      </p>
                    </div>
                  </div>
                  <label className="mt-3 flex items-start gap-2 rounded-card border border-border-subtle p-4">
                    <input
                      type="checkbox"
                      checked={refreshSchemaOnComplete}
                      onChange={(event) => {
                        setRefreshSchemaOnComplete(event.target.checked);
                        resetPlan();
                      }}
                      aria-label="Refresh target schema after import"
                      className="mt-1 accent-omni-600"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-content-primary">Refresh target schema after import</span>
                      <span className="mt-1 block text-xs text-content-secondary">Queues Omni schema refresh for every configured destination after dashboard import completes.</span>
                    </span>
                  </label>
                </section>

                <section className="border-t border-red-200 pt-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={15} className="mt-0.5 text-red-700" />
                    <div>
                      <div className="text-sm font-semibold text-red-800">Destructive cleanup</div>
                      <p className="mt-1 text-xs text-red-700">
                        These actions move dashboards to Trash. Leave them off unless you intentionally want cleanup after the readiness check confirms the scope.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    <label className="flex items-start gap-2 rounded-card border border-yellow-200 bg-yellow-50/50 p-4">
                      <input
                        type="checkbox"
                        checked={emptyFirst}
                        onChange={(event) => {
                          setEmptyFirst(event.target.checked);
                          resetPlan();
                        }}
                        aria-label="Empty target folder before import"
                        className="mt-1 accent-yellow-600"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-yellow-900">Empty target folder before import</span>
                        <span className="mt-1 block text-xs text-yellow-800">Advanced cleanup. Moves every existing dashboard in each selected destination folder to Trash before import.</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 rounded-card border border-red-200 bg-red-50/40 p-4">
                      <input
                        type="checkbox"
                        checked={deleteSourceOnSuccess}
                        onChange={(event) => {
                          setDeleteSourceOnSuccess(event.target.checked);
                          resetPlan();
                        }}
                        aria-label="Delete source dashboard after verified success"
                        className="mt-1 accent-red-600"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-red-800">Delete source dashboard after verified success</span>
                        <span className="mt-1 block text-xs text-red-700">Moves the original selected source dashboards to Trash only after every destination import succeeds and selected post-actions do not fail.</span>
                      </span>
                    </label>
                  </div>
                </section>
              </div>
            </div>
            <div className="card p-5">
              <h3 className="text-base font-semibold text-content-primary">Readiness check</h3>
              <div className="mt-4 grid gap-3 text-sm">
                <div className="rounded-card bg-surface-secondary p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Dashboards</div>
                  <div className="mt-1 text-content-primary">{selectedDocumentIds.length}</div>
                </div>
                <div className="rounded-card bg-surface-secondary p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Dashboard groups</div>
                  <div className="mt-1 text-content-primary">{compiledRouteGroups.length}</div>
                </div>
                <div className="rounded-card bg-surface-secondary p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Destination assignments</div>
                  <div className="mt-1 text-content-primary">{migrationTargets.length}</div>
                </div>
                <div className="rounded-card bg-surface-secondary p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Topics</div>
                  <div className="mt-1 text-content-primary">{sourceTopics.length || 'None'}</div>
                </div>
              </div>
              <div className="mt-5 flex justify-between gap-3">
                <button type="button" onClick={() => setStep(1)} className="btn-secondary">Back</button>
                <div className="flex flex-col items-end gap-2">
                  <button type="button" onClick={runPreflight} disabled={!canPreflight} className="btn-primary inline-flex items-center gap-2">
                    {preflightLoading ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                    Check readiness
                  </button>
                  {preflightBlockReason && !preflightLoading && <p className="max-w-sm text-right text-xs text-content-secondary">{preflightBlockReason}</p>}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="grid gap-5 lg:grid-cols-[1fr_0.62fr]">
          <div className="card p-5">
            <h2 className="text-base font-semibold text-content-primary">4. Review</h2>
            <div className="mt-4 rounded-card border border-border-subtle bg-surface-secondary/40 p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-content-primary">Migration impact</h3>
                  <p className="mt-1 text-xs text-content-secondary">
                    Read this first, then use the detailed route cards below if you need to inspect a specific destination.
                  </p>
                </div>
                <StatusChip
                  status={reviewImpactSummary.blockerGroups.length > 0 ? 'failed' : reviewImpactSummary.warningGroups.length > 0 ? 'warning' : 'success'}
                  label={reviewImpactSummary.blockerGroups.length > 0
                    ? `${reviewImpactSummary.blockerGroups.length} blocker${reviewImpactSummary.blockerGroups.length === 1 ? '' : 's'}`
                    : reviewImpactSummary.warningGroups.length > 0
                      ? `${reviewImpactSummary.warningGroups.length} warning${reviewImpactSummary.warningGroups.length === 1 ? '' : 's'}`
                      : 'Ready'}
                />
              </div>
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-6">
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.dashboardCount}</span><br />Dashboards</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.destinationCount}</span><br />Destinations</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.replacementCount}</span><br />Replacements</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{refreshSchemaOnComplete ? 'On' : 'Off'}</span><br />Schema refresh</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{deleteSourceOnSuccess ? 'On' : 'Off'}</span><br />Source delete</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.topicActionCount || 'None'}</span><br />Topic actions</div>
              </div>
              <div className="mt-3 space-y-2 text-sm text-content-primary">
                {reviewImpactSummary.impactStatements.map((statement) => (
                  <div key={statement} className="flex gap-2">
                    <Info size={14} className="mt-0.5 shrink-0 text-content-secondary" />
                    <span>{statement}</span>
                  </div>
                ))}
              </div>
              {(reviewImpactSummary.blockerGroups.length > 0 || reviewImpactSummary.warningGroups.length > 0 || reviewImpactSummary.noticeGroups.length > 0) && (
                <div className="mt-4 space-y-2">
                  {reviewImpactSummary.blockerGroups.map((group) => (
                    <div key={`blocker:${group.message}`} className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                      <AlertTriangle size={13} className="mr-1 inline-block" />
                      {group.message}
                      {group.count > 1 && <span className="ml-1 font-semibold">({group.count} occurrences)</span>}
                    </div>
                  ))}
                  {reviewImpactSummary.warningGroups.map((group) => (
                    <div key={`warning:${group.message}`} className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                      <AlertTriangle size={13} className="mr-1 inline-block" />
                      {group.message}
                      {group.count > 1 && <span className="ml-1 font-semibold">({group.count} occurrences)</span>}
                    </div>
                  ))}
                  {reviewImpactSummary.noticeGroups.map((group) => (
                    <div key={`notice:${group.message}`} className="rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                      <Info size={13} className="mr-1 inline-block" />
                      {group.message}
                      {group.count > 1 && <span className="ml-1 font-semibold">({group.count} occurrences)</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 space-y-3">
              {routeReviewGroups.map((route) => {
                const sourceDeleteLabel = !deleteSourceOnSuccess
                  ? 'Off'
                  : route.status === 'blocked'
                    ? 'Blocked'
                    : 'Eligible';
                return (
                  <div key={route.id} className={`rounded-card border p-4 ${route.status === 'blocked' ? 'border-red-200 bg-red-50/40' : 'border-border-subtle'}`}>
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">{route.name}</div>
                        <div className="mt-1 text-xs text-content-secondary">
                          {route.dashboardCount} dashboard{route.dashboardCount === 1 ? '' : 's'} assigned to {route.targetCount} destination{route.targetCount === 1 ? '' : 's'}
                        </div>
                      </div>
                      <StatusChip
                        status={route.status === 'blocked' ? 'failed' : route.status}
                        label={route.status === 'blocked' ? 'Blocked' : route.status === 'ready' ? 'Ready' : `${route.warningCount} warnings`}
                      />
                    </div>
                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-8">
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.dashboardCount}</span><br />Dashboards</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.targetCount}</span><br />Destinations</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.replaceCount}</span><br />Replacements</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{refreshSchemaOnComplete ? 'Yes' : 'No'}</span><br />Schema refresh</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{sourceDeleteLabel}</span><br />Source delete</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.topicActionCount || 'None'}</span><br />Topic actions</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.warningCount}</span><br />Warnings</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.noticeCount}</span><br />Notices</div>
                    </div>
                    {deleteSourceOnSuccess && (
                      <div className={`mt-3 rounded-card border px-3 py-2 text-xs ${route.status === 'blocked' ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
                        <Info size={13} className="mr-1 inline-block" />
                        {route.status === 'blocked'
                          ? 'Source delete will not run while this route has blockers.'
                          : 'Source delete is eligible only after every route target succeeds or completes with warnings.'}
                      </div>
                    )}
                    {route.error && (
                      <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <AlertTriangle size={13} className="mr-1 inline-block" />
                        {route.error}
                      </div>
                    )}
                    <div className="mt-4 space-y-3">
                      {route.targets.map((routeTarget) => {
                        const target = routeTarget.target;
                        return (
                          <div key={`${route.id}:${target.id}`} className={`rounded-card border p-3 ${routeTarget.status === 'blocked' ? 'border-red-200 bg-white' : 'border-border-subtle bg-white'}`}>
                            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                              <div>
                                <div className="text-sm font-semibold text-content-primary">{sourceInstance?.label || sourceId} -&gt; {target.destinationLabel || target.destinationInstanceId}</div>
                                <div className="mt-1 text-xs text-content-secondary">
                                  Connection: {targetConnectionLabel(target.destinationInstanceId, target.targetConnectionId)} · Model: {target.targetModelName || target.targetModelId} · Folder: {target.targetFolderPath || 'Default'}
                                </div>
                              </div>
                              <StatusChip
                                status={routeTarget.status === 'blocked' ? 'failed' : routeTarget.status}
                                label={routeTarget.status === 'blocked' ? 'Blocked' : routeTarget.status === 'ready' ? 'Ready' : `${routeTarget.warningCount} warnings`}
                              />
                            </div>
                            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.dashboardCount}</span><br />Dashboards</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.deleteCount}</span><br />Trash moves</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.replaceCount}</span><br />Replacements</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.topicActionCount || 'None'}</span><br />Topic actions</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.warningCount}</span><br />Warnings</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.noticeCount}</span><br />Notices</div>
                            </div>
                            {routeTarget.topicActions.length > 0 && (
                              <div className="mt-3 space-y-2">
                                {routeTarget.topicActions.map((action) => (
                                  <div key={`${action.routeGroupId || route.id}:${action.documentId || 'document'}`} className="rounded-card border border-border-subtle bg-surface-secondary/50 px-3 py-2">
                                    <div className="flex flex-col gap-1 text-xs text-content-secondary sm:flex-row sm:items-center sm:justify-between">
                                      <span>
                                        <span className="font-semibold text-content-primary">{action.documentName || action.documentId || 'Dashboard'}</span>
                                      </span>
                                      <span className={action.blocked ? 'font-semibold text-red-700' : 'font-semibold text-green-700'}>
                                        {action.blocked ? 'Blocked' : 'Ready'}
                                      </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1">
                                      {action.topicMappings.map((mapping) => (
                                        <span key={`${mapping.sourceTopicId || mapping.sourceTopicName}:${mapping.action}:${mapping.targetTopicName}`} className="rounded-chip bg-white px-2 py-0.5 text-[11px] font-semibold text-content-secondary">
                                          {mapping.action === 'copy_source' ? 'Create' : 'Use'} {mapping.sourceTopicName} -&gt; {mapping.targetTopicLabel || mapping.targetTopicName}
                                        </span>
                                      ))}
                                    </div>
                                    {action.warnings.map((warning) => (
                                      <div key={warning} className="mt-1 text-xs text-yellow-800">{warning}</div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
                            {routeTarget.deleteCount > 0 && (
                              <div className="mt-3 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
                                <AlertTriangle size={13} className="mr-1 inline-block" />
                                {emptyFirst
                                  ? `${routeTarget.deleteCount} existing target dashboard${routeTarget.deleteCount === 1 ? '' : 's'} will be moved to Trash before import.`
                                  : `${routeTarget.replaceCount} same-named target dashboard${routeTarget.replaceCount === 1 ? '' : 's'} will be moved to Trash before import.`}
                              </div>
                            )}
                            {routeTarget.error && (
                              <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                                <AlertTriangle size={13} className="mr-1 inline-block" />
                                {routeTarget.error}
                              </div>
                            )}
                            {routeTarget.warnings.length > 0 && (
                              <div className="mt-3 space-y-1">
                                {routeTarget.warnings.map((warning) => (
                                  <div key={warning} className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{warning}</div>
                                ))}
                              </div>
                            )}
                            {routeTarget.notices.length > 0 && (
                              <div className="mt-3 space-y-1">
                                {routeTarget.notices.map((notice) => (
                                  <div key={notice} className="rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                                    <Info size={13} className="mr-1 inline-block" />
                                    {notice}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {routeReviewGroups.length === 0 && (
                <div className="rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
                  Run the readiness check from the Destinations step to build the migration plan.
                </div>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <div className="card p-5">
              <h3 className="text-base font-semibold text-content-primary">Selected dashboards</h3>
              <div className="mt-3 space-y-2">
                {selectedDocuments.map((document) => (
                  <div key={document.identifier} className="rounded-card bg-surface-secondary px-3 py-2 text-xs">
                    <div className="font-semibold text-content-primary">{document.name}</div>
                    <div className="font-mono text-content-secondary">{document.baseModelId || 'model not detected'}</div>
                    <div className="text-content-secondary">Topic: {metadataList(document.topicNames)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-5">
              <h3 className="text-base font-semibold text-content-primary">Run options</h3>
              <div className="mt-3 grid gap-2 text-xs">
                <div className="rounded-card bg-surface-secondary p-3">
                  <div className="font-semibold text-content-primary">{replaceSameNamed ? 'On' : 'Off'}</div>
                  <div className="text-content-secondary">Replace same-named dashboards</div>
                </div>
                <div className="rounded-card bg-surface-secondary p-3">
                  <div className="font-semibold text-content-primary">{emptyFirst ? 'On' : 'Off'}</div>
                  <div className="text-content-secondary">Empty target folder</div>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex flex-col gap-3">
                <button type="button" onClick={() => setStep(2)} className="btn-secondary">Back to destinations</button>
                <button type="button" onClick={() => void startJob()} disabled={!canRun} className="btn-primary inline-flex items-center justify-center gap-2">
                  {jobBusy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  Start migration
                </button>
                {blockedRows.length > 0 && <p className="text-xs text-red-700">Resolve blocked review rows before starting the job.</p>}
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="space-y-5">
          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">5. Run and results</h2>
                <p className="mt-1 text-sm text-content-secondary">Live progress is streamed from the local migration engine.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {job && !jobDone && (
                  <button type="button" onClick={() => setConfirmAction('cancel')} disabled={jobBusy} className="btn-secondary inline-flex items-center gap-2 text-red-700">
                    <XCircle size={15} />
                    Cancel
                  </button>
                )}
                {job && (job.status === 'failed' || job.status === 'partial') && (
                  <button type="button" onClick={() => void retryFailed()} disabled={jobBusy} className="btn-secondary inline-flex items-center gap-2">
                    <RefreshCw size={15} />
                    Retry failed import
                  </button>
                )}
                {job && jobDone && (
                  <button type="button" onClick={startNewMigration} className="btn-primary inline-flex items-center gap-2">
                    <Send size={15} />
                    Start new migration
                  </button>
                )}
              </div>
            </div>
            {!job ? (
              <div className="mt-4 rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
                Start the job from Review to see live progress here.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <DashboardMigrationLaunchScene current={completedItems} total={totalItems} status={job.status} />
                <div className="grid gap-3 lg:grid-cols-6">
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Destinations</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{job.targets?.length || targetRows.length}</div>
                  </div>
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Exports</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{terminalCount(exportItems)}/{exportItems.length}</div>
                  </div>
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Imports</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{terminalCount(importItems)}/{importItems.length}</div>
                  </div>
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Topics</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{topicPrepareItems.length ? `${terminalCount(topicPrepareItems)}/${topicPrepareItems.length}` : 'None'}</div>
                  </div>
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Schema refresh</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{refreshItems.length ? `${terminalCount(refreshItems)}/${refreshItems.length}` : 'Off'}</div>
                  </div>
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Source delete</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{sourceDeleteItems.length ? `${terminalCount(sourceDeleteItems)}/${sourceDeleteItems.length}` : 'Off'}</div>
                  </div>
                </div>
                <details className="rounded-card border border-border-subtle">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-content-primary">Item log</summary>
                  <div className="max-h-[420px] overflow-auto border-t border-border-subtle">
                    {job.items.map((item) => (
                      <div key={item.id} className="border-b border-border-subtle px-4 py-3 text-xs last:border-b-0">
                        <div className="flex items-start justify-between gap-2">
                          <span>
                            <span className="font-semibold text-content-primary">{kindLabel(item.kind)}</span>
                            <span className="ml-2 text-content-secondary">{item.destinationLabel} · {item.documentName || item.targetModelName || item.documentId || 'Step'}</span>
                          </span>
                          <span className={`rounded-chip px-2 py-0.5 font-semibold ${statusClass(item.status)}`}>{item.status}</span>
                        </div>
                        {item.importedIdentifier && <div className="mt-1 font-mono text-content-secondary">Imported: {item.importedIdentifier}</div>}
                        {item.warnings?.map((warning) => <div key={warning} className="mt-1 text-yellow-700">{warning}</div>)}
                        {item.notices?.map((notice) => <div key={notice} className="mt-1 text-blue-700">{notice}</div>)}
                        {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            )}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'start-with-cleanup' ? 'Start migration with cleanup?' : 'Cancel migration job?'}
        message={confirmAction === 'start-with-cleanup'
          ? `OmniKit will ${startConfirmationMessage}.`
          : 'In-flight Omni requests may finish, but OmniKit will stop scheduling new migration steps for this job.'}
        confirmLabel={confirmAction === 'start-with-cleanup' ? 'Start migration' : 'Cancel job'}
        cancelLabel="Go back"
        variant={confirmAction === 'start-with-cleanup' ? 'danger' : 'primary'}
        itemCount={confirmAction === 'start-with-cleanup' ? Math.max(targetDeleteCount, selectedDocumentIds.length) : undefined}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action === 'start-with-cleanup') void startJob(true);
          if (action === 'cancel') void cancelJob();
        }}
      />
    </div>
  );
}
