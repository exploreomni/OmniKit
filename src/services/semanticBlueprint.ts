import { parseDocument } from 'yaml';
import type { OmniModelYamlResponse } from './omniApi';
import {
  semanticApprovedTopicViewScopeIssues,
  semanticModelViewNames,
  semanticViewIdentityContract,
  type SemanticReferenceFile,
  type SemanticViewIdentityContract,
} from './semanticModelReferences';
import { sha256Text } from './contentHash';
import type { SemanticArtifactAction } from './semanticSolutionPlanner';
import { authoredTopicYamlFiles } from './topicYamlGovernance';

export type SemanticBlueprintRoleHint = 'fact' | 'dimension' | 'bridge' | 'aggregate' | 'unknown';
export type SemanticBlueprintRelationshipDecision =
  | 'use_existing'
  | 'propose_reusable'
  | 'create_reusable'
  | 'needs_review';
export type SemanticBlueprintRelationshipType =
  | 'one_to_one'
  | 'many_to_one'
  | 'one_to_many'
  | 'many_to_many'
  | 'assumed_many_to_one';

export interface SemanticBlueprintRelationshipContract {
  joinFromView: string;
  joinToView: string;
  joinType: 'always_left';
  onSql: string;
  relationshipType: SemanticBlueprintRelationshipType;
  reversible: boolean;
}

export interface SemanticBlueprintDateTimeFieldOption {
  viewName: string;
  fieldName: string;
  fieldReference: string;
  dataType: string;
}

export interface SemanticBlueprintViewOption {
  viewName: string;
  fileName?: string;
  schemaName?: string;
  tableName?: string;
  roleHint: SemanticBlueprintRoleHint;
  dateFieldNames: string[];
  dateTimeFields: SemanticBlueprintDateTimeFieldOption[];
  identity?: SemanticViewIdentityContract;
}

export interface SemanticBlueprintDraft {
  businessPurpose: string;
  audience: string;
  grain: string;
  businessQuestions: string[];
  focusedSchemaNames: string[];
  primaryViewName: string;
  supportingViewNames: string[];
  relationshipDecisions: Record<string, SemanticBlueprintRelationshipDecision>;
  relationshipContracts: Record<string, SemanticBlueprintRelationshipContract>;
  excludedViewNames: string[];
  primaryDateField: string;
  primaryDateNotRequired: boolean;
  relationshipGuidance: string;
  securityGuidance: string;
  reviewedAndApproved: boolean;
}

export interface SemanticBlueprintPlanBindings {
  requestedArtifactFileNames: string[];
  excludedArtifactFileNames: string[];
  actionOverrides: Record<string, SemanticArtifactAction>;
}

const ACTION_PRESERVING_BLUEPRINT_PATCH_KEYS = new Set<keyof SemanticBlueprintDraft>([
  'relationshipGuidance',
  'securityGuidance',
  'reviewedAndApproved',
]);

export function semanticBlueprintActionOverridesAfterDraftPatch(
  current: Readonly<Record<string, SemanticArtifactAction>>,
  patch: Partial<SemanticBlueprintDraft>,
): Record<string, SemanticArtifactAction> {
  const patchKeys = Object.keys(patch) as Array<keyof SemanticBlueprintDraft>;
  if (patchKeys.every((key) => ACTION_PRESERVING_BLUEPRINT_PATCH_KEYS.has(key))) {
    return { ...current };
  }
  return {};
}

export interface SemanticBlueprintPromptScope {
  readOnlyFileNames: string[];
  viewNames: string[];
}

export interface SemanticBlueprintApproval {
  schemaVersion: 'omnikit.semantic-blueprint-approval.v4';
  modelId: string;
  blueprintFingerprint: string;
  sourceFingerprint: string;
  mutationFingerprint: string;
}

export interface SemanticBlueprintMutationBoundary {
  targetTopicFileName: string;
  solutionPlanFingerprint: string;
  permissionContractFingerprint: string;
  requestedArtifactFileNames: string[];
  excludedArtifactFileNames: string[];
  relationshipIntent: 'required' | 'not_required';
  permissionIntent: 'required' | 'not_required';
  actionOverrides: Record<string, SemanticArtifactAction>;
}

export interface SemanticBlueprintPackageInput {
  draft: SemanticBlueprintDraft;
  viewOptions: readonly SemanticBlueprintViewOption[];
  files: readonly SemanticReferenceFile[];
  baselineRelationshipsYaml?: string;
  approvedStagedViewFileNames?: readonly string[];
  approvedStagedViewIdentities?: readonly SemanticViewIdentityContract[];
  allowPartialPackage?: boolean;
  relationshipIntent?: 'required' | 'not_required';
  permissionIntent?: 'required' | 'not_required';
  approvedTargetTopicFileName?: string;
}

