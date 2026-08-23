# AI assistance disclosure

Polygraph was developed with assistance from AI coding tools. They were used to help explore
implementation options, draft code and copy, and suggest tests. They were not treated as an
authority for product claims, security properties, or test results.

The repository is the source of truth for the shipped behavior. The author reviewed the changes
and is responsible for the product decisions, including the deliberately conservative release,
quarantine, repair, and tenant-isolation rules.

Before relying on a claim, reproduce it from the checkout:

```bash
npm install
npm run test:all
npm run typecheck
npm run build:all
```

The hosted instance is a multi-tenant service on a single Google Cloud VM (see
`deploy/README.md`). Tenant Bright Data keys are encrypted per tenant with a master key that
lives only in the server environment. The offline demo (`npm run demo`) runs against a local
fixture and sends nothing anywhere. The server is started with
`POLYGRAPH_MASTER_KEY=<base64 of 32 random bytes> node dist/index.js serve`.

AI-generated suggestions can be wrong or incomplete. This disclosure does not replace the
repository's tests, the ledger verification command, or an operator's own review of a live
deployment.
