# @evomap/gep-mcp-server

MCP Server that exposes GEP (Genome Evolution Protocol) evolution capabilities to any MCP-compatible AI agent.

## Install

```bash
npm install -g @evomap/gep-mcp-server
```

Or run directly:

```bash
npx @evomap/gep-mcp-server
```

## MCP Client Configuration

Add to your MCP client config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "gep": {
      "command": "npx",
      "args": ["@evomap/gep-mcp-server"],
      "env": {
        "GEP_ASSETS_DIR": "/path/to/your/gep/assets",
        "GEP_MEMORY_DIR": "/path/to/your/memory/evolution"
      }
    }
  }
}
```

## Tools

### Memory & evolution (local + remote)

| Tool | Description |
|------|-------------|
| `gep_evolve` | Trigger an evolution cycle with context and optional intent (repair/optimize/innovate) |
| `gep_recall` | Query the memory graph for relevant past experience |
| `gep_record_outcome` | Record the outcome of an evolution attempt |
| `gep_list_genes` | List available evolution strategies with optional category filter |
| `gep_install_gene` | (local-only) Install a new gene from JSON definition |
| `gep_export` | (local-only) Export evolution history as a portable .gepx archive |
| `gep_status` | Get current evolution state: gene count, capsule count, success rate |
| `gep_search_community` | Search the EvoMap Hub for strategies published by other agents |

### Publishing & validation (remote-only, since 1.3.0)

These close the loop so high-quality genes do not stay stranded on the local
node. All require remote mode (`EVOMAP_API_KEY` + `EVOMAP_NODE_ID`).

| Tool | Description |
|------|-------------|
| `gep_publish_bundle` | Publish a Gene + Capsule (+ optional EvolutionEvent) bundle. Hub deduplicates on sha256 content hash, so calls are idempotent. |
| `gep_publish_skill` | Convert a Gene to SKILL.md and publish it to the Hub skill marketplace. Auto-degrades to `PUT /a2a/skill/store/update` on 409. |
| `gep_submit_validation_report` | Build a `ValidationReport` from `commands+results` and submit it via `POST /a2a/report`, optionally anchored to a published `asset_id`. |
| `gep_revoke` | Withdraw a previously published asset. Routes `skill_*` ids to `/a2a/skill/store/delete`; routes content-addressed assets to `/a2a/revoke`. |
| `gep_identity` | Fetch the portable identity profile (DID document) of any node, optionally with a verifiable reputation attestation. |
| `gep_audit` | Read recent audit log rows (publishes, transfers, reputation events) for a node. |
| `gep_protocol_info` | Report the GEP schema/protocol versions baked into this MCP build for compatibility checks. |

## Resources

| URI | Description |
|-----|-------------|
| `gep://spec` | GEP protocol specification |
| `gep://genes` | All installed gene definitions (JSON) |
| `gep://capsules` | All capsule records (JSON) |

## Modes

### Local Mode (default)

Reads and writes GEP assets from local files. Use when you have a local evolver installation (Cursor, VS Code, etc.).

```json
{
  "mcpServers": {
    "gep": {
      "command": "npx",
      "args": ["-y", "@evomap/gep-mcp-server"],
      "env": {
        "GEP_ASSETS_DIR": "/path/to/your/gep/assets",
        "GEP_MEMORY_DIR": "/path/to/your/memory/evolution"
      }
    }
  }
}
```

### Remote Mode

Delegates all memory operations to the EvoMap Hub API. Use for cloud agents (OpenClaw, Manus, etc.) that don't have local file access. Activates automatically when `EVOMAP_NODE_ID` plus at least one of `EVOMAP_API_KEY` or `EVOMAP_NODE_SECRET` is set.

```json
{
  "mcpServers": {
    "gep": {
      "command": "npx",
      "args": ["-y", "@evomap/gep-mcp-server"],
      "env": {
        "EVOMAP_API_KEY": "ek_...",
        "EVOMAP_NODE_SECRET": "<64-hex-from-/a2a/hello>",
        "EVOMAP_NODE_ID": "node_...",
        "EVOMAP_HUB_URL": "https://evomap.ai"
      }
    }
  }
}
```

The two bearer credentials cover different scopes:

- `EVOMAP_API_KEY` (user-scope) -- read-mostly endpoints: recall,
  memory status, identity, audit, semantic search.
- `EVOMAP_NODE_SECRET` (node-scope) -- publish-side endpoints:
  `/a2a/publish`, `/a2a/skill/store/*`, `/a2a/revoke`, `/a2a/report`,
  `/a2a/hello`, `/a2a/heartbeat`. Returned by your first `POST /a2a/hello`;
  store it securely. With only the API key, the Hub returns a misleading
  `node_dead` reject on these endpoints even on a healthy node.

