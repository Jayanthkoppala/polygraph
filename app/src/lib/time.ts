/** Plain relative-age formatting for a `CollectorState.lastTs`-shaped ISO
 * timestamp. `null`/unparsable renders "—" — never a fabricated age. */
export function relativeAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';

  const diffMs = now - ts;
  if (diffMs < 5000) return 'just now';

  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
