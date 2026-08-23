import type { DemoFixtureManifest, DemoFixtureVersion, DemoGithubClient, DemoMissionConfig } from './mission.js';
interface DemoGithubClientOptions { config: Pick<DemoMissionConfig, 'githubToken' | 'fixtureRepo' | 'fixtureWorkflow' | 'fixtureUrl' | 'githubRef' | 'pollIntervalMs' | 'pollDeadlineMs'>; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Dispatch is not proof: the no-store marker poll requires exact version and generation JSON. */
export class GithubFixtureClient implements DemoGithubClient {
  readonly workflowUrl: string;
  private readonly fetchImpl: typeof fetch; private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly options: DemoGithubClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; this.sleep = options.sleep ?? sleep; this.workflowUrl = `https://github.com/${options.config.fixtureRepo}/actions/workflows/${options.config.fixtureWorkflow}`; }
  async dispatch(_version: DemoFixtureVersion, generation: string, missionId: string, options?: { parentGeneration: string; seed: string }): Promise<void> {
    const { fixtureRepo, fixtureWorkflow, githubToken, githubRef = 'main' } = this.options.config;
    const repoPath = fixtureRepo.split('/').map(encodeURIComponent).join('/');
    if (!options) throw new Error('fixture evolution dispatch requires parent generation and deterministic seed');
    const response = await this.fetchImpl(`https://api.github.com/repos/${repoPath}/actions/workflows/${encodeURIComponent(fixtureWorkflow)}/dispatches`, { method: 'POST', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${githubToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ref: githubRef, inputs: { generation, parent_generation: options.parentGeneration, seed: options.seed, mission_id: missionId } }) });
    if (!response.ok) throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
  }
  async waitForMarker(_version: DemoFixtureVersion, generation: string, missionId: string, options?: { parentGeneration: string; seed: string }): Promise<void> {
    if (!options) throw new Error('fixture evolution marker check requires parent generation and deterministic seed');
    const intervalMs = this.options.config.pollIntervalMs ?? 1_000; const deadlineMs = this.options.config.pollDeadlineMs ?? 300_000; const started = Date.now();
    for (;;) {
      const markerUrl = new URL('version.json', this.options.config.fixtureUrl.endsWith('/') ? this.options.config.fixtureUrl : `${this.options.config.fixtureUrl}/`); markerUrl.searchParams.set('generation', generation);
      try { const response = await this.fetchImpl(markerUrl, { cache: 'no-store', headers: { accept: 'application/json' } } as unknown as RequestInit); if (response.ok) { const marker = (await response.json()) as { schema_version?: unknown; version?: unknown; generation?: unknown; parent_generation?: unknown; seed?: unknown; mission_id?: unknown }; if (marker.schema_version === 3 && marker.version === 'evolving' && String(marker.generation) === generation && String(marker.parent_generation) === options.parentGeneration && marker.seed === options.seed && marker.mission_id === missionId) return; } } catch { /* bounded retry handles deploy propagation and invalid JSON */ }
      if (Date.now() - started >= deadlineMs) throw new Error(`fixture version.json did not confirm evolving generation ${generation} before the polling deadline`);
      await this.sleep(intervalMs);
    }
  }
  private async readDeployedMarker(expectedGeneration?: string, expectedMissionId?: string): Promise<Record<string, unknown>> {
    const expectsDeployment = expectedGeneration !== undefined || expectedMissionId !== undefined;
    const intervalMs = this.options.config.pollIntervalMs ?? 1_000;
    const deadlineMs = this.options.config.pollDeadlineMs ?? 300_000;
    const started = Date.now();
    let attempt = 0;
    let lastObserved = 'no readable marker';
    for (;;) {
      attempt++;
      const markerUrl = new URL('version.json', this.options.config.fixtureUrl.endsWith('/') ? this.options.config.fixtureUrl : `${this.options.config.fixtureUrl}/`);
      if (expectedGeneration) markerUrl.searchParams.set('generation', expectedGeneration);
      if (expectedMissionId) markerUrl.searchParams.set('mission', expectedMissionId);
      markerUrl.searchParams.set('nonce', `${Date.now()}-${attempt}`);
      try {
        const response = await this.fetchImpl(markerUrl, { cache: 'no-store', headers: { accept: 'application/json' } } as unknown as RequestInit);
        if (!response.ok) {
          if (!expectsDeployment) throw new Error(`fixture version manifest failed: HTTP ${response.status}`);
          lastObserved = `HTTP ${response.status}`;
        } else {
          const marker = await response.json() as Record<string, unknown>;
          const generation = String(marker.generation ?? '');
          if (!/^\d+$/.test(generation)) {
            if (!expectsDeployment) throw new Error('fixture version manifest did not contain a numeric generation');
            lastObserved = 'a marker without a numeric generation';
          } else {
            const generationMatches = expectedGeneration === undefined || generation === expectedGeneration;
            const missionMatches = expectedMissionId === undefined || marker.mission_id === expectedMissionId;
            if (generationMatches && missionMatches) return marker;
            lastObserved = `generation ${generation}, mission ${String(marker.mission_id ?? 'missing')}`;
          }
        }
      } catch (error) {
        if (!expectsDeployment) throw error;
        lastObserved = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() - started >= deadlineMs) {
        throw new Error(`fixture version manifest did not confirm generation ${expectedGeneration ?? 'any'} for mission ${expectedMissionId ?? 'any'} before the polling deadline; last observed ${lastObserved}`);
      }
      await this.sleep(intervalMs);
    }
  }
  async readCurrentManifest(expectedGeneration?: string, expectedMissionId?: string): Promise<DemoFixtureManifest> {
    const marker = await this.readDeployedMarker(expectedGeneration, expectedMissionId);
    const generation = String(marker.generation ?? '');
    const rawAnchors = marker.anchors;
    const anchors = rawAnchors && typeof rawAnchors === 'object' && !Array.isArray(rawAnchors)
      ? Object.fromEntries(Object.entries(rawAnchors as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined;
    let commitSha: string | undefined;
    let workflowRunId: string | undefined;
    let workflowRunUrl: string | undefined;
    try {
      const repoPath = this.options.config.fixtureRepo.split('/').map(encodeURIComponent).join('/');
      const ref = encodeURIComponent(this.options.config.githubRef ?? 'main');
      const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${this.options.config.githubToken}` };
      const commitResponse = await this.fetchImpl(`https://api.github.com/repos/${repoPath}/commits/${ref}`, { headers });
      if (commitResponse.ok) {
        const commit = await commitResponse.json() as { sha?: unknown };
        if (typeof commit.sha === 'string') {
          const contentsResponse = await this.fetchImpl(`https://api.github.com/repos/${repoPath}/contents/version.json?ref=${encodeURIComponent(commit.sha)}`, { headers });
          if (contentsResponse.ok) {
            const contents = await contentsResponse.json() as { content?: unknown; encoding?: unknown };
            if (contents.encoding === 'base64' && typeof contents.content === 'string') {
              const committed = JSON.parse(Buffer.from(contents.content.replace(/\s/g, ''), 'base64').toString('utf8')) as Record<string, unknown>;
              const keys = ['schema_version', 'version', 'generation', 'parent_generation', 'seed', 'mission_id', 'html_sha256', 'template_sha256'] as const;
              const exactMarker = keys.every((key) => String(committed[key] ?? '') === String(marker[key] ?? ''))
                && JSON.stringify(committed.anchors ?? null) === JSON.stringify(marker.anchors ?? null)
                && JSON.stringify(committed.variant ?? null) === JSON.stringify(marker.variant ?? null);
              if (exactMarker) commitSha = commit.sha;
            }
          }
        }
      }
      if (commitSha) {
        const runsResponse = await this.fetchImpl(`https://api.github.com/repos/${repoPath}/actions/workflows/${encodeURIComponent(this.options.config.fixtureWorkflow)}/runs?branch=${ref}&event=workflow_dispatch&per_page=10`, { headers });
        if (runsResponse.ok) {
          const runs = await runsResponse.json() as { workflow_runs?: Array<{ id?: unknown; display_title?: unknown; html_url?: unknown }> };
          const expectedTitle = `Evolve fixture generation ${generation} for mission ${String(marker.mission_id ?? '')}`;
          const run = runs.workflow_runs?.find((candidate) => candidate.display_title === expectedTitle);
          if (run && (typeof run.id === 'number' || typeof run.id === 'string')) workflowRunId = String(run.id);
          if (run && typeof run.html_url === 'string') workflowRunUrl = run.html_url;
        }
      }
    } catch {
      // The deployed marker remains the proof boundary. GitHub metadata is
      // additional audit evidence and must not turn a verified deployment
      // into a false failure during a transient API outage.
    }
    return {
      schema_version: typeof marker.schema_version === 'number' ? marker.schema_version : undefined,
      version: typeof marker.version === 'string' ? marker.version : undefined,
      generation,
      parent_generation: marker.parent_generation === undefined ? undefined : String(marker.parent_generation),
      seed: typeof marker.seed === 'string' ? marker.seed : undefined,
      mission_id: typeof marker.mission_id === 'string' ? marker.mission_id : undefined,
      commit_sha: commitSha,
      workflow_run_id: workflowRunId,
      workflow_run_url: workflowRunUrl,
      html_sha256: typeof marker.html_sha256 === 'string' ? marker.html_sha256 : undefined,
      template_sha256: typeof marker.template_sha256 === 'string' ? marker.template_sha256 : undefined,
      anchors,
    };
  }
}
