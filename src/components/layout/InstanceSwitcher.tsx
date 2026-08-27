import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, Clock, KeyRound, Loader2, Lock, Server, ShieldCheck, UnlockKeyhole } from 'lucide-react';
import { PassphraseInput } from '@/components/ui/PassphraseInput';
import { ConnectionFailureDetails } from '@/components/ui/ConnectionFailureDetails';
import { useConnection } from '@/hooks/useConnection';
import { useVaultSession } from '@/hooks/useVaultSession';
import { hasActiveSavedVaultConnection, hasSavedVaultConnection } from '@/services/connectionGuards';
import {
  instanceConnectionDiagnosticFromError,
  instanceConnectionDiagnosticFromState,
  type InstanceConnectionDiagnostic,
} from '@/services/instanceConnectionDiagnostics';

const PRIMARY_ACTION_CLASS = 'flex min-h-9 w-full items-center justify-center gap-2 rounded-[6px] bg-brand-wine px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_ACTION_CLASS = 'flex min-h-9 w-full items-center justify-center gap-2 rounded-[6px] border border-border-strong bg-surface-primary px-3 py-2 text-xs font-semibold text-omni-900 transition-colors hover:border-brand-wine hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine';

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function roleLabel(role: string): string {
  if (role === 'both') return 'Source + destination';
  return role === 'source' ? 'Source' : 'Destination';
}

function isRecentlyValidated(value?: string): boolean {
  if (!value) return false;
  const validatedAt = Date.parse(value);
  if (!Number.isFinite(validatedAt)) return false;
  return Date.now() - validatedAt < 24 * 60 * 60 * 1000;
}

function validationLabel(value?: string): string {
  if (!value) return 'Not tested recently';
  const validatedAt = Date.parse(value);
  if (!Number.isFinite(validatedAt)) return 'Validation age unknown';
  return isRecentlyValidated(value) ? 'Tested in the last 24h' : 'Test again recommended';
}

function instanceHost(baseUrl?: string): string {
  if (!baseUrl) return 'Saved Omni instance';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'Saved Omni instance';
  }
}

