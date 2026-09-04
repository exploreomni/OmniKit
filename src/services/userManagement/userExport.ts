import type { OmniUser } from '../../types';
import type { CsvCellValue } from '../../utils/csvExport';
import {
  ApiError,
  USER_MODEL_ROLE_NAMES,
  listAllUsers,
  listConnections,
  listModels,
  listUserModelRoles,
  type UserModelRoleName,
  type UserModelRoleRecord,
} from '../omniApi';
import {
  IDENTITY_IMPORT_LIMITS,
  IDENTITY_NO_ASSIGNMENT_LABEL,
  escapeIdentityCsvValue,
  identityModelRoleLabel,
  joinIdentityList,
} from './identityImportInputs';

const EXPORT_MODEL_KINDS = ['SHARED', 'SHARED_EXTENSION'] as const;
const OMNI_ID_PATTERN = /^[\w-]+$/;
const ROLE_READ_CONCURRENCY = 2;
const ROLE_READ_MAX_ATTEMPTS = 3;
const ROLE_SOURCE_TYPES = new Set(['USER', 'User Role']);
const KNOWN_ROLE_SOURCE_TYPES = new Set([
  ...ROLE_SOURCE_TYPES,
  'GROUP',
  'Group Role',
  'CONNECTION_BASE_ROLE',
  'Connection Base Role',
]);
const BUILT_IN_ROLE_NAMES = new Set<string>(USER_MODEL_ROLE_NAMES);

export const IDENTITY_EXPORT_HEADERS = [
  'action',
  'display_name',
  'email',
  'group',
  'role',
  'connection',
  'model',
] as const;

export type IdentityExportConnection = {
  id: string;
  name: string;
};

export type IdentityExportModel = {
  id: string;
  name: string;
  connectionId: string;
  kind: typeof EXPORT_MODEL_KINDS[number];
};

export type IdentityExportProgress = {
  completed: number;
  total: number;
  stage: 'Users' | 'Access catalog' | 'User access';
  phase: 1 | 2 | 3;
  phaseTotal: 3;
  stageCompleted: number;
  stageTotal: number;
  message: string;
  estimatedRemainingMs?: number;
};

export type IdentityExportRoleRequestLimit = 60 | 500;

export type IdentityExportScope = {
  key: string;
  label: string;
  signal?: AbortSignal;
  isActive?: () => boolean;
  roleRequestsPerMinute?: IdentityExportRoleRequestLimit;
};

export type IdentityExportResult = {
  rows: CsvCellValue[][];
  userCount: number;
  directRoleCount: number;
  noAssignmentUserCount: number;
  unknownAssignmentSourceUserCount: number;
};

export type IdentityExportInput = {
  users: readonly OmniUser[];
  rolesByUserId: ReadonlyMap<string, readonly UserModelRoleRecord[]>;
  connections: readonly IdentityExportConnection[];
  models: readonly IdentityExportModel[];
};

export type IdentityExportErrorCode =
  | 'INSTANCE_CHANGED'
  | 'USER_INVENTORY_INCOMPLETE'
  | 'CONNECTION_INVENTORY_INVALID'
  | 'MODEL_INVENTORY_INCOMPLETE'
  | 'ROLE_EVIDENCE_INCOMPLETE'
  | 'ROLE_UNSUPPORTED'
  | 'ROLE_SCOPE_UNRESOLVED'
  | 'ROLE_SCOPE_AMBIGUOUS'
  | 'EXPORT_LIMIT_EXCEEDED';

