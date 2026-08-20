/**
 * App — polls `/api/state` and `/api/ledger`, and renders the real
 * three-region shell (docs/design/ui-system.md §5.2, assembled in
 * `FleetShell`). Replaces Task 5's placeholder, which existed only to
 * prove tokens/fonts/the API client worked end to end.
 */
import { useCallback, useEffect, useState } from 'react';
import { FleetShell } from '@/components/fleet/FleetShell';
import { fetchFleetState, fetchLedger, acknowledgeCollector, ApiError } from '@/lib/api';
import type { CollectorState, FleetState } from '@/lib/api';
import { toVerdictState } from '@/lib/verdict';
import type { LedgerRow } from '@/components/ledger/LedgerStream';

const POLL_INTERVAL_MS = 5000;

/** Same engine->display mapping `lib/verdict.ts` uses for a collector,
 * applied to a raw ledger row. Ledger rows don't carry an `unverified`
 * flag on the wire (that's a `CollectorState`-only derived field, per
 * `src/server.ts`'s `isUnverified`) — a skipped check on a ledger row is
 * legible from its own `evidence[]` instead, which the rail's five-state
 * split doesn't need to distinguish for a historical log entry. */
function ledgerRowState(verdict: string, cause: string | null) {
  return toVerdictState({ verdict, cause, unverified: false } as CollectorState);
}

function App() {
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const [state, ledger] = await Promise.all([fetchFleetState(), fetchLedger(100)]);
      setFleet(state);
      setLedgerRows(
        ledger.events
          .map((e) => ({
            id: e.id,
            ts: e.ts,
            collector: e.collector,
            state: ledgerRowState(e.verdict, e.cause),
            action: e.action,
            eventHash: e.event_hash,
          }))
          .sort((a, b) => a.id - b.id), // append-only, oldest first, newest at the bottom
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  const handleAcknowledge = useCallback(
    (id: string) => {
      const collector = fleet?.collectors.find((c) => c.id === id);
      if (!collector?.ledgerId) return;
      void acknowledgeCollector(collector.ledgerId).then(() => void poll());
    },
    [fleet, poll],
  );

  // No `/api/repair` route exists yet (repairs are executed by heal.ts on
  // its own schedule, not triggered from the dashboard). While that wiring
  // doesn't exist, Repair's click gives the diagnostic fallback ux-spec.md
  // §6 describes for repairs being off: the exact manual command, copied
  // to the clipboard, never a dead button.
  const handleRepair = useCallback(
    (id: string) => {
      const collector = fleet?.collectors.find((c) => c.id === id);
      const command = collector?.suggestedHealCommand;
      if (command && typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(command);
      }
    },
    [fleet],
  );

  if (error && !fleet) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-void)] p-8 font-sans text-[#EDEDED]">
        <p className="max-w-md text-center text-sm" style={{ color: 'var(--color-verdict-shape)' }}>
          Could not reach the fleet: {error}
        </p>
      </main>
    );
  }

  if (!fleet) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-void)] font-sans text-[#EDEDED]">
        <p className="font-mono text-sm text-[#9B9B9B]">loading /api/state…</p>
      </main>
    );
  }

  return <FleetShell fleet={fleet} ledgerRows={ledgerRows} onRepair={handleRepair} onAcknowledge={handleAcknowledge} />;
}

export default App;
