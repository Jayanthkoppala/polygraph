import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AlertNotifier, type AlertContext } from '../src/alerts.js';
import type { Evidence } from '../src/types.js';

function tempAlertsPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-alerts-test-'));
  return { dir, path: join(dir, 'polygraph.sqlite') };
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

const failedContractEvidence: Evidence[] = [
  { check: 'contract', ok: false, detail: 'fill rate 0.10 on required field "price"' },
  { check: 'coherence', ok: true, detail: 'no anomaly' },
];

function ctx(overrides: Partial<AlertContext> = {}): AlertContext {
  return {
    collector: 'acme-catalog',
    verdict: 'FAILED_CONTRACT',
    cause: 'STRUCTURAL',
    evidence: failedContractEvidence,
    ts: '2026-08-20T00:00:00.000Z',
    ledger_id: 42,
    ...overrides,
  };
}

const WEBHOOK = 'https://api.telegram.org/botSECRET_TOKEN_123/sendMessage';

describe('AlertNotifier — no-op / gating', () => {
  it('does nothing when webhookUrl is unset', async () => {
    const fetchImpl = vi.fn();
    const notifier = new AlertNotifier(':memory:', { fetchImpl });
    await notifier.notify(undefined, ctx());
    expect(fetchImpl).not.toHaveBeenCalled();
    notifier.close();
  });

  it('does not fire for a PASS verdict, even repeated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });
    await notifier.notify(WEBHOOK, ctx({ verdict: 'PASS', cause: 'NONE', evidence: [] }));
    await notifier.notify(WEBHOOK, ctx({ verdict: 'PASS', cause: 'NONE', evidence: [] }));
    expect(fetchImpl).not.toHaveBeenCalled();
    notifier.close();
  });

  it('does not fire for RECOVERY_PENDING', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl });
    await notifier.notify(WEBHOOK, ctx({ verdict: 'RECOVERY_PENDING', cause: 'STRUCTURAL', evidence: [] }));
    expect(fetchImpl).not.toHaveBeenCalled();
    notifier.close();
  });
});

describe('AlertNotifier — fires on transition-worthy verdicts', () => {
  const cases: Array<AlertContext['verdict']> = [
    'FAILED_CONTRACT',
    'FAILED_STRUCTURAL',
    'FAILED_IDENTITY',
    'FAILED_BLOCKED_RESPONSE',
    'SUSPECT_UNEXPLAINED_ANOMALY',
    'RECOVERY_VERIFIED',
    'RECOVERY_FAILED',
  ];

  it.each(cases)('fires for %s', async (verdict) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl });
    await notifier.notify(WEBHOOK, ctx({ verdict, collector: `col-${verdict}` }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('POSTs JSON with exactly {collector, verdict, cause, summary, ts, ledger_id}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl });
    await notifier.notify(WEBHOOK, ctx());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toMatch(/application\/json/);

    const payload = JSON.parse(init.body as string);
    expect(Object.keys(payload).sort()).toEqual(
      ['cause', 'collector', 'ledger_id', 'summary', 'ts', 'verdict'].sort()
    );
    expect(payload).toMatchObject({
      collector: 'acme-catalog',
      verdict: 'FAILED_CONTRACT',
      cause: 'STRUCTURAL',
      ts: '2026-08-20T00:00:00.000Z',
      ledger_id: 42,
    });
    expect(typeof payload.summary).toBe('string');
    expect(payload.summary.length).toBeGreaterThan(0);
    notifier.close();
  });

  it('never includes the webhook URL or any secret-looking token in the payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl });
    await notifier.notify(WEBHOOK, ctx());

    const [, init] = fetchImpl.mock.calls[0];
    const bodyStr = init.body as string;
    expect(bodyStr).not.toContain('SECRET_TOKEN_123');
    expect(bodyStr).not.toContain(WEBHOOK);
    notifier.close();
  });

  it('summary surfaces failed evidence details, not raw scraped rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl });
    await notifier.notify(
      WEBHOOK,
      ctx({
        evidence: [{ check: 'contract', ok: false, detail: 'fill rate 0.10 on required field "price"' }],
      })
    );
    const [, init] = fetchImpl.mock.calls[0];
    const payload = JSON.parse(init.body as string);
    expect(payload.summary).toContain('contract');
    expect(payload.summary).toContain('fill rate 0.10');
    notifier.close();
  });
});

