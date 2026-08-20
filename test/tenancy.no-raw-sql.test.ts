import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * Layer 2 of tenant-architecture.md §3's defence in depth: no module outside
 * src/tenancy/ prepares its own SQL. All tenant-scoped statements live in
 * the Scoped* classes (scope.ts) and Ledger/Governor/AlertNotifier
 * themselves (which own their own tables and are tenant-scoped internally
 * by construction, per §7 — they're the allowlist).
 *
 * `grep '\.exec('` also matches RegExp.exec() calls, which is a known false
 * positive in this blunt pattern (matches the doc's own grep, verbatim) —
 * src/server.ts and src/fixture/server.ts are allowlisted for exactly that
 * reason, confirmed by inspection to contain no db.prepare/db.exec calls.
 */
describe('src/tenancy/ isolation — no hand-written SQL outside it', () => {
  it('no module outside src/tenancy prepares its own SQL (Layer 2, tenant-architecture.md §3)', () => {
    const output = execSync(`grep -rln 'db.prepare\\|\\.exec(' src/ --include='*.ts' || true`, {
      cwd: process.cwd(),
    })
      .toString()
      .trim();
    const offenders = (output.length > 0 ? output.split('\n') : [])
      .filter((f) => !f.startsWith('src/tenancy/'))
      // ledger.ts/policy.ts/alerts.ts own their tables; they are scoped
      // internally by construction (§7) and are the allowlist per the spec.
      .filter((f) => !['src/ledger.ts', 'src/policy.ts', 'src/alerts.ts'].includes(f))
      // False positives from the blunt '\.exec(' pattern matching
      // RegExp.prototype.exec, not Database#exec. Neither file calls
      // db.prepare or db.exec.
      .filter((f) => !['src/server.ts', 'src/fixture/server.ts'].includes(f));

    expect(offenders).toEqual([]);
  });
});
