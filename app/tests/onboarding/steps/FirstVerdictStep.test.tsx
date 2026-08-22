/**
 * FirstVerdictStep — task-9-brief.md's required test: "the empty state
 * never renders a pass." A just-confirmed collector has not actually run
 * yet (no "run now" endpoint exists — see the component's own module doc),
 * so this screen must never claim VERIFIED/PASS for anything, no matter
 * how many collectors were just confirmed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FirstVerdictStep } from '@/onboarding/steps/FirstVerdictStep';

const DELIVERY_URL = 'https://polygraph.test/api/ingest/pgi_customer';

afterEach(() => cleanup());

describe('FirstVerdictStep — never a fake pass', () => {
  it('renders an honest NOT_CHECKED status, never PASS/VERIFIED, even with confirmed collectors', () => {
    render(
      <FirstVerdictStep
        confirmedIds={['amazon-prices', 'shopify-skus']}
        deliveryUrl={DELIVERY_URL}
        onGoToFleet={vi.fn()}
      />,
    );
    const status = screen.getByTestId('first-verdict-status');
    expect(status).toHaveAttribute('data-verdict-state', 'NOT_CHECKED');
    expect(status.textContent).toMatch(/awaiting bright data's first delivery/i);
    // The whole rendered screen — not just the status chip — never renders
    // a fabricated PASS/VERIFIED claim anywhere, e.g. in a per-collector
    // list item. (The status copy legitimately says "never a pass" as a
    // promise, which is the opposite of the thing being guarded against —
    // so this checks for an affirmative claim, not the bare substring.)
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/\bpassed\b/);
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/is passing/);
    expect(document.body.textContent?.toLowerCase()).not.toContain('verified ✓');
    expect(document.body.querySelector('[data-verdict-state="VERIFIED"]')).not.toBeInTheDocument();
  });

  it('renders the same honest status with zero collectors confirmed (nothing skipped either)', () => {
    render(<FirstVerdictStep confirmedIds={[]} deliveryUrl={DELIVERY_URL} onGoToFleet={vi.fn()} />);
    expect(screen.getByTestId('first-verdict-status')).toHaveAttribute('data-verdict-state', 'NOT_CHECKED');
  });

  it('states that Bright Data owns scheduling and customer auto-repair remains disabled', () => {
    render(<FirstVerdictStep confirmedIds={['amazon-prices']} deliveryUrl={DELIVERY_URL} onGoToFleet={vi.fn()} />);
    expect(screen.getByText(/bright data still owns the schedule/i)).toBeInTheDocument();
    expect(screen.getByText(/automatic customer repair off/i)).toBeInTheDocument();
  });

  it('shows and copies the one-time Bright Data delivery URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<FirstVerdictStep confirmedIds={['amazon-prices']} deliveryUrl={DELIVERY_URL} onGoToFleet={vi.fn()} />);
    expect(screen.getByTestId('delivery-url')).toHaveTextContent(DELIVERY_URL);
    fireEvent.click(screen.getByRole('button', { name: /copy polygraph delivery url/i }));
    expect(writeText).toHaveBeenCalledWith(DELIVERY_URL);
  });

  it('the CTA hands off to the fleet dashboard rather than rendering a fleet view itself', () => {
    const onGoToFleet = vi.fn();
    render(<FirstVerdictStep confirmedIds={[]} deliveryUrl={DELIVERY_URL} onGoToFleet={onGoToFleet} />);
    fireEvent.click(screen.getByTestId('go-to-fleet'));
    expect(onGoToFleet).toHaveBeenCalledTimes(1);
  });
});
