import { randomUUID } from 'node:crypto';
import type { DatasetPollResult, RefactorProgress } from '../brightdata.js';
import { healOwnedFixture, mintOwnedFixtureHealPermit } from '../heal.js';

export const DEMO_STEPS = ['mission-created', 'v1-baseline', 'deploy-wait', 'v2-broken', 'diagnosis', 'self-healing', 'receipt'] as const;
type Scene = 'landing' | 'v1_baseline' | 'deploy_wait' | 'broken_v2' | 'diagnosis' | 'self_healing' | 'receipt';
type Status = 'idle' | 'running' | 'waiting' | 'healed' | 'error';
export interface DemoMissionConfig {
  githubToken: string;
  fixtureRepo: string;
  fixtureWorkflow: string;
  fixtureUrl: string;
  collectorId: string;
  brightDataApiKey: string;
  expectedSku: string;
  expectedPrice: string;
  maxMissions?: number;
  githubRef?: string;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
}
export interface DemoGithubClient { dispatch(version: 'v1' | 'v2', generation: string, missionId: string): Promise<void>; waitForMarker(version: 'v1' | 'v2', generation: string, missionId: string): Promise<void>; workflowUrl: string }
export interface DemoMissionEvent { step: string; detail: string; at: string }
export interface DemoMission { id: string; scene: Scene; status: Status; steps: readonly string[]; activeStep: number; events: DemoMissionEvent[]; evidence: { fixture_repo: string; v1_url: string; v2_url: string | null; workflow_url: string; live_fixture_url: string; marker_url: string | null; collector_url: string; collector_id: string; commit_sha: null; run_id: string | null; baseline_run_id: string | null; broken_run_id: string | null; proof_run_id: string | null; heal_run_id: string | null }; last_error: string | null }
export interface DemoBrightDataClient { trigger(collectorId: string, inputs: unknown[]): Promise<string>; pollDataset(jobId: string): Promise<DatasetPollResult>; refactorTemplate(collectorId: string, prompt: string, customInput?: unknown[]): Promise<unknown>; pollRefactorTemplateProgress(collectorId: string): Promise<RefactorProgress>; resumeAutomationJob(collectorId: string, opts: { message: boolean; autoSave: boolean }): Promise<void> }
export interface DemoMissionDeps { config: DemoMissionConfig; github: DemoGithubClient; brightData: DemoBrightDataClient; now?: () => string; id?: () => string; nextGeneration?: () => string }
interface Runtime { scrapes: number; heals: number; settled: Promise<void> }
const fulfilled = Promise.resolve();
function hasPrice(row: Record<string, unknown>): boolean { const value = row.price; return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== ''); }
function assertRows(result: DatasetPollResult, label: string): Record<string, unknown>[] { if (result.ambiguous || result.rows.length === 0) throw new Error(`${label} returned no decisive rows`); return result.rows; }
function scalar(value: unknown): string { return value === undefined || value === null ? '' : String(value).trim(); }
function numericPrice(value: unknown): number | undefined { if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) return numericPrice((value as { value: unknown }).value); const normalized = scalar(value).replace(/,/g, '').replace(/[^0-9.-]/g, ''); if (!normalized) return undefined; const parsed = Number(normalized); return Number.isFinite(parsed) ? parsed : undefined; }
function assertFixtureRow(result: DatasetPollResult, label: string, config: DemoMissionConfig, expectedPrice: boolean): Record<string, unknown> {
  const rows = assertRows(result, label);
  if (rows.length !== 1) throw new Error(`${label} returned ${rows.length} rows; the owned one-product fixture must return exactly one`);
  const row = rows[0];
  if (scalar(row.sku) !== config.expectedSku) throw new Error(`${label} returned the wrong product identity; expected ${config.expectedSku}`);
  if (!expectedPrice) { if (hasPrice(row)) throw new Error(`${label} still contains a price; refusing to heal a fixture that is not broken`); return row; }
  if (numericPrice(row.price) !== numericPrice(config.expectedPrice)) throw new Error(`${label} did not prove the expected fixture price ${config.expectedPrice}`);
  return row;
}

