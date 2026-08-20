/**
 * Footer — ux-spec.md §1a below-the-fold item 4: "No testimonials, no logo
 * wall, no team section." Ship requirements from ui-system.md §4.3/B10:
 * privacy + terms links.
 */
export function Footer() {
  return (
    <footer className="border-t border-[#272727] bg-[#000000] px-6 py-10">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 text-center">
        <span className="font-mono text-sm text-[#9B9B9B]">Polygraph</span>
        <nav aria-label="Legal" className="flex gap-4 text-xs text-[#6E7681]">
          <a href="/legal/privacy" className="underline underline-offset-2 hover:text-[#9B9B9B]">
            Privacy
          </a>
          <a href="/legal/terms" className="underline underline-offset-2 hover:text-[#9B9B9B]">
            Terms
          </a>
        </nav>
      </div>
    </footer>
  );
}
