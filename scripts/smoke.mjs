/**
 * Headless smoke check for the layer the unit tests cannot reach: the renderer,
 * the HUD and the input path.
 *
 * The desert start needs no Maps key and exercises physics, colliders, bots and
 * every HUD component. Everything asserted here is something that has actually
 * broken: the HUD stacked in normal flow under the canvas for months because
 * .hud-corner was never styled, and the radar rendered off-screen the first
 * time it became a component.
 *
 *   npm run smoke                       # against the dev server
 *   E2E_URL=https://… npm run smoke     # against a deployment
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL ?? process.argv[2] ?? 'http://localhost:5173/';
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 }
];

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({ channel: 'chrome' });
for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name} (${vp.width}x${vp.height}) — ${URL}`);
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('sr-intro .play', { timeout: 30000 });
  await page.locator('sr-intro .play').click();
  await page.waitForTimeout(1500);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');

  const state = await page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.shadowRoot?.textContent?.trim() ?? '';
    const radar = document.querySelector('sr-minimap')?.shadowRoot?.querySelector('canvas');
    let spread = 0;
    if (radar) {
      const d = radar.getContext('2d').getImageData(0, 0, radar.width, radar.height).data;
      let lo = 255, hi = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (l < lo) lo = l;
        if (l > hi) hi = l;
      }
      spread = hi - lo;
    }
    // the relocate bar has twice drifted on top of the score panel
    const rect = sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const bar = rect('sr-relocate');
    const overlaps = (a, b) => !!a && !!b && a.r > b.l && a.l < b.r && a.b > b.t && a.t < b.b;
    const barOverBar = ['#hud .hud-tl', '#hud .hud-tr', 'sr-dirarrow'].some(sel => overlaps(bar, rect(sel)));
    const barRows = bar ? Math.round(bar.b - bar.t) : 0;
    const corners = [...document.querySelectorAll('#hud .hud-corner')].map(e => {
      const b = e.getBoundingClientRect();
      return { name: e.className, x: b.x, y: b.y, right: b.right, bottom: b.bottom, w: b.width, h: b.height };
    });
    return {
      speed: text('sr-speed'),
      barOverBar,
      barRows,
      objective: text('sr-objective'),
      corners,
      radarSpread: spread,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth
    };
  });

  const kmh = Number(state.speed.match(/(\d+)/)?.[1] ?? 0);
  check(errors.length === 0, `no console or page errors${errors.length ? `: ${errors[0]}` : ''}`);
  check(kmh > 0, `the car moves under throttle (${kmh} km/h)`);
  check(/CONTRABAND|BASE|TAKE IT BACK|ESCORT/.test(state.objective), 'the objective panel says something');
  check(state.corners.length === 4, `all four HUD corners exist (${state.corners.length})`);
  const offscreen = state.corners.filter(c =>
    c.x < 0 || c.y < 0 || c.right > state.winW + 1 || c.bottom > vp.height + 1 || c.w === 0);
  check(offscreen.length === 0, `no HUD corner off-screen${offscreen.length ? `: ${offscreen.map(c => c.name).join(', ')}` : ''}`);
  check(state.docW <= state.winW, `no horizontal overflow (${state.docW} <= ${state.winW})`);
  check(!state.barOverBar, 'the relocate bar covers no HUD corner or the nav marker');
  // wrapping to a second row is what pushes it down onto the marker
  check(state.barRows < 70, `the relocate bar stays on one row (${state.barRows}px tall)`);
  // a flat fill would mean the terrain relief never rasterised
  check(state.radarSpread > 20, `radar shows terrain relief (luminance spread ${Math.round(state.radarSpread)})`);
  await page.close();
}
await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
