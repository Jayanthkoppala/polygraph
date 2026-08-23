import type Database from 'better-sqlite3';

/**
 * Which provider template version produced a delivery.
 *
 * `collector_deliveries` does not record one — the webhook payload carries no
 * template version, and Bright Data's job log is not something this server
 * polls. The one place a version IS known is a recovery cycle: it records the
 * template it found before the repair (`provider_template_before`, the
 * template the INCIDENT delivery came from) and the one the verification run
 * reported afterwards (`provider_template_after`, the template the
 * VERIFICATION delivery came from).
 *
 * So this is a deliberate join over exactly those two edges, and nothing else
 * is inferred: every other delivery reports `null`, which the table renders as
 * "—". Guessing that a later delivery "probably" came from the newest template
 * would put an unverified version number next to real row counts, which is the
 * one thing a results table must never do.
 */

interface TemplateEdge {
  incident_delivery_id: string | null;
  verification_delivery_id: string | null;
  provider_template_before: string | null;
  provider_template_after: string | null;
}

/** `delivery id → template version`, for one collector. Built in a single
 * query so a page of deliveries costs one extra read, not one per row. */
export function deliveryTemplates(
  db: Database.Database,
  tenantId: string,
  collectorId: string
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT incident_delivery_id, verification_delivery_id,
              provider_template_before, provider_template_after
         FROM recovery_cycles
        WHERE tenant_id = ? AND collector_id = ?`
    )
    .all(tenantId, collectorId) as TemplateEdge[];

  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.incident_delivery_id && row.provider_template_before) {
      out.set(row.incident_delivery_id, row.provider_template_before);
    }
    if (row.verification_delivery_id && row.provider_template_after) {
      out.set(row.verification_delivery_id, row.provider_template_after);
    }
  }
  return out;
}
