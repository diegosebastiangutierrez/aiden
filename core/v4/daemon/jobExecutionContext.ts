/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { JobEngine, TransitionResult } from './jobEngine';
import type { JobControlAuthority } from './jobControlAuthority';
import type { DurableEffectDescriptor } from '../effectContract';
import type { RepositorySnapshotAuthority } from '../codebase/repositorySnapshotAuthority';
import type { SafeChangeAuthority } from '../codebase/safeChangeAuthority';
import type {
  StructuredValidationAuthority,
  ValidationEnvironment,
} from '../codebase/structuredValidationAuthority';
import { runtimeArtifactDirectory } from '../runtimeStorage';

export interface RepositoryExecutionBinding {
  rootPath: string;
  inspection: {
    snapshotId: string;
    rootPath: string;
    authority: RepositorySnapshotAuthority;
  };
  change: {
    baseSnapshotId: string;
    rootPath: string;
    authority: SafeChangeAuthority;
  };
  validation: {
    baseSnapshotId: string;
    rootPath: string;
    authority: StructuredValidationAuthority;
    environment: ValidationEnvironment;
  };
  advance(snapshotId: string): void;
}

export interface JobExecutionContext {
  engine: JobEngine;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  producer: string;
  signal?: AbortSignal;
  controlAuthority?: JobControlAuthority;
  workspacePath?: string;
  repository?: RepositoryExecutionBinding;
  repositoryPromise?: Promise<RepositoryExecutionBinding>;
  /** Source keys already promoted to Evidence during this Attempt. */
  researchEvidenceKeys?: Set<string>;
  /** Exact persisted model-call identities allowed to recover once after host restart. */
  resumableToolCallIds?: Set<string>;
}

const storage = new AsyncLocalStorage<JobExecutionContext>();
const durableToolCallStorage = new AsyncLocalStorage<PreparedDurableToolCall>();

export function runWithJobExecutionContext<T>(context: JobExecutionContext, operation: () => T): T {
  return storage.run(context, operation);
}

export function currentJobExecutionContext(): JobExecutionContext | undefined {
  return storage.getStore();
}

export function bindResumableDurableToolCalls(toolCallIds: readonly string[]): void {
  const context = currentJobExecutionContext();
  if (!context) {
    if (toolCallIds.length > 0) throw new Error('Durable tool-call resume requires an active Job execution context');
    return;
  }
  context.resumableToolCallIds = new Set(toolCallIds);
}

/** Exact persisted ToolCall currently dispatching physical work. */
export function currentPreparedDurableToolCall(): PreparedDurableToolCall | undefined {
  return durableToolCallStorage.getStore();
}

/** Lazily bind repository tools to the exact active Attempt and source snapshot. */
export async function ensureRepositoryExecutionBinding(
  context: JobExecutionContext,
): Promise<RepositoryExecutionBinding | undefined> {
  if (context.repository) return context.repository;
  if (!context.workspacePath) return undefined;
  if (!context.repositoryPromise) {
    context.repositoryPromise = (async () => {
      const existing = context.engine.repository.getAttemptSnapshot(context.jobId, context.attemptId);
      const snapshot = existing ?? await context.engine.repository.captureSnapshot({
        jobId: context.jobId,
        attemptId: context.attemptId,
        generation: context.generation,
        fenceToken: context.fenceToken,
        requestedPath: context.workspacePath!,
        producer: context.producer,
      });
      const workspace = context.engine.repository.getWorkspace(snapshot.workspaceId);
      if (!workspace) throw new Error('Repository workspace binding is unavailable');
      const rootPath = snapshot.repositoryRoot ?? workspace.canonicalPath;
      const inspection = {
        snapshotId: snapshot.id,
        rootPath,
        authority: context.engine.repository,
      };
      const change = {
        baseSnapshotId: snapshot.id,
        rootPath,
        authority: context.engine.changes,
      };
      const validation = {
        baseSnapshotId: snapshot.id,
        rootPath,
        authority: context.engine.validation,
        environment: {
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version,
          npmVersion: process.env.npm_config_user_agent?.match(/\bnpm\/([^\s]+)/)?.[1] ?? 'unknown',
          variables: {
            CI: process.env.CI ?? '',
            NODE_ENV: process.env.NODE_ENV ?? '',
          },
        },
      };
      const binding: RepositoryExecutionBinding = {
        rootPath,
        inspection,
        change,
        validation,
        advance(snapshotId) {
          inspection.snapshotId = snapshotId;
          change.baseSnapshotId = snapshotId;
          validation.baseSnapshotId = snapshotId;
        },
      };
      context.repository = binding;
      return binding;
    })();
  }
  try {
    return await context.repositoryPromise;
  } catch (error) {
    context.repositoryPromise = undefined;
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function normalizedArgsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(args))).digest('hex');
}

