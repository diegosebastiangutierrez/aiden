import { describe, expect, it, vi } from 'vitest';
import { makeIntegrationConnectTool } from '../../../core/v4/integrations/tools';

describe('app connection request tool', () => {
  it('requires approval and never authorizes a provider account itself', () => {
    const tool = makeIntegrationConnectTool({} as never, { ownerId: 'owner', workspaceId: 'workspace' });
    expect(tool.mutates).toBe(true);
    expect(tool.effectContract?.approvalRequirement).toBe('always');
    expect(tool.effectContract?.retrySafety).toBe('never_automatic');
  });
  it('uses server-owned scope and keeps authorization payload out of tool history', async () => {
    const initiateConnection = vi.fn(async () => ({ connectionId: 'request-1', authorizationUrl: 'https://example.invalid/authorize?private=value', userCode: 'private-code', state: 'pending' }));
    const tool = makeIntegrationConnectTool({ initiateConnection } as never, { ownerId: 'owner', workspaceId: 'workspace' });
    const result = await tool.execute({ provider_id: 'composio', toolkit_id: 'gmail' }, {} as never);
    expect(initiateConnection).toHaveBeenCalledWith({ providerId: 'composio', toolkitId: 'gmail', ownerId: 'owner', workspaceId: 'workspace' });
    expect(result).toMatchObject({ state: 'awaiting_user_authorization', connected: false, connectionId: 'request-1' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([{ provider_id: 'composio', toolkit_id: 'gmail', owner_id: 'other' }, { provider_id: 'composio', toolkit_id: 'gmail', credential: 'not-allowed' }, { provider_id: 'composio', toolkit_id: '../elsewhere' }])('rejects scope overrides, credentials and malformed identities', async args => {
    const initiateConnection = vi.fn();
    const tool = makeIntegrationConnectTool({ initiateConnection } as never, { ownerId: 'owner', workspaceId: 'workspace' });
    expect(tool.validateArguments?.(args)).toBeTruthy();
    await expect(tool.execute(args, {} as never)).rejects.toThrow();
    expect(initiateConnection).not.toHaveBeenCalled();
  });
  it('does not start a cancelled request', async () => {
    const initiateConnection = vi.fn(); const controller = new AbortController(); controller.abort();
    const tool = makeIntegrationConnectTool({ initiateConnection } as never, { ownerId: 'owner', workspaceId: 'workspace' });
    await expect(tool.execute({ provider_id: 'composio', toolkit_id: 'github' }, { signal: controller.signal } as never)).rejects.toThrow();
    expect(initiateConnection).not.toHaveBeenCalled();
  });
});
