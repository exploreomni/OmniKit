import { ApiError } from '@/services/omniApi';
import type { EvidenceBundle } from '@/services/evidenceBundle';
import { emitVaultLocked } from '@/services/vaultEvents';

export type DeliveryEvidenceState = 'available' | 'partial' | 'permission_denied' | 'unavailable';

export interface DeliveryRecipientEvidenceDTO {
  id?: string;
  label: string;
  kind: 'user' | 'group' | 'email' | 'channel' | 'destination' | 'unknown';
  userId?: string;
  accountState: 'active' | 'inactive' | 'not_applicable' | 'unverified';
}

export interface DeliveryOwnershipEvidenceDTO {
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
    destinations: Array<{
      id?: string;
      type: string;
      format?: string;
      latestStatus?: string;
      lastCompletedAt?: string;
      recipientCount: number;
    }>;
  };
  recipients: DeliveryRecipientEvidenceDTO[];
  exposure: Array<{
    severity: 'critical' | 'warning' | 'info';
    code: string;
    message: string;
  }>;
  historyCoverage: { state: 'latest_only'; detail: string };
}

export interface DeliveryOwnershipReportDTO {
  state: DeliveryEvidenceState;
  bundle: EvidenceBundle<DeliveryOwnershipEvidenceDTO>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidContract(): never {
  throw new Error('OmniKit returned an invalid delivery-ownership evidence response.');
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) invalidContract();
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) invalidContract();
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000) invalidContract();
  return value.map(requiredString);
}

function enumString<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalidContract();
  return value as T;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidContract();
  return Number(value);
}

function optionalScheduleString(schedule: Record<string, unknown>, key: string): Record<string, string> {
  const value = optionalString(schedule[key]);
  return value === undefined ? {} : { [key]: value };
}

