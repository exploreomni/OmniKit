export const VAULT_LOCKED_EVENT = 'omnikit:vault-locked';
export const VAULT_CHANGED_EVENT = 'omnikit:vault-changed';

export function emitVaultLocked(message = 'Unlock the native vault before continuing.'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VAULT_LOCKED_EVENT, { detail: { message } }));
}

export function emitVaultChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VAULT_CHANGED_EVENT));
}

export function onVaultLocked(listener: (message: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = event instanceof CustomEvent ? event.detail as { message?: string } | undefined : undefined;
    listener(detail?.message || 'Unlock the native vault before continuing.');
  };
  window.addEventListener(VAULT_LOCKED_EVENT, handler);
  return () => window.removeEventListener(VAULT_LOCKED_EVENT, handler);
}

export function onVaultChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(VAULT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(VAULT_CHANGED_EVENT, listener);
}