function opaqueReference(prefix: string, value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value));
  } catch {
    serialized = String(value);
  }
  return `${prefix}:sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function durableToolCallId(context: JobExecutionContext, modelCallId: string): string {
  return `tool-call:sha256:${createHash('sha256')
    .update(`${context.attemptId}\0${context.generation}\0${modelCallId}`)
    .digest('hex')}`;
}

/** Resolve the stable persisted ToolCall identity for the active Attempt. */
export function currentDurableToolCallId(modelCallId: string): string | null {
  const context = currentJobExecutionContext();
  return context ? durableToolCallId(context, modelCallId) : null;
}

export class DurableToolCallConflictError extends Error {
  constructor(readonly operation: string, readonly result: TransitionResult) {
    super(`Durable ToolCall ${operation} rejected: ${result.conflict ?? 'duplicate'}`);
    this.name = 'DurableToolCallConflictError';
  }
}

export interface PreparedDurableToolCall {
  toolCallId: string;
  effectId: string | null;
  mutates: boolean;
  effect?: DurableEffectDescriptor;
  recoveryDisposition?: 'prepared' | 'committed' | 'unknown';
}

function requireApplied(operation: string, result: TransitionResult): void {
  if (!result.applied && !result.duplicate) {
    throw new DurableToolCallConflictError(operation, result);
  }
}

export function prepareDurableToolCall(command: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskTier: string;
  mutates: boolean;
  effect?: DurableEffectDescriptor;
  approvalState?: 'not_required' | 'pending';
  allowExactMutationRecovery?: boolean;
}): PreparedDurableToolCall | null {
  const context = currentJobExecutionContext();
  if (!context) return null;
  const toolCallId = durableToolCallId(context, command.toolCallId);
  const argsDigest = normalizedArgsDigest(command.args);
  const effect = command.mutates ? command.effect : undefined;
  const reconciliationData = effect?.reconciliationData ? { ...effect.reconciliationData } : null;
  if (reconciliationData?.path && effect?.kind.startsWith('filesystem.')) {
    try {
      if (!existsSync(reconciliationData.path)) {
        reconciliationData.before = { exists: false };
      } else {
        const stat = statSync(reconciliationData.path);
        reconciliationData.before = {
          exists: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ...(stat.isFile() ? {
            contentSha256: createHash('sha256').update(readFileSync(reconciliationData.path)).digest('hex'),
          } : {}),
        };
      }
    } catch {
      reconciliationData.before = undefined;
    }
  }
  const result = context.engine.prepareToolCall({
    toolCallId,
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    modelCallId: command.toolCallId,
    toolName: command.toolName,
    normalizedArgsDigest: argsDigest,
    riskTier: command.riskTier,
    mutates: command.mutates,
    effect: effect && effect.classification !== 'read_only' ? {
      classification: effect.classification,
      kind: effect.kind,
      target: effect.target,
      retrySafety: effect.retrySafety,
      idempotencySupported: effect.idempotencySupported,
      idempotencyKey: effect.idempotencySupported
        ? createHash('sha256').update(`${command.toolName}\0${argsDigest}`).digest('hex')
        : null,
      reconciliationSupported: effect.reconciliationSupported,
      verificationSupported: effect.verificationSupported,
      approvalRequirement: effect.approvalRequirement,
      approvalState: command.approvalState ?? 'not_required',
      sensitiveFields: effect.sensitiveFields,
      redactionRules: effect.redactionRules,
      trusted: effect.trusted,
      reconciliationData,
    } : undefined,
    producer: context.producer,
  });
  const persistedResumeAuthorized = context.resumableToolCallIds?.has(command.toolCallId) === true;
  context.resumableToolCallIds?.delete(command.toolCallId);
  let recoveryDisposition: PreparedDurableToolCall['recoveryDisposition'];
  if (result.duplicate && command.mutates) {
    if (!command.allowExactMutationRecovery && !persistedResumeAuthorized) {
      throw new DurableToolCallConflictError('duplicate mutation', result);
    }
    recoveryDisposition = result.existingToolCallState === 'prepared'
      && ['requested', 'approved'].includes(result.existingEffectState ?? '')
      ? 'prepared'
      : result.existingToolCallState === 'completed' && result.existingEffectState === 'committed'
        ? 'committed'
        : 'unknown';
  }
  requireApplied('prepare', result);
  return {
    toolCallId,
    effectId: result.effectId ?? null,
    mutates: command.mutates,
    ...(effect ? { effect } : {}),
    ...(recoveryDisposition ? { recoveryDisposition } : {}),
  };
}

function captureDurableFileProof(
  context: JobExecutionContext,
  prepared: PreparedDurableToolCall,
): void {
  const effect = prepared.effect;
  if (!prepared.effectId || effect?.kind !== 'filesystem.write' || !effect.verificationSupported) return;
  const expected = effect.reconciliationData;
  const target = expected?.path;
  const claim = context.engine.proof.createClaim({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    category: 'contract',
    statement: `file write matches requested content: ${effect.target ?? target ?? 'target'}`,
    required: true,
  });
  let payload: Record<string, unknown> = { path: target ?? effect.target, exists: false, exact: false };
  let verificationResult: 'verified' | 'failed' | 'unknown' = 'unknown';
  let coverage: 'full' | 'unknown' = 'unknown';
  try {
    if (!target || !existsSync(target)) {
      payload = { ...payload, exists: false };
      verificationResult = 'failed';
      coverage = 'full';
    } else {
      const bytes = readFileSync(target);
      const stat = statSync(target);
      const contentSha256 = createHash('sha256').update(bytes).digest('hex');
      const exact = expected?.expectedContentSha256 !== undefined
        && expected.expectedSize !== undefined
        && contentSha256 === expected.expectedContentSha256
        && stat.size === expected.expectedSize;
      payload = { path: target, exists: true, size: stat.size, contentSha256, exact };
      verificationResult = exact ? 'verified' : 'failed';
      coverage = 'full';
    }
  } catch (error) {
    payload = {
      path: target ?? effect.target,
      exists: null,
      exact: null,
      captureError: error instanceof Error ? error.name : 'Error',
    };
  }
  const observedAt = Date.now();
  const evidence = context.engine.proof.recordEvidence({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    effectId: prepared.effectId,
    source: 'filesystem.readback',
    producer: context.producer,
    observedAt,
    freshUntil: observedAt + 60_000,
    coverage,
    verificationResult,
    payload,
  });
  context.engine.proof.checkClaim({
    claimId: claim.claimId,
    attemptId: context.attemptId,
    generation: context.generation,
    evidenceIds: [evidence.evidenceId],
    state: verificationResult,
  });
}

function captureDurableReadProof(context: JobExecutionContext, prepared: PreparedDurableToolCall, result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const value = result as Record<string, unknown>;
  if (value.success !== true || typeof value.path !== 'string') return;
  const hash = value.pageContentHash ?? value.contentHash;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) return;
  // A repeated-read stub is emitted only after the handler reads and hashes
  // the same range again. Never persist the file's contents in Proof.
  if (typeof value.content === 'string') {
    if (createHash('sha256').update(value.content).digest('hex') !== hash) return;
  } else if (value.stub !== true) return;
  const existing = context.engine.proof.listEvidence(context.jobId).some((item) =>
    item.attemptId === context.attemptId && item.source === 'filesystem.read'
    && (item.payload as { toolCallId?: string } | null)?.toolCallId === prepared.toolCallId);
  if (existing) return;
  const claim = context.engine.proof.createClaim({
    jobId: context.jobId, attemptId: context.attemptId, generation: context.generation,
    category: 'contract', required: true,
    statement: `file read returned an integrity-checked range: ${value.path}`,
  });
  const evidence = context.engine.proof.recordEvidence({
    jobId: context.jobId, attemptId: context.attemptId, generation: context.generation,
    fenceToken: context.fenceToken, source: 'filesystem.read', producer: context.producer,
    observedAt: Date.now(), coverage: 'full', verificationResult: 'verified',
    repositorySnapshotId: typeof value.snapshotId === 'string' ? value.snapshotId : null,
    payload: {
      toolCallId: prepared.toolCallId, path: value.path,
      rangeHash: hash, offset: value.offset, limit: value.limit,
      size: value.size, truncated: value.truncated === true,
      fullContentHash: typeof value.fullContentHash === 'string' ? value.fullContentHash : null,
      scope: 'returned_file_range',
    },
  });
  context.engine.proof.checkClaim({
    claimId: claim.claimId, attemptId: context.attemptId, generation: context.generation,
    evidenceIds: [evidence.evidenceId], state: 'verified',
  });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function captureDurableArtifactProof(
  context: JobExecutionContext,
  prepared: PreparedDurableToolCall,
  toolName: string,
  result: unknown,
): void {
  const effect = prepared.effect;
  if (!prepared.effectId || effect?.kind !== 'artifact.capture' || !effect.verificationSupported) return;
  const claim = context.engine.proof.createClaim({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    category: 'contract',
    statement: `runtime artifact was captured and read back: ${toolName}`,
    required: true,
  });
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const resultPath = typeof record.path === 'string' ? record.path.trim() : '';
  const observedAt = Date.now();
  const browserState = record.browserState && typeof record.browserState === 'object'
    ? record.browserState as Record<string, unknown>
    : null;
  const postState = browserState?.post_state && typeof browserState.post_state === 'object'
    ? browserState.post_state as Record<string, unknown>
    : null;
  const browserMetadata = {
    ...(typeof record.browserSessionId === 'string' ? { browserSessionId: record.browserSessionId } : {}),
    ...(typeof record.tabId === 'string' ? { tabId: record.tabId } : {}),
    ...(typeof postState?.normalized_url === 'string' ? { capturedUrl: postState.normalized_url } : {}),
    ...(typeof postState?.title === 'string' ? { capturedTitle: postState.title } : {}),
    capturedAt: observedAt,
  };
  let payload: Record<string, unknown> = {
    tool: toolName,
    sourceName: resultPath ? path.basename(resultPath.replace(/\\/g, '/')) : null,
    exists: false,
    exact: false,
    ...browserMetadata,
  };
  let coverage: 'full' | 'unknown' = 'full';
  let verificationResult: 'verified' | 'failed' | 'unknown' = 'failed';
  try {
    if (!resultPath) throw new Error('missing_artifact_path');
    const unresolvedCandidate = path.resolve(resultPath);
    const sourceStat = lstatSync(unresolvedCandidate);
    if (sourceStat.isSymbolicLink()) throw new Error('artifact_symlink_rejected');
    const candidate = realpathSync(unresolvedCandidate);
    const allowedRoots = [runtimeArtifactDirectory('screenshots'), runtimeArtifactDirectory('downloads')]
      .flatMap((root) => {
        try { return [realpathSync(root)]; } catch { return []; }
      });
    if (!sourceStat.isFile() || !allowedRoots.some((root) => isInside(root, candidate))) {
      payload = { ...payload, exists: sourceStat.isFile(), exact: false, reason: 'outside_runtime_artifact_authority' };
    } else {
      const bytes = readFileSync(candidate);
      payload = {
        tool: toolName,
        sourceName: path.basename(candidate),
        exists: true,
        size: bytes.byteLength,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        exact: true,
        ...browserMetadata,
      };
      verificationResult = 'verified';
    }
  } catch (error) {
    if (resultPath && !existsSync(resultPath)) {
      payload = { ...payload, exists: false, exact: false, reason: 'artifact_missing' };
    } else if (resultPath) {
      coverage = 'unknown';
      verificationResult = 'unknown';
      payload = { ...payload, exists: null, exact: null, reason: error instanceof Error ? error.name : 'Error' };
    }
  }
  const evidence = context.engine.proof.recordEvidence({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    effectId: prepared.effectId,
    source: 'artifact.readback',
    producer: context.producer,
    observedAt,
    freshUntil: null,
    coverage,
    verificationResult,
    payload,
  });
  context.engine.proof.checkClaim({
    claimId: claim.claimId,
    attemptId: context.attemptId,
    generation: context.generation,
    evidenceIds: [evidence.evidenceId],
    state: verificationResult,
  });
}

export function recordDurableToolApproval(command: {
  prepared: PreparedDurableToolCall | null;
  state: 'not_required' | 'pending' | 'approved' | 'denied' | 'interrupted' | 'timed_out' | 'blocked';
  approvalId?: string | null;
  actionDigest?: string | null;
}): void {
  if (!command.prepared?.effectId) return;
  const context = currentJobExecutionContext();
  if (!context) return;
  requireApplied('approval', context.engine.resolveToolCallApproval({
    toolCallId: command.prepared.toolCallId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    state: command.state,
    approvalId: command.approvalId,
    actionDigest: command.actionDigest,
    producer: context.producer,
  }));
}

export async function executeWithDurableToolCall<T>(command: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskTier: string;
  mutates: boolean;
  effect?: DurableEffectDescriptor;
  prepared?: PreparedDurableToolCall | null;
  execute: () => Promise<T>;
  isSuccessful?: (result: T) => boolean;
  captureFilesystemProof?: boolean;
}): Promise<T> {
  const context = currentJobExecutionContext();
  if (!context) return command.execute();

  const prepared = command.prepared ?? prepareDurableToolCall(command);
  if (!prepared) return command.execute();
  const toolCallId = prepared.toolCallId;
  requireApplied('start', context.engine.startToolCall({
    toolCallId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    producer: context.producer,
  }));

  try {
    const result = await durableToolCallStorage.run(prepared, command.execute);
    const succeeded = command.isSuccessful?.(result) ?? true;
    requireApplied('complete', context.engine.completeToolCall({
      toolCallId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      state: succeeded ? 'completed' : 'failed',
      sideEffectState: command.mutates ? (succeeded ? 'committed' : 'unknown') : undefined,
      resultRef: opaqueReference('tool-result', result),
      producer: context.producer,
    }));
    if (succeeded && command.captureFilesystemProof !== false) {
      captureDurableFileProof(context, prepared);
      captureDurableArtifactProof(context, prepared, command.toolName, result);
    }
    if (succeeded && !command.mutates && command.toolName === 'file_read') {
      captureDurableReadProof(context, prepared, result);
    }
    return result;
  } catch (error) {
    const completion = context.engine.completeToolCall({
      toolCallId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      state: 'failed',
      sideEffectState: command.mutates ? 'unknown' : undefined,
      producer: context.producer,
    });
    if (!completion.applied && !completion.duplicate) {
      throw new DurableToolCallConflictError('failure', completion);
    }
    throw error;
  }
}

export function recordDurableToolVerification(toolCallId: string, verification: unknown): void {
  const context = currentJobExecutionContext();
  if (!context) return;
  const persistedToolCallId = durableToolCallId(context, toolCallId);
  const result = context.engine.attachToolVerification({
    toolCallId: persistedToolCallId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    verificationRef: opaqueReference('tool-verification', verification),
    producer: context.producer,
  });
  // Argument/capability gates may return before durable ToolCall admission.
  // Their verifier output remains observational; absence is not lost authority.
  if (!result.applied && !result.duplicate && result.conflict === 'not_found') return;
  requireApplied('verification', result);
}

const RESEARCH_EVIDENCE_TOOLS = new Set([
  'web_search',
  'deep_research',
  'fetch_url',
  'fetch_page',
  'youtube_search',
]);

const SENSITIVE_QUERY_PARAMETER = /^(?:token|api[_-]?key|access[_-]?token|auth(?:orization)?|key|secret|password)$/i;

function redactResearchText(value: string, limit = 2000): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|authorization|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function sanitizeResearchValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactResearchText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeResearchValue(item, depth + 1));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).slice(0, 24).map((key) => [key, sanitizeResearchValue(record[key], depth + 1)]),
    );
  }
  return String(value);
}

function normalizeResearchUrl(candidate: string): string | null {
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizedResearchSource(toolName: string, args: Record<string, unknown>): {
  key: string;
  source: string;
} {
  const candidate = typeof args.url === 'string'
    ? args.url.trim()
    : typeof args.query === 'string'
      ? args.query.trim()
      : '';
  const normalizedUrl = normalizeResearchUrl(candidate);
  if (normalizedUrl) {
    return { key: `url:${normalizedUrl.toLowerCase()}`, source: normalizedUrl };
  }
  const query = redactResearchText(candidate, 500).toLowerCase();
  return { key: `${toolName}:${query}`, source: query || toolName };
}

function researchResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== 'object') return result !== null && result !== undefined;
  const record = result as Record<string, unknown>;
  if (record.success === false) return false;
  if (typeof record.error === 'string' && record.error.trim() && record.success !== true) return false;
  return true;
}

/** Promote bounded, read-only research output into the existing Proof authority. */
export function recordDurableResearchEvidence(command: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  verification?: { ok: boolean; code?: string };
  observedAt?: number;
}): void {
  if (
    !RESEARCH_EVIDENCE_TOOLS.has(command.toolName)
    || !researchResultSucceeded(command.result)
    || command.verification?.ok !== true
    || command.verification.code !== 'ok'
  ) return;
  const context = currentJobExecutionContext();
  if (!context) return;
  const source = normalizedResearchSource(command.toolName, command.args);
  const keys = context.researchEvidenceKeys ?? (context.researchEvidenceKeys = new Set<string>());
  if (keys.has(source.key)) return;
  keys.add(source.key);
  try {
    const observedAt = command.observedAt ?? Date.now();
    const directSourceCapture = command.toolName === 'fetch_url' || command.toolName === 'fetch_page';
    context.engine.proof.recordEvidence({
      jobId: context.jobId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      effectId: null,
      source: `research.${command.toolName}`,
      producer: context.producer,
      observedAt,
      // Interactive approval pauses must not make a source read stale before
      // the same Attempt can prove its final cited response.
      freshUntil: observedAt + RESEARCH_EVIDENCE_FRESHNESS_MS,
      coverage: directSourceCapture ? 'full' : 'partial',
      verificationResult: directSourceCapture ? 'verified' : 'unknown',
      payload: {
        source: source.source,
        toolCallId: command.toolCallId,
        durableToolCallId: durableToolCallId(context, command.toolCallId),
        arguments: sanitizeResearchValue(command.args),
        result: sanitizeResearchValue(command.result),
      },
    });
  } catch {
    // Evidence projection must never turn a successful read into a failed Job.
  }
}

const RESEARCH_CITATION_CLAIM = 'research response cites at least two captured source URLs';
const RESEARCH_EVIDENCE_FRESHNESS_MS = 30 * 60_000;

function citedResearchUrls(content: string): string[] {
  const values = content.match(/https?:\/\/[^\s\])}>,"']+/gu) ?? [];
  const normalized = values
    .map((value) => normalizeResearchUrl(value.replace(/[.;:!?]+$/u, '')))
    .filter((value): value is string => value !== null);
  return [...new Set(normalized.map((value) => value.toLowerCase()))];
}

function verifiedDurableResearchSources(
  context: JobExecutionContext,
  now: number,
): Map<string, ReturnType<JobEngine['proof']['listEvidence']>[number]> {
  const sources = new Map<string, ReturnType<JobEngine['proof']['listEvidence']>[number]>();
  const evidence = context.engine.proof.listEvidence(context.jobId)
    .slice()
    .sort((a, b) => a.capturedAt - b.capturedAt || a.evidenceId.localeCompare(b.evidenceId));
  for (const item of evidence) {
    if (
      item.attemptId !== context.attemptId
      || item.generation !== context.generation
      || item.verificationResult !== 'verified'
      || item.coverage !== 'full'
      || !/^research\.(?:fetch_url|fetch_page)$/.test(item.source)
      || (item.freshUntil !== null && item.freshUntil < now)
    ) continue;
    const payload = item.payload && typeof item.payload === 'object'
      ? item.payload as Record<string, unknown>
      : null;
    const source = typeof payload?.source === 'string' ? normalizeResearchUrl(payload.source) : null;
    if (!source) continue;
    const key = source.toLowerCase();
    if (!sources.has(key)) sources.set(key, item);
  }
  return sources;
}

/** Add exact verifier-backed source links when the response names sources but omits their URLs. */
export function appendDurableResearchSourceLinks(finalContent: string): string {
  const context = currentJobExecutionContext();
  if (!context || !finalContent.trim()) return finalContent;
  const sources = verifiedDurableResearchSources(context, Date.now());
  if (sources.size < 2) return finalContent;
  const cited = new Set(citedResearchUrls(finalContent));
  const matchedCount = [...sources.keys()].filter((source) => cited.has(source)).length;
  if (matchedCount >= 2) return finalContent;
  const missing = [...sources.entries()]
    .filter(([source]) => !cited.has(source))
    .map(([, evidence]) => normalizeResearchUrl((evidence.payload as { source: string }).source))
    .filter((source): source is string => source !== null);
  if (missing.length === 0) return finalContent;
  return `${finalContent.trimEnd()}\n\n## Sources\n${missing.map((source) => `- ${source}`).join('\n')}`;
}

