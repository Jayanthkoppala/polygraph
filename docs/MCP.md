# Use Polygraph from a coding agent

Polygraph includes a local [Model Context Protocol](https://modelcontextprotocol.io/) server. It lets a coding
agent inspect fleet state, verify the ledger, read the last verified output, or deliberately run one collector
without turning the coding agent into Polygraph's primary interface.

Build the server first:

```bash
git clone https://github.com/Jayanthkoppala/polygraph.git
cd polygraph
npm install
npm run build
```

If `POLYGRAPH_DB` points to a database created by an older pre-tenancy Polygraph version, migrate it once before
connecting a coding agent (fresh or already-migrated databases need no separate step):

```bash
POLYGRAPH_DB=/absolute/path/to/polygraph.sqlite node /absolute/path/to/polygraph/dist/index.js migrate
```

Use absolute paths for the repository, `fleet.yaml`, and SQLite database in agent configuration. That makes the
server independent of whichever project directory the coding agent currently has open.

## Codex CLI

```bash
codex mcp add polygraph --env POLYGRAPH_CONFIG=/absolute/path/to/fleet.yaml --env POLYGRAPH_DB=/absolute/path/to/polygraph.sqlite -- node /absolute/path/to/polygraph/dist/index.js mcp
```

Then verify the registration with `codex mcp list` and restart any already-open Codex session so it discovers the
new tools.

## Claude Code

```bash
claude mcp add --scope user -e POLYGRAPH_CONFIG=/absolute/path/to/fleet.yaml -e POLYGRAPH_DB=/absolute/path/to/polygraph.sqlite polygraph -- node /absolute/path/to/polygraph/dist/index.js mcp
```

## Other local MCP clients

Clients that accept the common command/arguments/environment shape can use:

```json
{
  "mcpServers": {
    "polygraph": {
      "command": "node",
      "args": ["/absolute/path/to/polygraph/dist/index.js", "mcp"],
      "env": {
        "POLYGRAPH_CONFIG": "/absolute/path/to/fleet.yaml",
        "POLYGRAPH_DB": "/absolute/path/to/polygraph.sqlite"
      }
    }
  }
}
```

The exact configuration filename and nesting belong to the client; the command, arguments, and environment above
are the Polygraph contract.

## Tools

| Tool | Effect |
|---|---|
| `fleet_status` | Reads every configured collector and its latest non-acknowledgement decision. |
| `ledger_verify` | Walks the local SHA-256 event chain and reports its integrity. |
| `get_safe_output` | Returns the last verified snapshot plus the collector's latest decision. |
| `run_verification` | Runs one collector through the real verification pipeline. |

`fleet_status`, `ledger_verify`, and `get_safe_output` are read operations. `run_verification` appends a decision
receipt and may advance the safe-output snapshot only when the result is released.

## Safety gates

Automatic healing is always disabled inside MCP, even if `fleet.yaml` and `POLYGRAPH_HEAL_ENABLED` both request it.
A repair-eligible failure returns the suggested manual command instead.

Local-adapter collectors whose resolved inputs all target loopback (`localhost`, `127.0.0.0/8`, or `::1`) can run
immediately. Any other destination—including a public, LAN, or cloud-metadata URL—is treated as network-backed,
even when its adapter is labeled `local`. A network-backed collector is denied unless both:

1. The operator launches the server with `POLYGRAPH_MCP_ALLOW_NETWORK=1`.
2. The individual `run_verification` call includes `confirm_network_access: true`.

The first gate is a machine-level opt-in. The second is visible, per-call approval for network access or possible
credit use. Neither gate enables healing.
