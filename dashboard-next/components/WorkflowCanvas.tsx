'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { compileVisualWorkflow, connectWorkflowNodes, createVisualWorkflow, type VisualWorkflow, type WorkflowNodeKind } from '../../shared/workflows/visualWorkflow';
import { saveVisualWorkflow, type WorkbenchAutomationSummary } from '../lib/aidenClient';
import { CanvasStage } from './CanvasStage';
import { ProductIcon, type ProductIconName } from './ProductIcon';

const blocks: Record<WorkflowNodeKind, { label: string; icon: ProductIconName; description: string }> = {
  trigger: { label: 'Start', icon: 'clock', description: 'Manual or scheduled' },
  task: { label: 'Aiden task', icon: 'sparkles', description: 'A read-only model task' },
  read_file: { label: 'Read file', icon: 'file', description: 'Read an exact workspace file' },
  list_directory: { label: 'List folder', icon: 'apps', description: 'Inspect a workspace folder' },
  fetch: { label: 'Read web page', icon: 'browser', description: 'Fetch a public HTTPS page' },
  write_file: { label: 'Write file', icon: 'artifact', description: 'Exact content, with approval' },
  result: { label: 'Result & Evidence', icon: 'check', description: 'Open the durable run history' },
};
const defaults: Record<WorkflowNodeKind, Record<string, string>> = { trigger: { mode: 'manual', expression: '0 9 * * 1-5', timezone: 'UTC' }, task: { prompt: '' }, read_file: { path: 'package.json' }, list_directory: { path: '.' }, fetch: { url: 'https://example.com' }, write_file: { path: 'report.txt', content: '' }, result: {} };

