import type {
  MigrationFieldCandidate,
  MigrationDependencyProposalWithheld,
  MigrationFieldDependency,
  MigrationFieldMapping,
  MigrationPermissionDecision,
  MigrationPermissionDependency,
  MigrationPlan,
  MigrationPlanStep,
  MigrationQueryViewMapping,
  MigrationSemanticPatch,
  MigrationTarget,
  MigrationTopicMapping,
} from './migrationJobs';

const MAX_PATCH_YAML_CHARACTERS = 250_000;
const MAX_TOTAL_PATCH_YAML_CHARACTERS = 1_000_000;

const FORBIDDEN_PERMISSION_KINDS = new Set<MigrationPermissionDependency['kind']>([
  'document_access',
  'document_settings',
  'folder_access',
  'model_role',
  'user_attribute',
  'user_attribute_coverage',
  'omni_attribute_reference',
  'user_group',
  'group_membership',
]);

export type DashboardSafeCopyTargetExceptionCode =
  | 'TARGET_SCOPE_MISMATCH'
  | 'UNSAFE_TARGET_CONFIGURATION'
  | 'AMBIGUOUS_MAPPING'
  | 'MISSING_EVIDENCE'
  | 'BLOCKED_DEPENDENCY'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'SECURITY_REVIEW_REQUIRED'
  | 'DESTRUCTIVE_CHANGE'
  | 'YAML_LIMIT_EXCEEDED';

export type DashboardSafeCopyTargetExceptionArtifact =
  | 'target'
  | 'field'
  | 'query_view'
  | 'topic'
  | 'permission'
  | 'relationship'
  | 'semantic_patch';

export interface DashboardSafeCopyTargetException {
  targetId: string;
  code: DashboardSafeCopyTargetExceptionCode;
  artifact: DashboardSafeCopyTargetExceptionArtifact;
  reference: string;
  message: string;
  sourceProvenance?: MigrationFieldDependency['sourceProvenance'];
  sourceFileName?: string;
  sourceDocumentIds?: string[];
}

export type DashboardSafeCopyResolverResult =
  | {
    status: 'resolved';
    target: MigrationTarget;
  }
  | {
    status: 'exception';
    targetId: string;
    exceptions: DashboardSafeCopyTargetException[];
  };

interface RequiredQueryViewEvidence {
  name: string;
  sourceFileName?: string;
  targetFileName?: string;
  status: 'exact_target_match' | 'missing_copyable' | 'missing_source_yaml' | 'blocked';
  compatibility?: {
    status?: string;
  };
}

interface SourceTopicEvidence {
  name: string;
  id?: string;
  fileName?: string;
}

interface CollectedPlanEvidence {
  fieldDependencies: MigrationFieldDependency[];
  queryViews: RequiredQueryViewEvidence[];
  queryViewMappings: MigrationQueryViewMapping[];
  topics: SourceTopicEvidence[];
  topicMappings: MigrationTopicMapping[];
  permissionDependencies: MigrationPermissionDependency[];
  semanticPatches: MigrationSemanticPatch[];
  proposalsWithheld: MigrationDependencyProposalWithheld[];
  relationshipBlocked: boolean;
  relationshipRequired: boolean;
  topicCompatibilityBlocked: boolean;
  waiverFound: boolean;
  invalidEvidenceFound: boolean;
  unexplainedBlockedStep: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanReference(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = [...value.trim()]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .slice(0, 256);
  return cleaned || fallback;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function normalizedFieldToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizedFieldTokenVariants(value: string): Set<string> {
  const normalized = normalizedFieldToken(value);
  const variants = new Set([normalized]);
  if (normalized.startsWith('semantic') && normalized.length > 'semantic'.length) {
    variants.add(normalized.slice('semantic'.length));
  }
  return variants;
}

function splitFieldRef(value: string): { viewName: string; fieldName: string } {
  const [viewName, ...fieldParts] = value.trim().split('.');
  return { viewName: viewName || '', fieldName: fieldParts.join('.') };
}

function fieldKindsAreCompatible(
  dependency: MigrationFieldDependency,
  candidate: MigrationFieldCandidate,
): boolean {
  return dependency.fieldKind === 'unknown'
    || !candidate.fieldKind
    || candidate.fieldKind === 'unknown'
    || candidate.fieldKind === dependency.fieldKind;
}

function strongFieldCandidate(
  dependency: MigrationFieldDependency,
  candidate: MigrationFieldCandidate,
): boolean {
  if (!fieldKindsAreCompatible(dependency, candidate)) return false;
  if (
    candidate.matchType === 'exact'
    && normalizedName(candidate.fieldRef) === normalizedName(dependency.sourceFieldRef)
  ) return true;
  if (candidate.matchType !== 'field_name' && candidate.matchType !== 'normalized') return false;
  const source = splitFieldRef(dependency.sourceFieldRef);
  const target = splitFieldRef(candidate.fieldRef);
  if (
    normalizedFieldToken(target.viewName)
    !== normalizedFieldToken(dependency.sourceViewName || source.viewName)
  ) return false;
  const sourceNames = normalizedFieldTokenVariants(dependency.sourceFieldName || source.fieldName);
  return [...normalizedFieldTokenVariants(target.fieldName)].some((name) => sourceNames.has(name));
}

function hasAccessBoost(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAccessBoost);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    return normalizedKey === 'accessboost' || normalizedKey === 'accessboostable'
      ? item === true
      : hasAccessBoost(item);
  });
}

function isFieldDependency(value: unknown): value is MigrationFieldDependency {
  return isRecord(value)
    && typeof value.sourceFieldRef === 'string'
    && typeof value.sourceViewName === 'string'
    && typeof value.sourceFieldName === 'string'
    && Array.isArray(value.targetCandidates)
    && (value.sourceDocumentId === undefined || typeof value.sourceDocumentId === 'string')
    && (value.sourceProvenance === undefined || ['shared_authored', 'workbook_local', 'workbook_override', 'inherited_unverified', 'unverified'].includes(String(value.sourceProvenance)));
}

