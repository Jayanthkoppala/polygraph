// The two right-side tables: "Accepted results" (raw deliveries for the selected
// collector) and "Repairs" (verified receipts only). Table headers stay pinned;
// only each `<tbody>`'s wrapper scrolls — RecoveryWorkspace gives each a bounded
// height via `min-h-0 flex-1` ancestors.
//
// A Repairs row is a receipt: clicking it expands the full end-to-end story of
// that repair INSIDE the table body (`ReceiptDetail`), which is why the detail
// must never be a dialog or a second page — the workspace is one viewport, and
// the scroll that reveals the story belongs to the table, not the document.
import { Fragment, useState } from 'react';
import { CaretRight, CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReceiptDetail } from './ReceiptDetail';
import { successRate, templateLabel, triggerLabel, verdictLabel } from './verdictLabel';
import { brokenChangeSentence, brokenFields, generationLine, repairNarrative } from './repairNarrative';
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
/** Repair column copy. A bootstrap receipt is the collector's first working
 * version — there was no baseline to restore fields against. */
export function repairModeLabel(repair: RecoveryRepair): string {
  return repair.mode === 'bootstrap' ? 'First working version' : 'Field repair';
}

/** "2 · crawl_error" — the count and the most frequent code; every code with
 * its count goes in the cell's tooltip. `errorCodes` is already counts only,
 * so nothing here can leak a message or an input. */
