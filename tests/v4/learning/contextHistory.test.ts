import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { recordLearningSelection } from '../../../core/v4/learning/learningContext';
import type { LearningRetrievalResult } from '../../../core/v4/learning/types';

it('retains context references after reopen without duplicating content or accepting a stale generation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiden-context-history-'));
  const file = path.join(root, 'state.sqlite');
  let db = new Database(file);
  try {
    runMigrations(db);
    db.prepare("INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES ('context',1,'test',1,1,'test')").run();
    const engine = createJobEngine({ db });
    const job = engine.submitJob({ entryPoint: 'test', source: 'test', sessionId: 'context-session', instanceId: 'context',
      idempotencyNamespace: 'context', idempotencyKey: 'first', requestFingerprint: 'first', goal: 'Summarize project' });
    const lease = engine.claimAttempt({ attemptId: job.attemptId, ownerId: 'test', ttlMs: 60000 });
    const result = { context: 'Private learned preference', items: [{ id: 'entry-example', version: 2 }] } as LearningRetrievalResult;
    const execute = (generation = lease.generation!) => runWithJobExecutionContext({ engine, jobId: job.jobId, attemptId: job.attemptId,
      generation, fenceToken: lease.fenceToken!, producer: 'test' }, () => recordLearningSelection(result));
    execute(); execute();
    expect(() => execute(lease.generation! + 10)).toThrow(/stale execution/);
    db.close(); db = new Database(file);
    const events = createJobEngine({ db }).listEvents(job.jobId).filter(event => event.type === 'learning.context_selected');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ entries: [{ entryId: 'entry-example', version: 2 }] });
    expect(JSON.stringify(events)).not.toContain('Private learned preference');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
