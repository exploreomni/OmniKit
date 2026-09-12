import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { DashboardTopicRepairPreview } from '../shared/dashboardTopicRepair';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import { canApproveDashboardTopicRepair, clearDashboardTopicJoinPathChoice, dashboardRepairFileActionLabel, dashboardTopicRepairApprovalChecklist, dashboardTopicRepairPreviewMatches, dashboardTopicRepairUnavailableReasons, DashboardRepairFileDiff, DashboardRepairPackageSummary, DashboardTopicApprovalChecklist, DashboardTopicInventoryDiagnostics, DashboardTopicJoinPathReview, DashboardTopicRepairReview } from '../src/components/dashboardMigration/DashboardTopicRepairReview';
import { DashboardTargetPlanChoices } from '../src/components/dashboardMigration/DashboardTargetPlanChoices';

function preview(): DashboardTopicRepairPreview {
  return { reviewId: 'example-review', reviewHash: 'example-hash', revision: 2, targetId: 'example-target', expiresAt: 10_000,
    sourceTopicName: 'source_topic', targetTopicName: 'new_topic', baseView: 'example', baseViewCandidates: ['example'], requiredViews: ['example'], blockers: [],
    files: [
      { fileName: 'new_topic.topic', original: null, proposed: 'base_view: example\n', kind: 'topic', status: 'new' },
      { fileName: 'example.view', original: 'fields:\n  existing: {}\n', proposed: 'fields:\n  existing: {}\n  addition: {}\n', kind: 'view', status: 'additive' },
      { fileName: 'relationships', original: 'relationships: []\n', proposed: 'relationships: []\n', kind: 'relationship', status: 'unchanged' },
    ],
  };
}
function plan(): DashboardDeploymentPlan {
  return { version: 2, id: 'example-plan', revision: 2, createdAt: 1, updatedAt: 1, sourceHashes: {}, sourceModelHashes: {},
    readinessRun: { id: 'example-run', status: 'complete', startedAt: 1 },
    intent: { profile: 'safe_copy_v1', requestId: 'example-request', source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] }, destinations: [{ targetId: 'example-target', instanceId: 'destination', connectionId: 'destination-connection', modelId: 'destination-model' }] },
    targets: [{ targetId: 'example-target', status: 'unverified', checkedAt: 1, modelHash: 'example-model-hash', sourceModelIds: ['source-model'], requiredFiles: ['example.view'], requiredFilesByModelId: { 'source-model': ['example.view'] }, findings: [], topicChoices: [{ sourceTopicName: 'source_topic', candidates: [], sourceCandidates: [{ name: 'source_topic_similar' }], documentIds: ['dashboard'] }] }],
  };
}

test('approval requires every changed file and both independent confirmations', () => {
  const value = preview();
  const reviewed = ['new_topic.topic', 'example.view'];
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), true);
  assert.equal(canApproveDashboardTopicRepair(value, ['new_topic.topic'], true, true, 1), false);
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, false, true, 1), false);
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, false, 1), false);
  assert.equal(canApproveDashboardTopicRepair(null, reviewed, true, true, 1), false);
});

test('inventory warnings do not block approval but every inventory blocker does', () => {
  const value = preview();
  const reviewed = ['new_topic.topic', 'example.view'];
  value.inventoryDiagnostics = [{ side: 'source', severity: 'warning', code: 'EXAMPLE_SKIPPED_ENTRY', count: 2, message: 'Some entries were skipped. Review source inventory coverage.' }];
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), true);
  value.inventoryDiagnostics.push({ side: 'destination', severity: 'blocker', code: 'EXAMPLE_AMBIGUOUS_ENTRY', count: 1, message: 'Resolve the ambiguous destination entry before previewing again.' });
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), false);
  assert.deepEqual(value.blockers, [], 'Diagnostic blockers apply independently of the older blocker-message array.');
});

