import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { pwClose, pwCloseBrowserSessionResources } from '../../../core/playwrightBridge';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import type { ToolContext, ToolHandler } from '../../../core/v4/toolRegistry';
import { browserClickTool } from '../../../tools/v4/browser/browserClick';
import { browserControlTool } from '../../../tools/v4/browser/browserControl';
import { browserDownloadTool } from '../../../tools/v4/browser/browserDownload';
import { browserCloseTool } from '../../../tools/v4/browser/browserClose';
import { browserExtractTool } from '../../../tools/v4/browser/browserExtract';
import { browserFillTool } from '../../../tools/v4/browser/browserFill';
import { browserNavigateTool } from '../../../tools/v4/browser/browserNavigate';
import { browserScreenshotTool } from '../../../tools/v4/browser/browserScreenshot';
import { browserSnapshotTool } from '../../../tools/v4/browser/browserSnapshot';
import { browserUploadTool } from '../../../tools/v4/browser/browserUpload';
import { browserTabTool, browserTabsTool } from '../../../tools/v4/browser/browserTabs';

const physical = process.env.AIDEN_PHYSICAL_BROWSER === '1' ? describe : describe.skip;

physical('physical durable Browser Operator fixture', () => {
  let root = '';
  let baseUrl = '';
  let server: http.Server;
  let db: Database.Database;
  let engine: JobEngine;
  let jobContext: ReturnType<typeof admit>;
  const uploads: Array<{ name: string; sha256: string }> = [];
  const downloadBody = 'AIDEN_BROWSER_DOWNLOAD_SMOKE';

  function admit(key = 'fixture') {
    const admission = engine.submitJob({
      entryPoint: 'test', source: 'browser-physical', sessionId: 'browser-physical',
      workspaceId: root, instanceId: 'browser-physical', idempotencyNamespace: 'browser-physical',
      idempotencyKey: key, goal: 'exercise deterministic browser fixture',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'browser-physical', ttlMs: 120_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('browser fixture lease');
    return {
      engine, jobId: admission.jobId, attemptId: admission.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken,
      producer: 'browser-physical', workspacePath: root,
    };
  }

  function completeJob(context: ReturnType<typeof admit>, browserSessionId: string): void {
    const job = engine.getJob(context.jobId)!;
    expect(engine.transitionJob({
      jobId: context.jobId, attemptId: context.attemptId,
      generation: context.generation, fenceToken: context.fenceToken,
      expectedStateVersion: job.stateVersion, to: 'running',
      eventIdempotencyKey: `${context.jobId}-running`, producer: 'browser-physical',
    })).toMatchObject({ applied: true });
    const attempt = engine.getAttempt(context.attemptId)!;
    expect(engine.transitionAttempt({
      attemptId: context.attemptId, expectedStateVersion: attempt.stateVersion,
      generation: context.generation, fenceToken: context.fenceToken,
      to: 'succeeded', eventIdempotencyKey: `${context.attemptId}-succeeded`,
      producer: 'browser-physical', finishReason: 'stop',
    })).toMatchObject({ applied: true });
    const running = engine.getJob(context.jobId)!;
    expect(engine.finalizeJob({
      jobId: context.jobId, attemptId: context.attemptId,
      generation: context.generation, fenceToken: context.fenceToken,
      expectedStateVersion: running.stateVersion, status: 'completed', outcome: 'verified',
      finishReason: 'stop', evidence: { browserSessionId },
      eventIdempotencyKey: `${context.jobId}-completed`, producer: 'browser-physical',
    })).toMatchObject({ applied: true });
    engine.browser.settleSession(context, 'closed', 'durable lifecycle completed');
  }

  async function run(tool: ToolHandler, args: Record<string, unknown>) {
    return runWithJobExecutionContext(jobContext, () => tool.execute(args, { signal: undefined } as ToolContext)) as Promise<Record<string, any>>;
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-browser-physical-'));
    process.env.AIDEN_HOME = root;
    process.env.AIDEN_BROWSER_PROFILE_DIR = path.join(root, 'browser-profile');
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('browser-physical',1,'localhost',?,?, '4.19.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
    jobContext = admit();
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/download') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="browser-download-smoke.txt"',
        });
        response.end(downloadBody);
        return;
      }
      if (url.pathname === '/upload-record' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          uploads.push({
            name: String(request.headers['x-filename'] ?? ''),
            sha256: createHash('sha256').update(body).digest('hex'),
          });
          response.writeHead(204).end();
        });
        return;
      }
      if (url.pathname === '/product-b') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Product B</title><main><h1>Product B</h1><p id="price">Price: INR 42</p></main>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head><title>Browser Fixture</title></head><body>
        <main><h1>Deterministic Browser Fixture</h1>
          <a id="product-link" href="/product-b">Product B</a>
          <button id="spa" onclick="document.querySelector('#spa-state').textContent='Profile draft active'">Open Profile</button>
          <p id="spa-state">Settings</p>
          <form id="profile"><label>Name <input id="name" name="name" required></label>
            <label>Country <select id="country"><option>Estonia</option><option>India</option></select></label>
            <label><input id="subscribe" type="checkbox"> Subscribe</label>
            <input id="upload" type="file">
          </form>
          <a id="download" href="/download" download>Download fixture</a>
          <a id="popup" href="/product-b" target="_blank">Open details in new tab</a>
        </main>
        <script>
          document.querySelector('#upload').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (file) await fetch('/upload-record', { method: 'POST', headers: { 'x-filename': file.name }, body: await file.arrayBuffer() });
          });
        </script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await pwClose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.AIDEN_BROWSER_PROFILE_DIR;
  }, 30_000);

  it('navigates, verifies SPA and form state, transfers files, and keeps tab ownership bounded', async () => {
    expect(await run(browserNavigateTool, { url: baseUrl })).toMatchObject({ success: true });
    const initial = await run(browserSnapshotTool, {});
    expect(initial).toMatchObject({ success: true });
    expect(initial.forms).toEqual(expect.arrayContaining([
      expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ label: 'Name' })]) }),
    ]));
    const screenshot = await run(browserScreenshotTool, {});
    expect(screenshot).toMatchObject({ success: true, path: expect.stringMatching(/\.png$/i) });
    expect((await fs.stat(screenshot.path)).size).toBeGreaterThan(0);

    expect(await run(browserFillTool, { fields: { '#name': 'Browser Smoke' } }))
      .toMatchObject({ success: true, verified: true });
    expect(await run(browserControlTool, { selector: '#country', operation: 'select', value: 'India' }))
      .toMatchObject({ success: true, verified: true });
    expect(await run(browserControlTool, { selector: '#subscribe', operation: 'check' }))
      .toMatchObject({ success: true, verified: true, checked: true });
    expect(await run(browserClickTool, { selector: '#spa' }))
      .toMatchObject({ success: true });
    expect(await run(browserExtractTool, {})).toMatchObject({ success: true, text: expect.stringContaining('Profile draft active') });

    const uploadPath = path.join(root, 'browser-upload-smoke.txt');
    const uploadBody = 'AIDEN_BROWSER_UPLOAD_SMOKE';
    await fs.writeFile(uploadPath, uploadBody);
    expect(await run(browserUploadTool, { selector: '#upload', paths: [uploadPath] }))
      .toMatchObject({ success: true, verified: true, files: ['browser-upload-smoke.txt'] });
    await vi.waitFor(() => expect(uploads).toEqual([{
      name: 'browser-upload-smoke.txt',
      sha256: createHash('sha256').update(uploadBody).digest('hex'),
    }]));

    const downloaded = await run(browserDownloadTool, { selector: '#download' });
    expect(downloaded).toMatchObject({
      success: true, verified: true, filename: 'browser-download-smoke.txt',
      sha256: createHash('sha256').update(downloadBody).digest('hex'),
    });
    expect(await fs.readFile(downloaded.path, 'utf8')).toBe(downloadBody);

    const initialTabs = await run(browserTabsTool, {});
    expect(initialTabs).toMatchObject({
      browser_session_id: expect.stringMatching(/^browser_session_/),
      job_id: jobContext.jobId,
      attempt_id: jobContext.attemptId,
      generation: jobContext.generation,
      session_state: 'ready',
    });
    const primaryTabId = initialTabs.tabs.find((tab: any) => tab.controlled)?.tab_id;
    expect(primaryTabId).toBeTruthy();
    expect(await run(browserTabTool, { action: 'rename', tab_id: primaryTabId, name: 'Source 1' }))
      .toMatchObject({ success: true, name: 'Source 1', verified: true });
    const opened = await run(browserTabTool, { action: 'open', url: `${baseUrl}/product-b`, name: 'Source 2' });
    expect(opened).toMatchObject({ success: true, name: 'Source 2', verified: true });
    const secondTabId = opened.tab_id;
    expect(await run(browserTabTool, { action: 'switch', tab_id: primaryTabId }))
      .toMatchObject({ success: true, tab_id: primaryTabId, verified: true });
    expect(await run(browserTabTool, { action: 'switch', tab_id: secondTabId }))
      .toMatchObject({ success: true, tab_id: secondTabId, verified: true });
    const tabs = await run(browserTabsTool, {});
    expect(tabs.success).toBe(true);
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.tabs.map((tab: any) => tab.name)).toEqual(['Source 1', 'Source 2']);
    expect(tabs.tabs.every((tab: any) => tab.created_by === 'aiden')).toBe(true);
    const durableTabs = engine.browser.listTabs(engine.browser.getSessionForAttempt(
      jobContext.jobId, jobContext.attemptId, jobContext.generation,
    )!.browserSessionId);
    expect(durableTabs.map((tab) => tab.purpose)).toEqual(['Source 1', 'Source 2']);
    expect(await run(browserTabTool, { action: 'switch', tab_id: primaryTabId }))
      .toMatchObject({ success: true, tab_id: primaryTabId, verified: true });
    expect(await run(browserTabTool, { action: 'close', tab_id: secondTabId }))
      .toMatchObject({ success: true, tab_id: secondTabId, verified: true });
    const tabsAfterClose = (await run(browserTabsTool, {})).tabs;
    expect(tabsAfterClose).toHaveLength(1);
    expect(engine.browser.listTabs(engine.browser.getSessionForAttempt(
      jobContext.jobId, jobContext.attemptId, jobContext.generation,
    )!.browserSessionId).find((tab) => tab.tabId === secondTabId)?.closedAt).not.toBeNull();

    const receipts = db.prepare('SELECT state FROM browser_action_receipts ORDER BY action_sequence').all() as Array<{ state: string }>;
    expect(receipts.length).toBeGreaterThanOrEqual(10);
    expect(receipts.every((receipt) => !['prepared', 'dispatched'].includes(receipt.state))).toBe(true);
    expect(engine.proof.listEvidence(jobContext.jobId).length).toBeGreaterThan(0);
    const activeSession = engine.browser.getSessionForAttempt(
      jobContext.jobId, jobContext.attemptId, jobContext.generation,
    )!;
    expect(await run(browserCloseTool, {})).toMatchObject({ success: true, verified: true });
    expect(engine.browser.getSession(activeSession.browserSessionId)).toMatchObject({
      state: 'closed', recoveryState: 'explicit close', controlledTabId: null,
    });
  }, 60_000);

  it('closes the controlled owned tab without rebinding its durable identity to another blank page', async () => {
    jobContext = admit('controlled-tab-close');
    const initial = await run(browserTabsTool, {});
    expect(initial).toMatchObject({ success: true, tabs: [expect.objectContaining({ controlled: true })] });
    const primaryTabId = initial.tabs[0].tab_id;

    const opened = await run(browserTabTool, {
      action: 'open', url: `${baseUrl}/product-b`, name: 'Temporary source',
    });
    expect(opened).toMatchObject({ success: true, verified: true });
    expect(opened.tab_id).not.toBe(primaryTabId);

    const closed = await run(browserTabTool, { action: 'close', tab_id: opened.tab_id });
    expect(closed).toMatchObject({ success: true, verified: true, tab_id: opened.tab_id });
    expect(closed.tabs).toEqual([
      expect.objectContaining({ tab_id: primaryTabId, controlled: true }),
    ]);

    const sessionId = initial.browser_session_id;
    expect(engine.browser.listTabs(sessionId).find((tab) => tab.tabId === opened.tab_id)?.closedAt)
      .not.toBeNull();
    expect(await run(browserCloseTool, {})).toMatchObject({ success: true, verified: true });
  }, 60_000);

  it('rehydrates the same durable named tabs after the browser host restarts', async () => {
    jobContext = admit('restart-recovery');
    expect(await run(browserNavigateTool, { url: baseUrl })).toMatchObject({ success: true });

    const before = await run(browserTabsTool, {});
    const primaryTabId = before.tabs.find((tab: any) => tab.controlled)?.tab_id;
    expect(primaryTabId).toBeTruthy();
    expect(await run(browserTabTool, { action: 'rename', tab_id: primaryTabId, name: 'Source A' }))
      .toMatchObject({ success: true, name: 'Source A', verified: true });
    const opened = await run(browserTabTool, {
      action: 'open', url: `${baseUrl}/product-b`, name: 'Source B',
    });
    expect(opened).toMatchObject({ success: true, name: 'Source B', verified: true });
    const secondTabId = opened.tab_id;
    expect(await run(browserTabTool, { action: 'switch', tab_id: secondTabId }))
      .toMatchObject({ success: true, tab_id: secondTabId, verified: true });
    expect(await run(browserTabTool, { action: 'switch', tab_id: primaryTabId }))
      .toMatchObject({ success: true, tab_id: primaryTabId, verified: true });

    const sessionId = before.browser_session_id;
    await pwClose();

    const recovered = await run(browserTabsTool, {});
    expect(recovered).toMatchObject({
      success: true,
      browser_session_id: sessionId,
      job_id: jobContext.jobId,
      attempt_id: jobContext.attemptId,
      generation: jobContext.generation,
      session_state: 'ready',
    });
    expect(recovered.tabs).toHaveLength(2);
    expect(recovered.tabs.map((tab: any) => ({
      tab_id: tab.tab_id,
      name: tab.name,
      url: tab.url,
      title: tab.title,
      controlled: tab.controlled,
    }))).toEqual([
      {
        tab_id: primaryTabId,
        name: 'Source A',
        url: `${baseUrl}/`,
        title: 'Browser Fixture',
        controlled: true,
      },
      {
        tab_id: secondTabId,
        name: 'Source B',
        url: `${baseUrl}/product-b`,
        title: 'Product B',
        controlled: false,
      },
    ]);
    const freshObservation = await run(browserExtractTool, {});
    expect(freshObservation).toMatchObject({
      success: true,
      text: expect.stringContaining('Deterministic Browser Fixture'),
    });
    expect(await run(browserCloseTool, {})).toMatchObject({ success: true, verified: true });
  }, 60_000);

  it('continues verified named tabs into a fresh Job and physical browser host', async () => {
    const source = admit('fresh-job-source');
    jobContext = source;
    expect(await run(browserNavigateTool, { url: baseUrl })).toMatchObject({ success: true });
    const sourceTabs = await run(browserTabsTool, {});
    const sourcePrimaryId = sourceTabs.tabs.find((tab: any) => tab.controlled)?.tab_id;
    expect(sourcePrimaryId).toBeTruthy();
    expect(await run(browserTabTool, { action: 'rename', tab_id: sourcePrimaryId, name: 'Source A' }))
      .toMatchObject({ success: true, verified: true });
    const sourceB = await run(browserTabTool, {
      action: 'open', url: `${baseUrl}/product-b`, name: 'Source B',
    });
    expect(sourceB).toMatchObject({ success: true, verified: true });
    expect(await run(browserTabTool, { action: 'switch', tab_id: sourceB.tab_id }))
      .toMatchObject({ success: true, verified: true });
    expect(await run(browserTabTool, { action: 'switch', tab_id: sourcePrimaryId }))
      .toMatchObject({ success: true, verified: true });

    await pwClose({ announce: false });
    completeJob(source, sourceTabs.browser_session_id);

    const target = admit('fresh-job-target');
    jobContext = target;
    const continued = await run(browserTabTool, {
      action: 'reconnect', session_id: sourceTabs.browser_session_id,
    });
    expect(continued).toMatchObject({
      success: true,
      verified: true,
      continued_from_session_id: sourceTabs.browser_session_id,
      browser_session_id: expect.stringMatching(/^browser_session_/),
      job_id: target.jobId,
      attempt_id: target.attemptId,
      generation: target.generation,
      controlled_tab_id: sourcePrimaryId,
    });
    expect(continued.browser_session_id).not.toBe(sourceTabs.browser_session_id);
    expect(continued.tabs.map((tab: any) => ({
      tab_id: tab.tab_id, name: tab.name, url: tab.url, controlled: tab.controlled,
    }))).toEqual([
      { tab_id: sourcePrimaryId, name: 'Source A', url: `${baseUrl}/`, controlled: true },
      { tab_id: sourceB.tab_id, name: 'Source B', url: `${baseUrl}/product-b`, controlled: false },
    ]);
    expect(await run(browserExtractTool, {})).toMatchObject({
      success: true,
      text: expect.stringContaining('Deterministic Browser Fixture'),
    });
    expect(engine.browser.listTabs(sourceTabs.browser_session_id).every((tab) => tab.closedAt !== null)).toBe(true);
    expect(engine.browser.listTabs(continued.browser_session_id).filter((tab) => tab.closedAt === null))
      .toHaveLength(2);
    expect(await run(browserCloseTool, {})).toMatchObject({ success: true, verified: true });
  }, 90_000);

  it('starts a fresh browser session after terminal lifecycle cleanup closes the prior physical surface', async () => {
    const first = admit('terminal-cleanup-first');
    jobContext = first;
    const firstTabs = await run(browserTabsTool, {});
    expect(firstTabs).toMatchObject({
      success: true,
      browser_session_id: expect.stringMatching(/^browser_session_/),
      tabs: [expect.objectContaining({ controlled: true })],
    });
    const temporary = await run(browserTabTool, {
      action: 'open', url: `${baseUrl}/product-b`, name: 'Temporary source',
    });
    expect(temporary).toMatchObject({ success: true, verified: true });
    expect(await run(browserTabTool, { action: 'close', tab_id: temporary.tab_id }))
      .toMatchObject({ success: true, verified: true, tab_id: temporary.tab_id });
    await pwCloseBrowserSessionResources(firstTabs.browser_session_id);
    completeJob(first, firstTabs.browser_session_id);

    const second = admit('terminal-cleanup-second');
    jobContext = second;
    const secondTabs = await run(browserTabsTool, {});
    expect(secondTabs).toMatchObject({
      success: true,
      browser_session_id: expect.stringMatching(/^browser_session_/),
      tabs: [expect.objectContaining({ controlled: true })],
    });
    expect(secondTabs.browser_session_id).not.toBe(firstTabs.browser_session_id);
    expect(await run(browserCloseTool, {})).toMatchObject({ success: true, verified: true });
  }, 60_000);
});
