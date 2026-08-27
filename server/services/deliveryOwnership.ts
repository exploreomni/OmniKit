import {
  createEvidenceBundle,
  type EvidenceBundle,
} from '../../src/services/evidenceBundle';
import {
  OmniClient,
  OmniClientError,
} from './omniClient';
import {
  listIdentityAccessUsers,
  type IdentityAccessUserRecord,
} from './identityAccessEvidence';
import type { SavedInstance } from './nativeVault';

export type DeliveryEvidenceState = 'available' | 'partial' | 'permission_denied' | 'unavailable';

export interface DeliveryRecipientEvidence {
  id?: string;
  label: string;
  kind: 'user' | 'group' | 'email' | 'channel' | 'destination' | 'unknown';
  userId?: string;
  accountState: 'active' | 'inactive' | 'not_applicable' | 'unverified';
}

export interface DeliveryDestinationEvidence {
  id?: string;
  type: string;
  format?: string;
  latestStatus?: string;
  lastCompletedAt?: string;
  recipientCount: number;
}

export interface DeliveryOwnershipEvidence {
  schedule: {
    id: string;
    name: string;
    dashboardId?: string;
    ownerId?: string;
    ownerName?: string;
    ownerState: 'active' | 'inactive' | 'not_found' | 'unverified';
    disabledAt?: string;
    systemDisabledAt?: string;
    systemDisabledReason?: string;
    destinations: DeliveryDestinationEvidence[];
  };
  recipients: DeliveryRecipientEvidence[];
  exposure: Array<{
    severity: 'critical' | 'warning' | 'info';
    code: string;
    message: string;
  }>;
  historyCoverage: {
    state: 'latest_only';
    detail: string;
  };
}

export interface DeliveryOwnershipReport {
  state: DeliveryEvidenceState;
  bundle: EvidenceBundle<DeliveryOwnershipEvidence>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 2_000);
  }
  return undefined;
}

function nested(record: UnknownRecord | null, ...path: string[]): unknown {
  let current: unknown = record;
  for (const part of path) {
    const row = asRecord(current);
    if (!row) return undefined;
    current = row[part];
  }
  return current;
}

function recordArray(value: unknown, keys: string[]): UnknownRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((row): row is UnknownRecord => Boolean(row));
  const root = asRecord(value);
  if (!root) return [];
  for (const key of keys) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).map(asRecord).filter((row): row is UnknownRecord => Boolean(row));
  }
  return [];
}

function parseDestinations(schedule: UnknownRecord): DeliveryDestinationEvidence[] {
  const destinations = recordArray(schedule.destinations, []);
  return destinations.map((destination) => {
    const metadata = asRecord(destination.metadata);
    const recipients = recordArray(destination.recipients, []);
    const userGroupRecipients = recordArray(destination.userGroupRecipients ?? destination.user_group_recipients, []);
    return {
      ...(firstString(destination.id) ? { id: firstString(destination.id) } : {}),
      type: firstString(destination.destinationType, destination.destination_type, metadata?.type, destination.type) ?? 'unknown',
      ...(firstString(destination.format, metadata?.format) ? { format: firstString(destination.format, metadata?.format) } : {}),
      ...(firstString(destination.lastStatus, destination.last_status) ? { latestStatus: firstString(destination.lastStatus, destination.last_status) } : {}),
      ...(firstString(destination.lastCompletedAt, destination.last_completed_at) ? { lastCompletedAt: firstString(destination.lastCompletedAt, destination.last_completed_at) } : {}),
      recipientCount: recipients.length + userGroupRecipients.length,
    };
  });
}

function parseRecipient(row: UnknownRecord): Omit<DeliveryRecipientEvidence, 'accountState'> {
  const membership = asRecord(row.membership);
  const membershipUser = asRecord(membership?.user);
  const user = asRecord(row.user) ?? membershipUser;
  const group = asRecord(row.userGroup ?? row.user_group ?? row.group);
  const userId = firstString(row.userId, row.user_id, user?.id, row.membershipId, row.membership_id);
  const email = firstString(row.email, user?.email, nested(row, 'membership', 'user', 'email'));
  const name = firstString(row.name, row.displayName, user?.name, group?.name, row.channelName, row.channel_name);
  const id = firstString(row.id, userId, group?.id, row.channelId, row.channel_id);
  const kind: DeliveryRecipientEvidence['kind'] = group
    ? 'group'
    : userId || user
      ? 'user'
      : email
        ? 'email'
        : firstString(row.channelId, row.channel_id)
          ? 'channel'
          : firstString(row.destinationType, row.destination_type)
            ? 'destination'
            : 'unknown';
  return {
    ...(id ? { id } : {}),
    label: name ?? email ?? id ?? 'Recipient details not returned',
    kind,
    ...(userId ? { userId } : {}),
  };
}

