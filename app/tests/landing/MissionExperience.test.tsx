import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MissionEvent, MissionState } from '@/landing/demoMissionApi';
import { MissionExperience } from '@/landing/MissionExperience';
import { START_PROOF_EVENT } from '@/components/GlobalChrome';

const missionApi = vi.hoisted(() => ({
  createMission: vi.fn(),
  getMission: vi.fn(),
  shiftMission: vi.fn(),
  resetMission: vi.fn(),
}));

vi.mock('@/landing/demoMissionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/landing/demoMissionApi')>()),
  ...missionApi,
}));

vi.mock('@/components/Dither', () => ({ default: () => <div data-testid="dither" /> }));

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
};

function event(step: string, detail: string, second: number): MissionEvent {
  return { step, detail, at: `2026-08-22T09:00:${String(second).padStart(2, '0')}.000Z` };
}

const baselineEvents = [
  event('dispatch_v1', 'Dispatched fixture workflow for V1 generation 1.', 1),
  event('marker_v1', 'Live version.json confirmed V1 generation 1.', 2),
  event('baseline_a', 'Bright Data A proved SKU SKU-ASTER-001 at 51.77 from live V1.', 3),
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
  evidence: { ...evidence, brokenRunId: 'job-b', brokenRunUrl: 'https://brightdata.example/runs/job-b' },
  events: [
    ...brokenMission.events,
    event('difference', 'Bright Data B still identified SKU-ASTER-001, but price collapsed from 51.77 to the schema default 0.', 6),
    event('incident_memory', 'Matched incident family selector_anchor_moved.', 7),
    event('healing_prompt', 'Healing prompt prepared for the changed price selector.', 8),
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
  },
  events: [...healingMission.events, event('receipt', 'Bright Data C re-proved SKU SKU-ASTER-001 at 51.78 after the repair.', 11)],
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
});

describe('MissionExperience live mission story', () => {
  it('keeps the launch surface empty until the global proof control is used', () => {
    render(<MissionExperience />);

    expect(screen.getByTestId('landing-scene')).toBeEmptyDOMElement();
    expect(missionApi.createMission).not.toHaveBeenCalled();
  });

  it('coalesces rapid global proof commands into one mission request', async () => {
    let resolveMission!: (mission: MissionState) => void;
    missionApi.createMission.mockReturnValue(new Promise((resolve) => { resolveMission = resolve; }));
    render(<MissionExperience />);

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
    render(<MissionExperience />);

    fireEvent(window, new Event(START_PROOF_EVENT));
    expect(await screen.findByRole('heading', { name: /v1 is telling the truth/i })).toBeInTheDocument();
    expect(missionApi.createMission).toHaveBeenCalledOnce();
    expect(screen.getByText(/job-a/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sku-aster-001/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('shift-v2-btn'));
    expect(await screen.findByText(/deploying v2 from github/i)).toBeInTheDocument();
    expect(missionApi.shiftMission).toHaveBeenCalledWith('mission-1');
    expect(screen.getByTestId('continue-after-deploy')).toBeDisabled();

    missionApi.getMission.mockResolvedValue(brokenMission);
    await waitFor(() => expect(screen.getByTestId('continue-after-deploy')).toBeEnabled(), { timeout: 2_800 });
    fireEvent.click(screen.getByTestId('continue-after-deploy'));
    expect(await screen.findByRole('heading', { name: /existing collector is running/i })).toBeInTheDocument();

    missionApi.getMission.mockResolvedValue(healingMission);
    await waitFor(() => expect(screen.getByTestId('open-diagnosis')).toBeEnabled(), { timeout: 2_800 });
    expect(screen.getByText(/price collapsed from 51.77/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-diagnosis'));
    expect(await screen.findByRole('heading', { name: /separate what we saw/i })).toBeInTheDocument();
    expect(screen.getByText(/matched incident family selector_anchor_moved/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('advance-to-healing'));

    expect(await screen.findByRole('heading', { name: /recovery has one controlled object/i })).toBeInTheDocument();
    expect(screen.getByText(/bright data reported repair progress status completed/i)).toBeInTheDocument();
    expect(screen.getByTestId('verify-fresh-run')).toBeDisabled();

    missionApi.getMission.mockResolvedValue(recoveredMission);
    await waitFor(() => expect(screen.getByTestId('verify-fresh-run')).toBeEnabled(), { timeout: 2_800 });
    fireEvent.click(screen.getByTestId('verify-fresh-run'));
    expect(await screen.findByRole('heading', { name: /the loop closes with new evidence/i })).toBeInTheDocument();
    expect(screen.getByText('RECOVERY VERIFIED')).toBeInTheDocument();
    expect(screen.getAllByText(/job-c/i).length).toBeGreaterThan(0);
    expect(screen.getByText('51.78')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open recovery receipt/i }));
    expect(await screen.findByRole('heading', { name: /same flow. server-recorded evidence/i })).toBeInTheDocument();
    expect(screen.getByText(/11 mission events/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /collection a proof/i })).toHaveAttribute('href', evidence.baselineRunUrl);
    expect(screen.getByRole('link', { name: /collection b proof/i })).toHaveAttribute('href', healingMission.evidence.brokenRunUrl);
    expect(screen.getByRole('link', { name: /healing proof/i })).toHaveAttribute('href', recoveredMission.evidence.healRunUrl);
    expect(screen.getByRole('link', { name: /collection c proof/i })).toHaveAttribute('href', recoveredMission.evidence.recoveryRunUrl);
    expect(screen.queryByText(/sha256/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /back to recovered state/i }));
    await screen.findByRole('heading', { name: /the loop closes with new evidence/i });
    fireEvent.click(screen.getByTestId('reset-v1-btn'));
    await waitFor(() => expect(missionApi.resetMission).toHaveBeenCalledWith('mission-1'));
  }, 14_000);

  it('keeps polling when healed status arrives before the receipt event', async () => {
    missionApi.createMission.mockResolvedValue(baselineMission);
    missionApi.getMission
      .mockResolvedValueOnce(healedWithoutReceipt)
      .mockResolvedValue(recoveredMission);
    render(<MissionExperience />);

    fireEvent(window, new Event(START_PROOF_EVENT));

    await waitFor(() => expect(missionApi.getMission).toHaveBeenCalledTimes(2), { timeout: 2_800 });
  });

  it('never invents a successful scene when the mission API rejects the start', async () => {
    missionApi.createMission.mockRejectedValue(new Error('/api/demo/missions: 503 unavailable'));
    render(<MissionExperience />);

    fireEvent(window, new Event(START_PROOF_EVENT));
    await waitFor(() => expect(missionApi.createMission).toHaveBeenCalledOnce());
    expect(screen.getByTestId('landing-scene')).toBeEmptyDOMElement();
    expect(screen.queryByText('RECOVERY VERIFIED')).not.toBeInTheDocument();
    expect(missionApi.shiftMission).not.toHaveBeenCalled();
  });

  it('keeps connection controls out of the minimal launch surface', () => {
    render(<MissionExperience />);

    expect(screen.queryByRole('button', { name: /connect my collectors/i })).not.toBeInTheDocument();
    expect(missionApi.createMission).not.toHaveBeenCalled();
  });
});
