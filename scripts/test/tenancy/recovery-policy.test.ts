import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../../src/core/types.js';
import {
  diagnoseFields,
  evaluateRecoveryEligibility,
  judgeBootstrap,
  judgeRepair,
  structuralErrorHint,
  ERROR_HINT_MAX_LEN,
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

  it('BLOCKED / captcha / login / compliance evidence is never eligible once block records reach BLOCK_HOLD_SHARE', () => {
    // 5 data rows + 15 block records = 75% of the delivery.
    const blockErrors = (code: string) => Array.from({ length: 15 }, () => ({ input: null, error_code: code, message: '' }));
    for (const code of ['blocked', 'detect_block', 'captcha_timeout', 'brul', 'login_required']) {
      const result = evaluateRecoveryEligibility(
        baseInput({ incident: { ...baseInput().incident, errors: blockErrors(code) } })
      );
      expect(result.eligible, code).toBe(false);
      expect(result.reason, code).toBe('BLOCKED');
    }
    const byCause = evaluateRecoveryEligibility(baseInput({ incident: { ...baseInput().incident, cause: 'BLOCKED' } }));
    expect(byCause.reason).toBe('BLOCKED');
  });

  it('a few block records beside a healthy majority are noise: eligibility is decided on the data rows', () => {
    // 5 broken data rows + 1 `blocked` record (17%, under BLOCK_HOLD_SHARE): the structural regression still wins.
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { ...baseInput().incident, errors: [{ input: null, error_code: 'blocked', message: '' }] } })
    );
    expect(result.eligible).toBe(true);
    expect(result.evidence.error_summary).toEqual({ count: 1, codes: { blocked: 1 } });
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

// ---------------------------------------------------------------------------
// Bootstrap repair: a never-healthy collector is repaired against its
// DECLARED schema when a delivery is structurally empty (docs/recovery.md).

/** The live Bright Data shape: every row is `{ input: {...} }` and nothing
 * else — all declared fields 0% filled. */
function emptyRows(count = 6): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ input: { url: `https://shop.example/p/SKU-${i + 1}` } }));
}

function bootstrapInput(overrides: Partial<RecoveryEligibilityInput> = {}): RecoveryEligibilityInput {
  return baseInput({
    hasBaseline: false,
    baselineRows: undefined,
    collectorName: 'Shop Catalog',
    incident: {
      rows: emptyRows(),
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      evidence: structuralEvidence(),
    },
    ...overrides,
  });
}

