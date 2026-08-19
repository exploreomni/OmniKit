import {
  assignUserModelRole,
  createGroup,
  createUser,
  deleteUser,
  findUserByEmail,
  getGroup,
  listAllGroups,
  listAllUsers,
  listConnections,
  listModels,
  listUserAttributes,
  listUserModelRoles,
  patchGroup,
  updateUser,
  type UserModelRoleRecord,
} from '../omniApi';
import { parseCsvTable } from '../../utils/csvImport';
import {
  IDENTITY_IMPORT_LIMITS,
  identityModelRoleLabel,
  normalizeIdentityModelRole,
  parseEscapedIdentityList,
  type IdentityModelRoleName,
} from './identityImportInputs';

const USER_ATTRIBUTE_URN = 'urn:omni:params:1.0:UserAttribute';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const OMNI_ID_PATTERN = /^[\w-]+$/;
const SIMPLE_HEADERS = ['action', 'display_name', 'email', 'group', 'role', 'connection', 'model'] as const;
const PERMISSION_MODEL_KINDS = ['SHARED', 'SHARED_EXTENSION'] as const;
const consumedIdentityPreflights = new WeakSet<object>();

type RecordSource = { rowNumber: number; rowNumbers: number[] };

export type IdentityImportRecord =
  | (RecordSource & {
      type: 'user';
      action: 'upsert' | 'delete';
      email: string;
      displayName: string;
      attributes: Record<string, string>;
    })
  | (RecordSource & { type: 'group'; action: 'ensure'; groupName: string })
  | (RecordSource & {
      type: 'membership';
      action: 'add' | 'remove';
      email: string;
      groupName: string;
    })
  | (RecordSource & {
      type: 'role';
      action: 'add' | 'remove';
      email: string;
      roleName: IdentityModelRoleName;
      connectionNames: string[];
      modelNames: string[];
    });

type UserImportRecord = Extract<IdentityImportRecord, { type: 'user' }>;
type UserUpsertRecord = UserImportRecord & { action: 'upsert' };
type UserDeleteRecord = UserImportRecord & { action: 'delete' };

export type IdentityImportIssue = {
  severity: 'error' | 'warning';
  message: string;
  rowNumber?: number;
};

export type IdentityImportSummary = {
  userUpserts: number;
  userDeletes: number;
  groupsEnsured: number;
  membershipsAdded: number;
  membershipsRemoved: number;
  rolesAdded: number;
  rolesRemoved: number;
};

export type IdentityImportPreviewRow = {
  rowNumber: number;
  action: 'add' | 'remove' | 'upsert' | 'delete' | 'ensure';
  email: string;
  displayName: string;
  groups: string[];
  role: string;
  connections: string[];
  models: string[];
  effects: string[];
  destructive: boolean;
};

export type IdentityImportPlan = {
  format: 'simple' | 'unified' | 'legacy-users' | 'legacy-memberships';
  records: IdentityImportRecord[];
  previewRows: IdentityImportPreviewRow[];
  issues: IdentityImportIssue[];
  summary: IdentityImportSummary;
};

type ScimUser = Record<string, unknown> & {
  id: string;
  userName: string;
  displayName?: string;
  active?: boolean;
};

type ScimMember = { value: string; display?: string };
type ScimGroup = Record<string, unknown> & { id: string; displayName: string; members?: ScimMember[] };
type NamedConnection = { id: string; name: string };
type NamedModel = { id: string; name: string; connectionId: string; kind: 'SHARED' | 'SHARED_EXTENSION' };

export type ResolvedIdentityRoleChange = {
  action: 'add' | 'remove';
  disposition: 'add' | 'noop' | 'conflict' | 'unsupported';
  rowNumbers: number[];
  email: string;
  roleName: IdentityModelRoleName;
  connectionId: string;
  connectionName: string;
  modelId?: string;
  modelName?: string;
  currentEvidence: Array<{
    roleName: string;
    baseRole?: string;
    modelId?: string;
    connectionId?: string;
    priority?: number;
    resolved?: boolean;
    source?: string;
  }>;
  message: string;
};

export type IdentityImportPreflight = {
  plan: IdentityImportPlan;
  scope: { key: string; instanceId?: string; label: string };
  issues: IdentityImportIssue[];
  inventory: {
    users: ScimUser[];
    groups: ScimGroup[];
    attributeNames: string[] | null;
    connections: NamedConnection[];
    models: NamedModel[];
  };
  roleChanges: ResolvedIdentityRoleChange[];
  executionFingerprint: string;
  changes: {
    usersToCreate: number;
    usersToUpdate: number;
    usersToDelete: number;
    groupsToCreate: number;
    membershipAdds: number;
    membershipRemoves: number;
    roleAdds: number;
    roleRemoves: number;
    noOps: number;
    conflicts: number;
  };
};

export type IdentityImportResult = {
  status: 'succeeded' | 'skipped' | 'failed';
  stage: 'user' | 'group' | 'membership' | 'role' | 'deprovision';
  field: 'user' | 'display_name' | 'attribute' | 'group' | 'membership' | 'role' | 'membership_revocation';
  target: string;
  message: string;
  rowNumbers: number[];
};

export type IdentityImportProgress = {
  completed: number;
  total: number;
  stage: string;
  message: string;
};

export class IdentityImportExecutionStoppedError extends Error {
  constructor(readonly results: IdentityImportResult[]) {
    super('The selected Omni instance changed. Execution stopped before the next mutation; review the partial journal before retrying.');
    this.name = 'IdentityImportExecutionStoppedError';
  }
}

export type IdentityImportScope = {
  key: string;
  instanceId?: string;
  label: string;
  signal?: AbortSignal;
  isActive?: () => boolean;
};

function normalizedHeader(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizedKey(value: string) {
  return value.trim().normalize('NFC').toLowerCase();
}

function looksLikeEmail(value: string) {
  if (value.length > IDENTITY_IMPORT_LIMITS.maxEmailLength || value.trim() !== value) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local
    || local.length > 64
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) return false;
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOmniId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && OMNI_ID_PATTERN.test(value);
}

function isSafeUserAttributeName(value: string): boolean {
  return value.length <= 128
    && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase());
}

function source(rowNumber: number): RecordSource {
  return { rowNumber, rowNumbers: [rowNumber] };
}

function summarize(records: IdentityImportRecord[]): IdentityImportSummary {
  return {
    userUpserts: records.filter((record) => record.type === 'user' && record.action === 'upsert').length,
    userDeletes: records.filter((record) => record.type === 'user' && record.action === 'delete').length,
    groupsEnsured: records.filter((record) => record.type === 'group').length,
    membershipsAdded: records.filter((record) => record.type === 'membership' && record.action === 'add').length,
    membershipsRemoved: records.filter((record) => record.type === 'membership' && record.action === 'remove').length,
    rolesAdded: records.filter((record) => record.type === 'role' && record.action === 'add').length,
    rolesRemoved: records.filter((record) => record.type === 'role' && record.action === 'remove').length,
  };
}

function mergeRowNumbers(target: RecordSource, next: RecordSource) {
  target.rowNumbers = [...new Set([...target.rowNumbers, ...next.rowNumbers])].sort((a, b) => a - b);
}

function deduplicateRecords(records: IdentityImportRecord[], issues: IdentityImportIssue[]) {
  const deduplicated: IdentityImportRecord[] = [];
  const seenUsers = new Map<string, Extract<IdentityImportRecord, { type: 'user' }>>();
  const seenGroups = new Map<string, Extract<IdentityImportRecord, { type: 'group' }>>();
  const seenMemberships = new Map<string, Extract<IdentityImportRecord, { type: 'membership' }>>();
  const seenRoles = new Map<string, Extract<IdentityImportRecord, { type: 'role' }>>();

  for (const record of records) {
    if (record.type === 'user') {
      const key = normalizedKey(record.email);
      const previous = seenUsers.get(key);
      if (!previous) {
        seenUsers.set(key, record);
        deduplicated.push(record);
        continue;
      }
      if (previous.action !== record.action) {
        issues.push({
          severity: 'error',
          rowNumber: record.rowNumber,
          message: `Conflicting user actions for ${record.email}; row ${previous.rowNumber} uses ${previous.action}.`,
        });
        continue;
      }
      mergeRowNumbers(previous, record);
      if (record.action === 'delete' || previous.action === 'delete') {
        issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `Duplicate delete row for ${record.email} was merged.` });
        continue;
      }
      issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `Compatible user add rows for ${record.email} were merged.` });
      if (previous.displayName && record.displayName && previous.displayName !== record.displayName) {
        issues.push({
          severity: 'error',
          rowNumber: record.rowNumber,
          message: `Conflicting display_name values for ${record.email}; row ${previous.rowNumber} uses "${previous.displayName}".`,
        });
      } else if (!previous.displayName && record.displayName) {
        previous.displayName = record.displayName;
      }
      for (const [attribute, value] of Object.entries(record.attributes)) {
        if (previous.attributes[attribute] !== undefined && previous.attributes[attribute] !== value) {
          issues.push({
            severity: 'error',
            rowNumber: record.rowNumber,
            message: `Conflicting ${attribute} values for ${record.email}; row ${previous.rowNumber} uses another value.`,
          });
        } else {
          previous.attributes[attribute] = value;
        }
      }
      continue;
    }

    if (record.type === 'group') {
      const key = normalizedKey(record.groupName);
      const previous = seenGroups.get(key);
      if (!previous) {
        seenGroups.set(key, record);
        deduplicated.push(record);
      } else {
        mergeRowNumbers(previous, record);
        issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `Duplicate group add for ${record.groupName} was merged.` });
      }
      continue;
    }

    if (record.type === 'membership') {
      const key = `${normalizedKey(record.groupName)}|${normalizedKey(record.email)}`;
      const previous = seenMemberships.get(key);
      if (!previous) {
        seenMemberships.set(key, record);
        deduplicated.push(record);
      } else if (previous.action !== record.action) {
        issues.push({
          severity: 'error',
          rowNumber: record.rowNumber,
          message: `Conflicting membership actions for ${record.email} in ${record.groupName}; row ${previous.rowNumber} uses ${previous.action}.`,
        });
      } else {
        mergeRowNumbers(previous, record);
        issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `Duplicate membership ${record.action} for ${record.email} in ${record.groupName} was merged.` });
      }
      continue;
    }

    const key = [
      normalizedKey(record.email),
      record.action,
      record.roleName,
      record.connectionNames.map(normalizedKey).sort().join('|'),
      record.modelNames.map(normalizedKey).sort().join('|'),
    ].join('::');
    const previous = seenRoles.get(key);
    if (!previous) {
      seenRoles.set(key, record);
      deduplicated.push(record);
    } else {
      mergeRowNumbers(previous, record);
      issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `Duplicate role ${record.action} for ${record.email} was merged.` });
    }
  }

  const deletedEmails = new Map(
    deduplicated
      .filter((record): record is Extract<IdentityImportRecord, { type: 'user' }> => record.type === 'user' && record.action === 'delete')
      .map((record) => [normalizedKey(record.email), record]),
  );
  for (const record of deduplicated) {
    const email = record.type === 'group' ? '' : record.email;
    const deletion = email ? deletedEmails.get(normalizedKey(email)) : undefined;
    if (deletion && record !== deletion) {
      issues.push({
        severity: 'error',
        rowNumber: record.rowNumber,
        message: `${email} cannot be deprovisioned and changed in the same import. Remove the conflicting row ${deletion.rowNumber}.`,
      });
    }
  }
  return deduplicated;
}

