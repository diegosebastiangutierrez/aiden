import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchMcpManagement } from '../../../core/v4/workbench/mcpManagement';

function fixture() {
  let servers: Record<string, unknown> = {};
  const live = new Map<string, any>();
  const config = { snapshot: () => ({ mcp: { servers } }), getValue: () => servers, set: (_: string, next: any) => { servers = next; }, save: vi.fn(async () => {}) };
  const client = { get: (name: string) => live.get(name), list: () => [...live.values()], connect: vi.fn(async (value: any) => { const server = { config: value, tools: [], status: 'ready' }; live.set(value.name, server); return server; }), disconnect: vi.fn(async (name: string) => { live.delete(name); }), approveCapabilities: vi.fn() };
  const port = createWorkbenchMcpManagement({ config: config as never, client: client as never, enabled: () => true });
  return { port, config, client, get servers() { return servers; } };
}
const entry = { type: 'stdio', stdio: { command: 'node', args: ['trusted-server.js'] } };
describe('MCP setup confirmation', () => {
  it('previews exact command with no write or spawn, then adds once', async () => {
    const f = fixture(); const preview = f.port.previewAdd('trusted', entry);
    expect(preview.configuration).toEqual(entry);
    expect(f.config.save).not.toHaveBeenCalled(); expect(f.client.connect).not.toHaveBeenCalled();
    await f.port.confirm(preview.confirmationId);
    expect(f.client.connect).toHaveBeenCalledWith({ name: 'trusted', ...entry });
    await expect(f.port.confirm(preview.confirmationId)).rejects.toThrow();
    expect(f.client.connect).toHaveBeenCalledTimes(1);
  });
  it('does not use caller mutation after preview', async () => {
    const f = fixture(); const changed = structuredClone(entry); const preview = f.port.previewAdd('trusted', changed);
    changed.stdio.args[0] = 'different.js'; await f.port.confirm(preview.confirmationId);
    expect(f.client.connect).toHaveBeenCalledWith({ name: 'trusted', ...entry });
  });
  it('rejects collisions appearing after review', async () => {
    const f = fixture(); const preview = f.port.previewAdd('trusted', entry);
    f.config.set('mcp.servers', { trusted: { type: 'http' } });
    await expect(f.port.confirm(preview.confirmationId)).rejects.toThrow(/changed|exists/i);
    expect(f.client.connect).not.toHaveBeenCalled();
  });
  it('preserves other raw configuration and never spawns when persistence fails', async () => {
    const f = fixture(); f.config.set('mcp.servers', { other: { http: { headers: { Authorization: '${EXISTING_TOKEN}' } } } });
    f.config.save.mockRejectedValueOnce(new Error('disk failure'));
    await expect(f.port.confirm(f.port.previewAdd('trusted', entry).confirmationId)).rejects.toThrow();
    expect(f.servers.trusted).toBeUndefined(); expect(JSON.stringify(f.servers)).toContain('${EXISTING_TOKEN}');
    expect(f.client.connect).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'stdio', stdio: { command: 'node', args: [], env: { TOKEN: 'private' } } },
    { type: 'http', http: { baseUrl: 'https://user:password@example.test/mcp' } },
    { type: 'http', http: { baseUrl: 'http://127.0.0.1:1234/mcp', allowLoopbackHttp: true } },
    { type: 'http', http: { baseUrl: 'https://example.test/mcp?token=private' } },
    { type: 'stdio', stdio: { command: 'node', args: ['--api-key=private'] } },
    { ...entry, envAllowlist: ['SECRET'] },
  ])('rejects secret fields and transport policy overrides', unsafe => {
    const f = fixture(); expect(() => f.port.previewAdd('trusted', unsafe)).toThrow();
    expect(f.config.save).not.toHaveBeenCalled();
  });
  it('keeps committed configuration visible when the connection fails', async () => {
    const f = fixture(); f.client.connect.mockRejectedValueOnce(new Error('failed'));
    await expect(f.port.confirm(f.port.previewAdd('trusted', entry).confirmationId)).rejects.toThrow(/saved/i);
    expect(f.port.snapshot().servers[0]).toMatchObject({ name: 'trusted', status: 'disconnected' });
  });
});
