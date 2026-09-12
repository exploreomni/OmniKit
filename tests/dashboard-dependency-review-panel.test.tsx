import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardDependencyReviewPanel } from '../src/components/dashboardMigration/DashboardDependencyReviewPanel';

type Props = React.ComponentProps<typeof DashboardDependencyReviewPanel>;

function fixture(): Props {
  return {
    scope: {
      handoff: { version: 2, source: 'dashboard_deployment_plan', planId: '11111111-1111-4111-8111-111111111111', targetId: 'target' },
      revision: 1, sourceInstanceId: 'source-instance', sourceConnectionId: 'source-connection', sourceModelIds: ['source-model'], documentIds: ['example-dashboard'],
      targetInstanceId: 'target-instance', targetConnectionId: 'target-connection', targetModelId: 'target-model',
      scopeReviewRequired: 'Example scope remains unverified.',
      readiness: {
        targetId: 'target', status: 'unverified', checkedAt: 1,
        sourceModelIds: ['source-model'], requiredFiles: ['example.view'], requiredFilesByModelId: { 'source-model': ['example.view'] },
        findings: [{ id: 'finding', kind: 'field', reference: 'example.value', message: 'This field cannot be traced to an authored source definition.', documentIds: ['example-dashboard'] }],
      },
    },
    source: { id: 'source-instance', label: 'Example source', baseUrl: 'https://source.example.test' },
    target: { id: 'target-instance', label: 'Example destination', baseUrl: 'https://target.example.test' },
    sourceConnection: { name: 'Example source connection', database: 'SOURCE' },
    targetConnection: { name: 'Example destination connection', database: 'DESTINATION' },
    sourceModels: [{ id: 'source-model', name: 'Example source model' }],
    targetModels: [{ id: 'target-model', name: 'Example destination model' }],
    documents: [{ id: 'example-dashboard', identifier: 'example-dashboard', name: 'Example dashboard' }],
    namesUnavailable: false, readiness: null, hasJob: false, onReturn: () => undefined,
  };
}

test('review keeps the dashboard task and labeled source and destination context', () => {
  const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...fixture()} />);
  assert.match(html, /<h1[^>]*>Prepare Example dashboard for Example destination<\/h1>/);
  assert.match(html, /Connection: Example source connection/);
  assert.match(html, /Model: Example destination model/);
  assert.match(html, /Back to dashboard plan/);
  assert.match(html, /Review unresolved definitions/);
  assert.match(html, /Reviewing these findings does not change any dashboards or models/);
  assert.doesNotMatch(html, /Stage and validate migration|Publish validated|Run Translate/);
});

test('details start collapsed and uncertainty never reads as a passed dependency', () => {
  const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...fixture()} />);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /id="dependency-review-findings" hidden=""/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(html, /Not established while verification is incomplete/);
  assert.match(html, /Not yet. Resolve the review items/);
  assert.match(html, /Original diagnostics \(1\)/);
  assert.match(html, /Example scope remains unverified/);
});

test('unresolved fields explain both review paths without guessing semantic equivalence or bypassing readiness', () => {
  const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...fixture()} />);
  assert.match(html, /exact view and field in its workbook/);
  assert.match(html, /does not by itself prove the dashboard is broken/);
  assert.match(html, /Keep intentional workbook-local fields in their original scope/);
  assert.match(html, /Do not promote a local calculation to a shared model merely to migrate it/);
  assert.match(html, /outdated dashboard reference, confirm the intended field and correct the affected reference/);
  assert.match(html, /Do not substitute a similarly named field from another view/);
  assert.match(html, /calculation, level of detail, joins, filters, and access behavior/);
  assert.match(html, /does not automatically edit models or dashboards or bypass readiness/);
  assert.match(html, /New repair controls remain unavailable until this review is resolved/);
  assert.match(html, /id="dependency-review-findings" hidden=""/);
});

test('name lookup failure retains scope without inventing a dashboard identity', () => {
  const props = fixture();
  const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...props} documents={[]} namesUnavailable />);
  assert.match(html, /Prepare 1 selected dashboard for Example destination/);
  assert.match(html, /Dashboard names could not be loaded/);
  assert.match(html, /Dashboard identifiers: example-dashboard/);
  assert.doesNotMatch(html, /Open Example dashboard/);
});

test('recorded jobs are acknowledged without claiming no writes occurred', () => {
  const props = fixture();
  const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...props} hasJob />);
  assert.match(html, /An earlier run is recorded for this plan/);
  assert.match(html, /Run results below/);
  assert.doesNotMatch(html, /No dashboard or model changes|This screen is read-only/);
});

test('passed and stale saved checks route back to readiness without claiming source evidence is missing', () => {
  for (const status of ['ready', 'needs_recheck'] as const) {
    const props = fixture();
    props.scope.readiness.status = status;
    props.scope.readiness.findings = [];
    const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...props} />);
    assert.match(html, /Return to dashboard readiness/);
    assert.doesNotMatch(html, /not yet have enough verified information/);
    assert.match(html, status === 'ready' ? /The saved dashboard check passed/ : /saved dependency review is out of date/);
  }
});

test('source links require a safe tenant root and encode returned dashboard identifiers', () => {
  const props = fixture();
  const html = renderToStaticMarkup(<DashboardDependencyReviewPanel {...props} documents={[{ ...props.documents[0], identifier: 'example/with?query' }]} />);
  assert.match(html, /href="https:\/\/source.example.test\/dashboards\/example%2Fwith%3Fquery"/);
  for (const baseUrl of ['javascript:alert(1)', 'https://user:secret@source.example.test', 'https://source.example.test/path']) {
    const unsafe = renderToStaticMarkup(<DashboardDependencyReviewPanel {...props} source={{ ...props.source!, baseUrl }} />);
    assert.doesNotMatch(unsafe, /Open source Omni|Open Example dashboard/);
  }
});
