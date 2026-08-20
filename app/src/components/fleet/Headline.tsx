/**
 * The headline sentence (ux-spec.md §4): "First (0-1s): one sentence. Not a
 * stat row. Not KPI tiles. A sentence in the largest type on the page."
 * `text-3xl` is the largest class actually used anywhere in the app shell
 * (metric values are `text-2xl`, card titles `text-base`), so it holds that
 * claim without inventing an off-scale size.
 */
import { computeHeadline } from '@/lib/density';
import { VERDICT } from '@/lib/verdict';
import type { CollectorState } from '@/lib/api';
import { relativeAge } from '@/lib/time';

export function Headline({ collectors, lastSweepTs }: { collectors: CollectorState[]; lastSweepTs: string | null }) {
  const { sentence, worstState } = computeHeadline(collectors);
  const color = worstState === 'NONE' ? undefined : VERDICT[worstState].color;

  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-balance text-3xl font-semibold" style={{ color: color ?? '#EDEDED' }}>
        {sentence}
      </h1>
      <p className="font-mono text-xs text-[#9B9B9B]">
        {lastSweepTs ? `Last full sweep ${relativeAge(lastSweepTs)}` : 'No sweep recorded yet'} ·{' '}
        <span className="tabular-nums">{collectors.length}</span> collector{collectors.length === 1 ? '' : 's'} watched
      </p>
    </div>
  );
}
