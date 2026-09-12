import { useCallback, useEffect, useRef, useState } from 'react';
import { listInstanceFolderInventory, type InstanceFolder, type SavedInstancePublic } from '@/services/opsConsole';

export interface DestinationFolderCatalog {
  folders: InstanceFolder[];
  loading: boolean;
  loaded: boolean;
  complete: boolean;
  error: string;
}
export const EMPTY_FOLDER_CATALOG: DestinationFolderCatalog = { folders: [], loading: false, loaded: false, complete: false, error: '' };
export const destinationFolderCacheKey = (instance: Pick<SavedInstancePublic, 'id' | 'updatedAt'>) => `${instance.id}:${instance.updatedAt}`;

export function useDashboardDestinationFolders(enabled: boolean) {
  const [catalogs, setCatalogs] = useState<Record<string, DestinationFolderCatalog>>({});
  const catalogRef = useRef(catalogs);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    if (!enabled) {
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      catalogRef.current = {};
      setCatalogs({});
    }
    return () => {
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, [enabled]);

  const load = useCallback(async (instance: SavedInstancePublic, forceRefresh = false) => {
    if (!enabled) return;
    const key = destinationFolderCacheKey(instance);
    const previous = catalogRef.current[key] || EMPTY_FOLDER_CATALOG;
    if (previous.loading || (previous.loaded && !forceRefresh)) return;
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const publish = (catalog: DestinationFolderCatalog) => {
      if (controller.signal.aborted || controllers.current.get(key) !== controller) return;
      catalogRef.current = { ...catalogRef.current, [key]: catalog };
      setCatalogs(catalogRef.current);
    };
    publish({ ...previous, loading: true, error: '' });
    try {
      const response = await listInstanceFolderInventory(instance.id, { signal: controller.signal, forceRefresh });
      publish({ folders: response.folders, complete: response.pagination.complete === true, loading: false, loaded: true, error: '' });
    } catch (error) {
      publish({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Could not load destination folders.' });
    } finally {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    }
  }, [enabled]);
  return { catalogs, load };
}
