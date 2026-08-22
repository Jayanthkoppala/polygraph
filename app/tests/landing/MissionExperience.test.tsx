import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { MissionEvent, MissionState } from '@/landing/demoMissionApi';
import { MissionExperience } from '@/landing/MissionExperience';
import { RECEIPT_EVENT, START_PROOF_EVENT } from '@/components/GlobalChrome';

const missionApi = vi.hoisted(() => ({
  createMission: vi.fn(),
  getMission: vi.fn(),
  shiftMission: vi.fn(),
  resetMission: vi.fn(),
}));

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="proof-route">{`${location.pathname}${location.search}`}</output>;
}

function renderMission(mode: 'landing' | 'proof' = 'landing') {
  const entry = mode === 'proof' ? '/live-proof?stage=collect' : '/';
  return render(<MemoryRouter initialEntries={[entry]}><MissionExperience mode={mode} /><RouteProbe /></MemoryRouter>);
}

vi.mock('@/landing/demoMissionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/landing/demoMissionApi')>()),
  ...missionApi,
}));

vi.mock('@/components/Dither', () => ({ default: () => <div data-testid="dither" /> }));

const baselineResult = {
  productCode: 'Product/Code-123',
  title: 'Aster QuietWave Wireless Noise-Cancelling Headphones, 40-hour Battery, Midnight Blue',
  price: { value: 51.77, currency: 'GBP', symbol: '£' },
  availability: 'In stock',
};
const brokenResult = {
  productCode: null,
  title: null,
  price: { value: 0, currency: 'GBP', symbol: '£' },
  availability: 'In stock',
};

const evidence: MissionState['evidence'] = {
  fixtureRepo: 'https://github.com/Jayanthkoppala/polygraph-version-shift-store',
  v1Url: 'https://github.com/example/fixture/blob/main/versions/v1.html',
  v2Url: 'https://github.com/example/fixture/blob/main/versions/v2.html',
  workflowUrl: 'https://github.com/example/fixture/actions/workflows/switch-version.yml',
  liveFixtureUrl: 'https://fixture.example/',
  collectorUrl: 'https://brightdata.example/collectors/c_demo',
  collectorId: 'c_demo',
  markerUrl: 'https://fixture.example/version.json?generation=2',
  commitSha: null,
  baselineRunId: 'job-a',
  baselineRunUrl: 'https://brightdata.example/runs/job-a',
  brokenRunId: null,
  brokenRunUrl: null,
  recoveryRunId: null,
  recoveryRunUrl: null,
  runId: 'job-a',
  healRunId: null,
  healRunUrl: null,
  baselineResult,
  brokenResult: null,
  proofResult: null,
  changedFields: [],
};

function event(step: string, detail: string, second: number): MissionEvent {
  return { step, detail, at: `2026-08-22T09:00:${String(second).padStart(2, '0')}.000Z` };
}

const baselineEvents = [
  event('dispatch_v1', 'Dispatched fixture workflow for V1 generation 1.', 1),
  event('marker_v1', 'Live version.json confirmed V1 generation 1.', 2),
  event('baseline_a', 'Bright Data A proved all four fields for Product/Code-123 at £51.77 from live V1.', 3),
];

const baselineMission: MissionState = {
  id: 'mission-1',
  status: 'waiting',
  scene: 'v1_baseline',
  steps: [],
  events: baselineEvents,
  evidence,
  lastError: null,
};

const deployMission: MissionState = {
  ...baselineMission,
  status: 'running',
  scene: 'deploy_wait',
  events: [...baselineEvents, event('dispatch_v2', 'Dispatched fixture workflow for V2 generation 2.', 4)],
};

const brokenMission: MissionState = {
  ...deployMission,
  scene: 'broken_v2',
  events: [...deployMission.events, event('marker_v2', 'Live version.json confirmed V2 generation 2.', 5)],
};

const healingMission: MissionState = {
  ...brokenMission,
  scene: 'self_healing',
  evidence: { ...evidence, brokenRunId: 'job-b', brokenRunUrl: 'https://brightdata.example/runs/job-b', brokenResult, changedFields: ['product_code', 'title', 'price'] },
  events: [
    ...brokenMission.events,
    event('difference', 'Bright Data B regressed product_code, title, and price after the V2 markup shift; availability stayed healthy.', 6),
    event('incident_memory', 'Matched incident family selector_anchor_moved.', 7),
    event('healing_prompt', 'Healing prompt prepared for product_code, title, and price.', 8),
    event('heal_approved', 'The owned-fixture repair reached Bright Data approval.', 9),
    event('heal_complete', 'Bright Data reported repair progress status completed.', 10),
  ],
};

