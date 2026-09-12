import { csvRowsToText } from '../utils/csvExport';
import { parseCsvTable } from '../utils/csvImport';

export const BULK_CONTENT_LABEL_HEADERS = [
  'action',
  'target_type',
  'target_id_or_url',
  'labels',
] as const;

export const BULK_CONTENT_LABEL_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5_000,
  maxLabelsPerRow: 50,
  maxTotalLabelIntents: 20_000,
  maxTargetLength: 2_048,
  minLabelLength: 2,
  maxLabelLength: 25,
} as const;

export const BULK_CONTENT_LABELS_CELL_FORMAT =
  'Separate labels with unescaped commas. Use \\, for a literal comma and \\\\ for a literal backslash.';

export type BulkContentLabelAction = 'add' | 'remove';
export type BulkContentLabelTargetType = 'folder' | 'document';

export type BulkContentLabelIssueCode =
  | 'ROW_FIELD_COUNT_INVALID'
  | 'ACTION_REQUIRED'
  | 'ACTION_INVALID'
  | 'TARGET_TYPE_REQUIRED'
  | 'TARGET_TYPE_INVALID'
  | 'TARGET_REQUIRED'
  | 'TARGET_TOO_LONG'
  | 'TARGET_CONTROL_CHARACTER'
  | 'LABELS_REQUIRED'
  | 'LABEL_EMPTY'
  | 'LABEL_ESCAPE_INVALID'
  | 'LABEL_ESCAPE_INCOMPLETE'
  | 'LABEL_TOO_SHORT'
  | 'LABEL_TOO_LONG'
  | 'LABEL_CONTROL_CHARACTER'
  | 'LABELS_PER_ROW_LIMIT'
  | 'TOTAL_LABEL_INTENT_LIMIT'
  | 'CONFLICTING_ACTIONS';

export interface BulkContentLabelIssue {
  severity: 'error' | 'warning';
  code: BulkContentLabelIssueCode;
  message: string;
  rowNumber?: number;
  rowNumbers?: number[];
  targetType?: BulkContentLabelTargetType;
  targetIdOrUrl?: string;
  labels?: string[];
}

export interface BulkContentLabelRow {
  rowNumber: number;
  action: BulkContentLabelAction;
  targetType: BulkContentLabelTargetType;
  targetIdOrUrl: string;
  normalizedTarget: string;
  labels: string[];
}

export interface BulkContentLabelOperation {
  action: BulkContentLabelAction;
  targetType: BulkContentLabelTargetType;
  targetIdOrUrl: string;
  normalizedTarget: string;
  labels: string[];
  rowNumbers: number[];
}

export interface BulkContentLabelPlanSummary {
  sourceRows: number;
  acceptedRows: number;
  mergedRows: number;
  uniqueTargets: number;
  operations: number;
  labelsToAdd: number;
  labelsToRemove: number;
  conflicts: number;
}

export interface BulkContentLabelPlan {
  rows: BulkContentLabelRow[];
  operations: BulkContentLabelOperation[];
  issues: BulkContentLabelIssue[];
  summary: BulkContentLabelPlanSummary;
  blocked: boolean;
}

export const BULK_CONTENT_LABEL_TEMPLATE_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  BULK_CONTENT_LABEL_HEADERS,
  ['add', 'document', '00000000-0000-4000-8000-000000000001', 'Certified\\, Reviewed, Executive'],
  ['remove', 'folder', 'https://example.omniapp.co/folders/example-folder', 'Legacy'],
];

export const BULK_CONTENT_LABEL_TEMPLATE_CSV = csvRowsToText(
  BULK_CONTENT_LABEL_TEMPLATE_ROWS.map((row) => [...row]),
);

const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function comparisonKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

type ParsedCsvRecord = {
  cells: string[];
  lineNumber: number;
};

