import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { annotate } from 'rough-notation';
import type { RoughAnnotation } from 'rough-notation/lib/model';
import './magicui.css';

type AnnotationAction = 'highlight' | 'underline' | 'box' | 'circle' | 'strike-through' | 'crossed-off' | 'bracket';

/** Source: magicuidesign/magicui registry/magicui/highlighter.tsx. */
export interface HighlighterProps {
  children: ReactNode;
  action?: AnnotationAction;
  color?: string;
  strokeWidth?: number;
  animationDuration?: number;
  iterations?: number;
  padding?: number;
  multiline?: boolean;
  isView?: boolean;
  className?: string;
}

export function Highlighter({ children, action = 'highlight', color = '#ffd1dc', strokeWidth = 1.5, animationDuration = 600,
  iterations = 2, padding = 2, multiline = true, isView = false, className }: HighlighterProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [isInView, setIsInView] = useState(!isView);
  useEffect(() => {
    const element = elementRef.current;
    if (!isView || !element || typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setIsInView(true);
        observer.disconnect();
      }
    }, { rootMargin: '-10%' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isView]);
  const shouldShow = !isView || isInView;
  useLayoutEffect(() => {
    const element = elementRef.current;
    let annotation: RoughAnnotation | null = null;
    let resizeObserver: ResizeObserver | null = null;
    if (shouldShow && element) {
      annotation = annotate(element, { type: action, color, strokeWidth, animationDuration, iterations, padding, multiline });
      annotation.show();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { annotation?.hide(); annotation?.show(); });
        resizeObserver.observe(element);
        resizeObserver.observe(document.body);
      }
    }
    return () => { annotation?.remove(); resizeObserver?.disconnect(); };
  }, [shouldShow, action, color, strokeWidth, animationDuration, iterations, padding, multiline]);
  return <span ref={elementRef} className={['pg-magic-highlighter', className].filter(Boolean).join(' ')}>{children}</span>;
}
