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

describe('RemoteRuntime.recall budget hint forwarding', () => {
  it('forwards budget_tokens / budget_usd / cost_tier to the Hub body', async () => {
    let captured;
    const fetchImpl = vi.fn(async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return buildResponse({ ok: true, status: 200, body: { matches: [] } });
    });
    const runtime = buildRuntime({ fetchImpl });
    await runtime.recall({
      query: 'x',
      budget_tokens: 1000,
      budget_usd: 0.5,
      cost_tier: 'low',
    });
    expect(captured.budget_tokens).toBe(1000);
    expect(captured.budget_usd).toBe(0.5);
    expect(captured.cost_tier).toBe('low');
  });

  it('omits budget fields when not supplied', async () => {
    let captured;
    const fetchImpl = vi.fn(async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return buildResponse({ ok: true, status: 200, body: { matches: [] } });
    });
    const runtime = buildRuntime({ fetchImpl });
    await runtime.recall({ query: 'x' });
    expect(captured.budget_tokens).toBeUndefined();
    expect(captured.budget_usd).toBeUndefined();
    expect(captured.cost_tier).toBeUndefined();
  });

  it('returns the Hub response unchanged', async () => {
    const body = { matches: [{ gene_id: 'a', cost_tokens: 99999 }], extra: 'pass-through' };
    const fetchImpl = vi.fn(async () => buildResponse({ ok: true, status: 200, body }));
    const runtime = buildRuntime({ fetchImpl });
    const result = await runtime.recall({ query: 'x' });
    expect(result).toEqual(body);
  });
});

describe('RemoteRuntime.recordOutcome attribution passthrough', () => {
  function capturingRuntime() {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return buildResponse({ ok: true, status: 200, body: { ok: true, recorded: 'r1' } });
    });
    return { runtime: buildRuntime({ fetchImpl }), calls };
  }

  it('includes used_asset_ids in the record body when provided', async () => {
    const { runtime, calls } = capturingRuntime();
    await runtime.recordOutcome({
      geneId: 'ad_hoc', status: 'success', signals: ['log_error'], summary: 's',
      used_asset_ids: ['sha256:aaa', 'sha256:bbb'],
    });
    expect(calls[0].used_asset_ids).toEqual(['sha256:aaa', 'sha256:bbb']);
  });

  it('omits used_asset_ids entirely when absent (byte-compatible with older agents)', async () => {
    const { runtime, calls } = capturingRuntime();
    await runtime.recordOutcome({ geneId: 'ad_hoc', status: 'success', signals: ['log_error'], summary: 's' });
    expect('used_asset_ids' in calls[0]).toBe(false);
  });

  it('omits used_asset_ids when an empty array is passed', async () => {
    const { runtime, calls } = capturingRuntime();
    await runtime.recordOutcome({ geneId: 'ad_hoc', status: 'success', signals: ['x'], summary: 's', used_asset_ids: [] });
    expect('used_asset_ids' in calls[0]).toBe(false);
  });
});
