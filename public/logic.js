// Makhzan business rules. Pure functions, no I/O: the API, the browser app and the tests all import this file.
// All money is stored in piasters (1 EGP = 100), as integers, so totals never drift.

export class UserError extends Error {}
const bad = (m) => { throw new UserError(m); };

export const TZ = 'Africa/Cairo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayKey = (t) => dayFmt.format(new Date(t));
export function dayStart(t) {
  const k = dayKey(t), g = Date.parse(k + 'T00:00:00Z');
  for (const off of [2, 3]) { const c = g - off * 3600000; if (dayKey(c) === k && dayKey(c - 1) !== k) return c; }
  return g - 2 * 3600000;
}
export const egp = (c) => (c / 100).toFixed(2);
export const vatOf = (total, rate) => Math.round((total * rate) / (100 + rate));
const isInt = (n) => Number.isInteger(n);
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const pad = (n, w = 6) => String(n).padStart(w, '0');

export const ROLES = { owner: 'owner', cashier: 'cashier' };
export const CASHIER_DISCOUNT_LIMIT_PCT = 10;
export const ADJUST_REASONS = ['count', 'damage', 'expired', 'loss', 'found'];
export const OFFLINE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// ---------- lookups ----------
export function allVariants(state) {
  const out = [];
  for (const p of state.products) for (const v of p.variants) out.push({ p, v });
  return out;
}
export function findVariant(state, id) {
  for (const p of state.products) for (const v of p.variants) if (v.id === id) return { p, v };
  return null;
}
export function findByCode(state, code) {
  const c = clean(code, 40).toLowerCase();
  if (!c) return null;
  for (const p of state.products) {
    if (!p.active) continue;
    for (const v of p.variants) if (v.barcode.toLowerCase() === c || v.sku.toLowerCase() === c) return { p, v };
  }
  return null;
}
export const openShiftOf = (state, userId) => state.shifts.find((s) => !s.closedAt && s.cashier === userId) || null;
export const lowStock = (state) => allVariants(state).filter(({ p, v }) => p.active && v.stock <= v.reorder).sort((a, b) => a.v.stock - b.v.stock);

// ---------- money rules for one sale ----------
export function priceSale({ lines, discount }, { role, rate }) {
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  let disc = 0;
  if (discount && discount.value) {
    const val = Number(discount.value);
    if (!Number.isFinite(val) || val < 0) bad('Bad discount');
    if (discount.type === 'pct') {
      if (val > 100) bad('Discount cannot be more than 100%');
      disc = Math.round((subtotal * val) / 100);
    } else if (discount.type === 'amt') disc = Math.round(val);
    else bad('Bad discount type');
  }
  if (disc > subtotal) bad('Discount is larger than the sale');
  if (role !== ROLES.owner && disc > Math.round((subtotal * CASHIER_DISCOUNT_LIMIT_PCT) / 100)) bad(`Cashier discount limit is ${CASHIER_DISCOUNT_LIMIT_PCT}%, ask the owner`);
  const total = subtotal - disc;
  return { subtotal, discount: disc, total, vat: vatOf(total, rate) };
}

export function checkPayments(payments, total) {
  if (!Array.isArray(payments) || !payments.length || payments.length > 4) bad('Add a payment');
  let cash = 0, card = 0;
  for (const p of payments) {
    if (!isInt(p.amount) || p.amount < 0) bad('Bad payment amount');
    if (p.method === 'cash') cash += p.amount;
    else if (p.method === 'card') card += p.amount;
    else bad('Payment must be cash or card');
  }
  if (card > total) bad('Card amount is more than the total');
  if (cash + card < total) bad('Payment is less than the total');
  const change = cash + card - total;
  if (change > cash) bad('Change can only be given from cash');
  return { cash, card, change, cashNet: cash - change };
}

// ---------- state ----------
function logMove(state, m) {
  state.movements.push({ id: 'm' + ++state.seq.move, ...m });
}
function audit(state, ctx, action, detail) {
  state.audit.push({ t: ctx.now, by: ctx.user.name, action, detail: clean(detail, 200) });
}

export function shiftTotals(state, shift) {
  let cashSales = 0, cardSales = 0, count = 0, cashRefunds = 0, cardRefunds = 0;
  for (const s of state.sales) {
    if (s.shiftId === shift.id) { cashSales += s.pay.cashNet; cardSales += s.pay.card; count++; }
    if (s.refund && s.refund.shiftId === shift.id) { cashRefunds += s.refund.cash; cardRefunds += s.refund.card; }
  }
  return { cashSales, cardSales, count, cashRefunds, cardRefunds, expected: shift.opening + cashSales - cashRefunds };
}

