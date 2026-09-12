import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { DashboardDeploymentPlan, DashboardDependencyFinding } from '../shared/dashboardDeploymentPlan';
import { DashboardReadinessReview } from '../src/components/dashboardMigration/DashboardReadinessReview';
import { reviewedExistingTopicMapping } from '../src/components/dashboardMigration/dashboardTopicMappingChoices';
import { createDashboardSafeCopyDraft, dashboardSafeCopyDraftReducer, dashboardSafeCopyIntentFromDraft } from '../src/components/dashboardMigration/dashboardSafeCopyFlowState';
import { groupDashboardReadinessFindings } from '../src/services/dashboardDependencyReview';
import { updateDashboardDeploymentPlan } from '../src/services/dashboardDeploymentPlans';

const planId = '11111111-1111-4111-8111-111111111111';
function plan(): DashboardDeploymentPlan {
  return {
    version: 2, id: planId, revision: 4, createdAt: 1, updatedAt: 1, sourceHashes: {}, sourceModelHashes: {},
    intent: { profile: 'safe_copy_v1', requestId: '22222222-2222-4222-8222-222222222222', source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] }, destinations: [{ targetId: 'target', instanceId: 'destination', connectionId: 'target-connection', modelId: 'target-model' }] },
    targets: [{ targetId: 'target', status: 'unverified', checkedAt: 1, sourceModelIds: ['source-model'], requiredFiles: ['example.view'], requiredFilesByModelId: { 'source-model': ['example.view'] },
      topicChoices: [{ sourceTopicName: 'original_topic', sourceCandidates: [{ name: 'source_reference_only', label: 'Current source topic' }], candidates: [{ name: 'destination_candidate', label: 'Candidate topic' }], documentIds: ['dashboard'] }],
      findings: [
        { id: 'local', kind: 'field', category: 'included_with_dashboard', sourceScope: 'workbook', reference: 'example.local_calculation', message: 'Example workbook-local definition.', documentIds: ['dashboard'] },
        { id: 'topic', kind: 'topic', category: 'topic_mapping_required', sourceScope: 'shared', reference: 'original_topic', message: 'Review the intended topic.', documentIds: ['dashboard'] },
        { id: 'access', kind: 'security', category: 'cannot_verify', sourceScope: 'workbook', reference: 'staging_access', message: 'Effective staging isolation cannot be verified with the available access evidence.', documentIds: ['dashboard'] },
      ],
    }],
  };
}
function render(value = plan(), savingTargetId = '') {
  return renderToStaticMarkup(<MemoryRouter><DashboardReadinessReview plan={value} checking={false} savingTargetId={savingTargetId} selectedTargetIds={[]}
    destinationLabels={{ target: { instance: 'Example destination', connection: 'Example connection', model: 'Example model', folder: 'Example final folder' } }}
    onCheck={() => undefined} onResolve={() => undefined} onSelect={() => undefined} onUpdate={() => undefined} onLoadFolders={() => undefined}
    folderCatalogs={{ target: { folders: [{ id: 'stage-folder', name: 'Example staging folder', path: '/Example staging folder' }], loaded: true, loading: false, complete: true, error: '' } }} /></MemoryRouter>);
}

test('categorized workbook findings are informative and do not enable an unverified destination', () => {
  const value = plan();
  const groups = groupDashboardReadinessFindings(value.targets[0]);
  assert.equal(groups.included_with_dashboard.length, 1);
  assert.equal(groups.topic_mapping_required.length, 1);
  assert.equal(groups.cannot_verify.length, 1);
  assert.deepEqual(groups.model_migrator, []);
  const html = render(value);
  assert.match(html, /Workbook-local definitions identified/);
  assert.match(html, /workbook-copy capability is not verified/);
  assert.match(html, /Effective staging isolation cannot be verified/);
  assert.match(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] || '', /disabled=""/);
  assert.doesNotMatch(html, /(?:Resolve|Review) in Model Migrator<\/button>/);
  assert.equal(value.targets[0].status, 'unverified');
});

test('topic candidates are not auto-selected and source topic references are never destination choices', () => {
  const html = render();
  const select = html.match(/<select[^>]*aria-label="Destination 1 reviewed topic for original_topic"[^>]*>[\s\S]*?<\/select>/)?.[0] || '';
  assert.match(select, /<option value="" selected="">Choose an existing destination topic/);
  assert.match(select, /destination_candidate/);
  assert.doesNotMatch(select, /source_reference_only/);
  assert.match(html, /Current source topics for reference/);
  assert.match(html, /source_reference_only/);
  assert.match(html, /Choosing a destination topic does not resolve missing source evidence/);
});

test('unavailable workbook-copy capability hides staging actions and preserves a saved choice read-only', () => {
  const value = plan();
  value.intent.destinations[0].workbookCopy = { stagingFolderId: 'saved-stage-folder' };
  const html = render(value);
  assert.doesNotMatch(html, /aria-label="Destination 1 workbook staging folder"|Reload staging folders/);
  assert.match(html, /Workbook-local copy is unavailable/);
  assert.match(html, /Choosing a folder or confirming privacy would not remove this block/);
  assert.match(html, /Previously saved staging folder: saved-stage-folder/);
  assert.match(html, /preserved, not verified or used for a copy/);
  assert.match(html, /not a finding that this tenant denied access/);
  assert.match(html, /What must be verified before automatic copying is available/);
  assert.match(html, /Production copy adapter — not verified/);
  assert.match(html, /Staging and delivery access proof — not verified/);
  assert.match(html, /New workbook-file conflict protection — not verified/);
  assert.match(html, /Content migration API — Beta/);
  assert.match(html, /href="https:\/\/docs\.omni\.co\/api\/content-migration\/import-dashboard"/);
  assert.match(html, /an acknowledgement here cannot enable automatic copying/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 1, 'Only the disabled deployment-selection checkbox is present.');
});

