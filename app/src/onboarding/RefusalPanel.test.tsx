/**
 * RefusalPanel — ux-spec.md §6: calm, bordered, no error styling, no
 * force-repair escape hatch. Three parts always present, in order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RefusalPanel } from './RefusalPanel';

afterEach(() => cleanup());

describe('RefusalPanel', () => {
  it('renders the refusal, the reason, and the one available action, in order', () => {
    render(
      <RefusalPanel
        collectorName="shopify-skus"
        reason="This collector returned perfect data for the wrong product. Re-capturing a field selector can't fix a wrong target."
        ledgerId={1283}
        onRediscover={vi.fn()}
      />,
    );
    expect(screen.getByText('Repair refused.')).toBeInTheDocument();
    expect(screen.getByText(/wrong product/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-discover the target/i })).toBeInTheDocument();
    expect(screen.getByText(/Ledger #1283/)).toBeInTheDocument();
  });

  it('offers no force-repair escape hatch anywhere in the panel', () => {
    render(<RefusalPanel collectorName="x" reason="reason" ledgerId={1} onRediscover={vi.fn()} />);
    const text = document.body.textContent?.toLowerCase() ?? '';
    expect(text).not.toMatch(/force/);
    expect(text).not.toMatch(/repair anyway/);
    // Only one actionable button in the whole panel.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('the rediscover action fires the callback', () => {
    const onRediscover = vi.fn();
    render(<RefusalPanel collectorName="x" reason="reason" ledgerId={1} onRediscover={onRediscover} />);
    fireEvent.click(screen.getByRole('button', { name: /re-discover the target/i }));
    expect(onRediscover).toHaveBeenCalledTimes(1);
  });

  it('handles a null ledgerId (no citation yet) without crashing', () => {
    render(<RefusalPanel collectorName="x" reason="reason" ledgerId={null} onRediscover={vi.fn()} />);
    expect(screen.queryByText(/Ledger #/)).not.toBeInTheDocument();
  });
});
