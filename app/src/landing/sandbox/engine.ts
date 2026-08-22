// Client-side demo of the real runner pipeline (ux-spec.md §3): verdicts and
// the SHA-256 chain are computed from the CLI fixture data, never hardcoded.
import { sha256Hex } from './sha256';
import {
  SANDBOX_COLLECTORS,
  SANDBOX_ROWS,
  PRODUCTS,
  probedProduct,
  receivedProduct,
  type SandboxCollectorDef,
} from './fixtureData';
import type { CollectorState, Evidence } from '@/lib/api';

// No 'blocked' member on purpose: the local fixture can't emit a real Bright
// Data error_code, so no code path is allowed to produce that verdict.
export type SandboxMode = 'healthy' | 'price_dead' | 'wrong_entity';

export const SANDBOX_MODES: SandboxMode[] = ['healthy', 'price_dead', 'wrong_entity'];

export const SANDBOX_MAX_ACTIONS = 20;

export interface SandboxLedgerRow {
  id: number;
  ts: string;
  collector: string;
  verdict: string;
  cause: string | null;
  action: string;
  eventHash: string;
  prevHash: string;
}

/** A snapshot of the last RELEASE, not the latest run: a failed run changes
 * the verdict and ledger while leaving this untouched. */
export interface SandboxSafeOutputSnapshot {
  collectorId: string;
  rowCount: number;
  releasedAt: string;
  releaseEventId: number;
  outputHash: string;
}

export class SandboxLimitError extends Error {
  constructor() {
    super('Sandbox limit reached — start your own fleet to keep going.');
    this.name = 'SandboxLimitError';
  }
}

export class SandboxBlockedModeError extends Error {
  constructor() {
    super("blocked mode can't be demonstrated locally and is excluded from the sandbox.");
    this.name = 'SandboxBlockedModeError';
  }
}

function isSandboxMode(value: string): value is SandboxMode {
  return (SANDBOX_MODES as string[]).includes(value);
}

/** Fill rates over the fields THIS collector extracts (`def.fields`), never a
 * fixed every-field list — that is what makes the three collector names true. */
function fillRatesFor(def: SandboxCollectorDef, mode: SandboxMode): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const field of def.fields) {
    rates[field] = mode === 'price_dead' && field === 'price' ? 0 : 1;
  }
  return rates;
}

/** A dead price field is only a failure for a collector whose job reads the
 * price; for the others the page is unchanged, so an honest pass. */
function effectiveMode(def: SandboxCollectorDef, mode: SandboxMode): SandboxMode {
  if (mode === 'price_dead' && !def.fields.includes('price')) return 'healthy';
  return mode;
}

function fillPctFor(rates: Record<string, number>): number {
  const values = Object.values(rates);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.round(avg * 100);
}

function buildEvidence(def: SandboxCollectorDef, mode: SandboxMode): Evidence[] {
  const rates = fillRatesFor(def, mode);
  const contract: Evidence = {
    check: 'contract',
    ok: mode !== 'price_dead',
    detail: mode === 'price_dead' ? 'price field collapsed to 0% fill' : 'ok',
    metrics: { fillRates: rates },
  };
  const coherence: Evidence = {
    check: 'coherence',
    ok: true,
    detail: 'ok',
    metrics: {},
  };

  if (mode === 'wrong_entity') {
    const requested = probedProduct(def);
    const received = receivedProduct(def);
    const identity: Evidence = {
      check: 'identity',
      ok: false,
      detail: 'mismatchRate=1',
      metrics: {
        compared: 1,
        mismatched: 1,
        mismatches: [
          {
            input: requested.sku,
            requestedKey: `${requested.sku} — ${requested.title}`,
            extractedKey: `${received.sku} — ${received.title}`,
          },
        ],
      },
    };
    return [contract, coherence, identity];
  }

  const identity: Evidence = {
    check: 'identity',
    ok: true,
    detail: 'ok',
    metrics: { compared: SANDBOX_ROWS, mismatched: 0 },
  };

  if (mode === 'price_dead') {
    const canary: Evidence = {
      check: 'canary',
      ok: false,
      detail: 'confirmed on re-fetch',
      metrics: {
        outcomes: [{ input: def.probeSku, pass: false, reason: 'price field still absent on re-fetch' }],
        failCount: 1,
      },
    };
    return [contract, coherence, identity, canary];
  }

  return [contract, coherence, identity];
}

// Verdict, cause, action and reason all key off the same mode, so they read as
// one row each rather than four parallel ternary chains.
const OUTCOME = {
  healthy: { verdict: 'PASS', cause: null, pureAction: 'RELEASE', actionReason: null },
  price_dead: {
    verdict: 'FAILED_CONTRACT',
    cause: 'STRUCTURAL',
    pureAction: 'REPAIR',
    actionReason: 'price field collapsed to 0% fill — safe to repair automatically',
  },
  wrong_entity: {
    verdict: 'FAILED_IDENTITY',
    cause: 'IDENTITY',
    pureAction: 'QUARANTINE',
    actionReason: "returned a different product than requested — repair can't fix a wrong target, quarantining instead",
  },
} as const satisfies Record<SandboxMode, unknown>;

function buildCollector(def: SandboxCollectorDef, requestedMode: SandboxMode, ts: string, ledgerId: number): CollectorState {
  const mode = effectiveMode(def, requestedMode);
  const rates = fillRatesFor(def, mode);
  const fillPct = fillPctFor(rates);
  const { verdict, cause, pureAction, actionReason } = OUTCOME[mode];

  return {
    id: def.id,
    name: def.name,
    verdict,
    cause,
    action: pureAction,
    rows: SANDBOX_ROWS,
    fillPct,
    fillRates: rates,
    lastTs: ts,
    ledgerId,
    needsAck: false,
    acked: false,
    healAttemptsToday: 0,
    unverified: false,
    pureAction,
    actionReason,
    suggestedHealCommand: mode === 'price_dead' ? `polygraph heal ${def.id} --field price` : null,
    evidence: buildEvidence(def, mode),
  };
}

