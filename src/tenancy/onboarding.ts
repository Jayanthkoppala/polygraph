/**
 * Steps 3 (CONFIRM) and 4 (PERSIST) of onboarding, per tenant-
 * architecture.md §4. Step 1 (INFER) lives in `infer-schema.ts`, step 2
 * (PROBE) in `probe.ts`, declarative entity-key compilation in
 * `entity-key.ts` — this module is the glue: turning the user's confirm-
 * step answers into an `OutputSchema`, persisting it via
 * `ScopedCollectors.confirmSetup`, and reading a confirmed row back into
 * the `{ schema, entityExtractor }` shape `RunnerContext.schemas` /
 * `RunnerContext.entityExtractors` (runner.ts) already expect.
 *
 * `RunnerContext.schemas`/`entityExtractors` already take precedence over
 * `extractors.ts`'s COLLECTOR_REGISTRY (runner.ts:205) — so once a hosted
 * runner populates them from `loadRunnerOverridesFor` below,
 * `evaluateCollector`/`runFleet` need ZERO changes to grade a hosted
 * tenant's collector for real, instead of forever reading "not verified".
 * Building the FULL `RunnerContext`/`FleetConfig` from every confirmed
 * collector (`buildTenantContext`) is a separate task's `config.ts`
 * concern — this module only owns turning ONE persisted row back into the
 * override shapes runner.ts consumes.
 */
import type { FieldSchema, OutputSchema } from '../core/types.js';
import type { TenantScope, TenantCollectorRow } from './scope.js';
import { compileEntityKeyRule, type EntityKeyRule, type KeyExtractor } from './entity-key.js';

export interface ConfirmedFieldInput {
  name: string;
  type: string;
  required: boolean;
  /** The observed default value from the probe (step 2), carried through
   * unedited unless the user overrides it in the confirm-step UI — this is
   * what makes `contract.ts`'s `isUnfilled` able to detect a collapsed
   * extractor at all; see the module doc on `probe.ts`. */
  default_value?: unknown;
}

/** Step 3 (CONFIRM): builds the final `OutputSchema` from the fields the
 * user ticked required/left as-is in the confirm table. `required` and
 * (the final say on) `default_value` are the two things §4 says only the
 * user can supply — everything else was pre-filled by inference (step 1)
 * and the probe (step 2). */
export function buildConfirmedSchema(fields: ConfirmedFieldInput[]): OutputSchema {
  const schemaFields: Record<string, FieldSchema> = {};
  for (const field of fields) {
    const entry: FieldSchema = { type: field.type };
    if (field.required) entry.required = true;
    if (field.default_value !== undefined) entry.default_value = field.default_value;
    schemaFields[field.name] = entry;
  }
  return { fields: schemaFields };
}

export interface ConfirmedSetup {
  outputSchema: OutputSchema;
  /** The row FIELD name to treat as the entity key (e.g. "sku"), or `null`
   * when the user picked "don't check identity for this collector". */
  entityKey: string | null;
  entityKeyRule: EntityKeyRule | null;
}

/** Step 4 (PERSIST): writes the confirmed schema + entity-key rule into
 * `tenant_collectors` via `ScopedCollectors.confirmSetup` — flips
 * `setup_state` to `'confirmed'` and `enabled` to `1`, the first time this
 * collector is ever scheduled (tenant-architecture.md §4's three-state UI:
 * a collector never burns credits on an ungradeable run before this). */
export function persistConfirmedSetup(
  scope: TenantScope,
  collectorId: string,
  setup: ConfirmedSetup,
  options: { scheduledByPolygraph?: boolean } = {}
): TenantCollectorRow {
  return scope.collectors.confirmSetup(collectorId, {
    outputSchemaJson: JSON.stringify(setup.outputSchema),
    entityKey: setup.entityKey,
    entityKeyRuleJson: setup.entityKeyRule ? JSON.stringify(setup.entityKeyRule) : null,
  }, { enabled: options.scheduledByPolygraph ?? true });
}

export interface RunnerOverrides {
  schema?: OutputSchema;
  entityExtractor?: KeyExtractor;
}

/**
 * Reads one confirmed `tenant_collectors` row back into the override shape
 * `RunnerContext.schemas`/`RunnerContext.entityExtractors` expect (keyed by
 * collector.id by the caller — this function only handles one row's
 * values). A row with no persisted schema/rule yet (still `draft`) simply
 * yields `{}` — the caller falls through to the same "no schema
 * registered" skip path `evaluateCollector` already has for any collector,
 * hosted or not.
 */
export function loadRunnerOverridesFor(row: Pick<TenantCollectorRow, 'output_schema_json' | 'entity_key_rule_json'>): RunnerOverrides {
  const overrides: RunnerOverrides = {};
  if (row.output_schema_json) {
    overrides.schema = JSON.parse(row.output_schema_json) as OutputSchema;
  }
  if (row.entity_key_rule_json) {
    overrides.entityExtractor = compileEntityKeyRule(JSON.parse(row.entity_key_rule_json) as EntityKeyRule);
  }
  return overrides;
}
