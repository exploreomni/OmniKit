import { validateBaseUrl } from '../security';
import type { SavedInstance } from './nativeVault';

const TIMEOUT_MS = 60_000;
const MIN_REQUEST_GAP_MS = 1200;
const MAX_RETRIES = 5;

const keyChains = new Map<string, Promise<void>>();
const lastStartByKey = new Map<string, number>();

export interface OmniConnectionRecord {
  id: string;
  name: string;
  dialect: string;
  database: string;
  defaultSchema?: string;
  deletedAt?: string | null;
}

export interface OmniSchemaModelRecord {
  id: string;
  name: string;
  connectionId?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface OmniModelRecord {
  id: string;
  name: string;
  identifier?: string;
  connectionId?: string;
  connectionName?: string;
  baseModelId?: string;
  kind?: string;
  gitConfigured?: boolean;
  pullRequestRequired?: boolean;
  gitProtected?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface OmniListModelsOptions {
  modelKind?: string;
  connectionId?: string;
  baseModelId?: string;
  modelId?: string;
  name?: string;
  includeDeleted?: boolean;
  include?: string;
}

export interface OmniFolderRecord {
  id: string;
  name: string;
  identifier?: string;
  path?: string;
  parentId?: string;
  children?: OmniFolderRecord[];
}

export interface OmniDocumentRecord {
  id: string;
  identifier: string;
  name: string;
  connectionId?: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  baseModelName?: string;
  topicNames?: string[];
  topicIds?: string[];
  type?: string;
  hasDashboard?: boolean | null;
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface OmniLabelRecord {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface OmniEmbedUserRecord {
  id: string;
  displayName: string;
  userName: string;
  active: boolean;
  embedExternalId: string;
  groups: Array<{ display: string; value: string }>;
  lastLogin?: string | null;
  createdAt?: string;
}

export interface OmniModelYamlResponse {
  files: Record<string, string>;
  checksums?: Record<string, string>;
  raw: unknown;
}

export interface OmniModelTopicRecord {
  name: string;
  label?: string;
  description?: string;
  fileName?: string;
  yaml?: string;
  checksum?: string;
}

export interface OmniModelBranchResult {
  id: string;
  name: string;
  raw: unknown;
}

export interface OmniValidationIssue {
  message?: string;
  is_warning?: boolean;
  yaml_path?: string;
  [key: string]: unknown;
}

export interface OmniDocumentQueryRecord {
  id: string;
  name: string;
  url?: string;
  query: Record<string, unknown>;
  visConfig?: Record<string, unknown>;
  description?: string;
}

export interface OmniCreateWorkbookInput {
  modelId: string;
  name: string;
  description?: string | null;
  folderId?: string;
  folderPath?: string;
  queryPresentations: Array<{
    name: string;
    description?: string | null;
    query: Record<string, unknown>;
    visConfig?: Record<string, unknown>;
  }>;
}

export interface OmniCreateWorkbookResult {
  id: string;
  identifier: string;
  url?: string;
  raw: unknown;
}

export interface OmniDashboardDownloadTile {
  id: string;
  name: string;
  queryId?: string;
  queryIdentifierMapKey?: string;
  section?: string;
  order: number;
  tileType?: string;
  markdown?: string;
}

export interface OmniDashboardDownloadFilter {
  field: string;
  label?: string;
  kind?: string;
  type?: string;
  values: unknown[];
  isNegative?: boolean;
  topic?: string;
  view?: string;
  source?: 'dashboard-picker' | 'tile';
}

export interface OmniDashboardDownloadDetails {
  id: string;
  name: string;
  filters: OmniDashboardDownloadFilter[];
  tiles: OmniDashboardDownloadTile[];
}

export interface OmniDashboardDownloadStartResult {
  jobId: string;
  raw: unknown;
}

export interface OmniDashboardDownloadStatus {
  status: string;
  error?: string;
  raw: unknown;
}

export interface OmniAiJobResult {
  id: string;
  status?: string;
  result?: unknown;
  raw: unknown;
}

export class OmniClientError extends Error {
  constructor(public status: number, public url: string, message: string) {
    super(`${status} ${url}: ${message}`);
    this.name = 'OmniClientError';
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSlot(apiKey: string): Promise<void> {
  const previous = keyChains.get(apiKey) ?? Promise.resolve();
  const next = previous.then(async () => {
    const lastStart = lastStartByKey.get(apiKey) ?? 0;
    const waitMs = Math.max(0, lastStart + MIN_REQUEST_GAP_MS - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lastStartByKey.set(apiKey, Date.now());
  });
  keyChains.set(apiKey, next.catch(() => undefined));
  await next;
}

function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const parsedDate = Date.parse(header);
    if (Number.isFinite(parsedDate)) return Math.max(0, parsedDate - Date.now());
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function extractArray(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    const firstArray = Object.values(record).find((value) => Array.isArray(value));
    if (Array.isArray(firstArray)) return firstArray;
  }
  return [];
}

function extractPageInfo(data: unknown): { hasNextPage?: boolean; nextCursor?: string } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pageInfo = (data as Record<string, unknown>).pageInfo;
  if (!pageInfo || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) return null;
  return pageInfo as { hasNextPage?: boolean; nextCursor?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function humanizeField(field: string): string {
  return field
    .split('.')
    .pop()
    ?.replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    || field;
}

function fieldViewName(field: string): string | undefined {
  if (!field.includes('.')) return undefined;
  return field.split('.')[0];
}

function pickDashboardName(data: unknown, fallbackId: string): string {
  const record = isRecord(data) ? data : {};
  const document = isRecord(record.document) ? record.document : {};
  const dashboard = isRecord(record.dashboard) ? record.dashboard : {};
  return firstString(
    record.name,
    record.title,
    record.displayName,
    record.display_name,
    document.name,
    document.title,
    document.displayName,
    document.display_name,
    dashboard.name,
    dashboard.title,
    dashboard.displayName,
    dashboard.display_name,
  ) || `Dashboard ${fallbackId}`;
}

function readDashboardFilterEntries(data: unknown): OmniDashboardDownloadFilter[] {
  const out: OmniDashboardDownloadFilter[] = [];
  if (!isRecord(data)) return out;

  const filters = data.filters;
  if (isRecord(filters)) {
    for (const [field, raw] of Object.entries(filters)) {
      if (!isRecord(raw)) continue;
      const values = Array.isArray(raw.values)
        ? raw.values.slice()
        : Array.isArray(raw.defaultValues)
          ? raw.defaultValues.slice()
          : Array.isArray(raw.default_values)
            ? raw.default_values.slice()
            : [];
      out.push({
        field,
        label: firstString(raw.label, raw.name) || humanizeField(field),
        kind: firstString(raw.kind),
        type: firstString(raw.type),
        values,
        isNegative: raw.is_negative === true || raw.isNegative === true,
        topic: firstString(raw.topic, raw.topic_name, raw.topicName),
        view: fieldViewName(field),
        source: 'dashboard-picker',
      });
    }
  }

  if (Array.isArray(data.controls)) {
    for (const control of data.controls) {
      if (!isRecord(control)) continue;
      const field = firstString(control.field, control.id);
      if (!field) continue;
      const options = Array.isArray(control.options)
        ? control.options
            .map((option) => (isRecord(option) ? option.value ?? option.label : option))
            .filter((value) => value !== undefined && value !== null)
        : [];
      out.push({
        field,
        label: firstString(control.label, control.name) || humanizeField(field),
        kind: firstString(control.kind),
        type: firstString(control.type),
        values: options,
        isNegative: false,
        view: fieldViewName(field),
        source: 'dashboard-picker',
      });
    }
  }

  return out;
}

function readDocFilterEntries(data: unknown): OmniDashboardDownloadFilter[] {
  const out: OmniDashboardDownloadFilter[] = [];
  const record = isRecord(data) ? data : {};
  const candidates = [
    record.filters,
    isRecord(record.document) ? record.document.filters : undefined,
    isRecord(record.dashboard) ? record.dashboard.filters : undefined,
  ];
  const pushEntry = (field: string | undefined, meta: Record<string, unknown>) => {
    if (!field) return;
    const values = Array.isArray(meta.values)
      ? meta.values.slice()
      : Array.isArray(meta.defaultValues)
        ? meta.defaultValues.slice()
        : Array.isArray(meta.default_values)
          ? meta.default_values.slice()
          : [];
    out.push({
      field,
      label: firstString(meta.label, meta.title, meta.displayName, meta.display_name, meta.name) || humanizeField(field),
      kind: firstString(meta.kind),
      type: firstString(meta.type),
      values,
      isNegative: meta.is_negative === true || meta.isNegative === true,
      topic: firstString(meta.topic, meta.topic_name, meta.topicName),
      view: fieldViewName(field),
      source: 'dashboard-picker',
    });
  };

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (!isRecord(item)) continue;
        pushEntry(firstString(item.field, item.fieldRef, item.field_ref, item.id), item);
      }
    } else if (isRecord(candidate)) {
      for (const [field, meta] of Object.entries(candidate)) {
        if (isRecord(meta)) pushEntry(field, meta);
      }
    }
  }
  return out;
}

function readDashboardDownloadTiles(data: unknown): OmniDashboardDownloadTile[] {
  const record = isRecord(data) ? data : {};
  const rawTiles = Array.isArray(record.queries)
    ? record.queries
    : Array.isArray(record.tiles)
      ? record.tiles
      : extractArray(data, ['queries', 'tiles', 'records', 'data', 'items']);

  const tiles = rawTiles
    .filter(isRecord)
    .map((row, index) => {
      const id = firstString(row.id, row.queryId, row.query_id) || `tile-${index}`;
      return {
        id,
        queryId: firstString(row.queryId, row.query_id, row.id),
        queryIdentifierMapKey: firstString(row.queryIdentifierMapKey, row.query_identifier_map_key),
        name: firstString(row.displayTitle, row.display_name, row.title, row.name, row.query_name, row.queryName) || `Tile ${index + 1}`,
        section: firstString(row.section, row.group_name),
        order: typeof row.position === 'number' ? row.position : typeof row.order === 'number' ? row.order : index,
        tileType: firstString(row.type, row.tileType, row.kind),
        markdown: firstString(row.markdown, row.body, row.text),
      };
    });

  return tiles.sort((a, b) => a.order - b.order);
}

function readTileFilters(tiles: OmniDashboardDownloadTile[], data: unknown): OmniDashboardDownloadFilter[] {
  const record = isRecord(data) ? data : {};
  const rawTiles = Array.isArray(record.queries)
    ? record.queries
    : Array.isArray(record.tiles)
      ? record.tiles
      : [];
  const out: OmniDashboardDownloadFilter[] = [];
  for (let index = 0; index < rawTiles.length; index += 1) {
    const raw = rawTiles[index];
    if (!isRecord(raw)) continue;
    const queryBody = isRecord(raw.query) ? raw.query : raw;
    if (!isRecord(queryBody.filters)) continue;
    for (const [field, meta] of Object.entries(queryBody.filters)) {
      if (!isRecord(meta)) continue;
      out.push({
        field,
        label: humanizeField(field),
        kind: firstString(meta.kind),
        type: firstString(meta.type),
        values: Array.isArray(meta.values) ? meta.values.slice() : [],
        isNegative: meta.is_negative === true || meta.isNegative === true,
        topic: firstString(queryBody.topic, queryBody.topicName, queryBody.topic_name),
        view: fieldViewName(field),
        source: 'tile',
      });
    }
  }
  void tiles;
  return out;
}

function mergeDashboardDownloadFilters(...groups: OmniDashboardDownloadFilter[][]): OmniDashboardDownloadFilter[] {
  const seen = new Map<string, OmniDashboardDownloadFilter>();
  for (const filters of groups) {
    for (const filter of filters) {
      const existing = seen.get(filter.field);
      if (existing) {
        seen.set(filter.field, {
          ...existing,
          ...Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== '')),
          values: existing.values.length > 0 ? existing.values : filter.values,
        });
      } else {
        seen.set(filter.field, filter);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => (a.label || a.field).localeCompare(b.label || b.field));
}

export class OmniClient {
  constructor(private readonly instance: Pick<SavedInstance, 'baseUrl' | 'apiKey' | 'label'>) {
    const urlError = validateBaseUrl(instance.baseUrl);
    if (urlError) throw new Error(urlError);
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = this.instance.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(method: string, path: string, options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    accept?: string;
  } = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.instance.apiKey}`,
      Accept: options.accept || 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await acquireSlot(this.instance.apiKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.status === 429 && attempt < MAX_RETRIES) {
          await sleep(retryAfterMs(response.headers.get('retry-after'), attempt));
          continue;
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new OmniClientError(response.status, url, text.slice(0, 500) || response.statusText);
        }
        return response;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (error instanceof OmniClientError && error.status < 500 && error.status !== 429) throw error;
        if (attempt >= MAX_RETRIES) break;
        await sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Omni request failed.');
  }

  async test(): Promise<void> {
    await this.request('GET', '/api/v1/folders', { query: { pageSize: 1 } });
  }

  async listConnections(): Promise<OmniConnectionRecord[]> {
    const response = await this.request('GET', '/api/v1/connections');
    const data = await response.json();
    return extractArray(data, ['connections', 'records', 'data']).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        dialect: String(row.dialect ?? ''),
        database: String(row.database ?? ''),
        defaultSchema: firstString(row.defaultSchema, row.default_schema, row.default_schema_name, row.schema),
        deletedAt: firstString(row.deletedAt, row.deleted_at) ?? null,
      };
    }).filter((connection) => connection.id);
  }

  async listSchemaModels(): Promise<OmniSchemaModelRecord[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/models', {
        query: {
          pageSize: 100,
          sortDirection: 'desc',
          sortField: 'updatedAt',
          modelKind: 'SCHEMA',
          cursor,
        },
      });
      const data = await response.json();
      all.push(...extractArray(data, ['models', 'records', 'data', 'items']));
      const pageInfo = extractPageInfo(data);
      cursor = pageInfo?.hasNextPage ? pageInfo.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 50);

    return all.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id ?? ''),
        name: String(row.name ?? row.identifier ?? ''),
        connectionId: firstString(row.connectionId, row.connection_id, nested(row, 'connection', 'id')),
        createdAt: firstString(row.createdAt, row.created_at),
        updatedAt: firstString(row.updatedAt, row.updated_at),
        deletedAt: firstString(row.deletedAt, row.deleted_at) ?? null,
      };
    }).filter((model) => model.id);
  }

  async listModels(modelKindOrOptions: string | OmniListModelsOptions = 'SHARED'): Promise<OmniModelRecord[]> {
    const options: OmniListModelsOptions = typeof modelKindOrOptions === 'string'
      ? { modelKind: modelKindOrOptions }
      : modelKindOrOptions;
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/models', {
        query: {
          pageSize: 100,
          sortField: 'name',
          sortDirection: 'asc',
          modelKind: options.modelKind || 'SHARED',
          connectionId: options.connectionId,
          baseModelId: options.baseModelId,
          modelId: options.modelId,
          name: options.name,
          includeDeleted: options.includeDeleted === true ? true : undefined,
          include: options.include,
          cursor,
        },
      });
      const data = await response.json();
      all.push(...extractArray(data, ['models', 'records', 'data', 'items']));
      const pageInfo = extractPageInfo(data);
      cursor = pageInfo?.hasNextPage ? pageInfo.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 50);

    return all.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id ?? ''),
        name: firstString(row.name, row.label, row.displayName, row.display_name, row.identifier) ?? String(row.id ?? ''),
        identifier: firstString(row.identifier, row.slug, row.key),
        connectionId: firstString(row.connectionId, row.connection_id, nested(row, 'connection', 'id')),
        connectionName: firstString(row.connectionName, row.connection_name, nested(row, 'connection', 'name')),
        baseModelId: firstString(row.baseModelId, row.base_model_id, nested(row, 'baseModel', 'id')),
        kind: firstString(row.kind, row.modelKind, row.model_kind, row.type),
        gitConfigured: Boolean(row.gitRepository || row.git_repository || row.gitRepo || row.git_repo || nested(row, 'git', 'repository') || nested(row, 'gitConfig', 'repository')),
        pullRequestRequired: Boolean(
          row.pullRequestRequired
          || row.pull_request_required
          || row.prRequired
          || row.pr_required
          || nested(row, 'git', 'pullRequestRequired')
          || nested(row, 'gitConfig', 'pullRequestRequired')
        ),
        gitProtected: Boolean(
          row.gitProtected
          || row.git_protected
          || row.protected
          || nested(row, 'git', 'protected')
          || nested(row, 'gitConfig', 'protected')
        ),
        createdAt: firstString(row.createdAt, row.created_at),
        updatedAt: firstString(row.updatedAt, row.updated_at),
        deletedAt: firstString(row.deletedAt, row.deleted_at) ?? null,
      };
    }).filter((model) => model.id);
  }

  async listFolders(): Promise<OmniFolderRecord[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/folders', {
        query: {
          pageSize: 100,
          sortField: 'name',
          sortDirection: 'asc',
          include: 'labels',
          cursor,
        },
      });
      const data = await response.json();
      all.push(...extractArray(data, ['folders', 'records', 'data', 'items']));
      const pageInfo = extractPageInfo(data);
      cursor = pageInfo?.hasNextPage ? pageInfo.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 50);

    const normalizeFolder = (raw: unknown): OmniFolderRecord | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const identifier = firstString(row.identifier, row.slug, row.filePath, row.file_path, row.path);
      const id = firstString(row.id, row.uuid, row.folderId, row.folder_id) || identifier;
      const children = Array.isArray(row.children)
        ? row.children.map(normalizeFolder).filter((folder): folder is OmniFolderRecord => Boolean(folder))
        : undefined;
      if (!id) return null;
      return {
        id,
        name: firstString(row.name, row.label, row.title, identifier) || id,
        identifier,
        path: firstString(row.path, row.folderPath, row.folder_path, row.filePath, row.file_path, identifier),
        parentId: firstString(row.parentId, row.parent_id),
        children,
      };
    };

    return all.map(normalizeFolder).filter((folder): folder is OmniFolderRecord => Boolean(folder));
  }

  async listFolderDocuments(folderId?: string, includeLabels = false): Promise<OmniDocumentRecord[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/documents', {
        query: {
          pageSize: 100,
          sortField: 'name',
          sortDirection: 'asc',
          folderId,
          include: includeLabels ? 'labels' : undefined,
          cursor,
        },
      });
      const data = await response.json();
      all.push(...extractArray(data, ['documents', 'dashboards', 'records', 'data', 'items']));
      const pageInfo = extractPageInfo(data);
      cursor = pageInfo?.hasNextPage ? pageInfo.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 50);

    return all.map((raw) => {
      const row = raw as Record<string, unknown>;
      const content = row.content && typeof row.content === 'object' && !Array.isArray(row.content)
        ? row.content as Record<string, unknown>
        : {};
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      const id = String(row.identifier ?? row.id ?? row.slug ?? '');
      return {
        id,
        identifier: id,
        name: String(row.name ?? ''),
        connectionId: firstString(row.connectionId, row.connection_id, nested(row, 'connection', 'id')),
        folderId: firstString(row.folderId, row.folder_id, nested(row, 'folder', 'id')),
        folderPath: firstString(row.folderPath, row.folder_path, row.path, nested(row, 'folder', 'path')),
        baseModelId: firstString(
          row.sharedModelId,
          row.shared_model_id,
          row.baseModelId,
          row.base_model_id,
          content.sharedModelId,
          content.shared_model_id,
          content.baseModelId,
          content.base_model_id,
          metadata.sharedModelId,
          metadata.shared_model_id,
          nested(row, 'baseModel', 'id'),
          nested(row, 'model', 'id'),
        ),
        type: firstString(row.type, row.documentType, row.document_type, content.type, metadata.type),
        hasDashboard: typeof row.hasDashboard === 'boolean'
          ? row.hasDashboard
          : typeof row.has_dashboard === 'boolean'
            ? row.has_dashboard
            : typeof content.hasDashboard === 'boolean'
              ? content.hasDashboard
              : typeof content.has_dashboard === 'boolean'
                ? content.has_dashboard
                : null,
        description: typeof row.description === 'string' ? row.description : null,
        labels: Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === 'string') : undefined,
        updatedAt: firstString(row.updatedAt, row.updated_at),
      };
    }).filter((document) => document.id && document.name);
  }

  async getDashboardDownloadDetails(dashboardId: string): Promise<OmniDashboardDownloadDetails> {
    const queryResponse = await this.request('GET', `/api/v1/documents/${encodeURIComponent(dashboardId)}/queries`);
    const queryData = await queryResponse.json();
    let name = pickDashboardName(queryData, dashboardId);

    if (name === `Dashboard ${dashboardId}`) {
      try {
        const metaResponse = await this.request('GET', `/api/v1/documents/${encodeURIComponent(dashboardId)}`);
        const metaData = await metaResponse.json();
        name = pickDashboardName(metaData, dashboardId);
      } catch {
        // Metadata fallback is best-effort; query payload is enough for downloads.
      }
    }

    const tiles = readDashboardDownloadTiles(queryData);
    let apiFilters: OmniDashboardDownloadFilter[] = [];
    try {
      const filterResponse = await this.request('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/filters`);
      apiFilters = readDashboardFilterEntries(await filterResponse.json());
    } catch {
      apiFilters = [];
    }

    return {
      id: dashboardId,
      name,
      tiles,
      filters: mergeDashboardDownloadFilters(
        readDocFilterEntries(queryData),
        apiFilters,
        readTileFilters(tiles, queryData),
      ),
    };
  }

  async startDashboardDownload(dashboardId: string, body: Record<string, unknown>): Promise<OmniDashboardDownloadStartResult> {
    const response = await this.request('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/download`, { body });
    const raw = await response.json();
    const record = isRecord(raw) ? raw : {};
    const jobId = firstString(record.job_id, record.jobId, record.id, record.download_job_id);
    if (!jobId) throw new Error('No job ID returned from Omni.');
    return { jobId, raw };
  }

  async getDashboardDownloadStatus(dashboardId: string, jobId: string): Promise<OmniDashboardDownloadStatus> {
    const response = await this.request('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/download/${encodeURIComponent(jobId)}/status`);
    const raw = await response.json();
    const record = isRecord(raw) ? raw : {};
    return {
      status: firstString(record.status, record.state) || 'processing',
      error: firstString(record.error, record.message, record.detail),
      raw,
    };
  }

  async getDashboardDownloadFile(dashboardId: string, jobId: string): Promise<Response> {
    return this.request('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/download/${encodeURIComponent(jobId)}`, {
      accept: '*/*',
    });
  }

  async listLabels(): Promise<OmniLabelRecord[]> {
    const response = await this.request('GET', '/api/v1/labels');
    const data = await response.json();
    return extractArray(data, ['labels', 'records', 'data']).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        name: String(row.name ?? ''),
        color: firstString(row.color) ?? null,
        description: firstString(row.description) ?? null,
      };
    }).filter((label) => label.name);
  }

  async getModelYamlFiles(modelId: string): Promise<Record<string, string>> {
    const data = await this.getModelYaml(modelId, { fullyResolved: true });
    return data.files;
  }

  async listModelTopics(modelId: string, options: { includeYaml?: boolean; includeChecksums?: boolean } = {}): Promise<OmniModelTopicRecord[]> {
    const yaml = await this.getModelYaml(modelId, { includeChecksums: options.includeChecksums });
    return Object.entries(yaml.files)
      .filter(([filePath]) => filePath.split('/').pop()?.endsWith('.topic'))
      .map(([filePath, content]) => {
        const fileName = filePath.split('/').pop() || filePath;
        const name = fileName.replace(/\.topic$/, '');
        const label = firstString(content.match(/^label:\s*["']?(.+?)["']?\s*$/m)?.[1]);
        const description = firstString(content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]);
        return {
          name,
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          fileName: filePath,
          ...(options.includeYaml ? { yaml: content } : {}),
          ...(yaml.checksums?.[filePath] ? { checksum: yaml.checksums[filePath] } : {}),
        };
      })
      .filter((topic) => topic.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModelYaml(modelId: string, options: {
    branchId?: string;
    fileName?: string;
    mode?: 'combined' | 'extension' | 'staged' | 'merged' | 'history';
    includeChecksums?: boolean;
    fullyResolved?: boolean;
  } = {}): Promise<OmniModelYamlResponse> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/yaml`, {
      query: {
        branchId: options.branchId,
        fileName: options.fileName,
        mode: options.mode,
        includeChecksums: options.includeChecksums,
        fullyResolved: options.fullyResolved,
      },
    });
    const data = await response.json() as Record<string, unknown>;
    const files = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).files
      : null;
    const normalizedFiles = !files || typeof files !== 'object' || Array.isArray(files)
      ? {}
      : Object.fromEntries(
      Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const checksums = data.checksums && typeof data.checksums === 'object' && !Array.isArray(data.checksums)
      ? Object.fromEntries(Object.entries(data.checksums).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined;
    return { files: normalizedFiles, checksums, raw: data };
  }

  async createModelBranch(input: { connectionId: string; baseModelId: string; branchName: string }): Promise<OmniModelBranchResult> {
    const response = await this.request('POST', '/api/v1/models', {
      body: {
        connectionId: input.connectionId,
        modelName: input.branchName,
        modelKind: 'BRANCH',
        baseModelId: input.baseModelId,
      },
    });
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    const id = firstString(raw.id, raw.modelId, raw.model_id, raw.branchId, raw.branch_id, nested(raw, 'model', 'id'), nested(raw, 'branch', 'id')) ?? '';
    const name = firstString(raw.name, raw.modelName, raw.model_name, raw.branchName, raw.branch_name, nested(raw, 'model', 'name'), nested(raw, 'branch', 'name')) ?? input.branchName;
    if (!id) throw new Error('Omni did not return a branch model id.');
    return { id, name, raw };
  }

  async findModelBranch(baseModelId: string, branchName: string): Promise<OmniModelBranchResult | null> {
    const branches = await this.listModels('BRANCH');
    const normalizedBranchName = branchName.trim().toLowerCase();
    const match = branches.find((branch) => (
      branch.baseModelId === baseModelId
      && [branch.name, branch.identifier, branch.id]
        .filter(Boolean)
        .some((value) => value?.trim().toLowerCase() === normalizedBranchName)
    ));
    return match ? { id: match.id, name: match.name || branchName, raw: match } : null;
  }

  async updateModelYamlFile(input: {
    modelId: string;
    fileName: string;
    yaml: string;
    branchId?: string;
    previousChecksum?: string;
    commitMessage?: string;
  }): Promise<unknown> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.modelId)}/yaml`, {
      body: {
        fileName: input.fileName,
        yaml: input.yaml,
        mode: 'combined',
        branchId: input.branchId,
        previousChecksum: input.previousChecksum,
        commitMessage: input.commitMessage,
      },
    });
    return response.json().catch(() => ({}));
  }

  async updateModelYamlFiles(input: {
    modelId: string;
    branchId: string;
    files: Array<{ fileName: string; yaml: string; previousChecksum?: string }>;
    commitMessage?: string;
  }): Promise<unknown> {
    if (input.files.length === 0) return {};
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.modelId)}/yaml`, {
      body: {
        mode: 'combined',
        branchId: input.branchId,
        commitMessage: input.commitMessage,
        files: input.files.map((file) => ({
          fileName: file.fileName,
          yaml: file.yaml,
          previousChecksum: file.previousChecksum,
        })),
      },
    });
    return response.json().catch(() => ({}));
  }

  async validateModel(modelId: string, branchId?: string): Promise<OmniValidationIssue[]> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/validate`, {
      query: branchId ? { branchId } : undefined,
    });
    const data = await response.json().catch(() => []) as unknown;
    return extractArray(data, ['issues', 'errors', 'warnings', 'data']).map((issue) => issue as OmniValidationIssue);
  }

  async validateModelContent(modelId: string, branchId?: string): Promise<Record<string, unknown>> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/content-validator`, {
      query: branchId ? { branch_id: branchId } : undefined,
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async migrateModel(input: {
    sourceModelId: string;
    gitRef?: string;
    targetModelId: string;
    branchName: string;
    commitMessage: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.sourceModelId)}/migrate`, {
      body: {
        gitRef: input.gitRef,
        targetModelId: input.targetModelId,
        branchName: input.branchName,
        commitMessage: input.commitMessage,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async mergeModelBranch(modelId: string, branchName: string, options: {
    publishDrafts?: boolean;
    deleteBranch?: boolean;
    forceOverrideGitSettings?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/branch/${encodeURIComponent(branchName)}/merge`, {
      body: {
        publish_drafts: options.publishDrafts === true,
        delete_branch: options.deleteBranch === true,
        force_override_git_settings: options.forceOverrideGitSettings === true,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async getDocumentQueries(documentId: string): Promise<OmniDocumentQueryRecord[]> {
    const response = await this.request('GET', `/api/v1/documents/${encodeURIComponent(documentId)}/queries`);
    const data = await response.json().catch(() => []) as unknown;
    return extractArray(data, ['queries', 'queryPresentations', 'records', 'data', 'items']).map((raw) => {
      const row = raw as Record<string, unknown>;
      const query = row.query && typeof row.query === 'object' && !Array.isArray(row.query)
        ? row.query as Record<string, unknown>
        : {};
      const visConfig = row.visConfig && typeof row.visConfig === 'object' && !Array.isArray(row.visConfig)
        ? row.visConfig as Record<string, unknown>
        : row.vis_config && typeof row.vis_config === 'object' && !Array.isArray(row.vis_config)
          ? row.vis_config as Record<string, unknown>
          : undefined;
      return {
        id: String(row.id ?? row.identifier ?? row.name ?? ''),
        name: firstString(row.name, row.title) ?? 'Workbook tab',
        url: firstString(row.url),
        query,
        visConfig,
        description: firstString(row.description),
      };
    }).filter((query) => query.id || Object.keys(query.query).length > 0);
  }

  async createWorkbookDocument(input: OmniCreateWorkbookInput): Promise<OmniCreateWorkbookResult> {
    const body: Record<string, unknown> = {
      modelId: input.modelId,
      name: input.name,
      description: input.description || undefined,
      queryPresentations: input.queryPresentations,
    };
    if (input.folderId) body.folderId = input.folderId;
    if (input.folderPath) body.folderPath = input.folderPath;
    const response = await this.request('POST', '/api/v1/documents', { body });
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    const id = firstString(raw.id, raw.documentId, raw.document_id, nested(raw, 'document', 'id')) ?? '';
    const identifier = firstString(raw.identifier, raw.miniUuid, nested(raw, 'document', 'identifier')) ?? id;
    return {
      id,
      identifier,
      url: firstString(raw.url, nested(raw, 'document', 'url')),
      raw,
    };
  }

  async createAiJob(input: { modelId: string; prompt: string; branchId?: string }): Promise<OmniAiJobResult> {
    const response = await this.request('POST', '/api/v1/ai/jobs', {
      body: {
        modelId: input.modelId,
        prompt: input.prompt,
        branchId: input.branchId,
      },
    });
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      id: firstString(raw.id, raw.jobId, raw.job_id, nested(raw, 'job', 'id')) ?? '',
      status: firstString(raw.status, nested(raw, 'job', 'status')),
      result: raw.result,
      raw,
    };
  }

  async getAiJob(jobId: string): Promise<OmniAiJobResult> {
    const response = await this.request('GET', `/api/v1/ai/jobs/${encodeURIComponent(jobId)}`);
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      id: firstString(raw.id, raw.jobId, raw.job_id, nested(raw, 'job', 'id')) ?? jobId,
      status: firstString(raw.status, nested(raw, 'job', 'status')),
      result: raw.result,
      raw,
    };
  }

  async getAiJobResult(jobId: string): Promise<unknown> {
    const response = await this.request('GET', `/api/v1/ai/jobs/${encodeURIComponent(jobId)}/result`);
    return response.json().catch(() => ({}));
  }

  async createLabel(label: OmniLabelRecord): Promise<void> {
    await this.request('POST', '/api/v1/labels', {
      body: {
        name: label.name,
        ...(label.color ? { color: label.color } : {}),
        ...(label.description ? { description: label.description } : {}),
      },
    });
  }

  async setDocumentLabels(identifier: string, add: string[]): Promise<void> {
    if (add.length === 0) return;
    await this.request('PATCH', `/api/v1/documents/${encodeURIComponent(identifier)}/labels`, {
      body: { add, remove: [] },
    });
  }

  async patchDocument(identifier: string, body: { description?: string | null; clearExistingDraft?: boolean }): Promise<void> {
    await this.request('PATCH', `/api/v1/documents/${encodeURIComponent(identifier)}`, { body });
  }

  async requestDeleteDocument(identifier: string): Promise<void> {
    await this.request('DELETE', `/api/v1/documents/${encodeURIComponent(identifier)}`);
  }

  async exportDocument(identifier: string): Promise<Record<string, unknown>> {
    const response = await this.request('GET', `/api/unstable/documents/${encodeURIComponent(identifier)}/export`);
    return await response.json() as Record<string, unknown>;
  }

  async importDocument(input: {
    exportPayload: Record<string, unknown>;
    baseModelId: string;
    folderPath?: string;
    documentName: string;
  }): Promise<{ identifier: string; documentId: string; raw: unknown }> {
    const payload: Record<string, unknown> = {
      ...input.exportPayload,
      baseModelId: input.baseModelId,
      document: {
        ...((input.exportPayload.document && typeof input.exportPayload.document === 'object' && !Array.isArray(input.exportPayload.document))
          ? input.exportPayload.document as Record<string, unknown>
          : {}),
        name: input.documentName,
      },
    };
    if (input.folderPath) payload.folderPath = input.folderPath;
    delete payload.identifier;

    const response = await this.request('POST', '/api/unstable/documents/import', { body: payload });
    const raw = await response.json() as Record<string, unknown>;
    const identifier = firstString(raw.identifier, raw.miniUuid, nested(raw, 'document', 'identifier')) ?? '';
    const documentId = firstString(raw.documentId, raw.id, nested(raw, 'document', 'id')) ?? '';
    return { identifier, documentId, raw };
  }

  async moveDocument(documentId: string, folderPath: string): Promise<void> {
    await this.request('PUT', `/api/v1/documents/${encodeURIComponent(documentId)}/move`, {
      body: { folderPath },
    });
  }

  async refreshModel(modelId: string): Promise<{ jobId?: string; status?: string; raw: unknown }> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/refresh`);
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      jobId: firstString(raw.jobId, raw.job_id, raw.id, nested(raw, 'job', 'id')),
      status: firstString(raw.status, nested(raw, 'job', 'status')),
      raw,
    };
  }

  async listEmbedUsers(): Promise<OmniEmbedUserRecord[]> {
    const users: OmniEmbedUserRecord[] = [];
    let startIndex = 1;
    const count = 100;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.request('GET', '/api/scim/v2/embed/users', {
        query: { count, startIndex },
      });
      const data = await response.json() as { Resources?: unknown[]; totalResults?: number };
      const resources = Array.isArray(data.Resources) ? data.Resources : [];
      users.push(...resources.map((raw) => {
        const row = raw as Record<string, unknown>;
        const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
          ? row.meta as Record<string, unknown>
          : {};
        const extension = row['urn:omni:params:scim:schemas:extension:user:2.0'];
        const extensionRecord = extension && typeof extension === 'object' && !Array.isArray(extension)
          ? extension as Record<string, unknown>
          : {};
        return {
          id: String(row.id ?? ''),
          displayName: String(row.displayName ?? ''),
          userName: String(row.userName ?? ''),
          active: row.active !== false,
          embedExternalId: String(row.embedExternalId ?? row.externalId ?? ''),
          groups: Array.isArray(row.groups)
            ? row.groups.map((group) => {
              const groupRecord = group as Record<string, unknown>;
              return {
                display: String(groupRecord.display ?? ''),
                value: String(groupRecord.value ?? ''),
              };
            })
            : [],
          lastLogin: firstString(extensionRecord.lastLogin) ?? null,
          createdAt: firstString(meta.created),
        };
      }).filter((user) => user.id));
      const total = typeof data.totalResults === 'number' ? data.totalResults : users.length;
      if (users.length >= total || resources.length < count) break;
      startIndex += resources.length;
    }
    return users;
  }
}
