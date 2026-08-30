import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createProductHostAuthority,
  type ProductPublicationAuthorization,
} from '../../../core/v4/commercial/productHostAuthority';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(authorizePublication?: (input: ProductPublicationAuthorization) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-product-host-')); roots.push(root);
  return createProductHostAuthority({ aidenRoot: root, ownerId: 'fixture-product-host', productId: 'fixture-product', authorizePublication });
}

function admission(host: ReturnType<typeof fixture>) {
  return host.admit({ subjectId: 'publication-subject', workspaceId: 'workspace-publication', sourceArtifactId: 'artifact-source',
    sourceArtifactDigest: 'a'.repeat(64), sourceTaskId: 'render-task', sourceGeneration: 1,
    idempotencyKey: 'admit-publication-subject', goal: 'Review verified product output', title: 'Review product output' });
}

function publication(binding: ReturnType<typeof admission>): ProductPublicationAuthorization {
  return { binding, intentId: 'intent-publication', intentDigest: 'b'.repeat(64), artifactId: 'artifact-video',
    artifactSha256: 'c'.repeat(64), accountId: 'account-youtube', targetId: 'channel-youtube' };
}

describe('generic product host authority', () => {
  it('admits one canonical waiting continuation and preserves its exact authority identity', () => {
    const host = fixture();
    const input = { subjectId: 'subject-1', workspaceId: 'workspace-1', sourceArtifactId: 'artifact-1',
      sourceArtifactDigest: 'a'.repeat(64), sourceTaskId: 'task-1', sourceGeneration: 1,
      idempotencyKey: 'admit-subject-1', goal: 'Review verified product output', title: 'Review product output' };
    const first = host.admit(input); const second = host.admit(input);
    expect(second).toEqual(first);
    expect(host.validate(first)).toEqual(first);
    expect(host.getJob(first.jobId)).toMatchObject({ id: first.jobId, status: 'waiting', workspaceId: 'workspace-1' });
    expect(host.getAttempt(first.attemptId)).toMatchObject({ id: first.attemptId, status: 'waiting', generation: first.generation, fenceToken: first.fenceToken });
    expect(host.listJobs()).toHaveLength(1);
    host.close();
  });

  it('rejects stale authority and releases a reattached lease back to waiting', () => {
    const host = fixture();
    const binding = host.admit({ subjectId: 'subject-2', workspaceId: 'workspace-2', sourceArtifactId: 'artifact-2',
      sourceArtifactDigest: 'b'.repeat(64), sourceTaskId: 'task-2', sourceGeneration: 1,
      idempotencyKey: 'admit-subject-2', goal: 'Review verified product output', title: 'Review product output' });
    expect(() => host.validate({ ...binding, fenceToken: 'stale-fence' })).toThrow(/fence/i);
    const acquired = host.acquire(binding); expect(host.getAttempt(acquired.attemptId)?.status).toBe('leased');
    host.release(acquired, 'waiting_for_product_review');
    expect(host.getAttempt(acquired.attemptId)).toMatchObject({ status: 'waiting', leaseOwner: null, leaseExpiresAt: null });
    host.close();
  });

  it('authorizes an exact publication only through the public host callback', () => {
    const accepted: ProductPublicationAuthorization[] = [];
    const host = fixture((input) => { accepted.push(input); });
    const binding = admission(host); const request = publication(binding);
    expect(host.authorizePublication(request)).toEqual(binding);
    expect(accepted).toEqual([request]);
    host.close();
  });

  it('fails closed without a public publication authorizer and rejects stale authority before callbacks', () => {
    const missing = fixture(); const missingBinding = admission(missing);
    expect(() => missing.authorizePublication(publication(missingBinding))).toThrow(/authoriz/i);
    missing.close();

    let calls = 0; const host = fixture(() => { calls += 1; }); const binding = admission(host);
    expect(() => host.authorizePublication(publication({ ...binding, generation: binding.generation + 1 }))).toThrow(/generation/i);
    expect(() => host.authorizePublication(publication({ ...binding, fenceToken: 'stale-fence' }))).toThrow(/fence/i);
    expect(calls).toBe(0);
    host.close();
  });

  it('delegates approval, Artifact, and target equality to the public action authority', () => {
    const expected = { intentDigest: 'b'.repeat(64), artifactId: 'artifact-video', artifactSha256: 'c'.repeat(64),
      accountId: 'account-youtube', targetId: 'channel-youtube' };
    const host = fixture((input) => {
      for (const [key, value] of Object.entries(expected)) {
        if (input[key as keyof typeof expected] !== value) throw new Error(`Publication ${key} differs from the approved action`);
      }
    });
    const binding = admission(host); const request = publication(binding);
    expect(() => host.authorizePublication({ ...request, intentDigest: 'd'.repeat(64) })).toThrow(/approved action/i);
    expect(() => host.authorizePublication({ ...request, artifactSha256: 'e'.repeat(64) })).toThrow(/approved action/i);
    expect(() => host.authorizePublication({ ...request, targetId: 'channel-other' })).toThrow(/approved action/i);
    expect(host.authorizePublication(request)).toEqual(binding);
    host.close();
  });
});
