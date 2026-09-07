/* Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyWorkbenchDestination, applyWorkbenchSelection, parseWorkbenchDestination } from '../../../dashboard-next/lib/workbenchNavigation';

describe('required child Evidence navigation', () => {
  it('preserves the Activity destination and exact child identity through hydration and reload', () => {
    const selection = '?session=child-session&job=child-job&attempt=child-attempt&run=7';
    const selected = applyWorkbenchSelection('http://localhost/?view=apps', selection, false);
    const destination = applyWorkbenchDestination(selected, { view: 'activity' });
    const hydrated = applyWorkbenchSelection(destination, selection, true);
    expect(parseWorkbenchDestination(new URL(hydrated).search)).toEqual({ view: 'activity' });
    for (const [key, value] of new URLSearchParams(selection)) expect(new URL(hydrated).searchParams.get(key)).toBe(value);
    const newChat = applyWorkbenchSelection(hydrated, '?session=new-chat', false);
    expect(parseWorkbenchDestination(new URL(newChat).search)).toEqual({});
  });

  it('opens child Evidence through the persistent destination instead of a transient view update', () => {
    const page = readFileSync(path.resolve('dashboard-next/app/page.tsx'), 'utf8');
    const surface = page.slice(page.indexOf('function AutomationsView()'), page.indexOf('function SponsorsView()'));
    const action = surface.slice(surface.indexOf('selectActiveJob({'), surface.indexOf('}}>Open child evidence'));
    expect(action).toContain('jobId: occurrence.jobId!');
    expect(action).toContain('attemptId: occurrence.attemptId');
    expect(action).toContain('runId: occurrence.execution!.runId');
    expect(action).toContain("openWorkbenchDestination({ view: 'activity' })");
    expect(action).not.toContain("setMainView('activity')");
  });
});
