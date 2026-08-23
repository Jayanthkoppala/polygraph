import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, ArrowSquareOut, GithubLogo, GlobeHemisphereWest } from '@phosphor-icons/react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import CardSwap, { Card } from '@/components/CardSwap';
import DecryptedText from '@/components/reactbits/DecryptedText';
import FuzzyText from '@/components/reactbits/FuzzyText';
import SplitFlapText from '@/components/reactbits/SplitFlapText';
import TextType from '@/components/reactbits/TextType';
import { Highlighter } from '@/components/magicui/Highlighter';
import { Safari } from '@/components/magicui/Safari';
import { ShinyButton } from '@/components/magicui/ShinyButton';
import { EvolutionPublishGraphic, JsonDifference, MissionProgressRail, PolygraphProcessGraphic, RecoverySuccess, type MissionProgressStage } from '@/components/story/MissionStoryVisuals';
import { HOME_EVENT, PROOF_REQUEST_EVENT, RECEIPT_EVENT, RECEIPT_STATE_EVENT, START_PROOF_EVENT } from '@/components/GlobalChrome';
import {
  createMission,
  getMission,
  shiftMission,
  type MissionState,
} from './demoMissionApi';
import './MissionExperience.css';

type StoryScene = 'landing' | 'baseline' | 'deploy' | 'broken' | 'diagnosis' | 'heal' | 'proof' | 'evidence' | 'connect';
type RequestState = 'idle' | 'start' | 'shift';
type ExperienceMode = 'landing' | 'proof';

const STORY_SCENE_PAUSE_MS = {
  deploy: 2_000,
  broken: 4_000,
  diagnosis: 4_000,
  heal: 3_200,
} as const;

function errorDetail(error: unknown) {
  return error instanceof Error ? ` ${error.message}` : '';
}

function eventFor(mission: MissionState | null, step: string) {
  return mission?.events.find((event) => event.step === step);
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
  const observation = step === 'receipt' ? mission?.evidence.proofResult : mission?.evidence.baselineResult;
  const detail = eventFor(mission, step)?.detail ?? '';
  const identity = detail.match(/(?:SKU|product code|fields for)\s+([^\s,]+).*?\bat\s+([£$€₹]?[0-9][\d.,]*)/i);
  const value = observation?.price.value;
  const price = value === null || value === undefined
    ? identity?.[2] ?? '—'
    : `${observation?.price.symbol ?? ''}${value.toFixed(2)}`;
  return {
    productCode: observation?.productCode ?? identity?.[1] ?? 'awaiting provider proof',
    title: observation?.title ?? 'awaiting product title',
    price,
    availability: observation?.availability ?? 'awaiting availability',
  };
}

