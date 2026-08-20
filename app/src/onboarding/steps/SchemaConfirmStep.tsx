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
import { useEffect, useRef, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

/** Radix `Select.Item` forbids an empty-string `value` — this sentinel
 * stands in for "no entity key chosen" and is translated back to `null`
 * at the one point it leaves this component (`handleConfirm`). */
const NO_ENTITY_KEY = '__none__';

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

  // Each phase of this step swaps the whole panel — heading, body and
  // action — but it is one screen to the wizard, so `OnboardingWizard`'s
  // step-change focus move never fires here. Without this, finishing a
  // probe silently replaces everything under a keyboard user's feet with
  // focus still on a button that no longer exists.
  const previousPhase = useRef<Phase>(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    document.querySelector<HTMLElement>('[data-onboarding-heading]')?.focus();
  }, [phase]);

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
        bare
        title={`Point at ${collector.name}`}
        subtitle={`Collector ${position.index + 1} of ${position.total}. What input(s) trigger a run?`}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="canary-inputs">Trigger input(s), one per line</Label>
            <Textarea
              id="canary-inputs"
              data-testid="canary-inputs"
              rows={4}
              value={canaryRaw}
              onChange={(e) => setCanaryRaw(e.target.value)}
              placeholder={'SKU-4471\nSKU-4482'}
            />
          </div>
          <p className="text-xs text-[#8B949E]">Up to 5. We&rsquo;ll run one of these live, once, to see what comes back.</p>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="button" disabled={canaryInputs.length === 0} onClick={runProbe} className="h-10 w-full">
            Run it once
          </Button>
        </div>
      </OnboardingPanel>
    );
  }

  if (phase === 'running') {
    return (
      <OnboardingPanel bare title={`Point at ${collector.name}`} subtitle="Running it once, live…" busy>
        <div className="flex h-24 items-center justify-center text-sm text-[#8B949E]">Checking…</div>
      </OnboardingPanel>
    );
  }

  if (phase === 'error') {
    return (
      <OnboardingPanel bare title={`Point at ${collector.name}`} subtitle="That run didn't go through.">
        <div className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button type="button" variant="outline" onClick={() => setPhase('inputs')} className="h-10 w-full">
            Try again
          </Button>
        </div>
      </OnboardingPanel>
    );
  }

  // ready
  return (
    <OnboardingPanel
      bare
      title="What does a good row look like?"
      subtitle={`We ran ${collector.name} once. Here's what came back. (${position.index + 1} of ${position.total})`}
    >
      <div className="flex flex-col gap-5">
        {/* `table-fixed` plus explicit column widths, because the default
          * auto layout blew the table 110px wider than its own card at every
          * viewport (measured in Chrome at 1512x805 and 1280x700) and pushed
          * the REQUIRED? column — the only interactive thing on this screen,
          * and the entire point of ux-spec.md §6's "Confirm what good looks
          * like" — off the right edge into a horizontal scroll with no
          * visible scrollbar. Same defect class as the clipped Connect
          * button: a control that exists, reports visible, and cannot be
          * seen or reached. The sample column truncates instead. */}
        <div className="overflow-x-auto rounded-sm border border-[var(--color-line)]">
          <Table data-testid="schema-confirm-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26%]">Field</TableHead>
                <TableHead className="w-[28%] whitespace-normal">Observed</TableHead>
                <TableHead className="w-[26%]">Sample</TableHead>
                <TableHead className="w-[20%] whitespace-normal">Required?</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((f, i) => (
                <TableRow key={f.name}>
                  <TableCell className="truncate font-mono">{f.name}</TableCell>
                  <TableCell className="whitespace-normal text-[#9B9B9B]">
                    {f.everFilled ? (
                      'Always filled'
                    ) : (
                      <span className="flex items-center gap-1">
                        <WarningCircle size={12} weight="regular" aria-hidden />
                        Sometimes empty
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="truncate font-mono text-[#9B9B9B]" title={String(f.sample ?? '—')}>
                    {String(f.sample ?? '—')}
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      // Column headers do not name a Radix checkbox (it is a
                      // `<button role="checkbox">`, not a form control), so
                      // without this the whole table is a column of
                      // identical unlabelled toggles to a screen reader.
                      aria-label={`Require ${f.name}`}
                      checked={f.required}
                      onCheckedChange={() =>
                        setFields((prev) => prev.map((row, idx) => (idx === i ? { ...row, required: !row.required } : row)))
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entity-key-select">Which field identifies the thing you asked for?</Label>
          <Select value={entityKey ?? NO_ENTITY_KEY} onValueChange={(v) => setEntityKey(v === NO_ENTITY_KEY ? null : v)}>
            <SelectTrigger id="entity-key-select" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ENTITY_KEY}>Don&rsquo;t check identity for this collector</SelectItem>
              {fields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {entityKey && <p className="text-xs text-[#8B949E]">This is what catches the wrong-product failure.</p>}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button type="button" disabled={saving} onClick={handleConfirm} className="h-10 w-full">
          {saving ? 'Saving…' : 'Looks right — start watching'}
        </Button>
      </div>
    </OnboardingPanel>
  );
}
