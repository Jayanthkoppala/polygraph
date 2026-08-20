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

async function renderReady() {
  vi.mocked(api.probeCollectorLive).mockResolvedValue({
    fields: [
      { name: 'sku', type: 'string', sample: 'B08N5WRWNW', everFilled: true },
      { name: 'price', type: 'number', sample: 49.99, everFilled: true },
      { name: 'breadcrumb', type: 'string', sample: 'Electronics > Smart Home', everFilled: false },
    ],
    empty: false,
  });
  render(
    <SchemaConfirmStep collector={collector} position={{ index: 0, total: 1 }} onConfirmed={vi.fn()} onSkippedEmpty={vi.fn()} />,
  );
  await enterCanaryAndRun();
}

describe('the schema table fits its card (the REQUIRED? column must be on screen)', () => {
  it('uses a fixed layout with explicit column widths instead of auto layout', async () => {
    // Measured in Chrome at 1512x805 and again at 1280x700: with the default
    // auto table layout this table rendered 110px wider than the 448px card
    // that contains it, pushing the REQUIRED? column — the only interactive
    // control on ux-spec.md §6's "Confirm what good looks like" screen —
    // past the right edge of an `overflow-x-auto` wrapper with no visible
    // scrollbar. The toggles existed, reported visible, and could not be
    // seen. jsdom cannot measure that, so this guards the layout decision
    // that fixes it.
    await renderReady();
    const table = await screen.findByTestId('schema-confirm-table');
    expect(table.className).toContain('table-fixed');
    const widths = Array.from(table.querySelectorAll('th')).map((th) => th.className);
    expect(widths).toHaveLength(4);
    for (const cls of widths) expect(cls).toMatch(/w-\[\d+%\]/);
  });

  it('every required-toggle is individually addressable by name', async () => {
    await renderReady();
    await screen.findByTestId('schema-confirm-table');
    expect(screen.getByRole('checkbox', { name: /require sku/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /require price/i })).toBeInTheDocument();
  });
});
