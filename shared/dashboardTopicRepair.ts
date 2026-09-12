/** Review-only reconstruction from server-verified authored shared-model snapshots. */
export interface DashboardTopicRepairDraftInput {
  sourceTopicName: string;
  targetTopicName: string;
  baseView?: string;
  /** Explicit choices from a prior preview, keyed by the offered required view. */
  selectedJoinPaths?: Record<string, string>;
  states: Record<string, unknown>[];
  /** Shared authored YAML only. Never pass workbook extensions or resolved YAML. */
  sourceFiles: Record<string, string>;
  targetFiles: Record<string, string>;
  /** Server-read inventory names; these never become fabricated authored files. */
  sourceRelationNames?: string[];
  targetRelationNames?: string[];
  /** Observed identities include unverified entries: existence is not permission to reuse. */
  sourceObservedRelationNames?: string[];
  targetObservedRelationNames?: string[];
  /** Exact index bindings from canonical view names to authored file paths. */
  sourceViewFileNames?: Record<string, string[]>;
  targetViewFileNames?: Record<string, string[]>;
}

export interface DashboardTopicRepairDraftFile {
  fileName: string;
  original: string | null;
  proposed: string;
  kind: 'topic' | 'view' | 'relationship';
  status: 'new' | 'additive' | 'unchanged' | 'conflict';
  message?: string;
}

export interface DashboardTopicRepairDraft {
  sourceTopicName: string;
  targetTopicName: string;
  baseView?: string;
  baseViewCandidates: string[];
  /** Submitted choices are review intent, not proof that their paths remain valid. */
  selectedJoinPaths?: Record<string, string>;
  joinPathChoices?: DashboardTopicJoinPathChoice[];
  files: DashboardTopicRepairDraftFile[];
  blockers: string[];
  requiredViews: string[];
  /** Includes attempted/unverified relation identities for diagnostic scoping, not authored files to create. */
  requiredInventoryNames?: string[];
  /** Expected unique authored destination bindings for post-publication readback. */
  targetViewBindings?: Record<string, string>;
  reusedRelations?: string[];
  baseViewReason?: string;
  inventoryDiagnostics?: DashboardTopicInventoryDiagnostic[];
}

export interface DashboardTopicJoinPath {
  /** SHA-256 identity of base, required view, and ordered authored edge values. */
  id: string;
  views: string[];
  edges: Array<{ fromView: string; toView: string; authoredYaml: string }>;
}

export interface DashboardTopicJoinPathChoice {
  requiredView: string;
  paths: DashboardTopicJoinPath[];
  /** False means bounded traversal did not establish a complete choice set. */
  complete: boolean;
  /** A unique path or a valid explicit selection; not an independent approval. */
  selectedPathId?: string;
}

/** Only bounded category/count diagnostics cross the browser boundary, never raw inventory entries. */
export interface DashboardTopicInventoryDiagnostic {
  side: 'source' | 'destination';
  severity: 'warning' | 'blocker';
  code: string;
  count: number;
  message: string;
}

/** Immutable evidence for inherited relations reused without writing their definitions. */
export interface DashboardTopicRelationEvidence {
  source: Record<string, string>;
  target: Record<string, string>;
}

export interface DashboardTopicRepairPreview extends DashboardTopicRepairDraft {
  reviewId: string;
  reviewHash: string;
  revision: number;
  targetId: string;
  expiresAt: number;
}
