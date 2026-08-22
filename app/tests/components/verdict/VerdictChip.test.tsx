// The glyph + label set (§2.4, §2.7): the label always renders and is never truncated (§6.2);
// the refusal badge shows only at row density, per §2.8 "Where the slot appears".
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VerdictChip } from '@/components/verdict/VerdictChip';
import { VERDICT, type VerdictState } from '@/lib/verdict';

afterEach(() => cleanup());

const ALL_STATES: VerdictState[] = [
  'VERIFIED',
  'UNEXPLAINED',
  'WRONG_SHAPE',
  'WRONG_TARGET',
  'NOT_CHECKED',
];

describe('VerdictChip — R1 display labels, always rendered', () => {
  it.each(ALL_STATES)('%s shows its R1 display label', (state) => {
    render(<VerdictChip state={state} />);
    expect(screen.getByText(VERDICT[state].label)).toBeInTheDocument();
  });
});

describe('VerdictChip — refusal badge only at row density (§2.8)', () => {
  it('WRONG_TARGET with showRefusal=false renders no "Repair refused" badge', () => {
    render(<VerdictChip state="WRONG_TARGET" showRefusal={false} />);
    expect(screen.queryByTestId('verdict-chip-refusal-badge')).toBeNull();
  });

  it('WRONG_TARGET with showRefusal=true renders the "Repair refused" badge', () => {
    render(<VerdictChip state="WRONG_TARGET" showRefusal />);
    expect(screen.getByTestId('verdict-chip-refusal-badge')).toBeInTheDocument();
    expect(screen.getByText('Repair refused')).toBeInTheDocument();
  });

  it('no other state ever shows the refusal badge, even with showRefusal=true', () => {
    for (const state of ALL_STATES.filter((s) => s !== 'WRONG_TARGET')) {
      const { queryByTestId, unmount } = render(<VerdictChip state={state} showRefusal />);
      expect(queryByTestId('verdict-chip-refusal-badge')).toBeNull();
      unmount();
    }
  });
});

// The badge follows the RUN: at row density the slot is dropped, so it is the only surface left
// that can carry a refusal. §2.8: "the refusal is never invisible at any density."
describe('VerdictChip — the refusal badge follows the run, not the label', () => {
  it('WRONG_SHAPE with refused=true shows the badge', () => {
    render(<VerdictChip state="WRONG_SHAPE" showRefusal refused />);
    expect(screen.getByTestId('verdict-chip-refusal-badge')).toBeInTheDocument();
    expect(screen.getByText('Repair refused')).toBeInTheDocument();
  });

  it('WRONG_SHAPE with refused=false shows no badge — a repairable run keeps its repair', () => {
    render(<VerdictChip state="WRONG_SHAPE" showRefusal refused={false} />);
    expect(screen.queryByTestId('verdict-chip-refusal-badge')).toBeNull();
  });

  it('refused=false cannot suppress the badge for WRONG_TARGET... it is simply never passed one', () => {
    // VerdictCard derives `refused` from repairRefusal(), which refuses every WRONG_TARGET run.
    // The prop overrides the WRONG_SHAPE split — not a licence to un-refuse an identity failure.
    render(<VerdictChip state="WRONG_TARGET" showRefusal />);
    expect(screen.getByTestId('verdict-chip-refusal-badge')).toBeInTheDocument();
  });

  it('the badge still needs row density — refused=true alone never renders it', () => {
    render(<VerdictChip state="WRONG_SHAPE" refused />);
    expect(screen.queryByTestId('verdict-chip-refusal-badge')).toBeNull();
  });

  it('the badge takes the state hue, so a blocked card does not turn magenta (§2.5)', () => {
    render(<VerdictChip state="WRONG_SHAPE" showRefusal refused />);
    const badge = screen.getByTestId('verdict-chip-refusal-badge');
    expect(badge.getAttribute('style')).toContain('var(--color-verdict-shape)');
    expect(badge.getAttribute('style')).not.toContain('var(--color-verdict-target)');
  });
});
