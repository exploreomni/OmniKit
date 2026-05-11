export function deriveScopeFromFolderPath(folderPath: string | undefined | null): string | undefined {
  if (!folderPath) return undefined;
  const normalized = folderPath.replace(/^\/+/, '').toLowerCase();
  if (normalized.startsWith('shared') || normalized.startsWith('organization')) return 'organization';
  if (normalized.startsWith('personal') || normalized.startsWith('my ')) return 'personal';
  return undefined;
}
