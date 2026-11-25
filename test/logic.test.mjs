import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/logic.js';
import { signToken, readToken } from '../api/_auth.js';

const NOW = Date.parse('2026-11-25T14:00:00Z');
const fresh = () => L.seed(NOW);
const U = Object.fromEntries(L.DEMO_USERS.map((u) => [u.name, { id: u.id, name: u.name, role: u.role }]));
const run = (st, user, op, now = NOW) => L.applyOp(st, op, { user: U[user], now });
const throws = (fn, re) => assert.throws(fn, (e) => e instanceof L.UserError && re.test(e.message), 'expected a UserError matching ' + re);
const item = (st, sku) => L.allVariants(st).map((x) => x).find((x) => x.v.sku === sku);
let n = 0;
const sid = () => 'test-sale-' + ++n + '-abcdefgh';
function openFor(st, user, now = NOW) {
  let s = L.openShiftOf(st, U[user].id);
  if (!s) s = run(st, user, { type: 'shift.open', opening: 10000 }, now).shift;
  return s;
}
// a cashier with an open shift on a fresh state
function setup(user = 'Karim') {
  const st = fresh();
  for (const s of st.shifts) if (!s.closedAt) s.closedAt = NOW - 1; // clear today's seeded open shift
  openFor(st, user);
  return st;
}
const cashPay = (amount) => [{ method: 'cash', amount }];

test('prices come from the catalog, VAT is inside the price', () => {
  const r = L.priceSale({ lines: [{ price: 11400, qty: 1 }], discount: null }, { role: 'cashier', rate: 14 });
  assert.equal(r.total, 11400); assert.equal(r.vat, 1400);
  assert.equal(L.vatOf(5000, 14), 614);
});

test('discount rules: percent, amount, cashier limit, never above the sale', () => {
  const lines = [{ price: 10000, qty: 2 }];
  const c = { role: 'cashier', rate: 14 }, o = { role: 'owner', rate: 14 };
  assert.equal(L.priceSale({ lines, discount: { type: 'pct', value: 10 } }, c).total, 18000);
  assert.equal(L.priceSale({ lines, discount: { type: 'amt', value: 2000 } }, c).total, 18000);
  throws(() => L.priceSale({ lines, discount: { type: 'pct', value: 10.5 } }, c), /limit is 10%/);
  throws(() => L.priceSale({ lines, discount: { type: 'amt', value: 2500 } }, c), /limit is 10%/);
  assert.equal(L.priceSale({ lines, discount: { type: 'pct', value: 30 } }, o).total, 14000);
  throws(() => L.priceSale({ lines, discount: { type: 'amt', value: 25000 } }, o), /larger than the sale/);
  throws(() => L.priceSale({ lines, discount: { type: 'pct', value: -5 } }, o), /Bad discount/);
  throws(() => L.priceSale({ lines, discount: { type: 'pct', value: 101 } }, o), /100%/);
});

test('payments: exact, change from cash, cash and card split, and the refusals', () => {
  assert.deepEqual(L.checkPayments(cashPay(10000), 8000), { cash: 10000, card: 0, change: 2000, cashNet: 8000 });
  assert.deepEqual(L.checkPayments([{ method: 'cash', amount: 3000 }, { method: 'card', amount: 5000 }], 8000), { cash: 3000, card: 5000, change: 0, cashNet: 3000 });
  throws(() => L.checkPayments(cashPay(7999), 8000), /less than the total/);
  throws(() => L.checkPayments([{ method: 'card', amount: 9000 }], 8000), /Card amount is more/);
  throws(() => L.checkPayments([{ method: 'cheque', amount: 8000 }], 8000), /cash or card/);
  throws(() => L.checkPayments([{ method: 'cash', amount: 1.5 }], 8000), /Bad payment/);
});

test('a sale takes stock, writes a movement, keeps the price from the catalog and numbers sales in order', () => {
  const st = setup(); const { v } = item(st, 'MK-001');
  const before = v.stock, price = v.price;
  const a = run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 3, price: 1 }], payments: cashPay(price * 3) }).sale;
  assert.equal(a.total, price * 3, 'a client-sent price is ignored online');
  assert.equal(v.stock, before - 3);
  const m = st.movements.at(-1);
  assert.deepEqual([m.type, m.qty, m.after, m.ref], ['sale', -3, before - 3, a.no]);
  const b = run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 1 }], payments: cashPay(price) }).sale;
  assert.equal(Number(b.no.slice(2)), Number(a.no.slice(2)) + 1);
});

