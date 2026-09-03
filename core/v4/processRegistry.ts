/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/processRegistry.ts — Aiden v4.0.0
 *
 * Background-process registry. Long-running commands (dev servers,
 * builds, watchers) the agent kicks off live here so the loop can
 * spawn them, stream their output back later, and reap them on
 * shutdown. Synchronous one-shot commands stay in the `shell_exec`
 * tool — only background work (`process_spawn`) lands in the
 * registry.
 *
 * v4 ships local-only here and routes Docker through `shell_exec`
 * instead — multi-environment sandboxing is not in scope for v4.0.
 *
 * Status: PHASE 8.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killProcessTree, getProcessCreationTime } from './util/spawnCommand';

export interface ProcessHandle {
  id: string;
  command: string;
  pid: number;
  /** Wall-clock ms when spawn() ran (for display/ordering). */
  startedAt: number;
  status: 'running' | 'exited' | 'killed';
  exitCode?: number;
  exitedAt?: number;
  /**
   * v4.12 PM.1 — the identity foundation. OS/kernel process creation-time
   * (epoch ms), best-effort; undefined when the query failed. PID + createdAt
   * is the practical process identity (PID alone is reused — the Firefox
   * lesson). PM.3 verifies this before signalling a recovered pid.
   */
  createdAt?: number;
  /** v4.12 PM.1 — resolved working directory the process was spawned in. */
  cwd?: string;
  /** v4.12 PM.1 — owning session/task id (best-effort from ctx.sessionId). */
  ownerSessionId?: string;
}

interface Slot {
  handle: ProcessHandle;
  child: ChildProcess;
  log: string[];
  waiters: Array<(h: ProcessHandle) => void>;
  /** v4.12 PM.1 — idempotency guard for move-to-finished (exit+error race). */
  finished: boolean;
  /** v4.12 PM.1 — pending graceful→force escalation timer, if any. */
  forceTimer?: ReturnType<typeof setTimeout>;
  /** Exact Job execution signal which owns this background process. */
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  /** A dispatched tree kill remains authoritative even when Windows reports
   *  the eventual exit without a POSIX-style signal. */
  killRequested: boolean;
}

const MAX_LOG_LINES = 1000;

/** v4.12 PM.1 — grace window between a graceful tree-kill and the force tree-kill. */
const KILL_GRACE_MS = 2000;

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Keep the parent environment by default for legacy callers. Structured
   * local execution disables inheritance so provider and user secrets never
   * enter the child process. */
  inheritEnv?: boolean;
  /** Exact argv for a direct non-shell spawn. When present, `command` is the
   * executable and no whitespace parsing or shell interpolation occurs. */
  args?: readonly string[];
  /** When `true` (default), run the command via the platform shell
   *  (PowerShell on Windows, bash on POSIX). When `false`, the first
   *  whitespace-separated token is the executable; the rest are
   *  argv. */
  shell?: boolean;
  /** v4.12 PM.1 — owning session/task id, stored on the handle. */
  sessionId?: string;
  /** v4.12 PM.1 — creation-time provider (test seam). Defaults to the
   *  OS query in util/spawnCommand. Best-effort; undefined is fine. */
  getCreationTime?: (pid: number) => number | null;
  /** v4.12 PM.1 — override `child_process.spawn` (test seam) so idempotency /
   *  kill-routing can be driven with a fake child. Defaults to the real spawn. */
  spawnImpl?: typeof spawn;
  /** Exact Job execution signal. Cancellation reaps only this spawned tree. */
  signal?: AbortSignal;
}

