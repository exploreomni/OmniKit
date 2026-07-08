import type { DashboardTile, FilterOverride, TileColumn, TileResult } from './types';

export interface TileQuerySummary {
  kind: 'query' | 'markdown' | 'unsupported';
  modelId?: string;
  topic?: string;
  fields: string[];
  filters: string[];
  sorts: string[];
  limit?: number;
  queryPath?: string;
  advancedJson?: string;
  message?: string;
}

export interface InsightDigest {
  text: string;
  empty: boolean;
  rowCount: number;
  sampledRowCount: number;
  truncated: boolean;
  budgetTruncated: boolean;
  samplingNote?: string;
  modelId?: string;
  topic?: string;
  visualKind: string;
  aggregates: Array<{
    field: string;
    label: string;
    count: number;
    min: number;
    max: number;
    sum: number;
    average: number;
  }>;
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passphrase|authorization|auth)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeQueryBody(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.modelId === 'string' || typeof value.model_id === 'string') return true;
  if (Array.isArray(value.fields) && value.fields.length > 0) return true;
  return false;
}

function extractQueryBody(raw: Record<string, unknown> | undefined): { body: Record<string, unknown>; path: string } | null {
  if (!raw) return null;
  const candidates: Array<{ path: string; value: unknown }> = [
    { path: 'query', value: raw.query },
    { path: 'queryShare.query', value: isRecord(raw.queryShare) ? raw.queryShare.query : undefined },
    { path: 'queryPresentation.query', value: isRecord(raw.queryPresentation) ? raw.queryPresentation.query : undefined },
    { path: 'queryBody', value: raw.queryBody },
    { path: 'query_body', value: raw.query_body },
    { path: 'tileQuery', value: raw.tileQuery },
    { path: 'workbook.query', value: isRecord(raw.workbook) ? raw.workbook.query : undefined },
    { path: '<self>', value: raw },
  ];
  for (const candidate of candidates) {
    if (looksLikeQueryBody(candidate.value)) return { body: candidate.value, path: candidate.path };
  }
  return null;
}

function compactText(value: unknown, maxLength = 80): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function fieldLabel(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  const field =
    value.field ||
    value.name ||
    value.id ||
    value.column ||
    value.columnName ||
    value.column_name ||
    value.fieldName ||
    value.field_name;
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function summarizeFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(fieldLabel).filter((field): field is string => Boolean(field));
}

function summarizeFilters(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!isRecord(entry)) return compactText(entry);
      const field = fieldLabel(entry) || 'filter';
      const rawValues = entry.values ?? entry.value ?? entry.defaultValue ?? entry.default_value;
      const operator = compactText(entry.kind || entry.type || entry.operator || entry.op, 32);
      const values = compactText(rawValues, 80);
      return [field, operator, values].filter(Boolean).join(' ');
    }).filter(Boolean);
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([field, meta]) => {
      if (!isRecord(meta)) return `${field}: ${compactText(meta)}`;
      const operator = compactText(meta.kind || meta.type || meta.operator || meta.op, 32);
      const rawValues = meta.values ?? meta.value ?? meta.defaultValue ?? meta.default_value;
      const values = compactText(rawValues, 80);
      return `${field}${operator ? ` ${operator}` : ''}${values ? ` ${values}` : ''}`;
    });
  }
  return [compactText(value)];
}

function summarizeSorts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!isRecord(entry)) return compactText(entry);
    const field = fieldLabel(entry) || 'sort';
    const direction = compactText(entry.direction || entry.dir || entry.desc || entry.ascending, 24);
    return [field, direction].filter(Boolean).join(' ');
  }).filter(Boolean);
}

function pickLimit(body: Record<string, unknown>): number | undefined {
  const raw = body.limit ?? body.rowLimit ?? body.row_limit;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeForPreview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForPreview);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : sanitizeForPreview(child);
  }
  return out;
}

