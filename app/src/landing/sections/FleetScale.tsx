/**
 * FleetScale — "One collector or forty" (ui-system.md §3.9/§4.3, order 6,
 * below the fold). The one WebGL moment in the product: ReactBits `Threads`
 * (installed via `npx shadcn@latest add @react-bits/Threads-TS-TW`, per
 * `app/components.json`'s `@react-bits` registry — the registry's actual
 * item names carry a `-TS-TW`/`-JS-CSS`/etc. variant suffix, confirmed
 * against `https://reactbits.dev/r/registry.json` directly), gated by all
 * four rules the designer specified:
 *   (a) never renders while offscreen (IntersectionObserver)
 *   (b) prefers-reduced-motion OR a failed WebGL context probe -> StaticThreads
 *   (c) no text over the canvas — the heading sits above it, canvas is aria-hidden
 *   (d) a contained ~420px bordered element, not a background/surface fill
 *
 * `StaticThreads` (the flat SVG fallback) is this task's own component, not
 * a registry item — ui-system.md §3.9 specifies its exact 40-line markup
 * itself, it isn't something ReactBits ships.
 */
import { useEffect, useRef, useState } from 'react';
import Threads from '@/components/Threads';
import { StaticThreads } from '../webgl/StaticThreads';

/** Probes for a real WebGL context without ever mounting the real canvas —
 * a failed probe is gate (b)'s second trigger, alongside reduced motion. */
function canGetWebglContext(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    return !!gl;
  } catch {
    return false;
  }
}

export function FleetScale() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    setWebglOk(canGetWebglContext());
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const shouldAnimate = intersecting && webglOk === true && !reducedMotion;

  return (
    <section className="bg-[#000000] py-24">
      <h2 className="mx-auto mb-12 max-w-[680px] text-balance px-6 text-3xl font-semibold text-[#EDEDED]">
        One collector or forty. The same four checks run on every run.
      </h2>

      {/* Gate (c): the canvas carries no text; the heading is above, outside it. */}
      {/* Gate (d): a contained 420px bordered element, not a surface fill. */}
      <div
        ref={containerRef}
        aria-hidden
        data-testid="fleet-scale-canvas"
        data-animate={shouldAnimate}
        className="relative mx-auto h-[420px] w-full max-w-6xl overflow-hidden rounded-2xl border border-[#272727] opacity-20"
      >
        {shouldAnimate ? (
          <Threads color={[1, 1, 1]} amplitude={0.9} distance={0.35} enableMouseInteraction={false} />
        ) : (
          <StaticThreads />
        )}
      </div>
    </section>
  );
}
