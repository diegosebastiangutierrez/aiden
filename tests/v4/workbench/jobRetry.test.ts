/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import Database from 'better-sqlite3';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    let selectedBinding = { provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default' as const };
    const jobEngine = createJobEngine({ db });
    const runStore = createRunStore({ db });
    const triggerBus = createTriggerBus({ db });
    const value = createWorkbenchJobCommands({
      db, jobEngine, runStore, triggerBus, instanceId: 'workbench_retry',
      workspacePath: 'C:\\fixture\\workspace', idFactory: () => 'fixed-command-key',
      resolveModelBinding: () => selectedBinding,
      validateModelBinding: async (binding) => {
        if (binding.provider !== selectedBinding.provider || binding.model !== selectedBinding.model) {
          throw new Error('The selected provider/model is not available or configured.');
        }
      },
    });
    return {
      ...value, jobEngine, runStore, triggerBus,
      selectModel(provider: string, model: string) {
        selectedBinding = { provider, model, source: 'session' };
      },
    };
  }

  it('preserves approved browser scope on a new Retry Job without reusing prior evidence', async () => {
    const value = fixture();
    const browserCheck = { version: 1, customerId: 'sample', specDigest: 'a'.repeat(64),
      origin: 'http://127.0.0.1:8523', allowLoopback: true, mutationPaths: ['/save'],
      observations: [{ id: 'saved', flowId: 'form', selector: '#result', kind: 'text', expected: 'Saved' }] };
    const original = value.enqueue.enqueue({ message: 'Check approved form', browserCheck, idempotencyKey: 'check-original' });
    value.cancel.cancel(original.runId);
    const retried = await value.retry.retry(original.runId, 'check-retry');
    expect(value.jobEngine.listEvents(retried.jobId).filter(event => event.type === 'browser.check.bound'))
      .toEqual([expect.objectContaining({ payload: browserCheck })]);
    expect(value.jobEngine.proof.listClaims(retried.jobId)).toEqual([expect.objectContaining({
      attemptId: retried.attemptId, required: true, state: 'unverified' })]);
    expect(value.jobEngine.proof.listEvidence(retried.jobId)).toHaveLength(0);
    expect(value.jobEngine.getJob(original.jobId)?.status).toBe('cancelled');
  });

  it('retries exact Workbench intent as a new Job and preserves provider, workspace, and history truth', async () => {
    const value = fixture();
    const prompt = 'Run a harmless long operation, then report the verified result.';
    const original = value.enqueue.enqueue({ message: prompt, sessionId: 'retry-session' });
    expect(value.cancel.cancel(original.runId).accepted).toBe(true);

    const retried = await value.retry.retry(original.runId);
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

  it('binds an explicit selected provider and model only to the new Retry Job', async () => {
    const value = fixture();
    const prompt = 'Run the approved operation and report the verified result.';
    const original = value.enqueue.enqueue({ message: prompt, sessionId: 'override-session' });
    const originalLease = value.jobEngine.claimAttempt({
      attemptId: original.attemptId, ownerId: 'original-owner', ttlMs: 30_000,
    });
    expect(originalLease).toMatchObject({ acquired: true, generation: 1, fenceToken: expect.any(String) });
    value.cancel.cancel(original.runId);
    value.selectModel('chatgpt-plus', 'gpt-5.6-luna');

    const retried = await value.retry.retry(original.runId, 'retry-with-selected', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });
    const retryLease = value.jobEngine.claimAttempt({
      attemptId: retried.attemptId, ownerId: 'retry-owner', ttlMs: 30_000,
    });
    const originalTrigger = value.triggerBus.get(original.triggerEventId)!;
    const retryTrigger = value.triggerBus.get(retried.triggerEventId)!;

    expect(value.jobEngine.getJob(original.jobId)).toMatchObject({
      id: original.jobId, status: 'cancelled', activeAttemptId: null, retryOfJobId: null,
    });
    expect(originalTrigger.payload.model_binding).toEqual({
      provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default',
    });
    expect(value.jobEngine.getJob(retried.jobId)).toMatchObject({
      id: retried.jobId, status: 'queued', retryOfJobId: original.jobId,
    });
    expect(retryTrigger.payload.model_binding).toEqual({
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session',
    });
    expect(retried).toMatchObject({
      accepted: true,
      originalJobId: original.jobId,
      modelBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
    });
    expect(retried.jobId).not.toBe(original.jobId);
    expect(retried.attemptId).not.toBe(original.attemptId);
    expect(retried.generation).toBe(1);
    expect(retryLease).toMatchObject({ acquired: true, generation: 1, fenceToken: expect.any(String) });
    expect(retryLease.fenceToken).not.toBe(originalLease.fenceToken);
  });

  it('rejects an unavailable explicit provider or model without admitting fallback work', async () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Retry only with the requested configured model.' });
    value.cancel.cancel(original.runId);

    await expect(value.retry.retry(original.runId, 'invalid-override', {
      provider: 'unavailable-provider', model: 'missing-model',
    })).rejects.toThrow(/not available|not configured|selected provider|explicit Workbench selection/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trigger_events WHERE source_key LIKE 'workbench-retry:%'").get())
      .toEqual({ count: 0 });
    expect(value.jobEngine.getJob(original.jobId)?.status).toBe('cancelled');
  });

  it('rejects reuse of one Retry request identity with a different model selection', async () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Retry once under the exact selected model.' });
    value.cancel.cancel(original.runId);
    value.selectModel('chatgpt-plus', 'gpt-5.6-luna');
    const first = await value.retry.retry(original.runId, 'one-retry-identity', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });
    value.selectModel('chatgpt-plus', 'gpt-5.5');

    await expect(value.retry.retry(original.runId, 'one-retry-identity', {
      provider: 'chatgpt-plus', model: 'gpt-5.5',
    })).rejects.toThrow(/different provider\/model selection/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
    expect(value.triggerBus.get(first.triggerEventId)?.payload.model_binding).toMatchObject({
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });
  });

  it('reopens immutable original and overridden Retry model truth from durable trigger events', async () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Preserve both durable model bindings.', sessionId: 'durable-model-session' });
    value.cancel.cancel(original.runId);
    value.selectModel('chatgpt-plus', 'gpt-5.6-luna');
    const retried = await value.retry.retry(original.runId, 'durable-override', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });

    const reopened = createWorkbenchJobCommands({
      db, triggerBus: createTriggerBus({ db }), jobEngine: createJobEngine({ db }),
      runStore: createRunStore({ db }), instanceId: 'workbench_retry_reopened',
      workspacePath: 'C:\\fixture\\workspace',
      resolveModelBinding: () => ({ provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' }),
    });

    expect(reopened.retry.describe(original.runId)).toEqual({
      jobBinding: { provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default' },
      selectedBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
    });
    expect(reopened.retry.describe(retried.runId)).toEqual({
      jobBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
      selectedBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
    });
    expect(reopened.retry.describe(original.runId).jobBinding).not.toEqual(
      reopened.retry.describe(retried.runId).jobBinding,
    );
  });

  it('deduplicates double-click, network replay, refresh, and a reopened adapter', async () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Retry this exact task.' });
    value.cancel.cancel(original.runId);

    const first = await value.retry.retry(original.runId);
    const doubleClick = await value.retry.retry(original.runId);
    const reopened = createWorkbenchJobCommands({
      db, triggerBus: createTriggerBus({ db }), jobEngine: createJobEngine({ db }),
      runStore: createRunStore({ db }), instanceId: 'workbench_retry',
      workspacePath: 'C:\\fixture\\workspace',
    }).retry.retry(original.runId);

    expect(doubleClick).toEqual({ ...first, duplicate: true });
    await expect(reopened).resolves.toEqual({ ...first, duplicate: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM trigger_events WHERE source_key LIKE 'workbench-retry:%'").get())
      .toEqual({ count: 1 });
  });

  it('can cancel the retry and retry that new terminal Job without reopening either terminal record', async () => {
    const value = fixture();
    const original = value.enqueue.enqueue({ message: 'Repeat safely.' });
    value.cancel.cancel(original.runId);
    const second = await value.retry.retry(original.runId);
    value.cancel.cancel(second.runId);
    const third = await value.retry.retry(second.runId);

    expect(value.jobEngine.getJob(original.jobId)?.status).toBe('cancelled');
    expect(value.jobEngine.getJob(second.jobId)).toMatchObject({ status: 'cancelled', retryOfJobId: original.jobId });
    expect(value.jobEngine.getJob(third.jobId)).toMatchObject({ status: 'queued', retryOfJobId: second.jobId });
    expect(new Set([original.jobId, second.jobId, third.jobId]).size).toBe(3);
  });

  it('recovers the original conversation anchor for a retry created before anchor metadata existed', async () => {
    const value = fixture();
    const prompt = 'Run the same safe operation again.';
    const original = value.enqueue.enqueue({ message: prompt, sessionId: 'legacy-retry-session' });
    value.cancel.cancel(original.runId);
    const legacyRetry = await value.retry.retry(original.runId);
    value.cancel.cancel(legacyRetry.runId);

    const legacyTrigger = value.triggerBus.get(legacyRetry.triggerEventId)!;
    const legacyPayload = { ...legacyTrigger.payload };
    delete legacyPayload.conversation_anchor_trigger_event_id;
    db.prepare('UPDATE trigger_events SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyPayload), legacyRetry.triggerEventId);

    const retried = await value.retry.retry(legacyRetry.runId);
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

  function post(
    port: number,
    path: string,
    token: string,
    body: Record<string, unknown> = { idempotencyKey: 'retry:original' },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
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
      req.end(JSON.stringify(body));
    });
  }

  function get(port: number, path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'GET', headers: { 'x-workbench-token': token },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end();
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

  it('passes one explicit provider/model override through the token-gated retry boundary', async () => {
    const runStore = createRunStore({ db });
    const retry = vi.fn(async (runId: number, _idempotencyKey?: string, modelOverride?: { provider: string; model: string }) => ({
      accepted: true, duplicate: false, originalJobId: 'job_old', jobId: 'job_new',
      attemptId: 'attempt_new', runId: runId + 1, generation: 1, triggerEventId: 12,
      modelBinding: modelOverride ? { ...modelOverride, source: 'session' as const } : undefined,
    }));
    bridge = await startWorkbenchBridge({
      reader: runStore, token: 'local-token', port: 0, retry: { retry },
    });

    const accepted = await post(bridge.port, '/api/tasks/8/retry', 'local-token', {
      idempotencyKey: 'retry:selected',
      modelOverride: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna' },
    });
    expect(retry).toHaveBeenCalledWith(8, 'retry:selected', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });
    expect(accepted).toEqual({
      status: 202,
      body: expect.objectContaining({
        job_id: 'job_new',
        model_binding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
      }),
    });
  });

  it('projects the original and Retry provider/model that durable execution will use', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('workbench_retry_projection', 1, 'localhost', ?, ?, '4.21.0')`,
    ).run(now, now);
    let selected: { provider: string; model: string; source: 'default' | 'session' } = {
      provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default',
    };
    const jobEngine = createJobEngine({ db });
    const runStore = createRunStore({ db });
    const triggerBus = createTriggerBus({ db });
    const commands = createWorkbenchJobCommands({
      db, jobEngine, runStore, triggerBus, instanceId: 'workbench_retry_projection',
      resolveModelBinding: () => selected,
      validateModelBinding: async () => undefined,
    });
    const original = commands.enqueue.enqueue({ message: 'Project exact model truth.', sessionId: 'projection-session' });
    commands.cancel.cancel(original.runId);
    selected = { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' };
    const retried = await commands.retry.retry(original.runId, 'projection-retry', {
      provider: selected.provider, model: selected.model,
    });
    bridge = await startWorkbenchBridge({
      reader: runStore, jobs: jobEngine, retry: commands.retry, token: 'local-token', port: 0,
    });

    const originalProjection = await get(
      bridge.port,
      `/api/jobs/${original.jobId}/projection?attemptId=${original.attemptId}&runId=${original.runId}`,
      'local-token',
    );
    const retryProjection = await get(
      bridge.port,
      `/api/jobs/${retried.jobId}/projection?attemptId=${retried.attemptId}&runId=${retried.runId}`,
      'local-token',
    );
    expect(originalProjection).toMatchObject({
      status: 200,
      body: {
        modelBinding: { provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'default' },
        selectedModelBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
      },
    });
    expect(retryProjection).toMatchObject({
      status: 200,
      body: {
        modelBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
        selectedModelBinding: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna', source: 'session' },
      },
    });
  });
});
