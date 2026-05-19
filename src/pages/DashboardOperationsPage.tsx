import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bug,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderOpen,
  Loader2,
  RefreshCcw,
  Trash2,
} from 'lucide-react';
import {
  bulkCopyDocuments,
  bulkDeleteDocuments,
  bulkMoveDocuments,
  enrichDocuments,
  listDocuments,
  listFolders,
} from '@/services/omniApi';
import { deriveScopeFromFolderPath } from '@/services/scope';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { SkeletonRow } from '@/components/ui/SkeletonRow';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { BulkOperationAnimation } from '@/components/ui/BulkOperationAnimation';
import { StatusChip } from '@/components/ui/StatusChip';
import { Blobby } from '@/components/ui/Blobby';
import type { BulkOperationResult, BulkOperationSummary, OmniDocument, OmniFolder } from '@/types';

type DashboardAction = 'move' | 'copy' | 'delete';

const ACTIONS: Record<
  DashboardAction,
  {
    label: string;
    shortLabel: string;
    description: string;
    icon: typeof FolderInput;
    tone: string;
    resultVerb: string;
    confirmTitle: string;
    confirmLabel: string;
    safetyCopy: string;
  }
> = {
  move: {
    label: 'Move dashboards',
    shortLabel: 'Move',
    description: 'Move dashboards to another folder while preserving IDs, permissions, favorites, and embed links.',
    icon: FolderInput,
    tone: 'text-content-primary bg-white border-border-strong',
    resultVerb: 'moved',
    confirmTitle: 'Confirm Dashboard Move',
    confirmLabel: 'Move Dashboards',
    safetyCopy: 'Dashboards will be moved in place. This changes their folder location but keeps the original documents.',
  },
  copy: {
    label: 'Copy dashboards',
    shortLabel: 'Copy',
    description: 'Duplicate dashboards into another folder while leaving the originals untouched.',
    icon: Copy,
    tone: 'text-emerald-700 bg-white border-emerald-300',
    resultVerb: 'copied',
    confirmTitle: 'Confirm Dashboard Copy',
    confirmLabel: 'Copy Dashboards',
    safetyCopy: 'Copies will be created in the destination folder. Originals will stay exactly where they are.',
  },
  delete: {
    label: 'Delete dashboards',
    shortLabel: 'Delete',
    description: 'Permanently delete selected dashboards. Use this only with disposable or approved content.',
    icon: Trash2,
    tone: 'text-red-700 bg-white border-red-300',
    resultVerb: 'deleted',
    confirmTitle: 'Confirm Dashboard Delete',
    confirmLabel: 'Delete Permanently',
    safetyCopy: 'Deleting dashboards is permanent and cannot be undone. Confirm you have backups if needed.',
  },
};

const STEP_LABELS: Record<string, string> = {
  move: 'Move In Place',
};

const STEP_ORDER = ['move'];

function getFolderPath(folder: OmniFolder): string {
  return folder.identifier || folder.path || folder.name;
}

