import type { WorkbenchAppToolkit, WorkbenchConnectedAccount, WorkbenchLearningConflict, WorkbenchLearningEntry, WorkbenchLearningScopeKind } from './aidenClient';

export function knowledgeScopeLabel(kind: WorkbenchLearningScopeKind): string {
  return { USER_GLOBAL: 'Across my workspaces', WORKSPACE: 'This workspace', REPOSITORY: 'This repository', PROJECT: 'Project', AUTOMATION: 'Automation', SKILL: 'Skill' }[kind];
}

export type KnowledgeFilter = 'all' | 'ready' | 'review' | 'archived';
export function filterKnowledge(entries: readonly WorkbenchLearningEntry[], query: string, filter: KnowledgeFilter): WorkbenchLearningEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => entry.lifecycle !== 'DELETED' && entry.content !== null)
    .filter(entry => filter === 'all' || (filter === 'archived' ? entry.lifecycle === 'ARCHIVED'
      : filter === 'ready' ? entry.eligible && entry.lifecycle === 'ACTIVE' && entry.confidence === 'TRUSTED'
        : entry.lifecycle !== 'ARCHIVED' && !(entry.eligible && entry.lifecycle === 'ACTIVE' && entry.confidence === 'TRUSTED')))
    .filter(entry => terms.every(term => `${entry.content} ${entry.type.replaceAll('_', ' ')}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export interface KnowledgeNode { id: string; kind: 'scope' | 'entry'; label: string; entryId?: string }
export interface KnowledgeEdge { from: string; to: string; kind: 'scope' | 'conflict' }
export function knowledgeGraph(entries: readonly WorkbenchLearningEntry[], conflicts: readonly WorkbenchLearningConflict[]) {
  const visible = filterKnowledge(entries, '', 'all');
  const bounded = visible.slice(0, 40);
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const scopes = new Set<string>();
  const ids = new Set(bounded.map(entry => entry.id));
  for (const entry of bounded) {
    const scopeId = `scope:${JSON.stringify([entry.scope.ownerId, entry.scope.workspaceId, entry.scope.kind, entry.scope.key])}`;
    if (!scopes.has(scopeId)) { scopes.add(scopeId); nodes.push({ id: scopeId, kind: 'scope', label: knowledgeScopeLabel(entry.scope.kind) }); }
    const id = `entry:${entry.id}`;
    nodes.push({ id, kind: 'entry', label: entry.content!, entryId: entry.id });
    edges.push({ from: scopeId, to: id, kind: 'scope' });
  }
  for (const conflict of conflicts) {
    if (conflict.state === 'OPEN' && ids.has(conflict.leftEntryId) && ids.has(conflict.rightEntryId)) {
      edges.push({ from: `entry:${conflict.leftEntryId}`, to: `entry:${conflict.rightEntryId}`, kind: 'conflict' });
    }
  }
  return { nodes, edges, omitted: visible.length - bounded.length };
}

const APP_DETAILS: Record<string, { category: string; description: string; mark: string }> = {
  github: { category: 'Development', description: 'Turn repository issues into a clear project brief.', mark: 'GH' },
  gmail: { category: 'Communication', description: 'Find important mail and prepare drafts for review.', mark: 'G' },
  slack: { category: 'Communication', description: 'Work with your team channels and conversations.', mark: 'S' },
  notion: { category: 'Knowledge', description: 'Use your notes and project documentation.', mark: 'N' },
  googledrive: { category: 'Knowledge', description: 'Find and work with your documents.', mark: 'D' },
  googlecalendar: { category: 'Productivity', description: 'Use your calendar with clear account permissions.', mark: 'C' },
  linear: { category: 'Development', description: 'Keep track of issues and project updates.', mark: 'L' },
};

export function catalogApps(toolkits: readonly WorkbenchAppToolkit[], accounts: readonly WorkbenchConnectedAccount[]) {
  const available = Array.from(new Map(toolkits.map(toolkit => [JSON.stringify([toolkit.providerId, toolkit.toolkitId]), toolkit])).values());
  const cards = available.map(toolkit => {
    const key = toolkit.toolkitId.toLowerCase();
    const linked = accounts.filter(account => account.providerId === toolkit.providerId && account.toolkitId === toolkit.toolkitId && account.status !== 'revoked');
    return { id: JSON.stringify([toolkit.providerId, toolkit.toolkitId]), label: toolkit.label, toolkit: toolkit as WorkbenchAppToolkit | null,
      ...(APP_DETAILS[key] ?? { category: 'Other', description: 'Explore the actions available for your connected account.', mark: toolkit.label.slice(0, 2).toUpperCase() }),
      status: linked.some(account => account.health !== 'healthy' || account.status !== 'active') ? 'attention' : linked.length ? 'connected' : 'available', accounts: linked };
  });
  for (const key of ['github', 'gmail']) if (!available.some(toolkit => toolkit.toolkitId.toLowerCase() === key)) {
    cards.push({ id: `setup:${key}`, label: key === 'github' ? 'GitHub' : 'Gmail', toolkit: null,
      ...APP_DETAILS[key], status: 'setup', accounts: [] });
  }
  return cards.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function workflowOutline(input: { prompt: string; schedule: string; allowWrite: boolean }) {
  return [
    { kind: 'trigger', title: input.schedule || 'Choose a schedule', detail: 'Starts when Aiden is available under your schedule policy.' },
    { kind: 'task', title: 'Aiden task', detail: input.prompt.trim() || 'Describe the outcome you want.' },
    { kind: 'review', title: input.allowWrite ? 'Workspace changes allowed' : 'Read-only workspace', detail: 'Existing action approvals still apply.' },
    { kind: 'result', title: 'Result & evidence', detail: 'Inspect the actual outcome in run history.' },
  ];
}
