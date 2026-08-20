import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  decide,
  decideWithGovernor,
  composeHealPrompt,
  causeForErrorCode,
  worstCause,
  Governor,
} from '../src/policy.js';
import type { Evidence } from '../src/types.js';
import type { Policy } from '../src/config.js';

const okContract: Evidence = {
  check: 'contract',
  ok: true,
  detail: 'all required fields filled',
  metrics: { fillRates: { price: 1, title: 1 }, requiredViolationRate: 0, errorRowRate: 0 },
};

const failedContract: Evidence = {
  check: 'contract',
  ok: false,
  detail: 'requiredViolationRate=0.9',
  metrics: { fillRates: { price: 0.1, title: 1 }, requiredViolationRate: 0.9, errorRowRate: 0 },
};

const okCoherence: Evidence = {
  check: 'coherence',
  ok: true,
  detail: 'no collapse',
  metrics: { collapsedFields: [], zeroRows: false },
};

const failedCoherence: Evidence = {
  check: 'coherence',
  ok: false,
  detail: 'collapsed field(s): price',
  metrics: { collapsedFields: ['price'], zeroRows: false },
};

const passedCanary: Evidence = {
  check: 'canary',
  ok: true,
  detail: 'all canary inputs passed',
  metrics: { passCount: 3, failCount: 0, passRate: 1 },
};

const failedCanary: Evidence = {
  check: 'canary',
  ok: false,
  detail: '2/3 canary inputs failed',
  metrics: { passCount: 1, failCount: 2, passRate: 1 / 3 },
};

function identityEvidence(mismatchRate: number): Evidence {
  return {
    check: 'identity',
    ok: mismatchRate === 0,
    detail: `mismatchRate=${mismatchRate}`,
    metrics: { compared: 10, mismatched: Math.round(mismatchRate * 10), mismatchRate },
  };
}

const advisoryPeer: Evidence = {
  check: 'peer',
  ok: false,
  detail: 'outlier below peer median',
  metrics: { advisory: true, collector: 'x', madMultiple: 5 },
};

