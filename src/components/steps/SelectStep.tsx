import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  AlertTriangle,
  Search,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Layers,
  X,
  KeyRound,
  Lock,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { listFolders, listDocuments, enrichDocuments, testConnection } from '@/services/omniApi';
import { SkeletonRow } from '@/components/ui/SkeletonRow';
import { InspectExportModal } from '@/components/ui/InspectExportModal';
import type { WizardState, WizardAction, OmniFolder, OmniDocument } from '@/types';
import {
  createInstanceVault,
  deleteInstanceFromVault,
  getUnlockedInstanceVault,
  hasInstanceVault,
  isInstanceVaultUnlocked,
  lockInstanceVault,
  saveInstanceToVault,
  unlockInstanceVault,
  type SavedOmniInstance,
} from '@/services/instanceVault';

interface FolderNodeProps {
  folder: OmniFolder;
  nodeKey: string;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (folder: OmniFolder) => void;
  depth?: number;
}

function FolderNode({ folder, nodeKey, selectedFolderId, expandedIds, onToggle, onSelect, depth = 0 }: FolderNodeProps) {
  const isExpanded = expandedIds.has(folder.id);
  const isSelected = selectedFolderId === folder.id;
  const hasChildren = folder.children && folder.children.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelect(folder);
          if (hasChildren) onToggle(folder.id);
        }}
        aria-pressed={isSelected}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-button transition-all duration-150 ${
          isSelected
            ? 'text-omni-700 font-semibold'
            : 'text-content-primary hover:bg-surface-secondary'
        }`}
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          background: isSelected ? '#F8F9FD' : undefined,
          borderLeft: isSelected ? '2px solid #FF4794' : '2px solid transparent',
        }}
      >
        {hasChildren ? (
          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : (
          <span className="w-3.5" />
        )}
        {isExpanded ? (
          <FolderOpen size={15} className="text-omni-500 flex-shrink-0" />
        ) : (
          <Folder size={15} className={isSelected ? 'text-omni-600 flex-shrink-0' : 'text-content-secondary flex-shrink-0'} />
        )}
        <span className="truncate">{folder.name}</span>
        {isSelected && <CheckCircle2 size={13} className="ml-auto shrink-0 text-omni-700" />}
      </button>
      {isExpanded && folder.children?.map((child, index) => (
        <FolderNode
          key={`${nodeKey}/${child.id || child.name}/${index}`}
          folder={child}
          nodeKey={`${nodeKey}/${child.id || child.name}/${index}`}
          selectedFolderId={selectedFolderId}
          expandedIds={expandedIds}
          onToggle={onToggle}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

interface SelectStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onNext: () => void;
  onBack: () => void;
}

function hostFromUrl(value: string): string {
  if (!value.trim()) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return parsed.host;
  } catch {
    return '';
  }
}

export function SelectStep({ state, dispatch, onNext, onBack }: SelectStepProps) {
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedFolderName, setSelectedFolderName] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [inspectDoc, setInspectDoc] = useState<OmniDocument | null>(null);
  const [testingTarget, setTestingTarget] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultName, setVaultName] = useState('');
  const [vaultNotice, setVaultNotice] = useState('');
  const [vaultError, setVaultError] = useState('');
  const [vaultExists, setVaultExists] = useState(() => hasInstanceVault());
  const [vaultUnlocked, setVaultUnlocked] = useState(() => isInstanceVaultUnlocked());
  const [savedInstances, setSavedInstances] = useState<SavedOmniInstance[]>(() => getUnlockedInstanceVault()?.instances ?? []);

  const selectedIds = useMemo(
    () => new Set(state.selectedDashboards.map((d) => d.id)),
    [state.selectedDashboards]
  );

  useEffect(() => {
    if (state.folders.length > 0) return;
    if (!state.source.baseUrl || !state.source.apiKey) return;
    async function fetchFolders() {
      setLoadingFolders(true);
      setError('');
      try {
        const res = await listFolders(state.source.baseUrl, state.source.apiKey, { allPages: true, pageSize: 100 });
        if (res.error) {
          setError(`API error: ${res.error}${res.detail ? ` — ${res.detail}` : ''}`);
          return;
        }
        const folders = Array.isArray(res.folders) ? res.folders : [];
        if (folders.length === 0 && res.rawResponse !== undefined) {
          setError(`No folders found. Unexpected API response shape: ${JSON.stringify(res.rawResponse).slice(0, 200)}`);
          return;
        }
        dispatch({ type: 'SET_FOLDERS', folders });
      } catch (err) {
        setError(`Failed to load folders: ${err instanceof Error ? err.message : 'Unknown error'}. Go back and check your connection.`);
      } finally {
        setLoadingFolders(false);
      }
    }
    fetchFolders();
  }, [state.source.baseUrl, state.source.apiKey, state.folders.length, dispatch]);

  async function handleFolderSelect(folder: OmniFolder) {
    setSelectedFolderId(folder.id);
    setSelectedFolderName(folder.name);
    setLoadingDocs(true);
    setError('');
    try {
      const res = await listDocuments(state.source.baseUrl, state.source.apiKey, folder.id, { allPages: true, pageSize: 100 });
      if (res.error) {
        setError(`API error loading documents: ${res.error}`);
        return;
      }
      const docs: OmniDocument[] = Array.isArray(res.documents) ? res.documents : [];
      dispatch({ type: 'SET_DOCUMENTS', documents: docs });

      const idsToEnrich = docs.filter((d) => !d.baseModelId).map((d) => d.id);
      if (idsToEnrich.length > 0) {
        setEnriching(true);
        try {
          const enrichments = await enrichDocuments(state.source.baseUrl, state.source.apiKey, idsToEnrich);
          dispatch({ type: 'ENRICH_DOCUMENTS', enrichments });
        } catch {
          // enrichment is best-effort
        } finally {
          setEnriching(false);
        }
      }
    } catch (err) {
      setError(`Failed to load documents: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoadingDocs(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filteredDocs = useMemo(() => {
    if (!search) return state.documents;
    const q = search.toLowerCase();
    return state.documents.filter(
      (d) => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)
    );
  }, [state.documents, search]);

  const toggleDashboard = useCallback((doc: OmniDocument) => {
    if (selectedIds.has(doc.id)) {
      dispatch({
        type: 'SET_SELECTED_DASHBOARDS',
        dashboards: state.selectedDashboards.filter((d) => d.id !== doc.id),
      });
    } else {
      dispatch({
        type: 'SET_SELECTED_DASHBOARDS',
        dashboards: [...state.selectedDashboards, doc],
      });
    }
  }, [dispatch, selectedIds, state.selectedDashboards]);

  const handleSelectAll = useCallback(() => {
    if (filteredDocs.length === 0) return;
    const allInView = filteredDocs.every((d) => selectedIds.has(d.id));
    if (allInView) {
      const viewIds = new Set(filteredDocs.map((d) => d.id));
      dispatch({
        type: 'SET_SELECTED_DASHBOARDS',
        dashboards: state.selectedDashboards.filter((d) => !viewIds.has(d.id)),
      });
    } else {
      const newDocs = filteredDocs.filter((d) => !selectedIds.has(d.id));
      dispatch({
        type: 'SET_SELECTED_DASHBOARDS',
        dashboards: [...state.selectedDashboards, ...newDocs],
      });
    }
  }, [filteredDocs, selectedIds, state.selectedDashboards, dispatch]);

  const allInViewSelected = filteredDocs.length > 0 && filteredDocs.every((d) => selectedIds.has(d.id));
  const selectedInView = filteredDocs.filter((d) => selectedIds.has(d.id)).length;

  const totalFolders = useMemo(() => {
    let count = 0;
    const walk = (list: OmniFolder[]) => {
      for (const f of list) {
        count++;
        if (f.children) walk(f.children);
      }
    };
    walk(state.folders);
    return count;
  }, [state.folders]);

  const targetHost = hostFromUrl(state.target.baseUrl);
  const sourceHost = hostFromUrl(state.source.baseUrl);
  const targetCanTest = Boolean(state.target.baseUrl.trim() && state.target.apiKey.trim() && !testingTarget);
  const targetReady = state.sameInstance || state.target.status === 'success';

  const refreshVaultState = useCallback(() => {
    setVaultExists(hasInstanceVault());
    const vault = getUnlockedInstanceVault();
    setVaultUnlocked(Boolean(vault));
    setSavedInstances(vault?.instances ?? []);
  }, []);

  useEffect(() => {
    refreshVaultState();
  }, [refreshVaultState]);

  const selectedVaultInstance = useMemo(
    () => savedInstances.find((instance) => instance.baseUrl.trim().toLowerCase() === state.target.baseUrl.trim().toLowerCase()),
    [savedInstances, state.target.baseUrl],
  );

  async function handleTargetTest() {
    if (!state.target.baseUrl.trim() || !state.target.apiKey.trim()) return;
    setTestingTarget(true);
    dispatch({ type: 'UPDATE_TARGET', payload: { status: 'testing', errorMessage: '' } });
    try {
      const result = await testConnection(state.target.baseUrl, state.target.apiKey) as { status?: string; message?: string };
      if (result.status === 'ok') {
        dispatch({ type: 'UPDATE_TARGET', payload: { status: 'success', errorMessage: '' } });
      } else {
        dispatch({ type: 'UPDATE_TARGET', payload: { status: 'error', errorMessage: result.message || 'Target connection failed.' } });
      }
    } catch (err) {
      dispatch({
        type: 'UPDATE_TARGET',
        payload: {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Target connection failed.',
        },
      });
    } finally {
      setTestingTarget(false);
    }
  }

  async function handleUnlockVault() {
    setVaultBusy(true);
    setVaultError('');
    setVaultNotice('');
    try {
      const payload = vaultExists
        ? await unlockInstanceVault(vaultPassword)
        : await createInstanceVault(vaultPassword);
      setSavedInstances(payload.instances);
      setVaultUnlocked(true);
      setVaultExists(true);
      setVaultPassword('');
      setVaultNotice(vaultExists ? 'Legacy browser vault unlocked for this app session.' : 'Legacy browser vault created.');
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not unlock the instance vault.');
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleSaveTargetInstance() {
    setVaultBusy(true);
    setVaultError('');
    setVaultNotice('');
    try {
      const saved = await saveInstanceToVault({
        id: selectedVaultInstance?.id,
        name: vaultName || targetHost || state.target.baseUrl,
        connection: state.target,
        defaultTargetFolder: state.targetFolder,
      });
      refreshVaultState();
      setVaultName(saved.name);
      setVaultNotice(`Saved ${saved.name} to the legacy browser vault. Import it into the native vault from Instance Manager when ready.`);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not save the target instance.');
    } finally {
      setVaultBusy(false);
    }
  }

  function handleUseSavedInstance(instance: SavedOmniInstance) {
    dispatch({
      type: 'UPDATE_TARGET',
      payload: {
        baseUrl: instance.baseUrl,
        apiKey: instance.apiKey,
        status: instance.lastValidatedAt ? 'success' : 'untested',
        errorMessage: '',
      },
    });
    if (instance.defaultTargetFolder) {
      dispatch({ type: 'SET_TARGET_FOLDER', folder: instance.defaultTargetFolder });
    }
    setVaultName(instance.name);
    setVaultNotice(`Loaded ${instance.name} as the target instance.`);
    setVaultError('');
  }

  async function handleDeleteSavedInstance(instance: SavedOmniInstance) {
    setVaultBusy(true);
    setVaultError('');
    setVaultNotice('');
    try {
      await deleteInstanceFromVault(instance.id);
      refreshVaultState();
      setVaultNotice(`Removed ${instance.name} from the instance vault.`);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not remove the saved instance.');
    } finally {
      setVaultBusy(false);
    }
  }

  function handleLockVault() {
    lockInstanceVault();
    refreshVaultState();
    setVaultPassword('');
    setVaultName('');
    setVaultNotice('Legacy browser vault locked.');
    setVaultError('');
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] px-2 py-0.5 rounded-full"
              style={{
                background: '#F8F9FD',
                color: '#C8186A',
                border: '1px solid rgba(255,71,148,0.2)',
              }}
            >
              Step 1 of 4
            </span>
            {totalFolders > 0 && (
              <span className="text-[11px] text-content-tertiary font-medium">
                {totalFolders} folder{totalFolders !== 1 ? 's' : ''} available
              </span>
            )}
          </div>
          <h2 className="text-[26px] font-bold text-content-primary tracking-tight leading-tight">
            Select Dashboards
          </h2>
          <p className="text-[13px] text-content-secondary mt-1 leading-relaxed max-w-xl">
            Pick a folder on the left, then choose the dashboards you want to migrate. You can search within a folder to narrow the list.
          </p>
        </div>

        {state.selectedDashboards.length > 0 && (
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-xl animate-fadeIn"
            style={{
	              background: '#FFFFFF',
              border: '1px solid rgba(16,185,129,0.22)',
            }}
          >
            <CheckCircle2 size={14} className="text-emerald-600" />
            <span className="text-[12px] font-semibold text-emerald-700">
              {state.selectedDashboards.length} dashboard{state.selectedDashboards.length !== 1 ? 's' : ''} queued
            </span>
          </div>
        )}
      </div>

      {error && (
        <div
          className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-sm"
          style={{
	            background: '#FFFFFF',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#B91C1C',
          }}
        >
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      <div
        className="rounded-2xl bg-white p-4"
        style={{
          border: '1px solid rgba(217,222,232,0.95)',
          boxShadow: '0 1px 3px rgba(64,71,84,0.08)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-content-primary">Migration mode</h3>
            <p className="mt-1 text-xs text-content-secondary leading-relaxed">
              Same-instance model remap is the default. Turn on cross-instance migration only when you want OmniKit to copy dashboards into another Omni instance.
            </p>
          </div>
          <div className="inline-flex rounded-xl border border-border bg-surface-secondary p-1">
            <button
              type="button"
              onClick={() => dispatch({ type: 'SET_SAME_INSTANCE', value: true })}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                state.sameInstance
                  ? 'bg-white text-omni-700 shadow-sm'
                  : 'text-content-secondary hover:text-content-primary'
              }`}
            >
              Same instance
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'SET_SAME_INSTANCE', value: false })}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                !state.sameInstance
                  ? 'bg-white text-omni-700 shadow-sm'
                  : 'text-content-secondary hover:text-content-primary'
              }`}
            >
              Copy to another instance
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-border/70 bg-surface-secondary px-3 py-2.5 text-xs text-content-secondary">
          <span className="font-semibold text-content-primary">Source (active connection):</span>{' '}
          <span className="font-mono">{sourceHost || 'Connected instance'}</span>
          <span className="mx-2 text-content-tertiary">→</span>
          <span className="font-semibold text-content-primary">Target:</span>{' '}
          <span className="font-mono">{state.sameInstance ? sourceHost || 'Same instance' : targetHost || 'Target instance required'}</span>
          {!state.sameInstance && (
            <div className="mt-1 text-[11px] leading-relaxed text-content-tertiary">
              To copy dashboards into the current instance, connect OmniKit to the other instance first, then enter the current instance as the target.
            </div>
          )}
        </div>

        {!state.sameInstance && (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-omni-100 bg-omni-50/50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <ShieldCheck size={15} className="mt-0.5 text-omni-700" />
                  <div>
                    <h4 className="text-xs font-semibold text-content-primary">Legacy browser vault</h4>
                    <p className="mt-1 text-[11px] leading-relaxed text-content-secondary">
                      This older browser-encrypted vault is kept only for existing saved targets. For reusable multi-instance credentials, use Instance Manager and the native encrypted vault.
                    </p>
                  </div>
                </div>
                {vaultUnlocked && (
                  <button type="button" onClick={handleLockVault} className="btn-secondary text-xs">
                    <Lock size={12} />
                    Lock
                  </button>
                )}
              </div>

              {!vaultUnlocked ? (
                <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                  <div>
                    <label htmlFor="instance-vault-password" className="mb-1.5 block text-xs font-semibold text-content-primary">
                      Legacy vault password
                    </label>
                    <input
                      id="instance-vault-password"
                      type="password"
                      value={vaultPassword}
                      onChange={(e) => setVaultPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleUnlockVault();
                      }}
                      placeholder={vaultExists ? 'Unlock legacy saved targets' : 'Create legacy vault password'}
                      className="input-field"
                      autoComplete="new-password"
                    />
                  </div>
                  <button type="button" onClick={handleUnlockVault} disabled={vaultBusy || !vaultPassword.trim()} className="btn-primary h-10 justify-center text-sm">
                    {vaultBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                    {vaultExists ? 'Unlock legacy vault' : 'Create legacy vault'}
                  </button>
                  <p className="md:col-span-2 text-[11px] leading-relaxed text-content-tertiary">
                    Prefer Instance Manager for new saved instances. This compatibility vault lives in browser storage and can be imported into the native vault from Instance Manager.
                  </p>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {savedInstances.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-omni-200 bg-white px-3 py-2 text-[11px] text-content-secondary">
                      No legacy target instances saved. For new reusable targets, use Instance Manager and the native vault.
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {savedInstances.map((instance) => (
                        <div key={instance.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-white px-3 py-2">
                          <button
                            type="button"
                            onClick={() => handleUseSavedInstance(instance)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="truncate text-xs font-semibold text-content-primary">{instance.name}</div>
                            <div className="truncate font-mono text-[10px] text-content-tertiary">{hostFromUrl(instance.baseUrl) || instance.baseUrl}</div>
                            {instance.defaultTargetFolder && (
                              <div className="truncate text-[10px] text-content-tertiary">Default folder: {instance.defaultTargetFolder}</div>
                            )}
                          </button>
                          <div className="flex items-center gap-2">
                            {instance.lastValidatedAt && (
                              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                Tested
                              </span>
                            )}
                            <button type="button" onClick={() => handleUseSavedInstance(instance)} className="btn-secondary text-xs">
                              Use
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteSavedInstance(instance)}
                              className="rounded-lg border border-border p-2 text-content-tertiary hover:border-red-200 hover:text-red-600"
                              aria-label={`Delete ${instance.name}`}
                              disabled={vaultBusy}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <div>
                      <label htmlFor="target-instance-name" className="mb-1.5 block text-xs font-semibold text-content-primary">
                        Legacy saved target name
                      </label>
                      <input
                        id="target-instance-name"
                        type="text"
                        value={vaultName}
                        onChange={(e) => setVaultName(e.target.value)}
                        placeholder={targetHost || 'Production target'}
                        className="input-field"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSaveTargetInstance()}
                      disabled={vaultBusy || !state.target.baseUrl.trim() || !state.target.apiKey.trim()}
                      className="btn-secondary h-10 justify-center text-sm"
                    >
                      {vaultBusy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                      {selectedVaultInstance ? 'Update legacy target' : 'Save legacy target'}
                    </button>
                  </div>
                </div>
              )}

              {vaultNotice && (
                <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  {vaultNotice}
                </div>
              )}
              {vaultError && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {vaultError}
                </div>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
              <div>
                <label htmlFor="target-base-url" className="mb-1.5 block text-xs font-semibold text-content-primary">
                  Target Base URL
                </label>
                <input
                  id="target-base-url"
                  type="url"
                  value={state.target.baseUrl}
                  onChange={(e) => dispatch({ type: 'UPDATE_TARGET', payload: { baseUrl: e.target.value, status: 'untested', errorMessage: '' } })}
                  placeholder="https://target-org.omni.co"
                  className="input-field"
                />
              </div>
              <div>
                <label htmlFor="target-api-key" className="mb-1.5 block text-xs font-semibold text-content-primary">
                  Target API Key
                </label>
                <input
                  id="target-api-key"
                  type="password"
                  value={state.target.apiKey}
                  onChange={(e) => dispatch({ type: 'UPDATE_TARGET', payload: { apiKey: e.target.value, status: 'untested', errorMessage: '' } })}
                  placeholder="Paste target API key"
                  className="input-field font-mono text-[13px]"
                  autoComplete="new-password"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              </div>
              <button
                type="button"
                onClick={handleTargetTest}
                disabled={!targetCanTest}
                className={`h-10 justify-center text-sm ${
                  state.target.status === 'success'
                    ? 'btn-primary shadow-[0_0_0_4px_rgba(255,71,148,0.18)]'
                    : 'btn-secondary'
                }`}
              >
                {testingTarget ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Testing
                  </>
                ) : state.target.status === 'success' ? (
                  <>
                    <CheckCircle2 size={14} />
                    Connected
                  </>
                ) : (
                  'Test Target'
                )}
              </button>
              <div className="lg:col-span-3">
                <label htmlFor="target-folder" className="mb-1.5 block text-xs font-semibold text-content-primary">
                  Target folder path <span className="font-normal text-content-tertiary">(optional)</span>
                </label>
                <input
                  id="target-folder"
                  type="text"
                  value={state.targetFolder}
                  onChange={(e) => dispatch({ type: 'SET_TARGET_FOLDER', folder: e.target.value })}
                  placeholder="e.g. Executive Dashboards/Migrated"
                  className="input-field"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-content-tertiary">
                  Leave blank to let Omni import into the target instance default location. When provided, OmniKit moves the imported dashboard to this folder after creation.
                </p>
              </div>
              {state.target.status === 'success' && (
                <div className="lg:col-span-3 flex items-start gap-2 rounded-xl border border-omni-200 bg-omni-50 px-3 py-2 text-xs text-omni-800">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-omni-500 animate-pulse" />
                  <span>
                    <span className="font-semibold">Target instance verified.</span> Model mapping and compatibility preflight will use this tested target connection.
                  </span>
                </div>
              )}
              {state.target.status === 'error' && state.target.errorMessage && (
                <div className="lg:col-span-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {state.target.errorMessage}
                </div>
              )}
            </div>
          </div>
        )}

        {!targetReady && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span>Test the target instance before continuing so model mapping and compatibility preflight run against the correct Omni instance.</span>
          </div>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-4 min-h-[440px]">
        <aside
          className="md:w-72 flex-shrink-0 rounded-2xl bg-white overflow-hidden flex flex-col"
          style={{
            border: '1px solid rgba(217,222,232,0.95)',
            boxShadow: '0 1px 3px rgba(64,71,84,0.08)',
          }}
        >
          <div
            className="px-4 py-2.5 flex items-center justify-between"
            style={{
	              borderBottom: '1px solid rgba(217,222,232,0.95)',
	              background: '#F8F9FD',
            }}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-6 h-6 rounded-lg flex items-center justify-center"
                style={{
	                  background: '#FFFFFF',
                  border: '1px solid rgba(255,71,148,0.2)',
                }}
              >
                <Folder size={12} className="text-omni-600" />
              </div>
              <span className="text-[11px] font-bold uppercase tracking-widest text-content-tertiary">
                Folders
              </span>
            </div>
            {totalFolders > 0 && (
              <span className="text-[10px] font-semibold text-content-tertiary px-1.5 py-0.5 rounded"
	                    style={{ background: '#F8F9FD' }}>
                {totalFolders}
              </span>
            )}
          </div>
          <div className="p-2 overflow-y-auto max-h-[440px] flex-1">
            {loadingFolders ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Loader2 size={20} className="text-omni-500 animate-spin" />
                <span className="text-[11px] text-content-tertiary">Loading folders…</span>
              </div>
            ) : state.folders.length === 0 ? (
              <div className="text-center py-8 px-3">
                <img
                  src="/blobby-empty.png"
                  alt=""
                  className="w-12 h-12 mx-auto object-contain mb-2 opacity-80"
                  aria-hidden
                />
                <p className="text-xs text-content-secondary">No folders found.</p>
              </div>
            ) : (
              state.folders.map((folder, index) => (
                <FolderNode
                  key={`${folder.id || folder.name}/${index}`}
                  folder={folder}
                  nodeKey={`${folder.id || folder.name}/${index}`}
                  selectedFolderId={selectedFolderId}
                  expandedIds={expandedIds}
                  onToggle={toggleExpanded}
                  onSelect={handleFolderSelect}
                />
              ))
            )}
          </div>
        </aside>

        <section
          className="flex-1 rounded-2xl bg-white overflow-hidden flex flex-col"
          style={{
            border: '1px solid rgba(217,222,232,0.95)',
            boxShadow: '0 1px 3px rgba(64,71,84,0.08)',
          }}
        >
          <div
            className="px-4 py-3 flex items-center justify-between gap-3"
            style={{
	              borderBottom: '1px solid rgba(217,222,232,0.95)',
	              background: '#F8F9FD',
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div
                className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{
	                  background: '#FFFFFF',
                  border: '1px solid rgba(255,71,148,0.2)',
                }}
              >
                <Layers size={12} className="text-omni-600" />
              </div>
              <div className="flex items-center gap-1.5 text-[11px] min-w-0">
                <span className="font-bold uppercase tracking-widest text-content-tertiary">
                  Dashboards
                </span>
                {selectedFolderName && (
                  <>
                    <ChevronRight size={11} className="text-content-tertiary/60 flex-shrink-0" />
                    <span className="font-semibold text-content-primary truncate max-w-[240px]">
                      {selectedFolderName}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {filteredDocs.length > 0 && (
                <>
                  <span className="text-[10px] font-semibold text-content-tertiary px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(255,71,148,0.08)' }}>
                    {selectedInView}/{filteredDocs.length}
                  </span>
                  <button
                    type="button"
                    onClick={handleSelectAll}
	                    className="text-[11px] font-semibold text-omni-700 hover:text-omni-800 transition-colors px-2 py-1 rounded-md hover:bg-surface-secondary"
                  >
                    {allInViewSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </>
              )}
            </div>
          </div>

          {selectedFolderId && state.documents.length > 0 && (
            <div
              className="px-4 py-2.5"
              style={{ borderBottom: '1px solid rgba(242,206,220,0.5)' }}
            >
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search dashboards in this folder…"
	                  className="w-full pl-9 pr-9 py-2 text-[13px] rounded-lg bg-surface-secondary border border-transparent focus:bg-white focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-border/70 transition-all placeholder:text-content-tertiary"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
	                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-content-tertiary hover:text-content-primary hover:bg-surface-secondary"
                    aria-label="Clear search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="overflow-y-auto flex-1 max-h-[440px]">
            {loadingDocs ? (
              <div className="p-2 space-y-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <SkeletonRow key={i} columns={3} index={i} />
                ))}
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-mascot">
                  <img
                    src={
                      search
                        ? '/blobby-no-results.png'
                        : selectedFolderId
                        ? '/blobby-empty.png'
                        : '/blobby-getting-started.png'
                    }
                    alt=""
                    className="w-16 h-16 object-contain animate-float"
                    style={{ animationDuration: '3s' }}
                    aria-hidden
                  />
                </div>
                <p className="text-sm font-semibold text-content-primary">
                  {search
                    ? 'No dashboards match your search.'
                    : selectedFolderId
                    ? 'This folder is empty.'
                    : 'Select a folder to browse dashboards.'}
                </p>
                <p className="text-xs text-content-tertiary mt-1 max-w-xs text-center leading-relaxed">
                  {search
                    ? 'Try a different name or clear the search to see everything.'
                    : selectedFolderId
                    ? 'Pick another folder from the sidebar to continue.'
                    : 'Choose a folder from the left panel to see its dashboards.'}
                </p>
              </div>
            ) : (
              filteredDocs.map((doc, index) => {
                const checked = selectedIds.has(doc.id);
                return (
                  <label
                    key={doc.id || `doc-${index}`}
                    className="flex items-center px-4 py-3 border-b border-border/40 cursor-pointer transition-all duration-150 group"
                    style={{
	                      background: checked ? '#F8F9FD' : undefined,
                      borderLeft: checked ? '3px solid #FF4794' : '3px solid transparent',
                    }}
                    onMouseEnter={(e) => {
	                      if (!checked) e.currentTarget.style.background = '#F8F9FD';
                    }}
                    onMouseLeave={(e) => {
                      if (!checked) e.currentTarget.style.background = '';
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDashboard(doc)}
                      className="flex-shrink-0"
                    />
                    <div className="ml-3 flex-1 min-w-0">
                      <div className={`text-sm truncate ${checked ? 'font-semibold text-omni-700' : 'text-content-primary'}`}>
                        {doc.name}
                      </div>
                      {doc.folderPath && (
                        <div className="text-xs text-content-tertiary truncate mt-0.5">{doc.folderPath}</div>
                      )}
                    </div>
                    {checked && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-chip bg-omni-600 px-2 py-1 text-[10px] font-semibold text-white">
                        <CheckCircle2 size={12} />
                        Selected
                      </span>
                    )}
                    <div className="ml-3 flex-shrink-0 flex items-center gap-2">
                      {!doc.baseModelId && enriching ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-content-tertiary">
                          <Loader2 size={12} className="animate-spin" />
                          Detecting…
                        </div>
                      ) : doc.baseModelId ? (
                        <div className="text-right max-w-[200px]">
                          <div className="text-xs font-medium text-content-primary truncate">
                            {doc.baseModelName || doc.baseModelId}
                          </div>
                          {doc.baseModelName && (
                            <div className="text-[10px] text-content-tertiary/80 font-mono truncate">
                              {doc.baseModelId}
                            </div>
                          )}
                          {doc.topicNames && doc.topicNames.length > 0 && (
                            <div className="text-[10px] text-content-secondary/70 truncate">
                              {doc.topicNames.join(', ')}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] text-amber-700 px-2 py-0.5 rounded-full"
                          style={{
                            background: 'rgba(245,158,11,0.1)',
                            border: '1px solid rgba(245,158,11,0.25)',
                          }}
                          title={doc.enrichmentError || 'Model not detected'}
                        >
                          <AlertTriangle size={10} className="flex-shrink-0" />
                          No model
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setInspectDoc(doc);
                        }}
	                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold text-content-tertiary hover:text-omni-700 hover:bg-surface-secondary transition-all opacity-0 group-hover:opacity-100"
                        title="Inspect raw export payload"
                      >
                        <Search size={10} />
                        Inspect
                      </button>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </section>
      </div>

      <div
        className="sticky bottom-0 -mx-6 md:-mx-10 px-6 md:px-10 py-3 flex items-center justify-between gap-4 z-20"
        style={{
	          background: '#FFFFFF',
	          borderTop: '1px solid rgba(217,222,232,0.95)',
        }}
      >
        <button onClick={onBack} className="btn-secondary">
          <ArrowLeft size={14} />
          Back
        </button>
        <div className="flex items-center gap-3">
          {state.selectedDashboards.length > 0 ? (
            <span className="text-[12px] text-content-secondary">
              <span className="font-semibold text-content-primary">{state.selectedDashboards.length}</span>{' '}
              selected · ready to map
            </span>
          ) : (
            <span className="text-[12px] text-content-tertiary">
              Select at least one dashboard to continue
            </span>
          )}
          <button
            onClick={onNext}
            disabled={state.selectedDashboards.length === 0 || !targetReady}
            className="btn-primary"
          >
            Next
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      <InspectExportModal
        open={inspectDoc !== null}
        onClose={() => setInspectDoc(null)}
        baseUrl={state.source.baseUrl}
        apiKey={state.source.apiKey}
        documentId={inspectDoc?.id ?? ''}
        documentName={inspectDoc?.name ?? ''}
      />
    </div>
  );
}
