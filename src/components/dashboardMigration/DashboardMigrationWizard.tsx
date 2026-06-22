import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Database,
  ExternalLink,
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
  listInstanceModelQueryViews,
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
  buildDashboardQueryViewMappings,
  buildDashboardMigrationJobInput,
  buildRouteGroupsBySourceScope,
  buildTargetFolderOptions,
  buildSchemaRefreshActionsForTargets,
  cleanDashboardModelMetadata,
  collectDashboardSourceTopics,
  completedItem,
  createDashboardRouteGroupsFromSelection,
  dashboardDocumentModelLabel,
  dashboardMigrationRoutePathLabel,
  dashboardDestinationsEmptyState,
  dashboardGroupSelectionAriaLabel,
  dashboardMigrationReviewImpactSummary,
  dashboardSelectionAriaLabel,
  dashboardSelectionEmptyState,
  dashboardSourceScopeKey,
  dashboardSourceScopeLabel,
  destinationInstanceSelectionAriaLabel,
  getDashboardLoadBlockReason,
  getDashboardMigrationPreflightBlockReason,
  isTerminalJobStatus,
  mixedRouteGroupSourceScopeMessage,
  normalizeDashboardRouteGroups,
  preflightRowsFromPlan,
  preflightRouteGroupsFromPlan,
  queryViewRequirementsByRouteTargetFromPlan,
  statusClass,
  TARGET_FOLDER_COMBOBOX_CONFIG,
  TARGET_MODEL_COMBOBOX_CONFIG,
  unresolvedQueryViewMappingRouteMessage,
  unresolvedTopicMappingRouteMessage,
} from './dashboardMigrationUtils';
import {
  routeGroupDraftToMigrationRouteGroup,
  type DashboardMigrationRouteGroupDraft,
  createDashboardMigrationTargetDraft,
  type DashboardMigrationModelCatalog,
  type DashboardMigrationQueryViewCatalog,
  type DashboardMigrationQueryViewMappingDraft,
  type DashboardMigrationTargetCatalog,
  type DashboardMigrationTargetDraft,
  type DashboardMigrationTopicCatalog,
  type DashboardMigrationTopicMappingDraft,
  type PreflightTargetRow,
} from './dashboardMigrationTypes';

type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;
type ConfirmAction = 'start-with-cleanup' | 'cancel' | null;

const STEP_LABELS = ['Source', 'Select & group', 'Assign destinations', 'Resolve dependencies', 'Review', 'Run'];
const PREFLIGHT_TIMEOUT_MS = 120_000;
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

function documentNeedsMetadataEnrichment(document: InstanceDocument) {
  return !cleanDashboardModelMetadata(document.baseModelId)
    || !cleanDashboardModelMetadata(document.baseModelName)
    || !document.topicNames?.length
    || !document.topicIds?.length;
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
    queryViewMappings: [],
  };
}

function defaultRouteGroup(documentIds: string[], targetRowIds: string[]): DashboardMigrationRouteGroupDraft {
  return {
    id: DEFAULT_ROUTE_GROUP_ID,
    name: 'All selected dashboards',
    documentIds,
    targetRowIds,
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
  };
}

function targetModelCatalogKey(instanceId: string, connectionId: string) {
  return `${instanceId}::${connectionId}`;
}

function targetTopicCatalogKey(instanceId: string, modelId: string) {
  return `${instanceId}::${modelId}`;
}

function targetQueryViewCatalogKey(instanceId: string, modelId: string) {
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
  if (kind === 'query_view_prepare') return 'QUERY VIEW PREP';
  if (kind === 'relationship_prepare') return 'RELATIONSHIP PREP';
  if (kind === 'topic_prepare') return 'TOPIC PREP';
  return kind.toUpperCase();
}

function groupedItemMessages(messages?: string[]) {
  const counts = new Map<string, number>();
  for (const rawMessage of messages || []) {
    const message = rawMessage.trim();
    if (!message) continue;
    counts.set(message, (counts.get(message) || 0) + 1);
  }
  return [...counts.entries()].map(([message, count]) => ({ message, count }));
}

function queryViewMappingKey(mapping: Pick<DashboardMigrationQueryViewMappingDraft, 'sourceQueryViewName' | 'sourceFileName'>) {
  return (mapping.sourceFileName || mapping.sourceQueryViewName).toLowerCase();
}

function topicMappingKey(mapping: Pick<DashboardMigrationTopicMappingDraft, 'sourceTopicName' | 'sourceTopicId'>) {
  return (mapping.sourceTopicId || mapping.sourceTopicName).toLowerCase();
}

function semanticDestinationKey(row: DashboardMigrationTargetDraft) {
  if (!row.destinationInstanceId || !row.targetConnectionId || !row.targetModelId) return `row:${row.id}`;
  return [row.destinationInstanceId, row.targetConnectionId, row.targetModelId].join('::');
}

function targetRouteFolderLabel(row: DashboardMigrationTargetDraft) {
  return row.targetFolderPath || 'My Documents/default';
}

