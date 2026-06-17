import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useConfetti } from '@/hooks/useConfetti';
import { Blobby } from './Blobby';
import { Vehicle } from './Vehicle';

interface MigrationAnimationProps {
  current: number;
  total: number;
  completed: boolean;
  hasFailures: boolean;
  mode?: 'migration' | 'remap';
  currentItem?: string;
  sourceHost?: string;
  targetHost?: string;
}

function useCountUp(target: number, duration = 600, reduced = false) {
  const [value, setValue] = useState(target);
  const prev = useRef(target);

  useEffect(() => {
    if (reduced) {
      setValue(target);
      prev.current = target;
      return;
    }
    const start = prev.current;
    const diff = target - start;
    if (diff === 0) return;
    const startTime = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(start + diff * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else prev.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);

  return value;
}

function Terminal({ label, host, kind }: { label: string; host?: string; kind: 'source' | 'target' }) {
  const accent = kind === 'source' ? '#C83B70' : '#047857';
  const bg = kind === 'source' ? 'rgba(255,71,148,0.08)' : 'rgba(16,185,129,0.08)';
  const border = kind === 'source' ? 'rgba(255,71,148,0.3)' : 'rgba(16,185,129,0.3)';
  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0" style={{ width: 92 }}>
      <div
        className="w-full flex flex-col items-center px-2 py-2 rounded-xl"
        style={{ background: bg, border: `1px solid ${border}` }}
      >
        <svg width="32" height="24" viewBox="0 0 40 28">
          <path d="M4 24 L36 24 L36 18 L32 14 L8 14 L4 18 Z" fill={accent} opacity="0.85" />
          <rect x="17" y="2" width="6" height="16" fill={accent} />
          <path d="M23 4 L33 8 L23 10 Z" fill={accent} />
        </svg>
        <div className="text-[9px] font-bold uppercase tracking-widest mt-1" style={{ color: accent }}>{label}</div>
        <div className="text-[10px] font-semibold text-content-primary truncate max-w-full">
          {host || (kind === 'source' ? 'Source' : 'Target')}
        </div>
      </div>
    </div>
  );
}

function MigrationSceneDecor({ mode, reduced }: { mode: 'migration' | 'remap'; reduced: boolean }) {
  if (mode === 'remap') {
    return (
      <>
        <div className="migration-scene-sky" aria-hidden />
        <div className="migration-scene-dock migration-scene-dock-left" aria-hidden />
        <div className="migration-scene-dock migration-scene-dock-right" aria-hidden />
        <div className="migration-scene-water" aria-hidden>
          {!reduced && [0, 1, 2].map((i) => <span key={i} style={{ animationDelay: `${i * 700}ms` }} />)}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="migration-scene-space" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={reduced ? '' : 'migration-star-twinkle'} style={{ animationDelay: `${i * 340}ms` }} />
        ))}
      </div>
      <div className="migration-scene-earth" aria-hidden />
      <div className="migration-scene-moon" aria-hidden />
      {!reduced && (
        <>
          <span className="migration-orbit-dash migration-orbit-dash-a" aria-hidden />
          <span className="migration-orbit-dash migration-orbit-dash-b" aria-hidden />
        </>
      )}
    </>
  );
}