function isWithheldProposal(value: unknown): value is MigrationDependencyProposalWithheld {
  return isRecord(value) && ['field', 'query_view', 'topic', 'relationship'].includes(String(value.artifact))
    && typeof value.reference === 'string' && Boolean(value.reference.trim())
    && typeof value.reason === 'string' && Boolean(value.reason.trim())
    && typeof value.sourceDocumentId === 'string' && Boolean(value.sourceDocumentId.trim());
}

function isQueryViewEvidence(value: unknown): value is RequiredQueryViewEvidence {
  return isRecord(value)
    && typeof value.name === 'string'
    && (
      value.status === 'exact_target_match'
      || value.status === 'missing_copyable'
      || value.status === 'missing_source_yaml'
      || value.status === 'blocked'
    );
}

function isQueryViewMapping(value: unknown): value is MigrationQueryViewMapping {
  return isRecord(value)
    && typeof value.sourceQueryViewName === 'string'
    && typeof value.targetQueryViewName === 'string'
    && (
      value.action === 'map_existing'
      || value.action === 'copy_source'
      || value.action === 'use_existing_unverified'
      || value.action === 'update_existing'
    );
}

function isSourceTopic(value: unknown): value is SourceTopicEvidence {
  return isRecord(value)
    && typeof value.name === 'string'
    && (value.id === undefined || typeof value.id === 'string')
    && (value.fileName === undefined || typeof value.fileName === 'string');
}

function isTopicMapping(value: unknown): value is MigrationTopicMapping {
  return isRecord(value)
    && typeof value.sourceTopicName === 'string'
    && (value.sourceTopicId === undefined || typeof value.sourceTopicId === 'string')
    && typeof value.targetTopicName === 'string'
    && (value.action === 'map_existing' || value.action === 'copy_source');
}

function isPermissionDependency(value: unknown): value is MigrationPermissionDependency {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.sourceRef === 'string'
    && Array.isArray(value.targetCandidates);
}

function isSemanticPatch(value: unknown): value is MigrationSemanticPatch {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.artifactType === 'string'
    && typeof value.targetFileName === 'string';
}

function pushArrayEvidence<T>(
  details: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
  output: T[],
): boolean {
  const raw = details[key];
  if (raw === undefined) return false;
  if (!Array.isArray(raw)) return true;
  let invalid = false;
  for (const value of raw) {
    if (guard(value)) output.push(value);
    else invalid = true;
  }
  return invalid;
}

function planStepMatchesTargetScope(step: MigrationPlanStep, target: MigrationTarget): boolean {
  return step.targetId === target.id
    && step.destinationId === target.destinationInstanceId
    && (step.targetConnectionId || '') === (target.targetConnectionId || '')
    && step.targetModelId === target.targetModelId
    && (step.targetFolderId || '') === (target.targetFolderId || '')
    && (step.targetFolderPath || '') === (target.targetFolderPath || '');
}

function collectPlanEvidence(plan: MigrationPlan, target: MigrationTarget): CollectedPlanEvidence {
  const evidence: CollectedPlanEvidence = {
    fieldDependencies: [],
    queryViews: [],
    queryViewMappings: [],
    topics: [],
    topicMappings: [],
    permissionDependencies: [],
    semanticPatches: [],
    proposalsWithheld: [],
    relationshipBlocked: false,
    relationshipRequired: false,
    topicCompatibilityBlocked: false,
    waiverFound: false,
    invalidEvidenceFound: false,
    unexplainedBlockedStep: false,
  };
  for (const step of plan.steps.filter((candidate) => planStepMatchesTargetScope(candidate, target))) {
    if (!step.details) {
      if (step.blocked) evidence.unexplainedBlockedStep = true;
      continue;
    }
    const details = step.details;
    const structuredEvidenceKeys = [
      'fieldDependencies',
      'requiredQueryViews',
      'sourceTopics',
      'permissionDependencies',
      'semanticPatches',
      'relationshipEdges',
      'relationshipBlockers',
      'topicCompatibilityBlockers',
      'dependencyProposalsWithheld',
    ];
    if (
      step.blocked
      && !structuredEvidenceKeys.some((key) => Array.isArray(details[key]) && details[key].length > 0)
    ) evidence.unexplainedBlockedStep = true;
    const previousFieldCount = evidence.fieldDependencies.length;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'fieldDependencies',
      isFieldDependency,
      evidence.fieldDependencies,
    ) || evidence.invalidEvidenceFound;
    evidence.fieldDependencies = evidence.fieldDependencies.map((field, index) => index < previousFieldCount ? field : {
      ...field, sourceDocumentId: field.sourceDocumentId || step.documentId,
    });
    evidence.invalidEvidenceFound = pushArrayEvidence(details, 'dependencyProposalsWithheld', isWithheldProposal, evidence.proposalsWithheld) || evidence.invalidEvidenceFound;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'requiredQueryViews',
      isQueryViewEvidence,
      evidence.queryViews,
    ) || evidence.invalidEvidenceFound;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'queryViewMappings',
      isQueryViewMapping,
      evidence.queryViewMappings,
    ) || evidence.invalidEvidenceFound;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'sourceTopics',
      isSourceTopic,
      evidence.topics,
    ) || evidence.invalidEvidenceFound;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'topicMappings',
      isTopicMapping,
      evidence.topicMappings,
    ) || evidence.invalidEvidenceFound;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'permissionDependencies',
      isPermissionDependency,
      evidence.permissionDependencies,
    ) || evidence.invalidEvidenceFound;
    evidence.invalidEvidenceFound = pushArrayEvidence(
      details,
      'semanticPatches',
      isSemanticPatch,
      evidence.semanticPatches,
    ) || evidence.invalidEvidenceFound;
    evidence.relationshipBlocked = evidence.relationshipBlocked
      || (Array.isArray(details.relationshipBlockers) && details.relationshipBlockers.length > 0);
    evidence.relationshipRequired = evidence.relationshipRequired
      || (Array.isArray(details.relationshipEdges) && details.relationshipEdges.length > 0);
    evidence.topicCompatibilityBlocked = evidence.topicCompatibilityBlocked
      || (Array.isArray(details.topicCompatibilityBlockers) && details.topicCompatibilityBlockers.length > 0);
    evidence.waiverFound = evidence.waiverFound
      || (Array.isArray(details.queryValidationWaivers) && details.queryValidationWaivers.length > 0);
  }
  return evidence;
}

