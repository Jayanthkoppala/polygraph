// S6 footer. `Terms` ships alongside copy.md links because ui-system.md §4.3/B10
// makes privacy AND terms mandatory.
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
          <a
            href="https://github.com/Jayanthkoppala/polygraph"
            className="underline underline-offset-2 hover:text-[#EDEDED]"
          >
            GitHub
          </a>
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