test('inventory diagnostics group source and destination, show counts and actions, and correlate the review', () => {
  const value = preview();
  value.reviewId = '12345678-1234-4321-8123-123456789012';
  value.inventoryDiagnostics = [
    { side: 'source', severity: 'warning', code: 'EXAMPLE_SKIPPED_ENTRY', count: 3, message: 'Review source inventory coverage.' },
    { side: 'destination', severity: 'blocker', code: 'EXAMPLE_AMBIGUOUS_ENTRY', count: 1, message: 'Resolve the destination ambiguity and preview again.' },
  ];
  const html = renderToStaticMarkup(<DashboardTopicInventoryDiagnostics preview={value} />);
  for (const text of ['Source inventory', 'Destination inventory', 'Warning · 3 items', 'Blocker · 1 item', 'Review source inventory coverage.', 'Resolve the destination ambiguity and preview again.', 'Review 12345678', 'Available file diffs remain below']) assert(html.includes(text));
  assert.doesNotMatch(html, /12345678-1234-4321/);
  const summary = renderToStaticMarkup(<DashboardRepairPackageSummary preview={value} />);
  assert.match(summary, /Create: 1 · Extend: 0 · Reuse: 0 · Conflicts: 0/);
  value.files = [];
  assert.match(renderToStaticMarkup(<DashboardRepairPackageSummary preview={value} />), /No relationship file established yet/);
  assert.doesNotMatch(renderToStaticMarkup(<DashboardRepairPackageSummary preview={value} />), /No joins required/);
});

test('inventory diagnostic display is bounded and puts blockers ahead of warnings', () => {
  const value = preview();
  value.inventoryDiagnostics = Array.from({ length: 8 }, (_, index) => ({ side: 'source' as const, severity: 'warning' as const, code: `EXAMPLE_WARNING_${index}`, count: 1, message: `Review inventory category ${index}.` }));
  value.inventoryDiagnostics.push({ side: 'source', severity: 'blocker', code: 'EXAMPLE_BLOCKER', count: 2, message: 'Resolve this blocker before approval.' });
  const html = renderToStaticMarkup(<DashboardTopicInventoryDiagnostics preview={value} />);
  assert.equal((html.match(/<li\b/g) || []).length, 6);
  assert(html.indexOf('Resolve this blocker') < html.indexOf('Review inventory category 0'));
  assert.match(html, /3 additional diagnostics not shown/);
  assert.equal(canApproveDashboardTopicRepair(value, ['new_topic.topic', 'example.view'], true, true, 1), false);
  assert.equal(renderToStaticMarkup(<DashboardTopicInventoryDiagnostics preview={preview()} />), '');
});

test('dependency summary distinguishes proposed files, shared joins, reused views, and a pending topic', () => {
  const value = preview();
  value.files[2].status = 'additive';
  value.reusedRelations = ['warehouse_orders'];
  value.baseViewReason = 'Only orders reaches every required view through authored relationships.';
  const html = renderToStaticMarkup(<DashboardRepairPackageSummary preview={value} />);
  assert.match(html, /nothing has been created in Omni/);
  for (const label of ['Views', 'Relationships', 'Topic', 'shared model-wide', 'warehouse_orders', 'Only orders reaches']) assert(html.includes(label));
  value.baseView = undefined;
  value.files = value.files.filter((file) => file.kind !== 'topic');
  assert.match(renderToStaticMarkup(<DashboardRepairPackageSummary preview={value} />), /Pending — choose a base view and preview again/);
});

test('view action labels distinguish reuse, field additions, missing files, and conflicts without changing source kind', () => {
  for (const [fileName, label] of [['example.view', 'view'], ['nested/example.query.view', 'query view']] as const) {
    assert.equal(dashboardRepairFileActionLabel({ fileName, kind: 'view', status: 'unchanged' }), `Reuse existing ${label}`);
    assert.equal(dashboardRepairFileActionLabel({ fileName, kind: 'view', status: 'additive' }), `Add fields to existing ${label}`);
    assert.equal(dashboardRepairFileActionLabel({ fileName, kind: 'view', status: 'new' }), `Create missing ${label}`);
    assert.equal(dashboardRepairFileActionLabel({ fileName, kind: 'view', status: 'conflict' }), 'Existing view conflict — review required');
  }
  assert.equal(dashboardRepairFileActionLabel({ fileName: 'relationships', kind: 'relationship', status: 'additive' }), 'Add missing relationships');
  assert.equal(dashboardRepairFileActionLabel({ fileName: 'relationships', kind: 'relationship', status: 'unchanged' }), 'Reuse existing relationships');
  assert.equal(dashboardRepairFileActionLabel({ fileName: 'example.topic', kind: 'topic', status: 'new' }), 'Create missing topic');
  assert.equal(dashboardRepairFileActionLabel({ fileName: 'example.topic', kind: 'topic', status: 'conflict' }), 'Existing topic conflict — review required');
});

