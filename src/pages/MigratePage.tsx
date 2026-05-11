import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stepper } from '@/components/layout/Stepper';
import { SelectStep } from '@/components/steps/SelectStep';
import { MapStep } from '@/components/steps/MapStep';
import { ReviewStep } from '@/components/steps/ReviewStep';
import { ResultsStep } from '@/components/steps/ResultsStep';
import { useWizard } from '@/hooks/useWizard';
import { useConnection } from '@/contexts/ConnectionContext';

export function MigratePage() {
  const { state, dispatch, nextStep, prevStep, resetAll } = useWizard();
  const { connection, isConnected } = useConnection();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isConnected) return;
    dispatch({
      type: 'UPDATE_SOURCE',
      payload: {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        status: 'success',
        errorMessage: '',
      },
    });
  }, [isConnected, connection.baseUrl, connection.apiKey, dispatch]);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (state.migrationInProgress || state.selectedDashboards.length > 0) {
        e.preventDefault();
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [state.migrationInProgress, state.selectedDashboards.length]);

  if (!isConnected) {
    return (
      <div
        className="relative flex flex-col items-center justify-center animate-fadeIn"
        style={{ minHeight: 'calc(100vh - 3rem)' }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(255,71,148,0.07) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        <div
          className="absolute top-0 left-0 right-0 h-1 pointer-events-none"
          style={{
            background: 'linear-gradient(90deg, #FF4794 0%, #E02C80 50%, #FF4794 100%)',
            opacity: 0.6,
          }}
        />
        <div
          className="relative z-10 flex flex-col items-center text-center px-8 py-10 rounded-2xl max-w-sm w-full mx-auto"
          style={{
            background: 'rgba(255,255,255,0.92)',
            border: '1px solid rgba(255,71,148,0.18)',
            boxShadow: '0 4px 24px rgba(200,24,106,0.08), 0 1px 4px rgba(200,24,106,0.06)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div className="empty-state-mascot mb-2">
            <img
              src="/blobby-migration.webp"
              alt="Blobby ready to migrate"
              className="w-24 h-24 object-contain animate-float"
              style={{ animationDuration: '3s' }}
            />
          </div>
          <h2 className="text-lg font-bold text-content-primary mb-2 tracking-tight">
            Connect first to start migrating
          </h2>
          <p className="text-sm text-content-secondary mb-7 leading-relaxed">
            You need to connect to your Omni instance before using the migration tool.
          </p>
          <button onClick={() => navigate('/connect')} className="btn-primary">
            Go to Connect
          </button>
        </div>
      </div>
    );
  }

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

  return (
    <div>
      <Stepper currentStep={state.currentStep} />
      <div className="pb-12">
        {renderStep()}
      </div>
    </div>
  );
}
