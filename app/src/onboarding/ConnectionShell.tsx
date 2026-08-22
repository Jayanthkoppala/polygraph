import type { ReactNode } from 'react';
import { ArrowUpRight, Check } from '@phosphor-icons/react';
import { motion, useReducedMotion } from 'motion/react';
import './ConnectionShell.css';

interface ConnectionShellProps {
  /** The post-authentication position: token, collector, then delivery. */
  position: 1 | 2 | 3;
  children: ReactNode;
}

const steps = [
  { label: 'Local workspace', detail: 'This browser' },
  { label: 'Bright Data', detail: 'Verify API token' },
  { label: 'Collector', detail: 'Choose what to watch' },
  { label: 'Delivery', detail: 'Receive finished runs' },
] as const;

const stories = [
  {
    kicker: 'BRIGHT DATA ACCESS',
    title: 'One token. Selected collectors. No new scheduler.',
    lede: 'Polygraph verifies your account, discovers the collectors already there, and lets Bright Data keep running them on their existing schedule.',
  },
  {
    kicker: 'COLLECTOR MEMORY',
    title: 'Choose the scraper Polygraph should learn.',
    lede: 'Each completed delivery grows an evidence history: expected fields, entity identity, and the shape of normal output.',
  },
  {
    kicker: 'EVIDENCE LOOP',
    title: 'Send every finished run into a guarded recovery loop.',
    lede: 'A private delivery URL turns each real Bright Data result into evidence, a policy decision, and—only when a break is proven—a repair attempt with a receipt.',
  },
] as const;

export function ConnectionShell({ position, children }: ConnectionShellProps) {
  const reduceMotion = useReducedMotion();
  const active = position + 1;
  const story = stories[position - 1];
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <main className="connection-shell">
      <div className="connection-shell-noise" aria-hidden />

      <section className="connection-shell-story" aria-label="Polygraph connection progress">
        <a className="connection-shell-brand" href="/" aria-label="Polygraph home">
          <span className="connection-shell-mark" aria-hidden>PG</span>
          <span>POLYGRAPH</span>
        </a>

        <motion.div
          key={position}
          className="connection-shell-copy"
          initial={reduceMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition}
        >
          <p className="connection-shell-kicker">{story.kicker}</p>
          <h2>{story.title}</h2>
          <p className="connection-shell-lede">{story.lede}</p>
        </motion.div>

        <ol
          className="connection-shell-flow"
          aria-label={`Onboarding progress: step ${active} of ${steps.length}`}
        >
          {steps.map((step, index) => {
            const number = index + 1;
            const complete = number < active;
            const current = number === active;
            return (
              <li
                key={step.label}
                className={current ? 'is-current' : complete ? 'is-complete' : undefined}
                aria-current={current ? 'step' : undefined}
                aria-label={`Step ${number}: ${step.label}${current ? ', current' : complete ? ', complete' : ''}`}
              >
                <span>{complete ? <Check size={11} weight="bold" aria-hidden /> : String(number).padStart(2, '0')}</span>
                <div><b>{step.label}</b><small>{step.detail}</small></div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="connection-shell-card" aria-label={steps[active - 1].label}>
        <div className="connection-shell-card-glow" aria-hidden />
        <div className="connection-shell-card-head">
          <span className="connection-shell-live"><i /> LIVE WORKSPACE</span>
          <span>{String(active).padStart(2, '0')} / 04</span>
        </div>

        <div className="connection-shell-scroll">
          <motion.div
            key={position}
            className="connection-shell-card-body"
            initial={reduceMotion ? false : { opacity: 0, y: 20, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={transition}
          >
            {children}
          </motion.div>
        </div>

        <a className="connection-shell-back" href="/">
          Return to the story <ArrowUpRight size={14} aria-hidden />
        </a>
      </section>
    </main>
  );
}
