import { jsonHeaders } from '../security';
import { getInstance, isVaultUnlocked, listInstances, type SavedInstancePublic } from '../services/nativeVault';
import { OmniClient, type OmniConnectionRecord, type OmniEmbedUserRecord } from '../services/omniClient';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function lowerPatterns(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.toLowerCase()).filter(Boolean);
}

function matchesFilter(value: string, contains: string[], exact: string[]): boolean {
  const normalized = value.toLowerCase();
  return contains.some((pattern) => normalized.includes(pattern)) || exact.some((pattern) => normalized === pattern);
}

const GENERIC_GROUP_NAMES = new Set(['all users', 'all embed users', 'everyone', 'users', 'admins', 'administrators']);

export function groupEntityName(user: OmniEmbedUserRecord, separator?: string): string {
  if (separator) {
    const group = user.groups.find((row) => row.display.includes(separator));
    if (!group) return '';
    return group.display.split(separator)[0]?.trim() ?? '';
  }

  const group = user.groups.find((row) => {
    const display = row.display.trim();
    return display && !GENERIC_GROUP_NAMES.has(display.toLowerCase());
  });
  return group?.display.trim() || '';
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function weekStartIso(time: number): string {
  const date = new Date(time);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + diff));
  return start.toISOString().slice(0, 10);
}

function monthKey(time: number): string {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lastWeeks(count: number, now = new Date()): string[] {
  const currentStart = Date.parse(weekStartIso(now.getTime()));
  return Array.from({ length: count }, (_, index) => weekStartIso(currentStart - (count - index - 1) * 7 * 24 * 60 * 60 * 1000));
}

function lastMonths(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - index - 1), 1));
    return monthKey(date.getTime());
  });
}

export function buildEmbedActivity(records: Array<OmniEmbedUserRecord & { filtered: boolean }>) {
  const counted = records.filter((user) => !user.filtered);
  const now = Date.now();
  const days = (value: number) => value * 24 * 60 * 60 * 1000;
  const lastLoginTimes = counted.map((user) => ({ user, time: parseDateMs(user.lastLogin) }));
  const weeks = lastWeeks(12);
  const months = lastMonths(12);
  const weeklyCounts = new Map(weeks.map((week) => [week, 0]));
  const monthlyCounts = new Map(months.map((month) => [month, 0]));

  for (const { time } of lastLoginTimes) {
    if (!time) continue;
    const week = weekStartIso(time);
    if (weeklyCounts.has(week)) weeklyCounts.set(week, (weeklyCounts.get(week) || 0) + 1);
  }

  for (const user of counted) {
    const createdAt = parseDateMs(user.createdAt);
    if (!createdAt) continue;
    const month = monthKey(createdAt);
    if (monthlyCounts.has(month)) monthlyCounts.set(month, (monthlyCounts.get(month) || 0) + 1);
  }

  return {
    active7d: lastLoginTimes.filter(({ time }) => Boolean(time && now - time <= days(7))).length,
    active30d: lastLoginTimes.filter(({ time }) => Boolean(time && now - time <= days(30))).length,
    active90d: lastLoginTimes.filter(({ time }) => Boolean(time && now - time <= days(90))).length,
    neverLoggedIn: lastLoginTimes.filter(({ time }) => !time).length,
    weeklyLogins: weeks.map((weekStart) => ({ weekStart, count: weeklyCounts.get(weekStart) || 0 })),
    monthlySignups: months.map((month) => ({ month, count: monthlyCounts.get(month) || 0 })),
  };
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
        schemaModelCreatedAt: schemaModel?.createdAt ?? null,
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
    activity: buildEmbedActivity(records),
    users: records,
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/instance-dashboard\/?/, '');
    const parts = path.split('/').filter(Boolean);
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

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'refresh-schema') {
      const instanceId = parts[0];
      const secret = getInstance(instanceId);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const body = await bodyJson(req);
      const modelId = cleanString(body.modelId);
      if (!modelId) return json({ error: 'Model ID is required for schema refresh.' }, 400);
      const result = await new OmniClient(secret).refreshModel(modelId);
      return json({
        ok: true,
        instanceId,
        modelId,
        jobId: result.jobId,
        status: result.status,
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
