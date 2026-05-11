function edgeFunctionUrl(name: string): string {
  return `/api/${name}`;
}

const defaultHeaders = {
  'Content-Type': 'application/json',
};

export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was invalid. Please check your input and try again.',
  401: 'Authentication failed. Please verify your API key is correct.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested resource was not found. Check your Base URL.',
  408: 'The request timed out. Please try again.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'An internal server error occurred. Please try again later.',
  502: 'The server is temporarily unavailable. Please try again later.',
  503: 'The service is currently unavailable. Please try again later.',
};

function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('text/html');
}

async function handleResponse(res: Response, context: string): Promise<Response> {
  if (res.ok) {
    if (isHtmlResponse(res)) {
      throw new ApiError(
        502,
        'The server returned an unexpected response. This is usually temporary -- please try again.',
      );
    }
    return res;
  }

  if (isHtmlResponse(res)) {
    throw new ApiError(
      res.status,
      STATUS_MESSAGES[res.status] || `${context} failed (HTTP ${res.status}). Please try again.`,
    );
  }

  let serverMessage = '';
  let detail = '';
  try {
    const body = await res.json();
    serverMessage = body.error || body.message || '';
    detail = body.detail || (typeof body === 'string' ? body : JSON.stringify(body));
  } catch {
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
  }

  const friendlyMessage =
    serverMessage ||
    STATUS_MESSAGES[res.status] ||
    `${context} failed (HTTP ${res.status})`;

  throw new ApiError(res.status, friendlyMessage, detail || undefined);
}

async function safeFetch(url: string, options: RequestInit, context: string): Promise<Response> {
  try {
    const res = await fetch(url, options);
    return await handleResponse(res, context);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof TypeError) {
      throw new ApiError(0, 'Network error -- check your internet connection and try again.');
    }
    throw new ApiError(0, err instanceof Error ? err.message : `${context} failed unexpectedly.`);
  }
}

export async function testConnection(baseUrl: string, apiKey: string) {
  const res = await safeFetch(
    edgeFunctionUrl('test-connection'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }) },
    'Connection test'
  );
  return res.json();
}

export async function listFolders(baseUrl: string, apiKey: string) {
  const res = await safeFetch(
    edgeFunctionUrl('list-folders'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }) },
    'List folders'
  );
  return res.json();
}

export async function listDocuments(baseUrl: string, apiKey: string, folderId?: string) {
  const res = await safeFetch(
    edgeFunctionUrl('list-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, folder_id: folderId }) },
    'List documents'
  );
  return res.json();
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
  options?: { connectionId?: string; modelKind?: string }
) {
  const res = await safeFetch(
    edgeFunctionUrl('list-models'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        model_kind: options?.modelKind,
        connection_id: options?.connectionId,
      }),
    },
    'List models'
  );
  return res.json();
}

export interface EnrichmentResult {
  baseModelId: string | null;
  baseModelName: string | null;
  topicNames: string[] | null;
  connectionName: string | null;
  connectionId: string | null;
  enrichmentError: string | null;
}

