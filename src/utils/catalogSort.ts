type LabelLike = string | { name?: string | null } | null | undefined;

interface ModelLike {
  id?: string;
  name?: string | null;
  identifier?: string | null;
  baseModelId?: string | null;
  connectionName?: string | null;
}

interface DocumentLike {
  id?: string;
  identifier?: string;
  name?: string;
  folderPath?: string;
  folderId?: string;
  baseModelId?: string | null;
  baseModelName?: string | null;
  connectionName?: string | null;
  labels?: LabelLike[];
}

interface FolderLike<TChild = unknown> {
  id?: string;
  name?: string;
  identifier?: string;
  path?: string;
  children?: TChild[];
}

interface InstanceLike {
  id?: string;
  label?: string;
  baseUrl?: string;
  role?: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
}

export const catalogCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function compareCatalogText(a?: string | null, b?: string | null): number {
  return catalogCollator.compare((a || '').trim(), (b || '').trim());
}

function firstText(...values: Array<string | null | undefined>): string {
  return values.find((value) => value?.trim())?.trim() || '';
}

function labelText(label: LabelLike): string {
  if (typeof label === 'string') return label;
  return label?.name || '';
}

export function modelDisplayLabel(model: ModelLike): string {
  const base = firstText(model.name, model.identifier, model.baseModelId, model.id);
  return model.connectionName ? `${model.connectionName} - ${base}` : base;
}

export function folderDisplayLabel(folder: FolderLike): string {
  return firstText(folder.path, folder.identifier, folder.name, folder.id);
}

export function sortModels<T extends ModelLike>(models: T[]): T[] {
  return [...models].sort((a, b) => (
    compareCatalogText(modelDisplayLabel(a), modelDisplayLabel(b))
    || compareCatalogText(a.identifier, b.identifier)
    || compareCatalogText(a.id, b.id)
  ));
}

export function sortDocuments<T extends DocumentLike>(documents: T[]): T[] {
  return [...documents].sort((a, b) => (
    compareCatalogText(a.name, b.name)
    || compareCatalogText(a.folderPath, b.folderPath)
    || compareCatalogText(a.identifier, b.identifier)
    || compareCatalogText(a.id, b.id)
  ));
}

export function sortSavedInstances<T extends InstanceLike>(instances: T[]): T[] {
  return [...instances].sort((a, b) => (
    compareCatalogText(a.label, b.label)
    || compareCatalogText(a.baseUrl, b.baseUrl)
    || compareCatalogText(a.id, b.id)
  ));
}

export function sortFolders<T extends FolderLike<T>>(folders: T[]): T[] {
  return [...folders]
    .map((folder) => ({
      ...folder,
      ...(folder.children ? { children: sortFolders(folder.children) } : {}),
    }) as T)
    .sort((a, b) => (
      compareCatalogText(folderDisplayLabel(a), folderDisplayLabel(b))
      || compareCatalogText(a.name, b.name)
      || compareCatalogText(a.id, b.id)
    ));
}

export function filterFolderTree<T extends FolderLike<T>>(folders: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  const sorted = sortFolders(folders);
  if (!normalized) return sorted;

  const matches = (folder: FolderLike) => [
    folder.name,
    folder.identifier,
    folder.path,
    folder.id,
  ].some((value) => value?.toLowerCase().includes(normalized));

  const filterOne = (folder: T): T | null => {
    const childMatches = folder.children
      ? filterFolderTree(folder.children, normalized)
      : [];
    if (matches(folder)) {
      return {
        ...folder,
        ...(folder.children ? { children: sortFolders(folder.children) } : {}),
      } as T;
    }
    if (childMatches.length > 0) {
      return { ...folder, children: childMatches } as T;
    }
    return null;
  };

  return sorted.map(filterOne).filter((folder): folder is T => Boolean(folder));
}

export function dashboardMatchesSearch(document: DocumentLike, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    document.name,
    document.identifier,
    document.id,
    document.folderPath,
    document.folderId,
    document.baseModelName,
    document.baseModelId,
    document.connectionName,
    ...(document.labels || []).map(labelText),
  ].some((value) => value?.toLowerCase().includes(normalized));
}

export function instanceMatchesSearch(instance: InstanceLike, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    instance.label,
    instance.baseUrl,
    instance.role,
    instance.defaultModelId,
    instance.defaultFolderPath,
    instance.defaultFolderId,
    instance.id,
  ].some((value) => value?.toLowerCase().includes(normalized));
}
