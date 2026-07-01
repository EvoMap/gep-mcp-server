// signals.canonical.js
//
// SINGLE SOURCE OF TRUTH for GEP evolution signal names + matchers.
//
// This exact vocabulary must stay in sync across two independently-published
// repos, because recall keys memory by signal set and uses Jaccard similarity
// — if the record side emits a signal the recall side can't extract, the
// memory silently fails to come back ("recorded but never recalled"):
//   - @evomap/gep-mcp-server : src/signals.canonical.js                 (this file, ESM)
//   - @evomap/evolver        : src/adapters/scripts/signals.canonical.js (CJS copy)
//
// Each repo ships a drift-guard test asserting CANONICAL_SIGNAL_NAMES equals
// the agreed spec below. When you change a signal, change BOTH copies + both
// guards in the same coordinated release.
//
// Canonical signal set (8): keep names identical in both copies.

export const SIGNALS = [
  { name: 'log_error', re: /error:|exception:|typeerror|referenceerror|syntaxerror|\[error\]|"status":\s*"error"|\bfailed\b/i },
  { name: 'test_failure', re: /test fail(?:ed|ure)?|\bassertion\b|expect\(|assert\./i },
  { name: 'perf_bottleneck', re: /timeout|slow|latency|bottleneck|oom|out of memory|performance/i },
  { name: 'capability_gap', re: /not supported|unsupported|not implemented|missing feature|not available|\bcannot\b/i },
  { name: 'deployment_issue', re: /deploy(?:ment)? failed|build failed|ci failed|pipeline|rollback|\bdeploy\b|\bci\b/i },
  { name: 'recurring_error', re: /same error|still failing|not fixed|keeps failing|repeatedly/i },
  { name: 'user_feature_request', re: /add feature|please add|new function|new module|\b(?:i want|i need|we need)\b|\b(?:add|implement|create|build)\b[^.]{3,60}\b(?:feature|function|module|capability)\b/i },
  { name: 'user_improvement_suggestion', re: /\b(?:improve|enhance|upgrade|refactor|optimi[sz]e)\b/i },
];

// The agreed canonical name list. Drift guards assert against this exact array.
export const CANONICAL_SIGNAL_NAMES = SIGNALS.map((s) => s.name);

// Recall-only fallback: when a query yields no detectable signal, recall still
// keys into "stable success" memory. NOT a canonical detection signal — the
// record side never emits it, so it is excluded from CANONICAL_SIGNAL_NAMES.
export const NO_SIGNAL_FALLBACK = 'stable_success_plateau';

// Detect canonical signals in free text. Every consumer (record-side hooks and
// recall-side extraction) MUST go through this so the vocabularies never drift.
export function detectSignals(text, { fallback = null } = {}) {
  const t = String(text == null ? '' : text);
  const found = [];
  for (const s of SIGNALS) {
    if (s.re.test(t)) found.push(s.name);
  }
  const uniq = [...new Set(found)];
  if (uniq.length === 0 && fallback) uniq.push(fallback);
  return uniq;
}
