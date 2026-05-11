import { useEffect, useRef } from 'react';
import { Copy, FolderInput, Trash2 } from 'lucide-react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useConfetti } from '@/hooks/useConfetti';
import { Blobby } from './Blobby';
import { Vehicle, type VehicleKind } from './Vehicle';

interface BulkOperationAnimationProps {
  current: number;
  total: number;
  type: 'move' | 'delete' | 'copy';
  label?: string;
  currentItem?: string;
  completed?: boolean;
}

const TONES: Record<
  BulkOperationAnimationProps['type'],
  {
    accent: string;
    accentSoft: string;
    border: string;
    bg: string;
    fill: string;
    icon: typeof FolderInput;
    verb: string;
    doneVerb: string;
    vehicle: VehicleKind;
    inProgressLine: (name: string) => string;
    runningTitle: string;
    doneTitle: (n: number) => string;
    doneSub: string;
  }
> = {
  move: {
    accent: '#C8186A',
    accentSoft: 'rgba(255,71,148,0.18)',
    border: 'rgba(255,71,148,0.28)',
    bg: 'rgba(255,71,148,0.06)',
    fill: 'linear-gradient(90deg, #C8186A 0%, #FF4794 100%)',
    icon: FolderInput,
    verb: 'Moving',
    doneVerb: 'Moved',
    vehicle: 'truck',
    inProgressLine: (name) => `Loading ${name} onto the truck`,
    runningTitle: "Blobby's moving truck is rolling",
    doneTitle: (n) => `Truck's unloaded — ${n} dashboard${n === 1 ? '' : 's'} in their new home!`,
    doneSub: 'Blobby tipped his cap and drove off into the sunset.',
  },
  copy: {
    accent: '#C8186A',
    accentSoft: 'rgba(255,71,148,0.18)',
    border: 'rgba(255,71,148,0.28)',
    bg: 'rgba(255,71,148,0.06)',
    fill: 'linear-gradient(90deg, #C8186A 0%, #FF4794 100%)',
    icon: Copy,
    verb: 'Copying',
    doneVerb: 'Copied',
    vehicle: 'copier',
    inProgressLine: (name) => `Running ${name} through the copier`,
    runningTitle: 'The copier is humming',
    doneTitle: (n) => `Fresh copies off the press — ${n} done!`,
    doneSub: 'Still warm. Handle with care.',
  },
  delete: {
    accent: '#B91C1C',
    accentSoft: 'rgba(239,68,68,0.18)',
    border: 'rgba(239,68,68,0.28)',
    bg: 'rgba(239,68,68,0.05)',
    fill: 'linear-gradient(90deg, #991B1B 0%, #DC2626 100%)',
    icon: Trash2,
    verb: 'Deleting',
    doneVerb: 'Deleted',
    vehicle: 'crane',
    inProgressLine: (name) => `Scooping up ${name}`,
    runningTitle: "Blobby's sanitation crane at work",
    doneTitle: (n) => `All clear — ${n} dashboard${n === 1 ? '' : 's'} off the books.`,
    doneSub: 'Blobby waved goodbye on the way out.',
  },
};