test('package summary counts creates, extensions, reuse, and conflicts separately', () => {
  const value = preview();
  value.files = [
    ...value.files.filter((file) => file.kind !== 'view'),
    ...(['new', 'additive', 'unchanged', 'conflict'] as const).flatMap((status, index) => Array.from({ length: index + 1 }, (_, entry) => ({
      fileName: `${status}_${entry}${entry % 2 ? '.query.view' : '.view'}`, kind: 'view' as const, status,
      original: status === 'new' ? null : 'dimensions: {}\n', proposed: 'dimensions: {}\n',
    }))),
  ];
  const html = renderToStaticMarkup(<DashboardRepairPackageSummary preview={value} />);
  assert.match(html, /Create: 1 · Extend: 2 · Reuse: 3 · Conflicts: 4/);
  assert.match(html, /Source view kinds are preserved/);
  assert.match(html, /New views are proposed only when absent/);
  assert.match(html, /Changes to existing definitions are blocked/);
  assert.match(html, /Standard views and query views are never converted automatically/);
  assert.doesNotMatch(html, /to add or extend|create.*workaround/i);
});

test('conflicts, blockers, expiry, duplicate files, and all-no-op previews cannot be overridden', () => {
  const reviewed = ['new_topic.topic', 'example.view', 'relationships'];
  const scenarios = [
    { ...preview(), blockers: ['Independent access evidence is unavailable.'] },
    { ...preview(), expiresAt: 1 },
    { ...preview(), expiresAt: Number.NaN },
    { ...preview(), reviewHash: '' },
    { ...preview(), files: preview().files.map((file) => ({ ...file, status: 'conflict' as const })) },
    { ...preview(), files: [preview().files[0], preview().files[0]] },
    { ...preview(), files: [preview().files[2]] },
    { ...preview(), files: [preview().files[1]] },
  ];
  for (const value of scenarios) assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), false);
});

test('preview identity matches exact names, revision, destination, and selected base view', () => {
  const expected = { revision: 2, targetId: 'example-target', sourceTopicName: 'source_topic', targetTopicName: 'new_topic', baseView: 'example' };
  assert.equal(dashboardTopicRepairPreviewMatches(preview(), expected), true);
  for (const patch of [{ revision: 3 }, { targetId: 'other-target' }, { sourceTopicName: 'SOURCE_TOPIC' }, { targetTopicName: 'other_topic' }, { baseView: 'other_view' }]) {
    assert.equal(dashboardTopicRepairPreviewMatches(preview(), { ...expected, ...patch }), false);
  }
});

test('approval checklist identifies independent unmet criteria without treating staging as deployment readiness', () => {
  const value = preview();
  value.baseView = undefined;
  value.blockers = ['An authored join has not been established.'];
  value.inventoryDiagnostics = [{ side: 'destination', severity: 'blocker', code: 'EXAMPLE_BLOCKER', count: 2, message: 'Resolve the destination inventory ambiguity.' }];
  const criteria = dashboardTopicRepairApprovalChecklist(value, ['new_topic.topic'], false, true, 1);
  for (const id of ['inventory', 'base', 'joins', 'blockers', 'files', 'additive']) assert.equal(criteria.find((item) => item.id === id)?.complete, false, id);
  assert.equal(criteria.find((item) => item.id === 'semantics')?.complete, true);
  const html = renderToStaticMarkup(<DashboardTopicApprovalChecklist criteria={criteria} />);
  for (const text of ['Unmet', 'Review example.view.', 'Destination · 2 items', 'Resolve the destination inventory ambiguity.', 'An authored join has not been established.', 'branch staging only', 'confirmations do not unlock deployment']) assert(html.includes(text));
  assert.equal(canApproveDashboardTopicRepair(value, ['new_topic.topic', 'example.view'], true, true, 1), false);
});

