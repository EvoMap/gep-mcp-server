// Copyright 2024-2026 EvoMap
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  buildValidationReport,
  computeAssetId,
  generateMessageId,
  geneToSkillMd,
  sanitizeSkillName,
  sanitizeTags,
  stampAsset,
  validateCapsule,
  validateGene,
  validateValidationReport,
} from './protocol.js';
import { SkillsService, defaultBundledRoot, defaultLocalRoot, clampPositive } from './skills.js';
import { applyCostThresholds } from './recallCostFilter.js';

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

// Endpoints that the Hub gates on a node-level Bearer secret rather than the
// user-level API key. /a2a/publish in particular returns a misleading
// `node_dead: zero credits + prolonged inactivity` reject when called with
// an API-key Bearer, even on a perfectly healthy node, because the gate
// reads "no node_secret presented" as "this node was never claimed by an
// agent runtime". Routes outside this set keep working with the API key
// (they only need user-scope auth).
const NODE_SECRET_REQUIRED_PATHS = new Set([
  '/a2a/publish',
  '/a2a/skill/store/publish',
  '/a2a/skill/store/update',
  '/a2a/skill/store/delete',
  '/a2a/revoke',
  '/a2a/report',
  '/a2a/hello',
  '/a2a/heartbeat',
]);

function pickBearer({ nodeSecret, apiKey }, path) {
  // Prefer node_secret on node-scoped endpoints when available; fall back to
  // the API key if the caller hasn't fetched/stored a secret yet.
  const pathname = path.split('?')[0];
  if (NODE_SECRET_REQUIRED_PATHS.has(pathname) && nodeSecret) return nodeSecret;
  return apiKey || nodeSecret;
}

export class RemoteRuntime {
  // `apiKey` (user-scope) authenticates read-mostly endpoints. `nodeSecret`
  // (node-scope, returned by POST /a2a/hello) is required for publish-side
  // endpoints. Pass at least one. If both are present we pick automatically
  // per endpoint.
  constructor({ hubUrl, nodeId, apiKey, nodeSecret, fetchImpl, sleepImpl }) {
    this.hubUrl = (hubUrl || DEFAULT_HUB_URL).replace(/\/+$/, '');
    this.nodeId = nodeId;
    this.apiKey = apiKey || null;
    this.nodeSecret = nodeSecret || null;
    if (!this.apiKey && !this.nodeSecret) {
      throw new Error('RemoteRuntime requires apiKey and/or nodeSecret');
    }
    this._fetch = fetchImpl || ((url, opts) => fetch(url, opts));
    this._sleep = sleepImpl || sleep;
    // Even in remote mode the agent can still pull `bundled` and `local` skills
    // off the host filesystem; only the `hub` source rides the network. Hub
    // endpoints are additive and may be missing on older Hub deploys, in
    // which case fetchSkillList/fetchSkill return empty + a warning.
    this.skills = new SkillsService({
      bundledRoot: defaultBundledRoot(null),
      localRoot: defaultLocalRoot(),
      hubFetch: (req) => this._hubSkillFetch(req),
      isRemote: true,
    });
  }

  listSkills(args) { return this.skills.listSkills(args || {}); }
  loadSkill(args) { return this.skills.loadSkill(args || {}); }

  async _hubSkillFetch({ op, name, version, query, limit }) {
    if (op === 'list') return this.fetchSkillList({ query, limit });
    if (op === 'fetch') return this.fetchSkill({ name, version });
    return null;
  }

  async fetchSkillList(args = {}) {
    try {
      const params = new URLSearchParams();
      if (args.query) params.set('q', String(args.query).slice(0, 200));
      params.set('limit', String(clampPositive(args.limit, 50, 200)));
      const path = `/a2a/skill/store/list${params.toString() ? '?' + params.toString() : ''}`;
      return await this._request('GET', path);
    } catch (err) {
      // Older Hub deploys return 404; treat as "no remote skills" rather than
      // a hard error so list_skill {source:"all"} still surfaces local +
      // bundled results.
      if (/returned 404/.test(err.message) || /returned 501/.test(err.message)) {
        return { skills: [], warning: `hub list endpoint unavailable: ${err.message}` };
      }
      throw err;
    }
  }

