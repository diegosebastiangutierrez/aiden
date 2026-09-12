import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Run against an already-running local Workbench. All mutation requests are blocked.
const base = new URL(process.env.AIDEN_UI_URL || 'http://127.0.0.1:4280');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Only loopback Workbench targets are supported');
const output = process.env.AIDEN_UI_EVIDENCE ? path.resolve(process.env.AIDEN_UI_EVIDENCE) : null;
if (output) {
  assert(!output.startsWith(path.resolve('.') + path.sep), 'Keep private screen evidence outside the repository');
  await mkdir(output, { recursive: true });
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
const mutations = [];
const results = [];
const reviewed = [];
let fixtures = null;
let failedLearning = false;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', async route => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
    mutations.push({ method: request.method(), path: pathname });
    return route.fulfill({ status: 403, json: { error: 'Read-only UI acceptance blocks writes' } });
  }
  if (fixtures && pathname === '/api/learning' && failedLearning) return route.fulfill({ status: 503, json: { error: 'Knowledge temporarily unavailable' } });
  if (fixtures?.[pathname]) return route.fulfill({ json: fixtures[pathname] });
  if (fixtures && pathname.startsWith('/api/learning/')) {
    const id = decodeURIComponent(pathname.slice('/api/learning/'.length));
    reviewed.push(id);
    const entry = [...fixtures['/api/learning'].trusted, ...fixtures['/api/learning'].needsReview, ...fixtures['/api/learning'].archived].find(item => item.id === id);
    return route.fulfill({ json: { entry, history: [], versions: [], sources: [], conflicts: [] } });
  }
  return route.continue();
});
async function open(view) {
  const start = performance.now();
  await page.goto(new URL(`/?view=${view}`, base).href);
  await page.locator('.workspace-surface').waitFor();
  await page.getByRole('navigation', { name: view === 'brain' ? 'Brain sections' : view === 'apps' ? 'Apps sections' : 'Automation sections' }).waitFor();
  return Math.round(performance.now() - start);
}
async function bounds(label) {
  // Resizing delivers the responsive navigation update asynchronously.
  // Require the actual closed state; never force it or ignore overlap.
  if (page.viewportSize().width <= 980) await page.locator('.workbench-grid.sidebar-closed').waitFor();
  const geometry = await page.evaluate(() => {
    const main = document.querySelector('.workspace-surface');
    const rail = Array.from(document.querySelectorAll('.history-sidebar')).find(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).display !== 'none');
    const rect = main.getBoundingClientRect();
    const controls = Array.from(main.querySelectorAll('button,input,select,textarea')).filter(node => node.getClientRects().length > 0 && !node.closest('.spatial-world'));
    return { left: rect.left, right: rect.right, viewport: innerWidth, railRight: rail?.getBoundingClientRect().right ?? 0,
      scrollWidth: document.documentElement.scrollWidth, mainScroll: main.scrollWidth, mainWidth: main.clientWidth,
      clippedControls: controls.filter(node => { const r = node.getBoundingClientRect(); return r.left < rect.left - 1 || r.right > rect.right + 1; }).map(node => node.getAttribute('aria-label') || node.textContent.slice(0, 60)) };
  });
  if (geometry.viewport > 620) assert(geometry.railRight > 0, `${label}: navigation bounds must be measured`);
  assert(geometry.left >= geometry.railRight - 1, `${label}: content under navigation ${JSON.stringify(geometry)}`);
  assert(geometry.right <= geometry.viewport + 1, `${label}: content outside viewport`);
  assert(geometry.scrollWidth <= geometry.viewport + 1 && geometry.mainScroll <= geometry.mainWidth + 1, `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.clippedControls, [], `${label}: clipped controls`);
  results.push({ label, geometry });
  if (output) await page.screenshot({ path: path.join(output, `${label}.png`) });
}
try {
  for (const [width, height] of [[480, 820], [900, 700], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    for (const view of ['apps', 'brain', 'automations']) {
      const elapsedMs = await open(view);
      await bounds(`live-${view}-${width}`);
      results.at(-1).elapsedMs = elapsedMs;
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await open('apps');
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await bounds('live-expanded-sidebar');
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const view of ['apps', 'brain', 'automations']) {
    await open(view);
    await bounds(`live-${view}-dark`);
  }
  const scope = { kind: 'REPOSITORY', key: 'fixture-project', ownerId: 'fixture-owner', workspaceId: 'fixture-workspace' };
  const memory = (id, content, overrides = {}) => ({ id, content, scope, type: 'USER_PREFERENCE', subjectKey: 'preference', confidence: 'TRUSTED', lifecycle: 'ACTIVE', eligible: true, sourceCount: 1, version: 1, contentDigest: null, createdAt: 1, updatedAt: 2, deletedAt: null, expiresAt: null, ...overrides });
  fixtures = {
    '/api/learning': { enabled: true, scopes: [scope], trusted: [memory('concise', 'Write concise project briefs')], needsReview: [memory('review', 'Review changed project conventions', { lifecycle: 'STALE', eligible: false })], archived: [memory('archive', 'Archived writing preference', { lifecycle: 'ARCHIVED', eligible: false })], conflicts: [], counts: { trusted: 1, needsReview: 1, archived: 1, conflicts: 0 } },
    '/api/apps': { providers: [{ id: 'fixture-provider', label: 'Test connection service', health: 'healthy' }], toolkits: [{ providerId: 'fixture-provider', toolkitId: 'github', label: 'GitHub' }, { providerId: 'fixture-provider', toolkitId: 'gmail', label: 'Gmail' }], accounts: [], configuration: { workbench: true } },
    '/api/automations': { capability: { available: true, visualWorkflows: true }, scheduler: { ready: true, dueBindings: 0 }, automations: [], history: [], attention: [] },
  };
  await page.setViewportSize({ width: 1366, height: 768 });
  await open('brain');
  const brain = page.locator('.brain-explorer');
  await brain.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await brain.getByRole('searchbox').fill('CONCISE');
  assert.equal(await brain.locator('.knowledge-card').count(), 1);
  await brain.getByRole('button', { name: 'Review', exact: true }).last().click();
  await page.locator('.learning-review').waitFor();
  assert.deepEqual(reviewed, ['concise']);
  await open('brain');
  await brain.getByRole('button', { name: 'Review', exact: true }).first().click();
  assert.equal(await brain.locator('.knowledge-card').count(), 1);
  assert.match(await brain.locator('.knowledge-card').innerText(), /Needs review/);
  await brain.getByRole('button', { name: 'Graph', exact: true }).click();
  assert.equal(await brain.locator('.memory-node.entry').count(), 3);
  await brain.getByRole('button', { name: 'Memory: Write concise project briefs', exact: true }).click();
  await brain.getByRole('button', { name: 'Open sources & history' }).waitFor();
  await bounds('fixture-relationships');
  failedLearning = true;
  await open('apps');
  await page.goto(new URL('/?view=brain', base).href);
  await page.getByRole('alert').filter({ hasText: 'Knowledge temporarily unavailable' }).waitFor();
  assert.equal(await brain.count(), 0);
  failedLearning = false;
  await open('apps');
  const apps = page.locator('.workspace-surface');
  await apps.getByRole('searchbox').fill('gmail');
  assert.equal(await apps.locator('.catalog-app').count(), 1);
  await apps.getByRole('searchbox').fill('not-an-app');
  await apps.getByRole('heading', { name: 'No matching apps' }).waitFor();
  await apps.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await apps.locator('.catalog-app').count(), 2);
  await apps.getByRole('button', { name: 'App workflows', exact: true }).click();
  await apps.getByRole('heading', { name: 'Connect an account to build a workflow' }).waitFor();
  await open('automations');
  await page.locator('.workflow-template-grid button').first().click();
  await page.locator('.workflow-outline').waitFor();
  const task = page.locator('textarea[name="prompt"]');
  assert((await task.inputValue()).length > 0);
  await task.fill('Summarise project changes');
  assert.match(await page.locator('.workflow-outline').innerText(), /Summarise project changes/);
  assert.equal(await page.locator('input[name="allowWrite"]').isChecked(), false);
  for (const [width, height] of [[480, 820], [900, 700], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await bounds(`fixture-workflow-draft-${width}`);
  }
  await page.getByRole('button', { name: 'Visual builder', exact: true }).click();
  await page.locator('.workflow-canvas-shell').waitFor();
  assert.equal(await page.locator('.workflow-block').count(), 4);
  await page.getByRole('button', { name: 'Edit Read file read', exact: true }).click();
  await page.getByLabel('Workspace-relative path', { exact: true }).fill('../outside');
  assert.equal(await page.getByRole('button', { name: 'Review & save', exact: true }).isDisabled(), true);
  await page.getByLabel('Workspace-relative path', { exact: true }).fill('package.json');
  await page.getByRole('button', { name: 'Disconnect input', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Review & save', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Connect output of List folder list', exact: true }).click();
  await page.getByRole('button', { name: 'Connect input of Read file read', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Review & save', exact: true }).isDisabled(), false);
  for (const [width, height] of [[480, 820], [900, 700], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await bounds(`fixture-workflow-canvas-${width}`);
  }
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  assert.deepEqual(mutations, [], 'Draft browsing must not attempt a mutation');
  console.log(JSON.stringify({ passed: true, viewportChecks: results.length, mutations: mutations.length, browserErrors: errors.length, results }, null, 2));
  if (output) await writeFile(path.join(output, 'ui-results.json'), JSON.stringify({ passed: true, results, browserErrors: errors.length, mutations: mutations.length }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
