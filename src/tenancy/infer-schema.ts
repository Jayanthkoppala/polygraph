/**
 * Step 1 (INFER) of onboarding, per tenant-architecture.md §4. Bright
 * Data's `GET /dca/collectors_list` `output_schema` field shape is NOT
 * documented — the docs corpus confirms the field exists ("the output
 * schema when available") but publishes no example response body and no
 * field-level schema for it (grep hits exactly two prose mentions, zero
 * examples). This module accepts the shapes it plausibly takes and
 * degrades to an empty field list for anything else.
 *
 * NEVER throws: an unrecognised shape must degrade to "the probe (step 2)
 * will figure it out", never to a crash on the onboarding wizard. Every
 * function here is pure — no network — so it's directly unit-testable and
 * reusable against a `collectors_list` response cached from key-save-time
 * verification (see `key-verification.ts`) without a second network call.
 */

import { partitionSchemaFieldNames } from './provider-metadata.js';

/** Bright Data's own id field name is unconfirmed too (docs show `id` in
 * examples, but the delete-scraper page notes "this ID may also be
 * referred to as `collector_id`") — tolerate both rather than assuming one. */
function collectorIdOf(entry: Record<string, unknown>): string | undefined {
  const id = entry.id ?? entry.collector_id;
  return typeof id === 'string' ? id : undefined;
}

/** Bright Data currently returns collectors as a paginated
 * `{total, offset, limit, data: [...]}` envelope. Older responses and tests
 * use the bare array, so accept both without trusting any other object shape. */
function collectorEntriesOf(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  const data = (response as Record<string, unknown>).data;
  return Array.isArray(data) ? data : [];
}

/** Finds the `collectors_list` entry matching `collectorId`. Accepts both a
 * bare array and Bright Data's paginated `{data: [...]}` envelope; returns
 * `undefined` for every other shape and never throws. */
export function findCollectorListEntry(
  collectorsListResponse: unknown,
  collectorId: string
): Record<string, unknown> | undefined {
  for (const entry of collectorEntriesOf(collectorsListResponse)) {
    if (!entry || typeof entry !== 'object') continue;
    if (collectorIdOf(entry as Record<string, unknown>) === collectorId) {
      return entry as Record<string, unknown>;
    }
  }
  return undefined;
}

function collectorNameOf(entry: Record<string, unknown>): string | undefined {
  const name = entry.name;
  return typeof name === 'string' ? name : undefined;
}

export interface CollectorSummary {
  id: string;
  name?: string;
}

/**
 * A defensive, minimal `{id, name}[]` view of a WHOLE `collectors_list`
 * response — for a caller that wants "Connected. Found N collectors." right
 * away (the settings/key save route reuses the SAME response
 * `saveVerifiedTenantKey`'s verification call already fetched, per §2 step
 * 2 — "this doubles as step 1 of onboarding... no extra request") without
 * assuming anything about `output_schema`'s shape at all. An entry with no
 * recognisable id is skipped rather than aborting the whole list — same
 * "never throws, degrade instead" posture as the rest of this module.
 */
export function summarizeCollectorsList(collectorsListResponse: unknown): CollectorSummary[] {
  const out: CollectorSummary[] = [];
  for (const entry of collectorEntriesOf(collectorsListResponse)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = collectorIdOf(entry as Record<string, unknown>);
    if (!id) continue;
    const name = collectorNameOf(entry as Record<string, unknown>);
    out.push(name ? { id, name } : { id });
  }
  return out;
}

/**
 * Parses an `output_schema` value into field names. Accepts four
 * observed/plausible encodings and returns `[]` for anything else:
 *   - an array: `[{name: "sku", ...}, ...]` or `["sku", "title"]`
 *   - Bright Data's live wrapper: `{type: "object", fields: {sku: {...}}}`
 *   - a JSON-Schema-ish object: `{properties: {sku: {...}, ...}}`
 *   - a flat map: `{sku: "text", price: "number"}`
 */
export function fieldNamesFromOutputSchema(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
          return (entry as Record<string, unknown>).name as string;
        }
        return null;
      })
      .filter((name): name is string => !!name);
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, 'fields')) {
      const fields = obj.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
      return Object.keys(fields as object);
    }
    if (obj.properties && typeof obj.properties === 'object') {
      return Object.keys(obj.properties as object);
    }
    return Object.keys(obj);
  }
  return [];
}

/** Bright Data's published `output_schema` types, mapped onto the vocabulary
 * `inferType` already emits for probed fields. `FieldSchema.type` has no
 * closed enum — nothing in contract.ts/coherence.ts branches on it — so this
 * is a convention for the confirm-step UI and the recovery repair brief, not
 * a validated domain. Anything unrecognised degrades to `'text'`, which is
 * also what `inferType` falls back to. */
const BRIGHTDATA_TYPE_MAP: Readonly<Record<string, string>> = {
  text: 'text',
  string: 'text',
  str: 'text',
  html: 'text',
  number: 'number',
  integer: 'number',
  int: 'number',
  float: 'number',
  double: 'number',
  decimal: 'number',
  price: 'number',
  currency: 'number',
  boolean: 'boolean',
  bool: 'boolean',
  url: 'url',
  link: 'url',
  uri: 'url',
  image: 'url',
  image_url: 'url',
  date: 'date',
  datetime: 'date',
  timestamp: 'date',
  array: 'array',
  list: 'array',
  object: 'object',
  dict: 'object',
  map: 'object',
};

