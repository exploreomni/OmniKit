import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvidenceBundle,
  evidenceBundleJson,
  sanitizeEvidence,
} from '../src/services/evidenceBundle';

test('evidence bundles preserve scope while removing secrets and raw transport data', () => {
  const bundle = createEvidenceBundle({
    kind: 'example-evidence',
    generatedAt: '2026-08-26T12:00:00.000Z',
    selectedInstance: {
      id: 'instance-1',
      label: 'Example organization',
      origin: 'https://example.omniapp.co',
    },
    scope: { modelId: 'model-1' },
    sources: [{ label: 'Current caller', method: 'GET', path: '/api/v1/whoami', assertion: 'observed' }],
    coverage: { included: 1, total: 1, complete: true, unit: 'callers' },
    evidence: {
      caller: { id: 'user-1', email: 'operator@example.test' },
      apiKey: 'must-not-leak',
      nested: { Authorization: 'Bearer must-not-leak', raw: { unsafe: true } },
    },
  });

  assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(bundle.scope, { modelId: 'model-1' });
  assert.deepEqual(bundle.evidence, {
    caller: { id: 'user-1', email: 'operator@example.test' },
    nested: {},
  });
  assert.deepEqual(bundle.sanitization.redactedFields, [
    'evidence.apiKey',
    'evidence.nested.Authorization',
    'evidence.nested.raw',
  ]);
  assert.doesNotMatch(evidenceBundleJson(bundle), /must-not-leak/);
});

test('sanitization is immutable and records each removed field path', () => {
  const original = { value: [{ token: 'hidden', status: 'available' }] };
  const sanitized = sanitizeEvidence(original);

  assert.deepEqual(original, { value: [{ token: 'hidden', status: 'available' }] });
  assert.deepEqual(sanitized.value, { value: [{ status: 'available' }] });
  assert.deepEqual(sanitized.redactedFields, ['value[0].token']);
});

test('evidence bundles redact secret-shaped values across metadata and ordinary strings', () => {
  const bundle = createEvidenceBundle({
    kind: 'secret-value-evidence',
    generatedAt: '2026-08-26T12:00:00.000Z',
    selectedInstance: {
      id: 'instance-1',
      label: 'Tenant Bearer metadata-secret',
      origin: 'https://operator:password-value@example.omniapp.co',
    },
    scope: { note: 'api_key=scope-secret-value' },
    sources: [{ label: 'token source-secret-value', method: 'GET', path: '/api/v1/example', assertion: 'observed' }],
    coverage: { included: 1, total: 1, complete: true, unit: 'records' },
    exclusions: ['Provider token omni_live_abcdefghijklmnop must not leak.'],
    evidence: {
      scheduleName: 'Daily delivery',
      systemDisabledReason: 'Authorization: Bearer upstream-secret-value',
      callback: 'https://user:callback-secret@example.test/hook?token=query-secret',
    },
  });

  const serialized = evidenceBundleJson(bundle);
  for (const secret of [
    'metadata-secret',
    'password-value',
    'scope-secret-value',
    'source-secret-value',
    'omni_live_abcdefghijklmnop',
    'upstream-secret-value',
    'callback-secret',
    'query-secret',
  ]) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[redacted/);
  assert.deepEqual(bundle.sanitization.redactedFields, [
    'evidence.callback',
    'evidence.systemDisabledReason',
    'exclusions[0]',
    'scope.note',
    'selectedInstance.label',
    'selectedInstance.origin',
    'sources[0].label',
  ]);
});
