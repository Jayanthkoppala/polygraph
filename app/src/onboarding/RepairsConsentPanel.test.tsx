/**
 * RepairsConsentPanel — task-9-brief.md's required test: "the repairs
 * confirm dialog cannot be bypassed." Covers both postures:
 *   - `hostedHealAvailable=false` (today's real hosted-v2 default, R6):
 *     the switch is inert — clicking it does nothing, no dialog, no
 *     `onConfirmEnable` call, ever.
 *   - `hostedHealAvailable=true` (future-ready path): clicking the switch
 *     opens the dialog but does NOT enable repairs by itself — only the
 *     dialog's own "Turn on repairs" button does, and Cancel leaves
 *     repairs off with the dialog closed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RepairsConsentPanel } from './RepairsConsentPanel';

afterEach(() => cleanup());

describe('RepairsConsentPanel — hosted v2 default (R6): honest, inert switch', () => {
  it('renders the honest "not available" explanation instead of a working toggle', () => {
    render(<RepairsConsentPanel />);
    expect(screen.getByTestId('repairs-hosted-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('repairs-switch')).toBeDisabled();
  });

  it('clicking the disabled switch never opens the confirm dialog or calls onConfirmEnable', () => {
    const onConfirmEnable = vi.fn();
    render(<RepairsConsentPanel onConfirmEnable={onConfirmEnable} />);
    fireEvent.click(screen.getByTestId('repairs-switch'));
    expect(screen.queryByTestId('repairs-confirm-dialog')).not.toBeInTheDocument();
    expect(onConfirmEnable).not.toHaveBeenCalled();
    expect(screen.getByTestId('repairs-switch')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('RepairsConsentPanel — the confirm dialog cannot be bypassed (future hostedHealAvailable path)', () => {
  it('clicking the switch opens the dialog WITHOUT enabling repairs yet', () => {
    const onConfirmEnable = vi.fn();
    render(<RepairsConsentPanel hostedHealAvailable onConfirmEnable={onConfirmEnable} />);
    fireEvent.click(screen.getByTestId('repairs-switch'));

    expect(screen.getByTestId('repairs-confirm-dialog')).toBeInTheDocument();
    // Still off — the click opened the gate, not the feature.
    expect(screen.getByTestId('repairs-switch')).toHaveAttribute('aria-checked', 'false');
    expect(onConfirmEnable).not.toHaveBeenCalled();
  });

  it('only the dialog\'s own confirm button actually enables repairs', () => {
    const onConfirmEnable = vi.fn();
    render(<RepairsConsentPanel hostedHealAvailable onConfirmEnable={onConfirmEnable} />);
    fireEvent.click(screen.getByTestId('repairs-switch'));
    fireEvent.click(screen.getByTestId('repairs-dialog-confirm'));

    expect(onConfirmEnable).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('repairs-switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('repairs-confirm-dialog')).not.toBeInTheDocument();
  });

  it('Cancel closes the dialog and leaves repairs off', () => {
    const onConfirmEnable = vi.fn();
    render(<RepairsConsentPanel hostedHealAvailable onConfirmEnable={onConfirmEnable} />);
    fireEvent.click(screen.getByTestId('repairs-switch'));
    fireEvent.click(screen.getByTestId('repairs-dialog-cancel'));

    expect(screen.queryByTestId('repairs-confirm-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('repairs-switch')).toHaveAttribute('aria-checked', 'false');
    expect(onConfirmEnable).not.toHaveBeenCalled();
  });

  it('the dialog states the credit-spend and daily-cap facts explicitly, and is the only such dialog rendered', () => {
    render(<RepairsConsentPanel hostedHealAvailable />);
    fireEvent.click(screen.getByTestId('repairs-switch'));
    const dialog = screen.getByTestId('repairs-confirm-dialog');
    expect(dialog.textContent).toMatch(/spend your Bright Data credits/i);
    expect(dialog.textContent).toMatch(/repairs a day/i);
    expect(dialog.textContent).toMatch(/ledger/i);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });
});
