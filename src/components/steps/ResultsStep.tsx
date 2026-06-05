import { useState, useEffect, useCallback } from 'react';
import { Download, RefreshCw, ChevronDown, ChevronRight, CheckCircle, XCircle, Clock, Loader2, AlertTriangle } from 'lucide-react';
import { MigrationAnimation } from '@/components/ui/MigrationAnimation';
import { StatusChip } from '@/components/ui/StatusChip';
import type { WizardState, MigrationResult } from '@/types';

function statusIcon(status: MigrationResult['status']) {
  switch (status) {
    case 'success':
      return <CheckCircle size={16} className="text-success" />;
    case 'failed':
      return <XCircle size={16} className="text-error" />;
    case 'warning':
      return <AlertTriangle size={16} className="text-warning" />;
    case 'in_progress':
      return <Loader2 size={16} className="text-omni-500 animate-spin" />;
    case 'skipped':
      return <AlertTriangle size={16} className="text-warning" />;
    default:
      return <Clock size={16} className="text-gray-400" />;
  }
}

interface ResultsStepProps {
  state: WizardState;
  onReset: () => void;
}

export function ResultsStep({ state, onReset }: ResultsStepProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const resolveTargetName = useCallback((modelId: string | undefined): string => {
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

  const inProgress = state.migrationInProgress;
  const completed = !inProgress && state.migrationSummary !== null;
  const currentIndex = state.migrationResults.filter(
    (r) => r.status !== 'pending'
  ).length;
  const total = state.migrationResults.length;
  const hasFailures = (state.migrationSummary?.failed ?? 0) > 0;
  const currentItemName = state.migrationResults.find((r) => r.status === 'in_progress')?.name;
  const operationLabel = state.sameInstance ? 'Model Remap' : 'Dashboard Copy';
  const operationLabelLower = state.sameInstance ? 'model remap' : 'dashboard copy';

  function hostnameFromUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  useEffect(() => {
    if (!completed) return;
    const failedIds = state.migrationResults
      .filter((r) => r.error)
      .map((r) => r.id);
    if (failedIds.length > 0) {
      setExpandedIds(new Set(failedIds));
    }
  }, [completed, state.migrationResults]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDownload() {
    const log = {
      timestamp: new Date().toISOString(),
      sourceUrl: state.source.baseUrl,
      targetUrl: state.sameInstance ? state.source.baseUrl : state.target.baseUrl,
      targetFolder: state.targetFolder || null,
      dryRun: false,
      summary: state.migrationSummary,
      modelMappings: state.modelMappings,
      results: state.migrationResults.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        error: r.error || null,
        sourceModel: r.sourceModel || null,
        targetModel: r.targetModel || null,
      })),
    };

    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.sameInstance ? 'model-remap' : 'dashboard-copy'}-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      {!completed && (
        <div>
          <h2 className="text-2xl font-semibold text-content-primary">
            {operationLabel} In Progress
          </h2>
          <p className="text-sm text-content-secondary mt-1">
            Your dashboards are being {state.sameInstance ? 'remapped' : 'copied into the target instance'}. Do not close this tab.
          </p>
        </div>
      )}

      {(inProgress || completed) && (
        <MigrationAnimation
          current={currentIndex}
          total={total}
          completed={completed}
          hasFailures={hasFailures}
          mode={state.sameInstance ? 'remap' : 'migration'}
          currentItem={currentItemName}
          sourceHost={hostnameFromUrl(state.source.baseUrl)}
          targetHost={hostnameFromUrl(state.sameInstance ? state.source.baseUrl : state.target.baseUrl)}
        />
      )}

      {completed && state.migrationSummary && (
        <div className="card bg-surface-secondary animate-fadeIn">
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <CheckCircle size={18} className="text-success" />
              <span className="font-medium">{state.migrationSummary.succeeded} succeeded</span>
            </div>
            {state.migrationSummary.failed > 0 && (
              <div className="flex items-center gap-2">
                <XCircle size={18} className="text-error" />
                <span className="font-medium">{state.migrationSummary.failed} failed</span>
              </div>
            )}
            {state.migrationSummary.skipped > 0 && (
              <div className="flex items-center gap-2">
                <AlertTriangle size={18} className="text-warning" />
                <span className="font-medium">{state.migrationSummary.skipped} skipped</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
          <div className="col-span-1" />
          <div className="col-span-4 text-xs font-medium text-content-secondary uppercase tracking-wider">Dashboard</div>
          <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Target Model</div>
          <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Status</div>
          <div className="col-span-2" />
        </div>

        <div className="max-h-[360px] overflow-y-auto">
          {state.migrationResults.map((result) => {
            const isExpanded = expandedIds.has(result.id);
            const hasDetail = Boolean(result.error);

            return (
              <div key={result.id} className="animate-fadeIn">
                <div
                  className={`px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center transition-colors duration-300 ${
                    result.status === 'success' ? 'bg-green-50/30' :
                    result.status === 'failed' ? 'bg-red-50/30' :
                    result.status === 'warning' ? 'bg-amber-50/30' :
                    result.status === 'in_progress' ? 'bg-blue-50/30' :
                    ''
                  }`}
                >
                  <div className="col-span-1 flex items-center">
                    {statusIcon(result.status)}
                  </div>
                  <div className="col-span-4 text-sm text-content-primary truncate">{result.name}</div>
                  <div className="col-span-3 text-xs truncate" title={result.targetModel}>
                    {result.targetModel ? (
                      <>
                        <div className="text-content-primary truncate">
                          {resolveTargetName(result.targetModel)}
                        </div>
                        {resolveTargetName(result.targetModel) !== result.targetModel && (
                          <div className="text-[10px] text-content-secondary/50 font-mono truncate">
                            {result.targetModel}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-warning italic">Unknown</span>
                    )}
                  </div>
                  <div className="col-span-2">
                    <StatusChip status={result.status} />
                  </div>
                  <div className="col-span-2 flex justify-end">
                    {hasDetail && (
                      <button
                        onClick={() => toggleExpand(result.id)}
                        className="text-content-secondary hover:text-content-primary transition-colors flex items-center gap-1 text-xs"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Details
                      </button>
                    )}
                  </div>
                </div>

                {isExpanded && hasDetail && (
                  <div className={`px-4 py-3 border-b border-border/50 ${result.status === 'failed' ? 'bg-red-50' : 'bg-amber-50'}`}>
                    <p className={`text-xs font-mono whitespace-pre-wrap ${result.status === 'failed' ? 'text-red-700' : 'text-amber-800'}`}>{result.error}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {completed && (
        <>
          <div className="flex items-center gap-3 pt-2">
            <button onClick={handleDownload} className="btn-secondary text-sm">
              <Download size={14} />
              Download Log (JSON)
            </button>
            <button onClick={onReset} className="btn-primary text-sm">
              <RefreshCw size={14} />
              Start New {operationLabel}
            </button>
          </div>

          <div className="flex items-start gap-2 px-4 py-3 bg-yellow-50 border border-yellow-200 rounded-card">
            <AlertTriangle size={14} className="text-yellow-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-yellow-800 leading-relaxed">
              Closing this tab will discard all {operationLabelLower} results and credentials. Download your log first if needed.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
