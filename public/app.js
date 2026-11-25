import * as L from './logic.js';
import { T } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('mk.' + k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem('mk.' + k, JSON.stringify(v)), del: (k) => localStorage.removeItem('mk.' + k) };

const S = {
  lang: new URLSearchParams(location.search).get('lang') || LS.get('lang', 'en'),
  token: LS.get('token', null), me: LS.get('me', null), view: LS.get('view', null),
  queue: LS.get('queue', []), rejected: LS.get('rejected', []),
  offline: false, cart: [], disc: { type: 'pct', value: '' }, q: '', cat: '', modal: null, receipt: null, busy: false,
  stockLow: false, stockTab: 'levels', range: 7, saleQ: '', prodQ: '', err: '',
};
if (!T[S.lang]) S.lang = 'en';
const t = (k) => T[S.lang][k] ?? T.en[k] ?? k;
const ar = () => S.lang === 'ar';
const loc = () => (ar() ? 'ar-EG' : 'en-GB');
const nf = (n, d = 0) => Number(n).toLocaleString(ar() ? 'ar-EG' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (c) => `${nf(c / 100, 2)} ${t('cur')}`;
const when = (ts) => new Date(ts).toLocaleString(loc(), { timeZone: L.TZ, hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const nm = (o) => (ar() ? o.nameAr || o.name : o.name);
const lb = (o) => (ar() ? o.labelAr || o.label : o.label);
const cat = (p) => (ar() ? p.categoryAr : p.category);
const toCents = (s) => { const n = parseFloat(String(s ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
const toast = (m, bad) => { const el = $('#toast'); el.innerHTML = `<div class="${bad ? 'err' : ''}">${esc(m)}</div>`; clearTimeout(toast.h); toast.h = setTimeout(() => (el.innerHTML = ''), bad ? 5000 : 2600); };
const isOwner = () => S.me?.role === 'owner';
const persist = () => { LS.set('queue', S.queue); LS.set('rejected', S.rejected); if (S.view) LS.set('view', S.view); };

// ---------- network ----------
class NetError extends Error {}
async function call(method, body) {
  let r;
  try {
    r = await fetch('/api/data', { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch { throw new NetError('offline'); }
  let j = {};
  try { j = await r.json(); } catch { if (r.status >= 500) throw new NetError('server'); }
  if (r.status === 401 && S.token) { logout(true); throw new Error(j.error || 'Sign in again'); }
  if (r.status >= 500) throw new NetError('server');
  if (!r.ok) throw Object.assign(new Error(j.error || 'Error'), { user: true });
  return j;
}
function setView(v) { const { result, ...rest } = v; S.view = rest; S.offline = false; persist(); return result; }
async function refresh(quiet) {
  if (!S.token) return;
  try { setView(await call('GET')); } catch (e) { if (e instanceof NetError) S.offline = true; else if (!quiet) toast(e.message, true); }
  if (!quiet || !busyUI()) render();
}
const busyUI = () => S.modal || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.id !== 'q';
async function act(op, okMsg) {
  if (S.busy) return null;
  S.busy = true;
  try { const r = setView(await call('POST', { op })); if (okMsg) toast(okMsg); return r || {}; }
  catch (e) { if (e instanceof NetError) { S.offline = true; toast(t('offline'), true); } else toast(e.message, true); return null; }
  finally { S.busy = false; render(); }
}
async function login(pin) {
  try {
    const j = await call('POST', { op: { type: 'login', pin } });
    S.token = j.token; S.me = j.me; LS.set('token', S.token); LS.set('me', S.me);
    S.cart = []; S.err = '';
    location.hash = j.me.role === 'owner' ? '#/dashboard' : '#/pos';
    await refresh();
  } catch (e) { S.err = e instanceof NetError ? t('offline') : e.message; render(); }
}
function logout(expired) {
  for (const k of ['token', 'me', 'view']) LS.del(k);
  S.token = S.me = S.view = null; S.cart = []; S.modal = null; S.receipt = null;
  if (expired) S.err = 'Sign in again';
  render();
}

// ---------- offline queue ----------
function localApplySale(op, pseudo) {
  for (const l of op.lines) { const f = L.findVariant(S.view, l.variantId); if (f) f.v.stock -= l.qty; }
  if (S.view.mySales) S.view.mySales.unshift(pseudo);
  if (S.view.myShiftTotals) { S.view.myShiftTotals.cashSales += pseudo.pay.cashNet; S.view.myShiftTotals.cardSales += pseudo.pay.card; S.view.myShiftTotals.count++; S.view.myShiftTotals.expected += pseudo.pay.cashNet; }
}
async function sync() {
  if (sync.on || !S.queue.length || !S.token) return;
  sync.on = true;
  try {
    while (S.queue.length) {
      const op = S.queue[0];
      try { setView(await call('POST', { op })); S.queue.shift(); }
      catch (e) {
        if (e instanceof NetError) { S.offline = true; break; }
        if (e.user) { S.rejected.push({ id: op.id, t: op.t, msg: e.message, total: op.pseudoTotal || 0 }); S.queue.shift(); toast(e.message, true); } else break;
      }
      persist();
    }
  } finally { sync.on = false; persist(); if (!S.queue.length && !S.offline) await refresh(true); else render(); }
}

// ---------- pos logic ----------
const prodState = () => ({ products: S.view.products });
function cartInfo() {
  const lines = S.cart.map((c) => { const f = L.findVariant(prodState(), c.variantId); return f ? { ...c, p: f.p, v: f.v, price: f.v.price } : null; }).filter(Boolean);
  const value = parseFloat(String(S.disc.value).replace(',', '.')) || 0;
  const disc = S.disc.type === 'amt' ? { type: 'amt', value: Math.round(value * 100) } : { type: 'pct', value };
  try { return { lines, ...L.priceSale({ lines, discount: value ? disc : null }, { role: S.me.role, rate: S.view.settings.vat }), disc: value ? disc : null }; }
  catch (e) { const sub = lines.reduce((a, l) => a + l.price * l.qty, 0); return { lines, subtotal: sub, discount: 0, total: sub, vat: 0, disc: null, error: e.message }; }
}
function addToCart(vid) {
  const f = L.findVariant(prodState(), vid); if (!f) return;
  const c = S.cart.find((x) => x.variantId === vid);
  const have = c ? c.qty : 0;
  if (f.v.stock <= have) return toast(`${nm(f.p)} ${lb(f.v)}: ${t('outOfStock')}`, true);
  if (c) c.qty++; else S.cart.push({ variantId: vid, qty: 1 });
  render();
}
function search() {
  const q = S.q.trim().toLowerCase();
  return S.view.products.filter((p) => p.active).flatMap((p) => p.variants.map((v) => ({ p, v }))).filter(({ p, v }) => (!S.cat || p.category === S.cat) && (!q || [p.name, p.nameAr, v.label, v.labelAr, v.sku, v.barcode].some((x) => String(x).toLowerCase().includes(q))));
}
function buildSaleOp(pays) {
  const info = cartInfo();
  return { type: 'sale', id: (crypto.randomUUID ? crypto.randomUUID() : 'sale-' + Date.now() + Math.random().toString(36).slice(2)), lines: info.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, price: l.price })), discount: info.disc, payments: pays };
}
async function submitSale() {
  const cash = toCents($('#pcash')?.value), card = toCents($('#pcard')?.value);
  const pays = [...(cash ? [{ method: 'cash', amount: cash }] : []), ...(card ? [{ method: 'card', amount: card }] : [])];
  const info = cartInfo();
  try { L.checkPayments(pays, info.total); } catch (e) { return toast(e.message, true); }
  const op = buildSaleOp(pays);
  if (!S.offline) {
    if (S.busy) return; S.busy = true;
    try {
      const r = setView(await call('POST', { op }));
      done(r.sale, false); return;
    } catch (e) {
      if (!(e instanceof NetError)) { toast(e.message, true); return; }
      S.offline = true;
    } finally { S.busy = false; }
  }
  queueSale(op, info);
}
function queueSale(op, info) {
  const now = Date.now();
  const q = { ...op, offline: true, t: now, shiftId: S.view.myShift?.id || null, pseudoTotal: info.total };
  const pay = L.checkPayments(op.payments, info.total);
  const pseudo = { id: op.id, no: '...', t: now, cashierName: S.me.name, lines: info.lines.map((l) => ({ name: l.p.name, nameAr: l.p.nameAr, label: l.v.label, labelAr: l.v.labelAr, qty: l.qty, price: l.price })), subtotal: info.subtotal, discount: info.discount, total: info.total, vat: info.vat, pay, pending: true, flags: [], refund: null };
  S.queue.push(q); localApplySale(q, pseudo); persist();
  done(pseudo, true);
}
function done(sale, offline) {
  S.cart = []; S.disc = { type: 'pct', value: '' }; S.modal = null; S.receipt = sale; S.q = '';
  toast(offline ? t('savedOffline') : t('saved'));
  render();
}

// ---------- html helpers ----------
const field = (id, label, val = '', extra = '') => `<div class="f"><label for="${id}">${esc(label)}</label><input id="${id}" value="${esc(val)}" ${extra}></div>`;
const num = (c) => (c / 100).toFixed(2);

function receiptHtml(s) {
  const st = S.view.settings;
  return `<div class="receipt"><h3>${esc(ar() ? st.shopAr : st.shop)}</h3><div class="c">${esc(s.no)} · ${esc(when(s.t))}</div><div class="c">${esc(t('cashier'))}: ${esc(s.cashierName)}</div><hr>
  ${s.lines.map((l) => `<div class="r"><span>${nf(l.qty)} × ${esc(nm(l))} ${esc(lb(l))}</span><span>${nf((l.price * l.qty) / 100, 2)}</span></div>`).join('')}<hr>
  <div class="r"><span>${t('subtotal')}</span><span>${nf(s.subtotal / 100, 2)}</span></div>
  ${s.discount ? `<div class="r"><span>${t('discount')}</span><span>-${nf(s.discount / 100, 2)}</span></div>` : ''}
  <div class="r"><b>${t('total')}</b><b>${money(s.total)}</b></div>
  <div class="r"><span>${t('vatIn')} ${nf(st.vat)}%</span><span>${nf(s.vat / 100, 2)}</span></div><hr>
  ${s.pay.cash ? `<div class="r"><span>${t('cash')}</span><span>${nf(s.pay.cash / 100, 2)}</span></div>` : ''}${s.pay.card ? `<div class="r"><span>${t('card')}</span><span>${nf(s.pay.card / 100, 2)}</span></div>` : ''}${s.pay.change ? `<div class="r"><span>${t('change')}</span><span>${nf(s.pay.change / 100, 2)}</span></div>` : ''}
  ${s.refund ? `<hr><div class="c"><b>${t('refunded')}</b></div>` : ''}${s.pending ? `<hr><div class="c">${t('pending')}</div>` : ''}</div>`;
}
const flagTags = (s) => (s.flags || []).map((f) => `<span class="tag">${esc(T[S.lang].flag[f] || f)}</span>`).join('');

// ---------- pages ----------
function loginPage() {
  const users = [['Owner', 'owner', '1111'], ['Mona', 'cashier', '2222'], ['Karim', 'cashier', '3333']];
  return `<div class="login"><div class="card"><div class="logo">${logo()}<div><h1>Makhzan · مخزن</h1><div style="color:var(--ink2)">${ar() ? 'مخزون ونقطة بيع للمحلات الصغيرة' : 'Inventory and point of sale for small shops'}</div></div></div>
  <form data-form="login"><div class="f"><label for="pin">${t('pin')}</label><input id="pin" inputmode="numeric" autocomplete="off" maxlength="8" autofocus></div>${S.err ? `<div class="notice bad">${esc(S.err)}</div>` : ''}<button class="btn pri" style="width:100%">${t('signin')}</button></form>
  <p style="color:var(--ink2);font-size:.85rem">${t('demoNote')}</p>
  <div class="demo-users">${users.map(([n, r, p]) => `<button class="btn" data-act="quick-login" data-pin="${p}"><span>${esc(n)} · ${t(r)}</span><span>${p}</span></button>`).join('')}</div>
  <button class="btn sm" data-act="lang">${t('other')}</button></div></div>`;
}
const logo = () => '<svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f3d3a"/><path d="M14 44V22l18-8 18 8v22l-18 8z" fill="none" stroke="#f5b942" stroke-width="3.5" stroke-linejoin="round"/><path d="M14 22l18 8 18-8M32 30v22" fill="none" stroke="#f5b942" stroke-width="3.5" stroke-linejoin="round"/></svg>';

function shell(body, route) {
  const own = isOwner();
  const links = own ? ['dashboard', 'pos', 'products', 'stock', 'purchases', 'sales', 'shifts', 'reports', 'audit'] : ['pos', 'shift', 'sales'];
  const pend = S.queue.length;
  return `<header class="top"><div class="brand">${logo()}<div>Makhzan<small>${esc(ar() ? S.view.settings.shopAr : S.view.settings.shop)}</small></div></div>
  <nav class="nav">${links.map((l) => `<a href="#/${l}" class="${route === l ? 'on' : ''}">${t(l)}</a>`).join('')}</nav>
  <div class="tools"><span class="pill ${S.offline ? 'off' : ''}" id="netpill">${S.offline ? t('offline') : t('online')}${pend ? ` · ${nf(pend)} ${t('pending')}` : ''}</span><span>${esc(S.me.name === 'Owner' ? t('owner') : S.me.name + ' (' + t(S.me.role) + ')')}</span><button class="btn sm ghost" data-act="lang">${t('other')}</button><button class="btn sm ghost" data-act="logout">${t('logout')}</button></div></header>
  <main>${S.rejected.length ? `<div class="notice bad"><b>${t('rejected')}</b>${S.rejected.map((r) => `<div>${esc(when(r.t))}: ${esc(r.msg)} <button class="btn sm" data-act="dismiss-rej" data-id="${esc(r.id)}">OK</button></div>`).join('')}</div>` : ''}${body}</main>`;
}

function posPage() {
  const sh = S.view.myShift;
  const info = cartInfo();
  const cats = [...new Set(S.view.products.filter((p) => p.active).map((p) => p.category))];
  const res = search();
  const tiles = res.map(({ p, v }) => `<button class="tile ${v.stock <= 0 ? 'out' : ''}" data-act="add" data-v="${esc(v.id)}" ${v.stock <= 0 ? 'disabled' : ''}><b>${esc(nm(p))}</b><span class="v">${esc(lb(v))}</span><span class="p">${money(v.price)}</span><span class="s">${v.stock <= 0 ? t('outOfStock') : `${nf(v.stock)} ${t('left')}`}</span></button>`).join('');
  const cartHtml = info.lines.length ? info.lines.map((l) => `<div class="line"><div class="nm">${esc(nm(l.p))}<small>${esc(lb(l.v))} · ${money(l.price)}</small></div><div class="qty"><button data-act="dec" data-v="${esc(l.variantId)}" aria-label="-">−</button><span>${nf(l.qty)}</span><button data-act="inc" data-v="${esc(l.variantId)}" aria-label="+">+</button></div><b>${nf((l.price * l.qty) / 100, 2)}</b></div>`).join('') : `<div class="empty">${t('cartEmpty')}</div>`;
  return `<div class="pos"><section>
  <div class="bar"><input id="q" class="sp" style="flex:1;font-size:1.05rem" placeholder="${esc(t('search'))}" value="${esc(S.q)}" autocomplete="off"></div>
  <div class="cats"><button class="chip ${S.cat ? '' : 'on'}" data-act="cat" data-c="">${t('all')}</button>${cats.map((c) => `<button class="chip ${S.cat === c ? 'on' : ''}" data-act="cat" data-c="${esc(c)}">${esc(cat(S.view.products.find((p) => p.category === c)))}</button>`).join('')}</div>
  <div class="tiles">${tiles || `<div class="empty">${t('notFound')}</div>`}</div><p style="color:var(--ink2);font-size:.8rem">${t('hint')}</p></section>
  <aside class="card cart"><h2>${t('cart')}</h2>
  ${sh ? `<div style="font-size:.8rem;color:var(--ink2)">${t('shift')}: ${t('since')} ${esc(when(sh.openedAt))}</div>` : `<div class="notice">${t('noShift')}<div class="row" style="margin-top:.5rem"><input id="open-cash" inputmode="decimal" placeholder="${esc(t('openingCash'))}"><button class="btn pri" data-act="open-shift">${t('openShift')}</button></div></div>`}
  <div class="lines">${cartHtml}</div>
  <label>${t('discount')}</label><div class="drow"><input id="dval" inputmode="decimal" value="${esc(S.disc.value)}" placeholder="0"><select id="dtype"><option value="pct" ${S.disc.type === 'pct' ? 'selected' : ''}>${t('pct')}</option><option value="amt" ${S.disc.type === 'amt' ? 'selected' : ''}>${t('amt')}</option></select><button class="btn" data-act="clear">${t('clear')}</button></div>
  ${info.error ? `<div class="notice bad" style="margin-top:.5rem">${esc(info.error)}</div>` : ''}
  <div class="tot" style="margin-top:.6rem"><span>${t('subtotal')}</span><span>${money(info.subtotal)}</span></div>${info.discount ? `<div class="tot"><span>${t('discount')}</span><span>-${money(info.discount)}</span></div>` : ''}
  <div class="tot big"><span>${t('total')}</span><span>${money(info.total)}</span></div><div class="tot" style="color:var(--ink2);font-size:.82rem"><span>${t('vatIn')}</span><span>${money(info.vat)}</span></div>
  <button class="btn pri" style="width:100%;margin-top:.6rem;padding:.8rem;font-size:1.05rem" data-act="pay" ${!info.lines.length || !sh || info.error ? 'disabled' : ''}>${t('pay')} ${money(info.total)}</button></aside></div>`;
}

function payModal() {
  const info = cartInfo();
  return `<div class="modal"><h2>${t('pay')}</h2><div style="font-size:1.6rem;font-weight:700">${t('due')}: ${money(info.total)}</div>
  <div class="quick"><button class="btn sm" data-act="q-exact">${t('exact')}</button><button class="btn sm" data-act="q-card">${t('fullCard')}</button>${[50, 100, 200].map((n) => `<button class="btn sm" data-act="q-cash" data-n="${n}">${nf(n)}</button>`).join('')}</div>
  <div class="row"><div class="f"><label for="pcash">${t('cash')}</label><input id="pcash" inputmode="decimal" autofocus></div><div class="f"><label for="pcard">${t('card')}</label><input id="pcard" inputmode="decimal"></div></div>
  <div id="paychange" class="change short"></div><div class="acts"><button class="btn" data-act="modal-close">${t('cancel')}</button><button class="btn pri" id="payok" data-act="confirm-pay">${t('confirm')}</button></div></div>`;
}
const fillCosts = () => document.querySelectorAll('[data-poline]').forEach((r) => { const c = r.querySelector('[name=cost]'); if (!c.value) c.value = r.querySelector('[name=v]').selectedOptions[0].dataset.cost; });
function updatePay() {
  const info = cartInfo(), cash = toCents($('#pcash')?.value), card = toCents($('#pcard')?.value), el = $('#paychange'); if (!el) return;
  const paid = cash + card, ok = paid >= info.total && card <= info.total && paid - info.total <= cash;
  el.className = 'change' + (paid < info.total ? ' short' : '');
  el.textContent = paid < info.total ? `${t('short')}: ${money(info.total - paid)}` : card > info.total ? t('card') + ' > ' + t('total') : `${t('change')}: ${money(paid - info.total)}`;
  $('#payok').disabled = !(ok && paid > 0);
}

function shiftPage() {
  const sh = S.view.myShift, tt = S.view.myShiftTotals;
  if (!sh) return `<div class="card"><h1>${t('shift')}</h1><div class="notice">${t('noShift')}</div><div class="f"><label for="open-cash">${t('openingCash')}</label><input id="open-cash" inputmode="decimal"></div><button class="btn pri" data-act="open-shift">${t('openShift')}</button></div>`;
  return `<div class="card" style="max-width:640px"><h1>${t('shift')}</h1><p>${t('since')} ${esc(when(sh.openedAt))}</p>
  <table><tr><td>${t('opening')}</td><td class="num">${money(sh.opening)}</td></tr><tr><td>${t('salesCount')}</td><td class="num">${nf(tt.count)}</td></tr><tr><td>${t('cashSales')}</td><td class="num">${money(tt.cashSales)}</td></tr><tr><td>${t('cardSales')}</td><td class="num">${money(tt.cardSales)}</td></tr><tr><td>${t('refundsOut')}</td><td class="num">${money(tt.cashRefunds)}</td></tr><tr><th>${t('expected')}</th><th class="num">${money(tt.expected)}</th></tr></table>
  ${S.queue.length ? `<div class="notice" style="margin-top:.7rem">${nf(S.queue.length)} ${t('pending')}</div>` : ''}
  <h2 style="margin-top:1rem">${t('closeShift')}</h2><div class="f"><label for="counted">${t('counted')}</label><input id="counted" inputmode="decimal"></div><div class="f"><label for="cnote">${t('note')}</label><input id="cnote" maxlength="200"></div><button class="btn pri" data-act="close-shift" ${S.queue.length ? 'disabled' : ''}>${t('closeShift')}</button></div>`;
}

const dayKeys = (n) => Array.from({ length: n }, (_, i) => L.dayKey(S.view.now - (n - 1 - i) * 86400000));
function chart2(rep, n) {
  const keys = dayKeys(n), max = Math.max(1, ...keys.map((k) => rep.byDay[k]?.gross || 0));
  return `<div class="charts" role="img" aria-label="${esc(t('revenue'))}">${keys.map((k) => { const d = rep.byDay[k] || { gross: 0, profit: 0 }; return `<div class="col" title="${esc(k)}: ${esc(money(d.gross))}"><div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;height:100%"><div class="b" style="height:${(d.gross / max) * 100}%;position:relative"><div class="b p" style="position:absolute;bottom:0;height:${d.gross ? (d.profit / d.gross) * 100 : 0}%;border-radius:0"></div></div></div><small>${nf(Number(k.slice(8)))}</small></div>`; }).join('')}</div><div class="legend"><span><i style="background:var(--teal)"></i>${t('revenue')}</span><span><i style="background:var(--amber)"></i>${t('profit')}</span></div>`;
}
const rangeOf = (n) => [L.dayStart(S.view.now - (n - 1) * 86400000), S.view.now + 1];

function dashboardPage() {
  const v = S.view, [f0, t0] = rangeOf(1), td = L.salesReport(v, f0, t0), r14 = L.salesReport(v, ...rangeOf(14));
  const low = L.lowStock(v), flagged = v.sales.filter((s) => s.flags.length && !s.refund).slice(-8).reverse();
  const open = v.shifts.filter((s) => !s.closedAt), po = v.purchases.filter((p) => p.status === 'ordered');
  return `<h1>${t('dashboard')}</h1><div class="grid kpis" style="margin-bottom:1rem">
  ${[[t('today') + ' · ' + t('revenue'), money(td.gross)], [t('today') + ' · ' + t('count'), nf(td.count)], [t('today') + ' · ' + t('profit'), money(td.profit)], [t('avgTicket'), money(td.avgTicket)], [t('last14') + ' · ' + t('profit'), `${money(r14.profit)} (${nf(r14.margin * 100, 0)}%)`]].map(([l, n]) => `<div class="card kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
  <div class="grid two"><div class="card"><h2>${t('last14')}</h2>${chart2(r14, 14)}</div>
  <div class="card"><h2>${t('lowStock')} <span class="pill bad">${nf(low.length)}</span></h2>${low.length ? `<table>${low.slice(0, 8).map(({ p, v }) => `<tr><td>${esc(nm(p))} <span style="color:var(--ink2)">${esc(lb(v))}</span></td><td class="num"><b style="color:var(--red)">${nf(v.stock)}</b> / ${nf(v.reorder)}</td></tr>`).join('')}</table><a href="#/stock" data-act="low-link">${t('stock')} →</a>` : `<div class="empty">${t('nothing')}</div>`}</div>
  <div class="card"><h2>${t('topSellers')}</h2><table>${r14.top.slice(0, 6).map((i) => `<tr><td>${esc(nm(i))} <span style="color:var(--ink2)">${esc(lb(i))}</span></td><td class="num">${nf(i.qty)}</td><td class="num">${money(i.revenue)}</td></tr>`).join('')}</table></div>
  <div class="card"><h2>${t('needsReview')}</h2>${flagged.length ? `<table>${flagged.map((s) => `<tr><td>${esc(s.no)}</td><td>${flagTags(s)}</td><td class="num">${money(s.total)}</td></tr>`).join('')}</table>` : `<div class="empty">${t('nothing')}</div>`}
  <h3 style="margin-top:.8rem">${t('openTills')}</h3>${open.length ? open.map((s) => `<div>${esc(s.cashierName)} · ${t('since')} ${esc(when(s.openedAt))} · ${money(s.cashSales + s.cardSales)}</div>`).join('') : `<div class="empty">${t('nothing')}</div>`}
  <h3 style="margin-top:.8rem">${t('pendingPOs')}</h3>${po.length ? po.map((p) => `<div>${esc(p.no)} · ${esc(p.supplierName)} · ${money(p.total)}</div>`).join('') : `<div class="empty">${t('nothing')}</div>`}</div></div>
  <p style="color:var(--ink2);font-size:.85rem;margin-top:1rem">${t('resetNote')} <button class="btn sm" data-act="reset-demo">${t('resetNow')}</button></p>`;
}

function productsPage() {
  const q = S.prodQ.toLowerCase();
  const rows = S.view.products.flatMap((p) => p.variants.map((v, i) => ({ p, v, i }))).filter(({ p, v }) => !q || [p.name, p.nameAr, v.label, v.sku, v.barcode].some((x) => String(x).toLowerCase().includes(q)));
  return `<div class="bar"><h1 style="margin:0">${t('products')}</h1><input id="pq" placeholder="${esc(t('search'))}" value="${esc(S.prodQ)}"><span class="sp"></span><button class="btn pri" data-act="new-product">${t('newProduct')}</button></div>
  <div class="tw"><table><thead><tr><th>${t('product')}</th><th>${t('variant')}</th><th>${t('sku')}</th><th>${t('barcode')}</th><th class="num">${t('price')}</th><th class="num">${t('cost')}</th><th class="num">${t('inStock')}</th><th>${t('status')}</th><th></th></tr></thead><tbody>
  ${rows.map(({ p, v, i }) => `<tr><td>${i === 0 ? `<b>${esc(nm(p))}</b><div style="font-size:.78rem;color:var(--ink2)">${esc(cat(p))}</div>` : ''}</td><td>${esc(lb(v))}</td><td>${esc(v.sku)}</td><td>${esc(v.barcode)}</td><td class="num">${money(v.price)}</td><td class="num">${money(v.cost)}</td><td class="num">${nf(v.stock)}</td><td>${i === 0 ? `<span class="tag ${p.active ? 'ok' : ''}">${p.active ? t('active') : t('archived')}</span>` : ''}</td><td>${i === 0 ? `<button class="btn sm" data-act="edit-product" data-id="${esc(p.id)}">${t('edit')}</button> <button class="btn sm" data-act="toggle-product" data-id="${esc(p.id)}">${p.active ? t('archive') : t('restore')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function productModal(p) {
  const vs = p ? p.variants : [{ sku: '', barcode: '', label: '', labelAr: '', price: 0, cost: 0, reorder: 5, stock: 0, isNew: true }];
  return `<div class="modal wide"><h2>${p ? t('edit') : t('newProduct')}</h2><form data-form="product" data-id="${esc(p?.id || '')}">
  <div class="row">${field('pn', t('nameEn'), p?.name)}${field('pna', t('nameAr'), p?.nameAr)}</div><div class="row">${field('pc', t('catEn'), p?.category)}${field('pca', t('catAr'), p?.categoryAr)}</div>
  <div class="vrow vh"><span>${t('labelEn')}</span><span>${t('labelAr')}</span><span>${t('sku')}</span><span>${t('barcode')}</span><span>${t('price')}</span><span>${t('cost')}</span><span>${t('reorder')}</span><span>${t('openStock')}</span></div>
  <div id="vrows">${vs.map((v) => vrow(v)).join('')}</div><button type="button" class="btn sm" data-act="add-vrow">${t('addVariant')}</button>
  <div class="acts"><button type="button" class="btn" data-act="modal-close">${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form></div>`;
}
const vrow = (v) => `<div class="vrow" data-vid="${esc(v.id || '')}"><input name="label" value="${esc(v.label)}" required><input name="labelAr" value="${esc(v.labelAr || '')}"><input name="sku" value="${esc(v.sku)}" required><input name="barcode" value="${esc(v.barcode)}" inputmode="numeric"><input name="price" inputmode="decimal" value="${v.price ? num(v.price) : ''}" required><input name="cost" inputmode="decimal" value="${v.cost || v.cost === 0 ? num(v.cost) : ''}"><input name="reorder" inputmode="numeric" value="${v.reorder}"><input name="stock" inputmode="numeric" value="${v.id ? v.stock : v.stock || 0}" ${v.id ? 'disabled' : ''}></div>`;
function readProduct(form) {
  const g = (id) => form.querySelector('#' + id).value;
  return { type: 'product.save', id: form.dataset.id || undefined, name: g('pn'), nameAr: g('pna'), category: g('pc'), categoryAr: g('pca'),
    variants: [...form.querySelectorAll('.vrow[data-vid]')].map((r) => { const f = (n) => r.querySelector(`[name=${n}]`).value; return { id: r.dataset.vid || undefined, label: f('label'), labelAr: f('labelAr'), sku: f('sku'), barcode: f('barcode'), price: toCents(f('price')), cost: toCents(f('cost')), reorder: parseInt(f('reorder'), 10) || 0, stock: parseInt(f('stock'), 10) || 0 }; }) };
}

function stockPage() {
  const v = S.view; let rows = L.allVariants(v).filter(({ p }) => p.active); if (S.stockLow) rows = rows.filter(({ v }) => v.stock <= v.reorder);
  const mt = { sale: t('mSale'), purchase: t('mPurchase'), adjust: t('mAdjust'), refund: t('mRefund'), opening: t('mOpening') };
  const vname = (id) => { const f = L.findVariant(v, id); return f ? `${nm(f.p)} ${lb(f.v)}` : id; };
  const tabs = `<div class="cats"><button class="chip ${S.stockTab === 'levels' ? 'on' : ''}" data-act="stab" data-s="levels">${t('levels')}</button><button class="chip ${S.stockTab === 'moves' ? 'on' : ''}" data-act="stab" data-s="moves">${t('movements')}</button></div>`;
  if (S.stockTab === 'moves') return `<div class="bar"><h1 style="margin:0">${t('stock')}</h1></div>${tabs}<div class="tw"><table><thead><tr><th>${t('time')}</th><th>${t('product')}</th><th>${t('type')}</th><th class="num">${t('qty')}</th><th class="num">${t('after')}</th><th>${t('ref')}</th><th>${t('by')}</th></tr></thead><tbody>${v.movements.map((m) => `<tr><td>${esc(when(m.t))}</td><td>${esc(vname(m.variantId))}</td><td>${esc(mt[m.type] || m.type)}${m.reason ? ` <span style="color:var(--ink2)">(${esc(m.reason)})</span>` : ''}</td><td class="num" style="color:${m.qty < 0 ? 'var(--red)' : '#0b5c4b'}">${m.qty > 0 ? '+' : ''}${nf(m.qty)}</td><td class="num">${nf(m.after)}</td><td>${esc(m.ref)}</td><td>${esc(m.by)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="bar"><h1 style="margin:0">${t('stock')}</h1><label style="margin:0;display:flex;gap:.3rem;align-items:center"><input type="checkbox" id="lowonly" ${S.stockLow ? 'checked' : ''}> ${t('lowOnly')}</label><span class="sp"></span><button class="btn" data-act="csv-stock">${t('csvStock')}</button></div>${tabs}
  <div class="tw"><table><thead><tr><th>${t('product')}</th><th>${t('variant')}</th><th>${t('sku')}</th><th class="num">${t('inStock')}</th><th class="num">${t('reorder')}</th><th class="num">${t('value')}</th><th></th></tr></thead><tbody>
  ${rows.map(({ p, v }) => `<tr class="${v.stock <= v.reorder ? 'low' : ''}"><td>${esc(nm(p))}</td><td>${esc(lb(v))}</td><td>${esc(v.sku)}</td><td class="num"><b>${nf(v.stock)}</b> ${v.stock <= 0 ? `<span class="tag red">${t('outOfStock')}</span>` : v.stock <= v.reorder ? `<span class="tag">${t('lowStock')}</span>` : ''}</td><td class="num">${nf(v.reorder)}</td><td class="num">${money(Math.max(0, v.stock) * v.cost)}</td><td><button class="btn sm" data-act="adjust" data-v="${esc(v.id)}">${t('adjust')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function adjustModal(vid) {
  const f = L.findVariant(S.view, vid);
  return `<div class="modal"><h2>${t('adjust')}: ${esc(nm(f.p))} ${esc(lb(f.v))}</h2><p>${t('inStock')}: <b>${nf(f.v.stock)}</b></p><form data-form="adjust" data-v="${esc(vid)}">
  <div class="f"><label for="acount">${t('newCount')}</label><input id="acount" inputmode="numeric" required autofocus></div>
  <div class="f"><label for="areason">${t('reason')}</label><select id="areason">${[['count', 'rCount'], ['damage', 'rDamage'], ['expired', 'rExpired'], ['loss', 'rLoss'], ['found', 'rFound']].map(([v, k]) => `<option value="${v}">${t(k)}</option>`).join('')}</select></div>
  <div class="acts"><button type="button" class="btn" data-act="modal-close">${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form></div>`;
}

function purchasesPage() {
  const v = S.view, stT = { ordered: t('ordered'), received: t('received'), cancelled: t('cancelled') };
  return `<div class="bar"><h1 style="margin:0">${t('purchases')}</h1><span class="sp"></span><button class="btn" data-act="new-supplier">${t('newSupplier')}</button><button class="btn pri" data-act="new-po">${t('newPO')}</button></div>
  <div class="grid two"><div><h2>${t('orders')}</h2><div class="tw"><table><thead><tr><th>#</th><th>${t('supplier')}</th><th>${t('time')}</th><th class="num">${t('total')}</th><th>${t('status')}</th><th></th></tr></thead><tbody>${v.purchases.map((p) => `<tr><td>${esc(p.no)}</td><td>${esc(p.supplierName)}</td><td>${esc(when(p.createdAt))}</td><td class="num">${money(p.total)}</td><td><span class="tag ${p.status === 'received' ? 'ok' : p.status === 'cancelled' ? 'red' : ''}">${stT[p.status]}</span></td><td>${p.status === 'ordered' ? `<button class="btn sm pri" data-act="po-receive" data-id="${esc(p.id)}">${t('receive')}</button> <button class="btn sm danger" data-act="po-cancel" data-id="${esc(p.id)}">${t('cancel')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>
  <div><h2>${t('suppliers')}</h2><div class="tw"><table><thead><tr><th>${t('name')}</th><th>${t('phone')}</th><th>${t('note')}</th><th></th></tr></thead><tbody>${v.suppliers.map((s) => `<tr><td>${esc(s.name)}</td><td dir="ltr">${esc(s.phone)}</td><td>${esc(s.note)}</td><td><button class="btn sm" data-act="edit-supplier" data-id="${esc(s.id)}">${t('edit')}</button></td></tr>`).join('')}</tbody></table></div></div></div>`;
}
function supplierModal(s) {
  return `<div class="modal"><h2>${s ? t('edit') : t('newSupplier')}</h2><form data-form="supplier" data-id="${esc(s?.id || '')}">${field('sn', t('name'), s?.name, 'required maxlength="60"')}${field('sp', t('phone'), s?.phone, 'maxlength="30"')}${field('sno', t('note'), s?.note, 'maxlength="120"')}<div class="acts"><button type="button" class="btn" data-act="modal-close">${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form></div>`;
}
function poModal() {
  const opts = L.allVariants(S.view).filter(({ p }) => p.active).map(({ p, v }) => `<option value="${esc(v.id)}" data-cost="${num(v.cost)}">${esc(nm(p))} · ${esc(lb(v))} (${nf(v.stock)})</option>`).join('');
  return `<div class="modal wide"><h2>${t('newPO')}</h2><form data-form="po"><div class="f"><label for="posup">${t('supplier')}</label><select id="posup">${S.view.suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>
  <div id="polines"><div class="row" data-poline style="margin-bottom:.4rem"><select name="v" style="flex:3">${opts}</select><input name="qty" inputmode="numeric" placeholder="${esc(t('qty'))}" required><input name="cost" inputmode="decimal" placeholder="${esc(t('unitCost'))}" required></div></div>
  <button type="button" class="btn sm" data-act="add-poline">${t('addLine')}</button><template id="poline-tpl"><div class="row" data-poline style="margin-bottom:.4rem"><select name="v" style="flex:3">${opts}</select><input name="qty" inputmode="numeric" placeholder="${esc(t('qty'))}" required><input name="cost" inputmode="decimal" placeholder="${esc(t('unitCost'))}" required></div></template>
  <div class="acts"><button type="button" class="btn" data-act="modal-close">${t('cancel')}</button><button class="btn pri">${t('save')}</button></div></form></div>`;
}

function salesPage() {
  const own = isOwner(), list = (own ? S.view.sales.slice().reverse() : S.view.mySales).filter((s) => !S.saleQ || s.no.toLowerCase().includes(S.saleQ.toLowerCase())).slice(0, 150);
  return `<div class="bar"><h1 style="margin:0">${own ? t('sales') : t('mine')}</h1><input id="sq" placeholder="${esc(t('sellerFilter'))}" value="${esc(S.saleQ)}"><span class="sp"></span>${own ? `<button class="btn" data-act="csv-sales">${t('csvSales')}</button>` : ''}</div>
  <div class="tw"><table><thead><tr><th>${t('sale')}</th><th>${t('time')}</th><th>${t('cashier')}</th><th class="num">${t('items')}</th><th class="num">${t('total')}</th><th>${t('status')}</th><th>${t('flags')}</th><th></th></tr></thead><tbody>
  ${list.map((s) => `<tr><td>${esc(s.no)}</td><td>${esc(when(s.t))}</td><td>${esc(s.cashierName)}</td><td class="num">${nf(s.lines.reduce((a, l) => a + l.qty, 0))}</td><td class="num">${money(s.total)}</td><td>${s.refund ? `<span class="tag red">${t('refunded')}</span>` : s.pending ? `<span class="tag">${t('pending')}</span>` : `<span class="tag ok">${t('paid')}</span>`}</td><td>${flagTags(s)}</td><td><button class="btn sm" data-act="view-sale" data-id="${esc(s.id)}">${t('receipt')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function saleModal(s) {
  return `<div class="modal">${receiptHtml(s)}${isOwner() && !s.refund && !s.pending ? `<div class="f" style="margin-top:.8rem"><label for="rreason">${t('refundReason')}</label><input id="rreason" maxlength="120"></div>` : ''}<div class="acts"><button class="btn" data-act="print">${t('print')}</button>${isOwner() && !s.refund && !s.pending ? `<button class="btn danger" data-act="refund" data-id="${esc(s.id)}">${t('refund')}</button>` : ''}<button class="btn pri" data-act="modal-close">${t('close')}</button></div></div>`;
}

function shiftsPage() {
  return `<h1>${t('shifts')}</h1><div class="tw"><table><thead><tr><th>${t('cashier')}</th><th>${t('openedAt')}</th><th>${t('closedAt')}</th><th class="num">${t('opening')}</th><th class="num">${t('cashSales')}</th><th class="num">${t('cardSales')}</th><th class="num">${t('expected')}</th><th class="num">${t('counted')}</th><th class="num">${t('variance')}</th><th>${t('note')}</th></tr></thead><tbody>
  ${S.view.shifts.map((s) => `<tr><td>${esc(s.cashierName)}</td><td>${esc(when(s.openedAt))}</td><td>${s.closedAt ? esc(when(s.closedAt)) : `<span class="tag ok">${t('tillOpen')}</span>`}</td><td class="num">${money(s.opening)}</td><td class="num">${money(s.cashSales)}</td><td class="num">${money(s.cardSales)}</td><td class="num">${money(s.expected)}</td><td class="num">${s.closedAt ? money(s.counted) : ''}</td><td class="num">${s.closedAt ? `<b style="color:${s.variance < 0 ? 'var(--red)' : s.variance > 0 ? '#8a5a00' : '#0b5c4b'}">${s.variance > 0 ? '+' : ''}${money(s.variance)}</b>` : ''}</td><td>${esc(s.note || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

function reportsPage() {
  const [a, b] = rangeOf(S.range), r = L.salesReport(S.view, a, b);
  return `<div class="bar"><h1 style="margin:0">${t('reports')}</h1>${[1, 7, 14].map((n) => `<button class="chip ${S.range === n ? 'on' : ''}" data-act="range" data-n="${n}">${t('range' + n)}</button>`).join('')}<span class="sp"></span><button class="btn" data-act="csv-report">${t('csvReport')}</button><button class="btn" data-act="csv-sales">${t('csvSales')}</button><button class="btn" data-act="csv-stock">${t('csvStock')}</button></div>
  <div class="grid kpis" style="margin-bottom:1rem">${[[t('revenue'), money(r.gross)], [t('netOfVat'), money(r.net)], [t('vat'), money(r.vat)], [t('cogs'), money(r.cogs)], [t('profit'), `${money(r.profit)} (${nf(r.margin * 100, 0)}%)`], [t('count'), nf(r.count)], [t('discounts'), money(r.discounts)], [t('refundsTotal'), `${money(r.refunds)} (${nf(r.refundCount)})`]].map(([l, n]) => `<div class="card kpi"><div class="n" style="font-size:1.25rem">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
  <div class="grid two"><div class="card"><h2>${t('revenue')}</h2>${chart2(r, Math.max(S.range, 7))}</div><div class="card"><h2>${t('topSellers')}</h2><table><thead><tr><th>${t('product')}</th><th class="num">${t('qty')}</th><th class="num">${t('revenue')}</th><th class="num">${t('profit')}</th></tr></thead>${r.top.map((i) => `<tr><td>${esc(nm(i))} <span style="color:var(--ink2)">${esc(lb(i))}</span></td><td class="num">${nf(i.qty)}</td><td class="num">${money(i.revenue)}</td><td class="num">${money(i.profit)}</td></tr>`).join('')}</table>
  <h3 style="margin-top:1rem">${t('cash')} / ${t('card')}</h3><div>${t('cash')}: ${money(r.cash)} · ${t('card')}: ${money(r.card)}</div></div></div>`;
}
function auditPage() {
  return `<h1>${t('audit')}</h1><div class="tw"><table><thead><tr><th>${t('time')}</th><th>${t('by')}</th><th>${t('action')}</th><th>${t('detail')}</th></tr></thead><tbody>${S.view.audit.map((a) => `<tr><td>${esc(when(a.t))}</td><td>${esc(a.by)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- render ----------
const route = () => (location.hash.replace(/^#\//, '') || (isOwner() ? 'dashboard' : 'pos')).split('?')[0];
function render() {
  document.documentElement.lang = S.lang; document.documentElement.dir = t('dir');
  const app = $('#app');
  const keep = document.activeElement?.id === 'q' ? document.activeElement.selectionStart : null;
  if (!S.token || !S.view) { app.innerHTML = loginPage(); return; }
  let r = route();
  const pages = { pos: posPage, shift: shiftPage, sales: salesPage, dashboard: dashboardPage, products: productsPage, stock: stockPage, purchases: purchasesPage, shifts: shiftsPage, reports: reportsPage, audit: auditPage };
  if (!pages[r] || (!isOwner() && !['pos', 'shift', 'sales'].includes(r))) r = isOwner() ? 'dashboard' : 'pos';
  let html = shell(pages[r](), r);
  const m = S.modal;
  if (S.receipt) html += `<div class="modal-bg"><div class="modal">${receiptHtml(S.receipt)}<div class="acts"><button class="btn" data-act="print">${t('print')}</button><button class="btn pri" data-act="receipt-close" autofocus>${t('newSale')}</button></div></div></div>`;
  else if (m) html += `<div class="modal-bg" data-bg>${m.type === 'pay' ? payModal() : m.type === 'product' ? productModal(m.p) : m.type === 'adjust' ? adjustModal(m.v) : m.type === 'supplier' ? supplierModal(m.s) : m.type === 'po' ? poModal() : saleModal(m.s)}</div>`;
  app.innerHTML = html;
  if (m?.type === 'pay') updatePay();
  if (m?.type === 'po') fillCosts();
  if (r === 'pos' && !m && !S.receipt) { const q = $('#q'); if (q && keep !== null) { q.focus(); q.setSelectionRange(keep, keep); } }
}

// ---------- events ----------
const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const H = {
  lang: () => { S.lang = ar() ? 'en' : 'ar'; LS.set('lang', S.lang); render(); },
  'quick-login': (el) => login(el.dataset.pin),
  logout: () => logout(),
  add: (el) => addToCart(el.dataset.v),
  inc: (el) => addToCart(el.dataset.v),
  dec: (el) => { const c = S.cart.find((x) => x.variantId === el.dataset.v); if (c && --c.qty <= 0) S.cart = S.cart.filter((x) => x !== c); render(); },
  clear: () => { S.cart = []; S.disc.value = ''; render(); },
  cat: (el) => { S.cat = el.dataset.c; render(); },
  pay: () => { S.modal = { type: 'pay' }; render(); },
  'modal-close': () => { S.modal = null; render(); },
  'receipt-close': () => { S.receipt = null; render(); },
  'q-exact': () => { $('#pcash').value = num(cartInfo().total); $('#pcard').value = ''; updatePay(); },
  'q-card': () => { $('#pcard').value = num(cartInfo().total); $('#pcash').value = ''; updatePay(); },
  'q-cash': (el) => { $('#pcash').value = el.dataset.n; updatePay(); },
  'confirm-pay': () => submitSale(),
  print: () => window.print(),
  'dismiss-rej': (el) => { S.rejected = S.rejected.filter((r) => r.id !== el.dataset.id); persist(); render(); },
  'open-shift': async () => { const c = $('#open-cash')?.value; if (c === '' || c === undefined) return toast(t('openingCash'), true); await act({ type: 'shift.open', opening: toCents(c) }); },
  'close-shift': async () => { const r = await act({ type: 'shift.close', counted: toCents($('#counted').value), note: $('#cnote').value }, null); if (r?.shift) toast(`${t('variance')}: ${money(r.shift.variance)}`); },
  'low-link': () => { S.stockLow = true; },
  'reset-demo': () => act({ type: 'reset' }, 'OK'),
  'new-product': () => { S.modal = { type: 'product', p: null }; render(); },
  'edit-product': (el) => { S.modal = { type: 'product', p: S.view.products.find((p) => p.id === el.dataset.id) }; render(); },
  'toggle-product': (el) => act({ type: 'product.toggle', id: el.dataset.id }),
  'add-vrow': () => { $('#vrows').insertAdjacentHTML('beforeend', vrow({ sku: '', barcode: '', label: '', price: 0, cost: 0, reorder: 5, stock: 0 })); },
  stab: (el) => { S.stockTab = el.dataset.s; render(); },
  adjust: (el) => { S.modal = { type: 'adjust', v: el.dataset.v }; render(); },
  'csv-stock': () => download('makhzan-stock.csv', L.stockCsv(S.view)),
  'csv-sales': () => { const [a, b] = rangeOf(location.hash.includes('reports') ? S.range : 14); download('makhzan-sales.csv', L.salesCsv(S.view, a, b)); },
  'csv-report': () => { const [a, b] = rangeOf(S.range); download('makhzan-report.csv', L.reportCsv(L.salesReport(S.view, a, b))); },
  range: (el) => { S.range = Number(el.dataset.n); render(); },
  'new-supplier': () => { S.modal = { type: 'supplier', s: null }; render(); },
  'edit-supplier': (el) => { S.modal = { type: 'supplier', s: S.view.suppliers.find((s) => s.id === el.dataset.id) }; render(); },
  'new-po': () => { if (!S.view.suppliers.length) return toast(t('newSupplier'), true); S.modal = { type: 'po' }; render(); },
  'add-poline': () => { $('#polines').appendChild($('#poline-tpl').content.cloneNode(true)); fillCosts(); },
  'po-receive': (el) => act({ type: 'po.receive', id: el.dataset.id }, t('received')),
  'po-cancel': (el) => act({ type: 'po.cancel', id: el.dataset.id }, t('cancelled')),
  'view-sale': (el) => { const list = isOwner() ? S.view.sales : S.view.mySales; S.modal = { type: 'sale', s: list.find((s) => s.id === el.dataset.id) }; render(); },
  refund: async (el) => { const r = await act({ type: 'refund', saleId: el.dataset.id, reason: $('#rreason')?.value || '' }, t('refunded')); if (r) { S.modal = null; render(); } },
};
document.addEventListener('click', (e) => {
  const bg = e.target.closest('[data-bg]'); if (bg && e.target === bg) { S.modal = null; render(); return; }
  const el = e.target.closest('[data-act]'); if (el && H[el.dataset.act]) { if (el.tagName === 'A') { H[el.dataset.act](el); return; } e.preventDefault(); H[el.dataset.act](el); }
});
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'q') { S.q = e.target.value; const keep = e.target.selectionStart; render(); const q = $('#q'); q.focus(); q.setSelectionRange(keep, keep); }
  else if (id === 'dval') { S.disc.value = e.target.value; const keep = e.target.selectionStart; render(); const d = $('#dval'); d.focus(); d.setSelectionRange(keep, keep); }
  else if (id === 'pcash' || id === 'pcard') updatePay();
  else if (id === 'pq') { S.prodQ = e.target.value; const k = e.target.selectionStart; render(); const q = $('#pq'); q.focus(); q.setSelectionRange(k, k); }
  else if (id === 'sq') { S.saleQ = e.target.value; const k = e.target.selectionStart; render(); const q = $('#sq'); q.focus(); q.setSelectionRange(k, k); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'dtype') { S.disc.type = e.target.value; render(); }
  if (e.target.id === 'lowonly') { S.stockLow = e.target.checked; render(); }
  if (e.target.name === 'v' && e.target.closest('[data-poline]')) { const o = e.target.selectedOptions[0]; e.target.closest('[data-poline]').querySelector('[name=cost]').value = o.dataset.cost; }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'q') {
    e.preventDefault(); const code = S.q.trim(); if (!code) return;
    const hit = L.findByCode({ products: S.view.products }, code);
    if (hit) { S.q = ''; addToCart(hit.v.id); return; }
    const r = search(); if (r.length === 1) { S.q = ''; addToCart(r[0].v.id); } else toast(t('notFound'), true);
  }
  if (e.key === 'Escape' && S.modal) { S.modal = null; render(); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const k = f.dataset.form;
  if (k === 'login') return login($('#pin').value.trim());
  if (k === 'product') { const r = await act(readProduct(f), 'OK'); if (r) S.modal = null; render(); }
  if (k === 'adjust') { const r = await act({ type: 'adjust', variantId: f.dataset.v, counted: parseInt($('#acount').value, 10), reason: $('#areason').value }, 'OK'); if (r) S.modal = null; render(); }
  if (k === 'supplier') { const r = await act({ type: 'supplier.save', id: f.dataset.id || undefined, name: $('#sn').value, phone: $('#sp').value, note: $('#sno').value }, 'OK'); if (r) S.modal = null; render(); }
  if (k === 'po') {
    const lines = [...f.querySelectorAll('[data-poline]')].map((r) => ({ variantId: r.querySelector('[name=v]').value, qty: parseInt(r.querySelector('[name=qty]').value, 10), cost: toCents(r.querySelector('[name=cost]').value) }));
    const r = await act({ type: 'po.create', supplierId: $('#posup').value, lines }, 'OK'); if (r) S.modal = null; render();
  }
});
window.addEventListener('hashchange', render);
window.addEventListener('online', () => { sync(); refresh(true); });
window.addEventListener('offline', () => { S.offline = true; render(); });
setInterval(() => { if (!S.token || document.hidden) return; if (S.queue.length) sync(); else refresh(true); }, 10000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
if (S.token) { if (!navigator.onLine) S.offline = true; refresh(true).then(sync); }
window.__mk = S;
