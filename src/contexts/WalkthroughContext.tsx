import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  WALKTHROUGH_VERSION,
  clearWalkthroughState,
  readWalkthroughState,
  shouldAutoOpenWalkthrough,
  walkthroughSteps,
  writeWalkthroughState,
  type WalkthroughStorageState,
} from '@/services/walkthrough';
import { WalkthroughContext, type WalkthroughContextValue, type WalkthroughOpenReason } from '@/contexts/walkthroughContextValue';

function persistedStateFor(reason: 'dismissed' | 'completed', existing: WalkthroughStorageState | null): WalkthroughStorageState {
  const now = new Date().toISOString();
  return {
    version: WALKTHROUGH_VERSION,
    openCount: existing?.openCount || 0,
    lastOpenedAt: existing?.lastOpenedAt,
    dismissedAt: reason === 'dismissed' ? now : existing?.dismissedAt,
    completedAt: reason === 'completed' ? now : existing?.completedAt,
  };
}

export function WalkthroughProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalkthroughStorageState | null>(() => readWalkthroughState());
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndexState] = useState(0);
  const [reason, setReason] = useState<WalkthroughOpenReason>('manual');

  useEffect(() => {
    const nextReason: WalkthroughOpenReason | null = !state
      ? 'first-run'
      : state.version !== WALKTHROUGH_VERSION
        ? 'updated'
        : null;
    if (!nextReason) return;
    setReason(nextReason);
    setStepIndexState(0);
    setOpen(true);
  }, [state]);

  const persist = useCallback((next: WalkthroughStorageState) => {
    writeWalkthroughState(next);
    setState(next);
  }, []);

  const openWalkthrough = useCallback((nextReason: WalkthroughOpenReason = 'manual', nextStepIndex = 0) => {
    const now = new Date().toISOString();
    const next = {
      ...(state || { version: WALKTHROUGH_VERSION }),
      version: state?.version || WALKTHROUGH_VERSION,
      lastOpenedAt: now,
      openCount: (state?.openCount || 0) + 1,
    };
    writeWalkthroughState(next);
    setState(next);
    setReason(nextReason);
    setStepIndexState(Math.min(Math.max(nextStepIndex, 0), walkthroughSteps.length - 1));
    setOpen(true);
  }, [state]);

  const closeWalkthrough = useCallback(() => {
    const next = persistedStateFor('dismissed', state);
    persist(next);
    setOpen(false);
  }, [persist, state]);

  const completeWalkthrough = useCallback(() => {
    const next = persistedStateFor('completed', state);
    persist(next);
    setOpen(false);
  }, [persist, state]);

  const resetWalkthrough = useCallback(() => {
    clearWalkthroughState();
    setState(null);
    setReason('first-run');
    setStepIndexState(0);
    setOpen(true);
  }, []);

  const setStepIndex = useCallback((index: number) => {
    setStepIndexState(Math.min(Math.max(index, 0), walkthroughSteps.length - 1));
  }, []);

  const value = useMemo<WalkthroughContextValue>(() => ({
    open,
    stepIndex,
    reason,
    state,
    currentVersion: WALKTHROUGH_VERSION,
    hasUpdate: shouldAutoOpenWalkthrough(state),
    openWalkthrough,
    closeWalkthrough,
    completeWalkthrough,
    resetWalkthrough,
    setStepIndex,
  }), [closeWalkthrough, completeWalkthrough, open, openWalkthrough, reason, resetWalkthrough, setStepIndex, state, stepIndex]);

  return (
    <WalkthroughContext.Provider value={value}>
      {children}
    </WalkthroughContext.Provider>
  );
}
