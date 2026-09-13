import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../daemon/db/connection';
import type { SecretAuthority } from '../integrations/secretAuthority';
import { safeAccountPortal } from './accountPortal';
import type { AccountClientPort, AccountClientState } from './accountContract';
export type { AccountClientPort, AccountClientState } from './accountContract';

interface RecordRow { origin: string; request_id: string | null; user_code: string | null; secret_handle: string; expires_at: number | null }

/** Same workspace secret authority, separate account-only credential. Never a paid activation. */
export class AccountClient implements AccountClientPort {
  private readonly scope: { workspaceId: string; ownerId: string };
  constructor(private readonly options: { db: Db; secrets: SecretAuthority; scope: { workspaceId: string; ownerId: string };
    origin: () => string | undefined; fetch?: typeof fetch }) {
    this.scope = options.scope;
    options.db.exec(`CREATE TABLE IF NOT EXISTS account_client_links(
      workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,origin TEXT NOT NULL,
      request_id TEXT,user_code TEXT,secret_handle TEXT NOT NULL,expires_at INTEGER,
      PRIMARY KEY(workspace_id,owner_id))`);
  }
  private row(): RecordRow | undefined {
    return this.options.db.prepare('SELECT * FROM account_client_links WHERE workspace_id=? AND owner_id=?')
      .get(this.scope.workspaceId, this.scope.ownerId) as RecordRow | undefined;
  }
  private origin() { return safeAccountPortal(this.options.origin()); }
  private async request(origin: string, action: string, body: unknown, credential?: string): Promise<Record<string, unknown>> {
    const response = await (this.options.fetch ?? fetch)(`${origin}/api/v1/account-link/${action}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Account ${credential}` } : {}) },
      body: JSON.stringify(body),
    }).catch(() => { throw new Error('Account service could not be reached. Your local work is still available.'); });
    if (!response.ok) throw new Error('Account request was not accepted. Retry or review account connections in the portal.');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Account response unavailable');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 16384) { await reader.cancel(); throw new Error('Account response too large'); }
      chunks.push(next.value); } } finally { reader.releaseLock(); }
    try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string,unknown>;
    } catch { /* Do not surface remote content or credentials in an error. */ }
    throw new Error('Account response is invalid');
  }
  private async forget(row: RecordRow) {
    this.options.db.prepare('DELETE FROM account_client_links WHERE workspace_id=? AND owner_id=? AND secret_handle=?')
      .run(this.scope.workspaceId, this.scope.ownerId, row.secret_handle);
    await this.options.secrets.delete(row.secret_handle, this.scope);
  }
  async begin(surface: 'cli' | 'workbench'): Promise<AccountClientState> {
    const origin = this.origin();
    if (!origin) return { state: 'unavailable' };
    if (!this.options.secrets.backendHealth().protectedByOs) throw new Error('Protected account storage is unavailable on this platform. Use the account portal instead.');
    if (this.row()) return this.status();
    const credential = randomBytes(32).toString('base64url');
    const handle = await this.options.secrets.create({ namespace: { ...this.scope, providerId: 'aiden-account' }, label: 'Account connection', value: credential });
    try {
      this.options.db.prepare('INSERT INTO account_client_links(workspace_id,owner_id,origin,secret_handle) VALUES(?,?,?,?)')
        .run(this.scope.workspaceId, this.scope.ownerId, origin, handle);
    } catch { await this.options.secrets.delete(handle, this.scope); throw new Error('Another account connection is already in progress. Refresh its status.'); }
    try {
      const value = await this.request(origin, 'begin', { challenge: createHash('sha256').update(credential).digest('hex'), surface });
      if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.userCode !== 'string'
        || !/^[A-F0-9]{10}$/.test(value.userCode) || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
        || value.verificationUrl !== origin) throw new Error('Account connection response is invalid');
      this.options.db.prepare('UPDATE account_client_links SET request_id=?,user_code=?,expires_at=? WHERE workspace_id=? AND owner_id=? AND secret_handle=?')
        .run(value.id, value.userCode, value.expiresAt, this.scope.workspaceId, this.scope.ownerId, handle);
      return { state: 'pending', portal: origin, userCode: value.userCode, expiresAt: value.expiresAt };
    } catch (error) { await this.forget({ origin, request_id: null, user_code: null, secret_handle: handle, expires_at: null }); throw error; }
  }
  async status(): Promise<AccountClientState> {
    const origin = this.origin(); if (!origin) return { state: 'unavailable' };
    const row = this.row(); if (!row) return { state: 'disconnected', portal: origin };
    if (row.origin !== origin) throw new Error('Account service configuration changed. Restore the previous service before managing this connection.');
    if (!row.request_id) throw new Error('Account connection was interrupted. Disconnect it and try again.');
    const credential = await this.options.secrets.resolve(row.secret_handle, this.scope);
    const value = await this.request(origin, 'poll', { id: row.request_id, credential });
    if (value.state === 'pending') return { state: 'pending', portal: origin, userCode: row.user_code!, expiresAt: row.expires_at! };
    if (['denied','expired','revoked'].includes(String(value.state))) {
      await this.forget(row); return { state: value.state as 'denied' | 'expired' | 'revoked', portal: origin };
    }
    const account = value.account as Record<string,unknown> | undefined;
    if (value.state !== 'linked' || !account || typeof account.id !== 'string' || !/^account_[a-zA-Z0-9_-]+$/.test(account.id)
      || typeof account.email !== 'string' || account.email.length > 254 || /[\x00-\x1f\x7f]/.test(account.email)
      || !account.email.includes('@') || typeof account.emailVerifiedAt !== 'number' || typeof value.expiresAt !== 'number')
      throw new Error('Verified account identity is unavailable');
    return { state: 'linked', portal: origin, expiresAt: value.expiresAt,
      account: { id: account.id, email: account.email, emailVerifiedAt: account.emailVerifiedAt } };
  }
  async disconnect(): Promise<AccountClientState> {
    const row = this.row(); const origin = this.origin();
    if (!row) return { state: origin ? 'disconnected' : 'unavailable', ...(origin ? { portal: origin } : {}) };
    if (origin !== row.origin) throw new Error('Restore the previous account service before disconnecting.');
    if (row.request_id) {
      const credential = await this.options.secrets.resolve(row.secret_handle, this.scope);
      const value = await this.request(origin, 'cancel', { id: row.request_id, credential });
      if (value.state !== 'revoked') throw new Error('Account disconnection could not be confirmed');
    }
    await this.forget(row); return { state: 'disconnected', portal: origin };
  }
}
