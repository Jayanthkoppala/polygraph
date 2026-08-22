// S6 slim repeat CTA plus the S5 "Run it yourself" band. DESTINATION stays
// `/signup`, pinned by landing-system.test.tsx — `#sandbox` converted nowhere.
import { useEffect, useRef, useState } from 'react';

const DEMO_COMMAND = 'npx tsx src/index.ts demo';

function RunItYourself() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function handleCopy() {
    void navigator.clipboard?.writeText(DEMO_COMMAND);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section id="run-it-yourself" className="bg-[#000000] px-6 py-24 text-center">
      <p className="mx-auto max-w-[680px] text-pretty text-base text-[#B4B4B4]">
        The same engine is MIT-licensed and runs fully offline — no account, no key.
      </p>
      <div className="mx-auto mt-4 inline-flex items-center gap-3 rounded-lg border border-[#272727] bg-[#1F1F1F] px-3 py-2">
        <code className="font-mono text-sm text-[#EDEDED]">{DEMO_COMMAND}</code>
        <button
          type="button"
          onClick={handleCopy}
          data-copied={copied}
          data-testid="selfhost-copy-command"
          className="rounded-sm border border-[#272727] px-2 py-1 font-mono text-xs text-[#9B9B9B] outline-none
                     hover:text-[#EDEDED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </section>
  );
}

export function FinalCTA() {
  return (
    <>
      <RunItYourself />
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
    </>
  );
}
