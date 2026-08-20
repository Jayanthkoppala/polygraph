/**
 * Evidence translation tests (ux-spec.md §5) — the module this task exists
 * for. Every check type, both pass and fail phrasing, asserted as the
 * COMPARISON sentence itself (never just "some text exists"), plus the
 * hard rule that raw metric identifiers never reach `sentence`/`detail`/
 * `label` for ANY line this module produces.
 */
import { describe, expect, it } from 'vitest';
import { translateEvidence, firstIdentityMismatch, type EvidenceLine } from './evidence';
import type { Evidence } from './api';

const RAW_METRIC_NAMES = [
  'requiredViolationRate',
  'errorRowRate',
  'mismatchRate',
  'collapsedFields',
  'fillRates',
  'passRate',
  'zeroRows',
];

function assertNoRawMetricNames(lines: EvidenceLine[]) {
  for (const line of lines) {
    for (const name of RAW_METRIC_NAMES) {
      expect(line.sentence, `${line.check} sentence leaked "${name}"`).not.toContain(name);
      expect(line.label, `${line.check} label leaked "${name}"`).not.toContain(name);
      if (line.detail) {
        expect(line.detail, `${line.check} detail leaked "${name}"`).not.toContain(name);
      }
    }
  }
}

function byCheck(lines: EvidenceLine[], check: EvidenceLine['check']): EvidenceLine {
  const line = lines.find((l) => l.check === check);
  if (!line) throw new Error(`no ${check} line in translateEvidence output`);
  return line;
}

describe('translateEvidence — always exactly four lines, fixed order', () => {
  it('returns contract, coherence, identity, canary in that order even with empty evidence', () => {
    const lines = translateEvidence({ evidence: [], cause: null, rows: null });
    expect(lines.map((l) => l.check)).toEqual(['contract', 'coherence', 'identity', 'canary']);
  });

  it('never leaks a raw metric name across a representative mixed run', () => {
    const evidence: Evidence[] = [
      {
        check: 'contract',
        ok: false,
        detail: 'requiredViolationRate=0.400, errorRowRate=0.000',
        metrics: {
          fillRates: { price: 0.004, sku: 1, title: 1, stock: 1 },
          requiredViolationRate: 0.4,
          errorRowRate: 0,
        },
      },
      {
        check: 'coherence',
        ok: false,
        detail: 'collapsed field(s): price',
        metrics: { collapsedFields: ['price'], zeroRows: false },
      },
      {
        check: 'identity',
        ok: true,
        detail: 'entity_key matched requested input on all 1204 comparable row(s)',
        metrics: { compared: 1204, mismatched: 0, mismatchRate: 0, mismatches: [] },
      },
    ];
    const lines = translateEvidence({ evidence, cause: 'STRUCTURAL', rows: 1204 });
    assertNoRawMetricNames(lines);
  });
});

describe('contract — comparison, never a lone number', () => {
  it('pass: states the row count and the "no errors" scope', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: true, detail: 'all 3 required field(s) filled across 1204 row(s), no errors', metrics: { fillRates: { sku: 1, title: 1, price: 1 }, requiredViolationRate: 0, errorRowRate: 0 } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: null, rows: 1204 }), 'contract');
    expect(line.status).toBe('pass');
    expect(line.sentence).toBe('Every required field was filled, on all 1,204 row(s), with no errors.');
  });

  it('pass with unknown row count omits the count rather than fabricating one', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: true, detail: 'ok', metrics: { fillRates: { sku: 1 }, requiredViolationRate: 0, errorRowRate: 0 } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: null, rows: null }), 'contract');
    expect(line.sentence).toBe('Every required field was filled, with no errors.');
  });

  it('fail: one collapsed field compared against several unequal peers -> average', () => {
    const evidence: Evidence[] = [
      {
        check: 'contract',
        ok: false,
        detail: 'requiredViolationRate=0.996, errorRowRate=0.000',
        metrics: {
          fillRates: { price: 0.004, sku: 1, title: 0.98, stock: 0.96, rating: 0.99 },
          requiredViolationRate: 0.996,
          errorRowRate: 0,
        },
      },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: 1204 }), 'contract');
    expect(line.status).toBe('fail');
    expect(line.sentence).toBe('price was filled on 0.4% of rows — the other 4 field(s) average 98.2%.');
  });

  it('fail: one collapsed field compared against a handful of EQUAL peers -> named, per the brief\'s own example', () => {
    const evidence: Evidence[] = [
      {
        check: 'contract',
        ok: false,
        detail: 'requiredViolationRate=1.000, errorRowRate=0.000',
        metrics: {
          fillRates: { price: 0, sku: 1, title: 1, stock: 1 },
          requiredViolationRate: 1,
          errorRowRate: 0,
        },
      },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: 12 }), 'contract');
    expect(line.sentence).toBe('price was filled on 0% of rows — sku, title and stock all at 100%.');
  });

  it('fail: errors-only (no field ever collapsed) gets its own error-scoped comparison', () => {
    const evidence: Evidence[] = [
      {
        check: 'contract',
        ok: false,
        detail: 'requiredViolationRate=0.000, errorRowRate=0.150',
        metrics: {
          fillRates: { sku: 1, title: 1 },
          requiredViolationRate: 0,
          errorRowRate: 0.15,
        },
      },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: null, rows: 100 }), 'contract');
    expect(line.sentence).toBe('15% of inputs errored out entirely — every field that did return data was fully filled.');
  });

  it('skipped: a registration gap renders "not checked", never a pass', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: false, detail: 'skipped: no schema registered', metrics: { skipped: true } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'DATA', rows: null }), 'contract');
    expect(line.status).toBe('skipped');
    expect(line.sentence).toBe('Not checked — no schema is registered for this collector.');
  });

  it('absent entirely: still renders a line, never a silent omission', () => {
    const line = byCheck(translateEvidence({ evidence: [], cause: null, rows: null }), 'contract');
    expect(line.status).toBe('skipped');
    expect(line.sentence).toContain('Not checked');
  });
});

