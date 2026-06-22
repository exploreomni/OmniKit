import { jsonHeaders, validateBaseUrl } from '../security';
import {
  deleteInstance,
  getInstance,
  isVaultUnlocked,
  listInstances,
  markInstanceValidated,
  upsertInstance,
  type InstanceMetricFilter,
  type InstanceRole,
  type PostMigrationAction,
  type SavedInstance,
} from '../services/nativeVault';
import { OmniClient, type OmniDocumentRecord, type OmniModelRecord } from '../services/omniClient';
import { importLegacyVault } from '../services/legacyVaultImport';
import { validatePostMigrationActionTarget } from '../services/postMigrationActions';
import { redactSensitiveText } from '../services/jobSanitizer';
import { createPerformanceTracker } from '../services/performanceTimings';
import { readThroughCache } from '../services/readThroughCache';

const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeFolderPath(value: string | undefined): string {
  return (value || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nestedString(obj: unknown, ...path: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current : undefined;
}

const MODEL_PLACEHOLDER_VALUES = new Set([
  'unknown',
  'model unknown',
  'model not detected',
  'not detected',
  'n/a',
  'none',
  '-',
]);

function cleanModelMetadata(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return MODEL_PLACEHOLDER_VALUES.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

function findStringByKey(obj: unknown, keys: string[], maxDepth = 6): string | undefined {
  if (maxDepth <= 0) return undefined;
  if (Array.isArray(obj)) {
    for (const value of obj) {
      const found = findStringByKey(value, keys, maxDepth - 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const value of Object.values(obj)) {
    const found = findStringByKey(value, keys, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function collectTopicMetadata(payload: unknown): { topicNames: string[]; topicIds: string[] } {
  const topicNames = new Set<string>();
  const topicIds = new Set<string>();

  function addName(value: unknown): void {
    const cleaned = cleanModelMetadata(value);
    if (cleaned) topicNames.add(cleaned);
  }

  function addId(value: unknown): void {
    const cleaned = cleanModelMetadata(value);
    if (cleaned) topicIds.add(cleaned);
  }

  function walk(value: unknown, maxDepth = 8): void {
    if (maxDepth <= 0 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') walk(item, maxDepth - 1);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    addName(record.topicName);
    addName(record.topic_name);
    if (typeof record.topic === 'string') addName(record.topic);
    addId(record.topicId);
    addId(record.topic_id);
    addId(record.topicIdentifier);
    addId(record.topic_identifier);
    addId(record.topicKey);
    addId(record.topic_key);
    if (isRecord(record.topic)) {
      addName(record.topic.label || record.topic.name);
      addId(record.topic.id || record.topic.identifier || record.topic.name);
    }

    for (const key of ['topicNames', 'topic_names', 'topicIdentifiers', 'topic_identifiers']) {
      const raw = record[key];
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item === 'string') addName(item);
        else if (isRecord(item)) {
          addName(item.label || item.name);
          addId(item.id || item.identifier || item.name);
        }
      }
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child, maxDepth - 1);
    }
  }

  walk(payload);
  const names = [...topicNames].sort((a, b) => a.localeCompare(b));
  const ids = [...topicIds].sort((a, b) => a.localeCompare(b));
  return {
    topicNames: names,
    topicIds: ids.length > 0 ? ids : names,
  };
}

function modelLabel(model: OmniModelRecord): string {
  return model.name || model.identifier || model.id;
}

function modelNameByKey(models: OmniModelRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const model of models) {
    const label = modelLabel(model);
    for (const key of [model.id, model.identifier, model.baseModelId, model.name]) {
      if (key && !names.has(key)) names.set(key, label);
    }
  }
  return names;
}

function extractModelDetails(payload: unknown): { baseModelId?: string; baseModelName?: string } {
  const baseModelId = cleanModelMetadata(nestedString(payload, 'dashboard', 'sharedModelId')
    || nestedString(payload, 'dashboard', 'model', 'baseModelId')
    || nestedString(payload, 'dashboard', 'model', 'id')
    || nestedString(payload, 'dashboard', 'baseModel', 'id')
    || nestedString(payload, 'dashboard', 'baseModelId')
    || nestedString(payload, 'workbookModel', 'baseModelId')
    || nestedString(payload, 'workbookModel', 'id')
    || nestedString(payload, 'workbookModel', 'modelId')
    || nestedString(payload, 'document', 'sharedModelId')
    || nestedString(payload, 'document', 'baseModel', 'id')
    || nestedString(payload, 'document', 'baseModelId')
    || nestedString(payload, 'document', 'model', 'id')
    || nestedString(payload, 'model', 'id')
    || findStringByKey(payload, [
      'sharedModelId',
      'shared_model_id',
      'baseModelId',
      'base_model_id',
      'modelId',
      'model_id',
    ]));
  const baseModelName = cleanModelMetadata(nestedString(payload, 'document', 'baseModel', 'name')
    || nestedString(payload, 'dashboard', 'baseModel', 'name')
    || nestedString(payload, 'dashboard', 'model', 'name')
    || nestedString(payload, 'workbookModel', 'name')
    || nestedString(payload, 'workbookModel', 'modelName')
    || nestedString(payload, 'document', 'model', 'name')
    || nestedString(payload, 'model', 'name')
    || findStringByKey(payload, ['modelName', 'model_name'], 4));
  return { baseModelId, baseModelName };
}

function topicLabelFromYaml(content: string): string | undefined {
  const labelMatch = content.match(/^label:\s*["']?(.+?)["']?\s*$/m);
  return cleanModelMetadata(labelMatch?.[1]);
}

async function inferSingleTopicFromModel(client: OmniClient, modelId: string | undefined): Promise<{ topicNames: string[]; topicIds: string[] }> {
  const cleanModelId = cleanModelMetadata(modelId);
  if (!cleanModelId) return { topicNames: [], topicIds: [] };
  try {
    const files = await client.getModelYamlFiles(cleanModelId);
    const topics = Object.entries(files)
      .filter(([filePath]) => filePath.split('/').pop()?.endsWith('.topic'))
      .map(([filePath, content]) => {
        const fileName = filePath.split('/').pop() || filePath;
        const id = cleanModelMetadata(fileName.replace(/\.topic$/, ''));
        if (!id) return null;
        return {
          id,
          name: topicLabelFromYaml(content) || id,
        };
      })
      .filter((topic): topic is { id: string; name: string } => Boolean(topic));
    if (topics.length !== 1) return { topicNames: [], topicIds: [] };
    return { topicNames: [topics[0].name], topicIds: [topics[0].id] };
  } catch {
    return { topicNames: [], topicIds: [] };
  }
}

function activeConnectionModels(models: OmniModelRecord[], connectionId?: string): OmniModelRecord[] {
  return models
    .filter((model) => !model.deletedAt)
    .filter((model) => !connectionId || model.connectionId === connectionId);
}

async function enrichDocumentModelDetails(
  client: OmniClient,
  documents: OmniDocumentRecord[],
  options: { connectionId?: string } = {},
): Promise<OmniDocumentRecord[]> {
  const models = activeConnectionModels(
    await client.listModels({ modelKind: 'SHARED', connectionId: options.connectionId }).catch(() => [] as OmniModelRecord[]),
    options.connectionId,
  );
  const namesByKey = modelNameByKey(models);
  const connectionFallbackModel = options.connectionId && models.length === 1 ? models[0] : undefined;
  const enriched: OmniDocumentRecord[] = [];

  for (const document of documents) {
    let baseModelId = cleanModelMetadata(document.baseModelId);
    let baseModelName = cleanModelMetadata(document.baseModelName) || (baseModelId ? namesByKey.get(baseModelId) : undefined);
    let topicNames = document.topicNames || [];
    let topicIds = document.topicIds || [];
    if (!baseModelId || !baseModelName || topicNames.length === 0 || topicIds.length === 0) {
      try {
        const exportPayload = await client.exportDocument(document.identifier);
        const details = extractModelDetails(exportPayload);
        const topics = collectTopicMetadata(exportPayload);
        baseModelId ||= details.baseModelId;
        baseModelName ||= details.baseModelName || (baseModelId ? namesByKey.get(baseModelId) : undefined);
        if (topics.topicNames.length > 0) topicNames = topics.topicNames;
        if (topics.topicIds.length > 0) topicIds = topics.topicIds;
      } catch {
        // Best-effort enrichment; preflight still validates migrations before imports run.
      }
    }
    if (!baseModelId || !baseModelName || topicNames.length === 0 || topicIds.length === 0) {
      try {
        const queryDetails = await client.getDocumentQueries(document.identifier);
        const details = extractModelDetails(queryDetails);
        const topics = collectTopicMetadata(queryDetails);
        baseModelId ||= details.baseModelId;
        baseModelName ||= details.baseModelName || (baseModelId ? namesByKey.get(baseModelId) : undefined);
        if (topics.topicNames.length > 0) topicNames = topics.topicNames;
        if (topics.topicIds.length > 0) topicIds = topics.topicIds;
      } catch {
        // Query metadata is optional; keep moving with model fallback if available.
      }
    }
    if (!baseModelId && connectionFallbackModel) baseModelId = connectionFallbackModel.id;
    if (!baseModelName && baseModelId) baseModelName = namesByKey.get(baseModelId);
    if (!baseModelName && connectionFallbackModel && baseModelId === connectionFallbackModel.id) {
      baseModelName = modelLabel(connectionFallbackModel);
    }
    if ((topicNames.length === 0 || topicIds.length === 0) && baseModelId) {
      const topics = await inferSingleTopicFromModel(client, baseModelId);
      if (topicNames.length === 0) topicNames = topics.topicNames;
      if (topicIds.length === 0) topicIds = topics.topicIds;
    }
    const documentWithoutModelPlaceholders = { ...document };
    delete documentWithoutModelPlaceholders.baseModelId;
    delete documentWithoutModelPlaceholders.baseModelName;
    delete documentWithoutModelPlaceholders.topicNames;
    delete documentWithoutModelPlaceholders.topicIds;
    enriched.push({
      ...documentWithoutModelPlaceholders,
      ...(baseModelId ? { baseModelId } : {}),
      ...(baseModelName ? { baseModelName } : {}),
      ...(topicNames.length > 0 ? { topicNames } : {}),
      ...(topicIds.length > 0 ? { topicIds } : {}),
    });
  }

  return enriched;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseFilter(value: unknown): InstanceMetricFilter {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    connectionDatabaseContains: parseStringArray(record.connectionDatabaseContains),
    connectionDatabaseExact: parseStringArray(record.connectionDatabaseExact),
    embedExternalIdContains: parseStringArray(record.embedExternalIdContains),
    embedExternalIdExact: parseStringArray(record.embedExternalIdExact),
  };
}

function parseActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      kind: action.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
      name: cleanString(action.name) || 'Post-migration action',
      method: parseMethod(action.method),
      url: cleanString(action.url) || '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
      destinationInstanceId: cleanString(action.destinationInstanceId),
      targetModelId: cleanString(action.targetModelId),
      targetModelName: cleanString(action.targetModelName),
    }))
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.targetModelId) : Boolean(action.url));
}

function parseLabelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function parseMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function parseRole(value: unknown): InstanceRole {
  return value === 'source' || value === 'destination' || value === 'both' ? value : 'destination';
}

function parseInstance(body: Record<string, unknown>, id?: string): Partial<SavedInstance> & { apiKey?: string } {
  return {
    ...(id ? { id } : {}),
    label: cleanString(body.label),
    role: parseRole(body.role),
    baseUrl: cleanString(body.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    defaultModelId: cleanString(body.defaultModelId),
    defaultFolderId: cleanString(body.defaultFolderId),
    defaultFolderPath: cleanString(body.defaultFolderPath),
    entityGroupSeparator: typeof body.entityGroupSeparator === 'string' ? body.entityGroupSeparator : undefined,
    metricFilter: parseFilter(body.metricFilter),
    postMigrationActions: parseActions(body.postMigrationActions),
  };
}

function validateInstanceInput(input: Partial<SavedInstance> & { apiKey?: string }, updating = false): void {
  if (input.baseUrl) {
    const urlError = validateBaseUrl(input.baseUrl);
    if (urlError) throw new Error(urlError);
  } else if (!updating) {
    throw new Error('Instance Base URL is required.');
  }
  if (!updating && (!input.apiKey || !input.apiKey.trim())) {
    throw new Error('Instance API key is required.');
  }
  for (const action of input.postMigrationActions || []) {
    const actionError = validatePostMigrationActionTarget(action);
    if (actionError) {
      throw Object.assign(new Error(`Post-migration action "${action.name}" is invalid: ${actionError}`), { statusCode: 400 });
    }
  }
}

async function testInstance(instance: Pick<SavedInstance, 'baseUrl' | 'apiKey' | 'label'>): Promise<void> {
  const urlError = validateBaseUrl(instance.baseUrl);
  if (urlError) throw new Error(urlError);
  await new OmniClient(instance).test();
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/instances\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'GET' && parts.length === 0) {
      return json({ instances: listInstances() });
    }

    if (req.method === 'POST' && parts.length === 0) {
      const body = await bodyJson(req);
      const input = parseInstance(body);
      validateInstanceInput(input);
      const saved = upsertInstance(input);
      return json({ instance: saved });
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'import-legacy') {
      const body = await bodyJson(req);
      const legacyPath = cleanString(body.path);
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
      if (!legacyPath) return json({ error: 'Legacy vault path is required.' }, 400);
      if (!passphrase) return json({ error: 'Legacy vault passphrase is required.' }, 400);
      const result = importLegacyVault({
        path: legacyPath,
        passphrase,
        dryRun: body.dryRun === true,
        confirmAbsolutePath: body.confirmAbsolutePath === true,
      });
      return json(result);
    }

    const id = parts[0];
    if (!id) return json({ error: 'Instance id required.' }, 400);

    if (req.method === 'GET' && parts.length === 1) {
      const instance = listInstances().find((row) => row.id === id);
      if (!instance) return json({ error: 'Instance not found.' }, 404);
      return json({ instance });
    }

    if (req.method === 'PUT' && parts.length === 1) {
      const body = await bodyJson(req);
      const input = parseInstance(body, id);
      validateInstanceInput(input, true);
      const saved = upsertInstance(input);
      return json({ instance: saved });
    }

    if (req.method === 'DELETE' && parts.length === 1) {
      deleteInstance(id);
      return json({ ok: true });
    }

    if (req.method === 'POST' && parts[1] === 'test') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      await testInstance(secret);
      return json({ instance: markInstanceValidated(id) });
    }

    if (req.method === 'POST' && parts[1] === 'connect') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      await testInstance(secret);
      const instance = markInstanceValidated(id);
      return json({
        instance,
        connection: {
          baseUrl: instance.baseUrl,
          apiKey: `${VAULT_API_KEY_REFERENCE_PREFIX}${id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: id,
          instanceLabel: instance.label,
          apiKeyMasked: instance.apiKeyMasked,
        },
      });
    }

    if (req.method === 'GET' && parts[1] === 'documents') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const timings = createPerformanceTracker();
      const client = new OmniClient(secret);
      const allFolders = url.searchParams.get('allFolders') === 'true';
      const folderId = allFolders ? undefined : cleanString(url.searchParams.get('folderId')) || secret.defaultFolderId;
      const folderPath = allFolders ? undefined : cleanString(url.searchParams.get('folderPath')) || secret.defaultFolderPath;
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const includeModelDetails = url.searchParams.get('includeModelDetails') === 'true';
      const requestedDocumentIds = new Set(
        (url.searchParams.get('documentIds') || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      );
      let documents = await timings.time(
        'list-documents',
        () => readThroughCache(
          `instance:${id}:documents:${JSON.stringify({ folderId, allFolders, folderPath, connectionId, includeLabels: true })}`,
          () => client.listFolderDocuments({ folderId, includeLabels: true, connectionId }),
        ),
        (result) => ({
          allFolders,
          hasFolderId: Boolean(folderId),
          hasFolderPath: Boolean(folderPath),
          connectionScoped: Boolean(connectionId),
          count: result?.length || 0,
        }),
      );
      if (!folderId && folderPath) {
        const filterStartedAt = Date.now();
        const requestedPath = normalizeFolderPath(folderPath);
        documents = documents.filter((document) => {
          const actualPath = normalizeFolderPath(document.folderPath);
          return actualPath === requestedPath || actualPath.endsWith(`/${requestedPath}`);
        });
        timings.mark('filter-folder-path', Date.now() - filterStartedAt, { count: documents.length });
      }
      if (connectionId) {
        const filterStartedAt = Date.now();
        documents = documents.filter((document) => !document.connectionId || document.connectionId === connectionId);
        timings.mark('filter-connection', Date.now() - filterStartedAt, { count: documents.length });
      }
      if (requestedDocumentIds.size > 0) {
        const filterStartedAt = Date.now();
        documents = documents.filter((document) => requestedDocumentIds.has(document.identifier) || requestedDocumentIds.has(document.id));
        timings.mark('filter-document-ids', Date.now() - filterStartedAt, { count: documents.length });
      }
      if (includeModelDetails) {
        documents = await timings.time(
          'enrich-model-details',
          () => readThroughCache(
            `instance:${id}:documents:metadata:${JSON.stringify({ connectionId, ids: documents.map((document) => document.identifier).sort() })}`,
            () => enrichDocumentModelDetails(client, documents, { connectionId }),
          ),
          () => ({ count: documents.length }),
        );
      }
      return json({ documents, performance: timings.snapshot() });
    }

    if (req.method === 'GET' && parts[1] === 'models' && parts[3] === 'topics') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const modelId = decodeURIComponent(parts[2] || '').trim();
      if (!modelId) return json({ error: 'Model id required.' }, 400);
      const client = new OmniClient(secret);
      const topics = await readThroughCache(`instance:${id}:model:${modelId}:topics`, () => client.listModelTopics(modelId));
      return json({ topics });
    }

    if (req.method === 'GET' && parts[1] === 'models' && parts[3] === 'query-views') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const modelId = decodeURIComponent(parts[2] || '').trim();
      if (!modelId) return json({ error: 'Model id required.' }, 400);
      const includeYaml = url.searchParams.get('includeYaml') === 'true';
      const includeChecksums = url.searchParams.get('includeChecksums') === 'true';
      const client = new OmniClient(secret);
      const queryViews = await readThroughCache(
        `instance:${id}:model:${modelId}:query-views:${JSON.stringify({ includeYaml, includeChecksums })}`,
        () => client.listModelQueryViews(modelId, { includeYaml, includeChecksums }),
      );
      return json({ queryViews });
    }

    if (req.method === 'GET' && parts[1] === 'models') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const modelKind = cleanString(url.searchParams.get('modelKind')) || 'SHARED';
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const models = activeConnectionModels(
        await readThroughCache(
          `instance:${id}:models:${JSON.stringify({ modelKind, connectionId })}`,
          () => client.listModels({ modelKind, connectionId }),
        ),
        connectionId,
      );
      return json({ models });
    }

    if (req.method === 'GET' && parts[1] === 'folders') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const folders = await readThroughCache(`instance:${id}:folders`, () => client.listFolders());
      return json({ folders });
    }

    if (req.method === 'GET' && parts[1] === 'labels') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const labels = await client.listLabels();
      return json({ labels });
    }

    if (req.method === 'PATCH' && parts[1] === 'documents' && parts[3] === 'metadata') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const documentId = decodeURIComponent(parts[2] || '').trim();
      if (!documentId) return json({ error: 'Document identifier required.' }, 400);
      const body = await bodyJson(req);
      const client = new OmniClient(secret);
      const description = typeof body.description === 'string' ? body.description : undefined;
      const labels = parseLabelNames(body.labels);
      const createLabels = parseLabelNames(body.createLabels);
      if (description !== undefined) {
        await client.patchDocument(documentId, {
          description,
          clearExistingDraft: body.clearExistingDraft !== false,
        });
      }
      for (const label of createLabels) {
        await client.createLabel({ name: label });
      }
      if (labels.length > 0) await client.setDocumentLabels(documentId, labels);
      return json({ ok: true });
    }

    return json({ error: `Unknown instances route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Instance operation failed.' }, statusCode);
  }
}
