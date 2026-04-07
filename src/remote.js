const DEFAULT_HUB_URL = 'https://evomap.ai';
const TIMEOUT_MS = 15000;

export class RemoteRuntime {
  constructor({ hubUrl, nodeId, apiKey }) {
    this.hubUrl = (hubUrl || DEFAULT_HUB_URL).replace(/\/+$/, '');
    this.nodeId = nodeId;
    this.apiKey = apiKey;
  }

  async _request(method, path, body) {
    const url = `${this.hubUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    const opts = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hub ${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
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
