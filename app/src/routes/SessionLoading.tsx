/** Shared "checking session…" state for both gate routes below — same
 * quiet, on-brand loading text `FleetApp` already uses for `/api/state`,
 * never a blank white screen while the session check is in flight. */
export function SessionLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-void)] font-sans text-[#EDEDED]">
      <p className="font-mono text-sm text-[#9B9B9B]">checking session…</p>
    </main>
  );
}
