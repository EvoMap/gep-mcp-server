// GEP protocol primitives shared between local and remote runtimes.
//
// These helpers are intentionally dependency-free so they can run inside the
// MCP server (no Node-only crypto outside what ships with Node 18+) and also
// be unit-tested without spinning up the full Hub.
//
// Schema/protocol versions tracked here MUST stay in lockstep with
// evolver-private-dev: bumping SCHEMA_VERSION here without a matching
// Hub deployment will fail validation on the receiving side.

import { createHash } from 'node:crypto';

// Bump MINOR for additive fields; MAJOR for breaking changes.
// Mirrors evolver-private-dev/src/gep/contentHash.js.
export const SCHEMA_VERSION = '1.6.0';
export const PROTOCOL_NAME = 'gep-a2a';
export const PROTOCOL_VERSION = '1.0.0';

// Canonical JSON: deterministic serialization with sorted keys at all levels.
// Arrays preserve order; non-finite numbers and undefined become null.
// MUST match evolver canonicalize() byte-for-byte so asset_ids dedupe across
// runtimes.
export function canonicalize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return 'null';
    return String(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = [];
    for (const k of keys) {
      pairs.push(JSON.stringify(k) + ':' + canonicalize(obj[k]));
    }
    return '{' + pairs.join(',') + '}';
  }
  return 'null';
}

// Compute a content-addressable asset ID. Excludes self-referential fields
// (asset_id itself) from the hash input. Returns "sha256:<hex>".
export function computeAssetId(obj, excludeFields) {
  if (!obj || typeof obj !== 'object') return null;
  const exclude = new Set(Array.isArray(excludeFields) ? excludeFields : ['asset_id']);
  const clean = {};
  for (const k of Object.keys(obj)) {
    if (exclude.has(k)) continue;
    clean[k] = obj[k];
  }
  const canonical = canonicalize(clean);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return 'sha256:' + hash;
}

export function generateMessageId() {
  return 'msg_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10);
}

// Attach asset_id and schema_version to an asset object in place.
// Returns the same object for chaining.
export function stampAsset(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  if (!asset.schema_version) asset.schema_version = SCHEMA_VERSION;
  // Always recompute asset_id on stamp so callers can mutate fields after
  // building and we still ship the right hash on the wire.
  asset.asset_id = computeAssetId(asset);
  return asset;
}

// Validate a Gene asset has the minimum required shape for /a2a/publish.
export function validateGene(gene) {
  const errors = [];
  if (!gene || typeof gene !== 'object') {
    return ['gene must be an object'];
  }
  if (gene.type !== 'Gene') errors.push('gene.type must be "Gene"');
  if (!gene.id || typeof gene.id !== 'string') errors.push('gene.id is required');
  if (!gene.category || !['repair', 'optimize', 'innovate'].includes(gene.category)) {
    errors.push('gene.category must be repair|optimize|innovate');
  }
  if (!Array.isArray(gene.signals_match) || gene.signals_match.length === 0) {
    errors.push('gene.signals_match must be a non-empty array');
  }
  return errors;
}

export function validateCapsule(capsule) {
  const errors = [];
  if (!capsule || typeof capsule !== 'object') return ['capsule must be an object'];
  if (capsule.type !== 'Capsule') errors.push('capsule.type must be "Capsule"');
  if (!capsule.id || typeof capsule.id !== 'string') errors.push('capsule.id is required');
  if (!Array.isArray(capsule.trigger) || capsule.trigger.length === 0) {
    errors.push('capsule.trigger must be a non-empty array of signals');
  }
  if (typeof capsule.summary !== 'string' || capsule.summary.trim().length < 10) {
    errors.push('capsule.summary must be a descriptive string (>= 10 chars)');
  }
  if (capsule.outcome && typeof capsule.outcome === 'object') {
    if (capsule.outcome.status && !['success', 'failed'].includes(capsule.outcome.status)) {
      errors.push('capsule.outcome.status must be success|failed');
    }
  }
  return errors;
}

