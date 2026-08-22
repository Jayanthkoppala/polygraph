import type { Evidence } from '../../core/types.js';

/** A same-night summary for one same-purpose collector, as fed to checkPeers. */
export interface PeerSummary {
  collector: string;
  rowsCount: number;
  meanFillRate: number;
}

export interface PeerMetrics extends Record<string, unknown> {
  collector: string;
  rowsCount: number;
  meanFillRate: number;
  medianFillRate: number;
  mad: number;
  deviation: number;
  madMultiple: number;
  /** Always true: this check is a confidence signal, never a hard gate — the
   * policy engine must never derive a cause/action from this evidence alone. */
  advisory: true;
}

/** Peer corroboration needs a real peer set to be meaningful — fewer than 3
 * same-purpose collectors and a median/MAD would just chase noise. */
const MIN_PEERS = 3;
const FLAG_MAD_MULTIPLE = 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compares a collector's fill-rate against its same-purpose peers'
 * (same-night summaries), flagging any collector whose fill-rate sits >= 3
 * median-absolute-deviations below the peer median.
 *
 * This is purely a confidence signal: it never gates release/quarantine by
 * itself — every returned Evidence carries `metrics.advisory: true` so the
 * policy engine can pass it through the verdict trail for context without
 * ever deriving a cause from it alone (an entire fleet running at 60% fill
 * on a genuinely broken source site would otherwise get quarantined by peer
 * comparison against ITSELF).
 *
 * Returns one Evidence per input collector, `ok: false` only for flagged
 * ones. When fewer than 3 peers are reporting, returns a single advisory
 * "insufficient peers" Evidence instead of computing a meaningless MAD.
 */
export function checkPeers(summaries: PeerSummary[]): Evidence[] {
  if (summaries.length < MIN_PEERS) {
    return [
      {
        check: 'peer',
        ok: true,
        detail: `only ${summaries.length} same-purpose collector(s) reporting tonight — need >= ${MIN_PEERS} for peer corroboration`,
        metrics: { advisory: true, insufficientPeers: true, peerCount: summaries.length },
      },
    ];
  }

  const fillRates = summaries.map((s) => s.meanFillRate);
  const med = median(fillRates);
  const mad = median(fillRates.map((v) => Math.abs(v - med)));

  return summaries.map((s): Evidence => {
    const deviation = med - s.meanFillRate;
    const madMultiple = mad === 0 ? (deviation > 0 ? Infinity : 0) : deviation / mad;
    const flagged = deviation > 0 && madMultiple >= FLAG_MAD_MULTIPLE;

    const detail = flagged
      ? `${s.collector} fill-rate ${s.meanFillRate.toFixed(3)} is ${
          madMultiple === Infinity ? 'many' : madMultiple.toFixed(1)
        } MAD below the peer median ${med.toFixed(3)} — advisory only`
      : `${s.collector} fill-rate ${s.meanFillRate.toFixed(3)} within peer range (median ${med.toFixed(3)})`;

    return {
      check: 'peer',
      ok: !flagged,
      detail,
      metrics: {
        collector: s.collector,
        rowsCount: s.rowsCount,
        meanFillRate: s.meanFillRate,
        medianFillRate: med,
        mad,
        deviation,
        madMultiple,
        advisory: true,
      } satisfies PeerMetrics,
    };
  });
}