test('the same sale id sent twice is saved once', () => {
  const st = setup(); const { v } = item(st, 'MK-002'); const id = sid(); const before = v.stock;
  const op = { type: 'sale', id, lines: [{ variantId: v.id, qty: 2 }], payments: cashPay(v.price * 2) };
  const first = run(st, 'Karim', op);
  const again = run(st, 'Karim', op);
  assert.equal(again.duplicate, true); assert.equal(again.sale.no, first.sale.no);
  assert.equal(v.stock, before - 2); assert.equal(st.sales.filter((s) => s.id === id).length, 1);
});

test('online sale: needs an open shift and enough stock, and bad input is refused', () => {
  const st = setup(); const { v } = item(st, 'MK-003');
  throws(() => run(st, 'Mona', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 1 }], payments: cashPay(v.price) }), /Open a shift first/);
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: v.stock + 1 }], payments: cashPay(v.price * (v.stock + 1)) }), /Not enough stock/);
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), lines: [], payments: cashPay(1) }), /cart is empty/);
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 0 }], payments: cashPay(v.price) }), /Quantity/);
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 1.5 }], payments: cashPay(v.price) }), /Quantity/);
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: 'nope', qty: 1 }], payments: cashPay(100) }), /no longer exists/);
  throws(() => run(st, 'Karim', { type: 'sale', id: 'x', lines: [{ variantId: v.id, qty: 1 }], payments: cashPay(v.price) }), /Bad sale id/);
  assert.equal(st.sales.at(-1).id.startsWith('seed-'), true, 'a refused sale saves nothing');
});

test('archived products cannot be sold', () => {
  const st = setup(); const { p, v } = item(st, 'MK-004');
  run(st, 'Owner', { type: 'product.toggle', id: p.id });
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 1 }], payments: cashPay(v.price) }), /archived/);
  assert.equal(L.findByCode(st, v.barcode), null);
});

test('offline sale: old price accepted and flagged, unknown price refused, stock can go below zero and is flagged', () => {
  const st = setup(); const { p, v } = item(st, 'MK-005'); const sh = L.openShiftOf(st, U.Karim.id);
  const oldPrice = v.price;
  run(st, 'Owner', { type: 'product.save', id: p.id, name: p.name, variants: p.variants.map((x) => ({ id: x.id, sku: x.sku, barcode: x.barcode, label: x.label, price: x.id === v.id ? oldPrice + 200 : x.price, cost: x.cost, reorder: x.reorder })) });
  assert.deepEqual(v.prices, [oldPrice]);
  const t = NOW - 3600e3;
  const ok = run(st, 'Karim', { type: 'sale', id: sid(), offline: true, t, shiftId: sh.id, lines: [{ variantId: v.id, qty: 1, price: oldPrice }], payments: cashPay(oldPrice) }).sale;
  assert.equal(ok.t, t); assert.equal(ok.total, oldPrice); assert.ok(ok.flags.includes('old-price')); assert.equal(ok.shiftId, sh.id);
  throws(() => run(st, 'Karim', { type: 'sale', id: sid(), offline: true, t, shiftId: sh.id, lines: [{ variantId: v.id, qty: 1, price: 1 }], payments: cashPay(100) }), /not a known price/);
  const q = v.stock + 2;
  const over = run(st, 'Karim', { type: 'sale', id: sid(), offline: true, t, shiftId: sh.id, lines: [{ variantId: v.id, qty: q, price: v.price }], payments: cashPay(v.price * q) }).sale;
  assert.ok(over.flags.includes('oversold')); assert.ok(v.stock < 0);
  assert.equal(L.lowStock(st).some((x) => x.v.id === v.id), true, 'negative stock shows in the alerts');
});

test('offline sale made in a shift that has since closed is kept but kept out of that till', () => {
  const st = setup(); const { v } = item(st, 'MK-006'); const sh = L.openShiftOf(st, U.Karim.id);
  run(st, 'Karim', { type: 'shift.close', counted: 10000 });
  openFor(st, 'Karim');
  const s = run(st, 'Karim', { type: 'sale', id: sid(), offline: true, t: NOW - 1000, shiftId: sh.id, lines: [{ variantId: v.id, qty: 1, price: v.price }], payments: cashPay(v.price) }).sale;
  assert.equal(s.shiftId, null); assert.ok(s.flags.includes('late-sync'));
  assert.equal(L.shiftTotals(st, sh).cashSales, 0);
});

