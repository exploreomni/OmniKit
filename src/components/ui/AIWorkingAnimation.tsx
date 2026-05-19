import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Blobby } from './Blobby';
import { Vehicle } from './Vehicle';

export type AIWorkStepStatus = 'complete' | 'active' | 'pending' | 'failed';

interface AIWorkingAnimationProps {
  variant: 'dashboard' | 'semantic';
  title: string;
  detail: string;
  statusLabel?: string;
  steps?: Array<{
    label: string;
    status: AIWorkStepStatus;
  }>;
  compact?: boolean;
}

const VARIANT_COPY = {
  dashboard: {
    mood: 'dashboard' as const,
    accent: '#FF5789',
    soft: 'rgba(255,87,137,0.1)',
    chips: ['Tiles', 'Filters', 'Topics', 'UX'],
  },
  semantic: {
    mood: 'semantic' as const,
    accent: '#C83B70',
    soft: 'rgba(200,59,112,0.1)',
    chips: ['Topic', 'Joins', 'Metrics', 'YAML'],
  },
};

function StepIcon({ status }: { status: AIWorkStepStatus }) {
  if (status === 'complete') return <CheckCircle2 size={13} className="text-green-700" />;
  if (status === 'failed') return <XCircle size={13} className="text-red-700" />;
  if (status === 'active') return <Loader2 size={13} className="text-omni-700 animate-spin" />;
  return <Clock size={13} className="text-content-tertiary" />;
}

function DashboardReviewScene({ compact, reduced }: { compact: boolean; reduced: boolean }) {
  return (
    <div
      className="ai-scene ai-scene-dashboard"
      style={{ width: compact ? 142 : 176, height: compact ? 120 : 150 }}
      aria-hidden
    >
      <div className="ai-scene-board ai-dashboard-card ai-dashboard-card-a">
        <span />
        <span />
      </div>
      <div className="ai-scene-board ai-dashboard-card ai-dashboard-card-b">
        <span />
        <span />
      </div>
      <div className="ai-clue-dot ai-clue-dot-a" />
      <div className="ai-clue-dot ai-clue-dot-b" />
      <div className="ai-clue-dot ai-clue-dot-c" />
      {!reduced && <span className="ai-clue-scan" />}
      <Vehicle
        kind="detective"
        width={compact ? 96 : 118}
        height={compact ? 78 : 98}
        motion={reduced ? 'none' : 'auto'}
        className="relative z-10"
      />
    </div>
  );
}

function SemanticWorkshopScene({ compact, reduced }: { compact: boolean; reduced: boolean }) {
  return (
    <div
      className="ai-scene ai-scene-semantic"
      style={{ width: compact ? 142 : 176, height: compact ? 120 : 150 }}
      aria-hidden
    >
      <div className="semantic-file-stack">
        <div className="semantic-file-lane semantic-file-lane-top">
          <span>topic</span>
        </div>
        <div className="semantic-file-lane semantic-file-lane-mid">
          <span>view</span>
        </div>
        <div className="semantic-file-lane semantic-file-lane-low">
          <span>metric</span>
        </div>
      </div>
      <div className="semantic-ai-terminal">
        <span>AI</span>
      </div>
      <div className="semantic-branch semantic-branch-dev">dev</div>
      <div className="semantic-branch semantic-branch-main">main</div>
      {!reduced && (
        <>
          <span className="semantic-feed semantic-feed-a" />
          <span className="semantic-feed semantic-feed-b" />
        </>
      )}
      <Blobby
        mood="semantic"
        size={compact ? 76 : 96}
        className={reduced ? 'relative z-10' : 'relative z-10 animate-float'}
        style={{ animationDuration: '3.8s' }}
      />
    </div>
  );
}

export function AIWorkingAnimation({
  variant,
  title,
  detail,
  statusLabel,
  steps = [],
  compact = false,
}: AIWorkingAnimationProps) {
  const reduced = useReducedMotion();
  const config = VARIANT_COPY[variant];
  const visibleSteps = steps.slice(0, 5);

  return (
    <div
      className={`ai-workbench relative overflow-hidden rounded-card border ${compact ? 'p-4' : 'p-5'} animate-fadeIn`}
      style={{
        borderColor: 'rgba(217,222,232,0.95)',
        background: '#FFFFFF',
        boxShadow: 'none',
      }}
      aria-live="polite"
    >
      <div className="ai-workbench-sheen" aria-hidden />
      <div className={`relative z-10 grid gap-4 ${compact ? 'md:grid-cols-[150px_minmax(0,1fr)]' : 'md:grid-cols-[190px_minmax(0,1fr)]'} items-center`}>
        <div className="relative flex items-center justify-center mx-auto">
          {variant === 'dashboard' ? (
            <DashboardReviewScene compact={compact} reduced={reduced} />
          ) : (
            <SemanticWorkshopScene compact={compact} reduced={reduced} />
          )}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-content-primary">{title}</div>
              <div className="text-xs text-content-secondary mt-1 leading-5">{detail}</div>
            </div>
            {statusLabel && (
              <span
                className="text-[10px] font-semibold px-2 py-0.5 rounded-chip bg-white border"
                style={{ color: config.accent, borderColor: 'rgba(255,87,137,0.24)' }}
              >
                {statusLabel}
              </span>
            )}
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2">
            {config.chips.map((chip, index) => (
              <div
                key={chip}
                className="ai-workbench-chip rounded-button border bg-white px-2 py-2 text-center text-[10px] font-semibold text-content-secondary"
                style={{
                  borderColor: 'rgba(232,213,222,0.9)',
                  animationDelay: reduced ? undefined : `${index * 180}ms`,
                }}
              >
                {chip}
              </div>
            ))}
          </div>

          {visibleSteps.length > 0 && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {visibleSteps.map((step) => (
                <div
                  key={step.label}
                  className={`flex items-center gap-2 rounded-button border px-2.5 py-2 text-[11px] ${
                    step.status === 'active'
                      ? 'border-omni-200 bg-omni-50 text-omni-800'
                      : step.status === 'complete'
                        ? 'border-green-200 bg-green-50 text-green-800'
                        : step.status === 'failed'
                          ? 'border-red-200 bg-red-50 text-red-800'
                          : 'border-border bg-white text-content-secondary'
                  }`}
                >
                  <StepIcon status={step.status} />
                  <span className="truncate font-medium">{step.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
