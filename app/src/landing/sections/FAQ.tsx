/**
 * FAQ — ui-system.md §4.3, order 8: eight questions, `#000000` ground,
 * rewritten for the HOSTED product's real objections: is my key safe, what
 * does it cost, what if I have no Bright Data account, can I self-host.
 * Every answer is a fact about the code or the tenant design
 * (tenant-architecture.md §§1–5, ux-spec.md §7) — no invented metrics, no
 * claim this build can't back up.
 */
import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Is my Bright Data API key safe here?',
    a: 'It is checked against Bright Data once, encrypted with AES-256-GCM before it touches disk, and stored under a key derived separately for your account. The decryption key lives in the server environment, never the database — someone who steals the database file cannot read your credential. No endpoint returns it, ever: you see the last four characters and a fingerprint, nothing more. Deleting your account deletes the ciphertext with it.',
  },
  {
    q: 'What does this cost me?',
    a: 'Polygraph is free while it is in hosted beta. Verification runs and any repair you approve go through your own Bright Data account, so that spend is yours, visible in your own Bright Data billing, and capped by the schedule you set. Auto-repair is off by default for exactly this reason.',
  },
  {
    q: 'I don’t have a Bright Data account. Can I still use this?',
    a: 'The hosted product watches Bright Data collectors, so it needs one. Without it you still get the whole idea: the sandbox above runs the real verification engine in your browser, and the open-source CLI runs the same pipeline offline on your machine — no account, no key, no network.',
  },
  {
    q: 'Will it change or re-run my scrapers without asking?',
    a: 'No. The hosted server has repair execution switched off at the environment level — a structural gate, not a setting a bug could flip. When a repair is the right answer, you get the diagnosis and the exact command to run against your own account. Nothing spends your credits or mutates your collector until you act.',
  },
  {
    q: 'What checks actually run on every pass?',
    a: 'Four: contract (is everything the schema promises actually there), coherence (did one field collapse while the others held), identity (is this the exact item we asked for, or a lookalike), and canaries (do inputs with known-good answers still come back right). Together they catch what a status code cannot: a 200 with the wrong data inside.',
  },
  {
    q: 'Why does a "wrong target" refuse repair instead of offering one?',
    a: 'Because the scraper is not broken — it fetched the wrong thing, perfectly. Re-deriving a field selector would make it fetch the wrong thing more reliably. The policy layer structurally excludes repair for identity failures and routes to quarantine or rediscovery instead. The refusal is the safety property you are buying.',
  },
  {
    q: 'What proves my ledger hasn’t been tampered with?',
    a: 'Every decision is SHA-256 hash chained to the one before it, and your account’s chain starts from its own genesis value — so rows cannot be transplanted in from another account, and verification walks your chain alone. "Verify chain" recomputes every hash from genesis; a single altered byte anywhere breaks the walk. Your export carries the whole chain and verifies standalone.',
  },
  {
    q: 'Can I self-host it instead?',
    a: 'Yes. Polygraph is MIT-licensed and the hosted product runs the same open-source server — `polygraph serve` on your own machine, with your own encryption master key, keeps every byte including your Bright Data key on hardware you control.',
  },
];

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="bg-[#000000] px-6 py-24">
      <h2 className="mx-auto mb-8 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        The questions you should be asking
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
