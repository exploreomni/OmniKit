import {
  DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY,
  type DashboardMigrationDraft,
  type DashboardMigrationFieldMappingDraft,
  type DashboardMigrationQueryViewMappingDraft,
  type DashboardMigrationSemanticPatchDraft,
  type DashboardMigrationTopicMappingDraft,
} from './dashboardMigrationTypes';
import type { MigrationQueryValidationWaiver } from '@/services/opsConsole';

const FORBIDDEN_DRAFT_KEYS = new Set(['apiKey', 'api_key', 'token', 'secret', 'passphrase', 'baseUrl', 'base_url']);

export function dashboardMigrationDraftContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(dashboardMigrationDraftContainsForbiddenKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    FORBIDDEN_DRAFT_KEYS.has(key) || dashboardMigrationDraftContainsForbiddenKeys(item)
  ));
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    : [];
}

function sanitizeWaiverReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\b(sk-[a-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*\S+|bearer\s+\S+)\b/gi, '[redacted]')
    .trim()
    .slice(0, 500);
}

function sanitizeQueryValidationWaivers(value: unknown): MigrationQueryValidationWaiver[] {
  if (!Array.isArray(value)) return [];
  const waivers = value
    .filter((waiver): waiver is Record<string, unknown> => Boolean(waiver) && typeof waiver === 'object' && !Array.isArray(waiver))
    .map((waiver) => ({
      documentId: typeof waiver.documentId === 'string' ? waiver.documentId.trim() : '',
      queryId: typeof waiver.queryId === 'string' ? waiver.queryId.trim() : '',
      reason: sanitizeWaiverReason(waiver.reason),
      acknowledgedAt: typeof waiver.acknowledgedAt === 'string' ? waiver.acknowledgedAt.trim() : undefined,
    }))
    .filter((waiver) => waiver.documentId && waiver.queryId && waiver.reason.length >= 10);
  return [...new Map(waivers.map((waiver) => [`${waiver.documentId}:${waiver.queryId}`, waiver])).values()];
}

function sanitizeTopicMappings(value: unknown): DashboardMigrationTopicMappingDraft[] {
  return Array.isArray(value) ? value.map((mapping) => ({
    sourceTopicName: mapping.sourceTopicName || '',
    sourceTopicId: mapping.sourceTopicId || undefined,
    action: mapping.action === 'copy_source' ? 'copy_source' as const : mapping.action === 'map_existing' ? 'map_existing' as const : 'unresolved' as const,
    targetTopicName: mapping.targetTopicName || '',
    targetTopicLabel: mapping.targetTopicLabel || undefined,
    status: mapping.status,
    warnings: uniqueStrings(mapping.warnings),
  })).filter((mapping) => mapping.sourceTopicName) : [];
}

function sanitizeQueryViewMappings(value: unknown): DashboardMigrationQueryViewMappingDraft[] {
  return Array.isArray(value) ? value.map((mapping) => ({
    sourceQueryViewName: mapping.sourceQueryViewName || '',
    sourceFileName: mapping.sourceFileName || undefined,
    action: mapping.action === 'copy_source'
      ? 'copy_source' as const
      : mapping.action === 'map_existing'
        ? 'map_existing' as const
        : mapping.action === 'use_existing_unverified'
          ? 'use_existing_unverified' as const
          : mapping.action === 'update_existing'
            ? 'update_existing' as const
            : 'unresolved' as const,
    targetQueryViewName: mapping.targetQueryViewName || '',
    targetFileName: mapping.targetFileName || undefined,
    targetQueryViewLabel: mapping.targetQueryViewLabel || undefined,
    requiredFieldRefs: uniqueStrings(mapping.requiredFieldRefs),
    suppliedFieldRefs: uniqueStrings(mapping.suppliedFieldRefs),
    fieldEvidence: mapping.fieldEvidence && typeof mapping.fieldEvidence === 'object'
      && ['source_yaml', 'target_yaml', 'accepted_patch'].includes(mapping.fieldEvidence.source)
      && typeof mapping.fieldEvidence.fileName === 'string'
      ? {
        source: mapping.fieldEvidence.source,
        fileName: mapping.fieldEvidence.fileName,
        verified: mapping.fieldEvidence.verified === true,
      }
      : undefined,
    status: mapping.status,
    warnings: uniqueStrings(mapping.warnings),
  })).filter((mapping) => mapping.sourceQueryViewName) : [];
}

