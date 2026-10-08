import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import type { DashboardPackagePreview, DashboardPackageSummary, DashboardPackageTargetResult } from '../shared/dashboardPackage';
import type { MigrationJob } from '../src/services/opsConsole';
import { DashboardReadinessReview } from '../src/components/dashboardMigration/DashboardReadinessReview';
import { DashboardPackageConfirmations, DashboardPackageDetails, DashboardPackageResults } from '../src/components/dashboardMigration/DashboardPackageReview';
import { dashboardPackageCopyCanVerify, dashboardPackageCreatedCounts, dashboardPackageDashboardUrl, dashboardPackageHistorySummary, dashboardPackagePreviewMatches, dashboardPackageResultsVerified, dashboardPackageReviewComplete, readDashboardPackageResults, readDashboardPackageHistorySummary, groupDashboardPackageIssues } from '../src/components/dashboardMigration/dashboardPackagePresentation';
import { DashboardPackageHistoryCounts } from '../src/components/dashboardMigration/DashboardPackageHistoryCounts';
import { HistoryJobDetail } from '../src/pages/HistoryPage';
import { DashboardPackageBindingChoices } from '../src/components/dashboardMigration/DashboardPackageBindingChoices';
import { dashboardSafeCopyDraftReducer, createDashboardSafeCopyDraft, dashboardSafeCopyIntentFromDraft } from '../src/components/dashboardMigration/dashboardSafeCopyFlowState';

const summary: DashboardPackageSummary = {
  version: 1, fingerprint: 'example-package-fingerprint',
  documents: [{ sourceDocumentId: 'dashboard', name: 'Example dashboard', localModelCount: 1 }],
  files: [{ fileName: 'example.view', sourceFileName: 'example.view', action: 'add', reason: 'Missing field only.' }], issues: [],
};
const preview: DashboardPackagePreview = { ...summary, files: [{ ...summary.files[0], before: 'dimensions:\n  existing: {}\n', after: 'dimensions:\n  existing: {}\n  added: {}\n' }] };
const binding = { sourceFileName: 'source/example.view', targetFileName: 'example.view', source: { catalog: 'EXAMPLE_SOURCE', schema: 'REPORTING' }, destination: { catalog: 'EXAMPLE_TARGET', schema: 'REPORTING' } };

