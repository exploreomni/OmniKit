import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { DashboardDeploymentPlan, DashboardDeploymentTargetReadiness } from '@/services/dashboardDeploymentPlans';
import { approveDashboardTopicRepair, previewDashboardTopicRepair } from '@/services/dashboardDeploymentPlans';
import type { DashboardTopicJoinPathChoice, DashboardTopicRepairDraftFile, DashboardTopicRepairPreview } from '../../../shared/dashboardTopicRepair';
import { lineDiff } from '@/utils/lineDiff';

/** Full aligned lines, not comparisons between unrelated row offsets. */
export function DashboardRepairFileDiff({ before, after }: { before: string | null; after: string }) {
  const tooLarge = ((before?.split('\n').length || 0) + 1) * (after.split('\n').length + 1) > 2_000_000;
  const parts = useMemo(() => tooLarge ? [] : lineDiff(before || '', after), [before, after, tooLarge]);
  if (tooLarge) return <div>
    <p className="mb-2 text-xs text-content-secondary">Full files are shown without line highlighting because this comparison exceeds the aligned-display limit. No row-by-row equivalence is implied.</p>
    <div className="grid gap-2 lg:grid-cols-2">{[{ label: 'Current destination', value: before }, { label: 'Proposed destination', value: after }].map((column) => <div key={column.label}><h5 className="mb-1 text-xs font-semibold">{column.label}</h5><pre className="max-h-96 overflow-auto rounded border border-border p-3 text-[11px]">{column.value ?? 'New file — not present in the destination.'}</pre></div>)}</div>
  </div>;
  return <div className="max-h-96 overflow-auto rounded border border-border bg-white text-[11px]" role="table" aria-label="Full destination before and after diff">
    <div className="sticky top-0 grid grid-cols-2 border-b border-border bg-surface-secondary font-semibold" role="row"><div role="columnheader" className="p-2">Current destination{before === null ? ' — new file' : ''}</div><div role="columnheader" className="p-2">Proposed destination</div></div>
    {parts.map((part, index) => <div key={index} role="row" className="grid grid-cols-2 font-mono">
      <div role="cell" className={`flex min-w-0 gap-2 border-r border-border px-2 py-0.5 ${part.type === 'remove' ? 'bg-red-50 text-red-900' : 'text-content-secondary'}`}><span className="w-8 shrink-0 text-right text-content-tertiary">{part.oldLineNumber}</span><span className="whitespace-pre-wrap break-words">{part.type !== 'add' ? `${part.type === 'remove' ? '− ' : '  '}${part.text}` : ''}</span></div>
      <div role="cell" className={`flex min-w-0 gap-2 px-2 py-0.5 ${part.type === 'add' ? 'bg-green-50 text-green-900' : 'text-content-secondary'}`}><span className="w-8 shrink-0 text-right text-content-tertiary">{part.newLineNumber}</span><span className="whitespace-pre-wrap break-words">{part.type !== 'remove' ? `${part.type === 'add' ? '+ ' : '  '}${part.text}` : ''}</span></div>
    </div>)}
    {parts.length === 0 && <p className="p-3 text-content-secondary">Both files are empty.</p>}
  </div>;
}

export interface DashboardTopicApprovalCriterion { id: string; label: string; complete: boolean; details?: string[] }

