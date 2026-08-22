import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type Database from 'better-sqlite3';
import { Ledger } from '../store/ledger.js';
import { Governor } from '../loop/policy.js';
import type { RunnerContext } from '../loop/runner.js';
import type { OutputSchema } from './types.js';
import type { KeyExtractor } from '../evidence/checks/identity.js';
import type { BrightDataClient, PollOptions } from '../brightdata/client.js';
import type { AlertNotifier } from '../loop/alerts.js';
// Type-only — erased at compile time, so this adds NO runtime import and the
// CLI's base module graph is unaffected (tenant-architecture.md §7 rule 3:
// local commands must never load hosted auth/crypto). `TenantCollectorRow` is scope.ts's
// own row shape (see src/tenancy/scope.ts) — `buildTenantContext` below
// takes an already-loaded array of these rather than a `TenantScope`
// itself, so this module never calls into src/tenancy/ at the type level
// either, only at the value level via a dynamic import (see below).
import type { TenantCollectorRow } from '../tenancy/scope.js';

export type Adapter = 'brightdata' | 'unlocker' | 'local';

export interface Collector {
  id: string;
  name: string;
  entity_key?: string;
  canary_inputs: string[];
  adapter: Adapter;
  url_template?: string;
}

export interface Policy {
  max_attempts_per_incident: number;
  cooldown_minutes: number;
  daily_heal_budget: number;
  heal_enabled: boolean;
}

export interface Alerts {
  telegram_webhook?: string;
}

export interface FleetConfig {
  tenant: { name: string };
  collectors: Collector[];
  policy: Policy;
  alerts: Alerts;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const VALID_ADAPTERS: Adapter[] = ['brightdata', 'unlocker', 'local'];

const DEFAULT_POLICY: Policy = {
  max_attempts_per_incident: 2,
  cooldown_minutes: 30,
  daily_heal_budget: 10,
  heal_enabled: false,
};

/** Loads and validates a fleet.yaml file from disk. */
export function loadFleetConfig(path: string): FleetConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read fleet config at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new ConfigError(`could not parse fleet config at ${path}: ${(err as Error).message}`);
  }

  return parseFleetConfig(parsed);
}

/** Validates an already-parsed fleet config document and returns a typed FleetConfig. */
export function parseFleetConfig(raw: unknown): FleetConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('fleet config must be a YAML mapping');
  }
  const doc = raw as Record<string, unknown>;

  const tenant = doc.tenant as Record<string, unknown> | undefined;
  if (!tenant || typeof tenant !== 'object' || typeof tenant.name !== 'string' || tenant.name.trim() === '') {
    throw new ConfigError('tenant.name is required');
  }

  if (!Array.isArray(doc.collectors) || doc.collectors.length === 0) {
    throw new ConfigError('collectors must be a non-empty array');
  }

  const seenIds = new Set<string>();
  const collectors: Collector[] = doc.collectors.map((c, i) => {
    const collector = validateCollector(c, i);
    if (seenIds.has(collector.id)) {
      throw new ConfigError(`collectors[${i}].id "${collector.id}" is duplicated`);
    }
    seenIds.add(collector.id);
    return collector;
  });

  return {
    tenant: { name: tenant.name },
    collectors,
    policy: parsePolicy(doc.policy),
    alerts: parseAlerts(doc.alerts),
  };
}

/** Every `policy:` key is optional; anything missing, non-numeric, or
 * non-boolean falls back to DEFAULT_POLICY rather than failing the load. */
function parsePolicy(raw: unknown): Policy {
  const policy = (raw as Record<string, unknown> | undefined) ?? {};
  return {
    max_attempts_per_incident: numberOr(policy.max_attempts_per_incident, DEFAULT_POLICY.max_attempts_per_incident),
    cooldown_minutes: numberOr(policy.cooldown_minutes, DEFAULT_POLICY.cooldown_minutes),
    daily_heal_budget: numberOr(policy.daily_heal_budget, DEFAULT_POLICY.daily_heal_budget),
    heal_enabled: typeof policy.heal_enabled === 'boolean' ? policy.heal_enabled : DEFAULT_POLICY.heal_enabled,
  };
}

function parseAlerts(raw: unknown): Alerts {
  const alerts = (raw as Record<string, unknown> | undefined) ?? {};
  if (alerts.telegram_webhook === undefined) return {};
  if (typeof alerts.telegram_webhook !== 'string') {
    throw new ConfigError('alerts.telegram_webhook must be a string');
  }
  return { telegram_webhook: alerts.telegram_webhook };
}

