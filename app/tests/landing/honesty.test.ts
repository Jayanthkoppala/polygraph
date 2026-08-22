/**
 * Static source scan over the landing surface's own copy — Task 10a's
 * honesty pass, kept as a running assertion rather than a one-time manual
 * check. This product's whole thesis is that impressive-looking output can
 * be silently wrong, so anything invented on our own marketing page is
 * self-refuting: no fabricated metrics, no fake logos, no testimonials, no
 * "trusted by", no uptime/accuracy number the code can't actually compute.
 *
 * Reads the real `.tsx` source files under `src/landing/**` (not a rendered
 * DOM — several sections only mount conditionally, e.g. `FleetScale`'s
 * WebGL branch) and asserts none of the banned patterns appear as literal
 * text content. A `// honesty:` comment explaining why a match is a false
 * positive is the only escape hatch, so a real new violation can't hide
 * behind an allowlist regex silently drifting.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = path.resolve(THIS_DIR, '../../src/landing'); // tests/ mirrors src/

/** Node 20 (this project's runtime) has no `fs.globSync` (Node 22+ only) —
 * a plain recursive walk avoids adding a glob dependency for one test file. */
function landingFiles(dir: string = LANDING_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...landingFiles(full));
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /trusted by/i, why: 'no "trusted by" logo wall — no customers to name yet' },
  { pattern: /testimonial/i, why: 'no testimonials — nothing to quote yet' },
  { pattern: /\b\d+(\.\d+)?%\s*(uptime|accura(te|cy))/i, why: 'no uptime/accuracy percentage the code can compute' },
  { pattern: /\bFortune\s*500\b/i, why: 'no enterprise-logo claim' },
  { pattern: /\bas seen (in|on)\b/i, why: 'no press-mention claim' },
  { pattern: /\bbacked by\b/i, why: 'no investor/backer claim on the product page' },
  { pattern: /★{2,}|\brated\s+\d(\.\d)?\s*(\/|out of)\s*5\b/i, why: 'no star rating — nothing rates this product yet' },
  { pattern: /\b\d[\d,]*\+?\s*(customers|companies|users|teams)\b/i, why: 'no customer-count claim' },
];

describe('landing page honesty pass (Task 10a)', () => {
  const files = landingFiles();

  it('found landing source files to scan (a broken glob would silently pass everything)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const rel = path.relative(LANDING_DIR, file);
    it(`${rel} carries no fabricated-proof claim`, () => {
      const source = readFileSync(file, 'utf8');
      for (const { pattern, why } of BANNED) {
        const lines = source.split('\n');
        lines.forEach((line, i) => {
          const trimmed = line.trim();
          // Skip comment lines (`//...`, `/**`, ` * ...`) — a doc comment
          // that explains what NOT to build (as several of these files
          // have, verbatim quoting ux-spec.md's own "no testimonials"
          // rulings) is the honesty pass working, not violating it. Real
          // JSX text content is what a reader actually sees.
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
          if (!isComment && pattern.test(line) && !line.includes('honesty:')) {
            expect.fail(`${rel}:${i + 1} matches banned pattern ${pattern} (${why}):\n  ${line.trim()}`);
          }
        });
      }
    });
  }

  it('the sandbox is disclosed as client-side somewhere a reader actually sees it', () => {
    const sandboxPanel = readFileSync(path.join(LANDING_DIR, 'sandbox/SandboxPanel.tsx'), 'utf8');
    // Must be real JSX text content, not just a code comment — a comment
    // alone is exactly the gap Task 10a's brief called out.
    const jsxTextDisclosure = /<p[^>]*>\s*Runs entirely in your browser/;
    expect(sandboxPanel).toMatch(jsxTextDisclosure);
  });
});
