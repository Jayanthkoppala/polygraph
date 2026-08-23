// Plain-language verdicts, the Bright Data-shaped results columns, and the
// sentences a repair receipt tells. All four helpers are pure, so the rules
// are pinned here rather than inferred from rendered markup — the table cases
// below only check that the table actually uses them.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { AcceptedResultsTable, type PagerProps } from '@/recovery/RecoveryTables';
import { successRate, templateLabel, triggerLabel, verdictLabel } from '@/recovery/verdictLabel';
import { brokenChangeSentence, brokenFields, generationLine, repairNarrative } from '@/recovery/repairNarrative';
import type { RecoveryDelivery, RecoveryRepair } from '@/lib/recoveryApi';

afterEach(() => cleanup());

const pager: PagerProps = {
  page: 1,
  pageSize: 50,
  total: 1,
  startIndex: 0,
  hasNext: false,
  changing: false,
  onPrev: () => {},
  onNext: () => {},
  onPageSizeChange: () => {},
};

function delivery(overrides: Partial<RecoveryDelivery> = {}): RecoveryDelivery {
  return {
    id: 'd1',
    receivedAt: '2026-08-23T10:00:00.000Z',
    source: 'webhook',
    providerRunId: 'j_1a2b3c4d5e6f',
    rowCount: 118,
    verdict: 'PASS',
    cause: 'NONE',
    isBaseline: true,
    testSample: false,
    errorCount: 2,
    errorCodes: { crawl_error: 2 },
    template: 't_x.4',
    preview: [],
    ...overrides,
  };
}

