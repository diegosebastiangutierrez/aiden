/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryTask } from '../../../dashboard-next/lib/aidenClient';
import { presentResult, presentRuntimeStatus } from '../../../dashboard-next/lib/workbenchPresentation';

const response = (body: unknown, status = 202): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response);

describe('Workbench retry surface', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('presents a cancelled terminal Job as stopped safely with Retry', () => {
    expect(presentRuntimeStatus('cancelled')).toMatchObject({
      label: 'Cancelled',
      detail: 'Stopped safely.',
      nextAction: 'Retry',
    });
  });

  it('keeps cancellation truth when a legacy terminal summary says failed', () => {
    expect(presentResult({
      status: 'cancelled',
      verdict: 'cancelled',
      summary: 'failed',
      evidenceCount: 1,
    })).toMatchObject({
      title: 'Cancelled',
      summary: 'Stopped safely.',
    });
  });

  it('posts one idempotent retry action and preserves the new durable identity', async () => {
    const fetchMock = vi.fn(async () => response({
      accepted: true, duplicate: false, original_job_id: 'job_old', job_id: 'job_new',
      attempt_id: 'attempt_new', run_id: 22, generation: 1, trigger_event_id: 44,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(retryTask(21, 'retry:job_old')).resolves.toEqual({
      accepted: true, duplicate: false, originalJobId: 'job_old', jobId: 'job_new',
      attemptId: 'attempt_new', runId: 22, generation: 1, triggerEventId: 44,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/21/retry', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: 'retry:job_old' }),
    }));
  });

  it('shows retry progress, selects the new Job, and labels lineage without raw IDs', () => {
    const page = fs.readFileSync(path.resolve('dashboard-next/app/page.tsx'), 'utf8');
    expect(page).toContain('Retrying as new work…');
    expect(page).toContain('aiden.retryTask(projection.identity.runId, key)');
    expect(page).toContain('Retried from previous run');
    expect(page).toContain('onRetried?.(next.jobId, next.attemptId, next.runId, projection.identity.sessionId ?? null)');
    expect(page).toContain("const key = `retry:${projection.identity.jobId}`");
  });
});
