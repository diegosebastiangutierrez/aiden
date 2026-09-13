/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  activateCommercialDevice,
  commercialDeviceStatus,
  refreshCommercialDevice,
  resolveCommercialDeviceId,
} from './commercialActivation';
import { ProductProcessHost, type ProductProcessHandle } from './productProcessHost';
import { safeAccountPortal } from '../product/accountPortal';

const identifier = /^[a-z0-9][a-z0-9-]{1,62}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const relativeEntrypoint = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/;

export type CommercialProductAccessMode = 'FULL' | 'READ_ONLY' | 'DENIED';

export function deriveCommercialProductAccessMode(input: {
  entitlementState: string;
  proAccess: boolean;
  installed: boolean;
}): CommercialProductAccessMode {
  if (input.proAccess && ['active', 'grace', 'cancelled'].includes(input.entitlementState)) return 'FULL';
  if (input.installed) return 'READ_ONLY';
  return 'DENIED';
}

export interface InstalledProductLaunch {
  productId: string;
  version: string;
  installedRoot: string;
  entrypoint: string;
}

export async function resolveInstalledProductLaunch(aidenRoot: string, productId: string): Promise<InstalledProductLaunch> {
  if (!identifier.test(productId)) throw new Error('Invalid product identity');
  const productRoot = path.resolve(aidenRoot, 'products', productId);
  const pointer = JSON.parse(await fs.readFile(path.join(productRoot, 'active.json'), 'utf8')) as {
    productId?: unknown; version?: unknown; installedRoot?: unknown;
  };
  if (pointer.productId !== productId || typeof pointer.version !== 'string' || !versionPattern.test(pointer.version)) {
    throw new Error('Installed product pointer is invalid');
  }
  const installedRoot = path.resolve(productRoot, 'versions', pointer.version);
  if (typeof pointer.installedRoot === 'string' && path.resolve(pointer.installedRoot) !== installedRoot) {
    throw new Error('Installed product root does not match the active pointer');
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
    aiden?: { productId?: unknown; entrypoint?: unknown; uiEntrypoint?: unknown };
  };
  if (packageJson.version !== pointer.version || packageJson.aiden?.productId !== productId) {
    throw new Error('Installed product identity does not match the active pointer');
  }
  // uiEntrypoint is the generic package contract. The bounded fallback keeps
  // already verified Content Studio beta packages launchable without changing
  // their immutable archive identity.
  const candidate = typeof packageJson.aiden.uiEntrypoint === 'string'
    ? packageJson.aiden.uiEntrypoint
    : packageJson.aiden.entrypoint === 'dist/cli.js'
      ? 'dist/webServer.js'
      : packageJson.aiden.entrypoint;
  if (typeof candidate !== 'string' || !relativeEntrypoint.test(candidate) || candidate.includes('..')) {
    throw new Error('Installed product UI entrypoint is invalid');
  }
  const entrypoint = path.resolve(installedRoot, ...candidate.split('/'));
  if (!entrypoint.startsWith(installedRoot + path.sep) || !(await fs.stat(entrypoint)).isFile()) {
    throw new Error('Installed product UI entrypoint is unavailable');
  }
  return { productId, version: pointer.version, installedRoot, entrypoint };
}

type CommercialStatus = Awaited<ReturnType<typeof commercialDeviceStatus>>;

export interface CommercialProductProjection extends CommercialStatus {
  accessMode: CommercialProductAccessMode;
  product: CommercialStatus['product'] & { running: boolean };
}

export interface CommercialProductOpenResult {
  productId: string;
  version: string;
  accessMode: Exclude<CommercialProductAccessMode, 'DENIED'>;
  url: string;
  pid: number | null;
  reused: boolean;
}