test('exact path selections bind preview identity and incomplete or unselected choices prevent approval', () => {
  const value = preview();
  const id = `sha256:${'1'.repeat(64)}`;
  value.joinPathChoices = [{ requiredView: 'dependency', complete: true, paths: [{ id, views: ['example', 'dependency'], edges: [{ fromView: 'example', toView: 'dependency', authoredYaml: 'join_type: always_left\nrelationship_type: many_to_one\non_sql: ${example.id} = ${dependency.id}\n' }] }] }];
  const reviewed = ['new_topic.topic', 'example.view'];
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), false);
  value.selectedJoinPaths = { dependency: id }; value.joinPathChoices[0].selectedPathId = id;
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), true);
  const expected = { revision: value.revision, targetId: value.targetId, sourceTopicName: value.sourceTopicName, targetTopicName: value.targetTopicName, selectedJoinPaths: { dependency: id } };
  assert.equal(dashboardTopicRepairPreviewMatches(value, expected), true);
  assert.equal(dashboardTopicRepairPreviewMatches(value, { ...expected, selectedJoinPaths: {} }), false);
  assert.equal(dashboardTopicRepairPreviewMatches(value, { ...expected, selectedJoinPaths: { dependency: 'different-id' } }), false);
  const html = renderToStaticMarkup(<DashboardTopicJoinPathReview choices={value.joinPathChoices} selections={value.selectedJoinPaths} disabled={false} onChange={() => undefined} />);
  for (const text of ['Path to dependency', 'example → dependency', 'many_to_one', 'always_left', 'Path identity:', 'joins are not reversed or invented']) assert(html.includes(text));
  value.joinPathChoices[0].complete = false;
  assert.equal(canApproveDashboardTopicRepair(value, reviewed, true, true, 1), false);
  const blocked = renderToStaticMarkup(<DashboardTopicJoinPathReview choices={value.joinPathChoices} selections={value.selectedJoinPaths} disabled={false} onChange={() => undefined} />);
  assert.match(blocked, /disabled=""/); assert.match(blocked, /A selection cannot remove this block/);
});

test('clearing a path cannot visually restore a previously selected cached path', () => {
  const id = `sha256:${'2'.repeat(64)}`;
  const choices = [{ requiredView: 'dependency', complete: true, selectedPathId: id, paths: [{ id, views: ['example', 'dependency'], edges: [] }] }];
  const cleared = clearDashboardTopicJoinPathChoice(choices, 'dependency');
  assert.equal(cleared[0].selectedPathId, undefined);
  assert.equal(choices[0].selectedPathId, id, 'The previous server preview is not mutated.');
  const html = renderToStaticMarkup(<DashboardTopicJoinPathReview choices={cleared} selections={{}} disabled={false} onChange={() => undefined} />);
  assert.match(html, /<option value="" selected="">Choose an authored path/);
  assert.doesNotMatch(html, /Inspect selected relationship values/);
});

test('unavailable repair actions explain linked jobs and missing or stale readiness evidence', () => {
  const value = plan();
  assert.deepEqual(dashboardTopicRepairUnavailableReasons(value, value.targets[0], false), []);
  for (const [patch, reason] of [
    [{ repairJobId: 'linked-repair' }, /model repair job is already linked/],
    [{ deploymentJobId: 'linked-deploy' }, /already has a dashboard deployment job/],
    [{ status: 'needs_recheck' as const }, /fresh readiness check/],
    [{ modelHash: undefined }, /model snapshot is unavailable/],
  ] as const) assert.match(dashboardTopicRepairUnavailableReasons(value, { ...value.targets[0], ...patch }, false).join(' '), reason);
  value.readinessRun!.status = 'canceled';
  assert.match(dashboardTopicRepairUnavailableReasons(value, value.targets[0], false).join(' '), /fresh readiness check/);
});