function sanitizeFieldMappings(value: unknown): DashboardMigrationFieldMappingDraft[] {
  return Array.isArray(value) ? value.map((mapping) => ({
    sourceFieldRef: mapping.sourceFieldRef || '',
    action: mapping.action === 'create_from_source'
      ? 'create_from_source' as const
      : mapping.action === 'ignore'
        ? 'ignore' as const
        : mapping.action === 'map_existing'
          ? 'map_existing' as const
          : 'unresolved' as const,
    targetFieldRef: mapping.targetFieldRef || undefined,
    sourceFileName: mapping.sourceFileName || undefined,
    targetFileName: mapping.targetFileName || undefined,
    status: mapping.status,
    warnings: uniqueStrings(mapping.warnings),
  })).filter((mapping) => mapping.sourceFieldRef) : [];
}

function sanitizeSemanticSafetyCategory(value: unknown): DashboardMigrationSemanticPatchDraft['safetyCategory'] {
  if (
    value === 'safe_ignore'
    || value === 'safe_map'
    || value === 'safe_create'
    || value === 'safe_update'
    || value === 'destructive_update'
    || value === 'manual_review'
    || value === 'blocked'
  ) {
    return value;
  }
  return undefined;
}

function sanitizeSemanticDependencyPath(value: unknown): DashboardMigrationSemanticPatchDraft['dependencyPath'] {
  if (!Array.isArray(value)) return undefined;
  const nodes = value
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && !Array.isArray(node))
    .map((node): NonNullable<DashboardMigrationSemanticPatchDraft['dependencyPath']>[number] | null => {
      const kind = node.kind === 'dashboard'
        || node.kind === 'topic'
        || node.kind === 'query_view'
        || node.kind === 'model_field'
        || node.kind === 'relationship'
        || node.kind === 'model_file'
        ? node.kind
        : undefined;
      const label = typeof node.label === 'string' ? node.label : '';
      if (!kind || !label) return null;
      return {
        kind,
        label,
        ...(typeof node.ref === 'string' ? { ref: node.ref } : {}),
        ...(typeof node.detail === 'string' ? { detail: node.detail } : {}),
      };
    })
    .filter((node): node is NonNullable<DashboardMigrationSemanticPatchDraft['dependencyPath']>[number] => Boolean(node));
  return nodes.length > 0 ? nodes : undefined;
}

function sanitizeSemanticPatches(value: unknown): DashboardMigrationSemanticPatchDraft[] {
  return Array.isArray(value) ? value
    .filter((patch): patch is Record<string, unknown> => Boolean(patch) && typeof patch === 'object' && !Array.isArray(patch))
    .map((patch) => {
      const resolution = patch.resolution === 'custom_edit'
        ? 'custom_edit' as const
        : patch.resolution === 'keep_target'
          ? 'keep_target' as const
          : patch.resolution === 'use_source'
            ? 'use_source' as const
            : 'recommended' as const;
      const warnings = uniqueStrings(patch.warnings);
      const strippedCustomEdit = resolution === 'custom_edit';
      return {
	      id: typeof patch.id === 'string' ? patch.id : '',
        artifactType: patch.artifactType === 'query_view'
          ? 'query_view' as const
          : patch.artifactType === 'topic'
            ? 'topic' as const
            : patch.artifactType === 'relationship'
              ? 'relationship' as const
              : 'field' as const,
	      sourceName: typeof patch.sourceName === 'string' ? patch.sourceName : undefined,
	      sourceFileName: typeof patch.sourceFileName === 'string' ? patch.sourceFileName : undefined,
	      targetFileName: typeof patch.targetFileName === 'string' ? patch.targetFileName : '',
	      targetModelId: typeof patch.targetModelId === 'string' ? patch.targetModelId : undefined,
	      previousChecksum: typeof patch.previousChecksum === 'string' ? patch.previousChecksum : undefined,
        resolution,
        destructive: patch.destructive === true,
	      confirmedDestructive: strippedCustomEdit ? false : patch.confirmedDestructive === true,
	      status: strippedCustomEdit
	        ? 'blocked' as const
	        : patch.status === 'blocked'
	          ? 'blocked' as const
	          : patch.status === 'warning'
	            ? 'warning' as const
	            : patch.status === 'ready'
	              ? 'ready' as const
	              : undefined,
	      safetyCategory: sanitizeSemanticSafetyCategory(patch.safetyCategory),
	      recommendedAction: typeof patch.recommendedAction === 'string' ? patch.recommendedAction : undefined,
	      dependencyPath: sanitizeSemanticDependencyPath(patch.dependencyPath),
	      warnings: strippedCustomEdit
          ? [...new Set([...warnings, 'Custom YAML is not stored in reusable drafts. Re-enter the custom edit or apply the recommended YAML again.'])]
          : warnings,
	    };
    }).filter((patch) => patch.id && patch.targetFileName) : [];
}

