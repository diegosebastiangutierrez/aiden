/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createActionAuthority,
  normalizeExecutionPlan,
  type PolicySnapshotInput,
} from '../../../core/v4/actionAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ProcessRegistry } from '../../../core/v4/processRegistry';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { buildWorkbenchApprovalCallbacks } from '../../../core/v4/workbench/approvalBridge';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { processSpawnTool } from '../../../tools/v4/process/processSpawn';

const POLICY: PolicySnapshotInput = {
  trustLevel: 'Partner',
  autonomyPolicy: 'runtime',
  approvalMode: 'smart',
  toolMetadataVersion: 'test',
  sandboxPolicy: {},
  networkPolicy: {},
  pluginGrants: [],
  mcpGrants: [],
  workspaceOverrides: {},
  jobOverrides: {},
};

describe('structured process durable authority', () => {
  let db: Database.Database;
  let root: string;
  let script: string;
  let processes: ProcessRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES ('instance-process', 1, 'test', 1, 1, 'test')`,
    ).run();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-process-authority-'));
    script = path.join(root, 'local-task.mjs');
    fs.writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('started.json', String(process.pid));\n",
      'utf8',
    );
    processes = new ProcessRegistry();
  });

  afterEach(() => {
    processes.cleanup();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runningJob(key: string) {
    const engine = createJobEngine({ db });
    const admission = engine.submitJob({
      entryPoint: 'test',
      source: 'test',
      sessionId: 'session-process',
      instanceId: 'instance-process',
      idempotencyNamespace: 'test',
      idempotencyKey: key,
      goal: 'run one approved local process',
    });
    const lease = engine.claimAttempt({
      attemptId: admission.attemptId,
      ownerId: 'test',
      ttlMs: 60_000,
    });
    const attempt = engine.transitionAttempt({
      attemptId: admission.attemptId,
      expectedStateVersion: lease.stateVersion!,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      to: 'running',
      eventIdempotencyKey: `${key}:attempt-running`,
      producer: 'test',
    });
    expect(attempt.applied).toBe(true);
    const job = engine.transitionJob({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      expectedStateVersion: 0,
      to: 'running',
      eventIdempotencyKey: `${key}:job-running`,
      producer: 'test',
    });
    expect(job.applied).toBe(true);
    return { engine, admission, lease };
  }

  function executor(
    engine: ReturnType<typeof createJobEngine>,
    actionAuthority: ReturnType<typeof createActionAuthority>,
    approvalEngine: ApprovalEngine,
  ) {
    const registry = new ToolRegistry();
    registry.register(withBuiltInEffectContract(processSpawnTool));
    return registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
      processes,
      actionAuthority,
      approvalEngine,
      policySnapshot: POLICY,
      sessionId: 'session-process',
    });
  }

  it('launches only after exact durable approval and binds the process to its Job identity', async () => {
    const { engine, admission, lease } = runningJob('approved-process');
    const actionAuthority = createActionAuthority({ db, jobEngine: engine });
    const approvalCallbacks = buildWorkbenchApprovalCallbacks({
      authority: actionAuthority,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      pollIntervalMs: 1,
      timeoutMs: 2_000,
    });
    const execute = executor(engine, actionAuthority, new ApprovalEngine('smart', approvalCallbacks));

    const pendingResult = runWithJobExecutionContext({
      engine,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      producer: 'test',
      workspacePath: root,
    }, () => execute({
      id: 'process-call-approved',
      name: 'process_spawn',
      arguments: { runtime: 'node', executable: process.execPath, script, args: [], cwd: root },
    }));

    await vi.waitFor(() => expect(actionAuthority.listPending(admission.jobId)).toHaveLength(1));
    const requested = actionAuthority.listPending(admission.jobId)[0]!;
    expect(requested.state).toBe('displayed');
    actionAuthority.decide({
      approvalId: requested.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      actionDigest: requested.actionDigest,
      policySnapshotId: requested.policySnapshotId,
      decision: 'approved',
      decisionScope: 'once',
      decidedBy: 'test',
      decisionChannel: 'workbench',
    });
    const result = await pendingResult;

    expect(result.error).toBeUndefined();
    const processResult = result.result as { id: string; pid: number };
    const handle = await processes.waitFor(processResult.id, 5_000);
    expect(handle.pid).toBe(processResult.pid);
    expect(handle.status).toBe('exited');
    expect(fs.readFileSync(path.join(root, 'started.json'), 'utf8')).toBe(String(processResult.pid));

    const approval = db.prepare(
      `SELECT state, job_id, attempt_id, generation, tool_call_id, normalized_execution_plan
         FROM approvals`,
    ).get() as {
      state: string;
      job_id: string;
      attempt_id: string;
      generation: number;
      tool_call_id: string;
      normalized_execution_plan: string;
    };
    expect(approval).toMatchObject({
      state: 'executed',
      job_id: admission.jobId,
      attempt_id: admission.attemptId,
      generation: lease.generation,
      tool_call_id: expect.stringMatching(/^tool-call:sha256:/u),
    });
    expect(JSON.parse(approval.normalized_execution_plan)).toMatchObject({
      executable: fs.realpathSync.native(process.execPath),
      args: { runtime: 'node', executable: process.execPath, script, args: [], cwd: root },
      cwd: fs.realpathSync.native(root),
      shell: null,
    });
  });

  it.each([
    {
      label: 'arguments',
      change: (base: Record<string, unknown>) => ({ ...base, args: ['changed-after-approval'] }),
    },
    {
      label: 'executable',
      change: (base: Record<string, unknown>) => ({ ...base, executable: path.join(root, 'different-node.exe') }),
    },
  ])('rejects changed $label after approval before execution', ({ label, change }) => {
    const { engine, admission, lease } = runningJob(`changed-process-${label}`);
    const authority = createActionAuthority({ db, jobEngine: engine });
    const baseArgs = { runtime: 'node', executable: process.execPath, script, args: [], cwd: root };
    const approved = normalizeExecutionPlan({
      toolName: 'process_spawn',
      args: baseArgs,
      cwd: root,
      mutates: true,
      riskTier: 'dangerous',
      policy: POLICY,
    });
    const record = authority.request({
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      toolCallId: `process-call-changed-${label}`,
      effectId: null,
      toolName: 'process_spawn',
      riskTier: 'dangerous',
      riskReasons: ['local process execution'],
      normalized: approved,
    });
    authority.markDisplayed(record.approvalId);
    authority.decide({
      approvalId: record.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      actionDigest: approved.actionDigest,
      policySnapshotId: approved.policySnapshot.policySnapshotId,
      decision: 'approved',
      decidedBy: 'test',
      decisionChannel: 'test',
    });

    const changed = normalizeExecutionPlan({
      toolName: 'process_spawn',
      args: change(baseArgs),
      cwd: root,
      mutates: true,
      riskTier: 'dangerous',
      policy: POLICY,
    });
    const authorization = authority.authorizeExecution({
      approvalId: record.approvalId,
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation!,
      fenceToken: lease.fenceToken!,
      toolCallId: `process-call-changed-${label}`,
      effectId: null,
      actionDigest: changed.actionDigest,
      policySnapshotId: changed.policySnapshot.policySnapshotId,
    });

    expect(authorization).toMatchObject({ authorized: false, reason: expect.stringContaining('binding mismatch') });
    expect(authority.get(record.approvalId)?.state).toBe('invalidated');
    expect(fs.existsSync(path.join(root, 'started.json'))).toBe(false);
  });

  it('rejects a stale Attempt generation after approval', () => {
    const { engine, admission, lease } = runningJob('stale-process-attempt');
    const authority = createActionAuthority({ db, jobEngine: engine });
    const args = { runtime: 'node', executable: process.execPath, script, args: [], cwd: root };
    const normalized = normalizeExecutionPlan({
      toolName: 'process_spawn', args, cwd: root, mutates: true, riskTier: 'dangerous', policy: POLICY,
    });
    const record = authority.request({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
      fenceToken: lease.fenceToken!, toolCallId: 'process-call-stale', effectId: null,
      toolName: 'process_spawn', riskTier: 'dangerous', riskReasons: ['local process execution'], normalized,
    });
    authority.markDisplayed(record.approvalId);
    authority.decide({
      approvalId: record.approvalId, jobId: admission.jobId, attemptId: admission.attemptId,
      generation: lease.generation!, actionDigest: normalized.actionDigest,
      policySnapshotId: normalized.policySnapshot.policySnapshotId, decision: 'approved',
      decidedBy: 'test', decisionChannel: 'test',
    });

    const authorization = authority.authorizeExecution({
      approvalId: record.approvalId, jobId: admission.jobId, attemptId: admission.attemptId,
      generation: lease.generation! + 1, fenceToken: lease.fenceToken!, toolCallId: 'process-call-stale',
      effectId: null, actionDigest: normalized.actionDigest,
      policySnapshotId: normalized.policySnapshot.policySnapshotId,
    });

    expect(authorization).toMatchObject({ authorized: false, reason: expect.stringContaining('stale') });
    expect(authority.get(record.approvalId)?.state).toBe('invalidated');
    expect(fs.existsSync(path.join(root, 'started.json'))).toBe(false);
  });
});
