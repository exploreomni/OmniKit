import { GitBranch, Search, ShieldCheck, Tag, Upload } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Blobby } from './Blobby';
import { Vehicle } from './Vehicle';

export type WorkflowStatusVariant =
  | 'health-scan'
  | 'branch-deploy'
  | 'bulk-upload'
  | 'label-apply'
  | 'content-scan'
  | 'upload-governance';

interface WorkflowStatusSceneProps {
  variant: WorkflowStatusVariant;
  title: string;
  detail?: string;
  statusLabel?: string;
  progressLabel?: string;
  compact?: boolean;
  className?: string;
}

function FileCard({ className = '' }: { className?: string }) {
  return (
    <span className={`workflow-status-file ${className}`} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function DashboardTile({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={`workflow-status-dashboard ${className}`} style={style} aria-hidden>
      <span />
      <span />
    </span>
  );
}

function SceneArt({ variant, reduced }: { variant: WorkflowStatusVariant; reduced: boolean }) {
  if (variant === 'health-scan') {
    return (
      <>
        <div className="workflow-status-grid" aria-hidden />
        <Blobby mood="model" size={58} className={reduced ? 'workflow-status-blobby' : 'workflow-status-blobby workflow-status-float'} />
        <div className="workflow-status-health-stack" aria-hidden>
          <FileCard className="workflow-status-file-a" />
          <FileCard className="workflow-status-file-b" />
          <FileCard className="workflow-status-file-c" />
        </div>
        <div className="workflow-status-node workflow-status-node-a" aria-hidden>Model</div>
        <div className="workflow-status-node workflow-status-node-b" aria-hidden>Topic</div>
        <div className="workflow-status-scan-beam" aria-hidden />
      </>
    );
  }

  if (variant === 'branch-deploy') {
    return (
      <>
        <div className="workflow-status-branch-line" aria-hidden>
          <span />
          <span />
        </div>
        <div className="workflow-status-branch-node workflow-status-branch-dev" aria-hidden>dev</div>
        <div className="workflow-status-branch-node workflow-status-branch-main" aria-hidden>Omni</div>
        <GitBranch className="workflow-status-branch-icon" size={25} aria-hidden />
        <FileCard className={reduced ? 'workflow-status-route-file' : 'workflow-status-route-file workflow-status-route-file-motion'} />
        <Blobby mood="semantic" size={50} className={reduced ? 'workflow-status-deploy-blobby' : 'workflow-status-deploy-blobby workflow-status-float'} />
      </>
    );
  }

  if (variant === 'bulk-upload') {
    return (
      <>
        <div className="workflow-status-warehouse" aria-hidden />
        <div className="workflow-status-mini-conveyor" aria-hidden />
        {[0, 1, 2].map((index) => (
          <DashboardTile
            key={index}
            className={reduced ? 'workflow-status-moving-box' : 'workflow-status-moving-box workflow-status-moving-box-motion'}
            style={{ animationDelay: `${index * 780}ms` }}
          />
        ))}
        <Blobby mood="users" size={48} className="workflow-status-control-blobby" />
        <Upload className="workflow-status-corner-icon" size={22} aria-hidden />
      </>
    );
  }

  if (variant === 'label-apply') {
    return (
      <>
        <div className="workflow-status-label-docs" aria-hidden>
          <FileCard className="workflow-status-label-doc-a" />
          <FileCard className="workflow-status-label-doc-b" />
          <FileCard className="workflow-status-label-doc-c" />
        </div>
        <Blobby mood="labels" size={54} className={reduced ? 'workflow-status-blobby' : 'workflow-status-blobby workflow-status-float'} />
        <div className={reduced ? 'workflow-status-label-stamp' : 'workflow-status-label-stamp workflow-status-label-stamp-motion'} aria-hidden>
          <Tag size={15} />
        </div>
      </>
    );
  }

  if (variant === 'upload-governance') {
    return (
      <>
        <div className="workflow-status-grid" aria-hidden />
        <Blobby mood="upload" size={52} className={reduced ? 'workflow-status-blobby' : 'workflow-status-blobby workflow-status-float'} />
        <div className="workflow-status-upload-stack" aria-hidden>
          <FileCard className="workflow-status-upload-file-a" />
          <FileCard className="workflow-status-upload-file-b" />
          <FileCard className="workflow-status-upload-file-c" />
        </div>
        <ShieldCheck className="workflow-status-shield" size={24} aria-hidden />
        <div className="workflow-status-scan-beam" aria-hidden />
      </>
    );
  }

  return (
    <>
      <div className="workflow-status-grid" aria-hidden />
      <Vehicle kind="detective" width={78} height={62} className="workflow-status-detective" motion="none" />
      <div className="workflow-status-content-board" aria-hidden>
        <DashboardTile className="workflow-status-content-tile-a" />
        <DashboardTile className="workflow-status-content-tile-b" />
        <DashboardTile className="workflow-status-content-tile-c" />
      </div>
      <Search className={reduced ? 'workflow-status-search-icon' : 'workflow-status-search-icon workflow-status-search-motion'} size={24} aria-hidden />
    </>
  );
}

export function WorkflowStatusScene({
  variant,
  title,
  detail,
  statusLabel,
  progressLabel,
  compact = false,
  className = '',
}: WorkflowStatusSceneProps) {
  const reduced = useReducedMotion();

  return (
    <div
      className={`workflow-status-card ${compact ? 'workflow-status-card-compact' : ''} ${className}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className={`workflow-status-scene workflow-status-scene-${variant}`}>
        <SceneArt variant={variant} reduced={reduced} />
      </div>
      <div className="workflow-status-copy">
        {statusLabel && (
          <div className="workflow-status-pill">
            <span className={reduced ? '' : 'workflow-status-live-dot'} />
            {statusLabel}
          </div>
        )}
        <div className="workflow-status-title">{title}</div>
        {detail && <div className="workflow-status-detail">{detail}</div>}
        {progressLabel && <div className="workflow-status-progress-label">{progressLabel}</div>}
      </div>
    </div>
  );
}
