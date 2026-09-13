/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { attachFrameInput } from '../../../../cli/v4/frame/inputTransport';
import { PASTE_BEGIN, PASTE_END, PASTE_ENABLE, PASTE_DISABLE } from '../../../../cli/v4/bracketedPaste';

function fixture() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
  const input = vi.fn(), output = vi.fn();
  const detach = attachFrameInput(stdin as unknown as NodeJS.ReadStream, input, output);
  return { stdin, input, output, detach };
}

describe('frame terminal input transport', () => {
  it('separates fast text plus Enter into ordered editing and submit events', () => {
    const f = fixture(); f.stdin.write('p\r');
    expect(f.input.mock.calls).toEqual([['p', {}], ['', { return: true }]]);
    f.detach();
  });
  it('preserves coalesced editing controls without treating an arrow as Escape', () => {
    const f = fixture(); f.stdin.write('ab\u001b[D\u007fz\r');
    expect(f.input.mock.calls).toEqual([['a', {}], ['b', {}], ['', { leftArrow: true }], ['', { backspace: true }], ['z', {}], ['', { return: true }]]);
    f.detach();
  });
  it('keeps bracketed multiline paste literal, even across split markers', () => {
    const f = fixture(); const bytes = PASTE_BEGIN + 'one\r\ntwo\r' + PASTE_END;
    for (const byte of bytes) f.stdin.write(byte);
    expect(f.input).toHaveBeenCalledExactlyOnceWith('one\ntwo\n', {});
    f.stdin.write('\r'); expect(f.input.mock.calls.at(-1)).toEqual(['', { return: true }]);
    f.detach();
  });
  it('does not turn pasted control or escape keys into cancellation or submission', () => {
    const f = fixture(); f.stdin.write(PASTE_BEGIN + 'a\u0003\u001b[D\rb' + PASTE_END);
    expect(f.input.mock.calls).toEqual([['a\nb', {}]]);
    f.detach();
  });
  it('discards incomplete paste and detaches owned listeners on shutdown', () => {
    const f = fixture(); f.stdin.write(PASTE_BEGIN + '/quit\r'); f.detach(); f.detach();
    expect(f.input).not.toHaveBeenCalled();
    expect(f.stdin.listenerCount('data')).toBe(0);
    expect(f.stdin.isRaw).toBe(false);
    expect(f.output.mock.calls).toEqual([[PASTE_ENABLE], [PASTE_DISABLE]]);
  });
  it('preserves the previous raw-mode state and ignores input after detach', () => {
    const f = fixture(); f.detach(); f.stdin.isRaw = true;
    const stop = attachFrameInput(f.stdin as unknown as NodeJS.ReadStream, f.input, f.output);
    stop(); f.stdin.emit('data', Buffer.from('x\r'));
    expect(f.stdin.isRaw).toBe(true); expect(f.input).not.toHaveBeenCalled();
  });
  it('preserves UTF-8 split across incoming byte chunks', () => {
    const f = fixture(); const bytes = Buffer.from('café');
    for (const byte of bytes) f.stdin.write(Buffer.from([byte]));
    expect(f.input.mock.calls.map(call => call[0]).join('')).toBe('café'); f.detach();
  });
  it('keeps standalone Escape and Ctrl+C available for cancellation', async () => {
    const f = fixture(); f.stdin.write('\u0003'); f.stdin.write('\u001b');
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(f.input.mock.calls).toEqual([['c', { ctrl: true }], ['', { escape: true }]]);
    f.detach();
  });
});
