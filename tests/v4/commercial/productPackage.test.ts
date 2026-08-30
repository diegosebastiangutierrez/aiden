import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../core/v4/commercial/signedPayload';
import { authorizeDownloadAndInstallProductPackage, installSignedProductPackage, verifyProductPackage, type ProductPackageManifest } from '../../../core/v4/commercial/productPackage';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function archive(entries: Array<{ name: string; body?: string; type?: 'file' | 'directory' | 'symlink'; linkname?: string }>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-product-package-')); roots.push(root);
  const file = path.join(root, 'package.tgz'); const pack = tar.pack();
  for (const entry of entries) pack.entry({ name: entry.name, type: entry.type ?? 'file', linkname: entry.linkname }, entry.body ?? '');
  pack.finalize(); await pipeline(pack, createGzip(), (await import('node:fs')).createWriteStream(file));
  return { root, file, bytes: await fs.readFile(file) };
}

function signed(bytes: Buffer, overrides: Partial<ProductPackageManifest> = {}) {
  const manifest: ProductPackageManifest = { schemaVersion: 1, productId: 'content-studio', version: '0.2.0-beta.1',
    platform: process.platform, architecture: process.arch, minimumAidenVersion: '4.21.0', packageFilename: 'package.tgz',
    entrypoint: 'dist/cli.js', packageSize: bytes.byteLength, packageSha256: createHash('sha256').update(bytes).digest('hex'),
    capabilities: ['workflow.premium'], entitlementProduct: 'aiden', updateChannel: 'pro-preview', noticesSha256: 'b'.repeat(64),
    buildTimestamp: '2026-08-29T00:00:00.000Z', signingKeyId: 'test-package-2026-01', ...overrides };
  return { manifest, signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString('base64') };
}

const safeEntries = (version = '0.2.0-beta.1') => [
  { name: 'package/package.json', body: JSON.stringify({ name: '@taracod/private-content-studio', version, aiden: { productId: 'content-studio', entrypoint: 'dist/cli.js' } }) },
  { name: 'package/dist/cli.js', body: 'process.stdout.write("ready")' },
  { name: 'package/THIRD_PARTY_NOTICES.md', body: 'notices' },
];

describe('signed private product installer', () => {
  it('verifies the exact signature, digest, product, version, platform, and key', async () => {
    const value = await archive(safeEntries()); const identity = signed(value.bytes);
    await expect(verifyProductPackage({ archivePath: value.file, signed: identity, expectedProductId: 'content-studio',
      expectedVersion: '0.2.0-beta.1', currentAidenVersion: '4.21.0', verificationKeys: { 'test-package-2026-01': publicKeyPem } }))
      .resolves.toMatchObject({ productId: 'content-studio', version: '0.2.0-beta.1' });
    const changed = Buffer.from(value.bytes); changed[changed.length - 1] ^= 1; await fs.writeFile(value.file, changed);
    await expect(verifyProductPackage({ archivePath: value.file, signed: identity, expectedProductId: 'content-studio',
      expectedVersion: '0.2.0-beta.1', currentAidenVersion: '4.21.0', verificationKeys: { 'test-package-2026-01': publicKeyPem } })).rejects.toThrow(/digest/i);
    await expect(verifyProductPackage({ archivePath: value.file, signed: signed(changed, { productId: 'other-product' }), expectedProductId: 'content-studio',
      expectedVersion: '0.2.0-beta.1', currentAidenVersion: '4.21.0', verificationKeys: { 'test-package-2026-01': publicKeyPem } })).rejects.toThrow(/product/i);
  });

  it('rejects traversal, absolute paths, drive escapes, and archive links', async () => {
    for (const bad of [
      { name: 'package/../../escape.txt' }, { name: '/absolute.txt' }, { name: 'C:/escape.txt' },
      { name: 'package/link', type: 'symlink' as const, linkname: '../../escape.txt' }, { name: 'package/NUL.txt' },
    ]) {
      const value = await archive([...safeEntries(), bad]);
      await expect(installSignedProductPackage({ aidenRoot: value.root, archivePath: value.file, signed: signed(value.bytes),
        expectedProductId: 'content-studio', currentAidenVersion: '4.21.0', verificationKeys: { 'test-package-2026-01': publicKeyPem } }))
        .rejects.toThrow(/archive|path|link|reserved/i);
    }
  });

  it('activates atomically and leaves the previous version active when readiness fails', async () => {
    const beta1 = await archive(safeEntries());
    const first = await installSignedProductPackage({ aidenRoot: beta1.root, archivePath: beta1.file, signed: signed(beta1.bytes),
      expectedProductId: 'content-studio', currentAidenVersion: '4.21.0', verificationKeys: { 'test-package-2026-01': publicKeyPem },
      readiness: async (root) => (await fs.readFile(path.join(root, 'dist/cli.js'), 'utf8')).includes('ready') });
    expect(first.activeVersion).toBe('0.2.0-beta.1');
    const beta2 = await archive(safeEntries('0.2.0-beta.2'));
    await expect(installSignedProductPackage({ aidenRoot: beta1.root, archivePath: beta2.file, signed: signed(beta2.bytes, { version: '0.2.0-beta.2' }),
      expectedProductId: 'content-studio', currentAidenVersion: '4.21.0', verificationKeys: { 'test-package-2026-01': publicKeyPem }, readiness: async () => false }))
      .rejects.toThrow(/readiness/i);
    expect(JSON.parse(await fs.readFile(path.join(beta1.root, 'products/content-studio/active.json'), 'utf8')).version).toBe('0.2.0-beta.1');
  });

  it('authorizes, downloads, verifies, and activates without persisting credentials', async () => {
    const value = await archive(safeEntries());
    const identity = signed(value.bytes);
    const deviceToken = 'd'.repeat(43);
    const packageToken = 'p'.repeat(43);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const result = await authorizeDownloadAndInstallProductPackage({ serviceOrigin: 'https://billing.test', deviceToken,
      productId: 'content-studio', version: '0.2.0-beta.1', aidenRoot: value.root, currentAidenVersion: '4.21.0',
      verificationKeys: { 'test-package-2026-01': publicKeyPem }, readiness: async () => true,
      fetch: async (request, init) => {
        const url = String(request); const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get('authorization') });
        if (url.endsWith('/authorize')) return new Response(JSON.stringify({ authorization: packageToken,
          expiresAt: Date.now() + 60_000, signedManifest: identity }), { headers: { 'Content-Type': 'application/json' } });
        return new Response(value.bytes, { headers: { 'Content-Length': String(value.bytes.byteLength) } });
      } });
    expect(result.activeVersion).toBe('0.2.0-beta.1');
    expect(requests).toEqual([
      { url: 'https://billing.test/api/v1/package/authorize', authorization: `Device ${deviceToken}` },
      { url: 'https://billing.test/api/v1/package/download/content-studio/0.2.0-beta.1', authorization: `Package ${packageToken}` },
    ]);
    expect(await fs.readdir(path.join(value.root, 'commercial', 'downloads'))).toEqual([]);
    expect(JSON.stringify(await fs.readFile(path.join(value.root, 'products/content-studio/active.json'), 'utf8'))).not.toContain(deviceToken);
  });
});
