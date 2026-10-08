import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { previewDashboardPackage, type DashboardPackagePreview, type DashboardPackageSummary, type DashboardPackageTargetResult } from '@/services/dashboardDeploymentPlans';
import { onVaultChanged, onVaultLocked } from '@/services/vaultEvents';
import { DiffView } from './DiffView';
import { dashboardPackageCopyCanVerify, dashboardPackageCopyCreated, dashboardPackageCreatedCounts, dashboardPackageDashboardUrl, dashboardPackagePreviewMatches, FILE_ACTIONS, groupDashboardPackageIssues } from './dashboardPackagePresentation';
import type { DashboardPackageBindingMapping } from '../../../shared/dashboardPackageBindings';
import { DashboardPackageBindingChoices } from './DashboardPackageBindingChoices';

export function DashboardPackageDetails({ summary, preview, onTransform, disabled = false }: {
  summary: DashboardPackageSummary;
  preview?: DashboardPackagePreview;
  onTransform?: () => void;
  disabled?: boolean;
}) {
  const reviewed = preview && dashboardPackagePreviewMatches(summary, preview) ? preview : undefined;
  const conflicts = summary.files.filter((file) => file.action === 'conflict');
  const issueGroups = groupDashboardPackageIssues(summary);
  return <div className="space-y-4">
    <section aria-label="Included with dashboards">
      <h4 className="text-sm font-semibold text-content-primary">Included with dashboards</h4>
      <p className="mt-1 text-xs leading-5 text-content-secondary">The package carries the dashboard and its workbook-local definitions together. Local definitions stay local; they are not promoted into the shared model.</p>
      <ul className="mt-2 space-y-2">{summary.documents.map((document) => <li key={document.sourceDocumentId} className="rounded-card border border-border bg-white p-3 text-xs">
        <p className="break-words font-medium text-content-primary">{document.name}</p>
        <p className="mt-1 text-content-secondary">{document.localModelCount} workbook-local model{document.localModelCount === 1 ? '' : 's'} included</p>
      </li>)}</ul>
    </section>
    <section aria-label="Destination changes">
      <h4 className="text-sm font-semibold text-content-primary">Destination changes</h4>
      <p className="mt-1 text-xs leading-5 text-content-secondary">Only the missing items listed below are proposed for addition. Existing destination definitions are retained; conflicts require a decision before deployment.</p>
      {summary.requiresPr && <p className="mt-2 text-xs leading-5 text-amber-950">This destination requires a model approval. Deployment will stop for that approval before continuing with the dashboards.</p>}
      {summary.files.length === 0 ? <p className="mt-2 text-xs text-content-secondary">No shared-model file changes are proposed.</p> : <ul className="mt-2 space-y-3">{summary.files.map((file, index) => {
        const diff = reviewed?.files.find((row) => row.fileName === file.fileName && row.sourceFileName === file.sourceFileName && row.action === file.action);
        return <li key={`${file.sourceFileName}:${file.fileName}:${index}`} className="rounded-card border border-border bg-white p-3">
          <p className="break-all text-xs font-semibold text-content-primary">{file.fileName} · {FILE_ACTIONS[file.action]}</p>
          <p className="mt-1 break-all text-xs text-content-secondary">Source: {file.sourceFileName}</p>
          {file.reason && <p className="mt-1 text-xs leading-5 text-content-secondary">{file.reason}</p>}
          {diff && file.action === 'conflict' && <>
            <p className="mt-2 text-xs leading-5 text-amber-900">Comparison only — no changes are approved. Destination-only definitions omitted from the source requirements will not be deleted.</p>
            {diff.sourceComparison !== undefined || diff.after !== diff.before
              ? <DiffView before={diff.before} after={diff.sourceComparison ?? diff.after} beforeLabel="Current destination"
                afterLabel={diff.sourceComparison !== undefined ? 'Required source definitions (comparison only)' : 'Blocked additions (not approved)'} emptyLabel="No existing destination content." className="mt-3" />
              : <p className="mt-2 text-xs text-content-secondary">No file write is proposed. Source comparison is unavailable; recheck to load current conflict details.</p>}
          </>}
          {diff && file.action !== 'reuse' && file.action !== 'conflict' && <DiffView before={diff.before} after={diff.after} beforeLabel="Current destination" afterLabel="Proposed package" emptyLabel="No existing destination content." className="mt-3" />}
          {!diff && file.action !== 'reuse' && <p className="mt-2 text-xs text-content-secondary">Load package details below to inspect the real before-and-after contents.</p>}
        </li>;
      })}</ul>}
    </section>
    <section aria-label="Decisions needed">
      <h4 className="text-sm font-semibold text-content-primary">Decisions needed</h4>
      {summary.issues.length === 0 && conflicts.length === 0 ? <p className="mt-1 text-xs leading-5 text-content-secondary">No unresolved package decisions were reported. Review the package and confirm the destination audience before deploying.</p> : <>
        <p className="mt-1 text-xs leading-5 text-amber-900">This destination is held. Resolve these decisions and recheck the package; no conflicting definition will be replaced automatically.</p>
        <ul className="mt-2 space-y-2 text-xs">{issueGroups.map((group, index) => <li key={index} className="rounded-card border border-amber-200 bg-amber-50 p-3">
          <p className="break-words font-semibold text-amber-950">{group.files.length ? `${group.files.length} affected view/file${group.files.length === 1 ? '' : 's'}` : group.issues[0].reference}</p>
          <p className="mt-1 leading-5 text-amber-950">{group.message}</p>
          <details className="mt-2"><summary className="cursor-pointer text-amber-900">Affected files and technical evidence ({group.issues.length} observations)</summary>
            {group.files.length > 0 && <ul className="mt-2 space-y-1">{group.files.map(file => <li key={file} className="break-all">{file}</li>)}</ul>}
            <ul className="mt-2 space-y-2">{group.issues.map((issue, issueIndex) => <li key={issueIndex} className="break-all">{issue.reference} · {issue.code}</li>)}</ul>
          </details>
        </li>)}</ul>
      </>}
      {onTransform && (conflicts.length > 0 || summary.issues.some(issue => issue.code === 'DIALECT_TRANSFORMATION_REQUIRED')) && <button type="button" className="btn-secondary btn-sm mt-3" disabled={disabled} onClick={onTransform}><ExternalLink size={13} aria-hidden="true" />Optional: open Model Migrator separately</button>}
    </section>
  </div>;
}

