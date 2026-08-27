import type {
  OmniDocumentAccessInventoryResult,
  OmniModelRoleRecord,
  OmniUserGroupRecord,
} from './omniClient';

export const IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION = 'omnikit.identity-access-evidence.v1' as const;

export const IDENTITY_ACCESS_MODEL_ROLES = [
  'VIEWER',
  'QUERY_TOPICS',
  'QUERIER',
  'MODELER',
  'CONNECTION_ADMIN',
  'NO_ACCESS',
] as const;

export const IDENTITY_ACCESS_CONTENT_ROLES = ['NO_ACCESS', 'VIEWER', 'EDITOR', 'MANAGER'] as const;

export type IdentityAccessPrincipalType = 'user' | 'group';
export type IdentityAccessEvidenceClassification = 'observed' | 'inferred' | 'operator_confirmed' | 'unverified';
export type IdentityAccessCoverageState = 'complete' | 'partial' | 'unavailable' | 'not_requested';
export type IdentityAccessModelRole = typeof IDENTITY_ACCESS_MODEL_ROLES[number];
export type IdentityAccessContentRole = typeof IDENTITY_ACCESS_CONTENT_ROLES[number];

export interface IdentityAccessExpectedAccess {
  active?: boolean;
  modelRole?: IdentityAccessModelRole;
  contentRole?: IdentityAccessContentRole;
}

export interface IdentityAccessEvidenceInput {
  instanceId: string;
  instanceLabel: string;
  principalType: IdentityAccessPrincipalType;
  principalIdentifier: string;
  connectionId?: string;
  modelId?: string;
  folderId?: string;
  documentId?: string;
  expectedAccess?: IdentityAccessExpectedAccess;
}

export interface IdentityAccessEvidenceSource {
  kind: 'omni_api' | 'operator_input' | 'correlation';
  method?: 'GET';
  path?: string;
}

export interface IdentityAccessFinding {
  id: string;
  classification: IdentityAccessEvidenceClassification;
  severity: 'info' | 'success' | 'warning';
  label: string;
  message: string;
  coverageSource: IdentityAccessCoverageSource;
  source: IdentityAccessEvidenceSource;
}

export type IdentityAccessCoverageSource =
  | 'identity'
  | 'group_membership'
  | 'model_roles'
  | 'document_access'
  | 'folder_context'
  | 'expected_access';

export interface IdentityAccessCoverage {
  source: IdentityAccessCoverageSource;
  state: IdentityAccessCoverageState;
  included: number;
  total: number | null;
  reason: string;
  exclusions: string[];
}

export interface IdentityAccessPrincipalEvidence {
  type: IdentityAccessPrincipalType;
  id: string;
  displayName: string;
  email?: string;
  active?: boolean;
  createdAt?: string;
  lastLogin?: string | null;
  classification: 'observed';
}

export interface IdentityAccessGroupEvidence {
  id: string;
  displayName: string;
  relationship: 'selected' | 'member';
  classification: IdentityAccessEvidenceClassification;
}

export interface IdentityAccessModelRoleEvidence {
  principalType: IdentityAccessPrincipalType;
  principalId: string;
  principalName: string;
  roleName: string;
  baseRole?: string;
  connectionId?: string;
  modelId?: string;
  resolved?: boolean;
  provenance?: {
    type?: string;
    name?: string;
    depth?: number;
  };
  classification: 'observed';
}

export interface IdentityAccessDocumentEvidence {
  principalType: 'user' | 'group';
  principalId: string;
  principalName: string;
  role: IdentityAccessContentRole;
  accessSource: 'direct' | 'folder';
  accessBoost: boolean;
  isOwner: boolean;
  folder?: {
    id?: string;
    name?: string;
    path?: string;
  };
  relationship: 'direct' | 'group';
  classification: 'observed';
}

export interface IdentityAccessLifecycleEvidence {
  state: 'active' | 'inactive' | 'group' | 'unknown';
  lastLogin?: string | null;
  inactiveGroupMembers?: number;
  unknownLifecycleGroupMembers?: number;
  unresolvedGroupMembers?: number;
  offboardingExposure: string[];
}

export interface IdentityAccessEvidenceReport {
  schemaVersion: typeof IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION;
  instance: {
    id: string;
    label: string;
  };
  checkedAt: string;
  scope: {
    principalType: IdentityAccessPrincipalType;
    principalIdentifier: string;
    connectionId?: string;
    modelId?: string;
    folderId?: string;
    documentId?: string;
    expectedAccess?: IdentityAccessExpectedAccess;
  };
  principal: IdentityAccessPrincipalEvidence;
  groups: IdentityAccessGroupEvidence[];
  modelRoles: IdentityAccessModelRoleEvidence[];
  documentAccess: IdentityAccessDocumentEvidence[];
  lifecycle: IdentityAccessLifecycleEvidence;
  findings: IdentityAccessFinding[];
  coverage: IdentityAccessCoverage[];
  exclusions: string[];
}

