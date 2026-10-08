import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSensitiveText, sanitizeJob } from '../server/services/jobSanitizer';
import type { MigrationJob } from '../server/services/migrationJobs';

const digest = 'a'.repeat(20) + '2125550199' + 'b'.repeat(34);
const targetId = 'target-2125550199';
const sourceId = 'source-3125550123';
const branchName = 'omnikit-dashboard-2026-10-07T12-34-56-789Z';
const sensitive = 'owner@example.test 2125550199 api_key: omni_fictionalsecret';

function fixture(): MigrationJob {
  return {
    id: 'package-sanitizer-job', workflow: 'dashboard', sourceId: 'source-instance', sourceLabel: 'Source',
    sourceConnectionId: 'source-connection', destinationIds: ['destination-instance'],
    targets: [{ id: targetId, destinationInstanceId: 'destination-instance', destinationLabel: 'Destination',
      targetConnectionId: 'destination-connection', targetModelId: 'destination-model' }],
    documentIds: [sourceId], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false,
    postMigrationActions: [], status: 'pending', createdAt: 1_750_000_000_000, items: [],
    details: {
      safeCopyProfile: 'safe_copy_v1', operationMode: 'safe_copy',
      safeCopyDeployment: { version: 2, planId: 'package-plan', sourceHashes: { [sourceId]: digest },
        modelHashes: { [targetId]: digest }, sourceModelHashes: { 'source-model': digest },
        packageCopy: { version: 1, targetFingerprints: { [targetId]: digest },
          confirmDestinationAudience: true, confirmDependencies: true } },
      dashboardPackageReceipts: { [targetId]: { fingerprint: digest, baselineHash: digest, expectedHash: digest,
        branchId: 'branch-4155550134', branchName, branchVerified: true, modelReady: false,
        imports: { [sourceId]: { sourceDocumentId: sourceId, identifier: 'a2125550199b',
          documentId: 'document-5125550145', name: sensitive, nameHash: digest,
          miniUuidMap: { 'tile-6125550156': 'tile-7125550167' }, imported: true, localsVerified: true,
          contentVerified: true, queriesVerified: false, verified: false } } } },
      dashboardPackageResults: [{ targetId, status: 'needs_review', stage: sensitive, message: sensitive,
        branchId: 'branch-4155550134', branchName,
        documents: [{ sourceDocumentId: sourceId, name: sensitive, identifier: 'a2125550199b',
          documentId: 'document-5125550145', status: 'needs_review', message: sensitive,
          url: 'https://user:password@example.test/dashboard/2125550199' }] }],
      unrelatedEvidence: { fingerprint: digest, documentId: 'document-5125550145', yaml: sensitive,
        apiKey: 'omni_fictionalsecret' },
    },
  };
}

function receipt(job: MigrationJob) {
  return (job.details!.dashboardPackageReceipts as Record<string, {
    fingerprint: string; baselineHash: string; expectedHash: string; branchId: string; branchName: string;
    imports: Record<string, { sourceDocumentId: string; identifier: string; documentId: string; name: string; nameHash: string;
      miniUuidMap: Record<string, string> }>;
  }>)[targetId];
}