function simplePreview(
  rowNumber: number,
  action: 'add' | 'remove',
  email: string,
  displayName: string,
  groups: string[],
  roleName: IdentityModelRoleName | null,
  connections: string[],
  models: string[],
): IdentityImportPreviewRow {
  const effects: string[] = [];
  if (action === 'add') {
    effects.push('Create the user if missing; otherwise fill only missing user values');
    if (groups.length > 0) effects.push(`Ensure and add ${groups.length} group membership${groups.length === 1 ? '' : 's'}`);
    if (roleName) effects.push(`Assign ${identityModelRoleLabel(roleName)} to the resolved permission target${models.length + connections.length === 1 ? '' : 's'}`);
  } else {
    if (groups.length > 0) effects.push(`Remove ${groups.length} matching group membership${groups.length === 1 ? '' : 's'}`);
    if (roleName) effects.push('Role removal requested; blocked until Omni publishes a supported clear contract');
    if (groups.length === 0 && !roleName) effects.push('Irreversibly revoke this user’s Omni organization membership');
  }
  return {
    rowNumber,
    action,
    email,
    displayName,
    groups,
    role: roleName ? identityModelRoleLabel(roleName) : '',
    connections,
    models,
    effects,
    destructive: action === 'remove' && groups.length === 0 && !roleName,
  };
}

function advancedPreviewRows(records: IdentityImportRecord[]): IdentityImportPreviewRow[] {
  return records.map((record) => {
    if (record.type === 'user') {
      return {
        rowNumber: record.rowNumber,
        action: record.action,
        email: record.email,
        displayName: record.displayName,
        groups: [],
        role: '',
        connections: [],
        models: [],
        effects: [record.action === 'delete' ? 'Irreversibly revoke this user’s Omni organization membership' : 'Create the user or fill missing user values'],
        destructive: record.action === 'delete',
      };
    }
    if (record.type === 'group') {
      return {
        rowNumber: record.rowNumber,
        action: 'ensure',
        email: '',
        displayName: '',
        groups: [record.groupName],
        role: '',
        connections: [],
        models: [],
        effects: ['Ensure the group exists'],
        destructive: false,
      };
    }
    if (record.type === 'membership') {
      return {
        rowNumber: record.rowNumber,
        action: record.action,
        email: record.email,
        displayName: '',
        groups: [record.groupName],
        role: '',
        connections: [],
        models: [],
        effects: [`${record.action === 'add' ? 'Add' : 'Remove'} the group membership`],
        destructive: false,
      };
    }
    return {
      rowNumber: record.rowNumber,
      action: record.action,
      email: record.email,
      displayName: '',
      groups: [],
      role: identityModelRoleLabel(record.roleName),
      connections: record.connectionNames,
      models: record.modelNames,
      effects: [`${record.action === 'add' ? 'Assign' : 'Remove'} the model role`],
      destructive: false,
    };
  });
}

