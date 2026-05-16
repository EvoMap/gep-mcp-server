import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsService, parseFrontmatter } from '../skills.js';

function makeSkill(rootAbs, dir, frontmatter, body = '## body\n') {
  const skillDir = join(rootAbs, dir);
  mkdirSync(skillDir, { recursive: true });
  const fmLines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) fmLines.push(`${k}: ${v}`);
  fmLines.push('---', '');
  writeFileSync(join(skillDir, 'SKILL.md'), fmLines.join('\n') + body, 'utf8');
  return skillDir;
}

describe('parseFrontmatter', () => {
  it('parses name/description/tags from a typical SKILL.md', () => {
    const md = '---\nname: foo\ndescription: "hello world"\ntags: a, b, c\n---\n\nbody';
    const fm = parseFrontmatter(md);
    expect(fm).toEqual({ name: 'foo', description: 'hello world', tags: 'a, b, c' });
  });

  it('returns {} when no frontmatter', () => {
    expect(parseFrontmatter('# just a heading')).toEqual({});
  });

  it('lowercases keys so consumers can rely on fm.name etc.', () => {
    const md = '---\nName: foo\nDescription: bar\n---\n\nbody';
    expect(parseFrontmatter(md)).toEqual({ name: 'foo', description: 'bar' });
  });
});

describe('SkillsService', () => {
  let bundledRoot;
  let localRoot;
  let service;

  beforeEach(() => {
    bundledRoot = mkdtempSync(join(tmpdir(), 'skills-bundled-'));
    localRoot = mkdtempSync(join(tmpdir(), 'skills-local-'));
    makeSkill(bundledRoot, 'alpha', { name: 'alpha', version: '1.0.0', description: 'bundled alpha skill', tags: 'demo' });
    makeSkill(bundledRoot, '_meta', { name: '_meta', version: '0.1.0', description: 'bootstrap' });
    makeSkill(localRoot, 'beta', { name: 'beta', version: '0.2.0', description: 'local beta skill' });
    service = new SkillsService({ bundledRoot, localRoot, hubFetch: null, isRemote: false });
  });

  afterEach(() => {
    rmSync(bundledRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  });

  it('lists local + bundled and hides _meta by default', async () => {
    const result = await service.listSkills({ source: 'all' });
    const names = result.skills.map(s => s.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).not.toContain('_meta');
  });

  it('surfaces _meta when query targets it', async () => {
    const result = await service.listSkills({ query: 'meta' });
    const names = result.skills.map(s => s.name);
    expect(names).toContain('_meta');
  });

  it('warns when hub source requested but unavailable', async () => {
    const result = await service.listSkills({ source: 'hub' });
    expect(result.warnings?.[0] || '').toMatch(/hub source unavailable/);
    expect(result.skills).toEqual([]);
  });

  it('prefers local over bundled and prefixes the bundled collision', async () => {
    makeSkill(localRoot, 'alpha', { name: 'alpha', version: '0.0.1', description: 'local alpha override' });
    const result = await service.listSkills({ source: 'all' });
    const alphas = result.skills.filter(s => s.name === 'alpha' || s.name === 'bundled:alpha');
    const sources = alphas.map(s => s.source).sort();
    expect(sources).toEqual(['bundled', 'local']);
    const local = alphas.find(s => s.source === 'local');
    const bundled = alphas.find(s => s.source === 'bundled');
    expect(local.name).toBe('alpha');
    expect(bundled.name).toBe('bundled:alpha');
  });

  it('loads bundled skill content', async () => {
    const result = await service.loadSkill({ name: 'alpha' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('bundled');
    expect(result.content).toMatch(/body/);
  });

  it('respects "<source>:<name>" prefix syntax', async () => {
    makeSkill(localRoot, 'alpha', { name: 'alpha', version: '9.9.9', description: 'local alpha' });
    const result = await service.loadSkill({ name: 'bundled:alpha' });
    expect(result.source).toBe('bundled');
    expect(result.version).toBe('1.0.0');
  });

  it('truncates content above maxBytes', async () => {
    const result = await service.loadSkill({ name: 'alpha', maxBytes: 1024 });
    if (Buffer.byteLength(readFileSync(join(bundledRoot, 'alpha', 'SKILL.md'), 'utf8')) > 1024) {
      expect(result.truncated).toBe(true);
    } else {
      // Skill is too small to truncate at 1024; widen and retry to make the
      // assertion meaningful even on small fixtures.
      const padding = 'x'.repeat(2048);
      writeFileSync(join(bundledRoot, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n' + padding, 'utf8');
      service._scanCache.clear();
      const r2 = await service.loadSkill({ name: 'alpha', maxBytes: 512 });
      expect(r2.truncated).toBe(true);
    }
  });

  it('install copies the skill directory into local root', async () => {
    const result = await service.loadSkill({ name: 'alpha', install: true });
    expect(result.ok).toBe(true);
    expect(existsSync(join(localRoot, 'alpha', 'SKILL.md'))).toBe(true);
  });

  it('install refuses to overwrite without force', async () => {
    await service.loadSkill({ name: 'alpha', install: true });
    await expect(service.loadSkill({ name: 'alpha', install: true })).rejects.toThrow(/already installed/);
  });

  it('install rejected in remote mode', async () => {
    const remoteService = new SkillsService({ bundledRoot, localRoot, hubFetch: null, isRemote: true });
    const result = await remoteService.loadSkill({ name: 'alpha', install: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('local_only');
  });

  it('throws when skill name not found', async () => {
    await expect(service.loadSkill({ name: 'does_not_exist' })).rejects.toThrow(/not found/);
  });

  it('hub source through hubFetch', async () => {
    const hubFetch = async ({ op, name }) => {
      if (op === 'list') return { skills: [{ name: 'gamma', version: '3.0.0', description: 'community gamma' }] };
      if (op === 'fetch' && name === 'gamma') {
        return { name: 'gamma', version: '3.0.0', description: 'community gamma', content: '---\nname: gamma\n---\nhub body' };
      }
      return null;
    };
    const s = new SkillsService({ bundledRoot, localRoot, hubFetch, isRemote: true });
    const list = await s.listSkills({ source: 'hub' });
    expect(list.skills.map(x => x.name)).toContain('gamma');
    const loaded = await s.loadSkill({ name: 'gamma', source: 'hub' });
    expect(loaded.content).toMatch(/hub body/);
  });
});
