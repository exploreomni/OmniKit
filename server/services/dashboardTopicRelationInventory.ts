import type { DashboardTopicInventoryDiagnostic, DashboardTopicRelationEvidence } from '../../shared/dashboardTopicRepair';
import { dashboardRepairSnapshotHash } from './dashboardRepairApproval';

interface InventoryIssue { code: string; name?: string; category: string }
export interface DashboardTopicRelationInventory {
  observedNames: string[];
  fingerprints: Record<string, string>;
  fileNames: Record<string, string[]>;
  issues: InventoryIssue[];
  /** Non-view placeholders are accounted for, never interpreted as missing views. */
  nonViewEntries: Array<{ kind: 'model' | 'relationship' | 'topic'; evidenceHash: string }>;
  /** False means absence cannot be established, even for an otherwise valid name. */
  complete: boolean;
  snapshotHash: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function dashboardRelationIdentity(value: string): string { return value.normalize('NFKC').trim().toLowerCase(); }
function supportedName(value: string): boolean {
  return /^[a-z_][\w/-]*$/.test(value)
    && value.split('/').every((part) => Boolean(part) && !['__proto__', 'constructor', 'prototype'].includes(part));
}
function nameCategory(value: unknown): string {
  if (typeof value !== 'string') return value === null ? 'null identity' : `${Array.isArray(value) ? 'array' : typeof value} identity`;
  if (!value.trim()) return 'empty identity';
  if (value.length > 256) return 'overlong identity';
  // eslint-disable-next-line no-control-regex -- Deliberately reject ASCII control characters in untrusted names.
  if (/[\x00-\x1f\x7f]/.test(value)) return 'control characters';
  // eslint-disable-next-line no-control-regex -- The full ASCII range is intentional, after rejecting its controls above.
  if (/[^\x00-\x7f]/.test(value)) return 'non-ASCII identity';
  if (value.includes('.')) return 'identity containing periods';
  if (/\s/.test(value)) return 'identity containing whitespace';
  return 'unsupported identity syntax';
}
function safeFilePath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Untrusted file paths must reject backslashes and ASCII controls.
  return value === value.trim() && value.length <= 2_048 && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function nonViewFileKind(fileName: string): 'model' | 'relationship' | 'topic' | undefined {
  // These are the distinct file kinds in the YAML API, not inferred view names.
  // https://docs.omni.co/api/models/create-or-update-yaml-files
  if (fileName === 'model') return 'model';
  if (fileName === 'relationships') return 'relationship';
  if (fileName.endsWith('.topic') || fileName.endsWith('.composite_topic')) return 'topic';
  return undefined;
}

/** Decode without discarding occupancy or inventing identities from file stems. */
export function readDashboardTopicRelationInventory(raw: unknown): DashboardTopicRelationInventory {
  const result: DashboardTopicRelationInventory = { observedNames: [], fingerprints: {}, fileNames: {}, issues: [], nonViewEntries: [], complete: true, snapshotHash: '' };
  const finish = () => {
    result.observedNames.sort();
    result.snapshotHash = dashboardRepairSnapshotHash({ observedNames: result.observedNames, fingerprints: result.fingerprints,
      fileNames: result.fileNames, issues: result.issues, nonViewEntries: result.nonViewEntries, complete: result.complete });
    return result;
  };
  const definitions = record(raw) ? raw.viewNames : undefined;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(definitions); } catch { /* Invalid input is a coverage gap, not an empty inventory. */ }
  if (!record(definitions) || serialized === undefined || Object.keys(definitions).length > 5_000 || serialized.length > 5_000_000) {
    result.complete = false;
    result.issues.push({ code: 'VIEW_INDEX_INCOMPLETE', category: definitions === undefined ? 'missing inventory' : 'invalid or oversized inventory' });
    return finish();
  }
  const seen = new Set<string>();
  const fingerprints = new Map<string, string>();
  const files = new Map<string, string[]>();
  const authoredFiles = record(raw) && record(raw.files) ? raw.files : undefined;
  const issue = (code: string, category: string, name?: string) => {
    result.issues.push({ code, category, name });
    if (!name) result.complete = false;
    if (name) fingerprints.delete(name);
  };
  for (const [entryKey, value] of Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))) {
    const safePath = safeFilePath(entryKey);
    const nonViewKind = safePath ? nonViewFileKind(entryKey) : undefined;
    const hasAuthoredFile = Boolean(authoredFiles && Object.hasOwn(authoredFiles, entryKey));
    const authored = hasAuthoredFile ? authoredFiles![entryKey] : undefined;
    // The index may include an empty name for a model, relationships, or topic
    // file. Exclude only an exact, returned non-view file; an empty .view or an
    // unreturned/unknown file still prevents proving destination absence.
    if (nonViewKind && typeof value === 'string' && !value.trim() && typeof authored === 'string') {
      result.nonViewEntries.push({ kind: nonViewKind,
        evidenceHash: dashboardRepairSnapshotHash({ fileName: entryKey, value, authored }) });
      continue;
    }
    // Existing consumers use exact file->name bindings. File paths are not view identities.
    const indexed = /\.(?:view|ya?ml)$/i.test(entryKey)
      || Boolean(nonViewKind) || (typeof value === 'string' && hasAuthoredFile);
    const identityValue = indexed ? value : entryKey;
    const name = typeof identityValue === 'string' ? dashboardRelationIdentity(identityValue) : '';
    const known = supportedName(name) && name.length <= 256;
    const shape = `${indexed ? 'file-to-name' : 'name-to-definition'}; ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value} value`;
    // Unknown syntax cannot establish unrelatedness or safe destination absence.
    if (!known) { issue('VIEW_NAME_UNSUPPORTED', `${shape}; ${nameCategory(identityValue)}`); continue; }
    result.observedNames.push(name);
    // Keep all known file ownership, including ambiguous/unverified entries.
    // Otherwise a filename fallback could resolve a file owned by another name.
    if (indexed && safePath) files.set(name, [...(files.get(name) || []), entryKey]);
    if (seen.has(name)) { issue('VIEW_NAME_AMBIGUOUS', 'multiple entries resolve to the same identity', name); continue; }
    seen.add(name);
    if (indexed) {
      if (nonViewKind) { issue('VIEW_MAPPING_KIND_CONFLICT', `${shape}; ${nonViewKind} file cannot identify a view`, name); continue; }
      if (!safePath) { issue('VIEW_MAPPING_UNSUPPORTED', `${shape}; unsupported file path`, name); continue; }
      if (authored !== undefined && typeof authored !== 'string') { issue('VIEW_DEFINITION_UNSUPPORTED', `${shape}; non-string authored YAML`, name); continue; }
      fingerprints.set(name, dashboardRepairSnapshotHash({ fileName: entryKey, viewName: value, authored: authored ?? null }));
    } else {
      if (value === null || !['string', 'object'].includes(typeof value) || Array.isArray(value)) {
        issue('VIEW_DEFINITION_UNSUPPORTED', shape, name); continue;
      }
      try { fingerprints.set(name, dashboardRepairSnapshotHash(value)); }
      catch { issue('VIEW_DEFINITION_UNSUPPORTED', `${shape}; unsupported nesting`, name); }
    }
  }
  // Every collision stays unverified regardless of entry order or equal bytes.
  for (const row of result.issues) if (row.name) fingerprints.delete(row.name);
  result.observedNames = [...new Set(result.observedNames)];
  result.fingerprints = Object.fromEntries(fingerprints);
  result.fileNames = Object.fromEntries(files);
  return finish();
}

