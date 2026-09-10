import { describe, expect, it } from 'vitest';
import { parseBrowserCheckContract, browserCheckRequestAllowed, browserCheckToolAllowed } from '../../../core/v4/browser/browserCheckContract';

const contract = () => ({ version: 1, customerId: 'sample-customer', specDigest: 'a'.repeat(64),
  origin: 'http://127.0.0.1:4521', allowLoopback: true, mutationPaths: ['/records'],
  observations: [{ id: 'form.saved', flowId: 'form', selector: '#result', kind: 'text', expected: 'Saved' }] });

describe('approved browser check boundary', () => {
  it('accepts a bounded exact-origin contract and freezes its authority', () => {
    const input = contract(); const value = parseBrowserCheckContract(input);
    input.mutationPaths.push('/other');
    expect(value.mutationPaths).toEqual(['/records']);
    expect(Object.isFrozen(value.observations[0])).toBe(true);
  });
  it.each(['https://user:password@example.com', 'file:///private', 'https://example.com/path',
    'https://example.com?key=value', 'http://169.254.169.254', 'http://10.0.0.2'])('rejects unsafe origin %s', origin => {
    expect(() => parseBrowserCheckContract({ ...contract(), origin })).toThrow();
  });
  it('requires explicit loopback fixture authorization', () => {
    expect(() => parseBrowserCheckContract({ ...contract(), allowLoopback: false })).toThrow();
  });
  it('rejects unbounded executable or ambiguous observation definitions', () => {
    for (const observation of [{ ...contract().observations[0], kind: 'evaluate' },
      { ...contract().observations[0], script: 'anything' }, { ...contract().observations[0], selector: '*' }]) {
      expect(() => parseBrowserCheckContract({ ...contract(), observations: [observation] })).toThrow();
    }
  });
  it('rejects duplicate identities and empty or oversized contracts', () => {
    expect(() => parseBrowserCheckContract({ ...contract(), observations: [] })).toThrow();
    expect(() => parseBrowserCheckContract({ ...contract(), observations: [contract().observations[0], contract().observations[0]] })).toThrow();
    expect(() => parseBrowserCheckContract({ ...contract(), unexpected: true })).toThrow();
  });
  it('permits only the approved origin and exact mutation paths', () => {
    const value = parseBrowserCheckContract(contract());
    expect(browserCheckRequestAllowed(value, 'http://127.0.0.1:4521/assets/main.css', 'GET')).toBe(true);
    expect(browserCheckRequestAllowed(value, 'http://127.0.0.1:4521/records', 'POST')).toBe(true);
    for (const [url, method] of [['http://127.0.0.1:4521/admin', 'POST'], ['http://127.0.0.1:4521/records', 'DELETE'],
      ['http://127.0.0.1:4522/records', 'POST'], ['https://other.example/', 'GET'],
      ['http://127.0.0.1:4521/records/../admin', 'POST'], ['http://127.0.0.1:4521/records?token=secret', 'POST']])
      expect(browserCheckRequestAllowed(value, url, method)).toBe(false);
  });
  it('cannot use generic execution, native input, uploads or arbitrary page evaluation', () => {
    for (const name of ['shell_exec', 'execute_code', 'app_input', 'browser_real_eval', 'browser_upload',
      'browser_download', 'file_write', 'subagent_fanout', 'tool_call', 'external_coding'])
      expect(browserCheckToolAllowed(name)).toBe(false);
    expect(browserCheckToolAllowed('browser_navigate')).toBe(true);
    expect(browserCheckToolAllowed('browser_check_observe')).toBe(true);
  });
});
