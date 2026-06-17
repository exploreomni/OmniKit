import type { DashboardFilter, DashboardTile, FilterOverride } from '@/services/deckBuilder/types';

export type DashboardDownloadFormat = 'pdf' | 'png' | 'csv' | 'xlsx' | 'json';
export type DashboardDownloadScope = 'dashboard' | 'tile';
export type DashboardDownloadQueueStatus = 'queued' | 'starting' | 'attached' | 'processing' | 'fetching' | 'done' | 'failed' | 'blocked';

export interface DashboardDownloadDetails {
  id: string;
  name: string;
  filters: DashboardFilter[];
  tiles: DashboardTile[];
}

export interface DashboardDownloadOptions {
  format: DashboardDownloadFormat;
  scope: DashboardDownloadScope;
  selectedTileKey?: string;
  paperFormat: string;
  orientation: string;
  hideTitle: boolean;
  showFilters: boolean;
  expandTables: boolean;
  singleColumnLayout: boolean;
  enableFormatting: boolean;
  hideHiddenFields: boolean;
  overrideRowLimit: boolean;
  maxRowLimit: string;
  customFilename: string;
}

export interface DashboardDownloadBuildInput {
  dashboardId: string;
  dashboardName: string;
  details?: DashboardDownloadDetails;
  filterValues: DashboardDownloadFilterState;
  options: DashboardDownloadOptions;
  total: number;
}

export interface DashboardDownloadRequest {
  dashboardId: string;
  dashboardName: string;
  format: DashboardDownloadFormat;
  scope: DashboardDownloadScope;
  body: Record<string, unknown>;
  filename: string;
  tileName?: string;
  warnings: string[];
}

export type DashboardDownloadFilterState = Record<string, string>;

export interface DashboardDownloadQueueItem {
  queueId: string;
  dashboardId: string;
  dashboardName: string;
  status: DashboardDownloadQueueStatus;
  detail: string;
  error?: string;
  format: DashboardDownloadFormat;
  scope: DashboardDownloadScope;
}

export interface RecentDashboardDownload {
  id: string;
  dashboardId: string;
  dashboardName: string;
  format: DashboardDownloadFormat;
  scope: DashboardDownloadScope;
  tileName?: string;
  filename: string;
  filterSummary?: string;
  createdAt: number;
  request: Record<string, unknown>;
}

export const DASHBOARD_DOWNLOAD_EXTENSIONS: Record<DashboardDownloadFormat, string> = {
  pdf: 'pdf',
  png: 'png',
  csv: 'zip',
  xlsx: 'xlsx',
  json: 'json',
};

export const DASHBOARD_DOWNLOAD_MIME_TYPES: Record<DashboardDownloadFormat, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  csv: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
};

export function formatDashboardDownloadLabel(format: DashboardDownloadFormat): string {
  return format === 'csv' ? 'CSV (ZIP)' : format.toUpperCase();
}

export function cleanDashboardDownloadFilename(value: string, maxLength = 240): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

export function buildDashboardDownloadFilename(
  dashboardName: string,
  format: DashboardDownloadFormat,
  customFilename: string,
  total: number,
): string {
  const requested = cleanDashboardDownloadFilename(customFilename);
  const base = requested
    ? total > 1
      ? cleanDashboardDownloadFilename(`${requested} - ${dashboardName}`)
      : requested
    : cleanDashboardDownloadFilename(dashboardName || 'dashboard');
  return `${base || 'dashboard'}.${DASHBOARD_DOWNLOAD_EXTENSIONS[format]}`;
}

