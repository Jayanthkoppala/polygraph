// Routing's session signal, probed via `GET /api/settings/key/status` — no dedicated
// login endpoint exists, and this one 401s and reports key state in a single call.

// A 401 and a timeout are NOT the same answer: collapsing every failure into
// `'anonymous'` ejected live authenticated sessions to the landing page.
export type SessionStatus = 'anonymous' | 'keyless' | 'ready' | 'demo' | 'unknown';

/** Sentinel `status` from `src/server.ts`'s offline dashboard, which has no tenancy
 *  at all — not a `TenantSecretStatus` value, hence its own `'demo'` status. */
const OFFLINE_DEMO_STATUS = 'offline-demo';

/** The probe blocks every authenticated route behind `SessionLoading`, so a hung
 *  server must not pin that text on screen forever. */
const SESSION_PROBE_TIMEOUT_MS = 8000;

/** Gap before the single retry: unnoticeable behind `SessionLoading`, long
 *  enough to clear a transient blip. */
const SESSION_PROBE_RETRY_MS = 400;

/** Only a 401 produces `'anonymous'`; every other failure is retried once and then
 *  reported as `'unknown'`, which is neither a session nor a logout. */
export async function fetchSessionStatus(): Promise<SessionStatus> {
  const first = await probeOnce();
  if (first !== 'unknown') return first;
  await new Promise((resolve) => setTimeout(resolve, SESSION_PROBE_RETRY_MS));
  return probeOnce();
}

/** Ends only this browser session. The server clears the HttpOnly cookie and
 * deletes its matching hashed session row before we navigate away. */
export async function signOut(): Promise<void> {
  const res = await fetch('/api/logout', {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Could not sign out');
}

async function probeOnce(): Promise<SessionStatus> {
  let res: Response;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), SESSION_PROBE_TIMEOUT_MS) : null;
  try {
    res = await fetch('/api/settings/key/status', {
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    return 'unknown';
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  // The only authoritative "you are not logged in" this route can give.
  if (res.status === 401) return 'anonymous';
  if (!res.ok) return 'unknown';
  try {
    const body = (await res.json()) as { status?: unknown };
    if (body.status === OFFLINE_DEMO_STATUS) return 'demo';
    return body.status === null || body.status === undefined ? 'keyless' : 'ready';
  } catch {
    return 'unknown';
  }
}
