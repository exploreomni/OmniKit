import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import type {
  JobItemKind,
  JobItemStatus,
  JobStatus,
  MigrationJob,
  MigrationJobItem,
  MigrationTarget,
} from './migrationJobs';
import { sanitizeJob, sanitizeJobHistory, sanitizeJobItem } from './jobSanitizer';
import type { PostMigrationAction } from './nativeVault';

const DEFAULT_DB_PATH = './data/omnikit.db';
const DEFAULT_LEGACY_JOBS_PATH = './data/jobs.json';

type SqlParams = Record<string, SQLInputValue>;

let db: DatabaseSync | null = null;
let dbPath = '';

interface JobRow {
  id: string;
  workflow: string | null;
  source_id: string;
  source_label: string;
  destination_ids: string;
  targets: string;
  document_ids: string;
  empty_first: number;
  replace_same_named: number;
  source_folder_id: string | null;
  source_folder_path: string | null;
  post_migration_actions: string;
  status: string;
  parent_job_id: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  details: string | null;
}

interface JobItemRow {
  id: string;
  job_id: string;
  target_id: string | null;
  destination_id: string;
  destination_label: string;
  target_model_id: string | null;
  target_model_name: string | null;
  target_folder_id: string | null;
  target_folder_path: string | null;
  kind: string;
  document_id: string | null;
  document_name: string | null;
  replacement: number;
  status: string;
  error: string | null;
  warnings: string;
  export_hash: string | null;
  imported_identifier: string | null;
  imported_document_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  details: string | null;
}

export function getJobsDbPath(): string {
  return process.env.OMNIKIT_DB_PATH || DEFAULT_DB_PATH;
}

export function getLegacyJobsPath(): string {
  return process.env.OMNIKIT_JOBS_PATH || DEFAULT_LEGACY_JOBS_PATH;
}

function getDb(): DatabaseSync {
  const nextPath = getJobsDbPath();
  if (db && dbPath === nextPath) return db;
  if (db) db.close();

  mkdirSync(dirname(nextPath), { recursive: true });
  const fileExisted = existsSync(nextPath);
  db = new DatabaseSync(nextPath);
  dbPath = nextPath;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  secureDbFiles(nextPath);
  if (!fileExisted || statSync(nextPath).size === 0) secureDbFiles(nextPath);
  importLegacyJobsIfNeeded(db);
  recoverInterruptedJobs(db);
  secureDbFiles(nextPath);
  return db;
}

