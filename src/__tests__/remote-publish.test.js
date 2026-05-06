import { describe, it, expect, vi } from 'vitest';
import { RemoteRuntime } from '../remote.js';

function buildResponse({ ok = true, status = 200, body = {}, text = '' } = {}) {
  const headers = new Map();
  return {
    ok,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => text,
  };
}

function buildRuntime({ fetchImpl, sleepImpl, apiKey, nodeSecret }) {
  return new RemoteRuntime({
    hubUrl: 'https://hub.test',
    nodeId: 'node_test',
    apiKey: apiKey === undefined ? 'test_key' : apiKey,
    nodeSecret: nodeSecret ?? null,
    fetchImpl,
    sleepImpl: sleepImpl ?? (async () => {}),
  });
}

const validGene = {
  type: 'Gene',
  id: 'gene_retry',
  category: 'repair',
  signals_match: ['log_error', 'rate_limited'],
  summary: 'Retry transient hub failures with exponential backoff',
  strategy: [
    'Detect transient hub failure category from status code and error body',
    'Sleep with exponential backoff (300ms, 900ms, 2100ms) before each retry',
    'Retry up to 3 times before bubbling the failure up to the caller',
  ],
  validation: ['node -e "require(\'assert\').strictEqual(typeof process.version,\'string\')"'],
};

const validCapsule = {
  type: 'Capsule',
  id: 'capsule_1',
  trigger: ['log_error'],
  summary: 'Fixed retry loop by adding backoff: 300/900/2100ms after 503 from /a2a/memory/record',
  outcome: { status: 'success', score: 0.9 },
  confidence: 0.9,
  blast_radius: { files: 1, lines: 30 },
  env_fingerprint: { platform: 'linux', arch: 'x64' },
  strategy: ['Detect transient 5xx', 'Sleep with exponential backoff before retrying'],
};

describe('bearer auth selection', () => {
  it('throws when constructed without any bearer', () => {
    expect(() => new RemoteRuntime({ hubUrl: 'https://hub.test', nodeId: 'n', apiKey: null, nodeSecret: null })).toThrow(/apiKey and\/or nodeSecret/);
  });

  it('uses node_secret on /a2a/publish when both are present', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = opts.headers.Authorization;
      return buildResponse({ ok: true, body: { ok: true } });
    });
    const runtime = buildRuntime({ fetchImpl, apiKey: 'api_x', nodeSecret: 'secret_y' });
    await runtime.publishBundle({ gene: validGene, capsule: validCapsule });
    expect(captured).toBe('Bearer secret_y');
  });

  it('uses api_key on /a2a/memory/recall (read-mostly endpoint)', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = opts.headers.Authorization;
      return buildResponse({ ok: true, body: { matches: [] } });
    });
    const runtime = buildRuntime({ fetchImpl, apiKey: 'api_x', nodeSecret: 'secret_y' });
    await runtime.recall({ query: 'q' });
    expect(captured).toBe('Bearer api_x');
  });

  it('falls back to api_key on publish if no node_secret given (legacy callers)', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = opts.headers.Authorization;
      return buildResponse({ ok: true, body: { ok: true } });
    });
    const runtime = buildRuntime({ fetchImpl, apiKey: 'api_x', nodeSecret: null });
    await runtime.publishBundle({ gene: validGene, capsule: validCapsule });
    expect(captured).toBe('Bearer api_x');
  });
});

describe('publishBundle', () => {
  it('rejects payload with malformed Gene before hitting network', async () => {
    const fetchImpl = vi.fn();
    const runtime = buildRuntime({ fetchImpl });
    await expect(runtime.publishBundle({ gene: { id: 'x' }, capsule: validCapsule })).rejects.toThrow(/publishBundle validation failed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a well-formed bundle envelope to /a2a/publish', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = { url, opts };
      return buildResponse({ ok: true, body: { ok: true, accepted: 2 } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.publishBundle({ gene: validGene, capsule: validCapsule });

    expect(captured.url).toBe('https://hub.test/a2a/publish');
    expect(captured.opts.method).toBe('POST');
    expect(captured.opts.headers.Authorization).toBe('Bearer test_key');
    const body = JSON.parse(captured.opts.body);
    expect(body.protocol).toBe('gep-a2a');
    expect(body.message_type).toBe('publish');
    expect(body.sender_id).toBe('node_test');
    expect(Array.isArray(body.payload.assets)).toBe(true);
    expect(body.payload.assets).toHaveLength(2);
    expect(body.payload.assets[0].asset_id).toMatch(/^sha256:/);
    expect(body.payload.assets[0].schema_version).toBe('1.6.0');
    expect(r.gene_asset_id).toMatch(/^sha256:/);
    expect(r.capsule_asset_id).toMatch(/^sha256:/);
  });

  it('attaches a third asset when an EvolutionEvent is provided', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return buildResponse({ ok: true, body: { ok: true } });
    });
    const runtime = buildRuntime({ fetchImpl });
    await runtime.publishBundle({
      gene: validGene,
      capsule: validCapsule,
      event: { type: 'EvolutionEvent', id: 'ev1', summary: 'ran cargo test' },
      modelName: 'claude-4.6',
    });
    expect(captured.payload.assets).toHaveLength(3);
    expect(captured.payload.assets[2].type).toBe('EvolutionEvent');
    expect(captured.payload.assets[0].model_name).toBe('claude-4.6');
  });
});

