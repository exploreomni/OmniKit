import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  OmniApiContractRadarContractError,
  parseOmniApiContractRadarReport,
} from '../src/services/omniApiContractRadar';

const HASH = 'a'.repeat(64);
const pageSource = readFileSync(new URL('../src/pages/ApiContractRadarPage.tsx', import.meta.url), 'utf8');

function report() {
  return {
    schemaVersion: 1,
    instanceId: 'radar-instance',
    tenantOrigin: 'https://radar-neutral.example.com',
    checkedAt: '2026-08-26T12:30:00.000Z',
    source: { method: 'GET', path: '/openapi.json' },
    openapiVersion: '3.1.0',
    specFingerprint: HASH,
    externalReferenceCount: 0,
    unresolvedLocalReferenceCount: 0,
    complete: true,
    baseline: { available: false },
    summary: {
      tenantOperations: 1,
      registryOperations: 1,
      matchedOperations: 1,
      tenantOnly: 0,
      registryOnly: 0,
      methodMismatches: 0,
      schemaChanges: 0,
      classificationMismatches: 0,
    },
    operations: [{
      key: 'GET /api/v1/whoami',
      path: '/api/v1/whoami',
      method: 'GET',
      pathFingerprint: HASH,
      methodFingerprint: HASH,
      requestSchemaFingerprint: HASH,
      responseSchemaFingerprint: HASH,
      schemaFingerprint: HASH,
      operationFingerprint: HASH,
      deprecated: false,
      registry: {
        id: 'whoami',
        status: 'documented_current',
        probeMode: 'read_only',
      },
    }],
    findings: [],
  };
}

test('frontend Contract Radar parser preserves the exact sanitized projection', () => {
  const parsed = parseOmniApiContractRadarReport(report());
  assert.equal(parsed.instanceId, 'radar-instance');
  assert.equal(parsed.tenantOrigin, 'https://radar-neutral.example.com');
  assert.equal(parsed.operations[0].path, '/api/v1/whoami');
  assert.equal(parsed.operations[0].registry?.id, 'whoami');
  assert.equal(parsed.summary.matchedOperations, 1);
});

test('frontend Contract Radar parser fails closed on unknown fields and unreconciled summaries', () => {
  const unknown = structuredClone(report());
  Object.assign(unknown.operations[0], { privateSchemaValue: 'must-not-cross-the-contract' });
  assert.throws(
    () => parseOmniApiContractRadarReport(unknown),
    OmniApiContractRadarContractError,
  );

  const unreconciled = structuredClone(report());
  unreconciled.summary.tenantOperations = 2;
  assert.throws(
    () => parseOmniApiContractRadarReport(unreconciled),
    /summary reconciliation/,
  );

  const partialBaseline = structuredClone(report());
  Object.assign(partialBaseline.baseline, { checkedAt: '2026-08-26T12:00:00.000Z' });
  assert.throws(
    () => parseOmniApiContractRadarReport(partialBaseline),
    /baseline availability/,
  );

  const invalidOrigin = structuredClone(report());
  invalidOrigin.tenantOrigin = 'https://radar-neutral.example.com/path';
  assert.throws(
    () => parseOmniApiContractRadarReport(invalidOrigin),
    /tenantOrigin/,
  );

  const unresolvedButComplete = structuredClone(report());
  unresolvedButComplete.unresolvedLocalReferenceCount = 1;
  assert.throws(
    () => parseOmniApiContractRadarReport(unresolvedButComplete),
    /reference completeness/,
  );
});

test('Contract Radar page invalidates requests on the full connection key and verifies returned origin', () => {
  assert.match(pageSource, /getConnectionCacheKey\(connection\)/);
  assert.match(pageSource, /activeConnectionKeyRef\.current = connectionKey/);
  assert.match(pageSource, /\}, \[connectionKey\]\);/);
  assert.match(pageSource, /activeConnectionKeyRef\.current !== requestConnectionKey/);
  assert.match(pageSource, /next\.tenantOrigin !== expectedTenantOrigin/);
});