export interface IdentityAccessEvidenceReader {
  listIdentityUsers(signal?: AbortSignal): Promise<IdentityAccessUserRecord[]>;
  listUserGroups(signal?: AbortSignal): Promise<OmniUserGroupRecord[]>;
  getUserGroup(groupId: string, signal?: AbortSignal): Promise<OmniUserGroupRecord>;
  listUserModelRoles(
    userId: string,
    options?: { modelId?: string; connectionId?: string },
    signal?: AbortSignal,
  ): Promise<OmniModelRoleRecord[]>;
  listUserGroupModelRoles(
    groupId: string,
    options?: { modelId?: string; connectionId?: string },
    signal?: AbortSignal,
  ): Promise<OmniModelRoleRecord[]>;
  listDocumentAccessInventory(
    documentId: string,
    options?: { accessSource?: 'direct' | 'folder'; type?: 'user' | 'userGroup' },
    signal?: AbortSignal,
  ): Promise<OmniDocumentAccessInventoryResult>;
}

export interface IdentityAccessUserRecord {
  id: string;
  displayName?: string;
  userName: string;
  email?: string;
  active?: boolean;
  createdAt?: string;
  lastLogin?: string | null;
}

export interface IdentityAccessScimUserPageReader {
  (count: number, startIndex: number, signal?: AbortSignal): Promise<unknown>;
}

export class IdentityAccessEvidenceError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'PRINCIPAL_NOT_FOUND' | 'PRINCIPAL_AMBIGUOUS' | 'IDENTITY_UNAVAILABLE',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'IdentityAccessEvidenceError';
  }
}

const MAX_INPUT_LENGTH = 500;
const MAX_GROUP_DETAIL_READS = 25;
const MAX_GROUP_ROLE_READS = 25;
const SCIM_USER_PAGE_SIZE = 100;
const MAX_SCIM_USER_PAGES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseIdentityAccessUser(value: unknown): IdentityAccessUserRecord {
  if (!isRecord(value)) throw new Error('Omni returned an invalid SCIM user collection.');
  const id = firstString(value.id);
  const userName = firstString(value.userName, value.username);
  if (!id || !userName) throw new Error('Omni returned an invalid SCIM user collection.');
  if (Object.prototype.hasOwnProperty.call(value, 'active') && typeof value.active !== 'boolean') {
    throw new Error('Omni returned an invalid SCIM user collection.');
  }
  if (value.displayName !== undefined && typeof value.displayName !== 'string') {
    throw new Error('Omni returned an invalid SCIM user collection.');
  }

  const emails = Array.isArray(value.emails) ? value.emails : [];
  const primaryEmail = emails
    .filter(isRecord)
    .sort((left, right) => Number(right.primary === true) - Number(left.primary === true))
    .map((email) => firstString(email.value))
    .find(Boolean);
  const meta = isRecord(value.meta) ? value.meta : {};
  const extension = isRecord(value['urn:omni:params:scim:schemas:extension:user:2.0'])
    ? value['urn:omni:params:scim:schemas:extension:user:2.0'] as Record<string, unknown>
    : {};
  return {
    id,
    userName,
    ...(firstString(value.displayName) ? { displayName: firstString(value.displayName) } : {}),
    email: primaryEmail || userName,
    ...(typeof value.active === 'boolean' ? { active: value.active } : {}),
    ...(firstString(meta.created, value.createdAt, value.created_at) ? {
      createdAt: firstString(meta.created, value.createdAt, value.created_at),
    } : {}),
    lastLogin: firstString(extension.lastLogin, extension.last_login, value.lastLogin, value.last_login) ?? null,
  };
}

function parseIdentityAccessUserPage(
  payload: unknown,
  requestedCount: number,
  requestedStartIndex: number,
): { users: IdentityAccessUserRecord[]; totalResults: number; itemsPerPage: number } {
  if (!isRecord(payload) || Object.prototype.hasOwnProperty.call(payload, 'error')) {
    throw new Error('Omni could not complete the SCIM user collection read.');
  }
  if (
    !Array.isArray(payload.Resources)
    || !nonNegativeInteger(payload.totalResults)
    || !nonNegativeInteger(payload.itemsPerPage)
    || !positiveInteger(payload.startIndex)
    || payload.startIndex !== requestedStartIndex
    || payload.itemsPerPage !== payload.Resources.length
    || payload.Resources.length > requestedCount
  ) {
    throw new Error('Omni returned an invalid SCIM user collection.');
  }
  const remainingResults = Math.max(0, payload.totalResults - (requestedStartIndex - 1));
  if (payload.Resources.length > Math.min(requestedCount, remainingResults)) {
    throw new Error('Omni returned an invalid SCIM user collection.');
  }
  if (remainingResults > 0 && payload.Resources.length === 0) {
    throw new Error('Omni returned an incomplete SCIM user collection.');
  }
  const users = payload.Resources.map(parseIdentityAccessUser);
  if (new Set(users.map((user) => user.id)).size !== users.length) {
    throw new Error('Omni returned an invalid SCIM user collection.');
  }
  return { users, totalResults: payload.totalResults, itemsPerPage: payload.itemsPerPage };
}

