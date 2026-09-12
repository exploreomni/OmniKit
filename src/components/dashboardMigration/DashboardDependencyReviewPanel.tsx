import { useRef, useState } from 'react';
import { ArrowRight, Download, ExternalLink } from 'lucide-react';
import type { DashboardModelRepairScope } from '../../services/modelMigratorHandoff';
import type { InstanceDocument, InstanceModel, ModelMigratorConnection, ModelMigratorReadiness, SavedInstancePublic } from '../../services/opsConsole';
import { buildDashboardDependencyReview, DASHBOARD_FINDING_CATEGORY_COPY, groupDashboardReadinessFindings, type DashboardDependencyReviewGroup } from '../../services/dashboardDependencyReview';
import { buildOmniDeepLink } from '../../services/omniDeepLinks';

interface Props {
  scope: DashboardModelRepairScope;
  source?: Pick<SavedInstancePublic, 'id' | 'label' | 'baseUrl'>;
  target?: Pick<SavedInstancePublic, 'id' | 'label' | 'baseUrl'>;
  sourceConnection?: Pick<ModelMigratorConnection, 'name' | 'database'>;
  targetConnection?: Pick<ModelMigratorConnection, 'name' | 'database'>;
  sourceModels: InstanceModel[];
  targetModels: InstanceModel[];
  documents: InstanceDocument[];
  namesUnavailable: boolean;
  readiness: ModelMigratorReadiness | null;
  hasJob: boolean;
  onReturn: () => void;
}

function resourceLink(baseUrl: string | undefined, path: string): string | undefined {
  const root = baseUrl && buildOmniDeepLink(baseUrl, 'tenant_root');
  return root ? new URL(path, root).href : undefined;
}

function FindingGroups({ groups }: { groups: DashboardDependencyReviewGroup[] }) {
  const kinds = { field: 'Fields', view: 'Views', query_view: 'Query views', topic: 'Topics', relationship: 'Joins', model: 'Models', security: 'Access', connection: 'Connections', document: 'Dashboards' };
  return <div className="mt-3 space-y-3">{groups.map((group) => (
    <div key={group.id} className="rounded-card border border-border-subtle bg-white p-4">
      <p className="mb-1 text-xs text-content-secondary">{kinds[group.findings[0].kind]}</p>
      <h4 className="text-sm font-semibold text-content-primary">{group.title}</h4>
      <p className="mt-1 text-sm text-content-secondary">{group.description}</p>
      <p className="mt-2 text-sm text-content-primary"><span className="font-semibold">Next step: </span>{group.nextStep}</p>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-semibold text-content-secondary">View affected items ({group.references.length})</summary>
        <ul className="mt-2 max-h-56 space-y-1 overflow-auto break-words pl-4 list-disc">{group.references.map((reference) => <li key={reference}>{reference}</li>)}</ul>
      </details>
    </div>
  ))}</div>;
}

