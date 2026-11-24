import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { TopicMigrationExecutionBinding } from '../shared/topicMigration';
import { canPreserveTopicMigrationJobEvidence } from '../server/services/jobSanitizer';

const sourceHash = 'sha256:' + '1234567890'.repeat(6) + '1234';
const targetHash = 'sha256:' + '9876543210'.repeat(6) + '9876';
const binding = (): TopicMigrationExecutionBinding => ({
  planId: '11111111-1111-4111-8111-111111111111', revision: 'a'.repeat(64),
  sourceHash, targetHash, filesHash: createHash('sha256').update('[]').digest('hex'), instanceBoundaryHash: 'b'.repeat(64),
  topicIds: ['example.topic'], request: {
    sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model',
    targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model',
    topicIds: ['example.topic'], schemaMapText: 'SOURCE.PUBLIC -> omni_demo.analytics',
    keepDestinationDefinitions: { 'SOURCE.PUBLIC/records.view': { destinationFileName: 'omni_demo.analytics/records.view', sourceHash, targetHash } },
  },
});

test('snapshot-bound destination preservation survives typed history sanitization', () => {
  assert.equal(canPreserveTopicMigrationJobEvidence(binding(), []), true);
});

test('preservation sanitization never exempts stale hashes, credentials, unrelated paths, or arbitrary fields', () => {
  for (const patch of [
    { sourceHash: 'sha256:' + '1'.repeat(64) },
    { targetHash: 'Bearer fictional-secret' },
    { destinationFileName: 'omni_credentialmaterial/records.view' },
    { destinationFileName: '../omni_demo.analytics/records.view' },
    { authorization: 'Bearer fictional-secret' },
  ]) {
    const row = binding();
    Object.assign(row.request.keepDestinationDefinitions!['SOURCE.PUBLIC/records.view'], patch);
    assert.equal(canPreserveTopicMigrationJobEvidence(row, []), false);
  }
});
