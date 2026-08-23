/** The payoff ("Connected. Found N collectors.") and its 403/unavailable fallback —
 * ux-spec.md §6: fallback copy must never frame it as the user's fault. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollectorsFoundStep, CollectorsFallbackStep } from '@/onboarding/steps/CollectorsStep';

afterEach(() => cleanup());

describe('CollectorsFoundStep', () => {
  const discovered = [
    { id: 'amazon-prices', name: 'amazon-prices' },
    { id: 'shopify-skus', name: 'shopify-skus' },
    { id: 'bestbuy-stock', name: 'bestbuy-stock' },
  ];

  it('shows the payoff with the discovered count and key last4', () => {
    render(<CollectorsFoundStep last4="3f2a" discovered={discovered} onContinue={vi.fn()} />);
    expect(screen.getByText(/Found 3 collectors/)).toBeInTheDocument();
    expect(screen.getByText(/3f2a/)).toBeInTheDocument();
    for (const c of discovered) expect(screen.getAllByText(c.name).length).toBeGreaterThan(0);
  });

  it('defaults the first discovered collector to selected', () => {
    render(<CollectorsFoundStep last4="3f2a" discovered={discovered} onContinue={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });

  it('connecting passes the one selected collector', async () => {
    const onContinue = vi.fn().mockResolvedValue(undefined);
    render(<CollectorsFoundStep last4="3f2a" discovered={discovered} onContinue={onContinue} />);
    fireEvent.click(screen.getByLabelText(/connect shopify-skus/i));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /connect selected collector/i })));
    expect(onContinue).toHaveBeenCalledWith([{ id: 'shopify-skus', name: 'shopify-skus' }]);
  });
});

describe('CollectorsFallbackStep — calm, never the user\'s fault', () => {
  it('never blames the account or calls it broken', () => {
    render(<CollectorsFallbackStep onRetry={vi.fn()} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/your account is broken/i);
    expect(text).not.toMatch(/error/i);
    expect(text).not.toMatch(/problem with your account/i);
    expect(text).toMatch(/couldn't load your collector list/i);
  });

  it('offers a reconnect action instead of an opaque collector-ID textbox', () => {
    const onRetry = vi.fn();
    render(<CollectorsFallbackStep onRetry={onRetry} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reconnect bright data/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
