import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertDashboardWorkbookCopyCapability,
  dashboardWorkbookHasAuthoredDefinitions,
  getDashboardWorkbookCopyCapability,
  runDashboardWorkbookCopyLifecycle,
  type DashboardWorkbookCopyArtifact,
  type DashboardWorkbookCopyAttempt,
  type DashboardWorkbookCopyLifecycleAdapter,
  type DashboardWorkbookCopyLifecycleInput,
  type DashboardWorkbookCopyStage,
  type DashboardWorkbookCopyWrite,
} from '../server/services/dashboardWorkbookCopy';
import { parseDashboardDeploymentPlanIntent, parseDashboardSafeCopyIntent } from '../shared/dashboardSafeCopyContract';
import { getDashboardWorkbookCopyCapability as getSharedWorkbookCopyCapability } from '../shared/dashboardWorkbookCopyCapability';

function digest(value: unknown): string {
  function stable(item: unknown): unknown {
    return Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, stable(val)])) : item;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function fixture() {
  const authoredFiles = { 'example.view': 'dimensions:\n  local_field:\n    sql: 1\n' };
  const content = { name: 'Source dashboard', queryPresentations: { data: {}, order: [] }, containers: [] };
  const input: DashboardWorkbookCopyLifecycleInput = {
    copyId: 'copy-example', planFingerprint: digest('approved-plan'), sourceDocumentId: 'source-document',
    sourceSharedModelId: 'source-shared', sourceWorkbookModelId: 'source-workbook', targetSharedModelId: 'target-shared',
    stagingFolderId: 'staging-folder', finalFolderId: 'final-folder', placeholderName: 'Migration staging artifact',
    authoredFiles, authoredModelHash: digest(authoredFiles), content, expectedContentHash: digest(content),
    expectedTargetSharedHash: digest('target-shared'), publishPolicyHash: digest('named-draft-policy'),
  };
  const attempts = new Map<string, DashboardWorkbookCopyAttempt>();
  const writes: DashboardWorkbookCopyWrite[] = [];
  const events: string[] = [];
  const completed = new Set<DashboardWorkbookCopyStage>();
  let published = false;
  let delivered = false;
  let files = { 'example.view': 'dimensions: {}' };
  let contentHash = digest({});
  let checksum = 'original-checksum';
  let failAfter: DashboardWorkbookCopyStage | undefined;
  let uncertain = false;
  let badAcl = false;
  let sharedHash = input.expectedTargetSharedHash;
  let draftModelId = 'destination-draft-workbook';
  let failQueries = false;
  let cancelBefore: DashboardWorkbookCopyStage | undefined;
  const controller = new AbortController();
  const artifact = (draft = false): DashboardWorkbookCopyArtifact => ({ documentId: 'created-document',
    ...(draft ? { draftId: 'created-draft', workbookModelId: draftModelId } : {}) });
  const adapter: DashboardWorkbookCopyLifecycleAdapter = {
    async loadAttempts() { return [...attempts.values()].map((attempt) => structuredClone(attempt)); },
    async persistAttempt(attempt) {
      attempts.set(attempt.operationKey, structuredClone(attempt));
      events.push(`record:${attempt.stage}:${attempt.state}`);
      if (attempt.state === 'dispatched' && attempt.stage === cancelBefore) controller.abort();
    },
    async reconcile(attempt) {
      if (uncertain || !completed.has(attempt.stage)) return undefined;
      return artifact(attempt.stage !== 'placeholder_create');
    },
    async revalidateApproval() { events.push('revalidate'); },
    async proveStagingAccess(folderId) {
      return { folderId, complete: !badAcl as true, restriction: 'migration_operator_only', effectiveAclHash: digest('effective-acl') };
    },
    async readSharedModelHash() { return sharedHash; },
    async readArtifact(selected) {
      const draft = Boolean(selected.draftId);
      if (draft && published) throw new Error('Published draft is retired.');
      return { ...artifact(draft), sharedModelId: input.targetSharedModelId,
        workbookModelId: draft || published ? draftModelId : 'placeholder-workbook',
        folderId: delivered ? input.finalFolderId : input.stagingFolderId,
        authoredFiles: draft || published ? files : {}, checksums: { 'example.view': checksum },
        contentHash: draft || published ? contentHash : digest({}), published: !draft };
    },
    async dispatch(write, guard) {
      guard.assertCanDispatch();
      assert.equal(attempts.get(`${write.stage}:${write.stage === 'workbook_write' ? write.fileName : ''}`)?.state, 'dispatched');
      writes.push(write);
      events.push(`write:${write.stage}`);
      if (write.stage === 'workbook_write') {
        assert.equal(write.modelId, draftModelId);
        assert.notEqual(write.modelId, input.targetSharedModelId);
        assert.equal(write.mode, 'extension');
        assert.equal(write.previousChecksum, checksum);
        files = { ...files, [write.fileName]: write.yaml };
        checksum = 'updated-checksum';
      }
      if (write.stage === 'draft_patch') contentHash = digest(write.content);
      if (write.stage === 'publish') published = true;
      if (write.stage === 'deliver') delivered = true;
      completed.add(write.stage);
      if (write.stage === failAfter) { failAfter = undefined; throw new Error('Response lost after commit'); }
      return artifact(write.stage !== 'placeholder_create');
    },
    async verifyDraft(selected) {
      events.push('verify-draft');
      return { workbookModelId: selected.workbookModelId, contentHash, authoredModelHash: digest(files), queriesPassed: !failQueries };
    },
    async provePublishPolicy() { events.push('verify-publish-policy'); return input.publishPolicyHash; },
    async verifyDelivered() { events.push('verify-delivered'); return delivered && published; },
  };
  const run = () => runDashboardWorkbookCopyLifecycle(input, adapter, {
    signal: controller.signal, assertCanDispatch() { if (controller.signal.aborted) throw new Error('canceled'); },
  });
  return { input, adapter, attempts, writes, events, run,
    failAfter(stage: DashboardWorkbookCopyStage) { failAfter = stage; },
    setUncertain() { uncertain = true; }, setBadAcl() { badAcl = true; },
    changeShared() { sharedHash = digest('changed'); }, bindShared() { draftModelId = input.targetSharedModelId; },
    removeChecksum() { checksum = ''; }, failQueries() { failQueries = true; },
    cancelBefore(stage: DashboardWorkbookCopyStage) { cancelBefore = stage; },
  };
}