export function InstanceSwitcher() {
  const { connection } = useConnection();
  const {
    status,
    vaultStatus,
    instances,
    loading,
    lockedMessage,
    unlock,
    connectInstance,
    touch,
    refreshStatus,
  } = useVaultSession();
  const panelId = useId();
  const passphraseInputId = `${panelId}-passphrase`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const checkedExpiryRef = useRef<number | null>(null);
  const connectUiSequenceRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectingInstanceId, setConnectingInstanceId] = useState('');
  const [error, setError] = useState<InstanceConnectionDiagnostic | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!vaultStatus?.unlocked) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [vaultStatus?.unlocked]);

  useEffect(() => {
    if (lockedMessage) setOpen(true);
  }, [lockedMessage]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const activeInstance = useMemo(
    () => instances.find((instance) => instance.id === connection.instanceId),
    [connection.instanceId, instances],
  );
  const remainingMs = vaultStatus?.unlocked && vaultStatus.idleTimeoutMs && vaultStatus.lastActivityAt
    ? vaultStatus.lastActivityAt + vaultStatus.idleTimeoutMs - now
    : null;
  const showIdleWarning = remainingMs !== null && remainingMs > 0 && remainingMs < 5 * 60 * 1000;
  const canUnlockVault = Boolean(passphrase.trim()) && Boolean(vaultStatus?.exists) && !busy;
  const hasSavedConnection = hasSavedVaultConnection(connection);
  const hasActiveConnection = hasActiveSavedVaultConnection(connection);
  const displayedError = error || (
    connection.status === 'error' && connection.errorMessage
      ? instanceConnectionDiagnosticFromState(connection.errorMessage, connection.errorCode)
      : null
  );
  const currentInstanceLabel = activeInstance?.label || connection.instanceLabel || (hasSavedConnection ? 'Saved instance' : 'Instance vault');
  const statusLabel = hasActiveConnection
    ? 'Connected'
    : status === 'unlocked'
      ? 'Vault unlocked'
    : status === 'no-vault'
      ? 'Setup needed'
      : status === 'unknown'
        ? 'Checking vault'
        : 'Vault locked';

  useEffect(() => {
    if (!vaultStatus?.unlocked || !vaultStatus.idleTimeoutMs || !vaultStatus.lastActivityAt) {
      checkedExpiryRef.current = null;
      return;
    }
    const expiresAt = vaultStatus.lastActivityAt + vaultStatus.idleTimeoutMs;
    if (now < expiresAt || checkedExpiryRef.current === expiresAt) return;
    checkedExpiryRef.current = expiresAt;
    void refreshStatus().catch(() => undefined);
  }, [now, refreshStatus, vaultStatus]);

  function closeAndRestoreFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function handleConnect(instanceId: string) {
    if (instanceId === connection.instanceId && hasActiveConnection && !busy) {
      closeAndRestoreFocus();
      return;
    }
    const sequence = connectUiSequenceRef.current + 1;
    connectUiSequenceRef.current = sequence;
    setBusy(true);
    setConnectingInstanceId(instanceId);
    setError(null);
    try {
      await connectInstance(instanceId);
      if (connectUiSequenceRef.current !== sequence) return;
      closeAndRestoreFocus();
    } catch (err) {
      if (connectUiSequenceRef.current !== sequence) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(instanceConnectionDiagnosticFromError(err));
    } finally {
      if (connectUiSequenceRef.current === sequence) {
        setConnectingInstanceId('');
        setBusy(false);
      }
    }
  }

  async function handleExtend() {
    setBusy(true);
    setError(null);
    try {
      await touch();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Could not extend the vault session.' });
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock() {
    if (!canUnlockVault) return;
    setBusy(true);
    setError(null);
    try {
      const result = await unlock(passphrase);
      setPassphrase('');
      if (result.activeInstance || result.resumedInstance) closeAndRestoreFocus();
      else setOpen(true);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Could not unlock the vault.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={containerRef} className="border-b border-border px-3 py-3">
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <span className="text-[11px] font-semibold leading-4 tracking-normal text-content-tertiary">Omni instance</span>
        <span
          className={`text-[10px] font-medium ${hasActiveConnection ? 'text-emerald-700' : 'text-content-tertiary'}`}
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) setError(null);
          setOpen((value) => !value);
        }}
        className="group flex min-h-12 w-full items-center gap-2.5 rounded-[6px] px-2 py-2 text-left text-[12px] font-semibold text-omni-900 transition-colors hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine"
        aria-label={`Switch Omni instance. Current: ${currentInstanceLabel}. ${statusLabel}.`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-busy={loading || busy}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] ${hasActiveConnection ? 'bg-omni-50 text-omni-700' : 'bg-surface-tertiary text-content-secondary'}`}>
          {hasActiveConnection
            ? <ShieldCheck size={15} aria-hidden="true" />
            : status === 'unlocked'
              ? <Server size={15} aria-hidden="true" />
              : <Lock size={15} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-4">
            {currentInstanceLabel}
          </span>
          <span className="mt-0.5 block truncate text-[10px] font-normal leading-4 text-content-secondary">
            {activeInstance
              ? `${roleLabel(activeInstance.role)} · ${instanceHost(activeInstance.baseUrl)}`
              : hasSavedConnection
                ? `${instanceHost(connection.baseUrl)} · reconnect needed`
                : status === 'unlocked'
                  ? `${instances.length} saved instance${instances.length === 1 ? '' : 's'}`
                  : status === 'no-vault'
                    ? 'Set up vault'
                    : 'Unlock to switch'}
          </span>
        </span>
        {loading ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-content-secondary" aria-hidden="true" />
        ) : (
          <ChevronDown
            size={14}
            className={`shrink-0 text-content-secondary transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>

      {showIdleWarning && (
        <div className="mt-2 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-900" role="status">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Clock size={12} className="shrink-0" aria-hidden="true" />
              <span className="truncate">Locks in {formatRemaining(remainingMs)}</span>
            </span>
            <button
              type="button"
              onClick={handleExtend}
              disabled={busy}
              className="shrink-0 font-semibold text-amber-950 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Extend session
            </button>
          </div>
        </div>
      )}

      {open && (
        <div
          id={panelId}
          className="mt-2 space-y-2 border-t border-border pt-2 text-[12px]"
          role="region"
          aria-label="Omni instance options"
        >
          {lockedMessage && (
            <div className="border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900" role="status">
              {lockedMessage}
            </div>
          )}
          {displayedError && (
            <ConnectionFailureDetails
              message={displayedError.message}
              code={displayedError.code}
              compact
            />
          )}

          {status === 'no-vault' ? (
            <Link to="/" onClick={() => setOpen(false)} className={PRIMARY_ACTION_CLASS}>
              <KeyRound size={14} aria-hidden="true" />
              Set up on Home
            </Link>
          ) : status === 'locked' || status === 'unknown' ? (
            <div className="space-y-2">
              <label htmlFor={passphraseInputId} className="block text-[11px] font-semibold text-content-secondary">
                Vault passphrase
              </label>
              <PassphraseInput
                id={passphraseInputId}
                value={passphrase}
                onChange={setPassphrase}
                onSubmit={() => {
                  if (canUnlockVault) void handleUnlock();
                }}
                disabled={busy || status === 'unknown'}
                inputClassName="h-9 text-xs"
                placeholder={status === 'unknown' ? 'Checking vault status...' : 'Enter vault passphrase'}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={handleUnlock}
                disabled={!canUnlockVault}
                className={PRIMARY_ACTION_CLASS}
              >
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <UnlockKeyhole size={14} aria-hidden="true" />}
                {hasSavedConnection ? 'Unlock and resume' : 'Unlock vault'}
              </button>
              <Link to="/" onClick={() => setOpen(false)} className={SECONDARY_ACTION_CLASS}>
                <Lock size={14} aria-hidden="true" />
                Open Home
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {instances.length === 0 ? (
                <Link to="/admin/fleet/instances" onClick={() => setOpen(false)} className={SECONDARY_ACTION_CLASS}>
                  <Server size={14} aria-hidden="true" />
                  Add saved instance
                </Link>
              ) : (
                <>
                  <div className="max-h-56 overflow-auto rounded-[6px] border border-border bg-surface-primary" role="group" aria-label="Saved Omni instances">
                    {instances.map((instance) => {
                      const active = instance.id === connection.instanceId;
                      const connected = active && hasActiveConnection;
                      const recent = isRecentlyValidated(instance.lastValidatedAt);
                      return (
                        <button
                          key={instance.id}
                          type="button"
                          onClick={() => void handleConnect(instance.id)}
                          disabled={busy && connectingInstanceId === instance.id}
                          className={`flex w-full items-start gap-2 border-b border-border-subtle border-l-[3px] px-2.5 py-2 text-left transition-colors last:border-b-0 ${
                            connected
                              ? 'border-l-omni-500 bg-omni-50 text-omni-900 hover:bg-omni-100'
                              : active
                                ? 'border-l-amber-400 bg-amber-50 text-omni-900 hover:bg-amber-100'
                              : 'border-l-transparent hover:bg-surface-secondary'
                          } disabled:cursor-wait disabled:opacity-70`}
                          aria-pressed={connected}
                        >
                          {connectingInstanceId === instance.id ? (
                            <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-content-secondary" aria-hidden="true" />
                          ) : (
                            <span
                              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${recent ? 'bg-success' : 'bg-border-strong'}`}
                              title={validationLabel(instance.lastValidatedAt)}
                              aria-hidden="true"
                            />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold text-omni-900">{instance.label}</span>
                            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="shrink-0 rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[9px] font-semibold tracking-normal text-content-secondary">
                                {roleLabel(instance.role)}
                              </span>
                              {connected && (
                                <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[9px] font-semibold tracking-normal text-omni-700 ring-1 ring-omni-200">
                                  Active
                                </span>
                              )}
                              {active && !connected && (
                                <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[9px] font-semibold tracking-normal text-amber-800 ring-1 ring-amber-200">
                                  Reconnect
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-content-secondary">
                              {instanceHost(instance.baseUrl)}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-content-tertiary">
                              {validationLabel(instance.lastValidatedAt)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <Link to="/admin/fleet/instances" onClick={() => setOpen(false)} className={SECONDARY_ACTION_CLASS}>
                    <Server size={14} aria-hidden="true" />
                    Manage instances
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
