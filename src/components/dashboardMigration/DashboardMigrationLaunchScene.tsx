import type { CSSProperties } from 'react';
import { CheckCircle2, Rocket, XCircle } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import { Vehicle } from '@/components/ui/Vehicle';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { MigrationJob } from '@/services/opsConsole';

interface DashboardMigrationLaunchSceneProps {
  current: number;
  total: number;
  status: MigrationJob['status'];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function statusCopy(status: MigrationJob['status']) {
  if (status === 'succeeded') {
    return {
      title: 'Blobby landed on the moon',
      detail: 'All migration steps finished successfully.',
      icon: <CheckCircle2 size={16} />,
    };
  }
  if (status === 'failed' || status === 'partial') {
    return {
      title: 'Mission needs review',
      detail: 'Blobby paused the route so the item log can show what needs attention.',
      icon: <XCircle size={16} />,
    };
  }
  if (status === 'canceled') {
    return {
      title: 'Mission canceled',
      detail: 'The migration engine stopped scheduling new work for this run.',
      icon: <XCircle size={16} />,
    };
  }
  return {
    title: 'Blobby is en route',
    detail: 'Exports, topic prep, imports, metadata, and post-actions are moving through the queue.',
    icon: <Rocket size={16} />,
  };
}

export function DashboardMigrationLaunchScene({ current, total, status }: DashboardMigrationLaunchSceneProps) {
  const reduced = useReducedMotion();
  const safeTotal = Math.max(total, 1);
  const safeCurrent = clamp(current, 0, safeTotal);
  const progress = safeCurrent / safeTotal;
  const progressPercent = Math.round(progress * 100);
  const rocketX = 13 + progress * 70;
  const rocketY = 62 - progress * 35 - Math.sin(progress * Math.PI) * 14;
  const rocketAngle = -20 + progress * 8;
  const copy = statusCopy(status);

  const style = {
    '--migration-launch-progress': progressPercent,
    '--migration-launch-rocket-x': `${rocketX}%`,
    '--migration-launch-rocket-y': `${rocketY}%`,
    '--migration-launch-rocket-angle': `${rocketAngle}deg`,
  } as CSSProperties;

  return (
    <div className={`dashboard-migration-launch dashboard-migration-launch-${status}`} aria-live="polite">
      <div
        className="dashboard-migration-launch-scene"
        role="progressbar"
        aria-label="Overall migration progress"
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={safeCurrent}
        aria-valuetext={`${safeCurrent}/${total} steps complete`}
        style={style}
      >
        <span className="dashboard-migration-launch-stars dashboard-migration-launch-stars-a" aria-hidden />
        <span className="dashboard-migration-launch-stars dashboard-migration-launch-stars-b" aria-hidden />
        <span className="dashboard-migration-launch-earth" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="dashboard-migration-launch-moon" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="dashboard-migration-launch-moon-glow" aria-hidden />
        <span className="dashboard-migration-launch-landing-pad" aria-hidden>
          <span />
        </span>
        <span className="dashboard-migration-launch-celebration" aria-hidden>
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
        <svg className="dashboard-migration-launch-route" viewBox="0 0 520 170" preserveAspectRatio="none" aria-hidden>
          <path className="dashboard-migration-launch-route-base" d="M56 118 C170 18 330 20 456 55" pathLength={100} />
          <path
            className="dashboard-migration-launch-route-progress"
            d="M56 118 C170 18 330 20 456 55"
            pathLength={100}
            style={{ strokeDasharray: `${progressPercent} 100` }}
          />
        </svg>
        <span className="dashboard-migration-launch-rocket-wrap" aria-hidden>
          <span className={reduced ? 'dashboard-migration-launch-trail' : 'dashboard-migration-launch-trail dashboard-migration-launch-trail-motion'} />
          <Vehicle
            kind="rocket"
            width={108}
            height={78}
            motion="none"
            className={reduced ? 'dashboard-migration-launch-rocket' : 'dashboard-migration-launch-rocket dashboard-migration-launch-rocket-motion'}
          />
        </span>
      </div>
      <div className="dashboard-migration-launch-copy">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="dashboard-migration-launch-icon">{copy.icon}</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-content-primary">{copy.title}</div>
              <div className="text-xs text-content-secondary">{copy.detail}</div>
            </div>
          </div>
          <StatusChip status={status === 'succeeded' ? 'success' : status === 'running' ? 'in_progress' : status} label={status} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-xs font-semibold text-content-secondary">
          <span>{safeCurrent}/{total} steps complete</span>
          <span>{progressPercent}%</span>
        </div>
      </div>
    </div>
  );
}