test('full new files are green additions and inserted lines do not misalign unchanged destination lines', () => {
  const newFile = renderToStaticMarkup(<DashboardRepairFileDiff before={null} after={'first: 1\nsecond: 2'} />);
  assert.equal((newFile.match(/bg-green-50 text-green-900/g) || []).length, 2);
  assert.doesNotMatch(newFile, /bg-red-50/);
  assert.match(newFile, /Current destination — new file/);
  assert.match(newFile, /first: 1/);
  assert.match(newFile, /second: 2/);
  const addition = renderToStaticMarkup(<DashboardRepairFileDiff before={'first: 1\nlast: 3'} after={'first: 1\ninserted: 2\nlast: 3'} />);
  assert.equal((addition.match(/bg-green-50 text-green-900/g) || []).length, 1);
  assert.doesNotMatch(addition, /bg-red-50/);
  assert.match(addition, /inserted: 2/);
  assert.equal((addition.match(/last: 3/g) || []).length, 2, 'The unchanged line is retained on both aligned sides.');
});

test('repair opens from an explicit action and existing jobs keep that action unavailable', () => {
  const value = plan();
  for (const kind of ['available', 'disabled', 'repair', 'deployment'] as const) {
    const target = { ...value.targets[0], ...(kind === 'repair' ? { repairJobId: 'existing-repair' } : {}), ...(kind === 'deployment' ? { deploymentJobId: 'existing-deployment' } : {}) };
    const html = renderToStaticMarkup(<MemoryRouter><DashboardTopicRepairReview plan={value} target={target} sourceTopicName="source_topic" disabled={kind === 'disabled'} /></MemoryRouter>);
    assert.match(html, /Create topic and review additions/);
    assert.doesNotMatch(html, /Approve additions and stage branch|<textarea/);
    if (kind === 'available') assert.doesNotMatch(html, /disabled=""/);
    else assert.match(html, /disabled=""/);
    if (kind === 'repair') {
      assert.match(html, /existing-repair/);
      assert.match(html, /Review staged model job/);
      assert.match(html, /current execution and publication status have not been checked here/);
      assert.doesNotMatch(html, /Branch-staging job recorded — not published/);
    }
  }
});

test('an exact authored source candidate hides reconstruction while a similar name does not', () => {
  const value = plan();
  const render = () => renderToStaticMarkup(<DashboardTargetPlanChoices plan={value} target={value.targets[0]} index={0} disabled={false} onUpdate={() => undefined} />);
  assert.match(render(), /Create topic and review additions/);
  value.targets[0].topicChoices![0].sourceCandidates!.push({ name: 'source_topic', fileName: 'source_topic.topic' });
  assert.doesNotMatch(render(), /Create topic and review additions/);
});

test('review lifecycle clears approvals and ignores canceled or superseded responses', () => {
  const source = readFileSync(new URL('../src/components/dashboardMigration/DashboardTopicRepairReview.tsx', import.meta.url), 'utf8');
  assert.match(source, /previewAbortRef\.current\?\.abort\(\); requestRef\.current \+= 1/);
  assert.match(source, /setConfirmAdditiveOnly\(false\); setConfirmNewTopicSemantics\(false\)/);
  assert.match(source, /request !== requestRef\.current \|\| scopeRef\.current !== requestScope/);
  assert.match(source, /disabled=\{busy === 'approve'\}/);
  assert.match(source, /onPlanChange\?\.\(result\.plan\)/);
  assert.match(source, /onBusyChangeRef\.current\?\.\(true\)/);
  assert.match(source, /onBusyChangeRef\.current\?\.\(false\)/);
});

test('dashboard Model Migrator review uses destination bytes, exact token approval, no AI or arbitrary YAML edits', () => {
  const source = readFileSync(new URL('../src/pages/ModelMigratorPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /DashboardRepairFileDiff before=\{file\.targetOriginal\} after=\{editableValue\}/);
  assert.match(source, /readOnly=\{dashboardRepairRequested\}/);
  assert.match(source, /runAi: dashboardRepairRequested \? false : runAiDialectPass/);
  assert.match(source, /file\.aiDraft && !dashboardRepairRequested/);
  assert.match(source, /reviewToken: translationsByModelId\[modelId\]/);
  assert.match(source, /yaml === \(file\.deterministic \|\| file\.translated\)/);
});
