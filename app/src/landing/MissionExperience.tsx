import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, CaretRight, CheckCircle, CircleNotch, LinkSimple, ShieldCheck, WarningCircle, X } from '@phosphor-icons/react';
import Dither from '@/components/Dither';
import { Button } from '@/components/ui/button';
import { createMission, getMission, resetMission, shiftMission, type MissionEvent, type MissionState } from './demoMissionApi';

type Scene = 'landing' | 'v1_baseline' | 'deploy_wait' | 'broken_v2' | 'diagnosis' | 'self_healing' | 'receipt';

const scenes: Record<Scene, { kicker: string; title: string; body: string; measure: string }> = {
  landing: { kicker: 'Release gate for web data', title: 'Your scraper says it recovered. Can you publish the result?', body: 'Polygraph protects the last verified feed until a fresh canary proves the repaired collector still extracts the right product, fields, and values.', measure: 'Start a real V1 → V2 proof mission' },
  v1_baseline: { kicker: '01 / V1 deployed', title: 'The baseline is live — and now it is evidence.', body: 'The first deployed scrape is pinned as the last verified state before the page changes.', measure: 'V1 receipt captured by the mission' },
  deploy_wait: { kicker: '02 / V2 deploying', title: 'The deployment is real. The countdown is not.', body: 'Polygraph waits for server events from the workflow instead of animating a percentage to look busy.', measure: 'Waiting for deployment evidence' },
  broken_v2: { kicker: '03 / V2 held', title: 'A 200 response can still be a wrong answer.', body: 'V2 altered the page. The new candidate is held while the previous verified feed remains the safe output.', measure: 'Candidate output held' },
  diagnosis: { kicker: '04 / analysis', title: 'Explain the difference. Find precedent. Draft the repair.', body: 'The mission shows the DOM/output diff, groups similar prior incidents, then drafts the precise Bright Data Self-Healing prompt.', measure: 'Three bounded assist stages in flight' },
  self_healing: { kicker: '05 / Bright Data self-healing', title: 'Repair the mechanism. Then verify the outcome.', body: 'A self-healing response is never presented as production proof. A new canary must earn the next receipt.', measure: 'Fresh canary required after healing' },
  receipt: { kicker: '06 / fresh receipt', title: 'Only new evidence can move the feed forward.', body: 'The mission receipt links the deployed fixture, workflow, collector, and fresh run that support the decision.', measure: 'Reset V1 to replay the real path' },
};

function inferScene(mission: MissionState | null): Scene {
  if (mission?.scene && mission.scene in scenes) return mission.scene;
  const source = `${mission?.status ?? ''} ${mission?.events.at(-1)?.step ?? ''}`.toLowerCase();
  if (/receipt|verified|healed|release/.test(source)) return 'receipt';
  if (/heal/.test(source)) return 'self_healing';
  if (/diagnos|contract|coheren|identity/.test(source)) return 'diagnosis';
  if (/broken|drift|hold|fail/.test(source)) return 'broken_v2';
  if (/deploy|shift|wait/.test(source)) return 'deploy_wait';
  if (/baseline|running|v1/.test(source)) return 'v1_baseline';
  return 'landing';
}

