/** Onboarding a11y + keyboard contract (ux-spec.md §6, ui-system.md §6.4), all of it
 * found by auditing the funnel the first time it was reachable in a browser. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingWizard } from '@/onboarding/OnboardingWizard';
import ReactBitsStepper, { Step } from '@/onboarding/ReactBitsStepper';
import { CollectorsFallbackStep } from '@/onboarding/steps/CollectorsStep';
import { SchemaConfirmStep } from '@/onboarding/steps/SchemaConfirmStep';
import { RepairsConsentPanel } from '@/onboarding/RepairsConsentPanel';
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

const noop = () => {};

describe('every onboarding input carries a real, associated label', () => {
  it('the manual collector-ID textarea is labelled, not just placeheld', () => {
    render(<CollectorsFallbackStep onContinue={noop} />);
    expect(screen.getByLabelText(/collector id/i)).toBe(screen.getByTestId('manual-collector-ids'));
  });

  it('the canary-input textarea is labelled', () => {
    render(
      <SchemaConfirmStep
        collector={{ id: 'amazon-prices', name: 'amazon-prices' }}
        position={{ index: 0, total: 1 }}
        onConfirmed={noop}
        onSkippedEmpty={noop}
      />,
    );
    expect(screen.getByLabelText(/trigger input/i)).toBe(screen.getByTestId('canary-inputs'));
  });

  it('the key-paste input is labelled', () => {
    render(<OnboardingWizard initialStage="key-paste" />);
    expect(screen.getByLabelText(/bright data api key/i)).toBe(screen.getByTestId('api-key-input'));
  });

  it('the repairs switch is named — a wrapping heading does not name a Radix switch', () => {
    render(<RepairsConsentPanel />);
    expect(screen.getByTestId('repairs-switch')).toHaveAccessibleName(/repairs/i);
  });
});

describe('the progress rail', () => {
  it('announces which step of how many, and marks the current one', () => {
    render(<OnboardingWizard initialStage="key-paste" />);
    const rail = screen.getByRole('list', { name: /onboarding progress/i });
    expect(rail).toHaveAccessibleName(/step 2 of 4/i);
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveAccessibleName(/step 2/i);
  });

  it('is not dimmed to a disabled treatment just because its dots are not clickable', () => {
    // The rail is persistent orientation chrome (ux-spec.md §6). `disableStepIndicators`
    // used to also apply `opacity-40`, ghosting the funnel's only wayfinding.
    render(
      <ReactBitsStepper initialStep={1} disableStepIndicators>
        <Step>one</Step>
        <Step>two</Step>
      </ReactBitsStepper>,
    );
    // Scoped to the rail: the footer Back button is genuinely disabled and may dim.
    const rail = screen.getByRole('list', { name: /onboarding progress/i });
    expect(rail.innerHTML).not.toContain('opacity-40');
    expect(rail.innerHTML).toContain('pointer-events-none');
  });
});

describe('keyboard', () => {
  it('the key-paste form submits on Enter from the input alone — no mouse needed', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'list-unavailable' });
    render(<OnboardingWizard initialStage="key-paste" />);

    const input = screen.getByTestId('api-key-input');
    fireEvent.change(input, { target: { value: 'brd_customer_hp_keyboard_only' } });
    await act(async () => {
      // Enter works only because the button is `type="submit"` inside the step's
      // own <form>; move the action out and this breaks.
      fireEvent.submit(input.closest('form')!);
    });

    expect(api.saveApiKey).toHaveBeenCalledOnce();
  });

  it('focus moves to the new step heading when the wizard advances, instead of being dropped on <body>', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'list-unavailable' });
    render(<OnboardingWizard initialStage="key-paste" />);

    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: 'brd_customer_hp_focus_test' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });

    const heading = await screen.findByRole('heading', { name: /point us at your collectors/i });
    expect(document.activeElement).toBe(heading);
  });

  it('focus follows the collector connection into the honest waiting state', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({
      kind: 'verified',
      last4: '3f2a',
      collectors: [{ id: 'amazon-prices', name: 'amazon-prices' }],
    });
    render(<OnboardingWizard initialStage="key-paste" />);
    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: 'brd_customer_hp_focus' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });
    await screen.findByTestId('discovered-collectors');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /connect selected collector/i }));
    });
    const heading = await screen.findByRole('heading', { name: /finish the connection/i });
    expect(document.activeElement).toBe(heading);
  });

  it('does not move focus while the user is still on the key screen (a rejection must not yank focus off the input)', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'rejected', message: '401 Unauthorized' });
    render(<OnboardingWizard initialStage="key-paste" />);
    const input = screen.getByTestId('api-key-input');
    fireEvent.change(input, { target: { value: 'brd_customer_hp_bad' } });
    input.focus();
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });
    await screen.findByTestId('key-reject-alert');
    expect(document.activeElement).toBe(input);
  });

  it('does not steal focus on first paint — arriving at a step is not the same event as advancing to one', () => {
    render(<OnboardingWizard initialStage="key-paste" />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('failure copy never attributes our own outage to Bright Data', () => {
  it('a Polygraph-side error is reported as ours, not as a rejected key', async () => {
    // The demo server has no `POST /api/settings/key`, so the save 404s — shipped
    // copy rendered that as "Bright Data rejected that key. Not Found".
    vi.mocked(api.saveApiKey).mockRejectedValue(new (await vi.importActual<typeof import('@/onboarding/api')>('@/onboarding/api')).ApiError('Not Found', 404));
    render(<OnboardingWizard initialStage="key-paste" />);

    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: 'brd_customer_hp_404' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });

    const alert = await screen.findByTestId('key-reject-alert');
    expect(alert).toHaveAttribute('data-failure-source', 'local');
    expect(alert.textContent).not.toMatch(/bright data rejected/i);
    expect(alert.textContent).toMatch(/polygraph couldn.t save that key/i);
  });

  it('a real upstream rejection still shows the literal upstream reason (ux-spec.md §6)', async () => {
    vi.mocked(api.saveApiKey).mockResolvedValue({ kind: 'rejected', message: '401 Unauthorized from Bright Data' });
    render(<OnboardingWizard initialStage="key-paste" />);

    fireEvent.change(screen.getByTestId('api-key-input'), { target: { value: 'brd_customer_hp_bad' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-button'));
    });

    const alert = await screen.findByTestId('key-reject-alert');
    expect(alert).toHaveAttribute('data-failure-source', 'upstream');
    expect(alert.textContent).toMatch(/bright data rejected that key/i);
    expect(alert.textContent).toMatch(/401 unauthorized from bright data/i);
  });
});