function parseRecipients(value: unknown, users: IdentityAccessUserRecord[] | null): DeliveryRecipientEvidence[] {
  const rows = recordArray(value, ['recipients', 'records', 'data', 'items']);
  const usersById = new Map((users ?? []).map((user) => [user.id, user]));
  return rows.map((row) => {
    const recipient = parseRecipient(row);
    const matchedUser = recipient.userId ? usersById.get(recipient.userId) : undefined;
    return {
      ...recipient,
      accountState: recipient.kind === 'email' || recipient.kind === 'channel' || recipient.kind === 'destination'
        ? 'not_applicable'
        : !users
          ? 'unverified'
          : matchedUser
            ? matchedUser.active === true
              ? 'active'
              : matchedUser.active === false
                ? 'inactive'
                : 'unverified'
            : 'unverified',
    };
  });
}

function ownerState(
  ownerId: string | undefined,
  users: IdentityAccessUserRecord[] | null,
): DeliveryOwnershipEvidence['schedule']['ownerState'] {
  if (!users) return 'unverified';
  if (!ownerId) return 'not_found';
  const owner = users.find((user) => user.id === ownerId);
  if (!owner) return 'not_found';
  if (owner.active === true) return 'active';
  if (owner.active === false) return 'inactive';
  return 'unverified';
}

function evidenceReadFailure(error: unknown): { state: DeliveryEvidenceState; reason: string } {
  if (error instanceof OmniClientError && (error.status === 401 || error.status === 403)) {
    return { state: 'permission_denied', reason: 'The current caller could not read this evidence area.' };
  }
  return { state: 'unavailable', reason: 'The evidence area could not be read from Omni.' };
}