  async fetchSkill({ name, version } = {}) {
    if (!name) throw new Error('fetchSkill requires name');
    try {
      const params = new URLSearchParams({ name: String(name) });
      if (version) params.set('version', String(version));
      return await this._request('GET', `/a2a/skill/store/fetch?${params.toString()}`);
    } catch (err) {
      if (/returned 404/.test(err.message) || /returned 501/.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  async _request(method, path, body) {
    const url = `${this.hubUrl}${path}`;
    const bearer = pickBearer(this, path);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearer}`,
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
    const { query, signals, limit, max_cost_tokens, max_cost_usd } = args || {};
    const effectiveLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const response = await this._request('POST', '/a2a/memory/recall', {
      node_id: this.nodeId,
      query,
      signals,
      limit: effectiveLimit,
    });
    return applyCostThresholds(response, { max_cost_tokens, max_cost_usd });
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

  // -- publish / share --------------------------------------------------

  // Publish a Gene+Capsule bundle (and an optional EvolutionEvent) to the
  // Hub via /a2a/publish. The Hub dedupes on asset_id (sha256 over canonical
  // JSON) so repeated calls with the same content are idempotent.
  //
  // Mirrors evolver-private-dev/src/gep/a2aProtocol.js#buildPublishBundle:
  // payload = { assets: [Gene, Capsule, EvolutionEvent?], signature }.
  //
  // Auth: this endpoint is gated on the node-scoped Bearer secret returned
  // by POST /a2a/hello (NOT the user-level EVOMAP_API_KEY). Pass it via
  // the `nodeSecret` constructor option, or set EVOMAP_NODE_SECRET in the
  // environment when launching gep-mcp-server. With only an API key, the
  // Hub returns a misleading `node_dead: zero credits + prolonged
  // inactivity` reject even on a healthy claimed node.
  async publishBundle(args) {
    const { gene, capsule, event, chainId, modelName } = args || {};
    const geneErrors = validateGene(gene);
    const capsuleErrors = validateCapsule(capsule);
    const errors = [...geneErrors, ...capsuleErrors];
    if (errors.length > 0) {
      throw new Error('publishBundle validation failed: ' + errors.join('; '));
    }

    // Stamp asset_id + schema_version on every asset before computing the
    // bundle signature. Mutate copies so the caller's object stays clean.
    const geneCopy = { ...gene };
    const capsuleCopy = { ...capsule };
    if (modelName && typeof modelName === 'string') {
      geneCopy.model_name = modelName;
      capsuleCopy.model_name = modelName;
    }
    stampAsset(geneCopy);
    stampAsset(capsuleCopy);

    const assets = [geneCopy, capsuleCopy];
    if (event && event.type === 'EvolutionEvent') {
      const eventCopy = { ...event };
      if (modelName && typeof modelName === 'string') eventCopy.model_name = modelName;
      stampAsset(eventCopy);
      assets.push(eventCopy);
    }

    const message = {
      protocol: PROTOCOL_NAME,
      protocol_version: PROTOCOL_VERSION,
      message_type: 'publish',
      message_id: generateMessageId(),
      sender_id: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: {
        assets,
        ...(chainId && typeof chainId === 'string' ? { chain_id: chainId } : {}),
      },
    };

    const result = await this._request('POST', '/a2a/publish', message);
    return {
      ok: true,
      gene_asset_id: geneCopy.asset_id,
      capsule_asset_id: capsuleCopy.asset_id,
      event_asset_id: assets[2]?.asset_id || null,
      response: result,
    };
  }

  // Convert a Gene into a SKILL.md document and publish it to the Hub skill
  // store via /a2a/skill/store/publish. On 409 (already exists), automatically
  // upgrades to PUT /a2a/skill/store/update -- callers should not need to
  // distinguish "first publish" from "iterative update".
  async publishSkill(args) {
    const { gene, category, tags, changelog } = args || {};
    const geneErrors = validateGene(gene);
    if (geneErrors.length > 0) {
      throw new Error('publishSkill validation failed: ' + geneErrors.join('; '));
    }

    const content = geneToSkillMd(gene);
    const fmName = content.match(/^name:\s*(.+)$/m);
    const baseId = fmName ? fmName[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') : (gene.id || 'unnamed').replace(/^gene_/, '');
    const cleanedId = baseId.replace(/_?\d{10,}_?/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const skillId = 'skill_' + (cleanedId || 'unnamed');

    const cleanTags = sanitizeTags(tags && tags.length ? tags : gene.signals_match);
    const body = {
      sender_id: this.nodeId,
      skill_id: skillId,
      content,
      category: category || gene.category || null,
      tags: cleanTags,
    };

    try {
      const data = await this._request('POST', '/a2a/skill/store/publish', body);
      return { ok: true, skill_id: skillId, mode: 'create', response: data };
    } catch (err) {
      // Hub returns 409 on duplicate skill_id. Detect and retry as update.
      if (/returned 409/.test(err.message)) {
        const updateBody = { ...body, changelog: changelog || 'Iterative evolution update' };
        const data = await this._request('PUT', '/a2a/skill/store/update', updateBody);
        return { ok: true, skill_id: skillId, mode: 'update', response: data };
      }
      throw err;
    }
  }

  // Submit a ValidationReport to the Hub. Either pass a pre-built report
  // (already-stamped asset_id) or pass commands+results to build one here.
  // Hub endpoint: POST /a2a/report
  async submitValidationReport(args) {
    const { report, commands, results, geneId, targetAssetId, targetLocalId } = args || {};
    let finalReport;
    if (report && typeof report === 'object') {
      const errors = validateValidationReport(report);
      if (errors.length > 0) throw new Error('validationReport invalid: ' + errors.join('; '));
      finalReport = { ...report };
      if (!finalReport.asset_id) finalReport.asset_id = computeAssetId(finalReport);
    } else {
      finalReport = buildValidationReport({
        geneId: geneId || null,
        commands: Array.isArray(commands) ? commands : [],
        results: Array.isArray(results) ? results : [],
      });
    }

    const message = {
      protocol: PROTOCOL_NAME,
      protocol_version: PROTOCOL_VERSION,
      message_type: 'report',
      message_id: generateMessageId(),
      sender_id: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: {
        target_asset_id: targetAssetId || null,
        target_local_id: targetLocalId || null,
        validation_report: finalReport,
      },
    };

    const data = await this._request('POST', '/a2a/report', message);
    return {
      ok: true,
      report_id: finalReport.id,
      report_asset_id: finalReport.asset_id,
      overall_ok: finalReport.overall_ok,
      response: data,
    };
  }

  // Withdraw a previously published asset. Routes to one of two Hub
  // endpoints depending on what we are revoking:
  //   - Skills (localId starts with `skill_`) -> POST /a2a/skill/store/delete
  //   - Genes / Capsules / EvolutionEvents    -> POST /a2a/revoke (requires
  //     target_asset_id, since those are content-addressed and the Hub
  //     refuses to revoke by local_id alone)
  async revoke(args) {
    const { assetId, localId, reason } = args || {};
    if (!assetId && !localId) {
      throw new Error('revoke requires either assetId or localId');
    }

    // Skill store delete path -- localId tells us this is a skill.
    if (localId && /^skill_/.test(localId)) {
      const data = await this._request('POST', '/a2a/skill/store/delete', {
        sender_id: this.nodeId,
        skill_id: localId,
        reason: reason || null,
      });
      return { ok: true, kind: 'skill', skill_id: localId, response: data };
    }

    // Asset revoke path -- Hub requires asset_id.
    if (!assetId) {
      throw new Error('revoke of a Gene/Capsule requires assetId (sha256 content hash). For skills, pass localId starting with "skill_".');
    }

    const message = {
      protocol: PROTOCOL_NAME,
      protocol_version: PROTOCOL_VERSION,
      message_type: 'revoke',
      message_id: generateMessageId(),
      sender_id: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: {
        target_asset_id: assetId,
        target_local_id: localId || null,
        reason: reason || null,
      },
    };
    const data = await this._request('POST', '/a2a/revoke', message);
    return { ok: true, kind: 'asset', target_asset_id: assetId, target_local_id: localId || null, response: data };
  }

  // -- identity / audit -------------------------------------------------

  // GET /a2a/identity/:nodeId  (+ optional attestation)
  async getIdentity(args) {
    const targetNode = args?.nodeId || this.nodeId;
    const profile = await this._request('GET', `/a2a/identity/${encodeURIComponent(targetNode)}`);
    if (args?.includeAttestation) {
      try {
        const att = await this._request('GET', `/a2a/identity/${encodeURIComponent(targetNode)}/attestation`);
        return { ok: true, profile, attestation: att };
      } catch (err) {
        return { ok: true, profile, attestation_error: err.message };
      }
    }
    return { ok: true, profile };
  }

  // GET /a2a/audit/:nodeId?sender_id=... (Hub requires sender_id query)
  async getAuditLogs(args) {
    const targetNode = args?.nodeId || this.nodeId;
    const limit = Math.min(Math.max(1, parseInt(args?.limit, 10) || 50), 200);
    const offset = Math.max(0, parseInt(args?.offset, 10) || 0);
    const params = new URLSearchParams({
      sender_id: this.nodeId,
      limit: String(limit),
      offset: String(offset),
    });
    if (args?.action) params.set('action', String(args.action));
    if (args?.since) params.set('since', String(args.since));
    if (args?.until) params.set('until', String(args.until));
    return this._request('GET', `/a2a/audit/${encodeURIComponent(targetNode)}?${params}`);
  }

  // -- introspection ---------------------------------------------------

  // Convenience: schema/protocol versions baked into this MCP build. Useful
  // for Hub-side compatibility checks and for agents auditing their own
  // toolchain version.
  getProtocolInfo() {
    return {
      schema_version: SCHEMA_VERSION,
      protocol_name: PROTOCOL_NAME,
      protocol_version: PROTOCOL_VERSION,
      mode: 'remote',
      node_id: this.nodeId,
      hub_url: this.hubUrl,
    };
  }
}