// ---------- operations ----------
// ctx = { user: {id, name, role}, now: ms }. Every mutation goes through here.
export function applyOp(state, op, ctx) {
  if (!op || typeof op !== 'object') bad('Bad request');
  const owner = ctx.user.role === ROLES.owner;
  const needOwner = () => { if (!owner) bad('Owner only'); };
  switch (op.type) {
    case 'sale': return opSale(state, op, ctx);
    case 'shift.open': {
      if (openShiftOf(state, ctx.user.id)) bad('You already have an open shift');
      const opening = op.opening;
      if (!isInt(opening) || opening < 0 || opening > 100000000) bad('Enter the opening cash');
      const s = { id: 'sh' + ++state.seq.shift, cashier: ctx.user.id, cashierName: ctx.user.name, openedAt: ctx.now, opening, closedAt: null };
      state.shifts.push(s);
      audit(state, ctx, 'shift.open', `Opening cash ${egp(opening)}`);
      return { shift: s };
    }
    case 'shift.close': {
      const s = op.shiftId ? state.shifts.find((x) => x.id === op.shiftId) : openShiftOf(state, ctx.user.id);
      if (!s || s.closedAt) bad('No open shift to close');
      if (!owner && s.cashier !== ctx.user.id) bad('You can only close your own shift');
      if (!isInt(op.counted) || op.counted < 0) bad('Enter the counted cash');
      const t = shiftTotals(state, s);
      const variance = op.counted - t.expected;
      const note = clean(op.note, 200);
      if (variance !== 0 && !note) bad('Explain the cash difference in the note');
      Object.assign(s, { closedAt: ctx.now, counted: op.counted, expected: t.expected, variance, note, closedBy: ctx.user.name, cashSales: t.cashSales, cardSales: t.cardSales, salesCount: t.count, cashRefunds: t.cashRefunds });
      audit(state, ctx, 'shift.close', `${s.cashierName}: expected ${egp(t.expected)}, counted ${egp(op.counted)}, difference ${egp(variance)}`);
      return { shift: s };
    }
    case 'refund': {
      needOwner();
      const sale = state.sales.find((s) => s.id === op.saleId);
      if (!sale) bad('Sale not found');
      if (sale.refund) bad('Sale is already refunded');
      const till = openShiftOf(state, ctx.user.id) || state.shifts.find((x) => !x.closedAt);
      if (!till) bad('Open a shift first, refunds are paid from the till');
      sale.refund = { t: ctx.now, by: ctx.user.name, shiftId: till.id, cash: sale.pay.cashNet, card: sale.pay.card, reason: clean(op.reason, 120) };
      for (const l of sale.lines) {
        const f = findVariant(state, l.variantId);
        if (!f) continue;
        f.v.stock += l.qty;
        logMove(state, { t: ctx.now, variantId: l.variantId, type: 'refund', qty: l.qty, after: f.v.stock, ref: sale.no, by: ctx.user.name, reason: sale.refund.reason });
      }
      audit(state, ctx, 'refund', `${sale.no} refunded ${egp(sale.total)}`);
      return { sale };
    }
    case 'adjust': {
      needOwner();
      const f = findVariant(state, op.variantId);
      if (!f) bad('Item not found');
      if (!ADJUST_REASONS.includes(op.reason)) bad('Choose a reason');
      let delta;
      if (op.counted !== undefined && op.counted !== null) {
        if (!isInt(op.counted) || op.counted < 0 || op.counted > 1000000) bad('Bad counted quantity');
        delta = op.counted - f.v.stock;
      } else {
        delta = op.delta;
        if (!isInt(delta) || Math.abs(delta) > 1000000) bad('Bad quantity');
      }
      if (delta === 0) bad('Nothing to change, the count already matches');
      if (f.v.stock + delta < 0) bad('Stock cannot go below zero');
      f.v.stock += delta;
      logMove(state, { t: ctx.now, variantId: f.v.id, type: 'adjust', qty: delta, after: f.v.stock, ref: '', by: ctx.user.name, reason: op.reason });
      audit(state, ctx, 'adjust', `${f.p.name} ${f.v.label}: ${delta > 0 ? '+' : ''}${delta} (${op.reason})`);
      return { variant: f.v };
    }
    case 'supplier.save': {
      needOwner();
      const name = clean(op.name, 60);
      if (!name) bad('Supplier name is required');
      let s = op.id && state.suppliers.find((x) => x.id === op.id);
      if (op.id && !s) bad('Supplier not found');
      if (!s) { s = { id: 'sp' + ++state.seq.supplier }; state.suppliers.push(s); }
      Object.assign(s, { name, phone: clean(op.phone, 30), note: clean(op.note, 120) });
      audit(state, ctx, 'supplier.save', name);
      return { supplier: s };
    }
    case 'po.create': {
      needOwner();
      const sup = state.suppliers.find((x) => x.id === op.supplierId);
      if (!sup) bad('Choose a supplier');
      if (!Array.isArray(op.lines) || !op.lines.length || op.lines.length > 60) bad('Add at least one item');
      const seen = new Set();
      const lines = op.lines.map((l) => {
        const f = findVariant(state, l.variantId);
        if (!f) bad('Item not found');
        if (seen.has(l.variantId)) bad('Each item can appear once');
        seen.add(l.variantId);
        if (!isInt(l.qty) || l.qty < 1 || l.qty > 100000) bad('Quantity must be 1 or more');
        if (!isInt(l.cost) || l.cost < 0 || l.cost > 100000000) bad('Bad unit cost');
        return { variantId: l.variantId, qty: l.qty, cost: l.cost };
      });
      const po = { id: 'po' + ++state.seq.po, no: 'PO-' + pad(state.seq.po, 4), supplierId: sup.id, supplierName: sup.name, status: 'ordered', createdAt: ctx.now, lines, total: lines.reduce((s, l) => s + l.qty * l.cost, 0) };
      state.purchases.push(po);
      audit(state, ctx, 'po.create', `${po.no} to ${sup.name}, ${egp(po.total)}`);
      return { purchase: po };
    }
    case 'po.receive': {
      needOwner();
      const po = state.purchases.find((x) => x.id === op.id);
      if (!po) bad('Purchase not found');
      if (po.status !== 'ordered') bad('This purchase is already received or cancelled');
      for (const l of po.lines) {
        const f = findVariant(state, l.variantId);
        if (!f) continue;
        const have = Math.max(0, f.v.stock);
        f.v.cost = have + l.qty > 0 ? Math.round((have * f.v.cost + l.qty * l.cost) / (have + l.qty)) : l.cost;
        f.v.stock += l.qty;
        logMove(state, { t: ctx.now, variantId: l.variantId, type: 'purchase', qty: l.qty, after: f.v.stock, ref: po.no, by: ctx.user.name, reason: po.supplierName });
      }
      po.status = 'received';
      po.receivedAt = ctx.now;
      audit(state, ctx, 'po.receive', `${po.no} received`);
      return { purchase: po };
    }
    case 'po.cancel': {
      needOwner();
      const po = state.purchases.find((x) => x.id === op.id);
      if (!po || po.status !== 'ordered') bad('Only an ordered purchase can be cancelled');
      po.status = 'cancelled';
      audit(state, ctx, 'po.cancel', po.no);
      return { purchase: po };
    }
    case 'product.save': { needOwner(); return opProduct(state, op, ctx); }
    case 'product.toggle': {
      needOwner();
      const p = state.products.find((x) => x.id === op.id);
      if (!p) bad('Product not found');
      p.active = !p.active;
      audit(state, ctx, 'product.toggle', `${p.name} ${p.active ? 'restored' : 'archived'}`);
      return { product: p };
    }
    case 'reset': return {};
    default: return bad('Unknown action');
  }
}

