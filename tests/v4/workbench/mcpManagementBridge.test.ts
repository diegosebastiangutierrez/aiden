/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
let bridge: WorkbenchBridge | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });
describe('MCP management bridge authority', () => {
  it('requires the current runtime token and rejects cross-site reads and writes', async () => {
    const management = { snapshot: vi.fn(() => ({ available: true, servers: [] })), preview: vi.fn(() => ({ confirmationId: 'one-use' })), confirm: vi.fn(async () => ({ available: true, servers: [] })) };
    bridge = await startWorkbenchBridge({ reader: { listEventsScoped: () => [] }, token: 'current-runtime-token', port: 0, mcpManagement: management as never });
    const url = `http://127.0.0.1:${bridge.port}/api/mcp/management`;
    expect((await fetch(url)).status).toBe(401);
    for (const suffix of ['/preview', '/confirm', '/add', '/cancel-authorization']) {
      expect((await fetch(url + suffix, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-token': 'other-workspace-token' }, body: '{}' })).status).toBe(401);
      expect((await fetch(url + suffix, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-token': 'current-runtime-token', origin: 'https://unrelated.example.test' }, body: '{}' })).status).toBe(403);
    }
    expect(management.preview).not.toHaveBeenCalled(); expect(management.confirm).not.toHaveBeenCalled();
    const headers = { 'content-type': 'application/json', 'x-workbench-token': 'current-runtime-token' };
    expect((await fetch(url, { headers })).status).toBe(200);
    expect((await fetch(url + '/preview', { method: 'POST', headers, body: JSON.stringify({ name: 'docs', action: 'reconnect' }) })).status).toBe(200);
    expect(management.preview).toHaveBeenCalledWith('docs', 'reconnect');
    expect((await fetch(url + '/confirm', { method: 'POST', headers, body: JSON.stringify({ confirmationId: 'one-use' }) })).status).toBe(200);
    expect(management.confirm).toHaveBeenCalledWith('one-use');
  });
  it('rejects malformed bodies without calling control methods', async () => {
    const management = { snapshot: vi.fn(), preview: vi.fn(), confirm: vi.fn() };
    bridge = await startWorkbenchBridge({ reader: { listEventsScoped: () => [] }, token: 'runtime-token', port: 0, mcpManagement: management as never });
    const url = `http://127.0.0.1:${bridge.port}/api/mcp/management`;
    const headers = { 'content-type': 'application/json', 'x-workbench-token': 'runtime-token' };
    expect((await fetch(url + '/preview', { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await fetch(url + '/confirm', { method: 'POST', headers, body: '{"confirmationId":42}' })).status).toBe(400);
    expect(management.preview).not.toHaveBeenCalled(); expect(management.confirm).not.toHaveBeenCalled();
  });
});
