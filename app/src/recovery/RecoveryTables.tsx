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

export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

/** The pagination controls shared by both tables. `page`/`total` are 1-indexed
 * and server-reported; `changing` covers the brief window between clicking
 * Prev/Next/page-size and the new page landing, so the old rows stay visible
 * (no flash to an empty state) while it spins. */
function PaginationFooter({
  page,
  pageSize,
  total,
  rowCount,
  startIndex,
  hasNext,
  changing,
  onPrev,
  onNext,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  rowCount: number;
  startIndex: number;
  hasNext: boolean;
  changing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPageSizeChange: (size: number) => void;
}) {
  const start = total === 0 ? 0 : startIndex + 1;
  const end = total === 0 ? 0 : startIndex + rowCount;
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-line)] px-4 py-2 font-mono text-[11px] text-[#8B949E]">
      <span>
        Showing {start}–{end} of {total}
        {changing && <CircleNotch size={11} className="ml-1.5 inline animate-spin align-[-1px]" aria-hidden />}
      </span>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Rows per page</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="rounded-md border border-[#313131] bg-[#1B1B1B] px-1.5 py-1 text-[11px] text-[#EDEDED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#EDEDED]"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
        </label>
        <span>Page {page}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPrev}
            disabled={page <= 1 || changing}
            className="rounded-md border border-[#313131] bg-[#1B1B1B] px-2 py-1 text-[11px] font-medium text-[#EDEDED] transition-[background-color,border-color] hover:border-[#4B4B4B] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext || changing}
            className="rounded-md border border-[#313131] bg-[#1B1B1B] px-2 py-1 text-[11px] font-medium text-[#EDEDED] transition-[background-color,border-color] hover:border-[#4B4B4B] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

export interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  startIndex: number;
  hasNext: boolean;
  changing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPageSizeChange: (size: number) => void;
}

export function AcceptedResultsTable({
  deliveries,
  loading,
  pager,
}: {
  deliveries: RecoveryDelivery[];
  loading: boolean;
  pager: PagerProps;
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
                  <TableCell
                    className="max-w-40 truncate font-mono text-xs text-[#9B9B9B]"
                    title={delivery.providerRunId ?? String(delivery.id)}
                  >
                    {delivery.providerRunId ?? compactHash(String(delivery.id))}
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
      <PaginationFooter {...pager} rowCount={deliveries.length} />
    </div>
  );
}

export function RepairsTable({
  repairs,
  loading,
  pager,
}: {
  repairs: RecoveryRepair[];
  loading: boolean;
  pager: PagerProps;
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
      <PaginationFooter {...pager} rowCount={verified.length} />
    </div>
  );
}
