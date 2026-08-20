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

  async function handleVerify() {
    setStatus('checking');
    setMessage(null);
    try {
      const result = await verifyLedgerChain();
      setStatus(result.ok ? 'ok' : 'broken');
      setMessage(
        result.ok
          ? `OK — ${result.checked.toLocaleString('en-US')} events verified, chain intact`
          : (result.reason ?? `Chain broken after ${result.checked.toLocaleString('en-US')} event(s)`),
      );
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof ApiError ? err.message : 'Verify is unavailable right now.');
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
        <span className="font-mono text-xs tabular-nums text-[#6E7681]">
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
          role="status"
          className="border-b border-[#272727] px-3 py-2 font-mono text-xs tabular-nums"
          style={{ color: statusColor }}
        >
          {message}
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
                  <span className="min-w-0 flex-1 truncate text-[#EDEDED]">{row.collector}</span>
                  <span className="shrink-0" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="shrink-0 text-[#9B9B9B]">{row.action}</span>
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
