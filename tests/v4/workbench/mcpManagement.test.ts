/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchMcpManagement } from '../../../core/v4/workbench/mcpManagement';

function fixture() {
  let configured: Record<string, unknown> = { docs: { type: 'http', http: { baseUrl: 'https://docs.example.test/mcp', headers: { Authorization: 'private-credential' } } } };
  let live: any = { config: { name: 'docs', ...configured.docs as object }, status: 'ready', tools: [{ rawName: 'read', description: 'Read documents', inputSchema: { type: 'object' }, effect: 'read_only' }], externalIdentityId: 'identity', capabilitySnapshotId: 'snapshot', capabilityReviewRequired: true, mutationBlocked: true };
  let now = 1000;
  const config = { getValue: vi.fn(() => configured), snapshot: () => ({ mcp: { servers: configured } }), set: (_: string, value: any) => { configured = value; }, save: vi.fn(async () => {}) };
  const client = { list: () => live ? [live] : [], get: () => live, disconnect: vi.fn(async () => { live = undefined; }), connect: vi.fn(async (value: any) => { live = { config: value, status: 'ready', tools: [] }; return live; }), approveCapabilities: vi.fn() };
  const create = (enabled = true) => createWorkbenchMcpManagement({ config: config as never, client: client as never, enabled: () => enabled, now: () => now });
  return { config, client, create, setLive: (value: any) => { live = value; }, get live() { return live; }, get configured() { return configured; }, advance: () => { now += 600_000; } };
}

describe('MCP connection management', () => {
  it('lists configured disconnected servers without exposing credentials or raw arguments', () => {
    const f = fixture(); f.setLive(undefined);
    const result = f.create().snapshot();
    expect(result.servers[0]).toMatchObject({ name: 'docs', status: 'disconnected' });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });
  it('preview has no effects; confirmation reconnects through the canonical client once', async () => {
    const f = fixture(), port = f.create();
    const preview = port.preview('docs', 'reconnect');
    expect(f.client.disconnect).not.toHaveBeenCalled();
    await port.confirm(preview.confirmationId);
    expect(f.client.connect).toHaveBeenCalledTimes(1);
    await expect(port.confirm(preview.confirmationId)).rejects.toThrow(/expired|used/i);
  });
  it('rejects changed endpoint, arguments or capabilities after preview', async () => {
    for (const change of ['endpoint', 'arguments', 'capabilities']) {
      const f = fixture(), port = f.create();
      const preview = port.preview('docs', 'review');
      if (change === 'endpoint') (f.configured.docs as any).http.baseUrl += '/changed';
      if (change === 'arguments') (f.configured.docs as any).stdio = { command: 'other', args: ['changed'] };
      if (change === 'capabilities') f.live.capabilitySnapshotId = 'new-snapshot';
      await expect(port.confirm(preview.confirmationId)).rejects.toThrow(/changed/i);
      expect(f.client.approveCapabilities).not.toHaveBeenCalled();
    }
  });
  it('rejects expired or previous-runtime confirmations', async () => {
    const f = fixture(), port = f.create();
    const preview = port.preview('docs', 'remove'); f.advance();
    await expect(port.confirm(preview.confirmationId)).rejects.toThrow(/expired/i);
    await expect(f.create().confirm(preview.confirmationId)).rejects.toThrow(/expired|used/i);
    expect(f.config.save).not.toHaveBeenCalled();
  });
  it('removes only the selected configuration after stopping its transport', async () => {
    const f = fixture(); f.configured.other = { type: 'stdio' };
    const port = f.create();
    await port.confirm(port.preview('docs', 'remove').confirmationId);
    expect(f.client.disconnect).toHaveBeenCalledWith('docs');
    expect(f.configured).toEqual({ other: { type: 'stdio' } });
    expect(f.config.save).toHaveBeenCalledTimes(1);
  });
  it('restores in-memory configuration when persistence fails', async () => {
    const f = fixture(), port = f.create();
    f.config.save.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(port.confirm(port.preview('docs', 'remove').confirmationId)).rejects.toThrow();
    expect(f.configured.docs).toBeDefined();
  });
  it('preserves environment references in other saved connections', async () => {
    const f = fixture();
    f.configured.other = { type: 'http', http: { baseUrl: 'https://other.example.test', headers: { Authorization: '${MCP_TEST_TOKEN}' } } };
    f.config.getValue.mockImplementation(() => ({ ...f.configured, other: { type: 'http', http: { headers: { Authorization: 'resolved-test-value' } } } }));
    const port = f.create();
    await port.confirm(port.preview('docs', 'remove').confirmationId);
    expect(JSON.stringify(f.configured)).toContain('${MCP_TEST_TOKEN}');
    expect(JSON.stringify(f.configured)).not.toContain('resolved-test-value');
  });
  it('does not delete a connection changed while disconnect was in flight', async () => {
    const f = fixture(), port = f.create();
    f.client.disconnect.mockImplementationOnce(async () => { (f.configured.docs as any).http.baseUrl = 'https://changed.example.test'; f.setLive(undefined); });
    await expect(port.confirm(port.preview('docs', 'remove').confirmationId)).rejects.toThrow(/changed/i);
    expect(f.config.save).not.toHaveBeenCalled();
  });
  it('accepts only the exact canonical capability snapshot without granting trust', async () => {
    const f = fixture(), port = f.create();
    const preview = port.preview('docs', 'review');
    expect(preview.tools[0]).toMatchObject({ name: 'read', effect: 'read_only' });
    await port.confirm(preview.confirmationId);
    expect(f.client.approveCapabilities).toHaveBeenCalledWith('docs', 'workbench-user');
  });
  it('does not start OAuth or bypass missing authorization on reconnect', async () => {
    const f = fixture(), port = f.create(); f.live.status = 'needs-auth';
    expect(() => port.preview('docs', 'reconnect')).toThrow(/authoriz/i);
    expect(f.client.connect).not.toHaveBeenCalled();
  });
  it('fails closed for disabled capability, unknown names and invalid actions', () => {
    const f = fixture();
    expect(() => f.create(false).preview('docs', 'remove')).toThrow(/unavailable/i);
    expect(() => f.create().preview('../other', 'remove')).toThrow();
    expect(() => f.create().preview('docs', 'execute' as never)).toThrow();
  });
});
