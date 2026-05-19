import { tableFromIPC } from 'apache-arrow';
import { getDashboardFilters, listDocuments, omniProxy, omniProxyDownload, listTopics, getTopic } from '@/services/omniApi';
import { deckLog, describeError } from './log';
import type { DashboardFilter, DashboardTile, FilterOverride, TopicFieldRef } from './types';
import type { CachedDashboard } from './localCache';

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fieldKeyMatchers(field: string): string[] {
  const tail = field.includes('.') ? field.split('.').slice(-1)[0] : field;
  return Array.from(new Set([field, tail]));
}

function pickFieldFromRow(rec: Record<string, unknown>, field: string): unknown {
  const matchers = fieldKeyMatchers(field);
  for (const m of matchers) {
    if (m in rec) return rec[m];
  }
  const lowerKeys = new Map<string, string>();
  for (const k of Object.keys(rec)) lowerKeys.set(k.toLowerCase(), k);
  for (const m of matchers) {
    const hit = lowerKeys.get(m.toLowerCase());
    if (hit) return rec[hit];
  }
  return undefined;
}

interface DocumentQueryRecord {
  id?: string;
  name?: string;
  title?: string;
  query_name?: string;
  queryName?: string;
  query_id?: string;
  queryId?: string;
  display_name?: string;
  displayTitle?: string;
  section?: string;
  group_name?: string;
  position?: number;
  order?: number;
}

interface DocumentResponse {
  document?: { id?: string; name?: string; title?: string; displayTitle?: string };
  dashboard?: { id?: string; name?: string; title?: string; displayTitle?: string };
  name?: string;
  title?: string;
  displayTitle?: string;
  queries?: DocumentQueryRecord[];
  tiles?: DocumentQueryRecord[];
}

const NAME_PATHS: Array<(d: DocumentResponse) => string | undefined> = [
  (d) => d.document?.title,
  (d) => d.document?.displayTitle,
  (d) => d.document?.name,
  (d) => d.dashboard?.title,
  (d) => d.dashboard?.displayTitle,
  (d) => d.dashboard?.name,
  (d) => d.title,
  (d) => d.displayTitle,
  (d) => d.name,
];

function pickName(doc: DocumentResponse): { name: string | null; sourcePath: string | null } {
  const labels = [
    'document.title',
    'document.displayTitle',
    'document.name',
    'dashboard.title',
    'dashboard.displayTitle',
    'dashboard.name',
    'title',
    'displayTitle',
    'name',
  ];
  for (let i = 0; i < NAME_PATHS.length; i += 1) {
    const v = NAME_PATHS[i](doc);
    if (typeof v === 'string' && v.trim().length > 0) {
      return { name: v.trim(), sourcePath: labels[i] };
    }
  }
  return { name: null, sourcePath: null };
}

