import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MissionExperience } from './MissionExperience';

vi.mock('@/components/Dither', () => ({ default: () => <div data-testid="dither" /> }));

const mission = {
  id: 'mission-1',
  status: 'waiting',
  scene: 'v1_baseline',
  events: [{ step: 'v1_baseline', detail: 'Baseline receipt saved.', at: '2026-08-22T09:00:00.000Z' }],
  evidence: {
    fixture_repo: 'https://github.com/Jayanthkoppala/polygraph-version-shift-store',
    live_fixture_url: 'https://fixture.example/v1',
    workflow_url: 'https://github.com/Jayanthkoppala/polygraph-version-shift-store/actions/runs/1',
    collector_url: 'https://brightdata.example/collectors/c_demo',
    collector_id: 'c_demo',
    marker_url: 'https://fixture.example/version.json?generation=1',
    baseline_run_id: 'job-a',
    baseline_run_url: 'https://brightdata.example/runs/job-a',
    broken_run_id: 'job-b',
    broken_run_url: 'https://brightdata.example/runs/job-b',
    recovery_run_id: 'job-c',
    recovery_run_url: 'https://brightdata.example/runs/job-c',
  },
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: 'test', json: async () => body };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MissionExperience', () => {
  it('keeps all primary mission controls visible and advances only from API state', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/demo/missions' && init?.method === 'POST') return response({ id: 'mission-1' });
      if (url === '/api/demo/missions/mission-1') return response(mission);
      if (url === '/api/demo/missions/mission-1/shift') return response({ ...mission, scene: 'broken_v2', events: [...mission.events, { step: 'v2_broken', detail: 'Candidate held.', at: '2026-08-22T09:01:00.000Z' }] });
      if (url === '/api/demo/missions/mission-1/reset') return response({ ...mission, status: 'idle', scene: 'landing', events: [...mission.events, { step: 'reset_v1', detail: 'V1 reset confirmed.', at: '2026-08-22T09:02:00.000Z' }] });
      return response({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    render(<MissionExperience />);
    expect(screen.getByRole('button', { name: /run the live proof/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /shift to v2/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /reset v1/i })).toBeVisible();
    fireEvent.click(screen.getByTestId('run-mission-btn'));
    await waitFor(() => expect(screen.getByText(/baseline receipt saved/i)).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/demo/missions', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByRole('link', { name: /live version marker/i })).toHaveAttribute('href', mission.evidence.marker_url);
    expect(screen.getByText(/collector c_demo/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open job-a/i })).toHaveAttribute('href', mission.evidence.baseline_run_url);
    fireEvent.click(screen.getByTestId('shift-v2-btn'));
    await waitFor(() => expect(screen.getByText(/candidate held/i)).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/demo/missions/mission-1/shift', expect.objectContaining({ method: 'POST' }));
    fireEvent.click(screen.getByTestId('reset-v1-btn'));
    await waitFor(() => expect(screen.getByText(/v1 reset confirmed/i)).toBeInTheDocument());
    expect(screen.getByTestId('run-mission-btn')).toBeEnabled();
  });

  it('holds both transition controls while a mission is still running', async () => {
    const runningMission = { ...mission, status: 'running' };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/demo/missions' && init?.method === 'POST') return response({ id: 'mission-1' });
      if (url === '/api/demo/missions/mission-1') return response(runningMission);
      return response({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    render(<MissionExperience />);
    fireEvent.click(screen.getByTestId('run-mission-btn'));
    await waitFor(() => expect(screen.getByText(/baseline receipt saved/i)).toBeInTheDocument());
    expect(screen.getByTestId('shift-v2-btn')).toBeDisabled();
    expect(screen.getByTestId('reset-v1-btn')).toBeDisabled();
  });

  it('labels replay fallback rather than inventing a receipt when the API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'down' }, 503)));
    render(<MissionExperience />);
    fireEvent.click(screen.getByTestId('run-mission-btn'));
    expect(await screen.findByTestId('mission-fallback')).toHaveTextContent(/replay fallback/i);
    expect(screen.getByTestId('progress-tracker')).toHaveTextContent(/no event has arrived/i);
  });

  it('routes customer collector connection into the signed-in onboarding flow', () => {
    render(<MissionExperience />);
    fireEvent.click(screen.getByRole('button', { name: /connect my collectors/i }));
    expect(screen.getByRole('heading', { name: /connect your collectors securely/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start secure onboarding/i })).toHaveAttribute('href', '/signup');
    expect(screen.getByRole('link', { name: /^sign in$/i })).toHaveAttribute('href', '/login');
  });
});
