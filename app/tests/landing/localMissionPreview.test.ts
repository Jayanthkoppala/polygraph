import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMission, getLocalMission, resetLocalMission, shiftLocalMission } from '@/landing/localMissionPreview';

afterEach(() => vi.useRealTimers());

describe('local mission preview', () => {
  it('replays the full V1 to V2 recovery story without a provider request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));

    expect((await createLocalMission()).scene).toBe('v1_baseline');
    expect((await shiftLocalMission()).scene).toBe('deploy_wait');

    vi.advanceTimersByTime(4_300);
    const broken = await getLocalMission();
    expect(broken.scene).toBe('broken_v2');
    expect(broken.evidence.changedFields).toEqual(['product_code', 'title', 'price']);
    expect(broken.evidence.brokenResult).toMatchObject({ productCode: null, title: null, availability: 'In stock' });

    vi.advanceTimersByTime(4_000);
    expect((await getLocalMission()).scene).toBe('self_healing');

    vi.advanceTimersByTime(4_800);
    const receipt = await getLocalMission();
    expect(receipt).toMatchObject({ scene: 'receipt', status: 'healed' });
    expect(receipt.events.at(-1)?.step).toBe('receipt');
    expect(receipt.evidence.proofResult).toEqual(receipt.evidence.baselineResult);

    expect((await resetLocalMission()).scene).toBe('v1_baseline');
  });
});
