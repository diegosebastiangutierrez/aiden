/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { PASTE_BEGIN, PASTE_END, PASTE_ENABLE, PASTE_DISABLE } from '../bracketedPaste';
import type { InkComponents } from './composer';

type InputHandler = Parameters<InkComponents['useInput']>[0];

/** One input owner for the optional renderer. Decode keys before rendering:
 * a stream chunk is not a key, and a bracketed paste is not a command.
 * The private decoder avoids attaching permanent readline listeners to stdin.
 */
export function attachFrameInput(stdin: NodeJS.ReadStream, handler: InputHandler, write: (text: string) => void): () => void {
  if (!stdin.isTTY) return () => {};
  const decoder = new PassThrough();
  let active = true, pasting = false, pasted = '';
  const wasRaw = stdin.isRaw, wasPaused = stdin.isPaused();
  emitKeypressEvents(decoder);
  const onKey = (text: string | undefined, key: Key = {}) => {
    if (!active) return;
    if (key.sequence === PASTE_BEGIN) { pasting = true; pasted = ''; return; }
    if (key.sequence === PASTE_END) {
      if (pasting && pasted) handler(pasted.replace(/\r\n?/g, '\n'), {});
      pasting = false; pasted = ''; return;
    }
    if (pasting) {
      // Neither control keys nor terminal escape sequences inside a paste
      // may gain execution/cancellation authority.
      if (key.name === 'return' || key.name === 'enter') pasted += key.sequence ?? '\n';
      else if (!key.ctrl && !key.meta && text && !text.includes('\u001b')) pasted += text;
      return;
    }
    if (key.ctrl) { if (key.name === 'c') handler('c', { ctrl: true }); return; }
    if (key.name === 'escape' && key.sequence === '\u001b') { handler('', { escape: true }); return; }
    if (key.meta) return;
    switch (key.name) {
      case 'return': case 'enter': handler('', { return: true }); return;
      case 'backspace': handler('', { backspace: true }); return;
      case 'delete': handler('', { delete: true }); return;
      case 'left': handler('', { leftArrow: true }); return;
      case 'right': handler('', { rightArrow: true }); return;
      case 'escape': handler('', { escape: true }); return;
    }
    if (text && !/[\u0000-\u001f\u007f]/.test(text)) handler(text, {});
  };
  const onData = (chunk: Buffer | string) => { if (active) decoder.write(chunk); };
  decoder.on('keypress', onKey);
  const detach = () => {
    if (!active) return;
    active = false; pasted = ''; pasting = false;
    stdin.removeListener('data', onData);
    decoder.removeListener('keypress', onKey); decoder.destroy();
    try { write(PASTE_DISABLE); } finally {
      stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused && stdin.listenerCount('data') === 0) stdin.pause();
    }
  };
  try {
    stdin.setRawMode(true); write(PASTE_ENABLE);
    stdin.on('data', onData); stdin.resume();
  } catch (error) { detach(); throw error; }
  return detach;
}

/** Use only Ink's public stdin context; do not depend on its private parser
 * or event emitter. Ink paints the view, while this hook owns key decoding.
 */
export function makeFrameInputHook(useStdin: () => { stdin: NodeJS.ReadStream }, write: (text: string) => void): InkComponents['useInput'] {
  const React = require('react') as typeof import('react');
  return (handler, options = {}) => {
    const { stdin } = useStdin();
    const current = React.useRef(handler); current.current = handler;
    // Terminal ownership must end during unmount, before readLine resolves
    // and the CLI can exit. Passive effects may be deferred past process exit.
    React.useLayoutEffect(() => {
      if (options.isActive === false) return;
      return attachFrameInput(stdin, (input, key) => current.current(input, key), write);
    }, [stdin, options.isActive]);
  };
}
