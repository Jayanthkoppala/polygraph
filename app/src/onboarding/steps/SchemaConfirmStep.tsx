/**
 * Step 3 — "Confirm what good looks like" (ux-spec.md §0.5, §6). REQUIRED,
 * not optional: without a confirmed schema every hosted collector renders
 * NOT VERIFIED forever (src/tenancy/onboarding.ts's whole reason for
 * existing). Runs once per collector in `OnboardingState.candidates`,
 * driven from this component rather than the wizard shell so each
 * collector's own create-draft -> infer -> probe -> confirm lifecycle stays
 * local and independently retryable.
 *
 * ux-spec.md §6's mockup shows a "FILLED 98%" percentage column. The real
 * probe endpoint (`probeCollectorLive` in ../api.ts) does not return a
 * fill-rate percentage — see that file's module doc for why. This renders
 * the honest signal actually available (`everFilled`) instead of a
 * fabricated number; defaults are pre-ticked required exactly where the
 * spec's own rule would land in the common case (a field observed with no
 * empty-like value IS the ≥95%-filled case for a probe this small).
 *
 * A zero-row probe (`draft.empty`) routes to `onSkippedEmpty` — ux-spec.md
 * §6: "it goes to NOT VERIFIED... and onboarding continues rather than
 * blocking" — never renders a fabricated table.
 */
import { useState } from 'react';
import { ClipboardText, WarningCircle } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import {
  createCollectorDraft,
  inferCollectorSchema,
  probeCollectorLive,
  confirmCollectorSchema,
  ApiError,
  type ProbeFieldDraft,
} from '../api';
import type { CollectorCandidate } from '../machine';

type Phase = 'inputs' | 'running' | 'ready' | 'error';

interface FieldRow extends ProbeFieldDraft {
  required: boolean;
}

export interface SchemaConfirmStepProps {
  collector: CollectorCandidate;
  position: { index: number; total: number };
  onConfirmed: (id: string) => void;
  onSkippedEmpty: (id: string) => void;
}

