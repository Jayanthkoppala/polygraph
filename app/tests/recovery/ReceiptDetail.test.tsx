// The expanded Repairs row. A receipt is the one screen a customer reads to
// decide whether to trust an automatic repair, so these cases pin the whole
// story being present — and the redaction line the story must never cross.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RepairsTable, type PagerProps } from '@/recovery/RecoveryTables';
import { formatDuration, formatPercent, stepLabel } from '@/recovery/ReceiptDetail';
import type { RecoveryRepair, RepairDetail } from '@/lib/recoveryApi';

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

function detail(overrides: Partial<RepairDetail> = {}): RepairDetail {
  return {
    cycleId: 'cyc_1',
    mode: 'baseline',
    startedAt: '2026-08-23T10:00:00.000Z',
    completedAt: '2026-08-23T10:20:00.000Z',
    totalDurationMs: 20 * 60 * 1000,
    detected: {
      deliveryId: 'del_incident',
      receivedAt: '2026-08-23T10:00:00.000Z',
      rowCount: 120,
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      errorCount: 2,
      regressedFields: ['sku', 'price'],
      retainedFields: ['title'],
      fields: [
        { field: 'sku', baselineFill: 1, incidentFill: 0, regression: 'missing', damaged: false },
        { field: 'price', baselineFill: 0.98, incidentFill: 0.12, regression: 'unfilled', damaged: false },
        { field: 'title', baselineFill: 1, incidentFill: 1, regression: null, damaged: false },
      ],
      baselineRowCount: 118,
      identityOk: true,
    },
    timeline: [
      { status: 'REFACTOR_STARTED', at: '2026-08-23T10:01:00.000Z', note: 'template t_x.4', durationMs: 60_000 },
      { status: 'PROVIDER_JOB_STARTED', at: '2026-08-23T10:01:05.000Z', note: 'job_abc', durationMs: 5_000 },
      { status: 'AWAITING_APPROVAL', at: '2026-08-23T10:05:00.000Z', note: null, durationMs: 235_000 },
      { status: 'PREVIEW_CHECKED', at: '2026-08-23T10:05:02.000Z', note: null, durationMs: 2_000 },
      { status: 'APPROVED_AUTOSAVE', at: '2026-08-23T10:05:03.000Z', note: null, durationMs: 1_000 },
      { status: 'PUBLISHED', at: '2026-08-23T10:08:00.000Z', note: null, durationMs: 177_000 },
      { status: 'VERIFYING', at: '2026-08-23T10:08:01.000Z', note: null, durationMs: 1_000 },
      { status: 'VERIFICATION_RUN_STARTED', at: '2026-08-23T10:08:05.000Z', note: 'job_def', durationMs: 4_000 },
      { status: 'TEMPLATE_PUBLISHED', at: '2026-08-23T10:18:00.000Z', note: 't_x.5', durationMs: 595_000 },
      { status: 'VERIFIED', at: '2026-08-23T10:20:00.000Z', note: null, durationMs: 120_000 },
    ],
    publication: {
      providerJobId: 'job_abc',
      templateBefore: 't_x.4',
      templateAfter: 't_x.5',
      completedSteps: ['refactor', 'save_new_template'],
      providerStatus: 'published',
      statusSequence: ['awaiting_approval', 'published'],
      previewFieldsPresent: ['sku', 'price', 'title'],
    },
    verification: {
      runId: 'job_def',
      deliveryId: 'del_verification',
      receivedAt: '2026-08-23T10:19:00.000Z',
      rowCount: 121,
      verdict: 'PASS',
      cause: 'NONE',
      fieldsRestored: ['sku', 'price'],
      fieldsRestoredRate: 1,
    },
    receipt: {
      sha256: 'b'.repeat(64),
      verifiedAt: '2026-08-23T10:20:00.000Z',
      ledgerEventId: 4211,
    },
    ...overrides,
  };
}

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
    detail: detail(),
    ...overrides,
  };
}

