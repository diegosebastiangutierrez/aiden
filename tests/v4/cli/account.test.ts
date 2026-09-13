import { afterEach, describe, expect, it, vi } from 'vitest';
import { account } from '../../../cli/v4/commands/account';
import { openOAuthBrowserUrl } from '../../../cli/v4/auth/loadProvider';
import type { SlashCommandContext } from '../../../cli/v4/commandRegistry';

vi.mock('../../../cli/v4/auth/loadProvider', () => ({ openOAuthBrowserUrl: vi.fn(async () => {}) }));
const prior = process.env.AIDEN_BILLING_ORIGIN;
afterEach(() => { if (prior === undefined) delete process.env.AIDEN_BILLING_ORIGIN; else process.env.AIDEN_BILLING_ORIGIN = prior; vi.clearAllMocks(); });

describe('CLI account portal', () => {
  it('opens only the initiating account link and waits for canonical completion', async () => {
    process.env.AIDEN_BILLING_ORIGIN = 'https://accounts.example.test';
    const write = vi.fn();
    const client = { begin: vi.fn(async () => ({ state: 'pending', portal: process.env.AIDEN_BILLING_ORIGIN, userCode: 'ABCDEF0123' })),
      status: vi.fn(async () => ({ state: 'linked', account: { email: 'creator@example.test' } })), disconnect: vi.fn() };
    const ctx = { args: ['open'], display: { write }, integrationRuntime: { accountClient: client } } as unknown as SlashCommandContext;
    await account.handler(ctx);
    expect(client.begin).toHaveBeenCalledWith('cli');
    expect(openOAuthBrowserUrl).toHaveBeenCalledWith('https://accounts.example.test/#connect=ABCDEF0123');
    expect(write.mock.calls.flat().join('')).not.toContain('Account linked:');
    await account.handler({ ...ctx, args: ['status'] });
    expect(write.mock.calls.flat().join('')).toContain('Account linked: creator@example.test');
  });
  it('requests canonical disconnection and never prints raw client errors', async () => {
    process.env.AIDEN_BILLING_ORIGIN = 'https://accounts.example.test';
    const write = vi.fn(); const disconnect = vi.fn(async () => { throw new Error('private-credential-detail'); });
    await account.handler({ args: ['disconnect'], display: { write }, integrationRuntime: { accountClient: { disconnect } } } as unknown as SlashCommandContext);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(write.mock.calls.flat().join('')).not.toContain('private-credential-detail');
    expect(openOAuthBrowserUrl).not.toHaveBeenCalled();
  });
  it('keeps unconfigured local use available without opening any page', async () => {
    delete process.env.AIDEN_BILLING_ORIGIN;
    const write = vi.fn();
    await account.handler({ args: ['open'], display: { write } } as unknown as SlashCommandContext);
    expect(write.mock.calls.flat().join('')).toContain('Continue locally');
    expect(openOAuthBrowserUrl).not.toHaveBeenCalled();
  });
  it('requires the explicit open action and never claims successful sign-in from a browser request', async () => {
    process.env.AIDEN_BILLING_ORIGIN = 'https://accounts.example.test';
    const write = vi.fn(), ctx = { args: [], display: { write } } as unknown as SlashCommandContext;
    await account.handler(ctx);
    expect(openOAuthBrowserUrl).not.toHaveBeenCalled();
    await account.handler({ ...ctx, args: ['open'] });
    expect(openOAuthBrowserUrl).toHaveBeenCalledWith('https://accounts.example.test');
    expect(write.mock.calls.flat().join('')).toContain('does not establish a local signed-in session');
  });
  it('rejects credential-bearing portal URLs without printing them', async () => {
    process.env.AIDEN_BILLING_ORIGIN = 'https://accounts.example.test/?token=fixture-private';
    const write = vi.fn();
    await account.handler({ args: ['open'], display: { write } } as unknown as SlashCommandContext);
    expect(openOAuthBrowserUrl).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join('')).not.toContain('fixture-private');
  });
});
