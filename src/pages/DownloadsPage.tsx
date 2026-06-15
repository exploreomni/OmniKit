import { useEffect, useMemo, useRef, useState } from 'react';
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
  SlidersHorizontal,
} from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { ApiError, listDocuments, listFolders, omniProxy, omniProxyDownload } from '@/services/omniApi';
import { fetchDashboardSummary } from '@/services/deckBuilder/omniDeckApi';
import type { DashboardFilter, DashboardTile, FilterOverride } from '@/services/deckBuilder/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadAnimation } from '@/components/ui/DownloadAnimation';
import { Blobby } from '@/components/ui/Blobby';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { selectedBadgeClass, selectedCardClass, selectedRowClass, unselectedCardClass, unselectedRowClass } from '@/components/ui/selectionStyles';
import type { OmniDocument, OmniFolder } from '@/types';

type DownloadFormat = 'pdf' | 'png' | 'csv' | 'xlsx' | 'json';
type DownloadScope = 'dashboard' | 'tile';
type QueueStatus = 'queued' | 'starting' | 'attached' | 'processing' | 'fetching' | 'done' | 'failed';

interface FormatOption {
  value: DownloadFormat;
  label: string;
  description: string;
  icon: typeof FileText;
  color: string;
}

interface DashboardDetailState {
  loading: boolean;
  filters: DashboardFilter[];
  tiles: DashboardTile[];
  error?: string;
}

interface DownloadQueueItem {
  queueId: string;
  dashboardId: string;
  dashboardName: string;
  status: QueueStatus;
  detail: string;
  error?: string;
  format: DownloadFormat;
}

interface RecentDownload {
  id: string;
  dashboardId: string;
  dashboardName: string;
  format: DownloadFormat;
  scope: DownloadScope;
  tileName?: string;
  filename: string;
  createdAt: number;
  body: Record<string, unknown>;
}

interface DownloadRunOptions {
  runFormat?: DownloadFormat;
  runScope?: DownloadScope;
  tileName?: string;
  filenameFactory?: (doc: OmniDocument, total: number) => string;
}

const BASE_FORMAT_OPTIONS: FormatOption[] = [
  { value: 'pdf', label: 'PDF', description: 'Single PDF file', icon: FileText, color: 'text-red-600 bg-red-50' },
  { value: 'png', label: 'PNG', description: 'Image snapshot', icon: Image, color: 'text-blue-600 bg-blue-50' },
  { value: 'csv', label: 'CSV (ZIP)', description: 'One CSV per tile', icon: FileSpreadsheet, color: 'text-green-600 bg-green-50' },
  { value: 'xlsx', label: 'XLSX', description: 'Excel workbook', icon: FileSpreadsheet, color: 'text-emerald-600 bg-emerald-50' },
];

const JSON_FORMAT_OPTION: FormatOption = {
  value: 'json',
  label: 'JSON',
  description: 'Single tile data',
  icon: FileText,
  color: 'text-violet-700 bg-violet-50',
};

const PAPER_FORMATS = [
  { value: 'fit_page', label: 'Fit Page' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
  { value: 'tabloid', label: 'Tabloid' },
  { value: 'a3', label: 'A3' },
  { value: 'a4', label: 'A4' },
];

const MIME_TYPES: Record<DownloadFormat, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  csv: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
};

const EXTENSIONS: Record<DownloadFormat, string> = {
  pdf: 'pdf',
  png: 'png',
  csv: 'zip',
  xlsx: 'xlsx',
  json: 'json',
};

function flattenFolders(folders: OmniFolder[], depth = 0): Array<OmniFolder & { depth: number }> {
  const result: Array<OmniFolder & { depth: number }> = [];
  for (const folder of folders) {
    result.push({ ...folder, depth });
    if (folder.children) result.push(...flattenFolders(folder.children, depth + 1));
  }
  return result;
}

function folderPath(folder: OmniFolder): string {
  return folder.path || folder.identifier || folder.name;
}

function formatLabel(format: DownloadFormat) {
  if (format === 'csv') return 'CSV (ZIP)';
  return format.toUpperCase();
}

