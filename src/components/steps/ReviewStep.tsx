import { useState, useCallback, useMemo } from 'react';
import { ArrowRight, Play, Zap, AlertTriangle, XCircle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { StatusChip } from '@/components/ui/StatusChip';
import { migrate } from '@/services/omniApi';
import type { WizardState, WizardAction, MigrationResult } from '@/types';

interface DiagnosticEntry {
  phase: string;
  detail: Record<string, unknown>;
}

type DiagnosticsMap = Record<string, DiagnosticEntry[]>;

interface PreflightDetail {
  referencedFieldCount: number | null;
  matchedFieldCount: number | null;
  targetFieldCount: number | null;
  missingFields: string[];
  warnings: string[];
  semanticCheckAvailable: boolean | null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function preflightFromDiagnostics(entries: DiagnosticEntry[] | undefined): PreflightDetail | null {
  const entry = entries?.find((item) => item.phase === 'compatibility_preflight');
  if (!entry) return null;
  return {
    referencedFieldCount: asNumber(entry.detail.referencedFieldCount),
    matchedFieldCount: asNumber(entry.detail.matchedFieldCount),
    targetFieldCount: asNumber(entry.detail.targetFieldCount),
    missingFields: asStringArray(entry.detail.missingFields),
    warnings: asStringArray(entry.detail.warnings),
    semanticCheckAvailable: typeof entry.detail.semanticCheckAvailable === 'boolean'
      ? entry.detail.semanticCheckAvailable
      : null,
  };
}

function groupFieldsByView(fields: string[]): Array<{ view: string; fields: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const field of fields) {
    const [view] = field.split('.');
    const key = view || 'unscoped';
    grouped.set(key, [...(grouped.get(key) || []), field]);
  }
  return [...grouped.entries()].map(([view, items]) => ({ view, fields: items }));
}

function preflightSeverity(result: MigrationResult | undefined, detail: PreflightDetail | null) {
  if (result?.status === 'failed' || result?.status === 'skipped') {
    return { status: 'failed', label: 'Blocked', text: 'This dashboard should not be copied or remapped until the blocker is resolved.' };
  }
  if (detail?.semanticCheckAvailable === false) {
    return { status: 'warning', label: 'Review required', text: 'Payload shape was checked, but target model fields could not be fully inspected.' };
  }
  if ((detail?.missingFields.length || 0) > 0 || result?.status === 'warning') {
    return { status: 'warning', label: 'Field mismatch', text: 'The target model is missing at least one field referenced by this dashboard.' };
  }
  if (result?.status === 'ready') {
    return { status: 'ready', label: 'Ready', text: 'No field-presence issues were detected by Compatibility Preflight.' };
  }
  return { status: 'pending', label: 'Pending', text: 'Run Compatibility Preflight before applying changes.' };
}

interface ReviewStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onBack: () => void;
}

