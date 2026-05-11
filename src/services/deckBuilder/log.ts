type LogLevel = 'info' | 'warn' | 'error' | 'step';

declare global {
  interface Window {
    __deckBuilderDebug?: boolean;
  }
}

interface DiagnosticEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const buffer: DiagnosticEntry[] = [];
const MAX_BUFFER = 500;

function isVerbose(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__deckBuilderDebug);
}

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) return `[dataUrl ${value.length} chars]`;
    if (value.length > 600) return `${value.slice(0, 600)}…[+${value.length - 600}]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/api[_-]?key|authorization|secret/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return value;
}

function record(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: DiagnosticEntry = {
    ts: Date.now(),
    level,
    scope,
    message,
    data: data === undefined ? undefined : sanitize(data),
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const prefix = `[DeckBuilder:${scope}]`;
  const args: unknown[] = [prefix, message];
  if (data !== undefined) args.push(sanitize(data));

  if (level === 'error') {
    console.error(...args);
  } else if (level === 'warn') {
    console.warn(...args);
  } else if (level === 'step') {
    console.info(...args);
  } else if (isVerbose()) {
    console.log(...args);
  }
}

export const deckLog = {
  step(scope: string, message: string, data?: unknown) {
    record('step', scope, message, data);
  },
  info(scope: string, message: string, data?: unknown) {
    record('info', scope, message, data);
  },
  warn(scope: string, message: string, data?: unknown) {
    record('warn', scope, message, data);
  },
  error(scope: string, message: string, data?: unknown) {
    record('error', scope, message, data);
  },
  enableVerbose() {
    if (typeof window !== 'undefined') {
      window.__deckBuilderDebug = true;
      console.info('[DeckBuilder] verbose logging enabled');
    }
  },
  snapshot(): DiagnosticEntry[] {
    return buffer.slice();
  },
  clear() {
    buffer.length = 0;
  },
};

export function describeError(err: unknown): { message: string; status?: number; detail?: string } {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; status?: number; detail?: string };
    if (e.name === 'ApiError') {
      return { message: e.message || 'API error', status: e.status, detail: e.detail };
    }
    if (e.message) return { message: e.message, status: e.status, detail: e.detail };
  }
  return { message: typeof err === 'string' ? err : 'Unknown error' };
}