function requireWritePatchCoverage(
  targetId: string,
  fieldMappings: readonly MigrationFieldMapping[],
  queryViewMappings: readonly MigrationQueryViewMapping[],
  topicMappings: readonly MigrationTopicMapping[],
  topics: readonly SourceTopicEvidence[],
  relationshipRequired: boolean,
  patches: readonly MigrationSemanticPatch[],
  exceptions: DashboardSafeCopyTargetException[],
  proposalsWithheld: readonly MigrationDependencyProposalWithheld[] = [],
): void {
  const expected = [
    ...fieldMappings
      .filter((candidate) => candidate.action === 'create_from_source')
      .map((mapping) => ({
        artifact: 'field' as const,
        reference: mapping.sourceFieldRef,
        message: 'A generated field write lacks an exact validated semantic patch.',
        matches: (patch: MigrationSemanticPatch) => (
          patch.artifactType === 'field'
          && normalizedName(patch.sourceName || '') === normalizedName(mapping.sourceFieldRef)
          && normalizedName(patch.targetFileName) === normalizedName(mapping.targetFileName || '')
        ),
      })),
    ...queryViewMappings
      .filter((candidate) => candidate.action === 'copy_source')
      .map((mapping) => ({
        artifact: 'query_view' as const,
        reference: mapping.sourceQueryViewName,
        message: 'A generated query-view write lacks an exact validated semantic patch.',
        matches: (patch: MigrationSemanticPatch) => (
          patch.artifactType === 'query_view'
          && normalizedName(patch.sourceName || '') === normalizedName(mapping.sourceQueryViewName)
          && normalizedName(patch.targetFileName) === normalizedName(mapping.targetFileName || '')
        ),
      })),
    ...topicMappings
      .filter((candidate) => candidate.action === 'copy_source')
      .map((mapping) => {
        const sourceFiles = uniqueStrings(topics
          .filter((topic) => normalizedName(topic.name) === normalizedName(mapping.sourceTopicName))
          .map((topic) => topic.fileName));
        const expectedFile = sourceFiles.length === 1 ? sourceFiles[0] : '';
        return {
          artifact: 'topic' as const,
          reference: mapping.sourceTopicName,
          message: 'A generated topic write lacks an exact validated semantic patch.',
          matches: (patch: MigrationSemanticPatch) => (
            Boolean(expectedFile)
            && patch.artifactType === 'topic'
            && normalizedName(patch.sourceName || '') === normalizedName(mapping.sourceTopicName)
            && normalizedName(patch.sourceFileName || '') === normalizedName(expectedFile)
            && normalizedName(patch.targetFileName) === normalizedName(expectedFile)
          ),
        };
      }),
    ...(relationshipRequired ? [{
      artifact: 'relationship' as const,
      reference: 'relationship',
      message: 'A generated relationship write lacks an exact validated semantic patch.',
      matches: (patch: MigrationSemanticPatch) => (
        patch.artifactType === 'relationship'
        && normalizedName(patch.sourceName || '') === 'relationships'
        && normalizedName(patch.sourceFileName || '') === 'relationships'
        && normalizedName(patch.targetFileName) === 'relationships'
      ),
    }] : []),
  ];
  const actual = patches
    .filter((patch) => patch.resolution === 'recommended')
    .map((patch) => ({ patch }));
  const remainingActual = [...actual];
  for (const decision of expected) {
    if (proposalsWithheld.some((withheld) => withheld.artifact === decision.artifact && normalizedName(withheld.reference) === normalizedName(decision.reference))) continue;
    const index = remainingActual.findIndex((candidate) => decision.matches(candidate.patch));
    if (index >= 0) {
      remainingActual.splice(index, 1);
    } else {
      addException(
        exceptions,
        targetId,
        'MISSING_EVIDENCE',
        decision.artifact,
        decision.reference,
        decision.message,
      );
    }
  }
  for (const orphan of remainingActual) {
    addException(
      exceptions,
      targetId,
      'MISSING_EVIDENCE',
      'semantic_patch',
      orphan.patch.sourceName || orphan.patch.targetFileName,
      'A semantic patch has no exact generated dependency decision.',
    );
  }
}

function exceptionSorter(
  left: DashboardSafeCopyTargetException,
  right: DashboardSafeCopyTargetException,
): number {
  return left.artifact.localeCompare(right.artifact)
    || left.reference.localeCompare(right.reference)
    || left.code.localeCompare(right.code);
}

function resultExceptions(
  targetId: string,
  values: DashboardSafeCopyTargetException[],
): DashboardSafeCopyResolverResult {
  const byIdentity = new Map<string, DashboardSafeCopyTargetException>();
  for (const value of values) {
    const key = `${value.artifact}:${value.reference}:${value.code}:${value.sourceProvenance || ''}:${value.sourceFileName || ''}:${value.message}`;
    const previous = byIdentity.get(key);
    const sourceDocumentIds = uniqueStrings([...(previous?.sourceDocumentIds || []), ...(value.sourceDocumentIds || [])]);
    byIdentity.set(key, { ...value, ...(sourceDocumentIds.length ? { sourceDocumentIds } : {}) });
  }
  const deduplicated = [...byIdentity.values()].sort(exceptionSorter);
  return { status: 'exception', targetId, exceptions: deduplicated };
}

function addException(
  exceptions: DashboardSafeCopyTargetException[],
  targetId: string,
  code: DashboardSafeCopyTargetExceptionCode,
  artifact: DashboardSafeCopyTargetExceptionArtifact,
  reference: unknown,
  message: string,
  source?: Pick<DashboardSafeCopyTargetException, 'sourceProvenance' | 'sourceFileName' | 'sourceDocumentIds'>,
): void {
  exceptions.push({
    targetId,
    code,
    artifact,
    reference: cleanReference(reference, artifact),
    message,
    ...source,
  });
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    groups.set(groupKey, [...(groups.get(groupKey) || []), value]);
  }
  return groups;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].sort();
}

