/**
 * LedgerStream — the warm archive material (ui-system.md §3.5/§1.2). Rows
 * are full bleed on `--color-archive`, keyed by their own stable ledger
 * `id`: React never remounts an existing row on a later poll, only mounts
 * genuinely new ones, so `AnimatePresence`'s entrance plays exactly once
 * per event, never as a re-sort or a replay from index 0 (ux-spec.md §5,
 * "Ledger events are append-only").
 *
 * `Verify chain` runs the real chain walk (`verifyLedgerChain`,
 * `lib/api.ts`) rather than asserting a static claim — ux-spec.md §1/§6:
 * "a button that actually runs and prints `OK — 47 events verified, chain
 * intact`."
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { VerdictRail } from '@/components/verdict/VerdictRail';
import { VERDICT, type VerdictState } from '@/lib/verdict';
import { verifyLedgerChain, ApiError } from '@/lib/api';

export interface LedgerRow {
  id: number;
  ts: string;
  collector: string;
  state: VerdictState;
  action: string;
  eventHash: string;
}

type VerifyStatus = 'idle' | 'checking' | 'ok' | 'broken' | 'error';

export function LedgerStream({ rows }: { rows: LedgerRow[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const prevLength = useRef(rows.length);

  useEffect(() => {
    // jsdom (unit tests) has no real layout and doesn't implement
    // scrollIntoView at all — guarded rather than assumed present.
    if (rows.length > prevLength.current && typeof endRef.current?.scrollIntoView === 'function') {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    prevLength.current = rows.length;
  }, [rows.length]);

  const [status, setStatus] = useState<VerifyStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  /**
   * Three outcomes, and the whole point is that they must never be mistaken
   * for each other (critique.md #10, as re-scoped once `POST
   * /api/ledger/verify` shipped in `src/server.ts`):
   *
   *   ok      the chain really was walked, and it held.
   *   broken  the chain really was walked, and it did NOT hold. This is the
   *           single most serious thing this product can say, so it says it
   *           in the failure hue and never hedges it into a "hiccup".
   *   error   the walk never happened. Nothing was verified and nothing was
   *           disproved — said explicitly, in the amber "needs you" hue, so
   *           a dropped request can never be read as a broken ledger.
   */
  async function handleVerify() {
    setStatus('checking');
    setMessage(null);
    setDetail(null);
    try {
      const result = await verifyLedgerChain();
      if (result.ok) {
        const n = result.checked;
        setStatus('ok');
        setMessage(`OK — ${n.toLocaleString('en-US')} event${n === 1 ? '' : 's'} verified, chain intact`);
        return;
      }
      setStatus('broken');
      setMessage('Chain broken — this ledger no longer verifies.');
      // `checked` counts the failing row too, so it is not a "verified
      // count" and is never printed as one. The server's own reason names
      // the event the walk stopped at; without it, say only what is known.
      setDetail(result.reason ?? `The walk stopped after ${result.checked.toLocaleString('en-US')} event(s).`);
    } catch (err) {
      setStatus('error');
      setMessage('Could not check the chain — nothing was verified.');
      setDetail(
        `The request did not complete, so this says nothing about whether the ledger is intact. ${
          err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const statusColor =
    status === 'ok'
      ? 'var(--color-verdict-pass)'
      : status === 'broken'
        ? 'var(--color-verdict-shape)'
        : status === 'error'
          ? 'var(--color-verdict-suspect)'
          : '#9B9B9B';

  return (
    <section
      aria-label="Ledger"
      data-testid="ledger-stream"
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[var(--color-archive)]"
    >
      <header className="flex items-center gap-3 border-b border-[#272727] px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Ledger</span>
        {/* The event count is a fact about the record, not chrome — it moves
            off the decoration-only #6E7681 (3.59:1, "never for text that
            carries meaning", ui-system.md §1.3/§6.1) onto muted #9B9B9B. */}
        <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">
          {rows.length.toLocaleString('en-US')} events
        </span>
        <button
          type="button"
          onClick={() => void handleVerify()}
          disabled={status === 'checking'}
          data-testid="verify-chain-button"
          className="ml-auto rounded-sm border border-[#272727] px-2 py-1 font-mono text-xs text-[#9B9B9B] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-wait"
        >
          {status === 'checking' ? 'Verifying…' : 'Verify chain'}
        </button>
      </header>

      {message && (
        <div
          data-testid="ledger-verify-result"
          data-verify-status={status}
          role="status"
          className="flex flex-col gap-1 border-b border-[#272727] px-3 py-2 font-mono text-xs tabular-nums"
        >
          <span style={{ color: statusColor }}>{message}</span>
          {detail && <span className="text-[#9B9B9B]">{detail}</span>}
        </div>
      )}

      <div role="log" aria-live="polite" aria-label="Ledger events" className="flex-1 overflow-y-auto">
        <ol className="divide-y divide-[#272727]">
          <AnimatePresence initial={false}>
            {rows.map((row) => {
              const meta = VERDICT[row.state];
              return (
                <motion.li
                  key={row.id}
                  data-row-id={row.id}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                  className="relative flex items-baseline gap-3 px-3 py-2 font-mono text-xs"
                >
                  <VerdictRail state={row.state} />
                  <time dateTime={row.ts} className="shrink-0 pl-3 tabular-nums text-[#9B9B9B]">
                    {row.ts.slice(11, 19)}
                  </time>
                  {/* The collector name is the one fact this row must carry
                      (docs/design/critique.md next-tier #5) — a fixed
                      min-width keeps it from truncating past readability
                      even in the narrow 360px LEDGER column, and the
                      redundant ACTION column (closely tracks the verdict
                      label already shown next to it) was dropped to make
                      room rather than starving the name further. */}
                  <span className="min-w-[84px] flex-1 truncate text-[#EDEDED]" title={row.collector}>
                    {row.collector}
                  </span>
                  <span className="shrink-0" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-[#6E7681]" title={row.eventHash}>
                    {row.eventHash.slice(0, 8)}
                  </span>
                </motion.li>
              );
            })}
          </AnimatePresence>
          <div ref={endRef} aria-hidden />
        </ol>
      </div>
    </section>
  );
}
