import { useState, useEffect, useMemo, useCallback } from 'react';
import { ArrowRight, AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { listModels } from '@/services/omniApi';
import { ComboBox } from '@/components/ui/ComboBox';
import { StatusChip } from '@/components/ui/StatusChip';
import { modelDisplayLabel, sortModels } from '../../utils/catalogSort';
import type { OmniModel } from '@/types';
import type { WizardState, WizardAction } from '@/types';

interface MapStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onNext: () => void;
  onBack: () => void;
}

type CompatibilityLevel = 'likely' | 'partial' | 'weak';

interface CompatibilityHint {
  level: CompatibilityLevel;
  score: number;
  reasons: string[];
}

const compatibilityStyles: Record<CompatibilityLevel, { label: string; status: string; tone: string }> = {
  likely: { label: 'Likely match', status: 'ready', tone: 'text-green-700' },
  partial: { label: 'Partial match', status: 'warning', tone: 'text-amber-700' },
  weak: { label: 'Poor match', status: 'failed', tone: 'text-red-700' },
};

function normalizeTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !['model', 'demo', 'shared', 'new'].includes(token));
}

function modelDisplayName(model: OmniModel): string {
  return modelDisplayLabel(model);
}

export function MapStep({ state, dispatch, onNext, onBack }: MapStepProps) {
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState('');

  const mappingGroups = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of state.selectedDashboards) {
      const key = d.baseModelId || '__unresolved__';
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).map(([key, count]) => ({ key, count }));
  }, [state.selectedDashboards]);

  useEffect(() => {
    if (state.targetModels.length > 0) return;
    async function fetchModels() {
      setLoadingModels(true);
      setError('');
      try {
        const targetConn = state.sameInstance ? state.source : state.target;
        const [targetRes, sourceRes] = await Promise.all([
          listModels(targetConn.baseUrl, targetConn.apiKey, { modelKind: 'SHARED', allPages: true, pageSize: 100 }),
          state.sourceModels.length === 0
            ? listModels(state.source.baseUrl, state.source.apiKey, { modelKind: 'SHARED', allPages: true, pageSize: 100 })
            : Promise.resolve(null),
        ]);

        if (targetRes.error) {
          setError(`Failed to load target models: ${targetRes.error}${targetRes.detail ? ` — ${targetRes.detail}` : ''}`);
          return;
        }

        const models = Array.isArray(targetRes.models) ? targetRes.models : [];
        dispatch({ type: 'SET_TARGET_MODELS', models });

        if (sourceRes && !sourceRes.error) {
          const srcModels = Array.isArray(sourceRes.models) ? sourceRes.models : [];
          dispatch({ type: 'SET_SOURCE_MODELS', models: srcModels });
        }
      } catch (err) {
        setError(`Failed to load models: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        setLoadingModels(false);
      }
    }
    fetchModels();
  }, [state.source, state.target, state.sameInstance, state.targetModels.length, state.sourceModels.length, dispatch]);

  function handleTargetChange(groupKey: string, newTargetId: string) {
    dispatch({ type: 'SET_MODEL_MAPPING', sourceId: groupKey, targetId: newTargetId });
  }

  const enrichedNameMap = useMemo(() => {
    const map: Record<string, { name: string; topicNames?: string[] }> = {};
    for (const d of state.selectedDashboards) {
      if (d.baseModelId && d.baseModelName) {
        map[d.baseModelId] = {
          name: d.baseModelName,
          topicNames: d.topicNames,
        };
      }
    }
    return map;
  }, [state.selectedDashboards]);

  const targetOptions = useMemo(() => {
    return sortModels(state.targetModels).map((m) => {
      const id = m.id || m.identifier || '';
      return {
        value: id,
        label: modelDisplayLabel(m),
        subtitle: m.kind || undefined,
      };
    });
  }, [state.targetModels]);

  const allMapped = mappingGroups.every(({ key }) => {
    const target = state.modelMappings[key];
    return !!target && target.length > 0;
  });

  const sourceHost = state.source.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const targetHost = (state.sameInstance ? state.source.baseUrl : state.target.baseUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const resolveSourceName = useCallback((modelId: string): string | null => {
    if (!modelId) return null;
    if (enrichedNameMap[modelId]?.name) return enrichedNameMap[modelId].name;
    const match = state.sourceModels.find(
      (m) => m.id === modelId || m.identifier === modelId
    );
    return match?.name || null;
  }, [state.sourceModels, enrichedNameMap]);

  const scoreCompatibility = useCallback((sourceModelId: string, targetModel: OmniModel): CompatibilityHint => {
    const sourceName = resolveSourceName(sourceModelId) || sourceModelId;
    const topics = enrichedNameMap[sourceModelId]?.topicNames || [];
    const targetName = modelDisplayName(targetModel);
    const sourceTokens = new Set([
      ...normalizeTokens(sourceName),
      ...topics.flatMap((topic) => normalizeTokens(topic)),
    ]);
    const targetTokens = new Set([
      ...normalizeTokens(targetName),
      ...normalizeTokens(targetModel.identifier),
      ...normalizeTokens(targetModel.connectionName),
    ]);
    const overlap = [...sourceTokens].filter((token) => targetTokens.has(token));
    const exactName = sourceName.toLowerCase() === targetName.toLowerCase();
    const sameId = Boolean(sourceModelId && (targetModel.id === sourceModelId || targetModel.identifier === sourceModelId));
    const score = Math.min(100, (sameId ? 100 : 0) + (exactName ? 75 : 0) + overlap.length * 25);
    const reasons = [
      sameId ? 'same model id' : '',
      exactName ? 'same model name' : '',
      overlap.length > 0 ? `name/topic overlap: ${overlap.slice(0, 3).join(', ')}` : '',
    ].filter(Boolean);

    if (score >= 75) return { level: 'likely', score, reasons: reasons.length ? reasons : ['strong metadata match'] };
    if (score >= 25) return { level: 'partial', score, reasons: reasons.length ? reasons : ['some metadata overlap'] };
    return { level: 'weak', score, reasons: ['no obvious model or topic-name overlap'] };
  }, [enrichedNameMap, resolveSourceName]);

  const bestHintsBySource = useMemo(() => {
    const out: Record<string, Array<{ model: OmniModel; hint: CompatibilityHint }>> = {};
    for (const { key } of mappingGroups) {
      if (key === '__unresolved__') continue;
      out[key] = state.targetModels
        .map((model) => ({ model, hint: scoreCompatibility(key, model) }))
        .sort((a, b) => b.hint.score - a.hint.score)
        .slice(0, 3);
    }
    return out;
  }, [mappingGroups, scoreCompatibility, state.targetModels]);

  const selectedHintFor = useCallback((sourceModelId: string, targetModelId: string): CompatibilityHint | null => {
    const targetModel = state.targetModels.find((model) => model.id === targetModelId || model.identifier === targetModelId);
    if (!targetModel || sourceModelId === '__unresolved__') return null;
    return scoreCompatibility(sourceModelId, targetModel);
  }, [scoreCompatibility, state.targetModels]);

  const weakOnlyTarget = !loadingModels && state.targetModels.length > 0 && mappingGroups
    .filter(({ key }) => key !== '__unresolved__')
    .every(({ key }) => (bestHintsBySource[key]?.[0]?.hint.level || 'weak') === 'weak');

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold text-content-primary">Map Models</h2>
        <p className="text-sm text-content-secondary mt-1">
          Each source model is pre-filled from your selected dashboards. Choose the target model to map each one to.
        </p>
      </div>

      <div className="rounded-card border border-omni-100 bg-omni-50 px-4 py-3">
        <div className="flex items-start gap-2">
          <ShieldCheck size={16} className="mt-0.5 flex-shrink-0 text-omni-700" />
          <div>
            <p className="text-sm font-semibold text-omni-800">
              {state.sameInstance ? 'Same-instance model / connection remap' : 'Cross-instance dashboard copy'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-omni-700">
              Active connection is the source: <span className="font-mono">{sourceHost || 'current instance'}</span>.
              {' '}Target is <span className="font-mono">{state.sameInstance ? sourceHost || 'current instance' : targetHost || 'tested instance'}</span>.
              {' '}Compatibility hints below are metadata-based; Compatibility Preflight is the field-level check before any write.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">
          {error}
        </div>
      )}

      {!loadingModels && !error && state.targetModels.length === 0 && (
        <div className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-700" />
            <div>
              <p className="text-sm font-semibold text-amber-900">No target shared models found</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-800">
                This target instance can be reached, but OmniKit did not find a shared model to map these dashboards to.
                Create or import a compatible model first, then return here and rerun the mapping step.
              </p>
            </div>
          </div>
        </div>
      )}

      {weakOnlyTarget && (
        <div className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-700" />
            <p className="text-xs leading-relaxed text-amber-800">
              Target models loaded, but none look like a close metadata match for the selected dashboard model.
              You can still map one manually, but expect Compatibility Preflight to flag missing fields or filters if the semantic layer is not aligned.
            </p>
          </div>
        </div>
      )}

      {loadingModels ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
          <span className="ml-3 text-sm text-content-secondary">Loading models...</span>
        </div>
      ) : (
        <div className="card p-0">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-4 rounded-t-card">
            <div className="col-span-5 text-xs font-medium text-content-secondary uppercase tracking-wider">
              Source Model
            </div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider text-center">
              Dashboards
            </div>
            <div className="col-span-1" />
            <div className="col-span-4 text-xs font-medium text-content-secondary uppercase tracking-wider">
              Target Model
            </div>
          </div>

          {mappingGroups.map(({ key, count }) => {
            const targetValue = state.modelMappings[key] || '';
            const isMapped = !!targetValue;
            const isUnresolved = key === '__unresolved__';
            const selectedHint = selectedHintFor(key, targetValue);
            const bestHints = bestHintsBySource[key] || [];

            return (
              <div
                key={key}
                className="px-4 py-4 border-b border-border/50 last:border-b-0 grid grid-cols-12 gap-4 items-center"
              >
                <div className="col-span-5">
                  {isUnresolved ? (
                    <div
                      className="px-3 py-2 rounded-button border text-sm truncate bg-yellow-50 border-yellow-200 text-yellow-700 italic"
                      title="These dashboards have no model ID set"
                    >
                      Unknown model
                    </div>
                  ) : (
                    <div
                      className="px-3 py-2 rounded-button border text-sm bg-surface-secondary border-border"
                      title={key}
                    >
                      <div className="text-content-primary truncate">
                        {resolveSourceName(key) || key}
                      </div>
                      {resolveSourceName(key) && (
                        <div className="text-[10px] text-content-secondary/50 font-mono truncate mt-0.5">
                          {key}
                        </div>
                      )}
                      {enrichedNameMap[key]?.topicNames && enrichedNameMap[key].topicNames!.length > 0 && (
                        <div className="text-[10px] text-content-secondary/70 truncate mt-0.5">
                          {enrichedNameMap[key].topicNames!.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="col-span-2 text-center">
                  <span className="bg-surface-secondary text-content-secondary text-xs font-medium px-2 py-0.5 rounded-chip">
                    {count}
                  </span>
                </div>
                <div className="col-span-1 flex justify-center">
                  <ArrowRight size={16} className="text-content-secondary" />
                </div>
                <div className="col-span-4 flex items-start gap-2">
                  <div className="flex-1">
                    <ComboBox
                      options={targetOptions}
                      value={targetValue}
                      onChange={(val) => handleTargetChange(key, val)}
                      placeholder="Select target model..."
                      allowFreeText={false}
                      ariaLabel={`Target model for ${resolveSourceName(key) || key}`}
                    />
                    {!isUnresolved && bestHints.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">
                          Compatibility hint
                        </div>
                        {selectedHint ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusChip
                              status={compatibilityStyles[selectedHint.level].status}
                              label={compatibilityStyles[selectedHint.level].label}
                            />
                            <span className={`text-[11px] ${compatibilityStyles[selectedHint.level].tone}`}>
                              {selectedHint.reasons.join('; ')}
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {bestHints.map(({ model, hint }) => (
                              <span
                                key={model.id}
                                className="inline-flex max-w-full items-center gap-1 rounded-chip border border-border bg-white px-2 py-1 text-[10px] text-content-secondary"
                                title={hint.reasons.join('; ')}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${
                                  hint.level === 'likely' ? 'bg-green-500' : hint.level === 'partial' ? 'bg-amber-500' : 'bg-red-500'
                                }`} />
                                <span className="truncate">{modelDisplayName(model)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {!isMapped && (
                    <AlertTriangle size={16} className="text-warning flex-shrink-0 mt-2.5" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="btn-secondary">
          Back
        </button>
        <button onClick={onNext} disabled={!allMapped} className="btn-primary">
          Next
        </button>
      </div>
    </div>
  );
}
