import type Database from 'better-sqlite3';
import type { SecretString } from './crypto.js';
import { decryptIngestToken } from './ingest-token-crypto.js';

/**
 * Re-reading a collector's ingest capability (M015).
 *
 * The product rule this implements: the operator must be able to get a
 * collector's webhook URL at any time from its card, not only in the one-shot
 * response to connect/rotate. Bright Data holds that URL in a dashboard
 * nobody can read back either, so "we showed it once" left the only copy
 * outside Polygraph — a support burden that ended in a rotation every time.
 *
 * What this deliberately does NOT do: invent a plaintext for a row that
 * never stored one. A token issued before M015 (or issued by a caller with
 * no master key) is hash-only and stays that way; it reports
 * `NOT_REVEALABLE`, and the operator rotates to get a fresh, revealable one.
 */

/** Why a reveal produced no URL. `NOT_FOUND` is the collector having no
 * ingest token row at all; the route answers 404 for a collector that is not
 * the caller's, so the two are never distinguishable to an attacker. */
export type RevealFailureReason = 'NOT_REVEALABLE' | 'NOT_FOUND';

export type IngestTokenReveal =
  | { ok: true; token: SecretString }
  | { ok: false; reason: RevealFailureReason };

interface TokenRow {
  token_ciphertext: Buffer | null;
  token_iv: Buffer | null;
  token_tag: Buffer | null;
  token_salt: Buffer | null;
  token_key_version: number | null;
  revoked_at: string | null;
}

/**
 * Decrypts the stored plaintext copy of one collector's ingest token.
 *
 * The tenant id is the caller's session tenant, never a request parameter,
 * and it is also the AAD and part of the HKDF `info` — so a row that somehow
 * belonged to another tenant would fail the GCM tag check rather than
 * decrypt. A revoked token is treated as absent: revocation exists to make a
 * URL dead, and handing it back would undo that.
 *
 * Returns a `SecretString`; the caller unwraps it once, at the point it
 * builds the response URL. Never logs, never throws for the ordinary
 * "nothing to reveal" cases.
 */
export function revealDeliveryToken(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  masterKey: Buffer
): IngestTokenReveal {
  const row = db
    .prepare(
      `SELECT token_ciphertext, token_iv, token_tag, token_salt, token_key_version, revoked_at
         FROM collector_ingest_tokens
        WHERE tenant_id = ? AND collector_id = ?`
    )
    .get(tenantId, collectorId) as TokenRow | undefined;

  if (!row || row.revoked_at !== null) return { ok: false, reason: 'NOT_FOUND' };
  if (!row.token_ciphertext || !row.token_iv || !row.token_tag || !row.token_salt) {
    // Issued before M015, or by a caller with no master key: only the digest
    // was ever stored, and no amount of trying makes that plaintext exist.
    return { ok: false, reason: 'NOT_REVEALABLE' };
  }

  try {
    const token = decryptIngestToken(masterKey, tenantId, {
      ciphertext: row.token_ciphertext,
      iv: row.token_iv,
      tag: row.token_tag,
      salt: row.token_salt,
      version: row.token_key_version ?? 1,
    });
    return { ok: true, token };
  } catch {
    // A wrong/rotated master key or tampered bytes. Indistinguishable from a
    // legacy row on the wire on purpose — both mean "rotate to get a URL".
    return { ok: false, reason: 'NOT_REVEALABLE' };
  }
}

/**
 * One content-free `ops_log` breadcrumb per reveal: who and when, never the
 * URL or the token. Reveals hand back a live ingress capability, so they are
 * the kind of read that has to leave a trace an operator can audit later.
 */
export function recordIngestTokenReveal(
  db: Database.Database,
  tenantId: string,
  collectorId: string,
  outcome: 'REVEALED' | RevealFailureReason,
  nowIso: string
): void {
  db.prepare(
    `INSERT INTO ops_log (ts, event, tenant_id, detail) VALUES (?, 'INGEST_TOKEN_REVEALED', ?, ?)`
  ).run(nowIso, tenantId, `${collectorId}:${outcome}`);
}
