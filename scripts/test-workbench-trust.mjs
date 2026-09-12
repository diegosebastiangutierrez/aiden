import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = new URL(process.env.AIDEN_UI_URL || 'http://127.0.0.1:4280');
assert(['127.0.0.1', 'localhost'].includes(base.hostname));
const output = process.env.AIDEN_UI_EVIDENCE ? path.resolve(process.env.AIDEN_UI_EVIDENCE) : null;
if (output) {
  assert(!output.startsWith(path.resolve('.') + path.sep));
  await mkdir(output, { recursive: true });
}
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
let level = 'Assistant', reject = false;
const writes = [], errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', route => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname === '/api/workbench/trust') {
    if (request.method() === 'POST') {
      writes.push(request.postDataJSON());
      if (reject) return route.fulfill({ status: 503, json: { error: 'Fixture storage unavailable' } });
      level = request.postDataJSON().level;
    }
    return route.fulfill({ json: { level, appliesTo: 'new-chat-jobs' } });
  }
  if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
  return route.continue();
});
try {
  await page.goto(base.href);
  const button = page.locator('.composer-auto-mode');
  await button.filter({ hasText: 'Auto off' }).waitFor();
  await button.click();
  await button.filter({ hasText: 'Auto on' }).waitFor();
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(writes, [{ level: 'Partner' }]);
  checks.push('one click requests the canonical Partner level');
  await page.reload();
  await button.filter({ hasText: 'Auto on' }).waitFor();
  checks.push('reload reflects server state');
  await button.click();
  await button.filter({ hasText: 'Auto off' }).waitFor();
  assert.deepEqual(writes[1], { level: 'Assistant' });
  checks.push('turning Auto off requests Assistant');
  reject = true;
  await button.click();
  await page.getByRole('alert').filter({ hasText: 'could not be confirmed' }).waitFor();
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  assert(await button.isDisabled());
  checks.push('failed save never claims Auto enabled');
  reject = false;
  await page.reload();
  await button.filter({ hasText: 'Auto off' }).waitFor();
  for (const [width, height] of [[480,820],[900,700],[1366,768],[1920,1080]]) {
    await page.setViewportSize({ width, height });
    if (width <= 980) await page.locator('.workbench-grid.sidebar-closed').waitFor();
    const bounds = await button.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
    await page.locator('.aiden-brand-mark img').first().evaluate(async image => { await image.decode(); });
    assert(await page.locator('.aiden-brand-mark img').first().evaluate(image => image.complete && image.naturalWidth === 1484));
    checks.push(`logo and composer control visible at ${width}x${height}`);
    if (output) await page.screenshot({ path: path.join(output, `chat-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  const result = { scope: 'Browser UI using an explicit trust-port fixture; no customer configuration mutated', checks, writes, errors };
  if (output) await writeFile(path.join(output, 'trust-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await context.close(); await browser.close(); }