function cleanFilename(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
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

function parseFilterValues(raw: string): unknown[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildFilterConfig(filters: DashboardFilter[], valuesByField: Record<string, string>): Record<string, FilterOverride> | undefined {
  const out: Record<string, FilterOverride> = {};
  for (const filter of filters) {
    const raw = valuesByField[filter.field] || '';
    const values = parseFilterValues(raw);
    if (values.length === 0) continue;
    out[filter.field] = {
      field: filter.field,
      kind: filter.kind,
      type: filter.type,
      values,
      isNegative: filter.isNegative,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseJobIdFromValue(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.job_id || record.jobId || record.id || record.download_job_id || '');
  }
  if (typeof value !== 'string') return '';
  try {
    return parseJobIdFromValue(JSON.parse(value));
  } catch {
    const match = value.match(/"?(?:job_id|jobId|download_job_id)"?\s*[:=]\s*"([^"]+)"/i);
    return match?.[1] || '';
  }
}

function statusVariant(status: QueueStatus) {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'queued') return 'pending';
  if (status === 'attached') return 'warning';
  return 'in_progress';
}

export function DownloadsPage() {
  const { connection } = useConnection();
  const logOp = useLogOperation();
  const connectionKey = connection.instanceId || connection.baseUrl;
  const activeConnectionKeyRef = useRef(connectionKey);

  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [documents, setDocuments] = useState<OmniDocument[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedFolderLabel, setSelectedFolderLabel] = useState('');
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [activeDocId, setActiveDocId] = useState('');
  const [folderSearch, setFolderSearch] = useState('');
  const [dashboardSearch, setDashboardSearch] = useState('');
  const [format, setFormat] = useState<DownloadFormat>('pdf');
  const [scope, setScope] = useState<DownloadScope>('dashboard');
  const [selectedTileKey, setSelectedTileKey] = useState('');
  const [detailsByDashboard, setDetailsByDashboard] = useState<Record<string, DashboardDetailState>>({});

  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [queue, setQueue] = useState<DownloadQueueItem[]>([]);
  const [recentDownloads, setRecentDownloads] = useState<RecentDownload[]>([]);
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
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});

  useEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
  }, [connectionKey]);

  useEffect(() => {
    async function load() {
      const requestKey = connectionKey;
      setLoadingFolders(true);
      setError('');
      try {
        const res = await listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        if (activeConnectionKeyRef.current !== requestKey) return;
        setFolders(Array.isArray(res.folders) ? res.folders : []);
      } catch (err) {
        if (activeConnectionKeyRef.current === requestKey) {
          setError(err instanceof Error ? err.message : 'Failed to load folders.');
        }
      } finally {
        if (activeConnectionKeyRef.current === requestKey) setLoadingFolders(false);
      }
    }
    void load();
  }, [connection.baseUrl, connection.apiKey, connectionKey]);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);
  const visibleFolders = useMemo(() => {
    const query = folderSearch.trim().toLowerCase();
    if (!query) return flatFolders.slice(0, 80);
    return flatFolders
      .filter((folder) => folder.name.toLowerCase().includes(query) || folderPath(folder).toLowerCase().includes(query))
      .slice(0, 80);
  }, [flatFolders, folderSearch]);

  const documentsById = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const selectedDocs = useMemo(() => selectedDocIds.map((id) => documentsById.get(id)).filter(Boolean) as OmniDocument[], [documentsById, selectedDocIds]);
  const activeDoc = documentsById.get(activeDocId) || selectedDocs[0] || null;
  const activeDetails = activeDoc ? detailsByDashboard[activeDoc.id] : undefined;
  const tileOptions = useMemo(
    () => activeDetails?.tiles.filter((tile) => tile.queryIdentifierMapKey) || [],
    [activeDetails?.tiles],
  );
  const selectedTile = tileOptions.find((tile) => tile.queryIdentifierMapKey === selectedTileKey) || null;
  const availableFormats = scope === 'tile' ? [...BASE_FORMAT_OPTIONS, JSON_FORMAT_OPTION] : BASE_FORMAT_OPTIONS;
  const isPdfPng = format === 'pdf' || format === 'png';
  const isDataFormat = format === 'csv' || format === 'xlsx' || format === 'json';
  const filterConfig = buildFilterConfig(activeDetails?.filters || [], filterValues);
  const canDownload = selectedDocs.length > 0
    && !downloading
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

  useEffect(() => {
    if (scope === 'dashboard' && format === 'json') setFormat('pdf');
  }, [format, scope]);

  useEffect(() => {
    setFilterValues({});
    setSelectedTileKey('');
  }, [activeDocId]);

  useEffect(() => {
    if (!activeDocId) return;
    const existing = detailsByDashboard[activeDocId];
    if (existing) return;
    let cancelled = false;
    setDetailsByDashboard((current) => ({
      ...current,
      [activeDocId]: { loading: true, filters: [], tiles: [] },
    }));
    fetchDashboardSummary(connection.baseUrl, connection.apiKey, activeDocId)
      .then((summary) => {
        if (cancelled) return;
        setDetailsByDashboard((current) => ({
          ...current,
          [activeDocId]: {
            loading: false,
            filters: summary.filters || [],
            tiles: summary.tiles || [],
          },
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailsByDashboard((current) => ({
          ...current,
          [activeDocId]: {
            loading: false,
            filters: [],
            tiles: [],
            error: err instanceof Error ? err.message : 'Could not load dashboard details.',
          },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeDocId, connection.apiKey, connection.baseUrl, detailsByDashboard]);

  useEffect(() => {
    if (scope !== 'tile' || selectedTileKey || tileOptions.length === 0) return;
    setSelectedTileKey(tileOptions[0].queryIdentifierMapKey || '');
  }, [scope, selectedTileKey, tileOptions]);

  async function handleFolderPick(folder: OmniFolder) {
    const requestKey = connectionKey;
    setSelectedFolder(folder.id);
    setSelectedFolderLabel(folderPath(folder));
    setSelectedDocIds([]);
    setActiveDocId('');
    setDocuments([]);
    setDashboardSearch('');
    setQueue([]);
    setSuccess('');
    setError('');
    setLoadingDocs(true);
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folder.id, { allPages: true, pageSize: 100 });
      if (activeConnectionKeyRef.current !== requestKey) return;
      setDocuments(Array.isArray(res.documents) ? res.documents : []);
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboards.');
      setDocuments([]);
    } finally {
      if (activeConnectionKeyRef.current === requestKey) setLoadingDocs(false);
    }
  }

  function toggleDashboard(doc: OmniDocument) {
    setSelectedDocIds((current) => {
      const selected = current.includes(doc.id);
      const next = selected ? current.filter((id) => id !== doc.id) : [...current, doc.id];
      if (!selected) setActiveDocId(doc.id);
      else if (activeDocId === doc.id) setActiveDocId(next[0] || '');
      return next;
    });
  }

  function selectVisibleDashboards() {
    const visibleIds = visibleDocuments.map((doc) => doc.id);
    setSelectedDocIds((current) => Array.from(new Set([...current, ...visibleIds])));
    if (!activeDocId && visibleIds[0]) setActiveDocId(visibleIds[0]);
  }

  function clearSelection() {
    setSelectedDocIds([]);
    setActiveDocId('');
    setQueue([]);
  }

  function updateQueueItem(queueId: string, patch: Partial<DownloadQueueItem>) {
    setQueue((current) => current.map((item) => (item.queueId === queueId ? { ...item, ...patch } : item)));
  }

  function buildFilename(doc: OmniDocument, total: number, runFormat = format) {
    const ext = EXTENSIONS[runFormat];
    const requested = cleanFilename(customFilename);
    const base = requested
      ? total > 1
        ? cleanFilename(`${requested} - ${doc.name}`)
        : requested
      : cleanFilename(doc.name || 'dashboard');
    return `${base || 'dashboard'}.${ext}`;
  }

  function buildDownloadBody(doc: OmniDocument, total: number): Record<string, unknown> {
    const body: Record<string, unknown> = { format };

    if (filterConfig) body.filterConfig = filterConfig;
    if (customFilename.trim()) body.filename = buildFilename(doc, total).replace(/\.[^.]+$/, '').slice(0, 255);

    if (scope === 'tile' && selectedTile?.queryIdentifierMapKey) {
      body.queryIdentifierMapKey = selectedTile.queryIdentifierMapKey;
    }

    if (format === 'pdf') {
      body.paperFormat = paperFormat;
      body.paperOrientation = orientation;
      body.showFilters = showFilters;
      if (hideTitle) body.hideTitle = true;
      if (expandTables) body.expandTablesToShowAllRows = true;
      if (singleColumnLayout) body.singleColumnLayout = true;
    }

    if (format === 'png') {
      body.showFilters = showFilters;
      if (hideTitle) body.hideTitle = true;
      if (expandTables) body.expandTablesToShowAllRows = true;
      if (singleColumnLayout) body.singleColumnLayout = true;
    }

    if (format === 'csv' || format === 'xlsx' || format === 'json') {
      body.enableFormatting = enableFormatting;
      if (hideHiddenFields) body.hideHiddenFields = true;
      const maxRows = Number.parseInt(maxRowLimit, 10);
      if (overrideRowLimit && Number.isFinite(maxRows) && maxRows > 0) {
        body.overrideRowLimit = true;
        body.maxRowLimit = maxRows;
      }
    }

    return body;
  }

  async function initiateDownload(dashboardId: string, body: Record<string, unknown>) {
    try {
      const res = await omniProxy<{ job_id?: string; jobId?: string; id?: string; error?: string }>(
        connection.baseUrl,
        connection.apiKey,
        'POST',
        `/v1/dashboards/${dashboardId}/download`,
        { body },
      );
      const jobId = res.job_id || res.jobId || res.id || '';
      if (!jobId) throw new Error(res.error || 'No job ID returned from Omni.');
      return { jobId, attached: false };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const jobId = parseJobIdFromValue(err.detail) || parseJobIdFromValue(err.message);
        if (jobId) return { jobId, attached: true };
        throw new Error('A download is already running for this dashboard, but Omni did not return the existing job id.');
      }
      throw err;
    }
  }

  async function pollJob(dashboardId: string, jobId: string, onStatus: (message: string) => void) {
    const maxAttempts = 60;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await omniProxy<{ status: string; error?: string }>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        `/v1/dashboards/${dashboardId}/download/${jobId}/status`,
      );
      if (status.status === 'complete') return;
      if (status.status === 'error') throw new Error(status.error || 'The download job failed on the server.');
      onStatus(`Processing... (${attempt * 3}s)`);
    }
    throw new Error('Download timed out after 3 minutes.');
  }

  async function runSingleDownload(
    doc: OmniDocument,
    body: Record<string, unknown>,
    queueId: string,
    total: number,
    options: DownloadRunOptions = {},
  ) {
    const runFormat = options.runFormat || format;
    const runScope = options.runScope || scope;
    const runTileName = options.tileName || selectedTile?.name;
    const startedAt = Date.now();
    const filename = options.filenameFactory?.(doc, total) || buildFilename(doc, total, runFormat);
    updateQueueItem(queueId, { status: 'starting', detail: 'Starting download' });
    setJobStatus(`Starting ${doc.name}...`);

    const { jobId, attached } = await initiateDownload(doc.id, body);
    updateQueueItem(queueId, {
      status: attached ? 'attached' : 'processing',
      detail: attached ? 'Attached to existing Omni job' : 'Processing in Omni',
    });
    setJobStatus(attached ? `Attached to existing job for ${doc.name}` : `Processing ${doc.name}...`);

    await pollJob(doc.id, jobId, (message) => {
      updateQueueItem(queueId, { status: 'processing', detail: message });
      setJobStatus(`${doc.name}: ${message}`);
    });

    updateQueueItem(queueId, { status: 'fetching', detail: 'Fetching file' });
    setJobStatus(`Fetching ${doc.name}...`);
    const blob = await omniProxyDownload(connection.baseUrl, connection.apiKey, `/v1/dashboards/${doc.id}/download/${jobId}`);
    const typedBlob = new Blob([blob], { type: MIME_TYPES[runFormat] || 'application/octet-stream' });
    downloadFile(typedBlob, filename);

    updateQueueItem(queueId, { status: 'done', detail: filename });
    setRecentDownloads((current) => [
      {
        id: `${Date.now()}:${doc.id}`,
        dashboardId: doc.id,
        dashboardName: doc.name,
        format: runFormat,
        scope: runScope,
        tileName: runTileName,
        filename,
        createdAt: Date.now(),
        body,
      },
      ...current,
    ].slice(0, 8));
    logOp('download', `Downloaded "${doc.name}" as ${formatLabel(runFormat)}`, {
      durationMs: Date.now() - startedAt,
      itemCount: 1,
      successCount: 1,
      failureCount: 0,
    });
  }

  async function runDownloadQueue(
    docs: OmniDocument[],
    bodyFactory: (doc: OmniDocument, total: number) => Record<string, unknown>,
    options: DownloadRunOptions = {},
  ) {
    const runFormat = options.runFormat || format;
    setDownloading(true);
    setError('');
    setSuccess('');
    const initialQueue = docs.map((doc, index) => ({
      queueId: `${Date.now()}:${doc.id}:${index}`,
      dashboardId: doc.id,
      dashboardName: doc.name,
      status: 'queued' as QueueStatus,
      detail: 'Queued',
      format: runFormat,
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
          await runSingleDownload(doc, bodyFactory(doc, docs.length), item.queueId, docs.length, options);
          succeeded += 1;
        } catch (err) {
          failed += 1;
          updateQueueItem(item.queueId, {
            status: 'failed',
            detail: 'Failed',
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
      setError(scope === 'tile' ? 'Choose one dashboard and one downloadable tile before exporting.' : 'Choose at least one dashboard.');
      return;
    }
    await runDownloadQueue(selectedDocs, (doc, total) => buildDownloadBody(doc, total));
  }

  async function rerunDownload(download: RecentDownload) {
    const doc: OmniDocument = { id: download.dashboardId, name: download.dashboardName };
    setFormat(download.format);
    setScope(download.scope);
    await runDownloadQueue([doc], () => download.body, {
      runFormat: download.format,
      runScope: download.scope,
      tileName: download.tileName,
      filenameFactory: () => download.filename,
    });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard Downloads"
        description="Export whole dashboards or individual tiles with filters, format controls, and a sequential download queue."
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
                      {active && <StatusChip status="info" label="Active" />}
                      {selected && <span className={selectedBadgeClass}><CheckCircle size={12} />Queued</span>}
                    </label>
                  );
                })
              )}
            </div>
            <div className="text-xs text-content-secondary">
              {selectedDocIds.length} dashboard{selectedDocIds.length === 1 ? '' : 's'} queued. {scope === 'tile' ? 'Single-tile downloads require exactly one dashboard.' : 'Queued downloads run sequentially to avoid Omni job conflicts.'}
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
          {activeDetails?.loading && (
            <StatusChip status="in_progress" label="Loading dashboard details" />
          )}
          {activeDetails?.error && (
            <StatusChip status="warning" label="Details unavailable" title={activeDetails.error} />
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setScope('dashboard')}
            aria-pressed={scope === 'dashboard'}
            className={`rounded-card border p-4 text-left transition-all ${scope === 'dashboard' ? selectedCardClass : unselectedCardClass}`}
          >
            <div className="text-sm font-semibold text-content-primary">Whole dashboard</div>
            <p className="mt-1 text-xs text-content-secondary">Export the full dashboard with the selected format and dashboard-level options.</p>
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
            {availableFormats.map((option) => {
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
                  ? 'Large XLSX row limits require the override toggle and are most reliable for single-tile exports.'
                  : format === 'csv'
                    ? 'CSV exports download as a ZIP containing one CSV per tile.'
                    : 'JSON exports are available for single-tile downloads only.'}
              </p>
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
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-content-secondary" />
              <div>
                <h3 className="text-sm font-semibold text-content-primary">Filter values</h3>
                <p className="text-xs text-content-secondary">Comma-separate multiple values. Blank filters use the dashboard default.</p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {activeDetails.filters.map((filter) => (
                <label key={filter.field} className="text-xs font-medium text-content-secondary">
                  {filter.label || filter.field}
                  <input
                    type="text"
                    value={filterValues[filter.field] || ''}
                    onChange={(event) => setFilterValues((current) => ({ ...current, [filter.field]: event.target.value }))}
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
                  <div className="text-xs text-content-secondary">{formatLabel(item.format)}</div>
                </div>
                <StatusChip status={statusVariant(item.status)} label={item.status === 'attached' ? 'Already running' : item.status} />
                <div className="truncate text-xs text-content-secondary" title={item.error || item.detail}>
                  {item.error || item.detail}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {recentDownloads.length > 0 && (
        <section className="card space-y-3">
          <div className="flex items-center gap-2">
            <RefreshCcw size={15} className="text-content-secondary" />
            <h2 className="text-base font-semibold text-content-primary">Recent downloads</h2>
          </div>
          <div className="grid gap-2">
            {recentDownloads.map((download) => (
              <div key={download.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-content-primary">{download.dashboardName}</div>
                  <div className="text-xs text-content-secondary">
                    {formatLabel(download.format)} · {download.scope === 'tile' ? download.tileName || 'Tile' : 'Whole dashboard'} · {new Date(download.createdAt).toLocaleTimeString()}
                  </div>
                </div>
                <button type="button" onClick={() => void rerunDownload(download)} disabled={downloading} className="btn-secondary text-xs disabled:opacity-50">
                  Re-run
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
