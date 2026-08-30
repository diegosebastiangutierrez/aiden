import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntitlementAuthority, type EntitlementClaim } from '../../../core/v4/commercial/entitlementAuthority';
import { canonicalJson } from '../../../core/v4/commercial/signedPayload';
import type { AidenPaths } from '../../../core/v4/paths';

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const roots: string[] = [];
const current = '2026-08-28T12:00:00.000Z';
function signed(overrides: Partial<EntitlementClaim> = {}) {
  const claim: EntitlementClaim = { product: 'aiden', accountId: 'customer-1', edition: 'pro',
    capabilities: ['workflow.premium'], issuedAt: '2026-08-28T11:00:00.000Z',
    expiresAt: '2026-09-28T11:00:00.000Z', deviceBinding: 'device-1', ...overrides };
  return { claim, signature: sign(null, Buffer.from(canonicalJson(claim)), keys.privateKey).toString('base64') };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-entitlement-safety-'));
  roots.push(root);
  let next = signed();
  const options = { paths: { root } as AidenPaths, publicKeyPem, now: () => new Date(current),
    deviceBinding: 'device-1', refreshProvider: { refresh: async () => next } };
  return { options, authority: new EntitlementAuthority(options), set: (value: typeof next) => { next = value; } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('entitlement refresh safety', () => {
  it('persists a signed revocation across restart instead of reviving the active cache', async () => {
    const f = await fixture();
    expect((await f.authority.refresh()).state).toBe('active');
    f.set(signed({ revoked: true, issuedAt: current }));
    expect((await f.authority.refresh()).state).toBe('revoked');
    expect((await new EntitlementAuthority(f.options).snapshot()).state).toBe('revoked');
  });
  it('persists a newly expired signed grant instead of reviving old access', async () => {
    const f = await fixture(); await f.authority.refresh();
    f.set(signed({ issuedAt: current, expiresAt: current }));
    expect((await f.authority.refresh()).state).toBe('expired');
    expect((await new EntitlementAuthority(f.options).snapshot()).state).toBe('expired');
  });
  it('rejects an older active refresh after a newer revocation', async () => {
    const f = await fixture(); f.set(signed({ revoked: true, issuedAt: current })); await f.authority.refresh();
    f.set(signed());
    expect((await f.authority.refresh()).state).toBe('revoked');
    expect((await f.authority.snapshot()).state).toBe('revoked');
  });
  it('preserves a revocation when the provider uses the same issue timestamp', async () => {
    const f = await fixture(); await f.authority.refresh();
    f.set(signed({ revoked: true }));
    expect((await f.authority.refresh()).state).toBe('revoked');
    f.set(signed());
    expect((await f.authority.refresh()).state).toBe('revoked');
  });
  it('does not revive access when an older provider response arrives last', async () => {
    const f = await fixture();
    let release!: (value: ReturnType<typeof signed>) => void;
    const delayed = new EntitlementAuthority({ ...f.options,
      refreshProvider: { refresh: () => new Promise(resolve => { release = resolve; }) } });
    const pending = delayed.refresh();
    f.set(signed({ revoked: true, issuedAt: current })); await f.authority.refresh();
    release(signed());
    expect((await pending).state).toBe('revoked');
    expect((await f.authority.snapshot()).state).toBe('revoked');
  });
  it('does not overwrite a valid cache with invalid signed input', async () => {
    const f = await fixture(); await f.authority.refresh();
    f.set({ ...signed({ revoked: true }), signature: 'invalid' });
    expect((await f.authority.refresh()).state).toBe('unavailable');
    expect((await f.authority.snapshot()).state).toBe('active');
  });
  it('rejects a future-issued claim when the local clock has rolled back', async () => {
    const f = await fixture();
    expect(f.authority.evaluate(signed({ issuedAt: '2026-08-29T12:00:00.000Z' })).state).toBe('unavailable');
  });
  it('fails closed for a signed malformed claim without throwing', async () => {
    const f = await fixture();
    expect(f.authority.evaluate(signed({ capabilities: null as unknown as EntitlementClaim['capabilities'] })).state).toBe('unavailable');
  });
  it('does not leak provider error details into diagnostics', async () => {
    const f = await fixture();
    const authority = new EntitlementAuthority({ ...f.options,
      refreshProvider: { refresh: async () => { throw new Error('Authorization: confidential-fixture'); } } });
    expect(JSON.stringify(await authority.refresh())).not.toContain('confidential-fixture');
  });
});
