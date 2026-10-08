import type { DashboardPackageBindingMapping } from './dashboardPackageBindings';

/** Public package summaries contain no authored YAML, credentials, or query results. */
export interface DashboardPackageFileSummary {
  fileName: string;
  sourceFileName: string;
  action: 'create' | 'add' | 'reuse' | 'conflict';
  reason?: string;
}
export interface DashboardPackageIssue { code: string; reference: string; message: string }
export interface DashboardPackageSummary {
  version: 1;
  fingerprint: string;
  documents: Array<{ sourceDocumentId: string; name: string; localModelCount: number }>;
  files: DashboardPackageFileSummary[];
  issues: DashboardPackageIssue[];
  /** Exact physical binding comparisons; never table, SQL, or security rewrites. */
  bindingMappings?: DashboardPackageBindingMapping[];
  requiresPr?: boolean;
}
export interface DashboardPackagePreview extends DashboardPackageSummary {
  files: Array<DashboardPackageFileSummary & { before: string; after: string; sourceComparison?: string }>;
}
export interface DashboardPackageTargetResult {
  targetId: string;
  status: 'verified' | 'needs_review' | 'uncertain' | 'failed' | 'waiting_approval';
  stage: string;
  message?: string;
  branchId?: string;
  branchName?: string;
  documents: Array<{ sourceDocumentId: string; name: string; documentId?: string; identifier?: string;
    url?: string; status: 'verified' | 'needs_review' | 'uncertain' | 'failed'; message?: string;
    /** Derived from an exact returned import receipt, never from an allocated identifier. */
    created?: boolean;
    /** Server-authorized verification of the retained copy; never permission to reimport. */
    canVerifyExistingCopy?: boolean }>;
}