function parseStrictCsvRecords(content: string): ParsedCsvRecord[] {
  const input = content.replace(/^\uFEFF/, '');
  let state: 'field_start' | 'unquoted' | 'quoted' | 'after_quote' = 'field_start';
  let lineNumber = 1;
  let recordStartLine = 1;
  let recordStartIndex = 0;
  const records: ParsedCsvRecord[] = [];

  const finishRecord = (endIndex: number) => {
    const recordText = input.slice(recordStartIndex, endIndex);
    if (!recordText.trim()) {
      throw new Error(`CSV contains a blank line at physical line ${recordStartLine}. Remove blank lines before importing.`);
    }
    const parsed = parseCsvTable(recordText);
    if (parsed.length !== 1) {
      throw new Error(`CSV contains an empty row at physical line ${recordStartLine}.`);
    }
    records.push({ cells: parsed[0], lineNumber: recordStartLine });
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const newline = character === '\n' || character === '\r';

    if (newline) {
      const crlf = character === '\r' && input[index + 1] === '\n';
      if (state === 'quoted') {
        if (crlf) index += 1;
        lineNumber += 1;
        continue;
      }
      finishRecord(index);
      if (crlf) index += 1;
      lineNumber += 1;
      recordStartLine = lineNumber;
      recordStartIndex = index + 1;
      state = 'field_start';
      continue;
    }

    if (state === 'field_start') {
      if (character === '"') state = 'quoted';
      else if (character !== ',') state = 'unquoted';
      continue;
    }
    if (state === 'unquoted') {
      if (character === '"') throw new Error('CSV contains a quote inside an unquoted value.');
      if (character === ',') state = 'field_start';
      continue;
    }
    if (state === 'quoted') {
      if (character !== '"') continue;
      if (input[index + 1] === '"') {
        index += 1;
      } else {
        state = 'after_quote';
      }
      continue;
    }
    if (character === ',') state = 'field_start';
    else throw new Error('CSV contains characters after a closing quote.');
  }

  if (state === 'quoted') throw new Error('CSV contains an unterminated quoted value.');
  if (recordStartIndex < input.length) finishRecord(input.length);
  return records;
}

/**
 * Produces a stable local comparison value without resolving or fetching the
 * supplied target. The original trimmed reference is retained on every row and
 * operation for later, explicit resolution by the integration layer.
 */
export function normalizeBulkContentLabelTarget(value: string): string {
  const target = value.trim().normalize('NFC');
  if (UUID_PATTERN.test(target)) return target.toLowerCase();
  if (URL_SCHEME_PATTERN.test(target)) {
    try {
      return new URL(target).toString();
    } catch {
      // Non-standard or partially encoded references remain valid opaque input.
    }
  }
  return comparisonKey(target);
}

function normalizedAction(value: string): BulkContentLabelAction | null {
  const normalized = comparisonKey(value.trim());
  return normalized === 'add' || normalized === 'remove' ? normalized : null;
}

function normalizedTargetType(value: string): BulkContentLabelTargetType | null {
  const normalized = comparisonKey(value.trim());
  return normalized === 'folder' || normalized === 'document' ? normalized : null;
}