test('database/schema choice needs reviewed details and explicit unchecked consent', () => {
  for (const reviewed of [false, true]) {
    const html = renderToStaticMarkup(<DashboardPackageBindingChoices mappings={[binding]} approved={[]} reviewed={reviewed} disabled={false} onSave={() => undefined} />);
    assert.match(html, /EXAMPLE_SOURCE/); assert.match(html, /EXAMPLE_TARGET/);
    assert.doesNotMatch(html, /checked=""/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Save database\/schema choice/);
    assert.match(html, /never deploys anything/);
    assert.match(html, /does not verify warehouse data equivalence/);
  }
  const approved = renderToStaticMarkup(<DashboardPackageBindingChoices mappings={[binding]} approved={[binding]} reviewed={true} disabled={false} onSave={() => undefined} />);
  assert.match(approved, /exact bindings are saved/);
  assert.match(approved, /Clear saved database\/schema choices/);
  const withBindings = { ...summary, bindingMappings: [binding] };
  assert.equal(dashboardPackagePreviewMatches(withBindings, preview), false);
  assert.equal(dashboardPackagePreviewMatches(withBindings, { ...preview, bindingMappings: [binding] }), true);
  const saved = plan(withBindings); saved.intent.destinations[0].bindingMappings = [binding];
  const restored = dashboardSafeCopyDraftReducer(createDashboardSafeCopyDraft(), { type: 'restore_plan', plan: saved });
  assert.deepEqual(dashboardSafeCopyIntentFromDraft(restored, []).destinations[0].bindingMappings, [binding]);
  const changed = dashboardSafeCopyDraftReducer(restored, { type: 'choose_source', sourceId: 'different-source', requestId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(changed.destinations[0].bindingMappings, undefined);
});

test('package warnings consolidate duplicate tile and aggregate findings without losing evidence', () => {
  const message = 'Existing catalog differs.';
  const warningSummary = { ...summary, issues: [
    { code: 'DESTINATION_DEFINITION_CONFLICT', reference: 'dashboard/one/example.view', message },
    { code: 'DESTINATION_DEFINITION_CONFLICT', reference: 'dashboard/two/example.view', message },
    { code: 'DEPENDENCY_CONFLICT', reference: 'example.view', message },
    { code: 'SECURITY_REQUIREMENT_CONFLICT', reference: 'model', message: 'Security requires review.' },
  ] };
  const groups = groupDashboardPackageIssues(warningSummary);
  assert.equal(groups.length, 2); assert.equal(groups[0].issues.length, 3);
  assert.deepEqual(groups[0].files, ['example.view']);
  const html = renderToStaticMarkup(<DashboardPackageDetails summary={warningSummary} />);
  assert.equal((html.match(/Existing catalog differs\./g) || []).length, 1);
  assert.match(html, /3 observations/); assert.match(html, /Security requires review/);
  assert.match(html, /dashboard\/one\/example.view/); assert.match(html, /dashboard\/two\/example.view/);
});
const result: DashboardPackageTargetResult = {
  targetId: 'target', status: 'verified', stage: 'readback', message: 'Package readback verified.',
  documents: [{ sourceDocumentId: 'dashboard', name: 'Example dashboard', status: 'verified', documentId: 'copied-document', identifier: 'copied', url: 'https://example.omni.co/dashboards/copied' }],
};
function job(rows: unknown = [result]): MigrationJob {
  return { id: 'job', status: 'succeeded', documentIds: ['dashboard'], targets: [{ id: 'target', destinationInstanceId: 'destination' }], details: { dashboardPackageResults: rows } } as MigrationJob;
}
function plan(packageSummary = summary): DashboardDeploymentPlan {
  return {
    version: 2, packageVersion: 1, id: 'plan', revision: 1, createdAt: 1, updatedAt: 1, sourceHashes: {}, sourceModelHashes: {},
    intent: { profile: 'safe_copy_v1', requestId: '22222222-2222-4222-8222-222222222222', source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] }, destinations: [{ targetId: 'target', instanceId: 'destination', connectionId: 'destination-connection', modelId: 'destination-model' }] },
    targets: [{ targetId: 'target', status: 'ready', package: packageSummary, findings: [{ id: 'local', kind: 'field', reference: 'example.local', message: 'Workbook-local field.', documentIds: ['dashboard'], sourceScope: 'workbook', category: 'included_with_dashboard', causeCode: 'WORKBOOK_FIELD_IDENTIFIED' }], sourceModelIds: ['source-model'], requiredFiles: ['example.view'], requiredFilesByModelId: { 'source-model': ['example.view'] }, checkedAt: 1 }],
  };
}

test('package review keeps local content and additions in one workflow with real inline diffs', () => {
  const html = renderToStaticMarkup(<DashboardPackageDetails summary={summary} preview={preview} onTransform={() => undefined} />);
  const headings = ['Included with dashboards', 'Destination changes', 'Decisions needed'];
  assert.ok(html.indexOf(headings[0]) < html.indexOf(headings[1]) && html.indexOf(headings[1]) < html.indexOf(headings[2]));
  assert.match(html, /1 workbook-local model included/);
  assert.match(html, /Add missing definitions/);
  assert.match(html, /Current destination -&gt; Proposed package/);
  assert.match(html, /existing: \{\}/);
  assert.match(html, /added: \{\}/);
  assert.doesNotMatch(html, /Model Migrator|Workbook copy unavailable/);
  assert.match(html, /not promoted into the shared model/);
});

test('package preview receipts require the exact fingerprint, files, and document origin', () => {
  assert.equal(dashboardPackagePreviewMatches(summary, preview), true);
  assert.equal(dashboardPackagePreviewMatches(summary, { ...preview, fingerprint: 'old' }), false);
  assert.equal(dashboardPackagePreviewMatches(summary, { ...preview, files: [] }), false);
  assert.equal(dashboardPackagePreviewMatches(summary, { ...preview, documents: [{ ...preview.documents[0], sourceDocumentId: 'other' }] }), false);
  assert.equal(dashboardPackageReviewComplete(summary), false);
  assert.equal(dashboardPackageReviewComplete(summary, 'old'), false);
  assert.equal(dashboardPackageReviewComplete(summary, summary.fingerprint), true);
  assert.equal(dashboardPackageReviewComplete({ ...summary, files: [{ ...summary.files[0], action: 'conflict' }] }, summary.fingerprint), false);
  assert.equal(dashboardPackageReviewComplete({ ...summary, issues: [{ code: 'CONFLICT', reference: 'example.view', message: 'Needs decision.' }] }, summary.fingerprint), false);
});

