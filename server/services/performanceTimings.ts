export interface PerformanceTimingEntry {
  name: string;
  durationMs: number;
  detail?: Record<string, unknown>;
}

export interface ApiPerformanceTimings {
  totalMs: number;
  timings: PerformanceTimingEntry[];
}

function nowMs() {
  return Date.now();
}

export function createPerformanceTracker(): {
  time<T>(name: string, work: () => Promise<T>, detail?: Record<string, unknown> | ((result: T | undefined) => Record<string, unknown>)): Promise<T>;
  mark(name: string, durationMs: number, detail?: Record<string, unknown>): void;
  snapshot(): ApiPerformanceTimings;
} {
  const startedAt = nowMs();
  const timings: PerformanceTimingEntry[] = [];

  return {
    async time<T>(name: string, work: () => Promise<T>, detail?: Record<string, unknown> | ((result: T | undefined) => Record<string, unknown>)): Promise<T> {
      const stepStartedAt = nowMs();
      let result: T | undefined;
      try {
        result = await work();
        return result;
      } finally {
        const nextDetail = typeof detail === 'function' ? detail(result) : detail;
        timings.push({
          name,
          durationMs: nowMs() - stepStartedAt,
          ...(nextDetail ? { detail: nextDetail } : {}),
        });
      }
    },
    mark(name: string, durationMs: number, detail?: Record<string, unknown>) {
      timings.push({
        name,
        durationMs,
        ...(detail ? { detail } : {}),
      });
    },
    snapshot(): ApiPerformanceTimings {
      return {
        totalMs: nowMs() - startedAt,
        timings,
      };
    },
  };
}
