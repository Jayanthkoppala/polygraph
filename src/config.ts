import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

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

  const policyRaw = (doc.policy as Record<string, unknown> | undefined) ?? {};
  const policy: Policy = {
    max_attempts_per_incident: numberOr(
      policyRaw.max_attempts_per_incident,
      DEFAULT_POLICY.max_attempts_per_incident
    ),
    cooldown_minutes: numberOr(policyRaw.cooldown_minutes, DEFAULT_POLICY.cooldown_minutes),
    daily_heal_budget: numberOr(policyRaw.daily_heal_budget, DEFAULT_POLICY.daily_heal_budget),
    heal_enabled: typeof policyRaw.heal_enabled === 'boolean' ? policyRaw.heal_enabled : DEFAULT_POLICY.heal_enabled,
  };

  const alertsRaw = (doc.alerts as Record<string, unknown> | undefined) ?? {};
  const alerts: Alerts = {};
  if (alertsRaw.telegram_webhook !== undefined) {
    if (typeof alertsRaw.telegram_webhook !== 'string') {
      throw new ConfigError('alerts.telegram_webhook must be a string');
    }
    alerts.telegram_webhook = alertsRaw.telegram_webhook;
  }

  return {
    tenant: { name: tenant.name },
    collectors,
    policy,
    alerts,
  };
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
