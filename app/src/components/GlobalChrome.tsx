import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Dither from './Dither';
import './GlobalChrome.css';

export const START_PROOF_EVENT = 'polygraph:start-proof';
export const HOME_EVENT = 'polygraph:home';
export const RECEIPT_EVENT = 'polygraph:receipt';
export const PROOF_REQUEST_EVENT = 'polygraph:proof-request';
export const RECEIPT_STATE_EVENT = 'polygraph:receipt-state';

type ProofRequestDetail = { pending: boolean };
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  ));
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

export function GlobalChrome({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null!);
  const location = useLocation();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const [proofPending, setProofPending] = useState(false);

  useEffect(() => {
    const updateProofState = (event: Event) => {
      setProofPending(Boolean((event as CustomEvent<ProofRequestDetail>).detail?.pending));
    };
    window.addEventListener(PROOF_REQUEST_EVENT, updateProofState);
    return () => window.removeEventListener(PROOF_REQUEST_EVENT, updateProofState);
  }, []);

  function openProof() {
    if (location.pathname === '/live-proof') {
      window.dispatchEvent(new Event(START_PROOF_EVENT));
      return;
    }
    navigate('/live-proof?stage=collect');
  }

  function showOverview() {
    navigate('/how-it-works');
  }

  return (
    <div ref={rootRef} className="global-chrome">
      <div className="global-chrome__dither" aria-hidden="true">
        <Dither
          className="h-full w-full"
          waveColor={[0, 0.06274509803921569, 0.792156862745098]}
          waveSpeed={0.05}
          waveFrequency={3}
          waveAmplitude={0.3}
          colorNum={4}
          pixelSize={2}
          enableMouseInteraction={!reducedMotion}
          mouseRadius={0.3}
          disableAnimation={reducedMotion}
          eventSource={rootRef}
        />
      </div>
      <div className="global-chrome__shade" aria-hidden="true" />
      <header className="poly-floating-nav">
        <button
          type="button"
          className="poly-nav-brand"
          onClick={() => navigate('/')}
          aria-label="Polygraph home"
        >
          <BrandMark />
          <span>Polygraph</span>
        </button>
        <nav className="poly-nav-links" aria-label="Primary">
          <button type="button" data-proof-action aria-current={location.pathname === '/live-proof' ? 'page' : undefined} disabled={proofPending} onClick={openProof}>Live proof</button>
          <button type="button" aria-current={location.pathname === '/how-it-works' ? 'page' : undefined} onClick={showOverview}>How it works</button>
          <Link to="/receipts" aria-current={location.pathname === '/receipts' ? 'page' : undefined}>Receipts</Link>
        </nav>
        <div className="poly-nav-actions">
          <Link className="poly-nav-connect" to="/signup">Connect</Link>
          <button
            type="button"
            className="poly-nav-cta"
            disabled={proofPending}
            onClick={openProof}
          >
            {proofPending ? 'Starting proof…' : 'Start proof'} <ArrowRight weight="bold" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="global-chrome__content">{children}</div>
    </div>
  );
}

export function BrandMark() {
  return (
    <span className="poly-brand-mark" aria-hidden="true">
      <span />
    </span>
  );
}
