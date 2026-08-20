/**
 * HowItWorks — ui-system.md §4.3, order 5: three steps, a terminal
 * transcript. Verbatim from `docs/demo.md`'s own scripted 3-minute demo —
 * real commands, real output strings, not invented copy (the plan's
 * honesty-pass constraint: "no invented metrics... no claim that isn't
 * true of the code").
 *
 * Restyled per §4.3: no macOS traffic-light dots (decoration with no
 * meaning here) — the header is the collector name in mono, since this is
 * a verification transcript, not a terminal emulator.
 */
import { motion } from 'motion/react';

const STEPS = [
  {
    title: '1. Break it',
    commands: ['polygraph chaos price_dead', 'polygraph run --collector demo-fixture-catalog'],
    output: [
      'demo-fixture-catalog: verdict=FAILED_STRUCTURAL cause=STRUCTURAL action=QUARANTINE run=...',
      '  suggested fix: bdata scraper heal demo-fixture-catalog "price return default/empty values on 100% of pages"',
    ],
  },
  {
    title: '2. The well-formed lie',
    commands: ['polygraph chaos wrong_entity', 'polygraph run --collector demo-fixture-catalog'],
    output: ['demo-fixture-catalog: verdict=FAILED_IDENTITY cause=IDENTITY action=REDISCOVER run=...'],
  },
  {
    title: '3. The receipt',
    commands: ['polygraph chaos healthy', 'polygraph run --collector demo-fixture-catalog', 'polygraph ledger verify'],
    output: ['ledger verify: OK — N event(s) verified, chain intact'],
  },
];

export function HowItWorks() {
  return (
    <section className="bg-[#000000] px-6 py-16">
      <h2 className="mx-auto mb-10 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        The same three-minute script, every time.
      </h2>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {STEPS.map((step, i) => (
          <motion.div
            key={step.title}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.8, delay: i * 0.1, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden rounded-2xl border border-[#272727] bg-[var(--color-archive)]"
          >
            <header className="flex items-center gap-2 border-b border-[#272727] px-3 py-2">
              <span className="text-xs font-medium text-[#EDEDED]">{step.title}</span>
              <span className="ml-auto font-mono text-xs text-[#6E7681]">demo-fixture-catalog</span>
            </header>
            <div className="flex flex-col gap-1 p-3 font-mono text-xs">
              {step.commands.map((c) => (
                <div key={c} className="text-[#EDEDED]">
                  <span className="text-[#6E7681]">$ </span>
                  {c}
                </div>
              ))}
              {step.output.map((o) => (
                <div key={o} className="text-[#9B9B9B]">
                  {o}
                </div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
