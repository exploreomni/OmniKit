import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  SearchCheck,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import type { ConnectionConfig } from '@/types';
import {
  fetchIdentityAccessEvidence,
  IDENTITY_ACCESS_CONTENT_ROLES,
  IDENTITY_ACCESS_MODEL_ROLES,
  serializeIdentityAccessEvidence,
  type IdentityAccessContentRole,
  type IdentityAccessEvidenceClassification,
  type IdentityAccessEvidenceReport,
  type IdentityAccessExpectedAccess,
  type IdentityAccessModelRole,
  type IdentityAccessPrincipalType,
} from '@/services/identityAccessEvidence';

interface IdentityAccessDebuggerProps {
  connection: ConnectionConfig;
}

interface DebuggerFormState {
  principalType: IdentityAccessPrincipalType;
  principalIdentifier: string;
  connectionId: string;
  modelId: string;
  folderId: string;
  documentId: string;
  expectedActive: '' | 'active' | 'inactive';
  expectedModelRole: '' | IdentityAccessModelRole;
  expectedContentRole: '' | IdentityAccessContentRole;
}

const INITIAL_FORM: DebuggerFormState = {
  principalType: 'user',
  principalIdentifier: '',
  connectionId: '',
  modelId: '',
  folderId: '',
  documentId: '',
  expectedActive: '',
  expectedModelRole: '',
  expectedContentRole: '',
};

const CLASSIFICATION_LABELS: Record<IdentityAccessEvidenceClassification, string> = {
  observed: 'Observed',
  inferred: 'Inferred',
  operator_confirmed: 'Operator-confirmed',
  unverified: 'Unverified',
};

const CLASSIFICATION_CLASSES: Record<IdentityAccessEvidenceClassification, string> = {
  observed: 'bg-green-100 text-green-800',
  inferred: 'bg-blue-100 text-blue-800',
  operator_confirmed: 'bg-purple-100 text-purple-800',
  unverified: 'bg-amber-100 text-amber-900',
};

function expectedAccess(form: DebuggerFormState): IdentityAccessExpectedAccess | undefined {
  const expected: IdentityAccessExpectedAccess = {
    ...(form.expectedActive ? { active: form.expectedActive === 'active' } : {}),
    ...(form.expectedModelRole ? { modelRole: form.expectedModelRole } : {}),
    ...(form.expectedContentRole ? { contentRole: form.expectedContentRole } : {}),
  };
  return Object.keys(expected).length > 0 ? expected : undefined;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return 'Not returned';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return error instanceof Error && error.message
    ? error.message
    : 'Identity access evidence could not be collected.';
}

