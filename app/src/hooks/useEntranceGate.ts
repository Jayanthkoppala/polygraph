import { useReducedMotion } from 'motion/react';
import { useSkipEntrance } from '@/hooks/useSkipEntrance';

/** Should this subtree skip its entrance? An explicit `animateEntrance` overrides the
 *  mount gate; reduced motion is never overridden. */
export function useEntranceGate(animateEntrance?: boolean): boolean {
  const reduceMotion = useReducedMotion();
  const mountSkip = useSkipEntrance(reduceMotion);
  return animateEntrance === undefined ? mountSkip : Boolean(reduceMotion) || !animateEntrance;
}
