import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Isolated static-build smoke: no personal home, live backend, account or mutation.
const root = path.resolve('dashboard-next/out');
const output = path.resolve(process.env.AIDEN_UI_EVIDENCE || '');
assert(process.env.AIDEN_UI_EVIDENCE && !output.startsWith(path.resolve('.') + path.sep), 'Use evidence outside source');
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const errors = [], writes = [], results = [];
let readinessUnavailable = false;
let accountUrl;
const readiness = { overall: 'needs_attention', checkedAt: 1, issues: [], items: [
  { id: 'workspace', title: 'Workspace', ready: true, healthy: true, blocking: true, state: 'ready', availableActions: [], detail: 'Test workspace' },
  { id: 'chat-provider', title: 'Model', ready: false, healthy: false, blocking: true, state: 'needs_setup', availableActions: ['manage_provider'], detail: 'No model configured' },
] };
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  if (request.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ status: 403, json: { error: 'Fixture rejects mutations' } }); }
  if (url.pathname === '/api/sessions') return route.fulfill({ json: [] });
  if (url.pathname === '/api/commercial/status') return route.fulfill({ json: accountUrl ? { accountUrl } : {} });
  if (url.pathname === '/api/system/readiness') return route.fulfill(readinessUnavailable ? { status: 503, json: { error: 'Readiness unavailable' } } : { json: readiness });
  if (url.pathname === '/api/external-protocols') return route.fulfill({ json: {
    entitlements: { mcpExternal: true, a2aPreview: false },
    mcp: { canonicalProtocolVersion: 'fixture', servers: [{ name: 'Test server', status: 'disconnected', authState: 'unavailable', reviewRequired: false, readToolCount: 0, mutationToolCount: 0, toolCount: 0, mutationBlocked: true, resourcesAvailable: false, endpoint: 'local fixture', transport: 'stdio', trustState: 'unknown', capabilityChange: 'none' }] },
    a2a: { protocolVersion: 'fixture', binding: 'fixture', mutationEnabled: false, agents: [], recoverableTasks: [], quarantinedArtifacts: 0 },
  } });
  return route.fulfill({ status: 503, json: { error: 'Capability not configured in isolated UI fixture' } });
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => errors.push(error.message));
try {
  for (const [width, height] of [[480,820], [900,700], [1366,768], [1920,1080]]) {
    await page.setViewportSize({ width, height });
    const start = performance.now();
    await page.goto(base + '/?view=connections');
    await page.getByRole('heading', { name: 'Connections & capabilities' }).waitFor();
    if (width <= 980) await page.locator('.workbench-grid.sidebar-closed').waitFor();
    const bounds = await page.evaluate(() => {
      const main = document.querySelector('.connections-workspace');
      const rail = document.querySelector('.history-sidebar');
      const rect = main.getBoundingClientRect(), nav = rail.getBoundingClientRect();
      return { left: rect.left, right: rect.right, navRight: nav.right, navWidth: nav.width, viewport: innerWidth, scroll: document.documentElement.scrollWidth,
        mainScroll: main.scrollWidth, mainWidth: main.clientWidth };
    });
    if (width > 620) assert(bounds.navWidth > 0, 'Visible navigation must have measured bounds');
    else {
      // The existing phone layout uses a drawer, not an always-visible rail.
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      await page.locator('.sidebar-nav').getByRole('button', { name: 'Connections', exact: true }).click();
      await page.locator('.workbench-grid.sidebar-closed').waitFor();
    }
    assert(bounds.left >= bounds.navRight - 1, JSON.stringify(bounds));
    assert(bounds.right <= width + 1 && bounds.scroll <= width + 1 && bounds.mainScroll <= bounds.mainWidth + 1, JSON.stringify(bounds));
    results.push({ name: `connections-${width}`, bounds, elapsedMs: Math.round(performance.now() - start) });
    await page.screenshot({ path: path.join(output, `connections-${width}.png`) });
  }
  await page.getByRole('searchbox').fill('Telegram');
  assert.equal(await page.locator('.connections-card').count(), 1);
  await page.getByRole('button', { name: 'Open Telegram', exact: true }).click();
  await page.getByRole('heading', { name: 'Messaging connections' }).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.reload();
  await page.getByRole('heading', { name: 'Messaging connections' }).waitFor();
  results.push({ name: 'search-messaging-deep-link-reload' });
  await page.goto(base + '/?settings=mcp');
  await page.getByText('Disconnected', { exact: true }).waitFor();
  assert.equal(await page.getByText('Connected', { exact: true }).count(), 0);
  results.push({ name: 'disconnected-server-is-not-connected' });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Welcome to Aiden' }).waitFor();
  await page.getByRole('button', { name: 'Continue to Workbench', exact: true }).click();
  await page.locator('.onboarding-dialog').waitFor({ state: 'hidden' });
  assert.notEqual(await page.evaluate(() => localStorage.getItem('aiden:first-run:v1')), 'complete');
  await page.goto(base + '/?settings=runtime');
  await page.getByRole('button', { name: 'Resume guided setup' }).click();
  await page.locator('.onboarding-dialog').waitFor();
  results.push({ name: 'dismiss-and-resume-does-not-fake-completion' });
  readinessUnavailable = true;
  await page.reload();
  await page.getByRole('button', { name: 'Resume guided setup' }).click();
  await page.getByRole('button', { name: 'Check this computer', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'readiness could not be loaded' }).waitFor();
  await page.getByRole('button', { name: 'Continue to Workbench', exact: true }).click();
  await page.locator('.onboarding-dialog').waitFor({ state: 'hidden' });
  results.push({ name: 'readiness-outage-does-not-trap-onboarding' });
  accountUrl = 'https://accounts.example.test';
  await page.goto(base + '/?settings=account');
  const signIn = page.getByRole('link', { name: 'Sign in or create an account', exact: true });
  await signIn.waitFor();
  assert.equal(await signIn.getAttribute('href'), accountUrl);
  assert.equal(await signIn.getAttribute('rel'), 'noopener noreferrer');
  // Inspect the link without opening or signing into an external account.
  assert.equal(await page.locator('input[type="password"], input[type="email"]').count(), 0);
  results.push({ name: 'configured-account-portal-is-explicit-and-does-not-collect-secrets' });
  accountUrl = 'javascript:alert(1)';
  await page.reload();
  await page.getByText('Account sign-in is not enabled for this installation yet.', { exact: false }).waitFor();
  assert.equal(await signIn.count(), 0);
  results.push({ name: 'unsafe-account-portal-is-not-rendered' });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 480, height: 820 });
  await page.goto(base + '/?view=connections');
  await page.getByRole('heading', { name: 'Connections & capabilities' }).waitFor();
  await page.screenshot({ path: path.join(output, 'connections-dark-phone.png') });
  results.push({ name: 'dark-mode-reduced-motion-phone' });
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
} finally {
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ type: 'isolated static-build fixture', results, errors, writes }, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ passed: results.length, errors: errors.length, mutations: writes.length }));
