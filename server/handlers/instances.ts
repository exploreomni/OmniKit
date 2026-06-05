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
import { OmniClient } from '../services/omniClient';

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
      name: cleanString(action.name) || 'Post-migration action',
      method: parseMethod(action.method),
      url: cleanString(action.url) || '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
    }))
    .filter((action) => action.url);
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

    if (req.method === 'POST' && path === 'import-browser') {
      const body = await bodyJson(req);
      const records = Array.isArray(body.instances) ? body.instances : [];
      const imported = records.map((record) => {
        const row = record as Record<string, unknown>;
        const input: Partial<SavedInstance> & { apiKey?: string } = {
          label: cleanString(row.name) || cleanString(row.label),
          role: 'destination',
          baseUrl: cleanString(row.baseUrl),
          apiKey: typeof row.apiKey === 'string' ? row.apiKey : undefined,
          defaultFolderPath: cleanString(row.defaultTargetFolder),
          metricFilter: parseFilter({}),
          postMigrationActions: [],
        };
        validateInstanceInput(input);
        return upsertInstance(input);
      });
      return json({ imported });
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
      const client = new OmniClient(secret);
      let documents = await client.listFolderDocuments(secret.defaultFolderId, true);
      if (!secret.defaultFolderId && secret.defaultFolderPath) {
        const requestedPath = normalizeFolderPath(secret.defaultFolderPath);
        documents = documents.filter((document) => {
          const actualPath = normalizeFolderPath(document.folderPath);
          return actualPath === requestedPath || actualPath.endsWith(`/${requestedPath}`);
        });
      }
      return json({ documents });
    }

    if (req.method === 'GET' && parts[1] === 'models') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const modelKind = cleanString(url.searchParams.get('modelKind')) || 'SHARED';
      const models = await client.listModels(modelKind);
      return json({ models });
    }

    if (req.method === 'GET' && parts[1] === 'folders') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const folders = await client.listFolders();
      return json({ folders });
    }

    return json({ error: `Unknown instances route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? error.message : 'Instance operation failed.' }, statusCode);
  }
}
