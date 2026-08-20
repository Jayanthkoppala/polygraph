/**
 * FleetColumn — the collector list itself, density-driven per
 * ui-system.md §5.3. The card never resizes to fill space; the container
 * changes what it holds:
 *
 *   n<=1    hero card (handled by the caller — FleetShell renders it inline)
 *   n=2-3   single column, card density
 *   n=4-12  grid-cols-3, card density
 *   n=13-40 row density, grid-cols-2, virtualized past 24 rows
 *   n>40    row density, grid-cols-1, virtualized, sticky group headers,
 *           VERIFIED collapsed by default
 *
 * At n<=12, only VERIFIED collapses into the quiet `HealthyRow` — every
 * other state gets a full card, capped at `MAX_ATTENTION_CARDS` with a
 * "+N more needing attention" note (ux-spec.md §4). At n>40 the same
 * VERIFIED-collapses-by-default rule is expressed as a group that starts
 * closed instead (ui-system.md §5.3).
 */
import { useMemo, useState } from 'react';
import { VerdictCard } from './VerdictCard';
import { HealthyRow } from './HealthyRow';
import { useRovingTabIndex } from '@/hooks/useRovingTabIndex';
import { VERDICT, toVerdictState, type VerdictState } from '@/lib/verdict';
import { layoutFor, sortBySeverityThenRecency, partitionByAttention, MAX_ATTENTION_CARDS } from '@/lib/density';
import { computeVirtualWindow } from '@/lib/virtualize';
import type { CollectorState } from '@/lib/api';

export interface FleetColumnProps {
  collectors: CollectorState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** Test-only escape hatch: the real viewport is measured from the DOM,
   * which jsdom always reports as 0. Defaults to a realistic in-app value. */
  viewportHeight?: number;
}

const ROW_HEIGHT = 56; // row-density card height (h-14)

export function FleetColumn({
  collectors,
  selectedId,
  onSelect,
  onRepair,
  onAcknowledge,
  viewportHeight = 640,
}: FleetColumnProps) {
  const layout = layoutFor(collectors.length);
  const sorted = useMemo(() => sortBySeverityThenRecency(collectors), [collectors]);
  // Called unconditionally, before the early return below, so this
  // component's own hook count never changes between renders — the ref it
  // returns is only ever attached in the non-virtualized branch's JSX; when
  // that branch doesn't render, the hook's effect just finds `current ===
  // null` and no-ops (see the hook's own early return).
  const listRef = useRovingTabIndex<HTMLDivElement>();

  if (layout.kind === 'row-grid-2' || layout.kind === 'row-grid-1-grouped') {
    return (
      <VirtualizedRows
        collectors={sorted}
        grouped={layout.grouped}
        gridCols={layout.kind === 'row-grid-2' ? 2 : 1}
        virtualize={layout.virtualize}
        viewportHeight={viewportHeight}
        selectedId={selectedId}
        onSelect={onSelect}
        onRepair={onRepair}
        onAcknowledge={onAcknowledge}
      />
    );
  }

  // hero / single-column / grid-3 — card density, healthy collapses.
  const { attention, healthy } = partitionByAttention(sorted);
  const visible = layout.kind === 'hero' ? attention : attention.slice(0, MAX_ATTENTION_CARDS);
  const overflow = attention.length - visible.length;
  const gridClass =
    layout.kind === 'hero'
      ? 'flex flex-col gap-2'
      : layout.kind === 'single-column'
        ? 'flex flex-col gap-2'
        : 'grid grid-cols-3 gap-2';

  return (
    <div className="flex flex-col gap-3">
      <div ref={listRef} className={gridClass} role="list" aria-label="Collectors needing attention">
        {visible.map((c) => (
          <VerdictCard
            key={c.id}
            collector={c}
            density={layout.density}
            selected={c.id === selectedId}
            onSelect={onSelect}
            onRepair={onRepair}
            onAcknowledge={onAcknowledge}
          />
        ))}
      </div>
      {overflow > 0 && (
        <div className="font-mono text-xs text-[#9B9B9B]" data-testid="attention-overflow">
          +{overflow} more needing attention
        </div>
      )}
      <HealthyRow collectors={healthy} />
    </div>
  );
}

type RowItem =
  | { kind: 'row'; collector: CollectorState }
  | { kind: 'group'; state: VerdictState; count: number; expanded: boolean };

/** Severity-first group order, matching `sortBySeverityThenRecency`'s own
 * ranking (ui-system.md §5.3's "sorted worst first"). */
