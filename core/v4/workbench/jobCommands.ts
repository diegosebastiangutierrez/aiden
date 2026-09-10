/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import type { Db } from '../daemon/db/connection';
import { createActionAuthority, type ActionAuthority } from '../actionAuthority';
import type { JobEngine, JobRecord } from '../daemon/jobEngine';
import { admitDurableJob } from '../daemon/jobLifecycle';
import { createJobControlAuthority, type JobControlAuthority } from '../daemon/jobControlAuthority';
import type { RunStore } from '../daemon/runStore';
import type { TriggerBus } from '../daemon/triggerBus';
import { createTaskStore } from '../daemon/taskStore';
import { continueFromCheckpoint } from '../safeContinue';
import { fingerprintContinuityEnvironment } from '../continuityCheckpoint';
import type { SessionStore } from '../sessionStore';
import { parseBrowserCheckContract, bindBrowserCheckContract, readBrowserCheckContract, type BrowserCheckContract } from '../browser/browserCheckContract';

export function summarizeWorkbenchGoal(message: string, maxLength = 120): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Workbench task';
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export interface WorkbenchModelBinding {
  provider: string;
  model: string;
  source: 'session' | 'default';
}

export interface WorkbenchRetryModelOverride {
  provider: string;
  model: string;
}

function normalizeModelBinding(value: unknown): WorkbenchModelBinding | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (!provider || !model) return null;
  return {
    provider,
    model,
    source: candidate.source === 'session' ? 'session' : 'default',
  };
}

function sameModel(
  left: Pick<WorkbenchModelBinding, 'provider' | 'model'> | null,
  right: Pick<WorkbenchModelBinding, 'provider' | 'model'> | null,
): boolean {
  return left?.provider === right?.provider && left?.model === right?.model;
}