export function ReviewStep({ state, dispatch, onBack }: ReviewStepProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [dryRunResults, setDryRunResults] = useState<MigrationResult[] | null>(null);
  const [dryRunAttempted, setDryRunAttempted] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsMap>({});
  const [expandedDiag, setExpandedDiag] = useState<Set<string>>(new Set());

  const targetConn = state.sameInstance ? state.source : state.target;
  const targetFolder = !state.sameInstance && state.targetFolder.trim()
    ? state.targetFolder.trim()
    : undefined;

  async function handleDryRun() {
    setRunningDryRun(true);
    setDryRunResults(null);
    setDryRunError(null);
    setDryRunAttempted(false);
    setDiagnostics({});
    setExpandedDiag(new Set());
    const results: MigrationResult[] = [];
    const diagMap: DiagnosticsMap = {};

    try {
      await migrate(
        {
          source: { base_url: state.source.baseUrl, api_key: state.source.apiKey },
          target: { base_url: targetConn.baseUrl, api_key: targetConn.apiKey },
          dashboards: state.selectedDashboards.map((d) => ({
            id: d.id,
            name: d.name,
            base_model_id: d.baseModelId,
          })),
          model_mapping: state.modelMappings,
          target_folder: targetFolder,
          dry_run: true,
          in_place: state.sameInstance,
        },
        (event) => {
          const e = event as Record<string, unknown>;
          if (e.type === 'diagnostic') {
            const dashId = e.dashboard_id as string;
            if (dashId) {
              if (!diagMap[dashId]) diagMap[dashId] = [];
              diagMap[dashId].push({
                phase: (e.phase as string) || 'unknown',
                detail: (e.detail as Record<string, unknown>) || {},
              });
            }
          }
          if (e.type === 'progress' && e.status !== 'in_progress') {
            const existingIdx = results.findIndex((r) => r.id === (e.dashboard_id as string));
            const entry: MigrationResult = {
              id: (e.dashboard_id as string) || '',
              name: (e.dashboard_name as string) || '',
              status: e.status === 'success' ? 'ready' : (e.status as MigrationResult['status']),
              error: e.error as string | undefined,
              warnings: Array.isArray(e.warnings) ? (e.warnings as string[]) : undefined,
            };
            if (existingIdx >= 0) {
              results[existingIdx] = entry;
            } else {
              results.push(entry);
            }
          }
          if (e.type === 'complete' && e.results) {
            const final = e.results as Array<Record<string, unknown>>;
            final.forEach((r, i) => {
              if (results[i]) {
                results[i].sourceModel = r.source_model as string;
                results[i].targetModel = r.target_model as string;
              }
            });
          }
        }
      );
      setDryRunResults(results);
      setDiagnostics(diagMap);
      const idsNeedingReview = results
        .filter((result) => result.status === 'warning' || result.status === 'failed' || result.status === 'skipped')
        .map((result) => result.id)
        .filter(Boolean);
      if (idsNeedingReview.length > 0) {
        setExpandedDiag(new Set(idsNeedingReview));
      }
      const allMigratable = results.length > 0 && results.every((r) => r.status === 'ready' || r.status === 'warning');
      if (allMigratable) {
        dispatch({ type: 'SET_DRY_RUN_COMPLETED', value: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Compatibility preflight failed. Check your credentials and try again.';
      setDryRunError(msg);
    }

    setDryRunAttempted(true);
    setRunningDryRun(false);
  }

  function handleExecute() {
    dispatch({ type: 'START_MIGRATION' });
    dispatch({ type: 'SET_STEP', step: 3 });

    migrate(
      {
        source: { base_url: state.source.baseUrl, api_key: state.source.apiKey },
        target: { base_url: targetConn.baseUrl, api_key: targetConn.apiKey },
        dashboards: state.selectedDashboards.map((d) => ({
          id: d.id,
          name: d.name,
          base_model_id: d.baseModelId,
        })),
        model_mapping: state.modelMappings,
        target_folder: targetFolder,
        dry_run: false,
        in_place: state.sameInstance,
      },
      (event) => {
        const e = event as Record<string, unknown>;
        if (e.type === 'progress') {
          dispatch({
            type: 'UPDATE_MIGRATION_PROGRESS',
            index: e.index as number,
            result: {
              id: (e.dashboard_id as string) || '',
              name: (e.dashboard_name as string) || '',
              status: e.status as MigrationResult['status'],
              error: e.error as string | undefined,
              warnings: Array.isArray(e.warnings) ? (e.warnings as string[]) : undefined,
            },
          });
        }
        if (e.type === 'complete') {
          const summary = e.summary as { succeeded: number; failed: number; skipped: number; total: number };
          const results = (e.results as Array<Record<string, unknown>>).map((r) => ({
            id: r.id as string,
            name: r.name as string,
            status: r.status as MigrationResult['status'],
            error: r.error as string | undefined,
            warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : undefined,
            sourceModel: r.source_model as string,
            targetModel: r.target_model as string,
          }));
          dispatch({ type: 'COMPLETE_MIGRATION', summary, results });
        }
      }
    ).catch(() => {
      dispatch({
        type: 'COMPLETE_MIGRATION',
        summary: { succeeded: 0, failed: state.selectedDashboards.length, skipped: 0, total: state.selectedDashboards.length },
        results: state.selectedDashboards.map((d) => ({
          id: d.id,
          name: d.name,
          status: 'failed' as const,
          error: 'Migration request failed.',
        })),
      });
    });
  }

  function getDryRunStatus(docId: string): MigrationResult | undefined {
    return dryRunResults?.find((r) => r.id === docId);
  }

  function getEffectiveTargetModel(docBaseModelId: string | undefined): string {
    if (docBaseModelId && state.modelMappings[docBaseModelId]) {
      return state.modelMappings[docBaseModelId];
    }
    const targets = [...new Set(
      Object.values(state.modelMappings).filter(Boolean)
    )];
    return targets.length > 0 ? targets[0] : '';
  }

  const resolveTargetName = useCallback((modelId: string): string => {
    if (!modelId) return '';
    const match = state.targetModels.find(
      (m) => m.id === modelId || m.identifier === modelId
    );
    if (!match) return modelId;
    const hasName = match.name && match.name !== match.id && match.name !== match.identifier;
    const namePart = hasName ? match.name : match.identifier || match.id;
    return match.connectionName
      ? `${match.connectionName} - ${namePart}`
      : namePart;
  }, [state.targetModels]);

  const enrichedNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of state.selectedDashboards) {
      if (d.baseModelId && d.baseModelName) {
        map[d.baseModelId] = d.baseModelName;
      }
    }
    return map;
  }, [state.selectedDashboards]);

  const resolveSourceName = useCallback((modelId: string): string | null => {
    if (!modelId) return null;
    if (enrichedNameMap[modelId]) return enrichedNameMap[modelId];
    const match = state.sourceModels.find(
      (m) => m.id === modelId || m.identifier === modelId
    );
    return match?.name || null;
  }, [state.sourceModels, enrichedNameMap]);

  const showPreflightWarning = !state.dryRunCompleted && !dryRunAttempted;
  const hasPreflightWarnings = dryRunResults?.some((r) => r.status === 'warning') ?? false;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold text-content-primary">Review & Confirm</h2>
        <p className="text-sm text-content-secondary mt-1">
          {state.sameInstance
            ? 'Review your model remap before applying it. Dashboards will not be duplicated — only their model linkage will be updated.'
            : 'Review your cross-instance dashboard copy and run compatibility preflight before executing.'}
        </p>
      </div>

      <div className="card bg-surface-secondary">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-xs text-content-secondary uppercase tracking-wider mb-1">Source</div>
            <div className="font-medium text-content-primary truncate">{state.source.baseUrl.replace(/https?:\/\//, '')}</div>
          </div>
          <div className="flex items-center justify-center">
            <ArrowRight size={18} className="text-content-secondary" />
          </div>
          <div>
            <div className="text-xs text-content-secondary uppercase tracking-wider mb-1">Target</div>
            <div className="font-medium text-content-primary truncate">
              {state.sameInstance ? 'Same instance' : targetConn.baseUrl.replace(/https?:\/\//, '')}
            </div>
          </div>
        </div>
        <div className="flex gap-6 mt-4 pt-4 border-t border-border text-sm">
          <div>
            <span className="text-content-secondary">Dashboards:</span>{' '}
            <span className="font-medium">{state.selectedDashboards.length}</span>
          </div>
          {!state.sameInstance && (
            <div>
              <span className="text-content-secondary">Target folder:</span>{' '}
              <span className="font-medium">{targetFolder || 'Default import location'}</span>
            </div>
          )}
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
          <div className="col-span-4 text-xs font-medium text-content-secondary uppercase tracking-wider">Dashboard</div>
          <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Source Model</div>
          <div className="col-span-1 text-xs font-medium text-content-secondary uppercase tracking-wider text-center" />
          <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Target Model</div>
          <div className="col-span-1 text-xs font-medium text-content-secondary uppercase tracking-wider text-right">Preflight</div>
        </div>

        <div className="max-h-[300px] overflow-y-auto">
          {state.selectedDashboards.map((doc) => {
            const targetModel = getEffectiveTargetModel(doc.baseModelId);
            const dryResult = getDryRunStatus(doc.id);
            const preflightDetail = preflightFromDiagnostics(diagnostics[doc.id]);
            const severity = preflightSeverity(dryResult, preflightDetail);
            const hasReviewDetails = Boolean(
              diagnostics[doc.id]?.length ||
              dryResult?.error ||
              dryResult?.warnings?.length
            );

            return (
              <div key={doc.id}>
                <div className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-4 text-sm text-content-primary truncate">{doc.name}</div>
                  <div className="col-span-3 text-xs truncate" title={doc.baseModelId}>
                    {doc.baseModelId ? (
                      <>
                        <div className="text-content-primary truncate">
                          {resolveSourceName(doc.baseModelId) || doc.baseModelId}
                        </div>
                        {resolveSourceName(doc.baseModelId) && (
                          <div className="text-[10px] text-content-secondary/50 font-mono truncate">
                            {doc.baseModelId}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-warning italic">Model not detected</span>
                    )}
                  </div>
                  <div className="col-span-1 flex justify-center">
                    <ArrowRight size={14} className="text-content-secondary" />
                  </div>
                  <div className="col-span-3 text-xs truncate" title={targetModel}>
                    {targetModel ? (
                      <>
                        <div className="text-content-primary truncate">
                          {resolveTargetName(targetModel)}
                        </div>
                        {resolveTargetName(targetModel) !== targetModel && (
                          <div className="text-[10px] text-content-secondary/50 font-mono truncate">
                            {targetModel}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-warning italic">Not mapped</span>
                    )}
                  </div>
                  <div className="col-span-1 flex justify-end items-center gap-1">
                    {dryResult ? (
                      <StatusChip status={dryResult.status} />
                    ) : (
                      <StatusChip status="pending" label="Pending" />
                    )}
                    {hasReviewDetails && (
                      <button
                        onClick={() => {
                          setExpandedDiag((prev) => {
                            const next = new Set(prev);
                            if (next.has(doc.id)) next.delete(doc.id);
                            else next.add(doc.id);
                            return next;
                          });
                        }}
                        className="p-0.5 rounded hover:bg-surface-secondary transition-colors text-content-secondary"
                        title="Toggle preflight details"
                      >
                        {expandedDiag.has(doc.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}
                  </div>
                </div>
                {expandedDiag.has(doc.id) && hasReviewDetails && (
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-border/50">
                    <div className="rounded-card border border-border bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-content-primary">Preflight details</div>
                          <p className="mt-1 text-[11px] leading-relaxed text-content-secondary">{severity.text}</p>
                        </div>
                        <StatusChip status={severity.status} label={severity.label} />
                      </div>

                      {preflightDetail && (
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
                          <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Referenced fields</div>
                            <div className="mt-1 text-lg font-semibold text-content-primary">{preflightDetail.referencedFieldCount ?? '-'}</div>
                          </div>
                          <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Matched fields</div>
                            <div className="mt-1 text-lg font-semibold text-content-primary">{preflightDetail.matchedFieldCount ?? '-'}</div>
                          </div>
                          <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Target fields scanned</div>
                            <div className="mt-1 text-lg font-semibold text-content-primary">{preflightDetail.targetFieldCount ?? '-'}</div>
                          </div>
                        </div>
                      )}

                      {(dryResult?.error || dryResult?.warnings?.length || preflightDetail?.warnings.length) && (
                        <div className="mt-3 rounded-button border border-amber-200 bg-amber-50 px-3 py-2">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">Review notes</div>
                          <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-amber-800">
                            {dryResult?.error && <li>{dryResult.error}</li>}
                            {(dryResult?.warnings || []).map((warning, idx) => <li key={`dry-${idx}`}>{warning}</li>)}
                            {(preflightDetail?.warnings || []).map((warning, idx) => <li key={`pre-${idx}`}>{warning}</li>)}
                          </ul>
                        </div>
                      )}

                      {preflightDetail && preflightDetail.missingFields.length > 0 && (
                        <div className="mt-3 rounded-button border border-red-200 bg-red-50 px-3 py-2">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-red-800">Missing fields by view</div>
                          <div className="mt-2 space-y-2">
                            {groupFieldsByView(preflightDetail.missingFields).map((group) => (
                              <div key={group.view}>
                                <div className="text-[11px] font-semibold text-red-900">{group.view}</div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {group.fields.map((field) => (
                                    <span key={field} className="rounded-chip bg-white px-2 py-0.5 font-mono text-[10px] text-red-700">
                                      {field}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {diagnostics[doc.id] && diagnostics[doc.id].length > 0 && (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-[11px] font-semibold text-content-secondary hover:text-content-primary">
                            Technical diagnostics
                          </summary>
                          <div className="mt-2 space-y-2">
                            {diagnostics[doc.id].map((d, idx) => (
                              <div key={idx}>
                                <div className="text-[10px] font-semibold text-content-secondary uppercase tracking-wider mb-1">
                                  {d.phase === 'post_export' ? 'After Export' : d.phase === 'post_transform' ? 'After Transform' : d.phase === 'compatibility_preflight' ? 'Compatibility Preflight' : d.phase}
                                </div>
                                <div className="font-mono text-[11px] text-content-primary bg-surface-secondary rounded border border-border/50 p-2 overflow-x-auto">
                                  {Object.entries(d.detail).map(([key, val]) => (
                                    <div key={key} className="flex gap-2">
                                      <span className="text-content-secondary flex-shrink-0">{key}:</span>
                                      <span className="break-all">
                                        {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {dryRunError && (
        <div className="flex items-start gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-card">
          <XCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-medium text-red-800">Compatibility preflight failed</p>
            <p className="text-xs text-red-700 mt-0.5 leading-relaxed">{dryRunError}</p>
          </div>
        </div>
      )}

      {dryRunAttempted && !dryRunError && dryRunResults !== null && dryRunResults.length === 0 && (
        <div className="flex items-start gap-2 px-4 py-3 bg-slate-50 border border-slate-200 rounded-card">
          <AlertTriangle size={16} className="text-slate-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-slate-700 leading-relaxed">
            Compatibility preflight returned no results. The migration service may be unavailable or no dashboards were processed.
          </p>
        </div>
      )}

      {dryRunAttempted && !dryRunError && dryRunResults !== null && dryRunResults.length > 0 && (() => {
        const readyCount = dryRunResults.filter(r => r.status === 'ready').length;
        const warningResults = dryRunResults.filter(r => r.status === 'warning');
        const failedResults = dryRunResults.filter(r => r.status === 'failed' || r.status === 'skipped');
        const allMigratable = failedResults.length === 0;

        return (
          <>
            <div className={`flex items-start gap-2 px-4 py-3 rounded-card ${
              allMigratable && warningResults.length === 0
                ? 'bg-green-50 border border-green-200'
                : 'bg-amber-50 border border-amber-200'
            }`}>
              {allMigratable && warningResults.length === 0 ? (
                <CheckCircle2 size={16} className="text-green-600 mt-0.5 flex-shrink-0" />
              ) : (
                <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
              )}
              <div>
                <p className={`text-xs leading-relaxed ${allMigratable && warningResults.length === 0 ? 'text-green-800' : 'text-amber-800'}`}>
                  Compatibility preflight completed -- {readyCount} ready, {warningResults.length} with warning{warningResults.length !== 1 ? 's' : ''}, {failedResults.length} blocked.
                  {allMigratable && warningResults.length > 0 && ` You can continue after reviewing the warning details.`}
                  {failedResults.length > 0 && ` Blocked dashboards will be skipped due to errors.`}
                </p>
                {warningResults.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {warningResults.map((r) => (
                      <li key={r.id} className="text-xs text-amber-700 flex items-start gap-1.5">
                        <AlertTriangle size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
                        <span><span className="font-medium">{r.name}</span>: {r.error || r.warnings?.join(' ') || 'Semantic compatibility warning.'}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {failedResults.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {failedResults.map((r) => (
                      <li key={r.id} className="text-xs text-amber-700 flex items-start gap-1.5">
                        <XCircle size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
                        <span><span className="font-medium">{r.name}</span>: {r.error || 'Unknown error'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        );
      })()}

      <div className="flex items-start gap-2 px-4 py-3 bg-yellow-50 border border-yellow-200 rounded-card">
        <AlertTriangle size={16} className="text-yellow-600 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-yellow-800 leading-relaxed">
          {state.sameInstance
            ? 'This changes the model attached to each selected dashboard in the current Omni instance. Compatibility preflight checks payload shape and target field presence, but it cannot prove that same-named metrics have identical business definitions.'
            : 'Importing creates new copies in the target; originals are not modified or deleted. Compatibility preflight checks payload shape and target field presence, but it cannot prove that same-named metrics have identical business definitions.'}
        </p>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} disabled={runningDryRun} className="btn-secondary">
          Back
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={handleDryRun}
            disabled={runningDryRun}
            className="btn-secondary text-sm"
          >
            {runningDryRun ? (
              <>
                <span className="w-4 h-4 border-2 border-omni-700 border-t-transparent rounded-full animate-spin" />
                Checking...
              </>
            ) : (
              <>
                <Play size={14} />
                Run Compatibility Preflight
              </>
            )}
          </button>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={runningDryRun}
            className="btn-primary text-sm"
          >
            <Zap size={14} />
            {state.sameInstance ? 'Apply Model Remap' : 'Copy Dashboards'}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={showConfirm}
        title={state.sameInstance ? 'Confirm Model Remap' : 'Confirm Dashboard Copy'}
        message={
          showPreflightWarning
            ? state.sameInstance
              ? `You are about to change the model attached to ${state.selectedDashboards.length} dashboard${state.selectedDashboards.length !== 1 ? 's' : ''} without running compatibility preflight first. We recommend running preflight to check payload and field compatibility. Continue anyway?`
              : `You are about to copy ${state.selectedDashboards.length} dashboard${state.selectedDashboards.length !== 1 ? 's' : ''} into another Omni instance without running compatibility preflight first. We recommend running preflight to check payload and field compatibility. Continue anyway?`
            : hasPreflightWarnings
              ? `Compatibility preflight found warnings. You can continue, but review the impacted dashboards in Omni after ${state.sameInstance ? 'the model remap' : 'the dashboard copy'} and expect possible tile or filter cleanup. Continue?`
            : state.sameInstance
              ? `You are about to change the model attached to ${state.selectedDashboards.length} dashboard${state.selectedDashboards.length !== 1 ? 's' : ''}. No dashboard copy will be created. Continue?`
              : `You are about to copy ${state.selectedDashboards.length} dashboard${state.selectedDashboards.length !== 1 ? 's' : ''} into the target instance. Originals are not modified or deleted. Continue?`
        }
        confirmLabel={state.sameInstance ? 'Apply Model Remap' : 'Copy Dashboards'}
        cancelLabel="Cancel"
        variant={showPreflightWarning ? 'danger' : 'primary'}
        onConfirm={() => {
          setShowConfirm(false);
          handleExecute();
        }}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
