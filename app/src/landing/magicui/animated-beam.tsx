/**
 * Magic UI `animated-beam` (registry:ui, pulled from the Magic UI registry
 * via MCP `getRegistryItem("animated-beam")`), corrected per ui-system.md
 * §3.1's convention: same structure, same ref-measured quadratic path, same
 * travelling-gradient mechanism — with the shipped lines that break the
 * design law replaced and named.
 *
 * Corrections to the shipped source:
 *  - `repeat = Infinity` default → `repeat = 0` (one pass). §1.9's motion
 *    budget bans "looping beams on resting state" outright; a beam that
 *    fires once when the diagram enters view is an event, a beam that loops
 *    forever is decoration. Callers may not turn Infinity back on.
 *  - `gradientStartColor = "#ffaa40"`, `gradientStopColor = "#9c40ff"` →
 *    both default `#EDEDED`. The orange→purple sweep collides with the
 *    verdict palette (§3.3 made the same correction to border-beam's
 *    `colorTo`); sections pass a single verdict color per beam.
 *  - Reduced motion renders the static base path only — the travelling
 *    gradient never mounts. The connection geometry (which is the meaning)
 *    survives, per §1.9's "static geometry survives intact".
 *  - The shipped `ease: [0.16, 1, 0.3, 1]` is kept: it is --ease-snap.
 *
 * The moving stroke is line work (a gradient on a 2px path), not a surface
 * fill — the same B4 reasoning that permits the dashed rail's
 * `repeating-linear-gradient` in §2.3.
 */
import { useEffect, useId, useState, type RefObject } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export interface AnimatedBeamProps {
  className?: string;
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  curvature?: number;
  reverse?: boolean;
  pathColor?: string;
  pathWidth?: number;
  pathOpacity?: number;
  gradientStartColor?: string;
  gradientStopColor?: string;
  delay?: number;
  duration?: number;
  repeat?: number;
  repeatDelay?: number;
  startXOffset?: number;
  startYOffset?: number;
  endXOffset?: number;
  endYOffset?: number;
}

export const AnimatedBeam: React.FC<AnimatedBeamProps> = ({
  className,
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 5,
  delay = 0,
  pathColor = '#313131',
  pathWidth = 2,
  pathOpacity = 0.6,
  gradientStartColor = '#EDEDED',
  gradientStopColor = '#EDEDED',
  repeat = 0,
  repeatDelay = 0,
  startXOffset = 0,
  startYOffset = 0,
  endXOffset = 0,
  endYOffset = 0,
}) => {
  const id = useId();
  const [pathD, setPathD] = useState('');
  const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 });
  const reduced = usePrefersReducedMotion();

  const gradientCoordinates = reverse
    ? { x1: ['90%', '-10%'], x2: ['100%', '0%'], y1: ['0%', '0%'], y2: ['0%', '0%'] }
    : { x1: ['10%', '110%'], x2: ['0%', '100%'], y1: ['0%', '0%'], y2: ['0%', '0%'] };

  useEffect(() => {
    const updatePath = () => {
      if (containerRef.current && fromRef.current && toRef.current) {
        const containerRect = containerRef.current.getBoundingClientRect();
        const rectA = fromRef.current.getBoundingClientRect();
        const rectB = toRef.current.getBoundingClientRect();

        setSvgDimensions({ width: containerRect.width, height: containerRect.height });

        const startX = rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
        const startY = rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
        const endX = rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
        const endY = rectB.top - containerRect.top + rectB.height / 2 + endYOffset;

        const controlY = startY - curvature;
        const d = `M ${startX},${startY} Q ${(startX + endX) / 2},${controlY} ${endX},${endY}`;
        setPathD(d);
      }
    };

    if (typeof ResizeObserver === 'undefined') {
      updatePath();
      return;
    }
    const resizeObserver = new ResizeObserver(() => updatePath());
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    updatePath();
    return () => resizeObserver.disconnect();
  }, [containerRef, fromRef, toRef, curvature, startXOffset, startYOffset, endXOffset, endYOffset]);

  return (
    <svg
      fill="none"
      width={svgDimensions.width}
      height={svgDimensions.height}
      xmlns="http://www.w3.org/2000/svg"
      className={cn('pointer-events-none absolute left-0 top-0 transform-gpu stroke-2', className)}
      viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
      aria-hidden
    >
      <path d={pathD} stroke={pathColor} strokeWidth={pathWidth} strokeOpacity={pathOpacity} strokeLinecap="round" />
      {!reduced && (
        <>
          <path d={pathD} strokeWidth={pathWidth} stroke={`url(#${id})`} strokeOpacity="1" strokeLinecap="round" />
          <defs>
            <motion.linearGradient
              className="transform-gpu"
              id={id}
              gradientUnits="userSpaceOnUse"
              initial={{ x1: '0%', x2: '0%', y1: '0%', y2: '0%' }}
              animate={{
                x1: gradientCoordinates.x1,
                x2: gradientCoordinates.x2,
                y1: gradientCoordinates.y1,
                y2: gradientCoordinates.y2,
              }}
              transition={{
                delay,
                duration,
                ease: [0.16, 1, 0.3, 1],
                repeat,
                repeatDelay,
              }}
            >
              <stop stopColor={gradientStartColor} stopOpacity="0" />
              <stop stopColor={gradientStartColor} />
              <stop offset="32.5%" stopColor={gradientStopColor} />
              <stop offset="100%" stopColor={gradientStopColor} stopOpacity="0" />
            </motion.linearGradient>
          </defs>
        </>
      )}
    </svg>
  );
};
