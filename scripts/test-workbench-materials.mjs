import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = new URL(process.env.AIDEN_UI_URL || 'http://127.0.0.1:4280');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const output = process.env.AIDEN_UI_EVIDENCE ? path.resolve(process.env.AIDEN_UI_EVIDENCE) : null;
if (output) {
  assert(!output.startsWith(path.resolve('.') + path.sep), 'Screen evidence must stay outside source');
  await mkdir(output, { recursive: true });
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ colorScheme: 'dark' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], writes = [], results = [];
let learning = null;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', route => {
  const req = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
    writes.push(new URL(req.url()).pathname);
    return route.fulfill({ status: 403, json: { error: 'Read-only visual acceptance' } });
  }
  if (learning && new URL(req.url()).pathname === '/api/learning') return route.fulfill({ json: learning });
  return route.continue();
});
async function open(query, ready) {
  const start = performance.now();
  await page.goto(new URL(`/?${query}`, base).href);
  await page.locator(ready).first().waitFor();
  return Math.round(performance.now() - start);
}
async function check(label) {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
  const bounds = await page.evaluate(() => {
    const root = document.querySelector('.settings-drawer') || document.querySelector('.workbench-main');
    const rect = root.getBoundingClientRect();
    return { viewport: innerWidth, left: rect.left, right: rect.right, scroll: document.documentElement.scrollWidth,
      readable: getComputedStyle(root).fontFamily, controls: [...root.querySelectorAll('button,input,select,textarea')].filter(el => el.getClientRects().length && !el.closest('.spatial-world')).map(el => {
        const r = el.getBoundingClientRect(); return { name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60), left: r.left, right: r.right };
      }) };
  });
  assert(bounds.left >= -1 && bounds.right <= bounds.viewport + 1 && bounds.scroll <= bounds.viewport + 1, `${label}: shell overflow ${JSON.stringify(bounds)}`);
  assert.deepEqual(bounds.controls.filter(item => item.left < -1 || item.right > bounds.viewport + 1), [], `${label}: clipped controls`);
  results.push({ label, controls: bounds.controls.length });
  if (output) await page.screenshot({ path: path.join(output, `${label}.png`) });
}
try {
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    for (const [width, height] of [[480, 820], [900, 700], [1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      for (const [view, ready] of [['chat', '.workbench-home'], ['activity', '.active-work-view'], ['artifacts', '.artifact-view-tabs'], ['apps', '.catalog-app'], ['brain', '.memory-graph-shell'], ['automations', '.product-tabs']]) {
        const duration = await open(`view=${view}`, ready);
        await check(`${view}-${colorScheme}-${width}`);
        results.at(-1).readyMs = duration;
      }
      await open('settings=runtime', '.settings-content');
      await check(`settings-${colorScheme}-${width}`);
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await page.locator('.settings-drawer').waitFor({ state: 'hidden' });
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await open('settings=runtime', '.settings-content');
  const sections = await page.locator('.settings-navigation button').allTextContents();
  for (const section of sections) {
    await page.locator('.settings-navigation').getByRole('button', { name: section.trim(), exact: true }).click();
    assert((await page.locator('.settings-content').innerText()).trim().length > 0, `${section}: empty settings`);
    await check(`settings-${section.trim().toLowerCase().replace(/[^a-z]+/g, '-')}`);
  }
  await open('view=chat', '.workbench-home');
  const composer = page.getByRole('textbox', { name: 'What should Aiden take care of?' });
  await composer.fill('A draft that must not be sent');
  assert.equal(await composer.inputValue(), 'A draft that must not be sent');
  await composer.fill('');
  await page.getByRole('button', { name: 'Add to request', exact: true }).click();
  await page.getByRole('menu', { name: 'Add to this request' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.locator('.settings-content').waitFor();
  assert.match(await page.locator('.settings-content').innerText(), /model|provider/i);
  const scope = { kind: 'REPOSITORY', key: 'graph-test', ownerId: 'local-test', workspaceId: 'graph-test' };
  learning = { enabled: true, scopes: [scope], trusted: Array.from({ length: 30 }, (_, i) => ({
    id: `memory-${i}`, content: `Project context ${i + 1}`, scope, type: 'USER_PREFERENCE', subjectKey: `context-${i}`,
    confidence: 'TRUSTED', lifecycle: 'ACTIVE', eligible: true, sourceCount: 1, version: 1, contentDigest: null,
    createdAt: 1, updatedAt: 2, deletedAt: null, expiresAt: null,
  })), needsReview: [], archived: [], conflicts: [], counts: { trusted: 30, needsReview: 0, archived: 0, conflicts: 0 } };
  await open('view=brain', '.memory-node.entry');
  assert.equal(await page.locator('.memory-node.entry').count(), 30);
  const node = page.locator('.memory-node.entry').first();
  const original = await node.getAttribute('transform');
  const graphTiming = await page.evaluate(() => new Promise(resolve => {
    const intervals = []; let last = performance.now();
    const sample = now => {
      intervals.push(now - last); last = now;
      if (intervals.length < 60) requestAnimationFrame(sample);
      else { const sorted = intervals.slice(1).sort((a, b) => a - b); resolve({ frames: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)] }); }
    };
    requestAnimationFrame(sample);
  }));
  await page.waitForFunction(value => document.querySelector('.memory-node.entry')?.getAttribute('transform') !== value, original);
  await page.getByRole('checkbox', { name: 'Gentle motion' }).uncheck();
  const paused = await node.getAttribute('transform');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await node.getAttribute('transform'), paused, 'Paused graph must not move');
  await node.hover();
  assert(await page.locator('.memory-edge.highlighted').count() > 0);
  await node.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Open sources & history' }).waitFor();
  await check('graph-populated-dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('checkbox', { name: 'Reduced motion' }).waitFor();
  assert(await page.getByRole('checkbox', { name: 'Reduced motion' }).isDisabled());
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + 38, { steps: 6 }); await page.mouse.up();
  assert.notEqual(await node.getAttribute('transform'), paused, 'Reduced motion must preserve manual graph dragging');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const world = page.locator('.memory-graph-body .spatial-world');
  const camera = await world.getAttribute('style');
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.waitForFunction(value => document.querySelector('.memory-graph-body .spatial-world')?.getAttribute('style') !== value, camera);
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  assert.equal(await page.locator('.memory-node.entry').count(), 30, 'Interactions must preserve node identity count');
  await check('graph-reduced-motion');
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, [], 'Visual inspection must not change customer state');
  const report = { passed: true, checks: results.length, settingsSections: sections.length, graphTiming, errors, writes, results };
  if (output) await writeFile(path.join(output, 'materials-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: results.length, settingsSections: sections.length, graphTiming, errors, writes }));
} finally { await context.close(); await browser.close(); }
