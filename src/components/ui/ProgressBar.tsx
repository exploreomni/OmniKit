import { useReducedMotion } from '@/hooks/useReducedMotion';

interface ProgressBarProps {
  current: number;
  total: number;
  label?: string;
  indeterminate?: boolean;
  tone?: 'brand' | 'danger' | 'success';
}

const TONES = {
  brand: {
    fill: 'linear-gradient(90deg, #C8186A 0%, #FF4794 100%)',
    track: 'rgba(255,71,148,0.14)',
    text: '#C8186A',
  },
  danger: {
    fill: 'linear-gradient(90deg, #B91C1C 0%, #EF4444 100%)',
    track: 'rgba(239,68,68,0.14)',
    text: '#B91C1C',
  },
  success: {
    fill: 'linear-gradient(90deg, #047857 0%, #10B981 100%)',
    track: 'rgba(16,185,129,0.14)',
    text: '#047857',
  },
};

export function ProgressBar({ current, total, label, indeterminate, tone = 'brand' }: ProgressBarProps) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const t = TONES[tone];
  const reduced = useReducedMotion();

  return (
    <div className="w-full">
      {label && (
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-[12px] font-medium text-content-secondary">{label}</span>
          {!indeterminate && (
            <span className="text-[12px] tabular-nums font-semibold" style={{ color: t.text }}>
              {pct}%
            </span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative w-full rounded-full overflow-hidden"
        style={{ height: 4, background: t.track }}
      >
        {indeterminate ? (
          <div
            className="absolute top-0 h-full rounded-full"
            style={{
              width: '40%',
              background: t.fill,
              animation: reduced ? undefined : 'progressSweep 1.6s ease-in-out infinite',
              boxShadow: '0 0 8px rgba(255,71,148,0.35)',
            }}
          />
        ) : (
          <div
            className="h-full rounded-full"
            style={{
              width: `${pct}%`,
              background: t.fill,
              transition: reduced ? 'none' : 'width 420ms cubic-bezier(0.22, 1, 0.36, 1)',
              boxShadow: '0 0 6px rgba(255,71,148,0.25)',
            }}
          />
        )}
        <div
          className="absolute inset-x-0 top-0 h-px pointer-events-none"
          style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)' }}
          aria-hidden
        />
      </div>
    </div>
  );
}
