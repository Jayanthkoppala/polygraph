import { Children, cloneElement, forwardRef, isValidElement, useEffect, useMemo, useRef, type HTMLAttributes, type MouseEvent, type ReactElement, type ReactNode, type RefAttributes } from 'react';
import gsap from 'gsap';
import './CardSwap.css';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { customClass?: string }>(
  ({ customClass, className, ...rest }, ref) => (
    <div ref={ref} {...rest} className={['card', customClass, className].filter(Boolean).join(' ')} />
  ),
);
Card.displayName = 'Card';

type CardSwapProps = {
  width?: number;
  height?: number;
  cardDistance?: number;
  verticalDistance?: number;
  delay?: number;
  pauseOnHover?: boolean;
  onCardClick?: (index: number) => void;
  skewAmount?: number;
  easing?: 'elastic' | 'smooth';
  disabled?: boolean;
  children: ReactNode;
};

type CardChildProps = HTMLAttributes<HTMLDivElement> & RefAttributes<HTMLDivElement>;

const makeSlot = (index: number, distX: number, distY: number, total: number) => ({
  x: index * distX,
  y: -index * distY,
  z: -index * distX * 1.5,
  zIndex: total - index,
});

export default function CardSwap({
  width = 500,
  height = 400,
  cardDistance = 60,
  verticalDistance = 70,
  delay = 5000,
  pauseOnHover = false,
  onCardClick,
  skewAmount = 6,
  easing = 'elastic',
  disabled = false,
  children,
}: CardSwapProps) {
  const childArr = useMemo(() => Children.toArray(children), [children]);
  const refs = useMemo(() => childArr.map(() => ({ current: null as HTMLDivElement | null })), [childArr.length]);
  const order = useRef(Array.from({ length: childArr.length }, (_, index) => index));
  const container = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    const total = refs.length;
    const context = gsap.context(() => {
      refs.forEach((ref, index) => {
        if (!ref.current) return;
        const slot = makeSlot(index, cardDistance, verticalDistance, total);
        gsap.set(ref.current, {
          ...slot,
          xPercent: -50,
          yPercent: -50,
          skewY: skewAmount,
          transformOrigin: 'center center',
          force3D: true,
        });
      });

      if (disabled || total < 2) return;

      const config = easing === 'elastic'
        ? { ease: 'elastic.out(0.6,0.9)', duration: 1.65, overlap: 0.72 }
        : { ease: 'power1.inOut', duration: 0.8, overlap: 0.45 };

      const swap = () => {
        const [front, ...rest] = order.current;
        const frontElement = refs[front]?.current;
        if (!frontElement) return;

        const timeline = gsap.timeline();
        timelineRef.current = timeline;
        // Keep the handoff inside its visual field: the next evidence state
        // rises while the current card yields, instead of falling out of frame.
        timeline.to(frontElement, { y: `+=${Math.round(height * 0.46)}`, duration: config.duration, ease: config.ease });
        timeline.addLabel('promote', `-=${config.duration * config.overlap}`);
        rest.forEach((index, slotIndex) => {
          const element = refs[index]?.current;
          if (!element) return;
          const slot = makeSlot(slotIndex, cardDistance, verticalDistance, total);
          timeline.set(element, { zIndex: slot.zIndex }, 'promote');
          timeline.to(element, { x: slot.x, y: slot.y, z: slot.z, duration: config.duration, ease: config.ease }, `promote+=${slotIndex * 0.12}`);
        });
        const backSlot = makeSlot(total - 1, cardDistance, verticalDistance, total);
        timeline.set(frontElement, { zIndex: backSlot.zIndex }, `promote+=${config.duration * 0.1}`);
        timeline.to(frontElement, { x: backSlot.x, y: backSlot.y, z: backSlot.z, duration: config.duration, ease: config.ease }, '>-0.08');
        timeline.call(() => { order.current = [...rest, front]; });
      };

      swap();
      const timer = window.setInterval(swap, delay);
      if (!pauseOnHover || !container.current) return () => window.clearInterval(timer);
      const node = container.current;
      const pause = () => timelineRef.current?.pause();
      const resume = () => timelineRef.current?.play();
      node.addEventListener('mouseenter', pause);
      node.addEventListener('mouseleave', resume);
      return () => {
        window.clearInterval(timer);
        timelineRef.current = null;
        node.removeEventListener('mouseenter', pause);
        node.removeEventListener('mouseleave', resume);
      };
    }, container);

    return () => {
      timelineRef.current = null;
      context.revert();
    };
  }, [cardDistance, childArr.length, delay, disabled, easing, height, pauseOnHover, refs, skewAmount, verticalDistance, width]);

  return (
    <div ref={container} className="card-swap-container" style={{ width, height }}>
      {childArr.map((child, index) => isValidElement(child)
        ? (() => {
          const card = child as ReactElement<CardChildProps>;
          return cloneElement(card, {
          key: index,
          ref: refs[index],
          style: { width, height, ...(card.props.style ?? {}) },
          onClick: (event: MouseEvent<HTMLDivElement>) => {
            card.props.onClick?.(event);
            onCardClick?.(index);
          },
          });
        })()
        : child)}
    </div>
  );
}
