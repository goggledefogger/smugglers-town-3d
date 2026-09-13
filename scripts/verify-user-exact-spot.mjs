import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const ARTIFACT_DIR = '/Users/Danny/.gemini/antigravity-ide/brain/17338ac7-1732-4700-9dc2-17d3d0437a25';
const SCRATCH = `${ARTIFACT_DIR}/scratch`;
mkdirSync(SCRATCH, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:5173';
const key = readFileSync('.sm-key.txt', 'utf8').trim();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);

console.log('[exact-spot] Navigating to user exact GPS (?lat=37.79613&lon=-122.40241&debug)...');
await page.goto(`${BASE}/?lat=37.79613&lon=-122.40241&debug`, { waitUntil: 'load' });
await page.waitForSelector('sr-loader[hidden]', { state: 'attached', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('sr-relocate')?.busy, null, { timeout: 60000 });
await page.locator('sr-intro button.play').click();
await page.waitForFunction(() => !!window.__game?.player, null, { timeout: 30000 });
await page.keyboard.press('Space');

// Set ultra resolution mode like user's HUD
await page.evaluate(() => {
  window.__tiles?.setResolutionMode('ultra');
});

// Wait for tiles to stream in
console.log('[exact-spot] Waiting for tiles to stream in...');
await page.waitForFunction(() => (window.__tiles?.tiles?.length ?? 0) > 80, null, { timeout: 60000 });
await page.waitForTimeout(5000);

// Place vehicle exactly at user position and orientation
await page.evaluate(() => {
  const p = window.__game.player.body;
  p.pos.set(-89, 43.3, -716);
  p.yaw = 0; // Facing North
  window.__setViewMode('best-3d');
});
await page.waitForTimeout(2000);

const shot = `${SCRATCH}/best3d_exact_user_view.png`;
await page.screenshot({ path: shot });
console.log(`[exact-spot] Saved exact viewpoint screenshot: ${shot}`);

await browser.close();
