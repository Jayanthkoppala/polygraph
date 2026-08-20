/**
 * Benefits — ui-system.md §4.3, order 4: four outcome bullets, `#181818`
 * ground, plain grid, Phosphor glyphs (matching the icon set the rest of
 * the product already uses via `@phosphor-icons/react`).
 */
import { ShieldCheck, Prohibit, Wrench, ClockCounterClockwise } from '@phosphor-icons/react';

const BENEFITS = [
  { Icon: ShieldCheck, title: 'Release with proof', detail: 'Every PASS carries the evidence that earned it, not just a status code.' },
  { Icon: Prohibit, title: 'Quarantine the unrepairable', detail: 'A wrong target never gets an auto-fix offered — the refusal is the finding.' },
  { Icon: Wrench, title: 'Repair the fixable', detail: 'A collapsed field gets a suggested command, ready to run, never a silent patch.' },
  { Icon: ClockCounterClockwise, title: 'Every decision, hash chained', detail: 'Release, quarantine, repair, or rediscover — all written to a ledger that verifies itself.' },
];

export function Benefits() {
  return (
    <section className="bg-[#181818] px-6 py-16">
      <div className="mx-auto grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-2">
        {BENEFITS.map(({ Icon, title, detail }) => (
          <div key={title} className="flex gap-3">
            <Icon size={20} weight="regular" className="mt-0.5 shrink-0 text-[#9B9B9B]" aria-hidden />
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-[#EDEDED]">{title}</h3>
              <p className="text-sm text-[#9B9B9B]">{detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
