/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import Database from 'better-sqlite3';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { sweepDurableJobRecovery } from '../../../core/v4/daemon/jobRecoverySweep';
import { createWorkbenchAutomationPort } from '../../../core/v4/workbench/automationPort';
import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';
import { projectWorkbenchJob } from '../../../core/v4/workbench/projection';
import { presentResult } from '../../../dashboard-next/lib/workbenchPresentation';

describe('historical denied Automation recovery', () => {
  let db: Database.Database;
  let jobs: JobEngine;
  let root: string;
  let jobId: string;
  let attemptId: string;
  let originalEvents: unknown[];
  const port = () => createWorkbenchAutomationPort({ db, jobs, triggerBus: createTriggerBus({ db }),
    workspaceRoot: root, edition: buildEditionAuthority('pro') });
  const sweep = () => sweepDurableJobRecovery({ jobEngine: jobs, triggerBus: createTriggerBus({ db }),
    instanceId: 'recovery-test', producer: 'test-recovery' });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-denial-recovery-'));
    db = new Database(path.join(root, 'state.db'));
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.exec(`INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('recovery-test',1,'localhost',1,1,'4.21.0')`);
    jobs = createJobEngine({ db });
    const automation = port().create({ name: 'Required local output', action: { kind: 'prompt', prompt: 'Create the requested local output.' },
      trigger: { kind: 'manual' }, createdBy: 'test', capabilities: ['repository.write'], credentialRefs: [],
      policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } } });
    const admitted = jobs.submitJob({ entryPoint: 'automation', source: 'test', sessionId: 'historical-session', workspaceId: root,
      instanceId: 'recovery-test', idempotencyNamespace: 'test', idempotencyKey: 'denied', goal: 'Create local output',
      automationId: automation.automationId, automationRevisionId: automation.revisionId, automationOccurrenceId: 'historical-occurrence' });
    jobId = admitted.jobId; attemptId = admitted.attemptId;
    db.prepare(`INSERT INTO automation_occurrences (occurrence_id,occurrence_key,automation_id,revision_id,
      trigger_kind,source_identity,triggered_at,job_id,attempt_id,state,created_at,updated_at)
      VALUES ('historical-occurrence','history',?,?,'manual','test',1,?,?,'unknown',1,1)`)
      .run(automation.automationId, automation.revisionId, jobId, attemptId);
    const lease = jobs.claimAttempt({ attemptId, ownerId: 'test', ttlMs: 60_000 });
    const identity = { engine: jobs, jobId, attemptId, generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test' };
    const snapshot = await jobs.repository.captureSnapshot({ ...identity, requestedPath: root });
    const registry = new ToolRegistry(); registry.register(withBuiltInEffectContract(fileWriteTool));
    const execute = registry.buildExecutor({ cwd: root, paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
      repositoryChange: { authority: jobs.changes, rootPath: root, baseSnapshotId: snapshot.id },
      actionAuthority: createActionAuthority({ db, jobEngine: jobs }),
      approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'deny' }),
      policySnapshot: { trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
        toolMetadataVersion: 'test', sandboxPolicy: { roots: [root], deny: [] }, networkPolicy: {}, pluginGrants: [],
        mcpGrants: [], workspaceOverrides: {}, jobOverrides: {} } });
    await runWithJobExecutionContext(identity, () => execute({ id: 'required-output', name: 'file_write',
      arguments: { path: 'denied.txt', content: 'must not exist' } }));
    // Represent the older durable format: the denial was recorded, but no
    // execution receipt or terminal claim/Job settlement was persisted.
    db.prepare('DELETE FROM claim_evidence WHERE claim_id IN (SELECT claim_id FROM job_claims WHERE job_id=?)').run(jobId);
    db.prepare('DELETE FROM job_evidence WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM job_verdicts WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM effect_reconciliations WHERE job_id=?').run(jobId);
    db.prepare("DELETE FROM run_events WHERE job_id=? AND kind='effect.reconciled'").run(jobId);
    db.prepare("UPDATE job_claims SET state='unverified',checked_at=NULL WHERE job_id=?").run(jobId);
    db.prepare("UPDATE repository_change_intents SET state='planned' WHERE job_id=?").run(jobId);
    db.prepare("UPDATE tool_calls SET state='prepared',started_at=NULL,ended_at=NULL WHERE job_id=?").run(jobId);
    db.prepare("UPDATE side_effect_ledger SET status='requested',effect_state='requested',reconciliation_outcome=NULL,last_reconciled_at=NULL WHERE job_id=?").run(jobId);
    db.prepare("UPDATE runs SET status='unknown',ended_at=10,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE attempt_id=?").run(attemptId);
    db.prepare("UPDATE tasks SET status='unknown',terminal_at=NULL,terminal_outcome='unknown',finish_reason='verification_incomplete' WHERE id=?").run(jobId);
    originalEvents = db.prepare('SELECT * FROM run_events WHERE job_id=? ORDER BY id').all(jobId);
  });
  afterEach(async () => { if (db?.open) db.close(); await rm(root, { recursive: true, force: true }); });

  it.each([false, true])('settles an old denied occurrence without rewriting historical Proof (recorded=%s)', async (recorded) => {
    if (recorded) db.prepare(`INSERT INTO job_verdicts (job_id,attempt_id,generation,verdict,summary_json,finalized_at)
      VALUES (?,?,1,'unknown','{"requiredClaims":1,"verifiedClaims":0,"failedClaims":0,"unknownClaims":1}',10)`).run(jobId, attemptId);
    const originalProof = jobs.proof.getVerdict(jobId);
    expect(port().snapshot().history[0].execution).toMatchObject({ cleanupState: 'active', evidenceCount: 0 });
    db.close(); db = new Database(path.join(root, 'state.db')); jobs = createJobEngine({ db });
    expect(sweep().reconciled).toBe(1);
    expect(jobs.getJob(jobId)).toMatchObject({ status: 'failed', activeAttemptId: null, terminalOutcome: 'approval_denied' });
    expect(port().snapshot().history[0]).toMatchObject({ state: 'failed', execution: {
      status: 'failed', verification: recorded ? 'unknown' : 'not_recorded', evidenceCount: 0, cleanupState: 'settled' },
      detail: { reason: 'Required action denied; historical Evidence was not recorded.' } });
    expect(jobs.proof.listEvidence(jobId)).toEqual([]);
    expect(jobs.proof.getVerdict(jobId)).toEqual(originalProof);
    const projection = projectWorkbenchJob(jobs, { jobId })!;
    expect(projection.receipt).toMatchObject({ status: 'failed', terminal: true,
      summary: 'Required action was denied before execution. Historical Evidence was not recorded.' });
    expect(presentResult({ status: projection.receipt.status, verdict: projection.receipt.verdict?.verdict,
      summary: projection.receipt.summary, evidenceCount: 0 })).toMatchObject({ title: 'Failed', proofLabel: 'Evidence details unavailable' });
    expect(jobs.getAttempt(attemptId)?.status).toBe('unknown');
    expect(db.prepare('SELECT * FROM run_events WHERE job_id=? ORDER BY id').all(jobId).slice(0, originalEvents.length)).toEqual(originalEvents);
    const after = jobs.listEvents(jobId); const job = jobs.getJob(jobId); const history = port().snapshot().history;
    db.close(); db = new Database(path.join(root, 'state.db')); jobs = createJobEngine({ db });
    expect(sweep().reconciled).toBe(0);
    expect(jobs.getJob(jobId)).toEqual(job); expect(jobs.listEvents(jobId)).toEqual(after);
    expect(port().snapshot().history).toEqual(history);
    await expect(access(path.join(root, 'denied.txt'))).rejects.toThrow();
  });

  it('shows the historical reconciliation reason beside occurrence history', async () => {
    const source = await readFile(path.join(process.cwd(), 'dashboard-next/app/page.tsx'), 'utf8');
    const start = source.indexOf('snapshot.history.map((occurrence)');
    const history = source.slice(start, source.indexOf('occurrence.execution &&', start));
    expect(history).toMatch(/occurrence\.detail\.reason\s*&&\s*<[^>]+>\{occurrence\.detail\.reason\}/);
  });

  it.each(['lease','started','committed','approval-mismatch','optional','new-attempt','completed','process-tool','recorded-evidence'])
    ('does not infer settlement when durable facts are insufficient: %s', (condition) => {
      if (condition === 'lease') db.prepare('UPDATE runs SET lease_expires_at=? WHERE attempt_id=?').run(Date.now()+60_000,attemptId);
      if (condition === 'started') db.prepare("UPDATE tool_calls SET state='started',started_at=2 WHERE job_id=?").run(jobId);
      if (condition === 'committed') db.prepare("UPDATE side_effect_ledger SET effect_state='committed',confirmed_at=2 WHERE job_id=?").run(jobId);
      if (condition === 'approval-mismatch') db.prepare('UPDATE approvals SET generation=generation+1 WHERE job_id=?').run(jobId);
      if (condition === 'optional') db.prepare('UPDATE job_claims SET required=0 WHERE job_id=?').run(jobId);
      if (condition === 'new-attempt') db.prepare("UPDATE runs SET status='running' WHERE attempt_id=?").run(attemptId);
      if (condition === 'completed') db.prepare("UPDATE tasks SET status='completed',terminal_at=3,active_attempt_id=NULL WHERE id=?").run(jobId);
      if (condition === 'process-tool') db.prepare("UPDATE tool_calls SET tool_name='process_spawn' WHERE job_id=?").run(jobId);
      if (condition === 'recorded-evidence') db.prepare(`INSERT INTO job_evidence
        (evidence_id,job_id,attempt_id,generation,source,producer,captured_at,observed_at,integrity_sha256,coverage,verification_result,payload_json)
        VALUES ('existing',?,?,1,'test','test',1,1,'digest','partial','unknown','{}')`).run(jobId, attemptId);
      const before = jobs.getJob(jobId);
      const evidence = jobs.proof.listEvidence(jobId);
      sweep(); expect(jobs.getJob(jobId)).toEqual(before); expect(jobs.proof.listEvidence(jobId)).toEqual(evidence);
    });
});