export async function fetchDashboardList(
  baseUrl: string,
  apiKey: string
): Promise<CachedDashboard[]> {
  const data = await listDocuments(baseUrl, apiKey, undefined, { allPages: true, pageSize: 100 });
  const docs: Array<Record<string, unknown>> = Array.isArray(data?.documents) ? data.documents : [];
  return docs
    .map((d) => ({
      id: String(d.id || d.identifier || ''),
      name: String(d.name || '').trim() || 'Untitled',
      folderPath: typeof d.folderPath === 'string' ? d.folderPath : undefined,
    }))
    .filter((d) => d.id.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function humanizeField(field: string): string {
  const tail = field.includes('.') ? field.split('.').slice(-1)[0] : field;
  const spaced = tail.replace(/[._]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function pickModelIdFromQuery(queryBody: Record<string, unknown>): string | undefined {
  if (typeof queryBody.modelId === 'string') return queryBody.modelId;
  if (typeof queryBody.model_id === 'string') return queryBody.model_id;
  return undefined;
}

function pickTopicFromQuery(queryBody: Record<string, unknown>): string | undefined {
  if (typeof queryBody.topic === 'string') return queryBody.topic;
  if (typeof queryBody.topicName === 'string') return queryBody.topicName;
  if (typeof queryBody.topic_name === 'string') return queryBody.topic_name;
  return undefined;
}

function fieldViewName(field: string): string | undefined {
  if (!field.includes('.')) return undefined;
  return field.split('.')[0];
}

interface DocFilterEntry {
  field: string;
  label?: string;
  kind?: string;
  type?: string;
  values?: unknown[];
  isNegative?: boolean;
  topic?: string;
}

function readDocFilters(doc: DocumentResponse): DocFilterEntry[] {
  const out: DocFilterEntry[] = [];
  const docAny = doc as unknown as Record<string, unknown>;
  const candidates: unknown[] = [
    docAny.filters,
    isObj(docAny.document) ? (docAny.document as Record<string, unknown>).filters : undefined,
    isObj(docAny.dashboard) ? (docAny.dashboard as Record<string, unknown>).filters : undefined,
  ];
  const pushEntry = (field: string | undefined, meta: Record<string, unknown>) => {
    if (!field) return;
    const label =
      (typeof meta.label === 'string' && meta.label) ||
      (typeof meta.title === 'string' && (meta.title as string)) ||
      (typeof meta.displayName === 'string' && (meta.displayName as string)) ||
      (typeof meta.display_name === 'string' && (meta.display_name as string)) ||
      (typeof meta.name === 'string' && (meta.name as string)) ||
      undefined;
    const kind = typeof meta.kind === 'string' ? meta.kind : undefined;
    const type = typeof meta.type === 'string' ? meta.type : undefined;
    const values = Array.isArray(meta.values) ? (meta.values as unknown[]).slice() : undefined;
    const defaults = Array.isArray(meta.default_values)
      ? (meta.default_values as unknown[]).slice()
      : Array.isArray(meta.defaultValues)
      ? (meta.defaultValues as unknown[]).slice()
      : undefined;
    const isNegative = meta.is_negative === true || meta.isNegative === true;
    const topic =
      (typeof meta.topic === 'string' && (meta.topic as string)) ||
      (typeof meta.topic_name === 'string' && (meta.topic_name as string)) ||
      (typeof meta.topicName === 'string' && (meta.topicName as string)) ||
      undefined;
    out.push({ field, label, kind, type, values: values ?? defaults, isNegative, topic });
  };
  for (const cand of candidates) {
    if (Array.isArray(cand)) {
      for (const f of cand) {
        if (!isObj(f)) continue;
        const meta = f as Record<string, unknown>;
        const field =
          (typeof meta.field === 'string' && (meta.field as string)) ||
          (typeof meta.fieldRef === 'string' && (meta.fieldRef as string)) ||
          (typeof meta.field_ref === 'string' && (meta.field_ref as string)) ||
          (typeof meta.id === 'string' && (meta.id as string)) ||
          undefined;
        pushEntry(field, meta);
      }
    } else if (isObj(cand)) {
      for (const [field, meta] of Object.entries(cand)) {
        if (!isObj(meta)) continue;
        pushEntry(field, meta as Record<string, unknown>);
      }
    }
  }
  return out;
}

function readDashboardFiltersResponse(data: unknown): DocFilterEntry[] {
  const out: DocFilterEntry[] = [];
  if (!isObj(data)) return out;

  const filters = data.filters;
  if (isObj(filters)) {
    for (const [field, raw] of Object.entries(filters)) {
      if (!isObj(raw)) continue;
      const meta = raw as Record<string, unknown>;
      const values =
        Array.isArray(meta.values) ? meta.values.slice() :
        Array.isArray(meta.defaultValues) ? meta.defaultValues.slice() :
        Array.isArray(meta.default_values) ? meta.default_values.slice() :
        undefined;
      out.push({
        field,
        label:
          (typeof meta.label === 'string' && meta.label) ||
          (typeof meta.name === 'string' && meta.name) ||
          humanizeField(field),
        kind: typeof meta.kind === 'string' ? meta.kind : undefined,
        type: typeof meta.type === 'string' ? meta.type : undefined,
        values,
        isNegative: meta.is_negative === true || meta.isNegative === true,
        topic:
          (typeof meta.topic === 'string' && meta.topic) ||
          (typeof meta.topic_name === 'string' && meta.topic_name) ||
          (typeof meta.topicName === 'string' && meta.topicName) ||
          undefined,
      });
    }
  }

  if (Array.isArray(data.controls)) {
    for (const control of data.controls) {
      if (!isObj(control)) continue;
      const field =
        (typeof control.field === 'string' && control.field) ||
        (typeof control.id === 'string' && control.id) ||
        undefined;
      if (!field) continue;
      const options = Array.isArray(control.options)
        ? control.options
            .map((option) => {
              if (!isObj(option)) return option;
              return option.value ?? option.label;
            })
            .filter((v) => v !== undefined && v !== null)
        : undefined;
      out.push({
        field,
        label:
          (typeof control.label === 'string' && control.label) ||
          (typeof control.name === 'string' && control.name) ||
          humanizeField(field),
        kind: typeof control.kind === 'string' ? control.kind : undefined,
        type: typeof control.type === 'string' ? control.type : undefined,
        values: options,
        isNegative: false,
      });
    }
  }

  return out;
}

function readDocTopics(doc: DocumentResponse): string[] {
  const out = new Set<string>();
  const docAny = doc as unknown as Record<string, unknown>;
  const candidates: unknown[] = [
    docAny.topicNames,
    docAny.topic_names,
    docAny.topics,
    isObj(docAny.document) ? (docAny.document as Record<string, unknown>).topicNames : undefined,
    isObj(docAny.document) ? (docAny.document as Record<string, unknown>).topics : undefined,
    isObj(docAny.dashboard) ? (docAny.dashboard as Record<string, unknown>).topicNames : undefined,
  ];
  for (const cand of candidates) {
    if (Array.isArray(cand)) {
      for (const t of cand) {
        if (typeof t === 'string' && t) out.add(t);
        else if (isObj(t)) {
          const name = (t as Record<string, unknown>).name;
          if (typeof name === 'string' && name) out.add(name);
        }
      }
    }
  }
  return Array.from(out);
}

function extractDashboardFilters(
  tiles: DashboardTile[],
  docFilters: DocFilterEntry[]
): DashboardFilter[] {
  const seen = new Map<string, DashboardFilter>();

  for (const entry of docFilters) {
    seen.set(entry.field, {
      field: entry.field,
      label: entry.label || humanizeField(entry.field),
      kind: entry.kind,
      type: entry.type,
      values: entry.values ?? [],
      isNegative: entry.isNegative,
      topic: entry.topic,
      view: fieldViewName(entry.field),
      source: 'dashboard-picker',
    });
  }

  for (const tile of tiles) {
    const queryBody =
      (isObj(tile.rawQuery?.query) && (tile.rawQuery!.query as Record<string, unknown>)) ||
      (isObj(tile.rawQuery) && (tile.rawQuery as Record<string, unknown>)) ||
      null;
    if (!queryBody) continue;
    const modelId = pickModelIdFromQuery(queryBody);
    const topic = pickTopicFromQuery(queryBody);
    const filters = queryBody.filters;
    if (!isObj(filters)) continue;
    for (const [field, raw] of Object.entries(filters)) {
      if (!isObj(raw)) continue;
      const existing = seen.get(field);
      if (existing) {
        if (!existing.modelId && modelId) existing.modelId = modelId;
        if (!existing.topic && topic) existing.topic = topic;
        if (!existing.view) existing.view = fieldViewName(field);
        continue;
      }
      const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
      const type = typeof raw.type === 'string' ? raw.type : undefined;
      const values = Array.isArray(raw.values) ? raw.values.slice() : [];
      const isNegative = raw.is_negative === true || raw.isNegative === true;
      seen.set(field, {
        field,
        label: humanizeField(field),
        kind,
        type,
        values,
        isNegative,
        modelId,
        topic,
        view: fieldViewName(field),
        source: 'tile',
      });
    }
  }

  for (const entry of seen.values()) {
    if (!entry.modelId) {
      const fallbackModel = getDashboardModelId(tiles);
      if (fallbackModel) entry.modelId = fallbackModel;
    }
  }

  return Array.from(seen.values()).sort((a, b) =>
    (a.label || a.field).localeCompare(b.label || b.field)
  );
}

export function getDashboardTopics(tiles: DashboardTile[]): string[] {
  const out = new Set<string>();
  for (const tile of tiles) {
    const queryBody =
      (isObj(tile.rawQuery?.query) && (tile.rawQuery!.query as Record<string, unknown>)) ||
      (isObj(tile.rawQuery) && (tile.rawQuery as Record<string, unknown>)) ||
      null;
    if (!queryBody) continue;
    const t = pickTopicFromQuery(queryBody);
    if (t) out.add(t);
  }
  return Array.from(out);
}

export function getDashboardModelId(tiles: DashboardTile[]): string | undefined {
  for (const tile of tiles) {
    const queryBody =
      (isObj(tile.rawQuery?.query) && (tile.rawQuery!.query as Record<string, unknown>)) ||
      (isObj(tile.rawQuery) && (tile.rawQuery as Record<string, unknown>)) ||
      null;
    if (!queryBody) continue;
    const id = pickModelIdFromQuery(queryBody);
    if (id) return id;
  }
  return undefined;
}

export async function fetchDashboardSummary(
  baseUrl: string,
  apiKey: string,
  dashboardId: string
): Promise<{
  name: string;
  tiles: DashboardTile[];
  nameSource: string;
  filters: DashboardFilter[];
  topics: string[];
  modelId?: string;
}> {
  deckLog.step('inspect', 'Fetching dashboard queries', { dashboardId });

  const doc = await omniProxy<DocumentResponse>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/documents/${dashboardId}/queries`
  );

  deckLog.info('inspect', 'Document queries response keys', { keys: Object.keys(doc || {}) });

  let { name: dashboardName, sourcePath } = pickName(doc);

  if (!dashboardName) {
    deckLog.warn('inspect', 'No dashboard name in /queries response, trying /v1/documents/{id}');
    try {
      const meta = await omniProxy<DocumentResponse>(
        baseUrl,
        apiKey,
        'GET',
        `/v1/documents/${dashboardId}`
      );
      const picked = pickName(meta);
      if (picked.name) {
        dashboardName = picked.name;
        sourcePath = `documents/{id}.${picked.sourcePath}`;
      } else {
        deckLog.warn('inspect', '/v1/documents/{id} also did not contain a name', {
          keys: Object.keys(meta || {}),
        });
      }
    } catch (err) {
      deckLog.warn('inspect', 'Metadata fallback request failed', describeError(err));
    }
  }

  if (!dashboardName) {
    dashboardName = `Dashboard ${dashboardId}`;
    sourcePath = 'fallback:slug';
    deckLog.warn('inspect', 'Using slug as dashboard name fallback', { dashboardId });
  } else {
    deckLog.info('inspect', 'Resolved dashboard name', { name: dashboardName, sourcePath });
  }

  const rawTiles: Array<Record<string, unknown>> = Array.isArray(doc.queries)
    ? (doc.queries as unknown as Array<Record<string, unknown>>)
    : Array.isArray(doc.tiles)
    ? (doc.tiles as unknown as Array<Record<string, unknown>>)
    : [];

  if (rawTiles.length > 0) {
    deckLog.info('inspect', 'First raw tile record (full)', rawTiles[0]);
    deckLog.info('inspect', 'First raw tile keys', { keys: Object.keys(rawTiles[0]) });
  }

  const tiles: DashboardTile[] = rawTiles.map((t, idx) => {
    const r = t as Record<string, unknown>;
    const id =
      (typeof r.id === 'string' && r.id) ||
      (typeof r.queryId === 'string' && r.queryId) ||
      (typeof r.query_id === 'string' && r.query_id) ||
      `tile-${idx}`;
    const queryId =
      (typeof r.queryId === 'string' && r.queryId) ||
      (typeof r.query_id === 'string' && r.query_id) ||
      (typeof r.id === 'string' && r.id) ||
      undefined;
    const queryIdentifierMapKey =
      (typeof r.queryIdentifierMapKey === 'string' && r.queryIdentifierMapKey) ||
      (typeof r.query_identifier_map_key === 'string' && r.query_identifier_map_key) ||
      undefined;
    const name =
      (typeof r.displayTitle === 'string' && r.displayTitle) ||
      (typeof r.display_name === 'string' && r.display_name) ||
      (typeof r.title === 'string' && r.title) ||
      (typeof r.name === 'string' && r.name) ||
      (typeof r.query_name === 'string' && r.query_name) ||
      (typeof r.queryName === 'string' && r.queryName) ||
      `Tile ${idx + 1}`;
    const section =
      (typeof r.section === 'string' && r.section) ||
      (typeof r.group_name === 'string' && r.group_name) ||
      undefined;
    const order =
      typeof r.position === 'number' ? r.position : typeof r.order === 'number' ? r.order : idx;
    const tileType =
      (typeof r.type === 'string' && r.type) ||
      (typeof r.tileType === 'string' && r.tileType) ||
      (typeof r.kind === 'string' && r.kind) ||
      undefined;
    const markdown =
      (typeof r.markdown === 'string' && r.markdown) ||
      (typeof r.body === 'string' && r.body) ||
      (typeof r.text === 'string' && r.text) ||
      undefined;
    return { id, queryId, queryIdentifierMapKey, name, section, order, rawQuery: r, tileType, markdown };
  });

  tiles.sort((a, b) => a.order - b.order);

  deckLog.info('inspect', `Parsed ${tiles.length} tiles`, {
    sample: tiles.slice(0, 3).map((t) => ({ id: t.id, name: t.name })),
  });

  let apiFilterEntries: DocFilterEntry[] = [];
  try {
    const dashboardFilters = await getDashboardFilters(baseUrl, apiKey, dashboardId);
    apiFilterEntries = readDashboardFiltersResponse(dashboardFilters);
    deckLog.info('inspect', `Fetched ${apiFilterEntries.length} dashboard filter/control entries from /filters`, {
      fields: apiFilterEntries.map((f) => f.field),
    });
  } catch (err) {
    deckLog.warn('inspect', 'Dashboard filters endpoint failed; falling back to document query filters', describeError(err));
  }

  const docFilters = [...readDocFilters(doc), ...apiFilterEntries];
  const filters = extractDashboardFilters(tiles, docFilters);
  const docTopics = readDocTopics(doc);
  const tileTopics = getDashboardTopics(tiles);
  const topics = Array.from(new Set([...docTopics, ...tileTopics]));
  const modelId = getDashboardModelId(tiles);
  deckLog.info('inspect', `Extracted ${filters.length} dashboard filter(s)`, {
    fields: filters.map((f) => f.field),
    docFilterCount: docFilters.length,
    topics,
    modelId,
  });

  return {
    name: dashboardName,
    tiles,
    nameSource: sourcePath || 'unknown',
    filters,
    topics,
    modelId,
  };
}

export type TileExportShape = 'queryIdentifierMapKey' | 'queryIds' | 'tileIds' | 'fullDashboard';

const SHAPE_BODY: Record<Exclude<TileExportShape, 'fullDashboard'>, (id: string) => Record<string, unknown>> = {
  queryIdentifierMapKey: (id) => ({ format: 'png', queryIdentifierMapKey: id }),
  queryIds: (id) => ({ format: 'png', queryIds: [id] }),
  tileIds: (id) => ({ format: 'png', tileIds: [id] }),
};

export interface TileExportOptions {
  tile: DashboardTile;
  signal?: AbortSignal;
  onStatusChange?: (status: string) => void;
  pollIntervalMs?: number;
  maxAttempts?: number;
  shapes?: TileExportShape[];
  logFirstStatusPayload?: boolean;
  filterOverrides?: Record<string, FilterOverride>;
}

interface PollStatusResponse {
  status?: string;
  state?: string;
  error?: string;
  message?: string;
}

async function pollForCompletion(
  baseUrl: string,
  apiKey: string,
  dashboardId: string,
  jobId: string,
  signal: AbortSignal | undefined,
  pollIntervalMs: number,
  maxAttempts: number,
  onStatusChange: ((s: string) => void) | undefined,
  logRaw: boolean,
  scope: string
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('Export cancelled.');
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    let status: PollStatusResponse;
    try {
      status = await omniProxy<PollStatusResponse>(
        baseUrl,
        apiKey,
        'GET',
        `/v1/dashboards/${dashboardId}/download/${jobId}/status`
      );
    } catch (err) {
      const e = describeError(err);
      throw new Error(`polling failed (attempt ${attempt + 1}): ${e.message}${e.status ? ` [HTTP ${e.status}]` : ''}`);
    }

    if (logRaw && attempt === 0) {
      deckLog.info(scope, 'First status payload (raw)', status);
    }

    const s = status.status || status.state;
    if (s === 'complete' || s === 'completed' || s === 'finished') return;
    if (s === 'error' || s === 'failed') {
      throw new Error(`Omni reported job failed: ${status.error || status.message || s}`);
    }

    onStatusChange?.(`Exporting (${Math.round((attempt + 1) * (pollIntervalMs / 1000))}s, status=${s ?? 'unknown'})`);
  }
  throw new Error(`polling timed out after ${maxAttempts} attempts.`);
}

const dashboardDownloadLocks = new Map<string, Promise<unknown>>();

async function withDashboardDownloadLock<T>(
  dashboardId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = dashboardDownloadLocks.get(dashboardId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  dashboardDownloadLocks.set(
    dashboardId,
    prev.then(() => gate)
  );
  try {
    await prev;
  } catch {
    // previous holder failed; we still proceed
  }
  try {
    return await fn();
  } finally {
    release();
    if (dashboardDownloadLocks.get(dashboardId)?.then === gate.then) {
      // best-effort cleanup; map entry replaced on next acquire
    }
  }
}

export async function exportTileAsPng(
  baseUrl: string,
  apiKey: string,
  dashboardId: string,
  options: TileExportOptions
): Promise<{ blob: Blob; shapeUsed: TileExportShape }> {
  return withDashboardDownloadLock(dashboardId, () => exportTileAsPngInner(baseUrl, apiKey, dashboardId, options));
}

async function exportTileAsPngInner(
  baseUrl: string,
  apiKey: string,
  dashboardId: string,
  options: TileExportOptions
): Promise<{ blob: Blob; shapeUsed: TileExportShape }> {
  const { tile, onStatusChange, signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 2500;
  const maxAttempts = options.maxAttempts ?? 80;
  const shapes: TileExportShape[] = options.shapes ?? ['queryIdentifierMapKey'];
  const scope = `tile:${tile.id.slice(0, 8)}`;

  if (options.filterOverrides && Object.keys(options.filterOverrides).length > 0) {
    deckLog.warn(
      scope,
      'Filter overrides are ignored by the Omni PNG download endpoint. The exported PNG will reflect the saved dashboard filter state. Use the Native render path for tiles that need filter control.'
    );
  }

  const failures: string[] = [];

  for (const shape of shapes) {
    if (shape === 'fullDashboard') continue;
    if (signal?.aborted) throw new Error('Export cancelled.');

    const idForShape =
      shape === 'queryIdentifierMapKey'
        ? tile.queryIdentifierMapKey
        : tile.queryId || tile.id;

    if (!idForShape) {
      const note = `${shape}: skipped (no identifier for this shape on tile)`;
      failures.push(note);
      deckLog.warn(scope, note);
      continue;
    }

    onStatusChange?.(`Requesting export (${shape})`);
    deckLog.step(scope, `Starting tile export`, { tile: tile.name, shape, idForShape });

    let jobId: string | null = null;
    let startError: { note: string } | null = null;
    try {
      const body: Record<string, unknown> = { ...SHAPE_BODY[shape](idForShape) };
      deckLog.info(scope, 'Download request body', body);
      const maxConflictRetries = 12;
      const conflictDelayMs = 2000;
      for (let attempt = 0; attempt <= maxConflictRetries; attempt += 1) {
        if (signal?.aborted) throw new Error('Export cancelled.');
        try {
          const startRes = await omniProxy<{ job_id?: string; jobId?: string; id?: string; error?: string }>(
            baseUrl,
            apiKey,
            'POST',
            `/v1/dashboards/${dashboardId}/download`,
            { body }
          );
          deckLog.info(scope, 'Download response', startRes);
          jobId = startRes.job_id || startRes.jobId || startRes.id || null;
          if (!jobId) {
            const note = startRes.error || 'no job_id in response';
            failures.push(`${shape}: ${note}`);
            deckLog.warn(scope, `Shape ${shape} returned no job_id`, startRes);
            startError = { note };
          }
          break;
        } catch (err) {
          const e = describeError(err);
          if ((e.status === 409 || e.status === 429) && attempt < maxConflictRetries) {
            const retryDelayMs = e.status === 429 ? 6000 : conflictDelayMs;
            onStatusChange?.(
              e.status === 429
                ? `Omni rate limited this export, retrying (${attempt + 1}/${maxConflictRetries})`
                : `Dashboard busy, retrying (${attempt + 1}/${maxConflictRetries})`
            );
            deckLog.info(
              scope,
              `Download ${e.status === 429 ? 'rate limit' : 'conflict'} (${e.status}), waiting ${retryDelayMs}ms before retry ${attempt + 1}/${maxConflictRetries}`
            );
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }
          const note = `${shape}: start failed${e.status ? ` [HTTP ${e.status}]` : ''}: ${e.message}${e.detail ? ` | ${e.detail.slice(0, 240)}` : ''}`;
          failures.push(note);
          deckLog.warn(scope, note);
          startError = { note };
          break;
        }
      }
    } catch (err) {
      const e = describeError(err);
      const note = `${shape}: start failed${e.status ? ` [HTTP ${e.status}]` : ''}: ${e.message}${e.detail ? ` | ${e.detail.slice(0, 240)}` : ''}`;
      failures.push(note);
      deckLog.warn(scope, note);
      continue;
    }
    if (!jobId) {
      if (!startError) continue;
      continue;
    }

    try {
      await pollForCompletion(
        baseUrl,
        apiKey,
        dashboardId,
        jobId,
        signal,
        pollIntervalMs,
        maxAttempts,
        onStatusChange,
        Boolean(options.logFirstStatusPayload),
        scope
      );
    } catch (err) {
      const e = describeError(err);
      const note = `${shape}: ${e.message}${e.detail ? ` | ${e.detail.slice(0, 240)}` : ''}`;
      failures.push(note);
      deckLog.warn(scope, note);
      continue;
    }

    onStatusChange?.('Fetching image');
    deckLog.step(scope, 'Fetching exported PNG', { jobId });
    try {
      const blob = await omniProxyDownload(
        baseUrl,
        apiKey,
        `/v1/dashboards/${dashboardId}/download/${jobId}`
      );
      const typed = new Blob([blob], { type: 'image/png' });
      deckLog.step(scope, 'Tile export OK', { shapeUsed: shape, bytes: typed.size });
      return { blob: typed, shapeUsed: shape };
    } catch (err) {
      const e = describeError(err);
      const note = `${shape}: fetch failed${e.status ? ` [HTTP ${e.status}]` : ''}: ${e.message}`;
      failures.push(note);
      deckLog.warn(scope, note);
    }
  }

  throw new Error(
    `All per-tile export attempts failed. Tried ${failures.length} shape(s): ${failures.join(' || ')}`
  );
}

export async function exportFullDashboardAsPng(
  baseUrl: string,
  apiKey: string,
  dashboardId: string,
  signal?: AbortSignal,
  onStatusChange?: (s: string) => void
): Promise<Blob> {
  deckLog.step('full', 'Starting full dashboard PNG export', { dashboardId });
  onStatusChange?.('Requesting full dashboard export');

  const startRes = await omniProxy<{ job_id?: string; error?: string }>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/dashboards/${dashboardId}/download`,
    { body: { format: 'png' } }
  );
  if (!startRes.job_id) {
    throw new Error(startRes.error || 'No job_id returned for full dashboard export.');
  }

  await pollForCompletion(
    baseUrl,
    apiKey,
    dashboardId,
    startRes.job_id,
    signal,
    2500,
    80,
    onStatusChange,
    true,
    'full'
  );

  const blob = await omniProxyDownload(
    baseUrl,
    apiKey,
    `/v1/dashboards/${dashboardId}/download/${startRes.job_id}`
  );
  return new Blob([blob], { type: 'image/png' });
}

interface RunResponseShape {
  result?: { columns?: unknown; rows?: unknown; data?: unknown };
  data?: unknown;
  rows?: unknown;
  columns?: unknown;
  raw?: unknown;
}

interface ParseValuesDiag {
  matchedRows: number;
  unmatchedRows: number;
  arrowDecoded: boolean;
  sampleKeys: string[];
}

function decodeArrowToRows(b64: string): Array<Record<string, unknown>> | null {
  try {
    const bytes = base64ToUint8Array(b64);
    const table = tableFromIPC(bytes);
    const cols = table.schema.fields.map((f) => f.name);
    const raw = table.toArray();
    return raw.map((r) => {
      const plain: Record<string, unknown> = {};
      for (const c of cols) {
        const v = (r as Record<string, unknown>)[c];
        if (typeof v === 'bigint') {
          plain[c] = v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER ? Number(v) : v.toString();
        } else if (v instanceof Date) {
          plain[c] = v.toISOString();
        } else {
          plain[c] = v;
        }
      }
      return plain;
    });
  } catch {
    return null;
  }
}

function collectRowsFromResponse(resp: RunResponseShape, diag: ParseValuesDiag): Array<Record<string, unknown>> {
  const allRows: Array<Record<string, unknown>> = [];

  const pushObjectRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        allRows.push(r as Record<string, unknown>);
      }
    }
  };

  pushObjectRows(resp.rows);
  pushObjectRows(resp.data);
  if (resp.result) {
    pushObjectRows(resp.result.rows);
    pushObjectRows(resp.result.data);
  }

  if (typeof resp.raw === 'string') {
    const parts: Array<Record<string, unknown>> = [];
    for (const line of resp.raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const v = JSON.parse(t);
        if (v && typeof v === 'object' && !Array.isArray(v)) parts.push(v as Record<string, unknown>);
      } catch {
        // skip
      }
    }

    const completePart = parts.find(
      (p) => (p as { status?: unknown }).status === 'COMPLETE' && typeof (p as { result?: unknown }).result === 'string'
    );
    if (completePart) {
      const arrowRows = decodeArrowToRows((completePart as { result: string }).result);
      if (arrowRows) {
        diag.arrowDecoded = true;
        allRows.push(...arrowRows);
      }
    }

    for (const p of parts) {
      const rowsArr =
        (Array.isArray((p as { rows?: unknown }).rows) && (p as { rows: unknown[] }).rows) ||
        (Array.isArray((p as { data?: unknown }).data) && (p as { data: unknown[] }).data) ||
        null;
      if (rowsArr) {
        for (const r of rowsArr) {
          if (r && typeof r === 'object' && !Array.isArray(r)) allRows.push(r as Record<string, unknown>);
        }
      }
    }
  }

  return allRows;
}