function resolveFields(
  targetId: string,
  dependencies: MigrationFieldDependency[],
  exceptions: DashboardSafeCopyTargetException[],
): MigrationFieldMapping[] {
  const mappings: MigrationFieldMapping[] = [];
  for (const [reference, rows] of groupBy(dependencies.filter((dependency) => dependency.status !== 'blocked'), (dependency) => normalizedName(dependency.sourceFieldRef))) {
    if (uniqueStrings(rows.map((row) => row.sourceYaml)).length > 1 || uniqueStrings(rows.map((row) => row.sourceFileName)).length > 1) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'field', reference, 'Field evidence conflicts across source documents.', { sourceDocumentIds: uniqueStrings(rows.map((row) => row.sourceDocumentId)) });
    }
  }
  const groups = groupBy(dependencies, (dependency) => `${normalizedName(dependency.sourceFieldRef)}:${dependency.sourceDocumentId || ''}`);
  for (const [key, rows] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const reference = rows[0]?.sourceFieldRef || key;
    const statuses = uniqueStrings(rows.map((row) => row.status));
    const sourceFiles = uniqueStrings(rows.map((row) => row.sourceFileName));
    const sourceYaml = uniqueStrings(rows.map((row) => row.sourceYaml));
    const sourceViews = uniqueStrings(rows.map((row) => row.sourceViewName));
    const sourceFields = uniqueStrings(rows.map((row) => row.sourceFieldName));
    const fieldKinds = uniqueStrings(rows.map((row) => row.fieldKind));
    const provenances = uniqueStrings(rows.map((row) => row.sourceProvenance));
    const source = {
      sourceDocumentIds: uniqueStrings(rows.map((row) => row.sourceDocumentId)),
      ...(provenances.length === 1 ? { sourceProvenance: provenances[0] as MigrationFieldDependency['sourceProvenance'] } : {}),
      ...(sourceFiles.length === 1 ? { sourceFileName: sourceFiles[0] } : {}),
    };
    if (
      statuses.length !== 1
      || sourceFiles.length > 1
      || sourceYaml.length > 1
      || sourceViews.length !== 1
      || sourceFields.length !== 1
      || fieldKinds.length !== 1
      || provenances.length > 1
    ) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'field', reference, 'Field evidence conflicts across the migration plan.', source);
      continue;
    }
    if (statuses[0] === 'blocked') {
      const reasons = uniqueStrings(rows.map((row) => row.reason));
      for (const reason of reasons.length ? reasons : ['The field dependency is blocked.']) {
        addException(exceptions, targetId, 'BLOCKED_DEPENDENCY', 'field', reference, cleanReference(reason, 'The field dependency is blocked.'), source);
      }
      continue;
    }
    if (statuses[0] === 'warning') {
      addException(exceptions, targetId, 'MANUAL_REVIEW_REQUIRED', 'field', reference, cleanReference(rows[0].reason, 'The field dependency requires manual review.'), source);
      continue;
    }
    const candidates = [...new Map(rows.flatMap((row) => row.targetCandidates)
      .filter((candidate) => strongFieldCandidate(rows[0], candidate))
      .map((candidate) => [normalizedName(candidate.fieldRef), candidate])).values()];
    const exact = candidates.filter((candidate) => (
      candidate.matchType === 'exact'
      && normalizedName(candidate.fieldRef) === normalizedName(reference)
    ));
    const preferred = exact.length > 0 ? exact : candidates;
    if (preferred.length === 1) {
      mappings.push({
        sourceFieldRef: reference,
        action: 'map_existing',
        targetFieldRef: preferred[0].fieldRef,
        ...(sourceFiles[0] ? { sourceFileName: sourceFiles[0] } : {}),
      });
      continue;
    }
    if (preferred.length > 1) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'field', reference, 'More than one strong field match is available.', source);
      continue;
    }
    if (!sourceFiles[0] || !sourceYaml[0]) {
      addException(exceptions, targetId, 'MISSING_EVIDENCE', 'field', reference, 'Verified source YAML is required to create this field.', source);
      continue;
    }
    if (sourceYaml[0].length > MAX_PATCH_YAML_CHARACTERS) {
      addException(exceptions, targetId, 'YAML_LIMIT_EXCEEDED', 'field', reference, 'The source field YAML exceeds the safe-copy limit.', source);
      continue;
    }
    mappings.push({
      sourceFieldRef: reference,
      sourceFileName: sourceFiles[0],
      targetFileName: sourceFiles[0],
      action: 'create_from_source',
    });
  }
  const uniqueMappings = [...new Map(mappings.map((mapping) => [stableJson(mapping), mapping])).values()];
  const conflictingReferences = new Set<string>();
  for (const [reference, rows] of groupBy(uniqueMappings, (mapping) => normalizedName(mapping.sourceFieldRef))) {
    if (rows.length > 1) {
      conflictingReferences.add(reference);
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'field', reference, 'Field mappings conflict across source documents.', {
        sourceDocumentIds: uniqueStrings(dependencies.filter((dependency) => normalizedName(dependency.sourceFieldRef) === reference).map((dependency) => dependency.sourceDocumentId)),
      });
    }
  }
  return uniqueMappings.filter((mapping) => !conflictingReferences.has(normalizedName(mapping.sourceFieldRef))).sort((left, right) => left.sourceFieldRef.localeCompare(right.sourceFieldRef));
}

