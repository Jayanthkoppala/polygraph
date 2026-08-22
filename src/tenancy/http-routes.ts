import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, RequestBodyTooLargeError } from '../http/server.js';
import { serveStaticOrSpa } from '../http/static.js';
import { createSession } from './auth.js';
import type { RouteContext, TenantServerDeps } from './routes/context.js';
import { applySecurityHeaders, loadTenantRow, requireSession } from './routes/context.js';
import { handlePublicRoutes } from './routes/public.js';
import { handleSessionRoutes } from './routes/session.js';
export type { TenantServerDeps };

/**
 * The hosted server's request dispatcher: public routes, then the session
 * gate, then session routes, then the SPA. Each group lives in its own
 * module under `routes/` and answers whether it handled the request.
 */
export async function handleTenantRequest(req: IncomingMessage, res: ServerResponse, deps: TenantServerDeps): Promise<void> {
  applySecurityHeaders(res);
  const nowFn = deps.now ?? (() => new Date().toISOString());

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: RouteContext = { req, res, deps, method: req.method ?? 'GET', url, path: url.pathname, nowFn };

    if (await handlePublicRoutes(ctx)) return;

    if (ctx.path.startsWith('/api/')) {
      const session = requireSession(deps.writer, req, res);
      if (!session) return;

      const tenantRowWriter = loadTenantRow(deps.writer, session.tenantId);
      if (!tenantRowWriter) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }

      // The `/api/` prefix is terminal: `handleSessionRoutes` answers every
      // path under it, 404-ing the ones it does not recognise, so an API
      // request never falls through to the SPA below.
      await handleSessionRoutes(ctx, session, tenantRowWriter);
      return;
    }

    if (ctx.method === 'GET') {
      await serveStaticOrSpa(ctx.path, deps.webDir, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tenancy/serve] request handler error: ${message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal server error' });
    } else {
      res.end();
    }
  }
}

// Re-exported so serve.ts / tests only need to import from this module.
export { createSession };
