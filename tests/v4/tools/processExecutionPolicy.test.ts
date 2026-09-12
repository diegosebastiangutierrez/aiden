/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeExecutionPlan, type PolicySnapshotInput } from '../../../core/v4/actionAuthority';
import {
  evaluateStructuredProcessAdmission,
  type StructuredProcessRequest,
} from '../../../core/v4/processExecutionPolicy';
import { decideForPolicy } from '../../../core/v4/daemon/dispatcher/daemonApproval';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { withBuiltInEffectContract } from '../../../tools/v4/effectContracts';
import { processSpawnTool } from '../../../tools/v4/process/processSpawn';
import { shellExecTool } from '../../../tools/v4/terminal/shellExec';

const policy: PolicySnapshotInput = {
  trustLevel: 'Partner',
  autonomyPolicy: 'runtime',
  approvalMode: 'smart',
  toolMetadataVersion: 'test',
  sandboxPolicy: { roots: [] },
  networkPolicy: {},
  pluginGrants: [],
  mcpGrants: [],
  workspaceOverrides: {},
  jobOverrides: {},
};

describe('structured local process admission', () => {
  let root: string;
  let script: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-process-policy-'));
    script = path.join(root, 'task.mjs');
    fs.writeFileSync(script, "import { writeFileSync } from 'node:fs';\nwriteFileSync('result.txt', 'ok');\n", 'utf8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function request(overrides: Partial<StructuredProcessRequest> = {}): StructuredProcessRequest {
    return {
      runtime: 'node',
      executable: process.execPath,
      script,
      args: [],
      cwd: root,
      ...overrides,
    };
  }

  it('admits a structured current-runtime script inside the authorized workspace for exact approval', () => {
    expect(evaluateStructuredProcessAdmission(request(), { workspaceRoot: root, runtimeExecutable: process.execPath }))
      .toMatchObject({ state: 'APPROVAL_REQUIRED', executable: fs.realpathSync.native(process.execPath), script: fs.realpathSync.native(script) });
  });

  it.runIf(process.platform === 'darwin')('accepts a platform path alias for the same authorized workspace', () => {
    const canonicalRoot = fs.realpathSync.native(root);
    const aliasRoot = canonicalRoot.startsWith('/private/') ? canonicalRoot.slice('/private'.length) : canonicalRoot;
    const aliasScript = path.join(aliasRoot, 'task.mjs');
    expect(evaluateStructuredProcessAdmission(request({ cwd: aliasRoot, script: aliasScript }), {
      workspaceRoot: root,
      runtimeExecutable: process.execPath,
    })).toMatchObject({
      state: 'APPROVAL_REQUIRED',
      cwd: canonicalRoot,
      script: fs.realpathSync.native(script),
    });
  });

  it('denies a script outside the authorized workspace', () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.mjs`);
    fs.writeFileSync(outside, 'setTimeout(() => {}, 1000);\n', 'utf8');
    try {
      expect(evaluateStructuredProcessAdmission(request({ script: outside }), { workspaceRoot: root, runtimeExecutable: process.execPath }))
        .toMatchObject({ state: 'UNAVAILABLE_BY_POLICY', code: 'outside_workspace' });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('denies lexical traversal before resolving the script', () => {
    expect(evaluateStructuredProcessAdmission(request({ script: path.join('..', path.basename(script)) }), { workspaceRoot: root, runtimeExecutable: process.execPath }))
      .toMatchObject({ state: 'UNAVAILABLE_BY_POLICY', code: 'path_traversal' });
  });

  it('denies a symlink or junction that escapes the authorized workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-process-policy-outside-'));
    const outsideScript = path.join(outside, 'task.mjs');
    const link = path.join(root, 'linked');
    fs.writeFileSync(outsideScript, 'setTimeout(() => {}, 1000);\n', 'utf8');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(evaluateStructuredProcessAdmission(request({ script: path.join(link, 'task.mjs') }), { workspaceRoot: root, runtimeExecutable: process.execPath }))
        .toMatchObject({ state: 'UNAVAILABLE_BY_POLICY', code: 'symlink_escape' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('denies shell control syntax even though arguments would be passed without a shell', () => {
    expect(evaluateStructuredProcessAdmission(request({ args: ['safe', 'next;whoami'] }), { workspaceRoot: root, runtimeExecutable: process.execPath }))
      .toMatchObject({ state: 'UNAVAILABLE_BY_POLICY', code: 'shell_syntax' });
  });

  it('denies an executable other than the exact current runtime', () => {
    expect(evaluateStructuredProcessAdmission(request({ executable: path.join(root, 'node.exe') }), { workspaceRoot: root, runtimeExecutable: process.execPath }))
      .toMatchObject({ state: 'UNAVAILABLE_BY_POLICY', code: 'runtime_mismatch' });
  });

  it('denies scripts that request network, child-process, or dynamic-code capabilities', () => {
    for (const [name, source] of [
      ['network.mjs', "import 'node:http';\n"],
      ['child.mjs', "import { spawn } from 'node:child_process';\n"],
      ['dynamic.mjs', "await import('node:net');\n"],
    ] as const) {
      const prohibited = path.join(root, name);
      fs.writeFileSync(prohibited, source, 'utf8');
      expect(evaluateStructuredProcessAdmission(request({ script: prohibited }), {
        workspaceRoot: root,
        runtimeExecutable: process.execPath,
      })).toMatchObject({ state: 'UNAVAILABLE_BY_POLICY', code: 'prohibited_capability' });
    }
  });

  it('binds executable and argument changes to different action digests', () => {
    const base = normalizeExecutionPlan({
      toolName: 'process_spawn', args: request(), cwd: root, mutates: true, riskTier: 'dangerous', policy,
    });
    const changedExecutable = normalizeExecutionPlan({
      toolName: 'process_spawn', args: request({ executable: path.join(root, 'other-node.exe') }), cwd: root,
      mutates: true, riskTier: 'dangerous', policy,
    });
    const changedArgs = normalizeExecutionPlan({
      toolName: 'process_spawn', args: request({ args: ['changed'] }), cwd: root,
      mutates: true, riskTier: 'dangerous', policy,
    });
    expect(base.plan.executable).toBe(fs.realpathSync.native(process.execPath));
    expect(base.plan.shell).toBeNull();
    expect(base.actionDigest).not.toBe(changedExecutable.actionDigest);
    expect(base.actionDigest).not.toBe(changedArgs.actionDigest);
  });

  it('keeps a structured process on the exact interactive approval path in smart mode', async () => {
    const promptUser = vi.fn(async () => 'allow' as const);
    const engine = new ApprovalEngine('smart', { promptUser });
    const handler = withBuiltInEffectContract(processSpawnTool);
    expect(handler.effectContract?.approvalRequirement).toBe('always');
    await expect(engine.checkApproval({
      toolName: 'process_spawn', category: 'execute', args: request(), riskTier: 'dangerous', approvalRequirement: 'always',
    })).resolves.toBe(true);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('does not redefine the independent safe-only daemon policy', () => {
    expect(decideForPolicy('safe-only', 'dangerous')).toBe('deny');
    expect(decideForPolicy('safe-only', 'caution')).toBe('deny');
  });

  it('advertises the supported structured path instead of an opaque shell command', () => {
    const properties = processSpawnTool.schema.inputSchema.properties;
    expect(properties).toHaveProperty('runtime');
    expect(properties).toHaveProperty('script');
    expect(properties).toHaveProperty('args');
    expect(properties).not.toHaveProperty('command');
    expect(processSpawnTool.schema.description).toMatch(/structured|without a shell/i);
    expect(processSpawnTool.schema.description).toMatch(/process_wait/u);
    expect(processSpawnTool.schema.description).toMatch(/not task completion|do not report.*complete/iu);
    expect(processSpawnTool.schema.description).toMatch(/inspect.*workspace/iu);
    expect(shellExecTool.schema.description).toMatch(/short.*one-shot/iu);
    expect(shellExecTool.schema.description).toMatch(/never.*long-running.*process_spawn/iu);
  });

  it('shows the exact runtime, script, workspace, and arguments in the approval preview', () => {
    const preview = processSpawnTool.buildPreview!(request({ args: ['literal-value'] }), {
      cwd: root,
      paths: {} as never,
    });
    expect(preview).toMatchObject({
      riskTier: 'dangerous',
      summary: expect.stringContaining(fs.realpathSync.native(process.execPath)),
    });
    expect(preview.summary).toContain(fs.realpathSync.native(script));
    expect(preview.summary).toContain(fs.realpathSync.native(root));
    expect(preview.summary).toContain('["literal-value"]');
  });
});
