import type {
  ConnectionMetricRecord,
  EmbedUserMetricRecord,
  InstanceConnectionStats,
  InstanceEmbedUserStats,
} from './opsConsole';

export const USER_HEALTH_EXPECTED_INACTIVE_STORAGE_KEY = 'omnikit:userHealthExpectedInactive:v1';

export type UserHealthFinding = 'healthy' | 'no_users' | 'no_active_users';
export type UserHealthReviewReason = 'inactive' | 'never_logged_in' | 'inactive_never_logged_in';

export interface UserHealthEntityRow {
  key: string;
  instanceId: string;
  instanceLabel: string;
  baseUrl: string;
  entityName: string;
  connectionNames: string[];
  connectionCount: number;
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  neverLoggedInUsers: number;
  lastLogin?: string | null;
  finding: UserHealthFinding;
  expectedInactive: boolean;
  actionNeeded: boolean;
}

export interface UserHealthInactiveUserRow {
  key: string;
  instanceId: string;
  instanceLabel: string;
  entityName: string;
  userId: string;
  userName: string;
  displayName: string;
  active: boolean;
  lastLogin?: string | null;
  expectedInactive: boolean;
  reason: UserHealthReviewReason;
}

export interface UserHealthSummary {
  totalEntities: number;
  actionNeededEntities: number;
  noUserEntities: number;
  noActiveUserEntities: number;
  expectedInactiveEntities: number;
  unmappedUsers: number;
  inactiveUsers: number;
  neverLoggedInUsers: number;
  lastLoginBuckets: {
    last30d: number;
    last31To90d: number;
    olderThan90d: number;
    neverLoggedIn: number;
  };
}

export interface UserHealthResult {
  summary: UserHealthSummary;
  entities: UserHealthEntityRow[];
  inactiveUsers: UserHealthInactiveUserRow[];
}

