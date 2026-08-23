/** task-9-brief.md: the pasted key must never be rendered back. State clears
 * synchronously before the await, so both the sync and resolved DOM are asserted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyPasteStep } from '@/onboarding/steps/KeyPasteStep';
import * as api from '@/onboarding/api';

vi.mock('@/onboarding/api', async () => {
  const actual = await vi.importActual<typeof import('@/onboarding/api')>('@/onboarding/api');
  return { ...actual, saveApiKey: vi.fn(), listAvailableCollectors: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FAKE_KEY = 'brd_customer_hp_test_super_secret_value_12345';

describe('KeyPasteStep — the key is never rendered back', () => {
  it('clears the input value immediately on submit, before the network call resolves', async () => {
    let resolvePromise: (v: api.SaveKeyOutcome) => void = () => {};
    vi.mocked(api.saveApiKey).mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );
    render(<KeyPasteStep onVerified={vi.fn()} onRejected={vi.fn()} onListUnavailable={vi.fn()} />);

    const input = screen.getByTestId('api-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: FAKE_KEY } });
    expect(input.value).toBe(FAKE_KEY);

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });

    // Cleared synchronously, well before the pending promise resolves.
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    vi.mocked(api.listAvailableCollectors).mockResolvedValue([{ id: 'a', name: 'a' }]);
    resolvePromise({ kind: 'verified', last4: '2345', collectors: [{ id: 'a', name: 'a' }] });
    await waitFor(() => expect(document.body.textContent).not.toContain(FAKE_KEY));
  });

  it('uses the refreshed server inventory, not a stale list returned when the key was saved', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'verified', last4: '2345', collectors: [{ id: 'stale', name: 'Stale' }] });
    vi.mocked(api.listAvailableCollectors).mockResolvedValue([{ id: 'current', name: 'Current' }]);
    const onVerified = vi.fn();
    render(<KeyPasteStep onVerified={onVerified} onRejected={vi.fn()} onListUnavailable={vi.fn()} />);

    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByTestId('connect-button'));

    await waitFor(() => expect(onVerified).toHaveBeenCalledWith('2345', [{ id: 'current', name: 'Current' }]));
  });

  it('never renders the key on a rejected submission either', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'rejected', message: '401 Unauthorized' });
    const onRejected = vi.fn();
    render(<KeyPasteStep onVerified={vi.fn()} onRejected={onRejected} onListUnavailable={vi.fn()} />);

    const input = screen.getByTestId('api-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: FAKE_KEY } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });

    await waitFor(() => expect(onRejected).toHaveBeenCalledWith('401 Unauthorized'));
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    // Literal upstream message, never a generic "something went wrong" (ux-spec.md §6).
    expect(screen.getByRole('alert').textContent).toContain('401 Unauthorized');
  });

  it('the input type is password and autocomplete is off', () => {
    render(<KeyPasteStep onVerified={vi.fn()} onRejected={vi.fn()} onListUnavailable={vi.fn()} />);
    const input = screen.getByTestId('api-key-input');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });

  it('reassurance text is inline on the same screen as the input, not gated behind a click', () => {
    render(<KeyPasteStep onVerified={vi.fn()} onRejected={vi.fn()} onListUnavailable={vi.fn()} />);
    expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
    expect(screen.getByText(/AES-256-GCM/)).toBeInTheDocument();
    expect(screen.getByText(/take over your day-to-day collector schedule/i)).toBeInTheDocument();
    expect(screen.getByText(/when a structural break is proven/i)).toBeInTheDocument();
  });
});
