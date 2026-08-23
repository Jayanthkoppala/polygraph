// The expanded Repairs row: the whole story of one repair, top to bottom.
//
// A repair receipt has to answer three questions in the order a customer asks
// them — what broke, what did you do about it, and how do I know it worked —
// so the panel is three stacked blocks in exactly that order, with the
// tamper-evident receipt last.
//
// The redaction rule is the same one the server enforces (recovery/api.ts,
// recovery/repair-detail.ts) and is repeated here because this is the surface
// where breaking it would be visible: field NAMES, fill RATES, ids, counts,
// and timestamps only. No row value, no provider error text, no secret ever
// reaches this component, and nothing here reconstructs one.
import type { RecoveryRepair, RepairDetail, RepairTimelineStep } from '@/lib/recoveryApi';

/** Customer-facing words for each step the worker records. An unrecognised
 *  status degrades to the bare code rather than being hidden: a step that
 *  happened is always worth showing, even if this build has no copy for it. */
const STEP_COPY: Record<string, string> = {
  REFACTOR_STARTED: 'Repair started',
  PROVIDER_JOB_STARTED: 'Bright Data job accepted',
  AWAITING_APPROVAL: 'Provider produced a candidate',
  PREVIEW_CHECKED: 'Preview checked',
  APPROVED_AUTOSAVE: 'Approved with auto-save',
  PUBLISHED: 'New template published',
  VERIFYING: 'Verification started',
  VERIFICATION_RUN_STARTED: 'Fresh verification run',
  TEMPLATE_PUBLISHED: 'Template version confirmed',
  VERIFIED: 'Verified',
  FAILED: 'Repair failed',
  HELD_POLICY: 'Held by policy',
  HELD_BUDGET: 'Held — repair budget',
  HELD_PROVIDER_STATE_UNKNOWN: 'Held — provider state unknown',
  // Provider-side step names carried through from the publication proof, used
  // when a pre-timeline cycle has no per-step times of its own.
  save_new_template: 'Saved the new template',
};

export function stepLabel(status: string): string {
  return STEP_COPY[status] ?? status;
}