test('offline time is trusted only inside a sane window', () => {
  const st = setup(); const { v } = item(st, 'MK-007'); const sh = L.openShiftOf(st, U.Karim.id);
  const mk = (t) => run(st, 'Karim', { type: 'sale', id: sid(), offline: true, t, shiftId: sh.id, lines: [{ variantId: v.id, qty: 1, price: v.price }], payments: cashPay(v.price) }).sale.t;
  assert.equal(mk(NOW - 30 * 86400e3), NOW, 'older than 7 days: use server time');
  assert.equal(mk(NOW + 3600e3), NOW, 'in the future: use server time');
  assert.equal(mk(NOW - 86400e3), NOW - 86400e3);
});

test('cashiers cannot do owner work, and never see costs', () => {
  const st = setup(); const { p, v } = item(st, 'MK-008');
  const base = { variantId: v.id, reason: 'damage', delta: -1 };
  for (const op of [{ type: 'adjust', ...base }, { type: 'refund', saleId: st.sales[0].id }, { type: 'po.create', supplierId: 'sp1', lines: [] }, { type: 'po.receive', id: 'po1' }, { type: 'supplier.save', name: 'x' }, { type: 'product.toggle', id: p.id }, { type: 'product.save', name: 'x', variants: [] }]) {
    throws(() => run(st, 'Karim', op), /Owner only/);
  }
  const cv = L.view(st, U.Karim, NOW);
  assert.ok(!JSON.stringify(cv).includes('"cost"'), 'no cost anywhere in the cashier view');
  assert.equal(cv.purchases, undefined); assert.equal(cv.suppliers, undefined); assert.equal(cv.audit, undefined);
  assert.ok(cv.mySales.every((s) => s.cashier === U.Karim.id));
  assert.ok(L.view(st, U.Owner, NOW).purchases.length);
});

test('shift cash: opening + cash sales (minus change) - cash refunds, difference needs a note', () => {
  const st = setup(); const sh = L.openShiftOf(st, U.Karim.id); const { v } = item(st, 'MK-009');
  const mk = (qty, pay) => run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty }], payments: pay }).sale;
  const a = mk(1, cashPay(Math.ceil(v.price / 1000) * 1000));
  mk(2, [{ method: 'card', amount: v.price * 2 }]);
  const c = mk(1, [{ method: 'cash', amount: 500 }, { method: 'card', amount: v.price - 500 }]);
  const t = L.shiftTotals(st, sh);
  assert.equal(t.cashSales, a.total + 500); assert.equal(t.cardSales, v.price * 2 + (v.price - 500)); assert.equal(t.count, 3);
  assert.equal(t.expected, 10000 + a.total + 500);
  run(st, 'Owner', { type: 'shift.open', opening: 0 });
  run(st, 'Owner', { type: 'refund', saleId: a.id, reason: 'wrong item' });
  assert.equal(L.shiftTotals(st, sh).cashRefunds, 0, 'the refund is paid from the owner till when the owner has one open');
  throws(() => run(st, 'Karim', { type: 'shift.close', counted: t.expected - 300 }), /Explain the cash difference/);
  throws(() => run(st, 'Mona', { type: 'shift.close', shiftId: sh.id, counted: 1 }), /own shift|No open shift/);
  const closed = run(st, 'Karim', { type: 'shift.close', counted: t.expected - 300, note: 'gave 3 EGP too much' }).shift;
  assert.equal(closed.variance, -300); assert.equal(closed.expected, t.expected);
  throws(() => run(st, 'Karim', { type: 'shift.close', counted: 0 }), /No open shift/);
  throws(() => run(st, 'Karim', { type: 'shift.open', opening: -5 }), /opening cash/);
  void c;
});

test('refund puts stock back once, pays out of an open till, and leaves the sale out of reports', () => {
  const st = setup(); const sh = L.openShiftOf(st, U.Karim.id); const { v } = item(st, 'MK-010');
  const before = v.stock;
  const s = run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 2 }], payments: cashPay(v.price * 2) }).sale;
  const r0 = L.salesReport(st, NOW - 1000, NOW + 1000);
  run(st, 'Owner', { type: 'refund', saleId: s.id, reason: 'changed mind' });
  assert.equal(v.stock, before); assert.equal(L.shiftTotals(st, sh).cashRefunds, s.total);
  assert.equal(st.movements.at(-1).type, 'refund');
  throws(() => run(st, 'Owner', { type: 'refund', saleId: s.id }), /already refunded/);
  const r1 = L.salesReport(st, NOW - 1000, NOW + 1000);
  assert.equal(r0.gross - r1.gross, s.total); assert.equal(r1.refundCount, 1);
  for (const x of st.shifts) if (!x.closedAt) x.closedAt = NOW;
  const s2 = Object.assign({}, s, { id: 'zz', refund: null }); st.sales.push(s2);
  throws(() => run(st, 'Owner', { type: 'refund', saleId: 'zz' }), /Open a shift first/);
});

