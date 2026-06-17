import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Database,
  FileText,
  FolderInput,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  cancelOpsMigrationJob,
  createOpsMigrationJob,
  getMigrationJob,
  getVaultStatus,
  listInstanceDocuments,
  listMigrationJobs,
  listSavedInstances,
  previewMigrationJob,
  retryOpsMigrationJob,
  subscribeMigrationJob,
  unlockNativeVault,
  type InstanceDocument,
  type MigrationJobInput,
  type MigrationJob,
  type MigrationPlan,
  type PostMigrationAction,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { SearchInput } from '@/components/ui/SearchInput';
import { ComboBox } from '@/components/ui/ComboBox';
import { PassphraseInput } from '@/components/ui/PassphraseInput';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { StatusChip } from '@/components/ui/StatusChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useConfetti } from '@/hooks/useConfetti';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { FixPanel } from './FixPanel';
import {
  targetDraftToMigrationTarget,
  type FanoutDraft,
  type FanoutStep,
  type PreflightTargetRow,
  type TargetDraft,
} from './fanoutTypes';
import {
  clearFanoutDraft,
  loadFanoutDraft,
  saveFanoutDraft,
} from './fanoutStorage';
import { useTargetCatalog } from './useTargetCatalog';
import {
  completedItem,
  combineMigrationPlans,
  estimateDurationSeconds,
  applySelectedSourceModelFallback,
  buildTargetFolderOptions,
  buildTargetModelOptions,
  canContinueFromSourceStep,
  cleanFanoutModelMetadata as cleanModelMetadata,
  fanoutDocumentModelLabel,
  getFanoutPreflightBlockReason,
  isTerminalJobStatus,
  preflightRowsFromPlan,
  preserveSelectedDocumentIds,
  removeTargetFromMigrationPlan,
  statusClass,
  summarizeJobByDestination,
  TARGET_FOLDER_COMBOBOX_CONFIG,
  TARGET_MODEL_COMBOBOX_CONFIG,
} from './fanoutUtils';

const STEP_LABELS = ['Source', 'Targets', 'Preflight', 'Run'];
const CATALOG_RECHECK_BATCH_SIZE = 5;
const PREFLIGHT_PREVIEW_TIMEOUT_MS = 30_000;

type ConfirmAction = 'empty-first' | 'cancel' | null;

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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

function previewMigrationJobWithTimeout(input: MigrationJobInput) {
  return withTimeout(
    previewMigrationJob(input),
    PREFLIGHT_PREVIEW_TIMEOUT_MS,
    'Compatibility preflight timed out before OmniKit received a response. No changes were applied. Try Re-check all, then run preflight again.',
  );
}

