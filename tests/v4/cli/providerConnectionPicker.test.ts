import { describe, expect, it, vi } from 'vitest';
import { pickProvider } from '../../../cli/v4/onboarding/providerPicker';
import { PROVIDERS } from '../../../cli/v4/setupWizard';

describe('provider connection picker', () => {
  it('offers connection methods before the matching real providers', async () => {
    const localIndex = PROVIDERS.findIndex((provider) => provider.kind === 'local');
    const select = vi.fn().mockResolvedValueOnce('local').mockResolvedValueOnce(String(localIndex));
    const result = await pickProvider({ providers: PROVIDERS, inquirerImpl: { select } as never });
    expect(result.id).toBe(PROVIDERS[localIndex].id);
    expect(select.mock.calls[0][0].choices.map((choice: { value: string }) => choice.value)).toEqual(['local', 'byok', 'oauth']);
    expect(select.mock.calls[1][0].choices.filter((choice: { value: string }) => choice.value !== 'back').every((choice: { value: string }) => PROVIDERS[Number(choice.value)].kind === 'local')).toBe(true);
  });
  it('can go back without applying a model or crossing connection types', async () => {
    const oauthIndex = PROVIDERS.findIndex((provider) => provider.kind === 'pro' || provider.kind === 'oauth');
    const select = vi.fn().mockResolvedValueOnce('local').mockResolvedValueOnce('back').mockResolvedValueOnce('oauth').mockResolvedValueOnce(String(oauthIndex));
    expect((await pickProvider({ providers: PROVIDERS, inquirerImpl: { select } as never })).index).toBe(oauthIndex);
    expect(select).toHaveBeenCalledTimes(4);
  });
  it('rejects an answer outside the displayed group', async () => {
    const cloudIndex = PROVIDERS.findIndex((provider) => provider.kind === 'key');
    const select = vi.fn().mockResolvedValueOnce('local').mockResolvedValueOnce(String(cloudIndex));
    await expect(pickProvider({ providers: PROVIDERS, inquirerImpl: { select } as never })).rejects.toThrow('selection');
  });
});
