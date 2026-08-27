import {
  INSTANCE_CONNECTION_DIAGNOSTICS,
  INSTANCE_CONNECTION_ERROR_CODES,
  isInstanceConnectionErrorCode,
  normalizeConnectionDiagnosticCode,
} from '../../shared/instanceConnectionErrors';

export interface InstanceConnectionDiagnostic {
  message: string;
  code?: string;
  guidance?: string;
}

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function messageFromError(error: unknown, fallback: string): string {
  const message = recordValue(error, 'message');
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

export function instanceConnectionDiagnosticFromError(
  error: unknown,
  fallback = 'Could not connect to this saved instance.',
): InstanceConnectionDiagnostic {
  const suppliedCode = normalizeConnectionDiagnosticCode(recordValue(error, 'code'));
  const code = suppliedCode
    || (error instanceof TypeError
      ? INSTANCE_CONNECTION_ERROR_CODES.localServerUnreachable
      : INSTANCE_CONNECTION_ERROR_CODES.clientConnectionFailed);
  const copy = isInstanceConnectionErrorCode(code)
    ? INSTANCE_CONNECTION_DIAGNOSTICS[code]
    : undefined;
  return {
    message: messageFromError(error, copy?.message || fallback),
    code,
    guidance: copy?.guidance,
  };
}

export function instanceConnectionDiagnosticFromState(
  message: string,
  code?: string,
): InstanceConnectionDiagnostic {
  const normalizedCode = normalizeConnectionDiagnosticCode(code);
  const copy = isInstanceConnectionErrorCode(normalizedCode)
    ? INSTANCE_CONNECTION_DIAGNOSTICS[normalizedCode]
    : undefined;
  return {
    message: message.trim() || copy?.message || 'Could not connect to this saved instance.',
    ...(normalizedCode ? { code: normalizedCode } : {}),
    ...(copy?.guidance ? { guidance: copy.guidance } : {}),
  };
}
