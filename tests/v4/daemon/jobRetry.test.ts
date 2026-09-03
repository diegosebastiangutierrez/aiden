/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LATEST_SCHEMA_VERSION, MIGRATIONS_FOR_TESTS, runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createActionAuthority, normalizeExecutionPlan, type PolicySnapshotInput } from '../../../core/v4/actionAuthority';
import {
  RetryNotAllowedError,
  createJobEngine,
  type AdmissionResult,
  type JobEngine,
} from '../../../core/v4/daemon/jobEngine';

describe('durable terminal Job retry authority', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('retry_test', 1, 'localhost', ?, ?, '4.21.0')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  function submit(key = 'original'): AdmissionResult {
    return engine.submitJob({
      entryPoint: 'workbench', source: 'workbench', sessionId: 'retry-session',
      workspaceId: 'C:\\fixture\\workspace', principalId: 'owner-1', instanceId: 'retry_test',
      idempotencyNamespace: 'retry-fixture', idempotencyKey: key,
      requestFingerprint: key, goal: 'Run the original user request',
      resourcePolicy: {
        budgets: { tool_calls: 8, runtime_ms: 60_000 },
        capabilities: { tools: ['file_read', 'process_spawn'], paths: ['C:\\fixture\\workspace'] },
      },
    });
  }

  function claim(admission: AdmissionResult, ownerId = 'worker-original') {
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId, ttlMs: 60_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined || lease.stateVersion === undefined) {
      throw new Error('test lease unavailable');
    }
    return lease as Required<Pick<typeof lease, 'fenceToken' | 'generation' | 'stateVersion'>> & typeof lease;
  }

  function finish(admission: AdmissionResult, attemptStatus: 'succeeded' | 'failed' | 'timed_out'): string {
    const lease = claim(admission);
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion,
      generation: lease.generation, fenceToken: lease.fenceToken, to: 'running',
      eventIdempotencyKey: `${admission.jobId}:attempt-running`, producer: 'test',
    });
    engine.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, expectedStateVersion: 0,
      generation: lease.generation, fenceToken: lease.fenceToken, to: 'running',
      eventIdempotencyKey: `${admission.jobId}:job-running`, producer: 'test',
    });
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: 2,
      generation: lease.generation, fenceToken: lease.fenceToken, to: attemptStatus,
      finishReason: attemptStatus, eventIdempotencyKey: `${admission.jobId}:attempt-terminal`, producer: 'test',
    });
    const status = attemptStatus === 'succeeded' ? 'completed' : 'failed';
    expect(engine.finalizeJob({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, expectedStateVersion: 1, status,
      outcome: attemptStatus === 'succeeded' ? 'completed' : attemptStatus,
      finishReason: attemptStatus, evidence: {},
      eventIdempotencyKey: `${admission.jobId}:job-terminal`, producer: 'test',
    }).applied).toBe(true);
    return lease.fenceToken;
  }

  function cancel(admission: AdmissionResult, existingFence?: string): string {
    const fenceToken = existingFence ?? claim(admission).fenceToken;
    expect(engine.cancelJob({
      jobId: admission.jobId, reason: 'stopped safely', producer: 'test',
      eventIdempotencyKey: `${admission.jobId}:cancelled`,
    }).applied).toBe(true);
    return fenceToken;
  }

  function retry(originalJobId: string, key = 'retry-1') {
    return engine.retryJob({
      originalJobId, instanceId: 'retry_test', idempotencyNamespace: 'job-retry',
      idempotencyKey: key, producer: 'workbench',
    });
  }

  it('migrates a durable indexed retry lineage field from the prior schema', () => {
    const legacy = new Database(':memory:');
    try {
      for (const migration of MIGRATIONS_FOR_TESTS.filter((item) => item.version <= 55)) {
        if (migration.sql) legacy.exec(migration.sql);
        else migration.apply?.(legacy);
        legacy.prepare(
          `INSERT INTO schema_version (id, version, applied_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version=excluded.version, applied_at=excluded.applied_at`,
        ).run(migration.version, Date.now());
      }
      expect(runMigrations(legacy)).toEqual({ from: 55, to: LATEST_SCHEMA_VERSION });
      expect((legacy.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
        .some((column) => column.name === 'retry_of_job_id')).toBe(true);
      expect((legacy.prepare("PRAGMA index_list('tasks')").all() as Array<{ name: string }>)
        .some((index) => index.name === 'idx_tasks_retry_origin')).toBe(true);
    } finally {
      legacy.close();
    }
  });

  it('retries a cancelled Job as one new Job with new Attempt, fence, and durable lineage', () => {
    const original = submit();
    const oldFence = cancel(original);
    const immutableOriginal = engine.getJob(original.jobId);
    const originalEvents = engine.listEvents(original.jobId);

    const created = retry(original.jobId);
    const newJob = engine.getJob(created.jobId);
    const newAttempt = engine.getAttempt(created.attemptId);
    const newLease = claim(created, 'worker-retry');

    expect(created).toMatchObject({ originalJobId: original.jobId, reused: false });
    expect(created.jobId).not.toBe(original.jobId);
    expect(created.attemptId).not.toBe(original.attemptId);
    expect(newJob).toMatchObject({
      retryOfJobId: original.jobId, status: 'queued', parentJobId: null,
      sessionId: 'retry-session', workspaceId: 'C:\\fixture\\workspace',
    });
    expect(newAttempt).toMatchObject({ generation: 1, attemptNumber: 1, fenceToken: null });
    expect(newLease.fenceToken).not.toBe(oldFence);
    expect(engine.getJob(original.jobId)).toEqual(immutableOriginal);
    expect(engine.listEvents(original.jobId)).toEqual(originalEvents);
    expect(engine.listEvents(created.jobId).map((event) => event.type)).toEqual([
      'job.submitted', 'attempt.created', 'job.retried', 'attempt.leased',
    ]);
  });

  it.each([
    ['failed', 'failed'] as const,
    ['timed out', 'timed_out'] as const,
  ])('creates a new Job when the original %s safely', (_label, terminal) => {
    const original = submit(`original-${terminal}`);
    finish(original, terminal);
    const created = retry(original.jobId, `retry-${terminal}`);
    expect(created.jobId).not.toBe(original.jobId);
    expect(engine.getJob(created.jobId)?.retryOfJobId).toBe(original.jobId);
    expect(engine.getJob(original.jobId)?.status).toBe('failed');
  });

  it('lets the new Job complete without changing the cancelled original', () => {
    const original = submit('retry-success');
    cancel(original);
    const created = retry(original.jobId, 'retry-success-action');

    finish(created, 'succeeded');

    expect(engine.getJob(original.jobId)).toMatchObject({ status: 'cancelled', terminalOutcome: 'cancelled' });
    expect(engine.getJob(created.jobId)).toMatchObject({
      status: 'completed', terminalOutcome: 'completed', retryOfJobId: original.jobId,
    });
    expect(engine.listAttempts(original.jobId)).toHaveLength(1);
    expect(engine.listAttempts(created.jobId)).toHaveLength(1);
  });

  it('rejects completed and nonterminal Jobs without altering either record', () => {
    const completed = submit('completed');
    finish(completed, 'succeeded');
    const queued = submit('queued');

    expect(() => retry(completed.jobId, 'retry-completed')).toThrowError(RetryNotAllowedError);
    expect(() => retry(queued.jobId, 'retry-queued')).toThrowError(RetryNotAllowedError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
  });

  it('blocks retry while a consequential Effect requires reconciliation', () => {
    const original = submit('unknown-effect');
    const lease = claim(original);
    expect(engine.prepareToolCall({
      toolCallId: 'unknown-effect-call', jobId: original.jobId, attemptId: original.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken, toolName: 'file_write',
      normalizedArgsDigest: 'digest', riskTier: 'caution', mutates: true,
      effect: {
        classification: 'reconcilable_mutation', kind: 'filesystem.write', target: 'C:/fixture/workspace/result.txt',
        retrySafety: 'reconcile_before_retry', idempotencySupported: true, idempotencyKey: 'effect-key',
        reconciliationSupported: true, verificationSupported: true, approvalRequirement: 'policy',
        approvalState: 'not_required', sensitiveFields: [], redactionRules: [], trusted: true,
      },
      producer: 'test',
    }).applied).toBe(true);
    expect(engine.startToolCall({
      toolCallId: 'unknown-effect-call', attemptId: original.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken, producer: 'test',
    }).applied).toBe(true);
    expect(engine.completeToolCall({
      toolCallId: 'unknown-effect-call', attemptId: original.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken,
      state: 'unknown', sideEffectState: 'unknown', producer: 'test',
    }).applied).toBe(true);
    cancel(original, lease.fenceToken);

    expect(() => retry(original.jobId, 'retry-unknown-effect')).toThrowError(
      expect.objectContaining({ reason: 'reconciliation_required' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  });

  it('is idempotent across double-click, engine reopen, and terminal retry settlement', () => {
    const original = submit('idempotent');
    cancel(original);
    const first = retry(original.jobId, 'same-retry-action');
    const doubleClick = retry(original.jobId, 'same-retry-action');
    const reopened = createJobEngine({ db }).retryJob({
      originalJobId: original.jobId, instanceId: 'retry_test', idempotencyNamespace: 'job-retry',
      idempotencyKey: 'same-retry-action', producer: 'workbench',
    });
    cancel(first);
    const refreshAfterSettlement = retry(original.jobId, 'same-retry-action');

    expect(doubleClick).toEqual({ ...first, reused: true });
    expect(reopened).toEqual({ ...first, reused: true });
    expect(refreshAfterSettlement).toEqual({ ...first, reused: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
  });

  it('does not copy approvals, effects, Evidence, Artifacts, or stale authority to the retry', () => {
    const original = submit('isolated-authority');
    cancel(original);
    db.prepare("UPDATE tasks SET artifact_ids='[\"artifact_old\"]', evidence='old-evidence' WHERE id=?")
      .run(original.jobId);
    const created = retry(original.jobId, 'isolated-retry');
    const task = db.prepare(
      'SELECT artifact_ids, evidence, policy_snapshot_id FROM tasks WHERE id=?',
    ).get(created.jobId) as { artifact_ids: string; evidence: string | null; policy_snapshot_id: string | null };

    expect(task).toEqual({ artifact_ids: '[]', evidence: null, policy_snapshot_id: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE job_id=?').get(created.jobId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM side_effect_ledger WHERE job_id=?').get(created.jobId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_evidence WHERE job_id=?').get(created.jobId)).toEqual({ count: 0 });
  });

  it('cannot use an approval bound to the original Job to authorize the retry', () => {
    const original = submit('stale-approval');
    const oldLease = claim(original);
    const actions = createActionAuthority({ db, jobEngine: engine });
    const policy: PolicySnapshotInput = {
      trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'smart',
      toolMetadataVersion: 'retry-test', sandboxPolicy: { roots: ['C:/fixture/workspace'], deny: [] },
      networkPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
    };
    const normalized = normalizeExecutionPlan({
      toolName: 'file_write', args: { path: 'C:/fixture/workspace/result.txt', content: 'safe' },
      cwd: 'C:/fixture/workspace', mutates: true, riskTier: 'dangerous', policy,
    });
    const approval = actions.request({
      jobId: original.jobId, attemptId: original.attemptId, generation: oldLease.generation,
      fenceToken: oldLease.fenceToken, toolCallId: 'old-tool-call', toolName: 'file_write',
      riskTier: 'dangerous', riskReasons: ['filesystem write'], normalized,
    });
    actions.decide({
      approvalId: approval.approvalId, jobId: original.jobId, attemptId: original.attemptId,
      generation: oldLease.generation, actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId, decision: 'approved', decidedBy: 'user', decisionChannel: 'test',
    });
    cancel(original, oldLease.fenceToken);
    const created = retry(original.jobId, 'retry-after-approval');
    const newLease = claim(created, 'worker-new');

    expect(actions.authorizeExecution({
      approvalId: approval.approvalId, jobId: created.jobId, attemptId: created.attemptId,
      generation: newLease.generation, fenceToken: newLease.fenceToken,
      toolCallId: 'old-tool-call', effectId: null, actionDigest: normalized.actionDigest,
      policySnapshotId: approval.policySnapshotId,
    })).toMatchObject({ authorized: false });
    expect(actions.listPending(created.jobId)).toEqual([]);
  });

  it('preserves the original workspace and capability envelope without accepting caller overrides', () => {
    const original = submit('capabilities');
    cancel(original);
    const created = retry(original.jobId, 'capability-retry');

    expect(engine.getJob(created.jobId)?.workspaceId).toBe('C:\\fixture\\workspace');
    expect(engine.resources.getBudgets(created.jobId)).toMatchObject([
      { kind: 'runtime_ms', limit: 60_000, used: 0 },
      { kind: 'tool_calls', limit: 8, used: 0 },
    ]);
    expect(engine.resources.authorize({ jobId: created.jobId, kind: 'tool', value: 'file_read' })).toBe(true);
    expect(engine.resources.authorize({ jobId: created.jobId, kind: 'tool', value: 'file_write' })).toBe(false);
    expect(engine.resources.authorize({ jobId: created.jobId, kind: 'path', value: 'C:\\other' })).toBe(false);
  });
});