export function dashboardTopicRepairApprovalChecklist(preview: DashboardTopicRepairPreview | null, reviewedFiles: string[], confirmAdditiveOnly: boolean, confirmNewTopicSemantics: boolean, now = Date.now()): DashboardTopicApprovalCriterion[] {
  const changed = preview?.files.filter((file) => file.status === 'new' || file.status === 'additive') || [];
  const inventoryBlockers = preview?.inventoryDiagnostics?.filter((row) => row.severity === 'blocker') || [];
  const conflicts = preview?.files.filter((file) => !['new', 'additive', 'unchanged'].includes(file.status)) || [];
  const duplicateFiles = preview ? new Set(preview.files.map((file) => file.fileName)).size !== preview.files.length : false;
  const remainingFiles = changed.filter((file) => !reviewedFiles.includes(file.fileName)).map((file) => file.fileName);
  const choices = preview?.joinPathChoices || [];
  const unresolvedPaths = choices.filter((choice) => !choice.complete || !choice.selectedPathId || !choice.paths.some((path) => path.id === choice.selectedPathId)).map((choice) => choice.requiredView);
  const invalidSelections = Object.entries(preview?.selectedJoinPaths || {}).filter(([view, id]) => !choices.some((choice) => choice.requiredView === view && choice.selectedPathId === id)).map(([view]) => view);
  return [
    { id: 'preview', label: 'Current evidence-bound preview returned', complete: Boolean(preview?.reviewId && preview.reviewHash) },
    { id: 'inventory', label: 'No blocking source or destination inventory diagnostics', complete: Boolean(preview) && !inventoryBlockers.length, details: inventoryBlockers.map((row) => `${row.side === 'source' ? 'Source' : 'Destination'} · ${row.count} ${row.count === 1 ? 'item' : 'items'}: ${row.message}`) },
    { id: 'base', label: 'Base view established from authored query evidence', complete: Boolean(preview?.baseView) },
    { id: 'joins', label: 'Required authored join paths resolved', complete: Boolean(preview?.baseView) && !unresolvedPaths.length && !invalidSelections.length, details: [...new Set([...unresolvedPaths, ...invalidSelections])].map((view) => `Choose a valid complete path for ${view}, then preview again.`) },
    { id: 'blockers', label: 'Planner safety checks have no unresolved blockers', complete: Boolean(preview) && !preview!.blockers.length, details: preview?.blockers },
    { id: 'topic', label: 'A new or additive topic definition is included', complete: changed.some((file) => file.kind === 'topic') },
    { id: 'conflicts', label: 'No conflicting or duplicate file definitions', complete: Boolean(preview) && !conflicts.length && !duplicateFiles, details: [...conflicts.map((file) => `${file.fileName}: existing definitions cannot be overwritten.`), ...(duplicateFiles ? ['Duplicate file identities require a fresh review.'] : [])] },
    { id: 'files', label: 'Every changed file opened and marked reviewed', complete: Boolean(preview) && changed.length > 0 && !remainingFiles.length, details: remainingFiles.map((name) => `Review ${name}.`) },
    { id: 'additive', label: 'Additions-only confirmation given', complete: confirmAdditiveOnly },
    { id: 'semantics', label: 'New topic semantics explicitly accepted', complete: confirmNewTopicSemantics },
    { id: 'expiry', label: 'Preview has not expired', complete: Boolean(preview && Number.isFinite(preview.expiresAt) && preview.expiresAt > now) },
  ];
}

export function canApproveDashboardTopicRepair(preview: DashboardTopicRepairPreview | null, reviewedFiles: string[], confirmAdditiveOnly: boolean, confirmNewTopicSemantics: boolean, now = Date.now()): boolean {
  return dashboardTopicRepairApprovalChecklist(preview, reviewedFiles, confirmAdditiveOnly, confirmNewTopicSemantics, now).every((item) => item.complete);
}

export function dashboardTopicRepairPreviewMatches(preview: DashboardTopicRepairPreview, expected: { revision: number; targetId: string; sourceTopicName: string; targetTopicName: string; baseView?: string; selectedJoinPaths?: Record<string, string> }): boolean {
  const selections = Object.entries(expected.selectedJoinPaths || {});
  return preview.revision === expected.revision && preview.targetId === expected.targetId && preview.sourceTopicName === expected.sourceTopicName
    && preview.targetTopicName === expected.targetTopicName && (!expected.baseView || preview.baseView === expected.baseView)
    && selections.length === Object.keys(preview.selectedJoinPaths || {}).length && selections.every(([view, id]) => preview.selectedJoinPaths?.[view] === id);
}

export function clearDashboardTopicJoinPathChoice(choices: DashboardTopicJoinPathChoice[], requiredView: string): DashboardTopicJoinPathChoice[] {
  return choices.map((choice) => choice.requiredView === requiredView ? { ...choice, selectedPathId: undefined } : choice);
}

