/**
 * Receipt — S4 "The receipt" per positioning.md §3 and copy.md §2/S4.
 * One job: decisions you can audit, custody you can trust.
 *
 * Left: the live ledger strip fed by the SAME sandbox engine as the hero
 * (passed down from `LandingPage`, one continuous chain — not a second
 * instance), with `Verify chain` running the real SHA-256 walk in-tab.
 * Right: the three custody facts, one line each, copy.md verbatim.
 * Under the strip: the first-use gloss for "ledger" (copy.md).
 *
 * Custody facts are enforced behavior, not counts (positioning.md §6 bans
 * test counts): AES-256-GCM per-tenant encryption with no read-back
 * endpoint and per-tenant genesis are tenant-architecture.md §§2–3,
 * repairs-off is the hosted heal env gate (§5).
 *
 * Deliberately NOT `components/ledger/LedgerStream`: its `Verify chain` is
 * hardwired to the real `/api/ledger/verify` fetch, which has nothing to
 * check against a client-only sandbox chain. Reuses `VerdictRail` directly
 * for each row's geometry, matching the ledger's warm-archive look.
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

const CUSTODY_FACTS = [
  'Your key is AES-256-GCM encrypted per tenant, and the key that decrypts it lives in the server environment, never the database — stealing the database file yields ciphertext and nothing else. No endpoint shows it back.',
  'Your fleet, your ledger — every tenant’s chain starts from its own genesis.',
  'Repairs are off in the hosted product — structurally, not as a default. A repair would spend your Bright Data credits, and nothing here can spend them.',
];

export function Receipt({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const rows = sandbox.ledgerRowsForDisplay();
  const [status, setStatus] = useState<VerifyStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  function handleVerify() {
    setStatus('checking');
    const result = sandbox.verifyChain();
    setStatus(result.ok ? 'ok' : 'broken');
    // Result strings per copy.md §2/S4, with the real count — the engine's
    // own reason wins on failure when it provides one.
    setMessage(
      result.ok
        ? `OK. ${result.checked.toLocaleString('en-US')} events verified. Chain intact.`
        : (result.reason ??
            `Verification stopped at entry #${(result.checked + 1).toLocaleString('en-US')}. ` +
              'This entry no longer matches the fingerprint chained into the next one. ' +
              'The record was altered after it was written.'),
    );
  }

  const statusColor = status === 'ok' ? 'var(--color-verdict-pass)' : status === 'broken' ? 'var(--color-verdict-shape)' : '#9B9B9B';

  return (
    <section className="bg-[#181818] px-6 py-24">
      <h2 className="mx-auto mb-10 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        Every decision leaves a receipt.
      </h2>

      <div className="mx-auto grid max-w-5xl grid-cols-1 items-start gap-8 lg:grid-cols-[1.4fr_1fr] lg:gap-12">
        <div>
          <div
            aria-label="Sandbox ledger"
            data-testid="receipt-ledger"
            className="relative flex max-h-96 flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[var(--color-archive)]"
          >
            {/* ui-system.md §2.5/§3.8: Magic UI's static `noise-texture` over
                #131209 at ~3% — painted once as an SVG filter, never
                ReactBits' `Noise` (a canvas repainting on an interval). */}
            <NoiseTexture aria-hidden className="!opacity-[0.03]" />
            <header className="relative flex items-center gap-3 border-b border-[#272727] px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Your sandbox ledger</span>
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
                            show — --text-muted, never --text-faint (§1.3). */}
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

          <p className="mt-2 text-pretty text-xs text-[#9B9B9B]">
            The ledger is an append only record of every verdict. Each entry carries a fingerprint
            of the one before it, so editing history breaks the chain.
          </p>
        </div>

        <ul className="flex flex-col gap-4">
          {CUSTODY_FACTS.map((fact) => (
            <li key={fact} className="rounded-2xl border border-[#272727] bg-[#1F1F1F] p-3">
              <p className="text-pretty text-sm text-[#B4B4B4]">{fact}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
