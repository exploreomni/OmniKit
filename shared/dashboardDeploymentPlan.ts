import type { DashboardSafeCopyIntent, DashboardSafeCopyDeployment } from './dashboardSafeCopyContract';
import type { DashboardReadinessStage } from './dashboardReadiness';

export type DashboardReadinessStatus = 'ready' | 'model_changes_required' | 'unverified' | 'needs_recheck';
export type DashboardFindingCategory = 'included_with_dashboard' | 'topic_mapping_required' | 'model_migrator' | 'cannot_verify';
export interface DashboardDependencyFinding {
  id: string;
  kind: 'field' | 'view' | 'query_view' | 'topic' | 'relationship' | 'model' | 'security' | 'connection' | 'document';
  reference: string;
  message: string;
  documentIds: string[];
  sourceFileName?: string;
  targetFileName?: string;
  category?: DashboardFindingCategory;
  sourceScope?: 'shared' | 'workbook' | 'inherited';
  /** Stable diagnostic identity; messages are presentation, not identity. */
  causeCode?: string;
  rootCauseId?: string;
}
export interface DashboardTopicChoice {
  sourceTopicName: string;
  candidates: Array<{ name: string; label?: string; fileName?: string }>;
  sourceCandidates?: Array<{ name: string; label?: string; fileName?: string }>;
  documentIds: string[];
}
export interface DashboardDeploymentTargetReadiness {
  targetId: string;
  status: DashboardReadinessStatus;
  findings: DashboardDependencyFinding[];
  sourceModelIds: string[];
  requiredFiles: string[];
  requiredFilesByModelId: Record<string, string[]>;
  checkedAt: number;
  modelHash?: string;
  repairJobId?: string;
  deploymentJobId?: string;
  topicChoices?: DashboardTopicChoice[];
}
export interface DashboardDeploymentPlan {
  version: 2;
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  intent: DashboardSafeCopyIntent;
  requestIntentHash?: string;
  sourceHashes: Record<string, string>;
  sourceModelHashes: Record<string, string>;
  targets: DashboardDeploymentTargetReadiness[];
  /** Older snapshots must be rechecked, never silently upgraded for dispatch. */
  evidenceVersion?: number;
  workbookCopies?: DashboardSafeCopyDeployment['workbookCopies'];
  /** Approval receipts only, never YAML. A staged branch is not a deployed topic. */
  topicRepairReceipts?: Array<{
    targetId: string;
    sourceModelId: string;
    sourceTopicName: string;
    targetTopicName: string;
    targetFileName: string;
    topicHash: string;
    sourceModelHash: string;
    sourceHashes: Record<string, string>;
    sourceWorkbookHashes: Record<string, string>;
    relationEvidence?: { source: Record<string, string>; target: Record<string, string> };
    sourceRelationInventoryHash?: string;
    targetViewBindings?: Record<string, string>;
    jobId: string;
  }>;
  readinessRun?: {
    id: string;
    status: 'running' | 'canceled' | 'timed_out' | 'failed' | 'complete';
    startedAt: number;
    finishedAt?: number;
    stage?: DashboardReadinessStage;
    elapsedMs?: number;
  };
}
export interface DashboardDeploymentHandoff {
  version: 2;
  source: 'dashboard_deployment_plan';
  planId: string;
  targetId: string;
}
