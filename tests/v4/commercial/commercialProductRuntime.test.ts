import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveCommercialProductAccessMode,
  CommercialProductRuntime,
  resolveInstalledProductLaunch,
} from '../../../core/v4/commercial/commercialProductRuntime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('commercial product runtime authority', () => {
  it('derives only generic FULL, READ_ONLY, and DENIED product access', () => {
    expect(deriveCommercialProductAccessMode({ entitlementState: 'active', proAccess: true, installed: true })).toBe('FULL');
    expect(deriveCommercialProductAccessMode({ entitlementState: 'grace', proAccess: true, installed: true })).toBe('FULL');
    expect(deriveCommercialProductAccessMode({ entitlementState: 'cancelled', proAccess: true, installed: true })).toBe('FULL');
    expect(deriveCommercialProductAccessMode({ entitlementState: 'expired', proAccess: false, installed: true })).toBe('READ_ONLY');
    expect(deriveCommercialProductAccessMode({ entitlementState: 'revoked', proAccess: false, installed: true })).toBe('READ_ONLY');
    expect(deriveCommercialProductAccessMode({ entitlementState: 'community', proAccess: false, installed: true })).toBe('READ_ONLY');
    expect(deriveCommercialProductAccessMode({ entitlementState: 'community', proAccess: false, installed: false })).toBe('DENIED');
  });

  it('resolves only the active installed product and its bounded UI entrypoint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-product-launch-')); roots.push(root);
    const installedRoot = path.join(root, 'products', 'content-studio', 'versions', '0.2.0-beta.2');
    fs.mkdirSync(path.join(installedRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({
      name: '@taracod/private-content-studio', version: '0.2.0-beta.2',
      aiden: { productId: 'content-studio', entrypoint: 'dist/cli.js', uiEntrypoint: 'dist/webServer.js' },
    }));
    fs.writeFileSync(path.join(installedRoot, 'dist', 'cli.js'), '');
    fs.writeFileSync(path.join(installedRoot, 'dist', 'webServer.js'), '');
    fs.writeFileSync(path.join(root, 'products', 'content-studio', 'active.json'), JSON.stringify({
      productId: 'content-studio', version: '0.2.0-beta.2', installedRoot,
    }));
    await expect(resolveInstalledProductLaunch(root, 'content-studio')).resolves.toMatchObject({
      productId: 'content-studio', version: '0.2.0-beta.2', installedRoot,
      entrypoint: path.join(installedRoot, 'dist', 'webServer.js'),
    });
    fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({
      version: '0.2.0-beta.2', aiden: { productId: 'content-studio', uiEntrypoint: '../outside.js' },
    }));
    await expect(resolveInstalledProductLaunch(root, 'content-studio')).rejects.toThrow(/entrypoint/i);
  });

  it('coalesces launches, reuses one child, refreshes access, fences crashes, and restarts an updated package', async () => {
    let access: 'active' | 'expired' = 'active'; let version = '0.2.0-beta.2'; let launches = 0; let stops = 0;
    let accessCallback: (() => Promise<'FULL' | 'READ_ONLY' | 'DENIED'>) | null = null;
    const children: Array<ChildProcess & { stdout: PassThrough; exitCode: number | null }> = [];
    const runtime = new CommercialProductRuntime({ aidenRoot: 'fixture-root', ownerId: 'fixture-owner', aidenVersion: '4.21.0',
      entitlementPublicKey: 'unused', serviceOrigin: 'https://billing.test', startupTimeoutMs: 2_000,
      statusProvider: async () => ({ entitlement: { state: access, edition: access === 'active' ? 'pro' : 'community' },
        billing: { access, proAccess: access === 'active', entitlementRevision: 1, stateVersion: 'a'.repeat(64) },
        deviceId: 'device-fixture', product: { id: 'content-studio', activeVersion: version, previousVersion: null } }) as never,
      resolveLaunch: async () => ({ productId: 'content-studio', version, installedRoot: 'installed-root', entrypoint: 'webServer.js' }),
      fetch: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      createProcessHost: ({ accessMode }) => ({ launch: () => {
        launches += 1; accessCallback = accessMode;
        const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; exitCode: number | null };
        child.stdout = new PassThrough(); child.exitCode = null; Object.defineProperty(child, 'pid', { value: 42 + launches }); children.push(child);
        const stop = async () => { if (child.exitCode !== null) return; stops += 1; child.exitCode = 0; child.emit('exit', 0, null); };
        setTimeout(() => child.stdout.write(`AIDEN_PRODUCT_READY ${JSON.stringify({ productId: 'content-studio', origin: 'http://127.0.0.1:45123' })}\n`), 0);
        return { child, stop };
      } }) as never,
    });
    const [first, duplicate] = await Promise.all([runtime.open('content-studio'), runtime.open('content-studio')]);
    expect(first).toMatchObject({ reused: false, version: '0.2.0-beta.2', accessMode: 'FULL' }); expect(duplicate).toEqual(first); expect(launches).toBe(1);
    await expect(runtime.open('content-studio')).resolves.toMatchObject({ reused: true }); expect(launches).toBe(1);
    access = 'expired'; await expect(accessCallback!()).resolves.toBe('READ_ONLY');
    children[0]!.exitCode = 1; children[0]!.emit('exit', 1, null); await expect(runtime.status()).resolves.toMatchObject({ product: { running: false } });
    version = '0.2.0-beta.3'; await expect(runtime.open('content-studio')).resolves.toMatchObject({ version, reused: false, accessMode: 'READ_ONLY' });
    expect(launches).toBe(2); await runtime.close(); expect(stops).toBe(1);
  });
});