function parseLabels(value: string, rowNumber: number): {
  labels: string[];
  issues: BulkContentLabelIssue[];
} {
  const issues: BulkContentLabelIssue[] = [];
  if (!value.trim()) {
    return {
      labels: [],
      issues: [{
        severity: 'error',
        code: 'LABELS_REQUIRED',
        rowNumber,
        message: 'labels is required and must contain at least one label.',
      }],
    };
  }

  const rawLabels: string[] = [];
  let currentLabel = '';
  let escaping = false;
  for (const character of value) {
    if (escaping) {
      if (character !== ',' && character !== '\\') {
        return {
          labels: [],
          issues: [{
            severity: 'error',
            code: 'LABEL_ESCAPE_INVALID',
            rowNumber,
            message: `labels uses an unsupported escape. ${BULK_CONTENT_LABELS_CELL_FORMAT}`,
          }],
        };
      }
      currentLabel += character;
      escaping = false;
      continue;
    }
    if (character === '\\') {
      escaping = true;
      continue;
    }
    if (character === ',') {
      rawLabels.push(currentLabel);
      currentLabel = '';
      continue;
    }
    currentLabel += character;
  }
  if (escaping) {
    return {
      labels: [],
      issues: [{
        severity: 'error',
        code: 'LABEL_ESCAPE_INCOMPLETE',
        rowNumber,
        message: `labels ends with an incomplete escape. ${BULK_CONTENT_LABELS_CELL_FORMAT}`,
      }],
    };
  }
  rawLabels.push(currentLabel);
  if (rawLabels.length > BULK_CONTENT_LABEL_LIMITS.maxLabelsPerRow) {
    return {
      labels: [],
      issues: [{
        severity: 'error',
        code: 'LABELS_PER_ROW_LIMIT',
        rowNumber,
        message: `labels is limited to ${BULK_CONTENT_LABEL_LIMITS.maxLabelsPerRow} values per row.`,
      }],
    };
  }

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const rawLabel of rawLabels) {
    const label = rawLabel.trim().normalize('NFC');
    if (!label) {
      issues.push({
        severity: 'error',
        code: 'LABEL_EMPTY',
        rowNumber,
        message: 'labels cannot contain an empty value.',
      });
      continue;
    }
    if (label.length < BULK_CONTENT_LABEL_LIMITS.minLabelLength) {
      issues.push({
        severity: 'error',
        code: 'LABEL_TOO_SHORT',
        rowNumber,
        labels: [label],
        message: `Label values must contain at least ${BULK_CONTENT_LABEL_LIMITS.minLabelLength} characters.`,
      });
      continue;
    }
    if (label.length > BULK_CONTENT_LABEL_LIMITS.maxLabelLength) {
      issues.push({
        severity: 'error',
        code: 'LABEL_TOO_LONG',
        rowNumber,
        labels: [label],
        message: `Label values cannot exceed ${BULK_CONTENT_LABEL_LIMITS.maxLabelLength} characters.`,
      });
      continue;
    }
    if (hasControlCharacter(label)) {
      issues.push({
        severity: 'error',
        code: 'LABEL_CONTROL_CHARACTER',
        rowNumber,
        labels: [label],
        message: 'Label values cannot contain control characters.',
      });
      continue;
    }
    const key = comparisonKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  return { labels, issues };
}

function validateHeaders(header: string[]): void {
  const exact = header.length === BULK_CONTENT_LABEL_HEADERS.length
    && BULK_CONTENT_LABEL_HEADERS.every((expected, index) => header[index] === expected);
  if (exact) return;

  const known = new Set<string>(BULK_CONTENT_LABEL_HEADERS);
  const unknown = header.filter((name) => !known.has(name));
  const missing = BULK_CONTENT_LABEL_HEADERS.filter((name) => !header.includes(name));
  const details = [
    missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : '',
    unknown.length > 0 ? ` Unknown: ${unknown.join(', ')}.` : '',
  ].join('');
  throw new Error(`CSV headers must be exactly: ${BULK_CONTENT_LABEL_HEADERS.join(', ')}.${details}`);
}

function operationKey(row: Pick<BulkContentLabelRow, 'action' | 'targetType' | 'normalizedTarget'>): string {
  return `${row.targetType}\u0000${row.normalizedTarget}\u0000${row.action}`;
}

function targetKey(row: Pick<BulkContentLabelRow, 'targetType' | 'normalizedTarget'>): string {
  return `${row.targetType}\u0000${row.normalizedTarget}`;
}

