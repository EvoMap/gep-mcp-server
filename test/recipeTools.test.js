// P4d — gep_build_recipe / gep_reuse_recipe on RemoteRuntime. A fake fetch
// records the calls so we can assert: build defaults to DRAFT (POST /a2a/recipe
// only, no publish) and only publishes when publish:true; reuse does GET then
// POST .../express. No network.

import { describe, it, expect } from 'vitest';
import { RemoteRuntime } from '../src/remote.js';

const A64 = 'sha256:' + 'a'.repeat(64);
const B64 = 'sha256:' + 'b'.repeat(64);

function makeRuntime() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ method: opts.method, url, body: opts.body ? JSON.parse(opts.body) : undefined });
    let data = { ok: true };
    if (opts.method === 'POST' && url.endsWith('/a2a/recipe')) data = { recipe: { id: 'recipe-xyz' } };
    else if (url.includes('/publish')) data = { status: 'published' };
    else if (url.includes('/express')) data = { organism_id: 'org-1' };
    else if (opts.method === 'GET') data = { id: 'recipe-xyz', title: 'R' };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  const rt = new RemoteRuntime({
    hubUrl: 'https://dev.evomap.ai',
    nodeId: 'node-test',
    nodeSecret: 'n'.repeat(64),
    fetchImpl,
    sleepImpl: async () => {},
  });
  return { rt, calls };
}

describe('gep_build_recipe (P4d)', () => {
  it('creates a DRAFT by default — no publish call', async () => {
    const { rt, calls } = makeRuntime();
    const res = await rt.buildRecipe({
      title: 'My Recipe',
      steps: [{ asset_id: A64, asset_type: 'Gene' }, { asset_id: B64, asset_type: 'Capsule' }],
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('draft');
    expect(res.recipe_id).toBe('recipe-xyz');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/a2a\/recipe$/);
    expect(calls.some((c) => c.url.includes('/publish'))).toBe(false);
    // positions default to array order
    expect(posts[0].body.steps.map((s) => s.position)).toEqual([0, 1]);
  });

  it('publishes only when publish:true', async () => {
    const { rt, calls } = makeRuntime();
    const res = await rt.buildRecipe({
      title: 'My Recipe',
      steps: [{ asset_id: A64, asset_type: 'Gene' }],
      publish: true,
    });
    expect(res.status).toBe('published');
    expect(calls.some((c) => c.url.endsWith('/a2a/recipe'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/recipe/recipe-xyz/publish'))).toBe(true);
  });

  it('rejects a bad asset_id', async () => {
    const { rt } = makeRuntime();
    await expect(
      rt.buildRecipe({ title: 'Valid title', steps: [{ asset_id: 'not-a-hash', asset_type: 'Gene' }] }),
    ).rejects.toThrow(/asset_id/);
  });

  it('rejects > 20 steps', async () => {
    const { rt } = makeRuntime();
    const steps = Array.from({ length: 21 }, () => ({ asset_id: A64, asset_type: 'Gene' }));
    await expect(rt.buildRecipe({ title: 'Valid title', steps })).rejects.toThrow(/20 steps/);
  });
});

describe('gep_reuse_recipe (P4d)', () => {
  it('fetches then expresses', async () => {
    const { rt, calls } = makeRuntime();
    const res = await rt.reuseRecipe({ recipe_id: 'recipe-xyz', input_payload: { q: 1 } });
    expect(res.ok).toBe(true);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toMatch(/\/a2a\/recipe\/recipe-xyz$/);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toMatch(/\/express$/);
    expect(calls[1].body.input_payload).toEqual({ q: 1 });
  });

  it('requires recipe_id', async () => {
    const { rt } = makeRuntime();
    await expect(rt.reuseRecipe({})).rejects.toThrow(/recipe_id/);
  });
});
