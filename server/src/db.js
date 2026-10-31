// ---------------------------------------------------------------------------------------------------------------
// db.js - database layer of the web shop: one SQLite database file, accessed with better-sqlite3.
//
// Role in the architecture: the ERP (Mini-ERP, SAP CAP) is the master for products, prices, stock and orders. The
// shop keeps a synchronized copy of that data in SQLite (filled by services/productSync.js) plus data that only the
// shop has: customer accounts with password hashes, login sessions, product categories, the SAP connectors and
// settings. The ERP keys (UUIDs) stored next to the shop rows link both worlds.
//
// What happens when this module is loaded (once, at server start - ES modules are executed only once):
//  1. open (or create) the database file and switch on WAL mode and foreign keys
//  2. create all tables if they do not exist yet (CREATE TABLE IF NOT EXISTS)
//  3. schema upgrades: add columns that newer versions of the shop need (ensureColumn)
//  4. on the very first start: create the SAP connectors from the environment (.env) and choose the active one
//  5. fill missing product categories, insert sample products into an empty database, create the demo accounts
// Exports: db (the connection used by all other modules), ORDER_STATUSES, getSetting/setSetting, DEMO_ACCOUNTS.
// ---------------------------------------------------------------------------------------------------------------

// better-sqlite3: SQLite driver for Node.js with a synchronous API (no callbacks/promises). This keeps the code simple
// and is fast for a single server process, because SQLite runs inside the process (no separate database server).
import Database from 'better-sqlite3';
// bcryptjs: password hashing - used here to store the passwords of the demo accounts as bcrypt hashes.
import bcrypt from 'bcryptjs';
// mkdirSync: creates a folder (synchronously) - used to make sure the folder of the database file exists.
import { mkdirSync } from 'node:fs';
// dirname: returns the folder part of a path, e.g. './data/webshop.db' -> './data'.
import { dirname } from 'node:path';
// CATALOG: the demo products (seed data); categoryFor: shop category of a productID (see catalog.js).
import { CATALOG, categoryFor } from './catalog.js';

// Path of the SQLite database file: configurable with DB_FILE (server/.env), default ./data/webshop.db. A relative
// path is resolved against the current working directory, i.e. the server folder when started with npm.
const DB_FILE = process.env.DB_FILE || './data/webshop.db';
// Creates the folder of the database file if it is missing (SQLite creates the file, but not the folder).
// recursive: true also creates parent folders and does not throw an error if the folder already exists.
mkdirSync(dirname(DB_FILE), { recursive: true });

// Opens the database file (it is created if it does not exist). This single connection is exported and shared by
// all routes and services; better-sqlite3 needs no connection pool because all calls are synchronous.
export const db = new Database(DB_FILE);
// Write-Ahead Logging: changes are first written to a separate log file (webshop.db-wal), so reading and writing do
// not block each other and writes are faster. This is the recommended journal mode for web applications.
db.pragma('journal_mode = WAL');
// SQLite does NOT check foreign keys (REFERENCES ...) by default; the check has to be switched on per connection.
// Only then are references enforced and ON DELETE CASCADE works (see sessions and order_items below).
db.pragma('foreign_keys = ON');

// Order status codes are the same as in the Mini-ERP (OrderStatus entity),
// so orders can later be handed over to the ERP without mapping.
// Life cycle: NEW -> PICKED -> SHIPPED -> COMPLETED, or CANCELED. The transitions correspond to the ERP's bound OData
// actions pickOrder, shipOrder, completeOrder and cancelOrder. Exported for routes/orders.js, which validates status
// changes against this list; the same values are repeated in the CHECK constraint of the orders table below.
export const ORDER_STATUSES = ['NEW', 'PICKED', 'SHIPPED', 'COMPLETED', 'CANCELED'];

