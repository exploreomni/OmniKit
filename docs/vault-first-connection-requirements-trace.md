# Vault-First Connection Requirements Trace

This trace records the Phase 1 vault-first connection work after the product decision to retire one-time manual connections. OmniKit workflows now require a saved native-vault instance reference.

## Product Decisions

| Decision | Status | Notes |
| --- | --- | --- |
| One-time manual connection | Retired | Protected workflows require a saved vault instance. Stale manual session payloads are ignored on restore and are not persisted. |
| Vault setup location | Current behavior | Home owns first-run vault creation and unlock. Instance Manager owns saved profile management and legacy import. |
| Browser-side vault | Retired | `src/services/instanceVault.ts` is removed. Legacy `localStorage` cache is only surfaced for user-directed dismissal. |

## Requirements

| ID | Requirement Summary | Status | Evidence / Notes |
| --- | --- | --- | --- |
| P1-1 | Reusable vault session hook | Complete | `src/hooks/useVaultSession.tsx` centralizes status, unlock, lock, touch, refresh, connect, and test behavior. |
| P1-2 | Global instance switcher | Complete | `src/components/layout/InstanceSwitcher.tsx` is mounted in the sidebar and supports unlock, resume, switch, idle extension, role labels, masked keys, and validation health. |
| P1-3 | Vault-first Home | Complete | Home defaults to native vault create/unlock/use flows. Manual one-time connection is intentionally absent. |
| P1-4 | Idle-lock visibility and resume | Complete | Switcher shows idle countdown under five minutes, `/api/vault/touch` extends the session, and API 423 responses emit the vault-locked event. |
| P1-5 | Test all saved instances | Complete | Instance Manager includes bulk test behavior and per-row validation metadata. |
| P1-6 | Remove deprecated browser vault | Complete | Browser vault module is absent; Data Privacy and Instance Manager expose only a compatibility/dismissal path. |
| P1-7 | Plaintext API keys not exposed for vault workflows | Complete | Browser sessions persist only reference tokens and masked keys for saved-vault connections. |
| P1-8 | Active workflow gate is vault-only | Complete | Protected workflows require an active, tested saved vault connection, not a generic successful connection or stale vault reference. |
| P1-9 | Per-instance cache isolation | Complete | Shared connection cache keys use saved instance ID before base URL, so same-host saved profiles do not share UI cache state. |

## Validation Checklist

- Typecheck app and node projects.
- Run lint.
- Run security regression tests covering vault token hydration, idle lock, touch, and browser vault removal.
- Manual smoke: unlock vault, switch between two saved instances from a non-Home workflow, verify data reloads for the selected profile.
- Manual smoke: set a short idle timeout, let the vault lock, trigger an API action, unlock from the switcher, and verify the page state remains mounted.
