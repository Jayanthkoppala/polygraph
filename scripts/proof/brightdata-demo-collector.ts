#!/usr/bin/env tsx
/**
 * Builds a WORKING demo collector and proves it works before handing it over.
 *
 * Why this exists: `output_schema` being populated does NOT mean extraction
 * works. Bright Data's `output_schema_generator` derives the field list from
 * the INTENT (the description you supplied), not from what the generated code
 * actually pulls off the page. Two collectors built on 2026-08-23 had a
 * perfect-looking schema (title/url/points/author/comment_count all active)
 * and still returned rows containing nothing but `{"input":{...}}` — every
 * extracted field came back null, and null fields are omitted from the NDJSON
 * payload. Their `automate_template/progress` was byte-identical to that of
 * two collectors built minutes earlier that worked fine:
 *   status "done", step "collector_mainatiner", completed_steps
 *   [prepare_intent_analyzer, planner, discovery, collector_mainatiner,
 *    output_schema_generator, code_generator, input_schema_generator,
 *    preview_runner, preview_picker]
 * So there is no progress-envelope signal that separates a good build from a
 * bad one. Generation is non-deterministic and can silently produce selectors
 * that match nothing.
 *
 * The only reliable acceptance test is therefore an END-TO-END one: trigger
 * the collector and check that real rows come back with real values in them.
 * This script does exactly that, and retries with a fresh collector when a
 * build comes out empty, deleting each failed attempt as it goes.
 *
 * The collector that passes is deliberately NOT deleted — it is the artifact.
 *
 * Usage: tsx scripts/proof/brightdata-demo-collector.ts [--attempts N] [--name-prefix P]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BrightDataClient, type BrightDataError } from '../../src/brightdata/client.js';

const TARGET_URL = 'https://news.ycombinator.com';
const GENERATION_DESCRIPTION =
  'Extract the stories on the Hacker News front page. For each story capture ' +
  'the title as title, the link as url, the score as points, the submitter as ' +
  'author, and the number of comments as comment_count.';

/** Fields that must be genuinely populated for the build to count as working. */
const REQUIRED_POPULATED = ['title', 'points'];
/** At least this share of rows must carry the required fields. */
const MIN_POPULATED_RATIO = 0.5;

const argv = process.argv;
const attempts = Number(argv[argv.indexOf('--attempts') + 1]) || 3;
const namePrefix = argv.includes('--name-prefix') ? argv[argv.indexOf('--name-prefix') + 1] : 'polygraph-demo';

const client = new BrightDataClient();
const SECRET = (process.env.BRIGHTDATA_API_KEY ?? '').trim();
function redact<T>(v: T): T {
  let t = JSON.stringify(v, null, 2) ?? 'null';
  if (SECRET.length >= 8) t = t.split(SECRET).join('<REDACTED_API_KEY>');
  t = t.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED_API_KEY>');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<REDACTED_EMAIL>');
  return JSON.parse(t) as T;
}

function log(m: string): void {
  console.log(`[${new Date().toISOString()}] ${m}`);
}

/** Ids created by THIS run — the only ones this script will ever delete. */
const createdHere: string[] = [];
function assertOurs(id: string): void {
  if (!createdHere.includes(id)) {
    throw new Error(`REFUSING to delete ${id}: not created by this run (${createdHere.join(', ') || 'none'})`);
  }
}

interface AttemptRecord {
  attempt: number;
  collectorId: string;
  name: string;
  jobId?: string;
  template?: string;
  rowCount?: number;
  populatedRows?: number;
  fields?: string[];
  sampleRow?: Record<string, unknown>;
  accepted: boolean;
  reason?: string;
  deleted?: boolean;
}
const record: AttemptRecord[] = [];

/** A row "counts" only if every required field is present AND non-null/non-empty. */
function isPopulated(row: Record<string, unknown>): boolean {
  return REQUIRED_POPULATED.every((f) => {
    const v = row[f];
    return v !== undefined && v !== null && v !== '';
  });
}

let winner: AttemptRecord | undefined;

