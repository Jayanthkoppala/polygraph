/**
 * ThreeFailures — ux-spec.md §1a below-the-fold item 1: "The three failures
 * we catch, each one line, each linked to a button above." Links jump back
 * to the hero's sandbox break buttons (`#sandbox`), the same anchor Hero's
 * CTA uses.
 *
 * Wording pass: no "selector", no "entity" — each failure described in
 * words someone running scrapers in production already recognises. The
 * heading names the shared property (nothing errors, everything stays
 * green) because that is the problem the whole page exists to solve.
 */
const FAILURES = [
  {
    title: 'A field quietly stops filling.',
    detail:
      'The page changes shape, the scraper stops finding the price, and everything else still looks fine. Still HTTP 200, still valid JSON — your database fills with empty prices.',
  },
  {
    title: 'The page serves the wrong thing.',
    detail:
      'Right shape, right fields, every value real — just for a different product than the one you asked about. No monitor on earth flags this one.',
  },
  {
    title: 'A run reports success with nothing behind it.',
    detail:
      'The job finishes, the status is green, and the page it actually fetched was empty or unreachable. The gap only shows up when someone queries the data.',
  },
];

export function ThreeFailures() {
  return (
    <section className="bg-[#181818] px-6 py-24">
      <h2 className="mx-auto mb-4 max-w-[680px] text-balance text-center text-3xl font-semibold text-[#EDEDED]">
        Scrapers don&rsquo;t fail loudly. They fail politely.
      </h2>
      <p className="mx-auto mb-10 max-w-[680px] text-pretty text-center text-base text-[#B4B4B4]">
        The dashboard stays green while the data goes wrong. Three ways it happens — all three are
        wired into the sandbox above, so you can trigger each one yourself.
      </p>
      <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 sm:grid-cols-3">
        {FAILURES.map((f) => (
          <div key={f.title} className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-[#EDEDED]">{f.title}</h3>
            <p className="text-pretty text-sm text-[#9B9B9B]">{f.detail}</p>
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
