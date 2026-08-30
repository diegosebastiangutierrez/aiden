/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { EntitlementAuthority, type SignedEntitlement } from './entitlementAuthority';

export interface CommercialActivationRecord extends SignedEntitlement {
  schemaVersion: 1;
  serviceOrigin: string;
  deviceId: string;
  deviceToken: string;
  activatedAt: string;
}

const bearer = /^[A-Za-z0-9_-]{43}$/;
const device = /^[A-Za-z0-9_-]{8,128}$/;

function activationFile(aidenRoot: string): string {
  return path.join(aidenRoot, 'commercial', 'activation.json');
}

async function writeProtectedJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function resolveCommercialDeviceId(aidenRoot: string): Promise<string> {
  const filename = path.join(aidenRoot, 'commercial', 'device.json');
  try {
    const current = JSON.parse(await fs.readFile(filename, 'utf8')) as { schemaVersion?: number; deviceId?: string };
    if (current.schemaVersion === 1 && /^aiden-device-[a-f0-9]{16}$/.test(current.deviceId ?? '')) return current.deviceId!;
  } catch { /* Create one random local identity below. */ }
  const deviceId = `aiden-device-${randomBytes(8).toString('hex')}`;
  await writeProtectedJson(filename, { schemaVersion: 1, deviceId, createdAt: new Date().toISOString() });
  return deviceId;
}

export async function activateCommercialDevice(input: {
  serviceOrigin: string;
  activationCode: string;
  deviceId: string;
  aidenRoot: string;
  entitlementPublicKey: string;
  fetch?: typeof fetch;
}): Promise<CommercialActivationRecord> {
  const origin = new URL(input.serviceOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.serviceOrigin || origin.username || origin.password)
    throw new Error('An exact HTTPS activation service origin is required');
  if (!bearer.test(input.activationCode) || !device.test(input.deviceId)) throw new Error('Invalid activation input');
  const response = await (input.fetch ?? globalThis.fetch)(new URL('/api/v1/activation/redeem', origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: input.activationCode, deviceId: input.deviceId, product: 'content-studio' }),
  });
  if (!response.ok) throw new Error(`Activation denied (${response.status})`);
  let body: { deviceToken?: string; entitlement?: SignedEntitlement };
  try { body = await response.json() as typeof body; }
  catch { throw new Error('Activation response is invalid'); }
  if (!bearer.test(body.deviceToken ?? '') || !body.entitlement) throw new Error('Activation response is invalid');
  const authority = new EntitlementAuthority({ paths: { root: input.aidenRoot }, publicKeyPem: input.entitlementPublicKey,
    product: 'aiden', deviceBinding: input.deviceId });
  const evaluated = authority.evaluate(body.entitlement);
  if (evaluated.state !== 'active' || evaluated.edition !== 'pro') throw new Error(`Activation entitlement is not active (${evaluated.reason ?? evaluated.state})`);
  const record: CommercialActivationRecord = { schemaVersion: 1, serviceOrigin: origin.origin, deviceId: input.deviceId,
    deviceToken: body.deviceToken!, claim: body.entitlement.claim, signature: body.entitlement.signature,
    activatedAt: new Date().toISOString() };
  await writeProtectedJson(activationFile(input.aidenRoot), record);
  return record;
}

export interface CommercialBillingProjection {
  access: 'free' | 'active' | 'payment_unverified' | 'payment_needs_attention' | 'grace' | 'cancelled' | 'expired' | 'revoked';
  proAccess: boolean;
  periodEnd?: number;
  graceUntil?: number;
  cancellationPending?: boolean;
  entitlementRevision: number;
  stateVersion: string;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Entitlement refresh response is empty');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 64 * 1024) { await reader.cancel(); throw new Error('Entitlement refresh response is too large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Entitlement refresh response is invalid'); }
}