async function enrichDocumentsNetwork(
  baseUrl: string,
  apiKey: string,
  documentIds: string[]
): Promise<Record<string, EnrichmentResult>> {
  const res = await safeFetch(
    edgeFunctionUrl('enrich-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, document_ids: documentIds }) },
    'Enrich documents'
  );
  const data = await res.json();
  const map: Record<string, EnrichmentResult> = {};
  if (Array.isArray(data.enrichments)) {
    for (const e of data.enrichments) {
      map[e.id] = {
        baseModelId: e.baseModelId || null,
        baseModelName: e.baseModelName || null,
        topicNames: Array.isArray(e.topicNames) ? e.topicNames : null,
        connectionName: e.connectionName || null,
        connectionId: e.connectionId || null,
        enrichmentError: e.enrichmentError || null,
      };
    }
  }
  return map;
}

export async function enrichDocuments(
  baseUrl: string,
  apiKey: string,
  documentIds: string[]
): Promise<Record<string, EnrichmentResult>> {
  if (documentIds.length === 0) return {};
  const { getCachedEnrichments, setCachedEnrichments } = await import('./enrichmentCache');
  const { hits, missing } = getCachedEnrichments(baseUrl, documentIds);
  if (missing.length === 0) return hits;
  const fresh = await enrichDocumentsNetwork(baseUrl, apiKey, missing);
  setCachedEnrichments(baseUrl, fresh);
  return { ...hits, ...fresh };
}

interface MigrateParams {
  source: { base_url: string; api_key: string };
  target: { base_url: string; api_key: string };
  dashboards: { id: string; name: string; base_model_id?: string }[];
  model_mapping: Record<string, string>;
  target_folder?: string;
  dry_run: boolean;
  in_place?: boolean;
}

async function consumeSseStream(
  res: Response,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(0, 'No response stream available.');

  const decoder = new TextDecoder();
  let buffer = '';
  let receivedComplete = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.type === 'heartbeat') continue;
          if (data.type === 'complete') receivedComplete = true;
          onEvent(data);
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }

  if (buffer.trim().startsWith('data: ')) {
    try {
      const data = JSON.parse(buffer.trim().slice(6));
      if (data.type === 'heartbeat') {
        // skip
      } else {
        if (data.type === 'complete') receivedComplete = true;
        onEvent(data);
      }
    } catch {
      // skip
    }
  }

  if (!receivedComplete) {
    onEvent({
      type: 'complete',
      summary: { succeeded: 0, failed: 0, skipped: 0, total: 0 },
      results: [],
      warning: 'Connection ended before operation completed. Results may be incomplete.',
    });
  }
}

export async function migrate(
  params: MigrateParams,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('migrate'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Migration'
  );
  await consumeSseStream(res, onEvent);
}

export async function bulkDeleteDocuments(
  params: {
    base_url: string;
    api_key: string;
    document_ids: Array<{ id: string; name: string }>;
  },
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('bulk-delete-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Bulk delete'
  );
  await consumeSseStream(res, onEvent);
}

export async function bulkMoveDocuments(
  params: {
    base_url: string;
    api_key: string;
    document_ids: Array<{ id: string; name: string; base_model_id?: string }>;
    target_folder_path: string;
    target_folder_id?: string;
    scope?: string;
  },
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('bulk-move-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Bulk move'
  );
  await consumeSseStream(res, onEvent);
}

export async function bulkCopyDocuments(
  params: {
    base_url: string;
    api_key: string;
    document_ids: Array<{ id: string; name: string; base_model_id?: string }>;
    target_folder_path: string;
    target_folder_id?: string;
    scope?: string;
    base_model_id_override?: string;
    rename_suffix?: string;
  },
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('bulk-copy-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Bulk copy'
  );
  await consumeSseStream(res, onEvent);
}

export async function listUsers(baseUrl: string, apiKey: string, count = 100, startIndex = 1) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', count, start_index: startIndex }) },
    'List users'
  );
  return res.json();
}

export async function findUserByEmail(baseUrl: string, apiKey: string, email: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'find', email }) },
    'Find user'
  );
  return res.json();
}

export async function createUser(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', user_data: body }) },
    'Create user'
  );
  return res.json();
}

export async function updateUser(baseUrl: string, apiKey: string, userId: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', user_id: userId, user_data: body }) },
    'Update user'
  );
  return res.json();
}

export async function deleteUser(baseUrl: string, apiKey: string, userId: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'delete', user_id: userId }) },
    'Delete user'
  );
  return res.json();
}

export async function listGroups(baseUrl: string, apiKey: string, count = 100, startIndex = 1) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', count, start_index: startIndex }) },
    'List groups'
  );
  return res.json();
}

export async function getGroup(baseUrl: string, apiKey: string, groupId: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'get', group_id: groupId }) },
    'Get group'
  );
  return res.json();
}

