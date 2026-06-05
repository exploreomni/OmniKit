import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react';
import type { ConnectionConfig, ConnectionStatus } from '@/types';
import { isVaultApiKeyReference } from '@/services/opsConsole';

interface ConnectionState {
  connection: ConnectionConfig;
  isConnected: boolean;
}

type ConnectionAction =
  | { type: 'UPDATE'; payload: Partial<ConnectionConfig> }
  | { type: 'RESET' };

const initialConnection: ConnectionConfig = {
  baseUrl: '',
  apiKey: '',
  status: 'untested',
  errorMessage: '',
  connectionMode: 'manual',
};

const SESSION_CONNECTION_KEY = 'omnikit:activeConnection:v1';

function readSessionConnection(): ConnectionConfig {
  if (typeof window === 'undefined') return { ...initialConnection };

  try {
    const raw = window.sessionStorage.getItem(SESSION_CONNECTION_KEY);
    if (!raw) return { ...initialConnection };

    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '';
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
    const instanceId = typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined;
    const connectionMode = parsed.connectionMode === 'vault' && instanceId ? 'vault' : 'manual';
    const isVaultReference = connectionMode === 'vault' && apiKey && isVaultApiKeyReference(apiKey);
    const status = parsed.status === 'success' && baseUrl && (apiKey || instanceId) ? 'success' : 'untested';

    return {
      baseUrl,
      apiKey: connectionMode === 'vault' && !isVaultReference ? '' : apiKey,
      status,
      errorMessage: '',
      connectionMode,
      instanceId,
      instanceLabel: typeof parsed.instanceLabel === 'string' ? parsed.instanceLabel : undefined,
      apiKeyMasked: typeof parsed.apiKeyMasked === 'string' ? parsed.apiKeyMasked : undefined,
    };
  } catch {
    return { ...initialConnection };
  }
}

function writeSessionConnection(connection: ConnectionConfig) {
  if (typeof window === 'undefined') return;

  try {
    if (!connection.baseUrl && !connection.apiKey && !connection.instanceId) {
      window.sessionStorage.removeItem(SESSION_CONNECTION_KEY);
      return;
    }

    const isVaultConnection = connection.connectionMode === 'vault' && connection.instanceId;
    window.sessionStorage.setItem(
      SESSION_CONNECTION_KEY,
      JSON.stringify({
        baseUrl: connection.baseUrl,
        apiKey: isVaultConnection
          ? (isVaultApiKeyReference(connection.apiKey) ? connection.apiKey : '')
          : connection.apiKey,
        status: connection.status,
        connectionMode: isVaultConnection ? 'vault' : 'manual',
        instanceId: isVaultConnection ? connection.instanceId : undefined,
        instanceLabel: isVaultConnection ? connection.instanceLabel : undefined,
        apiKeyMasked: isVaultConnection ? connection.apiKeyMasked : undefined,
      }),
    );
  } catch {
    // Session persistence is convenience-only. Keep the in-memory connection usable if storage is blocked.
  }
}

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'UPDATE': {
      const connection = { ...state.connection, ...action.payload };
      return { connection, isConnected: connection.status === 'success' };
    }
    case 'RESET':
      return { connection: { ...initialConnection }, isConnected: false };
    default:
      return state;
  }
}

interface ConnectionContextValue {
  connection: ConnectionConfig;
  isConnected: boolean;
  updateConnection: (payload: Partial<ConnectionConfig>) => void;
  resetConnection: () => void;
  setStatus: (status: ConnectionStatus, errorMessage?: string) => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(connectionReducer, undefined, () => {
    const connection = readSessionConnection();
    return {
      connection,
      isConnected: connection.status === 'success',
    };
  });

  useEffect(() => {
    writeSessionConnection(state.connection);
  }, [state.connection]);

  const updateConnection = useCallback((payload: Partial<ConnectionConfig>) => {
    writeSessionConnection({ ...state.connection, ...payload });
    dispatch({ type: 'UPDATE', payload });
  }, [state.connection]);

  const resetConnection = useCallback(() => {
    writeSessionConnection({ ...initialConnection });
    dispatch({ type: 'RESET' });
  }, []);

  const setStatus = useCallback((status: ConnectionStatus, errorMessage = '') => {
    writeSessionConnection({ ...state.connection, status, errorMessage });
    dispatch({ type: 'UPDATE', payload: { status, errorMessage } });
  }, [state.connection]);

  return (
    <ConnectionContext.Provider value={{
      connection: state.connection,
      isConnected: state.isConnected,
      updateConnection,
      resetConnection,
      setStatus,
    }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider');
  return ctx;
}