/** In-memory demo orchestration. Mutating routes only schedule work; GET exposes each state transition. */
export class DemoMissionService {
  private readonly missions = new Map<string, DemoMission>();
  private readonly runtimes = new Map<string, Runtime>();
  private activeId: string | undefined;
  private lastGeneration = 0;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly nextGeneration: () => string;
  private createdMissions = 0;
  constructor(private readonly deps: DemoMissionDeps) { this.now = deps.now ?? (() => new Date().toISOString()); this.id = deps.id ?? randomUUID; this.nextGeneration = deps.nextGeneration ?? (() => String(Math.max(Date.now(), this.lastGeneration + 1))); }
  current(id: string): DemoMission | undefined { return this.missions.get(id); }
  whenSettled(id: string): Promise<void> { const runtime = this.runtimes.get(id); if (!runtime) return Promise.reject(new DemoMissionNotFoundError(id)); return runtime.settled; }
  create(): DemoMission {
    if (this.activeId) throw new DemoMissionLeaseError();
    const maxMissions = this.deps.config.maxMissions ?? 2;
    if (this.createdMissions >= maxMissions) throw new DemoMissionBudgetError(maxMissions);
    this.createdMissions++;
    const mission: DemoMission = { id: this.id(), scene: 'v1_baseline', status: 'running', steps: DEMO_STEPS, activeStep: 1, events: [], evidence: { fixture_repo: `https://github.com/${this.deps.config.fixtureRepo}`, v1_url: this.sourceUrl('v1'), v2_url: null, workflow_url: this.deps.github.workflowUrl, live_fixture_url: this.deps.config.fixtureUrl, marker_url: null, collector_url: `https://brightdata.com/cp/scrapers/${encodeURIComponent(this.deps.config.collectorId)}`, collector_id: this.deps.config.collectorId, commit_sha: null, run_id: null, baseline_run_id: null, broken_run_id: null, proof_run_id: null, heal_run_id: null }, last_error: null };
    this.missions.set(mission.id, mission); this.activeId = mission.id; this.runtimes.set(mission.id, { scrapes: 0, heals: 0, settled: fulfilled }); this.schedule(mission, () => this.runCreate(mission)); return mission;
  }
  shift(id: string): DemoMission {
    const mission = this.require(id);
    if (this.activeId !== id || mission.status !== 'waiting') throw new DemoMissionConflictError('shift is available only after the V1 baseline is finished');
    mission.status = 'running'; mission.scene = 'deploy_wait'; mission.activeStep = 2; this.schedule(mission, () => this.runShift(mission)); return mission;
  }
  reset(id: string): DemoMission {
    const mission = this.require(id);
    if (this.activeId !== id || mission.status === 'running') throw new DemoMissionConflictError('reset is unavailable while the mission is running');
    mission.status = 'running'; mission.scene = 'landing'; mission.activeStep = 0; mission.last_error = null; this.schedule(mission, () => this.runReset(mission)); return mission;
  }
  private schedule(mission: DemoMission, work: () => Promise<void>): void { const runtime = this.runtime(mission.id); runtime.settled = Promise.resolve().then(work).catch((error) => { this.fail(mission, error); }); }
  private async runCreate(mission: DemoMission): Promise<void> { await this.deploy('v1', mission); const baseline = await this.scrape(mission, 'A baseline'); assertFixtureRow(baseline.result, 'A baseline', this.deps.config, true); mission.evidence.run_id = baseline.jobId; mission.evidence.baseline_run_id = baseline.jobId; this.event(mission, 'baseline_a', `Bright Data A proved SKU ${this.deps.config.expectedSku} at ${this.deps.config.expectedPrice} from live V1.`); mission.scene = 'v1_baseline'; mission.status = 'waiting'; mission.activeStep = 1; }
  private async runShift(mission: DemoMission): Promise<void> {
    await this.deploy('v2', mission); mission.evidence.v2_url = this.sourceUrl('v2'); mission.scene = 'broken_v2'; mission.activeStep = 3;
    const broken = await this.scrape(mission, 'B drift check'); assertFixtureRow(broken.result, 'B drift check', this.deps.config, false); mission.evidence.broken_run_id = broken.jobId;
    this.event(mission, 'difference', `Bright Data B still identified ${this.deps.config.expectedSku}, but its price field disappeared.`); mission.scene = 'diagnosis'; mission.activeStep = 4;
    this.event(mission, 'incident_memory', 'Recorded incident: V2 live marker appeared before Bright Data B lost the price field.');
    const prompt = 'The live V2 fixture returns rows without a price. Refactor the collector template to extract the product price and preserve the existing product identity fields.';
    this.event(mission, 'healing_prompt', `Healing prompt prepared: ${prompt}`); mission.scene = 'self_healing'; mission.activeStep = 5; await this.heal(mission, prompt); mission.activeStep = 6;
    const recovered = await this.scrape(mission, 'C recovery verification'); assertFixtureRow(recovered.result, 'C recovery verification', this.deps.config, true); mission.evidence.proof_run_id = recovered.jobId;
    this.event(mission, 'receipt', `Bright Data C re-proved SKU ${this.deps.config.expectedSku} at ${this.deps.config.expectedPrice} after the repair.`); mission.scene = 'receipt'; mission.status = 'healed';
  }
  private async runReset(mission: DemoMission): Promise<void> { await this.deploy('v1', mission); this.event(mission, 'reset_v1', 'V1 live marker confirmed; reset performs no additional Bright Data scrape.'); const runtime = this.runtime(mission.id); runtime.scrapes = 0; runtime.heals = 0; mission.status = 'idle'; this.activeId = undefined; }
  private async deploy(version: 'v1' | 'v2', mission: DemoMission): Promise<void> { const generation = this.newGeneration(); this.event(mission, `dispatch_${version}`, `Dispatched fixture workflow for ${version.toUpperCase()} generation ${generation}.`); await this.deps.github.dispatch(version, generation, mission.id); await this.deps.github.waitForMarker(version, generation, mission.id); mission.evidence.marker_url = this.markerUrl(generation); this.event(mission, `marker_${version}`, `Live version.json confirmed ${version.toUpperCase()} generation ${generation} for this mission.`); }
  private async scrape(mission: DemoMission, label: string): Promise<{ jobId: string; result: DatasetPollResult }> { const runtime = this.runtime(mission.id); if (runtime.scrapes >= 3) throw new Error('demo scrape limit reached (maximum 3)'); runtime.scrapes++; const jobId = await this.deps.brightData.trigger(this.deps.config.collectorId, [{ url: this.deps.config.fixtureUrl }]); const result = await this.deps.brightData.pollDataset(jobId); assertRows(result, label); return { jobId, result }; }
  private async heal(mission: DemoMission, prompt: string): Promise<void> {
    const runtime = this.runtime(mission.id);
    if (runtime.heals >= 1) throw new Error('demo heal limit reached (maximum 1)');
    runtime.heals++;
    const policy = { max_attempts_per_incident: 1, cooldown_minutes: 0, daily_heal_budget: 1, heal_enabled: true };
    const permit = mintOwnedFixtureHealPermit(this.deps.config.collectorId, this.deps.config.fixtureUrl, policy);
    const progress = await healOwnedFixture(prompt, { client: this.deps.brightData, policy, permit });
    this.event(mission, 'heal_approved', 'The owned-fixture repair reached Bright Data approval and used its explicit one-use auto-save permit.');
    mission.evidence.heal_run_id = typeof progress.id === 'string' ? progress.id : null;
    this.event(mission, 'heal_complete', `Bright Data reported repair progress status ${progress.status}.`);
  }
  private newGeneration(): string { const raw = this.nextGeneration(); if (!/^\d+$/.test(raw) || Number(raw) <= this.lastGeneration) throw new Error('demo generation must be a positive monotonically increasing integer'); this.lastGeneration = Number(raw); return raw; }
  private markerUrl(generation: string): string { const url = new URL('version.json', this.deps.config.fixtureUrl.endsWith('/') ? this.deps.config.fixtureUrl : `${this.deps.config.fixtureUrl}/`); url.searchParams.set('generation', generation); return url.toString(); }
  private sourceUrl(version: 'v1' | 'v2'): string { const ref = this.deps.config.githubRef ?? 'main'; return `https://github.com/${this.deps.config.fixtureRepo}/blob/${encodeURIComponent(ref)}/versions/${version}.html`; }
  private event(mission: DemoMission, step: string, detail: string): void { mission.events.push({ step, detail, at: this.now() }); }
  private fail(mission: DemoMission, error: unknown): void { mission.status = 'error'; mission.last_error = error instanceof Error ? error.message : String(error); this.event(mission, 'error', mission.last_error); }
  private runtime(id: string): Runtime { const value = this.runtimes.get(id); if (!value) throw new DemoMissionNotFoundError(id); return value; }
  private require(id: string): DemoMission { const mission = this.current(id); if (!mission) throw new DemoMissionNotFoundError(id); return mission; }
}
export class DemoMissionLeaseError extends Error { constructor() { super('a demo mission is already active; reset the current mission before starting another'); } }
export class DemoMissionBudgetError extends Error { constructor(limit: number) { super(`the live demo budget allows ${limit} mission(s) per server process`); } }
export class DemoMissionConflictError extends Error { constructor(message: string) { super(message); } }
export class DemoMissionNotFoundError extends Error { constructor(id: string) { super(`demo mission ${id} was not found`); } }
