/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AidenPaths } from '../paths';
import {
  COMMERCIAL_CAPABILITIES,
  EditionAuthority,
  type CommercialCapability,
  type ProductEdition,
} from './edition';
import { canonicalJson, verifyEd25519Payload } from './signedPayload';

const cacheLock = require('proper-lockfile') as {
  lock(file: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

export type EntitlementState =
  | 'community'
  | 'trial'
  | 'active'
  | 'grace'
  | 'expired'
  | 'revoked'
  | 'unavailable';

export interface EntitlementClaim {
  product: 'aiden';
  accountId: string;
  edition: ProductEdition;
  capabilities: CommercialCapability[];
  issuedAt: string;
  expiresAt: string;
  offlineUntil?: string;
  deviceBinding?: string;
  trial?: boolean;
  revoked?: boolean;
}

export interface SignedEntitlement {
  claim: EntitlementClaim;
  signature: string;
}

export interface EntitlementSnapshot {
  state: EntitlementState;
  edition: ProductEdition;
  accountId?: string;
  capabilities: CommercialCapability[];
  issuedAt?: string;
  expiresAt?: string;
  offlineUntil?: string;
  reason?: string;
}

export interface EntitlementRefreshProvider {
  refresh(): Promise<SignedEntitlement | null>;
}

export interface EntitlementAuthorityOptions {
  paths: Pick<AidenPaths, 'root'>;
  publicKeyPem: string;
  product?: string;
  deviceBinding?: string;
  refreshProvider?: EntitlementRefreshProvider;
  now?: () => Date;
  cacheFile?: string;
}

export class EntitlementAuthority {
  private readonly now: () => Date;
  private readonly cacheFile: string;

  constructor(private readonly options: EntitlementAuthorityOptions) {
    this.now = options.now ?? (() => new Date());
    this.cacheFile = options.cacheFile ?? path.join(options.paths.root, 'commercial', 'entitlement.json');
  }

  async snapshot(): Promise<EntitlementSnapshot> {
    const signed = await this.readCache();
    if (!signed) {
      return { state: 'community', edition: 'community', capabilities: [] };
    }
    return this.evaluate(signed);
  }

  async refresh(): Promise<EntitlementSnapshot> {
    if (!this.options.refreshProvider) {
      const current = await this.snapshot();
      return current.state === 'community'
        ? { ...current, state: 'unavailable', reason: 'entitlement service unavailable' }
        : current;
    }
    let signed: SignedEntitlement | null;
    try {
      signed = await this.options.refreshProvider.refresh();
    } catch {
      const cached = await this.snapshot();
      if (cached.state === 'active' || cached.state === 'trial' || cached.state === 'grace' || cached.state === 'revoked') return cached;
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'entitlement service unavailable' };
    }
    try {
      if (!signed) return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'no entitlement returned' };
      const result = this.evaluate(signed);
      if (result.state === 'unavailable') return result;
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const release = await cacheLock.lock(this.cacheFile, { realpath: false, retries: 0 });
      try {
        const cached = await this.readCache();
        if (cached && this.evaluate(cached).state !== 'unavailable') {
          const previousTime = Date.parse(cached.claim.issuedAt);
          const nextTime = Date.parse(signed.claim.issuedAt);
          if (nextTime < previousTime) return this.evaluate(cached);
          if (nextTime === previousTime && canonicalJson(cached.claim) !== canonicalJson(signed.claim)) {
            if (cached.claim.revoked) return this.evaluate(cached);
            if (!signed.claim.revoked) return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'conflicting entitlement revision' };
          }
        }
        // Signed terminal states replace cached access just like signed renewals.
        await this.writeCache(signed);
        return result;
      } finally {
        await release();
      }
    } catch {
      return {
        state: 'unavailable', edition: 'community', capabilities: [],
        reason: 'entitlement cache unavailable',
      };
    }
  }

  editionAuthority(snapshot: EntitlementSnapshot): EditionAuthority {
    return new EditionAuthority({ edition: snapshot.edition, grants: snapshot.capabilities });
  }

  evaluate(signed: SignedEntitlement): EntitlementSnapshot {
    if (!signed || !verifyEd25519Payload(signed.claim, signed.signature, this.options.publicKeyPem)) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'invalid entitlement signature' };
    }
    const claim = signed.claim;
    if (!claim || typeof claim !== 'object' || typeof claim.accountId !== 'string' || !claim.accountId.trim()
      || !['community', 'pro', 'team', 'enterprise'].includes(claim.edition)
      || !Array.isArray(claim.capabilities) || !claim.capabilities.every(value => typeof value === 'string')
      || typeof claim.issuedAt !== 'string' || typeof claim.expiresAt !== 'string'
      || (claim.offlineUntil !== undefined && typeof claim.offlineUntil !== 'string')
      || (claim.deviceBinding !== undefined && typeof claim.deviceBinding !== 'string')
      || (claim.revoked !== undefined && typeof claim.revoked !== 'boolean')
      || (claim.trial !== undefined && typeof claim.trial !== 'boolean')) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'invalid entitlement claim' };
    }
    const now = this.now().getTime();
    const issuedAt = Date.parse(claim.issuedAt);
    const expiresAt = Date.parse(claim.expiresAt);
    const offlineUntil = claim.offlineUntil ? Date.parse(claim.offlineUntil) : Number.NaN;
    if (!Number.isFinite(now) || !Number.isFinite(issuedAt) || issuedAt > now
      || !Number.isFinite(expiresAt)
      || (claim.offlineUntil !== undefined && (!Number.isFinite(offlineUntil) || offlineUntil < expiresAt))) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'invalid entitlement time bounds' };
    }
    if (claim.product !== (this.options.product ?? 'aiden')) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'wrong entitlement product' };
    }
    if (this.options.deviceBinding && claim.deviceBinding && claim.deviceBinding !== this.options.deviceBinding) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'wrong device binding' };
    }
    if (claim.revoked) {
      return { state: 'revoked', edition: 'community', capabilities: [], accountId: claim.accountId };
    }
    const capabilities = claim.capabilities.filter((capability): capability is CommercialCapability =>
      (COMMERCIAL_CAPABILITIES as readonly string[]).includes(capability));
    const base = {
      edition: claim.edition,
      accountId: claim.accountId,
      capabilities,
      issuedAt: claim.issuedAt,
      expiresAt: claim.expiresAt,
      ...(claim.offlineUntil ? { offlineUntil: claim.offlineUntil } : {}),
    };
    if (now < expiresAt) return { ...base, state: claim.edition === 'community' ? 'community' : claim.trial ? 'trial' : 'active' };
    if (Number.isFinite(offlineUntil) && now < offlineUntil) return { ...base, state: 'grace' };
    return { ...base, state: 'expired', capabilities: [] };
  }

  private async readCache(): Promise<SignedEntitlement | null> {
    try {
      return JSON.parse(await fs.readFile(this.cacheFile, 'utf8')) as SignedEntitlement;
    } catch {
      return null;
    }
  }

  private async writeCache(value: SignedEntitlement): Promise<void> {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const temp = `${this.cacheFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, this.cacheFile);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