export async function updateGroup(baseUrl: string, apiKey: string, groupId: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', group_id: groupId, group_data: body }) },
    'Update group'
  );
  return res.json();
}

export async function createModel(
  baseUrl: string,
  apiKey: string,
  connectionId: string,
  modelName: string,
  modelKind = 'SHARED',
  baseModelId?: string
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-models'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', connection_id: connectionId, model_name: modelName, model_kind: modelKind, base_model_id: baseModelId }) },
    'Create model'
  );
  return res.json();
}

export async function listTopics(baseUrl: string, apiKey: string, modelId: string): Promise<Array<{ name: string; label?: string; description?: string }>> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', model_id: modelId }) },
    'List topics'
  );
  const data = await res.json();
  return Array.isArray(data.topics) ? data.topics : [];
}

export async function getTopic(baseUrl: string, apiKey: string, modelId: string, topicName: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'get', model_id: modelId, topic_name: topicName }) },
    'Get topic'
  );
  return res.json();
}

export async function createTopic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  baseViewName: string,
  body: Record<string, unknown>
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', model_id: modelId, base_view_name: baseViewName, topic_data: body }) },
    'Create topic'
  );
  return res.json();
}

export async function updateTopic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  topicName: string,
  body: Record<string, unknown>
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', model_id: modelId, topic_name: topicName, topic_data: body }) },
    'Update topic'
  );
  return res.json();
}

export async function deleteTopic(baseUrl: string, apiKey: string, modelId: string, topicName: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'delete', model_id: modelId, topic_name: topicName }) },
    'Delete topic'
  );
  return res.json();
}

export interface InspectExportResult {
  documentId: string;
  diagnostics: {
    topLevelKeys: string[];
    payloadSizeBytes: number;
    modelIdLocations: Array<{ path: string; key: string; value: string }>;
    modelIdCount: number;
    hasTopLevelModelId: boolean;
    envelopePattern: { pattern: string; innerKeys: string[] } | null;
    nullOrUndefinedFields: string[];
  };
  rawPayload: unknown;
  error?: string;
}

export async function inspectExport(
  baseUrl: string,
  apiKey: string,
  documentId: string
): Promise<InspectExportResult> {
  const res = await safeFetch(
    edgeFunctionUrl('inspect-export'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, document_id: documentId }),
    },
    'Inspect export'
  );
  return res.json();
}

export async function omniProxy<T = unknown>(
  baseUrl: string,
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  endpoint: string,
  options?: { body?: unknown; queryParams?: Record<string, string>; rawResponse?: boolean }
): Promise<T> {
  const res = await safeFetch(
    edgeFunctionUrl('omni-proxy'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        method,
        endpoint,
        body: options?.body,
        query_params: options?.queryParams,
        raw_response: options?.rawResponse,
      }),
    },
    `${method} ${endpoint}`
  );
  return res.json();
}

export async function omniProxyDownload(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
): Promise<Blob> {
  const res = await safeFetch(
    edgeFunctionUrl('omni-proxy'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        method: 'GET',
        endpoint,
        raw_response: true,
      }),
    },
    `GET ${endpoint}`
  );
  return res.blob();
}

export interface DeckFilterDefaultsRow {
  defaults: Record<string, unknown>;
  dashboard_name: string;
  synced_at: string;
}

import { deckFilterDefaultsCache } from './deckBuilder/localCache';

export async function fetchDeckFilterDefaults(
  omniBaseUrl: string,
  dashboardId: string,
): Promise<DeckFilterDefaultsRow | null> {
  return deckFilterDefaultsCache.load(omniBaseUrl, dashboardId);
}

export async function upsertDeckFilterDefaults(
  omniBaseUrl: string,
  dashboardId: string,
  dashboardName: string,
  defaults: Record<string, unknown>,
): Promise<void> {
  deckFilterDefaultsCache.save(omniBaseUrl, dashboardId, dashboardName, defaults);
}

export async function generateEmbedUrl(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('generate-embed-url'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, embed_data: body }) },
    'Generate embed URL'
  );
  return res.json();
}
