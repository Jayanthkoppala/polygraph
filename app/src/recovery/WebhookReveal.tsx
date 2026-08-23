// The collector's webhook URL, re-readable on demand from its card (and shown
// straight after connect/rotate). Polygraph keeps an encrypted copy under the
// master key, so this is no longer a one-shot: the operator can come back for
// it whenever Bright Data needs it re-entered. Rotating is offered here too,
// because "I can't find the URL" and "the URL leaked" arrive at this dialog by
// the same route and need opposite answers.
import { useState } from 'react';
import { ArrowsClockwise, Check, CircleNotch, Copy, Warning, X } from '@phosphor-icons/react';

export function WebhookReveal({
  collectorName,
  webhookUrl,
  loading = false,
  error = null,
  rotating = false,
  onRotate,
  onClose,
}: {
  collectorName: string;
  /** `null` once loading has finished means the collector's token predates
   * encrypted storage — only a rotation can produce a URL for it. */
  webhookUrl: string | null;
  loading?: boolean;
  error?: string | null;
  rotating?: boolean;
  onRotate?: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  async function copy() {
    if (!webhookUrl) return;
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

        <div className="flex min-h-[46px] items-center gap-2 rounded-xl border border-[var(--color-line)] bg-black/30 px-3 py-2.5">
          {loading || rotating ? (
            <span className="flex items-center gap-2 font-mono text-xs text-[#9B9B9B]">
              <CircleNotch size={13} className="animate-spin" aria-hidden />
              {rotating ? 'Rotating…' : 'Loading…'}
            </span>
          ) : webhookUrl ? (
            <>
              <code data-testid="webhook-url" className="min-w-0 flex-1 truncate font-mono text-xs text-[#EDEDED]">{webhookUrl}</code>
              <button
                type="button"
                onClick={() => void copy()}
                aria-label="Copy webhook URL"
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#313131] bg-[#1B1B1B] px-2.5 text-xs font-medium text-[#EDEDED] transition-[background-color,border-color,transform] hover:border-[#4B4B4B] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
              >
                {copied ? <Check size={13} weight="bold" aria-hidden /> : <Copy size={13} aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </>
          ) : (
            <span className="font-mono text-xs text-[#9B9B9B]">Rotate to generate a URL</span>
          )}
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-200">{error}</p>
        )}

        <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2.5 text-xs leading-5 text-amber-200">
          <Warning size={14} weight="fill" className="mt-0.5 shrink-0" aria-hidden />
          Rotating issues a new URL and kills this one. Bright Data keeps delivering to
          whatever URL its webhook is configured with, so update that collector's
          delivery setting straight after rotating or its results stop arriving.
        </p>

        <div className="flex items-center justify-between gap-3">
          {onRotate ? (
            confirmingRotate ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingRotate(false);
                    onRotate();
                  }}
                  className="rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-400/20"
                >
                  Rotate and invalidate
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRotate(false)}
                  className="rounded-md border border-[#313131] px-2.5 py-1.5 text-xs text-[#9B9B9B] hover:bg-[var(--color-raised)]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRotate(true)}
                disabled={rotating}
                className="flex h-10 items-center gap-1.5 rounded-lg border border-[#313131] px-3 text-sm text-[#9B9B9B] transition-[background-color,border-color,color,transform] hover:border-[#4B4B4B] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-60"
              >
                <ArrowsClockwise size={14} aria-hidden />
                Rotate
              </button>
            )
          ) : (
            <span />
          )}
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
