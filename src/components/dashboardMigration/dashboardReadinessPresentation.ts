import type { DashboardDependencyFinding, DashboardDeploymentPlan, DashboardDeploymentTargetReadiness } from '../../../shared/dashboardDeploymentPlan';
import type { DashboardReadinessStage } from '../../../shared/dashboardReadiness';
import { getDashboardWorkbookCopyCapability } from '../../../shared/dashboardWorkbookCopyCapability';
import { isDashboardWorkbookCopyFinding, type DashboardReadinessCauseGroup } from '../../services/dashboardDependencyReview';

export const DASHBOARD_READINESS_STAGE_LABELS: Record<DashboardReadinessStage, string> = {
  source_dashboard: 'Reading source dashboard and workbook evidence',
  source_models: 'Reading source shared-model definitions',
  destination_evidence: 'Reading destination model and access evidence',
  comparison: 'Comparing dependency evidence',
  complete: 'Finishing the readiness result',
};

/** Retain findings for inspection, but never retain their previous authorization. */
export function staleDashboardReadiness(plan: DashboardDeploymentPlan | null): DashboardDeploymentPlan | null {
  return plan ? { ...plan, targets: plan.targets.map((target) => ({ ...target, status: 'needs_recheck' })) } : null;
}

export function dashboardReadinessIsStale(plan: DashboardDeploymentPlan | null): boolean {
  return Boolean(plan?.readinessRun && plan.readinessRun.status !== 'complete');
}

export function dashboardWorkbookCopyUnavailable(target: DashboardDeploymentTargetReadiness): boolean {
  return !getDashboardWorkbookCopyCapability().supported && target.findings.some(isDashboardWorkbookCopyFinding);
}

export function dashboardReadinessLabel(target: DashboardDeploymentTargetReadiness, stale: boolean): string {
  if (target.deploymentJobId) return 'Deployment started';
  if (stale) return 'Needs recheck · previous findings';
  if (dashboardWorkbookCopyUnavailable(target)) return 'Workbook copy unavailable';
  if (target.status === 'ready') return 'Ready to deploy';
  if (target.status === 'model_changes_required') return 'Needs model review';
  return 'Needs evidence review';
}

export function dashboardSourceScopeLabel(scope: DashboardDependencyFinding['sourceScope']): string {
  return scope === 'workbook' ? 'Workbook-local' : scope === 'shared' ? 'Shared model' : scope === 'inherited' ? 'Inherited definition' : 'Not established';
}

const SOURCE_FILE_ACTIONS: Record<string, { title: string; nextAction: string }> = {
  SOURCE_YAML_MALFORMED: {
    title: 'Source YAML needs a syntax check',
    nextAction: 'Ask the source model owner to inspect the exact file and reported line in Omni. Correct the syntax, then recheck; no empty or missing definitions were assumed.',
  },
  SOURCE_YAML_UNSUPPORTED_SHAPE: {
    title: 'Source file structure needs review',
    nextAction: 'Review the exact source file structure and relationship or field identities with the model owner. Establish how to preserve them before rechecking; do not replace the file with an empty definition.',
  },
  SOURCE_YAML_UNSUPPORTED_FEATURE: {
    title: 'Source YAML features need interpretation',
    nextAction: 'Review the source anchors, aliases, tags, or reported feature with the model owner. Establish its full meaning before rechecking; do not remove it merely to pass readiness.',
  },
  SOURCE_YAML_LIMIT: {
    title: 'Source file exceeds the automatic review limit',
    nextAction: 'Review the exact file separately with the implementation owner. Establish a supported review of its complete contents; the limit does not mean its definitions are absent.',
  },
  SOURCE_YAML_READ_UNAVAILABLE: {
    title: 'Source file could not be read',
    nextAction: 'Restore a complete source-file read and confirm access, then recheck. An unreadable response is not an empty source file.',
  },
  WORKBOOK_OVERLAY_PRESERVATION_REQUIRED: {
    title: 'Workbook settings need preservation review',
    nextAction: 'Review the exact workbook relationships, settings, or access rules with its owner. Keep their workbook scope and arrange a separately supported preservation workflow; do not promote them to the shared model.',
  },
};

export function dashboardReadinessCauseAction(cause: DashboardReadinessCauseGroup): { title: string; description: string; nextAction: string } {
  if (cause.workbookCopy) return {
    title: 'Workbook copy unavailable',
    description: 'Workbook-local definitions were identified, not copied. Automated copying is unavailable in this build; this is not a finding that the tenant denied access.',
    nextAction: 'Keep these definitions in the source workbook. Ask the Omni administrator and implementation owner to review a separate supported copy workflow; rechecking alone cannot enable copying here.',
  };
  if (cause.findings.some((finding) => finding.kind === 'security')) return {
    title: 'Access settings need review', description: cause.message,
    nextAction: 'Review the original access and security evidence with the model owner before approving any change, then recheck readiness.',
  };
  const sourceFileAction = cause.findings.map((finding) => SOURCE_FILE_ACTIONS[finding.causeCode || '']).find(Boolean);
  if (sourceFileAction) return { ...sourceFileAction, description: cause.message };
  if (cause.categories.includes('cannot_verify')) return {
    title: 'Evidence needs verification', description: cause.message,
    nextAction: 'Inspect the listed definitions and their source scope in Omni. Resolve the missing or ambiguous evidence, then recheck readiness.',
  };
  if (cause.categories.includes('topic_mapping_required')) return {
    title: 'Review the destination topic', description: cause.message,
    nextAction: 'Use the topic choices below after reviewing fields, joins, filters, and access. Save the intended mapping, then recheck readiness.',
  };
  if (cause.categories.includes('model_migrator')) return {
    title: cause.sourceScope === 'shared' ? 'Shared-model changes need review' : 'Model changes need review', description: cause.message,
    nextAction: 'Review the identified source and destination definitions in Model Migrator. Verify the intended model changes, then recheck dashboard readiness.',
  };
  return {
    title: 'Review the identified definitions', description: cause.message,
    nextAction: 'Inspect the original evidence and preserve its source scope. Identification alone does not prove a supported copy or a completed deployment.',
  };
}
