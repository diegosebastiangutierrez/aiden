import { describe, expect, it, vi } from 'vitest';
import { runLoopbackAuthFlow, startLoopbackServer } from '../../../core/v4/mcp/oauthLoginFlow';

describe('MCP authorization cancellation', () => {
  it('cancels a pending callback promptly and releases its listener', async () => {
    const server = await startLoopbackServer();
    const controller = new AbortController();
    try {
      const pending = server.waitForCallback(100, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow(/cancel/i);
    } finally { await server.close(); }
    const replacement = await startLoopbackServer({ ports: [server.port] });
    await replacement.close();
  });

  it('never opens a browser or listener for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const startServer = vi.fn();
    const ua = { log: vi.fn(), openBrowser: vi.fn(), prompt: vi.fn(), sleep: vi.fn() };
    await expect(runLoopbackAuthFlow({ config: {} as never, server: 'remote', ua, startServer, signal: controller.signal })).rejects.toThrow(/cancel/i);
    expect(startServer).not.toHaveBeenCalled(); expect(ua.openBrowser).not.toHaveBeenCalled();
  });
});
