import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAutomationReadinessAuthority } from '../../../core/v4/automation/readiness';
import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

describe('Reliable Automation runtime readiness', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('does not claim readiness when configuration is valid but no execution host is running', () => {
    const readiness = createAutomationReadinessAuthority({
      db,
      edition: buildEditionAuthority('pro'),
      schedulerReady: () => false,
    }).snapshot();

    expect(readiness).toMatchObject({
      ready: false,
      schedulerReady: false,
      detail: 'Automation execution host is unavailable.',
    });
  });

  it('becomes ready only while the canonical execution host is available', () => {
    let hostReady = false;
    const authority = createAutomationReadinessAuthority({
      db,
      edition: buildEditionAuthority('pro'),
      schedulerReady: () => hostReady,
    });

    expect(authority.snapshot().ready).toBe(false);
    hostReady = true;
    expect(authority.snapshot()).toMatchObject({ ready: true, schedulerReady: true });
  });
});
