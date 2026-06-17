import type { ConnectionConfig } from '../types';

const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';

function isVaultApiKeyReference(value: string): boolean {
  return value.startsWith(VAULT_API_KEY_REFERENCE_PREFIX);
}

export function hasSavedVaultConnection(
  connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'connectionMode' | 'instanceId'>,
) {
  return connection.connectionMode === 'vault'
    && Boolean(connection.instanceId)
    && Boolean(connection.baseUrl.trim())
    && isVaultApiKeyReference(connection.apiKey);
}

export function hasActiveSavedVaultConnection(
  connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'connectionMode' | 'instanceId' | 'status'>,
) {
  return hasSavedVaultConnection(connection) && connection.status === 'success';
}

export function getConnectionCacheKey(connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'instanceId'>) {
  return [
    connection.instanceId || connection.baseUrl.trim(),
    connection.apiKey ? 'key-present' : 'no-key',
  ].join('|');
}
