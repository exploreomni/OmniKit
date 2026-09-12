import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { DashboardDeploymentPlan, DashboardDeploymentTargetUpdate, DashboardReadinessProgressEvent } from '@/services/dashboardDeploymentPlans';
import { StatusChip } from '@/components/ui/StatusChip';
import { canReviewUnverifiedDashboardDependencies } from '@/services/modelMigratorHandoff';
import { DASHBOARD_FINDING_CATEGORY_COPY, groupDashboardReadinessCauses, groupDashboardReadinessFindings } from '@/services/dashboardDependencyReview';
import type { DashboardFindingCategory } from '../../../shared/dashboardDeploymentPlan';
import type { DestinationFolderCatalog } from './useDashboardDestinationFolders';
import { DashboardTargetPlanChoices } from './DashboardTargetPlanChoices';
import { DashboardReadinessProgress } from './DashboardReadinessProgress';
import { dashboardReadinessIsStale } from './dashboardReadinessPresentation';

const READINESS_LABELS = {
  ready: 'Ready to deploy',
  model_changes_required: 'Model changes required',
  unverified: 'Unverified',
  needs_recheck: 'Needs recheck',
} as const;

export function DashboardReadinessReview({ plan, checking, progress, startedAt, onCancel, savingTargetId, selectedTargetIds, destinationLabels, folderCatalogs, onLoadFolders, onUpdate, onCheck, onSelect, onResolve, onPlanChange, topicRepairBusy, onTopicRepairBusyChange }: {
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
}) {
  const busy = checking || Boolean(savingTargetId) || Boolean(topicRepairBusy);
  const stale = checking || dashboardReadinessIsStale(plan);
  const ready = stale ? [] : plan?.targets.filter((target) => target.status === 'ready' && !target.deploymentJobId) || [];
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
            {savingTargetId ? 'Only the saved plan is updated. Recheck readiness after the choices are saved.' : checking ? 'Previous findings are stale and cannot authorize deployment while this request is in progress.' : stale ? 'The saved readiness run did not complete. Previous findings are stale; explicitly recheck before deploying.' : plan ? 'Select the ready destinations to include. Held destinations remain in this plan.' : 'Readiness uses the exported dashboard dependencies and current model content.'}
          </p>
          {activeRun && <DashboardReadinessProgress progress={progress} startedAt={startedAt!} targetLabel={progress?.targetId ? destinationLabels[progress.targetId]?.instance : undefined} />}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className="btn-secondary justify-center" onClick={onCheck} disabled={busy}>
            {checking ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            {checking ? activeRun ? 'Checking…' : 'Restoring…' : plan ? 'Recheck readiness' : 'Check readiness'}
          </button>
          {activeRun && onCancel && <button type="button" className="btn-secondary justify-center" onClick={onCancel}>Cancel check</button>}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">{savingTargetId ? 'Saving plan choices. Deployment controls are unavailable until saving finishes.' : checking ? 'Readiness check in progress.' : plan ? `${ready.length} ready destinations. ${held} held destinations.` : 'Readiness has not been checked.'}</span>
      {plan && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-content-secondary">
            <span>{selected.length} selected · {held} held</span>
            <button type="button" className="btn-secondary btn-sm" disabled={busy || ready.length === 0} onClick={() => onSelect(selected.length === ready.length ? [] : ready.map((target) => target.targetId))}>
              {ready.length > 0 && selected.length === ready.length ? 'Clear selection' : 'Select all ready'}
            </button>
          </div>
          {plan.targets.map((target, index) => {
            const labels = destinationLabels[target.targetId];
            const targetStale = stale || target.status === 'needs_recheck';
            const deployable = !targetStale && target.status === 'ready' && !target.deploymentJobId;
            const reviewable = canReviewUnverifiedDashboardDependencies(target);
            const explanationId = `readiness-explanation-${target.targetId}`;
            const blockedExplanation = target.deploymentJobId ? 'This destination already has a deployment job.'
              : targetStale ? 'Previous findings are stale and cannot authorize deployment. Complete a new readiness check before selecting this destination.'
              : target.status === 'model_changes_required' ? 'Deployment is blocked until the identified model changes are reviewed and verified. Resolve the listed dependencies, then return to recheck this destination.'
              : target.status === 'unverified' ? 'Deployment is blocked because dependency evidence is incomplete or ambiguous. Missing source evidence does not establish that a target dependency is missing.'
              : 'Deployment is blocked until readiness is rechecked against the current source and destination models.';
            const grouped = groupDashboardReadinessFindings(target);
            const legacyFindings = target.findings.every((finding) => !finding.category);
            const modelReviewRelevant = grouped.model_migrator.length > 0 || legacyFindings;
            const editingBlocked = busy || Boolean(target.deploymentJobId) || Boolean(target.repairJobId);
            const causeCount = Object.values(grouped).reduce((count, findings) => count + groupDashboardReadinessCauses(findings).length, 0);
            return (
              <article key={target.targetId} className={`rounded-card border p-4 sm:p-5 ${deployable ? 'border-green-200 bg-green-50/40' : 'border-border bg-white'}`} aria-labelledby={`readiness-${target.targetId}`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <label className="flex min-w-0 items-start gap-3">
                    <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-omni-600" checked={deployable && selected.includes(target.targetId)} disabled={!deployable || busy} onChange={() => onSelect(selected.includes(target.targetId) ? selected.filter((id) => id !== target.targetId) : [...selected, target.targetId])} aria-label={`Deploy destination ${index + 1}: ${labels?.instance || 'Saved instance'}`} aria-describedby={explanationId} />
                    <span className="min-w-0">
                      <span id={`readiness-${target.targetId}`} className="block break-words text-sm font-semibold text-content-primary">{index + 1}. {labels?.instance || 'Saved instance'}</span>
                      <span className="mt-1 block break-words text-xs leading-5 text-content-secondary">{labels?.connection || 'Connection'} → {labels?.model || 'Model'} → {labels?.folder || 'Top level'}</span>
                    </span>
                  </label>
                  <StatusChip status={deployable ? 'ready' : 'warning'} label={target.deploymentJobId ? 'Deployment started' : targetStale ? 'Needs recheck · previous findings' : READINESS_LABELS[target.status]} size="xs" />
                </div>
                {deployable ? (
                  <p id={explanationId} className="mt-4 flex items-start gap-2 text-xs leading-5 text-green-900"><CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />Dependencies passed the current checks. Dashboard creation and verification run during deployment.</p>
                ) : (
                  <p id={explanationId} className="mt-4 flex items-start gap-2 text-xs leading-5 text-content-secondary"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />{blockedExplanation}</p>
                )}
                {target.status === 'unverified' && !target.deploymentJobId && modelReviewRelevant && (
                  <p className="mt-2 text-xs leading-5 text-content-secondary">
                    {reviewable ? 'Open the identified model context in Model Migrator. Inspect source model and dashboard workbook definitions in Omni, including workbook-local and inherited semantics. Establish the missing evidence and review any needed model changes, then recheck readiness.'
                      : target.sourceModelIds.length === 0 ? 'Confirm the dashboard’s source connection and model binding, and restore access to the source model. A source model and required files must be identified before Model Migrator can open a scoped review.'
                        : 'Inspect the source model and dashboard workbook in Omni for workbook-local or inherited definitions, and confirm source access. Resolve the missing dependency evidence, then recheck to identify the required files for a scoped Model Migrator review.'}
                  </p>
                )}
                {target.findings.length > 0 && (
                  <details className="mt-4 rounded-card border border-border bg-surface-secondary" open={target.status === 'model_changes_required' || grouped.cannot_verify.length > 0 || grouped.topic_mapping_required.length > 0 || undefined}>
                    <summary className="cursor-pointer px-3 py-3 text-xs font-semibold text-content-primary">{targetStale ? 'Previous findings — stale' : 'Readiness findings'} ({causeCount} cause groups · {target.findings.length} observations)</summary>
                    <div className="space-y-4 border-t border-border p-3">
                      {(Object.entries(grouped) as Array<[DashboardFindingCategory, typeof target.findings]>).filter(([, rows]) => rows.length > 0).map(([category, rows]) => (
                        <details key={category} open={category !== 'included_with_dashboard' || undefined}>
                          <summary className="cursor-pointer text-xs font-semibold text-content-primary">{DASHBOARD_FINDING_CATEGORY_COPY[category].title} ({groupDashboardReadinessCauses(rows).length} cause groups)</summary>
                          <p className="mt-1 text-xs leading-5 text-content-secondary">{DASHBOARD_FINDING_CATEGORY_COPY[category].description}</p>
                          <ul className="mt-2 space-y-2">
                            {groupDashboardReadinessCauses(rows).map((cause) => <li key={cause.id} className="rounded-card border border-border bg-white p-3 text-xs leading-5">
                              <p className="break-words font-medium text-content-primary">{cause.message}</p>
                              <p className="mt-1 break-words text-content-secondary">{cause.references.slice(0, 3).join(' · ')}{cause.references.length > 3 ? ` · ${cause.references.length - 3} more references` : ''}</p>
                              <p className="mt-1 text-content-tertiary">{cause.findings.length} observation{cause.findings.length === 1 ? '' : 's'} · {cause.documentIds.length} selected dashboard{cause.documentIds.length === 1 ? '' : 's'}</p>
                              <details className="mt-2">
                                <summary className="cursor-pointer font-medium text-content-secondary">View references and original evidence</summary>
                                <ul className="mt-2 space-y-3 border-t border-border pt-2">{cause.findings.map((finding, findingIndex) => <li key={`${finding.id}-${findingIndex}`}>
                                  <p className="break-words font-medium text-content-primary">{finding.reference}</p>
                                  <p className="break-words text-content-secondary">{finding.message}</p>
                                  {finding.sourceScope && <p>Source scope: {finding.sourceScope === 'workbook' ? 'Workbook-local' : finding.sourceScope === 'shared' ? 'Shared model' : 'Inherited definition'}</p>}
                                  {finding.sourceFileName && <p className="break-all">Source file: {finding.sourceFileName}</p>}
                                  {finding.targetFileName && <p className="break-all">Destination file: {finding.targetFileName}</p>}
                                  {finding.documentIds.length > 0 && <p className="break-all">Dashboard references: {finding.documentIds.join(', ')}</p>}
                                  {finding.causeCode && <p className="break-all">Diagnostic code: {finding.causeCode}</p>}
                                  {finding.rootCauseId && <p className="break-all">Root cause: {finding.rootCauseId}</p>}
                                </li>)}</ul>
                              </details>
                            </li>)}
                          </ul>
                        </details>
                      ))}
                    </div>
                  </details>
                )}
                {onUpdate && <DashboardTargetPlanChoices plan={plan} target={target} index={index} disabled={editingBlocked || Boolean(topicRepairBusy)} folderCatalog={folderCatalogs?.[target.targetId]} onLoadFolders={onLoadFolders} onUpdate={onUpdate} onPlanChange={onPlanChange} onBusyChange={onTopicRepairBusyChange} />}
                {target.repairJobId && <p className="mt-2 text-xs leading-5 text-content-secondary">A model repair is linked to this destination. Review its outcome and recheck readiness. Create a new plan if different topic or staging choices are needed.</p>}
                {!deployable && !target.deploymentJobId && modelReviewRelevant && (target.status === 'model_changes_required' || reviewable) && (
                  <button type="button" className="btn-secondary btn-sm mt-4 w-full justify-center sm:w-auto" disabled={busy} onClick={() => onResolve(target.targetId)}><ExternalLink size={14} aria-hidden="true" />{reviewable ? 'Review in Model Migrator' : 'Resolve in Model Migrator'}</button>
                )}
                <p className="mt-3 text-[11px] text-content-tertiary">{targetStale ? 'Previous check' : 'Checked'} {new Date(target.checkedAt).toLocaleString()}</p>
              </article>
            );
          })}
        </>
      )}
    </div>
  );
}
