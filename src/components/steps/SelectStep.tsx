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
} from 'lucide-react';
import { listFolders, listDocuments, enrichDocuments } from '@/services/omniApi';
import { SkeletonRow } from '@/components/ui/SkeletonRow';
import { InspectExportModal } from '@/components/ui/InspectExportModal';
import type { WizardState, WizardAction, OmniFolder, OmniDocument } from '@/types';

interface FolderNodeProps {
  folder: OmniFolder;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (folder: OmniFolder) => void;
  depth?: number;
}

function FolderNode({ folder, selectedFolderId, expandedIds, onToggle, onSelect, depth = 0 }: FolderNodeProps) {
  const isExpanded = expandedIds.has(folder.id);
  const isSelected = selectedFolderId === folder.id;
  const hasChildren = folder.children && folder.children.length > 0;

  return (
    <div>
      <button
        onClick={() => {
          onSelect(folder);
          if (hasChildren) onToggle(folder.id);
        }}
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
      </button>
      {isExpanded && folder.children?.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
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
              state.folders.map((folder) => (
                <FolderNode
                  key={folder.id}
                  folder={folder}
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
            disabled={state.selectedDashboards.length === 0}
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
