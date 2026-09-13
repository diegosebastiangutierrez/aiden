import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { WindowsDpapiSecretBackend } from '../../../core/v4/integrations/secretAuthority';

describe.skipIf(process.platform !== 'win32')('Windows CurrentUser secret protection', () => {
  it('round trips through a fresh noninteractive PowerShell without a preloaded security assembly', async () => {
    const backend = new WindowsDpapiSecretBackend();
    const value = randomBytes(32).toString('base64url');
    const encrypted = await backend.protect(value);
    expect(encrypted.includes(value)).toBe(false);
    expect((await backend.unprotect(encrypted)) === value).toBe(true);
  }, 30000);
  it('fails closed for malformed protected material without exposing it in errors', async () => {
    const backend = new WindowsDpapiSecretBackend();
    await expect(backend.unprotect('invalid-fixture')).rejects.toThrow('Platform secret protection failed');
  }, 30000);
});