function findFolderName(folders: OmniFolder[], id: string | null): string {
  if (!id) return '';
  for (const folder of folders) {
    if (folder.id === id) return folder.name;
    const childMatch = findFolderName(folder.children || [], id);
    if (childMatch) return childMatch;
  }
  return '';
}

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
          className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-button transition-colors ${
          isSelected ? 'bg-surface-tertiary text-content-primary font-medium' : 'text-content-primary hover:bg-surface-secondary'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : (
          <span className="w-3.5" />
        )}
        {isExpanded ? (
          <FolderOpen size={15} className="text-content-secondary flex-shrink-0" />
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
          type="button"
          onClick={() => {
            onSelect(folder);
            if (hasChildren) toggleExpanded(folder.id);
          }}
            className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-button transition-colors ${
            isSelected ? 'bg-surface-tertiary text-content-primary font-medium' : 'text-content-primary hover:bg-surface-secondary'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {hasChildren ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span className="w-3.5" />
          )}
          {isExpanded ? (
            <FolderOpen size={15} className="text-content-secondary flex-shrink-0" />
          ) : (
            <Folder size={15} className="text-content-secondary flex-shrink-0" />
          )}
          <span className="truncate">{folder.name}</span>
        </button>
        {isExpanded && folder.children?.map((child) => <PickerNode key={child.id} folder={child} depth={depth + 1} />)}
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

function PipelineSteps({ steps }: { steps: Record<string, unknown> }) {
  const presentKeys = STEP_ORDER.filter((key) => key in steps);
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
                {status === 'ok' ? 'OK' : status === 'failed' ? 'FAILED' : status === 'skipped' ? 'SKIPPED' : '-'}
              </span>
              <span className="text-[11px] font-medium text-content-primary w-28 flex-shrink-0">
                {STEP_LABELS[key] ?? key}
              </span>
              {detail && <span className="text-[11px] text-content-secondary font-mono truncate">{detail}</span>}
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
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-1">
            Request Payload
          </div>
          <pre className="text-[11px] font-mono text-content-primary bg-white border border-border rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {result.requestPayload ? JSON.stringify(result.requestPayload, null, 2) : 'N/A'}
          </pre>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-1">
            Response {result.responseStatus ? `(${result.responseStatus})` : ''}
          </div>
          <pre className="text-[11px] font-mono text-content-primary bg-white border border-border rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {result.responseBody != null ? JSON.stringify(result.responseBody, null, 2) : 'N/A'}
          </pre>
        </div>
      </div>
      {result.verificationBody != null && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary mb-1">
            Verification
          </div>
          <pre className="text-[11px] font-mono text-content-primary bg-white border border-border rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
            {JSON.stringify(result.verificationBody, null, 2)}
          </pre>
        </div>
      )}
      {result.error && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-red-600 mb-1">Error</div>
          <p className="text-xs text-red-700 font-mono">{result.error}</p>
        </div>
      )}
    </div>
  );
}

