import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { runWithJobExecutionContext, type JobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
const observe = vi.hoisted(() => vi.fn());
vi.mock('../../../core/playwrightBridge', () => ({ pwObserveBrowserCheck: observe }));
vi.mock('../../../tools/v4/browser/_observer', () => ({ withBrowserState: (tool: unknown) => tool }));
import { browserCheckObserveTool } from '../../../tools/v4/browser/browserCheckObserve';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../../core/v4/paths';

let db: Database.Database;
let engine: JobEngine;
let context: JobExecutionContext;
const specDigest = 'a'.repeat(64);
beforeEach(() => {
  db = new Database(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)')
    .run('check-test', 1, 'localhost', Date.now(), Date.now(), '1.0.0');
  engine = createJobEngine({ db });
  const job = engine.submitJob({ entryPoint: 'test', source: 'test', sessionId: 'sample', instanceId: 'check-test',
    idempotencyNamespace: 'check', idempotencyKey: 'one', requestFingerprint: 'one', goal: 'Observe approved result' });
  const lease = engine.claimAttempt({ attemptId: job.attemptId, ownerId: 'test-owner', ttlMs: 30_000 });
  context = { engine, jobId: job.jobId, attemptId: job.attemptId, generation: lease.generation!,
    fenceToken: lease.fenceToken!, producer: 'test' };
  engine.appendJobEvent({ ...context, type: 'browser.check.bound', producer: 'workbench', idempotencyKey: 'binding',
    payload: { version: 1, customerId: 'sample', specDigest, origin: 'http://127.0.0.1:8213', allowLoopback: true,
      mutationPaths: [], observations: [{ id: 'heading', flowId: 'landing', selector: '#result', kind: 'text', expected: 'Welcome' }] } });
  engine.proof.createClaim({ ...context, category: 'contract', statement: `browser-check:${specDigest}:heading`,
    required: true, requiredEvidenceCategories: ['browser.check'] });
  observe.mockReset(); observe.mockResolvedValue({ value: 'Welcome', observedAt: Date.now(), url: 'http://127.0.0.1:8213/' });
});
afterEach(() => { db.close(); });
const execute = (args = { observation_id: 'heading' }) => runWithJobExecutionContext(context,
  () => browserCheckObserveTool.execute(args, {} as never));

describe('canonical browser check observations', () => {
  it('blocks registered execution and file tools before dispatch in a browser-only Job', async () => {
    for (const name of ['shell_exec', 'file_write', 'browser_real_eval', 'tool_call', 'app_input']) {
      const handler = vi.fn(async () => ({ success: true }));
      const registry = new ToolRegistry();
      registry.register({ schema: { name, description: 'Forbidden candidate', inputSchema: { type: 'object' } },
        category: 'execute', toolset: 'test', mutates: true, execute: handler });
      const run = registry.buildExecutor({ cwd: process.cwd(), paths: resolveAidenPaths() });
      const result = await runWithJobExecutionContext(context, () => run({ id: `denied-${name}`, name, arguments: {} }));
      expect(result.error).toContain('outside the approved browser check contract');
      expect(handler).not.toHaveBeenCalled();
    }
  });
  it('records actual observation and verifies the exact required claim', async () => {
    expect(await execute()).toMatchObject({ success: true, check_passed: true, observed: 'Welcome' });
    expect(engine.proof.listEvidence(context.jobId)).toEqual([expect.objectContaining({
      source: 'browser.check', coverage: 'full', verificationResult: 'verified', late: false,
      payload: expect.objectContaining({ specDigest, observationId: 'heading', observed: 'Welcome' }) })]);
    expect(engine.proof.listClaims(context.jobId)[0].state).toBe('verified');
  });
  it('records an observed mismatch as failed Verification, not false success', async () => {
    observe.mockResolvedValue({ value: 'Sign in', observedAt: Date.now(), url: 'http://127.0.0.1:8213/' });
    expect(await execute()).toMatchObject({ success: true, check_passed: false });
    expect(engine.proof.listClaims(context.jobId)[0].state).toBe('failed');
    expect(engine.proof.finalize(context).verdict).toBe('failed');
  });
  it('does not collect an unapproved observation or trust a supplied claimed value', async () => {
    expect(await execute({ observation_id: 'other' })).toMatchObject({ success: false });
    expect(observe).not.toHaveBeenCalled();
    expect(engine.proof.listClaims(context.jobId)[0].state).toBe('unverified');
  });
  it('cannot turn missing observation or stale fence into verified evidence', async () => {
    observe.mockRejectedValueOnce(new Error('missing element'));
    await expect(execute()).rejects.toThrow('missing element');
    context.fenceToken = 'stale';
    await expect(execute()).rejects.toThrow();
    expect(engine.proof.listEvidence(context.jobId)).toHaveLength(0);
  });
  it('rejects a result after cancellation without creating evidence', async () => {
    const abort = new AbortController(); context.signal = abort.signal;
    observe.mockImplementation(async () => { abort.abort(); return { value: 'Welcome', observedAt: Date.now(), url: '' }; });
    await expect(execute()).rejects.toThrow('cancelled');
    expect(engine.proof.listEvidence(context.jobId)).toHaveLength(0);
  });
  it('keeps a terminal verdict immutable when an observation arrives late', async () => {
    expect(engine.proof.finalize(context).verdict).toBe('unknown');
    expect(await execute()).toMatchObject({ success: false, error: expect.stringContaining('Late') });
    expect(engine.proof.getVerdict(context.jobId)?.verdict).toBe('unknown');
    expect(engine.proof.listClaims(context.jobId)[0].state).toBe('unverified');
  });
  it('does not persist URL query or fragment credentials in canonical observation Evidence', async () => {
    observe.mockResolvedValue({ value: 'Welcome', observedAt: Date.now(), url: 'http://127.0.0.1:8213/result?access_token=fixture-private-value#session-data' });
    await execute();
    const payload = engine.proof.listEvidence(context.jobId)[0].payload;
    expect(payload.url).toBe('http://127.0.0.1:8213/result');
    expect(JSON.stringify(payload)).not.toContain('fixture-private-value');
    expect(JSON.stringify(payload)).not.toContain('session-data');
  });
  it('rejects sensitive observed text even when a lower observation layer returns it', async () => {
    observe.mockResolvedValue({ value: 'password=fixture-private-value', observedAt: Date.now(), url: 'http://127.0.0.1:8213/' });
    await expect(execute()).rejects.toThrow(/sensitive/);
    expect(engine.proof.listEvidence(context.jobId)).toHaveLength(0);
  });
  it('records canonical observations without creating files or admitting an external mutation', async () => {
    const image = Buffer.from('owned-redacted-capture');
    observe.mockResolvedValue({ value: 'Welcome', observedAt: Date.now(), url: 'http://127.0.0.1:8213/', image });
    const result = await execute();
    expect(browserCheckObserveTool.mutates).toBe(false);
    expect(result.path).toBeUndefined();
    expect(engine.proof.listEvidence(context.jobId)[0].payload.capture).toBeUndefined();
  });
});
