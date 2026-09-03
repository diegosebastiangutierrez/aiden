/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isWithin, realpathWithFallback } from './sandboxFs';

export type ProcessAdmissionState =
  | 'AVAILABLE'
  | 'APPROVAL_REQUIRED'
  | 'UNAVAILABLE_BY_POLICY'
  | 'UNAVAILABLE_BY_ENVIRONMENT';

export interface StructuredProcessRequest {
  runtime: 'node';
  executable?: string;
  script: string;
  args: string[];
  cwd?: string;
}

export interface StructuredProcessAdmission {
  state: ProcessAdmissionState;
  code: string;
  reason: string;
  executable?: string;
  script?: string;
  cwd?: string;
  args?: string[];
  spawnArgs?: string[];
}

export interface StructuredProcessPolicyOptions {
  workspaceRoot: string;
  runtimeExecutable?: string;
  runtimeVersion?: string;
}

const MAX_SCRIPT_BYTES = 1_048_576;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const CONTROL_OR_SHELL_SYNTAX = /[\0\r\n;&|<>`$]/u;
const FORBIDDEN_NODE_SOURCE = [
  /(?:from\s*|import\s*)['"](?:node:)?(?:child_process|cluster|worker_threads|net|http|https|http2|tls|dgram|dns|repl|vm|inspector|module)['"]/iu,
  /\brequire\s*\(/u,
  /\bimport\s*\(/u,
  /\b(?:fetch|WebSocket|EventSource)\s*\(/u,
  /\bprocess\s*\.\s*(?:getBuiltinModule|binding|dlopen)\b/u,
  /\b(?:eval|Function)\s*\(/u,
] as const;

function unavailable(
  state: Extract<ProcessAdmissionState, 'UNAVAILABLE_BY_POLICY' | 'UNAVAILABLE_BY_ENVIRONMENT'>,
  code: string,
  reason: string,
): StructuredProcessAdmission {
  return { state, code, reason };
}

function samePath(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === '' || (process.platform === 'win32' && left.toLowerCase() === right.toLowerCase());
}

function hasTraversal(input: string): boolean {
  return input.split(/[\\/]+/u).includes('..');
}

function resolveRuntimeExecutable(requested: string | undefined, runtimeExecutable: string): string | null {
  const trimmed = requested?.trim();
  if (!trimmed || /^(?:node|node\.exe)$/iu.test(trimmed)) return realpathWithFallback(runtimeExecutable);
  if (!path.isAbsolute(trimmed)) return null;
  return realpathWithFallback(trimmed);
}

function permissionFlag(version: string): string {
  const major = Number.parseInt(version.split('.', 1)[0] ?? '', 10);
  return Number.isFinite(major) && major >= 22 ? '--permission' : '--experimental-permission';
}

/**
 * Admits only an exact local Node script rooted in the active workspace.
 * The resulting argv is passed directly to child_process.spawn; no shell is
 * involved. Approval remains mandatory because local code can mutate the
 * authorized workspace even under Node's filesystem permission boundary.
 */
export function evaluateStructuredProcessAdmission(
  request: StructuredProcessRequest,
  options: StructuredProcessPolicyOptions,
): StructuredProcessAdmission {
  if (request.runtime !== 'node') {
    return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'runtime_unavailable', 'Only the current Node runtime is supported.');
  }

  const workspaceRoot = realpathWithFallback(options.workspaceRoot);
  let rootStat: fs.Stats;
  try { rootStat = fs.statSync(workspaceRoot); }
  catch { return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'workspace_unavailable', 'The authorized workspace is unavailable.'); }
  if (!rootStat.isDirectory()) {
    return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'workspace_unavailable', 'The authorized workspace is not a directory.');
  }

  const runtimeExecutable = realpathWithFallback(options.runtimeExecutable ?? process.execPath);
  const executable = resolveRuntimeExecutable(request.executable, runtimeExecutable);
  if (!executable || !samePath(executable, runtimeExecutable)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'runtime_mismatch', 'The executable is not the exact runtime hosting Aiden.');
  }
  try {
    if (!fs.statSync(executable).isFile()) {
      return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'runtime_unavailable', 'The current Node runtime is unavailable.');
    }
  } catch {
    return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'runtime_unavailable', 'The current Node runtime is unavailable.');
  }

  const requestedCwd = request.cwd?.trim() || workspaceRoot;
  if (CONTROL_OR_SHELL_SYNTAX.test(requestedCwd)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'shell_syntax', 'The working directory contains control or shell syntax.');
  }
  if (!path.isAbsolute(requestedCwd) && hasTraversal(requestedCwd)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'path_traversal', 'The working directory may not traverse outside the workspace.');
  }
  const lexicalCwd = path.resolve(workspaceRoot, requestedCwd);
  const cwd = realpathWithFallback(lexicalCwd);
  if (!samePath(cwd, workspaceRoot) && !isWithin(cwd, workspaceRoot)) {
    const lexicalInsideWorkspace = samePath(lexicalCwd, workspaceRoot) || isWithin(lexicalCwd, workspaceRoot);
    return unavailable(
      'UNAVAILABLE_BY_POLICY',
      lexicalInsideWorkspace ? 'symlink_escape' : 'outside_workspace',
      'The working directory resolves outside the authorized workspace.',
    );
  }
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'working_directory_unavailable', 'The working directory is unavailable.');
    }
  } catch {
    return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'working_directory_unavailable', 'The working directory is unavailable.');
  }

  if (typeof request.script !== 'string' || !request.script.trim()) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'script_required', 'A script path is required.');
  }
  const requestedScript = request.script.trim();
  if (CONTROL_OR_SHELL_SYNTAX.test(requestedScript)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'shell_syntax', 'The script path contains control or shell syntax.');
  }
  if (!path.isAbsolute(requestedScript) && hasTraversal(requestedScript)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'path_traversal', 'The script path may not traverse outside the workspace.');
  }
  const lexicalScript = path.resolve(cwd, requestedScript);
  if (!samePath(lexicalScript, workspaceRoot) && !isWithin(lexicalScript, workspaceRoot)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'outside_workspace', 'The script is outside the authorized workspace.');
  }
  const script = realpathWithFallback(lexicalScript);
  if (!samePath(script, lexicalScript)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'symlink_escape', 'The script path crosses a symlink or junction boundary.');
  }
  if (!samePath(script, workspaceRoot) && !isWithin(script, workspaceRoot)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'symlink_escape', 'The script resolves outside the authorized workspace.');
  }
  if (!/\.(?:cjs|mjs|js)$/iu.test(script)) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'script_type', 'Only JavaScript module files are supported.');
  }

  let source: string;
  try {
    const stat = fs.statSync(script);
    if (!stat.isFile()) return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'script_unavailable', 'The script is unavailable.');
    if (stat.size > MAX_SCRIPT_BYTES) return unavailable('UNAVAILABLE_BY_POLICY', 'script_too_large', 'The script exceeds the local execution policy limit.');
    source = fs.readFileSync(script, 'utf8');
  } catch {
    return unavailable('UNAVAILABLE_BY_ENVIRONMENT', 'script_unavailable', 'The script is unavailable.');
  }
  if (FORBIDDEN_NODE_SOURCE.some((pattern) => pattern.test(source))) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'prohibited_capability', 'The script requests a capability outside the local workspace execution profile.');
  }

  if (!Array.isArray(request.args) || request.args.length > MAX_ARGUMENTS) {
    return unavailable('UNAVAILABLE_BY_POLICY', 'invalid_arguments', 'Process arguments must be a bounded structured list.');
  }
  const args: string[] = [];
  for (const value of request.args) {
    if (typeof value !== 'string' || value.length > MAX_ARGUMENT_LENGTH) {
      return unavailable('UNAVAILABLE_BY_POLICY', 'invalid_arguments', 'Every process argument must be a bounded string.');
    }
    if (CONTROL_OR_SHELL_SYNTAX.test(value)) {
      return unavailable('UNAVAILABLE_BY_POLICY', 'shell_syntax', 'Process arguments may not contain control or shell syntax.');
    }
    args.push(value);
  }

  const version = options.runtimeVersion ?? process.versions.node;
  const spawnArgs = [
    permissionFlag(version),
    `--allow-fs-read=${workspaceRoot}`,
    `--allow-fs-write=${workspaceRoot}`,
    script,
    ...args,
  ];
  return {
    state: 'APPROVAL_REQUIRED',
    code: 'structured_local_process',
    reason: 'Exact approval is required for a workspace-contained local process.',
    executable,
    script,
    cwd,
    args,
    spawnArgs,
  };
}