function opSale(state, op, ctx) {
  const dup = op.id && state.sales.find((s) => s.id === op.id);
  if (dup) return { sale: dup, duplicate: true };
  if (typeof op.id !== 'string' || !/^[a-zA-Z0-9_-]{8,60}$/.test(op.id)) bad('Bad sale id');
  const offline = !!op.offline;
  if (!Array.isArray(op.lines) || !op.lines.length) bad('The cart is empty');
  if (op.lines.length > 80) bad('Too many lines');
  let t = ctx.now;
  if (offline && isInt(op.t) && op.t > ctx.now - OFFLINE_MAX_AGE_MS && op.t < ctx.now + 5 * 60 * 1000) t = op.t;
  const flags = [];
  let shiftId = null;
  const open = openShiftOf(state, ctx.user.id);
  if (!offline) {
    if (!open) bad('Open a shift first');
    shiftId = open.id;
  } else if (open && open.id === op.shiftId) shiftId = open.id;
  else flags.push('late-sync');
  const qtyBy = new Map();
  const lines = op.lines.map((l) => {
    const f = findVariant(state, l.variantId);
    if (!f) bad('An item in the cart no longer exists');
    if (!f.p.active) bad(`${f.p.name} is archived`);
    if (!isInt(l.qty) || l.qty < 1 || l.qty > 999) bad('Quantity must be 1 to 999');
    qtyBy.set(f.v.id, (qtyBy.get(f.v.id) || 0) + l.qty);
    let price = f.v.price;
    if (offline) {
      if (!isInt(l.price) || ![f.v.price, ...(f.v.prices || [])].includes(l.price)) bad(`Offline price for ${f.p.name} is not a known price`);
      if (l.price !== f.v.price) flags.push('old-price');
      price = l.price;
    }
    return { variantId: f.v.id, name: f.p.name, nameAr: f.p.nameAr, label: f.v.label, labelAr: f.v.labelAr, qty: l.qty, price, cost: f.v.cost };
  });
  for (const [vid, q] of qtyBy) {
    const f = findVariant(state, vid);
    if (f.v.stock < q) {
      if (!offline) bad(`Not enough stock for ${f.p.name} ${f.v.label} (only ${Math.max(0, f.v.stock)} left)`);
      flags.push('oversold');
    }
  }
  const priced = priceSale({ lines, discount: op.discount }, { role: ctx.user.role, rate: state.settings.vat });
  const pay = checkPayments(op.payments, priced.total);
  const sale = { id: op.id, no: 'S-' + pad(++state.seq.sale), t, cashier: ctx.user.id, cashierName: ctx.user.name, shiftId, lines, ...priced, pay, offline, flags: [...new Set(flags)], refund: null };
  state.sales.push(sale);
  for (const [vid, q] of qtyBy) {
    const f = findVariant(state, vid);
    f.v.stock -= q;
    logMove(state, { t, variantId: vid, type: 'sale', qty: -q, after: f.v.stock, ref: sale.no, by: ctx.user.name, reason: '' });
  }
  if (sale.flags.length) audit(state, ctx, 'sale.flag', `${sale.no}: ${sale.flags.join(', ')}`);
  return { sale };
}

