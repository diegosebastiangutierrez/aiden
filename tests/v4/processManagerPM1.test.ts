/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 PM.1 — process manager: wire + harden the core.
 *
 * Registry: creation-time (PID-identity foundation) + cwd + owner captured on
 * spawn; TREE-kill via killProcessTree with graceful→grace→force escalation;
 * move-to-finished idempotent (exit+error race → single completion); cleanup
 * reaps. Tools: process_list secret-redacts the command; process_spawn tags the
 * owner + returns creation-time. Wiring: aidenCLI wires ctx.processes (fixes the
 * dormancy — process_* were "registry not configured").
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { ProcessRegistry } from '../../core/v4/processRegistry';
import { processListTool } from '../../tools/v4/process/processList';
import { processSpawnTool } from '../../tools/v4/process/processSpawn';
import { resolveAidenPaths } from '../../core/v4/paths';
import type { ToolContext } from '../../core/v4/toolRegistry';

/** Minimal fake ChildProcess: records kill()s, lets tests drive exit/error. */
function makeFakeChild(pid: number | null = 4242) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const child = {
    pid,
    kill: vi.fn(),
    stdout: null,
    stderr: null,
    on(ev: string, cb: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(cb); return child; },
    _emit(ev: string, ...args: unknown[]) { (listeners[ev] || []).forEach((cb) => cb(...args)); },
  };
  return child;
}
const spawnFake = (fake: ReturnType<typeof makeFakeChild>) => (() => fake) as unknown as SpawnImpl;
type SpawnImpl = NonNullable<Parameters<ProcessRegistry['spawn']>[1]>['spawnImpl'];

describe('PM.1 — ProcessRegistry: identity foundation + ownership', () => {
  it('★ captures OS creation-time + cwd + ownerSessionId on spawn', () => {
    const r = new ProcessRegistry();
    const fake = makeFakeChild(1000);
    const h = r.spawn('do thing', {
      cwd: '/work/dir', sessionId: 'sess-7',
      getCreationTime: () => 1_717_171_717_000,
      spawnImpl: spawnFake(fake),
    });
    expect(h.createdAt).toBe(1_717_171_717_000);   // PID-identity foundation, not Date.now()
    expect(h.cwd).toBe('/work/dir');
    expect(h.ownerSessionId).toBe('sess-7');
    expect(h.pid).toBe(1000);
  });

  it('creation-time is best-effort — null → undefined, never throws', () => {
    const r = new ProcessRegistry();
    const h = r.spawn('x', { getCreationTime: () => null, spawnImpl: spawnFake(makeFakeChild(1)) });
    expect(h.createdAt).toBeUndefined();
  });
});

describe('PM.1 — ProcessRegistry: tree-kill + escalation', () => {
  // Inject a recording killTree + platform seam so tests are deterministic and
  // never run a real `taskkill` against a fake pid.
  const mkReg = (platform: NodeJS.Platform) => {
    const treeKills: string[] = [];
    const r = new ProcessRegistry({ platform, killTree: (_c, sig) => { treeKills.push(sig); } });
    return { r, treeKills };
  };

  it('★ POSIX: kill routes through the tree-kill helper and returns true', () => {
    const { r, treeKills } = mkReg('linux');
    const h = r.spawn('sleep', { getCreationTime: () => 1, spawnImpl: spawnFake(makeFakeChild(1000)) });
    expect(r.kill(h.id, 'SIGTERM')).toBe(true);
    expect(treeKills).toEqual(['SIGTERM']);   // graceful tree-kill dispatched
  });

  it('★ POSIX: graceful SIGTERM escalates to force SIGKILL after the grace window if still running', () => {
    vi.useFakeTimers();
    try {
      const { r, treeKills } = mkReg('linux');
      const h = r.spawn('sleep', { getCreationTime: () => 1, spawnImpl: spawnFake(makeFakeChild(1000)) });
      r.kill(h.id, 'SIGTERM');
      expect(treeKills).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(2000);
      expect(treeKills).toEqual(['SIGTERM', 'SIGKILL']);   // forced tree-kill after grace
    } finally { vi.useRealTimers(); }
  });

  it('POSIX: does NOT escalate when the process exits within the grace window', () => {
    vi.useFakeTimers();
    try {
      const { r, treeKills } = mkReg('linux');
      const fake = makeFakeChild(1000);
      const h = r.spawn('x', { getCreationTime: () => 1, spawnImpl: spawnFake(fake) });
      r.kill(h.id, 'SIGTERM');
      fake._emit('exit', 0, 'SIGTERM');
      vi.advanceTimersByTime(2000);
      expect(treeKills).toEqual(['SIGTERM']);   // no force escalation after clean exit
    } finally { vi.useRealTimers(); }
  });

  it('★ Windows: a SINGLE atomic force tree-kill (no graceful-first — console trees would orphan)', () => {
    const { r, treeKills } = mkReg('win32');
    const h = r.spawn('sleep', { getCreationTime: () => 1, spawnImpl: spawnFake(makeFakeChild(1000)) });
    expect(r.kill(h.id, 'SIGTERM')).toBe(true);
    expect(treeKills).toEqual(['SIGKILL']);   // force taskkill /t /f while the tree is intact
  });
});

