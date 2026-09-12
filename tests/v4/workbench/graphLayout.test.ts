import { describe, expect, it } from 'vitest';
import { advanceGraph, createGraphParticles } from '../../../dashboard-next/lib/graphLayout';

describe('Memory graph presentation physics', () => {
  const positions = { a: { x: 400, y: 300 }, b: { x: 400, y: 300 }, c: { x: 650, y: 350 } };
  const edges = [{ from: 'a', to: 'b' }];
  it('separates overlapping nodes without changing semantic identities or source coordinates', () => {
    const particles = createGraphParticles(positions);
    advanceGraph(particles, edges, 1);
    expect(Math.hypot(particles.a.x - particles.b.x, particles.a.y - particles.b.y)).toBeGreaterThan(0);
    expect(Object.keys(particles)).toEqual(['a', 'b', 'c']);
    expect(positions.a).toEqual({ x: 400, y: 300 });
  });
  it('preserves dragged nodes and ignores unavailable relationship endpoints', () => {
    const particles = createGraphParticles(positions);
    for (let i = 0; i < 200; i++) advanceGraph(particles, [...edges, { from: 'missing', to: 'b' }], .5, new Set(['a']));
    expect(particles.a.x).toBe(400);
    expect(particles.a.y).toBe(300);
    expect(Object.keys(particles)).not.toContain('missing');
  });
  it('stays finite and inside the canvas for the maximum projection size', () => {
    const particles = createGraphParticles(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [String(i), { x: 560, y: 350 }])));
    for (let i = 0; i < 240; i++) advanceGraph(particles, [], 1 - i / 240);
    for (const p of Object.values(particles)) {
      expect(Number.isFinite(p.x + p.y + p.vx + p.vy)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(70); expect(p.x).toBeLessThanOrEqual(1050);
      expect(p.y).toBeGreaterThanOrEqual(70); expect(p.y).toBeLessThanOrEqual(610);
    }
  });
  it('cools to a stable state and is repeatable for the same graph', () => {
    const a = createGraphParticles(positions), b = createGraphParticles(positions);
    for (let i = 0; i < 240; i++) {
      advanceGraph(a, edges, Math.max(0, 1 - i / 180));
      advanceGraph(b, edges, Math.max(0, 1 - i / 180));
    }
    expect(a).toEqual(b);
    expect(Math.max(...Object.values(a).map(p => Math.abs(p.vx) + Math.abs(p.vy)))).toBeLessThan(.001);
  });
});
