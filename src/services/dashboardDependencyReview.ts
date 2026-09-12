import type { DashboardDependencyFinding, DashboardDeploymentTargetReadiness, DashboardFindingCategory } from '../../shared/dashboardDeploymentPlan';

export const DASHBOARD_FINDING_CATEGORY_COPY: Record<DashboardFindingCategory, { title: string; description: string }> = {
  included_with_dashboard: { title: 'Workbook-local definitions identified', description: 'These definitions belong to the source dashboard workbook, not a shared-model repair. Identifying them does not mean they can be copied: workbook-copy capability is not verified, so affected destinations remain blocked. Keep intentional local definitions in their original scope.' },
  topic_mapping_required: { title: 'Review a destination topic', description: 'Choose the intended existing destination topic after reviewing its meaning. A candidate name is not evidence of equivalent fields, joins, filters, or access.' },
  model_migrator: { title: 'Review in Model Migrator', description: 'These shared-model changes require a separate model review. Dashboard plan choices do not write model definitions.' },
  cannot_verify: { title: 'Cannot verify yet', description: 'Missing or ambiguous evidence keeps this destination blocked. It does not establish that the source dashboard is broken.' },
};

/** Categories organize server evidence; they never override the destination readiness status. */
export function groupDashboardReadinessFindings(readiness: DashboardDeploymentTargetReadiness): Record<DashboardFindingCategory, DashboardDependencyFinding[]> {
  const groups: Record<DashboardFindingCategory, DashboardDependencyFinding[]> = { included_with_dashboard: [], topic_mapping_required: [], model_migrator: [], cannot_verify: [] };
  for (const finding of readiness.findings) {
    const category = finding.category && Object.prototype.hasOwnProperty.call(groups, finding.category) ? finding.category : 'cannot_verify';
    groups[category].push(finding);
  }
  return groups;
}

export interface DashboardReadinessCauseGroup {
  id: string;
  message: string;
  findings: DashboardDependencyFinding[];
  references: string[];
  documentIds: string[];
}

/** Exact server root causes compact repeated observations, without hiding independent blockers. */
export function groupDashboardReadinessCauses(findings: DashboardDependencyFinding[]): DashboardReadinessCauseGroup[] {
  const groups = new Map<string, DashboardReadinessCauseGroup>();
  for (const finding of findings) {
    // Security remains independent even if an older producer reuses another cause ID.
    const family = finding.kind === 'security' ? 'security' : 'dependency';
    const key = JSON.stringify([finding.category || 'cannot_verify', finding.sourceScope || 'unknown', family,
      finding.rootCauseId ? ['root', finding.rootCauseId] : ['reason', finding.causeCode || '', finding.kind, finding.message]]);
    let group = groups.get(key);
    if (!group) {
      group = { id: key, message: finding.message, findings: [], references: [], documentIds: [] };
      groups.set(key, group);
    }
    group.findings.push(finding);
    if (!group.references.includes(finding.reference)) group.references.push(finding.reference);
    for (const documentId of finding.documentIds) if (!group.documentIds.includes(documentId)) group.documentIds.push(documentId);
  }
  return [...groups.values()];
}

export interface DashboardDependencyReviewGroup {
  id: string;
  title: string;
  description: string;
  nextStep: string;
  /** Complete original records, including repeated observations and their document links. */
  findings: DashboardDependencyFinding[];
  /** Compact display references, deduplicated by finding kind and exact reference. */
  references: string[];
}

export interface DashboardDependencyReview {
  unverified: DashboardDependencyReviewGroup[];
  differences: DashboardDependencyReviewGroup[];
  ready: DashboardDependencyReviewGroup[];
  totalFindings: number;
}

type ReviewFamily = 'source' | 'source_field' | 'proposed_change' | 'destination' | 'join' | 'topic' | 'access' | 'scope' | 'unknown';
type GroupCopy = Pick<DashboardDependencyReviewGroup, 'title' | 'description' | 'nextStep'>;

// These are complete server-produced reasons, not substring guesses about a
// dependency's state. New wording stays unverified until its evidence is known.
const SOURCE_REASONS = new Set([
  'The authored source definition could not be located. This does not prove the field is absent; review the source model, workbook-local or inherited semantics.',
  'This field cannot be traced to an authored source definition.',
  'A required source file could not be read.',
  'The authored source join definition could not be located. Review inherited or workbook-local semantics before preparing a repair.',
  'The source shared-model binding could not be established.',
  'Verified source YAML is required to create this field.',
  'One exact source topic file is required for an automatic topic copy.',
]);