describe('coherence — cross-references contract\'s field count for its own comparison', () => {
  it('pass: states the field count, sourced from contract\'s fillRates', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: true, detail: 'ok', metrics: { fillRates: { sku: 1, title: 1, price: 1, stock: 1, rating: 1, reviews: 1, breadcrumb: 1 } } },
      { check: 'coherence', ok: true, detail: 'no field collapse and row count matches', metrics: { collapsedFields: [], zeroRows: false } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: null, rows: null }), 'coherence');
    expect(line.sentence).toBe('No field collapsed. Fill rates are even across all 7 field(s).');
  });

  it('fail: names the collapsed field(s) against the rest, per the exact ux-spec proof line', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: false, detail: 'x', metrics: { fillRates: { sku: 1, title: 1, price: 0.004, stock: 1, rating: 1, reviews: 1, breadcrumb: 1 } } },
      { check: 'coherence', ok: false, detail: 'collapsed field(s): price', metrics: { collapsedFields: ['price'], zeroRows: false } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: null }), 'coherence');
    expect(line.sentence).toBe(
      'Only price collapsed. The other 6 field(s) are untouched — this is one broken extractor, not a dead page.',
    );
  });

  it('fail: zero rows despite the job reporting lines', () => {
    const evidence: Evidence[] = [
      { check: 'coherence', ok: false, detail: 'zero rows returned despite meta.lines=12', metrics: { collapsedFields: [], zeroRows: true } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: null }), 'coherence');
    expect(line.sentence).toContain('zero rows');
    expect(line.status).toBe('fail');
  });

  it('absent entirely: renders "not checked"', () => {
    const line = byCheck(translateEvidence({ evidence: [], cause: null, rows: null }), 'coherence');
    expect(line.status).toBe('skipped');
  });
});

