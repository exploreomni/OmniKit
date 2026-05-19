import { tableFromIPC } from 'apache-arrow';
import { omniProxy } from '@/services/omniApi';
import { deckLog, describeError } from './log';
import type { DashboardTile, FilterOverride, TileColumn, TileResult, TileRenderKind } from './types';

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function arrowTypeToColumnType(typeStr: string): TileColumn['type'] {
  const t = typeStr.toLowerCase();
  if (/int|float|decimal|double|long|short|byte|uint/.test(t)) return 'number';
  if (/timestamp|date|time/.test(t)) return 'date';
  if (/bool/.test(t)) return 'string';
  return 'string';
}

function coerceArrowValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array || v instanceof Int8Array) {
    return Array.from(v as Iterable<number>);
  }
  if (typeof v === 'object') {
    const maybe = v as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === 'function') {
      try {
        const j = maybe.toJSON();
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(j as Record<string, unknown>)) {
            out[k] = coerceArrowValue(val);
          }
          return out;
        }
        return j;
      } catch {
        // fall through
      }
    }
  }
  return v;
}

function decodeArrowResult(
  base64: string,
  scope: string
): { columns: TileColumn[]; rows: Array<Record<string, unknown>> } | null {
  try {
    const bytes = base64ToUint8Array(base64);
    const table = tableFromIPC(bytes);
    const columns: TileColumn[] = table.schema.fields.map((f) => ({
      name: f.name,
      type: arrowTypeToColumnType(String(f.type)),
    }));
    const rawRows = table.toArray();
    const rows: Array<Record<string, unknown>> = rawRows.map((r) => {
      const plain: Record<string, unknown> = {};
      for (const col of columns) {
        plain[col.name] = coerceArrowValue((r as Record<string, unknown>)[col.name]);
      }
      return plain;
    });
    deckLog.info(scope, 'Arrow IPC decoded', {
      rowCount: rows.length,
      columns: columns.map((c) => `${c.name}:${c.type ?? 'string'}`),
    });
    return { columns, rows };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deckLog.warn(scope, 'Arrow IPC decode failed', {
      error: msg,
      base64Length: base64.length,
    });
    return null;
  }
}

interface RawQueryResponse {
  result?: { columns?: unknown; rows?: unknown; data?: unknown };
  data?: unknown;
  rows?: unknown;
  columns?: unknown;
  fields?: unknown;
  schema?: unknown;
  raw?: unknown;
  summary?: unknown;
}

function parseNdjson(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return out;
}

const NUMERIC_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'long']);
const DATE_TYPES = new Set(['date', 'timestamp', 'datetime', 'time']);
const MAX_TABLE_ROWS = 30;
const MAX_TABLE_COLS = 8;
const RUN_ROW_LIMIT = 200;
const FIELD_TRANSFORM_SUFFIX_RE = /\[[^\]]+\]$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function looksLikeQueryBody(v: unknown): v is Record<string, unknown> {
  if (!isObject(v)) return false;
  if (typeof v.modelId === 'string' || typeof v.model_id === 'string') return true;
  if (Array.isArray(v.fields) && (v.fields as unknown[]).length > 0) return true;
  return false;
}

interface ExtractedQuery {
  body: Record<string, unknown>;
  path: string;
}

function extractQueryBody(raw: Record<string, unknown> | undefined): ExtractedQuery | null {
  if (!raw) return null;
  const candidates: Array<{ path: string; getter: () => unknown }> = [
    { path: 'query', getter: () => raw.query },
    { path: 'queryShare.query', getter: () => (raw.queryShare as Record<string, unknown> | undefined)?.query },
    { path: 'queryPresentation.query', getter: () => (raw.queryPresentation as Record<string, unknown> | undefined)?.query },
    { path: 'queryBody', getter: () => raw.queryBody },
    { path: 'query_body', getter: () => raw.query_body },
    { path: 'tileQuery', getter: () => raw.tileQuery },
    { path: 'workbook.query', getter: () => (raw.workbook as Record<string, unknown> | undefined)?.query },
    { path: '<self>', getter: () => raw },
  ];
  for (const c of candidates) {
    const v = c.getter();
    if (looksLikeQueryBody(v)) return { body: v, path: c.path };
  }
  return null;
}

