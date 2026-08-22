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
type ReceiptStateDetail = { available: boolean };
type ChromeLocationState = { polygraphIntent?: string };

const LANDING_EVENTS = new Set([START_PROOF_EVENT, HOME_EVENT, RECEIPT_EVENT]);

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
  const [receiptAvailable, setReceiptAvailable] = useState(false);

  useEffect(() => {
    const updateProofState = (event: Event) => {
      setProofPending(Boolean((event as CustomEvent<ProofRequestDetail>).detail?.pending));
    };
    window.addEventListener(PROOF_REQUEST_EVENT, updateProofState);
    return () => window.removeEventListener(PROOF_REQUEST_EVENT, updateProofState);
  }, []);

  useEffect(() => {
    const updateReceiptState = (event: Event) => {
      setReceiptAvailable(Boolean((event as CustomEvent<ReceiptStateDetail>).detail?.available));
    };
    window.addEventListener(RECEIPT_STATE_EVENT, updateReceiptState);
    return () => window.removeEventListener(RECEIPT_STATE_EVENT, updateReceiptState);
  }, []);

  useEffect(() => {
    if (location.pathname !== '/') return;
    const intent = (location.state as ChromeLocationState | null)?.polygraphIntent;
    if (!intent || !LANDING_EVENTS.has(intent)) return;
    window.dispatchEvent(new Event(intent));
    navigate(`${location.pathname}${location.hash}`, { replace: true, state: null });
  }, [location.hash, location.pathname, location.state, navigate]);

  useEffect(() => {
    if (location.pathname !== '/' || location.hash !== '#mission-summary') return;
    const frame = window.requestAnimationFrame(() => {
      const overview = document.getElementById('mission-summary');
      overview?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      overview?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.pathname, reducedMotion]);

  function sendToLanding(eventName: string) {
    if (location.pathname === '/') {
      window.dispatchEvent(new Event(eventName));
      return;
    }
    navigate('/', { state: { polygraphIntent: eventName } satisfies ChromeLocationState });
  }

  function showOverview() {
    if (location.pathname !== '/') {
      navigate('/#mission-summary');
      return;
    }
    const overview = document.getElementById('mission-summary');
    overview?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    overview?.focus({ preventScroll: true });
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
          onClick={() => sendToLanding(HOME_EVENT)}
          aria-label="Polygraph home"
        >
          <BrandMark />
          <span>Polygraph</span>
        </button>
        <nav className="poly-nav-links" aria-label="Primary">
          <button type="button" data-proof-action disabled={proofPending} onClick={() => sendToLanding(START_PROOF_EVENT)}>Live proof</button>
          <button type="button" onClick={showOverview}>How it works</button>
          <button
            type="button"
            disabled={location.pathname !== '/' || !receiptAvailable}
            title={location.pathname === '/' && receiptAvailable ? 'Open recovery receipt' : 'Available after verified recovery'}
            onClick={() => sendToLanding(RECEIPT_EVENT)}
          >
            Receipt
          </button>
          <Link to="/signup">Connect</Link>
        </nav>
        <button
          type="button"
          className="poly-nav-cta"
          disabled={proofPending}
          onClick={() => sendToLanding(START_PROOF_EVENT)}
        >
          {proofPending ? 'Starting proof…' : 'Start proof'} <ArrowRight weight="bold" aria-hidden="true" />
        </button>
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
