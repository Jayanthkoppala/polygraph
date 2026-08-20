/**
 * Token smoke test — proves every design token in src/app.css actually
 * resolves through the real Tailwind v4 build pipeline, the way a
 * component will really reference it, rather than just being present as
 * source text.
 *
 * How: compiles app.css with the real `@tailwindcss/postcss` plugin (the
 * same engine `@tailwindcss/vite` uses under the hood) against this
 * project's real content — including token-usage.fixture.tsx, whose sole
 * job is to reference every token via the exact arbitrary-value syntax
 * (`bg-[var(--color-void)]`, `shadow-[var(--shadow-e2)]`, etc.) the
 * ui-system.md spec's own component snippets use. Tailwind v4 tree-shakes
 * any `@theme` variable it never sees referenced in scanned content, so
 * without that fixture most of this file's assertions would fail even
 * though the tokens are declared correctly — see the file's own docstring.
 *
 * This is deliberately NOT a snapshot test: every assertion pins to a
 * literal value transcribed from docs/design/ui-system.md, so a value
 * drifting from the spec fails loudly with the expected/actual spec value
 * in the diff, not a silent snapshot update.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { describe, expect, it, beforeAll } from 'vitest';

// process.cwd() rather than import.meta.url: vitest runs this file through
// vite-node, whose module URL isn't a plain file:// URL, so
// fileURLToPath(new URL(...)) throws. Vitest's cwd is the `app/` project
// root regardless of where `vitest` is invoked from.
const APP_CSS = path.resolve(process.cwd(), 'src/app.css');

let compiled: string;

beforeAll(async () => {
  const source = readFileSync(APP_CSS, 'utf8');
  const result = await postcss([tailwindcss()]).process(source, { from: APP_CSS });
  compiled = result.css;
});

/** Asserts an exact `--token: value;` custom-property declaration exists
 * in the compiled `:root` theme layer. */
function expectToken(name: string, value: string) {
  expect(compiled).toContain(`${name}: ${value};`);
}

describe('design tokens resolve through the real Tailwind v4 build (ui-system.md §1)', () => {
  it('§1.1 typeface — self-hosted Geist + Geist Mono, no CDN', () => {
    expectToken('--font-sans', `'Geist', ui-sans-serif, system-ui, sans-serif`);
    expectToken('--font-mono', `'Geist Mono', ui-monospace, monospace`);

    // Self-hosted: served from this app's own /fonts/, never a remote host.
    expect(compiled).toContain('/fonts/Geist-Variable.woff2');
    expect(compiled).toContain('/fonts/GeistMono-Variable.woff2');
    // Tailwind's printer normalizes to single quotes; semantically identical
    // to ui-system.md's `format("woff2-variations")`.
    expect(compiled).toContain("format('woff2-variations')");
    expect(compiled).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    // font-weight range per the spec: sans up to 700 (900 never used), mono up to 600.
    const sansFace = compiled.match(/@font-face\s*{\s*font-family:\s*'Geist';[\s\S]*?}/)?.[0] ?? '';
    const monoFace = compiled.match(/@font-face\s*{\s*font-family:\s*'Geist Mono';[\s\S]*?}/)?.[0] ?? '';
    expect(sansFace).toContain('font-weight: 100 700');
    expect(monoFace).toContain('font-weight: 100 600');
  });

  it('§1.2 surfaces — the six permitted flat backgrounds, nothing else', () => {
    expectToken('--color-void', '#000000');
    expectToken('--color-sunken', '#181818');
    expectToken('--color-surface', '#1f1f1f');
    expectToken('--color-raised', '#272727');
    expectToken('--color-line', '#313131');
    expectToken('--color-archive', '#131209');
  });

  it('§1.4 verdict palette — five states, magenta deliberately off the red ramp', () => {
    expectToken('--color-verdict-pass', '#4ade80');
    expectToken('--color-verdict-suspect', '#fbbf24');
    expectToken('--color-verdict-shape', '#f85149');
    expectToken('--color-verdict-target', '#e879f9');
    expectToken('--color-verdict-unchecked', '#8b949e');
  });

  it('§1.8 elevation — the lit-edge inset hairline is the load-bearing value', () => {
    expectToken('--shadow-e1', 'none');
    // The exact string called out as "the most important value in this section".
    expect(compiled).toContain('inset 0 1px 0 0 rgb(255 255 255 / 0.05)');
    expect(compiled).toContain('inset 0 1px 0 0 rgb(255 255 255 / 0.06)');
    expect(compiled).toContain('inset 0 -1px 0 0 rgb(255 255 255 / 0.04)');
  });

  it('§1.9 motion — custom cubic-beziers and the five durations, no ease/linear defaults', () => {
    expectToken('--ease-fluid', 'cubic-bezier(0.32, 0.72, 0, 1)');
    expectToken('--ease-snap', 'cubic-bezier(0.16, 1, 0.3, 1)');
    expectToken('--ease-exit', 'cubic-bezier(0.4, 0, 1, 1)');
    expectToken('--dur-instant', '120ms');
    expectToken('--dur-fast', '180ms');
    expectToken('--dur-base', '260ms');
    expectToken('--dur-slow', '420ms');
    expectToken('--dur-reveal', '800ms');
  });

  it('§6.5 prefers-reduced-motion collapses every transition to a 120ms crossfade', () => {
    expect(compiled).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(compiled).toContain('animation-duration: 120ms !important');
    expect(compiled).toContain('transition-duration: 120ms !important');
  });
});

