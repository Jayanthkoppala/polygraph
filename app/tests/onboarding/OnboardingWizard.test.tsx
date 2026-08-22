/** End-to-end through the 403/collectors-unavailable fallback, asserting the pasted key
 * never reappears at ANY later step (KeyPasteStep.test.tsx only covers submit-time). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import * as api from '@/onboarding/api';

vi.mock('@/onboarding/api', async () => {
  const actual = await vi.importActual<typeof import('@/onboarding/api')>('@/onboarding/api');
  return {
    ...actual,
    saveApiKey: vi.fn(),
    connectCollector: vi.fn().mockResolvedValue({
      id: 'amazon-prices',
      name: 'amazon-prices',
      scheduleOwner: 'brightdata',
      autoHeal: false,
      deliveryUrl: 'https://polygraph.test/api/ingest/pgi_test',
    }),
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

const FAKE_KEY = 'brd_customer_hp_never_shown_again_998877';

describe('OnboardingWizard — full fallback path, key never re-rendered', () => {
  it('walks key-paste -> fallback -> connected without representative inputs or schema questions', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'list-unavailable' });
    const onComplete = vi.fn();

    render(<OnboardingWizard initialStage="key-paste" onComplete={onComplete} />);

    // Step 2: paste + submit.
    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: FAKE_KEY } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    // Calm fallback screen — never the user's fault.
    await screen.findByTestId('manual-collector-ids');
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    expect(document.body.textContent).not.toMatch(/your account is broken/i);

    fireEvent.change(screen.getByTestId('manual-collector-ids'), { target: { value: 'amazon-prices' } });
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('onboarding-panel')).getByRole('button', { name: /connect collector/i }));
    });

    const status = await screen.findByTestId('first-verdict-status');
    expect(status).toHaveAttribute('data-verdict-state', 'NOT_CHECKED');
    expect(api.connectCollector).toHaveBeenCalledWith('amazon-prices');
    expect(screen.queryByTestId('canary-inputs')).not.toBeInTheDocument();
    expect(screen.getByTestId('delivery-url')).toHaveTextContent('https://polygraph.test/api/ingest/pgi_test');
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    fireEvent.click(screen.getByTestId('go-to-fleet'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});

describe('the verified-key path reaches ux-spec.md §6\'s payoff screen', () => {
  it('shows "Connected. Found N collectors." with their names BEFORE any schema-confirm screen', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({
      kind: 'verified',
      last4: '3f2a',
      collectors: [
        { id: 'amazon-prices', name: 'amazon-prices' },
        { id: 'shopify-skus', name: 'shopify-skus' },
      ],
    });

    render(<OnboardingWizard initialStage="key-paste" />);
    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: FAKE_KEY } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });

    // `KEY_VERIFIED` sets `candidates` and `stage` in one transition, so a wizard
    // branching on the candidate before the stage skips this screen. It did.
    const list = await screen.findByTestId('discovered-collectors');
    expect(within(list).getAllByText('amazon-prices').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('shopify-skus').length).toBeGreaterThan(0);
    expect(screen.getByText(/found 2 collectors on the key ending 3f2a/i)).toBeInTheDocument();
    expect(screen.queryByTestId('canary-inputs')).not.toBeInTheDocument();

    // Only then does the connection call reach the awaiting-result handoff.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /connect selected collector/i }));
    });
    expect(api.connectCollector).toHaveBeenCalledWith('amazon-prices');
    expect(await screen.findByTestId('first-verdict-status')).toBeInTheDocument();
    expect(screen.getByTestId('delivery-url')).toHaveTextContent('https://polygraph.test/api/ingest/pgi_test');
    expect(screen.queryByTestId('canary-inputs')).not.toBeInTheDocument();
  });
});
