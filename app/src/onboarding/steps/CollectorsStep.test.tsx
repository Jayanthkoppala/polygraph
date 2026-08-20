/**
 * CollectorsStep — the payoff ("Connected. Found N collectors.") and its
 * calm 403/unavailable fallback. ux-spec.md §6: fallback copy must never
 * frame the situation as the user's fault.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollectorsFoundStep, CollectorsFallbackStep } from './CollectorsStep';

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
    for (const c of discovered) expect(screen.getByText(c.name)).toBeInTheDocument();
  });

  it('defaults every discovered collector to selected', () => {
    render(<CollectorsFoundStep last4="3f2a" discovered={discovered} onContinue={vi.fn()} />);
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).toBeChecked();
    }
  });

  it('continuing passes only the currently-checked collectors', () => {
    const onContinue = vi.fn();
    render(<CollectorsFoundStep last4="3f2a" discovered={discovered} onContinue={onContinue} />);
    fireEvent.click(screen.getByLabelText(/shopify-skus/));
    fireEvent.click(screen.getByRole('button', { name: /watch 2 collectors/i }));
    expect(onContinue).toHaveBeenCalledWith([
      { id: 'amazon-prices', name: 'amazon-prices' },
      { id: 'bestbuy-stock', name: 'bestbuy-stock' },
    ]);
  });
});

describe('CollectorsFallbackStep — calm, never the user\'s fault', () => {
  it('never blames the account or calls it broken', () => {
    render(<CollectorsFallbackStep onContinue={vi.fn()} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/your account is broken/i);
    expect(text).not.toMatch(/error/i);
    expect(text).not.toMatch(/problem with your account/i);
    expect(text).toMatch(/doesn't expose the collector list/i);
  });

  it('parses one collector id per line and continues with them', () => {
    const onContinue = vi.fn();
    render(<CollectorsFallbackStep onContinue={onContinue} />);
    fireEvent.change(screen.getByTestId('manual-collector-ids'), {
      target: { value: 'amazon-prices\n\nshopify-skus\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onContinue).toHaveBeenCalledWith([
      { id: 'amazon-prices', name: 'amazon-prices' },
      { id: 'shopify-skus', name: 'shopify-skus' },
    ]);
  });

  it('continue is disabled with no input', () => {
    render(<CollectorsFallbackStep onContinue={vi.fn()} />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});