test('package destination selection requires reviewed details without the legacy workbook-copy block', () => {
  for (const fingerprint of ['', 'old', summary.fingerprint]) {
    const html = renderToStaticMarkup(<DashboardReadinessReview plan={plan()} checking={false} selectedTargetIds={['target']}
      destinationLabels={{ target: { instance: 'Example destination', connection: 'Connection', model: 'Model', folder: 'Folder' } }}
      reviewedPackages={{ target: fingerprint }} onPackageReviewed={() => undefined} onCheck={() => undefined} onSelect={() => undefined} onResolve={() => undefined} />);
    const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] || '';
    assert.match(html, /Review package details/);
    assert.doesNotMatch(html, /Workbook copy unavailable|Resolve in Model Migrator/);
    if (fingerprint === summary.fingerprint) {
      assert.doesNotMatch(checkbox, /disabled=""/);
      assert.match(checkbox, /checked=""/);
      assert.match(html, /Package ready to deploy/);
    } else {
      assert.match(checkbox, /disabled=""/);
      assert.doesNotMatch(checkbox, /checked=""/);
    }
  }
});

test('package conflicts expose an optional transformation route and never auto-approve', () => {
  const conflicting: DashboardPackageSummary = { ...summary, files: [{ ...summary.files[0], action: 'conflict' }], issues: [{ code: 'CONFLICT', reference: 'example.view', message: 'Existing definition differs.' }] };
  const html = renderToStaticMarkup(<DashboardPackageDetails summary={conflicting} onTransform={() => undefined} />);
  assert.match(html, /Optional: open Model Migrator separately/);
  assert.match(html, /No conflicting definition will be replaced automatically|no conflicting definition will be replaced automatically/);
  assert.match(html, /Existing definition differs/);
  assert.equal(dashboardPackageReviewComplete(conflicting, summary.fingerprint), false);
  const prHtml = renderToStaticMarkup(<DashboardPackageDetails summary={{ ...summary, requiresPr: true }} />);
  assert.match(prHtml, /stop for that approval/);
});

test('conflict preview shows source comparison separately from unchanged write output', () => {
  const conflicting: DashboardPackageSummary = { ...summary, files: [{ ...summary.files[0], action: 'conflict', reason: 'Catalog differs.' }], issues: [{ code: 'CONFLICT', reference: 'example.view', message: 'Catalog differs.' }] };
  const current = 'catalog: TARGET_EXAMPLE\n';
  const conflictPreview: DashboardPackagePreview = { ...conflicting, files: [{ ...conflicting.files[0], before: current, after: current, sourceComparison: 'catalog: SOURCE_EXAMPLE\n' }] };
  assert.equal(dashboardPackagePreviewMatches(conflicting, conflictPreview), true);
  const html = renderToStaticMarkup(<DashboardPackageDetails summary={conflicting} preview={conflictPreview} />);
  assert.match(html, /Required source definitions \(comparison only\)/);
  assert.match(html, /TARGET_EXAMPLE/);
  assert.match(html, /SOURCE_EXAMPLE/);
  assert.match(html, /will not be deleted/);
  assert.doesNotMatch(html, /No line changes detected|Proposed package/);
  assert.equal(dashboardPackageReviewComplete(conflicting, conflicting.fingerprint), false);
  const legacy = { ...conflictPreview, files: [{ ...conflictPreview.files[0], sourceComparison: undefined }] };
  const legacyHtml = renderToStaticMarkup(<DashboardPackageDetails summary={conflicting} preview={legacy} />);
  assert.match(legacyHtml, /Source comparison is unavailable/);
  assert.doesNotMatch(legacyHtml, /No line changes detected/);
  assert.equal(dashboardPackagePreviewMatches(conflicting, { ...conflictPreview, files: [{ ...conflictPreview.files[0], sourceComparison: 42 as unknown as string }] }), false);
});

