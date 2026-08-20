/**
 * Landing-surface system regressions — the design-law properties that are
 * easy to re-break one section at a time, asserted once, centrally.
 *
 * Two kinds of test live here:
 *
 *   - SOURCE SCANS over `src/landing/**`, in the same style as
 *     `honesty.test.ts`. Section rhythm and token discipline are properties
 *     of every section, so scanning the files catches a new section that
 *     quietly reintroduces `py-16` or `--text-faint`, which a render test of
 *     one component never would.
 *   - RENDER tests for behaviour (the copy control's acknowledgement, the
 *     final CTA's destination).
 *
 * What is deliberately NOT here: the hero's two-line headline break. jsdom
 * performs no text layout, so a "does this wrap" assertion in this file
 * could only ever be a class-name tautology. That property was measured in
 * the built app in a real browser instead (see Hero.tsx's module doc for the
 * numbers); the class-shape test below is the tripwire for someone changing
 * those classes without re-measuring, not a proof of the layout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FinalCTA } from './sections/FinalCTA';
import { Hero } from './sections/Hero';
import { useSandboxEngine } from './sandbox/useSandboxEngine';

const LANDING_DIR = path.dirname(fileURLToPath(import.meta.url));
const SECTIONS_DIR = path.join(LANDING_DIR, 'sections');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `honesty.test.ts`'s convention, generalised: a doc comment quoting a rule
 * ("no `animate-pulse` here, because §1.9...") is the rule working, not
 * violating it — so comments are blanked out before scanning. Blanking
 * rather than dropping keeps line numbers honest in the failure message,
 * and covers JSX `{/* ... *\/}` blocks, which a per-line `startsWith` check
 * misses on every continuation line.
 */
function codeLines(file: string): { n: number; line: string }[] {
  const blanked = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return blanked.split('\n').map((line, i) => ({ n: i + 1, line }));
}

describe('landing section rhythm (ui-system.md §1.6: "Section padding, landing page — 96px top and bottom")', () => {
  it('every below-the-fold section is py-24, with no py-16 left anywhere', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SECTIONS_DIR)) {
      for (const { n, line } of codeLines(file)) {
        if (/\bpy-16\b|\bpt-16\b|\bpb-16\b/.test(line)) {
          offenders.push(`${path.relative(LANDING_DIR, file)}:${n} — ${line.trim()}`);
        }
      }
    }
    // Measured before this rule existed: sections alternated 96/64, 64/64
    // and 96/96, so the page had no rhythm at all — it just looked
    // unevenly spaced. 96px is the only value §1.6 allows here.
    expect(offenders).toEqual([]);
  });

  it('the hero is the one documented exception, and only on the edge that faces the nav', () => {
    const hero = readFileSync(path.join(SECTIONS_DIR, 'Hero.tsx'), 'utf8');
    // `pt-4` is the hero's offset from the top nav — not a section-to-section
    // boundary. Measured at 1512x800 with the flow-in-viewport hero
    // (2026-08-20): at pt-8 the refusal kicker's bottom edge landed at
    // 813px, 13px below the fold; pt-4 recovers it. The bottom edge, which
    // IS a section boundary, stays on the 96px rhythm.
    expect(hero).toMatch(/pb-24 pt-4/);
  });
});

describe('landing text tokens (ui-system.md §1.3: --text-faint is "Decoration only. Never for text that carries meaning")', () => {
  it('#6E7681 survives only on elements explicitly hidden from the accessibility tree', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(LANDING_DIR)) {
      for (const { n, line } of codeLines(file)) {
        if (line.includes('#6E7681') && !line.includes('aria-hidden')) {
          offenders.push(`${path.relative(LANDING_DIR, file)}:${n} — ${line.trim()}`);
        }
      }
    }
    // The surviving case is HowItWorks' `$ ` shell prompt: a glyph with no
    // recoverable meaning, which is the rail-hairline case §1.3 keeps the
    // token for. Everything a reader has to READ — the hash prefix, the
    // event count, the run age, the actions-left budget, the legal links,
    // the skeleton's status line — is --text-muted (#9B9B9B, 5.93:1).
    expect(offenders).toEqual([]);
  });
});