export interface ProcessRegistryOptions {
  /** Override the tree-kill impl (test seam). Defaults to killProcessTree. */
  killTree?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  /** Override platform (test seam). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export class ProcessRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly killTree: (child: ChildProcess, signal: NodeJS.Signals) => void;
  private readonly platform: NodeJS.Platform;

  constructor(opts: ProcessRegistryOptions = {}) {
    this.killTree = opts.killTree ?? killProcessTree;
    this.platform = opts.platform ?? process.platform;
  }

  spawn(command: string, opts: SpawnOpts = {}): ProcessHandle {
    const id = randomUUID();
    const useShell = opts.shell !== false;
    const isWin = process.platform === 'win32';
    const spawnFn = opts.spawnImpl ?? spawn;

    let child: ChildProcess;
    if (opts.args) {
      if (useShell) throw new Error('Structured process arguments require shell:false');
      child = spawnFn(command, [...opts.args], {
        cwd: opts.cwd,
        env: opts.inheritEnv === false ? { ...(opts.env ?? {}) } : { ...process.env, ...(opts.env ?? {}) },
        ...(isWin ? {} : { detached: true }),
      });
    } else if (useShell) {
      if (isWin) {
        child = spawnFn('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
        });
      } else {
        child = spawnFn('bash', ['-lc', command], {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
        });
      }
    } else {
      const parts = command.split(/\s+/).filter(Boolean);
      const [exe, ...args] = parts;
      child = spawnFn(exe, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    }

    const resolvedCwd = opts.cwd ?? process.cwd();
    const pid = child.pid ?? -1;
    // ★ PM.1 — capture the OS creation-time NOW (the PID-identity foundation).
    // Best-effort: undefined when the process is too short-lived or the query
    // fails. `startedAt` (wall-clock) is kept separately for display/ordering.
    const getCreationTime = opts.getCreationTime ?? ((p: number) => getProcessCreationTime(p));
    const createdAt = pid > 0 ? (getCreationTime(pid) ?? undefined) : undefined;

    const handle: ProcessHandle = {
      id,
      command: opts.args ? [command, ...opts.args].map((part) => JSON.stringify(part)).join(' ') : command,
      pid,
      startedAt: Date.now(),
      status: 'running',
      createdAt,
      cwd: resolvedCwd,
      ownerSessionId: opts.sessionId,
    };
    const slot: Slot = { handle, child, log: [], waiters: [], finished: false, killRequested: false };
    this.slots.set(id, slot);

    // ★ PM.1 — idempotent move-to-finished. `exit` and `error` can BOTH fire
    // (e.g. spawn error then exit), and a kill races the natural exit; guard so
    // completion is recorded — and waiters notified — exactly once.
    const finish = (status: 'exited' | 'killed', exitCode: number | undefined) => {
      if (slot.finished) return;
      slot.finished = true;
      if (slot.forceTimer) { clearTimeout(slot.forceTimer); slot.forceTimer = undefined; }
      if (slot.abortSignal && slot.abortListener) {
        slot.abortSignal.removeEventListener('abort', slot.abortListener);
        slot.abortListener = undefined;
      }
      handle.exitedAt = Date.now();
      handle.exitCode = exitCode;
      handle.status = status;
      const waiters = slot.waiters.splice(0);
      for (const w of waiters) w(handle);
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        slot.log.push(line);
      }
      while (slot.log.length > MAX_LOG_LINES) slot.log.shift();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code, signal) => {
      const status = slot.killRequested || signal === 'SIGKILL' || signal === 'SIGTERM' ? 'killed' : 'exited';
      finish(status, typeof code === 'number' ? code : undefined);
    });

    child.on('error', (err) => {
      slot.log.push(`[spawn-error] ${err.message}`);
      finish('exited', -1);
    });

    if (opts.signal) {
      let handled = false;
      slot.abortSignal = opts.signal;
      slot.abortListener = () => {
        if (handled) return;
        handled = true;
        this.kill(id, 'SIGTERM');
      };
      opts.signal.addEventListener('abort', slot.abortListener, { once: true });
      if (opts.signal.aborted) slot.abortListener();
    }

    return handle;
  }

  list(): ProcessHandle[] {
    return [...this.slots.values()].map((s) => ({ ...s.handle }));
  }

  get(id: string): ProcessHandle | null {
    const slot = this.slots.get(id);
    return slot ? { ...slot.handle } : null;
  }

  readLog(id: string, lines = 100): string[] {
    const slot = this.slots.get(id);
    if (!slot) return [];
    if (lines <= 0) return [];
    return slot.log.slice(-lines);
  }

  /**
   * ★ PM.1 — TREE-kill (not parent-only), via the shared test-seamed
   * `killProcessTree` so the `powershell → node` (or `npx → node`) subtree dies
   * too — `child.kill()` alone orphans grandchildren (the Firefox lesson).
   *
   * Platform-honest escalation:
   *   - POSIX: graceful group SIGTERM → grace window → force group SIGKILL.
   *   - Windows: a SINGLE atomic force `taskkill /t /f` while the root is alive.
   *     Graceful-then-force CANNOT work for Windows console trees — a graceful
   *     `taskkill /t` (no `/f`) kills the root without reaping its console
   *     descendants, which then orphan (proven live). True Windows graceful
   *     signalling needs CREATE_NEW_PROCESS_GROUP + Ctrl+C (deferred to PM.4
   *     alongside Job Objects); until then, atomic force is the correct reap.
   * Returns true when a kill was dispatched (the exit handler flips status).
   */
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    if (slot.handle.status !== 'running') return false;