describe('evaluateRecoveryEligibility — bootstrap repair (no baseline)', () => {
  it('a structurally empty delivery against a schema with required fields is eligible in bootstrap mode', () => {
    const result = evaluateRecoveryEligibility(bootstrapInput());
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('ELIGIBLE');
    expect(result.evidence.mode).toBe('bootstrap');
    expect(result.evidence.regressed_fields).toEqual(['sku', 'price']);
    expect(result.evidence.retained_fields).toEqual([]);
    expect(result.evidence.schema_fields).toEqual([
      { field: 'sku', type: 'text', required: true },
      { field: 'title', type: 'text', required: false },
      { field: 'price', type: 'number', required: true },
    ]);
    expect(result.evidence.fields.map((f) => [f.field, f.incident_fill, f.regression])).toEqual([
      ['sku', 0, 'missing'],
      ['title', 0, null],
      ['price', 0, 'missing'],
    ]);
    // The prompt is composed from the declared schema, names the entity and
    // the key, and never carries a row value or input.
    const prompt = result.evidence.heal_prompt!;
    expect(prompt).toMatch(/returns no fields/);
    expect(prompt).toMatch(/sku \(text, required\)/);
    expect(prompt).toMatch(/price \(number, required\)/);
    expect(prompt).toMatch(/title \(text\)/);
    expect(prompt).toMatch(/for each Shop Catalog on the page/);
    expect(prompt).toMatch(/sku must equal the requested input/);
    expect(prompt.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(result.evidence)).not.toMatch(/shop\.example/);
  });

  it('the bootstrap prompt stays under 1000 chars for a very wide schema', () => {
    const fields: Record<string, { type: string; required?: boolean }> = {};
    for (let i = 0; i < 120; i += 1) fields[`a_rather_long_field_name_${i}`] = { type: 'text', required: i % 2 === 0 };
    const result = evaluateRecoveryEligibility(bootstrapInput({ schema: { fields } }));
    expect(result.eligible).toBe(true);
    expect(result.evidence.heal_prompt!.length).toBeLessThanOrEqual(1000);
    expect(result.evidence.heal_prompt).toMatch(/…/);
  });

  it('a partially filled first delivery is NOT bootstrap-eligible (it needs a real baseline)', () => {
    // sku fills on every row, price on none: a real run with one broken
    // extractor, not an empty one.
    const rows = emptyRows().map((row, i) => ({ ...row, sku: `SKU-${i + 1}` }));
    const result = evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, rows } }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NO_BASELINE');
    expect(result.detail).toMatch(/partially filled/);
    expect(result.evidence.mode).toBeUndefined();
  });

  it('a required field filled in >= 5% of rows is not structurally empty', () => {
    const rows = emptyRows(20).map((row, i) => (i === 0 ? { ...row, sku: 'SKU-1', price: 1 } : row)); // 5%
    expect(evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, rows } })).reason).toBe('NO_BASELINE');
    const rows2 = emptyRows(25).map((row, i) => (i === 0 ? { ...row, sku: 'SKU-1', price: 1 } : row)); // 4%
    expect(evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, rows: rows2 } })).eligible).toBe(true);
  });

  it('a value-only (PASS) first delivery is never bootstrap — it is the baseline', () => {
    const result = evaluateRecoveryEligibility(
      bootstrapInput({ incident: { rows: healthyRows(6), verdict: 'PASS', cause: 'NONE', evidence: structuralEvidence() } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('HEALTHY');
  });

  it('fewer than 5 rows is not enough to call a delivery structurally empty', () => {
    const result = evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, rows: emptyRows(4) } }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NO_BASELINE');
    expect(result.detail).toMatch(/at least 5/);
  });

  it('BLOCKED / captcha evidence is never bootstrap-eligible', () => {
    expect(evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, cause: 'BLOCKED' } })).reason).toBe('BLOCKED');
    expect(
      evaluateRecoveryEligibility(
        bootstrapInput({
          incident: {
            ...bootstrapInput().incident,
            evidence: [...structuralEvidence(), { check: 'canary', ok: false, detail: 'captcha page served' }],
          },
        })
      ).reason
    ).toBe('BLOCKED');
  });

  it('a contradicted identity is never bootstrap-eligible, but an absent identity row is fine', () => {
    const contradicted = structuralEvidence().map((e) => (e.check === 'identity' ? { ...e, ok: false } : e));
    expect(
      evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, evidence: contradicted } })).reason
    ).toBe('IDENTITY_UNSTABLE');
    const absent = structuralEvidence().filter((e) => e.check !== 'identity');
    expect(evaluateRecoveryEligibility(bootstrapInput({ incident: { ...bootstrapInput().incident, evidence: absent } })).eligible).toBe(true);
  });

  it('no reusable input, an active cycle, no required field, or the governor veto bootstrap', () => {
    expect(evaluateRecoveryEligibility(bootstrapInput({ hasReusableInput: false })).reason).toBe('NO_REUSABLE_INPUT');
    expect(evaluateRecoveryEligibility(bootstrapInput({ hasActiveCycle: true })).reason).toBe('ACTIVE_CYCLE');
    expect(evaluateRecoveryEligibility(bootstrapInput({ schema: { fields: { sku: { type: 'text' } } } })).reason).toBe('NO_BASELINE');
    expect(evaluateRecoveryEligibility(bootstrapInput({ schema: undefined })).reason).toBe('NO_BASELINE');
    const governed = evaluateRecoveryEligibility(bootstrapInput({ governor: { allowed: false, reason: 'daily budget exhausted' } }));
    expect(governed.reason).toBe('GOVERNOR');
  });

  it('judgeBootstrap passes only when every required field fills in >= 80% of rows', () => {
    expect(judgeBootstrap(SCHEMA, healthyRows(10)).ok).toBe(true);
    expect(judgeBootstrap(SCHEMA, healthyRows(10)).restored_fields).toEqual(['sku', 'price']);
    const noTitle = healthyRows(10).map(({ title: _t, ...row }) => row);
    expect(judgeBootstrap(SCHEMA, noTitle).ok).toBe(true); // title is optional
    const weakPrice = healthyRows(10).map((row, i) => (i < 3 ? { ...row, price: undefined } : row)); // 70%
    const r = judgeBootstrap(SCHEMA, weakPrice);
    expect(r.ok).toBe(false);
    expect(r.still_regressed).toEqual(['price']);
    expect(r.detail).toMatch(/price=70%/);
    expect(judgeBootstrap(SCHEMA, []).ok).toBe(false);
    expect(judgeBootstrap({ fields: { sku: { type: 'text' } } }, healthyRows()).ok).toBe(false);
  });
});


