import type { DashboardDeploymentPlan } from './dashboardDeploymentPlan';

export const DASHBOARD_READINESS_STAGES = [
  'source_dashboard', 'source_models', 'destination_evidence', 'comparison', 'complete',
] as const;
export type DashboardReadinessStage = typeof DASHBOARD_READINESS_STAGES[number];
export interface DashboardReadinessCounters {
  completed?: number;
  total?: number;
  targetId?: string;
}
export interface DashboardReadinessProgressEvent extends DashboardReadinessCounters {
  type: 'progress';
  runId: string;
  stage: DashboardReadinessStage;
  elapsedMs: number;
}
export type DashboardReadinessErrorCode =
  | 'DASHBOARD_READINESS_CANCELED'
  | 'DASHBOARD_READINESS_DEADLINE_EXCEEDED'
  | 'DASHBOARD_READINESS_FAILED';
export type DashboardReadinessEvent = DashboardReadinessProgressEvent
  | { type: 'complete'; runId: string; plan: DashboardDeploymentPlan }
  | { type: 'error'; runId: string; code: DashboardReadinessErrorCode; error: string; stage: DashboardReadinessStage; elapsedMs: number };
