/**
 * useSandboxEngine — the React-facing wrapper around `SandboxEngine`.
 *
 * Owns the interaction contract from ux-spec.md §3:
 *   1. Click -> `breaking` (button disabled, ~600ms)
 *   2. -> `reverifying` (target cards show a skeleton) for a MINIMUM of
 *      1.6s even if the engine already has the answer — sub-second verdicts
 *      read as canned, so this hook, not the (synchronous, fast) engine, is
 *      what enforces the floor.
 *   3. -> `idle`, fleet/ledger updated in one frame, no staggered reveal.
 *
 * One `SandboxEngine` instance is created per hook instance (lazy
 * `useState` initializer, never re-created across re-renders) — this is
 * what makes "per visitor" trivially true for anything mounted from this
 * hook: two components using this hook never share an engine.
 */
import { useCallback, useMemo, useState } from 'react';
import { SandboxEngine, SandboxLimitError, type SandboxMode } from './engine';
import type { CollectorState } from '@/lib/api';

export type SandboxPhase = 'idle' | 'breaking' | 'reverifying';

const BREAKING_MS = 600;
/** ux-spec.md §3: "a minimum of 1.6s even if the run returns faster." */
const MIN_REVERIFY_MS = 1600;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UseSandboxEngineResult {
  fleet: CollectorState[];
  mode: SandboxMode;
  phase: SandboxPhase;
  actionsRemaining: number;
  limitReached: boolean;
  ledgerCount: number;
  /** Triggers the full break/re-verify sequence for `mode`. No-ops while a
   * sequence is already in flight. */
  trigger: (mode: SandboxMode) => void;
  verifyChain: () => { ok: boolean; checked: number; reason?: string };
  ledgerRowsForDisplay: () => ReturnType<SandboxEngine['getLedger']>;
}

export function useSandboxEngine(): UseSandboxEngineResult {
  // Lazy initializer: runs exactly once per component instance, at mount —
  // never re-created on re-render, never shared across instances.
  const [engine] = useState(() => new SandboxEngine());
  const [fleet, setFleet] = useState<CollectorState[]>(() => engine.getFleet());
  const [mode, setMode] = useState<SandboxMode>('healthy');
  const [phase, setPhase] = useState<SandboxPhase>('idle');
  const [actionsRemaining, setActionsRemaining] = useState(engine.actionsRemaining);
  const [ledgerCount, setLedgerCount] = useState(engine.getLedger().length);

  const trigger = useCallback(
    (nextMode: SandboxMode) => {
      if (phase !== 'idle') return; // one sequence at a time
      if (!engine.canAct()) return;

      setPhase('breaking');
      void (async () => {
        await wait(BREAKING_MS);
        setPhase('reverifying');

        const minDelay = wait(MIN_REVERIFY_MS);
        let nextFleet: CollectorState[];
        try {
          nextFleet = engine.applyMode(nextMode);
        } catch (err) {
          await minDelay;
          setPhase('idle');
          if (err instanceof SandboxLimitError) setActionsRemaining(0);
          return;
        }
        await minDelay; // the floor — the engine itself resolved instantly

        // One frame: chip, colour, proof line, action slot all update together.
        setFleet(nextFleet);
        setMode(nextMode);
        setActionsRemaining(engine.actionsRemaining);
        setLedgerCount(engine.getLedger().length);
        setPhase('idle');
      })();
    },
    [engine, phase],
  );

  const verifyChain = useCallback(() => engine.verifyChain(), [engine]);
  const ledgerRowsForDisplay = useCallback(() => engine.getLedger(), [engine]);

  return useMemo(
    () => ({
      fleet,
      mode,
      phase,
      actionsRemaining,
      limitReached: actionsRemaining <= 0,
      ledgerCount,
      trigger,
      verifyChain,
      ledgerRowsForDisplay,
    }),
    [fleet, mode, phase, actionsRemaining, ledgerCount, trigger, verifyChain, ledgerRowsForDisplay],
  );
}
