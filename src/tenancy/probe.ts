/**
 * Step 2 (PROBE) of onboarding, per tenant-architecture.md §4 — "the
 * load-bearing step". `output_schema` (step 1) structurally cannot supply
 * `required` or `default_value`: `required` is a business judgment about
 * the tenant's own pipeline Bright Data has no way to know, and
 * `default_value` is precisely the field `contract.ts`'s `isUnfilled` uses
 * to catch a silently-collapsed extractor — Bright Data's output schema
 * will never carry it. The probe is what actually supplies both, by
 * running one real job against the tenant's own canary inputs and looking
 * at what came back.
 *
 * This spends the tenant's OWN Bright Data credits, so it is a user click,
 * never automatic — same posture as auto-heal (`policy.heal_enabled`):
 * never spend a tenant's credits without an explicit consent.
 */
import type { Collector } from '../core/config.js';
import { brightdataAdapter, type AdapterContext } from '../evidence/adapters.js';
import type { RunResult } from '../core/types.js';
import { inferType } from './infer-schema.js';

export class ConsentRequiredError extends Error {
  constructor() {
    super('polygraph: the probe run was not explicitly consented to — refusing to spend Bright Data credits');
    this.name = 'ConsentRequiredError';
  }
}

interface ProbeConsent {
  /** Must be explicitly `true` — omission or `false` refuses to run. */
  granted: boolean;
}

export interface ProbeCollectorInput {
  id: string;
  name: string;
  /** The single canary input(s) the user clicked to sample — a genuine
   * multi-input run is allowed but the wizard's own UI (§4) only ever
   * offers a single-input run at this step. */
  canary_inputs: string[];
  entity_key?: string;
}

/**
 * Runs one probe through the EXISTING brightdata adapter (adapters.ts) —
 * never a bespoke fetch, and never any other adapter: hosted tenants are
 * `adapter: brightdata` only (§4), so this never needs a page extractor.
 * Throws `ConsentRequiredError` (before touching the network at all) unless
 * `consent.granted === true`.
 */
export async function probeCollector(
  collector: ProbeCollectorInput,
  ctx: AdapterContext,
  consent: ProbeConsent
): Promise<RunResult> {
  if (!consent.granted) throw new ConsentRequiredError();

  const asCollector: Collector = {
    id: collector.id,
    name: collector.name,
    entity_key: collector.entity_key,
    canary_inputs: collector.canary_inputs,
    adapter: 'brightdata',
  };
  return brightdataAdapter.run(asCollector, collector.canary_inputs, ctx);
}

interface ProbedField {
  type: string;
  sample?: unknown;
  default_value?: unknown;
}

/** Bright Data's own dataset rows echo the request input alongside the
 * scraped fields (confirmed by `adapters.test.ts`'s own fixtures, e.g.
 * `{ sku: 'SKU-1', title: 'Widget', input: 'SKU-1' }`) — `'input'` is
 * excluded from the inferred field set so the confirm-step wizard never
 * offers it as a checkbox field to make required/entity-key. */
const RESERVED_ROW_FIELDS = new Set(['input']);

/**
 * Step 2's real deliverable: from the probe's returned rows, derives
 * per-field `type` / `sample` / `default_value` — exactly per §4's spec:
 *
 *   type[f]          = inferType() over every observed value for f
 *   default_value[f] = the empty-looking value actually observed for f
 *                       ("" | 0 | [] | null), absent if f was never empty
 *   sample[f]         = a real non-empty value, for the confirm table
 *
 * Note this mirrors the design doc verbatim, including its known ambiguity:
 * a genuine field value of exactly `0`/`""`/`[]`/`null` is indistinguishable
 * from an extractor's own "not found" sentinel purely from one probe sample
 * — that's what makes it a plausible `default_value` candidate at all, and
 * is the documented, accepted trade-off (a single probe run can't fully
 * resolve it; the user confirms/corrects it in step 3).
 */
export function buildProbeDraft(rows: Record<string, unknown>[]): Record<string, ProbedField> {
  const fieldNames = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!RESERVED_ROW_FIELDS.has(key)) fieldNames.add(key);
    }
  }

  const isEmptyLike = (v: unknown): boolean => v === '' || v === 0 || v === null || (Array.isArray(v) && v.length === 0);

  const draft: Record<string, ProbedField> = {};
  for (const field of fieldNames) {
    const values = rows.map((row) => row[field]);
    const entry: ProbedField = { type: inferType(values) };

    const emptyLike = values.find(isEmptyLike);
    if (emptyLike !== undefined) entry.default_value = emptyLike;

    const sample = values.find((v) => v !== undefined && !isEmptyLike(v));
    if (sample !== undefined) entry.sample = sample;

    draft[field] = entry;
  }
  return draft;
}
