/**
 * FAQ — S6 per positioning.md §3 and copy.md §2/S6: FIVE questions only,
 * copy.md verbatim (sandbox vs real product · what we call on your Bright
 * Data account · do you spend my credits · is my key safe · self-host —
 * "is my key safe" replaced "lose/revoke my key" per the copy owner's
 * swap: the revoke answer was a subset, and the custody objection deserves
 * the searchable title).
 * The previous eight-question set is deleted per the positioning ruling —
 * the hero now carries what those answered.
 *
 * shadcn-accordion-style disclosure, boring on purpose (positioning.md §4).
 */
import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Is the demo on this page the real product?',
    a: 'It is the real verification engine and a real SHA-256 chain, running entirely in your browser tab against fixture data. Nothing is persisted and there is no server behind it, so it never asks for a key. The hosted product is the same engine with signup, your own collectors, and your own ledger. If a page ever asks you for a Bright Data key, you are on a real instance; this page never will.',
  },
  {
    q: 'What does Polygraph call on my Bright Data account?',
    a: 'Two things, and nothing else: it lists your collectors once when you connect, and it triggers runs and reads their results on the schedule you set. A collector is Bright Data’s word for one configured scraper. It never modifies a collector and never reads beyond the collectors you pick.',
  },
  {
    q: 'Can Polygraph spend my credits?',
    a: 'Repairs are off for every hosted fleet, structurally: the hosted product does not trigger repairs on your behalf. Scheduled runs use your account the same way running the collector yourself would. When a break is repairable, Polygraph shows you the exact command and you decide whether to run it.',
  },
  {
    q: 'Is my Bright Data API key safe here?',
    a: 'It is encrypted before it touches disk, and the key that decrypts it is not in the database — it lives in the server environment, so a stolen database file yields ciphertext and nothing else. There is no endpoint that shows a stored key back, to you or to anyone. Every request ever made with it lands on your ledger, and revoking it takes one click: the stored copy is deleted, runs pause, and your ledger stays intact.',
  },
  {
    q: 'Can I self-host?',
    a: 'Yes. The engine is MIT licensed, and the full multi tenant server runs from a checkout with one command. It also runs entirely offline on a laptop with no account at all. The repo README covers both paths.',
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
              {open && <p className="px-4 pb-4 text-pretty text-sm text-[#9B9B9B]">{item.a}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
