import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Check } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { HOME_EVENT, PROOF_REQUEST_EVENT, RECEIPT_EVENT, RECEIPT_STATE_EVENT, START_PROOF_EVENT } from '@/components/GlobalChrome';
import {
  createMission,
  getMission,
  resetMission,
  shiftMission,
  type MissionState,
} from './demoMissionApi';
import './MissionExperience.css';

type StoryScene = 'landing' | 'baseline' | 'deploy' | 'broken' | 'diagnosis' | 'heal' | 'proof' | 'replay' | 'connect';
type RequestState = 'idle' | 'start' | 'shift' | 'reset';

const BACKEND_STAGE = {
  landing: 0,
  v1_baseline: 1,
  deploy_wait: 2,
  broken_v2: 3,
  diagnosis: 4,
  self_healing: 5,
  receipt: 6,
} as const;

function errorDetail(error: unknown) {
  return error instanceof Error ? ` ${error.message}` : '';
}

function eventFor(mission: MissionState | null, step: string) {
  return mission?.events.find((event) => event.step === step);
}

function hasReached(mission: MissionState | null, stage: keyof typeof BACKEND_STAGE) {
  return BACKEND_STAGE[mission?.scene ?? 'landing'] >= BACKEND_STAGE[stage];
}

function readableStep(step: string) {
  return step.replace(/[-_.]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerTime(value?: string) {
  if (!value) return 'waiting';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function missionFacts(mission: MissionState | null, step = 'baseline_a') {
  const detail = eventFor(mission, step)?.detail ?? '';
  const match = detail.match(/SKU\s+([^\s,]+).*?\bat\s+([£$€₹]?[0-9][\d.,]*)/i);
  return {
    sku: match?.[1] ?? 'awaiting provider proof',
    price: match?.[2] ?? '—',
  };
}

function evidenceHost(value: string | null) {
  if (!value) return 'polygraph-version-shift-store.vercel.app';
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function SceneButton({ children, onClick, variant = 'primary', disabled = false, testId }: { children: ReactNode; onClick: () => void; variant?: 'primary' | 'ghost'; disabled?: boolean; testId?: string }) {
  return <Button type="button" data-testid={testId} disabled={disabled} onClick={onClick} variant={variant === 'primary' ? 'default' : 'ghost'} className={`pg-action pg-action-${variant}`}>{children}</Button>;
}

function EvidenceLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return null;
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

function StoryTopbar({ mission, label, tone = 'neutral' }: { mission: MissionState; label: string; tone?: 'neutral' | 'pass' | 'warn' | 'fail' }) {
  return (
    <header className="pg-topbar">
      <span className="pg-story-context">LIVE PROOF · OWNED FIXTURE</span>
      <div className="pg-top-meta"><span className="pg-chip pg-chip-muted">MISSION {mission.id} · {mission.status}</span><span className={`pg-chip pg-chip-${tone}`}>{label}</span></div>
    </header>
  );
}

function VersionRail({ active }: { active: 1 | 2 | 3 | 4 }) {
  const steps = ['V1 verified', 'V2 break', 'Recover', 'Prove'];
  return (
    <nav className="pg-version-rail" aria-label="V1 to V2 recovery sequence">
      {steps.map((step, index) => {
        const value = index + 1;
        const failed = active > 2 && value === 2;
        const done = value < active && !failed;
        return <div key={step} className={`pg-version-step ${value === active ? 'active' : ''} ${done ? 'done' : ''} ${failed ? 'failed' : ''}`}><b>0{value}</b> {step}</div>;
      })}
    </nav>
  );
}

// Every mission scene is the same four-part frame: topbar, rail, one stage
// wrapper, command bar. Only `wrap` and the slots differ.
function SceneShell({ state, mission, label, tone, rail, wrap, children, footer }: { state: string; mission: MissionState; label: string; tone?: 'neutral' | 'pass' | 'warn' | 'fail'; rail: 1 | 2 | 3 | 4; wrap: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className={`pg-app ${state}`}><StoryTopbar mission={mission} label={label} tone={tone} /><VersionRail active={rail} />
      <main className="pg-stage"><div className={wrap}>{children}</div></main>
      <footer className="pg-commandbar">{footer}</footer>
    </div>
  );
}

function BrowserDots() {
  return <span className="pg-browser-dots" aria-hidden="true"><i /><i /><i /></span>;
}

function Headphones() {
  return <div className="pg-headphones" aria-hidden="true" />;
}

function ProductBrowser({ version, selector, price, sku, host }: { version: 'V1' | 'V2'; selector: string; price: string; sku: string; host: string }) {
  return (
    <div className="pg-window-inner">
      <div className="pg-browserbar"><BrowserDots /><span className="pg-url">{host}</span><span className="pg-version-badge">{version} · LIVE FIXTURE</span></div>
      <div className="pg-product">
        <div className="pg-product-visual"><Headphones /><span className="pg-stamp">{selector}</span></div>
        <div className="pg-product-info"><span className="pg-eyebrow">OWNED DEMO FIXTURE</span><h2>Aster Noise-Cancelling Headphones</h2><span className="pg-price">{price}</span><span className="pg-stock">In stock · {sku}</span><button type="button" disabled>Fixture preview</button></div>
      </div>
    </div>
  );
}

function LandingScene() {
  return <div className="poly-landing" data-testid="landing-scene" aria-label="Polygraph live proof launch" />;
}

function BaselineScene({ mission, request, onShift, onHome }: { mission: MissionState; request: RequestState; onShift: () => void; onHome: () => void }) {
  const baseline = eventFor(mission, 'baseline_a');
  const facts = missionFacts(mission);
  const ready = mission.status === 'waiting' && Boolean(baseline);
  return (
    <SceneShell state="state-v1" mission={mission} label={ready ? 'V1 PRODUCTION VERIFIED' : 'V1 COLLECTION RUNNING'} tone={ready ? 'pass' : 'warn'} rail={1} wrap="pg-stage-inner pg-stage-v1"
      footer={<><p><b>{ready ? 'Baseline verified' : 'Baseline pending'}</b> · {baseline?.detail ?? 'waiting for provider evidence'}</p><span className={`pg-chip ${ready ? 'pg-chip-pass' : 'pg-chip-muted'}`}>{ready ? 'READY FOR V2' : 'LIVE'}</span></>}>
      <section className="pg-copy"><div className="pg-kicker">OBSERVED · LIVE BACKEND</div><h1 id="mission-title">{ready ? 'V1 is telling the truth.' : 'Establishing the V1 baseline.'}</h1><p className="pg-lede">{baseline?.detail ?? 'Polygraph is waiting for the GitHub marker and Bright Data baseline collection. No success state is inferred locally.'}</p><div className="pg-actions"><SceneButton onClick={onShift} disabled={!ready || request !== 'idle'} testId="shift-v2-btn">{request === 'shift' ? 'Publishing V2…' : 'Publish V2'} <ArrowRight aria-hidden="true" /></SceneButton><SceneButton onClick={onHome} variant="ghost">Back to landing</SceneButton></div><p className="pg-micro">Collection {mission.evidence.baselineRunId ?? 'pending'} · event {providerTime(baseline?.at)} · mission {mission.id}</p></section>
      <section className="pg-window"><ProductBrowser version="V1" selector=".product-price" price={facts.price} sku={facts.sku} host={evidenceHost(mission.evidence.liveFixtureUrl)} /><aside className="pg-floating-output"><span>BRIGHT DATA OUTPUT</span><code>{'{'}<br />&nbsp; sku: "{facts.sku}",<br />&nbsp; price: <strong>{facts.price}</strong><br />{'}'}</code></aside></section>
    </SceneShell>
  );
}

function DeployScene({ mission, onNext }: { mission: MissionState; onNext: () => void }) {
  const steps = [
    { key: 'dispatch_v2', name: 'GitHub V2 workflow dispatched' },
    { key: 'marker_v2', name: 'Exact V2 version marker confirmed' },
  ];
  const canContinue = Boolean(eventFor(mission, 'marker_v2')) && hasReached(mission, 'broken_v2');
  return (
    <SceneShell state="state-deploying" mission={mission} label="V2 DEPLOYMENT OBSERVED" tone="warn" rail={2} wrap="pg-release-wrap"
      footer={<><p><b>Provider-driven progress.</b> The interface advances only after the mission reports the exact live marker and V2 collection state.</p><SceneButton onClick={onNext} disabled={!canContinue} testId="continue-after-deploy">Continue after V2 is observed</SceneButton></>}>
      <section className="pg-fold"><article className="pg-fold-half"><span>V1 · VERIFIED BASELINE</span><div className="pg-mini-product"><Headphones /><div><small>MISSION {mission.id}</small><h2>Verified fixture</h2><strong>{mission.evidence.baselineRunId ?? 'baseline recorded'}</strong><code>.product-price</code></div></div></article><article className="pg-fold-half pg-fold-v2"><span>V2 · GITHUB → LIVE FIXTURE</span><div className="pg-mini-product"><Headphones /><div><small>EXACT VERSION MARKER</small><h2>Changed markup</h2><strong>{eventFor(mission, 'marker_v2') ? 'V2 CONFIRMED' : 'DEPLOYING'}</strong><code>.money-widget__value</code></div></div></article><div className="pg-publish-seam" aria-hidden="true" /></section>
      <aside className="pg-event-card" aria-live="polite"><div className="pg-event-head"><span className="pg-event-signal" aria-hidden="true" /><div><strong>Deploying V2 from GitHub</strong><small>live mission events</small></div><time>{providerTime(mission.events.at(-1)?.at)}</time></div><ol>{steps.map(({ key, name }, index) => { const event = eventFor(mission, key); const current = !event && steps.slice(0, index).every((step) => eventFor(mission, step.key)); return <li key={key} className={event ? 'done' : current ? 'current' : ''}><b>{event ? <Check aria-hidden="true" /> : `0${index + 1}`}</b><span>{name}<small>{event?.detail ?? 'waiting for backend event'}</small></span></li>; })}</ol></aside>
    </SceneShell>
  );
}

function BrokenScene({ mission, onNext }: { mission: MissionState; onNext: () => void }) {
  const difference = eventFor(mission, 'difference');
  const facts = missionFacts(mission);
  const canDiagnose = Boolean(eventFor(mission, 'incident_memory'));
  return (
    <SceneShell state="state-broken" mission={mission} label={difference ? 'V2 BREAK CONFIRMED' : 'V2 COLLECTION RUNNING'} tone="fail" rail={3} wrap="pg-break-wrap"
      footer={<><p><b>Backend evidence</b> · {difference?.detail ?? 'waiting for the V2 collection result'}</p><SceneButton onClick={onNext} disabled={!canDiagnose} testId="open-diagnosis">Open diagnosis <ArrowRight aria-hidden="true" /></SceneButton></>}>
      <section className="pg-window pg-broken-browser"><ProductBrowser version="V2" selector=".money-widget__value" price={facts.price} sku={facts.sku} host={evidenceHost(mission.evidence.liveFixtureUrl)} /><div className="pg-fracture-line" aria-hidden="true" /></section><aside className="pg-output-drawer"><div className="pg-drawer-kicker">{difference ? 'BREAK CONFIRMED' : 'TESTING OLD COLLECTOR'}</div><h1 id="mission-title">{difference ? 'The product stayed the same. The extracted price collapsed.' : 'V2 is live. The existing collector is running.'}</h1><div className="pg-null"><code>price.value</code><strong>{difference ? '0' : '…'}</strong></div><div className="pg-evidence-list"><div>Contract <b className={difference ? 'fail' : ''}>{difference ? 'FAIL' : 'PENDING'}</b></div><div>Identity · {facts.sku} <b>{difference ? 'PASS' : 'PENDING'}</b></div><div>Broken collection <b>{mission.evidence.brokenRunId ?? 'PENDING'}</b></div><div>V1 expected value <b>{facts.price}</b></div></div><div className="pg-dom-seam"><span>OBSERVED MARKUP CHANGE</span><code><del>.product-price</del> → <ins>.money-widget__value</ins></code></div></aside>
    </SceneShell>
  );
}

function DiagnosisScene({ mission, onNext }: { mission: MissionState; onNext: () => void }) {
  const stages = [
    ['Observation', eventFor(mission, 'difference')?.detail],
    ['Reasoning', eventFor(mission, 'incident_memory')?.detail],
    ['Action', eventFor(mission, 'healing_prompt')?.detail],
  ];
  const handoffReady = Boolean(eventFor(mission, 'healing_prompt')) && hasReached(mission, 'self_healing');
  return (
    <SceneShell state="state-diagnosis" mission={mission} label={`MISSION ${mission.id}`} tone="warn" rail={3} wrap="pg-diagnosis-wrap"
      footer={<><p><b>Boundary</b> · the owned fixture may use its allowlisted permit; customer repairs still require approval</p><SceneButton onClick={onNext} disabled={!handoffReady} testId="advance-to-healing">View Self-Healing handoff</SceneButton></>}>
      <section className="pg-copy pg-diagnosis-copy"><div className="pg-kicker">POLYGRAPH DIAGNOSIS</div><h1 id="mission-title">Separate what we saw, why it failed, and what may change.</h1><p className="pg-lede">Every statement below comes from the mission event stream. The interface does not manufacture diagnosis progress.</p></section><section className="pg-reasoning-path">{stages.map(([title, body], index) => <article key={title}><span>{body ? <Check aria-hidden="true" /> : `0${index + 1}`}</span><div><h2>{title}</h2><p>{body ?? 'Waiting for mission evidence.'}</p></div>{index < 2 && <i aria-hidden="true" />}</article>)}</section><aside className="pg-repair-draft"><span>BOUNDED SELF-HEALING HANDOFF</span><p>{eventFor(mission, 'healing_prompt')?.detail ?? 'No repair prompt has been issued.'}</p></aside>
    </SceneShell>
  );
}

function HealScene({ mission, onNext }: { mission: MissionState; onNext: () => void }) {
  const stages = [
    ['Prompt prepared', eventFor(mission, 'healing_prompt')],
    ['Approval boundary observed', eventFor(mission, 'heal_approved')],
    ['Bright Data repair completed', eventFor(mission, 'heal_complete')],
  ] as const;
  const completed = stages.filter(([, event]) => event).length;
  const receipt = eventFor(mission, 'receipt');
  const proofReady = mission.status === 'healed' && Boolean(receipt && mission.evidence.recoveryRunId);
  return (
    <SceneShell state="state-healing" mission={mission} label={proofReady ? 'FRESH RUN VERIFIED' : 'RECOVERY CONTROL ACTIVE'} tone={proofReady ? 'pass' : 'warn'} rail={3} wrap="pg-heal-wrap"
      footer={<><p><b>Verification boundary</b> · recovery is withheld until collection C returns the expected identity and value</p><SceneButton onClick={onNext} disabled={!proofReady} testId="verify-fresh-run">View fresh production proof</SceneButton></>}>
      <section className="pg-repair-copy"><div className="pg-kicker">POLYGRAPH PREPARES · BRIGHT DATA REPAIRS</div><h1 id="mission-title">Recovery has one controlled object.</h1><p className="pg-lede">The backend owns the provider calls. This interface only renders events that the live mission has actually reported.</p><div className="pg-process">{stages.map(([title, event], index) => <div key={title} className={event ? 'done' : index === completed ? 'current' : ''}><span>{event ? <Check aria-hidden="true" /> : `0${index + 1}`}</span><p><strong>{title}</strong><small>{event?.detail ?? 'waiting for backend event'}</small></p></div>)}</div></section><section className="pg-heal-console"><div className="pg-heal-top"><span className="pg-provider-mark">BD</span><div><strong>Bright Data Self-Healing</strong><small>owned fixture · {mission.evidence.collectorId ?? 'collector pending'}</small></div><div><strong>{proofReady ? 'RECOVERY PROVED' : completed === stages.length ? 'FRESH RUN PENDING' : 'HANDOFF IN PROGRESS'}</strong><small>{providerTime(mission.events.at(-1)?.at)}</small></div></div><div className="pg-heal-track"><span style={{ transform: `scaleX(${completed / stages.length})` }} /></div><div className="pg-candidate"><div><span>PROVIDER REPAIR · NOT PRODUCTION PROOF</span><h2>{eventFor(mission, 'heal_complete') ? 'Repair completed by Bright Data' : 'Waiting for the repair result'}</h2><p>heal job {mission.evidence.healRunId ?? 'pending'}</p></div><strong>{eventFor(mission, 'heal_complete') ? 'DONE' : '…'}</strong></div><div className="pg-permit"><b>OWNED-FIXTURE PERMIT</b><span>server-gated to the approved collector and fixture URL</span></div></section>
    </SceneShell>
  );
}

function ProofScene({ mission, request, onConnect, onReplay, onReset }: { mission: MissionState; request: RequestState; onConnect: () => void; onReplay: () => void; onReset: () => void }) {
  const facts = missionFacts(mission, 'receipt');
  return (
    <SceneShell state="state-proof" mission={mission} label="FRESH PRODUCTION VERIFIED" tone="pass" rail={4} wrap="pg-proof-wrap"
      footer={<><p><b>Mission healed</b> · the backend accepted a fresh collection only after checking the expected identity and price</p><SceneButton onClick={onReset} disabled={request !== 'idle'} variant="ghost" testId="reset-v1-btn">{request === 'reset' ? 'Resetting V1…' : 'Reset fixture to V1'}</SceneButton><SceneButton onClick={onReplay}>Open recovery receipt</SceneButton></>}>
      <section className="pg-proof-copy"><div className="pg-kicker">OBSERVED · FRESH PRODUCTION</div><h1 id="mission-title">The loop closes with new evidence.</h1><p className="pg-lede">{eventFor(mission, 'receipt')?.detail ?? 'The backend has not issued a recovery receipt.'}</p><div className="pg-memory"><strong>MISSION {mission.id}</strong><span>{mission.events.length} server-recorded events in the current mission receipt.</span></div><div className="pg-actions"><SceneButton onClick={onConnect} testId="connect-collectors">Connect my collectors</SceneButton><SceneButton onClick={onReplay} variant="ghost">Inspect receipt</SceneButton></div></section><section className="pg-proof-object"><div className="pg-proof-ghost pg-proof-ghost-one" aria-hidden="true" /><div className="pg-proof-ghost pg-proof-ghost-two" aria-hidden="true" /><article className="pg-production-card"><div className="pg-product-visual"><Headphones /></div><div><span>VERIFIED IN PRODUCTION</span><h2>Aster Noise-Cancelling Headphones</h2><div className="pg-production-data"><div><small>SKU</small><strong>{facts.sku}</strong></div><div><small>Expected price</small><strong>{facts.price}</strong></div><div><small>Collection C</small><strong>{mission.evidence.recoveryRunId ?? 'not recorded'}</strong></div></div></div></article><div className="pg-receipt-strip"><b>RECOVERY VERIFIED</b><span>mission {mission.id}</span><span>heal {mission.evidence.healRunId ?? 'recorded'}</span><span>run {mission.evidence.recoveryRunId ?? 'recorded'}</span></div></section>
    </SceneShell>
  );
}

function ReplayScene({ mission, onHome, onProof }: { mission: MissionState; onHome: () => void; onProof: () => void }) {
  return (
    <SceneShell state="state-replay" mission={mission} label="MISSION RECEIPT" tone="pass" rail={4} wrap="pg-replay-wrap"
      footer={<><p><b>Receipt scope</b> · live mission evidence from the current backend process</p><SceneButton onClick={onHome}>Return to launch</SceneButton></>}>
      <section className="pg-replay-copy"><div className="pg-kicker">LIVE MISSION EVIDENCE</div><h1 id="mission-title">Same flow. Server-recorded evidence.</h1><p className="pg-lede">This receipt renders the mission ID, provider events, timestamps and collection IDs returned by the backend. It does not add a fabricated hash or persistence claim.</p><div className="pg-actions"><SceneButton onClick={onHome}>Return to landing</SceneButton><SceneButton onClick={onProof} variant="ghost">Back to recovered state</SceneButton></div><div className="pg-receipt-links"><EvidenceLink href={mission.evidence.fixtureRepo}>Fixture repository</EvidenceLink><EvidenceLink href={mission.evidence.workflowUrl}>GitHub workflow</EvidenceLink><EvidenceLink href={mission.evidence.markerUrl}>Version marker</EvidenceLink><EvidenceLink href={mission.evidence.collectorUrl}>Bright Data collector</EvidenceLink><EvidenceLink href={mission.evidence.baselineRunUrl}>Collection A proof</EvidenceLink><EvidenceLink href={mission.evidence.brokenRunUrl}>Collection B proof</EvidenceLink><EvidenceLink href={mission.evidence.healRunUrl}>Healing proof</EvidenceLink><EvidenceLink href={mission.evidence.recoveryRunUrl}>Collection C proof</EvidenceLink></div></section><section className="pg-receipt"><div className="pg-receipt-head"><span><Check aria-hidden="true" /></span><div><strong>Mission {mission.id}</strong><small>fixture V1 → V2 · collector {mission.evidence.collectorId ?? 'not recorded'}</small></div><span className="pg-chip pg-chip-muted">{mission.status}</span></div><div className="pg-replay-events">{mission.events.map((event) => <div key={`${event.step}-${event.at}`} className={event.step === 'difference' ? 'fail' : 'done'}><time>{providerTime(event.at)}</time><i>{event.step === 'difference' ? '!' : '✓'}</i><strong>{readableStep(event.step)}</strong><small>{event.detail}</small></div>)}</div><div className="pg-receipt-foot"><span>{mission.events.length} mission events</span><span>A {mission.evidence.baselineRunId ?? '—'} · B {mission.evidence.brokenRunId ?? '—'}</span><span>C {mission.evidence.recoveryRunId ?? '—'}</span></div></section>
    </SceneShell>
  );
}

function ConnectScene({ onHome }: { onHome: () => void }) {
  return (
    <div className="px-connect">
      <main className="px-onboard"><aside className="px-onboard-copy"><div className="pg-kicker">REAL CUSTOMER WORKSPACE</div><h1 id="mission-title">Connect Bright Data securely.</h1><p>Continue into Polygraph onboarding to save your API token server-side, choose an existing collector, and open your own collector dashboard. Scheduling remains in Bright Data.</p><div className="px-boundary"><b>Approval boundary</b><span>Customer repairs require approval. The owned-fixture auto-save permit never applies to customer collectors.</span></div></aside>
        <section className="px-connect-panel"><div className="px-panel-head"><div><small>CONNECTION</small><h2>Use the real onboarding flow</h2></div><span>LIVE BACKEND</span></div><p className="pg-lede">Create a Polygraph workspace or sign in to continue. No token is collected by this landing-page component.</p><div className="px-panel-actions"><SceneButton onClick={onHome} variant="ghost">Cancel</SceneButton><a href="/login" className="pg-action pg-action-ghost">Sign in</a><a href="/signup" className="pg-action pg-action-primary">Start secure onboarding</a></div></section>
      </main>
    </div>
  );
}

function sceneForMission(mission: MissionState): StoryScene {
  switch (mission.scene) {
    case 'v1_baseline': return 'baseline';
    case 'deploy_wait': return 'deploy';
    case 'broken_v2': return 'broken';
    case 'diagnosis': return 'diagnosis';
    case 'self_healing': return 'heal';
    case 'receipt': return 'proof';
    default: return 'landing';
  }
}

export function MissionExperience() {
  const reducedMotion = useReducedMotion();
  const [scene, setScene] = useState<StoryScene>('landing');
  const [mission, setMission] = useState<MissionState | null>(null);
  const [request, setRequest] = useState<RequestState>('idle');
  const [apiError, setApiError] = useState<string | null>(null);
  const pollSequence = useRef(0);
  const startRequest = useRef(false);
  const resetConfirmed = Boolean(mission?.status === 'idle' && eventFor(mission, 'reset_v1'));
  const receiptReady = Boolean(mission?.status === 'healed' && eventFor(mission, 'receipt'));
  const terminal = Boolean(mission && (receiptReady || mission.status === 'error' || resetConfirmed));
  const transition = reducedMotion ? { duration: 0.12 } : { duration: 0.34, ease: [0.23, 1, 0.32, 1] as const };
  const missionFailure = mission?.status === 'error'
    ? `Mission stopped without a receipt. ${mission.lastError ?? 'The backend reported an unspecified failure.'}`
    : null;
  const visibleError = apiError ?? missionFailure;

  useEffect(() => {
    if (!mission?.id || terminal) return;
    let mounted = true;
    let nextPoll: number | undefined;
    const missionId = mission.id;
    const poll = async () => {
      const sequence = ++pollSequence.current;
      try {
        const next = await getMission(missionId);
        if (mounted && sequence === pollSequence.current) {
          setMission(next);
          setApiError(null);
        }
      } catch (error) {
        if (mounted && sequence === pollSequence.current) {
              setApiError(`Live mission updates are unavailable.${errorDetail(error)} Existing evidence has not been advanced.`);
        }
      } finally {
        if (mounted) nextPoll = window.setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      mounted = false;
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
    };
  }, [mission?.id, terminal]);

  function home() {
    setScene('landing');
  }

  async function startOrResume() {
    if (startRequest.current) return;
    if (mission && !resetConfirmed) {
      setScene(sceneForMission(mission));
      return;
    }
    startRequest.current = true;
    pollSequence.current += 1;
    setRequest('start');
    setApiError(null);
    try {
      const next = await createMission();
      setMission(next);
      setScene('baseline');
    } catch (error) {
      setApiError(`The live proof could not start.${errorDetail(error)} No receipt was created.`);
    } finally {
      startRequest.current = false;
      setRequest('idle');
    }
  }

  async function publishV2() {
    if (!mission || mission.status !== 'waiting') return;
    const sequence = ++pollSequence.current;
    setRequest('shift');
    setApiError(null);
    try {
      const next = await shiftMission(mission.id);
      if (sequence === pollSequence.current) setMission(next);
      setScene('deploy');
    } catch (error) {
      setApiError(`The V2 shift could not start.${errorDetail(error)} Mission evidence has not been advanced.`);
    } finally {
      setRequest('idle');
    }
  }

  async function resetV1() {
    if (!mission || mission.status === 'running') return;
    pollSequence.current += 1;
    setRequest('reset');
    setApiError(null);
    try {
      const next = await resetMission(mission.id);
      setMission(next);
      setScene('landing');
    } catch (error) {
      setApiError(`The fixture could not reset to V1.${errorDetail(error)}`);
    } finally {
      setRequest('idle');
    }
  }

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(PROOF_REQUEST_EVENT, { detail: { pending: request === 'start' } }));
  }, [request]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(RECEIPT_STATE_EVENT, { detail: { available: receiptReady } }));
  }, [receiptReady]);

  useEffect(() => {
    const goHome = () => home();
    const startProof = () => void startOrResume();
    const showReceipt = () => receiptReady && setScene('replay');
    window.addEventListener(HOME_EVENT, goHome);
    window.addEventListener(START_PROOF_EVENT, startProof);
    window.addEventListener(RECEIPT_EVENT, showReceipt);
    return () => {
      window.removeEventListener(HOME_EVENT, goHome);
      window.removeEventListener(START_PROOF_EVENT, startProof);
      window.removeEventListener(RECEIPT_EVENT, showReceipt);
    };
  });

  function renderScene(): ReactNode {
    if (scene === 'connect') return <ConnectScene onHome={home} />;
    if (scene === 'landing' || !mission) return <LandingScene />;
    switch (scene) {
      case 'baseline': return <BaselineScene mission={mission} request={request} onShift={() => void publishV2()} onHome={home} />;
      case 'deploy': return <DeployScene mission={mission} onNext={() => setScene('broken')} />;
      case 'broken': return <BrokenScene mission={mission} onNext={() => setScene('diagnosis')} />;
      case 'diagnosis': return <DiagnosisScene mission={mission} onNext={() => setScene('heal')} />;
      case 'heal': return <HealScene mission={mission} onNext={() => setScene('proof')} />;
      case 'proof': return <ProofScene mission={mission} request={request} onConnect={() => setScene('connect')} onReplay={() => setScene('replay')} onReset={() => void resetV1()} />;
      default: return <ReplayScene mission={mission} onHome={home} onProof={() => setScene('proof')} />;
    }
  }
  const content = renderScene();

  return (
    <section className="mission-experience" aria-labelledby="mission-title">
      {visibleError && scene !== 'landing' && <div className="pg-api-error" role="alert" data-testid="mission-fallback"><span>{visibleError}</span>{mission && mission.status !== 'running' && <button type="button" onClick={() => void resetV1()}>Reset V1</button>}</div>}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={scene} className="mission-scene" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(14px)', filter: 'blur(4px)' }} animate={{ opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-8px)', filter: 'blur(3px)' }} transition={transition}>{content}</motion.div>
      </AnimatePresence>
    </section>
  );
}