function mergeOperations(rows: BulkContentLabelRow[]): BulkContentLabelOperation[] {
  const operations = new Map<string, BulkContentLabelOperation>();
  const labelKeysByOperation = new Map<string, Set<string>>();

  for (const row of rows) {
    const key = operationKey(row);
    const existing = operations.get(key);
    if (!existing) {
      operations.set(key, {
        action: row.action,
        targetType: row.targetType,
        targetIdOrUrl: row.targetIdOrUrl,
        normalizedTarget: row.normalizedTarget,
        labels: [...row.labels],
        rowNumbers: [row.rowNumber],
      });
      labelKeysByOperation.set(key, new Set(row.labels.map(comparisonKey)));
      continue;
    }

    existing.rowNumbers.push(row.rowNumber);
    const labelKeys = labelKeysByOperation.get(key)!;
    for (const label of row.labels) {
      const labelKey = comparisonKey(label);
      if (labelKeys.has(labelKey)) continue;
      labelKeys.add(labelKey);
      existing.labels.push(label);
    }
  }

  return [...operations.values()];
}

function conflictingActionIssues(rows: BulkContentLabelRow[]): BulkContentLabelIssue[] {
  const byTarget = new Map<string, {
    targetType: BulkContentLabelTargetType;
    targetIdOrUrl: string;
    labels: Map<string, { label: string; addRows: number[]; removeRows: number[] }>;
  }>();
  for (const row of rows) {
    const key = targetKey(row);
    const target = byTarget.get(key) || {
      targetType: row.targetType,
      targetIdOrUrl: row.targetIdOrUrl,
      labels: new Map(),
    };
    for (const label of row.labels) {
      const labelKey = comparisonKey(label);
      const source = target.labels.get(labelKey) || { label, addRows: [], removeRows: [] };
      const rowNumbers = row.action === 'add' ? source.addRows : source.removeRows;
      if (!rowNumbers.includes(row.rowNumber)) rowNumbers.push(row.rowNumber);
      target.labels.set(labelKey, source);
    }
    byTarget.set(key, target);
  }

  const issues: BulkContentLabelIssue[] = [];
  for (const target of byTarget.values()) {
    const conflicts = [...target.labels.values()].filter((source) => (
      source.addRows.length > 0 && source.removeRows.length > 0
    ));
    if (conflicts.length === 0) continue;

    issues.push({
      severity: 'error',
      code: 'CONFLICTING_ACTIONS',
      rowNumbers: [...new Set(conflicts.flatMap((source) => [...source.addRows, ...source.removeRows]))]
        .sort((left, right) => left - right),
      targetType: target.targetType,
      targetIdOrUrl: target.targetIdOrUrl,
      labels: conflicts.map((source) => source.label),
      message: `${target.targetType} ${target.targetIdOrUrl} cannot add and remove the same label${conflicts.length === 1 ? '' : 's'} in one plan: ${conflicts.map((source) => source.label).join(', ')}.`,
    });
  }
  return issues;
}

