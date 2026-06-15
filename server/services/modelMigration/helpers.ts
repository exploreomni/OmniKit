import { MODEL_MIGRATION_PROMPT_VERSION, buildDialectTranslationPrompt } from './prompts';

const MODEL_REFERENCE_KEYS = new Set([
  'modelId',
  'model_id',
  'baseModelId',
  'base_model_id',
  'sharedModelId',
  'shared_model_id',
]);
const FIELD_REF_KEYS = new Set([
  'field',
  'fieldName',
  'field_name',
  'column_name',
  'columnName',
  'fields',
  'pivots',
  'sorts',
  'filters',
  'filter',
  'measures',
  'dimensions',
  'x',
  'y',
  'series',
]);
const FIELD_REF_PATTERN = /\b([A-Za-z_][\w/]*\.[A-Za-z_][\w]*(?:\[[A-Za-z_][\w]*\])?)\b/g;
const CONNECTION_SETTING_PATTERNS = [
  { key: 'connection', pattern: /^\s*connection\s*:/mi },
  { key: 'connection_name', pattern: /^\s*connection_name\s*:/mi },
  { key: 'database', pattern: /^\s*database\s*:/mi },
  { key: 'warehouse', pattern: /^\s*warehouse\s*:/mi },
  { key: 'query_timezone', pattern: /^\s*query_timezone\s*:/mi },
  { key: 'timezone', pattern: /^\s*timezone\s*:/mi },
  { key: 'query_timeout', pattern: /^\s*query_timeout\s*:/mi },
  { key: 'connection settings', pattern: /^\s*(host|account|project|catalog)\s*:/mi },
];

export interface SchemaMapRule {
  source: string;
  target: string;
}

export interface TranslatedYamlFile {
  fileName: string;
  original: string;
  deterministic: string;
  translated: string;
  aiDraft?: string;
  aiJobId?: string;
  aiRefusal?: string;
  blocked?: boolean;
  changed: boolean;
  promptVersion: string;
  reviewRequired: boolean;
  warnings: string[];
}

export interface WorkbookQueryRewrite {
  query: Record<string, unknown>;
  replacements: number;
  fieldReferences: string[];
  blockers: string[];
}

export interface WorkbookTabResultDetail {
  name: string;
  status: 'pending' | 'created' | 'not_created';
  retryBoundary: 'document';
  carried: string[];
}

export interface ContentValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  documentId?: string;
  documentName?: string;
  field?: string;
  view?: string;
  targetUrl?: string;
  status?: 'blocking' | 'advisory' | 'new' | 'pre_existing';
  raw?: unknown;
}

function quotedSegmentPattern(segment: string): string {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:"${escaped}"|\`${escaped}\`|\\[${escaped}\\]|${escaped})`;
}

function schemaReferencePattern(source: string): RegExp {
  const segments = source.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return /$a/;
  return new RegExp(`(^|[^A-Za-z0-9_])(${segments.map(quotedSegmentPattern).join('\\s*\\.\\s*')})(?=$|[^A-Za-z0-9_])`, 'gi');
}

export function detectConnectionSettingWarnings(yaml: string): string[] {
  const warnings = new Set<string>();
  for (const row of CONNECTION_SETTING_PATTERNS) {
    if (row.pattern.test(yaml)) warnings.add(`${row.key} may not transfer across connections; review the target model settings before merge.`);
  }
  return [...warnings];
}

export function normalizeBranchName(raw: string, fallback = 'model-migration'): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\/+/g, '/')
    .slice(0, 96);
  return cleaned || `omnikit-${fallback}-${new Date().toISOString().slice(0, 10)}`;
}

export function parseSchemaMap(raw: string): SchemaMapRule[] {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [source, target] = line.split(/\s*(?:->|=>|,)\s*/);
      return { source: source?.trim() || '', target: target?.trim() || '' };
    })
    .filter((row) => row.source && row.target);
}

export function applySchemaMapToYaml(yaml: string, rules: SchemaMapRule[]): { yaml: string; replacements: number } {
  let next = yaml;
  let replacements = 0;
  for (const rule of rules) {
    const pattern = schemaReferencePattern(rule.source);
    next = next.replace(pattern, (_match, prefix: string) => {
      replacements += 1;
      return `${prefix}${rule.target}`;
    });
  }
  return { yaml: next, replacements };
}

export function buildTranslatedYamlFiles(input: {
  files: Record<string, string>;
  schemaMap: SchemaMapRule[];
  sourceDialect: string;
  targetDialect: string;
}): TranslatedYamlFile[] {
  return Object.entries(input.files).map(([fileName, original]) => {
    const deterministic = applySchemaMapToYaml(original, input.schemaMap);
    const dialectChanged = Boolean(input.sourceDialect && input.targetDialect && input.sourceDialect !== input.targetDialect);
    const warnings = [
      ...(deterministic.replacements > 0 ? [`${deterministic.replacements} schema/catalog reference rewrite${deterministic.replacements === 1 ? '' : 's'} applied.`] : []),
      ...(dialectChanged ? [`${input.sourceDialect} to ${input.targetDialect} SQL requires human review for sql blocks.`] : []),
      ...detectConnectionSettingWarnings(original),
    ];
    return {
      fileName,
      original,
      deterministic: deterministic.yaml,
      translated: deterministic.yaml,
      changed: deterministic.yaml !== original,
      promptVersion: MODEL_MIGRATION_PROMPT_VERSION,
      reviewRequired: dialectChanged || deterministic.yaml !== original,
      warnings,
    };
  });
}