describe('AlertNotifier — transition gate (state-shaped codes: PASS/FAILED_*/SUSPECT_*)', () => {
  it('(a) the same failed verdict repeated across many runs, hours apart, alerts exactly ONCE', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    for (let i = 0; i < 6; i++) {
      await notifier.notify(WEBHOOK, ctx());
      now = new Date(new Date(now).getTime() + 3 * 60 * 60_000).toISOString(); // +3h each cycle
    }

    // Well past any debounce window by the second call — a repeat verdict
    // must never re-alert no matter how much time has passed; only a real
    // state CHANGE can trigger another alert.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('(b) failed -> PASS -> the same failed verdict again fires TWO alerts (state reset)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });
    const advanceHours = (h: number) => {
      now = new Date(new Date(now).getTime() + h * 60 * 60_000).toISOString();
    };

    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' })); // 1st alert
    advanceHours(1);
    await notifier.notify(WEBHOOK, ctx({ verdict: 'PASS', cause: 'NONE', evidence: [] })); // recovers: resets state
    advanceHours(1);
    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' })); // fails again: 2nd alert

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });

  it('(c) failed verdict A then failed verdict B are distinct transitions — two alerts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });

    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' }));
    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_STRUCTURAL' }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });

  it('a collector stuck in a failed state does not re-alert every cycle for the same code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    for (let i = 0; i < 5; i++) {
      await notifier.notify(WEBHOOK, ctx());
      now = new Date(new Date(now).getTime() + 60_000).toISOString(); // +1 min each cycle
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('debounce is scoped per collector: a different collector with the same code fires independently', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });

    await notifier.notify(WEBHOOK, ctx({ collector: 'collector-a' }));
    await notifier.notify(WEBHOOK, ctx({ collector: 'collector-b' }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });
});

describe('AlertNotifier — debounce as a flap guard on top of the transition gate', () => {
  it('suppresses a second alert for the same collector+code within 10 minutes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    await notifier.notify(WEBHOOK, ctx());
    now = '2026-08-20T00:05:00.000Z'; // +5 min, still within debounce window
    await notifier.notify(WEBHOOK, ctx());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('(d) rapid repeat of a NEW verdict within 10 min is still capped by debounce, even though each swap is a real transition', async () => {
    // Oscillation: A fires -> B fires (a genuine transition away from A) ->
    // A again shortly after (a genuine transition away from B, structurally
    // identical to a fresh A) — the transition gate alone would fire on
    // every swap; the (collector, verdict) debounce is what actually caps
    // this kind of flapping.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' })); // fires, debounce(A) set @0m
    now = '2026-08-20T00:02:00.000Z';
    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_STRUCTURAL' })); // fires, debounce(B) set @2m
    now = '2026-08-20T00:04:00.000Z';
    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' })); // transition true, but debounce(A) is only 4m old -> suppressed

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });

  it('debounce is scoped per verdict code: the same collector transitioning to a different code fires independently', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });

    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' }));
    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_STRUCTURAL' }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });

  it('a failed delivery is not debounced — the next cycle retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    await notifier.notify(WEBHOOK, ctx());
    now = '2026-08-20T00:01:00.000Z'; // +1 min, well within the debounce window
    await notifier.notify(WEBHOOK, ctx());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });

  it('a failed delivery does not falsely record a transition either — state stays unset, so the very next cycle is still treated as a fresh transition', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });

    await notifier.notify(WEBHOOK, ctx()); // fails to deliver
    await notifier.notify(WEBHOOK, ctx()); // same verdict again -- still a "transition" since state was never recorded

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });
});