/** Exact index ownership takes precedence over legacy filename inference. */
export function dashboardTopicViewMatches(files: Record<string, string>, index: Record<string, string[]>, name: string): { matches: string[]; conflict: boolean } {
  const key = dashboardRelationIdentity(name);
  if (Object.hasOwn(index, key)) return { matches: index[key].filter((file) => Object.hasOwn(files, file)), conflict: index[key].length !== 1 };
  const candidates = Object.keys(files).filter((file) => {
    if (!file.endsWith('.view')) return false;
    const stem = file.replace(/\.(?:query\.view|view)$/, '');
    return dashboardRelationIdentity(stem) === key || (!name.includes('/') && dashboardRelationIdentity(stem.split('/').pop()!) === key);
  });
  const owned = new Set(Object.values(index).flat());
  return { matches: candidates.filter((file) => !owned.has(file)), conflict: candidates.some((file) => owned.has(file)) };
}

/** Compatibility helper for callers requiring an entirely verified inventory. */
export function dashboardTopicRelationInventory(raw: unknown): Record<string, string> {
  const inventory = readDashboardTopicRelationInventory(raw);
  if (inventory.issues.length) throw new Error(inventory.issues[0].code === 'VIEW_NAME_AMBIGUOUS'
    ? 'Inherited view identities are ambiguous.' : 'The view inventory is incomplete or contains an unsupported identity or definition.');
  return inventory.fingerprints;
}