export function parseDashboardDownloadFilterValues(raw: string): unknown[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildDashboardDownloadFilterConfig(
  filters: DashboardFilter[] = [],
  valuesByField: DashboardDownloadFilterState = {},
): Record<string, FilterOverride> | undefined {
  const out: Record<string, FilterOverride> = {};
  for (const filter of filters) {
    const raw = valuesByField[filter.field] || '';
    const values = parseDashboardDownloadFilterValues(raw);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanSummaryText(value: unknown): string {
  return Array.from(String(value ?? ''), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function summarizeFilterField(field: string): string {
  const label = field.split('.').pop() || field;
  return label
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function summarizeDashboardDownloadFilters(request: unknown, maxFilters = 3): string {
  if (!isRecord(request) || !isRecord(request.filterConfig)) return '';
  const entries = Object.entries(request.filterConfig)
    .map(([fieldKey, raw]) => {
      if (!isRecord(raw)) return '';
      const field = cleanSummaryText(raw.field || fieldKey);
      const values = Array.isArray(raw.values)
        ? raw.values.map(cleanSummaryText).filter(Boolean)
        : [];
      if (!field || values.length === 0) return '';
      return `${summarizeFilterField(field)}: ${values.slice(0, 3).join(', ')}${values.length > 3 ? ` +${values.length - 3} more` : ''}`;
    })
    .filter(Boolean);
  if (entries.length === 0) return '';
  const visible = entries.slice(0, maxFilters);
  return `${visible.join('; ')}${entries.length > maxFilters ? `; +${entries.length - maxFilters} more` : ''}`;
}

export function parseDashboardDownloadJobId(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.job_id || record.jobId || record.id || record.download_job_id || '');
  }
  if (typeof value !== 'string') return '';
  try {
    return parseDashboardDownloadJobId(JSON.parse(value));
  } catch {
    const match = value.match(/"?(?:job_id|jobId|download_job_id)"?\s*[:=]\s*"([^"]+)"/i);
    return match?.[1] || '';
  }
}

export function dashboardDownloadStatusVariant(status: DashboardDownloadQueueStatus) {
  if (status === 'done') return 'success';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'queued') return 'pending';
  if (status === 'attached') return 'warning';
  return 'in_progress';
}

export function availableDashboardDownloadFormats(scope: DashboardDownloadScope): DashboardDownloadFormat[] {
  return scope === 'tile'
    ? ['pdf', 'png', 'csv', 'xlsx', 'json']
    : ['pdf', 'png', 'csv', 'xlsx'];
}

export function buildDashboardDownloadRequest(input: DashboardDownloadBuildInput): DashboardDownloadRequest {
  const { dashboardId, dashboardName, details, filterValues, options, total } = input;
  const body: Record<string, unknown> = { format: options.format };
  const warnings: string[] = [];
  const filterConfig = buildDashboardDownloadFilterConfig(details?.filters || [], filterValues);
  const filename = buildDashboardDownloadFilename(dashboardName, options.format, options.customFilename, total);
  const filenameBase = filename.replace(/\.[^.]+$/, '').slice(0, 255);

  if (options.scope === 'dashboard' && options.format === 'json') {
    throw new Error('JSON downloads require single-tile mode.');
  }

  if (filterConfig) body.filterConfig = filterConfig;
  if (options.customFilename.trim()) body.filename = filenameBase;

  let tileName: string | undefined;
  if (options.scope === 'tile') {
    const tile = (details?.tiles || []).find((candidate) => candidate.queryIdentifierMapKey === options.selectedTileKey);
    if (!tile?.queryIdentifierMapKey) throw new Error('Choose a downloadable tile before exporting.');
    body.queryIdentifierMapKey = tile.queryIdentifierMapKey;
    tileName = tile.name;
  }

  if (options.format === 'pdf') {
    body.paperFormat = options.paperFormat;
    body.paperOrientation = options.orientation;
    body.showFilters = options.showFilters;
    if (options.hideTitle) body.hideTitle = true;
    if (options.expandTables) body.expandTablesToShowAllRows = true;
    if (options.singleColumnLayout) body.singleColumnLayout = true;
  }

  if (options.format === 'png') {
    body.showFilters = options.showFilters;
    if (options.hideTitle) body.hideTitle = true;
    if (options.expandTables) body.expandTablesToShowAllRows = true;
    if (options.singleColumnLayout) body.singleColumnLayout = true;
    if (filterConfig) warnings.push('Omni PNG exports may ignore filter overrides; verify the rendered file before sharing.');
  }

  if (options.format === 'csv' || options.format === 'xlsx' || options.format === 'json') {
    body.enableFormatting = options.enableFormatting;
    if (options.hideHiddenFields) body.hideHiddenFields = true;
    const maxRows = Number.parseInt(options.maxRowLimit, 10);
    if (options.overrideRowLimit && Number.isFinite(maxRows) && maxRows > 0) {
      if (options.format === 'xlsx' && options.scope !== 'tile') {
        throw new Error('XLSX row-limit overrides require single-tile mode with a downloadable tile.');
      }
      body.overrideRowLimit = true;
      body.maxRowLimit = maxRows;
    }
  }

  return {
    dashboardId,
    dashboardName,
    format: options.format,
    scope: options.scope,
    body,
    filename,
    tileName,
    warnings,
  };
}
