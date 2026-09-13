/** Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0. */
import { createHash, randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config';
import type { McpClient, McpServerConfig } from '../mcpClient';
import type { WorkbenchMcpAuthorization, McpAuthorizationSnapshot } from './mcpAuthorization';

export type McpManagementAction = 'reconnect' | 'remove' | 'review' | 'add' | 'authorize';
export interface McpManagementPreview {
  confirmationId: string;
  name: string;
  action: McpManagementAction;
  description: string;
  expiresAt: number;
  tools: Array<{ name: string; effect: string }>;
  configuration?: Omit<McpServerConfig, 'name'>;
}
export interface McpManagementSnapshot {
  available: boolean;
  authorization?: McpAuthorizationSnapshot | null;
  servers: Array<{ name: string; status: string; reviewRequired: boolean; actions: McpManagementAction[] }>;
}
export interface WorkbenchMcpManagement {
  snapshot(): McpManagementSnapshot;
  preview(name: string, action: McpManagementAction): McpManagementPreview;
  previewAdd(name: string, configuration: unknown): McpManagementPreview;
  confirm(confirmationId: string): Promise<McpManagementSnapshot>;
  cancelAuthorization?(id: string): Promise<void>;
  close?(): Promise<void>;
}

/** Web setup deliberately accepts no inline credentials, environment inheritance
 * overrides, or local-network bypass. Advanced existing configuration is preserved. */
function setupConfiguration(value: unknown): Omit<McpServerConfig, 'name'> {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP configuration must be an object');
    return input as Record<string, unknown>;
  };
  const only = (input: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(input).some(key => !keys.includes(key))) throw new Error('Unsupported MCP setup field. Credentials and policy overrides are not accepted.');
  };
  const text = (input: unknown): string => {
    if (typeof input !== 'string' || !input.trim() || input.length > 2048 || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid MCP setup value');
    if (/\$\{[^}]*\}/.test(input)) throw new Error('Use explicit non-secret setup values, not environment references');
    if (/(?:api[_-]?key|token|secret|password|authorization|credential)\s*[=:]|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/i.test(input)) throw new Error('Do not place credentials in MCP setup arguments');
    return input;
  };
  const source = object(value);
  if (source.type === 'stdio') {
    only(source, ['type', 'stdio']); const stdio = object(source.stdio); only(stdio, ['command', 'args']);
    if (!Array.isArray(stdio.args) || stdio.args.length > 32) throw new Error('MCP arguments must be an array with at most 32 entries');
    const args = stdio.args.map(text);
    if (args.some(arg => /^--?(?:api[_-]?key|token|secret|password|authorization|credential)$/i.test(arg))) throw new Error('Credentials must not be passed as MCP arguments');
    return { type: 'stdio', stdio: { command: text(stdio.command), args } };
  }
  if (source.type === 'http') {
    only(source, ['type', 'http']); const http = object(source.http); only(http, ['baseUrl', 'transport']);
    const url = new URL(text(http.baseUrl));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTPS MCP endpoint without credentials, query or fragment');
    if (http.transport !== undefined && http.transport !== 'streamable' && http.transport !== 'sse') throw new Error('Unsupported MCP transport');
    return { type: 'http', http: { baseUrl: url.toString(), transport: http.transport === 'sse' ? 'sse' : 'streamable' } };
  }
  throw new Error('Choose a local process or remote HTTPS MCP server');
}

/** A local presentation adapter over existing configuration and MCP authority.
 * Confirmations are short-lived, single-use, and invalid after runtime restart.
 * They never authorize a tool call, trust transition, or OAuth consent.
 */
