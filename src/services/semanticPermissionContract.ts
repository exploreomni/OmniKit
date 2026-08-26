import { isMap, parse, parseDocument } from 'yaml';
import { sha256Text } from './contentHash';

export type SemanticPermissionMode = 'grant_only' | 'row_filter_only' | 'grant_and_row_filter';

export type SemanticPermissionGrantLogic = 'all' | 'any';

export type SemanticPermissionAccessGrantDraft = {
  id: string;
  name: string;
  userAttribute: string;
  allowedValues: string[];
  accessBoostable: boolean;
};

export type SemanticPermissionTopicAccessFilterDraft = {
  id: string;
  field: string;
  userAttribute: string;
  allowUnfilteredValues: boolean;
  valuesForUnfiltered: string[];
};

export type SemanticPermissionContractDraft = {
  mode: SemanticPermissionMode;
  grants: SemanticPermissionAccessGrantDraft[];
  grantLogic: SemanticPermissionGrantLogic;
  filters: SemanticPermissionTopicAccessFilterDraft[];
  reviewedAndConfirmed: boolean;
};

export type SemanticPermissionUserAttributeOption = {
  reference: string;
  label: string;
  type: string;
  multipleValues: boolean;
  system: boolean;
  defaultValue: string;
};

export type SemanticPermissionFieldOption = {
  reference: string;
  label: string;
  viewName: string;
  fieldName: string;
  kind: 'dimension' | 'field';
};

export type SemanticPermissionFilterableViewOption = {
  name: string;
  fieldCount: number;
};

export type SemanticPermissionAccessGrant = {
  name: string;
  userAttribute: string;
  allowedValues: string[];
  accessBoostable: boolean;
};

export type SemanticPermissionTopicAccessFilter = {
  field: string;
  userAttribute: string;
  valuesForUnfiltered: string[];
};

export type SemanticPermissionContract = {
  accessGrants: SemanticPermissionAccessGrant[];
  topicRequiredAccessGrants: string[];
  topicAccessFilters: SemanticPermissionTopicAccessFilter[];
};

export const EMPTY_SEMANTIC_PERMISSION_CONTRACT_DRAFT: SemanticPermissionContractDraft = {
  mode: 'grant_and_row_filter',
  grants: [{ id: 'grant-1', name: '', userAttribute: '', allowedValues: [], accessBoostable: false }],
  grantLogic: 'all',
  filters: [{ id: 'filter-1', field: '', userAttribute: '', allowUnfilteredValues: false, valuesForUnfiltered: [] }],
  reviewedAndConfirmed: false,
};

const GRANT_NAME_PATTERN = /^[A-Za-z_][\w-]*$/;
const USER_ATTRIBUTE_PATTERN = /^[A-Za-z_][\w.-]*$/;
const FIELD_REFERENCE_PATTERN = /^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/;