const PROPOSED_CHANGE_REASONS = new Set([
  'The proposed model update would replace an existing definition and needs explicit Model Migrator review. No model changes were made by this readiness check.',
  'Destructive semantic patches cannot be automated.',
  'A generated field write lacks an exact validated semantic patch.',
  'A generated query-view write lacks an exact validated semantic patch.',
  'A generated topic write lacks an exact validated semantic patch.',
  'A generated relationship write lacks an exact validated semantic patch.',
  'This dependency requires a reviewed Model Migrator change before dashboard deployment.',
  'The semantic patch lacks bounded recommended or source YAML.',
  'The semantic patch is not a fresh automatic recommendation.',
  'The semantic patch safety category requires manual review.',
  'Existing manual or unsafe semantic decisions cannot be automated.',
]);

const DIRECT_COMPARISONS = new Map<string, readonly DashboardDependencyFinding['kind'][]>([
  ['The required field is missing or has different authored semantics in the destination.', ['field']],
  ['A required view setting differs from the source.', ['view']],
  ['The required file has missing or different semantic settings.', ['topic', 'model']],
  ['A source join path is missing or differs in the destination.', ['relationship']],
  ['The authored definition for a required join view could not be located in the destination.', ['view']],
  ['A model-level calculation or security setting differs and must be reviewed.', ['model']],
]);

const UNVERIFIED_COPY: Record<ReviewFamily, GroupCopy> = {
  source_field: {
    title: 'Source definitions need verification',
    description: 'The exact field definition has not been established from the available source evidence. A workbook-local definition or an outdated dashboard reference may explain the gap; this finding does not prove the source dashboard is broken or the destination is missing the field.',
    nextStep: 'Inspect the exact view-qualified field in the source dashboard workbook, including local and inherited definitions. Retain intentional workbook-local definitions in their original scope; review workbook-copy support and staging evidence in the dashboard plan, without promoting them to a shared model merely to migrate. If the dashboard reference is outdated, correct it after the dashboard owner confirms the intended field. A similarly named field in another view is not an equivalent replacement without semantic review. Recheck readiness after reviewed changes or evidence updates.',
  },
  source: {
    title: 'Source definitions need verification',
    description: 'The source definition or its evidence could not be established. This does not show that the destination is missing the dependency.',
    nextStep: 'Inspect the source model and dashboard workbook, including local and inherited definitions. Resolve the source evidence before deciding on destination changes.',
  },
  proposed_change: {
    title: 'Proposed model changes need review',
    description: 'The proposed change has not been established as a safe, reviewed repair. A proposed replacement is not evidence that a replacement occurred.',
    nextStep: 'Inspect the source and destination model definitions in Omni with the model owner. Confirm the intended change and its impact before preparing a repair here.',
  },
  destination: {
    title: 'Destination differences need verification',
    description: 'A possible destination difference was reported, but the available review does not establish a complete comparison.',
    nextStep: 'Resolve the missing or ambiguous evidence, then compare the listed definitions again before preparing destination changes.',
  },
  join: {
    title: 'Joins need verification',
    description: 'The listed join dependencies still need a verified source definition, path, or destination comparison.',
    nextStep: 'Inspect the source join path and its view definitions. Resolve ambiguous paths and review the matching destination relationships.',
  },
  topic: {
    title: 'Topics need verification',
    description: 'The topic dependency does not yet have enough verified evidence for a destination repair.',
    nextStep: 'Inspect the source topic and its referenced views, then confirm the intended destination topic and mapping.',
  },
  access: {
    title: 'Access settings need review',
    description: 'Access and security findings require explicit review; they are not an automatic model repair.',
    nextStep: 'Review the listed access settings, filters, and user-attribute rules with the model owner before approving changes.',
  },
  scope: {
    title: 'Dependency scope needs verification',
    description: 'The available evidence does not establish the complete model, document, or destination scope for this check.',
    nextStep: 'Confirm the source and destination bindings, required files, and access to them. Resolve the reported scope gap before rechecking.',
  },
  unknown: {
    title: 'Needs verification',
    description: 'This finding has no recognized evidence classification. It is not a confirmed difference or a passed check.',
    nextStep: 'Review the original reason and referenced definition. Establish the missing evidence before choosing a model change.',
  },
};

