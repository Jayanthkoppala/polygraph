import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { GoogleAuthStep } from './GoogleAuthStep';
import * as api from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    fetchGoogleAuthConfig: vi.fn(),
    loginWithGoogleCredential: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete window.google;
});

describe('GoogleAuthStep', () => {
  it('renders Google Identity Services and enters the Polygraph session without asking for a fleet name', async () => {
    vi.mocked(api.fetchGoogleAuthConfig).mockResolvedValue({ clientId: 'client.apps.googleusercontent.com' });
    vi.mocked(api.loginWithGoogleCredential).mockResolvedValue(undefined);
    const onAuthenticated = vi.fn();
    let credentialCallback: ((response: { credential: string }) => void) | undefined;
    const loadIdentityScript = vi.fn(async () => {
      window.google = {
        accounts: {
          id: {
            initialize(config) {
              credentialCallback = config.callback;
            },
            renderButton(target) {
              const button = document.createElement('button');
              button.textContent = 'Continue with Google';
              target.appendChild(button);
            },
          },
        },
      };
    });

    render(
      <GoogleAuthStep onAuthenticated={onAuthenticated} loadIdentityScript={loadIdentityScript} />,
    );

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/fleet name/i)).not.toBeInTheDocument();
    await act(async () => credentialCallback?.({ credential: 'signed-id-token' }));

    await waitFor(() => expect(api.loginWithGoogleCredential).toHaveBeenCalledWith('signed-id-token'));
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('keeps a configuration failure visible and retryable', async () => {
    vi.mocked(api.fetchGoogleAuthConfig).mockRejectedValue(new Error('Google sign-in is not configured'));
    render(<GoogleAuthStep loadIdentityScript={async () => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in is not configured');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