function resolveQueryViews(
  targetId: string,
  queryViews: RequiredQueryViewEvidence[],
  configured: MigrationQueryViewMapping[],
  exceptions: DashboardSafeCopyTargetException[],
): MigrationQueryViewMapping[] {
  const mappings: MigrationQueryViewMapping[] = [];
  const mappingGroups = groupBy(configured, (mapping) => normalizedName(mapping.sourceQueryViewName));
  const groups = groupBy(queryViews, (queryView) => normalizedName(queryView.name));
  for (const [key, rows] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const reference = rows[0]?.name || key;
    const statuses = uniqueStrings(rows.map((row) => row.status));
    const sourceFiles = uniqueStrings(rows.map((row) => row.sourceFileName));
    const targetFiles = uniqueStrings(rows.map((row) => row.targetFileName));
    if (statuses.length !== 1 || sourceFiles.length > 1 || targetFiles.length > 1) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'query_view', reference, 'Query-view evidence conflicts across the migration plan.');
      continue;
    }
    if (rows.some((row) => row.compatibility?.status && row.compatibility.status !== 'compatible')) {
      addException(exceptions, targetId, 'BLOCKED_DEPENDENCY', 'query_view', reference, 'The query view has unresolved target dependencies.');
      continue;
    }
    const existing = [...new Map((mappingGroups.get(key) || []).map((mapping) => [
      stableJson(mapping),
      mapping,
    ])).values()];
    if (statuses[0] === 'exact_target_match') {
      const exact = existing.filter((mapping) => (
        mapping.action === 'map_existing'
        && normalizedName(mapping.targetQueryViewName) === normalizedName(reference)
      ));
      if (existing.length > 0 && exact.length !== 1) {
        addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'query_view', reference, 'Only one exact query-view mapping can be automated.');
        continue;
      }
      mappings.push(exact[0] || {
        sourceQueryViewName: reference,
        sourceFileName: sourceFiles[0],
        action: 'map_existing',
        targetQueryViewName: reference,
        targetFileName: targetFiles[0],
      });
      continue;
    }
    if (statuses[0] === 'missing_copyable' && sourceFiles[0]) {
      const copies = existing.filter((mapping) => (
        mapping.action === 'copy_source'
        && normalizedName(mapping.targetQueryViewName) === normalizedName(reference)
      ));
      if (existing.length > 0 && copies.length !== 1) {
        addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'query_view', reference, 'Missing query views can only be copied under the source name.');
        continue;
      }
      mappings.push(copies[0] || {
        sourceQueryViewName: reference,
        sourceFileName: sourceFiles[0],
        action: 'copy_source',
        targetQueryViewName: reference,
        targetFileName: sourceFiles[0],
      });
      continue;
    }
    addException(
      exceptions,
      targetId,
      statuses[0] === 'blocked' ? 'BLOCKED_DEPENDENCY' : 'MISSING_EVIDENCE',
      'query_view',
      reference,
      'The query view cannot be resolved from verified source evidence.',
    );
  }
  return mappings.sort((left, right) => left.sourceQueryViewName.localeCompare(right.sourceQueryViewName));
}

/** Read-only candidates, not accepted decisions. Final resolution still checks
 * all evidence, patch coverage, permissions, checksums and destination scope. */
export function dashboardSafeCopyDependencyPatchCandidates(input: {
  fieldDependencies?: MigrationFieldDependency[];
  queryViews?: RequiredQueryViewEvidence[];
  configuredQueryViewMappings?: MigrationQueryViewMapping[];
}): { fieldMappings: MigrationFieldMapping[]; queryViewMappings: MigrationQueryViewMapping[] } {
  const exceptions: DashboardSafeCopyTargetException[] = [];
  return {
    fieldMappings: resolveFields('candidate', input.fieldDependencies || [], exceptions)
      .filter((mapping) => mapping.action === 'create_from_source'),
    queryViewMappings: resolveQueryViews('candidate', input.queryViews || [], input.configuredQueryViewMappings || [], exceptions)
      .filter((mapping) => mapping.action === 'copy_source'),
  };
}

function resolveTopics(
  targetId: string,
  topics: SourceTopicEvidence[],
  configured: MigrationTopicMapping[],
  explicitlyRequested: MigrationTopicMapping[],
  exceptions: DashboardSafeCopyTargetException[],
): MigrationTopicMapping[] {
  const mappings: MigrationTopicMapping[] = [];
  const mappingGroups = groupBy(configured, (mapping) => normalizedName(mapping.sourceTopicName));
  const groups = groupBy(topics, (topic) => normalizedName(topic.name));
  const filesByIdentity = new Map<string, Set<string>>();
  for (const topic of topics) {
    if (!topic.id?.trim() || !topic.fileName?.trim()) continue;
    const identity = normalizedName(topic.id);
    const files = filesByIdentity.get(identity) || new Set<string>();
    files.add(topic.fileName.trim());
    filesByIdentity.set(identity, files);
  }
  for (const [key, rows] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const reference = rows[0]?.name || key;
    const sourceFiles = uniqueStrings(rows.map((row) => row.fileName));
    const sourceIds = uniqueStrings(rows.map((row) => row.id));
    if (sourceIds.length > 1 || sourceIds.some((id) => (filesByIdentity.get(normalizedName(id))?.size || 0) > 1)) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'topic', reference, 'Topic identity evidence conflicts across the migration plan.');
      continue;
    }
    if (sourceFiles.length > 1) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'topic', reference, 'Topic file identity evidence conflicts across the migration plan.');
      continue;
    }
    const sourceFile = sourceFiles[0] || '';
    const sourceStem = sourceFile.endsWith('.topic') ? sourceFile.slice(0, -'.topic'.length) : '';
    const sourceNames = new Set([reference, ...sourceIds].map(normalizedName));
    if (!sourceStem || ![sourceStem, sourceStem.split('/').pop() || ''].some((name) => sourceNames.has(normalizedName(name)))) {
      // An exact destination match cannot establish the missing source identity.
      // Keep the original source name: a display label or renamed candidate is
      // not evidence that an unrelated authored file belongs to this topic.
      addException(exceptions, targetId, 'MISSING_EVIDENCE', 'topic', reference, 'One exact source topic file is required for an automatic topic copy.');
      continue;
    }
    const requested = [...new Map(explicitlyRequested
      .filter((mapping) => normalizedName(mapping.sourceTopicName) === key)
      .map((mapping) => [stableJson(mapping), mapping])).values()];
    const observed = mappingGroups.get(key) || [];
    const existing = [...new Map((observed.length ? observed : requested).map((mapping) => [
      stableJson(mapping),
      mapping,
    ])).values()];
    const sameChoice = (left: MigrationTopicMapping, right: MigrationTopicMapping) => (
      left.action === right.action
      && normalizedName(left.sourceTopicName) === normalizedName(right.sourceTopicName)
      && normalizedName(left.targetTopicName) === normalizedName(right.targetTopicName)
    );
    if (requested.length > 1
      || (requested.length === 1 && existing.some((mapping) => !sameChoice(mapping, requested[0])))
      || [...existing, ...requested].some((mapping) => mapping.sourceTopicId
        && !sourceIds.some((id) => normalizedName(id) === normalizedName(mapping.sourceTopicId!)))) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'topic', reference, 'The configured topic mapping conflicts with exact source identity evidence.');
      continue;
    }
    const exact = existing.filter((mapping) => mapping.action === 'map_existing' && (
      normalizedName(mapping.targetTopicName) === normalizedName(reference)
      || (requested.length === 1 && requested[0].action === 'map_existing' && sameChoice(mapping, requested[0]))
    ));
    const copies = existing.filter((mapping) => (
      mapping.action === 'copy_source'
      && normalizedName(mapping.targetTopicName) === normalizedName(reference)
    ));
    if (exact.length === 1 && existing.length === 1) {
      mappings.push(exact[0]);
      continue;
    }
    if (copies.length === 1 && existing.length === 1) {
      mappings.push(copies[0]);
      continue;
    }
    if (existing.length > 0) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'topic', reference, 'Topics can only be mapped exactly or copied under the source name.');
      continue;
    }
    mappings.push({
      sourceTopicName: reference,
      ...(rows[0]?.id ? { sourceTopicId: rows[0].id } : {}),
      action: 'copy_source',
      targetTopicName: reference,
    });
  }
  return mappings.sort((left, right) => left.sourceTopicName.localeCompare(right.sourceTopicName));
}

