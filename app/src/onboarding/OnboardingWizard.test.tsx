/**
 * OnboardingWizard — end-to-end integration through the 403/collectors-
 * unavailable fallback path (task-9-brief.md's named test), starting from
 * `initialStage="key-paste"` (the stage a returning, authenticated-but-
 * keyless tenant would be routed to by Task 10 post-signup-redirect).
 * Re-asserts, across every subsequent screen, that the pasted key is never
 * in the DOM again — the strongest form of "not rendered back": not just
 * immediately after submit (KeyPasteStep.test.tsx covers that in
 * isolation) but at every later step of the whole flow.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OnboardingWizard } from './OnboardingWizard';
import * as api from './api';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    saveApiKey: vi.fn(),
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

describe('OnboardingWizard — full 403 fallback path, key never re-rendered', () => {
  it('walks key-paste -> fallback -> schema-confirm -> first-verdict without ever showing the pasted key again', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'list-unavailable' });
    vi.mocked(api.probeCollectorLive).mockResolvedValue({
      fields: [{ name: 'sku', type: 'string', sample: 'SKU-4471', everFilled: true }],
      empty: false,
    });
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
    // Scoped to this step's own panel: the packaged ReactBits Stepper also
    // renders its own generic (hidden-in-production-CSS, but still present
    // in jsdom without compiled Tailwind) "Continue" button in its footer —
    // see OnboardingWizard.tsx's footerClassName="hidden" comment.
    fireEvent.click(within(screen.getByTestId('onboarding-panel')).getByRole('button', { name: /continue/i }));

    // Schema-confirm: point at the (only) collector, run the probe.
    await screen.findByTestId('canary-inputs');
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    fireEvent.change(screen.getByTestId('canary-inputs'), { target: { value: 'SKU-4471' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run it once/i }));
    });

    const table = await screen.findByTestId('schema-confirm-table');
    expect(table).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /looks right/i }));
    });

    // Only one candidate — straight to first-verdict.
    const status = await screen.findByTestId('first-verdict-status');
    expect(status).toHaveAttribute('data-verdict-state', 'NOT_CHECKED');
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    fireEvent.click(screen.getByTestId('go-to-fleet'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});
