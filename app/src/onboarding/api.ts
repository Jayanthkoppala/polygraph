/**
 * Thin client for the onboarding wizard endpoints, built against
 * src/tenancy/http-routes.ts's SHAPE as of this writing (Task 4 was still
 * building the surrounding `serve` command concurrently — see this task's
 * brief). Kept deliberately thin/dumb: every function is a one-to-one
 * mirror of one route, no business logic, so re-pointing at a renamed
 * route or a reshaped response body is a small, local change.
 *
 * Two known gaps against the current backend, both flagged to the Task 4/
 * onboarding-backend owners (not fixed here — outside this task's file
 * ownership):
 *
 *   1. POST /api/settings/key's handler computes but discards
 *      `collectorsListResponse` (see key-verification.ts's
 *      `saveVerifiedTenantKey`) — it currently responds with only
 *      `{ status }`. `saveApiKey` below reads an OPTIONAL `collectors`
 *      field defensively; until the route is updated to include it, every
 *      real account will take the same path as ux-spec.md §6's "your
 *      account doesn't expose the collector list" case, even on success.
 *      Not a crash, not a lie — just the fallback screen more often than
 *      the spec intends until that route change lands.
 *   2. `saveVerifiedTenantKey` classifies ANY non-401 failure calling
 *      `collectors_list` (a real 403-gated account, a timeout, a genuine
 *      5xx) as `TenantKeyVerificationUnavailableError` (503) and does NOT
 *      save the key. ux-spec.md §6 describes 403-gated accounts as a
 *      "known possibility" that should fall back calmly (implying the key
 *      itself is fine and gets saved) — the current backend can't
 *      distinguish "key is fine, list is gated" from "Bright Data is
 *      down," and saves neither. This module treats a 503 here as the
 *      calm fallback (never as a scary error, per §6's letter), but the
 *      underlying "was the key actually saved?" question needs a backend
 *      answer this client cannot give on its own.
 */
import { ApiError } from '@/lib/api';
import type { CollectorCandidate } from './machine';

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new ApiError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

export interface GoogleAuthConfig {
  clientId: string;
}

/** Public, cache-safe configuration for Google Identity Services. */
export async function fetchGoogleAuthConfig(): Promise<GoogleAuthConfig> {
  const res = await fetch('/api/auth/google/config', { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      // Keep statusText.
    }
    throw new ApiError(detail, res.status);
  }
  const body = (await res.json()) as { client_id?: unknown };
  if (typeof body.client_id !== 'string' || body.client_id.trim() === '') {
    throw new ApiError('Google sign-in is not configured', 503);
  }
  return { clientId: body.client_id };
}

/** Exchanges the signed GIS credential for Polygraph's HttpOnly session. */
export async function loginWithGoogleCredential(credential: string): Promise<void> {
  await postJson('/api/auth/google', { credential });
}

/** POST /api/signup -> { token, tenant_id }. The token is a one-time
 * magic-link credential, never a session by itself — the caller must
 * navigate to `exchangeTokenUrl(token)` (a real browser navigation, not a
 * fetch, since it's how the httpOnly session cookie gets set via a 302 —
 * see src/tenancy/auth.ts `exchangeTokenForSession`). */
export interface SignupResult {
  token: string;
  tenantId: string;
}

export async function signup(fleetName: string, recoveryEmail?: string): Promise<SignupResult> {
  const body: { fleet_name: string; recovery_email?: string } = { fleet_name: fleetName };
  if (recoveryEmail) body.recovery_email = recoveryEmail;
  const result = await postJson<{ token: string; tenant_id: string }>('/api/signup', body);
  return { token: result.token, tenantId: result.tenant_id };
}

/** The one-time exchange link. Callers navigate the browser here
 * (`window.location.assign`), they never `fetch` it — it's a redirect that
 * sets the session cookie. */
export function exchangeTokenUrl(token: string): string {
  return `/t/${encodeURIComponent(token)}`;
}

export interface SaveKeyResult {
  last4: string;
  collectors: CollectorCandidate[];
}

