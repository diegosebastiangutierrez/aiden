/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Workbench Phase 3 — the sidebar's session labels.
 *
 * Proves createSessionLister produces READABLE labels (never raw ids): the
 * distilled title when present, else a snippet of the first user message, else a
 * neutral fallback — and that the row id aligns with the session for the feed.
 */
import { describe, it, expect } from 'vitest';
import { SessionStore } from '../../../core/v4/sessionStore';
import { createSessionLister } from '../../../core/v4/workbench/sessionList';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';

function rowFor(store: SessionStore, id: string) {
  return createSessionLister(store).listSessions().find((x) => x.id === id)!;
}

describe('createSessionLister — readable labels, never raw ids', () => {
  it('uses the distilled title when present', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({ title: 'Refactor the auth flow' });
    const row = rowFor(s, rec.id);
    expect(row.label).toBe('Refactor the auth flow');
    expect(row.label).not.toBe(rec.id);
  });

  it('falls back to the first user-message snippet when untitled (whitespace-collapsed)', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    s.appendMessage(rec.id, { role: 'user', content: '  hey, can you   fix the flaky test in parser.ts?  \n more' });
    const row = rowFor(s, rec.id);
    expect(row.label).toBe('hey, can you fix the flaky test in parser.ts? more');
    expect(row.label).not.toMatch(/^[0-9a-f-]{36}$/);   // not a raw UUID
  });

  it('truncates a long snippet with an ellipsis', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    s.appendMessage(rec.id, { role: 'user', content: 'x'.repeat(200) });
    const row = rowFor(s, rec.id);
    expect(row.label.length).toBeLessThanOrEqual(73);
    expect(row.label.endsWith('…')).toBe(true);
  });

  it('falls back to a timestamp label when untitled and no user message', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    const label = rowFor(s, rec.id).label;
    expect(label).toMatch(/^Session · \d{4}-\d\d-\d\d \d\d:\d\d$/);   // readable time, not "(untitled)"
    expect(label).not.toBe(rec.id);
  });

  it('strips bracketed-paste artifacts from a pasted first message', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    s.appendMessage(rec.id, { role: 'user', content: '\x1b[200~paste me\x1b[201~ then more' });
    expect(rowFor(s, rec.id).label).toBe('paste me then more');
  });

  it('strips ESC-stripped leftovers ([200~ / [201~) from a title too', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({ title: '[200~fix the parser[201~' });
    expect(rowFor(s, rec.id).label).toBe('fix the parser');
  });

  it('carries lastActive and keeps the id aligned for /api/sessions/:id/events', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({ title: 't' });
    const row = rowFor(s, rec.id);
    expect(row.id).toBe(rec.id);
    expect(typeof row.lastActive).toBe('number');
  });

  it('projects the exact latest durable run identity for completed-history reopening', () => {
    const sessions = new SessionStore(':memory:');
    const session = sessions.createSession({ title: 'Verified artifact run' });
    const db = new Database(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(`INSERT INTO daemon_instances
      (instance_id,pid,hostname,started_at,last_heartbeat,version)
      VALUES ('session-list-test',1,'localhost',?,?,'4.21.0')`).run(now, now);
    const engine = createJobEngine({ db });
    const admitted = engine.submitJob({
      entryPoint: 'workbench', source: 'test', sessionId: session.id,
      instanceId: 'session-list-test', idempotencyNamespace: 'session-list',
      idempotencyKey: 'completed-run', requestFingerprint: 'completed-run',
      goal: 'Create and verify summary.md',
    });
    const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'test', ttlMs: 30_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('claim failed');
    engine.transitionAttempt({
      attemptId: admitted.attemptId, expectedStateVersion: 1, generation: lease.generation,
      fenceToken: lease.fenceToken, to: 'running', eventIdempotencyKey: 'attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, expectedStateVersion: 0, to: 'running',
      eventIdempotencyKey: 'job-running', producer: 'test',
    });
    engine.transitionAttempt({
      attemptId: admitted.attemptId, expectedStateVersion: 2, generation: lease.generation,
      fenceToken: lease.fenceToken, to: 'succeeded', eventIdempotencyKey: 'attempt-succeeded', producer: 'test',
    });
    engine.finalizeJob({
      jobId: admitted.jobId, attemptId: admitted.attemptId, generation: lease.generation,
      fenceToken: lease.fenceToken, expectedStateVersion: 1, status: 'completed', outcome: 'verified',
      finishReason: 'stop', evidence: { artifact: 'summary.md' }, eventIdempotencyKey: 'job-completed', producer: 'test',
    });

    const row = createSessionLister(sessions, 40, engine).listSessions()[0];
    expect(row).toMatchObject({
      id: session.id,
      jobId: admitted.jobId,
      attemptId: admitted.attemptId,
      runId: admitted.runId,
      status: 'completed',
    });
    sessions.close();
    db.close();
  });
});