describe('PM.1 — ProcessRegistry: idempotent completion + reap', () => {
  it('★ move-to-finished is idempotent (exit + racing error → single completion, first event wins)', () => {
    const r = new ProcessRegistry();
    const fake = makeFakeChild(1000);
    const h = r.spawn('x', { getCreationTime: () => 1, spawnImpl: spawnFake(fake) });
    fake._emit('exit', 0, null);              // natural exit → finish('exited', 0)
    fake._emit('error', new Error('late'));   // racing error → guarded no-op
    expect(r.get(h.id)!.status).toBe('exited');
    expect(r.get(h.id)!.exitCode).toBe(0);    // NOT overwritten to -1 by the error path
  });

  it('kill after exit is a no-op (returns false, status stable)', () => {
    const r = new ProcessRegistry();
    const fake = makeFakeChild(1000);
    const h = r.spawn('x', { getCreationTime: () => 1, spawnImpl: spawnFake(fake) });
    fake._emit('exit', 0, null);
    expect(r.kill(h.id)).toBe(false);
    expect(r.get(h.id)!.status).toBe('exited');
  });

  it('★ cleanup force-tree-kills running spawns and stays idempotent against a racing exit', () => {
    const treeKills: string[] = [];
    const r = new ProcessRegistry({ platform: 'linux', killTree: (_c, sig) => { treeKills.push(sig); } });
    const fake = makeFakeChild(1000);
    const h = r.spawn('x', { getCreationTime: () => 1, spawnImpl: spawnFake(fake) });
    r.cleanup();
    expect(treeKills).toEqual(['SIGKILL']);      // force tree-kill on reap
    expect(r.get(h.id)!.status).toBe('killed');
    fake._emit('exit', 0, null);                 // racing exit after reap
    expect(r.get(h.id)!.status).toBe('killed');  // not overwritten
  });
});

describe('PM.1 — tools: redaction + owner passthrough', () => {
  const ctx = (registry: ProcessRegistry, sessionId?: string): ToolContext => ({
    cwd: process.cwd(),
    paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-pm1-test' }),
    processes: registry,
    sessionId,
  }) as ToolContext;

  it('★ process_list secret-redacts the command (a Bearer token never reaches the model)', async () => {
    const r = new ProcessRegistry();
    r.spawn('curl -H "Authorization: Bearer sk-abcdefghij0123456789ABCDEFGHIJ" https://api', {
      getCreationTime: () => 1, spawnImpl: spawnFake(makeFakeChild(1)),
    });
    const out = (await processListTool.execute({}, ctx(r))) as { processes: Array<{ command: string }> };
    const cmd = out.processes[0].command;
    expect(cmd).not.toContain('sk-abcdefghij0123456789');
    expect(cmd).toMatch(/REDACTED/);
  });

  it('process_spawn tags the owning session from ctx.sessionId + returns creation-time', async () => {
    const r = new ProcessRegistry();
    const root = mkdtempSync(resolve(os.tmpdir(), 'aiden-process-owner-'));
    const script = resolve(root, 'owner.mjs');
    writeFileSync(script, "console.log('hi');\n", 'utf8');
    // stub the registry.spawn creation-time via a spy on the instance method's default:
    const spy = vi.spyOn(r, 'spawn');
    try {
      const out = (await processSpawnTool.execute(
        { runtime: 'node', executable: process.execPath, script, args: [], cwd: root },
        { ...ctx(r, 'sess-xyz'), cwd: root },
      )) as { success: boolean; id: string };
      expect(out.success).toBe(true);
      // the tool forwarded exact argv without a shell and retained ownership
      expect(spy).toHaveBeenCalledWith(
        process.execPath,
        expect.objectContaining({ sessionId: 'sess-xyz', shell: false, args: expect.arrayContaining([realpathSync.native(script)]) }),
      );
      const h = r.get(out.id)!;
      expect(h.ownerSessionId).toBe('sess-xyz');
    } finally {
      r.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PM.1 — wiring: process_* reachable in the REPL/daemon executor (dormancy fixed)', () => {
  it('★ aidenCLI wires ctx.processes into the shared tool-executor context', () => {
    const src = readFileSync(resolve(__dirname, '../../cli/v4/aidenCLI.ts'), 'utf8');
    // The load-bearing wire-up: a ProcessRegistry is created and put on the
    // executor context (which the daemon reuses) — so process_* stop returning
    // "process registry not configured" in a real session.
    expect(src).toMatch(/new ProcessRegistry\(\)/);
    expect(src).toMatch(/processes:\s*processRegistry/);
  });

  it('process tools return "not configured" ONLY when ctx.processes is absent (proves the wire-up matters)', async () => {
    const bare = { cwd: process.cwd(), paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-pm1-bare' }) } as ToolContext;
    const out = (await processListTool.execute({}, bare)) as { success: boolean; error?: string };
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });
});