export function DashboardOperationsPage() {
  const { connection } = useConnection();
  const [action, setAction] = useState<DashboardAction>('move');
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
  const [running, setRunning] = useState(false);
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

  const actionConfig = ACTIONS[action];
  const needsDestination = action === 'move' || action === 'copy';
  const canRun = selected.length > 0 && (!needsDestination || targetFolderPath.trim().length > 0);

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

  function toggleDebugMode() {
    setDebugMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('omni_debug_mode', next ? '1' : '0');
      } catch {
        // ignore localStorage failures
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

  function chooseAction(nextAction: DashboardAction) {
    setAction(nextAction);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);
    setShowConfirm(false);
    setExpandedDebugIds(new Set());
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
    setShowFolderPicker(false);
    setExpandedDebugIds(new Set());
  }

  function applyProgressEvent(event: Record<string, unknown>) {
    if (event.type === 'progress') {
      setCurrentIndex((event.index as number) + 1);
      setResults((prev) => {
        const next = [...prev];
        const id = (event.document_id as string) || (event.id as string) || '';
        const existingIndex = next.findIndex((result) => result.id === id);
        const entry: BulkOperationResult = {
          id,
          name: (event.document_name as string) || (event.name as string) || '',
          status: event.status as BulkOperationResult['status'],
          error: event.error as string | undefined,
          detail: event.detail as string | undefined,
          requestPayload: event.request_payload as Record<string, unknown> | undefined,
          responseBody: event.response_body,
          responseStatus: event.response_status as number | undefined,
          verificationBody: event.verification_body,
          steps: event.steps as Record<string, unknown> | undefined,
        };
        if (existingIndex >= 0) next[existingIndex] = entry;
        else next.push(entry);
        return next;
      });
    }

    if (event.type === 'complete') {
      setSummary(event.summary as BulkOperationSummary);
      if (event.results) {
        setResults(
          (event.results as Array<Record<string, unknown>>).map((result) => ({
            id: result.id as string,
            name: result.name as string,
            status: result.status as BulkOperationResult['status'],
            error: result.error as string | undefined,
            detail: result.detail as string | undefined,
            requestPayload: result.request_payload as Record<string, unknown> | undefined,
            responseBody: result.response_body,
            responseStatus: result.response_status as number | undefined,
            verificationBody: result.verification_body,
            steps: result.steps as Record<string, unknown> | undefined,
          }))
        );
      }
      if (action === 'delete' && selectedFolderId) {
        loadDocumentsForFolder(selectedFolderId);
      }
    }
  }

  async function runOperation() {
    setShowConfirm(false);
    setRunning(true);
    setResults([]);
    setSummary(null);
    setCurrentIndex(0);
    setExpandedDebugIds(new Set());

    try {
      if (action === 'copy') {
        const idsNeedingEnrichment = selected.filter((doc) => !doc.baseModelId).map((doc) => doc.id);
        const enrichedMap: Record<string, string | undefined> = {};
        if (idsNeedingEnrichment.length > 0) {
          setEnriching(true);
          try {
            const enrichments = await enrichDocuments(connection.baseUrl, connection.apiKey, idsNeedingEnrichment);
            for (const id of idsNeedingEnrichment) {
              const modelId = enrichments[id]?.baseModelId;
              if (modelId) enrichedMap[id] = modelId;
            }
          } finally {
            setEnriching(false);
          }
        }

        await bulkCopyDocuments(
          {
            base_url: connection.baseUrl,
            api_key: connection.apiKey,
            document_ids: selected.map((doc) => ({
              id: doc.id,
              name: doc.name,
              base_model_id: doc.baseModelId || enrichedMap[doc.id],
            })),
            target_folder_path: targetFolderPath,
            target_folder_id: targetFolderId || undefined,
            rename_suffix: renameSuffix || undefined,
            scope: deriveScopeFromFolderPath(targetFolderPath),
          },
          applyProgressEvent
        );
      } else if (action === 'move') {
        await bulkMoveDocuments(
          {
            base_url: connection.baseUrl,
            api_key: connection.apiKey,
            document_ids: selected.map((doc) => ({ id: doc.id, name: doc.name })),
            target_folder_path: targetFolderPath,
            target_folder_id: targetFolderId || undefined,
            scope: deriveScopeFromFolderPath(targetFolderPath),
          },
          applyProgressEvent
        );
      } else {
        await bulkDeleteDocuments(
          {
            base_url: connection.baseUrl,
            api_key: connection.apiKey,
            document_ids: selected.map((doc) => ({ id: doc.id, name: doc.name })),
          },
          applyProgressEvent
        );
      }
    } catch (err) {
      setSummary({
        succeeded: 0,
        failed: selected.length,
        skipped: 0,
        total: selected.length,
      });
      setError(err instanceof Error ? err.message : `${actionConfig.shortLabel} operation failed`);
    } finally {
      setRunning(false);
      setEnriching(false);
    }
  }

  const allInViewSelected = filteredDocs.length > 0 && filteredDocs.every((doc) => isSelected(doc));
  const showResults = summary !== null;
  const selectedFolderName = findFolderName(folders, selectedFolderId);
  const ActionIcon = actionConfig.icon;
  const confirmMessage =
    action === 'delete'
      ? `You are about to permanently delete ${selected.length} dashboard${selected.length !== 1 ? 's' : ''}. This action cannot be undone.`
      : `You are about to ${action} ${selected.length} dashboard${selected.length !== 1 ? 's' : ''} to "${targetFolderDisplay || targetFolderPath}".`;

  if (showResults) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Dashboard Operation Results"
          description={`${ACTIONS[action].shortLabel} completed for ${summary?.total ?? selected.length} selected dashboard${(summary?.total ?? selected.length) === 1 ? '' : 's'}.`}
          icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
          actions={
            debugMode && action === 'move' && (
              <button
                type="button"
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
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle size={18} className="text-success" />
                <span className="font-medium">{summary.succeeded} {actionConfig.resultVerb}</span>
              </div>
              {summary.failed > 0 && (
                <div className="flex items-center gap-2">
                  <AlertTriangle size={18} className="text-error" />
                  <span className="font-medium">{summary.failed} failed</span>
                </div>
              )}
              {needsDestination && (
                <div className="ml-auto text-xs text-content-secondary">
                  Destination:{' '}
                  <span className="font-mono font-medium text-content-primary">
                    {targetFolderDisplay || targetFolderPath}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card p-0 overflow-hidden">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            {debugMode && action === 'move' && <div className="col-span-1" />}
            <div className={`${debugMode && action === 'move' ? 'col-span-5' : 'col-span-6'} text-xs font-medium text-content-secondary uppercase tracking-wider`}>
              Dashboard
            </div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Status</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Details</div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {results.map((result, index) => (
              <div key={result.id || `result-${index}`}>
                <div className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center">
                  {debugMode && action === 'move' && (
                    <div className="col-span-1">
                      <button
                        type="button"
                        onClick={() => toggleDebugRow(result.id)}
                        className="text-content-secondary hover:text-content-primary transition-colors"
                      >
                        {expandedDebugIds.has(result.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </div>
                  )}
                  <div className={`${debugMode && action === 'move' ? 'col-span-5' : 'col-span-6'} text-sm text-content-primary truncate`}>
                    {result.name}
                  </div>
                  <div className="col-span-3">
                    <StatusChip status={result.status} />
                  </div>
                  <div className="col-span-3 text-xs truncate">
                    {result.error ? (
                      <span className="text-error">{result.error}</span>
                    ) : result.detail ? (
                      <span className="text-success">{result.detail}</span>
                    ) : null}
                  </div>
                </div>
                {action === 'move' && result.steps && <PipelineSteps steps={result.steps} />}
                {debugMode && action === 'move' && expandedDebugIds.has(result.id) && <DebugRow result={result} />}
              </div>
            ))}
          </div>
        </div>

        <button type="button" onClick={handleReset} className="btn-primary">
          Start New Operation
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard Operations"
        description="Select dashboards once, then choose whether to move, copy, or delete them with a clear review step before anything changes."
        icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={!canRun || running}
            className={`${action === 'delete' ? 'btn-danger' : 'btn-primary'} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {action === 'delete' ? <Trash2 size={14} /> : action === 'copy' ? <Copy size={14} /> : <FolderInput size={14} />}
            {canRun
              ? `${actionConfig.shortLabel} ${selected.length} Dashboard${selected.length !== 1 ? 's' : ''}`
              : actionConfig.shortLabel}
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {running && (
        <BulkOperationAnimation current={currentIndex} total={selected.length} type={action} />
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        {(Object.keys(ACTIONS) as DashboardAction[]).map((option) => {
          const config = ACTIONS[option];
          const Icon = config.icon;
          const active = option === action;
          return (
            <button
              key={option}
              type="button"
              onClick={() => chooseAction(option)}
              className={`text-left rounded-card border p-4 transition-all ${
                active
                  ? config.tone
                  : 'bg-white border-border text-content-primary hover:border-border-strong hover:bg-surface-secondary'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-secondary">
                  <Icon size={16} />
                </span>
                <span className="text-sm font-semibold">{config.label}</span>
              </div>
              <p className="text-xs leading-relaxed mt-2 text-content-secondary">{config.description}</p>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="panel-left p-3 overflow-y-auto max-h-[520px]">
          <div className="flex items-center justify-between px-2 mb-2">
            <div className="text-[10px] font-bold text-content-tertiary uppercase tracking-widest">Source Folder</div>
            {selectedFolderName && (
              <span className="text-[10px] text-content-tertiary truncate max-w-[130px]" title={selectedFolderName}>
                {selectedFolderName}
              </span>
            )}
          </div>
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="text-content-secondary animate-spin" />
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

        <div className="panel-right p-0 overflow-hidden">
          <div
            className="px-4 py-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
              style={{ borderBottom: '1px solid rgba(217,222,232,0.95)', background: '#F8F9FD' }}
          >
            <div className="flex items-center gap-2">
              {filteredDocs.length > 0 && (
                <input type="checkbox" checked={allInViewSelected} onChange={toggleSelectAll} className="flex-shrink-0" />
              )}
              <span className="text-[10px] font-bold text-content-tertiary uppercase tracking-widest">
                Dashboards
              </span>
              {selected.length > 0 && (
                <span className="text-[11px] font-semibold text-content-secondary bg-white border border-border rounded-full px-2 py-0.5">
                  {selected.length} selected
                </span>
              )}
            </div>
            <div className="lg:w-80">
              <SearchInput value={search} onChange={setSearch} placeholder="Search dashboards..." />
            </div>
          </div>

          <div className="overflow-y-auto max-h-[460px]">
            {loadingDocs ? (
              <div className="p-2 space-y-1">
                {Array.from({ length: 6 }).map((_, index) => (
                  <SkeletonRow key={index} columns={3} index={index} />
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
                    isSelected(doc) ? (action === 'delete' ? 'bg-red-50' : 'bg-surface-secondary') : ''
                  }`}
                >
                  <input type="checkbox" checked={isSelected(doc)} onChange={() => toggleDashboard(doc)} className="flex-shrink-0" />
                  <div className="ml-3 flex-1 min-w-0">
                    <div className="text-sm text-content-primary truncate">{doc.name}</div>
                    <div className="text-[11px] text-content-tertiary truncate">{doc.identifier || doc.id}</div>
                  </div>
                  <div className="ml-3 flex-shrink-0">
                    {!doc.baseModelId && enriching ? (
                      <Loader2 size={14} className="text-content-secondary animate-spin" />
                    ) : (
                      <span className="font-mono text-xs text-content-secondary" title={doc.baseModelId || ''}>
                        {doc.baseModelId ? (doc.baseModelId.length > 16 ? `${doc.baseModelId.slice(0, 16)}...` : doc.baseModelId) : '-'}
                      </span>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-content-primary">Operation Settings</h3>
              <p className="text-xs text-content-secondary mt-0.5">{actionConfig.description}</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold border rounded-full px-2.5 py-1 ${actionConfig.tone}`}>
              <ActionIcon size={13} />
              {actionConfig.shortLabel}
            </span>
          </div>

          {needsDestination ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-content-primary">Destination Folder</h4>
                  <p className="text-xs text-content-secondary mt-0.5">
                    Choose where to {action} the selected dashboard{selected.length === 1 ? '' : 's'}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFolderPicker(!showFolderPicker)}
                  className="text-xs text-content-secondary hover:text-content-primary font-medium transition-colors"
                >
                  {showFolderPicker ? 'Type folder path' : 'Browse folders'}
                </button>
              </div>

              {showFolderPicker ? (
                <div className="border border-border rounded-card p-3 max-h-[220px] overflow-y-auto bg-surface-secondary">
                  {folders.length === 0 ? (
                    <p className="text-xs text-content-secondary py-2">No folders available.</p>
                  ) : (
                    <DestinationFolderPicker
                      folders={folders}
                      selectedId={targetFolderId}
                      onSelect={(folder) => {
                        setTargetFolderId(folder.id);
                        setTargetFolderPath(getFolderPath(folder));
                        setTargetFolderDisplay(folder.name);
                      }}
                    />
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={targetFolderPath}
                  onChange={(event) => {
                    setTargetFolderPath(event.target.value);
                    setTargetFolderId('');
                    setTargetFolderDisplay(event.target.value);
                  }}
                  placeholder="Paste a folder path (e.g. team-dashboards)"
                  className="input w-full"
                />
              )}

              {action === 'copy' && (
                <div>
                  <label className="text-xs font-medium text-content-secondary">Rename suffix</label>
                  <input
                    type="text"
                    value={renameSuffix}
                    onChange={(event) => setRenameSuffix(event.target.value)}
                    placeholder=" (Copy)"
                    className="input w-full mt-1"
                  />
                  <p className="text-[11px] text-content-tertiary mt-1">
                    Leave blank to keep original dashboard names.
                  </p>
                </div>
              )}

              {targetFolderPath && (
                <div className="flex items-center gap-2 text-xs text-content-secondary">
                  {action === 'copy' ? <Copy size={13} className="text-content-secondary" /> : <FolderInput size={13} className="text-content-secondary" />}
                  {action === 'copy' ? 'Copying to:' : 'Moving to:'}{' '}
                  <span className="font-mono font-medium text-content-primary">{targetFolderDisplay || targetFolderPath}</span>
                  {targetFolderDisplay && targetFolderDisplay !== targetFolderPath && (
                    <span className="font-mono text-[10px] text-content-secondary/60">({targetFolderPath})</span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-card">
              <AlertTriangle size={14} className="text-red-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-800 leading-relaxed">{actionConfig.safetyCopy}</p>
            </div>
          )}
        </div>

        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-content-primary">Review</h3>
            <button type="button" onClick={handleReset} className="text-xs text-content-secondary hover:text-content-primary inline-flex items-center gap-1">
              <RefreshCcw size={12} />
              Reset
            </button>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-content-secondary">Action</span>
              <span className="font-semibold text-content-primary">{actionConfig.shortLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-content-secondary">Selected</span>
              <span className="font-semibold text-content-primary">{selected.length}</span>
            </div>
            {needsDestination && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-content-secondary">Destination</span>
                <span className="font-mono font-semibold text-content-primary truncate">
                  {targetFolderDisplay || targetFolderPath || 'Not selected'}
                </span>
              </div>
            )}
          </div>
          <div className={`rounded-card border px-3 py-2 text-xs leading-relaxed ${action === 'delete' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-surface-secondary border-border text-content-secondary'}`}>
            {actionConfig.safetyCopy}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showConfirm}
        title={actionConfig.confirmTitle}
        message={confirmMessage}
        confirmLabel={actionConfig.confirmLabel}
        cancelLabel="Cancel"
        variant={action === 'delete' ? 'danger' : 'primary'}
        itemCount={selected.length}
        requireTypedConfirmation={action === 'delete' && selected.length >= 5}
        onConfirm={runOperation}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
