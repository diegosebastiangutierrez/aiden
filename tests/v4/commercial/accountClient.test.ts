import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AccountClient } from '../../../core/v4/product/accountClient';
import type { SecretAuthority } from '../../../core/v4/integrations/secretAuthority';

let db: Database.Database;
const origin = 'https://accounts.example.test', id = '00000000-0000-4000-8000-000000000001';
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());
function fixture() {
  const vault = new Map<string,string>(); let credential = '', remote = 'pending', unavailable = false, protectedByOs = true;
  const scope = { ownerId: 'local-user', workspaceId: 'workspace_one' };
  const secrets = { backendHealth: () => ({ protectedByOs }),
    create: vi.fn(async ({ value }: { value: string }) => { const key = 'secret_' + vault.size; vault.set(key, value); return key; }),
    resolve: vi.fn(async (key: string) => { credential = vault.get(key)!; return credential; }),
    delete: vi.fn(async (key: string) => { vault.delete(key); }),
  } as unknown as SecretAuthority;
  const requests: Array<{ url: string; action: string }> = [];
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), action: String(url).split('/').at(-1)! });
    expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
    if (unavailable) throw new Error('remote-private-error');
    if (String(url).endsWith('/begin')) return Response.json({ id, userCode: 'ABCDEF0123', expiresAt: Date.now() + 600_000, verificationUrl: origin });
    if (String(url).endsWith('/cancel')) { remote = 'revoked'; return Response.json({ state: remote }); }
    return Response.json(remote === 'linked' ? { state: remote, expiresAt: Date.now() + 86400_000,
      account: { id: 'account_test', email: 'customer@example.test', emailVerifiedAt: 123 } } : { state: remote });
  });
  const create = (otherScope = scope, otherOrigin = origin) => new AccountClient({ db, secrets, scope: otherScope, origin: () => otherOrigin, fetch: transport as typeof fetch });
  return { client: create(), create, vault, secrets, requests, transport, get credential() { return credential; },
    state(value: string) { remote = value; }, offline(value: boolean) { unavailable = value; }, unprotected() { protectedByOs = false; } };
}
describe('protected account client', () => {
  it('persists pending state and restores through the same scoped secret after recreation', async () => {
    const f = fixture(); const pending = await f.client.begin('workbench');
    expect(pending.state).toBe('pending');
    expect(await f.create().status()).toEqual(pending);
    expect(f.requests.filter(r => r.action === 'begin')).toHaveLength(1);
    expect(JSON.stringify(db.prepare('SELECT * FROM account_client_links').all())).not.toContain(f.credential);
    expect(f.credential).toHaveLength(43);
    expect(JSON.stringify(pending)).not.toContain(f.credential);
  });
  it('only shows identity after canonical completion, not opening a URL', async () => {
    const f = fixture(); await f.client.begin('cli'); expect((await f.client.status()).account).toBeUndefined();
    f.state('linked'); expect(await f.client.status()).toMatchObject({ state: 'linked', account: { email: 'customer@example.test' } });
  });
  it('never requests another grant for an existing pending link', async () => {
    const f = fixture(); await f.client.begin('cli'); await f.client.begin('workbench');
    expect(f.requests.filter(r => r.action === 'begin')).toHaveLength(1);
  });
  it('refuses account secrets when OS protection is unavailable', async () => {
    const f = fixture(); f.unprotected(); await expect(f.client.begin('cli')).rejects.toThrow(/Protected/);
    expect(f.transport).not.toHaveBeenCalled(); expect(f.vault.size).toBe(0);
  });
  it('does not expose another workspace connection', async () => {
    const f = fixture(); await f.client.begin('cli');
    expect(await f.create({ ownerId: 'local-user', workspaceId: 'workspace_two' }).status()).toMatchObject({ state: 'disconnected' });
  });
  it('does not send a stored credential to a changed service origin', async () => {
    const f = fixture(); await f.client.begin('cli'); f.transport.mockClear();
    await expect(f.create(undefined, 'https://other.example.test').status()).rejects.toThrow(/changed/);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('retains a recoverable connection when remote disconnect fails', async () => {
    const f = fixture(); await f.client.begin('cli'); f.offline(true);
    await expect(f.client.disconnect()).rejects.toThrow(/could not be reached/);
    expect(f.vault.size).toBe(1); expect(db.prepare('SELECT * FROM account_client_links').all()).toHaveLength(1);
    f.offline(false); expect((await f.client.disconnect()).state).toBe('disconnected');
    expect(f.vault.size).toBe(0);
  });
  it.each(['expired','denied','revoked'])('clears the local secret only after canonical %s', async state => {
    const f = fixture(); await f.client.begin('cli'); f.state(state);
    expect((await f.client.status()).state).toBe(state); expect(f.vault.size).toBe(0);
    expect((await f.client.status()).state).toBe('disconnected');
  });
  it('cleans an unissued local credential after begin fails and redacts remote errors', async () => {
    const f = fixture(); f.offline(true);
    await expect(f.client.begin('cli')).rejects.toThrow('Account service could not be reached');
    expect(f.vault.size).toBe(0); expect(db.prepare('SELECT * FROM account_client_links').all()).toEqual([]);
  });
  it('keeps account configuration optional and rejects non-HTTPS service origins', async () => {
    const f = fixture(); expect(await f.create(undefined, 'http://example.test').begin('cli')).toEqual({ state: 'unavailable' });
    expect(f.transport).not.toHaveBeenCalled();
  });
});
