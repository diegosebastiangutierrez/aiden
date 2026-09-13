import { describe, expect, it } from 'vitest';
import { applyWorkbenchSelection, parseWorkbenchDestination } from '../../../dashboard-next/lib/workbenchNavigation';
import { pendingConnectionRemoved, presentMcpConnection } from '../../../dashboard-next/lib/connectionPresentation';
import { onboardingReadiness, readOnboardingStep, saveOnboardingStep } from '../../../dashboard-next/lib/onboardingProgress';
import { PRODUCT_FEATURES, searchProductFeatures } from '../../../core/v4/product/featureCatalog';
import { buildOnboardingPlan } from '../../../core/v4/commercial/onboardingPlan';

describe('customer setup discovery', () => {
  it('reconciles accounts when a pending card settles before its completion response arrives', () => {
    expect(pendingConnectionRemoved(['first'], [])).toBe(true);
    expect(pendingConnectionRemoved(['first', 'second'], ['second'])).toBe(true);
    expect(pendingConnectionRemoved(['first', 'second'], ['second', 'first'])).toBe(false);
    expect(pendingConnectionRemoved([], ['first'])).toBe(false);
  });
  it('gives every discovery entry a supported, reopenable product destination', () => {
    expect(new Set(PRODUCT_FEATURES.map(feature => feature.id)).size).toBe(PRODUCT_FEATURES.length);
    for (const feature of PRODUCT_FEATURES) {
      const search = new URLSearchParams(feature.destination).toString();
      expect(parseWorkbenchDestination(search)).toEqual(feature.destination);
    }
    expect(searchProductFeatures('telegram').map(feature => feature.id)).toContain('telegram');
    expect(searchProductFeatures('MCP', 'tools').map(feature => feature.id)).toContain('mcp');
    expect(searchProductFeatures('missing capability')).toEqual([]);
    expect(PRODUCT_FEATURES.filter(feature => feature.category === 'messaging')).toHaveLength(9);
  });

  it('uses authoritative readiness in the shared onboarding plan', () => {
    const projection = { overall: 'ready', items: [{ id: 'chat-provider', healthy: true, ready: false, detail: 'Permission needed', blocking: true }] } as never;
    expect(buildOnboardingPlan(projection).find(step => step.id === 'ai')?.state).toBe('action_required');
    expect(buildOnboardingPlan(projection).at(-1)?.state).toBe('action_required');
  });
  it.each(['connections', 'skills'])('restores the %s workspace with exact run identity', (view) => {
    expect(parseWorkbenchDestination(`?view=${view}`)).toEqual({ view });
    const restored = new URL(applyWorkbenchSelection(`http://localhost/?view=${view}`, '?job=one&attempt=two&run=3', true));
    expect(restored.searchParams.get('view')).toBe(view);
    expect(restored.searchParams.get('job')).toBe('one');
  });

  it.each(['channels', 'mcp', 'ide', 'conversation', 'sponsor'])('can reopen the existing %s settings page', (settings) => {
    expect(parseWorkbenchDestination(`?settings=${settings}`)).toEqual({ settings });
  });

  it('never labels disconnected or unknown MCP state as connected', () => {
    for (const status of ['disconnected', 'error', 'disabled', 'reconnecting', 'initializing', 'unknown']) {
      expect(presentMcpConnection({ status, authState: 'ready', reviewRequired: false }).label).not.toBe('Connected');
    }
    expect(presentMcpConnection({ status: 'ready', authState: 'unavailable', reviewRequired: false }).label).not.toBe('Connected');
    expect(presentMcpConnection({ status: 'ready', authState: 'ready', reviewRequired: false }).label).toBe('Connected');
    expect(presentMcpConnection({ status: 'ready', authState: 'required', reviewRequired: false }).label).toBe('Authentication required');
    expect(presentMcpConnection({ status: 'ready', authState: 'ready', reviewRequired: true }).label).toBe('Permissions need review');
  });

  it('treats healthy but not authorized readiness as incomplete', () => {
    expect(onboardingReadiness({ overall: 'ready', items: [{ id: 'chat-provider', ready: false, healthy: true, blocking: true }] } as never).canStart).toBe(false);
    expect(onboardingReadiness(null).canStart).toBe(false);
  });

  it('keeps optional failures separate from required execution readiness', () => {
    expect(onboardingReadiness({ overall: 'ready', items: [
      { id: 'chat-provider', ready: true, blocking: true },
      { id: 'workspace', ready: true, blocking: true },
      { id: 'browser', ready: false, blocking: false },
    ] } as never).canStart).toBe(true);
    expect(onboardingReadiness({ overall: 'needs_attention', items: [{ id: 'chat-provider', ready: true, blocking: true }] } as never).canStart).toBe(false);
  });

  it('does not crash or trap setup when browser storage is unavailable', () => {
    const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(readOnboardingStep(storage, 7)).toBe(0);
    expect(() => saveOnboardingStep(storage, 3)).not.toThrow();
  });

  it.each(['-2', 'NaN', '1e4', '1.5', '3oops'])('rejects invalid saved step %s', (stored) => {
    expect(readOnboardingStep({ getItem: () => stored }, 7)).toBe(0);
  });
  it('restores a valid saved step', () => {
    expect(readOnboardingStep({ getItem: () => '3' }, 7)).toBe(3);
  });
});