/** Maps one raw Bright Data type token to ours; `'text'` for anything else,
 * including a missing/non-string type. */
export function mapOutputSchemaType(raw: unknown): string {
  if (typeof raw !== 'string') return 'text';
  return BRIGHTDATA_TYPE_MAP[raw.trim().toLowerCase()] ?? 'text';
}

export interface InferredField {
  name: string;
  /** Mapped through `mapOutputSchemaType`; `'text'` when Bright Data
   * published no type for the field. */
  type: string;
}

function typeOfEntry(entry: unknown): string {
  if (typeof entry === 'string') return mapOutputSchemaType(entry);
  if (entry && typeof entry === 'object') return mapOutputSchemaType((entry as Record<string, unknown>).type);
  return 'text';
}

/**
 * `fieldNamesFromOutputSchema` with the declared type carried along, for the
 * connect path that persists a real `OutputSchema` rather than only
 * pre-filling a wizard. Accepts the same four encodings and is equally
 * total — a field whose type is missing or unrecognised is `'text'`, never
 * an error.
 */
export function fieldsFromOutputSchema(raw: unknown): InferredField[] {
  const names = fieldNamesFromOutputSchema(raw);
  if (names.length === 0) return [];

  const typeFor = (name: string): string => {
    if (Array.isArray(raw)) {
      const entry = raw.find(
        (e) => e && typeof e === 'object' && (e as Record<string, unknown>).name === name
      );
      return entry === undefined ? 'text' : typeOfEntry(entry);
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const container = (Object.prototype.hasOwnProperty.call(obj, 'fields') ? obj.fields : obj.properties) ?? obj;
      if (container && typeof container === 'object') {
        return typeOfEntry((container as Record<string, unknown>)[name]);
      }
    }
    return 'text';
  };

  return names.map((name) => ({ name, type: typeFor(name) }));
}

interface InferredSchema {
  /** Field names recognised from `output_schema` — [] when absent, present
   * but empty, or an unrecognised shape. Types/required/default_value are
   * NEVER derivable here (§4: "Inference alone is therefore insufficient
   * by design") — only names, to pre-fill the wizard. The probe (step 2)
   * is the actual source of truth. */
  fieldNames: string[];
  /** The same fields with their mapped types — what the connect route turns
   * into the persisted `OutputSchema`. Same exclusion as `fieldNames`. */
  fields: InferredField[];
  /** Wrapper field names that WERE published in `output_schema` and were
   * excluded — Bright Data's own delivery bookkeeping, never scraped
   * content. Surfaced so the wizard/logs can say why a 23-field collector
   * shows 5 fields, rather than looking like a parse failure. */
  metadataFieldNames: string[];
  /** A collectors_list entry matching this collector id was found at all. */
  found: boolean;
  /** The matched entry carried a non-null/undefined `output_schema`
   * (distinguishes "genuinely nothing published" from "collector not in
   * this account's list" — both currently degrade to the same empty
   * `fieldNames`, kept separate for callers that want to log/observe the
   * distinction). */
  hasOutputSchema: boolean;
}

/** Combines `findCollectorListEntry` + `fieldNamesFromOutputSchema` against
 * an already-fetched `GET /dca/collectors_list` response body — reused
 * directly from key-save-time verification per §4 ("already called at
 * key-save time — reuse that response, no extra request"). Never throws. */
export function inferFieldsForCollector(collectorsListResponse: unknown, collectorId: string): InferredSchema {
  const empty = { fieldNames: [], fields: [], metadataFieldNames: [] };
  const entry = findCollectorListEntry(collectorsListResponse, collectorId);
  if (!entry) return { ...empty, found: false, hasOutputSchema: false };

  const raw = entry.output_schema;
  if (raw === undefined || raw === null) return { ...empty, found: true, hasOutputSchema: false };

  // Bright Data publishes its delivery wrapper's own fields (timestamp,
  // status_code, error, html, ...) inside `output_schema` alongside the
  // scraped ones. Ingest strips them from every row, so keeping them here
  // would build a contract on fields that are 0% filled by construction.
  const parsed = fieldsFromOutputSchema(raw);
  const { kept, metadata } = partitionSchemaFieldNames(parsed.map((f) => f.name));
  const keptSet = new Set(kept);
  return {
    fieldNames: kept,
    fields: parsed.filter((f) => keptSet.has(f.name)),
    metadataFieldNames: metadata,
    found: true,
    hasOutputSchema: true,
  };
}

/**
 * Infers a field's `OutputSchema.type` from a set of observed values
 * (probe step, §4's `inferType`). Defensive over an empty/all-empty value
 * set — falls back to `'text'`. `FieldSchema.type` (types.ts) has no closed
 * enum — `contract.ts`/`coherence.ts` never branch on its value — so
 * `'price'`/`'url'`/`'text'` are conventions for the confirm-step UI, not
 * validated elsewhere in the pipeline.
 */
export function inferType(values: unknown[]): string {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonEmpty.length === 0) return 'text';
  if (nonEmpty.every((v) => typeof v === 'number')) return 'price';
  if (nonEmpty.every((v) => typeof v === 'string' && /^https?:\/\//.test(v))) return 'url';
  return 'text';
}
