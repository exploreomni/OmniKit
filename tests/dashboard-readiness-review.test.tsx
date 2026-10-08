import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardDeploymentPlan, DashboardDeploymentTargetReadiness } from '../shared/dashboardDeploymentPlan';
import { DashboardReadinessReview } from '../src/components/dashboardMigration/DashboardReadinessReview';
import { resolveDashboardDeploymentModelMigratorHandoff, scopeDashboardModelRepairTranslation } from '../src/services/modelMigratorHandoff';
import { dashboardReadinessIsStale, staleDashboardReadiness } from '../src/components/dashboardMigration/dashboardReadinessPresentation';

const planId = '11111111-1111-4111-8111-111111111111';
const targetId = 'target-review';

function plan(patch: Partial<DashboardDeploymentTargetReadiness> = {}): DashboardDeploymentPlan {
  return {
    version: 2, id: planId, revision: 1, createdAt: 1, updatedAt: 1, sourceHashes: {}, sourceModelHashes: {},
    intent: { profile: 'safe_copy_v1', requestId: '22222222-2222-4222-8222-222222222222',
      source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] },
      destinations: [{ targetId, instanceId: 'target', connectionId: 'target-connection', modelId: 'target-model' }],
    },
    targets: [{ targetId, status: 'unverified', findings: [], checkedAt: Date.UTC(2026, 0, 1), sourceModelIds: ['source-model'], requiredFiles: ['base.view'], requiredFilesByModelId: { 'source-model': ['base.view'] }, ...patch }],
  };
}

function render(patch: Partial<DashboardDeploymentTargetReadiness> = {}) {
  return renderToStaticMarkup(<DashboardReadinessReview plan={plan(patch)} checking={false} selectedTargetIds={[]}
    destinationLabels={{ [targetId]: { instance: 'Target instance', connection: 'Target connection', model: 'Target model', folder: 'Top level' } }}
    onCheck={() => undefined} onSelect={() => undefined} onResolve={() => undefined} />);
}

test('unverified dependencies with source scope offer review while deployment remains disabled', () => {
  const html = render();
  const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.match(checkbox, /disabled=""/);
  assert.match(checkbox, /aria-describedby="readiness-explanation-target-review readiness-selection-target-review"/);
  assert.doesNotMatch(checkbox, /\schecked(?:=|\s|>)/);
  assert.match(html, /Review in Model Migrator/);
  assert.doesNotMatch(html, /Resolve in Model Migrator/);
  assert.match(html, /Missing source evidence does not establish that a target dependency is missing/);
  assert.match(html, /workbook-local and inherited semantics/);
});

test('missing source scope or a deployed destination never offers an unverified review handoff', () => {
  for (const patch of [
    { sourceModelIds: [] },
    { requiredFiles: [] },
    { sourceModelIds: [' source-model'] },
    { deploymentJobId: '33333333-3333-4333-8333-333333333333' },
  ]) {
    const html = render(patch);
    assert.doesNotMatch(html, /(?:Review|Resolve) in Model Migrator/);
    assert.match(html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '', /disabled=""/);
  }
  assert.match(render({ sourceModelIds: [] }), /Confirm the dashboard.*source connection and model binding/);
  assert.match(render({ requiredFiles: [] }), /Inspect the source model and dashboard workbook in Omni/);
});

test('identified model changes keep their resolve action and unverified handoffs cannot prepare automatic repair', () => {
  const html = render({ status: 'model_changes_required' });
  assert.match(html, /Resolve in Model Migrator/);
  assert.doesNotMatch(html, /Review in Model Migrator/);
  const scope = resolveDashboardDeploymentModelMigratorHandoff({ version: 2, source: 'dashboard_deployment_plan', planId, targetId }, plan(), [
    { id: 'source', role: 'source' }, { id: 'target', role: 'destination' },
  ]);
  assert.match(scope.scopeReviewRequired || '', /Deployment and automatic model repair are blocked/);
  assert.match(scope.scopeReviewRequired || '', /workbook-local definitions and inherited semantics/);
  assert.match(scope.scopeReviewRequired || '', /resolve the definitions manually in Omni/);
  assert.throws(() => scopeDashboardModelRepairTranslation({ files: [{ fileName: 'base.view' }], checksums: {}, semanticDecisions: [], prompts: [] }, scope, 'source-model'), /automatic model repair are blocked/);
});