const GROUP_ORDER: VerdictState[] = ['WRONG_TARGET', 'WRONG_SHAPE', 'UNEXPLAINED', 'NOT_CHECKED', 'VERIFIED'];

function buildRowItems(collectors: CollectorState[], grouped: boolean, verifiedExpanded: boolean): RowItem[] {
  if (!grouped) return collectors.map((c) => ({ kind: 'row', collector: c }));

  const items: RowItem[] = [];
  for (const state of GROUP_ORDER) {
    const group = collectors.filter((c) => toVerdictState(c) === state);
    if (group.length === 0) continue;
    // "VERIFIED collapses by default at n > 40" (ui-system.md §5.3) — every
    // other group starts open; the healthy group starts closed.
    const expanded = state === 'VERIFIED' ? verifiedExpanded : true;
    items.push({ kind: 'group', state, count: group.length, expanded });
    if (expanded) {
      for (const c of group) items.push({ kind: 'row', collector: c });
    }
  }
  return items;
}

function VirtualizedRows({
  collectors,
  grouped,
  gridCols,
  virtualize,
  viewportHeight,
  selectedId,
  onSelect,
  onRepair,
  onAcknowledge,
}: {
  collectors: CollectorState[];
  grouped: boolean;
  gridCols: 1 | 2;
  virtualize: boolean;
  viewportHeight: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRepair: (id: string) => void;
  onAcknowledge: (id: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  // VERIFIED starts collapsed (ui-system.md §5.3) — a healthy fleet at
  // scale is noise; the group header's own count is the fact anyone needs.
  const [verifiedExpanded, setVerifiedExpanded] = useState(false);

  const items = useMemo(
    () => buildRowItems(collectors, grouped, verifiedExpanded),
    [collectors, grouped, verifiedExpanded],
  );

  const win = virtualize
    ? computeVirtualWindow({ total: items.length, rowHeight: ROW_HEIGHT, viewportHeight, scrollTop })
    : { startIndex: 0, endIndex: items.length, topPad: 0, bottomPad: 0 };

  const visibleItems = items.slice(win.startIndex, win.endIndex);
  const spanFull = gridCols === 2 ? { gridColumn: '1 / -1' } : undefined;
  const listRef = useRovingTabIndex<HTMLDivElement>();

  return (
    <div
      ref={listRef}
      role="list"
      aria-label="Fleet"
      data-testid="fleet-virtual-scroll"
      className={gridCols === 2 ? 'grid h-full auto-rows-min grid-cols-2 content-start gap-2 overflow-y-auto' : 'flex h-full flex-col overflow-y-auto'}
      style={{ maxHeight: viewportHeight }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      {win.topPad > 0 && <div aria-hidden style={{ height: win.topPad, ...spanFull }} />}
      {visibleItems.map((item) =>
        item.kind === 'group' ? (
          <GroupHeader
            key={`group-${item.state}`}
            state={item.state}
            count={item.count}
            expanded={item.expanded}
            onToggle={item.state === 'VERIFIED' ? () => setVerifiedExpanded((v) => !v) : undefined}
            spanFull={gridCols === 2}
          />
        ) : (
          <VerdictCard
            key={item.collector.id}
            collector={item.collector}
            density="row"
            selected={item.collector.id === selectedId}
            onSelect={onSelect}
            onRepair={onRepair}
            onAcknowledge={onAcknowledge}
          />
        ),
      )}
      {win.bottomPad > 0 && <div aria-hidden style={{ height: win.bottomPad, ...spanFull }} />}
    </div>
  );
}

function GroupHeader({
  state,
  count,
  expanded,
  onToggle,
  spanFull,
}: {
  state: VerdictState;
  count: number;
  expanded: boolean;
  onToggle?: () => void;
  spanFull: boolean;
}) {
  const meta = VERDICT[state];
  return (
    <div style={spanFull ? { gridColumn: '1 / -1' } : undefined}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        aria-expanded={onToggle ? expanded : undefined}
        data-testid="fleet-group-header"
        data-group-state={state}
        className="sticky top-0 z-10 flex w-full items-center justify-between gap-2 bg-[var(--color-sunken)] px-3 py-2 text-left text-xs font-medium uppercase tracking-wide outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-default"
        style={{ color: meta.color }}
      >
        <span>{meta.label}</span>
        <span className="font-mono tabular-nums text-[#9B9B9B]">{count}</span>
      </button>
    </div>
  );
}
