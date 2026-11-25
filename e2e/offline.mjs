// Offline checks: the till keeps selling with no connection, queues sales, and delivers each exactly once.
// Usage: node e2e/offline.mjs https://your-deploy.vercel.app
import puppeteer from 'puppeteer-core';
const U = process.argv[2] || 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const txt = (sel) => p.$eval(sel, (e) => e.innerText).catch(() => '');
const api = (method, body, token) => p.evaluate(async (method, body, token) => { const r = await fetch('/api/data', { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token ?? JSON.parse(localStorage.getItem('mk.token'))) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; }, method, body, token);

// owner token (to inspect the server) and reset
await p.goto(U + '/?lang=en', { waitUntil: 'networkidle0' });
await p.evaluate(() => localStorage.clear());
const ownerTok = (await p.evaluate(async () => (await (await fetch('/api/data', { method: 'POST', body: JSON.stringify({ op: { type: 'login', pin: '1111' } }) })).json()).token));
await api('POST', { op: { type: 'reset' } }, ownerTok);
const server = async () => (await api('GET', null, ownerTok)).json;
let sv = await server();
const item = sv.products[0].variants[1], other = sv.products[2].variants[0];
const s0 = item.stock, s1 = other.stock;

// cashier signs in online and opens the POS; wait for the service worker to take control
await p.reload({ waitUntil: 'networkidle0' });
await p.type('#pin', '2222'); await p.keyboard.press('Enter'); await p.waitForSelector('.tile'); await sleep(1500);
await p.evaluate(async () => { await navigator.serviceWorker.ready; });
ok(await p.evaluate(() => !!navigator.serviceWorker.controller), 'service worker is controlling the page');
await sleep(800);

// go offline and sell
await p.setOfflineMode(true);
const sellOne = async (q, pay) => {
  await p.click('#q', { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.type('#q', q); await p.keyboard.press('Enter'); await sleep(250);
  await p.click('[data-act=pay]'); await sleep(250); await p.click('[data-act=q-exact]'); await sleep(150); await p.click('#payok'); await sleep(900);
  const r = await txt('.receipt'); await p.click('[data-act=receipt-close]'); await sleep(250); return r;
};
const r1 = await sellOne(item.barcode);
ok(/waiting to sync/.test(r1), 'offline sale gives a receipt marked as waiting to sync');
ok(/Offline/.test(await txt('#netpill')) && /1 waiting/.test(await txt('#netpill')), 'status pill shows Offline and 1 waiting');
const r2 = await sellOne(other.sku);
ok(/2 waiting/.test(await txt('#netpill')), 'second offline sale queued (2 waiting)');
const localLeft = await p.evaluate((id) => window.__mk.view.products.flatMap((x) => x.variants).find((v) => v.id === id).stock, item.id);
ok(localLeft === s0 - 1, `local stock dropped while offline (${s0} to ${localLeft})`);
const reached = await server().then(() => true).catch(() => false);
ok(!reached, 'the browser really is offline (the server cannot be reached)');

// reload the page with no connection: the app must still open with the queue intact
await p.setOfflineMode(false); await p.setOfflineMode(true);
await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(1500);
ok((await p.$('.top')) !== null && /2 waiting/.test(await txt('#netpill')), 'app opens from cache with no connection and still holds 2 queued sales');
ok((await p.$$('.tile')).length > 20, 'catalog is shown from the saved copy while offline');

// reconnect: queue drains by itself, each sale lands once
await p.setOfflineMode(false);
let drained = false;
for (let i = 0; i < 40 && !drained; i++) { await sleep(500); drained = await p.evaluate(() => window.__mk.queue.length === 0); }
ok(drained, 'queue empties after reconnect without any click');
await sleep(500);
sv = await server();
const mine = sv.sales.filter((s) => s.offline);
ok(mine.length === 2, 'both offline sales are on the server exactly once, got ' + mine.length);
ok(sv.products[0].variants[1].stock === s0 - 1 && sv.products.flatMap((x) => x.variants).find((v) => v.id === other.id).stock === s1 - 1, 'server stock dropped by exactly one for each item');
ok(mine.every((s) => s.shiftId), 'offline sales were attached to the open shift');
ok(mine.every((s) => Date.now() - s.t > 3000), 'offline sales keep the time they were made');
ok(/^0|^$/.test((await txt('#netpill')).replace(/\D/g, '')) && /Online/.test(await txt('#netpill')), 'status pill is back to Online with nothing waiting');

// a sale with a price the server does not know is rejected and shown, not dropped silently
await p.evaluate((vid) => { const q = JSON.parse(localStorage.getItem('mk.queue') || '[]'); q.push({ type: 'sale', id: 'bad-offline-' + Date.now(), offline: true, t: Date.now() - 5000, shiftId: window.__mk.view.myShift?.id, lines: [{ variantId: vid, qty: 1, price: 1 }], payments: [{ method: 'cash', amount: 100 }], pseudoTotal: 100 }); localStorage.setItem('mk.queue', JSON.stringify(q)); }, item.id);
await p.reload({ waitUntil: 'networkidle0' });
for (let i = 0; i < 30; i++) { await sleep(500); if (await p.evaluate(() => window.__mk.rejected.length > 0)) break; }
ok(/not a known price/.test(await txt('.notice.bad')), 'a sale refused by the server is shown to the cashier with the reason');
ok((await p.evaluate(() => window.__mk.queue.length)) === 0, 'the refused sale left the queue (no endless retry)');

await api('POST', { op: { type: 'reset' } }, ownerTok);
ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join('|'));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
