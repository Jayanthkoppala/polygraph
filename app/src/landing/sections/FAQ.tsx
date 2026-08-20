/**
 * FAQ — ui-system.md §4.3, order 8: eight questions, `#000000` ground. Every
 * answer here is a real fact about the code (the plan's honesty-pass
 * constraint) — no invented metrics, no claim this build can't back up.
 */
import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Is the sandbox above connected to a real Bright Data account?',
    a: 'No. It runs entirely against a local, offline fixture — the same 12-product catalog the CLI’s own demo uses. No account, no API key, no network call.',
  },
  {
    q: 'What does "wrong target" actually mean?',
    a: 'The page returned a fully-formed, genuinely real product — just not the one you asked for. Every field checks out; the identity check is the only thing that can catch it.',
  },
  {
    q: 'Why does "wrong target" refuse repair instead of offering one?',
    a: 'Re-deriving a field selector cannot fix fetching the wrong page. Polygraph’s policy layer structurally excludes REPAIR for an identity failure — it routes to quarantine or rediscovery instead, never a patch that would fix the wrong problem.',
  },
  {
    q: 'Does the hosted product auto-repair my scrapers?',
    a: 'No. Auto-heal stays a local-only CLI capability. The hosted server never enables it — you get the diagnosis and the exact suggested command, and you decide whether to run it.',
  },
  {
    q: 'Why is "blocked" mode not one of the sandbox’s break buttons?',
    a: 'The local fixture can’t emit a real anti-bot error code, so it would produce a structural-looking failure with the wrong suggested remedy. Showing it here would teach you something false.',
  },
  {
    q: 'What proves the ledger hasn’t been tampered with?',
    a: 'Every event is SHA-256 hash chained to the one before it. "Verify chain" walks the whole thing from genesis and recomputes every hash — a single altered byte in any row breaks the walk.',
  },
  {
    q: 'What checks actually run on every verification pass?',
    a: 'Four: contract (are required fields actually filled), coherence (did one field collapse while the rest look fine), identity (is this the entity we asked for), and a live canary re-fetch that confirms a failure before anything is called repairable.',
  },
  {
    q: 'Can I run the whole thing without signing up for anything?',
    a: 'Yes — the sandbox above needs no account, and `npx tsx src/index.ts demo` runs the same pipeline fully offline on your own machine.',
  },
];

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="bg-[#000000] px-6 py-24">
      <h2 className="mx-auto mb-8 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        Questions
      </h2>
      <div className="mx-auto max-w-3xl divide-y divide-[#272727] rounded-2xl border border-[#272727]">
        {FAQS.map((item, i) => {
          const open = openIndex === i;
          return (
            <div key={item.q}>
              <button
                type="button"
                onClick={() => setOpenIndex(open ? null : i)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-[#EDEDED]
                           outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
              >
                {item.q}
                <CaretDown
                  size={16}
                  weight="regular"
                  aria-hidden
                  className={`shrink-0 text-[#9B9B9B] transition-transform duration-[var(--dur-fast)] ${open ? 'rotate-180' : ''}`}
                />
              </button>
              {open && <p className="px-4 pb-4 text-sm text-[#9B9B9B]">{item.a}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
