// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/tools/gmailTool.ts — Gmail integration foundation.
//
// App Password + IMAP reader, using the shared verified-TLS transport.
import { createImapConnection } from '../v4/daemon/triggers/email/imapConnection'
import { simpleParser } from 'mailparser'

// ── Types ──────────────────────────────────────────────────────

export interface GmailMessage {
  from:    string
  subject: string
  date:    string
  snippet: string
}

export interface GmailConfig {
  email:       string
  appPassword: string
}

// ── Gmail reader (IMAP App Password) ─────────────────────────
// Reading does not mark messages as seen.

export async function readGmail(
  config: GmailConfig,
  count:  number = 10,
  folder: string = 'INBOX',
): Promise<GmailMessage[]> {
  const connection = createImapConnection({ config: {
    user: config.email, password: config.appPassword,
    host: 'imap.gmail.com', port: 993, tls: true, authTimeoutMs: 10000,
  } })
  try {
    await connection.connect()
    await connection.openMailbox(folder)
    const uids = await connection.searchUnseen()
    const results: GmailMessage[] = []
    for (const uid of uids.slice(0, count)) {
      const message = await connection.fetchMessage(uid)
      if (!message) continue
      const parsed = await simpleParser(message.raw)
      results.push({ from: parsed.from?.text ?? '', subject: parsed.subject ?? '(no subject)',
        date: parsed.date?.toISOString() ?? '', snippet: '' })
    }

    console.log(`[Gmail] Fetched ${results.length} messages from ${folder}`)
    return results
  } catch (err: any) {
    console.error('[Gmail] IMAP read failed; check server and credentials')
    return []
  } finally {
    await connection.disconnect().catch(() => undefined)
  }
}

// ── Gmail sender (nodemailer + App Password) ──────────────────

export async function sendGmail(
  config:  GmailConfig,
  to:      string,
  subject: string,
  body:    string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodemailer = require('nodemailer') as typeof import('nodemailer')

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.email,
        pass: config.appPassword,
      },
    })

    await transporter.sendMail({
      from:    config.email,
      to,
      subject,
      text:    body,
    })

    console.log(`[Gmail] Sent email to ${to}: ${subject}`)
    return { success: true }
  } catch (err: any) {
    if (err?.code === 'MODULE_NOT_FOUND') {
      console.log('[Gmail] nodemailer not installed — run: npm install nodemailer')
      return { success: false, error: 'nodemailer not installed' }
    }
    console.error('[Gmail] Send failed:', String(err).slice(0, 120))
    return { success: false, error: String(err).slice(0, 200) }
  }
}
