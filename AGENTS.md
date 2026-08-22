# Working on Polygraph

Read this before changing anything. It records the layout, the house rules, and the
traps that have already cost real debugging time here.

## Layout

Flat files at `src/` root are **entry points**. Everything else is a folder named for
what it does.

```
src/index.ts       CLI entry — builds the program, registers commands
src/mcp.ts         coding-agent tool surface
src/cli/           one module per command; each exports register(program)
src/core/          types, config, error classification — no I/O
src/evidence/      the four checks, adapters, extractors
src/brightdata/    the only outbound Bright Data client, plus heal
src/loop/          runner, policy governor, alerts
src/store/         hash-chained ledger, safe-output retention
src/http/          the offline dashboard server
src/tenancy/       multi-tenant isolation, auth, key custody, scheduler
src/tenancy/routes/  public / session route groups + shared context
src/fixture/       the local break lab
src/demo/          the live V1 -> V2 mission
scripts/test/      backend suite, mirroring src/ exactly
app/src/           React front end — shipped code only
app/tests/         front-end suite, mirroring app/src/
deploy/            how the live instance runs
```

**Tests mirror the source path.** A test for `src/loop/policy.ts` lives at
`scripts/test/loop/policy.test.ts`. No test file belongs beside the code it covers.

Front-end tests live in `app/tests/`, **not** `scripts/test/`. Hoisting them out of the
`app` package makes Node resolve `react` from the repo root — a second React copy, and
hooks break. They are typechecked via `app/tsconfig.test.json`; if you move them again,
keep that include list correct or they silently stop being checked.

## House rules

- **Comments are 1–2 lines.** Say the non-obvious thing — a constraint, a trap, a spec
  section — and stop. If a comment only restates the code, delete it. Never delete a
  warning about a real trap; compress it.
- **Commands are 1–2 lines.** In npm scripts, docs and configs alike. No multi-line
  shell continuations.
- **Node 22+.** `better-sqlite3` is native; on Node 20 the whole suite fails with a
  misleading ABI error. `engines` enforces it.

## Definition of done

Green tests are not enough. Before calling any change complete:

```bash
npm run test && npm --prefix app run test
npm run typecheck:all && npm run build:all
```

Then **boot the thing**: `npm run demo`, open `http://127.0.0.1:4141`, and confirm the
real React app renders — not the "app hasn't been built" notice. See trap 1.

## Traps that have already bitten

1. **Path resolution relative to module depth.** `src/http/server.ts` resolves
   `../../app/dist`. Moving a module deeper silently breaks this, and *no test catches
   it* because every test injects `appDir`. This shipped once: `polygraph demo` served
   the "not built" notice while 651 tests passed. Boot the app.
2. **`tsc` never cleans `dist/`.** A rename leaves the old output next to the new, and
   `package.json` ships `dist/`. `npm run build` clears it first — keep it that way.
3. **A dependency-injected test proves nothing about the default.** If a function has a
   fallback path, test the fallback explicitly.
4. **Deleting UI needs proof, not grep.** Build the previous commit in a worktree and
   compare bundle sizes. Removing 1,858 lines of genuinely dead components moved the
   bundle 340 bytes; anything rendered moves it by tens of kB.
5. **Deleting CSS rules needs the reverse check.** Extract every class referenced in
   JSX and confirm each still has a rule.

## Do not

- **Do not convert the four structural stylesheets to Tailwind** —
  `app/src/landing/MissionExperience.css`, `app/src/components/GlobalChrome.css`,
  `app/src/onboarding/ConnectionShell.css`, `app/src/onboarding/steps/GoogleAuthStep.css`. They are structural CSS using descendant
  selectors and custom properties; as utility strings they would bloat the JSX and risk
  visual regressions. Small canvas-container stylesheets were folded in and deleted —
  that was the whole of that job.
- **Do not reintroduce Fly.io or Vercel config.** Both were removed as dead. The live
  deployment is a Google Cloud VM behind Caddy; `deploy/README.md` is authoritative.
- **Do not run two server instances.** SQLite on the VM's disk means exactly one,
  always running, or the ledger forks into two divergent hash chains.
- **Do not create a new Bright Data collector** for a task an existing one covers. See
  the pin in `CLAUDE.md`; six dead collectors already exist from doing this.
- **Do not weaken or delete a test to make a change pass.**

## Claims and evidence

This is a verification product, so its own documentation is held to the same standard.
Do not state that something works because a doc says so — check the code or the running
system. The README claimed multi-tenancy was "built, not live" while a live instance was
enforcing auth, and repeated a heal-detection claim the project's own plan calls a
load-bearing error. External claims need an as-of date and a source.
