import { useCallback, useEffect, useRef } from 'react';
import type { ConnectionConfig } from '@/types';

export function getConnectionRequestKey(connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'instanceId'>) {
  return [
    connection.instanceId || connection.baseUrl.trim(),
    connection.apiKey ? 'key-present' : 'no-key',
  ].join('|');
}

export function useConnectionRequestGuard(connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'instanceId'>) {
  const connectionKey = getConnectionRequestKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);

  useEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
  }, [connectionKey]);

  const isActiveConnectionRequest = useCallback((requestKey: string) => (
    activeConnectionKeyRef.current === requestKey
  ), []);

  return { connectionKey, isActiveConnectionRequest };
}
