import type { JobItemStatus, JobStatus, MigrationJob, MigrationJobItem } from './migrationJobs';
import { redactSensitiveText, sanitizeJob, sanitizeJobItem } from './jobSanitizer';

export type MigrationJobEvent =
  | { type: 'job'; jobId: string; status: JobStatus; at: number; job?: MigrationJob }
  | { type: 'item'; jobId: string; itemId: string; destinationId: string; status: JobItemStatus; error?: string; at: number; item?: MigrationJobItem }
  | { type: 'post-migration'; jobId: string; results: unknown; at: number };

type Listener = (event: MigrationJobEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeMigrationJobEvents(jobId: string, listener: Listener): () => void {
  const next = listeners.get(jobId) ?? new Set<Listener>();
  next.add(listener);
  listeners.set(jobId, next);
  return () => {
    const current = listeners.get(jobId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(jobId);
  };
}

export function publishMigrationJobEvent(event: MigrationJobEvent): void {
  const sanitized = sanitizeEvent(event);
  const current = listeners.get(event.jobId);
  if (!current) return;
  for (const listener of current) listener(sanitized);
}

function sanitizeEvent(event: MigrationJobEvent): MigrationJobEvent {
  if (event.type === 'job') {
    return { ...event, job: event.job ? sanitizeJob(event.job) : undefined };
  }
  if (event.type === 'item') {
    return {
      ...event,
      error: event.item?.error || event.error
        ? redactSensitiveText(event.item?.error || event.error || '')
        : undefined,
      item: event.item ? sanitizeJobItem(event.item) : undefined,
    };
  }
  return event;
}
