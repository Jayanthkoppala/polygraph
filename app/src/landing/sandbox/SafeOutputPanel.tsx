import { relativeAge } from '@/lib/time';
import type { CollectorState } from '@/lib/api';
import type { SandboxMode, SandboxSafeOutputSnapshot } from './engine';

export function SafeOutputPanel({
  snapshot,
  mode,
  target,
}: {
  snapshot: SandboxSafeOutputSnapshot;
  mode: SandboxMode;
  target: CollectorState | undefined;
}) {
  const isWrongTarget = mode === 'wrong_entity';
  const isHealthy = mode === 'healthy';
  const hasAdvanced = isHealthy && snapshot.releaseEventId > 1;
  const contractBaseline = mode === 'price_dead' ? 'FAIL' : 'PASS';

  return (
    <section
      data-testid="safe-output-panel"
      aria-label="Safe output browser demonstration"
      className="relative mt-3 rounded-xl border border-[#272727] bg-[#181818] p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[#EDEDED]">Safe output</p>
          <p className="text-xs text-[#9B9B9B]">Browser demo state — not hosted execution</p>
        </div>
        <span className="font-mono text-xs text-[#9B9B9B]">HTTP 200 · Contract baseline: {contractBaseline}</span>
      </div>

      {isWrongTarget ? (
        <p className="mt-2 text-sm font-medium text-[var(--color-verdict-target)]">
          Wrong target · Repair refused · Current run quarantined
        </p>
      ) : isHealthy ? (
        <p className="mt-2 text-sm font-medium text-[var(--color-verdict-pass)]">
          {hasAdvanced ? 'Healthy run released · Snapshot advanced' : 'Serving last verified demo snapshot'}
        </p>
      ) : (
        <p className="mt-2 text-sm font-medium text-[var(--color-verdict-shape)]">
          Current run held for repair · Safe snapshot unchanged
        </p>
      )}

      <div className="mt-2 grid grid-cols-1 gap-1 font-mono text-xs text-[#9B9B9B] sm:grid-cols-3">
        <span>{snapshot.rowCount} rows</span>
        <span>released {relativeAge(snapshot.releasedAt)}</span>
        <span title={snapshot.outputHash}>hash {snapshot.outputHash.slice(0, 12)}…</span>
      </div>

      {(!isHealthy || !hasAdvanced) && (
        <p className="mt-2 text-xs text-[#EDEDED]">Serving last verified demo snapshot · Snapshot unchanged</p>
      )}
      {isWrongTarget && target && (
        <p className="mt-1 text-xs text-[#9B9B9B]">The response has all required fields, but it is not {target.id}'s requested product.</p>
      )}
    </section>
  );
}
