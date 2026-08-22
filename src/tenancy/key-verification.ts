/**
 * Live Bright Data key verification at save time — carried ruling from
 * Task 2 into this task: "implement live Bright Data key verification at
 * save time here, since this task already calls their API — a saved key
 * that turns out to be invalid must fail fast and legibly during
 * onboarding, not silently produce 'Not checked' cards later."
 *
 * Implements tenant-architecture.md §2 "Validation at save time", as
 * corrected by a later controller ruling:
 *   1. Reject anything not matching the key-shape regex BEFORE touching
 *      crypto or the network at all.
 *   2. Verify it: `GET /dca/collectors_list` with the key.
 *        - A 401 is the only unambiguous invalid-credential signal Bright
 *          Data gives — nothing is stored, the caller must re-enter a
 *          working key.
 *        - EVERYTHING ELSE — most notably a 403, and any transport/network
 *          failure — must NOT discard a key the user just typed in. A 403
 *          means the collectors-list endpoint itself is gated for that
 *          account; it says nothing about whether the credential is valid,
 *          and this is not a hypothetical: it is the standing state of at
 *          least one real account this product needs to onboard. The key
 *          is persisted anyway, honestly marked `key_verification:
 *          'unverified'` (secrets.ts) — never silently reported as
 *          verified when it wasn't.
 *   3. On success, the `collectors_list` body is returned to the caller so
 *      `infer-schema.ts` can read it directly — no second network request
 *      (§4's "this doubles as step 1 of onboarding"). On the unverified
 *      path there is nothing real to return, so it's `[]` — every consumer
 *      (`summarizeCollectorsList`, `inferFieldsForCollector`) already
 *      degrades an empty/absent list cleanly.
 *
 * The first real run against a tenant's own key is what actually proves it
 * — see `ScopedSecrets.markVerified()`, called by whichever code path runs
 * that first job on success.
 */
import { BrightDataClient, BrightDataError, type SleepFn } from '../brightdata/client.js';
import { InvalidApiKeyFormatError, KEY_FORMAT, type ScopedSecrets, type TenantSecretStatus } from './secrets.js';

export class TenantKeyRejectedError extends Error {
  constructor() {
    super('Bright Data rejected this key');
    this.name = 'TenantKeyRejectedError';
  }
}

/**
 * No longer thrown by `saveVerifiedTenantKey` as of the controller ruling
 * above — a 403 or a transport/network failure now persists the key as
 * `unverified` instead of refusing to store it. Kept exported (and its
 * shape unchanged) purely so an existing importer (the settings/key HTTP
 * route) still compiles; its corresponding `catch` branch there is simply
 * unreachable code now, not a bug.
 */
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
   * `inferFieldsForCollector`/`summarizeCollectorsList` so onboarding's
   * INFER step never makes a second request for it. `[]` on the
   * `key_verification: 'unverified'` path (a 403 or a network failure never
   * yields a real list) — every consumer of this already treats an empty
   * array as "nothing to infer yet", never as an error. */
  collectorsListResponse: unknown;
}

export interface SaveVerifiedTenantKeyOptions {
  /** Injectable fetch implementation, for tests — never hits the network. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Passed straight through to `BrightDataClient` — lets tests use an
   * instant `sleep`/`maxRetries: 0` so a retry-heavy test doesn't wait out
   * real exponential backoff. */
  sleep?: SleepFn;
  maxRetries?: number;
}

/**
 * Saves `plaintext` for a tenant. Only a 401 (an unambiguous
 * invalid-credential signal) refuses to persist it — every other outcome of
 * the verification call persists the key, with `TenantSecretStatus.key_verification`
 * honestly reflecting whether Bright Data's own response actually confirmed
 * it works.
 */
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

  let collectorsListResponse: unknown = [];
  let verified = true;
  try {
    collectorsListResponse = await client.collectorsList();
  } catch (err) {
    if (err instanceof BrightDataError && err.status === 401) {
      // The only unambiguous invalid-credential signal Bright Data gives us.
      // Nothing is stored — the caller must re-enter a working key.
      throw new TenantKeyRejectedError();
    }
    // A 403 (the listing endpoint gated for this account — says nothing
    // about the credential's own validity), any other non-401 status, or a
    // transport/network-level throw: must NOT discard a key the user just
    // typed in. Persist it, honestly marked unverified.
    verified = false;
    collectorsListResponse = [];
  }

  const status = secrets.save(plaintext, { verified });
  return { status, collectorsListResponse };
}
