# Contributing to @evomap/gep-mcp-server

Thanks for your interest in `@evomap/gep-mcp-server` — the MCP (Model
Context Protocol) server that exposes Genome Evolution Protocol (GEP)
evolution capabilities to MCP-compatible AI agents (Claude, Cursor,
Cline, custom stacks).

## Scope

In scope:

- Bug fixes in tool handlers (`gep_recall`, `gep_publish`,
  `gep_record_outcome`, `gep_search_community`, `gep_list_skill`,
  `gep_load_skill`, …)
- New MCP tools that wrap existing GEP capabilities
- Remote-mode adapters (Hub backends, alternative storage drivers)
- Docs, examples, and integration guides for new MCP clients
- Tests — unit (`vitest`) and integration

Out of scope (and why):

- **Protocol primitives** (`canonicalize`, `computeAssetId`,
  `SCHEMA_VERSION`, JSON Schemas). These live in
  [`@evomap/gep-sdk`](https://github.com/EvoMap/gep-sdk-js) — bumping
  them here would re-introduce the drift the SDK was created to
  prevent. If a protocol change is needed, send the PR there first.
- **Selection / signal-extraction algorithms.** Those belong to
  [`@evomap/evolver`](https://github.com/EvoMap/evolver) (or to your
  own runtime). This server only routes between MCP clients and a
  GEP runtime.

## Contributor License Agreement (CLA)

Before we can merge any PR, contributors must sign the EvoMap
Individual Contributor License Agreement (ICLA) — or, if contributing
on behalf of a company, a Corporate CLA (CCLA). The agreement is
modelled on the Apache Software Foundation's standard ICLA/CCLA.

**How it works**: when you open your first PR, the
[CLA Assistant](https://github.com/cla-assistant/cla-assistant) bot
will post a link. Click through and sign with your GitHub identity.
Your future PRs are then auto-approved against the same signature.

The full agreement texts:

- [ICLA (individual)](./CLA/ICLA.md)
- [CCLA (corporate)](./CLA/CCLA.md)

By signing, you grant EvoMap (a) a perpetual copyright license to your
contribution under this repository's [Apache-2.0 LICENSE](./LICENSE),
and (b) a patent peace covenant. You retain ownership of your
contribution.

## Development workflow

```bash
git clone git@github.com:EvoMap/gep-mcp-server.git
cd gep-mcp-server
npm install
npm test                      # vitest run
node src/index.js             # local MCP server (stdio transport)
```

Open a branch, push it to a fork, send a PR against `master`. CLA
Assistant will gate the merge until signature is on file.

## Cross-package coordination

If your change touches the wire format with the Hub or assumes a
particular schema field, please cross-reference the relevant
`@evomap/gep-sdk` `SCHEMA_VERSION` in your PR description. Bump the
SDK dep range here in lockstep so a fresh `npm install` of this
package pulls a compatible SDK.

## Trademark policy

"EvoMap", "GEP", and "Genome Evolution Protocol" are trademarks of
EvoMap. The Apache 2.0 License does not grant permission to use them
(see Section 6 of the License and the repository's `NOTICE` file).
Forks and re-implementations of MCP servers around the protocol are
welcome and encouraged, but must not be marketed under these names
without prior written permission from EvoMap. Reach out at
`licensing@evomap.ai` if you'd like to discuss attribution or
co-marketing.
