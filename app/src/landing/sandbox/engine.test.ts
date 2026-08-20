/**
 * SandboxEngine — covers plan ruling R8 (per-visitor state, concurrent
 * visitors cannot affect each other), the `blocked`-mode exclusion, the
 * chaos-action rate limit, and that verdicts are genuinely computed from
 * mode rather than a table of canned per-button responses.
 */
import { describe, expect, it } from 'vitest';
import { SandboxEngine, SandboxLimitError, SandboxBlockedModeError, SANDBOX_MAX_ACTIONS, walkChain } from './engine';
import { PRODUCTS, SANDBOX_COLLECTORS, substituteProduct } from './fixtureData';
import { toVerdictState } from '@/lib/verdict';

/** Splits a post-`applyMode` fleet into the one collector the break buttons
 * act on and the collectors that merely re-ran. ux-spec.md §3's interaction
 * contract is written in the singular ("Target card enters a re-verify
 * skeleton"), and ui-system.md §5.4 rule 8 wants the failing accent to have
 * the screen to itself — so "the other two stay VERIFIED" is a behaviour
 * these tests assert, not an accident of the fixture. */
function splitByTarget(engine: SandboxEngine, fleet: ReturnType<SandboxEngine['getFleet']>) {
  const target = fleet.find((c) => c.id === engine.targetId);
  if (!target) throw new Error('sandbox fleet does not contain its own target collector');
  return { target, others: fleet.filter((c) => c.id !== engine.targetId) };
}

describe('SandboxEngine — seeded state (ux-spec.md §3)', () => {
  it('starts already green: 3 collectors, PASS, one completed run each on the chain', () => {
    const engine = new SandboxEngine();
    const fleet = engine.getFleet();
    expect(fleet).toHaveLength(3);
    for (const c of fleet) {
      expect(c.verdict).toBe('PASS');
      expect(toVerdictState(c)).toBe('VERIFIED');
      expect(c.fillPct).toBe(100);
    }
    expect(engine.getLedger()).toHaveLength(3);
    expect(engine.verifyChain().ok).toBe(true);
  });
});

describe('SandboxEngine — R8: per-visitor state, never shared', () => {
  it('two independently constructed engines never observe or affect each other', () => {
    const visitorA = new SandboxEngine();
    const visitorB = new SandboxEngine();

    expect(visitorA.id).not.toBe(visitorB.id);

    visitorA.applyMode('price_dead');
    visitorA.applyMode('wrong_entity');
    const { target: targetA, others: othersA } = splitByTarget(visitorA, visitorA.getFleet());

    // Visitor B's fleet and ledger are completely untouched by A's actions.
    for (const c of visitorB.getFleet()) {
      expect(c.verdict).toBe('PASS');
      expect(toVerdictState(c)).toBe('VERIFIED');
    }
    expect(visitorB.getLedger()).toHaveLength(3);
    expect(visitorB.actionsRemaining).toBe(SANDBOX_MAX_ACTIONS);

    // Visitor A's own state reflects its own actions, independently.
    expect(toVerdictState(targetA)).toBe('WRONG_TARGET');
    // ...and only the targeted collector: the rest of A's own fleet re-ran
    // and genuinely passed, which is what gives the magenta card something
    // to be read against (ui-system.md §5.4 rule 8).
    expect(othersA).toHaveLength(2);
    for (const c of othersA) expect(toVerdictState(c)).toBe('VERIFIED');
    expect(visitorA.getLedger()).toHaveLength(9); // 3 seed + 3 + 3
    expect(visitorA.actionsRemaining).toBe(SANDBOX_MAX_ACTIONS - 2);
  });

  it('a third, freshly constructed visitor is unaffected by any prior engine, ever', () => {
    const busy = new SandboxEngine();
    busy.applyMode('price_dead');
    busy.applyMode('wrong_entity');
    busy.applyMode('healthy');

    const freshVisitor = new SandboxEngine();
    for (const c of freshVisitor.getFleet()) {
      expect(toVerdictState(c)).toBe('VERIFIED');
    }
    expect(freshVisitor.getLedger()).toHaveLength(3);
  });
});

describe('SandboxEngine — blocked mode is structurally excluded', () => {
  it('never starts in or transitions to a blocked mode', () => {
    const engine = new SandboxEngine();
    expect(engine.getMode()).not.toBe('blocked');
  });

  it('rejects an attempt to force blocked mode past the type system', () => {
    const engine = new SandboxEngine();
    expect(() => engine.applyMode('blocked' as never)).toThrow(SandboxBlockedModeError);
  });
});

