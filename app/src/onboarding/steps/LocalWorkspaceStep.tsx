import { useState } from 'react';
import { ArrowRight, Browser, CheckCircle } from '@phosphor-icons/react';
import { ApiError, signup } from '../api';
import './GoogleAuthStep.css';

export interface LocalWorkspaceStepProps {
  onWorkspaceCreated: (result: { token: string; tenantId: string }) => void;
}

function browserWorkspaceName(): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? Math.random().toString(36).slice(2, 10);
  return `browser-${suffix}`;
}

export function LocalWorkspaceStep({ onWorkspaceCreated }: LocalWorkspaceStepProps) {
  const [status, setStatus] = useState<'ready' | 'creating' | 'error'>('ready');
  const [error, setError] = useState<string | null>(null);

  async function enterWorkspace() {
    if (status === 'creating') return;
    setStatus('creating');
    setError(null);
    try {
      const result = await signup(browserWorkspaceName());
      onWorkspaceCreated(result);
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof ApiError ? reason.message : 'Polygraph could not create this workspace. Try again.');
    }
  }

  return (
    <main className="google-auth-shell">
      <div className="google-auth-noise" aria-hidden />
      <section className="google-auth-story" aria-labelledby="local-workspace-title">
        <a className="google-auth-brand" href="/" aria-label="Polygraph home">
          <span className="google-auth-mark" aria-hidden>PG</span>
          <span>POLYGRAPH</span>
        </a>

        <div className="google-auth-copy">
          <p className="google-auth-kicker">INSTANT WORKSPACE</p>
          <h1 id="local-workspace-title">No account wall.<br />Your browser is the key.</h1>
          <p className="google-auth-lede">
            Enter the live product, connect one Bright Data collector, and keep every contract,
            verdict, and recovery receipt in this browser&rsquo;s workspace.
          </p>
        </div>

        <ol className="google-auth-flow" aria-label="Connection flow">
          <li className="is-current"><span>01</span><div><b>Local workspace</b><small>Start in this browser</small></div></li>
          <li><span>02</span><div><b>Bright Data</b><small>Verify your API token</small></div></li>
          <li><span>03</span><div><b>Collector</b><small>Choose what Polygraph watches</small></div></li>
          <li><span>04</span><div><b>Delivery</b><small>Receive finished runs</small></div></li>
        </ol>
      </section>

      <section className="google-auth-card" aria-label="Enter Polygraph">
        <div className="google-auth-card-glow" aria-hidden />
        <div className="google-auth-card-head">
          <span className="google-auth-live"><i /> LIVE WORKSPACE</span>
          <span>01 / 04</span>
        </div>

        <div className="google-auth-card-body">
          <div className="google-auth-icon"><Browser size={22} weight="duotone" aria-hidden /></div>
          <p className="google-auth-kicker">LOCAL ACCESS</p>
          <h2>Enter your workspace</h2>
          <p>No Google account, password, or approval list. This browser remembers where you stopped.</p>

          <button
            type="button"
            className="google-auth-local-button"
            onClick={() => void enterWorkspace()}
            disabled={status === 'creating'}
          >
            {status === 'creating' ? 'Creating workspace…' : 'Enter workspace'}
            {status !== 'creating' && <ArrowRight size={16} weight="bold" aria-hidden />}
          </button>

          {error && (
            <div className="google-auth-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void enterWorkspace()}>Retry</button>
            </div>
          )}

          <div className="google-auth-boundary">
            <CheckCircle size={16} weight="fill" aria-hidden />
            <span>Only an opaque workspace marker is kept locally. Your Bright Data token is encrypted and stored on the Polygraph server.</span>
          </div>
        </div>

        <a className="google-auth-back" href="/">Return to the story</a>
      </section>
    </main>
  );
}
