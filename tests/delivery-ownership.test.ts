import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceBundle } from '../src/services/evidenceBundle';
import { parseDeliveryOwnershipReport } from '../src/services/deliveryOwnership';
import { getDeliveryOwnershipEvidence } from '../server/services/deliveryOwnership';
import type { SavedInstance } from '../server/services/nativeVault';

const INSTANCE = {
  id: 'instance-1',
  label: 'Example organization',
  role: 'both',
  baseUrl: 'https://example.omniapp.co',
  apiKey: 'test-only-key',
  metricFilter: {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  },
  postMigrationActions: [],
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
} satisfies SavedInstance;

test('delivery ownership contract preserves latest-only and lifecycle boundaries', () => {
  const bundle = createEvidenceBundle({
    kind: 'delivery-ownership',
    generatedAt: '2026-08-26T12:00:00.000Z',
    selectedInstance: { id: 'instance-1', label: 'Example organization', origin: 'https://example.omniapp.co' },
    scope: { scheduleId: 'schedule-1' },
    sources: [
      { label: 'Schedule detail', method: 'GET', path: '/api/v1/schedules/schedule-1', assertion: 'observed' },
      { label: 'Recipients', method: 'GET', path: '/api/v1/schedules/schedule-1/recipients', assertion: 'observed' },
    ],
    coverage: { included: 2, total: 3, complete: false, unit: 'evidence areas' },
    exclusions: ['General schedule-run history is unavailable.'],
    evidence: {
      schedule: {
        id: 'schedule-1',
        name: 'Example delivery',
        ownerId: 'user-1',
        ownerName: 'Example owner',
        ownerState: 'inactive' as const,
        destinations: [{ type: 'email', latestStatus: 'COMPLETE', recipientCount: 1 }],
      },
      recipients: [{ label: 'Example recipient', kind: 'user' as const, userId: 'user-2', accountState: 'active' as const }],
      exposure: [{ severity: 'critical' as const, code: 'inactive_owner', message: 'The schedule owner is inactive.' }],
      historyCoverage: { state: 'latest_only' as const, detail: 'Latest destination evidence only.' },
    },
  });

  const parsed = parseDeliveryOwnershipReport({ state: 'partial', bundle });
  assert.equal(parsed.bundle.evidence.schedule.ownerState, 'inactive');
  assert.equal(parsed.bundle.evidence.historyCoverage.state, 'latest_only');
  assert.equal(parsed.bundle.coverage.complete, false);

  const withUnexpectedUpstreamField = structuredClone({ state: 'partial', bundle }) as {
    bundle: { evidence: { schedule: Record<string, unknown> } };
  };
  withUnexpectedUpstreamField.bundle.evidence.schedule.rawResponse = 'Bearer should-not-be-accepted';
  assert.throws(
    () => parseDeliveryOwnershipReport(withUnexpectedUpstreamField),
    /invalid delivery-ownership evidence/i,
  );
});

test('delivery ownership parser rejects a response without selected schedule evidence', () => {
  assert.throws(
    () => parseDeliveryOwnershipReport({ state: 'available', bundle: { schemaVersion: 1, evidence: {} } }),
    /invalid delivery-ownership evidence/i,
  );
});

test('delivery ownership preserves omitted SCIM active as unverified exposure', async () => {
  const report = await getDeliveryOwnershipEvidence(INSTANCE, 'schedule-1', undefined, {
    client: {
      async getSchedule() {
        return { id: 'schedule-1', name: 'Example delivery', ownerId: 'user-1' };
      },
      async listScheduleRecipients() {
        return { recipients: [{ id: 'recipient-1', userId: 'user-1', name: 'Example recipient' }] };
      },
      async getIdentityUserPage(count, startIndex) {
        assert.equal(count, 100);
        assert.equal(startIndex, 1);
        return {
          Resources: [{ id: 'user-1', userName: 'person@example.com' }],
          totalResults: 1,
          itemsPerPage: 1,
          startIndex: 1,
        };
      },
    },
  });

  assert.equal(report.bundle.evidence.schedule.ownerState, 'unverified');
  assert.equal(report.bundle.evidence.recipients[0]?.accountState, 'unverified');
  assert.deepEqual(
    report.bundle.evidence.exposure.map(({ code }) => code).sort(),
    ['owner_unverified', 'recipient_lifecycle_unverified'],
  );
  assert.equal(
    report.bundle.evidence.exposure.some(({ code }) => code === 'no_observed_exposure'),
    false,
  );
});