describe('decide — policy truth table', () => {
  it('NONE with no evidence releases (PASS)', () => {
    const { verdict, action } = decide('NONE', []);
    expect(verdict.code).toBe('PASS');
    expect(verdict.cause).toBe('NONE');
    expect(action).toEqual({ type: 'RELEASE' });
  });

  it('NONE with all-ok evidence still releases (PASS)', () => {
    const { verdict, action } = decide('NONE', [okContract, okCoherence]);
    expect(verdict.code).toBe('PASS');
    expect(action).toEqual({ type: 'RELEASE' });
  });

  it('DATA with a failed contract quarantines as FAILED_CONTRACT', () => {
    const { verdict, action } = decide('DATA', [failedContract]);
    expect(verdict.code).toBe('FAILED_CONTRACT');
    expect(verdict.cause).toBe('DATA');
    expect(action.type).toBe('QUARANTINE');
  });

  it('DATA with only a failed coherence (contract ok) quarantines as SUSPECT_UNEXPLAINED_ANOMALY', () => {
    const { verdict, action } = decide('DATA', [okContract, failedCoherence]);
    expect(verdict.code).toBe('SUSPECT_UNEXPLAINED_ANOMALY');
    expect(action.type).toBe('QUARANTINE');
  });

  it('DATA with no concrete failing evidence still quarantines as SUSPECT_UNEXPLAINED_ANOMALY, never releases', () => {
    const { verdict, action } = decide('DATA', []);
    expect(verdict.code).toBe('SUSPECT_UNEXPLAINED_ANOMALY');
    expect(action.type).toBe('QUARANTINE');
  });

  it('DATA with only advisory peer evidence still quarantines, never releases off advisory alone', () => {
    const { verdict, action } = decide('DATA', [advisoryPeer]);
    expect(verdict.code).toBe('SUSPECT_UNEXPLAINED_ANOMALY');
    expect(action.type).toBe('QUARANTINE');
  });

  it('IDENTITY with a high mismatch rate escalates to REDISCOVER', () => {
    const { verdict, action } = decide('IDENTITY', [identityEvidence(0.8)]);
    expect(verdict.code).toBe('FAILED_IDENTITY');
    expect(verdict.cause).toBe('IDENTITY');
    expect(action.type).toBe('REDISCOVER');
  });

  it('IDENTITY with a low mismatch rate quarantines for human review', () => {
    const { verdict, action } = decide('IDENTITY', [identityEvidence(0.1)]);
    expect(verdict.code).toBe('FAILED_IDENTITY');
    expect(action.type).toBe('QUARANTINE');
  });

  it('IDENTITY with no identity evidence at all conservatively escalates to REDISCOVER', () => {
    const { verdict, action } = decide('IDENTITY', []);
    expect(verdict.code).toBe('FAILED_IDENTITY');
    expect(action.type).toBe('REDISCOVER');
  });

  it('BLOCKED always quarantines as FAILED_BLOCKED_RESPONSE, regardless of other evidence', () => {
    const { verdict, action } = decide('BLOCKED', [passedCanary]);
    expect(verdict.code).toBe('FAILED_BLOCKED_RESPONSE');
    expect(action.type).toBe('QUARANTINE');
  });

  it('STRUCTURAL with failed contract + failed canary repairs', () => {
    const { verdict, action } = decide('STRUCTURAL', [failedContract, failedCanary], {
      entityKeyField: 'sku',
      now: new Date('2026-08-20T00:00:00Z'),
    });
    expect(verdict.code).toBe('FAILED_STRUCTURAL');
    expect(verdict.cause).toBe('STRUCTURAL');
    expect(action.type).toBe('REPAIR');
    if (action.type === 'REPAIR') {
      expect(action.heal_prompt.length).toBeLessThanOrEqual(1000);
      expect(action.heal_prompt).toContain('price');
      expect(action.heal_prompt).toContain('sku');
      expect(action.heal_prompt).toMatch(/^The field\(s\)/);
      expect(action.heal_prompt).toContain('Re-capture');
      expect(action.heal_prompt).toContain('Entity check:');
    }
  });

  it('STRUCTURAL with failed coherence + failed canary repairs', () => {
    const { verdict, action } = decide('STRUCTURAL', [failedCoherence, failedCanary], {
      entityKeyField: 'sku',
      now: new Date('2026-08-20T00:00:00Z'),
    });
    expect(verdict.code).toBe('FAILED_STRUCTURAL');
    expect(action.type).toBe('REPAIR');
  });

  it('STRUCTURAL with failed contract but NO canary evidence does not repair (missing confirmation)', () => {
    const { verdict, action } = decide('STRUCTURAL', [failedContract]);
    expect(verdict.code).toBe('FAILED_STRUCTURAL');
    expect(action.type).toBe('QUARANTINE');
  });

  it('STRUCTURAL with failed canary but NO structural (contract/coherence) evidence does not repair', () => {
    const { verdict, action } = decide('STRUCTURAL', [failedCanary]);
    expect(action.type).toBe('QUARANTINE');
  });

  it('STRUCTURAL with a passing canary (no canary failure) does not repair even with failed contract', () => {
    const { verdict, action } = decide('STRUCTURAL', [failedContract, passedCanary]);
    expect(action.type).toBe('QUARANTINE');
    expect(verdict.code).toBe('FAILED_STRUCTURAL');
  });
});

describe('decide — REPAIR invariant is structurally restricted to STRUCTURAL cause', () => {
  const causes = ['NONE', 'DATA', 'IDENTITY', 'BLOCKED'] as const;

  it.each(causes)('%s never yields a REPAIR action, even with contract+canary failure evidence present', (cause) => {
    const { action } = decide(cause, [failedContract, failedCanary, failedCoherence]);
    expect(action.type).not.toBe('REPAIR');
  });
});

describe('decide — property: IDENTITY never produces REPAIR over randomized evidence', () => {
  // Deterministic PRNG (mulberry32) so the property test is reproducible, not flaky.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const checks = ['contract', 'coherence', 'canary', 'identity', 'peer'];

  function randomEvidence(rand: () => number): Evidence[] {
    const count = Math.floor(rand() * 6);
    const evidence: Evidence[] = [];
    for (let i = 0; i < count; i++) {
      const check = checks[Math.floor(rand() * checks.length)];
      const ok = rand() > 0.5;
      evidence.push({
        check,
        ok,
        detail: `random ${check} ${ok}`,
        metrics: {
          fillRates: { price: rand() },
          collapsedFields: ok ? [] : ['price'],
          mismatchRate: rand(),
          passCount: Math.floor(rand() * 5),
          failCount: Math.floor(rand() * 5),
          advisory: check === 'peer' ? true : undefined,
        },
      });
    }
    return evidence;
  }

  it('holds over 500 randomized evidence combinations', () => {
    const rand = mulberry32(1337);
    for (let i = 0; i < 500; i++) {
      const evidence = randomEvidence(rand);
      const { action } = decide('IDENTITY', evidence);
      expect(action.type).not.toBe('REPAIR');
      expect(['QUARANTINE', 'REDISCOVER']).toContain(action.type);
    }
  });
});

