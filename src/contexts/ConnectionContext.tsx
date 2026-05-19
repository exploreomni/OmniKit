import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react';
import type { ConnectionConfig, ConnectionStatus } from '@/types';

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
    const status = parsed.status === 'success' && baseUrl && apiKey ? 'success' : 'untested';

    return {
      baseUrl,
      apiKey,
      status,
      errorMessage: '',
    };
  } catch {
    return { ...initialConnection };
  }
}

function writeSessionConnection(connection: ConnectionConfig) {
  if (typeof window === 'undefined') return;

  try {
    if (!connection.baseUrl && !connection.apiKey) {
      window.sessionStorage.removeItem(SESSION_CONNECTION_KEY);
      return;
    }

    window.sessionStorage.setItem(
      SESSION_CONNECTION_KEY,
      JSON.stringify({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        status: connection.status,
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
