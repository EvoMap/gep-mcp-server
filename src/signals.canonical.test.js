import { describe, it, expect } from 'vitest';
import {
  CANONICAL_SIGNAL_NAMES,
  SIGNALS,
  detectSignals,
  NO_SIGNAL_FALLBACK,
} from './signals.canonical.js';

// The agreed canonical signal spec. This list MUST stay identical to the guard
// in @evomap/evolver (test/signals.canonical.test.js there asserting the CJS
// copy). If you change a signal, change BOTH repos + BOTH guards in one
// coordinated release — otherwise record-side and recall-side vocabularies
// drift and Jaccard recall silently drops matches.
const SPEC = [
  'log_error',
  'test_failure',
  'perf_bottleneck',
  'capability_gap',
  'deployment_issue',
  'recurring_error',
  'user_feature_request',
  'user_improvement_suggestion',
];

describe('canonical signal vocabulary (drift guard)', () => {
  it('matches the agreed spec exactly', () => {
    expect([...CANONICAL_SIGNAL_NAMES].sort()).toEqual([...SPEC].sort());
    expect(SIGNALS.length).toBe(SPEC.length);
  });

  it('excludes the recall-only fallback from the canonical set', () => {
    expect(CANONICAL_SIGNAL_NAMES).not.toContain(NO_SIGNAL_FALLBACK);
  });

  it('extracts every canonical signal from a representative sample', () => {
    const samples = {
      log_error: 'TypeError: cannot read property of undefined',
      test_failure: 'test failed: assertion error in expect(result)',
      perf_bottleneck: 'the request has high latency and is very slow',
      capability_gap: 'this feature is not implemented yet',
      deployment_issue: 'deploy failed in the ci pipeline, had to rollback',
      recurring_error: 'same error, still failing, keeps failing repeatedly',
      user_feature_request: 'please add a new module to implement export capability',
      user_improvement_suggestion: 'we should refactor and optimize this path',
    };
    for (const name of SPEC) {
      expect(detectSignals(samples[name])).toContain(name);
    }
  });

  it('returns [] on neutral text, and the fallback only when asked', () => {
    expect(detectSignals('a neutral sentence about apples')).toEqual([]);
    expect(
      detectSignals('a neutral sentence about apples', { fallback: NO_SIGNAL_FALLBACK }),
    ).toEqual([NO_SIGNAL_FALLBACK]);
  });

  it('recognises the three signals that previously regressed recall', () => {
    // These were absent from the old recall-side _extractSignals, so outcomes
    // recorded with them could never be recalled.
    expect(detectSignals('test failed')).toContain('test_failure');
    expect(detectSignals('build failed in ci')).toContain('deployment_issue');
    expect(detectSignals('same error, still failing')).toContain('recurring_error');
  });
});
