// All business logic lives here. The REST API and the AI agent both call these functions,
// so every change follows the same rules and lands in the same audit log.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);
const now = () => new Date().toISOString();
const r2 = (n) => Math.round(n * 100) / 100;
const str = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v.trim();
};
const num = (v, name, min = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw bad(`${name} must be a number of at least ${min}`);
  return n;
};
const bool = (v) => (v === true || v === 1 || v === 'true' ? 1 : 0);
const tx = (fn) => db.transaction(fn)();

function audit(ctx, action, detail) {
  db.prepare('INSERT INTO audit_log(restaurant_id,user_id,source,action,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(ctx.rid, ctx.uid || null, ctx.source || 'ui', action, JSON.stringify(detail || {}), now());
}

/* ---------- restaurants & auth ---------- */
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'restaurant';

function registerRestaurant({ restaurant_name, name, email, password }) {
  restaurant_name = str(restaurant_name, 'Restaurant name', 80);
  name = str(name, 'Your name', 80);
  email = str(email, 'Email', 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email');
  if (typeof password !== 'string' || password.length < 8) throw bad('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw bad('That email is already registered');
  return tx(() => {
    let slug = slugify(restaurant_name);
    if (db.prepare('SELECT 1 FROM restaurants WHERE slug=?').get(slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
    const rid = Number(db.prepare('INSERT INTO restaurants(name,slug,created_at) VALUES (?,?,?)').run(restaurant_name, slug, now()).lastInsertRowid);
    const uid = Number(db.prepare('INSERT INTO users(restaurant_id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(rid, name, email, bcrypt.hashSync(password, 10), 'owner', now()).lastInsertRowid);
    return { rid, uid, role: 'owner', name, slug };
  });
}

function login({ email, password }) {
  const u = db.prepare('SELECT u.*, r.slug FROM users u JOIN restaurants r ON r.id=u.restaurant_id WHERE u.email=?')
    .get(String(email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) throw new HttpError(401, 'Wrong email or password');
  return { rid: u.restaurant_id, uid: u.id, role: u.role, name: u.name, slug: u.slug };
}

const getRestaurantBySlug = (slug) => {
  const r = db.prepare('SELECT id,name,slug,currency,tax_rate FROM restaurants WHERE slug=?').get(String(slug));
  if (!r) throw notFound('Restaurant not found');
  return r;
};

const getSettings = (ctx) => db.prepare('SELECT name,slug,currency,tax_rate FROM restaurants WHERE id=?').get(ctx.rid);

function updateSettings(ctx, d) {
  const cur = getSettings(ctx);
  const next = {
    name: d.name !== undefined ? str(d.name, 'name', 80) : cur.name,
    currency: d.currency !== undefined ? str(d.currency, 'currency', 5).toUpperCase() : cur.currency,
    tax_rate: d.tax_rate !== undefined ? num(d.tax_rate, 'tax_rate') : cur.tax_rate,
  };
  if (next.tax_rate > 100) throw bad('tax_rate cannot exceed 100');
  db.prepare('UPDATE restaurants SET name=?,currency=?,tax_rate=? WHERE id=?').run(next.name, next.currency, next.tax_rate, ctx.rid);
  audit(ctx, 'settings.update', next);
  return getSettings(ctx);
}

/* ---------- staff ---------- */
const listStaff = (ctx) => db.prepare('SELECT id,name,email,role FROM users WHERE restaurant_id=? ORDER BY id').all(ctx.rid);

function addStaff(ctx, d) {
  const email = str(d.email, 'email', 120).toLowerCase();
  if (!['manager', 'staff'].includes(d.role)) throw bad('role must be manager or staff');
  if (typeof d.password !== 'string' || d.password.length < 8) throw bad('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw bad('That email is already registered');
  const id = Number(db.prepare('INSERT INTO users(restaurant_id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(ctx.rid, str(d.name, 'name', 80), email, bcrypt.hashSync(d.password, 10), d.role, now()).lastInsertRowid);
  audit(ctx, 'staff.add', { email, role: d.role });
  return { id, email, role: d.role };
}

function removeStaff(ctx, { id }) {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND restaurant_id=?').get(Number(id), ctx.rid);
  if (!u) throw notFound('Staff member not found');
  if (u.role === 'owner') throw bad('The owner account cannot be removed');
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  audit(ctx, 'staff.remove', { email: u.email });
}

/* ---------- menu ---------- */
function categoryId(ctx, name, create = true) {
  const n = str(name, 'category', 80);
  const c = db.prepare('SELECT id FROM categories WHERE restaurant_id=? AND lower(name)=lower(?)').get(ctx.rid, n);
  if (c) return c.id;
  if (!create) throw notFound(`Category "${name}" not found`);
  return Number(db.prepare('INSERT INTO categories(restaurant_id,name,sort) VALUES (?,?,COALESCE((SELECT MAX(sort)+1 FROM categories WHERE restaurant_id=?),0))')
    .run(ctx.rid, n, ctx.rid).lastInsertRowid);
}

function findItem(ctx, ref) {
  if (ref === undefined || ref === null || ref === '') throw bad('item is required');
  let row = /^\d+$/.test(String(ref)) ? db.prepare('SELECT * FROM menu_items WHERE id=? AND restaurant_id=?').get(Number(ref), ctx.rid) : null;
  if (!row) {
    const rows = db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? AND lower(name)=lower(?)').all(ctx.rid, String(ref));
    if (rows.length > 1) throw bad(`Several items are named "${ref}"; use the item id`);
    row = rows[0];
  }
  if (!row) throw notFound(`Menu item "${ref}" not found`);
  return row;
}

function getMenu(ctx, { onlyAvailable = false } = {}) {
  const cats = db.prepare('SELECT id,name FROM categories WHERE restaurant_id=? ORDER BY sort,id').all(ctx.rid);
  const items = db.prepare(`SELECT id,category_id,name,description,price,available,image_url FROM menu_items WHERE restaurant_id=? ${onlyAvailable ? 'AND available=1' : ''} ORDER BY id`).all(ctx.rid);
  return cats.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) }));
}

function addCategory(ctx, { name }) {
  const id = categoryId(ctx, name);
  audit(ctx, 'category.add', { name });
  return { id, name };
}

function deleteCategory(ctx, { id }) {
  const c = db.prepare('SELECT * FROM categories WHERE id=? AND restaurant_id=?').get(Number(id), ctx.rid);
  if (!c) throw notFound('Category not found');
  if (db.prepare('SELECT 1 FROM menu_items WHERE category_id=?').get(c.id)) throw bad('Move or delete the items in this category first');
  db.prepare('DELETE FROM categories WHERE id=?').run(c.id);
  audit(ctx, 'category.delete', { name: c.name });
}

function addItem(ctx, d) {
  const name = str(d.name, 'name', 100);
  const price = num(d.price, 'price');
  const cid = categoryId(ctx, d.category);
  const image_url = d.image_url ? String(d.image_url).slice(0, 500) : '';
  const id = Number(db.prepare('INSERT INTO menu_items(restaurant_id,category_id,name,description,price,available,image_url,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(ctx.rid, cid, name, String(d.description || '').slice(0, 500), r2(price), d.available === false ? 0 : 1, image_url, now()).lastInsertRowid);
  audit(ctx, 'item.add', { id, name, price });
  return { id, name, price: r2(price), image_url };
}

function updateItem(ctx, d) {
  const it = findItem(ctx, d.item ?? d.id);
  const next = {
    name: d.name !== undefined ? str(d.name, 'name', 100) : it.name,
    description: d.description !== undefined ? String(d.description).slice(0, 500) : it.description,
    price: d.price !== undefined ? r2(num(d.price, 'price')) : it.price,
    available: d.available !== undefined ? bool(d.available) : it.available,
    category_id: d.category !== undefined ? categoryId(ctx, d.category) : it.category_id,
    image_url: d.image_url !== undefined ? String(d.image_url).slice(0, 500) : (it.image_url || ''),
  };
  db.prepare('UPDATE menu_items SET name=?,description=?,price=?,available=?,category_id=?,image_url=? WHERE id=?')
    .run(next.name, next.description, next.price, next.available, next.category_id, next.image_url, it.id);
  audit(ctx, 'item.update', { id: it.id, before: { name: it.name, price: it.price, available: it.available }, after: next });
  return { id: it.id, ...next };
}

function deleteItem(ctx, { id }) {
  const it = findItem(ctx, id);
  db.prepare('DELETE FROM menu_items WHERE id=?').run(it.id);
  audit(ctx, 'item.delete', { id: it.id, name: it.name });
}

function setCategoryAvailability(ctx, { category, available }) {
  const cid = categoryId(ctx, category, false);
  const n = db.prepare('UPDATE menu_items SET available=? WHERE category_id=? AND restaurant_id=?').run(bool(available), cid, ctx.rid).changes;
  audit(ctx, 'category.availability', { category, available: !!bool(available), items: n });
  return { category, available: !!bool(available), items_changed: n };
}

function adjustPrices(ctx, { percent, category }) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p === 0 || Math.abs(p) > 50) throw bad('percent must be non-zero and between -50 and 50');
  const rows = category
    ? db.prepare('SELECT id,price FROM menu_items WHERE restaurant_id=? AND category_id=?').all(ctx.rid, categoryId(ctx, category, false))
    : db.prepare('SELECT id,price FROM menu_items WHERE restaurant_id=?').all(ctx.rid);
  const upd = db.prepare('UPDATE menu_items SET price=? WHERE id=?');
  tx(() => rows.forEach((r) => upd.run(r2(r.price * (1 + p / 100)), r.id)));
  audit(ctx, 'prices.adjust', { percent: p, category: category || 'all', items: rows.length });
  return { percent: p, category: category || 'all', items_changed: rows.length };
}

/* ---------- tables ---------- */
const listTables = (ctx) => db.prepare('SELECT id,label,seats FROM dining_tables WHERE restaurant_id=? ORDER BY id').all(ctx.rid);

function addTable(ctx, d) {
  const label = str(d.label, 'label', 40);
  const seats = Math.round(num(d.seats ?? 2, 'seats', 1));
  const id = Number(db.prepare('INSERT INTO dining_tables(restaurant_id,label,seats) VALUES (?,?,?)').run(ctx.rid, label, seats).lastInsertRowid);
  audit(ctx, 'table.add', { label, seats });
  return { id, label, seats };
}

function deleteTable(ctx, { id }) {
  const n = db.prepare('DELETE FROM dining_tables WHERE id=? AND restaurant_id=?').run(Number(id), ctx.rid).changes;
  if (!n) throw notFound('Table not found');
  audit(ctx, 'table.delete', { id });
}

/* ---------- orders ---------- */
const FLOW = { new: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['completed'], completed: [], cancelled: [] };

function createOrder(ctx, d) {
  const type = d.type;
  if (!['dine_in', 'pickup', 'delivery'].includes(type)) throw bad('type must be dine_in, pickup or delivery');
  const customer = str(d.customer_name, 'Your name', 80);
  const phone = d.phone ? String(d.phone).slice(0, 30) : null;
  if (type !== 'dine_in' && !phone) throw bad('A phone number is required for pickup and delivery');
  const address = d.address ? String(d.address).slice(0, 300) : null;
  if (type === 'delivery' && !address) throw bad('A delivery address is required');
  let tableId = null;
  if (type === 'dine_in' && d.table_id) {
    const t = db.prepare('SELECT id FROM dining_tables WHERE id=? AND restaurant_id=?').get(Number(d.table_id), ctx.rid);
    if (!t) throw bad('Unknown table');
    tableId = t.id;
  }
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 50) throw bad('Add at least one item');
  const rate = db.prepare('SELECT tax_rate FROM restaurants WHERE id=?').get(ctx.rid).tax_rate;
  return tx(() => {
    const lines = d.items.map((l) => {
      const qty = Math.round(num(l.qty, 'quantity', 1));
      if (qty > 99) throw bad('Quantity too large');
      const it = db.prepare('SELECT * FROM menu_items WHERE id=? AND restaurant_id=?').get(Number(l.menu_item_id), ctx.rid);
      if (!it) throw bad('An item in your order no longer exists');
      if (!it.available) throw bad(`${it.name} is not available right now`);
      return { it, qty };
    });
    const subtotal = r2(lines.reduce((s, l) => s + l.it.price * l.qty, 0));
    const tax = r2(subtotal * rate / 100);
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const id = Number(db.prepare('INSERT INTO orders(restaurant_id,type,table_id,customer_name,phone,address,note,subtotal,tax,total,track_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ctx.rid, type, tableId, customer, phone, address, d.note ? String(d.note).slice(0, 300) : null, subtotal, tax, r2(subtotal + tax), code, now()).lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_items(order_id,menu_item_id,name,price,qty) VALUES (?,?,?,?,?)');
    lines.forEach((l) => ins.run(id, l.it.id, l.it.name, l.it.price, l.qty));
    audit(ctx, 'order.create', { id, total: r2(subtotal + tax) });
    // Sync to Google Sheets if connected
    syncToSheet(ctx, 'new', { id, customer, type, total: r2(subtotal + tax), created_at: now() }).catch(() => {});
    return { id, track_code: code, subtotal, tax, total: r2(subtotal + tax), status: 'new', payment_status: 'unpaid' };
  });
}

function listOrders(ctx, { status, limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit) || 100, 1), 300);
  const rows = status
    ? db.prepare('SELECT o.*, t.label AS table_label FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id WHERE o.restaurant_id=? AND o.status=? ORDER BY o.id DESC LIMIT ?').all(ctx.rid, status, lim)
    : db.prepare('SELECT o.*, t.label AS table_label FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id WHERE o.restaurant_id=? ORDER BY o.id DESC LIMIT ?').all(ctx.rid, lim);
  const items = db.prepare(`SELECT order_id,name,price,qty FROM order_items WHERE order_id IN (${rows.map(() => '?').join(',') || 'NULL'})`).all(...rows.map((r) => r.id));
  return rows.map(({ track_code, ...o }) => ({ ...o, items: items.filter((i) => i.order_id === o.id) }));
}

function setOrderStatus(ctx, { id, status }) {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND restaurant_id=?').get(Number(id), ctx.rid);
  if (!o) throw notFound('Order not found');
  if (!FLOW[o.status].includes(status)) throw bad(`An order that is ${o.status} cannot become ${status}`);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, o.id);
  audit(ctx, 'order.status', { id: o.id, from: o.status, to: status });
  // Sync completed orders to Google Sheets
  if (status === 'completed') {
    const items = db.prepare('SELECT name,price,qty FROM order_items WHERE order_id=?').all(o.id);
    syncToSheet(ctx, 'completed', { id: o.id, customer_name: o.customer_name, type: o.type, total: o.total, created_at: o.created_at }).catch(() => {});
  }
  return { id: o.id, status };
}

function setPaymentStatus(ctx, { id, payment_status }) {
  if (!['paid', 'unpaid'].includes(payment_status)) throw bad('payment_status must be paid or unpaid');
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND restaurant_id=?').get(Number(id), ctx.rid);
  if (!o) throw notFound('Order not found');
  db.prepare('UPDATE orders SET payment_status=? WHERE id=?').run(payment_status, o.id);
  audit(ctx, 'order.payment', { id: o.id, payment_status });
  return { id: o.id, payment_status };
}

function trackOrder(ctx, { id, code }) {
  const o = db.prepare('SELECT id,status,total,type,track_code FROM orders WHERE id=? AND restaurant_id=?').get(Number(id), ctx.rid);
  if (!o || o.track_code !== String(code || '').toUpperCase()) throw notFound('Order not found');
  const { track_code, ...pub } = o;
  return pub;
}

function getOrderReceipt(ctx, { id }) {
  const o = db.prepare('SELECT o.*, t.label AS table_label FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id WHERE o.id=? AND o.restaurant_id=?').get(Number(id), ctx.rid);
  if (!o) throw notFound('Order not found');
  const items = db.prepare('SELECT name,price,qty FROM order_items WHERE order_id=?').all(o.id);
  const restaurant = getSettings(ctx);
  const { track_code, ...order } = o;
  return { ...order, items, restaurant };
}

/* ---------- reports ---------- */
function salesReport(ctx, { from, to } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().slice(0, 10);
  from = day.test(from || '') ? from : today;
  to = day.test(to || '') ? to : today;
  const a = from + 'T00:00:00.000Z', b = to + 'T23:59:59.999Z';
  const where = "restaurant_id=? AND created_at BETWEEN ? AND ? AND status!='cancelled'";
  const t = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders WHERE ${where}`).get(ctx.rid, a, b);
  const top = db.prepare("SELECT oi.name, SUM(oi.qty) qty, ROUND(SUM(oi.qty*oi.price),2) revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.restaurant_id=? AND o.created_at BETWEEN ? AND ? AND o.status!='cancelled' GROUP BY oi.name ORDER BY qty DESC LIMIT 10").all(ctx.rid, a, b);
  const byType = db.prepare(`SELECT type, COUNT(*) orders, ROUND(SUM(total),2) revenue FROM orders WHERE ${where} GROUP BY type`).all(ctx.rid, a, b);
  const byDay = db.prepare(`SELECT substr(created_at,1,10) day, COUNT(*) orders, ROUND(SUM(total),2) revenue FROM orders WHERE ${where} GROUP BY day ORDER BY day`).all(ctx.rid, a, b);
  return { from, to, orders: t.orders, revenue: r2(t.revenue), average_order: t.orders ? r2(t.revenue / t.orders) : 0, top_items: top, by_type: byType, by_day: byDay };
}

const auditLog = (ctx, limit = 50) => db.prepare('SELECT source,action,detail,created_at FROM audit_log WHERE restaurant_id=? ORDER BY id DESC LIMIT ?').all(ctx.rid, Math.min(limit, 200));

/* ---------- Google Sheets ---------- */
function saveSheetConfig(ctx, { sheet_id, credentials }) {
  if (!sheet_id || !credentials) throw bad('sheet_id and credentials are required');
  try { JSON.parse(credentials); } catch { throw bad('credentials must be valid JSON'); }
  const existing = db.prepare('SELECT id FROM google_sheets WHERE restaurant_id=?').get(ctx.rid);
  if (existing) {
    db.prepare('UPDATE google_sheets SET sheet_id=?,credentials=? WHERE restaurant_id=?').run(sheet_id, credentials, ctx.rid);
  } else {
    db.prepare('INSERT INTO google_sheets(restaurant_id,sheet_id,credentials,created_at) VALUES (?,?,?,?)').run(ctx.rid, sheet_id, credentials, now());
  }
  audit(ctx, 'sheets.connect', { sheet_id });
  return { ok: true, sheet_id };
}

function getSheetConfig(ctx) {
  return db.prepare('SELECT sheet_id FROM google_sheets WHERE restaurant_id=?').get(ctx.rid) || null;
}

function deleteSheetConfig(ctx) {
  db.prepare('DELETE FROM google_sheets WHERE restaurant_id=?').run(ctx.rid);
  audit(ctx, 'sheets.disconnect', {});
}

async function syncToSheet(ctx, event, order) {
  const config = db.prepare('SELECT sheet_id,credentials FROM google_sheets WHERE restaurant_id=?').get(ctx.rid);
  if (!config) return;
  try {
    const { GoogleAuth } = require('google-auth-library');
    const { google } = require('googleapis');
    const credentials = JSON.parse(config.credentials);
    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [
      order.id, event, order.customer_name || '', order.type || '',
      order.total, order.created_at, new Date().toISOString()
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheet_id,
      range: 'Sheet1!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  } catch (e) {
    console.error('Google Sheets sync failed:', e.message);
  }
}

module.exports = {
  HttpError, registerRestaurant, login, getRestaurantBySlug, getSettings, updateSettings,
  listStaff, addStaff, removeStaff, getMenu, addCategory, deleteCategory, addItem, updateItem, deleteItem,
  setCategoryAvailability, adjustPrices, listTables, addTable, deleteTable,
  createOrder, listOrders, setOrderStatus, setPaymentStatus, trackOrder, getOrderReceipt,
  salesReport, auditLog, saveSheetConfig, getSheetConfig, deleteSheetConfig, syncToSheet,
};
