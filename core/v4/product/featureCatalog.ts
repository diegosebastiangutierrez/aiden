/** Product discovery metadata. Connection health and execution permission remain runtime-owned. */
export interface ProductFeature {
  id: string;
  title: string;
  description: string;
  category: 'apps' | 'messaging' | 'tools' | 'workspace' | 'developer';
  destination: { view: 'apps' | 'skills' | 'brain' | 'activity' | 'artifacts' | 'automations' } | {
    settings: 'model' | 'runtime' | 'channels' | 'mcp' | 'ide' | 'coding' | 'capabilities' | 'pro' | 'account';
  };
  setupNote: string;
}

export const PRODUCT_FEATURES: readonly ProductFeature[] = [
  { id: 'apps', title: 'Connected apps', category: 'apps', description: 'GitHub, Gmail and the app actions available from your configured integration provider.', destination: { view: 'apps' }, setupNote: 'Review permissions and connect each account.' },
  { id: 'telegram', title: 'Telegram', category: 'messaging', description: 'Talk to Aiden through your Telegram bot.', destination: { settings: 'channels' }, setupNote: 'Bot setup and allowed users are required.' },
  { id: 'discord', title: 'Discord', category: 'messaging', description: 'Reach Aiden from an authorized Discord bot.', destination: { settings: 'channels' }, setupNote: 'Guided connection currently available in CLI: /channel discord add.' },
  { id: 'slack', title: 'Slack messaging', category: 'messaging', description: 'Use a Slack app and Socket Mode to talk to Aiden.', destination: { settings: 'channels' }, setupNote: 'Adapter available; guided Web setup not yet supported.' },
  { id: 'whatsapp', title: 'WhatsApp Business', category: 'messaging', description: 'Connect through the WhatsApp Business channel adapter.', destination: { settings: 'channels' }, setupNote: 'Business API configuration required; guided Web setup not yet supported.' },
  { id: 'email', title: 'Email channel', category: 'messaging', description: 'Use an IMAP/SMTP mailbox as a messaging channel. This is separate from Gmail app actions.', destination: { settings: 'channels' }, setupNote: 'Mailbox configuration required; guided Web setup not yet supported.' },
  { id: 'webhook', title: 'Webhooks', category: 'messaging', description: 'Receive authorized requests through the channel API.', destination: { settings: 'channels' }, setupNote: 'Requires the API channel runtime; Workbench alone does not enable it.' },
  { id: 'twilio', title: 'SMS via Twilio', category: 'messaging', description: 'Use the existing SMS channel adapter.', destination: { settings: 'channels' }, setupNote: 'Provider configuration and messaging charges may apply; guided Web setup not yet supported.' },
  { id: 'signal', title: 'Signal', category: 'messaging', description: 'Use the signal-cli bridge adapter.', destination: { settings: 'channels' }, setupNote: 'External bridge required; guided Web setup not yet supported.' },
  { id: 'imessage', title: 'iMessage', category: 'messaging', description: 'Use the BlueBubbles bridge adapter.', destination: { settings: 'channels' }, setupNote: 'Requires a macOS bridge; not a native Windows connection.' },
  { id: 'mcp', title: 'MCP servers', category: 'tools', description: 'Add local or remote tool servers, authorize, review capabilities and manage connections.', destination: { settings: 'mcp' }, setupNote: 'Web and /mcp use the same connection authority. Provider consent and tool approvals remain separate.' },
  { id: 'skills', title: 'Skills', category: 'tools', description: 'Find and manage reusable capabilities, installed skills and review requirements.', destination: { view: 'skills' }, setupNote: 'Installation and trust controls still apply.' },
  { id: 'extensions', title: 'Capability extensions', category: 'tools', description: 'Inspect and manage extensions through existing capability authority.', destination: { settings: 'capabilities' }, setupNote: 'Review source and permissions before enabling.' },
  { id: 'browser', title: 'Browser access', category: 'tools', description: 'Check browser availability before asking Aiden to work on a website.', destination: { settings: 'runtime' }, setupNote: 'Browser/session permissions are separate from account sign-in.' },
  { id: 'models', title: 'Models and local Ollama', category: 'tools', description: 'Choose a supported cloud model or configure local Ollama.', destination: { settings: 'model' }, setupNote: 'Authentication, quota and execution readiness are separate.' },
  { id: 'coding', title: 'Coding and local tools', category: 'tools', description: 'Configure coding capabilities and inspect readiness for repository work.', destination: { settings: 'coding' }, setupNote: 'Supervised process policy and approvals remain required.' },
  { id: 'brain', title: 'Brain', category: 'workspace', description: 'Inspect learning records, sources and context used for your work.', destination: { view: 'brain' }, setupNote: 'Existing memory and evidence authority is preserved.' },
  { id: 'workflows', title: 'Workflows and Automations', category: 'workspace', description: 'Manage scheduled work and inspect execution history.', destination: { view: 'automations' }, setupNote: 'Creating or changing scheduled work requires your intent.' },
  { id: 'activity', title: 'Activity and Proof', category: 'workspace', description: 'Inspect Jobs, workers, approvals, Evidence, Verification and Proof.', destination: { view: 'activity' }, setupNote: 'Results come from durable execution records.' },
  { id: 'artifacts', title: 'Files and artifacts', category: 'workspace', description: 'Reopen resulting files and their associated work.', destination: { view: 'artifacts' }, setupNote: 'Workspace and artifact access rules apply.' },
  { id: 'ide', title: 'IDE connections', category: 'developer', description: 'Find configuration for using Aiden from supported coding editors.', destination: { settings: 'ide' }, setupNote: 'Client-specific setup is required.' },
  { id: 'a2a', title: 'External agents · Preview', category: 'developer', description: 'Inspect existing read-only A2A delegation and recoverable remote work.', destination: { settings: 'mcp' }, setupNote: 'Mutation delegation remains disabled; local verification is required.' },
  { id: 'account', title: 'Aiden account', category: 'workspace', description: 'Find the configured email sign-in portal for your account.', destination: { settings: 'account' }, setupNote: 'An account is optional for local Core use.' },
  { id: 'plan', title: 'Plan and billing', category: 'workspace', description: 'Review your existing activation and plan information.', destination: { settings: 'pro' }, setupNote: 'Signing in does not grant a paid entitlement.' },
];

export function searchProductFeatures(query: string, category?: ProductFeature['category']): ProductFeature[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return PRODUCT_FEATURES.filter(feature => (!category || feature.category === category)
    && words.every(word => `${feature.title} ${feature.description} ${feature.setupNote}`.toLowerCase().includes(word)));
}