/**
 * Verify the observable research contract against durable source captures.
 * Assistant prose alone is never proof: every cited URL must resolve to a
 * full, verifier-ok Evidence record from this exact Attempt.
 */
export function finalizeDurableResearchProof(finalContent: string): {
  verified: boolean;
  sourceCount: number;
} {
  const context = currentJobExecutionContext();
  if (!context || !finalContent.trim()) return { verified: false, sourceCount: 0 };
  const cited = new Set(citedResearchUrls(finalContent));
  if (cited.size < 2) return { verified: false, sourceCount: 0 };
  const now = Date.now();
  const sources = verifiedDurableResearchSources(context, now);
  const matched = new Map(
    [...sources.entries()].filter(([source]) => cited.has(source)),
  );
  if (matched.size < 2) return { verified: false, sourceCount: matched.size };

  const sourceEvidence = [...matched.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const existing = context.engine.proof.listClaims(context.jobId).find((claim) =>
    claim.category === 'contract'
    && claim.required
    && claim.statement === RESEARCH_CITATION_CLAIM
    && claim.attemptId === context.attemptId
    && claim.generation === context.generation);
  if (existing?.state === 'verified') return { verified: true, sourceCount: matched.size };
  const claim = existing ?? context.engine.proof.createClaim({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    category: 'contract',
    statement: RESEARCH_CITATION_CLAIM,
    required: true,
  });
  const sourceEvidenceIds = sourceEvidence.map((evidence) => evidence.evidenceId);
  const citationEvidence = context.engine.proof.recordEvidence({
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    effectId: null,
    source: 'research.citation_readback',
    producer: context.producer,
    observedAt: now,
    freshUntil: null,
    coverage: 'full',
    verificationResult: 'verified',
    payload: {
      answerSha256: createHash('sha256').update(finalContent).digest('hex'),
      sourceEvidenceIds,
      sources: sourceEvidence.map((evidence) => (evidence.payload as { source: string }).source),
    },
  });
  context.engine.proof.checkClaim({
    claimId: claim.claimId,
    attemptId: context.attemptId,
    generation: context.generation,
    evidenceIds: [...sourceEvidenceIds, citationEvidence.evidenceId],
    state: 'verified',
  });
  return { verified: true, sourceCount: matched.size };
}
