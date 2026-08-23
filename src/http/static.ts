/**
 * Static/SPA file serving for a built React app directory (`app/dist`).
 *
 * Deliberately dependency-free beyond `node:fs`/`node:path`/`node:http` — no
 * tenancy, no crypto, nothing that would make importing this module pull in
 * `src/tenancy/crypto.js`. R9 (docs/plans/polygraph-v2-hosted-plan.md,
 * tenant-architecture.md §7 rule 3, test/cli.clean-env.smoke.test.ts) requires
 * `polygraph run`/`watch`/`demo` to never load the crypto module, so this
 * helper lives outside `src/tenancy/**` specifically so BOTH `src/server.ts`
 * (the offline CLI dashboard, used by `demo`/`watch`) and
 * `src/tenancy/http-routes.ts` (the hosted `serve` command) can import the
 * exact same static-serving logic without either one dragging the other's
 * dependencies in.
 */
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import type { ServerResponse } from 'node:http';

export const EXT_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export const APP_NOT_BUILT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Polygraph</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40em; margin: 4em auto; line-height: 1.5;">
<h1>Polygraph is running</h1>
<p>The API is up, but the web app hasn't been built yet on this machine.</p>
<p>Run <code>cd app &amp;&amp; npm run build</code>, then reload this page.</p>
</body></html>`;

/** True when `dir` looks like a real built app directory (has an
 * `index.html`) — the one check every caller needs before deciding whether
 * to serve from it at all. */
export function hasBuiltApp(dir: string | undefined): dir is string {
  return !!dir && existsSync(join(dir, 'index.html'));
}

/**
 * Serves a built SPA out of `webDir`: a real static asset when `pathname`
 * resolves to one inside `webDir`, otherwise the SPA shell (`index.html`) so
 * client-side routing (`/app`, deep links) always gets something
 * real to mount into. Never crashes when `webDir` is missing or unbuilt — a
 * fresh clone that hasn't run `cd app && npm run build` yet still gets a
 * clear, working response instead of an error or a blank page.
 */
export async function serveStaticOrSpa(pathname: string, webDir: string | undefined, res: ServerResponse): Promise<void> {
  if (!hasBuiltApp(webDir)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP_NOT_BUILT_HTML);
    return;
  }

  if (pathname !== '/' && pathname !== '/app') {
    const safeRel = normalize(pathname).replace(/^([.][.][/\\])+/, '');
    const candidate = join(webDir, safeRel);
    // Path-traversal guard: only ever serve a file that resolves INSIDE
    // webDir. A crafted `../../etc/passwd`-style pathname falls through to
    // the SPA shell below instead of erroring — matches this codebase's
    // "never crash on a malformed request" posture.
    if (candidate.startsWith(webDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const ext = extname(candidate);
      const body = await readFile(candidate);
      res.writeHead(200, {
        'content-type': EXT_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'content-length': body.length,
      });
      res.end(body);
      return;
    }
  }

  const html = await readFile(join(webDir, 'index.html'), 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}