export function DashboardDependencyReviewPanel(props: Props) {
  const { scope, source, target, sourceModels, targetModels, documents, readiness, hasJob, onReturn } = props;
  const categories = groupDashboardReadinessFindings(scope.readiness);
  const review = buildDashboardDependencyReview({ ...scope.readiness, findings: scope.readiness.findings.filter((finding) => finding.category !== 'included_with_dashboard' && finding.category !== 'topic_mapping_required') });
  const reportedFindingsCount = scope.readiness.findings.length;
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const blocked = Boolean(scope.scopeReviewRequired);
  const checkPassed = scope.readiness.status === 'ready';
  const checkStale = scope.readiness.status === 'needs_recheck';
  const returnToPlan = checkPassed || checkStale;
  const sourceModelNames = scope.sourceModelIds.map((id) => sourceModels.find((model) => model.id === id)?.name || id);
  const targetModelName = targetModels.find((model) => model.id === scope.targetModelId)?.name || 'Model name unavailable';
  const title = scope.documentIds.length === 1 && documents.length === 1 ? documents[0].name : `${scope.documentIds.length} selected dashboard${scope.documentIds.length === 1 ? '' : 's'}`;
  const sourceUrl = source && buildOmniDeepLink(source.baseUrl, 'tenant_root');
  const targetUrl = target && buildOmniDeepLink(target.baseUrl, 'tenant_root');
  const groupCount = review.unverified.length + review.differences.length;
  const previousRun = hasJob || Boolean(scope.readiness.repairJobId || scope.readiness.deploymentJobId);

  function downloadReview() {
    // Deliberately export only review metadata, never whole instance objects or YAML.
    const lines = [
      `Dashboard migration review: ${title}`,
      `Source: ${source?.label || scope.sourceInstanceId} / ${sourceModelNames.join(', ')}`,
      `Destination: ${target?.label || scope.targetInstanceId} / ${targetModelName}`,
      `Plan: ${scope.handoff.planId}; target: ${scope.handoff.targetId}; revision: ${scope.revision}`,
      `Checked: ${new Date(scope.readiness.checkedAt).toISOString()}; status: ${scope.readiness.status}`,
      `Source dashboard identifiers: ${scope.documentIds.join(', ')}`,
      `Source model identifiers: ${scope.sourceModelIds.join(', ')}`,
      `Target model identifier: ${scope.targetModelId}`,
      'Unknown definitions are not proof of missing destination fields. This report does not authorize changes.',
      '',
      ...[...review.unverified, ...review.differences].flatMap((group) => [group.title, group.description, `Next step: ${group.nextStep}`, ...group.findings.map((finding) => `${finding.kind}: ${finding.reference} — ${finding.message}`), '']),
      ...[...categories.included_with_dashboard, ...categories.topic_mapping_required].map((finding) => `${finding.category}: ${finding.reference} — ${finding.message}`),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'dashboard-dependency-review.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section data-testid="dashboard-dependency-repair" className="space-y-4">
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Dashboard Migrator · Model review</p>
          <h1 className="mt-1 text-xl font-semibold text-content-primary">Prepare {title} for {target?.label || 'the destination'}</h1>
          <p className="mt-2 max-w-3xl text-sm text-content-secondary">A dashboard relies on model definitions for its fields, calculations, and joins. You are here to check those definitions before copying the dashboard.</p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={onReturn}>Back to dashboard plan</button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-card bg-surface-secondary p-3 text-sm"><p className="text-xs text-content-secondary">Copy from</p><p className="font-semibold">{source?.label || 'Source name unavailable'}</p><p className="break-words text-content-secondary">Connection: {props.sourceConnection?.name || 'Name unavailable'}</p><p className="break-words text-content-secondary">Model: {sourceModelNames.join(', ')}</p></div>
        <div className="rounded-card bg-surface-secondary p-3 text-sm"><p className="text-xs text-content-secondary">Copy to</p><p className="font-semibold">{target?.label || 'Destination name unavailable'}</p><p className="break-words text-content-secondary">Connection: {props.targetConnection?.name || 'Name unavailable'}</p><p className="break-words text-content-secondary">Model: {targetModelName}</p></div>
      </div>
      <p className="mt-3 text-xs text-content-secondary">Selections come from your dashboard plan. Use “Back to dashboard plan” to change the destination.</p>
      {props.namesUnavailable && <p className="mt-2 text-xs text-content-secondary">Dashboard names could not be loaded. The exact selected identifiers remain available in technical details; your plan has not changed.</p>}
    </div>

    <div className={`rounded-card border p-5 ${blocked ? 'border-amber-200 bg-amber-50' : 'border-border-subtle bg-surface-secondary'}`}>
      <h3 className="font-semibold text-content-primary">{checkPassed ? 'The saved dashboard check passed' : checkStale ? 'Recheck dashboard readiness' : blocked ? 'Paused — review required before changes' : 'Model changes are ready to review'}</h3>
      <p className="mt-2 max-w-3xl text-sm text-content-secondary">{checkPassed
        ? 'This saved check does not request another model repair. Return to the dashboard plan to confirm current readiness before deployment.'
        : checkStale
          ? 'The saved dependency review is out of date. Review any recorded run below, then return to the dashboard plan and choose “Recheck readiness.”'
          : blocked
            ? 'OmniKit does not yet have enough verified information to prepare a safe repair. This may be a gap in what OmniKit can read, not a missing field in your destination.'
            : 'Review the proposed model changes below. They must be validated and published through the model review process before the dashboard can be checked again.'}</p>
      <p className="mt-2 text-sm font-semibold">{previousRun ? `An earlier run is recorded for this plan. Review its outcome ${hasJob ? 'in Run results below' : 'in the dashboard plan'} before starting another.` : 'Reviewing these findings does not change any dashboards or models.'}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="btn-primary inline-flex items-center gap-2 text-sm" aria-expanded={returnToPlan ? undefined : reviewOpen} aria-controls={returnToPlan ? undefined : 'dependency-review-findings'}
          onClick={() => { if (returnToPlan) { onReturn(); return; } setReviewOpen(true); requestAnimationFrame(() => { reviewHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); reviewHeading.current?.focus(); }); }}>
          {returnToPlan ? 'Return to dashboard readiness' : blocked ? 'Review unresolved definitions' : 'Review model differences'}<ArrowRight size={15} />
        </button>
        <button type="button" className="btn-secondary inline-flex items-center gap-2 text-sm" onClick={downloadReview}><Download size={15} />Download review summary</button>
      </div>
    </div>

    <div className="grid gap-3 sm:grid-cols-3" aria-label="Dependency review summary">
      <div className="card p-4"><h3 className="text-sm font-semibold">Couldn’t verify</h3><p className="mt-1 text-sm text-content-secondary">{checkStale ? 'Previous findings only — recheck required' : review.unverified.length ? `${review.unverified.length} issue groups to review` : 'No separate verification issues reported'}</p></div>
      <div className="card p-4"><h3 className="text-sm font-semibold">Confirmed differences</h3><p className="mt-1 text-sm text-content-secondary">{checkStale ? 'Recheck required for current differences' : review.differences.length ? `${review.differences.length} groups need model review` : blocked && !checkPassed ? 'Not established while verification is incomplete' : 'No additional differences reported'}</p></div>
      <div className="card p-4"><h3 className="text-sm font-semibold">Ready to copy</h3><p className="mt-1 text-sm text-content-secondary">{checkPassed ? 'The saved dashboard check passed. Return to the plan before deployment.' : 'Not yet. Resolve the review items, then recheck in the dashboard plan.'}</p></div>
    </div>

    {categories.included_with_dashboard.length > 0 && <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-semibold">{DASHBOARD_FINDING_CATEGORY_COPY.included_with_dashboard.title} ({categories.included_with_dashboard.length})</summary>
      <p className="mt-2 text-content-secondary">{DASHBOARD_FINDING_CATEGORY_COPY.included_with_dashboard.description}</p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">{categories.included_with_dashboard.map((finding) => <li key={finding.id} className="break-words">{finding.reference} — {finding.message}</li>)}</ul>
    </details>}
    {categories.topic_mapping_required.length > 0 && <div className="card p-4 text-sm">
      <h3 className="font-semibold">Destination topic review stays in the dashboard plan</h3>
      <p className="mt-2 text-content-secondary">{DASHBOARD_FINDING_CATEGORY_COPY.topic_mapping_required.description}</p>
      <button type="button" onClick={onReturn} className="btn-secondary btn-sm mt-3">Review topic choices in dashboard plan</button>
    </div>}

    <section id="dependency-review-findings" hidden={!reviewOpen} className="card p-5" aria-labelledby="dependency-review-heading">
      <h3 ref={reviewHeading} id="dependency-review-heading" tabIndex={-1} className="text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-omni-400">{blocked ? 'Review unresolved definitions' : 'Review model differences'}</h3>
      <p className="mt-2 text-sm text-content-secondary">{groupCount} issue groups summarize {review.totalFindings} diagnostic findings. Several findings may refer to the same item; these are not separate repair tasks.</p>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
        <li>Open the source dashboard in Omni and inspect the exact view and field in its workbook, including local and inherited definitions. Not finding the field in the shared source model does not by itself prove the dashboard is broken.</li>
        <li>With the dashboard or model owner, identify the intended definition. Keep intentional workbook-local fields in their original scope; review workbook-copy support and staging evidence in the dashboard plan. Do not promote a local calculation to a shared model merely to migrate it. For an outdated dashboard reference, confirm the intended field and correct the affected reference.</li>
        <li>Do not substitute a similarly named field from another view or recreate a field based only on these warnings. Confirm its calculation, level of detail, joins, filters, and access behavior before approving a replacement.</li>
        <li>If the definition exists but OmniKit cannot read it, share the review summary with your Omni administrator or OmniKit maintainer. After the evidence gap or reviewed changes are resolved, return to the dashboard plan and choose “Recheck readiness.” This review does not automatically edit models or dashboards or bypass readiness.</li>
      </ol>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="btn-secondary inline-flex items-center gap-2">Open source Omni<ExternalLink size={14} /></a>}
        {targetUrl && <a href={targetUrl} target="_blank" rel="noreferrer" className="btn-secondary inline-flex items-center gap-2">Open destination Omni<ExternalLink size={14} /></a>}
        {documents.map((doc) => {
          const href = resourceLink(source?.baseUrl, `/dashboards/${encodeURIComponent(doc.identifier || doc.id)}`);
          return href ? <a key={doc.id} href={href} target="_blank" rel="noreferrer" className="btn-secondary inline-flex items-center gap-2">Open {doc.name}<ExternalLink size={14} /></a> : null;
        })}
      </div>
      <FindingGroups groups={[...review.unverified, ...review.differences]} />
      {groupCount === 0 && <p className="mt-4 text-sm">No additional Model Migrator findings were provided. Return to the dashboard plan for the current readiness result; an empty list does not authorize a repair.</p>}
    </section>

    <details className="card p-5 text-sm">
      <summary className="cursor-pointer font-semibold">Technical details · files, data locations, and original diagnostics</summary>
      <p className="mt-3 text-xs text-content-secondary">Checked {new Date(scope.readiness.checkedAt).toLocaleString()} · Saved plan revision {scope.revision}</p>
      <p className="mt-2 text-xs text-content-secondary">Passed dependencies are not individually reported. An empty findings list is not a pass.</p>
      {scope.scopeReviewRequired && <p className="mt-3 break-words text-xs">Original scope restriction: {scope.scopeReviewRequired}</p>}
      <p className="mt-3 break-words text-xs">Dashboard identifiers: {scope.documentIds.join(', ')}</p>
      <p className="mt-2 break-words text-xs">Source connection identifier: {scope.sourceConnectionId} · Destination connection identifier: {scope.targetConnectionId}</p>
      <p className="mt-2 break-words text-xs">Destination model identifier: {scope.targetModelId}</p>
      <h3 className="mt-4 font-semibold">Model files identified for review</h3>
      {scope.sourceModelIds.map((modelId) => <div key={modelId} className="mt-2"><p>{sourceModels.find((model) => model.id === modelId)?.name || modelId}</p><ul className="mt-1 list-disc pl-5 text-xs">{(scope.readiness.requiredFilesByModelId[modelId] || []).map((name) => <li key={name} className="break-all">{name}</li>)}</ul></div>)}
      <details className="mt-4"><summary className="cursor-pointer font-semibold">Data-location inventory</summary><p className="mt-2">Source database: {props.sourceConnection?.database || 'Not reported'} · Target database: {props.targetConnection?.database || 'Not reported'}</p>{readiness?.pairs.map((pair) => <div key={pair.sourceModelId} className="mt-2 break-words text-xs"><p>Source schemas: {pair.schemaOverlap?.sourceSchemas.join(', ') || 'Not reported'}</p><p>Target schemas: {pair.schemaOverlap?.targetSchemas.join(', ') || 'Not reported'}</p></div>)}</details>
      <details className="mt-4"><summary className="cursor-pointer font-semibold">Original diagnostics ({reportedFindingsCount})</summary><ul className="mt-2 max-h-80 space-y-2 overflow-auto break-words text-xs">{scope.readiness.findings.map((finding, index) => <li key={`${finding.id}:${index}`}>{finding.kind} · {finding.reference}<br />{finding.message}</li>)}</ul></details>
    </details>
    {blocked && !returnToPlan && <p className="px-1 text-sm text-content-secondary">Next stages, if model changes are needed: prepare changes → review and validate → publish → recheck the dashboard. New repair controls remain unavailable until this review is resolved.{hasJob ? ' Existing run results and available actions are shown below.' : ''}</p>}
  </section>;
}
