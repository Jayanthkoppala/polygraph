import { describe, expect, it } from 'vitest';
import {
  clampLimit,
  deriveCollectorView,
  HELD_REASON_CODES,
  HELD_REASON_COPY,
  safeHeldReason,
  STATE_COPY,
} from '../../../src/tenancy/recovery/api.js';
import { HOLDING_REASONS, MONITORING_ONLY_REASON } from '../../../src/tenancy/recovery/policy.js';

/**
 * Unit cover for the read-model's two pure decisions: what a collector's chip
 * says, and how a pagination parameter is bounded. Both are contract surface —
 * the strings are pinned by BUILD-PLAN.md and the UI renders them verbatim —
 * so they are tested here rather than only through the HTTP layer.
 */
describe('deriveCollectorView', () => {
  it('reports a collector that has never delivered as waiting for its first healthy delivery', () => {
    expect(deriveCollectorView({ hasActiveInput: false, hasReceipt: false })).toEqual({
      state: 'WAITING_BASELINE',
      state_copy: 'Waiting for first healthy delivery',
      held_reason: null,
    });
  });

  it('keeps WAITING_BASELINE even once an input and a receipt exist — the stored state wins', () => {
    const view = deriveCollectorView({
      state: { state: 'WAITING_BASELINE', held_reason: null },
      hasActiveInput: true,
      hasReceipt: true,
    });
    expect(view.state).toBe('WAITING_BASELINE');
  });

  it('reports READY without a reusable input as monitoring-only, not healthy', () => {
    expect(
      deriveCollectorView({
        state: { state: 'READY', held_reason: null },
        hasActiveInput: false,
        hasReceipt: false,
      })
    ).toEqual({
      state: 'MONITORING_ONLY',
      state_copy: 'Monitoring-only — delivery lacked reusable run input',
      held_reason: null,
    });
  });

  it('reports a monitoring-only collector as monitoring-only even after an older repair', () => {
    // The receipt is history; the collector still cannot be repaired today.
    // Saying "Recovered and verified" here would over-promise.
    const view = deriveCollectorView({
      state: { state: 'READY', held_reason: null },
      hasActiveInput: false,
      hasReceipt: true,
    });
    expect(view.state).toBe('MONITORING_ONLY');
  });

  it('reports an in-flight cycle as recovering', () => {
    expect(
      deriveCollectorView({
        state: { state: 'RECOVERING', held_reason: null },
        hasActiveInput: true,
        hasReceipt: false,
      })
    ).toEqual({ state: 'RECOVERING', state_copy: 'Recovering automatically', held_reason: null });
  });

  it('reports READY with a receipt as recovered and verified', () => {
    expect(
      deriveCollectorView({
        state: { state: 'READY', held_reason: null },
        hasActiveInput: true,
        hasReceipt: true,
      })
    ).toEqual({ state: 'VERIFIED', state_copy: 'Recovered and verified', held_reason: null });
  });

  it('reports READY with an input and no repair history as healthy', () => {
    expect(
      deriveCollectorView({
        state: { state: 'READY', held_reason: null },
        hasActiveInput: true,
        hasReceipt: false,
      })
    ).toEqual({ state: 'READY', state_copy: 'Healthy', held_reason: null });
  });

  it('renders a held collector with the mapped reason, never the stored code', () => {
    const view = deriveCollectorView({
      state: { state: 'HELD', held_reason: 'BUDGET' },
      hasActiveInput: true,
      hasReceipt: false,
    });
    expect(view).toEqual({
      state: 'HELD',
      state_copy: `Recovery held — ${HELD_REASON_COPY.BUDGET}`,
      held_reason: HELD_REASON_COPY.BUDGET,
    });
    expect(view.state_copy).not.toContain('BUDGET');
  });

  it('never echoes an unmapped held reason — provider text cannot reach a response', () => {
    const leak = 'HTTP 500 from https://api.brightdata.com/dca/x?token=sekrit';
    const view = deriveCollectorView({
      state: { state: 'HELD', held_reason: leak },
      hasActiveInput: true,
      hasReceipt: false,
    });
    expect(view.state_copy).toBe('Recovery held — an unexpected condition — contact support');
    expect(JSON.stringify(view)).not.toContain('sekrit');
    expect(JSON.stringify(view)).not.toContain('brightdata');
  });

  it('S2-6: every code a producer can write maps to real copy, never the fallback', () => {
    const producers = [
      // worker (CycleStop.code)
      'PROVIDER_STATE_UNKNOWN', 'VERIFICATION_FAILED', 'PROVIDER_ERROR', 'POLICY', 'BUDGET',
      // ingest
      ...HOLDING_REASONS, 'HELD', 'UNRESOLVED_PROVIDER_JOB', MONITORING_ONLY_REASON,
    ];
    for (const code of producers) {
      expect(HELD_REASON_CODES, code).toContain(code);
      expect(safeHeldReason(code), code).toBe(HELD_REASON_COPY[code as keyof typeof HELD_REASON_COPY]);
      expect(safeHeldReason(code), code).not.toBe('an unexpected condition — contact support');
    }
    // A free-text detail (what used to be written) is NOT a code.
    expect(safeHeldReason('GOVERNOR: heal budget used')).toBe('an unexpected condition — contact support');
  });

  it('falls back for a held collector with no reason recorded at all', () => {
    expect(safeHeldReason(null)).toBe('an unexpected condition — contact support');
    expect(safeHeldReason('')).toBe('an unexpected condition — contact support');
  });

  it('uses exactly the contract copy strings', () => {
    expect(STATE_COPY).toEqual({
      WAITING_BASELINE: 'Waiting for first healthy delivery',
      MONITORING_ONLY: 'Monitoring-only — delivery lacked reusable run input',
      RECOVERING: 'Recovering automatically',
      VERIFIED: 'Recovered and verified',
      READY: 'Healthy',
    });
  });
});

describe('clampLimit', () => {
  it('defaults when the parameter is absent or not a number', () => {
    expect(clampLimit(null)).toBe(50);
    expect(clampLimit('abc')).toBe(50);
    expect(clampLimit('')).toBe(50);
  });

  it('clamps into 1..200 instead of rejecting an out-of-range page size', () => {
    expect(clampLimit('0')).toBe(1);
    expect(clampLimit('-5')).toBe(1);
    expect(clampLimit('10000')).toBe(200);
    expect(clampLimit('200')).toBe(200);
    expect(clampLimit('7')).toBe(7);
  });
});