const DROP_KEYS = new Set([
  'id',
  'queryId',
  'query_id',
  'tileId',
  'tile_id',
  'documentId',
  'document_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'name',
  'title',
  'displayTitle',
  'display_name',
  'position',
  'order',
  'section',
  'group_name',
  'type',
  'tileType',
  'kind',
]);

function buildRunPayload(extracted: Record<string, unknown>): {
  payload: Record<string, unknown>;
  droppedKeys: string[];
} {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(extracted)) {
    if (DROP_KEYS.has(k)) {
      dropped.push(k);
      continue;
    }
    if (v === undefined) continue;
    out[k] = v;
  }
  if (out.modelId === undefined && typeof extracted.model_id === 'string') {
    out.modelId = extracted.model_id;
  }
  if (typeof out.limit !== 'number' || (out.limit as number) > RUN_ROW_LIMIT) {
    out.limit = RUN_ROW_LIMIT;
  }
  return { payload: out, droppedKeys: dropped };
}

function normalizeRunFieldRef(field: string): string {
  return field.replace(FIELD_TRANSFORM_SUFFIX_RE, '');
}

function normalizeRunFieldRefs(value: unknown, changed: Set<string>): unknown {
  if (typeof value === 'string') {
    const next = normalizeRunFieldRef(value);
    if (next !== value) changed.add(value);
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRunFieldRefs(item, changed));
  }
  return value;
}

function normalizeSortRefs(value: unknown, changed: Set<string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((sort) => {
    if (!isObject(sort)) return normalizeRunFieldRefs(sort, changed);
    const next = { ...sort };
    for (const key of ['field', 'fieldName', 'field_name', 'column_name', 'columnName']) {
      if (typeof next[key] === 'string') {
        const normalized = normalizeRunFieldRef(next[key] as string);
        if (normalized !== next[key]) changed.add(next[key] as string);
        next[key] = normalized;
      }
    }
    return next;
  });
}

function normalizeFilterRefs(value: unknown, changed: Set<string>): unknown {
  if (!isObject(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(value)) {
    const normalized = normalizeRunFieldRef(field);
    if (normalized !== field) changed.add(field);
    next[normalized] = raw;
  }
  return next;
}

function normalizeRunPayloadRefs(payload: Record<string, unknown>, scope: string): Record<string, unknown> {
  const changed = new Set<string>();
  const next = { ...payload };
  for (const key of ['fields', 'pivots', 'groupBy', 'group_by']) {
    if (key in next) next[key] = normalizeRunFieldRefs(next[key], changed);
  }
  for (const key of ['sorts', 'order_by', 'orderBy']) {
    if (key in next) next[key] = normalizeSortRefs(next[key], changed);
  }
  if ('filters' in next) next.filters = normalizeFilterRefs(next.filters, changed);

  if (changed.size > 0) {
    deckLog.warn(scope, 'Normalized UI-decorated field reference(s) for native query replay', {
      fields: Array.from(changed),
    });
  }
  return next;
}

function extractMissingField(message: string): string | null {
  const patterns = [
    /No such field\s+"([^"]+)"/i,
    /No such field\s+'([^']+)'/i,
    /field\s+"([^"]+)"\s+does not exist/i,
    /unknown field\s+"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function removeFieldFromArray(value: unknown, field: string): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };
  let changed = false;
  const next = value.filter((item) => {
    if (typeof item === 'string' && item === field) {
      changed = true;
      return false;
    }
    return true;
  }).map((item) => {
    if (!isObject(item)) return item;
    let localChanged = false;
    const nextItem = { ...item };
    for (const key of ['field', 'fieldName', 'field_name', 'column_name', 'columnName']) {
      if (nextItem[key] === field) {
        localChanged = true;
        changed = true;
      }
    }
    return localChanged ? null : nextItem;
  }).filter((item) => item !== null);
  return { value: next, changed };
}

