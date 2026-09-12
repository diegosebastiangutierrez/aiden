import { describe, expect, it } from 'vitest';
import { compileVisualWorkflow, createVisualWorkflow, connectWorkflowNodes } from '../../../core/v4/automation/visualWorkflow';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';

describe('visual workflow compilation', () => {
  it('persists the exact visual revision across reopen and rejects a forged execution binding', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-workflow-'));
    let db = new Database(path.join(dir, 'state.db'));
    try {
      runMigrations(db);
      let authority = createAutomationAuthority({ db });
      const visual = createVisualWorkflow('files');
      const spec = { ...compileVisualWorkflow(visual), workspace: { rootPath: dir } };
      const command = { ...spec, name: 'File review', createdBy: 'test-user', ownerId: 'test-user', requestId: 'visual-create-one' };
      const first = authority.create(command);
      expect(authority.create(command).definition.id).toBe(first.definition.id);
      expect(() => authority.create({ ...command, capabilities: ['repository.write'] })).toThrow(/execution contract/);
      expect(() => authority.create({ ...command, action: { kind: 'prompt', prompt: 'Do something else' } })).toThrow(/execution contract/);
      db.close(); db = new Database(path.join(dir, 'state.db')); authority = createAutomationAuthority({ db });
      expect(authority.getRevision(first.revision.id)?.spec.visual).toEqual(visual);
      const changed = structuredClone(visual); changed.nodes[1].x += 50;
      const revised = authority.revise(first.definition.id, { ...compileVisualWorkflow(changed), workspace: { rootPath: dir } }, { createdBy: 'test-user' });
      expect(revised.revision.revisionNumber).toBe(2);
      expect(authority.getRevision(first.revision.id)?.spec.visual).toEqual(visual);
      expect(revised.revision.spec.visual).toEqual(changed);
    } finally { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('compiles connected operations in edge order rather than screen or array order', () => {
    const graph = createVisualWorkflow('files');
    graph.nodes.reverse();
    const spec = compileVisualWorkflow(graph);
    expect(spec.action.kind).toBe('script');
    if (spec.action.kind === 'script') expect(spec.action.script.steps.map(step => step.kind)).toEqual(['list_directory', 'read_file']);
    expect(spec.trigger).toEqual({ kind: 'manual' });
    expect(spec.capabilities).toEqual(['repository.read']);
  });
  it('keeps an Aiden task on the existing model execution path', () => {
    const spec = compileVisualWorkflow(createVisualWorkflow('task'));
    expect(spec.action.kind).toBe('prompt');
    expect(spec.budget?.modelCalls).toBe(8);
  });
  it('rejects cycles, missing nodes, disconnected nodes and duplicate identities', () => {
    for (const mutation of [
      (g: ReturnType<typeof createVisualWorkflow>) => g.edges.push({ from: 'read', to: 'list' }),
      (g: ReturnType<typeof createVisualWorkflow>) => { g.edges[0].to = 'missing'; },
      (g: ReturnType<typeof createVisualWorkflow>) => { g.edges.pop(); },
      (g: ReturnType<typeof createVisualWorkflow>) => g.nodes.push({ ...g.nodes[0] }),
    ]) { const g = createVisualWorkflow('files'); mutation(g); expect(() => compileVisualWorkflow(g)).toThrow(); }
  });
  it('does not disguise mixed model/tool execution as a deterministic workflow', () => {
    const graph = createVisualWorkflow('files');
    graph.nodes.find(node => node.id === 'list')!.kind = 'task';
    expect(() => compileVisualWorkflow(graph)).toThrow(/separate/);
  });
  it('rejects branches instead of silently dropping an operation', () => {
    const graph = createVisualWorkflow('files'); graph.edges.push({ from: 'trigger', to: 'read' });
    expect(() => compileVisualWorkflow(graph)).toThrow();
  });
  it('requires exact-action approval for workspace writes', () => {
    const graph = createVisualWorkflow('files'); const node = graph.nodes.find(n => n.id === 'read')!;
    node.kind = 'write_file'; node.data = { path: 'result.txt', content: 'Approved content' };
    const spec = compileVisualWorkflow(graph);
    expect(spec.approval).toEqual({ mode: 'always' });
    expect(spec.capabilities).toContain('repository.write');
  });
  it('rejects unsafe paths, unsupported node kinds and credential-bearing URLs', () => {
    for (const path of ['../outside', 'C:\\outside', '/outside', 'folder/../outside', 'file:stream', 'bad\u0000path']) {
      const graph = createVisualWorkflow('files'); graph.nodes.find(n => n.id === 'read')!.data.path = path;
      expect(() => compileVisualWorkflow(graph)).toThrow();
    }
    const graph = createVisualWorkflow('files'); const node = graph.nodes.find(n => n.id === 'read')!;
    node.kind = 'fetch'; node.data = { url: 'https://user:password@example.com' };
    expect(() => compileVisualWorkflow(graph)).toThrow();
    node.kind = 'shell' as never; expect(() => compileVisualWorkflow(graph)).toThrow();
  });
  it('preserves a bounded immutable graph with the compiled revision', () => {
    const graph = createVisualWorkflow('files'); const spec = compileVisualWorkflow(graph);
    expect(spec.visual).toEqual(graph);
    expect(() => compileVisualWorkflow({ ...graph, nodes: Array(100).fill(graph.nodes[0]) })).toThrow();
    expect(() => compileVisualWorkflow({ ...graph, nodes: graph.nodes.map(n => ({ ...n, x: Infinity })) })).toThrow();
  });
  it('refuses invalid new connections without removing existing ones', () => {
    const graph = createVisualWorkflow('files');
    expect(() => connectWorkflowNodes(graph, 'trigger', 'read')).toThrow();
    expect(graph.edges).toHaveLength(3);
  });
});
