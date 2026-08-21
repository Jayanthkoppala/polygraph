import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useReducedMotion } from 'motion/react';
import { gsap } from 'gsap';
import { InertiaPlugin } from 'gsap/InertiaPlugin';
import './DotGrid.css';

gsap.registerPlugin(InertiaPlugin);

type Dot = { cx: number; cy: number; xOffset: number; yOffset: number; inertiaApplied: boolean };

function hexToRgb(hex: string) {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return { r: 0, g: 0, b: 0 };
  return { r: Number.parseInt(match[1], 16), g: Number.parseInt(match[2], 16), b: Number.parseInt(match[3], 16) };
}

interface DotGridProps {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  proximity?: number;
  speedTrigger?: number;
  shockRadius?: number;
  shockStrength?: number;
  maxSpeed?: number;
  resistance?: number;
  returnDuration?: number;
  className?: string;
  style?: CSSProperties;
}

export function DotGrid({
  dotSize = 2,
  gap = 16,
  baseColor = '#313131',
  activeColor = '#6E7681',
  proximity = 150,
  speedTrigger = 100,
  shockRadius = 250,
  shockStrength = 5,
  maxSpeed = 5000,
  resistance = 750,
  returnDuration = 1.5,
  className = '',
  style,
}: DotGridProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Dot[]>([]);
  const reducedMotion = useReducedMotion() ?? false;
  const pointerRef = useRef({ x: -1000, y: -1000, vx: 0, vy: 0, speed: 0, lastTime: 0, lastX: 0, lastY: 0 });
  const baseRgb = useMemo(() => hexToRgb(baseColor), [baseColor]);
  const activeRgb = useMemo(() => hexToRgb(activeColor), [activeColor]);

  const buildGrid = useCallback(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas || typeof window.CanvasRenderingContext2D === 'undefined') return;
    const { width, height } = wrapper.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context?.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cell = dotSize + gap;
    const columns = Math.max(1, Math.floor((width + gap) / cell));
    const rows = Math.max(1, Math.floor((height + gap) / cell));
    const startX = (width - (cell * columns - gap)) / 2 + dotSize / 2;
    const startY = (height - (cell * rows - gap)) / 2 + dotSize / 2;
    dotsRef.current = Array.from({ length: rows * columns }, (_, index) => ({
      cx: startX + (index % columns) * cell,
      cy: startY + Math.floor(index / columns) * cell,
      xOffset: 0,
      yOffset: 0,
      inertiaApplied: false,
    }));
  }, [dotSize, gap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window.CanvasRenderingContext2D === 'undefined') return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let animationFrame = 0;
    let visible = true;
    const proximitySquared = proximity * proximity;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      context.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      const pointer = pointerRef.current;
      for (const dot of dotsRef.current) {
        const dx = dot.cx - pointer.x;
        const dy = dot.cy - pointer.y;
        const distanceSquared = dx * dx + dy * dy;
        let color = baseColor;
        if (!reducedMotion && distanceSquared <= proximitySquared) {
          const amount = 1 - Math.sqrt(distanceSquared) / proximity;
          color = `rgb(${Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * amount)},${Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * amount)},${Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * amount)})`;
        }
        context.beginPath();
        context.arc(dot.cx + dot.xOffset, dot.cy + dot.yOffset, dotSize / 2, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
      }
      if (!reducedMotion && visible && !document.hidden) animationFrame = requestAnimationFrame(draw);
    };

    buildGrid();
    draw();
    const resizeObserver = new ResizeObserver(() => { buildGrid(); if (reducedMotion) draw(); });
    if (wrapperRef.current) resizeObserver.observe(wrapperRef.current);
    const intersectionObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(([entry]) => {
          const wasVisible = visible;
          visible = entry.isIntersecting;
          if (!reducedMotion && visible && !wasVisible) animationFrame = requestAnimationFrame(draw);
        });
    if (wrapperRef.current) intersectionObserver?.observe(wrapperRef.current);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
    };
  }, [activeRgb, baseColor, baseRgb, buildGrid, dotSize, proximity, reducedMotion]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || reducedMotion) return;

    const onMove = (event: PointerEvent) => {
      const now = performance.now();
      const pointer = pointerRef.current;
      const deltaTime = pointer.lastTime ? now - pointer.lastTime : 16;
      let velocityX = ((event.clientX - pointer.lastX) / deltaTime) * 1000;
      let velocityY = ((event.clientY - pointer.lastY) / deltaTime) * 1000;
      let speed = Math.hypot(velocityX, velocityY);
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed;
        velocityX *= scale;
        velocityY *= scale;
        speed = maxSpeed;
      }
      const rect = wrapper.getBoundingClientRect();
      Object.assign(pointer, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        vx: velocityX,
        vy: velocityY,
        speed,
        lastTime: now,
        lastX: event.clientX,
        lastY: event.clientY,
      });

      for (const dot of dotsRef.current) {
        const distance = Math.hypot(dot.cx - pointer.x, dot.cy - pointer.y);
        if (speed <= speedTrigger || distance >= proximity || dot.inertiaApplied) continue;
        dot.inertiaApplied = true;
        gsap.killTweensOf(dot);
        gsap.to(dot, {
          inertia: { xOffset: dot.cx - pointer.x + velocityX * 0.005, yOffset: dot.cy - pointer.y + velocityY * 0.005, resistance },
          onComplete: () => {
            gsap.to(dot, { xOffset: 0, yOffset: 0, duration: returnDuration, ease: 'elastic.out(1,0.75)', onComplete: () => { dot.inertiaApplied = false; } });
          },
        });
      }
    };

    const onClick = (event: MouseEvent) => {
      const rect = wrapper.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const clickY = event.clientY - rect.top;
      for (const dot of dotsRef.current) {
        const distance = Math.hypot(dot.cx - clickX, dot.cy - clickY);
        if (distance >= shockRadius || dot.inertiaApplied) continue;
        const falloff = Math.max(0, 1 - distance / shockRadius);
        dot.inertiaApplied = true;
        gsap.killTweensOf(dot);
        gsap.to(dot, {
          xOffset: (dot.cx - clickX) * shockStrength * falloff,
          yOffset: (dot.cy - clickY) * shockStrength * falloff,
          duration: 0.18,
          ease: 'power2.out',
          onComplete: () => {
            gsap.to(dot, { xOffset: 0, yOffset: 0, duration: returnDuration, ease: 'elastic.out(1,0.75)', onComplete: () => { dot.inertiaApplied = false; } });
          },
        });
      }
    };

    let lastMove = 0;
    const throttledMove = (event: PointerEvent) => {
      const now = performance.now();
      if (now - lastMove < 50) return;
      lastMove = now;
      onMove(event);
    };
    const onLeave = () => { pointerRef.current.x = -1000; pointerRef.current.y = -1000; };

    wrapper.addEventListener('pointermove', throttledMove, { passive: true });
    wrapper.addEventListener('pointerleave', onLeave);
    wrapper.addEventListener('click', onClick);
    return () => {
      wrapper.removeEventListener('pointermove', throttledMove);
      wrapper.removeEventListener('pointerleave', onLeave);
      wrapper.removeEventListener('click', onClick);
      for (const dot of dotsRef.current) gsap.killTweensOf(dot);
    };
  }, [maxSpeed, proximity, reducedMotion, resistance, returnDuration, shockRadius, shockStrength, speedTrigger]);

  return (
    <div className={`dot-grid ${className}`} style={style} aria-hidden>
      <div ref={wrapperRef} className="dot-grid__wrap">
        <canvas ref={canvasRef} className="dot-grid__canvas" />
      </div>
    </div>
  );
}
