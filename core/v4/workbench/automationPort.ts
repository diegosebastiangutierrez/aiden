/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type Database from 'better-sqlite3';
import path from 'node:path';

import type { EditionAuthority } from '../commercial/edition';
import type { TriggerBus } from '../daemon/triggerBus';
import { createAutomationAuthority } from '../automation/automationAuthority';
import { createAutomationControlAuthority } from '../automation/controlAuthority';
import type { AutomationParentExecution } from '../automation/controlAuthority';
import { previewSchedule } from '../automation/schedule';
import type { AutomationRevisionSpec } from '../automation/types';
import { projectChildExecutionVerification, type WorkbenchJobProjectionReader } from './projection';

export interface WorkbenchAutomationSummary {
  automationId: string;
  name: string;
  enabled: boolean;
  revisionId: string;
  revisionNumber: number;
  action: AutomationRevisionSpec['action'];
  trigger: AutomationRevisionSpec['trigger'];
  policies: AutomationRevisionSpec['policies'];
  capabilities: readonly string[];
  nextFireAt: string | null;
  lastOccurrence: { occurrenceId: string; state: string; jobId: string | null; createdAt: number } | null;
}

export interface WorkbenchAutomationSnapshot {
  capability: { available: boolean; reason?: string };
  scheduler: { ready: boolean; dueBindings: number; reason?: string };
  automations: WorkbenchAutomationSummary[];
  history: WorkbenchAutomationOccurrence[];
  attention: Array<{ automationId: string; state: string; occurrenceId: string }>;
}

export interface WorkbenchAutomationOccurrence {
  occurrenceId: string;
  automationId: string;
  revisionId: string;
  triggerKind: string;
  scheduledFor: string | null;
  triggeredAt: number;
  admittedAt: number | null;
  jobId: string | null;
  attemptId: string | null;
  state: string;
  replayOfOccurrenceId: string | null;
  updatedAt: number;
  detail: {
    reason?: string;
    delivery?: { state: 'completed' | 'failed' | 'unknown'; detail?: string; updatedAt?: number };
  };
  execution: {
    title: string;
    status: string;
    verification: string;
    evidenceCount: number;
    parentJobId: string | null;
    required: boolean;
    sessionId: string;
    runId: number | null;
    startedAt: number | null;
    endedAt: number | null;
    cleanupState: 'active' | 'settled' | 'needs_reconciliation';
  } | null;
}

export interface WorkbenchAutomationRunOutcome {
  triggerEventId: number;
  settled: boolean;
  state: string;
  occurrenceId: string | null;
  jobId: string | null;
  attemptId: string | null;
  jobStatus: string | null;
  terminalOutcome: string | null;
}

