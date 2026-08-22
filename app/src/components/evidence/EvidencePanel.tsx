// Every check always renders, passes included — "the passes are what make the failure
// believable" (§5). Proofs come from lib/evidence.ts, never a raw metric name.

// On the warm archive material (§1.2): the immutable-record half of the product, and
// deliberately a different substance from the mutable fleet cards.
import { useState } from 'react';
import { CheckCircle, XCircle, Minus, Copy, Check, ArrowsClockwise } from '@phosphor-icons/react';
import { translateEvidence, type EvidenceLine, type IdentityMismatch, type CanaryOutcome } from '@/lib/evidence';
import { VERDICT, toVerdictState } from '@/lib/verdict';
import type { CollectorState } from '@/lib/api';

/** The panel's section headings — one eyebrow treatment, said once. */
const SECTION_HEADING = 'text-xs font-medium uppercase tracking-wide text-[#9B9B9B]';

export function EvidencePanel({ collector }: { collector: CollectorState | null }) {
  if (!collector) {
    return (
      <div
        data-testid="evidence-panel-empty"
        className="flex h-full flex-col items-center justify-center gap-2 rounded-2xl border border-[#272727] bg-[var(--color-archive)] p-6 text-center"
      >
        <p className="text-sm text-[#9B9B9B]">Select a collector to see its evidence.</p>
      </div>
    );
  }

  const state = toVerdictState(collector);
  const meta = VERDICT[state];
  const lines = translateEvidence({ evidence: collector.evidence, cause: collector.cause, rows: collector.rows });

  const identityLine = lines.find((l) => l.check === 'identity');
  const identityMismatches = asMismatches(identityLine?.raw?.metrics?.mismatches);
  const canaryLine = lines.find((l) => l.check === 'canary');
  const canaryOutcomes = asOutcomes(canaryLine?.raw?.metrics?.outcomes);

  return (
    <div
      data-testid="evidence-panel"
      className="flex h-full flex-col gap-4 overflow-y-auto rounded-2xl border border-[#272727] bg-[var(--color-archive)] p-4"
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-base font-semibold text-[#EDEDED]">{collector.name}</h2>
          <span className="shrink-0 font-mono text-xs tabular-nums text-[#9B9B9B]">
            {collector.lastTs ? new Date(collector.lastTs).toLocaleTimeString() : 'Awaiting first run'}
          </span>
        </div>
        <div className="rounded-lg border p-3" style={{ borderColor: meta.color }}>
          <span className="text-sm font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
            {meta.label}
          </span>
          {collector.actionReason && state !== 'WRONG_TARGET' && (
            <p className="mt-1 text-sm text-[#B4B4B4]">{collector.actionReason}</p>
          )}
        </div>
      </header>

      <section aria-label="What we checked" className="flex flex-col gap-3">
        <h3 className={SECTION_HEADING}>What we checked</h3>
        {lines.map((line) => (
          <EvidenceRow key={line.check} line={line} />
        ))}
      </section>

      {identityMismatches.length > 0 && (
        <section aria-label="Requested vs received" className="flex flex-col gap-1">
          <h3 className={SECTION_HEADING}>Requested vs received</h3>
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr className="text-left text-[#9B9B9B]">
                <th className="border-b border-[#272727] pb-1 pr-2 font-medium">We asked for</th>
                <th className="border-b border-[#272727] pb-1 font-medium">We received</th>
              </tr>
            </thead>
            <tbody>
              {identityMismatches.slice(0, 5).map((m, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2 text-[#EDEDED]">{m.requestedKey}</td>
                  <td className="py-1" style={{ color: 'var(--color-verdict-target)' }}>
                    {m.extractedKey}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* "+ 40 more" is part of the proof, not chrome, so it takes the muted
              text token rather than the decoration-only #6E7681 that fails AA. */}
          {identityMismatches.length > 5 && (
            <p className="font-mono text-xs text-[#9B9B9B]">+ {identityMismatches.length - 5} more</p>
          )}
        </section>
      )}

      {canaryOutcomes.length > 0 && (
        <section aria-label="Canary outcomes, per input" className="flex flex-col gap-1">
          <h3 className={SECTION_HEADING}>Canary, per input</h3>
          <div className="flex items-center gap-1">
            {canaryOutcomes.map((o, i) => (
              <span
                key={i}
                title={o.pass ? `${o.input}: passed` : `${o.input}: ${o.reason ?? 'failed'}`}
                data-testid="canary-dot"
                data-pass={o.pass}
                className="h-2 w-2 rounded-full"
                style={{
                  background: o.pass ? 'var(--color-verdict-pass)' : 'transparent',
                  border: `1px solid ${o.pass ? 'var(--color-verdict-pass)' : 'var(--color-verdict-shape)'}`,
                }}
              />
            ))}
          </div>
        </section>
      )}

      {collector.suggestedHealCommand && <HealCommand command={collector.suggestedHealCommand} />}

      {state === 'WRONG_TARGET' && <RefusalPanel collector={collector} />}
    </div>
  );
}

function EvidenceRow({ line }: { line: EvidenceLine }) {
  const [showRaw, setShowRaw] = useState(false);
  const Icon = line.status === 'pass' ? CheckCircle : line.status === 'fail' ? XCircle : Minus;
  const color =
    line.status === 'pass'
      ? 'var(--color-verdict-pass)'
      : line.status === 'fail'
        ? 'var(--color-verdict-shape)'
        : 'var(--color-verdict-unchecked)';

  return (
    <div
      data-testid={`evidence-row-${line.check}`}
      data-status={line.status}
      className="flex flex-col gap-1 border-b border-[#272727] pb-3 last:border-b-0 last:pb-0"
    >
      <div className="flex items-start gap-2">
        <Icon size={16} weight="regular" style={{ color }} aria-hidden className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[#B4B4B4]">
            <span className="font-medium text-[#EDEDED]">{line.label}</span> {line.sentence}
          </p>
          {line.detail && <p className="mt-1 text-sm text-[#B4B4B4]">{line.detail}</p>}
        </div>
      </div>
      {line.raw && (
        <div className="pl-6">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
            className="font-mono text-xs text-[#9B9B9B] underline decoration-dotted outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            ⌄ raw
          </button>
          {showRaw && (
            <pre
              data-testid={`evidence-raw-${line.check}`}
              className="mt-1 overflow-x-auto rounded-sm bg-[#000000] p-2 font-mono text-xs text-[#9B9B9B]"
            >
              {JSON.stringify(line.raw.metrics ?? {}, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Copy-with-confirmation. A rejected write is swallowed: the command stays visible
 *  and selectable as plain text, so an unavailable clipboard costs the user nothing. */
function useCopyCommand(command: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    void clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return [copied, copy];
}

function HealCommand({ command }: { command: string }) {
  const [copied, onCopy] = useCopyCommand(command);

  return (
    <section aria-label="Run it yourself" className="flex flex-col gap-1">
      <h3 className={SECTION_HEADING}>Run it yourself</h3>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Command copied' : 'Copy heal command'}
        className="flex min-w-0 max-w-full items-center justify-between gap-2 rounded-sm border border-[#272727] bg-[#000000] px-3 py-2 text-left font-mono text-xs text-[#EDEDED] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
      >
        <code className="min-w-0 truncate">{command}</code>
        <span className="flex shrink-0 items-center gap-1 text-[#9B9B9B]">
          {copied ? <Check size={12} weight="regular" aria-hidden /> : <Copy size={12} weight="regular" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </span>
      </button>
    </section>
  );
}

// The heal-refused moment (§6): refusal, reason, then the one real thing to do.
// Never error-red, and never a "force repair anyway" escape hatch — the engine has none.

// Ignores `collector.actionReason` deliberately: that string is policy.ts's REDISCOVER
// diagnosis, which argues FOR repairability at the moment the product is refusing.

// v1 has no rediscover endpoint, so the button hands over the re-verify command and
// says so — it never implies Polygraph will re-point the collector for you.
function RefusalPanel({ collector }: { collector: CollectorState }) {
  const command = `polygraph run --collector ${collector.id}`;
  const [copied, onRediscover] = useCopyCommand(command);

  return (
    <section
      aria-label="Repair refused"
      data-testid="refusal-panel"
      className="mt-auto flex flex-col gap-3 rounded-2xl border p-4"
      style={{ borderColor: 'var(--color-verdict-target)' }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--color-verdict-target)' }}>
        Repair refused.
      </p>
      <p className="text-sm text-[#B4B4B4]">
        This collector returned well-formed data for the wrong entity. Repairing a field selector fixes a broken parser,
        not a request that landed on the wrong page — so Polygraph will not offer a repair it can&apos;t justify.
      </p>

      <div className="flex flex-col gap-2">
        {/* Action and ledger citation share a row: §6 part 3 is one beat, and one
            line is what keeps the panel inside the FOCUS region at 1512x805. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onRediscover}
            data-testid="rediscover-button"
            aria-label="Re-discover the target — copies the command that re-verifies this collector"
            className="flex w-fit items-center gap-2 rounded-lg border border-[#313131] bg-[var(--color-raised)] px-3 py-2 text-sm font-medium text-[#EDEDED] shadow-[var(--shadow-e2)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            {copied ? (
              <Check size={14} weight="regular" aria-hidden />
            ) : (
              <ArrowsClockwise size={14} weight="regular" aria-hidden />
            )}
            {copied ? 'Command copied' : 'Re-discover the target'}
          </button>
          <p data-testid="refusal-ledger-ref" className="font-mono text-xs tabular-nums text-[#9B9B9B]">
            {collector.ledgerId != null
              ? `Ledger #${collector.ledgerId} records this refusal.`
              : 'Not on the ledger yet — no run has been recorded.'}
          </p>
        </div>
        <p className="text-xs text-[#9B9B9B]">
          Re-point this collector at the right target, then re-verify —{' '}
          <code className="font-mono text-[#EDEDED]">{command}</code>. Polygraph will not re-point a collector for you.
        </p>
      </div>
    </section>
  );
}

function asMismatches(value: unknown): IdentityMismatch[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (m): m is IdentityMismatch =>
      !!m && typeof m === 'object' && typeof (m as IdentityMismatch).requestedKey === 'string',
  );
}

function asOutcomes(value: unknown): CanaryOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.filter((o): o is CanaryOutcome => !!o && typeof o === 'object' && typeof (o as CanaryOutcome).pass === 'boolean');
}