export function semanticPermissionListValues(value: string | string[]) {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : value.split(','))
    .map((item) => item.trim().replace(/^[`"']+|[`"']+$/g, ''))
    .filter((item) => {
      if (!item || /[\r\n\0]/.test(item)) return false;
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

export function semanticPermissionReviewedBaseViewNames(evidence: readonly unknown[]) {
  const names = new Map<string, string>();
  const addName = (value: unknown) => {
    if (typeof value !== 'string') return;
    const name = value.trim().replace(/^[`"']+|[`"']+$/g, '');
    if (!/^[A-Za-z_][\w-]*$/.test(name)) return;
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  };
  const inspectText = (value: string) => {
    const patterns = [
      /"baseView"\s*:\s*"([A-Za-z_][\w-]*)"/gi,
      /"base_view(?:_name)?"\s*:\s*"([A-Za-z_][\w-]*)"/gi,
      /^\s*base_view(?:_name)?\s*:\s*[`"']?([A-Za-z_][\w-]*)/gim,
      /\*\*Base view:\*\*\s*`?([A-Za-z_][\w-]*)/gi,
      /^\s*base view\s*:\s*`?([A-Za-z_][\w-]*)/gim,
    ];
    patterns.forEach((pattern) => {
      for (const match of value.matchAll(pattern)) addName(match[1]);
    });
  };
  const inspect = (value: unknown, depth = 0) => {
    if (typeof value === 'string') {
      inspectText(value);
      return;
    }
    const record = permissionRecord(value);
    if (!record || depth > 2) return;
    Object.entries(record).forEach(([key, nested]) => {
      if (['baseview', 'base_view', 'base_view_name'].includes(key.toLowerCase())) addName(nested);
      if (nested && typeof nested === 'object') inspect(nested, depth + 1);
    });
  };

  evidence.forEach((value) => inspect(value));
  return Array.from(names.values());
}

function permissionRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstPermissionString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function normalizeSemanticPermissionUserAttributes(payload: unknown): SemanticPermissionUserAttributeOption[] {
  const root = permissionRecord(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.records)
      ? root.records
      : Array.isArray(root?.userAttributes)
        ? root.userAttributes
        : Array.isArray(root?.user_attributes)
          ? root.user_attributes
          : [];
  const options = new Map<string, SemanticPermissionUserAttributeOption>();

  candidates.forEach((candidate) => {
    const record = permissionRecord(candidate);
    if (!record) return;
    const reference = firstPermissionString(record, ['reference', 'name', 'key']);
    if (!USER_ATTRIBUTE_PATTERN.test(reference)) return;
    const label = firstPermissionString(record, ['label', 'displayName', 'display_name']) || reference;
    const type = firstPermissionString(record, ['type', 'dataType', 'data_type']) || 'String';
    const defaultValueSource = record.default_value ?? record.defaultValue;
    const defaultValue = defaultValueSource == null
      ? ''
      : String(defaultValueSource);
    if (options.has(reference)) return;
    options.set(reference, {
      reference,
      label,
      type,
      multipleValues: Boolean(record.multiple_values ?? record.multipleValues),
      system: Boolean(record.system),
      defaultValue,
    });
  });

  return Array.from(options.values()).sort((left, right) =>
    Number(left.system) - Number(right.system)
    || left.label.localeCompare(right.label)
    || left.reference.localeCompare(right.reference));
}

function permissionFieldNames(value: unknown) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      const record = permissionRecord(entry);
      return record ? [firstPermissionString(record, ['name', 'field_name', 'fieldName', 'id'])].filter(Boolean) : [];
    });
  }
  const record = permissionRecord(value);
  return record ? Object.keys(record) : [];
}

function permissionTopicFieldOptions(
  value: unknown,
  viewName: string,
  kind: SemanticPermissionFieldOption['kind'],
) {
  const entries = Array.isArray(value)
    ? value
    : permissionRecord(value)
      ? Object.entries(permissionRecord(value) || {}).map(([name, definition]) => ({ name, definition }))
      : [];

  return entries.flatMap((entry): SemanticPermissionFieldOption[] => {
    if (typeof entry === 'string') {
      const fieldName = entry.includes('.') ? entry.split('.').pop() || entry : entry;
      const reference = entry.includes('.') ? entry : `${viewName}.${entry}`;
      return FIELD_REFERENCE_PATTERN.test(reference)
        ? [{ reference, label: fieldName, viewName, fieldName, kind }]
        : [];
    }

    const record = permissionRecord(entry);
    if (!record) return [];
    const nestedDefinition = permissionRecord(record.definition);
    const fieldName = firstPermissionString(record, ['field_name', 'fieldName', 'name', 'id']);
    if (!fieldName) return [];
    const reference = firstPermissionString(record, ['fully_qualified_name', 'fullyQualifiedName'])
      || (fieldName.includes('.') ? fieldName : `${viewName}.${fieldName}`);
    if (!FIELD_REFERENCE_PATTERN.test(reference)) return [];
    return [{
      reference,
      label: firstPermissionString(record, ['label', 'field_label', 'fieldLabel', 'parent_label', 'parentLabel'])
        || firstPermissionString(nestedDefinition || {}, ['label'])
        || fieldName.split('.').pop()
        || fieldName,
      viewName: reference.split('.')[0],
      fieldName: reference.split('.').slice(1).join('.'),
      kind,
    }];
  });
}

function permissionViewName(record: Record<string, unknown>) {
  return firstPermissionString(record, ['name', 'view_name', 'viewName', 'id']);
}

function semanticPermissionTopicFields(topicDetail: unknown) {
  const root = permissionRecord(topicDetail);
  const views = Array.isArray(root?.views) ? root.views : [];
  const options: SemanticPermissionFieldOption[] = [];
  views.forEach((view) => {
    const record = permissionRecord(view);
    if (!record) return;
    const viewName = permissionViewName(record);
    if (!viewName) return;
    const dimensions = permissionTopicFieldOptions(record.dimensions, viewName, 'dimension');
    const fallbackFields = permissionTopicFieldOptions(record.fields, viewName, 'field');
    const filterOnlyFields = permissionTopicFieldOptions(record.filter_only_fields ?? record.filterOnlyFields, viewName, 'field');
    options.push(...(dimensions.length > 0 ? dimensions : fallbackFields), ...filterOnlyFields);
  });
  return options;
}

function viewNameFromPermissionFile(fileName: string) {
  const leaf = fileName.split('/').pop() || fileName;
  if (leaf.endsWith('.query.view')) return leaf.slice(0, -'.query.view'.length);
  return leaf.endsWith('.view') ? leaf.slice(0, -'.view'.length) : '';
}

function semanticPermissionModelFields(
  files: Record<string, string>,
  viewNames: Record<string, unknown> = {},
) {
  const options: SemanticPermissionFieldOption[] = [];
  Object.entries(files).forEach(([fileName, yaml]) => {
    const indexedViewName = viewNames[fileName];
    const viewName = (typeof indexedViewName === 'string' ? indexedViewName.trim() : '')
      || viewNameFromPermissionFile(fileName);
    if (!viewName) return;
    try {
      const record = permissionRecord(parse(yaml || '{}'));
      permissionFieldNames(record?.dimensions).forEach((fieldName) => {
        if (!/^[A-Za-z_][\w-]*$/.test(fieldName)) return;
        options.push({
          reference: `${viewName}.${fieldName}`,
          label: fieldName,
          viewName,
          fieldName,
          kind: 'dimension',
        });
      });
    } catch {
      // Invalid source YAML is surfaced by the governed model validation path.
    }
  });
  return options;
}

export function semanticPermissionFieldOptions(input: {
  topicDetail?: unknown;
  modelFiles?: Record<string, string>;
  modelViewNames?: Record<string, unknown>;
  allowedViewNames?: string[];
}) {
  const topicOptions = semanticPermissionTopicFields(input.topicDetail);
  const allowedViewNames = new Set(
    (input.allowedViewNames || []).map((viewName) => viewName.trim().toLowerCase()).filter(Boolean),
  );
  const modelOptions = semanticPermissionModelFields(
    input.modelFiles || {},
    input.modelViewNames || {},
  );
  const candidates = topicOptions.length > 0
    ? topicOptions
    : allowedViewNames.size > 0
      ? modelOptions.filter((option) => allowedViewNames.has(option.viewName.toLowerCase()))
      : [];
  const unique = new Map<string, SemanticPermissionFieldOption>();
  candidates.forEach((option) => unique.set(option.reference, option));
  return Array.from(unique.values()).sort((left, right) =>
    left.viewName.localeCompare(right.viewName)
    || left.label.localeCompare(right.label)
    || left.reference.localeCompare(right.reference));
}

export function semanticPermissionFilterableViewOptions(input: {
  modelFiles?: Record<string, string>;
  modelViewNames?: Record<string, unknown>;
}) {
  const counts = new Map<string, SemanticPermissionFilterableViewOption>();
  semanticPermissionModelFields(
    input.modelFiles || {},
    input.modelViewNames || {},
  ).forEach((field) => {
    const key = field.viewName.toLowerCase();
    const existing = counts.get(key);
    counts.set(key, {
      name: existing?.name || field.viewName,
      fieldCount: (existing?.fieldCount || 0) + 1,
    });
  });
  return Array.from(counts.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function semanticPermissionContractIssues(draft: SemanticPermissionContractDraft) {
  const issues: string[] = [];
  const includesGrant = draft.mode !== 'row_filter_only';
  const includesRowFilter = draft.mode !== 'grant_only';

  if (includesGrant && draft.grants.length === 0) {
    issues.push('Add at least one model access grant.');
  }
  const grantNames = new Set<string>();
  if (includesGrant) draft.grants.forEach((grant, index) => {
    const label = `Grant ${index + 1}`;
    const normalizedName = grant.name.trim().toLowerCase();
    if (!GRANT_NAME_PATTERN.test(grant.name.trim())) {
      issues.push(`${label}: enter a name using letters, numbers, underscores, or hyphens; it must begin with a letter or underscore.`);
    } else if (grantNames.has(normalizedName)) {
      issues.push(`${label}: grant names must be unique.`);
    } else {
      grantNames.add(normalizedName);
    }
    if (!USER_ATTRIBUTE_PATTERN.test(grant.userAttribute.trim())) {
      issues.push(`${label}: choose an Omni user attribute.`);
    }
    if (semanticPermissionListValues(grant.allowedValues).length === 0) {
      issues.push(`${label}: add at least one exact attribute value that receives access.`);
    }
  });

  if (includesRowFilter && draft.filters.length === 0) {
    issues.push('Add at least one topic row filter.');
  }
  const filterFields = new Set<string>();
  if (includesRowFilter) draft.filters.forEach((filter, index) => {
    const label = `Row filter ${index + 1}`;
    const normalizedField = filter.field.trim().toLowerCase();
    if (!FIELD_REFERENCE_PATTERN.test(filter.field.trim())) {
      issues.push(`${label}: choose a field in view_name.field_name format.`);
    } else if (filterFields.has(normalizedField)) {
      issues.push(`${label}: each filtered field may appear only once.`);
    } else {
      filterFields.add(normalizedField);
    }
    if (!USER_ATTRIBUTE_PATTERN.test(filter.userAttribute.trim())) {
      issues.push(`${label}: choose an Omni user attribute.`);
    }
    if (filter.allowUnfilteredValues && semanticPermissionListValues(filter.valuesForUnfiltered).length === 0) {
      issues.push(`${label}: add at least one reviewed value that may see all rows.`);
    }
  });

  if (!draft.reviewedAndConfirmed) {
    issues.push('Confirm that the user attributes and values exist in Omni and that users without a row-filter value should fail closed.');
  }

  return issues;
}

export function semanticPermissionMetadataIssues(
  draft: SemanticPermissionContractDraft,
  input: {
    userAttributes: SemanticPermissionUserAttributeOption[];
    fieldOptions: SemanticPermissionFieldOption[];
    userAttributesLoaded: boolean;
  },
) {
  const issues: string[] = [];
  const includesGrant = draft.mode !== 'row_filter_only';
  const includesRowFilter = draft.mode !== 'grant_only';
  const attributeReferences = new Set(input.userAttributes.map((attribute) => attribute.reference));
  const fieldReferences = new Set(input.fieldOptions.map((field) => field.reference));

  if ((includesGrant || includesRowFilter) && !input.userAttributesLoaded) {
    issues.push('Load the Omni user-attribute inventory before confirming access rules.');
  }
  if (input.userAttributesLoaded) {
    if (includesGrant) draft.grants.forEach((grant, index) => {
      if (grant.userAttribute && !attributeReferences.has(grant.userAttribute)) {
        issues.push(`Grant ${index + 1}: ${grant.userAttribute} is not present in the loaded Omni attribute inventory.`);
      }
    });
    if (includesRowFilter) draft.filters.forEach((filter, index) => {
      if (filter.userAttribute && !attributeReferences.has(filter.userAttribute)) {
        issues.push(`Row filter ${index + 1}: ${filter.userAttribute} is not present in the loaded Omni attribute inventory.`);
      }
      const selectedAttribute = input.userAttributes.find((attribute) => attribute.reference === filter.userAttribute);
      if (
        filter.allowUnfilteredValues
        && selectedAttribute?.defaultValue
        && semanticPermissionListValues(filter.valuesForUnfiltered).includes(selectedAttribute.defaultValue)
      ) {
        issues.push(`Row filter ${index + 1}: ${selectedAttribute.defaultValue} is the default for ${selectedAttribute.reference} and cannot be used as an unfiltered bypass value.`);
      }
    });
  }
  if (includesRowFilter && input.fieldOptions.length === 0) {
    issues.push('Confirm a topic base view with at least one filterable dimension before configuring row filters.');
  } else if (includesRowFilter) {
    draft.filters.forEach((filter, index) => {
      if (filter.field && !fieldReferences.has(filter.field)) {
        issues.push(`Row filter ${index + 1}: ${filter.field} is not reachable from the reviewed topic scope.`);
      }
    });
  }

  return issues;
}

export function semanticPermissionContractFromDraft(
  draft: SemanticPermissionContractDraft,
): SemanticPermissionContract | null {
  if (semanticPermissionContractIssues(draft).length > 0) return null;

  const includesGrant = draft.mode !== 'row_filter_only';
  const includesRowFilter = draft.mode !== 'grant_only';
  const grants = includesGrant ? draft.grants.map((grant) => ({
    name: grant.name.trim(),
    userAttribute: grant.userAttribute.trim(),
    allowedValues: semanticPermissionListValues(grant.allowedValues),
    accessBoostable: grant.accessBoostable,
  })) : [];
  const grantNames = grants.map((grant) => grant.name);
  const requiredGrantExpression = grantNames.length <= 1
    ? grantNames
    : [grantNames.join(draft.grantLogic === 'all' ? '&' : '|')];
  return {
    accessGrants: grants,
    topicRequiredAccessGrants: requiredGrantExpression,
    topicAccessFilters: includesRowFilter ? draft.filters.map((filter) => ({
      field: filter.field.trim(),
      userAttribute: filter.userAttribute.trim(),
      valuesForUnfiltered: filter.allowUnfilteredValues
        ? semanticPermissionListValues(filter.valuesForUnfiltered)
        : [],
    })) : [],
  };
}

export function semanticPermissionContractFingerprint(
  draft: SemanticPermissionContractDraft,
): string {
  const stable = {
    mode: draft.mode,
    grantLogic: draft.grantLogic,
    reviewedAndConfirmed: draft.reviewedAndConfirmed,
    grants: draft.grants.map((grant) => ({
      name: grant.name.trim(),
      userAttribute: grant.userAttribute.trim(),
      allowedValues: semanticPermissionListValues(grant.allowedValues).sort(),
      accessBoostable: grant.accessBoostable,
    })).sort((left, right) => left.name.localeCompare(right.name)),
    filters: draft.filters.map((filter) => ({
      field: filter.field.trim(),
      userAttribute: filter.userAttribute.trim(),
      valuesForUnfiltered: filter.allowUnfilteredValues
        ? semanticPermissionListValues(filter.valuesForUnfiltered).sort()
        : [],
    })).sort((left, right) => left.field.localeCompare(right.field)),
  };
  return `permission-sha256:${sha256Text(JSON.stringify(stable))}`;
}

export function formatSemanticPermissionContract(draft: SemanticPermissionContractDraft) {
  const contract = semanticPermissionContractFromDraft(draft);
  if (!contract) return '';

  return [
    'Confirmed enforceable access contract:',
    `- Policy mode: ${draft.mode}.`,
    ...contract.accessGrants.map((grant) =>
      `- Define ${grant.name} grant with user_attribute: ${grant.userAttribute}; allowed_values: [${grant.allowedValues.join(', ')}]; access_boostable: ${grant.accessBoostable ? 'true' : 'false'}.`),
    ...(contract.accessGrants.length > 0 ? [
      `- Topic required_access_grants: [${contract.topicRequiredAccessGrants.join(', ')}].`,
    ] : []),
    ...contract.topicAccessFilters.map((filter) =>
      `- Topic access_filter on field: ${filter.field}; user_attribute: ${filter.userAttribute}; values_for_unfiltered: ${filter.valuesForUnfiltered.length ? `[${filter.valuesForUnfiltered.join(', ')}]` : 'none'}.`),
    '- The referenced user attributes and values are confirmed to exist in Omni.',
    ...(contract.topicAccessFilters.length > 0 ? ['- Users without the row-filter attribute value must fail closed; OmniKit must not add a default value.'] : []),
  ].join('\n');
}

function quotePermissionYamlValue(value: string) {
  return JSON.stringify(value);
}

export function renderSemanticPermissionAccessGrantEntries(grants: SemanticPermissionAccessGrant[]) {
  return grants.flatMap((grant) => [
    `  ${grant.name}:`,
    `    user_attribute: ${grant.userAttribute}`,
    '    allowed_values:',
    ...grant.allowedValues.map((value) => `      - ${quotePermissionYamlValue(value)}`),
    ...(grant.accessBoostable ? ['    access_boostable: true'] : []),
  ]);
}

export function renderSemanticPermissionRequiredAccessGrants(grantNames: string[]) {
  return [
    'required_access_grants:',
    ...grantNames.map((grantName) => `  - ${grantName}`),
  ].join('\n');
}

export function renderSemanticPermissionTopicAccessFilters(filters: SemanticPermissionTopicAccessFilter[]) {
  return [
    'access_filters:',
    ...filters.flatMap((filter) => [
      `  - field: ${filter.field}`,
      `    user_attribute: ${filter.userAttribute}`,
      ...(filter.valuesForUnfiltered.length > 0 ? [
        '    values_for_unfiltered:',
        ...filter.valuesForUnfiltered.map((value) => `      - ${quotePermissionYamlValue(value)}`),
      ] : []),
    ]),
  ].join('\n');
}

type UnknownRecord = Record<string, unknown>;

export type SemanticPermissionMergePlan = {
  accessGrantsToAdd: SemanticPermissionAccessGrant[];
  topicRequiredAccessGrants: string[];
  topicRequiredAccessGrantsToAdd: string[];
  topicAccessFiltersToAdd: SemanticPermissionTopicAccessFilter[];
  blockers: string[];
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function yamlRecord(value: string, label: string, blockers: string[]) {
  try {
    const parsed = parse(value || '{}');
    const record = asRecord(parsed);
    if (!record) blockers.push(`${label} must be a YAML mapping before access changes can be compiled.`);
    return record;
  } catch {
    blockers.push(`${label} is not valid YAML, so access changes cannot be merged safely.`);
    return null;
  }
}

function stringValues(value: unknown) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values
    .filter((item): item is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof item))
    .map((item) => String(item));
}

function sameValues(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  return left.every((value) => {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function existingTopicFilters(topic: UnknownRecord | null) {
  const value = topic?.access_filters;
  const filters = Array.isArray(value) ? value : value ? [value] : [];
  return filters.flatMap((entry) => {
    const record = asRecord(entry);
    const field = typeof record?.field === 'string' ? record.field : '';
    const userAttribute = typeof record?.user_attribute === 'string' ? record.user_attribute : '';
    if (!record || !field || !userAttribute) return [];
    return [{
      field,
      userAttribute,
      valuesForUnfiltered: stringValues(record.values_for_unfiltered),
    }];
  });
}

export function planSemanticPermissionMerge(input: {
  modelYaml: string;
  topicYaml: string;
  contract: SemanticPermissionContract;
}): SemanticPermissionMergePlan {
  const blockers: string[] = [];
  const model = yamlRecord(input.modelYaml, 'Settings/model', blockers);
  const topic = yamlRecord(input.topicYaml, 'The selected topic', blockers);
  const existingGrants = asRecord(model?.access_grants) || {};
  const accessGrantsToAdd: SemanticPermissionAccessGrant[] = [];

  input.contract.accessGrants.forEach((grant) => {
    const existing = asRecord(existingGrants[grant.name]);
    if (!existing) {
      accessGrantsToAdd.push(grant);
      return;
    }
    const equivalent = existing.user_attribute === grant.userAttribute
      && sameValues(stringValues(existing.allowed_values), grant.allowedValues)
      && Boolean(existing.access_boostable) === grant.accessBoostable;
    if (!equivalent) {
      blockers.push(`Access grant ${grant.name} already exists with a different definition. Review it explicitly instead of overwriting it.`);
    }
  });

  const existingRequiredGrants = stringValues(topic?.required_access_grants);
  const topicRequiredAccessGrants = Array.from(new Set([
    ...existingRequiredGrants,
    ...input.contract.topicRequiredAccessGrants,
  ]));
  const topicRequiredAccessGrantsToAdd = input.contract.topicRequiredAccessGrants
    .filter((grantName) => !existingRequiredGrants.includes(grantName));
  const existingFilters = existingTopicFilters(topic);
  const topicAccessFiltersToAdd: SemanticPermissionTopicAccessFilter[] = [];

  input.contract.topicAccessFilters.forEach((filter) => {
    const sameField = existingFilters.filter((existing) => existing.field === filter.field);
    const equivalent = sameField.find((existing) => existing.userAttribute === filter.userAttribute
      && sameValues(existing.valuesForUnfiltered, filter.valuesForUnfiltered));
    if (equivalent) return;
    if (sameField.length > 0) {
      blockers.push(`Topic access filter ${filter.field} already exists with a different contract. Review it explicitly instead of overwriting it.`);
      return;
    }
    topicAccessFiltersToAdd.push(filter);
  });

  return {
    accessGrantsToAdd,
    topicRequiredAccessGrants,
    topicRequiredAccessGrantsToAdd,
    topicAccessFiltersToAdd,
    blockers,
  };
}

function extractTopLevelBlock(yaml: string, key: string) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z_][\w-]*:\s*/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

function replaceTopLevelBlock(yaml: string, key: string, replacement: string, beforeKeys: string[] = []) {
  const sourceDocument = parseDocument(yaml || '{}', {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: false,
    uniqueKeys: true,
  });
  if (sourceDocument.errors.length > 0 || !isMap(sourceDocument.contents)) {
    throw new Error('The source YAML must contain one top-level mapping.');
  }

  const sourceMap = sourceDocument.contents;
  sourceMap.delete(key);
  if (!replacement.trim()) return String(sourceDocument).trimEnd();

  const replacementDocument = parseDocument(replacement, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: false,
    uniqueKeys: true,
  });
  if (replacementDocument.errors.length > 0 || !isMap(replacementDocument.contents)) {
    throw new Error(`The replacement ${key} block is not a valid YAML mapping.`);
  }
  const replacementPair = replacementDocument.contents.items.find((pair) => String(
    pair.key && typeof pair.key === 'object' && 'value' in pair.key
      ? pair.key.value
      : pair.key,
  ) === key);
  if (!replacementPair) throw new Error(`The replacement YAML does not define ${key}.`);

  sourceMap.items.push(replacementPair);
  sourceMap.flow = false;
  const insertedIndex = sourceMap.items.length - 1;
  const beforeIndex = sourceMap.items.findIndex((pair, index) => index !== insertedIndex && beforeKeys.includes(String(
    pair.key && typeof pair.key === 'object' && 'value' in pair.key
      ? pair.key.value
      : pair.key,
  )));
  if (beforeIndex >= 0) {
    sourceMap.items.splice(beforeIndex, 0, sourceMap.items.splice(insertedIndex, 1)[0]);
  }
  return String(sourceDocument).trimEnd();
}

function appendMappingEntries(existingBlock: string, key: string, entries: string[]) {
  if (!entries.length) return existingBlock.trimEnd();
  if (!existingBlock.trim() || new RegExp(`^${key}:\\s*(?:\\{\\})?\\s*$`).test(existingBlock.trim())) {
    return [`${key}:`, ...entries].join('\n');
  }
  return [existingBlock.trimEnd(), ...entries].join('\n');
}

function permissionListItem(value: string) {
  return /^[A-Za-z_][\w-]*$/.test(value) ? value : quotePermissionYamlValue(value);
}

function appendListItems(
  existingBlock: string,
  key: string,
  existingValues: string[],
  valuesToAdd: string[],
) {
  if (!valuesToAdd.length) return existingBlock.trimEnd();
  if (!existingBlock.trim()) {
    return [
      `${key}:`,
      ...valuesToAdd.map((value) => `  - ${permissionListItem(value)}`),
    ].join('\n');
  }
  const lines = existingBlock.split('\n');
  if (lines[0].trim() === `${key}:`) {
    return [existingBlock.trimEnd(), ...valuesToAdd.map((value) => `  - ${permissionListItem(value)}`)].join('\n');
  }
  const headerComment = lines[0].match(/\s+(#.*)$/)?.[1] || '';
  return [
    `${key}:${headerComment ? ` ${headerComment}` : ''}`,
    ...Array.from(new Set([...existingValues, ...valuesToAdd]))
      .map((value) => `  - ${permissionListItem(value)}`),
  ].join('\n');
}

function appendFilterEntries(existingBlock: string, filtersToAdd: SemanticPermissionTopicAccessFilter[]) {
  if (!filtersToAdd.length) return existingBlock.trimEnd();
  const rendered = renderSemanticPermissionTopicAccessFilters(filtersToAdd).split('\n').slice(1);
  if (!existingBlock.trim() || /^access_filters:\s*(?:\[\])?\s*$/.test(existingBlock.trim())) {
    return ['access_filters:', ...rendered].join('\n');
  }
  return [existingBlock.trimEnd(), ...rendered].join('\n');
}

export function compileSemanticPermissionYaml(input: {
  sourceModelYaml: string;
  sourceTopicYaml: string;
  baselineModelYaml: string;
  baselineTopicYaml: string;
  contract: SemanticPermissionContract;
}) {
  const plan = planSemanticPermissionMerge({
    modelYaml: input.baselineModelYaml,
    topicYaml: input.baselineTopicYaml,
    contract: input.contract,
  });
  if (plan.blockers.length > 0) {
    return { modelYaml: '', topicYaml: '', plan };
  }

  const accessGrantBlock = appendMappingEntries(
    extractTopLevelBlock(input.baselineModelYaml, 'access_grants'),
    'access_grants',
    renderSemanticPermissionAccessGrantEntries(plan.accessGrantsToAdd),
  );
  const requiredGrantBlock = appendListItems(
    extractTopLevelBlock(input.baselineTopicYaml, 'required_access_grants'),
    'required_access_grants',
    plan.topicRequiredAccessGrants.filter((name) => !plan.topicRequiredAccessGrantsToAdd.includes(name)),
    plan.topicRequiredAccessGrantsToAdd,
  );
  const accessFilterBlock = appendFilterEntries(
    extractTopLevelBlock(input.baselineTopicYaml, 'access_filters'),
    plan.topicAccessFiltersToAdd,
  );
  const topicBeforeKeys = ['joins', 'views', 'fields', 'ai_fields', 'sample_queries', 'ai_context'];

  try {
    const modelYaml = replaceTopLevelBlock(input.sourceModelYaml, 'access_grants', accessGrantBlock);
    const topicYaml = replaceTopLevelBlock(
      replaceTopLevelBlock(input.sourceTopicYaml, 'required_access_grants', requiredGrantBlock, topicBeforeKeys),
      'access_filters',
      accessFilterBlock,
      topicBeforeKeys,
    );
    yamlRecord(modelYaml, 'The compiled Settings/model file', plan.blockers);
    yamlRecord(topicYaml, 'The compiled topic file', plan.blockers);
    if (plan.blockers.length > 0) return { modelYaml: '', topicYaml: '', plan };
    return { modelYaml, topicYaml, plan };
  } catch (error) {
    plan.blockers.push(error instanceof Error
      ? `The reviewed access contract could not be compiled safely: ${error.message}`
      : 'The reviewed access contract could not be compiled safely.');
    return { modelYaml: '', topicYaml: '', plan };
  }
}

function stablePermissionRecord(value: unknown): UnknownRecord | null {
  const source = asRecord(value);
  if (!source) return null;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, stablePermissionValue(source[key])]),
  );
}

function stablePermissionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePermissionValue);
  return stablePermissionRecord(value) || value;
}

function canonicalAccessGrants(value: unknown) {
  const grants = asRecord(value) || {};
  return Object.fromEntries(Object.keys(grants).sort().map((name) => {
    const grant = asRecord(grants[name]);
    if (!grant) return [name, stablePermissionValue(grants[name])];
    const canonical = stablePermissionRecord(grant) || {};
    canonical.allowed_values = stringValues(grant.allowed_values).sort();
    canonical.access_boostable = Boolean(grant.access_boostable);
    return [name, canonical];
  }));
}

function canonicalRequiredAccessGrants(value: unknown) {
  return stringValues(value)
    .map((expression) => {
      const operator = expression.includes('&') ? '&' : expression.includes('|') ? '|' : '';
      return operator
        ? expression.split(operator).map((name) => name.trim()).filter(Boolean).sort().join(operator)
        : expression.trim();
    })
    .sort();
}

function canonicalAccessFilters(value: unknown) {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.map((entry) => {
    const filter = asRecord(entry);
    if (!filter) return stablePermissionValue(entry);
    const canonical = stablePermissionRecord(filter) || {};
    canonical.values_for_unfiltered = stringValues(filter.values_for_unfiltered).sort();
    return canonical;
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function permissionSecurityNodes(modelYaml: string, topicYaml: string, label: string, issues: string[]) {
  const model = yamlRecord(modelYaml, `${label} Settings/model`, issues);
  const topic = yamlRecord(topicYaml, `${label} topic`, issues);
  if (!model || !topic) return null;
  return {
    accessGrants: canonicalAccessGrants(model.access_grants),
    requiredAccessGrants: canonicalRequiredAccessGrants(topic.required_access_grants),
    accessFilters: canonicalAccessFilters(topic.access_filters),
  };
}

/**
 * Verifies only the enforceable security nodes while allowing unrelated YAML
 * authored elsewhere in the model and topic to remain unchanged.
 */
export function semanticPermissionPackageIssues(input: {
  modelYaml: string;
  topicYaml: string;
  baselineModelYaml: string;
  baselineTopicYaml: string;
  contract: SemanticPermissionContract;
}) {
  const compiled = compileSemanticPermissionYaml({
    sourceModelYaml: input.baselineModelYaml,
    sourceTopicYaml: input.baselineTopicYaml,
    baselineModelYaml: input.baselineModelYaml,
    baselineTopicYaml: input.baselineTopicYaml,
    contract: input.contract,
  });
  if (compiled.plan.blockers.length > 0) {
    return compiled.plan.blockers.map((blocker) => `The approved access contract could not be reconstructed: ${blocker}`);
  }

  const issues: string[] = [];
  const expected = permissionSecurityNodes(compiled.modelYaml, compiled.topicYaml, 'Expected', issues);
  const actual = permissionSecurityNodes(input.modelYaml, input.topicYaml, 'Staged', issues);
  if (!expected || !actual) return issues;

  if (JSON.stringify(actual.accessGrants) !== JSON.stringify(expected.accessGrants)) {
    issues.push('Settings/model access_grants do not exactly match the approved access contract and preserved baseline grants.');
  }
  if (JSON.stringify(actual.requiredAccessGrants) !== JSON.stringify(expected.requiredAccessGrants)) {
    issues.push('Topic required_access_grants do not exactly match the approved grant expression and preserved baseline requirements.');
  }
  if (JSON.stringify(actual.accessFilters) !== JSON.stringify(expected.accessFilters)) {
    issues.push('Topic access_filters do not exactly match the approved row-filter fields, Omni attributes, and bypass values.');
  }
  return issues;
}
