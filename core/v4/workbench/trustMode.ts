/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { isAutonomyLevel, resolveAutonomyPolicy, type AutonomyLevel } from '../../../moat/autonomy';
import type { ApprovalEngine } from '../../../moat/approvalEngine';
import type { JobExecutionContext } from '../daemon/jobExecutionContext';

export function createWorkbenchTrustPort(options: {
  read(): AutonomyLevel;
  save(level: AutonomyLevel): Promise<void>;
}) {
  let changing = false;
  const snapshot = () => ({ level: options.read(), appliesTo: 'new-chat-jobs' as const });
  return {
    snapshot,
    async set(level: AutonomyLevel) {
      if (!isAutonomyLevel(level)) throw new Error('Choose Observer, Assistant or Partner');
      if (changing) throw new Error('A mode change is already in progress');
      changing = true;
      try { await options.save(level); return snapshot(); }
      finally { changing = false; }
    },
  };
}

/** Snapshot the canonical dial into a fresh chat engine, never into Automations
 * or an already-running engine. The existing approval floors remain authority. */
export function applyWorkbenchTrust(
  engine: ApprovalEngine,
  context: JobExecutionContext | undefined,
  level: AutonomyLevel,
  approvalMode: 'policy' | 'always',
): void {
  if (!context || approvalMode === 'always' || !context.workspacePath) return;
  const job = context.engine.getJob(context.jobId);
  if (job?.entryPoint !== 'workbench' || job.automationId || job.parentJobId) return;
  engine.setAutonomyPolicy(resolveAutonomyPolicy(level, { workspaceRoots: [context.workspacePath] }));
  engine.freeze();
}
