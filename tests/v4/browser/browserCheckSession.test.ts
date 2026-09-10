import { describe, expect, it, vi } from 'vitest';
import { BrowserCheckSessions } from '../../../core/v4/browser/browserCheckSession';
import { parseBrowserCheckContract } from '../../../core/v4/browser/browserCheckContract';

const contract = parseBrowserCheckContract({ version: 1, customerId: 'customer-a', specDigest: 'a'.repeat(64),
  origin: 'http://127.0.0.1:8123', allowLoopback: true, mutationPaths: ['/save'],
  observations: [{ id: 'saved', flowId: 'form', selector: '#result', kind: 'text', expected: 'Saved' }] });
function fixture() {
  const contexts: any[] = [];
  const browser = { close: vi.fn(async () => {}), newContext: vi.fn(async (options: any) => {
    const context = { options, close: vi.fn(async () => {}), route: vi.fn(async () => {}),
      routeWebSocket: vi.fn(async () => {}) };
    contexts.push(context); return context;
  }) };
  const launch = vi.fn(async () => browser);
  const fetchResponse = vi.fn(async () => ({ status: 200, headers: {} as Record<string, string>, body: Buffer.from('Ready') }));
  return { sessions: new BrowserCheckSessions(launch, fetchResponse), launch, browser, contexts, fetchResponse };
}
const request = (url: string, method: string) => ({ url: () => url, method: () => method,
  allHeaders: async () => ({}), postDataBuffer: () => null });
describe('isolated approved browser checks', () => {
  it('reuses only the same immutable session and isolates different customer runs', async () => {
    const f = fixture();
    const a = await f.sessions.context('one', contract);
    expect(await f.sessions.context('one', contract)).toBe(a);
    expect(await f.sessions.context('two', { ...contract, customerId: 'customer-b' })).not.toBe(a);
    await expect(f.sessions.context('one', { ...contract, specDigest: 'b'.repeat(64) })).rejects.toThrow();
    expect(f.contexts).toHaveLength(2);
    expect(f.contexts[0].options).toMatchObject({ serviceWorkers: 'block', acceptDownloads: false });
  });
  it('enforces request scope at the network boundary and closes sockets', async () => {
    const f = fixture(); await f.sessions.context('one', contract);
    const handler = f.contexts[0].route.mock.calls[0][1];
    for (const [url, method, allowed] of [[`${contract.origin}/save`, 'POST', true],
      [`${contract.origin}/remove`, 'POST', false], ['https://outside.example/', 'GET', false]]) {
      const route = { request: () => request(String(url), String(method)),
        fulfill: vi.fn(), abort: vi.fn() };
      await handler(route);
      expect(route.fulfill).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(route.abort).toHaveBeenCalledTimes(allowed ? 0 : 1);
    }
    const socket = { close: vi.fn() };
    f.contexts[0].routeWebSocket.mock.calls[0][1](socket);
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it('closes only owned sessions and releases the owned browser after the last one', async () => {
    const f = fixture(); await f.sessions.context('one', contract); await f.sessions.context('two', contract);
    await f.sessions.close('one'); expect(f.contexts[0].close).toHaveBeenCalledOnce();
    expect(f.contexts[1].close).not.toHaveBeenCalled(); expect(f.browser.close).not.toHaveBeenCalled();
    await f.sessions.closeAll(); expect(f.contexts[1].close).toHaveBeenCalledOnce();
    expect(f.browser.close).toHaveBeenCalledOnce(); expect(f.sessions.size).toBe(0);
  });
  it('does not follow an unapproved redirect before checking its destination', async () => {
    const f = fixture(); await f.sessions.context('one', contract);
    const handler = f.contexts[0].route.mock.calls[0][1];
    f.fetchResponse.mockResolvedValueOnce({ status: 302, headers: { location: 'https://outside.example/remove' }, body: Buffer.alloc(0) });
    const route = { request: () => request(contract.origin, 'GET'),
      continue: vi.fn(), fulfill: vi.fn(), abort: vi.fn() };
    await handler(route);
    expect(f.fetchResponse).toHaveBeenCalledExactlyOnceWith(contract, { url: contract.origin, method: 'GET', headers: {}, body: null });
    expect(route.abort).toHaveBeenCalledOnce(); expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
  });
  it('blocks all redirect chains, including same-origin POST redirects, before a second request', async () => {
    const f = fixture(); await f.sessions.context('one', contract);
    const handler = f.contexts[0].route.mock.calls[0][1];
    for (const status of [301, 302, 303, 307, 308]) {
      f.fetchResponse.mockResolvedValueOnce({ status: Number(status), headers: { location: '/remove' }, body: Buffer.alloc(0) });
      const route = { request: () => request(`${contract.origin}/save`, 'POST'),
        continue: vi.fn(), fulfill: vi.fn(), abort: vi.fn() };
      await handler(route);
      expect(route.fulfill).not.toHaveBeenCalled();
      expect(route.abort).toHaveBeenCalledOnce();
    }
  });
  it('does not retain a partially configured context after an admission error', async () => {
    const close = vi.fn(async () => {});
    const browser = { close, newContext: async () => ({ close, route: async () => { throw new Error('route failed'); } }) };
    const sessions = new BrowserCheckSessions(async () => browser);
    await expect(sessions.context('one', contract)).rejects.toThrow('route failed');
    expect(sessions.size).toBe(0); expect(close).toHaveBeenCalled();
  });
});
