import { describe, expect, it } from 'vitest';

import {
  completedRunMessages,
  resolveWorkbenchOnboarding,
} from '../../../dashboard-next/lib/completedRunRecovery';

describe('completed Workbench run recovery', () => {
  it('reconstructs a cache-miss conversation from canonical Job and assistant events', () => {
    expect(completedRunMessages({
      identity: { jobId: 'task_1', attemptId: 'attempt_1', runId: 7, generation: 1, sessionId: 'session_1' },
      job: { id: 'task_1', status: 'completed', goal: 'Create summary.md', terminalOutcome: 'verified', finishReason: 'stop' },
      receipt: { terminal: true, status: 'verified', summary: 'verified' },
      assistantOutput: [
        { eventId: 10, sequence: 1, text: 'Created ' },
        { eventId: 11, sequence: 2, text: 'summary.md.' },
      ],
    }, 1_000)).toEqual([
      expect.objectContaining({ role: 'user', content: 'Create summary.md' }),
      expect.objectContaining({ role: 'assistant', content: 'Created summary.md.' }),
    ]);
  });

  it('treats durable prior sessions as completed onboarding after browser-local state is lost', () => {
    expect(resolveWorkbenchOnboarding(null, 1)).toEqual({ done: true, persist: true });
    expect(resolveWorkbenchOnboarding('complete', 0)).toEqual({ done: true, persist: false });
    expect(resolveWorkbenchOnboarding(null, 0)).toEqual({ done: false, persist: false });
  });
});
