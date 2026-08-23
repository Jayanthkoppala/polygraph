#!/usr/bin/env tsx
/**
 * LIVE PROBE: what does Bright Data's `deliver: {type:"webhook"}` actually
 * put on the wire for a /dca collector?
 *
 * The audit (scratchpad/audits/brightdata.md §Webhook delivery) records the
 * generic Bright Data delivery contract — gzipped tar, `x-brd-delivery-id`
 * headers — but flags the dca specifics as UNCONFIRMED. This probe confirms
 * them without touching any non-disposable collector: it stands up a local
 * sink, exposes it through a short-lived `cloudflared` quick tunnel, points
 * a `polygraph-proof-*` collector at it, triggers one run, and records
 * exactly what arrives.
 *
 * Same safety contract as brightdata-autosave-proof.ts: only collectors this
 * script created are ever mutated, cleanup runs in `finally`, and the API key
 * is scrubbed from every artifact.
 *
 * Requires `cloudflared` on PATH. Exits 2 (skipped, not failed) without it.
 */
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { BrightDataClient } from '../../src/brightdata/client.js';

const TARGET_URL = 'https://news.ycombinator.com';
const PORT = 8787;
const DESCRIPTION =
  'Extract the stories on the Hacker News front page: title, url, points, author, comment_count.';

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

interface Hit {
  receivedAt: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  byteLength: number;
  /** Best-effort decode: gunzip if content-encoding says so, then show the
   * leading bytes so the payload FORMAT (tar member vs raw json) is visible. */
  decoded?: { encoding: string; preview: string; parsedRows?: unknown };
  decodeError?: string;
}

const hits: Hit[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Decodes a delivery payload far enough to identify its shape: gzip is
 * unwrapped, a tar is detected by its `ustar` magic at offset 257 and its
 * first member's content extracted (tar headers are fixed 512-byte blocks). */
function decode(buf: Buffer, encoding: string | undefined): Hit['decoded'] {
  let body = buf;
  let label = 'identity';
  if ((encoding ?? '').includes('gzip') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    body = gunzipSync(buf);
    label = 'gzip';
  }
  const isTar = body.length > 262 && body.subarray(257, 262).toString('ascii') === 'ustar';
  if (isTar) {
    label += '+tar';
    const size = parseInt(body.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const name = body.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const member = body.subarray(512, 512 + size).toString('utf8');
    let parsedRows: unknown;
    try {
      parsedRows = member.trim().startsWith('[')
        ? JSON.parse(member)
        : member.trim().split('\n').slice(0, 2).map((l) => JSON.parse(l));
    } catch {
      /* leave undefined — the preview still shows the shape */
    }
    return { encoding: `${label} (member "${name}", ${size}B)`, preview: member.slice(0, 1200), parsedRows };
  }
  return { encoding: label, preview: body.toString('utf8').slice(0, 1200) };
}

async function startTunnel(): Promise<{ url: string; kill: () => void }> {
  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloudflared did not print a URL within 60s')), 60_000);
    const scan = (chunk: Buffer): void => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', reject);
  });
  return { url, kill: () => proc.kill('SIGTERM') };
}

// ---------------------------------------------------------------------------
const client = new BrightDataClient();
const created: string[] = [];
let tunnel: { url: string; kill: () => void } | undefined;
const outcome: Record<string, unknown> = { probe: 'brightdata-dca-webhook-delivery' };

const server = createServer((req, res) => {
  void (async () => {
    const buf = await readBody(req);
    const hit: Hit = {
      receivedAt: new Date().toISOString(),
      method: req.method ?? '?',
      url: req.url ?? '?',
      headers: { ...req.headers },
      byteLength: buf.length,
    };
    try {
      hit.decoded = decode(buf, req.headers['content-encoding'] as string | undefined);
    } catch (e) {
      hit.decodeError = (e as Error).message;
    }
    hits.push(hit);
    log(`webhook hit: ${hit.method} ${hit.url} ${hit.byteLength}B ct=${req.headers['content-type']}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  })();
});

try {
  await new Promise<void>((r) => server.listen(PORT, r));
  log(`sink listening on :${PORT}`);

  tunnel = await startTunnel();
  log(`tunnel: ${tunnel.url}`);
  outcome.tunnel = tunnel.url;

  const name = `polygraph-proof-webhook-${Math.floor(Date.now() / 1000)}`;
  const collector = await client.createCollector({
    name,
    // NOTE: no `format` key — POST /dca/collector rejects deliver.format with
    // HTTP 400 {"validation_errors":["\"deliver.format\" is not allowed"]}
    // (verified 2026-08-23). `filename` is the accepted control.
    deliver: {
      type: 'webhook',
      endpoint: `${tunnel.url}/brd-hook`,
      filename: { template: 'data', extension: 'json' },
    },
  });
  created.push(collector.id);
  outcome.collectorId = collector.id;
  log(`created ${collector.id} (${name}) delivering to ${tunnel.url}/brd-hook`);

  log('generating template...');
  await client.automateTemplate(collector.id, { description: DESCRIPTION, urls: [TARGET_URL] });
  await client.pollAutomateTemplateProgress(collector.id, { intervalMs: 10_000, deadlineMs: 20 * 60_000 });

  log('triggering a run...');
  const jobId = await client.trigger(collector.id, [{ url: TARGET_URL }]);
  outcome.jobId = jobId;
  const dataset = await client.pollDataset(jobId, { intervalMs: 10_000, deadlineMs: 900_000 });
  outcome.rowCount = dataset.rows.length;

  // Delivery is asynchronous relative to the dataset going ready.
  const deadline = Date.now() + 180_000;
  while (hits.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
  }

  const jobLog = await client.jobLog(jobId);
  outcome.jobLog = { status: jobLog.status, lines: jobLog.lines, deliver_fails: jobLog.deliver_fails, template: jobLog.template };
  outcome.hitCount = hits.length;
  outcome.hits = hits;
  outcome.result = hits.length > 0 ? 'delivered' : 'NO DELIVERY OBSERVED within 180s of dataset ready';
  log(String(outcome.result));
} catch (err) {
  const body = (err as { body?: unknown }).body;
  outcome.error = (err as Error).message;
  outcome.errorStatus = (err as { status?: number }).status;
  outcome.errorBody = body;
  log(`FAILED: ${(err as Error).message}${body ? ` body=${JSON.stringify(body)}` : ''}`);
} finally {
  for (const id of created) {
    try {
      await client.deleteCollector(id);
      log(`deleted ${id}`);
      outcome[`deleted_${id}`] = true;
    } catch (e) {
      log(`!! FAILED to delete ${id}: ${(e as Error).message}`);
      outcome[`deleted_${id}`] = `FAILED: ${(e as Error).message}`;
    }
  }
  tunnel?.kill();
  server.close();
}

const outPath = fileURLToPath(new URL('../../docs/evidence/webhook-probe-2026-08-23.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(redact(outcome), null, 2), 'utf8');
log(`evidence written to ${outPath}`);
process.exit(hits.length > 0 ? 0 : 1);
