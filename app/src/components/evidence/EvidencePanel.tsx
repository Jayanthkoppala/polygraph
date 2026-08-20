/**
 * EvidencePanel — the FOCUS region, and the direct fix for the user's
 * complaint: "I won't get understanding — why there is no reason, or
 * events, or what the event even emits." Every check always renders,
 * including passes and not-applicable-with-reason (ux-spec.md §5: "the
 * passes are what make the failure believable"); every proof comes from
 * `lib/evidence.ts`'s translation module, never a raw metric name.
 *
 * Sits on the warm archive material (`--color-archive`, ui-system.md §1.2)
 * — this is the immutable-record half of the product, same substance as
 * the ledger stream, and it looks physically different from the mutable
 * fleet cards for exactly that reason.
 */
import { useState } from 'react';
import { CheckCircle, XCircle, Minus, Copy, Check } from '@phosphor-icons/react';
import { translateEvidence, type EvidenceLine, type IdentityMismatch, type CanaryOutcome } from '@/lib/evidence';
import { VERDICT, toVerdictState } from '@/lib/verdict';
import type { CollectorState } from '@/lib/api';

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
        <h3 className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">What we checked</h3>
        {lines.map((line) => (
          <EvidenceRow key={line.check} line={line} />
        ))}
      </section>

      {identityMismatches.length > 0 && (
        <section aria-label="Requested vs received" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Requested vs received</h3>
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
          {identityMismatches.length > 5 && (
            <p className="font-mono text-xs text-[#6E7681]">+ {identityMismatches.length - 5} more</p>
          )}
        </section>
      )}

      {canaryOutcomes.length > 0 && (
        <section aria-label="Canary outcomes, per input" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Canary, per input</h3>
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

      {state === 'WRONG_TARGET' && <RefusalPanel actionReason={collector.actionReason} />}
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
            className="font-mono text-xs text-[#6E7681] underline decoration-dotted outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
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

function HealCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    void clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard unavailable (permissions, insecure context) — the
        // command is still fully visible and selectable as plain text.
      });
  };

  return (
    <section aria-label="Run it yourself" className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-[#9B9B9B]">Run it yourself</h3>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Command copied' : 'Copy heal command'}
        className="flex items-center justify-between gap-2 rounded-sm border border-[#272727] bg-[#000000] px-3 py-2 text-left font-mono text-xs text-[#EDEDED] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
      >
        <code className="truncate">{command}</code>
        <span className="flex shrink-0 items-center gap-1 text-[#9B9B9B]">
          {copied ? <Check size={12} weight="regular" aria-hidden /> : <Copy size={12} weight="regular" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </span>
      </button>
    </section>
  );
}

/**
 * The refusal panel (ux-spec.md §6, "the heal refused moment"): calm,
 * bordered, confident — never error-red styling. Three parts always, in
 * order: the refusal plainly, the reason in the user's terms, the one
 * thing that can actually be done. No "force repair anyway" escape hatch —
 * there isn't one in the engine and the UI must not imply otherwise.
 */
function RefusalPanel({ actionReason }: { actionReason: string | null }) {
  return (
    <section
      aria-label="Repair refused"
      data-testid="refusal-panel"
      className="mt-auto flex flex-col gap-2 rounded-2xl border p-4"
      style={{ borderColor: 'var(--color-verdict-target)' }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--color-verdict-target)' }}>
        Repair refused.
      </p>
      <p className="text-sm text-[#B4B4B4]">
        {actionReason ??
          'This collector returned well-formed data for the wrong entity. Re-deriving a field selector cannot fix fetching the wrong target.'}
      </p>
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
