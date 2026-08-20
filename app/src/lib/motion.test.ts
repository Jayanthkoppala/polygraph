/**
 * The refusal choreography's timing, asserted as data.
 *
 * ui-system.md §2.8 calls beat 4 "the single most important 300ms in the
 * product", and §2.6 explains that its 520ms head start is not polish but
 * argument: "Beat four is late on purpose. You read 'the target is wrong',
 * and only then 'and we will not repair it'. Firing them together makes the
 * refusal look like a system limitation." The critique that produced this
 * work found the slot firing ~40ms after the key swap — visually a much
 * snappier animation, and the wrong claim. Numbers that carry an argument
 * need a test, or the next person tightening the animation deletes the
 * argument without noticing.
 */
import { describe, expect, it } from 'vitest';
import { REFUSAL_BEAT } from './motion';

/** Spec times are written in ms; the constants are in motion/react seconds. */
const ms = (seconds: number) => Math.round(seconds * 1000);

describe('REFUSAL_BEAT — verbatim from ui-system.md §2.8 "The motion, which is the point"', () => {
  it('beat 4a: the button de-elevates 520 -> 700ms', () => {
    expect(ms(REFUSAL_BEAT.deElevate.start)).toBe(520);
    expect(ms(REFUSAL_BEAT.deElevate.duration)).toBe(180);
  });

  it('beat 4b: the strikethrough draws 560 -> 740ms', () => {
    expect(ms(REFUSAL_BEAT.strike.start)).toBe(560);
    expect(ms(REFUSAL_BEAT.strike.duration)).toBe(180);
  });

  it('beat 4c: " refused" fades in 700 -> 820ms', () => {
    expect(ms(REFUSAL_BEAT.refused.start)).toBe(700);
    expect(ms(REFUSAL_BEAT.refused.duration)).toBe(120);
  });
});

describe('REFUSAL_BEAT — the ordering law, independent of the exact numbers', () => {
  it('the whole withdrawal starts no earlier than 520ms, after beats 1-3 have said "wrong target"', () => {
    const earliest = Math.min(
      REFUSAL_BEAT.deElevate.start,
      REFUSAL_BEAT.strike.start,
      REFUSAL_BEAT.refused.start,
    );
    expect(ms(earliest)).toBeGreaterThanOrEqual(520);
  });

  it('de-elevation leads: the button sinks before it is crossed out, never the reverse', () => {
    expect(REFUSAL_BEAT.deElevate.start).toBeLessThan(REFUSAL_BEAT.strike.start);
  });

  it('the strike starts while the de-elevation is still running — one gesture, not three events', () => {
    const deElevateEnd = REFUSAL_BEAT.deElevate.start + REFUSAL_BEAT.deElevate.duration;
    expect(REFUSAL_BEAT.strike.start).toBeLessThan(deElevateEnd);
  });

  it('" refused" waits for the strike to land — §2.8: "fades in after the strike lands"', () => {
    const strikeMostlyDrawn = REFUSAL_BEAT.strike.start + REFUSAL_BEAT.strike.duration * 0.5;
    expect(REFUSAL_BEAT.refused.start).toBeGreaterThanOrEqual(strikeMostlyDrawn);
  });

  it('the whole withdrawal fits inside §2.6’s 600ms + tail budget: nothing runs past 820ms', () => {
    const end = Math.max(
      ...Object.values(REFUSAL_BEAT).map((beat) => beat.start + beat.duration),
    );
    expect(ms(end)).toBe(820);
  });
});
