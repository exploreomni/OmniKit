import { useState, useEffect, useMemo, useCallback } from 'react';
import { ArrowRight, AlertTriangle, Loader2 } from 'lucide-react';
import { listModels } from '@/services/omniApi';
import { ComboBox } from '@/components/ui/ComboBox';
import type { WizardState, WizardAction } from '@/types';

interface MapStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onNext: () => void;
  onBack: () => void;
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
    return state.targetModels.map((m) => {
      const id = m.id || m.identifier || '';
      const hasName = m.name && m.name !== m.id && m.name !== m.identifier;
      const namePart = hasName ? m.name : m.identifier || m.id;
      const label = m.connectionName
        ? `${m.connectionName} - ${namePart}`
        : namePart;
      return {
        value: id,
        label,
        subtitle: m.kind || undefined,
      };
    });
  }, [state.targetModels]);

  const allMapped = mappingGroups.every(({ key }) => {
    const target = state.modelMappings[key];
    return !!target && target.length > 0;
  });

  const resolveSourceName = useCallback((modelId: string): string | null => {
    if (!modelId) return null;
    if (enrichedNameMap[modelId]?.name) return enrichedNameMap[modelId].name;
    const match = state.sourceModels.find(
      (m) => m.id === modelId || m.identifier === modelId
    );
    return match?.name || null;
  }, [state.sourceModels, enrichedNameMap]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold text-content-primary">Map Models</h2>
        <p className="text-sm text-content-secondary mt-1">
          Each source model is pre-filled from your selected dashboards. Choose the target model to map each one to.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">
          {error}
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
                    />
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
