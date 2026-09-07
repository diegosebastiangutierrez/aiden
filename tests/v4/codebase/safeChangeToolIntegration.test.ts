/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';
import { filePatchTool } from '../../../tools/v4/files/filePatch';
import { fileMoveTool } from '../../../tools/v4/files/fileMove';
import { fileDeleteTool } from '../../../tools/v4/files/fileDelete';
import { fileReadTool } from '../../../tools/v4/files/fileRead';

describe('safe change file-tool integration', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;
  let context: ReturnType<typeof setup> extends Promise<infer T> ? T : never;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('change-integration',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-safe-tool-'));
    context = await setup();
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    const admission = engine.submitJob({
      entryPoint: 'test', source: 'unit', sessionId: 'safe-tool', workspaceId: root,
      instanceId: 'change-integration', idempotencyNamespace: 'safe-tool',
      idempotencyKey: path.basename(root), goal: 'write safely',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation: lease.generation!,
      fenceToken: lease.fenceToken!, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
      fenceToken: lease.fenceToken!, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'job-running', producer: 'test',
    });
    const snapshot = await engine.repository.captureSnapshot({
      jobId: admission.jobId, attemptId: admission.attemptId, generation: lease.generation!,
      fenceToken: lease.fenceToken!, requestedPath: root, producer: 'test',
    });
    const registry = new ToolRegistry();
    for (const handler of [fileWriteTool, filePatchTool, fileMoveTool, fileDeleteTool, fileReadTool]) {
      registry.register(withBuiltInEffectContract(handler));
    }
    const repositoryChange = {
      baseSnapshotId: snapshot.id,
      rootPath: root,
      authority: engine.changes,
    };
    return {
      admission,
      lease,
      repositoryChange,
      registry,
      executor(promptUser: () => Promise<'allow' | 'deny'>) {
        const execute = registry.buildExecutor({
          cwd: root,
          paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
          actionAuthority: createActionAuthority({ db, jobEngine: engine }),
          approvalEngine: new ApprovalEngine('manual', { promptUser }),
          policySnapshot: {
            trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
            toolMetadataVersion: 'codebase-v1', sandboxPolicy: { roots: [root], deny: [] },
            networkPolicy: {}, pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {},
          },
          repositoryChange,
        });
        return (call: { id: string; name: string; arguments: Record<string, unknown> }) => runWithJobExecutionContext({
          engine, jobId: admission.jobId, attemptId: admission.attemptId,
          generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
        }, () => execute(call));
      },
      run(promptUser: () => Promise<'allow' | 'deny'>) {
        const execute = this.executor(promptUser);
        return (content: string) => execute({
          id: 'provider-file-write', name: 'file_write', arguments: { path: 'source.ts', content },
        });
      },
    };
  }

  it('routes an approved file write through the source-fenced authority', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const fresh = await engine.repository.captureSnapshot({
      jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
      requestedPath: root, previousSnapshotId: context.repositoryChange.baseSnapshotId, producer: 'test',
    });
    context.repositoryChange.baseSnapshotId = fresh.id;
    const execute = context.run(async () => 'allow');
    const result = await execute('after\n');
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ success: true, changeId: expect.any(String), verified: true });
    expect(engine.changes.listRecords(context.admission.jobId)).toHaveLength(1);
    expect(context.repositoryChange.baseSnapshotId).not.toBe(fresh.id);
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('after\n');
  });

  it('persists exact read receipts and Verification without copying file contents into Proof', async () => {
    const content = 'read-only receipt fixture\n';
    await writeFile(path.join(root, 'report.txt'), content);
    const execute = context.executor(async () => 'allow');
    for (const id of ['read-first', 'read-repeat']) {
      const result = await execute({ id, name: 'file_read', arguments: { path: 'report.txt' } });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ success: true });
    }
    const evidence = engine.proof.listEvidence(context.admission.jobId);
    expect(evidence).toHaveLength(2);
    expect(evidence.every((item) => item.source === 'filesystem.read' && item.verificationResult === 'verified')).toBe(true);
    expect(new Set(evidence.map((item) => (item.payload as { toolCallId: string }).toolCallId)).size).toBe(2);
    expect(JSON.stringify(evidence)).not.toContain(content.trim());
    const identity = {
      jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
    };
    expect(engine.proof.finalize(identity).verdict).toBe('verified');
    const reopened = createJobEngine({ db });
    expect(reopened.proof.listEvidence(identity.jobId)).toEqual(evidence);
    expect(reopened.proof.getVerdict(identity.jobId)?.verdict).toBe('verified');
  });

  it('settles denied repository intent and its never-started Effect as failed, not unknown', async () => {
    const result = await context.run(async () => 'deny')('not authorized\n');
    expect(result.error).toContain('denied');
    await expect(readFile(path.join(root, 'source.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(db.prepare('SELECT effect_state, approval_state, reconciliation_required FROM side_effect_ledger').all()).toEqual([
      { effect_state: 'not_occurred', approval_state: 'denied', reconciliation_required: 0 },
    ]);
    expect(db.prepare('SELECT state, started_at FROM tool_calls').all()).toEqual([{ state: 'failed', started_at: null }]);
    expect(engine.proof.listClaims(context.admission.jobId)).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(engine.proof.listEvidence(context.admission.jobId)).toEqual([
      expect.objectContaining({ source: 'effect.approval_denied', verificationResult: 'failed' }),
    ]);
    expect(engine.proof.finalize({
      jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
    }).verdict).toBe('failed');
    expect(createJobEngine({ db }).proof.getVerdict(context.admission.jobId)?.verdict).toBe('failed');
  });

  it('keeps owned runtime-state updates outside repository change scope', async () => {
    const previousHome = process.env.AIDEN_HOME;
    const runtimeRoot = path.join(root, 'runtime-state');
    process.env.AIDEN_HOME = runtimeRoot;
    try {
      const fresh = await engine.repository.captureSnapshot({
        jobId: context.admission.jobId, attemptId: context.admission.attemptId,
        generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
        requestedPath: root, previousSnapshotId: context.repositoryChange.baseSnapshotId, producer: 'test',
      });
      context.repositoryChange.baseSnapshotId = fresh.id;
      const execute = context.executor(async () => {
        await mkdir(runtimeRoot, { recursive: true });
        await writeFile(path.join(runtimeRoot, 'sessions.db-wal'), 'runtime update');
        return 'allow';
      });

      const result = await execute({
        id: 'provider-file-write-with-runtime-state', name: 'file_write',
        arguments: { path: 'source.ts', content: 'verified output\n' },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ success: true, verified: true });
      await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('verified output\n');
      await expect(readFile(path.join(runtimeRoot, 'sessions.db-wal'), 'utf8')).resolves.toBe('runtime update');
      const [evidence] = engine.proof.listEvidence(context.admission.jobId);
      expect(evidence?.payload).toMatchObject({ changedScope: ['source.ts'] });
    } finally {
      if (previousHome === undefined) delete process.env.AIDEN_HOME;
      else process.env.AIDEN_HOME = previousHome;
    }
  });

  it('blocks a user edit made while exact approval is pending', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const fresh = await engine.repository.captureSnapshot({
      jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
      requestedPath: root, previousSnapshotId: context.repositoryChange.baseSnapshotId, producer: 'test',
    });
    context.repositoryChange.baseSnapshotId = fresh.id;
    const execute = context.run(async () => {
      await writeFile(path.join(root, 'source.ts'), 'user edit\n');
      return 'allow';
    });
    const result = await execute('planned\n');
    expect(result.error).toContain('Source metadata or content changed after approval');
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('user edit\n');
  });

  it('fails closed before registering an Effect when exact approval authority is unavailable', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before\n');
    const fresh = await engine.repository.captureSnapshot({
      jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
      requestedPath: root, previousSnapshotId: context.repositoryChange.baseSnapshotId, producer: 'test',
    });
    context.repositoryChange.baseSnapshotId = fresh.id;
    const execute = context.registry.buildExecutor({
      cwd: root,
      paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
      repositoryChange: context.repositoryChange,
    });
    const result = await runWithJobExecutionContext({
      engine, jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!, producer: 'test',
    }, () => execute({
      id: 'provider-file-write-without-approval', name: 'file_write',
      arguments: { path: 'source.ts', content: 'after\n' },
    }));

    expect(result.error).toContain('require exact interactive approval');
    expect(db.prepare('SELECT COUNT(*) AS count FROM side_effect_ledger').get()).toEqual({ count: 0 });
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('before\n');
  });

  it('returns one committed result for an exact duplicate ToolCall retry', async () => {
    const execute = context.run(async () => 'allow');
    const first = await execute('created\n');
    const second = await execute('created\n');
    expect(first.result).toMatchObject({ success: true, changeId: expect.any(String) });
    expect(second.result).toEqual(first.result);
    expect(engine.changes.listRecords(context.admission.jobId)).toHaveLength(1);
    expect(engine.graph.getCodingPlan(context.admission.jobId)).toMatchObject({
      remainingStepIds: [],
      steps: [
        expect.objectContaining({ stepId: 'inspect-source', state: 'completed', filesInspected: [] }),
        expect.objectContaining({ state: 'completed', label: 'Apply create' }),
      ],
    });
  });

  it('repairs patch proof by linking one fresh readback to the patch Effect', async () => {
    await writeFile(path.join(root, 'source.ts'), 'before value\n');
    const fresh = await engine.repository.captureSnapshot({
      jobId: context.admission.jobId, attemptId: context.admission.attemptId,
      generation: context.lease.generation!, fenceToken: context.lease.fenceToken!,
      requestedPath: root, previousSnapshotId: context.repositoryChange.baseSnapshotId, producer: 'test',
    });
    context.repositoryChange.baseSnapshotId = fresh.id;
    const execute = context.executor(async () => 'allow');
    const result = await execute({
      id: 'provider-file-patch', name: 'file_patch',
      arguments: { path: 'source.ts', find: 'value', replace: 'result' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ success: true, operation: 'patch', verified: true });
    expect(engine.proof.listEvidence(context.admission.jobId)).toEqual([
      expect.objectContaining({
        effectId: (result.result as Record<string, unknown>).effectId,
        source: 'repository.change.readback', verificationResult: 'verified', coverage: 'full',
      }),
    ]);
    await expect(readFile(path.join(root, 'source.ts'), 'utf8')).resolves.toBe('before result\n');
  });
});
