// Two headless Chrome contexts play an online match against the dev server:
// create a room, join by code, ready up, start, drive, read both HUDs.
// Usage: npm run dev (in another terminal), then npm run e2e:online
// Needs Chrome installed and network access to the Firebase project
import { chromium } from 'playwright-core';
const URL = 'http://localhost:5173/';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const mk = async (tag) => {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 750 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${tag} ${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log(`[${tag} pageerror]`, String(e).slice(0, 300)));
  await page.goto(URL);
  return page;
};
const host = await mk('host');
const guest = await mk('guest');
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
for (const p of [host, guest]) await p.locator('sr-intro button:has-text("PLAY ONLINE")').click();
await host.locator('sr-lobby #name').fill('Host');
await host.locator('sr-lobby button:has-text("CREATE ROOM")').click();
const lobbyText = (page) => page.evaluate(() => document.querySelector('sr-lobby')?.shadowRoot?.textContent.replace(/\s+/g, ' ').trim().slice(0, 300));
let code;
try {
  code = (await host.locator('sr-lobby .code-big').textContent({ timeout: 20000 })).trim();
} catch {
  log('no room code; lobby says:', await lobbyText(host));
  await b.close();
  process.exit(1);
}
log('room code', code);
await guest.locator('sr-lobby #name').fill('Guest');
await guest.locator('sr-lobby #code').fill(code);
await guest.locator('sr-lobby button:has-text("JOIN")').click();
try {
  await guest.locator('sr-lobby .code-big').waitFor({ timeout: 20000 });
} catch {
  log('guest never entered the room; guest lobby says:', await lobbyText(guest));
  log('host lobby says:', await lobbyText(host));
  await b.close();
  process.exit(1);
}
log('guest in room');
log('guest el before:', JSON.stringify(await guest.evaluate(() => { const el = document.querySelector('sr-lobby'); window.__ev = []; for (const n of ['lobby-ready', 'lobby-vehicle', 'lobby-team']) el.addEventListener(n, e => window.__ev.push([n, e.detail])); return { selfId: el.selfId, hasRoom: !!el.room, busy: el.busy, players: Object.keys(el.room?.players ?? {}) }; })));
await guest.locator('sr-lobby button', { hasText: /READY/i }).first().click();
await guest.waitForTimeout(1500);
log('guest events:', JSON.stringify(await guest.evaluate(() => window.__ev)));
await guest.waitForTimeout(2500);
log('room in db:', JSON.stringify((await (await fetch(`https://smugglers-town-3d-default-rtdb.firebaseio.com/rooms/${code}.json`)).json())?.players));
log('guest lobby:', (await lobbyText(guest)).slice(0, 200));
const start = host.locator('sr-lobby button:has-text("START MATCH")');
await start.waitFor({ timeout: 20000 });
for (let i = 0; i < 40 && await start.isDisabled(); i++) await host.waitForTimeout(250);
log('start enabled:', !(await start.isDisabled()));
await start.click();
const hud = (page) => page.evaluate(() => {
  const out = [];
  const walk = (n) => { if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.children || []) { if (c.tagName?.startsWith('SR-') && !c.hidden) out.push(c.tagName + ': ' + (c.shadowRoot ? c.shadowRoot.textContent : c.textContent).replace(/\s+/g, ' ').trim().slice(0, 90)); walk(c); } };
  walk(document.body);
  return out;
});
for (let i = 0; i < 30; i++) {
  await host.waitForTimeout(1000);
  const h = await hud(host), g = await hud(guest);
  const hs = h.find(x => x.startsWith('SR-SPEED')), gs = g.find(x => x.startsWith('SR-SPEED'));
  if (i % 5 === 0 || (hs && gs)) log('host:', h.filter(x => /SPEED|SCORE|BANNER|LOBBY/.test(x)).join(' | '), '\n      guest:', g.filter(x => /SPEED|SCORE|BANNER|LOBBY/.test(x)).join(' | '));
  if (hs && gs) break;
}
// drive on the guest, watch the host see it move
const key = (p, type, code, k) => p.evaluate(([type, code, k]) => window.dispatchEvent(new KeyboardEvent(type, { code, key: k, bubbles: true })), [type, code, k]);
await host.waitForTimeout(4000);
await key(guest, 'keydown', 'KeyW', 'w');
await guest.waitForTimeout(3000);
await key(guest, 'keyup', 'KeyW', 'w');
log('after guest drove — host HUD:', (await hud(host)).filter(x => /SPEED|OBJECTIVE/.test(x)).join(' | '));
log('guest HUD:', (await hud(guest)).filter(x => /SPEED|OBJECTIVE|HEALTH/.test(x)).join(' | '));
await host.screenshot({ path: '.playwright-mcp/e2e-host.jpg', type: 'jpeg', quality: 80 });
await guest.screenshot({ path: '.playwright-mcp/e2e-guest.jpg', type: 'jpeg', quality: 80 });
await b.close();