function removeMissingFieldFromPayload(
  payload: Record<string, unknown>,
  missingField: string,
  scope: string,
): { payload: Record<string, unknown>; changed: boolean } {
  const candidates = Array.from(new Set([missingField, normalizeRunFieldRef(missingField)]));
  let next = { ...payload };
  let changed = false;

  for (const field of candidates) {
    for (const key of ['fields', 'pivots', 'groupBy', 'group_by', 'sorts', 'order_by', 'orderBy']) {
      if (!(key in next)) continue;
      const removed = removeFieldFromArray(next[key], field);
      if (removed.changed) {
        next = { ...next, [key]: removed.value };
        changed = true;
      }
    }
    if (isObject(next.filters) && field in next.filters) {
      const filters = { ...next.filters };
      delete filters[field];
      next = { ...next, filters };
      changed = true;
    }
  }

  if (changed) {
    deckLog.warn(scope, 'Removed field Omni no longer recognizes before retrying native query replay', {
      missingField,
    });
  }
  return { payload: next, changed };
}

type RunShape = 'wrapped' | 'flat';
let cachedRunShape: RunShape | null = null;

function sanitizePayloadForLog(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) {
      out[k] = `array(${v.length})`;
    } else if (v && typeof v === 'object') {
      out[k] = `object(${Object.keys(v as Record<string, unknown>).length} keys)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeColumns(raw: unknown): TileColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    if (typeof c === 'string') return { name: c };
    if (isObject(c)) {
      const name =
        (typeof c.name === 'string' && c.name) ||
        (typeof c.field === 'string' && c.field) ||
        (typeof c.id === 'string' && c.id) ||
        `col_${i}`;
      const label =
        (typeof c.label === 'string' && c.label) ||
        (typeof c.displayName === 'string' && c.displayName) ||
        (typeof c.title === 'string' && c.title) ||
        undefined;
      const type =
        (typeof c.type === 'string' && c.type.toLowerCase()) ||
        (typeof c.dataType === 'string' && c.dataType.toLowerCase()) ||
        (typeof c.fieldType === 'string' && c.fieldType.toLowerCase()) ||
        undefined;
      return { name, label, type };
    }
    return { name: `col_${i}` };
  });
}

function normalizeRows(raw: unknown, columns: TileColumn[]): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    if (Array.isArray(r)) {
      const o: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        o[c.name] = r[i];
      });
      return o;
    }
    if (isObject(r)) return r;
    return {};
  });
}

function inferColumnsFromRows(rows: Array<Record<string, unknown>>): TileColumn[] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]);
  return keys.map((k) => {
    const sample = rows.slice(0, 20).map((r) => r[k]);
    const numericish = sample.every((v) => v == null || typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v.trim() !== ''));
    const datelike = sample.every((v) => {
      if (v == null) return true;
      if (typeof v !== 'string') return false;
      return /^\d{4}-\d{2}/.test(v);
    });
    return { name: k, type: datelike ? 'date' : numericish ? 'number' : 'string' };
  });
}

function classifyRender(columns: TileColumn[], rows: Array<Record<string, unknown>>): TileRenderKind {
  if (rows.length === 0) return 'empty';
  if (rows.length === 1 && columns.length === 1) {
    const v = rows[0][columns[0].name];
    if (typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)))) return 'kpi';
  }
  const numericCols = columns.filter((c) => c.type && NUMERIC_TYPES.has(c.type));
  const nonNumericCols = columns.filter((c) => !c.type || !NUMERIC_TYPES.has(c.type));
  const hasDimension = nonNumericCols.length >= 1;

  if (hasDimension && numericCols.length >= 1 && rows.length <= 50 && rows.length >= 2 && columns.length <= 6) {
    const dim = nonNumericCols[0];
    if (dim.type && DATE_TYPES.has(dim.type)) return 'line';
    if (rows.length <= 6 && numericCols.length === 1) return 'pie';
    return 'bar';
  }

  return 'table';
}

function parseQueryResponse(
  body: RawQueryResponse,
  scope: string
): { columns: TileColumn[]; rows: Array<Record<string, unknown>> } | null {
  if (typeof body.raw === 'string') {
    const rawText = body.raw;
    deckLog.info(scope, 'Run response is non-JSON text, attempting NDJSON parse', {
      length: rawText.length,
      preview: rawText.slice(0, 500),
      tail: rawText.length > 500 ? rawText.slice(-200) : undefined,
    });
    const parts = parseNdjson(rawText);
    deckLog.info(scope, 'NDJSON parts parsed', {
      count: parts.length,
      partKeys: parts.slice(0, 5).map((p) => Object.keys(p)),
      firstPart: parts[0],
    });

    const failedPart = parts.find(
      (p) => (p as { status?: unknown }).status === 'FAILED'
    ) as { error_message?: unknown; error_type?: unknown } | undefined;
    if (failedPart) {
      const msg =
        (typeof failedPart.error_message === 'string' && failedPart.error_message) ||
        (typeof failedPart.error_type === 'string' && failedPart.error_type) ||
        'Query failed';
      deckLog.warn(scope, 'Omni query job FAILED; attempting repair or image fallback', {
        errorType: typeof failedPart.error_type === 'string' ? failedPart.error_type : undefined,
        errorMessage: msg,
      });
      throw new Error(`Omni query failed: ${msg}`);
    }

    const completePart = parts.find(
      (p) =>
        (p as { status?: unknown }).status === 'COMPLETE' &&
        typeof (p as { result?: unknown }).result === 'string'
    );
    if (completePart) {
      const sql = (completePart as { summary?: { display_sql?: unknown } }).summary?.display_sql;
      if (typeof sql === 'string') {
        deckLog.info(scope, 'Decoding Arrow IPC result', { sqlPreview: sql.slice(0, 200) });
      }
      const decoded = decodeArrowResult(
        (completePart as { result: string }).result,
        scope
      );
      if (decoded) return decoded;
    }

    let columns: TileColumn[] = [];
    const rows: Array<Record<string, unknown>> = [];
    for (const p of parts) {
      const fieldsArr =
        (Array.isArray((p as { fields?: unknown }).fields) && (p as { fields: unknown[] }).fields) ||
        (Array.isArray((p as { columns?: unknown }).columns) && (p as { columns: unknown[] }).columns) ||
        (Array.isArray((p as { schema?: unknown }).schema) && (p as { schema: unknown[] }).schema);
      if (fieldsArr && columns.length === 0) {
        columns = normalizeColumns(fieldsArr);
      }
      const rowsArr =
        (Array.isArray((p as { rows?: unknown }).rows) && (p as { rows: unknown[] }).rows) ||
        (Array.isArray((p as { data?: unknown }).data) && (p as { data: unknown[] }).data) ||
        (Array.isArray((p as { result?: unknown }).result) && (p as { result: unknown[] }).result);
      if (rowsArr) {
        rows.push(...normalizeRows(rowsArr, columns));
        continue;
      }
      const single = (p as { row?: unknown }).row;
      if (single && typeof single === 'object' && !Array.isArray(single)) {
        rows.push(single as Record<string, unknown>);
        continue;
      }
      const ignoredKeys = new Set([
        'summary', 'meta', 'error', 'progress', 'status', 'metadata',
        'fields', 'columns', 'schema', 'sql', 'cache_status', 'remote_results_url',
      ]);
      const keys = Object.keys(p);
      if (keys.length > 0 && keys.some((k) => !ignoredKeys.has(k))) {
        const allScalar = keys.every((k) => {
          const v = p[k];
          return v === null || ['string', 'number', 'boolean'].includes(typeof v);
        });
        if (allScalar) rows.push(p);
      }
    }
    if (columns.length === 0 && rows.length > 0) {
      columns = inferColumnsFromRows(rows);
    }
    if (columns.length > 0 || rows.length > 0) {
      return { columns, rows };
    }
    deckLog.warn(scope, 'NDJSON yielded no columns or rows');
  }

  const candidates: Array<{ cols?: unknown; rows?: unknown }> = [
    { cols: body.columns, rows: body.rows },
    { cols: body.fields, rows: body.rows },
    { cols: body.schema, rows: body.rows },
    { cols: body.result?.columns, rows: body.result?.rows },
    { cols: body.result?.columns, rows: body.result?.data },
    { cols: body.columns, rows: body.data },
    { cols: undefined, rows: body.data },
    { cols: undefined, rows: body.rows },
  ];

  for (const c of candidates) {
    if (Array.isArray(c.rows)) {
      let cols = normalizeColumns(c.cols);
      const rows = normalizeRows(c.rows, cols);
      if (cols.length === 0) cols = inferColumnsFromRows(rows);
      if (cols.length > 0 || rows.length > 0) return { columns: cols, rows };
    }
  }
  return null;
}

export interface RunTileQueryResult {
  result: TileResult;
  payloadUsed: Record<string, unknown>;
  bodyPath: string;
}

function isMarkdownTile(tile: DashboardTile): boolean {
  if (tile.markdown && tile.markdown.trim().length > 0) return true;
  const t = tile.tileType?.toLowerCase();
  return t === 'markdown' || t === 'text' || t === 'note';
}

export function normalizeFilterType(input: string | undefined): string {
  if (!input) return 'string';
  const t = input.toLowerCase().trim();
  if (t === 'timeframe' || t === 'date_range' || t === 'daterange') return 'date';
  if (t === 'string' || t === 'text' || t === 'varchar' || t === 'char') return 'string';
  if (t === 'number' || t === 'integer' || t === 'int' || t === 'bigint' || t === 'long' ||
      t === 'float' || t === 'double' || t === 'decimal' || t === 'numeric') return 'number';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'date' || t === 'datetime' || t === 'timestamp' || t === 'time') return 'date';
  const known = new Set(['bind', 'boolean', 'composite', 'date', 'null', 'number', 'query', 'string', 'user_attribute']);
  if (known.has(t)) return t;
  return 'string';
}

function normalizeFilterKind(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  return value || 'EQUALS';
}

function isUnsupportedRunFilterKind(kind: string): boolean {
  // Dashboard controls can expose UI-only timeframe filters. /v1/query/run
  // validates filter kinds against field-type enums and rejects TIMEFRAME, so
  // native deck export should skip those controls instead of failing the deck.
  return kind.toUpperCase() === 'TIMEFRAME';
}

function sanitizeRunFilters(
  filters: Record<string, unknown>,
  scope: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [field, raw] of Object.entries(filters)) {
    if (isObject(raw) && isUnsupportedRunFilterKind(normalizeFilterKind(raw.kind))) {
      removed.push(field);
      continue;
    }
    next[field] = raw;
  }
  if (removed.length > 0) {
    deckLog.warn(scope, 'Skipped unsupported dashboard timeframe filter(s) for native query export', {
      fields: removed,
    });
  }
  return next;
}

function inferFilterTypeForKind(
  type: string | undefined,
  kind: string,
  field: string,
  values: unknown[],
): string {
  const normalized = normalizeFilterType(type);
  const upperKind = kind.toUpperCase();
  const dateKind =
    upperKind.includes('TIMEFRAME') ||
    upperKind.includes('DATE') ||
    upperKind === 'BETWEEN' ||
    upperKind === 'RANGE';
  if (dateKind) return 'date';

  if (normalized !== 'string') return normalized;

  const lowerField = field.toLowerCase();
  const fieldLooksTemporal =
    lowerField.endsWith('_at') ||
    lowerField.endsWith('_date') ||
    lowerField.includes('date') ||
    lowerField.includes('time');
  const valueLooksTemporal = values.some((value) => {
    const raw = String(value ?? '').trim().toLowerCase();
    return (
      /^\d{4}-\d{2}-\d{2}/.test(raw) ||
      raw.includes('day') ||
      raw.includes('week') ||
      raw.includes('month') ||
      raw.includes('quarter') ||
      raw.includes('year')
    );
  });

  return fieldLooksTemporal && valueLooksTemporal ? 'date' : normalized;
}

function collectTileViewPrefixes(payload: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const fields = payload.fields;
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (typeof f === 'string' && f.includes('.')) out.add(f.split('.')[0]);
    }
  }
  const filters = payload.filters;
  if (isObject(filters)) {
    for (const k of Object.keys(filters)) {
      if (k.includes('.')) out.add(k.split('.')[0]);
    }
  }
  for (const key of ['table', 'topic', 'topicName', 'topic_name', 'join_paths_from_topic_name']) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) out.add(v);
  }
  return out;
}

function applyFilterOverrides(
  payload: Record<string, unknown>,
  overrides: Record<string, FilterOverride> | undefined,
  scope: string
): Record<string, unknown> {
  if (!overrides || Object.keys(overrides).length === 0) return payload;
  const existing = isObject(payload.filters)
    ? sanitizeRunFilters({ ...payload.filters as Record<string, unknown> }, scope)
    : {};
  const viewPrefixes = collectTileViewPrefixes(payload);
  const applied: string[] = [];
  const skipped: string[] = [];
  const unsupported: string[] = [];
  for (const [field, override] of Object.entries(overrides)) {
    const viewPrefix = field.includes('.') ? field.split('.')[0] : undefined;
    const alreadyFiltered = field in existing;
    const compatible =
      alreadyFiltered ||
      !viewPrefix ||
      viewPrefixes.size === 0 ||
      viewPrefixes.has(viewPrefix);
    if (!compatible) {
      skipped.push(field);
      continue;
    }
    const base = isObject(existing[field]) ? (existing[field] as Record<string, unknown>) : {};
    const baseType = typeof base.type === 'string' ? base.type : undefined;
    const kind = normalizeFilterKind(override.kind ?? base.kind);
    if (isUnsupportedRunFilterKind(kind)) {
      delete existing[field];
      unsupported.push(field);
      continue;
    }
    const values = override.values;
    existing[field] = {
      ...base,
      kind,
      type: inferFilterTypeForKind(override.type ?? baseType, kind, field, values),
      values,
      is_negative: override.isNegative ?? base.is_negative ?? false,
    };
    applied.push(field);
  }
  if (applied.length > 0) {
    deckLog.info(scope, `Applied ${applied.length} filter override(s)`, { fields: applied });
  }
  if (skipped.length > 0) {
    deckLog.warn(scope, `Skipped ${skipped.length} incompatible filter override(s) (field not on tile's topic)`, {
      fields: skipped,
      tileViews: Array.from(viewPrefixes),
    });
  }
  if (unsupported.length > 0) {
    deckLog.warn(scope, 'Skipped unsupported dashboard timeframe override(s) for native query export', {
      fields: unsupported,
    });
  }
  return { ...payload, filters: existing };
}

