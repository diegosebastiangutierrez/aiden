/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../../dashboard-next/lib/aidenClient';
import { createRetryIdempotencyKey, retryTask } from '../../../dashboard-next/lib/aidenClient';
import { presentResult, presentRuntimeStatus } from '../../../dashboard-next/lib/workbenchPresentation';

const response = (body: unknown, status = 202): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response);

describe('Workbench retry surface', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['session', 'default'] as const)('invalidates terminal Retry choices after an acknowledged %s model change', async (scope) => {
    const notify = vi.fn();
    const unsubscribe = client.subscribeModelSelection(notify);
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; })));
    try {
      const binding = { sessionId: 'selected-chat', providerId: 'test-provider', modelId: 'selected-model' };
      const pending = scope === 'session' ? client.setSessionModel(binding) : client.setDefaultModel(binding);
      expect(notify).not.toHaveBeenCalled();
      complete(response(binding));
      await pending;
      expect(notify).toHaveBeenCalledTimes(1);
      unsubscribe();
      vi.stubGlobal('fetch', vi.fn(async () => response(binding)));
      await client.setSessionModel(binding);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('does not invalidate model truth when the selected model is rejected', async () => {
    const notify = vi.fn();
    const unsubscribe = client.subscribeModelSelection(notify);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'model unavailable' }, 400)));
      await expect(client.setSessionModel({ sessionId: 'chat', providerId: 'unavailable', modelId: 'missing' })).rejects.toThrow();
      expect(notify).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

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

    await expect(retryTask(21, 'retry:job_old', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    })).resolves.toEqual({
      accepted: true, duplicate: false, originalJobId: 'job_old', jobId: 'job_new',
      attemptId: 'attempt_new', runId: 22, generation: 1, triggerEventId: 44,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/21/retry', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: 'retry:job_old',
        modelOverride: { provider: 'chatgpt-plus', model: 'gpt-5.6-luna' },
      }),
    }));
  });

  it('gives each deliberate Retry action a fresh request identity', () => {
    const first = createRetryIdempotencyKey('job_old', 'selected', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });
    const second = createRetryIdempotencyKey('job_old', 'selected', {
      provider: 'chatgpt-plus', model: 'gpt-5.6-luna',
    });

    expect(first).toMatch(/^retry:job_old:selected:chatgpt-plus:gpt-5\.6-luna:/);
    expect(second).toMatch(/^retry:job_old:selected:chatgpt-plus:gpt-5\.6-luna:/);
    expect(second).not.toBe(first);
  });

  it('shows explicit original and selected model choices before starting new Retry work', () => {
    const page = fs.readFileSync(path.resolve('dashboard-next/app/page.tsx'), 'utf8');
    expect(page).toContain('Retrying as new work…');
    expect(page).toContain('Retry with original model');
    expect(page).toContain('Retry with selected model');
    expect(page.includes('aiden.subscribeModelSelection')).toBe(true);
    expect(page).toContain('projection.modelBinding');
    expect(page).toContain('modelOverride');
    expect(page).toContain('retryInFlightRef');
    expect(page).toContain('createRetryIdempotencyKey');
    expect(page).toContain('Retried from previous run');
    expect(page).toContain('onRetried?.(next.jobId, next.attemptId, next.runId, projection.identity.sessionId ?? null)');
    expect(page).toContain('retry:${projection.identity.jobId}:original');
    expect(page).toContain('retry:${projection.identity.jobId}:selected:');
  });

  it('applies current-chat model changes to the selected durable conversation rather than the browser session', () => {
    const page = fs.readFileSync(path.resolve('dashboard-next/app/page.tsx'), 'utf8');
    const drawer = page.slice(page.indexOf('function SettingsDrawer()'), page.indexOf('function SettingsDrawer()') + 22_000);
    expect(drawer.includes('selectedContext.sessionId || currentConvId || sessionId')).toBe(true);
    expect(drawer.includes('<AIModelsSettings sessionId={modelSessionId}')).toBe(true);
    expect(drawer.includes('<AIModelsSettings sessionId={sessionId}')).toBe(false);
  });
});
