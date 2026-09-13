export function pendingConnectionRemoved(previous: readonly string[], current: readonly string[]): boolean {
  const remaining = new Set(current);
  return previous.some(id => !remaining.has(id));
}

export function presentMcpConnection(server: { status: string; authState: string; reviewRequired: boolean }): { label: string; tone: 'ready' | 'attention' | 'disabled' } {
  if (server.reviewRequired) return { label: 'Permissions need review', tone: 'attention' };
  if (server.authState === 'required') return { label: 'Authentication required', tone: 'attention' };
  if (server.status === 'ready' && server.authState === 'ready') return { label: 'Connected', tone: 'ready' };
  if (server.status === 'initializing' || server.status === 'reconnecting') return { label: 'Connecting', tone: 'attention' };
  if (server.status === 'disabled') return { label: 'Disabled', tone: 'disabled' };
  if (server.status === 'error' || server.status === 'disconnected') return { label: 'Disconnected', tone: 'attention' };
  return { label: 'Connection unavailable', tone: 'attention' };
}
