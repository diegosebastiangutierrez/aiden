/**
 * v4.3 Phase 5 — Browser-tool classifier + verifier tests.
 *
 * Coverage:
 *   1. browserInteractiveClassifier — 4 priority tiers
 *      (manual_blocker > stale_ref-from-retry > stale_ref-from-noop
 *       > fallthrough to default)
 *   2. browserNavigateClassifier — manual_blocker only
 *   3. Confidence scoring (0.95 / 0.9 / 0.75 per design)
 *   4. browserInteractiveVerifier — demotes success when needs_verifier
 *   5. Verifier demotion produces `no_progress` code when maybe_noop,
 *      `low_signal` otherwise
 *   6. Both new classifiers fall through to defaultClassifier when no
 *      browserState sidecar present (AIDEN_BROWSER_DEPTH=0 path)
 *   7. Registry registration sanity (all 4 browser tools wired)
 */
import { describe, it, expect } from 'vitest';
import {
  browserInteractiveClassifier,
  browserNavigateClassifier,
  buildDefaultClassifier,
} from '../../../core/v4/failureClassifier';
import {
  browserInteractiveVerifier,
  buildDefaultRegistry,
} from '../../../core/v4/verifier';
import type { VerificationResult } from '../../../core/v4/verifier';
import type { ToolCallResult } from '../../../providers/v4/types';

function mkResult(over: Partial<ToolCallResult> = {}): ToolCallResult {
  return {
    id:     't1',
    name:   'browser_click',
    result: { success: false, error: 'something failed' },
    ...over,
  };
}

function mkFailed(reason: string): VerificationResult {
  return { ok: false, confidence: 1.0, code: 'failed', reason };
}

function mkOk(): VerificationResult {
  return { ok: true, confidence: 1.0, code: 'ok' };
}

describe('browser action-specific verification', () => {
  it('preserves verified input readback when visible page text does not change', () => {
    const result = mkResult({ name: 'browser_type', result: {
      success: true, verified: true, value: 'demo value',
      browserState: { needs_verifier: true, maybe_noop: true, progress_score: 0 },
    } });
    expect(browserInteractiveVerifier('browser_type', { text: 'demo value' }, result).ok).toBe(true);
  });
  it('does not accept a failed action merely because verified is present', () => {
    const result = mkResult({ result: { success: false, verified: true, error: 'Input value did not match' } });
    expect(browserInteractiveVerifier('browser_type', {}, result).ok).toBe(false);
  });
});

// Helper: tool result with a browserState sidecar.
function mkResultWithSidecar(sidecar: Record<string, unknown>): ToolCallResult {
  return mkResult({
    result: {
      success:      false,
      error:        'Element not found',
      browserState: sidecar,
    },
  });
}

// ── browserInteractiveClassifier — priority 1: manual_blocker ──────────────

describe('browserInteractiveClassifier — manual_blocker', () => {
  it('routes blocker present → manual_blocker (conf 0.95)', () => {
    const c = browserInteractiveClassifier(
      mkFailed('Element not found'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [],
        maybe_noop: true, needs_verifier: true,
        blocker: {
          kind: 'login', subtype: 'password',
          url: 'https://example.com/login',
          confidence: 0.9, evidence: ['text:sign in'],
          message: 'Sign in required.',
        },
      }),
    );
    expect(c.category).toBe('manual_blocker');
    expect(c.confidence).toBe(0.95);
    expect(c.recoverable).toBe(false);
    expect(c.recoveryHint?.action).toBe('request_user_action');
    expect(c.matchedPattern).toContain('blocker.login');
  });

  it('blocker reason includes subtype + URL', () => {
    const c = browserInteractiveClassifier(
      mkFailed('blocked'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [], maybe_noop: false, needs_verifier: false,
        blocker: {
          kind: '2fa', subtype: 'totp',
          url: 'https://example.com/verify',
          confidence: 0.9, evidence: [],
          message: 'Enter the code.',
        },
      }),
    );
    expect(c.reason).toContain('2fa');
    expect(c.reason).toContain('totp');
    expect(c.reason).toContain('https://example.com/verify');
  });

  it('blocker beats failed staleRefRetry (priority ordering)', () => {
    const c = browserInteractiveClassifier(
      mkFailed('not found'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [], maybe_noop: false, needs_verifier: false,
        staleRefRetry: { attempted: true, succeeded: false, reason: 'timeout', state_delta: [] },
        blocker: {
          kind: 'captcha', url: 'https://blocked.com/', confidence: 0.9,
          evidence: [], message: 'solve captcha',
        },
      }),
    );
    expect(c.category).toBe('manual_blocker');   // blocker wins
  });
});

