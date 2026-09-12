import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { catalogApps, filterKnowledge, knowledgeGraph, knowledgeScopeLabel, workflowOutline } from '../../../dashboard-next/lib/productExperience';
import type { WorkbenchLearningEntry } from '../../../dashboard-next/lib/aidenClient';

const entry = (id: string, content: string, overrides: Partial<WorkbenchLearningEntry> = {}): WorkbenchLearningEntry => ({
  id, content, scope: { kind: 'REPOSITORY', key: 'repo-one', ownerId: 'owner-one', workspaceId: 'workspace-one' },
  type: 'USER_PREFERENCE', subjectKey: 'preference', confidence: 'TRUSTED', lifecycle: 'ACTIVE', eligible: true,
  sourceCount: 1, version: 1, contentDigest: null, createdAt: 1, updatedAt: 2, deletedAt: null, expiresAt: null, ...overrides,
});

describe('Workbench product experience projections', () => {
  it('shows friendly scope names without treating another workspace as the current project', () => {
    expect(knowledgeScopeLabel('REPOSITORY')).toBe('This repository');
    expect(knowledgeScopeLabel('USER_GLOBAL')).toBe('Across my workspaces');
    expect(knowledgeScopeLabel('SKILL')).toBe('Skill');
  });
  it('searches visible knowledge without bringing back deleted content', () => {
    const rows = [entry('one', 'Write concise briefs'), entry('two', 'Use numbered headings'), entry('three', 'Secret old brief', { lifecycle: 'DELETED' })];
    expect(filterKnowledge(rows, 'BRIEF', 'all').map(row => row.id)).toEqual(['one']);
  });
  it('keeps review and archival states distinct from usable context', () => {
    const rows = [entry('one', 'A'), entry('two', 'B', { lifecycle: 'STALE', eligible: false }), entry('three', 'C', { lifecycle: 'ARCHIVED', eligible: false })];
    expect(filterKnowledge(rows, '', 'review').map(row => row.id)).toEqual(['two']);
    expect(filterKnowledge(rows, '', 'archived').map(row => row.id)).toEqual(['three']);
  });
  it('does not merge equal text or same-named scopes across identities', () => {
    const a = entry('one', 'Same text');
    const b = entry('two', 'Same text', { scope: { ...a.scope, key: 'repo-two' } });
    const graph = knowledgeGraph([a, b], []);
    expect(graph.nodes.filter(node => node.kind === 'entry')).toHaveLength(2);
    expect(graph.nodes.filter(node => node.kind === 'scope')).toHaveLength(2);
    expect(graph.edges.filter(edge => edge.kind === 'scope')).toHaveLength(2);
  });
  it('draws only recorded scope membership and in-scope unresolved conflicts', () => {
    const rows = [entry('one', 'A'), entry('two', 'B')];
    const graph = knowledgeGraph(rows, [
      { id: 'conflict-one', leftEntryId: 'one', rightEntryId: 'two', state: 'OPEN', reasonCode: 'different', createdAt: 1, resolvedAt: null },
      { id: 'outside', leftEntryId: 'one', rightEntryId: 'outside', state: 'OPEN', reasonCode: 'different', createdAt: 1, resolvedAt: null },
    ]);
    expect(graph.edges.filter(edge => edge.kind === 'conflict')).toHaveLength(1);
    expect(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to))).toBe(true);
  });
  it('bounds relationship rendering and reports undisplayed entries honestly', () => {
    const graph = knowledgeGraph(Array.from({ length: 120 }, (_, i) => entry(String(i), 'Item')), []);
    expect(graph.nodes.filter(node => node.kind === 'entry')).toHaveLength(40);
    expect(graph.omitted).toBe(80);
  });
  it('keeps multiple providers for the same app separately actionable', () => {
    const cards = catalogApps([{ providerId: 'a', toolkitId: 'github', label: 'GitHub' }, { providerId: 'b', toolkitId: 'github', label: 'GitHub' }], []);
    expect(cards.filter(card => card.toolkit?.toolkitId === 'github')).toHaveLength(2);
    expect(new Set(cards.map(card => card.id)).size).toBe(cards.length);
  });
  it('never pretends a disconnected or missing connector is ready', () => {
    const cards = catalogApps([], []);
    expect(cards.every(card => card.status === 'setup' && !card.toolkit)).toBe(true);
    expect(cards.map(card => card.label)).toContain('GitHub');
  });
  it('surfaces unhealthy connected accounts without claiming healthy access', () => {
    const cards = catalogApps([{ providerId: 'a', toolkitId: 'github', label: 'GitHub' }], [{ accountId: 'account', providerId: 'a', toolkitId: 'github', label: 'Work', status: 'active', health: 'expired', scopes: [], lastCheckedAt: null }]);
    expect(cards.find(card => card.toolkit)?.status).toBe('attention');
  });
  it('workflow outline reflects the draft and never invents an executed step', () => {
    expect(workflowOutline({ prompt: 'Summarise repository issues', schedule: 'Every Monday', allowWrite: false })).toEqual([
      { kind: 'trigger', title: 'Every Monday', detail: 'Starts when Aiden is available under your schedule policy.' },
      { kind: 'task', title: 'Aiden task', detail: 'Summarise repository issues' },
      { kind: 'review', title: 'Read-only workspace', detail: 'Existing action approvals still apply.' },
      { kind: 'result', title: 'Result & evidence', detail: 'Inspect the actual outcome in run history.' },
    ]);
  });
});

describe('Workbench product experience wiring', () => {
  const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
  it('does not replace the existing execution APIs or hide approvals in a draft preview', () => {
    const workflow = page.slice(page.indexOf('function AutomationsView()'), page.indexOf('function SponsorsView()'));
    expect(workflow).toContain('<WorkflowOutline {...outline} />');
    expect(workflow).toContain('aiden.createAutomation(input)');
    expect(workflow).toContain('aiden.reviseAutomation(editing.automationId, input)');
    expect(workflow).toContain('Open child evidence');
    expect(workflow).toContain('Scheduling never bypasses approvals');
  });
  it('starts a chosen template fresh instead of revising an unrelated existing workflow', () => {
    const template = page.slice(page.indexOf('const applyAutomationTemplate'), page.indexOf('const editAutomation'));
    expect(template).toContain('form.reset()');
    expect(template).toContain('setEditing(null)');
    expect(template).toContain('syncOutline()');
  });
  it('keeps disconnected workflows unavailable while providing a direct connection path', () => {
    const apps = page.slice(page.indexOf('function AppsView()'), page.indexOf('function describeAutomationSchedule'));
    expect(apps).toContain("account.status === 'active' && account.health === 'healthy'");
    expect(apps).toContain('Connect an account to build a workflow');
    expect(apps).toContain('aria-label="Search apps"');
    expect(apps).toContain('aria-label="App categories"');
  });
  it('preserves full work discovery when the sidebar shows a bounded preview', () => {
    const sidebar = page.slice(page.indexOf('function HistorySidebar()'), page.indexOf('function EmptyState()'));
    expect(sidebar).toContain('activeJobs.slice(0, 3)');
    expect(sidebar).toContain("openView('activity')}>View all work &amp; details");
  });
  it('uses existing authorized knowledge review and rejects late review responses', () => {
    expect(page).toContain('<BrainExplorer snapshot={snapshot}');
    expect(page).toContain('aiden.loadLearningReview(entryId)');
    expect(page).toContain('if (request !== reviewRequest.current) return');
    expect(page).toContain('knowledgeScopeLabel(scope.kind)');
  });
});