export function BulkOperationAnimation({
  current,
  total,
  type,
  label,
  currentItem,
  completed,
}: BulkOperationAnimationProps) {
  const reduced = useReducedMotion();
  const fireConfetti = useConfetti();
  const tone = TONES[type];
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const firedRef = useRef(false);

  useEffect(() => {
    if (completed && type !== 'delete' && !firedRef.current && total > 0) {
      firedRef.current = true;
      fireConfetti({ count: 90, originY: 0.5 });
    }
  }, [completed, type, total, fireConfetti]);

  if (completed) {
    return (
      <div
        className="rounded-2xl p-5 animate-fadeIn flex items-center gap-4"
        style={{
          background:
            type === 'delete'
              ? 'rgba(239,68,68,0.05)'
              : 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(255,71,148,0.05))',
          border: `1px solid ${type === 'delete' ? 'rgba(239,68,68,0.22)' : 'rgba(16,185,129,0.28)'}`,
        }}
      >
        <Blobby
          mood={type === 'delete' ? 'waving' : 'celebrating'}
          size={64}
          className={reduced ? '' : 'animate-wiggle-infinite'}
        />
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-content-primary leading-tight">
            {tone.doneTitle(current)}
          </div>
          <div className="text-[12px] text-content-secondary mt-1">{tone.doneSub}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl p-5 animate-fadeIn"
      style={{
        background:
          type === 'delete'
            ? 'linear-gradient(180deg, #FFF5F5 0%, #FFF8FB 100%)'
            : 'linear-gradient(180deg, #FFFFFF 0%, #FFF8FB 100%)',
        border: '1px solid rgba(242,190,214,0.8)',
        boxShadow: '0 1px 4px rgba(200,24,100,0.06), 0 4px 16px rgba(200,24,100,0.04)',
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold uppercase tracking-widest text-content-tertiary">
          {label || tone.runningTitle}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-content-secondary tabular-nums">
            <span className="font-bold text-content-primary">{current}</span>
            <span className="text-content-tertiary"> / </span>
            <span className="font-semibold">{total}</span>
          </span>
          <span
            className="text-[12px] font-bold tabular-nums px-2 py-0.5 rounded-full"
            style={{ background: tone.accentSoft, color: tone.accent, border: `1px solid ${tone.border}` }}
          >
            {pct}%
          </span>
        </div>
      </div>

      <div className="relative" style={{ height: 94 }}>
        <div
          className="absolute left-0 right-0"
          style={{
            bottom: 8,
            height: 4,
            background: 'repeating-linear-gradient(90deg, rgba(200,24,100,0.18) 0 8px, transparent 8px 14px)',
            borderRadius: 999,
          }}
        />
        <div
          className="absolute left-0"
          style={{
            bottom: 8,
            height: 4,
            width: `${pct}%`,
            background: tone.fill,
            borderRadius: 999,
            transition: reduced ? 'none' : 'width 500ms cubic-bezier(0.22, 1, 0.36, 1)',
            boxShadow: `0 0 8px ${tone.accentSoft}`,
          }}
        />

        <div
          className="absolute bottom-3"
          style={{
            left: `calc(${Math.max(2, Math.min(pct, 94))}% - 50px)`,
            transition: reduced ? 'none' : 'left 600ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <div className="relative">
            <Vehicle kind={tone.vehicle} width={88} height={56} />
            <Blobby
              mood={type === 'delete' ? 'waving' : 'in-progress'}
              size={28}
              className={reduced ? 'absolute' : 'absolute animate-float'}
              style={{
                left: tone.vehicle === 'crane' ? 18 : tone.vehicle === 'copier' ? 12 : 14,
                top: tone.vehicle === 'copier' ? -4 : -8,
                animationDuration: '2.4s',
              }}
            />
          </div>
        </div>

        <div
          className="absolute right-0 bottom-4 flex items-center gap-1 px-2 py-1 rounded-lg"
          style={{
            background: type === 'delete' ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
            border: `1px dashed ${type === 'delete' ? 'rgba(239,68,68,0.35)' : 'rgba(16,185,129,0.35)'}`,
          }}
        >
          {type === 'delete' ? (
            <Trash2 size={14} className="text-red-600" />
          ) : type === 'copy' ? (
            <Copy size={14} className="text-emerald-700" />
          ) : (
            <FolderInput size={14} className="text-emerald-700" />
          )}
          <span
            className="text-[10px] font-bold uppercase tracking-wider"
            style={{ color: type === 'delete' ? '#B91C1C' : '#047857' }}
          >
            {type === 'delete' ? 'Trash' : 'Destination'}
          </span>
        </div>
      </div>

      {currentItem && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-content-secondary">
          <span
            className={`w-1.5 h-1.5 rounded-full ${reduced ? '' : 'animate-pulse'}`}
            style={{ background: tone.accent }}
          />
          <span className="truncate">{tone.inProgressLine(currentItem)}</span>
        </div>
      )}
    </div>
  );
}
