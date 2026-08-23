import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RepairsTable, repairModeLabel } from '@/recovery/RecoveryTables';
import type { RecoveryRepair } from '@/lib/recoveryApi';

afterEach(() => cleanup());

function repair(overrides: Partial<RecoveryRepair> = {}): RecoveryRepair {
  return {
    id: 'r1',
    collectorId: 'c_shop',
    collectorName: 'Shop Catalog',
    detectedAt: '2026-08-23T10:00:00.000Z',
    verifiedAt: '2026-08-23T10:20:00.000Z',
    fieldsRestored: ['sku', 'price'],
    templateBefore: 't.1',
    templateAfter: 't.2',
    receiptSha256: 'a'.repeat(64),
    status: 'VERIFIED',
    ...overrides,
  };
}

import type { PagerProps } from '@/recovery/RecoveryTables';

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

describe('RepairsTable — Repair column', () => {
  it('labels a bootstrap receipt "First working version" and a baseline one "Field repair"', () => {
    expect(repairModeLabel(repair({ mode: 'bootstrap' }))).toBe('First working version');
    expect(repairModeLabel(repair({ mode: 'baseline' }))).toBe('Field repair');
    expect(repairModeLabel(repair())).toBe('Field repair');

    render(
      <RepairsTable
        repairs={[repair({ id: 'r1', mode: 'bootstrap' }), repair({ id: 'r2', mode: 'baseline' })]}
        loading={false}
        pager={pager}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Repair' })).toBeInTheDocument();
    expect(screen.getByText('First working version')).toBeInTheDocument();
    expect(screen.getByText('Field repair')).toBeInTheDocument();
  });
});
