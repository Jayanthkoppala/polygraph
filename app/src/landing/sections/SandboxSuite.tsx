import { Check, MagnifyingGlass, Prohibit, ShieldCheck } from '@phosphor-icons/react';
import { DotGrid } from '@/components/DotGrid';
import { DotPattern } from '@/components/ui/dot-pattern';
import type { UseSandboxEngineResult } from '../sandbox/useSandboxEngine';
import { SafeOutputPanel } from '../sandbox/SafeOutputPanel';
import { SANDBOX_COLLECTORS, SANDBOX_ROWS, probedProduct, receivedProduct } from '../sandbox/fixtureData';
import type { SandboxMode } from '../sandbox/engine';

const BREAK_CLASS =
  'inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg border border-[#272727] bg-[#272727] px-3 py-2 text-sm font-semibold text-[#EDEDED] outline-none transition-[background-color,transform,color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-fluid)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#272727] hover:bg-[#313131] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]';

const SECONDARY_ACTIONS: { mode: SandboxMode; label: string }[] = [
  { mode: 'price_dead', label: 'Kill the price field' },
  { mode: 'wrong_entity', label: 'Serve the wrong product' },
  { mode: 'healthy', label: 'Put it back' },
];

const SECONDARY_BUTTON_CLASS =
  'min-h-10 rounded-lg border border-[#272727] bg-[#1F1F1F] px-3 py-2 text-xs font-semibold text-[#B4B4B4] ' +
  'outline-none transition-[background-color,color,transform] duration-[var(--dur-fast)] ease-[var(--ease-fluid)] ' +
  'hover:bg-[#272727] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-50';

type SuiteState = 'healthy' | 'wrong-shape' | 'wrong-target';

function classifyMode(mode: UseSandboxEngineResult['mode']): SuiteState {
  if (mode === 'wrong_entity') return 'wrong-target';
  if (mode === 'price_dead') return 'wrong-shape';
  return 'healthy';
}

// One row per suite state, so the three variants read as a table instead of
// eight parallel ternary chains.
const SUITE = {
  healthy: {
    color: 'var(--color-verdict-pass)',
    shape: 'PASS',
    shapeColor: 'var(--color-verdict-pass)',
    identity: 'PASS',
    identityColor: 'var(--color-verdict-pass)',
    decision: 'Release',
    consumer: 'Advance safe output',
    contractBaseline: 'PASS',
    consequence: 'healthy run → release → snapshot advanced',
    headline: 'Green status. Healthy signal',
    summary: 'Current run is healthy and can advance the safe output.',
  },
  'wrong-shape': {
    color: 'var(--color-verdict-shape)',
    shape: 'FAIL',
    shapeColor: 'var(--color-verdict-shape)',
    identity: 'PASS',
    identityColor: 'var(--color-verdict-pass)',
    decision: 'Repair available',
    consumer: 'Keep verified feed',
    contractBaseline: 'FAIL',
    consequence: 'shape drift → repair requested → snapshot preserved',
    headline: 'Green status. Shape drift, repair allowed',
    summary: 'Current run is held while a repair is prepared; verified feed keeps serving.',
  },
  'wrong-target': {
    color: 'var(--color-verdict-target)',
    shape: 'PASS',
    shapeColor: 'var(--color-verdict-pass)',
    identity: 'FAIL',
    identityColor: 'var(--color-verdict-target)',
    decision: 'Quarantine run',
    consumer: 'Keep verified feed',
    contractBaseline: 'PASS',
    consequence: 'wrong entity → quarantine → snapshot preserved',
    headline: 'Green status. Wrong product.',
    summary: 'Current run is blocked while verified feed keeps serving.',
  },
} as const satisfies Record<SuiteState, Record<string, string>>;

function formatProduct(product: { sku: string; title: string } | null) {
  return product ? `${product.sku} — ${product.title}` : 'identity not available';
}

function ProofFact({
  label,
  value,
  color,
  testId,
}: {
  label: string;
  value: string;
  color: string;
  testId: string;
}) {
  return (
    <p
      className="rounded-lg border border-[#272727] border-l-2 bg-[#1F1F1F] px-3 py-2"
      style={{ borderLeftColor: color }}
    >
      <span className="font-mono text-[#9B9B9B]">{label}</span>
      <span data-testid={testId} className="mt-1 block font-mono text-[#EDEDED]">{value}</span>
    </p>
  );
}

