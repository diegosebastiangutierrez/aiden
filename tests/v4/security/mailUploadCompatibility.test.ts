import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const MailMessage = require('nodemailer/lib/mailer/mail-message');
const multer = require('multer');
const { simpleParser } = require('mailparser');

describe('installed mail and upload security compatibility', () => {
  it('honours disabled file access with the legacy mail-content callback', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aiden-mail-content-'));
    try {
      const file = path.join(directory, 'owned.txt');
      await writeFile(file, 'test-owned content');
      const message = new MailMessage({ options: { disableFileAccess: true } }, {});
      const result = await new Promise<{ error: Error | null; content: unknown }>((resolve) => {
        message.resolveContent({ attachment: { path: file } }, 'attachment',
          (error: Error | null, content: unknown) => resolve({ error, content }));
      });
      expect(result.error?.message).toMatch(/file access rejected/i);
      expect(result.content).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves normal MIME text and attachment parsing without sending mail', async () => {
    const parsed = await simpleParser([
      'From: sender@example.test', 'To: reader@example.test', 'Subject: Receipt',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="mail-boundary"', '',
      '--mail-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Verified text',
      '--mail-boundary', 'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="evidence.txt"',
      'Content-Transfer-Encoding: base64', '', Buffer.from('Evidence').toString('base64'),
      '--mail-boundary--', '',
    ].join('\r\n'));
    expect(parsed.subject).toBe('Receipt');
    expect(parsed.text.trim()).toBe('Verified text');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].content.toString()).toBe('Evidence');
  });

  it('enforces the file count before asynchronous upload filtering completes', async () => {
    const boundary = 'upload-boundary';
    const body = Buffer.from(['first.txt', 'second.txt'].map((name) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\ndata\r\n`,
    ).join('') + `--${boundary}--\r\n`);
    const request = Readable.from([body]) as Readable & { headers: Record<string, string> };
    request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    const upload = multer({
      storage: multer.memoryStorage(), limits: { files: 1 },
      fileFilter: (_request: unknown, _file: unknown, done: (error: Error | null, accept: boolean) => void) => {
        setImmediate(() => done(null, true));
      },
    }).any();
    const error = await new Promise<{ code?: string } | undefined>((resolve) => upload(request, {}, resolve));
    expect(error?.code).toBe('LIMIT_FILE_COUNT');
  });
});
