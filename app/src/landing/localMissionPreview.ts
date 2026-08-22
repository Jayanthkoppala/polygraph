import type { MissionEvent, MissionState, ProductObservation } from './demoMissionApi';

const startedAt = new Date('2026-08-22T12:00:00.000Z');
let shiftedAt: number | null = null;

const baselineResult: ProductObservation = {
  productCode: 'Product/Code-123',
  title: 'Aster QuietWave Wireless Noise-Cancelling Headphones, 40-hour Battery, Midnight Blue',
  price: { value: 51.77, currency: 'GBP', symbol: '£' },
  availability: 'In stock',
};
const brokenResult: ProductObservation = {
  productCode: null,
  title: null,
  price: { value: 0, currency: 'GBP', symbol: '£' },
  availability: 'In stock',
};
const changedFields = ['product_code', 'title', 'price'];

const evidence: MissionState['evidence'] = {
  fixtureRepo: 'https://github.com/Jayanthkoppala/polygraph-version-shift-store',
  v1Url: 'https://github.com/Jayanthkoppala/polygraph-version-shift-store/blob/main/versions/v1.html',
  v2Url: 'https://github.com/Jayanthkoppala/polygraph-version-shift-store/blob/main/versions/v2.html',
  workflowUrl: null,
  liveFixtureUrl: 'https://polygraph-version-shift-store.vercel.app',
  collectorUrl: null,
  collectorId: 'c_mt3kif5w1ds27lttug',
  markerUrl: null,
  commitSha: 'local-ux-replay',
  baselineRunId: 'local-run-a',
  baselineRunUrl: null,
  brokenRunId: null,
  brokenRunUrl: null,
  recoveryRunId: null,
  recoveryRunUrl: null,
  runId: 'local-run-a',
  healRunId: null,
  healRunUrl: null,
  baselineResult,
  brokenResult: null,
  proofResult: null,
  changedFields: [],
};

function event(step: string, detail: string, offset: number): MissionEvent {
  return { step, detail, at: new Date(startedAt.valueOf() + offset).toISOString() };
}

const baselineEvents = [
  event('dispatch_v1', 'Local UX replay prepared the initial snapshot. No workflow was dispatched.', 0),
  event('marker_v1', 'Local replay confirmed the initial version marker.', 400),
  event('baseline_a', 'Local collection A proved all four product fields for Product/Code-123 at £51.77 from the initial snapshot.', 800),
];

function current(): MissionState {
  const elapsed = shiftedAt === null ? 0 : Date.now() - shiftedAt;
  const shiftedEvents = [
    ...baselineEvents,
    event('dispatch_v2', 'Local UX replay entered the switch-version deployment boundary.', 1_200),
    event('marker_v2', 'Local replay confirmed the switched version marker.', 1_600),
  ];

  if (shiftedAt === null) {
    return { id: 'local-ux-replay', status: 'waiting', scene: 'v1_baseline', steps: [], events: baselineEvents, evidence, lastError: null };
  }
  if (elapsed < 4_200) {
    const deploymentEvents = elapsed < 2_000 ? shiftedEvents.slice(0, -1) : shiftedEvents;
    return { id: 'local-ux-replay', status: 'running', scene: 'deploy_wait', steps: [], events: deploymentEvents, evidence, lastError: null };
  }

  const brokenEvents = [...shiftedEvents,
    event('difference', 'Collection B regressed product_code, title, and price after the V2 markup shift; availability stayed healthy.', 2_000),
    event('incident_memory', 'Matched selector_anchor_moved: three monitored extraction fields moved away from the V1 contract.', 2_300),
  ];
  if (elapsed < 8_200) {
    return { id: 'local-ux-replay', status: 'running', scene: 'broken_v2', steps: [], events: brokenEvents, evidence: { ...evidence, brokenRunId: 'local-run-b', brokenResult, changedFields }, lastError: null };
  }

  const healingEvents = [...brokenEvents,
    event('healing_prompt', 'Local replay prepared one bounded repair for product_code, title, and price.', 3_000),
    event('heal_approved', 'Local replay confirmed the owned-fixture permit boundary.', 3_300),
    event('heal_complete', 'Local replay completed the Bright Data repair handoff.', 3_700),
  ];
  if (elapsed < 13_000) {
    return { id: 'local-ux-replay', status: 'running', scene: 'self_healing', steps: [], events: healingEvents, evidence: { ...evidence, brokenRunId: 'local-run-b', brokenResult, changedFields, healRunId: 'local-heal-1' }, lastError: null };
  }

  return {
    id: 'local-ux-replay', status: 'healed', scene: 'receipt', steps: [],
    events: [...healingEvents, event('receipt', 'Collection C re-proved all four fields for Product/Code-123 at £51.77 after the repair.', 4_600)],
    evidence: { ...evidence, brokenRunId: 'local-run-b', brokenResult, proofResult: baselineResult, changedFields, recoveryRunId: 'local-run-c', healRunId: 'local-heal-1' }, lastError: null,
  };
}

export async function createLocalMission(): Promise<MissionState> {
  shiftedAt = null;
  return current();
}

export async function getLocalMission(): Promise<MissionState> {
  return current();
}

export async function shiftLocalMission(): Promise<MissionState> {
  shiftedAt = Date.now();
  return current();
}

export async function resetLocalMission(): Promise<MissionState> {
  shiftedAt = null;
  return current();
}
