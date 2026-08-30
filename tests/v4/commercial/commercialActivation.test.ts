import { generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { activateCommercialDevice, loadCommercialActivation, refreshCommercialDevice,
  resolveCommercialDeviceId, commercialDeviceStatus } from '../../../core/v4/commercial/commercialActivation';
import { canonicalJson } from '../../../core/v4/commercial/signedPayload';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

describe('commercial device activation', () => {
  it('redeems once, verifies the exact signed device entitlement, and persists only protected local state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-activation-')); roots.push(root);
    const keys = generateKeyPairSync('ed25519'); const deviceId = 'device-local-1';
    const claim = { product: 'aiden' as const, accountId: 'account-1', edition: 'pro' as const,
      capabilities: ['workflow.premium'] as const, deviceBinding: deviceId,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const entitlement = { claim, signature: sign(null, Buffer.from(canonicalJson(claim)), keys.privateKey).toString('base64') };
    const record = await activateCommercialDevice({ serviceOrigin: 'https://billing.test', activationCode: 'a'.repeat(43),
      deviceId, aidenRoot: root, entitlementPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fetch: async (_request, init) => {
        expect(init?.body).toBe(JSON.stringify({ code: 'a'.repeat(43), deviceId, product: 'content-studio' }));
        return Response.json({ deviceToken: 'd'.repeat(43), entitlement });
      } });
    expect(record.claim.deviceBinding).toBe(deviceId);
    await expect(loadCommercialActivation({ aidenRoot: root,
      entitlementPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).resolves.toMatchObject({ deviceId });
    const stored = await fs.readFile(path.join(root, 'commercial', 'activation.json'), 'utf8');
    expect(stored).not.toContain('a'.repeat(43));
  });

  it('does not persist a bad signature or wrong device binding', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-activation-')); roots.push(root);
    const keys = generateKeyPairSync('ed25519');
    const entitlement = { claim: { product: 'aiden' as const, accountId: 'account-1', edition: 'pro' as const,
      capabilities: ['workflow.premium'] as const, deviceBinding: 'other-device', issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, signature: 'invalid' };
    await expect(activateCommercialDevice({ serviceOrigin: 'https://billing.test', activationCode: 'a'.repeat(43),
      deviceId: 'device-local-1', aidenRoot: root, entitlementPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fetch: async () => Response.json({ deviceToken: 'd'.repeat(43), entitlement }) })).rejects.toThrow(/entitlement/i);
    await expect(fs.stat(path.join(root, 'commercial', 'activation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refreshes exact signed terminal state without exposing or replacing the device identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-activation-')); roots.push(root);
    const keys = generateKeyPairSync('ed25519'); const deviceId = 'device-local-1'; const accountId = 'account-1';
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signed = (claim: Record<string, unknown>) => ({ claim, signature: sign(null, Buffer.from(canonicalJson(claim)), keys.privateKey).toString('base64') });
    const activeClaim = { product: 'aiden', accountId, edition: 'pro', capabilities: ['workflow.premium'], deviceBinding: deviceId,
      issuedAt: new Date(Date.now() - 2_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await activateCommercialDevice({ serviceOrigin: 'https://billing.test', activationCode: 'a'.repeat(43), deviceId,
      aidenRoot: root, entitlementPublicKey: publicKey, fetch: async () => Response.json({ deviceToken: 'd'.repeat(43), entitlement: signed(activeClaim) }) });
    const revokedClaim = { product: 'aiden', accountId, edition: 'community', capabilities: [], deviceBinding: deviceId,
      issuedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), offlineUntil: new Date().toISOString(), revoked: true };
    const result = await refreshCommercialDevice({ aidenRoot: root, entitlementPublicKey: publicKey, fetch: async (_url, init) => {
      expect(init?.headers).toEqual({ Authorization: `Device ${'d'.repeat(43)}`, 'Content-Type': 'application/json' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ entitlement: signed(revokedClaim), account: { access: 'revoked', proAccess: false,
        entitlementRevision: 2, stateVersion: 'f'.repeat(64) } });
    } });
    expect(result).toMatchObject({ entitlement: { state: 'revoked', edition: 'community' }, billing: { access: 'revoked' }, deviceId });
    expect(JSON.stringify(result)).not.toContain('d'.repeat(43));
    expect(await loadCommercialActivation({ aidenRoot: root, entitlementPublicKey: publicKey })).toMatchObject({ deviceId, claim: { revoked: true } });
    expect(await commercialDeviceStatus({ aidenRoot: root, entitlementPublicKey: publicKey })).toMatchObject({ billing: { access: 'revoked' } });
  });
  it('keeps one random local device identity without machine fingerprinting', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-activation-')); roots.push(root);
    const first = await resolveCommercialDeviceId(root);
    const second = await resolveCommercialDeviceId(root);
    expect(first).toBe(second);
    expect(first).toMatch(/^aiden-device-[a-f0-9]{16}$/);
    expect(await fs.readFile(path.join(root, 'commercial', 'device.json'), 'utf8')).toContain(first);
  });
  it('projects local entitlement and installed Content Studio versions without bearer credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-activation-')); roots.push(root);
    const keys = generateKeyPairSync('ed25519'); const deviceId = 'device-local-1';
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const claim = { product: 'aiden' as const, accountId: 'account-1', edition: 'pro' as const,
      capabilities: ['workflow.premium'] as const, deviceBinding: deviceId,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const entitlement = { claim, signature: sign(null, Buffer.from(canonicalJson(claim)), keys.privateKey).toString('base64') };
    await activateCommercialDevice({ serviceOrigin: 'https://billing.test', activationCode: 'a'.repeat(43), deviceId,
      aidenRoot: root, entitlementPublicKey: publicKey, fetch: async () => Response.json({ deviceToken: 'd'.repeat(43), entitlement }) });
    const productRoot = path.join(root, 'products', 'content-studio'); await fs.mkdir(productRoot, { recursive: true });
    await fs.writeFile(path.join(productRoot, 'active.json'), JSON.stringify({ productId: 'content-studio', version: '0.2.0-beta.2', previousVersion: '0.2.0-beta.1' }));
    const status = await commercialDeviceStatus({ aidenRoot: root, entitlementPublicKey: publicKey });
    expect(status).toMatchObject({ entitlement: { state: 'active', edition: 'pro' }, deviceId, accountUrl: 'https://billing.test',
      product: { activeVersion: '0.2.0-beta.2', previousVersion: '0.2.0-beta.1' } });
    expect(JSON.stringify(status)).not.toContain('d'.repeat(43));
  });
});
