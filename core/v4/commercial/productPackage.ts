/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';

import { verifyEd25519Payload } from './signedPayload';

const identifier = /^[a-z0-9][a-z0-9-]{1,62}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface ProductPackageManifest {
  schemaVersion: 1;
  productId: string;
  version: string;
  platform: string;
  architecture: string;
  minimumAidenVersion: string;
  packageFilename: string;
  entrypoint: string;
  packageSize: number;
  packageSha256: string;
  capabilities: string[];
  entitlementProduct: string;
  updateChannel: string;
  noticesSha256: string;
  buildTimestamp: string;
  signingKeyId: string;
}

export interface SignedProductPackageManifest { manifest: ProductPackageManifest; signature: string }

export interface ProductPackageAuthorization {
  authorization: string;
  expiresAt: number;
  signedManifest: SignedProductPackageManifest;
}

function numericVersion(value: string): [number, number, number] {
  if (!versionPattern.test(value)) throw new Error('Invalid package version');
  const [major, minor, patch] = value.split(/[.-]/, 3).map(Number);
  return [major!, minor!, patch!];
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = numericVersion(current); const right = numericVersion(minimum);
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

function validateManifest(manifest: ProductPackageManifest): void {
  if (manifest.schemaVersion !== 1 || !identifier.test(manifest.productId)) throw new Error('Invalid package product');
  numericVersion(manifest.version); numericVersion(manifest.minimumAidenVersion);
  if (!['win32', 'linux', 'darwin'].includes(manifest.platform) || !['x64', 'arm64'].includes(manifest.architecture))
    throw new Error('Invalid package platform');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,150}\.tgz$/.test(manifest.packageFilename)
    || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(manifest.entrypoint) || manifest.entrypoint.includes('..'))
    throw new Error('Invalid package path');
  if (!Number.isSafeInteger(manifest.packageSize) || manifest.packageSize < 1 || manifest.packageSize > 512 * 1024 * 1024
    || !digestPattern.test(manifest.packageSha256) || !digestPattern.test(manifest.noticesSha256)) throw new Error('Invalid package digest');
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length < 1 || !identifier.test(manifest.entitlementProduct)
    || !identifier.test(manifest.updateChannel) || !Number.isFinite(Date.parse(manifest.buildTimestamp))
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(manifest.signingKeyId)) throw new Error('Invalid package manifest');
}

async function fileIdentity(filename: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { const value = chunk as Buffer; bytes += value.byteLength; hash.update(value); }
  return { bytes, sha256: hash.digest('hex') };
}

export async function verifyProductPackage(input: {
  archivePath: string;
  signed: SignedProductPackageManifest;
  expectedProductId: string;
  expectedVersion?: string;
  currentAidenVersion: string;
  verificationKeys: Record<string, string>;
}): Promise<ProductPackageManifest> {
  validateManifest(input.signed.manifest);
  const manifest = input.signed.manifest;
  if (manifest.productId !== input.expectedProductId) throw new Error('Wrong package product');
  if (input.expectedVersion && manifest.version !== input.expectedVersion) throw new Error('Wrong package version');
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error('Wrong package platform');
  if (!versionAtLeast(input.currentAidenVersion, manifest.minimumAidenVersion)) throw new Error('Aiden runtime is too old for this package');
  const key = input.verificationKeys[manifest.signingKeyId];
  if (!key || !verifyEd25519Payload(manifest, input.signed.signature, key)) throw new Error('Invalid package signature');
  const identity = await fileIdentity(input.archivePath);
  if (identity.bytes !== manifest.packageSize || identity.sha256 !== manifest.packageSha256) throw new Error('Package digest does not match the signed manifest');
  return manifest;
}

