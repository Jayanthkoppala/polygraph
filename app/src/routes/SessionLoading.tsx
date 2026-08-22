/** Shared "checking session…" state for both gate routes — never a blank white
 * screen while the session check is in flight. */
export function SessionLoading() {
  return (
    <main className="flex min-h-[calc(100svh-var(--poly-chrome-offset,0px))] items-center justify-center bg-black/55 font-sans text-[#EDEDED]">
      <p className="font-mono text-sm text-[#C5C5CC]">checking session…</p>
    </main>
  );
}

/** Shown when the session probe could not answer at all, as opposed to answering 401.
 * Never auto-redirects: resolving failures to `'anonymous'` ejected live sessions. */
export function SessionUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <main
      data-testid="session-unavailable"
      className="flex min-h-[calc(100svh-var(--poly-chrome-offset,0px))] items-center justify-center bg-black/55 p-8 font-sans text-[#EDEDED]"
    >
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-8">
        <h1 className="text-lg font-semibold">Couldn&rsquo;t reach Polygraph.</h1>
        <p className="text-sm text-[#9B9B9B]">
          We couldn&rsquo;t check your session, so we haven&rsquo;t signed you out and we haven&rsquo;t
          guessed. Nothing has changed on your fleet.
        </p>
        <button
          type="button"
          data-testid="session-retry"
          onClick={onRetry}
          className="h-10 w-full rounded-sm bg-[#EDEDED] text-sm font-medium text-[#131209] outline-none transition-[background-color,transform] duration-150 hover:bg-[#EDEDED]/90 focus-visible:ring-[3px] focus-visible:ring-[#EDEDED]/50 active:scale-[0.96]"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
