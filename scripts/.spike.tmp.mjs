import { chromium } from 'playwright-core';
import { readFileSync, appendFileSync } from 'node:fs';
const OUT = '/private/tmp/claude-502/-Users-Danny-Source-smugglers-town-3d/1034eee5-2363-4a75-b924-967ecb06798a/scratchpad/dbg';
const key = readFileSync('/Users/Danny/Source/smugglers-town-3d/.sm-key.txt', 'utf8').trim();
const [name, lat, lon] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
await page.goto('http://localhost:5173/?debug', { waitUntil: 'load' });
await page.evaluate(k => localStorage.setItem('gmap_key', k), key);
await page.goto(`http://localhost:5173/?debug&lat=${lat}&lon=${lon}`, { waitUntil: 'load' });
await page.waitForFunction(() => /active/.test(document.querySelector('#debug-diagnostic')?.textContent ?? ''), null, { timeout: 120000 });
await page.waitForTimeout(12000);
for (const cs of [1.0, 2.0]) {
  const r = await page.evaluate(([cs]) => window.__spike.run({ cs, ch: 0.4, walkableSlopeAngle: 30, radiusM: 400 }), [cs]);
  const line = `${name.padEnd(16)} cs=${cs}m  ${r.ok ? `build ${Math.round(r.buildMs)}ms query ${Math.round(r.queryMs)}ms | meshes ${r.meshesUsed} tris ${r.trisUsed} | onSurface ${r.onSurface}/${r.sampled} reachable ${r.reachable} = ${r.reachablePctOfSurface.toFixed(1)}% of surface` : `FAILED ${r.error}`}`;
  console.log(line); appendFileSync(`${OUT}/spike.log`, line + '\n');
}
if (errs.length) console.log('  page errors:', errs[0]);
await b.close();
