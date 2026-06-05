import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Database,
  FileText,
  FolderInput,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  createOpsMigrationJob,
  getMigrationJob,
  getVaultStatus,
  listInstanceDocuments,
  listInstanceFolders,
  listInstanceModels,
  listMigrationJobs,
  listSavedInstances,
  previewMigrationJob,
  retryOpsMigrationJob,
  unlockNativeVault,
  type InstanceDocument,
  type InstanceFolder,
  type InstanceModel,
  type MigrationJob,
  type MigrationPlan,
  type MigrationTarget,
  type PostMigrationAction,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { SearchInput } from '@/components/ui/SearchInput';

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value?: number | string) {
  if (!value) return 'Not started';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString();
}

function statusClass(status: string) {
  if (status === 'succeeded') return 'bg-green-100 text-green-700';
  if (status === 'warning' || status === 'partial') return 'bg-yellow-100 text-yellow-800';
  if (status === 'failed') return 'bg-red-100 text-red-700';
  if (status === 'running') return 'bg-omni-50 text-omni-700';
  return 'bg-surface-secondary text-content-secondary';
}

function actionKey(action: PostMigrationAction, index: number) {
  return `${index}:${action.name}:${action.url}`;
}

interface TargetDraft {
  id: string;
  destinationInstanceId: string;
  targetModelId: string;
  targetModelName: string;
  targetFolderPath: string;
  targetFolderId: string;
}

