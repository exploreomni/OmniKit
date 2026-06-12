/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@/contexts/ConnectionContext';
import {
  connectSavedInstance,
  getVaultStatus,
  listSavedInstances,
  lockNativeVault,
  testSavedInstance,
  touchNativeVault,
  unlockNativeVault,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { onVaultChanged, onVaultLocked } from '@/services/vaultEvents';
import { toast } from '@/components/ui/Toast';

export type VaultSessionState = 'unknown' | 'no-vault' | 'locked' | 'unlocked';

interface VaultTestResult {
  ok: boolean;
  error?: string;
}

interface VaultSessionContextValue {
  status: VaultSessionState;
  vaultStatus: VaultStatus | null;
  instances: SavedInstancePublic[];
  loading: boolean;
  lockedMessage: string;
  refreshStatus: () => Promise<VaultStatus | null>;
  refreshInstances: () => Promise<SavedInstancePublic[]>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => Promise<void>;
  touch: () => Promise<void>;
  connectInstance: (instanceId: string) => Promise<SavedInstancePublic>;
  testInstance: (instanceId: string) => Promise<VaultTestResult>;
}

const VaultSessionContext = createContext<VaultSessionContextValue | null>(null);

function sessionStateFromStatus(status: VaultStatus | null): VaultSessionState {
  if (!status) return 'unknown';
  if (!status.exists) return 'no-vault';
  return status.unlocked ? 'unlocked' : 'locked';
}

export function VaultSessionProvider({ children }: { children: ReactNode }) {
  const { updateConnection } = useConnection();
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [lockedMessage, setLockedMessage] = useState('');

  const refreshStatus = useCallback(async () => {
    const status = await getVaultStatus();
    setVaultStatus(status);
    if (!status.unlocked) setInstances([]);
    return status;
  }, []);

  const refreshInstances = useCallback(async () => {
    const status = await refreshStatus();
    if (!status?.unlocked) return [];
    const result = await listSavedInstances();
    setInstances(result.instances);
    return result.instances;
  }, [refreshStatus]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const status = await getVaultStatus();
        if (!active) return;
        setVaultStatus(status);
        if (status.unlocked) {
          const result = await listSavedInstances();
          if (active) setInstances(result.instances);
        } else {
          setInstances([]);
        }
      } catch {
        if (active) {
          setVaultStatus(null);
          setInstances([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onFocus = () => {
      void refreshInstances().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshInstances]);

  useEffect(() => onVaultChanged(() => {
    void refreshInstances().catch(() => undefined);
  }), [refreshInstances]);

  useEffect(() => onVaultLocked((message) => {
    setLockedMessage(message);
    void refreshStatus().catch(() => undefined);
  }), [refreshStatus]);

  const unlock = useCallback(async (passphrase: string) => {
    const result = await unlockNativeVault(passphrase);
    setVaultStatus(result.status);
    const nextInstances = result.status.unlocked ? await listSavedInstances() : { instances: [] };
    setInstances(nextInstances.instances);
    setLockedMessage('');
  }, []);

  const lock = useCallback(async () => {
    const result = await lockNativeVault();
    setVaultStatus(result.status);
    setInstances([]);
  }, []);

  const touch = useCallback(async () => {
    const result = await touchNativeVault();
    setVaultStatus(result.status);
  }, []);

  const connectInstance = useCallback(async (instanceId: string) => {
    if (!instanceId) throw new Error('Choose a saved instance first.');
    const result = await connectSavedInstance(instanceId);
    updateConnection({ ...result.connection, errorMessage: '' });
    setVaultStatus((current) => current ? { ...current, unlocked: true, lastActivityAt: Date.now() } : current);
    setInstances((current) => current.map((instance) => (
      instance.id === result.instance.id ? result.instance : instance
    )));
    toast({
      type: 'success',
      title: `Connected to ${result.instance.label}`,
      detail: 'Using a native-vault reference token. The browser did not receive the plaintext API key.',
      duration: 3500,
    });
    return result.instance;
  }, [updateConnection]);

  const testInstance = useCallback(async (instanceId: string): Promise<VaultTestResult> => {
    try {
      const result = await testSavedInstance(instanceId);
      setInstances((current) => current.map((instance) => (
        instance.id === result.instance.id ? result.instance : instance
      )));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not test this instance.' };
    }
  }, []);

  const value = useMemo<VaultSessionContextValue>(() => ({
    status: sessionStateFromStatus(vaultStatus),
    vaultStatus,
    instances,
    loading,
    lockedMessage,
    refreshStatus,
    refreshInstances,
    unlock,
    lock,
    touch,
    connectInstance,
    testInstance,
  }), [
    connectInstance,
    instances,
    loading,
    lock,
    lockedMessage,
    refreshInstances,
    refreshStatus,
    testInstance,
    touch,
    unlock,
    vaultStatus,
  ]);

  return (
    <VaultSessionContext.Provider value={value}>
      {children}
    </VaultSessionContext.Provider>
  );
}

export function useVaultSession() {
  const context = useContext(VaultSessionContext);
  if (!context) throw new Error('useVaultSession must be used within VaultSessionProvider');
  return context;
}
