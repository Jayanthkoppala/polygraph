/**
 * Magic UI `blur-fade` (registry:ui, pulled from the Magic UI registry via
 * MCP `getRegistryItem("blur-fade")`), with the ui-system.md corrections the
 * shipped source needs — following §3.1's convention: name the line that
 * broke, ship the corrected version, keep the component's real structure.
 *
 * Corrections to the shipped source:
 *  - `ease: "easeOut"` → `[0.32, 0.72, 0, 1]` (--ease-fluid). §1.9: "There
 *    is no `ease`, no `ease-in-out`, no `linear`."
 *  - Defaults retuned to §4.3's scroll-reveal spec: 800ms (--dur-reveal),
 *    16px offset, 12px blur, `inView` on by default with the same `-80px`
 *    margin the page's existing reveals use.
 *  - `useInView` from `motion/react` replaced by a guarded
 *    IntersectionObserver effect: framer-motion's viewport observer calls
 *    `new IntersectionObserver(...)` unguarded
 *    (framer-motion/dist/es/render/dom/viewport/index.mjs:34), which throws
 *    in this suite's jsdom. Same missing-API-means-visible fallback
 *    FleetScale uses.
 *  - Reduced motion collapses to §6.5's 120ms opacity-only crossfade —
 *    no translate, no blur.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type MotionProps, type Variants } from 'motion/react';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

interface BlurFadeProps extends MotionProps {
  children: React.ReactNode;
  className?: string;
  duration?: number;
  delay?: number;
  offset?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  inView?: boolean;
  inViewMargin?: string;
  blur?: string;
}

export function BlurFade({
  children,
  className,
  duration = 0.8,
  delay = 0,
  offset = 16,
  direction = 'up',
  inView = true,
  inViewMargin = '-80px',
  blur = '12px',
  ...props
}: BlurFadeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [inViewResult, setInViewResult] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      // No observer (jsdom, ancient browser): never leave content hidden.
      setInViewResult(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInViewResult(true);
          io.disconnect();
        }
      },
      { rootMargin: inViewMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inViewMargin]);

  const isInView = !inView || inViewResult;

  const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
  const hiddenOffset = direction === 'right' || direction === 'down' ? -offset : offset;

  // The reduced variants still name `filter` and the axis explicitly: motion
  // keeps the last value a variant set, so if the preference flips after the
  // first paint (the hook resolves in an effect), an unnamed `filter` would
  // leave the initial blur frozen on screen.
  const variants: Variants = reduced
    ? {
        hidden: { [axis]: 0, opacity: 0, filter: 'blur(0px)' },
        visible: { [axis]: 0, opacity: 1, filter: 'blur(0px)' },
      }
    : {
        hidden: { [axis]: hiddenOffset, opacity: 0, filter: `blur(${blur})` },
        visible: { [axis]: 0, opacity: 1, filter: 'blur(0px)' },
      };

  return (
    <AnimatePresence>
      <motion.div
        ref={ref}
        initial="hidden"
        animate={isInView ? 'visible' : 'hidden'}
        exit="hidden"
        variants={variants}
        transition={{
          delay: 0.04 + delay,
          duration: reduced ? 0.12 : duration,
          ease: [0.32, 0.72, 0, 1],
        }}
        className={className}
        {...props}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
