import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyWorkbenchDestination,
  applyWorkbenchSelection,
  parseWorkbenchDestination,
} from '../../../dashboard-next/lib/workbenchNavigation';

describe('Workbench product deep links', () => {
  it('uses the shared durable navigation path for sidebar and workflow history controls', () => {
    const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
    const sidebar = page.slice(page.indexOf('function HistorySidebar()'), page.indexOf('function HistorySidebar()') + 11000);
    expect(sidebar).toContain('openWorkbenchDestination({ view })');
    expect(sidebar).not.toContain('setMainView(view)');
    expect(page).toContain("openWorkbenchDestination({ view: 'automations' })}>Open workflow runs and history");
  });

  it('opens a scoped context reference without losing exact execution identity or leaking it to another section', () => {
    const base = 'http://127.0.0.1:4280/?session=one&job=job-one&attempt=attempt-one&run=4';
    const context = new URL(applyWorkbenchDestination(base, { view: 'brain', contextEntryId: 'entry/one?other=2' }));
    expect(context.searchParams.get('context')).toBe('entry/one?other=2');
    expect(context.searchParams.has('other')).toBe(false);
    expect(context.searchParams.get('job')).toBe('job-one');
    expect(new URL(applyWorkbenchDestination(context.href, { settings: 'apps' })).searchParams.has('context')).toBe(false);
  });

  it('restores every existing product section after reload and run reconciliation', () => {
    for (const view of ['chat', 'activity', 'artifacts', 'apps', 'automations', 'sponsors', 'brain']) {
      const search = `?view=${view}&session=session-one&job=job-one&attempt=attempt-one&run=1`;
      expect(parseWorkbenchDestination(search)).toEqual({ view });
      const restored = new URL(applyWorkbenchSelection(`http://127.0.0.1:4280/${search}`, '?session=session-one&job=job-one&attempt=attempt-one&run=1', true));
      expect(restored.searchParams.get('view')).toBe(view);
      expect(restored.searchParams.get('job')).toBe('job-one');
    }
  });

  it('clears context detail on deliberate navigation or another Job but retains it during same-run restore', () => {
    const source = 'http://127.0.0.1:4280/?view=brain&context=context-one&job=job-one&attempt=attempt-one&run=1';
    expect(new URL(applyWorkbenchDestination(source, { view: 'apps' })).searchParams.has('context')).toBe(false);
    expect(new URL(applyWorkbenchSelection(source, '?job=job-one&attempt=attempt-one&run=1', true)).searchParams.get('context')).toBe('context-one');
    expect(new URL(applyWorkbenchSelection(source, '?job=job-two&attempt=attempt-two&run=2', false)).searchParams.has('context')).toBe(false);
    expect(new URL(applyWorkbenchSelection(source, '?job=job-two&attempt=attempt-two&run=2', true)).searchParams.has('context')).toBe(false);
  });

  it('opens exact readiness and Apps destinations while preserving run identity', () => {
    const base = 'http://127.0.0.1:4280/?jobId=job-1&attemptId=attempt-1&runId=7';
    const readiness = applyWorkbenchDestination(base, { settings: 'runtime' });
    expect(readiness).toContain('jobId=job-1');
    expect(readiness).toContain('settings=runtime');
    expect(parseWorkbenchDestination(new URL(readiness).search)).toEqual({ settings: 'runtime' });

    const apps = applyWorkbenchDestination(readiness, { view: 'apps' });
    expect(apps).toContain('jobId=job-1');
    expect(apps).not.toContain('settings=');
    expect(parseWorkbenchDestination(new URL(apps).search)).toEqual({ view: 'apps' });
  });

  it('ignores unknown destinations and clears only Workbench navigation keys', () => {
    expect(parseWorkbenchDestination('?view=unknown&settings=unsafe')).toEqual({});
    const cleared = applyWorkbenchDestination(
      'http://127.0.0.1:4280/?jobId=job-1&view=apps&settings=runtime',
      {},
    );
    expect(cleared).toContain('jobId=job-1');
    expect(cleared).not.toContain('view=');
    expect(cleared).not.toContain('settings=');
  });

  it('deep-links every customer-facing settings section without disturbing run identity', () => {
    const settings = ['runtime', 'model', 'coding', 'appearance', 'skills', 'capabilities', 'apps', 'automations', 'pro', 'updates', 'support', 'about', 'privacy', 'legal'] as const;
    for (const tab of settings) {
      const url = applyWorkbenchDestination('http://127.0.0.1:4280/?job=job-1&run=7', { settings: tab });
      expect(parseWorkbenchDestination(new URL(url).search)).toEqual({ settings: tab });
      expect(url).toContain('job=job-1');
    }
  });

  it('preserves an explicit Apps or Settings destination while runtime identity reconciles', () => {
    const apps = applyWorkbenchSelection(
      'http://127.0.0.1:4280/?view=apps',
      '?session=session-1&job=job-1&attempt=attempt-1&run=7',
      true,
    );
    expect(new URL(apps).searchParams.get('view')).toBe('apps');
    expect(new URL(apps).searchParams.get('job')).toBe('job-1');

    const readiness = applyWorkbenchSelection(
      'http://127.0.0.1:4280/?settings=runtime',
      '?session=session-1',
      true,
    );
    expect(new URL(readiness).searchParams.get('settings')).toBe('runtime');
    expect(new URL(readiness).searchParams.get('session')).toBe('session-1');

    const explicitChat = applyWorkbenchSelection(apps, '?session=session-2', false);
    expect(new URL(explicitChat).searchParams.has('view')).toBe(false);
    expect(new URL(explicitChat).searchParams.get('session')).toBe('session-2');
  });
});
