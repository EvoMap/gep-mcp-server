import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, copyFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MAX_BYTES = 64000;
// Names that should not surface in `gep_list_skill` by default. `_meta` is
// the bootstrap skill (already injected at agent startup) and `index.json`
// is the bundled-skill catalog file, never a real skill.
const HIDDEN_NAMES = new Set(['_meta', 'index.json']);

// Minimal SKILL.md frontmatter parser. Mirrors the helper in
// evolver-private-dev/scripts/build_public.js so the two stay in sync — both
// must produce the same descriptor shape for the bundled-skill index.
export function parseFrontmatter(md) {
  const text = String(md || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const out = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1].toLowerCase()] = val;
  }
  return out;
}

export function defaultBundledRoot(assetsDir) {
  if (process.env.EVOLVER_SKILLS_DIR) return resolve(process.env.EVOLVER_SKILLS_DIR);
  // ASSETS_DIR defaults to <evolver-install>/assets/gep, so the bundled
  // skills tree lives two levels up at <evolver-install>/skills.
  if (assetsDir) return resolve(assetsDir, '..', '..', 'skills');
  return null;
}

export function defaultLocalRoot() {
  if (process.env.CLAUDE_SKILLS_DIR) return resolve(process.env.CLAUDE_SKILLS_DIR);
  return join(homedir(), '.claude', 'skills');
}

export class SkillsService {
  constructor({ bundledRoot, localRoot, hubFetch, isRemote }) {
    this.bundledRoot = bundledRoot || null;
    this.localRoot = localRoot || null;
    this.hubFetch = typeof hubFetch === 'function' ? hubFetch : null;
    this.isRemote = !!isRemote;
    this._scanCache = new Map();
  }

