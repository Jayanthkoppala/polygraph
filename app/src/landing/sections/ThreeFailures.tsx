/**
 * ThreeFailures — S2 "The three lies we catch" per positioning.md §3 and
 * copy.md §2/S2 (canonical copy, pasted verbatim — including its open
 * compounds like "anti bot"; the spelling law lives in copy.md's preamble).
 *
 * Three ROWS, not a card grid (positioning.md: "Three rows (not a card
 * grid), each: plain-English name → the proof line the product would show →
 * which break button above demonstrates it"). shadcn-style flat bordered
 * rows — structure only, the proof lines carry the section. This section
 * absorbs what ProofMoment + the old ThreeFailures card grid covered.
 *
 * The third lie deliberately says it is NOT in the sandbox: the sandbox
 * cannot fake a real anti bot block without teaching something false
 * (the same honesty ruling that removed the `blocked` chaos button).
 */
import { BlurFade } from '../magicui/blur-fade';

const LIES: {
  name: string;
  pointer: { label: string; href?: string };
  body: React.ReactNode;
}[] = [
  {
    name: 'A field dies quietly',
    pointer: { label: 'press “Kill the price field” above', href: '#sandbox' },
    body: (
      <>
        The page loads, the run reports success, and one field comes back empty on every row. The
        proof is a comparison:{' '}
        <span className="font-mono text-[#EDEDED]">price filled on 0% of rows. Every other field: 100%.</span>{' '}
        One collapsed field against healthy neighbours means a broken extractor, and for that one
        failure Polygraph hands you the exact repair.
      </>
    ),
  },
  {
    name: 'The wrong thing entirely',
    pointer: { label: 'press “Serve the wrong product” above', href: '#sandbox' },
    body: (
      <>
        The data is complete, well formed, and about the wrong product. Every check that only looks
        at shape would pass it. The proof:{' '}
        <span className="font-mono text-[#EDEDED]">Asked for SKU-4471. Received SKU-9012.</span> No
        parser fix can undo fetching the wrong page, so this one is never offered a repair.
      </>
    ),
  },
  {
    name: 'A block dressed as success',
    pointer: { label: 'not in the sandbox, and honestly so' },
    body: (
      <>
        The site pushed back: the response says 200, but it is an anti bot page, not your data.
        Polygraph reads the block for what it is and holds everything. The sandbox cannot fake a
        real block without teaching you something false, so it does not try.
      </>
    ),
  },
];

export function ThreeFailures() {
  return (
    <section className="bg-[#181818] px-6 py-24">
      <h2 className="mx-auto mb-10 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        The three lies we catch
      </h2>
      <BlurFade>
        <div className="mx-auto flex max-w-4xl flex-col divide-y divide-[#272727] overflow-hidden rounded-2xl border border-[#272727] bg-[#1F1F1F]">
          {LIES.map((lie) => (
            <div key={lie.name} className="grid grid-cols-1 gap-2 p-4 md:grid-cols-[240px_1fr] md:gap-8">
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold text-[#EDEDED]">{lie.name}</h3>
                {lie.pointer.href ? (
                  <a
                    href={lie.pointer.href}
                    className="font-mono text-xs text-[#9B9B9B] underline underline-offset-2 hover:text-[#EDEDED]"
                  >
                    {lie.pointer.label}
                  </a>
                ) : (
                  <span className="font-mono text-xs text-[#9B9B9B]">{lie.pointer.label}</span>
                )}
              </div>
              <p className="text-pretty text-sm text-[#B4B4B4]">{lie.body}</p>
            </div>
          ))}
        </div>
      </BlurFade>

      {/* S2's closing block: the heal-promotion finding (re-homed here from
          the dissolved S3). Text is copy.md's locked wording verbatim —
          "hedges and date locked, do not strengthen or round" — every claim
          grounded in docs/FINDING-heal-promotion.md. It sits on the
          warm-archive surface (--color-archive) because it is a record, not
          live state (ui-system §1.2). */}
      <BlurFade>
        <div className="mx-auto mt-8 max-w-4xl rounded-2xl border border-[#272727] bg-[var(--color-archive)] p-4">
          <h3 className="text-base font-semibold text-[#EDEDED]">We caught a repair lying, too.</h3>
          <p className="mt-2 text-pretty text-sm text-[#B4B4B4]">
            We ran a vendor self-heal live (2026-08-20). It reported &quot;done&quot; in about 105 seconds, with
            the approval step completed — and the change landed in a draft: the collector&rsquo;s production
            schema was unchanged, and we found no API endpoint that promotes a draft to production. Polygraph
            checks the schema before and after a repair, and refuses to call that a recovery.
          </p>
          <a
            href="https://github.com/jayanth137/polygraph/blob/main/docs/FINDING-heal-promotion.md"
            className="mt-3 inline-block font-mono text-sm text-[#9B9B9B] underline underline-offset-2 hover:text-[#EDEDED]"
          >
            Read the finding →
          </a>
        </div>
      </BlurFade>
    </section>
  );
}
