import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrightDataClient } from '../../../src/brightdata/client.js';
import { healOwnedFixture, mintOwnedFixtureHealPermit, PolygraphHealDisabled } from '../../../src/brightdata/heal.js';

const collectorId = 'c_owned_fixture';
const fixtureUrl = 'https://fixture.example/';
const policy = { max_attempts_per_incident: 1, cooldown_minutes: 0, daily_heal_budget: 1, heal_enabled: true };
const keys = ['POLYGRAPH_HEAL_ENABLED', 'POLYGRAPH_DEMO_LIVE', 'POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE', 'POLYGRAPH_DEMO_COLLECTOR_ID', 'POLYGRAPH_DEMO_FIXTURE_URL'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.POLYGRAPH_HEAL_ENABLED = '1';
  process.env.POLYGRAPH_DEMO_LIVE = '1';
  process.env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE = '1';
  process.env.POLYGRAPH_DEMO_COLLECTOR_ID = collectorId;
  process.env.POLYGRAPH_DEMO_FIXTURE_URL = fixtureUrl;
});

afterEach(() => {
  for (const key of keys) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe('owned fixture heal permit', () => {
  it('cannot be minted for a customer collector or when the dedicated auto-save gate is closed', () => {
    expect(() => mintOwnedFixtureHealPermit('c_customer', fixtureUrl, policy)).toThrow(PolygraphHealDisabled);
    delete process.env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE;
    expect(() => mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy)).toThrow(PolygraphHealDisabled);
  });

  it('requires the Bright Data approval stop, auto-saves once, and returns only after completion', async () => {
    const calls: unknown[][] = [];
    let polls = 0;
    const client: Pick<BrightDataClient, 'refactorTemplate' | 'pollRefactorTemplateProgress' | 'resumeAutomationJob'> = {
      refactorTemplate: vi.fn(async (...args: unknown[]) => { calls.push(args); return {}; }) as BrightDataClient['refactorTemplate'],
      pollRefactorTemplateProgress: vi.fn(async () => (++polls === 1
        ? { status: 'pending_answer', id: 'heal-1', preview_result: [{ product_code: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP' }, availability: 'In stock' }] }
        : { status: 'done', id: 'heal-1', completed_steps: ['user_approval', 'save_new_template'] })) as BrightDataClient['pollRefactorTemplateProgress'],
      resumeAutomationJob: vi.fn(async () => undefined),
    };
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const previewContract = { productCode: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };
    const result = await healOwnedFixture('price moved', { client, policy, permit, previewContract, poll: { intervalMs: 1, deadlineMs: 10 } });

    expect(result).toMatchObject({ status: 'done', id: 'heal-1' });
    expect(calls[0]).toEqual([collectorId, 'price moved', [{ url: fixtureUrl }]]);
    expect(client.resumeAutomationJob).toHaveBeenCalledOnce();
    expect(client.resumeAutomationJob).toHaveBeenCalledWith(collectorId, { message: true, autoSave: true });
  });

  it('rejects an invalid preview rather than auto-approving the fixture repair', async () => {
    const client: Pick<BrightDataClient, 'refactorTemplate' | 'pollRefactorTemplateProgress' | 'resumeAutomationJob'> = {
      refactorTemplate: vi.fn(async () => ({})) as BrightDataClient['refactorTemplate'],
      pollRefactorTemplateProgress: vi.fn(async () => ({ status: 'pending_answer', id: 'heal-1', preview_result: [{ product_code: 'WRONG', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' }] })) as BrightDataClient['pollRefactorTemplateProgress'],
      resumeAutomationJob: vi.fn(async () => undefined),
    };
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const previewContract = { productCode: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract, poll: { intervalMs: 1, deadlineMs: 10 } })).rejects.toThrow(/rejected before approval.*product_code/i);
    expect(client.resumeAutomationJob).toHaveBeenCalledWith(collectorId, { message: false, autoSave: false });
    expect(client.resumeAutomationJob).not.toHaveBeenCalledWith(collectorId, { message: true, autoSave: true });
  });

  it('requires save_new_template evidence when Bright Data provides completed steps', async () => {
    let polls = 0;
    const client: Pick<BrightDataClient, 'refactorTemplate' | 'pollRefactorTemplateProgress' | 'resumeAutomationJob'> = {
      refactorTemplate: vi.fn(async () => ({})) as BrightDataClient['refactorTemplate'],
      pollRefactorTemplateProgress: vi.fn(async () => (++polls === 1
        ? { status: 'pending_answer', preview_result: [{ product_code: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' }] }
        : { status: 'done', completed_steps: ['user_approval'] })) as BrightDataClient['pollRefactorTemplateProgress'],
      resumeAutomationJob: vi.fn(async () => undefined),
    };
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const previewContract = { productCode: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };

    await expect(healOwnedFixture('price moved', { client, policy, permit, previewContract, poll: { intervalMs: 1, deadlineMs: 10 } })).rejects.toThrow(/save_new_template/i);
  });

  it('refuses a terminal heal envelope that omits promotion evidence', async () => {
    let polls = 0;
    const client: Pick<BrightDataClient, 'refactorTemplate' | 'pollRefactorTemplateProgress' | 'resumeAutomationJob'> = {
      refactorTemplate: vi.fn(async () => ({})) as BrightDataClient['refactorTemplate'],
      pollRefactorTemplateProgress: vi.fn(async () => (++polls === 1
        ? { status: 'pending_answer', preview_result: [{ product_code: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' }] }
        : { status: 'done' })) as BrightDataClient['pollRefactorTemplateProgress'],
      resumeAutomationJob: vi.fn(async () => undefined),
    };
    const permit = mintOwnedFixtureHealPermit(collectorId, fixtureUrl, policy);
    const previewContract = { productCode: 'SKU-1', title: 'Aster', price: { value: 51.77, currency: 'GBP', symbol: '£' }, availability: 'In stock' };

    await expect(healOwnedFixture('title moved', { client, policy, permit, previewContract, poll: { intervalMs: 1, deadlineMs: 10 } })).rejects.toThrow(/save_new_template/i);
  });
});