describe('composeHealPrompt', () => {
  it('renders the exact template shape with substitutions', () => {
    const prompt = composeHealPrompt({
      fields: ['price'],
      symptom: 'default/empty values',
      failRate: 0.9,
      date: '2026-08-20',
      entityKey: 'sku',
    });

    expect(prompt).toBe(
      'The field(s) price return default/empty values on 90% of pages since 2026-08-20. ' +
        'Re-capture price from the current markup. Entity check: sku must equal the requested input.'
    );
    expect(prompt.length).toBeLessThanOrEqual(1000);
  });

  it('never exceeds 1000 chars even with a huge field list', () => {
    const fields = Array.from({ length: 500 }, (_, i) => `field_number_${i}_with_a_long_name`);
    const prompt = composeHealPrompt({
      fields,
      symptom: 'default/empty values',
      failRate: 1,
      date: '2026-08-20',
      entityKey: 'sku',
    });
    expect(prompt.length).toBeLessThanOrEqual(1000);
  });
});

describe('causeForErrorCode', () => {
  it('maps terminal_structural codes to STRUCTURAL', () => {
    expect(causeForErrorCode('dead_page')).toBe('STRUCTURAL');
    expect(causeForErrorCode('parse_error')).toBe('STRUCTURAL');
  });

  it('maps validation to DATA', () => {
    expect(causeForErrorCode('validation')).toBe('DATA');
  });

  it('maps an unrecognized (unknown-class) code to DATA, never auto-heal-eligible', () => {
    expect(causeForErrorCode('some_made_up_code')).toBe('DATA');
  });

  it('maps blocked and detect_block specifically to BLOCKED', () => {
    expect(causeForErrorCode('blocked')).toBe('BLOCKED');
    expect(causeForErrorCode('detect_block')).toBe('BLOCKED');
  });

  it('maps compliance (brul) to BLOCKED', () => {
    expect(causeForErrorCode('brul')).toBe('BLOCKED');
  });

  it('maps other retryable_transient codes to NONE (transient noise, not a verdict cause)', () => {
    expect(causeForErrorCode('timeout')).toBe('NONE');
    expect(causeForErrorCode('network_error')).toBe('NONE');
  });

  it('never returns IDENTITY — identity comes only from the identity check', () => {
    const allCodesSample = ['dead_page', 'validation', 'blocked', 'brul', 'timeout', 'unknown_xyz'];
    for (const code of allCodesSample) {
      expect(causeForErrorCode(code)).not.toBe('IDENTITY');
    }
  });
});

describe('worstCause', () => {
  it('orders STRUCTURAL > BLOCKED > DATA > NONE', () => {
    expect(worstCause(['NONE', 'DATA', 'BLOCKED', 'STRUCTURAL'])).toBe('STRUCTURAL');
    expect(worstCause(['NONE', 'DATA', 'BLOCKED'])).toBe('BLOCKED');
    expect(worstCause(['NONE', 'DATA'])).toBe('DATA');
    expect(worstCause(['NONE'])).toBe('NONE');
  });

  it('returns NONE for an empty list', () => {
    expect(worstCause([])).toBe('NONE');
  });

  it('IDENTITY outranks everything when present', () => {
    expect(worstCause(['STRUCTURAL', 'IDENTITY', 'BLOCKED'])).toBe('IDENTITY');
  });
});