export function WorkflowCanvas({ existing, onSaved, onClose }: { existing?: WorkbenchAutomationSummary; onSaved: () => void; onClose: () => void }) {
  const [graph, setGraph] = useState<VisualWorkflow>(() => structuredClone(existing?.visual ?? createVisualWorkflow('files')));
  const [name, setName] = useState(existing?.name ?? 'Repository file review');
  const [selected, setSelected] = useState('trigger');
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const review = useRef<HTMLElement>(null);
  useEffect(() => { if (confirmSave) review.current?.scrollIntoView({ block: 'nearest' }); }, [confirmSave]);
  const request = useRef<string | null>(null);
  const drag = useRef<{ id: string; sx: number; sy: number; x: number; y: number } | null>(null);
  const validation = useMemo(() => { try { return { spec: compileVisualWorkflow(graph), error: null }; } catch (error) { return { spec: null, error: error instanceof Error ? error.message : 'Invalid workflow' }; } }, [graph]);
  const node = graph.nodes.find(item => item.id === selected);
  const change = (next: VisualWorkflow | ((old: VisualWorkflow) => VisualWorkflow)) => { setGraph(next); setConfirmSave(false); setMessage(null); request.current = null; };
  const updateData = (key: string, value: string) => change(g => ({ ...g, nodes: g.nodes.map(n => n.id === selected ? { ...n, data: { ...n.data, [key]: value } } : n) }));
  const connect = (to: string) => { if (!connectFrom) { setMessage('Select an output port first'); return; } try { change(connectWorkflowNodes(graph, connectFrom, to)); setConnectFrom(null); } catch (error) { setMessage((error as Error).message); } };
  const add = (kind: WorkflowNodeKind) => { if (graph.nodes.length >= 32) { setMessage('This workflow supports up to 32 blocks'); return; } const id = `node_${crypto.randomUUID().replaceAll('-', '')}`; change(g => ({ ...g, nodes: [...g.nodes, { id, kind, x: 180 + (g.nodes.length % 4) * 260, y: 380 + Math.floor(g.nodes.length / 4) * 50, data: { ...defaults[kind] } }] })); setSelected(id); };
  const save = async () => {
    if (!validation.spec || !name.trim() || saving) return;
    setSaving(true); setMessage(null); request.current ??= crypto.randomUUID();
    try { await saveVisualWorkflow({ name: name.trim(), spec: validation.spec, requestId: request.current, automationId: existing?.automationId }); onSaved(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Workflow was not saved'); }
    finally { setSaving(false); }
  };
  const chooseTemplate = (template: 'task' | 'files') => { change(createVisualWorkflow(template)); setSelected('trigger'); setConnectFrom(null); setName(template === 'task' ? 'Project summary' : 'Repository file review'); };
  return <section className="workflow-canvas-shell" aria-label="Visual workflow editor">
    <header className="workflow-canvas-toolbar"><div><span className="eyebrow">VISUAL WORKFLOW</span><input aria-label="Workflow name" disabled={saving} value={name} readOnly={Boolean(existing)} maxLength={200} onChange={e => { setName(e.target.value); setConfirmSave(false); request.current = null; }} /></div><div><span className={`product-status ${validation.error ? 'attention' : 'connected'}`}>{validation.error ? 'Needs connections' : 'Ready to save'}</span><button type="button" className="nav-btn" disabled={saving} onClick={onClose}>Close editor</button><button type="button" className="product-primary" disabled={saving || !validation.spec || !name.trim()} onClick={() => setConfirmSave(true)}>Review & save</button></div></header>
    <div className="workflow-canvas-body"><aside className="workflow-palette"><span className="eyebrow">STARTING POINTS</span><button type="button" disabled={Boolean(existing) || saving} onClick={() => chooseTemplate('files')}>Exact-action chain</button><button type="button" disabled={Boolean(existing) || saving} onClick={() => chooseTemplate('task')}>Aiden model task</button><span className="eyebrow">ADD A BLOCK</span>{(['read_file', 'list_directory', 'fetch', 'write_file', 'task'] as const).map(kind => <button type="button" key={kind} disabled={saving} onClick={() => add(kind)}><ProductIcon name={blocks[kind].icon} size={18} /><span>{blocks[kind].label}</span><span>+</span></button>)}<p className="product-footnote">Connect one path from Start to Result. Model tasks run separately from exact-action chains. Branching and data mappings are not supported in this version.</p></aside>
      <CanvasStage label="Workflow canvas" width={1280} height={700} onBackground={() => setConnectFrom(null)}>
        {zoom => <><svg className="workflow-wires" width="1600" height="900" aria-label="Workflow connections"><defs><marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="currentColor" /></marker></defs>{graph.edges.map(edge => { const a = graph.nodes.find(n => n.id === edge.from), b = graph.nodes.find(n => n.id === edge.to); if (!a || !b) return null; return <path key={`${edge.from}:${edge.to}`} d={`M${a.x + 224},${a.y + 55} C${a.x + 270},${a.y + 55} ${b.x - 50},${b.y + 55} ${b.x},${b.y + 55}`} markerEnd="url(#workflow-arrow)" />; })}</svg>
          {graph.nodes.map(n => <article key={n.id} data-node="true" className={`workflow-block kind-${n.kind} ${selected === n.id ? 'selected' : ''}`} style={{ left: n.x, top: n.y }}>
            {n.kind !== 'trigger' && <button type="button" className="workflow-port input" aria-label={`Connect input of ${blocks[n.kind].label} ${n.id}`} disabled={saving} onClick={() => connect(n.id)} />}
            <button type="button" className="workflow-block-drag" aria-label={`Edit ${blocks[n.kind].label} ${n.id}`} onClick={() => setSelected(n.id)}
              onPointerDown={event => { if (saving) return; event.stopPropagation(); setSelected(n.id); drag.current = { id: n.id, sx: event.clientX, sy: event.clientY, x: n.x, y: n.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={event => { const d = drag.current; if (!d || d.id !== n.id) return; const x = Math.max(10, Math.min(1350, d.x + (event.clientX - d.sx) / zoom)), y = Math.max(10, Math.min(760, d.y + (event.clientY - d.sy) / zoom)); change(g => ({ ...g, nodes: g.nodes.map(item => item.id === d.id ? { ...item, x, y } : item) })); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
              <span className="workflow-block-icon"><ProductIcon name={blocks[n.kind].icon} size={23} /></span><span><strong>{blocks[n.kind].label}</strong><small>{n.kind === 'trigger' ? (n.data.mode === 'schedule' ? n.data.expression : 'When you run it') : n.data.path || n.data.url || (n.kind === 'task' ? 'Read-only model execution' : blocks[n.kind].description)}</small></span>
            </button>{n.kind !== 'result' && <button type="button" className={`workflow-port output ${connectFrom === n.id ? 'connecting' : ''}`} aria-label={`Connect output of ${blocks[n.kind].label} ${n.id}`} disabled={saving} onClick={() => { setConnectFrom(n.id); setMessage('Now select the next block’s input port'); }} />}
          </article>)}
        </>}
      </CanvasStage>
      <aside className="workflow-inspector"><span className="eyebrow">BLOCK SETTINGS</span>{node && <><h3>{blocks[node.kind].label}</h3><p>{blocks[node.kind].description}</p>{node.kind === 'trigger' ? <><label>Start mode<select value={node.data.mode} disabled={saving} onChange={e => updateData('mode', e.target.value)}><option value="manual">Manual — Run now</option><option value="schedule">Schedule</option></select></label>{node.data.mode === 'schedule' && <><label>Cron schedule<input value={node.data.expression ?? ''} disabled={saving} onChange={e => updateData('expression', e.target.value)} /></label><label>Timezone<input value={node.data.timezone ?? ''} disabled={saving} onChange={e => updateData('timezone', e.target.value)} /></label></>}</> : <>{Object.entries(node.data).map(([key, value]) => <label key={key}>{key === 'path' ? 'Workspace-relative path' : key === 'url' ? 'Public HTTPS URL' : key === 'prompt' ? 'Task instructions' : 'Exact file content'}{key === 'content' || key === 'prompt' ? <textarea rows={6} value={value} disabled={saving} onChange={e => updateData(key, e.target.value)} /> : <input value={value} disabled={saving} onChange={e => updateData(key, e.target.value)} />}</label>)}</>}
        {node.kind === 'write_file' && <p className="workflow-safety-note">Requires exact-action approval when executed. Saving does not write this file.</p>}
        {node.kind === 'result' && <p>Results, tool events, Evidence and Verification are recorded by the existing Job system. Open Run history after execution.</p>}
        {graph.edges.filter(edge => edge.from === node.id || edge.to === node.id).map(edge => <button type="button" className="nav-btn" key={`${edge.from}:${edge.to}`} disabled={saving} onClick={() => change(g => ({ ...g, edges: g.edges.filter(e => e !== edge) }))}>Disconnect {edge.from === node.id ? 'output' : 'input'}</button>)}
        {!['trigger', 'result'].includes(node.kind) && <button type="button" className="workflow-remove" disabled={saving} onClick={() => { change(g => ({ ...g, nodes: g.nodes.filter(n => n.id !== node.id), edges: g.edges.filter(e => e.from !== node.id && e.to !== node.id) })); setSelected('trigger'); }}>Remove block</button>}
      </>}<p className="product-footnote">Dragging changes layout, not execution order. Connected lines determine the exact order.</p></aside>
    </div>
    <div className="workflow-canvas-status" role="status">{message ?? validation.error ?? 'Connected and valid. Saving creates a durable workflow; manual workflows run only when you choose Run now.'}</div>
{confirmSave && validation.spec && <section ref={review} className="workflow-save-review" aria-label="Review workflow before saving"><h3>{existing ? 'Save a new revision?' : 'Save this workflow?'}</h3><p>{graph.nodes.length - 2} execution blocks · {validation.spec.trigger.kind === 'manual' ? 'Manual start' : 'Scheduled start — future runs become enabled'} · {validation.spec.approval?.mode === 'always' ? 'Exact-action approval required' : 'Normal Aiden approvals'}</p><p>Previous runs retain their original revision. This workspace and its normal security policies remain in control.</p><button className="product-primary" type="button" disabled={saving} onClick={() => { void save(); }}>{saving ? 'Saving…' : 'Confirm save'}</button><button className="nav-btn" type="button" disabled={saving} onClick={() => setConfirmSave(false)}>Keep editing</button></section>}
  </section>;
}