describe('identity — the requested-vs-received comparison', () => {
  it('pass: states the comparable row count', () => {
    const evidence: Evidence[] = [
      { check: 'identity', ok: true, detail: 'entity_key matched requested input on all 1204 comparable row(s)', metrics: { compared: 1204, mismatched: 0, mismatchRate: 0, mismatches: [] } },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: null, rows: null }), 'identity');
    expect(line.sentence).toBe('Every ID requested matched the ID returned, across 1,204 comparable row(s).');
  });

  it('fail: leads with the actual requested/received pair, per the exact ux-spec example', () => {
    const evidence: Evidence[] = [
      {
        check: 'identity',
        ok: false,
        detail: 'mismatchRate=0.036 (43/1204 row(s))',
        metrics: {
          compared: 1204,
          mismatched: 43,
          mismatchRate: 0.0357,
          mismatches: [
            { input: 'SKU-4471', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' },
            { input: 'SKU-4482', requestedKey: 'SKU-4482', extractedKey: 'SKU-9012' },
          ],
        },
      },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'IDENTITY', rows: null }), 'identity');
    expect(line.sentence).toBe('We asked for SKU-4471. The page returned SKU-9012.');
    expect(line.detail).toBe('43 of 1,204 row(s) are the wrong product.');
  });

  it('the entity-key substitution helper returns the same first mismatch VerdictCard needs', () => {
    const evidence: Evidence[] = [
      {
        check: 'identity',
        ok: false,
        detail: 'mismatchRate=0.036 (43/1204 row(s))',
        metrics: { compared: 1204, mismatched: 43, mismatchRate: 0.0357, mismatches: [{ input: 'x', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' }] },
      },
    ];
    expect(firstIdentityMismatch(evidence)).toEqual({ input: 'x', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' });
  });

  it('the substitution helper returns null when identity passed', () => {
    const evidence: Evidence[] = [
      { check: 'identity', ok: true, detail: 'ok', metrics: { compared: 5, mismatched: 0, mismatchRate: 0, mismatches: [] } },
    ];
    expect(firstIdentityMismatch(evidence)).toBeNull();
  });

  it('not applicable: no entity_key configured, distinguished from a registration gap', () => {
    const evidence: Evidence[] = [
      { check: 'identity', ok: true, detail: 'not applicable: no entity_key configured for this collector' },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: null, rows: null }), 'identity');
    expect(line.status).toBe('skipped');
    expect(line.sentence).toContain('no entity key is configured');
  });

  it('absent entirely: renders "not checked"', () => {
    const line = byCheck(translateEvidence({ evidence: [], cause: null, rows: null }), 'identity');
    expect(line.status).toBe('skipped');
  });
});

describe('canary — per-input outcomes with reasons, never a bare pass rate', () => {
  it('pass: states the input count on both sides of the comparison', () => {
    const evidence: Evidence[] = [
      {
        check: 'canary',
        ok: true,
        detail: 'all 5 canary input(s) passed',
        metrics: { outcomes: [1, 2, 3, 4, 5].map((i) => ({ input: `in-${i}`, pass: true })), passCount: 5, failCount: 0, passRate: 1 },
      },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: null }), 'canary');
    expect(line.sentence).toBe('We re-fetched 5 known-good input(s) just now. All 5 came back clean.');
  });

  it('fail: N of M with the actual failure reason, per the brief\'s own example', () => {
    const evidence: Evidence[] = [
      {
        check: 'canary',
        ok: false,
        detail: '2/2 canary input(s) failed',
        metrics: {
          outcomes: [
            { input: 'a', pass: false, reason: 'missing required field(s): price' },
            { input: 'b', pass: false, reason: 'missing required field(s): price' },
          ],
          passCount: 0,
          failCount: 2,
          passRate: 0,
        },
      },
    ];
    const line = byCheck(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: null }), 'canary');
    expect(line.sentence).toBe('We re-fetched 2 known-good input(s) just now. 2 of 2 failed: missing required field(s): price.');
  });

  it('not run for a STRUCTURAL-adjacent cause other than a confirmed structural break: generic reason', () => {
    const line = byCheck(translateEvidence({ evidence: [], cause: 'DATA', rows: null }), 'canary');
    expect(line.status).toBe('skipped');
    expect(line.sentence).toBe('Not run. A canary re-fetch only runs to confirm a suspected structural break.');
  });

  it('not run because the cause is IDENTITY — the exact ux-spec run-detail phrasing', () => {
    const line = byCheck(translateEvidence({ evidence: [], cause: 'IDENTITY', rows: null }), 'canary');
    expect(line.status).toBe('skipped');
    expect(line.sentence).toBe(
      "Not run. A canary re-fetch confirms a broken extractor; it can't confirm the wrong target was served.",
    );
  });
});

describe('never a raw metric name reaches sentence/label/detail, across every branch above', () => {
  it('a full four-check STRUCTURAL failure set', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: false, detail: 'x', metrics: { fillRates: { price: 0, sku: 1, title: 1 }, requiredViolationRate: 1, errorRowRate: 0 } },
      { check: 'coherence', ok: false, detail: 'x', metrics: { collapsedFields: ['price'], zeroRows: false } },
      { check: 'identity', ok: true, detail: 'ok', metrics: { compared: 12, mismatched: 0, mismatchRate: 0, mismatches: [] } },
      { check: 'canary', ok: false, detail: 'x', metrics: { outcomes: [{ input: 'a', pass: false, reason: 'missing required field(s): price' }], passCount: 0, failCount: 1, passRate: 0 } },
    ];
    assertNoRawMetricNames(translateEvidence({ evidence, cause: 'STRUCTURAL', rows: 12 }));
  });

  it('a full four-check IDENTITY failure set', () => {
    const evidence: Evidence[] = [
      { check: 'contract', ok: true, detail: 'x', metrics: { fillRates: { sku: 1, title: 1 }, requiredViolationRate: 0, errorRowRate: 0 } },
      { check: 'coherence', ok: true, detail: 'x', metrics: { collapsedFields: [], zeroRows: false } },
      { check: 'identity', ok: false, detail: 'x', metrics: { compared: 20, mismatched: 20, mismatchRate: 1, mismatches: [{ input: 'a', requestedKey: 'A', extractedKey: 'B' }] } },
    ];
    assertNoRawMetricNames(translateEvidence({ evidence, cause: 'IDENTITY', rows: 20 }));
  });
});
