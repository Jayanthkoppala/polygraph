/**
 * FinalCTA — ui-system.md §4.3, order 9: "identical to hero." Same label,
 * same button, `#181818` ground, pointing back at the sandbox anchor.
 */
export function FinalCTA() {
  return (
    <section className="bg-[#181818] px-6 py-24 text-center">
      <h2 className="mx-auto max-w-[680px] text-balance text-3xl font-semibold text-[#EDEDED] md:text-4xl">
        Point this at your own fleet.
      </h2>
      <a
        href="#sandbox"
        className="mt-8 inline-block rounded-lg bg-[#EDEDED] px-3 py-2 text-base font-semibold text-[#000000] outline-none
                   transition-colors duration-[var(--dur-fast)] ease-[var(--ease-fluid)] hover:bg-white
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
      >
        Run the verification demo
      </a>
    </section>
  );
}
