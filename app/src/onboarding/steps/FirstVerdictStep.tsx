/** Step 4 — the handoff. NEVER render a pass for a collector that hasn't run: Bright
 * Data owns the schedule, so "Awaiting first delivery" is the only honest copy. */
import { useState } from 'react';
import { SealCheck, EyeSlash, ArrowRight, CalendarBlank, Copy, Check, ArrowSquareOut } from '@phosphor-icons/react';
import { OnboardingPanel } from '../OnboardingPanel';
import { Button } from '@/components/ui/button';

export interface FirstVerdictStepProps {
  confirmedIds: string[];
  deliveryUrl?: string;
  onGoToFleet: () => void;
}

export function FirstVerdictStep({ confirmedIds, deliveryUrl, onGoToFleet }: FirstVerdictStepProps) {
  const [copied, setCopied] = useState(false);
  const collectorId = confirmedIds[0];
  const brightDataUrl = collectorId
    ? `https://brightdata.com/cp/scrapers?id=${encodeURIComponent(collectorId)}`
    : 'https://brightdata.com/cp/scrapers';

  const copyDeliveryUrl = async () => {
    if (!deliveryUrl || !navigator.clipboard) return;
    await navigator.clipboard.writeText(deliveryUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <OnboardingPanel bare title="Finish the connection." subtitle="Give Bright Data one place to send each completed scheduled run.">
      <div className="flex flex-col gap-5">
        <div
          data-testid="first-verdict-status"
          data-verdict-state="NOT_CHECKED"
          className="flex items-center gap-2 rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2.5 text-sm text-[#EDEDED]"
        >
          <EyeSlash size={14} weight="regular" className="text-[#8B949E]" aria-hidden />
          Awaiting Bright Data's first delivery — never a pass until a real check has actually run.
        </div>

        <div className="overflow-hidden rounded-2xl border border-[#31263f] bg-[linear-gradient(145deg,#17121f_0%,#111014_72%)] shadow-[0_18px_48px_rgba(0,0,0,.28)]">
          <div className="flex items-center justify-between border-b border-[#2b2434] px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-[#b7a7cb]">
              <CalendarBlank size={15} className="text-[#a78bfa]" aria-hidden />
              Bright Data delivery
            </div>
            <span className="rounded-full border border-[#47345f] bg-[#241a31] px-2 py-1 font-mono text-[9px] tracking-[0.12em] text-[#c4b5fd]">ONE-TIME SETUP</span>
          </div>

          <ol className="grid gap-0 px-4 pt-3 text-xs text-[#aaa5af] sm:grid-cols-3">
            {['Open Delivery preferences', 'Choose Webhook + JSON', 'Paste this URL'].map((label, index) => (
              <li key={label} className="flex items-center gap-2 border-b border-[#25212a] py-2.5 sm:border-b-0 sm:border-r sm:last:border-r-0 sm:px-3 sm:first:pl-0">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#28202f] font-mono text-[9px] text-[#c4b5fd]">{index + 1}</span>
                {label}
              </li>
            ))}
          </ol>

          <div className="m-4 mt-3 rounded-xl border border-[#332a3e] bg-[#0c0b0f] p-2">
            <code data-testid="delivery-url" className="block max-h-14 overflow-auto break-all px-2 py-1.5 font-mono text-[11px] leading-5 text-[#d8d1e1]">
              {deliveryUrl ?? 'Delivery URL unavailable — reconnect this collector.'}
            </code>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void copyDeliveryUrl()}
                disabled={!deliveryUrl}
                aria-label="Copy Polygraph delivery URL"
                className="flex h-9 items-center justify-center gap-2 rounded-lg bg-[#8b5cf6] text-xs font-medium text-white transition hover:bg-[#9d73f7] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
              >
                {copied ? <Check size={14} weight="bold" aria-hidden /> : <Copy size={14} aria-hidden />}
                {copied ? 'Copied' : 'Copy URL'}
              </button>
              <a
                href={brightDataUrl}
                target="_blank"
                rel="noreferrer"
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#37313e] bg-[#17151b] text-xs font-medium text-[#ddd7e4] transition hover:border-[#6d548d] hover:bg-[#1e1924]"
              >
                Open Bright Data
                <ArrowSquareOut size={13} aria-hidden />
              </a>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-[#30283f] bg-[#171220] px-4 py-3 text-sm">
          <CalendarBlank size={16} className="mt-0.5 shrink-0 text-[#a78bfa]" aria-hidden />
          <div className="flex flex-col gap-1">
            <b className="font-medium text-[#EDEDED]">Bright Data still owns the schedule</b>
            <span className="text-xs leading-5 text-[#9B9B9B]">Polygraph builds evidence from each completed delivery. A proven structural break enters the recovery policy; ambiguous data is held, never repaired blindly.</span>
          </div>
        </div>

        {confirmedIds.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-[#8B949E]">Collector contract saved</p>
            <ul className="flex flex-col gap-1">
              {confirmedIds.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm text-[#EDEDED]">
                  <SealCheck size={12} weight="regular" className="text-[var(--color-verdict-pass)]" aria-hidden />
                  {id}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button type="button" onClick={onGoToFleet} data-testid="go-to-fleet" className="h-10 w-full gap-2">
          Open the waiting dashboard
          <ArrowRight size={14} weight="bold" aria-hidden />
        </Button>
      </div>
    </OnboardingPanel>
  );
}
