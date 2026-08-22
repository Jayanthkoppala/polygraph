/** Landing design-law regressions: source scans over src/landing/** catch a NEW
 * section reintroducing `py-16` or `--text-faint`. No wrap assertions — jsdom has no layout. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FinalCTA } from '@/landing/sections/FinalCTA';
import { Hero } from '@/landing/sections/Hero';

const LANDING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/landing');
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

/** Comments are blanked (not dropped, so line numbers stay honest): a comment
 * quoting a banned pattern is the rule working, not a violation. */
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
    // Sections used to alternate 96/64, 64/64, 96/96 — no rhythm at all.
    expect(offenders).toEqual([]);
  });

  it('the hero is the one documented exception, and only on the edge that faces the nav', () => {
    const hero = readFileSync(path.join(SECTIONS_DIR, 'Hero.tsx'), 'utf8');
    // `pt-4` is the nav offset, not a section boundary; the bottom edge is one
    // and stays on the 96px rhythm.
    expect(hero).toMatch(/pb-24 pt-4/);
  });
});

describe('landing viewport composition', () => {
  it('keeps the cinematic proof mission in the first desktop viewport', () => {
    const page = readFileSync(path.join(LANDING_DIR, 'LandingPage.tsx'), 'utf8');
    const mission = readFileSync(path.join(LANDING_DIR, 'MissionExperience.tsx'), 'utf8');
    const missionCss = readFileSync(path.join(LANDING_DIR, 'MissionExperience.css'), 'utf8');
    const chrome = readFileSync(path.resolve(LANDING_DIR, '../components/GlobalChrome.tsx'), 'utf8');
    const chromeCss = readFileSync(path.resolve(LANDING_DIR, '../components/GlobalChrome.css'), 'utf8');
    const dither = readFileSync(path.resolve(LANDING_DIR, '../components/Dither.tsx'), 'utf8');

    expect(page).toMatch(/<MissionExperience/);
    expect(mission).toMatch(/function LandingScene/);
    expect(mission).toMatch(/data-testid="landing-scene"/);
    expect(mission).toMatch(/We built a version-shifting store for this test/);
    expect(mission).toMatch(/Change the store to \$\{mission\.evidence\.changedVersion\.toUpperCase\(\)\}/);
    expect(missionCss).toMatch(/min-height: calc\(100svh - var\(--poly-chrome-offset/);
    expect(chrome).toMatch(/<Dither/);
    expect(mission).toMatch(/createMission/);
    expect(mission).not.toMatch(/LOCAL PRODUCT WALKTHROUGH/);
    expect(chromeCss).toMatch(/\.poly-floating-nav/);
    expect(dither).toMatch(/eventPrefix=\{eventSource \? 'client' : 'offset'\}/);
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
    // Only survivor: HowItWorks' `$ ` shell prompt, a meaningless glyph.
    // Anything a reader must READ uses --text-muted (#9B9B9B, 5.93:1).
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
    // The "live" dot used to pulse forever, teaching that green means
    // "animating" rather than "verified".
    expect(offenders).toEqual([]);
  });
});

describe('FinalCTA — the page\'s only conversion (ux-spec.md §1a, §3 handoff)', () => {
  afterEach(cleanup);

  it('points at /signup, never back up the page at an anchor', () => {
    render(<FinalCTA />);
    const cta = screen.getByTestId('final-cta');
    expect(cta).toHaveAttribute('href', '/signup');
    // §4.3's "identical to hero" is visual only; read literally it produced
    // `href="#sandbox"` and the page converted nowhere.
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

  it('writes the real command to the clipboard and says so, then reverts', async () => {
    // Control moved hero → FinalCTA's S5 `RunItYourself` (positioning.md S1).
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

    // Reverts on its own; a control stuck in "copied" says nothing. act() because
    // the revert fires from a faked timer callback, not an event.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(button).toHaveAttribute('data-copied', 'false');
    expect(button).toHaveTextContent('copy');
  });

  it("the hero's secondary CTA anchors to the S5 band that actually exists", () => {
    // FinalCTA renders `#run-it-yourself` solely as this link's target; rename
    // either half alone and the hero's self-host affordance becomes a no-op scroll.
    render(<Hero />);
    const link = screen.getByRole('link', { name: /run it yourself, offline/i });
    expect(link).toHaveAttribute('href', '#run-it-yourself');
    cleanup();
    render(<FinalCTA />);
    expect(document.getElementById('run-it-yourself')).not.toBeNull();
  });

  it('keeps the headline readable while viewport one remains a single focused column', () => {
    const hero = readFileSync(path.join(SECTIONS_DIR, 'Hero.tsx'), 'utf8');
    expect(hero).toMatch(/md:text-4xl/);
    expect(hero).toMatch(/max-w-7xl/);
    expect(hero).toMatch(/max-w-3xl/);
    expect(hero).toMatch(/min-h-\[calc\(100svh-45px\)\]/);
    expect(hero).not.toMatch(/md:grid-cols-/);
    expect(hero).not.toMatch(/md:text-5xl|md:text-6xl/);
  });
});
