/** Topic-first migration contracts. Identifiers are scoped to the exact model pair. */
export interface TopicMigrationPair {
  sourceInstanceId: string;
  sourceConnectionId: string;
  sourceModelId: string;
  targetInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
}

export interface TopicMigrationTopic {
  id: string;
  name: string;
  fileName: string;
  description?: string;
  baseView?: string;
  unavailableReason?: string;
}

export interface TopicMigrationRequest extends TopicMigrationPair {
  topicIds: string[];
  schemaMapText: string;
  /** Explicit source authored file -> destination authored file identity mappings. */
  fileMappings?: Record<string, string>;
  /** Human-reviewed corrections, never accepted from an unbound execution request. */
  reviewedSqlFiles?: Record<string, string>;
  /** Explicit physical bindings, keyed by the authored source view path. */
  tableMappings?: Record<string, { targetTable: string; columnMappings?: Record<string, string> }>;
  /** Explicit per-view destination preservation, bound to complete authored snapshots. */
  keepDestinationDefinitions?: Record<string, TopicMigrationPreservationOption>;
}

export interface TopicMigrationPreservationOption {
  destinationFileName: string;
  sourceHash: string;
  targetHash: string;
}

export interface TopicMigrationPhysicalTable {
  name: string;
  fileName: string;
  columns: string[];
}

export interface TopicMigrationPhysicalRequirement {
  fileName: string;
  sourceTable?: string;
  targetTable?: string;
  requiredColumns: string[];
  status: 'verified' | 'unresolved';
}

export interface TopicMigrationSchemaEvidence {
  status: 'available' | 'unavailable' | 'ambiguous' | 'unsupported';
  message: string;
}

export interface TopicMigrationPhysicalReview {
  evidence: TopicMigrationSchemaEvidence;
  tables: TopicMigrationPhysicalTable[];
  requirements: TopicMigrationPhysicalRequirement[];
}

export interface TopicMigrationIssue {
  id: string;
  kind: 'source' | 'mapping' | 'conflict' | 'sql' | 'security' | 'validation';
  severity: 'blocker' | 'review' | 'info';
  title: string;
  message: string;
  nextAction: string;
  topicIds: string[];
  fileName?: string;
}

export interface TopicMigrationDependency {
  fileName: string;
  kind: 'topic' | 'view' | 'relationships' | 'model';
  topicIds: string[];
  reasons: string[];
}

export interface TopicMigrationFile {
  sourceFileName: string;
  fileName: string;
  /** Grouped topics are written by semantic basename and read back at their full export key. */
  writeFileName?: string;
  /** Exact expected authored path after the explicitly reviewed namespace substitution. */
  destinationFileName?: string;
  kind: TopicMigrationDependency['kind'];
  topicIds: string[];
  before: string | null;
  proposed: string;
  /** Source-scoped correction input, before preserving destination-only additions. */
  sqlReviewDraft?: string;
  previousChecksum?: string;
  /** Server-derived eligibility, not a claim that source and destination behavior are equivalent. */
  preservationOption?: TopicMigrationPreservationOption;
  destinationPreservation?: { keptPaths: string[]; addedPaths: string[]; omittedSourcePaths?: string[] };
  /** Case-only physical table spelling confirmed in the selected destination namespace. */
  tableNameCorrection?: { namespace: string; from: string; to: string };
  /** Bounded dialect checks; corrections are part of the approved YAML, not warehouse validation. */
  sqlDialectReview?: {
    corrections: Array<{ path: string; from: string; to: string }>;
    findings: Array<{ path: string; reason: string }>;
  };
  status: 'create' | 'add' | 'reuse' | 'blocked';
}

export interface TopicMigrationAnalysis {
  topics: TopicMigrationTopic[];
  dependencies: TopicMigrationDependency[];
  files: TopicMigrationFile[];
  issues: TopicMigrationIssue[];
  sourceHash: string;
  targetHash: string;
  /** Binds optional destination table-name metadata to this exact review, not warehouse validity. */
  tableNameEvidenceHash?: string;
  /** Server-derived dialect metadata and rule version bound to this approval. */
  sqlDialectPolicy?: { version: 'column_identifiers_v1'; sourceDialect: string; targetDialect: string };
  physical?: TopicMigrationPhysicalReview;
}

export interface TopicMigrationPlan extends TopicMigrationAnalysis {
  version: 1 | 2;
  /** Version 1 is historical evidence only and can never authorize execution. */
  executionProfile?: 'branch_preparation_v1';
  dashboardRepair?: { planId: string; targetId: string; revision: number };
  branchReceipt?: BranchPreparationReceipt;
  id: string;
  revision: string;
  request: TopicMigrationRequest;
  createdAt: number;
  expiresAt: number;
  status: 'blocked' | 'ready' | 'unchanged' | 'submitted';
  jobId?: string;
  /** Fresh analysis only; never an approval to replay or replace the referenced run. */
  comparisonOnly?: { ofPlanId: string; priorRuns: Array<{ planId: string; jobId?: string; branchName: string }> };
  /** Native model namespace suggestions only, never table/column validation evidence. */
  dataLocations?: { source?: string[]; target?: string[] };
}

export interface BranchPreparationReceipt {
  modelId: string;
  branchId: string;
  branchName: string;
}

export interface TopicBranchVerificationFinding {
  code: string;
  fileName?: string;
  message: string;
}

export interface TopicBranchFileComparison {
  sourceFileName: string;
  submittedFileName: string;
  destinationFileName: string;
  classification: 'exact' | 'mapped_path' | 'formatting_only' | 'mapped_path_and_formatting' | 'mismatch';
}

export interface TopicBranchComparison {
  policy: 'topic_branch_readback_v1';
  verified: boolean;
  expectedHash: string;
  /** Null means authoritative branch bytes could not be read, not an empty branch. */
  actualHash: string | null;
  files: TopicBranchFileComparison[];
  findings: TopicBranchVerificationFinding[];
}

/** Separate read-only observation; never rewrites or reauthorizes the original execution. */
export interface BranchVerificationRecord extends TopicBranchComparison {
  version: 1;
  requestId: string;
  planId: string;
  planRevision: string;
  jobId: string;
  targetInstanceId: string;
  modelId: string;
  branchId: string;
  branchName: string;
  verifiedAt: number;
  sourceHash: string;
  mainHash: string;
  jobEvidenceHash: string;
}

export interface BranchPreparationBinding {
  profile: 'branch_preparation_v1';
}

export interface TopicMigrationExecutionBinding {
  planId: string;
  revision: string;
  request: TopicMigrationRequest;
  sourceHash: string;
  targetHash: string;
  filesHash: string;
  instanceBoundaryHash: string;
  topicIds: string[];
}
