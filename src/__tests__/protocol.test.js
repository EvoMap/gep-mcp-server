import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  buildExecutionTrace,
  buildValidationReport,
  canonicalize,
  computeAssetId,
  geneToSkillMd,
  sanitizeSkillName,
  sanitizeTags,
  stampAsset,
  toTitleCase,
  validateCapsule,
  validateGene,
  validateValidationReport,
} from '../protocol.js';

describe('protocol primitives', () => {
  it('exports current schema and protocol versions in lockstep with evolver', () => {
    // Bump these together with evolver-private-dev/src/gep/contentHash.js
    // and a2aProtocol.js. If the Hub is on a newer version this assertion
    // is the canary.
    expect(SCHEMA_VERSION).toBe('1.6.0');
    expect(PROTOCOL_NAME).toBe('gep-a2a');
    expect(PROTOCOL_VERSION).toBe('1.0.0');
  });

  it('canonicalize sorts object keys deterministically', () => {
    const a = canonicalize({ b: 1, a: 2, c: { y: [3, 1, 2], x: null } });
    const b = canonicalize({ a: 2, c: { x: null, y: [3, 1, 2] }, b: 1 });
    expect(a).toBe(b);
    // Non-finite numbers and undefined become "null"
    expect(canonicalize({ x: NaN, y: Infinity, z: undefined })).toBe('{"x":null,"y":null,"z":null}');
  });

  it('computeAssetId is stable across key orderings and excludes self-id', () => {
    const a = computeAssetId({ b: 1, a: 2 });
    const b = computeAssetId({ a: 2, b: 1, asset_id: 'sha256:should-be-ignored' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('stampAsset adds asset_id and schema_version idempotently', () => {
    const g = { type: 'Gene', id: 'g1' };
    stampAsset(g);
    expect(g.schema_version).toBe('1.6.0');
    expect(g.asset_id).toMatch(/^sha256:/);
    const previousId = g.asset_id;
    // Stamping again with same content yields same id
    stampAsset(g);
    expect(g.asset_id).toBe(previousId);
    // Mutating then re-stamping changes the id (catches forgot-to-restamp bugs)
    g.id = 'g2';
    stampAsset(g);
    expect(g.asset_id).not.toBe(previousId);
  });
});

describe('validation', () => {
  const validGene = {
    type: 'Gene',
    id: 'gene_x',
    category: 'repair',
    signals_match: ['error'],
    strategy: [
      'Detect transient hub failure category',
      'Sleep with exponential backoff',
    ],
    validation: ['node -e "require(\'assert\').strictEqual(typeof process.version,\'string\')"'],
  };

  const validCapsule = {
    type: 'Capsule',
    id: 'c1',
    trigger: ['log_error'],
    summary: 'Fixed retry loop by adding exponential backoff',
    confidence: 0.9,
    blast_radius: { files: 1, lines: 30 },
    env_fingerprint: { platform: 'linux', arch: 'x64' },
    outcome: { status: 'success', score: 0.9 },
  };

  it('rejects malformed Gene', () => {
    expect(validateGene(null)).toEqual(['gene must be an object']);
    const errs = validateGene({ id: 'x' });
    expect(errs).toContain('gene.type must be "Gene"');
    expect(errs.some((e) => /signals_match/.test(e))).toBe(true);
  });

  it('rejects Gene with too-short strategy steps', () => {
    const errs = validateGene({ ...validGene, strategy: ['short', 'tiny'] });
    expect(errs.some((e) => /at least 15 characters/.test(e))).toBe(true);
  });

  it('rejects Gene missing validation commands', () => {
    const errs = validateGene({ ...validGene, validation: [] });
    expect(errs.some((e) => /validation/.test(e))).toBe(true);
  });

  it('accepts well-formed Gene', () => {
    expect(validateGene(validGene)).toEqual([]);
  });

  it('rejects malformed Capsule (short summary)', () => {
    const errs = validateCapsule({ ...validCapsule, summary: 'short' });
    expect(errs.some((e) => /summary/.test(e))).toBe(true);
  });

  it('rejects Capsule missing hub-1.6.0 required fields', () => {
    const errs = validateCapsule({
      type: 'Capsule', id: 'c1', trigger: ['x'], summary: 'long enough summary text here',
    });
    expect(errs.some((e) => /confidence/.test(e))).toBe(true);
    expect(errs.some((e) => /blast_radius/.test(e))).toBe(true);
    expect(errs.some((e) => /env_fingerprint/.test(e))).toBe(true);
    expect(errs.some((e) => /outcome/.test(e))).toBe(true);
  });

  it('rejects Capsule with out-of-range confidence', () => {
    expect(validateCapsule({ ...validCapsule, confidence: 1.5 }).some((e) => /confidence/.test(e))).toBe(true);
    expect(validateCapsule({ ...validCapsule, confidence: -0.1 }).some((e) => /confidence/.test(e))).toBe(true);
  });

  it('accepts well-formed Capsule', () => {
    expect(validateCapsule(validCapsule)).toEqual([]);
  });

  it('validateValidationReport requires overall_ok boolean', () => {
    expect(validateValidationReport({ type: 'ValidationReport', commands: [], overall_ok: true })).toEqual([]);
    expect(validateValidationReport({ type: 'ValidationReport', commands: [] })).toContain('report.overall_ok must be a boolean');
  });
});

describe('stampAsset hub-compatibility quirks', () => {
  it('strips capsule.outcome.notes before hashing so asset_id matches Hub', () => {
    // Same logical capsule, one with the legal-on-wire-but-unhashed `notes`,
    // one without. Hub strips notes during /a2a/publish recompute -- if our
    // stamp does not match, we get capsule_asset_id_verification_failed.
    const withNotes = {
      type: 'Capsule', id: 'c_notes',
      trigger: ['x'], summary: 'long enough summary text',
      confidence: 0.9, blast_radius: { files: 1, lines: 1 },
      env_fingerprint: { platform: 'linux', arch: 'x64' },
      outcome: { status: 'success', notes: 'tests pass; reviewer happy' },
    };
    const withoutNotes = JSON.parse(JSON.stringify(withNotes));
    delete withoutNotes.outcome.notes;
    stampAsset(withNotes);
    stampAsset(withoutNotes);
    expect(withNotes.outcome).toEqual({ status: 'success' });
    expect(withNotes.asset_id).toBe(withoutNotes.asset_id);
  });

  it('preserves status + score on capsule outcome', () => {
    const c = {
      type: 'Capsule', id: 'c_score',
      trigger: ['x'], summary: 'long enough summary text',
      confidence: 0.9, blast_radius: { files: 1, lines: 1 },
      env_fingerprint: { platform: 'linux', arch: 'x64' },
      outcome: { status: 'success', score: 0.85, foo: 'gone' },
    };
    stampAsset(c);
    expect(c.outcome).toEqual({ status: 'success', score: 0.85 });
  });

  it('does not touch outcome on non-Capsule assets', () => {
    const g = { type: 'Gene', id: 'g_outcome', outcome: { whatever: true } };
    stampAsset(g);
    expect(g.outcome).toEqual({ whatever: true });
  });
});

describe('buildValidationReport', () => {
  it('builds well-formed report and sets overall_ok=false on any failure', () => {
    const r = buildValidationReport({
      geneId: 'gene_x',
      commands: ['cargo test', 'cargo clippy -D warnings'],
      results: [
        { ok: true, stdout: 'all good', stderr: '' },
        { ok: false, stdout: '', stderr: 'lint failed' },
      ],
    });
    expect(r.type).toBe('ValidationReport');
    expect(r.overall_ok).toBe(false);
    expect(r.commands).toHaveLength(2);
    expect(r.commands[1].stderr).toBe('lint failed');
    expect(r.asset_id).toMatch(/^sha256:/);
    expect(r.schema_version).toBe('1.6.0');
  });

  it('falls back to commands derived from results when commands omitted', () => {
    const r = buildValidationReport({
      results: [{ command: 'echo hi', ok: true }],
    });
    expect(r.commands[0].command).toBe('echo hi');
    expect(r.overall_ok).toBe(true);
  });

  it('truncates stdout/stderr at 4000 chars to keep payload bounded', () => {
    const huge = 'x'.repeat(5000);
    const r = buildValidationReport({
      commands: ['cmd'],
      results: [{ ok: true, stdout: huge, stderr: huge }],
    });
    expect(r.commands[0].stdout.length).toBe(4000);
    expect(r.commands[0].stderr.length).toBe(4000);
  });
});

describe('buildExecutionTrace', () => {
  it('produces a desensitized snapshot', () => {
    const t = buildExecutionTrace({
      geneId: 'gene_x',
      mutationCategory: 'repair',
      signals: ['log_error', 'env_pollution'],
      filesChanged: 1,
      linesAdded: 14,
      linesRemoved: 0,
      validationOk: true,
      outcomeStatus: 'success',
      errorSignatures: ['TypeError'],
    });
    expect(t.type).toBe('ExecutionTrace');
    expect(t.validation_result).toBe('pass');
    expect(t.outcome).toBe('success');
    expect(t.error_signatures).toEqual(['TypeError']);
  });
});

describe('skill md conversion', () => {
  it('sanitizeSkillName drops embedded timestamps and tool aliases', () => {
    expect(sanitizeSkillName('gene_distilled_retry-with-backoff_1700000000000')).toBe('retry-with-backoff');
    expect(sanitizeSkillName('cursor_1700')).toBe(null);
    expect(sanitizeSkillName('ab')).toBe(null);
    expect(sanitizeSkillName('00001234567890')).toBe(null);
  });

  it('toTitleCase formats kebab cleanly', () => {
    expect(toTitleCase('retry-with-backoff')).toBe('Retry With Backoff');
  });

  it('geneToSkillMd renders a complete document', () => {
    const md = geneToSkillMd({
      type: 'Gene',
      id: 'gene_retry_with_backoff',
      category: 'repair',
      summary: 'Retry transient hub failures with exponential backoff',
      signals_match: ['log_error', 'rate_limited', '5xx_error'],
      preconditions: ['idempotent endpoint'],
      strategy: ['Detect transient status', 'Sleep with backoff', 'Retry up to N times'],
      constraints: { max_files: 5, forbidden_paths: ['.git'] },
      validation: ['npm test'],
    });
    expect(md).toMatch(/^---\nname: Retry With Backoff/);
    expect(md).toContain('## Trigger Signals');
    expect(md).toContain('- `log_error`');
    expect(md).toContain('## Strategy');
    expect(md).toContain('## Validation');
    expect(md).toContain('Schema version: `1.6.0`');
  });

  it('sanitizeTags drops short / pure-numeric / timestamp-bearing entries', () => {
    expect(sanitizeTags(['ok', '12', '1700000000000', 'log_error', '   ', 'test_failure'])).toEqual([
      'log_error',
      'test_failure',
    ]);
    expect(sanitizeTags(null)).toEqual([]);
  });
});
