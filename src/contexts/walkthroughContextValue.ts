import { createContext } from 'react';
import type { WalkthroughStorageState } from '@/services/walkthrough';

export type WalkthroughOpenReason = 'first-run' | 'updated' | 'manual';

export interface WalkthroughContextValue {
  open: boolean;
  stepIndex: number;
  reason: WalkthroughOpenReason;
  state: WalkthroughStorageState | null;
  currentVersion: string;
  hasUpdate: boolean;
  openWalkthrough: (reason?: WalkthroughOpenReason, stepIndex?: number) => void;
  closeWalkthrough: () => void;
  completeWalkthrough: () => void;
  resetWalkthrough: () => void;
  setStepIndex: (index: number) => void;
}

export const WalkthroughContext = createContext<WalkthroughContextValue | null>(null);