interface TargetCatalog {
  models: InstanceModel[];
  folders: InstanceFolder[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

function makeTargetId(destinationInstanceId: string, index = Date.now()) {
  return `${destinationInstanceId || 'destination'}:${index}:${Math.random().toString(36).slice(2, 8)}`;
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

export function MultiInstanceMigratePanel() {
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [targets, setTargets] = useState<TargetDraft[]>([]);
  const [targetCatalog, setTargetCatalog] = useState<Record<string, TargetCatalog>>({});
  const [documents, setDocuments] = useState<InstanceDocument[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [emptyFirst, setEmptyFirst] = useState(false);
  const [enabledActionKeys, setEnabledActionKeys] = useState<string[]>([]);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const status = await getVaultStatus();
      setVaultStatus(status);
      if (status.unlocked) {
        const [instancesRes, jobsRes] = await Promise.all([
          listSavedInstances(),
          listMigrationJobs(),
        ]);
        setInstances(instancesRes.instances);
        setJobs(jobsRes.jobs);
      } else {
        setInstances([]);
        setJobs([]);
      }
    } catch (err) {
      setError(errorText(err, 'Could not load saved instance migration state.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!job || job.status === 'succeeded' || job.status === 'failed' || job.status === 'partial') return undefined;
    const timer = window.setInterval(async () => {
      try {
        const res = await getMigrationJob(job.id);
        setJob(res.job);
        if (res.job.status === 'succeeded' || res.job.status === 'failed' || res.job.status === 'partial') {
          const jobsRes = await listMigrationJobs();
          setJobs(jobsRes.jobs);
        }
      } catch {
        // Job polling should not interrupt the page; the user can refresh manually.
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [job]);

  const sourceInstances = instances.filter((instance) => instance.role === 'source' || instance.role === 'both');
  const destinationInstances = instances.filter((instance) => instance.role === 'destination' || instance.role === 'both');
  const source = instances.find((instance) => instance.id === sourceId);
  const selectedActions = (source?.postMigrationActions || []).filter((action, index) => enabledActionKeys.includes(actionKey(action, index)));
  const migrationTargets: MigrationTarget[] = targets
    .filter((target) => target.destinationInstanceId)
    .map((target) => {
      const destination = instances.find((instance) => instance.id === target.destinationInstanceId);
      return {
        id: target.id,
        destinationInstanceId: target.destinationInstanceId,
        destinationLabel: destination?.label,
        targetModelId: target.targetModelId,
        targetModelName: target.targetModelName,
        targetFolderId: target.targetFolderId || undefined,
        targetFolderPath: target.targetFolderPath || undefined,
      };
    });
  const hasLoadingTargets = targets.some((target) => target.destinationInstanceId && targetCatalog[target.destinationInstanceId]?.loading);
  const hasUnresolvedFolderTargets = targets.some((target) => Boolean(target.targetFolderId && !target.targetFolderPath));
  const hasInvalidTargets = migrationTargets.length === 0
    || migrationTargets.some((target) => !target.targetModelId)
    || hasLoadingTargets
    || hasUnresolvedFolderTargets;
  const canRunPreflight = Boolean(!busy && sourceId && selectedDocumentIds.length > 0 && !hasInvalidTargets);
  const canStartJob = Boolean(canRunPreflight && plan);

  const filteredDocuments = useMemo(() => {
    const normalized = search.toLowerCase();
    return documents.filter((document) => {
      if (!normalized) return true;
      return [
        document.name,
        document.identifier,
        document.folderPath,
        document.baseModelId,
        ...(document.labels || []),
      ].some((value) => value?.toLowerCase().includes(normalized));
    });
  }, [documents, search]);

  async function unlockVault() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await unlockNativeVault(passphrase);
      setVaultStatus(res.status);
      setPassphrase('');
      await refresh();
      setMessage('Native vault unlocked.');
    } catch (err) {
      setError(errorText(err, 'Could not unlock vault.'));
    } finally {
      setBusy(false);
    }
  }

  async function loadSourceDocuments(nextSourceId = sourceId) {
    if (!nextSourceId) return;
    setBusy(true);
    setError('');
    setMessage('');
    setPlan(null);
    setJob(null);
    try {
      const res = await listInstanceDocuments(nextSourceId);
      setDocuments(res.documents);
      setSelectedDocumentIds([]);
      setMessage(`Loaded ${res.documents.length} dashboard document${res.documents.length === 1 ? '' : 's'} from the source folder.`);
    } catch (err) {
      setDocuments([]);
      setSelectedDocumentIds([]);
      setError(errorText(err, 'Could not load source dashboards.'));
    } finally {
      setBusy(false);
    }
  }

  function setSource(nextSourceId: string) {
    setSourceId(nextSourceId);
    setPlan(null);
    setJob(null);
    setEnabledActionKeys([]);
    void loadSourceDocuments(nextSourceId);
  }

  const loadTargetCatalog = useCallback(async (instanceId: string) => {
    if (!instanceId || targetCatalog[instanceId]?.loading || targetCatalog[instanceId]?.loaded) return;
    setTargetCatalog((prev) => ({
      ...prev,
      [instanceId]: {
        models: prev[instanceId]?.models || [],
        folders: prev[instanceId]?.folders || [],
        loading: true,
        loaded: prev[instanceId]?.loaded || false,
        error: '',
      },
    }));
    try {
      const [modelsRes, foldersRes] = await Promise.all([
        listInstanceModels(instanceId),
        listInstanceFolders(instanceId),
      ]);
      const flattenedFolders = flattenFolders(foldersRes.folders);
      setTargetCatalog((prev) => ({
        ...prev,
        [instanceId]: {
          models: modelsRes.models,
          folders: flattenedFolders,
          loading: false,
          loaded: true,
          error: '',
        },
      }));
      setTargets((prev) => prev.map((target) => {
        if (target.destinationInstanceId !== instanceId) return target;
        const model = modelsRes.models.find((row) => row.id === target.targetModelId);
        const folder = flattenedFolders.find((row) => row.id === target.targetFolderId || row.path === target.targetFolderPath);
        return {
          ...target,
          targetModelName: model?.name || target.targetModelName,
          targetFolderId: folder?.id || target.targetFolderId,
          targetFolderPath: folder?.path || target.targetFolderPath,
        };
      }));
    } catch (err) {
      setTargetCatalog((prev) => ({
        ...prev,
        [instanceId]: {
          models: prev[instanceId]?.models || [],
          folders: prev[instanceId]?.folders || [],
          loading: false,
          loaded: false,
          error: errorText(err, 'Could not load target models and folders.'),
        },
      }));
    }
  }, [targetCatalog]);

  const addTarget = useCallback((destinationInstanceId = '') => {
    const destination = destinationInstances.find((instance) => instance.id === destinationInstanceId) || destinationInstances[0];
    if (!destination) return;
    const catalog = targetCatalog[destination.id];
    const defaultModel = catalog?.models.find((model) => model.id === destination.defaultModelId) || catalog?.models[0];
    const defaultFolder = catalog?.folders.find((folder) => folder.path === destination.defaultFolderPath || folder.id === destination.defaultFolderId);
    setTargets((prev) => [
      ...prev,
      {
        id: makeTargetId(destination.id, prev.length),
        destinationInstanceId: destination.id,
        targetModelId: destination.defaultModelId || defaultModel?.id || '',
        targetModelName: defaultModel?.name || destination.defaultModelId || '',
        targetFolderPath: destination.defaultFolderPath || defaultFolder?.path || '',
        targetFolderId: destination.defaultFolderId || defaultFolder?.id || '',
      },
    ]);
    setPlan(null);
    setJob(null);
    void loadTargetCatalog(destination.id);
  }, [destinationInstances, loadTargetCatalog, targetCatalog]);

  useEffect(() => {
    if (targets.length > 0) return;
    const defaultDestination = instances.find((instance) => instance.role === 'destination' || instance.role === 'both');
    if (defaultDestination) addTarget(defaultDestination.id);
  }, [addTarget, instances, targets.length]);

  function removeTarget(id: string) {
    setTargets((prev) => prev.filter((target) => target.id !== id));
    setPlan(null);
    setJob(null);
  }

  function updateTarget(id: string, patch: Partial<TargetDraft>) {
    setTargets((prev) => prev.map((target) => {
      if (target.id !== id) return target;
      const next = { ...target, ...patch };
      const destination = destinationInstances.find((instance) => instance.id === next.destinationInstanceId);
      if (patch.destinationInstanceId !== undefined) {
        if (!patch.destinationInstanceId) {
          next.targetModelId = '';
          next.targetModelName = '';
          next.targetFolderPath = '';
          next.targetFolderId = '';
          return next;
        }
        const catalog = targetCatalog[patch.destinationInstanceId];
        const defaultModel = catalog?.models.find((model) => model.id === destination?.defaultModelId) || catalog?.models[0];
        const defaultFolder = catalog?.folders.find((folder) => folder.path === destination?.defaultFolderPath || folder.id === destination?.defaultFolderId);
        next.targetModelId = destination?.defaultModelId || defaultModel?.id || '';
        next.targetModelName = defaultModel?.name || destination?.defaultModelId || '';
        next.targetFolderPath = destination?.defaultFolderPath || defaultFolder?.path || '';
        next.targetFolderId = destination?.defaultFolderId || defaultFolder?.id || '';
        void loadTargetCatalog(patch.destinationInstanceId);
      }
      if (patch.targetModelId !== undefined) {
        if (!patch.targetModelId) {
          next.targetModelName = '';
        }
        const model = targetCatalog[next.destinationInstanceId]?.models.find((row) => row.id === patch.targetModelId);
        if (patch.targetModelId) next.targetModelName = model?.name || patch.targetModelId;
      }
      if (patch.targetFolderPath !== undefined) {
        if (!patch.targetFolderPath) {
          next.targetFolderId = '';
          next.targetFolderPath = '';
          return next;
        }
        const folder = targetCatalog[next.destinationInstanceId]?.folders.find((row) => row.path === patch.targetFolderPath || row.id === patch.targetFolderPath);
        next.targetFolderId = folder?.id || '';
        next.targetFolderPath = folder?.path || patch.targetFolderPath;
      }
      return next;
    }));
    setPlan(null);
    setJob(null);
  }

  function toggleDocument(id: string) {
    setSelectedDocumentIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
    setPlan(null);
    setJob(null);
  }

  function toggleAction(key: string) {
    setEnabledActionKeys((prev) => prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]);
  }

  async function preview() {
    setBusy(true);
    setError('');
    setMessage('');
    setPlan(null);
    setJob(null);
    try {
      const res = await previewMigrationJob({
        sourceId,
        targets: migrationTargets,
        documentIds: selectedDocumentIds,
        emptyFirst,
        postMigrationActions: selectedActions,
      });
      setPlan(res.plan);
      setMessage('Compatibility preflight plan is ready. Review the steps before starting the job.');
    } catch (err) {
      setError(errorText(err, 'Could not preview migration job.'));
    } finally {
      setBusy(false);
    }
  }

  async function startJob() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await createOpsMigrationJob({
        sourceId,
        targets: migrationTargets,
        documentIds: selectedDocumentIds,
        emptyFirst,
        postMigrationActions: selectedActions,
      });
      setJob(res.job);
      setPlan(null);
      setMessage('Migration job started. Status will update below.');
      const jobsRes = await listMigrationJobs();
      setJobs(jobsRes.jobs);
    } catch (err) {
      setError(errorText(err, 'Could not start migration job.'));
    } finally {
      setBusy(false);
    }
  }

  async function retryJob(id: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await retryOpsMigrationJob(id);
      setJob(res.job);
      setMessage('Retry job started.');
    } catch (err) {
      setError(errorText(err, 'Could not retry job.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary">
        <Loader2 size={18} className="animate-spin" />
        Loading saved-instance migration mode...
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
              Cross-instance dashboard copy/import uses saved instance profiles from the native encrypted vault.
            </p>
            {error && <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void unlockVault();
                }}
                className="input-field"
                placeholder={vaultStatus?.exists ? 'Enter vault passphrase' : 'Create vault passphrase'}
              />
              <button type="button" onClick={unlockVault} disabled={busy || !passphrase.trim()} className="btn-primary inline-flex items-center justify-center gap-2">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
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
      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
        <div className="card p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-base font-semibold text-content-primary">Saved-instance dashboard copy/import</h2>
              <p className="mt-1 text-sm text-content-secondary">
                Select one source instance, then choose the exact destination model and folder for each dashboard import target.
              </p>
            </div>
            <button type="button" onClick={refresh} disabled={busy} className="btn-secondary inline-flex items-center justify-center gap-2">
              <RefreshCw size={15} />
              Refresh
            </button>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source instance</label>
              <select value={sourceId} onChange={(event) => setSource(event.target.value)} className="input-field">
                <option value="">Select source</option>
                {sourceInstances.map((instance) => (
                  <option key={instance.id} value={instance.id}>{instance.label}</option>
                ))}
              </select>
              {source && (
                <div className="mt-2 rounded-card border border-border-subtle bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                  Folder scope: {source.defaultFolderPath || source.defaultFolderId || 'My Documents/default'}
                </div>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-content-primary">Add migration target</label>
              <div className="rounded-card border border-border-subtle p-3">
                <p className="text-xs text-content-secondary">
                  A target is one destination instance plus the exact model and folder where selected dashboards will land.
                </p>
                <button
                  type="button"
                  onClick={() => addTarget()}
                  disabled={busy || destinationInstances.length === 0}
                  className="btn-secondary mt-3 inline-flex w-full items-center justify-center gap-2"
                >
                  <Plus size={15} />
                  Add target
                </button>
                {destinationInstances.length === 0 && (
                  <div className="mt-2 text-xs text-content-secondary">No destination instances saved yet.</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <label className="block text-sm font-semibold text-content-primary">Migration targets</label>
                <p className="mt-1 text-xs text-content-secondary">
                  Configure one or more explicit destinations. Add multiple rows for multiple models in the same Omni instance.
                </p>
              </div>
              {hasInvalidTargets && (
                <div className="inline-flex items-center gap-1.5 rounded-chip bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-800">
                  <AlertTriangle size={13} />
                  Target details required
                </div>
              )}
            </div>
            <div className="space-y-3">
              {targets.map((target, index) => {
                const destination = destinationInstances.find((instance) => instance.id === target.destinationInstanceId);
                const catalog = targetCatalog[target.destinationInstanceId];
                const models = catalog?.models || [];
                const folders = catalog?.folders || [];
                return (
                  <div key={target.id} className="rounded-card border border-border-subtle p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">Target {index + 1}</div>
                        <div className="mt-1 text-xs text-content-secondary">
                          {destination?.label || 'Choose a destination'} {target.targetModelName ? `→ ${target.targetModelName}` : ''}
                        </div>
                      </div>
                      <button type="button" onClick={() => removeTarget(target.id)} className="btn-danger inline-flex items-center gap-1 text-xs">
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-3">
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-content-primary">Destination instance</label>
                        <select
                          value={target.destinationInstanceId}
                          onChange={(event) => updateTarget(target.id, { destinationInstanceId: event.target.value })}
                          className="input-field"
                        >
                          <option value="">Select destination</option>
                          {destinationInstances.map((instance) => (
                            <option key={instance.id} value={instance.id}>{instance.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-content-primary">
                          <Database size={12} />
                          Target model
                        </label>
                        <select
                          value={target.targetModelId}
                          onFocus={() => void loadTargetCatalog(target.destinationInstanceId)}
                          onChange={(event) => updateTarget(target.id, { targetModelId: event.target.value })}
                          className="input-field"
                          disabled={!target.destinationInstanceId || catalog?.loading}
                        >
                          <option value="">{catalog?.loading ? 'Loading models...' : 'Select model'}</option>
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>{model.name || model.identifier || model.id}</option>
                          ))}
                          {target.targetModelId && !models.some((model) => model.id === target.targetModelId) && (
                            <option value={target.targetModelId}>{target.targetModelName || target.targetModelId}</option>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-content-primary">
                          <FolderInput size={12} />
                          Target folder
                        </label>
                        <select
                          value={target.targetFolderPath}
                          onFocus={() => void loadTargetCatalog(target.destinationInstanceId)}
                          onChange={(event) => updateTarget(target.id, { targetFolderPath: event.target.value })}
                          className="input-field"
                          disabled={!target.destinationInstanceId || catalog?.loading}
                        >
                          <option value="">My Documents/default</option>
                          {folders.map((folder) => (
                            <option key={`${folder.id}:${folder.path || folder.identifier || folder.name}`} value={folder.path || folder.identifier || folder.id}>
                              {folder.path || folder.identifier || folder.name}
                            </option>
                          ))}
                          {target.targetFolderPath && !folders.some((folder) => folder.path === target.targetFolderPath || folder.identifier === target.targetFolderPath) && (
                            <option value={target.targetFolderPath}>{target.targetFolderPath}</option>
                          )}
                        </select>
                      </div>
                    </div>

                    {catalog?.error && (
                      <div className="mt-3 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                        {catalog.error}
                      </div>
                    )}
                    {target.targetFolderId && !target.targetFolderPath && (
                      <div className="mt-3 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                        This saved folder ID needs a folder path before import can safely run. Choose a folder from the list or clear the folder to use the default destination.
                      </div>
                    )}
                    <div className="mt-3 text-xs text-content-secondary">
                      Import will use model <span className="font-mono">{target.targetModelId || 'not selected'}</span>
                      {target.targetFolderPath ? <> and folder <span className="font-mono">{target.targetFolderPath}</span></> : <> and the default folder</>}.
                    </div>
                  </div>
                );
              })}
              {targets.length === 0 && (
                <div className="rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">
                  Add at least one migration target to choose exactly where dashboards will be imported.
                </div>
              )}
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <label className="block text-sm font-semibold text-content-primary">Source dashboards</label>
                <p className="mt-1 text-xs text-content-secondary">
                  Loaded from the source default folder. Select specific dashboards to copy.
                </p>
              </div>
              <button type="button" onClick={() => loadSourceDocuments()} disabled={busy || !sourceId} className="btn-secondary inline-flex items-center justify-center gap-2">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
                Load dashboards
              </button>
            </div>
            <SearchInput value={search} onChange={setSearch} placeholder="Search dashboard names, labels, model IDs, or folders" />
            <div className="mt-3 max-h-[360px] overflow-auto rounded-card border border-border-subtle">
              {filteredDocuments.map((document) => (
                <label key={document.identifier} className="grid gap-2 border-b border-border-subtle px-3 py-2 text-sm last:border-b-0 hover:bg-surface-secondary md:grid-cols-[auto_1fr_0.9fr] md:items-start">
                  <input
                    type="checkbox"
                    checked={selectedDocumentIds.includes(document.identifier)}
                    onChange={() => toggleDocument(document.identifier)}
                    className="mt-1 accent-omni-600"
                  />
                  <span>
                    <span className="block font-medium text-content-primary">{document.name}</span>
                    <span className="block text-xs text-content-secondary">{document.identifier}</span>
                    {document.labels?.length ? <span className="mt-1 block text-xs text-omni-700">Labels: {document.labels.join(', ')}</span> : null}
                  </span>
                  <span className="text-xs text-content-secondary">
                    Model: {document.baseModelId || 'Unknown'}
                    <br />
                    Folder: {document.folderPath || document.folderId || 'Unknown'}
                  </span>
                </label>
              ))}
              {filteredDocuments.length === 0 && (
                <div className="p-4 text-sm text-content-secondary">
                  {sourceId ? 'No dashboards loaded or matching the search.' : 'Choose a source instance to load dashboards.'}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-card border border-border-subtle p-4">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={emptyFirst}
                  onChange={(event) => {
                    setEmptyFirst(event.target.checked);
                    setPlan(null);
                    setJob(null);
                  }}
                  className="mt-1 accent-omni-600"
                />
                <span>
                  <span className="block text-sm font-semibold text-content-primary">Empty target folders before import</span>
                  <span className="mt-1 block text-xs text-content-secondary">
                    Adds delete steps for every dashboard currently in each selected target folder. Leave off to import without removing destination content.
                  </span>
                </span>
              </label>
            </div>
            <div className="rounded-card border border-border-subtle p-4">
              <div className="text-sm font-semibold text-content-primary">Post-migration actions</div>
              <p className="mt-1 text-xs text-content-secondary">Enable saved HTTPS actions for this job. Results are recorded in job details.</p>
              <div className="mt-3 space-y-2">
                {(source?.postMigrationActions || []).map((action, index) => {
                  const key = actionKey(action, index);
                  return (
                    <label key={key} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" checked={enabledActionKeys.includes(key)} onChange={() => toggleAction(key)} className="mt-1 accent-omni-600" />
                      <span>
                        <span className="font-medium text-content-primary">{action.name}</span>
                        <span className="block truncate text-xs text-content-secondary">{action.method} {action.url}</span>
                      </span>
                    </label>
                  );
                })}
                {!source?.postMigrationActions.length && <div className="text-xs text-content-secondary">No source actions configured.</div>}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={preview}
              disabled={!canRunPreflight}
              className="btn-secondary inline-flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
              Compatibility preflight
            </button>
            <button
              type="button"
              onClick={startJob}
              disabled={!canStartJob}
              className="btn-primary inline-flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              Start copy/import
            </button>
            {!plan && (
              <div className="text-xs text-content-secondary sm:self-center">
                Run compatibility preflight first.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-base font-semibold text-content-primary">Preflight summary</h3>
            {!plan ? (
              <p className="mt-2 text-sm text-content-secondary">
                Run compatibility preflight after choosing the source, migration targets, and dashboards. The plan is generated per target before any import starts.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-card bg-surface-secondary p-2">
                    <div className="font-semibold text-content-primary">{plan.documentIds.length}</div>
                    <div className="text-content-secondary">Dashboards</div>
                  </div>
                  <div className="rounded-card bg-surface-secondary p-2">
                    <div className="font-semibold text-content-primary">{plan.targets?.length || plan.destinationIds.length}</div>
                    <div className="text-content-secondary">Targets</div>
                  </div>
                  <div className="rounded-card bg-surface-secondary p-2">
                    <div className="font-semibold text-content-primary">{plan.steps.length}</div>
                    <div className="text-content-secondary">Steps</div>
                  </div>
                </div>
                <div className="max-h-72 overflow-auto rounded-card border border-border-subtle">
                  {plan.steps.map((step, index) => (
                    <div key={`${step.targetId || step.destinationId}-${step.kind}-${step.documentId}-${index}`} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                      <div className="font-semibold text-content-primary">{step.kind.toUpperCase()} · {step.destinationLabel}</div>
                      <div className="text-content-secondary">{step.documentName || step.documentId || 'Destination cleanup'}</div>
                      {(step.targetModelName || step.targetModelId || step.targetFolderPath) && (
                        <div className="mt-1 text-content-secondary">
                          Target: {step.targetModelName || step.targetModelId || 'Unknown model'}
                          {step.targetFolderPath ? ` · ${step.targetFolderPath}` : ''}
                        </div>
                      )}
                      {step.warnings?.map((warning) => (
                        <div key={warning} className="mt-1 text-yellow-700">{warning}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card p-5">
            <h3 className="text-base font-semibold text-content-primary">Current job</h3>
            {!job ? (
              <p className="mt-2 text-sm text-content-secondary">No active migration job in this session.</p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`rounded-chip px-2.5 py-1 text-xs font-semibold ${statusClass(job.status)}`}>{job.status}</span>
                  <span className="text-xs text-content-secondary">{formatDate(job.createdAt)}</span>
                </div>
                <div className="max-h-80 overflow-auto rounded-card border border-border-subtle">
                  {job.items.map((item) => (
                    <div key={item.id} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-content-primary">{item.kind.toUpperCase()} · {item.destinationLabel}</div>
                          <div className="text-content-secondary">{item.documentName || item.documentId || item.importedIdentifier || 'Job step'}</div>
                          {(item.targetModelName || item.targetModelId || item.targetFolderPath) && (
                            <div className="text-content-secondary">
                              Target: {item.targetModelName || item.targetModelId || 'Unknown model'}
                              {item.targetFolderPath ? ` · ${item.targetFolderPath}` : ''}
                            </div>
                          )}
                        </div>
                        <span className={`rounded-chip px-2 py-0.5 font-semibold ${statusClass(item.status)}`}>{item.status}</span>
                      </div>
                      {item.importedIdentifier && <div className="mt-1 text-content-secondary">Imported: {item.importedIdentifier}</div>}
                      {item.warnings?.map((warning) => <div key={warning} className="mt-1 text-yellow-700">{warning}</div>)}
                      {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
                    </div>
                  ))}
                </div>
                {(job.status === 'failed' || job.status === 'partial') && (
                  <button type="button" onClick={() => retryJob(job.id)} disabled={busy} className="btn-secondary inline-flex w-full items-center justify-center gap-2">
                    <RefreshCw size={15} />
                    Retry failed import/export items
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="card p-5">
            <h3 className="text-base font-semibold text-content-primary">Recent jobs</h3>
            <div className="mt-3 space-y-2">
              {jobs.slice(0, 5).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setJob(row)}
                  className="w-full rounded-card border border-border-subtle px-3 py-2 text-left hover:bg-surface-secondary"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-content-primary">{row.sourceLabel}</span>
                    <span className={`rounded-chip px-2 py-0.5 font-semibold ${statusClass(row.status)}`}>{row.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-content-secondary">
                    {row.documentIds.length} dashboards · {row.targets?.length || row.destinationIds.length} targets · {formatDate(row.createdAt)}
                  </div>
                </button>
              ))}
              {jobs.length === 0 && <div className="text-sm text-content-secondary">No migration jobs yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
