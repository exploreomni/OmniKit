import { useEffect } from 'react';

export type BlobbyMood =
  | 'dashboard'
  | 'connections'
  | 'content'
  | 'governance'
  | 'groups'
  | 'labels'
  | 'model'
  | 'semantic'
  | 'users'
  | 'embed'
  | 'rocket'
  | 'migration'
  | 'celebrating'
  | 'success'
  | 'in-progress'
  | 'thinking'
  | 'error'
  | 'sad'
  | 'schedule'
  | 'warning'
  | 'waving'
  | 'deck-package'
  | 'download'
  | 'upload'
  | 'ready'
  | 'skipped'
  | 'pending';

const MOOD_TO_SRC: Record<BlobbyMood, string> = {
  dashboard: '/blobby-dashboard.webp',
  connections: '/blobby-connections.png',
  content: '/blobby-governance.webp',
  governance: '/blobby-governance.webp',
  groups: '/blobby-groups.webp',
  labels: '/blobby-labels.png',
  model: '/blobby-reference.png',
  semantic: '/blobby-semantic.webp',
  users: '/blobby-users.webp',
  embed: '/blobby-embed.webp',
  rocket: '/blobby-rocket.webp',
  migration: '/blobby-migration.webp',
  celebrating: '/blobby-celebrating.webp',
  success: '/blobby-connection-success.png',
  'in-progress': '/blobby-connection-testing.png',
  thinking: '/blobby-thinking.webp',
  error: '/blobby-error.png',
  sad: '/blobby-sad.png',
  schedule: '/blobby-pending.png',
  warning: '/blobby-warning.png',
  waving: '/blobby-waving.png',
  'deck-package': '/blobby-powerpoint-delivery.png',
  download: '/blobby-download.png',
  upload: '/blobby-upload.png',
  ready: '/blobby-ready.webp',
  skipped: '/blobby-empty.png',
  pending: '/blobby-pending.png',
};

interface BlobbyProps {
  mood: BlobbyMood;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
}

export function Blobby({ mood, size = 48, className = '', style, alt }: BlobbyProps) {
  return (
    <img
      src={MOOD_TO_SRC[mood]}
      alt={alt ?? `Blobby ${mood}`}
      width={size}
      height={size}
      className={`select-none pointer-events-none object-contain ${className}`}
      style={{ width: size, height: size, ...style }}
      draggable={false}
    />
  );
}

let preloaded = false;
export function usePreloadBlobby() {
  useEffect(() => {
    if (preloaded || typeof window === 'undefined') return;
    preloaded = true;
    for (const src of Object.values(MOOD_TO_SRC)) {
      const img = new Image();
      img.src = src;
    }
  }, []);
}
