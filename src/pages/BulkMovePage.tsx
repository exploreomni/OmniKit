import { useState, useEffect, useMemo } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  FolderInput,
  CheckCircle,
  XCircle,
  Bug,
  AlertTriangle,
} from 'lucide-react';
import { listFolders, listDocuments, bulkMoveDocuments } from '@/services/omniApi';
import { deriveScopeFromFolderPath } from '@/services/scope';
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
          onClick={() => {
            onSelect(folder);
            if (hasChildren) toggleExpanded(folder.id);
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

const STEP_LABELS: Record<string, string> = {
  move: 'Move In Place',
};

const STEP_ORDER = ['move'];

function getStepStatus(_key: string, data: Record<string, unknown>): 'ok' | 'failed' | 'skipped' | 'unknown' {
  if (data.skipped) return 'skipped';
  if (typeof data.ok === 'boolean') return data.ok ? 'ok' : 'failed';
  return 'unknown';
}

function getStepDetail(key: string, data: Record<string, unknown>): string {
  if (data.skipped && typeof data.reason === 'string') return data.reason;
  if (key === 'move') {
    const parts: string[] = [];
    if (typeof data.folder_path === 'string') parts.push(data.folder_path);
    if (typeof data.status === 'number') parts.push(`HTTP ${data.status}`);
    return parts.join(' · ');
  }
  return '';
}

function PipelineSteps({ steps }: { steps: Record<string, unknown> }) {
  const presentKeys = STEP_ORDER.filter((k) => k in steps);
  if (presentKeys.length === 0) return null;

  return (
    <div className="px-4 py-2.5 bg-gray-50 border-b border-border/50">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-2">
        Pipeline Steps
      </div>
      <div className="flex flex-col gap-1">
        {presentKeys.map((key) => {
          const data = steps[key] as Record<string, unknown>;
          const status = getStepStatus(key, data);
          const detail = getStepDetail(key, data);
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                className={`inline-flex items-center justify-center w-[72px] flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  status === 'ok'
                    ? 'bg-green-100 text-green-700'
                    : status === 'failed'
                    ? 'bg-red-100 text-red-700'
                    : status === 'skipped'
                    ? 'bg-gray-200 text-gray-500'
                    : 'bg-gray-100 text-gray-400'
                }`}
              >
                {status === 'ok' ? 'OK' : status === 'failed' ? 'FAILED' : status === 'skipped' ? 'SKIPPED' : '—'}
              </span>
              <span className="text-[11px] font-medium text-content-primary w-28 flex-shrink-0">
                {STEP_LABELS[key] ?? key}
              </span>
              {detail && (
                <span className="text-[11px] text-content-secondary font-mono truncate">{detail}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DebugRow({ result }: { result: BulkOperationResult }) {
  return (
    <div className="px-4 py-3 bg-gray-50 border-b border-border/50 space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-1">
            Request Payload
          </div>
          <pre className="text-[11px] font-mono text-content-primary bg-white border border-border rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {result.requestPayload
              ? JSON.stringify(result.requestPayload, null, 2)
              : 'N/A'}
          </pre>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-1">
            Response {result.responseStatus ? `(${result.responseStatus})` : ''}
          </div>
          <pre className="text-[11px] font-mono text-content-primary bg-white border border-border rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {result.responseBody != null
              ? JSON.stringify(result.responseBody, null, 2)
              : 'N/A'}
          </pre>
        </div>
      </div>
      {result.verificationBody != null && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-1">
            Verification (GET documents in target folder)
          </div>
          <pre className="text-[11px] font-mono text-content-primary bg-white border border-border rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {JSON.stringify(result.verificationBody, null, 2)}
          </pre>
        </div>
      )}
      {result.error && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-red-600 mb-1">
            Error
          </div>
          <p className="text-xs text-red-700 font-mono">{result.error}</p>
        </div>
      )}
    </div>
  );
}

export function BulkMovePage() {
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
  const [targetFolderId, setTargetFolderId] = useState('');
  const [targetFolderPath, setTargetFolderPath] = useState('');
  const [targetFolderDisplay, setTargetFolderDisplay] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [moving, setMoving] = useState(false);
  const [results, setResults] = useState<BulkOperationResult[]>([]);
  const [summary, setSummary] = useState<BulkOperationSummary | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [debugMode, setDebugMode] = useState(() => {
    try {
      return localStorage.getItem('omni_debug_mode') === '1';
    } catch {
      return false;
    }
  });
  const [expandedDebugIds, setExpandedDebugIds] = useState<Set<string>>(new Set());

  function toggleDebugMode() {
    setDebugMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('omni_debug_mode', next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }

  function toggleDebugRow(id: string) {
    setExpandedDebugIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  async function handleFolderSelect(folder: OmniFolder) {
    setSelectedFolderId(folder.id);
    setLoadingDocs(true);
    setError('');
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folder.id, { allPages: true, pageSize: 100 });
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

  async function handleMove() {
    setShowConfirm(false);
    setMoving(true);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);
    setExpandedDebugIds(new Set());

    try {
      await bulkMoveDocuments(
        {
          base_url: connection.baseUrl,
          api_key: connection.apiKey,
          document_ids: selected.map((d) => ({ id: d.id, name: d.name })),
          target_folder_path: targetFolderPath,
          target_folder_id: targetFolderId || undefined,
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
                id: (e.document_id as string) || '',
                name: (e.document_name as string) || '',
                status: e.status as BulkOperationResult['status'],
                error: e.error as string | undefined,
                detail: e.detail as string | undefined,
                requestPayload: e.request_payload as Record<string, unknown> | undefined,
                responseBody: e.response_body,
                responseStatus: e.response_status as number | undefined,
                verificationBody: e.verification_body,
                steps: e.steps as Record<string, unknown> | undefined,
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
                  requestPayload: r.request_payload as Record<string, unknown> | undefined,
                  responseBody: r.response_body,
                  responseStatus: r.response_status as number | undefined,
                  verificationBody: r.verification_body,
                  steps: r.steps as Record<string, unknown> | undefined,
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
      setError(err instanceof Error ? err.message : 'Move operation failed');
    } finally {
      setMoving(false);
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
    setExpandedDebugIds(new Set());
  }

  const allInViewSelected = filteredDocs.length > 0 && filteredDocs.every((d) => isSelected(d));
  const showResults = summary !== null;
  const canMove = selected.length > 0 && targetFolderPath.trim().length > 0;

  if (showResults) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Bulk Move Results"
          icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
          actions={
            debugMode && (
            <button
              onClick={toggleDebugMode}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-button border transition-colors ${
                debugMode
                  ? 'bg-amber-50 border-amber-300 text-amber-700'
                  : 'bg-surface-secondary border-border text-content-secondary hover:text-content-primary'
              }`}
            >
              <Bug size={13} />
              {debugMode ? 'Debug ON' : 'Debug'}
            </button>
            )
          }
        />

        {summary && (
          <div className="card bg-surface-secondary">
            <div className="flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle size={18} className="text-success" />
                <span className="font-medium">{summary.succeeded} moved</span>
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
            {debugMode && <div className="col-span-1" />}
            <div className={`${debugMode ? 'col-span-5' : 'col-span-6'} text-xs font-medium text-content-secondary uppercase tracking-wider`}>Dashboard</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Status</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Details</div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {results.map((r, index) => (
              <div key={r.id || `result-${index}`}>
                <div className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center">
                  {debugMode && (
                    <div className="col-span-1">
                      <button
                        onClick={() => toggleDebugRow(r.id)}
                        className="text-content-secondary hover:text-content-primary transition-colors"
                      >
                        {expandedDebugIds.has(r.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </div>
                  )}
                  <div className={`${debugMode ? 'col-span-5' : 'col-span-6'} text-sm text-content-primary truncate`}>{r.name}</div>
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
                {r.steps && <PipelineSteps steps={r.steps} />}
                {debugMode && expandedDebugIds.has(r.id) && <DebugRow result={r} />}
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
        title="Bulk Move Dashboards"
        description="Move dashboards to a different folder in place. Document IDs, permissions, favorites, and embed links are preserved."
        icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={
          <div className="flex items-center gap-2">
            {canMove && (
              <button onClick={() => setShowConfirm(true)} disabled={moving} className="btn-primary">
                <FolderInput size={14} />
                Move {selected.length} Dashboard{selected.length !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {moving && (
        <BulkOperationAnimation current={currentIndex} total={selected.length} type="move" />
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
                  className={`flex items-center px-4 py-2.5 border-b border-border/50 cursor-pointer hover:bg-surface-secondary transition-colors ${
                    isSelected(doc) ? 'bg-surface-secondary' : ''
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
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-content-primary">Destination Folder</h3>
              <p className="text-xs text-content-secondary mt-0.5">
                Choose where to move the {selected.length} selected dashboard{selected.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowFolderPicker(!showFolderPicker)}
              className="text-xs text-omni-600 hover:text-omni-700 font-medium transition-colors"
            >
              {showFolderPicker ? 'Type folder ID' : 'Browse folders'}
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

          {targetFolderPath && (
            <div className="flex items-center gap-2 text-xs text-content-secondary">
              <FolderInput size={13} className="text-omni-500" />
              Moving to: <span className="font-mono font-medium text-content-primary">{targetFolderDisplay || targetFolderPath}</span>
              {targetFolderDisplay && targetFolderDisplay !== targetFolderPath && (
                <span className="font-mono text-[10px] text-content-secondary/60">({targetFolderPath})</span>
              )}
            </div>
          )}
          {showFolderPicker && targetFolderId && targetFolderDisplay && targetFolderPath === targetFolderDisplay && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-card px-3 py-2">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              <span>This folder has no machine-readable path. The move will use the display name <span className="font-mono font-medium">"{targetFolderPath}"</span> as the target path, which may not match what Omni expects. If the move fails or the document lands in the wrong place, switch to manual entry and paste the exact folder path.</span>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showConfirm}
        title="Confirm Bulk Move"
        message={`You are about to move dashboards to "${targetFolderDisplay || targetFolderPath}". This operation cannot be undone.`}
        confirmLabel="Move Dashboards"
        cancelLabel="Cancel"
        variant="primary"
        itemCount={selected.length}
        onConfirm={handleMove}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