export function validateValidationReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return ['report must be an object'];
  if (report.type !== 'ValidationReport') errors.push('report.type must be "ValidationReport"');
  if (!Array.isArray(report.commands)) errors.push('report.commands must be an array');
  if (typeof report.overall_ok !== 'boolean') errors.push('report.overall_ok must be a boolean');
  return errors;
}

// Build a standardized ValidationReport from raw command results.
// Mirrors evolver-private-dev/src/gep/validationReport.js shape.
export function buildValidationReport({ geneId, commands, results, startedAt, finishedAt }) {
  const resultsList = Array.isArray(results) ? results : [];
  const cmdsList = Array.isArray(commands) && commands.length > 0
    ? commands
    : resultsList.map((r) => (r && r.command ? String(r.command) : ''));
  const overallOk = resultsList.length > 0 && resultsList.every((r) => r && r.ok);
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? finishedAt - startedAt
    : null;

  const report = {
    type: 'ValidationReport',
    schema_version: SCHEMA_VERSION,
    id: 'vr_' + Date.now(),
    gene_id: geneId || null,
    commands: cmdsList.map((cmd, i) => {
      const r = resultsList[i] || {};
      return {
        command: String(cmd || ''),
        ok: !!r.ok,
        stdout: String(r.stdout || r.out || '').slice(0, 4000),
        stderr: String(r.stderr || r.err || '').slice(0, 4000),
      };
    }),
    overall_ok: overallOk,
    duration_ms: durationMs,
    created_at: new Date().toISOString(),
  };

  report.asset_id = computeAssetId(report);
  return report;
}

// ExecutionTrace: lightweight, desensitized summary of a mutation run.
// MCP variant only carries the fields a coding agent can plausibly observe;
// collaboration-level fields are intentionally omitted (those need swarm
// context the MCP shell does not have).
export function buildExecutionTrace({
  geneId,
  mutationCategory,
  signals,
  filesChanged,
  linesAdded,
  linesRemoved,
  validationOk,
  outcomeStatus,
  errorSignatures,
}) {
  return {
    type: 'ExecutionTrace',
    schema_version: SCHEMA_VERSION,
    gene_id: geneId || null,
    mutation_category: mutationCategory || null,
    signals_matched: Array.isArray(signals) ? signals.slice(0, 10) : [],
    files_changed_count: Number(filesChanged) || 0,
    lines_added: Number(linesAdded) || 0,
    lines_removed: Number(linesRemoved) || 0,
    validation_result: validationOk ? 'pass' : 'fail',
    outcome: outcomeStatus || 'unknown',
    error_signatures: Array.isArray(errorSignatures) ? errorSignatures.slice(0, 10) : [],
    created_at: new Date().toISOString(),
  };
}