export function createWorkbenchMcpManagement(input: {
  config: Pick<ConfigManager, 'getValue' | 'snapshot' | 'set' | 'save'>;
  client: Pick<McpClient, 'list' | 'get' | 'connect' | 'disconnect' | 'approveCapabilities'>;
  enabled(): boolean;
  isIdle?(): boolean;
  now?: () => number;
  authorization?: WorkbenchMcpAuthorization;
}): WorkbenchMcpManagement {
  const now = input.now ?? Date.now;
  const pending = new Map<string, { preview: McpManagementPreview; fingerprint: string }>();
  let busy = false;
  const configured = () => input.config.getValue<Record<string, Omit<McpServerConfig, 'name'>>>('mcp.servers') ?? {};
  const rawConfigured = () => (input.config.snapshot().mcp as { servers?: Record<string, Omit<McpServerConfig, 'name'>> } | undefined)?.servers ?? {};
  const fingerprint = (name: string) => {
    const server = input.client.get(name);
    return createHash('sha256').update(JSON.stringify({
      configured: configured()[name], raw: rawConfigured()[name], liveConfig: server?.config,
      identity: server?.externalIdentityId, snapshot: server?.capabilitySnapshotId,
      trust: server?.externalTrustState, status: server?.status,
      tools: server?.tools, review: server?.capabilityReviewRequired,
    })).digest('hex');
  };
  const requireAvailable = () => {
    if (!input.enabled()) throw new Error('MCP management is unavailable in this runtime');
    if (busy || input.authorization?.isBusy()) throw new Error('An MCP connection change is already in progress');
    if (input.isIdle && !input.isIdle()) throw new Error('Wait for active work to finish before changing MCP connections');
  };
  const exists = (name: string) => Object.prototype.hasOwnProperty.call(configured(), name) || Boolean(input.client.get(name));
  const port: WorkbenchMcpManagement = {
    snapshot() {
      const names = new Set([...Object.keys(configured()), ...input.client.list().map(server => server.config.name)]);
      return { available: input.enabled(), authorization: input.authorization?.snapshot(), servers: [...names].sort().map(name => {
        const live = input.client.get(name);
        const actions: McpManagementAction[] = input.enabled() ? ['remove'] : [];
        if (input.enabled() && live?.status !== 'needs-auth') actions.unshift('reconnect');
        if (input.enabled() && live?.status === 'ready' && live.capabilityReviewRequired) actions.push('review');
        if (input.enabled() && input.authorization && configured()[name]?.type === 'http') actions.push('authorize');
        return { name, status: live?.status ?? 'disconnected', reviewRequired: live?.capabilityReviewRequired === true, actions };
      }) };
    },
    previewAdd(name, configuration) {
      requireAvailable();
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid MCP server name');
      if (exists(name)) throw new Error('MCP server already exists; existing connections cannot be overwritten');
      const entry = setupConfiguration(configuration);
      for (const [id, request] of pending) if (request.preview.expiresAt <= now()) pending.delete(id);
      if (pending.size >= 32) throw new Error('Too many pending connection reviews; wait for them to expire');
      const preview: McpManagementPreview = { confirmationId: randomUUID(), name, action: 'add', expiresAt: now() + 120_000, tools: [], configuration: entry,
        description: entry.type === 'stdio' ? 'Run this exact program and arguments now and on future starts, with your user permissions. Only add servers you trust. Do not include credentials. Tool trust and execution approvals remain separate.' : 'Save and connect to this HTTPS server now and on future starts. Network policy remains enforced. Provider authorization and tool permissions remain separate.' };
      pending.set(preview.confirmationId, { preview: structuredClone(preview), fingerprint: fingerprint(name) });
      return preview;
    },
    preview(name, action) {
      requireAvailable();
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(name) || !exists(name)) throw new Error('Configured MCP server not found');
      if (!['reconnect', 'remove', 'review', 'authorize'].includes(action)) throw new Error('Invalid MCP management action');
      if (action === 'authorize' && (!input.authorization || configured()[name]?.type !== 'http')) throw new Error('Web authorization is unavailable for this server');
      const server = input.client.get(name);
      if (action === 'reconnect' && server?.status === 'needs-auth') throw new Error('Authorize this server before reconnecting. Use the supported MCP authorization flow.');
      if (action === 'review' && (server?.status !== 'ready' || !server.capabilityReviewRequired)) throw new Error('No current connected capability review is available');
      for (const [id, entry] of pending) if (entry.preview.expiresAt <= now()) pending.delete(id);
      if (pending.size >= 32) throw new Error('Too many pending connection reviews; wait for them to expire');
      const preview: McpManagementPreview = {
        confirmationId: randomUUID(), name, action, expiresAt: now() + 120_000,
        description: action === 'authorize'
          ? `Authorize the saved server ${new URL(configured()[name].http!.baseUrl).origin} through its provider. Review the requested permissions on the provider website. Tokens stay in protected storage. This does not grant tool execution permission.`
          : action === 'remove'
          ? 'Stop this connection and remove its startup configuration. Existing Jobs, Evidence and audit history remain. Provider authorization is not revoked.'
          : action === 'review'
            ? 'Accept the currently displayed tool capabilities. This does not grant server trust or approve any tool execution. Normal permission checks still apply.'
            : 'Stop and reconnect this server using its existing saved configuration. Local servers run with your user permissions. Active tool calls may be interrupted.',
        tools: action === 'review' ? server!.tools.map(tool => ({ name: tool.rawName, effect: tool.effect })) : [],
      };
      pending.set(preview.confirmationId, { preview, fingerprint: fingerprint(name) });
      return preview;
    },
    async confirm(confirmationId) {
      requireAvailable();
      const entry = pending.get(confirmationId);
      pending.delete(confirmationId);
      if (!entry || entry.preview.expiresAt <= now()) throw new Error('Connection confirmation expired or was already used');
      const { name, action } = entry.preview;
      if ((action === 'add' ? exists(name) : !exists(name)) || fingerprint(name) !== entry.fingerprint) throw new Error('Connection or capabilities changed. Review the current state again.');
      busy = true;
      try {
        if (action === 'add') {
          const configuration = setupConfiguration(entry.preview.configuration);
          const previous = rawConfigured();
          input.config.set('mcp.servers', { ...previous, [name]: configuration });
          try { await input.config.save(); }
          catch { input.config.set('mcp.servers', previous); throw new Error('MCP setup could not be saved. No process was started.'); }
          if (input.isIdle && !input.isIdle()) throw new Error('MCP configuration was saved, but work started during setup. Reconnect after active work finishes.');
          try { await input.client.connect({ ...configuration, name }); }
          catch { throw new Error('MCP configuration was saved, but connection did not complete. Review connection status before retrying.'); }
        } else if (action === 'authorize') input.authorization!.start(name);
        else if (action === 'review') input.client.approveCapabilities(name, 'workbench-user');
        else if (action === 'remove') {
          const expected = JSON.stringify(rawConfigured()[name]);
          await input.client.disconnect(name);
          const previous = rawConfigured();
          if (JSON.stringify(previous[name]) !== expected) throw new Error('Connection changed while stopping. Review the current configuration again.');
          const next = { ...previous }; delete next[name];
          input.config.set('mcp.servers', next);
          try { await input.config.save(); }
          catch { input.config.set('mcp.servers', previous); throw new Error('Connection stopped, but its saved configuration could not be removed. Retry after checking storage.'); }
        } else {
          const saved = configured()[name] ?? input.client.get(name)?.config;
          if (!saved) throw new Error('Saved MCP configuration is unavailable');
          const config = structuredClone({ ...saved, name }) as McpServerConfig;
          const expected = JSON.stringify(configured()[name]);
          await input.client.disconnect(name);
          if (JSON.stringify(configured()[name]) !== expected) throw new Error('Connection changed while stopping. Review the current configuration again.');
          try { await input.client.connect(config); }
          catch { throw new Error('MCP reconnect did not complete. Saved configuration is retained; inspect connection status and authorization.'); }
        }
        return port.snapshot();
      } finally { busy = false; }
    },
  };
  if (input.authorization) {
    port.cancelAuthorization = id => input.authorization!.cancel(id);
    port.close = () => input.authorization!.close();
  }
  return port;
}