export class IdentityExportError extends Error {
  constructor(
    readonly code: IdentityExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityExportError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOmniId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && OMNI_ID_PATTERN.test(value);
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function assertActive(scope: IdentityExportScope): void {
  if (scope.signal?.aborted) {
    throw new DOMException('The user export was cancelled.', 'AbortError');
  }
  if (scope.isActive && !scope.isActive()) {
    throw new IdentityExportError(
      'INSTANCE_CHANGED',
      'The selected Omni instance changed during export. No file was downloaded.',
    );
  }
}

function waitForExport(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The user export was cancelled.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('The user export was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function roleRequestSpacingMs(requestsPerMinute: IdentityExportRoleRequestLimit): number {
  // Keep headroom for other reads sharing the same API key. The accelerated
  // profile is opt-in because Omni must approve the higher instance limit.
  return requestsPerMinute === 500 ? 150 : 1_050;
}

type RoleReadPacer = {
  waitForTurn: (signal?: AbortSignal) => Promise<void>;
  noteRateLimit: (retryAfterMs: number) => void;
  readonly requestSpacingMs: number;
};

function createRoleReadPacer(requestsPerMinute: IdentityExportRoleRequestLimit): RoleReadPacer {
  let spacingMs = roleRequestSpacingMs(requestsPerMinute);
  let nextRequestAt = 0;
  let cooldownUntil = 0;

  return {
    async waitForTurn(signal?: AbortSignal) {
      while (true) {
        const now = Date.now();
        const scheduledAt = Math.max(now, nextRequestAt, cooldownUntil);
        nextRequestAt = scheduledAt + spacingMs;
        if (scheduledAt > now) await waitForExport(scheduledAt - now, signal);
        if (Date.now() >= cooldownUntil) return;
      }
    },
    noteRateLimit(retryAfterMs: number) {
      // An accelerated selection that receives a 429 automatically falls back
      // to the standard pace for the remainder of this export.
      spacingMs = Math.max(spacingMs, roleRequestSpacingMs(60));
      cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterMs);
      nextRequestAt = Math.max(nextRequestAt, cooldownUntil);
    },
    get requestSpacingMs() {
      return spacingMs;
    },
  };
}

function hasUnknownAssignmentSource(roles: readonly UserModelRoleRecord[]): boolean {
  return roles.some((role) => !KNOWN_ROLE_SOURCE_TYPES.has(role.from?.type));
}

function shouldMarkNoAssignment(roles: readonly UserModelRoleRecord[]): boolean {
  return hasUnknownAssignmentSource(roles)
    && !roles.some((role) => ROLE_SOURCE_TYPES.has(role.from?.type));
}

function mapScimExportUser(value: Record<string, unknown>): OmniUser {
  if (!Object.prototype.hasOwnProperty.call(value, 'groups') || !Array.isArray(value.groups)) {
    throw new IdentityExportError(
      'USER_INVENTORY_INCOMPLETE',
      'Omni did not return explicit group-membership evidence for every user. No partial export was downloaded.',
    );
  }
  const groups = value.groups.map((group) => {
    if (!isRecord(group) || typeof group.value !== 'string' || typeof group.display !== 'string') {
      throw new IdentityExportError(
        'USER_INVENTORY_INCOMPLETE',
        'Omni returned a user group membership without a display name. No partial export was downloaded.',
      );
    }
    return { value: group.value, display: group.display };
  });
  return {
    id: String(value.id),
    userName: String(value.userName),
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
    ...(typeof value.active === 'boolean' ? { active: value.active } : {}),
    groups,
  };
}

function parseConnections(payload: unknown): IdentityExportConnection[] {
  if (
    !isRecord(payload)
    || Object.prototype.hasOwnProperty.call(payload, 'error')
    || Object.prototype.hasOwnProperty.call(payload, 'errors')
    || payload.ok === false
    || payload.success === false
    || !Array.isArray(payload.connections)
  ) {
    throw new IdentityExportError(
      'CONNECTION_INVENTORY_INVALID',
      'Omni returned an invalid connection inventory. No partial export was downloaded.',
    );
  }
  const seenIds = new Set<string>();
  return payload.connections.map((value) => {
    const deletedAt = isRecord(value) ? value.deletedAt ?? value.deleted_at : undefined;
    if (
      !isRecord(value)
      || !isOmniId(value.id)
      || typeof value.name !== 'string'
      || !value.name.trim()
      || value.name.trim() !== value.name
      || value.name.length > IDENTITY_IMPORT_LIMITS.maxScopeNameLength
      || (deletedAt !== undefined && deletedAt !== null)
      || seenIds.has(value.id)
    ) {
      throw new IdentityExportError(
        'CONNECTION_INVENTORY_INVALID',
        'Omni returned an invalid connection inventory. No partial export was downloaded.',
      );
    }
    seenIds.add(value.id);
    return { id: value.id, name: value.name };
  });
}

function parseModels(payload: unknown, expectedKind: IdentityExportModel['kind']): IdentityExportModel[] {
  if (
    !isRecord(payload)
    || Object.prototype.hasOwnProperty.call(payload, 'error')
    || Object.prototype.hasOwnProperty.call(payload, 'errors')
    || payload.ok === false
    || payload.success === false
    || !Array.isArray(payload.models)
    || payload.complete !== true
    || !Number.isSafeInteger(payload.loadedResults)
    || !Number.isSafeInteger(payload.totalResults)
    || payload.loadedResults !== payload.models.length
    || payload.totalResults !== payload.models.length
  ) {
    throw new IdentityExportError(
      'MODEL_INVENTORY_INCOMPLETE',
      `Omni returned an incomplete ${expectedKind} model inventory. No partial export was downloaded.`,
    );
  }
  const seenIds = new Set<string>();
  return payload.models.map((value) => {
    if (
      !isRecord(value)
      || !isOmniId(value.id)
      || !isOmniId(value.connectionId)
      || value.kind !== expectedKind
      || typeof value.name !== 'string'
      || !value.name.trim()
      || value.name.trim() !== value.name
      || value.name.length > IDENTITY_IMPORT_LIMITS.maxScopeNameLength
      || value.name === value.id
      || value.deletedAt !== null
      || seenIds.has(value.id)
    ) {
      throw new IdentityExportError(
        'MODEL_INVENTORY_INCOMPLETE',
        `Omni returned an invalid ${expectedKind} model inventory. No partial export was downloaded.`,
      );
    }
    seenIds.add(value.id);
    return {
      id: value.id,
      name: value.name,
      connectionId: value.connectionId,
      kind: expectedKind,
    };
  });
}

function uniqueGroupNames(user: OmniUser): string[] {
  if (!Array.isArray(user.groups)) {
    throw new IdentityExportError(
      'USER_INVENTORY_INCOMPLETE',
      `Group-membership evidence is unavailable for ${user.userName}. No partial export was downloaded.`,
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const group of user.groups) {
    const name = group.display;
    if (
      typeof name !== 'string'
      || !name.trim()
      || name.trim() !== name
      || name.length > IDENTITY_IMPORT_LIMITS.maxGroupNameLength
    ) {
      throw new IdentityExportError(
        'USER_INVENTORY_INCOMPLETE',
        `A group membership for ${user.userName} cannot be represented safely in the identity-import format.`,
      );
    }
    const key = normalizedName(name);
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function builtInRoleName(roleName: string, user: OmniUser): UserModelRoleName {
  if (!BUILT_IN_ROLE_NAMES.has(roleName)) {
    throw new IdentityExportError(
      'ROLE_UNSUPPORTED',
      `${user.userName} has an unsupported custom role. OmniKit will not coerce it to a broader built-in role.`,
    );
  }
  return roleName as UserModelRoleName;
}

function uniqueCatalogName(
  type: 'connection' | 'model',
  name: string,
  candidates: readonly { name: string }[],
): void {
  if (candidates.filter((candidate) => normalizedName(candidate.name) === normalizedName(name)).length !== 1) {
    throw new IdentityExportError(
      'ROLE_SCOPE_AMBIGUOUS',
      `The ${type} name "${name}" is ambiguous and cannot be round-tripped safely. No file was downloaded.`,
    );
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function buildIdentityExportRows(input: IdentityExportInput): CsvCellValue[][] {
  const rows: CsvCellValue[][] = [[...IDENTITY_EXPORT_HEADERS]];
  const connectionsById = new Map<string, IdentityExportConnection>();
  const modelsById = new Map<string, IdentityExportModel>();
  const connectionNameCandidates = new Map<string, IdentityExportConnection[]>();
  const modelNameCandidates = new Map<string, IdentityExportModel[]>();
  const uniqueGroups = new Set<string>();
  let userGroupMembershipCount = 0;
  let directRoleTargetCount = 0;
  let roleRowCount = 0;

  for (const connection of input.connections) {
    if (connectionsById.has(connection.id)) {
      throw new IdentityExportError('ROLE_SCOPE_AMBIGUOUS', 'Omni returned duplicate connection identities. No file was downloaded.');
    }
    connectionsById.set(connection.id, connection);
    const key = normalizedName(connection.name);
    connectionNameCandidates.set(key, [...(connectionNameCandidates.get(key) || []), connection]);
  }
  for (const model of input.models) {
    if (modelsById.has(model.id)) {
      throw new IdentityExportError('ROLE_SCOPE_AMBIGUOUS', 'Omni returned duplicate model identities. No file was downloaded.');
    }
    modelsById.set(model.id, model);
    const key = `${model.connectionId}|${normalizedName(model.name)}`;
    modelNameCandidates.set(key, [...(modelNameCandidates.get(key) || []), model]);
  }

  const seenUserIds = new Set<string>();
  const seenEmails = new Set<string>();
  const sortedUsers = [...input.users].sort((left, right) => (
    left.userName.localeCompare(right.userName) || left.id.localeCompare(right.id)
  ));

  for (const user of sortedUsers) {
    const emailKey = normalizedName(user.userName);
    if (
      !isOmniId(user.id)
      || !user.userName.trim()
      || user.userName.trim() !== user.userName
      || seenUserIds.has(user.id)
      || seenEmails.has(emailKey)
      || !input.rolesByUserId.has(user.id)
    ) {
      throw new IdentityExportError(
        'ROLE_EVIDENCE_INCOMPLETE',
        'User or role evidence was incomplete or duplicated. No partial export was downloaded.',
      );
    }
    seenUserIds.add(user.id);
    seenEmails.add(emailKey);

    const groupNames = uniqueGroupNames(user);
    groupNames.forEach((name) => uniqueGroups.add(normalizedName(name)));
    userGroupMembershipCount += groupNames.length;
    const roleEvidence = input.rolesByUserId.get(user.id) || [];
    const markNoAssignment = shouldMarkNoAssignment(roleEvidence);
    const directRoles = roleEvidence.filter((role) => ROLE_SOURCE_TYPES.has(role.from.type));

    const modelRoleByScope = new Map<string, UserModelRoleName>();
    const adminConnections = new Set<string>();
    const groupedModels = new Map<string, {
      roleName: UserModelRoleName;
      connection: IdentityExportConnection;
      modelNames: Set<string>;
    }>();
    const directRoleKeys = new Set<string>();

    for (const role of directRoles) {
      const roleName = builtInRoleName(role.roleName, user);
      if (!role.connectionId) {
        throw new IdentityExportError(
          'ROLE_SCOPE_UNRESOLVED',
          `${user.userName} has a direct ${identityModelRoleLabel(roleName)} assignment without a connection. No file was downloaded.`,
        );
      }
      const connection = connectionsById.get(role.connectionId);
      if (!connection) {
        throw new IdentityExportError(
          'ROLE_SCOPE_UNRESOLVED',
          `${user.userName} has a direct role whose connection could not be resolved. No file was downloaded.`,
        );
      }
      uniqueCatalogName('connection', connection.name, connectionNameCandidates.get(normalizedName(connection.name)) || []);

      if (roleName === 'CONNECTION_ADMIN') {
        adminConnections.add(connection.id);
        const directKey = `${roleName}|${connection.id}`;
        if (directRoleKeys.has(directKey)) continue;
        directRoleKeys.add(directKey);
        directRoleTargetCount += 1;
        groupedModels.set(directKey, { roleName, connection, modelNames: new Set() });
        continue;
      }
      if (!role.modelId) {
        throw new IdentityExportError(
          'ROLE_SCOPE_UNRESOLVED',
          `${user.userName} has a direct ${identityModelRoleLabel(roleName)} assignment without a model. No file was downloaded.`,
        );
      }
      const model = modelsById.get(role.modelId);
      if (!model || model.connectionId !== connection.id) {
        throw new IdentityExportError(
          'ROLE_SCOPE_UNRESOLVED',
          `${user.userName} has a direct role whose model could not be resolved in its connection. No file was downloaded.`,
        );
      }
      uniqueCatalogName(
        'model',
        model.name,
        modelNameCandidates.get(`${connection.id}|${normalizedName(model.name)}`) || [],
      );
      const scopeKey = `${connection.id}|${model.id}`;
      const existingRole = modelRoleByScope.get(scopeKey);
      if (existingRole && existingRole !== roleName) {
        throw new IdentityExportError(
          'ROLE_SCOPE_AMBIGUOUS',
          `${user.userName} has multiple direct roles for the same model. Resolve the conflicting assignments before exporting.`,
        );
      }
      modelRoleByScope.set(scopeKey, roleName);
      const directKey = `${roleName}|${connection.id}|${model.id}`;
      if (directRoleKeys.has(directKey)) continue;
      directRoleKeys.add(directKey);
      directRoleTargetCount += 1;
      const groupKey = `${roleName}|${connection.id}`;
      const group = groupedModels.get(groupKey) || { roleName, connection, modelNames: new Set<string>() };
      group.modelNames.add(model.name);
      groupedModels.set(groupKey, group);
    }

    for (const connectionId of adminConnections) {
      if ([...modelRoleByScope.keys()].some((key) => key.startsWith(`${connectionId}|`))) {
        throw new IdentityExportError(
          'ROLE_SCOPE_AMBIGUOUS',
          `${user.userName} has Connection Admin and model-scoped direct roles on the same connection. That state cannot be round-tripped safely.`,
        );
      }
    }

    const roleGroups = [...groupedModels.values()].sort((left, right) => (
      left.connection.name.localeCompare(right.connection.name)
      || identityModelRoleLabel(left.roleName).localeCompare(identityModelRoleLabel(right.roleName))
    ));
    const userRoleRows: Array<[string, string, string]> = [];
    for (const roleGroup of roleGroups) {
      const modelNames = [...roleGroup.modelNames].sort((left, right) => left.localeCompare(right));
      const modelChunks = roleGroup.roleName === 'CONNECTION_ADMIN'
        ? [[]]
        : chunk(modelNames, IDENTITY_IMPORT_LIMITS.maxListValuesPerCell);
      for (const modelChunk of modelChunks) {
        userRoleRows.push([
          identityModelRoleLabel(roleGroup.roleName),
          joinIdentityList([roleGroup.connection.name]),
          joinIdentityList(modelChunk),
        ]);
      }
    }
    roleRowCount += userRoleRows.length;
    if (markNoAssignment) {
      userRoleRows.push([IDENTITY_NO_ASSIGNMENT_LABEL, '', '']);
    }

    const groupChunks = chunk(groupNames, IDENTITY_IMPORT_LIMITS.maxListValuesPerCell);
    const userRowCount = Math.max(1, groupChunks.length, userRoleRows.length);
    for (let index = 0; index < userRowCount; index += 1) {
      const roleCells = userRoleRows[index] || ['', '', ''];
      rows.push([
        'add',
        escapeIdentityCsvValue(user.displayName || ''),
        escapeIdentityCsvValue(user.userName),
        joinIdentityList(groupChunks[index] || []),
        ...roleCells,
      ]);
    }
  }

  if (directRoleTargetCount > IDENTITY_IMPORT_LIMITS.maxTotalRoleTargets) {
    throw new IdentityExportError(
      'EXPORT_LIMIT_EXCEEDED',
      `The complete export contains ${directRoleTargetCount.toLocaleString()} role targets, exceeding the ${IDENTITY_IMPORT_LIMITS.maxTotalRoleTargets.toLocaleString()}-target import limit. No partial export was downloaded.`,
    );
  }
  const compiledOperations = sortedUsers.length
    + uniqueGroups.size
    + userGroupMembershipCount
    + roleRowCount;
  if (compiledOperations > IDENTITY_IMPORT_LIMITS.maxCompiledOperations) {
    throw new IdentityExportError(
      'EXPORT_LIMIT_EXCEEDED',
      `The complete export compiles to ${compiledOperations.toLocaleString()} operations, exceeding the ${IDENTITY_IMPORT_LIMITS.maxCompiledOperations.toLocaleString()}-operation import limit. No partial export was downloaded.`,
    );
  }
  if (rows.length - 1 > IDENTITY_IMPORT_LIMITS.maxRows) {
    throw new IdentityExportError(
      'EXPORT_LIMIT_EXCEEDED',
      `The complete export requires ${(rows.length - 1).toLocaleString()} rows, exceeding the ${IDENTITY_IMPORT_LIMITS.maxRows.toLocaleString()}-row import limit. No partial export was downloaded.`,
    );
  }
  return rows;
}

async function readRolesWithRetry(
  baseUrl: string,
  apiKey: string,
  userId: string,
  scope: IdentityExportScope,
  pacer: RoleReadPacer,
): Promise<readonly UserModelRoleRecord[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ROLE_READ_MAX_ATTEMPTS; attempt += 1) {
    assertActive(scope);
    await pacer.waitForTurn(scope.signal);
    assertActive(scope);
    try {
      return (await listUserModelRoles(baseUrl, apiKey, userId, {
        signal: scope.signal,
        requestSpacingMs: pacer.requestSpacingMs,
      })).results;
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || error.status !== 429 || attempt === ROLE_READ_MAX_ATTEMPTS - 1) {
        throw error;
      }
      const retryDelayMs = error.retryAfterMs ?? Math.min(2_000 * (2 ** attempt), 8_000);
      pacer.noteRateLimit(Math.min(Math.max(retryDelayMs, 1_000), 60_000));
    }
  }
  throw lastError;
}

export async function prepareIdentityUserExport(
  baseUrl: string,
  apiKey: string,
  scope: IdentityExportScope,
  onProgress?: (progress: IdentityExportProgress) => void,
): Promise<IdentityExportResult> {
  assertActive(scope);
  onProgress?.({
    completed: 0,
    total: 1,
    stage: 'Users',
    phase: 1,
    phaseTotal: 3,
    stageCompleted: 0,
    stageTotal: 1,
    message: `Refreshing users for ${scope.label}...`,
  });
  const userResponse = await listAllUsers(baseUrl, apiKey, {
    pageSize: 100,
    maxPages: 200,
    signal: scope.signal,
  });
  assertActive(scope);
  const resources = userResponse.Resources || [];
  const totalResults = Number(userResponse.totalResults);
  if (
    userResponse.error
    || userResponse.truncated
    || !Number.isSafeInteger(totalResults)
    || totalResults < 0
    || resources.length !== totalResults
  ) {
    throw new IdentityExportError(
      'USER_INVENTORY_INCOMPLETE',
      `The user collection is incomplete: ${resources.length} of ${Number.isSafeInteger(totalResults) ? totalResults : 'an unknown total'} records were loaded. No partial export was downloaded.`,
    );
  }
  const users = resources.map(mapScimExportUser);
  const total = users.length + 2;
  onProgress?.({
    completed: 1,
    total,
    stage: 'Access catalog',
    phase: 2,
    phaseTotal: 3,
    stageCompleted: 0,
    stageTotal: 1,
    message: 'Refreshing connection and model names...',
  });

  const [connectionPayload, sharedModelPayload, extensionModelPayload] = await Promise.all([
    listConnections(baseUrl, apiKey, { forceRefresh: true, signal: scope.signal }),
    listModels(baseUrl, apiKey, {
      modelKind: EXPORT_MODEL_KINDS[0],
      allPages: true,
      pageSize: 100,
      forceRefresh: true,
      signal: scope.signal,
    }),
    listModels(baseUrl, apiKey, {
      modelKind: EXPORT_MODEL_KINDS[1],
      allPages: true,
      pageSize: 100,
      forceRefresh: true,
      signal: scope.signal,
    }),
  ]);
  assertActive(scope);
  const connections = parseConnections(connectionPayload);
  const models = [
    ...parseModels(sharedModelPayload, EXPORT_MODEL_KINDS[0]),
    ...parseModels(extensionModelPayload, EXPORT_MODEL_KINDS[1]),
  ];
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new IdentityExportError(
      'ROLE_SCOPE_AMBIGUOUS',
      'Omni returned duplicate model identities across permission inventories. No file was downloaded.',
    );
  }

  // Permission exports must always use fresh role evidence. Reusing a prior
  // browser-session read could recreate access that was revoked elsewhere.
  const rolesByUserId = new Map<string, readonly UserModelRoleRecord[]>();
  const usersToRead = users;
  const requestsPerMinute = scope.roleRequestsPerMinute === 500 ? 500 : 60;
  const pacer = createRoleReadPacer(requestsPerMinute);
  let nextUserIndex = 0;
  let freshlyReadUserCount = 0;
  let completedUserCount = 0;
  const roleReadStartedAt = Date.now();
  const roleReadController = new AbortController();
  const abortRoleReads = () => roleReadController.abort();
  if (scope.signal?.aborted) abortRoleReads();
  else scope.signal?.addEventListener('abort', abortRoleReads, { once: true });
  const roleReadScope: IdentityExportScope = {
    ...scope,
    signal: roleReadController.signal,
  };

  const reportRoleProgress = () => {
    const remainingFreshReads = usersToRead.length - freshlyReadUserCount;
    const observedMsPerRead = freshlyReadUserCount >= Math.min(ROLE_READ_CONCURRENCY, usersToRead.length)
      ? Math.max(1, (Date.now() - roleReadStartedAt) / freshlyReadUserCount)
      : pacer.requestSpacingMs;
    const estimatedRemainingMs = remainingFreshReads === 0
      ? 0
      : Math.ceil(remainingFreshReads * Math.max(pacer.requestSpacingMs, observedMsPerRead));
    onProgress?.({
      completed: 2 + completedUserCount,
      total,
      stage: 'User access',
      phase: 3,
      phaseTotal: 3,
      stageCompleted: completedUserCount,
      stageTotal: users.length,
      message: completedUserCount === users.length
        ? `Verified user access for all ${users.length.toLocaleString()} users.`
        : `Verified user access for ${completedUserCount.toLocaleString()} of ${users.length.toLocaleString()} users.`,
      estimatedRemainingMs,
    });
  };

  reportRoleProgress();
  const readNextUser = async () => {
    while (true) {
      assertActive(roleReadScope);
      const userIndex = nextUserIndex;
      nextUserIndex += 1;
      if (userIndex >= usersToRead.length) return;
      const user = usersToRead[userIndex];
      try {
        const roles = await readRolesWithRetry(baseUrl, apiKey, user.id, roleReadScope, pacer);
        assertActive(roleReadScope);
        rolesByUserId.set(user.id, roles);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof IdentityExportError) throw error;
        throw new IdentityExportError(
          'ROLE_EVIDENCE_INCOMPLETE',
          `Role evidence could not be verified for ${user.userName}. No partial export was downloaded.`,
        );
      }
      freshlyReadUserCount += 1;
      completedUserCount += 1;
      reportRoleProgress();
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(ROLE_READ_CONCURRENCY, usersToRead.length) },
        () => readNextUser(),
      ),
    );
  } finally {
    roleReadController.abort();
    scope.signal?.removeEventListener('abort', abortRoleReads);
  }
  assertActive(scope);

  const rows = buildIdentityExportRows({ users, rolesByUserId, connections, models });
  const directRoleCount = [...rolesByUserId.values()]
    .flatMap((roles) => [...roles])
    .filter((role) => ROLE_SOURCE_TYPES.has(role.from?.type)).length;
  const noAssignmentUserCount = users.filter((user) => (
    shouldMarkNoAssignment(rolesByUserId.get(user.id) || [])
  )).length;
  const unknownAssignmentSourceUserCount = users.filter((user) => (
    hasUnknownAssignmentSource(rolesByUserId.get(user.id) || [])
  )).length;
  return {
    rows,
    userCount: users.length,
    directRoleCount,
    noAssignmentUserCount,
    unknownAssignmentSourceUserCount,
  };
}
