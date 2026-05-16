#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { GepRuntime } from './runtime.js';
import { RemoteRuntime } from './remote.js';
import { annotateSearchPayload } from './searchEnrich.js';

const ASSETS_DIR = process.env.GEP_ASSETS_DIR || resolve(process.cwd(), 'assets/gep');
const MEMORY_DIR = process.env.GEP_MEMORY_DIR || resolve(process.cwd(), 'memory/evolution');
const HUB_URL = process.env.EVOMAP_HUB_URL || 'https://evomap.ai';

// Remote mode requires a node id and at least one of:
//   - EVOMAP_API_KEY     (user-scope, suffices for read-mostly endpoints)
//   - EVOMAP_NODE_SECRET (node-scope, required for publish/skill/revoke/report;
//     returned by POST /a2a/hello on first registration)
// Configure both when possible; the runtime picks per endpoint.
const HAS_REMOTE_AUTH = !!(process.env.EVOMAP_API_KEY || process.env.EVOMAP_NODE_SECRET);
const IS_REMOTE = !!(HAS_REMOTE_AUTH && process.env.EVOMAP_NODE_ID);
const runtime = IS_REMOTE
  ? new RemoteRuntime({
      hubUrl: HUB_URL,
      nodeId: process.env.EVOMAP_NODE_ID,
      apiKey: process.env.EVOMAP_API_KEY || null,
      nodeSecret: process.env.EVOMAP_NODE_SECRET || null,
    })
  : new GepRuntime({ assetsDir: ASSETS_DIR, memoryDir: MEMORY_DIR });

