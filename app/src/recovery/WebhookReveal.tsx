// The one-time webhook URL reveal after connect/rotate (§ contract: "Never return
// plaintext secrets ... anywhere" — the token embedded in this URL is the one
// exception, shown exactly once and never re-fetchable). Closing this panel is the
// only way to see it — there is no "show again" affordance anywhere else in the UI.
import { useState } from 'react';
import { Check, Copy, Warning, X } from '@phosphor-icons/react';

export function WebhookReveal({
  collectorName,
  webhookUrl,
  onClose,
}: {
  collectorName: string;
  webhookUrl: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(webhookUrl);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard access can be denied — the URL stays selectable in the field either way.
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhook-reveal-title"
        className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-[#38333f] bg-[var(--color-sunken)] p-6 shadow-[var(--shadow-e3)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a78bfa]">{collectorName}</p>
            <h2 id="webhook-reveal-title" className="text-balance text-xl font-semibold text-[#EDEDED]">Webhook URL</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close webhook URL"
            className="grid size-10 shrink-0 place-items-center rounded-lg text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-[var(--color-line)] bg-black/30 px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-[#EDEDED]">{webhookUrl}</code>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy webhook URL"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#313131] bg-[#1B1B1B] px-2.5 text-xs font-medium text-[#EDEDED] transition-[background-color,border-color,transform] hover:border-[#4B4B4B] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            {copied ? <Check size={13} weight="bold" aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2.5 text-xs leading-5 text-amber-200">
          <Warning size={14} weight="fill" className="mt-0.5 shrink-0" aria-hidden />
          This URL is shown once. Polygraph does not store or redisplay it — copy it now and point the collector's delivery at it, or rotate it to get a new one later.
        </p>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg bg-[#EDEDED] px-4 text-sm font-medium text-[#131209] transition-[background-color,transform] hover:bg-white active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
          >
            Done
          </button>
        </div>
      </section>
    </div>
  );
}
