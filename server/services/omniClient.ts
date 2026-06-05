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
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
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
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
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
  } = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.instance.apiKey}`,
      Accept: 'application/json',
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

  async listModels(modelKind = 'SHARED'): Promise<OmniModelRecord[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/models', {
        query: {
          pageSize: 100,
          sortField: 'name',
          sortDirection: 'asc',
          modelKind,
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
        description: typeof row.description === 'string' ? row.description : null,
        labels: Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === 'string') : undefined,
        updatedAt: firstString(row.updatedAt, row.updated_at),
      };
    }).filter((document) => document.id && document.name);
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
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/yaml`, {
      query: { fullyResolved: true },
    });
    const data = await response.json();
    const files = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).files
      : null;
    if (!files || typeof files !== 'object' || Array.isArray(files)) return {};
    return Object.fromEntries(
      Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
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