test('package confirmations are explicit and source guards bind receipts to review and vault context', () => {
  const html = renderToStaticMarkup(<DashboardPackageConfirmations audience={false} dependencies={false} disabled={false} onChange={() => undefined} />);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /destination folders and their intended audience/);
  assert.match(html, /listed dependency additions/);
  const flow = readFileSync(new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url), 'utf8');
  assert.match(flow, /!confirmDestinationAudience \|\| !confirmDependencies/);
  assert.match(flow, /confirmDestinationAudience: true, confirmDependencies: true/);
  assert.match(flow, /currentPlan\?\.revision, draft.requestId, connection.instanceId, vaultStatus\?\.unlocked, vaultReviewEpoch/);
  assert.match(flow, /packageReviewKeyRef.current !== packageReviewKey/);
  assert.match(flow, /reviewContextKey=\{packageReviewKey\}/);
  const component = readFileSync(new URL('../src/components/dashboardMigration/DashboardPackageReview.tsx', import.meta.url), 'utf8');
  assert.match(component, /controller.signal.aborted \|\| currentIdentity.current !== identity/);
  assert.match(component, /onVaultLocked\(invalidate\)/);
  assert.doesNotMatch(component, /localStorage|sessionStorage/);
});

test('native package results need exact verified coverage and do not reuse legacy safe-copy evidence', () => {
  assert.deepEqual(readDashboardPackageResults(job()), [result]);
  assert.equal(dashboardPackageResultsVerified(job(), [result]), true);
  assert.deepEqual(readDashboardPackageResults(job([{ ...result, documents: [] }])), []);
  assert.deepEqual(readDashboardPackageResults(job([{ ...result, targetId: 'other' }])), []);
  assert.equal(dashboardPackageResultsVerified(job(), []), false);
  const uncertain: DashboardPackageTargetResult = { ...result, status: 'uncertain', message: 'Import outcome needs inspection.', documents: [{ ...result.documents[0], status: 'uncertain' }] };
  assert.equal(dashboardPackageResultsVerified(job([uncertain]), [uncertain]), false);
  const html = renderToStaticMarkup(<DashboardPackageResults results={[uncertain]} destinations={{ target: { label: 'Destination', baseUrl: 'https://example.omni.co' } }} />);
  assert.match(html, /Outcome uncertain/);
  assert.match(html, /before another copy is submitted/);
  assert.doesNotMatch(html, /Open verified dashboard|Retry destination|Move complete/);
  const verified = renderToStaticMarkup(<DashboardPackageResults results={[result]} destinations={{ target: { label: 'Destination', baseUrl: 'https://example.omni.co' } }} />);
  assert.match(verified, /Open verified dashboard/);
  const foreign = renderToStaticMarkup(<DashboardPackageResults results={[result]} destinations={{ target: { label: 'Destination', baseUrl: 'https://different.example' } }} />);
  assert.doesNotMatch(foreign, /Open verified dashboard/);
});

test('package continuation requires fresh confirmation and is absent for uncertain or failed outcomes', () => {
  for (const status of ['waiting_approval', 'needs_review', 'uncertain', 'failed'] as const) {
    const html = renderToStaticMarkup(<DashboardPackageResults results={[{ ...result, status }]} destinations={{ target: { label: 'Destination' } }} onContinue={() => undefined} />);
    if (status === 'waiting_approval' || status === 'needs_review') {
      assert.match(html, /Recheck \/ continue/);
      assert.match(html, /may continue unfinished approved work/);
      assert.match(html, /does not authorize another dashboard copy/);
      assert.doesNotMatch(html, /checked=""/);
      assert.match(html.match(/<button\b[^>]*>[\s\S]*?Recheck \/ continue<\/button>/)?.[0] || '', /disabled=""/);
    } else assert.doesNotMatch(html, /Recheck \/ continue|type="checkbox"/);
  }
});

