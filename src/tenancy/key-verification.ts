/**
 * Live Bright Data key verification at save time — carried ruling from
 * Task 2 into this task: "implement live Bright Data key verification at
 * save time here, since this task already calls their API — a saved key
 * that turns out to be invalid must fail fast and legibly during
 * onboarding, not silently produce 'Not checked' cards later."
 *
 * Implements tenant-architecture.md §2 "Validation at save time" exactly:
 *   1. Reject anything not matching the key-shape regex BEFORE touching
 *      crypto or the network at all.
 *   2. Verify it works: `GET /dca/collectors_list` with the key. A 401 ->
 *      the key is wrong, nothing stored. A 5xx/network failure -> Bright
 *      Data is unreachable right now, nothing stored either way. This
 *      doubles as step 1 of onboarding (§4) — the collectors_list response
 *      is returned to the caller so `infer-schema.ts` can read it directly,
 *      with no second network request.
 *   3. Only on success: encrypt + upsert via `ScopedSecrets.save()`.
 */
import { BrightDataClient, BrightDataError, type SleepFn } from '../brightdata.js';
import { InvalidApiKeyFormatError, KEY_FORMAT, type ScopedSecrets, type TenantSecretStatus } from './secrets.js';

export class TenantKeyRejectedError extends Error {
  constructor() {
    super('Bright Data rejected this key');
    this.name = 'TenantKeyRejectedError';
  }
}

export class TenantKeyVerificationUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Bright Data was unreachable while verifying this key — nothing was stored');
    this.name = 'TenantKeyVerificationUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

export interface VerifiedKeySave {
  status: TenantSecretStatus;
  /** The raw `GET /dca/collectors_list` body from the SAME call that
   * verified the key — pass straight to `infer-schema.ts`'s
   * `inferFieldsForCollector` so onboarding's INFER step never makes a
   * second request for it. */
  collectorsListResponse: unknown;
}

export interface SaveVerifiedTenantKeyOptions {
  /** Injectable fetch implementation, for tests — never hits the network. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Passed straight through to `BrightDataClient` — lets tests use an
   * instant `sleep`/`maxRetries: 0` so a 5xx/retry test doesn't wait out
   * real exponential backoff. */
  sleep?: SleepFn;
  maxRetries?: number;
}

/** Saves `plaintext` for a tenant only after confirming Bright Data
 * actually accepts it. Never calls `secrets.save()` on any failure path —
 * a rejected or unverifiable key leaves the tenant's existing key (or lack
 * of one) untouched. */
export async function saveVerifiedTenantKey(
  secrets: ScopedSecrets,
  plaintext: string,
  options: SaveVerifiedTenantKeyOptions = {}
): Promise<VerifiedKeySave> {
  if (!KEY_FORMAT.test(plaintext)) throw new InvalidApiKeyFormatError();

  const client = new BrightDataClient({
    apiKey: plaintext,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
  });

  let collectorsListResponse: unknown;
  try {
    collectorsListResponse = await client.collectorsList();
  } catch (err) {
    if (err instanceof BrightDataError && err.status === 401) {
      throw new TenantKeyRejectedError();
    }
    // Any other failure — a 5xx, a non-401 4xx, or a network-level throw —
    // means Bright Data is unreachable or misbehaving right now, not that
    // this specific key is wrong. Nothing is stored either way.
    throw new TenantKeyVerificationUnavailableError(err);
  }

  const status = secrets.save(plaintext);
  return { status, collectorsListResponse };
}
