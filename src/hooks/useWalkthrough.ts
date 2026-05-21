import { useContext } from 'react';
import { WalkthroughContext } from '@/contexts/walkthroughContextValue';

export function useWalkthrough() {
  const value = useContext(WalkthroughContext);
  if (!value) throw new Error('useWalkthrough must be used inside WalkthroughProvider');
  return value;
}