for (let n = 1; n <= attempts && !winner; n += 1) {
  const name = `${namePrefix}-${Math.floor(Date.now() / 1000)}`;
  log(`--- attempt ${n}/${attempts}: creating "${name}"`);
  const created = await client.createCollector({ name, deliver: { type: 'api_pull' } });
  createdHere.push(created.id);
  const entry: AttemptRecord = { attempt: n, collectorId: created.id, name, accepted: false };
  record.push(entry);
  log(`    collector ${created.id}`);

  try {
    await client.automateTemplate(created.id, { description: GENERATION_DESCRIPTION, urls: [TARGET_URL] });
    const gen = await client.pollAutomateTemplateProgress(created.id, {
      intervalMs: 10_000,
      deadlineMs: 20 * 60_000,
    });
    log(`    generation ${gen.status}, steps=${(gen.completed_steps ?? []).length}`);

    // THE acceptance test: a real run, with real values in the rows.
    const jobId = await client.trigger(created.id, [{ url: TARGET_URL }]);
    entry.jobId = jobId;
    log(`    triggered ${jobId}, waiting for the dataset...`);
    const dataset = await client.pollDataset(jobId, { intervalMs: 10_000, deadlineMs: 900_000 });
    const jobLog = await client.jobLog(jobId);
    entry.template = jobLog.template;
    entry.rowCount = dataset.rows.length;

    const fields = new Set<string>();
    for (const row of dataset.rows) for (const k of Object.keys(row)) fields.add(k);
    entry.fields = [...fields].sort();
    entry.sampleRow = dataset.rows[0];
    const populated = dataset.rows.filter(isPopulated).length;
    entry.populatedRows = populated;

    const ratio = dataset.rows.length === 0 ? 0 : populated / dataset.rows.length;
    log(
      `    rows=${dataset.rows.length} populated=${populated} (${Math.round(ratio * 100)}%) ` +
        `fields=${entry.fields.join(',')}`
    );
    log(`    sample row: ${JSON.stringify(dataset.rows[0])?.slice(0, 240)}`);

    if (dataset.rows.length > 0 && ratio >= MIN_POPULATED_RATIO) {
      entry.accepted = true;
      winner = entry;
      log(`    ACCEPTED — ${created.id} extracts real data.`);
    } else {
      entry.reason =
        dataset.rows.length === 0
          ? 'dataset came back empty'
          : `only ${populated}/${dataset.rows.length} rows had ${REQUIRED_POPULATED.join(' + ')} populated ` +
            `(this is the silent bad-build case: schema looks right, extraction returns nulls)`;
      log(`    REJECTED — ${entry.reason}`);
    }
  } catch (err) {
    entry.reason = `${(err as Error).message}${
      (err as BrightDataError).body ? ` body=${JSON.stringify((err as BrightDataError).body)}` : ''
    }`;
    log(`    REJECTED — ${entry.reason}`);
  }

  if (!entry.accepted) {
    try {
      assertOurs(created.id);
      await client.deleteCollector(created.id);
      entry.deleted = true;
      log(`    deleted failed attempt ${created.id}`);
    } catch (e) {
      entry.deleted = false;
      log(`    !! could not delete ${created.id}: ${(e as Error).message}`);
    }
  }
}

const outcome = redact({
  purpose: 'working demo collector for the production demo',
  finishedAt: new Date().toISOString(),
  targetUrl: TARGET_URL,
  acceptance: {
    requiredPopulatedFields: REQUIRED_POPULATED,
    minPopulatedRatio: MIN_POPULATED_RATIO,
    rationale:
      'output_schema is generated from the intent, not from what the code extracts, so a ' +
      'populated schema does not prove extraction works. Only a real triggered run does.',
  },
  winner: winner ?? null,
  attempts: record,
});
const outPath = fileURLToPath(new URL('../../docs/evidence/demo-collector-2026-08-23.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(outcome, null, 2), 'utf8');

if (winner) {
  log(`\n=== SUCCESS ===`);
  log(`collector: ${winner.collectorId}`);
  log(`name:      ${winner.name}`);
  log(`job:       ${winner.jobId}`);
  log(`template:  ${winner.template}`);
  log(`rows:      ${winner.rowCount} (${winner.populatedRows} fully populated)`);
  log(`fields:    ${winner.fields?.join(', ')}`);
  log(`NOT deleted — this is the deliverable.`);
} else {
  log(`\n=== FAILED after ${attempts} attempts — every build extracted nothing. ===`);
  log(`All attempt collectors were deleted. See ${outPath}`);
}
log(`evidence: ${outPath}`);
process.exit(winner ? 0 : 1);