export function parseBulkContentLabelsCsv(content: string): BulkContentLabelPlan {
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > BULK_CONTENT_LABEL_LIMITS.maxBytes) {
    throw new Error(`CSV imports are limited to ${Math.floor(BULK_CONTENT_LABEL_LIMITS.maxBytes / (1024 * 1024))} MB.`);
  }
  const records = parseStrictCsvRecords(content);
  if (records.length === 0) throw new Error('CSV must include a header and at least one data row.');
  validateHeaders(records[0].cells);

  const dataRows = records.slice(1);
  if (dataRows.length === 0) throw new Error('CSV must include at least one data row.');
  if (dataRows.length > BULK_CONTENT_LABEL_LIMITS.maxRows) {
    throw new Error(`CSV imports are limited to ${BULK_CONTENT_LABEL_LIMITS.maxRows.toLocaleString()} data rows.`);
  }

  const rows: BulkContentLabelRow[] = [];
  const issues: BulkContentLabelIssue[] = [];
  let totalLabelIntents = 0;

  for (const { cells, lineNumber: rowNumber } of dataRows) {
    if (cells.length !== BULK_CONTENT_LABEL_HEADERS.length) {
      issues.push({
        severity: 'error',
        code: 'ROW_FIELD_COUNT_INVALID',
        rowNumber,
        message: 'Each row must contain exactly four CSV fields. Quote labels cells that contain comma-separated values.',
      });
      continue;
    }

    const [actionValue, targetTypeValue, targetValue, labelsValue] = cells;
    const action = normalizedAction(actionValue);
    const targetType = normalizedTargetType(targetTypeValue);
    const targetIdOrUrl = targetValue.trim().normalize('NFC');
    const rowIssues: BulkContentLabelIssue[] = [];

    if (!actionValue.trim()) {
      rowIssues.push({ severity: 'error', code: 'ACTION_REQUIRED', rowNumber, message: 'action is required.' });
    } else if (!action) {
      rowIssues.push({ severity: 'error', code: 'ACTION_INVALID', rowNumber, message: 'action must be add or remove.' });
    }
    if (!targetTypeValue.trim()) {
      rowIssues.push({ severity: 'error', code: 'TARGET_TYPE_REQUIRED', rowNumber, message: 'target_type is required.' });
    } else if (!targetType) {
      rowIssues.push({ severity: 'error', code: 'TARGET_TYPE_INVALID', rowNumber, message: 'target_type must be folder or document.' });
    }
    if (!targetIdOrUrl) {
      rowIssues.push({ severity: 'error', code: 'TARGET_REQUIRED', rowNumber, message: 'target_id_or_url is required.' });
    } else if (targetIdOrUrl.length > BULK_CONTENT_LABEL_LIMITS.maxTargetLength) {
      rowIssues.push({
        severity: 'error',
        code: 'TARGET_TOO_LONG',
        rowNumber,
        message: `target_id_or_url cannot exceed ${BULK_CONTENT_LABEL_LIMITS.maxTargetLength} characters.`,
      });
    } else if (hasControlCharacter(targetIdOrUrl)) {
      rowIssues.push({
        severity: 'error',
        code: 'TARGET_CONTROL_CHARACTER',
        rowNumber,
        message: 'target_id_or_url cannot contain control characters.',
      });
    }

    const parsedLabels = parseLabels(labelsValue, rowNumber);
    rowIssues.push(...parsedLabels.issues);
    issues.push(...rowIssues);
    if (rowIssues.length > 0 || !action || !targetType || !targetIdOrUrl || parsedLabels.labels.length === 0) continue;

    totalLabelIntents += parsedLabels.labels.length;
    rows.push({
      rowNumber,
      action,
      targetType,
      targetIdOrUrl,
      normalizedTarget: normalizeBulkContentLabelTarget(targetIdOrUrl),
      labels: parsedLabels.labels,
    });
  }

  if (totalLabelIntents > BULK_CONTENT_LABEL_LIMITS.maxTotalLabelIntents) {
    issues.push({
      severity: 'error',
      code: 'TOTAL_LABEL_INTENT_LIMIT',
      message: `CSV imports are limited to ${BULK_CONTENT_LABEL_LIMITS.maxTotalLabelIntents.toLocaleString()} label values across accepted rows.`,
    });
  }

  const operations = mergeOperations(rows);
  const conflicts = conflictingActionIssues(rows);
  issues.push(...conflicts);
  const uniqueTargets = new Set(operations.map(targetKey)).size;
  const labelsToAdd = operations
    .filter((operation) => operation.action === 'add')
    .reduce((total, operation) => total + operation.labels.length, 0);
  const labelsToRemove = operations
    .filter((operation) => operation.action === 'remove')
    .reduce((total, operation) => total + operation.labels.length, 0);

  return {
    rows,
    operations,
    issues,
    summary: {
      sourceRows: dataRows.length,
      acceptedRows: rows.length,
      mergedRows: rows.length - operations.length,
      uniqueTargets,
      operations: operations.length,
      labelsToAdd,
      labelsToRemove,
      conflicts: conflicts.reduce((total, issue) => total + (issue.labels?.length || 0), 0),
    },
    blocked: issues.some((issue) => issue.severity === 'error'),
  };
}
