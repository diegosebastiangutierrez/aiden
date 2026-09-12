'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export function CanvasStage({ children, label, width = 1200, height = 720, onBackground, tools, fitBounds }: {
  children: ReactNode | ((zoom: number) => ReactNode); label: string; width?: number; height?: number; onBackground?: () => void; tools?: ReactNode;
  fitBounds?: { left: number; top: number; right: number; bottom: number };
}) {
  const host = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState({ x: 20, y: 20, zoom: .7 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const x = event.clientX - box.left, y = event.clientY - box.top;
      setCamera(current => {
        const zoom = Math.max(.2, Math.min(2.5, current.zoom * Math.exp(-event.deltaY * .002)));
        return { x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom, zoom };
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  const zoom = (next: number) => setCamera(current => {
    const z = Math.max(.2, Math.min(2.5, next));
    const box = host.current?.getBoundingClientRect(); const x = (box?.width ?? 800) / 2; const y = (box?.height ?? 500) / 2;
    return { x: x - (x - current.x) * z / current.zoom, y: y - (y - current.y) * z / current.zoom, zoom: z };
  });
  const left = fitBounds?.left ?? 0, top = fitBounds?.top ?? 0;
  const right = fitBounds?.right ?? width, bottom = fitBounds?.bottom ?? height;
  const fit = useCallback(() => {
    const box = host.current?.getBoundingClientRect(); if (!box) return;
    const z = Math.max(.2, Math.min(1, (box.width - 60) / Math.max(1, right - left), (box.height - 80) / Math.max(1, bottom - top)));
    setCamera({ x: box.width / 2 - (left + right) / 2 * z, y: box.height / 2 - (top + bottom) / 2 * z, zoom: z });
  }, [left, top, right, bottom]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(fit); observer.observe(element); fit();
    return () => observer.disconnect();
  }, [fit]);
  return <div className="spatial-stage" ref={host} role="region" aria-label={label} tabIndex={0}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === '+') zoom(camera.zoom + .1); else if (event.key === '-') zoom(camera.zoom - .1); else if (event.key === '0') fit(); else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setCamera(c => ({ ...c, x: c.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: c.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) })); } }}
    onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest('button,input,select,textarea,a,[data-node]')) return; drag.current = { x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (!drag.current) return; const dx = event.clientX - drag.current.x; const dy = event.clientY - drag.current.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true; setCamera(c => ({ ...c, x: drag.current!.cx + dx, y: drag.current!.cy + dy })); }}
    onPointerUp={() => { if (drag.current && !drag.current.moved) onBackground?.(); drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    <div className="spatial-world" style={{ width, height, transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})` }}>{typeof children === 'function' ? children(camera.zoom) : children}</div>
    <div className="spatial-controls" onPointerDown={e => e.stopPropagation()}><button type="button" aria-label="Zoom out" onClick={() => zoom(camera.zoom - .15)}>−</button><span>{Math.round(camera.zoom * 100)}%</span><button type="button" aria-label="Zoom in" onClick={() => zoom(camera.zoom + .15)}>+</button><button type="button" onClick={fit}>Fit view</button>{tools}</div>
    <span className="spatial-hint">Drag to explore · Ctrl/⌘ + scroll to zoom · 0 to fit</span>
  </div>;
}
