/**
 * Session status — the one client-side signal routing needs to decide
 * between "show the landing page", "resume onboarding at key-paste", and
 * "show the fleet dashboard".
 *
 * There is no dedicated "am I logged in" endpoint. `GET
 * /api/settings/key/status` already exists (src/tenancy/http-routes.ts) and
 * is the smallest route that answers both questions at once: it 401s with
 * no session cookie, and returns `{ status: null }` for a session that has
 * no Bright Data key on file yet (a tenant who just landed via the `/t/:token`
 * exchange redirect and hasn't pasted a key). Reusing it here avoids adding
 * a route to `src/**`, which this task does not own.
 */
export type SessionStatus = 'anonymous' | 'keyless' | 'ready';

/**
 * Resolves to:
 * - `'anonymous'`  — no valid session cookie.
 * - `'keyless'`    — authenticated, but no Bright Data key saved yet.
 * - `'ready'`      — authenticated and keyed; the fleet dashboard applies.
 *
 * Fails closed to `'anonymous'` on any non-401 error (a timeout, a 500, a
 * malformed body) rather than risk routing someone into a screen that
 * assumes a session that might not actually be there.
 */
export async function fetchSessionStatus(): Promise<SessionStatus> {
  let res: Response;
  try {
    res = await fetch('/api/settings/key/status', { headers: { accept: 'application/json' } });
  } catch {
    return 'anonymous';
  }
  if (res.status === 401) return 'anonymous';
  if (!res.ok) return 'anonymous';
  try {
    const body = (await res.json()) as { status?: unknown };
    return body.status === null || body.status === undefined ? 'keyless' : 'ready';
  } catch {
    return 'anonymous';
  }
}