export interface WorkbenchAutomationPort {
  snapshot(): WorkbenchAutomationSnapshot;
  create(input: AutomationRevisionSpec & { name: string; createdBy: string; requestId?: string }): WorkbenchAutomationSummary;
  revise(automationId: string, input: Omit<AutomationRevisionSpec, 'workspace'> & { createdBy: string }): WorkbenchAutomationSummary;
  setEnabled(automationId: string, enabled: boolean): WorkbenchAutomationSummary;
  remove(automationId: string, removedBy: string, now?: number): {
    automationId: string; removedAt: number; removedBy: string;
  };
  runNow(automationId: string, parentExecution?: AutomationParentExecution, requestId?: string): {
    triggerEventId: number; state: 'queued'; schedulerReady: boolean;
  };
  waitForRun(triggerEventId: number, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<WorkbenchAutomationRunOutcome>;
  replay(occurrenceId: string): { triggerEventId: number; state: 'queued'; schedulerReady: boolean };
  preview(input: { expression: string; timezone: string; count?: number }): readonly string[];
}

export function createWorkbenchAutomationPort(options: {
  db: Database.Database;
  triggerBus: TriggerBus;
  edition: EditionAuthority;
  ownerId?: string;
  workspaceId?: string | null;
  /** Host-owned workspace root. Client automation payloads cannot override it. */
  workspaceRoot?: string;
  /** True only while a canonical dispatcher can consume queued automation events. */
  schedulerReady?: () => boolean;
  jobs?: WorkbenchJobProjectionReader;
}): WorkbenchAutomationPort {
  const { db } = options;
  const authority = createAutomationAuthority({ db });
  const control = createAutomationControlAuthority({ db, triggerBus: options.triggerBus });
  const scope = (alias = 'd'): { sql: string; params: unknown[] } => {
    if (options.ownerId === undefined) return { sql: '', params: [] };
    return {
      sql: ` AND ${alias}.owner_id = ? AND ${alias}.workspace_id IS ?`,
      params: [options.ownerId, options.workspaceId ?? null],
    };
  };
  const assertAccessible = (automationId: string): void => {
    const scoped = scope();
    const row = db.prepare(
      `SELECT d.automation_id FROM automation_definitions d WHERE d.automation_id = ?${scoped.sql}`,
    ).get(automationId, ...scoped.params);
    if (!row) throw new Error('Automation is outside the current workspace');
  };
  const sameWorkspace = (left: string, right: string): boolean => {
    const normalize = (value: string): string => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
  };
  const projectExecution = (jobId: string | null, attemptId: string | null): WorkbenchAutomationOccurrence['execution'] => {
    if (!jobId || !options.jobs) return null;
    const job = options.jobs.getJob(jobId);
    if (!job) return null;
    if (options.workspaceRoot !== undefined && job.workspaceId !== null
      && !sameWorkspace(job.workspaceId, options.workspaceRoot)) return null;
    const attempt = attemptId ? options.jobs.getAttempt(attemptId) : null;
    if (attempt && attempt.jobId !== job.id) return null;
    const contract = options.jobs.getChildContract?.(jobId) ?? null;
    const verdict = options.jobs.proof?.getVerdict(jobId) ?? null;
    const evidence = options.jobs.proof?.listEvidence(jobId) ?? [];
    const events = options.jobs.listEvents(jobId, 0).sort((left, right) => left.jobSequence - right.jobSequence);
    const unresolved = options.jobs.listEffectsRequiringReconciliation?.(jobId) ?? [];
    return {
      title: job.goal,
      status: contract?.resultStatus ?? job.status,
      verification: contract
        ? projectChildExecutionVerification(contract, verdict, job.status)
        : verdict?.verdict ?? (job.status === 'verification_failed' ? 'failed' : 'not_recorded'),
      evidenceCount: evidence.length || contract?.evidenceHandles.length || 0,
      parentJobId: contract?.parentJobId ?? job.parentJobId,
      required: contract?.required ?? false,
      sessionId: job.sessionId,
      runId: attempt?.rowId ?? null,
      startedAt: events[0]?.createdAt ?? null,
      endedAt: job.terminalAt,
      cleanupState: unresolved.length > 0
        ? 'needs_reconciliation'
        : job.terminalAt === null ? 'active' : 'settled',
    };
  };
  const requireCapability = (): void => {
    if (!options.edition.can('automation.create')) throw new Error('Reliable Automations require Aiden Pro');
  };
  const project = (automationId: string): WorkbenchAutomationSummary => {
    const scoped = scope();
    const row = db.prepare(
      `SELECT d.automation_id,d.name,d.enabled,d.current_revision_id,
              r.revision_number,r.spec_json,b.next_fire_at
         FROM automation_definitions d
         JOIN automation_revisions r ON r.revision_id = d.current_revision_id
         LEFT JOIN automation_trigger_bindings b ON b.revision_id = r.revision_id AND b.enabled = 1
        WHERE d.automation_id = ?${scoped.sql}`,
    ).get(automationId, ...scoped.params) as {
      automation_id: string; name: string; enabled: number; current_revision_id: string;
      revision_number: number; spec_json: string; next_fire_at: string | null;
    } | undefined;
    if (!row) throw new Error(`Automation not found: ${automationId}`);
    const occurrence = db.prepare(
      `SELECT occurrence_id,state,job_id,created_at FROM automation_occurrences
        WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(automationId) as { occurrence_id: string; state: string; job_id: string | null; created_at: number } | undefined;
    const spec = JSON.parse(row.spec_json) as AutomationRevisionSpec;
    return {
      automationId: row.automation_id, name: row.name, enabled: row.enabled === 1,
      revisionId: row.current_revision_id, revisionNumber: row.revision_number,
      action: spec.action, trigger: spec.trigger, policies: spec.policies,
      capabilities: [...spec.capabilities], nextFireAt: row.next_fire_at,
      lastOccurrence: occurrence ? {
        occurrenceId: occurrence.occurrence_id, state: occurrence.state,
        jobId: occurrence.job_id, createdAt: occurrence.created_at,
      } : null,
    };
  };
  return {
    snapshot() {
      const available = options.edition.can('automation.create');
      const scoped = scope();
      const ids = db.prepare(
        `SELECT d.automation_id FROM automation_definitions d
          WHERE d.removed_at IS NULL${scoped.sql}
          ORDER BY d.updated_at DESC LIMIT 500`,
      )
        .all(...scoped.params) as Array<{ automation_id: string }>;
      const due = db.prepare(
        `SELECT COUNT(*) AS count FROM automation_trigger_bindings b
          JOIN automation_definitions d ON d.automation_id = b.automation_id
         WHERE b.enabled = 1 AND d.enabled = 1 AND b.next_fire_at IS NOT NULL AND b.next_fire_at <= ?${scoped.sql}`,
      ).get(new Date().toISOString(), ...scoped.params) as { count: number };
      const attention = db.prepare(
        `SELECT o.automation_id,o.state,o.occurrence_id FROM automation_occurrences o
          JOIN automation_definitions d ON d.automation_id = o.automation_id
          WHERE o.state IN ('waiting_approval','blocked','unknown','failed')${scoped.sql}
          ORDER BY o.updated_at DESC LIMIT 100`,
      ).all(...scoped.params) as Array<{ automation_id: string; state: string; occurrence_id: string }>;
      const history = db.prepare(
        `SELECT o.occurrence_id,o.automation_id,o.revision_id,o.trigger_kind,o.scheduled_for,
                o.triggered_at,o.admitted_at,o.job_id,o.attempt_id,o.state,o.replay_of_occurrence_id,o.updated_at,o.detail_json
           FROM automation_occurrences o
           JOIN automation_definitions d ON d.automation_id = o.automation_id
          WHERE 1 = 1${scoped.sql}
          ORDER BY o.triggered_at DESC,o.occurrence_id DESC LIMIT 200`,
      ).all(...scoped.params) as Array<{
        occurrence_id: string; automation_id: string; revision_id: string; trigger_kind: string;
        scheduled_for: string | null; triggered_at: number; admitted_at: number | null;
        job_id: string | null; attempt_id: string | null; state: string;
        replay_of_occurrence_id: string | null; updated_at: number;
        detail_json: string;
      }>;
      return {
        capability: available ? { available: true } : { available: false, reason: 'Reliable Automations require Aiden Pro' },
        scheduler: options.schedulerReady?.() === true
          ? { ready: true, dueBindings: due.count }
          : { ready: false, dueBindings: due.count, reason: 'Automation execution host is unavailable.' },
        automations: ids.map((row) => project(row.automation_id)),
        history: history.map((row) => ({
          occurrenceId: row.occurrence_id, automationId: row.automation_id,
          revisionId: row.revision_id, triggerKind: row.trigger_kind,
          scheduledFor: row.scheduled_for, triggeredAt: row.triggered_at,
          admittedAt: row.admitted_at, jobId: row.job_id, attemptId: row.attempt_id,
          state: row.state, replayOfOccurrenceId: row.replay_of_occurrence_id,
          updatedAt: row.updated_at,
          detail: (() => {
            try { return JSON.parse(row.detail_json) as WorkbenchAutomationOccurrence['detail']; }
            catch { return {}; }
          })(),
          execution: projectExecution(row.job_id, row.attempt_id),
        })),
        attention: attention.map((row) => ({ automationId: row.automation_id, state: row.state, occurrenceId: row.occurrence_id })),
      };
    },
    create(input) {
      requireCapability();
      const created = authority.create({
        ...input,
        workspace: { rootPath: options.workspaceRoot ?? process.cwd() },
        ownerId: options.ownerId ?? input.createdBy,
        workspaceId: options.workspaceId ?? null,
        commercialContext: 'pro',
      });
      return project(created.definition.id);
    },
    revise(automationId, input) {
      requireCapability();
      assertAccessible(automationId);
      const { createdBy, ...spec } = input;
      authority.revise(automationId, {
        ...spec,
        workspace: { rootPath: options.workspaceRoot ?? process.cwd() },
      }, { createdBy });
      return project(automationId);
    },
    setEnabled(automationId, enabled) {
      requireCapability(); assertAccessible(automationId); authority.setEnabled(automationId, enabled); return project(automationId);
    },
    remove(automationId, removedBy, now) {
      requireCapability();
      assertAccessible(automationId);
      const removed = authority.remove(automationId, { removedBy, ...(now !== undefined ? { now } : {}) });
      return {
        automationId: removed.id,
        removedAt: removed.removedAt!,
        removedBy: removed.removedBy!,
      };
    },
    runNow(automationId, parentExecution, requestId) {
      requireCapability();
      assertAccessible(automationId);
      const result = control.runNow(automationId, Date.now(), parentExecution, requestId);
      return {
        triggerEventId: result.triggerEventId,
        state: 'queued',
        schedulerReady: options.schedulerReady?.() === true,
      };
    },
    async waitForRun(triggerEventId, waitOptions = {}) {
      requireCapability();
      const timeoutMs = Math.max(0, waitOptions.timeoutMs ?? 120_000);
      const startedAt = Date.now();
      const read = (): WorkbenchAutomationRunOutcome => {
        const scoped = scope();
        const row = db.prepare(
          `SELECT o.occurrence_id,o.state,o.job_id,o.attempt_id,
                   t.status AS job_status,t.terminal_outcome
             FROM automation_occurrences o
             JOIN automation_definitions d ON d.automation_id = o.automation_id
             LEFT JOIN tasks t ON t.id = o.job_id
             WHERE o.trigger_event_id = ?${scoped.sql}
             ORDER BY o.created_at DESC,o.occurrence_id DESC LIMIT 1`,
        ).get(triggerEventId, ...scoped.params) as {
          occurrence_id: string; state: string; job_id: string | null; attempt_id: string | null;
          job_status: string | null; terminal_outcome: string | null;
        } | undefined;
        const terminal = row
          ? ['completed', 'failed', 'cancelled', 'blocked', 'unknown', 'skipped_overlap'].includes(row.state)
            || ['completed', 'failed', 'cancelled', 'blocked', 'unknown', 'dead_letter'].includes(row.job_status ?? '')
          : false;
        return {
          triggerEventId,
          settled: terminal,
          state: row?.state ?? 'queued',
          occurrenceId: row?.occurrence_id ?? null,
          jobId: row?.job_id ?? null,
          attemptId: row?.attempt_id ?? null,
          jobStatus: row?.job_status ?? null,
          terminalOutcome: row?.terminal_outcome ?? null,
        };
      };
      for (;;) {
        const current = read();
        if (current.settled || waitOptions.signal?.aborted || Date.now() - startedAt >= timeoutMs) {
          return current;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    },
    replay(occurrenceId) {
      requireCapability();
      const scoped = scope();
      const owned = db.prepare(
        `SELECT o.occurrence_id FROM automation_occurrences o
          JOIN automation_definitions d ON d.automation_id = o.automation_id
         WHERE o.occurrence_id = ?${scoped.sql}`,
      ).get(occurrenceId, ...scoped.params);
      if (!owned) throw new Error('Automation occurrence is outside the current workspace');
      const result = control.replay(occurrenceId);
      return {
        triggerEventId: result.triggerEventId,
        state: 'queued',
        schedulerReady: options.schedulerReady?.() === true,
      };
    },
    preview(input) {
      requireCapability(); return previewSchedule({ ...input, count: input.count ?? 5 }).instants;
    },
  };
}