export function DashboardPackageReview({ planId, revision, targetId, summary, disabled, onReviewed, onTransform, approvedBindings = [], onBindingsChange }: {
  planId: string; revision: number; targetId: string; summary: DashboardPackageSummary; disabled: boolean;
  onReviewed: (targetId: string, fingerprint: string) => void; onTransform?: () => void;
  approvedBindings?: DashboardPackageBindingMapping[];
  onBindingsChange?: (mappings: DashboardPackageBindingMapping[], fingerprint: string) => void;
}) {
  const identity = JSON.stringify([planId, revision, targetId, summary.fingerprint]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const request = useRef<AbortController | null>(null);
  const [loaded, setLoaded] = useState<{ identity: string; preview: DashboardPackagePreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const preview = !disabled && loaded?.identity === identity ? loaded.preview : undefined;
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setLoaded(null); setLoading(false); setError('');
    return () => { request.current?.abort(); };
  }, [identity, disabled]);
  useEffect(() => {
    const invalidate = () => {
      request.current?.abort(); request.current = null;
      setLoaded(null); setLoading(false); setError('Package review expired after a vault change. Reopen the plan after unlocking.');
      onReviewed(targetId, '');
    };
    const stopLocked = onVaultLocked(invalidate);
    const stopChanged = onVaultChanged(invalidate);
    return () => { stopLocked(); stopChanged(); };
  }, [onReviewed, targetId]);
  async function loadPreview() {
    if (disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError(''); setLoaded(null);
    onReviewed(targetId, '');
    try {
      const result = await previewDashboardPackage(planId, revision, targetId, controller.signal);
      if (controller.signal.aborted || currentIdentity.current !== identity) return;
      if (!dashboardPackagePreviewMatches(summary, result)) throw new Error('The package changed or its details were incomplete. Recheck before reviewing it again.');
      setLoaded({ identity, preview: result });
      onReviewed(targetId, result.fingerprint);
    } catch (loadError) {
      if (!controller.signal.aborted && currentIdentity.current === identity) setError(loadError instanceof Error ? loadError.message : 'Package details could not be loaded.');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }
  return <div className="mt-4 space-y-4">
    <DashboardPackageDetails summary={summary} preview={preview} onTransform={onTransform} disabled={disabled || loading} />
    <div className="rounded-card border border-border bg-surface-secondary p-3">
      <button type="button" className="btn-secondary btn-sm" disabled={disabled || loading} onClick={() => void loadPreview()}>{loading && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />}{loading ? 'Loading package details…' : preview ? 'Refresh package details' : 'Review package details'}</button>
      <p className="mt-2 text-xs leading-5 text-content-secondary">{preview ? 'Package details match this review. Nothing has been deployed; confirmation comes next.' : 'Review the package details before including this destination. This read-only check does not deploy or change a model.'}</p>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
    </div>
    {onBindingsChange && <DashboardPackageBindingChoices mappings={summary.bindingMappings || []} approved={approvedBindings}
      reviewed={Boolean(preview)} disabled={disabled || loading} onSave={mappings => onBindingsChange(mappings, summary.fingerprint)} />}
  </div>;
}

const RESULT_LABELS = { verified: 'Verified package', needs_review: 'Review needed', uncertain: 'Outcome uncertain', failed: 'Deployment failed', waiting_approval: 'Awaiting approval' } as const;

export function DashboardPackageConfirmations({ audience, dependencies, disabled, onChange }: {
  audience: boolean; dependencies: boolean; disabled: boolean; onChange: (field: 'audience' | 'dependencies', checked: boolean) => void;
}) {
  return <fieldset className="mt-5 space-y-3 rounded-card border border-border p-4" disabled={disabled}>
    <legend className="px-1 text-sm font-semibold text-content-primary">Confirm deployment</legend>
    <label className="flex items-start gap-3 text-xs leading-5 text-content-secondary"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-omni-600" checked={audience} onChange={(event) => onChange('audience', event.target.checked)} />I have reviewed the selected destination folders and their intended audience. Copied dashboards may be visible there immediately.</label>
    <label className="flex items-start gap-3 text-xs leading-5 text-content-secondary"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-omni-600" checked={dependencies} onChange={(event) => onChange('dependencies', event.target.checked)} />I approve the reviewed dashboard package and its listed dependency additions. Conflicting destination definitions must not be replaced.</label>
  </fieldset>;
}

export function DashboardPackageResults({ results, destinations, onContinue, continuingTargetIds = [], onVerifyExisting, verifyingDocumentKeys = [], disabled = false, running = false }: {
  results: DashboardPackageTargetResult[]; destinations: Record<string, { label: string; baseUrl?: string }>;
  onContinue?: (targetId: string) => void; continuingTargetIds?: string[];
  onVerifyExisting?: (targetId: string, sourceDocumentId: string) => void; verifyingDocumentKeys?: string[]; disabled?: boolean; running?: boolean;
}) {
  const [continuationApproval, setContinuationApproval] = useState<Record<string, boolean>>({});
  if (results.length === 0) return <p className="card p-4 text-sm text-content-secondary" role="status">{running ? 'Preparing dashboard package. Results will appear as each destination advances.' : 'Package results are incomplete. Check the latest job before taking further action; do not submit another copy.'}</p>;
  return <div className="space-y-4">{results.map((result) => {
    const approvalKey = JSON.stringify(result);
    const continuing = continuingTargetIds.includes(result.targetId);
    const counts = dashboardPackageCreatedCounts([result]);
    const busy = disabled || continuing || verifyingDocumentKeys.length > 0;
    const continueExisting = result.status === 'needs_review' && counts.pendingVerification > 0
      && !result.documents.some(document => document.status === 'uncertain' || dashboardPackageCopyCanVerify(document));
    return <article key={result.targetId} className="card space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{destinations[result.targetId]?.label || result.targetId}</h3><StatusChip status={result.status === 'verified' ? 'success' : 'warning'} label={counts.pendingVerification > 0 ? 'Created · verification pending' : RESULT_LABELS[result.status]} /></div>
    <p className="text-xs text-content-secondary">Stage: {result.stage}</p>
    {counts.created > 0 && <p className="text-xs text-content-secondary">{counts.created} dashboard{counts.created === 1 ? '' : 's'} created · {counts.verified} verified · {counts.pendingVerification} awaiting verification</p>}
    {result.message && <p className="text-sm text-content-secondary">{result.message}</p>}
    {result.branchName && <p className="break-all text-xs text-content-secondary">Review branch: {result.branchName}</p>}
    {result.status === 'uncertain' && <p className="text-xs text-amber-950">The outcome must be checked before another copy is submitted. Cancellation or closing this page does not roll back changes.</p>}
    {onContinue && (counts.pendingVerification === 0 || continueExisting) && (result.status === 'waiting_approval' || result.status === 'needs_review') && <div className="space-y-3 rounded-card border border-border bg-surface-secondary p-3">
      <p className="text-xs leading-5 text-content-secondary">{continueExisting ? 'Recheck the retained dashboard copies and finish remaining approved work. Existing dashboards will not be reimported.' : 'Recheck the exact saved package after resolving the reported review or branch approval. This may continue unfinished approved work; it does not authorize another dashboard copy.'}</p>
      <label className="flex items-start gap-3 text-xs leading-5"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-omni-600" checked={Boolean(continuationApproval[approvalKey])} disabled={busy} onChange={(event) => setContinuationApproval({ [approvalKey]: event.target.checked })} />I approve rechecking this package and continuing its unfinished approved work.</label>
      <button type="button" className="btn-secondary btn-sm" disabled={busy || !continuationApproval[approvalKey]} onClick={() => { setContinuationApproval({}); onContinue(result.targetId); }}>{continuing ? 'Rechecking package…' : continueExisting ? 'Finish verification' : 'Recheck / continue'}</button>
    </div>}
    <ul className="space-y-2">{result.documents.map((document) => {
      const url = dashboardPackageDashboardUrl(document, destinations[result.targetId]?.baseUrl);
      const created = dashboardPackageCopyCreated(document);
      const documentKey = JSON.stringify([result.targetId, document.sourceDocumentId]);
      const verifyApprovalKey = `${approvalKey}:${documentKey}`;
      const verifying = verifyingDocumentKeys.includes(documentKey);
      return <li key={document.sourceDocumentId} className="rounded-card border border-border p-3 text-xs">
        <p className="font-semibold">{document.name}</p><p className="mt-1">{document.status === 'verified' ? 'Verified' : created ? 'Dashboard created; verification pending' : document.status === 'uncertain' ? 'Outcome uncertain' : document.status === 'failed' ? 'Not verified' : 'Review needed'}</p>
        {document.message && <p className="mt-1 text-content-secondary">{document.message}</p>}
        {created && document.status !== 'verified' && <p className="mt-2 text-amber-950">The copy exists in the destination. Its remaining setup and validation are not complete; do not create another copy.</p>}
        {url && <a className="btn-secondary btn-sm mt-2" href={url} target="_blank" rel="noreferrer"><ExternalLink size={12} aria-hidden="true" />{document.status === 'verified' ? 'Open verified dashboard' : 'Open dashboard'}</a>}
        {onVerifyExisting && dashboardPackageCopyCanVerify(document) && <div className="mt-3 space-y-3 rounded-card border border-border bg-surface-secondary p-3">
          <p className="leading-5">This will not create another copy of this dashboard. Remaining approved work for this destination may continue.</p>
          <label className="flex items-start gap-3 leading-5"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-omni-600" checked={Boolean(continuationApproval[verifyApprovalKey])} disabled={busy} onChange={event => setContinuationApproval({ [verifyApprovalKey]: event.target.checked })} />I approve verifying this existing copy and continuing the remaining approved work for this destination.</label>
          <button type="button" className="btn-secondary btn-sm" disabled={busy || !continuationApproval[verifyApprovalKey]} onClick={() => { setContinuationApproval({}); onVerifyExisting(result.targetId, document.sourceDocumentId); }}>{verifying && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />}{verifying ? 'Verifying existing copy…' : 'Verify existing copy'}</button>
        </div>}
      </li>;
    })}</ul>
  </article>;
  })}</div>;
}
