import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { resolveBrowserCheckAddress, fetchBrowserCheckResponse } from '../../../core/v4/browser/browserCheckTransport';
import { parseBrowserCheckContract } from '../../../core/v4/browser/browserCheckContract';
const make = (origin: string, allowLoopback = false) => parseBrowserCheckContract({ version: 1,
  customerId: 'customer-a', specDigest: 'a'.repeat(64), origin, allowLoopback, mutationPaths: ['/save'],
  observations: [{ id: 'heading', flowId: 'landing', kind: 'text', selector: '#heading', expected: 'Ready' }] });

describe('approved browser request transport', () => {
  it('rejects private, mixed, reserved and unsupported DNS answers before connecting', async () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '172.16.1.1', '192.168.2.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1']) {
      await expect(resolveBrowserCheckAddress(make('https://owned.example'), async () => [
        { address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 },
      ])).rejects.toThrow();
    }
  });
  it('resolves a public hostname once and returns a fixed address without accepting response-supplied addresses', async () => {
    let calls = 0;
    const result = await resolveBrowserCheckAddress(make('https://owned.example'), async () => {
      calls++; return [{ address: '8.8.8.8', family: 4 }];
    });
    expect(result).toEqual({ address: '8.8.8.8', family: 4 }); expect(calls).toBe(1);
    await expect(resolveBrowserCheckAddress(make('https://owned.example'), async () => [])).rejects.toThrow();
  });
  it('returns redirects without following them and sends exactly one approved request', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => { requests++; res.writeHead(302, { location: 'http://127.0.0.1:1/outside' }); res.end('Redirect'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const response = await fetchBrowserCheckResponse(make(origin, true), { url: origin, method: 'GET', headers: {}, body: null });
      expect(response.status).toBe(302); expect(response.headers.location).toBe('http://127.0.0.1:1/outside');
      expect(requests).toBe(1);
      await expect(fetchBrowserCheckResponse(make(origin, true), { url: `${origin}/delete`, method: 'POST', headers: {}, body: null })).rejects.toThrow();
      expect(requests).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('bounds response and submitted body sizes without retrying a mutation', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => { requests++; res.writeHead(200, { 'content-length': String(5 * 1024 * 1024) }); res.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      await expect(fetchBrowserCheckResponse(make(origin, true), { url: origin, method: 'GET', headers: {}, body: null })).rejects.toThrow(/limit/);
      await expect(fetchBrowserCheckResponse(make(origin, true), { url: `${origin}/save`, method: 'POST', headers: {}, body: Buffer.alloc(65537) })).rejects.toThrow(/limit/);
      expect(requests).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