export function SandboxSuite({ sandbox }: { sandbox: UseSandboxEngineResult }) {
  const busy = sandbox.phase !== 'idle';
  const state = classifyMode(sandbox.mode);
  const facts = SUITE[state];
  const target = sandbox.fleet.find((collector) => collector.id === sandbox.targetId);
  const targetDef = SANDBOX_COLLECTORS.find((def) => def.id === sandbox.targetId);
  const requestedProduct = targetDef ? probedProduct(targetDef) : null;
  const receivedProductValue = targetDef ? (state === 'wrong-target' ? receivedProduct(targetDef) : probedProduct(targetDef)) : null;
  // The engine mutates its chain before the hook publishes the resolved snapshot,
  // so hold the last count during the floor or old copy and a new count mix.
  const chain = busy ? { ok: true, checked: sandbox.ledgerCount } : sandbox.verifyChain();

  function runProof() {
    if (busy || sandbox.limitReached) return;
    sandbox.trigger('wrong_entity');
  }

  function triggerFixture(mode: SandboxMode) {
    if (busy || sandbox.limitReached) return;
    sandbox.trigger(mode);
  }

  return (
    <section
      id="sandbox"
      aria-labelledby="sandbox-title"
      className="relative isolate min-h-[100svh] overflow-hidden border-y border-[#272727] bg-[#000000] px-4 py-24 sm:px-6"
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
          <h2 id="sandbox-title" className="mt-3 text-balance text-3xl font-semibold leading-tight text-[#EDEDED]">
            Break the run. Watch the proof.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-base text-[#9B9B9B] md:text-lg">
            This surface is one judge-ready dashboard: one proof row, one safe-output row, one chain row.
          </p>
        </div>

        <div className="relative mt-10 overflow-hidden rounded-3xl border border-[#272727] bg-[#000000] shadow-[var(--shadow-e3)]">
          <DotGrid
            dotSize={2}
            gap={16}
            baseColor="#272727"
            activeColor="#8B949E"
            proximity={130}
            shockRadius={180}
            shockStrength={2.4}
            className="absolute inset-0 opacity-70"
          />

          <div className="relative flex min-h-14 flex-col items-stretch gap-3 border-b border-[#272727] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-h-11 max-w-full items-center gap-3 rounded-2xl border border-[#272727] bg-[#181818] px-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#EDEDED] text-[#000000]">
                <ShieldCheck size={16} weight="regular" aria-hidden />
              </span>
              <span className="font-mono text-xs text-[#EDEDED]">Polygraph sandbox proof board</span>
            </div>
            <span
              aria-live="polite"
              className="break-words font-mono text-xs text-[#9B9B9B] sm:text-right"
              style={{ color: busy ? 'var(--color-verdict-suspect)' : facts.color }}
            >
              {busy ? 'checking' : facts.headline}
            </span>
          </div>

          <div className="relative grid grid-cols-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,0.62fr)_minmax(0,1.38fr)] lg:p-8">
            <section aria-label="Judge action rail" className="overflow-hidden rounded-2xl border border-[#272727] bg-[#181818] p-4 lg:flex lg:flex-col lg:justify-center">
              <h3 className="text-balance text-2xl font-semibold text-[#EDEDED]">{facts.headline}</h3>
              <p className="mt-2 text-pretty text-sm text-[#EDEDED]">
                {facts.summary}
              </p>
              <div className="mt-4 rounded-xl border border-[#272727] bg-[#1F1F1F] p-3 text-xs text-[#9B9B9B]">
                <p className="font-mono text-xs uppercase tracking-wide text-[#EDEDED]">Proof counterfactual</p>
                <p className="mt-2">
                  HTTP 200 · <span className="font-mono">required fields present</span> · Contract baseline: {facts.contractBaseline}
                </p>
              </div>
              <button
                type="button"
                onClick={runProof}
                disabled={busy || sandbox.limitReached}
                data-testid="run-proof-button"
                aria-label="Run the proof"
                className={`${BREAK_CLASS} mt-4`}
              >
                <MagnifyingGlass size={16} weight="regular" aria-hidden />
                {busy ? 'Running proof…' : 'Run the proof'}
                {state === 'wrong-target' ? <Check size={16} weight="regular" aria-hidden /> : null}
              </button>
              <p className="mt-2 text-xs text-[#9B9B9B]">
                <span className="font-mono tracking-wide text-[#9B9B9B]">Actions remaining</span>{' '}
                <span className="font-mono tabular-nums text-[#EDEDED]">{sandbox.actionsRemaining}</span>
              </p>

              <details className="mt-4 border-t border-[#272727] pt-3">
                <summary className="flex min-h-10 cursor-pointer items-center text-xs font-semibold text-[#9B9B9B] outline-none hover:text-[#EDEDED] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]">
                  Try the other sandbox fixtures
                </summary>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {SECONDARY_ACTIONS.map((action) => (
                    <button
                      key={action.mode}
                      type="button"
                      onClick={() => triggerFixture(action.mode)}
                      disabled={busy || sandbox.limitReached}
                      data-testid={`sandbox-break-${action.mode}`}
                      className={SECONDARY_BUTTON_CLASS}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </details>
            </section>

            <section aria-label="Target proof dashboard" className="overflow-hidden rounded-2xl border border-[#272727] bg-[#181818] p-4">
              <div className="grid gap-3">
                <div className="rounded-xl border border-[#272727] bg-[#1F1F1F] p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#9B9B9B]">Current run compare</p>
                  <div className="mt-2 grid grid-cols-1 gap-3 text-xs text-[#9B9B9B] sm:grid-cols-2">
                    <div>
                      <p className="font-mono text-[#EDEDED]">Current store-pricing run</p>
                      <p className="mt-1" data-testid="proof-requested-identity">
                        requested:{' '}
                        <span className="font-mono text-[#EDEDED]">{formatProduct(requestedProduct)}</span>
                      </p>
                      <p data-testid="proof-received-identity">
                        received:{' '}
                        <span className="font-mono text-[#EDEDED]">{formatProduct(receivedProductValue)}</span>
                      </p>
                      <p className="mt-1" data-testid="proof-fill">
                        FILL <span className="font-mono text-[#EDEDED]">100%</span> /{' '}
                        <span className="font-mono tabular-nums text-[#EDEDED]">{SANDBOX_ROWS} rows</span>
                      </p>
                      {state === 'wrong-target' && (
                        <p data-testid="proof-repair-slot" className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[#272727] px-3 font-mono text-[#EDEDED]">
                          <Prohibit size={16} weight="regular" className="text-[var(--color-verdict-target)]" aria-hidden />
                          <span className="line-through decoration-[var(--color-verdict-target)]">Repair</span>
                          <span>{' '}refused</span>
                        </p>
                      )}
                    </div>
                    <SafeOutputPanel
                      snapshot={sandbox.safeOutput}
                      mode={sandbox.mode}
                      target={target}
                      className="mt-0 bg-[#1F1F1F]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-5" aria-label="Run proof facts">
                  <ProofFact label="HTTP status" value="HTTP 200" color="#8B949E" testId="proof-fact-http" />
                  <ProofFact
                    label="Shape"
                    value={facts.shape}
                    color={facts.shapeColor}
                    testId="proof-fact-shape"
                  />
                  <ProofFact
                    label="Identity"
                    value={facts.identity}
                    color={facts.identityColor}
                    testId="proof-fact-identity"
                  />
                  <ProofFact label="Decision" value={facts.decision} color={facts.color} testId="proof-fact-decision" />
                  <ProofFact
                    label="Consumer"
                    value={facts.consumer}
                    color="var(--color-verdict-pass)"
                    testId="proof-fact-consumer"
                  />
                </div>

                <dl className="grid grid-cols-1 gap-2 rounded-xl border border-[#272727] border-l-2 border-l-[var(--color-verdict-target)] bg-[var(--color-archive)] px-3 py-2 text-xs text-[#9B9B9B] sm:grid-cols-[auto_1fr]">
                  <dt className="font-semibold text-[#EDEDED]">Recorded production effect</dt>
                  <dd>
                    <span data-testid="proof-production-receipt" className="font-mono text-[#EDEDED]">
                      heal reported done · production schema unchanged · recovery blocked
                    </span>
                    <span className="mt-1 block text-[#9B9B9B]">Live evidence from 2026-08-20 — separate from this browser fixture.</span>
                  </dd>
                  <dt className="font-semibold text-[#EDEDED]">Ledger</dt>
                  <dd data-testid="proof-ledger-consequence" className="font-mono text-[#EDEDED]">
                    {facts.consequence}
                  </dd>
                  <dt className="font-semibold text-[#EDEDED]">Chain</dt>
                  <dd data-testid="proof-chain-state" className="font-mono tabular-nums text-[#EDEDED]">
                    {chain.ok ? `Chain intact · ${chain.checked} events` : `Chain failed · ${chain.reason ?? 'unknown'}`}
                  </dd>
                </dl>
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
