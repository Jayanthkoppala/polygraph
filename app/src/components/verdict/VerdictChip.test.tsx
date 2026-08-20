/**
 * VerdictChip tests — the glyph + label set (§2.4, §2.7). The label is
 * always rendered and never truncated (§6.2); the refusal badge only shows
 * at row density, per §2.8 "Where the slot appears".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VerdictChip } from './VerdictChip';
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