export function SchemaConfirmStep({ collector, position, onConfirmed, onSkippedEmpty }: SchemaConfirmStepProps) {
  const [phase, setPhase] = useState<Phase>('inputs');
  const [canaryRaw, setCanaryRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [entityKey, setEntityKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canaryInputs = canaryRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);

  async function runProbe() {
    if (canaryInputs.length === 0) return;
    setPhase('running');
    setError(null);
    try {
      await createCollectorDraft({ collectorId: collector.id, name: collector.name, canaryInputs });
      await inferCollectorSchema(collector.id); // pre-warms names; probe is the source of truth used below
      const draft = await probeCollectorLive(collector.id);
      if (draft.empty) {
        onSkippedEmpty(collector.id);
        return;
      }
      const rows: FieldRow[] = draft.fields.map((f) => ({ ...f, required: f.everFilled }));
      // Highest-cardinality short string field, preferring an id/sku/key-
      // named field when one exists — the same heuristic ux-spec.md §6
      // describes ("pre-selects the highest-cardinality short string
      // field"), approximated here since this client doesn't have raw row
      // data to compute cardinality from (only one probe run's samples).
      const guess =
        rows.find((f) => /(^|_)(id|sku|key)$/i.test(f.name) && typeof f.sample === 'string') ??
        rows.find((f) => typeof f.sample === 'string');
      setFields(rows);
      setEntityKey(guess?.name ?? null);
      setPhase('ready');
    } catch (err) {
      setPhase('error');
      setError(err instanceof ApiError ? err.message : 'Could not reach Polygraph — try again.');
    }
  }

  async function handleConfirm() {
    setSaving(true);
    try {
      await confirmCollectorSchema(
        collector.id,
        fields.map((f) => ({ name: f.name, type: f.type, required: f.required, defaultValue: f.defaultValue })),
        entityKey,
      );
      onConfirmed(collector.id);
    } catch (err) {
      setSaving(false);
      setError(err instanceof ApiError ? err.message : 'Could not reach Polygraph — try again.');
    }
  }

  if (phase === 'inputs') {
    return (
      <OnboardingPanel
        title={`Point at ${collector.name}`}
        subtitle={`Collector ${position.index + 1} of ${position.total}. What input(s) trigger a run?`}
      >
        <div className="flex flex-col gap-4">
          <textarea
            data-testid="canary-inputs"
            rows={4}
            value={canaryRaw}
            onChange={(e) => setCanaryRaw(e.target.value)}
            placeholder={'SKU-4471\nSKU-4482'}
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 font-mono text-sm text-[#EDEDED] outline-none placeholder:text-[#8B949E] focus-visible:border-[#EDEDED]"
          />
          <p className="text-xs text-[#8B949E]">Up to 5. We&rsquo;ll run one of these live, once, to see what comes back.</p>
          {error && (
            <p role="alert" className="text-sm text-[var(--color-verdict-shape)]">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={canaryInputs.length === 0}
            onClick={runProbe}
            className="flex h-10 items-center justify-center rounded-sm bg-[#EDEDED] text-sm font-medium text-[#131209] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run it once
          </button>
        </div>
      </OnboardingPanel>
    );
  }

  if (phase === 'running') {
    return (
      <OnboardingPanel title={`Point at ${collector.name}`} subtitle="Running it once, live…" busy>
        <div className="flex h-24 items-center justify-center text-sm text-[#8B949E]">Checking…</div>
      </OnboardingPanel>
    );
  }

  if (phase === 'error') {
    return (
      <OnboardingPanel title={`Point at ${collector.name}`} subtitle="That run didn't go through.">
        <div className="flex flex-col gap-4">
          <p role="alert" className="text-sm text-[var(--color-verdict-shape)]">
            {error}
          </p>
          <button
            type="button"
            onClick={() => setPhase('inputs')}
            className="flex h-10 items-center justify-center rounded-sm border border-[var(--color-line)] text-sm font-medium text-[#EDEDED]"
          >
            Try again
          </button>
        </div>
      </OnboardingPanel>
    );
  }

  // ready
  return (
    <OnboardingPanel
      title="What does a good row look like?"
      subtitle={`We ran ${collector.name} once. Here's what came back. (${position.index + 1} of ${position.total})`}
    >
      <div className="flex flex-col gap-5">
        <ClipboardText size={16} weight="regular" className="text-[#8B949E]" aria-hidden />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="schema-confirm-table">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-[#8B949E]">
                <th className="pb-2 pr-3 font-medium">Field</th>
                <th className="pb-2 pr-3 font-medium">Observed</th>
                <th className="pb-2 pr-3 font-medium">Sample</th>
                <th className="pb-2 font-medium">Required?</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={f.name} className="border-t border-[var(--color-line)]">
                  <td className="py-2 pr-3 font-mono text-[#EDEDED]">{f.name}</td>
                  <td className="py-2 pr-3 text-[#9B9B9B]">
                    {f.everFilled ? 'Always filled' : (
                      <span className="flex items-center gap-1">
                        <WarningCircle size={12} weight="regular" aria-hidden />
                        Sometimes empty
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 truncate font-mono text-[#9B9B9B]">{String(f.sample ?? '—')}</td>
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={() =>
                        setFields((prev) => prev.map((row, idx) => (idx === i ? { ...row, required: !row.required } : row)))
                      }
                      className="accent-[#EDEDED]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="entity-key-select" className="text-sm font-medium text-[#EDEDED]">
            Which field identifies the thing you asked for?
          </label>
          <select
            id="entity-key-select"
            value={entityKey ?? ''}
            onChange={(e) => setEntityKey(e.target.value || null)}
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm text-[#EDEDED] outline-none focus-visible:border-[#EDEDED]"
          >
            <option value="">Don&rsquo;t check identity for this collector</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          {entityKey && <p className="text-xs text-[#8B949E]">This is what catches the wrong-product failure.</p>}
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-verdict-shape)]">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={saving}
          onClick={handleConfirm}
          className="flex h-10 items-center justify-center rounded-sm bg-[#EDEDED] text-sm font-medium text-[#131209] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Looks right — start watching'}
        </button>
      </div>
    </OnboardingPanel>
  );
}