test('production workbook capability is closed and cannot be enabled by caller evidence', () => {
  assert.equal(getDashboardWorkbookCopyCapability().supported, false);
  assert.throws(assertDashboardWorkbookCopyCapability, { code: 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED' });
});

test('shared workbook readiness identifies implementation gaps without claiming tenant denial or enabling a native fallback', () => {
  const capability = getDashboardWorkbookCopyCapability();
  assert.deepEqual(capability, getSharedWorkbookCopyCapability());
  assert.equal(capability.status, 'implementation_blocked');
  assert.equal(capability.tenantAccessAssessment, 'not_assessed');
  assert.deepEqual(capability.checks.map((check) => check.id), ['production_adapter', 'effective_access', 'new_file_conflicts']);
  assert.ok(capability.checks.every((check) => check.status === 'not_verified'));
  assert.match(capability.message, /not a finding that this tenant denied access/);
  assert.match(capability.transportCandidates[1].title, /Beta/);
  assert.match(capability.transportCandidates[1].detail, /not an automatic fallback/);
  assert.ok(capability.documentation.every((url) => new URL(url).origin === 'https://docs.omni.co'));
  capability.checks.length = 0;
  capability.requiredEvidence.length = 0;
  Reflect.set(capability, 'supported', true);
  assert.equal(getDashboardWorkbookCopyCapability().checks.length, 3);
  assert.equal(getDashboardWorkbookCopyCapability().supported, false);
  assert.throws(assertDashboardWorkbookCopyCapability, { code: 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED' });
});

test('only provably empty authored roots are ignorable', () => {
  for (const yaml of ['', '# comment only', '{}', 'null']) assert.equal(dashboardWorkbookHasAuthoredDefinitions({ model: yaml }), false);
  for (const yaml of ['[]', 'false', 'dimensions: {}', 'sql: 1', 'bad: [']) assert.equal(dashboardWorkbookHasAuthoredDefinitions({ model: yaml }), true);
});

test('guarded lifecycle records each write, binds only draft workbook, verifies before publish and final readiness', async () => {
  const harness = fixture();
  assert.equal((await harness.run()).status, 'verified');
  assert.deepEqual(harness.writes.map((write) => write.stage), ['placeholder_create', 'draft_create', 'workbook_write', 'draft_patch', 'publish', 'deliver']);
  assert.ok(harness.events.indexOf('verify-draft') < harness.events.indexOf('write:publish'));
  assert.equal(harness.events.at(-1), 'verify-delivered');
  for (const attempt of harness.attempts.values()) assert.equal(attempt.state, 'verified');
  const evidence = JSON.stringify([...harness.attempts.values()]);
  assert.ok(!evidence.includes('local_field') && !evidence.includes('Source dashboard'));
  const placeholder = harness.writes[0];
  assert.equal(placeholder.stage, 'placeholder_create');
  if (placeholder.stage === 'placeholder_create') assert.deepEqual(placeholder.queryPresentations, { data: {}, order: [] });
});

for (const stage of ['placeholder_create', 'draft_create', 'workbook_write', 'draft_patch', 'publish', 'deliver'] as const) {
  test(`lost ${stage} response reconciles exact artifact without duplicate write`, async () => {
    const harness = fixture();
    harness.failAfter(stage);
    await assert.rejects(harness.run(), /Response lost/);
    assert.equal((await harness.run()).status, 'verified');
    assert.equal(harness.writes.filter((write) => write.stage === stage).length, 1);
    assert.equal(harness.writes.filter((write) => write.stage === 'placeholder_create').length, 1);
    const count = harness.writes.length;
    assert.equal((await harness.run()).status, 'verified');
    assert.equal(harness.writes.length, count, 'fully delivered resume must not replay earlier stages');
  });
}

test('uncertain create, missing checksum, unsafe ACL, shared binding, and shared drift fail closed', async () => {
  const uncertain = fixture();
  uncertain.failAfter('placeholder_create');
  await assert.rejects(uncertain.run());
  uncertain.setUncertain();
  await assert.rejects(uncertain.run(), /uncertain/);
  assert.equal(uncertain.writes.length, 1);
  for (const alter of ['setBadAcl', 'changeShared', 'bindShared', 'removeChecksum'] as const) {
    const harness = fixture();
    harness[alter]();
    await assert.rejects(harness.run());
    assert.equal(harness.writes.some((write) => write.stage === 'workbook_write' || write.stage === 'publish'), false);
  }
});

test('failed local query proof never publishes or delivers and cancellation after durable record never dispatches', async () => {
  const failed = fixture();
  failed.failQueries();
  await assert.rejects(failed.run(), /failed verification/);
  assert.equal(failed.writes.some((write) => write.stage === 'publish' || write.stage === 'deliver'), false);
  const canceled = fixture();
  canceled.cancelBefore('placeholder_create');
  await assert.rejects(canceled.run());
  assert.equal(canceled.writes.length, 0);
  assert.equal(canceled.attempts.get('placeholder_create:')?.state, 'dispatched');
});

test('workbook contract requires reviewed evidence, retains hashes, and rejects shared identity or staging delivery overlap', () => {
  const base = { profile: 'safe_copy_v1', requestId: '11111111-1111-4111-8111-111111111111',
    source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['source-document'] },
    destinations: [{ targetId: 'target', instanceId: 'destination', connectionId: 'target-connection', modelId: 'target-model',
      folderId: 'delivery', workbookCopy: { stagingFolderId: 'staging' } }] };
  assert.equal(parseDashboardDeploymentPlanIntent(base).destinations[0].workbookCopy?.stagingFolderId, 'staging');
  assert.throws(() => parseDashboardSafeCopyIntent(base));
  const deployment = { version: 2, planId: 'plan', sourceHashes: { 'source-document': digest('source') }, modelHashes: { target: digest('target') },
    workbookCopies: { 'source-document': { sourceWorkbookModelId: 'source-workbook', sourceSharedModelId: 'source-shared',
      authoredModelHash: digest({}), authoredFileHashes: { 'example.view': digest('definition') } } } };
  assert.deepEqual(parseDashboardSafeCopyIntent({ ...base, deployment }).deployment?.workbookCopies, deployment.workbookCopies);
  assert.throws(() => parseDashboardSafeCopyIntent({ ...base, deployment: { ...deployment, workbookCopies: {} } }));
  assert.throws(() => parseDashboardDeploymentPlanIntent({ ...base, destinations: [{ ...base.destinations[0], workbookCopy: { stagingFolderId: 'delivery' } }] }));
  assert.throws(() => parseDashboardSafeCopyIntent({ ...base, deployment: { ...deployment, workbookCopies: {
    'source-document': { ...deployment.workbookCopies['source-document'], sourceWorkbookModelId: 'source-shared' },
  } } }));
});
