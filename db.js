const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const file = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
// Note: foreign_keys left off — integrity enforced at service layer

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'PKR', tax_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','staff')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price REAL NOT NULL,
  available INTEGER NOT NULL DEFAULT 1, image_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  label TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 2
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  type TEXT NOT NULL, table_id INTEGER, customer_name TEXT NOT NULL, phone TEXT, address TEXT,
  note TEXT, status TEXT NOT NULL DEFAULT 'new', payment_status TEXT NOT NULL DEFAULT 'unpaid',
  subtotal REAL NOT NULL, tax REAL NOT NULL,
  total REAL NOT NULL, track_code TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER, name TEXT NOT NULL, price REAL NOT NULL, qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, user_id INTEGER,
  source TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_sheets (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL UNIQUE REFERENCES restaurants(id),
  webhook_url TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_r ON orders(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_items_r ON menu_items(restaurant_id);
`);

// Migrate existing databases — add new columns if they don't exist yet
const cols = db.prepare("PRAGMA table_info(menu_items)").all().map(c => c.name);
if (!cols.includes('image_url')) db.exec("ALTER TABLE menu_items ADD COLUMN image_url TEXT NOT NULL DEFAULT ''");

const ocols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!ocols.includes('payment_status')) db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'");

const rcols = db.prepare("PRAGMA table_info(restaurants)").all().map(c => c.name);
if (!rcols.includes('status')) db.exec("ALTER TABLE restaurants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");

// Seed admin user if not exists
const bcrypt = require('bcryptjs');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'muhammadrashid49055@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MR54321mr@';
const existingAdmin = db.prepare('SELECT id FROM admin_users WHERE email=?').get(ADMIN_EMAIL);
if (!existingAdmin) {
  db.prepare('INSERT INTO admin_users(email,password_hash,created_at) VALUES (?,?,?)')
    .run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 10), new Date().toISOString());
  console.log(`Admin user created: ${ADMIN_EMAIL}`);
}

// Migrate google_sheets table — drop old schema if it has credentials column and recreate
try {
  const gcols = db.prepare("PRAGMA table_info(google_sheets)").all().map(c => c.name);
  if (gcols.includes('credentials')) {
    db.exec("DROP TABLE google_sheets");
    db.exec(`CREATE TABLE IF NOT EXISTS google_sheets (
      id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL UNIQUE REFERENCES restaurants(id),
      webhook_url TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }
} catch(e) {}

module.exports = db;