function opProduct(state, op, ctx) {
  const name = clean(op.name, 80);
  if (!name) bad('Product name is required');
  if (!Array.isArray(op.variants) || !op.variants.length || op.variants.length > 12) bad('Add 1 to 12 variants');
  let p = op.id && state.products.find((x) => x.id === op.id);
  if (op.id && !p) bad('Product not found');
  const isNew = !p;
  const codes = new Map();
  for (const { v } of allVariants(state)) { codes.set('s:' + v.sku.toLowerCase(), v.id); if (v.barcode) codes.set('b:' + v.barcode.toLowerCase(), v.id); }
  const mine = new Set();
  const seenNow = new Set();
  const vs = op.variants.map((x) => {
    const existing = x.id && (p ? p.variants.find((v) => v.id === x.id) : null);
    if (x.id && !existing) bad('Variant not found');
    const sku = clean(x.sku, 30), barcode = clean(x.barcode, 30);
    if (!sku) bad('Each variant needs a SKU');
    for (const [k, code] of [['s:', sku], ['b:', barcode]]) {
      if (!code) continue;
      const key = k + code.toLowerCase();
      const owner = codes.get(key);
      if (seenNow.has(key) || (owner && owner !== existing?.id)) bad(`${k === 's:' ? 'SKU' : 'Barcode'} ${code} is already used`);
      seenNow.add(key);
    }
    if (!isInt(x.price) || x.price < 1 || x.price > 100000000) bad('Price must be more than zero');
    if (!isInt(x.cost) || x.cost < 0 || x.cost > 100000000) bad('Bad cost');
    if (!isInt(x.reorder) || x.reorder < 0 || x.reorder > 100000) bad('Bad reorder level');
    const label = clean(x.label, 40);
    if (!label) bad('Each variant needs a label');
    if (existing) mine.add(existing.id);
    return { existing, sku, barcode, label, labelAr: clean(x.labelAr, 40) || label, price: x.price, cost: x.cost, reorder: x.reorder, stock: x.stock };
  });
  if (isNew) { p = { id: 'p' + ++state.seq.product, variants: [], active: true }; state.products.push(p); }
  Object.assign(p, { name, nameAr: clean(op.nameAr, 80) || name, category: clean(op.category, 40) || 'General', categoryAr: clean(op.categoryAr, 40) || clean(op.category, 40) || 'عام' });
  for (const x of vs) {
    if (x.existing) {
      const v = x.existing;
      if (v.price !== x.price) v.prices = [v.price, ...(v.prices || [])].slice(0, 5);
      Object.assign(v, { sku: x.sku, barcode: x.barcode, label: x.label, labelAr: x.labelAr, price: x.price, cost: x.cost, reorder: x.reorder });
    } else {
      const start = isInt(x.stock) && x.stock > 0 && x.stock <= 1000000 ? x.stock : 0;
      const v = { id: 'v' + ++state.seq.variant, sku: x.sku, barcode: x.barcode, label: x.label, labelAr: x.labelAr, price: x.price, cost: x.cost, stock: start, reorder: x.reorder, prices: [] };
      p.variants.push(v);
      if (start) logMove(state, { t: ctx.now, variantId: v.id, type: 'opening', qty: start, after: start, ref: '', by: ctx.user.name, reason: 'opening stock' });
    }
  }
  audit(state, ctx, isNew ? 'product.create' : 'product.update', name);
  return { product: p };
}

