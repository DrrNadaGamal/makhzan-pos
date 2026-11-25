// Takes the screenshots used in the README and the case study. Usage: node e2e/shots.mjs <url> <outdir>
import puppeteer from 'puppeteer-core';
const U = process.argv[2] || 'http://localhost:3100', out = (process.argv[3] || '/tmp/e2e/').replace(/\/?$/, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const errs = [];
async function session(pin, lang, w, h, fn) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1 });
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' }); await p.type('#pin', pin); await p.keyboard.press('Enter'); await p.waitForSelector('.top'); await sleep(500);
  await fn(p); await ctx.close();
}
const go = async (p, r) => { await p.evaluate((r) => (location.hash = '#/' + r), r); await sleep(500); };
const shot = (p, n, full) => p.screenshot({ path: out + n + '.png', fullPage: !!full });
const fillCart = async (p) => { for (const code of ['MK-001', 'MK-005', 'MK-010', 'MK-007']) { await p.type('#q', code); await p.keyboard.press('Enter'); await sleep(250); } await p.click('[data-act=inc]'); await sleep(200); await p.$eval('#dval', (e) => e.focus()); await p.type('#dval', '5'); await sleep(300); await p.$eval('#dval', (e) => e.blur()); await sleep(100); };
await session('2222', 'en', 1440, 900, async (p) => { await fillCart(p); await shot(p, 'pos-en'); await p.click('[data-act=pay]'); await sleep(300); await p.click('[data-act=q-cash]'); await sleep(200); await shot(p, 'pay-en'); });
await session('2222', 'ar', 1440, 900, async (p) => { await fillCart(p); await shot(p, 'pos-ar'); });
await session('2222', 'ar', 390, 844, async (p) => { await fillCart(p); await p.evaluate(() => window.scrollTo(0, 99999)); await sleep(300); await shot(p, 'pos-mobile-ar'); });
await session('1111', 'en', 1440, 1000, async (p) => {
  await shot(p, 'dashboard');
  await go(p, 'stock'); await shot(p, 'stock');
  await go(p, 'products'); await shot(p, 'products');
  await go(p, 'purchases'); await shot(p, 'purchases');
  await go(p, 'shifts'); await shot(p, 'shifts');
  await go(p, 'reports'); await shot(p, 'reports');
  await go(p, 'sales'); await sleep(300); await p.click('[data-act=view-sale]'); await sleep(300); await shot(p, 'sale-receipt');
});
await session('1111', 'ar', 1440, 1000, async (p) => { await shot(p, 'dashboard-ar'); await go(p, 'stock'); await shot(p, 'stock-ar'); });
console.log('errors:', errs);
await b.close();
