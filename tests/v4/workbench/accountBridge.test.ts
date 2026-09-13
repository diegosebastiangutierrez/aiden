import { afterEach, expect, it, vi } from 'vitest';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
let bridge: WorkbenchBridge | undefined;
afterEach(async () => { await bridge?.close(); });
it('gates every account operation and accepts no browser-supplied secret or scope', async () => {
  const port = { status: vi.fn(async () => ({ state: 'disconnected' as const })),
    begin: vi.fn(async () => ({ state: 'pending' as const })), disconnect: vi.fn(async () => ({ state: 'disconnected' as const })) };
  bridge = await startWorkbenchBridge({ reader: { listEventsScoped: () => [] }, token: 'test-account-token', account: port, port: 0 });
  for (const action of ['status','begin','disconnect'] as const) {
    const url = `http://127.0.0.1:${bridge.port}/api/account/${action}`;
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    const headers = { 'Content-Type': 'application/json', 'x-workbench-token': 'test-account-token' };
    expect((await fetch(url, { method: 'POST', headers, body: '{"credential":"not-allowed"}' })).status).toBe(409);
    expect(port[action]).not.toHaveBeenCalled();
    expect((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://other.example.test' }, body: '{}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(200);
  }
  expect(port.begin).toHaveBeenCalledWith('workbench');
});
it('redacts authority exceptions at the browser boundary', async () => {
  bridge = await startWorkbenchBridge({ reader: { listEventsScoped: () => [] }, token: 'test-account-token', port: 0,
    account: { status: async () => { throw new Error('private-upstream-detail'); }, begin: vi.fn(), disconnect: vi.fn() } });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/account/status`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': 'test-account-token' }, body: '{}' });
  expect(response.status).toBe(409); expect(await response.text()).not.toContain('private-upstream-detail');
});
