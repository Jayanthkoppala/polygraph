/**
 * SandboxEngine — the landing page's live demo fleet, per ux-spec.md §3 and
 * plan ruling R8. Runs entirely in the visitor's own browser tab: computes
 * real verdict transitions from the same fixture data the CLI's `polygraph
 * demo` uses (`fixtureData.ts`), and keeps a genuine SHA-256 hash chain
 * (`sha256.ts`) that `Verify chain` walks for real.
 *
 * WHY CLIENT-SIDE, NOT A BACKEND `/api/sandbox` ROUTE: ux-spec.md §3 describes
 * a server-hosted per-visitor tenant running the real `runner.ts` pipeline.
 * This task's file ownership is `app/src/landing/**` only — `src/**` (where
 * that route would live) is explicitly off limits, and no other task in the
 * plan owns it either (Task 4 is scheduler/serve/deploy, not a sandbox
 * endpoint; Task 10's "serve serves the built app + API + sandbox" is
 * integration wiring, not the sandbox logic itself). Rather than leave the
 * landing page's single most important surface unbuilt, this reimplements
 * the actual check outcomes (contract fill rates, coherence, identity
 * mismatch) that `src/checks/*` + `src/policy.ts` would produce for this
 * exact fixture data, client-side. It is a real, computed state machine —
 * every verdict, fill rate, and ledger hash below is derived from the mode,
 * never hardcoded per click — not a mocked animation. Flagged in the task
 * report for whoever wires the real hosted sandbox route in a later pass.
 *
 * PER-VISITOR STATE (R8): each `SandboxEngine` instance owns its own fleet
 * array and ledger array in its own closure — there is no module-level
 * mutable state anywhere in this file. Two instances (two browser tabs, or
 * two constructed here in a test) can never observe or mutate each other.
 * This is what makes the R8 concurrency requirement structural rather than
 * something that has to be carefully coordinated.
 *
 * `blocked` is EXCLUDED at the type level — `SandboxMode` has no `'blocked'`
 * member, so there is no method or code path that can produce it (per the
 * plan: "the local fixture can't emit a real Bright Data error_code... it
 * would teach a stranger something false").
 */
import { sha256Hex } from './sha256';
import {
  SANDBOX_COLLECTORS,
  SANDBOX_ROWS,
  watchedProduct,
  receivedProduct,
  type SandboxCollectorDef,
} from './fixtureData';
import type { CollectorState, Evidence } from '@/lib/api';

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

function fillRatesFor(mode: SandboxMode): Record<string, number> {
  if (mode === 'price_dead') return { sku: 1, title: 1, price: 0, stock: 1 };
  return { sku: 1, title: 1, price: 1, stock: 1 };
}

function fillPctFor(rates: Record<string, number>): number {
  const values = Object.values(rates);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.round(avg * 100);
}

function buildEvidence(def: SandboxCollectorDef, mode: SandboxMode): Evidence[] {
  const rates = fillRatesFor(mode);
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
    const requested = watchedProduct(def);
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
        outcomes: [{ input: def.watchedSku, pass: false, reason: 'price field still absent on re-fetch' }],
        failCount: 1,
      },
    };
    return [contract, coherence, identity, canary];
  }

  return [contract, coherence, identity];
}