export function errorSummaryLabel(delivery: Pick<RecoveryDelivery, 'errorCount' | 'errorCodes'>): {
  label: string;
  title: string;
} | null {
  if (!delivery.errorCount) return null;
  const codes = Object.entries(delivery.errorCodes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = codes[0]?.[0];
  const label = top ? `${delivery.errorCount} · ${top}` : String(delivery.errorCount);
  const title = codes.length > 0
    ? codes.map(([code, n]) => `${code} × ${n}`).join('\n')
    : `${delivery.errorCount} error record(s)`;
  return { label, title };
}

export function isVerifiedReceipt(repair: RecoveryRepair): boolean {
  return repair.status === undefined || repair.status.toUpperCase() === 'VERIFIED';
}

/** Chip colours per verdict tone. `muted` has no entry: a test sample renders
 *  as plain text, never as a chip. */
const VERDICT_TONE: Record<'pass' | 'fail' | 'blocked' | 'neutral', string> = {
  pass: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  fail: 'border-red-400/30 bg-red-400/10 text-red-300',
  blocked: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  neutral: 'border-[#3A3A3A] bg-[#1B1B1B] text-[#A1A1AA]',
};

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
                <TableHead className="pl-4">Run ID</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Template</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Success</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead className="pr-4">Baseline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => {
                const errors = errorSummaryLabel(delivery);
                const template = templateLabel(delivery.template);
                const verdict = verdictLabel(delivery);
                const success = successRate(delivery);
                return (
                <TableRow key={delivery.id}>
                  <TableCell
                    className="max-w-44 truncate py-1.5 pl-4 font-mono text-xs text-[#D4D4D8]"
                    title={delivery.providerRunId ?? String(delivery.id)}
                  >
                    {delivery.providerRunId ?? compactHash(String(delivery.id))}
                  </TableCell>
                  <TableCell className="py-1.5 text-xs text-[#A1A1AA]">{triggerLabel(delivery.source)}</TableCell>
                  <TableCell className="py-1.5 font-mono text-xs text-[#9B9B9B]" title={template.title}>
                    {template.label}
                  </TableCell>
                  <TableCell className="py-1.5 text-right font-mono text-xs tabular-nums text-[#D4D4D8]">
                    {delivery.rowCount ?? '—'}
                  </TableCell>
                  <TableCell className="py-1.5 text-right font-mono text-xs tabular-nums">
                    {errors ? (
                      <span className="text-amber-200" title={errors.title}>{errors.label}</span>
                    ) : (
                      <span className="text-[#71717A]">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-1.5 text-right font-mono text-xs tabular-nums text-[#A1A1AA]">
                    {success === null ? '—' : `${Math.round(success * 100)}%`}
                  </TableCell>
                  <TableCell className="py-1.5 font-mono text-xs text-[#A1A1AA]">{displayTime(delivery.receivedAt)}</TableCell>
                  <TableCell className="py-1.5 text-xs">
                    {verdict.tone === 'muted' ? (
                      <span className="text-[#71717A]" title={verdict.title}>{verdict.label}</span>
                    ) : (
                      <span
                        title={verdict.title}
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] ${VERDICT_TONE[verdict.tone]}`}
                      >
                        {verdict.label}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-1.5 pr-4">
                    {delivery.isBaseline && (
                      <span className="rounded-full border border-indigo-400/30 bg-indigo-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-indigo-200">
                        Baseline
                      </span>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
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
  // One receipt open at a time: two expanded stories in a bounded table body
  // means neither is readable without scrolling past the other.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#272727] bg-[#111111]/90">
      <div className="shrink-0 border-b border-[#272727] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[#EDEDED]">Repair receipts</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid min-h-32 place-items-center font-mono text-xs text-[#8B949E]">Loading repairs…</div>
        ) : verified.length === 0 ? (
          <div className="grid min-h-32 place-items-center px-6 text-center text-sm text-[#8B949E]">No verified repairs for this collector yet.</div>
        ) : (
          <Table aria-label="Repair receipts">
            <TableHeader className="sticky top-0 z-10 bg-[#181818]">
              <TableRow>
                <TableHead className="pl-4">Detected</TableHead>
                <TableHead>Collector</TableHead>
                <TableHead>Broken change</TableHead>
                <TableHead>Repair</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="pr-4 text-right">Receipt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verified.map((repair) => {
                const rowId = String(repair.id);
                const open = expandedId === rowId;
                const broken = brokenFields(repair);
                const generation = generationLine(repair);
                return (
                <Fragment key={rowId}>
                <TableRow
                  data-testid={`repair-row-${rowId}`}
                  data-expanded={open ? 'true' : 'false'}
                  onClick={() => setExpandedId(open ? null : rowId)}
                  className="cursor-pointer"
                >
                  <TableCell className="pl-4 align-top font-mono text-xs text-[#A1A1AA]">
                    <span className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? `Hide repair receipt for ${repair.collectorName}` : `Show repair receipt for ${repair.collectorName}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedId(open ? null : rowId);
                        }}
                        className="grid size-4 shrink-0 place-items-center rounded text-[#8B949E] transition-colors hover:text-[#EDEDED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#EDEDED]"
                      >
                        <CaretRight size={11} weight="bold" className={open ? 'rotate-90 transition-transform' : 'transition-transform'} aria-hidden />
                      </button>
                      {displayTime(repair.detectedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="max-w-40">
                      <p className="truncate text-sm font-medium text-[#EDEDED]">{repair.collectorName}</p>
                      <p className="truncate font-mono text-[11px] text-[#777]">{repair.collectorId}</p>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal align-top">
                    <div className="max-w-72 space-y-2">
                      <p className="line-clamp-2 text-sm text-[#D4D4D8]">{brokenChangeSentence(repair)}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {broken.length > 0
                          ? broken.map((field) => (
                              <span key={field} className="rounded border border-red-400/20 bg-red-400/10 px-1.5 py-0.5 font-mono text-[10px] text-red-200">
                                {field}
                              </span>
                            ))
                          : <span className="font-mono text-[10px] text-[#71717A]">structural</span>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal align-top">
                    <div className="max-w-72 space-y-1.5">
                      {generation && (
                        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#818CF8]">{generation}</p>
                      )}
                      <p className="line-clamp-2 text-sm text-[#A1A1AA]">{repairNarrative(repair)}</p>
                      <p className="font-mono text-[10px] text-[#62626A]">{repairModeLabel(repair)}</p>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="space-y-1.5">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-emerald-300">
                        <CheckCircle size={13} weight="fill" aria-hidden />
                        Verified
                      </span>
                      <p className="font-mono text-[10px] text-[#71717A]">{displayTime(repair.verifiedAt)}</p>
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right align-top">
                    <p className="font-mono text-xs text-[#A5B4FC]" title={repair.receiptSha256 ?? undefined}>
                      #{compactHash(repair.receiptSha256)}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-[#62626A]">
                      {repair.detail?.receipt.ledgerEventId != null
                        ? `Ledger #${repair.detail.receipt.ledgerEventId}`
                        : 'Live evidence'}
                    </p>
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="p-0">
                      {repair.detail ? (
                        <ReceiptDetail repair={repair} detail={repair.detail} />
                      ) : (
                        <p className="border-t border-[#272727] bg-[#0D0D0D] px-4 py-3 text-xs text-[#71717A]">
                          The full record for this repair is not available.
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <PaginationFooter {...pager} rowCount={verified.length} />
    </div>
  );
}
