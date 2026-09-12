import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
import { createWorkbenchTrustPort, applyWorkbenchTrust } from '../../../core/v4/workbench/trustMode';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { decideAutonomy } from '../../../moat/autonomy';

let bridge: WorkbenchBridge | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });

describe('Workbench trust control', () => {
  it('reports saved truth and persists only supported explicit levels', async () => {
    let level = 'Assistant';
    const save = vi.fn(async (value: string) => { level = value; });
    const port = createWorkbenchTrustPort({ read: () => level as any, save });
    expect(port.snapshot().level).toBe('Assistant');
    await expect(port.set('Partner')).resolves.toMatchObject({ level: 'Partner' });
    await expect(port.set('off' as any)).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not report success when persistence fails', async () => {
    const port = createWorkbenchTrustPort({ read: () => 'Assistant', save: async () => { throw new Error('Storage unavailable'); } });
    await expect(port.set('Partner')).rejects.toThrow('Storage unavailable');
    expect(port.snapshot().level).toBe('Assistant');
  });

  it('requires authorization and rejects foreign origins and invalid levels', async () => {
    let saved: 'Assistant' | 'Partner' = 'Assistant';
    const trust = createWorkbenchTrustPort({ read: () => saved, save: vi.fn(async (value) => { saved = value as typeof saved; }) });
    bridge = await startWorkbenchBridge({ reader: { listEventsScoped: () => [] }, trust, token: 'test-token', port: 0 });
    const url = `http://127.0.0.1:${bridge.port}/api/workbench/trust`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { 'x-workbench-token': 'test-token', Origin: 'https://example.com' }, body: '{"level":"Partner"}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { 'x-workbench-token': 'test-token' }, body: '{"level":"off"}' })).status).toBe(400);
    expect((await fetch(url, { headers: { 'x-workbench-token': 'test-token' } })).status).toBe(200);
    const response = await fetch(url, { method: 'POST', headers: { 'x-workbench-token': 'test-token' }, body: '{"level":"Partner"}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ level: 'Partner', appliesTo: 'new-chat-jobs' });
  });

  it('leaves non-chat, missing-context and always-approved execution unchanged', () => {
    const engine = new ApprovalEngine('smart');
    const context = (job: object) => ({ engine: { getJob: () => job }, jobId: 'test-job', workspacePath: process.cwd() }) as any;
    applyWorkbenchTrust(engine, undefined, 'Partner', 'policy');
    applyWorkbenchTrust(engine, context({ entryPoint: 'automation' }), 'Partner', 'policy');
    applyWorkbenchTrust(engine, context({ entryPoint: 'workbench', automationId: 'automation' }), 'Partner', 'policy');
    applyWorkbenchTrust(engine, context({ entryPoint: 'workbench' }), 'Partner', 'always');
    expect(engine.getAutonomyPolicy()).toBeUndefined();
    applyWorkbenchTrust(engine, context({ entryPoint: 'workbench' }), 'Partner', 'policy');
    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');
    const policy = engine.getAutonomyPolicy()!;
    expect(decideAutonomy(policy, { toolName: 'shell_exec', category: 'execute', args: { command: 'echo hello' } } as any)).toBe('ask');
    expect(decideAutonomy(policy, { toolName: 'file_write', category: 'write', riskTier: 'dangerous', args: { path: `${process.cwd()}/test.txt` } } as any)).toBe('ask');
    expect(engine.setAutonomyPolicy({ ...policy, level: 'Partner' })).toBe(true);
  });

  it('cannot falsely claim mode support on an older runtime', async () => {
    bridge = await startWorkbenchBridge({ reader: { listEventsScoped: () => [] }, token: 'test-token', port: 0 });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/workbench/trust`, { headers: { 'x-workbench-token': 'test-token' } });
    expect(response.status).toBe(503);
  });

  it('serializes writes rather than race conflicting trust settings', async () => {
    let finish!: () => void;
    const port = createWorkbenchTrustPort({ read: () => 'Assistant', save: () => new Promise<void>(resolve => { finish = resolve; }) });
    const pending = port.set('Partner');
    await expect(port.set('Observer')).rejects.toThrow('already in progress');
    finish();
    await pending;
  });
});
