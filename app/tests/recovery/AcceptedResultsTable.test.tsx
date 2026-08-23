import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AcceptedResultsTable, errorSummaryLabel, type PagerProps } from '@/recovery/RecoveryTables';
import type { RecoveryDelivery } from '@/lib/recoveryApi';

afterEach(() => cleanup());

function delivery(overrides: Partial<RecoveryDelivery> = {}): RecoveryDelivery {
  return {
    id: 'd1',
    receivedAt: '2026-08-23T10:00:00.000Z',
    source: 'webhook',
    providerRunId: 'run-1',
    rowCount: 58,
    verdict: 'PASS',
    cause: 'NONE',
    isBaseline: true,
    testSample: false,
    errorCount: 0,
    errorCodes: {},
    preview: [],
    ...overrides,
  };
}

const pager: PagerProps = {
  page: 1,
  pageSize: 50,
  total: 2,
  startIndex: 0,
  hasNext: false,
  changing: false,
  onPrev: () => {},
  onNext: () => {},
  onPageSizeChange: () => {},
};

describe('AcceptedResultsTable — Errors column', () => {
  it('summarises the count and top code, with every code in the tooltip', () => {
    expect(errorSummaryLabel({ errorCount: 0, errorCodes: {} })).toBeNull();
    expect(errorSummaryLabel({ errorCount: 2, errorCodes: { crawl_error: 2 } })).toEqual({
      label: '2 · crawl_error',
      title: 'crawl_error × 2',
    });
    expect(errorSummaryLabel({ errorCount: 3, errorCodes: { dead_page: 1, blocked: 2 } })).toEqual({
      label: '3 · blocked',
      title: 'blocked × 2\ndead_page × 1',
    });
    // A pre-M016 row may carry a count without codes.
    expect(errorSummaryLabel({ errorCount: 4, errorCodes: {} })).toEqual({ label: '4', title: '4 error record(s)' });
  });

  it('renders an Errors column: "2 · crawl_error" for a delivery with error records and a dash without', () => {
    render(
      <AcceptedResultsTable
        deliveries={[
          delivery({ id: 'd1', errorCount: 2, errorCodes: { crawl_error: 2 } }),
          delivery({ id: 'd2', providerRunId: 'run-2', errorCount: 0, isBaseline: false }),
        ]}
        loading={false}
        pager={pager}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Errors' })).toBeTruthy();
    const cell = screen.getByText('2 · crawl_error');
    expect(cell.getAttribute('title')).toBe('crawl_error × 2');
    const rows = screen.getAllByRole('row');
    // header + 2 body rows; the second body row shows the dash in the Errors column.
    expect(rows).toHaveLength(3);
    expect(rows[2].textContent).toContain('—');
  });
});
