import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LocalWorkspaceStep } from '@/onboarding/steps/LocalWorkspaceStep';
import * as api from '@/onboarding/api';

vi.mock('@/onboarding/api', async () => {
  const actual = await vi.importActual<typeof import('@/onboarding/api')>('@/onboarding/api');
  return { ...actual, signup: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LocalWorkspaceStep', () => {
  it('creates a browser-local workspace without Google or a form', async () => {
    vi.mocked(api.signup).mockResolvedValue({ token: 'pg_once', tenantId: 'tenant-local' });
    const onWorkspaceCreated = vi.fn();
    render(<LocalWorkspaceStep onWorkspaceCreated={onWorkspaceCreated} />);

    expect(screen.queryByText(/continue with google/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /enter workspace/i }));
    });

    expect(api.signup).toHaveBeenCalledWith(expect.stringMatching(/^browser-/));
    expect(onWorkspaceCreated).toHaveBeenCalledWith({ token: 'pg_once', tenantId: 'tenant-local' });
  });
});
