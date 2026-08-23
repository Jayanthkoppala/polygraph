/** Thin client for the onboarding routes: one function per route, no business logic,
 * every response read defensively so a reshaped body stays a local change. */
import { ApiError } from '@/lib/api';
import type { CollectorCandidate } from './machine';

/** Throws the response's own `error` field when it has one, else its statusText. */
async function throwApiError(res: Response): Promise<never> {
  let detail = res.statusText;
  try {
    const parsed = (await res.json()) as { error?: string };
    if (parsed?.error) detail = parsed.error;
  } catch {
    // Body wasn't JSON — keep statusText.
  }
  throw new ApiError(detail, res.status);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}

export interface GoogleAuthConfig {
  clientId: string;
}

/** Public, cache-safe configuration for Google Identity Services. */
export async function fetchGoogleAuthConfig(): Promise<GoogleAuthConfig> {
  const res = await fetch('/api/auth/google/config', { headers: { accept: 'application/json' } });
  if (!res.ok) await throwApiError(res);
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

/** POST /api/signup. `token` is a one-time credential, never a session: the caller
 * must NAVIGATE to `exchangeTokenUrl(token)` — the 302 is what sets the cookie. */
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

/** The one-time exchange link. Navigate to it (`window.location.assign`); never
 * `fetch` it — the redirect is what sets the session cookie. */
export function exchangeTokenUrl(token: string): string {
  return `/t/${encodeURIComponent(token)}`;
}

export interface SaveKeyResult {
  last4: string;
  collectors: CollectorCandidate[];
}

/** Best-effort `{id, name}` extraction from either collectors_list shape. Never
 * throws: an unrecognised shape degrades to `[]`, i.e. the calm fallback path. */
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

/** POST /api/settings/key. The two "calm, not an error" cases come back as a
 * discriminated result, so callers never string-match a message to pick a tone. */
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
      // 400 is a real key rejection, shown with the literal upstream message (§6).
      if (err.status === 400) return { kind: 'rejected', message: err.message };
      // 503 means the backend couldn't reach collectors_list AND did not save the
      // key. Presented as the calm fallback per §6, never as an error banner.
      if (err.status === 503) return { kind: 'list-unavailable' };
    }
    throw err;
  }
}

/** A fresh server-side inventory check. This deliberately uses the encrypted
 * tenant key; the browser never receives it again after the initial save. */
export async function listAvailableCollectors(): Promise<CollectorCandidate[]> {
  const res = await fetch('/api/collectors/available', { headers: { accept: 'application/json' } });
  if (!res.ok) await throwApiError(res);
  const body = (await res.json()) as { collectors?: unknown };
  return asCollectorCandidates(body.collectors);
}

export interface ConnectedCollector {
  id: string;
  name: string;
  scheduleOwner: 'brightdata';
  autoHeal: false;
  deliveryUrl: string;
}

/** Connects one collector from its published Bright Data output schema. No
 * schedule or inputs are sent: Bright Data stays the run source, auto-heal off. */
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

/** POST /api/collectors — the draft row infer/probe/confirm run against.
 * `canaryInputs` come from the user; collectors_list carries no sample inputs. */
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

/** POST /api/collectors/:id/infer — field names read from collectors_list's
 * `output_schema`, before any live probe. */
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

/** One row of the schema-confirm table. §6's mockup shows "FILLED 98%" but the probe
 * returns no fill rate, so `everFilled` stands in rather than a fabricated number. */
export interface ProbeFieldDraft {
  name: string;
  type: string;
  sample: unknown;
  defaultValue?: unknown;
  /** True when no empty-like value was observed for this field in the probe.
   * Pre-ticks "required" — the stand-in for the spec's "≥95% filled" rule. */
  everFilled: boolean;
}

export interface ProbeDraft {
  fields: ProbeFieldDraft[];
  /** Zero rows came back at all. The caller routes this to
   * `COLLECTOR_SKIPPED_EMPTY` (§6: continue, don't block), never to a table. */
  empty: boolean;
}

/** POST /api/collectors/:id/probe — runs the collector once, live. Consent is
 * always true: the key-paste screen's "what we call" list already said so. */
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

/** POST /api/collectors/:id/confirm. `entityKey` is the ROW FIELD NAME to match the
 * input ("sku"); `null` skips identity. The rule is always `input_equals_field`. */
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
