import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/layout/PageHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { useConnection } from '@/hooks/useConnection';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import {
  fetchAIGovernanceFleet,
  type AIGovernanceEvidenceState,
  type AIGovernanceFleetReportDTO,
} from '@/services/aiGovernanceFleet';

type ScopeMode = 'fleet' | 'selected';

function statusFor(state: AIGovernanceEvidenceState): 'success' | 'error' | 'warning' | 'pending' | 'info' {
  if (state === 'available') return 'success';
  if (state === 'partial' || state === 'permission_denied' || state === 'unsupported') return 'warning';
  if (state === 'rate_limited') return 'pending';
  return 'error';
}

function labelFor(state: string): string {
  return state.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function numberLabel(value: number | null): string {
  return value === null ? 'Not reported' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function percentLabel(value: number | null): string {
  return value === null ? 'Not calculated' : `${value.toFixed(1)}%`;
}

function selectedOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function downloadEvidence(report: AIGovernanceFleetReportDTO): void {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `omnikit-ai-governance-${report.generatedAt.slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function AIGovernancePage() {
  const { connection } = useConnection();
  const [scopeMode, setScopeMode] = useState<ScopeMode>('fleet');
  const connectionKey = getConnectionCacheKey(connection);
  const selectedInstanceId = scopeMode === 'selected' ? connection.instanceId : undefined;
  const selectedInstanceOrigin = scopeMode === 'selected' ? selectedOrigin(connection.baseUrl) : undefined;
  const requestScopeKey = scopeMode === 'selected' ? `selected:${connectionKey}` : 'fleet';
  const [report, setReport] = useState<AIGovernanceFleetReportDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const activeRequestScopeKeyRef = useRef(requestScopeKey);

  useLayoutEffect(() => {
    activeRequestScopeKeyRef.current = requestScopeKey;
    requestRef.current += 1;
    setReport(null);
    setError('');
    setLoading(false);
  }, [requestScopeKey]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const activeScope = requestScopeKey;
    if (scopeMode === 'selected' && !selectedInstanceId) {
      setReport(null);
      setLoading(false);
      setError('The selected Omni instance is no longer saved. Select a saved instance before loading selected evidence.');
      return;
    }
    if (scopeMode === 'selected' && !selectedInstanceOrigin) {
      setReport(null);
      setLoading(false);
      setError('The selected saved Omni instance does not have a valid HTTPS tenant origin.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await fetchAIGovernanceFleet({
        ...(selectedInstanceId ? { instanceId: selectedInstanceId } : {}),
      });
      if (request !== requestRef.current || activeRequestScopeKeyRef.current !== activeScope) return;
      if (selectedInstanceId && (
        next.instances.length !== 1
        || next.instances[0]?.instanceId !== selectedInstanceId
        || next.instances[0]?.bundle.selectedInstance.origin !== selectedInstanceOrigin
        || next.coverage.total !== 1
      )) {
        throw new Error('AI governance returned evidence outside the selected instance scope.');
      }
      setReport(next);
    } catch (loadError) {
      if (request !== requestRef.current || activeRequestScopeKeyRef.current !== activeScope) return;
      setReport(null);
      setError(loadError instanceof Error ? loadError.message : 'AI governance evidence could not be loaded.');
    } finally {
      if (request === requestRef.current && activeRequestScopeKeyRef.current === activeScope) setLoading(false);
    }
  }, [requestScopeKey, scopeMode, selectedInstanceId, selectedInstanceOrigin]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Governance Fleet"
        description="Compare account-level AI credit controls with one bounded, point-in-time eval evidence read per instance. This view never changes limits or starts, polls, cancels, archives, or restores evals."
        icon={<Sparkles size={46} className="text-omni-700" />}
        actions={(
          <>
            <button type="button" className="btn-secondary text-sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh once
            </button>
            <button type="button" className="btn-secondary text-sm" onClick={() => report && downloadEvidence(report)} disabled={!report}>
              <Download size={14} />
              Export evidence
            </button>
          </>
        )}
      />

      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold text-content-primary">Evidence scope</div>
          <p className="mt-1 text-xs text-content-secondary">Fleet reads are bounded to two instances at a time and are only initiated by this page load or the refresh button.</p>
        </div>
        <div className="inline-flex rounded-button border border-border bg-surface-secondary p-1">
          <button type="button" onClick={() => setScopeMode('fleet')} className={`rounded px-3 py-1.5 text-xs font-semibold ${scopeMode === 'fleet' ? 'bg-white text-omni-800 shadow-sm' : 'text-content-secondary'}`}>
            All saved instances
          </button>
          <button type="button" onClick={() => setScopeMode('selected')} disabled={!connection.instanceId} className={`rounded px-3 py-1.5 text-xs font-semibold ${scopeMode === 'selected' ? 'bg-white text-omni-800 shadow-sm' : 'text-content-secondary'} disabled:opacity-50`}>
            Current instance
          </button>
        </div>
      </div>

      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {report && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="card p-4">
              <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">Coverage</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{report.coverage.included} / {report.coverage.total}</div>
              <p className="mt-1 text-xs text-content-secondary">Instances with complete credit-control and bounded eval evidence.</p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">Write posture</div>
              <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-content-primary"><ShieldCheck size={17} className="text-emerald-600" /> Read only</div>
              <p className="mt-1 text-xs text-content-secondary">No credit limit or eval mutation is available from this view.</p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">Checked</div>
              <div className="mt-2 text-sm font-semibold text-content-primary">{new Date(report.generatedAt).toLocaleString()}</div>
              <p className="mt-1 text-xs text-content-secondary">A point-in-time evidence snapshot, not a monitor.</p>
            </div>
          </div>

          <div className="space-y-3">
            {report.instances.map((instance) => {
              const { credits, evals } = instance.bundle.evidence;
              return (
                <section key={instance.instanceId} className="card p-0 overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <div>
                      <h2 className="text-sm font-semibold text-content-primary">{instance.instanceLabel}</h2>
                      <p className="mt-0.5 text-xs text-content-secondary">{instance.bundle.selectedInstance.origin}</p>
                    </div>
                    <StatusChip status={statusFor(instance.state)} label={labelFor(instance.state)} />
                  </div>
                  <div className="grid gap-px bg-border md:grid-cols-4">
                    {[
                      ['Credits used', numberLabel(credits.creditsUsed)],
                      ['Account limit', numberLabel(credits.accountCreditLimit)],
                      ['Remaining', numberLabel(credits.remainingCredits)],
                      ['Utilization', percentLabel(credits.utilizationPercent)],
                    ].map(([label, value]) => (
                      <div key={label} className="bg-white px-4 py-3">
                        <div className="text-[11px] font-medium uppercase tracking-wider text-content-secondary">{label}</div>
                        <div className="mt-1 text-sm font-semibold text-content-primary">{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-4 px-4 py-4 lg:grid-cols-2">
                    <div>
                      <div className="text-xs font-semibold text-content-primary">Credit-control evidence</div>
                      <p className="mt-1 text-xs leading-5 text-content-secondary">{credits.detail}</p>
                      <p className="mt-2 text-[11px] text-content-tertiary">Period: {credits.periodStart ? new Date(credits.periodStart).toLocaleString() : 'not reported'} → {credits.periodEnd ? new Date(credits.periodEnd).toLocaleString() : 'not reported'}</p>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 text-xs font-semibold text-content-primary">
                        AI eval read evidence
                        <StatusChip status={statusFor(evals.state)} label={labelFor(evals.state)} />
                      </div>
                      <p className="mt-1 text-xs leading-5 text-content-secondary">{evals.detail}</p>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-content-tertiary">
                        <span>Visible prompt sets: {numberLabel(evals.promptSetCount)}</span>
                        <span>Configured prompts: {numberLabel(evals.configuredPromptCount)}</span>
                        <span>Run collection: {labelFor(evals.runCollectionState)}</span>
                        <span>Run detail: {labelFor(evals.latestRunDetailState)}</span>
                      </div>
                      {evals.latestRun && (
                        <div className="mt-3 rounded border border-border bg-surface-secondary px-3 py-2 text-[11px] text-content-secondary">
                          <div className="font-semibold text-content-primary">Latest bounded run: {labelFor(evals.latestRun.status)}</div>
                          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                            <span>Results: {evals.latestRun.detailResultCount}</span>
                            <span>Terminal: {numberLabel(evals.latestRun.terminalResultCount)} / {numberLabel(evals.latestRun.totalResultCount)}</span>
                            <span>Scored: {evals.latestRun.scoredResultCount}</span>
                            <span>Average score: {numberLabel(evals.latestRun.averageScore)}</span>
                            <span>Errors: {evals.latestRun.errorResultCount}</span>
                            <span>Completed: {evals.latestRun.completedAt ? new Date(evals.latestRun.completedAt).toLocaleString() : 'not reported'}</span>
                          </div>
                        </div>
                      )}
                      <p className="mt-2 text-[11px] text-content-tertiary">Tenant contract: {evals.contractState === 'contract_observed' ? 'Observed' : 'Unverified'} · Read operations: {evals.discoveredReadOperations} · Writes identified but not run: {evals.discoveredWriteOperations}</p>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>

          <div className="card p-4">
            <div className="text-sm font-semibold text-content-primary">Known exclusions</div>
            <ul className="mt-2 space-y-1 text-xs leading-5 text-content-secondary">
              {report.exclusions.map((exclusion) => <li key={exclusion}>• {exclusion}</li>)}
            </ul>
          </div>
        </>
      )}

      {loading && !report && (
        <div className="card p-8 text-center text-sm text-content-secondary">Reading bounded AI governance evidence…</div>
      )}
    </div>
  );
}
