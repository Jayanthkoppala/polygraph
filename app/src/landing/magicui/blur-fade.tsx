// Magic UI `blur-fade` with ui-system.md corrections: --ease-fluid instead of
// `easeOut`, §4.3 reveal defaults, and reduced motion collapsed to a crossfade.
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
      // Hand-rolled instead of motion's `useInView`, which constructs an
      // IntersectionObserver unguarded and throws in jsdom. Missing API: stay visible.
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

  // The reduced variants name `filter` and the axis explicitly: motion keeps the
  // last value a variant set, so an unnamed one would freeze the initial blur.
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