export async function getDeliveryOwnershipEvidence(
  instance: SavedInstance,
  scheduleId: string,
  signal?: AbortSignal,
  dependencies: {
    client?: Pick<OmniClient, 'getSchedule' | 'listScheduleRecipients' | 'getIdentityUserPage'>;
  } = {},
): Promise<DeliveryOwnershipReport> {
  const client = dependencies.client ?? new OmniClient(instance, { requestTimeoutMs: 15_000, maxReadRetries: 1 });
  const scheduleValue = await client.getSchedule(scheduleId, signal);
  const schedule = asRecord(scheduleValue);
  if (!schedule || firstString(schedule.id) !== scheduleId) {
    throw Object.assign(new Error('Omni returned an invalid schedule detail response.'), { statusCode: 502 });
  }

  const [recipientResult, userResult] = await Promise.allSettled([
    client.listScheduleRecipients(scheduleId, signal),
    listIdentityAccessUsers(
      (count, startIndex, pageSignal) => client.getIdentityUserPage(count, startIndex, pageSignal),
      signal,
    ),
  ]);
  const recipientsValue = recipientResult.status === 'fulfilled' ? recipientResult.value : null;
  const users = userResult.status === 'fulfilled' ? userResult.value : null;
  const recipients = recipientsValue === null ? [] : parseRecipients(recipientsValue, users);
  const ownerId = firstString(schedule.ownerId, schedule.owner_id);
  const ownerName = firstString(nested(schedule, 'owner', 'name'), schedule.ownerName, schedule.owner_name);
  const ownerEvidenceState = ownerState(ownerId, users);
  const exposure: DeliveryOwnershipEvidence['exposure'] = [];
  if (ownerEvidenceState === 'inactive') {
    exposure.push({ severity: 'critical', code: 'inactive_owner', message: 'The schedule owner is an inactive Omni user.' });
  } else if (ownerEvidenceState === 'not_found') {
    exposure.push({ severity: 'warning', code: 'owner_not_found', message: 'The schedule owner was not present in the readable standard-user inventory.' });
  } else if (ownerEvidenceState === 'unverified') {
    exposure.push({ severity: 'warning', code: 'owner_unverified', message: 'The current caller could not establish the owner\'s lifecycle state.' });
  }
  const inactiveRecipients = recipients.filter(({ accountState }) => accountState === 'inactive');
  if (inactiveRecipients.length > 0) {
    exposure.push({ severity: 'warning', code: 'inactive_recipients', message: `${inactiveRecipients.length} recipient account${inactiveRecipients.length === 1 ? '' : 's'} are inactive.` });
  }
  const unverifiedRecipients = recipients.filter(({ accountState }) => accountState === 'unverified');
  if (unverifiedRecipients.length > 0) {
    exposure.push({ severity: 'warning', code: 'recipient_lifecycle_unverified', message: `${unverifiedRecipients.length} recipient lifecycle state${unverifiedRecipients.length === 1 ? ' was' : 's were'} not established by the readable identity evidence.` });
  }
  const systemDisabledAt = firstString(schedule.systemDisabledAt, schedule.system_disabled_at);
  const systemDisabledReason = firstString(schedule.systemDisabledReason, schedule.system_disabled_reason);
  if (systemDisabledAt) {
    exposure.push({ severity: 'critical', code: 'system_disabled', message: systemDisabledReason ? `Omni system-disabled this schedule: ${systemDisabledReason}.` : 'Omni system-disabled this schedule.' });
  }
  if (exposure.length === 0) {
    exposure.push({ severity: 'info', code: 'no_observed_exposure', message: 'No lifecycle or system-disabled exposure was observed in the available evidence.' });
  }

  const unavailableAreas = [
    ...(recipientResult.status === 'rejected' ? [`Recipients: ${evidenceReadFailure(recipientResult.reason).reason}`] : []),
    ...(userResult.status === 'rejected' ? [`User lifecycle: ${evidenceReadFailure(userResult.reason).reason}`] : []),
  ];
  const included = 1 + Number(recipientResult.status === 'fulfilled') + Number(userResult.status === 'fulfilled');
  const evidence: DeliveryOwnershipEvidence = {
    schedule: {
      id: scheduleId,
      name: firstString(schedule.name) ?? scheduleId,
      ...(firstString(schedule.entityId, schedule.entity_id, schedule.identifier) ? { dashboardId: firstString(schedule.entityId, schedule.entity_id, schedule.identifier) } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(ownerName ? { ownerName } : {}),
      ownerState: ownerEvidenceState,
      ...(firstString(schedule.disabledAt, schedule.disabled_at) ? { disabledAt: firstString(schedule.disabledAt, schedule.disabled_at) } : {}),
      ...(systemDisabledAt ? { systemDisabledAt } : {}),
      ...(systemDisabledReason ? { systemDisabledReason } : {}),
      destinations: parseDestinations(schedule),
    },
    recipients,
    exposure,
    historyCoverage: {
      state: 'latest_only',
      detail: 'OmniKit reports current schedule configuration and latest destination status only; the public API does not establish general run-history monitoring.',
    },
  };
  return {
    state: included === 3 ? 'available' : 'partial',
    bundle: createEvidenceBundle({
      kind: 'delivery-ownership',
      selectedInstance: { id: instance.id, label: instance.label, origin: new URL(instance.baseUrl).origin },
      scope: { scheduleId },
      sources: [
        { label: 'Schedule detail', method: 'GET', path: `/api/v1/schedules/${scheduleId}`, assertion: 'observed' },
        { label: 'Schedule recipients', method: 'GET', path: `/api/v1/schedules/${scheduleId}/recipients`, assertion: recipientResult.status === 'fulfilled' ? 'observed' : 'unverified' },
        { label: 'Standard-user lifecycle', method: 'GET', path: '/api/scim/v2/users', assertion: userResult.status === 'fulfilled' ? 'observed' : 'unverified' },
      ],
      coverage: { included, total: 3, complete: included === 3, unit: 'evidence areas' },
      exclusions: [
        ...unavailableAreas,
        'General schedule-run history and detailed delivery-error history are not claimed.',
        'Embed-group and entity-folder permission behavior are outside this evidence bundle.',
      ],
      evidence,
    }),
  };
}
