import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchMcpAuthorization } from '../../../core/v4/workbench/mcpAuthorization';

function fixture(run?: any) {
  let entry = { type: 'http', http: { baseUrl: 'https://mcp.example.com' } };
  const config = { getValue: () => ({ remote: entry }) };
  const connect = vi.fn(async () => ({ status: 'ready' }));
  const port = createWorkbenchMcpAuthorization({ config: config as never, paths: {} as never, client: { get: () => undefined, connect, authorizeAndConnect: connect } as never,
    enabled: () => true, isIdle: () => true, run });
  return { port, connect, change: () => { entry = { ...entry, http: { baseUrl: 'https://other.example.com' } }; } };
}

describe('Workbench MCP authorization lifecycle', () => {
  it('keeps consent pending until authorization and canonical connection complete', async () => {
    let release!: () => void;
    const f = fixture(async ({ onAuthorization, beforePersist }: any) => {
      await onAuthorization({ url: 'https://login.example.com/authorize', userCode: 'test-code', expiresAt: Date.now() + 60000 });
      await new Promise<void>(resolve => { release = resolve; }); beforePersist();
    });
    f.port.start('remote'); await vi.waitFor(() => expect(f.port.snapshot()?.state).toBe('waiting'));
    expect(f.connect).not.toHaveBeenCalled(); expect(() => f.port.start('remote')).toThrow(/progress/i);
    release(); await vi.waitFor(() => expect(f.port.snapshot()?.state).toBe('connected'));
    expect(f.connect).toHaveBeenCalledOnce(); expect(f.port.snapshot()?.url).toBeUndefined();
    await f.port.close();
  });
  it('cancels only the exact request and cleans transient consent details', async () => {
    let cleaned = false;
    const f = fixture(async ({ signal, onAuthorization }: any) => {
      await onAuthorization({ url: 'https://login.example.com/authorize', expiresAt: Date.now() + 60000 });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cleaned = true; resolve(); }, { once: true }));
    });
    const request = f.port.start('remote'); await vi.waitFor(() => expect(f.port.snapshot()?.state).toBe('waiting'));
    await expect(f.port.cancel('wrong')).rejects.toThrow(/request/i); expect(cleaned).toBe(false);
    await f.port.cancel(request.id); expect(cleaned).toBe(true);
    expect(f.port.snapshot()).toMatchObject({ state: 'cancelled' }); expect(f.port.snapshot()?.url).toBeUndefined(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('rejects configuration changes before credential persistence', async () => {
    let release!: () => void; const persisted = vi.fn();
    const f = fixture(async ({ beforePersist }: any) => { await new Promise<void>(r => { release = r; }); beforePersist(); persisted(); });
    f.port.start('remote'); await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.change(); release();
    await vi.waitFor(() => expect(f.port.snapshot()?.state).toBe('failed')); expect(persisted).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('aborts owned authorization on shutdown and rejects later requests', async () => {
    const f = fixture(async ({ signal }: any) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
    f.port.start('remote'); await f.port.close(); expect(f.port.snapshot()?.state).toBe('cancelled'); expect(() => f.port.start('remote')).toThrow(/closed/i);
  });
  it('does not expose provider error text or accept unsafe consent links', async () => {
    const f = fixture(async ({ onAuthorization }: any) => { await onAuthorization({ url: 'javascript:alert(1)', expiresAt: Date.now() + 1000 }); throw new Error('access_token=secret'); });
    f.port.start('remote'); await vi.waitFor(() => expect(f.port.snapshot()?.state).toBe('failed'));
    expect(JSON.stringify(f.port.snapshot())).not.toMatch(/access_token|javascript|secret/);
  });
  it('does not mistake a needs-auth connection for a ready server', async () => {
    const f = fixture(async ({ beforePersist }: any) => beforePersist());
    f.connect.mockResolvedValue({ status: 'needs-auth' }); f.port.start('remote');
    await vi.waitFor(() => expect(f.port.snapshot()?.state).toBe('authorized'));
    expect(f.port.snapshot()?.message).toContain('connection failed');
  });
});
