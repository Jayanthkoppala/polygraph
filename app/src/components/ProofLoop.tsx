import { useEffect, useState } from 'react';
import './ProofLoop.css';

const STAGES = [
  { step: '01', phase: 'COLLECT', source: 'BRIGHT DATA · RUN A', title: 'Capture the output', detail: 'Product identity, price, and page signal arrive as evidence.', tone: 'pass' },
  { step: '02', phase: 'VALIDATE', source: 'POLYGRAPH · DIFF', title: 'Check it against V1', detail: 'Contract, identity, and expected value decide whether to hold.', tone: 'fail' },
  { step: '03', phase: 'REPAIR', source: 'BRIGHT DATA · HEAL', title: 'Apply a bounded repair', detail: 'The policy gate permits only the owned fixture and collector.', tone: 'blue' },
  { step: '04', phase: 'PROVE', source: 'POLYGRAPH · RUN C', title: 'Grade a fresh result', detail: 'A new production run earns the recovery receipt.', tone: 'pass' },
] as const;

export function ProofLoop({ reducedMotion }: { reducedMotion: boolean }) {
  const [active, setActive] = useState(0);
  const current = STAGES[active];

  useEffect(() => {
    if (reducedMotion) return;
    const interval = window.setInterval(() => setActive((value) => (value + 1) % STAGES.length), 3_800);
    return () => window.clearInterval(interval);
  }, [reducedMotion]);

  return (
    <section className="proof-loop" aria-label="Polygraph recovery method" data-active={active}>
      <header className="proof-loop__header"><span>POLYGRAPH / RECOVERY LOOP</span><b>LIVE METHOD</b></header>
      <svg className="proof-loop__paths" viewBox="0 0 480 420" fill="none" aria-hidden="true">
        <path className="proof-loop__track" d="M145 105C190 63 290 63 335 105M373 137C412 180 412 244 373 287M335 319C289 357 191 357 145 319M107 287C68 244 68 180 107 137" />
        <path className="proof-loop__flow" d="M145 105C190 63 290 63 335 105M373 137C412 180 412 244 373 287M335 319C289 357 191 357 145 319M107 287C68 244 68 180 107 137" />
        <circle cx="240" cy="210" r="92" className="proof-loop__orbit" />
      </svg>
      {STAGES.map((stage, index) => (
        <article key={stage.phase} className={`proof-loop__node proof-loop__node--${index + 1} ${active === index ? 'is-active' : ''}`}>
          <div className="proof-loop__node-top"><b className={`tone-${stage.tone}`}>{stage.step}</b><span>{stage.phase}</span></div>
          <small>{stage.source}</small>
        </article>
      ))}
      <div className="proof-loop__core" aria-live="polite">
        <span>ACTIVE METHOD</span>
        <b className={`tone-${current.tone}`}>{current.phase}</b>
        <strong>{current.title}</strong>
        <p>{current.detail}</p>
      </div>
      <footer className="proof-loop__footer"><span>BASELINE</span><i aria-hidden="true" /><span>POLICY GATE</span><i aria-hidden="true" /><span>REGRESSION RECEIPT</span></footer>
    </section>
  );
}
