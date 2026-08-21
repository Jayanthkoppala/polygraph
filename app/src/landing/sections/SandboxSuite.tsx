import { Check, Code, Cube, ShieldCheck, X } from '@phosphor-icons/react';
import { DotGrid } from '@/components/DotGrid';
import { DotPattern } from '@/components/ui/dot-pattern';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';
import { SandboxPanel } from '../sandbox/SandboxPanel';
import { PipelineFlowchart } from './PipelineFlowchart';

/**
 * The live sandbox gets a viewport of its own. The node-map treatment is
 * deliberately composition, not a second demo implementation: the fleet,
 * decisions, safe output, and ledger all read from the one engine instance
 * created by LandingPage.
 */
export function SandboxSuite({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const busy = sandbox.phase !== 'idle';
  const state = sandbox.mode === 'wrong_entity' ? 'wrong-target' : sandbox.mode === 'price_dead' ? 'wrong-shape' : 'verified';

  return (
    <section
      id="sandbox"
      aria-labelledby="sandbox-title"
      className="relative isolate min-h-[100svh] overflow-hidden border-y border-[#272727] bg-[#030404] px-4 py-24 sm:px-6"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.14]"
        style={{ maskImage: 'radial-gradient(ellipse at center, black 12%, transparent 82%)' }}
      >
        <DotPattern width={18} height={18} cx={1} cy={1} cr={1} className="text-[#8B949E]" />
      </div>

      <div className="mx-auto max-w-[1440px]">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-verdict-pass)]">
            Live browser sandbox
          </span>
          <h2 id="sandbox-title" className="mt-3 text-balance text-3xl font-bold leading-tight text-[#EDEDED] md:text-5xl">
            Break the run. Watch every check answer.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-base text-[#9B9B9B] md:text-lg">
            This is the real local verification engine, laid out as a suite. Change the fixture and follow the run from HTTP 200 to a safe decision.
          </p>
        </div>

        <div className="relative mt-10 overflow-hidden rounded-[28px] border border-[#272727] bg-[#060707] shadow-[var(--shadow-e3)]">
          <DotGrid
            dotSize={2}
            gap={14}
            baseColor="#272727"
            activeColor="#8B949E"
            proximity={130}
            shockRadius={180}
            shockStrength={2.4}
            className="absolute inset-0 opacity-70"
          />

          <div className="relative flex min-h-16 items-center border-b border-[#272727] px-4 sm:px-6">
            <div className="flex min-h-11 items-center gap-3 rounded-2xl border border-[#272727] bg-[#101111] px-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#EDEDED] text-[#000000]">
                <ShieldCheck size={16} weight="fill" aria-hidden />
              </span>
              <span className="font-mono text-xs text-[#EDEDED]">Polygraph</span>
              <span aria-hidden className="text-[#6E7681]">/</span>
              <span className="font-mono text-xs text-[#EDEDED] sm:hidden">sandbox</span>
              <span className="hidden font-mono text-xs text-[#9B9B9B] sm:inline">fixture-store</span>
              <span aria-hidden className="hidden text-[#6E7681] sm:inline">/</span>
              <span className="hidden font-mono text-xs text-[#EDEDED] sm:inline">sandbox suite</span>
            </div>
            <span className="ml-auto flex items-center gap-2 font-mono text-xs text-[#9B9B9B]">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: busy ? 'var(--color-verdict-suspect)' : stateColor(state) }}
              />
              {busy ? 'checking' : stateLabel(state)}
            </span>
          </div>

          <div className="relative grid grid-cols-1 gap-8 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:p-8">
            <div className="relative min-w-0">
              <div className="relative z-10 mx-auto w-full max-w-sm rounded-2xl border border-[#313131] bg-[#101111] p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#313131] bg-[#181818] text-[#EDEDED]">
                    <Cube size={18} weight="duotone" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#EDEDED]">Fixture run</p>
                    <p className="mt-1 truncate font-mono text-xs text-[#9B9B9B]">GET /products/sku-1042 · HTTP 200</p>
                  </div>
                  {state === 'verified' ? (
                    <Check size={16} weight="bold" className="ml-auto shrink-0" style={{ color: stateColor(state) }} aria-hidden />
                  ) : (
                    <X size={16} weight="bold" className="ml-auto shrink-0" style={{ color: stateColor(state) }} aria-hidden />
                  )}
                </div>
                <div className="mt-3 border-t border-[#272727] pt-3 font-mono text-xs text-[#9B9B9B]">
                  claimed success → verify independently
                </div>
              </div>

              <div aria-hidden className="mx-auto h-10 w-px bg-[#313131]" />
              <span aria-hidden className="absolute left-1/2 top-[154px] z-10 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-[#6E7681] bg-[#060707]" />

              <div className="relative z-10">
                <SandboxPanel sandbox={sandbox} />
              </div>

              <div className="relative mt-8 border-t border-[#272727] pt-8">
                <div className="mb-5 flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#313131] bg-[#181818] text-[#EDEDED]">
                    <Code size={18} weight="duotone" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-[#EDEDED]">Decision path</p>
                    <p className="text-xs text-[#9B9B9B]">The same run, opened up.</p>
                  </div>
                </div>
                <PipelineFlowchart sandbox={sandbox} />
              </div>

              <p className="mt-6 text-balance text-center text-lg font-semibold text-[#EDEDED]">
                Polygraph does not heal scrapers. It decides when healing is safe.
              </p>
            </div>

            <SuiteConversation sandbox={sandbox} />
          </div>
        </div>
      </div>
    </section>
  );
}

