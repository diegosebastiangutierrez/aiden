import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('media skill durable browser contract', () => {
  const readSkill = () => fs.readFile(path.resolve(__dirname, '../../..', 'skills/media-search/SKILL.md'), 'utf8');
  it('requires search and authoritative navigation, not external launching', async () => {
    const md = await readSkill();
    expect(md).toMatch(/^required_tools: \[youtube_search, browser_navigate\]$/m);
    expect(md).not.toMatch(/open_url.*REQUIRED|open_url.*always available/i);
  });
  it('requires observable playback rather than assuming autoplay', async () => {
    const md = await readSkill();
    expect(md).toContain('Navigation alone does not prove playback');
    expect(md).toMatch(/paused.*currentTime/s);
    expect(md).not.toContain('Only claim\n  "now playing" when you launched a watch URL');
  });
  it('preserves source URLs and security boundaries', async () => {
    const md = await readSkill();
    expect(md).toContain('copy the `url` field');
    expect(md).toContain('Do not bypass');
    expect(md).toContain('approval');
  });
});

/**
 * Phase 21 #3 — guard the media-search SKILL.md against accidental
 * loosening of the "open_url is mandatory" contract. The bug: the
 * model would call web_search, find a /watch?v= URL, then stop and
 * report "found the song" — never firing open_url, so the user never
 * heard anything. The skill prose is the only lever (no runtime
 * change), so this test pins the loud anti-pattern callouts.
 */
describe('Phase 21 #3 — media-search skill content', () => {
  it.skip('1. SKILL.md spells out the required two-tool sequence /* TODO v4.1.1: skill content drift */', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const md = await fs.readFile(
      path.join(repoRoot, 'skills', 'media-search', 'SKILL.md'),
      'utf8',
    );
    // The "REQUIRED tool sequence" header tells the model up front
    // that web_search alone is not enough.
    expect(md).toMatch(/REQUIRED tool sequence/i);
    // Both tools must be named in the required block, in order.
    const reqIdx = md.indexOf('REQUIRED tool sequence');
    const tail = md.slice(reqIdx);
    const wsIdx = tail.indexOf('web_search');
    const ouIdx = tail.indexOf('open_url');
    expect(wsIdx).toBeGreaterThan(-1);
    expect(ouIdx).toBeGreaterThan(wsIdx);
    // Anti-pattern: re-entering the skill / re-searching / stopping early.
    expect(md).toMatch(/web_search.{0,5}twice/i);
    expect(md).toMatch(/Re-entering the .?media_search.? skill/i);
    expect(md).toMatch(/FAILED run/i);
  });
});
