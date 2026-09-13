/* Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ clients: [] as any[] }));
vi.mock('imapflow', () => ({
  ImapFlow: class extends EventEmitter {
    usable = false;
    connect = vi.fn(async () => { this.usable = true; });
    close = vi.fn(() => { this.usable = false; });
    logout = vi.fn(async () => undefined);
    mailboxOpen = vi.fn(async () => ({ uidValidity: 4294967295n }));
    search = vi.fn(async () => [4, 8]);
    fetchOne = vi.fn(async () => ({ uid: 8, source: Buffer.from('test source'), flags: new Set(['\\Seen']), internalDate: new Date(0) }));
    messageFlagsAdd = vi.fn(async () => true);
    constructor(public options: any) { super(); state.clients.push(this); }
  },
}));
import { createImapConnection, nextBackoffMs } from '../../../../../core/v4/daemon/triggers/email/imapConnection';

const config = { host: 'mail.example.test', port: 993, user: 'fixture@example.test', password: 'test-only-password', tls: true, authTimeoutMs: 1000 };
beforeEach(() => { state.clients.length = 0; });

describe('IMAP transport contract', () => {
  it('uses verified TLS, identification and disabled wire logging', async () => {
    const connection = createImapConnection({ config });
    await connection.connect();
    expect(state.clients[0].options).toMatchObject({ secure: true, tls: { rejectUnauthorized: true }, logger: false, logRaw: false, clientInfo: { name: 'Aiden' } });
    expect(connection.isConnected()).toBe(true);
    await connection.disconnect();
    expect(connection.isConnected()).toBe(false);
  });
  it('requires STARTTLS for non-implicit TLS and never opts out of verification', async () => {
    const connection = createImapConnection({ config: { ...config, tls: false, port: 143 } });
    await connection.connect();
    expect(state.clients[0].options).toMatchObject({ secure: false, doSTARTTLS: true, tls: { rejectUnauthorized: true } });
    await connection.disconnect();
  });
  it('preserves UIDVALIDITY, UID search and read-without-marking semantics', async () => {
    const connection = createImapConnection({ config });
    await connection.connect();
    expect(await connection.openMailbox('Inbox ✓')).toEqual({ uidValidity: 4294967295 });
    expect(await connection.searchAll()).toEqual([4, 8]);
    expect(await connection.searchUnseen()).toEqual([4, 8]);
    const client = state.clients[0];
    expect(client.search.mock.calls).toEqual([[{ all: true }, { uid: true }], [{ seen: false }, { uid: true }]]);
    expect(await connection.fetchMessage(8)).toEqual({ uid: 8, raw: Buffer.from('test source'), flags: ['\\Seen'], internalDate: new Date(0) });
    expect(client.fetchOne).toHaveBeenCalledWith('8', { source: true, flags: true, internalDate: true }, { uid: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    await connection.markSeen(8);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('8', ['\\Seen'], { uid: true });
    await connection.disconnect();
  });
  it('keeps missing messages distinct from successful fetches', async () => {
    const connection = createImapConnection({ config });
    await connection.connect();
    state.clients[0].fetchOne.mockResolvedValue(false);
    expect(await connection.fetchMessage(44)).toBeNull();
    await connection.disconnect();
  });
  it('closes failed connections and redacts provider errors', async () => {
    const log = vi.fn();
    const connection = createImapConnection({ config, log });
    const pending = connection.connect();
    await pending;
    const client = state.clients[0];
    client.emit('error', new Error(config.password));
    client.fetchOne.mockRejectedValue(new Error(config.password));
    expect(await connection.fetchMessage(8)).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain(config.password);
    await connection.disconnect();
    expect(client.close).toHaveBeenCalled();
  });
  it('does not report a closed socket as connected and reconnects with a fresh client', async () => {
    const connection = createImapConnection({ config });
    await connection.connect();
    await connection.connect();
    expect(state.clients).toHaveLength(1);
    state.clients[0].usable = false;
    expect(connection.isConnected()).toBe(false);
    await expect(connection.searchAll()).rejects.toThrow('not connected');
    await connection.connect();
    expect(state.clients).toHaveLength(2);
    await connection.disconnect();
  });
  it('forces socket cleanup even if graceful logout fails', async () => {
    const connection = createImapConnection({ config });
    await connection.connect();
    const client = state.clients[0];
    client.logout.mockRejectedValue(new Error('logout failed'));
    await expect(connection.disconnect()).rejects.toThrow('logout failed');
    expect(client.close).toHaveBeenCalled();
    expect(connection.isConnected()).toBe(false);
    await connection.disconnect();
  });
  it('preserves bounded reconnect backoff', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1000)).toBe(2000);
    expect(nextBackoffMs(60000)).toBe(60000);
  });
});
