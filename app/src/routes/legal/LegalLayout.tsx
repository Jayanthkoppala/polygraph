import type { ReactNode } from 'react';

export function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-[calc(100svh-var(--poly-chrome-offset,0px))] bg-black/55 text-[#EDEDED]">
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#9B9B9B]">Legal</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-[#EDEDED]">{title}</h1>
        <div className="mt-10 space-y-8 text-sm leading-7 text-[#C7C7C7]">{children}</div>
      </main>
    </div>
  );
}
