const DB_NAME = 'omnikit-local';
const DB_VERSION = 1;

export const STORES = [
  'operations_log',
  'content_validation_runs',
  'permission_snapshots',
  'permission_audit',
  'branch_activity',
  'schedule_run_history',
  'ai_conversations',
  'ai_messages',
  'embed_templates',
  'dashboard_filter_presets',
  'deck_filter_defaults',
  'saved_views',
  'notifications',
  'settings',
] as const;

export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(store, mode).objectStore(store);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRecord<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  const s = await tx(store, 'readwrite');
  await promisify(s.put(value));
}

export async function getRecord<T>(store: StoreName, id: string): Promise<T | null> {
  const s = await tx(store, 'readonly');
  const res = await promisify<T | undefined>(s.get(id) as IDBRequest<T | undefined>);
  return res ?? null;
}

export async function getAllRecords<T>(store: StoreName): Promise<T[]> {
  const s = await tx(store, 'readonly');
  return promisify<T[]>(s.getAll() as IDBRequest<T[]>);
}

export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  const s = await tx(store, 'readwrite');
  await promisify(s.delete(id));
}

export async function clearStore(store: StoreName): Promise<void> {
  const s = await tx(store, 'readwrite');
  await promisify(s.clear());
}

export async function countStore(store: StoreName): Promise<number> {
  const s = await tx(store, 'readonly');
  return promisify<number>(s.count());
}

export async function exportAll(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of STORES) {
    out[name] = await getAllRecords(name);
  }
  return out;
}

export async function importAll(data: Record<string, unknown[]>, mode: 'merge' | 'replace'): Promise<void> {
  const db = await openDb();
  for (const name of STORES) {
    if (!Array.isArray(data[name])) continue;
    const t = db.transaction(name, 'readwrite');
    const s = t.objectStore(name);
    if (mode === 'replace') {
      await promisify(s.clear());
    }
    for (const row of data[name] as Array<{ id?: string }>) {
      if (row && typeof row === 'object' && row.id) {
        await promisify(s.put(row));
      }
    }
  }
}

export async function storageSummary(): Promise<Array<{ store: StoreName; count: number }>> {
  const results = await Promise.all(
    STORES.map(async (name) => ({ store: name, count: await countStore(name) })),
  );
  return results;
}
