import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  PlayCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
  Workflow,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { DashboardDependencyReviewPanel } from '@/components/dashboardMigration/DashboardDependencyReviewPanel';
import { DashboardRepairFileDiff } from '@/components/dashboardMigration/DashboardTopicRepairReview';
import { SavedInstanceRequiredEmptyState } from '@/components/layout/RequireConnection';
import { Blobby } from '@/components/ui/Blobby';
import { useConnection } from '@/hooks/useConnection';
import { useLogOperation } from '@/hooks/useOperationLog';
import {
  cancelOpsMigrationJob,
  createModelMigratorJob,
  getVaultStatus,
  getMigrationJob,
  listModelMigratorConnections,
  listModelMigratorModels,
  listSavedInstances,
  listInstanceDocuments,
  loadModelMigratorInventory,
  loadModelMigratorReadiness,
  mergeModelMigratorJob,
  preflightModelMigratorWorkbooks,
  retryOpsMigrationJob,
  subscribeMigrationJob,
  translateModelMigratorYaml,
  type InstanceModel,
  type InstanceDocument,
  type ModelMigratorConnection,
  type ModelMigratorContentRepairAction,
  type ModelMigratorInventoryDocument,
  type ModelMigratorInventoryRow,
  type ModelMigratorJobContentInput,
  type ModelMigratorSemanticDecision,
  type ModelMigratorReadiness,
  type ModelMigratorReadinessPair,
  type ModelMigratorTranslatedFile,
  type ModelMigratorWorkbookPreflight,
  type MigrationJob,
  type MigrationJobItem,
  type PostMigrationAction,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import {
  sanitizeModelMigratorDraftForStorage,
} from '@/services/modelMigratorDraft';
import {
  dashboardDeploymentModelMigratorHandoffFromSearch,
  dashboardSafeCopyModelMigratorHandoffMatchesJob,
  parseDashboardDeploymentModelMigratorHandoff,
  parseDashboardSafeCopyModelMigratorHandoff,
  resolveDashboardDeploymentModelMigratorHandoff,
  resolveDashboardSafeCopyModelMigratorHandoff,
  scopeDashboardModelRepairTranslation,
  type DashboardModelRepairScope,
  type DashboardSafeCopyModelMigratorHandoff,
} from '@/services/modelMigratorHandoff';
import { getDashboardDeploymentPlan, linkDashboardModelRepair } from '@/services/dashboardDeploymentPlans';
import {
  parseSchemaMappingRows,
  recommendModelMigrationStrategy,
  scoreTargetModelMatch,
  serializeSchemaMappingRows,
  type SchemaMappingRow,
} from '@/services/modelMigratorAdvisor';

const MODEL_MIGRATOR_DRAFT_KEY = 'omnikit:modelMigratorDraft:v1';
const WIZARD_STEPS = ['Source', 'Target match', 'Migration path', 'Resolve differences', 'Content impact', 'Publish', 'Results'];
const WORKBOOK_FIDELITY_DISCLOSURE = 'Workbook migration ports query presentations, tab names, descriptions, and visConfig where Omni APIs expose them. Schedules, alerts, permissions, sharing, favorites, workbook-level filters or parameters, and unexposed workbook artifacts are not moved automatically.';
const SOURCE_MODEL_PAGE_SIZE = 100;
const INVENTORY_DEBOUNCE_MS = 250;
const READINESS_DEBOUNCE_MS = 250;

type ModelPath = 'fast' | 'translate' | 'impact_report';

interface TranslationState {
  files: ModelMigratorTranslatedFile[];
  checksums: Record<string, string>;
  semanticDecisions: ModelMigratorSemanticDecision[];
  prompts: Array<{ fileName: string; prompt: string }>;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isAbortFailure(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>) {
  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  return leftEntries.length === rightKeys.length
    && leftEntries.every(([key, value]) => right[key] === value);
}

function modelMigratorReadinessFingerprint(input: {
  sourceInstanceId: string;
  targetInstanceId: string;
  selectedSourceModelIds: string[];
  targetModelBySourceId: Record<string, string>;
}) {
  const sourceInstanceId = input.sourceInstanceId.trim();
  const targetInstanceId = input.targetInstanceId.trim();
  const sourceModelIds = [...new Set(input.selectedSourceModelIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (!sourceInstanceId || !targetInstanceId || sourceModelIds.length === 0) return '';
  const pairs = sourceModelIds.map((sourceModelId) => [
    sourceModelId,
    (input.targetModelBySourceId[sourceModelId] || '').trim(),
  ] as const);
  if (pairs.some(([, targetModelId]) => !targetModelId)) return '';
  return JSON.stringify([sourceInstanceId, targetInstanceId, pairs]);
}

function readinessInputFromFingerprint(fingerprint: string) {
  const [sourceInstanceId, targetInstanceId, pairs] = JSON.parse(fingerprint) as [
    string,
    string,
    Array<[string, string]>,
  ];
  return {
    sourceInstanceId,
    targetInstanceId,
    sourceModelIds: pairs.map(([sourceModelId]) => sourceModelId),
    targetModelBySourceId: Object.fromEntries(pairs),
  };
}

function roleLabel(role: SavedInstancePublic['role']) {
  if (role === 'both') return 'Source + destination';
  return role === 'source' ? 'Source' : 'Destination';
}

function hostLabel(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function connectionLabel(connection: ModelMigratorConnection) {
  const database = connection.database ? ` · ${connection.database}` : '';
  return `${connection.name || connection.id}${database}`;
}

function modelLabel(model: InstanceModel) {
  const identifier = model.identifier && model.identifier !== model.name ? ` · ${model.identifier}` : '';
  return `${model.name || model.id}${identifier}`;
}

function shortDate(value?: string) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString();
}

function selectedModelName(models: InstanceModel[], id: string) {
  return models.find((model) => model.id === id)?.name || id;
}

function modelSupportsFastPath(model: InstanceModel) {
  return model.gitConfigured === true;
}

function modelRequiresMergeHandoff(model?: InstanceModel) {
  return Boolean(model?.pullRequestRequired || model?.gitProtected);
}

function diffLineClass(original: string | undefined, translated: string | undefined) {
  if (original === translated) return 'text-content-secondary';
  if (original === undefined) return 'bg-green-50 text-green-800';
  if (translated === undefined) return 'bg-red-50 text-red-800';
  return 'bg-amber-50 text-amber-900';
}

function fileDraft(file: ModelMigratorTranslatedFile) {
  return file.aiDraft || file.translated || file.deterministic || file.original;
}

function reviewLines(value: string | undefined) {
  return (value || '').split('\n');
}

function statusCounts(job: MigrationJob) {
  return {
    succeeded: job.items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length,
    failed: job.items.filter((item) => item.status === 'failed').length,
  };
}

function modelItemLogDescription(item: MigrationJobItem): string | null {
  if (!['succeeded', 'failed', 'warning'].includes(item.status)) return null;
  const subject = item.documentName || item.targetModelName || item.targetModelId || 'step';
  if (item.kind === 'model_validate') return `Model validation ${item.status}: ${subject}`;
  if (item.kind === 'content_validate') return `Content validation ${item.status}: ${subject}`;
  if (item.kind === 'model_impact_report') return `Impact report ${item.status}: ${subject}`;
  if (item.kind === 'content_repair') return `Content repair ${item.status}: ${subject}`;
  if (item.kind === 'model_pr') return `Model pull request ${item.status}: ${subject}`;
  if (item.kind === 'model_merge') return `Model branch merge ${item.status}: ${subject}`;
  if (item.kind === 'workbook_create') return `Workbook create ${item.status}: ${subject}`;
  if (item.kind === 'import') return `Dashboard import ${item.status}: ${subject}`;
  if (item.kind === 'post_action') return `Post-action ${item.status}: ${subject}`;
  return null;
}

function jobCanMerge(job: MigrationJob | null) {
  if (!job || job.workflow !== 'model') return false;
  if (job.items.some((item) => item.kind === 'model_merge' || item.kind === 'model_pr')) return false;
  const validations = job.items.filter((item) => item.kind === 'model_validate');
  return validations.length > 0
    && validations.every((item) => item.status === 'succeeded')
    && ['succeeded', 'partial'].includes(job.status);
}

function readinessTone(status?: 'ready' | 'warning' | 'blocked' | 'unknown') {
  if (status === 'ready') return 'border-green-200 bg-green-50 text-green-800';
  if (status === 'warning') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (status === 'blocked') return 'border-red-200 bg-red-50 text-red-800';
  return 'border-border-subtle bg-surface-secondary text-content-secondary';
}

function readinessLabel(status?: 'ready' | 'warning' | 'blocked' | 'unknown') {
  if (status === 'ready') return 'Ready';
  if (status === 'warning') return 'Review';
  if (status === 'blocked') return 'Blocked';
  return 'Checking';
}

function confidenceTone(confidence: 'strong' | 'likely' | 'manual') {
  if (confidence === 'strong') return 'bg-green-50 text-green-700';
  if (confidence === 'likely') return 'bg-blue-50 text-blue-700';
  return 'bg-surface-secondary text-content-secondary';
}

function defaultBranchName(model: InstanceModel) {
  const base = (model.identifier || model.name || model.id)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `omnikit-model-migration-${base || 'model'}`;
}

function contentKey(document: ModelMigratorInventoryDocument) {
  return `${document.kind}:${document.id}`;
}

function documentMatchesSearch(document: ModelMigratorInventoryDocument, search: string) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [document.name, document.id, document.folderPath, document.kind].filter(Boolean).join(' ').toLowerCase().includes(value);
}

function canUseAsSource(instance: SavedInstancePublic) {
  return instance.role === 'source' || instance.role === 'both';
}

function canUseAsTarget(instance: SavedInstancePublic) {
  return instance.role === 'destination' || instance.role === 'both';
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-content-secondary">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="input-field"
      >
        {children}
      </select>
    </label>
  );
}

function EmptyValue({ children }: { children: React.ReactNode }) {
  return <option value="">{children}</option>;
}

function StepPill({ index, label, active }: { index: number; label: string; active: boolean }) {
  return (
    <div className={`rounded-card border px-3 py-2 ${active ? 'border-omni-200 bg-omni-50 text-omni-800' : 'border-border-subtle bg-white text-content-secondary'}`}>
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${active ? 'bg-omni-600 text-white' : 'bg-surface-secondary text-content-tertiary'}`}>
          {index}
        </span>
        <span className="text-xs font-semibold">{label}</span>
      </div>
    </div>
  );
}

function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border-subtle bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
      <Loader2 size={13} className="animate-spin" />
      {label}
    </div>
  );
}

export function ModelMigratorPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { connection } = useConnection();
  const logOperation = useLogOperation();
  const activeVaultInstanceId = connection.connectionMode === 'vault' ? connection.instanceId || '' : '';
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceInstanceId, setSourceInstanceId] = useState('');
  const [targetInstanceId, setTargetInstanceId] = useState('');
  const [sourceConnections, setSourceConnections] = useState<ModelMigratorConnection[]>([]);
  const [targetConnections, setTargetConnections] = useState<ModelMigratorConnection[]>([]);
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [targetConnectionId, setTargetConnectionId] = useState('');
  const [sourceModels, setSourceModels] = useState<InstanceModel[]>([]);
  const [targetModels, setTargetModels] = useState<InstanceModel[]>([]);
  const [selectedSourceModelIds, setSelectedSourceModelIds] = useState<string[]>([]);
  const [targetModelBySourceId, setTargetModelBySourceId] = useState<Record<string, string>>({});
  const [inventory, setInventory] = useState<ModelMigratorInventoryRow[]>([]);
  const [loadingVault, setLoadingVault] = useState(true);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [loadingReadiness, setLoadingReadiness] = useState(false);
  const [readinessError, setReadinessError] = useState('');
  const [readinessResultFingerprint, setReadinessResultFingerprint] = useState('');
  const [readinessRefreshToken, setReadinessRefreshToken] = useState(0);
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);
  const [sourceModelDisplayLimit, setSourceModelDisplayLimit] = useState(SOURCE_MODEL_PAGE_SIZE);
  const [translating, setTranslating] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [startingJob, setStartingJob] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [schemaMapText, setSchemaMapText] = useState('');
  const [contentSearch, setContentSearch] = useState('');
  const [selectedContentKeys, setSelectedContentKeys] = useState<string[]>([]);
  const [pathByModelId, setPathByModelId] = useState<Record<string, ModelPath>>({});
  const [branchNameByModelId, setBranchNameByModelId] = useState<Record<string, string>>({});
  const [gitRefByModelId, setGitRefByModelId] = useState<Record<string, string>>({});
  const [fastPathConfirmedByModelId, setFastPathConfirmedByModelId] = useState<Record<string, boolean>>({});
  const [translationsByModelId, setTranslationsByModelId] = useState<Record<string, TranslationState>>({});
  const [acceptedFilesByModelId, setAcceptedFilesByModelId] = useState<Record<string, Record<string, string>>>({});
  const [viewedDashboardFiles, setViewedDashboardFiles] = useState<string[]>([]);
  const [skippedFilesByModelId, setSkippedFilesByModelId] = useState<Record<string, string[]>>({});
  const [approvedRepairDecisionIds, setApprovedRepairDecisionIds] = useState<string[]>([]);
  const [workbookPreflights, setWorkbookPreflights] = useState<ModelMigratorWorkbookPreflight[]>([]);
  const [readiness, setReadiness] = useState<ModelMigratorReadiness | null>(null);
  const [replaceSameNamed, setReplaceSameNamed] = useState(true);
  const [runAiDialectPass, setRunAiDialectPass] = useState(false);
  const [publishDrafts, setPublishDrafts] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [refreshSchemaAfterMigration, setRefreshSchemaAfterMigration] = useState(false);
  const [selectedPostActionIndexes, setSelectedPostActionIndexes] = useState<number[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const dashboardRepairHandoff = useRef(
    dashboardDeploymentModelMigratorHandoffFromSearch(location.search)
    || parseDashboardDeploymentModelMigratorHandoff(location.state),
  );
  const dashboardRepairRequested = useRef(Boolean(
    new URLSearchParams(location.search).has('planId')
    || new URLSearchParams(location.search).has('targetId')
    || (location.state && typeof location.state === 'object' && location.state.source === 'dashboard_deployment_plan'),
  )).current;
  const [dashboardRepairScope, setDashboardRepairScope] = useState<DashboardModelRepairScope | null>(null);
  const [loadingDashboardRepair, setLoadingDashboardRepair] = useState(dashboardRepairRequested);
  const [dashboardReviewDocuments, setDashboardReviewDocuments] = useState<{ scopeKey: string; documents: InstanceDocument[]; unavailable: boolean }>({ scopeKey: '', documents: [], unavailable: false });
  const loggedTerminalJobs = useRef(new Set<string>());
  const loggedItemEvents = useRef(new Set<string>());
  const pendingSafeCopyHandoff = useRef<DashboardSafeCopyModelMigratorHandoff | null>(
    parseDashboardSafeCopyModelMigratorHandoff(location.state),
  );
  const safeCopyHandoffWasPresent = useRef(Boolean(
    location.state
    && typeof location.state === 'object'
    && !Array.isArray(location.state)
    && (location.state as Record<string, unknown>).source === 'dashboard_safe_copy_v1',
  ));
  const safeCopyHandoffHandled = useRef(false);
  const safeCopyHandoffApplying = useRef(false);
  const safeCopyHandoffManualRevision = useRef(0);
  const safeCopyHandoffAppliedRevision = useRef<number | null>(null);
  const requestSequences = useRef({
    sourceConnections: 0,
    targetConnections: 0,
    sourceModels: 0,
    targetModels: 0,
    inventory: 0,
    readiness: 0,
  });
  const catalogScopes = useRef({
    sourceConnections: '',
    targetConnections: '',
    sourceModels: '',
    targetModels: '',
  });
  const handledCatalogRefreshes = useRef({
    sourceConnections: 0,
    targetConnections: 0,
    sourceModels: 0,
    targetModels: 0,
    inventory: 0,
  });
  const handledReadinessRefresh = useRef(0);
  const jobActive = job?.status === 'pending' || job?.status === 'running';
  const scopeControlsLocked = jobActive || dashboardRepairRequested;

  const sourceInstances = useMemo(() => instances.filter(canUseAsSource), [instances]);
  const targetInstances = useMemo(() => instances.filter(canUseAsTarget), [instances]);
  const selectedSourceModels = useMemo(
    () => sourceModels.filter((model) => selectedSourceModelIds.includes(model.id)),
    [sourceModels, selectedSourceModelIds],
  );
  const displayedSourceModels = useMemo(
    () => sourceModels.slice(0, sourceModelDisplayLimit),
    [sourceModelDisplayLimit, sourceModels],
  );
  const inventoryByModel = useMemo(
    () => new Map(inventory.map((row) => [row.modelId, row])),
    [inventory],
  );
  const totals = useMemo(() => inventory.reduce((sum, row) => ({
    dashboardCount: sum.dashboardCount + row.dashboardCount,
    workbookCount: sum.workbookCount + row.workbookCount,
    unknownCount: sum.unknownCount + row.unknownCount,
  }), { dashboardCount: 0, workbookCount: 0, unknownCount: 0 }), [inventory]);
  const allDocuments = useMemo(() => inventory.flatMap((row) => (
    row.documents.map((document) => ({ ...document, sourceModelId: row.modelId }))
  )), [inventory]);
  const visibleDocuments = useMemo(() => allDocuments.filter((document) => documentMatchesSearch(document, contentSearch)), [allDocuments, contentSearch]);
  const selectedDocuments = useMemo(() => dashboardRepairRequested ? [] : allDocuments.filter((document) => selectedContentKeys.includes(contentKey(document))), [allDocuments, dashboardRepairRequested, selectedContentKeys]);
  const selectedWorkbookDocs = selectedDocuments.filter((document) => document.kind === 'workbook');
  const selectedDashboardDocs = selectedDocuments.filter((document) => document.kind === 'dashboard');
  const translateReviewComplete = selectedSourceModels.every((model) => {
    if ((pathByModelId[model.id] || 'translate') === 'fast') return true;
    if ((pathByModelId[model.id] || 'translate') === 'impact_report') return true;
    const translation = translationsByModelId[model.id];
    if (!translation?.files.length) return false;
    if (dashboardRepairRequested && translation.files.some((file) => file.blocked || file.additiveStatus === 'conflict' || file.targetOriginal === undefined || (file.additiveStatus !== 'unchanged' && !file.reviewToken))) return false;
    const accepted = acceptedFilesByModelId[model.id] || {};
    if (dashboardRepairRequested) {
      return translation.files.every((file) => file.additiveStatus === 'unchanged'
        || accepted[file.fileName] === (file.deterministic || file.translated));
    }
    const skipped = new Set(skippedFilesByModelId[model.id] || []);
    return Object.keys(accepted).length > 0
      && translation.files.every((file) => file.blocked === true || accepted[file.fileName] !== undefined || skipped.has(file.fileName));
  }) && (!dashboardRepairRequested || selectedSourceModels.some((model) => acceptedFilesForModel(model.id).length > 0));
  const targetInstance = targetInstances.find((instance) => instance.id === targetInstanceId);
  const selectedSourceConnection = sourceConnections.find((row) => row.id === sourceConnectionId);
  const selectedTargetConnection = targetConnections.find((row) => row.id === targetConnectionId);
  const readinessFingerprint = useMemo(() => modelMigratorReadinessFingerprint({
    sourceInstanceId,
    targetInstanceId,
    selectedSourceModelIds,
    targetModelBySourceId,
  }), [selectedSourceModelIds, sourceInstanceId, targetInstanceId, targetModelBySourceId]);
  const readinessPendingMessage = useMemo(() => {
    if (!sourceInstanceId || !targetInstanceId) {
      return 'Choose a source and target instance to prepare a readiness check.';
    }
    if (selectedSourceModelIds.length === 0) {
      return 'Select at least one source model. Readiness checks begin only after you choose what to migrate.';
    }
    const unmappedCount = selectedSourceModelIds.filter((modelId) => !(targetModelBySourceId[modelId] || '').trim()).length;
    if (unmappedCount > 0) {
      return `Choose a target model for ${unmappedCount} selected source model${unmappedCount === 1 ? '' : 's'} before checking readiness.`;
    }
    return 'The model pairing is complete. OmniKit is preparing one scoped readiness check.';
  }, [selectedSourceModelIds, sourceInstanceId, targetInstanceId, targetModelBySourceId]);
  const readinessPairBySourceId = useMemo(() => new Map((readiness?.pairs || []).map((pair) => [pair.sourceModelId, pair])), [readiness]);
  const targetMatchBySourceId = useMemo(() => {
    const out: Record<string, ReturnType<typeof scoreTargetModelMatch>> = {};
    for (const sourceModel of selectedSourceModels) {
      const targetModel = targetModels.find((model) => model.id === targetModelBySourceId[sourceModel.id]);
      if (!targetModel) continue;
      out[sourceModel.id] = scoreTargetModelMatch(
        sourceModel,
        targetModel,
        selectedSourceConnection,
        selectedTargetConnection,
        readinessPairBySourceId.get(sourceModel.id)?.schemaOverlap,
      );
    }
    return out;
  }, [readinessPairBySourceId, selectedSourceModels, selectedSourceConnection, selectedTargetConnection, targetModelBySourceId, targetModels]);
  const strategyBySourceId = useMemo(() => {
    const out: Record<string, ReturnType<typeof recommendModelMigrationStrategy>> = {};
    for (const sourceModel of selectedSourceModels) {
      const targetModel = targetModels.find((model) => model.id === targetModelBySourceId[sourceModel.id]);
      out[sourceModel.id] = recommendModelMigrationStrategy({
        sourceModel,
        targetModel,
        sourceConnection: selectedSourceConnection,
        targetConnection: selectedTargetConnection,
        readinessPair: readinessPairBySourceId.get(sourceModel.id),
        contentSelected: selectedDocuments.some((document) => document.sourceModelId === sourceModel.id),
      });
    }
    return out;
  }, [readinessPairBySourceId, selectedDocuments, selectedSourceConnection, selectedSourceModels, selectedTargetConnection, targetModelBySourceId, targetModels]);
  const schemaMappingRows = useMemo(() => parseSchemaMappingRows(schemaMapText), [schemaMapText]);
  const reviewSummary = useMemo(() => {
    const semanticDecisionCount = selectedSourceModels.reduce((sum, model) => (
      sum + (translationsByModelId[model.id]?.semanticDecisions.length || 0)
    ), 0);
    const approvedRepairCount = selectedSourceModels.reduce((sum, model) => (
      sum + contentRepairActionsForModel(model.id).length
    ), 0);
    const impactOnlyCount = selectedSourceModels.filter((model) => (pathByModelId[model.id] || 'translate') === 'impact_report').length;
    const prHandoffCount = selectedSourceModels.filter((model) => {
      const targetModel = targetModels.find((row) => row.id === targetModelBySourceId[model.id]);
      return modelRequiresMergeHandoff(targetModel);
    }).length;
    return {
      semanticDecisionCount,
      approvedRepairCount,
      impactOnlyCount,
      prHandoffCount,
    };
  // contentRepairActionsForModel intentionally derives from dependencies below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvedRepairDecisionIds, pathByModelId, selectedSourceModels, targetModelBySourceId, targetModels, translationsByModelId]);
  const selectedPostMigrationActions = useMemo(() => {
    const actions: PostMigrationAction[] = [];
    if (dashboardRepairRequested) return actions;
    if (refreshSchemaAfterMigration) {
      for (const sourceModel of selectedSourceModels) {
        const targetModelId = targetModelBySourceId[sourceModel.id];
        if (!targetModelId || !targetInstance) continue;
        const targetModel = targetModels.find((model) => model.id === targetModelId);
        actions.push({
          kind: 'refresh-schema',
          name: `${targetInstance.label}: refresh schema model ${targetModel?.name || targetModelId}`,
          method: 'POST',
          url: '',
          headers: {},
          body: '',
          destinationInstanceId: targetInstance.id,
          targetModelId,
          targetModelName: targetModel?.name || targetModelId,
        });
      }
    }
    if (targetInstance) {
      for (const actionIndex of selectedPostActionIndexes) {
        const action = targetInstance.postMigrationActions[actionIndex];
        if (!action) continue;
        actions.push({
          ...action,
          name: `${targetInstance.label}: ${action.name}`,
          destinationInstanceId: targetInstance.id,
        });
      }
    }
    return actions;
  }, [dashboardRepairRequested, refreshSchemaAfterMigration, selectedPostActionIndexes, selectedSourceModels, targetInstance, targetModelBySourceId, targetModels]);
  const workbookBlockerCount = workbookPreflights.reduce((sum, row) => sum + row.blockerCount, 0);
  const canStartJob = selectedSourceModels.length > 0
    && (!dashboardRepairRequested || Boolean(dashboardRepairScope && !dashboardRepairScope.scopeReviewRequired && !loadingDashboardRepair
      && !dashboardRepairScope.readiness.repairJobId
      && sourceInstanceId === dashboardRepairScope.sourceInstanceId && sourceConnectionId === dashboardRepairScope.sourceConnectionId
      && targetInstanceId === dashboardRepairScope.targetInstanceId && targetConnectionId === dashboardRepairScope.targetConnectionId
      && sameStringArray([...selectedSourceModelIds].sort(), [...dashboardRepairScope.sourceModelIds].sort())
      && selectedSourceModels.every((model) => pathByModelId[model.id] === 'translate'
        && targetModelBySourceId[model.id] === dashboardRepairScope.targetModelId)))
    && selectedSourceModels.every((model) => targetModelBySourceId[model.id])
    && selectedSourceModels.every((model) => branchNameByModelId[model.id]?.trim())
    && selectedSourceModels.every((model) => pathByModelId[model.id] !== 'fast' || (modelSupportsFastPath(model) && fastPathConfirmedByModelId[model.id] === true))
    && translateReviewComplete
    && workbookBlockerCount === 0
    && Boolean(readinessFingerprint)
    && readinessResultFingerprint === readinessFingerprint
    && readinessRefreshToken === handledReadinessRefresh.current
    && !loadingReadiness
    && !readinessError
    && (readiness?.summary.status === 'ready' || readiness?.summary.status === 'warning')
    && !jobActive
    && !startingJob;
  async function refreshVault() {
    setLoadingVault(true);
    setError('');
    try {
      const status = await getVaultStatus();
      setVaultStatus(status);
      if (status.unlocked) await refreshInstances();
    } catch (err) {
      setError(errorText(err, 'Failed to read vault status.'));
    } finally {
      setLoadingVault(false);
    }
  }

  async function refreshInstances() {
    setLoadingInstances(true);
    try {
      const result = await listSavedInstances();
      setInstances(result.instances);
    } catch (err) {
      setError(errorText(err, 'Failed to load saved instances.'));
    } finally {
      setLoadingInstances(false);
    }
  }

  function refreshWorkflow() {
    setError('');
    setCatalogRefreshToken((current) => current + 1);
    if (readinessFingerprint) setReadinessRefreshToken((current) => current + 1);
    void refreshInstances();
  }

  const clearModelScopedWorkflowState = useCallback(() => {
    setSelectedSourceModelIds((current) => current.length === 0 ? current : []);
    setTargetModelBySourceId((current) => Object.keys(current).length === 0 ? current : {});
    setInventory((current) => current.length === 0 ? current : []);
    setSelectedContentKeys((current) => current.length === 0 ? current : []);
    setPathByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setBranchNameByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setGitRefByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setFastPathConfirmedByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setTranslationsByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setAcceptedFilesByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setViewedDashboardFiles([]);
    setSkippedFilesByModelId((current) => Object.keys(current).length === 0 ? current : {});
    setApprovedRepairDecisionIds((current) => current.length === 0 ? current : []);
    setWorkbookPreflights((current) => current.length === 0 ? current : []);
  }, []);

  const clearTargetScopedWorkflowState = useCallback(() => {
    setTargetModelBySourceId((current) => Object.keys(current).length === 0 ? current : {});
    setWorkbookPreflights((current) => current.length === 0 ? current : []);
    setSelectedPostActionIndexes((current) => current.length === 0 ? current : []);
  }, []);

  useEffect(() => {
    if (!activeVaultInstanceId) {
      setVaultStatus(null);
      setInstances([]);
      setLoadingVault(false);
      return;
    }
    void refreshVault();
    // Runs when the workflow opens or the active saved instance changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVaultInstanceId]);

  useEffect(() => {
    if (typeof window === 'undefined' || dashboardRepairRequested) return;
    try {
      const raw = window.sessionStorage.getItem(MODEL_MIGRATOR_DRAFT_KEY);
      if (!raw) return;
      const parsed = sanitizeModelMigratorDraftForStorage(JSON.parse(raw));
      setSchemaMapText(parsed.schemaMapText || '');
      setSelectedContentKeys(Array.isArray(parsed.selectedContentKeys) ? parsed.selectedContentKeys : []);
      setPathByModelId(parsed.pathByModelId || {});
      setBranchNameByModelId(parsed.branchNameByModelId || {});
      setGitRefByModelId(parsed.gitRefByModelId || {});
      setFastPathConfirmedByModelId(parsed.fastPathConfirmedByModelId || {});
      setTranslationsByModelId(parsed.translationsByModelId || {});
      setAcceptedFilesByModelId(parsed.acceptedFilesByModelId || {});
      setSkippedFilesByModelId(parsed.skippedFilesByModelId || {});
      setApprovedRepairDecisionIds(Array.isArray(parsed.approvedRepairDecisionIds) ? parsed.approvedRepairDecisionIds : []);
      setReplaceSameNamed(parsed.replaceSameNamed !== false);
      setRunAiDialectPass(parsed.runAiDialectPass === true);
      setPublishDrafts(parsed.publishDrafts === true);
      setDeleteBranch(parsed.deleteBranch !== false);
      setRefreshSchemaAfterMigration(parsed.refreshSchemaAfterMigration === true);
      setSelectedPostActionIndexes([]);
    } catch {
      // Draft restore is convenience only.
    }
  }, [dashboardRepairRequested]);

  useEffect(() => {
    if (!dashboardRepairRequested || loadingInstances || instances.length === 0) return;
    const handoff = dashboardRepairHandoff.current;
    if (!handoff) {
      setLoadingDashboardRepair(false);
      setError('The dashboard dependency repair handoff is invalid. Return to dashboard deployment to choose its target.');
      return;
    }
    const controller = new AbortController();
    setLoadingDashboardRepair(true);
    void (async () => {
      try {
        const { plan } = await getDashboardDeploymentPlan(handoff.planId, controller.signal);
        if (controller.signal.aborted) return;
        const scope = resolveDashboardDeploymentModelMigratorHandoff(handoff, plan, instances);
        clearModelScopedWorkflowState();
        setDashboardRepairScope(scope);
        setSourceInstanceId(scope.sourceInstanceId);
        setTargetInstanceId(scope.targetInstanceId);
        setReplaceSameNamed(false);
        setPublishDrafts(false);
        setDeleteBranch(false);
        setRefreshSchemaAfterMigration(false);
        setSelectedPostActionIndexes([]);
        setSchemaMapText('');
        setError('');
        navigate(`/models/migrate?${new URLSearchParams({ planId: handoff.planId, targetId: handoff.targetId })}`, { replace: true, state: null });
        if (scope.readiness.repairJobId) {
          try {
            const result = await getMigrationJob(scope.readiness.repairJobId);
            if (!controller.signal.aborted) setJob(result.job);
          } catch {
            if (!controller.signal.aborted) setError('The saved repair job could not be loaded. Recheck the deployment plan before starting another repair.');
          }
        }
      } catch (repairError) {
        if (!controller.signal.aborted) {
          setDashboardRepairScope(null);
          setError(errorText(repairError, 'The dashboard dependency repair plan could not be loaded.'));
        }
      } finally {
        if (!controller.signal.aborted) setLoadingDashboardRepair(false);
      }
    })();
    return () => controller.abort();
  }, [clearModelScopedWorkflowState, dashboardRepairRequested, instances, loadingInstances, navigate]);

  // Names are display context only; they never authorize or change the plan.
  const repairDocumentScopeKey = dashboardRepairScope && dashboardRepairScope.documentIds.length === 1
    ? JSON.stringify([dashboardRepairScope.sourceInstanceId, dashboardRepairScope.sourceConnectionId, dashboardRepairScope.documentIds[0]])
    : '';
  useEffect(() => {
    if (!repairDocumentScopeKey) return;
    const controller = new AbortController();
    const [instanceId, connectionId, documentId] = JSON.parse(repairDocumentScopeKey) as [string, string, string];
    void listInstanceDocuments(instanceId, { connectionId, allFolders: true, documentIds: [documentId], signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const matches = result.documents.filter((doc) => (doc.identifier || doc.id) === documentId && doc.connectionId === connectionId);
        setDashboardReviewDocuments({ scopeKey: repairDocumentScopeKey, documents: matches.length === 1 ? matches : [], unavailable: matches.length !== 1 });
      })
      .catch(() => {
        if (!controller.signal.aborted) setDashboardReviewDocuments({ scopeKey: repairDocumentScopeKey, documents: [], unavailable: true });
      });
    return () => controller.abort();
  }, [repairDocumentScopeKey]);

  useEffect(() => {
    if (dashboardRepairRequested) return;
    if (safeCopyHandoffHandled.current || safeCopyHandoffApplying.current || loadingInstances) return;
    if (!safeCopyHandoffWasPresent.current) return;
    const handoff = pendingSafeCopyHandoff.current;
    if (!handoff) {
      safeCopyHandoffHandled.current = true;
      setError('The dashboard repair handoff was invalid and was not applied.');
      navigate('/models/migrate', { replace: true, state: null });
      return;
    }
    if (instances.length === 0) return;
    const revision = safeCopyHandoffManualRevision.current;
    safeCopyHandoffApplying.current = true;
    void (async () => {
      try {
        const resolved = resolveDashboardSafeCopyModelMigratorHandoff(handoff, instances);
        if (resolved.status !== 'ready' || !resolved.handoff) {
          throw new Error(resolved.message || 'The dashboard repair handoff is no longer valid.');
        }
        const sourceJob = (await getMigrationJob(handoff.jobId)).job;
        if (safeCopyHandoffManualRevision.current !== revision) return;
        if (!dashboardSafeCopyModelMigratorHandoffMatchesJob(handoff, sourceJob)) {
          throw new Error('The dashboard repair target no longer matches its safe-copy job.');
        }
        setSourceInstanceId(handoff.sourceInstanceId);
        setTargetInstanceId(handoff.targetInstanceId);
        setReplaceSameNamed(false);
        setPublishDrafts(false);
        setDeleteBranch(false);
        setRefreshSchemaAfterMigration(false);
        setSelectedPostActionIndexes([]);
        setSelectedContentKeys([]);
        setSchemaMapText('');
        safeCopyHandoffAppliedRevision.current = revision;
        safeCopyHandoffHandled.current = true;
        setError('');
        setMessage('Loaded the failed dashboard target as a non-destructive Model Migrator planning scope. Choose the source model to review the repair.');
      } catch (handoffError) {
        pendingSafeCopyHandoff.current = null;
        safeCopyHandoffHandled.current = true;
        setError(errorText(handoffError, 'The dashboard repair handoff could not be applied safely.'));
      } finally {
        safeCopyHandoffApplying.current = false;
        navigate('/models/migrate', { replace: true, state: null });
      }
    })();
  }, [dashboardRepairRequested, instances, loadingInstances, navigate]);

  useEffect(() => {
    if (typeof window === 'undefined' || dashboardRepairRequested) return;
    const draft = {
      schemaMapText,
      selectedContentKeys,
      pathByModelId,
      branchNameByModelId,
      gitRefByModelId,
      fastPathConfirmedByModelId,
      translationsByModelId,
      acceptedFilesByModelId,
      skippedFilesByModelId,
      approvedRepairDecisionIds,
      replaceSameNamed,
      runAiDialectPass,
      publishDrafts,
      deleteBranch,
      refreshSchemaAfterMigration,
      // Saved post-actions are write-bearing and must be chosen again for each target scope.
      selectedPostActionIndexes: [],
    };
    try {
      window.sessionStorage.setItem(MODEL_MIGRATOR_DRAFT_KEY, JSON.stringify(sanitizeModelMigratorDraftForStorage(draft)));
    } catch {
      // Draft persistence is best-effort.
    }
  }, [dashboardRepairRequested, schemaMapText, selectedContentKeys, pathByModelId, branchNameByModelId, gitRefByModelId, fastPathConfirmedByModelId, translationsByModelId, acceptedFilesByModelId, skippedFilesByModelId, approvedRepairDecisionIds, replaceSameNamed, runAiDialectPass, publishDrafts, deleteBranch, refreshSchemaAfterMigration]);

  useEffect(() => {
    if (dashboardRepairRequested) return;
    const preferredSource = sourceInstances.find((instance) => instance.id === activeVaultInstanceId) || sourceInstances[0];
    const nextSourceInstanceId = sourceInstances.some((instance) => instance.id === sourceInstanceId)
      ? sourceInstanceId
      : preferredSource?.id || '';
    if (nextSourceInstanceId !== sourceInstanceId) setSourceInstanceId(nextSourceInstanceId);

    const nextTargetInstanceId = targetInstances.some((instance) => instance.id === targetInstanceId)
      ? targetInstanceId
      : targetInstances.find((instance) => instance.id !== nextSourceInstanceId)?.id || targetInstances[0]?.id || '';
    if (nextTargetInstanceId !== targetInstanceId) setTargetInstanceId(nextTargetInstanceId);
  }, [activeVaultInstanceId, dashboardRepairRequested, sourceInstanceId, sourceInstances, targetInstanceId, targetInstances]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequences.current.sourceConnections;
    const isLatestScope = () => (
      sequence === requestSequences.current.sourceConnections && !controller.signal.aborted
    );
    const scopeChanged = catalogScopes.current.sourceConnections !== sourceInstanceId;
    catalogScopes.current.sourceConnections = sourceInstanceId;

    if (scopeChanged) {
      setSourceConnections((current) => current.length === 0 ? current : []);
      setSourceConnectionId((current) => current ? '' : current);
      setSourceModels((current) => current.length === 0 ? current : []);
      clearModelScopedWorkflowState();
    }
    if (!sourceInstanceId) {
      setLoadingSource(false);
      return () => {
        controller.abort();
      };
    }

    const forceRefresh = catalogRefreshToken > handledCatalogRefreshes.current.sourceConnections;
    handledCatalogRefreshes.current.sourceConnections = catalogRefreshToken;
    setLoadingSource(true);
    listModelMigratorConnections(sourceInstanceId, controller.signal, { forceRefresh })
      .then((result) => {
        if (!isLatestScope()) return;
        setSourceConnections(result.connections);
        setSourceConnectionId((current) => (
          dashboardRepairScope
            ? result.connections.some((connection) => connection.id === dashboardRepairScope.sourceConnectionId)
              ? dashboardRepairScope.sourceConnectionId : ''
            : pendingSafeCopyHandoff.current?.sourceInstanceId === sourceInstanceId
            && safeCopyHandoffAppliedRevision.current === safeCopyHandoffManualRevision.current
            ? result.connections.some((connection) => connection.id === pendingSafeCopyHandoff.current?.sourceConnectionId)
              ? pendingSafeCopyHandoff.current.sourceConnectionId
              : ''
            : result.connections.some((connection) => connection.id === current)
            ? current
            : result.connections[0]?.id || ''
        ));
        if (
          (dashboardRepairScope || pendingSafeCopyHandoff.current?.sourceInstanceId === sourceInstanceId)
          && !result.connections.some((connection) => connection.id === (dashboardRepairScope?.sourceConnectionId || pendingSafeCopyHandoff.current?.sourceConnectionId))
        ) setError('The dashboard repair source connection is no longer available.');
      })
      .catch((err) => {
        if (isLatestScope() && !isAbortFailure(err)) setError(errorText(err, 'Failed to load source connections.'));
      })
      .finally(() => {
        if (isLatestScope()) setLoadingSource(false);
      });
    return () => {
      controller.abort();
    };
  }, [catalogRefreshToken, clearModelScopedWorkflowState, dashboardRepairScope, sourceInstanceId]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequences.current.targetConnections;
    const isLatestScope = () => (
      sequence === requestSequences.current.targetConnections && !controller.signal.aborted
    );
    const scopeChanged = catalogScopes.current.targetConnections !== targetInstanceId;
    catalogScopes.current.targetConnections = targetInstanceId;

    if (scopeChanged) {
      setTargetConnections((current) => current.length === 0 ? current : []);
      setTargetConnectionId((current) => current ? '' : current);
      setTargetModels((current) => current.length === 0 ? current : []);
      clearTargetScopedWorkflowState();
    }
    if (!targetInstanceId) {
      setLoadingTarget(false);
      return () => {
        controller.abort();
      };
    }

    const forceRefresh = catalogRefreshToken > handledCatalogRefreshes.current.targetConnections;
    handledCatalogRefreshes.current.targetConnections = catalogRefreshToken;
    setLoadingTarget(true);
    listModelMigratorConnections(targetInstanceId, controller.signal, { forceRefresh })
      .then((result) => {
        if (!isLatestScope()) return;
        setTargetConnections(result.connections);
        setTargetConnectionId((current) => (
          dashboardRepairScope
            ? result.connections.some((connection) => connection.id === dashboardRepairScope.targetConnectionId)
              ? dashboardRepairScope.targetConnectionId : ''
            : pendingSafeCopyHandoff.current?.targetInstanceId === targetInstanceId
            && safeCopyHandoffAppliedRevision.current === safeCopyHandoffManualRevision.current
            ? result.connections.some((connection) => connection.id === pendingSafeCopyHandoff.current?.targetConnectionId)
              ? pendingSafeCopyHandoff.current.targetConnectionId
              : ''
            : result.connections.some((connection) => connection.id === current)
            ? current
            : result.connections[0]?.id || ''
        ));
        if (
          (dashboardRepairScope || pendingSafeCopyHandoff.current?.targetInstanceId === targetInstanceId)
          && !result.connections.some((connection) => connection.id === (dashboardRepairScope?.targetConnectionId || pendingSafeCopyHandoff.current?.targetConnectionId))
        ) setError('The dashboard repair target connection is no longer available.');
      })
      .catch((err) => {
        if (isLatestScope() && !isAbortFailure(err)) setError(errorText(err, 'Failed to load target connections.'));
      })
      .finally(() => {
        if (isLatestScope()) setLoadingTarget(false);
      });
    return () => {
      controller.abort();
    };
  }, [catalogRefreshToken, clearTargetScopedWorkflowState, dashboardRepairScope, targetInstanceId]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequences.current.sourceModels;
    const isLatestScope = () => sequence === requestSequences.current.sourceModels && !controller.signal.aborted;
    const scope = JSON.stringify([sourceInstanceId, sourceConnectionId]);
    const scopeChanged = catalogScopes.current.sourceModels !== scope;
    catalogScopes.current.sourceModels = scope;

    if (scopeChanged) {
      setSourceModels((current) => current.length === 0 ? current : []);
      setSourceModelDisplayLimit(SOURCE_MODEL_PAGE_SIZE);
      clearModelScopedWorkflowState();
    }
    if (!sourceInstanceId || !sourceConnectionId) {
      setLoadingSource(false);
      return () => {
        controller.abort();
      };
    }

    const forceRefresh = catalogRefreshToken > handledCatalogRefreshes.current.sourceModels;
    handledCatalogRefreshes.current.sourceModels = catalogRefreshToken;
    setLoadingSource(true);
    listModelMigratorModels(sourceInstanceId, {
      connectionId: sourceConnectionId,
      forceRefresh,
      signal: controller.signal,
    })
      .then((result) => {
        if (!isLatestScope()) return;
        setSourceModels(result.models);
        if (dashboardRepairScope && dashboardRepairScope.sourceModelIds.some((id) => (
          !result.models.some((model) => model.id === id && model.connectionId === sourceConnectionId)
        ))) setError('A required source model is no longer available on the deployment plan source connection.');
      })
      .catch((err) => {
        if (isLatestScope() && !isAbortFailure(err)) setError(errorText(err, 'Failed to load source models.'));
      })
      .finally(() => {
        if (isLatestScope()) setLoadingSource(false);
      });
    return () => {
      controller.abort();
    };
  }, [catalogRefreshToken, clearModelScopedWorkflowState, dashboardRepairScope, sourceConnectionId, sourceInstanceId]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequences.current.targetModels;
    const isLatestScope = () => sequence === requestSequences.current.targetModels && !controller.signal.aborted;
    const scope = JSON.stringify([targetInstanceId, targetConnectionId]);
    const scopeChanged = catalogScopes.current.targetModels !== scope;
    catalogScopes.current.targetModels = scope;

    if (scopeChanged) {
      setTargetModels((current) => current.length === 0 ? current : []);
      clearTargetScopedWorkflowState();
    }
    if (!targetInstanceId || !targetConnectionId) {
      setLoadingTarget(false);
      return () => {
        controller.abort();
      };
    }

    const forceRefresh = catalogRefreshToken > handledCatalogRefreshes.current.targetModels;
    handledCatalogRefreshes.current.targetModels = catalogRefreshToken;
    setLoadingTarget(true);
    listModelMigratorModels(targetInstanceId, {
      connectionId: targetConnectionId,
      forceRefresh,
      signal: controller.signal,
    })
      .then((result) => {
        if (!isLatestScope()) return;
        setTargetModels(result.models);
        const handoff = dashboardRepairScope || pendingSafeCopyHandoff.current;
        if (
          handoff
          && handoff.targetInstanceId === targetInstanceId
          && handoff.targetConnectionId === targetConnectionId
          && !result.models.some((model) => model.id === handoff.targetModelId && model.connectionId === targetConnectionId)
        ) setError('The dashboard repair target model is no longer available on its expected connection.');
      })
      .catch((err) => {
        if (isLatestScope() && !isAbortFailure(err)) setError(errorText(err, 'Failed to load target models.'));
      })
      .finally(() => {
        if (isLatestScope()) setLoadingTarget(false);
      });
    return () => {
      controller.abort();
    };
  }, [catalogRefreshToken, clearTargetScopedWorkflowState, dashboardRepairScope, targetConnectionId, targetInstanceId]);

  useEffect(() => {
    setSelectedSourceModelIds((current) => {
      const next = (dashboardRepairScope?.sourceModelIds || current).filter((id) => sourceModels.some((model) => model.id === id));
      return sameStringArray(current, next) ? current : next;
    });
  }, [dashboardRepairScope, sourceModels]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const sourceModel of selectedSourceModels) {
      if (dashboardRepairScope) {
        next[sourceModel.id] = targetModels.some((model) => model.id === dashboardRepairScope.targetModelId && model.connectionId === dashboardRepairScope.targetConnectionId)
          ? dashboardRepairScope.targetModelId : '';
        continue;
      }
      const existing = targetModelBySourceId[sourceModel.id];
      if (existing && targetModels.some((model) => model.id === existing)) {
        next[sourceModel.id] = existing;
        continue;
      }
      const handoffTargetModelId = pendingSafeCopyHandoff.current?.targetModelId;
      if (
        selectedSourceModels.length === 1
        && handoffTargetModelId
        && safeCopyHandoffAppliedRevision.current === safeCopyHandoffManualRevision.current
      ) {
        next[sourceModel.id] = targetModels.some((model) => model.id === handoffTargetModelId)
          ? handoffTargetModelId
          : '';
        continue;
      }
      const ranked = targetModels
        .map((model) => ({
          model,
          match: scoreTargetModelMatch(sourceModel, model, selectedSourceConnection, selectedTargetConnection),
        }))
        .sort((a, b) => b.match.score - a.match.score);
      next[sourceModel.id] = ranked[0]?.match.score >= 35 ? ranked[0].model.id : '';
    }
    if (sameStringRecord(targetModelBySourceId, next)) return;
    setSelectedPostActionIndexes([]);
    setTargetModelBySourceId(next);
  }, [dashboardRepairScope, selectedSourceModels, selectedSourceConnection, selectedTargetConnection, targetModelBySourceId, targetModels]);

  useEffect(() => {
    setPathByModelId((current) => {
      const next: Record<string, ModelPath> = {};
      for (const model of selectedSourceModels) next[model.id] = dashboardRepairRequested ? 'translate' : current[model.id] || 'translate';
      return sameStringRecord(current, next) ? current : next;
    });
    setBranchNameByModelId((current) => {
      const next: Record<string, string> = {};
      for (const model of selectedSourceModels) next[model.id] = current[model.id] || defaultBranchName(model);
      return sameStringRecord(current, next) ? current : next;
    });
  }, [dashboardRepairRequested, selectedSourceModels]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequences.current.inventory;
    const isLatestScope = () => sequence === requestSequences.current.inventory && !controller.signal.aborted;
    const modelIds = [...new Set(selectedSourceModelIds.map((modelId) => modelId.trim()).filter(Boolean))].sort();

    if (dashboardRepairRequested || !sourceInstanceId || modelIds.length === 0) {
      setInventory((current) => current.length === 0 ? current : []);
      setLoadingInventory(false);
      return () => {
        controller.abort();
      };
    }

    const forceRefresh = catalogRefreshToken > handledCatalogRefreshes.current.inventory;
    setLoadingInventory(true);
    const timer = setTimeout(() => {
      handledCatalogRefreshes.current.inventory = catalogRefreshToken;
      loadModelMigratorInventory(sourceInstanceId, modelIds, {
        forceRefresh,
        signal: controller.signal,
      })
        .then((result) => {
          if (isLatestScope()) setInventory(result.models);
        })
        .catch((err) => {
          if (isLatestScope() && !isAbortFailure(err)) setError(errorText(err, 'Failed to load source content inventory.'));
        })
        .finally(() => {
          if (isLatestScope()) setLoadingInventory(false);
        });
    }, INVENTORY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [catalogRefreshToken, dashboardRepairRequested, selectedSourceModelIds, sourceInstanceId]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequences.current.readiness;
    const isLatestScope = () => sequence === requestSequences.current.readiness && !controller.signal.aborted;

    setReadiness(null);
    setReadinessError('');
    setReadinessResultFingerprint('');
    if (!readinessFingerprint) {
      setLoadingReadiness(false);
      return () => {
        controller.abort();
      };
    }

    const forceRefresh = readinessRefreshToken > handledReadinessRefresh.current;
    handledReadinessRefresh.current = readinessRefreshToken;
    setLoadingReadiness(true);
    const timer = setTimeout(() => {
      const input = readinessInputFromFingerprint(readinessFingerprint);
      loadModelMigratorReadiness({ ...input, forceRefresh }, controller.signal)
        .then((result) => {
          if (!isLatestScope()) return;
          setReadiness(result.readiness);
          setReadinessResultFingerprint(readinessFingerprint);
        })
        .catch((err) => {
          if (!isLatestScope() || isAbortFailure(err)) return;
          const detail = errorText(err, 'Omni did not return readiness for this model pairing.');
          if (/\b429\b|rate.?limit|too many requests/i.test(detail)) {
            setReadinessError('Omni is handling too many requests right now. Wait a moment, then retry this model pairing.');
          } else if (/time.?out|timed out/i.test(detail)) {
            setReadinessError('The readiness check took too long. Retry this model pairing when Omni is responsive.');
          } else {
            setReadinessError(detail);
          }
        })
        .finally(() => {
          if (isLatestScope()) setLoadingReadiness(false);
        });
    }, READINESS_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [readinessFingerprint, readinessRefreshToken]);

  useEffect(() => {
    setPathByModelId((current) => {
      const next = { ...current };
      let changed = false;
      for (const model of selectedSourceModels) {
        const recommendation = strategyBySourceId[model.id]?.modelPath;
        if (recommendation && !next[model.id]) {
          next[model.id] = recommendation;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [selectedSourceModels, strategyBySourceId]);

  function markManualModelMigratorScopeChange() {
    safeCopyHandoffManualRevision.current += 1;
    safeCopyHandoffAppliedRevision.current = null;
    pendingSafeCopyHandoff.current = null;
    if (safeCopyHandoffWasPresent.current) safeCopyHandoffHandled.current = true;
  }

  function markManualBeforeSafeCopyHandoff() {
    if (safeCopyHandoffWasPresent.current && !safeCopyHandoffHandled.current) {
      markManualModelMigratorScopeChange();
    }
  }

  function chooseSourceInstance(instanceId: string) {
    if (scopeControlsLocked) return;
    markManualModelMigratorScopeChange();
    setSourceConnectionId('');
    setSourceInstanceId(instanceId);
  }

  function chooseTargetInstance(instanceId: string) {
    if (scopeControlsLocked) return;
    markManualModelMigratorScopeChange();
    setSelectedPostActionIndexes([]);
    setTargetConnectionId('');
    setTargetInstanceId(instanceId);
  }

  function chooseSourceConnection(connectionId: string) {
    if (scopeControlsLocked) return;
    markManualModelMigratorScopeChange();
    setSourceConnectionId(connectionId);
  }

  function chooseTargetConnection(connectionId: string) {
    if (scopeControlsLocked) return;
    markManualModelMigratorScopeChange();
    setSelectedPostActionIndexes([]);
    setTargetConnectionId(connectionId);
  }

  function chooseTargetModel(sourceModelId: string, targetModelId: string) {
    if (scopeControlsLocked) return;
    markManualModelMigratorScopeChange();
    setSelectedPostActionIndexes([]);
    setTargetModelBySourceId((current) => ({ ...current, [sourceModelId]: targetModelId }));
  }

  function toggleSourceModel(modelId: string) {
    if (scopeControlsLocked) return;
    markManualBeforeSafeCopyHandoff();
    setSelectedSourceModelIds((current) => (
      current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]
    ));
  }

  function selectAllSourceModels() {
    if (scopeControlsLocked) return;
    markManualBeforeSafeCopyHandoff();
    setSelectedSourceModelIds((current) => {
      const next = sourceModels.map((model) => model.id);
      return sameStringArray(current, next) ? current : next;
    });
  }

  function clearSourceModels() {
    if (scopeControlsLocked) return;
    markManualBeforeSafeCopyHandoff();
    setSelectedSourceModelIds((current) => current.length === 0 ? current : []);
  }

  function toggleContent(document: ModelMigratorInventoryDocument) {
    if (jobActive) return;
    const key = contentKey(document);
    setSelectedContentKeys((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ));
  }

  function selectVisibleContent(kind?: 'dashboard' | 'workbook') {
    if (jobActive) return;
    const keys = visibleDocuments
      .filter((document) => !kind || document.kind === kind)
      .map(contentKey);
    setSelectedContentKeys((current) => [...new Set([...current, ...keys])]);
  }

  function clearContentSelection() {
    if (jobActive) return;
    setSelectedContentKeys([]);
  }

  function updateSchemaMappingRows(rows: SchemaMappingRow[]) {
    setSchemaMapText(serializeSchemaMappingRows(rows));
  }

  function updateSchemaMappingRow(rowId: string, patch: Partial<Pick<SchemaMappingRow, 'source' | 'target'>>) {
    const rows = schemaMappingRows.length > 0 ? schemaMappingRows : [{ id: 'schema-map-0', source: '', target: '' }];
    updateSchemaMappingRows(rows.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  }

  function addSchemaMappingRow() {
    updateSchemaMappingRows([...schemaMappingRows, { id: `schema-map-${Date.now()}`, source: 'SOURCE_SCHEMA', target: 'TARGET_SCHEMA' }]);
  }

  function removeSchemaMappingRow(rowId: string) {
    updateSchemaMappingRows(schemaMappingRows.filter((row) => row.id !== rowId));
  }

  function updateSemanticDecision(modelId: string, decisionId: string, patch: Partial<ModelMigratorSemanticDecision>) {
    setTranslationsByModelId((current) => {
      const existing = current[modelId];
      if (!existing) return current;
      return {
        ...current,
        [modelId]: {
          ...existing,
          semanticDecisions: existing.semanticDecisions.map((decision) => (
            decision.id === decisionId ? { ...decision, ...patch } : decision
          )),
        },
      };
    });
  }

  async function translateSelectedModels() {
    if (jobActive || (dashboardRepairRequested && (!dashboardRepairScope || dashboardRepairScope.scopeReviewRequired || loadingDashboardRepair))) return;
    setTranslating(true);
    setError('');
    setMessage('');
    try {
      const nextTranslations: Record<string, TranslationState> = { ...translationsByModelId };
      const nextAccepted: Record<string, Record<string, string>> = { ...acceptedFilesByModelId };
      const nextSkipped: Record<string, string[]> = { ...skippedFilesByModelId };
      const sourceDialect = sourceConnections.find((connection) => connection.id === sourceConnectionId)?.dialect || '';
      const targetDialect = targetConnections.find((connection) => connection.id === targetConnectionId)?.dialect || '';
      for (const model of selectedSourceModels.filter((row) => {
        const mode = pathByModelId[row.id] || 'translate';
        return mode !== 'fast' && mode !== 'impact_report';
      })) {
        const result = await translateModelMigratorYaml({
          sourceInstanceId,
          targetInstanceId,
          modelId: model.id,
          targetModelId: targetModelBySourceId[model.id],
          schemaMapText,
          sourceDialect,
          targetDialect,
          runAi: dashboardRepairRequested ? false : runAiDialectPass,
          ...(dashboardRepairScope ? { dashboardRepair: {
            planId: dashboardRepairScope.handoff.planId,
            targetId: dashboardRepairScope.handoff.targetId,
            revision: dashboardRepairScope.revision,
          } } : {}),
        });
        nextTranslations[model.id] = dashboardRepairScope ? scopeDashboardModelRepairTranslation(result, dashboardRepairScope, model.id) : result;
        nextAccepted[model.id] = {};
        nextSkipped[model.id] = [];
      }
      setTranslationsByModelId(nextTranslations);
      setViewedDashboardFiles([]);
      setAcceptedFilesByModelId(nextAccepted);
      setSkippedFilesByModelId(nextSkipped);
      setMessage(dashboardRepairRequested ? 'Additive-only changes prepared. Review the current destination and exact proposed additions, then explicitly accept each changed file. YAML and AI edits are unavailable for this reviewed repair.' : 'Model YAML translated. Accept, edit, or skip each file before running.');
    } catch (err) {
      setError(errorText(err, 'Failed to translate selected models.'));
    } finally {
      setTranslating(false);
    }
  }

  async function preflightWorkbooks() {
    if (jobActive) return;
    setPreflighting(true);
    setError('');
    try {
      const rows: ModelMigratorWorkbookPreflight[] = [];
      for (const model of selectedSourceModels) {
        const targetModelId = targetModelBySourceId[model.id];
        const docs = selectedWorkbookDocs.filter((document) => document.sourceModelId === model.id);
        if (!targetModelId || docs.length === 0) continue;
        const result = await preflightModelMigratorWorkbooks({
          sourceInstanceId,
          targetInstanceId,
          sourceModelId: model.id,
          targetModelId,
          documentIds: docs.map((document) => document.id),
        });
        rows.push(...result.workbooks);
      }
      setWorkbookPreflights(rows);
      const blockers = rows.reduce((sum, row) => sum + row.blockerCount, 0);
      setMessage(blockers > 0 ? `${blockers} workbook blocker${blockers === 1 ? '' : 's'} found.` : 'Workbook preflight passed.');
    } catch (err) {
      setError(errorText(err, 'Failed to preflight workbook queries.'));
    } finally {
      setPreflighting(false);
    }
  }

  function acceptedFilesForModel(modelId: string) {
    const accepted = acceptedFilesByModelId[modelId] || {};
    const checksums = translationsByModelId[modelId]?.checksums || {};
    const requiredFiles = new Set(dashboardRepairScope?.readiness.requiredFilesByModelId?.[modelId] || []);
    return Object.entries(accepted).filter(([fileName, yaml]) => {
      if (!dashboardRepairRequested) return true;
      const file = translationsByModelId[modelId]?.files.find((row) => row.fileName === fileName);
      return requiredFiles.has(fileName) && file && !file.blocked && file.targetOriginal !== undefined && file.additiveStatus !== 'conflict' && file.additiveStatus !== 'unchanged' && Boolean(file.reviewToken) && yaml === (file.deterministic || file.translated);
    }).map(([fileName, yaml]) => ({
      fileName,
      yaml,
      previousChecksum: checksums[fileName],
      ...(dashboardRepairRequested ? { reviewToken: translationsByModelId[modelId]?.files.find((file) => file.fileName === fileName)?.reviewToken } : {}),
    }));
  }

  function contentRepairActionsForModel(modelId: string): ModelMigratorContentRepairAction[] {
    if (dashboardRepairRequested) return [];
    return (translationsByModelId[modelId]?.semanticDecisions || [])
      .filter((decision) => (
        approvedRepairDecisionIds.includes(decision.id)
        && decision.action === 'map_existing'
        && Boolean(decision.targetName)
        && (decision.kind === 'field' || decision.kind === 'view' || decision.kind === 'topic')
      ))
      .map((decision) => ({
        id: decision.id,
        kind: decision.kind as 'field' | 'view' | 'topic',
        find: decision.sourceName,
        replacement: decision.targetName || '',
        approved: true,
        includePersonalFolders: false,
      }));
  }

  function contentInputs(): ModelMigratorJobContentInput[] {
    return selectedDocuments
      .filter((document) => document.kind === 'dashboard' || document.kind === 'workbook')
      .map((document) => {
        const targetModelId = targetModelBySourceId[document.sourceModelId] || '';
        const targetModel = targetModels.find((model) => model.id === targetModelId);
        const kind: 'dashboard' | 'workbook' = document.kind === 'dashboard' ? 'dashboard' : 'workbook';
        return {
          documentId: document.id,
          documentName: document.name,
          kind,
          sourceModelId: document.sourceModelId,
          targetModelId,
          targetModelName: targetModel?.name,
          targetFolderPath: document.folderPath,
        };
      })
      .filter((row) => row.targetModelId);
  }

  async function startModelMigrationJob() {
    if (!canStartJob) return;
    setStartingJob(true);
    setError('');
    try {
      const result = await createModelMigratorJob({
        sourceId: sourceInstanceId,
        targetId: targetInstanceId,
        targetLabel: targetInstances.find((instance) => instance.id === targetInstanceId)?.label,
        replaceSameNamed: dashboardRepairRequested ? false : replaceSameNamed,
        mergeAfterValidation: false,
        publishDrafts: dashboardRepairRequested ? false : publishDrafts,
        deleteBranch: dashboardRepairRequested ? false : deleteBranch,
        models: selectedSourceModels.filter((model) => !dashboardRepairRequested || acceptedFilesForModel(model.id).length > 0).map((model) => {
          const targetModelId = targetModelBySourceId[model.id];
          const targetModel = targetModels.find((row) => row.id === targetModelId);
          const mode = pathByModelId[model.id] || 'translate';
          return {
            sourceModelId: model.id,
            sourceModelName: model.name,
            targetModelId,
            targetModelName: targetModel?.name,
            targetConnectionId,
            mode,
            branchName: branchNameByModelId[model.id],
            gitRef: gitRefByModelId[model.id]?.trim() || undefined,
            fastPathSchemaConfirmed: mode === 'fast' ? fastPathConfirmedByModelId[model.id] === true : undefined,
            orgApiKeyConfirmed: mode === 'fast' ? fastPathConfirmedByModelId[model.id] === true : undefined,
            mergeHandoffRequired: modelRequiresMergeHandoff(targetModel),
            acceptedFiles: mode === 'translate' ? acceptedFilesForModel(model.id) : undefined,
            semanticDecisions: translationsByModelId[model.id]?.semanticDecisions || [],
            contentRepairActions: contentRepairActionsForModel(model.id),
          };
        }),
        content: contentInputs(),
        postMigrationActions: selectedSourceModels.every((model) => (pathByModelId[model.id] || 'translate') === 'impact_report') ? [] : selectedPostMigrationActions,
        ...(dashboardRepairScope ? { dashboardRepair: {
          planId: dashboardRepairScope.handoff.planId,
          targetId: dashboardRepairScope.handoff.targetId,
          revision: dashboardRepairScope.revision,
        } } : {}),
      });
      setJob(result.job);
      if (dashboardRepairScope) {
        setDashboardRepairScope((current) => current ? { ...current, readiness: { ...current.readiness, repairJobId: result.job.id } } : current);
        try {
          await linkDashboardModelRepair(dashboardRepairScope.handoff.planId, dashboardRepairScope.handoff.targetId, result.job.id);
          setMessage('Dependency repair started. After the reviewed model changes are published, return to dashboard deployment to recheck compatibility.');
        } catch (linkError) {
          setError(`Repair job ${result.job.id} was created, but its plan reference could not be saved. ${errorText(linkError, 'Return to dashboard deployment and recheck before starting another repair.')}`);
        }
      } else {
        setMessage('Model migration job started.');
      }
      logOperation('model_migration', 'Model Migrator job started', {
        itemCount: result.job.items.length,
        successCount: 0,
        failureCount: 0,
      });
    } catch (err) {
      setError(errorText(err, 'Failed to start model migration job.'));
    } finally {
      setStartingJob(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    const result = await cancelOpsMigrationJob(job.id);
    setJob(result.job);
    logOperation('model_migration', 'Model Migrator job canceled', {
      itemCount: result.job.items.length,
      successCount: result.job.items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length,
      failureCount: result.job.items.filter((item) => item.status === 'failed').length,
    });
  }

  async function retryJob() {
    if (!job) return;
    const result = await retryOpsMigrationJob(job.id);
    setJob(result.job);
    logOperation('model_migration', 'Model Migrator retry started', {
      itemCount: result.job.items.length,
      successCount: 0,
      failureCount: 0,
    });
  }

  async function mergeValidatedJob() {
    if (!job || !jobCanMerge(job)) return;
    setStartingJob(true);
    setError('');
    try {
      const result = await mergeModelMigratorJob(job.id, { publishDrafts, deleteBranch });
      setJob(result.job);
      logOperation('model_migration', 'Model Migrator merge requested', {
        itemCount: result.job.items.filter((item) => item.kind === 'model_merge').length,
        successCount: result.job.items.filter((item) => item.kind === 'model_merge' && (item.status === 'succeeded' || item.status === 'warning')).length,
        failureCount: result.job.items.filter((item) => item.kind === 'model_merge' && item.status === 'failed').length,
      });
    } catch (err) {
      setError(errorText(err, 'Failed to merge validated branches.'));
    } finally {
      setStartingJob(false);
    }
  }

  const activeJobId = job?.id;

  useEffect(() => {
    if (!activeJobId) return undefined;
    const unsubscribe = subscribeMigrationJob(
      activeJobId,
      (event) => {
        if (event.type === 'snapshot' || event.type === 'job') {
          if (event.job) {
            setJob(event.job);
            if (['succeeded', 'partial', 'failed', 'canceled'].includes(event.job.status) && !loggedTerminalJobs.current.has(event.job.id)) {
              loggedTerminalJobs.current.add(event.job.id);
              const counts = statusCounts(event.job);
              logOperation('model_migration', `Model Migrator job ${event.job.status}`, {
                itemCount: event.job.items.length,
                successCount: counts.succeeded,
                failureCount: counts.failed,
                durationMs: event.job.startedAt ? Date.now() - event.job.startedAt : 0,
              });
            }
          }
          return;
        }
        if (event.type === 'item') {
          if (event.item) {
            const description = modelItemLogDescription(event.item);
            const key = `${event.item.id}:${event.item.status}`;
            if (description && !loggedItemEvents.current.has(key)) {
              loggedItemEvents.current.add(key);
              logOperation('model_migration', description, {
                itemCount: 1,
                successCount: event.item.status === 'succeeded' || event.item.status === 'warning' ? 1 : 0,
                failureCount: event.item.status === 'failed' ? 1 : 0,
                durationMs: event.item.startedAt ? (event.item.endedAt || Date.now()) - event.item.startedAt : 0,
              });
            }
          }
          void getMigrationJob(activeJobId).then((result) => setJob(result.job)).catch(() => undefined);
        }
      },
      () => undefined,
    );
    return unsubscribe;
  }, [activeJobId, logOperation]);

  if (!activeVaultInstanceId) {
    return (
      <SavedInstanceRequiredEmptyState
        toolName="Model Migrator"
        description="Model Migrator runs through saved Omni instances only. Unlock Home, then choose and test the saved Omni instance this workflow should use."
      />
    );
  }

  if (loadingVault) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary">
        <Loader2 size={16} className="animate-spin" />
        Loading vault status
      </div>
    );
  }

  const unlocked = Boolean(vaultStatus?.unlocked);
  const hideDashboardRepairEditor = dashboardRepairRequested && (loadingDashboardRepair || !dashboardRepairScope || Boolean(dashboardRepairScope.scopeReviewRequired));

  if (!unlocked) {
    return (
      <>
        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <SavedInstanceRequiredEmptyState toolName="Model Migrator" />
      </>
    );
  }

  return (
    <div className="space-y-5 pb-12">
      {!dashboardRepairRequested && <PageHeader
        title="Model Migrator"
        description="Safely move semantic models between saved Omni instances: match a target, resolve differences, check content impact, then publish or hand off review."
        icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={(
          <button type="button" onClick={refreshWorkflow} className="btn-secondary inline-flex items-center gap-2 text-sm">
            <RefreshCw size={14} />
            Refresh
          </button>
        )}
      />}

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div aria-live="polite" className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

      {dashboardRepairRequested && (dashboardRepairScope ? (
        <DashboardDependencyReviewPanel scope={dashboardRepairScope}
          source={instances.find((instance) => instance.id === dashboardRepairScope.sourceInstanceId)}
          target={instances.find((instance) => instance.id === dashboardRepairScope.targetInstanceId)}
          sourceConnection={selectedSourceConnection} targetConnection={selectedTargetConnection}
          sourceModels={sourceModels} targetModels={targetModels}
          documents={dashboardReviewDocuments.scopeKey === repairDocumentScopeKey ? dashboardReviewDocuments.documents : []}
          namesUnavailable={dashboardReviewDocuments.scopeKey === repairDocumentScopeKey && dashboardReviewDocuments.unavailable}
          readiness={readiness} hasJob={Boolean(job)}
          onReturn={() => navigate(`/dashboards/migrate?${new URLSearchParams({ planId: dashboardRepairScope.handoff.planId })}`)}
        />
      ) : (
        <section className="card p-5">
          <h1 className="text-xl font-semibold">Review dashboard model definitions</h1>
          <p className="mt-2 text-sm">{loadingDashboardRepair ? 'Loading your saved dashboard plan…' : 'The saved plan could not be opened. Return to Dashboard Migrator to review the selected source and destination.'}</p>
          <button type="button" className="btn-secondary mt-3" onClick={() => navigate(dashboardRepairHandoff.current
            ? `/dashboards/migrate?${new URLSearchParams({ planId: dashboardRepairHandoff.current.planId })}`
            : '/dashboards/migrate')}>Back to dashboard plan</button>
        </section>
      ))}

      <div className="space-y-5" hidden={hideDashboardRepairEditor} data-testid="model-repair-editor">
      {dashboardRepairRequested && <p className="text-sm text-content-secondary">The source and destination below are fixed by your dashboard plan. This repair permits shared-model additions only, not replacements or deletions of existing definitions. Conflicts block staging; unchanged files need no write. Review the current destination against each exact proposal before accepting it. YAML is read-only and AI edits are unavailable for this repair. Dashboard copying happens later in Dashboard Migrator.</p>}

      <div className="grid gap-3 lg:grid-cols-7">
        {WIZARD_STEPS.map((step, index) => (
          <StepPill key={step} index={index + 1} label={step} active={index < 2 || selectedSourceModels.length > 0} />
        ))}
      </div>

      <section
        data-testid="model-migrator-readiness"
        className={`rounded-card border p-4 ${readinessError ? 'border-red-200 bg-red-50 text-red-800' : readinessTone(readiness?.summary.status)}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              {loadingReadiness ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
              Model preparation checks

            </div>
            <p className="mt-1 text-xs" role={readinessError ? 'alert' : undefined}>
              {loadingReadiness
                ? 'Checking the selected model pairing. You can keep reviewing the page while Omni responds.'
                : readinessError
                  ? `The readiness check could not finish. ${readinessError}`
                  : readiness?.summary.label || readinessPendingMessage}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-chip bg-white/70 px-3 py-1 text-xs font-semibold">
              {loadingReadiness ? 'Checking' : readinessError ? 'Needs retry' : readiness ? readinessLabel(readiness.summary.status) : 'Waiting'}
              {readiness ? ` · ${readiness.summary.blockers} model-level blocker${readiness.summary.blockers === 1 ? '' : 's'} · ${readiness.summary.warnings} model-level review items` : ''}
            </span>
            <button
              type="button"
              onClick={() => setReadinessRefreshToken((current) => current + 1)}
              disabled={!readinessFingerprint || loadingReadiness}
              className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-50"
            >
              <RefreshCw size={13} />
              {readinessError ? 'Retry readiness' : 'Refresh readiness'}
            </button>
          </div>
        </div>
        {readiness && (
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            {([
              { slot: 'source', row: readiness.source },
              { slot: 'target', row: readiness.target },
            ] as const).map(({ slot, row }) => row ? (
              <div key={`${slot}:${row.instanceId}`} className="rounded-card border border-white/60 bg-white/70 p-3 text-xs">
                <div className="font-semibold text-content-primary">{row.label}</div>
                <div className="mt-1 text-content-secondary">{row.baseUrlHost} · {row.connections} connections · {row.sharedModels} shared models</div>
                <div className="mt-2 space-y-1">
                  {row.checks.slice(0, 3).map((item) => (
                    <div key={item.id} className="flex items-start gap-2">
                      <span className={`mt-1 h-1.5 w-1.5 rounded-full ${item.status === 'blocked' ? 'bg-red-500' : item.status === 'warning' ? 'bg-amber-500' : 'bg-green-500'}`} />
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null)}
            <div className="rounded-card border border-white/60 bg-white/70 p-3 text-xs">
              <div className="font-semibold text-content-primary">Selected migration paths</div>
              <div className="mt-1 text-content-secondary">
                {readiness.pairs.length === 0 ? 'Select source and target models to get a path recommendation.' : `${readiness.pairs.length} model pair${readiness.pairs.length === 1 ? '' : 's'} checked.`}
              </div>
              <div className="mt-2 space-y-1">
                {readiness.pairs.slice(0, 4).map((pair) => (
                  <div key={pair.sourceModelId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{selectedModelName(sourceModels, pair.sourceModelId)}</span>
                    <span className="rounded-chip bg-white px-2 py-0.5 font-semibold">{pair.releaseMode === 'pr' ? 'PR review' : pair.recommendedPath === 'fast' ? 'Auto copy' : pair.recommendedPath === 'translate' ? 'Review changes' : 'Impact only'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {loadingInstances ? (
        <LoadingLine label="Loading saved instances" />
      ) : instances.length === 0 ? (
        <div className="card p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-card bg-surface-secondary text-content-secondary">
              <Server size={18} />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-content-primary">No saved Omni instances yet</h2>
              <p className="mt-1 text-sm text-content-secondary">
                Add at least one source and one destination profile in Instance Manager before starting model migration.
              </p>
            </div>
            <button type="button" onClick={() => navigate('/admin/fleet/instances')} className="btn-primary inline-flex items-center gap-2 text-sm">
              Instance Manager
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Database size={16} />
                    Source
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Choose the saved instance, connection, and source models you want to move.</p>
                </div>
                {loadingSource && <Loader2 size={16} className="animate-spin text-content-secondary" />}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SelectField label="Source instance" value={sourceInstanceId} onChange={chooseSourceInstance} disabled={scopeControlsLocked}>
                  <EmptyValue>Choose source instance</EmptyValue>
                  {sourceInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label} · {roleLabel(instance.role)} · {hostLabel(instance.baseUrl)}</option>
                  ))}
                </SelectField>
                <SelectField label="Source connection" value={sourceConnectionId} onChange={chooseSourceConnection} disabled={scopeControlsLocked || !sourceInstanceId || sourceConnections.length === 0}>
                  <EmptyValue>{sourceConnections.length === 0 ? 'No connections loaded' : 'Choose connection'}</EmptyValue>
                  {sourceConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>
                  ))}
                </SelectField>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-content-secondary">
                  Showing {displayedSourceModels.length} of {sourceModels.length} models · {selectedSourceModelIds.length} selected
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAllSourceModels} disabled={scopeControlsLocked || sourceModels.length === 0} className="btn-secondary text-xs disabled:opacity-50">Select all</button>
                  <button type="button" onClick={clearSourceModels} disabled={scopeControlsLocked || selectedSourceModelIds.length === 0} className="btn-secondary text-xs disabled:opacity-50">Clear</button>
                </div>
              </div>

              <div data-testid="model-migrator-source-model-list" className="mt-3 max-h-[360px] overflow-auto rounded-card border border-border-subtle">
                {sourceModels.length === 0 ? (
                  <div className="p-5 text-sm text-content-secondary">No source models are available for the selected connection.</div>
                ) : displayedSourceModels.map((model) => {
                  const selected = selectedSourceModelIds.includes(model.id);
                  const row = inventoryByModel.get(model.id);
                  return (
                    <button
                      type="button"
                      key={model.id}
                      onClick={() => toggleSourceModel(model.id)}
                      disabled={scopeControlsLocked}
                      aria-pressed={selected}
                      className={`block w-full border-l-4 px-4 py-3 text-left transition ${selected ? 'border-l-omni-500 bg-omni-50' : 'border-l-transparent hover:bg-surface-secondary'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-content-primary">{model.name || model.id}</div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-content-tertiary">{model.id}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-content-secondary">
                            <span>{model.kind || 'SHARED'}</span>
                            <span>Updated {shortDate(model.updatedAt)}</span>
                            <span>{model.gitConfigured ? 'Git-backed fast path eligible' : 'Git status unknown'}</span>
                          </div>
                        </div>
                        <span className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border ${selected ? 'border-omni-600 bg-omni-600 text-white' : 'border-border-strong bg-white text-transparent'}`}>
                          <CheckCircle2 size={13} />
                        </span>
                      </div>
                      {selected && row && (
                        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
                          <div className="rounded-card bg-white px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row.dashboardCount}</span><br />Dashboards</div>
                          <div className="rounded-card bg-white px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row.workbookCount}</span><br />Workbooks</div>
                          <div className="rounded-card bg-white px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row.unknownCount}</span><br />Unknown</div>
                        </div>
                      )}
                    </button>
                  );
                })}
                {displayedSourceModels.length < sourceModels.length && (
                  <div className="border-t border-border-subtle bg-surface-secondary p-3 text-center">
                    <button
                      type="button"
                      onClick={() => setSourceModelDisplayLimit((current) => Math.min(sourceModels.length, current + SOURCE_MODEL_PAGE_SIZE))}
                      disabled={jobActive}
                      className="btn-secondary text-xs disabled:opacity-50"
                    >
                      Show {Math.min(SOURCE_MODEL_PAGE_SIZE, sourceModels.length - displayedSourceModels.length)} more models
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <GitBranch size={16} />
                    Target match
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Match each source model to the destination model OmniKit should prepare.</p>
                </div>
                {loadingTarget && <Loader2 size={16} className="animate-spin text-content-secondary" />}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SelectField label="Target instance" value={targetInstanceId} onChange={chooseTargetInstance} disabled={scopeControlsLocked}>
                  <EmptyValue>Choose target instance</EmptyValue>
                  {targetInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label} · {roleLabel(instance.role)} · {hostLabel(instance.baseUrl)}</option>
                  ))}
                </SelectField>
                <SelectField label="Target connection" value={targetConnectionId} onChange={chooseTargetConnection} disabled={scopeControlsLocked || !targetInstanceId || targetConnections.length === 0}>
                  <EmptyValue>{targetConnections.length === 0 ? 'No connections loaded' : 'Choose connection'}</EmptyValue>
                  {targetConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>
                  ))}
                </SelectField>
              </div>

              <div className="mt-3 space-y-3">
                {selectedSourceModels.length === 0 ? (
                  <div className="rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                    Select one or more source models to map target models.
                  </div>
                ) : selectedSourceModels.map((sourceModel) => {
                  const match = targetMatchBySourceId[sourceModel.id];
                  const strategy = strategyBySourceId[sourceModel.id];
                  const readinessPair: ModelMigratorReadinessPair | undefined = readinessPairBySourceId.get(sourceModel.id);
                  return (
                  <div key={sourceModel.id} className="rounded-card border border-border-subtle p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-content-primary">{sourceModel.name || sourceModel.id}</div>
                        <div className="truncate text-[11px] text-content-tertiary">{sourceModel.identifier || sourceModel.connectionName || sourceModel.id}</div>
                      </div>
                      <ArrowRight size={14} className="flex-shrink-0 text-content-tertiary" />
                    </div>
                    <select
                      value={targetModelBySourceId[sourceModel.id] || ''}
                      onChange={(event) => chooseTargetModel(sourceModel.id, event.target.value)}
                      disabled={scopeControlsLocked || targetModels.length === 0}
                      className="input-field"
                    >
                      <option value="">{targetModels.length === 0 ? 'No target models loaded' : 'Choose target model'}</option>
                      {targetModels.map((model) => (
                        <option key={model.id} value={model.id}>{modelLabel(model)}</option>
                      ))}
                    </select>
                    {match && strategy && (
                      <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1.3fr]">
                        <div className={`rounded-card px-3 py-2 text-xs ${confidenceTone(match.confidence)}`}>
                          <div className="font-semibold">{match.confidence === 'strong' ? 'Strong target match' : match.confidence === 'likely' ? 'Likely target match' : 'Manual match'}</div>
                          <div className="mt-1">Model similarity: {match.score}/100 · {match.reasons.slice(0, 2).join(', ') || 'Selected manually'}</div>
                          <p className="mt-1">Similarity is a matching hint, not a readiness or validation score.</p>
                          {readinessPair?.schemaOverlap && (
                            <div className="mt-1">
                              {readinessPair.schemaOverlap.overlappingSchemas.length} schema overlap
                              {readinessPair.schemaOverlap.overlappingSchemas.length > 0 ? ` · ${readinessPair.schemaOverlap.overlappingSchemas.slice(0, 3).join(', ')}` : ''}
                            </div>
                          )}
                        </div>
                        <div className={`rounded-card border px-3 py-2 text-xs ${readinessTone(readinessPair?.status)}`}>
                          <div className="font-semibold">{strategy.label}</div>
                          <div className="mt-1">{strategy.description}</div>
                        </div>
                      </div>
                    )}
	                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Migration path</span>
                        <select
                          value={pathByModelId[sourceModel.id] || 'translate'}
                          onChange={(event) => setPathByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value as ModelPath }))}
                          className="input-field"
                          disabled={scopeControlsLocked}
                        >
                          <option value="translate">Review and adapt model changes</option>
                          <option value="fast" disabled={!modelSupportsFastPath(sourceModel)}>Copy model automatically {modelSupportsFastPath(sourceModel) ? '' : '(git-backed source required)'}</option>
                          <option value="impact_report">Impact report only - no changes</option>
                        </select>
                      </label>
	                      <label className="block">
	                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Safe working copy</span>
	                        <input
                          value={branchNameByModelId[sourceModel.id] || ''}
                          onChange={(event) => setBranchNameByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value }))}
                          className="input-field"
                          disabled={jobActive}
                          placeholder={defaultBranchName(sourceModel)}
	                        />
	                      </label>
	                    </div>
	                    {(pathByModelId[sourceModel.id] || 'translate') === 'fast' && (
	                      <div className="mt-3 space-y-2 rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
	                        <label className="flex items-start gap-2">
	                          <input
	                            type="checkbox"
	                            className="mt-0.5"
	                            checked={fastPathConfirmedByModelId[sourceModel.id] === true}
	                            onChange={(event) => setFastPathConfirmedByModelId((current) => ({ ...current, [sourceModel.id]: event.target.checked }))}
                              disabled={jobActive}
	                          />
	                        <span>I confirm the source and target data locations are compatible and the saved credential is an Omni Organization API key. OmniKit will still validate before publish.</span>
	                        </label>
	                        <label className="block">
	                          <span className="mb-1 block font-semibold uppercase tracking-wide">Git ref</span>
	                          <input
	                            value={gitRefByModelId[sourceModel.id] || ''}
	                            onChange={(event) => setGitRefByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value }))}
	                            className="input-field bg-white"
                              disabled={jobActive}
	                            placeholder="Optional source git ref"
	                          />
	                        </label>
	                      </div>
	                    )}
	                    {modelRequiresMergeHandoff(targetModels.find((model) => model.id === targetModelBySourceId[sourceModel.id])) && (
	                      <div className="mt-3 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
	                        Target model appears protected. OmniKit will stage and validate changes, then prepare a review handoff instead of forcing a direct publish.
	                      </div>
	                    )}
	                  </div>
                  );
                })}
              </div>
            </section>
          </div>

          {!dashboardRepairRequested && <section className="card p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                  <FileText size={16} />
                  Content impact
                </div>
                <p className="mt-1 text-xs text-content-secondary">Select affected dashboards and workbooks that should move with the model migration.</p>
              </div>
              {loadingInventory ? (
                <span className="inline-flex items-center gap-2 text-xs text-content-secondary"><Loader2 size={13} className="animate-spin" />Loading inventory</span>
              ) : (
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{totals.dashboardCount}</div><div className="text-content-secondary">Dashboards</div></div>
                  <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{totals.workbookCount}</div><div className="text-content-secondary">Workbooks</div></div>
                  <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{totals.unknownCount}</div><div className="text-content-secondary">Unknown</div></div>
                </div>
              )}
            </div>
            <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_auto]">
              <input
                value={contentSearch}
                onChange={(event) => setContentSearch(event.target.value)}
                className="input-field"
                placeholder="Search content by name, folder, or kind"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => selectVisibleContent()} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Select visible</button>
                <button type="button" onClick={() => selectVisibleContent('workbook')} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Workbooks</button>
                <button type="button" onClick={() => selectVisibleContent('dashboard')} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Dashboards</button>
                <button type="button" onClick={clearContentSelection} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Clear</button>
              </div>
            </div>
            <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              {WORKBOOK_FIDELITY_DISCLOSURE}
            </div>

            {selectedSourceModelIds.length === 0 ? (
              <div className="rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                Model selection will populate content inventory.
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {selectedSourceModelIds.map((modelId) => {
                  const row = inventoryByModel.get(modelId);
                  const documents = row?.documents || [];
                  return (
                    <div key={modelId} className="rounded-card border border-border-subtle p-4">
                      <div className="mb-3">
                        <div className="text-sm font-semibold text-content-primary">{selectedModelName(sourceModels, modelId)}</div>
                        <div className="font-mono text-[11px] text-content-tertiary">{modelId}</div>
                      </div>
                      <div className="mb-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                        <div className="rounded-card bg-surface-secondary px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row?.dashboardCount || 0}</span><br />Dashboards</div>
                        <div className="rounded-card bg-surface-secondary px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row?.workbookCount || 0}</span><br />Workbooks</div>
                        <div className="rounded-card bg-surface-secondary px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row?.unknownCount || 0}</span><br />Unknown</div>
                      </div>
                      {documents.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border-subtle px-3 py-2 text-xs text-content-secondary">No documents found for this model.</div>
                      ) : (
                        <div className="max-h-48 overflow-auto rounded-card border border-border-subtle">
                          {documents.filter((document) => documentMatchesSearch(document, contentSearch)).map((document) => (
                            <label key={document.id} className="flex cursor-pointer items-start gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-surface-secondary">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={selectedContentKeys.includes(contentKey(document))}
                                onChange={() => toggleContent(document)}
                                disabled={jobActive}
                              />
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
	                                  <div className="truncate text-xs font-semibold text-content-primary">{document.name}</div>
	                                  <div className="truncate text-[11px] text-content-tertiary">{document.folderPath || 'No folder path'}</div>
	                                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-content-secondary">
	                                    {document.description ? <span className="rounded-chip bg-surface-secondary px-1.5 py-0.5">description</span> : <span className="rounded-chip bg-amber-50 px-1.5 py-0.5 text-amber-800">missing description</span>}
	                                    {document.labels?.length ? <span className="rounded-chip bg-surface-secondary px-1.5 py-0.5">{document.labels.length} label{document.labels.length === 1 ? '' : 's'}</span> : <span className="rounded-chip bg-amber-50 px-1.5 py-0.5 text-amber-800">no labels</span>}
	                                  </div>
	                                </div>
                                <span className={`rounded-chip px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                  document.kind === 'dashboard'
                                    ? 'bg-green-50 text-green-700'
                                    : document.kind === 'workbook'
                                      ? 'bg-blue-50 text-blue-700'
                                      : 'bg-surface-secondary text-content-secondary'
                                }`}
                                >
                                  {document.kind}
                                </span>
                              </div>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>}

          <section className="grid gap-5 xl:grid-cols-2">
            <div className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Layers3 size={16} />
                    Resolve model differences
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Map data locations, review semantic YAML changes, and choose which files should be staged on the safe working copy. Main branches are never written by this step.</p>
                </div>
	                <button type="button" onClick={translateSelectedModels} disabled={jobActive || translating || selectedSourceModels.length === 0 || (dashboardRepairRequested && (!dashboardRepairScope || Boolean(dashboardRepairScope.scopeReviewRequired) || loadingDashboardRepair))} className="btn-primary inline-flex items-center gap-2 text-xs disabled:opacity-60">
	                  {translating ? <Loader2 size={13} className="animate-spin" /> : <Workflow size={13} />}
	                  Prepare differences
	                </button>
	              </div>
	              {!dashboardRepairRequested && <label className="mb-3 flex items-start gap-2 rounded-card border border-border-subtle bg-surface-secondary p-3 text-xs text-content-secondary">
	                <input
	                  type="checkbox"
	                  className="mt-0.5"
	                  checked={runAiDialectPass}
	                  onChange={(event) => setRunAiDialectPass(event.target.checked)}
                    disabled={jobActive}
	                />
	                <span>Run Omni AI dialect pass after deterministic schema rewrites. AI output is a reviewed draft and never writes until accepted.</span>
	              </label>}
              <div className="rounded-card border border-border-subtle p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Data-location mappings</div>
                    <p className="mt-1 text-xs text-content-secondary">Tell OmniKit how source schemas or database paths should land in the target model.</p>
                  </div>
                  <button type="button" onClick={addSchemaMappingRow} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Add mapping</button>
                </div>
                <div className="space-y-2">
                  {(schemaMappingRows.length > 0 ? schemaMappingRows : [{ id: 'schema-map-0', source: '', target: '' }]).map((row) => (
                    <div key={row.id} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                      <input
                        value={row.source}
                        onChange={(event) => updateSchemaMappingRow(row.id, { source: event.target.value })}
                        className="input-field"
                        disabled={jobActive}
                        placeholder="Source schema, database, or path"
                      />
                      <input
                        value={row.target}
                        onChange={(event) => updateSchemaMappingRow(row.id, { target: event.target.value })}
                        className="input-field"
                        disabled={jobActive}
                        placeholder="Target schema, database, or path"
                      />
                      <button
                        type="button"
                        onClick={() => removeSchemaMappingRow(row.id)}
                        disabled={jobActive || schemaMappingRows.length === 0}
                        className="btn-secondary text-xs disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-content-secondary">Advanced raw mapping text</summary>
                  <textarea
                    value={schemaMapText}
                    onChange={(event) => setSchemaMapText(event.target.value)}
                    className="input-field mt-2 min-h-[88px]"
                    disabled={jobActive}
                    placeholder="ANALYTICS.PUBLIC -> main.analytics"
                  />
                </details>
              </div>
              <div className="mt-4 space-y-3">
                {selectedSourceModels.filter((model) => pathByModelId[model.id] !== 'fast').length === 0 ? (
                  <div className="rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">Translate pipeline models will appear here.</div>
                ) : selectedSourceModels.filter((model) => pathByModelId[model.id] !== 'fast').map((model) => {
                  const translation = translationsByModelId[model.id];
                  return (
                    <div key={model.id} className="rounded-card border border-border-subtle p-3">
                      <div className="mb-2 text-sm font-semibold text-content-primary">{model.name}</div>
                      {!translation ? (
                        <div className="text-xs text-content-secondary">Choose “Prepare differences” to load model definitions for review. This does not publish changes.</div>
                      ) : (
                        <div className="space-y-2">
                          {translation.semanticDecisions.length > 0 && (
                            <div className="rounded-card border border-blue-200 bg-blue-50 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Semantic decisions</div>
                              <div className="space-y-2">
                                {translation.semanticDecisions.slice(0, 12).map((decision) => (
                                  <div key={decision.id} className="rounded-card border border-blue-100 bg-white p-2 text-xs">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                      <div>
                                        <div className="font-semibold text-content-primary">{decision.kind}: {decision.sourceName}</div>
                                        <div className="text-content-secondary">{decision.sourceFileName || 'model YAML'}{decision.required ? ' · required before publish' : ''}</div>
                                      </div>
                                      <select
                                        value={decision.action}
                                        onChange={(event) => updateSemanticDecision(model.id, decision.id, { action: event.target.value as ModelMigratorSemanticDecision['action'] })}
                                        className="input-field max-w-[220px] bg-white text-xs"
                                        disabled={jobActive}
                                      >
                                        <option value="create_from_source">Create from source</option>
                                        <option value="map_existing">Map to existing</option>
                                        <option value="keep_target">Keep target</option>
                                        <option value="ignore">Ignore</option>
                                        <option value="custom_edit">Edit code</option>
                                      </select>
                                    </div>
                                    {decision.action === 'map_existing' && (
                                      <div className="mt-2 space-y-2">
                                        <input
                                          value={decision.targetName || ''}
                                          onChange={(event) => updateSemanticDecision(model.id, decision.id, { targetName: event.target.value })}
                                          className="input-field bg-white text-xs"
                                          disabled={jobActive}
                                          placeholder="Target view, field, topic, or relationship name"
                                        />
                                        {['field', 'view', 'topic'].includes(decision.kind) && (
                                          <label className="flex items-start gap-2 rounded-card border border-blue-100 bg-blue-50 px-2 py-1 text-blue-900">
                                            <input
                                              type="checkbox"
                                              className="mt-0.5"
                                              checked={approvedRepairDecisionIds.includes(decision.id)}
                                              disabled={jobActive || !decision.targetName}
                                              onChange={(event) => setApprovedRepairDecisionIds((current) => (
                                                event.target.checked
                                                  ? [...new Set([...current, decision.id])]
                                                  : current.filter((id) => id !== decision.id)
                                              ))}
                                            />
                                            <span>Also repair existing content references from {decision.sourceName} to {decision.targetName || 'the selected target'} before validation.</span>
                                          </label>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                              {translation.semanticDecisions.length > 12 && (
                                <div className="mt-2 text-xs text-blue-800">Showing 12 of {translation.semanticDecisions.length} detected differences. Use YAML review below for the full file-level detail.</div>
                              )}
                            </div>
                          )}
	                          {translation.files.map((file) => {
	                            const skipped = (skippedFilesByModelId[model.id] || []).includes(file.fileName);
                              const acceptedValue = acceptedFilesByModelId[model.id]?.[file.fileName];
                              const activeDraft = dashboardRepairRequested ? file.deterministic || file.translated : fileDraft(file);
                              const editableValue = dashboardRepairRequested ? activeDraft : acceptedValue ?? activeDraft;
                              const accepted = dashboardRepairRequested ? acceptedValue === activeDraft : acceptedValue !== undefined;
                              const edited = editableValue !== activeDraft;
                              const unchanged = dashboardRepairRequested && file.additiveStatus === 'unchanged';
                              const blocked = file.blocked || (dashboardRepairRequested && (file.additiveStatus === 'conflict' || file.targetOriginal === undefined || (!unchanged && !file.reviewToken)));
                              const dashboardReviewKey = JSON.stringify([model.id, file.fileName, file.reviewToken]);
                              const viewed = !dashboardRepairRequested || viewedDashboardFiles.includes(dashboardReviewKey);
	                            const decision = blocked ? file.additiveStatus === 'conflict' ? 'Conflict — blocked' : 'Blocked' : unchanged ? 'No change' : skipped ? 'Skipped' : accepted ? edited ? 'Accepted edit' : 'Accepted' : edited ? 'Edited — needs acceptance' : 'Needs decision';
	                            return (
	                              <details key={file.fileName} className="rounded-card border border-border-subtle bg-white" onToggle={(event) => { if (dashboardRepairRequested && event.currentTarget.open) setViewedDashboardFiles((current) => current.includes(dashboardReviewKey) ? current : [...current, dashboardReviewKey]); }}>
	                                <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-content-primary">
	                                  <span>{file.fileName}</span>
                                    <span className="flex flex-wrap items-center justify-end gap-2">
                                      {file.aiDraft && !skipped && !dashboardRepairRequested && (
                                        <span className="rounded-chip bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                                          AI draft needs review
                                        </span>
                                      )}
	                                    <span className={blocked ? 'text-red-700' : skipped || unchanged ? 'text-content-secondary' : accepted ? 'text-green-700' : 'text-amber-700'}>{decision}</span>
                                    </span>
	                                </summary>
	                                <div className="border-t border-border-subtle p-3">
	                                  {file.warnings.map((warning) => <div key={warning} className="mb-2 rounded-card bg-amber-50 px-2 py-1 text-xs text-amber-800">{warning}</div>)}
                                    {file.aiJobId && <div className="mb-2 rounded-card bg-blue-50 px-2 py-1 text-xs text-blue-800">Omni AI job: {file.aiJobId}</div>}
                                    {file.aiRefusal && <div className="mb-2 rounded-card bg-red-50 px-2 py-1 text-xs text-red-800">{file.aiRefusal}</div>}
                                    {dashboardRepairRequested && <p className={`mb-2 text-xs leading-5 ${blocked ? 'text-red-800' : 'text-content-secondary'}`}>{file.targetOriginal === undefined ? 'Current destination evidence was not returned. Prepare differences again before accepting this file.' : file.additiveStatus === 'conflict' ? 'This proposal conflicts with an existing definition. It cannot be accepted or overridden here.' : unchanged ? 'The destination already has this definition. No change or acceptance is needed.' : !file.reviewToken ? 'The server-issued review is unavailable. Prepare differences again; this file cannot be accepted.' : file.additiveStatus === 'new' ? 'New destination file. Review its full contents before accepting.' : 'Additions to the existing destination file. Existing definitions must be preserved.'}</p>}
	                                  <div className="mb-2 flex flex-wrap gap-2 text-xs">
	                                    <button
	                                      type="button"
	                                      className="btn-secondary text-xs"
                                        disabled={blocked || unchanged || !viewed || jobActive || startingJob}
	                                      onClick={() => {
	                                        setAcceptedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: { ...(current[model.id] || {}), [file.fileName]: file.deterministic || file.translated },
	                                        }));
	                                        setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
	                                        }));
	                                      }}
	                                    >
	                                      Accept deterministic
	                                    </button>
                                      {file.aiDraft && !dashboardRepairRequested && (
                                        <button
                                          type="button"
                                          className="btn-secondary text-xs"
                                          disabled={blocked || unchanged || jobActive || startingJob}
                                          onClick={() => {
                                            setAcceptedFilesByModelId((current) => ({
                                              ...current,
                                              [model.id]: { ...(current[model.id] || {}), [file.fileName]: file.aiDraft || file.translated },
                                            }));
                                            setSkippedFilesByModelId((current) => ({
                                              ...current,
                                              [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
                                            }));
                                          }}
                                        >
                                          Accept AI draft
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className="btn-secondary text-xs"
                                        disabled={blocked || unchanged || !viewed || jobActive || startingJob}
                                        onClick={() => {
                                          setAcceptedFilesByModelId((current) => ({
                                            ...current,
                                            [model.id]: { ...(current[model.id] || {}), [file.fileName]: editableValue },
                                          }));
                                          setSkippedFilesByModelId((current) => ({
                                            ...current,
                                            [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
                                          }));
                                        }}
                                      >
                                        Accept current
	                                    </button>
	                                    <button
	                                      type="button"
	                                      className="btn-secondary text-xs"
                                        disabled={blocked || unchanged || jobActive || startingJob}
	                                      onClick={() => {
	                                        setAcceptedFilesByModelId((current) => {
	                                          const modelFiles = { ...(current[model.id] || {}) };
	                                          delete modelFiles[file.fileName];
	                                          return { ...current, [model.id]: modelFiles };
	                                        });
	                                        setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: [...new Set([...(current[model.id] || []), file.fileName])],
	                                        }));
	                                      }}
	                                    >
	                                      Skip file
	                                    </button>
	                                  </div>
	                                  <div className="grid gap-3 xl:grid-cols-2">
                                      {dashboardRepairRequested ? <div className="xl:col-span-2">{file.targetOriginal === undefined ? <pre className="max-h-96 overflow-auto rounded border border-border p-3 text-[11px]">{editableValue}</pre> : <DashboardRepairFileDiff before={file.targetOriginal} after={editableValue} />}</div> : <>
	                                    <div>
	                                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Original</div>
	                                      <pre className="max-h-72 overflow-auto rounded-card border border-border-subtle bg-surface-secondary p-3 font-mono text-[11px] leading-5 text-content-secondary">
	                                        {reviewLines(file.original).map((line, index) => {
	                                          const deterministicLine = reviewLines(file.deterministic || file.translated)[index];
	                                          return <div key={`${file.fileName}:orig:${index}`} className={diffLineClass(line, deterministicLine)}>{line || ' '}</div>;
	                                        })}
	                                      </pre>
	                                    </div>
                                      <div>
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Deterministic draft</div>
                                        <pre className="max-h-72 overflow-auto rounded-card border border-border-subtle bg-surface-secondary p-3 font-mono text-[11px] leading-5 text-content-secondary">
                                          {reviewLines(file.deterministic || file.translated).map((line, index) => {
                                            const originalLine = reviewLines(file.original)[index];
                                            return <div key={`${file.fileName}:det:${index}`} className={diffLineClass(originalLine, line)}>{line || ' '}</div>;
                                          })}
                                        </pre>
                                      </div>
                                      <div>
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">AI draft</div>
                                        {file.aiDraft ? (
                                          <pre className="max-h-72 overflow-auto rounded-card border border-border-subtle bg-surface-secondary p-3 font-mono text-[11px] leading-5 text-content-secondary">
                                            {reviewLines(file.aiDraft).map((line, index) => {
                                              const deterministicLine = reviewLines(file.deterministic || file.translated)[index];
                                              return <div key={`${file.fileName}:ai:${index}`} className={diffLineClass(deterministicLine, line)}>{line || ' '}</div>;
                                            })}
                                          </pre>
                                        ) : (
                                          <div className="rounded-card border border-dashed border-border-subtle bg-surface-secondary p-3 text-xs text-content-secondary">
                                            {file.aiRefusal ? 'AI did not return a YAML draft. Review the deterministic draft instead.' : 'AI pass was not run for this file.'}
                                          </div>
                                        )}
                                      </div>
                                      </>}
	                                    <label className="block">
	                                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">{dashboardRepairRequested ? 'Exact proposed output — read-only' : 'Accepted output'}</span>
	                                      <textarea
	                                        value={editableValue}
	                                        readOnly={dashboardRepairRequested}
	                                        onChange={(event) => {
                                            if (dashboardRepairRequested) return;
                                            const value = event.target.value;
                                            setAcceptedFilesByModelId((current) => ({ ...current, [model.id]: { ...(current[model.id] || {}), [file.fileName]: value } }));
                                          }}
	                                        onFocus={() => setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
	                                        }))}
	                                        className="input-field min-h-[288px] font-mono text-[11px]"
	                                        disabled={skipped || blocked || unchanged || jobActive || startingJob}
	                                      />
	                                    </label>
	                                  </div>
	                                </div>
                              </details>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <ShieldCheck size={16} />
                    {dashboardRepairRequested ? 'Dependency review and publish' : 'Content impact and publish'}
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Check affected workbooks and dashboards, then stage the model changes. Apply and validate writes only to safe working copies; publish after validation.</p>
                </div>
                {!dashboardRepairRequested && <button type="button" onClick={preflightWorkbooks} disabled={jobActive || preflighting || selectedWorkbookDocs.length === 0} className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-60">
                  {preflighting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Check workbook impact
                </button>}
              </div>
              {!dashboardRepairRequested && <div className="grid gap-2 text-xs text-content-secondary sm:grid-cols-2">
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={replaceSameNamed} onChange={(event) => setReplaceSameNamed(event.target.checked)} disabled={jobActive} />
	                  <span>Replace same-named workbook documents in the target folder.</span>
	                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={publishDrafts} onChange={(event) => setPublishDrafts(event.target.checked)} disabled={jobActive} />
	                  <span>Publish drafts when validated model changes are published.</span>
	                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
		                  <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} disabled={jobActive} />
		                  <span>Delete the safe working copy after publish.</span>
		                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={refreshSchemaAfterMigration} onChange={(event) => setRefreshSchemaAfterMigration(event.target.checked)} disabled={jobActive} />
	                  <span>Refresh target schema models after migration completes.</span>
	                </label>
	              </div>}
	              {!dashboardRepairRequested && targetInstance?.postMigrationActions.length ? (
	                <div className="mt-4 rounded-card border border-border-subtle p-3">
	                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">Saved post-actions</div>
	                  <div className="space-y-2">
	                    {targetInstance.postMigrationActions.map((action, actionIndex) => (
	                      <label key={`${action.name}:${actionIndex}`} className="flex items-start gap-2 text-xs text-content-secondary">
	                          <input
	                            type="checkbox"
	                          checked={selectedPostActionIndexes.includes(actionIndex)}
                            disabled={jobActive}
	                          onChange={(event) => setSelectedPostActionIndexes((current) => (
	                            event.target.checked
	                              ? [...new Set([...current, actionIndex])]
	                              : current.filter((row) => row !== actionIndex)
	                          ))}
	                        />
	                        <span><span className="font-semibold text-content-primary">{action.name}</span> · {action.kind || 'webhook'} {action.url ? `· ${action.url}` : ''}</span>
	                      </label>
	                    ))}
	                  </div>
	                </div>
	              ) : null}
	              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{selectedSourceModels.length}</div><div className="text-content-secondary">Models</div></div>
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{dashboardRepairScope ? dashboardRepairScope.documentIds.length : selectedDashboardDocs.length}</div><div className="text-content-secondary">{dashboardRepairScope ? 'Dashboards awaiting model review' : 'Dashboards selected for copy'}</div></div>
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{dashboardRepairScope ? 'Not assessed' : selectedWorkbookDocs.length}</div><div className="text-content-secondary">{dashboardRepairScope ? 'Other workbook impact' : 'Workbooks selected for copy'}</div></div>
              </div>
              <div className="mt-4 rounded-card border border-border-subtle bg-surface-secondary p-3 text-xs">
                <div className="mb-2 font-semibold text-content-primary">Review before run</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.impactOnlyCount > 0 ? `${reviewSummary.impactOnlyCount} impact-only` : 'Publishing path'}</div>
                    <div className="text-content-secondary">{reviewSummary.impactOnlyCount === selectedSourceModels.length && selectedSourceModels.length > 0 ? 'No branches, YAML writes, imports, merges, or post-actions will run.' : 'Selected publishing paths will stage changes on safe working copies first.'}</div>
                  </div>
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.semanticDecisionCount} semantic decisions</div>
                    <div className="text-content-secondary">Detected model differences are recorded with the run.</div>
                  </div>
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.approvedRepairCount} approved repairs</div>
                    <div className="text-content-secondary">Find/replace repairs run only for explicitly approved mappings.</div>
                  </div>
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.prHandoffCount} PR handoffs</div>
                    <div className="text-content-secondary">Protected targets will create/update a pull request instead of direct publish.</div>
                  </div>
                </div>
              </div>
              {workbookPreflights.length > 0 && (
                <div className="mt-4 max-h-48 overflow-auto rounded-card border border-border-subtle">
                  {workbookPreflights.map((row) => (
                    <div key={row.documentId} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                      <div className="font-semibold text-content-primary">{row.documentId}</div>
                      <div className={row.blockerCount > 0 ? 'text-red-700' : 'text-green-700'}>{row.tabCount} tab{row.tabCount === 1 ? '' : 's'} · {row.blockerCount} blocker{row.blockerCount === 1 ? '' : 's'}</div>
                      {row.tabs.flatMap((tab) => tab.blockers.map((blocker) => <div key={`${tab.id}:${blocker}`} className="mt-1 text-red-700">{tab.name}: {blocker}</div>))}
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={startModelMigrationJob} disabled={!canStartJob} className="btn-primary mt-4 inline-flex w-full items-center justify-center gap-2 disabled:opacity-60">
                {startingJob ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                Stage and validate migration
              </button>
            </div>
          </section>

        </>
      )}
      </div>

          {job && (
            <section className="card p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Workflow size={16} />
                    Run results
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Job {job.id} · {job.status}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={mergeValidatedJob} disabled={!jobCanMerge(job) || startingJob} className="btn-primary inline-flex items-center gap-2 text-xs disabled:opacity-50">
                    {startingJob ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
                    Publish validated
                  </button>
                  <button type="button" onClick={retryJob} className="btn-secondary inline-flex items-center gap-2 text-xs">Retry failed</button>
                  <button type="button" onClick={cancelJob} disabled={['succeeded', 'partial', 'failed', 'canceled'].includes(job.status)} className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-50">
                    <X size={13} />
                    Cancel
                  </button>
                </div>
              </div>
              <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                Model Migrator stages semantic YAML and dashboard metadata where Omni APIs expose them. {WORKBOOK_FIDELITY_DISCLOSURE}
              </div>
              <div className="max-h-[420px] overflow-auto rounded-card border border-border-subtle">
                {job.items.map((item) => (
                  <div key={item.id} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold uppercase tracking-wide text-content-primary">{item.kind}</div>
                        <div className="mt-0.5 truncate text-content-secondary">{item.documentName || item.targetModelName || item.targetModelId || 'Model step'}</div>
                      </div>
                      <span className={`rounded-chip px-2 py-0.5 font-semibold ${item.status === 'succeeded' ? 'bg-green-100 text-green-700' : item.status === 'failed' ? 'bg-red-100 text-red-700' : item.status === 'warning' ? 'bg-yellow-100 text-yellow-800' : 'bg-surface-secondary text-content-secondary'}`}>
                        {item.status}
                      </span>
                    </div>
                    {item.importedDocumentId && <div className="mt-1 text-content-secondary">Created document: {item.importedDocumentId}</div>}
                    {typeof item.details?.url === 'string' && (
                      <a href={item.details.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-omni-700 underline">
                        Open created document
                      </a>
                    )}
                    {item.warnings?.map((warning) => <div key={warning} className="mt-1 text-amber-700">{warning}</div>)}
                    {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
                    {item.kind === 'content_validate' && Array.isArray(item.details?.issues) && item.details.issues.length > 0 ? (
	                      <details className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
	                        <summary className="cursor-pointer font-semibold text-content-primary">Content validation punch list</summary>
	                        <div className="mt-2 max-h-48 space-y-2 overflow-auto">
	                          {(item.details.issues as Array<{ severity?: string; message?: string; documentName?: string; documentId?: string; field?: string; view?: string; status?: string; targetUrl?: string }>).map((issue, issueIndex) => (
	                            <div key={`${item.id}:issue:${issueIndex}`} className="rounded-card bg-white p-2">
	                              <div className={issue.severity === 'warning' ? 'font-semibold text-amber-700' : issue.severity === 'info' ? 'font-semibold text-content-secondary' : 'font-semibold text-red-700'}>
	                                {issue.severity || 'error'} · {issue.status || 'blocking'} · {issue.message || 'Validation issue'}
	                              </div>
	                              <div className="mt-1 text-content-secondary">
	                                {[issue.documentName || issue.documentId, issue.view, issue.field].filter(Boolean).join(' · ') || 'No document detail returned'}
	                              </div>
                                {issue.targetUrl && <a href={issue.targetUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-omni-700 underline">Open target</a>}
	                            </div>
	                          ))}
	                        </div>
	                      </details>
	                    ) : item.kind === 'content_validate' && item.details?.result ? (
	                      <details className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
	                        <summary className="cursor-pointer font-semibold text-content-primary">Content validation raw result</summary>
	                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-content-secondary">{JSON.stringify(item.details.result, null, 2)}</pre>
	                      </details>
	                    ) : null}
                    {item.kind === 'workbook_create' && Array.isArray(item.details?.tabs) ? (
                      <div className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
                        <div className="mb-1 font-semibold text-content-primary">Workbook tabs</div>
                        {(item.details.tabs as Array<{ name?: string; status?: string; carried?: string[]; retryBoundary?: string }>).map((tab, tabIndex) => (
                          <div key={`${item.id}:tab:${tabIndex}`} className="flex items-center justify-between gap-2 py-0.5 text-content-secondary">
                            <span>{tab.name || `Tab ${tabIndex + 1}`}</span>
                            <span>{tab.status || 'created'} · {(tab.carried || []).join(', ') || 'query'}{tab.retryBoundary ? ` · retry: ${tab.retryBoundary}` : ''}</span>
                          </div>
                        ))}
                        {Array.isArray(item.details.limitations) && (
                          <div className="mt-2 text-content-secondary">
                            {(item.details.limitations as string[]).join(' ')}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )}
    </div>
  );
}
