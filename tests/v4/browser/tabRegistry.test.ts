import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTabRegistry } from '../../../core/v4/browser/tabRegistry';

afterEach(() => getTabRegistry().clear());

describe('physical browser tab identity', () => {
  it('keeps one page stable and gives reopened physical pages new identities', () => {
    const registry = getTabRegistry();
    const page = {};
    const first = registry.track(page, 'aiden', null, 'session-current');
    expect(registry.track(page, 'aiden', null, 'session-current').tab_id).toBe(first.tab_id);
    registry.clear();
    expect(registry.track({}, 'aiden', null, 'session-next').tab_id).not.toBe(first.tab_id);
  });

  it('does not reuse tab identities across a new runtime module instance', async () => {
    const first = getTabRegistry().track({}, 'aiden', null).tab_id;
    vi.resetModules();
    const restarted = (await import('../../../core/v4/browser/tabRegistry')).getTabRegistry();
    try {
      expect(restarted.track({}, 'aiden', null).tab_id).not.toBe(first);
    } finally {
      restarted.clear();
    }
  });

  it('does not let another session steal the same physical page', () => {
    const registry = getTabRegistry();
    const page = {};
    const original = registry.track(page, 'aiden', null, 'session-owner');
    expect(() => registry.track(page, 'aiden', null, 'session-other')).toThrow(/another durable session/);
    expect(registry.get(page)).toBe(original);
    expect(original.browserSessionId).toBe('session-owner');
  });

  it('restores an explicitly reconciled legacy identity without reusing it for another page', () => {
    const registry = getTabRegistry();
    const page = {};
    registry.track(page, 'aiden', null);
    const durable = {
      tabId: 'tab-2', createdBy: 'aiden' as const, openerId: null,
      browserSessionId: 'session-recovered', controlled: true,
      url: 'https://fixture.test/form', title: 'Form', dirtyForm: false,
      lastSnapshotHash: 'previous-observation',
    };
    expect(registry.trackDurable(page, durable).tab_id).toBe(durable.tabId);
    expect(registry.pageById(durable.tabId)).toBe(page);
    expect(registry.track({}, 'aiden', null).tab_id).not.toBe(durable.tabId);
    const duplicate = {};
    registry.track(duplicate, 'aiden', null);
    expect(() => registry.trackDurable(duplicate, durable)).toThrow(/another physical page/);
    expect(registry.pageById(durable.tabId)).toBe(page);
    registry.remove(page);
    expect(registry.trackDurable(duplicate, durable).tab_id).toBe(durable.tabId);
  });
});
