import type { InstanceFolder } from '@/services/opsConsole';
import type { ComboBoxOption } from '@/components/ui/comboBoxUtils';

export const DESTINATIONS_PER_PAGE = 10;
export const TOP_LEVEL_FOLDER = 'top-level';
const CURRENT_FOLDER = 'current-selection';
export interface DestinationFolderChoice extends ComboBoxOption {
  folderId: string;
  folderPath: string;
}

/** Breadcrumb fallbacks are display-only; only API-provided paths go to preflight. */
export function destinationFolderChoices(folders: InstanceFolder[]): DestinationFolderChoice[] {
  const byId = new Map<string, DestinationFolderChoice>();
  const pending = folders.map((folder) => ({ folder, prefix: '' }));
  while (pending.length) {
    const { folder, prefix } = pending.shift()!;
    if (!folder.id || byId.has(folder.id)) continue;
    const path = folder.path || folder.identifier || '';
    const label = path || [prefix, folder.name || folder.id].filter(Boolean).join(' / ');
    byId.set(folder.id, { value: `folder:${folder.id}`, label, subtitle: folder.name && folder.name !== label ? folder.name : undefined,
      folderId: folder.id, folderPath: path });
    for (const child of folder.children || []) pending.push({ folder: child, prefix: label });
  }
  return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }));
}

export function destinationFolderSelection(choices: DestinationFolderChoice[], selection: { folderId?: string; folderPath?: string }) {
  const normalizedPath = (value: string | undefined) => (value || '').trim().replace(/^\/+|\/+$/g, '');
  const selected = selection.folderId
    ? choices.find((choice) => choice.folderId === selection.folderId && (!selection.folderPath || normalizedPath(choice.folderPath) === normalizedPath(selection.folderPath)))
    : selection.folderPath ? choices.filter((choice) => choice.folderPath && normalizedPath(choice.folderPath) === normalizedPath(selection.folderPath)) : undefined;
  const match = Array.isArray(selected) ? selected.length === 1 ? selected[0] : undefined : selected;
  const hasSelection = Boolean(selection.folderId || selection.folderPath);
  const options: ComboBoxOption[] = [{ value: TOP_LEVEL_FOLDER, label: 'Top level', subtitle: 'No destination folder' }, ...choices];
  if (hasSelection && !match) options.push({ value: CURRENT_FOLDER, label: selection.folderPath || selection.folderId!, subtitle: 'Current selection — not in the loaded folder list' });
  return { value: match?.value || (hasSelection ? CURRENT_FOLDER : TOP_LEVEL_FOLDER), options, missing: hasSelection && !match };
}

export function destinationFolderPatch(choices: DestinationFolderChoice[], value: string): { folderId: string; folderPath: string } | undefined {
  if (value === TOP_LEVEL_FOLDER) return { folderId: '', folderPath: '' };
  const choice = choices.find((row) => row.value === value);
  return choice ? { folderId: choice.folderId, folderPath: choice.folderPath } : undefined;
}

export function destinationPage<T>(rows: T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / DESTINATIONS_PER_PAGE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  return { page, pageCount, rows: rows.slice(page * DESTINATIONS_PER_PAGE, (page + 1) * DESTINATIONS_PER_PAGE) };
}