// Creates the database schema. db.exec() runs several SQL statements at once (db.prepare() accepts only one).
// "IF NOT EXISTS" makes this idempotent: on every later start the existing tables and their data stay untouched.
// (It also never changes an existing table - new columns are added by ensureColumn() further below.)
// The "--" texts inside the SQL are SQL comments. Tables and columns:
//
// products - the shop's copy of the product master data (with a connector: synchronized from the ERP)
//   id           shop-internal technical key (INTEGER PRIMARY KEY AUTOINCREMENT: numbered automatically, never
//                reused); used in shop URLs, in the cart and in order_items.product_id
//   product_id   business key, the same value as the ERP productID; UNIQUE: no duplicates; used to match ERP products
//   name, description  product texts
//   price_cents  price in integer cents; CHECK (price_cents >= 0) rejects negative prices at database level
//   currency     ISO currency code, DEFAULT 'EUR'
//   stock        available quantity; CHECK (stock >= 0): stock can never become negative (no overselling locally)
//   active       1 = offered, 0 = removed (soft delete, so old orders can still reference the product)
//   updated_at   time of the last change; DEFAULT (datetime('now')) = current UTC time as 'YYYY-MM-DD HH:MM:SS'
//
// customers - shop accounts (customers and admins); only the shop has these passwords
//   email        UNIQUE COLLATE NOCASE: unique and compared case-insensitively ("Max@x.de" equals "max@x.de"),
//                both for the unique check and for lookups such as the login query
//   password_hash  bcrypt hash of the password, never the password itself
//   street, house_number, postal_code, city, country_code (DEFAULT 'DE')  address, required for checkout and
//                  passed to the ERP when the customer is created there
//   role         CHECK (role IN ('customer', 'admin')): only these two values are allowed
//   created_at   registration time
//
// sessions - login sessions (see auth.js)
//   token        random session token; PRIMARY KEY, so the lookup per request is fast
//   customer_id  REFERENCES customers(id) ON DELETE CASCADE: the session belongs to a customer; if the customer is
//                deleted, the sessions are deleted automatically
//   expires_at   expiry time as ISO text
//
// orders - shop orders (with a connector they are created in the ERP first and then stored here)
//   customer_id  REFERENCES customers(id): an order always belongs to an existing customer
//   order_date   DEFAULT now
//   status       DEFAULT 'NEW'; CHECK allows only the five ERP status codes (= ORDER_STATUSES)
//   total_cents, currency  order total in cents
//   ship_*       shipping address snapshot, copied at checkout so later address changes do not change old orders
//   erp_order_id the ERP's technical key (UUID) of the order, filled when the order is created in the ERP;
//                stays NULL for orders that exist only in the shop
//
// order_items - order lines
//   order_id     REFERENCES orders(id) ON DELETE CASCADE: the lines are deleted together with their order
//   product_id   REFERENCES products(id): the shop id of the product (not the business key)
//   product_name, unit_price_cents  snapshot at the time of purchase: later price or name changes in the ERP must
//                not change what the customer has paid
//   quantity     CHECK (quantity > 0); item_total_cents = unit price * quantity
//
// erp_connectors - the SAP connectors (ERP systems the shop can talk to; managed in Admin > SAP connectors)
//   id           short readable key, e.g. 'local', 'btp', 'custom'
//   name         display name; url: base URL of the ERP (the API paths /rest/api/... and /odata/v4/simple-erp/...
//                are appended to it)
//   auth         CHECK: 'basic' (user + password, local cds watch) or 'oauth' (OAuth 2.0 client credentials via XSUAA)
//   username, password  credentials for basic auth (the password is needed in plain form because it is sent to the ERP)
//   key_file     path of the XSUAA service key file (clientid, clientsecret, token URL) for OAuth
//
// settings - simple key/value store, e.g. key 'active_connector' = id of the active SAP connector
//
// Indexes: SQLite does not index foreign key columns automatically. idx_orders_customer speeds up "all orders of a
// customer" (purchase history, admin customer list), idx_items_order speeds up loading the lines of an order.
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