const server = new Server(
  { name: 'gep-mcp-server', version: '1.4.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'gep_evolve',
      description: 'Trigger a GEP evolution cycle. The agent detects signals from the provided context, selects the best gene (evolution strategy), and returns the evolution plan. Use this when you encounter a problem you cannot solve or want to learn a new capability.',
      inputSchema: {
        type: 'object',
        properties: {
          context: {
            type: 'string',
            description: 'The current execution context: error messages, logs, user requests, or any text that describes what needs to evolve',
          },
          intent: {
            type: 'string',
            enum: ['repair', 'optimize', 'innovate'],
            description: 'Optional: force a specific evolution intent. If omitted, the system infers from signals.',
          },
        },
        required: ['context'],
      },
    },
    {
      name: 'gep_recall',
      description: 'Query the evolution memory graph for relevant past experience. Returns historical signal-gene-outcome mappings that match the query. Use this to check if you have dealt with a similar situation before.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Description of what you want to recall from evolution history',
          },
          signals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: specific signal patterns to search for',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 10, max 50)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'gep_record_outcome',
      description: 'Record the outcome of a task. Call this after completing substantive work to build evolution memory. The summary must describe both the problem and the solution.',
      inputSchema: {
        type: 'object',
        properties: {
          geneId: {
            type: 'string',
            description: 'The gene ID that was used (use "ad_hoc" for non-gene-driven tasks)',
          },
          signals: {
            type: 'array',
            items: { type: 'string' },
            description: 'The signals that triggered the evolution',
          },
          status: {
            type: 'string',
            enum: ['success', 'failed'],
            description: 'Whether the task was successful',
          },
          score: {
            type: 'number',
            description: 'Quality score from 0.0 to 1.0',
          },
          summary: {
            type: 'string',
            description: 'Specific description of what happened: "Fixed X by doing Y" (required for useful recall)',
          },
        },
        required: ['geneId', 'signals', 'status', 'score', 'summary'],
      },
    },
    {
      name: 'gep_list_genes',
      description: 'List all available evolution genes (strategies). Each gene responds to specific signals and contains actionable steps.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['repair', 'optimize', 'innovate'],
            description: 'Optional: filter by category',
          },
        },
      },
    },
    {
      name: 'gep_install_gene',
      description: 'Install a new gene (evolution strategy) into the local gene pool.',
      inputSchema: {
        type: 'object',
        properties: {
          gene: {
            type: 'object',
            description: 'The Gene object to install (must conform to GEP Gene schema)',
          },
        },
        required: ['gene'],
      },
    },
    {
      name: 'gep_list_skill',
      description: 'List skills available across bundled (shipped with evolver), local (~/.claude/skills/), and hub (community) sources. Use this before gep_load_skill to discover what is available. The bootstrap _meta skill is hidden by default; pass a query to surface it.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['bundled', 'local', 'hub', 'all'],
            description: 'Which source to list. Defaults to "all".',
          },
          query: {
            type: 'string',
            description: 'Optional substring filter applied to name / description / tags',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 50, max 200)',
          },
        },
      },
    },
    {
      name: 'gep_load_skill',
      description: 'Fetch a skill\'s SKILL.md content. Default returns the markdown as a tool result so you can apply it for the current turn. Pass install:true (local mode only) to copy the skill directory into ~/.claude/skills/<name>/ for native Claude Code Skill use across sessions. Resolution priority is local > bundled > hub; disambiguate collisions with "<source>:<name>".',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name. Use "bundled:<name>", "local:<name>", or "hub:<name>" to force a source.',
          },
          source: {
            type: 'string',
            enum: ['bundled', 'local', 'hub'],
            description: 'Optional explicit source. Overrides the prefix syntax in name.',
          },
          version: {
            type: 'string',
            description: 'Optional version pin (hub source only).',
          },
          install: {
            type: 'boolean',
            description: 'If true, copy to ~/.claude/skills/<name>/ instead of returning content. Local mode only.',
          },
          force: {
            type: 'boolean',
            description: 'When install:true, overwrite an existing local skill of the same name.',
          },
          maxBytes: {
            type: 'number',
            description: 'Truncation cap for returned content (default 64000). Skills larger than this are truncated; pass install:true to access the full file.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'gep_export',
      description: 'Export the complete evolution history as a portable .gepx archive. This is your sovereign evolution data.',
      inputSchema: {
        type: 'object',
        properties: {
          outputPath: {
            type: 'string',
            description: 'File path for the .gepx archive',
          },
          agentName: {
            type: 'string',
            description: 'Name of the agent whose evolution is being exported',
          },
        },
        required: ['outputPath'],
      },
    },
    {
      name: 'gep_status',
      description: 'Get the current evolution status: gene count, capsule count, recent events, memory graph size.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'gep_search_community',
      description: 'Search the EvoMap community for evolution strategies and capsules published by other agents. Use natural language to find relevant past experiences across the entire ecosystem.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query (e.g. "how to fix retry timeout issues")',
          },
          type: {
            type: 'string',
            enum: ['Gene', 'Capsule'],
            description: 'Optional: filter by asset type',
          },
          outcome: {
            type: 'string',
            enum: ['success', 'failed'],
            description: 'Optional: filter by outcome status',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 10)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'gep_publish_bundle',
      description: 'Publish a Gene + Capsule (and optional EvolutionEvent) bundle to the EvoMap Hub. The Hub deduplicates on content hash so repeated calls with identical assets are idempotent. Use this when local high-quality genes should become available to the community. Requires remote mode (EVOMAP_API_KEY).',
      inputSchema: {
        type: 'object',
        properties: {
          gene: { type: 'object', description: 'Gene asset (must include type="Gene", id, category, signals_match)' },
          capsule: { type: 'object', description: 'Capsule asset (must include type="Capsule", id, trigger[], summary)' },
          event: { type: 'object', description: 'Optional EvolutionEvent asset to attach' },
          chainId: { type: 'string', description: 'Optional evolution chain id (groups related publishes)' },
          modelName: { type: 'string', description: 'Optional model name to stamp on each asset' },
        },
        required: ['gene', 'capsule'],
      },
    },
    {
      name: 'gep_publish_skill',
      description: 'Convert a Gene into SKILL.md format and publish it to the EvoMap Hub skill marketplace. On 409 (already published) the call automatically degrades to an iterative update. Use this when a gene is mature enough for other agents to install and run as a Cursor / Claude Code skill.',
      inputSchema: {
        type: 'object',
        properties: {
          gene: { type: 'object', description: 'Gene asset to convert' },
          category: { type: 'string', description: 'Optional override for skill category' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag list (defaults to gene.signals_match, sanitized)' },
          changelog: { type: 'string', description: 'Optional changelog message used only on update path' },
        },
        required: ['gene'],
      },
    },
    {
      name: 'gep_submit_validation_report',
      description: 'Build and submit a ValidationReport to the Hub. Pass either a pre-built report object or raw commands+results to construct one. Reports are anchored to a published asset by asset_id (recommended) so reviewers can correlate outcomes with assets.',
      inputSchema: {
        type: 'object',
        properties: {
          report: { type: 'object', description: 'Pre-built ValidationReport object (mutually exclusive with commands+results)' },
          commands: { type: 'array', items: { type: 'string' }, description: 'List of commands that were run, in order' },
          results: { type: 'array', items: { type: 'object' }, description: 'List of {ok, stdout, stderr} objects matching commands order' },
          geneId: { type: 'string', description: 'Local gene id this report validates' },
          targetAssetId: { type: 'string', description: 'asset_id of the published asset this report validates' },
          targetLocalId: { type: 'string', description: 'local id of the asset (alternative to targetAssetId)' },
        },
      },
    },
    {
      name: 'gep_revoke',
      description: 'Withdraw a previously published asset from the Hub. For skills, pass localId starting with "skill_" (routes to /a2a/skill/store/delete). For Gene/Capsule/EvolutionEvent, pass assetId (sha256 content hash, routes to /a2a/revoke).',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: 'The asset_id (sha256:...) to revoke (required for Gene/Capsule/Event)' },
          localId: { type: 'string', description: 'Local id; required for skills (must start with "skill_")' },
          reason: { type: 'string', description: 'Free-form reason recorded in the audit log' },
        },
      },
    },
    {
      name: 'gep_identity',
      description: 'Fetch the portable identity profile of a node (DID document, capabilities, registered services). Defaults to the current node. Optionally also returns a verifiable reputation attestation.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Target node id (defaults to the current node)' },
          includeAttestation: { type: 'boolean', description: 'If true, also fetch the reputation attestation' },
        },
      },
    },
    {
      name: 'gep_audit',
      description: 'Read recent audit log entries for a node (publishes, transfers, reputation events). Defaults to the current node and requires sender_id authorization (handled automatically).',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Target node id (defaults to the current node)' },
          limit: { type: 'number', description: 'Max rows to return (default 50, max 200)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
          action: { type: 'string', description: 'Optional action-type filter' },
          since: { type: 'string', description: 'Optional ISO-8601 lower bound on timestamp' },
          until: { type: 'string', description: 'Optional ISO-8601 upper bound on timestamp' },
        },
      },
    },
    {
      name: 'gep_protocol_info',
      description: 'Return the GEP schema and protocol versions this MCP build speaks. Use to detect protocol drift between MCP and Hub or between MCP and the parent agent.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'gep_evolve':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.evolve(args), null, 2) }] };
      case 'gep_recall':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.recall(args), null, 2) }] };
      case 'gep_record_outcome':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.recordOutcome(args), null, 2) }] };
      case 'gep_list_genes':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.listGenes(args), null, 2) }] };
      case 'gep_install_gene': {
        if (IS_REMOTE) return { content: [{ type: 'text', text: JSON.stringify({ error: 'local_only', tool: 'gep_install_gene', hint: 'This tool requires local mode. Set ASSETS_DIR and MEMORY_DIR instead of EVOMAP_API_KEY.' }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(runtime.installGene(args), null, 2) }] };
      }
      case 'gep_list_skill':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.listSkills(args), null, 2) }] };
      case 'gep_load_skill': {
        if (IS_REMOTE && args?.install) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'local_only', tool: 'gep_load_skill', hint: 'install:true requires local mode. Set ASSETS_DIR and MEMORY_DIR instead of EVOMAP_API_KEY, or call without install:true to receive the skill content as a tool result.' }) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.loadSkill(args), null, 2) }] };
      }
      case 'gep_export': {
        if (IS_REMOTE) return { content: [{ type: 'text', text: JSON.stringify({ error: 'local_only', tool: 'gep_export', hint: 'This tool requires local mode. Set ASSETS_DIR and MEMORY_DIR instead of EVOMAP_API_KEY.' }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(runtime.exportEvolution(args), null, 2) }] };
      }
      case 'gep_status':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.getStatus(), null, 2) }] };
      case 'gep_search_community': {
        if (!args.query || typeof args.query !== 'string' || args.query.trim().length < 2) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'query must be a string with at least 2 characters' }) }], isError: true };
        }
        let data;
        if (IS_REMOTE) {
          data = await runtime.searchCommunity(args);
        } else {
          const params = new URLSearchParams();
          params.set('q', args.query.trim().slice(0, 500));
          if (args.type && ['Gene', 'Capsule'].includes(args.type)) params.set('type', args.type);
          if (args.outcome && ['success', 'failed'].includes(args.outcome)) params.set('outcome', args.outcome);
          params.set('limit', String(Math.min(Math.max(1, parseInt(args.limit, 10) || 10), 50)));
          params.set('include_context', 'true');
          const url = `${HUB_URL}/a2a/assets/semantic-search?${params.toString()}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`Hub returned ${res.status}`);
          data = await res.json();
        }
        // Annotate every asset with similarity_band and confidence_band so
        // callers do not fall into the 0.6 trust trap (similarity high enough
        // to look real, too low to actually solve the query). Purely
        // additive: existing payload shape is preserved.
        const enriched = annotateSearchPayload(data);
        return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] };
      }
      case 'gep_publish_bundle':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.publishBundle(args), null, 2) }] };
      case 'gep_publish_skill':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.publishSkill(args), null, 2) }] };
      case 'gep_submit_validation_report':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.submitValidationReport(args), null, 2) }] };
      case 'gep_revoke':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.revoke(args), null, 2) }] };
      case 'gep_identity':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.getIdentity(args), null, 2) }] };
      case 'gep_audit':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.getAuditLogs(args), null, 2) }] };
      case 'gep_protocol_info':
        return { content: [{ type: 'text', text: JSON.stringify(runtime.getProtocolInfo(), null, 2) }] };
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'gep://spec',
      name: 'GEP Protocol Specification',
      description: 'The complete Genome Evolution Protocol specification',
      mimeType: 'text/markdown',
    },
    {
      uri: 'gep://genes',
      name: 'Gene Pool',
      description: 'All currently installed evolution genes',
      mimeType: 'application/json',
    },
    {
      uri: 'gep://capsules',
      name: 'Evolution Capsules',
      description: 'Records of past successful evolutions',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  switch (uri) {
    case 'gep://spec': {
      const candidates = [
        resolve(ASSETS_DIR, 'gep-spec-v1.md'),
        resolve(__dirname, '../../gep-protocol/spec/gep-spec-v1.md'),
      ];
      const specPath = candidates.find(p => existsSync(p));
      const content = specPath
        ? readFileSync(specPath, 'utf8')
        : 'GEP spec not found. Place gep-spec-v1.md in your GEP_ASSETS_DIR or install gep-protocol alongside this package.';
      return { contents: [{ uri, mimeType: 'text/markdown', text: content }] };
    }
    case 'gep://genes': {
      if (IS_REMOTE) {
        const result = await runtime.listGenes({});
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.genes || [], null, 2) }] };
      }
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(runtime.store.loadGenes(), null, 2) }] };
    }
    case 'gep://capsules': {
      if (IS_REMOTE) {
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ note: 'Capsules are stored on EvoMap Hub. Use gep_recall to query evolution history.' }) }] };
      }
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(runtime.store.loadCapsules(), null, 2) }] };
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`GEP MCP Server running on stdio (${IS_REMOTE ? 'remote' : 'local'} mode)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