  async listSkills({ source = 'all', query, limit = 50 } = {}) {
    const wanted = source === 'all' ? ['local', 'bundled', 'hub'] : [source];
    const cap = clampLimit(limit, 50, 200);
    const out = [];
    const claimed = new Set();
    const warnings = [];

    for (const src of wanted) {
      let list = [];
      try {
        if (src === 'bundled') list = this._listBundled();
        else if (src === 'local') list = this._listLocal();
        else if (src === 'hub') {
          if (!this.hubFetch) { warnings.push('hub source unavailable: remote auth not configured'); continue; }
          list = await this._listHub();
        } else {
          warnings.push(`unknown source: ${src}`);
          continue;
        }
      } catch (err) {
        warnings.push(`${src} list failed: ${err.message}`);
        continue;
      }
      for (const item of list) {
        if (HIDDEN_NAMES.has(item.name) && !query) continue;
        if (query && !matchesQuery(item, query)) continue;
        const key = item.name;
        // First source to claim a name keeps it; later sources get prefixed
        // so collisions stay addressable.
        const entry = claimed.has(key)
          ? { ...item, name: `${src}:${key}`, source: src }
          : { ...item, source: src };
        if (!claimed.has(key)) claimed.add(key);
        out.push(entry);
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    }

    const result = { skills: out };
    if (warnings.length) result.warnings = warnings;
    return result;
  }

  async loadSkill({
    name, source, version, install = false, force = false,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    if (!name || typeof name !== 'string') throw new Error('name is required');

    // Allow disambiguation via "source:name" syntax (mirrors how listSkills
    // surfaces collisions).
    let resolvedSource = source || null;
    let resolvedName = name;
    const colon = name.indexOf(':');
    if (!resolvedSource && colon > 0) {
      const prefix = name.slice(0, colon);
      if (['bundled', 'local', 'hub'].includes(prefix)) {
        resolvedSource = prefix;
        resolvedName = name.slice(colon + 1);
      }
    }

    const order = resolvedSource ? [resolvedSource] : ['local', 'bundled', 'hub'];
    let found = null;
    for (const src of order) {
      const candidate = await this._readOne(src, resolvedName, version);
      if (candidate) { found = { ...candidate, source: src }; break; }
    }
    if (!found) {
      throw new Error(`skill not found: ${resolvedName}${resolvedSource ? ' (source=' + resolvedSource + ')' : ''}`);
    }

    if (install) {
      if (this.isRemote) {
        return {
          ok: false,
          error: 'local_only',
          hint: 'gep_load_skill install:true requires local mode (sets ASSETS_DIR/MEMORY_DIR rather than EVOMAP_API_KEY).',
        };
      }
      return this._install(found, { force });
    }

    const limit = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    let content = found.content;
    let truncated = false;
    if (Buffer.byteLength(content, 'utf8') > limit) {
      content = content.slice(0, limit) + '\n\n[...truncated; pass install:true to access the full skill...]';
      truncated = true;
    }
    return {
      ok: true,
      name: found.name,
      source: found.source,
      version: found.version || null,
      description: found.description || null,
      content,
      truncated,
    };
  }

  // ---------- internals ----------

  _listBundled() {
    if (!this.bundledRoot) return [];
    const indexPath = join(this.bundledRoot, 'index.json');
    if (existsSync(indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
        if (Array.isArray(raw)) return raw.map(x => ({ ...x }));
      } catch {
        // Fall through to directory scan if index.json is malformed.
      }
    }
    if (!existsSync(this.bundledRoot)) return [];
    return this._scanDir(this.bundledRoot);
  }

  _listLocal() {
    if (!this.localRoot || !existsSync(this.localRoot)) return [];
    return this._scanDir(this.localRoot);
  }

  async _listHub() {
    if (!this.hubFetch) return [];
    const data = await this.hubFetch({ op: 'list' });
    if (Array.isArray(data?.skills)) return data.skills;
    if (Array.isArray(data?.assets)) {
      return data.assets.map(a => ({
        name: a.name || a.skill_id || a.id,
        version: a.version || null,
        description: a.description || a.summary || null,
        tags: Array.isArray(a.tags) ? a.tags : [],
        sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : null,
      }));
    }
    return [];
  }

  _scanDir(rootAbs) {
    const out = [];
    let entries;
    try { entries = readdirSync(rootAbs, { withFileTypes: true }); }
    catch { return []; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = join(rootAbs, ent.name);
      const md = join(dir, 'SKILL.md');
      if (!existsSync(md)) continue;
      const stat = statSync(md);
      const cached = this._scanCache.get(md);
      if (cached && cached.mtime === stat.mtimeMs) {
        out.push(cached.descriptor);
        continue;
      }
      const fm = parseFrontmatter(readFileSync(md, 'utf8'));
      const desc = {
        name: fm.name || ent.name,
        dir: ent.name,
        version: fm.version || null,
        description: fm.description || null,
        tags: fm.tags ? String(fm.tags).split(/\s*,\s*/).filter(Boolean) : [],
        sizeBytes: stat.size,
      };
      this._scanCache.set(md, { mtime: stat.mtimeMs, descriptor: desc });
      out.push(desc);
    }
    return out;
  }

  async _readOne(src, name, version) {
    if (src === 'bundled' || src === 'local') {
      const root = src === 'bundled' ? this.bundledRoot : this.localRoot;
      if (!root) return null;
      const list = src === 'bundled' ? this._listBundled() : this._listLocal();
      const entry = list.find(x => x.name === name) || list.find(x => x.dir === name);
      if (!entry) return null;
      const dir = entry.dir || entry.name;
      const md = join(root, dir, 'SKILL.md');
      if (!existsSync(md)) return null;
      return {
        name: entry.name,
        version: entry.version || null,
        description: entry.description || null,
        tags: entry.tags || [],
        dir,
        rootAbs: root,
        content: readFileSync(md, 'utf8'),
      };
    }
    if (src === 'hub') {
      if (!this.hubFetch) return null;
      const data = await this.hubFetch({ op: 'fetch', name, version });
      if (!data || !data.content) return null;
      return {
        name: data.name || name,
        version: data.version || null,
        description: data.description || null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        content: String(data.content),
      };
    }
    return null;
  }

  _install(found, { force }) {
    if (!this.localRoot) throw new Error('local skill root not configured');
    const safeName = found.name.replace(/[/\\:]/g, '_');
    const targetDir = join(this.localRoot, safeName);
    if (existsSync(targetDir) && !force) {
      throw new Error(`skill already installed at ${targetDir}; pass force:true to overwrite`);
    }
    mkdirSync(targetDir, { recursive: true });
    if (found.rootAbs && found.dir) {
      copyDir(join(found.rootAbs, found.dir), targetDir);
    } else {
      writeFileSync(join(targetDir, 'SKILL.md'), found.content, 'utf8');
    }
    return {
      ok: true,
      name: found.name,
      installedPath: targetDir,
      message: `Installed to ${targetDir}. Restart Claude Code or invoke the native Skill tool with name=${found.name}.`,
    };
  }
}

function matchesQuery(item, query) {
  const q = String(query).toLowerCase();
  return [item.name, item.description, ...(item.tags || [])]
    .filter(Boolean)
    .some(s => String(s).toLowerCase().includes(q));
}

function clampLimit(value, defaultV, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultV;
  return Math.min(n, max);
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) copyFileSync(s, d);
  }
}
