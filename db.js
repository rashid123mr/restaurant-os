const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'PKR', tax_rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
  available INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  label TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 2
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  type TEXT NOT NULL, table_id INTEGER, customer_name TEXT NOT NULL, phone TEXT, address TEXT,
  note TEXT, status TEXT NOT NULL DEFAULT 'new', subtotal REAL NOT NULL, tax REAL NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_orders_r ON orders(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_items_r ON menu_items(restaurant_id);
`);

module.exports = db;
