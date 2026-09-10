/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/browser/tabRegistry.ts — v4.12 B4.1 (first-class tab registry).
 *
 * Promotes the data-only `pwSnapshotTabs` into a LIVE registry fed by the
 * bridge's `context.on('page')` / `page.on('close')` events. Each tracked Page
 * carries metadata + a `createdBy` classification that drives the multi-tab
 * SAFETY policy:
 *
 *   - Aiden-created  = Aiden's own newPage tabs + any popup whose opener chain
 *                      roots at an Aiden tab (OAuth/payment/login popups).
 *                      → fully controllable AND closeable.
 *   - User-created   = present-at-attach OR user-opened (no Aiden-rooted opener).
 *                      → listable but NEVER closeable; controlling one needs an
 *                        explicit, user-initiated designation (tier 2).
 *
 * This module is pure state — the bridge owns the Playwright Pages and feeds
 * events in. It never imports Playwright or the bridge (no cycle).
 */

import { randomUUID } from 'node:crypto';

export interface TabMeta {
  tab_id: string;
  url: string;
  title: string;
  origin: string;
  opener_id: string | null;
  createdBy: 'aiden' | 'user';
  controlled: boolean;
  lastSnapshotHash: string | null;
  dirtyForm: boolean;
  browserSessionId: string | null;
}

class TabRegistry {
  private byPage = new Map<unknown, TabMeta>();

  /**
   * Track (or override) a page. Idempotent: a second call with createdBy
   * 'aiden' upgrades an event-classified entry — this is how the bridge's
   * explicit Aiden-newPage registration wins regardless of event ordering.
   */
  track(
    page: unknown,
    createdBy: 'aiden' | 'user',
    openerId: string | null,
    browserSessionId: string | null = null,
  ): TabMeta {
    let meta = this.byPage.get(page);
    if (!meta) {
      meta = {
        // Physical identities must not collide with durable rows from a prior host.
        // Only explicit trackDurable reconciliation may restore an existing ID.
        tab_id: `tab-${randomUUID()}`,
        url: '', title: '', origin: '',
        opener_id: openerId,
        createdBy,
        controlled: false,
        lastSnapshotHash: null,
        dirtyForm: false,
        browserSessionId,
      };
      this.byPage.set(page, meta);
    } else {
      if (createdBy === 'aiden') meta.createdBy = 'aiden'; // upgrade only
      if (openerId !== null) meta.opener_id = openerId;
      if (browserSessionId !== null) {
        if (meta.browserSessionId !== null && meta.browserSessionId !== browserSessionId) {
          throw new Error('Browser tab is already assigned to another durable session');
        }
        meta.browserSessionId = browserSessionId;
      }
    }
    return meta;
  }

  /**
   * Rebind a newly-created physical Page to an existing durable tab identity.
   * Used only when a browser host reconnects the same authoritative session;
   * it never invents or aliases a durable tab ID.
   */
  trackDurable(
    page: unknown,
    durable: {
      tabId: string;
      createdBy: 'aiden' | 'user';
      openerId: string | null;
      browserSessionId: string;
      controlled: boolean;
      url: string;
      title: string;
      dirtyForm: boolean;
      lastSnapshotHash: string | null;
    },
  ): TabMeta {
    const tabId = durable.tabId.trim();
    if (!tabId) throw new Error('Durable browser tab ID is required');

    for (const [otherPage, other] of this.byPage) {
      if (otherPage === page || other.tab_id !== tabId) continue;
      if (other.browserSessionId !== null) {
        throw new Error('Durable browser tab ID is already bound to another physical page');
      }
      this.byPage.delete(otherPage);
    }

    const current = this.byPage.get(page);
    if (current?.browserSessionId !== null
      && current?.browserSessionId !== durable.browserSessionId) {
      throw new Error('Browser tab is already assigned to another durable session');
    }

    let origin = '';
    try { origin = durable.url ? new URL(durable.url).origin : ''; } catch { /* invalid URL stays originless */ }
    const meta: TabMeta = {
      tab_id: tabId,
      url: durable.url,
      title: durable.title,
      origin,
      opener_id: durable.openerId,
      createdBy: durable.createdBy,
      controlled: durable.controlled,
      lastSnapshotHash: durable.lastSnapshotHash,
      dirtyForm: durable.dirtyForm,
      browserSessionId: durable.browserSessionId,
    };
    this.byPage.set(page, meta);
    return meta;
  }

  get(page: unknown): TabMeta | undefined { return this.byPage.get(page); }
  has(page: unknown): boolean { return this.byPage.has(page); }
  remove(page: unknown): void { this.byPage.delete(page); }
  clear(): void { this.byPage.clear(); }

  pageById(tabId: string): unknown | undefined {
    for (const [pg, m] of this.byPage) if (m.tab_id === tabId) return pg;
    return undefined;
  }
  idOf(page: unknown): string | null { return this.byPage.get(page)?.tab_id ?? null; }

  /** Mark exactly one page as the controlled tab (the rest cleared). */
  markControlled(page: unknown, browserSessionId: string | null = null): void {
    for (const [pg, m] of this.byPage) {
      if (browserSessionId === null || m.browserSessionId === browserSessionId) m.controlled = pg === page;
    }
  }

  isAidenCreated(page: unknown): boolean { return this.byPage.get(page)?.createdBy === 'aiden'; }

  /** Aiden-created tabs are closeable; user tabs NEVER are (even when controlled). */
  canClose(page: unknown): boolean { return this.isAidenCreated(page); }

  entries(): Array<[unknown, TabMeta]> { return [...this.byPage.entries()]; }
  list(browserSessionId?: string): TabMeta[] {
    const tabs = [...this.byPage.values()];
    return browserSessionId === undefined ? tabs : tabs.filter((tab) => tab.browserSessionId === browserSessionId);
  }
}

let _registry: TabRegistry | null = null;
export function getTabRegistry(): TabRegistry {
  if (!_registry) _registry = new TabRegistry();
  return _registry;
}
