import { describe, expect, it } from 'vitest';
import { safeAccountPortal } from '../../../core/v4/product/accountPortal';

describe('account portal origin boundary', () => {
  it('accepts an exact configured HTTPS origin without implying authentication', () => {
    expect(safeAccountPortal('https://accounts.example.test/')).toBe('https://accounts.example.test');
  });
  it.each([null, '', ' http://example.test', 'http://example.test', 'https://user:secret@example.test',
    'https://example.test/signin', 'https://example.test/?token=private', 'https://example.test/#secret',
    'https://example.test\\@other.test', 'javascript:alert(1)', '//example.test'])('rejects non-origin account configuration %s', value => {
    expect(safeAccountPortal(value)).toBeNull();
  });
});
