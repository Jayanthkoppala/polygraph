import { useRef } from 'react';
import { Check, Database, FileCode, GithubLogo, GlobeHemisphereWest, ShieldCheck, Sparkle } from '@phosphor-icons/react';
import { AnimatedBeam } from '@/components/magicui/AnimatedBeam';
import { CodeComparison } from '@/components/magicui/CodeComparison';
import type { ProductObservation } from '@/landing/demoMissionApi';
import './MissionStoryVisuals.css';

export type MissionProgressStage = 0 | 1 | 2 | 3;

const progressLabels = ['collect', 'compare', 'repair', 'prove'] as const;

export function MissionProgressRail({ active, reducedMotion }: { active: MissionProgressStage; reducedMotion: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const collectRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const repairRef = useRef<HTMLDivElement>(null);
  const proveRef = useRef<HTMLDivElement>(null);
  const refs = [collectRef, compareRef, repairRef, proveRef];

  return (
    <div className="pg-mission-progress" ref={containerRef} aria-label={`Mission progress: ${progressLabels[active]}`}>
      {progressLabels.map((label, index) => (
        <div ref={refs[index]} className={`pg-mission-progress__step ${index <= active ? 'is-active' : ''} ${index === active ? 'is-current' : ''}`} key={label}>
          <i aria-hidden="true" /><span>{label}</span>
        </div>
      ))}
      {[0, 1, 2].map(index => index < active ? (
        <AnimatedBeam key={progressLabels[index]} containerRef={containerRef} fromRef={refs[index]} toRef={refs[index + 1]}
          pathColor="rgba(132,136,255,.18)" gradientStartColor="#777cff" gradientStopColor="#a8aaff"
          pathWidth={1.5} duration={reducedMotion ? 0.01 : 2.4} repeat={reducedMotion ? 0 : Infinity} />
      ) : null)}
    </div>
  );
}

function collectorJson(observation: ProductObservation | null) {
  return {
    product_code: observation?.productCode ?? null,
    title: observation?.title ?? null,
    price: observation?.price ?? { value: null, currency: null, symbol: null },
    availability: observation?.availability ?? null,
  };
}

export function JsonDifference({ before, after, changedFields }: { before: ProductObservation | null; after: ProductObservation | null; changedFields: string[] }) {
  const beforeCode = JSON.stringify(collectorJson(before), null, 2);
  const afterCode = JSON.stringify(collectorJson(after), null, 2);
  return (
    <section className="pg-json-difference" aria-label="The collector output before and after the version switch">
      <div className="pg-json-difference__meta"><span>availability stayed healthy</span><b>{changedFields.length} fields regressed</b></div>
      <CodeComparison beforeCode={beforeCode} afterCode={afterCode} language="json" filename="collector-output.json" theme="dark" />
    </section>
  );
}

export function EvolutionPublishGraphic({
  baselineGeneration,
  targetGeneration,
  deployed,
  reducedMotion,
}: {
  baselineGeneration: string;
  targetGeneration: string;
  deployed: boolean;
  reducedMotion: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const githubRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  return (
    <section className="pg-evolution-graphic" aria-label={`Publishing generation ${targetGeneration}`}>
      <div className="pg-evolution-graphic__canvas" ref={containerRef}>
        <div className="pg-evolution-node" ref={sourceRef}>
          <Database aria-hidden="true" />
          <span>healthy reference</span>
          <b>Generation {baselineGeneration}</b>
          <small>Run A is stored. The product values stay fixed.</small>
        </div>
        <div className="pg-evolution-node is-active" ref={githubRef}>
          <GithubLogo weight="fill" aria-hidden="true" />
          <span>real source change</span>
          <b>{deployed ? 'Commit published' : 'Generating new anchors'}</b>
          <small>A recorded seed changes code, title, and price anchors.</small>
        </div>
        <div className={`pg-evolution-node ${deployed ? 'is-proved' : ''}`} ref={liveRef}>
          <GlobeHemisphereWest aria-hidden="true" />
          <span>production marker</span>
          <b>Generation {targetGeneration}</b>
          <small>{deployed ? 'The live page matches the GitHub commit.' : 'Waiting for the public deployment to match.'}</small>
        </div>
        <AnimatedBeam containerRef={containerRef} fromRef={sourceRef} toRef={githubRef} pathColor="rgba(132,136,255,.22)" gradientStartColor="#777cff" gradientStopColor="#a8aaff" duration={reducedMotion ? 0.01 : 2.8} repeat={reducedMotion ? 0 : Infinity} />
        <AnimatedBeam containerRef={containerRef} fromRef={githubRef} toRef={liveRef} pathColor="rgba(132,136,255,.22)" gradientStartColor="#a8aaff" gradientStopColor={deployed ? '#62e5a1' : '#69dff8'} duration={reducedMotion ? 0.01 : 3.1} delay={0.35} repeat={reducedMotion ? 0 : Infinity} />
      </div>
      <div className="pg-process-graphic__focus"><span>recorded seed → github commit → verified production marker</span></div>
    </section>
  );
}

export function PolygraphProcessGraphic({ phase, proofReady, reducedMotion, changedFields, baselineLabel = 'baseline', changedLabel = 'evolved' }: { phase: 'diagnosis' | 'healing'; proofReady: boolean; reducedMotion: boolean; changedFields: string[]; baselineLabel?: string; changedLabel?: string }) {
  const isHealing = phase === 'healing';

  return (
    <section className={`pg-process-graphic is-${phase}`} aria-label="What Polygraph is doing in the background">
      <div className={`pg-process-graphic__canvas ${reducedMotion ? 'is-reduced-motion' : ''}`}>
        <svg className="pg-process-route" viewBox="0 0 1200 370" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="pg-route-gradient" x1="0" x2="1">
              <stop offset="0%" stopColor="#7d86ff" />
              <stop offset="58%" stopColor="#65d8ff" />
              <stop offset="100%" stopColor={proofReady ? '#62e5a1' : '#9a8cff'} />
            </linearGradient>
          </defs>
          <path className="pg-process-route__line pg-process-route__line--v1" d="M200 111 C292 111 330 157 410 178" />
          <path className="pg-process-route__line pg-process-route__line--v2" d="M200 265 C292 265 330 207 410 185" />
          <path className="pg-process-route__line pg-process-route__line--main" d="M570 184 C670 184 690 111 776 111 S920 184 1010 184" />
          <path className="pg-process-route__packet" pathLength="1" d="M200 111 C292 111 330 157 410 178 C470 196 520 184 570 184 C670 184 690 111 776 111 S920 184 1010 184" />
        </svg>
        <div className="pg-process-sources">
          <div className="pg-process-node pg-process-node--baseline"><Database aria-hidden="true" /><span>generation {baselineLabel}</span><b>Baseline contract</b><small>4 fields captured</small></div>
          <div className="pg-process-node pg-process-node--returned"><FileCode aria-hidden="true" /><span>generation {changedLabel} <em>held</em></span><b>{changedFields.length} fields changed</b><small>result remains isolated</small></div>
        </div>
        <div className="pg-process-node pg-process-node--core"><div className="pg-process-node__icon"><ShieldCheck aria-hidden="true" /></div><span>Polygraph <em>fresh run</em></span><b>Fresh-run gate</b><small>Re-checks the held candidate against live source state.</small><i>{isHealing ? 'fresh run started' : 'awaiting repair'}</i></div>
        <div className={`pg-process-node pg-process-node--provider ${isHealing ? 'is-active' : ''}`}><Sparkle aria-hidden="true" /><span>Bright Data <em>isolated</em></span><b>Repair lane</b><small>{isHealing ? 'Candidate repair returned.' : 'Repair context prepared.'}</small><i>{isHealing ? 'repair complete' : 'standby'}</i></div>
        <div className={`pg-process-node pg-process-node--proof ${proofReady ? 'is-active' : ''}`}><div className="pg-process-node__proof-seal"><Check aria-hidden="true" /></div><span>Fresh proof <em>independent</em></span><b>{proofReady ? '4 of 4 fields pass' : 'Proof pending'}</b><small>{proofReady ? 'Independent run sealed the result.' : 'Only a fresh run can unlock proof.'}</small></div>
      </div>
      <div className="pg-process-graphic__focus"><span>held result → independent repair → fresh verification</span></div>
    </section>
  );
}

export function RecoverySuccess({ productCode, price }: { productCode: string; price: string }) {
  return (
    <section className="pg-recovery-success" aria-label="Recovery verified">
      <div className="pg-recovery-success__seal" aria-hidden="true"><span><Check weight="bold" /></span><i /><i /></div>
      <div className="pg-recovery-success__statement"><span>recovery verified</span><b>{productCode}</b><strong>{price}</strong></div>
      <div className="pg-recovery-success__checks"><span>4 of 4 fields match</span><span>fresh production run</span><span>evidence verified</span></div>
    </section>
  );
}
