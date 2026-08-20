/**
 * EvidencePanel — the direct fix for "there is no reason on screen"
 * (ux-spec.md §5). Every check always renders including passes; raw metric
 * disclosure is collapsed by default; the refusal panel only appears for
 * WRONG_TARGET; the heal command is copyable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { EvidencePanel } from './EvidencePanel';
import type { CollectorState } from '@/lib/api';

afterEach(() => cleanup());

function baseCollector(overrides: Partial<CollectorState> = {}): CollectorState {
  return {
    id: 'shopify-skus',
    name: 'shopify-skus',
    verdict: 'PASS',
    cause: null,
    action: 'RELEASE',
    rows: 1204,
    fillPct: 100,
    fillRates: null,
    lastTs: '2026-08-20T14:02:11.000Z',
    ledgerId: 1283,
    needsAck: false,
    acked: false,
    healAttemptsToday: 0,
    unverified: false,
    pureAction: 'RELEASE',
    actionReason: null,
    suggestedHealCommand: null,
    evidence: null,
    ...overrides,
  };
}

describe('EvidencePanel — empty state', () => {
  it('renders a composed empty state, never a blank region', () => {
    render(<EvidencePanel collector={null} />);
    expect(screen.getByTestId('evidence-panel-empty')).toBeInTheDocument();
  });
});

describe('EvidencePanel — all four checks always render, including passes (ux-spec.md §5)', () => {
  it('renders contract, coherence, identity, and canary rows even when nothing failed', () => {
    const collector = baseCollector({
      evidence: [
        { check: 'contract', ok: true, detail: 'x', metrics: { fillRates: { sku: 1, title: 1 }, requiredViolationRate: 0, errorRowRate: 0 } },
        { check: 'coherence', ok: true, detail: 'x', metrics: { collapsedFields: [], zeroRows: false } },
        { check: 'identity', ok: true, detail: 'x', metrics: { compared: 1204, mismatched: 0, mismatches: [] } },
      ],
    });
    render(<EvidencePanel collector={collector} />);
    expect(screen.getByTestId('evidence-row-contract')).toHaveAttribute('data-status', 'pass');
    expect(screen.getByTestId('evidence-row-coherence')).toHaveAttribute('data-status', 'pass');
    expect(screen.getByTestId('evidence-row-identity')).toHaveAttribute('data-status', 'pass');
    // Canary never ran (cause null) — still renders, marked skipped, never a silent omission.
    expect(screen.getByTestId('evidence-row-canary')).toHaveAttribute('data-status', 'skipped');
  });

  it('a failed run still shows the passing checks alongside the failure — the passes make it credible', () => {
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [
        { check: 'contract', ok: true, detail: 'x', metrics: { fillRates: { sku: 1 }, requiredViolationRate: 0, errorRowRate: 0 } },
        { check: 'coherence', ok: true, detail: 'x', metrics: { collapsedFields: [], zeroRows: false } },
        {
          check: 'identity',
          ok: false,
          detail: 'x',
          metrics: { compared: 1204, mismatched: 43, mismatches: [{ input: 'a', requestedKey: 'SKU-4471', extractedKey: 'SKU-9012' }] },
        },
      ],
    });
    render(<EvidencePanel collector={collector} />);
    expect(screen.getByTestId('evidence-row-contract')).toHaveAttribute('data-status', 'pass');
    expect(screen.getByTestId('evidence-row-identity')).toHaveAttribute('data-status', 'fail');
    expect(within(screen.getByTestId('evidence-row-identity')).getByText(/We asked for SKU-4471/)).toBeInTheDocument();
  });
});

describe('EvidencePanel — comparison sentences on screen, raw metric names hidden by default', () => {
  it('shows the comparison sentence directly, and reveals raw JSON only after clicking "raw"', () => {
    const collector = baseCollector({
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      evidence: [
        {
          check: 'contract',
          ok: false,
          detail: 'requiredViolationRate=1.000',
          metrics: { fillRates: { price: 0, sku: 1, title: 1, stock: 1 }, requiredViolationRate: 1, errorRowRate: 0 },
        },
      ],
    });
    render(<EvidencePanel collector={collector} />);
    const row = screen.getByTestId('evidence-row-contract');
    expect(within(row).getByText(/price was filled on 0% of rows/)).toBeInTheDocument();
    expect(screen.queryByTestId('evidence-raw-contract')).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: /raw/ }));
    const raw = screen.getByTestId('evidence-raw-contract');
    expect(raw).toBeInTheDocument();
    expect(raw.textContent).toContain('requiredViolationRate');
  });
});

describe('EvidencePanel — the entity-key requested/received table (WRONG_TARGET)', () => {
  it('renders the comparison table, first five mismatches', () => {
    const mismatches = Array.from({ length: 7 }, (_, i) => ({
      input: `in-${i}`,
      requestedKey: `SKU-${i}`,
      extractedKey: `SKU-9012`,
    }));
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      evidence: [{ check: 'identity', ok: false, detail: 'x', metrics: { compared: 7, mismatched: 7, mismatches } }],
    });
    render(<EvidencePanel collector={collector} />);
    const rows = screen.getAllByText(/SKU-9012/);
    expect(rows).toHaveLength(6); // 5 in the table + 1 inside the headline sentence
    expect(screen.getByText('+ 2 more')).toBeInTheDocument();
  });
});

describe('EvidencePanel — canary per-input outcomes', () => {
  it('renders one dot per canary input with its outcome in the title', () => {
    const collector = baseCollector({
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      evidence: [
        {
          check: 'canary',
          ok: false,
          detail: 'x',
          metrics: {
            outcomes: [
              { input: 'a', pass: false, reason: 'missing required field(s): price' },
              { input: 'b', pass: true },
            ],
            passCount: 1,
            failCount: 1,
          },
        },
      ],
    });
    render(<EvidencePanel collector={collector} />);
    const dots = screen.getAllByTestId('canary-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute('data-pass', 'false');
    expect(dots[0]).toHaveAttribute('title', 'a: missing required field(s): price');
    expect(dots[1]).toHaveAttribute('data-pass', 'true');
  });
});

describe('EvidencePanel — the heal command, click to copy', () => {
  it('copies the exact suggested command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const collector = baseCollector({
      verdict: 'FAILED_STRUCTURAL',
      cause: 'STRUCTURAL',
      pureAction: 'REPAIR',
      suggestedHealCommand: 'bdata scraper heal amazon-prices "re-derive the price selector"',
    });
    render(<EvidencePanel collector={collector} />);
    fireEvent.click(screen.getByRole('button', { name: /copy heal command/i }));
    expect(writeText).toHaveBeenCalledWith('bdata scraper heal amazon-prices "re-derive the price selector"');
  });

  it('does not render the section when there is no suggested command', () => {
    render(<EvidencePanel collector={baseCollector({ suggestedHealCommand: null })} />);
    expect(screen.queryByLabelText('Run it yourself')).not.toBeInTheDocument();
  });
});

describe('EvidencePanel — the refusal panel (ux-spec.md §6)', () => {
  it('renders only for WRONG_TARGET, with the plain-language reason — never the engine\'s own actionReason', () => {
    const collector = baseCollector({
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      // policy.ts's REDISCOVER `actionReason` is the STRUCTURAL diagnosis
      // ("selector likely broken") — it argues FOR repairability at the
      // exact moment the panel is refusing to repair, so the panel must
      // never surface it verbatim. Set here specifically to prove that.
      actionReason: 'entity_key mismatch on 100% of comparable rows — selector likely broken',
    });
    render(<EvidencePanel collector={collector} />);
    const panel = screen.getByTestId('refusal-panel');
    expect(panel).toHaveTextContent('Repair refused.');
    expect(panel).toHaveTextContent(
      "This collector returned well-formed data for the wrong entity. Repairing a field selector fixes a broken parser, not a request that landed on the wrong page — so Polygraph will not offer a repair it can't justify.",
    );
    expect(panel).not.toHaveTextContent('selector likely broken');
  });

  /**
   * ux-spec.md §6 mandates THREE parts, always, in order. Part 3 — the one
   * thing that can actually be done, plus the ledger citation — was missing
   * entirely (docs/design/critique.md #2).
   */
  it('renders part 3: a live re-discover action that says exactly what it does, plus the ledger citation', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const collector = baseCollector({
      id: 'shopify-skus',
      verdict: 'FAILED_IDENTITY',
      cause: 'IDENTITY',
      ledgerId: 1283,
    });
    render(<EvidencePanel collector={collector} />);
    const panel = screen.getByTestId('refusal-panel');

    // 3a — the action exists, is enabled, and carries the spec's own label.
    const action = within(panel).getByTestId('rediscover-button');
    expect(action).toBeEnabled();
    expect(action).toHaveTextContent('Re-discover the target');

    // 3b — it never implies Polygraph will re-point the collector itself,
    // and the command it hands over is visible before it is pressed.
    expect(panel).toHaveTextContent('polygraph run --collector shopify-skus');
    expect(panel).toHaveTextContent('Polygraph will not re-point a collector for you.');

    // 3c — the ledger citation, from the collector's real ledger id.
    expect(screen.getByTestId('refusal-ledger-ref')).toHaveTextContent('Ledger #1283 records this refusal.');

    // The action is live, not decorative.
    fireEvent.click(action);
    expect(writeText).toHaveBeenCalledWith('polygraph run --collector shopify-skus');

    vi.unstubAllGlobals();
  });

  it('never invents a ledger number when the collector has no ledger record yet', () => {
    const collector = baseCollector({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY', ledgerId: null });
    render(<EvidencePanel collector={collector} />);
    const ref = screen.getByTestId('refusal-ledger-ref');
    expect(ref).toHaveTextContent('Not on the ledger yet');
    expect(ref).not.toHaveTextContent('#');
  });

  it('offers no "force repair anyway" escape hatch — re-discover is the only control on the panel', () => {
    const collector = baseCollector({ verdict: 'FAILED_IDENTITY', cause: 'IDENTITY' });
    render(<EvidencePanel collector={collector} />);
    const buttons = within(screen.getByTestId('refusal-panel')).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-testid', 'rediscover-button');
  });

  it('does not render for a WRONG_SHAPE (repairable) collector', () => {
    const collector = baseCollector({ verdict: 'FAILED_STRUCTURAL', cause: 'STRUCTURAL' });
    render(<EvidencePanel collector={collector} />);
    expect(screen.queryByTestId('refusal-panel')).not.toBeInTheDocument();
  });
});