export async function refreshCommercialDevice(input: {
  aidenRoot: string;
  entitlementPublicKey: string;
  fetch?: typeof fetch;
}): Promise<{ entitlement: ReturnType<EntitlementAuthority['evaluate']>; billing: CommercialBillingProjection; deviceId: string }> {
  const current = await loadCommercialActivation(input);
  if (!current) throw new Error('No commercial device activation is available');
  const response = await (input.fetch ?? globalThis.fetch)(new URL('/api/v1/entitlement/refresh', current.serviceOrigin), {
    method: 'POST', headers: { Authorization: `Device ${current.deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: 'content-studio' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Entitlement refresh denied (${response.status})`);
  const body = await boundedJson(response) as { entitlement?: SignedEntitlement; account?: Partial<CommercialBillingProjection> };
  if (!body.entitlement || !body.account) throw new Error('Entitlement refresh response is invalid');
  const authority = new EntitlementAuthority({ paths: { root: input.aidenRoot }, publicKeyPem: input.entitlementPublicKey,
    product: 'aiden', deviceBinding: current.deviceId });
  const entitlement = authority.evaluate(body.entitlement);
  if (!['active', 'grace', 'expired', 'revoked'].includes(entitlement.state)
    || body.entitlement.claim.accountId !== current.claim.accountId
    || body.entitlement.claim.deviceBinding !== current.deviceId
    || Date.parse(body.entitlement.claim.issuedAt) < Date.parse(current.claim.issuedAt))
    throw new Error('Entitlement refresh identity is invalid');
  const account = body.account;
  if (!['free', 'active', 'payment_unverified', 'payment_needs_attention', 'grace', 'cancelled', 'expired', 'revoked'].includes(account.access ?? '')
    || typeof account.proAccess !== 'boolean' || !Number.isSafeInteger(account.entitlementRevision)
    || !/^[a-f0-9]{64}$/.test(account.stateVersion ?? '')
    || (account.periodEnd !== undefined && !Number.isSafeInteger(account.periodEnd))
    || (account.graceUntil !== undefined && !Number.isSafeInteger(account.graceUntil)))
    throw new Error('Entitlement refresh account state is invalid');
  const next: CommercialActivationRecord = { ...current, claim: body.entitlement.claim, signature: body.entitlement.signature };
  await writeProtectedJson(activationFile(input.aidenRoot), next);
  await writeProtectedJson(path.join(input.aidenRoot, 'commercial', 'billing.json'), {
    schemaVersion: 1, ...account, updatedAt: new Date().toISOString(),
  });
  return { entitlement, billing: account as CommercialBillingProjection, deviceId: current.deviceId };
}

export async function loadCommercialActivation(input: {
  aidenRoot: string;
  entitlementPublicKey: string;
}): Promise<CommercialActivationRecord | null> {
  let value: CommercialActivationRecord;
  try { value = JSON.parse(await fs.readFile(activationFile(input.aidenRoot), 'utf8')) as CommercialActivationRecord; }
  catch { return null; }
  if (value.schemaVersion !== 1 || !bearer.test(value.deviceToken) || !device.test(value.deviceId)) return null;
  const authority = new EntitlementAuthority({ paths: { root: input.aidenRoot }, publicKeyPem: input.entitlementPublicKey,
    product: 'aiden', deviceBinding: value.deviceId });
  return ['active', 'grace', 'revoked', 'expired'].includes(authority.evaluate(value).state) ? value : null;
}

export async function commercialDeviceStatus(input: {
  aidenRoot: string;
  entitlementPublicKey: string;
}): Promise<{
  entitlement: ReturnType<EntitlementAuthority['evaluate']>;
  billing?: CommercialBillingProjection;
  deviceId?: string;
  accountUrl?: string;
  product: { id: 'content-studio'; activeVersion: string | null; previousVersion: string | null };
}> {
  const activation = await loadCommercialActivation(input);
  const authority = new EntitlementAuthority({ paths: { root: input.aidenRoot }, publicKeyPem: input.entitlementPublicKey,
    product: 'aiden', deviceBinding: activation?.deviceId });
  const entitlement = activation ? authority.evaluate(activation) : await authority.snapshot();
  let activeVersion: string | null = null; let previousVersion: string | null = null;
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(input.aidenRoot, 'products', 'content-studio', 'active.json'), 'utf8')) as {
      productId?: string; version?: string; previousVersion?: string | null;
    };
    if (pointer.productId === 'content-studio' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(pointer.version ?? '')) {
      activeVersion = pointer.version!;
      previousVersion = typeof pointer.previousVersion === 'string' ? pointer.previousVersion : null;
    }
  } catch { /* The private product is not installed. */ }
  let billing: CommercialBillingProjection | undefined;
  try {
    const cached = JSON.parse(await fs.readFile(path.join(input.aidenRoot, 'commercial', 'billing.json'), 'utf8')) as
      CommercialBillingProjection & { schemaVersion?: number };
    if (cached.schemaVersion === 1 && ['free', 'active', 'payment_unverified', 'payment_needs_attention', 'grace', 'cancelled', 'expired', 'revoked'].includes(cached.access)
      && typeof cached.proAccess === 'boolean' && Number.isSafeInteger(cached.entitlementRevision)
      && /^[a-f0-9]{64}$/.test(cached.stateVersion)) billing = cached;
  } catch { /* No provider projection has been refreshed yet. */ }
  return { entitlement, ...(billing ? { billing } : {}), ...(activation ? { deviceId: activation.deviceId, accountUrl: activation.serviceOrigin } : {}),
    product: { id: 'content-studio', activeVersion, previousVersion } };
}
