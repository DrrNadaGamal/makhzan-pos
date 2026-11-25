// Browser checks against a running Makhzan (local dev server or the live URL).
// Usage: node e2e/e2e.mjs https://your-deploy.vercel.app   (needs Chrome at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
const U = process.argv[2] || 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } console.log(c ? 'PASS' : 'FAIL', m); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const errs = [];
async function newPage(w = 1440, h = 900) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errs.push(m.text()));
  p.on('dialog', (d) => d.dismiss());
  return p;
}
async function login(p, pin, lang = 'en') {
  await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.type('#pin', pin); await p.keyboard.press('Enter'); await p.waitForSelector('.top', { timeout: 15000 }); await sleep(300);
}
const api = (p, method, body, token) => p.evaluate(async (method, body, token) => { const r = await fetch('/api/data', { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token ?? JSON.parse(localStorage.getItem('mk.token'))) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; }, method, body, token);
const go = async (p, r) => { await p.evaluate((r) => (location.hash = '#/' + r), r); await sleep(350); };
const txt = (p, sel) => p.$eval(sel, (e) => e.innerText).catch(() => '');
const toastText = async (p) => { await sleep(250); return txt(p, '#toast'); };
const click = async (p, sel) => { await p.waitForSelector(sel, { timeout: 8000 }); await p.click(sel); await sleep(250); };
const typeIn = async (p, sel, v) => { await p.$eval(sel, (e) => { e.focus(); e.select(); }); await p.keyboard.press('Backspace'); await sleep(150); await p.type(sel, v); };

// ---- 0. wrong PIN and role gate ----
let p = await newPage();
await p.goto(U + '/?lang=en', { waitUntil: 'networkidle0' });
await p.evaluate(() => localStorage.clear());
await p.type('#pin', '9999'); await p.keyboard.press('Enter'); await sleep(900);
ok(/Wrong PIN/.test(await txt(p, '.login')), 'wrong PIN is refused with a message');
const noTok = await p.evaluate(async () => (await fetch('/api/data')).status);
ok(noTok === 401, 'API without a token returns 401, got ' + noTok);

// ---- 1. owner baseline (reset demo so the run starts from known data) ----
await login(p, '1111');
await api(p, 'POST', { op: { type: 'reset' } });
let ov = (await api(p, 'GET')).json;
const water = ov.products[0].variants[0];
const stock0 = water.stock;
const rev0 = ov.sales.filter((s) => !s.refund).reduce((a, s) => a + s.total, 0);

// ---- 2. cashier flow ----
const c = await newPage();
await login(c, '2222');
ok((await txt(c, '.nav')).includes('Point of sale') && !/Products|Purchases|Reports|Audit/.test(await txt(c, '.nav')), 'cashier menu has only POS, My shift, Sales');
await go(c, 'products');
ok(/Point of sale|Cart/.test(await txt(c, 'main')) || (await c.evaluate(() => location.hash)) !== '#/products' || !/Unit cost|Cost/.test(await txt(c, 'main')), 'cashier cannot open the products page');
const cv = await api(c, 'GET');
ok(cv.status === 200 && !JSON.stringify(cv.json).includes('"cost"'), 'cashier API view contains no cost fields');
const forbid = await api(c, 'POST', { op: { type: 'adjust', variantId: water.id, delta: -1, reason: 'loss' } });
ok(forbid.status === 400 && /Owner only/.test(forbid.json.error), 'cashier cannot adjust stock (server says Owner only)');
const forbid2 = await api(c, 'POST', { op: { type: 'reset' } });
ok(forbid2.status === 403, 'cashier cannot reset the demo, got ' + forbid2.status);
await go(c, 'pos');
// scan barcode + Enter
await c.type('#q', water.barcode); await c.keyboard.press('Enter'); await sleep(300);
ok((await c.$$('.line')).length === 1, 'barcode scan adds the item to the cart');
await c.type('#q', 'MK-003'); await c.keyboard.press('Enter'); await sleep(300);
ok((await c.$$('.line')).length === 2, 'SKU typed in the search box adds the item');
await c.type('#q', '0000000000000'); await c.keyboard.press('Enter'); await sleep(300);
ok(/No item with that code/.test(await toastText(c)), 'unknown barcode shows a message');
await click(c, '[data-act=inc]');
ok(/2/.test(await txt(c, '.line .qty')), 'plus button raises quantity');
// discount over the cashier limit
await typeIn(c, '#dval', '15'); await sleep(300);
ok(/limit is 10%/.test(await txt(c, '.cart')) && await c.$eval('[data-act=pay]', (e) => e.disabled), 'cashier discount above 10% is blocked and Pay is disabled');
await typeIn(c, '#dval', '10'); await sleep(300);
ok(!(await c.$eval('[data-act=pay]', (e) => e.disabled)), '10% cashier discount is accepted');
const totalTxt = await txt(c, '.tot.big');
const cartTotalCents = Math.round(parseFloat(totalTxt.replace(/[^0-9.]/g, '')) * 100);
const expected = Math.round((water.price * 2 + ov.products[1].variants[0].price) * 0.9);
ok(Math.abs(cartTotalCents - expected) <= 1, `cart total with 10% off is ${cartTotalCents / 100} (expected ${expected / 100})`);
await click(c, '[data-act=pay]');
ok(await c.$eval('#payok', (e) => e.disabled), 'Confirm payment is disabled until the amount is covered');
await c.type('#pcash', String(Math.floor(cartTotalCents / 200))); await c.type('#pcard', String((cartTotalCents - Math.floor(cartTotalCents / 200) * 100) / 100));
await sleep(200);
ok(!(await c.$eval('#payok', (e) => e.disabled)), 'cash and card split covering the total enables Confirm');
await click(c, '#payok'); await sleep(900);
const rcpt = await txt(c, '.receipt');
ok(/S-\d+/.test(rcpt) && /Cash/.test(rcpt) && /Card/.test(rcpt) && /incl\. VAT/.test(rcpt), 'receipt shows sale number, cash, card and VAT');
const saleNo = (rcpt.match(/S-\d+/) || [''])[0];
await click(c, '[data-act=receipt-close]');
ov = (await api(p, 'GET')).json;
const sale = ov.sales.find((s) => s.no === saleNo);
ok(sale && sale.total === cartTotalCents && sale.pay.cash + sale.pay.card === cartTotalCents && sale.discount > 0, 'sale saved on the server with the right total, split and discount');
ok(ov.products[0].variants[0].stock === stock0 - 2, `stock of the first item dropped by 2 (${stock0} to ${ov.products[0].variants[0].stock})`);
// shift close needs a note when counts differ
await go(c, 'shift');
await typeIn(c, '#counted', '1'); await click(c, '[data-act=close-shift]');
ok(/Explain the cash difference/.test(await toastText(c)), 'closing a shift with a difference needs a note');
// Arabic and RTL
await c.goto(U + '/?lang=ar#/pos', { waitUntil: 'networkidle0' }); await sleep(500);
ok((await c.evaluate(() => document.documentElement.dir)) === 'rtl' && /نقطة البيع/.test(await txt(c, '.nav')), 'Arabic switches the page to rtl with Arabic menu');

// ---- 3. owner flows ----
await p.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await go(p, 'sales');
await typeIn(p, '#sq', saleNo); await sleep(300);
await click(p, '[data-act=view-sale]');
await typeIn(p, '#rreason', 'e2e refund'); await click(p, '[data-act=refund]'); await sleep(900);
ov = (await api(p, 'GET')).json;
ok(ov.sales.find((s) => s.no === saleNo).refund && ov.products[0].variants[0].stock === stock0, 'owner refund restores stock');
await go(p, 'stock'); await click(p, '[data-act=adjust]'); await p.type('#acount', '3'); await p.select('#areason', 'damage'); await p.keyboard.press('Enter'); await sleep(900);
ov = (await api(p, 'GET')).json;
ok(ov.movements[0].type === 'adjust' && ov.audit[0].action === 'adjust', 'adjustment appears in movements and the audit trail');
// hostile text in a product name must render as text
await go(p, 'products'); await click(p, '[data-act=new-product]');
await p.type('#pn', '<img src=x onerror=window.__pwn=1>Test <b>bold</b>'); await p.type('#pc', 'Test');
await p.type('.vrow[data-vid] [name=label]', 'One'); await p.type('.vrow[data-vid] [name=sku]', 'E2E-1'); await p.type('.vrow[data-vid] [name=price]', '12.50'); await p.type('.vrow[data-vid] [name=cost]', '8'); await p.type('.vrow[data-vid] [name=stock]', '5');
await p.keyboard.press('Enter'); await sleep(1000);
ok(await p.evaluate(() => !window.__pwn && !document.querySelector('main img[src=x]')), 'hostile HTML in a product name is shown as text, nothing runs');
ok((await txt(p, 'main')).includes('<img src=x'), 'the hostile name is visible as plain text');
await click(p, '[data-act=new-product]');
await p.type('#pn', 'Dup'); await p.type('.vrow[data-vid] [name=label]', 'x'); await p.type('.vrow[data-vid] [name=sku]', 'E2E-1'); await p.type('.vrow[data-vid] [name=price]', '1');
await p.keyboard.press('Enter'); await sleep(700);
ok(/SKU E2E-1 is already used/.test(await toastText(p)), 'duplicate SKU is refused in the UI');
await click(p, '[data-act=modal-close]');
// purchase order
await go(p, 'purchases'); await click(p, '[data-act=new-po]');
await p.type('[data-poline] [name=qty]', '10'); await sleep(100);
await p.keyboard.press('Enter'); await sleep(900);
ov = (await api(p, 'GET')).json;
const po = ov.purchases[0];
ok(po.status === 'ordered' && po.lines[0].qty === 10, 'purchase order created (cost prefilled from the item)');
const before = ov.products.flatMap((x) => x.variants).find((v) => v.id === po.lines[0].variantId).stock;
await p.click(`[data-act=po-receive][data-id="${po.id}"]`); await sleep(900);
ov = (await api(p, 'GET')).json;
ok(ov.products.flatMap((x) => x.variants).find((v) => v.id === po.lines[0].variantId).stock === before + 10, 'receiving the order adds the stock');
// CSV
await go(p, 'reports');
await p.evaluate(() => { window.__csv = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then((t) => window.__csv.push(t)); return o.call(URL, b); }; });
await click(p, '[data-act=csv-sales]'); await click(p, '[data-act=csv-report]'); await sleep(500);
const csv = await p.evaluate(() => window.__csv);
ok(csv.length === 2 && csv[0].includes('Sale,Date (Cairo)') && csv[1].includes('Total,'), 'sales and report CSV files are produced');
const kp = await txt(p, 'main');
ok(/Revenue/.test(kp) && /Profit/.test(kp), 'reports page shows revenue and profit');
// every owner page renders without error
for (const r of ['dashboard', 'pos', 'products', 'stock', 'purchases', 'sales', 'shifts', 'reports', 'audit']) { await go(p, r); ok((await txt(p, 'main')).length > 50, 'owner page ' + r + ' renders'); }

// ---- 4. same sale id twice via API saves once ----
const tok = await p.evaluate(() => JSON.parse(localStorage.getItem('mk.token')));
const mtok = (await api(p, 'POST', { op: { type: 'login', pin: '2222' } }, tok)).json.token;
const op = { type: 'sale', id: 'e2e-dup-' + Date.now(), lines: [{ variantId: water.id, qty: 1 }], payments: [{ method: 'cash', amount: water.price }] };
const r1 = await api(p, 'POST', { op }, mtok), r2 = await api(p, 'POST', { op }, mtok);
ov = (await api(p, 'GET')).json;
ok(r1.status === 200 && r2.status === 200 && r2.json.result.duplicate && ov.sales.filter((s) => s.id === op.id).length === 1, 'the same sale sent twice is stored once');

// leave demo clean
await api(p, 'POST', { op: { type: 'reset' } });
ok(errs.length === 0, 'no console or page errors (' + errs.slice(0, 3).join(' | ') + ')');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
