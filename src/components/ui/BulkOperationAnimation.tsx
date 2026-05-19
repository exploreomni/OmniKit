import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Copy, FolderInput, Trash2 } from 'lucide-react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useConfetti } from '@/hooks/useConfetti';
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
    accent: '#C83B70',
    accentSoft: 'rgba(255,71,148,0.18)',
    border: 'rgba(255,71,148,0.28)',
    bg: 'rgba(255,71,148,0.06)',
    fill: 'linear-gradient(90deg, #C83B70 0%, #FF5789 100%)',
    icon: FolderInput,
    verb: 'Moving',
    doneVerb: 'Moved',
    vehicle: 'delivery-truck',
    inProgressLine: (name) => `Delivering ${name} to the Omni warehouse`,
    runningTitle: "Blobby's delivery truck is rolling",
    doneTitle: (n) => `Delivered — ${n} dashboard${n === 1 ? '' : 's'} arrived at the Omni warehouse!`,
    doneSub: 'Blobby checked the manifest and parked at the dock.',
  },
  copy: {
    accent: '#C83B70',
    accentSoft: 'rgba(255,71,148,0.18)',
    border: 'rgba(255,71,148,0.28)',
    bg: 'rgba(255,71,148,0.06)',
    fill: 'linear-gradient(90deg, #C83B70 0%, #FF5789 100%)',
    icon: Copy,
    verb: 'Copying',
    doneVerb: 'Copied',
    vehicle: 'conveyor',
    inProgressLine: (name) => `Sending ${name} down the conveyor`,
    runningTitle: 'The conveyor is humming',
    doneTitle: (n) => `Fresh copies off the belt — ${n} done!`,
    doneSub: 'Quality checked and ready to use.',
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
    vehicle: 'bulldozer',
    inProgressLine: (name) => `Clearing ${name}`,
    runningTitle: "Blobby's cleanup bulldozer is rolling",
    doneTitle: (n) => `All clear — ${n} dashboard${n === 1 ? '' : 's'} off the books.`,
    doneSub: 'Blobby waved goodbye on the way out.',
  },
};

function DashboardBox({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={`workflow-box ${className}`} style={style} aria-hidden>
      <span className="workflow-box-chart" />
      <span className="workflow-box-line" />
    </span>
  );
}

function BulkSceneDecor({ type, reduced }: { type: BulkOperationAnimationProps['type']; reduced: boolean }) {
  if (type === 'move') {
    return (
      <>
        <img src="/omni-warehouse.svg" alt="" className="bulk-scene-setting-image bulk-scene-warehouse-image" aria-hidden />
        <div className="bulk-scene-route" aria-hidden />
      </>
    );
  }

  if (type === 'copy') {
    return (
      <>
        <img src="/blobby-control-panel.png" alt="" className="bulk-control-panel-image" aria-hidden />
        <div className="bulk-scene-shelves" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="bulk-scene-conveyor" aria-hidden />
        {[0, 1, 2].map((i) => (
          <DashboardBox
            key={i}
            className={reduced ? 'bulk-conveyor-box' : 'bulk-conveyor-box workflow-box-slide'}
            style={{ animationDelay: `${i * 850}ms` }}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <img src="/bulk-construction-site.svg" alt="" className="bulk-scene-setting-image bulk-scene-construction-image" aria-hidden />
      <div className="bulk-scene-pile" aria-hidden>
        <DashboardBox className="bulk-pile-box bulk-pile-box-a" />
        <DashboardBox className="bulk-pile-box bulk-pile-box-b" />
        <DashboardBox className="bulk-pile-box bulk-pile-box-c" />
      </div>
    </>
  );
}

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
              ? '#FFFFFF'
              : '#FFFFFF',
          border: `1px solid ${type === 'delete' ? 'rgba(239,68,68,0.22)' : 'rgba(16,185,129,0.28)'}`,
        }}
      >
        <div className="relative flex-shrink-0">
          <Vehicle
            kind={type === 'delete' ? 'bulldozer' : tone.vehicle}
            width={104}
            height={72}
            className={reduced ? '' : 'animate-wiggle-infinite'}
          />
        </div>
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
            ? '#FFFFFF'
            : '#FFFFFF',
        border: '1px solid rgba(217,222,232,0.95)',
        boxShadow: 'none',
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

      <div className={`bulk-workflow-scene bulk-workflow-scene-${type}`} style={{ height: 118 }}>
        <BulkSceneDecor type={type} reduced={reduced} />
        {type !== 'delete' && (
          <>
            <div
              className="absolute left-4 right-4"
              style={{
                bottom: type === 'copy' ? 30 : 20,
                height: 4,
                background: '#DDE2EB',
                borderRadius: 999,
              }}
            />
            <div
              className="absolute left-4"
              style={{
                bottom: type === 'copy' ? 30 : 20,
                height: 4,
                width: pct > 0 ? `calc(${pct}% - 2rem)` : 0,
                background: tone.fill,
                borderRadius: 999,
                transition: reduced ? 'none' : 'width 500ms cubic-bezier(0.22, 1, 0.36, 1)',
                boxShadow: 'none',
              }}
            />
          </>
        )}

        {type === 'move' && (
          <div
            className="absolute bottom-3"
            style={{
              left: `calc(${Math.max(2, Math.min(pct, 94))}% - 50px)`,
              bottom: 24,
              transition: reduced ? 'none' : 'left 600ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <div className="relative bulk-delivery-truck-motion">
              <Vehicle
                kind={tone.vehicle}
                width={124}
                height={78}
                motion="none"
              />
            </div>
          </div>
        )}

        {type === 'delete' && (
          <div
            className="absolute bulk-bulldozer-push-group"
            style={{
              left: `calc(${Math.max(2, Math.min(pct, 84))}% - 42px)`,
              transition: reduced ? 'none' : 'left 620ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <div className="relative bulk-vehicle-facing-right">
              <Vehicle kind="bulldozer" width={126} height={80} motion="none" />
            </div>
            <DashboardBox className="bulk-bulldozer-pushed-tile" />
            <span className={reduced ? 'bulk-bulldozer-dust' : 'bulk-bulldozer-dust bulk-bulldozer-dust-motion'} aria-hidden />
          </div>
        )}

        {type !== 'delete' && (
          <div
            className="absolute right-3 bottom-4 flex items-center gap-1 px-2 py-1 rounded-lg"
            style={{
              background: 'rgba(16,185,129,0.08)',
              border: '1px dashed rgba(16,185,129,0.35)',
            }}
          >
            {type === 'copy' ? (
              <Copy size={14} className="text-emerald-700" />
            ) : (
              <FolderInput size={14} className="text-emerald-700" />
            )}
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              Destination
            </span>
          </div>
        )}
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
