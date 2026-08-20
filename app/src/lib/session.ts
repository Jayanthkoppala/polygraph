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
 *
 * THE OFFLINE DEMO IS NOT A TENANT. `polygraph demo` serves the same built
 * app from `src/server.ts`, which answers this route with the literal
 * sentinel `{ status: 'offline-demo' }` — it has no tenancy, no session and
 * no Bright Data key concept at all, and says so in its own comment. This
 * module used to flatten that to `'ready'`, which is a claim ("this tenant
 * is authenticated and has a key on file") that is simply not true of the
 * demo process. `'demo'` is therefore its own status: the client's model of
 * the session stays honest, and each route decides what to do with it
 * rather than inheriting a decision from a lossy mapping.
 */
/**
 * A 401 AND A TIMEOUT ARE NOT THE SAME ANSWER. This module used to collapse
 * every failure — a timeout, a 500, a malformed body, a transient blip —
 * into `'anonymous'`, and `AppGate` maps `'anonymous'` to
 * `<Navigate to="/">`. One flaky request therefore ejected a working,
 * authenticated session to the marketing page (observed live twice, with
 * the route answering normally before and after). A 401 is a real answer
 * ("you are not logged in"); a timeout is NO answer, and routing on it
 * asserts something the client does not know. The fail-closed instinct
 * stays — nothing here ever upgrades an unknown into a session — but
 * "could not determine" gets its own value, and the routes hold still and
 * offer a retry instead of throwing the user out.
 */
export type SessionStatus = 'anonymous' | 'keyless' | 'ready' | 'demo' | 'unknown';

/** The literal `status` string `src/server.ts`'s offline dashboard answers
 * with. Not a `TenantSecretStatus` value — a sentinel. */
const OFFLINE_DEMO_STATUS = 'offline-demo';

/** The session probe is on the critical path of every authenticated route:
 * until it resolves, `SessionLoading` is all the user has. An un-aborted
 * `fetch` against a hung server would leave that "checking session…" text
 * on screen forever, so the probe fails closed on a deadline instead. */
const SESSION_PROBE_TIMEOUT_MS = 8000;

/** Gap before the single retry. Short enough that a real user does not
 * notice it behind `SessionLoading`, long enough to clear a blip. */
const SESSION_PROBE_RETRY_MS = 400;

/**
 * Resolves to:
 * - `'anonymous'`  — no valid session cookie.
 * - `'keyless'`    — authenticated, but no Bright Data key saved yet.
 * - `'ready'`      — authenticated and keyed; the fleet dashboard applies.
 * - `'demo'`       — this is the offline `polygraph demo` server, which has
 *                    no session concept at all (see the module note).
 *
 * - `'unknown'`    — the probe could not answer (timeout, 5xx, unparseable
 *                    body). NEVER treated as a session, and never treated
 *                    as a logout either.
 *
 * Only a 401 produces `'anonymous'`. Everything else that fails is retried
 * once — the observed ejections were single transient failures with a
 * healthy route either side — and then reported as `'unknown'`.
 */
export async function fetchSessionStatus(): Promise<SessionStatus> {
  const first = await probeOnce();
  if (first !== 'unknown') return first;
  await new Promise((resolve) => setTimeout(resolve, SESSION_PROBE_RETRY_MS));
  return probeOnce();
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
