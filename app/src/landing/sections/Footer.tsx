/**
 * Footer — ux-spec.md §1a below-the-fold item 4: "No testimonials, no logo
 * wall, no team section." Ship requirements from ui-system.md §4.3/B10:
 * privacy + terms links.
 *
 * The legal links are `--text-muted`, not `--text-faint`: they are named
 * destinations a reader has to be able to find and click, which §1.3 rules
 * out for the faint token ("Never for text that carries meaning" — it also
 * fails AA at 3.59:1). B10 makes them mandatory; setting a mandatory link
 * below the contrast floor is the same as not shipping it.
 */
export function Footer() {
  return (
    <footer className="border-t border-[#272727] bg-[#000000] px-6 py-10">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 text-center">
        <span className="font-mono text-sm text-[#9B9B9B]">Polygraph</span>
        <nav aria-label="Legal" className="flex gap-4 text-xs text-[#9B9B9B]">
          <a href="/legal/privacy" className="underline underline-offset-2 hover:text-[#EDEDED]">
            Privacy
          </a>
          <a href="/legal/terms" className="underline underline-offset-2 hover:text-[#EDEDED]">
            Terms
          </a>
        </nav>
      </div>
    </footer>
  );
}
