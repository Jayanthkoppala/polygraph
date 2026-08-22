import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import './magicui.css';

export interface CodeComparisonProps {
  beforeCode: string;
  afterCode: string;
  language?: string;
  filename?: string;
  lightTheme?: string;
  darkTheme?: string;
  /** Vite adaptation: the caller declares the visual theme instead of next-themes. */
  theme?: 'light' | 'dark';
  highlightColor?: string;
  className?: string;
}

/**
 * Source: magicuidesign/magicui registry/magicui/code-comparison.tsx.
 * The rendered two-up comparison, Shiki transform pipeline, focus behaviour,
 * and semantic before/after labels are kept. next-themes is replaced by a
 * deterministic `theme` prop because Polygraph has no Next provider.
 */
export function CodeComparison({ beforeCode, afterCode, language = 'json', filename = 'response.json', lightTheme = 'github-light', darkTheme = 'github-dark', theme = 'dark', highlightColor = '#ff3333', className }: CodeComparisonProps) {
  const [highlightedBefore, setHighlightedBefore] = useState('');
  const [highlightedAfter, setHighlightedAfter] = useState('');
  const selectedTheme = useMemo(() => theme === 'dark' ? darkTheme : lightTheme, [theme, darkTheme, lightTheme]);
  const hasLeftFocus = highlightedBefore.includes('class="line focused"');
  const hasRightFocus = highlightedAfter.includes('class="line focused"');
  useEffect(() => {
    let active = true;
    async function highlightCode() {
      try {
        const { codeToHtml } = await import('shiki');
        const { transformerNotationDiff, transformerNotationFocus, transformerNotationHighlight } = await import('@shikijs/transformers');
        const options = { lang: language, theme: selectedTheme, transformers: [transformerNotationHighlight({ matchAlgorithm: 'v3' }), transformerNotationDiff({ matchAlgorithm: 'v3' }), transformerNotationFocus({ matchAlgorithm: 'v3' })] };
        const [before, after] = await Promise.all([codeToHtml(beforeCode, options), codeToHtml(afterCode, options)]);
        if (active) { setHighlightedBefore(before); setHighlightedAfter(after); }
      } catch (error) {
        console.error('CodeComparison highlighting failed:', error);
        if (active) { setHighlightedBefore(''); setHighlightedAfter(''); }
      }
    }
    void highlightCode();
    return () => { active = false; };
  }, [beforeCode, afterCode, language, selectedTheme]);
  const renderCode = (code: string, highlighted: string) => highlighted
    ? <div className="pg-magic-code__html" style={{ '--highlight-color': highlightColor } as CSSProperties} dangerouslySetInnerHTML={{ __html: highlighted }} />
    : <pre className="pg-magic-code__fallback">{code}</pre>;
  return <div className={['pg-magic-code', className].filter(Boolean).join(' ')} aria-label="Returned JSON comparison">
    <div className={['pg-magic-code__panel pg-magic-code__panel--before', hasLeftFocus ? 'has-focus' : ''].filter(Boolean).join(' ')}><div className="pg-magic-code__tab"><FileGlyph />{filename}<span>before</span></div>{renderCode(beforeCode, highlightedBefore)}</div>
    <div className={['pg-magic-code__panel pg-magic-code__panel--after', hasRightFocus ? 'has-focus' : ''].filter(Boolean).join(' ')}><div className="pg-magic-code__tab"><FileGlyph />{filename}<span>after</span></div>{renderCode(afterCode, highlightedAfter)}</div>
    <div className="pg-magic-code__versus" aria-hidden="true">VS</div>
  </div>;
}

function FileGlyph() { return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6l4 4v9H3zM9 1.5v4h4" /></svg>; }
