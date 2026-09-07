/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import Database from 'better-sqlite3';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AidenAgent } from '../../../core/v4/aidenAgent';
import { createActionAuthority } from '../../../core/v4/actionAuthority';
import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import { createTaskStore } from '../../../core/v4/daemon/taskStore';
import { createTriggerBus } from '../../../core/v4/daemon/triggerBus';
import { createDispatcher } from '../../../core/v4/daemon/dispatcher';
import { createRealAgentRunner } from '../../../core/v4/daemon/dispatcher/realAgentRunner';
import { createWorkbenchAutomationPort } from '../../../core/v4/workbench/automationPort';
import { createAutomationControlAuthority, automationParentFenceDigest } from '../../../core/v4/automation/controlAuthority';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { fileReadTool } from '../../../tools/v4/files/fileRead';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';

describe('required Automation child durable file evidence', () => {
  it.each([false, true])('preserves real tool verification and terminal cleanup after reopen (denied=%s)', async (denied) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-child-evidence-'));
    const dbPath = path.join(root, 'state.sqlite');
    let db = new Database(dbPath);
    try {
      runMigrations(db);
      db.prepare(`INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
        VALUES ('child-history',1,'localhost',1,1,'4.21.0')`).run();
      await writeFile(path.join(root, 'source.txt'), 'verified source\n');
      const jobs = createJobEngine({ db });
      const bus = createTriggerBus({ db });
      const runs = createRunStore({ db });
      const port = createWorkbenchAutomationPort({ db, triggerBus: bus, jobs, workspaceRoot: root, edition: buildEditionAuthority('pro') });
      const automation = port.create({
        name: 'Inspect source', action: { kind: 'prompt', prompt: 'Inspect source and perform the required action.' },
        trigger: { kind: 'manual' }, createdBy: 'test', capabilities: ['repository.read', 'repository.write'],
        credentialRefs: [], policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
      });
      const parent = jobs.submitJob({
        entryPoint: 'workbench', source: 'test', sessionId: 'parent', workspaceId: root,
        instanceId: 'child-history', idempotencyNamespace: 'test', idempotencyKey: 'parent', goal: 'Run required child',
      });
      const lease = jobs.claimAttempt({ attemptId: parent.attemptId, ownerId: 'parent', ttlMs: 60_000 });
      if (!lease.fenceToken || lease.generation === undefined) throw new Error('Parent lease unavailable');
      createAutomationControlAuthority({ db, triggerBus: bus }).runNow(automation.automationId, Date.now(), {
        jobId: parent.jobId, attemptId: parent.attemptId, generation: lease.generation,
        fenceTokenDigest: automationParentFenceDigest(lease.fenceToken),
      });
      const registry = new ToolRegistry();
      registry.register(withBuiltInEffectContract(fileReadTool));
      registry.register(withBuiltInEffectContract(fileWriteTool));
      const dispatcher = createDispatcher({
        db, triggerBus: bus, runStore: runs, jobEngine: jobs, workerCount: 1,
        ownerId: 'child-history', instanceId: 'child-history',
        runnerFactory: () => createRealAgentRunner({
          db, runStore: runs, jobEngine: jobs, taskStore: createTaskStore({ db }),
          persistedDefault: { provider: 'test', model: 'fixture' },
          agentBuilder: () => ({ runConversation: async () => {
            const execute = registry.buildExecutor({
              cwd: root, paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
              actionAuthority: createActionAuthority({ db, jobEngine: jobs }),
              approvalEngine: new ApprovalEngine('manual', { promptUser: async () => 'deny' }),
              policySnapshot: { trustLevel: 'Assistant', autonomyPolicy: 'ask_for_mutations', approvalMode: 'manual',
                toolMetadataVersion: 'test', sandboxPolicy: { roots: [root], deny: [] }, networkPolicy: {},
                pluginGrants: [], mcpGrants: [], workspaceOverrides: {}, jobOverrides: {} },
            });
            const read = await execute({ id: 'read-source', name: 'file_read', arguments: { path: 'source.txt' } });
            const trace = [{ name: 'file_read', args: { path: 'source.txt' }, ...read }];
            if (denied) {
              const args = { path: 'denied.txt', content: 'must not be written' };
              const write = await execute({ id: 'required-write', name: 'file_write', arguments: args });
              trace.push({ name: 'file_write', args, ...write });
            }
            return { finishReason: 'stop', finalContent: denied ? 'Required action denied.' : 'Source read.',
              turnCount: 1, toolCallTrace: trace };
          } } as unknown as AidenAgent),
        }),
      });
      await dispatcher._pumpOnce();
      const child = jobs.listJobs({ entryPoint: 'automation' })[0];
      expect(child).toBeDefined();
      expect(child).toMatchObject({ parentJobId: parent.jobId, status: denied ? 'failed' : 'completed', activeAttemptId: null });
      const history = port.snapshot().history[0];
      expect(history).toMatchObject({ state: denied ? 'failed' : 'completed', execution: {
        status: denied ? 'failed' : 'completed', parentJobId: parent.jobId, required: true, cleanupState: 'settled',
      } });
      expect(history.execution!.evidenceCount).toBeGreaterThan(0);
      expect(history.execution!.verification).toBe(denied ? 'partially_verified' : 'verified');
      if (denied) expect(jobs.proof.getVerdict(child.id)?.summary.failedClaims).toBe(1);
      expect(jobs.proof.listEvidence(child.id).some((item) => item.source === 'filesystem.read')).toBe(true);
      expect(jobs.listEffectsRequiringReconciliation(child.id)).toEqual([]);
      await expect(access(path.join(root, 'denied.txt'))).rejects.toThrow();
      port.setEnabled(automation.automationId, false);
      db.close();
      db = new Database(dbPath);
      const reopenedJobs = createJobEngine({ db });
      const reopened = createWorkbenchAutomationPort({ db, triggerBus: createTriggerBus({ db }), jobs: reopenedJobs,
        workspaceRoot: root, edition: buildEditionAuthority('pro') });
      expect(reopened.snapshot().history[0]).toEqual(history);
      expect(reopenedJobs.getJob(child.id)?.status).toBe(denied ? 'failed' : 'completed');
      expect(reopenedJobs.getChildContract(child.id)?.resultStatus).toBe(denied ? 'failed' : 'completed');
    } finally {
      if (db.open) db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
