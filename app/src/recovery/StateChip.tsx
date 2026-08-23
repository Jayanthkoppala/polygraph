// One chip per recovery state. Text is always the server's own `stateCopy` — never
// derived here — so the chip only owns color/icon, matching state → tone.
import { CheckCircle, Clock, MagnifyingGlass, WarningCircle, ArrowsClockwise } from '@phosphor-icons/react';
import type { RecoveryState } from '@/lib/recoveryApi';

const TONE: Record<RecoveryState, { className: string; Icon: typeof CheckCircle; spin?: boolean }> = {
  WAITING_BASELINE: { className: 'border-[#313131] bg-[#1B1B1B] text-[#9B9B9B]', Icon: Clock },
  MONITORING_ONLY: { className: 'border-sky-400/30 bg-sky-400/10 text-sky-300', Icon: MagnifyingGlass },
  RECOVERING: { className: 'border-amber-300/30 bg-amber-300/10 text-amber-200', Icon: ArrowsClockwise, spin: true },
  HELD: { className: 'border-red-400/30 bg-red-400/10 text-red-300', Icon: WarningCircle },
  VERIFIED: { className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300', Icon: CheckCircle },
  READY: { className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300', Icon: CheckCircle },
};

export function StateChip({ state, stateCopy }: { state: RecoveryState; stateCopy: string }) {
  const tone = TONE[state] ?? TONE.HELD;
  const { Icon } = tone;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] leading-tight ${tone.className}`}
    >
      <Icon size={12} weight="fill" className={tone.spin ? 'animate-spin' : ''} aria-hidden />
      <span className="truncate">{stateCopy}</span>
    </span>
  );
}
