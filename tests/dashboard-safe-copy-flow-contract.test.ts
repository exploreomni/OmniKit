import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const flowSource = readFileSync(
  new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(new URL('../src/pages/MigratePage.tsx', import.meta.url), 'utf8');

test('safe-copy is the default experience and legacy Dashboard Migrator is a lazy internal rollback', () => {
  assert.match(pageSource, /VITE_OMNIKIT_SAFE_COPY_V1_INTERNAL\s*!==\s*'false'/);
  assert.match(pageSource, /VITE_OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL\s*===\s*'true'/);
  assert.match(pageSource, /const LegacyDashboardMigrationWizard\s*=\s*lazy\(/);
  assert.match(pageSource, /legacyRollbackEnabled\s*\?\s*\(/);
  assert.match(pageSource, /<LegacyDashboardMigrationWizard\s*\/>/);
  assert.match(pageSource, /:\s*safeCopyEnabled\s*\?\s*<DashboardSafeCopyFlow\s*\/>\s*:/);
  assert.match(pageSource, /Dashboard migration is temporarily unavailable/);
  assert.match(pageSource, /Safe-copy has been disabled by the local operator/);
  assert.doesNotMatch(pageSource, /import\s*\{\s*DashboardMigrationWizard\s*\}/);
});

test('the default safe-copy experience exposes four accessible screens with readiness before deployment', () => {
  assert.match(
    flowSource,
    /STEP_LABELS\s*=\s*\['Choose dashboards',\s*'Choose destinations',\s*'Review readiness',\s*'Deploy and track'\]\s+as const/,
  );
  assert.equal((flowSource.match(/draft\.step === [012]/g) || []).length, 3);
  assert.match(flowSource, /aria-label="Dashboard move steps"/);
  assert.match(flowSource, /aria-current=\{draft\.step === step \? 'step' : undefined\}/);
  // Focus must move to the step heading on every step change. Assert the
  // ingredients of that behaviour rather than one exact expression: pinning
  // `headingRef.current?.focus()` broke this contract when the focus move was
  // hardened to confirm the focus actually landed.
  assert.match(flowSource, /headingRef\.current/);
  assert.match(flowSource, /\.focus\(\)/);
  assert.match(flowSource, /\}, \[draft\.jobId, draft\.step, loading\]\);/);
  assert.equal((flowSource.match(/ref=\{headingRef\}\s+tabIndex=\{-1\}/g) || []).length, 4);
});

test('the safe-copy flow does not expose legacy destructive or expert controls', () => {
  for (const forbiddenAssignment of [
    /\bemptyFirst\s*:/,
    /\breplaceSameNamed\s*:/,
    /\bdeleteSourceOnSuccess\s*:/,
    /\bpostMigrationActions\s*:/,
    /\bsemanticPatches\s*:/,
    /\bacceptedYaml\s*:/,
    /\bqueryValidationWaivers\s*:/,
  ]) {
    assert.doesNotMatch(flowSource, forbiddenAssignment);
  }
  for (const forbiddenControl of [
    /Advanced/i,
    /Dependency decisions/i,
    /Edit YAML/i,
    /Cleanup source/i,
    /Delete source/i,
    /Replace same-name/i,
    /Waive validation/i,
  ]) {
    assert.doesNotMatch(flowSource, forbiddenControl);
  }
});

test('new starts use reviewed deployment plans and never call legacy migration starts', () => {
  assert.match(flowSource, /\bcreateDashboardDeploymentPlan\b/);
  assert.match(flowSource, /\bdeployDashboardDeploymentPlan\b/);
  assert.match(flowSource, /\bretryDashboardSafeCopyTarget\b/);
  for (const legacyCall of [
    /\bcreateMigrationJob\b/,
    /\bcreateDashboardSafeCopyJob\b/,
    /\bpreviewDashboardMigrationJob\b/,
    /\bvalidateDashboardMigrationPatches\b/,
    /\brunPostMigrationActions\b/,
    /\bretryMigrationJob\b/,
  ]) {
    assert.doesNotMatch(flowSource, legacyCall);
  }
});

test('large inventories are progressively disclosed and asynchronous scope work is abortable', () => {
  assert.match(flowSource, /DASHBOARD_PAGE_SIZE\s*=\s*100/);
  assert.match(flowSource, /filteredDocuments\.slice\(0, visibleDashboardCount\)/);
  assert.match(flowSource, /visibleDocuments\.map\(/);
  assert.match(flowSource, /visibleDocuments\.length < filteredDocuments\.length/);
  assert.match(flowSource, /Show \{Math\.min\(DASHBOARD_PAGE_SIZE/);

  assert.match(flowSource, /sourceConnectionAbortRef/);
  assert.match(flowSource, /dashboardAbortRef/);
  assert.match(flowSource, /destinationAbortRef/);
  assert.match(flowSource, /new AbortController\(\)/);
  assert.match(flowSource, /sourceConnectionAbortRef\.current\?\.abort\(\)/);
  assert.match(flowSource, /dashboardAbortRef\.current\?\.abort\(\)/);
  assert.match(flowSource, /Object\.(?:values|entries)\(destinationAbortRef\.current\).*controller\.abort\(\)/s);
});

test('dashboard selection uses explicit browse or exact lookup with observable cancellable progress', () => {
  assert.match(flowSource, /Add dashboard by link/);
  assert.match(flowSource, /Browse all dashboards/);
  assert.match(flowSource, /lookupInstanceDocument\(draft.sourceId/);
  assert.match(flowSource, /onClick=\{\(\) => void loadDashboards\(\)\}/);
  assert.doesNotMatch(flowSource, /void loadDashboards\(false\)|void loadDashboards\(true\)/);
  assert.match(flowSource, /documentIds: selectedIds/);
  assert.match(flowSource, /'explicit_documents'/);
  assert.match(flowSource, /hasVerifiedDashboardSelection\(documents, draft.selectedDocumentIds, draft.sourceConnectionId\)/);
  assert.match(flowSource, /dashboardScopeRef.current === scope/);
  assert.match(flowSource, /Cancel browsing/);
  assert.match(flowSource, /dashboardBrowseProgress.pages/);
  assert.match(flowSource, /dashboardBrowseProgress.returnedRecords/);
  assert.match(flowSource, /Elapsed: \{dashboardBrowseElapsed\}s/);
  assert.match(flowSource, /Reused complete cached inventory/);
  assert.match(flowSource, /dashboardInventory.cache.fetchedAt/);
  assert.match(flowSource, /Folder details not supplied/);
  assert.doesNotMatch(flowSource, /document.folderPath \|\| 'Top level'/);
});

test('source catalog failures stay instance-scoped in Step 1 and cannot overwrite readiness or a restored source', () => {
  const sourceCatalog = flowSource.slice(flowSource.indexOf('const loadSourceConnections = useCallback'), flowSource.indexOf('// Changing the source cancels work'));
  assert.doesNotMatch(sourceCatalog, /setError\(/);
  assert.match(sourceCatalog, /error: sourceConnectionLoadError\(loadError\)/);
  assert.match(sourceCatalog, /sourceConnectionContextRef\.current\.instanceId === instanceId/);
  assert.match(sourceCatalog, /sourceConnectionContextRef\.current\.step === 0/);
  assert.match(sourceCatalog, /draft\.step !== 0/);
  assert.match(sourceCatalog, /sourcePlanRestoring/);
  assert.match(sourceCatalog, /sourceConnectionAbortRef\.current\?\.abort\(\)/);
  assert.match(sourceCatalog, /sourceConnectionRequestRef\.current \+= 1/);
  assert.match(sourceCatalog, /if \(!sourceConnectionContextRef\.current\.planId\)/);
  assert.match(flowSource, /sourceConnectionCatalog\.instanceId === draft\.sourceId/);
  assert.match(flowSource, /emptyLabel=\{sourceConnectionEmptyLabel\(sourceCatalog\)\}/);
  const picker = flowSource.slice(flowSource.indexOf('ariaLabel="Source connection"'), flowSource.indexOf('<h3 className="text-base font-semibold text-content-primary">Dashboards'));
  assert.match(picker, /sourceCatalog\.error/);
  assert.match(picker, /Retry source connections/);
  assert.match(picker, /separate from dashboard readiness/);
  assert.match(flowSource, /currentPlan\.intent\.source\.instanceId === draft\.sourceId/);
  assert.match(flowSource, /currentPlan\.intent\.source\.connectionId === draft\.sourceConnectionId/);
  assert.match(flowSource, /sameDocumentScope\(currentPlan\.intent\.source\.documentIds, draft\.selectedDocumentIds\)/);
  assert.match(flowSource, /savedSourceScopeMatches \|\| \(verifiedDocumentsScopeRef/);
});

test('active source, submit idempotency, target retry guard, and reduced motion have explicit seams', () => {
  assert.match(flowSource, /useConnection\(\)/);
  assert.match(flowSource, /connection\.instanceId/);
  assert.match(flowSource, /submitGuardRef\.current/);
  assert.match(flowSource, /retryGuardRef\.current/);
  assert.doesNotMatch(flowSource, /className="animate-spin"/);
  assert.ok((flowSource.match(/motion-safe:animate-spin/g) || []).length >= 1);
});

test('restored job evidence is bound to the stored job and request identities before rendering', () => {
  assert.match(flowSource, /isDashboardSafeCopyJobForRequest\(next,\s*draft\.requestId/);
  assert.match(flowSource, /next\.id\s*!==\s*jobId/);
  assert.match(flowSource, /status\s*===\s*404/);
  assert.match(flowSource, /reject_restored_job/);
});

test('exception codes are available only in collapsed technical details', () => {
  const detailsIndex = flowSource.indexOf('<details');
  const summaryIndex = flowSource.indexOf('Technical details', detailsIndex);
  const codeIndex = flowSource.indexOf("target.exceptionCodes.join", detailsIndex);
  assert.ok(detailsIndex >= 0, 'Expected a collapsed details disclosure.');
  assert.ok(summaryIndex > detailsIndex, 'Expected a Technical details summary.');
  assert.ok(codeIndex > summaryIndex, 'Expected exception codes inside Technical details.');
  assert.equal(flowSource.indexOf('target.exceptionCodes.join'), codeIndex, 'Exception codes must not be rendered elsewhere.');
});

test('safe-copy access wording distinguishes direct verification from destination-folder governance', () => {
  assert.match(flowSource, /Source sharing is not copied\./);
  assert.match(flowSource, /Access inherited from the destination folder and business acceptance still require your review/);
  assert.match(flowSource, /Folder \{destinationFolderLabel\(targetScope\?\.targetFolderPath, targetScope\?\.targetFolderId\)\}/);
  assert.doesNotMatch(flowSource, /passed content, access, and query verification/);
});