describe('error records as policy evidence', () => {
  const errs = (code: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ input: { url: `https://shop.example/p/${i}` }, error_code: code, message: `failed ${code}` }));

  it('error_summary carries codes and counts only, for every code including transient ones', () => {
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { ...baseInput().incident, errors: [...errs('crawl_error', 2), ...errs('dead_page', 1)] } })
    );
    expect(result.evidence.error_summary).toEqual({ count: 3, codes: { crawl_error: 2, dead_page: 1 } });
    expect(result.evidence.error_codes).toEqual(['crawl_error', 'dead_page']);
    expect(JSON.stringify(result.evidence)).not.toMatch(/failed |shop\.example/);
  });

  it('the heal prompt hint names structural codes only, under 120 characters', () => {
    expect(structuralErrorHint(undefined)).toBe('');
    expect(structuralErrorHint(errs('crawl_error', 5))).toBe('');
    expect(structuralErrorHint([...errs('dead_page', 3), ...errs('parse_error', 1), ...errs('timeout', 9)])).toBe(
      'Provider error codes: dead_page×3, parse_error×1'
    );
    const many = ['dead_page', 'bad_input', 'parse_error', 'too_many_pages', 'job_run_timeout', 'deadline_timeout', 'uncrawled_page', 'page_too_big', 'parse_req_error', 'parse_mem_limit_exceeded'].flatMap((c) => errs(c, 1));
    const hint = structuralErrorHint(many);
    expect(hint.length).toBeLessThanOrEqual(ERROR_HINT_MAX_LEN);
    expect(hint).toMatch(/^Provider error codes: /);
  });

  it('a minority of structural error records beside healthy data rows is evidence only, never eligibility', () => {
    // 60 healthy rows + 10 dead_page (14%): graded PASS on the data rows → HEALTHY, codes recorded.
    const healthy = evaluateRecoveryEligibility(
      baseInput({ baselineRows: healthyRows(60), incident: { rows: healthyRows(60), errors: errs('dead_page', 10), verdict: 'PASS', cause: 'NONE', evidence: [
        { check: 'contract', ok: true, detail: '' },
        { check: 'coherence', ok: true, detail: '' },
        { check: 'identity', ok: true, detail: '' },
      ] } })
    );
    expect(healthy).toMatchObject({ eligible: false, reason: 'HEALTHY' });
    expect(healthy.evidence.error_summary).toEqual({ count: 10, codes: { dead_page: 10 } });
    // The same minority beside a real data-row regression: eligible on the
    // rows, but the codes did not contribute, so no hint reaches the prompt.
    const regressed = evaluateRecoveryEligibility(
      baseInput({
        baselineRows: healthyRows(60),
        incident: { ...baseInput().incident, rows: healthyRows(60).map(({ price: _p, ...row }) => row), errors: errs('dead_page', 10) },
      })
    );
    expect(regressed.eligible).toBe(true);
    expect(regressed.evidence.regressed_fields).toEqual(['price']);
    expect(regressed.evidence.heal_prompt).not.toMatch(/Provider error codes/);
  });

  it('structural error records dominating a delivery with a few intact rows are eligible with every required field regressed and a hint', () => {
    // 10 healthy rows + 30 dead_page = 75% errors.
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows: healthyRows(10), errors: errs('dead_page', 30), verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence() } })
    );
    expect(result.eligible).toBe(true);
    expect(result.evidence.regressed_fields).toEqual(['sku', 'title', 'price']);
    expect(result.evidence.damaged_retained_fields).toEqual([]);
    expect(result.evidence.heal_prompt).toMatch(/\nProvider error codes: dead_page×30$/);
    expect(result.detail).toMatch(/dominate/);
  });

  it('a baseline incident made only of structural error records is eligible with every baseline field regressed', () => {
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows: [], errors: errs('dead_page', 4), verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence() } })
    );
    expect(result.eligible).toBe(true);
    expect(result.evidence.regressed_fields).toEqual(['sku', 'title', 'price']);
    expect(result.evidence.heal_prompt).toMatch(/\nProvider error codes: dead_page×4$/);
  });

  it('an empty delivery with only transient error records stays EMPTY_DELIVERY', () => {
    const result = evaluateRecoveryEligibility(
      baseInput({ incident: { rows: [], errors: errs('timeout', 4), verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence() } })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('EMPTY_DELIVERY');
  });

  it('bootstrap: structural error records count toward the minimum and make the delivery structurally empty', () => {
    const bootstrap = (errors: ReturnType<typeof errs>) =>
      evaluateRecoveryEligibility(
        baseInput({
          hasBaseline: false,
          baselineRows: undefined,
          collectorName: 'Shop',
          incident: { rows: [], errors, verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence() },
        })
      );
    expect(bootstrap(errs('dead_page', 4))).toMatchObject({ eligible: false, reason: 'NO_BASELINE' });
    const ok = bootstrap(errs('dead_page', 5));
    expect(ok.eligible).toBe(true);
    expect(ok.evidence.mode).toBe('bootstrap');
    expect(ok.evidence.heal_prompt).toMatch(/Provider error codes: dead_page×5/);
    expect(bootstrap(errs('timeout', 9))).toMatchObject({ eligible: false, reason: 'NO_BASELINE' });
  });

  it('bootstrap: a structural minority beside filled rows is not structurally empty and gets no hint', () => {
    const result = evaluateRecoveryEligibility(
      baseInput({
        hasBaseline: false,
        baselineRows: undefined,
        collectorName: 'Shop',
        incident: { rows: healthyRows(20), errors: errs('dead_page', 4), verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL', evidence: structuralEvidence() },
      })
    );
    expect(result).toMatchObject({ eligible: false, reason: 'NO_BASELINE' });
    expect(result.detail).toMatch(/partially filled/);
  });
});
