import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Process-bound, short-lived review receipts contain no model YAML. Restarting
// the service invalidates unsigned/unsubmitted reviews rather than trusting them.
const key = randomBytes(32);
const TTL = 15 * 60_000;
export function dashboardRepairSnapshotHash(value: unknown): string {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable)
    : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map((name) => [name, stable((input as Record<string, unknown>)[name])])) : input;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export interface DashboardRepairApprovalEvidence {
  planId: string; revision: number; targetId: string; sourceModelId: string;
  sourceModelHash: string; targetModelHash: string; fileName: string;
  yaml: string; previousChecksum?: string;
  instanceBoundaryHash: string;
  sourceDocumentHashes: Record<string, string>;
  sourceWorkbookHashes: Record<string, string>;
}
function requireBinding(value: DashboardRepairApprovalEvidence): void {
  if (!/^[a-f0-9]{64}$/.test(value.instanceBoundaryHash || '')
    || [value.sourceDocumentHashes, value.sourceWorkbookHashes].some((hashes) => !hashes || typeof hashes !== 'object'
      || Array.isArray(hashes) || !Object.keys(hashes).length
      || Object.entries(hashes).some(([id, hash]) => !id || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) {
    throw Object.assign(new Error('This repair review is missing source or instance binding evidence. Prepare and approve fresh differences.'), { statusCode: 409 });
  }
}
function signature(value: DashboardRepairApprovalEvidence, expires: number): string {
  return createHmac('sha256', key).update(JSON.stringify([expires, value.planId, value.revision,
    value.targetId, value.sourceModelId, value.sourceModelHash, value.targetModelHash,
    value.fileName, value.yaml, value.previousChecksum ?? null, value.instanceBoundaryHash,
    dashboardRepairSnapshotHash(value.sourceDocumentHashes), dashboardRepairSnapshotHash(value.sourceWorkbookHashes)])).digest('hex');
}
export function issueDashboardRepairApproval(value: DashboardRepairApprovalEvidence): string {
  requireBinding(value);
  const expires = Date.now() + TTL;
  return `${expires}.${signature(value, expires)}`;
}
export function verifyDashboardRepairApproval(token: unknown, value: DashboardRepairApprovalEvidence): void {
  requireBinding(value);
  const parts = typeof token === 'string' ? token.split('.') : [];
  const [time, hash] = parts;
  const expires = Number(time);
  if (parts.length !== 2 || !Number.isSafeInteger(expires) || expires < Date.now() || expires > Date.now() + TTL || !/^[a-f0-9]{64}$/.test(hash || '')
    || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(signature(value, expires), 'hex'))) {
    throw Object.assign(new Error('The accepted YAML no longer matches its reviewed diff, or the review expired. Prepare and approve fresh differences.'), { statusCode: 409 });
  }
}
