/** Scans `src/landing/**` source, not a rendered DOM (some sections mount only
 * conditionally), for fabricated proof. `// honesty:` is the only escape hatch. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = path.resolve(THIS_DIR, '../../src/landing'); // tests/ mirrors src/

/** Node 20 has no `fs.globSync` (22+ only); a walk avoids a glob dependency. */
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
          // Skip comments: a doc comment quoting ux-spec.md's "no testimonials"
          // ruling is the honesty pass working. Only JSX text reaches a reader.
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
    // Must be real JSX text, not a code comment — the gap Task 10a called out.
    const jsxTextDisclosure = /<p[^>]*>\s*Runs entirely in your browser/;
    expect(sandboxPanel).toMatch(jsxTextDisclosure);
  });
});
