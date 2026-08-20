/**
 * FinalCTA — ui-system.md §4.3, order 9: "identical to hero." Same button
 * treatment, same type, `#181818` ground.
 *
 * DESTINATION, deliberately not the hero's. §4.3's "identical to hero" is a
 * visual instruction (same button, one primary CTA) and was previously read
 * literally, `href="#sandbox"` and all — which pointed the page's LAST and
 * ONLY conversion control back up at a demo the reader has, by definition,
 * already scrolled past. ux-spec.md §1a puts "Point this at your own fleet
 * →" at exactly this position, and §3's handoff section describes the CTA
 * as the thing that carries a visitor into signup. So the button keeps the
 * hero's shape and takes the heading's own promise as its label, pointing
 * at `/signup` — the same route the nav's `Start` and the sandbox's
 * limit-reached copy already use.
 */
export function FinalCTA() {
  return (
    <section className="bg-[#181818] px-6 py-24 text-center">
      <h2 className="mx-auto max-w-[680px] text-balance text-3xl font-semibold text-[#EDEDED] md:text-4xl">
        Point this at your own fleet.
      </h2>
      <a
        href="/signup"
        data-testid="final-cta"
        className="mt-8 inline-block rounded-lg bg-[#EDEDED] px-3 py-2 text-base font-semibold text-[#000000] outline-none
                   transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:bg-white
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
      >
        Start your own fleet
      </a>
    </section>
  );
}
