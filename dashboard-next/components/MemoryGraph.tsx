'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchLearningConflict, WorkbenchLearningEntry } from '../lib/aidenClient';
import { knowledgeGraph, knowledgeScopeLabel } from '../lib/productExperience';
import { CanvasStage } from './CanvasStage';
import { ProductIcon } from './ProductIcon';
import { advanceGraph, createGraphParticles } from '../lib/graphLayout';

export function MemoryGraph({ entries, conflicts, busy, onReview }: { entries: WorkbenchLearningEntry[]; conflicts: WorkbenchLearningConflict[]; busy: boolean; onReview: (id: string) => void }) {
  const graph = useMemo(() => knowledgeGraph(entries, conflicts), [entries, conflicts]);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [motion, setMotion] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const pinned = useRef(new Set<string>());
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const drag = useRef<{ id: string; x: number; y: number; nx: number; ny: number; moved: boolean } | null>(null);
  const layout = useMemo(() => {
    const scopes = graph.nodes.filter(node => node.kind === 'scope');
    const result: Record<string, { x: number; y: number }> = {};
    scopes.forEach((scope, index) => {
      const angle = index / Math.max(scopes.length, 1) * Math.PI * 2 - Math.PI / 2;
      const center = scopes.length === 1 ? { x: 560, y: 350 } : { x: 560 + Math.cos(angle) * 310, y: 350 + Math.sin(angle) * 190 };
      result[scope.id] = center;
      const members = graph.edges.filter(edge => edge.kind === 'scope' && edge.from === scope.id);
      members.forEach((edge, i) => { const theta = i * 2.39996 - .7; const radius = 95 + Math.sqrt(i) * 24; result[edge.to] = { x: center.x + Math.cos(theta) * radius, y: center.y + Math.sin(theta) * radius }; });
    });
    return result;
  }, [graph]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    pinned.current.clear();
    setPositions(layout);
  }, [layout, epoch]);
  useEffect(() => {
    if (!motion || reducedMotion || document.hidden) return;
    const particles = createGraphParticles(layout);
    let frame = 0, handle = 0, stopped = false;
    const step = () => {
      if (stopped || document.hidden) return;
      advanceGraph(particles, graph.edges, Math.max(0, 1 - frame / 180), pinned.current);
      setPositions(previous => Object.fromEntries(Object.entries(particles).map(([id, p]) => {
        if (pinned.current.has(id) && previous[id]) { p.x = previous[id].x; p.y = previous[id].y; }
        return [id, { x: p.x, y: p.y }];
      })));
      if (++frame < 210) handle = requestAnimationFrame(step);
    };
    const visibility = () => { if (document.hidden) { stopped = true; cancelAnimationFrame(handle); } };
    handle = requestAnimationFrame(step);
    document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; cancelAnimationFrame(handle); document.removeEventListener('visibilitychange', visibility); };
  }, [layout, graph.edges, epoch, motion, reducedMotion]);
  const points = Object.values(layout);
  const fitBounds = points.length ? {
    left: Math.min(...points.map(p => p.x)) - 120, right: Math.max(...points.map(p => p.x)) + 120,
    top: Math.min(...points.map(p => p.y)) - 70, bottom: Math.max(...points.map(p => p.y)) + 90,
  } : undefined;
  const point = (id: string) => positions[id] ?? layout[id] ?? { x: 0, y: 0 };
  const active = graph.nodes.find(node => node.id === selected);
  const highlight = hovered ?? (focus && active ? selected : null);
  const focused = Boolean(highlight);
  const record = entries.find(entry => entry.id === active?.entryId);
  const neighborhood = new Set([highlight, ...graph.edges.filter(e => e.from === highlight || e.to === highlight).flatMap(e => [e.from, e.to])]);
  return <div className="memory-graph-shell">
    <div className="memory-graph-header"><div><span className="eyebrow">YOUR KNOWLEDGE, CONNECTED</span><h3>Memory graph</h3></div><div className="graph-legend"><span><i className="scope" />Scope</span><span><i />Memory</span><span><i className="conflict" />Conflict</span><label className="graph-motion-control"><input type="checkbox" checked={motion && !reducedMotion} disabled={reducedMotion} onChange={event => setMotion(event.target.checked)} />{reducedMotion ? 'Reduced motion' : 'Gentle motion'}</label></div></div>
    <div className="memory-graph-body"><CanvasStage label="Interactive memory graph" width={1120} height={700} fitBounds={fitBounds} onBackground={() => setSelected(null)} tools={<button type="button" onClick={() => setEpoch(value => value + 1)}>Reset layout</button>}>
      {zoom => <svg width="1120" height="700" className="memory-graph-svg" aria-label="Recorded memory relationships">
        <defs><radialGradient id="memory-aura"><stop stopColor="var(--orange)" stopOpacity=".1" /><stop offset="1" stopColor="var(--orange)" stopOpacity="0" /></radialGradient></defs>
        <circle cx="560" cy="350" r="310" fill="url(#memory-aura)" />
        {graph.edges.map((edge, i) => { const a = point(edge.from), b = point(edge.to); return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`memory-edge ${edge.kind} ${focused && (edge.from === highlight || edge.to === highlight) ? 'highlighted' : ''}`} opacity={focused && (!neighborhood.has(edge.from) || !neighborhood.has(edge.to)) ? .12 : 1} />; })}
        {graph.nodes.map(node => { const p = point(node.id); return <g data-node="true" key={node.id} transform={`translate(${p.x},${p.y})`} role="button" tabIndex={0} aria-label={`${node.kind === 'scope' ? 'Scope' : 'Memory'}: ${node.label}`} aria-pressed={selected === node.id} className={`memory-node ${node.kind} ${selected === node.id ? 'selected' : ''}`} opacity={focused && !neighborhood.has(node.id) ? .2 : 1}
          onPointerEnter={() => setHovered(node.id)} onPointerLeave={() => setHovered(null)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(node.id); } }}
          onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); pinned.current.add(node.id); drag.current = { id: node.id, x: event.clientX, y: event.clientY, nx: p.x, ny: p.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { const d = drag.current; if (!d || d.id !== node.id) return; const dx = (event.clientX - d.x) / zoom, dy = (event.clientY - d.y) / zoom; if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true; setPositions(old => ({ ...old, [d.id]: { x: Math.max(20, Math.min(1100, d.nx + dx)), y: Math.max(20, Math.min(680, d.ny + dy)) } })); }}
          onPointerUp={() => { if (!drag.current?.moved) setSelected(node.id); drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <circle className="node-halo" r={node.kind === 'scope' ? 32 : 22} /><circle r={node.kind === 'scope' ? 13 : 7} /><text y={node.kind === 'scope' ? 47 : 30} textAnchor="middle" opacity={node.kind === 'scope' || graph.nodes.length <= 12 || selected === node.id || hovered === node.id || zoom > 1.2 ? 1 : 0}>{node.label.length > 34 ? `${node.label.slice(0, 32)}…` : node.label}</text><title>{node.label}</title>
        </g>; })}
      </svg>}
    </CanvasStage><aside className="graph-inspector"><span className="eyebrow">INSPECT KNOWLEDGE</span>{active ? <><h3>{active.kind === 'scope' ? active.label : 'Remembered context'}</h3><p className="graph-selected-content">{active.label}</p>{record && <><span className="product-status">{record.lifecycle.toLowerCase()} · {record.confidence.toLowerCase()}</span><dl><dt>Applies to</dt><dd>{knowledgeScopeLabel(record.scope.kind)}</dd><dt>Source references</dt><dd>{record.sourceCount}</dd><dt>Updated</dt><dd>{new Date(record.updatedAt).toLocaleDateString()}</dd></dl><button type="button" className="product-primary" disabled={busy} onClick={() => onReview(record.id)}>Open sources & history</button></>}<label className="graph-focus"><input type="checkbox" checked={focus} onChange={e => setFocus(e.target.checked)} />Focus connections</label></> : <><div className="graph-inspector-icon"><ProductIcon name="sparkles" size={30} /></div><h3>Follow a thought</h3><p>Select a dot to inspect its memory and sources. Drag nodes to make room, or focus on a single neighbourhood.</p></>}<p className="product-footnote">{graph.nodes.filter(n => n.kind === 'entry').length} memories · {graph.edges.length} recorded links{graph.omitted ? ` · ${graph.omitted} more: narrow your search` : ''}</p><p className="product-footnote">Links show actual scope membership and recorded conflicts—not inferred facts about people or topics.</p></aside></div>
  </div>;
}