type SuiteState = 'verified' | 'wrong-shape' | 'wrong-target';

function stateColor(state: SuiteState) {
  if (state === 'wrong-target') return 'var(--color-verdict-target)';
  if (state === 'wrong-shape') return 'var(--color-verdict-shape)';
  return 'var(--color-verdict-pass)';
}

function stateLabel(state: SuiteState) {
  if (state === 'wrong-target') return 'wrong target';
  if (state === 'wrong-shape') return 'wrong shape';
  return 'verified';
}

function SuiteConversation({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const busy = sandbox.phase !== 'idle';
  const response = busy
    ? 'I am re-fetching the target and walking the four checks now.'
    : sandbox.mode === 'wrong_entity'
      ? 'The shape passed, but identity failed. I quarantined the run and refused repair.'
      : sandbox.mode === 'price_dead'
        ? 'The price field collapsed. I held the new run, kept the last safe snapshot, and prepared a repair.'
        : 'All three collectors verified. The safe snapshot and ledger are ready below.';

  return (
    <aside aria-label="Sandbox guide" className="relative flex flex-col gap-4 lg:pt-12">
      <div className="self-end rounded-2xl rounded-br-md border border-[#313131] bg-[#1F1F1F] px-4 py-3 text-sm leading-relaxed text-[#EDEDED]">
        Break the price field, or serve the wrong product.
      </div>
      <div
        aria-live="polite"
        className="rounded-2xl rounded-tl-md border bg-[#101111] px-4 py-3 text-sm leading-relaxed text-[#B4B4B4] transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-fluid)]"
        style={{ borderColor: busy ? '#313131' : stateColor(sandbox.mode === 'wrong_entity' ? 'wrong-target' : sandbox.mode === 'price_dead' ? 'wrong-shape' : 'verified') }}
      >
        <span className="mb-2 flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wide text-[#EDEDED]">
          <ShieldCheck size={14} weight="fill" aria-hidden />
          Polygraph
        </span>
        {response}
      </div>

      <div className="mt-2 rounded-2xl border border-[#272727] bg-[#0B0C0C] p-4">
        <p className="font-mono text-xs font-semibold uppercase tracking-wide text-[#9B9B9B]">What changes</p>
        <ul className="mt-3 flex flex-col gap-3 text-xs leading-relaxed text-[#9B9B9B]">
          <li className="flex gap-2"><span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-verdict-pass)]" />Green runs can advance safe output.</li>
          <li className="flex gap-2"><span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-verdict-shape)]" />Broken shape can receive a repair.</li>
          <li className="flex gap-2"><span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-verdict-target)]" />Wrong identity is quarantined, never auto-repaired.</li>
        </ul>
      </div>
    </aside>
  );
}
