import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createIntegrationRuntime } from '../../../core/v4/integrations/runtime';
import { MachineBoundSecretBackend } from '../../../core/v4/integrations/secretAuthority';

let db: Database.Database, root: string;
const scope = { ownerId: 'owner', workspaceId: 'workspace' };
const make = () => createIntegrationRuntime({ db, rootDir: root, scope, includeFake: true, secretBackend: new MachineBoundSecretBackend(root) });
beforeEach(async () => { db = new Database(':memory:'); runMigrations(db); root = await mkdtemp(path.join(os.tmpdir(), 'app-recovery-')); });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

describe('durable app authorization recovery', () => {
  it('preserves a committed account credential when authorization cleanup fails', async () => {
    const runtime = make();
    const provider = runtime.providers.require('fake');
    const original = provider.completeConnection.bind(provider);
    vi.spyOn(provider, 'completeConnection').mockImplementation(async input => ({ ...(await original(input)), secretValue: 'test-account-credential' }));
    const start = await runtime.actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope });
    vi.spyOn(runtime.secrets, 'revoke').mockRejectedValueOnce(new Error('Test cleanup unavailable'));
    await expect(runtime.actions.completeConnection({ connectionId: start.connectionId, ...scope })).rejects.toThrow();
    const account = runtime.accounts.list(scope)[0];
    expect(account?.secretHandle).toBeTruthy();
    expect(await runtime.secrets.resolve(account.secretHandle!, scope)).toBe('test-account-credential');
    expect(await make().actions.completeConnection({ connectionId: start.connectionId, ...scope })).toMatchObject({ accountId: account.accountId });
  });
  it('reuses the same pending authorization for repeated or concurrent starts', async () => {
    const runtime = make();
    const begin = () => runtime.actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope });
    const [first, second] = await Promise.all([begin(), begin()]);
    expect(first.connectionId).toBe(second.connectionId);
    expect((await make().actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope })).connectionId).toBe(first.connectionId);
    expect(runtime.actions.listConnections(scope)).toHaveLength(1);
  });
  it('restores a scoped pending request without putting the authorization link in the database or list projection', async () => {
    const runtime = make();
    const started = await runtime.actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope });
    const restarted = make();
    const pending = restarted.actions.listConnections(scope);
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain(started.authorizationUrl);
    expect(await restarted.actions.resumeConnection({ connectionId: started.connectionId, ...scope })).toMatchObject({ authorizationUrl: started.authorizationUrl });
    const stored = db.prepare('SELECT * FROM integration_connection_sessions').all();
    expect(JSON.stringify(stored)).not.toContain(started.authorizationUrl);
    expect(restarted.actions.listConnections({ ...scope, workspaceId: 'other' })).toEqual([]);
    await expect(restarted.actions.resumeConnection({ connectionId: started.connectionId, ...scope, ownerId: 'other' })).rejects.toThrow();
  });
  it('cancels durably and refuses later completion without creating an account', async () => {
    const runtime = make();
    const started = await runtime.actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope });
    await runtime.actions.cancelConnection({ connectionId: started.connectionId, ...scope });
    await expect(make().actions.completeConnection({ connectionId: started.connectionId, ...scope })).rejects.toMatchObject({ category: 'cancelled' });
    expect(runtime.accounts.list(scope)).toEqual([]);
    expect(runtime.actions.listConnections(scope)).toEqual([]);
  });
  it('cannot resurrect a cancelled request when provider readback is in flight', async () => {
    const runtime = make();
    const provider = runtime.providers.require('fake');
    const original = provider.completeConnection.bind(provider);
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const entered = vi.fn();
    vi.spyOn(provider, 'completeConnection').mockImplementation(async input => { entered(); await barrier; return original(input); });
    const start = await runtime.actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope });
    const completion = runtime.actions.completeConnection({ connectionId: start.connectionId, ...scope });
    const rejected = expect(completion).rejects.toMatchObject({ category: 'cancelled' });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    await runtime.actions.cancelConnection({ connectionId: start.connectionId, ...scope }); finish(); await rejected;
    expect(runtime.accounts.list(scope)).toEqual([]);
  });
  it('expires requests with no provider deadline and never revives an expired request', async () => {
    const runtime = make();
    const start = await runtime.actions.initiateConnection({ providerId: 'fake', toolkitId: 'projects', ...scope });
    expect(start.expiresAt).toBeGreaterThan(Date.now());
    db.prepare('UPDATE integration_connection_sessions SET expires_at=?').run(Date.now() - 1);
    await expect(runtime.actions.resumeConnection({ connectionId: start.connectionId, ...scope })).rejects.toMatchObject({ category: 'auth_expired' });
    await expect(runtime.actions.completeConnection({ connectionId: start.connectionId, ...scope })).rejects.toMatchObject({ category: 'auth_expired' });
  });
});