export function createWorkbenchJobCommands(options: {
  db: Db;
  triggerBus: TriggerBus;
  jobEngine: JobEngine;
  runStore: RunStore;
  instanceId: string;
  /** Exact repository/workspace root bound to newly admitted Workbench Jobs. */
  workspacePath?: string;
  controlAuthority?: JobControlAuthority;
  actionAuthority?: ActionAuthority;
  /** Durable conversation authority shared with the Workbench dispatcher. */
  sessionStore?: SessionStore;
  /** Resolve the exact provider/model before admission. The returned binding
   * is copied into the immutable trigger event so later settings changes
   * cannot drift an already-admitted Job. */
  resolveModelBinding?: (sessionId?: string) => { provider: string; model: string; source?: 'session' | 'default' } | null;
  /** Confirm that an explicitly selected Retry binding is currently supported
   * and configured. Rejection happens before any trigger or Job is admitted. */
  validateModelBinding?: (binding: WorkbenchRetryModelOverride, sessionId: string) => void | Promise<void>;
  idFactory?: () => string;
}) {
  const controlAuthority = options.controlAuthority ?? createJobControlAuthority({ db: options.db, jobEngine: options.jobEngine });
  const actionAuthority = options.actionAuthority ?? createActionAuthority({ db: options.db, jobEngine: options.jobEngine });
  const checkpoints = options.jobEngine.continuity;
  if (!checkpoints) throw new Error('Workbench requires the canonical JobEngine continuity authority');
  const taskStore = createTaskStore({ db: options.db });
  const nextId = options.idFactory ?? randomUUID;
  const enqueueTx = options.db.transaction((task: {
    message: string;
    sessionId?: string;
    idempotencyKey?: string;
    modelBinding?: WorkbenchModelBinding | null;
    browserCheck?: BrowserCheckContract;
  }) => {
    const idempotencyKey = task.idempotencyKey?.trim() || nextId();
    const sessionId = task.sessionId?.trim() || `workbench:${idempotencyKey}`;
    const fingerprint = createHash('sha256').update(task.browserCheck
      ? JSON.stringify({ message: task.message, browserCheck: task.browserCheck }) : task.message).digest('hex');
    const trigger = options.triggerBus.insert({
      source: 'manual', sourceKey: 'workbench-web', idempotencyKey,
      payload: {
        body: { prompt: task.message, source: 'workbench-web' },
        sessionId,
        ...(task.modelBinding ? { model_binding: task.modelBinding } : {}),
      },
    });
    const admission = admitDurableJob(options.jobEngine, {
      entryPoint: 'workbench', source: 'workbench',
      sessionId,
      instanceId: options.instanceId,
      idempotencyNamespace: 'workbench-web', idempotencyKey,
      requestFingerprint: fingerprint,
      goal: summarizeWorkbenchGoal(task.message),
      workspaceId: options.workspacePath ?? null,
      triggerEventId: trigger.id,
    });
    if (task.browserCheck) {
      bindBrowserCheckContract(options.jobEngine, admission.jobId, admission.attemptId, task.browserCheck);
    }
    options.db.prepare('UPDATE trigger_events SET payload_json = ? WHERE id = ?').run(JSON.stringify({
      body: { prompt: task.message, source: 'workbench-web' },
      sessionId,
      durable_job: {
        job_id: admission.jobId,
        attempt_id: admission.attemptId,
        run_id: admission.runId,
      },
      ...(task.modelBinding ? { model_binding: task.modelBinding } : {}),
    }), trigger.id);
    return { trigger, admission, sessionId };
  }).immediate;

  const retryTx = options.db.transaction((task: {
    originalJobId: string;
    prompt: string;
    sessionId: string;
    idempotencyKey: string;
    conversationAnchorTriggerEventId: number;
    modelBinding?: WorkbenchModelBinding | null;
  }) => {
    const actionKey = `retry:${task.originalJobId}:${task.idempotencyKey}`;
    const trigger = options.triggerBus.insert({
      source: 'manual',
      sourceKey: `workbench-retry:${task.originalJobId}`,
      idempotencyKey: actionKey,
      payload: {
        body: { prompt: task.prompt, source: 'workbench-retry' },
        sessionId: task.sessionId,
        retry_of_job_id: task.originalJobId,
        conversation_anchor_trigger_event_id: task.conversationAnchorTriggerEventId,
        ...(task.modelBinding ? { model_binding: task.modelBinding } : {}),
      },
    });
    if (!trigger.inserted) {
      const existingBinding = normalizeModelBinding(options.triggerBus.get(trigger.id)?.payload.model_binding);
      if (!sameModel(existingBinding, task.modelBinding ?? null)) {
        throw new Error('This Retry request identity was already used with a different provider/model selection.');
      }
    }
    const admission = options.jobEngine.retryJob({
      originalJobId: task.originalJobId,
      instanceId: options.instanceId,
      idempotencyNamespace: 'workbench-retry',
      idempotencyKey: actionKey,
      triggerEventId: trigger.id,
      producer: 'workbench',
    });
    const browserCheck = readBrowserCheckContract(options.jobEngine, task.originalJobId);
    if (browserCheck) bindBrowserCheckContract(options.jobEngine, admission.jobId, admission.attemptId, browserCheck);
    options.db.prepare('UPDATE trigger_events SET payload_json = ? WHERE id = ?').run(JSON.stringify({
      body: { prompt: task.prompt, source: 'workbench-retry' },
      sessionId: task.sessionId,
      retry_of_job_id: task.originalJobId,
      conversation_anchor_trigger_event_id: task.conversationAnchorTriggerEventId,
      durable_job: {
        job_id: admission.jobId,
        attempt_id: admission.attemptId,
        run_id: admission.runId,
      },
      ...(task.modelBinding ? { model_binding: task.modelBinding } : {}),
    }), trigger.id);
    return { trigger, admission };
  }).immediate;

  const finalRun = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'interrupted']);
  const selectedModelBinding = (sessionId?: string): WorkbenchModelBinding | null =>
    normalizeModelBinding(options.resolveModelBinding?.(sessionId) ?? null);
  const modelBindingForRun = (runId: number): WorkbenchModelBinding | null => {
    const run = options.runStore.get(runId);
    if (!run?.triggerEventId) return null;
    return normalizeModelBinding(options.triggerBus.get(run.triggerEventId)?.payload.model_binding);
  };
  const conversationAnchorForRetry = (job: JobRecord, prompt: string): number => {
    const visited = new Set<string>();
    let root = job;
    while (root.retryOfJobId) {
      if (!visited.add(root.id)) throw new Error('Retry lineage contains a cycle and cannot be executed safely.');
      const parent = options.jobEngine.getJob(root.retryOfJobId);
      if (!parent) throw new Error('Retry lineage is incomplete and cannot be executed safely.');
      if (parent.sessionId !== job.sessionId) {
        throw new Error('Retry lineage crossed a conversation boundary and cannot be executed safely.');
      }
      root = parent;
    }
    const run = options.db.prepare(
      `SELECT trigger_event_id
         FROM runs
        WHERE task_id = ? AND trigger_event_id IS NOT NULL
        ORDER BY id ASC LIMIT 1`,
    ).get(root.id) as { trigger_event_id: number | null } | undefined;
    const triggerEventId = run?.trigger_event_id;
    if (!triggerEventId || !Number.isSafeInteger(triggerEventId)) {
      throw new Error('The original durable conversation anchor is unavailable and cannot be retried safely.');
    }
    const trigger = options.triggerBus.get(triggerEventId);
    const payload = trigger?.payload ?? {};
    const body = payload.body && typeof payload.body === 'object'
      ? payload.body as Record<string, unknown>
      : null;
    if (payload.sessionId !== job.sessionId || body?.prompt !== prompt) {
      throw new Error('The retry lineage does not match the original durable request.');
    }
    if (options.sessionStore) {
      const durableUser = options.sessionStore.getMessages(job.sessionId).find((message) =>
        message.role === 'user' && message.turnNumber === triggerEventId,
      );
      if (!durableUser || durableUser.content !== prompt) {
        throw new Error('The original durable conversation message is unavailable and cannot be retried safely.');
      }
    }
    return triggerEventId;
  };
  const activeTarget = (runId: number) => {
    const run = options.runStore.get(runId);
    if (!run?.taskId) return null;
    const job = options.jobEngine.getJob(run.taskId);
    const attempt = job?.activeAttemptId ? options.jobEngine.getAttempt(job.activeAttemptId) : null;
    if (!job || !attempt) return null;
    return { run, job, attempt };
  };
  const captureBoundary = (jobId: string, attemptId: string, generation: number, reason: string, key: string) => {
    const inputs = controlAuthority.inputs.listPending(jobId);
    return checkpoints.capture({
      jobId, attemptId, attemptGeneration: generation, reason,
      idempotencyNamespace: 'workbench-boundary', idempotencyKey: key,
      pendingApprovalIds: actionAuthority.listPending(jobId).map((item) => item.approvalId),
      durableInputCursor: Math.max(0, ...inputs.map((item) => item.sequence)),
    });
  };
  const resumeRun = (runId: number, idempotencyKey = nextId(), promptOverride?: string) => {
    const run = options.runStore.get(runId);
    if (!run?.taskId) return { accepted: false as const, runId };
    const resumed = controlAuthority.commands.resume({
      jobId: run.taskId,
      source: 'workbench',
      instanceId: options.instanceId,
      idempotencyNamespace: 'workbench-control',
      idempotencyKey,
    });
    const job = options.jobEngine.getJob(run.taskId)!;
    const trigger = options.triggerBus.insert({
      source: 'manual',
      sourceKey: `workbench-resume:${run.taskId}`,
      idempotencyKey: `resume:${idempotencyKey}`,
      payload: {
        body: { prompt: promptOverride ?? job.goal, source: 'workbench-resume' },
        sessionId: job.sessionId,
        durable_job: { job_id: job.id, attempt_id: resumed.attemptId, run_id: resumed.runId },
      },
    });
    options.db.prepare('UPDATE runs SET trigger_event_id = ? WHERE attempt_id = ?').run(trigger.id, resumed.attemptId);
    captureBoundary(job.id, resumed.attemptId, resumed.generation, 'resumed', `resume:${idempotencyKey}`);
    return { accepted: true as const, runId, triggerEventId: trigger.id, ...resumed };
  };
  return {
    enqueue: {
      enqueue(task: { message: string; sessionId?: string; idempotencyKey?: string; browserCheck?: unknown }) {
        const modelBinding = selectedModelBinding(task.sessionId);
        const browserCheck = task.browserCheck === undefined ? undefined : parseBrowserCheckContract(task.browserCheck);
        if (browserCheck && !task.idempotencyKey?.trim()) throw new Error('Browser check requires an explicit request identity');
        const accepted = enqueueTx({ ...task, browserCheck, modelBinding });
        if (accepted.trigger.inserted && options.sessionStore) {
          try {
            const { sessionId } = accepted;
            options.sessionStore.ensureSession(sessionId, {
              title: summarizeWorkbenchGoal(task.message),
            });
            const alreadyRecorded = options.sessionStore.getMessages(sessionId)
              .some((message) => message.role === 'user' && message.turnNumber === accepted.trigger.id);
            if (!alreadyRecorded) {
              options.sessionStore.appendMessage(sessionId, {
                role: 'user', content: task.message, turnNumber: accepted.trigger.id,
              });
            }
          } catch {
            // Conversation persistence must never undo an already-admitted Job.
          }
        }
        const attempt = options.jobEngine.getAttempt(accepted.admission.attemptId)!;
        captureBoundary(
          accepted.admission.jobId,
          accepted.admission.attemptId,
          attempt.generation,
          'admitted',
          `admitted:${accepted.admission.attemptId}`,
        );
        return {
          accepted: true,
          triggerEventId: accepted.trigger.id,
          duplicate: !accepted.trigger.inserted,
          jobId: accepted.admission.jobId,
          attemptId: accepted.admission.attemptId,
          runId: accepted.admission.runId,
        };
      },
    },
    cancel: {
      cancel(runId: number): { accepted: boolean; runId: number; alreadyFinal?: boolean } {
        const run = options.runStore.get(runId);
        if (!run) return { accepted: false, runId };
        if (finalRun.has(String(run.status))) return { accepted: true, runId, alreadyFinal: true };
        if (run.taskId && options.jobEngine.getJob(run.taskId)) {
          const attempt = options.jobEngine.getAttempt(options.jobEngine.getJob(run.taskId)?.activeAttemptId ?? '');
          const result = controlAuthority.commands.request({
            jobId: run.taskId,
            attemptId: attempt?.id,
            generation: attempt?.generation,
            kind: 'cancel',
            reason: 'stopped from workbench web',
            source: 'workbench',
            idempotencyNamespace: 'workbench-control',
            idempotencyKey: `cancel:${run.taskId}`,
          });
          if (!result.applied && !result.duplicate) return { accepted: false, runId };
          actionAuthority.cancelPendingForJob(run.taskId, 'Job cancellation requested');
          if (run.triggerEventId) {
            const trigger = options.triggerBus.get(run.triggerEventId);
            if (trigger && (trigger.status === 'pending' || trigger.status === 'claimed')) {
              options.triggerBus.deadLetter(run.triggerEventId, 'workbench task cancelled before dispatch');
            }
          }
          try {
            options.runStore.emitEvent(runId, 'task_cancelled', {
              source: 'workbench-web', reason: 'stopped from dashboard',
            });
          } catch { /* compatibility projection is best-effort */ }
          captureBoundary(run.taskId, attempt!.id, attempt!.generation, 'cancel requested', `cancel:${run.taskId}`);
        } else {
          options.runStore.setStatus(runId, 'cancelled', { finishReason: 'stopped from workbench web' });
          options.runStore.emitEvent(runId, 'task_cancelled', {
            source: 'workbench-web', reason: 'stopped from dashboard',
          });
        }
        return { accepted: true, runId };
      },
    },
    retry: {
      describe(runId: number) {
        const run = options.runStore.get(runId);
        const job = run?.taskId ? options.jobEngine.getJob(run.taskId) : null;
        return {
          jobBinding: modelBindingForRun(runId),
          selectedBinding: selectedModelBinding(job?.sessionId),
        };
      },
      async retry(runId: number, idempotencyKey?: string, modelOverride?: WorkbenchRetryModelOverride) {
        const run = options.runStore.get(runId);
        if (!run?.taskId) return { accepted: false as const, runId };
        const originalJob = options.jobEngine.getJob(run.taskId);
        if (!originalJob) return { accepted: false as const, runId };
        const originalTrigger = run.triggerEventId ? options.triggerBus.get(run.triggerEventId) : null;
        const payload = originalTrigger?.payload ?? {};
        const body = payload.body && typeof payload.body === 'object'
          ? payload.body as Record<string, unknown>
          : null;
        const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
        if (!prompt.trim()) throw new Error('The exact original Workbench request is unavailable and cannot be retried safely.');
        const originalBinding = normalizeModelBinding(payload.model_binding);
        let modelBinding = originalBinding;
        if (modelOverride !== undefined) {
          const provider = typeof modelOverride.provider === 'string' ? modelOverride.provider.trim() : '';
          const model = typeof modelOverride.model === 'string' ? modelOverride.model.trim() : '';
          if (!provider || !model) {
            throw new Error('An explicit Retry requires both a provider and model.');
          }
          const selected = selectedModelBinding(originalJob.sessionId);
          if (!sameModel(selected, { provider, model })) {
            throw new Error('The requested Retry provider/model is not the current explicit Workbench selection.');
          }
          if (!options.validateModelBinding) {
            throw new Error('Explicit Retry model validation is unavailable.');
          }
          await options.validateModelBinding({ provider, model }, originalJob.sessionId);
          modelBinding = { provider, model, source: selected!.source };
        }
        const conversationAnchorTriggerEventId = conversationAnchorForRetry(originalJob, prompt);
        const stableKey = idempotencyKey?.trim() || originalJob.id;
        const retried = retryTx({
          originalJobId: originalJob.id,
          prompt,
          sessionId: originalJob.sessionId,
          idempotencyKey: stableKey,
          conversationAnchorTriggerEventId,
          modelBinding,
        });
        captureBoundary(
          retried.admission.jobId,
          retried.admission.attemptId,
          retried.admission.generation,
          'retried as new work',
          `retried:${retried.admission.attemptId}`,
        );
        return {
          accepted: true as const,
          duplicate: !retried.trigger.inserted || retried.admission.reused,
          originalJobId: retried.admission.originalJobId,
          jobId: retried.admission.jobId,
          attemptId: retried.admission.attemptId,
          runId: retried.admission.runId,
          generation: retried.admission.generation,
          triggerEventId: retried.trigger.id,
          modelBinding,
        };
      },
    },
    input: {
      receive(runId: number, content: string, idempotencyKey = nextId()) {
        const target = activeTarget(runId);
        if (!target) return { accepted: false, runId };
        const received = controlAuthority.inputs.receive({
          jobId: target.job.id,
          targetAttemptId: target.attempt.id,
          targetGeneration: target.attempt.generation,
          sessionId: target.run.sessionId ?? `workbench:${target.job.id}`,
          channelId: 'workbench',
          source: 'workbench',
          kind: 'message',
          content,
          idempotencyNamespace: 'workbench-input',
          idempotencyKey,
        });
        return {
          accepted: true,
          runId,
          jobId: target.job.id,
          attemptId: target.attempt.id,
          inputId: received.record.inputId,
          duplicate: received.duplicate,
        };
      },
    },
    control: {
      pause(runId: number, idempotencyKey = nextId()) {
        const target = activeTarget(runId);
        if (!target) return { accepted: false, applied: false, runId };
        const result = controlAuthority.commands.request({
          jobId: target.job.id,
          attemptId: target.attempt.id,
          generation: target.attempt.generation,
          kind: 'pause',
          source: 'workbench',
          reason: 'paused from workbench',
          idempotencyNamespace: 'workbench-control',
          idempotencyKey,
        });
        captureBoundary(target.job.id, target.attempt.id, target.attempt.generation, 'pause requested', `pause:${idempotencyKey}`);
        return { accepted: true, applied: result.applied, runId, controlId: result.controlId };
      },
      applyPauseBoundary(runId: number) {
        const run = options.runStore.get(runId);
        if (!run?.taskId) return { accepted: false, applied: false };
        const result = controlAuthority.commands.applyPendingAtBoundary({ jobId: run.taskId });
        return { accepted: true, applied: result.applied };
      },
      resume(runId: number, idempotencyKey = nextId()) {
        return resumeRun(runId, idempotencyKey);
      },
    },
    approval: {
      decide(approvalId: string, decision: 'approved' | 'denied' | 'cancelled') {
        const record = actionAuthority.get(approvalId);
        if (!record) return { accepted: false, approvalId };
        const decided = actionAuthority.decide({
          approvalId,
          jobId: record.jobId,
          attemptId: record.attemptId,
          generation: record.generation,
          actionDigest: record.actionDigest,
          policySnapshotId: record.policySnapshotId,
          decision,
          decidedBy: 'user',
          decisionChannel: 'workbench',
        });
        return { accepted: true, approvalId, state: decided.state };
      },
    },
    continuity: checkpoints,
    continueTask: {
      async continue(checkpointId: string, idempotencyKey: string) {
        const checkpoint = checkpoints.get(checkpointId);
        if (!checkpoint) throw new Error('Continuity checkpoint not found');
        let currentRepositoryFingerprint: string | null | undefined;
        if (checkpoint.repositorySnapshotId) {
          const inventory = await options.jobEngine.repository.inventory(
            checkpoint.repositorySnapshotId,
            { limit: 1 },
          );
          currentRepositoryFingerprint = inventory.stale
            ? `stale:${inventory.stateDigest}`
            : inventory.stateDigest;
        }
        return continueFromCheckpoint({
          db: options.db,
          checkpoints,
          engine: options.jobEngine,
          taskStore,
          checkpointId,
          idempotencyKey,
          currentRepositoryFingerprint,
          currentEnvironmentFingerprint: fingerprintContinuityEnvironment(),
          fileProbe(filePath) {
            try { const stat = statSync(filePath); return { exists: true, bytes: stat.size }; }
            catch { return { exists: false }; }
          },
          resume(input) {
            const priorAttempt = options.jobEngine.getAttempt(input.priorAttemptId);
            if (!priorAttempt) throw new Error('Prior Attempt not found');
            const result = resumeRun(priorAttempt.rowId, input.idempotencyKey, input.preamble);
            if (!result.accepted || !('attemptId' in result) || !('generation' in result)) {
              throw new Error('Durable Job could not be resumed');
            }
            return { attemptId: result.attemptId, generation: result.generation, runId: result.runId };
          },
        });
      },
    },
  };
}