test('active readiness shows real stage counters and cancellation without retaining a passed selection', () => {
  const html = renderToStaticMarkup(<DashboardReadinessReview plan={plan({ status: 'ready' })} checking startedAt={Date.now() - 3_000}
    progress={{ type: 'progress', runId: 'example-run', stage: 'destination_evidence', elapsedMs: 2_000, completed: 2, total: 3, targetId }}
    selectedTargetIds={[targetId]} destinationLabels={{ [targetId]: { instance: 'Target instance', connection: 'Connection', model: 'Model', folder: 'Folder' } }}
    onCheck={() => undefined} onCancel={() => undefined} onSelect={() => undefined} onResolve={() => undefined} />);
  assert.match(html, /Reading destination model and access evidence/);
  assert.match(html, /2 of 3 items in this stage/);
  assert.match(html, /s elapsed/);
  assert.match(html, /Cancel check/);
  assert.match(html, /Previous findings are stale and cannot authorize deployment/);
  const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '';
  assert.match(checkbox, /disabled=""/);
  assert.doesNotMatch(checkbox, /\schecked(?:=|\s|>)/);
  assert.doesNotMatch(html, /Dependencies passed the current checks/);
});

test('readiness review orders findings and choices before recheck and destination inclusion', () => {
  const reviewedPlan = plan({
    status: 'model_changes_required',
    findings: [{ id: 'missing-field', kind: 'field', reference: 'example.field', message: 'Review this identified model difference.', documentIds: ['dashboard'] }],
    topicChoices: [{ sourceTopicName: 'example', candidates: [{ name: 'destination_example' }], sourceCandidates: [{ name: 'example' }], documentIds: ['dashboard'] }],
  });
  const secondTargetId = 'target-ready';
  reviewedPlan.targets.push({ ...plan({ status: 'ready' }).targets[0], targetId: secondTargetId });
  reviewedPlan.intent.destinations.push({ ...reviewedPlan.intent.destinations[0], targetId: secondTargetId });
  const html = renderToStaticMarkup(<DashboardReadinessReview plan={reviewedPlan} checking={false} selectedTargetIds={[]}
    destinationLabels={{
      [targetId]: { instance: 'Target instance', connection: 'Target connection', model: 'Target model', folder: 'Top level' },
      [secondTargetId]: { instance: 'Ready instance', connection: 'Ready connection', model: 'Ready model', folder: 'Ready folder' },
    }}
    onCheck={() => undefined} onSelect={() => undefined} onResolve={() => undefined} onUpdate={() => undefined} />);
  const cards = html.match(/<article\b[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, 2);
  for (const card of cards) assert.doesNotMatch(card, /type="checkbox"|Include this destination/);
  const firstCard = cards[0];
  const orderedReview = ['Readiness findings', 'Destination 1 reviewed topic for example', 'Resolve in Model Migrator', '>Checked '];
  let previous = -1;
  for (const item of orderedReview) {
    const position = firstCard.indexOf(item);
    assert.ok(position > previous, `${item} must follow the preceding review content`);
    previous = position;
  }
  const rechecks = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).filter((button) => button.includes('Recheck readiness'));
  assert.equal(rechecks.length, 1);
  const lastCardEnd = html.lastIndexOf('</article>') + '</article>'.length;
  const recheckPosition = html.indexOf(rechecks[0]);
  const countPosition = html.indexOf('0 selected · 2 held');
  const bulkPosition = html.indexOf('Select all ready');
  const inclusionPosition = html.indexOf('aria-label="Deploy destination 1: Target instance"');
  assert.ok(recheckPosition > lastCardEnd);
  assert.ok(countPosition > recheckPosition);
  assert.ok(bulkPosition > countPosition);
  assert.ok(inclusionPosition > bulkPosition);
  const selectionArea = html.slice(lastCardEnd);
  assert.match(selectionArea, /Target connection → Target model → Top level/);
  assert.match(selectionArea, /Ready connection → Ready model → Ready folder/);
  assert.equal((selectionArea.match(/Include this destination/g) || []).length, 2);
  assert.match(selectionArea, /Held: review and verify the model changes above, then recheck readiness/);
  assert.match(selectionArea, /Held until you include this ready destination/);
  const checkboxes = selectionArea.match(/<input\b[^>]*type="checkbox"[^>]*>/g) || [];
  assert.equal(checkboxes.length, 2);
  assert.match(checkboxes[0], /disabled=""/);
  assert.doesNotMatch(checkboxes[1], /disabled=""/);
});

