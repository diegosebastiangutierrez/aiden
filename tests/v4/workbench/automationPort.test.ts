import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createWorkbenchAutomationPort } from '../../../core/v4/workbench/automationPort';

describe('Workbench reliable automation port', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => db.close());

  it('fails closed in Community without weakening safety capabilities', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('community'),
    });
    expect(port.snapshot().capability).toMatchObject({ available: false });
    expect(() => port.create({
      name: 'No', action: { kind: 'prompt', prompt: 'No' }, trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [], createdBy: 'test',
    })).toThrow(/Pro/);
  });

  it('creates, previews, pauses and manually enqueues without exposing credentials', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      workspaceRoot: process.cwd(),
    });
    const created = port.create({
      name: 'Daily', action: { kind: 'prompt', prompt: 'Summarize' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [], createdBy: 'test',
    });
    expect(port.preview({ expression: '0 9 * * *', timezone: 'Asia/Kolkata' })).toHaveLength(5);
    expect(port.runNow(created.automationId).triggerEventId).toBeGreaterThan(0);
    db.prepare(
      `INSERT INTO automation_occurrences (
         occurrence_id,occurrence_key,automation_id,revision_id,trigger_kind,source_identity,
         scheduled_for,triggered_at,admitted_at,state,created_at,updated_at
       ) VALUES ('occurrence_history','key-history',?,?, 'manual','manual-history',NULL,1000,NULL,'detected',1000,1000)`,
    ).run(created.automationId, created.revisionId);
    expect(port.setEnabled(created.automationId, false).enabled).toBe(false);
    const snapshot = port.snapshot();
    expect(snapshot.capability.visualWorkflows).toBe(true);
    expect(snapshot.automations).toHaveLength(1);
    expect(snapshot.history).toEqual([
      expect.objectContaining({
        occurrenceId: 'occurrence_history', automationId: created.automationId,
        revisionId: created.revisionId, triggeredAt: 1000, state: 'detected',
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/password|accessToken|secretHandle/i);
    const row = db.prepare(
      `SELECT r.spec_json FROM automation_revisions r
        JOIN automation_definitions d ON d.current_revision_id = r.revision_id
       WHERE d.automation_id = ?`,
    ).get(created.automationId) as { spec_json: string };
    expect(JSON.parse(row.spec_json)).toMatchObject({ workspace: { rootPath: process.cwd() } });
  });

  it('edits through a new immutable revision while preserving the automation identity', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      workspaceRoot: process.cwd(),
    });
    const created = port.create({
      name: 'Morning brief', createdBy: 'test',
      action: { kind: 'prompt', prompt: 'Original prompt' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'UTC' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [],
    });

    const revised = port.revise(created.automationId, {
      createdBy: 'workbench', action: { kind: 'prompt', prompt: 'Updated prompt' },
      trigger: { kind: 'schedule', expression: '0 10 * * *', timezone: 'Europe/Tallinn' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 2 } },
      capabilities: ['repository.read'], credentialRefs: [],
    });

    expect(revised).toMatchObject({ automationId: created.automationId, revisionNumber: 2 });
    expect(revised.revisionId).not.toBe(created.revisionId);
    expect(revised.action).toEqual({ kind: 'prompt', prompt: 'Updated prompt' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_revisions WHERE automation_id = ?').get(created.automationId)).toEqual({ count: 2 });
  });

  it('limits automation history and definitions to the authorized owner and workspace', () => {
    const triggerBus = createTriggerBus({ db });
    const first = createWorkbenchAutomationPort({
      db, triggerBus, edition: buildEditionAuthority('pro'),
      ownerId: 'owner-a', workspaceId: 'workspace-a', workspaceRoot: process.cwd(),
    });
    const second = createWorkbenchAutomationPort({
      db, triggerBus, edition: buildEditionAuthority('pro'),
      ownerId: 'owner-b', workspaceId: 'workspace-b', workspaceRoot: process.cwd(),
    });
    const spec = {
      action: { kind: 'prompt' as const, prompt: 'Summarize' }, trigger: { kind: 'manual' as const },
      policies: { misfire: { kind: 'skip' as const }, overlap: 'skip' as const, retry: { maxAttempts: 1 } },
      capabilities: [] as string[], credentialRefs: [] as string[], createdBy: 'test',
    };
    const visible = first.create({ ...spec, name: 'Visible' });
    const foreign = second.create({ ...spec, name: 'Foreign' });
    db.prepare(
      `INSERT INTO automation_occurrences (
         occurrence_id,occurrence_key,automation_id,revision_id,trigger_kind,source_identity,
         scheduled_for,triggered_at,state,created_at,updated_at
       ) VALUES ('occurrence_visible','visible',?,?,'manual','visible',NULL,1000,'completed',1000,1000),
                ('occurrence_foreign','foreign',?,?,'manual','foreign',NULL,1001,'failed',1001,1001)`,
    ).run(visible.automationId, visible.revisionId, foreign.automationId, foreign.revisionId);

    const snapshot = first.snapshot();
    expect(snapshot.automations.map((item) => item.automationId)).toEqual([visible.automationId]);
    expect(snapshot.history.map((item) => item.occurrenceId)).toEqual(['occurrence_visible']);
    expect(snapshot.attention).toEqual([]);
  });

  it('projects a required child execution from durable contract Verification and Evidence', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('automation-history-test',1,'localhost',?,?,'4.21.0')`).run(now, now);
    const jobs = createJobEngine({ db });
    const parent = jobs.submitJob({
      entryPoint: 'workbench', source: 'test', sessionId: 'parent-session',
      instanceId: 'automation-history-test', idempotencyNamespace: 'automation-history',
      idempotencyKey: 'parent', requestFingerprint: 'parent', goal: 'Run scheduled work',
      workspaceId: process.cwd(),
    });
    const child = jobs.submitJob({
      entryPoint: 'automation', source: 'test', sessionId: 'child-session',
      instanceId: 'automation-history-test', idempotencyNamespace: 'automation-history',
      idempotencyKey: 'child', requestFingerprint: 'child', goal: 'Verify repository state',
      workspaceId: process.cwd(), parentJobId: parent.jobId, rootJobId: parent.jobId,
      childContract: {
        required: true, workerId: 'scheduled-worker', capabilities: ['read'],
        allowedResources: { workspace: process.cwd() }, budget: { maxIterations: 1 },
      },
    });
    const lease = jobs.claimAttempt({ attemptId: child.attemptId, ownerId: 'test', ttlMs: 30_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('claim failed');
    jobs.transitionAttempt({
      attemptId: child.attemptId, expectedStateVersion: 1, generation: lease.generation,
      fenceToken: lease.fenceToken, to: 'running', eventIdempotencyKey: 'child-attempt-running', producer: 'test',
    });
    jobs.transitionJob({
      jobId: child.jobId, attemptId: child.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'child-job-running', producer: 'test',
    });
    const evidenceHandle = {
      tool: 'file_read', kind: 'path', value: 'package.json', verified: true, code: 'ok',
    };
    jobs.recordChildResult({
      childJobId: child.jobId, attemptId: child.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, status: 'completed',
      evidence: { v: 1, verdict: 'completed', handles: [evidenceHandle], failures: [] },
      evidenceHandles: [evidenceHandle],
      producer: 'test', idempotencyKey: 'child-result',
    });
    jobs.transitionAttempt({
      attemptId: child.attemptId, expectedStateVersion: 2, generation: lease.generation,
      fenceToken: lease.fenceToken, to: 'succeeded', eventIdempotencyKey: 'child-attempt-done', producer: 'test',
    });
    jobs.finalizeJob({
      jobId: child.jobId, attemptId: child.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, expectedStateVersion: 1, status: 'completed',
      outcome: 'completed', finishReason: 'done', evidence: { handles: [evidenceHandle] },
      eventIdempotencyKey: 'child-job-done', producer: 'test',
    });

    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      workspaceRoot: process.cwd(), jobs,
    });
    const automation = port.create({
      name: 'Verified schedule', createdBy: 'test', action: { kind: 'prompt', prompt: 'Verify state' },
      trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: ['repository.read'], credentialRefs: [],
    });
    db.prepare(
      `INSERT INTO automation_occurrences (
         occurrence_id,occurrence_key,automation_id,revision_id,trigger_kind,source_identity,
         scheduled_for,triggered_at,admitted_at,job_id,attempt_id,state,created_at,updated_at,terminal_at
       ) VALUES ('occurrence_verified','verified',?,?,'manual','verified',NULL,?,?,?,?,'completed',?,?,?)`,
    ).run(
      automation.automationId, automation.revisionId, now, now,
      child.jobId, child.attemptId, now, now, now,
    );

    expect(port.snapshot().history[0]).toMatchObject({
      occurrenceId: 'occurrence_verified',
      execution: {
        title: 'Verify repository state', status: 'completed', verification: 'verified',
        evidenceCount: 1, parentJobId: parent.jobId, required: true, cleanupState: 'settled',
      },
    });
  });

  it('reports scheduler readiness from the execution host instead of configuration alone', () => {
    let hostReady = false;
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      schedulerReady: () => hostReady,
    });

    expect(port.snapshot().scheduler).toMatchObject({
      ready: false,
      reason: 'Automation execution host is unavailable.',
    });

    hostReady = true;
    expect(port.snapshot().scheduler).toEqual({ ready: true, dueBindings: 0 });
  });

  it('distinguishes trigger admission from a terminal failed occurrence', async () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      schedulerReady: () => true,
    });
    const created = port.create({
      name: 'Observed run', createdBy: 'test', action: { kind: 'prompt', prompt: 'Run once' },
      trigger: { kind: 'manual' },
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [],
    });
    const queued = port.runNow(created.automationId);
    db.prepare(
      `INSERT INTO automation_occurrences (
         occurrence_id,occurrence_key,automation_id,revision_id,trigger_kind,source_identity,
         scheduled_for,triggered_at,trigger_event_id,state,created_at,updated_at,terminal_at
       ) VALUES ('occurrence_failed','key-failed',?,?,'manual','manual-failed',NULL,1000,?,'failed',1000,1000,1000)`,
    ).run(created.automationId, created.revisionId, queued.triggerEventId);

    await expect(port.waitForRun(queued.triggerEventId, { timeoutMs: 0 })).resolves.toMatchObject({
      triggerEventId: queued.triggerEventId,
      settled: true,
      state: 'failed',
      occurrenceId: 'occurrence_failed',
      jobId: null,
    });
  });

  it('removes an automation from active control while retaining its durable history', () => {
    const port = createWorkbenchAutomationPort({
      db, triggerBus: createTriggerBus({ db }), edition: buildEditionAuthority('pro'),
      workspaceRoot: process.cwd(),
    });
    const created = port.create({
      name: 'Temporary acceptance automation', createdBy: 'test',
      action: { kind: 'prompt', prompt: 'Return AUTOMATION_OK.' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      policies: { misfire: { kind: 'run_once' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      capabilities: [], credentialRefs: [],
    });
    db.prepare(
      `INSERT INTO automation_occurrences (
         occurrence_id,occurrence_key,automation_id,revision_id,trigger_kind,source_identity,
         scheduled_for,triggered_at,admitted_at,state,created_at,updated_at
       ) VALUES ('occurrence_removed','key-removed',?,?,'manual','manual-removed',NULL,1000,NULL,'completed',1000,1000)`,
    ).run(created.automationId, created.revisionId);

    expect(port.remove(created.automationId, 'test', 2_000)).toEqual({
      automationId: created.automationId,
      removedAt: 2_000,
      removedBy: 'test',
    });
    const snapshot = port.snapshot();
    expect(snapshot.automations).toEqual([]);
    expect(snapshot.history).toEqual([
      expect.objectContaining({
        occurrenceId: 'occurrence_removed',
        automationId: created.automationId,
        state: 'completed',
      }),
    ]);
    expect(db.prepare(
      'SELECT enabled,removed_at,removed_by FROM automation_definitions WHERE automation_id = ?',
    ).get(created.automationId)).toEqual({ enabled: 0, removed_at: 2_000, removed_by: 'test' });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM automation_trigger_bindings WHERE automation_id = ? AND enabled = 1',
    ).get(created.automationId)).toEqual({ count: 0 });
    expect(() => port.setEnabled(created.automationId, true)).toThrow(/removed/i);
  });
});
