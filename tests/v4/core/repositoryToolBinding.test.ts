/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { fileListTool } from '../../../tools/v4/files/fileList';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('repository tool binding scope', () => {
  it('does not capture an unrelated workspace before an external read-only listing', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiden-binding-workspace-'));
    const external = await mkdtemp(path.join(os.tmpdir(), 'aiden-binding-external-'));
    cleanup.push(workspace, external);
    await writeFile(path.join(external, 'target.txt'), 'external');

    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      db.prepare(
        `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
         VALUES ('repository-binding',1,'localhost',1,1,'test')`,
      ).run();
      const engine = createJobEngine({ db });
      const admission = engine.submitJob({
        entryPoint: 'test', source: 'unit', sessionId: 'repository-binding', workspaceId: workspace,
        instanceId: 'repository-binding', idempotencyNamespace: 'repository-binding',
        idempotencyKey: path.basename(workspace), goal: 'inspect an external directory',
      });
      const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
      const capture = vi.spyOn(engine.repository, 'captureSnapshot');
      const registry = new ToolRegistry();
      registry.register(fileListTool);
      const execute = registry.buildExecutor({
        cwd: workspace,
        paths: resolveAidenPaths({ rootOverride: path.join(workspace, '.aiden') }),
      });

      const externalResult = await runWithJobExecutionContext({
        engine, jobId: admission.jobId, attemptId: admission.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
        workspacePath: workspace,
      }, () => execute({ id: 'external-list', name: 'file_list', arguments: { path: external } }));

      expect(externalResult.error).toBeUndefined();
      expect(externalResult.result).toMatchObject({ success: true, count: 1 });
      expect(capture).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('keeps repository capture for read-only listings inside the current workspace', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiden-binding-current-'));
    cleanup.push(workspace);
    await writeFile(path.join(workspace, 'target.txt'), 'current');

    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      db.prepare(
        `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
         VALUES ('repository-binding-current',1,'localhost',1,1,'test')`,
      ).run();
      const engine = createJobEngine({ db });
      const admission = engine.submitJob({
        entryPoint: 'test', source: 'unit', sessionId: 'repository-binding-current', workspaceId: workspace,
        instanceId: 'repository-binding-current', idempotencyNamespace: 'repository-binding-current',
        idempotencyKey: path.basename(workspace), goal: 'inspect the current workspace',
      });
      const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
      const capture = vi.spyOn(engine.repository, 'captureSnapshot');
      const registry = new ToolRegistry();
      registry.register(fileListTool);
      const execute = registry.buildExecutor({
        cwd: workspace,
        paths: resolveAidenPaths({ rootOverride: path.join(workspace, '.aiden') }),
      });

      const result = await runWithJobExecutionContext({
        engine, jobId: admission.jobId, attemptId: admission.attemptId,
        generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
        workspacePath: workspace,
      }, () => execute({ id: 'current-list', name: 'file_list', arguments: { path: workspace } }));

      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ success: true });
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