export function dashboardTopicInventoryDiagnostics(inventory: DashboardTopicRelationInventory, names: string[], side: 'source' | 'destination'): DashboardTopicInventoryDiagnostic[] {
  const required = new Set(names.map(dashboardRelationIdentity));
  const groups = new Map<string, DashboardTopicInventoryDiagnostic>();
  for (const issue of inventory.issues) {
    const severity = !issue.name || required.has(issue.name) ? 'blocker' : 'warning';
    const key = `${severity}:${issue.code}:${issue.category}`;
    const row = groups.get(key);
    if (row) { row.count++; continue; }
    groups.set(key, { side, severity, code: issue.code, count: 1,
      message: `${side === 'source' ? 'Source' : 'Destination'} view index: ${issue.category}. ${!issue.name
        ? 'The affected identity cannot be established, so absence and dependency safety cannot be verified. Inspect the model view index before approval.'
        : severity === 'blocker' ? 'This affects a required dependency. Resolve its definition or ambiguous mapping before approval.'
          : 'The identified view is outside this dependency package. It will not be reused or created by this repair.'}` });
  }
  const diagnostics = [...groups.values()];
  for (const kind of ['model', 'relationship', 'topic'] as const) {
    const count = inventory.nonViewEntries.filter((entry) => entry.kind === kind).length;
    if (count) diagnostics.push({ side, severity: 'warning', code: 'NON_VIEW_INDEX_ENTRY', count,
      message: `${side === 'source' ? 'Source' : 'Destination'} index: ${count} ${kind} file ${count === 1 ? 'entry has' : 'entries have'} no view name. These exact files were returned as ${kind} files, not views; they do not block view inventory verification. Their definitions remain subject to model and dependency review.` });
  }
  return diagnostics;
}

export function dashboardTopicRelationEvidence(names: string[], source: Record<string, string>, target: Record<string, string>): DashboardTopicRelationEvidence {
  const select = (inventory: Record<string, string>) => Object.fromEntries([...new Set(names)].sort().map((name) => {
    if (!Object.hasOwn(inventory, name)) throw new Error('A required inherited view is no longer verified. Review its dependency again.');
    return [name, inventory[name]];
  }));
  return { source: select(source), target: select(target) };
}

export function assertDashboardTopicRelationInventory(raw: unknown, expected: Record<string, string>, side: string): void {
  if (!Object.keys(expected).length) return;
  const current = readDashboardTopicRelationInventory(raw);
  if (!current.complete || Object.entries(expected).some(([name, hash]) => current.fingerprints[name] !== hash)) {
    throw new Error(`${side} inherited view evidence changed after review. Prepare fresh differences.`);
  }
}
