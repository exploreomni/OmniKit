import type { OperationLogEntry } from '@/types';
import type { MigrationJob } from '@/services/opsConsole';

const REDACTED = '[redacted]';
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+\b/gi;
const OMNI_TOKEN_PATTERN = /\bomni_[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|authorization|token|secret|password|passphrase|headers?|body|cookie|set-cookie|x-api-key)$/i;
const PHONE_PATTERN = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const PAN_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

export interface HistoryExportPayload {
  operations: OperationLogEntry[];
  migrationJobs: MigrationJob[];
}

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

export function redactHistoryExportText(value: string): string {
  return value
    .replace(TOKEN_PATTERN, `$1${REDACTED}`)
    .replace(OMNI_TOKEN_PATTERN, REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED}`)
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(PAN_CANDIDATE_PATTERN, (candidate) => (isLuhnValid(candidate) ? '[redacted-pan]' : candidate));
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactHistoryExportText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redactHistoryExportText(key),
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeUnknown(item),
    ]),
  );
}

export function sanitizeHistoryExportPayload(payload: HistoryExportPayload): HistoryExportPayload {
  return sanitizeUnknown(payload) as HistoryExportPayload;
}
