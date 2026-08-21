import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * Layer 2 of tenant-architecture.md §3's defence in depth: tenant SQL lives
 * only in explicit persistence owners. The Scoped* classes live under
 * src/tenancy/; Ledger/Governor/AlertNotifier/ScopedSafeOutput own their
 * own tables and are tenant-scoped internally by construction (§7).
 *
 * `grep '\.exec('` also matches RegExp.exec() calls, which is a known false
 * positive in this blunt pattern (matches the doc's own grep, verbatim) —
 * src/server.ts and src/fixture/server.ts are allowlisted for exactly that
 * reason, confirmed by inspection to contain no db.prepare/db.exec calls.
 */
describe('src/tenancy/ isolation — no hand-written SQL outside it', () => {
  it('no module outside the persistence-owner allowlist prepares its own SQL (Layer 2, tenant-architecture.md §3)', () => {
    const output = execSync(`grep -rlnE '\\.prepare\\(|\\.exec\\(' src/ --include='*.ts' || true`, {
      cwd: process.cwd(),
    })
      .toString()
      .trim();
    const offenders = (output.length > 0 ? output.split('\n') : [])
      .filter((f) => !f.startsWith('src/tenancy/'))
      // These modules own their tables and are scoped internally by
      // construction (§7); adding another file requires an explicit review.
      .filter((f) => !['src/ledger.ts', 'src/policy.ts', 'src/alerts.ts', 'src/safe-output.ts'].includes(f))
      // False positives from the blunt '\.exec(' pattern matching
      // RegExp.prototype.exec, not Database#exec. Neither file calls
      // db.prepare or db.exec.
      .filter((f) => !['src/server.ts', 'src/fixture/server.ts'].includes(f));

    expect(offenders).toEqual([]);
  });
});
