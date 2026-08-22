// R10 / §3.4: the border-ring illumination must never regress into an interior background
// wash — the exact defect that got magic-card vetoed in the first place.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VerdictCardShell } from '@/components/fleet/VerdictCardShell';

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
    // The padding-box (fill) layer is a flat literal colour — not a gradient, not the accent.
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

// Regression, critique.md "Beautiful but wrong": §3.4's pointer-driven `radial-gradient(240px
// circle at ...)` left every shell grey at rest, but §2.5 says the border carries state.
describe('VerdictCardShell — the ring is flat and always on (critique.md "Beautiful but wrong")', () => {
  it('paints the accent at rest, with no pointer interaction of any kind', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-target)">
        <span>content</span>
      </VerdictCardShell>,
    );
    const shell = getByTestId('verdict-card-shell');
    expect(shell.style.background).toContain('var(--color-verdict-target) 0 0) border-box');
  });

  it('the ring layer is not a radial gradient and does not track a position', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-shape)">
        <span>content</span>
      </VerdictCardShell>,
    );
    const bg = getByTestId('verdict-card-shell').style.background;
    expect(bg).not.toContain('radial-gradient');
    expect(bg).not.toContain('circle at');
    expect(bg).not.toContain('px');
  });

  it('moving the pointer across the shell changes nothing', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-target)">
        <span>content</span>
      </VerdictCardShell>,
    );
    const shell = getByTestId('verdict-card-shell');
    const before = shell.style.background;
    fireEvent.pointerMove(shell, { clientX: 40, clientY: 20 });
    fireEvent.pointerMove(shell, { clientX: 200, clientY: 90 });
    expect(shell.style.background).toBe(before);
  });

  it('hover still responds — but with elevation, which is what §1.8 prescribes', () => {
    const { getByTestId } = render(
      <VerdictCardShell accent="var(--color-verdict-pass)">
        <span>content</span>
      </VerdictCardShell>,
    );
    expect(getByTestId('verdict-card-shell').className).toContain('hover:shadow-[var(--shadow-e2)]');
  });
});
