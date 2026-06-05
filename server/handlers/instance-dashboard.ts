import { jsonHeaders } from '../security';
import { getInstance, isVaultUnlocked, listInstances, type SavedInstancePublic } from '../services/nativeVault';
import { OmniClient, type OmniConnectionRecord, type OmniEmbedUserRecord } from '../services/omniClient';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function lowerPatterns(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.toLowerCase()).filter(Boolean);
}

function matchesFilter(value: string, contains: string[], exact: string[]): boolean {
  const normalized = value.toLowerCase();
  return contains.some((pattern) => normalized.includes(pattern)) || exact.some((pattern) => normalized === pattern);
}

function groupEntityName(user: OmniEmbedUserRecord, separator?: string): string {
  if (!separator) return '';
  const group = user.groups.find((row) => row.display.includes(separator));
  if (!group) return '';
  return group.display.split(separator)[0]?.trim() ?? '';
}

async function connectionStats(instance: SavedInstancePublic) {
  const secret = getInstance(instance.id);
  if (!secret) throw new Error('Instance not found.');
  const client = new OmniClient(secret);
  const [connections, schemaModels] = await Promise.all([
    client.listConnections(),
    client.listSchemaModels(),
  ]);
  const schemaModelByConnectionId = new Map(
    schemaModels
      .filter((model) => !model.deletedAt && model.connectionId)
      .map((model) => [model.connectionId!, model]),
  );
  const contains = lowerPatterns(secret.metricFilter.connectionDatabaseContains);
  const exact = lowerPatterns(secret.metricFilter.connectionDatabaseExact);

  const records = connections
    .filter((connection) => !connection.deletedAt)
    .map((connection: OmniConnectionRecord) => {
      const schemaModel = schemaModelByConnectionId.get(connection.id);
      const hasSchemaModel = Boolean(schemaModel);
      const schemaModelGenerated = Boolean(
        schemaModel?.createdAt
        && schemaModel?.updatedAt
        && schemaModel.createdAt !== schemaModel.updatedAt,
      );
      return {
        ...connection,
        filtered: matchesFilter(connection.database || connection.name || '', contains, exact),
        hasSchemaModel,
        schemaModelGenerated,
        schemaModelId: schemaModel?.id ?? null,
        schemaModelUpdatedAt: schemaModel?.updatedAt ?? null,
        readiness: !hasSchemaModel
          ? 'missing_schema_model'
          : schemaModelGenerated
            ? 'ready'
            : 'schema_model_stuck',
      };
    });

  return {
    instanceId: instance.id,
    instanceLabel: instance.label,
    instanceRole: instance.role,
    baseUrl: instance.baseUrl,
    totalConnections: records.filter((record) => !record.filtered).length,
    filteredCount: records.filter((record) => record.filtered).length,
    missingSchemaModelCount: records.filter((record) => !record.filtered && !record.hasSchemaModel).length,
    stuckSchemaModelCount: records.filter((record) => !record.filtered && record.hasSchemaModel && !record.schemaModelGenerated).length,
    connections: records,
  };
}

async function embedUserStats(instance: SavedInstancePublic) {
  const secret = getInstance(instance.id);
  if (!secret) throw new Error('Instance not found.');
  const client = new OmniClient(secret);
  const users = await client.listEmbedUsers();
  const contains = lowerPatterns(secret.metricFilter.embedExternalIdContains);
  const exact = lowerPatterns(secret.metricFilter.embedExternalIdExact);
  const records = users.map((user) => ({
    ...user,
    entityName: groupEntityName(user, secret.entityGroupSeparator),
    filtered: matchesFilter(user.embedExternalId || user.userName || '', contains, exact),
  }));
  const activeUsers = records.filter((user) => !user.filtered && user.active);
  const entityNames = new Set(activeUsers.map((user) => user.entityName).filter(Boolean));

  return {
    instanceId: instance.id,
    instanceLabel: instance.label,
    instanceRole: instance.role,
    baseUrl: instance.baseUrl,
    totalUsers: records.filter((user) => !user.filtered).length,
    activeUsers: activeUsers.length,
    inactiveUsers: records.filter((user) => !user.filtered && !user.active).length,
    filteredCount: records.filter((user) => user.filtered).length,
    entityCount: entityNames.size,
    users: records,
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/instance-dashboard\/?/, '');
    const instances = listInstances().filter((instance) => instance.role === 'source' || instance.role === 'both' || instance.role === 'destination');

    if (req.method === 'GET' && path === 'connections') {
      const results = await Promise.allSettled(instances.map(connectionStats));
      return json({
        instances: results.map((result, index) => {
          if (result.status === 'fulfilled') return result.value;
          const instance = instances[index];
          return {
            instanceId: instance?.id,
            instanceLabel: instance?.label,
            instanceRole: instance?.role,
            baseUrl: instance?.baseUrl,
            totalConnections: 0,
            filteredCount: 0,
            missingSchemaModelCount: 0,
            stuckSchemaModelCount: 0,
            connections: [],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }),
      });
    }

    if (req.method === 'GET' && path === 'embed-users') {
      const results = await Promise.allSettled(instances.map(embedUserStats));
      return json({
        instances: results.map((result, index) => {
          if (result.status === 'fulfilled') return result.value;
          const instance = instances[index];
          return {
            instanceId: instance?.id,
            instanceLabel: instance?.label,
            instanceRole: instance?.role,
            baseUrl: instance?.baseUrl,
            totalUsers: 0,
            activeUsers: 0,
            inactiveUsers: 0,
            filteredCount: 0,
            entityCount: 0,
            users: [],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }),
      });
    }

    return json({ error: `Unknown instance dashboard route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? error.message : 'Dashboard stats failed.' }, statusCode);
  }
}