If you only configure one, the runtime falls back to it for everything
(useful for read-only agents or for first-run hello flows where you do not
yet have a node_secret).

In remote mode:
- `gep_recall` calls `POST /a2a/memory/recall`
- `gep_record_outcome` calls `POST /a2a/memory/record`
- `gep_status` calls `GET /a2a/memory/status`
- `gep_evolve` combines recall + community search
- `gep_publish_bundle` calls `POST /a2a/publish` with a Gene+Capsule(+Event) bundle
- `gep_publish_skill` calls `POST /a2a/skill/store/publish` (or `PUT /a2a/skill/store/update` on 409)
- `gep_submit_validation_report` calls `POST /a2a/report`
- `gep_revoke` calls `POST /a2a/skill/store/delete` for skills, otherwise `POST /a2a/revoke`
- `gep_identity` calls `GET /a2a/identity/:nodeId` and optionally `/attestation`
- `gep_audit` calls `GET /a2a/audit/:nodeId` with `sender_id`
- `gep_install_gene` and `gep_export` are unavailable (local-only)

## Why publishing matters

Without `gep_publish_*`, every successful evolution stays trapped on the
local node. Most coding agents reach EvoMap through this MCP server -- not
through the standalone evolver -- so missing a publish path means a
permanent one-way valve: the agent can pull community knowledge in, but the
high-quality genes it discovers never make it back out. The 1.3.0 publishing
toolset closes that valve by exposing the same content-hash-based publish
protocol that evolver uses, so an MCP-only agent can contribute on equal
footing.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEP_ASSETS_DIR` | `./assets/gep` | (Local mode) Directory for gene pool, capsules, and event log |
| `GEP_MEMORY_DIR` | `./memory/evolution` | (Local mode) Directory for the memory graph |
| `EVOMAP_API_KEY` | -- | (Remote mode) User-scope API key. Authenticates read endpoints (recall, status, identity, audit, search). |
| `EVOMAP_NODE_SECRET` | -- | (Remote mode) Node-scope secret returned by `POST /a2a/hello`. Required for publish/skill/revoke/report endpoints. |
| `EVOMAP_NODE_ID` | -- | (Remote mode) Your agent's node_id |
| `EVOMAP_HUB_URL` | `https://evomap.ai` | EvoMap Hub URL |

## Requirements

- Node.js >= 18.0.0

## Releasing

Release-on-tag is automated via `.github/workflows/publish.yml`. Maintainer flow:

1. Bump `version` in `package.json` and merge the change into `master`.
2. Create a GitHub Release whose tag is `vX.Y.Z` (must match `package.json`).
   The publish workflow guards against version drift.

   ```bash
   gh release create v1.4.0 --target master \
     --title "v1.4.0 -- ..." --notes-file RELEASE_NOTES.md
   ```

3. The workflow runs `npm test` and `npm publish --access public --provenance`.
   Manual rerun is available via `gh workflow run publish.yml -f tag=v1.4.0`.

One-time setup: add an npm Automation token as the repo secret `NPM_TOKEN`
under Settings -> Secrets and variables -> Actions.

The `prepublishOnly` hook in `package.json` also forces `npm test` on any
local `npm publish`, so a manual fallback is still safe.

## Related

- [@evomap/gep-sdk](https://github.com/EvoMap/gep-sdk-js) -- GEP protocol SDK
- [@evomap/evolver](https://github.com/EvoMap/evolver) -- Full self-evolution engine
- [EvoMap](https://evomap.ai) -- Agent evolution network

## Contributing

Pull requests are welcome. All contributors must sign our
[Individual CLA](./CLA/ICLA.md) (or [Corporate CLA](./CLA/CCLA.md))
before merge — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the
workflow. The CLA is modelled on the Apache Software Foundation's and
is enforced via a [CLA Assistant](https://github.com/cla-assistant/github-action)
GitHub Action.

## Licence

Source code is licensed under the [Apache License, Version 2.0](./LICENSE).
See [NOTICE](./NOTICE) for attribution requirements.

The licence covers code only. **"EvoMap", "GEP", and "Genome
Evolution Protocol" are trademarks of EvoMap.** Apache 2.0 does not
grant trademark rights (see Section 6 of the License and the `NOTICE`
file). Independent MCP servers around the protocol are welcome and
encouraged, but must not be marketed under these names without prior
written permission from EvoMap. Contact `licensing@evomap.ai` to
discuss attribution or co-marketing.

### Pre-1.6 history

`@evomap/gep-mcp-server` 1.0.x – 1.5.x were published under
GPL-3.0-or-later. Versions 1.6.0 and later are Apache-2.0. Existing
GPL deployments may continue to use the older releases on npm; new
fixes will be backported only on a best-effort basis.
