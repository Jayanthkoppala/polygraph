import { useEffect, useState } from 'react';
import { fetchFleetState } from '@/lib/api';
import type { FleetState } from '@/lib/api';

/**
 * Task 5 placeholder. Screens are built in later tasks (6-9) — this exists
 * only to prove, visually, that the foundation actually works end to end:
 * the self-hosted Geist fonts load, the design tokens resolve to real
 * pixels/colours, and the typed API client can reach a running
 * `polygraph watch` server. Nothing here is a real component; the real
 * fleet/focus/ledger shell is Task 7's `docs/design/ui-system.md` §5.2.
 */
function App() {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchFleetState()
      .then(setState)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-void)] p-8 font-sans text-[#EDEDED]">
      <h1 className="text-3xl font-semibold">Polygraph — frontend foundation</h1>
      <p className="max-w-md text-center text-base text-[#B4B4B4]">
        Tokens, self-hosted Geist/Geist Mono, and the typed API client are wired.
        Real screens land in Tasks 6-9.
      </p>
      <div className="rounded-2xl border border-[#272727] bg-[var(--color-surface)] px-6 py-4 font-mono text-sm text-[#9B9B9B]">
        {error ? (
          <span style={{ color: 'var(--color-verdict-shape)' }}>api/state error: {error}</span>
        ) : state ? (
          <span>
            tenant <span className="text-[#EDEDED]">{state.tenant}</span> ·{' '}
            <span className="tabular-nums">{state.collectors.length}</span> collector
            {state.collectors.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span>loading /api/state…</span>
        )}
      </div>
    </main>
  );
}

export default App;