export interface CommercialProductRuntimeOptions {
  aidenRoot: string;
  ownerId: string;
  aidenVersion: string;
  entitlementPublicKey: string;
  serviceOrigin: string;
  fetch?: typeof fetch;
  startupTimeoutMs?: number;
  statusProvider?: () => Promise<CommercialStatus>;
  resolveLaunch?: (aidenRoot: string, productId: string) => Promise<InstalledProductLaunch>;
  createProcessHost?: (input: {
    productId: string;
    accessMode: () => Promise<CommercialProductAccessMode>;
  }) => Pick<ProductProcessHost, 'launch'>;
}

interface RunningProduct {
  launch: InstalledProductLaunch;
  mode: Exclude<CommercialProductAccessMode, 'DENIED'>;
  sessionToken: string;
  origin: string;
  handle: ProductProcessHandle;
}

function publicProjection(status: CommercialStatus, running: boolean): CommercialProductProjection {
  const access = status.billing?.access ?? status.entitlement.state;
  return {
    ...status,
    accessMode: deriveCommercialProductAccessMode({ entitlementState: access,
      proAccess: status.billing?.proAccess ?? (status.entitlement.state === 'active' || status.entitlement.state === 'grace'),
      installed: status.product.activeVersion !== null }),
    product: { ...status.product, running },
  };
}

async function waitForProductReady(input: {
  productId: string;
  handle: ProductProcessHandle;
  sessionToken: string;
  fetch: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false; let buffer = ''; let timer: ReturnType<typeof setTimeout>;
    const done = (error?: Error, origin?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      input.handle.child.stdout?.off('data', onData); input.handle.child.off('exit', onExit);
      if (error) reject(error); else resolve(origin!);
    };
    const verify = async (line: string) => {
      if (!line.startsWith('AIDEN_PRODUCT_READY ')) return;
      let body: { productId?: unknown; origin?: unknown };
      try { body = JSON.parse(line.slice('AIDEN_PRODUCT_READY '.length)) as typeof body; }
      catch { done(new Error('Product readiness message is invalid')); return; }
      if (body.productId !== input.productId || typeof body.origin !== 'string') {
        done(new Error('Product readiness identity is invalid')); return;
      }
      let origin: URL;
      try { origin = new URL(body.origin); } catch { done(new Error('Product readiness origin is invalid')); return; }
      if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
        || origin.origin !== body.origin) { done(new Error('Product readiness origin is not loopback')); return; }
      try {
        const response = await input.fetch(new URL('/api/readiness', origin), {
          headers: { 'x-aiden-product-token': input.sessionToken }, signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        done(undefined, origin.origin);
      } catch { done(new Error('Product readiness verification failed')); }
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > 64 * 1024) { done(new Error('Product startup output exceeded the safe limit')); return; }
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        void verify(line);
      }
    };
    const onExit = () => done(new Error('Product process exited before readiness'));
    input.handle.child.stdout?.on('data', onData); input.handle.child.once('exit', onExit);
    timer = setTimeout(() => done(new Error('Product startup timed out')), input.timeoutMs);
    timer.unref?.();
  });
}

export class CommercialProductRuntime {
  private readonly running = new Map<string, RunningProduct>();
  private readonly pending = new Map<string, Promise<CommercialProductOpenResult>>();

  constructor(private readonly options: CommercialProductRuntimeOptions) {}

  private request(): typeof fetch { return this.options.fetch ?? globalThis.fetch; }

  async status(): Promise<CommercialProductProjection> {
    const current = this.options.statusProvider
      ? await this.options.statusProvider()
      : await commercialDeviceStatus({ aidenRoot: this.options.aidenRoot,
        entitlementPublicKey: this.options.entitlementPublicKey });
    const record = this.running.get(current.product.id);
    const projection = publicProjection(current, Boolean(record));
    const accountUrl = safeAccountPortal(this.options.serviceOrigin) ?? safeAccountPortal(projection.accountUrl);
    if (accountUrl) projection.accountUrl = accountUrl;
    else delete projection.accountUrl;
    if (record && projection.accessMode !== 'DENIED') record.mode = projection.accessMode;
    return projection;
  }