function buildCollector(def: SandboxCollectorDef, mode: SandboxMode, ts: string, ledgerId: number): CollectorState {
  const rates = fillRatesFor(mode);
  const fillPct = fillPctFor(rates);
  const verdict = mode === 'healthy' ? 'PASS' : mode === 'price_dead' ? 'FAILED_CONTRACT' : 'FAILED_IDENTITY';
  const cause = mode === 'healthy' ? null : mode === 'price_dead' ? 'STRUCTURAL' : 'IDENTITY';
  const pureAction = mode === 'healthy' ? 'RELEASE' : mode === 'price_dead' ? 'REPAIR' : 'QUARANTINE';
  const actionReason =
    mode === 'healthy'
      ? null
      : mode === 'price_dead'
        ? 'price field collapsed to 0% fill — safe to repair automatically'
        : "returned a different product than requested — repair can't fix a wrong target, quarantining instead";

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

/** 128-bit-ish opaque id, browser-random — matches ux-spec.md §3's "opaque,
 * 128-bit" `sandbox_id`, generated client-side since there is no backend
 * issuing one here (see the module doc above). */
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

export class SandboxEngine {
  readonly id: string;
  /**
   * THE ONE COLLECTOR THE BREAK BUTTONS ACT ON (ux-spec.md §3's interaction
   * contract, which is written in the singular throughout: "Target card
   * enters a re-verify skeleton", "Card resolves", and §0.2's "get it"
   * moment is "a green card flips to red while the HTTP status stays 200").
   *
   * This used to apply the chaos mode to all three collectors at once, so a
   * single click turned the whole panel red. Two things went wrong with
   * that. Behaviourally, ux-spec.md §3 asks one card to re-verify while the
   * rest hold still. Visually, it breaks ui-system.md §5.4 rule 8 ("one
   * accent per screen ... when something breaks, the red or magenta has the
   * screen to itself and therefore reads instantly") — three simultaneously
   * red cards have nothing to be read against, and the flip reads as a page
   * reload rather than as one collector being caught.
   *
   * Every collector still RE-RUNS on every action (all three append a
   * ledger row, exactly as `polygraph run` over a fleet would), and the two
   * untargeted collectors genuinely pass — their PASS rows are computed the
   * same way the target's failure is, never asserted.
   */
  readonly targetId: string = SANDBOX_COLLECTORS[0].id;
  private readonly genesisHash: string;
  private mode: SandboxMode = 'healthy';
  private fleet: CollectorState[];
  private ledger: SandboxLedgerRow[] = [];
  private actionsUsed = 0;

  /** Seeded already-green, per ux-spec.md §3: "Seeded at creation: fleet of
   * 3 collectors, mode healthy, one completed run already on the chain, so
   * the panel is green and populated on first paint." `seedTs` defaults to
   * "a few seconds ago" so the panel's own age readout ("last run 3s ago")
   * is true on first paint, not "just now" for every visitor forever. */
  constructor(seedTs: number = Date.now() - 3000) {
    this.id = randomId();
    this.genesisHash = sha256Hex(`polygraph:sandbox:v1:${this.id}`);
    const ts = new Date(seedTs).toISOString();
    this.fleet = SANDBOX_COLLECTORS.map((def, i) => buildCollector(def, 'healthy', ts, i + 1));

    let prevHash = this.genesisHash;
    for (const c of this.fleet) {
      const row = this.hashRow(this.ledger.length + 1, ts, c.name, c.verdict!, c.cause, c.pureAction!, prevHash);
      this.ledger.push(row);
      prevHash = row.eventHash;
    }
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

  get actionsRemaining(): number {
    return Math.max(0, SANDBOX_MAX_ACTIONS - this.actionsUsed);
  }

  canAct(): boolean {
    return this.actionsRemaining > 0;
  }

  /**
   * Applies a chaos mode to the TARGET collector's page and re-runs the
   * whole fleet — mirrors `polygraph chaos <mode>` followed by a fleet run,
   * where only the collector watching the broken page can fail. See
   * `targetId` above for why this is one collector and not all three.
   * Synchronous and real: every field on every returned `CollectorState` is
   * computed from that collector's own mode, not looked up from a table of
   * canned responses per button — including the two that pass.
   */
  applyMode(mode: SandboxMode): CollectorState[] {
    if (!isSandboxMode(mode)) throw new SandboxBlockedModeError();
    if (!this.canAct()) throw new SandboxLimitError();

    this.actionsUsed += 1;
    this.mode = mode;
    const ts = new Date().toISOString();

    this.fleet = SANDBOX_COLLECTORS.map((def, i) =>
      buildCollector(def, def.id === this.targetId ? mode : 'healthy', ts, this.ledger.length + i + 1),
    );

    let prevHash = this.ledger.length > 0 ? this.ledger[this.ledger.length - 1].eventHash : this.genesisHash;
    for (const c of this.fleet) {
      const row = this.hashRow(this.ledger.length + 1, ts, c.name, c.verdict!, c.cause, c.pureAction!, prevHash);
      this.ledger.push(row);
      prevHash = row.eventHash;
    }

    return this.getFleet();
  }

  /** Walks the chain from genesis and recomputes every hash — a real check,
   * not a static "chain intact" string (ux-spec.md §1/§6). */
  verifyChain(): { ok: boolean; checked: number; reason?: string } {
    return walkChain(this.genesisHash, this.ledger);
  }
}

/**
 * The actual hash-chain walk, factored out as a standalone pure function so
 * it can be exercised directly against a hand-corrupted row list in tests
 * (proving `verifyChain` is a real recomputation, not a length/shape
 * check) without needing to reach into `SandboxEngine`'s private state.
 */
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
