import type { Command } from 'commander';


/** Registers `polygraph serve` on the root program. */
export function register(program: Command): void {
  program
    .command('serve')
    .description('Run the hosted multi-tenant server (requires POLYGRAPH_MASTER_KEY)')
    .option('-p, --port <port>', 'HTTP port (default 8080, or PORT env)')
    .option('--host <address>', 'bind address (default 0.0.0.0)')
    .action(async (opts: { port?: string; host?: string }) => {
      try {
        const { startServer, MasterKeyMismatchError } = await import('../tenancy/serve.js');
        const running = await startServer({
          port: opts.port ? Number.parseInt(opts.port, 10) : undefined,
          host: opts.host,
        });
        process.stdout.write(`polygraph serve: listening on http://${running.host}:${running.port}\n`);

        const shutdown = () => {
          process.stdout.write('\npolygraph serve: shutting down\n');
          void running.stop().then(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Re-exported purely so `MasterKeyMismatchError` stays reachable for
        // anyone importing this module's action in a test — the catch block
        // below is what actually handles it at runtime.
        void MasterKeyMismatchError;
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