  async activate(code: string): Promise<CommercialProductProjection> {
    const deviceId = await resolveCommercialDeviceId(this.options.aidenRoot);
    await activateCommercialDevice({ serviceOrigin: this.options.serviceOrigin, activationCode: code,
      deviceId, aidenRoot: this.options.aidenRoot, entitlementPublicKey: this.options.entitlementPublicKey,
      fetch: this.request() });
    return this.status();
  }

  async refresh(): Promise<CommercialProductProjection> {
    await refreshCommercialDevice({ aidenRoot: this.options.aidenRoot,
      entitlementPublicKey: this.options.entitlementPublicKey, fetch: this.request() });
    return this.status();
  }

  async open(productId: string): Promise<CommercialProductOpenResult> {
    const pending = this.pending.get(productId); if (pending) return pending;
    const operation = this.openOnce(productId).finally(() => { if (this.pending.get(productId) === operation) this.pending.delete(productId); });
    this.pending.set(productId, operation); return operation;
  }

  private async openOnce(productId: string): Promise<CommercialProductOpenResult> {
    const projection = await this.status();
    if (projection.product.id !== productId) throw new Error('Unknown commercial product');
    if (projection.accessMode === 'DENIED') throw new Error('This product requires an active installation and commercial access');
    const launch = await (this.options.resolveLaunch ?? resolveInstalledProductLaunch)(this.options.aidenRoot, productId);
    const current = this.running.get(productId);
    if (current && current.handle.child.exitCode === null && current.launch.version === launch.version) {
      current.mode = projection.accessMode;
      return { productId, version: current.launch.version, accessMode: current.mode,
        url: `${current.origin}/#aiden-session=${current.sessionToken}`, pid: current.handle.child.pid ?? null, reused: true };
    }
    if (current) await this.closeProduct(productId);
    const record = {} as RunningProduct;
    record.mode = projection.accessMode;
    record.launch = launch;
    record.sessionToken = randomBytes(32).toString('base64url');
    const dynamicAccessMode = async (): Promise<CommercialProductAccessMode> => {
        const currentMode = (await this.status()).accessMode;
        if (currentMode !== 'DENIED') record.mode = currentMode;
        return currentMode;
      };
    const host = this.options.createProcessHost?.({ productId, accessMode: dynamicAccessMode })
      ?? new ProductProcessHost({ aidenRoot: this.options.aidenRoot,
        ownerId: `${this.options.ownerId}-${productId}`.slice(0, 63), accessMode: dynamicAccessMode });
    record.handle = host.launch({ productId, executable: process.execPath, args: [launch.entrypoint], cwd: launch.installedRoot,
      environment: { ...process.env, AIDEN_PRODUCT_ID: productId, AIDEN_PRODUCT_VERSION: launch.version,
        AIDEN_RUNTIME_VERSION: this.options.aidenVersion,
        AIDEN_PRODUCT_SESSION_TOKEN: record.sessionToken, AIDEN_PRODUCT_ACCESS_MODE: record.mode,
        CONTENT_STUDIO_PORT: '0' } });
    try {
      record.origin = await waitForProductReady({ productId, handle: record.handle, sessionToken: record.sessionToken,
        fetch: this.request(), timeoutMs: this.options.startupTimeoutMs ?? 30_000 });
    } catch (error) { await record.handle.stop(); throw error; }
    this.running.set(productId, record);
    record.handle.child.once('exit', () => { if (this.running.get(productId) === record) this.running.delete(productId); });
    return { productId, version: launch.version, accessMode: record.mode,
      url: `${record.origin}/#aiden-session=${record.sessionToken}`, pid: record.handle.child.pid ?? null, reused: false };
  }

  async closeProduct(productId: string): Promise<{ closed: boolean }> {
    const record = this.running.get(productId); if (!record) return { closed: false };
    this.running.delete(productId); await record.handle.stop(); return { closed: true };
  }

  async close(): Promise<void> {
    await Promise.all([...this.running.keys()].map((productId) => this.closeProduct(productId).then(() => undefined)));
  }
}
