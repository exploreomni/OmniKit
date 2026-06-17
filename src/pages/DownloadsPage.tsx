import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Download,
  FileSpreadsheet,
  FileText,
  Folder,
  Image,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import {
  fetchDashboardDownloadFile,
  getDashboardDownloadDetails,
  getDashboardDownloadJobStatus,
  listInstanceDocuments,
  listInstanceFolders,
  startDashboardDownloadJob,
  type InstanceDocument,
  type InstanceFolder,
} from '@/services/opsConsole';
import {
  availableDashboardDownloadFormats,
  buildDashboardDownloadRequest,
  dashboardDownloadStatusVariant,
  DASHBOARD_DOWNLOAD_MIME_TYPES,
  formatDashboardDownloadLabel,
  summarizeDashboardDownloadFilters,
  type DashboardDownloadDetails,
  type DashboardDownloadFilterState,
  type DashboardDownloadFormat,
  type DashboardDownloadOptions,
  type DashboardDownloadQueueItem,
  type DashboardDownloadScope,
  type RecentDashboardDownload,
} from '@/services/dashboardDownloads';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadAnimation } from '@/components/ui/DownloadAnimation';
import { Blobby } from '@/components/ui/Blobby';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { selectedBadgeClass, selectedCardClass, selectedRowClass, unselectedCardClass, unselectedRowClass } from '@/components/ui/selectionStyles';

type DetailState = {
  loading: boolean;
  details?: DashboardDownloadDetails;
  error?: string;
};

interface FormatOption {
  value: DashboardDownloadFormat;
  label: string;
  description: string;
  icon: typeof FileText;
  color: string;
}

type FlatFolder = InstanceFolder & { depth: number };

const RECENT_DOWNLOADS_KEY = 'omnikit:dashboardDownloads:recent:v1';

const BASE_FORMAT_OPTIONS: FormatOption[] = [
  { value: 'pdf', label: 'PDF', description: 'Single PDF file', icon: FileText, color: 'text-red-600 bg-red-50' },
  { value: 'png', label: 'PNG', description: 'Image snapshot', icon: Image, color: 'text-blue-600 bg-blue-50' },
  { value: 'csv', label: 'CSV (ZIP)', description: 'One CSV per tile', icon: FileSpreadsheet, color: 'text-green-600 bg-green-50' },
  { value: 'xlsx', label: 'XLSX', description: 'Excel workbook', icon: FileSpreadsheet, color: 'text-emerald-600 bg-emerald-50' },
  { value: 'json', label: 'JSON', description: 'Single tile data', icon: FileText, color: 'text-violet-700 bg-violet-50' },
];

const PAPER_FORMATS = [
  { value: 'fit_page', label: 'Fit Page' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
  { value: 'tabloid', label: 'Tabloid' },
  { value: 'a3', label: 'A3' },
  { value: 'a4', label: 'A4' },
];

function flattenFolders(folders: InstanceFolder[], depth = 0): FlatFolder[] {
  const result: FlatFolder[] = [];
  for (const folder of folders) {
    result.push({ ...folder, depth });
    if (folder.children) result.push(...flattenFolders(folder.children, depth + 1));
  }
  return result;
}

function folderPath(folder: InstanceFolder): string {
  return folder.path || folder.identifier || folder.name;
}

function readRecentDownloads(): RecentDashboardDownload[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(RECENT_DOWNLOADS_KEY) || '[]') as RecentDashboardDownload[];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.dashboardId === 'string' && typeof item.filename === 'string').slice(0, 8)
          .map((item) => ({
            ...item,
            filterSummary: item.filterSummary || summarizeDashboardDownloadFilters(item.request),
          }))
      : [];
  } catch {
    return [];
  }
}

function writeRecentDownloads(downloads: RecentDashboardDownload[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(RECENT_DOWNLOADS_KEY, JSON.stringify(downloads.slice(0, 8)));
  } catch {
    // Recent downloads are convenience state only.
  }
}

function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function hasConfiguredFilters(values: DashboardDownloadFilterState | undefined): boolean {
  return Boolean(values && Object.values(values).some((value) => value.trim()));
}