function secureDbFiles(pathname = getJobsDbPath()): void {
  for (const filePath of [pathname, `${pathname}-wal`, `${pathname}-shm`]) {
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
  }
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      workflow TEXT,
      source_id TEXT NOT NULL,
      source_label TEXT NOT NULL,
      destination_ids TEXT NOT NULL,
      targets TEXT NOT NULL,
      document_ids TEXT NOT NULL,
      empty_first INTEGER NOT NULL,
      replace_same_named INTEGER NOT NULL DEFAULT 1,
      source_folder_id TEXT,
      source_folder_path TEXT,
      post_migration_actions TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_job_id TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      details TEXT
    );
    CREATE TABLE IF NOT EXISTS job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      target_id TEXT,
      destination_id TEXT NOT NULL,
      destination_label TEXT NOT NULL,
      target_model_id TEXT,
      target_model_name TEXT,
      target_folder_id TEXT,
      target_folder_path TEXT,
      kind TEXT NOT NULL,
      document_id TEXT,
      document_name TEXT,
      replacement INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      warnings TEXT NOT NULL DEFAULT '[]',
      export_hash TEXT,
      imported_identifier TEXT,
      imported_document_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS job_items_job ON job_items(job_id);
    CREATE INDEX IF NOT EXISTS job_items_job_status ON job_items(job_id, status);
  `);
  ensureColumn(database, 'jobs', 'replace_same_named', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'jobs', 'source_folder_id', 'TEXT');
  ensureColumn(database, 'jobs', 'source_folder_path', 'TEXT');
  ensureColumn(database, 'jobs', 'workflow', 'TEXT');
  ensureColumn(database, 'jobs', 'details', 'TEXT');
  ensureColumn(database, 'job_items', 'replacement', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'job_items', 'details', 'TEXT');
}

function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, definition: string): void {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === columnName)) return;
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function runTransaction(database: DatabaseSync, callback: () => void): void {
  database.exec('BEGIN');
  try {
    callback();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function importLegacyJobsIfNeeded(database: DatabaseSync): void {
  const count = database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
  const legacyPath = getLegacyJobsPath();
  if (count.count > 0 || !existsSync(legacyPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return;
    const jobs = sanitizeJobHistory(parsed.filter(isJob));
    runTransaction(database, () => {
      const rows = jobs;
      for (const job of rows) insertJobRows(database, job);
    });
    renameSync(legacyPath, `${legacyPath}.bak`);
  } catch {
    // A corrupt legacy job file should not stop OmniKit from starting.
  }
}

function recoverInterruptedJobs(database: DatabaseSync): void {
  const now = Date.now();
  database.prepare(`
    UPDATE job_items
    SET status = 'failed', error = COALESCE(error, 'Interrupted by server restart.'), ended_at = COALESCE(ended_at, ?)
    WHERE status IN ('running', 'pending')
      AND job_id IN (SELECT id FROM jobs WHERE status IN ('running', 'pending'))
  `).run(now);
  database.prepare(`
    UPDATE jobs
    SET status = 'failed', ended_at = COALESCE(ended_at, ?)
    WHERE status IN ('running', 'pending')
  `).run(now);
}

function isJob(value: unknown): value is MigrationJob {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as MigrationJob).id === 'string'
    && Array.isArray((value as MigrationJob).items);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToJob(row: JobRow, items: JobItemRow[]): MigrationJob {
  return {
    id: row.id,
    workflow: row.workflow === 'model' ? 'model' : 'dashboard',
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    destinationIds: parseJson<string[]>(row.destination_ids, []),
    targets: parseJson<MigrationTarget[]>(row.targets, []),
    documentIds: parseJson<string[]>(row.document_ids, []),
    emptyFirst: row.empty_first === 1,
    replaceSameNamed: row.replace_same_named !== 0,
    sourceFolderId: row.source_folder_id || undefined,
    sourceFolderPath: row.source_folder_path || undefined,
    postMigrationActions: parseJson<PostMigrationAction[]>(row.post_migration_actions, []),
    status: row.status as JobStatus,
    parentJobId: row.parent_job_id || undefined,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    endedAt: row.ended_at || undefined,
    details: parseJson<Record<string, unknown>>(row.details || '', {}),
    items: items.map(rowToItem),
  };
}

function rowToItem(row: JobItemRow): MigrationJobItem {
  return {
    id: row.id,
    jobId: row.job_id,
    targetId: row.target_id || undefined,
    destinationId: row.destination_id,
    destinationLabel: row.destination_label,
    targetModelId: row.target_model_id || undefined,
    targetModelName: row.target_model_name || undefined,
    targetFolderId: row.target_folder_id || undefined,
    targetFolderPath: row.target_folder_path || undefined,
    kind: row.kind as JobItemKind,
    documentId: row.document_id || undefined,
    documentName: row.document_name || undefined,
    replacement: row.replacement === 1 || undefined,
    status: row.status as JobItemStatus,
    error: row.error || undefined,
    warnings: parseJson<string[]>(row.warnings, []),
    startedAt: row.started_at || undefined,
    endedAt: row.ended_at || undefined,
    exportHash: row.export_hash || undefined,
    importedIdentifier: row.imported_identifier || undefined,
    importedDocumentId: row.imported_document_id || undefined,
    details: parseJson<Record<string, unknown>>(row.details || '', {}),
  };
}

function insertJobRows(database: DatabaseSync, job: MigrationJob): void {
  upsertJobRow(database, job);
  const insertItem = database.prepare(`
    INSERT INTO job_items (
      id, job_id, target_id, destination_id, destination_label, target_model_id, target_model_name,
      target_folder_id, target_folder_path, kind, document_id, document_name, status, error,
      replacement, warnings, export_hash, imported_identifier, imported_document_id, started_at, ended_at, details
    ) VALUES (
      @id, @job_id, @target_id, @destination_id, @destination_label, @target_model_id, @target_model_name,
      @target_folder_id, @target_folder_path, @kind, @document_id, @document_name, @status, @error,
      @replacement, @warnings, @export_hash, @imported_identifier, @imported_document_id, @started_at, @ended_at, @details
    )
    ON CONFLICT(id) DO UPDATE SET
      target_id = excluded.target_id,
      destination_id = excluded.destination_id,
      destination_label = excluded.destination_label,
      target_model_id = excluded.target_model_id,
      target_model_name = excluded.target_model_name,
      target_folder_id = excluded.target_folder_id,
      target_folder_path = excluded.target_folder_path,
      kind = excluded.kind,
      document_id = excluded.document_id,
      document_name = excluded.document_name,
      replacement = excluded.replacement,
      status = excluded.status,
      error = excluded.error,
      warnings = excluded.warnings,
      export_hash = excluded.export_hash,
      imported_identifier = excluded.imported_identifier,
      imported_document_id = excluded.imported_document_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      details = excluded.details
  `);
  for (const item of job.items) insertItem.run(itemParams(item));
}

function upsertJobRow(database: DatabaseSync, job: MigrationJob): void {
  const sanitized = sanitizeJob(job);
  const params: SqlParams = {
    id: sanitized.id,
    workflow: sanitized.workflow || 'dashboard',
    source_id: sanitized.sourceId,
    source_label: sanitized.sourceLabel,
    destination_ids: JSON.stringify(sanitized.destinationIds),
    targets: JSON.stringify(sanitized.targets || []),
    document_ids: JSON.stringify(sanitized.documentIds),
    empty_first: sanitized.emptyFirst ? 1 : 0,
    replace_same_named: sanitized.replaceSameNamed === false ? 0 : 1,
    source_folder_id: sanitized.sourceFolderId || null,
    source_folder_path: sanitized.sourceFolderPath || null,
    post_migration_actions: JSON.stringify(sanitized.postMigrationActions),
    status: sanitized.status,
    parent_job_id: sanitized.parentJobId || null,
    created_at: sanitized.createdAt,
    started_at: sanitized.startedAt || null,
    ended_at: sanitized.endedAt || null,
    details: JSON.stringify(sanitized.details || {}),
  };
  database.prepare(`
    INSERT INTO jobs (
      id, workflow, source_id, source_label, destination_ids, targets, document_ids, empty_first,
      replace_same_named, source_folder_id, source_folder_path,
      post_migration_actions, status, parent_job_id, created_at, started_at, ended_at, details
    ) VALUES (
      @id, @workflow, @source_id, @source_label, @destination_ids, @targets, @document_ids, @empty_first,
      @replace_same_named, @source_folder_id, @source_folder_path,
      @post_migration_actions, @status, @parent_job_id, @created_at, @started_at, @ended_at, @details
    )
    ON CONFLICT(id) DO UPDATE SET
      workflow = excluded.workflow,
      source_id = excluded.source_id,
      source_label = excluded.source_label,
      destination_ids = excluded.destination_ids,
      targets = excluded.targets,
      document_ids = excluded.document_ids,
      empty_first = excluded.empty_first,
      replace_same_named = excluded.replace_same_named,
      source_folder_id = excluded.source_folder_id,
      source_folder_path = excluded.source_folder_path,
      post_migration_actions = excluded.post_migration_actions,
      status = excluded.status,
      parent_job_id = excluded.parent_job_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      details = excluded.details
  `).run(params);
}

function itemParams(item: MigrationJobItem): SqlParams {
  const sanitized = sanitizeJobItem(item);
  return {
    id: sanitized.id,
    job_id: sanitized.jobId,
    target_id: sanitized.targetId || null,
    destination_id: sanitized.destinationId,
    destination_label: sanitized.destinationLabel,
    target_model_id: sanitized.targetModelId || null,
    target_model_name: sanitized.targetModelName || null,
    target_folder_id: sanitized.targetFolderId || null,
    target_folder_path: sanitized.targetFolderPath || null,
    kind: sanitized.kind,
    document_id: sanitized.documentId || null,
    document_name: sanitized.documentName || null,
    replacement: sanitized.replacement ? 1 : 0,
    status: sanitized.status,
    error: sanitized.error || null,
    warnings: JSON.stringify(sanitized.warnings || []),
    export_hash: sanitized.exportHash || null,
    imported_identifier: sanitized.importedIdentifier || null,
    imported_document_id: sanitized.importedDocumentId || null,
    started_at: sanitized.startedAt || null,
    ended_at: sanitized.endedAt || null,
    details: JSON.stringify(sanitized.details || {}),
  };
}

export function insertJob(job: MigrationJob): void {
  const database = getDb();
  runTransaction(database, () => insertJobRows(database, sanitizeJob(job)));
  secureDbFiles();
}

export function updateJobStatus(job: MigrationJob): void {
  upsertJobRow(getDb(), job);
  secureDbFiles();
}

export function updateJobItem(item: MigrationJobItem): void {
  getDb().prepare(`
    INSERT INTO job_items (
      id, job_id, target_id, destination_id, destination_label, target_model_id, target_model_name,
      target_folder_id, target_folder_path, kind, document_id, document_name, status, error,
      replacement, warnings, export_hash, imported_identifier, imported_document_id, started_at, ended_at, details
    ) VALUES (
      @id, @job_id, @target_id, @destination_id, @destination_label, @target_model_id, @target_model_name,
      @target_folder_id, @target_folder_path, @kind, @document_id, @document_name, @status, @error,
      @replacement, @warnings, @export_hash, @imported_identifier, @imported_document_id, @started_at, @ended_at, @details
    )
    ON CONFLICT(id) DO UPDATE SET
      replacement = excluded.replacement,
      status = excluded.status,
      error = excluded.error,
      warnings = excluded.warnings,
      export_hash = excluded.export_hash,
      imported_identifier = excluded.imported_identifier,
      imported_document_id = excluded.imported_document_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      details = excluded.details
  `).run(itemParams(item));
  secureDbFiles();
}

export function getJob(id: string): MigrationJob | undefined {
  const database = getDb();
  const row = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
  if (!row) return undefined;
  const items = database.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY rowid ASC').all(id) as unknown as JobItemRow[];
  return rowToJob(row, items);
}

export function listJobs(limit = 100, offset = 0): MigrationJob[] {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as JobRow[];
  const itemStmt = database.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY rowid ASC');
  return rows.map((row) => rowToJob(row, itemStmt.all(row.id) as unknown as JobItemRow[]));
}

export function clearJobs(): void {
  getDb().exec('DELETE FROM jobs');
  secureDbFiles();
}

export function closeJobStoreForTests(): void {
  if (!db) return;
  db.close();
  db = null;
  dbPath = '';
}
