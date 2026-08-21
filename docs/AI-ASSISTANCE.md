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

The browser sandbox on the public Vercel site runs fixture data locally in the visitor's browser.
It is not a hosted tenant service and does not send a Bright Data key anywhere. The self-hosted
server is a separate runtime started with `POLYGRAPH_MASTER_KEY=<32-byte hex> npm run serve`.

AI-generated suggestions can be wrong or incomplete. This disclosure does not replace the
repository's tests, the ledger verification command, or an operator's own review of a live
deployment.