test('bottom destination inclusion preserves saving and model-review guards with visible reasons', () => {
  for (const busyState of [
    { props: { savingTargetId: targetId }, reason: 'Selection is unavailable while reviewed plan choices are saving.' },
    { props: { topicRepairBusy: true }, reason: 'Selection is unavailable while the model review is in progress.' },
  ]) {
    const html = renderToStaticMarkup(<DashboardReadinessReview plan={plan({ status: 'ready' })} checking={false} selectedTargetIds={[targetId]}
      destinationLabels={{ [targetId]: { instance: 'Target instance', connection: 'Connection', model: 'Model', folder: 'Folder' } }}
      onCheck={() => undefined} onSelect={() => undefined} onResolve={() => undefined} {...busyState.props} />);
    const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '';
    assert.match(checkbox, /disabled=""/);
    assert.match(checkbox, /checked=""/);
    assert.ok(html.includes(busyState.reason));
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
    for (const label of ['Recheck readiness', 'Clear selection']) {
      const button = buttons.find((item) => item.includes(label));
      assert.ok(button, `${label} remains visible`);
      assert.match(button, /disabled=""/);
    }
  }
});

test('workbook review presents one scoped cause with affected fields and complete collapsed evidence', () => {
  const fields = Array.from({ length: 6 }, (_, index) => ({
    id: `local-${index}`, kind: 'field' as const, reference: `example.local_${index % 3}`, message: `Original workbook observation ${index}.`,
    documentIds: ['dashboard'], sourceFileName: 'example.view', sourceScope: 'workbook' as const, category: 'included_with_dashboard' as const,
    causeCode: 'WORKBOOK_FIELD_IDENTIFIED', rootCauseId: 'workbook_definitions:dashboard',
  }));
  const findings = [...fields, {
    id: 'copy-capability', kind: 'document' as const, reference: 'workbook_copy_capability', message: 'Original copy prerequisite.',
    documentIds: ['dashboard'], sourceScope: 'workbook' as const, category: 'cannot_verify' as const,
    causeCode: 'WORKBOOK_COPY_PREREQUISITE', rootCauseId: 'workbook_copy_capability',
  }];
  const html = render({ findings });
  assert.match(html, /1 cause groups · 7 observations/);
  assert.match(html, /3 affected fields · 1 selected dashboard · Source scope: Workbook-local/);
  assert.match(html, /Workbook-local definitions were identified, not copied/);
  assert.match(html, /not a finding that the tenant denied access/);
  assert.equal((html.match(/Next action:/g) || []).length, 1);
  assert.match(html, /rechecking alone cannot enable copying here/);
  assert.doesNotMatch(html, /<details[^>]*open=/);
  for (const finding of findings) {
    assert.ok(html.includes(finding.message));
    assert.ok(html.includes(finding.causeCode));
    assert.ok(html.includes(finding.rootCauseId));
  }
  assert.doesNotMatch(html, /(?:Resolve|Review) in Model Migrator<\/button>/);
  assert.match(html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '', /disabled=""/);
  assert.match(html, /Held: automated workbook-local copying is unavailable/);
});

