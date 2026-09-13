/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/imapConnection.ts — v4.5 Phase 4a.
 *
 * Thin wrapper around the maintained IMAP transport. Adds:
 *   - exponential backoff reconnect (1s → 60s capped at 60s)
 *   - IMAP ID command on connect (defends against servers that
 *     disconnect unidentified clients — see audit §8)
 *   - UIDVALIDITY tracking for cross-restart UID correctness
 *   - typed Promise interface shared with email channel readers
 *
 * Lifecycle:
 *   const ic = createImapConnection(spec.imap, log);
 *   await ic.connect();
 *   await ic.openMailbox(spec.mailbox);
 *   const uids = await ic.searchAll();              // seed seenUids
 *   const unseen = await ic.searchUnseen();         // poll
 *   const msg = await ic.fetchMessage(uid);
 *   await ic.markSeen(uid);
 *   await ic.disconnect();
 */

import { ImapFlow } from 'imapflow';
import { VERSION } from '../../../../version';

export interface ImapConfig {
  host:           string;
  port:           number;
  user:           string;
  password:       string;
  tls:            boolean;
  authTimeoutMs:  number;
}

export interface RawMessage {
  uid:         number;
  /** Full RFC822 source for mailparser to consume. */
  raw:         Buffer;
  /** Convenience: flags + date from IMAP attributes. */
  flags:       string[];
  internalDate: Date;
}

export interface ImapConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  openMailbox(mailbox: string): Promise<{ uidValidity: number }>;
  /** UID SEARCH ALL — returns every UID in the open mailbox. */
  searchAll(): Promise<number[]>;
  /** UID SEARCH UNSEEN — returns every unread UID. */
  searchUnseen(): Promise<number[]>;
  /** Fetch one message by UID; returns raw RFC822 source. */
  fetchMessage(uid: number): Promise<RawMessage | null>;
  /** Mark a UID as `\Seen` on the server. Idempotent. */
  markSeen(uid: number): Promise<void>;
}

const BACKOFF_INITIAL_MS  = 1_000;
const BACKOFF_MAX_MS      = 60_000;
const BACKOFF_MULTIPLIER  = 2;

export interface CreateImapConnectionOptions {
  config: ImapConfig;
  log?:   (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const noopLog = (_l: 'info' | 'warn' | 'error', _m: string): void => undefined;

export function createImapConnection(opts: CreateImapConnectionOptions): ImapConnection {
  const cfg = opts.config;
  const log = opts.log ?? noopLog;
  let conn: ImapFlow | null = null;
  const requireConnection = (): ImapFlow => {
    if (!conn?.usable) throw new Error('[email] not connected');
    return conn;
  };

  return {
    async connect(): Promise<void> {
      if (conn?.usable) return;
      conn?.close();
      const client = new ImapFlow({
        host: cfg.host, port: cfg.port, secure: cfg.tls,
        // Non-implicit TLS must upgrade before credentials can be sent.
        ...(cfg.tls ? {} : { doSTARTTLS: true }),
        auth: { user: cfg.user, pass: cfg.password },
        tls: { rejectUnauthorized: true },
        connectionTimeout: cfg.authTimeoutMs,
        greetingTimeout: cfg.authTimeoutMs,
        clientInfo: { name: 'Aiden', version: VERSION, vendor: 'Taracod' },
        logger: false, logRaw: false,
      });
      // Never let protocol errors print credentials or become unhandled events.
      client.on('error', () => log('warn', '[email] IMAP transport error'));
      conn = client;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => { client.close(); reject(new Error('IMAP connect deadline')); }, cfg.authTimeoutMs);
            deadline.unref();
          }),
        ]);
        log('info', '[email] IMAP connected');
      } catch (e) {
        client.close();
        if (conn === client) conn = null;
        log('error', '[email] IMAP connection failed');
        throw new Error('[email] IMAP connection failed; check server, TLS and credentials');
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    },
    async disconnect(): Promise<void> {
      const client = conn;
      conn = null;
      if (!client) return;
      try { await client.logout(); } finally { client.close(); }
    },
    isConnected(): boolean {
      return conn?.usable === true;
    },
    async openMailbox(mailbox: string): Promise<{ uidValidity: number }> {
      const box = await requireConnection().mailboxOpen(mailbox);
      return { uidValidity: Number(box.uidValidity) };
    },
    async searchAll(): Promise<number[]> {
      return (await requireConnection().search({ all: true }, { uid: true })) || [];
    },
    async searchUnseen(): Promise<number[]> {
      return (await requireConnection().search({ seen: false }, { uid: true })) || [];
    },
    async fetchMessage(uid: number): Promise<RawMessage | null> {
      const client = requireConnection();
      try {
        const m = await client.fetchOne(String(uid), { source: true, flags: true, internalDate: true }, { uid: true });
        if (!m || !m.source) return null;
        return {
          uid: m.uid,
          raw: m.source,
          flags: [...(m.flags ?? [])],
          internalDate: m.internalDate instanceof Date ? m.internalDate : new Date(m.internalDate ?? Date.now()),
        };
      } catch (e) {
        log('warn', `[email] fetch uid ${uid} failed`);
        return null;
      }
    },
    async markSeen(uid: number): Promise<void> {
      await requireConnection().messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    },
  };
}

/**
 * Compute the next exponential-backoff delay given the previous one.
 * Pure — used by the orchestrator's reconnect loop.
 */
export function nextBackoffMs(prev: number): number {
  return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_INITIAL_MS, prev * BACKOFF_MULTIPLIER));
}

export const BACKOFF_CONSTANTS: { initialMs: number; maxMs: number; multiplier: number } = Object.freeze({
  initialMs:  BACKOFF_INITIAL_MS,
  maxMs:      BACKOFF_MAX_MS,
  multiplier: BACKOFF_MULTIPLIER,
});
