import { describe, it, expect } from 'vitest';
import { openWriter } from '../src/tenancy/db.js';
import { migrate } from '../src/tenancy/migrate.js';
import { createTenant } from '../src/tenancy/tenants.js';
import { scopeFor } from '../src/tenancy/scope.js';

function setup() {
  const db = openWriter(':memory:');
  migrate(db, ':memory:');
  const { tenantId } = createTenant(db, { displayName: 'Acme Fleet' });
  const scope = scopeFor(db, tenantId);
  return { db, scope };
}

describe('ScopedCollectors.createDraft', () => {
  it('creates a draft, disabled row, absent from listConfirmed', () => {
    const { scope } = setup();

    const row = scope.collectors.createDraft({
      collectorId: 'c_acme1',
      name: 'Acme Catalog',
      canaryInputs: ['SKU-1001'],
    });

    expect(row.setup_state).toBe('draft');
    expect(row.enabled).toBe(0);
    expect(row.output_schema_json).toBeNull();
    expect(JSON.parse(row.canary_inputs_json)).toEqual(['SKU-1001']);
    expect(scope.collectors.listConfirmed()).toEqual([]);
    expect(scope.collectors.list()).toHaveLength(1);
  });

  it('is idempotent — re-running the wizard on the same collector refreshes name/canary inputs, not duplicates the row', () => {
    const { scope } = setup();
    scope.collectors.createDraft({ collectorId: 'c_1', name: 'First Name', canaryInputs: ['a'] });
    const second = scope.collectors.createDraft({ collectorId: 'c_1', name: 'Renamed', canaryInputs: ['b', 'c'] });

    expect(scope.collectors.list()).toHaveLength(1);
    expect(second.name).toBe('Renamed');
    expect(JSON.parse(second.canary_inputs_json)).toEqual(['b', 'c']);
  });
});

describe('ScopedCollectors.get', () => {
  it('returns the row for an existing collector, undefined otherwise', () => {
    const { scope } = setup();
    expect(scope.collectors.get('missing')).toBeUndefined();
    scope.collectors.createDraft({ collectorId: 'c_1', name: 'A', canaryInputs: ['x'] });
    expect(scope.collectors.get('c_1')?.collector_id).toBe('c_1');
  });
});

describe('ScopedCollectors.confirmSetup', () => {
  it('persists the schema/entity-key, flips to confirmed + enabled', () => {
    const { scope } = setup();
    scope.collectors.createDraft({ collectorId: 'c_1', name: 'Acme Catalog', canaryInputs: ['SKU-1001'] });

    const schemaJson = JSON.stringify({ fields: { sku: { type: 'text', required: true } } });
    const ruleJson = JSON.stringify({ kind: 'input_equals_field' });

    const row = scope.collectors.confirmSetup('c_1', {
      outputSchemaJson: schemaJson,
      entityKey: 'sku',
      entityKeyRuleJson: ruleJson,
    });

    expect(row.setup_state).toBe('confirmed');
    expect(row.enabled).toBe(1);
    expect(row.output_schema_json).toBe(schemaJson);
    expect(row.entity_key).toBe('sku');
    expect(row.entity_key_rule_json).toBe(ruleJson);

    // And it now shows up in listConfirmed.
    expect(scope.collectors.listConfirmed().map((r) => r.collector_id)).toEqual(['c_1']);
  });

  it('throws a clear error when confirming a collector with no draft row', () => {
    const { scope } = setup();
    expect(() =>
      scope.collectors.confirmSetup('never-created', {
        outputSchemaJson: '{}',
        entityKey: null,
        entityKeyRuleJson: null,
      })
    ).toThrow(/createDraft first/);
  });
});
