/**
 * KeyPasteStep — the pasted API key must never be rederable anywhere in
 * this component's own DOM once a submit attempt has started (task-9-
 * brief.md's required test: "the API key is never rendered back after
 * submission — assert it does not appear in the DOM at any later step").
 * The component clears its local `apiKey` state synchronously, before
 * awaiting the network call, so this asserts on the DOM immediately after
 * the click as well as after the async result lands, both for the success
 * and the rejected paths.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyPasteStep } from './KeyPasteStep';
import * as api from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, saveApiKey: vi.fn() };
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

    resolvePromise({ kind: 'verified', last4: '2345', collectors: [{ id: 'a', name: 'a' }] });
    await waitFor(() => expect(document.body.textContent).not.toContain(FAKE_KEY));
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
    // The literal upstream message IS shown — never a generic "something
    // went wrong" (ux-spec.md §6) — but the raw key itself never appears.
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
    expect(screen.getByText(/never start or schedule customer runs/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/trigger a run/i);
  });
});
