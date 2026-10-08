import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { DashboardDeploymentPlan, DashboardDeploymentTargetUpdate, DashboardReadinessProgressEvent } from '@/services/dashboardDeploymentPlans';
import { StatusChip } from '@/components/ui/StatusChip';
import { canReviewUnverifiedDashboardDependencies } from '@/services/modelMigratorHandoff';
import { DASHBOARD_FINDING_CATEGORY_COPY, groupDashboardReadinessCauses, groupDashboardReadinessFindings } from '@/services/dashboardDependencyReview';
import type { DestinationFolderCatalog } from './useDashboardDestinationFolders';
import { DashboardTargetPlanChoices } from './DashboardTargetPlanChoices';
import { DashboardReadinessProgress } from './DashboardReadinessProgress';
import { dashboardReadinessCauseAction, dashboardReadinessIsStale, dashboardReadinessLabel, dashboardSourceScopeLabel, dashboardWorkbookCopyUnavailable } from './dashboardReadinessPresentation';
import { DashboardPackageReview } from './DashboardPackageReview';
import { dashboardPackageReviewComplete } from './dashboardPackagePresentation';

export function DashboardReadinessReview({ plan, checking, progress, startedAt, onCancel, savingTargetId, selectedTargetIds, destinationLabels, folderCatalogs, onLoadFolders, onUpdate, onCheck, onSelect, onResolve, onPlanChange, topicRepairBusy, onTopicRepairBusyChange, reviewedPackages = {}, onPackageReviewed, reviewContextKey = '' }: {
  plan: DashboardDeploymentPlan | null;
  checking: boolean;
  progress?: DashboardReadinessProgressEvent | null;
  startedAt?: number | null;
  onCancel?: () => void;
  savingTargetId?: string;
  selectedTargetIds: string[];
  destinationLabels: Record<string, { instance: string; connection: string; model: string; folder: string }>;
  folderCatalogs?: Record<string, DestinationFolderCatalog>;
  onLoadFolders?: (targetId: string, forceRefresh?: boolean) => void;
  onUpdate?: (update: DashboardDeploymentTargetUpdate) => void;
  onCheck: () => void;
  onSelect: (targetIds: string[]) => void;
  onResolve: (targetId: string) => void;
  onPlanChange?: (plan: DashboardDeploymentPlan) => void;
  topicRepairBusy?: boolean;
  onTopicRepairBusyChange?: (busy: boolean) => void;
  reviewedPackages?: Record<string, string>;
  onPackageReviewed?: (targetId: string, fingerprint: string) => void;
  reviewContextKey?: string;
}) {
  const busy = checking || Boolean(savingTargetId) || Boolean(topicRepairBusy);
  const stale = checking || dashboardReadinessIsStale(plan);
  const ready = stale ? [] : plan?.targets.filter((target) => target.status === 'ready' && !target.deploymentJobId
    && (target.package ? dashboardPackageReviewComplete(target.package, reviewedPackages[target.targetId]) : !dashboardWorkbookCopyUnavailable(target))) || [];
  const selected = selectedTargetIds.filter((id) => ready.some((target) => target.targetId === id));
  const held = (plan?.targets.length || 0) - selected.length;
  const activeRun = checking && startedAt != null;
  return (
    <div className="space-y-4" aria-busy={busy}>
      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-content-primary">
            {savingTargetId ? 'Saving reviewed plan choices…' : activeRun ? 'Checking deployment readiness' : checking ? 'Restoring saved readiness…' : plan ? `${ready.length} of ${plan.targets.length} destinations ready` : 'Check every destination before deploying'}
          </p>
          <p className="mt-1 text-xs leading-5 text-content-secondary">
            {savingTargetId ? 'Only the saved plan is updated. Recheck readiness after the choices are saved.' : checking ? 'Previous findings are stale and cannot authorize deployment while this request is in progress.' : stale ? 'The saved readiness run did not complete. Previous findings are stale; explicitly recheck before deploying.' : plan ? 'Review the destinations below, recheck after resolving any findings, then choose which ready destinations to include. Held destinations remain in this plan.' : 'Readiness uses the exported dashboard dependencies and current model content.'}
          </p>
          {activeRun && <DashboardReadinessProgress progress={progress} startedAt={startedAt!} targetLabel={progress?.targetId ? destinationLabels[progress.targetId]?.instance : undefined} />}
        </div>
        {activeRun && onCancel && <button type="button" className="btn-secondary shrink-0 justify-center" onClick={onCancel}>Cancel check</button>}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{savingTargetId ? 'Saving plan choices. Deployment controls are unavailable until saving finishes.' : checking ? 'Readiness check in progress.' : plan ? `${ready.length} ready destinations. ${held} held destinations.` : 'Readiness has not been checked.'}</span>
      {plan && (
        <>
          {plan.targets.map((target, index) => {
            const labels = destinationLabels[target.targetId];
            const targetStale = stale || target.status === 'needs_recheck';
            const workbookUnavailable = !target.package && dashboardWorkbookCopyUnavailable(target);
            const packageReviewed = dashboardPackageReviewComplete(target.package, reviewedPackages[target.targetId]);
            const deployable = !targetStale && target.status === 'ready' && !target.deploymentJobId && !workbookUnavailable && packageReviewed;
            const reviewable = canReviewUnverifiedDashboardDependencies(target);
            const explanationId = `readiness-explanation-${target.targetId}`;
            const blockedExplanation = target.deploymentJobId ? 'This destination already has a deployment job.'
              : targetStale ? 'Previous findings are stale and cannot authorize deployment. Complete a new readiness check before selecting this destination.'
              : target.package ? target.package.issues.length > 0 || target.package.files.some((file) => file.action === 'conflict')
                ? 'This package has decisions to resolve below. No conflicting destination definitions will be replaced automatically.'
                : target.status !== 'ready' ? 'This package is held by readiness checks. Review its details and the additional evidence below, then recheck before including this destination.'
                  : 'Review the package details below before including this destination. Missing dependency additions and workbook-local definitions are handled within this dashboard package.'
              : workbookUnavailable ? 'This destination needs workbook-local definitions that this build cannot copy automatically. It remains held; a model repair or plan acknowledgement does not enable workbook copying.'
              : target.status === 'model_changes_required' ? 'Deployment is blocked until the identified model changes are reviewed and verified. Resolve the listed dependencies, then return to recheck this destination.'
              : target.status === 'unverified' ? 'Deployment is blocked because dependency evidence is incomplete or ambiguous. Missing source evidence does not establish that a target dependency is missing.'
              : 'Deployment is blocked until readiness is rechecked against the current source and destination models.';
            const grouped = groupDashboardReadinessFindings(target);
            const legacyFindings = target.findings.every((finding) => !finding.category);
            const modelReviewRelevant = grouped.model_migrator.length > 0 || legacyFindings;
            const editingBlocked = busy || Boolean(target.deploymentJobId) || Boolean(target.repairJobId);
            const causes = groupDashboardReadinessCauses(target.findings);
            return (
              <article key={target.targetId} className={`rounded-card border p-4 sm:p-5 ${deployable ? 'border-green-200 bg-green-50/40' : 'border-border bg-white'}`} aria-labelledby={`readiness-${target.targetId}`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <span id={`readiness-${target.targetId}`} className="block break-words text-sm font-semibold text-content-primary">{index + 1}. {labels?.instance || 'Saved instance'}</span>
                    <span className="mt-1 block break-words text-xs leading-5 text-content-secondary">{labels?.connection || 'Connection'} → {labels?.model || 'Model'} → {labels?.folder || 'Top level'}</span>
                  </div>
                  <StatusChip status={deployable ? 'ready' : 'warning'} label={target.package && !targetStale && !target.deploymentJobId ? deployable ? 'Package ready to deploy' : target.package.issues.length > 0 || target.package.files.some((file) => file.action === 'conflict') ? 'Decisions needed' : 'Review package details' : dashboardReadinessLabel(target, targetStale)} size="xs" />
                </div>
                {deployable ? (
                  <p id={explanationId} className="mt-4 flex items-start gap-2 text-xs leading-5 text-green-900"><CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />{target.package ? 'Package details reviewed. Proposed additions are not yet applied; deployment and verification require your final confirmation.' : 'Dependencies passed the current checks. Dashboard creation and verification run during deployment.'}</p>
                ) : (
                  <p id={explanationId} className="mt-4 flex items-start gap-2 text-xs leading-5 text-content-secondary"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />{blockedExplanation}</p>
                )}
                {target.package && onPackageReviewed && <DashboardPackageReview key={`${reviewContextKey}:${plan.id}:${plan.revision}:${target.targetId}`} planId={plan.id} revision={plan.revision} targetId={target.targetId} summary={target.package} disabled={busy || targetStale || Boolean(target.deploymentJobId)} onReviewed={onPackageReviewed} onTransform={() => onResolve(target.targetId)}
                  approvedBindings={plan.intent.destinations.find(destination => destination.targetId === target.targetId)?.bindingMappings}
                  onBindingsChange={onUpdate ? (bindingMappings, packageFingerprint) => onUpdate({ revision: plan.revision, targetId: target.targetId, bindingMappings, packageFingerprint }) : undefined} />}
                {target.package && target.findings.length > 0 && <details className="mt-3 rounded-card border border-border p-3 text-xs">
                  <summary className="cursor-pointer font-semibold text-content-secondary">Additional readiness evidence ({target.findings.length})</summary>
                  <ul className="mt-2 space-y-3">{target.findings.map((finding, findingIndex) => <li key={`${finding.id}:${findingIndex}`}>
                    <p className="break-words font-medium">{finding.reference}</p><p className="mt-1 leading-5 text-content-secondary">{finding.message}</p>
                    <p>Source scope: {dashboardSourceScopeLabel(finding.sourceScope)}</p>{finding.sourceFileName && <p className="break-all">Source file: {finding.sourceFileName}</p>}
                  </li>)}</ul>
                </details>}
                {!target.package && target.status === 'unverified' && !target.deploymentJobId && modelReviewRelevant && (
                  <p className="mt-2 text-xs leading-5 text-content-secondary">
                    {reviewable ? 'Open the identified model context in Model Migrator. Inspect source model and dashboard workbook definitions in Omni, including workbook-local and inherited semantics. Establish the missing evidence and review any needed model changes, then recheck readiness.'
                      : target.sourceModelIds.length === 0 ? 'Confirm the dashboard’s source connection and model binding, and restore access to the source model. A source model and required files must be identified before Model Migrator can open a scoped review.'
                        : 'Inspect the source model and dashboard workbook in Omni for workbook-local or inherited definitions, and confirm source access. Resolve the missing dependency evidence, then recheck to identify the required files for a scoped Model Migrator review.'}
                  </p>
                )}
                {!target.package && target.findings.length > 0 && (
                  <section className="mt-4 rounded-card border border-border bg-surface-secondary p-3" aria-label={targetStale ? 'Previous findings — stale' : 'Readiness findings'}>
                    <h4 className="text-xs font-semibold text-content-primary">{targetStale ? 'Previous findings — stale' : 'Readiness findings'} ({causes.length} cause groups · {target.findings.length} observations)</h4>
                    <ul className="mt-3 space-y-3">{causes.map((cause) => {
                      const action = dashboardReadinessCauseAction(cause);
                      const sourceFiles = [...new Set(cause.findings.flatMap((finding) => finding.sourceFileName ? [finding.sourceFileName] : []))];
                      return <li key={cause.id} className="rounded-card border border-border bg-white p-3 text-xs leading-5">
                        <p className="font-semibold text-content-primary">{action.title}</p>
                        <p className="mt-1 text-content-secondary">{cause.fieldReferences.length > 0 && `${cause.fieldReferences.length} affected field${cause.fieldReferences.length === 1 ? '' : 's'} · `}{cause.documentIds.length} selected dashboard{cause.documentIds.length === 1 ? '' : 's'} · Source scope: {dashboardSourceScopeLabel(cause.sourceScope)}</p>
                        {sourceFiles.length > 0 && <p className="mt-1 break-all text-content-secondary">{sourceFiles.length === 1 ? `Source file: ${sourceFiles[0]}` : `${sourceFiles.length} source files — see original evidence below`}</p>}
                        <p className="mt-1 break-words text-content-secondary">{action.description}</p>
                        <p className="mt-2 text-content-primary"><span className="font-semibold">Next action: </span>{action.nextAction}</p>
                        <details className="mt-3">
                          <summary className="cursor-pointer font-medium text-content-secondary">View affected references and original evidence ({cause.findings.length} observations)</summary>
                          <p className="mt-2 break-words text-content-secondary">{cause.references.join(' · ')}</p>
                          <ul className="mt-2 space-y-3 border-t border-border pt-2">{cause.findings.map((finding, findingIndex) => <li key={`${finding.id}-${findingIndex}`}>
                            <p className="break-words font-medium text-content-primary">{finding.reference}</p>
                            <p className="break-words text-content-secondary">{finding.message}</p>
                            <p>Source scope: {dashboardSourceScopeLabel(finding.sourceScope)}</p>
                            {finding.category && <p>Evidence classification: {DASHBOARD_FINDING_CATEGORY_COPY[finding.category]?.title || 'Cannot verify yet'}</p>}
                            {finding.sourceFileName && <p className="break-all">Source file: {finding.sourceFileName}</p>}
                            {finding.targetFileName && <p className="break-all">Destination file: {finding.targetFileName}</p>}
                            {finding.documentIds.length > 0 && <p className="break-all">Dashboard references: {finding.documentIds.join(', ')}</p>}
                            {finding.causeCode && <p className="break-all">Diagnostic code: {finding.causeCode}</p>}
                            {finding.rootCauseId && <p className="break-all">Root cause: {finding.rootCauseId}</p>}
                          </li>)}</ul>
                        </details>
                      </li>;
                    })}</ul>
                  </section>
                )}
                {!target.package && onUpdate && <DashboardTargetPlanChoices plan={plan} target={target} index={index} disabled={editingBlocked || Boolean(topicRepairBusy)} folderCatalog={folderCatalogs?.[target.targetId]} onLoadFolders={onLoadFolders} onUpdate={onUpdate} onPlanChange={onPlanChange} onBusyChange={onTopicRepairBusyChange} />}
                {target.repairJobId && <p className="mt-2 text-xs leading-5 text-content-secondary">A model repair is linked to this destination. Review its outcome and recheck readiness. Create a new plan if different topic or staging choices are needed.</p>}
                {!target.package && !deployable && !target.deploymentJobId && modelReviewRelevant && (target.status === 'model_changes_required' || reviewable) && (
                  <button type="button" className="btn-secondary btn-sm mt-4 w-full justify-center sm:w-auto" disabled={busy} onClick={() => onResolve(target.targetId)}><ExternalLink size={14} aria-hidden="true" />{reviewable ? 'Review in Model Migrator' : 'Resolve in Model Migrator'}</button>
                )}
                <p className="mt-3 text-[11px] text-content-tertiary">{targetStale ? 'Previous check' : 'Checked'} {new Date(target.checkedAt).toLocaleString()}</p>
              </article>
            );
          })}
        </>
      )}
      <div className="space-y-4 rounded-card border border-border bg-surface-secondary p-4">
        <button type="button" className="btn-secondary justify-center" onClick={onCheck} disabled={busy}>
          {checking ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          {checking ? activeRun ? 'Checking…' : 'Restoring…' : plan ? 'Recheck readiness' : 'Check readiness'}
        </button>
        {plan && <fieldset className="space-y-3 border-t border-border pt-4">
          <legend className="sr-only">Choose destinations to include</legend>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-content-secondary">
            <span>{selected.length} selected · {held} held</span>
            <button type="button" className="btn-secondary btn-sm" disabled={busy || ready.length === 0} onClick={() => onSelect(selected.length === ready.length ? [] : ready.map((target) => target.targetId))}>
              {ready.length > 0 && selected.length === ready.length ? 'Clear selection' : 'Select all ready'}
            </button>
          </div>
          {plan.targets.map((target, index) => {
            const labels = destinationLabels[target.targetId];
            const deployable = ready.some((row) => row.targetId === target.targetId);
            const selectionExplanationId = `readiness-selection-${target.targetId}`;
            const selectionExplanation = target.deploymentJobId ? 'Held: deployment has already started for this destination.'
              : checking ? 'Held while readiness is checked. Previous selection cannot authorize deployment.'
              : savingTargetId ? 'Selection is unavailable while reviewed plan choices are saving.'
              : topicRepairBusy ? 'Selection is unavailable while the model review is in progress.'
              : stale || target.status === 'needs_recheck' ? 'Held: readiness is stale. Complete a new readiness check before including this destination.'
              : target.package && !dashboardPackageReviewComplete(target.package, reviewedPackages[target.targetId]) ? 'Held: review the current package details and resolve any decisions above before including this destination.'
              : target.package && target.status !== 'ready' ? 'Held: resolve the package readiness evidence above, then recheck before deploying.'
              : !target.package && dashboardWorkbookCopyUnavailable(target) ? 'Held: automated workbook-local copying is unavailable in this build. Review the separate copy-workflow handoff above.'
              : target.status === 'model_changes_required' ? 'Held: review and verify the model changes above, then recheck readiness.'
              : !deployable ? 'Held: dependency evidence is incomplete or ambiguous. Resolve the findings above, then recheck readiness.'
              : selected.includes(target.targetId) ? 'Included in the next deployment review.'
              : 'Held until you include this ready destination.';
            return <div key={target.targetId} className="rounded-card border border-border bg-white p-3">
              <p className="break-words text-sm font-semibold text-content-primary">{index + 1}. {labels?.instance || 'Saved instance'}</p>
              <p className="mt-1 break-words text-xs leading-5 text-content-secondary">{labels?.connection || 'Connection'} → {labels?.model || 'Model'} → {labels?.folder || 'Top level'}</p>
              <label className="mt-3 flex items-start gap-3 text-sm font-semibold text-content-primary">
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-omni-600" checked={deployable && selected.includes(target.targetId)} disabled={!deployable || busy} onChange={() => onSelect(selected.includes(target.targetId) ? selected.filter((id) => id !== target.targetId) : [...selected, target.targetId])} aria-label={`Deploy destination ${index + 1}: ${labels?.instance || 'Saved instance'}`} aria-describedby={`readiness-explanation-${target.targetId} ${selectionExplanationId}`} />
                Include this destination
              </label>
              <p id={selectionExplanationId} className="mt-1 pl-7 text-xs leading-5 text-content-secondary">{selectionExplanation}</p>
            </div>;
          })}
        </fieldset>}
      </div>
    </div>
  );
}
