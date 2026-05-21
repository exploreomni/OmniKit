import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  ExternalLink,
  EyeOff,
  Map,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useWalkthrough } from '@/hooks/useWalkthrough';
import { WALKTHROUGH_DISPLAY_VERSION, walkthroughSteps } from '@/services/walkthrough';

function reasonCopy(reason: string) {
  if (reason === 'updated') {
    return {
      eyebrow: 'Updated walkthrough',
      title: 'See what changed before you keep working',
      description: 'This local copy of OmniKit includes an updated guide. Review it now, dismiss it for this version, or replay it later from the sidebar.',
    };
  }
  if (reason === 'first-run') {
    return {
      eyebrow: 'First time setup',
      title: 'A guided tour for confident Omni work',
      description: 'This walkthrough is written for non-technical users. It explains where to start, what each area is for, and how to review work before it changes anything.',
    };
  }
  return {
    eyebrow: 'Learning center',
    title: 'OmniKit walkthrough',
    description: 'Use this click-through guide as a refresher whenever someone needs help navigating OmniKit.',
  };
}

export function OmniKitWalkthrough() {
  const navigate = useNavigate();
  const {
    open,
    stepIndex,
    reason,
    closeWalkthrough,
    completeWalkthrough,
    setStepIndex,
  } = useWalkthrough();
  const activeStep = walkthroughSteps[stepIndex];
  const intro = reasonCopy(reason);
  const progress = Math.round(((stepIndex + 1) / walkthroughSteps.length) * 100);
  const isLast = stepIndex === walkthroughSteps.length - 1;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWalkthrough();
      if (event.key === 'ArrowRight') setStepIndex(stepIndex + 1);
      if (event.key === 'ArrowLeft') setStepIndex(stepIndex - 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeWalkthrough, open, setStepIndex, stepIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 px-4 py-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="omnikit-walkthrough-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-[8px] border border-white/20 bg-white shadow-dropdown">
        <div className="border-b border-border bg-gradient-to-r from-omni-50 via-white to-white px-5 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-chip bg-omni-600 px-2.5 py-1 text-[11px] font-semibold text-white">
                <Sparkles size={13} />
                {intro.eyebrow}
              </div>
              <h2 id="omnikit-walkthrough-title" className="mt-3 text-2xl font-semibold tracking-normal text-content-primary">
                {intro.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-content-secondary">{intro.description}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="button" onClick={closeWalkthrough} className="btn-secondary text-sm">
                <EyeOff size={14} />
                Dismiss
              </button>
              <button
                type="button"
                onClick={closeWalkthrough}
                className="rounded-button p-2 text-content-secondary transition-colors hover:bg-surface-secondary hover:text-content-primary"
                aria-label="Close walkthrough"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-omni-100">
            <div className="h-full rounded-full bg-omni-600 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-content-secondary">
            <span>Step {stepIndex + 1} of {walkthroughSteps.length}</span>
            <span>{WALKTHROUGH_DISPLAY_VERSION}</span>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-border bg-surface-secondary p-3 lg:border-b-0 lg:border-r">
            <div className="mb-2 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.12em] text-content-secondary">
              <Map size={14} />
              Learning path
            </div>
            <div className="space-y-1">
              {walkthroughSteps.map((step, index) => {
                const active = index === stepIndex;
                const complete = index < stepIndex;
                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => setStepIndex(index)}
                    aria-pressed={active}
                    className={`w-full rounded-[6px] border px-3 py-2.5 text-left transition-all ${
                      active
                        ? 'border-omni-400 bg-white shadow-soft ring-2 ring-omni-100'
                        : 'border-transparent hover:border-border hover:bg-white'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                        active
                          ? 'bg-omni-600 text-white'
                          : complete
                            ? 'bg-green-100 text-green-700'
                            : 'bg-white text-content-secondary'
                      }`}>
                        {complete ? <CheckCircle2 size={13} /> : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-content-primary">{step.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-content-secondary">{step.title}</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto p-5">
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="space-y-4">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-chip bg-surface-secondary px-2.5 py-1 text-[11px] font-semibold text-content-secondary">
                    <BookOpenCheck size={13} />
                    {activeStep.label}
                  </div>
                  <h3 className="mt-3 text-xl font-semibold text-content-primary">{activeStep.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-content-secondary">{activeStep.purpose}</p>
                </div>

                <div className="rounded-card border border-border bg-white p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <ArrowRight size={15} className="text-omni-700" />
                    What to do
                  </div>
                  <ol className="space-y-2">
                    {activeStep.directions.map((direction, index) => (
                      <li key={direction} className="flex gap-3 text-sm leading-relaxed text-content-secondary">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">
                          {index + 1}
                        </span>
                        <span>{direction}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {activeStep.caution && (
                  <div className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-800">
                    <div className="mb-1 flex items-center gap-2 font-semibold">
                      <ShieldCheck size={15} />
                      Keep in mind
                    </div>
                    {activeStep.caution}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="rounded-card border border-omni-100 bg-omni-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-omni-700">Outcome</div>
                  <p className="mt-2 text-sm leading-relaxed text-omni-800">{activeStep.outcome}</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(activeStep.route)}
                  className="btn-primary w-full justify-center text-sm"
                >
                  <ExternalLink size={14} />
                  Open this page
                </button>
                <div className="rounded-card border border-border bg-surface-secondary p-3 text-[12px] leading-relaxed text-content-secondary">
                  The walkthrough stays available while you move through the app. Use the sidebar Guide button to reopen it later.
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-3 border-t border-border bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs leading-relaxed text-content-secondary">
            Dismiss stores only walkthrough progress in localStorage. It does not include Omni content, source files, or API keys.
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setStepIndex(stepIndex - 1)}
              disabled={stepIndex === 0}
              className="btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft size={14} />
              Back
            </button>
            {isLast ? (
              <button type="button" onClick={completeWalkthrough} className="btn-primary text-sm">
                <CheckCircle2 size={14} />
                Finish
              </button>
            ) : (
              <button type="button" onClick={() => setStepIndex(stepIndex + 1)} className="btn-primary text-sm">
                Next
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
