/**
 * Footer — S6 footer per copy.md §2/S6: the one-line premise plus links
 * `Sandbox · GitHub · Privacy · Sign in`. No testimonials, no logo wall,
 * no team section, no test counts.
 *
 * `Terms` is kept alongside copy.md's links: ui-system.md §4.3/B10 makes
 * privacy AND terms mandatory ship requirements — ratified by the lead and
 * positioning, and copy.md's list now includes it.
 *
 * The GitHub link from copy.md's list is deliberately NOT rendered yet:
 * package.json's `repository` URL 404s and the repo has no remote. See the
 * comment at the link site below.
 */
export function Footer() {
  return (
    <footer className="border-t border-[#272727] bg-[#000000] px-6 py-10">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 text-center">
        <span className="font-mono text-sm text-[#9B9B9B]">Polygraph</span>
        <p className="text-pretty text-xs text-[#9B9B9B]">
          Built on one premise: &ldquo;the job succeeded&rdquo; and &ldquo;the data is
          correct&rdquo; are different claims.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-4 text-xs text-[#9B9B9B]">
          <a href="#sandbox" className="underline underline-offset-2 hover:text-[#EDEDED]">
            Sandbox
          </a>
          {/* GitHub link intentionally absent: package.json's repository
              URL 404s and this repo has no remote — nothing has been
              pushed. A dead GitHub link on a page selling verification is
              self-refuting. Restore the link (copy.md's list has it) the
              moment the public repo exists (team-lead ruling, 2026-08-20). */}
          <a href="/legal/privacy" className="underline underline-offset-2 hover:text-[#EDEDED]">
            Privacy
          </a>
          <a href="/legal/terms" className="underline underline-offset-2 hover:text-[#EDEDED]">
            Terms
          </a>
          <a href="/login" className="underline underline-offset-2 hover:text-[#EDEDED]">
            Sign in
          </a>
        </nav>
      </div>
    </footer>
  );
}
