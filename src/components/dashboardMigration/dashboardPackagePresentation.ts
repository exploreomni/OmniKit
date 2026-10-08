import type { DashboardPackagePreview, DashboardPackageSummary, DashboardPackageTargetResult } from '@/services/dashboardDeploymentPlans';
import type { MigrationJob } from '@/services/opsConsole';
import { isDashboardPackageBindingMapping } from '../../../shared/dashboardPackageBindings';

export const FILE_ACTIONS = { create: 'Create missing file', add: 'Add missing definitions', reuse: 'Reuse destination definitions', conflict: 'Decision needed' } as const;

export function groupDashboardPackageIssues(summary: DashboardPackageSummary) {
  const groups = new Map<string, { message: string; files: string[]; issues: DashboardPackageSummary['issues'] }>();
  const files = [...summary.files].sort((a, b) => b.fileName.length - a.fileName.length);
  for (const issue of summary.issues) {
    // The aggregate file conflict repeats the same per-tile evidence. Keep every
    // observation in details while presenting one actionable cause to the user.
    const code = ['DEPENDENCY_CONFLICT', 'DESTINATION_DEFINITION_CONFLICT'].includes(issue.code) ? 'DEFINITION_CONFLICT' : issue.code;
    const key = JSON.stringify([code, issue.message]);
    const group = groups.get(key) || { message: issue.message, files: [], issues: [] };
    const file = files.find(file => issue.reference === file.fileName || issue.reference.endsWith('/' + file.fileName));
    if (file && !group.files.includes(file.fileName)) group.files.push(file.fileName);
    group.issues.push(issue);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function dashboardPackagePreviewMatches(summary: DashboardPackageSummary, preview: DashboardPackagePreview): boolean {
  if (!preview || preview.fingerprint !== summary.fingerprint || !Array.isArray(preview.files) || !Array.isArray(preview.documents) || !Array.isArray(preview.issues)) return false;
  if ((preview.bindingMappings !== undefined && (!Array.isArray(preview.bindingMappings) || preview.bindingMappings.some(mapping => !isDashboardPackageBindingMapping(mapping))))
    || JSON.stringify(preview.bindingMappings || []) !== JSON.stringify(summary.bindingMappings || [])) return false;
  if (preview.files.some((row) => !row || typeof row.fileName !== 'string' || typeof row.sourceFileName !== 'string' || !Object.prototype.hasOwnProperty.call(FILE_ACTIONS, row.action))
    || preview.documents.some((row) => !row || typeof row.sourceDocumentId !== 'string' || typeof row.name !== 'string' || !Number.isSafeInteger(row.localModelCount) || row.localModelCount < 0)) return false;
  const files = (rows: DashboardPackageSummary['files']) => rows.map((row) => JSON.stringify([row.fileName, row.sourceFileName, row.action, row.reason || ''])).sort();
  const documents = (rows: DashboardPackageSummary['documents']) => rows.map((row) => JSON.stringify([row.sourceDocumentId, row.name, row.localModelCount])).sort();
  return preview.files.every((row) => row && typeof row.before === 'string' && typeof row.after === 'string'
      && (row.sourceComparison === undefined || typeof row.sourceComparison === 'string'))
    && JSON.stringify(files(preview.files)) === JSON.stringify(files(summary.files))
    && JSON.stringify(documents(preview.documents)) === JSON.stringify(documents(summary.documents))
    && JSON.stringify(preview.issues) === JSON.stringify(summary.issues);
}

export function dashboardPackageReviewComplete(summary: DashboardPackageSummary | undefined, fingerprint?: string): boolean {
  return !summary || (summary.fingerprint === fingerprint && summary.issues.length === 0 && !summary.files.some((file) => file.action === 'conflict'));
}

export function readDashboardPackageResults(job: MigrationJob): DashboardPackageTargetResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(job.details || {}, 'dashboardPackageResults')) return null;
  const rows = job.details?.dashboardPackageResults;
  if (!Array.isArray(rows)) return [];
  const statuses = new Set(['verified', 'needs_review', 'uncertain', 'failed', 'waiting_approval']);
  if (rows.some((row) => !row || typeof row !== 'object' || typeof row.targetId !== 'string' || !statuses.has(row.status)
    || !(job.targets || []).some((target) => target.id === row.targetId)
    || typeof row.stage !== 'string' || (row.message !== undefined && typeof row.message !== 'string') || !Array.isArray(row.documents)
    || (row.branchName !== undefined && typeof row.branchName !== 'string')
    || row.documents.some((document: DashboardPackageTargetResult['documents'][number]) => !document || typeof document.sourceDocumentId !== 'string' || typeof document.name !== 'string' || !statuses.has(document.status)
      || !job.documentIds.includes(document.sourceDocumentId) || (document.message !== undefined && typeof document.message !== 'string')
      || (document.created !== undefined && typeof document.created !== 'boolean')
      || (document.canVerifyExistingCopy !== undefined && typeof document.canVerifyExistingCopy !== 'boolean')
      || (document.documentId !== undefined && typeof document.documentId !== 'string')
      || (document.identifier !== undefined && typeof document.identifier !== 'string')
      || (document.url !== undefined && typeof document.url !== 'string'))
    || new Set(row.documents.map((document: DashboardPackageTargetResult['documents'][number]) => document.sourceDocumentId)).size !== row.documents.length
    || (row.status === 'verified' && (row.documents.length !== job.documentIds.length || row.documents.some((document: DashboardPackageTargetResult['documents'][number]) => document.status !== 'verified'))))) return [];
  if (new Set(rows.map((row) => row.targetId)).size !== rows.length) return [];
  return rows as DashboardPackageTargetResult[];
}

