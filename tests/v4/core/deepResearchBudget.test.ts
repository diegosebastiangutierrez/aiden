import { describe, expect, it, vi } from 'vitest';

import { runBoundedResearch } from '../../../core/webSearch';

describe('bounded deep research', () => {
  it('runs the reviewed three-pass plan and reports observable semantic phases', async () => {
    const phases: string[] = [];
    const queries: string[] = [];
    const result = await runBoundedResearch('durable systems', {
      budgetMs: 5_000,
      maxPasses: 3,
      search: async (query) => {
        queries.push(query);
        return { success: true, output: `Source https://example.com/${queries.length} ${'evidence '.repeat(20)}` };
      },
      onPhase: (phase) => phases.push(phase),
    });

    expect(queries).toHaveLength(3);
    expect(result.status).toBe('completed');
    expect(result.found).toBe(3);
    expect(result.sources).toEqual([
      'https://example.com/1', 'https://example.com/2', 'https://example.com/3',
    ]);
    expect(phases).toEqual([
      'planning', 'searching_broad', 'searching_recent',
      'comparing_sources', 'preparing_result', 'completed',
    ]);
  });

  it('returns useful partial truth when the total budget expires', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const pending = runBoundedResearch('bounded topic', {
        budgetMs: 50,
        maxPasses: 3,
        search: async (_query, signal) => {
          calls += 1;
          if (calls === 1) return { success: true, output: `https://example.com/first ${'fact '.repeat(30)}` };
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ success: false, output: '', error: 'aborted' }), { once: true });
          });
        },
      });
      await vi.advanceTimersByTimeAsync(60);
      const result = await pending;

      expect(result).toMatchObject({ success: true, status: 'partial', found: 1 });
      expect(result.output).toContain('first');
      expect(result.failed.length).toBeGreaterThan(0);
      expect(result.next).toMatch(/continue/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours an outer cancellation signal without starting later passes', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await runBoundedResearch('cancelled topic', {
      budgetMs: 5_000,
      maxPasses: 3,
      signal: controller.signal,
      search: async (_query, signal) => {
        calls += 1;
        controller.abort();
        return { success: false, output: '', error: signal.aborted ? 'cancelled' : 'unexpected' };
      },
    });

    expect(result.status).toBe('cancelled');
    expect(calls).toBe(1);
    expect(result.success).toBe(false);
  });
});
