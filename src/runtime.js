import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SCHEMA_VERSION = '1.5.0';

export class GepRuntime {
  constructor({ assetsDir, memoryDir }) {
    this.assetsDir = assetsDir;
    this.memoryDir = memoryDir;
    this.store = new SimpleStore(assetsDir);
    this.memoryGraphPath = join(memoryDir, 'memory_graph.jsonl');
    mkdirSync(assetsDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    this.store.ensureFiles();
  }

  evolve({ context, intent }) {
    const signals = this._extractSignals(context);

    if (intent) {
      const intentSignalMap = {
        repair: 'log_error',
        innovate: 'stable_success_plateau',
        optimize: 'user_improvement_suggestion',
      };
      if (intentSignalMap[intent] && !signals.includes(intentSignalMap[intent])) {
        signals.unshift(intentSignalMap[intent]);
      }
    }

    const genes = this.store.loadGenes();
    const capsules = this.store.loadCapsules();
    const memoryAdvice = this._getMemoryAdvice(signals, genes);
    const { selected, alternatives } = this._selectGene(genes, signals, memoryAdvice);

    if (!selected) {
      return {
        ok: false,
        signals,
        message: 'No matching gene found for these signals. A new gene may need to be created.',
        suggestion: 'Use gep_install_gene to add a gene that matches these signal patterns.',
      };
    }

    const category = this._inferCategory(signals, intent);
    const mutation = {
      type: 'Mutation',
      id: `mut_${Date.now()}`,
      category,
      trigger_signals: signals,
      target: `gene:${selected.id}`,
      expected_effect: this._effectFromCategory(category),
      risk_level: category === 'innovate' ? 'medium' : 'low',
    };

    this._recordToGraph({
      kind: 'attempt',
      signals,
      gene: { id: selected.id, category: selected.category },
      mutation: { id: mutation.id, category: mutation.category, risk_level: mutation.risk_level },
    });

    const matchingCapsule = this._selectCapsule(capsules, signals);

    return {
      ok: true,
      signals,
      selected_gene: {
        id: selected.id,
        category: selected.category,
        strategy: selected.strategy,
        constraints: selected.constraints,
        validation: selected.validation,
      },
      mutation,
      alternatives: alternatives.map(g => ({ id: g.id, category: g.category })),
      matching_capsule: matchingCapsule ? {
        id: matchingCapsule.id,
        gene: matchingCapsule.gene,
        summary: matchingCapsule.summary,
        confidence: matchingCapsule.confidence,
      } : null,
      memory_advice: {
        preferred: memoryAdvice.preferredGeneId,
        banned_count: memoryAdvice.bannedGeneIds.size,
      },
      instructions: [
        'Follow the gene strategy steps in order.',
        `Constraint: modify at most ${selected.constraints?.max_files || 12} files.`,
        `Forbidden paths: ${(selected.constraints?.forbidden_paths || []).join(', ')}`,
        'After applying changes, run validation commands to verify correctness.',
        'Then call gep_record_outcome with the result.',
      ],
    };
  }

  recall({ query, signals }) {
    const events = this._readGraphEvents(500);
    const querySignals = signals || this._extractSignals(query);
    const queryKey = this._computeSignalKey(querySignals);

    const outcomes = events.filter(e => e.kind === 'outcome');
    const relevant = [];

    for (const ev of outcomes) {
      const evKey = ev.signal?.key || '';
      const evSignals = ev.signal?.signals || [];
      const sim = this._jaccard(querySignals, evSignals);
      if (sim >= 0.2 || evKey === queryKey) {
        relevant.push({
          signal_key: evKey,
          gene_id: ev.gene?.id,
          gene_category: ev.gene?.category,
          outcome: ev.outcome,
          similarity: Math.round(sim * 100) / 100,
          timestamp: ev.ts,
        });
      }
    }

    relevant.sort((a, b) => b.similarity - a.similarity);

    return {
      query,
      signals_extracted: querySignals,
      matches: relevant.slice(0, 10),
      total_memory_events: events.length,
    };
  }

  recordOutcome({ geneId, signals, status, score, summary }) {
    const signalKey = this._computeSignalKey(signals);
    const ev = {
      type: 'MemoryGraphEvent',
      kind: 'outcome',
      id: `mge_${Date.now()}_${this._stableHash(`${signalKey}|${geneId}|outcome`)}`,
      ts: new Date().toISOString(),
      signal: { key: signalKey, signals },
      gene: { id: geneId },
      outcome: { status, score: clamp01(score), note: summary || null },
    };
    this._appendToGraph(ev);

    if (status === 'success' && score >= 0.5) {
      const capsule = {
        type: 'Capsule',
        schema_version: SCHEMA_VERSION,
        id: `capsule_${Date.now()}`,
        trigger: signals,
        gene: geneId,
        summary: summary || `Evolution with ${geneId}: ${status}`,
        confidence: clamp01(score),
        blast_radius: { files: 0, lines: 0 },
        outcome: { status, score: clamp01(score) },
        success_streak: 1,
      };
      capsule.asset_id = this._computeAssetId(capsule);
      this.store.upsertCapsule(capsule);
    }

    return { ok: true, recorded: ev.id };
  }

  listGenes({ category } = {}) {
    let genes = this.store.loadGenes();
    if (category) genes = genes.filter(g => g.category === category);
    return {
      total: genes.length,
      genes: genes.map(g => ({
        id: g.id,
        category: g.category,
        signals_match: g.signals_match,
        strategy_steps: g.strategy?.length || 0,
        constraints: g.constraints,
      })),
    };
  }

  installGene({ gene }) {
    if (!gene || gene.type !== 'Gene' || !gene.id) {
      return { ok: false, error: 'Invalid gene: must have type="Gene" and a non-empty id' };
    }
    if (!gene.schema_version) gene.schema_version = SCHEMA_VERSION;
    if (!gene.asset_id) gene.asset_id = this._computeAssetId(gene);
    this.store.upsertGene(gene);
    return { ok: true, installed: gene.id };
  }

  exportEvolution({ outputPath, agentName }) {
    const tmpDir = `${outputPath}.tmp`;
    mkdirSync(join(tmpDir, 'genes'), { recursive: true });
    mkdirSync(join(tmpDir, 'capsules'), { recursive: true });
    mkdirSync(join(tmpDir, 'events'), { recursive: true });
    mkdirSync(join(tmpDir, 'memory'), { recursive: true });

    const copies = [
      [join(this.assetsDir, 'genes.json'), join(tmpDir, 'genes', 'genes.json')],
      [join(this.assetsDir, 'capsules.json'), join(tmpDir, 'capsules', 'capsules.json')],
      [join(this.assetsDir, 'events.jsonl'), join(tmpDir, 'events', 'events.jsonl')],
      [this.memoryGraphPath, join(tmpDir, 'memory', 'memory_graph.jsonl')],
    ];

    for (const [src, dest] of copies) {
      if (existsSync(src)) writeFileSync(dest, readFileSync(src));
    }

    const manifest = {
      gep_version: '1.0.0',
      schema_version: SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      agent_name: agentName || 'unknown',
      statistics: this.getStatus().statistics,
      source: { platform: 'gep-mcp-server', version: '1.0.0' },
    };
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    execFileSync('tar', ['-czf', outputPath, '-C', tmpDir, '.'], { timeout: 30000 });
    rmSync(tmpDir, { recursive: true, force: true });

    return { ok: true, outputPath, manifest };
  }

  getStatus() {
    const genes = this.store.loadGenes();
    const capsules = this.store.loadCapsules();
    const events = this.store.readAllEvents();
    const graphEvents = this._readGraphEvents(100);

    const recentEvents = events.slice(-5).map(e => ({
      id: e.id,
      intent: e.intent,
      outcome: e.outcome?.status,
      score: e.outcome?.score,
    }));

    const successCount = events.filter(e => e.outcome?.status === 'success').length;

    return {
      schema_version: SCHEMA_VERSION,
      statistics: {
        total_genes: genes.length,
        total_capsules: capsules.length,
        total_events: events.length,
        memory_graph_entries: graphEvents.length,
        success_rate: events.length > 0 ? Math.round((successCount / events.length) * 100) / 100 : 0,
      },
      recent_events: recentEvents,
      gene_categories: {
        repair: genes.filter(g => g.category === 'repair').length,
        optimize: genes.filter(g => g.category === 'optimize').length,
        innovate: genes.filter(g => g.category === 'innovate').length,
      },
    };
  }

  _extractSignals(context) {
    const signals = [];
    const text = String(context || '');
    const lower = text.toLowerCase();

    if (/\[error\]|error:|exception:|"status":\s*"error"/.test(lower)) signals.push('log_error');
    if (/\b(add|implement|create|build)\b[^.]{3,60}\b(feature|function|module|capability)\b/i.test(text)) {
      signals.push('user_feature_request');
    }
    if (/\b(i want|i need|we need|please add)\b/i.test(lower)) signals.push('user_feature_request');
    if (/\b(improve|enhance|upgrade|refactor|optimize)\b/i.test(lower) && !signals.includes('log_error')) {
      signals.push('user_improvement_suggestion');
    }
    if (/\b(slow|timeout|latency|bottleneck|performance)\b/i.test(lower)) signals.push('perf_bottleneck');
    if (/\b(not supported|cannot|unsupported|missing feature)\b/i.test(lower)) signals.push('capability_gap');
    if (signals.length === 0) signals.push('stable_success_plateau');
    return [...new Set(signals)];
  }

  _selectGene(genes, signals, advice) {
    const bannedIds = advice?.bannedGeneIds || new Set();
    const scored = genes
      .map(g => {
        const pats = Array.isArray(g.signals_match) ? g.signals_match : [];
        let score = 0;
        for (const p of pats) {
          const needle = String(p).toLowerCase();
          if (signals.some(s => s.toLowerCase().includes(needle))) score++;
        }
        return { gene: g, score };
      })
      .filter(x => x.score > 0 && !bannedIds.has(x.gene.id))
      .sort((a, b) => b.score - a.score);

    if (advice?.preferredGeneId) {
      const preferred = scored.find(x => x.gene.id === advice.preferredGeneId);
      if (preferred) {
        const rest = scored.filter(x => x.gene.id !== advice.preferredGeneId);
        return { selected: preferred.gene, alternatives: rest.slice(0, 4).map(x => x.gene) };
      }
    }

    return {
      selected: scored.length > 0 ? scored[0].gene : null,
      alternatives: scored.slice(1, 5).map(x => x.gene),
    };
  }

  _selectCapsule(capsules, signals) {
    const scored = (capsules || [])
      .map(c => {
        const triggers = Array.isArray(c.trigger) ? c.trigger : [];
        const score = triggers.reduce((acc, t) => {
          return signals.some(s => s.toLowerCase().includes(String(t).toLowerCase())) ? acc + 1 : acc;
        }, 0);
        return { capsule: c, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.length > 0 ? scored[0].capsule : null;
  }

  _getMemoryAdvice(signals, genes) {
    const events = this._readGraphEvents(1000);
    const edges = new Map();
    for (const ev of events) {
      if (ev.kind !== 'outcome') continue;
      const k = `${ev.signal?.key || ''}::${ev.gene?.id || ''}`;
      const cur = edges.get(k) || { success: 0, fail: 0 };
      if (ev.outcome?.status === 'success') cur.success++;
      else if (ev.outcome?.status === 'failed') cur.fail++;
      edges.set(k, cur);
    }

    const curKey = this._computeSignalKey(signals);
    const bannedGeneIds = new Set();
    let bestGeneId = null;
    let bestScore = -1;

    for (const g of genes) {
      if (!g?.id) continue;
      const k = `${curKey}::${g.id}`;
      const edge = edges.get(k);
      if (!edge) continue;
      const total = edge.success + edge.fail;
      const p = (edge.success + 1) / (total + 2);
      if (total >= 2 && p < 0.35) bannedGeneIds.add(g.id);
      if (p > bestScore) { bestScore = p; bestGeneId = g.id; }
    }

    return { preferredGeneId: bestGeneId, bannedGeneIds };
  }

  _inferCategory(signals, forceIntent) {
    if (forceIntent && ['repair', 'optimize', 'innovate'].includes(forceIntent)) return forceIntent;
    if (signals.some(s => s === 'log_error' || s.startsWith('errsig:'))) return 'repair';
    const oppSignals = ['user_feature_request', 'capability_gap', 'stable_success_plateau', 'force_innovation_after_repair_loop'];
    if (signals.some(s => oppSignals.includes(s))) return 'innovate';
    return 'optimize';
  }

  _effectFromCategory(cat) {
    if (cat === 'repair') return 'reduce runtime errors, increase stability';
    if (cat === 'innovate') return 'explore new strategy combinations';
    return 'improve success rate and efficiency';
  }

  _readGraphEvents(limit = 1000) {
    try {
      if (!existsSync(this.memoryGraphPath)) return [];
      const raw = readFileSync(this.memoryGraphPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      return lines.slice(Math.max(0, lines.length - limit)).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  _appendToGraph(event) {
    mkdirSync(this.memoryDir, { recursive: true });
    appendFileSync(this.memoryGraphPath, JSON.stringify(event) + '\n', 'utf8');
  }

  _recordToGraph({ kind, signals, gene, mutation }) {
    const ev = {
      type: 'MemoryGraphEvent',
      kind,
      id: `mge_${Date.now()}_${this._stableHash(JSON.stringify({ kind, signals, gene }))}`,
      ts: new Date().toISOString(),
      signal: { key: this._computeSignalKey(signals), signals },
      gene: gene || null,
      mutation: mutation || null,
    };
    this._appendToGraph(ev);
  }

  _computeSignalKey(signals) {
    return [...new Set((signals || []).map(String).filter(Boolean))].sort().join('|') || '(none)';
  }

  _stableHash(input) {
    const s = String(input || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  _jaccard(a, b) {
    const setA = new Set(a.map(String));
    const setB = new Set(b.map(String));
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    return inter / (setA.size + setB.size - inter);
  }

  _computeAssetId(obj) {
    const clean = {};
    for (const k of Object.keys(obj)) {
      if (k === 'asset_id') continue;
      clean[k] = obj[k];
    }
    const canonical = this._canonicalize(clean);
    return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  _canonicalize(obj) {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj === 'boolean') return obj ? 'true' : 'false';
    if (typeof obj === 'number') return Number.isFinite(obj) ? String(obj) : 'null';
    if (typeof obj === 'string') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(x => this._canonicalize(x)).join(',') + ']';
    if (typeof obj === 'object') {
      const keys = Object.keys(obj).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + this._canonicalize(obj[k])).join(',') + '}';
    }
    return 'null';
  }
}

class SimpleStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  loadGenes() {
    const data = readJsonSafe(join(this.dir, 'genes.json'), { genes: [] });
    return Array.isArray(data.genes) ? data.genes : [];
  }

  loadCapsules() {
    const data = readJsonSafe(join(this.dir, 'capsules.json'), { capsules: [] });
    return Array.isArray(data.capsules) ? data.capsules : [];
  }

  readAllEvents() {
    return readJsonl(join(this.dir, 'events.jsonl'));
  }

  upsertGene(gene) {
    const data = readJsonSafe(join(this.dir, 'genes.json'), { version: 1, genes: [] });
    const genes = Array.isArray(data.genes) ? data.genes : [];
    const idx = genes.findIndex(g => g?.id === gene.id);
    if (idx >= 0) genes[idx] = gene; else genes.push(gene);
    writeJsonAtomic(join(this.dir, 'genes.json'), { version: data.version || 1, genes });
  }

  upsertCapsule(capsule) {
    const data = readJsonSafe(join(this.dir, 'capsules.json'), { version: 1, capsules: [] });
    const capsules = Array.isArray(data.capsules) ? data.capsules : [];
    const idx = capsules.findIndex(c => c?.id === capsule.id);
    if (idx >= 0) capsules[idx] = capsule; else capsules.push(capsule);
    writeJsonAtomic(join(this.dir, 'capsules.json'), { version: data.version || 1, capsules });
  }

  ensureFiles() {
    const files = [
      [join(this.dir, 'genes.json'), JSON.stringify({ version: 1, genes: [] }, null, 2)],
      [join(this.dir, 'capsules.json'), JSON.stringify({ version: 1, capsules: [] }, null, 2)],
      [join(this.dir, 'events.jsonl'), ''],
    ];
    for (const [path, content] of files) {
      if (!existsSync(path)) writeFileSync(path, content + '\n', 'utf8');
    }
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function readJsonl(filePath) {
  try {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, filePath);
}

function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
