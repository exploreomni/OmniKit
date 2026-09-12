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
  assert.match(checkbox, /aria-describedby="readiness-explanation-target-review"/);
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
