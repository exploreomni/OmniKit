/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection } from '@/hooks/useConnection';
import {
  connectSavedInstance,
  getVaultStatus,
  listSavedInstances,
  touchNativeVault,
  unlockNativeVault,
  vaultApiKeyReference,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { onVaultChanged, onVaultLocked } from '@/services/vaultEvents';
import { hasActiveSavedVaultConnection } from '@/services/connectionGuards';
import { instanceConnectionDiagnosticFromError } from '@/services/instanceConnectionDiagnostics';
import { toast } from '@/services/toast';
import { INSTANCE_CONNECTION_ERROR_CODES } from '../../shared/instanceConnectionErrors';

export type VaultSessionState = 'unknown' | 'no-vault' | 'locked' | 'unlocked';

interface VaultUnlockResult {
  activeInstance?: SavedInstancePublic;
  resumedInstance?: SavedInstancePublic;
  resetConnection?: boolean;
}

interface ConnectListedInstanceOptions {
  notify?: boolean;
}

interface VaultSessionContextValue {
  status: VaultSessionState;
  vaultStatus: VaultStatus | null;
  instances: SavedInstancePublic[];
  loading: boolean;
  lockedMessage: string;
  refreshStatus: () => Promise<VaultStatus | null>;
  refreshInstances: () => Promise<SavedInstancePublic[]>;
  unlock: (passphrase: string) => Promise<VaultUnlockResult>;
  touch: () => Promise<void>;
  connectInstance: (instanceId: string) => Promise<SavedInstancePublic>;
}

const VaultSessionContext = createContext<VaultSessionContextValue | null>(null);

function sessionStateFromStatus(status: VaultStatus | null): VaultSessionState {
  if (!status) return 'unknown';
  if (!status.exists) return 'no-vault';
  return status.unlocked ? 'unlocked' : 'locked';
}

export function VaultSessionProvider({ children }: { children: ReactNode }) {
  const { connection, updateConnection, resetConnection } = useConnection();
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [lockedMessage, setLockedMessage] = useState('');
  const connectSequenceRef = useRef(0);
  const connectAbortRef = useRef<AbortController | null>(null);
  const catalogSequenceRef = useRef(0);
  const instancesRef = useRef<SavedInstancePublic[]>([]);
  const autoConnectAttemptRef = useRef('');
  const suppressDefaultAutoConnectRef = useRef(false);

  const replaceInstances = useCallback((nextInstances: SavedInstancePublic[]) => {
    instancesRef.current = nextInstances;
    setInstances(nextInstances);
  }, []);

  useEffect(() => () => {
    connectSequenceRef.current += 1;
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
  }, []);

  const refreshStatus = useCallback(async () => {
    const status = await getVaultStatus();
    setVaultStatus(status);
    if (!status.unlocked) {
      catalogSequenceRef.current += 1;
      replaceInstances([]);
    }
    return status;
  }, [replaceInstances]);

  const refreshInstances = useCallback(async () => {
    const sequence = catalogSequenceRef.current + 1;
    catalogSequenceRef.current = sequence;
    const status = await getVaultStatus();
    if (catalogSequenceRef.current !== sequence) return [];
    setVaultStatus(status);
    if (!status.unlocked) {
      replaceInstances([]);
      return [];
    }
    const result = await listSavedInstances();
    if (catalogSequenceRef.current === sequence) replaceInstances(result.instances);
    return result.instances;
  }, [replaceInstances]);

  useEffect(() => {
    let active = true;
    async function load() {
      const sequence = catalogSequenceRef.current + 1;
      catalogSequenceRef.current = sequence;
      setLoading(true);
      try {
        const status = await getVaultStatus();
        if (!active || catalogSequenceRef.current !== sequence) return;
        setVaultStatus(status);
        if (status.unlocked) {
          const result = await listSavedInstances();
          if (active && catalogSequenceRef.current === sequence) replaceInstances(result.instances);
        } else {
          replaceInstances([]);
        }
      } catch {
        if (active) {
          setVaultStatus(null);
          replaceInstances([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [replaceInstances]);

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
    connectSequenceRef.current += 1;
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    autoConnectAttemptRef.current = '';
    suppressDefaultAutoConnectRef.current = false;
    setLockedMessage(message);
    void refreshStatus().catch(() => undefined);
  }), [refreshStatus]);

  useEffect(() => {
    if (!vaultStatus || vaultStatus.unlocked) return;
    if (connection.connectionMode !== 'vault' || connection.status !== 'success') return;
    updateConnection({
      status: 'untested',
      errorMessage: lockedMessage || 'Vault locked — unlock to resume.',
      errorCode: undefined,
    });
  }, [connection.connectionMode, connection.status, lockedMessage, updateConnection, vaultStatus]);

  useEffect(() => {
    if (loading || !vaultStatus?.unlocked || connection.connectionMode !== 'vault' || !connection.instanceId) return;
    const activeInstance = instances.find((instance) => instance.id === connection.instanceId);
    if (!activeInstance) {
      suppressDefaultAutoConnectRef.current = true;
      autoConnectAttemptRef.current = '';
      resetConnection();
      return;
    }
    const validationInvalidated = connection.status === 'success' && !activeInstance.lastValidatedAt;
    if (
      connection.baseUrl !== activeInstance.baseUrl
      || connection.instanceLabel !== activeInstance.label
      || connection.apiKeyMasked !== activeInstance.apiKeyMasked
      || validationInvalidated
    ) {
      updateConnection({
        baseUrl: activeInstance.baseUrl,
        instanceLabel: activeInstance.label,
        apiKeyMasked: activeInstance.apiKeyMasked,
        ...(validationInvalidated ? {
          status: 'untested' as const,
          errorMessage: 'This saved instance changed. Reconnect before continuing.',
          errorCode: INSTANCE_CONNECTION_ERROR_CODES.credentialChanged,
        } : {}),
      });
    }
  }, [
    connection.apiKeyMasked,
    connection.baseUrl,
    connection.connectionMode,
    connection.instanceId,
    connection.instanceLabel,
    connection.status,
    instances,
    loading,
    resetConnection,
    updateConnection,
    vaultStatus?.unlocked,
  ]);

  const connectListedInstance = useCallback(async (
    instanceId: string,
    availableInstances: SavedInstancePublic[],
    options: ConnectListedInstanceOptions = {},
  ) => {
    if (!instanceId) throw new Error('Choose a saved instance first.');
    const targetInstance = availableInstances.find((instance) => instance.id === instanceId);
    if (!targetInstance) throw new Error('The selected saved instance is no longer available. Refresh the instance list and try again.');
    autoConnectAttemptRef.current = targetInstance.id;

    const pendingController = connectAbortRef.current;
    if (
      pendingController
      && hasActiveSavedVaultConnection(connection)
      && connection.instanceId === targetInstance.id
    ) {
      // Choosing the still-active instance is a cancellation of the pending
      // switch, not a reason to revalidate or downgrade the verified scope.
      connectSequenceRef.current += 1;
      connectAbortRef.current = null;
      pendingController.abort();
      return targetInstance;
    }

    const sequence = connectSequenceRef.current + 1;
    connectSequenceRef.current = sequence;
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;
    const isCurrentIntent = () => (
      connectSequenceRef.current === sequence
      && connectAbortRef.current === controller
      && !controller.signal.aborted
    );
    const staleIntentError = () => new DOMException('The connection switch was superseded.', 'AbortError');

    const pendingConnection = {
      baseUrl: targetInstance.baseUrl,
      apiKey: vaultApiKeyReference(targetInstance.id),
      status: 'testing' as const,
      errorMessage: '',
      errorCode: undefined,
      connectionMode: 'vault' as const,
      instanceId: targetInstance.id,
      instanceLabel: targetInstance.label,
      apiKeyMasked: targetInstance.apiKeyMasked,
    };
    const preservesDifferentActiveInstance = hasActiveSavedVaultConnection(connection)
      && connection.instanceId !== targetInstance.id;
    // Switching is atomic: a failed attempt to move from verified instance A to
    // B leaves A active. A reconnect of the same unverified instance, however,
    // owns that scope and must expose testing/error rather than stale success.
    if (!preservesDifferentActiveInstance) updateConnection(pendingConnection);

    try {
      const result = await connectSavedInstance(instanceId, controller.signal);
      if (!isCurrentIntent()) throw staleIntentError();
      const exactReference = vaultApiKeyReference(targetInstance.id);
      const validatedAt = Date.parse(result.instance.lastValidatedAt || '');
      if (
        result.instance.id !== targetInstance.id
        || result.connection.instanceId !== targetInstance.id
        || result.connection.apiKey !== exactReference
        || result.connection.connectionMode !== 'vault'
        || result.connection.status !== 'success'
        || !result.connection.baseUrl.trim()
        || result.connection.baseUrl !== result.instance.baseUrl
        || result.connection.instanceLabel !== result.instance.label
        || !Number.isFinite(validatedAt)
      ) {
        throw new Error('OmniKit received a mismatched saved-instance connection. Reconnect from the vault and try again.');
      }
      updateConnection({ ...result.connection, errorMessage: '', errorCode: undefined });
      setVaultStatus((current) => current ? { ...current, unlocked: true, lastActivityAt: Date.now() } : current);
      catalogSequenceRef.current += 1;
      let replaced = false;
      const nextInstances = instancesRef.current.map((instance) => {
        if (instance.id !== result.instance.id) return instance;
        replaced = true;
        return result.instance;
      });
      replaceInstances(replaced ? nextInstances : [...nextInstances, result.instance]);
      suppressDefaultAutoConnectRef.current = false;
      if (options.notify !== false) {
        toast({
          type: 'success',
          title: `Connected to ${result.instance.label}`,
          detail: 'Using a native-vault reference token. The browser did not receive the plaintext API key.',
          duration: 3500,
        });
      }
      return result.instance;
    } catch (error) {
      if (!isCurrentIntent()) throw staleIntentError();
      const diagnostic = instanceConnectionDiagnosticFromError(error);
      if (!preservesDifferentActiveInstance) {
        updateConnection({
          ...pendingConnection,
          status: 'error',
          errorMessage: diagnostic.message,
          errorCode: diagnostic.code,
        });
      }
      throw error;
    } finally {
      if (connectAbortRef.current === controller) connectAbortRef.current = null;
    }
  }, [connection, replaceInstances, updateConnection]);

  const unlock = useCallback(async (passphrase: string): Promise<VaultUnlockResult> => {
    const intentAtUnlockStart = connectSequenceRef.current;
    const previousInstanceId = connection.connectionMode === 'vault' ? connection.instanceId : undefined;
    // The vault-change event may publish the unlocked catalog before this
    // function finishes reading it. Hold bootstrap work here so a slow
    // automatic selection can never outrank a newer human choice.
    autoConnectAttemptRef.current = '';
    suppressDefaultAutoConnectRef.current = true;
    let result: Awaited<ReturnType<typeof unlockNativeVault>>;
    try {
      result = await unlockNativeVault(passphrase);
    } catch (error) {
      suppressDefaultAutoConnectRef.current = false;
      throw error;
    }
    const sequence = catalogSequenceRef.current + 1;
    catalogSequenceRef.current = sequence;
    let nextInstances: Awaited<ReturnType<typeof listSavedInstances>>;
    try {
      nextInstances = result.status.unlocked ? await listSavedInstances() : { instances: [] };
    } catch (error) {
      suppressDefaultAutoConnectRef.current = false;
      throw error;
    }
    if (catalogSequenceRef.current === sequence) {
      setVaultStatus(result.status);
      replaceInstances(nextInstances.instances);
    }
    setLockedMessage('');
    if (!result.status.unlocked) {
      suppressDefaultAutoConnectRef.current = false;
      return {};
    }

    const targetInstance = previousInstanceId
      ? nextInstances.instances.find((instance) => instance.id === previousInstanceId)
      : nextInstances.instances[0];
    if (previousInstanceId && !targetInstance) {
      suppressDefaultAutoConnectRef.current = true;
      resetConnection();
      toast({
        type: 'warning',
        title: 'Saved instance no longer available',
        detail: 'The vault unlocked, but the previous instance was not found. Choose a saved instance to continue.',
        duration: 5000,
      });
      return { resetConnection: true };
    }
    if (!targetInstance) {
      suppressDefaultAutoConnectRef.current = false;
      return {};
    }

    if (connectSequenceRef.current !== intentAtUnlockStart) {
      suppressDefaultAutoConnectRef.current = false;
      return {};
    }

    autoConnectAttemptRef.current = targetInstance.id;
    suppressDefaultAutoConnectRef.current = false;
    try {
      const activeInstance = await connectListedInstance(
        targetInstance.id,
        nextInstances.instances,
        { notify: false },
      );
      toast({
        type: 'success',
        title: previousInstanceId ? `Resumed ${activeInstance.label}` : `Connected to ${activeInstance.label}`,
        detail: previousInstanceId
          ? 'Vault unlocked and the previous saved instance is active again.'
          : 'Vault unlocked and the first saved instance is active.',
        duration: 3500,
      });
      return {
        activeInstance,
        ...(previousInstanceId ? { resumedInstance: activeInstance } : {}),
      };
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast({
          type: 'warning',
          title: previousInstanceId ? 'Could not resume saved instance' : 'Could not connect the first saved instance',
          detail: error instanceof Error ? error.message : 'Choose a saved instance to continue.',
          duration: 5000,
        });
      }
      return {};
    }
  }, [connectListedInstance, connection.connectionMode, connection.instanceId, replaceInstances, resetConnection]);

  const touch = useCallback(async () => {
    const result = await touchNativeVault();
    setVaultStatus(result.status);
  }, []);

  const connectInstance = useCallback(
    (instanceId: string) => connectListedInstance(instanceId, instancesRef.current),
    [connectListedInstance],
  );

  useEffect(() => {
    if (loading || !vaultStatus?.unlocked || instances.length === 0) return;
    if (suppressDefaultAutoConnectRef.current) return;

    const previousInstanceId = connection.connectionMode === 'vault' ? connection.instanceId : undefined;
    const targetInstance = previousInstanceId
      ? instances.find((instance) => instance.id === previousInstanceId)
      : instances[0];
    if (previousInstanceId && !targetInstance) {
      suppressDefaultAutoConnectRef.current = true;
      return;
    }
    if (!targetInstance) return;
    if (
      hasActiveSavedVaultConnection(connection)
      && connection.instanceId === targetInstance.id
    ) return;
    if (autoConnectAttemptRef.current === targetInstance.id) return;

    autoConnectAttemptRef.current = targetInstance.id;
    void connectListedInstance(targetInstance.id, instances, { notify: false }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast({
        type: 'warning',
        title: previousInstanceId ? 'Could not resume saved instance' : 'Could not connect the first saved instance',
        detail: error instanceof Error ? error.message : 'Choose a saved instance to continue.',
        duration: 5000,
      });
    });
  }, [connectListedInstance, connection, instances, loading, vaultStatus?.unlocked]);

  const value = useMemo<VaultSessionContextValue>(() => ({
    status: sessionStateFromStatus(vaultStatus),
    vaultStatus,
    instances,
    loading,
    lockedMessage,
    refreshStatus,
    refreshInstances,
    unlock,
    touch,
    connectInstance,
  }), [
    connectInstance,
    instances,
    loading,
    lockedMessage,
    refreshInstances,
    refreshStatus,
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