export async function listIdentityAccessUsers(
  readPage: IdentityAccessScimUserPageReader,
  signal?: AbortSignal,
): Promise<IdentityAccessUserRecord[]> {
  const users: IdentityAccessUserRecord[] = [];
  const ids = new Set<string>();
  let startIndex = 1;
  let totalResults: number | undefined;

  for (let page = 0; page < MAX_SCIM_USER_PAGES; page += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException('The request was cancelled.', 'AbortError');
    const parsed = parseIdentityAccessUserPage(
      await readPage(SCIM_USER_PAGE_SIZE, startIndex, signal),
      SCIM_USER_PAGE_SIZE,
      startIndex,
    );
    if (totalResults !== undefined && parsed.totalResults !== totalResults) {
      throw new Error('Omni changed the SCIM user collection while it was being read.');
    }
    totalResults = parsed.totalResults;
    for (const user of parsed.users) {
      if (ids.has(user.id)) throw new Error('Omni returned a duplicate SCIM user across pages.');
      ids.add(user.id);
      users.push(user);
    }
    if (users.length === totalResults) return users;
    if (users.length > totalResults || parsed.itemsPerPage <= 0) {
      throw new Error('Omni returned an incomplete SCIM user collection.');
    }
    startIndex += parsed.itemsPerPage;
  }
  throw new Error('The SCIM user collection exceeded the bounded evidence window.');
}

