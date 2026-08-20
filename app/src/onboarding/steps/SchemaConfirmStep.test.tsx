/**
 * SchemaConfirmStep — the required-fields/entity-key table. Two things
 * this task's binding constraints make load-bearing:
 *   - a zero-row probe must route to `onSkippedEmpty` (NOT VERIFIED,
 *     onboarding continues) rather than ever rendering a table for data
 *     that doesn't exist.
 *   - the table must never show a fabricated fill-rate percentage (see
 *     ../api.ts's module doc on why the real endpoint can't supply one) —
 *     only the honest "Always filled" / "Sometimes empty" signal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SchemaConfirmStep } from './SchemaConfirmStep';
import * as api from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    createCollectorDraft: vi.fn().mockResolvedValue(undefined),
    inferCollectorSchema: vi.fn().mockResolvedValue({ fieldNames: [] }),
    probeCollectorLive: vi.fn(),
    confirmCollectorSchema: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const collector = { id: 'amazon-prices', name: 'amazon-prices' };

async function enterCanaryAndRun(inputValue = 'SKU-4471') {
  fireEvent.change(screen.getByTestId('canary-inputs'), { target: { value: inputValue } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /run it once/i }));
  });
}

describe('SchemaConfirmStep', () => {
  it('a zero-row probe routes to onSkippedEmpty, never renders a fabricated table', async () => {
    vi.mocked(api.probeCollectorLive).mockResolvedValue({ fields: [], empty: true });
    const onSkippedEmpty = vi.fn();
    render(
      <SchemaConfirmStep
        collector={collector}
        position={{ index: 0, total: 1 }}
        onConfirmed={vi.fn()}
        onSkippedEmpty={onSkippedEmpty}
      />,
    );
    await enterCanaryAndRun();
    await waitFor(() => expect(onSkippedEmpty).toHaveBeenCalledWith('amazon-prices'));
    expect(screen.queryByTestId('schema-confirm-table')).not.toBeInTheDocument();
  });

  it('renders honest "Always filled" / "Sometimes empty" signals, never a percentage', async () => {
    vi.mocked(api.probeCollectorLive).mockResolvedValue({
      fields: [
        { name: 'sku', type: 'string', sample: 'SKU-4471', everFilled: true },
        { name: 'breadcrumb', type: 'string', sample: 'Electronics', defaultValue: '', everFilled: false },
      ],
      empty: false,
    });
    render(
      <SchemaConfirmStep collector={collector} position={{ index: 0, total: 1 }} onConfirmed={vi.fn()} onSkippedEmpty={vi.fn()} />,
    );
    await enterCanaryAndRun();

    const table = await screen.findByTestId('schema-confirm-table');
    expect(table.textContent).toMatch(/Always filled/);
    expect(table.textContent).toMatch(/Sometimes empty/);
    // No metric-shaped percentage anywhere in the table.
    expect(table.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('pre-ticks required for always-filled fields and leaves sometimes-empty fields unticked', async () => {
    vi.mocked(api.probeCollectorLive).mockResolvedValue({
      fields: [
        { name: 'sku', type: 'string', sample: 'SKU-4471', everFilled: true },
        { name: 'breadcrumb', type: 'string', sample: 'Electronics', defaultValue: '', everFilled: false },
      ],
      empty: false,
    });
    render(
      <SchemaConfirmStep collector={collector} position={{ index: 0, total: 1 }} onConfirmed={vi.fn()} onSkippedEmpty={vi.fn()} />,
    );
    await enterCanaryAndRun();
    await screen.findByTestId('schema-confirm-table');

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).toBeChecked(); // sku
    expect(checkboxes[1]).not.toBeChecked(); // breadcrumb
  });

  it('confirming calls confirmCollectorSchema then onConfirmed', async () => {
    vi.mocked(api.probeCollectorLive).mockResolvedValue({
      fields: [{ name: 'sku', type: 'string', sample: 'SKU-4471', everFilled: true }],
      empty: false,
    });
    const onConfirmed = vi.fn();
    render(
      <SchemaConfirmStep collector={collector} position={{ index: 0, total: 1 }} onConfirmed={onConfirmed} onSkippedEmpty={vi.fn()} />,
    );
    await enterCanaryAndRun();
    await screen.findByTestId('schema-confirm-table');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /looks right/i }));
    });

    expect(api.confirmCollectorSchema).toHaveBeenCalledWith(
      'amazon-prices',
      [{ name: 'sku', type: 'string', required: true, defaultValue: undefined }],
      'sku',
    );
    expect(onConfirmed).toHaveBeenCalledWith('amazon-prices');
  });
});