interface StoredExpectedInactiveEntities {
  version: 1;
  keys: string[];
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface EntityAccumulator {
  key: string;
  instanceId: string;
  instanceLabel: string;
  baseUrl: string;
  entityName: string;
  connectionNames: Set<string>;
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  neverLoggedInUsers: number;
  lastLogin?: string | null;
}

interface ConnectionEntityRef {
  entityName: string;
  aliases: Set<string>;
}

const UNASSIGNED_ENTITY_NAME = 'Unassigned';
const MIN_ALIAS_KEY_LENGTH = 5;
const GENERIC_ALIAS_KEYS = new Set([
  'admin',
  'admins',
  'default',
  'demo',
  'dev',
  'development',
  'internal',
  'prod',
  'production',
  'schema',
  'service',
  'shared',
  'test',
  'uat',
  'user',
  'users',
]);

function browserStorage(): KeyValueStorage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function normalizeEntityName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeAliasKey(value: string | undefined | null): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function entityHealthKey(instanceId: string, entityName: string): string {
  return `${instanceId}::${normalizeEntityName(entityName)}`;
}

function parseDate(value?: string | null): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function latestDate(current: string | null | undefined, next: string | null | undefined): string | null | undefined {
  return parseDate(next) > parseDate(current) ? next : current;
}

function getConnectionEntityName(connection: ConnectionMetricRecord): string {
  return connection.name?.trim() || connection.id;
}

function addAlias(aliases: Set<string>, value: string | undefined | null): void {
  const key = normalizeAliasKey(value);
  if (key.length < MIN_ALIAS_KEY_LENGTH || GENERIC_ALIAS_KEYS.has(key)) return;
  aliases.add(key);
}

function buildConnectionEntityRef(connection: ConnectionMetricRecord): ConnectionEntityRef {
  const entityName = getConnectionEntityName(connection);
  const aliases = new Set<string>();
  addAlias(aliases, connection.id);
  addAlias(aliases, connection.name);
  addAlias(aliases, connection.database);
  addAlias(aliases, connection.defaultSchema);

  const nameParts = (connection.name || '').split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (nameParts.length > 1) addAlias(aliases, nameParts[nameParts.length - 1]);

  const databaseWithoutEnvironment = (connection.database || '').replace(/^(prod|production|dev|development|test|uat)[_-]+/i, '');
  addAlias(aliases, databaseWithoutEnvironment);

  return { entityName, aliases };
}

function findUniqueConnectionMatch(text: string, connections: ConnectionEntityRef[]): ConnectionEntityRef | null {
  const key = normalizeAliasKey(text);
  if (!key) return null;
  const matches = connections.filter((connection) => {
    for (const alias of connection.aliases) {
      if (key === alias || key.includes(alias)) return true;
    }
    return false;
  });
  return matches.length === 1 ? matches[0] : null;
}

function resolveUserEntityName(user: EmbedUserMetricRecord, connections: ConnectionEntityRef[]): string {
  const explicitEntityName = user.entityName?.trim();
  if (explicitEntityName && normalizeEntityName(explicitEntityName) !== normalizeEntityName(UNASSIGNED_ENTITY_NAME)) {
    const normalized = normalizeEntityName(explicitEntityName);
    const exactConnection = connections.find((connection) => normalizeEntityName(connection.entityName) === normalized);
    if (exactConnection) return exactConnection.entityName;

    const matchedConnection = findUniqueConnectionMatch(explicitEntityName, connections);
    return matchedConnection?.entityName || explicitEntityName;
  }

  const matchedConnection = findUniqueConnectionMatch(
    [user.embedExternalId, user.userName, user.displayName].filter(Boolean).join(' '),
    connections,
  );
  return matchedConnection?.entityName || UNASSIGNED_ENTITY_NAME;
}

function getAccumulator(
  entities: Map<string, EntityAccumulator>,
  instance: Pick<InstanceConnectionStats | InstanceEmbedUserStats, 'instanceId' | 'instanceLabel' | 'baseUrl'>,
  entityName: string,
): EntityAccumulator {
  const key = entityHealthKey(instance.instanceId, entityName);
  const current = entities.get(key);
  if (current) return current;
  const created: EntityAccumulator = {
    key,
    instanceId: instance.instanceId,
    instanceLabel: instance.instanceLabel,
    baseUrl: instance.baseUrl,
    entityName,
    connectionNames: new Set(),
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    neverLoggedInUsers: 0,
    lastLogin: null,
  };
  entities.set(key, created);
  return created;
}

function rowFinding(row: EntityAccumulator, connectionCount: number): UserHealthFinding {
  if (connectionCount > 0 && row.totalUsers === 0) return 'no_users';
  if (row.totalUsers > 0 && row.activeUsers === 0) return 'no_active_users';
  return 'healthy';
}

function reviewReason(user: EmbedUserMetricRecord): UserHealthReviewReason {
  if (!user.active && !user.lastLogin) return 'inactive_never_logged_in';
  if (!user.active) return 'inactive';
  return 'never_logged_in';
}

function incrementLastLoginBucket(
  buckets: UserHealthSummary['lastLoginBuckets'],
  lastLogin: string | null | undefined,
  nowMs: number,
): void {
  const loginMs = parseDate(lastLogin);
  if (!loginMs) {
    buckets.neverLoggedIn += 1;
    return;
  }
  const ageDays = Math.max(0, Math.floor((nowMs - loginMs) / 86_400_000));
  if (ageDays <= 30) buckets.last30d += 1;
  else if (ageDays <= 90) buckets.last31To90d += 1;
  else buckets.olderThan90d += 1;
}

export function readExpectedInactiveEntityKeys(storage: KeyValueStorage | undefined = browserStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(USER_HEALTH_EXPECTED_INACTIVE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<StoredExpectedInactiveEntities> | string[];
    const keys = Array.isArray(parsed) ? parsed : parsed.version === 1 ? parsed.keys : [];
    return new Set((keys || []).filter((key): key is string => typeof key === 'string' && key.length > 0));
  } catch {
    return new Set();
  }
}

export function writeExpectedInactiveEntityKeys(keys: Set<string>, storage: KeyValueStorage | undefined = browserStorage()): void {
  if (!storage) return;
  const payload: StoredExpectedInactiveEntities = {
    version: 1,
    keys: [...keys].sort(),
  };
  storage.setItem(USER_HEALTH_EXPECTED_INACTIVE_STORAGE_KEY, JSON.stringify(payload));
}

export function buildUserHealth(
  connectionStats: InstanceConnectionStats[],
  embedUserStats: InstanceEmbedUserStats[],
  expectedInactiveKeys: Set<string>,
  now: Date = new Date(),
): UserHealthResult {
  const embedByInstance = new Map(embedUserStats.map((instance) => [instance.instanceId, instance]));
  const instanceIds = new Set([
    ...connectionStats.map((instance) => instance.instanceId),
    ...embedUserStats.map((instance) => instance.instanceId),
  ]);
  const entities = new Map<string, EntityAccumulator>();
  const inactiveUsers: UserHealthInactiveUserRow[] = [];
  const lastLoginBuckets: UserHealthSummary['lastLoginBuckets'] = {
    last30d: 0,
    last31To90d: 0,
    olderThan90d: 0,
    neverLoggedIn: 0,
  };
  const nowMs = now.getTime();
  let unmappedUsers = 0;

  for (const instanceId of instanceIds) {
    const connectionInstance = connectionStats.find((instance) => instance.instanceId === instanceId);
    const userInstance = embedByInstance.get(instanceId);
    const instance = connectionInstance || userInstance;
    if (!instance) continue;

    const connectionEntityRefs: ConnectionEntityRef[] = [];
    for (const connection of connectionInstance?.connections || []) {
      if (connection.filtered) continue;
      const entityName = getConnectionEntityName(connection);
      connectionEntityRefs.push(buildConnectionEntityRef(connection));
      const row = getAccumulator(entities, instance, entityName);
      row.connectionNames.add(connection.name || connection.id);
    }

    for (const user of userInstance?.users || []) {
      if (user.filtered) continue;
      incrementLastLoginBucket(lastLoginBuckets, user.lastLogin, nowMs);
      const entityName = resolveUserEntityName(user, connectionEntityRefs);
      if (entityName === UNASSIGNED_ENTITY_NAME) unmappedUsers += 1;
      const row = getAccumulator(entities, instance, entityName);
      row.totalUsers += 1;
      row.lastLogin = latestDate(row.lastLogin, user.lastLogin);
      if (user.active) row.activeUsers += 1;
      else row.inactiveUsers += 1;
      if (!user.lastLogin) row.neverLoggedInUsers += 1;

      if (!user.active || !user.lastLogin) {
        inactiveUsers.push({
          key: `${instance.instanceId}::${user.id || user.userName || user.displayName}`,
          instanceId: instance.instanceId,
          instanceLabel: instance.instanceLabel,
          entityName,
          userId: user.id,
          userName: user.userName,
          displayName: user.displayName,
          active: user.active,
          lastLogin: user.lastLogin,
          expectedInactive: expectedInactiveKeys.has(row.key),
          reason: reviewReason(user),
        });
      }
    }
  }

  const rows = [...entities.values()].map((row): UserHealthEntityRow => {
    const connectionCount = row.connectionNames.size;
    const finding = rowFinding(row, connectionCount);
    const expectedInactive = expectedInactiveKeys.has(row.key);
    return {
      key: row.key,
      instanceId: row.instanceId,
      instanceLabel: row.instanceLabel,
      baseUrl: row.baseUrl,
      entityName: row.entityName,
      connectionNames: [...row.connectionNames].sort((a, b) => a.localeCompare(b)),
      connectionCount,
      totalUsers: row.totalUsers,
      activeUsers: row.activeUsers,
      inactiveUsers: row.inactiveUsers,
      neverLoggedInUsers: row.neverLoggedInUsers,
      lastLogin: row.lastLogin,
      finding,
      expectedInactive,
      actionNeeded: finding !== 'healthy' && !expectedInactive,
    };
  }).sort((a, b) => {
    if (a.actionNeeded !== b.actionNeeded) return a.actionNeeded ? -1 : 1;
    if (a.finding !== b.finding) return a.finding.localeCompare(b.finding);
    return a.instanceLabel.localeCompare(b.instanceLabel) || a.entityName.localeCompare(b.entityName);
  });

  inactiveUsers.sort((a, b) => {
    if (a.expectedInactive !== b.expectedInactive) return a.expectedInactive ? 1 : -1;
    return a.instanceLabel.localeCompare(b.instanceLabel)
      || a.entityName.localeCompare(b.entityName)
      || (a.displayName || a.userName).localeCompare(b.displayName || b.userName);
  });

  return {
    summary: {
      totalEntities: rows.length,
      actionNeededEntities: rows.filter((row) => row.actionNeeded).length,
      noUserEntities: rows.filter((row) => row.finding === 'no_users').length,
      noActiveUserEntities: rows.filter((row) => row.finding === 'no_active_users').length,
      expectedInactiveEntities: rows.filter((row) => row.expectedInactive).length,
      unmappedUsers,
      inactiveUsers: inactiveUsers.filter((user) => !user.active).length,
      neverLoggedInUsers: inactiveUsers.filter((user) => !user.lastLogin).length,
      lastLoginBuckets,
    },
    entities: rows,
    inactiveUsers,
  };
}