function readableStep(step: string) {
  return step.replace(/[-_.]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function EvidenceLink({ href, label }: { href: string | null | undefined; label: string }) {
  return href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#c8c8ff] underline decoration-[#5a5aff]/70 underline-offset-4 hover:text-white"><LinkSimple size={14} aria-hidden="true" />{label}</a> : <span className="text-[#77778d]">{label} unavailable</span>;
}

function ReceiptEvidence({ label, href, id }: { label: string; href: string | null | undefined; id: string | null | undefined }) {
  return <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[#30304e] bg-black/35 px-3 py-2 text-xs">
    <span className="font-mono uppercase tracking-[0.12em] text-[#9999b6]">{label}</span>
    <span className="min-w-0 text-right text-[#d4d4e5]">{href ? <EvidenceLink href={href} label={id ? `Open ${id}` : 'Open evidence'} /> : id ?? 'Not recorded'}</span>
  </div>;
}

export function MissionExperience() {
  const reducedMotion = useReducedMotion();
  const [mission, setMission] = useState<MissionState | null>(null);
  const [request, setRequest] = useState<'idle' | 'start' | 'shift' | 'reset'>('idle');
  const [apiError, setApiError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const pollSequence = useRef(0);

  const scene = inferScene(mission);
  const content = scenes[scene];
  const resetConfirmed = mission?.status === 'idle' && mission.events.some((event) => /reset/.test(event.step));
  const terminal = mission?.status === 'healed' || mission?.status === 'error' || mission?.status === 'fallback' || resetConfirmed;
  const canShift = Boolean(mission && mission.status === 'waiting' && request === 'idle' && !terminal && scene === 'v1_baseline');
  const canRun = request === 'idle' && (!mission || resetConfirmed);
  const events = useMemo(() => mission?.events ?? [], [mission]);

  useEffect(() => {
    if (!mission?.id || terminal) return;
    let mounted = true;
    const poll = async () => {
      const sequence = ++pollSequence.current;
      try {
        const next = await getMission(mission.id);
        // Intervals may overlap. Only the newest response is allowed to change
        // the screen, so an older GET can never move a just-shifted mission back.
        if (mounted && sequence === pollSequence.current) { setMission(next); setApiError(null); }
      } catch {
        if (mounted && sequence === pollSequence.current) setApiError('Replay fallback — the mission API is unavailable. The screen will not simulate a successful deployment or receipt.');
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 2000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [mission?.id, terminal]);

  async function run() {
    pollSequence.current += 1;
    setRequest('start'); setApiError(null);
    try { setMission(await createMission({})); }
    catch (error) { setApiError(error instanceof Error ? `Replay fallback — mission API unavailable: ${error.message}` : 'Replay fallback — mission API unavailable.'); }
    finally { setRequest('idle'); }
  }
  async function shift() {
    if (!mission) return;
    pollSequence.current += 1;
    setRequest('shift'); setApiError(null);
    try { setMission(await shiftMission(mission.id)); }
    catch (error) { setApiError(error instanceof Error ? `Replay fallback — V2 shift unavailable: ${error.message}` : 'Replay fallback — V2 shift unavailable.'); }
    finally { setRequest('idle'); }
  }
  async function reset() {
    if (!mission) return;
    pollSequence.current += 1;
    setRequest('reset'); setApiError(null);
    try { setMission(await resetMission(mission.id)); }
    catch (error) { setApiError(error instanceof Error ? `Replay fallback — reset unavailable: ${error.message}` : 'Replay fallback — reset unavailable.'); }
    finally { setRequest('idle'); }
  }

  return <section className="relative isolate min-h-[calc(100svh-45px)] overflow-x-hidden bg-black px-4 py-5 text-[#ededed] antialiased sm:px-6 lg:px-8" aria-labelledby="mission-title">
    <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden="true"><Dither className="h-full w-full" waveColor={[0.0039215686, 0, 1]} waveSpeed={0.05} waveFrequency={3} waveAmplitude={0.3} colorNum={4} pixelSize={2} enableMouseInteraction mouseRadius={0.3} disableAnimation={Boolean(reducedMotion)} /></div>
    <div className="pointer-events-none absolute inset-0 bg-black/60" aria-hidden="true" />
    <div className="relative mx-auto flex min-h-[calc(100svh-85px)] w-full max-w-7xl flex-col justify-between gap-7">
      <motion.div initial={reducedMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : 0.38 }} className="grid gap-6 pt-2 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
        <AnimatePresence mode="wait"><motion.div key={scene} initial={reducedMotion ? false : { opacity: 0, y: 12, filter: 'blur(5px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={reducedMotion ? undefined : { opacity: 0, y: -12, filter: 'blur(3px)' }} transition={{ duration: reducedMotion ? 0 : 0.28 }}><p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[#aaaafd]">{content.kicker}</p><h1 id="mission-title" className="mt-5 max-w-5xl text-balance text-4xl font-semibold leading-[0.95] tracking-[-0.055em] text-white sm:text-6xl xl:text-7xl">{content.title}</h1><p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-[#c0c0ce] sm:text-lg">{content.body}</p></motion.div></AnimatePresence>
        <div className="rounded-2xl border border-[#484876] bg-[#090910]/85 p-5 shadow-[var(--shadow-e3)]">
          <div className="flex items-center justify-between"><span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#aaaafd]">Mission signal</span><ShieldCheck size={22} className="text-[#7777ff]" aria-hidden="true" /></div>
          <p className="mt-5 text-xl font-medium leading-tight text-white">{content.measure}</p>
          <p className="mt-4 font-mono text-xs text-[#9a9aac]">{apiError ? 'REPLAY MODE · API UNAVAILABLE' : mission ? `MISSION ${mission.id}` : 'NO MISSION CREATED'}</p>
        </div>
      </motion.div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-end">
        <div className="rounded-2xl border border-[#3b3b64] bg-[#08080e]/90 p-5 shadow-[var(--shadow-e3)] sm:p-6">
          <div className="flex flex-wrap items-center gap-3" aria-label="Mission controls">
            <Button type="button" data-testid="run-mission-btn" onClick={() => void run()} disabled={!canRun} className="min-h-12 bg-[#3f3fff] px-5 text-white transition-transform duration-150 active:scale-[0.96] hover:bg-[#5757ff]">
              {request === 'start' ? <CircleNotch size={18} /> : <CaretRight weight="fill" size={18} />} Run the live proof
            </Button>
            <Button type="button" data-testid="shift-v2-btn" variant="outline" onClick={() => void shift()} disabled={!canShift} className="min-h-12 border-[#6666ff] bg-black/50 px-5 text-white transition-transform duration-150 active:scale-[0.96] hover:bg-[#151529]">Shift to V2 <ArrowRight size={18} /></Button>
            <Button type="button" data-testid="reset-v1-btn" variant="ghost" onClick={() => void reset()} disabled={!mission || request !== 'idle' || mission.status === 'running'} className="min-h-12 text-[#d8d8ea] transition-transform duration-150 active:scale-[0.96] hover:bg-[#171724] hover:text-white">Reset V1</Button>
            <Button type="button" variant="ghost" onClick={() => setConnectOpen(true)} className="min-h-12 text-[#aaaafd] transition-transform duration-150 active:scale-[0.96] hover:bg-[#171724] hover:text-white">Connect my collectors</Button>
          </div>
          <p className="mt-3 text-xs text-[#9999ae]">The fixture mission is auto-approved. A fresh recovery run must verify the repaired collector before this mission issues its receipt.</p>
          {apiError && <p role="status" data-testid="mission-fallback" className="mt-4 flex gap-2 rounded-lg border border-[#a47d27] bg-[#261e09]/90 p-3 text-sm leading-6 text-[#f1cf74]"><WarningCircle className="mt-1 shrink-0" size={17} />{apiError}</p>}
        </div>
        <div className="rounded-2xl border border-[#3b3b64] bg-[#08080e]/90 p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#aaaafd]">Evidence links</p>
          <div className="mt-3 grid gap-2 text-sm"><EvidenceLink href={mission?.evidence.fixtureRepo} label="Fixture repository" /><EvidenceLink href={mission?.evidence.liveFixtureUrl} label="Live fixture" /><EvidenceLink href={mission?.evidence.workflowUrl} label="GitHub workflow" /><EvidenceLink href={mission?.evidence.markerUrl} label="Live version marker" /><EvidenceLink href={mission?.evidence.collectorUrl} label="Bright Data collector" />{mission?.evidence.collectorId && <span className="font-mono text-xs text-[#9d9db4]">Collector {mission.evidence.collectorId}</span>}</div>
        </div>
      </div>

      <section className="rounded-2xl border border-[#3b3b64] bg-[#08080e]/94 p-5 shadow-[var(--shadow-e3)]" aria-labelledby="events-title">
        <div className="flex items-center justify-between gap-4 border-b border-[#292943] pb-4"><div><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#aaaafd]">Mission trace</p><h2 id="events-title" className="mt-1 text-lg font-semibold text-white">Real server events only</h2></div><span className="font-mono text-xs tabular-nums text-[#9494ac]">{events.length} received</span></div>
        <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="progress-tracker" aria-live="polite">
          {events.map((event: MissionEvent, index) => <li key={`${event.at}-${event.step}-${index}`} data-testid="mission-event" className="rounded-xl border border-[#30304e] bg-black/45 p-3"><div className="flex gap-3"><CheckCircle weight="fill" size={18} className="mt-0.5 shrink-0 text-[#7373ff]" aria-hidden="true" /><div className="min-w-0"><div className="flex items-baseline justify-between gap-2"><span className="text-sm font-medium text-white">{readableStep(event.step)}</span><time className="shrink-0 font-mono text-[10px] text-[#85859b]">{time(event.at)}</time></div><p className="mt-1 text-xs leading-5 text-[#b9b9c7]">{event.detail}</p></div></div></li>)}
          {events.length === 0 && <li className="rounded-xl border border-dashed border-[#47476e] p-4 text-sm leading-6 text-[#a8a8bc]">No event has arrived. Start the live proof to create a mission — this tracker will never fill from a local timer.</li>}
        </ol>
      </section>

      {mission && (scene === 'receipt' || mission.evidence.baselineRunId || mission.evidence.brokenRunId || mission.evidence.recoveryRunId) && <section className="rounded-2xl border border-[#3b3b64] bg-[#08080e]/94 p-5 shadow-[var(--shadow-e3)]" aria-labelledby="receipt-evidence-title">
        <div className="flex items-center justify-between gap-4"><div><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#aaaafd]">Receipt evidence</p><h2 id="receipt-evidence-title" className="mt-1 text-lg font-semibold text-white">A / B / C run record</h2></div><span className="font-mono text-xs text-[#9494ac]">server supplied</span></div>
        <div className="mt-4 grid gap-2 md:grid-cols-3"><ReceiptEvidence label="A baseline" href={mission.evidence.baselineRunUrl} id={mission.evidence.baselineRunId} /><ReceiptEvidence label="B broken" href={mission.evidence.brokenRunUrl} id={mission.evidence.brokenRunId} /><ReceiptEvidence label="C recovery" href={mission.evidence.recoveryRunUrl} id={mission.evidence.recoveryRunId} /></div>
        {mission.evidence.healRunId && <div className="mt-2"><ReceiptEvidence label="Heal proposal" href={mission.evidence.healRunUrl} id={mission.evidence.healRunId} /></div>}
      </section>}
    </div>

    {connectOpen && <div role="dialog" aria-modal="true" aria-labelledby="connect-title" className="fixed inset-0 z-30 grid place-items-center bg-black/75 p-4"><div className="w-full max-w-lg rounded-2xl border border-[#55558a] bg-[#0b0b12] p-6 shadow-[var(--shadow-e3)]"><div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#aaaafd]">Customer flow</p><h2 id="connect-title" className="mt-2 text-2xl font-semibold text-white">Connect your collectors securely</h2></div><Button type="button" variant="ghost" size="icon" aria-label="Close collector connection" onClick={() => setConnectOpen(false)}><X size={18} /></Button></div><p className="mt-3 text-sm leading-6 text-[#bdbdcb]">Saving a Bright Data token requires a signed-in tenant session and CSRF protection. Continue to the existing onboarding flow to connect a token, load your collectors, and select one.</p><div className="mt-6 flex flex-wrap gap-3"><a href="/signup" className="inline-flex min-h-11 items-center rounded-md bg-[#3f3fff] px-4 text-sm font-medium text-white transition-transform duration-150 active:scale-[0.96] hover:bg-[#5757ff]">Start secure onboarding</a><a href="/login" className="inline-flex min-h-11 items-center rounded-md border border-[#5d5d8f] px-4 text-sm font-medium text-[#e4e4f5] transition-colors duration-150 hover:bg-[#171724]">Sign in</a></div></div></div>}
  </section>;
}