function makeTargetId(destinationInstanceId: string) {
  return `${destinationInstanceId || 'destination'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(value?: string | number) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function metadataMissing(document: InstanceDocument) {
  return !document.description?.trim() || !document.labels?.length;
}

function actionKey(instanceId: string, index: number) {
  return `${instanceId}:${index}`;
}

function migrationJobDone(job: MigrationJob | null) {
  if (!job) return false;
  return isTerminalJobStatus(job.status);
}

export function FanOutWizard() {
  const initialDraft = typeof window === 'undefined' ? null : loadFanoutDraft();
  const [step, setStep] = useState<FanoutStep>(initialDraft?.step ?? 0);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceId, setSourceId] = useState(initialDraft?.sourceId ?? '');
  const [sourceModelId, setSourceModelId] = useState(initialDraft?.sourceModelId ?? '');
  const [sourceFolderId, setSourceFolderId] = useState(initialDraft?.sourceFolderId ?? '');
  const [sourceFolderPath, setSourceFolderPath] = useState(initialDraft?.sourceFolderPath ?? '');
  const [documents, setDocuments] = useState<InstanceDocument[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>(initialDraft?.selectedDocumentIds ?? []);
  const [targets, setTargets] = useState<TargetDraft[]>(initialDraft?.targets ?? []);
  const [metadataOnly, setMetadataOnly] = useState(initialDraft?.metadataOnly ?? false);
  const [emptyFirst, setEmptyFirst] = useState(initialDraft?.emptyFirst ?? false);
  const [replaceSameNamed, setReplaceSameNamed] = useState(initialDraft?.replaceSameNamed ?? true);
  const [refreshSchemaAfterImport, setRefreshSchemaAfterImport] = useState(initialDraft?.refreshSchemaAfterImport ?? false);
  const [search, setSearch] = useState('');
  const [bulkFolderPath, setBulkFolderPath] = useState('');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [preflightRows, setPreflightRows] = useState<PreflightTargetRow[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [fixPanelOpen, setFixPanelOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const { catalogs, loadCatalog, hydrateTargetFromCatalog } = useTargetCatalog();
  const fireConfetti = useConfetti();
  const logOperation = useLogOperation();
  const jobRef = useRef<MigrationJob | null>(null);

  const sourceInstances = instances.filter((instance) => instance.role === 'source' || instance.role === 'both');
  const destinationInstances = instances.filter((instance) => instance.role === 'destination' || instance.role === 'both');
  const source = instances.find((instance) => instance.id === sourceId);
  const sourceCatalog = catalogs[sourceId];
  const sourceModels = useMemo(() => sourceCatalog?.models || [], [sourceCatalog?.models]);
  const sourceFolders = sourceCatalog?.folders || [];
  const creatingVault = vaultStatus?.exists === false;
  const passphraseMatches = !creatingVault || passphrase === passphraseConfirm;
  const passphraseMeetsMinimum = !creatingVault || passphrase.trim().length >= 8;
  const canUnlockVault = Boolean(passphrase.trim()) && !unlocking && passphraseMatches && passphraseMeetsMinimum;
  const { sourceModelNameById, sourceModelKeysById } = useMemo(() => {
    const names = new Map<string, string>();
    const keysById = new Map<string, Set<string>>();
    for (const model of sourceModels) {
      const label = cleanModelMetadata(model.name) || cleanModelMetadata(model.identifier) || model.id;
      const keys = [model.id, model.identifier, model.baseModelId, model.name]
        .map(cleanModelMetadata)
        .filter((value): value is string => Boolean(value));
      keysById.set(model.id, new Set(keys));
      for (const key of keys) {
        if (!names.has(key)) names.set(key, label);
      }
    }
    return { sourceModelNameById: names, sourceModelKeysById: keysById };
  }, [sourceModels]);

  const migrationTargets = useMemo(
    () => targets.map((target) => targetDraftToMigrationTarget(target, instances)),
    [instances, targets],
  );
  const selectedDocuments = documents.filter((document) => selectedDocumentIds.includes(document.identifier));
  const selectedMetadataMissing = selectedDocuments.filter(metadataMissing);
  const hasLoadingTargets = targets.some((target) => target.destinationInstanceId && catalogs[target.destinationInstanceId]?.loading);
  const hasUnresolvedFolderTargets = targets.some((target) => Boolean(target.targetFolderId && !target.targetFolderPath));
  const canContinueSource = canContinueFromSourceStep(selectedDocumentIds, fixPanelOpen);
  const preflightBlockReason = getFanoutPreflightBlockReason({
    sourceId,
    selectedDocumentIds,
    targets: migrationTargets,
    hasLoadingTargets,
    hasUnresolvedFolderTargets,
    preflightLoading,
    jobBusy,
  });
  const canPreflight = !preflightBlockReason;
  const blockedPreflightRows = preflightRows.filter((row) => row.status === 'blocked');
  const canRun = Boolean(plan && preflightRows.length > 0 && blockedPreflightRows.length === 0 && !preflightBlockReason && !jobBusy);
  const overSoftCap = targets.length > 10;
  const durationSeconds = estimateDurationSeconds(plan);
  const destinationProgress = summarizeJobByDestination(job);
  const exportItems = job?.items.filter((item) => item.kind === 'export') || [];
  const exportDocumentIds = [...new Set(exportItems.map((item) => item.documentId).filter((item): item is string => Boolean(item)))];
  const exportDone = exportDocumentIds.filter((documentId) => (
    exportItems.some((item) => item.documentId === documentId && completedItem(item))
  )).length;
  const plannedDeleteCount = plan?.steps.filter((step) => step.kind === 'delete').length || 0;

  const filteredDocuments = useMemo(() => {
    const normalized = search.toLowerCase();
    return documents.filter((document) => {
      if (sourceModelId) {
        const allowedKeys = sourceModelKeysById.get(sourceModelId) || new Set([sourceModelId]);
        const documentKeys = [cleanModelMetadata(document.baseModelId), cleanModelMetadata(document.baseModelName)]
          .filter((value): value is string => Boolean(value));
        if (documentKeys.length === 0 || !documentKeys.some((value) => allowedKeys.has(value))) return false;
      }
      if (metadataOnly && !metadataMissing(document)) return false;
      if (!normalized) return true;
      return [
        document.name,
        document.identifier,
        document.folderPath,
        cleanModelMetadata(document.baseModelName),
        cleanModelMetadata(document.baseModelId),
        ...(document.labels || []),
      ].some((value) => value?.toLowerCase().includes(normalized));
    });
  }, [documents, metadataOnly, search, sourceModelId, sourceModelKeysById]);

  const selectedPostMigrationActions = useMemo(() => {
    const actions: PostMigrationAction[] = [];
    for (const target of targets) {
      const destination = instances.find((instance) => instance.id === target.destinationInstanceId);
      if (!destination) continue;
      if (refreshSchemaAfterImport && target.targetModelId) {
        actions.push({
          kind: 'refresh-schema',
          name: `${destination.label}: refresh schema model ${target.targetModelName || target.targetModelId}`,
          method: 'POST',
          url: '',
          headers: {},
          body: '',
          destinationInstanceId: destination.id,
          targetModelId: target.targetModelId,
          targetModelName: target.targetModelName || target.targetModelId,
        });
      }
      for (const index of target.selectedActionIndexes) {
        const action = destination.postMigrationActions[index];
        if (!action) continue;
        actions.push({
          ...action,
          name: `${destination.label}: ${action.name}`,
        });
      }
    }
    return actions;
  }, [instances, refreshSchemaAfterImport, targets]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const status = await getVaultStatus();
      setVaultStatus(status);
      if (!status.unlocked) {
        setInstances([]);
        return;
      }
      const [instancesRes, jobsRes] = await Promise.all([
        listSavedInstances(),
        listMigrationJobs(),
      ]);
      setInstances(instancesRes.instances);
      const running = jobsRes.jobs.find((row) => row.status === 'running' || row.status === 'pending');
      if (running && !jobRef.current) {
        setJob(running);
        setStep(3);
      }
    } catch (err) {
      setError(errorText(err, 'Could not load fan-out migration state.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const draft: FanoutDraft = {
      step,
      sourceId,
      sourceModelId,
      sourceFolderId,
      sourceFolderPath,
      selectedDocumentIds,
      targets,
      emptyFirst,
      replaceSameNamed,
      metadataOnly,
      refreshSchemaAfterImport,
    };
    saveFanoutDraft(draft);
  }, [
    emptyFirst,
    metadataOnly,
    refreshSchemaAfterImport,
    replaceSameNamed,
    selectedDocumentIds,
    sourceFolderId,
    sourceFolderPath,
    sourceId,
    sourceModelId,
    step,
    targets,
  ]);

  useEffect(() => {
    if (!sourceId || !vaultStatus?.unlocked) return;
    void loadCatalog(sourceId);
  }, [loadCatalog, sourceId, vaultStatus?.unlocked]);

  const missingDestinationCatalogKey = useMemo(() => {
    if (!vaultStatus?.unlocked || targets.length === 0) return '';
    return [...new Set(
      targets
        .map((target) => target.destinationInstanceId)
        .filter((instanceId) => instanceId && !catalogs[instanceId]),
    )].join('|');
  }, [catalogs, targets, vaultStatus?.unlocked]);

  useEffect(() => {
    const missingIds = missingDestinationCatalogKey.split('|').filter(Boolean);
    if (missingIds.length === 0) return undefined;
    let canceled = false;
    void (async () => {
      for (const instanceId of missingIds) {
        const catalog = await loadCatalog(instanceId);
        if (canceled) return;
        setTargets((prev) => prev.map((target) => (
          target.destinationInstanceId === instanceId ? hydrateTargetFromCatalog(target, catalog) : target
        )));
      }
    })();
    return () => {
      canceled = true;
    };
  }, [hydrateTargetFromCatalog, loadCatalog, missingDestinationCatalogKey]);

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
            logOperation('migration', `Fan-out migration ${event.job.status}`, {
              itemCount: event.job.items.length,
              successCount: successful,
              failureCount: failed,
              durationMs: event.job.startedAt ? Date.now() - event.job.startedAt : 0,
            });
            if (event.job.status === 'succeeded' || event.job.status === 'partial') clearFanoutDraft();
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
          // The user can refresh manually; avoid interrupting an in-progress board.
        }
      },
    );
    return () => {
      closed = true;
      unsubscribe();
    };
  }, [fireConfetti, job?.id, job?.status, logOperation]);

  function resetPreflight() {
    setPlan(null);
    setPreflightRows([]);
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

  function chooseSource(nextSourceId: string) {
    const nextSource = instances.find((instance) => instance.id === nextSourceId);
    setSourceId(nextSourceId);
    setSourceModelId('');
    setSourceFolderId(nextSource?.defaultFolderId || '');
    setSourceFolderPath(nextSource?.defaultFolderPath || '');
    setDocuments([]);
    setSelectedDocumentIds([]);
    setTargets([]);
    resetPreflight();
    setJob(null);
    setMessage(nextSourceId ? 'Source selected. Load dashboards after choosing the source model or use all models.' : '');
    if (nextSourceId) void loadCatalog(nextSourceId);
  }

  function chooseSourceFolder(nextFolderPath: string) {
    const folder = sourceFolders.find((row) => row.path === nextFolderPath || row.identifier === nextFolderPath || row.id === nextFolderPath);
    if (!nextFolderPath) {
      setSourceFolderId('');
      setSourceFolderPath('');
    } else {
      setSourceFolderId(folder?.id || '');
      setSourceFolderPath(folder?.path || nextFolderPath);
    }
    setDocuments([]);
    setSelectedDocumentIds([]);
    resetPreflight();
    setJob(null);
  }

  async function loadDocuments(nextSourceId = sourceId, options: { preserveSelection?: boolean } = {}) {
    if (!nextSourceId) return;
    setLoadingDocuments(true);
    setError('');
    setMessage('');
    resetPreflight();
    try {
      const res = await listInstanceDocuments(nextSourceId, {
        folderId: sourceFolderId || undefined,
        folderPath: sourceFolderPath || undefined,
        includeModelDetails: true,
      });
      const nextDocuments = applySelectedSourceModelFallback(res.documents, {
        sourceModelId,
        sourceModels,
        sourceFolderId,
        sourceFolderPath,
      });
      setDocuments(nextDocuments);
      if (options.preserveSelection) {
        setSelectedDocumentIds((prev) => preserveSelectedDocumentIds(prev, nextDocuments));
      } else {
        setSelectedDocumentIds([]);
      }
      setMessage(`Loaded ${nextDocuments.length} dashboard document${nextDocuments.length === 1 ? '' : 's'} from the source folder.`);
    } catch (err) {
      setDocuments([]);
      if (!options.preserveSelection) setSelectedDocumentIds([]);
      setError(errorText(err, 'Could not load source dashboards.'));
    } finally {
      setLoadingDocuments(false);
    }
  }

  function toggleDocument(identifier: string) {
    setSelectedDocumentIds((prev) => prev.includes(identifier) ? prev.filter((item) => item !== identifier) : [...prev, identifier]);
    resetPreflight();
  }

  function selectAllVisibleDocuments() {
    setSelectedDocumentIds([...new Set([...selectedDocumentIds, ...filteredDocuments.map((document) => document.identifier)])]);
    resetPreflight();
  }

  function clearDocumentSelection() {
    setSelectedDocumentIds([]);
    resetPreflight();
  }

  async function toggleDestination(instance: SavedInstancePublic) {
    resetPreflight();
    setJob(null);
    const existing = targets.find((target) => target.destinationInstanceId === instance.id);
    if (existing) {
      setTargets((prev) => prev.filter((target) => target.destinationInstanceId !== instance.id));
      return;
    }
    const draft: TargetDraft = {
      id: makeTargetId(instance.id),
      destinationInstanceId: instance.id,
      targetModelId: instance.defaultModelId || '',
      targetModelName: instance.defaultModelId || '',
      targetFolderId: instance.defaultFolderId || '',
      targetFolderPath: instance.defaultFolderPath || '',
      selectedActionIndexes: [],
    };
    setTargets((prev) => [...prev, draft]);
    const catalog = await loadCatalog(instance.id);
    setTargets((prev) => prev.map((target) => (
      target.id === draft.id ? hydrateTargetFromCatalog(target, catalog) : target
    )));
  }

  function updateTarget(id: string, patch: Partial<TargetDraft>) {
    setTargets((prev) => prev.map((target) => {
      if (target.id !== id) return target;
      const next = { ...target, ...patch };
      if (patch.targetModelId !== undefined) {
        const model = catalogs[next.destinationInstanceId]?.models.find((row) => row.id === patch.targetModelId);
        next.targetModelName = model?.name || patch.targetModelId || '';
      }
      if (patch.targetFolderPath !== undefined) {
        if (!patch.targetFolderPath) {
          next.targetFolderId = '';
          next.targetFolderPath = '';
        } else {
          const folder = catalogs[next.destinationInstanceId]?.folders.find((row) => row.path === patch.targetFolderPath || row.id === patch.targetFolderPath);
          next.targetFolderId = folder?.id || '';
          next.targetFolderPath = folder?.path || patch.targetFolderPath;
        }
      }
      return next;
    }));
    resetPreflight();
  }

  async function hydrateDestinationCatalogs(instanceIds: string[], options?: { force?: boolean }) {
    const uniqueIds = [...new Set(instanceIds.filter(Boolean))];
    if (uniqueIds.length === 0) return;
    setCatalogRefreshing(true);
    try {
      for (let index = 0; index < uniqueIds.length; index += CATALOG_RECHECK_BATCH_SIZE) {
        const chunk = uniqueIds.slice(index, index + CATALOG_RECHECK_BATCH_SIZE);
        const loaded = await Promise.all(chunk.map(async (instanceId) => ({
          instanceId,
          catalog: await loadCatalog(instanceId, options),
        })));
        setTargets((prev) => prev.map((target) => {
          const row = loaded.find((entry) => entry.instanceId === target.destinationInstanceId);
          return row ? hydrateTargetFromCatalog(target, row.catalog) : target;
        }));
      }
    } finally {
      setCatalogRefreshing(false);
    }
  }

  async function selectAllDestinations() {
    const selected = new Set(targets.map((target) => target.destinationInstanceId));
    const additions = destinationInstances.filter((instance) => !selected.has(instance.id));
    const nextAdditions = additions.map((instance) => ({
        id: makeTargetId(instance.id),
        destinationInstanceId: instance.id,
        targetModelId: instance.defaultModelId || '',
        targetModelName: instance.defaultModelId || '',
        targetFolderId: instance.defaultFolderId || '',
        targetFolderPath: instance.defaultFolderPath || '',
        selectedActionIndexes: [],
    }));
    setTargets((prev) => [...prev, ...nextAdditions]);
    resetPreflight();
    await hydrateDestinationCatalogs(additions.map((instance) => instance.id));
  }

  async function recheckAllTargets() {
    resetPreflight();
    await hydrateDestinationCatalogs(targets.map((target) => target.destinationInstanceId), { force: true });
  }

  function removeTarget(targetId: string, preservePreflight = false) {
    setTargets((prev) => prev.filter((target) => target.id !== targetId));
    if (!preservePreflight) {
      resetPreflight();
      return;
    }
    setPreflightRows((prev) => prev.filter((row) => row.target.id !== targetId));
    setPlan((prev) => removeTargetFromMigrationPlan(prev, targetId));
  }

  function applyFolderToAll(folderPath: string) {
    setTargets((prev) => prev.map((target) => {
      const folder = catalogs[target.destinationInstanceId]?.folders.find((row) => row.path === folderPath || row.id === folderPath);
      return {
        ...target,
        targetFolderId: folder?.id || '',
        targetFolderPath: folder?.path || folderPath,
      };
    }));
    resetPreflight();
  }

  async function runPreflight() {
    if (preflightBlockReason) {
      setError('');
      setMessage(preflightBlockReason);
      return;
    }
    setPreflightLoading(true);
    setError('');
    setMessage('Running compatibility preflight. This may take a moment while OmniKit checks the selected destination.');
    setPlan(null);
    setPreflightRows([]);
    const baseInput = {
      sourceId,
      documentIds: selectedDocumentIds,
      emptyFirst,
      replaceSameNamed,
      sourceFolderId: sourceFolderId || undefined,
      sourceFolderPath: sourceFolderPath || undefined,
      postMigrationActions: selectedPostMigrationActions,
    };
    try {
      const res = await previewMigrationJobWithTimeout({
        ...baseInput,
        targets: migrationTargets,
      });
      setPlan(res.plan);
      setPreflightRows(preflightRowsFromPlan(res.plan));
      setStep(2);
      setMessage('Compatibility preflight matrix is ready. Review warnings before running.');
    } catch (previewError) {
      const bulkPreviewError = errorText(previewError, 'Bulk compatibility preflight failed.');
      const successfulPlans: MigrationPlan[] = [];
      const rows: PreflightTargetRow[] = [];
      if (migrationTargets.length === 1) {
        rows.push({
          target: migrationTargets[0],
          status: 'blocked',
          steps: [],
          warnings: [],
          warningCount: 0,
          deleteCount: 0,
          replaceCount: 0,
          error: bulkPreviewError,
        });
      } else {
        for (const target of migrationTargets) {
          try {
            const res = await previewMigrationJobWithTimeout({
              ...baseInput,
              targets: [target],
            });
            successfulPlans.push(res.plan);
            rows.push(...preflightRowsFromPlan(res.plan));
          } catch (targetError) {
            rows.push({
              target,
              status: 'blocked',
              steps: [],
              warnings: [],
              warningCount: 0,
              deleteCount: 0,
              replaceCount: 0,
              error: errorText(targetError, 'Could not preflight this destination.'),
            });
          }
        }
      }
      const mergedPlan = combineMigrationPlans(successfulPlans);
      setPlan(mergedPlan);
      setPreflightRows(rows);
      setStep(2);
      const blockedCount = rows.filter((row) => row.status === 'blocked').length;
      if (blockedCount > 0) {
        const fallbackContext = migrationTargets.length === 1
          ? bulkPreviewError
          : `Bulk check fell back to per-target validation: ${bulkPreviewError}`;
        setMessage(`${blockedCount} target${blockedCount === 1 ? '' : 's'} blocked. Remove or fix blocked targets before starting the job. ${fallbackContext}`);
      } else if (mergedPlan) {
        setMessage('Compatibility preflight matrix is ready. Review warnings before running.');
      } else {
        setError(`Could not run compatibility preflight for any target. ${bulkPreviewError}`);
      }
    } finally {
      setPreflightLoading(false);
    }
  }

  async function startJob(confirmedEmptyFirst = false) {
    if (emptyFirst && !confirmedEmptyFirst) {
      setConfirmAction('empty-first');
      return;
    }
    setJobBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await createOpsMigrationJob({
        sourceId,
        targets: migrationTargets,
        documentIds: selectedDocumentIds,
        emptyFirst,
        replaceSameNamed,
        sourceFolderId: sourceFolderId || undefined,
        sourceFolderPath: sourceFolderPath || undefined,
        postMigrationActions: selectedPostMigrationActions,
      });
      setJob(res.job);
      setStep(3);
      setMessage('Fan-out copy/import job started.');
    } catch (err) {
      setError(errorText(err, 'Could not start copy/import job.'));
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

  function requestCancelJob() {
    if (!job) return;
    setConfirmAction('cancel');
  }

  async function retryDestination(destinationId?: string) {
    if (!job) return;
    setJobBusy(true);
    setError('');
    try {
      const res = await retryOpsMigrationJob(job.id, destinationId);
      setJob(res.job);
      setMessage(destinationId ? 'Retry job started for the selected destination.' : 'Retry job started.');
    } catch (err) {
      setError(errorText(err, 'Could not retry failed items.'));
    } finally {
      setJobBusy(false);
    }
  }

  async function reloadDocumentsAfterFix() {
    await loadDocuments(sourceId, { preserveSelection: true });
  }

  function startNewMigration() {
    resetPreflight();
    setJob(null);
    setSelectedDocumentIds([]);
    setTargets([]);
    setStep(0);
    setMessage('Ready for a new migration. Source selection kept.');
  }

  function canOpenStep(index: number) {
    if (index === 0) return true;
    if (index === 1) return selectedDocumentIds.length > 0;
    if (index === 2) return Boolean(plan);
    if (index === 3) return Boolean(job);
    return false;
  }

  if (loading) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary">
        <Loader2 size={18} className="animate-spin" />
        Loading fan-out migration wizard...
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
              Fan-out migration uses saved source and destination profiles from the native encrypted vault.
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
        <div className="grid gap-2 md:grid-cols-4">
          {STEP_LABELS.map((label, index) => {
            const enabled = index === step || canOpenStep(index);
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (enabled) setStep(index as FanoutStep);
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
        <section className="grid gap-5 xl:grid-cols-[0.82fr_1.18fr]">
          <div className="card p-5">
            <h2 className="text-base font-semibold text-content-primary">1. Pick the source once</h2>
            <p className="mt-1 text-sm text-content-secondary">Choose a saved source profile, optionally narrow to one source model, then select dashboards from the source folder.</p>
            <p className="mt-1 text-xs text-content-secondary">Migrates dashboards built on this model. Each destination must already have an equivalent model — pick it per target.</p>
            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source instance</label>
                <select value={sourceId} onChange={(event) => chooseSource(event.target.value)} className="input-field">
                  <option value="">Select source</option>
                  {sourceInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source model</label>
                <select
                  value={sourceModelId}
                  onFocus={() => void loadCatalog(sourceId)}
                  onChange={(event) => {
                    setSourceModelId(event.target.value);
                    setSelectedDocumentIds([]);
                    resetPreflight();
                  }}
                  disabled={!sourceId || sourceCatalog?.loading}
                  className="input-field"
                >
                  <option value="">{sourceCatalog?.loading ? 'Loading models...' : 'All source models'}</option>
                  {sourceModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name || model.identifier || model.id}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source folder</label>
                <select
                  value={sourceFolderPath || sourceFolderId}
                  onFocus={() => void loadCatalog(sourceId)}
                  onChange={(event) => chooseSourceFolder(event.target.value)}
                  disabled={!sourceId || sourceCatalog?.loading}
                  className="input-field"
                >
                  <option value="">{sourceCatalog?.loading ? 'Loading folders...' : 'My Documents/default'}</option>
                  {sourceFolders.map((folder, index) => (
                    <option key={`source-folder:${index}:${folder.id}:${folder.path || folder.identifier || folder.name}`} value={folder.path || folder.identifier || folder.id}>
                      {folder.path || folder.identifier || folder.name}
                    </option>
                  ))}
                  {source && (source.defaultFolderPath || source.defaultFolderId) && !sourceFolders.some((folder) => (
                    folder.path === (sourceFolderPath || sourceFolderId)
                    || folder.identifier === (sourceFolderPath || sourceFolderId)
                    || folder.id === (sourceFolderPath || sourceFolderId)
                  )) && (
                    <option value={sourceFolderPath || sourceFolderId}>{sourceFolderPath || sourceFolderId}</option>
                  )}
                </select>
              </div>
              <button type="button" onClick={() => loadDocuments()} disabled={!sourceId || loadingDocuments} className="btn-primary inline-flex w-full items-center justify-center gap-2">
                {loadingDocuments ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
                Load dashboards
              </button>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-base font-semibold text-content-primary">Source dashboards</h3>
                <p className="mt-1 text-sm text-content-secondary">{selectedDocumentIds.length} selected · {selectedMetadataMissing.length} need metadata review</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={selectAllVisibleDocuments} disabled={filteredDocuments.length === 0} className="btn-secondary text-xs">Select visible</button>
                <button type="button" onClick={clearDocumentSelection} disabled={selectedDocumentIds.length === 0} className="btn-secondary text-xs">Clear</button>
                <button type="button" onClick={() => setFixPanelOpen(true)} disabled={selectedMetadataMissing.length === 0} className="btn-secondary inline-flex items-center gap-1 text-xs">
                  <Tag size={13} />
                  Fix metadata
                </button>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
              <SearchInput value={search} onChange={setSearch} placeholder="Search names, labels, model IDs, or folders" />
              <label className="flex items-center gap-2 text-xs font-semibold text-content-secondary">
                <input type="checkbox" checked={metadataOnly} onChange={(event) => setMetadataOnly(event.target.checked)} className="accent-omni-600" />
                Missing metadata only
              </label>
            </div>
            <div className="mt-4 max-h-[460px] overflow-auto rounded-card border border-border-subtle">
              {filteredDocuments.map((document) => {
                const selected = selectedDocumentIds.includes(document.identifier);
                const missing = metadataMissing(document);
                const model = fanoutDocumentModelLabel(document, sourceModelNameById);
                return (
                  <label key={document.identifier} className={`grid gap-3 border-b border-border-subtle px-3 py-3 text-sm last:border-b-0 hover:bg-surface-secondary md:grid-cols-[auto_1fr_0.7fr_0.45fr] ${selected ? 'bg-omni-50/50' : ''}`}>
                    <input type="checkbox" checked={selected} onChange={() => toggleDocument(document.identifier)} className="mt-1 accent-omni-600" />
                    <span>
                      <span className="block font-semibold text-content-primary">{document.name}</span>
                      <span className="block font-mono text-xs text-content-secondary">{document.identifier}</span>
                      {document.folderPath && <span className="mt-1 block text-xs text-content-secondary">{document.folderPath}</span>}
                    </span>
                    <span className="text-xs text-content-secondary" title={model.detected ? undefined : 'No model metadata was available from the dashboard export.'}>
                      Model: {model.label}
                      <br />
                      Updated: {formatDate(document.updatedAt)}
                    </span>
                    <span className="flex flex-col gap-1">
                      <StatusChip status={document.description?.trim() ? 'success' : 'warning'} label={document.description?.trim() ? 'Description' : 'No description'} />
                      <StatusChip status={document.labels?.length ? 'success' : 'warning'} label={`${document.labels?.length || 0} labels`} />
                      {missing && <span className="text-[10px] text-yellow-800">FixPanel available</span>}
                    </span>
                  </label>
                );
              })}
              {filteredDocuments.length === 0 && (
                <div className="p-6 text-sm text-content-secondary">{documents.length === 0 ? 'Load dashboards to begin.' : 'No dashboards match this filter.'}</div>
              )}
            </div>
            <div className="mt-4 flex flex-col items-end gap-2">
              {fixPanelOpen && (
                <p className="text-xs text-content-secondary">Apply or cancel metadata fixes before continuing.</p>
              )}
              <button
                type="button"
                onClick={() => setStep(1)}
                disabled={!canContinueSource}
                title={fixPanelOpen ? 'Apply or cancel metadata fixes before continuing.' : undefined}
                className="btn-primary"
              >
                Continue to targets
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="grid gap-5 xl:grid-cols-[0.78fr_1.22fr]">
          <div className="card p-5">
            <h2 className="text-base font-semibold text-content-primary">2. Check destinations</h2>
            <p className="mt-1 text-sm text-content-secondary">Select destination instances once. Defaults fill in from each saved profile.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => void selectAllDestinations()} disabled={destinationInstances.length === 0 || catalogRefreshing} className="btn-secondary text-xs">Select all destinations</button>
              <button type="button" onClick={() => void recheckAllTargets()} disabled={targets.length === 0 || catalogRefreshing} className="btn-secondary inline-flex items-center gap-1 text-xs">
                <RefreshCw size={13} className={catalogRefreshing ? 'animate-spin' : ''} />
                Re-check all
              </button>
              <button type="button" onClick={() => { setTargets([]); resetPreflight(); }} disabled={targets.length === 0} className="btn-secondary text-xs">Clear targets</button>
            </div>
            {catalogRefreshing && (
              <div className="mt-3 rounded-card border border-border-subtle bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                Refreshing destination model and folder catalogs in small batches.
              </div>
            )}
            {overSoftCap && (
              <div className="mt-4 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                More than 10 targets selected. OmniKit will queue extras behind the 10 parallel destination lanes.
              </div>
            )}
            <div className="mt-4 max-h-[460px] space-y-2 overflow-auto">
              {destinationInstances.map((instance) => {
                const checked = targets.some((target) => target.destinationInstanceId === instance.id);
                return (
                  <label key={instance.id} className={`block rounded-card border px-3 py-3 text-sm transition ${checked ? 'border-omni-300 bg-omni-50' : 'border-border-subtle hover:bg-surface-secondary'}`}>
                    <span className="flex items-start gap-2">
                      <input type="checkbox" checked={checked} onChange={() => void toggleDestination(instance)} className="mt-1 accent-omni-600" />
                      <span className="min-w-0">
                        <span className="block font-semibold text-content-primary">{instance.label}</span>
                        <span className="block truncate text-xs text-content-secondary">{instance.baseUrl}</span>
                        <span className="mt-1 block text-xs text-content-secondary">
                          Default model: {instance.defaultModelId || 'Not set'} · Folder: {instance.defaultFolderPath || instance.defaultFolderId || 'Default'}
                        </span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-base font-semibold text-content-primary">Target details</h3>
                <p className="mt-1 text-sm text-content-secondary">Every checked destination needs a model. Folder defaults can be kept or overridden.</p>
              </div>
              <div className="flex gap-2">
                <input
                  value={bulkFolderPath}
                  onChange={(event) => setBulkFolderPath(event.target.value)}
                  className="input-field h-9 min-w-[220px] text-xs"
                  placeholder="Folder path for all"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyFolderToAll(event.currentTarget.value);
                  }}
                />
                <button
                  type="button"
                  onClick={() => applyFolderToAll(bulkFolderPath)}
                  disabled={!bulkFolderPath.trim() || targets.length === 0}
                  className="btn-secondary h-9 text-xs"
                >
                  Apply
                </button>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {targets.map((target, index) => {
                const destination = instances.find((instance) => instance.id === target.destinationInstanceId);
                const catalog = catalogs[target.destinationInstanceId];
                const models = catalog?.models || [];
                const folders = catalog?.folders || [];
                const modelOptions = buildTargetModelOptions(models);
                const folderOptions = buildTargetFolderOptions(folders);
                return (
                  <div key={target.id} className="rounded-card border border-border-subtle p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">Target {index + 1}: {destination?.label || target.destinationInstanceId}</div>
                        <div className="text-xs text-content-secondary">{catalog?.loading ? 'Loading model and folder catalog...' : target.targetModelName || 'Choose target model'}</div>
                      </div>
                      <button type="button" onClick={() => removeTarget(target.id)} className="btn-danger inline-flex items-center gap-1 text-xs">
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-content-primary"><Database size={12} /> Target model</label>
                        <ComboBox
                          options={modelOptions}
                          value={target.targetModelId}
                          onChange={(value) => updateTarget(target.id, { targetModelId: value })}
                          disabled={catalog?.loading}
                          placeholder={catalog?.loading ? 'Loading models...' : 'Select model'}
                          emptyLabel={TARGET_MODEL_COMBOBOX_CONFIG.emptyLabel}
                          allowFreeText={TARGET_MODEL_COMBOBOX_CONFIG.allowFreeText}
                          ariaLabel={`Target model for ${destination?.label || `target ${index + 1}`}`}
                        />
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-content-primary"><FolderInput size={12} /> Target folder</label>
                        <ComboBox
                          options={folderOptions}
                          value={target.targetFolderPath}
                          disabled={catalog?.loading}
                          onChange={(value) => updateTarget(target.id, { targetFolderPath: value })}
                          placeholder={catalog?.loading ? 'Loading folders...' : 'My Documents/default'}
                          emptyLabel={TARGET_FOLDER_COMBOBOX_CONFIG.emptyLabel}
                          allowFreeText={TARGET_FOLDER_COMBOBOX_CONFIG.allowFreeText}
                          ariaLabel={`Target folder for ${destination?.label || `target ${index + 1}`}`}
                        />
                      </div>
                    </div>
                    {target.targetFolderId && !target.targetFolderPath && (
                      <div className="mt-3 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                        This saved folder ID needs a path before import can safely run. Choose a folder or clear the folder.
                      </div>
                    )}
                    {catalog?.error && <div className="mt-3 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{catalog.error}</div>}
                    {destination?.postMigrationActions.length ? (
                      <div className="mt-3 rounded-card border border-border-subtle bg-surface-secondary p-3">
                        <div className="mb-2 text-xs font-semibold text-content-primary">Post-migration actions for this destination</div>
                        <div className="space-y-1">
                          {destination.postMigrationActions.map((action, actionIndex) => (
                            <label key={actionKey(destination.id, actionIndex)} className="flex items-start gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={target.selectedActionIndexes.includes(actionIndex)}
                                onChange={() => updateTarget(target.id, {
                                  selectedActionIndexes: target.selectedActionIndexes.includes(actionIndex)
                                    ? target.selectedActionIndexes.filter((row) => row !== actionIndex)
                                    : [...target.selectedActionIndexes, actionIndex],
                                })}
                                className="mt-0.5 accent-omni-600"
                              />
                              <span>
                                <span className="font-semibold text-content-primary">{action.name}</span>
                                <span className="ml-2 text-content-secondary">{action.method}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {targets.length === 0 && <div className="rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">Check at least one destination instance to configure exact target models and folders.</div>}
            </div>
            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              <label className="flex items-start gap-2 rounded-card border border-border-subtle p-4">
                <input type="checkbox" checked={emptyFirst} onChange={(event) => { setEmptyFirst(event.target.checked); resetPreflight(); }} className="mt-1 accent-omni-600" />
                <span>
                  <span className="block text-sm font-semibold text-content-primary">Empty target folders before import</span>
                  <span className="mt-1 block text-xs text-content-secondary">Adds delete steps for dashboards currently in each selected target folder.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-card border border-border-subtle p-4">
                <input
                  type="checkbox"
                  checked={replaceSameNamed}
                  onChange={(event) => { setReplaceSameNamed(event.target.checked); resetPreflight(); }}
                  className="mt-1 accent-omni-600"
                />
                <span>
                  <span className="block text-sm font-semibold text-content-primary">Replace same-named dashboards</span>
                  <span className="mt-1 block text-xs text-content-secondary">When not emptying folders, delete only existing dashboards whose names match the selected source dashboards.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-card border border-border-subtle p-4">
                <input
                  type="checkbox"
                  checked={refreshSchemaAfterImport}
                  onChange={(event) => { setRefreshSchemaAfterImport(event.target.checked); resetPreflight(); }}
                  className="mt-1 accent-omni-600"
                />
                <span>
                  <span className="block text-sm font-semibold text-content-primary">Refresh schema model after import</span>
                  <span className="mt-1 block text-xs text-content-secondary">
                    Queues Omni schema refresh for each destination target model after import completes. This uses saved vault credentials directly, not a user-authored webhook URL.
                  </span>
                </span>
              </label>
            </div>
            <div className="mt-5 flex justify-between gap-3">
              <button type="button" onClick={() => setStep(0)} className="btn-secondary">Back</button>
              <div className="flex flex-col items-end gap-2">
                <button type="button" onClick={runPreflight} disabled={!canPreflight} className="btn-primary inline-flex items-center gap-2">
                  {preflightLoading ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                  Run preflight
                </button>
                {preflightLoading && (
                  <p aria-live="polite" className="max-w-sm text-right text-xs text-content-secondary">
                    Running compatibility preflight. This should resolve to a matrix or an actionable error.
                  </p>
                )}
                {preflightBlockReason && !preflightLoading && (
                  <p className="max-w-sm text-right text-xs text-content-secondary">{preflightBlockReason}</p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="grid gap-5 xl:grid-cols-[1fr_0.62fr]">
          <div className="card p-5">
            <h2 className="text-base font-semibold text-content-primary">3. Preflight matrix</h2>
            <p className="mt-1 text-sm text-content-secondary">Review each destination before any dashboard import starts.</p>
            {blockedPreflightRows.length > 0 && (
              <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {blockedPreflightRows.length} target{blockedPreflightRows.length === 1 ? '' : 's'} blocked. Remove blocked rows or return to Targets to fix model, folder, or connection settings before running.
              </div>
            )}
            {preflightRows.length === 0 ? (
              <div className="mt-4 rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
                Run preflight from the Targets step to build the compatibility matrix.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {preflightRows.map((summary) => (
                  <div key={summary.target.id} className={`rounded-card border p-4 ${summary.status === 'blocked' ? 'border-red-200 bg-red-50/40' : 'border-border-subtle'}`}>
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">{summary.target.destinationLabel || summary.target.destinationInstanceId}</div>
                        <div className="mt-1 text-xs text-content-secondary">
                          Model: {summary.target.targetModelName || summary.target.targetModelId} · Folder: {summary.target.targetFolderPath || 'Default'}
                        </div>
                      </div>
                      <StatusChip
                        status={summary.status === 'blocked' ? 'failed' : summary.status}
                        label={summary.status === 'blocked' ? 'Blocked' : summary.status === 'ready' ? 'Preflight ready' : `${summary.warningCount} warnings`}
                      />
                    </div>
                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-5">
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{summary.status === 'blocked' ? 'Blocked' : 'Passed'}</span><br />Reachable</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{summary.target.targetModelId ? 'Set' : 'Missing'}</span><br />Model</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{summary.target.targetFolderPath || summary.target.targetFolderId ? 'Resolved' : 'Default'}</span><br />Folder</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{summary.status === 'blocked' ? 'Not checked' : summary.warningCount}</span><br />Field warnings</div>
                      <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{summary.deleteCount}</span><br />Deletes</div>
                    </div>
                    {summary.error && (
                      <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <AlertTriangle size={13} className="mr-1 inline-block" />
                        {summary.error}
                      </div>
                    )}
                    {summary.replaceCount > 0 && (
                      <div className="mt-2 text-xs text-content-secondary">
                        {summary.replaceCount} existing dashboard{summary.replaceCount === 1 ? '' : 's'} will be replaced by name in this target folder.
                      </div>
                    )}
                    {summary.warnings.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {summary.warnings.map((warning) => (
                          <div key={warning} className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{warning}</div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {summary.status === 'blocked' && (
                        <button type="button" onClick={() => { setStep(1); setMessage('Fix the blocked target, then run preflight again.'); }} className="btn-secondary text-xs">
                          Fix target
                        </button>
                      )}
                      <button type="button" onClick={() => removeTarget(summary.target.id, true)} className="btn-secondary text-xs">
                        Remove target
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-4">
            <div className="card p-5">
              <h3 className="text-base font-semibold text-content-primary">Plan summary</h3>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-card bg-surface-secondary p-2"><div className="font-semibold text-content-primary">{plan?.documentIds.length || selectedDocumentIds.length}</div><div className="text-content-secondary">Dashboards</div></div>
                <div className="rounded-card bg-surface-secondary p-2"><div className="font-semibold text-content-primary">{plan?.targets.length || targets.length}</div><div className="text-content-secondary">Targets</div></div>
                <div className="rounded-card bg-surface-secondary p-2"><div className="font-semibold text-content-primary">{plan?.steps.length || 0}</div><div className="text-content-secondary">Steps</div></div>
              </div>
              {plan && (
                <div className="mt-3 rounded-card border border-border-subtle p-3 text-sm text-content-secondary">
                  Estimated duration: about <span className="font-semibold text-content-primary">{durationSeconds}s</span>, based on one source export lane and parallel destination lanes.
                </div>
              )}
            </div>
            <div className="card p-5">
              <div className="flex flex-col gap-3">
                <button type="button" onClick={() => setStep(1)} className="btn-secondary">Back to targets</button>
                <button type="button" onClick={() => void startJob()} disabled={!canRun} className="btn-primary inline-flex items-center justify-center gap-2">
                  {jobBusy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  Start fan-out job
                </button>
                {blockedPreflightRows.length > 0 && (
                  <p className="text-xs text-red-700">Remove or fix blocked targets before starting the job.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-5">
          <div className="card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-content-primary">4. Run and results</h2>
                <p className="mt-1 text-sm text-content-secondary">Live progress is streamed from the local migration engine.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {job && !migrationJobDone(job) && (
                  <button type="button" onClick={requestCancelJob} disabled={jobBusy} className="btn-secondary inline-flex items-center gap-2 text-red-700">
                    <XCircle size={15} />
                    Cancel
                  </button>
                )}
                {job && (job.status === 'failed' || job.status === 'partial') && (
                  <button type="button" onClick={() => retryDestination()} disabled={jobBusy} className="btn-secondary inline-flex items-center gap-2">
                    <RefreshCw size={15} />
                    Retry all failed
                  </button>
                )}
                {job && migrationJobDone(job) && (
                  <button type="button" onClick={startNewMigration} className="btn-primary inline-flex items-center gap-2">
                    <Send size={15} />
                    Start new migration
                  </button>
                )}
              </div>
            </div>
            {!job ? (
              <div className="mt-4 rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
                Start the job from Preflight to see live progress here.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="rounded-card border border-border-subtle p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Sparkles size={16} className="text-omni-600" />
                      <span className="text-sm font-semibold text-content-primary">Exporting from source</span>
                    </div>
                    <StatusChip status={job.status === 'running' && exportDone < exportDocumentIds.length ? 'in_progress' : 'info'} label={`${exportDone}/${exportDocumentIds.length} exports`} />
                  </div>
                  <ProgressBar current={exportDone} total={Math.max(exportDocumentIds.length, 1)} label="Shared source export stage" indeterminate={job.status === 'running' && exportDocumentIds.length === 0} />
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {destinationProgress.map((row) => (
                    <div key={`${row.destinationId}:${row.targetIds.join(',')}`} className="rounded-card border border-border-subtle p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-content-primary">{row.destinationLabel}</div>
                          <div className="mt-1 text-xs text-content-secondary">Current: {row.currentItem || 'No active step'}</div>
                        </div>
                        <StatusChip status={row.status === 'succeeded' ? 'success' : row.status === 'running' ? 'in_progress' : row.status} label={row.status} />
                      </div>
                      <div className="mt-3">
                        <ProgressBar current={row.done} total={Math.max(row.total, 1)} label={`${row.done}/${row.total} destination steps`} tone={row.failed > 0 ? 'danger' : row.status === 'succeeded' ? 'success' : 'brand'} />
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                        <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{row.failed}</span><br />Failed</div>
                        <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{row.warning}</span><br />Warnings</div>
                        <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{row.skipped}</span><br />Skipped</div>
                        <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{row.running}</span><br />Running</div>
                      </div>
                      {row.failed > 0 && migrationJobDone(job) && (
                        <button type="button" onClick={() => retryDestination(row.destinationId)} disabled={jobBusy} className="btn-secondary mt-3 inline-flex w-full items-center justify-center gap-2">
                          <RefreshCw size={14} />
                          Retry this destination
                        </button>
                      )}
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-semibold text-content-secondary">Item log</summary>
                        <div className="mt-2 max-h-56 overflow-auto rounded-card border border-border-subtle">
                          {job.items.filter((item) => item.destinationId === row.destinationId && item.kind !== 'export').map((item) => (
                            <div key={item.id} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                              <div className="flex items-start justify-between gap-2">
                                <span>
                                  <span className="font-semibold text-content-primary">{item.kind.toUpperCase()}</span>
                                  <span className="ml-2 text-content-secondary">{item.documentName || item.documentId || 'Step'}</span>
                                </span>
                                <span className={`rounded-chip px-2 py-0.5 font-semibold ${statusClass(item.status)}`}>{item.status}</span>
                              </div>
                              {item.warnings?.map((warning) => <div key={warning} className="mt-1 text-yellow-700">{warning}</div>)}
                              {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {job?.postMigrationActions.length ? (
            <div className="card p-5">
              <h3 className="text-base font-semibold text-content-primary">Post-migration actions</h3>
              <p className="mt-1 text-sm text-content-secondary">Enabled action templates are recorded as redacted job steps.</p>
              <div className="mt-3 space-y-2">
                {job.items.filter((item) => item.kind === 'post_action').map((item) => (
                  <div key={item.id} className="rounded-card border border-border-subtle px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-content-primary">{item.documentName || 'Post-migration action'}</span>
                      <span className={`rounded-chip px-2 py-0.5 font-semibold ${statusClass(item.status)}`}>{item.status}</span>
                    </div>
                    {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      )}

      <FixPanel
        open={fixPanelOpen}
        instanceId={sourceId}
        documents={selectedDocuments}
        onClose={() => setFixPanelOpen(false)}
        onApplied={reloadDocumentsAfterFix}
      />
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'empty-first' ? 'Empty target folders before import?' : 'Cancel migration job?'}
        message={confirmAction === 'empty-first'
          ? 'OmniKit will delete existing dashboards from each selected target folder before importing the selected dashboards. This only affects the selected destination folders.'
          : 'In-flight Omni requests may finish, but OmniKit will stop scheduling new migration steps for this job.'}
        confirmLabel={confirmAction === 'empty-first' ? 'Empty folders and start' : 'Cancel job'}
        cancelLabel="Go back"
        variant={confirmAction === 'empty-first' ? 'danger' : 'primary'}
        itemCount={confirmAction === 'empty-first' ? plannedDeleteCount : undefined}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action === 'empty-first') void startJob(true);
          if (action === 'cancel') void cancelJob();
        }}
      />
    </div>
  );
}
