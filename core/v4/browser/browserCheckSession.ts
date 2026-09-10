import { browserCheckRequestAllowed, type BrowserCheckContract } from './browserCheckContract';
import { fetchBrowserCheckResponse } from './browserCheckTransport';

export class BrowserCheckSessions {
  private browser: any = null;
  private readonly contexts = new Map<string, { context: any; identity: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly launch: () => Promise<any>, private readonly fetchResponse = fetchBrowserCheckResponse) {}
  get size(): number { return this.contexts.size; }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  context(sessionId: string, contract: BrowserCheckContract): Promise<any> {
    return this.exclusive(async () => {
      const identity = JSON.stringify(contract);
      const existing = this.contexts.get(sessionId);
      if (existing) {
        if (existing.identity !== identity) throw new Error('Browser check session identity changed');
        return existing.context;
      }
      this.browser ??= await this.launch();
      let context: any;
      try {
        context = await this.browser.newContext({ viewport: { width: 1280, height: 720 },
          serviceWorkers: 'block', acceptDownloads: false });
        await context.route('**/*', async (route: any) => {
          const request = route.request();
          if (!browserCheckRequestAllowed(contract, request.url(), request.method())) {
            await route.abort('blockedbyclient'); return;
          }
          try {
            // Automatic redirect following would send a request before the next scope check.
            const response = await this.fetchResponse(contract, { url: request.url(), method: request.method(),
              headers: await request.allHeaders(), body: request.postDataBuffer() });
            const status = response.status;
            const location = response.headers.location;
            if (status >= 300 && status < 400 && location) {
              // Browser interception is not guaranteed for later hops. Direct-page checks
              // fail closed instead of advertising an unguarded redirect flow as supported.
              await route.abort('blockedbyclient'); return;
            }
            await route.fulfill(response);
          } catch {
            await route.abort('failed').catch(() => {});
          }
        });
        await context.routeWebSocket('**/*', (socket: any) => socket.close());
        this.contexts.set(sessionId, { context, identity });
        return context;
      } catch (error) {
        if (context) await context.close();
        if (!this.contexts.size) { await this.browser.close(); this.browser = null; }
        throw error;
      }
    });
  }
  close(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      const entry = this.contexts.get(sessionId);
      if (!entry) return;
      await entry.context.close();
      this.contexts.delete(sessionId);
      if (!this.contexts.size && this.browser) { await this.browser.close(); this.browser = null; }
    });
  }
  closeAll(): Promise<void> {
    return this.exclusive(async () => {
      for (const [sessionId, entry] of this.contexts) {
        await entry.context.close(); this.contexts.delete(sessionId);
      }
      if (this.browser) { await this.browser.close(); this.browser = null; }
    });
  }
}
