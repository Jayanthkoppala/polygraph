/**
 * The chaos fixture's HTTP server: a tiny static catalog site (12 products,
 * clean semantic HTML) that a `local`-adapter collector points at. Every
 * request re-reads the chaos mode from disk (`readChaosMode`) — there is no
 * in-memory mode cache — so `polygraph chaos <mode>` (which only writes the
 * switch file) takes effect on the very next request, with the server
 * already running. Always answers HTTP 200 for a known product route,
 * regardless of chaos mode: the entire point of this fixture is
 * structurally-wrong-but-200 data, never a 4xx/5xx (see docs/demo.md).
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { renderIndex, renderProductPage } from './render.js';
import { readChaosMode, DEFAULT_FIXTURE_STATE_PATH } from './state.js';

export interface FixtureServerOptions {
  /** Path to the chaos state switch file this server re-reads on every
   * request. Defaults to DEFAULT_FIXTURE_STATE_PATH. */
  statePath?: string;
}

const PRODUCT_PATH = /^\/products\/([^/?]+)\/?$/;

/** Builds the (unstarted) fixture `http.Server` — caller owns listen/close,
 * matching server.ts's own createServer contract. */
export function createFixtureServer(options: FixtureServerOptions = {}): Server {
  const statePath = options.statePath ?? DEFAULT_FIXTURE_STATE_PATH;

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderIndex());
      return;
    }

    const match = PRODUCT_PATH.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const requestedSku = decodeURIComponent(match[1]);
      const mode = readChaosMode(statePath);
      const html = renderProductPage(requestedSku, mode);

      if (html === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`no such product: ${requestedSku}`);
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}