function normalized(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function boundedInput(value: string | undefined, label: string, required = false): string | undefined {
  const clean = value?.trim();
  if (!clean) {
    if (required) throw new IdentityAccessEvidenceError('INVALID_INPUT', `${label} is required.`, 400);
    return undefined;
  }
  if (clean.length > MAX_INPUT_LENGTH || hasControlCharacters(clean)) {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', `${label} is invalid.`, 400);
  }
  return clean;
}

function validateExpectedAccess(expected: IdentityAccessExpectedAccess | undefined): IdentityAccessExpectedAccess | undefined {
  if (!expected) return undefined;
  if (expected.active !== undefined && typeof expected.active !== 'boolean') {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', 'Expected lifecycle state is invalid.', 400);
  }
  if (expected.modelRole !== undefined && !IDENTITY_ACCESS_MODEL_ROLES.includes(expected.modelRole)) {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', 'Expected model role is invalid.', 400);
  }
  if (expected.contentRole !== undefined && !IDENTITY_ACCESS_CONTENT_ROLES.includes(expected.contentRole)) {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', 'Expected content role is invalid.', 400);
  }
  return Object.keys(expected).length > 0 ? expected : undefined;
}

export function validateIdentityAccessEvidenceInput(input: IdentityAccessEvidenceInput): IdentityAccessEvidenceInput {
  if (input.principalType !== 'user' && input.principalType !== 'group') {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', 'Principal type must be user or group.', 400);
  }
  const instanceId = boundedInput(input.instanceId, 'Selected instance', true)!;
  const instanceLabel = boundedInput(input.instanceLabel, 'Selected instance label', true)!;
  const principalIdentifier = boundedInput(input.principalIdentifier, 'Principal identifier', true)!;
  const connectionId = boundedInput(input.connectionId, 'Connection ID');
  const modelId = boundedInput(input.modelId, 'Model ID');
  const folderId = boundedInput(input.folderId, 'Folder ID or path');
  const documentId = boundedInput(input.documentId, 'Document ID');
  const expectedAccess = validateExpectedAccess(input.expectedAccess);
  return {
    instanceId,
    instanceLabel,
    principalType: input.principalType,
    principalIdentifier,
    ...(connectionId ? { connectionId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(folderId ? { folderId } : {}),
    ...(documentId ? { documentId } : {}),
    ...(expectedAccess ? { expectedAccess } : {}),
  };
}

function resolveUser(users: IdentityAccessUserRecord[], identifier: string): IdentityAccessUserRecord {
  const key = normalized(identifier);
  const matches = users.filter((user) => (
    user.id === identifier.trim()
    || normalized(user.userName) === key
    || (user.email ? normalized(user.email) === key : false)
  ));
  const unique = [...new Map(matches.map((user) => [user.id, user])).values()];
  if (unique.length === 0) {
    throw new IdentityAccessEvidenceError('PRINCIPAL_NOT_FOUND', 'The requested user was not returned by the complete identity read.', 404);
  }
  if (unique.length > 1) {
    throw new IdentityAccessEvidenceError('PRINCIPAL_AMBIGUOUS', 'The requested user matched more than one identity.', 409);
  }
  return unique[0];
}

function resolveGroup(groups: OmniUserGroupRecord[], identifier: string): OmniUserGroupRecord {
  const key = normalized(identifier);
  const matches = groups.filter((group) => group.id === identifier.trim() || normalized(group.displayName) === key);
  const unique = [...new Map(matches.map((group) => [group.id, group])).values()];
  if (unique.length === 0) {
    throw new IdentityAccessEvidenceError('PRINCIPAL_NOT_FOUND', 'The requested group was not returned by the complete identity read.', 404);
  }
  if (unique.length > 1) {
    throw new IdentityAccessEvidenceError('PRINCIPAL_AMBIGUOUS', 'The requested group name matched more than one identity.', 409);
  }
  return unique[0];
}

function groupContainsUser(group: OmniUserGroupRecord, userId: string): boolean {
  return group.members?.some((member) => member.value === userId) === true;
}

function roleKey(role: IdentityAccessModelRoleEvidence): string {
  return [
    role.principalType,
    role.principalId,
    role.roleName,
    role.baseRole || '',
    role.connectionId || '',
    role.modelId || '',
    role.provenance?.type || '',
    role.provenance?.name || '',
  ].join('\u0000');
}

function normalizeRoleEvidence(
  role: OmniModelRoleRecord,
  principal: { type: IdentityAccessPrincipalType; id: string; name: string },
): IdentityAccessModelRoleEvidence {
  return {
    principalType: principal.type,
    principalId: principal.id,
    principalName: principal.name,
    roleName: role.roleName,
    ...(role.baseRole ? { baseRole: role.baseRole } : {}),
    ...(role.connectionId ? { connectionId: role.connectionId } : {}),
    ...(role.modelId ? { modelId: role.modelId } : {}),
    ...(typeof role.resolved === 'boolean' ? { resolved: role.resolved } : {}),
    ...(role.from ? {
      provenance: {
        ...(role.from.type ? { type: role.from.type } : {}),
        ...(role.from.name ? { name: role.from.name } : {}),
        ...(typeof role.from.depth === 'number' ? { depth: role.from.depth } : {}),
      },
    } : {}),
    classification: 'observed',
  };
}

function folderMatches(folderId: string | undefined, folder: IdentityAccessDocumentEvidence['folder']): boolean {
  if (!folderId || !folder) return false;
  const key = normalized(folderId);
  return [folder.id, folder.name, folder.path].some((value) => value ? normalized(value) === key : false);
}

function matchingDocumentAccess(
  report: OmniDocumentAccessInventoryResult,
  principal: IdentityAccessPrincipalEvidence,
  groupIds: Set<string>,
): IdentityAccessDocumentEvidence[] {
  return report.principals.flatMap((entry): IdentityAccessDocumentEvidence[] => {
    const directUser = principal.type === 'user'
      && entry.type === 'user'
      && (entry.id === principal.id || (principal.email && entry.email && normalized(entry.email) === normalized(principal.email)));
    const directGroup = principal.type === 'group' && entry.type === 'userGroup' && entry.id === principal.id;
    const inheritedGroup = principal.type === 'user' && entry.type === 'userGroup' && groupIds.has(entry.id);
    if (!directUser && !directGroup && !inheritedGroup) return [];
    return [{
      principalType: entry.type === 'user' ? 'user' : 'group',
      principalId: entry.id,
      principalName: entry.name,
      role: entry.role,
      accessSource: entry.accessSource,
      accessBoost: entry.accessBoost,
      isOwner: entry.isOwner,
      ...(entry.folderInfo ? { folder: { ...entry.folderInfo } } : {}),
      relationship: inheritedGroup ? 'group' : 'direct',
      classification: 'observed',
    }];
  });
}

async function boundedMap<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildIdentityAccessEvidence(
  rawInput: IdentityAccessEvidenceInput,
  reader: IdentityAccessEvidenceReader,
  signal?: AbortSignal,
): Promise<IdentityAccessEvidenceReport> {
  const input = validateIdentityAccessEvidenceInput(rawInput);
  const checkedAt = new Date().toISOString();
  const findings: IdentityAccessFinding[] = [];
  const coverage: IdentityAccessCoverage[] = [];
  const exclusions = new Set<string>();
  let findingIndex = 0;
  const addFinding = (finding: Omit<IdentityAccessFinding, 'id'>) => {
    findingIndex += 1;
    findings.push({ id: `access-finding-${findingIndex}`, ...finding });
  };

  let users: IdentityAccessUserRecord[];
  let groups: OmniUserGroupRecord[];
  try {
    [users, groups] = await Promise.all([
      reader.listIdentityUsers(signal),
      reader.listUserGroups(signal),
    ]);
  } catch {
    throw new IdentityAccessEvidenceError('IDENTITY_UNAVAILABLE', 'Identity and group evidence could not be collected.', 502);
  }

  const selectedUser = input.principalType === 'user' ? resolveUser(users, input.principalIdentifier) : undefined;
  const selectedGroup = input.principalType === 'group' ? resolveGroup(groups, input.principalIdentifier) : undefined;
  const principal: IdentityAccessPrincipalEvidence = selectedUser
    ? {
      type: 'user',
      id: selectedUser.id,
      displayName: selectedUser.displayName || selectedUser.email || selectedUser.userName,
      ...(selectedUser.email || selectedUser.userName ? { email: selectedUser.email || selectedUser.userName } : {}),
      ...(typeof selectedUser.active === 'boolean' ? { active: selectedUser.active } : {}),
      ...(selectedUser.createdAt ? { createdAt: selectedUser.createdAt } : {}),
      lastLogin: selectedUser.lastLogin ?? null,
      classification: 'observed',
    }
    : {
      type: 'group',
      id: selectedGroup!.id,
      displayName: selectedGroup!.displayName,
      classification: 'observed',
    };

  coverage.push({
    source: 'identity',
    state: 'complete',
    included: 1,
    total: 1,
    reason: 'The explicit principal was resolved from a complete documented SCIM collection read.',
    exclusions: [],
  });
  addFinding({
    classification: 'observed',
    severity: 'success',
    label: `${input.principalType === 'user' ? 'User' : 'Group'} identity resolved`,
    message: `${principal.displayName} was returned with the exact principal identifier ${principal.id}.`,
    coverageSource: 'identity',
    source: { kind: 'omni_api', method: 'GET', path: input.principalType === 'user' ? '/api/scim/v2/users' : '/api/scim/v2/groups' },
  });

  const knownGroups: OmniUserGroupRecord[] = [];
  let membershipKnown = 0;
  let membershipFailures = 0;
  let membershipCapped = 0;

  if (selectedGroup) {
    let detail = selectedGroup;
    if (!detail.members) {
      try {
        detail = await reader.getUserGroup(detail.id, signal);
      } catch {
        membershipFailures += 1;
      }
    }
    if (detail.members) {
      membershipKnown = 1;
      knownGroups.push(detail);
    }
  } else if (selectedUser) {
    const detailed = groups.filter((group) => group.members !== undefined);
    const unresolved = groups.filter((group) => group.members === undefined);
    membershipKnown += detailed.length;
    knownGroups.push(...detailed.filter((group) => groupContainsUser(group, selectedUser.id)));
    const reads = unresolved.slice(0, MAX_GROUP_DETAIL_READS);
    membershipCapped = Math.max(0, unresolved.length - reads.length);
    const results = await boundedMap(reads, 3, async (group) => {
      try {
        return { group: await reader.getUserGroup(group.id, signal), available: true as const };
      } catch {
        return { group, available: false as const };
      }
    });
    for (const result of results) {
      if (!result.available || !result.group.members) {
        membershipFailures += 1;
        continue;
      }
      membershipKnown += 1;
      if (groupContainsUser(result.group, selectedUser.id)) knownGroups.push(result.group);
    }
  }

  const membershipTotal = selectedGroup ? 1 : groups.length;
  const membershipComplete = membershipKnown === membershipTotal;
  const membershipExclusions: string[] = [];
  if (membershipFailures > 0) membershipExclusions.push(`${membershipFailures} group membership detail read${membershipFailures === 1 ? '' : 's'} failed or omitted members.`);
  if (membershipCapped > 0) membershipExclusions.push(`${membershipCapped} group membership detail read${membershipCapped === 1 ? ' was' : 's were'} outside the bounded ${MAX_GROUP_DETAIL_READS}-group inspection window.`);
  membershipExclusions.forEach((value) => exclusions.add(value));
  coverage.push({
    source: 'group_membership',
    state: membershipComplete ? 'complete' : membershipKnown > 0 ? 'partial' : 'unavailable',
    included: membershipKnown,
    total: membershipTotal,
    reason: membershipComplete
      ? 'Membership details were available for every group in scope.'
      : 'Only groups with documented member detail can be correlated safely.',
    exclusions: membershipExclusions,
  });

  const groupEvidence: IdentityAccessGroupEvidence[] = selectedGroup
    ? [{ id: selectedGroup.id, displayName: selectedGroup.displayName, relationship: 'selected', classification: 'observed' }]
    : [...new Map(knownGroups.map((group) => [group.id, group])).values()].map((group) => ({
      id: group.id,
      displayName: group.displayName,
      relationship: 'member' as const,
      classification: 'observed' as const,
    }));

  if (selectedUser) {
    addFinding({
      classification: membershipComplete ? 'observed' : 'unverified',
      severity: membershipComplete ? 'info' : 'warning',
      label: 'Group membership coverage',
      message: membershipComplete
        ? `${groupEvidence.length} matching group membership${groupEvidence.length === 1 ? ' was' : 's were'} returned by the complete read.`
        : `${groupEvidence.length} membership${groupEvidence.length === 1 ? ' was' : 's were'} observed, but incomplete group detail prevents a complete membership claim.`,
      coverageSource: 'group_membership',
      source: { kind: 'omni_api', method: 'GET', path: '/api/scim/v2/groups/:groupId' },
    });
  }

  const roleOptions = {
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  };
  const modelRoles: IdentityAccessModelRoleEvidence[] = [];
  let directRoleRead = false;
  let groupRoleReads = 0;
  let roleFailures = 0;
  try {
    const roles = selectedUser
      ? await reader.listUserModelRoles(selectedUser.id, roleOptions, signal)
      : await reader.listUserGroupModelRoles(selectedGroup!.id, roleOptions, signal);
    directRoleRead = true;
    modelRoles.push(...roles.map((role) => normalizeRoleEvidence(role, {
      type: input.principalType,
      id: principal.id,
      name: principal.displayName,
    })));
  } catch {
    roleFailures += 1;
  }

  if (selectedUser) {
    const roleGroups = knownGroups.slice(0, MAX_GROUP_ROLE_READS);
    if (knownGroups.length > roleGroups.length) {
      const message = `${knownGroups.length - roleGroups.length} observed groups were outside the bounded ${MAX_GROUP_ROLE_READS}-group role inspection window.`;
      exclusions.add(message);
    }
    const results = await boundedMap(roleGroups, 3, async (group) => {
      try {
        return { group, roles: await reader.listUserGroupModelRoles(group.id, roleOptions, signal), available: true as const };
      } catch {
        return { group, roles: [] as OmniModelRoleRecord[], available: false as const };
      }
    });
    for (const result of results) {
      if (!result.available) {
        roleFailures += 1;
        continue;
      }
      groupRoleReads += 1;
      modelRoles.push(...result.roles.map((role) => normalizeRoleEvidence(role, {
        type: 'group',
        id: result.group.id,
        name: result.group.displayName,
      })));
    }
  }

  const uniqueModelRoles = [...new Map(modelRoles.map((role) => [roleKey(role), role])).values()];
  const expectedRoleReads = 1 + (selectedUser ? Math.min(knownGroups.length, MAX_GROUP_ROLE_READS) : 0);
  const completedRoleReads = (directRoleRead ? 1 : 0) + groupRoleReads;
  const roleCoverageComplete = roleFailures === 0
    && completedRoleReads === expectedRoleReads
    && (!selectedUser || membershipComplete)
    && (!selectedUser || knownGroups.length <= MAX_GROUP_ROLE_READS);
  const roleExclusions = [...exclusions].filter((value) => /group|role/i.test(value));
  if (roleFailures > 0) roleExclusions.push(`${roleFailures} model-role read${roleFailures === 1 ? '' : 's'} failed.`);
  roleExclusions.forEach((value) => exclusions.add(value));
  coverage.push({
    source: 'model_roles',
    state: roleCoverageComplete ? 'complete' : completedRoleReads > 0 ? 'partial' : 'unavailable',
    included: completedRoleReads,
    total: expectedRoleReads,
    reason: roleCoverageComplete
      ? 'Direct and observed-group model-role reads completed for the requested scope.'
      : 'Model-role evidence is limited to successful direct and observed-group reads.',
    exclusions: roleExclusions,
  });
  addFinding({
    classification: roleCoverageComplete ? 'observed' : 'unverified',
    severity: roleCoverageComplete ? 'info' : 'warning',
    label: 'Model-role evidence',
    message: roleCoverageComplete
      ? `${uniqueModelRoles.length} scoped model-role assignment${uniqueModelRoles.length === 1 ? ' was' : 's were'} returned by Omni.`
      : `${uniqueModelRoles.length} model-role assignment${uniqueModelRoles.length === 1 ? ' was' : 's were'} observed, but incomplete role or membership reads prevent a complete effective-access claim.`,
    coverageSource: 'model_roles',
    source: { kind: 'omni_api', method: 'GET', path: input.principalType === 'user' ? '/api/v1/users/:userId/model-roles' : '/api/v1/user-groups/:groupId/model-roles' },
  });

  let documentAccess: IdentityAccessDocumentEvidence[] = [];
  let documentCoverageComplete = false;
  let documentCorrelationComplete = false;
  if (input.documentId) {
    try {
      const access = await reader.listDocumentAccessInventory(input.documentId, {}, signal);
      documentCoverageComplete = access.pagination.complete === true;
      documentCorrelationComplete = documentCoverageComplete && (!selectedUser || membershipComplete);
      documentAccess = matchingDocumentAccess(access, principal, new Set(groupEvidence.map((group) => group.id)));
      const documentExclusions = selectedUser && !membershipComplete
        ? ['Incomplete group membership evidence prevents a complete user-to-document correlation.']
        : [];
      documentExclusions.forEach((value) => exclusions.add(value));
      coverage.push({
        source: 'document_access',
        state: documentCorrelationComplete ? 'complete' : 'partial',
        included: access.pagination.returnedRecords,
        total: access.pagination.reportedTotalRecords ?? access.pagination.returnedRecords,
        reason: documentCorrelationComplete
          ? 'The complete document access list was correlated to the explicit principal and complete observed-group membership evidence.'
          : documentCoverageComplete
            ? 'The document access list completed, but group membership evidence was incomplete.'
            : 'The selected document access list was only partially returned.',
        exclusions: documentExclusions,
      });
      addFinding({
        classification: documentAccess.length > 0 || documentCorrelationComplete ? 'observed' : 'unverified',
        severity: documentAccess.length > 0 ? 'info' : documentCorrelationComplete ? 'success' : 'warning',
        label: 'Selected document access',
        message: documentAccess.length > 0
          ? `${documentAccess.length} direct or observed-group access entr${documentAccess.length === 1 ? 'y was' : 'ies were'} returned for the selected document.`
          : documentCorrelationComplete
            ? 'No matching direct or observed-group entry was returned by the complete document access list.'
            : 'Document access could not be resolved completely.',
        coverageSource: 'document_access',
        source: { kind: 'omni_api', method: 'GET', path: '/api/v1/documents/:documentId/access-list' },
      });
    } catch {
      const message = 'The selected document access list could not be read.';
      exclusions.add(message);
      coverage.push({ source: 'document_access', state: 'unavailable', included: 0, total: null, reason: message, exclusions: [message] });
      addFinding({
        classification: 'unverified',
        severity: 'warning',
        label: 'Selected document access unavailable',
        message,
        coverageSource: 'document_access',
        source: { kind: 'omni_api', method: 'GET', path: '/api/v1/documents/:documentId/access-list' },
      });
    }
  } else {
    const reason = 'No document was supplied, so document permissions were not read.';
    coverage.push({ source: 'document_access', state: 'not_requested', included: 0, total: null, reason, exclusions: [reason] });
    exclusions.add(reason);
  }

  if (input.folderId) {
    const matchingFolderEntries = documentAccess.filter((entry) => folderMatches(input.folderId, entry.folder));
    const reason = input.documentId
      ? 'Folder evidence is limited to inherited folder information returned by the selected document access list.'
      : 'A standalone documented folder-permission read is not available in this workflow; supply a document to inspect inherited folder evidence.';
    exclusions.add(reason);
    coverage.push({
      source: 'folder_context',
      state: input.documentId && documentCoverageComplete ? 'partial' : 'unavailable',
      included: matchingFolderEntries.length,
      total: null,
      reason,
      exclusions: [reason],
    });
    addFinding({
      classification: matchingFolderEntries.length > 0 ? 'observed' : 'unverified',
      severity: matchingFolderEntries.length > 0 ? 'info' : 'warning',
      label: 'Folder context',
      message: matchingFolderEntries.length > 0
        ? `${matchingFolderEntries.length} selected-document access entr${matchingFolderEntries.length === 1 ? 'y references' : 'ies reference'} the requested folder context.`
        : reason,
      coverageSource: 'folder_context',
      source: matchingFolderEntries.length > 0
        ? { kind: 'omni_api', method: 'GET', path: '/api/v1/documents/:documentId/access-list' }
        : { kind: 'correlation' },
    });
  } else {
    coverage.push({
      source: 'folder_context',
      state: 'not_requested',
      included: 0,
      total: null,
      reason: 'No folder context was supplied.',
      exclusions: [],
    });
  }

  const offboardingExposure: string[] = [];
  let lifecycle: IdentityAccessLifecycleEvidence;
  if (selectedUser) {
    const lifecycleObserved = typeof selectedUser.active === 'boolean';
    lifecycle = {
      state: lifecycleObserved ? selectedUser.active ? 'active' : 'inactive' : 'unknown',
      lastLogin: selectedUser.lastLogin ?? null,
      offboardingExposure,
    };
    addFinding({
      classification: lifecycleObserved ? 'observed' : 'unverified',
      severity: selectedUser.active === true ? 'success' : 'warning',
      label: lifecycleObserved
        ? selectedUser.active ? 'Standard user is active' : 'Standard user is inactive'
        : 'Standard-user lifecycle state was not returned',
      message: lifecycleObserved
        ? selectedUser.lastLogin
          ? `Omni returned the standard-user lifecycle state and a last-login timestamp of ${selectedUser.lastLogin}.`
          : 'Omni returned the standard-user lifecycle state, but no last-login timestamp was returned.'
        : 'The SCIM user record omitted active, so OmniKit cannot classify this standard user as active or inactive.',
      coverageSource: 'identity',
      source: { kind: 'omni_api', method: 'GET', path: '/api/scim/v2/users' },
    });
    if (selectedUser.active === false) {
      if (uniqueModelRoles.length > 0) offboardingExposure.push(`${uniqueModelRoles.length} observed model-role assignment${uniqueModelRoles.length === 1 ? '' : 's'}`);
      if (documentAccess.length > 0) offboardingExposure.push(`${documentAccess.length} selected-document access entr${documentAccess.length === 1 ? 'y' : 'ies'}`);
      if (documentAccess.some((entry) => entry.isOwner)) offboardingExposure.push('selected-document ownership');
      if (offboardingExposure.length > 0) {
        addFinding({
          classification: 'inferred',
          severity: 'warning',
          label: 'Inactive-user offboarding exposure',
          message: `The inactive standard user is correlated with ${offboardingExposure.join(', ')}. Review ownership and access in Omni before deprovisioning.`,
          coverageSource: documentAccess.length > 0 ? 'document_access' : 'model_roles',
          source: { kind: 'correlation' },
        });
      }
    }
  } else {
    const selectedMembers = knownGroups[0]?.members || [];
    const usersById = new Map(users.map((user) => [user.id, user]));
    const inactiveMembers = selectedMembers.filter((member) => usersById.get(member.value)?.active === false).length;
    const unknownLifecycleMembers = selectedMembers.filter((member) => {
      const user = usersById.get(member.value);
      return Boolean(user) && typeof user?.active !== 'boolean';
    }).length;
    const unresolvedMembers = selectedMembers.filter((member) => !usersById.has(member.value)).length;
    lifecycle = {
      state: 'group',
      inactiveGroupMembers: inactiveMembers,
      unknownLifecycleGroupMembers: unknownLifecycleMembers,
      unresolvedGroupMembers: unresolvedMembers,
      offboardingExposure,
    };
    addFinding({
      classification: membershipComplete && unresolvedMembers === 0 && unknownLifecycleMembers === 0 ? 'observed' : 'unverified',
      severity: inactiveMembers > 0 || unresolvedMembers > 0 || unknownLifecycleMembers > 0 ? 'warning' : 'success',
      label: 'Group lifecycle exposure',
      message: membershipComplete
        ? `${inactiveMembers} inactive standard-user member${inactiveMembers === 1 ? ' was' : 's were'} correlated to this group${unknownLifecycleMembers > 0 ? `; ${unknownLifecycleMembers} member lifecycle state${unknownLifecycleMembers === 1 ? ' was' : 's were'} not returned` : ''}${unresolvedMembers > 0 ? `; ${unresolvedMembers} member identities were unresolved` : ''}.`
        : 'Group member lifecycle exposure could not be completely correlated.',
      coverageSource: 'group_membership',
      source: { kind: 'correlation' },
    });
  }

  if (input.expectedAccess) {
    const expectations = Object.entries(input.expectedAccess);
    coverage.push({
      source: 'expected_access',
      state: 'complete',
      included: expectations.length,
      total: expectations.length,
      reason: 'Expected access was supplied explicitly by the operator.',
      exclusions: [],
    });
    for (const [field, value] of expectations) {
      addFinding({
        classification: 'operator_confirmed',
        severity: 'info',
        label: `Expected ${field === 'modelRole' ? 'model role' : field === 'contentRole' ? 'content role' : 'lifecycle state'}`,
        message: field === 'active' ? `The operator expects this standard user to be ${value ? 'active' : 'inactive'}.` : `The operator expects ${String(value)}.`,
        coverageSource: 'expected_access',
        source: { kind: 'operator_input' },
      });
    }

    if (input.expectedAccess.active !== undefined) {
      if (!selectedUser) {
        addFinding({ classification: 'unverified', severity: 'warning', label: 'Expected lifecycle cannot be compared', message: 'Active/inactive state applies to a standard user, not a group.', coverageSource: 'expected_access', source: { kind: 'correlation' } });
      } else if (typeof selectedUser.active !== 'boolean') {
        addFinding({ classification: 'unverified', severity: 'warning', label: 'Expected lifecycle cannot be compared', message: 'The SCIM user record omitted active, so the operator-confirmed lifecycle expectation cannot be compared.', coverageSource: 'expected_access', source: { kind: 'correlation' } });
      } else {
        const matches = selectedUser.active === input.expectedAccess.active;
        addFinding({ classification: 'inferred', severity: matches ? 'success' : 'warning', label: matches ? 'Lifecycle expectation aligns' : 'Lifecycle expectation differs', message: matches ? 'The observed standard-user lifecycle state matches the operator-confirmed expectation.' : 'The observed standard-user lifecycle state does not match the operator-confirmed expectation.', coverageSource: 'identity', source: { kind: 'correlation' } });
      }
    }
    if (input.expectedAccess.modelRole) {
      const matches = uniqueModelRoles.some((role) => role.roleName === input.expectedAccess!.modelRole);
      addFinding({
        classification: matches || roleCoverageComplete ? 'inferred' : 'unverified',
        severity: matches ? 'success' : 'warning',
        label: matches ? 'Model-role expectation represented' : 'Model-role expectation not proven',
        message: matches
          ? 'The expected model role appears in the observed scoped assignment evidence; effective query, row, and field access still require test-user validation.'
          : roleCoverageComplete
            ? 'The expected model role does not appear in the complete scoped assignment evidence.'
            : 'Incomplete membership or role reads prevent a complete comparison to the expected model role.',
        coverageSource: 'model_roles',
        source: { kind: 'correlation' },
      });
    }
    if (input.expectedAccess.contentRole) {
      const matches = documentAccess.some((entry) => entry.role === input.expectedAccess!.contentRole);
      addFinding({
        classification: matches || (input.documentId && documentCorrelationComplete) ? 'inferred' : 'unverified',
        severity: matches ? 'success' : 'warning',
        label: matches ? 'Content-role expectation represented' : 'Content-role expectation not proven',
        message: matches
          ? 'The expected content role appears in the observed direct or group document-access evidence; end-user validation is still required.'
          : input.documentId && documentCorrelationComplete
            ? 'The expected content role does not appear in the complete selected-document access list for the explicit principal or observed groups.'
            : 'Supply a document and complete group membership evidence before comparing the expected content role.',
        coverageSource: 'document_access',
        source: { kind: 'correlation' },
      });
    }
  } else {
    coverage.push({ source: 'expected_access', state: 'not_requested', included: 0, total: null, reason: 'No expected access was supplied.', exclusions: [] });
  }

  exclusions.add('Model-role assignments and document permission records are not proof of row-level, field-level, query-result, or end-user runtime access.');
  exclusions.add('Use a controlled test user in Omni to validate the final effective experience.');

  return {
    schemaVersion: IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION,
    instance: { id: input.instanceId, label: input.instanceLabel },
    checkedAt,
    scope: {
      principalType: input.principalType,
      principalIdentifier: input.principalIdentifier,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.expectedAccess ? { expectedAccess: input.expectedAccess } : {}),
    },
    principal,
    groups: groupEvidence,
    modelRoles: uniqueModelRoles,
    documentAccess,
    lifecycle,
    findings,
    coverage,
    exclusions: [...exclusions],
  };
}
