/**
 * Not rendered anywhere. Exists purely so Tailwind v4's content scanner
 * (which text-scans the whole project for class-name-shaped and
 * var(--token)-shaped substrings, and tree-shakes any `@theme` custom
 * property it never sees referenced) has a real usage of every design
 * token this project defines — the same `bg-[var(--color-verdict-pass)]` /
 * `shadow-[var(--shadow-e2)]` / `ease-[var(--ease-fluid)]` arbitrary-value
 * syntax the ui-system.md spec's own component snippets use — so
 * tokens.smoke.test.ts can compile app.css and assert every token actually
 * resolves the way a real component will reference it, not just that it's
 * declared and immediately thrown away.
 *
 * Tailwind's default scale (type, spacing, radii) is exercised too, so a
 * regression from Tailwind v3 semantics (e.g. rounded-sm silently meaning
 * 2px instead of 4px) would show up here before it reaches any screen.
 */
export function TokenUsageFixture() {
  return (
    <div className="rounded-xs rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl rounded-3xl rounded-4xl rounded-full">
      <p className="text-xs text-sm text-base text-lg text-2xl text-3xl text-4xl text-5xl text-6xl" />
      <div className="p-3 gap-1 gap-2 gap-4 gap-6 gap-8 py-24" />
      <span className="font-sans font-mono tabular-nums tracking-wide uppercase" />

      {/* Surfaces, §1.2 */}
      <div className="bg-[var(--color-void)] bg-[var(--color-sunken)] bg-[var(--color-surface)] bg-[var(--color-raised)] border-[var(--color-line)] bg-[var(--color-archive)]" />

      {/* Verdict palette, §1.4 */}
      <div className="text-[var(--color-verdict-pass)] text-[var(--color-verdict-suspect)] text-[var(--color-verdict-shape)] text-[var(--color-verdict-target)] text-[var(--color-verdict-unchecked)]" />

      {/* Elevation, §1.8 */}
      <div className="shadow-[var(--shadow-e1)] shadow-[var(--shadow-e2)] shadow-[var(--shadow-e3)] shadow-[var(--shadow-e0)]" />

      {/* Motion, §1.9 */}
      <div className="ease-[var(--ease-fluid)] ease-[var(--ease-snap)] ease-[var(--ease-exit)] duration-[var(--dur-instant)] duration-[var(--dur-fast)] duration-[var(--dur-base)] duration-[var(--dur-slow)] duration-[var(--dur-reveal)]" />
    </div>
  );
}
