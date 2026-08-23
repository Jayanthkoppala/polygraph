# Contributing

## Setup

Node **22** (`.node-version`). `better-sqlite3` is native; a different major
fails with a `NODE_MODULE_VERSION` mismatch — run `npm rebuild better-sqlite3`
after switching Node versions.

```bash
npm run setup          # npm install for the server and for app/
npm run typecheck:all
npm run test:all
```

## Layout rules

- Flat files at `src/` root are entry points; everything else is a folder
  named for what it does.
- Every backend test lives at the mirror path under `scripts/test/`; front-end
  tests live under `app/tests/`.
- Migrations are non-destructive and idempotent (`CREATE ... IF NOT EXISTS`,
  guarded `ALTER TABLE ADD COLUMN`). Add a new file under
  `src/tenancy/migrations/`, register it in `src/tenancy/migrate.ts`, and bump
  the count asserted in `scripts/test/tenancy/migration-013.test.ts`.
- The only outbound Bright Data client is `src/brightdata/`. Do not add a second.
- Never log or return a key, token, stored run input, or raw provider error
  string to a tenant-facing surface; the closed copy maps in
  `src/tenancy/recovery/api.ts` are the boundary.

## Running one test

```bash
npx vitest run scripts/test/store/ledger.test.ts          # backend file
npx vitest run -t "verify"                                 # backend by name
npm --prefix app run test -- tests/recovery/RepairsTable.test.tsx   # front end
```

## Definition of done

`npm run typecheck:all`, `npm run test:all`, and `npm run build:all` pass
locally; CI runs the same plus a Docker build. Changed behaviour ships with a
test and, if user-visible, a line in `CHANGELOG.md`. Claims in docs need an
as-of date and a pointer to evidence.

## Commits

Conventional prefixes (`feat`, `fix`, `docs`, `chore`, `test`, `deploy`),
scope in parentheses, imperative subject. One logical change per commit.
