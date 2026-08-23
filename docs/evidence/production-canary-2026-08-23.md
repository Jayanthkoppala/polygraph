# Production canary — 2026-08-23

The first end-to-end run of the autonomous repair loop on the production
instance (`https://35.193.31.253.sslip.io`, build `3f0a8e0`), through the
product's own path: webhook ingest → checks → worker → Bright Data
Self-Healing → `auto_save` → fresh verification run → repair receipt.

This is distinct from [`autosave-proof-2026-08-23.md`](./autosave-proof-2026-08-23.md),
which is a controlled two-arm experiment on disposable collectors that proves
the `auto_save` primitive in isolation. The canary exercises the shipped loop
on a live tenant.

| | |
|---|---|
| Tenant | `browser-828af752` |
| Collector | `polygraph-demo-1787483366` (`c_mt5pg1nc278ge4iitq`) |
| Baseline | `delivery_b713b21d…` — 60 rows, HEALTHY, 19:04:06 IST |
| Break | `j_drift_points_1787492200` — 60 rows with `points` removed, verdict WRONG SHAPE (`FAILED_STRUCTURAL`), 19:06:42 |
| Repair started | 19:06:47 (+5.4 s after detection) |
| Bright Data heal job | `ia_mt5upiht11tnb3mkrh`, accepted 19:06:47 |
| Template | `—` → `t_mt5pk4na23pzcvwrz0.2` (published via `auto_save`) |
| Verification run | `j_mt5v9w2bme1gfqizp` — 31 rows, HEALTHY, promoted to new baseline, 19:23:04 |
| Receipt | `#985f5e71…908dd8`, ledger entry #67, result VERIFIED |
| Detected → verified | **16 min 22 s** |

Screenshots of the `/app` workspace taken at 19:26 IST, after the cycle closed:

- [`production-canary-2026-08-23-receipt.jpg`](./production-canary-2026-08-23-receipt.jpg) — the receipt row expanded: detected / what Polygraph did / verified.
- [`production-canary-2026-08-23-receipt-timeline.jpg`](./production-canary-2026-08-23-receipt-timeline.jpg) — the tail of the timeline with the total.

Where the raw records live: the tenant's `recovery_cycles`, `repair_receipts`
and ledger rows on the production database. They are per-tenant and are not
exported here; the receipt hash and ledger sequence number above are enough to
locate them with `ledger verify`.