test('purchase: receive adds stock, moves the average cost, and cannot be received twice', () => {
  const st = fresh(); const { v } = item(st, 'MK-011'); const stock = v.stock, cost = v.cost;
  const po = run(st, 'Owner', { type: 'po.create', supplierId: 'sp1', lines: [{ variantId: v.id, qty: 10, cost: cost + 1000 }] }).purchase;
  assert.equal(po.status, 'ordered'); assert.equal(v.stock, stock, 'ordering changes nothing yet');
  run(st, 'Owner', { type: 'po.receive', id: po.id });
  assert.equal(v.stock, stock + 10);
  assert.equal(v.cost, Math.round((stock * cost + 10 * (cost + 1000)) / (stock + 10)));
  throws(() => run(st, 'Owner', { type: 'po.receive', id: po.id }), /already received/);
  throws(() => run(st, 'Owner', { type: 'po.cancel', id: po.id }), /Only an ordered/);
  throws(() => run(st, 'Owner', { type: 'po.create', supplierId: 'nope', lines: [{ variantId: v.id, qty: 1, cost: 1 }] }), /supplier/);
  throws(() => run(st, 'Owner', { type: 'po.create', supplierId: 'sp1', lines: [{ variantId: v.id, qty: 0, cost: 1 }] }), /Quantity/);
  throws(() => run(st, 'Owner', { type: 'po.create', supplierId: 'sp1', lines: [{ variantId: v.id, qty: 1, cost: 1 }, { variantId: v.id, qty: 1, cost: 1 }] }), /once/);
  const p2 = run(st, 'Owner', { type: 'po.create', supplierId: 'sp1', lines: [{ variantId: v.id, qty: 1, cost: 1 }] }).purchase;
  run(st, 'Owner', { type: 'po.cancel', id: p2.id });
  throws(() => run(st, 'Owner', { type: 'po.receive', id: p2.id }), /already received or cancelled/);
});

test('stock adjustment: reason required, count mode, never below zero, every change is in the audit trail', () => {
  const st = fresh(); const { v } = item(st, 'MK-012'); const was = v.stock;
  throws(() => run(st, 'Owner', { type: 'adjust', variantId: v.id, delta: -1 }), /reason/);
  throws(() => run(st, 'Owner', { type: 'adjust', variantId: v.id, delta: 0, reason: 'count' }), /Bad quantity|Nothing/);
  throws(() => run(st, 'Owner', { type: 'adjust', variantId: v.id, counted: was, reason: 'count' }), /already matches/);
  throws(() => run(st, 'Owner', { type: 'adjust', variantId: v.id, delta: -(was + 1), reason: 'loss' }), /below zero/);
  const a0 = st.audit.length, m0 = st.movements.length;
  run(st, 'Owner', { type: 'adjust', variantId: v.id, counted: was + 4, reason: 'count' });
  assert.equal(v.stock, was + 4);
  assert.equal(st.movements.length, m0 + 1); assert.equal(st.audit.length, a0 + 1);
  assert.deepEqual([st.movements.at(-1).qty, st.movements.at(-1).after, st.movements.at(-1).reason], [4, was + 4, 'count']);
});

test('product editing: unique SKU and barcode, price history, opening stock logged, validation', () => {
  const st = fresh(); const { p, v } = item(st, 'MK-013');
  const mine = (over = {}) => ({ type: 'product.save', name: 'Test lamp', category: 'Home', variants: [{ sku: 'LAMP-1', barcode: '6220000000001', label: 'White', price: 15000, cost: 9000, reorder: 3, stock: 7, ...over }] });
  const made = run(st, 'Owner', mine()).product;
  assert.equal(made.variants[0].stock, 7); assert.equal(st.movements.at(-1).type, 'opening');
  throws(() => run(st, 'Owner', mine()), /already used/);
  throws(() => run(st, 'Owner', mine({ sku: 'LAMP-2', barcode: v.barcode })), /Barcode .* already used/);
  throws(() => run(st, 'Owner', mine({ sku: v.sku, barcode: '' })), /SKU .* already used/);
  throws(() => run(st, 'Owner', mine({ sku: 'A', barcode: '', price: 0 })), /more than zero/);
  throws(() => run(st, 'Owner', mine({ sku: 'A', barcode: '', price: 10.5 })), /more than zero/);
  throws(() => run(st, 'Owner', mine({ sku: 'A', barcode: '', cost: -1 })), /Bad cost/);
  throws(() => run(st, 'Owner', mine({ sku: 'A', barcode: '', label: '  ' })), /label/);
  throws(() => run(st, 'Owner', { type: 'product.save', name: ' ', variants: [] }), /name/);
  const before = made.variants[0].price;
  run(st, 'Owner', { type: 'product.save', id: made.id, name: 'Test lamp', variants: [{ id: made.variants[0].id, sku: 'LAMP-1', barcode: '6220000000001', label: 'White', price: 16000, cost: 9000, reorder: 3, stock: 999 }] });
  assert.equal(made.variants[0].price, 16000); assert.deepEqual(made.variants[0].prices, [before]);
  assert.equal(made.variants[0].stock, 7, 'stock is changed only through adjust, receive and sale');
  void p;
});

