// The three-region shell (§5.2), only region interiors scroll. Cards never resize to
// fill space, so the SHELL changes shape: hero (n<=1), docked (2-3), overlay (n>=4).
import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CircleNotch, Plus, SignOut, X } from '@phosphor-icons/react';
import Counter from '@/components/Counter';
import { FleetColumn } from './FleetColumn';
import { VerdictCard } from './VerdictCard';
import { Headline } from './Headline';
import { EvidencePanel } from '@/components/evidence/EvidencePanel';
import { LedgerStream, type LedgerRow } from '@/components/ledger/LedgerStream';
import { layoutFor, resolveFocusSelection, pinFocus, AUTO_FOCUS, type FocusSelection } from '@/lib/density';
import { EASE_FLUID } from '@/lib/motion';
import type { CollectorState, FleetState } from '@/lib/api';

export interface FleetShellProps {
  fleet: FleetState;
  ledgerRows: LedgerRow[];
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
  onAddCollector?: (collectorId: string) => Promise<void>;
  onSignOut?: () => void;
  signingOut?: boolean;
  signOutError?: string | null;
}

export function FleetShell({
  fleet,
  ledgerRows,
  onRepair,
  onAcknowledge,
  onAddCollector,
  onSignOut,
  signingOut = false,
  signOutError = null,
}: FleetShellProps) {
  const collectors = fleet.collectors;
  const layout = layoutFor(collectors.length);

  // Resolved every render against the current fleet, not captured at mount, so a
  // collector that starts lying pulls the panel with it. Judgement: `resolveFocusSelection`.
  const [selection, setSelection] = useState<FocusSelection>(AUTO_FOCUS);
  const focus = useMemo(() => resolveFocusSelection(selection, collectors), [selection, collectors]);
  const selectedId = focus.id;
  const selected = collectors.find((c) => c.id === selectedId) ?? null;
  const selectCollector = (id: string) => setSelection(pinFocus(id, collectors));
  const [addingCollector, setAddingCollector] = useState(false);

  const shellMode: 'hero' | 'docked' | 'overlay' =
    layout.kind === 'hero' ? 'hero' : layout.kind === 'single-column' ? 'docked' : 'overlay';
  const gridCols = shellMode === 'docked' ? '280px 1fr 360px' : '1fr 360px';

  return (
    <div className="flex h-[calc(100svh-var(--poly-chrome-offset,0px))] flex-col bg-black/65 font-sans text-[#EDEDED] backdrop-blur-[2px]">
      <ShellHeader
        fleet={fleet}
        ledgerRows={ledgerRows}
        onAddCollector={onAddCollector ? () => setAddingCollector(true) : undefined}
        onSignOut={onSignOut}
        signingOut={signingOut}
        signOutError={signOutError}
      />

      <div
        data-testid="fleet-shell-grid"
        data-shell-mode={shellMode}
        className="grid min-h-0 flex-1 gap-4 overflow-x-hidden p-4"
        style={{ gridTemplateColumns: gridCols }}
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto" data-testid="fleet-region">
          <Headline collectors={collectors} lastSweepTs={fleet.ts} />

          {collectors.length === 0 ? (
            <EmptyFleet />
          ) : shellMode === 'hero' ? (
            <>
              <VerdictCard
                collector={collectors[0]}
                density="hero"
                selected
                onSelect={selectCollector}
                onRepair={onRepair}
                onAcknowledge={onAcknowledge}
              />
              <EvidencePanel collector={collectors[0]} />
            </>
          ) : (
            <FleetColumn
              collectors={collectors}
              selectedId={selectedId}
              onSelect={selectCollector}
              onRepair={onRepair}
              onAcknowledge={onAcknowledge}
            />
          )}
        </div>

        {shellMode === 'docked' && (
          <div className="min-h-0 min-w-0" data-testid="focus-region">
            <EvidencePanel collector={selected} />
          </div>
        )}

        <div className="min-h-0 min-w-0" data-testid="ledger-region">
          <LedgerStream rows={ledgerRows} />
        </div>
      </div>

      {shellMode === 'overlay' && selectedId != null && (
        <FocusOverlay collector={selected} onClose={() => setSelection({ id: null, source: 'user' })} />
      )}
      {addingCollector && onAddCollector && (
        <AddCollectorDialog onClose={() => setAddingCollector(false)} onAddCollector={onAddCollector} />
      )}
    </div>
  );
}

