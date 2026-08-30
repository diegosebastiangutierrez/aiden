/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

import { createHash } from 'node:crypto';

import { createJobEngine, type AttemptRecord, type JobEngine, type JobRecord } from '../daemon/jobEngine';
import { closeDaemonDb, openDaemonDb } from '../daemon/db/connection';
import { daemonDbPath } from '../daemon/daemonConfig';
import { createLearningAuthority } from '../learning';

const LEASE_TTL_MS = 60_000;
const identifier = /^[a-z0-9][a-z0-9-]{1,62}$/;

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
    : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export interface ProductHostBinding {
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  workspaceId: string;
}

export interface ProductHostAdmission {
  subjectId: string;
  workspaceId: string;
  sourceArtifactId: string;
  sourceArtifactDigest: string;
  sourceTaskId: string;
  sourceGeneration: number;
  idempotencyKey: string;
  goal: string;
  title: string;
}

export interface ProductPublicationAuthorization {
  binding: ProductHostBinding;
  intentId: string;
  intentDigest: string;
  artifactId: string;
  artifactSha256: string;
  accountId: string;
  targetId: string;
}

export interface ProductHostAuthority {
  admit(input: ProductHostAdmission): ProductHostBinding;
  validate(binding: ProductHostBinding): ProductHostBinding;
  acquire(binding: ProductHostBinding): ProductHostBinding;
  release(binding: ProductHostBinding, reason: string): void;
  authorizePublication(input: ProductPublicationAuthorization): ProductHostBinding;
  getJob(jobId: string): JobRecord | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  listJobs(): JobRecord[];
  retrieveLearning(input: { objective: string; ownerId: string; workspaceId: string; projectId: string; limit?: number }): {
    items: Array<{ content: string | null; subjectKey: string; confidence: string }>;
    context: string;
  };
  close(): void;
}

function exact(engine: JobEngine, entryPoint: string, binding: ProductHostBinding): ProductHostBinding {
  const job = engine.getJob(binding.jobId);
  const attempt = engine.getAttempt(binding.attemptId);
  if (!job || !attempt || attempt.jobId !== job.id || job.activeAttemptId !== attempt.id) throw new Error('Product Job or Attempt is missing');
  if (job.entryPoint !== entryPoint || job.source !== entryPoint) throw new Error('Job is outside product-host authority');
  if (job.workspaceId !== binding.workspaceId) throw new Error('Product workspace is outside Job authority');
  if (attempt.generation !== binding.generation) throw new Error('Stale product generation');
  if (attempt.fenceToken !== binding.fenceToken) throw new Error('Stale product fence');
  if (!['waiting', 'leased'].includes(attempt.status) || !['waiting', 'queued', 'recovering'].includes(job.status)) throw new Error('Product continuation is not available');
  return { jobId: job.id, attemptId: attempt.id, generation: attempt.generation, fenceToken: attempt.fenceToken, workspaceId: binding.workspaceId };
}