function parseValuesFromResponse(resp: RunResponseShape, field: string): { values: string[]; diag: ParseValuesDiag } {
  const diag: ParseValuesDiag = { matchedRows: 0, unmatchedRows: 0, arrowDecoded: false, sampleKeys: [] };
  const rows = collectRowsFromResponse(resp, diag);
  if (rows.length > 0) diag.sampleKeys = Object.keys(rows[0]).slice(0, 10);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const v = pickFieldFromRow(r, field);
    if (v === undefined) {
      diag.unmatchedRows += 1;
      continue;
    }
    diag.matchedRows += 1;
    if (v === null) continue;
    const s = typeof v === 'string' ? v : String(v);
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return { values: out.sort((a, b) => a.localeCompare(b)), diag };
}

export interface FilterValueLookupOptions {
  modelId: string;
  field: string;
  topic?: string;
  candidateTopics?: string[];
  templateBody?: Record<string, unknown>;
  signal?: AbortSignal;
  limit?: number;
}

interface AttemptLog {
  shape: string;
  status?: number;
  message?: string;
  detail?: string;
  rowCount?: number;
  matchedRows?: number;
  unmatchedRows?: number;
  arrowDecoded?: boolean;
  sampleKeys?: string[];
}

const TEMPLATE_DROP_KEYS = new Set([
  'id', 'queryId', 'query_id', 'tileId', 'tile_id', 'documentId', 'document_id',
  'createdAt', 'created_at', 'updatedAt', 'updated_at',
  'name', 'title', 'displayTitle', 'display_name',
  'position', 'order', 'section', 'group_name',
  'type', 'tileType', 'kind',
  'filters', 'sorts', 'pivots', 'groupBy', 'group_by',
  'limit', 'fields',
]);

