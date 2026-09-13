import type { SystemReadinessProjection } from './aidenClient';

export const ONBOARDING_STEP_KEY = 'aiden:first-run:step:v1';

export function readOnboardingStep(storage: Pick<Storage, 'getItem'>, count: number): number {
  try {
    const raw = storage.getItem(ONBOARDING_STEP_KEY) ?? '0';
    if (!/^\d+$/.test(raw)) return 0;
    const saved = Number(raw);
    return Number.isSafeInteger(saved) && saved >= 0 && saved < count ? saved : 0;
  } catch { return 0; }
}

export function saveOnboardingStep(storage: Pick<Storage, 'setItem'>, step: number): void {
  try { storage.setItem(ONBOARDING_STEP_KEY, String(step)); } catch { /* Setup remains usable without browser persistence. */ }
}

export function onboardingReadiness(readiness: SystemReadinessProjection | null): { canStart: boolean } {
  return { canStart: readiness?.overall === 'ready'
    && readiness.items.some(item => item.id === 'chat-provider' && item.ready === true)
    && readiness.items.every(item => !item.blocking || item.ready === true) };
}