export function createProductHostAuthority(options: {
  aidenRoot: string;
  ownerId: string;
  productId: string;
  authorizePublication?: (input: ProductPublicationAuthorization) => void;
}): ProductHostAuthority {
  if (!identifier.test(options.productId) || !identifier.test(options.ownerId)) throw new Error('Invalid product-host identity');
  const entryPoint = `product:${options.productId}:continuation`;
  const databasePath = daemonDbPath(options.aidenRoot);
  const db = openDaemonDb(databasePath);
  const now = Date.now();
  db.prepare(`INSERT INTO daemon_instances(instance_id,pid,hostname,started_at,last_heartbeat,version)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(instance_id) DO UPDATE SET pid=excluded.pid,last_heartbeat=excluded.last_heartbeat,version=excluded.version`)
    .run(options.ownerId, process.pid, 'localhost', now, now, 'product-host');
  const engine = createJobEngine({ db });
  const learning = createLearningAuthority({ db, enabled: true });
  const validate = (binding: ProductHostBinding) => exact(engine, entryPoint, binding);
  const release = (binding: ProductHostBinding, reason: string) => {
    const current = validate(binding);
    const attempt = engine.getAttempt(current.attemptId)!;
    if (attempt.status === 'waiting') return;
    if (!attempt.leaseId) throw new Error('Product-host lease identity is missing');
    const result = engine.detachAttemptForHost({ jobId: current.jobId, attemptId: current.attemptId,
      generation: current.generation, fenceToken: current.fenceToken, ownerId: options.ownerId, reason,
      producer: entryPoint, eventIdempotencyKey: `product-host-detach:${current.jobId}:${attempt.leaseId}` });
    if (!result.applied && !result.duplicate) throw new Error(`Product continuation could not detach: ${result.conflict ?? 'unknown conflict'}`);
  };
  return {
    admit(input) {
      if (!input.subjectId || !input.workspaceId || !input.sourceArtifactId || !/^[a-f0-9]{64}$/i.test(input.sourceArtifactDigest)
        || !input.sourceTaskId || !Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 1
        || !input.idempotencyKey || !input.goal || !input.title) throw new Error('Invalid product continuation admission');
      const admission = engine.submitJob({ entryPoint, source: entryPoint, sessionId: `product:${options.productId}:${input.subjectId}`,
        workspaceId: input.workspaceId, principalId: `product:${options.productId}`, instanceId: options.ownerId,
        idempotencyNamespace: entryPoint, idempotencyKey: input.idempotencyKey,
        requestFingerprint: digest({ subjectId: input.subjectId, workspaceId: input.workspaceId,
          sourceArtifactId: input.sourceArtifactId, sourceArtifactDigest: input.sourceArtifactDigest,
          sourceTaskId: input.sourceTaskId, sourceGeneration: input.sourceGeneration }), goal: input.goal, title: input.title });
      const job = engine.getJob(admission.jobId); const attempt = engine.getAttempt(admission.attemptId);
      if (!job || !attempt || job.workspaceId !== input.workspaceId) throw new Error('Product continuation admission failed');
      if (attempt.status === 'waiting' && attempt.fenceToken) return validate({ jobId: job.id, attemptId: attempt.id, generation: attempt.generation, fenceToken: attempt.fenceToken, workspaceId: input.workspaceId });
      if (attempt.status === 'leased' && attempt.fenceToken && attempt.leaseOwner === options.ownerId) {
        const binding = { jobId: job.id, attemptId: attempt.id, generation: attempt.generation, fenceToken: attempt.fenceToken, workspaceId: input.workspaceId };
        release(binding, 'waiting_for_product_review'); return validate(binding);
      }
      if (attempt.status !== 'queued') throw new Error(`Product continuation cannot be admitted from ${attempt.status}`);
      const lease = engine.claimAttempt({ attemptId: attempt.id, ownerId: options.ownerId, ttlMs: LEASE_TTL_MS });
      if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error(`Product continuation lease was not acquired: ${lease.conflict ?? 'unknown conflict'}`);
      const binding = { jobId: job.id, attemptId: attempt.id, generation: lease.generation, fenceToken: lease.fenceToken, workspaceId: input.workspaceId };
      release(binding, 'waiting_for_product_review'); return validate(binding);
    },
    validate,
    authorizePublication(input) {
      const current = validate(input.binding);
      if (!input.intentId || !/^[a-f0-9]{64}$/.test(input.intentDigest)
        || !input.artifactId || !/^[a-f0-9]{64}$/.test(input.artifactSha256)
        || !input.accountId || !input.targetId) throw new Error('Invalid publication authorization identity');
      if (!options.authorizePublication) throw new Error('Public publication authorizer is unavailable');
      options.authorizePublication({ ...input, binding: current });
      return current;
    },
    acquire(binding) {
      const job = engine.getJob(binding.jobId); const attempt = engine.getAttempt(binding.attemptId);
      if (!job || !attempt || attempt.jobId !== job.id || job.activeAttemptId !== attempt.id) throw new Error('Product Job or Attempt is missing');
      if (job.workspaceId !== binding.workspaceId || attempt.generation !== binding.generation || attempt.fenceToken !== binding.fenceToken) throw new Error('Stale product generation or fence');
      if (attempt.status === 'leased' && attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt <= Date.now()) {
        const recovered = engine.recoverExpiredAttempts({ now: Date.now(), instanceId: options.ownerId, producer: entryPoint, maxCrashes: 3 })
          .find((item) => item.jobId === binding.jobId && item.expiredAttemptId === binding.attemptId);
        if (!recovered || recovered.decision !== 'retry' || !recovered.recoveryAttemptId) throw new Error('Expired product authority could not be recovered safely');
        const next = engine.getAttempt(recovered.recoveryAttemptId);
        if (!next || next.status !== 'queued') throw new Error('Product recovery Attempt is unavailable');
        const lease = engine.claimAttempt({ attemptId: next.id, ownerId: options.ownerId, ttlMs: LEASE_TTL_MS });
        if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('Product recovery lease was not acquired');
        return exact(engine, entryPoint, { jobId: binding.jobId, attemptId: next.id, generation: lease.generation, fenceToken: lease.fenceToken, workspaceId: binding.workspaceId });
      }
      const current = validate(binding); const currentAttempt = engine.getAttempt(current.attemptId)!;
      if (currentAttempt.status === 'leased') {
        if (currentAttempt.leaseOwner !== options.ownerId) throw new Error('Product lease is owned by another host');
        return current;
      }
      const lease = engine.reattachAttempt({ jobId: current.jobId, attemptId: current.attemptId,
        generation: current.generation, fenceToken: current.fenceToken, ownerId: options.ownerId, ttlMs: LEASE_TTL_MS });
      if (!lease.acquired || lease.generation !== current.generation || lease.fenceToken !== current.fenceToken) throw new Error(`Product continuation could not reattach: ${lease.conflict ?? 'unknown conflict'}`);
      return validate(current);
    },
    release,
    getJob: (jobId) => engine.getJob(jobId),
    getAttempt: (attemptId) => engine.getAttempt(attemptId),
    listJobs: () => engine.listJobs({ entryPoint }),
    retrieveLearning(input) {
      return learning.retrieve({ query: input.objective, scopes: [
        { kind: 'PROJECT', key: input.projectId, ownerId: input.ownerId, workspaceId: input.workspaceId },
        { kind: 'WORKSPACE', key: input.workspaceId, ownerId: input.ownerId, workspaceId: input.workspaceId },
        { kind: 'USER_GLOBAL', key: input.ownerId, ownerId: input.ownerId, workspaceId: null },
      ], limit: Math.max(1, Math.min(8, input.limit ?? 5)), maxChars: 1_500,
      types: ['USER_PREFERENCE', 'USER_CORRECTION'] });
    },
    close: () => closeDaemonDb(databasePath),
  };
}
