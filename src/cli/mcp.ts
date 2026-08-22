import type { Command } from 'commander';


/** Registers `polygraph mcp` on the root program. */
export function register(program: Command): void {
  program
    .command('mcp')
    .description('Serve Polygraph tools to a local coding agent over MCP stdio')
    .action(async () => {
      try {
        // Dynamic import keeps MCP and the hosted tenancy graph out of every
        // ordinary CLI command. Never write a startup banner to stdout: that
        // stream belongs exclusively to JSON-RPC while this command is alive.
        const { createLocalPolygraphMcpOperations, servePolygraphMcp } = await import('../mcp.js');
        await servePolygraphMcp(createLocalPolygraphMcpOperations(), {
          allowNetworkRuns: process.env.POLYGRAPH_MCP_ALLOW_NETWORK === '1',
        });
      } catch (err) {
        process.stderr.write(`polygraph mcp: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
}