/** "1.4s" / "3m 20s" / "1h 04m". Durations here are per-step, so seconds are
 *  the useful unit and hours are the ceiling worth spelling out. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function displayTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function clockTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString();
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8B949E]">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-[#71717A]">{label}</span>
      <span className={`min-w-0 truncate text-right text-[11px] text-[#D4D4D8] ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function FieldTable({ detail }: { detail: RepairDetail }) {
  const detected = detail.detected;
  const regressed = new Set(detected?.regressedFields ?? []);
  // Only the fields that actually moved: a 40-field collector's receipt is
  // about the three that broke, not the 37 that were fine.
  const rows = (detected?.fields ?? []).filter((f) => regressed.has(f.field) || f.damaged);
  if (rows.length === 0) return null;
  return (
    <table className="w-full table-fixed border-separate border-spacing-y-1 text-[11px]">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-[#71717A]">
          <th className="w-1/2 text-left font-medium">Field</th>
          <th className="text-right font-medium">Baseline fill</th>
          <th className="text-right font-medium">At the break</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((field) => (
          <tr key={field.field}>
            <td className="truncate pr-2 font-mono text-[#EDEDED]" title={field.field}>
              {field.field}
              {field.regression && <span className="ml-1.5 text-[10px] text-[#71717A]">({field.regression})</span>}
            </td>
            <td className="text-right font-mono tabular-nums text-[#A1A1AA]">{formatPercent(field.baselineFill)}</td>
            <td className="text-right font-mono tabular-nums text-red-300">{formatPercent(field.incidentFill)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Timeline({ steps }: { steps: RepairTimelineStep[] }) {
  if (steps.length === 0) {
    return <p className="text-[11px] text-[#71717A]">No step-by-step trail was recorded for this repair.</p>;
  }
  return (
    <ol className="flex flex-col" data-testid="receipt-timeline">
      {steps.map((step, index) => {
        const duration = formatDuration(step.durationMs);
        return (
          <li key={`${step.status}-${index}`} className="flex gap-3">
            {/* The rail: a dot per step, a hairline between them. The last
                step gets no trailing line — the story ends there. */}
            <div className="flex w-3 shrink-0 flex-col items-center pt-1.5">
              <span className="size-1.5 shrink-0 rounded-full bg-[#8b5cf6]" aria-hidden />
              {index < steps.length - 1 && <span className="w-px flex-1 bg-[#313131]" aria-hidden />}
            </div>
            <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3 pb-2.5">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] text-[#EDEDED]">{stepLabel(step.status)}</span>
                {step.note && (
                  <span className="truncate font-mono text-[10px] text-[#71717A]" title={step.note}>
                    {step.note}
                  </span>
                )}
              </div>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-[#8B949E]">
                {clockTime(step.at)}
                {duration && <span className="ml-1.5 text-[#5A5A60]">+{duration}</span>}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Whether this repair is a field repair against a healthy baseline, or the
 *  collector's first working version. Mirrors `repairModeLabel`, kept in sync
 *  by both reading `mode`. */
export function detailModeLabel(detail: RepairDetail): string {
  return detail.mode === 'bootstrap' ? 'First working version' : 'Field repair';
}

export function ReceiptDetail({ repair, detail }: { repair: RecoveryRepair; detail: RepairDetail }) {
  const { detected, publication, verification, receipt } = detail;
  const template = `${publication.templateBefore ?? '—'} → ${publication.templateAfter ?? '—'}`;
  const total = formatDuration(detail.totalDurationMs);

  return (
    <div
      data-testid={`receipt-detail-${repair.id}`}
      className="grid gap-6 border-t border-[#272727] bg-[#0D0D0D] px-4 py-4 lg:grid-cols-3"
    >
      <Section title="Detected">
        <div className="flex flex-col gap-1">
          <Fact label="Delivery" value={displayTime(detected?.receivedAt ?? null)} />
          <Fact label="Rows" value={detected?.rowCount !== null && detected?.rowCount !== undefined ? String(detected.rowCount) : '—'} />
          <Fact label="Verdict" value={detected?.verdict ? `${detected.verdict}${detected.cause ? ` (${detected.cause})` : ''}` : '—'} />
          {detected?.errorCount ? <Fact label="Error records" value={String(detected.errorCount)} /> : null}
          <Fact label="Mode" value={detailModeLabel(detail)} mono={false} />
        </div>
        <FieldTable detail={detail} />
        {detected && detected.regressedFields.length === 0 && (
          <p className="text-[11px] text-[#71717A]">
            No prior baseline to regress against — this collector had never produced a healthy delivery.
          </p>
        )}
      </Section>

      <Section title="What Polygraph did">
        <Timeline steps={detail.timeline} />
        <div className="flex flex-col gap-1 border-t border-[#1F1F1F] pt-2">
          <Fact label="Bright Data job" value={publication.providerJobId ?? '—'} />
          <Fact label="Template" value={template} />
          {publication.previewFieldsPresent.length > 0 && (
            <Fact label="Preview fields" value={publication.previewFieldsPresent.join(', ')} />
          )}
          {publication.completedSteps.length > 0 && (
            <Fact label="Provider steps" value={publication.completedSteps.join(' → ')} />
          )}
          {total && <Fact label="Total" value={total} />}
        </div>
      </Section>

      <Section title="Verified">
        <div className="flex flex-col gap-1">
          <Fact label="Verification run" value={verification.runId ?? '—'} />
          <Fact label="Ran at" value={displayTime(verification.receivedAt)} />
          <Fact label="Rows" value={verification.rowCount !== null ? String(verification.rowCount) : '—'} />
          <Fact
            label="Fields restored"
            value={
              verification.fieldsRestoredRate !== null
                ? `${formatPercent(verification.fieldsRestoredRate)} (${verification.fieldsRestored.length})`
                : `${verification.fieldsRestored.length} field(s)`
            }
          />
          {verification.fieldsRestored.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {verification.fieldsRestored.map((field) => (
                <span
                  key={field}
                  className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200"
                >
                  {field}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 border-t border-[#1F1F1F] pt-2">
          <Fact label="Receipt" value={receipt.sha256 ?? '—'} />
          <Fact label="Verified at" value={displayTime(receipt.verifiedAt)} />
          <Fact label="Ledger event" value={receipt.ledgerEventId !== null ? `#${receipt.ledgerEventId}` : '—'} />
        </div>
      </Section>
    </div>
  );
}
