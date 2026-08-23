// Polls `/api/state` and `/api/ledger` into `FleetShell`. Mounted at `/app` and
// `/fleet` only once `AppGate` has confirmed the session is authenticated and keyed.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FleetShell } from '@/components/fleet/FleetShell';
import { fetchFleetState, fetchLedger, acknowledgeCollector, ApiError } from '@/lib/api';
import { signOut } from '@/lib/session';
import { connectCollector, listAvailableCollectors } from '@/onboarding/api';
import type { CollectorState, FleetState } from '@/lib/api';
import { toVerdictState } from '@/lib/verdict';
import type { LedgerRow } from '@/components/ledger/LedgerStream';

const POLL_INTERVAL_MS = 5000;

/** `lib/verdict.ts`'s mapping applied to a raw ledger row. Rows carry no `unverified`
 *  flag on the wire — a historical entry doesn't need that distinction. */
function ledgerRowState(verdict: string, cause: string | null) {
  return toVerdictState({ verdict, cause, unverified: false } as CollectorState);
}

export function FleetApp() {
  const navigate = useNavigate();
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

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

  // No `/api/repair` route exists — heal.ts runs on its own schedule. So Repair gives
  // §6's repairs-off fallback: the exact manual command on the clipboard, never a dead button.
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

  const handleAddCollector = useCallback(
    async (collectorId: string) => {
      await connectCollector(collectorId);
      await poll();
    },
    [poll],
  );

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      navigate('/', { replace: true });
    } catch {
      setSignOutError('Could not sign you out. Please try again.');
      setSigningOut(false);
    }
  }, [navigate, signingOut]);

  if (error && !fleet) {
    return (
      <main className="flex min-h-[calc(100svh-var(--poly-chrome-offset,0px))] flex-col items-center justify-center gap-4 bg-black/55 p-8 font-sans text-[#EDEDED]">
        <p className="max-w-md text-center text-sm" style={{ color: 'var(--color-verdict-shape)' }}>
          Could not reach the fleet: {error}
        </p>
      </main>
    );
  }

  if (!fleet) {
    return (
      <main className="flex min-h-[calc(100svh-var(--poly-chrome-offset,0px))] items-center justify-center bg-black/55 font-sans text-[#EDEDED]">
        <p className="font-mono text-sm text-[#9B9B9B]">loading /api/state…</p>
      </main>
    );
  }

  return (
    <FleetShell
      fleet={fleet}
      ledgerRows={ledgerRows}
      onRepair={handleRepair}
      onAcknowledge={handleAcknowledge}
      onAddCollector={handleAddCollector}
      onListCollectors={listAvailableCollectors}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      signOutError={signOutError}
    />
  );
}