function expand(name = /show repair receipt/i) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('RepairsTable — a repair row expands into its receipt', () => {
  it('is collapsed until the row is opened', () => {
    render(<RepairsTable repairs={[repair()]} loading={false} pager={pager} />);
    expect(screen.queryByTestId('receipt-detail-r1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show repair receipt for shop catalog/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('renders every recorded step of the repair, in order, with its duration', () => {
    render(<RepairsTable repairs={[repair()]} loading={false} pager={pager} />);
    expand();

    const timeline = within(screen.getByTestId('receipt-timeline'));
    for (const label of [
      'Repair started',
      'Bright Data job accepted',
      'Provider produced a candidate',
      'Preview checked',
      'Approved with auto-save',
      'New template published',
      'Verification started',
      'Fresh verification run',
      'Template version confirmed',
      'Verified',
    ]) {
      expect(timeline.getByText(label)).toBeInTheDocument();
    }

    const steps = screen.getByTestId('receipt-timeline').querySelectorAll('li');
    expect(steps).toHaveLength(10);
    expect(steps[0].textContent).toContain('Repair started');
    expect(steps[steps.length - 1].textContent).toContain('Verified');
    // Durations are rendered per step, not only as one total.
    expect(steps[1].textContent).toContain('+5.0s');
  });

  it('shows the detection facts, the provider ids and the receipt', () => {
    render(<RepairsTable repairs={[repair()]} loading={false} pager={pager} />);
    expand();

    const panel = within(screen.getByTestId('receipt-detail-r1'));
    // Which fields regressed, baseline vs incident fill — names and rates only.
    // Both as a diagnosed field and as a restored one.
    expect(panel.getAllByText('sku').length).toBeGreaterThan(0);
    expect(panel.getAllByText('price').length).toBeGreaterThan(0);
    expect(panel.getByText('100%')).toBeInTheDocument();
    expect(panel.getByText('12%')).toBeInTheDocument();
    // A retained, undamaged field is not part of this repair's story.
    expect(panel.queryByText('title')).not.toBeInTheDocument();

    expect(panel.getByText('FAILED_STRUCTURAL (STRUCTURAL)')).toBeInTheDocument();
    expect(panel.getAllByTitle('job_abc').length).toBeGreaterThan(0);
    expect(panel.getByText('t_x.4 → t_x.5')).toBeInTheDocument();
    expect(panel.getByText('refactor → save_new_template')).toBeInTheDocument();
    expect(panel.getAllByTitle('job_def').length).toBeGreaterThan(0);
    expect(panel.getByText('100% (2)')).toBeInTheDocument();
    expect(panel.getByTitle('b'.repeat(64))).toBeInTheDocument();
    expect(panel.getByText('#4211')).toBeInTheDocument();
  });

  it('labels the mode: a field repair against a baseline, or a first working version', () => {
    render(<RepairsTable repairs={[repair()]} loading={false} pager={pager} />);
    expand();
    expect(within(screen.getByTestId('receipt-detail-r1')).getByText('Field repair')).toBeInTheDocument();
    cleanup();

    render(
      <RepairsTable
        repairs={[
          repair({
            mode: 'bootstrap',
            detail: detail({
              mode: 'bootstrap',
              detected: { ...detail().detected!, regressedFields: [], fields: [] },
              verification: { ...detail().verification, fieldsRestoredRate: null },
            }),
          }),
        ]}
        loading={false}
        pager={pager}
      />,
    );
    expand();
    const panel = within(screen.getByTestId('receipt-detail-r1'));
    expect(panel.getAllByText('First working version').length).toBeGreaterThan(0);
    expect(panel.getByText(/never produced a healthy delivery/i)).toBeInTheDocument();
  });

  it('never renders a row value, a payload, or a provider error — names, rates and ids only', () => {
    render(<RepairsTable repairs={[repair()]} loading={false} pager={pager} />);
    expand();
    const text = screen.getByTestId('receipt-detail-r1').textContent ?? '';
    // The fixture's field names are present; nothing that could be a value is.
    expect(text).toContain('sku');
    expect(text).not.toMatch(/SKU-\d/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/rows_json|rows_preview|secret|token/i);
  });

  it('opens one receipt at a time and closes on a second click', () => {
    render(
      <RepairsTable
        repairs={[repair(), repair({ id: 'r2', collectorName: 'Second Feed' })]}
        loading={false}
        pager={pager}
      />,
    );
    expand(/show repair receipt for shop catalog/i);
    expect(screen.getByTestId('receipt-detail-r1')).toBeInTheDocument();

    expand(/show repair receipt for second feed/i);
    expect(screen.queryByTestId('receipt-detail-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('receipt-detail-r2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hide repair receipt for second feed/i }));
    expect(screen.queryByTestId('receipt-detail-r2')).not.toBeInTheDocument();
  });

  it('falls back to a plain sentence when the server sent no detail, rather than an empty panel', () => {
    const { detail: _drop, ...rest } = repair();
    render(<RepairsTable repairs={[rest as RecoveryRepair]} loading={false} pager={pager} />);
    expand();
    expect(screen.getByText(/full record for this repair is not available/i)).toBeInTheDocument();
  });
});

describe('receipt formatting helpers', () => {
  it('formats durations at the scale a reader can use', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(940)).toBe('940ms');
    expect(formatDuration(5_000)).toBe('5.0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(null)).toBeNull();
  });

  it('formats fill rates as whole percents and unknown as an em dash', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.125)).toBe('13%');
    expect(formatPercent(null)).toBe('—');
  });

  it('shows an unrecognised step code rather than hiding a step that happened', () => {
    expect(stepLabel('VERIFIED')).toBe('Verified');
    expect(stepLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
