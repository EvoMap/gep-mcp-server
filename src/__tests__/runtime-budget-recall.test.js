// Integration tests for schema 1.7.0 budget-aware recall (Meta-Harness
// PoC task D). Exercises the full local-mode pipeline:
// recordOutcome (with / without cost) -> recall (with / without budget)
// -> over_budget flag + conservative fallback for unknown-cost matches.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GepRuntime,
  resolveBudgetCaps,
  selectWithinBudget,
  isOverBudget,
  serializeBudgetApplied,
} from '../runtime.js';
import { GEP_GENE_CATEGORIES } from '@evomap/gep-sdk';

let runtime;
let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gep-runtime-budget-'));
  runtime = new GepRuntime({
    assetsDir: join(tmp, 'assets'),
    memoryDir: join(tmp, 'memory'),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveBudgetCaps', () => {
  it('returns inactive caps when nothing is supplied', () => {
    const b = resolveBudgetCaps({});
    expect(b.active).toBe(false);
    expect(b.tokens).toBe(Number.POSITIVE_INFINITY);
    expect(b.usd).toBe(Number.POSITIVE_INFINITY);
  });

  it('honours explicit budget_tokens and budget_usd', () => {
    const b = resolveBudgetCaps({ budget_tokens: 1000, budget_usd: 0.1 });
    expect(b.active).toBe(true);
    expect(b.tokens).toBe(1000);
    expect(b.usd).toBe(0.1);
  });

  it('maps cost_tier to tiered caps when no explicit numbers given', () => {
    expect(resolveBudgetCaps({ cost_tier: 'low' })).toMatchObject({ active: true, tokens: 5000, usd: 0.05 });
    expect(resolveBudgetCaps({ cost_tier: 'medium' })).toMatchObject({ active: true, tokens: 50000, usd: 0.5 });
    expect(resolveBudgetCaps({ cost_tier: 'high' }).active).toBe(true);
    expect(resolveBudgetCaps({ cost_tier: 'high' }).tokens).toBe(Number.POSITIVE_INFINITY);
  });

  it('explicit numeric caps win over cost_tier', () => {
    const b = resolveBudgetCaps({ budget_tokens: 9999, cost_tier: 'low' });
    expect(b.tokens).toBe(9999);
    expect(b.usd).toBe(Number.POSITIVE_INFINITY); // unrelated cap stays unset
  });
});

describe('isOverBudget', () => {
  const cap = { active: true, tokens: 1000, usd: 0.1 };

  it('returns false when budget is inactive regardless of cost', () => {
    expect(isOverBudget({ active: false, tokens: 0, usd: 0 }, 999999, 999)).toBe(false);
  });

  it('returns false for unknown-cost capsules (conservative fallback)', () => {
    expect(isOverBudget(cap, null, null)).toBe(false);
  });

  it('returns true when token cost exceeds cap', () => {
    expect(isOverBudget(cap, 1500, null)).toBe(true);
  });

  it('returns true when usd cost exceeds cap even if tokens are fine', () => {
    expect(isOverBudget(cap, 50, 0.5)).toBe(true);
  });

  it('partial knowledge: only tokens given and within cap', () => {
    expect(isOverBudget(cap, 500, null)).toBe(false);
  });
});

