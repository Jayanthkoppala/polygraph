import type { Command } from 'commander';
import { Ledger } from '../store/ledger.js';
import { resolveDbPath } from './shared.js';

/** Registers `polygraph ledger` on the root program. */
export function register(program: Command): void {
  const ledgerCmd = program.command('ledger').description('Verification ledger operations');

  ledgerCmd
    .command('verify')
    .description('Verify the integrity of the ledger')
    .action(() => {
      const store = new Ledger(resolveDbPath());
      const result = store.verify();
      store.close();

      if (result.ok) {
        process.stdout.write(`ledger verify: OK — ${result.checked} event(s) verified, chain intact\n`);
        process.exitCode = 0;
      } else {
        process.stderr.write(
          `ledger verify: FAILED — tamper detected at event id ${result.firstBadId} (checked ${result.checked} event(s))\n`
        );
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // Hosted commands — tenant-architecture.md §7 rule 3: `serve` dynamically
  // loads the hosted auth/crypto graph. Local write commands share the
  // migration primitives through local-store.ts, but never load crypto, so
  // `polygraph demo` remains offline and needs no POLYGRAPH_MASTER_KEY. See
  // test/cli.clean-env.smoke.test.ts.
}
