import { describe, expect, it } from 'vitest';
import { durableApprovalCards } from '../../../dashboard-next/lib/workbenchUx';
import { presentApproval } from '../../../dashboard-next/lib/workbenchPresentation';

const row = {
  approval_id: 'approval_connect', job_id: 'job_connect', attempt_id: 'attempt_connect',
  generation: 1, tool_call_id: 'tool_connect', effect_id: 'effect_connect',
  tool_name: 'app_connect', risk_tier: 'caution', state: 'displayed', requested_at: 1,
};

describe('App connection approval presentation', () => {
  it('names the exact app and service without implying consent has been granted', () => {
    const [card] = durableApprovalCards([{ ...row, normalized_execution_plan: JSON.stringify({
      args: { provider_id: 'composio', toolkit_id: 'github', ignored: 'private-value' },
      affectedResources: [],
    }) }]);
    expect(card).toMatchObject({ appConnection: { providerId: 'composio', toolkitId: 'github' } });
    expect(JSON.stringify(card)).not.toContain('private-value');
    const presentation = presentApproval(card!);
    expect(presentation.what).toBe('Connect an app');
    expect(presentation.where).toBe('GitHub via Composio');
    expect(presentation.impact).toContain('does not grant account access');
    expect(presentation.afterApproval).toContain('provider');
    expect(presentation.afterApproval).not.toContain('then verify the result');
    expect(presentation.actionable).toBe(true);
  });

  it.each([
    {}, { provider_id: 'composio' },
    { provider_id: 'https://example.invalid/?secret=value', toolkit_id: 'github' },
    { provider_id: 'composio', toolkit_id: '<script>' },
  ])('does not offer an actionable connection without safe bound identities: %j', args => {
    const [card] = durableApprovalCards([{ ...row, normalized_execution_plan: { args } }]);
    expect(card?.appConnection).toBeUndefined();
    expect(presentApproval(card!).actionable).toBe(false);
    expect(presentApproval(card!).where).toBe('Connection details unavailable');
  });
});