// ── browserInteractiveClassifier — priority 2: stale_ref (retry failed) ────

describe('browserInteractiveClassifier — stale_ref from retry failure', () => {
  it('routes staleRefRetry.succeeded=false → stale_ref (conf 0.9)', () => {
    const c = browserInteractiveClassifier(
      mkFailed('Element not found'), 'browser_type', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0.4, evidence: ['url_changed'],
        maybe_noop: false, needs_verifier: false,
        staleRefRetry: {
          attempted: true, succeeded: false,
          reason: 'element not found', state_delta: ['url_changed'],
        },
      }),
    );
    expect(c.category).toBe('stale_ref');
    expect(c.confidence).toBe(0.9);
    expect(c.recoverable).toBe(true);
    expect(c.recoveryHint?.action).toBe('retry');
    expect(c.matchedPattern).toBe('browserState.staleRefRetry.failed');
  });

  it('does NOT route to stale_ref when staleRefRetry succeeded', () => {
    // Successful retry means the action ultimately succeeded — no
    // classification at all (verifier.ok would be true). But test
    // the classifier-only path defensively: when verification says
    // failed but staleRefRetry says succeeded, fall through to
    // default (this is an unusual shape; classifier handles it).
    const c = browserInteractiveClassifier(
      mkFailed('Element not found'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0.8, evidence: ['url_changed'],
        maybe_noop: false, needs_verifier: false,
        staleRefRetry: { attempted: true, succeeded: true, reason: 'fixed', state_delta: [] },
      }),
    );
    // Falls through to defaultClassifier — matches 'not found' pattern.
    expect(c.category).toBe('not_found');
  });
});

// ── browserInteractiveClassifier — priority 3: stale_ref from no-progress ─

describe('browserInteractiveClassifier — stale_ref from needs_verifier', () => {
  it('maybe_noop=true → stale_ref (conf 0.75)', () => {
    const c = browserInteractiveClassifier(
      mkFailed('demoted by verifier'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [],
        maybe_noop: true, needs_verifier: true,
      }),
    );
    expect(c.category).toBe('stale_ref');
    expect(c.confidence).toBe(0.75);
    expect(c.recoverable).toBe(true);
    expect(c.matchedPattern).toBe('browserState.no_progress');
  });

  it('needs_verifier=true + low progress_score → stale_ref', () => {
    const c = browserInteractiveClassifier(
      mkFailed('low signal'), 'browser_type', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0.2, evidence: ['title_changed'],
        maybe_noop: false, needs_verifier: true,
      }),
    );
    expect(c.category).toBe('stale_ref');
    expect(c.confidence).toBe(0.75);
  });

  it('needs_verifier=true but high progress_score → fall through (not stale_ref)', () => {
    const c = browserInteractiveClassifier(
      mkFailed('Element not found'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0.8, evidence: ['url_changed'],
        maybe_noop: false, needs_verifier: true,    // flag set but score is high
      }),
    );
    // Falls through to default — matches 'not found' pattern.
    expect(c.category).toBe('not_found');
  });
});

// ── browserInteractiveClassifier — fall-through ────────────────────────────

describe('browserInteractiveClassifier — fall-through to default', () => {
  it('no browserState sidecar → falls through to defaultClassifier', () => {
    // AIDEN_BROWSER_DEPTH=0 path: tool result has no browserState.
    const c = browserInteractiveClassifier(
      mkFailed('Element not found or not visible: "#submit"'),
      'browser_click', {},
      mkResult({ result: { success: false, error: 'Element not found or not visible: "#submit"' } }),
    );
    // Default classifier matches "not found" pattern.
    expect(c.category).toBe('not_found');
  });

  it('browserState present but no signals → falls through', () => {
    const c = browserInteractiveClassifier(
      mkFailed('Timeout 5000ms exceeded'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0.8, evidence: ['url_changed'],
        maybe_noop: false, needs_verifier: false,
      }),
    );
    // Default classifier matches "timeout" pattern.
    expect(c.category).toBe('timeout');
  });
});

// ── browserNavigateClassifier ──────────────────────────────────────────────

describe('browserNavigateClassifier', () => {
  it('routes blocker → manual_blocker (same as interactive)', () => {
    const c = browserNavigateClassifier(
      mkFailed('Page captcha-walled'), 'browser_navigate', { url: 'https://x.com/' },
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [], maybe_noop: false, needs_verifier: false,
        blocker: {
          kind: 'captcha', subtype: 'cloudflare',
          url: 'https://x.com/', confidence: 0.95, evidence: [],
          message: 'CAPTCHA at x.com.',
        },
      }),
    );
    expect(c.category).toBe('manual_blocker');
    expect(c.confidence).toBe(0.95);
  });

  it('ignores staleRefRetry (navigate is excluded from STALE_REF_RETRYABLE)', () => {
    const c = browserNavigateClassifier(
      mkFailed('Element not found'), 'browser_navigate', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [], maybe_noop: false, needs_verifier: false,
        staleRefRetry: { attempted: true, succeeded: false, reason: 'r', state_delta: [] },
      }),
    );
    // staleRefRetry is read by browserInteractiveClassifier ONLY.
    // browserNavigateClassifier falls through — matches "not found".
    expect(c.category).toBe('not_found');
  });
});