describe('AlertNotifier — RECOVERY_VERIFIED/RECOVERY_FAILED are event-shaped, not state-shaped', () => {
  it('fires on every occurrence (subject only to debounce), never suppressed by "same as last time"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    await notifier.notify(WEBHOOK, ctx({ verdict: 'RECOVERY_FAILED', evidence: [] }));
    now = '2026-08-20T00:11:00.000Z'; // past the 10-minute debounce window
    await notifier.notify(WEBHOOK, ctx({ verdict: 'RECOVERY_FAILED', evidence: [] }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });

  it('is still debounced within the window like before (unchanged behavior)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    let now = '2026-08-20T00:00:00.000Z';
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => now });

    await notifier.notify(WEBHOOK, ctx({ verdict: 'RECOVERY_VERIFIED', evidence: [] }));
    now = '2026-08-20T00:05:00.000Z';
    await notifier.notify(WEBHOOK, ctx({ verdict: 'RECOVERY_VERIFIED', evidence: [] }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('does not disturb the state-shaped transition gate for the same collector', async () => {
    // A RECOVERY_VERIFIED for a collector must not be mistaken for a PASS
    // state reset by the (unrelated) FAILED_*/SUSPECT_* transition gate.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(':memory:', { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });

    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' })); // 1st alert, state=FAILED_CONTRACT
    await notifier.notify(WEBHOOK, ctx({ verdict: 'RECOVERY_VERIFIED', evidence: [] })); // 2nd alert, event-shaped
    await notifier.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' })); // still the same recorded state -> suppressed

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    notifier.close();
  });
});

describe('AlertNotifier — never throws into the pipeline', () => {
  it('swallows a 404 response and logs it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not found' }));
    const onError = vi.fn();
    const notifier = new AlertNotifier(':memory:', { fetchImpl, onError });

    await expect(notifier.notify(WEBHOOK, ctx())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('swallows a garbage (non-JSON) 200 response body without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(200, 'not json at all {{{'));
    const notifier = new AlertNotifier(':memory:', { fetchImpl });

    await expect(notifier.notify(WEBHOOK, ctx())).resolves.toBeUndefined();
    notifier.close();
  });

  it('swallows a rejected fetch (network error) without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const onError = vi.fn();
    const notifier = new AlertNotifier(':memory:', { fetchImpl, onError });

    await expect(notifier.notify(WEBHOOK, ctx())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('times out a hanging notifier instead of stalling the fleet, and swallows the timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const onError = vi.fn();
    const notifier = new AlertNotifier(':memory:', { fetchImpl, onError, timeoutMs: 20 });

    const start = Date.now();
    await expect(notifier.notify(WEBHOOK, ctx())).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(onError).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it('never logs the webhook URL or a secret-looking token, even on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404));
    const onError = vi.fn();
    const notifier = new AlertNotifier(':memory:', { fetchImpl, onError });

    await notifier.notify(WEBHOOK, ctx());

    expect(onError).toHaveBeenCalledTimes(1);
    const loggedMessage = String(onError.mock.calls[0][0]);
    expect(loggedMessage).not.toContain('SECRET_TOKEN_123');
    expect(loggedMessage).not.toContain(WEBHOOK);
    notifier.close();
  });
});

describe('AlertNotifier — debounce persistence across instances (real file, not :memory:)', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it('a debounce recorded by one instance is honored by a second instance opened against the same file', async () => {
    const { dir, path } = tempAlertsPath();
    dirs.push(dir);

    const writerFetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const writer = new AlertNotifier(path, { fetchImpl: writerFetch, now: () => '2026-08-20T00:00:00.000Z' });
    await writer.notify(WEBHOOK, ctx());
    writer.close();

    const readerFetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const reader = new AlertNotifier(path, { fetchImpl: readerFetch, now: () => '2026-08-20T00:05:00.000Z' });
    await reader.notify(WEBHOOK, ctx());
    expect(readerFetch).not.toHaveBeenCalled();
    reader.close();
  });

  it('accepts an already-open better-sqlite3 Database, like Governor/Ledger do', async () => {
    const { dir, path } = tempAlertsPath();
    dirs.push(dir);
    const db = new Database(path);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(db, { fetchImpl });
    await notifier.notify(WEBHOOK, ctx());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notifier.close(); // must not close a Database it doesn't own
    db.close();
  });

  it('(e) the last-alerted verdict state survives a restart too — a second instance still suppresses a repeat, but recognizes a real transition', async () => {
    const { dir, path } = tempAlertsPath();
    dirs.push(dir);

    const writerFetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const writer = new AlertNotifier(path, { fetchImpl: writerFetch, now: () => '2026-08-20T00:00:00.000Z' });
    await writer.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' }));
    writer.close();

    // Second instance, same file, well past the debounce window: a repeat
    // of the SAME verdict must still be suppressed by the persisted state,
    // not just by (an already-expired) debounce timestamp.
    const readerFetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const reader = new AlertNotifier(path, { fetchImpl: readerFetch, now: () => '2026-08-20T03:00:00.000Z' });
    await reader.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' }));
    expect(readerFetch).not.toHaveBeenCalled();

    // A genuine transition (via PASS, hours later) is still recognized
    // across the restart -- the persisted state, not just the debounce
    // table, carries over.
    await reader.notify(WEBHOOK, ctx({ verdict: 'PASS', cause: 'NONE', evidence: [] }));
    const thirdFetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const reader2 = new AlertNotifier(path, { fetchImpl: thirdFetch, now: () => '2026-08-20T06:00:00.000Z' });
    await reader2.notify(WEBHOOK, ctx({ verdict: 'FAILED_CONTRACT' }));
    expect(thirdFetch).toHaveBeenCalledTimes(1);

    reader.close();
    reader2.close();
  });
});

describe('AlertNotifier — tenant scoping (Task 1: polygraph-v2-hosted-plan)', () => {
  it("defaults to tenantId 'local' when no options are passed — pre-tenancy call sites keep working unchanged", async () => {
    const db = new Database(':memory:');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = new AlertNotifier(db, { fetchImpl, now: () => '2026-08-20T00:00:00.000Z' });

    await notifier.notify(WEBHOOK, ctx());
    const row = db.prepare('SELECT tenant_id FROM alert_state WHERE collector = ?').get('acme-catalog') as {
      tenant_id: string;
    };
    expect(row.tenant_id).toBe('local');
    db.close();
  });

  it("one tenant's alert history (state + debounce) is fully invisible to another tenant sharing the same collector name and verdict", async () => {
    const db = new Database(':memory:');
    const fetchA = vi.fn().mockResolvedValue(jsonResponse(200));
    const fetchB = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifierA = new AlertNotifier(db, { fetchImpl: fetchA, tenantId: 'tenant-a', now: () => '2026-08-20T00:00:00.000Z' });
    const notifierB = new AlertNotifier(db, { fetchImpl: fetchB, tenantId: 'tenant-b', now: () => '2026-08-20T00:00:05.000Z' });

    // Tenant A alerts and gets debounced on a repeat within 10 minutes.
    await notifierA.notify(WEBHOOK, ctx({ collector: 'shared-collector', verdict: 'FAILED_CONTRACT' }));
    expect(fetchA).toHaveBeenCalledTimes(1);
    await notifierA.notify(WEBHOOK, ctx({ collector: 'shared-collector', verdict: 'FAILED_CONTRACT' }));
    expect(fetchA).toHaveBeenCalledTimes(1); // steady-state repeat, no re-alert

    // Tenant B, same collector name, same verdict, same physical tables —
    // must alert on its OWN first transition, completely unaffected by A's
    // debounce/state rows.
    await notifierB.notify(WEBHOOK, ctx({ collector: 'shared-collector', verdict: 'FAILED_CONTRACT' }));
    expect(fetchB).toHaveBeenCalledTimes(1);

    db.close();
  });
});