export const EMPTY_SEMANTIC_BLUEPRINT_DRAFT: SemanticBlueprintDraft = Object.freeze({
  businessPurpose: '',
  audience: '',
  grain: '',
  businessQuestions: [],
  focusedSchemaNames: [],
  primaryViewName: '',
  supportingViewNames: [],
  relationshipDecisions: {},
  relationshipContracts: {},
  excludedViewNames: [],
  primaryDateField: '',
  primaryDateNotRequired: false,
  relationshipGuidance: '',
  securityGuidance: '',
  reviewedAndApproved: false,
});

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values: readonly string[], limit = 100): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const candidate = clean(value);
    const key = candidate.toLowerCase();
    if (!candidate || seen.has(key) || result.length >= limit) return;
    seen.add(key);
    result.push(candidate);
  });
  return result;
}

function parsedRecord(yaml: string): Record<string, unknown> | null {
  try {
    const document = parseDocument(yaml, {
      prettyErrors: false,
      strict: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return null;
    const value = document.toJS({ maxAliasCount: 20 });
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function semanticBlueprintExistingRelationshipContracts(
  modelYaml: Pick<OmniModelYamlResponse, 'files'> | null | undefined,
): SemanticBlueprintRelationshipContract[] {
  const yaml = modelYaml?.files?.relationships || '';
  if (!yaml.trim()) return [];
  try {
    const document = parseDocument(yaml, {
      prettyErrors: false,
      strict: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return [];
    const rows = document.toJS({ maxAliasCount: 20 });
    if (!Array.isArray(rows)) return [];
    const contracts = rows.flatMap((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
      const record = row as Record<string, unknown>;
      const joinFromView = clean(record.join_from_view);
      const joinToView = clean(record.join_to_view);
      const joinType = clean(record.join_type);
      const onSql = clean(record.on_sql);
      const relationshipType = clean(record.relationship_type) as SemanticBlueprintRelationshipType;
      if (
        !joinFromView
        || !joinToView
        || joinType !== 'always_left'
        || !onSql
        || !['one_to_one', 'many_to_one', 'one_to_many', 'many_to_many', 'assumed_many_to_one'].includes(relationshipType)
        || (record.reversible !== undefined && typeof record.reversible !== 'boolean')
      ) return [];
      return [{
        joinFromView,
        joinToView,
        joinType: 'always_left' as const,
        onSql,
        relationshipType,
        reversible: record.reversible === true,
      }];
    });
    return Array.from(new Map(
      contracts.map((contract) => [JSON.stringify(contract), contract]),
    ).values());
  } catch {
    return [];
  }
}

function inferredViewName(fileName: string): string {
  const normalized = fileName.trim().replace(/^\/+|\/+$/g, '');
  if (!/\.view$/i.test(normalized)) return '';
  const parts = normalized.split('/');
  const leaf = (parts.pop() || '')
    .replace(/\.query\.view$/i, '')
    .replace(/\.view$/i, '');
  if (!leaf || leaf.includes('__') || parts.length === 0) return leaf;
  const folder = parts[parts.length - 1] || '';
  return folder && folder.toLowerCase() !== 'views' ? `${folder}__${leaf}` : leaf;
}

function roleHint(...values: string[]): SemanticBlueprintRoleHint {
  const tokens = values
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.some((token) => ['fact', 'fct'].includes(token))) return 'fact';
  if (tokens.some((token) => ['dim', 'dimension'].includes(token))) return 'dimension';
  if (tokens.some((token) => ['bridge', 'xref', 'mapping'].includes(token))) return 'bridge';
  if (tokens.some((token) => ['agg', 'aggregate', 'summary'].includes(token))) return 'aggregate';
  return 'unknown';
}

const SEMANTIC_BLUEPRINT_DATE_TIME_TYPES = new Set([
  'date',
  'datetime',
  'time',
  'timestamp',
  'timestamp_ntz',
  'timestamp_tz',
  'timestamptz',
]);

function dateTimeFieldOptions(
  record: Record<string, unknown> | null,
  viewName: string,
): SemanticBlueprintDateTimeFieldOption[] {
  const fields = [record?.dimensions, record?.dimension_groups].flatMap((section) => {
    if (!section || typeof section !== 'object') return [];
    if (Array.isArray(section)) {
      return section.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const name = clean((item as Record<string, unknown>).name);
        if (!name) return [];
        return [[name, item]] as Array<[string, unknown]>;
      });
    }
    return Object.entries(section as Record<string, unknown>);
  });
  return fields.flatMap(([fieldName, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const dataType = clean((value as Record<string, unknown>).type).toLowerCase();
    if (!SEMANTIC_BLUEPRINT_DATE_TIME_TYPES.has(dataType)) return [];
    return [{
      viewName,
      fieldName,
      fieldReference: `${viewName}.${fieldName}`,
      dataType,
    }];
  }).sort((left, right) => left.fieldReference.localeCompare(right.fieldReference));
}

export function semanticBlueprintDateTimeFieldOptions(
  viewOptions: readonly SemanticBlueprintViewOption[],
  reachableViewNames?: readonly string[],
): SemanticBlueprintDateTimeFieldOption[] {
  const reachable = reachableViewNames
    ? new Set(reachableViewNames.map((viewName) => viewName.toLowerCase()))
    : null;
  return viewOptions
    .filter((option) => !reachable || reachable.has(option.viewName.toLowerCase()))
    .flatMap((option) => option.dateTimeFields)
    .sort((left, right) => left.fieldReference.localeCompare(right.fieldReference));
}

export function semanticBlueprintViewOptions(
  modelYaml: Pick<OmniModelYamlResponse, 'files' | 'viewNames'> | null | undefined,
): SemanticBlueprintViewOption[] {
  const indexedNames = modelYaml?.viewNames || {};
  const byName = new Map<string, SemanticBlueprintViewOption>();
  const representedAliases = new Set<string>();

  Object.entries(modelYaml?.files || {}).forEach(([fileName, yaml]) => {
    if (!/\.view$/i.test(fileName)) return;
    const record = parsedRecord(yaml);
    const indexedName = clean(indexedNames[fileName]);
    const declaredName = clean(record?.name ?? record?.view ?? record?.view_name);
    const viewName = declaredName || indexedName || inferredViewName(fileName);
    if (!viewName) return;
    const schemaName = clean(record?.schema ?? record?.schema_name);
    const tableName = clean(record?.table_name ?? record?.sql_table_name);
    const identity = semanticViewIdentityContract({ fileName, yaml }, indexedName || undefined);
    const dateTimeFields = dateTimeFieldOptions(record, viewName);
    [viewName, indexedName, declaredName, inferredViewName(fileName)]
      .filter(Boolean)
      .forEach((alias) => representedAliases.add(alias.toLowerCase()));
    byName.set(viewName.toLowerCase(), {
      viewName,
      fileName,
      schemaName: schemaName || undefined,
      tableName: tableName || undefined,
      roleHint: roleHint(viewName, tableName),
      dateFieldNames: dateTimeFields.map((option) => option.fieldName),
      dateTimeFields,
      identity: identity || undefined,
    });
  });

  semanticModelViewNames(modelYaml).forEach((viewName) => {
    const key = viewName.toLowerCase();
    if (!byName.has(key) && !representedAliases.has(key)) {
      byName.set(key, {
        viewName,
        roleHint: roleHint(viewName),
        dateFieldNames: [],
        dateTimeFields: [],
      });
    }
  });

  return [...byName.values()].sort((left, right) => left.viewName.localeCompare(right.viewName));
}

export function normalizeSemanticBlueprintDraft(
  input: Partial<SemanticBlueprintDraft>,
): SemanticBlueprintDraft {
  const primaryViewName = clean(input.primaryViewName);
  const supportingViewNames = unique(input.supportingViewNames || [], 12)
    .filter((viewName) => viewName.toLowerCase() !== primaryViewName.toLowerCase());
  const supportedRelationshipDecisions = new Set<SemanticBlueprintRelationshipDecision>([
    'use_existing',
    'propose_reusable',
    'create_reusable',
    'needs_review',
  ]);
  const inputDecisions = input.relationshipDecisions && typeof input.relationshipDecisions === 'object'
    ? input.relationshipDecisions
    : {};
  const relationshipDecisions = Object.fromEntries(supportingViewNames.flatMap((viewName) => {
    const matchingKey = Object.keys(inputDecisions).find((key) => key.toLowerCase() === viewName.toLowerCase());
    const decision = matchingKey ? inputDecisions[matchingKey] : undefined;
    return decision && supportedRelationshipDecisions.has(decision)
      ? [[viewName, decision]]
      : [];
  }));
  const supportedRelationshipTypes = new Set<SemanticBlueprintRelationshipType>([
    'one_to_one',
    'many_to_one',
    'one_to_many',
    'many_to_many',
    'assumed_many_to_one',
  ]);
  const inputContracts = input.relationshipContracts && typeof input.relationshipContracts === 'object'
    ? input.relationshipContracts
    : {};
  const relationshipContracts = Object.fromEntries(supportingViewNames.flatMap((viewName) => {
    if (!['use_existing', 'create_reusable'].includes(relationshipDecisions[viewName] || '')) return [];
    const matchingKey = Object.keys(inputContracts).find((key) => key.toLowerCase() === viewName.toLowerCase());
    const contract = matchingKey ? inputContracts[matchingKey] : undefined;
    if (!contract || typeof contract !== 'object') return [];
    if (
      contract.joinType !== 'always_left'
      || !supportedRelationshipTypes.has(contract.relationshipType)
      || typeof contract.reversible !== 'boolean'
    ) return [];
    return [[viewName, {
      joinFromView: clean(contract.joinFromView),
      joinToView: clean(contract.joinToView),
      joinType: 'always_left' as const,
      onSql: clean(contract.onSql),
      relationshipType: contract.relationshipType,
      reversible: contract.reversible,
    }]];
  }));
  const primaryDateNotRequired = input.primaryDateNotRequired === true;
  const primaryDateField = primaryDateNotRequired ? '' : clean(input.primaryDateField);

  return {
    businessPurpose: clean(input.businessPurpose),
    audience: clean(input.audience),
    grain: clean(input.grain),
    businessQuestions: unique(input.businessQuestions || [], 8),
    focusedSchemaNames: unique(input.focusedSchemaNames || [], 12),
    primaryViewName,
    supportingViewNames,
    relationshipDecisions,
    relationshipContracts,
    // Retained in the draft contract so older saved drafts still load. Scope is now include-only.
    excludedViewNames: [],
    primaryDateField,
    primaryDateNotRequired,
    relationshipGuidance: clean(input.relationshipGuidance),
    securityGuidance: clean(input.securityGuidance),
    reviewedAndApproved: Boolean(input.reviewedAndApproved),
  };
}

function editableText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function semanticBlueprintQuestionLinesForEditing(value: string): string[] {
  return value.split(/\r?\n/).slice(0, 8);
}

export function mergeSemanticBlueprintDraftForEditing(
  current: SemanticBlueprintDraft,
  patch: Partial<SemanticBlueprintDraft>,
): SemanticBlueprintDraft {
  const merged = { ...current, ...patch };
  const normalized = normalizeSemanticBlueprintDraft(merged);
  if (normalized.reviewedAndApproved) return normalized;

  const inputContracts = merged.relationshipContracts && typeof merged.relationshipContracts === 'object'
    ? merged.relationshipContracts
    : {};
  const relationshipContracts = Object.fromEntries(Object.entries(normalized.relationshipContracts).map(
    ([viewName, contract]) => {
      const inputKey = Object.keys(inputContracts).find((key) => key.toLowerCase() === viewName.toLowerCase());
      const inputContract = inputKey ? inputContracts[inputKey] : undefined;
      return [viewName, {
        ...contract,
        onSql: editableText(inputContract?.onSql),
      }];
    },
  ));

  return {
    ...normalized,
    businessPurpose: editableText(merged.businessPurpose),
    audience: editableText(merged.audience),
    grain: editableText(merged.grain),
    businessQuestions: Array.isArray(merged.businessQuestions)
      ? merged.businessQuestions.slice(0, 8).map(editableText)
      : [],
    relationshipContracts,
    relationshipGuidance: editableText(merged.relationshipGuidance),
    securityGuidance: editableText(merged.securityGuidance),
  };
}

export function semanticBlueprintIssues(input: {
  draft: SemanticBlueprintDraft;
  viewOptions: readonly SemanticBlueprintViewOption[];
  requireApproval?: boolean;
  relationshipIntent?: 'required' | 'not_required';
  permissionIntent?: 'required' | 'not_required';
}): string[] {
  const draft = normalizeSemanticBlueprintDraft(input.draft);
  const availableViews = new Set(input.viewOptions.map((option) => option.viewName.toLowerCase()));
  const availableSchemas = new Set(
    input.viewOptions.map((option) => option.schemaName?.toLowerCase()).filter(Boolean),
  );
  const issues: string[] = [];

  if (!draft.businessPurpose) issues.push('Describe the business outcome this topic should support.');
  if (!draft.grain) issues.push('Describe what one row or record represents for this topic.');
  if (draft.businessQuestions.length === 0) issues.push('Add at least one business question the topic must answer.');
  if (!draft.primaryViewName) issues.push('Choose the primary data view for this topic.');
  if (draft.primaryViewName && !availableViews.has(draft.primaryViewName.toLowerCase())) {
    issues.push(`Primary view "${draft.primaryViewName}" is no longer available in this model.`);
  }
  draft.supportingViewNames.forEach((viewName) => {
    if (!availableViews.has(viewName.toLowerCase())) {
      issues.push(`View "${viewName}" is no longer available in this model.`);
    }
  });
  draft.supportingViewNames.forEach((viewName) => {
    const decision = draft.relationshipDecisions[viewName];
    if (!decision || decision === 'needs_review') {
      issues.push(`Choose how supporting view "${viewName}" should relate to the primary view.`);
    }
    if (decision === 'use_existing' || decision === 'create_reusable') {
      const contract = draft.relationshipContracts[viewName];
      if (!contract) {
        issues.push(
          decision === 'use_existing'
            ? `Select the exact authored relationship contract to reuse for supporting view "${viewName}".`
            : `Define the exact reusable relationship contract for supporting view "${viewName}".`,
        );
        return;
      }
      const endpointNames = [contract.joinFromView, contract.joinToView].map((value) => value.toLowerCase());
      if (
        !endpointNames.includes(draft.primaryViewName.toLowerCase())
        || !endpointNames.includes(viewName.toLowerCase())
        || endpointNames[0] === endpointNames[1]
      ) {
        issues.push(`The reusable relationship for "${viewName}" must connect exactly that view and the primary view.`);
      }
      if (!contract.onSql) {
        issues.push(`Enter the exact join SQL for the relationship to "${viewName}".`);
      } else {
        [contract.joinFromView, contract.joinToView].filter(Boolean).forEach((endpoint) => {
          if (!contract.onSql.includes(`\${${endpoint}.`)) {
            issues.push(`The join SQL for "${viewName}" must reference a field from "${endpoint}" using \${${endpoint}.field_name}.`);
          }
        });
      }
    }
  });
  const reachableBlueprintViews = [draft.primaryViewName, ...draft.supportingViewNames].filter(Boolean);
  if (!draft.primaryDateNotRequired) {
    if (!draft.primaryDateField) {
      issues.push('Choose an exact verified date/time field or explicitly approve no default date field.');
    } else {
      const verifiedDateTimeFields = semanticBlueprintDateTimeFieldOptions(
        input.viewOptions,
        reachableBlueprintViews,
      );
      if (!verifiedDateTimeFields.some((option) => option.fieldReference === draft.primaryDateField)) {
        issues.push(
          `Primary date field "${draft.primaryDateField}" is not an exact verified date/time field on an approved reachable view.`,
        );
      }
    }
  }
  if (draft.supportingViewNames.length > 0 && input.relationshipIntent === 'not_required') {
    issues.push('Supporting views require the reusable relationship workflow. Select Review or create the relationship file.');
  }
  if (draft.securityGuidance && input.permissionIntent === 'not_required') {
    issues.push('Security guidance was entered, but access changes are set to No access changes. Include access setup or remove the security guidance.');
  }
  draft.focusedSchemaNames.forEach((schemaName) => {
    if (!availableSchemas.has(schemaName.toLowerCase())) {
      issues.push(`Schema "${schemaName}" is no longer represented by the loaded model views.`);
    }
  });
  if (draft.focusedSchemaNames.length > 0) {
    const focusedSchemas = new Set(draft.focusedSchemaNames.map((schemaName) => schemaName.toLowerCase()));
    [draft.primaryViewName, ...draft.supportingViewNames].filter(Boolean).forEach((viewName) => {
      const option = input.viewOptions.find((candidate) => candidate.viewName.toLowerCase() === viewName.toLowerCase());
      if (option?.schemaName && !focusedSchemas.has(option.schemaName.toLowerCase())) {
        issues.push(`Approved view "${viewName}" belongs to schema "${option.schemaName}", outside the selected schema focus.`);
      }
    });
  }
  if (input.requireApproval !== false && !draft.reviewedAndApproved) {
    issues.push('Review and approve the semantic blueprint before AI Review.');
  }

  return unique(issues, 30);
}

function stableBlueprintValue(draft: SemanticBlueprintDraft) {
  const normalized = normalizeSemanticBlueprintDraft(draft);
  return {
    ...normalized,
    businessQuestions: [...normalized.businessQuestions].sort(),
    focusedSchemaNames: [...normalized.focusedSchemaNames].sort(),
    supportingViewNames: [...normalized.supportingViewNames].sort(),
    relationshipDecisions: Object.fromEntries(
      Object.entries(normalized.relationshipDecisions).sort(([left], [right]) => left.localeCompare(right)),
    ),
    relationshipContracts: Object.fromEntries(
      Object.entries(normalized.relationshipContracts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    excludedViewNames: [...normalized.excludedViewNames].sort(),
  };
}

export function semanticBlueprintFingerprint(draft: SemanticBlueprintDraft): string {
  return `blueprint-sha256:${sha256Text(JSON.stringify(stableBlueprintValue(draft)))}`;
}

function stableMutationBoundary(input: SemanticBlueprintMutationBoundary) {
  return {
    targetTopicFileName: clean(input.targetTopicFileName).toLowerCase(),
    solutionPlanFingerprint: clean(input.solutionPlanFingerprint),
    permissionContractFingerprint: clean(input.permissionContractFingerprint),
    requestedArtifactFileNames: unique(input.requestedArtifactFileNames, 100).sort(),
    excludedArtifactFileNames: unique(input.excludedArtifactFileNames, 100).sort(),
    relationshipIntent: input.relationshipIntent,
    permissionIntent: input.permissionIntent,
    actionOverrides: Object.fromEntries(
      Object.entries(input.actionOverrides)
        .map(([key, action]) => [key.trim().toLowerCase(), action] as const)
        .filter(([key]) => Boolean(key))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function semanticBlueprintMutationFingerprint(input: SemanticBlueprintMutationBoundary): string {
  return `mutation-sha256:${sha256Text(JSON.stringify(stableMutationBoundary(input)))}`;
}

export function semanticBlueprintPlanBindings(
  draft: SemanticBlueprintDraft,
  viewOptions: readonly SemanticBlueprintViewOption[],
): SemanticBlueprintPlanBindings {
  const blueprint = normalizeSemanticBlueprintDraft(draft);
  const approvedNames = new Set(
    [blueprint.primaryViewName, ...blueprint.supportingViewNames]
      .filter(Boolean)
      .map((viewName) => viewName.toLowerCase()),
  );
  const requestedArtifactFileNames = unique(viewOptions
    .filter((option) => approvedNames.has(option.viewName.toLowerCase()))
    .map((option) => option.fileName || ''), 40);
  const excludedArtifactFileNames = unique(viewOptions
    .filter((option) => !approvedNames.has(option.viewName.toLowerCase()))
    .map((option) => option.fileName || ''), Math.max(1, viewOptions.length));
  const actionOverrides = Object.fromEntries(requestedArtifactFileNames.map((fileName) => [
    `${/\.query\.view$/i.test(fileName) ? 'query_view' : 'view'}:${fileName.toLowerCase()}`,
    'reuse' as SemanticArtifactAction,
  ]));

  return {
    requestedArtifactFileNames,
    excludedArtifactFileNames,
    actionOverrides,
  };
}

export function semanticBlueprintPromptScope(
  draft: SemanticBlueprintDraft,
  viewOptions: readonly SemanticBlueprintViewOption[],
): SemanticBlueprintPromptScope {
  const blueprint = normalizeSemanticBlueprintDraft(draft);
  const viewNames = unique([
    blueprint.primaryViewName,
    ...blueprint.supportingViewNames,
  ], 13);
  const approvedNames = new Set(viewNames.map((viewName) => viewName.toLowerCase()));
  const approvedViewFiles = viewOptions
    .filter((option) => approvedNames.has(option.viewName.toLowerCase()))
    .map((option) => option.fileName || '');

  return {
    readOnlyFileNames: unique(['model', 'relationships', ...approvedViewFiles], 20),
    viewNames,
  };
}

export function semanticBlueprintSourceFingerprint(
  draft: SemanticBlueprintDraft,
  modelYaml: Pick<OmniModelYamlResponse, 'files' | 'viewNames' | 'checksums'> | null | undefined,
  targetTopicFileName = '',
): string {
  const scope = semanticBlueprintPromptScope(draft, semanticBlueprintViewOptions(modelYaml));
  const files = modelYaml?.files || {};
  const sourceClosure = scope.readOnlyFileNames
    .filter((fileName) => Object.prototype.hasOwnProperty.call(files, fileName))
    .sort()
    .map((fileName) => ({
      fileName,
      yamlDigest: sha256Text(files[fileName] || ''),
    }));
  const normalizedTarget = targetTopicFileName.trim().replace(/^\/+/, '');
  const targetTopicSnapshot = authoredTopicYamlFiles(modelYaml, normalizedTarget.replace(/\.topic$/i, ''))
    .map(({ fileName }) => fileName)
    .sort()
    .map((fileName) => ({
      fileName,
      yamlDigest: sha256Text(files[fileName] || ''),
    }));
  return `source-sha256:${sha256Text(JSON.stringify({
    views: [...scope.viewNames].sort(),
    sourceClosure,
    targetTopic: {
      requestedFileName: normalizedTarget,
      matches: targetTopicSnapshot,
    },
  }))}`;
}

export function createSemanticBlueprintApproval(input: {
  draft: SemanticBlueprintDraft;
  modelId: string;
  modelYaml: Pick<OmniModelYamlResponse, 'files' | 'viewNames' | 'checksums'>;
  mutationBoundary: SemanticBlueprintMutationBoundary;
}): SemanticBlueprintApproval {
  return Object.freeze({
    schemaVersion: 'omnikit.semantic-blueprint-approval.v4',
    modelId: input.modelId,
    blueprintFingerprint: semanticBlueprintFingerprint(input.draft),
    sourceFingerprint: semanticBlueprintSourceFingerprint(
      input.draft,
      input.modelYaml,
      input.mutationBoundary.targetTopicFileName,
    ),
    mutationFingerprint: semanticBlueprintMutationFingerprint(input.mutationBoundary),
  });
}

export function semanticBlueprintApprovalIssues(input: {
  approval: SemanticBlueprintApproval | null | undefined;
  draft: SemanticBlueprintDraft;
  modelId: string;
  modelYaml: Pick<OmniModelYamlResponse, 'files' | 'viewNames' | 'checksums'> | null | undefined;
  mutationBoundary: SemanticBlueprintMutationBoundary;
}): string[] {
  const issues: string[] = [];
  if (!input.approval) return ['The semantic blueprint approval snapshot is missing. Return to Scope and approve it again.'];
  if (input.approval.modelId !== input.modelId) {
    issues.push('The selected model changed after semantic blueprint approval.');
  }
  if (input.approval.blueprintFingerprint !== semanticBlueprintFingerprint(input.draft)) {
    issues.push('The semantic blueprint changed after approval.');
  }
  if (input.approval.sourceFingerprint !== semanticBlueprintSourceFingerprint(
    input.draft,
    input.modelYaml,
    input.mutationBoundary.targetTopicFileName,
  )) {
    issues.push('The approved model, relationship, view, or target topic context changed after semantic blueprint approval.');
  }
  if (input.approval.mutationFingerprint !== semanticBlueprintMutationFingerprint(input.mutationBoundary)) {
    issues.push('The requested artifact, relationship, permission, or action plan changed after semantic blueprint approval.');
  }
  return issues;
}

export function semanticBlueprintPackageIssues(input: SemanticBlueprintPackageInput): string[] {
  const blueprint = normalizeSemanticBlueprintDraft(input.draft);
  const approvedStagedViewIdentities = input.approvedStagedViewIdentities
    ?? (input.approvedStagedViewFileNames === undefined
      ? undefined
      : input.approvedStagedViewFileNames.flatMap((fileName) => {
          const option = input.viewOptions.find((candidate) => (
            candidate.fileName?.trim().toLowerCase() === fileName.trim().toLowerCase()
          ));
          return option?.identity ? [option.identity] : [];
        }));
  return unique([
    ...semanticBlueprintIssues({
      draft: blueprint,
      viewOptions: input.viewOptions,
      relationshipIntent: input.relationshipIntent,
      permissionIntent: input.permissionIntent,
    }),
    ...semanticBlueprintTopicArtifactIssues(input),
    ...semanticApprovedTopicViewScopeIssues({
      files: input.files,
      approvedExistingViewNames: [blueprint.primaryViewName, ...blueprint.supportingViewNames],
      approvedStagedViewFileNames: input.approvedStagedViewFileNames,
      approvedStagedViewIdentities,
      primaryExistingViewName: blueprint.primaryViewName,
      baselineRelationshipsYaml: input.baselineRelationshipsYaml,
      relationshipDecisions: blueprint.relationshipDecisions,
      relationshipContracts: Object.values(blueprint.relationshipContracts).map((contract) => ({
        join_from_view: contract.joinFromView,
        join_to_view: contract.joinToView,
        join_type: contract.joinType,
        on_sql: contract.onSql,
        relationship_type: contract.relationshipType,
        reversible: contract.reversible,
      })),
      approvedTargetTopicFileName: input.approvedTargetTopicFileName,
      allowPartialPackage: input.allowPartialPackage,
    }),
    ...semanticBlueprintDefaultDateIssues({
      blueprint,
      viewOptions: input.viewOptions,
      files: input.files,
    }),
  ], 40);
}

function comparableTopicFileName(value: string): string {
  return clean(value)
    .replace(/^\/+/, '')
    .replace(/^topics\//i, '')
    .toLowerCase();
}

function semanticBlueprintTopicArtifactIssues(input: SemanticBlueprintPackageInput): string[] {
  const topicFiles = input.files.filter((file) => /\.topic$/i.test(file.fileName.trim()));
  if (topicFiles.length === 0) {
    return input.allowPartialPackage
      ? []
      : ['The governed semantic package must contain exactly one complete topic artifact.'];
  }
  if (topicFiles.length > 1) {
    return [`The governed semantic package contains ${topicFiles.length} topic artifacts; exactly one approved target topic is allowed.`];
  }

  const [topicFile] = topicFiles;
  const issues: string[] = [];
  const approvedTarget = comparableTopicFileName(input.approvedTargetTopicFileName || '');
  if (approvedTarget && comparableTopicFileName(topicFile.fileName) !== approvedTarget) {
    issues.push(`${topicFile.fileName} does not match the approved target topic ${input.approvedTargetTopicFileName}.`);
  }

  const topicRecord = parsedRecord(topicFile.yaml);
  if (!topicRecord) {
    issues.push(`${topicFile.fileName} must contain one complete, valid YAML topic object.`);
    return issues;
  }
  if (!clean(topicRecord.base_view)) {
    issues.push(`${topicFile.fileName} must include a non-empty base_view.`);
  }
  return issues;
}

function normalizedDateFieldReference(value: string): string {
  return clean(value).replace(/\[[^\]]+\]$/u, '').toLowerCase();
}

function semanticBlueprintDefaultDateIssues(input: {
  blueprint: SemanticBlueprintDraft;
  viewOptions: readonly SemanticBlueprintViewOption[];
  files: readonly SemanticReferenceFile[];
}): string[] {
  const reachableViews = [
    input.blueprint.primaryViewName,
    ...input.blueprint.supportingViewNames,
  ].filter(Boolean);
  const verifiedDateFields = new Map(
    semanticBlueprintDateTimeFieldOptions(input.viewOptions, reachableViews)
      .map((option) => [normalizedDateFieldReference(option.fieldReference), option.fieldReference]),
  );
  const approvedDate = normalizedDateFieldReference(input.blueprint.primaryDateField);

  return input.files.flatMap((file) => {
    if (!file.fileName.endsWith('.topic')) return [];
    const record = parsedRecord(file.yaml);
    const defaultFilters = record?.default_filters;
    if (!defaultFilters || typeof defaultFilters !== 'object' || Array.isArray(defaultFilters)) {
      return approvedDate && !input.blueprint.primaryDateNotRequired
        ? [`${file.fileName} does not include the approved primary date "${input.blueprint.primaryDateField}" in default_filters.`]
        : [];
    }

    const defaultFilterKeys = Object.keys(defaultFilters as Record<string, unknown>);
    const normalizedDefaultFilterKeys = defaultFilterKeys.map(normalizedDateFieldReference);
    const issues = approvedDate
      && !input.blueprint.primaryDateNotRequired
      && !normalizedDefaultFilterKeys.includes(approvedDate)
      ? [`${file.fileName} does not include the approved primary date "${input.blueprint.primaryDateField}" in default_filters.`]
      : [];

    return [...issues, ...defaultFilterKeys.flatMap((fieldReference) => {
      const normalized = normalizedDateFieldReference(fieldReference);
      const verifiedReference = verifiedDateFields.get(normalized);
      if (!verifiedReference) return [];
      if (input.blueprint.primaryDateNotRequired) {
        return [`${file.fileName} adds a default date filter on "${verifiedReference}", but the approved Blueprint explicitly selected No default date.`];
      }
      if (approvedDate && normalized !== approvedDate) {
        return [`${file.fileName} adds a default date filter on "${verifiedReference}", but the approved primary date is "${input.blueprint.primaryDateField}".`];
      }
      return [];
    })];
  });
}

export function formatSemanticBlueprintForAi(draft: SemanticBlueprintDraft): string {
  const blueprint = normalizeSemanticBlueprintDraft(draft);
  const approvedViews = [blueprint.primaryViewName, ...blueprint.supportingViewNames].filter(Boolean);
  return [
    '## User-approved semantic blueprint (immutable boundary)',
    `- Business outcome: ${blueprint.businessPurpose || 'Not confirmed'}`,
    `- Audience: ${blueprint.audience || 'Not specified'}`,
    `- Intended grain: ${blueprint.grain || 'Not confirmed'}`,
    `- Business questions: ${blueprint.businessQuestions.join(' | ') || 'Not confirmed'}`,
    `- Focus schemas: ${blueprint.focusedSchemaNames.join(', ') || 'No physical schema restriction confirmed'}`,
    `- Primary/base view: ${blueprint.primaryViewName || 'Not confirmed'}`,
    `- Supporting views: ${blueprint.supportingViewNames.join(', ') || 'None approved'}`,
    `- Relationship decisions: ${blueprint.supportingViewNames.map((viewName) => `${viewName}=${blueprint.relationshipDecisions[viewName] || 'needs_review'}`).join(', ') || 'No supporting-view relationships required'}`,
    `- Exact relationship contracts: ${blueprint.supportingViewNames.flatMap((viewName) => {
      const contract = blueprint.relationshipContracts[viewName];
      return contract ? [`${viewName}=${JSON.stringify(contract)}`] : [];
    }).join(' | ') || 'No relationship contract approved'}`,
    `- Include-only view policy: ${approvedViews.length} approved view(s); every other model view remains out of scope. Do not mention or reuse out-of-scope views in generated YAML, labels, descriptions, sample queries, or ai_context.`,
    `- Primary date field: ${blueprint.primaryDateNotRequired ? 'Explicitly no default date' : blueprint.primaryDateField || 'Not confirmed'}`,
    `- Relationship guidance: ${blueprint.relationshipGuidance || 'Use only reviewed relationship evidence. Propose joins only where the decision is propose_reusable; never invent unsupported keys or cardinality'}`,
    `- Security guidance: ${blueprint.securityGuidance || 'No additional security guidance supplied here; preserve separately reviewed access controls'}`,
    `- Blueprint approval: ${blueprint.reviewedAndApproved ? 'Approved by the user' : 'Not approved'}`,
    '',
    'Enforcement rules:',
    `- The topic base_view must be exactly ${blueprint.primaryViewName || 'the confirmed primary view'}.`,
    `- Existing model views allowed in generated topic or relationship changes: ${approvedViews.join(', ') || 'none'}.`,
    '- For propose_reusable decisions, propose the minimum complete reusable relationship graph needed to make each approved supporting view reachable from the primary view. An edge may connect two approved supporting views when the reviewed key evidence requires a multi-hop path. Use only fields and evidence present in the supplied reviewed view YAML. If join keys or cardinality are not supported, return a blocking recommendation instead of guessing.',
    '- Return only proposed in-scope relationship rows. OmniKit preserves and merges the authored relationship baseline deterministically after validation. Never reproduce or mention unrelated baseline rows or comments.',
    '- The primary date must equal the approved verified date/time field, or remain absent when no default date was explicitly approved.',
    '- Do not introduce a view, schema, join, field, artifact, access rule, or business assumption outside this blueprint.',
    '- If the solution requires broader scope, return a recommendation for user approval instead of generating the change.',
  ].join('\n');
}
