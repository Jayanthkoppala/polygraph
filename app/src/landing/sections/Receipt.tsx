/**
 * Receipt — ux-spec.md §1a below-the-fold item 3 / ui-system.md §4.3 order
 * 7 ("the ledger, chain proof"). The SAME sandbox engine the hero's
 * `SandboxPanel` drives (passed down from `LandingPage`, not a second
 * instance) — so `Verify chain` here is walking the exact chain the
 * visitor just built by clicking break buttons above.
 *
 * Deliberately NOT `components/ledger/LedgerStream`: that component's
 * `Verify chain` button is hardwired to the real `/api/ledger/verify`
 * fetch (`lib/api.ts`), which has nothing to check against a client-only
 * sandbox chain. Reuses `VerdictRail` directly instead — one of the four
 * primitives this task was told to reuse, never re-implement — for each
 * row's geometry, matching the ledger's warm-archive look.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { VerdictRail } from '@/components/verdict/VerdictRail';
import { NoiseTexture } from '@/components/ui/noise-texture';
import { VERDICT, toVerdictState } from '@/lib/verdict';
import type { CollectorState } from '@/lib/api';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';

/** Same engine->display mapping App.tsx uses for a real ledger row, applied
 * to a sandbox ledger row — neither carries an `unverified` flag (that's a
 * `CollectorState`-only derived field), so it's always false here. */
function ledgerRowState(verdict: string, cause: string | null) {
  return toVerdictState({ verdict, cause, unverified: false } as CollectorState);
}

type VerifyStatus = 'idle' | 'checking' | 'ok' | 'broken';

export function Receipt({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const rows = sandbox.ledgerRowsForDisplay();
  const [status, setStatus] = useState<VerifyStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  function handleVerify() {
    setStatus('checking');
    const result = sandbox.verifyChain();
    setStatus(result.ok ? 'ok' : 'broken');
    setMessage(
      result.ok
        ? `OK — ${result.checked.toLocaleString('en-US')} events verified, chain intact`
        : (result.reason ?? `Chain broken after ${result.checked.toLocaleString('en-US')} event(s)`),
    );
  }

  const statusColor = status === 'ok' ? 'var(--color-verdict-pass)' : status === 'broken' ? 'var(--color-verdict-shape)' : '#9B9B9B';

  return (
    <section className="bg-[#181818] px-6 py-24">
      <h2 className="mx-auto mb-4 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        Every decision, hash chained.
      </h2>
      {/* The hosted per-tenant chain facts are tenant-architecture.md §3:
          per-account chain, per-account genesis, standalone export, clean
          delete. The strip below is the visitor's OWN sandbox chain (same
          engine instance as the hero), which the copy says outright. */}
      <p className="mx-auto mb-6 max-w-[680px] text-pretty text-center text-base text-[#B4B4B4]">
        On the hosted product, your account gets its own chain with its own genesis — it verifies
        standalone, exports standalone, and nobody else&rsquo;s rows are in it. The strip below is
        the chain you just built in the sandbox above. Try the button; then try distrusting it.
      </p>

      <div
        aria-label="Sandbox ledger"
        data-testid="receipt-ledger"
        className="relative mx-auto flex max-h-96 max-w-3xl flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[var(--color-archive)]"
      >
        {/* ui-system.md §2.5/§3.8: Magic UI's static `noise-texture` over
            #131209 at ~3% — the material/tactile grain, painted once as an
            SVG filter, never ReactBits' `Noise` (a canvas repainting on an
            interval, which would burn GPU on a page that sits open all day). */}
        <NoiseTexture aria-hidden className="!opacity-[0.03]" />
        <header className="relative flex items-center gap-3 border-b border-[#272727] px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Your sandbox ledger</span>
          {/* Chain length is the receipt's own headline number — meaning, not
              decoration, so --text-muted per §1.3. */}
          <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">{rows.length} events</span>
          <button
            type="button"
            onClick={handleVerify}
            disabled={status === 'checking'}
            data-testid="sandbox-verify-chain-button"
            className="ml-auto rounded-sm border border-[#272727] px-2 py-1 font-mono text-xs text-[#9B9B9B] outline-none
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            {status === 'checking' ? 'Verifying…' : 'Verify chain'}
          </button>
        </header>

        {message && (
          <div
            role="status"
            data-testid="sandbox-verify-result"
            className="relative border-b border-[#272727] px-3 py-2 font-mono text-xs tabular-nums"
            style={{ color: statusColor }}
          >
            {message}
          </div>
        )}

        <div role="log" aria-live="polite" aria-label="Sandbox ledger events" className="relative flex-1 overflow-y-auto">
          <ol className="divide-y divide-[#272727]">
            <AnimatePresence initial={false}>
              {rows.map((row) => {
                const state = ledgerRowState(row.verdict, row.cause);
                const meta = VERDICT[state];
                return (
                  <motion.li
                    key={row.id}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                    className="relative flex items-baseline gap-3 px-3 py-2 font-mono text-xs"
                  >
                    <VerdictRail state={state} />
                    <time dateTime={row.ts} className="shrink-0 pl-3 tabular-nums text-[#9B9B9B]">
                      {row.ts.slice(11, 19)}
                    </time>
                    <span className="min-w-0 flex-1 truncate text-[#EDEDED]">{row.collector}</span>
                    <span className="shrink-0" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                    <span className="shrink-0 text-[#9B9B9B]">{row.action}</span>
                    {/* The hash prefix IS the proof this section exists to
                        show — the most load-bearing string in the row, and
                        the one a reader compares against `Verify chain`.
                        --text-muted, never --text-faint (§1.3). */}
                    <span className="shrink-0 tabular-nums text-[#9B9B9B]" title={row.eventHash}>
                      {row.eventHash.slice(0, 8)}
                    </span>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        </div>
      </div>
    </section>
  );
}
