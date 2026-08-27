function cleanBuildToken(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim();
  return cleaned && /^[A-Za-z0-9._+-]{1,80}$/.test(cleaned) ? cleaned : fallback;
}

const version = cleanBuildToken(
  typeof __OMNIKIT_VERSION__ === 'string' ? __OMNIKIT_VERSION__ : undefined,
  '1.0.0',
);
const commit = cleanBuildToken(
  typeof __OMNIKIT_BUILD_SHA__ === 'string' ? __OMNIKIT_BUILD_SHA__ : undefined,
  'development',
);

export const OMNIKIT_BUILD_INFO = Object.freeze({
  version,
  commit,
  label: `v${version} · ${commit === 'development' ? 'development build' : `build ${commit}`}`,
});
