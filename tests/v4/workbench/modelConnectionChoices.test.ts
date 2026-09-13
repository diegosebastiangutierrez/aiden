import { describe, expect, it } from 'vitest';
import { modelConnectionKind, MODEL_CONNECTION_CHOICES } from '../../../core/v4/product/modelConnection';
import { applyWorkbenchDestination, applyWorkbenchSelection, parseWorkbenchDestination } from '../../../dashboard-next/lib/workbenchNavigation';

describe('model connection choices', () => {
  it('groups real admission metadata rather than provider names or pricing', () => {
    expect(modelConnectionKind(['local'])).toBe('local');
    expect(modelConnectionKind(['api_key', 'subscription'])).toBe('byok');
    expect(modelConnectionKind(['oauth', 'device_code', 'subscription'])).toBe('oauth');
    expect(modelConnectionKind(['none'])).toBeNull();
    expect(modelConnectionKind(['unknown'])).toBeNull();
    expect(MODEL_CONNECTION_CHOICES.map((choice) => choice.id)).toEqual(['local', 'byok', 'oauth']);
  });
  it('restores the chosen setup path without changing durable job identity', () => {
    const url = applyWorkbenchDestination('/?job=existing&run=9', { settings: 'model', connectionKind: 'local' });
    expect(parseWorkbenchDestination(new URL(url, 'http://localhost').search)).toEqual({ settings: 'model', connectionKind: 'local' });
    const restored = applyWorkbenchSelection(url, '?job=existing&run=9&attempt=current', true);
    expect(restored).toContain('connection=local');
    expect(restored).toContain('job=existing');
    expect(applyWorkbenchSelection(restored, '?job=new', false)).not.toContain('connection=');
    expect(applyWorkbenchDestination(restored, { settings: 'account' })).not.toContain('connection=');
  });
  it('ignores unsupported and misplaced connection choices', () => {
    expect(parseWorkbenchDestination('?settings=model&connection=imaginary')).toEqual({ settings: 'model' });
    expect(parseWorkbenchDestination('?settings=account&connection=oauth')).toEqual({ settings: 'account' });
  });
});