    if (this.platform === 'win32') {
      slot.killRequested = true;
      try { this.killTree(slot.child, 'SIGKILL'); } catch { slot.killRequested = false; return false; }
      return true;
    }

    // POSIX: graceful → grace window → force.
    slot.killRequested = true;
    try { this.killTree(slot.child, signal); } catch { slot.killRequested = false; return false; }
    if (signal !== 'SIGKILL' && !slot.forceTimer) {
      slot.forceTimer = setTimeout(() => {
        slot.forceTimer = undefined;
        if (slot.handle.status === 'running') {
          try { this.killTree(slot.child, 'SIGKILL'); } catch { /* already gone */ }
        }
      }, KILL_GRACE_MS);
      slot.forceTimer.unref?.();
    }
    return true;
  }

  waitFor(id: string, timeoutMs?: number): Promise<ProcessHandle> {
    const slot = this.slots.get(id);
    if (!slot) {
      return Promise.reject(new Error(`Unknown process id: ${id}`));
    }
    if (slot.handle.status !== 'running') {
      return Promise.resolve({ ...slot.handle });
    }
    return new Promise<ProcessHandle>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (h: ProcessHandle) => {
        if (timer) clearTimeout(timer);
        resolve({ ...h });
      };
      slot.waiters.push(finish);
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = slot.waiters.indexOf(finish);
          if (idx >= 0) slot.waiters.splice(idx, 1);
          reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /**
   * ★ PM.1 — reap all tracked running processes (wired into REPL shutdown /
   * session-end so spawns aren't orphaned). Force TREE-kill each so no
   * grandchild survives; mark finished synchronously (idempotent) so a racing
   * exit handler doesn't double-report. PM.2 refines this to owner-scoped
   * reaping with a durable-daemon exemption; PM.1 reaps all (the app is exiting).
   */
  cleanup(): void {
    for (const slot of this.slots.values()) {
      if (slot.forceTimer) { clearTimeout(slot.forceTimer); slot.forceTimer = undefined; }
      if (slot.abortSignal && slot.abortListener) {
        slot.abortSignal.removeEventListener('abort', slot.abortListener);
        slot.abortListener = undefined;
      }
      if (slot.handle.status === 'running') {
        slot.killRequested = true;
        try { this.killTree(slot.child, 'SIGKILL'); } catch { /* ignore */ }
        if (!slot.finished) {
          slot.finished = true;
          slot.handle.status = 'killed';
          slot.handle.exitedAt = Date.now();
        }
      }
    }
  }
}
