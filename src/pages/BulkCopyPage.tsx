import { useState, useEffect, useMemo } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  Copy,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { listFolders, listDocuments, enrichDocuments, bulkCopyDocuments } from '@/services/omniApi';
import { deriveScopeFromFolderPath } from '@/services/scope';
import { useConnection } from '@/contexts/ConnectionContext';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { SkeletonRow } from '@/components/ui/SkeletonRow';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { BulkOperationAnimation } from '@/components/ui/BulkOperationAnimation';
import { StatusChip } from '@/components/ui/StatusChip';
import { Blobby } from '@/components/ui/Blobby';
import {
  selectedBadgeClass,
  selectedRowClass,
  selectedTreeRowClass,
  unselectedRowClass,
  unselectedTreeRowClass,
} from '@/components/ui/selectionStyles';
import type { OmniFolder, OmniDocument, BulkOperationResult, BulkOperationSummary } from '@/types';

function FolderNode({
  folder,
  selectedFolderId,
  expandedIds,
  onToggle,
  onSelect,
  depth = 0,
}: {
  folder: OmniFolder;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (folder: OmniFolder) => void;
  depth?: number;
}) {
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
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-button transition-all ${
          isSelected ? selectedTreeRowClass : unselectedTreeRowClass
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : (
          <span className="w-3.5" />
        )}
        {isExpanded ? (
          <FolderOpen size={15} className="text-omni-500 flex-shrink-0" />
        ) : (
          <Folder size={15} className="text-content-secondary flex-shrink-0" />
        )}
        <span className="truncate">{folder.name}</span>
        {isSelected && <CheckCircle size={13} className="ml-auto shrink-0 text-omni-700" />}
      </button>
      {isExpanded &&
        folder.children?.map((child) => (
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

function DestinationFolderPicker({
  folders,
  selectedId,
  onSelect,
}: {
  folders: OmniFolder[];
  selectedId: string;
  onSelect: (folder: OmniFolder) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function PickerNode({ folder, depth = 0 }: { folder: OmniFolder; depth?: number }) {
    const isExpanded = expandedIds.has(folder.id);
    const isSelected = folder.id === selectedId;
    const hasChildren = folder.children && folder.children.length > 0;

    return (
      <div>
        <button
          type="button"
          onClick={() => {
            onSelect(folder);
            if (hasChildren) toggleExpanded(folder.id);
          }}
          aria-pressed={isSelected}
          className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-button transition-all ${
            isSelected ? selectedTreeRowClass : unselectedTreeRowClass
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {hasChildren ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span className="w-3.5" />
          )}
          {isExpanded ? (
            <FolderOpen size={15} className="text-omni-500 flex-shrink-0" />
          ) : (
            <Folder size={15} className="text-content-secondary flex-shrink-0" />
          )}
          <span className="truncate">{folder.name}</span>
          {isSelected && <CheckCircle size={13} className="ml-auto shrink-0 text-omni-700" />}
        </button>
        {isExpanded &&
          folder.children?.map((child) => (
            <PickerNode key={child.id} folder={child} depth={depth + 1} />
          ))}
      </div>
    );
  }

  return (
    <div>
      {folders.map((folder) => (
        <PickerNode key={folder.id} folder={folder} />
      ))}
    </div>
  );
}

export function BulkCopyPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [documents, setDocuments] = useState<OmniDocument[]>([]);
  const [selected, setSelected] = useState<OmniDocument[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [targetFolderId, setTargetFolderId] = useState('');
  const [targetFolderPath, setTargetFolderPath] = useState('');
  const [targetFolderDisplay, setTargetFolderDisplay] = useState('');
  const [renameSuffix, setRenameSuffix] = useState(' (Copy)');
  const [showConfirm, setShowConfirm] = useState(false);
  const [copying, setCopying] = useState(false);
  const [results, setResults] = useState<BulkOperationResult[]>([]);
  const [summary, setSummary] = useState<BulkOperationSummary | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  useEffect(() => {
    async function fetchFolders() {
      const requestKey = connectionKey;
      setLoadingFolders(true);
      setError('');
      setFolders([]);
      setDocuments([]);
      setSelected([]);
      setSelectedFolderId(null);
      try {
        const res = await listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        if (!isActiveConnectionRequest(requestKey)) return;
        if (res.error) {
          setError(`API error: ${res.error}`);
          return;
        }
        setFolders(Array.isArray(res.folders) ? res.folders : []);
      } catch (err) {
        if (!isActiveConnectionRequest(requestKey)) return;
        setError(`Failed to load folders: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        if (isActiveConnectionRequest(requestKey)) setLoadingFolders(false);
      }
    }
    fetchFolders();
  }, [connection.baseUrl, connection.apiKey, connectionKey, isActiveConnectionRequest]);

  async function handleFolderSelect(folder: OmniFolder) {
    const requestKey = connectionKey;
    setSelectedFolderId(folder.id);
    setLoadingDocs(true);
    setError('');
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folder.id, { allPages: true, pageSize: 100 });
      if (!isActiveConnectionRequest(requestKey)) return;
      if (res.error) {
        setError(`API error: ${res.error}`);
        return;
      }
      const docs: OmniDocument[] = Array.isArray(res.documents) ? res.documents : [];
      setDocuments(docs);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(`Failed to load documents: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingDocs(false);
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
    if (!search) return documents;
    const q = search.toLowerCase();
    return documents.filter((d) => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q));
  }, [documents, search]);

  function isSelected(doc: OmniDocument) {
    return selected.some((d) => d.id === doc.id);
  }

  function toggleDashboard(doc: OmniDocument) {
    if (isSelected(doc)) {
      setSelected((prev) => prev.filter((d) => d.id !== doc.id));
    } else {
      setSelected((prev) => [...prev, doc]);
    }
  }

  function toggleSelectAll() {
    const allInView = filteredDocs.every((d) => isSelected(d));
    if (allInView) {
      const viewIds = new Set(filteredDocs.map((d) => d.id));
      setSelected((prev) => prev.filter((d) => !viewIds.has(d.id)));
    } else {
      const existing = new Set(selected.map((d) => d.id));
      const newDocs = filteredDocs.filter((d) => !existing.has(d.id));
      setSelected((prev) => [...prev, ...newDocs]);
    }
  }

  async function handleCopy() {
    setShowConfirm(false);
    setCopying(true);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);

    const idsNeedingEnrichment = selected.filter((d) => !d.baseModelId).map((d) => d.id);
    const enrichedMap: Record<string, string | undefined> = {};
    if (idsNeedingEnrichment.length > 0) {
      setEnriching(true);
      try {
        const enrichments = await enrichDocuments(connection.baseUrl, connection.apiKey, idsNeedingEnrichment);
        for (const id of idsNeedingEnrichment) {
          const modelId = enrichments[id]?.baseModelId;
          if (modelId) enrichedMap[id] = modelId;
        }
      } catch {
        // best-effort; copy backend will fail gracefully if baseModelId is truly required
      } finally {
        setEnriching(false);
      }
    }

    try {
      await bulkCopyDocuments(
        {
          base_url: connection.baseUrl,
          api_key: connection.apiKey,
          document_ids: selected.map((d) => ({
            id: d.id,
            name: d.name,
            base_model_id: d.baseModelId || enrichedMap[d.id],
          })),
          target_folder_path: targetFolderPath,
          target_folder_id: targetFolderId || undefined,
          rename_suffix: renameSuffix || undefined,
          scope: deriveScopeFromFolderPath(targetFolderPath),
        },
        (event) => {
          const e = event as Record<string, unknown>;
          if (e.type === 'progress') {
            setCurrentIndex((e.index as number) + 1);
            setResults((prev) => {
              const newResults = [...prev];
              const idx = newResults.findIndex((r) => r.id === e.document_id);
              const entry: BulkOperationResult = {
                id: (e.document_id as string) || (e.id as string) || '',
                name: (e.document_name as string) || (e.name as string) || '',
                status: e.status as BulkOperationResult['status'],
                error: e.error as string | undefined,
                detail: e.detail as string | undefined,
              };
              if (idx >= 0) newResults[idx] = entry;
              else newResults.push(entry);
              return newResults;
            });
          }
          if (e.type === 'complete') {
            setSummary(e.summary as BulkOperationSummary);
            if (e.results) {
              setResults(
                (e.results as Array<Record<string, unknown>>).map((r) => ({
                  id: r.id as string,
                  name: r.name as string,
                  status: r.status as BulkOperationResult['status'],
                  error: r.error as string | undefined,
                  detail: r.detail as string | undefined,
                }))
              );
            }
          }
        }
      );
    } catch (err) {
      setSummary({
        succeeded: 0,
        failed: selected.length,
        skipped: 0,
        total: selected.length,
      });
      setError(err instanceof Error ? err.message : 'Copy operation failed');
    } finally {
      setCopying(false);
    }
  }

  function handleReset() {
    setSelected([]);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);
    setDocuments([]);
    setSelectedFolderId(null);
    setTargetFolderId('');
    setTargetFolderPath('');
    setTargetFolderDisplay('');
  }

  const allInViewSelected = filteredDocs.length > 0 && filteredDocs.every((d) => isSelected(d));
  const showResults = summary !== null;
  const canCopy = selected.length > 0 && targetFolderPath.trim().length > 0;

  if (showResults) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Bulk Copy Results"
          icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        />
        {summary && (
          <div className="card bg-surface-secondary">
            <div className="flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle size={18} className="text-success" />
                <span className="font-medium">{summary.succeeded} copied</span>
              </div>
              {summary.failed > 0 && (
                <div className="flex items-center gap-2">
                  <XCircle size={18} className="text-error" />
                  <span className="font-medium">{summary.failed} failed</span>
                </div>
              )}
              <div className="ml-auto text-xs text-content-secondary">
                Destination: <span className="font-mono font-medium text-content-primary">{targetFolderDisplay || targetFolderPath}</span>
              </div>
            </div>
          </div>
        )}

        <div className="card p-0 overflow-hidden">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            <div className="col-span-6 text-xs font-medium text-content-secondary uppercase tracking-wider">Dashboard</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Status</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Details</div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {results.map((r, index) => (
              <div key={r.id || `result-${index}`} className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center">
                <div className="col-span-6 text-sm text-content-primary truncate">{r.name}</div>
                <div className="col-span-3">
                  <StatusChip status={r.status} />
                </div>
                <div className="col-span-3 text-xs truncate">
                  {r.error
                    ? <span className="text-error">{r.error}</span>
                    : r.detail
                    ? <span className="text-success">{r.detail}</span>
                    : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        <button onClick={handleReset} className="btn-primary">
          Start New Operation
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bulk Copy Dashboards"
        description="Duplicate dashboards into another folder. The originals stay exactly where they are."
        icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={
          canCopy && (
            <button onClick={() => setShowConfirm(true)} disabled={copying} className="btn-primary">
              <Copy size={14} />
              Copy {selected.length} Dashboard{selected.length !== 1 ? 's' : ''}
            </button>
          )
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {copying && (
        <BulkOperationAnimation current={currentIndex} total={selected.length} type="copy" />
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search dashboards..." />

      <div className="flex flex-col md:flex-row gap-4 min-h-[360px]">
        <div className="md:w-64 flex-shrink-0 panel-left p-3 overflow-y-auto max-h-[420px]">
          <div className="text-[10px] font-bold text-content-tertiary uppercase tracking-widest px-2 mb-2">Source Folder</div>
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="text-omni-500 animate-spin" />
            </div>
          ) : folders.length === 0 ? (
            <p className="text-xs text-content-secondary px-2 py-4">No folders found.</p>
          ) : (
            folders.map((folder) => (
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

        <div className="flex-1 panel-right p-0">
          <div
            className="px-4 py-2.5 flex items-center justify-between"
            style={{ borderBottom: '1px solid rgba(242,206,220,0.7)', background: 'rgba(255,245,248,0.5)' }}
          >
            <div className="flex items-center gap-2">
              {filteredDocs.length > 0 && (
                <input
                  type="checkbox"
                  checked={allInViewSelected}
                  onChange={toggleSelectAll}
                  className="flex-shrink-0"
                />
              )}
              <span className="text-[10px] font-bold text-content-tertiary uppercase tracking-widest">Dashboards</span>
            </div>
            <span className="text-[10px] font-bold text-content-tertiary uppercase tracking-widest">Model</span>
          </div>

          <div className="overflow-y-auto max-h-[360px]">
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
                    src={selectedFolderId ? '/blobby-empty.png' : '/blobby-getting-started.png'}
                    alt={selectedFolderId ? 'No dashboards' : 'Select a folder'}
                    className="w-14 h-14 object-contain animate-float"
                    style={{ animationDuration: '3s' }}
                  />
                </div>
                <p className="text-sm font-medium text-content-secondary">
                  {selectedFolderId ? 'No dashboards in this folder.' : 'Select a folder to browse dashboards.'}
                </p>
                {!selectedFolderId && (
                  <p className="text-xs text-content-tertiary mt-1">Choose a source folder from the left panel</p>
                )}
              </div>
            ) : (
              filteredDocs.map((doc, index) => (
                <label
                  key={doc.id || `doc-${index}`}
                  className={`flex items-center px-4 py-2.5 border-b border-border/50 cursor-pointer transition-all ${
                    isSelected(doc) ? selectedRowClass : unselectedRowClass
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected(doc)}
                    onChange={() => toggleDashboard(doc)}
                    className="flex-shrink-0"
                  />
                  <div className="ml-3 flex-1 min-w-0">
                    <div className="text-sm text-content-primary truncate">{doc.name}</div>
                  </div>
                  {isSelected(doc) && (
                    <span className={selectedBadgeClass}>
                      <CheckCircle size={12} />
                      Selected
                    </span>
                  )}
                  <div className="ml-3 flex-shrink-0">
                    {!doc.baseModelId && enriching ? (
                      <Loader2 size={14} className="text-content-secondary animate-spin" />
                    ) : (
                      <span className="font-mono text-xs text-content-secondary" title={doc.baseModelId || ''}>
                        {doc.baseModelId ? (doc.baseModelId.length > 16 ? doc.baseModelId.slice(0, 16) + '...' : doc.baseModelId) : '-'}
                      </span>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-content-primary">Destination Folder</h3>
              <p className="text-xs text-content-secondary mt-0.5">
                Choose where to place copies of the {selected.length} selected dashboard{selected.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowFolderPicker(!showFolderPicker)}
              className="text-xs text-omni-600 hover:text-omni-700 font-medium transition-colors"
            >
              {showFolderPicker ? 'Type folder path' : 'Browse folders'}
            </button>
          </div>

          {showFolderPicker ? (
            <div className="border border-border rounded-card p-3 max-h-[200px] overflow-y-auto bg-surface-secondary">
              {folders.length === 0 ? (
                <p className="text-xs text-content-secondary py-2">No folders available.</p>
              ) : (
                <DestinationFolderPicker
                  folders={folders}
                  selectedId={targetFolderId}
                  onSelect={(folder) => {
                    setTargetFolderId(folder.id);
                    setTargetFolderPath(folder.identifier || folder.path || folder.name);
                    setTargetFolderDisplay(folder.name);
                  }}
                />
              )}
            </div>
          ) : (
            <input
              type="text"
              value={targetFolderPath}
              onChange={(e) => {
                setTargetFolderPath(e.target.value);
                setTargetFolderId('');
                setTargetFolderDisplay(e.target.value);
              }}
              placeholder="Paste a folder path (e.g. my-folder)"
              className="input w-full"
            />
          )}

          <div>
            <label className="text-xs font-medium text-content-secondary">Rename suffix (appended to each copy)</label>
            <input
              type="text"
              value={renameSuffix}
              onChange={(e) => setRenameSuffix(e.target.value)}
              placeholder=" (Copy)"
              className="input w-full mt-1"
            />
            <p className="text-[11px] text-content-tertiary mt-1">
              Leave blank to keep original names. Appended to each copied dashboard's title.
            </p>
          </div>

          {targetFolderPath && (
            <div className="flex items-center gap-2 text-xs text-content-secondary">
              <Copy size={13} className="text-omni-500" />
              Copying to: <span className="font-mono font-medium text-content-primary">{targetFolderDisplay || targetFolderPath}</span>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showConfirm}
        title="Confirm Bulk Copy"
        message={`You are about to duplicate ${selected.length} dashboard${selected.length !== 1 ? 's' : ''} into "${targetFolderDisplay || targetFolderPath}". Originals will stay in place.`}
        confirmLabel="Copy Dashboards"
        cancelLabel="Cancel"
        variant="primary"
        itemCount={selected.length}
        onConfirm={handleCopy}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