describe('Governor', () => {
  let db: Database.Database;
  let governor: Governor;
  const policy: Policy = {
    max_attempts_per_incident: 2,
    cooldown_minutes: 30,
    daily_heal_budget: 3,
    heal_enabled: true,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    governor = new Governor(db);
  });

  afterEach(() => {
    db.close();
  });

  it('allows a heal attempt with a fresh governor state', () => {
    const gate = governor.canHeal('demo-catalog', '2026-08-20T10:00:00Z', policy);
    expect(gate.allowed).toBe(true);
  });

  it('blocks when heal_enabled is false', () => {
    const gate = governor.canHeal('demo-catalog', '2026-08-20T10:00:00Z', { ...policy, heal_enabled: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/disabled/);
  });

  it('blocks once max_attempts_per_incident is reached for that collector/day', () => {
    governor.recordAttempt('demo-catalog', '2026-08-20T10:00:00Z');
    governor.recordAttempt('demo-catalog', '2026-08-20T11:30:00Z');
    const gate = governor.canHeal('demo-catalog', '2026-08-20T12:00:00Z', policy);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/max_attempts_per_incident/);
  });

  it('blocks while cooldown has not elapsed since the last attempt', () => {
    governor.recordAttempt('demo-catalog', '2026-08-20T10:00:00Z');
    const gate = governor.canHeal('demo-catalog', '2026-08-20T10:10:00Z', policy); // 10m < 30m cooldown
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/cooldown/);
  });

  it('allows again once cooldown has elapsed', () => {
    governor.recordAttempt('demo-catalog', '2026-08-20T10:00:00Z');
    const gate = governor.canHeal('demo-catalog', '2026-08-20T10:31:00Z', policy); // 31m >= 30m cooldown
    expect(gate.allowed).toBe(true);
  });

  it('blocks once the daily_heal_budget is exhausted across ALL collectors for that day', () => {
    governor.recordAttempt('collector-a', '2026-08-20T08:00:00Z');
    governor.recordAttempt('collector-b', '2026-08-20T09:00:00Z');
    governor.recordAttempt('collector-c', '2026-08-20T10:00:00Z');
    // budget is 3; a 4th collector's first attempt today should be blocked
    const gate = governor.canHeal('collector-d', '2026-08-20T11:00:00Z', policy);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/daily_heal_budget/);
  });

  it('does not carry attempt counts across different days', () => {
    governor.recordAttempt('demo-catalog', '2026-08-19T10:00:00Z');
    governor.recordAttempt('demo-catalog', '2026-08-19T11:30:00Z');
    // next day, counters reset
    const gate = governor.canHeal('demo-catalog', '2026-08-20T10:00:00Z', policy);
    expect(gate.allowed).toBe(true);
  });

  it('accepts a raw db path string as well as a Database instance', () => {
    const g2 = new Governor(':memory:');
    const gate = g2.canHeal('x', '2026-08-20T10:00:00Z', policy);
    expect(gate.allowed).toBe(true);
    g2.close();
  });
});

describe('decideWithGovernor', () => {
  let db: Database.Database;
  let governor: Governor;
  const policy: Policy = {
    max_attempts_per_incident: 2,
    cooldown_minutes: 30,
    daily_heal_budget: 10,
    heal_enabled: true,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    governor = new Governor(db);
  });

  afterEach(() => {
    db.close();
  });

  it('passes through REPAIR and records the attempt when the governor allows it', () => {
    const { action } = decideWithGovernor('STRUCTURAL', [failedContract, failedCanary], {
      collector: 'demo-catalog',
      now: '2026-08-20T10:00:00Z',
      policy,
      governor,
      entityKeyField: 'sku',
    });
    expect(action.type).toBe('REPAIR');

    const gate = governor.canHeal('demo-catalog', '2026-08-20T10:00:00Z', policy);
    // one attempt was just recorded, so a same-instant second attempt should
    // now be blocked by max_attempts_per_incident only after a 2nd recordAttempt —
    // here we just confirm the attempt WAS recorded via cooldown blocking immediate reattempt.
    expect(gate.allowed).toBe(false);
  });

  it('downgrades REPAIR to QUARANTINE when the governor blocks it, and does not record an attempt', () => {
    const { verdict, action } = decideWithGovernor('STRUCTURAL', [failedContract, failedCanary], {
      collector: 'demo-catalog',
      now: '2026-08-20T10:00:00Z',
      policy: { ...policy, heal_enabled: false },
      governor,
      entityKeyField: 'sku',
    });
    expect(action.type).toBe('QUARANTINE');
    expect(verdict.code).toBe('FAILED_STRUCTURAL'); // verdict/cause unchanged, only the action is downgraded
    if (action.type === 'QUARANTINE') {
      expect(action.reason).toMatch(/governor/i);
    }
  });

  it('passes through non-REPAIR decisions untouched (no governor check performed)', () => {
    const { action } = decideWithGovernor('DATA', [failedContract], {
      collector: 'demo-catalog',
      now: '2026-08-20T10:00:00Z',
      policy: { ...policy, heal_enabled: false },
      governor,
    });
    expect(action.type).toBe('QUARANTINE');
  });
});
