/* Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const affectedRoots = ['@modelcontextprotocol/sdk', '@slack/bolt', 'express', 'imap-simple', 'twilio'];

describe('runtime package dependency resolution', () => {
  it('ships the patched dependency chains without relying on consumer overrides', () => {
    expect(manifest.bundleDependencies).toEqual(affectedRoots);
    expect(lock.packages[''].bundleDependencies).toEqual(manifest.bundleDependencies);
    for (const name of affectedRoots) expect(manifest.dependencies[name]).toBeDefined();
    expect(manifest.bundleDependencies).not.toContain('better-sqlite3');
    expect(manifest.bundleDependencies).not.toContain('node-pty');
  });

  it('keeps patched mail encoding and HTTP parsing resolutions in their actual callers', () => {
    const require = createRequire(import.meta.url);
    const from = (name: string) => createRequire(require.resolve(`${name}/package.json`));
    const mail = createRequire(from('imap-simple').resolve('imap/package.json'));
    const utf7 = createRequire(mail.resolve('utf7/package.json'));
    const assertLocked = (caller: NodeRequire, name: string) => {
      const resolved = caller.resolve(`${name}/package.json`);
      const location = path.relative(root, path.dirname(resolved)).split(path.sep).join('/');
      expect(caller(`${name}/package.json`).version).toBe(lock.packages[location]?.version);
    };
    assertLocked(utf7, 'semver');
    assertLocked(from('express'), 'qs');
    expect(utf7('semver').gte(utf7('semver/package.json').version, '7.5.2')).toBe(true);
    const encoding = mail('utf7');
    expect(encoding.decode(encoding.encode('Inbox ✓'))).toBe('Inbox ✓');
    expect(encoding.imap.decode(encoding.imap.encode('Inbox ✓'))).toBe('Inbox ✓');
    const qs = from('express')('qs');
    expect(qs.parse('filter[state]=ready&items[]=one&items[]=two')).toEqual({ filter: { state: 'ready' }, items: ['one', 'two'] });
    expect(qs.parse('__proto__[polluted]=yes')).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
