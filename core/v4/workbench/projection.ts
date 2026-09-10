/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type {
  AttemptRecord,
  ChildJobContractRecord,
  JobEventRecord,
  JobRecord,
} from '../daemon/jobEngine';
import type {
  ClaimRecord,
  EvidenceRecord,
  JobVerdictRecord,
} from '../daemon/jobProofAuthority';
import { operatorStatusMessage } from '../operatorStatusMessage';

export type WorkbenchProjectionStatus =
  | 'queued' | 'running' | 'waiting' | 'paused' | 'cancelling'
  | 'completed' | 'verified' | 'partially_verified' | 'failed' | 'cancelled'
  | 'unknown' | 'blocked';

export interface WorkbenchJobProjectionReader {
  getJob(jobId: string): JobRecord | null;
  getVerificationFailure?(jobId: string): string | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  listAttempts(jobId: string): AttemptRecord[];
  listEvents(jobId: string, afterSequence?: number): JobEventRecord[];
  getChildContract?(childJobId: string): ChildJobContractRecord | null;
  listChildContracts?(parentJobId: string): ChildJobContractRecord[];
  listEffectsRequiringReconciliation?(jobId: string): unknown[];
  proof?: {
    listClaims(jobId: string): ClaimRecord[];
    listEvidence(jobId: string): EvidenceRecord[];
    getVerdict(jobId: string): JobVerdictRecord | null;
    exportJson(jobId: string): Record<string, unknown>;
  };
}

export interface WorkbenchIdentityProjection {
  jobId: string;
  rootJobId: string;
  attemptId: string;
  runId: number;
  generation: number;
  sessionId: string;
  workspaceId: string | null;
}

export interface WorkbenchResultReceipt {
  terminal: boolean;
  status: WorkbenchProjectionStatus;
  outcome: string | null;
  finishReason: string | null;
  verdict: JobVerdictRecord | null;
  summary: string;
}

export interface WorkbenchChildExecutionProjection {
  childJobId: string;
  parentJobId: string;
  required: boolean;
  title: string;
  status: string;
  sessionId: string;
  attemptId: string | null;
  runId: number | null;
  generation: number | null;
  verification: string;
  evidenceCount: number;
  startedAt: number | null;
  endedAt: number | null;
  cleanupState: 'active' | 'settled' | 'needs_reconciliation';
}

export interface WorkbenchChildContractEvidenceHandle {
  tool: string | null;
  kind: string;
  value: string;
  verified: boolean | null;
  code: string | null;
}

export interface WorkbenchChildContractEvidenceProjection {
  parentJobId: string;
  required: boolean;
  verification: string;
  handles: WorkbenchChildContractEvidenceHandle[];
}

export interface WorkbenchJobProjection {
  schemaVersion: 1;
  identity: WorkbenchIdentityProjection;
  job: JobRecord;
  activeAttempt: AttemptRecord;
  attempts: AttemptRecord[];
  timeline: JobEventRecord[];
  workers: WorkbenchChildExecutionProjection[];
  approvals: unknown[];
  effects: unknown[];
  claims: ClaimRecord[];
  evidence: EvidenceRecord[];
  claimEvidence?: Array<{ claimId: string; evidenceId: string }>;
  childContractEvidence: WorkbenchChildContractEvidenceProjection | null;
  verification: JobVerdictRecord | null;
  receipt: WorkbenchResultReceipt;
  eventCursor: number;
}

const TERMINAL_JOBS = new Set([
  'cancelled', 'completed', 'failed', 'dead_letter',
  'completed_unverified', 'verification_failed', 'abandoned',
]);

function isReconciledDenial(job: JobRecord): boolean {
  return job.status === 'failed' && job.terminalAt !== null
    && job.terminalOutcome === 'approval_denied' && job.finishReason === 'required_action_denied';
}

