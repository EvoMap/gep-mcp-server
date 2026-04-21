const DEFAULT_HUB_URL = 'https://evomap.ai';
const TIMEOUT_MS = 15000;

// Retry only for transient upstream failures (network errors, 502/503/504, 429).
// Idempotent writes are whitelisted because the Hub dedupes on (node_id, summary, ts).
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const IDEMPOTENT_WRITE_PATHS = new Set([
  '/a2a/memory/record',
  '/a2a/memory/recall',
]);
const RETRY_DELAYS_MS = [300, 900, 2100];

function isIdempotentRequest(method, path) {
  if (method === 'GET' || method === 'HEAD') return true;
  const pathname = path.split('?')[0];
  return IDEMPOTENT_WRITE_PATHS.has(pathname);
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 5000);
  }
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    if (diff > 0) return Math.min(diff, 5000);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RemoteRuntime {
  constructor({ hubUrl, nodeId, apiKey, fetchImpl, sleepImpl }) {
    this.hubUrl = (hubUrl || DEFAULT_HUB_URL).replace(/\/+$/, '');
    this.nodeId = nodeId;
    this.apiKey = apiKey;
    this._fetch = fetchImpl || ((url, opts) => fetch(url, opts));
    this._sleep = sleepImpl || sleep;
  }

  async _request(method, path, body) {
    const url = `${this.hubUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    const canRetry = isIdempotentRequest(method, path);
    const maxAttempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1;
    const payload = body ? JSON.stringify(body) : undefined;

    let lastError;
    let lastStatus;
    let lastText = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const opts = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (payload !== undefined) opts.body = payload;

      let res;
      try {
        res = await this._fetch(url, opts);
      } catch (err) {
        lastError = err;
        lastStatus = null;
        if (!canRetry || attempt === maxAttempts) {
          throw new Error(
            `Hub ${method} ${path} failed after ${attempt} attempt(s): ${err.message || err}`
          );
        }
        await this._sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }

      if (res.ok) return res.json();

      lastText = await res.text().catch(() => '');
      lastStatus = res.status;
      lastError = null;

      const transient = TRANSIENT_STATUSES.has(res.status);
      if (!transient || !canRetry || attempt === maxAttempts) {
        throw new Error(
          `Hub ${method} ${path} returned ${res.status} after ${attempt} attempt(s): ${lastText.slice(0, 200)}`
        );
      }

      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const delay = retryAfter ?? RETRY_DELAYS_MS[attempt - 1];
      await this._sleep(delay);
    }

    const detail = lastStatus != null
      ? `status ${lastStatus}: ${lastText.slice(0, 200)}`
      : (lastError?.message ?? 'unknown');
    throw new Error(`Hub ${method} ${path} exhausted retries: ${detail}`);
  }

  async recall(args) {
    const { query, signals, limit } = args || {};
    const effectiveLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    return this._request('POST', '/a2a/memory/recall', {
      node_id: this.nodeId,
      query,
      signals,
      limit: effectiveLimit,
    });
  }

  async recordOutcome(args) {
    const { geneId, signals, status, score, summary } = args || {};
    return this._request('POST', '/a2a/memory/record', {
      node_id: this.nodeId,
      signals,
      gene_id: geneId,
      status,
      score,
      summary,
    });
  }

  async getStatus() {
    return this._request('GET', `/a2a/memory/status?node_id=${encodeURIComponent(this.nodeId)}`);
  }

  async evolve(args) {
    const { context, intent } = args || {};
    const intentSignals = intent ? [`intent:${intent}`] : [];
    const recallResult = await this.recall({ query: context, signals: intentSignals.length ? intentSignals : null });
    const signals = recallResult.signals_extracted || [];

    let communityGenes = [];
    try {
      const searchQuery = intent
        ? `${intent} ${(context || '').slice(0, 150)}`
        : (context || '').slice(0, 200);
      const params = new URLSearchParams({ q: searchQuery, type: 'Gene', limit: '5' });
      const searchResult = await this._request('GET', `/a2a/assets/semantic-search?${params}`);
      communityGenes = (searchResult.assets || []).slice(0, 3);
    } catch { /* best effort */ }

    const matches = recallResult.matches || [];
    const bestMatch = matches.length > 0 ? matches[0] : null;

    const actionableAdvice = [];
    if (bestMatch) {
      const status = bestMatch.outcome?.status || bestMatch.status;
      const summary = bestMatch.outcome?.summary || bestMatch.summary || '';
      if (status === 'success') {
        actionableAdvice.push(`Prior success (score ${bestMatch.score ?? 'N/A'}): ${summary}`);
        actionableAdvice.push('Follow the same approach unless context has changed.');
      } else if (status === 'failed') {
        actionableAdvice.push(`Prior failure: ${summary}`);
        actionableAdvice.push('Avoid repeating this approach -- try a different strategy.');
      }
    }

    const geneStrategies = communityGenes
      .filter(g => g.strategy || g.strategy_steps)
      .map(g => ({
        id: g.asset_id || g.id,
        category: g.category,
        summary: g.summary || g.description,
        strategy: g.strategy || g.strategy_steps,
      }));

    return {
      ok: true,
      mode: 'remote',
      intent: intent || null,
      signals,
      recall_matches: matches,
      best_match_advice: actionableAdvice.length > 0 ? actionableAdvice : null,
      community_genes: communityGenes.map(g => ({
        id: g.asset_id || g.id,
        category: g.category,
        summary: g.summary || g.description,
      })),
      gene_strategies: geneStrategies.length > 0 ? geneStrategies : null,
      instructions: [
        ...(actionableAdvice.length > 0
          ? ['Apply the advice from prior experience above.']
          : ['No prior experience found. Proceed with best judgment.']),
        ...(geneStrategies.length > 0
          ? ['Community gene strategies are available -- review and apply if relevant.']
          : []),
        'After completing the task, call gep_record_outcome to record the result.',
      ],
    };
  }

  async listGenes(args) {
    try {
      const params = new URLSearchParams({ q: args?.category || 'evolution strategy', type: 'Gene', limit: '20' });
      const result = await this._request('GET', `/a2a/assets/semantic-search?${params}`);
      return {
        total: (result.assets || []).length,
        source: 'hub',
        genes: (result.assets || []).map(g => ({
          id: g.asset_id || g.id,
          category: g.category,
          summary: g.summary || g.description,
        })),
      };
    } catch (err) {
      return { total: 0, source: 'hub', genes: [], error: err.message };
    }
  }

  async searchCommunity(args) {
    const params = new URLSearchParams();
    params.set('q', (args?.query || '').slice(0, 500));
    if (args?.type) params.set('type', args.type);
    if (args?.outcome) params.set('outcome', args.outcome);
    params.set('limit', String(Math.min(Math.max(1, parseInt(args?.limit, 10) || 10), 50)));
    params.set('include_context', 'true');
    return this._request('GET', `/a2a/assets/semantic-search?${params}`);
  }
}
