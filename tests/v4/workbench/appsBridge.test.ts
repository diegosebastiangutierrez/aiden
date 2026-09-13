/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
import type { WorkbenchAppsPort } from '../../../core/v4/workbench/appsPort';

const TOKEN = 'workbench-apps-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;

afterEach(async () => {
  await bridge?.close();
  bridge = null;
});

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('Workbench Apps bridge', () => {
  it('gates recovery controls, rejects injected scope and distinguishes pending from connected', async () => {
    const pendingError = Object.assign(new Error('Waiting for provider authorization'), { category: 'authorization_pending' });
    const apps: WorkbenchAppsPort = { snapshot: vi.fn(), configureProvider: vi.fn(), connect: vi.fn(),
      complete: vi.fn(async () => { throw pendingError; }), refresh: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(),
      pending: () => [{ connectionId: 'request', providerId: 'fake', toolkitId: 'projects', label: null, expiresAt: null, createdAt: 1 }],
      resume: vi.fn(async () => ({ connectionId: 'request', providerId: 'fake', toolkitId: 'projects', authorizationUrl: 'https://example.invalid/authorize' })),
      cancel: vi.fn(async () => {}),
    };
    bridge = await startWorkbenchBridge({ reader, apps, token: TOKEN, port: 0 });
    for (const suffix of ['pending', 'request/resume', 'request/cancel', 'request/check']) {
      const path = `/api/apps/connections/${suffix}`;
      expect((await request(path, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await request(path, { method: 'POST', headers: { 'x-workbench-token': TOKEN, origin: 'https://foreign.invalid' }, body: '{}' })).status).toBe(403);
    }
    const headers = { 'x-workbench-token': TOKEN, 'Content-Type': 'application/json' };
    expect((await request('/api/apps/connections/request/resume', { method: 'POST', headers, body: JSON.stringify({ workspaceId: 'other' }) })).status).toBe(400);
    expect((await request('/api/apps/connections/request/check', { method: 'POST', headers, body: '{}' })).body).toEqual({ state: 'pending' });
    expect((await request('/api/apps/connections/request/cancel', { method: 'POST', headers, body: '{}' })).body).toEqual({ state: 'cancelled' });
    expect(apps.cancel).toHaveBeenCalledWith('request');
  });
  it('keeps account metadata token-gated and exposes no credential fields', async () => {
    const apps: WorkbenchAppsPort = {
      snapshot: vi.fn(async () => ({
        providers: [{ id: 'fake', label: 'Fake', health: 'healthy' }],
        toolkits: [{ providerId: 'fake', toolkitId: 'projects', label: 'Projects' }],
        accounts: [{
          accountId: 'account-1', providerId: 'fake', toolkitId: 'projects', label: 'Personal',
          status: 'active', health: 'healthy', scopes: ['read'], lastCheckedAt: 1,
        }],
        configuration: { command: 'aiden apps configure composio' },
      })),
      connect: vi.fn(), complete: vi.fn(), refresh: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(),
    };
    bridge = await startWorkbenchBridge({ reader, apps, token: TOKEN, port: 0 });
    expect((await request('/api/apps')).status).toBe(401);
    const result = await request('/api/apps', { headers: { 'x-workbench-token': TOKEN } });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toMatch(/secretHandle|providerAccountRef|credential/i);
  });

  it('gates every account mutation and requires an explicit disconnect confirmation', async () => {
    const account = {
      accountId: 'account-1', providerId: 'fake', toolkitId: 'projects', label: 'Personal',
      status: 'active', health: 'healthy', scopes: [], lastCheckedAt: null,
    };
    const apps: WorkbenchAppsPort = {
      snapshot: vi.fn(),
      connect: vi.fn(async () => ({ connectionId: 'connection-1', authorizationUrl: 'https://example.invalid' })),
      complete: vi.fn(async () => account),
      refresh: vi.fn(async () => account),
      reconnect: vi.fn(async () => ({ connectionId: 'connection-2' })),
      disconnect: vi.fn(async () => ({ ...account, status: 'revoked', health: 'revoked' })),
    };
    bridge = await startWorkbenchBridge({ reader, apps, token: TOKEN, port: 0 });
    const denied = await request('/api/apps/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'fake', toolkitId: 'projects' }),
    });
    expect(denied.status).toBe(401);
    expect(apps.connect).not.toHaveBeenCalled();

    const connected = await request('/api/apps/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ providerId: 'fake', toolkitId: 'projects', label: 'Work' }),
    });
    expect(connected).toMatchObject({ status: 202, body: { connectionId: 'connection-1' } });
    expect(apps.connect).toHaveBeenCalledWith({ providerId: 'fake', toolkitId: 'projects', label: 'Work' });

    const unconfirmed = await request('/api/apps/accounts/account-1/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN }, body: '{}',
    });
    expect(unconfirmed.status).toBe(400);
    expect(apps.disconnect).not.toHaveBeenCalled();

    const disconnected = await request('/api/apps/accounts/account-1/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(disconnected.status).toBe(200);
    expect(apps.disconnect).toHaveBeenCalledWith('account-1');
  });
});