/** Opaque 128-bit `sandbox_id` (ux-spec.md §3), generated client-side because
 * there is no backend issuing one. */
function randomId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Per-visitor by construction (R8): fleet and ledger live in instance state, so
// two tabs or two test instances can never observe each other.
export class SandboxEngine {
  readonly id: string;
  /** The single collector the break buttons act on (ux-spec.md §3, ui-system.md
   * §5.4 rule 8): breaking all three at once reads as a page reload, not a catch. */
  readonly targetId: string = SANDBOX_COLLECTORS[0].id;
  private readonly genesisHash: string;
  private mode: SandboxMode = 'healthy';
  private fleet: CollectorState[];
  private ledger: SandboxLedgerRow[] = [];
  private safeOutput: SandboxSafeOutputSnapshot;
  private actionsUsed = 0;

  /** Seeded already-green with one completed run (ux-spec.md §3). `seedTs`
   * defaults to a few seconds ago so "last run 3s ago" is true on first paint. */
  constructor(seedTs: number = Date.now() - 3000) {
    this.id = randomId();
    this.genesisHash = sha256Hex(`polygraph:sandbox:v1:${this.id}`);
    const ts = new Date(seedTs).toISOString();
    this.fleet = SANDBOX_COLLECTORS.map((def, i) => buildCollector(def, 'healthy', ts, i + 1));

    this.appendFleetRows(ts);
    this.safeOutput = this.createSafeOutput(ts, 1);
  }

  /** One ledger row per collector, chained onto the tip (genesis when empty). */
  private appendFleetRows(ts: string): void {
    let prevHash = this.ledger.length > 0 ? this.ledger[this.ledger.length - 1].eventHash : this.genesisHash;
    for (const c of this.fleet) {
      const row = this.hashRow(this.ledger.length + 1, ts, c.name, c.verdict!, c.cause, c.pureAction!, prevHash);
      this.ledger.push(row);
      prevHash = row.eventHash;
    }
  }

  private createSafeOutput(releasedAt: string, releaseEventId: number): SandboxSafeOutputSnapshot {
    return {
      collectorId: this.targetId,
      rowCount: SANDBOX_ROWS,
      releasedAt,
      releaseEventId,
      // Hash of the released rows: a healthy re-run of identical output advances
      // provenance without claiming the data changed.
      outputHash: sha256Hex(JSON.stringify(PRODUCTS)),
    };
  }

  private hashRow(
    id: number,
    ts: string,
    collector: string,
    verdict: string,
    cause: string | null,
    action: string,
    prevHash: string,
  ): SandboxLedgerRow {
    const payload = { ts, collector, verdict, cause, action };
    const eventHash = sha256Hex(prevHash + JSON.stringify(payload));
    return { id, ts, collector, verdict, cause, action, eventHash, prevHash };
  }

  getFleet(): CollectorState[] {
    return this.fleet.slice();
  }

  getLedger(): SandboxLedgerRow[] {
    return this.ledger.slice();
  }

  getMode(): SandboxMode {
    return this.mode;
  }

  getSafeOutputSnapshot(): SandboxSafeOutputSnapshot {
    return { ...this.safeOutput };
  }

  get actionsRemaining(): number {
    return Math.max(0, SANDBOX_MAX_ACTIONS - this.actionsUsed);
  }

  canAct(): boolean {
    return this.actionsRemaining > 0;
  }

  /** Applies a chaos mode to the target collector and re-runs the whole fleet —
   * every field on every returned collector is computed, including the passes. */
  applyMode(mode: SandboxMode): CollectorState[] {
    if (!isSandboxMode(mode)) throw new SandboxBlockedModeError();
    if (!this.canAct()) throw new SandboxLimitError();

    this.actionsUsed += 1;
    this.mode = mode;
    const ts = new Date().toISOString();

    this.fleet = SANDBOX_COLLECTORS.map((def, i) =>
      buildCollector(def, def.id === this.targetId ? mode : 'healthy', ts, this.ledger.length + i + 1),
    );

    this.appendFleetRows(ts);

    const target = this.fleet.find((collector) => collector.id === this.targetId);
    if (target?.pureAction === 'RELEASE' && target.ledgerId !== null) {
      this.safeOutput = this.createSafeOutput(ts, target.ledgerId);
    }

    return this.getFleet();
  }

  /** Recomputes every hash from genesis — a real check, not a static string. */
  verifyChain(): { ok: boolean; checked: number; reason?: string } {
    return walkChain(this.genesisHash, this.ledger);
  }
}

/** Standalone so tests can walk a hand-corrupted row list without reaching into
 * `SandboxEngine`s private state. */
export function walkChain(genesisHash: string, rows: SandboxLedgerRow[]): { ok: boolean; checked: number; reason?: string } {
  let prev = genesisHash;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const payload = { ts: row.ts, collector: row.collector, verdict: row.verdict, cause: row.cause, action: row.action };
    const expected = sha256Hex(prev + JSON.stringify(payload));
    if (expected !== row.eventHash || row.prevHash !== prev) {
      return { ok: false, checked: i, reason: `chain broke at event ${row.id}` };
    }
    prev = row.eventHash;
  }
  return { ok: true, checked: rows.length };
}
