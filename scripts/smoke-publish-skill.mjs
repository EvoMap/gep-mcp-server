#!/usr/bin/env node
// One-shot live smoke test for the new publish/identity/audit tools.
// Requires EVOMAP_API_KEY + EVOMAP_NODE_ID to be set in the environment.
// Run: node scripts/smoke-publish-skill.mjs

import { RemoteRuntime } from '../src/remote.js';

const apiKey = process.env.EVOMAP_API_KEY;
const nodeId = process.env.EVOMAP_NODE_ID;
const hubUrl = process.env.EVOMAP_HUB_URL || 'https://evomap.ai';

if (!apiKey || !nodeId) {
  console.error('skip: EVOMAP_API_KEY and EVOMAP_NODE_ID must be set');
  process.exit(2);
}

const runtime = new RemoteRuntime({ hubUrl, nodeId, apiKey });

const demoGene = {
  type: 'Gene',
  id: 'gene_mcp_smoketest_publish_pipeline',
  category: 'optimize',
  signals_match: ['mcp_publish_smoke', 'gep_protocol_validation'],
  preconditions: ['gep-mcp-server v1.3.0+ in remote mode'],
  strategy: [
    'Build a Gene+Capsule bundle locally',
    'Stamp asset_id via canonical-JSON sha256',
    'POST /a2a/publish with the bundle and Bearer API key',
    'Verify the Hub returns 200 and the asset_id round-trips',
  ],
  constraints: { max_files: 1, forbidden_paths: ['.git', 'node_modules'] },
  validation: ['npm test'],
  summary: 'Smoke gene proving the gep-mcp-server v1.3.0 publish pipeline reaches EvoMap Hub end to end',
};

async function main() {
  console.log('--- protocol_info ---');
  console.log(runtime.getProtocolInfo());

  console.log('\n--- identity ---');
  try {
    const r = await runtime.getIdentity({});
    console.log('did:', r.profile?.did);
  } catch (e) {
    console.log('identity error:', e.message);
  }

  console.log('\n--- publish_skill ---');
  try {
    const r = await runtime.publishSkill({ gene: demoGene });
    console.log('result:', JSON.stringify(r, null, 2).slice(0, 1500));
  } catch (e) {
    console.log('publishSkill error:', e.message);
  }

  console.log('\n--- audit ---');
  try {
    const r = await runtime.getAuditLogs({ limit: 3 });
    console.log('audit entries:', JSON.stringify(r, null, 2).slice(0, 800));
  } catch (e) {
    console.log('audit error:', e.message);
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
