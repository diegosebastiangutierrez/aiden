import { describe, expect, it } from 'vitest';

import { classifyBrowserError, classifyBrowserResult } from '../../../core/v4/browser/browserErrors';
import { BrowserAuthorityError } from '../../../core/v4/browser/browserSessionAuthority';

describe('typed browser errors', () => {
  it('distinguishes a missing snapshot lease before dispatch from an uncertain stale action', () => {
    expect(classifyBrowserResult({ success: false, error: 'Element ref @e14 is not in the current snapshot. Run browser_snapshot to refresh element refs, then retry.' }, 'browser_click'))
      .toMatchObject({ code: 'FRESH_OBSERVATION_REQUIRED', retryable: true });
    expect(classifyBrowserError('Element detached from the DOM', 'browser_click')).toMatchObject({ code: 'STALE_ELEMENT' });
  });
  it('does not treat embedded error text or a partially applied multi-field fill as pre-dispatch rejection', () => {
    const missing = 'Element ref @e14 is not in the current snapshot. Run browser_snapshot to refresh element refs, then retry.';
    expect(classifyBrowserError(`Action timed out: ${missing}`, 'browser_click').code).not.toBe('FRESH_OBSERVATION_REQUIRED');
    expect(classifyBrowserError(missing, 'browser_fill').code).not.toBe('FRESH_OBSERVATION_REQUIRED');
  });
  it.each([
    ['Target page, context or browser has been closed', 'PAGE_CLOSED'],
    ['Element not found', 'ELEMENT_NOT_FOUND'],
    ['Element is not visible', 'ELEMENT_NOT_VISIBLE'],
    ['Timeout 5000ms exceeded', 'NAVIGATION_TIMEOUT'],
    ['Sign in is required', 'BLOCKED_BY_LOGIN'],
    ['Interactive approval is required', 'APPROVAL_REQUIRED'],
    ['Upload file is unavailable', 'UPLOAD_FAILED'],
    ['Download did not complete', 'DOWNLOAD_FAILED'],
  ])('maps %s to %s', (message, code) => {
    expect(classifyBrowserError(new Error(message))).toMatchObject({ code, message });
  });

  it('preserves durable authority error identity', () => {
    expect(classifyBrowserError(new BrowserAuthorityError('TAB_NOT_OWNED', 'wrong Job')))
      .toMatchObject({ code: 'TAB_NOT_OWNED', message: 'wrong Job' });
  });

  it('separates protocol success from failed verification', () => {
    expect(classifyBrowserResult({ success: true, verified: false }))
      .toMatchObject({ code: 'VERIFICATION_FAILED' });
    expect(classifyBrowserResult({ success: false, error: 'CAPTCHA challenge', captcha_detected: true }))
      .toMatchObject({ code: 'BLOCKED_BY_CAPTCHA' });
  });
});
