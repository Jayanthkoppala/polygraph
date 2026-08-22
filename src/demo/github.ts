import type { DemoGithubClient, DemoMissionConfig } from './mission.js';
interface DemoGithubClientOptions { config: Pick<DemoMissionConfig, 'githubToken' | 'fixtureRepo' | 'fixtureWorkflow' | 'fixtureUrl' | 'githubRef' | 'pollIntervalMs' | 'pollDeadlineMs'>; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Dispatch is not proof: the no-store marker poll requires exact version and generation JSON. */
export class GithubFixtureClient implements DemoGithubClient {
  readonly workflowUrl: string;
  private readonly fetchImpl: typeof fetch; private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly options: DemoGithubClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; this.sleep = options.sleep ?? sleep; this.workflowUrl = `https://github.com/${options.config.fixtureRepo}/actions/workflows/${options.config.fixtureWorkflow}`; }
  async dispatch(version: 'v1' | 'v2', generation: string, missionId: string): Promise<void> {
    const { fixtureRepo, fixtureWorkflow, githubToken, githubRef = 'main' } = this.options.config;
    const repoPath = fixtureRepo.split('/').map(encodeURIComponent).join('/');
    const response = await this.fetchImpl(`https://api.github.com/repos/${repoPath}/actions/workflows/${encodeURIComponent(fixtureWorkflow)}/dispatches`, { method: 'POST', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${githubToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ref: githubRef, inputs: { version, generation, mission_id: missionId } }) });
    if (!response.ok) throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
  }
  async waitForMarker(version: 'v1' | 'v2', generation: string, missionId: string): Promise<void> {
    const intervalMs = this.options.config.pollIntervalMs ?? 1_000; const deadlineMs = this.options.config.pollDeadlineMs ?? 120_000; const started = Date.now();
    for (;;) {
      const markerUrl = new URL('version.json', this.options.config.fixtureUrl.endsWith('/') ? this.options.config.fixtureUrl : `${this.options.config.fixtureUrl}/`); markerUrl.searchParams.set('generation', generation);
      try { const response = await this.fetchImpl(markerUrl, { cache: 'no-store', headers: { accept: 'application/json' } } as unknown as RequestInit); if (response.ok) { const marker = (await response.json()) as { version?: unknown; generation?: unknown; mission_id?: unknown }; if (marker.version === version && String(marker.generation) === generation && marker.mission_id === missionId) return; } } catch { /* bounded retry handles deploy propagation and invalid JSON */ }
      if (Date.now() - started >= deadlineMs) throw new Error(`fixture version.json did not confirm ${version} generation ${generation} before the polling deadline`);
      await this.sleep(intervalMs);
    }
  }
}