/** Best-effort extraction of `{id, name}` pairs from whatever shape a raw
 * Bright Data `collectors_list` (or an already-shaped `{id,name}[]`)
 * arrives as. Never throws — an unrecognised shape degrades to `[]`, which
 * this wizard already treats identically to the calm fallback path. */
function asCollectorCandidates(value: unknown): CollectorCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: CollectorCandidate[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.id ?? rec.collector_id;
    if (typeof id !== 'string' || id.trim() === '') continue;
    const name = rec.name ?? rec.collector_name ?? id;
    out.push({ id, name: typeof name === 'string' ? name : id });
  }
  return out;
}

/**
 * POST /api/settings/key. Never rejects with the raw ApiError for the two
 * "calm, not an error" cases — those come back as a discriminated result so
 * `KeyPasteStep` never has to string-match a message to decide the tone.
 *
 * As of `258a5fc` the route responds with
 * `{ status: TenantSecretStatus, collectors: CollectorSummary[] }`
 * (secrets.ts's `TenantSecretStatus.key_last4`, infer-schema.ts's
 * `summarizeCollectorsList`) — read defensively (`last4` as a fallback
 * alias, and `apiKey.slice(-4)` as a last resort) so this client degrades
 * gracefully rather than breaking if either shape drifts again.
 */
export type SaveKeyOutcome =
  | { kind: 'verified'; last4: string; collectors: CollectorCandidate[] }
  | { kind: 'rejected'; message: string }
  | { kind: 'list-unavailable' };

export async function saveApiKey(apiKey: string): Promise<SaveKeyOutcome> {
  try {
    const result = await postJson<{ status?: { key_last4?: string; last4?: string }; collectors?: unknown }>(
      '/api/settings/key',
      { api_key: apiKey },
    );
    return {
      kind: 'verified',
      last4: result.status?.key_last4 ?? result.status?.last4 ?? apiKey.slice(-4),
      collectors: asCollectorCandidates(result.collectors),
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 400) {
        // InvalidApiKeyFormatError or TenantKeyRejectedError — a real
        // rejection, shown with the literal upstream message (§6).
        return { kind: 'rejected', message: err.message };
      }
      if (err.status === 503) {
        // See gap (2) in the module doc — treated as the calm fallback,
        // never as an error banner.
        return { kind: 'list-unavailable' };
      }
    }
    throw err;
  }
}

export interface ConnectedCollector {
  id: string;
  name: string;
  scheduleOwner: 'brightdata';
  autoHeal: false;
  deliveryUrl: string;
}

/**
 * Connects one collector using its published Bright Data output schema.
 * Polygraph deliberately supplies no schedule or representative inputs:
 * Bright Data remains the run source and customer auto-heal remains off.
 */
export async function connectCollector(collectorId: string): Promise<ConnectedCollector> {
  const result = await postJson<{
    collector: { collector_id: string; name: string };
    schedule_owner: 'brightdata';
    auto_heal: false;
    delivery: { mode: 'webhook'; format: 'json'; url: string };
  }>('/api/collectors/connect', { collector_id: collectorId });
  return {
    id: result.collector.collector_id,
    name: result.collector.name,
    scheduleOwner: result.schedule_owner,
    autoHeal: result.auto_heal,
    deliveryUrl: result.delivery.url,
  };
}

/** POST /api/collectors — creates the draft row a collector's infer/probe/
 * confirm calls need to exist against. `canaryInputs` are the trigger
 * inputs (URLs/IDs) the probe re-fetches to prove identity/coherence —
 * supplied by the user at schema-confirm time, since Bright Data's
 * collectors_list response carries no sample inputs of its own. */
export async function createCollectorDraft(input: {
  collectorId: string;
  name: string;
  canaryInputs: string[];
}): Promise<void> {
  await postJson('/api/collectors', {
    collector_id: input.collectorId,
    name: input.name,
    canary_inputs: input.canaryInputs,
  });
}

/** POST /api/collectors/:id/infer -> field names guessed from Bright
 * Data's own collectors_list `output_schema`, before any live probe. */
export interface InferredField {
  fieldNames: string[];
}

export async function inferCollectorSchema(collectorId: string): Promise<InferredField> {
  const result = await postJson<{ inferred: { fieldNames: string[] } }>(
    `/api/collectors/${encodeURIComponent(collectorId)}/infer`,
    {},
  );
  return { fieldNames: result.inferred.fieldNames ?? [] };
}

