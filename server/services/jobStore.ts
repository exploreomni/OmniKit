import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type {
  MigrationJob,
  MigrationJobItem,
} from './migrationJobs';
import { sanitizeJob, sanitizeJobHistory, sanitizeJobItem } from './jobSanitizer';

const DEFAULT_JOB_HISTORY_PATH = './data/omnikit-jobs.json';
const DEFAULT_LEGACY_JOBS_PATH = './data/jobs.json';

let jobsCache: MigrationJob[] | null = null;
let jobsPath = '';

export function getJobsDbPath(): string {
  return process.env.OMNIKIT_JOB_HISTORY_PATH
    || process.env.OMNIKIT_DB_PATH
    || DEFAULT_JOB_HISTORY_PATH;
}

export function getLegacyJobsPath(): string {
  return process.env.OMNIKIT_JOBS_PATH || DEFAULT_LEGACY_JOBS_PATH;
}

function secureHistoryFile(pathname = getJobsDbPath()): void {
  if (existsSync(pathname)) chmodSync(pathname, 0o600);
}

function isJob(value: unknown): value is MigrationJob {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as MigrationJob).id === 'string'
    && Array.isArray((value as MigrationJob).items);
}

function parseJobs(value: unknown): MigrationJob[] {
  if (Array.isArray(value)) return sanitizeJobHistory(value.filter(isJob));
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    return sanitizeJobHistory((value as { jobs: unknown[] }).jobs.filter(isJob));
  }
  return [];
}

function readJobsFile(pathname: string): MigrationJob[] {
  if (!existsSync(pathname)) return [];
  try {
    return parseJobs(JSON.parse(readFileSync(pathname, 'utf8')) as unknown);
  } catch {
    // A corrupt or non-JSON history file should not stop OmniKit from starting.
    return [];
  }
}

function writeJobsFile(pathname: string, jobs: MigrationJob[]): void {
  mkdirSync(dirname(pathname), { recursive: true });
  const sanitized = sanitizeJobHistory(jobs);
  const tempPath = `${pathname}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, pathname);
    chmodSync(pathname, 0o600);
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only; preserve the original write error.
      }
    }
    throw error;
  }
}

function importLegacyJobsIfNeeded(pathname: string, jobs: MigrationJob[]): MigrationJob[] {
  const legacyPath = getLegacyJobsPath();
  if (jobs.length > 0 || legacyPath === pathname || !existsSync(legacyPath)) return jobs;
  try {
    const imported = parseJobs(JSON.parse(readFileSync(legacyPath, 'utf8')) as unknown);
    if (imported.length === 0) return jobs;
    renameSync(legacyPath, `${legacyPath}.bak`);
    return imported;
  } catch {
    // A corrupt legacy job file should not stop OmniKit from starting.
    return jobs;
  }
}

function recoverInterruptedJobs(jobs: MigrationJob[]): boolean {
  const now = Date.now();
  let changed = false;
  for (const job of jobs) {
    if (job.status !== 'running' && job.status !== 'pending') continue;
    for (const item of job.items) {
      if (item.status !== 'running' && item.status !== 'pending') continue;
      item.status = 'failed';
      item.error = item.error || 'Interrupted by server restart.';
      item.endedAt = item.endedAt || now;
      changed = true;
    }
    job.status = 'failed';
    job.endedAt = job.endedAt || now;
    changed = true;
  }
  return changed;
}

function loadJobs(): MigrationJob[] {
  const nextPath = getJobsDbPath();
  if (jobsCache && jobsPath === nextPath) return jobsCache;

  mkdirSync(dirname(nextPath), { recursive: true });
  jobsPath = nextPath;
  let jobs = readJobsFile(nextPath);
  const hadHistoryFile = existsSync(nextPath);
  const beforeImportCount = jobs.length;
  jobs = importLegacyJobsIfNeeded(nextPath, jobs);
  const importedLegacy = jobs.length !== beforeImportCount;
  const recovered = recoverInterruptedJobs(jobs);
  jobsCache = sanitizeJobHistory(jobs);

  if (!hadHistoryFile || importedLegacy || recovered) writeJobsFile(nextPath, jobsCache);
  else secureHistoryFile(nextPath);

  return jobsCache;
}

function persistJobs(jobs: MigrationJob[]): void {
  jobsCache = sanitizeJobHistory(jobs);
  writeJobsFile(getJobsDbPath(), jobsCache);
}

function upsertJob(jobs: MigrationJob[], job: MigrationJob): MigrationJob[] {
  const sanitized = sanitizeJob(job);
  const index = jobs.findIndex((row) => row.id === sanitized.id);
  if (index === -1) return [...jobs, sanitized];
  const next = [...jobs];
  next[index] = sanitized;
  return next;
}

export function insertJob(job: MigrationJob): void {
  persistJobs(upsertJob(loadJobs(), job));
}

export function updateJobStatus(job: MigrationJob): void {
  const jobs = loadJobs();
  const existing = jobs.find((row) => row.id === job.id);
  persistJobs(upsertJob(jobs, {
    ...(existing || {}),
    ...job,
    items: job.items || existing?.items || [],
  } as MigrationJob));
}

export function updateJobItem(item: MigrationJobItem): void {
  const jobs = loadJobs();
  const job = jobs.find((row) => row.id === item.jobId);
  if (!job) return;
  const sanitized = sanitizeJobItem(item);
  const index = job.items.findIndex((row) => row.id === sanitized.id);
  const nextItems = [...job.items];
  if (index === -1) nextItems.push(sanitized);
  else nextItems[index] = { ...nextItems[index], ...sanitized };
  persistJobs(upsertJob(jobs, { ...job, items: nextItems }));
}

export function getJob(id: string): MigrationJob | undefined {
  return loadJobs().find((job) => job.id === id);
}

export function listJobs(limit = 100, offset = 0): MigrationJob[] {
  return [...loadJobs()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(offset, offset + limit);
}

export function clearJobs(): void {
  persistJobs([]);
}

export function closeJobStoreForTests(): void {
  jobsCache = null;
  jobsPath = '';
}
