import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BrightDataClient } from '../brightdata.js';
import { readRequestBody, RequestBodyTooLargeError } from '../server.js';
import { serveStaticOrSpa } from '../static-serve.js';
import { GithubFixtureClient } from './github.js';
import { DemoMissionBudgetError, DemoMissionConflictError, DemoMissionLeaseError, DemoMissionNotFoundError, DemoMissionService, type DemoBrightDataClient, type DemoMissionConfig } from './mission.js';
export interface DemoServerDeps { config?: DemoMissionConfig; service?: DemoMissionService; appDir?: string }
export function readDemoMissionConfig(env: NodeJS.ProcessEnv = process.env): DemoMissionConfig | undefined {
  if (env.POLYGRAPH_DEMO_LIVE !== '1') return undefined;
  if (env.POLYGRAPH_HEAL_ENABLED !== '1' || env.POLYGRAPH_DEMO_OWNED_FIXTURE_AUTOSAVE !== '1') return undefined;
  const values = { githubToken: env.POLYGRAPH_DEMO_GITHUB_TOKEN, fixtureRepo: env.POLYGRAPH_DEMO_FIXTURE_REPO, fixtureWorkflow: env.POLYGRAPH_DEMO_FIXTURE_WORKFLOW, fixtureUrl: env.POLYGRAPH_DEMO_FIXTURE_URL, collectorId: env.POLYGRAPH_DEMO_COLLECTOR_ID, brightDataApiKey: env.BRIGHTDATA_API_KEY, expectedSku: env.POLYGRAPH_DEMO_EXPECTED_SKU, expectedPrice: env.POLYGRAPH_DEMO_EXPECTED_PRICE, expectedCurrency: env.POLYGRAPH_DEMO_EXPECTED_CURRENCY, expectedSymbol: env.POLYGRAPH_DEMO_EXPECTED_SYMBOL };
  if (Object.values(values).some((value) => !value || value.trim() === '')) return undefined;
  const requestedMax = Number(env.POLYGRAPH_DEMO_MAX_MISSIONS ?? '2');
  return { ...values as Omit<DemoMissionConfig, 'maxMissions'>, maxMissions: Number.isInteger(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, 3) : 2 };
}
export function createDemoMissionService(config: DemoMissionConfig): DemoMissionService { const github = new GithubFixtureClient({ config }); const brightData: DemoBrightDataClient = new BrightDataClient({ apiKey: config.brightDataApiKey }); return new DemoMissionService({ config, github, brightData }); }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> { const raw = await readRequestBody(req); if (!raw) return {}; try { const parsed: unknown = JSON.parse(raw); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function trustedJsonMutation(req: IncomingMessage): boolean {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none';
}
function defaultAppDir(): string { return join(fileURLToPath(new URL('../..', import.meta.url)), 'app', 'dist'); }
/** Handles only public demo API routes, returning false for all other paths. */
export async function tryHandleDemoMissionRequest(req: IncomingMessage, res: ServerResponse, service?: DemoMissionService): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/demo/missions' && !url.pathname.startsWith('/api/demo/missions/')) return false;

  try {
    const method = req.method ?? 'GET';
    if (!service) { sendJson(res, 503, { error: 'demo mission configuration is incomplete or POLYGRAPH_DEMO_LIVE is not 1' }); return true; }
    if (method === 'POST' && !trustedJsonMutation(req)) { sendJson(res, 415, { error: 'demo mutations require same-site application/json requests' }); return true; }
    if (method === 'POST' && url.pathname === '/api/demo/missions') { if (!(await jsonBody(req))) { sendJson(res, 400, { error: 'invalid JSON body' }); return true; } const acquired = service.acquire(); sendJson(res, acquired.reused ? 200 : 201, { id: acquired.mission.id, reused: acquired.reused }); return true; }
    const match = url.pathname.match(/^\/api\/demo\/missions\/([^/]+)(?:\/(shift|reset))?$/);
    if (!match) { sendJson(res, 404, { error: 'not found' }); return true; }
    const id = decodeURIComponent(match[1]); const action = match[2];
    if (method === 'GET' && !action) { const mission = service.current(id); if (!mission) throw new DemoMissionNotFoundError(id); sendJson(res, 200, mission); return true; }
    if (method === 'POST' && (action === 'shift' || action === 'reset')) { if (!(await jsonBody(req))) { sendJson(res, 400, { error: 'invalid JSON body' }); return true; } const mission = action === 'shift' ? service.shift(id) : service.reset(id); sendJson(res, 202, mission); return true; }
    sendJson(res, 405, { error: 'method not allowed' }); return true;
  } catch (error) { if (error instanceof DemoMissionLeaseError || error instanceof DemoMissionConflictError) sendJson(res, 409, { error: error.message }); else if (error instanceof DemoMissionBudgetError) sendJson(res, 429, { error: error.message }); else if (error instanceof DemoMissionNotFoundError) sendJson(res, 404, { error: error.message }); else if (error instanceof RequestBodyTooLargeError) sendJson(res, 413, { error: error.message }); else sendJson(res, 500, { error: 'internal server error' }); }
  return true;
}
export function createDemoMissionServer(deps: DemoServerDeps = {}): Server { const config = deps.config ?? readDemoMissionConfig(); const service = deps.service ?? (config ? createDemoMissionService(config) : undefined); const appDir = deps.appDir ?? defaultAppDir(); return createHttpServer((req, res) => { void handle(req, res, service, appDir); }); }
async function handle(req: IncomingMessage, res: ServerResponse, service: DemoMissionService | undefined, appDir: string): Promise<void> {
  if (await tryHandleDemoMissionRequest(req, res, service)) return;
  const method = req.method ?? 'GET'; const url = new URL(req.url ?? '/', 'http://localhost');
  if (method === 'GET') { await serveStaticOrSpa(url.pathname, appDir, res); return; }
  sendJson(res, 404, { error: 'not found' });
}