describe("Tailwind v4 default scale matches ui-system.md's tables (§1.5-§1.7) — not redeclared, must not silently drift", () => {
  it('§1.7 radii — v4 values (rounded-sm is 4px, NOT v3\'s 2px)', () => {
    expectToken('--radius-xs', '0.125rem'); // 2px
    expectToken('--radius-sm', '0.25rem'); // 4px  — the v3/v4 breaking value
    expectToken('--radius-md', '0.375rem'); // 6px
    expectToken('--radius-lg', '0.5rem'); // 8px
    expectToken('--radius-xl', '0.75rem'); // 12px
    expectToken('--radius-2xl', '1rem'); // 16px — collector card
    expectToken('--radius-3xl', '1.5rem'); // 24px
    expectToken('--radius-4xl', '2rem'); // 32px
  });

  it('§1.6 spacing — 4px base unit, so p-3 = 12px (card padding) and gap-2 = 8px (card grid gap)', () => {
    expectToken('--spacing', '0.25rem'); // 4px base multiplier
    expect(compiled).toMatch(/\.p-3\s*{[^}]*padding:\s*calc\(var\(--spacing\)\s*\*\s*3\)/);
    expect(compiled).toMatch(/\.gap-2\s*{[^}]*gap:\s*calc\(var\(--spacing\)\s*\*\s*2\)/);
  });

  it('§1.5 type scale — Tailwind default steps, text-xs is the floor at 12px', () => {
    expectToken('--text-xs', '0.75rem'); // 12px — nothing set smaller
    expectToken('--text-sm', '0.875rem'); // 14px
    expectToken('--text-base', '1rem'); // 16px
    expectToken('--text-lg', '1.125rem'); // 18px
    expectToken('--text-2xl', '1.5rem'); // 24px — metric value
    expectToken('--text-3xl', '1.875rem'); // 30px — section heading
    expectToken('--text-6xl', '3.75rem'); // 60px — hero heading
  });
});

describe("real usage compiles (the same arbitrary-value syntax ui-system.md's own snippets use)", () => {
  it('every surface, verdict, shadow, and motion token is reachable through a real Tailwind arbitrary-value class', () => {
    // These are the CSS-escaped selectors Tailwind actually emits for an
    // arbitrary-value class such as `bg-[var(--color-void)]` (which prints
    // as `.bg-\[var\(--color-void\)\]`) — asserted as literal substrings
    // rather than a constructed regex, since re-deriving the escaping
    // rules here would just be re-testing Tailwind's printer instead of
    // this project's tokens. NOTE: never write a shortened, truncated
    // arbitrary-value example anywhere in this project (comments, strings,
    // test names included) with a bracket-var pattern left incomplete —
    // Tailwind's content scanner text-scans everything it can reach,
    // tries to compile the truncated form literally, and emits a build
    // warning for the malformed candidate. Always spell out a real,
    // complete token name instead, as the list above does.
    for (const selector of [
      '.bg-\\[var\\(--color-void\\)\\]',
      '.text-\\[var\\(--color-verdict-pass\\)\\]',
      '.shadow-\\[var\\(--shadow-e2\\)\\]',
      '.ease-\\[var\\(--ease-fluid\\)\\]',
      '.duration-\\[var\\(--dur-fast\\)\\]',
    ]) {
      expect(compiled, `expected a generated rule for ${selector}`).toContain(selector);
    }
  });
});
