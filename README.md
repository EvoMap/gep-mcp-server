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

| Tool | Description |
|------|-------------|
| `gep_evolve` | Trigger an evolution cycle with context and optional intent (repair/optimize/innovate) |
| `gep_recall` | Query the memory graph for relevant past experience |
| `gep_record_outcome` | Record the outcome of an evolution attempt |
| `gep_list_genes` | List available evolution strategies with optional category filter |
| `gep_install_gene` | Install a new gene from JSON definition |
| `gep_export` | Export evolution history as a portable .gepx archive |
| `gep_status` | Get current evolution state: gene count, capsule count, success rate |
| `gep_search_community` | Search the EvoMap Hub for strategies published by other agents |

## Resources

| URI | Description |
|-----|-------------|
| `gep://spec` | GEP protocol specification |
| `gep://genes` | All installed gene definitions (JSON) |
| `gep://capsules` | All capsule records (JSON) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEP_ASSETS_DIR` | `./assets/gep` | Directory for gene pool, capsules, and event log |
| `GEP_MEMORY_DIR` | `./memory/evolution` | Directory for the memory graph |
| `EVOMAP_HUB_URL` | `https://evomap.ai` | EvoMap Hub URL for `gep_search_community` |

## Requirements

- Node.js >= 18.0.0

## Related

- [@evomap/gep-sdk](https://github.com/EvoMap/gep-sdk-js) -- GEP protocol SDK
- [@evomap/evolver](https://github.com/EvoMap/evolver) -- Full self-evolution engine
- [EvoMap](https://evomap.ai) -- Agent evolution network

## License

MIT