function resolvePermissions(
  targetId: string,
  dependencies: MigrationPermissionDependency[],
  exceptions: DashboardSafeCopyTargetException[],
): MigrationPermissionDecision[] {
  const decisions: MigrationPermissionDecision[] = [];
  const groups = groupBy(dependencies, (dependency) => dependency.id);
  for (const [id, rows] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const fingerprints = new Set(rows.map((row) => stableJson({
      kind: row.kind,
      sourceRef: row.sourceRef,
      sourceFileName: row.sourceFileName,
      targetFileName: row.targetFileName,
      targetCandidates: [...row.targetCandidates].sort((left, right) => left.targetRef.localeCompare(right.targetRef)),
      status: row.status,
      risk: row.risk,
      recommendedAction: row.recommendedAction,
      sourceValue: row.sourceValue,
      targetValue: row.targetValue,
      accessBoost: hasAccessBoost(row.sourceValue) || hasAccessBoost(row.targetValue),
    })));
    const dependency = rows[0];
    if (!dependency || fingerprints.size !== 1) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'permission', 'permission', 'Permission evidence conflicts across the migration plan.');
      continue;
    }
    if (
      FORBIDDEN_PERMISSION_KINDS.has(dependency.kind)
      || hasAccessBoost(dependency.sourceValue)
      || hasAccessBoost(dependency.targetValue)
      || dependency.reason?.toLowerCase().includes('accessboost')
    ) {
      addException(exceptions, targetId, 'SECURITY_REVIEW_REQUIRED', 'permission', dependency.kind, 'This permission class always requires human security review.');
      continue;
    }
    if (dependency.status === 'blocked') {
      addException(exceptions, targetId, 'BLOCKED_DEPENDENCY', 'permission', dependency.kind, 'The permission dependency is blocked.');
      continue;
    }
    if (dependency.status === 'warning') {
      addException(exceptions, targetId, 'MANUAL_REVIEW_REQUIRED', 'permission', dependency.kind, 'The permission dependency requires manual review.');
      continue;
    }
    const equivalent = [...new Map(dependency.targetCandidates
      .filter((candidate) => candidate.compatibility === 'equivalent')
      .map((candidate) => [candidate.targetRef, candidate])).values()];
    if (equivalent.length === 1 && dependency.recommendedAction === 'map_existing') {
      decisions.push({ dependencyId: id, action: 'map_existing', targetRef: equivalent[0].targetRef });
      continue;
    }
    if (equivalent.length > 1) {
      addException(exceptions, targetId, 'AMBIGUOUS_MAPPING', 'permission', dependency.kind, 'More than one equivalent permission target is available.');
      continue;
    }
    if (equivalent.length === 1) {
      addException(exceptions, targetId, 'MANUAL_REVIEW_REQUIRED', 'permission', dependency.kind, 'The permission recommendation is not an exact automatic map.');
      continue;
    }
    addException(
      exceptions,
      targetId,
      'SECURITY_REVIEW_REQUIRED',
      'permission',
      dependency.kind,
      'Safe-copy automation requires one exact equivalent target permission.',
    );
  }
  return decisions.sort((left, right) => left.dependencyId.localeCompare(right.dependencyId));
}

function minimalKeptPatch(patch: MigrationSemanticPatch): MigrationSemanticPatch {
  return {
    id: patch.id,
    artifactType: patch.artifactType,
    ...(patch.sourceName ? { sourceName: patch.sourceName } : {}),
    ...(patch.sourceFileName ? { sourceFileName: patch.sourceFileName } : {}),
    targetFileName: patch.targetFileName,
    ...(patch.targetModelId ? { targetModelId: patch.targetModelId } : {}),
    resolution: 'keep_target',
    destructive: false,
    confirmedDestructive: false,
    checksumStale: false,
    status: 'ready',
    safetyCategory: 'safe_ignore',
  };
}

function acceptedPatch(
  patch: MigrationSemanticPatch,
  yaml: string,
  checksum?: string,
): MigrationSemanticPatch {
  return {
    id: patch.id,
    artifactType: patch.artifactType,
    ...(patch.sourceName ? { sourceName: patch.sourceName } : {}),
    ...(patch.sourceFileName ? { sourceFileName: patch.sourceFileName } : {}),
    targetFileName: patch.targetFileName,
    ...(patch.targetModelId ? { targetModelId: patch.targetModelId } : {}),
    acceptedYaml: yaml,
    ...(checksum ? { previousChecksum: checksum } : {}),
    resolution: 'recommended',
    destructive: false,
    confirmedDestructive: false,
    checksumStale: false,
    status: 'ready',
    safetyCategory: patch.safetyCategory,
  };
}

