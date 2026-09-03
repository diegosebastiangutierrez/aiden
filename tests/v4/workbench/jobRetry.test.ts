/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { listWorkbenchActiveJobs } from '../../../core/v4/workbench/activeJobs';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
import { createWorkbenchJobCommands } from '../../../core/v4/workbench/jobCommands';
import { projectWorkbenchJob } from '../../../core/v4/workbench/projection';

describe('Workbench terminal Job retry adapter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('workbench_retry', 1, 'localhost', ?, ?, '4.21.0')`,
    ).run(now, now);
  });

  afterEach(() => db.close());

  function fixture() {
    const jobEngine = createJobEngine({ db });
    const runStore = createRunStore({ db });
    const triggerBus = createTriggerBus({ db });
    const value = createWorkbenchJobCommands({
      db, jobEngine, runStore, triggerBus, instanceId: 'workbench_retry',
      workspacePath: 'C:\\fixture\\workspace', idFactory: () => 'fixed-command-key',
      resolveModelBinding: () => ({ provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default' }),
    });
    return { ...value, jobEngine, runStore, triggerBus };
  }

  it('retries exact Workbench intent as a new Job and preserves provider, workspace, and history truth', () => {
    const value = fixture();
    const prompt = 'Run a harmless long operation, then report the verified result.';
    const original = value.enqueue.enqueue({ message: prompt, sessionId: 'retry-session' });
    expect(value.cancel.cancel(original.runId).accepted).toBe(true);

    const retried = value.retry.retry(original.runId);
    const originalJob = value.jobEngine.getJob(original.jobId)!;
    const retryJob = value.jobEngine.getJob(retried.jobId)!;
    const trigger = value.triggerBus.get(retried.triggerEventId)!;

    expect(retried).toMatchObject({
      accepted: true, duplicate: false, originalJobId: original.jobId,
      jobId: expect.not.stringMatching(new RegExp(`^${original.jobId}$`)),
      attemptId: expect.any(String), runId: expect.any(Number), generation: 1,
    });
    expect(originalJob).toMatchObject({ status: 'cancelled', activeAttemptId: null, retryOfJobId: null });
    expect(retryJob).toMatchObject({
      status: 'queued', retryOfJobId: original.jobId, sessionId: 'retry-session',
      workspaceId: 'C:\\fixture\\workspace', parentJobId: null,
    });
    expect(trigger.payload).toMatchObject({
      body: { prompt, source: 'workbench-retry' },
      sessionId: 'retry-session',
      retry_of_job_id: original.jobId,
      conversation_anchor_trigger_event_id: original.triggerEventId,
      model_binding: { provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default' },
      durable_job: { job_id: retried.jobId, attempt_id: retried.attemptId, run_id: retried.runId },
    });

    const history = value.jobEngine.listJobs({ sessionId: 'retry-session' });
    expect(history.map((job) => ({ id: job.id, status: job.status, retryOfJobId: job.retryOfJobId }))).toEqual([
      { id: original.jobId, status: 'cancelled', retryOfJobId: null },
      { id: retried.jobId, status: 'queued', retryOfJobId: original.jobId },
    ]);
    expect(projectWorkbenchJob(value.jobEngine, { jobId: original.jobId, attemptId: original.attemptId, runId: original.runId })?.receipt.status)
      .toBe('cancelled');
    expect(projectWorkbenchJob(value.jobEngine, { jobId: retried.jobId, attemptId: retried.attemptId, runId: retried.runId })?.job.retryOfJobId)
      .toBe(original.jobId);
    expect(listWorkbenchActiveJobs({ jobs: value.jobEngine, runs: value.runStore, triggers: value.triggerBus }))
      .toMatchObject([{ jobId: retried.jobId, status: 'queued', statusDetail: 'Queued for execution · Retried from previous run' }]);
  });

  it('deduplicates double-click, network replay, refresh, and a reopened adapter', () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Retry this exact task.' });
    value.cancel.cancel(original.runId);

    const first = value.retry.retry(original.runId);
    const doubleClick = value.retry.retry(original.runId);
    const reopened = createWorkbenchJobCommands({
      db, triggerBus: createTriggerBus({ db }), jobEngine: createJobEngine({ db }),
      runStore: createRunStore({ db }), instanceId: 'workbench_retry',
      workspacePath: 'C:\\fixture\\workspace',
    }).retry.retry(original.runId);

    expect(doubleClick).toEqual({ ...first, duplicate: true });
    expect(reopened).toEqual({ ...first, duplicate: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trigger_events WHERE source_key LIKE 'workbench-retry:%'").get())
      .toEqual({ count: 1 });
  });

  it('can cancel the retry and retry that new terminal Job without reopening either terminal record', () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Repeat safely.' });
    value.cancel.cancel(original.runId);
    const second = value.retry.retry(original.runId);
    value.cancel.cancel(second.runId);
    const third = value.retry.retry(second.runId);

    expect(value.jobEngine.getJob(original.jobId)?.status).toBe('cancelled');
    expect(value.jobEngine.getJob(second.jobId)).toMatchObject({ status: 'cancelled', retryOfJobId: original.jobId });
    expect(value.jobEngine.getJob(third.jobId)).toMatchObject({ status: 'queued', retryOfJobId: second.jobId });
    expect(new Set([original.jobId, second.jobId, third.jobId]).size).toBe(3);
  });

  it('recovers the original conversation anchor for a retry created before anchor metadata existed', () => {
    const value = fixture();
    const prompt = 'Run the same safe operation again.';
    const original = value.enqueue.enqueue({ message: prompt, sessionId: 'legacy-retry-session' });
    value.cancel.cancel(original.runId);
    const legacyRetry = value.retry.retry(original.runId);
    value.cancel.cancel(legacyRetry.runId);

    const legacyTrigger = value.triggerBus.get(legacyRetry.triggerEventId)!;
    const legacyPayload = { ...legacyTrigger.payload };
    delete legacyPayload.conversation_anchor_trigger_event_id;
    db.prepare('UPDATE trigger_events SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyPayload), legacyRetry.triggerEventId);

    const retried = value.retry.retry(legacyRetry.runId);
    expect(value.triggerBus.get(retried.triggerEventId)?.payload).toMatchObject({
      retry_of_job_id: legacyRetry.jobId,
      conversation_anchor_trigger_event_id: original.triggerEventId,
      body: { prompt },
    });
  });
});

describe('Workbench retry HTTP boundary', () => {
  let db: Database.Database;
  let bridge: WorkbenchBridge | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(async () => {
    if (bridge) await bridge.close();
    db.close();
  });

  function post(port: number, path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'x-workbench-token': token, 'content-type': 'application/json' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ idempotencyKey: 'retry:original' }));
    });
  }

  it('routes one token-gated retry action to the injected canonical adapter', async () => {
    const runStore = createRunStore({ db });
    bridge = await startWorkbenchBridge({
      reader: runStore, token: 'local-token', port: 0,
      retry: {
        retry: (runId, _idempotencyKey) => ({
          accepted: true, duplicate: false, originalJobId: 'job_old', jobId: 'job_new',
          attemptId: 'attempt_new', runId: runId + 1, generation: 1, triggerEventId: 12,
        }),
      },
    });

    const denied = await post(bridge.port, '/api/tasks/8/retry', 'wrong-token');
    const accepted = await post(bridge.port, '/api/tasks/8/retry', 'local-token');
    expect(denied.status).toBe(401);
    expect(accepted).toEqual({
      status: 202,
      body: expect.objectContaining({
        accepted: true, duplicate: false, original_job_id: 'job_old',
        job_id: 'job_new', attempt_id: 'attempt_new', run_id: 9, generation: 1,
      }),
    });
  });
});
