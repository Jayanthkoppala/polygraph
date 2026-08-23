import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrightDataClient, RefactorProgress } from '../../../src/brightdata/client.js';
import { healOwnedFixture, mintOwnedFixtureHealPermit, PolygraphHealDisabled } from '../../../src/brightdata/heal.js';

const collectorId = 'c_owned_fixture';
const fixtureUrl = 'https://fixture.example/';
const policy = { max_attempts_per_incident: 1, cooldown_minutes: 0, daily_heal_budget: 1, heal_enabled: true };
const previewContract = { productCode: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };
const preview = { product_code: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };
const substantiveSteps = ['planner', 'code_fixer', 'step_preview_runner', 'request_fulfillment_validator', 'user_approval'];
const oldFence: RefactorProgress = { status: 'done', id: 'heal-old', completed_steps: ['user_approval'] };
const keys = ['POLYGRAPH_HEAL_ENABLED', 'POLYGRAPH_DEMO_LIVE', 'POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE', 'POLYGRAPH_DEMO_COLLECTOR_ID', 'POLYGRAPH_DEMO_FIXTURE_URL'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
type OwnedClient = Pick<BrightDataClient, 'refactorTemplate' | 'refactorTemplateProgress' | 'pollRefactorTemplateProgress' | 'resumeAutomationJob'>;

function sequence<T>(values: T[]): () => Promise<T> {
  let index = 0;
  return async () => {
    if (index >= values.length) throw new Error(`unexpected sequence call ${index + 1}`);
    return values[index++];
  };
}

function clientWith(options: {
  fences?: RefactorProgress[];
  accepted?: unknown[];
  polls?: RefactorProgress[];
  resumeError?: Error;
} = {}): OwnedClient {
  return {
    refactorTemplateProgress: vi.fn(sequence(options.fences ?? [oldFence])) as OwnedClient['refactorTemplateProgress'],
    refactorTemplate: vi.fn(sequence(options.accepted ?? [{ id: 'heal-1' }])) as OwnedClient['refactorTemplate'],
    pollRefactorTemplateProgress: vi.fn(sequence(options.polls ?? [])) as OwnedClient['pollRefactorTemplateProgress'],
    resumeAutomationJob: vi.fn(async () => {
      if (options.resumeError) throw options.resumeError;
    }),
  };
}

function gate(id: string, row = preview, success: boolean | undefined = true, steps = substantiveSteps): RefactorProgress {
  return {
    status: 'pending_answer',
    id,
    ...(success === undefined ? {} : { success }),
    completed_steps: steps,
    preview_result: [row],
  };
}

function gateWithoutSuccess(id: string): RefactorProgress {
  const { success: _success, ...progress } = gate(id);
  return progress;
}

function terminal(id: string, savedTemplate = false): RefactorProgress {
  return { status: 'done', id, completed_steps: savedTemplate ? ['user_approval', 'save_new_template'] : ['user_approval'] };
}

beforeEach(() => {
  process.env.POLYGRAPH_HEAL_ENABLED = '1';
  process.env.POLYGRAPH_DEMO_LIVE = '1';
  process.env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE = '1';
  process.env.POLYGRAPH_DEMO_COLLECTOR_ID = collectorId;
  process.env.POLYGRAPH_DEMO_FIXTURE_URL = fixtureUrl;
});

afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('owned fixture heal permit', () => {
  it('cannot be minted for a customer collector or when the dedicated auto-save gate is closed', () => {
    expect(() => mintOwnedFixtureHealPermit('c_customer', fixtureUrl, policy)).toThrow(PolygraphHealDisabled);
    delete process.env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE;
    expect(() => mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy)).toThrow(PolygraphHealDisabled);
  });

  it('refuses to trigger while the prior provider operation is not terminal', async () => {
    const client = clientWith({ fences: [{ status: 'pending_answer', id: 'heal-old', step: 'user_approval' }] });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract })).rejects.toThrow(/prior job heal-old is not terminal/i);
    expect(client.refactorTemplate).not.toHaveBeenCalled();
    expect(client.resumeAutomationJob).not.toHaveBeenCalled();
  });

  it('acquires a fresh id after an accepted envelope omits it, then binds approval to that id', async () => {
    const client = clientWith({
      accepted: [{ queued: true }],
      polls: [
        { status: 'running', id: 'heal-1' },
        gate('heal-1'),
        terminal('heal-1', true),
      ],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const result = await healOwnedFixture('price moved', { client, policy, permit, previewContract });

    expect(result).toMatchObject({ status: 'done', id: 'heal-1' });
    expect(client.pollRefactorTemplateProgress).toHaveBeenNthCalledWith(
      1,
      collectorId,
      expect.any(Object),
      expect.objectContaining({ returnOnFreshJobId: true, staleJobIds: ['heal-old'] }),
    );
    expect(client.pollRefactorTemplateProgress).toHaveBeenNthCalledWith(
      2,
      collectorId,
      expect.any(Object),
      expect.objectContaining({ expectedJobId: 'heal-1', staleJobIds: ['heal-old'] }),
    );
  });

  it('allows a truly empty pre-trigger progress envelope when no prior operation exists', async () => {
    const client = clientWith({
      fences: [{} as RefactorProgress],
      polls: [gate('heal-1'), terminal('heal-1', true)],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract })).resolves.toMatchObject({ id: 'heal-1' });
    expect(client.refactorTemplate).toHaveBeenCalledWith(collectorId, 'price moved', []);
  });

  it('uses official empty custom_input, auto-saves once, and returns only after promotion evidence', async () => {
    const client = clientWith({ polls: [gate('heal-1'), terminal('heal-1', true)] });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const result = await healOwnedFixture('price moved', { client, policy, permit, previewContract });

    expect(result).toMatchObject({ status: 'done', id: 'heal-1' });
    expect(client.refactorTemplate).toHaveBeenCalledOnce();
    expect(client.refactorTemplate).toHaveBeenCalledWith(collectorId, 'price moved', []);
    expect(client.resumeAutomationJob).toHaveBeenCalledOnce();
    expect(client.resumeAutomationJob).toHaveBeenCalledWith(collectorId, { message: true, autoSave: true });
  });

  it.each(['done', 'ready'])('never resumes a terminal %s envelope that preserves a stale user_approval step', async (status) => {
    const client = clientWith({
      polls: [{ ...gate('heal-1'), status, step: 'user_approval' }],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract })).rejects.toThrow(new RegExp(`did not stop at the required approval gate.*${status}`, 'i'));
    expect(client.resumeAutomationJob).not.toHaveBeenCalled();
  });

  it('rejects candidate one, confirms same-id terminal no-save, then retries once with prompt feedback and empty input', async () => {
    const rejected = gate('heal-1', { ...preview, product_code: '' });
    const onCandidateRejected = vi.fn();
    const client = clientWith({
      fences: [oldFence, terminal('heal-1')],
      accepted: [{ id: 'heal-1' }, { id: 'heal-2' }],
      polls: [rejected, terminal('heal-1'), gate('heal-2'), terminal('heal-2', true)],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const result = await healOwnedFixture('product_code is blank; change parser code', {
      client,
      policy,
      permit,
      previewContract,
      onCandidateRejected,
    });

    expect(result).toMatchObject({ status: 'done', id: 'heal-2' });
    expect(client.refactorTemplate).toHaveBeenNthCalledWith(1, collectorId, 'product_code is blank; change parser code', []);
    expect(client.refactorTemplate).toHaveBeenNthCalledWith(
      2,
      collectorId,
      expect.stringMatching(/previous candidate heal-1 was rejected.*modify the parser code/i),
      [],
    );
    expect(client.resumeAutomationJob).toHaveBeenNthCalledWith(1, collectorId, { message: false, autoSave: false });
    expect(client.resumeAutomationJob).toHaveBeenNthCalledWith(2, collectorId, { message: true, autoSave: true });
    expect(onCandidateRejected).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, id: 'heal-1', reason: expect.stringMatching(/product_code/i) }));
  });

  it('keeps retry feedback within the provider prompt limit even for an oversized operation id', async () => {
    const oversizedId = `heal-${'z'.repeat(2_000)}`;
    const client = clientWith({
      fences: [oldFence, terminal(oversizedId)],
      accepted: [{ id: oversizedId }, { id: 'heal-2' }],
      polls: [gate(oversizedId, { ...preview, product_code: '' }), terminal(oversizedId), gate('heal-2'), terminal('heal-2', true)],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    await healOwnedFixture('x'.repeat(2_000), { client, policy, permit, previewContract });

    const retry = vi.mocked(client.refactorTemplate).mock.calls[1]?.[1] ?? '';
    expect(retry.length).toBeLessThanOrEqual(1000);
    expect(retry).toMatch(/previous candidate heal-/i);
    expect(client.refactorTemplate).toHaveBeenNthCalledWith(2, collectorId, expect.any(String), []);
  });

  it.each([
    ['success false', gate('heal-1', preview, false), gate('heal-2', preview, false), /explicit success:true/i],
    ['missing success', gateWithoutSuccess('heal-1'), gateWithoutSuccess('heal-2'), /explicit success:true/i],
    ['invalid preview', gate('heal-1', { ...preview, product_code: 'WRONG' }), gate('heal-2', { ...preview, product_code: 'WRONG' }), /product_code/i],
    ['no substantive repair steps', gate('heal-1', preview, true, ['planner', 'user_approval']), gate('heal-2', preview, true, ['planner', 'user_approval']), /substantive repair steps/i],
  ])('rejects both bounded candidates with zero approvals for %s', async (_label, firstGate, secondGate, message) => {
    const client = clientWith({
      fences: [oldFence, terminal('heal-1')],
      accepted: [{ id: 'heal-1' }, { id: 'heal-2' }],
      polls: [firstGate, terminal('heal-1'), secondGate, terminal('heal-2')],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract })).rejects.toThrow(message);
    expect(client.refactorTemplate).toHaveBeenCalledTimes(2);
    expect(client.resumeAutomationJob).toHaveBeenCalledTimes(2);
    expect(client.resumeAutomationJob).not.toHaveBeenCalledWith(collectorId, { message: true, autoSave: true });
  });

  it('aborts without retry when a rejected candidate terminal envelope reports a save', async () => {
    const client = clientWith({ polls: [gate('heal-1', { ...preview, product_code: '' }), terminal('heal-1', true)] });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('product_code is blank', { client, policy, permit, previewContract })).rejects.toThrow(/rejection unexpectedly reported save_new_template/i);
    expect(client.refactorTemplate).toHaveBeenCalledOnce();
    expect(client.resumeAutomationJob).toHaveBeenCalledOnce();
  });

  it('fails closed when retry acquisition cannot produce a unique fresh id', async () => {
    const client = clientWith({
      fences: [oldFence, terminal('heal-1')],
      accepted: [{ id: 'heal-1' }, { id: 'heal-1' }],
      polls: [gate('heal-1', { ...preview, product_code: '' }), terminal('heal-1'), terminal('heal-1')],
    });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('product_code is blank', { client, policy, permit, previewContract })).rejects.toThrow(/stale or duplicate job id/i);
    expect(client.resumeAutomationJob).toHaveBeenCalledTimes(1);
  });

  it('does not retry when rejecting the first candidate is ambiguous', async () => {
    const client = clientWith({ polls: [gate('heal-1', { ...preview, product_code: '' })], resumeError: new Error('reject transport ambiguous') });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('product_code is blank', { client, policy, permit, previewContract })).rejects.toThrow(/reject transport ambiguous/i);
    expect(client.refactorTemplate).toHaveBeenCalledOnce();
  });

  it.each([
    ['trigger', 'trigger failed'],
    ['gate poll', 'gate poll failed'],
    ['rejection terminal poll', 'rejection terminal failed'],
    ['approval', 'approval failed'],
    ['approval terminal poll', 'approval terminal failed'],
  ])('does not start a second candidate after a %s ambiguity', async (phase, message) => {
    const client = clientWith();
    if (phase === 'trigger') {
      client.refactorTemplate = vi.fn(async () => { throw new Error(message); }) as OwnedClient['refactorTemplate'];
    } else if (phase === 'gate poll') {
      client.pollRefactorTemplateProgress = vi.fn(async () => { throw new Error(message); }) as OwnedClient['pollRefactorTemplateProgress'];
    } else if (phase === 'rejection terminal poll') {
      client.pollRefactorTemplateProgress = vi.fn()
        .mockResolvedValueOnce(gate('heal-1', { ...preview, product_code: '' }))
        .mockRejectedValueOnce(new Error(message)) as OwnedClient['pollRefactorTemplateProgress'];
    } else if (phase === 'approval') {
      client.pollRefactorTemplateProgress = vi.fn(async () => gate('heal-1')) as OwnedClient['pollRefactorTemplateProgress'];
      client.resumeAutomationJob = vi.fn(async () => { throw new Error(message); });
    } else {
      client.pollRefactorTemplateProgress = vi.fn()
        .mockResolvedValueOnce(gate('heal-1'))
        .mockRejectedValueOnce(new Error(message)) as OwnedClient['pollRefactorTemplateProgress'];
    }
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract })).rejects.toThrow(message);
    expect(client.refactorTemplate).toHaveBeenCalledOnce();
  });

  it('requires save_new_template evidence after approving an exact candidate', async () => {
    const client = clientWith({ polls: [gate('heal-1'), terminal('heal-1')] });
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract })).rejects.toThrow(/save_new_template/i);
    expect(client.resumeAutomationJob).toHaveBeenCalledWith(collectorId, { message: true, autoSave: true });
    expect(client.refactorTemplate).toHaveBeenCalledOnce();
  });
});