test('created copy is visible but never verified and recovery requires exact backend eligibility', () => {
  const document = { ...result.documents[0], status: 'needs_review' as const, created: true, canVerifyExistingCopy: true };
  const pending = { ...result, status: 'failed' as const, documents: [document] };
  assert.deepEqual(dashboardPackageCreatedCounts([pending]), { created: 1, verified: 0, pendingVerification: 1 });
  assert.equal(dashboardPackageResultsVerified(job([pending]), [pending]), false);
  assert.equal(dashboardPackageCopyCanVerify(document), true);
  for (const candidate of [{ ...document, canVerifyExistingCopy: false }, { ...document, created: false },
    { ...document, documentId: undefined }, { ...document, identifier: undefined }]) assert.equal(dashboardPackageCopyCanVerify(candidate), false);
  const html = renderToStaticMarkup(<DashboardPackageResults results={[pending]} destinations={{ target: { label: 'Destination', baseUrl: 'https://example.omni.co' } }} onVerifyExisting={() => undefined} onContinue={() => undefined} />);
  assert.match(html, /Dashboard created; verification pending/);
  assert.match(html, /1 dashboard created · 0 verified · 1 awaiting verification/);
  assert.match(html, /Open dashboard/); assert.doesNotMatch(html, /Open verified dashboard|Deployment failed|Recheck \/ continue/);
  assert.match(html, /will not create another copy of this dashboard/);
  assert.match(html, /Remaining approved work for this destination may continue/);
  assert.match(html.match(/<button\b[^>]*>Verify existing copy<\/button>/)?.[0] || '', /disabled=""/);
  const ineligible = renderToStaticMarkup(<DashboardPackageResults results={[{ ...pending, documents: [{ ...document, canVerifyExistingCopy: false }] }]} destinations={{}} onVerifyExisting={() => undefined} />);
  assert.doesNotMatch(ineligible, /Verify existing copy|type="checkbox"/);
});

test('created copy links bind the exact retained identifier and selected destination', () => {
  const document = { ...result.documents[0], status: 'needs_review' as const, created: true };
  assert.equal(dashboardPackageDashboardUrl(document, 'https://example.omni.co'), document.url);
  for (const url of ['https://other.example/dashboards/copied', 'https://example.omni.co/dashboards/another',
    'https://example.omni.co/dashboards/copied?next=other', 'javascript:alert(1)', 'https://user:secret@example.omni.co/dashboards/copied']) {
    assert.equal(dashboardPackageDashboardUrl({ ...document, url }, 'https://example.omni.co'), '');
  }
  assert.equal(dashboardPackageDashboardUrl({ ...document, created: false }, 'https://example.omni.co'), '');
  assert.equal(dashboardPackageDashboardUrl(document, 'https://other.example'), '');
});

test('created copy query failure keeps safe finish verification separate from uncertain-import recovery', () => {
  const pending = { ...result, status: 'needs_review' as const, documents: [{ ...result.documents[0], status: 'needs_review' as const, created: true }] };
  const html = renderToStaticMarkup(<DashboardPackageResults results={[pending]} destinations={{}} onContinue={() => undefined} onVerifyExisting={() => undefined} />);
  assert.match(html, /Finish verification/); assert.match(html, /Existing dashboards will not be reimported/);
  assert.doesNotMatch(html, /Verify existing copy/);
  assert.match(html.match(/<button\b[^>]*>Finish verification<\/button>/)?.[0] || '', /disabled=""/);
  const uncertain = renderToStaticMarkup(<DashboardPackageResults results={[{ ...pending, documents: [{ ...pending.documents[0], status: 'uncertain' }] }]} destinations={{}} onContinue={() => undefined} />);
  assert.doesNotMatch(uncertain, /Finish verification|Recheck \/ continue/);
});

test('history detail retains approved finish verification after an existing-copy query failure', () => {
  const pending = { ...result, status: 'needs_review' as const, documents: [{ ...result.documents[0], status: 'needs_review' as const, created: true }] };
  const saved = { ...job([pending]), sourceId: 'source', status: 'partial' as const, items: [] };
  const props = { job: saved, destinations: {}, onVerifyExisting: () => undefined, verifyingDocumentKeys: [], onContinue: () => undefined, continuingTargetIds: [] };
  const html = renderToStaticMarkup(<HistoryJobDetail {...props} />);
  assert.match(html, /Finish verification/); assert.match(html, /Existing dashboards will not be reimported/);
  assert.match(html.match(/<button\b[^>]*>Finish verification<\/button>/)?.[0] || '', /disabled=""/);
  const running = renderToStaticMarkup(<HistoryJobDetail {...props} continuingTargetIds={['target']} />);
  assert.match(running.match(/<button\b[^>]*>Rechecking package…<\/button>/)?.[0] || '', /disabled=""/);
  const history = readFileSync(new URL('../src/pages/HistoryPage.tsx', import.meta.url), 'utf8');
  assert.match(history, /retryDashboardSafeCopyTarget\(job.id, targetId, crypto.randomUUID\(\), controller.signal\)/);
  assert.match(history, /controller.signal.aborted \|\| verifyRequestRef.current !== controller/);
});

