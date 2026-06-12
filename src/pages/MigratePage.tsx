import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Stepper } from '@/components/layout/Stepper';
import { SelectStep } from '@/components/steps/SelectStep';
import { MapStep } from '@/components/steps/MapStep';
import { ReviewStep } from '@/components/steps/ReviewStep';
import { ResultsStep } from '@/components/steps/ResultsStep';
import { FanOutWizard } from '@/components/migrateFanout/FanOutWizard';
import { useWizard } from '@/hooks/useWizard';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { RequireConnection } from '@/components/layout/RequireConnection';

export function MigratePage() {
  const { state, dispatch, nextStep, prevStep, resetAll } = useWizard();
  const { connection, isConnected } = useConnection();
  const navigate = useNavigate();
  const location = useLocation();
  const mode = new URLSearchParams(location.search).get('mode') === 'copy' ? 'copy' : 'remap';

  useEffect(() => {
    if (!isConnected) return;
    if (
      state.source.baseUrl === connection.baseUrl &&
      state.source.apiKey === connection.apiKey &&
      state.source.status === 'success'
    ) {
      return;
    }
    dispatch({
      type: 'UPDATE_SOURCE',
      payload: {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        status: 'success',
        errorMessage: '',
      },
    });
  }, [
    isConnected,
    connection.baseUrl,
    connection.apiKey,
    state.source.baseUrl,
    state.source.apiKey,
    state.source.status,
    dispatch,
  ]);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (state.migrationInProgress || state.selectedDashboards.length > 0) {
        e.preventDefault();
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [state.migrationInProgress, state.selectedDashboards.length]);

  function renderStep() {
    switch (state.currentStep) {
      case 0:
        return <SelectStep state={state} dispatch={dispatch} onNext={nextStep} onBack={() => navigate('/connect')} />;
      case 1:
        return <MapStep state={state} dispatch={dispatch} onNext={nextStep} onBack={prevStep} />;
      case 2:
        return <ReviewStep state={state} dispatch={dispatch} onBack={prevStep} />;
      case 3:
        return <ResultsStep state={state} onReset={resetAll} />;
      default:
        return null;
    }
  }

  if (mode === 'remap' && !isConnected) {
    return (
      <RequireConnection>
        <div />
      </RequireConnection>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Model Migrator"
        description="Pick the migration path first: remap dashboards inside the active instance, or fan out selected dashboards from one saved source to many saved destination instances."
        icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
      />
      <div className="card p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-content-primary">Where are you migrating to?</h2>
          <p className="mt-1 text-sm text-content-secondary">
            Same-instance remap uses the active Connect session. Fan-out copy/import uses saved profiles from the native encrypted vault.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() => navigate('/dashboards/migrate')}
            className={`rounded-button px-4 py-4 text-left transition ${
              mode === 'remap' ? 'bg-omni-600 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
            }`}
          >
            <div className="text-sm font-semibold">Within this instance</div>
            <div className={`mt-1 text-xs ${mode === 'remap' ? 'text-white/80' : 'text-content-secondary'}`}>
              Remap selected dashboards from one model to another inside the connected Omni instance.
            </div>
          </button>
          <button
            type="button"
            onClick={() => navigate('/dashboards/migrate?mode=copy')}
            className={`rounded-button px-4 py-4 text-left transition ${
              mode === 'copy' ? 'bg-omni-600 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
            }`}
          >
            <div className="text-sm font-semibold">To other saved instances</div>
            <div className={`mt-1 text-xs ${mode === 'copy' ? 'text-white/80' : 'text-content-secondary'}`}>
              Copy dashboards from one vault source into many destination instances, models, and folders.
            </div>
          </button>
        </div>
      </div>
      {mode === 'copy' ? (
        <FanOutWizard />
      ) : isConnected ? (
        <>
          <Stepper currentStep={state.currentStep} />
          <div className="pb-12">
            {renderStep()}
          </div>
        </>
      ) : null}
    </div>
  );
}
