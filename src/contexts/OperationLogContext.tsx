import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OperationLogEntry, OperationType } from '@/types';
import { clearStore, getAllRecords, putRecord } from '@/services/localStore';

interface OperationLogContextValue {
  entries: OperationLogEntry[];
  addEntry: (entry: Omit<OperationLogEntry, 'id' | 'timestamp'>) => void;
  clearLog: () => void;
}

const OperationLogContext = createContext<OperationLogContextValue | null>(null);

let entryCounter = 0;

const MAX_ENTRIES = 500;

export function OperationLogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<OperationLogEntry[]>([]);

  useEffect(() => {
    getAllRecords<OperationLogEntry>('operations_log')
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ENTRIES);
        setEntries(sorted);
      })
      .catch(() => {
        // IndexedDB unavailable; continue in-memory only
      });
  }, []);

  const addEntry = useCallback((entry: Omit<OperationLogEntry, 'id' | 'timestamp'>) => {
    entryCounter += 1;
    const newEntry: OperationLogEntry = {
      ...entry,
      id: `op-${Date.now()}-${entryCounter}`,
      timestamp: Date.now(),
    };
    setEntries((prev) => [newEntry, ...prev].slice(0, MAX_ENTRIES));
    putRecord('operations_log', newEntry).catch(() => {
      // best-effort persistence
    });
  }, []);

  const clearLog = useCallback(() => {
    setEntries([]);
    clearStore('operations_log').catch(() => {
      // ignore
    });
  }, []);

  return (
    <OperationLogContext.Provider value={{ entries, addEntry, clearLog }}>
      {children}
    </OperationLogContext.Provider>
  );
}

export function useOperationLog() {
  const ctx = useContext(OperationLogContext);
  if (!ctx) throw new Error('useOperationLog must be used within OperationLogProvider');
  return ctx;
}

export function useLogOperation() {
  const { addEntry } = useOperationLog();

  return useCallback(
    (
      type: OperationType,
      description: string,
      opts: { itemCount?: number; successCount?: number; failureCount?: number; durationMs?: number } = {}
    ) => {
      addEntry({
        type,
        description,
        itemCount: opts.itemCount ?? 1,
        successCount: opts.successCount ?? 1,
        failureCount: opts.failureCount ?? 0,
        durationMs: opts.durationMs ?? 0,
      });
    },
    [addEntry]
  );
}

export type { OperationType };
