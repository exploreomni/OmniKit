import { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react';
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
  const [state, dispatch] = useReducer(connectionReducer, {
    connection: { ...initialConnection },
    isConnected: false,
  });

  const updateConnection = useCallback((payload: Partial<ConnectionConfig>) => {
    dispatch({ type: 'UPDATE', payload });
  }, []);

  const resetConnection = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const setStatus = useCallback((status: ConnectionStatus, errorMessage = '') => {
    dispatch({ type: 'UPDATE', payload: { status, errorMessage } });
  }, []);

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
