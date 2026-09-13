import type { SlashCommand } from '../commandRegistry';
import { searchProductFeatures } from '../../../core/v4/product/featureCatalog';

export const discover: SlashCommand = {
  name: 'discover',
  description: 'Find capabilities and setup locations; /discover telegram to search.',
  category: 'system',
  handler: async (ctx) => {
    const features = searchProductFeatures(ctx.args.join(' '));
    ctx.display.write('\nAiden capabilities — setup options, not connection health\n\n');
    for (const feature of features) {
      const destination = 'view' in feature.destination ? `view=${feature.destination.view}` : `settings=${feature.destination.settings}`;
      ctx.display.write(`${feature.title}\n  ${feature.description}\n  ${feature.setupNote}\n  Workbench: ?${destination}\n\n`);
    }
    if (!features.length) ctx.display.write('No matching capability. Try /discover without a search.\n');
    ctx.display.write('Setup: /setup · Live capabilities: /status · Messaging: /channel list · MCP: /mcp\n');
  },
};