// ── browserInteractiveVerifier ─────────────────────────────────────────────

describe('browserInteractiveVerifier — demotion via needs_verifier', () => {
  it('passes through success when no sidecar present', () => {
    const v = browserInteractiveVerifier('browser_click', {}, mkResult({
      result: { success: true },
    }));
    expect(v.ok).toBe(true);
  });

  it('passes through success when needs_verifier=false', () => {
    const v = browserInteractiveVerifier('browser_click', {}, mkResult({
      result: {
        success: true,
        browserState: {
          progress_score: 0.8, evidence: ['url_changed'],
          maybe_noop: false, needs_verifier: false,
        },
      },
    }));
    expect(v.ok).toBe(true);
  });

  it('demotes success when needs_verifier=true + maybe_noop=true → no_progress code', () => {
    const v = browserInteractiveVerifier('browser_click', {}, mkResult({
      result: {
        success: true,
        browserState: {
          progress_score: 0, evidence: [],
          maybe_noop: true, needs_verifier: true,
        },
      },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('no_progress');
    expect(v.confidence).toBe(0.75);
    expect(v.reason).toContain('did not change');
  });

  it('demotes success when needs_verifier=true + maybe_noop=false → low_signal code', () => {
    const v = browserInteractiveVerifier('browser_click', {}, mkResult({
      result: {
        success: true,
        browserState: {
          progress_score: 0.2, evidence: ['title_changed'],
          maybe_noop: false, needs_verifier: true,
        },
      },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('low_signal');
    expect(v.reason).toContain('low progress');
  });

  it('respects original failure when base verifier said failed', () => {
    // success: false at the envelope level — defaultVerifier returns
    // failed before our demotion path. The needs_verifier flag should
    // not promote a failure.
    const v = browserInteractiveVerifier('browser_click', {}, mkResult({
      result: {
        success: false,
        error:   'real failure',
        browserState: {
          progress_score: 0.8, evidence: ['url_changed'],
          maybe_noop: false, needs_verifier: false,
        },
      },
    }));
    expect(v.ok).toBe(false);
    // Code is 'failed' (defaultVerifier) — not the Phase 5 'no_progress'.
    expect(v.code).toBe('failed');
  });
});

// ── Registry registration sanity ───────────────────────────────────────────

describe('Registry registration sanity', () => {
  it('classifier registry wires all 4 browser tools', () => {
    const reg = buildDefaultClassifier();
    expect(reg.hasOverride('browser_click')).toBe(true);
    expect(reg.hasOverride('browser_type')).toBe(true);
    expect(reg.hasOverride('browser_fill')).toBe(true);
    expect(reg.hasOverride('browser_navigate')).toBe(true);
  });

  it('verifier registry wires all 4 browser tools', () => {
    const reg = buildDefaultRegistry();
    expect(reg.hasOverride('browser_click')).toBe(true);
    expect(reg.hasOverride('browser_type')).toBe(true);
    expect(reg.hasOverride('browser_fill')).toBe(true);
    expect(reg.hasOverride('browser_navigate')).toBe(true);
  });

  it('verifier registry routes browser_click through browserInteractiveVerifier', () => {
    const reg = buildDefaultRegistry();
    const verifier = reg.resolve('browser_click');
    // Should demote success when sidecar says maybe_noop.
    const v = verifier('browser_click', {}, mkResult({
      result: {
        success: true,
        browserState: {
          progress_score: 0, evidence: [],
          maybe_noop: true, needs_verifier: true,
        },
      },
    }));
    expect(v.ok).toBe(false);
  });

  it('classifier registry routes browser_click through browserInteractiveClassifier', () => {
    const reg = buildDefaultClassifier();
    const cls = reg.resolve('browser_click');
    const c = cls(
      mkFailed('Element not found'), 'browser_click', {},
      mkResultWithSidecar({
        pre_state: null, post_state: null,
        progress_score: 0, evidence: [], maybe_noop: false, needs_verifier: false,
        blocker: {
          kind: 'login', url: 'https://example.com/login',
          confidence: 0.9, evidence: [], message: 'sign in',
        },
      }),
    );
    expect(c.category).toBe('manual_blocker');
  });
});