test('package sanitizer preserves only approved bounded recovery identities through repeated history sanitization', () => {
  assert.notEqual(redactSensitiveText(digest), digest);
  const sanitized = sanitizeJob(fixture());
  const row = receipt(sanitized);
  assert.equal(row.fingerprint, digest);
  assert.equal(row.baselineHash, digest);
  assert.equal(row.expectedHash, digest);
  assert.equal(row.branchId, 'branch-4155550134');
  assert.equal(row.branchName, branchName);
  assert.deepEqual(row.imports[sourceId].miniUuidMap, { 'tile-6125550156': 'tile-7125550167' });
  assert.equal(row.imports[sourceId].sourceDocumentId, sourceId);
  assert.equal(row.imports[sourceId].identifier, 'a2125550199b');
  assert.equal(row.imports[sourceId].documentId, 'document-5125550145');
  assert.equal(row.imports[sourceId].nameHash, digest);
  assert.equal(row.imports[sourceId].name, redactSensitiveText(sensitive));
  const results = sanitized.details!.dashboardPackageResults as Array<Record<string, unknown>>;
  assert.equal(results[0].targetId, targetId);
  assert.equal(results[0].stage, redactSensitiveText(sensitive));
  const document = (results[0].documents as Array<Record<string, unknown>>)[0];
  assert.equal(document.sourceDocumentId, sourceId);
  assert.equal(document.identifier, 'a2125550199b');
  assert.equal(document.documentId, 'document-5125550145');
  assert.equal(document.name, redactSensitiveText(sensitive));
  assert.match(document.url as string, /\[redacted\]/);
  const approval = sanitized.details!.safeCopyDeployment as { packageCopy: { targetFingerprints: Record<string, string> } };
  assert.equal(approval.packageCopy.targetFingerprints[targetId], digest);
  assert.deepEqual(sanitizeJob(sanitized), sanitized);
  assert.deepEqual(sanitized.details!.unrelatedEvidence, {
    fingerprint: redactSensitiveText(digest), documentId: redactSensitiveText('document-5125550145'),
    yaml: redactSensitiveText(sensitive), apiKey: '[redacted]',
  });
});

test('package sanitizer does not exempt legacy, unapproved, or out-of-scope package evidence', () => {
  for (const mutate of [
    (job: MigrationJob) => { delete (job.details!.safeCopyDeployment as Record<string, unknown>).packageCopy; },
    (job: MigrationJob) => { job.workflow = 'model'; },
    (job: MigrationJob) => { job.documentIds = ['different-source']; },
    (job: MigrationJob) => { job.targets![0].id = 'different-target'; },
    (job: MigrationJob) => {
      const approval = job.details!.safeCopyDeployment as { packageCopy: Record<string, unknown> };
      approval.packageCopy.confirmDependencies = false;
    },
  ]) {
    const job = fixture(); mutate(job);
    const sanitized = sanitizeJob(job);
    assert.equal(receipt(sanitized), undefined, 'Unapproved numeric-looking map keys retain ordinary sanitization.');
    assert.match(JSON.stringify(sanitized.details!.dashboardPackageReceipts), /\[redacted-phone\]/);
    assert.doesNotMatch(JSON.stringify(sanitized.details), /omni_fictionalsecret|owner@example\.test/);
  }
});

test('package sanitizer rejects mismatched fingerprints, unsafe identifiers, ambiguous maps, and unknown receipt fields', () => {
  for (const mutate of [
    (row: ReturnType<typeof receipt>) => { row.fingerprint = 'c'.repeat(64); },
    (row: ReturnType<typeof receipt>) => { row.branchName = sensitive; },
    (row: ReturnType<typeof receipt>) => { row.imports[sourceId].documentId = 'omni_fictionalsecret'; },
    (row: ReturnType<typeof receipt>) => { row.imports[sourceId].documentId = 'prefix-omni_fictionalsecret'; },
    (row: ReturnType<typeof receipt>) => { row.imports[sourceId].documentId = 'api_key:fictionalsecret'; },
    (row: ReturnType<typeof receipt>) => { row.imports[sourceId].nameHash = sensitive; },
    (row: ReturnType<typeof receipt>) => { row.imports[sourceId].miniUuidMap = { a: 'same', b: 'same' }; },
    (row: ReturnType<typeof receipt>) => { row.imports[sourceId].miniUuidMap = { a: 'x'.repeat(257) }; },
    (row: ReturnType<typeof receipt>) => { Object.assign(row, { yaml: sensitive }); },
  ]) {
    const job = fixture(); mutate(receipt(job));
    const sanitized = sanitizeJob(job);
    assert.equal(receipt(sanitized), undefined);
    assert.match(JSON.stringify(sanitized.details!.dashboardPackageReceipts), /\[redacted-phone\]/);
    assert.doesNotMatch(JSON.stringify(sanitized.details), /omni_fictionalsecret|owner@example\.test/);
  }
});