function cloneTemplateBody(template: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!template) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (TEMPLATE_DROP_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function isObjRec(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function pickTemplateTopic(template: Record<string, unknown> | undefined): string | undefined {
  if (!template) return undefined;
  if (typeof template.topicName === 'string') return template.topicName;
  if (typeof template.topic_name === 'string') return template.topic_name;
  if (typeof template.topic === 'string') return template.topic;
  return undefined;
}

type RunShape = 'wrapped' | 'flat';
let cachedFilterRunShape: RunShape | null = null;

export async function fetchFilterValueOptions(
  baseUrl: string,
  apiKey: string,
  options: FilterValueLookupOptions
): Promise<{ values: string[]; attempts: AttemptLog[] }> {
  const { modelId, field, signal, templateBody } = options;
  const limit = options.limit ?? 1000;

  const topicCandidates: Array<string | undefined> = [];
  const templateTopic = pickTemplateTopic(templateBody);
  if (templateTopic) topicCandidates.push(templateTopic);
  if (options.topic && !topicCandidates.includes(options.topic)) topicCandidates.push(options.topic);
  if (options.candidateTopics) {
    for (const t of options.candidateTopics) {
      if (t && !topicCandidates.includes(t)) topicCandidates.push(t);
    }
  }
  if (topicCandidates.length === 0) topicCandidates.push(undefined);

  const templateBase = cloneTemplateBody(templateBody);

  const buildVariants = (topicName: string | undefined): Array<{ key: string; payload: Record<string, unknown> }> => {
    const base: Record<string, unknown> = { ...templateBase, modelId, limit };
    if (topicName) base.topicName = topicName;
    return [
      {
        key: `topicName=${topicName ?? 'none'}|sorted`,
        payload: { ...base, fields: [field], sorts: [{ fieldName: field, direction: 'asc' }] },
      },
      {
        key: `topicName=${topicName ?? 'none'}|no-sort`,
        payload: { ...base, fields: [field] },
      },
    ];
  };

  const attempts: AttemptLog[] = [];
  let bestValues: string[] = [];
  let lastErr: unknown = null;
  let lastFailDetail: { status?: number; message: string; detail?: string } | null = null;

  const shapeOrder: RunShape[] = cachedFilterRunShape
    ? [cachedFilterRunShape, cachedFilterRunShape === 'wrapped' ? 'flat' : 'wrapped']
    : ['wrapped', 'flat'];

  for (const topicName of topicCandidates) {
    for (const variant of buildVariants(topicName)) {
      for (const shape of shapeOrder) {
        if (signal?.aborted) throw new Error('Cancelled');
        const body = shape === 'wrapped' ? { query: variant.payload } : variant.payload;
        const attemptKey = `${variant.key}|${shape}`;
        try {
          const resp = await omniProxy<RunResponseShape>(baseUrl, apiKey, 'POST', '/v1/query/run', { body });
          cachedFilterRunShape = shape;
          const { values, diag } = parseValuesFromResponse(resp, field);
          attempts.push({
            shape: attemptKey,
            rowCount: values.length,
            matchedRows: diag.matchedRows,
            unmatchedRows: diag.unmatchedRows,
            arrowDecoded: diag.arrowDecoded,
            sampleKeys: diag.sampleKeys,
          });
          deckLog.info('filter-values', `Attempt result for ${field}`, {
            attemptKey,
            distinctValues: values.length,
            matchedRows: diag.matchedRows,
            unmatchedRows: diag.unmatchedRows,
            arrowDecoded: diag.arrowDecoded,
            sampleKeys: diag.sampleKeys,
          });
          if (diag.matchedRows > 0 && values.length > bestValues.length) bestValues = values;
          if (values.length > 0 && diag.matchedRows > 0) {
            return { values: bestValues, attempts };
          }
        } catch (err) {
          lastErr = err;
          const e = describeError(err);
          const detailTrunc = e.detail ? e.detail.slice(0, 400) : undefined;
          attempts.push({ shape: attemptKey, status: e.status, message: e.message, detail: detailTrunc });
          lastFailDetail = { status: e.status, message: e.message, detail: detailTrunc };
          deckLog.warn('filter-values', `Attempt failed for ${field}`, {
            attemptKey,
            status: e.status,
            message: e.message,
            detail: detailTrunc,
          });
          if (e.status && e.status !== 400 && e.status !== 422) break;
        }
      }
    }
  }

  if (bestValues.length > 0) return { values: bestValues, attempts };
  if (lastErr) {
    const reason = lastFailDetail?.detail || lastFailDetail?.message || describeError(lastErr).message;
    const summary = attempts
      .slice(-3)
      .map((a) => `${a.shape}${a.status ? ` [${a.status}]` : ''}`)
      .join(' | ');
    throw new Error(
      `Could not load values for ${field}: ${reason}${summary ? ` — last attempts: ${summary}` : ''}`
    );
  }
  return { values: [], attempts };
}

export function pickTileTemplateBody(tiles: DashboardTile[], preferredView?: string): Record<string, unknown> | undefined {
  let fallback: Record<string, unknown> | undefined;
  for (const tile of tiles) {
    const queryBody =
      (isObjRec(tile.rawQuery?.query) && (tile.rawQuery!.query as Record<string, unknown>)) ||
      (isObjRec(tile.rawQuery) && (tile.rawQuery as Record<string, unknown>)) ||
      null;
    if (!queryBody) continue;
    if (typeof queryBody.modelId !== 'string' && typeof queryBody.model_id !== 'string') continue;
    if (!fallback) fallback = queryBody;
    if (preferredView && Array.isArray(queryBody.fields)) {
      const hasView = (queryBody.fields as unknown[]).some(
        (f) => typeof f === 'string' && f.startsWith(`${preferredView}.`)
      );
      if (hasView) return queryBody;
    }
  }
  return fallback;
}

export interface TopicCatalogResult {
  modelId: string;
  topics: string[];
  fields: TopicFieldRef[];
  errors: Array<{ topic: string; message: string }>;
}

export async function fetchTopicCatalog(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  preferredTopics?: string[]
): Promise<TopicCatalogResult> {
  const errors: Array<{ topic: string; message: string }> = [];
  let topicNames: string[] = preferredTopics ? [...preferredTopics] : [];

  if (topicNames.length === 0) {
    try {
      const list = await listTopics(baseUrl, apiKey, modelId);
      topicNames = list.map((t) => t.name).filter(Boolean);
    } catch (err) {
      const e = describeError(err);
      deckLog.warn('topic-catalog', 'listTopics failed', { message: e.message });
      errors.push({ topic: '*list*', message: e.message });
    }
  }

  const seen = new Set<string>();
  const fields: TopicFieldRef[] = [];

  for (const topicName of topicNames) {
    try {
      const topic = (await getTopic(baseUrl, apiKey, modelId, topicName)) as Record<string, unknown>;
      const views = Array.isArray(topic.views) ? (topic.views as Array<Record<string, unknown>>) : [];
      for (const view of views) {
        const viewName =
          (typeof view.name === 'string' && (view.name as string)) ||
          (typeof view.label === 'string' && (view.label as string)) ||
          'view';
        const dimensions = Array.isArray(view.dimensions)
          ? (view.dimensions as Array<Record<string, unknown>>)
          : [];
        for (const d of dimensions) {
          const fieldName =
            (typeof d.field_name === 'string' && (d.field_name as string)) ||
            (typeof d.fieldName === 'string' && (d.fieldName as string)) ||
            (typeof d.name === 'string' && (d.name as string)) ||
            undefined;
          if (!fieldName) continue;
          const qualified = `${viewName}.${fieldName}`;
          if (seen.has(qualified)) continue;
          seen.add(qualified);
          const dataType =
            (typeof d.data_type === 'string' && (d.data_type as string)) ||
            (typeof d.dataType === 'string' && (d.dataType as string)) ||
            undefined;
          fields.push({
            field: qualified,
            label: humanizeField(fieldName),
            view: viewName,
            topic: topicName,
            modelId,
            dataType,
          });
        }
      }
    } catch (err) {
      const e = describeError(err);
      deckLog.warn('topic-catalog', `getTopic failed for ${topicName}`, { message: e.message });
      errors.push({ topic: topicName, message: e.message });
    }
  }

  fields.sort((a, b) => {
    if (a.view !== b.view) return a.view.localeCompare(b.view);
    return a.label.localeCompare(b.label);
  });

  return { modelId, topics: topicNames, fields, errors };
}

function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export function seedOverridesFromDashboardFilters(
  filters: DashboardFilter[] | undefined,
): Record<string, FilterOverride> {
  if (!filters || filters.length === 0) return {};
  const out: Record<string, FilterOverride> = {};
  for (const f of filters) {
    if (!f.field) continue;
    const values = Array.isArray(f.values) ? f.values.filter(isMeaningfulValue) : [];
    if (values.length === 0) continue;
    out[f.field] = {
      field: f.field,
      kind: f.kind,
      type: f.type,
      values,
      isNegative: f.isNegative,
    };
  }
  return out;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read image data.'));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}