export function parseIdentityImportCsv(content: string): IdentityImportPlan {
  const table = parseCsvTable(content);
  if (table.length < 2) throw new Error('CSV must include a header and at least one data row.');

  const headers = table[0].map(normalizedHeader);
  const headerIndex = new Map<string, number>();
  headers.forEach((header, index) => {
    if (!header) throw new Error('CSV column names cannot be blank.');
    if (headerIndex.has(header)) throw new Error(`CSV contains duplicate column "${header}".`);
    headerIndex.set(header, index);
  });
  const dataRows = table.slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => row.some((value) => value.trim()));
  if (dataRows.length === 0) throw new Error('CSV must include at least one non-empty data row.');
  if (dataRows.length > IDENTITY_IMPORT_LIMITS.maxRows) {
    throw new Error(`CSV imports are limited to ${IDENTITY_IMPORT_LIMITS.maxRows.toLocaleString()} data rows.`);
  }

  const hasUnifiedContract = headerIndex.has('record_type') && headerIndex.has('action');
  const hasLegacyOperation = headerIndex.has('op');
  const legacyMemberships = !hasUnifiedContract && hasLegacyOperation && headerIndex.has('group_name');
  const legacyUsers = !hasUnifiedContract && hasLegacyOperation && headerIndex.has('email') && !headerIndex.has('group_name');
  const simple = !hasUnifiedContract && !hasLegacyOperation && headerIndex.has('action') && headerIndex.has('email');
  if (!simple && !hasUnifiedContract && !legacyMemberships && !legacyUsers) {
    throw new Error('Use the action/display_name/email/group/role/connection/model template, or a supported legacy CSV.');
  }
  if (simple) {
    const missingHeaders = SIMPLE_HEADERS.filter((header) => !headerIndex.has(header));
    const unknownHeaders = headers.filter((header) => !SIMPLE_HEADERS.includes(header as typeof SIMPLE_HEADERS[number]));
    if (missingHeaders.length > 0 || unknownHeaders.length > 0) {
      throw new Error(`The simple template requires exactly: ${SIMPLE_HEADERS.join(', ')}.`);
    }
  }

  const issues: IdentityImportIssue[] = [];
  const records: IdentityImportRecord[] = [];
  const previewRows: IdentityImportPreviewRow[] = [];
  const knownUnifiedHeaders = new Set(['record_type', 'action', 'email', 'display_name', 'group_name']);
  if (hasUnifiedContract) {
    headers.forEach((header) => {
      if (!knownUnifiedHeaders.has(header) && !header.startsWith('attribute_')) {
        issues.push({ severity: 'error', message: `Unknown column "${header}". Legacy user attribute columns must start with attribute_.` });
      }
    });
  }
  const cell = (row: string[], name: string) => (row[headerIndex.get(name) ?? -1] || '').trim();

  for (const { row, rowNumber } of dataRows) {
    if (simple) {
      if (row.length !== SIMPLE_HEADERS.length) {
        issues.push({
          severity: 'error',
          rowNumber,
          message: 'Simple-template rows must contain exactly seven CSV fields. Quote cells that contain comma-separated lists.',
        });
        continue;
      }
      const actionValue = normalizedKey(cell(row, 'action'));
      const email = cell(row, 'email');
      const displayName = cell(row, 'display_name');
      const roleValue = cell(row, 'role');
      if (actionValue !== 'add' && actionValue !== 'remove') {
        issues.push({ severity: 'error', rowNumber, message: 'Action must be add or remove.' });
        continue;
      }
      if (!looksLikeEmail(email)) {
        issues.push({ severity: 'error', rowNumber, message: 'Every row requires a valid email address.' });
        continue;
      }
      if (displayName.length > IDENTITY_IMPORT_LIMITS.maxDisplayNameLength) {
        issues.push({ severity: 'error', rowNumber, message: `display_name cannot exceed ${IDENTITY_IMPORT_LIMITS.maxDisplayNameLength} characters.` });
        continue;
      }
      let groups: string[];
      let connections: string[];
      let models: string[];
      try {
        const groupList = parseEscapedIdentityList(cell(row, 'group'), { label: 'group', maxValueLength: IDENTITY_IMPORT_LIMITS.maxGroupNameLength });
        const connectionList = parseEscapedIdentityList(cell(row, 'connection'), { label: 'connection', maxValueLength: IDENTITY_IMPORT_LIMITS.maxScopeNameLength });
        const modelList = parseEscapedIdentityList(cell(row, 'model'), { label: 'model', maxValueLength: IDENTITY_IMPORT_LIMITS.maxScopeNameLength });
        groups = groupList.values;
        connections = connectionList.values;
        models = modelList.values;
        const duplicateCount = groupList.duplicateCount + connectionList.duplicateCount + modelList.duplicateCount;
        if (duplicateCount > 0) {
          issues.push({ severity: 'warning', rowNumber, message: `${duplicateCount} duplicate list value${duplicateCount === 1 ? '' : 's'} were ignored.` });
        }
      } catch (error) {
        issues.push({ severity: 'error', rowNumber, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const roleName = roleValue ? normalizeIdentityModelRole(roleValue) : null;
      if (roleValue && !roleName) {
        issues.push({ severity: 'error', rowNumber, message: 'Role must be Viewer, Restricted Querier, Querier, Modeler, Connection Admin, Admin, or No Access.' });
        continue;
      }
      if (!roleName && (connections.length > 0 || models.length > 0)) {
        issues.push({ severity: 'error', rowNumber, message: 'Connection and model values require a role.' });
        continue;
      }
      if (roleName && connections.length === 0) {
        issues.push({ severity: 'error', rowNumber, message: 'Role assignments require at least one connection name.' });
        continue;
      }
      if (roleName === 'CONNECTION_ADMIN' && models.length > 0) {
        issues.push({ severity: 'error', rowNumber, message: 'Connection Admin targets connections directly; leave model blank.' });
        continue;
      }
      if (roleName && roleName !== 'CONNECTION_ADMIN' && models.length === 0) {
        issues.push({ severity: 'error', rowNumber, message: `${identityModelRoleLabel(roleName)} requires at least one model name.` });
        continue;
      }
      if (actionValue === 'remove' && groups.length === 0 && !roleName && !displayName) {
        issues.push({ severity: 'error', rowNumber, message: 'Full user deprovisioning requires display_name so OmniKit can verify both identity fields.' });
        continue;
      }

      previewRows.push(simplePreview(rowNumber, actionValue, email, displayName, groups, roleName, connections, models));
      if (actionValue === 'add') {
        records.push({ ...source(rowNumber), type: 'user', action: 'upsert', email, displayName, attributes: {} });
        for (const groupName of groups) {
          records.push({ ...source(rowNumber), type: 'group', action: 'ensure', groupName });
          records.push({ ...source(rowNumber), type: 'membership', action: 'add', email, groupName });
        }
        if (roleName) records.push({ ...source(rowNumber), type: 'role', action: 'add', email, roleName, connectionNames: connections, modelNames: models });
      } else {
        for (const groupName of groups) records.push({ ...source(rowNumber), type: 'membership', action: 'remove', email, groupName });
        if (roleName) records.push({ ...source(rowNumber), type: 'role', action: 'remove', email, roleName, connectionNames: connections, modelNames: models });
        if (groups.length === 0 && !roleName) records.push({ ...source(rowNumber), type: 'user', action: 'delete', email, displayName, attributes: {} });
      }
      continue;
    }

    const type = hasUnifiedContract ? normalizedKey(cell(row, 'record_type')) : legacyMemberships ? 'membership' : 'user';
    const action = normalizedKey(cell(row, hasUnifiedContract ? 'action' : 'op'));
    const email = cell(row, 'email');
    const displayName = cell(row, 'display_name');
    const groupName = cell(row, 'group_name');
    if (type === 'user') {
      if (action !== 'upsert' && action !== 'delete') {
        issues.push({ severity: 'error', rowNumber, message: 'User action must be upsert or delete.' });
        continue;
      }
      if (!looksLikeEmail(email)) {
        issues.push({ severity: 'error', rowNumber, message: 'User rows require a valid email address.' });
        continue;
      }
      if (action === 'upsert' && !displayName) {
        issues.push({ severity: 'error', rowNumber, message: 'Legacy user upsert rows require display_name.' });
        continue;
      }
      const attributes: Record<string, string> = {};
      headers.forEach((header, index) => {
        const isLegacyAttribute = legacyUsers && !['email', 'display_name', 'op'].includes(header);
        if (!header.startsWith('attribute_') && !isLegacyAttribute) return;
        const attributeName = header.startsWith('attribute_') ? header.slice('attribute_'.length) : header;
        const value = (row[index] || '').trim();
        if (value && !isSafeUserAttributeName(attributeName)) {
          issues.push({ severity: 'error', rowNumber, message: `User attribute column "${header}" is not a safe attribute name.` });
          return;
        }
        if (attributeName && value) attributes[attributeName] = value;
      });
      records.push({ ...source(rowNumber), type: 'user', action, email, displayName, attributes });
      continue;
    }
    if (type === 'group') {
      if (action !== 'ensure') {
        issues.push({ severity: 'error', rowNumber, message: 'Group action must be ensure.' });
        continue;
      }
      if (!groupName || groupName.length > IDENTITY_IMPORT_LIMITS.maxGroupNameLength) {
        issues.push({ severity: 'error', rowNumber, message: `Group rows require group_name of at most ${IDENTITY_IMPORT_LIMITS.maxGroupNameLength} characters.` });
        continue;
      }
      records.push({ ...source(rowNumber), type: 'group', action: 'ensure', groupName });
      continue;
    }
    if (type === 'membership') {
      if (action !== 'add' && action !== 'remove') {
        issues.push({ severity: 'error', rowNumber, message: 'Membership action must be add or remove.' });
        continue;
      }
      if (!looksLikeEmail(email) || !groupName) {
        issues.push({ severity: 'error', rowNumber, message: 'Membership rows require a valid email and group_name.' });
        continue;
      }
      records.push({ ...source(rowNumber), type: 'membership', action, email, groupName });
      continue;
    }
    issues.push({ severity: 'error', rowNumber, message: 'record_type must be user, group, or membership.' });
  }

  const deduplicated = deduplicateRecords(records, issues);
  if (deduplicated.length > IDENTITY_IMPORT_LIMITS.maxCompiledOperations) {
    issues.push({ severity: 'error', message: `The import compiles to more than ${IDENTITY_IMPORT_LIMITS.maxCompiledOperations.toLocaleString()} operations. Split it into smaller files.` });
  }
  const format: IdentityImportPlan['format'] = simple ? 'simple' : hasUnifiedContract ? 'unified' : legacyMemberships ? 'legacy-memberships' : 'legacy-users';
  return {
    format,
    records: deduplicated,
    previewRows: simple ? previewRows : advancedPreviewRows(deduplicated),
    issues,
    summary: summarize(deduplicated),
  };
}

function extractAttributeDefinitions(payload: unknown): Array<{ name: string; system: boolean }> | null {
  let values: unknown = payload;
  if (isRecord(payload)) {
    values = undefined;
    for (const key of ['userAttributes', 'user_attributes', 'attributes', 'records', 'data', 'items']) {
      if (Array.isArray(payload[key])) {
        values = payload[key];
        break;
      }
    }
  }
  if (!Array.isArray(values)) return null;
  const definitions: Array<{ name: string; system: boolean }> = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (!isRecord(entry) || typeof entry.system !== 'boolean') return null;
    const rawName = entry.name ?? entry.identifier ?? entry.key ?? entry.attributeName ?? entry.attribute_name;
    if (typeof rawName !== 'string' || !rawName.trim() || rawName.trim() !== rawName) return null;
    const key = normalizedKey(rawName);
    if (seen.has(key)) return null;
    seen.add(key);
    definitions.push({ name: rawName, system: entry.system });
  }
  return definitions;
}

function scimUsers(resources: Array<Record<string, unknown>>) {
  return resources.filter((resource): resource is ScimUser => typeof resource.id === 'string' && typeof resource.userName === 'string');
}

function scimGroups(resources: Array<Record<string, unknown>>) {
  return resources.filter((resource): resource is ScimGroup => typeof resource.id === 'string' && typeof resource.displayName === 'string');
}

function parseDetailedGroup(payload: unknown, expected: { id?: string; name?: string } = {}): ScimGroup {
  if (
    !isRecord(payload)
    || !isOmniId(payload.id)
    || typeof payload.displayName !== 'string'
    || !payload.displayName.trim()
    || payload.displayName.trim() !== payload.displayName
    || !Array.isArray(payload.members)
    || (expected.id && payload.id !== expected.id)
    || (expected.name && normalizedKey(payload.displayName) !== normalizedKey(expected.name))
  ) throw new Error('Omni returned invalid or incomplete group membership evidence.');
  const members: ScimMember[] = [];
  const seenMemberIds = new Set<string>();
  for (const member of payload.members) {
    if (
      !isRecord(member)
      || !isOmniId(member.value)
      || (member.display !== undefined && typeof member.display !== 'string')
      || seenMemberIds.has(member.value)
    ) throw new Error('Omni returned invalid or incomplete group membership evidence.');
    seenMemberIds.add(member.value);
    members.push({ value: member.value, ...(typeof member.display === 'string' ? { display: member.display } : {}) });
  }
  return { ...payload, id: payload.id, displayName: payload.displayName, members };
}

function parseConnections(payload: unknown): NamedConnection[] {
  if (
    !isRecord(payload)
    || Object.prototype.hasOwnProperty.call(payload, 'error')
    || Object.prototype.hasOwnProperty.call(payload, 'errors')
    || payload.ok === false
    || payload.success === false
    || !Array.isArray(payload.connections)
  ) throw new Error('Omni returned an invalid connection inventory.');
  const connections: NamedConnection[] = [];
  const seenIds = new Set<string>();
  for (const value of payload.connections) {
    const deletedAt = isRecord(value) ? value.deletedAt ?? value.deleted_at : undefined;
    if (
      !isRecord(value)
      || !isOmniId(value.id)
      || typeof value.name !== 'string'
      || !value.name.trim()
      || value.name.trim() !== value.name
      || (deletedAt !== undefined && deletedAt !== null)
      || seenIds.has(value.id)
    ) throw new Error('Omni returned an invalid connection inventory.');
    seenIds.add(value.id);
    connections.push({ id: value.id, name: value.name });
  }
  return connections;
}

function parseModels(payload: unknown, expectedKind: NamedModel['kind']): NamedModel[] {
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
  ) throw new Error(`Omni returned an incomplete ${expectedKind} model inventory.`);
  const models: NamedModel[] = [];
  const seenIds = new Set<string>();
  for (const value of payload.models) {
    if (
      !isRecord(value)
      || !isOmniId(value.id)
      || !isOmniId(value.connectionId)
      || value.kind !== expectedKind
      || typeof value.name !== 'string'
      || !value.name.trim()
      || value.name.trim() !== value.name
      || value.name === value.id
      || value.deletedAt !== null
      || seenIds.has(value.id)
    ) throw new Error(`Omni returned an invalid ${expectedKind} model inventory.`);
    seenIds.add(value.id);
    models.push({ id: value.id, name: value.name, connectionId: value.connectionId, kind: expectedKind });
  }
  return models;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>, options?: { delayMs?: number }): Promise<R[]> {
  const results = new Array<R>(values.length);
  const delayMs = options?.delayMs || 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
      if (delayMs > 0 && nextIndex < values.length) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function addIssue(issues: IdentityImportIssue[], issue: IdentityImportIssue) {
  if (!issues.some((existing) => existing.severity === issue.severity && existing.rowNumber === issue.rowNumber && existing.message === issue.message)) {
    issues.push(issue);
  }
}

function directUserRole(role: UserModelRoleRecord): boolean {
  return role.from?.type === 'USER' || role.from?.type === 'User Role';
}

function roleScopeKey(email: string, connectionId: string, modelId?: string): string {
  return `${normalizedKey(email)}|${connectionId}|${modelId || 'connection'}`;
}

function resolveRoleTargets(
  record: Extract<IdentityImportRecord, { type: 'role' }>,
  connections: NamedConnection[],
  models: NamedModel[],
  issues: IdentityImportIssue[],
): Array<Omit<ResolvedIdentityRoleChange, 'disposition' | 'message' | 'currentEvidence'>> {
  const resolvedConnections: NamedConnection[] = [];
  for (const name of record.connectionNames) {
    const matches = connections.filter((connection) => normalizedKey(connection.name) === normalizedKey(name));
    if (matches.length !== 1) {
      addIssue(issues, {
        severity: 'error',
        rowNumber: record.rowNumber,
        message: matches.length === 0
          ? `Connection "${name}" was not found.`
          : `Connection name "${name}" is ambiguous. Rename the duplicate connections before importing roles.`,
      });
      continue;
    }
    resolvedConnections.push(matches[0]);
  }
  if (resolvedConnections.length !== record.connectionNames.length) return [];
  if (record.roleName === 'CONNECTION_ADMIN') {
    return resolvedConnections.map((connection) => ({
      action: record.action,
      rowNumbers: record.rowNumbers,
      email: record.email,
      roleName: record.roleName,
      connectionId: connection.id,
      connectionName: connection.name,
    }));
  }

  const connectionIds = new Set(resolvedConnections.map((connection) => connection.id));
  const targets: Array<Omit<ResolvedIdentityRoleChange, 'disposition' | 'message' | 'currentEvidence'>> = [];
  const usedConnectionIds = new Set<string>();
  for (const modelName of record.modelNames) {
    const matches = models.filter((model) => connectionIds.has(model.connectionId) && normalizedKey(model.name) === normalizedKey(modelName));
    if (matches.length !== 1) {
      addIssue(issues, {
        severity: 'error',
        rowNumber: record.rowNumber,
        message: matches.length === 0
          ? `Model "${modelName}" was not found in the selected connection scope.`
          : `Model name "${modelName}" is ambiguous across the selected connections. Use a separate row with one connection.`,
      });
      continue;
    }
    const model = matches[0];
    const connection = resolvedConnections.find((candidate) => candidate.id === model.connectionId);
    if (!connection) continue;
    usedConnectionIds.add(connection.id);
    targets.push({
      action: record.action,
      rowNumbers: record.rowNumbers,
      email: record.email,
      roleName: record.roleName,
      connectionId: connection.id,
      connectionName: connection.name,
      modelId: model.id,
      modelName: model.name,
    });
  }
  for (const connection of resolvedConnections) {
    if (!usedConnectionIds.has(connection.id)) {
      addIssue(issues, { severity: 'error', rowNumber: record.rowNumber, message: `Connection "${connection.name}" does not own any model named in this row.` });
    }
  }
  if (targets.length > IDENTITY_IMPORT_LIMITS.maxRoleTargetsPerRow) {
    addIssue(issues, { severity: 'error', rowNumber: record.rowNumber, message: `A row can resolve to at most ${IDENTITY_IMPORT_LIMITS.maxRoleTargetsPerRow} role targets.` });
    return [];
  }
  return targets;
}

function currentUserPatch(record: UserImportRecord, user: ScimUser, writableAttributeNames: ReadonlySet<string> = new Set()) {
  const patch: Record<string, unknown> = { userName: user.userName };
  const conflicts: string[] = [];
  let changed = false;
  let attributesChanged = false;
  const currentDisplayName = typeof user.displayName === 'string' ? user.displayName : '';
  if (record.displayName) {
    if (!currentDisplayName.trim()) {
      patch.displayName = record.displayName;
      changed = true;
    } else if (currentDisplayName !== record.displayName) {
      conflicts.push('display_name');
    }
  }
  const currentAttributes = isRecord(user[USER_ATTRIBUTE_URN]) ? user[USER_ATTRIBUTE_URN] as Record<string, unknown> : {};
  const nextAttributes = Object.create(null) as Record<string, unknown>;
  for (const [attribute, value] of Object.entries(currentAttributes)) {
    if (writableAttributeNames.has(normalizedKey(attribute))) nextAttributes[attribute] = value;
  }
  for (const [attribute, value] of Object.entries(record.attributes)) {
    const currentEntry = findUserAttributeEntry(currentAttributes, attribute);
    const current = currentEntry?.[1];
    if (current === undefined || current === '') {
      nextAttributes[currentEntry?.[0] ?? attribute] = value;
      changed = true;
      attributesChanged = true;
    } else if (current !== value) {
      conflicts.push(`attribute_${attribute}`);
    }
  }
  if (attributesChanged) patch[USER_ATTRIBUTE_URN] = nextAttributes;
  return { patch, changed, conflicts };
}

function findUserAttributeEntry(
  attributes: Record<string, unknown>,
  requestedName: string,
): [string, unknown] | undefined {
  const requestedKey = normalizedKey(requestedName);
  return Object.entries(attributes).find(([name]) => normalizedKey(name) === requestedKey);
}

type RequestedUserField = {
  field: 'display_name' | 'attribute';
  target: string;
  requested: string;
  current: unknown;
};

function requestedUserFields(record: UserImportRecord, user?: ScimUser): RequestedUserField[] {
  const fields: RequestedUserField[] = [];
  if (record.displayName) {
    fields.push({
      field: 'display_name',
      target: `${record.email} · display_name`,
      requested: record.displayName,
      current: user?.displayName,
    });
  }
  const currentAttributes = user && isRecord(user[USER_ATTRIBUTE_URN])
    ? user[USER_ATTRIBUTE_URN] as Record<string, unknown>
    : {};
  for (const [attribute, requested] of Object.entries(record.attributes)) {
    const currentEntry = findUserAttributeEntry(currentAttributes, attribute);
    fields.push({
      field: 'attribute',
      target: `${record.email} · attribute_${attribute}`,
      requested,
      current: currentEntry?.[1],
    });
  }
  return fields;
}

function completedExistingUserFieldResults(record: UserImportRecord, user: ScimUser): IdentityImportResult[] {
  return requestedUserFields(record, user).map<IdentityImportResult>((field) => {
    const missing = field.current === undefined || field.current === '';
    const matches = field.current === field.requested;
    return {
      status: missing ? 'succeeded' : 'skipped',
      stage: 'user',
      field: field.field,
      target: field.target,
      message: missing
        ? `Filled the missing ${field.field === 'display_name' ? 'display name' : 'user attribute'} and verified it.`
        : matches
          ? 'The requested value already exists.'
          : 'A different existing value was preserved.',
      rowNumbers: record.rowNumbers,
    };
  });
}

function requestedUserValuesMatch(record: UserImportRecord, user: ScimUser): boolean {
  if (normalizedKey(user.userName) !== normalizedKey(record.email)) return false;
  if (record.displayName && user.displayName !== record.displayName) return false;
  const attributes = isRecord(user[USER_ATTRIBUTE_URN]) ? user[USER_ATTRIBUTE_URN] as Record<string, unknown> : {};
  return Object.entries(record.attributes).every(([name, value]) => findUserAttributeEntry(attributes, name)?.[1] === value);
}

function appliedUserPatchMatches(patch: Record<string, unknown>, user: ScimUser): boolean {
  if (typeof patch.displayName === 'string' && user.displayName !== patch.displayName) return false;
  if (isRecord(patch[USER_ATTRIBUTE_URN])) {
    const actual = isRecord(user[USER_ATTRIBUTE_URN]) ? user[USER_ATTRIBUTE_URN] as Record<string, unknown> : {};
    for (const [name, value] of Object.entries(patch[USER_ATTRIBUTE_URN])) {
      if (findUserAttributeEntry(actual, name)?.[1] !== value) return false;
    }
  }
  return true;
}

function buildExecutionFingerprint(
  plan: IdentityImportPlan,
  usersByEmail: Map<string, ScimUser[]>,
  groupsByName: Map<string, ScimGroup[]>,
  roleChanges: ResolvedIdentityRoleChange[],
  changes: IdentityImportPreflight['changes'],
): string {
  const userRecords = plan.records.filter((record): record is UserImportRecord => record.type === 'user');
  const emailKeys = [...new Set(
    plan.records.flatMap((record) => record.type === 'group' ? [] : [normalizedKey(record.email)]),
  )].sort();
  const users = emailKeys.map((emailKey) => {
    const requestedAttributeNames = [...new Set(
      userRecords
        .filter((record) => normalizedKey(record.email) === emailKey)
        .flatMap((record) => Object.keys(record.attributes)),
    )].sort();
    return [emailKey, (usersByEmail.get(emailKey) || [])
      .map((user) => {
        const attributes = isRecord(user[USER_ATTRIBUTE_URN]) ? user[USER_ATTRIBUTE_URN] as Record<string, unknown> : {};
        return {
          id: user.id,
          displayName: user.displayName ?? null,
          attributes: requestedAttributeNames.map((name) => [name, findUserAttributeEntry(attributes, name)?.[1] ?? null]),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id))] as const;
  });
  const membershipRecords = plan.records.filter((record): record is Extract<IdentityImportRecord, { type: 'membership' }> => record.type === 'membership');
  const groupKeys = [...new Set(
    plan.records.flatMap((record) => record.type === 'group' || record.type === 'membership' ? [normalizedKey(record.groupName)] : []),
  )].sort();
  const groups = groupKeys.map((groupKey) => {
    const relevantMemberIds = new Set(
      membershipRecords
        .filter((record) => normalizedKey(record.groupName) === groupKey)
        .flatMap((record) => (usersByEmail.get(normalizedKey(record.email)) || []).map((user) => user.id)),
    );
    return [groupKey, (groupsByName.get(groupKey) || [])
      .map((group) => ({
        id: group.id,
        relevantMembers: (group.members || [])
          .map((member) => member.value)
          .filter((id) => relevantMemberIds.has(id))
          .sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))] as const;
  });
  const roles = roleChanges
    .map((role) => ({
      action: role.action,
      disposition: role.disposition,
      email: normalizedKey(role.email),
      roleName: role.roleName,
      connectionId: role.connectionId,
      modelId: role.modelId ?? null,
      currentEvidence: role.currentEvidence,
      message: role.message,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({ users, groups, roles, changes });
}

async function readExactUser(baseUrl: string, apiKey: string, email: string, expectedId?: string, signal?: AbortSignal): Promise<ScimUser> {
  const response = await findUserByEmail(baseUrl, apiKey, email, { signal });
  const users = scimUsers(response.Resources || []);
  if (
    users.length !== 1
    || !isOmniId(users[0].id)
    || normalizedKey(users[0].userName) !== normalizedKey(email)
    || (expectedId !== undefined && users[0].id !== expectedId)
  ) throw new Error('OmniKit could not verify the exact user after the write.');
  return users[0];
}

export async function preflightIdentityImport(
  baseUrl: string,
  apiKey: string,
  plan: IdentityImportPlan,
  scope: IdentityImportScope = { key: `${baseUrl}|legacy`, label: baseUrl },
  onProgress?: (progress: IdentityImportProgress) => void,
): Promise<IdentityImportPreflight> {
  const roleRecords = plan.records.filter((record): record is Extract<IdentityImportRecord, { type: 'role' }> => record.type === 'role');
  const referencedAttributes = new Set(plan.records.flatMap((record) => record.type === 'user' ? Object.keys(record.attributes) : []));
  const userCount = plan.records.filter((record) => record.type === 'user').length;
  const roleUserCount = new Set(roleRecords.map((r) => normalizedKey(r.email))).size;
  const totalSteps = 1 + (referencedAttributes.size > 0 ? 1 : 0) + (roleRecords.length > 0 ? 1 : 0) + roleUserCount;
  let completedSteps = 0;
  const reportProgress = (stage: string, message: string) => {
    completedSteps += 1;
    onProgress?.({ completed: completedSteps, total: totalSteps, stage, message });
  };
  onProgress?.({ completed: 0, total: totalSteps, stage: 'Inventory', message: `Fetching ${userCount} users and groups from Omni...` });
  const [userResponse, groupResponse, attributeResult, connectionResult, sharedModelResult, extensionModelResult] = await Promise.all([
    listAllUsers(baseUrl, apiKey, { pageSize: 100, maxPages: 200, signal: scope.signal }),
    listAllGroups(baseUrl, apiKey, { pageSize: 100, maxPages: 200, signal: scope.signal }),
    referencedAttributes.size > 0
      ? listUserAttributes(baseUrl, apiKey, { signal: scope.signal }).then((payload) => ({ payload, error: null })).catch((error: unknown) => ({ payload: null, error }))
      : Promise.resolve({ payload: null, error: null }),
    roleRecords.length > 0 ? listConnections(baseUrl, apiKey, { forceRefresh: true, signal: scope.signal }) : Promise.resolve(null),
    roleRecords.length > 0
      ? listModels(baseUrl, apiKey, { modelKind: PERMISSION_MODEL_KINDS[0], allPages: true, pageSize: 100, forceRefresh: true, signal: scope.signal })
      : Promise.resolve(null),
    roleRecords.length > 0
      ? listModels(baseUrl, apiKey, { modelKind: PERMISSION_MODEL_KINDS[1], allPages: true, pageSize: 100, forceRefresh: true, signal: scope.signal })
      : Promise.resolve(null),
  ]);
  if (scope.isActive && !scope.isActive()) throw new Error('The selected Omni instance changed during preflight. Validate the import again.');
  if (userResponse.error) throw new Error(String(userResponse.error));
  if (groupResponse.error) throw new Error(String(groupResponse.error));
  if (userResponse.truncated) throw new Error('User inventory hit its safety limit. Split the import before continuing.');
  if (groupResponse.truncated) throw new Error('Group inventory hit its safety limit. Split the import before continuing.');
  reportProgress('Inventory', `Found ${(userResponse.Resources || []).length} users and ${(groupResponse.Resources || []).length} groups.`);

  const users = scimUsers(userResponse.Resources || []);
  const listedGroups = scimGroups(groupResponse.Resources || []);
  const issues = [...plan.issues];
  const usersByEmail = new Map<string, ScimUser[]>();
  const groupsByName = new Map<string, ScimGroup[]>();
  users.forEach((user) => {
    const key = normalizedKey(user.userName);
    usersByEmail.set(key, [...(usersByEmail.get(key) || []), user]);
  });
  listedGroups.forEach((group) => {
    const key = normalizedKey(group.displayName);
    groupsByName.set(key, [...(groupsByName.get(key) || []), group]);
  });

  const referencedExistingGroups = [...new Set(
    plan.records
      .filter((record): record is Extract<IdentityImportRecord, { type: 'membership' }> => record.type === 'membership')
      .flatMap((record) => (groupsByName.get(normalizedKey(record.groupName)) || []).map((group) => group.id)),
  )];
  if (referencedExistingGroups.length > 0) {
    reportProgress('Groups', `Checking ${referencedExistingGroups.length} group memberships...`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const detailedGroups = await mapWithConcurrency(referencedExistingGroups, 1, async (groupId) => {
    if (!isOmniId(groupId)) throw new Error('Omni returned an invalid group identifier for a referenced membership.');
    const detail = await withRateLimitRetry(
      () => getGroup(baseUrl, apiKey, groupId, { signal: scope.signal }),
      () => { if (scope.isActive && !scope.isActive()) throw new Error('cancelled'); },
    );
    const listed = listedGroups.find((group) => group.id === groupId);
    return parseDetailedGroup(detail, { id: groupId, ...(listed ? { name: listed.displayName } : {}) });
  });
  if (scope.isActive && !scope.isActive()) throw new Error('The selected Omni instance changed during preflight. Validate the import again.');
  const detailById = new Map(detailedGroups.map((group) => [group.id, group]));
  const groups = listedGroups.map((group) => detailById.get(group.id) || group);
  groupsByName.clear();
  groups.forEach((group) => {
    const key = normalizedKey(group.displayName);
    groupsByName.set(key, [...(groupsByName.get(key) || []), group]);
  });

  const connections = roleRecords.length > 0 ? parseConnections(connectionResult) : [];
  const models = roleRecords.length > 0 ? [...parseModels(sharedModelResult, 'SHARED'), ...parseModels(extensionModelResult, 'SHARED_EXTENSION')] : [];
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error('Omni returned duplicate model identities across the permission inventories.');
  }
  let attributeNames: string[] | null = null;
  if (referencedAttributes.size > 0) {
    if (attributeResult.error) {
      issues.push({ severity: 'error', message: 'OmniKit could not verify user attribute definitions. Legacy attribute writes are blocked.' });
    } else {
      const definitions = extractAttributeDefinitions(attributeResult.payload);
      if (!definitions) {
        issues.push({ severity: 'error', message: 'OmniKit could not verify writable user attribute definitions. Legacy attribute writes are blocked.' });
      } else {
        const definitionsByName = new Map(definitions.map((definition) => [normalizedKey(definition.name), definition]));
        attributeNames = definitions.filter((definition) => !definition.system).map((definition) => definition.name);
        referencedAttributes.forEach((attribute) => {
          const definition = definitionsByName.get(normalizedKey(attribute));
          if (!definition) issues.push({ severity: 'error', message: `User attribute "${attribute}" is not defined in Omni.` });
          else if (definition.system) issues.push({ severity: 'error', message: `User attribute "${attribute}" is system-managed and cannot be written by Bulk Import.` });
        });
      }
    }
  }
  const writableAttributeNames = new Set((attributeNames || []).map(normalizedKey));

  let usersToCreate = 0;
  let usersToUpdate = 0;
  let usersToDelete = 0;
  let groupsToCreate = 0;
  let membershipAdds = 0;
  let membershipRemoves = 0;
  let roleAdds = 0;
  let roleRemoves = 0;
  let noOps = 0;
  let conflicts = 0;
  const plannedUsers = new Set(
    plan.records
      .filter((record): record is UserUpsertRecord => record.type === 'user' && record.action === 'upsert')
      .map((record) => normalizedKey(record.email)),
  );
  const plannedGroups = new Set(
    plan.records
      .filter((record): record is Extract<IdentityImportRecord, { type: 'group' }> => record.type === 'group')
      .map((record) => normalizedKey(record.groupName)),
  );

  for (const record of plan.records) {
    if (record.type === 'user') {
      const matches = usersByEmail.get(normalizedKey(record.email)) || [];
      if (matches.length > 1) {
        issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned multiple users for ${record.email}. Resolve the duplicate identity before import.` });
        continue;
      }
      if (matches.length === 1 && !isOmniId(matches[0].id)) {
        issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned an invalid user identifier for ${record.email}.` });
        continue;
      }
      if (record.action === 'delete') {
        if (matches.length === 0) {
          noOps += 1;
          issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `${record.email} does not exist and will be skipped.` });
        } else if (record.displayName && record.displayName !== (matches[0].displayName || '')) {
          conflicts += 1;
          issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `display_name does not match ${record.email}; deprovisioning is blocked.` });
        } else usersToDelete += 1;
        continue;
      }
      if (matches.length === 0) {
        if (!record.displayName) issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `${record.email} is new and requires display_name.` });
        else usersToCreate += 1;
      } else {
        const mutation = currentUserPatch(record, matches[0], writableAttributeNames);
        if (mutation.changed) usersToUpdate += 1;
        else noOps += 1;
        for (const field of mutation.conflicts) {
          conflicts += 1;
          issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `${record.email} already has a different ${field}; OmniKit will preserve the existing value.` });
        }
      }
      continue;
    }
    if (record.type === 'group') {
      const matches = groupsByName.get(normalizedKey(record.groupName)) || [];
      if (matches.length > 1) issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned multiple groups named ${record.groupName}. Rename the duplicates before import.` });
      else if (matches.length === 0) groupsToCreate += 1;
      else noOps += 1;
    }
  }

  for (const record of plan.records.filter((candidate): candidate is Extract<IdentityImportRecord, { type: 'membership' }> => candidate.type === 'membership')) {
    const userMatches = usersByEmail.get(normalizedKey(record.email)) || [];
    const groupMatches = groupsByName.get(normalizedKey(record.groupName)) || [];
    if (userMatches.length > 1 || groupMatches.length > 1) continue;
    if (userMatches.length === 1 && !isOmniId(userMatches[0].id)) {
      issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned an invalid user identifier for ${record.email}.` });
      continue;
    }
    if (groupMatches.length === 1 && !isOmniId(groupMatches[0].id)) {
      issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned an invalid group identifier for ${record.groupName}.` });
      continue;
    }
    if (userMatches.length === 0 && !plannedUsers.has(normalizedKey(record.email))) {
      if (record.action === 'remove') {
        noOps += 1;
        issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `${record.email} does not exist; the membership removal will be skipped.` });
      } else issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `${record.email} is not in Omni and has no user add row.` });
      continue;
    }
    if (groupMatches.length === 0 && !plannedGroups.has(normalizedKey(record.groupName))) {
      if (record.action === 'remove') {
        noOps += 1;
        issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `${record.groupName} does not exist; the membership removal will be skipped.` });
      } else issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `${record.groupName} is not in Omni and has no group add row.` });
      continue;
    }
    if (userMatches.length === 0 || groupMatches.length === 0) {
      if (record.action === 'add') membershipAdds += 1;
      else noOps += 1;
      continue;
    }
    const members = groupMatches[0].members;
    if (!Array.isArray(members)) {
      issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Membership evidence for ${record.groupName} is unavailable.` });
      continue;
    }
    const present = members.some((member) => member.value === userMatches[0].id);
    if (record.action === 'add' && !present) membershipAdds += 1;
    else if (record.action === 'remove' && present) membershipRemoves += 1;
    else noOps += 1;
  }

  const unresolvedRoleTargets = roleRecords.flatMap((record) => resolveRoleTargets(record, connections, models, issues));
  if (unresolvedRoleTargets.length > IDENTITY_IMPORT_LIMITS.maxTotalRoleTargets) {
    issues.push({ severity: 'error', message: `The import resolves to more than ${IDENTITY_IMPORT_LIMITS.maxTotalRoleTargets.toLocaleString()} role targets. Split it into smaller files.` });
  }
  const roleIntentByScope = new Map<string, typeof unresolvedRoleTargets[number]>();
  for (const target of unresolvedRoleTargets) {
    const key = roleScopeKey(target.email, target.connectionId, target.modelId);
    const previous = roleIntentByScope.get(key);
    if (previous && (previous.roleName !== target.roleName || previous.action !== target.action)) {
      issues.push({ severity: 'error', rowNumber: target.rowNumbers[0], message: `Conflicting roles target ${target.email} on the same connection/model.` });
    } else if (!previous) roleIntentByScope.set(key, target);
  }
  const roleTargetsByConnection = new Map<string, Array<typeof unresolvedRoleTargets[number]>>();
  for (const target of roleIntentByScope.values()) {
    const key = `${normalizedKey(target.email)}|${target.connectionId}`;
    roleTargetsByConnection.set(key, [...(roleTargetsByConnection.get(key) || []), target]);
  }
  for (const targets of roleTargetsByConnection.values()) {
    if (targets.some((target) => target.modelId === undefined) && targets.some((target) => target.modelId !== undefined)) {
      issues.push({
        severity: 'error',
        rowNumber: targets[0].rowNumbers[0],
        message: `${targets[0].email} cannot receive Connection Admin and model-scoped roles on the same connection in one import. Use one clear permission intent.`,
      });
    }
  }
  const roleTargetsByUser = new Map<string, typeof unresolvedRoleTargets>();
  for (const target of roleIntentByScope.values()) {
    const key = normalizedKey(target.email);
    roleTargetsByUser.set(key, [...(roleTargetsByUser.get(key) || []), target]);
  }
  const currentRolesByEmail = new Map<string, UserModelRoleRecord[]>();
  const preflightAssertActive = () => { if (scope.isActive && !scope.isActive()) throw new Error('cancelled'); };
  if (roleTargetsByUser.size > 0) {
    reportProgress('Roles', `Checking current roles for ${roleTargetsByUser.size} users...`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let roleUsersChecked = 0;
  await mapWithConcurrency([...roleTargetsByUser.entries()], 1, async ([emailKey, targets]) => {
    const userMatches = usersByEmail.get(emailKey) || [];
    if (userMatches.length === 0) {
      if (!plannedUsers.has(emailKey)) issues.push({ severity: 'error', rowNumber: targets[0].rowNumbers[0], message: `${targets[0].email} is not in Omni and has no user add row.` });
      currentRolesByEmail.set(emailKey, []);
      return;
    }
    if (userMatches.length !== 1) return;
    if (!isOmniId(userMatches[0].id)) {
      currentRolesByEmail.set(emailKey, []);
      return;
    }
    const scopes = new Map<string, { connectionId: string; modelId?: string }>();
    targets.forEach((target) => {
      scopes.set(`${target.connectionId}|${target.modelId || ''}`, { connectionId: target.connectionId, ...(target.modelId ? { modelId: target.modelId } : {}) });
    });
    const responses = await mapWithConcurrency([...scopes.values()], 1, (targetScope) => withRateLimitRetry(
      () => listUserModelRoles(
        baseUrl,
        apiKey,
        userMatches[0].id,
        { ...targetScope, signal: scope.signal },
      ),
      preflightAssertActive,
    ), { delayMs: 350 });
    currentRolesByEmail.set(emailKey, responses.flatMap((response) => response.results));
    roleUsersChecked += 1;
    onProgress?.({ completed: completedSteps + roleUsersChecked, total: totalSteps, stage: 'Roles', message: `Checked ${roleUsersChecked}/${roleTargetsByUser.size} users...` });
  }, { delayMs: 350 });
  if (scope.isActive && !scope.isActive()) throw new Error('The selected Omni instance changed during preflight. Validate the import again.');

  const roleChanges: ResolvedIdentityRoleChange[] = [];
  for (const target of roleIntentByScope.values()) {
    const currentRoles = currentRolesByEmail.get(normalizedKey(target.email)) || [];
    const scopedRoles = currentRoles.filter((role) => (
      role.connectionId === target.connectionId
      && (target.modelId ? role.modelId === target.modelId : true)
    ));
    const currentEvidence = scopedRoles.map((role) => ({
      roleName: role.roleName,
      ...(role.baseRole ? { baseRole: role.baseRole } : {}),
      ...(role.modelId ? { modelId: role.modelId } : {}),
      ...(role.connectionId ? { connectionId: role.connectionId } : {}),
      ...(role.priority === undefined ? {} : { priority: role.priority }),
      ...(role.resolved === undefined ? {} : { resolved: role.resolved }),
      ...(role.from?.type ? { source: role.from.type } : {}),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (target.action === 'remove') {
      roleRemoves += 1;
      roleChanges.push({ ...target, currentEvidence, disposition: 'unsupported', message: 'Omni does not publish a supported user role-removal operation.' });
      issues.push({ severity: 'error', rowNumber: target.rowNumbers[0], message: 'Role removal is not supported by Omni’s documented API. Remove the role from this remove row.' });
      continue;
    }
    const directRoles = scopedRoles.filter(directUserRole);
    // Omni's connection-scoped read returns model-scoped rows, so it cannot
    // prove that a connection-wide assignment already exists. Re-submit the
    // documented idempotent CONNECTION_ADMIN assignment instead of inferring
    // a no-op from one model row.
    const sameRole = target.modelId
      ? directRoles.find((role) => role.roleName === target.roleName)
      : undefined;
    if (sameRole) {
      noOps += 1;
      roleChanges.push({ ...target, currentEvidence, disposition: 'noop', message: `${identityModelRoleLabel(target.roleName)} is already assigned directly.` });
      continue;
    }
    if (target.modelId && directRoles.length > 0) {
      roleAdds += 1;
      const existingNames = [...new Set(directRoles.map((role) => role.roleName))].join(', ');
      roleChanges.push({ ...target, currentEvidence, disposition: 'add', message: `Overwrite existing ${existingNames} with ${identityModelRoleLabel(target.roleName)}.` });
      issues.push({ severity: 'warning', rowNumber: target.rowNumbers[0], message: `${target.email} has existing direct role ${existingNames} on this target; it will be overwritten with ${identityModelRoleLabel(target.roleName)}.` });
      continue;
    }
    roleAdds += 1;
    roleChanges.push({ ...target, currentEvidence, disposition: 'add', message: `Assign ${identityModelRoleLabel(target.roleName)}.` });
    const resolvedRole = scopedRoles.find((role) => role.resolved === true);
    if (resolvedRole && resolvedRole.roleName !== target.roleName) {
      issues.push({ severity: 'warning', rowNumber: target.rowNumbers[0], message: `Inherited or base access may remain more permissive than ${identityModelRoleLabel(target.roleName)}.` });
    }
  }

  const changes = { usersToCreate, usersToUpdate, usersToDelete, groupsToCreate, membershipAdds, membershipRemoves, roleAdds, roleRemoves, noOps, conflicts };
  return {
    plan,
    scope: { key: scope.key, ...(scope.instanceId ? { instanceId: scope.instanceId } : {}), label: scope.label },
    issues,
    inventory: { users, groups, attributeNames, connections, models },
    roleChanges,
    executionFingerprint: buildExecutionFingerprint(plan, usersByEmail, groupsByName, roleChanges, changes),
    changes,
  };
}

export function buildGroupMembershipPatch(additions: ScimMember[], removals: string[]): Record<string, unknown> | null {
  const memberIds = [...additions.map((member) => member.value), ...removals];
  if (memberIds.some((memberId) => !isOmniId(memberId)) || new Set(memberIds).size !== memberIds.length) {
    throw new Error('Group membership changes require unique UUID user identifiers.');
  }
  const operations: Array<Record<string, unknown>> = [];
  if (additions.length > 0) operations.push({ op: 'add', path: 'members', value: additions });
  removals.forEach((userId) => operations.push({ op: 'remove', path: `members[value eq "${userId}"]` }));
  if (operations.length === 0) return null;
  return { schemas: [PATCH_SCHEMA], Operations: operations };
}

async function withRateLimitRetry<T>(operation: () => Promise<T>, assertActive: () => void, options?: { maxAttempts?: number }): Promise<T> {
  const maxAttempts = options?.maxAttempts || 8;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    assertActive();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/\b429\b|rate.?limit/i.test(message) || attempt === maxAttempts - 1) throw error;
      const baseDelay = attempt < 2 ? 2000 : 5000;
      await new Promise((resolve) => setTimeout(resolve, baseDelay * (2 ** Math.min(attempt, 3))));
    }
  }
  throw lastError;
}

export async function executeIdentityImport(
  baseUrl: string,
  apiKey: string,
  preflight: IdentityImportPreflight,
  onProgress?: (progress: IdentityImportProgress) => void,
  executionScope?: IdentityImportScope,
): Promise<IdentityImportResult[]> {
  const scope: IdentityImportScope = executionScope || { key: preflight.scope.key, instanceId: preflight.scope.instanceId, label: preflight.scope.label };
  if (
    scope.key !== preflight.scope.key
    || (preflight.scope.instanceId !== undefined && scope.instanceId !== preflight.scope.instanceId)
  ) throw new Error('The selected Omni instance changed. Validate the import again.');
  if (consumedIdentityPreflights.has(preflight)) {
    throw new Error('This identity import preview has already been consumed. Validate a fresh preview before retrying.');
  }
  consumedIdentityPreflights.add(preflight);
  const results: IdentityImportResult[] = [];
  const assertActive = () => {
    if (scope.signal?.aborted || (scope.isActive && !scope.isActive())) {
      throw new IdentityImportExecutionStoppedError([...results]);
    }
  };
  assertActive();
  if (preflight.issues.some((issue) => issue.severity === 'error')) throw new Error('Resolve preflight errors before running the import.');
  const fresh = await preflightIdentityImport(baseUrl, apiKey, preflight.plan, scope);
  assertActive();
  if (fresh.issues.some((issue) => issue.severity === 'error')) throw new Error('The live identity inventory changed. Review a fresh preflight before continuing.');
  if (fresh.executionFingerprint !== preflight.executionFingerprint) {
    throw new Error('The live identity inventory changed after the preview. Validate the import again before writing.');
  }

  const usersByEmail = new Map(fresh.inventory.users.map((user) => [normalizedKey(user.userName), user]));
  const groupsByName = new Map(fresh.inventory.groups.map((group) => [normalizedKey(group.displayName), group]));
  const writableAttributeNames = new Set((fresh.inventory.attributeNames || []).map(normalizedKey));
  const failedUsers = new Set<string>();
  const failedGroups = new Set<string>();
  const userUpserts = fresh.plan.records.filter((record): record is UserUpsertRecord => record.type === 'user' && record.action === 'upsert');
  const groupsToEnsure = fresh.plan.records.filter((record): record is Extract<IdentityImportRecord, { type: 'group' }> => record.type === 'group');
  const memberships = fresh.plan.records.filter((record): record is Extract<IdentityImportRecord, { type: 'membership' }> => record.type === 'membership');
  const userDeletes = fresh.plan.records.filter((record): record is UserDeleteRecord => record.type === 'user' && record.action === 'delete');
  const membershipGroups = new Set(memberships.map((record) => normalizedKey(record.groupName)));
  const total = groupsToEnsure.length + userUpserts.length + membershipGroups.size + fresh.roleChanges.length + userDeletes.length;
  let completed = 0;
  function report(stage: string, message: string) {
    completed += 1;
    onProgress?.({ completed, total, stage, message });
  }

  for (const record of groupsToEnsure) {
    assertActive();
    const key = normalizedKey(record.groupName);
    const existing = groupsByName.get(key);
    if (existing) {
      results.push({ status: 'skipped', stage: 'group', field: 'group', target: record.groupName, message: `${record.groupName} already exists.`, rowNumbers: record.rowNumbers });
      report('Groups', record.groupName);
      continue;
    }
    try {
      const response = await withRateLimitRetry(() => createGroup(baseUrl, apiKey, { displayName: record.groupName, members: [] }, { signal: scope.signal }), assertActive);
      if (!isOmniId(response.id)) throw new Error('Omni did not return a valid group ID.');
      const verified = parseDetailedGroup(await getGroup(baseUrl, apiKey, response.id, { signal: scope.signal }), { id: response.id, name: record.groupName });
      assertActive();
      groupsByName.set(key, verified);
      results.push({ status: 'succeeded', stage: 'group', field: 'group', target: record.groupName, message: `Created group ${record.groupName}.`, rowNumbers: record.rowNumbers });
    } catch (error) {
      failedGroups.add(key);
      results.push({ status: 'failed', stage: 'group', field: 'group', target: record.groupName, message: `Group creation outcome is unverified. Refresh and validate before retrying: ${error instanceof Error ? error.message : String(error)}`, rowNumbers: record.rowNumbers });
    }
    report('Groups', record.groupName);
  }

  for (const record of userUpserts) {
    assertActive();
    const key = normalizedKey(record.email);
    const existing = usersByEmail.get(key);
    try {
      if (existing) {
        const mutation = currentUserPatch(record, existing, writableAttributeNames);
        if (!mutation.changed) {
          const fieldResults = completedExistingUserFieldResults(record, existing);
          if (fieldResults.length > 0) results.push(...fieldResults);
          else results.push({ status: 'skipped', stage: 'user', field: 'user', target: record.email, message: `${record.email} already exists.`, rowNumbers: record.rowNumbers });
        } else {
          await withRateLimitRetry(() => updateUser(baseUrl, apiKey, existing.id, mutation.patch, { signal: scope.signal }), assertActive);
          const verified = await withRateLimitRetry(() => readExactUser(baseUrl, apiKey, record.email, existing.id, scope.signal), assertActive);
          assertActive();
          if (!appliedUserPatchMatches(mutation.patch, verified)) throw new Error('OmniKit could not verify the requested user completion.');
          usersByEmail.set(key, verified);
          results.push(...completedExistingUserFieldResults(record, existing));
        }
      } else {
        const response = await withRateLimitRetry(() => createUser(baseUrl, apiKey, {
          userName: record.email,
          displayName: record.displayName,
          ...(Object.keys(record.attributes).length > 0 ? { [USER_ATTRIBUTE_URN]: record.attributes } : {}),
        }, { signal: scope.signal }), assertActive);
        if (!isOmniId(response.id)) throw new Error('Omni did not return a valid user ID.');
        const verified = await withRateLimitRetry(() => readExactUser(baseUrl, apiKey, record.email, response.id, scope.signal), assertActive);
        assertActive();
        if (!requestedUserValuesMatch(record, verified)) throw new Error('OmniKit could not verify the requested new-user values.');
        usersByEmail.set(key, verified);
        results.push({ status: 'succeeded', stage: 'user', field: 'user', target: record.email, message: `Created ${record.email}.`, rowNumbers: record.rowNumbers });
        requestedUserFields(record).forEach((field) => results.push({
          status: 'succeeded',
          stage: 'user',
          field: field.field,
          target: field.target,
          message: `Created and verified the requested ${field.field === 'display_name' ? 'display name' : 'user attribute'}.`,
          rowNumbers: record.rowNumbers,
        }));
      }
    } catch (error) {
      failedUsers.add(key);
      results.push({ status: 'failed', stage: 'user', field: 'user', target: record.email, message: `User write outcome is unverified. Refresh and validate before retrying: ${error instanceof Error ? error.message : String(error)}`, rowNumbers: record.rowNumbers });
      requestedUserFields(record, existing).forEach((field) => results.push({
        status: field.current === undefined || field.current === '' ? 'failed' : 'skipped',
        stage: 'user',
        field: field.field,
        target: field.target,
        message: field.current === undefined || field.current === ''
          ? 'The requested field outcome is unverified; reread the user before retrying.'
          : field.current === field.requested
            ? 'The requested value already existed before the write.'
            : 'A different existing value was preserved.',
        rowNumbers: record.rowNumbers,
      }));
    }
    report('Users', record.email);
  }

  const membershipsByGroup = new Map<string, Array<Extract<IdentityImportRecord, { type: 'membership' }>>>();
  memberships.forEach((record) => {
    const key = normalizedKey(record.groupName);
    membershipsByGroup.set(key, [...(membershipsByGroup.get(key) || []), record]);
  });
  for (const [groupKey, groupRecords] of membershipsByGroup) {
    assertActive();
    let group = groupsByName.get(groupKey);
    if (!group || failedGroups.has(groupKey)) {
      groupRecords.forEach((record) => results.push({ status: record.action === 'remove' ? 'skipped' : 'failed', stage: 'membership', field: 'membership', target: `${record.email} → ${record.groupName}`, message: `Group ${record.groupName} is unavailable.`, rowNumbers: record.rowNumbers }));
      report('Memberships', groupRecords[0].groupName);
      continue;
    }
    let pendingOnFailure = groupRecords;
    try {
      if (fresh.inventory.groups.some((candidate) => candidate.id === group?.id)) {
        group = parseDetailedGroup(await withRateLimitRetry(() => getGroup(baseUrl, apiKey, group!.id, { signal: scope.signal }), assertActive), { id: group.id, name: group.displayName });
      }
      const existingMemberIds = new Set((group.members || []).map((member) => member.value));
      const additions: ScimMember[] = [];
      const removals: string[] = [];
      const actionable: Array<Extract<IdentityImportRecord, { type: 'membership' }>> = [];
      for (const record of groupRecords) {
        const userKey = normalizedKey(record.email);
        const user = usersByEmail.get(userKey);
        if (!user || failedUsers.has(userKey)) {
          results.push({ status: record.action === 'remove' ? 'skipped' : 'failed', stage: 'membership', field: 'membership', target: `${record.email} → ${record.groupName}`, message: `User ${record.email} is unavailable.`, rowNumbers: record.rowNumbers });
          continue;
        }
        if (record.action === 'add') {
          if (existingMemberIds.has(user.id)) {
            results.push({ status: 'skipped', stage: 'membership', field: 'membership', target: `${record.email} → ${record.groupName}`, message: `${record.email} is already in ${record.groupName}.`, rowNumbers: record.rowNumbers });
            continue;
          }
          additions.push({ value: user.id, display: user.userName });
        } else {
          if (!existingMemberIds.has(user.id)) {
            results.push({ status: 'skipped', stage: 'membership', field: 'membership', target: `${record.email} → ${record.groupName}`, message: `${record.email} is not in ${record.groupName}.`, rowNumbers: record.rowNumbers });
            continue;
          }
          removals.push(user.id);
        }
        actionable.push(record);
      }
      pendingOnFailure = actionable;
      const patch = buildGroupMembershipPatch(additions, removals);
      if (patch) {
        assertActive();
        await withRateLimitRetry(() => patchGroup(baseUrl, apiKey, group!.id, patch, { signal: scope.signal }), assertActive);
        const verified = parseDetailedGroup(await withRateLimitRetry(() => getGroup(baseUrl, apiKey, group!.id, { signal: scope.signal }), assertActive), { id: group!.id, name: group!.displayName });
        assertActive();
        const verifiedIds = new Set(verified.members!.map((member) => member.value));
        if (additions.some((member) => !verifiedIds.has(member.value)) || removals.some((id) => verifiedIds.has(id))) throw new Error('OmniKit could not verify the group membership update.');
        groupsByName.set(groupKey, verified);
        actionable.forEach((record) => results.push({
          status: 'succeeded',
          stage: 'membership',
          field: 'membership',
          target: `${record.email} → ${record.groupName}`,
          message: `${record.action === 'add' ? 'Added' : 'Removed'} ${record.email} ${record.action === 'add' ? 'to' : 'from'} ${record.groupName}.`,
          rowNumbers: record.rowNumbers,
        }));
      }
    } catch (error) {
      pendingOnFailure.forEach((record) => results.push({ status: 'failed', stage: 'membership', field: 'membership', target: `${record.email} → ${record.groupName}`, message: `Membership outcome is unverified. Refresh and validate before retrying: ${error instanceof Error ? error.message : String(error)}`, rowNumbers: record.rowNumbers }));
    }
    report('Memberships', groupRecords[0].groupName);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  for (const change of fresh.roleChanges) {
    assertActive();
    const target = `${change.email} → ${change.connectionName}${change.modelName ? ` / ${change.modelName}` : ''}`;
    if (change.disposition !== 'add') {
      results.push({ status: change.disposition === 'unsupported' ? 'failed' : 'skipped', stage: 'role', field: 'role', target, message: change.message, rowNumbers: change.rowNumbers });
      report('Roles', target);
      continue;
    }
    const user = usersByEmail.get(normalizedKey(change.email));
    if (!user || failedUsers.has(normalizedKey(change.email))) {
      results.push({ status: 'failed', stage: 'role', field: 'role', target, message: `User ${change.email} is unavailable.`, rowNumbers: change.rowNumbers });
      report('Roles', target);
      continue;
    }
    try {
      const assignment = await withRateLimitRetry(() => assignUserModelRole(baseUrl, apiKey, user.id, {
        roleName: change.roleName,
        connectionId: change.connectionId,
        ...(change.modelId ? { modelId: change.modelId } : {}),
      }, { signal: scope.signal }), assertActive);
      const resolvedRoles = assignment.results.filter((role) => (
        role.resolved === true
        && role.connectionId === change.connectionId
        && (change.modelId ? role.modelId === change.modelId : true)
      ));
      if (resolvedRoles.length === 0) throw new Error('Omni did not return effective-role evidence after the direct assignment.');
      const effectiveNames = [...new Set(resolvedRoles.map((role) => role.roleName))];
      const effectiveMatches = effectiveNames.every((roleName) => roleName === change.roleName);
      results.push({
        status: 'succeeded',
        stage: 'role',
        field: 'role',
        target,
        message: effectiveMatches
          ? `Assigned ${identityModelRoleLabel(change.roleName)} and verified both direct and effective access.`
          : `Assigned the direct ${identityModelRoleLabel(change.roleName)} role; effective access still resolves to ${effectiveNames.join(', ')} because broader access also applies.`,
        rowNumbers: change.rowNumbers,
      });
    } catch (error) {
      results.push({ status: 'failed', stage: 'role', field: 'role', target, message: `Role assignment outcome is unverified. Refresh and validate before retrying: ${error instanceof Error ? error.message : String(error)}`, rowNumbers: change.rowNumbers });
    }
    report('Roles', target);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  for (const record of userDeletes) {
    assertActive();
    const key = normalizedKey(record.email);
    const user = usersByEmail.get(key);
    if (!user) {
      results.push({ status: 'skipped', stage: 'deprovision', field: 'membership_revocation', target: record.email, message: `${record.email} does not exist.`, rowNumbers: record.rowNumbers });
      report('Deprovisioning', record.email);
      continue;
    }
    if (!isOmniId(user.id)) {
      results.push({ status: 'failed', stage: 'deprovision', field: 'membership_revocation', target: record.email, message: 'Omni returned an invalid user identifier; deprovisioning was not attempted.', rowNumbers: record.rowNumbers });
      report('Deprovisioning', record.email);
      continue;
    }
    try {
      await deleteUser(baseUrl, apiKey, user.id, { signal: scope.signal });
      const verification = await findUserByEmail(baseUrl, apiKey, record.email, { signal: scope.signal });
      if ((verification.Resources || []).length !== 0 || verification.totalResults !== 0) {
        throw new Error('Omni still returns this user after the deprovisioning request.');
      }
      usersByEmail.delete(key);
      results.push({ status: 'succeeded', stage: 'deprovision', field: 'membership_revocation', target: record.email, message: `Revoked ${record.email}’s Omni organization membership.`, rowNumbers: record.rowNumbers });
    } catch (error) {
      let reconciled = false;
      try {
        const verification = await findUserByEmail(baseUrl, apiKey, record.email, { signal: scope.signal });
        reconciled = (verification.Resources || []).length === 0 && verification.totalResults === 0;
      } catch {
        reconciled = false;
      }
      if (reconciled) {
        usersByEmail.delete(key);
        results.push({ status: 'succeeded', stage: 'deprovision', field: 'membership_revocation', target: record.email, message: `Revoked ${record.email}’s Omni organization membership and verified it by rereading the user inventory.`, rowNumbers: record.rowNumbers });
      } else {
        results.push({ status: 'failed', stage: 'deprovision', field: 'membership_revocation', target: record.email, message: `Deprovisioning outcome is unverified. Refresh and validate before retrying: ${error instanceof Error ? error.message : String(error)}`, rowNumbers: record.rowNumbers });
      }
    }
    report('Deprovisioning', record.email);
  }
  assertActive();
  return results;
}

export const IDENTITY_IMPORT_TEMPLATE: string[][] = [
  [...SIMPLE_HEADERS],
  ['add', 'Example Analyst', 'analyst@example.com', 'Analytics Users, Finance Users', 'Restricted Querier', 'Production Warehouse', 'Core Analytics'],
  ['add', 'Example Administrator', 'admin@example.com', '', 'Connection Admin', 'Production Warehouse', ''],
  ['remove', '', 'former.analyst@example.com', 'Legacy Users', '', '', ''],
  ['remove', 'Departed User', 'departed.user@example.com', '', '', '', ''],
];