export function projectWorkbenchStatus(
  job: JobRecord,
  verdict: JobVerdictRecord | null,
  hasRequiredClaims = false,
): WorkbenchProjectionStatus {
  if (isReconciledDenial(job)) return 'failed';
  if (verdict?.verdict === 'verified') return 'verified';
  if (verdict?.verdict === 'partially_verified') return 'partially_verified';
  if (verdict?.verdict === 'failed') return 'failed';
  if (verdict?.verdict === 'cancelled') return 'cancelled';
  if (verdict?.verdict === 'unknown') return 'unknown';
  if (job.status === 'completed') return hasRequiredClaims ? 'unknown' : 'completed';
  if (job.status === 'completed_unverified' || job.status === 'abandoned') return 'unknown';
  if (job.status === 'failed' || job.status === 'dead_letter' || job.status === 'verification_failed') return 'failed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'blocked') return 'blocked';
  if (job.status === 'unknown') return 'unknown';
  if (job.status === 'crashed') return 'unknown';
  if (job.status === 'waiting') return 'waiting';
  if (job.status === 'paused') return 'paused';
  if (job.status === 'cancelling') return 'cancelling';
  if (job.status === 'queued') return 'queued';
  return 'running';
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isVerifiedEvidenceHandle(value: unknown): boolean {
  const handle = record(value);
  const code = typeof handle.code === 'string' ? handle.code.toLowerCase() : null;
  const result = typeof handle.verificationResult === 'string'
    ? handle.verificationResult.toLowerCase()
    : null;
  return handle.verified === true && (code === 'ok' || result === 'verified');
}

export function projectChildExecutionVerification(
  contract: ChildJobContractRecord,
  verdict: JobVerdictRecord | null,
  childStatus: string,
): string {
  if (verdict) return verdict.verdict;
  if (childStatus === 'verification_failed' || contract.resultStatus === 'verification_failed') return 'failed';

  const contractEvidence = record(contract.evidence);
  const evidenceVerdict = typeof contractEvidence.verdict === 'string'
    ? contractEvidence.verdict
    : null;
  const failures = array(contractEvidence.failures);
  const handles = contract.evidenceHandles.length > 0
    ? contract.evidenceHandles
    : array(contractEvidence.handles);
  if (
    (evidenceVerdict === 'completed' || evidenceVerdict === 'verified')
    && failures.length === 0
    && handles.length > 0
    && handles.every(isVerifiedEvidenceHandle)
  ) return 'verified';

  return 'not_recorded';
}

function projectChildEvidenceHandle(value: unknown): WorkbenchChildContractEvidenceHandle | null {
  if (typeof value === 'string' && value.length > 0) {
    return { tool: null, kind: 'evidence', value, verified: null, code: null };
  }
  const handle = record(value);
  const target = typeof handle.value === 'string' ? handle.value : null;
  const kind = typeof handle.kind === 'string' ? handle.kind : null;
  if (!target || !kind) return null;
  return {
    tool: typeof handle.tool === 'string' ? handle.tool : null,
    kind,
    value: target,
    verified: typeof handle.verified === 'boolean' ? handle.verified : null,
    code: typeof handle.code === 'string' ? handle.code : null,
  };
}

function projectChildContractEvidence(
  contract: ChildJobContractRecord | null,
  verdict: JobVerdictRecord | null,
  childStatus: string,
): WorkbenchChildContractEvidenceProjection | null {
  if (!contract) return null;
  const contractEvidence = record(contract.evidence);
  const handles = (contract.evidenceHandles.length > 0
    ? contract.evidenceHandles
    : array(contractEvidence.handles))
    .map(projectChildEvidenceHandle)
    .filter((handle): handle is WorkbenchChildContractEvidenceHandle => handle !== null);
  return {
    parentJobId: contract.parentJobId,
    required: contract.required,
    verification: projectChildExecutionVerification(contract, verdict, childStatus),
    handles,
  };
}

function latestAttempt(attempts: readonly AttemptRecord[]): AttemptRecord | null {
  return attempts.reduce<AttemptRecord | null>((latest, candidate) => {
    if (!latest) return candidate;
    if (candidate.attemptNumber !== latest.attemptNumber) {
      return candidate.attemptNumber > latest.attemptNumber ? candidate : latest;
    }
    return candidate.rowId > latest.rowId ? candidate : latest;
  }, null);
}

function projectChildExecutions(
  reader: WorkbenchJobProjectionReader,
  parentJobId: string,
): WorkbenchChildExecutionProjection[] {
  return (reader.listChildContracts?.(parentJobId) ?? []).flatMap((contract) => {
    const child = reader.getJob(contract.childJobId);
    if (!child || child.parentJobId !== parentJobId) return [];
    const attempts = reader.listAttempts(child.id);
    const attempt = contract.resultAttemptId
      ? reader.getAttempt(contract.resultAttemptId)
      : child.activeAttemptId
        ? reader.getAttempt(child.activeAttemptId)
        : latestAttempt(attempts);
    const validAttempt = attempt?.jobId === child.id ? attempt : null;
    const timeline = reader.listEvents(child.id, 0).sort((left, right) => left.jobSequence - right.jobSequence);
    const verdict = reader.proof?.getVerdict(child.id) ?? null;
    const evidence = reader.proof?.listEvidence(child.id) ?? [];
    const unresolved = reader.listEffectsRequiringReconciliation?.(child.id) ?? [];
    return [{
      childJobId: child.id,
      parentJobId,
      required: contract.required,
      title: child.goal,
      status: contract.resultStatus ?? child.status,
      sessionId: child.sessionId,
      attemptId: validAttempt?.id ?? null,
      runId: validAttempt?.rowId ?? null,
      generation: validAttempt?.generation ?? contract.resultGeneration,
      verification: projectChildExecutionVerification(contract, verdict, child.status),
      evidenceCount: evidence.length || contract.evidenceHandles.length,
      startedAt: timeline[0]?.createdAt ?? null,
      endedAt: child.terminalAt,
      cleanupState: unresolved.length > 0
        ? 'needs_reconciliation'
        : child.terminalAt === null ? 'active' : 'settled',
    }];
  });
}

function failureSummary(
  status: WorkbenchProjectionStatus,
  job: JobRecord,
  verdict: JobVerdictRecord | null,
  timeline: JobEventRecord[],
  reader: WorkbenchJobProjectionReader,
): string {
  if (isReconciledDenial(job)) {
    return 'Required action was denied before execution. Historical Evidence was not recorded.';
  }
  if (!['failed', 'unknown', 'blocked'].includes(status)) {
    return verdict?.verdict ?? job.terminalOutcome ?? status;
  }
  for (const event of [...timeline].reverse()) {
    const payload = event.payload ?? {};
    const raw = payload.error ?? payload.invocationError ?? payload.reason ?? payload.lastError;
    if (typeof raw === 'string' && raw.trim()) return operatorStatusMessage(raw, status);
  }
  const retainedFailure = reader.getVerificationFailure?.(job.id);
  if (retainedFailure?.trim()) return operatorStatusMessage(retainedFailure, status);
  if (job.terminalOutcome === 'verification_failed') {
    return 'Verification failed. Review the retained result and Evidence before retrying.';
  }
  // A provider's normal end-of-response marker is not an execution failure reason.
  return operatorStatusMessage(job.finishReason === 'stop' ? null : job.finishReason, verdict?.verdict ?? status);
}

/** Build a read-only projection from existing durable authorities. */
export function projectWorkbenchJob(
  reader: WorkbenchJobProjectionReader,
  request: { jobId: string; attemptId?: string; runId?: number },
): WorkbenchJobProjection | null {
  const job = reader.getJob(request.jobId);
  if (!job) return null;
  const attempts = reader.listAttempts(job.id);
  const newestAttempt = latestAttempt(attempts);
  const attemptId = request.attemptId ?? job.activeAttemptId ?? newestAttempt?.id ?? null;
  if (!attemptId) return null;
  const attempt = reader.getAttempt(attemptId);
  if (!attempt || attempt.jobId !== job.id) return null;
  if (request.runId !== undefined && attempt.rowId !== request.runId) return null;
  const timeline = reader.listEvents(job.id, 0).sort((a, b) => a.jobSequence - b.jobSequence);
  const proof = reader.proof;
  const claims = proof?.listClaims(job.id) ?? [];
  const evidence = proof?.listEvidence(job.id) ?? [];
  const verdict = proof?.getVerdict(job.id) ?? null;
  const childContract = reader.getChildContract?.(job.id) ?? null;
  const exported = proof ? proof.exportJson(job.id) : {};
  const status = projectWorkbenchStatus(job, verdict, claims.some((claim) => claim.required));
  const terminal = TERMINAL_JOBS.has(job.status);
  return {
    schemaVersion: 1,
    identity: {
      jobId: job.id,
      rootJobId: job.rootJobId,
      attemptId: attempt.id,
      runId: attempt.rowId,
      generation: attempt.generation,
      sessionId: job.sessionId,
      workspaceId: job.workspaceId ?? null,
    },
    job,
    activeAttempt: attempt,
    attempts,
    timeline,
    workers: projectChildExecutions(reader, job.id),
    approvals: array(exported.approvals),
    effects: array(exported.effects),
    claims,
    evidence,
    claimEvidence: array(exported.claimEvidence).filter((entry): entry is { claimId: string; evidenceId: string } =>
      Boolean(entry && typeof entry === 'object' && typeof (entry as any).claimId === 'string'
        && typeof (entry as any).evidenceId === 'string'))
      .map(({ claimId, evidenceId }) => ({ claimId, evidenceId })),
    childContractEvidence: projectChildContractEvidence(childContract, verdict, job.status),
    verification: verdict,
    receipt: {
      terminal,
      status,
      outcome: job.terminalOutcome,
      finishReason: job.finishReason,
      verdict,
        summary: failureSummary(status, job, verdict, timeline, reader),
    },
    eventCursor: timeline.length > 0 ? timeline[timeline.length - 1].jobSequence : 0,
  };
}
