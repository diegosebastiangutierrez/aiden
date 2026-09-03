import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ProcessRegistry } from '../../../core/v4/processRegistry';
import { processSpawnTool } from '../../../tools/v4/process/processSpawn';
import { processListTool } from '../../../tools/v4/process/processList';
import { processLogReadTool } from '../../../tools/v4/process/processLogRead';
import { processKillTool } from '../../../tools/v4/process/processKill';
import { processWaitTool } from '../../../tools/v4/process/processWait';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let registry: ProcessRegistry;
let ctx: ToolContext;
let root: string;

function script(name: string, source: string): Record<string, unknown> {
  const file = path.join(root, name);
  fs.writeFileSync(file, source, 'utf8');
  return { runtime: 'node', executable: process.execPath, script: file, args: [], cwd: root };
}

beforeEach(() => {
  registry = new ProcessRegistry();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-proc-tools-'));
  ctx = {
    cwd: root,
    paths: resolveAidenPaths({ rootOverride: path.join(root, '.aiden') }),
    processes: registry,
  };
});

afterEach(() => {
  registry.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('process tools', () => {
  it('1. process_spawn returns id and pid', async () => {
    const r = (await processSpawnTool.execute(
      script('echo.mjs', "console.log('hi');\n"),
      ctx,
    )) as { success: boolean; id: string; pid: number };
    expect(r.success).toBe(true);
    expect(typeof r.id).toBe('string');
    expect(typeof r.pid).toBe('number');
    expect(r).toMatchObject({
      status: 'running',
      taskComplete: false,
      requiredNextAction: {
        tool: 'process_wait',
        arguments: { id: r.id },
      },
    });
  });

  it('2. process_list returns spawned processes', async () => {
    await processSpawnTool.execute(script('sleep-one.mjs', 'setTimeout(() => {}, 2000);\n'), ctx);
    await processSpawnTool.execute(script('sleep-two.mjs', 'setTimeout(() => {}, 2000);\n'), ctx);
    const r = (await processListTool.execute({}, ctx)) as {
      success: boolean;
      count: number;
    };
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
  });

  it('3. process_log_read returns output lines', async () => {
    const spawn = (await processSpawnTool.execute(
      script('log.mjs', "console.log('marker-xyz');\n"),
      ctx,
    )) as { id: string };
    await registry.waitFor(spawn.id, 10_000);
    const r = (await processLogReadTool.execute(
      { id: spawn.id },
      ctx,
    )) as { success: boolean; lines: string[] };
    expect(r.success).toBe(true);
    expect(r.lines.join('\n')).toMatch(/marker-xyz/);
  });

  it('4. process_kill terminates a running process', async () => {
    const spawn = (await processSpawnTool.execute(
      script('kill.mjs', 'setTimeout(() => {}, 30000);\n'),
      ctx,
    )) as { id: string };
    const r = (await processKillTool.execute(
      { id: spawn.id },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    const final = await registry.waitFor(spawn.id, 5000);
    expect(final.status === 'killed' || final.status === 'exited').toBe(true);
  });

  it('5. process_wait blocks until exit', async () => {
    const spawn = (await processSpawnTool.execute(
      script('wait.mjs', "console.log('done');\n"),
      ctx,
    )) as { id: string };
    const r = (await processWaitTool.execute(
      { id: spawn.id, timeoutMs: 10_000 },
      ctx,
    )) as { success: boolean; status: string };
    expect(r.success).toBe(true);
    expect(r.status).toBe('exited');
  });

  it('6. a Job abort reaps a process spawned by that exact execution signal', async () => {
    const controller = new AbortController();
    ctx = { ...ctx, signal: controller.signal };
    const spawned = (await processSpawnTool.execute(
      script('abort.mjs', 'setTimeout(() => {}, 30000);\n'),
      ctx,
    )) as { success: boolean; id: string; pid: number };
    expect(spawned.success).toBe(true);
    expect(registry.get(spawned.id)?.status).toBe('running');

    controller.abort(new Error('durable cancellation persisted'));

    const final = await registry.waitFor(spawned.id, 5_000);
    expect(final.pid).toBe(spawned.pid);
    expect(final.status).toBe('killed');
  });

  it('7. a structured child does not inherit parent credentials', async () => {
    const key = 'AIDEN_PROCESS_POLICY_PRIVATE_VALUE';
    const previous = process.env[key];
    process.env[key] = 'must-not-enter-child';
    try {
      const spawned = (await processSpawnTool.execute(
        script('environment.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync('environment.json', JSON.stringify(process.env));\n`),
        ctx,
      )) as { success: boolean; id: string };
      expect(spawned.success).toBe(true);
      await registry.waitFor(spawned.id, 5_000);
      const environment = JSON.parse(fs.readFileSync(path.join(root, 'environment.json'), 'utf8')) as Record<string, string>;
      expect(environment[key]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
