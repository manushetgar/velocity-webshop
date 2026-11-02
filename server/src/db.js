import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { CATALOG, categoryFor } from './catalog.js';

const DB_FILE = process.env.DB_FILE || './data/webshop.db';
mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const ORDER_STATUSES = ['NEW', 'PICKED', 'SHIPPED', 'COMPLETED', 'CANCELED'];

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   TEXT    NOT NULL UNIQUE,          -- business key, same as ERP productID (e.g. DXTR1000)
    name         TEXT    NOT NULL,
    description  TEXT,
    price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),  -- money as integer cents, no float rounding
    currency     TEXT    NOT NULL DEFAULT 'EUR',
    stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    active       INTEGER NOT NULL DEFAULT 1,       -- soft delete: removed products stay for order history
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    street        TEXT,
    house_number  TEXT,
    postal_code   TEXT,
    city          TEXT,
    country_code  TEXT DEFAULT 'DE',
    role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    order_date   TEXT    NOT NULL DEFAULT (datetime('now')),
    status       TEXT    NOT NULL DEFAULT 'NEW'
                 CHECK (status IN ('NEW', 'PICKED', 'SHIPPED', 'COMPLETED', 'CANCELED')),
    total_cents  INTEGER NOT NULL,
    currency     TEXT    NOT NULL DEFAULT 'EUR',
    -- shipping address snapshot (customer may change address later)
    ship_name    TEXT, ship_street TEXT, ship_house_number TEXT,
    ship_postal_code TEXT, ship_city TEXT, ship_country_code TEXT,
    erp_order_id TEXT                              -- UUID of the order in the ERP (set by the ERP-first checkout)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    product_name     TEXT    NOT NULL,             -- snapshot at time of purchase
    unit_price_cents INTEGER NOT NULL,             -- snapshot at time of purchase
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    item_total_cents INTEGER NOT NULL
  );

  -- SAP connectors: the ERP systems the shop can talk to (one of them is active)
  CREATE TABLE IF NOT EXISTS erp_connectors (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    auth       TEXT NOT NULL CHECK (auth IN ('basic', 'oauth')),
    username   TEXT,
    password   TEXT,                                -- local dev ERP only; BTP uses a service key file
    key_file   TEXT,                                -- path to the XSUAA service key (OAuth)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

function ensureColumn(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
ensureColumn('products', 'erp_id', 'TEXT');
ensureColumn('customers', 'erp_customer_id', 'TEXT');
ensureColumn('orders', 'erp_order_number', 'INTEGER');
ensureColumn('products', 'category', 'TEXT');
ensureColumn('customers', 'phone', 'TEXT');
ensureColumn('products', 'erp_created_by', 'TEXT');
ensureColumn('products', 'erp_connector', 'TEXT');
ensureColumn('customers', 'erp_connector', 'TEXT');
ensureColumn('orders', 'erp_connector', 'TEXT');
ensureColumn('erp_connectors', 'auto_catalog', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('erp_connectors', 'integration', "TEXT NOT NULL DEFAULT 'api'");

db.exec(`
  CREATE TABLE IF NOT EXISTS file_transfer_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    direction  TEXT NOT NULL CHECK (direction IN ('export', 'import')),
    connector  TEXT,
    file_name  TEXT,
    status     TEXT NOT NULL,
    rows       INTEGER,
    summary    TEXT,
    errors     TEXT,
    checksum   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_file_log_file ON file_transfer_log(file_name);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    location   TEXT,
    profile    TEXT NOT NULL DEFAULT '{}',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS supplier_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id   TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS supplier_sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES supplier_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supplier_deliveries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at  TEXT,
    supplier_id   TEXT NOT NULL,
    channel       TEXT NOT NULL CHECK (channel IN ('portal', 'ftp', 'folder')),
    username      TEXT,
    original_name TEXT,
    file_name     TEXT NOT NULL,
    format        TEXT,
    status        TEXT NOT NULL,
    rows          INTEGER,
    summary       TEXT,
    errors        TEXT,
    warnings      TEXT,
    checksum      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_supplier ON supplier_deliveries(supplier_id, file_name);
`);

if (db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n === 0) {
  const demo = [
    ['bikeparts', 'BikeParts GmbH', 'Köln, Germany',
     { format: 'csv', delimiter: ';', decimal: ',', fields: { productID: 'Artikelnummer', name: 'Bezeichnung',
       description: 'Beschreibung', price: 'Preis', stock: 'Bestand' }, update: ['price', 'stock'], createProducts: true },
     'bikeparts', 'Anna Becker'],
    ['globalcycle', 'Global Cycle Supply Ltd.', 'Manchester, UK',
     { format: 'json', recordPath: 'data.items', fields: {}, update: ['name', 'description', 'price', 'stock'], createProducts: true },
     'globalcycle', 'James Walker'],
    ['nordicgear', 'Nordic Gear AB', 'Göteborg, Sweden',
     { format: 'xml', recordPath: 'Article', fields: {}, update: ['name', 'description', 'price', 'stock'], createProducts: true },
     'nordicgear', 'Linnea Berg'],
    ['celticparts', 'Celtic Cycle Parts Ltd.', 'Dublin, Ireland',
     { format: 'auto', fields: {}, update: ['price', 'stock'], createProducts: true },
     'celticparts', 'Siobhan Kelly'],
  ];
  const hash = bcrypt.hashSync(process.env.SUPPLIER_DEMO_PASSWORD || 'supplier123', 10);
  db.transaction(() => {
    for (const [id, name, location, profile, username, person] of demo) {
      db.prepare('INSERT INTO suppliers (id, name, location, profile) VALUES (?, ?, ?, ?)').run(id, name, location, JSON.stringify(profile));
      db.prepare('INSERT INTO supplier_users (supplier_id, username, name, password_hash) VALUES (?, ?, ?, ?)').run(id, username, person, hash);
    }
  })();
  console.log(`[db] created ${demo.length} demo suppliers`);
}

export const getSetting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

if (db.prepare('SELECT COUNT(*) AS n FROM erp_connectors').get().n === 0) {
  const add = db.prepare(`INSERT INTO erp_connectors (id, name, url, auth, username, password, key_file, auto_catalog)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const isLocal = url => /localhost|127\.0\.0\.1/.test(url);
  const onCloudFoundry = !!process.env.VCAP_APPLICATION;
  const envIsLocal = process.env.ERP_URL && process.env.ERP_USER && isLocal(process.env.ERP_URL);
  if (!onCloudFoundry) {
    add.run('local', 'Local SAP (cds watch)',
            process.env.LOCAL_ERP_URL || (envIsLocal ? process.env.ERP_URL.replace(/\/$/, '') : 'http://localhost:4004'), 'basic',
            process.env.LOCAL_ERP_USER || (envIsLocal ? process.env.ERP_USER : 'service-user'),
            process.env.LOCAL_ERP_PASSWORD || (envIsLocal ? process.env.ERP_PASSWORD : 'service-user'), null, 1);
  }
  if (process.env.ERP_URL && process.env.ERP_XSUAA_KEY_FILE) {
    add.run('btp', 'SAP BTP (Cloud Foundry)', process.env.ERP_URL.replace(/\/$/, ''), 'oauth', null, null, process.env.ERP_XSUAA_KEY_FILE, 0);
  } else if (process.env.ERP_URL && process.env.ERP_USER && !isLocal(process.env.ERP_URL)) {
    add.run('custom', 'SAP ERP (.env)', process.env.ERP_URL.replace(/\/$/, ''), 'basic', process.env.ERP_USER, process.env.ERP_PASSWORD || '', null, 0);
  }
  const legacy = db.prepare("SELECT id FROM erp_connectors WHERE id IN ('btp', 'custom')").get()?.id;
  if (legacy) for (const t of ['products', 'customers', 'orders']) {
    const col = t === 'products' ? 'erp_id' : t === 'customers' ? 'erp_customer_id' : 'erp_order_id';
    db.prepare(`UPDATE ${t} SET erp_connector = ? WHERE ${col} IS NOT NULL AND erp_connector IS NULL`).run(legacy);
  }
  const exists = id => !!db.prepare('SELECT 1 FROM erp_connectors WHERE id = ?').get(id);
  const wanted = process.env.ERP_ACTIVE;
  const active = wanted === 'none' ? ''
    : wanted && exists(wanted) ? wanted
    : exists('local') ? 'local' : db.prepare('SELECT id FROM erp_connectors ORDER BY rowid').get()?.id || '';
  setSetting('active_connector', active);
  console.log(`[db] created SAP connectors, active: ${active || 'none'}`);
}

for (const p of db.prepare('SELECT id, product_id FROM products WHERE category IS NULL').all())
  db.prepare('UPDATE products SET category = ? WHERE id = ?').run(categoryFor(p.product_id), p.id);

const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (productCount === 0) {
  const insert = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, category)
                             VALUES (?, ?, ?, ?, 'EUR', ?, ?)`);
  for (const p of CATALOG) insert.run(p.productID, p.name, p.description, Math.round(p.price * 100), p.stock, p.category);
  console.log(`[db] seeded ${CATALOG.length} sample products`);
}

// On a public deployment the well-known demo admin password must not be used.
const adminPassword = process.env.ADMIN_PASSWORD
  || (process.env.NODE_ENV === 'production' ? randomBytes(24).toString('base64url') : 'admin123');
if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV === 'production')
  console.warn('[db] ADMIN_PASSWORD is not set - the admin account gets a random password (set ADMIN_PASSWORD and restart).');

export const DEMO_ACCOUNTS = [
  { role: 'admin', name: 'Shop Admin',
    email: process.env.ADMIN_EMAIL || 'admin@webshop.local', password: adminPassword },
  { role: 'customer', name: 'Max Mustermann',
    email: process.env.DEMO_CUSTOMER_EMAIL || 'customer@webshop.local', password: process.env.DEMO_CUSTOMER_PASSWORD || 'customer123',
    address: { street: 'Bahnhofstraße', houseNumber: '12', postalCode: '52064', city: 'Aachen', countryCode: 'DE' } },
];

for (const a of DEMO_ACCOUNTS) {
  const exists = a.role === 'admin'
    ? db.prepare("SELECT 1 FROM customers WHERE role = 'admin'").get()
    : db.prepare('SELECT 1 FROM customers WHERE email = ?').get(a.email);
  if (exists) continue;
  db.prepare(`INSERT INTO customers (name, email, password_hash, role, street, house_number, postal_code, city, country_code)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a.name, a.email, bcrypt.hashSync(a.password, 10), a.role, a.address?.street ?? null, a.address?.houseNumber ?? null,
         a.address?.postalCode ?? null, a.address?.city ?? null, a.address?.countryCode ?? 'DE');
  console.log(`[db] created ${a.role} demo account ${a.email}`);
}