function ShellHeader({
  fleet,
  ledgerRows,
  onAddCollector,
  onSignOut,
  signingOut,
  signOutError,
}: {
  fleet: FleetState;
  ledgerRows: LedgerRow[];
  onAddCollector?: () => void;
  onSignOut?: () => void;
  signingOut: boolean;
  signOutError: string | null;
}) {
  // The latest event's own id, not `ledgerRows.length`: rows are capped to the
  // fetch window, so a length would plateau while ids keep climbing honestly.
  const latestLedgerId = ledgerRows.length > 0 ? ledgerRows[ledgerRows.length - 1].id : 0;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-[#272727] px-4">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9B9B9B]">Collector fleet</span>
      <span className="font-mono text-xs text-[#9B9B9B]">{fleet.tenant}</span>
      {/* An odometer only rolls upward — the one numeric shape that states the ledger's
          append-only invariant. `gradientHeight={0}` drops its fade mask, which B4 forbids. */}
      <span className="flex items-center gap-1.5 font-mono text-xs text-[#9B9B9B]">
        <span className="uppercase tracking-wide">Ledger</span>
        <Counter
          value={latestLedgerId}
          fontSize={12}
          gap={2}
          horizontalPadding={4}
          borderRadius={4}
          gradientHeight={0}
          textColor="#EDEDED"
          fontWeight={500}
          containerStyle={{ fontFamily: 'var(--font-mono)' }}
        />
      </span>
      <span className="ml-auto font-mono text-xs tabular-nums text-[#9B9B9B]">
        {fleet.governor.heal_enabled
          ? `recovery ${fleet.governor.totalAttemptsToday}/${fleet.governor.daily_heal_budget}`
          : 'Recovery policy: protected'}
      </span>
      <span className="font-mono text-xs tabular-nums text-[#9B9B9B]">
        {fleet.ts ? new Date(fleet.ts).toLocaleTimeString() : '—'}
      </span>
      {onAddCollector && (
        <button
          type="button"
          onClick={onAddCollector}
          className="flex h-10 items-center gap-1.5 rounded-lg border border-[#49405d] bg-[#171220] px-3 text-sm font-medium text-[#EDEDED] transition-[background-color,border-color,transform] hover:border-[#8b5cf6] hover:bg-[#211832] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          <Plus size={16} weight="bold" aria-hidden />
          Add collector
        </button>
      )}
      {onSignOut && (
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-70"
        >
          {signingOut ? <CircleNotch size={16} className="animate-spin" aria-hidden /> : <SignOut size={16} aria-hidden />}
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      )}
      {signOutError && <span role="alert" className="text-xs text-red-200">{signOutError}</span>}
    </header>
  );
}

function AddCollectorDialog({
  onClose,
  onAddCollector,
}: {
  onClose: () => void;
  onAddCollector: (collectorId: string) => Promise<void>;
}) {
  const [collectorId, setCollectorId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = collectorId.trim();
    if (!id || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAddCollector(id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Collector could not be connected.');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-collector-title"
        className="flex w-full max-w-lg flex-col gap-5 rounded-2xl border border-[#38333f] bg-[var(--color-sunken)] p-6 shadow-[var(--shadow-e3)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a78bfa]">Collector fleet</p>
            <h2 id="add-collector-title" className="text-balance text-xl font-semibold text-[#EDEDED]">Add a collector</h2>
            <p className="text-sm leading-6 text-[#9B9B9B]">Paste the ID of a published Bright Data collector. Its existing schedule stays in Bright Data.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close add collector"
            className="grid size-10 shrink-0 place-items-center rounded-lg text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <label className="flex flex-col gap-2 text-sm font-medium text-[#EDEDED]" htmlFor="collector-id">
            Bright Data collector ID
            <input
              id="collector-id"
              autoFocus
              value={collectorId}
              onChange={(event) => setCollectorId(event.target.value)}
              placeholder="c_your_collector_id"
              className="h-11 rounded-lg border border-[#38333f] bg-black/30 px-3 font-mono text-sm text-[#EDEDED] outline-none transition-[border-color,box-shadow] placeholder:text-[#69656d] focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/30"
            />
          </label>
          {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-950/20 px-3 py-2 text-sm text-red-200">{error}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-lg px-3 text-sm text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]">Cancel</button>
            <button type="submit" disabled={!collectorId.trim() || submitting} className="flex h-10 items-center gap-2 rounded-lg bg-[#EDEDED] px-4 text-sm font-medium text-[#131209] transition-[background-color,transform] hover:bg-white active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-not-allowed disabled:bg-[#403e40] disabled:text-[#9B9B9B]">
              {submitting && <CircleNotch size={16} className="animate-spin" aria-hidden />}
              {submitting ? 'Adding collector…' : 'Add collector'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** E2 "zero collectors" (§2): composed, never blank — a sentence plus the two ways out.
 *  Both destinations are real routes in `App.tsx`, so neither promises a missing surface. */
function EmptyFleet() {
  return (
    <div
      data-testid="empty-fleet"
      className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-[#272727] bg-[var(--color-surface)] p-8 text-center"
    >
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-[#EDEDED]">No collectors connected yet.</p>
        <p className="text-sm text-[#9B9B9B]">Polygraph has nothing to watch.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          href="/signup"
          data-testid="empty-fleet-connect"
          className="rounded-lg border border-[#313131] bg-[var(--color-raised)] px-3 py-2 text-sm font-medium text-[#EDEDED] shadow-[var(--shadow-e2)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          Connect collectors
        </a>
        <a
          href="/#sandbox"
          data-testid="empty-fleet-sandbox"
          className="rounded-lg border border-[#272727] px-3 py-2 text-sm text-[#9B9B9B] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          Open the sandbox instead
        </a>
      </div>
    </div>
  );
}

/** §5.3's slide-in sheet, n>=4 only. The border goes all the way around: three edges sit
 *  flush against the viewport anyway, so the no-single-sided-border rule stays absolute. */
function FocusOverlay({ collector, onClose }: { collector: CollectorState | null; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      role="dialog"
      aria-label="Collector evidence"
      data-testid="focus-overlay"
      className="fixed inset-y-0 right-0 z-20 flex w-[420px] max-w-full flex-col gap-3 border border-[#272727] bg-[var(--color-sunken)] p-4 shadow-[var(--shadow-e3)]"
      initial={reduceMotion ? false : { x: '100%' }}
      animate={{ x: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.42, ease: EASE_FLUID }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close evidence panel"
        className="flex w-fit items-center gap-1 font-mono text-xs text-[#9B9B9B] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
      >
        <X size={12} weight="regular" aria-hidden />
        Close
      </button>
      <div className="min-h-0 flex-1">
        <EvidencePanel collector={collector} />
      </div>
    </motion.div>
  );
}
