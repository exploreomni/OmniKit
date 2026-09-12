import type { DashboardDeploymentPlan } from '../../../shared/dashboardDeploymentPlan';
import type { DashboardReadinessStage } from '../../../shared/dashboardReadiness';

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