function savedInstanceRequired() {
  return (
    <div className="flex min-h-[520px] items-center justify-center">
      <div className="card max-w-[448px] space-y-5 text-center">
        <img src="/blobby-construction.png" alt="Blobby ready to help" className="mx-auto h-20 w-20 object-contain animate-float" style={{ animationDuration: '3s' }} />
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-omni-200 bg-omni-50 px-3 py-1 text-xs font-semibold text-omni-700">
          <ShieldCheck size={13} />
          Saved instance required
        </div>
        <div>
          <h2 className="text-xl font-semibold text-content-primary">Choose an instance to unlock Dashboard Downloads</h2>
          <p className="mt-3 text-sm text-content-secondary">
            Dashboard Downloads now runs through the local native vault. Unlock Home, then choose the saved Omni instance this workflow should use.
          </p>
        </div>
        <div className="grid gap-2 text-left text-xs text-content-secondary">
          <div className="rounded-card border border-border px-3 py-2">Plaintext keys stay in the local vault</div>
          <div className="rounded-card border border-border px-3 py-2">Per-dashboard filters are staged before each export</div>
          <div className="rounded-card border border-border px-3 py-2">Downloads run sequentially to avoid Omni job conflicts</div>
        </div>
        <Link to="/" className="btn-primary w-full justify-center text-sm">Go to Home</Link>
      </div>
    </div>
  );
}