function safeAdvancedJson(body: Record<string, unknown>): string {
  try {
    return JSON.stringify(sanitizeForPreview(body), null, 2);
  } catch {
    return '{}';
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function compactCellValue(key: string, value: unknown, maxLength = 96): string {
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  return compactText(sanitizeForPreview(value), maxLength);
}

function columnLabel(column: TileColumn): string {
  return column.label || column.name;
}

function columnLooksNumeric(column: TileColumn, rows: Array<Record<string, unknown>>): boolean {
  const type = (column.type || '').toLowerCase();
  if (/number|int|float|double|decimal|numeric|bigint|long/.test(type)) return true;
  return rows.some((row) => typeof row[column.name] === 'number' && Number.isFinite(row[column.name] as number));
}

function sampleRows(rows: Array<Record<string, unknown>>, maxRows: number): Array<Record<string, unknown>> {
  if (rows.length <= maxRows) return rows;
  if (maxRows <= 1) return rows.slice(0, 1);
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  for (let i = 0; i < maxRows; i += 1) {
    const index = Math.round((i * (rows.length - 1)) / (maxRows - 1));
    if (!seen.has(index)) {
      seen.add(index);
      out.push(rows[index]);
    }
  }
  return out;
}

function summarizeFilterOverrides(filters: Record<string, FilterOverride> | undefined): string[] {
  if (!filters) return [];
  return Object.entries(filters).map(([field, filter]) => {
    const values = compactCellValue(field, filter.values, 120);
    const operator = filter.kind || filter.type || 'filter';
    return `${field} ${operator} ${values}`.trim();
  });
}

function buildMeasureAggregates(result: TileResult) {
  return result.columns
    .filter((column) => !SECRET_KEY_RE.test(column.name) && columnLooksNumeric(column, result.rows))
    .map((column) => {
      const values = result.rows
        .map((row) => row[column.name])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (values.length === 0) return null;
      const sum = values.reduce((acc, value) => acc + value, 0);
      return {
        field: column.name,
        label: columnLabel(column),
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        sum,
        average: sum / values.length,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

export function buildInsightDigest({
  tile,
  result,
  filters,
  visualKind,
  dashboardName,
  maxRows = 30,
  maxDigestChars = 8000,
}: {
  tile: DashboardTile;
  result: TileResult;
  filters?: Record<string, FilterOverride>;
  visualKind?: string;
  dashboardName?: string;
  maxRows?: number;
  maxDigestChars?: number;
}): InsightDigest {
  const query = summarizeTileQuery(tile);
  const boundedMaxRows = Math.max(1, Math.min(50, Math.floor(maxRows)));
  const sampledRows = sampleRows(result.rows, boundedMaxRows);
  const safeColumns = result.columns.filter((column) => !SECRET_KEY_RE.test(column.name) && !SECRET_KEY_RE.test(column.label || ''));
  const truncated = result.rows.length > sampledRows.length;
  const samplingNote = truncated
    ? `Showing ${sampledRows.length} evenly sampled rows of ${result.rows.length}.`
    : undefined;
  const aggregates = buildMeasureAggregates(result);
  const filterLines = Array.from(new Set([
    ...query.filters,
    ...summarizeFilterOverrides(filters),
  ])).slice(0, 20);

  const lines: string[] = [
    `Dashboard: ${dashboardName || 'Untitled dashboard'}`,
    `Tile: ${tile.name || tile.id}`,
    `Visual kind: ${visualKind || result.renderKind}`,
    query.modelId ? `Model ID: ${query.modelId}` : '',
    query.topic ? `Topic: ${query.topic}` : '',
    `Rows: ${result.rows.length}`,
    samplingNote || '',
    `Columns: ${safeColumns.map((column) => `${columnLabel(column)} (${column.name}, ${column.type || 'unknown'})`).join('; ') || 'none'}`,
    filterLines.length > 0 ? `Filters: ${filterLines.join('; ')}` : 'Filters: none detected',
  ].filter(Boolean);

  if (result.rows.length === 0) {
    lines.push('No rows are available for this tile result. Do not invent a trend or conclusion.');
  } else {
    if (aggregates.length > 0) {
      lines.push('Measure aggregates:');
      for (const aggregate of aggregates.slice(0, 12)) {
        lines.push(
          `- ${aggregate.label}: count ${aggregate.count}, min ${formatNumber(aggregate.min)}, max ${formatNumber(aggregate.max)}, sum ${formatNumber(aggregate.sum)}, avg ${formatNumber(aggregate.average)}`
        );
      }
    }
    lines.push('Sample rows:');
    sampledRows.forEach((row, rowIndex) => {
      const cells = safeColumns.slice(0, 12).map((column) => {
        return `${columnLabel(column)}=${compactCellValue(column.name, row[column.name])}`;
      });
      lines.push(`${rowIndex + 1}. ${cells.join('; ')}`);
    });
  }

  const rawText = lines.join('\n');
  const budget = Math.max(1000, Math.floor(maxDigestChars));
  const budgetNote = '\nDigest truncated to stay within Omni AI prompt budget.';
  const budgetTruncated = rawText.length > budget;
  const text = budgetTruncated
    ? `${rawText.slice(0, Math.max(0, budget - budgetNote.length)).replace(/\n[^\n]*$/, '')}${budgetNote}`
    : rawText;

  return {
    text,
    empty: result.rows.length === 0,
    rowCount: result.rows.length,
    sampledRowCount: sampledRows.length,
    truncated,
    budgetTruncated,
    samplingNote,
    modelId: query.modelId,
    topic: query.topic,
    visualKind: visualKind || result.renderKind,
    aggregates,
  };
}

export function summarizeTileQuery(tile: DashboardTile): TileQuerySummary {
  if (tile.markdown || /markdown|text/i.test(tile.tileType || '')) {
    return {
      kind: 'markdown',
      fields: [],
      filters: [],
      sorts: [],
      message: 'This is a text tile, so there is no native data query to review.',
    };
  }

  const extracted = extractQueryBody(tile.rawQuery);
  if (!extracted) {
    return {
      kind: 'unsupported',
      fields: [],
      filters: [],
      sorts: [],
      message: 'OmniKit could not find a reusable native query payload for this tile.',
    };
  }

  const { body, path } = extracted;
  const modelId = typeof body.modelId === 'string' ? body.modelId : typeof body.model_id === 'string' ? body.model_id : undefined;
  const topic =
    typeof body.topic === 'string' ? body.topic :
    typeof body.topicName === 'string' ? body.topicName :
    typeof body.topic_name === 'string' ? body.topic_name :
    undefined;
  const fields = summarizeFields(body.fields);
  const filters = summarizeFilters(body.filters);
  const sorts = summarizeSorts(body.sorts || body.orderBy || body.order_by);

  return {
    kind: 'query',
    modelId,
    topic,
    fields,
    filters,
    sorts,
    limit: pickLimit(body),
    queryPath: path,
    advancedJson: safeAdvancedJson(body),
  };
}
