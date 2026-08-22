/** Step 3 — "Confirm what good looks like" (§0.5, §6). REQUIRED: without it a collector
 * is NOT VERIFIED forever. A zero-row probe skips rather than faking a table. */
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

/** Radix `Select.Item` forbids an empty-string `value`, so "no entity key" needs a
 * sentinel; it becomes `null` again the moment it leaves this component. */
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

/** Renders nothing when there is no error, so callers need no `&&` guard. */
function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function SchemaConfirmStep({ collector, position, onConfirmed, onSkippedEmpty }: SchemaConfirmStepProps) {
  const pointAtTitle = `Point at ${collector.name}`;
  const [phase, setPhase] = useState<Phase>('inputs');
  const [canaryRaw, setCanaryRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [entityKey, setEntityKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A phase swaps the whole panel but is one screen to the wizard, so its focus
  // move never fires — without this, focus is left on a button that no longer exists.
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
      // ux-spec.md §6 wants the highest-cardinality short string field; one probe
      // run gives no cardinality, so an id/sku/key-shaped name is the stand-in.
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
        title={pointAtTitle}
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
          <ErrorAlert message={error} />
          <Button type="button" disabled={canaryInputs.length === 0} onClick={runProbe} className="h-10 w-full">
            Run it once
          </Button>
        </div>
      </OnboardingPanel>
    );
  }

  if (phase === 'running') {
    return (
      <OnboardingPanel bare title={pointAtTitle} subtitle="Running it once, live…" busy>
        <div className="flex h-24 items-center justify-center text-sm text-[#8B949E]">Checking…</div>
      </OnboardingPanel>
    );
  }

  if (phase === 'error') {
    return (
      <OnboardingPanel bare title={pointAtTitle} subtitle="That run didn't go through.">
        <div className="flex flex-col gap-4">
          <ErrorAlert message={error} />
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
        {/* `table-fixed` + explicit widths are load-bearing: auto layout ran 110px wide
          * and pushed REQUIRED?, the only control here, into a scrollbar-less overflow. */}
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
                      // A Radix checkbox is a `<button role="checkbox">`, so the column
                      // header never names it — without this it is an unlabelled toggle.
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

        <ErrorAlert message={error} />

        <Button type="button" disabled={saving} onClick={handleConfirm} className="h-10 w-full">
          {saving ? 'Saving…' : 'Looks right — start watching'}
        </Button>
      </div>
    </OnboardingPanel>
  );
}
