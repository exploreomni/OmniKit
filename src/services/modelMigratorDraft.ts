import type { ModelMigratorTranslatedFile } from './opsConsole';

export interface ModelMigratorDraftState {
  schemaMapText?: string;
  selectedContentKeys?: string[];
  pathByModelId?: Record<string, 'fast' | 'translate'>;
  branchNameByModelId?: Record<string, string>;
  gitRefByModelId?: Record<string, string>;
  fastPathConfirmedByModelId?: Record<string, boolean>;
  translationsByModelId?: Record<string, {
    files: ModelMigratorTranslatedFile[];
    checksums: Record<string, string>;
    prompts: Array<{ fileName: string; prompt: string }>;
  }>;
  acceptedFilesByModelId?: Record<string, Record<string, string>>;
  skippedFilesByModelId?: Record<string, string[]>;
  replaceSameNamed?: boolean;
  runAiDialectPass?: boolean;
  publishDrafts?: boolean;
  deleteBranch?: boolean;
  refreshSchemaAfterMigration?: boolean;
  selectedPostActionIndexes?: number[];
}

const SECRET_KEY_PATTERN = /api[_-]?key|authorization|bearer|token|secret|password|passphrase/i;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+\b/gi;
const OMNI_KEY_PATTERN = /\bomni_[A-Za-z0-9_=-]{12,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_ASSIGNMENT_TEST_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const BEARER_TEST_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/i;
const OMNI_KEY_TEST_PATTERN = /\bomni_[A-Za-z0-9_=-]{12,}\b/;

function redactDraftText(value: string): string {
  return value
    .replace(BEARER_PATTERN, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]')
    .replace(OMNI_KEY_PATTERN, '[redacted]')
    .replace(EMAIL_PATTERN, '[redacted-email]');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(redactDraftText) : [];
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
      .map(([key, item]) => [redactDraftText(key), item]),
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, item]) => [redactDraftText(key), redactDraftText(item)]),
  );
}

function nestedStringRecord(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [redactDraftText(key), stringRecord(item)])
      .filter(([, item]) => Object.keys(item as Record<string, string>).length > 0),
  ) as Record<string, Record<string, string>>;
}

function pathRecord(value: unknown): Record<string, 'fast' | 'translate'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, 'fast' | 'translate'] => entry[1] === 'fast' || entry[1] === 'translate')
      .map(([key, item]) => [redactDraftText(key), item]),
  );
}

function translatedFile(value: unknown): ModelMigratorTranslatedFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<ModelMigratorTranslatedFile>;
  if (typeof row.fileName !== 'string') return null;
  const original = typeof row.original === 'string' ? redactDraftText(row.original) : '';
  const deterministic = typeof row.deterministic === 'string'
    ? redactDraftText(row.deterministic)
    : typeof row.translated === 'string'
      ? redactDraftText(row.translated)
      : original;
  const translated = typeof row.translated === 'string' ? redactDraftText(row.translated) : deterministic;
  return {
    fileName: redactDraftText(row.fileName),
    original,
    deterministic,
    translated,
    ...(typeof row.aiDraft === 'string' ? { aiDraft: redactDraftText(row.aiDraft) } : {}),
    ...(typeof row.aiJobId === 'string' ? { aiJobId: redactDraftText(row.aiJobId) } : {}),
    ...(typeof row.aiRefusal === 'string' ? { aiRefusal: redactDraftText(row.aiRefusal) } : {}),
    ...(row.blocked === true ? { blocked: true } : {}),
    changed: row.changed === true,
    promptVersion: typeof row.promptVersion === 'string' ? redactDraftText(row.promptVersion) : '',
    reviewRequired: row.reviewRequired === true,
    warnings: stringArray(row.warnings),
  };
}

function translationsRecord(value: unknown): ModelMigratorDraftState['translationsByModelId'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([modelId, item]) => {
      const row = item && typeof item === 'object' && !Array.isArray(item)
        ? item as { files?: unknown; checksums?: unknown; prompts?: unknown }
        : {};
      return [redactDraftText(modelId), {
        files: Array.isArray(row.files) ? row.files.map(translatedFile).filter((file): file is ModelMigratorTranslatedFile => Boolean(file)) : [],
        checksums: stringRecord(row.checksums),
        prompts: Array.isArray(row.prompts)
          ? row.prompts
            .filter((prompt): prompt is { fileName?: unknown; prompt?: unknown } => Boolean(prompt) && typeof prompt === 'object')
            .map((prompt) => ({
              fileName: typeof prompt.fileName === 'string' ? redactDraftText(prompt.fileName) : '',
              prompt: typeof prompt.prompt === 'string' ? redactDraftText(prompt.prompt) : '',
            }))
            .filter((prompt) => prompt.fileName)
          : [],
      }];
    }),
  );
}

export function sanitizeModelMigratorDraftForStorage(input: unknown): ModelMigratorDraftState {
  const row = input && typeof input === 'object' && !Array.isArray(input) ? input as ModelMigratorDraftState : {};
  return {
    schemaMapText: typeof row.schemaMapText === 'string' ? redactDraftText(row.schemaMapText) : '',
    selectedContentKeys: stringArray(row.selectedContentKeys),
    pathByModelId: pathRecord(row.pathByModelId),
    branchNameByModelId: stringRecord(row.branchNameByModelId),
    gitRefByModelId: stringRecord(row.gitRefByModelId),
    fastPathConfirmedByModelId: booleanRecord(row.fastPathConfirmedByModelId),
    translationsByModelId: translationsRecord(row.translationsByModelId),
    acceptedFilesByModelId: nestedStringRecord(row.acceptedFilesByModelId),
    skippedFilesByModelId: Object.fromEntries(
      Object.entries(row.skippedFilesByModelId || {}).map(([modelId, files]) => [redactDraftText(modelId), stringArray(files)]),
    ),
    replaceSameNamed: row.replaceSameNamed !== false,
    runAiDialectPass: row.runAiDialectPass === true,
    publishDrafts: row.publishDrafts === true,
    deleteBranch: row.deleteBranch !== false,
    refreshSchemaAfterMigration: row.refreshSchemaAfterMigration === true,
    selectedPostActionIndexes: Array.isArray(row.selectedPostActionIndexes)
      ? row.selectedPostActionIndexes.filter((item): item is number => typeof item === 'number')
      : [],
  };
}

export function modelMigratorDraftContainsForbiddenKeys(value: unknown): boolean {
  if (typeof value === 'string') {
    const hasPlainSecretAssignment = [...value.matchAll(SECRET_ASSIGNMENT_TEST_PATTERN)]
      .some((match) => match[3] !== '[redacted]');
    return BEARER_TEST_PATTERN.test(value) || OMNI_KEY_TEST_PATTERN.test(value) || hasPlainSecretAssignment;
  }
  if (Array.isArray(value)) return value.some(modelMigratorDraftContainsForbiddenKeys);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    SECRET_KEY_PATTERN.test(key) || modelMigratorDraftContainsForbiddenKeys(item)
  ));
}