function safeArchivePath(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) throw new Error('Unsafe absolute archive path');
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] !== 'package' || parts.length < 2 || parts.some((part) => part === '.' || part === '..'))
    throw new Error('Unsafe archive traversal path');
  const relative = parts.slice(1);
  if (relative.some((part) => reservedWindowsName.test(part) || /[<>:"|?*]/.test(part))) throw new Error('Unsafe reserved archive path');
  return relative.join('/');
}

async function extractSafely(archivePath: string, destination: string): Promise<void> {
  const extractor = tar.extract();
  let failure: Error | null = null;
  extractor.on('entry', (header, stream, next) => {
    const complete = (error?: Error) => { if (error && !failure) failure = error; stream.resume(); next(error); };
    let relative: string;
    try {
      relative = safeArchivePath(header.name);
      if (!['file', 'directory'].includes(header.type)) throw new Error('Archive links and special entries are not allowed');
    } catch (error) { complete(error instanceof Error ? error : new Error('Unsafe archive entry')); return; }
    const target = path.resolve(destination, ...relative.split('/'));
    if (target !== destination && !target.startsWith(destination + path.sep)) { complete(new Error('Archive path escaped the install root')); return; }
    if (header.type === 'directory') {
      fs.mkdir(target, { recursive: true }).then(() => complete(), complete); return;
    }
    fs.mkdir(path.dirname(target), { recursive: true })
      .then(() => pipeline(stream, createWriteStream(target, { flags: 'wx', mode: header.mode & 0o755 })))
      .then(() => next(), complete);
  });
  await pipeline(createReadStream(archivePath), createGunzip(), extractor);
  if (failure) throw failure;
}

export async function installSignedProductPackage(input: {
  aidenRoot: string;
  archivePath: string;
  signed: SignedProductPackageManifest;
  expectedProductId: string;
  currentAidenVersion: string;
  verificationKeys: Record<string, string>;
  readiness?: (installedRoot: string) => Promise<boolean>;
}): Promise<{ productId: string; activeVersion: string; previousVersion: string | null; installedRoot: string }> {
  const manifest = await verifyProductPackage(input);
  const productRoot = path.join(input.aidenRoot, 'products', manifest.productId);
  const versionsRoot = path.join(productRoot, 'versions'); const stagingRoot = path.join(productRoot, '.staging');
  const stage = path.join(stagingRoot, `${manifest.version}-${randomUUID()}`);
  const destination = path.join(versionsRoot, manifest.version); const pointer = path.join(productRoot, 'active.json');
  await fs.mkdir(stage, { recursive: true });
  try {
    await extractSafely(input.archivePath, stage);
    const packageJson = JSON.parse(await fs.readFile(path.join(stage, 'package.json'), 'utf8')) as { version?: string; aiden?: { productId?: string; entrypoint?: string } };
    if (packageJson.version !== manifest.version || packageJson.aiden?.productId !== manifest.productId
      || packageJson.aiden.entrypoint !== manifest.entrypoint) throw new Error('Extracted package identity does not match the signed manifest');
    const entrypoint = path.resolve(stage, ...manifest.entrypoint.split('/'));
    if (!entrypoint.startsWith(stage + path.sep) || !(await fs.stat(entrypoint)).isFile()) throw new Error('Package entrypoint is unavailable');
    if (input.readiness && !(await input.readiness(stage))) throw new Error('Package readiness check failed');
    await fs.mkdir(versionsRoot, { recursive: true });
    try { await fs.stat(destination); throw new Error('Package version is already installed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let previousVersion: string | null = null;
    try { previousVersion = (JSON.parse(await fs.readFile(pointer, 'utf8')) as { version?: string }).version ?? null; }
    catch { previousVersion = null; }
    await fs.rename(stage, destination);
    const temporary = `${pointer}.${randomUUID()}.tmp`;
    await fs.mkdir(productRoot, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({ productId: manifest.productId, version: manifest.version,
      previousVersion, installedRoot: destination, activatedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, pointer);
    return { productId: manifest.productId, activeVersion: manifest.version, previousVersion, installedRoot: destination };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

/**
 * Performs the complete customer-side package transaction without persisting
 * device or download credentials. The private archive remains inactive until
 * its signed identity and readiness check both pass.
 */
export async function authorizeDownloadAndInstallProductPackage(input: {
  serviceOrigin: string;
  deviceToken: string;
  productId: string;
  version: string;
  aidenRoot: string;
  currentAidenVersion: string;
  verificationKeys: Record<string, string>;
  readiness?: (installedRoot: string) => Promise<boolean>;
  fetch?: typeof fetch;
}): Promise<{ productId: string; activeVersion: string; previousVersion: string | null; installedRoot: string }> {
  const origin = new URL(input.serviceOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.serviceOrigin || origin.username || origin.password)
    throw new Error('An exact HTTPS package service origin is required');
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.deviceToken)) throw new Error('Invalid device authorization');
  if (!identifier.test(input.productId) || !versionPattern.test(input.version)) throw new Error('Invalid requested package identity');
  const request = input.fetch ?? globalThis.fetch;
  const authorizationResponse = await request(new URL('/api/v1/package/authorize', origin), {
    method: 'POST',
    headers: { 'Authorization': `Device ${input.deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: input.productId, version: input.version }),
  });
  if (!authorizationResponse.ok) throw new Error(`Package authorization denied (${authorizationResponse.status})`);
  let grant: ProductPackageAuthorization;
  try { grant = await authorizationResponse.json() as ProductPackageAuthorization; }
  catch { throw new Error('Package authorization response is invalid'); }
  if (!/^[A-Za-z0-9_-]{43}$/.test(grant.authorization) || !Number.isSafeInteger(grant.expiresAt)
    || grant.expiresAt <= Date.now() || !grant.signedManifest) throw new Error('Package authorization response is invalid');
  if (grant.signedManifest.manifest.productId !== input.productId || grant.signedManifest.manifest.version !== input.version)
    throw new Error('Package authorization identity mismatch');
  const downloadResponse = await request(new URL(`/api/v1/package/download/${input.productId}/${input.version}`, origin), {
    headers: { 'Authorization': `Package ${grant.authorization}` },
  });
  if (!downloadResponse.ok) throw new Error(`Package download denied (${downloadResponse.status})`);
  const statedLength = Number(downloadResponse.headers.get('content-length') ?? grant.signedManifest.manifest.packageSize);
  if (!Number.isSafeInteger(statedLength) || statedLength !== grant.signedManifest.manifest.packageSize
    || statedLength < 1 || statedLength > 512 * 1024 * 1024) throw new Error('Package download size is invalid');
  const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
  if (bytes.byteLength !== statedLength) throw new Error('Package download was truncated');
  const downloads = path.join(input.aidenRoot, 'commercial', 'downloads');
  const temporary = path.join(downloads, `${input.productId}-${input.version}-${randomUUID()}.tgz`);
  await fs.mkdir(downloads, { recursive: true });
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    return await installSignedProductPackage({ aidenRoot: input.aidenRoot, archivePath: temporary,
      signed: grant.signedManifest, expectedProductId: input.productId, currentAidenVersion: input.currentAidenVersion,
      verificationKeys: input.verificationKeys, readiness: input.readiness });
  } finally { await fs.rm(temporary, { force: true }); }
}