test('readiness presentation distinguishes ready deployment, model review, and unavailable saved workbook copy', () => {
  const readyHtml = render({ status: 'ready' });
  assert.match(readyHtml, /Ready to deploy/);
  assert.doesNotMatch(readyHtml.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '', /disabled=""/);
  const modelHtml = render({ status: 'model_changes_required' });
  assert.match(modelHtml, /Needs model review/);
  const workbookHtml = render({ status: 'ready', findings: [{
    id: 'saved-local', kind: 'field', reference: 'example.local', message: 'Saved workbook evidence.', documentIds: ['dashboard'],
    sourceScope: 'workbook', category: 'included_with_dashboard', causeCode: 'WORKBOOK_FIELD_IDENTIFIED', rootCauseId: 'workbook_definitions:dashboard',
  }] });
  assert.match(workbookHtml, /Workbook copy unavailable/);
  assert.match(workbookHtml, /0 of 1 destinations ready/);
  assert.doesNotMatch(workbookHtml, /Ready to deploy|Dependencies passed the current checks/);
  assert.match(workbookHtml.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '', /disabled=""/);
});

test('typed source evidence issues explain the review action without proposing shared-model repair', () => {
  for (const [code, title] of [
    ['SOURCE_YAML_MALFORMED', 'Source YAML needs a syntax check'],
    ['SOURCE_YAML_UNSUPPORTED_SHAPE', 'Source file structure needs review'],
    ['SOURCE_YAML_UNSUPPORTED_FEATURE', 'Source YAML features need interpretation'],
    ['SOURCE_YAML_LIMIT', 'Source file exceeds the automatic review limit'],
    ['SOURCE_YAML_READ_UNAVAILABLE', 'Source file could not be read'],
    ['WORKBOOK_OVERLAY_PRESERVATION_REQUIRED', 'Workbook settings need preservation review'],
  ]) {
    const html = render({ findings: [{ id: code, kind: 'document', reference: 'source-file', message: 'Original source-file evidence.',
      documentIds: ['dashboard'], sourceFileName: 'example.view', sourceScope: 'workbook', category: 'cannot_verify', causeCode: code }] });
    assert.ok(html.includes(title));
    assert.match(html, /Source scope: Workbook-local/);
    assert.match(html, /Source file: example.view/);
    assert(html.indexOf('Source file: example.view') < html.indexOf('<details'), 'The affected file is visible without expanding the evidence.');
    assert.equal((html.match(/Next action:/g) || []).length, 1);
    assert.doesNotMatch(html, /(?:Resolve|Review) in Model Migrator<\/button>/);
    assert.match(html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '', /disabled=""/);
  }
});

test('canceling or failing a check keeps original evidence but invalidates every previous ready target', () => {
  const previous = plan({ status: 'ready', findings: [{ id: 'original', kind: 'field', reference: 'example.field', message: 'Original evidence.', documentIds: ['dashboard'] }] });
  const stale = staleDashboardReadiness(previous)!;
  assert.equal(stale.targets[0].status, 'needs_recheck');
  assert.equal(stale.targets[0].findings, previous.targets[0].findings);
  assert.equal(previous.targets[0].status, 'ready');
  assert.equal(staleDashboardReadiness(null), null);
  for (const status of ['running', 'canceled', 'timed_out', 'failed'] as const) {
    previous.readinessRun = { id: 'old-run', status, startedAt: 1 };
    assert.equal(dashboardReadinessIsStale(previous), true);
  }
  previous.readinessRun = { id: 'complete-run', status: 'complete', startedAt: 1 };
  assert.equal(dashboardReadinessIsStale(previous), false);
});
