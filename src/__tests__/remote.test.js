import { describe, it, expect, vi } from 'vitest';
import { RemoteRuntime } from '../remote.js';

function buildResponse({ ok = true, status = 200, body = {}, text = '', retryAfter } = {}) {
  const headers = new Map();
  if (retryAfter !== undefined) headers.set('retry-after', String(retryAfter));
  return {
    ok,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => text,
  };
}

function buildRuntime({ fetchImpl, sleepImpl }) {
  return new RemoteRuntime({
    hubUrl: 'https://hub.test',
    nodeId: 'node_test',
    apiKey: 'test_key',
    fetchImpl,
    sleepImpl: sleepImpl ?? (async () => {}),
  });
}

describe('RemoteRuntime._request retry logic', () => {
  it('recordOutcome succeeds after two 503s then 200', async () => {
    const statuses = [503, 503, 200];
    const fetchImpl = vi.fn(async () => {
      const code = statuses.shift();
      if (code === 200) {
        return buildResponse({ ok: true, status: 200, body: { ok: true, recorded: 'abc' } });
      }
      return buildResponse({ ok: false, status: code, text: 'upstream connect error' });
    });
    const sleepSpy = vi.fn(async () => {});
    const runtime = buildRuntime({ fetchImpl, sleepImpl: sleepSpy });

    const result = await runtime.recordOutcome({
      geneId: 'ad_hoc',
      status: 'success',
      signals: ['log_error'],
      summary: 'test',
    });

    expect(result).toEqual({ ok: true, recorded: 'abc' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy.mock.calls[0][0]).toBe(300);
    expect(sleepSpy.mock.calls[1][0]).toBe(900);
  });

  it('recordOutcome throws with attempts=4 after four consecutive 503s', async () => {
    const fetchImpl = vi.fn(async () =>
      buildResponse({ ok: false, status: 503, text: 'upstream' })
    );
    const runtime = buildRuntime({ fetchImpl });

    await expect(
      runtime.recordOutcome({ geneId: 'x', status: 'success', summary: 'y' })
    ).rejects.toThrow(/after 4 attempt\(s\)/);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('400 fails immediately without retry', async () => {
    const fetchImpl = vi.fn(async () =>
      buildResponse({ ok: false, status: 400, text: 'bad request' })
    );
    const runtime = buildRuntime({ fetchImpl });

    await expect(
      runtime.recordOutcome({ geneId: 'x', status: 'success', summary: 'y' })
    ).rejects.toThrow(/returned 400 after 1 attempt\(s\)/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetch reject on first call then success', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('ECONNRESET');
      return buildResponse({ ok: true, status: 200, body: { matches: [] } });
    });
    const runtime = buildRuntime({ fetchImpl });

    const result = await runtime.recall({ query: 'x', limit: 5 });
    expect(result).toEqual({ matches: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('non-idempotent POST is not retried (e.g. semantic-search POST if ever added)', async () => {
    const fetchImpl = vi.fn(async () =>
      buildResponse({ ok: false, status: 503, text: 'x' })
    );
    const runtime = buildRuntime({ fetchImpl });
    await expect(runtime._request('POST', '/a2a/unknown-nonidempotent', { a: 1 }))
      .rejects.toThrow(/returned 503 after 1 attempt\(s\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After header (seconds) instead of default backoff', async () => {
    const statuses = [503, 200];
    const fetchImpl = vi.fn(async () => {
      const code = statuses.shift();
      if (code === 200) return buildResponse({ ok: true, status: 200, body: { ok: true } });
      return buildResponse({ ok: false, status: code, text: 'rate limited', retryAfter: 2 });
    });
    const sleepSpy = vi.fn(async () => {});
    const runtime = buildRuntime({ fetchImpl, sleepImpl: sleepSpy });

    await runtime._request('GET', '/a2a/memory/status?node_id=x');
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy.mock.calls[0][0]).toBe(2000);
  });
});

describe('RemoteRuntime.recall cost-threshold post-filter', () => {
  // Phase 2 (Hub side, queued with cloudcarver) is expected to attach
  // cost_tokens / cost_usd to each match in the /a2a/memory/recall response.
  // Until that lands, these tests double as the contract spec for what
  // the mcp-server will do when those fields show up.
  function recallResponse(matches) {
    return buildResponse({ ok: true, status: 200, body: { matches } });
  }

  it('drops matches whose cost_tokens exceed max_cost_tokens', async () => {
    const fetchImpl = vi.fn(async () => recallResponse([
      { gene_id: 'cheap', cost_tokens: 500 },
      { gene_id: 'pricey', cost_tokens: 5000 },
    ]));
    const runtime = buildRuntime({ fetchImpl });
    const result = await runtime.recall({ query: 'x', max_cost_tokens: 1000 });
    expect(result.matches.map(m => m.gene_id)).toEqual(['cheap']);
  });

  it('keeps matches whose cost_tokens is missing (unknown != unbounded)', async () => {
    const fetchImpl = vi.fn(async () => recallResponse([
      { gene_id: 'legacy' },
      { gene_id: 'cheap', cost_tokens: 100 },
      { gene_id: 'pricey', cost_tokens: 10000 },
    ]));
    const runtime = buildRuntime({ fetchImpl });
    const result = await runtime.recall({ query: 'x', max_cost_tokens: 1000 });
    expect(result.matches.map(m => m.gene_id)).toEqual(['legacy', 'cheap']);
  });

  it('applies max_cost_tokens and max_cost_usd conjunctively', async () => {
    const fetchImpl = vi.fn(async () => recallResponse([
      { gene_id: 'both_ok', cost_tokens: 500, cost_usd: 0.01 },
      { gene_id: 'token_fail', cost_tokens: 5000, cost_usd: 0.01 },
      { gene_id: 'usd_fail', cost_tokens: 500, cost_usd: 1.0 },
    ]));
    const runtime = buildRuntime({ fetchImpl });
    const result = await runtime.recall({
      query: 'x',
      max_cost_tokens: 1000,
      max_cost_usd: 0.1,
    });
    expect(result.matches.map(m => m.gene_id)).toEqual(['both_ok']);
  });

  it('returns the Hub response unchanged when no threshold args are given', async () => {
    const body = { matches: [{ gene_id: 'a', cost_tokens: 99999 }], extra: 'pass-through' };
    const fetchImpl = vi.fn(async () => buildResponse({ ok: true, status: 200, body }));
    const runtime = buildRuntime({ fetchImpl });
    const result = await runtime.recall({ query: 'x' });
    expect(result).toEqual(body);
  });

  it('accepts max_cost_usd as a float threshold', async () => {
    const fetchImpl = vi.fn(async () => recallResponse([
      { gene_id: 'cheap', cost_usd: 0.0234 },
      { gene_id: 'pricey', cost_usd: 0.5 },
    ]));
    const runtime = buildRuntime({ fetchImpl });
    const result = await runtime.recall({ query: 'x', max_cost_usd: 0.1 });
    expect(result.matches.map(m => m.gene_id)).toEqual(['cheap']);
  });
});
