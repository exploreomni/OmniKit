import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { SavedInstanceRequiredEmptyState } from '@/components/layout/RequireConnection';
import { Blobby } from '@/components/ui/Blobby';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import {
  cancelOpsMigrationJob,
  createModelMigratorJob,
  getVaultStatus,
  getMigrationJob,
  listModelMigratorConnections,
  listModelMigratorModels,
  listSavedInstances,
  loadModelMigratorInventory,
  mergeModelMigratorJob,
  preflightModelMigratorWorkbooks,
  retryOpsMigrationJob,
  subscribeMigrationJob,
  translateModelMigratorYaml,
  type InstanceModel,
  type ModelMigratorConnection,
  type ModelMigratorInventoryDocument,
  type ModelMigratorInventoryRow,
  type ModelMigratorJobContentInput,
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

const MODEL_MIGRATOR_DRAFT_KEY = 'omnikit:modelMigratorDraft:v1';
const WIZARD_STEPS = ['Source', 'Target', 'Model translate/review', 'Apply & validate', 'Content scope', 'Run/results'];
const WORKBOOK_FIDELITY_DISCLOSURE = 'Workbook migration ports query presentations, tab names, descriptions, and visConfig where Omni APIs expose them. Schedules, alerts, permissions, sharing, favorites, workbook-level filters or parameters, and unexposed workbook artifacts are not moved automatically.';

type ModelPath = 'fast' | 'translate';

interface TranslationState {
  files: ModelMigratorTranslatedFile[];
  checksums: Record<string, string>;
  prompts: Array<{ fileName: string; prompt: string }>;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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
  if (item.kind === 'model_merge') return `Model branch merge ${item.status}: ${subject}`;
  if (item.kind === 'workbook_create') return `Workbook create ${item.status}: ${subject}`;
  if (item.kind === 'import') return `Dashboard import ${item.status}: ${subject}`;
  if (item.kind === 'post_action') return `Post-action ${item.status}: ${subject}`;
  return null;
}

function jobCanMerge(job: MigrationJob | null) {
  if (!job || job.workflow !== 'model') return false;
  if (job.items.some((item) => item.kind === 'model_merge')) return false;
  const validations = job.items.filter((item) => item.kind === 'model_validate');
  return validations.length > 0
    && validations.every((item) => item.status === 'succeeded')
    && ['succeeded', 'partial'].includes(job.status);
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
  const [skippedFilesByModelId, setSkippedFilesByModelId] = useState<Record<string, string[]>>({});
  const [workbookPreflights, setWorkbookPreflights] = useState<ModelMigratorWorkbookPreflight[]>([]);
  const [replaceSameNamed, setReplaceSameNamed] = useState(true);
  const [runAiDialectPass, setRunAiDialectPass] = useState(false);
  const [publishDrafts, setPublishDrafts] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [refreshSchemaAfterMigration, setRefreshSchemaAfterMigration] = useState(false);
  const [selectedPostActionIndexes, setSelectedPostActionIndexes] = useState<number[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const loggedTerminalJobs = useRef(new Set<string>());
  const loggedItemEvents = useRef(new Set<string>());
  const jobActive = job?.status === 'pending' || job?.status === 'running';

  const sourceInstances = useMemo(() => instances.filter(canUseAsSource), [instances]);
  const targetInstances = useMemo(() => instances.filter(canUseAsTarget), [instances]);
  const selectedSourceModels = useMemo(
    () => sourceModels.filter((model) => selectedSourceModelIds.includes(model.id)),
    [sourceModels, selectedSourceModelIds],
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
  const selectedDocuments = useMemo(() => allDocuments.filter((document) => selectedContentKeys.includes(contentKey(document))), [allDocuments, selectedContentKeys]);
  const selectedWorkbookDocs = selectedDocuments.filter((document) => document.kind === 'workbook');
  const selectedDashboardDocs = selectedDocuments.filter((document) => document.kind === 'dashboard');
  const translateReviewComplete = selectedSourceModels.every((model) => {
    if ((pathByModelId[model.id] || 'translate') === 'fast') return true;
    const translation = translationsByModelId[model.id];
    if (!translation?.files.length) return false;
    const accepted = acceptedFilesByModelId[model.id] || {};
    const skipped = new Set(skippedFilesByModelId[model.id] || []);
    return Object.keys(accepted).length > 0
      && translation.files.every((file) => file.blocked === true || accepted[file.fileName] !== undefined || skipped.has(file.fileName));
  });
  const targetInstance = targetInstances.find((instance) => instance.id === targetInstanceId);
  const selectedPostMigrationActions = useMemo(() => {
    const actions: PostMigrationAction[] = [];
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
        actions.push({ ...action, name: `${targetInstance.label}: ${action.name}` });
      }
    }
    return actions;
  }, [refreshSchemaAfterMigration, selectedPostActionIndexes, selectedSourceModels, targetInstance, targetModelBySourceId, targetModels]);
  const workbookBlockerCount = workbookPreflights.reduce((sum, row) => sum + row.blockerCount, 0);
  const canStartJob = selectedSourceModels.length > 0
    && selectedSourceModels.every((model) => targetModelBySourceId[model.id])
    && selectedSourceModels.every((model) => branchNameByModelId[model.id]?.trim())
    && selectedSourceModels.every((model) => pathByModelId[model.id] !== 'fast' || (modelSupportsFastPath(model) && fastPathConfirmedByModelId[model.id] === true))
    && translateReviewComplete
    && workbookBlockerCount === 0
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

  function clearModelScopedWorkflowState() {
    setSelectedSourceModelIds([]);
    setTargetModelBySourceId({});
    setInventory([]);
    setSelectedContentKeys([]);
    setPathByModelId({});
    setBranchNameByModelId({});
    setGitRefByModelId({});
    setFastPathConfirmedByModelId({});
    setTranslationsByModelId({});
    setAcceptedFilesByModelId({});
    setSkippedFilesByModelId({});
    setWorkbookPreflights([]);
  }

  function clearTargetScopedWorkflowState() {
    setTargetModelBySourceId({});
    setWorkbookPreflights([]);
  }

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
    if (typeof window === 'undefined') return;
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
      setReplaceSameNamed(parsed.replaceSameNamed !== false);
      setRunAiDialectPass(parsed.runAiDialectPass === true);
      setPublishDrafts(parsed.publishDrafts === true);
      setDeleteBranch(parsed.deleteBranch !== false);
      setRefreshSchemaAfterMigration(parsed.refreshSchemaAfterMigration === true);
      setSelectedPostActionIndexes(Array.isArray(parsed.selectedPostActionIndexes) ? parsed.selectedPostActionIndexes.filter((row): row is number => typeof row === 'number') : []);
    } catch {
      // Draft restore is convenience only.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
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
      replaceSameNamed,
      runAiDialectPass,
      publishDrafts,
      deleteBranch,
      refreshSchemaAfterMigration,
      selectedPostActionIndexes,
    };
    try {
      window.sessionStorage.setItem(MODEL_MIGRATOR_DRAFT_KEY, JSON.stringify(sanitizeModelMigratorDraftForStorage(draft)));
    } catch {
      // Draft persistence is best-effort.
    }
  }, [schemaMapText, selectedContentKeys, pathByModelId, branchNameByModelId, gitRefByModelId, fastPathConfirmedByModelId, translationsByModelId, acceptedFilesByModelId, skippedFilesByModelId, replaceSameNamed, runAiDialectPass, publishDrafts, deleteBranch, refreshSchemaAfterMigration, selectedPostActionIndexes]);

  useEffect(() => {
    if (!sourceInstanceId && sourceInstances.length > 0) setSourceInstanceId(sourceInstances[0].id);
    if (!targetInstanceId && targetInstances.length > 0) {
      const target = targetInstances.find((instance) => instance.id !== sourceInstanceId) || targetInstances[0];
      setTargetInstanceId(target.id);
    }
  }, [sourceInstances, targetInstances, sourceInstanceId, targetInstanceId]);

  useEffect(() => {
    let active = true;
    setSourceConnections([]);
    setSourceConnectionId('');
    setSourceModels([]);
    clearModelScopedWorkflowState();
    if (!sourceInstanceId) return () => { active = false; };
    setLoadingSource(true);
    listModelMigratorConnections(sourceInstanceId)
      .then((result) => {
        if (!active) return;
        setSourceConnections(result.connections);
        setSourceConnectionId(result.connections[0]?.id || '');
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load source connections.'));
      })
      .finally(() => {
        if (active) setLoadingSource(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId]);

  useEffect(() => {
    let active = true;
    setTargetConnections([]);
    setTargetConnectionId('');
    setTargetModels([]);
    clearTargetScopedWorkflowState();
    if (!targetInstanceId) return () => { active = false; };
    setLoadingTarget(true);
    listModelMigratorConnections(targetInstanceId)
      .then((result) => {
        if (!active) return;
        setTargetConnections(result.connections);
        setTargetConnectionId(result.connections[0]?.id || '');
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load target connections.'));
      })
      .finally(() => {
        if (active) setLoadingTarget(false);
      });
    return () => { active = false; };
  }, [targetInstanceId]);

  useEffect(() => {
    let active = true;
    setSourceModels([]);
    clearModelScopedWorkflowState();
    if (!sourceInstanceId || !sourceConnectionId) return () => { active = false; };
    setLoadingSource(true);
    listModelMigratorModels(sourceInstanceId, { connectionId: sourceConnectionId })
      .then((result) => {
        if (!active) return;
        setSourceModels(result.models);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load source models.'));
      })
      .finally(() => {
        if (active) setLoadingSource(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId, sourceConnectionId]);

  useEffect(() => {
    let active = true;
    setTargetModels([]);
    clearTargetScopedWorkflowState();
    if (!targetInstanceId || !targetConnectionId) return () => { active = false; };
    setLoadingTarget(true);
    listModelMigratorModels(targetInstanceId, { connectionId: targetConnectionId })
      .then((result) => {
        if (active) setTargetModels(result.models);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load target models.'));
      })
      .finally(() => {
        if (active) setLoadingTarget(false);
      });
    return () => { active = false; };
  }, [targetInstanceId, targetConnectionId]);

  useEffect(() => {
    setSelectedSourceModelIds((current) => current.filter((id) => sourceModels.some((model) => model.id === id)));
  }, [sourceModels]);

  useEffect(() => {
    setTargetModelBySourceId((current) => {
      const next: Record<string, string> = {};
      for (const sourceModel of selectedSourceModels) {
        const existing = current[sourceModel.id];
        if (existing && targetModels.some((model) => model.id === existing)) {
          next[sourceModel.id] = existing;
          continue;
        }
        const match = targetModels.find((model) => (
          model.name.toLowerCase() === sourceModel.name.toLowerCase()
          || (model.identifier && sourceModel.identifier && model.identifier.toLowerCase() === sourceModel.identifier.toLowerCase())
        ));
        next[sourceModel.id] = match?.id || '';
      }
      return next;
    });
  }, [selectedSourceModels, targetModels]);

  useEffect(() => {
    setPathByModelId((current) => {
      const next: Record<string, ModelPath> = {};
      for (const model of selectedSourceModels) next[model.id] = current[model.id] || (modelSupportsFastPath(model) ? 'fast' : 'translate');
      return next;
    });
    setBranchNameByModelId((current) => {
      const next: Record<string, string> = {};
      for (const model of selectedSourceModels) next[model.id] = current[model.id] || defaultBranchName(model);
      return next;
    });
  }, [selectedSourceModels]);

  useEffect(() => {
    let active = true;
    if (!sourceInstanceId || selectedSourceModelIds.length === 0) {
      setInventory([]);
      return () => { active = false; };
    }
    setLoadingInventory(true);
    loadModelMigratorInventory(sourceInstanceId, selectedSourceModelIds)
      .then((result) => {
        if (active) setInventory(result.models);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load source content inventory.'));
      })
      .finally(() => {
        if (active) setLoadingInventory(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId, selectedSourceModelIds]);

  function toggleSourceModel(modelId: string) {
    if (jobActive) return;
    setSelectedSourceModelIds((current) => (
      current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]
    ));
  }

  function selectAllSourceModels() {
    if (jobActive) return;
    setSelectedSourceModelIds(sourceModels.map((model) => model.id));
  }

  function clearSourceModels() {
    if (jobActive) return;
    setSelectedSourceModelIds([]);
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

  async function translateSelectedModels() {
    if (jobActive) return;
    setTranslating(true);
    setError('');
    setMessage('');
    try {
      const nextTranslations: Record<string, TranslationState> = { ...translationsByModelId };
      const nextAccepted: Record<string, Record<string, string>> = { ...acceptedFilesByModelId };
      const nextSkipped: Record<string, string[]> = { ...skippedFilesByModelId };
      const sourceDialect = sourceConnections.find((connection) => connection.id === sourceConnectionId)?.dialect || '';
      const targetDialect = targetConnections.find((connection) => connection.id === targetConnectionId)?.dialect || '';
      for (const model of selectedSourceModels.filter((row) => pathByModelId[row.id] !== 'fast')) {
        const result = await translateModelMigratorYaml({
          sourceInstanceId,
          modelId: model.id,
          schemaMapText,
          sourceDialect,
          targetDialect,
          runAi: runAiDialectPass,
        });
        nextTranslations[model.id] = result;
        nextAccepted[model.id] = {};
        nextSkipped[model.id] = [];
      }
      setTranslationsByModelId(nextTranslations);
      setAcceptedFilesByModelId(nextAccepted);
      setSkippedFilesByModelId(nextSkipped);
      setMessage('Model YAML translated. Accept, edit, or skip each file before running.');
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
    return Object.entries(accepted).map(([fileName, yaml]) => ({
      fileName,
      yaml,
      previousChecksum: checksums[fileName],
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
        replaceSameNamed,
        mergeAfterValidation: false,
        publishDrafts,
        deleteBranch,
        models: selectedSourceModels.map((model) => {
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
            mergeHandoffRequired: modelRequiresMergeHandoff(targetModel),
            acceptedFiles: mode === 'translate' ? acceptedFilesForModel(model.id) : undefined,
          };
        }),
        content: contentInputs(),
        postMigrationActions: selectedPostMigrationActions,
      });
      setJob(result.job);
      setMessage('Model migration job started.');
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
      <PageHeader
        title="Model Migrator"
        description="Move semantic models between saved Omni instances and connections, then stage dashboard and workbook content for the migration handoff."
        icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={(
          <button type="button" onClick={refreshVault} className="btn-secondary inline-flex items-center gap-2 text-sm">
            <RefreshCw size={14} />
            Refresh
          </button>
        )}
      />

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div aria-live="polite" className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

      <div className="grid gap-3 lg:grid-cols-6">
        {WIZARD_STEPS.map((step, index) => (
          <StepPill key={step} index={index + 1} label={step} active={index < 2 || selectedSourceModels.length > 0} />
        ))}
      </div>

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
            <button type="button" onClick={() => navigate('/instances')} className="btn-primary inline-flex items-center gap-2 text-sm">
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
                    Source model set
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Saved source instance, connection, and shared models.</p>
                </div>
                {loadingSource && <Loader2 size={16} className="animate-spin text-content-secondary" />}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SelectField label="Source instance" value={sourceInstanceId} onChange={setSourceInstanceId} disabled={jobActive}>
                  <EmptyValue>Choose source instance</EmptyValue>
                  {sourceInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label} · {roleLabel(instance.role)} · {hostLabel(instance.baseUrl)}</option>
                  ))}
                </SelectField>
                <SelectField label="Source connection" value={sourceConnectionId} onChange={setSourceConnectionId} disabled={jobActive || !sourceInstanceId || sourceConnections.length === 0}>
                  <EmptyValue>{sourceConnections.length === 0 ? 'No connections loaded' : 'Choose connection'}</EmptyValue>
                  {sourceConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>
                  ))}
                </SelectField>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-content-secondary">
                  {sourceModels.length} models loaded · {selectedSourceModelIds.length} selected
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAllSourceModels} disabled={jobActive || sourceModels.length === 0} className="btn-secondary text-xs disabled:opacity-50">Select all</button>
                  <button type="button" onClick={clearSourceModels} disabled={jobActive || selectedSourceModelIds.length === 0} className="btn-secondary text-xs disabled:opacity-50">Clear</button>
                </div>
              </div>

              <div className="mt-3 max-h-[360px] overflow-auto rounded-card border border-border-subtle">
                {sourceModels.length === 0 ? (
                  <div className="p-5 text-sm text-content-secondary">No source models are available for the selected connection.</div>
                ) : sourceModels.map((model) => {
                  const selected = selectedSourceModelIds.includes(model.id);
                  const row = inventoryByModel.get(model.id);
                  return (
                    <button
                      type="button"
                      key={model.id}
                      onClick={() => toggleSourceModel(model.id)}
                      disabled={jobActive}
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
              </div>
            </section>

            <section className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <GitBranch size={16} />
                    Target landing map
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Saved target instance, connection, and target model selection per source.</p>
                </div>
                {loadingTarget && <Loader2 size={16} className="animate-spin text-content-secondary" />}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SelectField label="Target instance" value={targetInstanceId} onChange={setTargetInstanceId} disabled={jobActive}>
                  <EmptyValue>Choose target instance</EmptyValue>
                  {targetInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label} · {roleLabel(instance.role)} · {hostLabel(instance.baseUrl)}</option>
                  ))}
                </SelectField>
                <SelectField label="Target connection" value={targetConnectionId} onChange={setTargetConnectionId} disabled={jobActive || !targetInstanceId || targetConnections.length === 0}>
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
                ) : selectedSourceModels.map((sourceModel) => (
                  <div key={sourceModel.id} className="rounded-card border border-border-subtle p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-content-primary">{sourceModel.name || sourceModel.id}</div>
                        <div className="truncate font-mono text-[11px] text-content-tertiary">{sourceModel.id}</div>
                      </div>
                      <ArrowRight size={14} className="flex-shrink-0 text-content-tertiary" />
                    </div>
                    <select
                      value={targetModelBySourceId[sourceModel.id] || ''}
                      onChange={(event) => setTargetModelBySourceId((current) => ({ ...current, [sourceModel.id]: event.target.value }))}
                      disabled={jobActive || targetModels.length === 0}
                      className="input-field"
                    >
                      <option value="">{targetModels.length === 0 ? 'No target models loaded' : 'Choose target model'}</option>
                      {targetModels.map((model) => (
                        <option key={model.id} value={model.id}>{modelLabel(model)}</option>
                      ))}
                    </select>
	                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Model path</span>
                        <select
                          value={pathByModelId[sourceModel.id] || 'translate'}
                          onChange={(event) => setPathByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value as ModelPath }))}
                          className="input-field"
                          disabled={jobActive}
                        >
                          <option value="translate">Translate pipeline</option>
                          <option value="fast" disabled={!modelSupportsFastPath(sourceModel)}>Fast path {modelSupportsFastPath(sourceModel) ? '' : '(git required)'}</option>
                        </select>
                      </label>
	                      <label className="block">
	                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Dev branch</span>
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
	                          <span>I confirm the source and target schemas are identical enough for Omni's fast path. OmniKit will still validate before merge.</span>
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
	                        Target model appears git/PR protected. OmniKit will stage and validate, then record a PR handoff instead of forcing merge settings.
	                      </div>
	                    )}
	                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="card p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                  <FileText size={16} />
                  Content inventory
                </div>
                <p className="mt-1 text-xs text-content-secondary">Documents built on the selected source models, split into dashboard and workbook-only evidence where Omni metadata exposes it.</p>
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
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <div className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Layers3 size={16} />
                    Model translate/review
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Apply deterministic schema rewrites, generate review prompts, and choose accepted files for branch-only writes. Main branches are never written by this step.</p>
                </div>
	                <button type="button" onClick={translateSelectedModels} disabled={jobActive || translating || selectedSourceModels.length === 0} className="btn-primary inline-flex items-center gap-2 text-xs disabled:opacity-60">
	                  {translating ? <Loader2 size={13} className="animate-spin" /> : <Workflow size={13} />}
	                  Translate
	                </button>
	              </div>
	              <label className="mb-3 flex items-start gap-2 rounded-card border border-border-subtle bg-surface-secondary p-3 text-xs text-content-secondary">
	                <input
	                  type="checkbox"
	                  className="mt-0.5"
	                  checked={runAiDialectPass}
	                  onChange={(event) => setRunAiDialectPass(event.target.checked)}
                    disabled={jobActive}
	                />
	                <span>Run Omni AI dialect pass after deterministic schema rewrites. AI output is a reviewed draft and never writes until accepted.</span>
	              </label>
	              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-content-secondary">Schema map</span>
                <textarea
                  value={schemaMapText}
                  onChange={(event) => setSchemaMapText(event.target.value)}
                  className="input-field min-h-[88px]"
                  disabled={jobActive}
                  placeholder="ANALYTICS.PUBLIC -> main.analytics"
                />
              </label>
              <div className="mt-4 space-y-3">
                {selectedSourceModels.filter((model) => pathByModelId[model.id] !== 'fast').length === 0 ? (
                  <div className="rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">Translate pipeline models will appear here.</div>
                ) : selectedSourceModels.filter((model) => pathByModelId[model.id] !== 'fast').map((model) => {
                  const translation = translationsByModelId[model.id];
                  return (
                    <div key={model.id} className="rounded-card border border-border-subtle p-3">
                      <div className="mb-2 text-sm font-semibold text-content-primary">{model.name}</div>
                      {!translation ? (
                        <div className="text-xs text-content-secondary">Run Translate to load YAML and prepare accepted files.</div>
                      ) : (
                        <div className="space-y-2">
	                          {translation.files.map((file) => {
	                            const accepted = acceptedFilesByModelId[model.id]?.[file.fileName] !== undefined;
	                            const skipped = (skippedFilesByModelId[model.id] || []).includes(file.fileName);
                              const acceptedValue = acceptedFilesByModelId[model.id]?.[file.fileName];
                              const activeDraft = fileDraft(file);
                              const edited = accepted && acceptedValue !== activeDraft;
	                            const decision = file.blocked ? 'Blocked' : skipped ? 'Skipped' : accepted ? edited ? 'Edited' : 'Accepted' : 'Needs decision';
	                            return (
	                              <details key={file.fileName} className="rounded-card border border-border-subtle bg-white">
	                                <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-content-primary">
	                                  <span>{file.fileName}</span>
                                    <span className="flex flex-wrap items-center justify-end gap-2">
                                      {file.aiDraft && !skipped && (
                                        <span className="rounded-chip bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                                          AI draft needs review
                                        </span>
                                      )}
	                                    <span className={file.blocked ? 'text-red-700' : skipped ? 'text-content-secondary' : accepted ? 'text-green-700' : 'text-amber-700'}>{decision}</span>
                                    </span>
	                                </summary>
	                                <div className="border-t border-border-subtle p-3">
	                                  {file.warnings.map((warning) => <div key={warning} className="mb-2 rounded-card bg-amber-50 px-2 py-1 text-xs text-amber-800">{warning}</div>)}
                                    {file.aiJobId && <div className="mb-2 rounded-card bg-blue-50 px-2 py-1 text-xs text-blue-800">Omni AI job: {file.aiJobId}</div>}
                                    {file.aiRefusal && <div className="mb-2 rounded-card bg-red-50 px-2 py-1 text-xs text-red-800">{file.aiRefusal}</div>}
	                                  <div className="mb-2 flex flex-wrap gap-2 text-xs">
	                                    <button
	                                      type="button"
	                                      className="btn-secondary text-xs"
                                        disabled={file.blocked}
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
                                      {file.aiDraft && (
                                        <button
                                          type="button"
                                          className="btn-secondary text-xs"
                                          disabled={file.blocked}
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
                                        disabled={file.blocked}
                                        onClick={() => {
                                          setAcceptedFilesByModelId((current) => ({
                                            ...current,
                                            [model.id]: { ...(current[model.id] || {}), [file.fileName]: current[model.id]?.[file.fileName] ?? activeDraft },
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
                                        disabled={file.blocked}
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
	                                    <label className="block">
	                                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Accepted output</span>
	                                      <textarea
	                                        value={acceptedFilesByModelId[model.id]?.[file.fileName] ?? activeDraft}
	                                        onChange={(event) => setAcceptedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: { ...(current[model.id] || {}), [file.fileName]: event.target.value },
	                                        }))}
	                                        onFocus={() => setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
	                                        }))}
	                                        className="input-field min-h-[288px] font-mono text-[11px]"
	                                        disabled={skipped || file.blocked}
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
                    Preflight and run
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Validate workbook query portability, then run the unified branch/workbook job. Apply and validate writes only to target dev branches; use Merge validated later to merge.</p>
                </div>
                <button type="button" onClick={preflightWorkbooks} disabled={jobActive || preflighting || selectedWorkbookDocs.length === 0} className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-60">
                  {preflighting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Preflight
                </button>
              </div>
              <div className="grid gap-2 text-xs text-content-secondary sm:grid-cols-2">
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={replaceSameNamed} onChange={(event) => setReplaceSameNamed(event.target.checked)} disabled={jobActive} />
	                  <span>Replace same-named workbook docs in the target folder.</span>
	                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={publishDrafts} onChange={(event) => setPublishDrafts(event.target.checked)} disabled={jobActive} />
	                  <span>Publish drafts when you later merge validated branches.</span>
	                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
		                  <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} disabled={jobActive} />
		                  <span>Delete branch after merge.</span>
		                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={refreshSchemaAfterMigration} onChange={(event) => setRefreshSchemaAfterMigration(event.target.checked)} disabled={jobActive} />
	                  <span>Refresh target schema models after the run.</span>
	                </label>
	              </div>
	              {targetInstance?.postMigrationActions.length ? (
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
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{selectedDashboardDocs.length}</div><div className="text-content-secondary">Dashboards</div></div>
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{selectedWorkbookDocs.length}</div><div className="text-content-secondary">Workbooks</div></div>
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
                Run Model Migrator
              </button>
            </div>
          </section>

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
                    Merge validated
                  </button>
                  <button type="button" onClick={retryJob} className="btn-secondary inline-flex items-center gap-2 text-xs">Retry failed</button>
                  <button type="button" onClick={cancelJob} disabled={['succeeded', 'partial', 'failed', 'canceled'].includes(job.status)} className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-50">
                    <X size={13} />
                    Cancel
                  </button>
                </div>
              </div>
              <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                Model Migrator ports semantic YAML and dashboard metadata where Omni APIs expose them. {WORKBOOK_FIDELITY_DISCLOSURE}
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
        </>
      )}
    </div>
  );
}
