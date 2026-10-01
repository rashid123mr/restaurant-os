// Load .env only in local development; Railway injects env vars automatically
if (process.env.NODE_ENV !== 'production') { try { require('dotenv').config(); } catch {} }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const S = require('./services');
const { runAgent } = require('./agent');

const SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change-me' ? process.env.JWT_SECRET : (() => {
  console.warn('WARNING: JWT_SECRET is not set. Using a temporary secret; everyone is signed out on each restart.');
  return crypto.randomBytes(32).toString('hex');
})();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const hits = new Map();
const limit = (bucket, max) => (req, res, next) => {
  const k = bucket + req.ip, t = Date.now();
  const h = (hits.get(k) || []).filter((x) => t - x < 60000);
  if (h.length >= max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  h.push(t); hits.set(k, h); next();
};
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

const h = (fn) => async (req, res) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); }
  catch (e) {
    const s = e.status || 500;
    if (s === 500) console.error(e);
    res.status(s).json({ error: s === 500 ? 'Something went wrong on the server' : e.message });
  }
};
const sign = (u) => ({ token: jwt.sign({ uid: u.uid, rid: u.rid, role: u.role, name: u.name }, SECRET, { expiresIn: '12h' }), user: { name: u.name, role: u.role, slug: u.slug } });

const auth = (...roles) => (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    if (roles.length && !roles.includes(p.role)) return res.status(403).json({ error: 'You do not have permission to do this' });
    req.ctx = { rid: p.rid, uid: p.uid, role: p.role, source: 'ui' };
    next();
  } catch { res.status(401).json({ error: 'Sign in required' }); }
};
const staff = auth();
const mgr = auth('owner', 'manager');
const owner = auth('owner');

/* ---- accounts ---- */
app.post('/api/register', limit('reg', 10), h((req) => sign(S.registerRestaurant(req.body))));
app.post('/api/login', limit('login', 10), h((req) => sign(S.login(req.body))));

/* ---- public customer ordering ---- */
app.get('/api/public/:slug', h((req) => {
  const r = S.getRestaurantBySlug(req.params.slug);
  return { name: r.name, currency: r.currency, tax_rate: r.tax_rate, menu: S.getMenu({ rid: r.id }, { onlyAvailable: true }).filter((c) => c.items.length) };
}));
app.post('/api/public/:slug/orders', limit('order', 20), h((req) => {
  const r = S.getRestaurantBySlug(req.params.slug);
  return S.createOrder({ rid: r.id, source: 'customer' }, req.body);
}));
app.get('/api/public/:slug/orders/:id', h((req) => S.trackOrder({ rid: S.getRestaurantBySlug(req.params.slug).id }, { id: req.params.id, code: req.query.code })));

/* ---- image upload (Cloudinary) ---- */
app.post('/api/upload', mgr, h(async (req) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new S.HttpError(503, 'Image uploads are not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to your environment variables.');
  // Return signed upload params so browser uploads directly to Cloudinary
  const timestamp = Math.round(Date.now() / 1000);
  const folder = `restaurant-os/${req.ctx.rid}`;
  const toSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');
  return { cloudName, apiKey, timestamp, folder, signature };
}));

/* ---- dashboard API ---- */
app.get('/api/me', staff, h((req) => ({ ...S.getSettings(req.ctx), role: req.ctx.role })));
app.get('/api/menu', staff, h((req) => S.getMenu(req.ctx)));
app.post('/api/categories', mgr, h((req) => S.addCategory(req.ctx, req.body)));
app.delete('/api/categories/:id', mgr, h((req) => S.deleteCategory(req.ctx, req.params)));
app.post('/api/items', mgr, h((req) => S.addItem(req.ctx, req.body)));
app.patch('/api/items/:id', staff, h((req) => {
  const body = req.ctx.role === 'staff' ? { available: req.body.available } : req.body;
  return S.updateItem(req.ctx, { ...body, item: req.params.id });
}));
app.delete('/api/items/:id', mgr, h((req) => S.deleteItem(req.ctx, req.params)));
app.post('/api/prices/adjust', mgr, h((req) => S.adjustPrices(req.ctx, req.body)));

app.get('/api/tables', staff, h((req) => S.listTables(req.ctx)));
app.post('/api/tables', mgr, h((req) => S.addTable(req.ctx, req.body)));
app.delete('/api/tables/:id', mgr, h((req) => S.deleteTable(req.ctx, req.params)));

app.get('/api/orders', staff, h((req) => S.listOrders(req.ctx, req.query)));
app.post('/api/orders', staff, h((req) => S.createOrder(req.ctx, req.body)));
app.patch('/api/orders/:id', staff, h((req) => S.setOrderStatus(req.ctx, { id: req.params.id, status: req.body.status })));
app.patch('/api/orders/:id/payment', staff, h((req) => S.setPaymentStatus(req.ctx, { id: req.params.id, payment_status: req.body.payment_status })));
app.get('/api/orders/:id/receipt', staff, h((req) => S.getOrderReceipt(req.ctx, { id: req.params.id })));

app.get('/api/reports/sales', mgr, h((req) => S.salesReport(req.ctx, req.query)));
app.get('/api/audit', mgr, h((req) => S.auditLog(req.ctx)));
app.put('/api/settings', owner, h((req) => S.updateSettings(req.ctx, req.body)));
app.get('/api/staff', mgr, h((req) => S.listStaff(req.ctx)));
app.post('/api/staff', owner, h((req) => S.addStaff(req.ctx, req.body)));
app.delete('/api/staff/:id', owner, h((req) => S.removeStaff(req.ctx, req.params)));

/* ---- Google Sheets ---- */
app.get('/api/sheets', owner, h((req) => S.getSheetConfig(req.ctx)));
app.post('/api/sheets', owner, h((req) => S.saveSheetConfig(req.ctx, { webhook_url: req.body.webhook_url })));
app.delete('/api/sheets', owner, h((req) => S.deleteSheetConfig(req.ctx)));

app.post('/api/agent', mgr, limit('agent', 20), h((req) => runAgent({ ...req.ctx, source: 'agent' }, req.body.prompt)));

/* ---- pages ---- */
const pub = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(pub));
app.get('/r/:slug', (req, res) => res.sendFile(path.join(pub, 'order.html')));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaurant OS running on http://localhost:${PORT}`));
module.exports = app;
