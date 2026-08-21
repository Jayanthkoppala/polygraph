import type { ReactNode } from 'react';

export function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#000000] text-[#EDEDED]">
      <nav
        aria-label="Primary"
        className="flex items-center border-b border-[#272727] bg-[#000000] px-6 py-4"
      >
        <a href="/" className="font-mono text-sm font-semibold tracking-wide text-[#EDEDED]">
          POLYGRAPH
        </a>
        <a href="/" className="ml-auto text-sm text-[#9B9B9B] hover:text-[#EDEDED]">
          Back to the sandbox
        </a>
      </nav>
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#9B9B9B]">Legal</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-[#EDEDED]">{title}</h1>
        <div className="mt-10 space-y-8 text-sm leading-7 text-[#C7C7C7]">{children}</div>
      </main>
    </div>
  );
}
