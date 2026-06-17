import { useCallback, useState } from 'react';
import {
  listInstanceFolders,
  listInstanceModels,
  type InstanceFolder,
} from '@/services/opsConsole';
import type { TargetCatalog, TargetDraft } from './fanoutTypes';

function flattenFolders(folders: InstanceFolder[], prefix = ''): InstanceFolder[] {
  const rows: InstanceFolder[] = [];
  for (const folder of folders) {
    const displayPath = folder.path || folder.identifier || (prefix ? `${prefix}/${folder.name}` : folder.name);
    rows.push({ ...folder, path: displayPath });
    if (folder.children?.length) rows.push(...flattenFolders(folder.children, displayPath));
  }
  return rows;
}

export function useTargetCatalog() {
  const [catalogs, setCatalogs] = useState<Record<string, TargetCatalog>>({});

  const loadCatalog = useCallback(async (instanceId: string, options?: { force?: boolean }) => {
    if (!instanceId) return null;
    const current = catalogs[instanceId];
    if (current?.loading) return null;
    if (current?.loaded && !options?.force) return current;
    setCatalogs((prev) => ({
      ...prev,
      [instanceId]: {
        models: prev[instanceId]?.models || [],
        folders: prev[instanceId]?.folders || [],
        loading: true,
        loaded: prev[instanceId]?.loaded || false,
        error: '',
      },
    }));
    try {
      const [modelsRes, foldersRes] = await Promise.all([
        listInstanceModels(instanceId),
        listInstanceFolders(instanceId),
      ]);
      const next = {
        models: modelsRes.models,
        folders: flattenFolders(foldersRes.folders),
        loading: false,
        loaded: true,
        error: '',
      };
      setCatalogs((prev) => ({ ...prev, [instanceId]: next }));
      return next;
    } catch (error) {
      const next = {
        models: current?.models || [],
        folders: current?.folders || [],
        loading: false,
        loaded: false,
        error: error instanceof Error ? error.message : 'Could not load target models and folders.',
      };
      setCatalogs((prev) => ({ ...prev, [instanceId]: next }));
      return next;
    }
  }, [catalogs]);

  const hydrateTargetFromCatalog = useCallback((target: TargetDraft, catalog: TargetCatalog | null | undefined): TargetDraft => {
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
