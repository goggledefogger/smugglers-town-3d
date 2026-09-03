// Capture the 3D nav arrow in a live single-player match.
// Usage: node scripts/shot-nav.mjs [url]  (defaults to http://localhost:5174)
import { chromium } from 'playwright-core';
const URL = process.argv[2] ?? 'http://localhost:5174/';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(URL);
// start a single-player match: click START ENGINE
await page.locator('sr-intro button:has-text("START ENGINE")').click();
// let it run a few seconds so the car settles and the arrow orients
await page.waitForTimeout(3500);
await page.screenshot({ path: '.playwright-mcp/nav-arrow.png' });
// drive a bit and capture again (turn the car so the bearing changes)
await page.keyboard.down('KeyD');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyD');
await page.waitForTimeout(400);
await page.screenshot({ path: '.playwright-mcp/nav-arrow-turned.png' });
// grab the rendered transform the arrow actually got
const info = await page.evaluate(() => {
  const stage = document.querySelector('sr-dirarrow')?.shadowRoot?.querySelector('.stage') ?? null;
  const fold = document.querySelector('sr-dirarrow')?.shadowRoot?.querySelector('.fold') ?? null;
  const label = document.querySelector('sr-dirarrow')?.shadowRoot?.querySelector('.label') ?? null;
  return {
    stageTransform: stage?.getAttribute('style') ?? null,
    foldClass: fold?.className ?? null,
    label: label?.textContent ?? null
  };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