function resolvePatches(
  target: MigrationTarget,
  patches: MigrationSemanticPatch[],
  exceptions: DashboardSafeCopyTargetException[],
): MigrationSemanticPatch[] {
  const resolved: MigrationSemanticPatch[] = [];
  let totalYamlCharacters = 0;
  const groups = groupBy(patches, (patch) => `${patch.artifactType}:${patch.id}`);
  for (const [key, rows] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const patch = rows[0];
    const permissionEvidence = rows.some((row) => (
      row.artifactType === 'permission'
      || Boolean(row.dependencyPath?.some((node) => node.kind === 'permission'))
    ));
    const reference = permissionEvidence ? 'permission' : patch?.sourceName || patch?.targetFileName || key;
    if (!patch || new Set(rows.map(stableJson)).size !== 1) {
      addException(
        exceptions,
        target.id,
        'AMBIGUOUS_MAPPING',
        permissionEvidence ? 'permission' : 'semantic_patch',
        reference,
        'Semantic patch evidence conflicts across the migration plan.',
      );
      continue;
    }
    if (patch.targetModelId && patch.targetModelId !== target.targetModelId) {
      addException(exceptions, target.id, 'TARGET_SCOPE_MISMATCH', 'semantic_patch', reference, 'The semantic patch targets a different model.');
      continue;
    }
    const carriesPermission = patch.artifactType === 'permission'
      || Boolean(patch.dependencyPath?.some((node) => node.kind === 'permission'));
    if (carriesPermission) {
      addException(exceptions, target.id, 'SECURITY_REVIEW_REQUIRED', 'permission', 'permission', 'Permission YAML changes require human security review.');
      continue;
    }
    if (patch.destructive || patch.safetyCategory === 'destructive_update') {
      addException(exceptions, target.id, 'DESTRUCTIVE_CHANGE', 'semantic_patch', reference, 'Destructive semantic patches cannot be automated.');
      continue;
    }
    if (patch.status === 'blocked' || patch.safetyCategory === 'blocked') {
      addException(exceptions, target.id, 'BLOCKED_DEPENDENCY', 'semantic_patch', reference, 'The semantic patch is blocked.');
      continue;
    }
    if (patch.status !== 'ready' || patch.checksumStale === true) {
      addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'semantic_patch', reference, 'The semantic patch is not a fresh automatic recommendation.');
      continue;
    }
    if (patch.safetyCategory === 'safe_ignore') {
      if (patch.resolution !== 'recommended' && patch.resolution !== 'keep_target') {
        addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'semantic_patch', reference, 'The safe-ignore patch contains a manual resolution.');
        continue;
      }
      resolved.push(minimalKeptPatch(patch));
      continue;
    }
    if (patch.resolution !== 'recommended') {
      addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'semantic_patch', reference, 'The semantic patch contains a manual resolution.');
      continue;
    }
    if (
      patch.safetyCategory !== 'safe_create'
      && patch.safetyCategory !== 'safe_update'
      && patch.safetyCategory !== 'safe_map'
    ) {
      addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'semantic_patch', reference, 'The semantic patch safety category requires manual review.');
      continue;
    }
    const yaml = patch.recommendedYaml?.trim() ? patch.recommendedYaml : patch.sourceYaml;
    if (!yaml?.trim()) {
      addException(exceptions, target.id, 'MISSING_EVIDENCE', 'semantic_patch', reference, 'The semantic patch lacks bounded recommended or source YAML.');
      continue;
    }
    if (yaml.length > MAX_PATCH_YAML_CHARACTERS) {
      addException(exceptions, target.id, 'YAML_LIMIT_EXCEEDED', 'semantic_patch', reference, 'The semantic patch exceeds the per-file YAML limit.');
      continue;
    }
    totalYamlCharacters += yaml.length;
    if (totalYamlCharacters > MAX_TOTAL_PATCH_YAML_CHARACTERS) {
      addException(exceptions, target.id, 'YAML_LIMIT_EXCEEDED', 'semantic_patch', reference, 'The semantic patch set exceeds the total YAML limit.');
      continue;
    }
    const checksum = patch.latestChecksum || patch.previousChecksum;
    if (
      patch.latestChecksum
      && patch.previousChecksum
      && patch.latestChecksum !== patch.previousChecksum
    ) {
      addException(exceptions, target.id, 'BLOCKED_DEPENDENCY', 'semantic_patch', reference, 'The semantic patch checksum evidence is stale.');
      continue;
    }
    if (
      (patch.safetyCategory === 'safe_update' || (patch.safetyCategory === 'safe_map' && patch.currentYaml))
      && !checksum
    ) {
      addException(exceptions, target.id, 'MISSING_EVIDENCE', 'semantic_patch', reference, 'A destination checksum is required for this semantic update.');
      continue;
    }
    if (patch.safetyCategory === 'safe_create' && patch.currentYaml?.trim()) {
      addException(exceptions, target.id, 'BLOCKED_DEPENDENCY', 'semantic_patch', reference, 'A safe-create patch cannot overwrite existing YAML.');
      continue;
    }
    resolved.push(acceptedPatch(patch, yaml, checksum));
  }
  return resolved.sort((left, right) => (
    left.artifactType.localeCompare(right.artifactType) || left.id.localeCompare(right.id)
  ));
}

function targetScopeMatches(planTarget: MigrationTarget, target: MigrationTarget): boolean {
  return planTarget.destinationInstanceId === target.destinationInstanceId
    && (planTarget.targetConnectionId || '') === (target.targetConnectionId || '')
    && planTarget.targetModelId === target.targetModelId
    && (planTarget.targetFolderId || '') === (target.targetFolderId || '')
    && (planTarget.targetFolderPath || '') === (target.targetFolderPath || '');
}

