import type { PostMigrationAction } from './nativeVault';

const PRIVATE_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|fc00:|fd[0-9a-f]{2}:)/i;
const LOOPBACK_NAMES = new Set(['localhost', '0.0.0.0']);

export function validatePostMigrationActionTarget(action: PostMigrationAction): string | null {
  if (action.kind === 'refresh-schema') return null;
  let url: URL;
  try {
    url = new URL(action.url);
  } catch {
    return 'Post-migration action URL is invalid.';
  }
  if (url.protocol !== 'https:') {
    return 'Post-migration actions must use HTTPS.';
  }
  const allowPrivate = process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS === 'true';
  const hostname = url.hostname.toLowerCase();
  if (!allowPrivate && (LOOPBACK_NAMES.has(hostname) || PRIVATE_HOST_RE.test(hostname))) {
    return 'Private-network post-migration actions are blocked by default.';
  }
  const allowlist = (process.env.OMNIKIT_POST_ACTION_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return `Post-migration action host is not allowlisted: ${hostname}.`;
  }
  return null;
}