/**
 * One row of the schema-confirm table. IMPORTANT DEVIATION FROM THE MOCKUP:
 * ux-spec.md §6 shows a "FILLED 98%" percentage column. `probe.ts`'s
 * `buildProbeDraft` — the actual function behind this endpoint — does not
 * compute or return any per-field fill-rate percentage; it only derives
 * `type` / `sample` / `default_value` from the single probe run
 * (src/tenancy/probe.ts, and the route only ever forwards `.draft`, never
 * the raw row count — see `http-routes.ts`'s probe handler). Inventing a
 * percentage here would violate this task's own "never fabricate data"
 * constraint, so this client exposes what's actually true instead:
 * `everFilled` (no empty-like value was observed for this field across the
 * probe) is the honest analogue of "high fill rate" and drives the same
 * pre-tick-required behaviour the spec wants, without a fake number.
 * Flagged to the backend owners as a real gap between the spec and
 * `buildProbeDraft`'s shape — see this task's report.
 */
export interface ProbeFieldDraft {
  name: string;
  type: string;
  sample: unknown;
  defaultValue?: unknown;
  /** True when no empty-like value (`''`, `0`, `[]`, `null`) was observed
   * for this field in the probe. Pre-ticks "required" — the honest stand-in
   * for the spec's "≥95% filled" rule, since no percentage exists to
   * threshold against. */
  everFilled: boolean;
}

export interface ProbeDraft {
  fields: ProbeFieldDraft[];
  /** True when the probe returned zero rows at all — the caller
   * (SchemaConfirmStep) routes this to `COLLECTOR_SKIPPED_EMPTY`
   * (ux-spec.md §6: "If a collector returns zero rows on this pass, it
   * goes to NOT VERIFIED... and onboarding continues"), never to a
   * fabricated table. */
  empty: boolean;
}

/** POST /api/collectors/:id/probe { consent: true } — runs the collector
 * once, live, and returns per-field type/sample/default_value derived from
 * that run. Consent is always sent explicit and true from this wizard: the
 * user reaching this screen already agreed (via the key-paste screen's
 * "what we call" list) that a probe run happens as part of setup. */
export async function probeCollectorLive(collectorId: string): Promise<ProbeDraft> {
  const result = await postJson<{
    draft: Record<string, { type?: string; sample?: unknown; default_value?: unknown }>;
  }>(`/api/collectors/${encodeURIComponent(collectorId)}/probe`, { consent: true });

  const entries = Object.entries(result.draft ?? {});
  const fields: ProbeFieldDraft[] = entries.map(([name, f]) => ({
    name,
    type: typeof f.type === 'string' ? f.type : 'string',
    sample: f.sample,
    defaultValue: f.default_value,
    everFilled: f.default_value === undefined,
  }));
  return { fields, empty: fields.length === 0 };
}

export interface ConfirmedFieldInput {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
}

/** POST /api/collectors/:id/confirm — persists the final schema + entity
 * key. `entityKey` is the ROW FIELD NAME to compare against the input
 * (e.g. "sku"), per `src/tenancy/onboarding.ts`'s `ConfirmedSetup`;
 * `null` means "don't check identity for this collector", an explicit,
 * deliberate choice this wizard always surfaces rather than defaulting
 * silently. The rule sent alongside it is always `input_equals_field` —
 * "the raw trigger input IS the expected key" (entity-key.ts) — the only
 * rule that needs no extra input from the user; `url_path_segment` would
 * require asking which path segment, which this wizard doesn't collect. */
export async function confirmCollectorSchema(
  collectorId: string,
  fields: ConfirmedFieldInput[],
  entityKey: string | null,
): Promise<void> {
  await postJson(`/api/collectors/${encodeURIComponent(collectorId)}/confirm`, {
    fields: fields.map((f) => ({ name: f.name, type: f.type, required: f.required, default_value: f.defaultValue })),
    entity_key: entityKey,
    entity_key_rule: entityKey ? { kind: 'input_equals_field' } : null,
  });
}

export { ApiError };
