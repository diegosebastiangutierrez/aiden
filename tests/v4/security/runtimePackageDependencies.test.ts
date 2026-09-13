/* Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const affectedRoots = ['@modelcontextprotocol/sdk', '@slack/bolt', 'express', 'imapflow', 'twilio'];

describe('runtime package dependency resolution', () => {
  it('satisfies upstream ranges for bundled security-sensitive dependencies', () => {
    const require = createRequire(import.meta.url);
    const semver = require('semver');
    const failures: string[] = [];
    for (const [location, entry] of Object.entries(lock.packages) as Array<[string, any]>) {
      if (!entry.inBundle) continue;
      const caller = createRequire(path.join(root, location, 'package.json'));
      const upstream = caller('./package.json');
      for (const name of ['qs', 'semver']) {
        const range = upstream.dependencies?.[name];
        if (!range) continue;
        const actual = caller(`${name}/package.json`).version;
        if (!semver.satisfies(actual, range)) failures.push(`${location}: ${name}@${actual} does not satisfy ${range}`);
      }
    }
    expect(failures).toEqual([]);
  });
  it('ships the patched dependency chains without relying on consumer overrides', () => {
    expect(manifest.bundleDependencies).toEqual(affectedRoots);
    expect(lock.packages[''].bundleDependencies).toEqual(manifest.bundleDependencies);
    for (const name of affectedRoots) expect(manifest.dependencies[name]).toBeDefined();
    expect(manifest.bundleDependencies).not.toContain('better-sqlite3');
    expect(manifest.bundleDependencies).not.toContain('node-pty');
    expect(manifest.dependencies['@types/express']).toBeDefined();
  });

  it('keeps patched mail encoding and HTTP parsing resolutions in their actual callers', () => {
    const require = createRequire(import.meta.url);
    const from = (name: string) => createRequire(require.resolve(`${name}/package.json`));
    const assertLocked = (caller: NodeRequire, name: string) => {
      const resolved = caller.resolve(`${name}/package.json`);
      const location = path.relative(root, path.dirname(resolved)).split(path.sep).join('/');
      expect(caller(`${name}/package.json`).version).toBe(lock.packages[location]?.version);
    };
    assertLocked(require, 'imapflow');
    assertLocked(from('express'), 'qs');
    expect(Object.keys(lock.packages).some(p => /node_modules\/(imap-simple|utf7)$/.test(p))).toBe(false);
    const encoding = require('imapflow/lib/tools');
    const connection = { enabled: new Set(), capabilities: new Map() };
    expect(encoding.decodePath(connection, encoding.encodePath(connection, 'Inbox ✓'))).toBe('Inbox ✓');
    const qs = from('express')('qs');
    expect(qs.parse('filter[state]=ready&items[]=one&items[]=two')).toEqual({ filter: { state: 'ready' }, items: ['one', 'two'] });
    expect(qs.parse('__proto__[polluted]=yes')).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