export function DashboardTopicJoinPathReview({ choices, selections, disabled, onChange }: { choices: DashboardTopicJoinPathChoice[]; selections: Record<string, string>; disabled: boolean; onChange: (view: string, pathId: string) => void }) {
  if (!choices.length) return null;
  return <section aria-label="Authored join path choices" className="space-y-3 rounded border border-border p-3 text-xs leading-5">
    <h5 className="font-semibold">Review authored join paths</h5>
    <p>Choose a directed path for each ambiguous dependency, then preview again. Only returned authored relationships are offered; joins are not reversed or invented. A path is a proposed semantic choice, not proof of equivalence to the missing source topic.</p>
    {choices.map((choice) => {
      const selectedId = selections[choice.requiredView] || choice.selectedPathId || '';
      const selected = choice.paths.find((path) => path.id === selectedId);
      return <div key={choice.requiredView}>
        <label className="font-semibold">Path to {choice.requiredView}<select className="input-field mt-1 w-full" value={selectedId} disabled={disabled || !choice.complete || !choice.paths.length} onChange={(event) => onChange(choice.requiredView, event.target.value)}>
          <option value="">Choose an authored path</option>
          {selectedId && !selected && <option value={selectedId}>Previous choice is unavailable — choose again</option>}
          {choice.paths.map((path) => <option key={path.id} value={path.id}>{path.views.join(' → ')} · {path.id.slice(7, 15)}</option>)}
        </select></label>
        {!choice.complete && <p className="text-red-800">The path inventory is incomplete or exceeds the review limit. A selection cannot remove this block.</p>}
        {choice.complete && !choice.paths.length && <p className="text-red-800">No supported authored directed path was returned. An absent or unsupported join cannot be fabricated.</p>}
        {selected && <details className="mt-1"><summary className="cursor-pointer text-content-secondary">Inspect selected relationship values ({selected.edges.length})</summary><p className="mt-1 break-all text-content-secondary">Path identity: {selected.id}</p>{selected.edges.map((edge, index) => <div key={index} className="mt-2"><p className="font-semibold">{edge.fromView} → {edge.toView}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-[11px]">{edge.authoredYaml}</pre></div>)}</details>}
      </div>;
    })}
  </section>;
}

export function DashboardTopicApprovalChecklist({ criteria }: { criteria: DashboardTopicApprovalCriterion[] }) {
  const unmet = criteria.filter((item) => !item.complete);
  return <section className="rounded border border-border p-3 text-xs leading-5" aria-label="Topic repair approval checklist">
    <h5 className="font-semibold">Approval checklist · {unmet.length ? `${unmet.length} criteria unmet` : 'Review criteria met'}</h5>
    <ul className="mt-2 space-y-1">{criteria.map((item) => <li key={item.id}><span className={item.complete ? 'text-content-secondary' : 'font-medium text-amber-950'}>{item.complete ? 'Met' : 'Unmet'} · {item.label}</span>{!item.complete && Boolean(item.details?.length) && <ul className="ml-4 list-disc text-content-secondary">{item.details!.map((detail, index) => <li key={index} className="break-words">{detail}</li>)}</ul>}</li>)}</ul>
    <p className="mt-2 text-content-secondary">These criteria apply to branch staging only. Publication, a fresh dashboard readiness check, and remaining access or workbook-copy requirements are separate; confirmations do not unlock deployment.</p>
  </section>;
}

export function dashboardTopicRepairUnavailableReasons(plan: DashboardDeploymentPlan, target: DashboardDeploymentTargetReadiness, disabled: boolean): string[] {
  const reasons: string[] = [];
  if (target.repairJobId) reasons.push('A model repair job is already linked. Inspect that job before attempting another repair.');
  if (target.deploymentJobId) reasons.push('This destination already has a dashboard deployment job. A new repair cannot be submitted here.');
  if (plan.readinessRun?.status !== 'complete' || target.status === 'needs_recheck') reasons.push('Complete a fresh readiness check for this destination before previewing a repair.');
  if (!target.modelHash) reasons.push('The destination model snapshot is unavailable. Recheck readiness to establish current model evidence.');
  if (!plan.intent.destinations.some((row) => row.targetId === target.targetId)) reasons.push('This destination is not part of the current plan. Return to the saved plan.');
  if (disabled && !reasons.length) reasons.push('Another plan action is in progress or editing is locked. Finish that action before reviewing a repair.');
  return reasons;
}

export function dashboardRepairFileActionLabel(file: Pick<DashboardTopicRepairDraftFile, 'kind' | 'status' | 'fileName'>): string {
  if (file.kind === 'view') {
    const view = file.fileName.endsWith('.query.view') ? 'query view' : 'view';
    if (file.status === 'unchanged') return `Reuse existing ${view}`;
    if (file.status === 'additive') return `Add fields to existing ${view}`;
    if (file.status === 'new') return `Create missing ${view}`;
    return 'Existing view conflict — review required';
  }
  if (file.kind === 'relationship') {
    if (file.status === 'unchanged') return 'Reuse existing relationships';
    if (file.status === 'additive') return 'Add missing relationships';
    if (file.status === 'new') return 'Create missing relationship file';
    return 'Existing relationship conflict — review required';
  }
  if (file.status === 'unchanged') return 'Reuse existing topic';
  if (file.status === 'additive') return 'Add to existing topic';
  if (file.status === 'new') return 'Create missing topic';
  return 'Existing topic conflict — review required';
}

export function DashboardRepairPackageSummary({ preview }: { preview: DashboardTopicRepairPreview }) {
  const blocked = preview.blockers.length > 0 || preview.inventoryDiagnostics?.some((diagnostic) => diagnostic.severity === 'blocker');
  const groups = [
    { kind: 'view', label: 'Views', absent: 'No authored view files established' },
    { kind: 'relationship', label: 'Relationships', absent: blocked ? 'No relationship file established yet' : 'No joins required' },
    { kind: 'topic', label: 'Topic', absent: preview.baseView ? 'Topic definition not established' : 'Pending — choose a base view and preview again' },
  ];
  return <div className="space-y-2 rounded border border-border bg-surface-secondary p-3 text-xs leading-5">
    <p className="font-semibold">Proposed dependency package — nothing has been created in Omni</p>
    <dl className="grid gap-2 sm:grid-cols-3">{groups.map(({ kind, label, absent }) => {
      const files = preview.files.filter((file) => file.kind === kind);
      const creates = files.filter((file) => file.status === 'new').length;
      const extendsExisting = files.filter((file) => file.status === 'additive').length;
      const reuses = files.filter((file) => file.status === 'unchanged').length;
      const conflicts = files.filter((file) => file.status === 'conflict').length;
      return <div key={kind}><dt className="font-semibold">{label}</dt><dd>{files.length ? `Create: ${creates} · Extend: ${extendsExisting} · Reuse: ${reuses} · Conflicts: ${conflicts}` : absent}</dd></div>;
    })}</dl>
    <p>Source view kinds are preserved. New views are proposed only when absent; existing views are reused or receive missing fields. Changes to existing definitions are blocked. Standard views and query views are never converted automatically.</p>
    {preview.baseViewReason && <p>{preview.baseViewReason}</p>}
    {Boolean(preview.reusedRelations?.length) && <p>Existing upstream views to reuse, verified in both model inventories: <span className="break-all">{preview.reusedRelations!.join(', ')}</span>. No new definition is proposed for these views.</p>}
    {preview.files.some((file) => file.kind === 'relationship' && (file.status === 'new' || file.status === 'additive')) && <p>Relationship-file additions are shared model-wide. Review their join conditions and cardinality; the new topic references them through its joins.</p>}
  </div>;
}

export function DashboardTopicInventoryDiagnostics({ preview }: { preview: DashboardTopicRepairPreview }) {
  const diagnostics = preview.inventoryDiagnostics || [];
  if (diagnostics.length === 0) return null;
  const hasBlockers = diagnostics.some((diagnostic) => diagnostic.severity === 'blocker');
  return <div className="space-y-3 rounded border border-border p-3 text-xs leading-5" aria-label="Inventory diagnostics">
    <div><p className="font-semibold">Inventory diagnostics · Review {preview.reviewId.slice(0, 8)}</p><p className="text-content-secondary">{hasBlockers ? 'Approval is blocked until the blocking inventory issues are resolved. Available file diffs remain below for review.' : 'These warnings do not prevent approval. The other review and safety checks still apply.'}</p></div>
    {(['source', 'destination'] as const).map((side) => {
      const rows = diagnostics.filter((diagnostic) => diagnostic.side === side).sort((left, right) => Number(right.severity === 'blocker') - Number(left.severity === 'blocker'));
      if (rows.length === 0) return null;
      return <section key={side} aria-label={`${side === 'source' ? 'Source' : 'Destination'} inventory diagnostics`}>
        <h5 className="font-semibold">{side === 'source' ? 'Source inventory' : 'Destination inventory'}</h5>
        <ul className="mt-1 space-y-2">{rows.slice(0, 6).map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`} className={`rounded p-2 ${diagnostic.severity === 'blocker' ? 'bg-red-50 text-red-900' : 'bg-amber-50 text-amber-950'}`}>
          <p className="font-semibold">{diagnostic.severity === 'blocker' ? 'Blocker' : 'Warning'} · {diagnostic.count} {diagnostic.count === 1 ? 'item' : 'items'}</p>
          <p className="break-words">{diagnostic.message}</p>
          <p className="break-all text-[11px]">Code: {diagnostic.code}</p>
        </li>)}</ul>
        {rows.length > 6 && <p className="mt-1 text-content-secondary">{rows.length - 6} additional diagnostics not shown. Share review {preview.reviewId.slice(0, 8)} when investigating; all blockers still apply.</p>}
      </section>;
    })}
  </div>;
}

export function DashboardTopicRepairReview({ plan, target, sourceTopicName, disabled, onPlanChange, onBusyChange }: {
  plan: DashboardDeploymentPlan;
  target: DashboardDeploymentTargetReadiness;
  sourceTopicName: string;
  disabled: boolean;
  onPlanChange?: (plan: DashboardDeploymentPlan) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [targetTopicName, setTargetTopicName] = useState(sourceTopicName);
  const [baseView, setBaseView] = useState('');
  const [baseViewCandidates, setBaseViewCandidates] = useState<string[]>([]);
  const [joinPathChoices, setJoinPathChoices] = useState<DashboardTopicJoinPathChoice[]>([]);
  const [selectedJoinPaths, setSelectedJoinPaths] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<DashboardTopicRepairPreview | null>(null);
  const [openedFiles, setOpenedFiles] = useState<string[]>([]);
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([]);
  const [confirmAdditiveOnly, setConfirmAdditiveOnly] = useState(false);
  const [confirmNewTopicSemantics, setConfirmNewTopicSemantics] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'approve' | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [staged, setStaged] = useState<{ jobId: string; scope: string } | null>(null);
  const requestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const approvalPendingRef = useRef(false);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const identity = JSON.stringify([plan.id, target.targetId, sourceTopicName]);
  const scope = JSON.stringify([identity, plan.revision]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const unavailableReasons = dashboardTopicRepairUnavailableReasons(plan, target, disabled);
  const unavailable = unavailableReasons.length > 0;

  function clearReview() {
    setPreview(null); setOpenedFiles([]); setReviewedFiles([]);
    setConfirmAdditiveOnly(false); setConfirmNewTopicSemantics(false); setExpired(false);
  }
  function invalidatePreview() {
    previewAbortRef.current?.abort(); requestRef.current += 1;
    clearReview(); setError(''); setBusy(null);
  }
  useEffect(() => {
    previewAbortRef.current?.abort(); requestRef.current += 1;
    clearReview(); setError(''); setBusy(null); setOpen(false);
    setTargetTopicName(sourceTopicName); setBaseView(''); setBaseViewCandidates([]);
    setJoinPathChoices([]); setSelectedJoinPaths({});
    return () => { previewAbortRef.current?.abort(); requestRef.current += 1; };
  }, [scope, sourceTopicName]);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(() => { setExpired(true); setConfirmAdditiveOnly(false); setConfirmNewTopicSemantics(false); }, Math.max(0, Math.min(preview.expiresAt - Date.now(), 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [preview]);

  async function loadPreview() {
    if (unavailable || busy || approvalPendingRef.current || !targetTopicName.trim()) return;
    invalidatePreview();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const request = ++requestRef.current;
    const requestScope = scope;
    const requestedName = targetTopicName.trim();
    const requestedBase = baseView.trim();
    const requestedPaths = { ...selectedJoinPaths };
    setBusy('preview');
    try {
      const result = await previewDashboardTopicRepair(plan.id, { revision: plan.revision, targetId: target.targetId, sourceTopicName, targetTopicName: requestedName, ...(requestedBase ? { baseView: requestedBase } : {}), selectedJoinPaths: requestedPaths }, controller.signal);
      if (controller.signal.aborted || request !== requestRef.current || scopeRef.current !== requestScope) return;
      if (!dashboardTopicRepairPreviewMatches(result, { revision: plan.revision, targetId: target.targetId, sourceTopicName, targetTopicName: requestedName, baseView: requestedBase, selectedJoinPaths: requestedPaths })) throw new Error('The preview did not match the current choices. Preview again before approving.');
      setPreview(result); setBaseViewCandidates(result.baseViewCandidates); setBaseView(result.baseView || requestedBase); setJoinPathChoices(result.joinPathChoices || []); setExpired(result.expiresAt <= Date.now());
    } catch (previewError) {
      if (!controller.signal.aborted && request === requestRef.current && scopeRef.current === requestScope) setError(previewError instanceof Error ? previewError.message : 'The additions could not be previewed.');
    } finally { if (request === requestRef.current) setBusy(null); }
  }

  async function approve() {
    if (unavailable || busy || approvalPendingRef.current || expired || !preview
      || !dashboardTopicRepairPreviewMatches(preview, { revision: plan.revision, targetId: target.targetId, sourceTopicName, targetTopicName: targetTopicName.trim(), baseView: baseView.trim(), selectedJoinPaths })
      || !canApproveDashboardTopicRepair(preview, reviewedFiles, confirmAdditiveOnly, confirmNewTopicSemantics)) return;
    const review = preview!;
    const request = ++requestRef.current;
    const requestScope = scope;
    approvalPendingRef.current = true; setBusy('approve'); setError('');
    onBusyChangeRef.current?.(true);
    try {
      const result = await approveDashboardTopicRepair(plan.id, { revision: plan.revision, targetId: target.targetId, reviewId: review.reviewId, reviewHash: review.reviewHash, confirmAdditiveOnly: true, confirmNewTopicSemantics: true });
      if (request !== requestRef.current || scopeRef.current !== requestScope) return;
      if (result.plan.id !== plan.id || !result.plan.targets.some((row) => row.targetId === target.targetId) || !result.job.id) throw new Error('The staging response did not match this plan. Check the recorded plan and jobs before retrying.');
      clearReview(); setStaged({ jobId: result.job.id, scope: identity });
      onPlanChange?.(result.plan);
    } catch (approvalError) {
      if (request === requestRef.current && scopeRef.current === requestScope) {
        clearReview();
        setError(`${approvalError instanceof Error ? approvalError.message : 'The staging outcome could not be confirmed.'} Review the saved plan and recorded jobs before submitting another approval.`);
      }
    } finally {
      approvalPendingRef.current = false;
      // An in-flight write is not canceled by closing or unmounting its review.
      // Keep the parent's write lock until the request actually settles.
      onBusyChangeRef.current?.(false);
      if (request === requestRef.current) setBusy(null);
    }
  }

  const approvalAllowed = !unavailable && !busy && !expired && Boolean(preview && dashboardTopicRepairPreviewMatches(preview, { revision: plan.revision, targetId: target.targetId, sourceTopicName, targetTopicName: targetTopicName.trim(), baseView: baseView.trim(), selectedJoinPaths })) && canApproveDashboardTopicRepair(preview, reviewedFiles, confirmAdditiveOnly, confirmNewTopicSemantics);
  const stagedHere = staged?.scope === identity;
  const recordedJobId = stagedHere ? staged.jobId : target.repairJobId;
  return <div className="mt-3">
    {unavailableReasons.length > 0 && <ul className="mb-2 space-y-1 text-xs leading-5 text-amber-950" aria-label="Topic repair unavailable reasons">{unavailableReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    {recordedJobId && <div role="status" className="mb-3 rounded border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-950">
      <p className="font-semibold">{stagedHere ? 'Branch-staging job recorded — not published' : 'A model repair job is linked to this destination'}</p>
      <p className="break-all">Job {recordedJobId}. Inspect the job’s result and branch validation before separately reviewing publication. {stagedHere ? 'This approval did not publish a model or copy a dashboard.' : 'Its current execution and publication status have not been checked here.'} Return to this plan and explicitly recheck readiness after reviewed changes are published.</p>
      <Link className="mt-1 inline-block underline" to={`/models/migrate?${new URLSearchParams({ planId: plan.id, targetId: target.targetId })}`}>Review staged model job</Link>
    </div>}
    {!open ? <button type="button" className="btn-secondary btn-sm" disabled={unavailable || approvalPendingRef.current} onClick={() => setOpen(true)}>Create topic and review additions</button> : <section aria-labelledby={headingId} aria-busy={Boolean(busy)} className="space-y-3 rounded-card border border-border bg-white p-4">
      <h4 id={headingId} className="text-sm font-semibold">Review the topic and its dependencies</h4>
      <p className="text-xs leading-5 text-content-secondary">The dashboard references <span className="break-all font-medium">{sourceTopicName}</span>, but an exact authored source topic has not been identified. This is a proposed new topic, not recovery of proven equivalent source semantics. Review its base view, joins, fields, filters, and access. Shared-model additions only; workbook-local definitions and existing-definition replacements are excluded.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold">New destination topic name<input className="input-field mt-1 w-full" value={targetTopicName} disabled={unavailable || busy === 'approve'} onChange={(event) => { invalidatePreview(); setTargetTopicName(event.target.value); setJoinPathChoices([]); setSelectedJoinPaths({}); }} /></label>
        <label className="text-xs font-semibold">Base view{baseViewCandidates.length ? <select className="input-field mt-1 w-full" value={baseView} disabled={unavailable || busy === 'approve'} onChange={(event) => { invalidatePreview(); setBaseView(event.target.value); setJoinPathChoices([]); setSelectedJoinPaths({}); }}><option value="">Choose the topic’s starting view</option>{baseViewCandidates.map((view) => <option key={view} value={view}>{view}</option>)}</select> : <input className="input-field mt-1 w-full" value={baseView} placeholder="Preview to identify available base views" disabled={unavailable || busy === 'approve'} onChange={(event) => { invalidatePreview(); setBaseView(event.target.value); setJoinPathChoices([]); setSelectedJoinPaths({}); }} />}</label>
      </div>
      <p className="text-xs text-content-secondary">Changing a name, base view, or join path discards the preview and every approval. Names are exact; similar names are not automatically substituted.</p>
      <DashboardTopicJoinPathReview choices={joinPathChoices} selections={selectedJoinPaths} disabled={unavailable || busy === 'approve'} onChange={(view, pathId) => {
        invalidatePreview();
        setJoinPathChoices((current) => clearDashboardTopicJoinPathChoice(current, view));
        setSelectedJoinPaths((current) => { const next = { ...current }; if (pathId) next[view] = pathId; else delete next[view]; return next; });
      }} />
      {!preview && joinPathChoices.length > 0 && <p className="text-xs text-amber-950">Preview again to validate the selected paths together and generate their exact file diffs. Previous file approvals no longer apply.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={unavailable || Boolean(busy) || !targetTopicName.trim()} onClick={() => void loadPreview()}>{busy === 'preview' ? 'Reading additions…' : 'Preview additions'}</button>
        <button type="button" className="btn-secondary btn-sm" disabled={busy === 'approve'} onClick={() => { invalidatePreview(); setOpen(false); }}>Cancel review</button>
      </div>
      {busy === 'approve' && <p role="status" className="text-xs text-content-secondary">Submitting the reviewed additions for branch staging. This write request cannot be canceled here.</p>}
      {error && <p role="alert" className="text-xs leading-5 text-red-800">{error}</p>}
      {preview && <>
        <DashboardRepairPackageSummary preview={preview} />
        <DashboardTopicInventoryDiagnostics preview={preview} />
        <p className="text-xs leading-5 text-content-secondary">Destination topic: <span className="break-all font-medium">{preview.targetTopicName}</span> · Base view: {preview.baseView || 'Not established'} · Required views: {preview.requiredViews.join(', ') || 'None established'}</p>
        <DashboardTopicApprovalChecklist criteria={dashboardTopicRepairApprovalChecklist(preview, reviewedFiles, confirmAdditiveOnly, confirmNewTopicSemantics)} />
        {target.status !== 'ready' && <p className="text-xs leading-5 text-amber-950">Dashboard deployment remains disabled for this destination: {target.status === 'unverified' ? 'required source or destination evidence is still unverified.' : target.status === 'needs_recheck' ? 'its choices or evidence require a fresh readiness check.' : 'shared-model differences remain unresolved.'} Branch staging alone does not change this status.</p>}
        {preview.files.map((file) => {
          const changed = file.status === 'new' || file.status === 'additive';
          return <details key={`${preview.reviewId}:${file.fileName}`} className="rounded border border-border" onToggle={(event) => { if (event.currentTarget.open) setOpenedFiles((current) => current.includes(file.fileName) ? current : [...current, file.fileName]); }}>
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold"><span className="break-all">{file.fileName}</span> · {dashboardRepairFileActionLabel(file)}{reviewedFiles.includes(file.fileName) ? ' · Reviewed' : ''}</summary>
            <div className="space-y-3 border-t border-border p-3">
              {file.message && <p className={`text-xs leading-5 ${file.status === 'conflict' ? 'text-red-800' : 'text-content-secondary'}`}>{file.message}</p>}
              <DashboardRepairFileDiff before={file.original} after={file.proposed} />
              {changed && <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={reviewedFiles.includes(file.fileName)} disabled={unavailable || Boolean(busy) || expired || !openedFiles.includes(file.fileName)} onChange={(event) => setReviewedFiles((current) => event.target.checked ? [...new Set([...current, file.fileName])] : current.filter((name) => name !== file.fileName))} />I reviewed this file’s complete proposed changes.</label>}
              {file.status === 'unchanged' && <p className="text-xs text-content-secondary">No change is proposed for this file; it does not require an approval.</p>}
              {file.status === 'conflict' && <p className="text-xs text-red-800">Existing definitions would conflict. There is no approval override for this file.</p>}
            </div>
          </details>;
        })}
        {preview.files.length === 0 && <p className="text-xs text-content-secondary">No additions were returned. There is nothing to approve.</p>}
        <p className="text-xs text-content-secondary">{reviewedFiles.length} changed files reviewed. Open and review every new or additive file before approval.</p>
        <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={confirmAdditiveOnly} disabled={unavailable || Boolean(busy) || expired} onChange={(event) => setConfirmAdditiveOnly(event.target.checked)} />I approve additions only, with no replacement or deletion of existing definitions.</label>
        <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={confirmNewTopicSemantics} disabled={unavailable || Boolean(busy) || expired} onChange={(event) => setConfirmNewTopicSemantics(event.target.checked)} />I reviewed and accept the new topic’s intended semantics; an unavailable source definition does not prove equivalence.</label>
        <p className={`text-xs ${expired ? 'text-red-800' : 'text-content-secondary'}`}>{expired ? 'This preview expired. Preview again and review the new evidence.' : `Preview expires ${new Date(preview.expiresAt).toLocaleString()}. Approval stages a branch only; publishing remains a separate review.`}</p>
        <button type="button" className="btn-primary btn-sm" disabled={!approvalAllowed} onClick={() => void approve()}>Approve additions and stage branch</button>
      </>}
    </section>}
  </div>;
}
