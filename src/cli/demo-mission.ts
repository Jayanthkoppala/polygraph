import type { Command } from 'commander';


/** Registers `polygraph demo-mission` on the root program. */
export function register(program: Command): void {
  program
    .command('demo-mission')
    .description('Serve the live-gated V1 → V2 demo mission (requires POLYGRAPH_DEMO_LIVE=1 and all demo env vars)')
    .option('-p, --port <port>', 'HTTP port (default 4171)', '4171')
    .option('--host <address>', 'bind address (default 127.0.0.1)', '127.0.0.1')
    .action(async (opts: { port?: string; host?: string }) => {
      const { createDemoMissionServer, readDemoMissionConfig } = await import('../demo/server.js');
      if (!readDemoMissionConfig()) {
        process.stderr.write('polygraph demo-mission: set POLYGRAPH_DEMO_LIVE=1 plus all POLYGRAPH_DEMO_* and BRIGHTDATA_API_KEY variables\n');
        process.exitCode = 1;
        return;
      }
      const port = Number.parseInt(opts.port ?? '4171', 10) || 4171;
      const host = opts.host ?? '127.0.0.1';
      const server = createDemoMissionServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      process.stdout.write(`polygraph demo-mission: listening on http://${host}:${port}\n`);
      const shutdown = () => server.close(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