describe('selectWithinBudget', () => {
  it('keeps in-budget first then backfills up to overBudgetSlack', () => {
    const matches = [
      { id: 'a', similarity: 0.9, over_budget: true },
      { id: 'b', similarity: 0.8, over_budget: false },
      { id: 'c', similarity: 0.7, over_budget: false },
      { id: 'd', similarity: 0.6, over_budget: true },
      { id: 'e', similarity: 0.5, over_budget: true },
    ];
    const out = selectWithinBudget(matches, 4, 2);
    expect(out.map((m) => m.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(out.filter((m) => m.over_budget)).toHaveLength(2);
  });

  it('respects overBudgetSlack=0 (drop all over-budget)', () => {
    const matches = [
      { id: 'a', over_budget: true },
      { id: 'b', over_budget: false },
    ];
    const out = selectWithinBudget(matches, 10, 0);
    expect(out.map((m) => m.id)).toEqual(['b']);
  });

  it('respects limit even when in-budget exceeds it', () => {
    const matches = Array.from({ length: 20 }, (_, i) => ({ id: String(i), over_budget: false }));
    const out = selectWithinBudget(matches, 5, 2);
    expect(out).toHaveLength(5);
  });
});

describe('GepRuntime.recall budget integration', () => {
  it('returns matches unchanged when no budget is supplied (backward compat)', () => {
    runtime.recordOutcome({
      geneId: 'ad_hoc',
      signals: ['log_error', 'retry_timeout'],
      status: 'success',
      score: 0.9,
      summary: 'Resolved a retry timeout by increasing the deadline.',
    });
    const result = runtime.recall({ query: 'timeout', signals: ['log_error'] });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.budget_applied).toBeNull();
    // Pre-1.7.0 callers do not see over_budget bookkeeping.
    expect(result.matches[0]).toHaveProperty('over_budget', false);
  });

  it('flags capsules whose cost_tokens exceed budget_tokens', () => {
    runtime.recordOutcome({
      geneId: 'ad_hoc',
      signals: ['log_error', 'retry_timeout'],
      status: 'success',
      score: 0.9,
      summary: 'Cheap fix for a transient retry.',
      cost_tokens: 500,
    });
    runtime.recordOutcome({
      geneId: 'ad_hoc',
      signals: ['log_error', 'retry_timeout'],
      status: 'success',
      score: 0.85,
      summary: 'Expensive multi-step rewrite for the same class of bug.',
      cost_tokens: 200_000,
    });
    const result = runtime.recall({
      query: 'timeout',
      signals: ['log_error', 'retry_timeout'],
      budget_tokens: 5000,
    });
    expect(result.budget_applied).toMatchObject({ budget_tokens: 5000 });
    const cheap = result.matches.find((m) => m.outcome?.note?.includes('Cheap fix'));
    const pricey = result.matches.find((m) => m.outcome?.note?.includes('Expensive'));
    expect(cheap).toBeDefined();
    expect(cheap.over_budget).toBe(false);
    expect(pricey).toBeDefined();
    expect(pricey.over_budget).toBe(true);
  });

  it('keeps unknown-cost capsules in the result (conservative fallback)', () => {
    // Old-format outcome: no cost fields recorded. The recall must
    // not silently drop it just because the new caller supplied a
    // budget.
    runtime.recordOutcome({
      geneId: 'ad_hoc',
      signals: ['log_error', 'race_condition'],
      status: 'success',
      score: 0.8,
      summary: 'Fixed a race using a per-key mutex; no cost recorded.',
    });
    const result = runtime.recall({
      query: 'race',
      signals: ['log_error', 'race_condition'],
      budget_tokens: 100,
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const m = result.matches[0];
    expect(m.cost_tokens).toBeNull();
    expect(m.cost_usd).toBeNull();
    expect(m.over_budget).toBe(false);
  });

  it('cost_tier=low collapses to the documented token / usd caps', () => {
    runtime.recordOutcome({
      geneId: 'ad_hoc',
      signals: ['log_error', 'timeout'],
      status: 'success',
      score: 0.7,
      summary: 'A summary that satisfies the minimum length requirement.',
      cost_tokens: 8000, // > 5000 low cap
    });
    const result = runtime.recall({
      query: 'timeout',
      signals: ['log_error', 'timeout'],
      cost_tier: 'low',
    });
    expect(result.budget_applied).toMatchObject({
      budget_tokens: 5000,
      budget_usd: 0.05,
      tokens_unbounded: false,
      usd_unbounded: false,
      cost_tier: 'low',
    });
    expect(result.matches[0].over_budget).toBe(true);
  });
});

describe('GepRuntime category constants integration', () => {
  it('reports every SDK Gene category in status stats', () => {
    runtime.installGene({
      gene: {
        type: 'Gene',
        id: 'gene_explore_sparse_niche',
        category: 'explore',
        signals_match: ['stable_success_plateau'],
        summary: 'Explore sparse strategy niches before selecting a concrete optimization path.',
        strategy: ['Inspect recent memory graph gaps', 'Draft a bounded exploration plan'],
        validation: ['node -e "process.exit(0)"'],
      },
    });

    const status = runtime.getStatus();
    expect(Object.keys(status.gene_categories)).toEqual(GEP_GENE_CATEGORIES);
    expect(status.gene_categories.explore).toBe(1);
  });

  it('accepts explore as a forced evolution intent', () => {
    runtime.installGene({
      gene: {
        type: 'Gene',
        id: 'gene_explore_plateau',
        category: 'explore',
        signals_match: ['stable_success_plateau'],
        summary: 'Explore alternatives when repeated stable cycles stop producing useful improvements.',
        strategy: ['Identify plateau evidence', 'Search for a new strategy direction'],
        validation: ['node -e "process.exit(0)"'],
      },
    });

    const result = runtime.evolve({
      context: 'No active error, but recent cycles are saturated.',
      intent: 'explore',
    });

    expect(result.ok).toBe(true);
    expect(result.mutation.category).toBe('explore');
    expect(result.mutation.expected_effect).toMatch(/discover new strategy opportunities/);
  });
});

describe('serializeBudgetApplied (JSON-safety regression)', () => {
  // Regression for Cursor Bugbot 2026-05-14: Number.POSITIVE_INFINITY in
  // the recall response was silently turned into `null` by JSON.stringify
  // in the MCP transport, leaving the caller unable to distinguish
  // "uncapped on this dimension" from "caller passed nothing".

  it('returns null when no budget is active', () => {
    const inactive = resolveBudgetCaps({});
    expect(serializeBudgetApplied(inactive)).toBeNull();
  });

  it('cost_tier=high serializes to JSON without losing the budget signal', () => {
    const budget = resolveBudgetCaps({ cost_tier: 'high' });
    const applied = serializeBudgetApplied(budget);
    expect(applied).toEqual({
      budget_tokens: null,
      budget_usd: null,
      tokens_unbounded: true,
      usd_unbounded: true,
      cost_tier: 'high',
    });
    // Round-trip through JSON to prove no field was silently dropped /
    // converted to a misleading `null`.
    const roundTripped = JSON.parse(JSON.stringify(applied));
    expect(roundTripped.tokens_unbounded).toBe(true);
    expect(roundTripped.usd_unbounded).toBe(true);
    expect(roundTripped.cost_tier).toBe('high');
    // Confirm that no Infinity value leaked through (which JSON.stringify
    // converts to `null`, the bug we are guarding against).
    expect(JSON.stringify(applied)).not.toMatch(/Infinity/);
  });

  it('partial cap (only budget_tokens) marks the missing dimension unbounded', () => {
    const budget = resolveBudgetCaps({ budget_tokens: 1000 });
    expect(serializeBudgetApplied(budget)).toEqual({
      budget_tokens: 1000,
      budget_usd: null,
      tokens_unbounded: false,
      usd_unbounded: true,
      cost_tier: null,
    });
  });

  it('partial cap (only budget_usd) marks the missing dimension unbounded', () => {
    const budget = resolveBudgetCaps({ budget_usd: 0.25 });
    expect(serializeBudgetApplied(budget)).toEqual({
      budget_tokens: null,
      budget_usd: 0.25,
      tokens_unbounded: true,
      usd_unbounded: false,
      cost_tier: null,
    });
  });

  it('GepRuntime.recall response stays JSON-safe with cost_tier=high', () => {
    runtime.recordOutcome({
      geneId: 'ad_hoc',
      signals: ['log_error', 'timeout'],
      status: 'success',
      score: 0.7,
      summary: 'A summary that satisfies the minimum length requirement.',
      cost_tokens: 8000,
    });
    const result = runtime.recall({
      query: 'timeout',
      signals: ['log_error', 'timeout'],
      cost_tier: 'high',
    });
    // JSON round-trip emulates what the MCP handler does in index.js
    // (`JSON.stringify(result, null, 2)`); after the fix, the caller
    // sees `tokens_unbounded: true` instead of a misleading
    // `budget_tokens: null` indistinguishable from "unset".
    const wire = JSON.parse(JSON.stringify(result));
    expect(wire.budget_applied).toEqual({
      budget_tokens: null,
      budget_usd: null,
      tokens_unbounded: true,
      usd_unbounded: true,
      cost_tier: 'high',
    });
  });
});

describe('GepRuntime K_auto / reference_only passthrough and signal extraction', () => {
  it('preserves K_auto Gene coordinates and reference_only Capsule fields across installGene, listGenes, and evolve', () => {
    const kautoGene = {
      type: 'Gene',
      id: 'gene_kauto_local',
      category: 'repair',
      signals_match: ['log_error'],
      summary: 'Repair transient errors with verified K_auto bounds.',
      strategy: ['Inspect failing trace line', 'Apply bounded retry patch'],
      constraints: { max_files: 3, forbidden_paths: ['.git'] },
      validation: ['node -e "process.exit(0)"'],
      routing_hint: { tier: 'mid', reasoning_level: 'high' },
      tool_policy: { deny: ['Bash'], severity: 'warn' },
      claims: [{ predicate: 'exit_code==0', kind: 'behavioral' }],
      scope: { signals: ['log_error'], predicate: 'matches(log_error)' },
      runtime_profile: { runtime: 'node@22', env_class: 'local' },
      verifier_profile: { verifier: 'vitest', decision: 'pass' },
    };
    const installed = runtime.installGene({ gene: kautoGene });
    expect(installed.ok).toBe(true);

    const listed = runtime.listGenes({ category: 'repair' });
    expect(listed.genes[0].claims).toEqual(kautoGene.claims);
    expect(listed.genes[0].scope).toEqual(kautoGene.scope);
    expect(listed.genes[0].runtime_profile).toEqual(kautoGene.runtime_profile);
    expect(listed.genes[0].verifier_profile).toEqual(kautoGene.verifier_profile);
    expect(listed.genes[0].routing_hint).toEqual(kautoGene.routing_hint);
    expect(listed.genes[0].tool_policy).toEqual(kautoGene.tool_policy);

    runtime.store.upsertCapsule({
      type: 'Capsule',
      id: 'cap_ref_local',
      trigger: ['log_error'],
      gene: 'gene_kauto_local',
      summary: 'Reference capsule for log_error triage',
      confidence: 0.9,
      evidence_mode: 'reference_only',
      source_type: 'reference',
      blast_radius: { files: 0, lines: 0 },
      execution_trace: [],
      diff: null,
      content: { text: 'Triage reference note', mime: 'text/plain' },
      proof_of_work: {
        kind: 'artifact_hash',
        artifact_hash: { sha256: 'a'.repeat(64), mime: 'text/plain', size: 21 },
      },
      outcome: { status: 'success', score: 0.9 },
    });

    const evolved = runtime.evolve({
      context: '{\n  "request_id": "req_1"\n}\nTypeError: connection failed at Client.send',
    });
    expect(evolved.ok).toBe(true);
    expect(evolved.signals).toContain('log_error');
    expect(evolved.selected_gene.claims).toEqual(kautoGene.claims);
    expect(evolved.selected_gene.verifier_profile).toEqual(kautoGene.verifier_profile);
    expect(evolved.matching_capsule.evidence_mode).toBe('reference_only');
    expect(evolved.matching_capsule.content).toEqual({ text: 'Triage reference note', mime: 'text/plain' });
    expect(evolved.matching_capsule.proof_of_work.kind).toBe('artifact_hash');
  });

  it('rejects malformed K_auto or unknown fields in installGene (negative control)', () => {
    const bad = runtime.installGene({
      gene: {
        type: 'Gene',
        id: 'gene_bad_local',
        category: 'repair',
        tool_policy: { allow_only: [] },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/tool_policy\.allow_only/);
  });

  it('does not mask real stack traces behind earlier JSON lines, while ignoring pure JSON status fields', () => {
    const mixedSignals = runtime._extractSignals('{\n  "step": "upgrade"\n}\nError: socket hang up');
    expect(mixedSignals).toContain('log_error');

    const pureJsonAndComment = runtime._extractSignals('// error handling comment\n{\n  "status": "error",\n  "failed": false\n}');
    expect(pureJsonAndComment).not.toContain('log_error');
    expect(pureJsonAndComment).toEqual(['stable_success_plateau']);
  });
});
