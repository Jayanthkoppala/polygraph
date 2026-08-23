import { describe, it, expect } from 'vitest';
import {
  PROVIDER_METADATA_FIELDS,
  SCHEMA_METADATA_FIELDS,
  effectiveSchema,
  isSchemaMetadataField,
  partitionSchemaFieldNames,
} from '../../../src/tenancy/provider-metadata.js';
import { loadRunnerOverridesFor, buildConfirmedSchema } from '../../../src/tenancy/onboarding.js';
import { requiredFields, isStructurallyEmpty } from '../../../src/tenancy/recovery/policy.js';
import { checkContract } from '../../../src/evidence/checks/contract.js';
import { stripProviderMetadata } from '../../../src/tenancy/delivery-store.js';
import type { OutputSchema } from '../../../src/core/types.js';
import {
  LEGACY_CONNECT_SCHEMA,
  REAL_FIELDS,
  METADATA_FIELDS,
  healthyHackerNewsRows,
} from './provider-metadata-fixtures.js';

/** The legacy schema stores its fields alphabetically; compare as a set. */
const REAL_FIELDS_SORTED = [...REAL_FIELDS].sort();

describe('provider metadata field lists', () => {
  it('covers all 18 Bright Data delivery-wrapper fields a connected collector can inherit', () => {
    for (const name of METADATA_FIELDS) expect(isSchemaMetadataField(name)).toBe(true);
    expect(SCHEMA_METADATA_FIELDS.size).toBe(18);
  });

  it('keeps `input` out of graded schemas but IN the row-stripping exemption', () => {
    // `input` is the echoed run input: needed in rows for verification reuse
    // (extractReusableVerificationInput), never a field to grade.
    expect(PROVIDER_METADATA_FIELDS.has('input')).toBe(false);
    expect(SCHEMA_METADATA_FIELDS.has('input')).toBe(true);
  });

  it('partitions field names while preserving order on both sides', () => {
    expect(partitionSchemaFieldNames(['title', 'timestamp', 'url', 'input', 'points'])).toEqual({
      kept: ['title', 'url', 'points'],
      metadata: ['timestamp', 'input'],
    });
  });
});

describe('effectiveSchema', () => {
  it('removes every metadata field from a legacy 23-field connect schema', () => {
    const effective = effectiveSchema(LEGACY_CONNECT_SCHEMA);
    expect(Object.keys(effective.fields).sort()).toEqual(REAL_FIELDS_SORTED);
    for (const name of REAL_FIELDS) {
      expect(effective.fields[name]).toEqual({ type: 'text', required: true });
    }
  });

  it('returns the same object when there is nothing to remove', () => {
    const schema: OutputSchema = { fields: { sku: { type: 'text', required: true } } };
    expect(effectiveSchema(schema)).toBe(schema);
  });

  it('leaves a metadata-ONLY schema unchanged rather than grading everything green', () => {
    const schema: OutputSchema = {
      fields: { timestamp: { type: 'text', required: true }, error: { type: 'text', required: true } },
    };
    // Emptying it would make requiredViolationRate 0 for every delivery. The
    // broken setup stays visible instead — the same rule migration 017 uses.
    expect(effectiveSchema(schema)).toBe(schema);
  });

  it('passes undefined through for a collector with no declared schema', () => {
    expect(effectiveSchema(undefined)).toBeUndefined();
  });
});

describe('the grading paths that read a stored schema', () => {
  it('loadRunnerOverridesFor filters an already-connected collector at load time (no migration needed)', () => {
    const overrides = loadRunnerOverridesFor({
      output_schema_json: JSON.stringify(LEGACY_CONNECT_SCHEMA),
      entity_key_rule_json: null,
    });
    expect(Object.keys(overrides.schema!.fields).sort()).toEqual(REAL_FIELDS_SORTED);
  });

  it('bootstrap requiredFields ignores metadata, and the graded contract passes on a healthy delivery', () => {
    const schema = loadRunnerOverridesFor({
      output_schema_json: JSON.stringify(LEGACY_CONNECT_SCHEMA),
      entity_key_rule_json: null,
    }).schema!;
    expect(requiredFields(schema).sort()).toEqual(REAL_FIELDS_SORTED);

    // Rows as the grader sees them: ingest has already stripped the wrapper
    // fields, which is precisely why the legacy schema's 18 extra "required"
    // fields were 0% filled by construction.
    const rows = stripProviderMetadata(healthyHackerNewsRows(60));
    const run = { collector: 'c_legacy', run_id: 'r1', rows };

    const legacy = checkContract(run, LEGACY_CONNECT_SCHEMA);
    expect(legacy.ok).toBe(false);
    expect((legacy.metrics as { requiredViolationRate: number }).requiredViolationRate).toBe(1);

    const fixed = checkContract(run, schema);
    expect(fixed.ok).toBe(true);
    expect((fixed.metrics as { requiredViolationRate: number }).requiredViolationRate).toBe(0);

    // And a genuinely full delivery is never "structurally empty" for bootstrap.
    expect(isStructurallyEmpty(schema, rows)).toBe(false);
  });

  it('buildConfirmedSchema refuses to put a wrapper field into a confirmed contract', () => {
    const schema = buildConfirmedSchema([
      { name: 'title', type: 'text', required: true },
      { name: 'html', type: 'text', required: true },
      { name: 'input', type: 'text', required: true },
    ]);
    expect(Object.keys(schema.fields)).toEqual(['title']);
  });
});
