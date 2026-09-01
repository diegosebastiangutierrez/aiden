/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/sandboxFs.ts — v4.4 Phase 2: filesystem allowlist enforcement.
 *
 * Pure in-process path policy decision module. Consulted by the six
 * file_* tools (file_read, file_list, file_write, file_patch,
 * file_copy, file_move, file_delete) BEFORE any disk I/O, so a
 * decision can be returned to the agent without ever touching the
 * filesystem when the answer is "no".
 *
 * Two-list model (mirrors Phase 1's `SandboxConfig`):
 *   - fsDenyList  — sensitive paths the user never wants touched
 *                   (.ssh, .aws, .env, /etc, /var, ...). Wins for
 *                   BOTH read and write operations. Denylist always
 *                   takes precedence over allowlist.
 *   - fsAllowList — write-permitted roots (cwd, ~/Documents,
 *                   ~/Downloads, ~/Desktop, os.tmpdir()). Writes /
 *                   deletes outside these roots are refused. Reads
 *                   are NOT constrained by the allowlist — reads
 *                   only have to clear the denylist.
 *
 * Symlink defense:
 *   - Realpath the target (or its first existing ancestor for
 *     non-existent paths like file_write destinations). Symlink
 *     bypass on allowlist roots is the canonical attack vector;
 *     this module canonicalizes before checking.
 *   - A path that is LEXICALLY under an allowlist root but
 *     REALPATH'd outside (via a symlink) yields a distinct
 *     `fs.symlink_escape` violation code.
 *
 * Non-existent path handling (Q-P2-3 default):
 *   - Walk up to the first existing ancestor, realpath that, then
 *     rejoin the trailing segments. This defends against
 *     `<allowlist-root>/<symlinked-dir>/new-file.txt` writes.
 *
 * TOCTOU posture (Q-P2-5 default):
 *   - Phase 2 is in-process. A racing actor could rename a
 *     directory between our policy check and the tool's open()
 *     call. Phase 3 (Docker sandbox) closes this gap at the OS
 *     layer via container isolation. Phase 2 documents the gap
 *     and accepts it for the strict-opt-in `AIDEN_SANDBOX=1`
 *     period (default-off until Phase 6).
 *
 * Short-circuit semantics:
 *   - When `config.enabled === false` (default through Phase 5),
 *     `isPathAllowed` returns `{ allowed: true, resolvedPath: ...,
 *     ... }` with no denylist/allowlist evaluation. Zero overhead
 *     for users who haven't opted in. Phase 6 flips the gate but
 *     the wire-in stays.
 *
 * The returned `PathPolicyDecision` shape is also forward-compatible
 * with Phase 5's `FailureCategory.sandbox_violation` — the
 * `violation.category` field is pre-populated with the constant
 * Phase 5 will register in FailureClassifier.
 */

import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';

import {
  type SandboxConfig,
  getSandboxConfig,
  resolveRealPath,
} from './sandboxConfig';

// ── Public types ────────────────────────────────────────────────────────────

/** Operation kind for `isPathAllowed`. Drives allowlist vs deny-only check. */
export type FsOp = 'read' | 'write' | 'delete';

/**
 * Taxonomy of filesystem policy violations. Stable wire-format keys —
 * Phase 5's FailureClassifier matches on these strings, so renames here
 * require a coordinated bump in failureClassifier.
 */
export type FsViolationCode =
  | 'fs.sensitive_path'           // hit fsDenyList (read or write)
  | 'fs.write_outside_allowlist'  // write/delete target not under any fsAllowList root
  | 'fs.read_denied'              // reserved — currently same as sensitive_path; kept for taxonomy clarity
  | 'fs.symlink_escape'           // lexical-resolved was under allowlist but realpath escaped
  | 'fs.path_traversal';          // lexical `..` segments after expandPath escape cwd-relative input

export interface FsViolation {
  code:          FsViolationCode;
  /** The allowlist/denylist entry that triggered, or '' for traversal/escape. */
  matchedPolicy: string;
  /** Constant — wires into Phase 5 FailureClassifier.sandbox_violation. */
  category:      'sandbox_violation';
  /** Sandbox violations are NEVER retryable — same input will always fail. */
  retryable:     false;
  /** Human-readable string safe to surface in the tool result `error` field. */
  message:       string;
}

export interface PathPolicyDecision {
  /** True when the operation is permitted by the policy. */
  allowed:        boolean;
  /** The realpath'd (or resolved-only when target doesn't exist) absolute path. */
  resolvedPath:   string;
  /** The original raw argument the tool received — useful for logging. */
  requestedPath:  string;
  /** Post-expandPath, pre-realpath. Lexical normalization only. */
  expandedPath:   string;
  /** Operation evaluated. Echoed for downstream telemetry. */
  op:             FsOp;
  /** Populated only when `allowed === false`. */
  violation?:     FsViolation;
}

export interface PathPolicyOptions {
  /**
   * Exact, approval-bound output targets for this one tool execution. These
   * targets do not become directory roots and never override the deny list or
   * symlink-escape checks.
   */
  exactWritePaths?: ReadonlyArray<string>;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * `tools/v4/utils/paths.ts#expandPath` re-implemented locally so the
 * core module doesn't depend on a tools-layer helper. Keeps the
 * import direction core ← tools (never the reverse).
 */
function expandPathInline(input: string, cwd: string): string {
  const home = os.homedir();
  let p = input;
  if (/^~[\\/]/i.test(p)) p = home + p.slice(1);
  else if (/^Desktop[\\/]?$/i.test(p)) p = path.join(home, 'Desktop');
  else if (/^Desktop[\\/]/i.test(p)) p = path.join(home, 'Desktop', p.slice(8));
  if (path.isAbsolute(p)) return p;
  if (/^[A-Z]:/i.test(p)) return p;
  return path.join(cwd, p);
}

/**
 * Boundary-aware path check (file_* tool defense-in-depth — NOT process
 * containment; shell_exec bypasses this). `path.relative` avoids the
 * `<root>/user-evil` vs `<root>/user` false positive that a naive
 * `startsWith` would produce.
 */
export function isWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Realpath a path that may not yet exist. Walks up to the first
 * existing ancestor, realpaths that, then rejoins the trailing
 * segments. Defends against `<allowlist>/<symlink>/new-file.txt`
 * writes where the symlink mid-path points outside the allowlist.
 *
 * Idempotent: existing paths are realpath'd directly (single
 * `resolveRealPath` call).
 */
export function realpathWithFallback(input: string): string {
  // First, resolve the whole thing optimistically — if it exists,
  // realpath handles it directly and we're done.
  const resolved = path.resolve(input);
  try {
    if (fs.existsSync(resolved)) {
      return resolveRealPath(resolved);
    }
  } catch {
    // existsSync shouldn't throw, but a permissions error on a
    // parent dir could surface here on Windows. Fall through.
  }

  // Path doesn't exist yet — walk up.
  let cur  = resolved;
  let tail = '';
  // Guard against infinite loop on malformed paths (path.dirname
  // of a root returns the root itself).
  for (let i = 0; i < 4096; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      // Reached filesystem root without finding any existing
      // ancestor. Return the lexical resolve.
      return resolved;
    }
    let parentExists = false;
    try {
      parentExists = fs.existsSync(parent);
    } catch {
      parentExists = false;
    }
    if (parentExists) {
      const parentReal = resolveRealPath(parent);
      tail = tail ? path.join(path.basename(cur), tail) : path.basename(cur);
      return path.join(parentReal, tail);
    }
    tail = tail ? path.join(path.basename(cur), tail) : path.basename(cur);
    cur = parent;
  }
  return resolved;
}