export function dashboardPackageCopyCreated(document: DashboardPackageTargetResult['documents'][number]): boolean {
  return (document.created === true || document.status === 'verified')
    && typeof document.documentId === 'string' && document.documentId.length > 0
    && typeof document.identifier === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(document.identifier);
}

export function dashboardPackageCopyCanVerify(document: DashboardPackageTargetResult['documents'][number]): boolean {
  return document.canVerifyExistingCopy === true && document.status !== 'verified' && dashboardPackageCopyCreated(document);
}

export function dashboardPackageDashboardUrl(document: DashboardPackageTargetResult['documents'][number], baseUrl?: string): string {
  if (!dashboardPackageCopyCreated(document) || !baseUrl) return '';
  try {
    const destination = new URL(baseUrl);
    if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password) return '';
    const expected = new URL(`/dashboards/${encodeURIComponent(document.identifier!)}`, destination).href;
    return document.url === expected ? expected : '';
  } catch { return ''; }
}

export function dashboardPackageCreatedCounts(results: DashboardPackageTargetResult[]) {
  const documents = results.flatMap(result => result.documents);
  const created = documents.filter(dashboardPackageCopyCreated).length;
  const verified = documents.filter(document => document.status === 'verified' && dashboardPackageCopyCreated(document)).length;
  return { created, verified, pendingVerification: created - verified };
}

export function readDashboardPackageHistorySummary(job: MigrationJob): {
  version: 1; dashboardCount: number; targetCount: number; stepCount: number; createdCount: number; verifiedCount: number; pendingVerificationCount: number;
} | null {
  const value = job.details?.dashboardPackageHistorySummary;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = ['dashboardCount', 'targetCount', 'stepCount', 'createdCount', 'verifiedCount', 'pendingVerificationCount'];
  if (row.version !== 1 || keys.some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 1_000_000)) return null;
  const summary = row as { version: 1; dashboardCount: number; targetCount: number; stepCount: number; createdCount: number; verifiedCount: number; pendingVerificationCount: number };
  return summary.createdCount <= summary.dashboardCount * summary.targetCount && summary.verifiedCount <= summary.createdCount
    && summary.pendingVerificationCount === summary.createdCount - summary.verifiedCount ? summary : null;
}

export function dashboardPackageHistorySummary(job: MigrationJob) {
  const compact = readDashboardPackageHistorySummary(job);
  if (compact) return compact;
  const results = readDashboardPackageResults(job);
  if (results === null || !job.sourceId) return null;
  const counts = dashboardPackageCreatedCounts(results);
  return { version: 1 as const, dashboardCount: job.documentIds.length, targetCount: job.targets?.length || 0,
    stepCount: job.items.length, createdCount: counts.created, verifiedCount: counts.verified, pendingVerificationCount: counts.pendingVerification };
}

export function dashboardPackageResultsVerified(job: MigrationJob, rows: DashboardPackageTargetResult[]): boolean {
  const targets = job.targets || [];
  return job.status === 'succeeded' && targets.length > 0 && rows.length === targets.length
    && new Set(rows.map((row) => row.targetId)).size === rows.length
    && rows.every((row) => targets.some((target) => target.id === row.targetId) && row.status === 'verified'
      && row.documents.length === job.documentIds.length && new Set(row.documents.map((document) => document.sourceDocumentId)).size === row.documents.length
      && row.documents.every((document) => job.documentIds.includes(document.sourceDocumentId) && document.status === 'verified'));
}