export function promptForYamlFile(input: {
  sourceDialect: string;
  targetDialect: string;
  fileName: string;
  schemaMap: SchemaMapRule[];
  yaml: string;
}): string {
  return buildDialectTranslationPrompt(input);
}

export function rewriteQueryModelReferences(
  query: Record<string, unknown>,
  sourceModelId: string,
  targetModelId: string,
): WorkbookQueryRewrite {
  let replacements = 0;
  const rewritten = rewriteUnknown(query, sourceModelId, targetModelId, () => {
    replacements += 1;
  }) as Record<string, unknown>;
  const fieldReferences = [...collectFieldReferences(rewritten)].sort();
  return { query: rewritten, replacements, fieldReferences, blockers: [] };
}

function rewriteUnknown(value: unknown, sourceModelId: string, targetModelId: string, onReplace: () => void, key?: string): unknown {
  if (typeof value === 'string' && key && MODEL_REFERENCE_KEYS.has(key) && value === sourceModelId) {
    onReplace();
    return targetModelId;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteUnknown(item, sourceModelId, targetModelId, onReplace));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, item]) => [
      childKey,
      rewriteUnknown(item, sourceModelId, targetModelId, onReplace, childKey),
    ]),
  );
}

export function collectFieldReferences(value: unknown, parentKey = ''): Set<string> {
  const refs = new Set<string>();
  if (typeof value === 'string') {
    if (FIELD_REF_KEYS.has(parentKey)) {
      for (const match of value.matchAll(FIELD_REF_PATTERN)) refs.add(match[1]);
    }
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectFieldReferences(item, parentKey)) refs.add(ref);
    }
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    for (const ref of collectFieldReferences(item, key)) refs.add(ref);
  }
  return refs;
}

export function buildFieldUniverseFromYaml(files: Record<string, string>): Set<string> {
  const refs = new Set<string>();
  for (const [fileName, yaml] of Object.entries(files)) {
    const viewName = fileName.endsWith('.view') ? fileName.replace(/\.view$/, '') : '';
    if (!viewName) continue;
    for (const match of yaml.matchAll(/^\s{2}([A-Za-z_][\w]*):\s*$/gm)) {
      refs.add(`${viewName}.${match[1]}`);
    }
    for (const match of yaml.matchAll(/name:\s*([A-Za-z_][\w]*)/g)) {
      refs.add(`${viewName}.${match[1]}`);
    }
  }
  return refs;
}

export function preflightWorkbookQueryFields(rewrite: WorkbookQueryRewrite, fieldUniverse: Set<string>): WorkbookQueryRewrite {
  const blockers = rewrite.fieldReferences
    .filter((field) => fieldUniverse.size > 0 && !fieldUniverse.has(field))
    .map((field) => `Field is not available on the target model: ${field}`);
  return { ...rewrite, blockers };
}

export function buildWorkbookTabResultDetails(
  tabs: Array<{ name: string; visConfig?: Record<string, unknown>; description?: string }>,
  status: WorkbookTabResultDetail['status'],
): WorkbookTabResultDetail[] {
  return tabs.map((tab) => ({
    name: tab.name,
    status,
    retryBoundary: 'document',
    carried: ['query', tab.visConfig ? 'visConfig' : '', tab.description ? 'description' : ''].filter(Boolean),
  }));
}

function stringFromKeys(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function severityFrom(row: Record<string, unknown>): ContentValidationIssue['severity'] {
  const raw = stringFromKeys(row, ['severity', 'level', 'type', 'status'])?.toLowerCase();
  if (raw?.includes('warn')) return 'warning';
  if (raw?.includes('info') || raw?.includes('advisory')) return 'info';
  if (row.is_warning === true || row.warning === true) return 'warning';
  return 'error';
}

function statusFrom(row: Record<string, unknown>, severity: ContentValidationIssue['severity']): ContentValidationIssue['status'] {
  const raw = stringFromKeys(row, ['validationStatus', 'validation_status', 'disposition', 'category', 'source'])?.toLowerCase();
  if (raw?.includes('pre')) return 'pre_existing';
  if (raw?.includes('new')) return 'new';
  if (raw?.includes('advis')) return 'advisory';
  if (raw?.includes('block')) return 'blocking';
  if (row.blocking === true || row.is_blocking === true) return 'blocking';
  return severity === 'error' ? 'blocking' : 'advisory';
}

export function normalizeContentValidationIssues(value: unknown): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    const message = stringFromKeys(row, ['message', 'error', 'description', 'details', 'reason']);
    if (message) {
      const severity = severityFrom(row);
      issues.push({
        severity,
        message,
        documentId: stringFromKeys(row, ['documentId', 'document_id', 'docId', 'id']),
        documentName: stringFromKeys(row, ['documentName', 'document_name', 'name', 'title']),
        field: stringFromKeys(row, ['field', 'fieldName', 'field_name']),
        view: stringFromKeys(row, ['view', 'viewName', 'view_name']),
        targetUrl: stringFromKeys(row, ['targetUrl', 'target_url', 'url', 'link']),
        status: statusFrom(row, severity),
        raw: row,
      });
      return;
    }
    for (const item of Object.values(row)) visit(item);
  };
  visit(value);
  return issues;
}
