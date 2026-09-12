export interface GraphPoint { x: number; y: number }
export interface GraphParticle extends GraphPoint { vx: number; vy: number }

export function createGraphParticles(positions: Record<string, GraphPoint>): Record<string, GraphParticle> {
  return Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { ...point, vx: 0, vy: 0 }]));
}

/** Presentation only. Springs never create or change a recorded relationship. */
export function advanceGraph(particles: Record<string, GraphParticle>, edges: readonly { from: string; to: string }[], alpha: number, pinned: ReadonlySet<string> = new Set()): void {
  const ids = Object.keys(particles);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = particles[ids[i]], b = particles[ids[j]];
      let dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) + Math.abs(dy) < .01) { dx = Math.cos((i + j) * 2.39996); dy = Math.sin((i + j) * 2.39996); }
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = Math.min(3, 900 / (distance * distance)) * alpha;
      a.vx -= dx / distance * force; a.vy -= dy / distance * force;
      b.vx += dx / distance * force; b.vy += dy / distance * force;
    }
  }
  for (const edge of edges) {
    const a = particles[edge.from], b = particles[edge.to];
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
    const force = (distance - 135) * .012 * alpha;
    a.vx += dx / distance * force; a.vy += dy / distance * force;
    b.vx -= dx / distance * force; b.vy -= dy / distance * force;
  }
  for (const id of ids) {
    const p = particles[id];
    if (pinned.has(id)) { p.vx = 0; p.vy = 0; continue; }
    p.vx = (p.vx + (560 - p.x) * .0015 * alpha) * .72;
    p.vy = (p.vy + (350 - p.y) * .0015 * alpha) * .72;
    p.x = Math.max(70, Math.min(1050, p.x + Math.max(-8, Math.min(8, p.vx))));
    p.y = Math.max(70, Math.min(610, p.y + Math.max(-8, Math.min(8, p.vy))));
  }
}
