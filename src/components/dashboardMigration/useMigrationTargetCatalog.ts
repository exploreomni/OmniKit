import { useCallback, useState } from 'react';
import {
  listInstanceFolders,
  listInstanceModels,
  type InstanceFolder,
} from '@/services/opsConsole';
import { compareCatalogText, folderDisplayLabel, sortModels } from '../../utils/catalogSort';
import type { DashboardMigrationTargetCatalog, DashboardMigrationTargetDraft } from './dashboardMigrationTypes';

function flattenFolders(folders: InstanceFolder[], prefix = ''): InstanceFolder[] {
  const rows: InstanceFolder[] = [];
  for (const folder of folders) {
    const displayPath = folder.path || folder.identifier || (prefix ? `${prefix}/${folder.name}` : folder.name);
    rows.push({ ...folder, path: displayPath });
    if (folder.children?.length) rows.push(...flattenFolders(folder.children, displayPath));
  }
  return rows;
}

export function useMigrationTargetCatalog() {
  const [catalogs, setCatalogs] = useState<Record<string, DashboardMigrationTargetCatalog>>({});

  const loadCatalog = useCallback(async (instanceId: string, options?: { force?: boolean }) => {
    if (!instanceId) return null;
    const current = catalogs[instanceId];
    if (current?.loading) return null;
    if (current?.loaded && !options?.force) return current;
    setCatalogs((prev) => ({
      ...prev,
      [instanceId]: {
        connections: prev[instanceId]?.connections || [],
        models: [],
        folders: prev[instanceId]?.folders || [],
        loading: true,
        loaded: prev[instanceId]?.loaded || false,
        error: '',
      } as DashboardMigrationTargetCatalog,
    }));
    try {
      const [modelsRes, foldersRes] = await Promise.all([
        listInstanceModels(instanceId),
        listInstanceFolders(instanceId),
      ]);
      const next = {
        connections: [],
        models: sortModels(modelsRes.models),
        folders: flattenFolders(foldersRes.folders)
          .sort((a, b) => compareCatalogText(folderDisplayLabel(a), folderDisplayLabel(b))),
        loading: false,
        loaded: true,
        error: '',
      } as DashboardMigrationTargetCatalog;
      setCatalogs((prev) => ({ ...prev, [instanceId]: next }));
      return next;
    } catch (error) {
      const next = {
        connections: current?.connections || [],
        models: [],
        folders: current?.folders || [],
        loading: false,
        loaded: false,
        error: error instanceof Error ? error.message : 'Could not load target models and folders.',
      } as DashboardMigrationTargetCatalog;
      setCatalogs((prev) => ({ ...prev, [instanceId]: next }));
      return next;
    }
  }, [catalogs]);

  const hydrateTargetFromCatalog = useCallback((target: DashboardMigrationTargetDraft, catalog: DashboardMigrationTargetCatalog | null | undefined): DashboardMigrationTargetDraft => {
    if (!catalog) return target;
    const model = catalog.models.find((row) => row.id === target.targetModelId);
    const folder = catalog.folders.find((row) => row.id === target.targetFolderId || row.path === target.targetFolderPath);
    return {
      ...target,
      targetModelName: model?.name || target.targetModelName,
      targetFolderId: folder?.id || target.targetFolderId,
      targetFolderPath: folder?.path || target.targetFolderPath,
    };
  }, []);

  return {
    catalogs,
    loadCatalog,
    hydrateTargetFromCatalog,
  };
}