function downloadEvidence(report: IdentityAccessEvidenceReport) {
  const blob = new Blob([serializeIdentityAccessEvidence(report)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `omnikit-access-evidence-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function IdentityAccessDebugger({ connection }: IdentityAccessDebuggerProps) {
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const selectedInstanceId = connection.instanceId?.trim() || '';
  const selectedInstanceLabel = connection.instanceLabel?.trim() || selectedInstanceId;
  const selectedInstanceReady = Boolean(
    selectedInstanceId
    && connection.connectionMode === 'vault'
    && connection.status === 'success',
  );
  const [form, setForm] = useState<DebuggerFormState>(INITIAL_FORM);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [report, setReport] = useState<IdentityAccessEvidenceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    requestSequenceRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setForm(INITIAL_FORM);
    setAdvancedOpen(false);
    setReport(null);
    setLoading(false);
    setError('');
    return () => controllerRef.current?.abort();
  }, [connectionKey]);

  function updateForm<K extends keyof DebuggerFormState>(key: K, value: DebuggerFormState[K]) {
    requestSequenceRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setLoading(false);
    setReport(null);
    setError('');
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function inspect() {
    if (!selectedInstanceReady) {
      setError('Select and connect a validated saved Omni instance before collecting access evidence.');
      return;
    }
    if (!form.principalIdentifier.trim()) {
      setError(form.principalType === 'user' ? 'Enter an exact user email or Omni user ID.' : 'Enter an exact group name or Omni group ID.');
      return;
    }
    const requestKey = connectionKey;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => (
      requestSequenceRef.current === requestId
      && !controller.signal.aborted
      && isActiveConnectionRequest(requestKey)
    );
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const expected = expectedAccess(form);
      const next = await fetchIdentityAccessEvidence({
        instanceId: selectedInstanceId,
        principalType: form.principalType,
        principalIdentifier: form.principalIdentifier,
        ...(form.connectionId.trim() ? { connectionId: form.connectionId } : {}),
        ...(form.modelId.trim() ? { modelId: form.modelId } : {}),
        ...(form.folderId.trim() ? { folderId: form.folderId } : {}),
        ...(form.documentId.trim() ? { documentId: form.documentId } : {}),
        ...(expected ? { expectedAccess: expected } : {}),
      }, { signal: controller.signal });
      if (!isCurrent() || next.instance.id !== selectedInstanceId) return;
      setReport(next);
    } catch (nextError) {
      if (!isCurrent()) return;
      setError(errorMessage(nextError));
    } finally {
      if (isCurrent()) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }

  const classificationCounts = useMemo(() => {
    const counts: Record<IdentityAccessEvidenceClassification, number> = {
      observed: 0,
      inferred: 0,
      operator_confirmed: 0,
      unverified: 0,
    };
    for (const finding of report?.findings || []) counts[finding.classification] += 1;
    return counts;
  }, [report]);

  return (
    <section data-testid="identity-access-debugger" className="card p-0 overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              <SearchCheck size={17} className="text-omni-700" />
              Effective Access Debugger
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-content-secondary">
              Correlate one explicit standard user or group with documented membership, model-role, and selected-document evidence. Findings distinguish observed facts, correlations, operator expectations, and evidence gaps.
            </p>
          </div>
          <div className="rounded-chip border border-border bg-surface-secondary px-3 py-1.5 text-xs text-content-secondary">
            Instance: <span className="font-semibold text-content-primary">{selectedInstanceLabel || 'No saved instance selected'}</span>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-5 py-5">
        <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content-secondary">Principal type</span>
            <select
              aria-label="Access debugger principal type"
              value={form.principalType}
              onChange={(event) => updateForm('principalType', event.target.value as IdentityAccessPrincipalType)}
              className="input-field"
            >
              <option value="user">Standard user</option>
              <option value="group">Group</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content-secondary">
              {form.principalType === 'user' ? 'Exact user email or Omni ID' : 'Exact group name or Omni ID'}
            </span>
            <input
              aria-label="Access debugger principal identifier"
              value={form.principalIdentifier}
              onChange={(event) => updateForm('principalIdentifier', event.target.value)}
              className="input-field"
              autoComplete="off"
              placeholder={form.principalType === 'user' ? 'analyst@example.com' : 'Analytics Users'}
            />
          </label>
          <button
            type="button"
            onClick={() => void inspect()}
            disabled={loading || !selectedInstanceReady}
            className="btn-primary min-w-[190px] justify-center text-sm disabled:opacity-40"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {loading ? 'Collecting evidence...' : 'Collect read-only evidence'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          aria-expanded={advancedOpen}
          className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700"
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Scope and expected access
        </button>

        {advancedOpen && (
          <div className="grid gap-3 rounded-card border border-border bg-surface-secondary p-4 md:grid-cols-2 xl:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Connection ID, optional</span>
              <input aria-label="Access debugger connection ID" value={form.connectionId} onChange={(event) => updateForm('connectionId', event.target.value)} className="input-field bg-white" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Model ID, optional</span>
              <input aria-label="Access debugger model ID" value={form.modelId} onChange={(event) => updateForm('modelId', event.target.value)} className="input-field bg-white" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Document ID, optional</span>
              <input aria-label="Access debugger document ID" value={form.documentId} onChange={(event) => updateForm('documentId', event.target.value)} className="input-field bg-white" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Folder ID or exact path, optional</span>
              <input aria-label="Access debugger folder ID or path" value={form.folderId} onChange={(event) => updateForm('folderId', event.target.value)} className="input-field bg-white" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Expected lifecycle, optional</span>
              <select aria-label="Access debugger expected lifecycle" value={form.expectedActive} onChange={(event) => updateForm('expectedActive', event.target.value as DebuggerFormState['expectedActive'])} className="input-field bg-white">
                <option value="">Not specified</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Expected model role, optional</span>
              <select aria-label="Access debugger expected model role" value={form.expectedModelRole} onChange={(event) => updateForm('expectedModelRole', event.target.value as DebuggerFormState['expectedModelRole'])} className="input-field bg-white">
                <option value="">Not specified</option>
                {IDENTITY_ACCESS_MODEL_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-content-secondary">Expected document role, optional</span>
              <select aria-label="Access debugger expected document role" value={form.expectedContentRole} onChange={(event) => updateForm('expectedContentRole', event.target.value as DebuggerFormState['expectedContentRole'])} className="input-field bg-white">
                <option value="">Not specified</option>
                {IDENTITY_ACCESS_CONTENT_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
          </div>
        )}

        <div className="rounded-card border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800">
          Assignment and permission evidence is not proof of row, field, query-result, or end-user runtime access. Validate the final experience with a controlled test user in Omni.
        </div>

        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      </div>

      {report && (
        <div className="space-y-5 border-t border-border bg-surface-secondary px-5 py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                {report.findings.some((finding) => finding.severity === 'warning')
                  ? <AlertTriangle size={17} className="text-amber-600" />
                  : <CheckCircle2 size={17} className="text-green-700" />}
                Evidence for {report.principal.displayName}
              </div>
              <p className="mt-1 text-xs text-content-secondary">
                Checked {formatTime(report.checkedAt)} · {report.principal.type === 'user' ? 'Standard user' : 'Group'} · <span className="font-mono">{report.principal.id}</span>
              </p>
            </div>
            <button type="button" onClick={() => downloadEvidence(report)} className="btn-secondary text-sm">
              <Download size={14} />
              Export sanitized evidence
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(Object.keys(CLASSIFICATION_LABELS) as IdentityAccessEvidenceClassification[]).map((classification) => (
              <div key={classification} className="rounded-card border border-border bg-white px-3 py-2">
                <div className="text-lg font-semibold text-content-primary">{classificationCounts[classification]}</div>
                <div className="text-[11px] text-content-secondary">{CLASSIFICATION_LABELS[classification]}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-card border border-border bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-content-secondary"><Users size={14} /> Lifecycle</div>
              <div className="mt-2 text-sm font-semibold capitalize text-content-primary">{report.lifecycle.state}</div>
              <div className="mt-1 text-xs text-content-secondary">Last login: {formatTime(report.lifecycle.lastLogin)}</div>
              {report.lifecycle.inactiveGroupMembers !== undefined && <div className="mt-1 text-xs text-content-secondary">Inactive group members: {report.lifecycle.inactiveGroupMembers}</div>}
              {report.lifecycle.unknownLifecycleGroupMembers !== undefined && <div className="mt-1 text-xs text-content-secondary">Members with lifecycle not returned: {report.lifecycle.unknownLifecycleGroupMembers}</div>}
              {report.lifecycle.unresolvedGroupMembers !== undefined && <div className="mt-1 text-xs text-content-secondary">Unresolved members: {report.lifecycle.unresolvedGroupMembers}</div>}
              {report.lifecycle.offboardingExposure.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-800">
                  {report.lifecycle.offboardingExposure.map((value) => <li key={value}>{value}</li>)}
                </ul>
              )}
            </div>
            <div className="rounded-card border border-border bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Observed relationships</div>
              <div className="mt-2 text-sm text-content-primary">{report.groups.length} group relationship{report.groups.length === 1 ? '' : 's'}</div>
              <div className="mt-1 text-sm text-content-primary">{report.modelRoles.length} model-role record{report.modelRoles.length === 1 ? '' : 's'}</div>
              <div className="mt-1 text-sm text-content-primary">{report.documentAccess.length} selected-document access entr{report.documentAccess.length === 1 ? 'y' : 'ies'}</div>
            </div>
            <div className="rounded-card border border-border bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Requested scope</div>
              <div className="mt-2 space-y-1 text-xs text-content-secondary">
                <div>Connection: <span className="font-mono text-content-primary">{report.scope.connectionId || 'All returned'}</span></div>
                <div>Model: <span className="font-mono text-content-primary">{report.scope.modelId || 'All returned'}</span></div>
                <div>Document: <span className="font-mono text-content-primary">{report.scope.documentId || 'Not requested'}</span></div>
                <div>Folder: <span className="font-mono text-content-primary">{report.scope.folderId || 'Not requested'}</span></div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-content-primary">Findings</h3>
            <div className="mt-2 space-y-2">
              {report.findings.map((finding) => (
                <div key={finding.id} className="rounded-card border border-border bg-white px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-content-primary">{finding.label}</div>
                    <span className={`rounded-chip px-2 py-0.5 text-[11px] font-semibold ${CLASSIFICATION_CLASSES[finding.classification]}`}>
                      {CLASSIFICATION_LABELS[finding.classification]}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-content-secondary">{finding.message}</p>
                  <div className="mt-1 text-[11px] text-content-tertiary">Coverage: {finding.coverageSource} · Source: {finding.source.path || finding.source.kind}</div>
                </div>
              ))}
            </div>
          </div>

          {(report.modelRoles.length > 0 || report.documentAccess.length > 0) && (
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-card border border-border bg-white p-4">
                <h3 className="text-sm font-semibold text-content-primary">Model-role records</h3>
                <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                  {report.modelRoles.length === 0 ? <div className="text-xs text-content-secondary">No model-role records returned.</div> : report.modelRoles.slice(0, 100).map((role, index) => (
                    <div key={`${role.principalId}-${role.roleName}-${role.connectionId || ''}-${role.modelId || ''}-${index}`} className="rounded-button border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                      <div className="font-semibold text-content-primary">{role.roleName} · {role.principalName}</div>
                      <div>Connection: <span className="font-mono">{role.connectionId || 'Not returned'}</span> · Model: <span className="font-mono">{role.modelId || 'Not returned'}</span></div>
                      <div>Provenance: {role.provenance?.type || 'Not returned'}{role.provenance?.name ? ` · ${role.provenance.name}` : ''}</div>
                    </div>
                  ))}
                  {report.modelRoles.length > 100 && <div className="text-xs text-content-secondary">{report.modelRoles.length - 100} additional records are available in the sanitized export.</div>}
                </div>
              </div>
              <div className="rounded-card border border-border bg-white p-4">
                <h3 className="text-sm font-semibold text-content-primary">Selected-document access records</h3>
                <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                  {report.documentAccess.length === 0 ? <div className="text-xs text-content-secondary">No matching access records returned.</div> : report.documentAccess.slice(0, 100).map((entry, index) => (
                    <div key={`${entry.principalId}-${entry.role}-${entry.accessSource}-${index}`} className="rounded-button border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                      <div className="font-semibold text-content-primary">{entry.role} · {entry.principalName}</div>
                      <div>{entry.relationship === 'group' ? 'Correlated through observed group membership' : 'Direct principal'} · {entry.accessSource} access{entry.isOwner ? ' · Owner' : ''}</div>
                      {entry.folder && <div>Folder: {entry.folder.path || entry.folder.name || entry.folder.id || 'Not returned'}</div>}
                    </div>
                  ))}
                  {report.documentAccess.length > 100 && <div className="text-xs text-content-secondary">{report.documentAccess.length - 100} additional records are available in the sanitized export.</div>}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-card border border-border bg-white p-4">
            <h3 className="text-sm font-semibold text-content-primary">Coverage and exclusions</h3>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {report.coverage.map((entry) => (
                <div key={entry.source} className="rounded-button border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold text-content-primary">{entry.source.replace(/_/g, ' ')}</span><span className="capitalize">{entry.state.replace(/_/g, ' ')}</span></div>
                  <div className="mt-1">{entry.reason}</div>
                  <div className="mt-1">Coverage: {entry.included}/{entry.total === null ? 'unknown' : entry.total}</div>
                </div>
              ))}
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-content-secondary">
              {report.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
