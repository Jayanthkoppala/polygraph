/**
 * Benefits — ui-system.md §4.3, order 4, rewritten for the HOSTED product:
 * who this is for and what an account actually gets, including the
 * multi-tenant guarantees stated plainly (tenant-architecture.md §§1–3):
 * encrypted key custody, a per-account hash chain, auto-repair off by
 * default because repairs spend the customer's own Bright Data credits.
 *
 * Laid out with Magic UI `bento-grid`
 * (src/landing/magicui/bento-grid.tsx, corrected per §3.1's convention).
 * No invented numbers: five collectors is `tenants.max_collectors`
 * (src/tenancy/migrate.ts:85), the custody facts are §2's scheme verbatim,
 * signup's shape is §1's capability-token flow.
 */
import { Detective, HandPalm, Key, LinkSimple, Swap } from '@phosphor-icons/react';
import { BentoCard, BentoGrid } from '../magicui/bento-grid';
import { BlurFade } from '../magicui/blur-fade';

const CARDS = [
  {
    Icon: Detective,
    name: 'For scrapers already in production',
    description:
      'If collectors feed your dashboards, pricing, or pipelines, you have met this failure: the job succeeds, the chart drifts, and three weeks later someone asks why the numbers are wrong. Polygraph finds it on the next scheduled run instead — and holds the bad rows before they land.',
    className: 'lg:col-span-2',
  },
  {
    Icon: Key,
    name: 'Your key is encrypted, then never shown again',
    description:
      'Your Bright Data key is encrypted with AES-256-GCM before it touches disk, under a key derived separately for your account. The decryption key lives in the server environment, never the database. You only ever see the last four characters and a fingerprint.',
    className: 'lg:col-span-1',
  },
  {
    Icon: LinkSimple,
    name: 'Your ledger is yours alone',
    description:
      'Every account gets its own hash chain with its own genesis — not a shared log with your rows mixed in. It verifies on its own, exports on its own, and deleting your account deletes it cleanly.',
    className: 'lg:col-span-1',
  },
  {
    Icon: HandPalm,
    name: 'Auto-repair is off by default',
    description:
      'Repairs run through your Bright Data account and spend your credits, so the hosted product never starts one on its own. You get the diagnosis and the exact fix; the decision to spend stays yours.',
    className: 'lg:col-span-1',
  },
  {
    Icon: Swap,
    name: 'A refusal you can trust',
    description:
      'When a collector returns perfect-looking data for the wrong item, Polygraph refuses to repair it — a patched scraper would just fetch the wrong thing more reliably. The refusal is recorded in your ledger like every other decision.',
    className: 'lg:col-span-1',
  },
] as const;

export function Benefits() {
  return (
    <section className="bg-[#181818] px-6 py-24">
      <h2 className="mx-auto mb-4 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        A verified fleet of your own
      </h2>
      <p className="mx-auto mb-12 max-w-[680px] text-pretty text-center text-base text-[#B4B4B4]">
        Sign up with a fleet name — no password, no email required. Paste your Bright Data key,
        pick up to five collectors, and every run they make gets judged before you trust it.
      </p>
      <div className="mx-auto max-w-5xl">
        <BlurFade>
          <BentoGrid>
            {CARDS.map((card) => (
              <BentoCard key={card.name} {...card} />
            ))}
          </BentoGrid>
        </BlurFade>
      </div>
    </section>
  );
}
