import { randomUUID } from 'node:crypto';
import type { DatasetPollResult, RefactorProgress } from '../brightdata/client.js';
import { healOwnedFixture, mintOwnedFixtureHealPermit } from '../brightdata/heal.js';

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
  expectedProductCode: string;
  expectedPrice: string;
  expectedCurrency: string;
  expectedSymbol: string;
  maxMissions?: number;
  githubRef?: string;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
  /** Kept server-side; only the operator-only fresh-proof endpoint reads it. */
  freshProofToken?: string;
}
export interface DemoProductObservation {
  product_code: string | null;
  title: string | null;
  price: { value: number | null; currency: string | null; symbol: string | null };
  availability: string | null;
}
export type DemoFixtureVersion = 'v1' | 'v2' | 'v3';
export interface DemoGithubClient { dispatch(version: DemoFixtureVersion, generation: string, missionId: string): Promise<void>; waitForMarker(version: DemoFixtureVersion, generation: string, missionId: string): Promise<void>; workflowUrl: string }
export interface DemoMissionEvent { step: string; detail: string; at: string }
export interface DemoMissionEvidence { fixture_repo: string; v1_url: string; v2_url: string | null; baseline_version?: DemoFixtureVersion; changed_version?: DemoFixtureVersion; workflow_url: string; live_fixture_url: string; marker_url: string | null; collector_url: string; collector_id: string; commit_sha: null; run_id: string | null; baseline_run_id: string | null; broken_run_id: string | null; proof_run_id: string | null; heal_run_id: string | null; baseline_result: DemoProductObservation | null; broken_result: DemoProductObservation | null; proof_result: DemoProductObservation | null; changed_fields: string[] }
export interface DemoMission { id: string; scene: Scene; status: Status; steps: readonly string[]; activeStep: number; events: DemoMissionEvent[]; evidence: DemoMissionEvidence; last_error: string | null }
export interface DemoMissionStore {
  loadCompleted(): DemoMission[];
  saveCompleted(mission: DemoMission): void;
}
export interface DemoRepairReceipt {
  id: string;
  source: 'demo';
  mission_id: string;
  collector: string;
  collector_name: string;
  incident_run_id: string | null;
  heal_job_id: string;
  detected_at: string;
  repair_started_at: string;
  completed_at: string;
  status: 'verified';
  cause: 'STRUCTURAL';
  incident_verdict: 'FAILED_STRUCTURAL';
  changed_fields: string[];
  change_summary: string;
  repair_prompt: string | null;
  proof_run_id: string | null;
  terminal_ledger_id: null;
  event_hash: null;
}
export interface DemoBrightDataClient { trigger(collectorId: string, inputs: unknown[]): Promise<string>; pollDataset(jobId: string): Promise<DatasetPollResult>; refactorTemplate(collectorId: string, prompt: string, customInput?: unknown[]): Promise<unknown>; pollRefactorTemplateProgress(collectorId: string): Promise<RefactorProgress>; resumeAutomationJob(collectorId: string, opts: { message: boolean; autoSave: boolean }): Promise<void> }
interface DemoMissionDeps { config: DemoMissionConfig; github: DemoGithubClient; brightData: DemoBrightDataClient; store?: DemoMissionStore; now?: () => string; id?: () => string; nextGeneration?: () => string }
interface Runtime { scrapes: number; heals: number; settled: Promise<void> }
const fulfilled = Promise.resolve();
function assertRows(result: DatasetPollResult, label: string): Record<string, unknown>[] { if (result.ambiguous || result.rows.length === 0) throw new Error(`${label} returned no decisive rows`); return result.rows; }
function scalar(value: unknown): string { return value === undefined || value === null ? '' : String(value).trim(); }
function numericPrice(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function productObservation(row: Record<string, unknown>): DemoProductObservation {
  const money = row.price && typeof row.price === 'object' && !Array.isArray(row.price) ? row.price as Record<string, unknown> : {};
  return {
    product_code: scalar(row.product_code) || null,
    title: scalar(row.title) || null,
    price: { value: numericPrice(money.value) ?? null, currency: scalar(money.currency) || null, symbol: scalar(money.symbol) || null },
    availability: scalar(row.availability) || null,
  };
}
function assertMoneyShape(value: unknown, label: string, config: DemoMissionConfig): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} did not return the required structured money value`);
  const money = value as Record<string, unknown>;
  if (numericPrice(money.value) === undefined) throw new Error(`${label} did not return a finite numeric price.value`);
  if (scalar(money.currency) !== config.expectedCurrency || scalar(money.symbol) !== config.expectedSymbol) throw new Error(`${label} returned the wrong currency; expected ${config.expectedCurrency} ${config.expectedSymbol}`);
}
function oneFixtureObservation(result: DatasetPollResult, label: string): { row: Record<string, unknown>; observation: DemoProductObservation } {
  const rows = assertRows(result, label);
  if (rows.length !== 1) throw new Error(`${label} returned ${rows.length} rows; the owned one-product fixture must return exactly one`);
  const row = rows[0];
  return { row, observation: productObservation(row) };
}
function assertBaselineRow(result: DatasetPollResult, label: string, config: DemoMissionConfig): DemoProductObservation {
  const { row, observation } = oneFixtureObservation(result, label);
  if (typeof row.product_code !== 'string' || !row.product_code.trim()) throw new Error(`${label} did not return the required literal product_code field`);
  if (observation.product_code !== config.expectedProductCode) throw new Error(`${label} returned the wrong product identity; expected ${config.expectedProductCode}`);
  if (!observation.title || !observation.availability) throw new Error(`${label} did not return the complete product title and availability contract`);
  assertMoneyShape(row.price, label, config);
  if (observation.price.value !== Number(config.expectedPrice)) throw new Error(`${label} did not prove the expected fixture price ${config.expectedPrice}`);
  return observation;
}
function changedFixtureFields(baseline: DemoProductObservation, current: DemoProductObservation): string[] {
  const changed: string[] = [];
  if (current.product_code !== baseline.product_code) changed.push('product_code');
  if (current.title !== baseline.title) changed.push('title');
  if (current.price.value !== baseline.price.value || current.price.currency !== baseline.price.currency || current.price.symbol !== baseline.price.symbol) changed.push('price');
  if (current.availability !== baseline.availability) changed.push('availability');
  return changed;
}
function inspectBrokenRow(result: DatasetPollResult, label: string, baseline: DemoProductObservation): { observation: DemoProductObservation; changedFields: string[] } {
  const { observation } = oneFixtureObservation(result, label);
  const changedFields = changedFixtureFields(baseline, observation);
  return { observation, changedFields };
}
function assertExpectedBrokenRow(regression: { observation: DemoProductObservation; changedFields: string[] }, label: string, baseline: DemoProductObservation): void {
  if (regression.observation.product_code && regression.observation.product_code !== baseline.product_code) throw new Error(`${label} returned the wrong product identity; expected ${baseline.product_code}`);
  const expectedRegression = ['product_code', 'title', 'price'];
  if (regression.changedFields.join('|') !== expectedRegression.join('|')) throw new Error(`${label} did not reproduce the expected product_code, title, and price regression while preserving availability; observed ${humanList(regression.changedFields) || 'no changed fields'}`);
}
function assertRecoveredRow(result: DatasetPollResult, label: string, config: DemoMissionConfig, baseline: DemoProductObservation): DemoProductObservation {
  const { row, observation } = oneFixtureObservation(result, label);
  if (typeof row.product_code !== 'string' || !row.product_code.trim()) throw new Error(`${label} did not return the required literal product_code field`);
  assertMoneyShape(row.price, label, config);
  const changedFields = changedFixtureFields(baseline, observation);
  if (changedFields.length > 0) throw new Error(`${label} still differs from the V1 contract on ${humanList(changedFields)}`);
  return observation;
}
function humanList(values: string[]): string {
  if (values.length < 2) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

/** In-memory demo orchestration. Mutating routes only schedule work; GET exposes each state transition. */
export class DemoMissionService {
  private readonly missions = new Map<string, DemoMission>();
  private readonly runtimes = new Map<string, Runtime>();
  private activeId: string | undefined;
  private lastReceiptId: string | undefined;
  private lastGeneration = 0;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly nextGeneration: () => string;
  private createdMissions = 0;
  private completedMissions = 0;
  constructor(private readonly deps: DemoMissionDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.id = deps.id ?? randomUUID;
    this.nextGeneration = deps.nextGeneration ?? (() => String(Math.max(Date.now(), this.lastGeneration + 1)));
    const completed = deps.store?.loadCompleted() ?? [];
    for (const mission of completed) {
      if (mission.status !== 'healed' || mission.scene !== 'receipt' || !mission.events.some((event) => event.step === 'receipt')) continue;
      this.missions.set(mission.id, mission);
      this.runtimes.set(mission.id, { scrapes: 3, heals: 1, settled: fulfilled });
      this.completedMissions++;
    }
    const latest = completed.find((mission) => this.missions.has(mission.id));
    if (latest) {
      this.lastReceiptId = latest.id;
      this.activeId = latest.id;
    }
  }
  current(id: string): DemoMission | undefined { return this.missions.get(id); }
  repairReceipts(limit = 100): DemoRepairReceipt[] {
    return [...this.missions.values()]
      .filter((mission) => mission.status === 'healed' && mission.scene === 'receipt')
      .flatMap((mission) => {
        const difference = mission.events.find((event) => event.step === 'difference');
        const prompt = mission.events.find((event) => event.step === 'healing_prompt');
        const receipt = mission.events.find((event) => event.step === 'receipt');
        if (!difference || !prompt || !receipt) return [];
        return [{
          id: mission.id,
          source: 'demo' as const,
          mission_id: mission.id,
          collector: mission.evidence.collector_id,
          collector_name: 'Version-shift demo collector',
          incident_run_id: mission.evidence.broken_run_id,
          heal_job_id: mission.evidence.heal_run_id ?? `${mission.id}:heal`,
          detected_at: difference.at,
          repair_started_at: prompt.at,
          completed_at: receipt.at,
          status: 'verified' as const,
          cause: 'STRUCTURAL' as const,
          incident_verdict: 'FAILED_STRUCTURAL' as const,
          changed_fields: [...mission.evidence.changed_fields],
          change_summary: difference.detail,
          repair_prompt: prompt.detail.replace(/^Healing prompt prepared:\s*/i, '') || null,
          proof_run_id: mission.evidence.proof_run_id,
          terminal_ledger_id: null,
          event_hash: null,
        }];
      })
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
      .slice(0, Math.max(1, Math.floor(limit)));
  }
  whenSettled(id: string): Promise<void> { const runtime = this.runtimes.get(id); if (!runtime) return Promise.reject(new DemoMissionNotFoundError(id)); return runtime.settled; }
  acquire(): { mission: DemoMission; reused: boolean } {
    if (this.activeId) return { mission: this.require(this.activeId), reused: true };
    if (this.lastReceiptId) {
      return { mission: this.require(this.lastReceiptId), reused: true };
    }
    throw new DemoMissionConflictError('no completed demo receipt is available to replay; an operator must start the fresh proof');
  }
  /** Starts only A. First proof is V1→V2; later receipts advance V2→V3. */
  startFresh(): DemoMission {
    const active = this.activeId ? this.require(this.activeId) : undefined;
    if (active && (active.status === 'running' || active.status === 'waiting')) throw new DemoMissionLeaseError();
    const maxMissions = this.deps.config.maxMissions ?? 2;
    // Hydrated durable receipts plus fresh attempts started in this process.
    // A completed same-process attempt is already represented by createdMissions.
    if (this.completedMissions + this.createdMissions >= maxMissions) throw new DemoMissionBudgetError(maxMissions);
    this.createdMissions++;
    const baselineVersion: DemoFixtureVersion = this.hasCompletedReceipt() ? 'v2' : 'v1';
    const changedVersion: DemoFixtureVersion = baselineVersion === 'v1' ? 'v2' : 'v3';
    const mission: DemoMission = { id: this.id(), scene: 'v1_baseline', status: 'running', steps: DEMO_STEPS, activeStep: 1, events: [], evidence: { fixture_repo: `https://github.com/${this.deps.config.fixtureRepo}`, v1_url: this.sourceUrl(baselineVersion), v2_url: null, baseline_version: baselineVersion, changed_version: changedVersion, workflow_url: this.deps.github.workflowUrl, live_fixture_url: this.deps.config.fixtureUrl, marker_url: null, collector_url: `https://brightdata.com/cp/scrapers/${encodeURIComponent(this.deps.config.collectorId)}`, collector_id: this.deps.config.collectorId, commit_sha: null, run_id: null, baseline_run_id: null, broken_run_id: null, proof_run_id: null, heal_run_id: null, baseline_result: null, broken_result: null, proof_result: null, changed_fields: [] }, last_error: null };
    this.missions.set(mission.id, mission); this.activeId = mission.id; this.runtimes.set(mission.id, { scrapes: 0, heals: 0, settled: fulfilled }); this.schedule(mission, () => this.runCreate(mission)); return mission;
  }
  /** Backward-compatible service seam; HTTP callers must use startFresh through its operator gate. */
  create(): DemoMission { return this.startFresh(); }
  shift(id: string): DemoMission {
    const mission = this.require(id);
    if (this.activeId !== id || mission.status !== 'waiting') throw new DemoMissionConflictError(`shift is available only after the ${this.baselineVersion(mission).toUpperCase()} baseline is finished`);
    mission.status = 'running'; mission.scene = 'deploy_wait'; mission.activeStep = 2; this.schedule(mission, () => this.runShift(mission)); return mission;
  }
  reset(id: string): DemoMission {
    const mission = this.require(id);
    if (this.activeId !== id || mission.status === 'running') throw new DemoMissionConflictError('reset is unavailable while the mission is running');
    mission.status = 'running'; mission.scene = 'landing'; mission.activeStep = 0; mission.last_error = null; this.schedule(mission, () => this.runReset(mission)); return mission;
  }
  private schedule(mission: DemoMission, work: () => Promise<void>): void { const runtime = this.runtime(mission.id); runtime.settled = Promise.resolve().then(work).catch((error) => { this.fail(mission, error); }); }
  private async runCreate(mission: DemoMission): Promise<void> { const baselineVersion = this.baselineVersion(mission); await this.deploy(baselineVersion, mission); const baseline = await this.scrape(mission, 'A baseline'); const observation = assertBaselineRow(baseline.result, 'A baseline', this.deps.config); mission.evidence.run_id = baseline.jobId; mission.evidence.baseline_run_id = baseline.jobId; mission.evidence.baseline_result = observation; this.event(mission, 'baseline_a', `Bright Data A proved product code ${observation.product_code}, title, price ${this.deps.config.expectedSymbol}${this.deps.config.expectedPrice}, and availability from live ${baselineVersion.toUpperCase()}.`); mission.scene = 'v1_baseline'; mission.status = 'waiting'; mission.activeStep = 1; }
  private async runShift(mission: DemoMission): Promise<void> {
    const baselineVersion = this.baselineVersion(mission); const changedVersion = this.changedVersion(mission);
    await this.deploy(changedVersion, mission); mission.evidence.v2_url = this.sourceUrl(changedVersion); mission.scene = 'broken_v2'; mission.activeStep = 3;
    const baselineObservation = mission.evidence.baseline_result;
    if (!baselineObservation) throw new Error(`${baselineVersion.toUpperCase()} baseline observation is missing`);
    const broken = await this.scrape(mission, 'B drift check'); const regression = inspectBrokenRow(broken.result, 'B drift check', baselineObservation); mission.evidence.broken_run_id = broken.jobId; mission.evidence.broken_result = regression.observation; mission.evidence.changed_fields = regression.changedFields; assertExpectedBrokenRow(regression, 'B drift check', baselineObservation);
    this.event(mission, 'difference', `Bright Data B regressed ${humanList(regression.changedFields)} after the ${changedVersion.toUpperCase()} markup shift; ${4 - regression.changedFields.length} of 4 monitored fields stayed healthy.`); mission.scene = 'diagnosis'; mission.activeStep = 4;
    this.event(mission, 'incident_memory', `Matched incident family selector_anchor_moved: the deployment changed and ${regression.changedFields.length} monitored extraction fields moved away from the ${baselineVersion.toUpperCase()} contract.`);
    const prompt = this.repairPrompt(baselineVersion, changedVersion, regression.changedFields);
    this.event(mission, 'healing_prompt', `Healing prompt prepared: ${prompt}`); mission.scene = 'self_healing'; mission.activeStep = 5; await this.heal(mission, prompt); mission.activeStep = 6;
    const recovered = await this.scrape(mission, 'C recovery verification'); const proofObservation = assertRecoveredRow(recovered.result, 'C recovery verification', this.deps.config, baselineObservation); mission.evidence.proof_run_id = recovered.jobId; mission.evidence.proof_result = proofObservation;
    this.event(mission, 'receipt', `Bright Data C re-proved all four fields for ${proofObservation.product_code} at ${this.deps.config.expectedSymbol}${this.deps.config.expectedPrice} after the ${changedVersion.toUpperCase()} repair.`); mission.scene = 'receipt'; mission.status = 'healed'; this.lastReceiptId = mission.id; this.deps.store?.saveCompleted(mission);
  }
  private async runReset(mission: DemoMission): Promise<void> { const baselineVersion = this.baselineVersion(mission); await this.deploy(baselineVersion, mission); this.event(mission, `reset_${baselineVersion}`, `${baselineVersion.toUpperCase()} live marker confirmed; reset performs no additional Bright Data scrape.`); const runtime = this.runtime(mission.id); runtime.scrapes = 0; runtime.heals = 0; mission.status = 'idle'; this.activeId = undefined; }
  private async deploy(version: DemoFixtureVersion, mission: DemoMission): Promise<void> { const generation = this.newGeneration(); this.event(mission, `dispatch_${version}`, `Dispatched fixture workflow for ${version.toUpperCase()} generation ${generation}.`); await this.deps.github.dispatch(version, generation, mission.id); await this.deps.github.waitForMarker(version, generation, mission.id); mission.evidence.marker_url = this.markerUrl(generation); this.event(mission, `marker_${version}`, `Live version.json confirmed ${version.toUpperCase()} generation ${generation} for this mission.`); }
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
  private baselineVersion(mission: DemoMission): DemoFixtureVersion { return mission.evidence.baseline_version ?? 'v1'; }
  private hasCompletedReceipt(): boolean { return [...this.missions.values()].some((mission) => mission.status === 'healed' && mission.scene === 'receipt'); }
  private changedVersion(mission: DemoMission): DemoFixtureVersion { return mission.evidence.changed_version ?? 'v2'; }
  private repairPrompt(baselineVersion: DemoFixtureVersion, changedVersion: DemoFixtureVersion, fields: string[]): string {
    const anchorChange = baselineVersion === 'v2' && changedVersion === 'v3'
      ? 'product code from data-catalog-key to data-listing-id, title from .catalog-heading to .listing-headline, and price from .commerce-amount to .listing-price__amount'
      : 'product code from data-product-ref to data-catalog-key, title from .product-title to .catalog-heading, and price from .money-widget__value to .commerce-amount';
    return `The owned ${changedVersion.toUpperCase()} fixture regressed ${humanList(fields)}. The markup moved ${anchorChange}. Refactor the collector to restore only those three fields while preserving ${this.deps.config.expectedProductCode}. Keep the availability extraction untouched because it still matches the ${baselineVersion.toUpperCase()} result.`;
  }
  private sourceUrl(version: DemoFixtureVersion): string { const ref = this.deps.config.githubRef ?? 'main'; return `https://github.com/${this.deps.config.fixtureRepo}/blob/${encodeURIComponent(ref)}/versions/${version}.html`; }
  private event(mission: DemoMission, step: string, detail: string): void { mission.events.push({ step, detail, at: this.now() }); }
  private fail(mission: DemoMission, error: unknown): void {
    mission.status = 'error'; mission.last_error = error instanceof Error ? error.message : String(error); this.event(mission, 'error', mission.last_error);
    // Never turn a failed fresh attempt into the public replay target. It remains
    // inspectable by ID while ordinary Start proof continues to replay evidence.
    if (this.activeId === mission.id) this.activeId = this.lastReceiptId;
  }
  private runtime(id: string): Runtime { const value = this.runtimes.get(id); if (!value) throw new DemoMissionNotFoundError(id); return value; }
  private require(id: string): DemoMission { const mission = this.current(id); if (!mission) throw new DemoMissionNotFoundError(id); return mission; }
}
export class DemoMissionLeaseError extends Error { constructor() { super('a demo mission is already active; reset the current mission before starting another'); } }
export class DemoMissionBudgetError extends Error { constructor(limit: number) { super(`the live demo budget allows ${limit} mission(s) per server process`); } }
export class DemoMissionConflictError extends Error { constructor(message: string) { super(message); } }
export class DemoMissionNotFoundError extends Error { constructor(id: string) { super(`demo mission ${id} was not found`); } }
