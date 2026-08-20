/**
 * FleetShell — the three-region app shell (ui-system.md §5.2): FLEET 280px
 * / FOCUS 1fr / LEDGER 360px, header and footer fixed, only region
 * interiors scroll. Cards never resize to fill space (§5.4 rule 2) — the
 * shell itself changes shape instead, in three modes driven by
 * `layoutFor()`:
 *
 *   hero    (n<=1)   FLEET+FOCUS collapse into one column: the single
 *                    card plus its evidence inline, per §5.3's "zero
 *                    empty regions" rule. LEDGER stays.
 *   docked  (n=2-3)  the real three-column grid as drawn in §5.2.
 *   overlay (n>=4)   FLEET takes the FOCUS column's width so the fleet
 *                    grid/rows have room; FOCUS becomes a slide-in panel
 *                    (§5.3: "FOCUS becomes a sheet that slides in from
 *                    the right") instead of a permanent column.
 */
import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { X } from '@phosphor-icons/react';
import Counter from '@/components/Counter';
import { FleetColumn } from './FleetColumn';
import { VerdictCard } from './VerdictCard';
import { Headline } from './Headline';
import { EvidencePanel } from '@/components/evidence/EvidencePanel';
import { LedgerStream, type LedgerRow } from '@/components/ledger/LedgerStream';
import { layoutFor, sortBySeverityThenRecency } from '@/lib/density';
import { EASE_FLUID } from '@/lib/motion';
import type { CollectorState, FleetState } from '@/lib/api';

export interface FleetShellProps {
  fleet: FleetState;
  ledgerRows: LedgerRow[];
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
}

export function FleetShell({ fleet, ledgerRows, onRepair, onAcknowledge }: FleetShellProps) {
  const collectors = fleet.collectors;
  const layout = layoutFor(collectors.length);
  const sorted = useMemo(() => sortBySeverityThenRecency(collectors), [collectors]);
  const [selectedId, setSelectedId] = useState<string | null>(sorted[0]?.id ?? null);
  const selected = collectors.find((c) => c.id === selectedId) ?? null;

  const shellMode: 'hero' | 'docked' | 'overlay' =
    layout.kind === 'hero' ? 'hero' : layout.kind === 'single-column' ? 'docked' : 'overlay';
  const gridCols = shellMode === 'docked' ? '280px 1fr 360px' : '1fr 360px';

  return (
    <div className="flex h-screen flex-col bg-[var(--color-void)] font-sans text-[#EDEDED]">
      <ShellHeader fleet={fleet} ledgerRows={ledgerRows} />

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
                onSelect={setSelectedId}
                onRepair={onRepair}
                onAcknowledge={onAcknowledge}
              />
              <EvidencePanel collector={collectors[0]} />
            </>
          ) : (
            <FleetColumn
              collectors={collectors}
              selectedId={selectedId}
              onSelect={setSelectedId}
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
        <FocusOverlay collector={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function ShellHeader({ fleet, ledgerRows }: { fleet: FleetState; ledgerRows: LedgerRow[] }) {
  // The most recent event's own id, not `ledgerRows.length` — rows are
  // capped to the last `fetchLedger(n)` window (FleetApp.tsx polls 100), so
  // an array length plateaus once the ledger outgrows that window instead
  // of continuing to climb. Ledger ids are assigned in append order, so the
  // highest one seen is the honest "how far has the chain gotten" figure —
  // never fabricated, never a total we can't actually compute client-side.
  const latestLedgerId = ledgerRows.length > 0 ? ledgerRows[ledgerRows.length - 1].id : 0;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-[#272727] px-4">
      <span className="text-sm font-semibold tracking-wide">POLYGRAPH</span>
      <span className="font-mono text-xs text-[#9B9B9B]">{fleet.tenant}</span>
      {/* ui-system.md §3.2/§3.8: ReactBits `Counter` — an odometer can only
          roll upward, which is the one numeric display shape that states
          the ledger's own append-only invariant. `gradientHeight={0}`
          disables the component's default top/bottom fade mask (a
          background gradient, which B4 forbids on a surface); the digit
          reel is short enough here that the fade served no purpose anyway. */}
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
          ? `heal ${fleet.governor.totalAttemptsToday}/${fleet.governor.daily_heal_budget}`
          : 'Repairs: OFF'}
      </span>
      <span className="font-mono text-xs tabular-nums text-[#6E7681]">
        {fleet.ts ? new Date(fleet.ts).toLocaleTimeString() : '—'}
      </span>
    </header>
  );
}

function EmptyFleet() {
  return (
    <div
      data-testid="empty-fleet"
      className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#272727] p-8 text-center"
    >
      <p className="text-sm text-[#9B9B9B]">No collectors connected yet. Polygraph has nothing to watch.</p>
    </div>
  );
}

/** §5.3's "sheet that slides in from the right", n>=4 only — FLEET keeps
 * the whole main width for its grid/rows, FOCUS becomes an overlay rather
 * than a permanent column. */
function FocusOverlay({ collector, onClose }: { collector: CollectorState | null; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      role="dialog"
      aria-label="Collector evidence"
      data-testid="focus-overlay"
      className="fixed inset-y-0 right-0 z-20 flex w-[420px] max-w-full flex-col gap-3 border-l border-[#272727] bg-[var(--color-sunken)] p-4 shadow-[var(--shadow-e3)]"
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