test('plan controls remain disabled during save, a submitted deployment, or an unresolved linked repair', () => {
  for (const setup of ['saving', 'deployment', 'repair'] as const) {
    const value = plan();
    if (setup === 'deployment') value.targets[0].deploymentJobId = 'existing-deployment';
    if (setup === 'repair') { value.targets[0].repairJobId = 'existing-repair'; value.targets[0].status = 'needs_recheck'; }
    const html = render(value, setup === 'saving' ? 'target' : '');
    assert.match(html.match(/<select[^>]*aria-label="Destination 1 reviewed topic for original_topic"[^>]*>/)?.[0] || '', /disabled=""/);
  }
});

test('exact reviewed mapping preserves other decisions and rejects similar-name substitutions', () => {
  const current = [{ sourceTopicName: 'other', action: 'map_existing' as const, targetTopicName: 'other_target' }];
  assert.deepEqual(reviewedExistingTopicMapping(current, 'source', 'target', ['target']), [...current, { sourceTopicName: 'source', action: 'map_existing', targetTopicName: 'target' }]);
  assert.throws(() => reviewedExistingTopicMapping(current, 'source', 'TARGET', ['target']), /exact topic/);
  assert.deepEqual(reviewedExistingTopicMapping([...current, { sourceTopicName: 'source', action: 'map_existing', targetTopicName: 'target' }], 'source', '', ['target']), current);
});

test('unknown finding categories stay in cannot-verify and never become included evidence', () => {
  const target = plan().targets[0];
  target.findings = [{ id: 'unknown', kind: 'field', reference: 'example.value', message: 'Unclassified reason.', documentIds: ['dashboard'], category: 'future_category' } as unknown as DashboardDependencyFinding];
  const groups = groupDashboardReadinessFindings(target);
  assert.equal(groups.cannot_verify.length, 1);
  assert.equal(groups.included_with_dashboard.length, 0);
});

test('plan PATCH includes reviewed revision and choices without triggering a recheck', async (t) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({ plan: plan() }), { headers: { 'Content-Type': 'application/json' } });
  });
  const signal = new AbortController().signal;
  const patch = { revision: 4, targetId: 'target', topicMappings: [{ sourceTopicName: 'source', action: 'map_existing' as const, targetTopicName: 'target' }], workbookCopy: { stagingFolderId: 'stage-folder' } };
  await updateDashboardDeploymentPlan(planId, patch, signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/migration-jobs/deployment-plans/${planId}`);
  assert.equal(calls[0].init?.method, 'PATCH');
  assert.equal(calls[0].init?.signal, signal);
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), patch);
});

test('restored staging and topic choices survive a final-folder edit but not another instance', () => {
  const value = plan();
  value.intent.destinations[0].workbookCopy = { stagingFolderId: 'stage-folder' };
  value.intent.destinations[0].topicMappings = [{ sourceTopicName: 'source', action: 'map_existing', targetTopicName: 'target' }];
  let draft = dashboardSafeCopyDraftReducer(createDashboardSafeCopyDraft(), { type: 'restore_plan', plan: value });
  draft = dashboardSafeCopyDraftReducer(draft, { type: 'update_destination', targetId: 'target', patch: { folderId: 'new-final-folder', folderPath: '/New final folder' }, requestId: '33333333-3333-4333-8333-333333333333' });
  const intent = dashboardSafeCopyIntentFromDraft(draft, []);
  assert.deepEqual(intent.destinations[0].workbookCopy, { stagingFolderId: 'stage-folder' });
  assert.deepEqual(intent.destinations[0].topicMappings, value.intent.destinations[0].topicMappings);
  draft = dashboardSafeCopyDraftReducer(draft, { type: 'update_destination', targetId: 'target', patch: { instanceId: 'another-instance' }, requestId: '44444444-4444-4444-8444-444444444444' });
  assert.equal(draft.destinations[0].workbookCopy, undefined);
  assert.equal(draft.destinations[0].topicMappings, undefined);
});

test('opening a saved plan does not automatically recheck unchanged Model Migrator context', () => {
  const source = readFileSync(new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url), 'utf8');
  const restore = source.slice(source.indexOf('const restored = await getDashboardDeploymentPlan'), source.indexOf('// Reopening a plan restores'));
  assert.match(restore, /const response = restored/);
  assert.doesNotMatch(restore, /recheckDashboardDeploymentPlan/);
  const returnToPlan = source.slice(source.indexOf('async function returnToPlan()'), source.indexOf('function goToStep('));
  assert.match(returnToPlan, /getDashboardDeploymentPlan/);
  assert.doesNotMatch(returnToPlan, /recheckDashboardDeploymentPlan/);
});