test('running package preparation does not report missing verification evidence as a terminal failure', () => {
  const html = renderToStaticMarkup(<DashboardPackageResults results={[]} destinations={{}} running />);
  assert.match(html, /Preparing dashboard package/); assert.doesNotMatch(html, /incomplete|failed|0 dashboard/);
  const flow = readFileSync(new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url), 'utf8');
  const status = flow.slice(flow.indexOf('const displayedJobStatus'), flow.indexOf('const instanceById'));
  assert.ok(status.indexOf('packageRunning') < status.indexOf('globalEvidenceHold'));
  assert.ok(status.indexOf('pendingVerification') < status.indexOf('globalReconciliationHold'));
});

test('package history uses bounded saved counts and never treats compact omissions as zero', () => {
  const compact = { ...job(), sourceId: '', documentIds: [], targets: [], items: [], details: { safeCopyProfile: 'safe_copy_v1',
    dashboardPackageHistorySummary: { version: 1, dashboardCount: 1, targetCount: 1, stepCount: 3, createdCount: 1, verifiedCount: 0, pendingVerificationCount: 1 } } };
  assert.equal(readDashboardPackageHistorySummary(compact)?.createdCount, 1);
  const html = renderToStaticMarkup(<DashboardPackageHistoryCounts job={compact} />);
  assert.match(html, /1<\/span><br\/>Dashboards created/); assert.match(html, /3<\/span><br\/>Recorded steps/);
  assert.match(html, /1<\/span><br\/>Verification pending/);
  const unknown = renderToStaticMarkup(<DashboardPackageHistoryCounts job={{ ...compact, details: {} }} />);
  assert.match(unknown, /Details not loaded/); assert.doesNotMatch(unknown, /0|Recorded steps/);
  for (const changed of [{ createdCount: 2 }, { stepCount: -1 }, { verifiedCount: 1 }, { pendingVerificationCount: '1' }]) {
    assert.equal(readDashboardPackageHistorySummary({ ...compact, details: { dashboardPackageHistorySummary: { ...compact.details.dashboardPackageHistorySummary, ...changed } } }), null);
  }
  const full = { ...job([{ ...result, status: 'needs_review', documents: [{ ...result.documents[0], status: 'needs_review', created: true }] }]), sourceId: 'source', items: [] };
  assert.equal(dashboardPackageHistorySummary(full)?.pendingVerificationCount, 1);
});

test('existing-copy recovery uses its dedicated route and invalidates late detail or vault responses', () => {
  const service = readFileSync(new URL('../src/services/opsConsole.ts', import.meta.url), 'utf8');
  const route = service.slice(service.indexOf('export async function verifyExistingDashboardPackageCopy'), service.indexOf('export async function createOpsMigrationJob'));
  assert.match(route, /\/verify-import/); assert.match(route, /JSON.stringify\(\{ requestId, sourceDocumentId \}\)/);
  assert.doesNotMatch(route, /\/retry/);
  const flow = readFileSync(new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url), 'utf8');
  assert.match(flow, /controller.signal.aborted \|\| packageVerificationContextRef.current !== context/);
  assert.match(flow, /!document \|\| !dashboardPackageCopyCanVerify\(document\)/);
  const history = readFileSync(new URL('../src/pages/HistoryPage.tsx', import.meta.url), 'utf8');
  assert.match(history, /getMigrationJob\(id, controller.signal\)/);
  assert.match(history, /onClick=\{\(\) => void openJobDetails\(item.job.id\)\}/);
  assert.match(history, /controller.signal.aborted \|\| verifyRequestRef.current !== controller/);
  assert.match(history, /onVaultLocked\(invalidate\)/);
});
