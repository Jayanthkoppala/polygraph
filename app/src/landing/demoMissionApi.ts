export interface MissionEvidenceRef {
  fixtureRepo: string | null;
  v1Url: string | null;
  v2Url: string | null;
  workflowUrl: string | null;
  liveFixtureUrl: string | null;
  collectorUrl: string | null;
  collectorId: string | null;
  markerUrl: string | null;
  commitSha: string | null;
  baselineRunId: string | null;
  baselineRunUrl: string | null;
  brokenRunId: string | null;
  brokenRunUrl: string | null;
  recoveryRunId: string | null;
  recoveryRunUrl: string | null;
  runId: string | null;
  healRunId: string | null;
  healRunUrl: string | null;
}

export interface MissionEvent {
  step: string;
  detail: string;
  at: string;
}

export type MissionScene =
  | 'landing'
  | 'v1_baseline'
  | 'deploy_wait'
  | 'broken_v2'
  | 'diagnosis'
  | 'self_healing'
  | 'receipt';

export type MissionStateStatus = 'idle' | 'running' | 'waiting' | 'healed' | 'fallback' | 'error';

export interface MissionState {
  id: string;
  scene?: MissionScene;
  status: MissionStateStatus;
  steps: string[];
  activeStep?: number;
  events: MissionEvent[];
  evidence: MissionEvidenceRef;
  lastError?: string | null;
}

interface MissionCreateResponse {
  id: string;
}

function stringValue(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof raw[key] === 'string') return raw[key] as string;
  }
  return null;
}

function coalesceEvidence(raw: Record<string, unknown>): MissionEvidenceRef {
  const runId = stringValue(raw, 'run_id');
  const baselineRunId = stringValue(raw, 'baseline_run_id', 'a_run_id') ?? runId;
  return {
    fixtureRepo: stringValue(raw, 'fixture_repo'),
    v1Url: stringValue(raw, 'v1_url'),
    v2Url: stringValue(raw, 'v2_url'),
    workflowUrl: stringValue(raw, 'workflow_url'),
    liveFixtureUrl: stringValue(raw, 'live_fixture_url'),
    collectorUrl: stringValue(raw, 'collector_url', 'bright_data_collector_url'),
    collectorId: stringValue(raw, 'collector_id'),
    markerUrl: stringValue(raw, 'marker_url'),
    commitSha: stringValue(raw, 'commit_sha'),
    baselineRunId,
    baselineRunUrl: stringValue(raw, 'baseline_run_url', 'a_run_url', 'run_url'),
    brokenRunId: stringValue(raw, 'broken_run_id', 'b_run_id'),
    brokenRunUrl: stringValue(raw, 'broken_run_url', 'b_run_url'),
    recoveryRunId: stringValue(raw, 'recovery_run_id', 'proof_run_id', 'c_run_id'),
    recoveryRunUrl: stringValue(raw, 'recovery_run_url', 'c_run_url'),
    runId,
    healRunId: stringValue(raw, 'heal_run_id'),
    healRunUrl: stringValue(raw, 'heal_run_url'),
  };
}

function coalesceScene(value: unknown): MissionScene | undefined {
  if (typeof value !== 'string') return undefined;
  if (['landing', 'v1_baseline', 'deploy_wait', 'broken_v2', 'diagnosis', 'self_healing', 'receipt'].includes(value)) {
    return value as MissionScene;
  }
  return undefined;
}

function coalesceStatus(value: unknown): MissionStateStatus {
  if (
    value === 'running' ||
    value === 'waiting' ||
    value === 'healed' ||
    value === 'fallback' ||
    value === 'error'
  ) {
    return value;
  }
  if (value === 'complete' || value === 'completed' || value === 'released') return 'healed';
  if (value === 'failed' || value === 'held') return 'error';
  return 'idle';
}

function normalizeState(raw: MissionState): MissionState {
  const steps = Array.isArray((raw as { steps?: unknown }).steps)
    ? ((raw as { steps?: string[] }).steps ?? []).filter((step) => typeof step === 'string')
    : ['mission-created', 'v1-baseline', 'deploy-wait', 'v2-broken', 'diagnosis', 'self-healing', 'receipt'];

  const events = Array.isArray((raw as { events?: unknown }).events)
    ? ((raw as { events: unknown[] }).events || []).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        const step = record.step ?? record.type ?? record.stage;
        const detail = record.detail ?? record.message ?? record.description;
        const at = record.at ?? record.created_at ?? record.timestamp;
        return typeof step === 'string' && typeof detail === 'string' && typeof at === 'string' ? [{ step, detail, at }] : [];
      })
    : [];

  return {
    id: raw.id,
    scene: coalesceScene((raw as { scene?: unknown }).scene),
    status: coalesceStatus((raw as { status?: unknown }).status),
    steps,
    activeStep: typeof (raw as { activeStep?: unknown }).activeStep === 'number' ? (raw as { activeStep?: number }).activeStep : undefined,
    events,
    evidence: coalesceEvidence(((raw as { evidence?: unknown }).evidence as Record<string, unknown>) ?? {}),
    lastError:
      typeof (raw as { lastError?: unknown }).lastError === 'string'
        ? String((raw as { lastError?: unknown }).lastError)
        : typeof (raw as { last_error?: unknown }).last_error === 'string'
          ? String((raw as { last_error?: unknown }).last_error)
          : null,
  };
}

async function parseJson<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) {
    let error = response.statusText;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (typeof parsed?.error === 'string') error = parsed.error;
    } catch {
      // ignore parsing failure
    }
    throw new Error(`${path}: ${response.status} ${error}`);
  }
  return (await response.json()) as T;
}

export async function createMission(): Promise<MissionState> {
  const response = await fetch('/api/demo/missions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const created = await parseJson<MissionCreateResponse>(response, '/api/demo/missions');
  return getMission(created.id);
}

export async function getMission(id: string): Promise<MissionState> {
  const response = await fetch(`/api/demo/missions/${encodeURIComponent(id)}`);
  const raw = await parseJson<Partial<MissionState>>(response, `/api/demo/missions/${id}`);
  return normalizeState(raw as MissionState);
}

export async function shiftMission(id: string): Promise<MissionState> {
  const response = await fetch(`/api/demo/missions/${encodeURIComponent(id)}/shift`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const raw = await parseJson<Partial<MissionState>>(response, `/api/demo/missions/${id}/shift`);
  return normalizeState(raw as MissionState);
}

export async function resetMission(id: string): Promise<MissionState> {
  const response = await fetch(`/api/demo/missions/${encodeURIComponent(id)}/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const raw = await parseJson<Partial<MissionState>>(response, `/api/demo/missions/${id}/reset`);
  return normalizeState(raw as MissionState);
}