function detailStringArray(details: Record<string, unknown> | undefined, key: string): string[] {
  const value = details?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function detailArrayCount(details: Record<string, unknown> | undefined, key: string): number {
  const value = details?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function semanticAuditLines(item: MigrationJobItem): string[] {
  const details = item.details;
  if (!details || item.status === 'failed') return [];
  if (item.kind === 'query_view_prepare') {
    const created = detailStringArray(details, 'createdQueryViews');
    const updated = detailStringArray(details, 'updatedQueryViews');
    const mapped = detailStringArray(details, 'mappedQueryViews');
    return [
      created.length > 0 ? `Created query views: ${created.join(', ')}` : '',
      updated.length > 0 ? `Updated query views: ${updated.join(', ')}` : '',
      mapped.length > 0 ? `Mapped query views: ${mapped.join(', ')}` : '',
    ].filter(Boolean);
  }
  if (item.kind === 'relationship_prepare') {
    const addedCount = detailArrayCount(details, 'addedRelationshipEdges');
    const existingCount = detailArrayCount(details, 'existingRelationshipEdges');
    return [
      addedCount > 0 ? `Added ${addedCount} relationship edge${addedCount === 1 ? '' : 's'}.` : '',
      existingCount > 0 ? `Verified ${existingCount} existing relationship edge${existingCount === 1 ? '' : 's'}.` : '',
    ].filter(Boolean);
  }
  if (item.kind === 'topic_prepare') {
    const created = detailStringArray(details, 'createdTopics');
    const mapped = detailStringArray(details, 'mappedTopics');
    return [
      created.length > 0 ? `Created topics: ${created.join(', ')}` : '',
      mapped.length > 0 ? `Mapped topics: ${mapped.join(', ')}` : '',
    ].filter(Boolean);
  }
  if (item.kind === 'import' && typeof details.topicRewriteCount === 'number' && details.topicRewriteCount > 0) {
    return [`Rewrote ${details.topicRewriteCount} dashboard topic reference${details.topicRewriteCount === 1 ? '' : 's'} before import.`];
  }
  return [];
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
  const [routeAssignmentsCustomized, setRouteAssignmentsCustomized] = useState(false);
  const [targetInstanceSelectionIds, setTargetInstanceSelectionIds] = useState<string[]>([]);
  const [targetCatalogs, setTargetCatalogs] = useState<Record<string, DashboardMigrationTargetCatalog>>({});
  const [targetModelCatalogs, setTargetModelCatalogs] = useState<Record<string, DashboardMigrationModelCatalog>>({});
  const [targetTopicCatalogs, setTargetTopicCatalogs] = useState<Record<string, DashboardMigrationTopicCatalog>>({});
  const [targetQueryViewCatalogs, setTargetQueryViewCatalogs] = useState<Record<string, DashboardMigrationQueryViewCatalog>>({});
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
  const [dashboardLoadStatus, setDashboardLoadStatus] = useState('');
  const [metadataEnrichmentStatus, setMetadataEnrichmentStatus] = useState('');
  const [metadataEnrichmentRetryIds, setMetadataEnrichmentRetryIds] = useState<string[]>([]);
  const [dashboardLoadAttempted, setDashboardLoadAttempted] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightStatus, setPreflightStatus] = useState('');
  const [jobBusy, setJobBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fireConfetti = useConfetti();
  const logOperation = useLogOperation();
  const enrichedDocumentIdsRef = useRef<Set<string>>(new Set());
  const enrichingDocumentIdsRef = useRef<Set<string>>(new Set());

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
  const selectedSourceScopeCount = useMemo(
    () => new Set(selectedDocuments.map(dashboardSourceScopeKey)).size,
    [selectedDocuments],
  );
  const shouldRecommendSourceScopeGrouping = selectedSourceScopeCount > 1 && !hasAdvancedDashboardGroups;
  const allGroupsRouteToAllDestinations = useMemo(() => (
    targetRows.length > 0
    && routeGroups.length > 0
    && routeGroups.every((group) => targetRows.every((row) => group.targetRowIds.includes(row.id)))
  ), [routeGroups, targetRows]);

  useEffect(() => {
    setRouteGroups((current) => normalizeDashboardRouteGroups({
      groups: current,
      selectedDocumentIds,
      targetRowIds,
      defaultGroupId: DEFAULT_ROUTE_GROUP_ID,
      preserveTargetAssignments: routeAssignmentsCustomized,
    }));
    const validDocumentIds = new Set(selectedDocumentIds);
    setRouteSelectionIds((current) => current.filter((documentId) => validDocumentIds.has(documentId)));
  }, [routeAssignmentsCustomized, selectedDocumentIds, targetRowIds]);

  useEffect(() => {
    if (routeGroups.some((group) => group.id === activeRouteGroupId)) return;
    setActiveRouteGroupId(routeGroups[0]?.id || DEFAULT_ROUTE_GROUP_ID);
  }, [activeRouteGroupId, routeGroups]);

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

  const enrichSelectedDashboardMetadata = useCallback(async (documentIds: string[], options: { force?: boolean } = {}) => {
    if (options.force) {
      documentIds.forEach((documentId) => enrichedDocumentIdsRef.current.delete(documentId));
    }
    const ids = [...new Set(documentIds)]
      .filter((documentId) => !enrichedDocumentIdsRef.current.has(documentId))
      .filter((documentId) => !enrichingDocumentIdsRef.current.has(documentId));
    if (!sourceId || ids.length === 0) return;

    ids.forEach((documentId) => enrichingDocumentIdsRef.current.add(documentId));
    setMetadataEnrichmentStatus(`Reading model and topic metadata for ${ids.length} selected dashboard${ids.length === 1 ? '' : 's'}...`);
    let failed = false;
    try {
      const res = await listInstanceDocuments(sourceId, {
        connectionId: sourceConnectionId || undefined,
        allFolders: true,
        includeModelDetails: true,
        documentIds: ids,
      });
      const enrichedById = new Map<string, InstanceDocument>();
      for (const document of res.documents) {
        enrichedById.set(document.identifier, document);
        enrichedById.set(document.id, document);
      }
      setDocuments((current) => current.map((document) => {
        const enriched = enrichedById.get(document.identifier) || enrichedById.get(document.id);
        return enriched ? { ...document, ...enriched } : document;
      }));
      setMetadataEnrichmentRetryIds([]);
    } catch (err) {
      failed = true;
      setMetadataEnrichmentRetryIds(ids);
      setMetadataEnrichmentStatus(errorText(err, 'Metadata enrichment could not finish. Review will validate the selected dashboards before import.'));
    } finally {
      ids.forEach((documentId) => {
        enrichingDocumentIdsRef.current.delete(documentId);
        enrichedDocumentIdsRef.current.add(documentId);
      });
      if (!failed && enrichingDocumentIdsRef.current.size === 0) {
        window.setTimeout(() => setMetadataEnrichmentStatus(''), 1500);
      }
    }
  }, [sourceConnectionId, sourceId]);

  useEffect(() => {
    if (selectedDocumentIds.length === 0 || documents.length === 0) return;
    const selectedNeedingMetadata = documents
      .filter((document) => selectedDocumentIds.includes(document.identifier))
      .filter(documentNeedsMetadataEnrichment)
      .map((document) => document.identifier);
    if (selectedNeedingMetadata.length > 0) void enrichSelectedDashboardMetadata(selectedNeedingMetadata);
  }, [documents, enrichSelectedDashboardMetadata, selectedDocumentIds]);

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

  const activeTargetRowsWithQueryViewMappings = useMemo<DashboardMigrationTargetDraft[]>(() => (
    targetRows.map((row) => ({
      ...row,
      queryViewMappings: activeRouteGroup.queryViewMappingsByTargetId?.[row.id] || [],
    }))
  ), [activeRouteGroup, targetRows]);
  const activeAssignedTargetRowsWithQueryViewMappings = useMemo(
    () => activeTargetRowsWithQueryViewMappings.filter((row) => activeRouteGroup.targetRowIds.includes(row.id)),
    [activeRouteGroup.targetRowIds, activeTargetRowsWithQueryViewMappings],
  );
  const activeAssignedRowsWithDetectedQueryViewMappings = useMemo(
    () => activeAssignedTargetRowsWithQueryViewMappings.filter((row) => (row.queryViewMappings || []).length > 0),
    [activeAssignedTargetRowsWithQueryViewMappings],
  );
  const activeAssignedQueryViewSemanticGroups = useMemo(() => {
    const groups = new Map<string, {
      id: string;
      primaryRow: DashboardMigrationTargetDraft;
      rows: DashboardMigrationTargetDraft[];
      routeIndexes: number[];
      folderLabels: string[];
      queryViewMappings: DashboardMigrationQueryViewMappingDraft[];
    }>();
    for (const row of activeAssignedRowsWithDetectedQueryViewMappings) {
      const key = semanticDestinationKey(row);
      const routeIndex = targetRows.findIndex((targetRow) => targetRow.id === row.id) + 1;
      const existing = groups.get(key);
      const group = existing || {
        id: key,
        primaryRow: row,
        rows: [],
        routeIndexes: [],
        folderLabels: [],
        queryViewMappings: [],
      };
      group.rows.push(row);
      if (routeIndex > 0) group.routeIndexes.push(routeIndex);
      const folderLabel = targetRouteFolderLabel(row);
      if (!group.folderLabels.includes(folderLabel)) group.folderLabels.push(folderLabel);
      const existingKeys = new Set(group.queryViewMappings.map(queryViewMappingKey));
      for (const mapping of row.queryViewMappings || []) {
        const mappingKey = queryViewMappingKey(mapping);
        if (!existingKeys.has(mappingKey)) {
          group.queryViewMappings.push(mapping);
          existingKeys.add(mappingKey);
        }
      }
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [activeAssignedRowsWithDetectedQueryViewMappings, targetRows]);

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
  const activeAssignedTargetRowsWithTopicMappings = useMemo(
    () => activeTargetRowsWithTopicMappings.filter((row) => activeRouteGroup.targetRowIds.includes(row.id)),
    [activeRouteGroup.targetRowIds, activeTargetRowsWithTopicMappings],
  );
  const activeAssignedTopicSemanticGroups = useMemo(() => {
    const groups = new Map<string, {
      id: string;
      primaryRow: DashboardMigrationTargetDraft;
      rows: DashboardMigrationTargetDraft[];
      routeIndexes: number[];
      folderLabels: string[];
      topicMappings: DashboardMigrationTopicMappingDraft[];
    }>();
    for (const row of activeAssignedTargetRowsWithTopicMappings) {
      const key = semanticDestinationKey(row);
      const routeIndex = targetRows.findIndex((targetRow) => targetRow.id === row.id) + 1;
      const existing = groups.get(key);
      const group = existing || {
        id: key,
        primaryRow: row,
        rows: [],
        routeIndexes: [],
        folderLabels: [],
        topicMappings: [],
      };
      group.rows.push(row);
      if (routeIndex > 0) group.routeIndexes.push(routeIndex);
      const folderLabel = targetRouteFolderLabel(row);
      if (!group.folderLabels.includes(folderLabel)) group.folderLabels.push(folderLabel);
      const existingKeys = new Set(group.topicMappings.map(topicMappingKey));
      for (const mapping of row.topicMappings || []) {
        const mappingKey = topicMappingKey(mapping);
        if (!existingKeys.has(mappingKey)) {
          group.topicMappings.push(mapping);
          existingKeys.add(mappingKey);
        }
      }
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [activeAssignedTargetRowsWithTopicMappings, targetRows]);

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

  const queryViewMappingBlockMessage = useMemo(() => {
    for (const group of routeGroups) {
      for (const targetRowId of group.targetRowIds) {
        const row = targetRows.find((targetRow) => targetRow.id === targetRowId);
        const existingMappings = group.queryViewMappingsByTargetId?.[targetRowId] || [];
        if (existingMappings.length === 0 || !row?.destinationInstanceId || !row.targetModelId) continue;
        const queryViewCatalog = targetQueryViewCatalogs[targetQueryViewCatalogKey(row.destinationInstanceId, row.targetModelId)];
        const destinationLabel = instances.find((instance) => instance.id === row.destinationInstanceId)?.label || row.destinationInstanceId;
        const connection = targetCatalogs[row.destinationInstanceId]?.connections.find((item) => item.id === row.targetConnectionId);
        const connectionRouteLabel = connection ? connectionLabel(connection) : row.targetConnectionId;
        const routeLabel = dashboardMigrationRoutePathLabel({
          groupName: group.name,
          destinationLabel,
          connectionLabel: connectionRouteLabel,
          modelLabel: row.targetModelName || row.targetModelId,
          folderLabel: row.targetFolderPath || 'My Documents/default',
        });
        if (!queryViewCatalog?.loaded) {
          return `Load destination query views for route ${routeLabel} before review.`;
        }
        const unresolved = existingMappings.find((mapping) => !mapping.targetQueryViewName || mapping.status === 'blocked' || mapping.action === 'unresolved');
        if (unresolved) {
          return unresolvedQueryViewMappingRouteMessage({
            sourceQueryViewName: unresolved.sourceQueryViewName,
            groupName: group.name,
            destinationLabel,
            connectionLabel: connectionRouteLabel,
            modelLabel: row.targetModelName || row.targetModelId,
            folderLabel: row.targetFolderPath || 'My Documents/default',
          });
        }
      }
    }
    return '';
  }, [instances, routeGroups, targetCatalogs, targetQueryViewCatalogs, targetRows]);

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
          const connection = targetCatalogs[row.destinationInstanceId]?.connections.find((item) => item.id === row.targetConnectionId);
          const targetConnectionRouteLabel = connection
            ? connectionLabel(connection)
            : row.targetConnectionId;
          return unresolvedTopicMappingRouteMessage({
            sourceTopicName: unresolved.sourceTopicName,
            groupName: group.name,
            destinationLabel,
            connectionLabel: targetConnectionRouteLabel,
            modelLabel: row.targetModelName || row.targetModelId,
            folderLabel: row.targetFolderPath || 'My Documents/default',
          });
        }
      }
    }
    return '';
  }, [documents, instances, routeGroups, targetCatalogs, targetRows, targetTopicCatalogs]);

  const hasLoadingTargets = targetRows.some((row) => {
    if (!routedTargetRowIds.has(row.id)) return false;
    const targetCatalog = row.destinationInstanceId ? targetCatalogs[row.destinationInstanceId] : null;
    const modelCatalog = row.destinationInstanceId && row.targetConnectionId
      ? targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)]
      : null;
    const topicCatalog = row.destinationInstanceId && row.targetModelId
      ? targetTopicCatalogs[targetTopicCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
    const rowHasQueryViewMappings = routeGroups.some((group) => (
      group.targetRowIds.includes(row.id)
      && (group.queryViewMappingsByTargetId?.[row.id]?.length || 0) > 0
    ));
    const queryViewCatalog = rowHasQueryViewMappings && row.destinationInstanceId && row.targetModelId
      ? targetQueryViewCatalogs[targetQueryViewCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
    return targetCatalog?.loading || modelCatalog?.loading || topicCatalog?.loading || queryViewCatalog?.loading;
  });
  const hasUnresolvedFolderTargets = targetRows.some((row) => routedTargetRowIds.has(row.id) && Boolean(row.targetFolderId && !row.targetFolderPath));
  const hasInvalidTargetModel = targetRows.some((row) => {
    if (!routedTargetRowIds.has(row.id)) return false;
    if (!row.destinationInstanceId || !row.targetConnectionId || !row.targetModelId) return false;
    const modelCatalog = targetModelCatalogs[targetModelCatalogKey(row.destinationInstanceId, row.targetConnectionId)];
    if (!modelCatalog?.loaded) return false;
    return !modelCatalog.models.some((model) => model.id === row.targetModelId);
  });
  const hasUnresolvedQueryViewMappings = Boolean(queryViewMappingBlockMessage);
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
    hasUnresolvedQueryViewMappings,
    unresolvedQueryViewMappingMessage: queryViewMappingBlockMessage,
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
  const queryViewPrepareItems = job?.items.filter((item) => item.kind === 'query_view_prepare') || [];
  const relationshipPrepareItems = job?.items.filter((item) => item.kind === 'relationship_prepare') || [];
  const topicPrepareItems = job?.items.filter((item) => item.kind === 'topic_prepare') || [];
  const refreshItems = job?.items.filter((item) => item.kind === 'post_action') || [];
  const sourceDeleteItems = job?.items.filter((item) => item.kind === 'source_delete') || [];
  const totalItems = job?.items.length || 0;
  const completedItems = job ? terminalCount(job.items) : 0;
  const failedItems = job?.items.filter((item) => item.status === 'failed') || [];
  const warningItems = job?.items.filter((item) => item.status === 'warning' || (item.warnings?.length || 0) > 0) || [];
  const importedDashboardLinks = importItems
    .filter((item) => item.importedIdentifier && (item.status === 'succeeded' || item.status === 'warning'))
    .map((item) => {
      const instance = instances.find((candidate) => candidate.id === item.destinationId);
      const baseUrl = instance?.baseUrl.replace(/\/+$/, '');
      return {
        id: item.id,
        label: item.documentName || item.importedIdentifier || 'Imported dashboard',
        destinationLabel: item.destinationLabel,
        url: baseUrl && item.importedIdentifier ? `${baseUrl}/dashboards/${item.importedIdentifier}` : '',
      };
    });

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
    setRouteAssignmentsCustomized(false);
    setSearch('');
    setDashboardFolderFilter('');
    setDashboardModelFilter('');
    setDashboardTopicFilter('');
    setDashboardLabelFilter('');
    setDashboardLoadAttempted(false);
    setDashboardLoadStatus('');
    setMetadataEnrichmentStatus('');
    setMetadataEnrichmentRetryIds([]);
    enrichedDocumentIdsRef.current.clear();
    enrichingDocumentIdsRef.current.clear();
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
        foldersLoading: prev[instanceId]?.foldersLoading || false,
        foldersLoaded: prev[instanceId]?.foldersLoaded || false,
        folderError: prev[instanceId]?.folderError || '',
        error: '',
      },
    }));
    try {
      const connectionsRes = await listModelMigratorConnections(instanceId);
      const catalog: DashboardMigrationTargetCatalog = {
        connections: connectionsRes.connections.filter((connection) => !connection.deletedAt),
        models: [],
        folders: current?.folders || [],
        loading: false,
        loaded: true,
        foldersLoading: current?.foldersLoading || false,
        foldersLoaded: current?.foldersLoaded || false,
        folderError: current?.folderError || '',
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
        foldersLoading: current?.foldersLoading || false,
        foldersLoaded: current?.foldersLoaded || false,
        folderError: current?.folderError || '',
        error: errorText(err, 'Could not load target connections and folders.'),
      };
      setTargetCatalogs((prev) => ({ ...prev, [instanceId]: catalog }));
      setError(catalog.error);
      return catalog;
    }
  }

  async function loadTargetFolders(instanceId: string): Promise<DashboardMigrationTargetCatalog | null> {
    if (!instanceId) return null;
    const current = targetCatalogs[instanceId];
    if (current?.foldersLoaded && !current.foldersLoading) return current;
    setTargetCatalogs((prev) => ({
      ...prev,
      [instanceId]: {
        connections: prev[instanceId]?.connections || [],
        models: prev[instanceId]?.models || [],
        folders: prev[instanceId]?.folders || [],
        loading: prev[instanceId]?.loading || false,
        loaded: prev[instanceId]?.loaded || false,
        foldersLoading: true,
        foldersLoaded: prev[instanceId]?.foldersLoaded || false,
        folderError: '',
        error: prev[instanceId]?.error || '',
      },
    }));
    try {
      const foldersRes = await listInstanceFolders(instanceId);
      const catalog: DashboardMigrationTargetCatalog = {
        connections: current?.connections || [],
        models: current?.models || [],
        folders: flattenFolders(foldersRes.folders),
        loading: current?.loading || false,
        loaded: current?.loaded || false,
        foldersLoading: false,
        foldersLoaded: true,
        folderError: '',
        error: current?.error || '',
      };
      setTargetCatalogs((prev) => ({
        ...prev,
        [instanceId]: {
          ...catalog,
          connections: prev[instanceId]?.connections || catalog.connections,
          loaded: prev[instanceId]?.loaded || catalog.loaded,
          error: prev[instanceId]?.error || catalog.error,
        },
      }));
      return catalog;
    } catch (err) {
      const catalog: DashboardMigrationTargetCatalog = {
        connections: current?.connections || [],
        models: current?.models || [],
        folders: current?.folders || [],
        loading: current?.loading || false,
        loaded: current?.loaded || false,
        foldersLoading: false,
        foldersLoaded: false,
        folderError: errorText(err, 'Could not load target folders.'),
        error: current?.error || '',
      };
      setTargetCatalogs((prev) => ({ ...prev, [instanceId]: catalog }));
      setError(catalog.folderError || 'Could not load target folders.');
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

  async function loadTargetQueryViews(instanceId: string, modelId: string): Promise<DashboardMigrationQueryViewCatalog | null> {
    if (!instanceId || !modelId) return null;
    const key = targetQueryViewCatalogKey(instanceId, modelId);
    const current = targetQueryViewCatalogs[key];
    if (current?.loaded && !current.loading) return current;
    setTargetQueryViewCatalogs((prev) => ({
      ...prev,
      [key]: {
        queryViews: prev[key]?.queryViews || [],
        loading: true,
        loaded: prev[key]?.loaded || false,
        error: '',
      },
    }));
    try {
      const res = await listInstanceModelQueryViews(instanceId, modelId);
      const catalog: DashboardMigrationQueryViewCatalog = {
        queryViews: [...res.queryViews].sort((a, b) => a.name.localeCompare(b.name)),
        loading: false,
        loaded: true,
        error: '',
      };
      setTargetQueryViewCatalogs((prev) => ({ ...prev, [key]: catalog }));
      return catalog;
    } catch (err) {
      const catalog: DashboardMigrationQueryViewCatalog = {
        queryViews: current?.queryViews || [],
        loading: false,
        loaded: false,
        error: errorText(err, 'Could not load target query views for the selected model.'),
      };
      setTargetQueryViewCatalogs((prev) => ({ ...prev, [key]: catalog }));
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
      queryViewMappings: [],
    };
    setTargetRows((prev) => [...prev, duplicate]);
    resetPlan();
    if (duplicate.destinationInstanceId) await loadTargetCatalog(duplicate.destinationInstanceId);
    if (duplicate.destinationInstanceId && duplicate.targetConnectionId) {
      await loadTargetModels(duplicate.destinationInstanceId, duplicate.targetConnectionId);
    }
    if (duplicate.destinationInstanceId && duplicate.targetModelId) {
      void loadTargetTopics(duplicate.destinationInstanceId, duplicate.targetModelId);
      void loadTargetQueryViews(duplicate.destinationInstanceId, duplicate.targetModelId);
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

  function clearRouteSemanticMappingsForTarget(rowId: string) {
    setRouteGroups((current) => current.map((group) => {
      if (!group.topicMappingsByTargetId?.[rowId] && !group.queryViewMappingsByTargetId?.[rowId]) return group;
      const topicMappingsByTargetId = { ...group.topicMappingsByTargetId };
      const queryViewMappingsByTargetId = { ...group.queryViewMappingsByTargetId };
      delete topicMappingsByTargetId[rowId];
      delete queryViewMappingsByTargetId[rowId];
      return { ...group, topicMappingsByTargetId, queryViewMappingsByTargetId };
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
      queryViewMappings: [],
    });
    clearRouteSemanticMappingsForTarget(rowId);
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
      queryViewMappings: [],
    });
    clearRouteSemanticMappingsForTarget(rowId);
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
        queryViewMappings: [],
      });
      void loadTargetTopics(destinationInstanceId, model.id);
      void loadTargetQueryViews(destinationInstanceId, model.id);
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
        queryViewMappings: [],
      });
      clearRouteSemanticMappingsForTarget(row.id);
      setError('Choose a target model from the selected connection catalog.');
      return;
    }
    setError('');
    patchTargetRow(row.id, {
      targetModelId,
      targetModelName: model ? modelDisplayLabel(model) : targetModelId,
      topicMappings: [],
      queryViewMappings: [],
    });
    clearRouteSemanticMappingsForTarget(row.id);
    if (row.destinationInstanceId && targetModelId) {
      void loadTargetTopics(row.destinationInstanceId, targetModelId);
      void loadTargetQueryViews(row.destinationInstanceId, targetModelId);
    }
  }

  function chooseTargetFolder(row: DashboardMigrationTargetDraft, value: string) {
    const catalog = targetCatalogs[row.destinationInstanceId];
    const folder = catalog?.folders.find((item) => item.path === value || item.identifier === value || item.id === value);
    patchTargetRow(row.id, {
      targetFolderId: folder?.id || '',
      targetFolderPath: folder?.path || value || '',
    });
  }

  function updateQueryViewMapping(row: DashboardMigrationTargetDraft, nextMapping: DashboardMigrationQueryViewMappingDraft) {
    const nextKey = queryViewMappingKey(nextMapping);
    const peerRowIds = targetRows
      .filter((targetRow) => activeRouteGroup.targetRowIds.includes(targetRow.id))
      .filter((targetRow) => semanticDestinationKey(targetRow) === semanticDestinationKey(row))
      .map((targetRow) => targetRow.id);
    setRouteGroups((current) => current.map((group) => {
      if (group.id !== activeRouteGroup.id) return group;
      const queryViewMappingsByTargetId = { ...(group.queryViewMappingsByTargetId || {}) };
      for (const targetRowId of peerRowIds) {
        const currentMappings = queryViewMappingsByTargetId[targetRowId] || [];
        queryViewMappingsByTargetId[targetRowId] = currentMappings.some((mapping) => queryViewMappingKey(mapping) === nextKey)
          ? currentMappings.map((mapping) => queryViewMappingKey(mapping) === nextKey ? nextMapping : mapping)
          : [...currentMappings, nextMapping];
      }
      return {
        ...group,
        queryViewMappingsByTargetId,
      };
    }));
    resetPlan();
  }

  function updateTopicMapping(row: DashboardMigrationTargetDraft, nextMapping: DashboardMigrationTopicMappingDraft) {
    const nextKey = topicMappingKey(nextMapping);
    const peerRowIds = targetRows
      .filter((targetRow) => activeRouteGroup.targetRowIds.includes(targetRow.id))
      .filter((targetRow) => semanticDestinationKey(targetRow) === semanticDestinationKey(row))
      .map((targetRow) => targetRow.id);
    setRouteGroups((current) => current.map((group) => {
      if (group.id !== activeRouteGroup.id) return group;
      const topicMappingsByTargetId = { ...(group.topicMappingsByTargetId || {}) };
      for (const targetRowId of peerRowIds) {
        const currentMappings = topicMappingsByTargetId[targetRowId] || [];
        topicMappingsByTargetId[targetRowId] = currentMappings.some((mapping) => topicMappingKey(mapping) === nextKey)
          ? currentMappings.map((mapping) => topicMappingKey(mapping) === nextKey ? nextMapping : mapping)
          : [...currentMappings, nextMapping];
      }
      return {
        ...group,
        topicMappingsByTargetId,
      };
    }));
    resetPlan();
  }

  function toggleRouteSelection(documentId: string) {
    setRouteSelectionIds((current) => current.includes(documentId)
      ? current.filter((id) => id !== documentId)
      : [...current, documentId]);
  }

  function keepDashboardsTogether() {
    setRouteAssignmentsCustomized(false);
    setRouteGroups([defaultRouteGroup(selectedDocumentIds, targetRowIds)]);
    setActiveRouteGroupId(DEFAULT_ROUTE_GROUP_ID);
    setRouteSelectionIds([]);
    resetPlan();
  }

  function createRouteGroupFromSelection() {
    if (routeSelectionIds.length === 0) {
      setMessage('Choose dashboards in the grouping panel before creating a group.');
      return;
    }
    const nextGroupId = makeRouteGroupId();
    const remainingGroupId = makeRouteGroupId();
    setRouteGroups((current) => createDashboardRouteGroupsFromSelection({
      currentGroups: current,
      activeGroupId: activeRouteGroup.id,
      selectedDocumentIds,
      routeSelectionIds,
      targetRowIds,
      defaultGroupId: DEFAULT_ROUTE_GROUP_ID,
      nextGroupId,
      remainingGroupId,
      nextGroupName: `Dashboard group ${routeGroups.length}`,
    }));
    setActiveRouteGroupId(nextGroupId);
    setRouteSelectionIds([]);
    resetPlan();
  }

  function moveSelectionToActiveRouteGroup() {
    if (routeSelectionIds.length === 0) {
      setMessage('Choose dashboards in the grouping panel before moving them.');
      return;
    }
    if (activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID) {
      setMessage('The default group already includes every selected dashboard. Choose or create another group before moving dashboards.');
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
      queryViewMappingsByTargetId: Object.fromEntries(
        Object.entries(activeRouteGroup.queryViewMappingsByTargetId || {}).map(([targetRowId, mappings]) => [
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
    setRouteAssignmentsCustomized(false);
    setRouteGroups(grouped.length > 0 ? grouped : [defaultRouteGroup(selectedDocumentIds, targetRowIds)]);
    setActiveRouteGroupId(grouped[0]?.id || DEFAULT_ROUTE_GROUP_ID);
    setRouteSelectionIds([]);
    resetPlan();
  }

  function setRouteGroupTargetAssignment(groupId: string, rowId: string, included: boolean) {
    setRouteAssignmentsCustomized(true);
    setRouteGroups((current) => current.map((group) => {
      if (group.id !== groupId) return group;
      const targetRowIds = included
        ? [...new Set([...group.targetRowIds, rowId])]
        : group.targetRowIds.filter((targetRowId) => targetRowId !== rowId);
      const topicMappingsByTargetId = { ...(group.topicMappingsByTargetId || {}) };
      const queryViewMappingsByTargetId = { ...(group.queryViewMappingsByTargetId || {}) };
      if (!included) delete topicMappingsByTargetId[rowId];
      if (!included) delete queryViewMappingsByTargetId[rowId];
      return { ...group, targetRowIds, topicMappingsByTargetId, queryViewMappingsByTargetId };
    }));
    resetPlan();
  }

  function assignAllGroupsToAllDestinations() {
    setRouteAssignmentsCustomized(false);
    setRouteGroups((current) => current.map((group) => ({
      ...group,
      targetRowIds,
      topicMappingsByTargetId: Object.fromEntries(
        Object.entries(group.topicMappingsByTargetId || {}).filter(([targetRowId]) => targetRowIds.includes(targetRowId)),
      ),
      queryViewMappingsByTargetId: Object.fromEntries(
        Object.entries(group.queryViewMappingsByTargetId || {}).filter(([targetRowId]) => targetRowIds.includes(targetRowId)),
      ),
    })));
    resetPlan();
  }

  function assignGroupToAllDestinations(groupId: string) {
    setRouteAssignmentsCustomized(true);
    setRouteGroups((current) => current.map((group) => (
      group.id === groupId ? { ...group, targetRowIds } : group
    )));
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
    setDashboardLoadStatus('Loading the dashboard catalog for this connection...');
    setMetadataEnrichmentStatus('');
    enrichedDocumentIdsRef.current.clear();
    enrichingDocumentIdsRef.current.clear();
    setDashboardLoadAttempted(true);
    setError('');
    setMessage('');
    resetPlan();
    try {
      const res = await listInstanceDocuments(sourceId, {
        connectionId: sourceConnectionId || undefined,
        allFolders: true,
        includeModelDetails: false,
      });
      setDashboardLoadStatus('Scoping dashboards to the selected connection...');
      const connectionScopedDocuments = sourceConnectionId
        ? res.documents.filter((document) => !document.connectionId || document.connectionId === sourceConnectionId)
        : res.documents;
      let modelRows = sourceModels;
      if (sourceConnectionId && modelRows.length === 0) {
        setDashboardLoadStatus('Checking source models for fallback metadata...');
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
      setDashboardLoadStatus('');
      setError(errorText(err, 'Could not load source dashboards.'));
    } finally {
      setLoadingDocuments(false);
      setDashboardLoadStatus('');
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
    return buildDashboardMigrationJobInput({
      sourceId,
      sourceConnectionId,
      targets: migrationTargets,
      routeGroups: compiledRouteGroups,
      documentIds: selectedDocumentIds,
      sourceDocumentHints: selectedDocuments,
      emptyFirst,
      replaceSameNamed,
      deleteSourceOnSuccess,
      postMigrationActions,
    });
  }

  async function syncDetectedQueryViewMappingsFromPlan(nextPlan: MigrationPlan) {
    const requirementsByRouteTarget = queryViewRequirementsByRouteTargetFromPlan(nextPlan);
    const catalogByTargetRowId = new Map<string, DashboardMigrationQueryViewCatalog>();
    const neededTargetRows = new Map<string, DashboardMigrationTargetDraft>();

    for (const group of routeGroups) {
      const groupRequirements = requirementsByRouteTarget[group.id] || {};
      for (const targetRowId of Object.keys(groupRequirements)) {
        if (groupRequirements[targetRowId].length === 0) continue;
        const row = targetRows.find((targetRow) => targetRow.id === targetRowId);
        if (row?.destinationInstanceId && row.targetModelId) neededTargetRows.set(targetRowId, row);
      }
    }

    await Promise.all([...neededTargetRows.entries()].map(async ([targetRowId, row]) => {
      const catalog = await loadTargetQueryViews(row.destinationInstanceId, row.targetModelId);
      if (catalog) catalogByTargetRowId.set(targetRowId, catalog);
    }));

    let detectedCount = 0;
    let addedCount = 0;
    let blockedCount = 0;
    let changed = false;
    const mappingKey = (mapping: Pick<DashboardMigrationQueryViewMappingDraft, 'sourceQueryViewName' | 'sourceFileName'>) => (
      (mapping.sourceFileName || mapping.sourceQueryViewName).toLowerCase()
    );

    const nextGroups = routeGroups.map((group) => {
      const groupRequirements = requirementsByRouteTarget[group.id] || {};
      if (Object.keys(groupRequirements).length === 0) return group;
      const queryViewMappingsByTargetId = { ...(group.queryViewMappingsByTargetId || {}) };
      let groupChanged = false;

      for (const targetRowId of group.targetRowIds) {
        const requiredQueryViews = groupRequirements[targetRowId] || [];
        if (requiredQueryViews.length === 0) continue;
        const existingMappings = queryViewMappingsByTargetId[targetRowId] || [];
        const existingKeys = new Set(existingMappings.map(mappingKey));
        const targetQueryViews = catalogByTargetRowId.get(targetRowId)?.queryViews || [];
        const nextMappings = buildDashboardQueryViewMappings(requiredQueryViews, targetQueryViews, existingMappings);
        detectedCount += nextMappings.length;
        addedCount += nextMappings.filter((mapping) => !existingKeys.has(mappingKey(mapping))).length;
        blockedCount += nextMappings.filter((mapping) => !mapping.targetQueryViewName || mapping.status === 'blocked' || mapping.action === 'unresolved').length;
        const before = JSON.stringify(existingMappings);
        const after = JSON.stringify(nextMappings);
        if (before !== after) {
          changed = true;
          groupChanged = true;
          queryViewMappingsByTargetId[targetRowId] = nextMappings;
        }
      }

      return groupChanged ? { ...group, queryViewMappingsByTargetId } : group;
    });

    if (changed) setRouteGroups(nextGroups);
    return {
      detectedCount,
      addedCount,
      blockedCount,
      needsReview: addedCount > 0 || blockedCount > 0,
    };
  }

  async function runPreflight() {
    if (preflightBlockReason) {
      setMessage(preflightBlockReason);
      return;
    }
    setPreflightLoading(true);
    setPreflightStatus('Building the route preview and checking destination readiness...');
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
      setPreflightStatus('Checking query-view and topic mappings from the readiness result...');
      const queryViewSync = await syncDetectedQueryViewMappingsFromPlan(res.plan);
      setPlan(res.plan);
      setPlanRows(preflightRowsFromPlan(res.plan));
      if (queryViewSync.needsReview) {
        setStep(3);
        setMessage(queryViewSync.blockedCount > 0
          ? 'Query-view mappings were detected and need attention before review. Resolve them in Step 4, then check readiness again.'
          : 'Query-view mappings were detected. Review them in Step 4, then check readiness again.');
        return;
      }
      setStep(4);
      setMessage('Review is ready. Check warnings before starting the migration.');
    } catch (err) {
      setMessage('');
      setError(errorText(err, 'Could not check destination readiness.'));
    } finally {
      setPreflightLoading(false);
      setPreflightStatus('');
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
      setStep(5);
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
    if (index === 3) return selectedDocumentIds.length > 0 && targetRows.length > 0;
    if (index === 4) return planRows.length > 0;
    if (index === 5) return Boolean(job);
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

  function targetQueryViewOptions(row: DashboardMigrationTargetDraft) {
    const catalog = row.destinationInstanceId && row.targetModelId
      ? targetQueryViewCatalogs[targetQueryViewCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
    return (catalog?.queryViews || []).map((queryView) => ({
      value: queryView.name,
      label: queryView.label && queryView.label !== queryView.name ? `${queryView.label} (${queryView.name})` : queryView.name,
      subtitle: queryView.fileName || queryView.description,
    }));
  }

  function targetQueryViewCatalog(row: DashboardMigrationTargetDraft) {
    return row.destinationInstanceId && row.targetModelId
      ? targetQueryViewCatalogs[targetQueryViewCatalogKey(row.destinationInstanceId, row.targetModelId)]
      : null;
  }

  function targetQueryViewNameExists(row: DashboardMigrationTargetDraft, value: string) {
    const cleanValue = cleanDashboardModelMetadata(value)?.toLowerCase();
    if (!cleanValue) return false;
    return (targetQueryViewCatalog(row)?.queryViews || []).some((queryView) => (
      [queryView.name, queryView.label, queryView.fileName?.split('/').pop()?.replace(/\.query\.view$/i, '')]
        .map((candidate) => cleanDashboardModelMetadata(candidate)?.toLowerCase())
        .includes(cleanValue)
    ));
  }

  function generatedQueryViewName(row: DashboardMigrationTargetDraft, mapping: DashboardMigrationQueryViewMappingDraft) {
    const base = cleanDashboardModelMetadata(mapping.sourceQueryViewName)
      || cleanDashboardModelMetadata(mapping.sourceFileName?.split('/').pop()?.replace(/\.query\.view$/i, ''))
      || 'created_query_view';
    if (!targetQueryViewNameExists(row, base)) return base;
    for (let index = 1; index < 100; index += 1) {
      const candidate = index === 1 ? `${base}_copy` : `${base}_copy_${index}`;
      if (!targetQueryViewNameExists(row, candidate)) return candidate;
    }
    return `${base}_copy_${Date.now()}`;
  }

  function createdQueryViewMapping(
    row: DashboardMigrationTargetDraft,
    mapping: DashboardMigrationQueryViewMappingDraft,
    targetQueryViewName: string,
  ): DashboardMigrationQueryViewMappingDraft {
    const cleanName = targetQueryViewName.trim();
    const exists = Boolean(cleanName && targetQueryViewNameExists(row, cleanName));
    return {
      ...mapping,
      action: 'copy_source',
      targetQueryViewName: cleanName,
      targetFileName: cleanName ? `${cleanName}.query.view` : undefined,
      targetQueryViewLabel: undefined,
      status: !cleanName || exists ? 'blocked' : 'ready',
      warnings: !cleanName
        ? ['Enter a target query-view name to create.']
        : exists
          ? [`Target query view ${cleanName} already exists. Use the existing query view or enter a new query-view name.`]
          : undefined,
    };
  }

  function existingQueryViewMapping(
    row: DashboardMigrationTargetDraft,
    mapping: DashboardMigrationQueryViewMappingDraft,
    action: 'map_existing' | 'use_existing_unverified' | 'update_existing',
  ): DashboardMigrationQueryViewMappingDraft {
    const queryView = targetQueryViewCatalog(row)?.queryViews.find((item) => item.name === mapping.targetQueryViewName)
      || targetQueryViewCatalog(row)?.queryViews.find((item) => item.name === mapping.sourceQueryViewName);
    const targetQueryViewName = queryView?.name || mapping.targetQueryViewName;
    const unresolvedWarnings = mapping.action === 'unresolved' || mapping.status === 'blocked' ? mapping.warnings : undefined;
    return {
      ...mapping,
      action,
      targetQueryViewName,
      targetFileName: queryView?.fileName || mapping.targetFileName,
      targetQueryViewLabel: queryView?.label || mapping.targetQueryViewLabel,
      status: targetQueryViewName
        ? (action === 'use_existing_unverified' ? 'warning' : action === 'map_existing' && unresolvedWarnings?.length ? 'blocked' : 'ready')
        : 'blocked',
      warnings: !targetQueryViewName
        ? ['Choose an existing target query view.']
        : action === 'use_existing_unverified'
          ? ['Using this existing query view as-is even though compatibility checks found a mismatch.']
          : action === 'map_existing'
            ? unresolvedWarnings
            : undefined,
    };
  }

  function queryViewMappingIsExactMatch(mapping: DashboardMigrationQueryViewMappingDraft) {
    if (!['map_existing', 'use_existing_unverified', 'update_existing'].includes(mapping.action) || !mapping.targetQueryViewName) return false;
    const sourceKeys = [mapping.sourceQueryViewName, mapping.sourceFileName?.split('/').pop()?.replace(/\.query\.view$/i, '')]
      .map((value) => cleanDashboardModelMetadata(value)?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const targetKeys = [mapping.targetQueryViewName, mapping.targetQueryViewLabel, mapping.targetFileName?.split('/').pop()?.replace(/\.query\.view$/i, '')]
      .map((value) => cleanDashboardModelMetadata(value)?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    return sourceKeys.some((sourceKey) => targetKeys.includes(sourceKey));
  }

  function queryViewMappingStatus(mapping: DashboardMigrationQueryViewMappingDraft) {
    if (mapping.status === 'blocked' || !mapping.targetQueryViewName) {
      return {
        label: 'Needs choice',
        className: 'bg-red-50 text-red-700',
      };
    }
    if (mapping.action === 'copy_source') {
      return {
        label: 'Will create before topics',
        className: 'bg-blue-50 text-blue-700',
      };
    }
    if (mapping.action === 'update_existing') {
      return {
        label: 'Will update existing',
        className: 'bg-blue-50 text-blue-700',
      };
    }
    if (mapping.action === 'use_existing_unverified') {
      return {
        label: 'Use as-is override',
        className: 'bg-yellow-50 text-yellow-800',
      };
    }
    if (queryViewMappingIsExactMatch(mapping)) {
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

  function routePathLabel(group: DashboardMigrationRouteGroupDraft, row: DashboardMigrationTargetDraft) {
    return dashboardMigrationRoutePathLabel({
      groupName: group.name,
      destinationLabel: targetInstanceLabel(row.destinationInstanceId),
      connectionLabel: targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId),
      modelLabel: row.targetModelName || row.targetModelId || 'Model not selected',
      folderLabel: row.targetFolderPath || 'My Documents/default',
    });
  }

  function queryViewMappingRouteBlocker(row: DashboardMigrationTargetDraft) {
    if (!activeRouteGroup.targetRowIds.includes(row.id)) return '';
    const routeMappings = row.queryViewMappings || [];
    if (routeMappings.length === 0) return '';
    if (!row.targetModelId) return `Choose a destination model for route ${routePathLabel(activeRouteGroup, row)} before mapping query views.`;
    const queryViewCatalog = targetQueryViewCatalog(row);
    if (queryViewCatalog?.loading) return `Checking destination query views for route ${routePathLabel(activeRouteGroup, row)} before review.`;
    if (queryViewCatalog?.error) return `Route ${routePathLabel(activeRouteGroup, row)}: ${queryViewCatalog.error}`;
    if (!queryViewCatalog?.loaded) return `Load destination query views for route ${routePathLabel(activeRouteGroup, row)} before review.`;
    const unresolved = routeMappings.find((mapping) => !mapping.targetQueryViewName || mapping.status === 'blocked' || mapping.action === 'unresolved');
    return unresolved
      ? unresolvedQueryViewMappingRouteMessage({
          sourceQueryViewName: unresolved.sourceQueryViewName,
          groupName: activeRouteGroup.name,
          destinationLabel: targetInstanceLabel(row.destinationInstanceId),
          connectionLabel: targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId),
          modelLabel: row.targetModelName || row.targetModelId,
          folderLabel: row.targetFolderPath || 'My Documents/default',
        })
      : '';
  }

  function topicMappingRouteBlocker(row: DashboardMigrationTargetDraft) {
    if (activeRouteSourceTopics.length === 0) return '';
    if (!activeRouteGroup.targetRowIds.includes(row.id)) return '';
    if (!row.targetModelId) return `Choose a destination model for route ${routePathLabel(activeRouteGroup, row)} before mapping topics.`;
    const topicCatalog = targetTopicCatalog(row);
    if (topicCatalog?.loading) return `Checking destination topics for route ${routePathLabel(activeRouteGroup, row)} before review.`;
    if (topicCatalog?.error) return `Route ${routePathLabel(activeRouteGroup, row)}: ${topicCatalog.error}`;
    if (!topicCatalog?.loaded) return `Load destination topics for route ${routePathLabel(activeRouteGroup, row)} before review.`;
    const unresolved = (row.topicMappings || []).find((mapping) => !mapping.targetTopicName || mapping.status === 'blocked' || mapping.action === 'unresolved');
    return unresolved
      ? unresolvedTopicMappingRouteMessage({
          sourceTopicName: unresolved.sourceTopicName,
          groupName: activeRouteGroup.name,
          destinationLabel: targetInstanceLabel(row.destinationInstanceId),
          connectionLabel: targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId),
          modelLabel: row.targetModelName || row.targetModelId,
          folderLabel: row.targetFolderPath || 'My Documents/default',
        })
      : '';
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
        <div className="grid gap-2 md:grid-cols-6">
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
                <p className="mt-1 text-xs text-content-secondary">
                  Type to search long connection lists by name, warehouse/database, dialect, or audit ID.
                </p>
              </div>
              {sourceConnectionId && (
                <div className="rounded-card border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                  OmniKit will search all dashboards tied to this connection, across all folders.
                </div>
              )}
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
              {dashboardLoadStatus && (
                <p aria-live="polite" className="text-xs text-content-secondary">{dashboardLoadStatus}</p>
              )}
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
              <h2 className="text-base font-semibold text-content-primary">2. Select and group dashboards</h2>
              <p className="mt-1 text-sm text-content-secondary">
                First choose what to move. Then keep everything together or create groups when dashboards need different destinations.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={selectAllVisibleDocuments} disabled={filteredDocuments.length === 0} className="btn-secondary text-xs">Select visible</button>
              <button type="button" onClick={() => { setSelectedDocumentIds([]); resetPlan(); }} disabled={selectedDocumentIds.length === 0} className="btn-secondary text-xs">Clear</button>
            </div>
          </div>
          <div className="mt-5 rounded-card border border-border-subtle bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-content-primary">Select dashboards</h3>
                <p className="mt-1 text-xs text-content-secondary">
                  Showing dashboards from the selected source connection across all folders.
                </p>
              </div>
              <div className="text-xs text-content-secondary">
                {selectedDocumentIds.length} selected from {filteredDocuments.length} visible
              </div>
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
          {metadataEnrichmentStatus && (
            <div aria-live="polite" className="mt-3 flex flex-col gap-2 rounded-card border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800 md:flex-row md:items-center md:justify-between">
              <span>{metadataEnrichmentStatus}</span>
              {metadataEnrichmentRetryIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => void enrichSelectedDashboardMetadata(metadataEnrichmentRetryIds, { force: true })}
                  className="rounded-button border border-blue-200 bg-white px-2 py-1 font-semibold text-blue-800 hover:bg-blue-100"
                >
                  Retry metadata
                </button>
              )}
            </div>
          )}
          <div className="mt-4 max-h-[520px] overflow-auto rounded-card border border-border-subtle">
            {filteredDocuments.map((document) => {
              const selected = selectedDocumentIds.includes(document.identifier);
              const model = dashboardDocumentModelLabel(document, sourceModelNameById);
              const metadataPending = selected && documentNeedsMetadataEnrichment(document);
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
                    {metadataPending && (
                      <span className="mt-1 inline-flex rounded-chip bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
                        Checking model/topic...
                      </span>
                    )}
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
          <div className="mt-5 rounded-card border border-border-subtle bg-surface-secondary/30 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-base font-semibold text-content-primary">Organize dashboard groups</h3>
                <p className="mt-1 text-sm text-content-secondary">
                  Groups let different dashboards go to different destinations. Keep one group for simple migrations.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={keepDashboardsTogether}
                  disabled={selectedDocumentIds.length === 0}
                  className="btn-secondary text-xs"
                >
                  Keep as one group
                </button>
                <button
                  type="button"
                  onClick={autoGroupBySourceScope}
                  disabled={selectedDocumentIds.length === 0}
                  className="btn-secondary text-xs"
                >
                  Auto-group by model/topic
                </button>
              </div>
            </div>
            <div className="mt-3 rounded-card border border-border-subtle bg-white px-3 py-2 text-xs text-content-secondary">
              {selectedDocumentIds.length === 0
                ? 'Select dashboards above before creating groups.'
                : hasAdvancedDashboardGroups
                  ? `${routeGroups.length} dashboard groups are configured. Step 3 will route these groups to destinations.`
                  : 'Default grouping is active: all selected dashboards will move together unless you split them.'}
            </div>
            {shouldRecommendSourceScopeGrouping && (
              <div className="mt-3 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                <Info size={13} className="mr-1 inline-block" />
                These dashboards use {selectedSourceScopeCount} model/topic scopes. Auto-grouping by model/topic is recommended before routing them to destinations.
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {routeGroups.map((group) => {
                const mixedMessage = mixedRouteGroupSourceScopeMessage(group, documents);
                const active = group.id === activeRouteGroupId;
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setActiveRouteGroupId(group.id)}
                    className={`rounded-card border px-3 py-2 text-left text-xs ${active ? 'border-omni-300 bg-omni-50 text-omni-800' : 'border-border-subtle bg-white text-content-secondary'}`}
                  >
                    <span className="block font-semibold">{group.name}</span>
                    <span className="block">{group.documentIds.length} dashboard{group.documentIds.length === 1 ? '' : 's'}</span>
                    {mixedMessage && <span className="mt-1 block text-red-700">Mixed model/topic scope</span>}
                  </button>
                );
              })}
            </div>
            {selectedDocumentIds.length > 0 && (
              <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                <div>
                  <div className="text-sm font-semibold text-content-primary">Dashboards in selected group</div>
                  <p className="mt-1 text-xs text-content-secondary">
                    Check dashboards below when you want to create a new group or move them into the active group.
                  </p>
                  <div className="mt-2 max-h-64 overflow-auto rounded-card border border-border-subtle bg-white">
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
                  </div>
                </div>
                <div>
                  <div className="text-sm font-semibold text-content-primary">Group actions</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <button type="button" onClick={createRouteGroupFromSelection} disabled={routeSelectionIds.length === 0} className="btn-secondary text-xs">
                      Create group from checked dashboards
                    </button>
                    <button type="button" onClick={moveSelectionToActiveRouteGroup} disabled={routeSelectionIds.length === 0 || activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID} className="btn-secondary text-xs">
                      Move checked to active group
                    </button>
                    <button type="button" onClick={duplicateActiveRouteGroup} disabled={activeRouteGroup.documentIds.length === 0} className="btn-secondary text-xs">
                      Duplicate active group
                    </button>
                    <button type="button" onClick={removeActiveRouteGroup} disabled={activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID} className="btn-secondary text-xs text-red-700">
                      Remove active group
                    </button>
                  </div>
                  <div className="mt-3 rounded-card bg-white p-3 text-xs text-content-secondary">
                    Active group: <span className="font-semibold text-content-primary">{activeRouteGroup.name}</span><br />
                    {activeRouteGroup.id === DEFAULT_ROUTE_GROUP_ID
                      ? 'All selected dashboards are currently grouped together.'
                      : 'This group can be routed separately once route assignment is added in Step 3.'}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="mt-5 flex justify-between gap-3">
            <button type="button" onClick={() => setStep(0)} className="btn-secondary">Back</button>
            <button type="button" onClick={() => setStep(2)} disabled={selectedDocumentIds.length === 0} className="btn-primary">Continue to destinations</button>
          </div>
        </section>
      )}

      {(step === 2 || step === 3) && (
        <section className="space-y-5">
          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">
                  {step === 2 ? '3. Assign destinations' : '4. Resolve dependencies'}
                </h2>
                <p className="mt-1 text-sm text-content-secondary">
                  {step === 2
                    ? 'Add destinations, then choose which dashboard groups should route to each one.'
                    : 'Confirm the query views and topics OmniKit should use or create before dashboard import.'}
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

	          {step === 3 && activeAssignedQueryViewSemanticGroups.length > 0 && (
	            <div className="card p-5">
	              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
	                <div>
	                  <h2 className="text-base font-semibold text-content-primary">Query-view decisions by target model</h2>
	                  <p className="mt-1 text-sm text-content-secondary">
	                    Query views are shared by the destination model, so routes that only differ by folder use the same decisions.
	                  </p>
	                </div>
	                <div className="rounded-chip bg-surface-secondary px-3 py-1 text-xs font-semibold text-content-secondary">
	                  {activeRouteGroup.name}
	                </div>
	              </div>
	              <div className="mt-4 space-y-4">
	                {activeAssignedQueryViewSemanticGroups.map((semanticGroup) => {
	                  const row = semanticGroup.primaryRow;
	                  const queryViewCatalog = targetQueryViewCatalog(row);
	                  const routeBlocker = queryViewMappingRouteBlocker(row);
	                  const destinationLabel = semanticGroup.routeIndexes.length > 1
	                    ? `Destinations ${semanticGroup.routeIndexes.join(' & ')}`
	                    : `Destination ${semanticGroup.routeIndexes[0] || '?'}`;
	                  const routeMappings = semanticGroup.queryViewMappings;
	                  return (
	                    <div key={`query-view-route-${activeRouteGroup.id}-${semanticGroup.id}`} className="rounded-card border border-border-subtle bg-white p-4">
	                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
	                        <div className="min-w-0">
	                          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
	                            <FileText size={14} />
	                            {destinationLabel} query-view decisions
	                          </div>
	                          <div className="mt-1 truncate text-xs text-content-secondary">
	                            {dashboardMigrationRoutePathLabel({
	                              groupName: activeRouteGroup.name,
	                              destinationLabel: targetInstanceLabel(row.destinationInstanceId),
	                              connectionLabel: targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId),
	                              modelLabel: row.targetModelName || row.targetModelId || 'Model not selected',
	                              folderLabel: semanticGroup.folderLabels.length > 1
	                                ? `${semanticGroup.folderLabels.length} folders: ${semanticGroup.folderLabels.join(', ')}`
	                                : semanticGroup.folderLabels[0] || targetRouteFolderLabel(row),
	                            })}
	                          </div>
	                          {semanticGroup.rows.length > 1 && (
	                            <div className="mt-2 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
	                              One decision set applies to {semanticGroup.rows.length} folder route{semanticGroup.rows.length === 1 ? '' : 's'} in this same target model.
	                            </div>
	                          )}
	                        </div>
	                        <div className="flex flex-wrap items-center gap-2">
	                          {queryViewCatalog?.loading && (
	                            <span className="inline-flex items-center gap-1 rounded-chip bg-surface-secondary px-2 py-1 text-xs text-content-secondary">
	                              <Loader2 size={13} className="animate-spin" />
	                              Checking query views
	                            </span>
	                          )}
	                          <span className={`rounded-chip px-2 py-1 text-xs font-semibold ${routeBlocker ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
	                            {routeBlocker ? 'Needs attention' : 'Ready'}
	                          </span>
	                        </div>
	                      </div>
	                      {routeBlocker && (
	                        <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
	                          {routeBlocker}
	                        </div>
	                      )}
	                      {queryViewCatalog?.loaded && routeMappings.length > 0 && (
	                        <div className="mt-3 space-y-3">
	                          {routeMappings.map((mapping) => (
	                            <div key={`${semanticGroup.id}:${mapping.sourceFileName || mapping.sourceQueryViewName}`} className="grid gap-3 rounded-card border border-border-subtle bg-surface-primary p-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,0.8fr)_minmax(0,1.1fr)]">
	                              <div className="min-w-0">
	                                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Source query view</div>
	                                <div className="mt-1 truncate text-sm font-semibold text-content-primary">{mapping.sourceQueryViewName}</div>
	                                <div className="truncate font-mono text-xs text-content-secondary">{mapping.sourceFileName || `${mapping.sourceQueryViewName}.query.view`}</div>
	                                <span className={`mt-2 inline-flex rounded-chip px-2 py-0.5 text-[11px] font-semibold ${queryViewMappingStatus(mapping).className}`}>
	                                  {queryViewMappingStatus(mapping).label}
	                                </span>
	                              </div>
	                              <div>
	                                <div className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Action</div>
	                                <div className="inline-flex flex-wrap rounded-card border border-border-subtle bg-white p-1 text-xs">
	                                  <button
	                                    type="button"
	                                    onClick={() => updateQueryViewMapping(row, existingQueryViewMapping(row, mapping, 'map_existing'))}
	                                    disabled={!queryViewCatalog?.loaded || targetQueryViewOptions(row).length === 0}
	                                    className={`rounded-card px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${mapping.action === 'map_existing' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
	                                  >
	                                    Use existing
	                                  </button>
	                                  <button
	                                    type="button"
	                                    onClick={() => updateQueryViewMapping(row, existingQueryViewMapping(row, mapping, 'use_existing_unverified'))}
	                                    disabled={!queryViewCatalog?.loaded || targetQueryViewOptions(row).length === 0}
	                                    className={`rounded-card px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${mapping.action === 'use_existing_unverified' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
	                                  >
	                                    Use as-is
	                                  </button>
	                                  <button
	                                    type="button"
	                                    onClick={() => updateQueryViewMapping(row, createdQueryViewMapping(row, mapping, generatedQueryViewName(row, mapping)))}
	                                    disabled={!mapping.sourceFileName}
	                                    className={`rounded-card px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${mapping.action === 'copy_source' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
	                                  >
	                                    Create new
	                                  </button>
	                                  <button
	                                    type="button"
	                                    onClick={() => updateQueryViewMapping(row, existingQueryViewMapping(row, mapping, 'update_existing'))}
	                                    disabled={!mapping.sourceFileName || !queryViewCatalog?.loaded || targetQueryViewOptions(row).length === 0}
	                                    className={`rounded-card px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${mapping.action === 'update_existing' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
	                                  >
	                                    Update existing
	                                  </button>
	                                </div>
	                              </div>
	                              <div>
	                                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
	                                  {mapping.action === 'copy_source' ? 'New query-view name' : 'Target query view'}
	                                </label>
	                                {mapping.action === 'copy_source' ? (
	                                  <>
	                                    <input
	                                      type="text"
	                                      value={mapping.targetQueryViewName}
	                                      onChange={(event) => updateQueryViewMapping(row, createdQueryViewMapping(row, mapping, event.target.value))}
	                                      className="input-field text-sm"
	                                      placeholder={mapping.sourceQueryViewName}
	                                      aria-label={`New query-view name for ${mapping.sourceQueryViewName} on ${routePathLabel(activeRouteGroup, row)}`}
	                                    />
	                                    <div className="mt-1 text-xs text-content-secondary">
	                                      OmniKit will create this query view before topic preparation and dashboard import.
	                                    </div>
	                                  </>
	                                ) : (
	                                  <ComboBox
	                                    options={targetQueryViewOptions(row)}
	                                    value={mapping.targetQueryViewName}
	                                    onChange={(value) => {
	                                      const queryView = queryViewCatalog?.queryViews.find((item) => item.name === value);
	                                      updateQueryViewMapping(row, {
	                                        ...mapping,
	                                        action: mapping.action === 'use_existing_unverified' || mapping.action === 'update_existing' ? mapping.action : 'map_existing',
	                                        targetQueryViewName: value,
	                                        targetFileName: queryView?.fileName,
	                                        targetQueryViewLabel: queryView?.label,
	                                        status: value ? (mapping.action === 'use_existing_unverified' ? 'warning' : 'ready') : 'blocked',
	                                        warnings: !value
	                                          ? ['Choose an existing target query view.']
	                                          : mapping.action === 'use_existing_unverified'
	                                            ? ['Using this existing query view as-is even though compatibility checks found a mismatch.']
	                                            : undefined,
	                                      });
	                                    }}
	                                    disabled={!queryViewCatalog?.loaded || queryViewCatalog.loading}
	                                    placeholder={queryViewCatalog?.loading ? 'Checking destination query views...' : 'Select existing query view'}
	                                    allowFreeText={false}
	                                    emptyLabel={queryViewCatalog?.loaded ? 'No destination query views found for this model' : 'Choose a destination model first'}
	                                    ariaLabel={`${destinationLabel} query view for ${mapping.sourceQueryViewName} on ${activeRouteGroup.name}`}
	                                  />
	                                )}
	                              </div>
	                              <div className="lg:col-span-3">
	                                {mapping.action === 'map_existing' && mapping.targetQueryViewName && queryViewMappingIsExactMatch(mapping) && (
	                                  <div className="text-xs text-green-700">
	                                    Already matched to destination query view {mapping.targetQueryViewLabel || mapping.targetQueryViewName}.
	                                  </div>
	                                )}
	                                {mapping.action === 'map_existing' && mapping.targetQueryViewName && !queryViewMappingIsExactMatch(mapping) && (
	                                  <div className="text-xs text-green-700">Will use existing destination query view {mapping.targetQueryViewLabel || mapping.targetQueryViewName} for this route.</div>
	                                )}
	                                {mapping.action === 'use_existing_unverified' && mapping.targetQueryViewName && (
	                                  <div className="text-xs text-yellow-800">Will use existing destination query view {mapping.targetQueryViewLabel || mapping.targetQueryViewName} as-is.</div>
	                                )}
	                                {mapping.action === 'update_existing' && mapping.targetQueryViewName && (
	                                  <div className="text-xs text-blue-700">Will update existing destination query view {mapping.targetQueryViewLabel || mapping.targetQueryViewName} before topic preparation.</div>
	                                )}
	                                {mapping.action === 'copy_source' && mapping.status !== 'blocked' && (
	                                  <div className="text-xs text-green-700">Will create destination query view {mapping.targetQueryViewName} before topic preparation.</div>
	                                )}
	                                {mapping.action === 'unresolved' && (
	                                  <div className="text-xs text-red-700">Choose an existing destination query view or create a new one before review.</div>
	                                )}
	                                {!mapping.sourceFileName && (
	                                  <div className="mt-1 text-xs text-red-700">Source YAML was not found, so create-new is unavailable for this query view.</div>
	                                )}
	                                {mapping.warnings?.map((warning) => (
	                                  <div key={warning} className="mt-1 text-xs text-red-700">{warning}</div>
	                                ))}
	                              </div>
	                            </div>
	                          ))}
	                        </div>
	                      )}
	                    </div>
	                  );
	                })}
	              </div>
	            </div>
	          )}

	          {step === 2 && (
	          <>
	          <div className="card p-5">
	            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">Dashboard groups from Step 2</h2>
                <p className="mt-1 text-sm text-content-secondary">
                  These groups are fixed here. Choose a group to review topic mappings, or use the route assignment map below to decide where each group goes.
                </p>
              </div>
              <button type="button" onClick={() => setStep(1)} className="btn-secondary text-xs">
                Edit groups
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {routeGroups.map((group) => {
                const active = group.id === activeRouteGroupId;
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setActiveRouteGroupId(group.id)}
                    className={`rounded-card border px-3 py-2 text-left text-xs ${active ? 'border-omni-300 bg-omni-50 text-omni-800' : 'border-border-subtle bg-white text-content-secondary'}`}
                  >
                    <span className="block font-semibold">{group.name}</span>
                    <span className="block">{group.documentIds.length} dashboard{group.documentIds.length === 1 ? '' : 's'} · {group.targetRowIds.length} destination{group.targetRowIds.length === 1 ? '' : 's'}</span>
                  </button>
                );
              })}
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
                          onOpen={() => void loadTargetFolders(row.destinationInstanceId)}
                          onChange={(value) => chooseTargetFolder(row, value)}
                          placeholder={targetCatalog?.foldersLoading ? 'Loading destination folders...' : 'My Documents/default'}
                          emptyLabel={targetCatalog?.folderError || TARGET_FOLDER_COMBOBOX_CONFIG.emptyLabel}
                          allowFreeText={TARGET_FOLDER_COMBOBOX_CONFIG.allowFreeText}
                          ariaLabel={`Destination ${index + 1} folder`}
                        />
                      </div>
                    </div>
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
                <h2 className="text-base font-semibold text-content-primary">Route assignment</h2>
                <p className="mt-1 text-sm text-content-secondary">
                  Rows are dashboard groups. Destination cards show where each group will be copied.
                </p>
              </div>
              <button
                type="button"
                onClick={assignAllGroupsToAllDestinations}
                disabled={targetRows.length === 0 || (allGroupsRouteToAllDestinations && !routeAssignmentsCustomized)}
                className="btn-secondary text-xs"
              >
                Send all groups to all destinations
              </button>
            </div>
            <div className="mt-4 rounded-card border border-border-subtle bg-surface-secondary/50 px-3 py-2 text-xs text-content-secondary">
              {targetRows.length === 0
                ? 'Add at least one destination before assigning routes.'
                : allGroupsRouteToAllDestinations && !routeAssignmentsCustomized
                  ? 'Default routing is active: every dashboard group currently goes to every destination.'
                  : allGroupsRouteToAllDestinations
                    ? 'Every dashboard group currently goes to every destination. Use the send-all action to return to the default routing behavior.'
                    : 'Custom routing is active: each dashboard group can go to a different set of destinations.'}
            </div>
            {targetRows.length > 0 ? (
              <div className="mt-4 space-y-3">
                {routeGroups.map((group) => {
                  const assignedCount = targetRows.filter((row) => group.targetRowIds.includes(row.id)).length;
                  return (
                    <div key={group.id} className={`rounded-card border p-4 ${group.id === activeRouteGroupId ? 'border-omni-300 bg-omni-50/40' : 'border-border-subtle bg-white'}`}>
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <button
                          type="button"
                          onClick={() => setActiveRouteGroupId(group.id)}
                          className="min-w-0 text-left"
                        >
                          <span className="block text-sm font-semibold text-content-primary">{group.name}</span>
                          <span className="mt-0.5 block text-xs text-content-secondary">
                            {group.documentIds.length} dashboard{group.documentIds.length === 1 ? '' : 's'} · {assignedCount}/{targetRows.length} destination{targetRows.length === 1 ? '' : 's'}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveRouteGroupId(group.id);
                            assignGroupToAllDestinations(group.id);
                          }}
                          disabled={assignedCount === targetRows.length}
                          className="btn-secondary text-xs"
                        >
                          Send group everywhere
                        </button>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        {targetRows.map((row, index) => {
                          const assigned = group.targetRowIds.includes(row.id);
                          return (
                            <label
                              key={`${group.id}:${row.id}`}
                              className={`flex items-start gap-3 rounded-card border px-3 py-2 text-xs ${assigned ? 'border-green-200 bg-green-50 text-green-800' : 'border-border-subtle bg-surface-secondary/40 text-content-secondary'}`}
                            >
                              <input
                                type="checkbox"
                                checked={assigned}
                                onChange={(event) => {
                                  setActiveRouteGroupId(group.id);
                                  setRouteGroupTargetAssignment(group.id, row.id, event.target.checked);
                                }}
                                aria-label={`Route ${group.name} to destination ${index + 1}`}
                                className="mt-1 accent-omni-600"
                              />
                              <span className="min-w-0">
                                <span className="block font-semibold text-content-primary">Destination {index + 1}</span>
                                <span className="block truncate">{targetInstanceLabel(row.destinationInstanceId)}</span>
                                <span className="block truncate">{targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId)}</span>
                                <span className="block truncate">{row.targetModelName || row.targetModelId || 'Model not selected'}</span>
                                <span className="mt-1 block truncate text-content-secondary">{row.targetFolderPath || 'My Documents/default'}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      {assignedCount === 0 && (
                        <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          This dashboard group has no destination. Add at least one destination assignment before review.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-4 rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
                Destination cards will appear here after you add a target instance above.
              </div>
            )}
          </div>
	          </>
	          )}

          {step === 3 && (
          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">Topic decisions by target model</h2>
                <p className="mt-1 text-sm text-content-secondary">
                  Topic choices are shared by the destination model, so folder-only route duplicates use one decision set.
                </p>
              </div>
              <div className="rounded-chip bg-surface-secondary px-3 py-1 text-xs font-semibold text-content-secondary">
                {activeRouteGroup.name}
              </div>
            </div>
            <div className="mt-4 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              Some dashboards are built on topics. Keep the matching destination topic when OmniKit finds one, or create a new topic before the dashboard is copied.
            </div>
            {activeRouteSourceTopics.length === 0 ? (
              <div className="mt-4 rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                The selected dashboard group does not reference any source topics, so no topic mappings are needed for this group.
              </div>
            ) : activeAssignedTopicSemanticGroups.length === 0 ? (
              <div className="mt-4 rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                Assign {activeRouteGroup.name} to at least one destination before mapping topics.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {activeAssignedTopicSemanticGroups.map((semanticGroup) => {
                  const row = semanticGroup.primaryRow;
                  const topicCatalog = targetTopicCatalog(row);
                  const routeBlocker = topicMappingRouteBlocker(row);
                  const destinationLabel = semanticGroup.routeIndexes.length > 1
                    ? `Destinations ${semanticGroup.routeIndexes.join(' & ')}`
                    : `Destination ${semanticGroup.routeIndexes[0] || '?'}`;
                  const routeMappings = semanticGroup.topicMappings;
                  return (
                    <div key={`topic-route-${activeRouteGroup.id}-${semanticGroup.id}`} className="rounded-card border border-border-subtle bg-white p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                            <BookOpen size={14} />
                            {destinationLabel} topic decisions
                          </div>
                          <div className="mt-1 truncate text-xs text-content-secondary">
                            {dashboardMigrationRoutePathLabel({
                              groupName: activeRouteGroup.name,
                              destinationLabel: targetInstanceLabel(row.destinationInstanceId),
                              connectionLabel: targetConnectionLabel(row.destinationInstanceId, row.targetConnectionId),
                              modelLabel: row.targetModelName || row.targetModelId || 'Model not selected',
                              folderLabel: semanticGroup.folderLabels.length > 1
                                ? `${semanticGroup.folderLabels.length} folders: ${semanticGroup.folderLabels.join(', ')}`
                                : semanticGroup.folderLabels[0] || targetRouteFolderLabel(row),
                            })}
                          </div>
                          {semanticGroup.rows.length > 1 && (
                            <div className="mt-2 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                              One decision set applies to {semanticGroup.rows.length} folder route{semanticGroup.rows.length === 1 ? '' : 's'} in this same target model.
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {topicCatalog?.loading && (
                            <span className="inline-flex items-center gap-1 rounded-chip bg-surface-secondary px-2 py-1 text-xs text-content-secondary">
                              <Loader2 size={13} className="animate-spin" />
                              Checking topics
                            </span>
                          )}
                          <span className={`rounded-chip px-2 py-1 text-xs font-semibold ${routeBlocker ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                            {routeBlocker ? 'Needs attention' : routeMappings.length > 0 ? 'Ready' : 'No topic action'}
                          </span>
                        </div>
                      </div>
                      {routeBlocker && (
                        <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {routeBlocker}
                        </div>
                      )}
                      {topicCatalog?.loaded && routeMappings.length > 0 && (
                        <div className="mt-3 space-y-3">
                          {routeMappings.map((mapping) => (
                            <div key={`${semanticGroup.id}:${mapping.sourceTopicId || mapping.sourceTopicName}`} className="grid gap-3 rounded-card border border-border-subtle bg-surface-primary p-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,0.8fr)_minmax(0,1.1fr)]">
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
                                <div className="inline-flex rounded-card border border-border-subtle bg-white p-1 text-xs">
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
                                      aria-label={`New topic name for ${mapping.sourceTopicName} on ${routePathLabel(activeRouteGroup, row)}`}
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
                                    ariaLabel={`${destinationLabel} topic for ${mapping.sourceTopicName} on ${activeRouteGroup.name}`}
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
                                  <div className="text-xs text-green-700">Will use existing destination topic {mapping.targetTopicLabel || mapping.targetTopicName} for this route.</div>
                                )}
                                {mapping.action === 'copy_source' && mapping.status !== 'blocked' && (
                                  <div className="text-xs text-green-700">Will create destination topic {mapping.targetTopicName} before dashboard import, then point this route to it.</div>
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
                        </div>
                      )}
                      {topicCatalog?.loaded && routeMappings.length === 0 && !routeBlocker && (
                        <div className="mt-3 rounded-card border border-dashed border-border-subtle p-3 text-xs text-content-secondary">
                          No topic mappings are needed for this route.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {step === 3 && planRows.length === 0 && (
            <div className="card p-5">
              <h2 className="text-base font-semibold text-content-primary">Check readiness to find dependencies</h2>
              <p className="mt-1 text-sm text-content-secondary">
                OmniKit needs to preview the route before it can detect query views, relationships, topics, and replacement work.
              </p>
              <div className="mt-4 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                Use the readiness button below. If dependencies are found, they will appear here as a checklist to resolve.
              </div>
            </div>
          )}

          {step === 3 && planRows.length > 0 && activeAssignedQueryViewSemanticGroups.length === 0 && activeRouteSourceTopics.length === 0 && (
            <div className="card p-5">
              <h2 className="text-base font-semibold text-content-primary">No semantic dependencies need choices</h2>
              <p className="mt-1 text-sm text-content-secondary">
                OmniKit did not detect query views or topics that need manual mapping for the selected dashboard group.
              </p>
              <div className="mt-4 rounded-card border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                This route can move straight to Review after the readiness check completes.
              </div>
            </div>
          )}

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
              <h3 className="text-base font-semibold text-content-primary">
                {step === 2 ? 'Readiness check' : 'Dependency readiness'}
              </h3>
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
                <button type="button" onClick={() => setStep(step === 3 ? 2 : 1)} className="btn-secondary">
                  {step === 3 ? 'Back to destinations' : 'Back'}
                </button>
                <div className="flex flex-col items-end gap-2">
                  <button type="button" onClick={runPreflight} disabled={!canPreflight} className="btn-primary inline-flex items-center gap-2">
                    {preflightLoading ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                    {step === 3 ? 'Recheck readiness' : 'Check readiness'}
                  </button>
                  {preflightStatus && <p aria-live="polite" className="max-w-sm text-right text-xs text-content-secondary">{preflightStatus}</p>}
                  {preflightBlockReason && !preflightLoading && <p className="max-w-sm text-right text-xs text-content-secondary">{preflightBlockReason}</p>}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="grid gap-5 lg:grid-cols-[1fr_0.62fr]">
          <div className="card p-5">
            <h2 className="text-base font-semibold text-content-primary">5. Review impact</h2>
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
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-8">
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.dashboardCount}</span><br />Dashboards</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.destinationCount}</span><br />Destinations</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.replacementCount}</span><br />Replacements</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{refreshSchemaOnComplete ? 'On' : 'Off'}</span><br />Schema refresh</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{deleteSourceOnSuccess ? 'On' : 'Off'}</span><br />Source delete</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.queryViewActionCount || 'None'}</span><br />Query-view actions</div>
                <div className="rounded-card bg-white p-2"><span className="font-semibold">{reviewImpactSummary.relationshipActionCount || 'None'}</span><br />Relationship actions</div>
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
            <div className="mt-4 rounded-card border border-border-subtle bg-white p-4">
              <h3 className="text-sm font-semibold text-content-primary">What will happen</h3>
              <ol className="mt-3 space-y-2 text-sm text-content-secondary">
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">1</span>
                  <span>OmniKit exports the selected source dashboards from the chosen connection.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">2</span>
                  <span>For each route, OmniKit prepares required query views, relationships, and topics before import.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">3</span>
                  <span>
                    {targetDeleteCount > 0
                      ? `${targetDeleteCount} existing target dashboard${targetDeleteCount === 1 ? '' : 's'} will be moved to Trash in scoped target folders before import.`
                      : replaceSameNamed
                        ? 'Same-name replacement is on, but no scoped target replacements were found in this preview.'
                        : 'Same-name replacement is off, so existing target dashboards will not be touched.'}
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">4</span>
                  <span>Dashboards are imported into each configured destination connection, model, and folder.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">5</span>
                  <span>
                    {refreshSchemaOnComplete
                      ? 'Schema refresh is queued for the selected target models after import.'
                      : 'Schema refresh is off.'}
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">6</span>
                  <span>
                    {deleteSourceOnSuccess
                      ? 'Source dashboards are moved to Trash only after every route succeeds and selected post-actions do not fail.'
                      : 'Source delete is off, so the original dashboards stay where they are.'}
                  </span>
                </li>
              </ol>
            </div>
            <div className="mt-4 rounded-card border border-border-subtle bg-white p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-content-primary">Route map</h3>
                  <p className="mt-1 text-xs text-content-secondary">
                    Each card shows one dashboard group moving to one configured destination.
                  </p>
                </div>
                <div className="rounded-chip bg-surface-secondary px-3 py-1 text-xs font-semibold text-content-secondary">
                  {routeReviewGroups.reduce((sum, route) => sum + route.targets.length, 0)} route{routeReviewGroups.reduce((sum, route) => sum + route.targets.length, 0) === 1 ? '' : 's'}
                </div>
              </div>
              {routeReviewGroups.length > 0 ? (
                <div className="mt-4 grid gap-3 xl:grid-cols-2">
                  {routeReviewGroups.flatMap((route) => route.targets.map((routeTarget) => {
                    const target = routeTarget.target;
                    const destinationLabel = target.destinationLabel || target.destinationInstanceId;
                    const connectionRouteLabel = targetConnectionLabel(target.destinationInstanceId, target.targetConnectionId);
                    const modelRouteLabel = target.targetModelName || target.targetModelId || 'Model not selected';
                    const folderRouteLabel = target.targetFolderPath || 'Default';
                    const routePath = dashboardMigrationRoutePathLabel({
                      groupName: route.name,
                      destinationLabel,
                      connectionLabel: connectionRouteLabel,
                      modelLabel: modelRouteLabel,
                      folderLabel: folderRouteLabel,
                    });
                    const routeBlocked = route.status === 'blocked' || routeTarget.status === 'blocked';
                    const sourceDeleteLabel = !deleteSourceOnSuccess
                      ? 'Off'
                      : routeBlocked
                        ? 'Blocked'
                        : 'Eligible after all routes succeed';
                    const replacementLabel = routeTarget.replaceCount > 0
                      ? `${routeTarget.replaceCount} same-name replacement${routeTarget.replaceCount === 1 ? '' : 's'}`
                      : routeTarget.deleteCount > 0
                        ? `${routeTarget.deleteCount} target Trash move${routeTarget.deleteCount === 1 ? '' : 's'}`
                        : 'None';
                    const queryViewActionLabel = routeTarget.queryViewActionCount > 0
                      ? `${routeTarget.queryViewActionCount} query-view action${routeTarget.queryViewActionCount === 1 ? '' : 's'}`
                      : 'None';
                    const relationshipActionLabel = routeTarget.relationshipActionCount > 0
                      ? `${routeTarget.relationshipActionCount} relationship action${routeTarget.relationshipActionCount === 1 ? '' : 's'}`
                      : 'None';
                    const topicActionLabel = routeTarget.topicActionCount > 0
                      ? `${routeTarget.topicActionCount} topic action${routeTarget.topicActionCount === 1 ? '' : 's'}`
                      : 'None';
                    const schemaRefreshLabel = refreshSchemaOnComplete ? 'Queued after import' : 'Off';
                    const routeBlocker = routeTarget.error || (routeBlocked ? 'This route has a blocker in the migration plan.' : '');
                    const visibleWarnings = routeTarget.warnings.slice(0, 2);
                    const visibleNotices = routeTarget.notices.slice(0, 2);
                    return (
                      <div key={`route-map:${route.id}:${target.id}`} className={`rounded-card border p-4 ${routeBlocked ? 'border-red-200 bg-red-50/40' : routeTarget.warningCount > 0 ? 'border-yellow-200 bg-yellow-50/40' : 'border-border-subtle bg-surface-secondary/30'}`}>
                        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-content-primary">{route.name}</div>
                            <div className="mt-1 truncate text-xs text-content-secondary">{routePath}</div>
                          </div>
                          <StatusChip
                            status={routeBlocked ? 'failed' : routeTarget.status}
                            label={routeBlocked ? 'Blocked' : routeTarget.status === 'ready' ? 'Ready' : `${routeTarget.warningCount} warning${routeTarget.warningCount === 1 ? '' : 's'}`}
                          />
                        </div>
                        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{route.dashboardCount}</span><br />
                            Dashboard{route.dashboardCount === 1 ? '' : 's'} in group
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{destinationLabel}</span><br />
                            Destination instance
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{connectionRouteLabel}</span><br />
                            Connection
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{modelRouteLabel}</span><br />
                            Model
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{folderRouteLabel}</span><br />
                            Folder
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{queryViewActionLabel}</span><br />
                            Query-view action summary
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{relationshipActionLabel}</span><br />
                            Relationship action summary
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{topicActionLabel}</span><br />
                            Topic action summary
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{replacementLabel}</span><br />
                            Replacement summary
                          </div>
                          <div className="rounded-card bg-white p-2">
                            <span className="font-semibold">{schemaRefreshLabel}</span><br />
                            Schema refresh
                          </div>
                          <div className="rounded-card bg-white p-2 sm:col-span-2">
                            <span className="font-semibold">{sourceDeleteLabel}</span><br />
                            Source delete eligibility
                          </div>
                        </div>
                        {(routeBlocker || visibleWarnings.length > 0 || visibleNotices.length > 0) && (
                          <div className="mt-3 space-y-2">
                            {routeBlocker && (
                              <div className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                                <AlertTriangle size={13} className="mr-1 inline-block" />
                                {routeBlocker}
                              </div>
                            )}
                            {visibleWarnings.map((warning) => (
                              <div key={`route-map-warning:${route.id}:${target.id}:${warning}`} className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                                <AlertTriangle size={13} className="mr-1 inline-block" />
                                {warning}
                              </div>
                            ))}
                            {routeTarget.warnings.length > visibleWarnings.length && (
                              <div className="text-xs text-content-secondary">
                                {routeTarget.warnings.length - visibleWarnings.length} more warning{routeTarget.warnings.length - visibleWarnings.length === 1 ? '' : 's'} in the detailed route card below.
                              </div>
                            )}
                            {visibleNotices.map((notice) => (
                              <div key={`route-map-notice:${route.id}:${target.id}:${notice}`} className="rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                                <Info size={13} className="mr-1 inline-block" />
                                {notice}
                              </div>
                            ))}
                            {routeTarget.notices.length > visibleNotices.length && (
                              <div className="text-xs text-content-secondary">
                                {routeTarget.notices.length - visibleNotices.length} more notice{routeTarget.notices.length - visibleNotices.length === 1 ? '' : 's'} in the detailed route card below.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }))}
                </div>
              ) : (
                <div className="mt-4 rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                  Run the readiness check from the Destinations step to build the route map.
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
                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-10">
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.dashboardCount}</span><br />Dashboards</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.targetCount}</span><br />Destinations</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.replaceCount}</span><br />Replacements</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{refreshSchemaOnComplete ? 'Yes' : 'No'}</span><br />Schema refresh</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{sourceDeleteLabel}</span><br />Source delete</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.queryViewActionCount || 'None'}</span><br />Query-view actions</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{route.relationshipActionCount || 'None'}</span><br />Relationships</div>
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
                            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-8">
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.dashboardCount}</span><br />Dashboards</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.deleteCount}</span><br />Trash moves</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.replaceCount}</span><br />Replacements</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.queryViewActionCount || 'None'}</span><br />Query-view actions</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.relationshipActionCount || 'None'}</span><br />Relationships</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.topicActionCount || 'None'}</span><br />Topic actions</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.warningCount}</span><br />Warnings</div>
                              <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{routeTarget.noticeCount}</span><br />Notices</div>
                            </div>
                            {routeTarget.queryViewActions.length > 0 && (
                              <div className="mt-3 space-y-2">
                                {routeTarget.queryViewActions.map((action) => (
                                  <div key={`query-view:${action.routeGroupId || route.id}:${action.documentId || 'document'}`} className="rounded-card border border-border-subtle bg-surface-secondary/50 px-3 py-2">
                                    <div className="flex flex-col gap-1 text-xs text-content-secondary sm:flex-row sm:items-center sm:justify-between">
                                      <span>
                                        <span className="font-semibold text-content-primary">{action.documentName || action.documentId || 'Dashboard'}</span>
                                      </span>
                                      <span className={action.blocked ? 'font-semibold text-red-700' : 'font-semibold text-green-700'}>
                                        {action.blocked ? 'Blocked' : 'Ready'}
                                      </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1">
                                      {action.queryViewMappings.map((mapping) => (
                                        <span key={`${mapping.sourceFileName || mapping.sourceQueryViewName}:${mapping.action}:${mapping.targetFileName || mapping.targetQueryViewName}`} className="rounded-chip bg-white px-2 py-0.5 text-[11px] font-semibold text-content-secondary">
	                                          {mapping.action === 'copy_source'
	                                            ? 'Create'
	                                            : mapping.action === 'update_existing'
	                                              ? 'Update'
	                                              : mapping.action === 'use_existing_unverified'
	                                                ? 'Use as-is'
	                                                : 'Use'} {mapping.sourceQueryViewName} -&gt; {mapping.targetQueryViewLabel || mapping.targetQueryViewName}
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
                            {routeTarget.relationshipActions.length > 0 && (
                              <div className="mt-3 space-y-2">
                                {routeTarget.relationshipActions.map((action) => (
                                  <div key={`relationship:${action.routeGroupId || route.id}:${action.documentId || 'document'}`} className="rounded-card border border-border-subtle bg-surface-secondary/50 px-3 py-2">
                                    <div className="flex flex-col gap-1 text-xs text-content-secondary sm:flex-row sm:items-center sm:justify-between">
                                      <span>
                                        <span className="font-semibold text-content-primary">{action.documentName || action.documentId || 'Dashboard'}</span>
                                      </span>
                                      <span className={action.blocked ? 'font-semibold text-red-700' : 'font-semibold text-green-700'}>
                                        {action.blocked ? 'Blocked' : 'Ready'}
                                      </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1">
                                      {action.relationshipEdges.map((edge) => (
                                        <span key={`${edge.joinFromView}:${edge.joinToView}:${edge.relationshipType || edge.joinType || 'relationship'}`} className="rounded-chip bg-white px-2 py-0.5 text-[11px] font-semibold text-content-secondary">
                                          Link {edge.joinFromView} -&gt; {edge.joinToView}
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
                <button type="button" onClick={() => setStep(3)} className="btn-secondary">Back to dependencies</button>
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

      {step === 5 && (
        <section className="space-y-5">
          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">6. Run and results</h2>
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
                {jobDone && (
                  <div className={`rounded-card border p-4 ${failedItems.length > 0 ? 'border-red-200 bg-red-50/40' : warningItems.length > 0 || job.status === 'partial' ? 'border-yellow-200 bg-yellow-50/40' : 'border-green-200 bg-green-50/40'}`}>
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <h3 className="text-base font-semibold text-content-primary">
                          {failedItems.length > 0
                            ? 'Migration needs attention'
                            : warningItems.length > 0 || job.status === 'partial'
                              ? 'Migration landed with warnings'
                              : 'Landed successfully'}
                        </h3>
                        <p className="mt-1 text-sm text-content-secondary">
                          {failedItems.length > 0
                            ? `${failedItems.length} step${failedItems.length === 1 ? '' : 's'} failed. Open the item log below for the exact route and retry details.`
                            : 'The selected dashboards finished their route. Review the target links below, then open the dashboard in Omni when you are ready.'}
                        </p>
                      </div>
                      <StatusChip
                        status={failedItems.length > 0 ? 'failed' : warningItems.length > 0 || job.status === 'partial' ? 'warning' : 'success'}
                        label={failedItems.length > 0 ? 'Needs attention' : warningItems.length > 0 || job.status === 'partial' ? 'Warnings' : 'Complete'}
                      />
                    </div>
                    <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
                      <div className="rounded-card bg-white p-3">
                        <span className="font-semibold text-content-primary">{importItems.length}</span><br />
                        Dashboard import route{importItems.length === 1 ? '' : 's'}
                      </div>
                      <div className="rounded-card bg-white p-3">
                        <span className="font-semibold text-content-primary">{queryViewPrepareItems.length ? terminalCount(queryViewPrepareItems) : 'None'}</span><br />
                        Query views prepared
                      </div>
                      <div className="rounded-card bg-white p-3">
                        <span className="font-semibold text-content-primary">{relationshipPrepareItems.length ? terminalCount(relationshipPrepareItems) : 'None'}</span><br />
                        Relationships prepared
                      </div>
                      <div className="rounded-card bg-white p-3">
                        <span className="font-semibold text-content-primary">{topicPrepareItems.length ? terminalCount(topicPrepareItems) : 'None'}</span><br />
                        Topics prepared
                      </div>
                      <div className="rounded-card bg-white p-3">
                        <span className="font-semibold text-content-primary">{sourceDeleteItems.length ? terminalCount(sourceDeleteItems) : 'Off'}</span><br />
                        Source delete
                      </div>
                    </div>
                    {importedDashboardLinks.length > 0 && (
                      <div className="mt-4">
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Open target dashboards</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {importedDashboardLinks.map((link) => (
                            link.url ? (
                              <a
                                key={link.id}
                                href={link.url}
                                target="_blank"
                                rel="noreferrer"
                                className="btn-secondary inline-flex items-center gap-2 text-xs"
                              >
                                <ExternalLink size={13} />
                                {link.label} · {link.destinationLabel}
                              </a>
                            ) : (
                              <span key={link.id} className="rounded-chip bg-white px-3 py-1 text-xs font-semibold text-content-secondary">
                                {link.label} · {link.destinationLabel}
                              </span>
                            )
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="grid gap-3 lg:grid-cols-8">
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
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Query views</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{queryViewPrepareItems.length ? `${terminalCount(queryViewPrepareItems)}/${queryViewPrepareItems.length}` : 'None'}</div>
                  </div>
                  <div className="rounded-card border border-border-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Relationships</div>
                    <div className="mt-2 text-xl font-semibold text-content-primary">{relationshipPrepareItems.length ? `${terminalCount(relationshipPrepareItems)}/${relationshipPrepareItems.length}` : 'None'}</div>
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
                <details open={failedItems.length > 0} className="rounded-card border border-border-subtle">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-content-primary">Item log</summary>
                  <div className="max-h-[420px] overflow-auto border-t border-border-subtle">
	                    {job.items.map((item) => {
	                      const auditLines = semanticAuditLines(item);
	                      const warningGroups = groupedItemMessages(item.warnings);
	                      const noticeGroups = groupedItemMessages(item.notices);
	                      return (
	                        <div key={item.id} className="border-b border-border-subtle px-4 py-3 text-xs last:border-b-0">
	                          <div className="flex items-start justify-between gap-2">
	                            <span>
	                              <span className="font-semibold text-content-primary">{kindLabel(item.kind)}</span>
	                              <span className="ml-2 text-content-secondary">{item.destinationLabel} · {item.documentName || item.targetModelName || item.documentId || 'Step'}</span>
	                            </span>
	                            <span className={`rounded-chip px-2 py-0.5 font-semibold ${statusClass(item.status)}`}>{item.status}</span>
	                          </div>
	                          {item.importedIdentifier && <div className="mt-1 font-mono text-content-secondary">Imported: {item.importedIdentifier}</div>}
	                          {auditLines.map((line) => <div key={line} className="mt-1 text-green-700">{line}</div>)}
	                          {warningGroups.map((group) => (
	                            <div key={group.message} className="mt-1 text-yellow-700">
	                              {group.message}
	                              {group.count > 1 && <span className="ml-1 font-semibold">({group.count} occurrences)</span>}
	                            </div>
	                          ))}
	                          {noticeGroups.map((group) => (
	                            <div key={group.message} className="mt-1 text-blue-700">
	                              {group.message}
	                              {group.count > 1 && <span className="ml-1 font-semibold">({group.count} occurrences)</span>}
	                            </div>
	                          ))}
	                          {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
	                        </div>
	                      );
	                    })}
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
