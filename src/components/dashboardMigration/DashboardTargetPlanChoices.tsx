import type { DashboardDeploymentPlan, DashboardDeploymentTargetReadiness, DashboardDeploymentTargetUpdate } from '@/services/dashboardDeploymentPlans';
import type { DestinationFolderCatalog } from './useDashboardDestinationFolders';
import { reviewedExistingTopicMapping } from './dashboardTopicMappingChoices';
import { DashboardTopicRepairReview } from './DashboardTopicRepairReview';
import { getDashboardWorkbookCopyCapability } from '../../../shared/dashboardWorkbookCopyCapability';

export function DashboardTargetPlanChoices({ plan, target, index, disabled, onUpdate, onPlanChange, onBusyChange }: {
  plan: DashboardDeploymentPlan;
  target: DashboardDeploymentTargetReadiness;
  index: number;
  disabled: boolean;
  folderCatalog?: DestinationFolderCatalog;
  onLoadFolders?: (targetId: string, forceRefresh?: boolean) => void;
  onUpdate: (update: DashboardDeploymentTargetUpdate) => void;
  onPlanChange?: (plan: DashboardDeploymentPlan) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const destination = plan.intent.destinations.find((row) => row.targetId === target.targetId);
  if (!destination) return null;
  const topicChoices = target.topicChoices || [];
  const stagingFolderId = destination.workbookCopy?.stagingFolderId || '';
  const workbookIncluded = target.findings.some((finding) => finding.sourceScope === 'workbook');
  if (topicChoices.length === 0 && !workbookIncluded && !stagingFolderId) return null;
  const update = (patch: Omit<DashboardDeploymentTargetUpdate, 'revision' | 'targetId'>) => onUpdate({ revision: plan.revision, targetId: target.targetId, ...patch });
  const capabilityReasons = target.findings.filter((finding) => finding.causeCode === 'WORKBOOK_COPY_CAPABILITY_UNVERIFIED' || finding.reference === 'workbook_copy_capability');
  const workbookCapability = getDashboardWorkbookCopyCapability();
  const savedCapabilityReasons = capabilityReasons.filter((finding) => finding.message !== workbookCapability.message);
  return <div className="mt-4 space-y-4 rounded-card border border-border bg-surface-secondary p-3">
    {(workbookIncluded || stagingFolderId) && <div className="rounded-card border border-amber-200 bg-amber-50 p-3">
      <h4 className="text-xs font-semibold text-amber-950">Workbook-local copy is unavailable</h4>
      <p className="mt-1 text-xs leading-5 text-amber-950">{workbookCapability.message}</p>
      <p className="mt-1 text-xs leading-5 text-amber-950">Choosing a folder or confirming privacy would not remove this block, so staging choices are unavailable.</p>
      {savedCapabilityReasons.length > 0 && <details className="mt-2 text-xs leading-5 text-amber-950">
        <summary className="cursor-pointer font-semibold">Saved readiness evidence — may be outdated</summary>
        <p className="mt-1">These messages were stored with this plan. They are not a current tenant-access assessment; the capability checklist below describes this build.</p>
        {savedCapabilityReasons.map((finding) => <p key={finding.id} className="mt-1">{finding.message}</p>)}
      </details>}
      <details className="mt-2 text-xs leading-5 text-amber-950">
        <summary className="cursor-pointer font-semibold">What must be verified before automatic copying is available</summary>
        <ul className="mt-2 list-disc space-y-2 pl-4">{workbookCapability.checks.map((check) => <li key={check.id}>
          <span className="font-semibold">{check.title} — not verified.</span> {check.detail}
          <p className="mt-1">{check.requiredEvidence}</p>
          <p className="mt-1 flex flex-wrap gap-x-3">{check.documentation.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="underline">{link.title}</a>)}</p>
        </li>)}</ul>
        {workbookCapability.transportCandidates.map((candidate) => <div key={candidate.title} className="mt-3">
          <p><span className="font-semibold">{candidate.title}.</span> {candidate.detail}</p>
          <p className="mt-1 flex flex-wrap gap-x-3">{candidate.documentation.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="underline">{link.title}</a>)}</p>
        </div>)}
      </details>
      <p className="mt-2 text-xs leading-5 text-amber-950">{workbookCapability.handoff}</p>
      {stagingFolderId && <p className="mt-1 break-all text-xs text-amber-950">Previously saved staging folder: {stagingFolderId}. This choice is preserved, not verified or used for a copy.</p>}
    </div>}
    {topicChoices.length > 0 && <p className="text-xs leading-5 text-content-secondary">Each topic choice saves this plan only and invalidates this destination’s readiness. Finish reviewing your choices, then choose “Recheck readiness.” Nothing is copied or written to a model by these controls.</p>}
    {topicChoices.map((choice) => {
      const current = destination.topicMappings?.find((mapping) => mapping.sourceTopicName === choice.sourceTopicName);
      const selected = current?.action === 'map_existing' ? current.targetTopicName : '';
      const selectedMissing = selected && !choice.candidates.some((candidate) => candidate.name === selected);
      return <div key={choice.sourceTopicName}>
        {Boolean(choice.sourceCandidates?.length) && <details className="mb-2 text-xs">
          <summary className="cursor-pointer font-semibold text-content-secondary">Current source topics for reference ({choice.sourceCandidates!.length})</summary>
          <p className="mt-1 leading-5 text-content-secondary">These source names are read-only context, not replacements for the dashboard reference. A similar name does not establish the missing source definition or equivalent semantics.</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">{choice.sourceCandidates!.map((candidate) => <li key={candidate.fileName || candidate.name} className="break-words">{candidate.name}{candidate.label && candidate.label !== candidate.name ? ` — ${candidate.label}` : ''}{candidate.fileName ? ` (${candidate.fileName})` : ''}</li>)}</ul>
        </details>}
        <label className="block text-xs font-semibold text-content-primary">
          Exact source dashboard topic reference: <span className="break-all">{choice.sourceTopicName}</span>
          <select className="input-field mt-1 w-full" aria-label={`Destination ${index + 1} reviewed topic for ${choice.sourceTopicName}`} value={selected} disabled={disabled} onChange={(event) => {
            const value = event.target.value;
            if (value === selected) return;
            update({ topicMappings: reviewedExistingTopicMapping(destination.topicMappings, choice.sourceTopicName, value, choice.candidates.map((candidate) => candidate.name)) });
          }}>
            <option value="">Choose an existing destination topic</option>
            {selectedMissing && <option value={selected}>Saved: {selected} — not in the current candidate list</option>}
            {choice.candidates.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.label && candidate.label !== candidate.name ? `${candidate.label} — ${candidate.name}` : candidate.name}{candidate.fileName ? ` (${candidate.fileName})` : ''}</option>)}
          </select>
        </label>
        <p className="mt-1 text-xs leading-5 text-content-secondary">Affects {choice.documentIds.length} dashboard{choice.documentIds.length === 1 ? '' : 's'}. Review fields, joins, filters, and access before choosing. Similar names do not establish equivalent semantics; an incompatible mapping stays blocked. Choosing a destination topic does not resolve missing source evidence.</p>
        {choice.candidates.length === 0 && <p className="mt-1 text-xs text-amber-800">No destination candidates were returned. Verify the exact source topic and destination catalog in Omni. Only an identified shared-model difference belongs in Model Migrator; no topic will be created automatically here.</p>}
        {current?.action === 'copy_source' && <p className="mt-1 text-xs text-amber-800">This plan has a previously saved copy-source decision. Selecting an existing topic replaces that decision; leaving this control unchanged preserves it.</p>}
        {!choice.sourceCandidates?.some((candidate) => candidate.name === choice.sourceTopicName) && <DashboardTopicRepairReview plan={plan} target={target} sourceTopicName={choice.sourceTopicName} disabled={disabled} onPlanChange={onPlanChange} onBusyChange={onBusyChange} />}
      </div>;
    })}
  </div>;
}
