import { useState, useEffect, useMemo } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  Trash2,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { listFolders, listDocuments, bulkDeleteDocuments } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { SkeletonRow } from '@/components/ui/SkeletonRow';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { BulkOperationAnimation } from '@/components/ui/BulkOperationAnimation';
import { StatusChip } from '@/components/ui/StatusChip';
import { Blobby } from '@/components/ui/Blobby';
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
        onClick={() => {
          onSelect(folder);
          if (hasChildren) onToggle(folder.id);
        }}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-button transition-colors ${
          isSelected ? 'bg-omni-100 text-omni-700 font-medium' : 'text-content-primary hover:bg-surface-secondary'
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

export function BulkDeletePage() {
  const { connection } = useConnection();
  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [documents, setDocuments] = useState<OmniDocument[]>([]);
  const [selected, setSelected] = useState<OmniDocument[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [error, setError] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [results, setResults] = useState<BulkOperationResult[]>([]);
  const [summary, setSummary] = useState<BulkOperationSummary | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    async function fetchFolders() {
      setLoadingFolders(true);
      setError('');
      try {
        const res = await listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        if (res.error) {
          setError(`API error: ${res.error}`);
          return;
        }
        setFolders(Array.isArray(res.folders) ? res.folders : []);
      } catch (err) {
        setError(`Failed to load folders: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        setLoadingFolders(false);
      }
    }
    fetchFolders();
  }, [connection.baseUrl, connection.apiKey]);

  async function loadDocumentsForFolder(folderId: string) {
    setLoadingDocs(true);
    setError('');
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folderId, { allPages: true, pageSize: 100 });
      if (res.error) {
        setError(`API error: ${res.error}`);
        return;
      }
      const docs: OmniDocument[] = Array.isArray(res.documents) ? res.documents : [];
      setDocuments(docs);
    } catch (err) {
      setError(`Failed to load documents: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoadingDocs(false);
    }
  }

  async function handleFolderSelect(folder: OmniFolder) {
    setSelectedFolderId(folder.id);
    await loadDocumentsForFolder(folder.id);
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

  async function handleDelete() {
    setShowConfirm(false);
    setDeleting(true);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);

    try {
      await bulkDeleteDocuments(
        {
          base_url: connection.baseUrl,
          api_key: connection.apiKey,
          document_ids: selected.map((d) => ({ id: d.id, name: d.name })),
        },
        (event) => {
          const e = event as Record<string, unknown>;
          if (e.type === 'progress') {
            setCurrentIndex((e.index as number) + 1);
            setResults((prev) => {
              const newResults = [...prev];
              const idx = newResults.findIndex((r) => r.id === e.document_id);
              const entry: BulkOperationResult = {
                id: (e.document_id as string) || '',
                name: (e.document_name as string) || '',
                status: e.status as BulkOperationResult['status'],
                error: e.error as string | undefined,
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
                }))
              );
            }
            if (selectedFolderId) {
              loadDocumentsForFolder(selectedFolderId);
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
      setError(err instanceof Error ? err.message : 'Delete operation failed');
    } finally {
      setDeleting(false);
    }
  }

  function handleReset() {
    setSelected([]);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);
  }

  const allInViewSelected = filteredDocs.length > 0 && filteredDocs.every((d) => isSelected(d));
  const showResults = summary !== null;

  if (showResults) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Bulk Delete Results"
          icon={<Blobby mood="warning" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        />

        {summary && (
          <div className="card bg-surface-secondary">
            <div className="flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle size={18} className="text-success" />
                <span className="font-medium">{summary.succeeded} deleted</span>
              </div>
              {summary.failed > 0 && (
                <div className="flex items-center gap-2">
                  <XCircle size={18} className="text-error" />
                  <span className="font-medium">{summary.failed} failed</span>
                </div>
              )}
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
                <div className="col-span-3 text-xs text-error truncate">{r.error || ''}</div>
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
        title="Bulk Delete Dashboards"
        description="Select dashboards to permanently delete from your Omni instance."
        icon={<Blobby mood="warning" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={
          <button
            onClick={() => setShowConfirm(true)}
            disabled={deleting || selected.length === 0}
            className="btn-danger disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={14} />
            {selected.length > 0
              ? `Delete ${selected.length} Dashboard${selected.length !== 1 ? 's' : ''}`
              : 'Delete Dashboards'}
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {deleting && (
        <BulkOperationAnimation current={currentIndex} total={selected.length} type="delete" />
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search dashboards..." />

      <div className="flex flex-col md:flex-row gap-4 min-h-[360px]">
        <div className="md:w-64 flex-shrink-0 panel-left p-3 overflow-y-auto max-h-[420px]">
          <div className="text-[10px] font-bold text-content-tertiary uppercase tracking-widest px-2 mb-2">Folders</div>
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
                  <p className="text-xs text-content-tertiary mt-1">Choose a folder from the left panel</p>
                )}
              </div>
            ) : (
              filteredDocs.map((doc, index) => (
                <label
                  key={doc.id || `doc-${index}`}
                  className={`flex items-center px-4 py-2.5 border-b border-border/50 cursor-pointer hover:bg-surface-secondary transition-colors ${
                    isSelected(doc) ? 'bg-red-50/30' : ''
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
                  <div className="ml-3 flex-shrink-0">
                    <span className="font-mono text-xs text-content-secondary" title={doc.baseModelId || ''}>
                      {doc.baseModelId ? (doc.baseModelId.length > 16 ? doc.baseModelId.slice(0, 16) + '...' : doc.baseModelId) : '-'}
                    </span>
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-card">
          <AlertTriangle size={14} className="text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-800 leading-relaxed">
            Deleting dashboards is permanent and cannot be undone. Make sure you have backups if needed.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={showConfirm}
        title="Confirm Bulk Delete"
        message="You are about to permanently delete dashboards. This action cannot be undone."
        confirmLabel="Delete Permanently"
        cancelLabel="Cancel"
        variant="danger"
        itemCount={selected.length}
        requireTypedConfirmation={selected.length >= 5}
        onConfirm={handleDelete}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
