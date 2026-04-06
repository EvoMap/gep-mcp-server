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

const ASSETS_DIR = process.env.GEP_ASSETS_DIR || resolve(process.cwd(), 'assets/gep');
const MEMORY_DIR = process.env.GEP_MEMORY_DIR || resolve(process.cwd(), 'memory/evolution');
const HUB_URL = process.env.EVOMAP_HUB_URL || 'https://evomap.ai';

const IS_REMOTE = !!(process.env.EVOMAP_API_KEY && process.env.EVOMAP_NODE_ID);
const runtime = IS_REMOTE
  ? new RemoteRuntime({ hubUrl: HUB_URL, nodeId: process.env.EVOMAP_NODE_ID, apiKey: process.env.EVOMAP_API_KEY })
  : new GepRuntime({ assetsDir: ASSETS_DIR, memoryDir: MEMORY_DIR });

const server = new Server(
  { name: 'gep-mcp-server', version: '1.1.0' },
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
        },
        required: ['query'],
      },
    },
    {
      name: 'gep_record_outcome',
      description: 'Record the outcome of an evolution attempt. Call this after applying an evolution plan to provide feedback to the memory graph.',
      inputSchema: {
        type: 'object',
        properties: {
          geneId: {
            type: 'string',
            description: 'The gene ID that was used',
          },
          signals: {
            type: 'array',
            items: { type: 'string' },
            description: 'The signals that triggered the evolution',
          },
          status: {
            type: 'string',
            enum: ['success', 'failed'],
            description: 'Whether the evolution was successful',
          },
          score: {
            type: 'number',
            description: 'Quality score from 0.0 to 1.0',
          },
          summary: {
            type: 'string',
            description: 'Brief description of what happened',
          },
        },
        required: ['geneId', 'signals', 'status', 'score'],
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
        if (IS_REMOTE) return { content: [{ type: 'text', text: 'gep_install_gene is only available in local mode' }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(runtime.installGene(args), null, 2) }] };
      }
      case 'gep_export': {
        if (IS_REMOTE) return { content: [{ type: 'text', text: 'gep_export is only available in local mode' }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(runtime.exportEvolution(args), null, 2) }] };
      }
      case 'gep_status':
        return { content: [{ type: 'text', text: JSON.stringify(await runtime.getStatus(), null, 2) }] };
      case 'gep_search_community': {
        if (!args.query || typeof args.query !== 'string' || args.query.trim().length < 2) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'query must be a string with at least 2 characters' }) }], isError: true };
        }
        if (IS_REMOTE) {
          const data = await runtime.searchCommunity(args);
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        const params = new URLSearchParams();
        params.set('q', args.query.trim().slice(0, 500));
        if (args.type && ['Gene', 'Capsule'].includes(args.type)) params.set('type', args.type);
        if (args.outcome && ['success', 'failed'].includes(args.outcome)) params.set('outcome', args.outcome);
        params.set('limit', String(Math.min(Math.max(1, parseInt(args.limit, 10) || 10), 50)));
        params.set('include_context', 'true');
        const url = `${HUB_URL}/a2a/assets/semantic-search?${params.toString()}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Hub returned ${res.status}`);
        const data = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
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
