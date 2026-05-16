// ---------------------------------------------------------------------------
// searchEnrich — annotate gep_search_community results with confidence and
// similarity bands so calling LLMs can decide whether a match is trustworthy
// without parsing raw scores.
//
// Background (2026-05-16): real-world community search of the Hub returned
// 10 results in the 0.59–0.61 similarity range, none of which actually
// solved the user's problem. similarity numbers in that band are a
// "trust trap" — high enough to look real, too low to be reliable.
// validation_summary is also dropped on most legacy assets, so callers
// have no easy way to filter unverified content.
//
// This module adds two purely additive fields per asset (no filtering, no
// reordering): similarity_band and confidence_band. Existing clients keep
// working; LLM-aware clients can read the bands.
// ---------------------------------------------------------------------------

// Similarity bands. Hub semantic search currently returns embedding cosine
// similarity. ≥0.75 is the empirical "strong overlap" threshold we trust;
// 0.6–0.75 is "loosely related, verify before reuse"; <0.6 is "drag-net,
// often unrelated despite similar wording".
export const SIMILARITY_BAND_HIGH = 0.75;
export const SIMILARITY_BAND_MEDIUM = 0.6;

export function classifySimilarity(score) {
  // Reject null / undefined / non-numeric strings up front. Number(null)
  // coerces to 0, which would otherwise classify a missing similarity as
  // 'low' and hide the fact that the upstream payload was incomplete.
  if (score === null || score === undefined) return 'unknown';
  if (typeof score === 'string' && score.trim() === '') return 'unknown';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= SIMILARITY_BAND_HIGH) return 'high';
  if (n >= SIMILARITY_BAND_MEDIUM) return 'medium';
  return 'low';
}

// Confidence bands derived from the Hub's validation_summary.validationQuality.
// 'real'       — Hub observed and accepted a non-empty validation report.
// 'suspicious' — validation field present but Hub flagged it (e.g. empty
//                array, missing execution_trace, fishy commands).
// 'empty'      — no validation field at all, so there is no evidence the
//                asset has ever been verified.
// Anything unexpected falls back to 'unknown' so we never silently lie about
// quality.
export function classifyConfidence(validationSummary) {
  if (!validationSummary || typeof validationSummary !== 'object') return 'unknown';
  const q = String(validationSummary.validationQuality || '').toLowerCase();
  if (q === 'real') return 'high';
  if (q === 'suspicious') return 'medium';
  if (q === 'empty') return 'low';
  return 'unknown';
}

// Annotate a single asset (Gene or Capsule) returned by /a2a/assets/semantic-search.
// Returns a new object; caller's input is untouched. Bands are appended even
// when the underlying signals are missing — a band of 'unknown' is itself
// useful information for the consumer.
export function annotateAsset(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  const similarity_band = classifySimilarity(asset.similarity);
  const confidence_band = classifyConfidence(asset.validation_summary);
  return { ...asset, similarity_band, confidence_band };
}

// Walk a search-community payload and annotate every asset in place. The Hub
// can return either { assets: [...] } (current shape) or { genes: [...] }
// (older shape used by some endpoints). We annotate whichever is present.
// Anything else is returned unchanged so the function is safe to call on
// partial / error payloads too.
export function annotateSearchPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (Array.isArray(payload.assets)) {
    out.assets = payload.assets.map(annotateAsset);
  }
  if (Array.isArray(payload.genes)) {
    out.genes = payload.genes.map(annotateAsset);
  }
  // Surface a hint to the consumer that bands are present; prevents older
  // clients from being surprised, helps newer clients decide quickly that
  // they can trust the band fields rather than recomputing.
  out._enrichment = {
    bands: ['similarity_band', 'confidence_band'],
    similarity_thresholds: { high: SIMILARITY_BAND_HIGH, medium: SIMILARITY_BAND_MEDIUM },
    confidence_mapping: { real: 'high', suspicious: 'medium', empty: 'low' },
  };
  return out;
}