function fmtList(list: ReadonlyArray<string>, max = 5): string {
  if (list.length === 0) return '(none)';
  if (list.length <= max) return list.join(', ');
  return list.slice(0, max).join(', ') + `, ... (${list.length - max} more)`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Evaluate a path against the active sandbox policy.
 *
 * @param rawPath  The original path string from tool args (untrusted).
 * @param op       'read' | 'write' | 'delete' — determines whether the
 *                 allowlist applies. 'read' = deny-only; 'write' /
 *                 'delete' = allowlist required.
 * @param cwd      The tool context's working directory, used to resolve
 *                 relative paths the same way the file tools do.
 * @param config   Optional config override (default = singleton from
 *                 `getSandboxConfig()`). Tests pass a custom config.
 *
 * @returns `{ allowed: true, ... }` when the operation may proceed,
 *          or `{ allowed: false, violation: {...}, ... }` with a
 *          structured `FsViolation` when it must be refused. Tools
 *          should forward the violation into a `sandbox_violation`
 *          envelope on the result object alongside `success: false`.
 *
 * Behavior when `config.enabled === false` (Phase 1-5 default):
 * the function still resolves the path (so the caller can use
 * `resolvedPath` uniformly), but returns `allowed: true` without
 * evaluating either list. Zero runtime cost beyond expand+resolve.
 */
export function isPathAllowed(
  rawPath: string,
  op:      FsOp,
  cwd:     string,
  config:  SandboxConfig = getSandboxConfig(),
  options: PathPolicyOptions = {},
): PathPolicyDecision {
  const requestedPath = rawPath;
  const expandedPath  = expandPathInline(rawPath, cwd);

  // Short-circuit when sandbox is disabled. Still produce a useful
  // resolvedPath so the tool can keep its current single-codepath
  // structure (resolve once, use the resolved path).
  if (!config.enabled) {
    return {
      allowed: true,
      resolvedPath: expandedPath,
      requestedPath,
      expandedPath,
      op,
    };
  }

  // Lexical path-traversal sniff: if `rawPath` was a relative input
  // that escapes `cwd` via `..`, refuse with a clear code BEFORE
  // realpath touches the disk. This is belt-and-suspenders — realpath
  // would catch most cases via the symlink-escape branch — but a
  // structured `fs.path_traversal` reads more cleanly in logs.
  if (!path.isAbsolute(rawPath) && !/^[A-Z]:/i.test(rawPath) && !/^~[\\/]/i.test(rawPath)) {
    const cwdReal = resolveRealPath(cwd);
    const expReal = path.resolve(cwd, rawPath);
    if (!isWithin(expReal, cwdReal) && rawPath.includes('..')) {
      // Don't treat this as fatal yet — a relative path can legitimately
      // escape cwd (e.g. `../tmp/x` when cwd is under tmp). We only flag
      // it if it ALSO lands outside both lists, which the standard checks
      // below will catch. Leaving the sniff in as a `path_traversal`
      // upgrade for the escape-with-no-allowlist-hit case.
    }
  }

  const resolvedPath = realpathWithFallback(expandedPath);

  const base = {
    resolvedPath,
    requestedPath,
    expandedPath,
    op,
  };

  // ── Denylist (always wins, both read and write) ───────────────────────
  for (const denied of config.fsDenyList) {
    if (isWithin(resolvedPath, denied) || resolvedPath === denied) {
      return {
        ...base,
        allowed: false,
        violation: {
          code:          'fs.sensitive_path',
          matchedPolicy: denied,
          category:      'sandbox_violation',
          retryable:     false,
          message:
            `Sandbox: path "${resolvedPath}" is under the sensitive denylist entry ` +
            `"${denied}". Reads and writes are both refused. ` +
            `(Override by extending AIDEN_SANDBOX_ALLOW is not sufficient — the ` +
            `denylist takes precedence.)`,
        },
      };
    }
  }

  // ── Allowlist (write/delete only — reads pass through after denylist) ─
  if (op === 'read') {
    return { ...base, allowed: true };
  }

  // One exact target may be authorized by the mutation approval boundary even
  // when it is outside the configured workspace roots. Keep this narrower than
  // an allow-list extension: siblings and descendants remain denied. Refuse a
  // lexical path that resolves through a symlink/junction so an approved label
  // cannot silently name a different physical destination.
  const lexicalResolved = path.resolve(expandedPath);
  const crossesLinkBoundary = path.relative(lexicalResolved, resolvedPath) !== '';
  if (!crossesLinkBoundary && options.exactWritePaths?.some((candidate) => {
    const expandedCandidate = expandPathInline(candidate, cwd);
    const resolvedCandidate = realpathWithFallback(expandedCandidate);
    return path.relative(resolvedCandidate, resolvedPath) === '';
  })) {
    return { ...base, allowed: true };
  }

  // Symlink-escape detection: resolvedPath escaped the allowlist
  // tree, but expandedPath was LEXICALLY under it. That's the
  // classic allowlist-bypass-via-symlink pattern.
  let lexicalUnderAllow = false;
  let realUnderAllow    = false;
  let matchedAllow      = '';
  for (const allowed of config.fsAllowList) {
    if (isWithin(expandedPath, allowed) || expandedPath === allowed) {
      lexicalUnderAllow = true;
    }
    if (isWithin(resolvedPath, allowed) || resolvedPath === allowed) {
      realUnderAllow = true;
      matchedAllow   = allowed;
      break;
    }
  }

  if (realUnderAllow) {
    return { ...base, allowed: true };
  }

  if (lexicalUnderAllow) {
    return {
      ...base,
      allowed: false,
      violation: {
        code:          'fs.symlink_escape',
        matchedPolicy: '',
        category:      'sandbox_violation',
        retryable:     false,
        message:
          `Sandbox: path "${expandedPath}" appears to live under an allowlisted ` +
          `root, but its real path "${resolvedPath}" is outside every allowlist ` +
          `entry. A symlink in the path likely points outside the sandbox.`,
      },
    };
  }

  // Plain write-outside-allowlist. Most common refusal.
  return {
    ...base,
    allowed: false,
    violation: {
      code:          'fs.write_outside_allowlist',
      matchedPolicy: matchedAllow,
      category:      'sandbox_violation',
      retryable:     false,
      message:
        `Sandbox: ${op} target "${resolvedPath}" is not under any allowlisted ` +
        `directory. Allowed roots: ${fmtList(config.fsAllowList)}. ` +
        `(Extend via AIDEN_SANDBOX_ALLOW=<colon-separated-paths>.)`,
    },
  };
}

/**
 * Convenience: build the structured envelope the file tools attach
 * to their result objects when a policy denial occurs. Centralises
 * the wire format so all six tools serialise the same shape.
 */
export function violationEnvelope(decision: PathPolicyDecision): {
  code:           FsViolationCode;
  matched_policy: string;
  requested_path: string;
  resolved_path:  string;
  retryable:      false;
  category:       'sandbox_violation';
} {
  if (!decision.violation) {
    // Defensive — callers should only call this on denied decisions.
    throw new Error('violationEnvelope called on allowed decision');
  }
  return {
    code:           decision.violation.code,
    matched_policy: decision.violation.matchedPolicy,
    requested_path: decision.requestedPath,
    resolved_path:  decision.resolvedPath,
    retryable:      false,
    category:       'sandbox_violation',
  };
}