export function parseDeliveryOwnershipReport(value: unknown): DeliveryOwnershipReportDTO {
  const root = record(value);
  const bundle = record(root?.bundle);
  const evidence = record(bundle?.evidence);
  const schedule = record(evidence?.schedule);
  if (!root || !bundle || !evidence || !schedule) invalidContract();
  exactKeys(root, ['state', 'bundle']);
  exactKeys(bundle, [
    'schemaVersion', 'evidenceId', 'generatedAt', 'selectedInstance', 'scope', 'sources',
    'coverage', 'exclusions', 'freshness', 'sanitization', 'evidence',
  ]);
  exactKeys(evidence, ['schedule', 'recipients', 'exposure', 'historyCoverage']);
  exactKeys(schedule, [
    'id', 'name', 'dashboardId', 'ownerId', 'ownerName', 'ownerState', 'disabledAt',
    'systemDisabledAt', 'systemDisabledReason', 'destinations',
  ]);

  const selectedInstance = record(bundle.selectedInstance);
  const scope = record(bundle.scope);
  const coverage = record(bundle.coverage);
  const freshness = record(bundle.freshness);
  const sanitization = record(bundle.sanitization);
  const historyCoverage = record(evidence.historyCoverage);
  if (!selectedInstance || !scope || !coverage || !freshness || !sanitization || !historyCoverage) invalidContract();
  exactKeys(selectedInstance, ['id', 'label', 'origin']);
  exactKeys(scope, ['scheduleId']);
  exactKeys(coverage, ['included', 'total', 'complete', 'unit']);
  exactKeys(freshness, ['checkedAt', 'state']);
  exactKeys(sanitization, ['secretsExcluded', 'rawHeadersExcluded', 'rawUpstreamResponsesExcluded', 'redactedFields']);
  exactKeys(historyCoverage, ['state', 'detail']);

  const origin = requiredString(selectedInstance.origin);
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) invalidContract();
  } catch {
    invalidContract();
  }
  if (bundle.schemaVersion !== 1 || sanitization.secretsExcluded !== true || sanitization.rawHeadersExcluded !== true || sanitization.rawUpstreamResponsesExcluded !== true) {
    invalidContract();
  }
  if (typeof coverage.complete !== 'boolean' || (coverage.total !== null && (!Number.isSafeInteger(coverage.total) || Number(coverage.total) < 0))) invalidContract();

  if (!Array.isArray(bundle.sources) || bundle.sources.length > 100) invalidContract();
  const sources = bundle.sources.map((item) => {
    const source = record(item);
    if (!source) invalidContract();
    exactKeys(source, ['label', 'method', 'path', 'assertion']);
    return {
      label: requiredString(source.label),
      ...(source.method === undefined ? {} : { method: enumString(source.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) }),
      ...(source.path === undefined ? {} : { path: requiredString(source.path) }),
      assertion: enumString(source.assertion, ['observed', 'inferred', 'operator_confirmed', 'unverified'] as const),
    };
  });

  if (!Array.isArray(schedule.destinations) || schedule.destinations.length > 10_000) invalidContract();
  const destinations = schedule.destinations.map((item) => {
    const destination = record(item);
    if (!destination) invalidContract();
    exactKeys(destination, ['id', 'type', 'format', 'latestStatus', 'lastCompletedAt', 'recipientCount']);
    return {
      ...(optionalString(destination.id) ? { id: optionalString(destination.id) } : {}),
      type: requiredString(destination.type),
      ...(optionalString(destination.format) ? { format: optionalString(destination.format) } : {}),
      ...(optionalString(destination.latestStatus) ? { latestStatus: optionalString(destination.latestStatus) } : {}),
      ...(optionalString(destination.lastCompletedAt) ? { lastCompletedAt: optionalString(destination.lastCompletedAt) } : {}),
      recipientCount: nonNegativeInteger(destination.recipientCount),
    };
  });

  if (!Array.isArray(evidence.recipients) || evidence.recipients.length > 10_000) invalidContract();
  const recipients = evidence.recipients.map((item): DeliveryRecipientEvidenceDTO => {
    const recipient = record(item);
    if (!recipient) invalidContract();
    exactKeys(recipient, ['id', 'label', 'kind', 'userId', 'accountState']);
    return {
      ...(optionalString(recipient.id) ? { id: optionalString(recipient.id) } : {}),
      label: requiredString(recipient.label),
      kind: enumString(recipient.kind, ['user', 'group', 'email', 'channel', 'destination', 'unknown'] as const),
      ...(optionalString(recipient.userId) ? { userId: optionalString(recipient.userId) } : {}),
      accountState: enumString(recipient.accountState, ['active', 'inactive', 'not_applicable', 'unverified'] as const),
    };
  });

  if (!Array.isArray(evidence.exposure) || evidence.exposure.length > 1_000) invalidContract();
  const exposure = evidence.exposure.map((item) => {
    const row = record(item);
    if (!row) invalidContract();
    exactKeys(row, ['severity', 'code', 'message']);
    return {
      severity: enumString(row.severity, ['critical', 'warning', 'info'] as const),
      code: requiredString(row.code),
      message: requiredString(row.message),
    };
  });

  return {
    state: enumString(root.state, ['available', 'partial', 'permission_denied', 'unavailable'] as const),
    bundle: {
      schemaVersion: 1,
      evidenceId: requiredString(bundle.evidenceId),
      generatedAt: requiredString(bundle.generatedAt),
      selectedInstance: {
        id: requiredString(selectedInstance.id),
        label: requiredString(selectedInstance.label),
        origin,
      },
      scope: { scheduleId: requiredString(scope.scheduleId) },
      sources,
      coverage: {
        included: nonNegativeInteger(coverage.included),
        total: coverage.total === null ? null : nonNegativeInteger(coverage.total),
        complete: coverage.complete,
        unit: requiredString(coverage.unit),
      },
      exclusions: stringList(bundle.exclusions),
      freshness: {
        checkedAt: requiredString(freshness.checkedAt),
        state: enumString(freshness.state, ['current', 'stale', 'unknown'] as const),
      },
      sanitization: {
        secretsExcluded: true,
        rawHeadersExcluded: true,
        rawUpstreamResponsesExcluded: true,
        redactedFields: stringList(sanitization.redactedFields),
      },
      evidence: {
        schedule: {
          id: requiredString(schedule.id),
          name: requiredString(schedule.name),
          ...optionalScheduleString(schedule, 'dashboardId'),
          ...optionalScheduleString(schedule, 'ownerId'),
          ...optionalScheduleString(schedule, 'ownerName'),
          ownerState: enumString(schedule.ownerState, ['active', 'inactive', 'not_found', 'unverified'] as const),
          ...optionalScheduleString(schedule, 'disabledAt'),
          ...optionalScheduleString(schedule, 'systemDisabledAt'),
          ...optionalScheduleString(schedule, 'systemDisabledReason'),
          destinations,
        },
        recipients,
        exposure,
        historyCoverage: {
          state: enumString(historyCoverage.state, ['latest_only'] as const),
          detail: requiredString(historyCoverage.detail),
        },
      },
    },
  };
}

export async function fetchDeliveryOwnershipEvidence(options: {
  instanceId: string;
  scheduleId: string;
  signal?: AbortSignal;
}): Promise<DeliveryOwnershipReportDTO> {
  const params = new URLSearchParams({
    instanceId: options.instanceId,
    scheduleId: options.scheduleId,
  });
  const response = await fetch(`/api/delivery-ownership?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (!response.ok) {
    const message = response.status === 423
      ? 'Unlock the local vault before reading delivery ownership.'
      : response.status === 403
        ? 'The current caller cannot read this schedule or its ownership evidence.'
        : response.status === 404
          ? 'The selected schedule or Omni instance is no longer available.'
          : `Delivery ownership evidence could not be read (HTTP ${response.status}).`;
    if (response.status === 423) emitVaultLocked(message);
    throw new ApiError(response.status, message);
  }
  const report = parseDeliveryOwnershipReport(await response.json());
  if (
    report.bundle.selectedInstance.id !== options.instanceId
    || report.bundle.scope.scheduleId !== options.scheduleId
  ) {
    throw new Error('Delivery ownership evidence did not match the selected instance and schedule.');
  }
  return report;
}
