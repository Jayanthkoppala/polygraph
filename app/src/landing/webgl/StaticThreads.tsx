/**
 * StaticThreads — Gate (b)'s flat fallback (ui-system.md §3.9): 40 straight
 * SVG lines on flat `#000000`, zero motion, zero GPU. Rendered whenever
 * `prefers-reduced-motion` is set OR a real WebGL context probe fails.
 */
const LINE_COUNT = 40;

export function StaticThreads() {
  return (
    <svg
      data-testid="static-threads"
      className="h-full w-full bg-[#000000]"
      preserveAspectRatio="none"
      viewBox="0 0 100 40"
      aria-hidden
    >
      {Array.from({ length: LINE_COUNT }, (_, i) => (
        <line key={i} x1="0" x2="100" y1={i + 0.5} y2={i + 0.5} stroke="#FFFFFF" strokeWidth="0.08" />
      ))}
    </svg>
  );
}
