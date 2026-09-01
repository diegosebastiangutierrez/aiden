/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import {
  pwCloseTab,
  pwListTabs,
  pwOpenTab,
  pwRehydrateCurrentDurableSession,
  pwSwitchControl,
} from '../../../core/playwrightBridge';
import { currentBrowserExecutionScope } from '../../../core/v4/browser/browserExecutionScope';
import { withBrowserState } from './_observer';

function visibleName(tab: {
  purpose?: string | null;
  title?: string | null;
  url?: string | null;
  tabId?: string;
}): string {
  if (tab.purpose?.trim()) return tab.purpose.trim();
  if (tab.title?.trim()) return tab.title.trim();
  if (tab.url) {
    try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url; }
  }
  return tab.tabId ?? 'Untitled tab';
}

async function projectedTabs() {
  const listed = await pwListTabs();
  if (!listed.ok) return { success: false as const, error: listed.error ?? 'Could not list browser tabs', tabs: [] };
  const scope = currentBrowserExecutionScope();
  const durableSession = scope?.authority.getSession(scope.session.browserSessionId) ?? null;
  const durableById = new Map(
    (scope?.authority.listTabs(scope.session.browserSessionId) ?? []).map((tab) => [tab.tabId, tab]),
  );
  return {
    success: true as const,
    browser_session_id: durableSession?.browserSessionId ?? null,
    job_id: durableSession?.jobId ?? null,
    attempt_id: durableSession?.attemptId ?? null,
    generation: durableSession?.generation ?? null,
    session_state: durableSession?.state ?? null,
    tabs: listed.tabs.map((tab) => {
      const durable = durableById.get(tab.tab_id);
      return {
        tab_id: tab.tab_id,
        name: visibleName({
          purpose: durable?.purpose,
          title: tab.title || durable?.title,
          url: tab.url || durable?.url,
          tabId: tab.tab_id,
        }),
        title: tab.title || durable?.title || '',
        url: tab.url || durable?.url || '',
        controlled: tab.controlled,
        created_by: tab.createdBy,
        closeable: tab.createdBy === 'aiden',
      };
    }),
  };
}

const _browserTabsTool: ToolHandler = {
  schema: {
    name: 'browser_tabs',
    description:
      'List the tabs in the current durable browser session. Returns stable tab IDs, useful names, URLs, titles, ownership, and which tab is active.',
    inputSchema: { type: 'object', properties: {} },
  },
  category: 'browser',
  mutates: false,
  toolset: 'browser',
  riskTier: 'safe',
  async execute() {
    return projectedTabs();
  },
};

const _browserTabTool: ToolHandler = {
  schema: {
    name: 'browser_tab',
    description:
      'Manage tabs owned by the current durable browser session. Open a named tab, reconnect the named tabs from an exact completed session ID, switch to an exact tab ID, rename a tab for the task, or close an Aiden-owned tab. Call browser_tabs first when an exact tab ID is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'reconnect', 'switch', 'rename', 'close'] },
        tab_id: { type: 'string', description: 'Exact tab ID returned by browser_tabs. Required for switch, rename, and close.' },
        session_id: { type: 'string', description: 'Exact completed browser session ID. Required for reconnect.' },
        url: { type: 'string', description: 'URL to load in a newly opened tab.' },
        name: { type: 'string', description: 'Short useful task name such as Research, Source 1, or Example Domain.' },
      },
      required: ['action'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'caution',
  buildPreview(args) {
    const action = String(args.action ?? '');
    const tabId = String(args.tab_id ?? '').trim();
    const sessionId = String(args.session_id ?? '').trim();
    const url = String(args.url ?? '').trim();
    const name = String(args.name ?? '').trim();
    return {
      tool: 'browser_tab',
      args,
      riskTier: 'caution',
      sideEffects: [{
        type: 'browser_action',
        action: `tab_${action || 'manage'}`,
        ...(url ? { url } : {}),
        ...(tabId ? { target: tabId } : {}),
      }],
      detectedRisks: [],
      summary: action === 'open'
        ? `Would open browser tab${name ? ` “${name}”` : ''}${url ? ` at ${url}` : ''}`
        : action === 'reconnect'
          ? `Would reconnect named tabs from browser session ${sessionId || '(not selected)'}`
        : `Would ${action || 'manage'} browser tab ${tabId || '(not selected)'}`,
    };
  },
  async execute(args) {
    const action = String(args.action ?? '').trim();
    const tabId = String(args.tab_id ?? '').trim();
    const sessionId = String(args.session_id ?? '').trim();
    const url = String(args.url ?? '').trim();
    const name = String(args.name ?? '').trim();

    if (action === 'open') {
      if (!url) return { success: false, error: 'A URL is required to open a browser tab' };
      if (!name) return { success: false, error: 'A useful tab name is required' };
      const opened = await pwOpenTab(url, name);
      if (!opened.ok || !opened.tab_id) return { success: false, error: opened.error ?? 'Could not open browser tab' };
      const switched = await pwSwitchControl(opened.tab_id);
      if (!switched.ok) return { success: false, error: switched.error ?? 'Could not activate the opened tab' };
      return { ...(await projectedTabs()), tab_id: opened.tab_id, name, verified: true };
    }

    if (action === 'reconnect') {
      if (!sessionId) return { success: false, error: 'An exact session_id is required for reconnect' };
      const scope = currentBrowserExecutionScope();
      if (!scope) return { success: false, error: 'Durable browser session is required to reconnect tabs' };
      const continuation = scope.authority.continueSession(scope.binding, sessionId);
      const restored = await pwRehydrateCurrentDurableSession();
      if (!restored.ok) {
        return { success: false, error: restored.error ?? 'Could not restore durable browser tabs' };
      }
      return {
        ...(await projectedTabs()),
        continued_from_session_id: continuation.sourceBrowserSessionId,
        controlled_tab_id: continuation.controlledTabId,
        verified: true,
      };
    }

    if (!tabId) return { success: false, error: `An exact tab_id is required for ${action || 'this action'}` };
    if (action === 'switch') {
      const switched = await pwSwitchControl(tabId);
      return switched.ok
        ? { ...(await projectedTabs()), tab_id: tabId, verified: true }
        : { success: false, error: switched.error ?? 'Could not switch browser tab' };
    }
    if (action === 'rename') {
      if (!name) return { success: false, error: 'A useful tab name is required' };
      const scope = currentBrowserExecutionScope();
      if (!scope) return { success: false, error: 'Durable browser session is required to name a tab' };
      scope.authority.setTabPurpose(scope.binding, tabId, name);
      return { ...(await projectedTabs()), tab_id: tabId, name, verified: true };
    }
    if (action === 'close') {
      const closed = await pwCloseTab(tabId);
      return closed.ok
        ? { ...(await projectedTabs()), tab_id: tabId, verified: true }
        : { success: false, error: closed.error ?? 'Could not close browser tab' };
    }
    return { success: false, error: 'action must be open, reconnect, switch, rename, or close' };
  },
};

export const browserTabsTool = withBrowserState(_browserTabsTool);
export const browserTabTool = withBrowserState(_browserTabTool);
