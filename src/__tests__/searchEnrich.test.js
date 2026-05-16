import { describe, it, expect } from 'vitest';
import {
  classifySimilarity,
  classifyConfidence,
  annotateAsset,
  annotateSearchPayload,
  SIMILARITY_BAND_HIGH,
  SIMILARITY_BAND_MEDIUM,
} from '../searchEnrich.js';

describe('classifySimilarity', () => {
  it('returns "high" at and above the high threshold', () => {
    expect(classifySimilarity(SIMILARITY_BAND_HIGH)).toBe('high');
    expect(classifySimilarity(0.99)).toBe('high');
    expect(classifySimilarity(1.0)).toBe('high');
  });

  it('returns "medium" between medium (inclusive) and high (exclusive) thresholds', () => {
    expect(classifySimilarity(SIMILARITY_BAND_MEDIUM)).toBe('medium');
    expect(classifySimilarity(0.61)).toBe('medium');
    expect(classifySimilarity(0.7499)).toBe('medium');
  });

  it('returns "low" below the medium threshold', () => {
    expect(classifySimilarity(0.59)).toBe('low');
    expect(classifySimilarity(0.0)).toBe('low');
  });

  it('returns "unknown" for non-numeric inputs', () => {
    expect(classifySimilarity(undefined)).toBe('unknown');
    expect(classifySimilarity(null)).toBe('unknown');
    expect(classifySimilarity('abc')).toBe('unknown');
    expect(classifySimilarity(NaN)).toBe('unknown');
  });
});

describe('classifyConfidence', () => {
  it('maps "real" → high', () => {
    expect(classifyConfidence({ validationQuality: 'real' })).toBe('high');
  });

  it('maps "suspicious" → medium', () => {
    expect(classifyConfidence({ validationQuality: 'suspicious' })).toBe('medium');
  });

  it('maps "empty" → low', () => {
    expect(classifyConfidence({ validationQuality: 'empty' })).toBe('low');
  });

  it('case-insensitive matching of validationQuality', () => {
    expect(classifyConfidence({ validationQuality: 'REAL' })).toBe('high');
    expect(classifyConfidence({ validationQuality: 'Suspicious' })).toBe('medium');
  });

  it('returns "unknown" for missing/unrecognized validation_summary', () => {
    expect(classifyConfidence(null)).toBe('unknown');
    expect(classifyConfidence(undefined)).toBe('unknown');
    expect(classifyConfidence({})).toBe('unknown');
    expect(classifyConfidence({ validationQuality: 'whatever' })).toBe('unknown');
    expect(classifyConfidence('not-an-object')).toBe('unknown');
  });
});

describe('annotateAsset', () => {
  it('appends similarity_band and confidence_band without mutating input', () => {
    const original = {
      asset_id: 'sha256:abc',
      similarity: 0.78,
      validation_summary: { validationQuality: 'real' },
    };
    const out = annotateAsset(original);
    expect(out).not.toBe(original);
    expect(out.similarity_band).toBe('high');
    expect(out.confidence_band).toBe('high');
    expect(original.similarity_band).toBeUndefined();
    expect(original.confidence_band).toBeUndefined();
  });

  it('preserves all original fields', () => {
    const out = annotateAsset({ asset_id: 'x', similarity: 0.65, payload: { type: 'Gene' } });
    expect(out.asset_id).toBe('x');
    expect(out.similarity).toBe(0.65);
    expect(out.payload).toEqual({ type: 'Gene' });
  });

  it('exposes "low"/"unknown" bands for the real-world 0.6 trust-trap example', () => {
    // This is the exact pattern that motivated the change: similarity ~0.6
    // and validation_summary "suspicious" — the LLM should see clearly
    // that this is NOT a high-confidence match.
    const out = annotateAsset({
      asset_id: 'sha256:typescript-strict',
      similarity: 0.6021,
      validation_summary: { validationQuality: 'suspicious' },
    });
    expect(out.similarity_band).toBe('medium');
    expect(out.confidence_band).toBe('medium');
  });

  it('handles non-object input gracefully', () => {
    expect(annotateAsset(null)).toBe(null);
    expect(annotateAsset(undefined)).toBe(undefined);
    expect(annotateAsset(42)).toBe(42);
  });
});

describe('annotateSearchPayload', () => {
  it('annotates assets[] from the canonical /a2a/assets/semantic-search shape', () => {
    const payload = {
      assets: [
        { asset_id: 'a', similarity: 0.8, validation_summary: { validationQuality: 'real' } },
        { asset_id: 'b', similarity: 0.55, validation_summary: { validationQuality: 'empty' } },
      ],
      count: 2,
    };
    const out = annotateSearchPayload(payload);
    expect(out.assets).toHaveLength(2);
    expect(out.assets[0].similarity_band).toBe('high');
    expect(out.assets[0].confidence_band).toBe('high');
    expect(out.assets[1].similarity_band).toBe('low');
    expect(out.assets[1].confidence_band).toBe('low');
    expect(out.count).toBe(2); // preserves other fields
  });

  it('annotates legacy genes[] payload shape (older endpoints)', () => {
    const payload = { genes: [{ asset_id: 'g1', similarity: 0.9 }] };
    const out = annotateSearchPayload(payload);
    expect(out.genes[0].similarity_band).toBe('high');
    expect(out.genes[0].confidence_band).toBe('unknown');
  });

  it('attaches an _enrichment hint describing what bands mean', () => {
    const out = annotateSearchPayload({ assets: [] });
    expect(out._enrichment).toMatchObject({
      bands: ['similarity_band', 'confidence_band'],
      similarity_thresholds: { high: SIMILARITY_BAND_HIGH, medium: SIMILARITY_BAND_MEDIUM },
      confidence_mapping: { real: 'high', suspicious: 'medium', empty: 'low' },
    });
  });

  it('passes through error/empty payloads unchanged (only adds _enrichment to objects)', () => {
    expect(annotateSearchPayload(null)).toBe(null);
    expect(annotateSearchPayload(undefined)).toBe(undefined);
    const errOut = annotateSearchPayload({ error: 'rate_limited' });
    expect(errOut.error).toBe('rate_limited');
    expect(errOut._enrichment).toBeDefined();
  });
});
