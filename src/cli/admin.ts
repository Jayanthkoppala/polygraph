import type { Command } from 'commander';
import { resolveDbPath } from './shared.js';

/** Registers `polygraph admin` on the root program. */
export function register(program: Command): void {
  const adminCmd = program.command('admin').description('Hosted administration commands');

  adminCmd
    .command('rekey')
    .description(
      'Re-encrypt every tenant Bright Data key from POLYGRAPH_MASTER_KEY_PREVIOUS to POLYGRAPH_MASTER_KEY (master-key rotation, tenant-architecture.md §2)'
    )
    .action(async () => {
      try {
        const { openWriter } = await import('../tenancy/db.js');
        const { migrate: runMigrate } = await import('../tenancy/migrate.js');
        const { loadMasterKey, loadPreviousMasterKey } = await import('../tenancy/crypto.js');
        const { rekeyTenantSecrets } = await import('../tenancy/admin.js');

        const dbPath = resolveDbPath();
        const db = openWriter(dbPath);
        runMigrate(db, dbPath);

        const masterKey = loadMasterKey();
        const previousMasterKey = loadPreviousMasterKey();
        if (!previousMasterKey) {
          process.stderr.write(
            'polygraph admin rekey: POLYGRAPH_MASTER_KEY_PREVIOUS is not set — nothing to rotate from\n'
          );
          process.exitCode = 1;
          db.close();
          return;
        }

        const { rotated, unreadable } = rekeyTenantSecrets(db, masterKey, previousMasterKey);
        db.close();
        process.stdout.write(
          `polygraph admin rekey: rotated ${rotated} tenant secret(s)` +
            (unreadable > 0 ? `, ${unreadable} unreadable under either key (marked 'unreadable')\n` : '\n')
        );
        if (unreadable > 0) process.exitCode = 1;
      } catch (err) {
        process.stderr.write(`polygraph admin rekey: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  adminCmd
    .command('set-public <tenant-id> <on-or-off>')
    .description('Mark (or unmark) a tenant as the public read-only showcase (tenant-architecture.md §1)')
    .action(async (tenantId: string, onOrOff: string) => {
      try {
        if (onOrOff !== 'on' && onOrOff !== 'off') {
          process.stderr.write('polygraph admin set-public: second argument must be "on" or "off"\n');
          process.exitCode = 1;
          return;
        }
        const { openWriter } = await import('../tenancy/db.js');
        const { migrate: runMigrate } = await import('../tenancy/migrate.js');
        const { setTenantPublic } = await import('../tenancy/admin.js');
        const dbPath = resolveDbPath();
        const db = openWriter(dbPath);
        runMigrate(db, dbPath);

        const { changed } = setTenantPublic(db, tenantId, onOrOff === 'on');
        db.close();

        if (!changed) {
          process.stderr.write(`polygraph admin set-public: no tenant with id "${tenantId}"\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`polygraph admin set-public: ${tenantId} is now ${onOrOff === 'on' ? 'the public showcase' : 'private'}\n`);
      } catch (err) {
        process.stderr.write(`polygraph admin set-public: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