export function compact(state) {
  if (state.sales.length > 3000) state.sales.splice(0, state.sales.length - 3000);
  if (state.movements.length > 6000) state.movements.splice(0, state.movements.length - 6000);
  if (state.audit.length > 1000) state.audit.splice(0, state.audit.length - 1000);
}

// ---------- what each role is allowed to see ----------
export function view(state, user, now) {
  const me = { id: user.id, name: user.name, role: user.role };
  const base = { me, settings: state.settings, now, resetAt: state.resetAt, myShift: openShiftOf(state, user.id) };
  const strip = (p) => ({ ...p, variants: p.variants.map(({ cost, ...v }) => v) });
  if (user.role !== ROLES.owner) {
    const mine = state.sales.filter((s) => s.cashier === user.id).slice(-40).reverse().map((s) => ({ ...s, lines: s.lines.map(({ cost, ...l }) => l) }));
    return { ...base, products: state.products.filter((p) => p.active).map(strip), mySales: mine, myShiftTotals: base.myShift ? shiftTotals(state, base.myShift) : null };
  }
  return {
    ...base,
    products: state.products,
    suppliers: state.suppliers,
    purchases: state.purchases.slice().reverse(),
    sales: state.sales,
    shifts: state.shifts.slice().reverse().map((s) => (s.closedAt ? s : { ...s, ...shiftTotals(state, s) })),
    movements: state.movements.slice(-500).reverse(),
    audit: state.audit.slice(-200).reverse(),
    myShiftTotals: base.myShift ? shiftTotals(state, base.myShift) : null,
  };
}

// ---------- reports ----------
export function salesReport(state, fromT, toT) {
  const sales = state.sales.filter((s) => s.t >= fromT && s.t < toT);
  const r = { count: 0, gross: 0, vat: 0, net: 0, cogs: 0, profit: 0, discounts: 0, refunds: 0, refundCount: 0, cash: 0, card: 0, byDay: {}, top: [], bySeller: {} };
  const items = new Map();
  for (const s of sales) {
    const day = (r.byDay[dayKey(s.t)] ||= { gross: 0, net: 0, profit: 0, count: 0 });
    if (s.refund) { r.refunds += s.total; r.refundCount++; continue; }
    const cogs = s.lines.reduce((a, l) => a + l.cost * l.qty, 0);
    const net = s.total - s.vat;
    r.count++; r.gross += s.total; r.vat += s.vat; r.net += net; r.cogs += cogs; r.profit += net - cogs; r.discounts += s.discount;
    r.cash += s.pay.cashNet; r.card += s.pay.card;
    day.gross += s.total; day.net += net; day.profit += net - cogs; day.count++;
    const sel = (r.bySeller[s.cashierName] ||= { gross: 0, count: 0 });
    sel.gross += s.total; sel.count++;
    for (const l of s.lines) {
      const it = items.get(l.variantId) || { variantId: l.variantId, name: l.name, nameAr: l.nameAr, label: l.label, labelAr: l.labelAr, qty: 0, revenue: 0, profit: 0 };
      // Revenue and profit per item are shown before the cart-level discount.
      it.qty += l.qty; it.revenue += l.price * l.qty; it.profit += (l.price - l.cost) * l.qty;
      items.set(l.variantId, it);
    }
  }
  r.top = [...items.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  r.avgTicket = r.count ? Math.round(r.gross / r.count) : 0;
  r.margin = r.net ? r.profit / r.net : 0;
  return r;
}

// ---------- CSV (cells that start with = + - @ are neutralised so a spreadsheet never runs them) ----------
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: TZ, hour12: false });
export function salesCsv(state, fromT, toT) {
  const rows = [['Sale', 'Date (Cairo)', 'Cashier', 'Items', 'Subtotal', 'Discount', 'Total', 'VAT incl.', 'Cash', 'Card', 'Status', 'Flags']];
  for (const s of state.sales.filter((x) => x.t >= fromT && x.t < toT)) {
    rows.push([s.no, when(s.t), s.cashierName, s.lines.reduce((a, l) => a + l.qty, 0), egp(s.subtotal), egp(s.discount), egp(s.total), egp(s.vat), egp(s.pay.cashNet), egp(s.pay.card), s.refund ? 'refunded' : 'paid', s.flags.join(' ')]);
  }
  return toCsv(rows);
}
export function stockCsv(state) {
  const rows = [['SKU', 'Barcode', 'Product', 'Variant', 'Category', 'In stock', 'Reorder at', 'Unit cost', 'Price', 'Stock value (cost)']];
  for (const { p, v } of allVariants(state)) rows.push([v.sku, v.barcode, p.name, v.label, p.category, v.stock, v.reorder, egp(v.cost), egp(v.price), egp(Math.max(0, v.stock) * v.cost)]);
  return toCsv(rows);
}
export function reportCsv(r) {
  const rows = [['Day', 'Sales', 'Gross', 'Net of VAT', 'Profit']];
  for (const d of Object.keys(r.byDay).sort()) rows.push([d, r.byDay[d].count, egp(r.byDay[d].gross), egp(r.byDay[d].net), egp(r.byDay[d].profit)]);
  rows.push(['Total', r.count, egp(r.gross), egp(r.net), egp(r.profit)]);
  return toCsv(rows);
}

