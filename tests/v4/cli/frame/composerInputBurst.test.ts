import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { makeComposer, type InkComponents } from '../../../../cli/v4/frame/composer';
import { makeInitialState } from '../../../../cli/v4/frame/state';

function fixture() {
  let input!: Parameters<InkComponents['useInput']>[0];
  const React = require('react') as typeof import('react');
  const Primitive = ({ children }: { children?: ReactNode }) => React.createElement('span', null, children);
  const Composer = makeComposer({ Box: Primitive, Text: Primitive, useInput: handler => { input = handler; } });
  const callbacks = { onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() };
  const ref = vi.spyOn(React, 'useRef').mockImplementation((value: any) => ({ current: value }));
  try { (Composer as (props: any) => unknown)({ state: makeInitialState('> '), callbacks }); }
  finally { ref.mockRestore(); }
  return { input: (...args: Parameters<typeof input>) => input(...args), callbacks };
}

describe('Composer input before the next render', () => {
  it('preserves consecutive input chunks and submits the latest value once', () => {
    const f = fixture();
    f.input('hello ', {}); f.input('world', {}); f.input('', { return: true }); f.input('', { return: true });
    expect(f.callbacks.onChange.mock.calls.at(-1)).toEqual(['hello world', 11]);
    expect(f.callbacks.onSubmit).toHaveBeenCalledExactlyOnceWith('hello world');
  });
  it('applies cursor movement and deletion to the latest input', () => {
    const f = fixture();
    f.input('abc', {}); f.input('', { leftArrow: true }); f.input('', { backspace: true });
    f.input('z', {}); f.input('', { return: true });
    expect(f.callbacks.onSubmit).toHaveBeenCalledExactlyOnceWith('azc');
  });
  it('does not submit or accept more input after cancellation', () => {
    const f = fixture();
    f.input('draft', {}); f.input('c', { ctrl: true }); f.input('more', {}); f.input('', { return: true });
    expect(f.callbacks.onCancel).toHaveBeenCalledOnce();
    expect(f.callbacks.onSubmit).not.toHaveBeenCalled();
    expect(f.callbacks.onChange).toHaveBeenCalledOnce();
  });
});
