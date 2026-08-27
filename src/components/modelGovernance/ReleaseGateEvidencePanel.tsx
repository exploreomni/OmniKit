import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import {
  approveReleaseGate,
  reconcileReleaseGateApproval,
  type ReleaseGateApproval,
  type ReleaseGateEvidence,
} from '@/services/releaseGateEvidence';

interface ReleaseGateEvidencePanelProps {
  evidence: ReleaseGateEvidence;
  approval: ReleaseGateApproval | null;
  onApprovalChange: (approval: ReleaseGateApproval | null) => void;
  disabled?: boolean;
}

export function ReleaseGateEvidencePanel({
  evidence,
  approval,
  onApprovalChange,
  disabled = false,
}: ReleaseGateEvidencePanelProps) {
  const currentApproval = reconcileReleaseGateApproval(approval, evidence);
  const affectedContentCheck = evidence.checks.find((check) => check.id === 'affected_content');

  useEffect(() => {
    if (approval && !currentApproval) onApprovalChange(null);
  }, [approval, currentApproval, evidence.fingerprint, onApprovalChange]);

  return (
    <section className="rounded-card border border-border bg-surface-secondary p-4 space-y-3" aria-label="Release gate evidence">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-content-primary inline-flex items-center gap-2">
            <ShieldCheck size={16} /> Release gate evidence
          </h4>
          <p className="mt-1 text-xs text-content-secondary">
            Fresh instance, connection, Git, branch, checksum, validation, scoped impact, and diff evidence. OmniKit never merges this branch automatically.
          </p>
        </div>
        <span className={`rounded-chip px-2 py-1 text-xs font-semibold ${
          evidence.status === 'blocked'
            ? 'bg-red-50 text-red-700'
            : 'bg-green-50 text-green-700'
        }`}>
          {evidence.status === 'blocked'
            ? 'Blocked'
            : evidence.status === 'ready_for_pull_request' ? 'Ready for PR' : 'Ready for manual handoff'}
        </span>
      </div>

      <div className="rounded-button border border-border bg-white px-3 py-2 text-xs text-content-secondary">
        <span className="font-semibold text-content-primary">Scope:</span>{' '}
        {evidence.connection.instanceLabel || evidence.connection.origin} · {evidence.connection.connectionName || evidence.connection.connectionId} · {evidence.branch.modelName} / <span className="font-mono">{evidence.branch.branchName}</span>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {evidence.checks.map((check) => (
          <div key={check.id} className="rounded-button border border-border bg-white px-3 py-2 text-xs">
            <div className="flex items-center gap-2 font-semibold text-content-primary">
              {check.status === 'ready'
                ? <CheckCircle2 size={14} className="text-green-700" />
                : check.status === 'blocked'
                  ? <XCircle size={14} className="text-red-700" />
                  : <AlertTriangle size={14} className="text-amber-700" />}
              {check.label}
            </div>
            <div className="mt-1 text-content-secondary">{check.detail}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <details className="rounded-button border border-border bg-white overflow-hidden">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">
            Complete branch diff ({evidence.diff.length})
          </summary>
          <div className="border-t border-border px-3 py-2 space-y-1 text-xs text-content-secondary">
            {evidence.diff.length === 0
              ? <div>No changed files were verified.</div>
              : evidence.diff.map((row) => (
                  <div key={row.fileName} className="flex items-center justify-between gap-3">
                    <span className="font-mono break-all">{row.fileName}</span>
                    <span className="rounded-chip bg-surface-secondary px-2 py-0.5 font-semibold">{row.change}</span>
                  </div>
                ))}
          </div>
        </details>
        <details className="rounded-button border border-border bg-white overflow-hidden">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">
            Affected content ({evidence.affectedContent.length})
          </summary>
          <div className="border-t border-border px-3 py-2 space-y-1 text-xs text-content-secondary">
            {evidence.affectedContent.length === 0
              ? <div>{affectedContentCheck?.detail || 'Affected-content inventory is unavailable.'}</div>
              : evidence.affectedContent.slice(0, 10).map((row) => (
                  <div key={`${row.documentId}:${row.identifier}:${row.name}`}>{row.name} · {row.type}</div>
                ))}
            {evidence.affectedContent.length > 10 && <div>+{evidence.affectedContent.length - 10} more</div>}
          </div>
        </details>
      </div>

      <div className="text-[11px] text-content-tertiary">
        Evidence fingerprint: <span className="font-mono">{evidence.fingerprint.slice(0, 32)}…</span> · collected {evidence.collectedAt}
      </div>

      <label className={`flex items-start gap-2 rounded-button border px-3 py-2 text-xs ${
        evidence.status === 'blocked'
          ? 'border-red-100 bg-red-50 text-red-700'
          : 'border-omni-100 bg-omni-50 text-omni-700'
      }`}>
        <input
          type="checkbox"
          checked={Boolean(currentApproval)}
          disabled={disabled || evidence.status === 'blocked'}
          onChange={(event) => onApprovalChange(event.target.checked ? approveReleaseGate(evidence) : null)}
          className="mt-0.5 rounded border-omni-300 text-omni-700 focus:ring-omni-500"
        />
        <span>
          I reviewed this exact evidence fingerprint and approve the {evidence.handoff.mode === 'pull_request' ? 'pull-request' : 'manual Omni'} handoff. Any state change invalidates this approval.
        </span>
      </label>
    </section>
  );
}
