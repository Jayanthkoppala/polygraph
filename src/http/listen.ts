import type { Server } from 'node:http';

/**
 * Starts `server` and resolves once it is listening. A bind failure — port
 * already in use, address not assignable — rejects instead of leaving the
 * caller awaiting forever, which is what every command and the hosted
 * `serve` bootstrap want, so the one-shot `error` listener lives here rather
 * than being re-spelled at each call site.
 */
export function listenAsync(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}
