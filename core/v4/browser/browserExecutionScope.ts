/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  currentJobExecutionContext,
  type JobExecutionContext,
} from '../daemon/jobExecutionContext';
import type {
  BrowserSessionAuthority,
  BrowserSessionBinding,
  BrowserSessionRecord,
} from './browserSessionAuthority';

export interface BrowserExecutionScope {
  authority: BrowserSessionAuthority;
  binding: BrowserSessionBinding;
  session: BrowserSessionRecord;
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<BrowserExecutionScope>();

export function currentBrowserExecutionScope(): BrowserExecutionScope | undefined {
  return storage.getStore();
}

/**
 * Reject a navigation whose exact normalized destination is already present
 * in the current durable session history. This check intentionally runs at
 * the ToolHandler argument boundary, before ToolCall/Effect admission: no
 * browser command has been dispatched, so the known no-progress outcome must
 * not be persisted as an unknown external effect.
 */
export function browserNavigationPreflightError(normalizedUrl: string): string | null {
  const scoped = currentBrowserExecutionScope();
  if (scoped) {
    try {
      return scoped.authority.canRepeatNavigation(scoped.binding, normalizedUrl)
        ? null
        : `Browser session already observed ${normalizedUrl}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  const context = currentJobExecutionContext();
  if (!context) return null;
  const session = context.engine.browser.getSessionForAttempt(
    context.jobId,
    context.attemptId,
    context.generation,
  );
  if (!session) return null;
  const binding: BrowserSessionBinding = {
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    workspaceId: session.workspaceId,
    mode: session.mode,
    profileIdentity: session.profileIdentity,
  };
  try {
    return context.engine.browser.canRepeatNavigation(binding, normalizedUrl)
      ? null
      : `Browser session already observed ${normalizedUrl}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function bindingFor(context: JobExecutionContext): BrowserSessionBinding {
  const job = context.engine.getJob(context.jobId);
  return {
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    workspaceId: job?.workspaceId ?? null,
    mode: process.env.AIDEN_BROWSER_MODE === 'attached' ? 'attached' : 'owned',
    profileIdentity: process.env.AIDEN_BROWSER_PROFILE ?? 'aiden-default',
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled');
  throw reason;
}

/**
 * Bind a browser tool invocation to the exact active Job Attempt. Legacy calls
 * without a durable Job context retain their existing local behavior.
 */
export async function runWithAuthorizedBrowserSession<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = currentBrowserExecutionScope();
  if (existing) {
    assertNotAborted(signal ?? existing.signal);
    existing.authority.assertActionable(existing.binding);
    return operation();
  }
  const context = currentJobExecutionContext();
  if (!context) {
    assertNotAborted(signal);
    return operation();
  }
  const binding = bindingFor(context);
  const authority = context.engine.browser;
  const session = authority.ensureSession(binding);
  const activeSignal = signal ?? context.signal;
  assertNotAborted(activeSignal);
  return storage.run({ authority, binding, session, signal: activeSignal }, async () => {
    authority.assertActionable(binding);
    const value = await operation();
    assertNotAborted(activeSignal);
    const current = authority.getSession(session.browserSessionId);
    const explicitlyClosed = current?.state === 'closed' && current.recoveryState === 'explicit close';
    if (!explicitlyClosed && current?.state !== 'user_control_required' && current?.state !== 'user_control') {
      authority.assertActionable(binding);
    }
    return value;
  });
}