describe('landing motion budget (ui-system.md §1.9: idle pulsing is banned outright)', () => {
  it('nothing on the landing page animates while at rest', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(LANDING_DIR)) {
      for (const { n, line } of codeLines(file)) {
        if (/animate-(pulse|ping|bounce|spin)/.test(line)) {
          offenders.push(`${path.relative(LANDING_DIR, file)}:${n} — ${line.trim()}`);
        }
      }
    }
    // The "live" dot used to carry `motion-safe:animate-pulse` forever. A
    // dot that throbs on a resting, healthy fleet teaches that green means
    // "animating" rather than "verified" — §1.9: "A card sitting there being
    // fine is not an event and gets none."
    expect(offenders).toEqual([]);
  });
});

describe('FinalCTA — the page\'s only conversion (ux-spec.md §1a, §3 handoff)', () => {
  afterEach(cleanup);

  it('points at /signup, never back up the page at an anchor', () => {
    render(<FinalCTA />);
    const cta = screen.getByTestId('final-cta');
    expect(cta).toHaveAttribute('href', '/signup');
    // ui-system.md §4.3's "identical to hero" is a visual instruction about
    // the button; read literally it produced `href="#sandbox"`, which sent
    // the last control on the page back to a demo the reader had already
    // scrolled past, and the page converted nowhere.
    expect(cta.getAttribute('href')).not.toMatch(/^#/);
  });
});

describe('Hero — the copy control acknowledges the click (§1.9: a click IS an event)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function HeroHarness() {
    const sandbox = useSandboxEngine();
    return <Hero sandbox={sandbox} />;
  }

  it('writes the real command to the clipboard and says so, then reverts', async () => {
    // The control moved with the self-host band: hero → FinalCTA.tsx's S5
    // `RunItYourself` (positioning.md S1: "the self-host footnote + copy
    // command (moves to S5)"). Same invariant, surviving control.
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    render(<FinalCTA />);
    const button = screen.getByTestId('selfhost-copy-command');

    expect(button).toHaveAttribute('data-copied', 'false');
    expect(button).toHaveTextContent('copy');

    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledWith('npx tsx src/index.ts demo');
    expect(button).toHaveAttribute('data-copied', 'true');
    expect(button).toHaveTextContent('copied');

    // It reverts on its own — a control stuck in "copied" is as uninformative
    // as one that never acknowledged at all. (act(): the revert is a state
    // update fired from inside a faked timer callback, not an event.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(button).toHaveAttribute('data-copied', 'false');
    expect(button).toHaveTextContent('copy');
  });

  it("the hero's secondary CTA anchors to the S5 band that actually exists", () => {
    // `#run-it-yourself` is rendered by FinalCTA's RunItYourself section —
    // built there specifically as this link's target. If either half is
    // renamed alone, the hero's only self-host affordance silently 404s
    // into a no-op scroll.
    render(<HeroHarness />);
    const link = screen.getByRole('link', { name: /run it yourself, offline/i });
    expect(link).toHaveAttribute('href', '#run-it-yourself');
    cleanup();
    render(<FinalCTA />);
    expect(document.getElementById('run-it-yourself')).not.toBeNull();
  });

  it('holds the headline at the size and column the measured break was verified against', () => {
    const hero = readFileSync(path.join(SECTIONS_DIR, 'Hero.tsx'), 'utf8');
    // Re-measured 2026-08-20 for the two-column S1 hero (positioning.md §3,
    // controller-final) in a real browser at 1512x800 with the shipped
    // Geist 700: "Your scraper says 200 OK." needs 464px at text-4xl and
    // 515px at text-5xl's neighbor 40px; the left grid column
    // (max-w-7xl, 2fr/3fr, gap-8) is ~499px. So text-4xl is the largest
    // type-scale step where headline line one holds unbroken; one step up
    // breaks it. Change any half of this triple (heading size, grid cap,
    // column split) and RE-MEASURE in a browser — do not re-guess.
    expect(hero).toMatch(/md:text-4xl/);
    expect(hero).toMatch(/max-w-7xl/);
    // minmax(0,…) is load-bearing, not styling: bare fr tracks carry a
    // min-content minimum, the exact mechanism behind the 2349px grid
    // blowout this file's width discipline exists to prevent.
    expect(hero).toMatch(/md:grid-cols-\[minmax\(0,2fr\)_minmax\(0,3fr\)\]/);
    expect(hero).not.toMatch(/md:text-5xl|md:text-6xl/);
  });
});
