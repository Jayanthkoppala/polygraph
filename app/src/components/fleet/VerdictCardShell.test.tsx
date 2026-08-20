/**
 * VerdictCardShell tests — R10 / §3.4: the border-ring illumination trick
 * must never regress into an interior background wash (the exact defect
 * that got magic-card vetoed in the first place).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { VerdictCardShell } from './VerdictCardShell';

afterEach(() => cleanup());

describe('VerdictCardShell — border-ring illumination only, no interior gradient (R10, §1.2, §3.4)', () => {
  it('the accent gradient paints the border-box layer, never the fill', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-target)">
        <span>content</span>
      </VerdictCardShell>,
    );
    const shell = getByTestId('verdict-card-shell');
    const bg = shell.style.background;
    expect(bg).toContain('border-box');
    expect(bg).toContain('padding-box');
    // The padding-box (fill) layer is a flat, literal colour — not a
    // gradient, not the accent.
    expect(bg).toMatch(/linear-gradient\(#1F1F1F 0 0\) padding-box/);
  });

  it('a separate flat fill layer sits on top of the gradient, clipping it out of the visible interior', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-pass)">
        <span>content</span>
      </VerdictCardShell>,
    );
    const fill = getByTestId('verdict-card-shell-fill');
    expect(fill).toHaveClass('bg-[#1F1F1F]');
    // The fill must never itself carry a gradient class.
    expect(fill.className).not.toMatch(/gradient/);
  });

  it('children render inside the shell', () => {
    const { getByText } = render(
      <VerdictCardShell accent="var(--color-verdict-shape)">
        <span>card contents</span>
      </VerdictCardShell>,
    );
    expect(getByText('card contents')).toBeInTheDocument();
  });

  it('keyboard focus on an inner control rings the whole shell (§6.3 focus-within)', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-suspect)">
        <button type="button">act</button>
      </VerdictCardShell>,
    );
    const shell = getByTestId('verdict-card-shell');
    expect(shell.className).toContain('focus-within:outline');
    expect(shell.className).toContain('focus-within:outline-2');
  });
});
