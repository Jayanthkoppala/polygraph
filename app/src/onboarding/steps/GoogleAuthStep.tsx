import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle, ShieldCheck } from '@phosphor-icons/react';
import { ApiError } from '@/lib/api';
import { fetchGoogleAuthConfig, loginWithGoogleCredential } from '../api';
import './GoogleAuthStep.css';

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleAccountsId {
  initialize(config: { client_id: string; callback: (response: GoogleCredentialResponse) => void }): void;
  renderButton(target: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

let googleScriptPromise: Promise<void> | null = null;

function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;

  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-polygraph-google-auth]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google sign-in could not load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.dataset.polygraphGoogleAuth = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google sign-in could not load'));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
}

export interface GoogleAuthStepProps {
  onAuthenticated?: () => void;
  loadIdentityScript?: () => Promise<void>;
}

export function GoogleAuthStep({
  onAuthenticated,
  loadIdentityScript = loadGoogleIdentityScript,
}: GoogleAuthStepProps) {
  const buttonHost = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'authenticating' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);

    void Promise.all([fetchGoogleAuthConfig(), loadIdentityScript()])
      .then(([config]) => {
        if (cancelled || !buttonHost.current || !window.google?.accounts.id) return;
        window.google.accounts.id.initialize({
          client_id: config.clientId,
          callback: (response) => {
            if (!response.credential || cancelled) return;
            setStatus('authenticating');
            setError(null);
            void loginWithGoogleCredential(response.credential)
              .then(() => {
                if (cancelled) return;
                if (onAuthenticated) onAuthenticated();
                else window.location.assign('/app');
              })
              .catch((reason) => {
                if (cancelled) return;
                setStatus('error');
                setError(reason instanceof ApiError ? reason.message : 'Google sign-in could not be completed.');
              });
          },
        });
        buttonHost.current.replaceChildren();
        window.google.accounts.id.renderButton(buttonHost.current, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          logo_alignment: 'left',
          width: 320,
        });
        setStatus('ready');
      })
      .catch((reason) => {
        if (cancelled) return;
        setStatus('error');
        setError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Google sign-in could not load.');
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, loadIdentityScript, onAuthenticated]);

  return (
    <main className="google-auth-shell">
      <div className="google-auth-noise" aria-hidden />
      <section className="google-auth-story" aria-labelledby="google-auth-title">
        <a className="google-auth-brand" href="/" aria-label="Polygraph home">
          <span className="google-auth-mark" aria-hidden>PG</span>
          <span>POLYGRAPH</span>
        </a>

        <div className="google-auth-copy">
          <p className="google-auth-kicker">CUSTOMER ACCESS</p>
          <h1 id="google-auth-title">Your scrapers already run.<br />Now give them a memory.</h1>
          <p className="google-auth-lede">
            Sign in, connect one Bright Data collector, and Polygraph keeps the contract, the evidence,
            and every decision in one place.
          </p>
        </div>

        <ol className="google-auth-flow" aria-label="Connection flow">
          <li className="is-current"><span>01</span><div><b>Google account</b><small>Create your private workspace</small></div></li>
          <li><span>02</span><div><b>Bright Data</b><small>Verify your API token</small></div></li>
          <li><span>03</span><div><b>Collector</b><small>Choose what Polygraph watches</small></div></li>
          <li><span>04</span><div><b>Delivery</b><small>Receive finished runs</small></div></li>
        </ol>
      </section>

      <section className="google-auth-card" aria-label="Sign in to Polygraph">
        <div className="google-auth-card-glow" aria-hidden />
        <div className="google-auth-card-head">
          <span className="google-auth-live"><i /> LIVE WORKSPACE</span>
          <span>01 / 04</span>
        </div>

        <div className="google-auth-card-body">
          <div className="google-auth-icon"><ShieldCheck size={22} weight="duotone" aria-hidden /></div>
          <p className="google-auth-kicker">IDENTITY</p>
          <h2>Continue with Google</h2>
          <p>One account for your private collector dashboard. No password or magic link to manage.</p>

          <div className="google-auth-button-frame" data-state={status}>
            <div ref={buttonHost} data-testid="google-signin-host" />
            {status === 'loading' && <span className="google-auth-loading">Loading secure sign-in…</span>}
            {status === 'authenticating' && <span className="google-auth-loading">Opening your workspace…</span>}
          </div>

          {error && (
            <div className="google-auth-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
            </div>
          )}

          <div className="google-auth-boundary">
            <CheckCircle size={16} weight="fill" aria-hidden />
            <span>Google confirms who you are. Your Bright Data token is connected separately and encrypted server-side.</span>
          </div>
        </div>

        <a className="google-auth-back" href="/">Return to the story <ArrowUpRight size={14} aria-hidden /></a>
      </section>
    </main>
  );
}
