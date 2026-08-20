/**
 * ThreeFailures — ux-spec.md §1a below-the-fold item 1: "The three failures
 * we catch, each one line, each linked to a button above." Links jump back
 * to the hero's sandbox break buttons (`#sandbox`), the same anchor Hero's
 * CTA uses.
 */
/** Wording pass: no "selector", no "entity" — each failure described in
 * words someone who has never scraped a page already understands. */
const FAILURES = [
  {
    title: 'A field quietly stops filling.',
    detail:
      'The page changes shape, the scraper stops finding the price, and everything else still looks fine. Still HTTP 200.',
  },
  {
    title: 'The page serves the wrong thing.',
    detail:
      'Right shape, right fields, every value real — just for a different product than the one you asked about.',
  },
  {
    title: 'A run reports success with nothing behind it.',
    detail: 'The job finishes, the status is green, and the page it actually fetched was empty or unreachable.',
  },
];

export function ThreeFailures() {
  return (
    <section className="bg-[#181818] px-6 py-24">
      <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 sm:grid-cols-3">
        {FAILURES.map((f) => (
          <div key={f.title} className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-[#EDEDED]">{f.title}</h3>
            <p className="text-sm text-[#9B9B9B]">{f.detail}</p>
          </div>
        ))}
      </div>
      <div className="mx-auto mt-6 max-w-4xl text-center">
        <a href="#sandbox" className="font-mono text-sm text-[#9B9B9B] underline underline-offset-2">
          Go break one yourself →
        </a>
      </div>
    </section>
  );
}