// ---------- demo data ----------
const CATS = { drinks: ['Drinks', 'مشروبات'], snacks: ['Snacks', 'وجبات خفيفة'], stationery: ['Stationery', 'أدوات مكتبية'], phone: ['Phone accessories', 'إكسسوارات موبايل'], clothing: ['Clothing', 'ملابس'], cleaning: ['Cleaning', 'منظفات'] };
// [name, nameAr, cat, [[label, labelAr, price EGP, cost EGP, reorder]...]]
const CATALOG = [
  ['Mineral water', 'مياه معدنية', 'drinks', [['600 ml', '٦٠٠ مل', 5, 3.2, 24], ['1.5 L', '١.٥ لتر', 9, 5.5, 18]]],
  ['Cola', 'كولا', 'drinks', [['330 ml can', 'علبة ٣٣٠ مل', 18, 13, 24], ['1 L bottle', 'زجاجة ١ لتر', 30, 22, 12]]],
  ['Orange juice', 'عصير برتقال', 'drinks', [['250 ml', '٢٥٠ مل', 10, 7, 20], ['1 L', '١ لتر', 32, 24, 10]]],
  ['Potato chips', 'شيبسي', 'snacks', [['Small', 'صغير', 10, 7, 30], ['Large', 'كبير', 25, 18, 15]]],
  ['Biscuits', 'بسكويت', 'snacks', [['Chocolate', 'شوكولاتة', 12, 8.5, 20], ['Vanilla', 'فانيليا', 12, 8.5, 20]]],
  ['Chocolate bar', 'لوح شوكولاتة', 'snacks', [['Milk', 'بالحليب', 20, 14, 16], ['Hazelnut', 'بالبندق', 25, 17, 12]]],
  ['Notebook A5', 'كراسة A5', 'stationery', [['60 sheets', '٦٠ ورقة', 22, 14, 20], ['100 sheets', '١٠٠ ورقة', 35, 23, 15]]],
  ['Ballpoint pens (12)', 'أقلام حبر (١٢)', 'stationery', [['Blue', 'أزرق', 48, 32, 8], ['Black', 'أسود', 48, 32, 8]]],
  ['Highlighters', 'أقلام تحديد', 'stationery', [['Yellow', 'أصفر', 15, 9, 10], ['Set of 4', 'طقم ٤', 55, 36, 6]]],
  ['Phone cable', 'كابل شاحن', 'phone', [['USB-C 1 m', 'USB-C ١ م', 90, 48, 12], ['Lightning 1 m', 'لايتنج ١ م', 140, 85, 8], ['Micro-USB 1 m', 'مايكرو ١ م', 70, 38, 8]]],
  ['Wall charger 20W', 'شاحن حائط ٢٠ واط', 'phone', [['White', 'أبيض', 220, 150, 6], ['Black', 'أسود', 220, 150, 6]]],
  ['Earphones', 'سماعات', 'phone', [['Wired', 'سلك', 120, 70, 8], ['Bluetooth', 'بلوتوث', 350, 230, 5]]],
  ['Phone case', 'جراب موبايل', 'phone', [['Model A', 'موديل A', 80, 40, 8], ['Model B', 'موديل B', 80, 40, 8]]],
  ['Cotton T-shirt', 'تيشيرت قطن', 'clothing', [['S', 'S', 250, 150, 4], ['M', 'M', 250, 150, 4], ['L', 'L', 250, 150, 4], ['XL', 'XL', 250, 150, 3]]],
  ['Cotton socks', 'شرابات قطن', 'clothing', [['Pack of 3', 'عبوة ٣', 90, 55, 8], ['Pack of 6', 'عبوة ٦', 160, 100, 5]]],
  ['Cap', 'كاب', 'clothing', [['Black', 'أسود', 140, 80, 4], ['Navy', 'كحلي', 140, 80, 4]]],
  ['Dish soap', 'سائل أطباق', 'cleaning', [['750 ml', '٧٥٠ مل', 45, 32, 10], ['1.5 L', '١.٥ لتر', 80, 58, 6]]],
  ['Laundry powder', 'مسحوق غسيل', 'cleaning', [['1 kg', '١ كجم', 85, 62, 8], ['3 kg', '٣ كجم', 230, 170, 5]]],
  ['Tissues', 'مناديل', 'cleaning', [['Box', 'علبة', 25, 16, 15], ['6-pack', '٦ علب', 130, 90, 6]]],
  ['Bleach', 'مبيض', 'cleaning', [['1 L', '١ لتر', 35, 24, 8]]],
];

