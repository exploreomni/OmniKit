import type { PostMigrationAction } from './nativeVault';
import type { MigrationJob, MigrationJobItem, MigrationTarget } from './migrationJobs';

const REDACTED = '[redacted]';
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+\b/gi;
const OMNI_TOKEN_PATTERN = /\bomni_[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|authorization|token|secret|password|passphrase)$/i;
const PHONE_PATTERN = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const PAN_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(TOKEN_PATTERN, `$1${REDACTED}`)
    .replace(OMNI_TOKEN_PATTERN, REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED}`)
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(PAN_CANDIDATE_PATTERN, (candidate) => (isLuhnValid(candidate) ? '[redacted-pan]' : candidate));
}

export function sanitizePostMigrationAction(action: PostMigrationAction): PostMigrationAction {
  return {
    kind: action.kind,
    name: redactSensitiveText(action.name),
    method: action.method,
    url: redactSensitiveText(action.url),
    headers: Object.fromEntries(
      Object.keys(action.headers || {}).map((key) => [redactSensitiveText(key), REDACTED]),
    ),
    body: action.body ? REDACTED : '',
    destinationInstanceId: action.destinationInstanceId,
    targetModelId: action.targetModelId,
    targetModelName: action.targetModelName ? redactSensitiveText(action.targetModelName) : action.targetModelName,
  };
}

export function sanitizeJobItem(item: MigrationJobItem): MigrationJobItem {
  return {
    ...item,
    destinationLabel: redactSensitiveText(item.destinationLabel),
    targetModelName: item.targetModelName ? redactSensitiveText(item.targetModelName) : item.targetModelName,
    targetFolderPath: item.targetFolderPath ? redactSensitiveText(item.targetFolderPath) : item.targetFolderPath,
    documentName: item.documentName ? redactSensitiveText(item.documentName) : item.documentName,
    error: item.error ? redactSensitiveText(item.error) : item.error,
    warnings: item.warnings?.map(redactSensitiveText),
    importedIdentifier: item.importedIdentifier ? redactSensitiveText(item.importedIdentifier) : item.importedIdentifier,
    importedDocumentId: item.importedDocumentId ? redactSensitiveText(item.importedDocumentId) : item.importedDocumentId,
    details: sanitizeDetails(item.details),
  };
}

export function sanitizeMigrationTarget(target: MigrationTarget): MigrationTarget {
  return {
    ...target,
    destinationLabel: target.destinationLabel ? redactSensitiveText(target.destinationLabel) : target.destinationLabel,
    targetModelName: target.targetModelName ? redactSensitiveText(target.targetModelName) : target.targetModelName,
    targetFolderPath: target.targetFolderPath ? redactSensitiveText(target.targetFolderPath) : target.targetFolderPath,
  };
}

export function sanitizeJob(job: MigrationJob): MigrationJob {
  return {
    ...job,
    sourceLabel: redactSensitiveText(job.sourceLabel),
    sourceFolderPath: job.sourceFolderPath ? redactSensitiveText(job.sourceFolderPath) : job.sourceFolderPath,
    targets: job.targets?.map(sanitizeMigrationTarget),
    postMigrationActions: job.postMigrationActions.map(sanitizePostMigrationAction),
    details: sanitizeDetails(job.details),
    items: job.items.map(sanitizeJobItem),
  };
}

export function sanitizeJobHistory(jobs: MigrationJob[]): MigrationJob[] {
  return jobs.map(sanitizeJob);
}

function sanitizeDetails(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return value;
  return sanitizeUnknown(value) as Record<string, unknown>;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redactSensitiveText(key),
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeUnknown(item),
    ]),
  );
}