function readableFields(fields: string[]) {
  const labels = fields.map((field) => field.replaceAll('_', ' '));
  if (labels.length < 2) return labels[0] ?? 'collector output';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function SceneButton({ children, onClick, variant = 'primary', disabled = false, testId }: { children: ReactNode; onClick: () => void; variant?: 'primary' | 'ghost'; disabled?: boolean; testId?: string }) {
  return <Button type="button" data-testid={testId} disabled={disabled} onClick={onClick} variant={variant === 'primary' ? 'default' : 'ghost'} className={`pg-action pg-action-${variant}`}>{children}</Button>;
}

const FIXTURE_REPOSITORY_URL = 'https://github.com/Jayanthkoppala/polygraph-version-shift-store';
const FIXTURE_LIVE_URL = 'https://polygraph-version-shift-store.vercel.app';

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function ProofSources({ liveUrl }: { liveUrl: string | null }) {
  const verifiedLiveUrl = liveUrl ?? FIXTURE_LIVE_URL;
  return (
    <aside className="pg-proof-sources" aria-label="Verify this proof yourself">
      <span className="pg-proof-sources__label">Verify it yourself</span>
      <a href={FIXTURE_REPOSITORY_URL} target="_blank" rel="noreferrer">
        <GithubLogo weight="fill" aria-hidden="true" />
        <span><b>GitHub</b><small>{displayUrl(FIXTURE_REPOSITORY_URL)}</small></span>
        <ArrowSquareOut aria-hidden="true" />
      </a>
      <a href={verifiedLiveUrl} target="_blank" rel="noreferrer">
        <GlobeHemisphereWest weight="duotone" aria-hidden="true" />
        <span><b>Live store</b><small>{displayUrl(verifiedLiveUrl)}</small></span>
        <ArrowSquareOut aria-hidden="true" />
      </a>
    </aside>
  );
}

function generationLabel(mission: MissionState, kind: 'baseline' | 'changed') {
  const snapshot = mission.evidence.generationManifest?.[kind];
  if (snapshot?.generation) return snapshot.generation;
  return kind === 'baseline' ? mission.evidence.baselineVersion.toUpperCase() : mission.evidence.changedVersion.toUpperCase();
}

function LiveStoreFrame({ mission }: { mission: MissionState }) {
  const source = mission.evidence.liveFixtureUrl;
  const generation = generationLabel(mission, 'baseline');
  const displayUrl = source ? source.replace(/^https?:\/\//, '') : 'connecting…';
  return (
    <figure className="pg-version-frame pg-version-frame--single" data-generation={generation}>
      <figcaption><span>Generation {generation}</span><span>live healthy page</span></figcaption>
      <Safari url={displayUrl} className="pg-version-safari">{source
        ? <iframe className="pg-version-iframe" title={`Live product page — generation ${generation}`} src={source} sandbox="allow-scripts allow-same-origin" loading="eager" />
        : <div className="pg-version-empty">The live page is still connecting.</div>}</Safari>
    </figure>
  );
}

function LiveGenerationBadge({ generation }: { generation: string }) {
  return <span className="pg-live-generation" data-testid="live-generation-badge">LIVE · GENERATION {generation}</span>;
}

function ConversationScene({ state, activeStage, reducedMotion, generation, visual, children }: { state: string; activeStage: MissionProgressStage; reducedMotion: boolean; generation?: string; visual: ReactNode; children: ReactNode }) {
  return (
    <div className={`pg-app pg-conversation-app ${state}`}>
      <main className="pg-conversation-stage" data-testid="conversation-scene">
        <MissionProgressRail active={activeStage} reducedMotion={reducedMotion} />
        {generation && <LiveGenerationBadge generation={generation} />}
        <section className="pg-conversation" aria-live="polite">{children}</section>
        <div className="pg-conversation-visual">{visual}</div>
      </main>
    </div>
  );
}

function StoryLine({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return <div className={`pg-conversation-line ${quiet ? 'is-quiet' : ''}`}><span aria-hidden="true" /><div>{children}</div></div>;
}

function VerdictStack({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <section className="verdict-stack" aria-label="Polygraph recovery method">
      <div className="verdict-stack__labels" aria-hidden="true"><span>POLYGRAPH METHOD</span><b>BACKEND-GATED</b></div>
      <ol className="verdict-stack__rail" aria-label="Recovery stages">
        <li><b>01</b><span>COLLECT</span></li>
        <li className="is-held"><b>02</b><span>VALIDATE</span></li>
        <li><b>03</b><span>REPAIR</span></li>
        <li className="is-proved"><b>04</b><span>PROVE</span></li>
      </ol>
      <div className="verdict-stack__deck">
        <CardSwap width={480} height={315} cardDistance={30} verticalDistance={20} delay={6_800} pauseOnHover skewAmount={3} easing="smooth" disabled={reducedMotion}>
          <Card customClass="verdict-card verdict-card--validate">
            <div className="verdict-card__top"><span>POLYGRAPH · DIFF</span><b>HELD</b></div>
            <div className="verdict-card__body"><h2>Compare the switch</h2><p>Three returned fields drift. One control field stays healthy.</p></div>
            <div className="verdict-card__evidence"><span>REGRESSED <b>CODE · TITLE · PRICE</b></span><span>STABLE <b>AVAILABILITY</b></span></div>
            <div className="verdict-card__foot"><span>VERDICT</span><b>MARKUP DRIFT</b></div>
          </Card>
          <Card customClass="verdict-card verdict-card--repair">
            <div className="verdict-card__top"><span>BRIGHT DATA · HEAL</span><b>BOUNDED</b></div>
            <div className="verdict-card__body"><h2>Repair the extractors</h2><p>Only the owned fixture and approved collector can proceed.</p></div>
            <div className="verdict-card__evidence"><span>FIXTURE <b>ALLOWLISTED</b></span><span>COLLECTOR <b>APPROVED</b></span></div>
            <div className="verdict-card__foot"><span>POLICY</span><b>PERMIT CHECKED</b></div>
          </Card>
          <Card customClass="verdict-card verdict-card--prove">
            <div className="verdict-card__top"><span>POLYGRAPH · RUN C</span><b>FRESH</b></div>
            <div className="verdict-card__body"><h2>Prove it in production</h2><p>A repaired selector is not evidence until a new run agrees.</p></div>
            <div className="verdict-card__evidence"><span>CONTRACT <b>4 ACTIVE FIELDS</b></span><span>RESULT <b>4 / 4 MATCH</b></span></div>
            <div className="verdict-card__foot"><span>COLLECTION C</span><b>VERIFIED</b></div>
          </Card>
          <Card customClass="verdict-card verdict-card--receipt">
            <div className="verdict-card__top"><span>POLYGRAPH · RESULT</span><b>VERIFIED</b></div>
            <div className="verdict-card__body"><h2>Keep the recovery as evidence</h2><p>The fresh post-repair run matches the healthy reference.</p></div>
            <div className="verdict-card__evidence"><span>RUN A <b>BASELINE</b></span><span>RUN C <b>VERIFIED</b></span></div>
            <div className="verdict-card__foot"><span>RESULT</span><b>4 / 4 MATCH</b></div>
          </Card>
        </CardSwap>
      </div>
      <div className="verdict-stack__trace" aria-hidden="true"><i /><span>OBSERVE → DIAGNOSE → HEAL → PROVE</span></div>
    </section>
  );
}

function LandingScene({ onStart, onConnect, reducedMotion }: { onStart: () => void; onConnect: () => void; reducedMotion: boolean }) {
  return (
    <main className="poly-landing" data-testid="landing-scene" aria-label="Polygraph live proof launch">
      <div className="poly-landing__frame">
        <section className="poly-landing__copy">
          <p className="poly-landing__eyebrow">Watch a real recovery happen</p>
          <h1>See a scraper break, heal, and prove itself.</h1>
          <p className="poly-landing__lede">We built a live evolving store for this test. You will collect its healthy generation, publish a new recorded structure, watch the same Bright Data collector break, and see Polygraph complete the repair through a fresh production proof.</p>
          <div className="poly-landing__actions">
            <button type="button" className="poly-landing__primary" onClick={onStart}>Start proof <ArrowRight weight="bold" aria-hidden="true" /></button>
            <button type="button" className="poly-landing__secondary" onClick={onConnect}>Connect collectors</button>
          </div>
        </section>
        <section className="poly-landing__artifact" aria-label="Recovery evidence sequence"><VerdictStack reducedMotion={reducedMotion} /></section>
      </div>
    </main>
  );
}


function BaselineScene({ mission, request, reducedMotion, onShift }: { mission: MissionState; request: RequestState; reducedMotion: boolean; onShift: () => void }) {
  const baseline = eventFor(mission, 'baseline_a');
  const facts = missionFacts(mission);
  const ready = mission.status === 'waiting' && Boolean(baseline);
  const lead = ready ? 'For this test, we built a live evolving store and connected it to a real Bright Data collector.' : 'For this test, we built a live evolving store. Bright Data is collecting its current healthy generation now.';
  return (
    <ConversationScene state="state-v1" activeStage={0} reducedMotion={reducedMotion} generation={generationLabel(mission, 'baseline')} visual={<LiveStoreFrame mission={mission} />}>
      <StoryLine>{reducedMotion ? lead : <span className="pg-type-guidance"><span className="pg-visually-hidden">{lead}</span><span aria-hidden="true"><TextType as="span" text={lead} loop={false} typingSpeed={18} /></span></span>}</StoryLine>
      <StoryLine quiet>{ready ? `Generation ${generationLabel(mission, 'baseline')} returned ${facts.productCode}, its full product title, ${facts.price}, and ${facts.availability}. Polygraph saved all four fields as the healthy reference before anything changes.` : 'Once that real result arrives, Polygraph will remember the product code, title, price, and availability before anything changes.'}</StoryLine>
      <ProofSources liveUrl={mission.evidence.liveFixtureUrl} />
      <ShinyButton className="pg-kickoff-action cursor-target" type="button" onClick={onShift} disabled={!ready || request !== 'idle'} data-testid="shift-v2-btn">{request === 'shift' ? 'Evolving the live store…' : 'Evolve the live store'}<ArrowRight weight="bold" aria-hidden="true" /></ShinyButton>
      <p className="pg-kickoff-note">One click publishes a new recorded generation. Polygraph then runs compare, repair, and proof automatically.</p>
    </ConversationScene>
  );
}

function DeployScene({ mission, reducedMotion }: { mission: MissionState; reducedMotion: boolean }) {
  const marker = eventFor(mission, `marker_${mission.evidence.changedVersion}`);
  const baselineGeneration = generationLabel(mission, 'baseline');
  const changedGeneration = generationLabel(mission, 'changed');
  const switchMessage = marker ? `The new recorded generation is live in production. GitHub published the change before Polygraph continued.` : 'You asked the test store to evolve. GitHub is generating, committing, and publishing that real change now.';
  return (
    <ConversationScene state="state-deploying" activeStage={0} reducedMotion={reducedMotion} generation={changedGeneration} visual={<EvolutionPublishGraphic baselineGeneration={baselineGeneration} targetGeneration={changedGeneration} deployed={Boolean(marker)} reducedMotion={reducedMotion} />}>
      <StoryLine>{marker ? switchMessage : <SplitFlapText words={['GENERATING NEW ANCHORS', 'COMMITTING TO GITHUB', 'WAITING FOR PRODUCTION', 'VERIFYING LIVE MARKER']} loop cycleDelay={1_150} flipDuration={0.09} stagger={0.025} flipsPerChar={4} padTo={22} fontSize={15} gap={2} tileRadius={3} />}</StoryLine>
      <StoryLine quiet>{reducedMotion ? (marker ? 'Polygraph left the collector untouched and automatically started it against the new generation.' : 'Polygraph is waiting for the production marker instead of pretending the new page is live.') : <DecryptedText text={marker ? 'Polygraph left the collector untouched and automatically started it against the new generation.' : 'Polygraph is waiting for the production marker instead of pretending the new page is live.'} animateOn="view" sequential speed={24} />}</StoryLine>
      <StoryLine quiet><span className="pg-auto-status">No more clicks. The proof continues automatically.</span></StoryLine>
    </ConversationScene>
  );
}

function BrokenScene({ mission, reducedMotion }: { mission: MissionState; reducedMotion: boolean }) {
  const difference = eventFor(mission, 'difference');
  const changedFields = mission.evidence.changedFields.length > 0 ? mission.evidence.changedFields : difference ? ['price'] : [];
  const baseline = generationLabel(mission, 'baseline');
  const changed = generationLabel(mission, 'changed');
  const breakMessage = difference ? `The same collector just ran against generation ${changed}. ${readableFields(changedFields)} no longer match the healthy generation ${baseline} result.` : `The evolved store is live. Polygraph is watching the same collector run against generation ${changed} now.`;
  return (
    <ConversationScene state="state-broken" activeStage={1} reducedMotion={reducedMotion} generation={changed} visual={difference ? <JsonDifference before={mission.evidence.baselineResult} after={mission.evidence.brokenResult} changedFields={changedFields} /> : <div className="pg-visual-wait">Waiting for the changed collector result.</div>}>
      <StoryLine>{difference && !reducedMotion ? <span className="pg-fuzzy-message"><span className="pg-visually-hidden">{breakMessage}</span><FuzzyText fontSize={27} fontWeight={650} color="#8f252d" baseIntensity={0.14} hoverIntensity={0.3} enableHover>{`${changedFields.length} EXTRACTION FIELDS BROKE`}</FuzzyText></span> : breakMessage}</StoryLine>
      <StoryLine quiet>{difference ? <Highlighter action="underline" color="#8f252d" strokeWidth={2}>Polygraph holds the incomplete generation {changed} result instead of sending it downstream. The comparison shows exactly which fields regressed and which evidence remained healthy.</Highlighter> : 'Polygraph will wait for the returned data before deciding whether the generated structure actually broke anything.'}</StoryLine>
      <StoryLine quiet><span className="pg-auto-status">Polygraph is investigating this regression automatically.</span></StoryLine>
    </ConversationScene>
  );
}

function DiagnosisScene({ mission, reducedMotion }: { mission: MissionState; reducedMotion: boolean }) {
  const memory = eventFor(mission, 'incident_memory');
  const prompt = eventFor(mission, 'healing_prompt');
  const changedFields = mission.evidence.changedFields;
  const diagnosis = `Here is what Polygraph found: generation ${generationLabel(mission, 'changed')} moved ${readableFields(changedFields)}, while availability still agrees with healthy generation ${generationLabel(mission, 'baseline')}.`;
  return (
    <ConversationScene state="state-diagnosis" activeStage={1} reducedMotion={reducedMotion} generation={generationLabel(mission, 'changed')} visual={<PolygraphProcessGraphic phase="diagnosis" proofReady={false} reducedMotion={reducedMotion} changedFields={changedFields} baselineLabel={generationLabel(mission, 'baseline')} changedLabel={generationLabel(mission, 'changed')} />}>
      <StoryLine>{reducedMotion ? diagnosis : <span className="pg-type-guidance"><span className="pg-visually-hidden">{diagnosis}</span><span aria-hidden="true"><TextType as="span" text={diagnosis} typingSpeed={12} loop={false} /></span></span>}</StoryLine>
      <StoryLine quiet>{memory ? 'By comparing the two runs with its incident memory, it recognized a moved selector rather than a legitimate product change.' : 'It is comparing both runs with the failures it already knows, looking for the exact cause.'}</StoryLine>
      <StoryLine quiet>{prompt ? 'Polygraph turned that evidence into precise repair instructions for Bright Data, so Self-Healing knows what broke and what must remain unchanged.' : 'Next, Polygraph will translate the evidence into a focused Self-Healing request.'}</StoryLine>
      <StoryLine quiet><span className="pg-auto-status">{prompt ? 'The bounded repair request has been sent automatically.' : 'Polygraph is preparing the bounded repair request.'}</span></StoryLine>
    </ConversationScene>
  );
}

function HealScene({ mission, reducedMotion }: { mission: MissionState; reducedMotion: boolean }) {
  const healing = eventFor(mission, 'heal_complete');
  const receipt = eventFor(mission, 'receipt');
  const proofReady = mission.status === 'healed' && Boolean(receipt && mission.evidence.recoveryRunId);
  const changedFields = mission.evidence.changedFields;
  return (
    <ConversationScene state="state-healing" activeStage={proofReady ? 3 : 2} reducedMotion={reducedMotion} generation={generationLabel(mission, 'changed')} visual={<PolygraphProcessGraphic phase="healing" proofReady={proofReady} reducedMotion={reducedMotion} changedFields={changedFields} baselineLabel={generationLabel(mission, 'baseline')} changedLabel={generationLabel(mission, 'changed')} />}>
      <StoryLine>{healing ? `Polygraph sent one evidence-backed request for ${readableFields(changedFields)}, and Bright Data returned an autosaved repair candidate for the same collector.` : `Polygraph has handed Bright Data the exact ${changedFields.length}-field diff. Self-Healing is preparing a candidate for the same collector now.`}</StoryLine>
      <StoryLine quiet>{healing ? `But a “repair completed” message is not proof. Polygraph keeps the old result held and runs the repaired collector against live generation ${generationLabel(mission, 'changed')} again.` : 'While Bright Data works, Polygraph keeps the broken result safely held.'}</StoryLine>
      <StoryLine quiet>{proofReady ? `That separate generation ${generationLabel(mission, 'changed')} run has arrived. Polygraph checked product code, title, price, and availability before unlocking the final proof.` : reducedMotion ? `Now Polygraph is waiting for a completely fresh generation ${generationLabel(mission, 'changed')} collection.` : <DecryptedText text={`Now Polygraph is waiting for a completely fresh generation ${generationLabel(mission, 'changed')} collection.`} animateOn="view" sequential speed={24} />}</StoryLine>
      <StoryLine quiet><span className="pg-auto-status">{proofReady ? 'The fresh proof passed. Opening the verified result automatically.' : 'Polygraph will open the result only after the fresh proof passes.'}</span></StoryLine>
    </ConversationScene>
  );
}

function ProofScene({ mission, reducedMotion }: { mission: MissionState; reducedMotion: boolean }) {
  const facts = missionFacts(mission, 'receipt');
  return (
    <ConversationScene state="state-proof" activeStage={3} reducedMotion={reducedMotion} generation={generationLabel(mission, 'changed')} visual={<RecoverySuccess productCode={facts.productCode} price={facts.price} />}>
      <StoryLine>The third production run is back. Product code, title, price, and availability all match the healthy generation {generationLabel(mission, 'baseline')} reference again.</StoryLine>
      <StoryLine quiet>Polygraph now has fresh evidence that Bright Data repaired every regressed field, not merely a “repair completed” message.</StoryLine>
      <StoryLine><Highlighter action="highlight" color="#245b3d" iterations={1}>{`${facts.productCode} is back at ${facts.price} with 4 of 4 fields verified.`}</Highlighter></StoryLine>
      <div className="pg-proof-actions" aria-label="Next steps">
        <Link className="pg-proof-cta pg-proof-cta--primary" to="/signup">Connect your collector <ArrowRight weight="bold" aria-hidden="true" /></Link>
        <Link className="pg-proof-cta pg-proof-cta--secondary" to="/receipts">See the receipt <ArrowRight weight="bold" aria-hidden="true" /></Link>
      </div>
    </ConversationScene>
  );
}

function EvidenceScene({ mission, reducedMotion }: { mission: MissionState; reducedMotion: boolean }) {
  return (
    <ConversationScene state="state-evidence" activeStage={3} reducedMotion={reducedMotion} generation={generationLabel(mission, 'changed')} visual={<div className="pg-conversation-events">{mission.events.map((event) => <div key={`${event.step}-${event.at}`}><time>{providerTime(event.at)}</time><span>{readableStep(event.step)}</span><span>{event.detail}</span></div>)}</div>}>
      <StoryLine>Here is the evidence trail behind the story. Every line came from this live mission, from the first generation {generationLabel(mission, 'baseline')} collection to the final generation {generationLabel(mission, 'changed')} proof.</StoryLine>
    </ConversationScene>
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

function routeStageForScene(scene: StoryScene) {
  if (scene === 'broken' || scene === 'diagnosis') return 'compare';
  if (scene === 'heal') return 'repair';
  if (scene === 'proof' || scene === 'evidence') return 'prove';
  return 'collect';
}

function ProofBootScene({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <ConversationScene state="state-v1" activeStage={0} reducedMotion={reducedMotion} visual={<div className="pg-visual-wait">Opening the live version-shift mission.</div>}>
      <StoryLine>We’re preparing the version-shifting store and its real Bright Data collector.</StoryLine>
      <StoryLine quiet>The Collect chapter will begin when the backend returns the live baseline mission.</StoryLine>
    </ConversationScene>
  );
}

export function MissionExperience({ mode = 'landing' }: { mode?: ExperienceMode }) {
  const reducedMotion = useReducedMotion();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [scene, setScene] = useState<StoryScene>(mode === 'proof' ? 'baseline' : 'landing');
  const [mission, setMission] = useState<MissionState | null>(null);
  const [request, setRequest] = useState<RequestState>('idle');
  const [apiError, setApiError] = useState<string | null>(null);
  const pollSequence = useRef(0);
  const startRequest = useRef(false);
  const routeBootstrapped = useRef(false);
  const bootPromise = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const receiptReady = Boolean(mission?.status === 'healed' && eventFor(mission, 'receipt'));
  const differenceReady = Boolean(eventFor(mission, 'difference'));
  const terminal = Boolean(mission && (receiptReady || mission.status === 'error'));
  const transition = reducedMotion ? { duration: 0.12 } : { duration: 0.34, ease: [0.23, 1, 0.32, 1] as const };
  const missionFailure = mission?.status === 'error'
    ? `Mission stopped without a receipt. ${mission.lastError ?? 'The backend reported an unspecified failure.'}`
    : null;
  const visibleError = apiError ?? missionFailure;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (mode !== 'proof' || routeBootstrapped.current || bootPromise.current) return;
    const missionId = searchParams.get('mission');
    const boot = async () => {
      startRequest.current = true;
      setRequest('start');
      try {
        const next = missionId ? await getMission(missionId) : await createMission();
        if (!mounted.current) return;
        setMission(next);
        setScene(sceneForMission(next));
        setApiError(null);
      } catch (error) {
        if (mounted.current) setApiError(`The live proof could not start.${errorDetail(error)} No receipt was created.`);
      } finally {
        routeBootstrapped.current = true;
        if (mounted.current) setRequest('idle');
        startRequest.current = false;
        bootPromise.current = null;
      }
    };
    bootPromise.current = boot();
  }, [mode, searchParams]);

  useEffect(() => {
    if (mode !== 'proof') return;
    const next = new URLSearchParams(searchParams);
    next.set('stage', routeStageForScene(scene));
    if (mission?.id) next.set('mission', mission.id);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [mission?.id, mode, scene, searchParams, setSearchParams]);

  useEffect(() => {
    const locked = mode === 'landing';
    document.documentElement.classList.toggle('polygraph-landing-lock', locked);
    document.body.classList.toggle('polygraph-landing-lock', locked);
    return () => {
      document.documentElement.classList.remove('polygraph-landing-lock');
      document.body.classList.remove('polygraph-landing-lock');
    };
  }, [mode]);

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

  useEffect(() => {
    if (!mission) return;
    const memoryReady = Boolean(eventFor(mission, 'incident_memory'));
    const promptReady = Boolean(eventFor(mission, 'healing_prompt'));
    const advance: { scene: StoryScene; delay: number } | null =
      scene === 'deploy' && differenceReady ? { scene: 'broken', delay: STORY_SCENE_PAUSE_MS.deploy }
        : scene === 'broken' && memoryReady ? { scene: 'diagnosis', delay: STORY_SCENE_PAUSE_MS.broken }
          : scene === 'diagnosis' && promptReady ? { scene: 'heal', delay: STORY_SCENE_PAUSE_MS.diagnosis }
            : scene === 'heal' && receiptReady ? { scene: 'proof', delay: STORY_SCENE_PAUSE_MS.heal }
              : null;
    if (!advance) return;
    const timeout = window.setTimeout(() => setScene(advance.scene), reducedMotion ? 0 : advance.delay);
    return () => window.clearTimeout(timeout);
  }, [differenceReady, mission, receiptReady, reducedMotion, scene]);

  function home() {
    navigate('/');
  }

  async function startOrResume() {
    if (startRequest.current) return;
    if (mission && !receiptReady && mission.status !== 'error') {
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
      setScene(sceneForMission(next));
    } catch (error) {
      setApiError(`The live proof could not start.${errorDetail(error)} No receipt was created.`);
    } finally {
      startRequest.current = false;
      setRequest('idle');
    }
  }

  async function evolveStore() {
    if (!mission || mission.status !== 'waiting') return;
    const sequence = ++pollSequence.current;
    setRequest('shift');
    setApiError(null);
    try {
      const next = await shiftMission(mission.id);
      if (sequence === pollSequence.current) setMission(next);
      setScene('deploy');
    } catch (error) {
      setApiError(`The version switch could not start.${errorDetail(error)} Mission evidence has not been advanced.`);
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
    const startProof = () => mode === 'proof' ? void startOrResume() : navigate('/live-proof?stage=collect');
    const showReceipt = () => receiptReady && setScene('evidence');
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
    if (mode === 'landing') return <LandingScene onStart={() => navigate('/live-proof?stage=collect')} onConnect={() => navigate('/signup')} reducedMotion={Boolean(reducedMotion)} />;
    if (!mission) return <ProofBootScene reducedMotion={Boolean(reducedMotion)} />;
    if (scene === 'connect') return <ConnectScene onHome={home} />;
    switch (scene) {
      case 'baseline': return <BaselineScene mission={mission} request={request} reducedMotion={Boolean(reducedMotion)} onShift={() => void evolveStore()} />;
      case 'deploy': return <DeployScene mission={mission} reducedMotion={Boolean(reducedMotion)} />;
      case 'broken': return <BrokenScene mission={mission} reducedMotion={Boolean(reducedMotion)} />;
      case 'diagnosis': return <DiagnosisScene mission={mission} reducedMotion={Boolean(reducedMotion)} />;
      case 'heal': return <HealScene mission={mission} reducedMotion={Boolean(reducedMotion)} />;
      case 'proof': return <ProofScene mission={mission} reducedMotion={Boolean(reducedMotion)} />;
      default: return <EvidenceScene mission={mission} reducedMotion={Boolean(reducedMotion)} />;
    }
  }
  const content = renderScene();

  return (
    <section className="mission-experience" aria-label="Polygraph mission">
      {visibleError && scene !== 'landing' && <div className="pg-api-error" role="alert" data-testid="mission-fallback"><span>{visibleError}</span></div>}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={scene} className="mission-scene" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(14px)', filter: 'blur(4px)' }} animate={{ opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-8px)', filter: 'blur(3px)' }} transition={transition}>{content}</motion.div>
      </AnimatePresence>
    </section>
  );
}