export function MigrationAnimation({
  current,
  total,
  completed,
  hasFailures,
  mode = 'migration',
  currentItem,
  sourceHost,
  targetHost,
}: MigrationAnimationProps) {
  const reduced = useReducedMotion();
  const fireConfetti = useConfetti();
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const displayPct = useCountUp(pct, 500, reduced);
  const firedRef = useRef(false);
  const routeVehicle = mode === 'remap' ? 'sailboat' : 'rocket';

  useEffect(() => {
    if (completed && !hasFailures && !firedRef.current) {
      firedRef.current = true;
      fireConfetti({ count: 120, originY: 0.4, spread: 90 });
    }
  }, [completed, hasFailures, fireConfetti]);

  if (completed && !hasFailures) {
    return (
      <div
        className="relative overflow-hidden rounded-2xl p-5 animate-fadeIn"
        style={{
          background: '#FFFFFF',
          border: '1px solid rgba(16,185,129,0.3)',
        }}
      >
        <div className="flex items-center gap-4">
          <Blobby mood="celebrating" size={72} className={reduced ? '' : 'animate-wiggle-infinite'} />
          <div className="min-w-0">
            <div className="text-[17px] font-bold text-content-primary leading-tight">
              Wheels down! Blobby stuck the landing.
            </div>
            <div className="text-[13px] text-content-secondary mt-1">
              {mode === 'remap'
                ? `${total} dashboard${total !== 1 ? 's' : ''} updated to the target model. Location unchanged.`
                : `${total} dashboard${total !== 1 ? 's are' : ' is'} settled in at ${total !== 1 ? 'their' : 'its'} new home.`}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (completed && hasFailures) {
    return (
      <div
        className="rounded-2xl p-5 animate-fadeIn"
        style={{
          background: '#FFFFFF',
          border: '1px solid rgba(245,158,11,0.3)',
        }}
      >
        <div className="flex items-center gap-4">
          <Blobby mood="warning" size={64} />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold text-content-primary leading-tight flex items-center gap-2">
              Landed with a little turbulence
              <AlertTriangle size={16} className="text-amber-500" />
            </div>
            <div className="text-[12px] text-content-secondary mt-1">
              A few rows need another look — scroll down for the flight log.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`migration-workflow-scene migration-workflow-scene-${mode} relative overflow-hidden rounded-2xl p-5 animate-fadeIn`}
      style={{
        background: mode === 'remap' ? '#F8F9FD' : '#404754',
        border: '1px solid rgba(217,222,232,0.95)',
        boxShadow: 'none',
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      <MigrationSceneDecor mode={mode} reduced={reduced} />

      <div className="flex items-center justify-between mb-3 relative">
        <span className={`text-[11px] font-bold uppercase tracking-widest ${mode === 'migration' ? 'text-white/78' : 'text-content-tertiary'}`}>
          {mode === 'remap' ? 'Remap route' : 'Rocket route'}
        </span>
        <div className="flex items-center gap-3">
          <span className={`text-[12px] tabular-nums ${mode === 'migration' ? 'text-white/72' : 'text-content-secondary'}`}>
            <span className={`font-bold ${mode === 'migration' ? 'text-white' : 'text-content-primary'}`}>{current}</span>
            <span className={mode === 'migration' ? 'text-white/45' : 'text-content-tertiary'}> / </span>
            <span className="font-semibold">{total}</span>
          </span>
          <span
            className="text-[12px] font-bold tabular-nums px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(255,71,148,0.12)',
              color: '#C83B70',
              border: '1px solid rgba(255,71,148,0.25)',
            }}
          >
            {displayPct}%
          </span>
        </div>
      </div>

      <div className="flex items-end gap-3 relative z-10">
        <Terminal label="Depart" kind="source" host={sourceHost} />

        <div className="flex-1 relative" style={{ height: 96 }}>
          <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 60">
            <path
              d="M 2 48 Q 50 4 98 48"
              stroke={mode === 'migration' ? 'rgba(255,255,255,0.48)' : '#E8D5DE'}
              strokeWidth="1"
              fill="none"
              strokeDasharray="2,3"
            />
          </svg>
          <div
            className="absolute"
            style={{
              left: `calc(${Math.max(2, Math.min(pct, 98))}% - 58px)`,
              bottom: `${Math.sin((pct / 100) * Math.PI) * 42 + 16}px`,
              transition: reduced ? 'none' : 'left 600ms cubic-bezier(0.22, 1, 0.36, 1), bottom 600ms cubic-bezier(0.22, 1, 0.36, 1)',
              transform: pct < 50 ? 'rotate(-8deg)' : 'rotate(6deg)',
            }}
          >
            <div className="relative">
              <Vehicle kind={routeVehicle} width={mode === 'remap' ? 112 : 124} height={mode === 'remap' ? 92 : 84} />
              {mode === 'migration' && !reduced && pct > 0 && pct < 100 && (
                <>
                  <span
                    className="absolute rounded-full"
                    style={{
                      left: -6,
                      top: 50,
                      width: 10,
                      height: 4,
                      background: 'rgba(255,71,148,0.45)',
                      animation: 'rocketTrail 0.9s ease-out infinite',
                    }}
                  />
                  <span
                    className="absolute rounded-full"
                    style={{
                      left: -16,
                      top: 54,
                      width: 8,
                      height: 3,
                      background: 'rgba(255,71,148,0.3)',
                      animation: 'rocketTrail 0.9s 0.2s ease-out infinite',
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <Terminal label="Arrive" kind="target" host={targetHost} />
      </div>

      {currentItem && (
        <div className={`mt-3 flex items-center gap-2 text-[12px] relative z-10 ${mode === 'migration' ? 'text-white/80' : 'text-content-secondary'}`}>
          <span className={`w-1.5 h-1.5 rounded-full bg-omni-500 ${reduced ? '' : 'animate-pulse'}`} />
          <span className="truncate">
            {mode === 'remap' ? (
              <>
                Remapping <span className="font-semibold text-content-primary">{currentItem}</span>
              </>
            ) : (
              <>
                Now flying <span className="font-semibold text-white">{currentItem}</span> to its new home
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