describe('verdictLabel — the grader speaks English, the code stays in the tooltip', () => {
  it('maps each verdict to plain language and keeps the raw code as the title', () => {
    expect(verdictLabel(delivery({ verdict: 'PASS' }))).toMatchObject({ label: 'Healthy', title: 'PASS (NONE)' });
    expect(verdictLabel(delivery({ verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' }))).toMatchObject({
      label: 'Wrong shape',
      title: 'FAILED_STRUCTURAL (STRUCTURAL)',
    });
    expect(verdictLabel(delivery({ verdict: 'FAILED_CONTRACT', cause: 'BLOCKED' })).label).toBe('Blocked');
    expect(verdictLabel(delivery({ verdict: 'SUSPECT_UNEXPLAINED_ANOMALY', cause: null })).label).toBe('Needs a look');
  });

  it('a delivery with no data rows is an empty delivery, even when it graded PASS', () => {
    expect(verdictLabel(delivery({ rowCount: 0, verdict: 'PASS' })).label).toBe('Empty delivery');
  });

  it('a test sample is muted and carries no verdict chip at all', () => {
    const shown = verdictLabel(delivery({ testSample: true, verdict: 'PASS' }));
    expect(shown.label).toBe('Test sample');
    expect(shown.tone).toBe('muted');
  });

  it('falls back to "Verification run" only for an ungraded verification delivery', () => {
    expect(verdictLabel(delivery({ source: 'verification', verdict: null, cause: null })).label).toBe('Verification run');
    // A verification run that FAILED still says so — the trigger column already
    // says whose run it was.
    expect(verdictLabel(delivery({ source: 'verification', verdict: 'FAILED_STRUCTURAL' })).label).toBe('Wrong shape');
  });
});

describe('results-table column helpers', () => {
  it('names the trigger after who caused the run', () => {
    expect(triggerLabel('webhook')).toBe('Bright Data delivery');
    expect(triggerLabel('verification')).toBe('Polygraph verification run');
  });

  it('shows a template as its version, the full id in the tooltip, and never guesses one', () => {
    expect(templateLabel('t_x.4')).toEqual({ label: 'v4', title: 't_x.4' });
    expect(templateLabel('weird-id')).toEqual({ label: 'weird-id', title: 'weird-id' });
    expect(templateLabel(null).label).toBe('—');
    expect(templateLabel(undefined).label).toBe('—');
  });

  it('computes success as data rows over data rows plus error records', () => {
    expect(successRate({ rowCount: 98, errorCount: 2 })).toBe(0.98);
    expect(successRate({ rowCount: 10, errorCount: 0 })).toBe(1);
    expect(successRate({ rowCount: 0, errorCount: 4 })).toBe(0);
    // Nothing at all is not 0%.
    expect(successRate({ rowCount: 0, errorCount: 0 })).toBeNull();
  });
});

describe('AcceptedResultsTable — the Bright Data runs table', () => {
  it('renders the run id, trigger, template, counts, success rate and a plain-language verdict', () => {
    render(<AcceptedResultsTable deliveries={[delivery()]} loading={false} pager={pager} />);

    for (const header of ['Run ID', 'Trigger', 'Template', 'Rows', 'Errors', 'Success', 'Received', 'Verdict', 'Baseline']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }

    const row = screen.getByRole('table').querySelector('tbody tr')!;
    const cells = within(row as HTMLElement);
    expect(cells.getByText('j_1a2b3c4d5e6f')).toBeInTheDocument();
    expect(cells.getByText('Bright Data delivery')).toBeInTheDocument();
    expect(cells.getByText('v4')).toBeInTheDocument();
    expect(cells.getByText('118')).toBeInTheDocument();
    expect(cells.getByText('2 · crawl_error')).toBeInTheDocument();
    expect(cells.getByText('98%')).toBeInTheDocument();
    expect(cells.getByText('Healthy')).toBeInTheDocument();
    expect(cells.getByText('Baseline')).toBeInTheDocument();
    // The raw grader output never disappears — it is one hover away.
    expect(cells.getByTitle('PASS (NONE)')).toBeInTheDocument();
  });

  it('right-aligns the numeric columns', () => {
    render(<AcceptedResultsTable deliveries={[delivery()]} loading={false} pager={pager} />);
    for (const header of ['Rows', 'Errors', 'Success']) {
      expect(screen.getByRole('columnheader', { name: header }).className).toContain('text-right');
    }
  });

  it('a test sample renders muted, with no verdict chip', () => {
    render(<AcceptedResultsTable deliveries={[delivery({ testSample: true })]} loading={false} pager={pager} />);
    const chip = screen.getByText('Test sample');
    expect(chip.className).not.toContain('rounded-full');
    expect(chip.className).toContain('text-[#71717A]');
  });

  it('shows "—" for a delivery whose template version is not known', () => {
    render(<AcceptedResultsTable deliveries={[delivery({ template: null })]} loading={false} pager={pager} />);
    expect(screen.getByTitle('No template version recorded for this delivery')).toHaveTextContent('—');
  });
});

function repair(overrides: Partial<RecoveryRepair> = {}): RecoveryRepair {
  return {
    id: 'r1',
    collectorId: 'c_shop',
    collectorName: 'Shop Catalog',
    detectedAt: '2026-08-23T10:00:00.000Z',
    verifiedAt: '2026-08-23T10:20:00.000Z',
    fieldsRestored: ['sku', 'price'],
    templateBefore: 't_x.4',
    templateAfter: 't_x.5',
    receiptSha256: 'b'.repeat(64),
    status: 'VERIFIED',
    mode: 'baseline',
    ...overrides,
  };
}

describe('repair receipt sentences', () => {
  it('says what broke, in fields and rows, from the recorded diagnosis', () => {
    const withDetail = repair({
      detail: {
        cycleId: 'cyc_1',
        mode: 'baseline',
        startedAt: null,
        completedAt: null,
        totalDurationMs: null,
        detected: {
          deliveryId: 'd1',
          receivedAt: null,
          rowCount: 120,
          verdict: 'FAILED_STRUCTURAL',
          cause: 'STRUCTURAL',
          errorCount: 0,
          regressedFields: ['sku', 'price'],
          retainedFields: ['title'],
          fields: [],
          baselineRowCount: 118,
          identityOk: true,
        },
        timeline: [],
        publication: {
          providerJobId: null,
          templateBefore: 't_x.4',
          templateAfter: 't_x.5',
          completedSteps: [],
          providerStatus: null,
          statusSequence: [],
          previewFieldsPresent: [],
        },
        verification: {
          runId: null,
          deliveryId: null,
          receivedAt: null,
          rowCount: null,
          verdict: null,
          cause: null,
          fieldsRestored: ['sku', 'price'],
          fieldsRestoredRate: 1,
        },
        receipt: { sha256: 'b'.repeat(64), verifiedAt: null, ledgerEventId: 7 },
      },
    });
    expect(brokenChangeSentence(withDetail)).toBe('2 fields stopped arriving in a 120-row delivery.');
    expect(brokenFields(withDetail)).toEqual(['sku', 'price']);
    expect(generationLine(withDetail)).toBe('Generation v4 → v5');
    expect(repairNarrative(withDetail)).toContain('brought 2 fields back');
  });

  it('falls back to the restored fields when no diagnosis was recorded', () => {
    expect(brokenFields(repair())).toEqual(['sku', 'price']);
    expect(brokenChangeSentence(repair())).toBe('2 fields stopped arriving.');
  });

  it('tells the bootstrap story instead of pretending there was a regression', () => {
    const bootstrap = repair({ mode: 'bootstrap', fieldsRestored: [] });
    expect(brokenChangeSentence(bootstrap)).toMatch(/never produced a delivery matching its declared schema/);
    expect(repairNarrative(bootstrap)).toMatch(/first working extraction/);
  });

  it('omits the generation line rather than showing half a version range', () => {
    expect(generationLine(repair({ templateAfter: null }))).toBeNull();
  });
});
