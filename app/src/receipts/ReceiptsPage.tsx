import { useCallback, useEffect, useState } from 'react';
import { ArrowClockwise, CheckCircle, Clock, WarningCircle } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, fetchVisibleRepairReceipts, type RepairReceipt } from '@/lib/api';

const POLL_INTERVAL_MS = 10_000;

function compactHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function displayTime(value: string | null) {
  if (!value) return 'In progress';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function ReceiptStatus({ status }: { status: RepairReceipt['status'] }) {
  const config = status === 'verified'
    ? { label: 'Verified', Icon: CheckCircle, className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' }
    : status === 'failed'
      ? { label: 'Failed', Icon: WarningCircle, className: 'border-red-400/30 bg-red-400/10 text-red-300' }
      : { label: 'Repairing', Icon: Clock, className: 'border-amber-300/30 bg-amber-300/10 text-amber-200' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] ${config.className}`}>
      <config.Icon size={13} weight="fill" aria-hidden />
      {config.label}
    </span>
  );
}

export function ReceiptsPage() {
  const [receipts, setReceipts] = useState<RepairReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const next = await fetchVisibleRepairReceipts(100);
      setReceipts(next.receipts);
      setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <main className="min-h-[calc(100svh-var(--poly-chrome-offset,0px))] bg-black/60 px-8 py-10 font-sans text-[#EDEDED] backdrop-blur-[2px]">
      <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6" aria-labelledby="receipts-title">
        <header className="flex items-end justify-between gap-8">
          <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#818CF8]">Verified repair history</p>
            <h1 id="receipts-title" className="text-4xl font-semibold tracking-[-0.04em]">Repair receipts</h1>
            <p className="max-w-2xl text-sm leading-6 text-[#9B9B9B]">Only collectors that entered a real broken-and-repair lifecycle appear here. Healthy runs stay in the fleet ledger.</p>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/fleet" className="rounded-lg border border-[#313131] bg-[#181818]/80 px-4 py-2 text-sm font-medium text-[#EDEDED] hover:bg-[#272727]">Collector fleet</Link>
            <button type="button" onClick={() => void load(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-lg border border-[#313131] bg-[#272727] px-4 py-2 text-sm font-medium text-[#EDEDED] hover:border-[#4B4B4B] disabled:opacity-50">
              <ArrowClockwise className={refreshing ? 'animate-spin' : ''} size={16} aria-hidden />
              Refresh
            </button>
          </div>
        </header>

        <div className="overflow-hidden rounded-2xl border border-[#313131] bg-[#111111]/90 shadow-[var(--shadow-e3)]">
          {error && <p role="alert" className="border-b border-red-400/20 bg-red-400/10 px-5 py-3 text-sm text-red-200">Receipts could not refresh: {error}</p>}
          {receipts === null ? (
            <div className="grid min-h-64 place-items-center font-mono text-sm text-[#8B949E]">Loading repair receipts…</div>
          ) : receipts.length === 0 ? (
            <div className="grid min-h-64 place-items-center px-6 text-center">
              <div className="space-y-2">
                <p className="text-lg font-medium">No broken collectors have entered repair.</p>
                <p className="text-sm text-[#8B949E]">The first confirmed repair will create a receipt automatically.</p>
              </div>
            </div>
          ) : (
            <Table aria-label="Repair receipts">
              <TableHeader className="bg-[#181818]">
                <TableRow>
                  <TableHead className="pl-5">Detected</TableHead>
                  <TableHead>Collector</TableHead>
                  <TableHead>Broken change</TableHead>
                  <TableHead>Repair</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="pr-5 text-right">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.map((receipt) => (
                  <TableRow key={`${receipt.source ?? 'customer'}:${receipt.id}`}>
                    <TableCell className="pl-5 font-mono text-xs text-[#A1A1AA]">{displayTime(receipt.detected_at)}</TableCell>
                    <TableCell>
                      <div className="max-w-48">
                        <p className="truncate font-medium">{receipt.collector_name}</p>
                        <p className="truncate font-mono text-[11px] text-[#777]">{receipt.collector}</p>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="max-w-80 space-y-2">
                        <p className="line-clamp-2 text-sm text-[#D4D4D8]" title={receipt.change_summary}>{receipt.change_summary}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {(receipt.changed_fields.length > 0 ? receipt.changed_fields : [receipt.cause ?? 'structural']).map((field) => (
                            <span key={field} className="rounded border border-red-400/20 bg-red-400/10 px-1.5 py-0.5 font-mono text-[10px] text-red-200">{field}</span>
                          ))}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <p className="max-w-72 line-clamp-2 text-sm text-[#A1A1AA]" title={receipt.repair_prompt ?? undefined}>{receipt.repair_prompt ?? 'Repair prompt was not retained for this older receipt.'}</p>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1.5">
                        <ReceiptStatus status={receipt.status} />
                        <p className="font-mono text-[10px] text-[#71717A]">{displayTime(receipt.completed_at)}</p>
                      </div>
                    </TableCell>
                    <TableCell className="pr-5 text-right">
                      <p className="font-mono text-xs text-[#A5B4FC]">#{receipt.terminal_ledger_id ?? receipt.id}</p>
                      {receipt.event_hash
                        ? <p className="mt-1 font-mono text-[10px] text-[#62626A]" title={receipt.event_hash}>{compactHash(receipt.event_hash)}</p>
                        : <p className="mt-1 font-mono text-[10px] text-[#62626A]">Live mission evidence</p>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>
    </main>
  );
}
