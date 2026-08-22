import type { Command } from 'commander';
import { resolveDbPath } from './shared.js';

/** Registers `polygraph migrate` on the root program. */
export function register(program: Command): void {
  program
    .command('migrate')
    .description('Run the hosted database migration against a local database — safe to run repeatedly')
    .action(async () => {
      try {
        const { openWriter } = await import('../tenancy/db.js');
        const { migrate: runMigrate } = await import('../tenancy/migrate.js');
        const dbPath = resolveDbPath();
        const db = openWriter(dbPath);
        runMigrate(db, dbPath);
        db.close();
        process.stdout.write(`polygraph migrate: ${dbPath} is up to date\n`);
      } catch (err) {
        process.stderr.write(`polygraph migrate: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