export function DownloadsPage() {
  const { connection } = useConnection();
  const logOp = useLogOperation();
  const instanceId = connection.connectionMode === 'vault' ? connection.instanceId || '' : '';
  const requestKeyRef = useRef(instanceId);

  const [folders, setFolders] = useState<InstanceFolder[]>([]);
  const [documents, setDocuments] = useState<InstanceDocument[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedFolderLabel, setSelectedFolderLabel] = useState('');
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [activeDocId, setActiveDocId] = useState('');
  const [folderSearch, setFolderSearch] = useState('');
  const [dashboardSearch, setDashboardSearch] = useState('');
  const [detailsByDashboard, setDetailsByDashboard] = useState<Record<string, DetailState>>({});
  const detailsRef = useRef(detailsByDashboard);

  const [format, setFormat] = useState<DashboardDownloadFormat>('pdf');
  const [scope, setScope] = useState<DashboardDownloadScope>('dashboard');
  const [selectedTileKey, setSelectedTileKey] = useState('');
  const [filterValuesByDashboard, setFilterValuesByDashboard] = useState<Record<string, DashboardDownloadFilterState>>({});

  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [queue, setQueue] = useState<DashboardDownloadQueueItem[]>([]);
  const [recentDownloads, setRecentDownloads] = useState<RecentDashboardDownload[]>(() => readRecentDownloads());
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [paperFormat, setPaperFormat] = useState('fit_page');
  const [orientation, setOrientation] = useState('landscape');
  const [hideTitle, setHideTitle] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const [expandTables, setExpandTables] = useState(false);
  const [singleColumnLayout, setSingleColumnLayout] = useState(false);
  const [enableFormatting, setEnableFormatting] = useState(true);
  const [hideHiddenFields, setHideHiddenFields] = useState(false);
  const [overrideRowLimit, setOverrideRowLimit] = useState(false);
  const [maxRowLimit, setMaxRowLimit] = useState('');
  const [customFilename, setCustomFilename] = useState('');

  useEffect(() => {
    requestKeyRef.current = instanceId;
  }, [instanceId]);

  useEffect(() => {
    detailsRef.current = detailsByDashboard;
  }, [detailsByDashboard]);

  useEffect(() => {
    writeRecentDownloads(recentDownloads);
  }, [recentDownloads]);

  useEffect(() => {
    if (!instanceId) return;
    const requestKey = instanceId;
    setLoadingFolders(true);
    setFolders([]);
    setDocuments([]);
    setSelectedFolder('');
    setSelectedFolderLabel('');
    setSelectedDocIds([]);
    setActiveDocId('');
    setDetailsByDashboard({});
    setFilterValuesByDashboard({});
    setSelectedTileKey('');
    setError('');
    listInstanceFolders(instanceId)
      .then((res) => {
        if (requestKeyRef.current !== requestKey) return;
        setFolders(Array.isArray(res.folders) ? res.folders : []);
      })
      .catch((err) => {
        if (requestKeyRef.current === requestKey) setError(err instanceof Error ? err.message : 'Failed to load folders.');
      })
      .finally(() => {
        if (requestKeyRef.current === requestKey) setLoadingFolders(false);
      });
  }, [instanceId]);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);
  const visibleFolders = useMemo(() => {
    const query = folderSearch.trim().toLowerCase();
    if (!query) return flatFolders.slice(0, 80);
    return flatFolders
      .filter((folder) => folder.name.toLowerCase().includes(query) || folderPath(folder).toLowerCase().includes(query))
      .slice(0, 80);
  }, [flatFolders, folderSearch]);

  const documentsById = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const selectedDocs = useMemo(() => selectedDocIds.map((id) => documentsById.get(id)).filter(Boolean) as InstanceDocument[], [documentsById, selectedDocIds]);
  const activeDoc = documentsById.get(activeDocId) || selectedDocs[0] || null;
  const activeState = activeDoc ? detailsByDashboard[activeDoc.id] : undefined;
  const activeDetails = activeState?.details;
  const activeFilterValues = activeDoc ? filterValuesByDashboard[activeDoc.id] || {} : {};
  const tileOptions = useMemo(() => activeDetails?.tiles.filter((tile) => tile.queryIdentifierMapKey) || [], [activeDetails?.tiles]);
  const selectedTile = tileOptions.find((tile) => tile.queryIdentifierMapKey === selectedTileKey) || null;
  const availableFormats = availableDashboardDownloadFormats(scope);
  const formatOptions = BASE_FORMAT_OPTIONS.filter((option) => availableFormats.includes(option.value));
  const isPdfPng = format === 'pdf' || format === 'png';
  const isDataFormat = format === 'csv' || format === 'xlsx' || format === 'json';
  const configuredFilterCount = selectedDocIds.filter((id) => hasConfiguredFilters(filterValuesByDashboard[id])).length;
  const queueStatusHint = scope === 'tile'
    ? selectedDocIds.length !== 1
      ? 'Single-tile downloads require exactly one dashboard.'
      : activeState?.loading
        ? 'Loading tile details...'
        : selectedTile?.queryIdentifierMapKey
          ? 'Ready for a single-tile export.'
          : 'Choose a tile to continue.'
    : 'Queued downloads run sequentially to avoid Omni job conflicts.';
  const parsedMaxRows = Number.parseInt(maxRowLimit, 10);
  const xlsxRowLimitBlocked = format === 'xlsx'
    && overrideRowLimit
    && Number.isFinite(parsedMaxRows)
    && parsedMaxRows > 0
    && scope !== 'tile';
  const canDownload = selectedDocs.length > 0
    && !downloading
    && Boolean(instanceId)
    && !xlsxRowLimitBlocked
    && (scope === 'dashboard' || (selectedDocs.length === 1 && Boolean(selectedTile?.queryIdentifierMapKey)));

  const visibleDocuments = useMemo(() => {
    const query = dashboardSearch.trim().toLowerCase();
    if (!query) return documents;
    return documents.filter((doc) => (
      doc.name.toLowerCase().includes(query)
      || (doc.identifier || '').toLowerCase().includes(query)
      || (doc.folderPath || '').toLowerCase().includes(query)
    ));
  }, [documents, dashboardSearch]);

  const currentOptions = useMemo<DashboardDownloadOptions>(() => ({
    format,
    scope,
    selectedTileKey,
    paperFormat,
    orientation,
    hideTitle,
    showFilters,
    expandTables,
    singleColumnLayout,
    enableFormatting,
    hideHiddenFields,
    overrideRowLimit,
    maxRowLimit,
    customFilename,
  }), [
    customFilename,
    enableFormatting,
    expandTables,
    format,
    hideHiddenFields,
    hideTitle,
    maxRowLimit,
    orientation,
    overrideRowLimit,
    paperFormat,
    scope,
    selectedTileKey,
    showFilters,
    singleColumnLayout,
  ]);

  const ensureDetails = useCallback(async (dashboardId: string): Promise<DashboardDownloadDetails> => {
    if (!instanceId) throw new Error('Choose a saved Omni instance before downloading.');
    const cached = detailsRef.current[dashboardId];
    if (cached?.details) return cached.details;
    if (cached?.error) throw new Error(cached.error);
    setDetailsByDashboard((current) => ({
      ...current,
      [dashboardId]: { loading: true },
    }));
    try {
      const res = await getDashboardDownloadDetails(instanceId, dashboardId);
      setDetailsByDashboard((current) => ({
        ...current,
        [dashboardId]: { loading: false, details: res.details },
      }));
      return res.details;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load dashboard details.';
      setDetailsByDashboard((current) => ({
        ...current,
        [dashboardId]: { loading: false, error: message },
      }));
      throw new Error(message);
    }
  }, [instanceId]);

  useEffect(() => {
    if (scope === 'dashboard' && format === 'json') setFormat('pdf');
  }, [format, scope]);

  useEffect(() => {
    if (activeDocId) void ensureDetails(activeDocId).catch(() => undefined);
  }, [activeDocId, ensureDetails]);

  useEffect(() => {
    if (scope !== 'tile') return;
    if (selectedTileKey && tileOptions.some((tile) => tile.queryIdentifierMapKey === selectedTileKey)) return;
    setSelectedTileKey(tileOptions[0]?.queryIdentifierMapKey || '');
  }, [scope, selectedTileKey, tileOptions]);

  async function handleFolderPick(folder: InstanceFolder) {
    if (!instanceId) return;
    const requestKey = instanceId;
    setSelectedFolder(folder.id);
    setSelectedFolderLabel(folderPath(folder));
    setSelectedDocIds([]);
    setActiveDocId('');
    setDocuments([]);
    setDashboardSearch('');
    setQueue([]);
    setFilterValuesByDashboard({});
    setSelectedTileKey('');
    setSuccess('');
    setError('');
    setLoadingDocs(true);
    try {
      const res = await listInstanceDocuments(instanceId, { folderId: folder.id });
      if (requestKeyRef.current !== requestKey) return;
      setDocuments(Array.isArray(res.documents) ? res.documents : []);
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboards.');
      setDocuments([]);
    } finally {
      if (requestKeyRef.current === requestKey) setLoadingDocs(false);
    }
  }

  function toggleDashboard(doc: InstanceDocument) {
    setSelectedDocIds((current) => {
      const selected = current.includes(doc.id);
      const next = selected ? current.filter((id) => id !== doc.id) : [...current, doc.id];
      if (!selected) {
        setActiveDocId(doc.id);
        void ensureDetails(doc.id).catch(() => undefined);
      } else if (activeDocId === doc.id) {
        setActiveDocId(next[0] || '');
      }
      return next;
    });
  }

  function selectVisibleDashboards() {
    const visibleIds = visibleDocuments.map((doc) => doc.id);
    setSelectedDocIds((current) => Array.from(new Set([...current, ...visibleIds])));
    if (!activeDocId && visibleIds[0]) setActiveDocId(visibleIds[0]);
    for (const id of visibleIds) void ensureDetails(id).catch(() => undefined);
  }

  function clearSelection() {
    setSelectedDocIds([]);
    setActiveDocId('');
    setQueue([]);
  }

  function updateQueueItem(queueId: string, patch: Partial<DashboardDownloadQueueItem>) {
    setQueue((current) => current.map((item) => (item.queueId === queueId ? { ...item, ...patch } : item)));
  }

  function updateActiveFilter(field: string, value: string) {
    if (!activeDoc) return;
    setFilterValuesByDashboard((current) => ({
      ...current,
      [activeDoc.id]: {
        ...(current[activeDoc.id] || {}),
        [field]: value,
      },
    }));
  }

  async function pollJob(dashboardId: string, jobId: string, onStatus: (message: string) => void) {
    const maxAttempts = 60;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await getDashboardDownloadJobStatus(instanceId, dashboardId, jobId);
      if (status.status === 'complete') return;
      if (status.status === 'error') throw new Error(status.error || 'The download job failed on the server.');
      onStatus(`Processing... (${attempt * 3}s)`);
    }
    throw new Error('Download timed out after 3 minutes.');
  }

  async function runSingleDownload(
    doc: InstanceDocument,
    queueId: string,
    total: number,
    options: DashboardDownloadOptions,
    filterSnapshot: Record<string, DashboardDownloadFilterState>,
    storedRequest?: RecentDashboardDownload,
  ) {
    const startedAt = Date.now();
    const runFormat = storedRequest?.format || options.format;
    const runScope = storedRequest?.scope || options.scope;
    let requestBody = storedRequest?.request;
    let filename = storedRequest?.filename || '';
    let tileName = storedRequest?.tileName;

    updateQueueItem(queueId, { status: 'starting', detail: 'Preparing request' });
    setJobStatus(`Preparing ${doc.name}...`);

    if (!requestBody) {
      let details: DashboardDownloadDetails;
      try {
        details = await ensureDetails(doc.id);
      } catch (err) {
        throw Object.assign(new Error(err instanceof Error ? err.message : 'Could not load dashboard details.'), { blocked: true });
      }
      const built = buildDashboardDownloadRequest({
        dashboardId: doc.id,
        dashboardName: doc.name,
        details,
        filterValues: filterSnapshot[doc.id] || {},
        options,
        total,
      });
      requestBody = built.body;
      filename = built.filename;
      tileName = built.tileName;
      if (built.warnings.length > 0) updateQueueItem(queueId, { detail: built.warnings.join(' ') });
    }

    const start = await startDashboardDownloadJob(instanceId, doc.id, {
      request: requestBody,
      format: runFormat,
      scope: runScope,
    });
    updateQueueItem(queueId, {
      status: start.attached ? 'attached' : 'processing',
      detail: start.attached ? 'Attached to existing Omni job' : 'Processing in Omni',
    });
    setJobStatus(start.attached ? `Attached to existing job for ${doc.name}` : `Processing ${doc.name}...`);

    await pollJob(doc.id, start.jobId, (message) => {
      updateQueueItem(queueId, { status: 'processing', detail: message });
      setJobStatus(`${doc.name}: ${message}`);
    });

    updateQueueItem(queueId, { status: 'fetching', detail: 'Fetching file' });
    setJobStatus(`Fetching ${doc.name}...`);
    const file = await fetchDashboardDownloadFile(instanceId, doc.id, start.jobId, filename);
    const typedBlob = new Blob([file.blob], { type: file.contentType || DASHBOARD_DOWNLOAD_MIME_TYPES[runFormat] || 'application/octet-stream' });
    downloadFile(typedBlob, filename);

    updateQueueItem(queueId, { status: 'done', detail: filename });
    const recent: RecentDashboardDownload = {
      id: `${Date.now()}:${doc.id}`,
      dashboardId: doc.id,
      dashboardName: doc.name,
      format: runFormat,
      scope: runScope,
      tileName,
      filename,
      filterSummary: summarizeDashboardDownloadFilters(requestBody),
      createdAt: Date.now(),
      request: requestBody,
    };
    setRecentDownloads((current) => [recent, ...current].slice(0, 8));
    logOp('download', `Downloaded "${doc.name}" as ${formatDashboardDownloadLabel(runFormat)}`, {
      durationMs: Date.now() - startedAt,
      itemCount: 1,
      successCount: 1,
      failureCount: 0,
    });
  }

  async function runDownloadQueue(
    docs: InstanceDocument[],
    options: DashboardDownloadOptions,
    filterSnapshot: Record<string, DashboardDownloadFilterState>,
    storedRequest?: RecentDashboardDownload,
  ) {
    setDownloading(true);
    setError('');
    setSuccess('');
    const initialQueue = docs.map((doc, index) => ({
      queueId: `${Date.now()}:${doc.id}:${index}`,
      dashboardId: doc.id,
      dashboardName: doc.name,
      status: 'queued' as const,
      detail: 'Queued',
      format: storedRequest?.format || options.format,
      scope: storedRequest?.scope || options.scope,
    }));
    setQueue(initialQueue);

    let succeeded = 0;
    let failed = 0;
    const queueStartedAt = Date.now();
    try {
      for (const item of initialQueue) {
        const doc = docs.find((candidate) => candidate.id === item.dashboardId);
        if (!doc) continue;
        try {
          await runSingleDownload(doc, item.queueId, docs.length, options, filterSnapshot, storedRequest);
          succeeded += 1;
        } catch (err) {
          failed += 1;
          const blocked = Boolean((err as { blocked?: unknown }).blocked);
          updateQueueItem(item.queueId, {
            status: blocked ? 'blocked' : 'failed',
            detail: blocked ? 'Blocked before download' : 'Failed',
            error: err instanceof Error ? err.message : 'Download failed',
          });
        }
      }
      setSuccess(`${succeeded} download${succeeded === 1 ? '' : 's'} completed${failed ? `, ${failed} failed` : ''}.`);
      logOp('download', `Dashboard download queue completed: ${succeeded}/${docs.length}`, {
        durationMs: Date.now() - queueStartedAt,
        itemCount: docs.length,
        successCount: succeeded,
        failureCount: failed,
      });
    } finally {
      setDownloading(false);
      setJobStatus(null);
    }
  }

  async function handleDownload() {
    if (!canDownload) {
      setError(
        xlsxRowLimitBlocked
          ? 'XLSX row-limit overrides require single-tile mode. Switch to Single tile or turn off the row-limit override.'
          : scope === 'tile'
            ? 'Choose one dashboard and one downloadable tile before exporting.'
            : 'Choose at least one dashboard.',
      );
      return;
    }
    await runDownloadQueue(selectedDocs, currentOptions, filterValuesByDashboard);
  }

  async function rerunDownload(download: RecentDashboardDownload) {
    const doc: InstanceDocument = {
      id: download.dashboardId,
      identifier: download.dashboardId,
      name: download.dashboardName,
    };
    setFormat(download.format);
    setScope(download.scope);
    await runDownloadQueue([doc], currentOptions, filterValuesByDashboard, download);
  }

  if (!instanceId) return savedInstanceRequired();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard Downloads"
        description="Export dashboards or tiles through the native vault with per-dashboard filters and a sequential queue."
        icon={<Blobby mood="download" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
      />

      <section className="card space-y-5">
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Folder</label>
              <SearchInput value={folderSearch} onChange={setFolderSearch} placeholder="Search folders..." />
            </div>
            <div className="max-h-[320px] overflow-y-auto rounded-card border border-border bg-surface-secondary p-2">
              {loadingFolders ? (
                <div className="flex items-center gap-2 px-2 py-4 text-sm text-content-secondary">
                  <Loader2 size={14} className="animate-spin" />
                  Loading folders
                </div>
              ) : visibleFolders.length === 0 ? (
                <div className="px-2 py-4 text-sm text-content-secondary">No folders match.</div>
              ) : (
                visibleFolders.map((folder) => {
                  const selected = selectedFolder === folder.id;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => void handleFolderPick(folder)}
                      aria-pressed={selected}
                      className={`w-full rounded-button px-2 py-2 text-left text-sm transition-all ${selected ? selectedRowClass : unselectedRowClass}`}
                      style={{ paddingLeft: `${folder.depth * 14 + 8}px` }}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Folder size={14} className="shrink-0 text-content-secondary" />
                        <span className="truncate">{folder.name}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
            {selectedFolderLabel && (
              <div className="text-[11px] text-content-tertiary">
                Folder: <span className="font-mono text-content-secondary">{selectedFolderLabel}</span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-[240px] flex-1">
                <label className="block text-xs font-medium text-content-secondary mb-1">Dashboards</label>
                <SearchInput value={dashboardSearch} onChange={setDashboardSearch} placeholder="Search dashboards in folder..." />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={selectVisibleDashboards} disabled={visibleDocuments.length === 0} className="btn-secondary text-xs disabled:opacity-50">
                  Select visible
                </button>
                <button type="button" onClick={clearSelection} disabled={selectedDocIds.length === 0} className="btn-secondary text-xs disabled:opacity-50">
                  Clear
                </button>
              </div>
            </div>

            <div className="max-h-[320px] overflow-y-auto rounded-card border border-border">
              {loadingDocs ? (
                <div className="flex items-center gap-2 px-4 py-6 text-sm text-content-secondary">
                  <Loader2 size={14} className="animate-spin" />
                  Loading dashboards
                </div>
              ) : !selectedFolder ? (
                <div className="empty-state py-10">
                  <div className="empty-state-mascot">
                    <img src="/blobby-getting-started.png" alt="Select a folder" className="w-14 h-14 object-contain animate-float" style={{ animationDuration: '3s' }} />
                  </div>
                  <p className="text-sm font-medium text-content-secondary">Choose a folder to browse dashboards.</p>
                </div>
              ) : visibleDocuments.length === 0 ? (
                <div className="empty-state py-10">
                  <div className="empty-state-mascot">
                    <img src="/blobby-empty.png" alt="No dashboards" className="w-14 h-14 object-contain animate-float" style={{ animationDuration: '3s' }} />
                  </div>
                  <p className="text-sm font-medium text-content-secondary">No dashboards match this search.</p>
                </div>
              ) : (
                visibleDocuments.map((doc) => {
                  const selected = selectedDocIds.includes(doc.id);
                  const active = activeDocId === doc.id;
                  const detailState = detailsByDashboard[doc.id];
                  return (
                    <label
                      key={doc.id}
                      className={`flex cursor-pointer items-center gap-3 border-b border-border/50 px-4 py-3 last:border-b-0 transition-all ${selected ? selectedRowClass : unselectedRowClass}`}
                    >
                      <input type="checkbox" checked={selected} onChange={() => toggleDashboard(doc)} />
                      <button type="button" onClick={() => setActiveDocId(doc.id)} className="min-w-0 flex-1 text-left">
                        <div className="truncate text-sm font-medium text-content-primary">{doc.name}</div>
                        <div className="truncate text-[11px] text-content-tertiary">{doc.identifier || doc.id}</div>
                      </button>
                      {detailState?.loading && <Loader2 size={13} className="animate-spin text-content-secondary" />}
                      {detailState?.error && <StatusChip status="warning" label="Details" title={detailState.error} />}
                      {active && <StatusChip status="info" label="Active" />}
                      {selected && <span className={selectedBadgeClass}><CheckCircle size={12} />Queued</span>}
                    </label>
                  );
                })
              )}
            </div>
            <div className="text-xs text-content-secondary">
              {selectedDocIds.length} dashboard{selectedDocIds.length === 1 ? '' : 's'} queued. Filters configured: {configuredFilterCount}/{selectedDocIds.length}. {queueStatusHint}
            </div>
          </div>
        </div>
      </section>

      <section className="card space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-content-primary">Download options</h2>
            <p className="text-sm text-content-secondary">
              {activeDoc ? `Active dashboard: ${activeDoc.name}` : 'Select a dashboard to load filters and tiles.'}
            </p>
          </div>
          {activeState?.loading && <StatusChip status="in_progress" label="Loading dashboard details" />}
          {activeState?.error && <StatusChip status="warning" label="Details unavailable" title={activeState.error} />}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setScope('dashboard')}
            aria-pressed={scope === 'dashboard'}
            className={`rounded-card border p-4 text-left transition-all ${scope === 'dashboard' ? selectedCardClass : unselectedCardClass}`}
          >
            <div className="text-sm font-semibold text-content-primary">Whole dashboard</div>
            <p className="mt-1 text-xs text-content-secondary">Export selected dashboards with their own filter values and shared format settings.</p>
          </button>
          <button
            type="button"
            onClick={() => setScope('tile')}
            aria-pressed={scope === 'tile'}
            className={`rounded-card border p-4 text-left transition-all ${scope === 'tile' ? selectedCardClass : unselectedCardClass}`}
          >
            <div className="text-sm font-semibold text-content-primary">Single tile</div>
            <p className="mt-1 text-xs text-content-secondary">Export one tile from the active dashboard. JSON is available only in this mode.</p>
          </button>
        </div>

        {scope === 'tile' && (
          <div className="rounded-card border border-border bg-surface-secondary p-4">
            <label className="block text-xs font-medium text-content-secondary mb-1">Tile</label>
            <select
              value={selectedTileKey}
              onChange={(event) => setSelectedTileKey(event.target.value)}
              className="input-field"
              disabled={tileOptions.length === 0}
            >
              <option value="">{tileOptions.length === 0 ? 'No downloadable tiles found' : 'Choose tile...'}</option>
              {tileOptions.map((tile) => (
                <option key={tile.queryIdentifierMapKey || tile.id} value={tile.queryIdentifierMapKey}>
                  {tile.name}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-content-secondary">Omni JSON downloads require a single tile with a queryIdentifierMapKey.</p>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-content-secondary mb-2">Format</label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {formatOptions.map((option) => {
              const Icon = option.icon;
              const isSelected = format === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFormat(option.value)}
                  aria-pressed={isSelected}
                  className={`relative flex flex-col items-center gap-1.5 p-3 rounded-card border-2 transition-all ${isSelected ? selectedCardClass : unselectedCardClass}`}
                >
                  {isSelected && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
                  <div className={`p-2 rounded-button ${option.color}`}>
                    <Icon size={18} />
                  </div>
                  <span className="text-xs font-medium text-content-primary">{option.label}</span>
                  <span className="text-[10px] text-content-secondary leading-tight text-center">{option.description}</span>
                  {isSelected && <span className={selectedBadgeClass}><CheckCircle size={12} />Selected</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {isPdfPng && (
            <div className="space-y-3 rounded-card bg-surface-secondary p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                <Image size={15} />
                Render options
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {format === 'pdf' && (
                  <>
                    <label className="text-xs font-medium text-content-secondary">
                      Paper Format
                      <select value={paperFormat} onChange={(event) => setPaperFormat(event.target.value)} className="input-field mt-1">
                        {PAPER_FORMATS.map((paper) => <option key={paper.value} value={paper.value}>{paper.label}</option>)}
                      </select>
                    </label>
                    <label className="text-xs font-medium text-content-secondary">
                      Orientation
                      <select value={orientation} onChange={(event) => setOrientation(event.target.value)} className="input-field mt-1">
                        <option value="landscape">Landscape</option>
                        <option value="portrait">Portrait</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
              <div className="grid gap-2 text-xs text-content-primary sm:grid-cols-2">
                <label className="flex items-center gap-2"><input type="checkbox" checked={hideTitle} onChange={(event) => setHideTitle(event.target.checked)} />Hide title</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={showFilters} onChange={(event) => setShowFilters(event.target.checked)} />Show filters on export</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={expandTables} onChange={(event) => setExpandTables(event.target.checked)} />Expand tables</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={singleColumnLayout} onChange={(event) => setSingleColumnLayout(event.target.checked)} />Single-column layout</label>
              </div>
              {format === 'png' && (
                <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Omni PNG exports may ignore filter overrides in some cases. Verify filtered PNGs before sharing externally.
                </div>
              )}
            </div>
          )}

          {isDataFormat && (
            <div className="space-y-3 rounded-card bg-surface-secondary p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                <FileSpreadsheet size={15} />
                Data options
              </div>
              <p className="text-xs text-content-secondary">
                {format === 'xlsx'
                  ? 'Large XLSX row limits require single-tile mode and a downloadable tile.'
                  : format === 'csv'
                    ? 'CSV exports download as a ZIP containing one CSV per tile.'
                    : 'JSON exports are available for single-tile downloads only.'}
              </p>
              {xlsxRowLimitBlocked && (
                <div role="alert" className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  XLSX row-limit overrides require single-tile mode. Switch to Single tile or disable the override before exporting.
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-content-secondary">
                  Max Row Limit
                  <input
                    type="number"
                    value={maxRowLimit}
                    onChange={(event) => setMaxRowLimit(event.target.value)}
                    disabled={!overrideRowLimit}
                    className="input-field mt-1 disabled:opacity-50"
                    min="1"
                    max="1000000"
                    placeholder="No override"
                  />
                </label>
                <div className="flex flex-col justify-center gap-2 text-xs text-content-primary">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={overrideRowLimit} onChange={(event) => setOverrideRowLimit(event.target.checked)} />Override default row limit</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={enableFormatting} onChange={(event) => setEnableFormatting(event.target.checked)} />Enable formatting</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={hideHiddenFields} onChange={(event) => setHideHiddenFields(event.target.checked)} />Hide hidden fields</label>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3 rounded-card bg-surface-secondary p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              <Download size={15} />
              Filename
            </div>
            <label className="text-xs font-medium text-content-secondary">
              Custom filename
              <input
                type="text"
                value={customFilename}
                onChange={(event) => setCustomFilename(event.target.value)}
                className="input-field mt-1"
                maxLength={255}
                placeholder="Optional. Defaults to dashboard name."
              />
            </label>
            <p className="text-xs text-content-secondary">For batches, OmniKit appends the dashboard name to keep files distinct.</p>
          </div>
        </div>

        {activeDetails?.filters && activeDetails.filters.length > 0 && (
          <div className="space-y-3 rounded-card border border-border bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={15} className="text-content-secondary" />
                <div>
                  <h3 className="text-sm font-semibold text-content-primary">Filter values</h3>
                  <p className="text-xs text-content-secondary">These values apply only to the active dashboard. Comma-separate multiple values.</p>
                </div>
              </div>
              <StatusChip status={hasConfiguredFilters(activeFilterValues) ? 'success' : 'pending'} label={hasConfiguredFilters(activeFilterValues) ? 'Configured' : 'Defaults'} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {activeDetails.filters.map((filter) => (
                <label key={filter.field} className="text-xs font-medium text-content-secondary">
                  {filter.label || filter.field}
                  <input
                    type="text"
                    value={activeFilterValues[filter.field] || ''}
                    onChange={(event) => updateActiveFilter(filter.field, event.target.value)}
                    className="input-field mt-1"
                    placeholder={(filter.values || []).map(String).filter(Boolean).slice(0, 3).join(', ') || filter.field}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {(downloading || success) && (
          <div aria-live="polite">
            <DownloadAnimation status={jobStatus} success={Boolean(success && !downloading)} format={format} />
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {success && !downloading && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-card">
            <CheckCircle size={16} />
            {success}
          </div>
        )}

        <button
          onClick={() => void handleDownload()}
          disabled={!canDownload}
          className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {downloading
            ? 'Downloading...'
            : scope === 'tile'
              ? 'Download Tile'
              : selectedDocs.length > 1
                ? `Download ${selectedDocs.length} Dashboards`
                : 'Download Dashboard'}
        </button>
      </section>

      {queue.length > 0 && (
        <section className="card space-y-3" aria-live="polite">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-content-primary">Download queue</h2>
            <span className="text-xs text-content-secondary">Sequential per dashboard</span>
          </div>
          <div className="divide-y divide-border rounded-card border border-border">
            {queue.map((item) => (
              <div key={item.queueId} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)] md:items-center">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-content-primary">{item.dashboardName}</div>
                  <div className="text-xs text-content-secondary">{formatDashboardDownloadLabel(item.format)}</div>
                </div>
                <StatusChip status={dashboardDownloadStatusVariant(item.status)} label={item.status === 'attached' ? 'Already running' : item.status} />
                <div className="truncate text-xs text-content-secondary" title={item.error || item.detail}>
                  {item.error || item.detail}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <RefreshCcw size={15} className="text-content-secondary" />
          <h2 className="text-base font-semibold text-content-primary">Recent downloads</h2>
        </div>
        {recentDownloads.length === 0 ? (
          <div className="rounded-card border border-dashed border-border px-4 py-5 text-sm text-content-secondary">
            Completed downloads will appear here with their original request settings for one-click re-run.
          </div>
        ) : (
          <div className="grid gap-2">
            {recentDownloads.map((download) => (
              <div key={download.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-content-primary">{download.dashboardName}</div>
                  <div className="text-xs text-content-secondary">
                    {formatDashboardDownloadLabel(download.format)} · {download.scope === 'tile' ? download.tileName || 'Tile' : 'Whole dashboard'} · {new Date(download.createdAt).toLocaleTimeString()}
                  </div>
                  {download.filterSummary && (
                    <div className="mt-0.5 truncate text-[11px] text-content-tertiary" title={download.filterSummary}>
                      Filters: {download.filterSummary}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => void rerunDownload(download)} disabled={downloading} className="btn-secondary text-xs disabled:opacity-50">
                  Re-run
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