// ---------- schema upgrades for databases created by an older version ----------
// Adds a column to an existing table if it is missing - a minimal "migration" mechanism. Needed because
// CREATE TABLE IF NOT EXISTS above never changes a table that already exists, so a database file created by an older
// version of the shop would otherwise lack the newer columns. Running it on every start is harmless (idempotent).
function ensureColumn(table, column, type) {
  // PRAGMA table_info(<table>) returns one row per column of the table (cid, name, type, notnull, ...);
  // .some(...) checks whether one of them has the wanted name. Table and column names cannot be bound parameters
  // ("?" works only for values), therefore a template string is used - safe here, because all arguments are fixed
  // values written in this file, never user input.
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  // Column missing -> add it. Existing rows get NULL (or the DEFAULT given in `type`) in the new column.
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// products.erp_id: the ERP's technical key (UUID) of the product, set by the product sync. product_id is the readable
// business key, erp_id is the key the ERP uses internally for the record.
ensureColumn('products', 'erp_id', 'TEXT');               // ERP technical key (UUID) of the product
// customers.erp_customer_id: key of the ERP customer that belongs to this shop account (set when the customer is
// found or created in the ERP at registration or checkout - see services/erpOrders.js); orders in the ERP need it.
ensureColumn('customers', 'erp_customer_id', 'TEXT');     // ERP customer this shop customer is mapped to
// orders.erp_order_number: the ERP's readable order number (orderID), shown to customers and admins.
ensureColumn('orders', 'erp_order_number', 'INTEGER');   // readable ERP orderID (erp_order_id holds the UUID)
// products.category: e.g. 'Bikes' or 'Accessories'; it exists only in the shop (see catalog.js).
ensureColumn('products', 'category', 'TEXT');             // shop-only merchandising data, not stored in the ERP
// customers.phone: optional phone number of the customer (registration / profile).
ensureColumn('customers', 'phone', 'TEXT');
// who created the product in the ERP: empty = the ERP's initial data (Lab 0 CSV files), otherwise the
// technical user that created it via the API (e.g. service-user = this shop's "Load demo catalog")
ensureColumn('products', 'erp_created_by', 'TEXT');
// which SAP connector the ERP keys belong to (local and BTP ERP have different keys)
// The same product (e.g. DXTR1000) has a different UUID in the local ERP than in the ERP on SAP BTP, so every ERP key
// is stored together with the id of the connector it is valid for. With a connector active, the shop shows only the
// products of that connector (see visibleProductsFilter in routes/products.js).
ensureColumn('products', 'erp_connector', 'TEXT');
// The same for customers: erp_customer_id is only valid in the ERP of this connector.
ensureColumn('customers', 'erp_connector', 'TEXT');
// The same for orders: the ERP in which the order was created (needed for status changes and the status sync).
ensureColumn('orders', 'erp_connector', 'TEXT');
// create the demo catalog in this ERP automatically (local ERP: its data is in memory and reset on every restart)
// INTEGER used as boolean (0/1). SQLite requires a DEFAULT when a NOT NULL column is added to an existing table;
// existing connectors get 0 (off).
ensureColumn('erp_connectors', 'auto_catalog', 'INTEGER NOT NULL DEFAULT 0');
// Lab 2: how the product data of this ERP reaches the shop - 'api' (REST/OData calls, the default) or 'file' (the ERP's
// CSV export is transferred through the folder server/transfer, see services/fileTransfer.js).
ensureColumn('erp_connectors', 'integration', "TEXT NOT NULL DEFAULT 'api'");

// Lab 2: history of the file transfer (one row per export file written by the ERP export job and per imported or
// rejected file), shown in Admin > File transfer.
//   direction  'export' (ERP -> transfer folder) or 'import' (transfer folder -> shop)
//   status     export: 'written' / 'failed'; import: 'imported' (data changed) / 'unchanged' / 'rejected'
//   rows       number of products in the file
//   summary    JSON with counters (created, updated, unlinked, ...) and where the file was moved to
//   errors     JSON array with the error messages of a rejected file / failed export
//   checksum   SHA-256 of the file content
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

// Lab 2 extension: suppliers (supply chain partners) deliver product data in THEIR formats through the supplier portal
// (separate site, port 3200) or FTP (port 2121). See services/suppliers.js and services/supplierImport.js.
//   suppliers            one row per partner; profile = JSON mapping profile (format, separator, decimal sign,
//                        record path, field mapping, which fields it may update, whether it may create products)
//   supplier_users       employees / system accounts of a supplier; the same login works for the portal and for FTP
//                        (password stored as bcrypt hash); username is unique and case-insensitive
//   supplier_sessions    login sessions of the portal (separate from the shop's sessions)
//   supplier_deliveries  every file a supplier delivered: channel (portal / ftp / folder), status
//                        (received -> applied / unchanged / rejected, or waiting while the ERP is not reachable),
//                        result counters, errors and remarks as JSON
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

// Demo suppliers (only when the table is empty): four partners with four different formats, so the integration can be
// shown without preparing anything. Sample files are in server/src/portal/samples. Password of all demo logins:
// SUPPLIER_DEMO_PASSWORD (default in .env.example).
if (db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n === 0) {
  // id, name, location, mapping profile, demo login (username, employee name).
  const demo = [
    ['bikeparts', 'BikeParts GmbH', 'Köln, Germany',
     // German Excel CSV: semicolons, decimal comma, German column names; this supplier owns price and stock only
     // (texts of existing products stay as maintained in the ERP), but may introduce new products.
     { format: 'csv', delimiter: ';', decimal: ',', fields: { productID: 'Artikelnummer', name: 'Bezeichnung',
       description: 'Beschreibung', price: 'Preis', stock: 'Bestand' }, update: ['price', 'stock'], createProducts: true },
     'bikeparts', 'Anna Becker'],
    ['globalcycle', 'Global Cycle Supply Ltd.', 'Manchester, UK',
     // JSON feed of a web shop system: nested objects, the products are in data.items; fields detected automatically.
     { format: 'json', recordPath: 'data.items', fields: {}, update: ['name', 'description', 'price', 'stock'], createProducts: true },
     'globalcycle', 'James Walker'],
    ['nordicgear', 'Nordic Gear AB', 'Göteborg, Sweden',
     // XML from a legacy ERP: <Article id="..."> with child elements and a currency attribute on <Price>.
     { format: 'xml', recordPath: 'Article', fields: {}, update: ['name', 'description', 'price', 'stock'], createProducts: true },
     'nordicgear', 'Linnea Berg'],
    ['celticparts', 'Celtic Cycle Parts Ltd.', 'Dublin, Ireland',
     // Excel list from a purchasing system with its own column names (Part Number, Item Name, Unit Price, Qty Available)
     // - everything detected automatically; this supplier owns price and stock only.
     { format: 'auto', fields: {}, update: ['price', 'stock'], createProducts: true },
     'celticparts', 'Siobhan Kelly'],
  ];
  // One hash for all demo logins (bcrypt is slow on purpose, so it is computed once).
  const hash = bcrypt.hashSync(process.env.SUPPLIER_DEMO_PASSWORD || 'supplier123', 10);
  // All inserts in one transaction: either every demo supplier is created or none.
  db.transaction(() => {
    // One supplier after the other.
    for (const [id, name, location, profile, username, person] of demo) {
      // The supplier with its mapping profile (stored as JSON text).
      db.prepare('INSERT INTO suppliers (id, name, location, profile) VALUES (?, ?, ?, ?)').run(id, name, location, JSON.stringify(profile));
      // Its demo login (portal + FTP), with the shared password hash.
      db.prepare('INSERT INTO supplier_users (supplier_id, username, name, password_hash) VALUES (?, ?, ?, ?)').run(id, username, person, hash);
    }
  // Run the transaction immediately.
  })();
  // Start-up log message.
  console.log(`[db] created ${demo.length} demo suppliers`);
}

// ---------- SAP connectors (seeded once; managed in Admin > SAP connectors afterwards) ----------
// Reads a value from the settings table. .get(key) returns the row or undefined; `?.value` avoids an error when the
// key does not exist yet, and `?? null` turns that case into null. Exported, e.g. for services/connectors.js.
export const getSetting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
// Writes a value into the settings table ("upsert"): INSERT adds a new row; if the key already exists (primary key
// conflict), ON CONFLICT(key) DO UPDATE changes the existing row instead. `excluded.value` is the value of the row
// that could not be inserted, i.e. the new value. One atomic statement instead of "SELECT, then INSERT or UPDATE".
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// Only when the connector table is empty, i.e. on the very first start with a new database: create the SAP connectors
// from the environment variables. Afterwards the admin manages them in the UI, and changes made there must not be
// overwritten by .env values on the next restart. .get().n is the result of COUNT(*).
if (db.prepare('SELECT COUNT(*) AS n FROM erp_connectors').get().n === 0) {
  // Prepared INSERT statement, reused for every connector below (prepared once, executed several times).
  // The 8 "?" placeholders receive the values in the order of the 8 listed columns.
  const add = db.prepare(`INSERT INTO erp_connectors (id, name, url, auth, username, password, key_file, auto_catalog)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // true if a URL points to the own computer (localhost or 127.0.0.1). In the regular expression the dots are
  // escaped (\.) because a plain "." means "any character".
  const isLocal = url => /localhost|127\.0\.0\.1/.test(url);
  // Cloud Foundry sets the environment variable VCAP_APPLICATION for every app it runs; `!!` converts it to a boolean.
  const onCloudFoundry = !!process.env.VCAP_APPLICATION; // running on SAP BTP: there is no local ERP
  // the Mini-ERP started locally with `cds watch` (users from the ERP lab description)
  // envIsLocal is truthy when the generic variables ERP_URL and ERP_USER are set and ERP_URL points to a local ERP;
  // then these values are used for the local connector (older .env files configured the local ERP this way).
  // (`&&` returns one of its operands, not strictly true/false - that is fine, it is only used as a condition.)
  const envIsLocal = process.env.ERP_URL && process.env.ERP_USER && isLocal(process.env.ERP_URL);
  // The local connector is created only on a developer machine: on Cloud Foundry "localhost" would be the shop's own
  // container, where no ERP runs.
  if (!onCloudFoundry) {
    // Arguments in column order: id 'local', display name,
    add.run('local', 'Local SAP (cds watch)',
            // url: LOCAL_ERP_URL, else ERP_URL if it is local (replace(/\/$/, '') removes a trailing slash so the API
            // paths can be appended cleanly), else the default address of `cds watch` (port 4004); auth 'basic',
            process.env.LOCAL_ERP_URL || (envIsLocal ? process.env.ERP_URL.replace(/\/$/, '') : 'http://localhost:4004'), 'basic',
            // username: LOCAL_ERP_USER, else ERP_USER (if local), else the mocked CAP user 'service-user',
            process.env.LOCAL_ERP_USER || (envIsLocal ? process.env.ERP_USER : 'service-user'),
            // password (same order of fallbacks; the mocked user's password is 'service-user'), key_file null (no
            // OAuth), auto_catalog 1: the in-memory local ERP is reset on every restart, so the demo catalog is
            // created in it automatically.
            process.env.LOCAL_ERP_PASSWORD || (envIsLocal ? process.env.ERP_PASSWORD : 'service-user'), null, 1);
  }
  // the Mini-ERP on SAP BTP: service key file locally, service binding (vcap:<instance>) on Cloud Foundry
  // Created when ERP_URL and ERP_XSUAA_KEY_FILE are set: auth 'oauth' (OAuth 2.0 client credentials via XSUAA), no
  // username/password (the client id and secret come from the key file / binding), auto_catalog 0 (the BTP ERP keeps
  // its data in SAP HANA Cloud).
  if (process.env.ERP_URL && process.env.ERP_XSUAA_KEY_FILE) {
    add.run('btp', 'SAP BTP (Cloud Foundry)', process.env.ERP_URL.replace(/\/$/, ''), 'oauth', null, null, process.env.ERP_XSUAA_KEY_FILE, 0);
  // Otherwise: a remote (non-local) ERP with basic auth from .env -> connector 'custom'. A missing ERP_PASSWORD
  // becomes '' (empty string).
  } else if (process.env.ERP_URL && process.env.ERP_USER && !isLocal(process.env.ERP_URL)) {
    add.run('custom', 'SAP ERP (.env)', process.env.ERP_URL.replace(/\/$/, ''), 'basic', process.env.ERP_USER, process.env.ERP_PASSWORD || '', null, 0);
  }
  // existing ERP links from the time before connectors belong to the .env connection
  // Older databases have ERP keys but no erp_connector value. They were created with the ERP from .env, so they are
  // assigned to the 'btp' or 'custom' connector created just now (`?.id` is undefined if neither exists).
  const legacy = db.prepare("SELECT id FROM erp_connectors WHERE id IN ('btp', 'custom')").get()?.id;
  // For each of the three tables with ERP keys (only if such a connector exists):
  if (legacy) for (const t of ['products', 'customers', 'orders']) {
    // the name of the ERP key column in this table
    const col = t === 'products' ? 'erp_id' : t === 'customers' ? 'erp_customer_id' : 'erp_order_id';
    // Sets the connector for all rows that have an ERP key but no connector yet. Table/column names are fixed values
    // from this code (template string); the connector id is passed as a bound parameter.
    db.prepare(`UPDATE ${t} SET erp_connector = ? WHERE ${col} IS NOT NULL AND erp_connector IS NULL`).run(legacy);
  }
  // Helper: true if a connector with this id exists (SELECT 1 only checks existence; `!!` turns row/undefined into a
  // boolean).
  const exists = id => !!db.prepare('SELECT 1 FROM erp_connectors WHERE id = ?').get(id);
  // ERP_ACTIVE chooses the connector that is active on the first start: 'local', 'btp' or 'none'
  // (scripts/cf-prepare.mjs sets 'btp' for the deployment on Cloud Foundry).
  const wanted = process.env.ERP_ACTIVE;
  // Decision, checked from top to bottom:
  //  - 'none' -> '' = no active connector, the shop runs standalone with its local products
  const active = wanted === 'none' ? ''
    //  - the wanted connector, if it was created above
    : wanted && exists(wanted) ? wanted
    //  - otherwise 'local' if it exists, else the first created connector (ORDER BY rowid = insertion order),
    //    else '' if there is no connector at all
    : exists('local') ? 'local' : db.prepare('SELECT id FROM erp_connectors ORDER BY rowid').get()?.id || '';
  // Stores the choice; services/connectors.js reads it with getSetting('active_connector').
  setSetting('active_connector', active);
  // Start-up log message, e.g. "[db] created SAP connectors, active: local".
  console.log(`[db] created SAP connectors, active: ${active || 'none'}`);
}

// products created by an older version have no category yet
// For every such product (category IS NULL, e.g. right after ensureColumn added the column) the category is set from
// the demo catalog ('Other' for unknown products). On later starts the query finds no rows and nothing happens.
for (const p of db.prepare('SELECT id, product_id FROM products WHERE category IS NULL').all())
  // the UPDATE is the body of the for loop (single statement, no braces)
  db.prepare('UPDATE products SET category = ? WHERE id = ?').run(categoryFor(p.product_id), p.id);

// ---------- seed data ----------
// Shop-only sample products for an empty database. They are shown only while no SAP connector is active;
// with a connector the shop shows the products of that ERP (Admin > SAP connectors > "Load demo catalog").
// These rows get no erp_id / erp_connector, which is why the connector filter hides them while a connector is active.
// Number of products in the shop database (.n = alias of COUNT(*)).
const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
// Only if the products table is completely empty (e.g. new database file).
if (productCount === 0) {
  // Prepared INSERT for the sample products; the currency is fixed to 'EUR' directly in the SQL, the other six values
  // are bound parameters.
  const insert = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, category)
                             VALUES (?, ?, ?, ?, 'EUR', ?, ?)`);
  // One row per catalog entry; Math.round(p.price * 100) converts the euro price into integer cents (like toCents()).
  for (const p of CATALOG) insert.run(p.productID, p.name, p.description, Math.round(p.price * 100), p.stock, p.category);
  // Log message with the number of inserted products.
  console.log(`[db] seeded ${CATALOG.length} sample products`);
}

// Demo accounts (created once if missing). Values come from .env, defaults are in .env.example.
// Exported because routes/customers.js shows these accounts (with their passwords) on the login page in demo mode, so
// the lab can be presented without registering first. Change the passwords before the shop is publicly reachable.
export const DEMO_ACCOUNTS = [
  // The administrator: e-mail/password from ADMIN_EMAIL / ADMIN_PASSWORD, otherwise the defaults (no address needed).
  { role: 'admin', name: 'Shop Admin',
    email: process.env.ADMIN_EMAIL || 'admin@webshop.local', password: process.env.ADMIN_PASSWORD || 'admin123' },
  // A demo customer, from DEMO_CUSTOMER_EMAIL / DEMO_CUSTOMER_PASSWORD or the defaults.
  { role: 'customer', name: 'Max Mustermann',
    email: process.env.DEMO_CUSTOMER_EMAIL || 'customer@webshop.local', password: process.env.DEMO_CUSTOMER_PASSWORD || 'customer123',
    // The demo customer gets an address in Aachen, so the checkout (which requires an address) works immediately.
    address: { street: 'Bahnhofstraße', houseNumber: '12', postalCode: '52064', city: 'Aachen', countryCode: 'DE' } },
];

// Creates each demo account that does not exist yet.
for (const a of DEMO_ACCOUNTS) {
  // Does the account already exist?
  const exists = a.role === 'admin'
    // admin: is there ANY admin? Then no second admin is created (e.g. if the admin's e-mail was changed later).
    ? db.prepare("SELECT 1 FROM customers WHERE role = 'admin'").get()
    // customer: is the e-mail already registered? (case-insensitive because of COLLATE NOCASE)
    : db.prepare('SELECT 1 FROM customers WHERE email = ?').get(a.email);
  // Already there -> skip this account and continue with the next one.
  if (exists) continue;
  // Inserts the account with 9 columns: name, e-mail, password hash, role and the address fields.
  db.prepare(`INSERT INTO customers (name, email, password_hash, role, street, house_number, postal_code, city, country_code)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    // bcrypt.hashSync(a.password, 10) stores only the hash (cost factor 10, like hashPassword() in auth.js).
    // `a.address?.street ?? null`: the admin has no address -> NULL in the database; country falls back to 'DE'.
    .run(a.name, a.email, bcrypt.hashSync(a.password, 10), a.role, a.address?.street ?? null, a.address?.houseNumber ?? null,
         a.address?.postalCode ?? null, a.address?.city ?? null, a.address?.countryCode ?? 'DE');
  // Log message, e.g. "[db] created customer demo account customer@webshop.local".
  console.log(`[db] created ${a.role} demo account ${a.email}`);
}
