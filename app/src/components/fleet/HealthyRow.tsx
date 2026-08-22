// "Healthy collectors do not deserve equal pixels" (§4); renders nothing when empty.

// The green rule is a bar element, never a `border-l-*` — single-sided borders are
// forbidden product-wide (§1.2/B4).
import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { CollectorState } from '@/lib/api';

const PREVIEW_COUNT = 4;

export function HealthyRow({ collectors }: { collectors: CollectorState[] }) {
  const [expanded, setExpanded] = useState(false);
  if (collectors.length === 0) return null;

  const names = collectors.map((c) => c.name);
  const shown = expanded ? names : names.slice(0, PREVIEW_COUNT);
  const remaining = names.length - shown.length;

  return (
    <div
      data-testid="healthy-row"
      className="relative flex items-center gap-3 rounded-lg border border-[#272727] bg-[var(--color-surface)] py-2 pl-4 pr-3"
    >
      <span aria-hidden className="absolute inset-y-2 left-2 w-[2px] rounded-full bg-[var(--color-verdict-pass)]" />
      <span className="shrink-0 pl-2 text-sm font-medium text-[#9B9B9B]">
        <span className="font-mono tabular-nums text-[#EDEDED]">{collectors.length}</span>
        {` collector${collectors.length === 1 ? '' : 's'} passing`}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#9B9B9B]">
        {shown.join(' · ')}
        {remaining > 0 ? ` · +${remaining}` : ''}
      </span>
      {names.length > PREVIEW_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse passing collectors' : 'Expand passing collectors'}
          className="shrink-0 text-[#9B9B9B] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          <CaretDown size={14} weight="regular" className={expanded ? 'rotate-180' : ''} aria-hidden />
        </button>
      )}
    </div>
  );
}
