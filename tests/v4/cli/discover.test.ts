import { describe, it, expect, vi } from 'vitest';
import { discover } from '../../../cli/v4/commands/discover';
import type { SlashCommandContext } from '../../../cli/v4/commandRegistry';

describe('CLI capability discovery', () => {
  it('finds setup paths without invoking tools or changing configuration', async () => {
    const write = vi.fn();
    await discover.handler({ args: ['telegram'], display: { write } } as unknown as SlashCommandContext);
    const output = write.mock.calls.flat().join('');
    expect(output).toContain('Telegram');
    expect(output).toContain('?settings=channels');
    expect(output).toContain('not connection health');
    expect(output).not.toContain('Connected successfully');
  });
  it('shows a useful empty state', async () => {
    const write = vi.fn();
    await discover.handler({ args: ['nonexistent-example'], display: { write } } as unknown as SlashCommandContext);
    expect(write.mock.calls.flat().join('')).toContain('No matching capability');
  });
});
