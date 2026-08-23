// The two right-side tables: "Accepted results" (raw deliveries for the selected
// collector) and "Repairs" (verified receipts only). Table headers stay pinned;
// only each `<tbody>`'s wrapper scrolls — RecoveryWorkspace gives each a bounded
// height via `min-h-0 flex-1` ancestors.
import { CircleNotch } from '@phosphor-icons/react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecoveryDelivery, RecoveryRepair } from '@/lib/recoveryApi';

function displayTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function compactHash(value: string | null) {
  if (!value) return '—';
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** VERIFIED-only, defended client-side too: `/api/recovery/repairs` is documented
 *  to return verified receipts exclusively, but a `status` field on a row that
 *  says otherwise must never render here regardless of what the server sent. */
export function isVerifiedReceipt(repair: RecoveryRepair): boolean {
  return repair.status === undefined || repair.status.toUpperCase() === 'VERIFIED';
}

function LoadMore({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center border-t border-[var(--color-line)] py-2.5">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="flex items-center gap-1.5 rounded-lg border border-[#313131] bg-[#1B1B1B] px-3 py-1.5 text-xs font-medium text-[#EDEDED] transition-[background-color,border-color] hover:border-[#4B4B4B] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading && <CircleNotch size={12} className="animate-spin" aria-hidden />}
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

export function AcceptedResultsTable({
  deliveries,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  deliveries: RecoveryDelivery[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[#111111]/90">
      <div className="shrink-0 border-b border-[#272727] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[#EDEDED]">Accepted results</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid min-h-32 place-items-center font-mono text-xs text-[#8B949E]">Loading deliveries…</div>
        ) : deliveries.length === 0 ? (
          <div className="grid min-h-32 place-items-center px-6 text-center text-sm text-[#8B949E]">No accepted deliveries yet for this collector.</div>
        ) : (
          <Table aria-label="Accepted results">
            <TableHeader className="sticky top-0 z-10 bg-[#181818]">
              <TableRow>
                <TableHead className="pl-4">Received</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead className="pr-4">Baseline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => (
                <TableRow key={delivery.id}>
                  <TableCell className="pl-4 font-mono text-xs text-[#A1A1AA]">{displayTime(delivery.receivedAt)}</TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs text-[#9B9B9B]" title={delivery.providerRunId ?? undefined}>
                    {delivery.providerRunId ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{delivery.rowCount ?? '—'}</TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono">{delivery.verdict ?? '—'}</span>
                    {delivery.cause && <span className="ml-1 text-[#71717A]">({delivery.cause})</span>}
                  </TableCell>
                  <TableCell className="pr-4">
                    {delivery.isBaseline && (
                      <span className="rounded-full border border-indigo-400/30 bg-indigo-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-indigo-200">
                        Baseline
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {hasMore && <LoadMore loading={loadingMore} onClick={onLoadMore} />}
    </div>
  );
}

export function RepairsTable({
  repairs,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  repairs: RecoveryRepair[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const verified = repairs.filter(isVerifiedReceipt);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[#111111]/90">
      <div className="shrink-0 border-b border-[#272727] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[#EDEDED]">Repairs</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid min-h-32 place-items-center font-mono text-xs text-[#8B949E]">Loading repairs…</div>
        ) : verified.length === 0 ? (
          <div className="grid min-h-32 place-items-center px-6 text-center text-sm text-[#8B949E]">No verified repairs for this collector yet.</div>
        ) : (
          <Table aria-label="Repairs">
            <TableHeader className="sticky top-0 z-10 bg-[#181818]">
              <TableRow>
                <TableHead className="pl-4">Detected</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead>Fields restored</TableHead>
                <TableHead>Template</TableHead>
                <TableHead className="pr-4 text-right">Receipt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verified.map((repair) => (
                <TableRow key={repair.id}>
                  <TableCell className="pl-4 font-mono text-xs text-[#A1A1AA]">{displayTime(repair.detectedAt)}</TableCell>
                  <TableCell className="font-mono text-xs text-[#A1A1AA]">{displayTime(repair.verifiedAt)}</TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex max-w-56 flex-wrap gap-1.5">
                      {repair.fieldsRestored.length > 0
                        ? repair.fieldsRestored.map((field) => (
                            <span key={field} className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200">
                              {field}
                            </span>
                          ))
                        : <span className="text-xs text-[#71717A]">—</span>}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <p className="max-w-56 truncate font-mono text-[11px] text-[#9B9B9B]" title={`${repair.templateBefore ?? '—'} → ${repair.templateAfter ?? '—'}`}>
                      {repair.templateBefore ?? '—'} → {repair.templateAfter ?? '—'}
                    </p>
                  </TableCell>
                  <TableCell className="pr-4 text-right font-mono text-xs text-[#A5B4FC]" title={repair.receiptSha256 ?? undefined}>
                    {compactHash(repair.receiptSha256)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {hasMore && <LoadMore loading={loadingMore} onClick={onLoadMore} />}
    </div>
  );
}