// Convert a Gene into a SKILL.md document. Output mirrors the format used
// by evolver-private-dev's skillPublisher so a Hub-side skill marketplace
// can render content from either source identically.
export function geneToSkillMd(gene) {
  const rawName = (gene && gene.id) || 'unnamed-skill';
  const name = sanitizeSkillName(rawName) || deriveFallbackName(gene);
  const displayName = toTitleCase(name);
  let desc = (gene.summary || '').replace(/[\r\n]+/g, ' ').replace(/\s*\d{10,}\s*$/g, '').trim();
  if (!desc || desc.length < 10) desc = 'AI agent skill distilled from evolution experience.';

  const lines = [
    '---',
    'name: ' + displayName,
    'description: ' + desc,
    '---',
    '',
    '# ' + displayName,
    '',
    desc,
    '',
  ];

  if (Array.isArray(gene.signals_match) && gene.signals_match.length > 0) {
    lines.push('## When to Use', '');
    lines.push('- When your project encounters: ' + gene.signals_match.slice(0, 4).map((s) => '`' + s + '`').join(', '));
    lines.push('');
    lines.push('## Trigger Signals', '');
    gene.signals_match.forEach((s) => lines.push('- `' + s + '`'));
    lines.push('');
  }

  if (Array.isArray(gene.preconditions) && gene.preconditions.length > 0) {
    lines.push('## Preconditions', '');
    gene.preconditions.forEach((p) => lines.push('- ' + p));
    lines.push('');
  }

  if (Array.isArray(gene.strategy) && gene.strategy.length > 0) {
    lines.push('## Strategy', '');
    gene.strategy.forEach((step, i) => {
      const text = String(step);
      const verb = extractStepVerb(text);
      if (verb) lines.push((i + 1) + '. **' + verb + '** -- ' + stripLeadingVerb(text));
      else lines.push((i + 1) + '. ' + text);
    });
    lines.push('');
  }

  if (gene.constraints) {
    lines.push('## Constraints', '');
    if (gene.constraints.max_files) lines.push('- Max files per invocation: ' + gene.constraints.max_files);
    if (Array.isArray(gene.constraints.forbidden_paths) && gene.constraints.forbidden_paths.length > 0) {
      lines.push('- Forbidden paths: ' + gene.constraints.forbidden_paths.map((p) => '`' + p + '`').join(', '));
    }
    lines.push('');
  }

  if (Array.isArray(gene.validation) && gene.validation.length > 0) {
    lines.push('## Validation', '');
    gene.validation.forEach((cmd) => {
      lines.push('```bash', cmd, '```', '');
    });
  }

  lines.push('## Metadata', '');
  lines.push('- Category: `' + (gene.category || 'innovate') + '`');
  lines.push('- Schema version: `' + (gene.schema_version || SCHEMA_VERSION) + '`');
  lines.push('');
  lines.push('---', '');
  lines.push('*This Skill was generated by [Evolver](https://github.com/EvoMap/gep-mcp-server) and is distributed under the [EvoMap Skill License (ESL-1.0)](https://evomap.ai/terms).*');
  lines.push('');

  return lines.join('\n');
}

// Derive a kebab-case skill name from a raw gene id; null if unsalvageable.
export function sanitizeSkillName(rawName) {
  if (typeof rawName !== 'string') return null;
  let name = rawName.replace(/[\r\n]+/g, '-').replace(/^gene_distilled_/, '').replace(/^gene_/, '').replace(/_/g, '-');
  name = name.replace(/-?\d{10,}-?/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (/^\d{8,}/.test(name)) return null;
  if (/^(cursor|vscode|vim|emacs|windsurf|copilot|cline|codex)[-]?\d*$/i.test(name)) return null;
  if (name.replace(/[-]/g, '').length < 6) return null;
  return name;
}

export function toTitleCase(kebabName) {
  return String(kebabName || '').split('-').map((w) => {
    if (!w) return '';
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function deriveFallbackName(gene) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'are', 'was', 'has', 'had', 'not', 'but', 'its']);
  const words = [];
  const seen = new Set();
  const collect = (text) => {
    String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).forEach((w) => {
      if (w.length >= 3 && !stop.has(w) && !seen.has(w) && words.length < 5) {
        words.push(w);
        seen.add(w);
      }
    });
  };
  if (gene && Array.isArray(gene.signals_match)) gene.signals_match.slice(0, 3).forEach(collect);
  if (words.length < 2 && gene && gene.summary) collect(gene.summary);
  return words.length >= 2 ? words.join('-') : 'auto-distilled-skill';
}

function extractStepVerb(step) {
  const match = String(step).match(/^([A-Z][a-z]+)/);
  return match ? match[1] : '';
}

function stripLeadingVerb(step) {
  const verb = extractStepVerb(step);
  if (verb && step.startsWith(verb)) {
    const rest = step.slice(verb.length).replace(/^[\s:.\-]+/, '');
    return rest || step;
  }
  return step;
}

// Sanitize free-form tags coming from the agent: drop pure-numeric strings,
// drop very short tokens, drop strings containing 10+ digit timestamps.
export function sanitizeTags(rawTags) {
  return (Array.isArray(rawTags) ? rawTags : [])
    .map((t) => String(t || '').trim())
    .filter((s) => s.length >= 3 && !/^\d+$/.test(s) && !/\d{10,}/.test(s));
}