export async function runTileQuery(
  baseUrl: string,
  apiKey: string,
  _dashboardId: string,
  tile: DashboardTile,
  signal?: AbortSignal,
  filterOverrides?: Record<string, FilterOverride>
): Promise<RunTileQueryResult> {
  const scope = `query:${tile.id.slice(0, 8)}`;

  if (isMarkdownTile(tile)) {
    deckLog.info(scope, 'Tile is markdown/text', { tileType: tile.tileType });
    return {
      result: {
        columns: [{ name: 'markdown' }],
        rows: [{ markdown: tile.markdown ?? '' }],
        rowCount: 1,
        truncated: false,
        renderKind: 'markdown',
      },
      payloadUsed: {},
      bodyPath: 'markdown',
    };
  }

  const extracted = extractQueryBody(tile.rawQuery);
  if (!extracted) {
    deckLog.warn(scope, 'No query body found on tile record', {
      keys: tile.rawQuery ? Object.keys(tile.rawQuery) : null,
    });
    return {
      result: {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        renderKind: 'unsupported',
      },
      payloadUsed: {},
      bodyPath: 'none',
    };
  }

  if (signal?.aborted) throw new Error('Query cancelled.');

  const { payload: basePayload, droppedKeys } = buildRunPayload(extracted.body);
  let payload = normalizeRunPayloadRefs(applyFilterOverrides(basePayload, filterOverrides, scope), scope);
  let response: RawQueryResponse | null = null;
  let parsed: { columns: TileColumn[]; rows: Array<Record<string, unknown>> } | null = null;
  const maxMissingFieldRepairs = 2;

  const runPayload = async (candidatePayload: Record<string, unknown>) => {
    deckLog.step(scope, `Running query via /v1/query/run`, {
      bodyPath: extracted.path,
      payloadKeys: Object.keys(candidatePayload),
      droppedKeys,
      modelId: candidatePayload.modelId,
      fieldCount: Array.isArray(candidatePayload.fields) ? (candidatePayload.fields as unknown[]).length : 0,
      sanitized: sanitizePayloadForLog(candidatePayload),
    });

    const wireBody = (shape: RunShape) =>
      shape === 'wrapped' ? { query: candidatePayload } : candidatePayload;

    const tryShape = async (shape: RunShape) =>
      omniProxy<RawQueryResponse>(baseUrl, apiKey, 'POST', '/v1/query/run', {
        body: wireBody(shape),
      });

    const order: RunShape[] = cachedRunShape
      ? [cachedRunShape, cachedRunShape === 'wrapped' ? 'flat' : 'wrapped']
      : ['wrapped', 'flat'];

    let runResponse: RawQueryResponse | null = null;
    const failures: string[] = [];
    for (const shape of order) {
      try {
        runResponse = await tryShape(shape);
        cachedRunShape = shape;
        deckLog.info(scope, `Run shape accepted`, { shape });
        break;
      } catch (err) {
        const e = describeError(err);
        failures.push(`shape=${shape}${e.status ? ` [HTTP ${e.status}]` : ''}: ${e.message}${e.detail ? ` | ${e.detail.slice(0, 200)}` : ''}`);
        deckLog.warn(scope, `Run shape ${shape} failed`, {
          status: e.status,
          message: e.message,
          detail: e.detail?.slice(0, 240),
        });
        if (e.status && e.status !== 400 && e.status !== 422) break;
      }
    }
    if (!runResponse) {
      throw new Error(`/v1/query/run failed for all shapes. ${failures.join(' || ')}`);
    }

    const responseRecord = runResponse as unknown as Record<string, unknown>;
    const rawField = responseRecord.raw;
    deckLog.info(scope, 'Run response keys', {
      keys: Object.keys(responseRecord),
      rawType: typeof rawField,
      rawLen: typeof rawField === 'string' ? rawField.length : undefined,
      rawPreview: typeof rawField === 'string' ? rawField.slice(0, 300) : undefined,
    });

    const runParsed = parseQueryResponse(runResponse, scope);
    return { runResponse, runParsed };
  };

  for (let repairAttempt = 0; repairAttempt <= maxMissingFieldRepairs; repairAttempt += 1) {
    try {
      const result = await runPayload(payload);
      response = result.runResponse;
      parsed = result.runParsed;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missingField = extractMissingField(message);
      if (!missingField || repairAttempt >= maxMissingFieldRepairs) throw err;
      const repaired = removeMissingFieldFromPayload(payload, missingField, scope);
      if (!repaired.changed) throw err;
      payload = normalizeRunPayloadRefs(repaired.payload, scope);
    }
  }

  if (!response) {
    throw new Error('/v1/query/run returned no response.');
  }
  if (!parsed) {
    const responseRecord = response as unknown as Record<string, unknown>;
    const dumpKeys = Object.keys(responseRecord).slice(0, 10);
    const dumpSummary: Record<string, unknown> = {};
    for (const k of dumpKeys) {
      const v = responseRecord[k];
      if (typeof v === 'string') {
        dumpSummary[k] = v.length > 400 ? `${v.slice(0, 400)}...(${v.length}b)` : v;
      } else if (Array.isArray(v)) {
        dumpSummary[k] = `array(${v.length})`;
      } else if (v && typeof v === 'object') {
        dumpSummary[k] = `object(keys=${Object.keys(v as Record<string, unknown>).join(',')})`;
      } else {
        dumpSummary[k] = v;
      }
    }
    deckLog.error(scope, 'Could not parse run response', { dumpSummary });
    throw new Error(
      `/v1/query/run returned no rows/columns we could parse. keys=${Object.keys(responseRecord).join(',')}`
    );
  }

  let { columns, rows } = parsed;
  let truncated = false;
  const fullRowCount = rows.length;
  if (columns.length > MAX_TABLE_COLS) {
    columns = columns.slice(0, MAX_TABLE_COLS);
    truncated = true;
  }
  if (rows.length > MAX_TABLE_ROWS) {
    rows = rows.slice(0, MAX_TABLE_ROWS);
    truncated = true;
  }

  const renderKind = classifyRender(columns, rows);
  const result: TileResult = { columns, rows, rowCount: fullRowCount, truncated, renderKind };

  deckLog.step(scope, `Query OK`, {
    rowCount: fullRowCount,
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    renderKind,
    bodyPath: extracted.path,
  });

  return { result, payloadUsed: payload, bodyPath: extracted.path };
}