export function sanitizeDashboardMigrationDraftForStorage(input: DashboardMigrationDraft): DashboardMigrationDraft {
  return {
    step: input.step,
    sourceId: input.sourceId || '',
    sourceConnectionId: input.sourceConnectionId || '',
    sourceFolderId: input.sourceFolderId || '',
    sourceFolderPath: input.sourceFolderPath || '',
    selectedDocumentIds: uniqueStrings(input.selectedDocumentIds),
    targets: Array.isArray(input.targets) ? input.targets.map((target) => ({
      id: target.id || '',
      destinationInstanceId: target.destinationInstanceId || '',
      targetConnectionId: target.targetConnectionId || '',
      targetModelId: target.targetModelId || '',
      targetModelName: target.targetModelName || '',
      targetFolderPath: target.targetFolderPath || '',
      targetFolderId: target.targetFolderId || '',
      sameNamedStrategy: target.sameNamedStrategy === 'replace' ? 'replace' : 'update',
      topicMappings: sanitizeTopicMappings(target.topicMappings),
      queryViewMappings: sanitizeQueryViewMappings(target.queryViewMappings),
      fieldMappings: sanitizeFieldMappings(target.fieldMappings),
      semanticPatches: sanitizeSemanticPatches(target.semanticPatches),
      queryValidationWaivers: sanitizeQueryValidationWaivers(target.queryValidationWaivers),
    })) : [],
    routeGroups: Array.isArray(input.routeGroups) ? input.routeGroups.map((group, index) => {
      const topicMappingsByTargetId = Object.fromEntries(
        Object.entries(group.topicMappingsByTargetId || {})
          .map(([targetRowId, mappings]) => [targetRowId, sanitizeTopicMappings(mappings)] as const)
          .filter(([, mappings]) => mappings.length > 0),
      );
      const queryViewMappingsByTargetId = Object.fromEntries(
        Object.entries(group.queryViewMappingsByTargetId || {})
          .map(([targetRowId, mappings]) => [targetRowId, sanitizeQueryViewMappings(mappings)] as const)
          .filter(([, mappings]) => mappings.length > 0),
      );
      const fieldMappingsByTargetId = Object.fromEntries(
        Object.entries(group.fieldMappingsByTargetId || {})
          .map(([targetRowId, mappings]) => [targetRowId, sanitizeFieldMappings(mappings)] as const)
          .filter(([, mappings]) => mappings.length > 0),
      );
      const semanticPatchesByTargetId = Object.fromEntries(
        Object.entries(group.semanticPatchesByTargetId || {})
          .map(([targetRowId, patches]) => [targetRowId, sanitizeSemanticPatches(patches)] as const)
          .filter(([, patches]) => patches.length > 0),
      );
      const queryValidationWaiversByTargetId = Object.fromEntries(
        Object.entries(group.queryValidationWaiversByTargetId || {})
          .map(([targetRowId, waivers]) => [targetRowId, sanitizeQueryValidationWaivers(waivers)] as const)
          .filter(([, waivers]) => waivers.length > 0),
      );
      return {
        id: group.id || `route-group-${index + 1}`,
        name: group.name || `Route group ${index + 1}`,
        documentIds: uniqueStrings(group.documentIds),
        targetRowIds: uniqueStrings(group.targetRowIds),
        topicMappingsByTargetId,
        queryViewMappingsByTargetId,
        fieldMappingsByTargetId,
        ...(Object.keys(semanticPatchesByTargetId).length > 0 ? { semanticPatchesByTargetId } : {}),
        ...(Object.keys(queryValidationWaiversByTargetId).length > 0 ? { queryValidationWaiversByTargetId } : {}),
      };
    }).filter((group) => group.documentIds.length > 0) : [],
    routeAssignmentsCustomized: input.routeAssignmentsCustomized === true,
    replaceSameNamed: input.replaceSameNamed !== false,
    emptyFirst: input.emptyFirst === true,
    refreshSchemaOnComplete: input.refreshSchemaOnComplete === true,
    deleteSourceOnSuccess: input.deleteSourceOnSuccess === true,
  };
}

export function loadDashboardMigrationDraft(): DashboardMigrationDraft | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DashboardMigrationDraft;
    return sanitizeDashboardMigrationDraftForStorage(parsed);
  } catch {
    return null;
  }
}

export function saveDashboardMigrationDraft(input: DashboardMigrationDraft): void {
  if (typeof window === 'undefined') return;
  const sanitized = sanitizeDashboardMigrationDraftForStorage(input);
  window.localStorage.setItem(DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY, JSON.stringify(sanitized));
}

export function clearDashboardMigrationDraft(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY);
}