describe('SandboxEngine — verdicts are computed from mode, not hardcoded per click', () => {
  it('price_dead: only the price field collapses on the TARGET; sku/title/stock stay full, contract fails, repair available', () => {
    const engine = new SandboxEngine();
    const { target } = splitByTarget(engine, engine.applyMode('price_dead'));

    expect(target.fillRates).toEqual({ sku: 1, title: 1, price: 0, stock: 1 });
    expect(target.fillPct).toBe(75);
    expect(target.cause).toBe('STRUCTURAL');
    expect(toVerdictState(target)).toBe('WRONG_SHAPE');
    const identity = target.evidence?.find((e) => e.check === 'identity');
    expect(identity?.ok).toBe(true); // identity still passes; this is a structural failure, not a wrong target
  });

  it('price_dead leaves the untargeted collectors genuinely passing, evidence and all — not merely unlabelled', () => {
    const engine = new SandboxEngine();
    const { others } = splitByTarget(engine, engine.applyMode('price_dead'));

    expect(others).toHaveLength(2);
    for (const c of others) {
      expect(toVerdictState(c)).toBe('VERIFIED');
      expect(c.fillRates).toEqual({ sku: 1, title: 1, price: 1, stock: 1 });
      expect(c.fillPct).toBe(100);
      expect(c.cause).toBeNull();
      // The pass is computed the same way the failure is: every check ran
      // and reported ok, rather than the collector simply being skipped.
      for (const e of c.evidence ?? []) expect(e.ok).toBe(true);
    }
  });

  it('wrong_entity: the target is fully filled (100%) — the "looks like it is passing" card — but identity fails', () => {
    const engine = new SandboxEngine();
    const { target, others } = splitByTarget(engine, engine.applyMode('wrong_entity'));

    expect(target.fillPct).toBe(100);
    expect(target.cause).toBe('IDENTITY');
    expect(toVerdictState(target)).toBe('WRONG_TARGET');
    const identity = target.evidence?.find((e) => e.check === 'identity');
    expect(identity?.ok).toBe(false);
    const mismatches = identity?.metrics?.mismatches as Array<{ requestedKey: string; extractedKey: string }>;
    expect(mismatches[0].requestedKey).not.toBe(mismatches[0].extractedKey);

    for (const c of others) expect(toVerdictState(c)).toBe('VERIFIED');
  });

  it('healthy after a failure genuinely returns the fleet to VERIFIED, not just a label swap', () => {
    const engine = new SandboxEngine();
    engine.applyMode('price_dead');
    const fleet = engine.applyMode('healthy');
    for (const c of fleet) {
      expect(c.fillPct).toBe(100);
      expect(c.cause).toBeNull();
      expect(toVerdictState(c)).toBe('VERIFIED');
    }
  });

  it('the wrong_entity swap is two REAL catalog products in catalog order — never a fabricated one', () => {
    const engine = new SandboxEngine();
    const { target } = splitByTarget(engine, engine.applyMode('wrong_entity'));
    const def = SANDBOX_COLLECTORS.find((d) => d.id === engine.targetId)!;

    const identity = target.evidence?.find((e) => e.check === 'identity');
    const mismatches = (identity?.metrics?.mismatches ?? []) as Array<{ requestedKey: string; extractedKey: string }>;
    const [m] = mismatches;

    const requested = PRODUCTS.find((prod) => prod.sku === def.watchedSku)!;
    const received = substituteProduct(def.watchedSku);

    // Both halves of the swap name a product that actually exists in the
    // fixture catalog, and the substitution is the documented catalog-order
    // successor — the honesty property the old three-collector "each swap is
    // distinct" assertion was standing in for.
    expect(m.requestedKey).toBe(`${requested.sku} — ${requested.title}`);
    expect(m.extractedKey).toBe(`${received.sku} — ${received.title}`);
    expect(PRODUCTS.some((prod) => prod.sku === received.sku)).toBe(true);
    expect(received.sku).not.toBe(requested.sku);
  });
});

describe('SandboxEngine — rate limit (ux-spec.md §3: 20 chaos actions per session)', () => {
  it('disables further actions once the limit is exhausted', () => {
    const engine = new SandboxEngine();
    for (let i = 0; i < SANDBOX_MAX_ACTIONS; i++) {
      engine.applyMode(i % 2 === 0 ? 'price_dead' : 'healthy');
    }
    expect(engine.canAct()).toBe(false);
    expect(engine.actionsRemaining).toBe(0);
    expect(() => engine.applyMode('healthy')).toThrow(SandboxLimitError);
  });

  it('a fresh visitor is not affected by another visitor exhausting their own limit', () => {
    const exhausted = new SandboxEngine();
    for (let i = 0; i < SANDBOX_MAX_ACTIONS; i++) exhausted.applyMode('healthy');
    expect(exhausted.canAct()).toBe(false);

    const fresh = new SandboxEngine();
    expect(fresh.canAct()).toBe(true);
    expect(fresh.actionsRemaining).toBe(SANDBOX_MAX_ACTIONS);
  });
});

describe('SandboxEngine — Verify chain is a real cryptographic walk', () => {
  it('reports ok:true with the correct checked count after several actions', () => {
    const engine = new SandboxEngine();
    engine.applyMode('price_dead');
    engine.applyMode('wrong_entity');
    engine.applyMode('healthy');
    const result = engine.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(engine.getLedger().length);
  });

  it('detects tampering: a hand-corrupted event hash breaks the chain walk', () => {
    const engine = new SandboxEngine();
    engine.applyMode('price_dead');
    expect(engine.verifyChain().ok).toBe(true);

    const rows = engine.getLedger();
    const tampered = rows.map((r, i) => (i === 2 ? { ...r, eventHash: 'deadbeef'.repeat(8) } : r));

    // walkChain is the exact function verifyChain() delegates to — exercised
    // directly here against a hand-corrupted row to prove it is a genuine
    // hash recomputation, not merely a length/shape check.
    const genesis = rows[0].prevHash; // the chain's own genesis hash
    const result = walkChain(genesis, tampered);
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.reason).toContain('event');
  });

  it('a chain that has never been tampered with always walks clean from the same genesis', () => {
    const engine = new SandboxEngine();
    engine.applyMode('wrong_entity');
    const rows = engine.getLedger();
    const genesis = rows[0].prevHash;
    expect(walkChain(genesis, rows).ok).toBe(true);
  });
});
