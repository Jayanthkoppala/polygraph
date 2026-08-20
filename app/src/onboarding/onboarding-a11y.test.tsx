/**
 * Onboarding accessibility + keyboard contract (ux-spec.md §6, ui-system.md
 * §6.4). Everything here was found by auditing the funnel once it was
 * actually reachable in a browser — the whole surface had never been
 * rendered by a human, so none of it had been checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingWizard } from './OnboardingWizard';
import ReactBitsStepper, { Step } from './ReactBitsStepper';
import { CollectorsFallbackStep } from './steps/CollectorsStep';
import { SchemaConfirmStep } from './steps/SchemaConfirmStep';
import { RepairsConsentPanel } from './RepairsConsentPanel';
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

const noop = () => {};

describe('every onboarding input carries a real, associated label', () => {
  it('the manual collector-ID textarea is labelled, not just placeheld', () => {
    render(<CollectorsFallbackStep onContinue={noop} />);
    expect(screen.getByLabelText(/collector ids/i)).toBe(screen.getByTestId('manual-collector-ids'));
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
    expect(rail).toHaveAccessibleName(/step 1 of 3/i);
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveAccessibleName(/step 1/i);
  });

  it('is not dimmed to a disabled treatment just because its dots are not clickable', () => {
    // ux-spec.md §6 makes the 3-dot rail persistent orientation chrome, and
    // ui-system.md §5 forbids the blanket opacity disabled treatment where
    // it costs contrast. `disableStepIndicators` used to also apply
    // `opacity-40` to every indicator, ghosting the only wayfinding the
    // funnel has. Removing a click affordance is not the same as disabling
    // a control.
    render(
      <ReactBitsStepper initialStep={1} disableStepIndicators>
        <Step>one</Step>
        <Step>two</Step>
      </ReactBitsStepper>,
    );
    // Scoped to the rail itself — the Stepper's own footer Back button is a
    // genuinely disabled control and is allowed its dimming.
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
      // A real submit — the button is `type="submit"` inside the form, which
      // is the only reason Enter works. It only stays true while the action
      // lives inside the step's own <form>.
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

  it('focus follows a screen change WITHIN one rail position (collectors-found -> schema-confirm)', async () => {
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

    // Both of these screens sit at rail position 2, so keying focus off the
    // position alone silently skipped this transition.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /watch 1 collector/i }));
    });
    const heading = await screen.findByRole('heading', { name: /point at amazon-prices/i });
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
    // Reproduces exactly what the running demo server does today: no
    // `POST /api/settings/key` route at all, so the save 404s. The shipped
    // copy rendered that as "Bright Data rejected that key. Not Found".
    vi.mocked(api.saveApiKey).mockRejectedValue(new (await vi.importActual<typeof import('./api')>('./api')).ApiError('Not Found', 404));
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