describe('publishSkill', () => {
  it('first publish: POST /a2a/skill/store/publish with sanitized SKILL.md', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = { url, opts };
      return buildResponse({ ok: true, status: 201, body: { skill_id: 'skill_retry', stored: true } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.publishSkill({ gene: validGene, tags: ['log_error', 'ok'] });
    expect(captured.url).toBe('https://hub.test/a2a/skill/store/publish');
    expect(captured.opts.method).toBe('POST');
    const body = JSON.parse(captured.opts.body);
    expect(body.skill_id).toMatch(/^skill_/);
    expect(body.sender_id).toBe('node_test');
    expect(body.content).toContain('## Strategy');
    // 'ok' should be stripped (length < 3)
    expect(body.tags).toEqual(['log_error']);
    expect(r.mode).toBe('create');
  });

  it('on 409, automatically PUTs to /a2a/skill/store/update', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url, opts) => {
      calls += 1;
      if (calls === 1) return buildResponse({ ok: false, status: 409, text: 'duplicate' });
      return buildResponse({ ok: true, body: { updated: true } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.publishSkill({ gene: validGene, changelog: 'iter v2' });
    expect(calls).toBe(2);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://hub.test/a2a/skill/store/update');
    expect(fetchImpl.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).changelog).toBe('iter v2');
    expect(r.mode).toBe('update');
  });
});

describe('submitValidationReport', () => {
  it('builds and posts a report when given commands+results', async () => {
    let captured;
    const fetchImpl = vi.fn(async (_, opts) => {
      captured = JSON.parse(opts.body);
      return buildResponse({ ok: true, body: { ok: true } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.submitValidationReport({
      geneId: 'gene_x',
      commands: ['cargo test'],
      results: [{ ok: true, stdout: 'all green', stderr: '' }],
      targetAssetId: 'sha256:abc',
    });
    expect(captured.message_type).toBe('report');
    expect(captured.payload.target_asset_id).toBe('sha256:abc');
    expect(captured.payload.validation_report.overall_ok).toBe(true);
    expect(captured.payload.validation_report.asset_id).toMatch(/^sha256:/);
    expect(r.overall_ok).toBe(true);
  });

  it('rejects pre-built report missing required fields', async () => {
    const fetchImpl = vi.fn();
    const runtime = buildRuntime({ fetchImpl });
    await expect(
      runtime.submitValidationReport({ report: { type: 'NotAReport' } })
    ).rejects.toThrow(/validationReport invalid/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('revoke', () => {
  it('refuses without assetId or localId', async () => {
    const fetchImpl = vi.fn();
    const runtime = buildRuntime({ fetchImpl });
    await expect(runtime.revoke({})).rejects.toThrow(/either assetId or localId/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes skill_* localId to /a2a/skill/store/delete', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = { url, opts };
      return buildResponse({ ok: true, body: { skill_id: 'skill_x', status: 'recycled' } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.revoke({ localId: 'skill_x', reason: 'mistake' });
    expect(captured.url).toBe('https://hub.test/a2a/skill/store/delete');
    const body = JSON.parse(captured.opts.body);
    expect(body.skill_id).toBe('skill_x');
    expect(body.sender_id).toBe('node_test');
    expect(body.reason).toBe('mistake');
    expect(r.kind).toBe('skill');
  });

  it('Gene/Capsule revoke requires assetId, refuses bare localId', async () => {
    const fetchImpl = vi.fn();
    const runtime = buildRuntime({ fetchImpl });
    await expect(runtime.revoke({ localId: 'gene_x' })).rejects.toThrow(/requires assetId/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a revoke message to /a2a/revoke when assetId is provided', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, opts) => {
      captured = { url, opts };
      return buildResponse({ ok: true, body: { revoked: true } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.revoke({ assetId: 'sha256:deadbeef', reason: 'leaked secret' });
    expect(captured.url).toBe('https://hub.test/a2a/revoke');
    const body = JSON.parse(captured.opts.body);
    expect(body.message_type).toBe('revoke');
    expect(body.payload.target_asset_id).toBe('sha256:deadbeef');
    expect(body.payload.reason).toBe('leaked secret');
    expect(r.kind).toBe('asset');
  });
});

describe('getIdentity', () => {
  it('GETs identity profile and optionally attestation', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url) => {
      calls += 1;
      if (url.endsWith('/attestation')) {
        return buildResponse({ ok: true, body: { reputation_score: 0.7 } });
      }
      return buildResponse({ ok: true, body: { did: 'did:evomap:node_test' } });
    });
    const runtime = buildRuntime({ fetchImpl });
    const r = await runtime.getIdentity({ includeAttestation: true });
    expect(calls).toBe(2);
    expect(r.profile.did).toBe('did:evomap:node_test');
    expect(r.attestation.reputation_score).toBe(0.7);
  });
});

describe('getAuditLogs', () => {
  it('attaches sender_id and limit/offset to query string', async () => {
    let captured;
    const fetchImpl = vi.fn(async (url) => {
      captured = url;
      return buildResponse({ ok: true, body: { entries: [] } });
    });
    const runtime = buildRuntime({ fetchImpl });
    await runtime.getAuditLogs({ limit: 10, offset: 5, action: 'publish' });
    const u = new URL(captured);
    expect(u.pathname).toBe('/a2a/audit/node_test');
    expect(u.searchParams.get('sender_id')).toBe('node_test');
    expect(u.searchParams.get('limit')).toBe('10');
    expect(u.searchParams.get('offset')).toBe('5');
    expect(u.searchParams.get('action')).toBe('publish');
  });
});

describe('getProtocolInfo', () => {
  it('reports schema/protocol versions for compatibility checks', () => {
    const runtime = buildRuntime({ fetchImpl: vi.fn() });
    const info = runtime.getProtocolInfo();
    expect(info.schema_version).toBe('1.6.0');
    expect(info.protocol_name).toBe('gep-a2a');
    expect(info.mode).toBe('remote');
    expect(info.node_id).toBe('node_test');
  });
});
