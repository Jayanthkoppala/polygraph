/** One sentence in the largest type on the page (§4). `text-3xl` is the largest class
 *  used anywhere in the shell, so the claim holds without an off-scale size. */
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