function validateCollector(c: unknown, index: number): Collector {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    throw new ConfigError(`collectors[${index}] must be a mapping`);
  }
  const col = c as Record<string, unknown>;

  if (typeof col.id !== 'string' || col.id.trim() === '') {
    throw new ConfigError(`collectors[${index}].id is required`);
  }
  const label = `collectors[${index}] (${col.id})`;

  if (typeof col.name !== 'string' || col.name.trim() === '') {
    throw new ConfigError(`${label}.name is required`);
  }

  if (!Array.isArray(col.canary_inputs) || col.canary_inputs.length === 0 || col.canary_inputs.some((x) => typeof x !== 'string')) {
    throw new ConfigError(`${label}.canary_inputs must be a non-empty array of strings`);
  }

  if (typeof col.adapter !== 'string' || !VALID_ADAPTERS.includes(col.adapter as Adapter)) {
    throw new ConfigError(`${label}.adapter must be one of ${VALID_ADAPTERS.join(', ')}`);
  }

  if (col.entity_key !== undefined && typeof col.entity_key !== 'string') {
    throw new ConfigError(`${label}.entity_key must be a string`);
  }

  if (col.url_template !== undefined && typeof col.url_template !== 'string') {
    throw new ConfigError(`${label}.url_template must be a string`);
  }

  return {
    id: col.id,
    name: col.name,
    entity_key: col.entity_key as string | undefined,
    canary_inputs: col.canary_inputs as string[],
    adapter: col.adapter as Adapter,
    url_template: col.url_template as string | undefined,
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// buildTenantContext — the hosted-server seam (tenant-architecture.md §4/§7):
// turns N `tenant_collectors` rows into ONE FleetConfig + ONE RunnerContext,
// the identical types `runFleet` (runner.ts) already consumes from a
// fleet.yaml-driven CLI run. Everything below `FleetConfig` — runner.ts,
// policy.ts, checks/*, heal.ts, adapters.ts — never learns tenancy exists;
// this function is the entire seam.
//
// Deliberately does NOT statically import anything under `src/tenancy/` —
// `loadRunnerOverridesFor` (src/tenancy/onboarding.ts) is loaded via a
// DYNAMIC import inside the function body instead, so `config.ts`'s own
// module-load-time behavior (and therefore every CLI command's, since
// index.ts imports config.ts unconditionally) is byte-for-byte unchanged:
// hosted onboarding code is not parsed unless this function is actually
// called by `src/tenancy/serve.ts`/`scheduler.ts`.

export interface BuildTenantContextInput {
  db: Database.Database;
  tenantId: string;
  genesisHash: string;
  displayName: string;
  /** tenants.heal_enabled === 1, per row — still ANDed with the
   * POLYGRAPH_HEAL_ENABLED env gate inside heal.ts's `isHealEnabled`
   * regardless of this value (R6: hosted heal is structurally off because
   * `serve` never sets that env var, not because this flag is hardcoded
   * false). */
  healEnabled: boolean;
  client: BrightDataClient;
  pollOptions?: PollOptions;
  notifier?: AlertNotifier;
  now?: () => string;
}

/**
 * Builds `{ config, ctx }` from every row in `confirmedCollectors` (the
 * caller loads these via `scope.collectors.listConfirmed()`, or a
 * single-row array for the scheduler's one-collector-per-tick mini fleet —
 * see tenant-architecture.md §5). Only `setup_state = 'confirmed'` rows
 * should ever be passed in: an unconfirmed collector has no
 * `output_schema_json` to build a real check against and — per §4's
 * three-state UI — must never be scheduled or dashboarded as if it were.
 *
 * `ctx.ledger`/`ctx.governor` are freshly constructed `Ledger`/`Governor`
 * instances scoped to `tenantId` (mirroring what `ScopedLedger`/
 * `ScopedGovernor` do internally in src/tenancy/scope.ts) rather than reused
 * from an existing `TenantScope` — `runFleet` needs the actual `Ledger`/
 * `Governor` classes (it calls `ctx.ledger.append` and hands `ctx.governor`
 * straight to `decideWithGovernor`), not the isolation-wrapped `Scoped*`
 * variants those are for HTTP read paths, not the scheduler.
 */
export async function buildTenantContext(
  confirmedCollectors: TenantCollectorRow[],
  input: BuildTenantContextInput
): Promise<{ config: FleetConfig; ctx: RunnerContext }> {
  const { loadRunnerOverridesFor } = await import('../tenancy/onboarding.js');

  const collectors: Collector[] = confirmedCollectors.map((row) => ({
    id: row.collector_id,
    name: row.name,
    entity_key: row.entity_key ?? undefined,
    canary_inputs: JSON.parse(row.canary_inputs_json) as string[],
    adapter: 'brightdata',
  }));

  const config: FleetConfig = {
    tenant: { name: input.displayName },
    collectors,
    // Hosted v1 uses the same governor defaults as a fleet.yaml run with no
    // `policy:` block — sourced from DEFAULT_POLICY so the two can't drift.
    policy: { ...DEFAULT_POLICY, heal_enabled: input.healEnabled },
    // Hosted v1 has no per-tenant webhook (tenant-architecture.md §4 —
    // `alerts.telegram_webhook` is a server-side POST to a user-controlled
    // URL, an SSRF primitive not offered in v1).
    alerts: {},
  };

  const schemas: Record<string, OutputSchema> = {};
  const entityExtractors: Record<string, KeyExtractor> = {};
  for (const row of confirmedCollectors) {
    const overrides = loadRunnerOverridesFor(row);
    if (overrides.schema) schemas[row.collector_id] = overrides.schema;
    if (overrides.entityExtractor) entityExtractors[row.collector_id] = overrides.entityExtractor as KeyExtractor;
  }

  const ledger = new Ledger(input.db, { tenantId: input.tenantId, genesisHash: input.genesisHash });
  const governor = new Governor(input.db, { tenantId: input.tenantId });

  const ctx: RunnerContext = {
    adapterContext: { client: input.client, pollOptions: input.pollOptions },
    governor,
    ledger,
    schemas,
    entityExtractors,
    ...(input.notifier ? { notifier: input.notifier } : {}),
    ...(input.now ? { now: input.now } : {}),
  };

  return { config, ctx };
}
