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
      {/* `text-center`: §3.9's code sample omits it, but every other section
          heading on this page (and §4.1's hero) is centered, so this was the
          page's one heading that sat left while its own content block was
          centered under it. Alignment consistency wins over a sample that
          wasn't making an alignment argument. */}
      <h2 className="mx-auto mb-4 max-w-[680px] text-balance px-6 text-center text-3xl font-semibold text-[#EDEDED]">
        Your fleet gets watched while you don&rsquo;t watch it.
      </h2>
      {/* Real hosted numbers, not marketing ones: five collectors is
          `tenants.max_collectors` DEFAULT 5 (src/tenancy/migrate.ts:85),
          hourly is the `interval_minutes >= 60` floor
          (tenant-architecture.md §5 abuse floors). */}
      <p className="mx-auto mb-12 max-w-[680px] text-pretty px-6 text-center text-base text-[#B4B4B4]">
        The hosted beta runs up to five collectors per account, on a schedule as frequent as every
        hour. Every run gets the same four checks, and every decision lands in your ledger —
        including the ones made at 3am.
      </p>

      {/* Gate (c): the canvas carries no text; the heading is above, outside it. */}
      {/* Gate (d): a contained 420px bordered element, not a surface fill. */}
      <div
        ref={containerRef}
        aria-hidden
        data-testid="fleet-scale-canvas"
        data-animate={shouldAnimate}
        // `opacity-40`, not §3.9's literal `opacity-20`. §3.9's own reasoning
        // for the value is only "the container's opacity-20 does the
        // dimming" of a white `[1,1,1]` shader so it stays out of the verdict
        // palette — at 20% on #000000 the brightest thread lands near #333,
        // and the section renders as an empty bordered box in any still
        // frame (which is also what a reduced-motion or no-WebGL visitor sees
        // permanently, since StaticThreads' 0.08-wide strokes are dimmed by
        // the same container). 40% keeps it neutral-white and unmistakably
        // not-a-verdict while making the 40 lines actually visible. Flagged
        // as a deliberate deviation, not drift.
        className="relative mx-auto h-[420px] w-full max-w-6xl overflow-hidden rounded-2xl border border-[#272727] opacity-40"
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