function ean13(body12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(body12[i]) * (i % 2 ? 3 : 1);
  return body12 + ((10 - (s % 10)) % 10);
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const DEMO_USERS = [
  { id: 'u-owner', name: 'Owner', role: 'owner', pin: '1111' },
  { id: 'u-mona', name: 'Mona', role: 'cashier', pin: '2222' },
  { id: 'u-karim', name: 'Karim', role: 'cashier', pin: '3333' },
];

function buildEmpty(now, startStock) {
  const st = { v: 1, resetAt: now, seq: { sale: 1040, shift: 0, move: 0, po: 0, product: 0, variant: 0, supplier: 0 }, settings: { shop: 'Baraka Mini Market', shopAr: 'ميني ماركت البركة', vat: 14, currency: 'EGP' }, users: DEMO_USERS.map((u) => ({ ...u })), products: [], suppliers: [], purchases: [], sales: [], shifts: [], movements: [], audit: [] };
  CATALOG.forEach(([name, nameAr, cat, vars], i) => {
    const p = { id: 'p' + ++st.seq.product, name, nameAr, category: CATS[cat][0], categoryAr: CATS[cat][1], active: true, variants: [] };
    vars.forEach(([label, labelAr, price, cost, reorder], j) => {
      const id = ++st.seq.variant;
      p.variants.push({ id: 'v' + id, sku: `MK-${String(id).padStart(3, '0')}`, barcode: ean13('622' + String(100000 + i * 37 + j * 7 + id * 1013).padStart(9, '0').slice(-9)), label, labelAr, price: Math.round(price * 100), cost: Math.round(cost * 100), stock: startStock(id, reorder), reorder, prices: [] });
    });
    st.products.push(p);
  });
  st.suppliers.push({ id: 'sp' + ++st.seq.supplier, name: 'Delta Wholesale', phone: '+20 100 000 0001', note: 'Drinks and snacks, delivers Sunday and Wednesday' });
  st.suppliers.push({ id: 'sp' + ++st.seq.supplier, name: 'Nile Gadgets', phone: '+20 100 000 0002', note: 'Phone accessories' });
  st.suppliers.push({ id: 'sp' + ++st.seq.supplier, name: 'Cairo Clean and Paper', phone: '+20 100 000 0003', note: 'Cleaning and stationery' });
  return st;
}

// Builds 14 days of believable history by replaying real operations at past times, so every number
// (stock, movements, shift cash, reports) comes from the same rules as live use.
export function seed(now = Date.now()) {
  const owner = DEMO_USERS[0], cashiers = [DEMO_USERS[1], DEMO_USERS[2]];
  const run = (startStock, record) => {
    const st = buildEmpty(now, startStock);
    const rand = rng(20261125);
    const vars = allVariants(st).map((x) => x.v);
    const day0 = Date.parse(dayKey(now) + 'T00:00:00Z') - 2 * 3600 * 1000;
    const sold = new Map();
    const act = (u, t, op) => applyOp(st, op, { user: u, now: t });
    const pick = () => { const w = vars.map((v, i) => 1 / (1 + (i % 9) * 0.35 + (v.price > 20000 ? 1.5 : 0))); let r = rand() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < vars.length; i++) { r -= w[i]; if (r <= 0) return vars[i]; } return vars[0]; };
    for (let d = 13; d >= 0; d--) {
      const base = day0 - d * 86400000;
      const dow = new Date(base + 3 * 3600000).getUTCDay();
      const cashier = cashiers[d % 2];
      const openT = base + 9 * 3600000;
      if (openT > now - 5 * 60000) continue;
      act(cashier, openT, { type: 'shift.open', opening: 50000 });
      const n = Math.round((dow === 5 || dow === 6 ? 25 : 17) + rand() * 7);
      const times = Array.from({ length: n }, () => openT + 20 * 60000 + Math.floor(rand() * 11.2 * 3600000)).sort((a, b) => a - b);
      for (const t of times) {
        if (t > now - 60000) break;
        const lines = [], seen = new Set();
        const k = 1 + Math.floor(rand() * 3.2);
        for (let i = 0; i < k; i++) { const v = pick(); if (seen.has(v.id)) continue; seen.add(v.id); lines.push({ variantId: v.id, qty: rand() < 0.2 ? 2 : 1 }); }
        const discount = rand() < 0.12 ? (rand() < 0.5 ? { type: 'pct', value: 5 } : { type: 'pct', value: 10 }) : null;
        const sub = lines.reduce((a, l) => { const v = vars.find((x) => x.id === l.variantId); return a + v.price * l.qty; }, 0);
        const total = sub - (discount ? Math.round((sub * discount.value) / 100) : 0);
        const m = rand();
        let payments;
        if (m < 0.5) payments = [{ method: 'cash', amount: m < 0.25 ? total : Math.ceil(total / 500) * 500 }];
        else if (m < 0.88) payments = [{ method: 'card', amount: total }];
        else { const c = Math.min(total - 100, Math.ceil((total / 2) / 500) * 500); payments = [{ method: 'cash', amount: c }, { method: 'card', amount: total - c }]; }
        const res = act(cashier, t, { type: 'sale', id: 'seed-' + d + '-' + t, lines, discount, payments });
        for (const l of res.sale.lines) sold.set(l.variantId, (sold.get(l.variantId) || 0) + l.qty);
      }
      if (d === 9 && st.suppliers.length) {
        const low = vars.slice(0, 8);
        const po = act(owner, base + 11 * 3600000, { type: 'po.create', supplierId: 'sp1', lines: low.map((v) => ({ variantId: v.id, qty: v.reorder * 3, cost: Math.round(v.cost * 1.03) })) }).purchase;
        act(owner, base + 12 * 3600000, { type: 'po.receive', id: po.id });
      }
      if (d === 4) act(owner, base + 14 * 3600000, { type: 'adjust', variantId: 'v3', delta: -2, reason: 'damage' });
      if (d === 3) {
        const target = st.sales.filter((s) => s.cashier === cashier.id && !s.refund && s.t > openT && s.discount === 0).pop();
        if (target) act(owner, base + 16 * 3600000, { type: 'refund', saleId: target.id, reason: 'Customer returned the item' });
      }
      if (d === 2) act(owner, base + 15 * 3600000, { type: 'adjust', variantId: 'v9', counted: Math.max(0, findVariant(st, 'v9').v.stock - 1), reason: 'count' });
      if (d > 0) {
        const t = shiftTotals(st, st.shifts[st.shifts.length - 1]);
        const variance = [0, 0, 0, -500, 0, 200, 0, -1000, 0, 0, 0, 0, 100, 0][d] || 0;
        act(cashier, openT + 12.4 * 3600000, { type: 'shift.close', counted: t.expected + variance, note: variance ? (variance < 0 ? 'Short, change given twice' : 'Over, a customer left the change') : '' });
      }
    }
    if (record) {
      const sp = st.suppliers[1];
      act(owner, now - 20 * 3600000, { type: 'po.create', supplierId: sp.id, lines: vars.filter((v) => ['Lightning 1 m', 'Bluetooth'].includes(v.label)).map((v) => ({ variantId: v.id, qty: 6, cost: v.cost })) });
    }
    return { st, sold };
  };
  // Pass 1 with plenty of stock shows how much leaves each item and how low it dips; pass 2 starts each item so
  // today's stock lands at a chosen level (never below zero on the way).
  const BIG = 100000;
  const first = run(() => BIG, false);
  const rand2 = rng(777);
  const minAfter = new Map();
  for (const m of first.st.movements) minAfter.set(m.variantId, Math.min(minAfter.get(m.variantId) ?? BIG, m.after));
  const finals = new Map();
  allVariants(first.st).forEach(({ v }) => { const r = rand2(); finals.set(v.id, r < 0.14 ? Math.max(0, v.reorder - 1 - Math.floor(r * 10)) : v.reorder + 4 + Math.floor(rand2() * v.reorder * 3)); });
  const start = (id) => {
    const vid = 'v' + id, end1 = allVariants(first.st).find((x) => x.v.id === vid).v.stock;
    const netOut = BIG - end1;
    return Math.max(finals.get(vid) + netOut, BIG - (minAfter.get(vid) ?? BIG) + 0);
  };
  const final = run(start, true);
  const st = final.st;
  st.resetAt = now;
  st.audit.push({ t: now, by: 'System', action: 'demo.reset', detail: 'Demo data created' });
  return st;
}
