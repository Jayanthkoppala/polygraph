/**
 * The single source of truth for "which field names belong to Bright Data's
 * delivery wrapper rather than to a collector's scraped output".
 *
 * Two lists, because rows and schemas need different answers:
 *
 *  - `PROVIDER_METADATA_FIELDS` — stripped from delivery ROWS before grading
 *    and storage (`stripProviderMetadata`, `partitionDeliveryRows`). `input`
 *    is deliberately NOT in it: the echoed run input is what
 *    `extractReusableVerificationInput` needs for a post-repair verification
 *    run, and `rowsForHistory` is the one place that drops it.
 *
 *  - `SCHEMA_METADATA_FIELDS` — excluded from a collector's GRADED schema
 *    (`effectiveSchema`, and the confirmed schema built at connect time).
 *    Same list PLUS `input`: a schema that declares `input` as a required
 *    field is grading the collector on Bright Data's echo of its own request,
 *    not on anything scraped.
 *
 * Why this module exists at all: `POST /api/collectors/connect` used to copy
 * Bright Data's whole published `output_schema` into
 * `tenant_collectors.output_schema_json` with every field marked
 * `required: true` — including all 18 wrapper fields. Since ingest strips
 * those fields from the rows, a perfectly healthy delivery graded
 * FAILED_STRUCTURAL against 18 "required" fields that were 0% filled by
 * construction. `effectiveSchema` fixes already-connected collectors at load
 * time; migration 017 rewrites the stored rows.
 */
import type { OutputSchema } from '../core/types.js';

/** Fields Bright Data's delivery wrapper attaches to every row for its own
 * bookkeeping — job/page/collector identifiers, crawl status, and raw
 * artefacts — never something a collector's OutputSchema declared. Left in
 * place, they inflate contract fill rates with data nobody scraped and can
 * leak raw html/warc/screenshot payloads into the retained preview. */
export const PROVIDER_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'job_id',
  'page_id',
  'collector_id',
  'collector_queue',
  'reparse_file',
  'crawl_type',
  'timestamp',
  'requested_timestamp',
  'prime_input',
  'status_code',
  'warning',
  'warning_code',
  'error',
  'error_code',
  'screenshot',
  'html',
  'warc',
]);

/** `PROVIDER_METADATA_FIELDS` plus `input` — the names that must never appear
 * in a collector's graded schema. `input` stays in the rows (it is the run
 * input the verification path reuses) but grading a collector on it says
 * nothing about whether the extractor still works. */
export const SCHEMA_METADATA_FIELDS: ReadonlySet<string> = new Set([
  ...PROVIDER_METADATA_FIELDS,
  'input',
]);

/** True when `name` is a Bright Data wrapper field that must not be graded. */
export function isSchemaMetadataField(name: string): boolean {
  return SCHEMA_METADATA_FIELDS.has(name);
}

/** Splits field names into the ones a schema should keep and the wrapper
 * names it should drop, preserving input order in both. */
export function partitionSchemaFieldNames(names: readonly string[]): { kept: string[]; metadata: string[] } {
  const kept: string[] = [];
  const metadata: string[] = [];
  for (const name of names) (isSchemaMetadataField(name) ? metadata : kept).push(name);
  return { kept, metadata };
}

/**
 * The schema a collector is actually graded against: its declared schema with
 * every `SCHEMA_METADATA_FIELDS` name removed. Applied at LOAD time
 * (`loadRunnerOverridesFor`), so a collector connected before this fix grades
 * correctly on its very next delivery rather than waiting for migration 017.
 *
 * Two deliberate properties:
 *
 *  - Returns the SAME object when nothing would be removed, so the common
 *    path allocates nothing and `===` identity is preserved for callers that
 *    compare schemas.
 *  - Returns the schema UNCHANGED when removal would leave zero fields. A
 *    metadata-only schema is a broken setup, not a collector with no
 *    contract; silently grading it as "no required fields" would turn every
 *    delivery green. Leaving it alone keeps the failure visible, and matches
 *    migration 017's own skip rule so a migrated database and a
 *    not-yet-migrated one behave identically.
 *
 * Cost: a collector whose OWN output genuinely contains a metadata-named
 * field (jobs.ashbyhq.com's `job_id` is the known case) loses that field from
 * both its graded contract and — because ingest derives `stripProviderMetadata`'s
 * `keepFields` from the graded schema — its stored rows. Sourcing `keepFields`
 * from the RAW schema instead was tried and is worse: a legacy schema declares
 * all 18 wrapper names, so nothing would be stripped at all and html/warc/
 * screenshot payloads would land back in the retained preview. Distinguishing
 * "the site's job_id" from "Bright Data's job_id" is not possible from the
 * schema alone, and failing every delivery of every collector is by far the
 * worse of the two errors.
 */
export function effectiveSchema(schema: OutputSchema): OutputSchema;
export function effectiveSchema(schema: OutputSchema | undefined): OutputSchema | undefined;
export function effectiveSchema(schema: OutputSchema | undefined): OutputSchema | undefined {
  if (!schema || !schema.fields) return schema;
  const names = Object.keys(schema.fields);
  const { kept, metadata } = partitionSchemaFieldNames(names);
  if (metadata.length === 0) return schema;
  if (kept.length === 0) return schema;
  const fields: OutputSchema['fields'] = {};
  for (const name of kept) fields[name] = schema.fields[name];
  return { ...schema, fields };
}
