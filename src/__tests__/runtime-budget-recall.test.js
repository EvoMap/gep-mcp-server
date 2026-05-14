// Integration tests for schema 1.7.0 budget-aware recall (Meta-Harness
// PoC task D). Exercises the full local-mode pipeline:
// recordOutcome (with / without cost) -> recall (with / without budget)
// -> over_budget flag + conservative fallback for unknown-cost matches.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GepRuntime, resolveBudgetCaps, selectWithinBudget, isOverBudget } from '../runtime.js';

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
    expect(result.budget_applied).toMatchObject({ budget_tokens: 5000, budget_usd: 0.05 });
    expect(result.matches[0].over_budget).toBe(true);
  });
});
