/**
 * FinalCTA — S6's slim repeat CTA per positioning.md §3 and copy.md §2/S6:
 * one line + button, copy.md verbatim. `#181818` ground, hero button
 * treatment (ui-system.md §4.3's "identical to hero" is visual).
 *
 * DESTINATION stays `/signup`, pinned by landing-system.test.tsx: an
 * earlier literal reading produced `href="#sandbox"`, which pointed the
 * page's last conversion control back up at a demo the reader had already
 * scrolled past, and the page converted nowhere.
 */
export function FinalCTA() {
  return (
    <section className="bg-[#181818] px-6 py-24 text-center">
      <h2 className="mx-auto max-w-[680px] text-balance text-3xl font-semibold text-[#EDEDED]">
        Your dashboards are green. Polygraph checks whether they are right.
      </h2>
      <a
        href="/signup"
        data-testid="final-cta"
        className="mt-8 inline-block rounded-lg bg-[#EDEDED] px-3 py-2 text-base font-semibold text-[#000000] outline-none
                   transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:bg-white
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
      >
        Point this at your own fleet →
      </a>
    </section>
  );
}
