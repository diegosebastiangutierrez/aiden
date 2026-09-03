/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processSpawn.ts — `process_spawn` wrapper.
 *
 * Start a long-running background process tracked by the
 * ProcessRegistry. For one-shot synchronous commands, use
 * `shell_exec`.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import {
  evaluateStructuredProcessAdmission,
  type StructuredProcessRequest,
} from '../../../core/v4/processExecutionPolicy';

function requestFrom(args: Readonly<Record<string, unknown>>): StructuredProcessRequest {
  return {
    runtime: args.runtime as 'node',
    ...(typeof args.executable === 'string' ? { executable: args.executable } : {}),
    script: typeof args.script === 'string' ? args.script : '',
    args: Array.isArray(args.args) ? args.args as string[] : [],
    ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
  };
}

export const processSpawnTool: ToolHandler = {
  schema: {
    name: 'process_spawn',
    description:
      'Start one structured local Node script without a shell. Use this for long-running or cancellable local work; when the request describes an operation rather than a script, inspect the active workspace for a suitable existing Node script first. The script and working directory must remain inside the active workspace, the current Node runtime is used, and exact approval is always required. A successful start is not task completion: immediately call process_wait with the returned id whenever the Job must remain active for Stop or until the process exits, and do not report the task complete while status is running.',
    inputSchema: {
      type: 'object',
      properties: {
        runtime: { type: 'string', enum: ['node'], description: 'Supported local runtime.' },
        executable: { type: 'string', description: 'Optional exact current Node executable; omit or use node to bind the hosting runtime.' },
        script: { type: 'string', description: 'JavaScript module path inside the active workspace.' },
        args: { type: 'array', description: 'Structured literal script arguments. Shell syntax is not accepted.', items: { type: 'string' } },
        cwd: { type: 'string', description: 'Working directory inside the active workspace.' },
      },
      required: ['runtime', 'script', 'args'],
      additionalProperties: false,
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'process',
  riskTier: 'dangerous',   // v4.4 Phase 1
  validateArguments(args, ctx) {
    if (!ctx) return 'Structured process admission requires an execution context.';
    const allowedKeys = new Set(['runtime', 'executable', 'script', 'args', 'cwd']);
    if (Object.keys(args).some((key) => !allowedKeys.has(key))) {
      return 'Only runtime, executable, script, args, and cwd are accepted; opaque commands are unavailable by policy.';
    }
    const admission = evaluateStructuredProcessAdmission(requestFrom(args), {
      workspaceRoot: ctx.cwd,
      runtimeExecutable: process.execPath,
    });
    return admission.state === 'APPROVAL_REQUIRED' ? null : `${admission.code}: ${admission.reason}`;
  },
  buildPreview(args, ctx) {
    const admission = evaluateStructuredProcessAdmission(requestFrom(args), {
      workspaceRoot: ctx.cwd,
      runtimeExecutable: process.execPath,
    });
    const executable = admission.executable ?? process.execPath;
    const script = admission.script ?? String(args.script ?? '');
    const cwd = admission.cwd ?? (typeof args.cwd === 'string' ? args.cwd : ctx.cwd);
    const literalArgs = admission.args ?? [];
    return {
      tool: 'process_spawn',
      args,
      riskTier: 'dangerous',
      sideEffects: [{ type: 'process_spawn', command: executable, args: admission.spawnArgs ?? [] }],
      detectedRisks: admission.state === 'APPROVAL_REQUIRED' ? [] : [admission.reason],
      summary: `Would run local Node process\nExecutable: ${executable}\nScript: ${script}\nWorkspace: ${cwd}\nArguments: ${JSON.stringify(literalArgs)}\nNetwork: unavailable under this execution profile\nExternal side effect: workspace files only`,
    };
  },
  async execute(args, ctx) {
    if (!ctx.processes) {
      return { success: false, error: 'process registry not configured' };
    }
    const admission = evaluateStructuredProcessAdmission(requestFrom(args), {
      workspaceRoot: ctx.cwd,
      runtimeExecutable: process.execPath,
    });
    if (admission.state !== 'APPROVAL_REQUIRED' || !admission.executable || !admission.cwd || !admission.spawnArgs) {
      return { success: false, error: `${admission.code}: ${admission.reason}` };
    }
    try {
      // v4.12 PM.1 — tag the owning session (best-effort from ctx.sessionId) so
      // the handle records ownership; creation-time is captured inside spawn().
      const handle = ctx.processes.spawn(admission.executable, {
        args: admission.spawnArgs,
        shell: false,
        inheritEnv: false,
        cwd: admission.cwd,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
      return {
        success: true,
        id: handle.id,
        pid: handle.pid,
        status: handle.status,
        startedAt: handle.startedAt,
        createdAt: handle.createdAt,
        cwd: handle.cwd,
        executable: admission.executable,
        script: admission.script,
        taskComplete: false,
        requiredNextAction: {
          tool: 'process_wait',
          arguments: { id: handle.id },
          reason: 'Keep the current Job active until the supervised process exits or Stop cancels it.',
        },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
