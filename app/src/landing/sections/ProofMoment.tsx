/**
 * ProofMoment — ui-system.md §4.2, "the most important visual in the
 * product." Two real `VerdictCard`s, same HTTP 200, opposite verdicts: one
 * WRONG_SHAPE (price collapsed, FILL 62%, live Repair), one WRONG_TARGET
 * (FILL 100% — "by every measure a status monitor has, that card is
 * passing" — Repair refused). Static, seeded data, not the interactive
 * sandbox: this is the "get it" image, always the same, always true.
 *
 * The right card replays the WRONG_TARGET entity-key substitution once per
 * viewport entry (never loops) by remounting `VerdictCard` on a bumped
 * `key` each time an IntersectionObserver reports a fresh entry — the same
 * event-only-motion gate Task 6 built (`useSkipEntrance`) only plays that
 * animation on a genuine transition, so a remount is what makes it replay.
 * The left card never remounts and never animates.
 */
import { useEffect, useRef, useState } from 'react';
import { VerdictCard } from '@/components/fleet/VerdictCard';
import type { CollectorState } from '@/lib/api';

const noop = () => {};

const WRONG_SHAPE_CARD: CollectorState = {
  id: 'books-prices',
  name: 'books prices',
  verdict: 'FAILED_CONTRACT',
  cause: 'STRUCTURAL',
  action: 'REPAIR',
  rows: 20,
  fillPct: 62,
  fillRates: { price: 0, title: 1, stock: 1, sku: 0.86 },
  lastTs: new Date().toISOString(),
  ledgerId: 1001,
  needsAck: false,
  acked: false,
  healAttemptsToday: 0,
  unverified: false,
  pureAction: 'REPAIR',
  actionReason: 'price field collapsed to 0% fill — safe to repair automatically',
  suggestedHealCommand: 'polygraph heal books-prices --field price',
  evidence: null,
};

const WRONG_TARGET_CARD: CollectorState = {
  id: 'books-detail',
  name: 'books detail',
  verdict: 'FAILED_IDENTITY',
  cause: 'IDENTITY',
  action: 'QUARANTINE',
  rows: 20,
  fillPct: 100,
  fillRates: { price: 1, title: 1, stock: 1, sku: 1 },
  lastTs: new Date().toISOString(),
  ledgerId: 1002,
  needsAck: false,
  acked: false,
  healAttemptsToday: 0,
  unverified: false,
  pureAction: 'QUARANTINE',
  actionReason: "returned a different product than requested — repair can't fix a wrong target, quarantining instead",
  suggestedHealCommand: null,
  evidence: [
    {
      check: 'identity',
      ok: false,
      detail: 'mismatchRate=1',
      metrics: {
        compared: 1,
        mismatched: 1,
        mismatches: [{ input: 'books-detail', requestedKey: 'a light in the attic', extractedKey: 'tipping the velvet' }],
      },
    },
  ],
};

export function ProofMoment() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let wasVisible = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !wasVisible) {
          setReplayKey((k) => k + 1);
        }
        wasVisible = entry.isIntersecting;
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section className="bg-[#000000] px-6 py-16">
      <div ref={sectionRef} className="mx-auto grid max-w-4xl grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <HttpTag />
          <VerdictCard collector={WRONG_SHAPE_CARD} density="hero" onSelect={noop} onRepair={noop} onAcknowledge={noop} />
        </div>
        <div className="flex flex-col gap-2">
          <HttpTag />
          <VerdictCard
            key={replayKey}
            collector={WRONG_TARGET_CARD}
            density="hero"
            onSelect={noop}
            onRepair={noop}
            onAcknowledge={noop}
          />
        </div>
      </div>
      <p className="mx-auto mt-6 max-w-4xl text-center text-base text-[#9B9B9B]">
        Same status code. Same shaped JSON. Only one of these can be repaired.
      </p>
    </section>
  );
}

function HttpTag() {
  return <span className="self-start font-mono text-xs tabular-nums text-[#6E7681]">HTTP 200</span>;
}