const recoveredMission: MissionState = {
  ...healingMission,
  status: 'healed',
  scene: 'receipt',
  evidence: {
    ...healingMission.evidence,
    recoveryRunId: 'job-c',
    recoveryRunUrl: 'https://brightdata.example/runs/job-c',
    healRunId: 'heal-1',
    healRunUrl: 'https://brightdata.example/heals/heal-1',
    proofResult: baselineResult,
  },
  events: [...healingMission.events, event('receipt', 'Bright Data C re-proved all four fields for Product/Code-123 at £51.77 after the repair.', 11)],
};

const replayMission: MissionState = {
  ...recoveredMission,
  replay: true,
};

const healedWithoutReceipt: MissionState = {
  ...healingMission,
  status: 'healed',
  scene: 'receipt',
  evidence: { ...healingMission.evidence, recoveryRunId: 'job-c' },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MissionExperience live mission story', () => {
  it('shows the switch-version recovery artifact without starting a live mission', () => {
    renderMission();

    expect(screen.getByTestId('landing-scene')).toHaveTextContent(/we built a version-shifting store for this test/i);
    expect(screen.getByText('VALIDATE')).toBeInTheDocument();
    expect(missionApi.createMission).not.toHaveBeenCalled();
  });

  it('coalesces rapid global proof commands into one mission request', async () => {
    let resolveMission!: (mission: MissionState) => void;
    missionApi.createMission.mockReturnValue(new Promise((resolve) => { resolveMission = resolve; }));
    renderMission('proof');

    await waitFor(() => expect(missionApi.createMission).toHaveBeenCalledOnce());
    fireEvent(window, new Event(START_PROOF_EVENT));
    fireEvent(window, new Event(START_PROOF_EVENT));
    expect(missionApi.createMission).toHaveBeenCalledOnce();

    await act(async () => {
      resolveMission(baselineMission);
      await Promise.resolve();
    });
    expect(missionApi.createMission).toHaveBeenCalledOnce();
  });

  it('renders the complete cinematic story from mission API state and real evidence fields', async () => {
    missionApi.createMission.mockResolvedValue(baselineMission);
    missionApi.getMission.mockResolvedValue(baselineMission);
    missionApi.shiftMission.mockResolvedValue(deployMission);
    missionApi.resetMission.mockResolvedValue({ ...recoveredMission, status: 'running', scene: 'landing' });
    renderMission('proof');

    expect(await screen.findByText(/for this test, we built a live version-shifting store/i)).toBeInTheDocument();
    expect(missionApi.createMission).toHaveBeenCalledOnce();
    expect(screen.getAllByText(/product\/code-123/i).length).toBeGreaterThan(0);
    expect(screen.getByTitle(/live product page — initial snapshot/i)).toHaveAttribute('src', 'https://fixture.example/versions/v1');
    expect(screen.getByTitle(/live product page — switched version/i)).toHaveAttribute('src', 'https://fixture.example/versions/v2');
    expect(screen.getByTitle(/live product page — initial snapshot/i).closest('.pg-magic-safari')).not.toBeNull();
    expect(screen.getByLabelText(/mission progress: collect/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('proof-route')).toHaveTextContent('/live-proof?stage=collect&mission=mission-1'));
    expect(screen.getByRole('button', { name: /change the store to v2/i })).toBeEnabled();
    expect(screen.getByText(/polygraph guides the self-healing loop/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /github/i })).toHaveAttribute('href', 'https://github.com/Jayanthkoppala/polygraph-version-shift-store');
    expect(screen.getByRole('link', { name: /live store/i })).toHaveAttribute('href', 'https://fixture.example/');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('shift-v2-btn'));
    expect(await screen.findByLabelText(/publishing v2/i)).toBeInTheDocument();
    expect(missionApi.shiftMission).toHaveBeenCalledWith('mission-1');
    expect(screen.getByText(/no more clicks/i)).toBeInTheDocument();

    missionApi.getMission.mockResolvedValue(brokenMission);
    missionApi.getMission.mockResolvedValue(healingMission);
    expect(await screen.findByText(/product code, title, and price no longer match/i, {}, { timeout: 7_000 })).toBeInTheDocument();
    expect(screen.getByText(/product code, title, and price no longer match/i)).toBeInTheDocument();
    expect(document.querySelector('.pg-fuzzy-message canvas')).not.toBeNull();
    expect(screen.getByLabelText(/returned json comparison/i).closest('.pg-conversation-visual')).not.toBeNull();
    expect(screen.queryByTitle(/live product page/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/here is what polygraph found/i, {}, { timeout: 5_200 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('proof-route')).toHaveTextContent(/stage=compare/));
    expect(screen.getByText(/recognized a moved selector/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/returned json comparison/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/what polygraph is doing in the background/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mission progress: compare/i)).toBeInTheDocument();

    expect(await screen.findByText(/bright data returned an autosaved repair candidate/i, {}, { timeout: 5_200 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('proof-route')).toHaveTextContent(/stage=repair/));
    expect(screen.getByLabelText(/mission progress: repair/i)).toBeInTheDocument();

    missionApi.getMission.mockResolvedValue(recoveredMission);
    expect(await screen.findByText(/third production run is back/i, {}, { timeout: 7_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('proof-route')).toHaveTextContent(/stage=prove/));
    expect(screen.getByText(/4 of 4 fields verified/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mission progress: prove/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/recovery verified/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /connect your collector/i })).toHaveAttribute('href', '/signup');
    expect(screen.getByRole('link', { name: /see the receipt/i })).toHaveAttribute('href', '/receipts');
    expect(document.querySelector('.story-confetti')).toBeNull();
    expect(screen.queryByRole('button', { name: /reset fixture/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open recovery receipt/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('continue-after-deploy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-diagnosis')).not.toBeInTheDocument();
    expect(screen.queryByTestId('advance-to-healing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-fresh-run')).not.toBeInTheDocument();

    fireEvent(window, new Event(RECEIPT_EVENT));
    expect(await screen.findByText(/here is the evidence trail behind the story/i)).toBeInTheDocument();
    expect(screen.getByText(/bright data c re-proved/i)).toBeInTheDocument();
  }, 26_000);

  it('replays a completed receipt through all four chapters without another provider mutation', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    missionApi.createMission.mockResolvedValue(replayMission);
    renderMission('proof');

    expect(await screen.findByText(/verified receipt replay/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mission progress: collect/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change the store to v2/i })).not.toBeInTheDocument();

    expect(await screen.findByText(/replaying the verified v2 deployment/i, {}, { timeout: 4_200 })).toBeInTheDocument();
    expect(await screen.findByLabelText(/returned json comparison/i, {}, { timeout: 3_200 })).toBeInTheDocument();
    expect(await screen.findByText(/here is what polygraph found/i, {}, { timeout: 5_200 })).toBeInTheDocument();
    expect(await screen.findByLabelText(/mission progress: repair/i, {}, { timeout: 5_200 })).toBeInTheDocument();
    expect(await screen.findByLabelText(/mission progress: prove/i, {}, { timeout: 4_400 })).toBeInTheDocument();
    expect(screen.getByText(/4 of 4 fields verified/i)).toBeInTheDocument();

    expect(missionApi.createMission).toHaveBeenCalledOnce();
    expect(missionApi.shiftMission).not.toHaveBeenCalled();
    expect(missionApi.resetMission).not.toHaveBeenCalled();
  }, 25_000);

  it('keeps polling when healed status arrives before the receipt event', async () => {
    missionApi.createMission.mockResolvedValue(baselineMission);
    missionApi.getMission
      .mockResolvedValueOnce(healedWithoutReceipt)
      .mockResolvedValue(recoveredMission);
    renderMission('proof');

    await waitFor(() => expect(missionApi.getMission).toHaveBeenCalledTimes(2), { timeout: 2_800 });
  });

  it('never invents a successful scene when the mission API rejects the start', async () => {
    missionApi.createMission.mockRejectedValue(new Error('/api/demo/missions: 503 unavailable'));
    renderMission('proof');
    await waitFor(() => expect(missionApi.createMission).toHaveBeenCalledOnce());
    expect(screen.getByTestId('mission-fallback')).toHaveTextContent(/live proof could not start/i);
    expect(screen.queryByText('RECOVERY VERIFIED')).not.toBeInTheDocument();
    expect(missionApi.shiftMission).not.toHaveBeenCalled();
  });

  it('offers customer connection without starting a live mission', () => {
    renderMission();

    expect(screen.getByRole('button', { name: /connect collectors/i })).toBeInTheDocument();
    expect(missionApi.createMission).not.toHaveBeenCalled();
  });
});
