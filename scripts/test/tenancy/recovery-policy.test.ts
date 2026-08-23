import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../../src/core/types.js';
import {
  diagnoseFields,
  evaluateRecoveryEligibility,
  judgeRepair,
  type RecoveryEligibilityInput,
} from '../../../src/tenancy/recovery/policy.js';
import { healthyRows, SCHEMA } from './recovery-harness.js';

/** Evidence the grader would produce for rows that fail contract only. */
function structuralEvidence(collapsed: string[] = []): Evidence[] {
  return [
    { check: 'contract', ok: false, detail: 'requiredViolationRate=1.000', metrics: { fillRates: {} } },
    { check: 'coherence', ok: collapsed.length === 0, detail: '', metrics: { collapsedFields: collapsed } },
    { check: 'identity', ok: true, detail: 'matched' },
  ];
}

function baseInput(overrides: Partial<RecoveryEligibilityInput> = {}): RecoveryEligibilityInput {
  return {
    serverEnabled: true,
    autoHeal: true,
    source: 'webhook',
    baselineRows: healthyRows(),
    hasBaseline: true,
    hasReusableInput: true,
    hasActiveCycle: false,
    governor: { allowed: true },
    schema: SCHEMA,
    entityKey: 'sku',
    incident: {
      rows: healthyRows().map(({ price: _p, ...row }) => row),
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      evidence: structuralEvidence(),
    },
    now: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

describe('evaluateRecoveryEligibility (D7)', () => {
  it('a missing required field against a healthy baseline is eligible, with a redacted heal prompt', () => {
    const result = evaluateRecoveryEligibility(baseInput());
    expect(result.eligible).toBe(true);
    expect(result.evidence.regressed_fields).toEqual(['price']);
    expect(result.evidence.retained_fields).toEqual(['sku', 'title']);
    expect(result.evidence.heal_prompt).toMatch(/price/);
    expect(result.evidence.heal_prompt).toMatch(/sku must equal the requested input/);
    // Redaction: evidence never carries row values or inputs.
    const json = JSON.stringify(result.evidence);
    expect(json).not.toMatch(/shop\.example/);
    expect(json).not.toMatch(/Product 1/);
  });

  it('a type change (number -> string) is eligible even when the grader saw no fill failure', () => {
    const rows = healthyRows().map((row) => ({ ...row, price: `${row.price as number} USD` }));
    const result = evaluateRecoveryEligibility(
      baseInput({
        incident: { rows, verdict: 'SUSPECT_UNEXPLAINED_ANOMALY', cause: 'DATA', evidence: [
          { check: 'contract', ok: true, detail: '' },
          { check: 'coherence', ok: true, detail: '' },
          { check: 'identity', ok: true, detail: '' },
        ] },
      })
    );
    expect(result.eligible).toBe(true);
    expect(result.evidence.fields.find((f) => f.field === 'price')?.regression).toBe('type_change');
  });

  it('a fill collapse flagged by coherence is eligible', () => {
    const rows = healthyRows(10).map((row, i) => (i === 0 ? row : { ...row, price: undefined }));
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows, verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence(['price']) } })
    );
    expect(result.eligible).toBe(true);
    expect(result.evidence.fields.find((f) => f.field === 'price')?.regression).toBe('fill_collapse');
  });

  it('a value-only change (same shape, PASS) is not eligible', () => {
    const rows = healthyRows().map((row) => ({ ...row, price: (row.price as number) * 2 }));
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows, verdict: 'PASS', cause: 'NONE', evidence: [
        { check: 'contract', ok: true, detail: '' },
        { check: 'coherence', ok: true, detail: '' },
        { check: 'identity', ok: true, detail: '' },
      ] } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('HEALTHY');
  });

  it('an ambiguous empty delivery is not eligible', () => {
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows: [], verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence(), errors: [
        { input: null, error_code: 'DELIVERY_EMPTY', message: 'zero rows' },
      ] } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('EMPTY_DELIVERY');
  });

  it('BLOCKED / captcha / login / compliance evidence is never eligible', () => {
    for (const code of ['blocked', 'detect_block', 'captcha_timeout', 'brul', 'login_required']) {
      const result = evaluateRecoveryEligibility(
        baseInput({ incident: { ...baseInput().incident, errors: [{ input: null, error_code: code, message: '' }] } })
      );
      expect(result.eligible, code).toBe(false);
      expect(result.reason, code).toBe('BLOCKED');
    }
    const byCause = evaluateRecoveryEligibility(baseInput({ incident: { ...baseInput().incident, cause: 'BLOCKED' } }));
    expect(byCause.reason).toBe('BLOCKED');
  });

  it('identity instability is never eligible', () => {
    const evidence = structuralEvidence().map((e) => (e.check === 'identity' ? { ...e, ok: false } : e));
    const result = evaluateRecoveryEligibility(baseInput({ incident: { ...baseInput().incident, evidence } }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('IDENTITY_UNSTABLE');
    const byCause = evaluateRecoveryEligibility(baseInput({ incident: { ...baseInput().incident, cause: 'IDENTITY' } }));
    expect(byCause.reason).toBe('IDENTITY_UNSTABLE');
  });

  it('verification-source deliveries are never eligible (non-recursive)', () => {
    const result = evaluateRecoveryEligibility(baseInput({ source: 'verification' }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('VERIFICATION_SOURCE');
  });

  it('requires a baseline, an unpurged baseline payload, a reusable input, no active cycle, auto-heal, and the server switch', () => {
    expect(evaluateRecoveryEligibility(baseInput({ hasBaseline: false, baselineRows: undefined })).reason).toBe('NO_BASELINE');
    expect(evaluateRecoveryEligibility(baseInput({ baselineRows: undefined })).reason).toBe('BASELINE_PAYLOAD_PURGED');
    expect(evaluateRecoveryEligibility(baseInput({ hasReusableInput: false })).reason).toBe('NO_REUSABLE_INPUT');
    expect(evaluateRecoveryEligibility(baseInput({ hasActiveCycle: true })).reason).toBe('ACTIVE_CYCLE');
    expect(evaluateRecoveryEligibility(baseInput({ autoHeal: false })).reason).toBe('AUTO_HEAL_OFF');
    expect(evaluateRecoveryEligibility(baseInput({ serverEnabled: false })).reason).toBe('DISABLED');
  });

  it('the governor gate is honoured and named', () => {
    const result = evaluateRecoveryEligibility(baseInput({ governor: { allowed: false, reason: 'cooldown active, 12m remaining' } }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('GOVERNOR');
    expect(result.detail).toMatch(/cooldown/);
  });

  it('damaged retained fields veto the repair', () => {
    // price missing everywhere (regressed) AND title fell to 50% (damaged, not collapsed by coherence).
    const rows = healthyRows(10).map(({ price: _p, ...row }, i) => (i % 2 === 0 ? row : { ...row, title: undefined }));
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows, verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence() } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('RETAINED_FIELDS_DAMAGED');
    expect(result.evidence.damaged_retained_fields).toEqual(['title']);
    expect(result.evidence.regressed_fields).toEqual(['price']);
  });

  it('a non-structural cause with no field regression is not eligible', () => {
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows: healthyRows(), verdict: 'SUSPECT_UNEXPLAINED_ANOMALY', cause: 'DATA', evidence: structuralEvidence().map((e) => ({ ...e, ok: true })) } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NOT_STRUCTURAL');
  });
});

describe('diagnoseFields / judgeRepair', () => {
  it('classifies missing, type change, collapse and damage per field', () => {
    const baseline = healthyRows(10);
    const incident = baseline.map(({ price: _p, ...row }, i) => ({
      ...row,
      sku: String(i), // still filled, same type
      title: i < 7 ? row.title : undefined, // 70%: damaged
    }));
    const d = Object.fromEntries(diagnoseFields(SCHEMA, baseline, incident).map((x) => [x.field, x]));
    expect(d.price.regression).toBe('missing');
    expect(d.title.regression).toBeNull();
    expect(d.title.damaged).toBe(true);
    expect(d.sku.regression).toBeNull();
    expect(d.sku.damaged).toBe(false);
  });

  it('judgeRepair passes only when regressed fields return and retained ones survive', () => {
    const baseline = healthyRows();
    expect(judgeRepair(SCHEMA, baseline, healthyRows(), ['price']).ok).toBe(true);
    const stillBroken = healthyRows().map(({ price: _p, ...row }) => row);
    const r = judgeRepair(SCHEMA, baseline, stillBroken, ['price']);
    expect(r.ok).toBe(false);
    expect(r.still_regressed).toEqual(['price']);
    const damagedTitle = healthyRows().map(({ title: _t, ...row }) => row);
    const r2 = judgeRepair(SCHEMA, baseline, damagedTitle, ['price']);
    expect(r2.ok).toBe(false);
    expect(r2.damaged_retained).toEqual(['title']);
    expect(judgeRepair(SCHEMA, baseline, [], ['price']).ok).toBe(false);
  });
});
