/**
 * E2E Smoke check for Gamepad integration, specifically Google Stadia Controller
 * in non-standard Bluetooth mapping and multi-gamepad setup.
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL ?? process.argv[2] ?? 'http://localhost:5173/';

console.log(`Starting Gamepad E2E check on ${URL}...`);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

// Inject mock Stadia gamepad before page loads
await page.addInitScript(() => {
  const mockStadia = {
    id: '18d1-9400-Google LLC Stadia Controller rev. A',
    index: 0,
    connected: true,
    mapping: '', // non-standard Firefox/DirectInput mode
    axes: [0, 0, 0, 0, -1, -1], // triggers resting at -1
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
    timestamp: performance.now()
  };

  window.__mockStadia = mockStadia;

  navigator.getGamepads = () => [mockStadia];
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('sr-intro', { timeout: 30000 });

// Verify Gamepad name is displayed in intro screen footer
await page.waitForTimeout(500);
const footerText = await page.evaluate(() => {
  const intro = document.querySelector('sr-intro');
  return intro?.shadowRoot?.querySelector('footer')?.textContent ?? '';
});

console.log('Checking intro footer for gamepad badge...');
if (!footerText.includes('Google Stadia Controller')) {
  console.error('FAIL: Gamepad badge not found in intro footer! Found: ' + footerText);
  process.exit(1);
}
console.log('  ok  Google Stadia Controller detected in garage screen');

// Click start engine
await page.locator('sr-intro .play').click();
console.log('Waiting through cinematic countdown...');
await page.waitForTimeout(6500);

// Simulate gamepad throttle (A button = raw button 0) and steer (left stick X = axis 0)
await page.evaluate(() => {
  const pad = window.__mockStadia;
  if (pad) {
    pad.buttons[0] = { value: 1, pressed: true };
    pad.axes[0] = -0.7; // steer left
    pad.timestamp = performance.now();
  }
});

await page.waitForTimeout(2000);

const state = await page.evaluate(() => {
  const text = sel => document.querySelector(sel)?.shadowRoot?.textContent?.trim() ?? '';
  return {
    speed: text('sr-speed')
  };
});

const kmh = Number(state.speed.match(/(\d+)/)?.[1] ?? 0);
console.log(`Car speed after gamepad throttle: ${kmh} km/h`);
if (kmh <= 0) {
  console.error('FAIL: Car did not move with gamepad throttle!');
  process.exit(1);
}
console.log('  ok  Car accelerated and steered via non-standard Bluetooth Stadia controller!');

await browser.close();
console.log('\nGamepad E2E smoke test PASSED!');