const DIFFERENCE_COPY: Partial<Record<ReviewFamily, GroupCopy>> = {
  destination: {
    title: 'Destination definitions differ',
    description: 'The authored comparison reports a required definition or setting that is missing or different in the destination.',
    nextStep: 'Review the source and destination definitions and approve the intended change in Model Migrator, then recheck dashboard readiness.',
  },
  join: {
    title: 'Destination joins differ',
    description: 'The authored comparison reports a required join path or join view that is missing or different in the destination.',
    nextStep: 'Review the join fields, path, and relationship behavior before preparing the destination change.',
  },
  topic: {
    title: 'Destination topics differ',
    description: 'The authored comparison reports missing or different semantic settings for a required destination topic.',
    nextStep: 'Review the topic settings and referenced views in Model Migrator, approve the intended change, then recheck.',
  },
};

function familyFor(finding: DashboardDependencyFinding): ReviewFamily {
  if (finding.causeCode === 'SOURCE_FILE_UNAVAILABLE') return finding.kind === 'field' ? 'source_field' : 'source';
  if (SOURCE_REASONS.has(finding.message)) return finding.kind === 'field' ? 'source_field' : 'source';
  if (PROPOSED_CHANGE_REASONS.has(finding.message)) return 'proposed_change';
  if (finding.kind === 'security') return 'access';
  if (finding.kind === 'relationship' || finding.message === 'The authored definition for a required join view could not be located in the destination.') return 'join';
  if (finding.kind === 'topic') return 'topic';
  if (finding.kind === 'connection' || finding.kind === 'document' || finding.reference === 'mapped_repair_scope') return 'scope';
  if (DIRECT_COMPARISONS.get(finding.message)?.includes(finding.kind)) return 'destination';
  return 'unknown';
}

function isScopedDirectComparison(finding: DashboardDependencyFinding, readiness: DashboardDeploymentTargetReadiness): boolean {
  return Boolean(DIRECT_COMPARISONS.get(finding.message)?.includes(finding.kind)
    && finding.sourceFileName
    && finding.targetFileName
    && readiness.sourceModelIds.length > 0
    && readiness.requiredFiles.includes(finding.sourceFileName));
}

/** Organizes existing evidence for review; it cannot change readiness or authorize a repair. */
export function buildDashboardDependencyReview(readiness: DashboardDeploymentTargetReadiness): DashboardDependencyReview {
  const result: DashboardDependencyReview = { unverified: [], differences: [], ready: [], totalFindings: readiness.findings.length };
  // Legacy findings have no individual pass/verification discriminator. Do not
  // promote one apparent comparison while other findings undermine its scope.
  const comparisonsEstablished = readiness.status === 'model_changes_required'
    && readiness.findings.length > 0
    && readiness.findings.every((finding) => isScopedDirectComparison(finding, readiness));
  const groups = new Map<string, DashboardDependencyReviewGroup>();
  const seenReferences = new Map<string, Set<string>>();
  for (const finding of readiness.findings) {
    const family = familyFor(finding);
    const bucket = comparisonsEstablished ? 'differences' : 'unverified';
    const reasonKey = JSON.stringify([finding.kind, finding.message]);
    const id = `${bucket}:${encodeURIComponent(reasonKey)}`;
    let group = groups.get(id);
    if (!group) {
      const copy = comparisonsEstablished ? DIFFERENCE_COPY[family] || DIFFERENCE_COPY.destination! : UNVERIFIED_COPY[family];
      group = { id, ...copy, findings: [], references: [] };
      groups.set(id, group);
      seenReferences.set(id, new Set());
      result[bucket].push(group);
    }
    group.findings.push(finding);
    const referenceKey = JSON.stringify([finding.kind, finding.reference]);
    if (!seenReferences.get(id)!.has(referenceKey)) {
      seenReferences.get(id)!.add(referenceKey);
      group.references.push(finding.reference);
    }
  }
  // Empty findings, even on a ready target, do not identify individual passes.
  return result;
}