export function resolveDashboardSafeCopyTarget(
  plan: MigrationPlan,
  target: MigrationTarget,
  options: { mode?: 'execution' | 'readiness' } = {},
): DashboardSafeCopyResolverResult {
  const exceptions: DashboardSafeCopyTargetException[] = [];
  const matchingTargets = plan.targets.filter((candidate) => candidate.id === target.id);
  if (matchingTargets.length !== 1 || !targetScopeMatches(matchingTargets[0], target)) {
    addException(exceptions, target.id, 'TARGET_SCOPE_MISMATCH', 'target', target.id, 'The target does not match one exact migration-plan scope.');
  }
  const targetSteps = plan.steps.filter((step) => step.targetId === target.id);
  if (targetSteps.length === 0) {
    addException(exceptions, target.id, 'MISSING_EVIDENCE', 'target', target.id, 'No target-scoped migration-plan evidence is available.');
  } else if (targetSteps.some((step) => !planStepMatchesTargetScope(step, target))) {
    addException(exceptions, target.id, 'TARGET_SCOPE_MISMATCH', 'target', target.id, 'A migration-plan step does not match the exact destination scope.');
  }
  if (target.sameNamedStrategy === 'replace') {
    addException(exceptions, target.id, 'UNSAFE_TARGET_CONFIGURATION', 'target', target.id, 'Replacing a same-named dashboard is not permitted in safe-copy mode.');
  }
  if (target.queryValidationWaivers?.length) {
    addException(exceptions, target.id, 'UNSAFE_TARGET_CONFIGURATION', 'target', target.id, 'Query-validation waivers are not permitted in safe-copy mode.');
  }
  if (target.fieldMappings?.some((mapping) => mapping.action === 'ignore')) {
    addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'field', 'field', 'Ignored field dependencies require human review.');
  }
  if (target.queryViewMappings?.some((mapping) => (
    mapping.action === 'use_existing_unverified' || mapping.action === 'update_existing'
  ))) {
    addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'query_view', 'query_view', 'Unverified or updating query-view decisions require human review.');
  }
  if (target.permissionDecisions?.some((decision) => (
    decision.action === 'ignore_with_waiver'
    || decision.action === 'manual_prerequisite'
    || decision.action === 'preserve_target'
  ))) {
    addException(exceptions, target.id, 'SECURITY_REVIEW_REQUIRED', 'permission', 'permission', 'Manual, waived, or preserve-target permission decisions cannot be automated.');
  }
  if (target.semanticPatches?.some((patch) => (
    patch.destructive
    || patch.checksumStale
    || patch.status === 'blocked'
    || patch.safetyCategory === 'blocked'
    || patch.safetyCategory === 'destructive_update'
    || patch.safetyCategory === 'manual_review'
    || patch.resolution === 'custom_edit'
    || patch.resolution === 'use_source'
  ))) {
    addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'semantic_patch', 'semantic_patch', 'Existing manual or unsafe semantic decisions cannot be automated.');
  }

  const evidence = collectPlanEvidence(plan, target);
  for (const [documentId, withheld] of groupBy(evidence.proposalsWithheld, (proposal) => proposal.sourceDocumentId)) {
    addException(exceptions, target.id, 'MANUAL_REVIEW_REQUIRED', 'target', 'source_evidence',
      uniqueStrings(withheld.map((proposal) => proposal.reason)).map((reason) => cleanReference(reason, 'Source prerequisites require review.')).join(' '),
      { sourceDocumentIds: [documentId] });
  }
  if (evidence.invalidEvidenceFound) {
    addException(exceptions, target.id, 'MISSING_EVIDENCE', 'target', target.id, 'The migration plan contains malformed target evidence.');
  }
  if (evidence.relationshipBlocked) {
    addException(exceptions, target.id, 'BLOCKED_DEPENDENCY', 'relationship', 'relationship', 'A relationship dependency is blocked.');
  }
  if (evidence.topicCompatibilityBlocked) {
    addException(exceptions, target.id, 'BLOCKED_DEPENDENCY', 'topic', 'topic', 'A topic compatibility dependency is blocked.');
  }
  if (evidence.waiverFound) {
    addException(exceptions, target.id, 'UNSAFE_TARGET_CONFIGURATION', 'target', target.id, 'The migration plan contains a query-validation waiver.');
  }
  if (evidence.unexplainedBlockedStep) {
    addException(exceptions, target.id, 'BLOCKED_DEPENDENCY', 'target', target.id, 'A blocked plan step lacks structured automatic-resolution evidence.');
  }

  const fieldMappings = resolveFields(target.id, evidence.fieldDependencies, exceptions);
  const queryViewMappings = resolveQueryViews(
    target.id,
    evidence.queryViews,
    evidence.queryViewMappings,
    exceptions,
  );
  const topicMappings = resolveTopics(target.id, evidence.topics, evidence.topicMappings, target.topicMappings || [], exceptions);
  const permissionDecisions = resolvePermissions(
    target.id,
    evidence.permissionDependencies,
    exceptions,
  );
  if (
    target.permissionDecisions?.length
    && stableJson([...target.permissionDecisions].sort((left, right) => left.dependencyId.localeCompare(right.dependencyId)))
      !== stableJson(permissionDecisions)
  ) {
    addException(exceptions, target.id, 'SECURITY_REVIEW_REQUIRED', 'permission', 'permission', 'Existing permission decisions are not supported by the exact target evidence.');
  }
  const semanticPatches = resolvePatches(
    target,
    evidence.semanticPatches,
    exceptions,
  );
  requireWritePatchCoverage(
    target.id,
    fieldMappings,
    queryViewMappings,
    topicMappings,
    evidence.topics,
    evidence.relationshipRequired,
    semanticPatches,
    exceptions,
    options.mode === 'readiness' ? evidence.proposalsWithheld : [],
  );

  if (exceptions.length > 0) return resultExceptions(target.id, exceptions.map((exception) => {
    if (exception.artifact !== 'field' || exception.sourceDocumentIds?.length) return exception;
    const fields = evidence.fieldDependencies.filter((field) => normalizedName(field.sourceFieldRef) === normalizedName(exception.reference));
    return { ...exception, sourceDocumentIds: uniqueStrings(fields.map((field) => field.sourceDocumentId)) };
  }));
  return {
    status: 'resolved',
    target: {
      ...target,
      fieldMappings,
      queryViewMappings,
      topicMappings,
      permissionDecisions,
      semanticPatches,
      queryValidationWaivers: [],
    },
  };
}
