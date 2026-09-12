import type { AutomationRevisionSpec, ScriptStep } from '../../core/v4/automation/types';

export type WorkflowNodeKind = 'trigger' | 'task' | 'read_file' | 'list_directory' | 'fetch' | 'write_file' | 'result';
export interface WorkflowNode { id: string; kind: WorkflowNodeKind; x: number; y: number; data: Record<string, string> }
export interface VisualWorkflow { version: 1; nodes: WorkflowNode[]; edges: Array<{ from: string; to: string }> }
const kinds = new Set(['trigger', 'task', 'read_file', 'list_directory', 'fetch', 'write_file', 'result']);

export function createVisualWorkflow(template: 'task' | 'files'): VisualWorkflow {
  const nodes: WorkflowNode[] = [
    { id: 'trigger', kind: 'trigger', x: 90, y: 180, data: { mode: 'manual', expression: '0 9 * * 1-5', timezone: 'UTC' } },
    ...(template === 'task' ? [{ id: 'task', kind: 'task' as const, x: 390, y: 180, data: { prompt: 'Read package.json and summarise this project.' } }]
      : [{ id: 'list', kind: 'list_directory' as const, x: 390, y: 180, data: { path: '.' } }, { id: 'read', kind: 'read_file' as const, x: 690, y: 180, data: { path: 'package.json' } }]),
    { id: 'result', kind: 'result', x: template === 'task' ? 690 : 990, y: 180, data: {} },
  ];
  return { version: 1, nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })) };
}

export function connectWorkflowNodes(graph: VisualWorkflow, from: string, to: string): VisualWorkflow {
  if (from === to || !graph.nodes.some(node => node.id === from && node.kind !== 'result')
    || !graph.nodes.some(node => node.id === to && node.kind !== 'trigger')) throw new Error('Choose a valid output and input');
  if (graph.edges.some(edge => edge.from === from || edge.to === to)) throw new Error('Disconnect the existing line first. Branching is not supported.');
  let current = to;
  for (let i = 0; i <= graph.nodes.length; i++) {
    if (current === from) throw new Error('This connection would create a cycle');
    const edge = graph.edges.find(candidate => candidate.from === current);
    if (!edge) return { ...graph, edges: [...graph.edges, { from, to }] };
    current = edge.to;
  }
  throw new Error('This graph already contains a cycle');
}

/** A visual document compiles to the existing immutable automation contract. */
export function compileVisualWorkflow(graph: VisualWorkflow): AutomationRevisionSpec {
  if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.nodes.length < 3 || graph.nodes.length > 32 || graph.edges.length !== graph.nodes.length - 1) throw new Error('Connect 3 to 32 blocks in one complete path');
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) || ids.has(node.id) || !kinds.has(node.kind)) throw new Error('Invalid or duplicate block identity');
    ids.add(node.id);
    if (![node.x, node.y].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw new Error('Invalid block position');
    if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)
      || Object.keys(node.data).length > 8 || Object.values(node.data).some(value => typeof value !== 'string' || value.length > 16000)) throw new Error('Invalid block settings');
  }
  const triggers = graph.nodes.filter(node => node.kind === 'trigger');
  if (triggers.length !== 1 || graph.nodes.filter(node => node.kind === 'result').length !== 1) throw new Error('One trigger and one result are required');
  const outgoing = new Map<string, string>(); const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || outgoing.has(edge.from) || incoming.has(edge.to)) throw new Error('Missing blocks, branching or merged paths are not supported');
    outgoing.set(edge.from, edge.to); incoming.add(edge.to);
  }
  if (incoming.has(triggers[0].id)) throw new Error('A trigger cannot have an input');
  const ordered: WorkflowNode[] = []; let node: WorkflowNode | undefined = triggers[0];
  while (node) {
    if (ordered.includes(node)) throw new Error('Workflow contains a cycle');
    ordered.push(node); node = graph.nodes.find(candidate => candidate.id === outgoing.get(node!.id));
  }
  if (ordered.length !== graph.nodes.length || ordered[ordered.length - 1]?.kind !== 'result') throw new Error('Every block must connect from the trigger to the result');
  const trigger = triggers[0].data;
  if (trigger.mode !== 'manual' && trigger.mode !== 'schedule') throw new Error('Choose manual or scheduled start');
  if (trigger.mode === 'schedule' && (!trigger.expression?.trim() || !trigger.timezone?.trim())) throw new Error('Schedule and timezone are required');
  const work = ordered.slice(1, -1);
  if (work.some(item => item.kind === 'task') && (work.length !== 1 || work[0].kind !== 'task')) throw new Error('Keep model tasks and exact-action chains separate in this version');
  const text = (item: WorkflowNode, key: string): string => {
    const value = item.data[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`${item.kind}: ${key} is required`); return value;
  };
  const workspacePath = (item: WorkflowNode): string => {
    const value = text(item, 'path').replace(/\\/g, '/');
    if (value.startsWith('/') || value.includes(':') || value.split('/').includes('..') || /[\u0000-\u001f]/.test(value)) throw new Error('Use a workspace-relative path without traversal or alternate streams');
    return value;
  };
  const steps: ScriptStep[] = []; const capabilities = new Set<string>();
  for (const item of work) {
    if (item.kind === 'task') { capabilities.add('repository.read'); continue; }
    if (item.kind === 'read_file' || item.kind === 'list_directory') {
      capabilities.add('repository.read'); steps.push({ kind: item.kind, path: workspacePath(item) });
    } else if (item.kind === 'write_file') {
      capabilities.add('repository.write'); steps.push({ kind: 'write_file', path: workspacePath(item), content: text(item, 'content') });
    } else if (item.kind === 'fetch') {
      const url = new URL(text(item, 'url'));
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS URL without embedded credentials');
      capabilities.add('web.read'); steps.push({ kind: 'http_request', method: 'GET', url: url.href });
    } else throw new Error('Unsupported execution block');
  }
  const model = work[0].kind === 'task'; const writes = steps.filter(step => step.kind === 'write_file').length;
  return {
    action: model ? { kind: 'prompt', prompt: text(work[0], 'prompt') } : { kind: 'script', script: { version: 1, steps, maxRuntimeMs: 120000 } },
    trigger: trigger.mode === 'manual' ? { kind: 'manual' } : { kind: 'schedule', expression: trigger.expression.trim(), timezone: trigger.timezone.trim() },
    policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
    capabilities: Array.from(capabilities), credentialRefs: [], approval: { mode: writes ? 'always' : 'policy' },
    budget: { runtimeMs: model ? 300000 : 120000, modelCalls: model ? 8 : 0, toolCalls: model ? 40 : steps.length, effects: writes },
    visual: structuredClone(graph),
  };
}