test('barcode or SKU lookup, case-insensitive', () => {
  const st = fresh(); const { v } = item(st, 'MK-014');
  assert.equal(L.findByCode(st, v.barcode).v.id, v.id);
  assert.equal(L.findByCode(st, v.sku.toLowerCase()).v.id, v.id);
  assert.equal(L.findByCode(st, 'nothing'), null); assert.equal(L.findByCode(st, ''), null);
});

test('reports: profit is net of VAT minus cost, CSV neutralises formulas and quotes cells', () => {
  const st = setup(); const { v } = item(st, 'MK-015');
  const t = NOW + 1;
  const s = run(st, 'Karim', { type: 'sale', id: sid(), lines: [{ variantId: v.id, qty: 2 }], payments: cashPay(v.price * 2) }, t).sale;
  const r = L.salesReport(st, t - 1, t + 1);
  assert.equal(r.count, 1); assert.equal(r.gross, s.total); assert.equal(r.vat, s.vat); assert.equal(r.net, s.total - s.vat);
  assert.equal(r.profit, s.total - s.vat - v.cost * 2);
  const { p } = item(st, 'MK-015'); p.name = '=HYPERLINK("http://evil","x")'; st.sales.at(-1).cashierName = 'A, "B"';
  const csv = L.salesCsv(st, t - 1, t + 1);
  assert.ok(csv.startsWith('\ufeffSale,Date'));
  assert.ok(csv.includes('"A, ""B"""'));
  assert.equal(L.toCsv([['=1+1', '+SUM(A1)', '-2', '@x', 'plain']]), "\ufeff'=1+1,'+SUM(A1),'-2,'@x,plain\r\n");
  assert.ok(L.reportCsv(r).includes('Total,1,'));
  assert.ok(L.stockCsv(st).split('\r\n')[0].includes('Stock value'));
});

test('seeded demo is consistent: stock matches the movement log, no negatives, shift cash recomputes', () => {
  const st = fresh();
  assert.ok(st.sales.length > 200 && st.shifts.length >= 12);
  const last = new Map();
  for (const m of st.movements) last.set(m.variantId, m.after);
  for (const { v } of L.allVariants(st)) {
    assert.ok(v.stock >= 0, v.sku + ' stock is negative');
    if (last.has(v.id)) assert.equal(last.get(v.id), v.stock, v.sku + ' stock differs from its last movement');
  }
  for (const s of st.shifts.filter((x) => x.closedAt)) {
    const t = L.shiftTotals(st, s);
    assert.equal(s.expected, t.expected); assert.equal(s.variance, s.counted - t.expected);
    if (s.variance) assert.ok(s.note, 'a shift with a difference has a note');
  }
  assert.ok(L.lowStock(st).length >= 3, 'the demo shows low-stock alerts');
  assert.equal(st.shifts.filter((s) => !s.closedAt).length <= 1, true);
  for (const s of st.sales) assert.equal(s.total, s.subtotal - s.discount);
  const total = L.dayKey(NOW);
  assert.match(total, /^2026-11-25$/);
});

test('tokens: valid, tampered, expired and unknown users are all handled', () => {
  const users = L.DEMO_USERS; const t = signToken('u-mona', NOW);
  assert.equal(readToken(t, users, NOW).role, 'cashier');
  assert.equal(readToken(t + 'x', users, NOW), null);
  assert.equal(readToken(t.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), users, NOW), null);
  assert.equal(readToken(t, users, NOW + 13 * 3600e3), null);
  assert.equal(readToken(signToken('ghost', NOW), users, NOW), null);
  assert.equal(readToken('', users, NOW), null); assert.equal(readToken(undefined, users, NOW), null);
  // a cashier token cannot be edited into an owner token
  const [b, sig] = t.split('.'); const forged = Buffer.from(Buffer.from(b, 'base64url').toString().replace('u-mona', 'u-owner')).toString('base64url') + '.' + sig;
  assert.equal(readToken(forged, users, NOW), null);
});
