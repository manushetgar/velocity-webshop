// =====================================================================================================
// connectors.js - data access + validation for the "SAP connectors" (SQLite table erp_connectors).
//
// Role in the architecture: a connector describes ONE ERP system the shop can talk to (base URL plus
// authentication: basic auth with user/password, or OAuth via an XSUAA service key / service binding).
// The admin manages them in Admin > SAP connectors (routes/erp.js -> functions in this file).
// Which connector is active is stored in the settings table (key 'active_connector'); erpClient.js reads
// it with getActiveConnector() before every ERP call. Exactly one connector - or none - is active.
// This file contains no HTTP calls to the ERP; it only reads and writes the shop's own database.
// =====================================================================================================

// Import the shared better-sqlite3 database connection and the helpers for the key/value table "settings"
// (used to remember which connector is active).
import { db, getSetting, setSetting } from '../db.js';
// Import the helper that creates an Error with an HTTP status (e.g. 400, 404, 409); the central error
// handler in index.js turns such errors into a JSON response { error: message } with that status.
import { httpError } from '../util.js';
// Import the check whether the OAuth credentials of a connector can be found (file exists / service bound).
import { serviceKeyAvailable } from './serviceKey.js';

/**
 * SAP connectors: the ERP systems the shop can be connected to (e.g. the local Mini-ERP
 * started with `cds watch`, or the Mini-ERP on SAP BTP). Exactly one - or none - is active.
 */

// Loads one connector row by its id. SQL: select all columns of the row whose primary key equals the
// parameter. "?" is a placeholder: better-sqlite3 binds the value safely (no SQL injection possible).
// .get() returns the first row as an object, or undefined if no row matches.
const load = id => db.prepare('SELECT * FROM erp_connectors WHERE id = ?').get(id);

// Returns the active connector row, or null if the shop currently runs without an ERP.
export function getActiveConnector() {
  // Read the id of the active connector from the settings table ('' or null = none active).
  const id = getSetting('active_connector');
  // If an id is set, load that row; "|| null" also covers an id whose row no longer exists.
  return id ? load(id) || null : null;
}

// Returns all connectors. SQL: all rows of erp_connectors; ORDER BY rowid = SQLite's internal insertion
// order, so the admin UI lists the connectors in the order they were created. .all() returns an array.
export const listConnectors = () => db.prepare('SELECT * FROM erp_connectors ORDER BY rowid').all();

// Returns one connector or throws 404 - used by routes that work on /connectors/:id.
export function getConnector(id) {
  // Load the row from SQLite.
  const c = load(id);
  // Unknown id: 404 Not Found (the requested resource does not exist).
  if (!c) throw httpError(404, 'Connector not found.');
  // Return the row.
  return c;
}

// Stores which connector is active (id), or deactivates all connectors (id = null / empty).
export function setActiveConnector(id) {
  // If an id is given, make sure the connector exists (getConnector throws 404 otherwise).
  if (id) getConnector(id);
  // Save it in the settings table; an empty string means "no active connector" (shop runs standalone).
  setSetting('active_connector', id || '');
}

/** Connector as shown in the admin UI (never returns the password). */
// Converts a database row (snake_case columns) into the JSON object the frontend expects (camelCase).
// `extra` lets the caller add more fields (e.g. lastSync, products, orders in routes/erp.js).
export function connectorToApi(c, extra = {}) {
  // Load the active connector once, to mark this connector as active or not.
  const active = getActiveConnector();
  // Build the API object field by field:
  return {
    // technical id, e.g. 'local' or 'btp' (used in URLs like /api/erp/connectors/:id)
    id: c.id,
    // display name shown in the admin UI
    name: c.name,
    // ERP base URL, e.g. http://localhost:4004
    url: c.url,
    // authentication method: 'basic' or 'oauth'
    auth: c.auth,
    // user for basic auth ('' if none) - not a secret
    username: c.username || '',
    // SECURITY: the password itself is never sent to the browser, only whether one is stored (true/false)
    hasPassword: !!c.password,
    // where the OAuth credentials are found: a file path or "vcap:<instance>" (only the location, no secret)
    keyFile: c.key_file || '',
    // OAuth only: true/false whether the service key file / binding exists; null for basic auth connectors
    keyFileFound: c.auth === 'oauth' ? serviceKeyAvailable(c.key_file) : null,
    // SQLite stores booleans as 0/1 - convert to true/false for the frontend
    autoCatalog: !!c.auto_catalog,
    // how product data gets from this ERP into the shop: 'api' (REST/OData, Lab 1/3) or 'file' (file transfer, Lab 2)
    integration: c.integration || 'api',
    // true if this is the active connector (?. because there may be no active connector)
    active: active?.id === c.id,
    // copy all extra fields given by the caller into the result
    ...extra,
  };
}

// Validates the connector data sent by the admin UI and returns a clean, normalized object.
// `existing` is the stored row when editing: fields missing in the body keep their stored value.
// Invalid input throws 400 Bad Request with a message the UI shows next to the form.
function validate(body, existing) {
  // Name: the body value, else the stored one, else ''. "??" (nullish coalescing) only falls back on
  // null/undefined. String() + trim() make sure it is a string without surrounding spaces.
  const name = String(body.name ?? existing?.name ?? '').trim();
  // URL: same fallback logic, plus a trailing "/" is removed - erpClient builds URLs as url + '/path', so a
  // trailing slash would produce "//path".
  const url = String(body.url ?? existing?.url ?? '').trim().replace(/\/$/, '');
  // Authentication method from the body, else the stored one.
  const auth = body.auth ?? existing?.auth;
  // A name is mandatory (shown in the UI and used to derive the id).
  if (!name) throw httpError(400, 'Name is required.');
  // The URL must start with http:// or https:// and must not contain whitespace (regular expression check).
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw httpError(400, 'URL must start with http:// or https://');
  // Only the two supported methods are allowed (same rule as the CHECK constraint of the table).
  if (!['basic', 'oauth'].includes(auth)) throw httpError(400, 'Authentication must be "basic" or "oauth".');
  // User name for basic auth: body value, else stored value, else null.
  const username = body.username ?? existing?.username ?? null;
  // Password: a non-empty password in the body replaces the stored one. An empty or missing password means
  // "keep the stored password" - needed because the UI never receives the password (see connectorToApi)
  // and therefore sends an empty field when the admin does not change it.
  const password = body.password ? body.password : existing?.password ?? null; // empty = keep
  // Location of the OAuth credentials (file path or "vcap:<instance>"): body value, else stored value.
  const keyFile = body.keyFile ?? existing?.key_file ?? null;
  // Basic auth needs a user name (the password may be empty).
  if (auth === 'basic' && !username) throw httpError(400, 'User is required for basic authentication.');
  // OAuth needs a place to read the client id / secret from.
  if (auth === 'oauth' && !keyFile) throw httpError(400, 'Service key file is required for OAuth (XSUAA).');
  // "Auto catalog" flag: if the body contains it, convert true/false to 1/0 (SQLite has no boolean type);
  // otherwise keep the stored value, or 0 (off) for a new connector.
  const autoCatalog = body.autoCatalog !== undefined ? (body.autoCatalog ? 1 : 0) : existing?.auto_catalog ?? 0;
  // Integration style: body value, else the stored one, else 'api' for a new connector.
  const integration = body.integration ?? existing?.integration ?? 'api';
  // Only the two supported styles (same values the admin UI offers).
  if (!['api', 'file'].includes(integration)) throw httpError(400, 'Integration must be "api" or "file".');
  // Return the normalized data. Only the credentials of the chosen method are kept, the others are set to
  // null, so no old password stays stored after switching a connector from basic to OAuth (and vice versa).
  return { name, url, auth, username: auth === 'basic' ? username : null, password: auth === 'basic' ? password : null,
           // keyFile only for OAuth connectors; autoCatalog as 0/1
           keyFile: auth === 'oauth' ? keyFile : null, autoCatalog, integration };
}

/** Checks a connector configuration without saving it (empty password = the stored one of `id`). */
// Used by POST /api/erp/connectors/test: the admin can test a form before saving it.
export function connectorFromBody(body) {
  // If the form belongs to an existing connector, load it, so an empty password uses the stored password.
  const existing = body.id ? load(body.id) : undefined;
  // Validate (throws 400 on bad input) and convert to the database row format. The id is the real one, or
  // '_test' for a connector that is not saved yet (erpClient uses the id e.g. as key of the token cache).
  return { id: body.id || '_test', ...toRow(validate(body, existing)) };
}
// Maps the camelCase result of validate() to the snake_case column names of the erp_connectors table
// (keyFile -> key_file, autoCatalog -> auto_catalog), i.e. the same shape as a row loaded from SQLite.
const toRow = c => ({ name: c.name, url: c.url, auth: c.auth, username: c.username, password: c.password,
                      key_file: c.keyFile, auto_catalog: c.autoCatalog, integration: c.integration });

// Creates a new connector from the admin form and returns the stored row.
export function createConnector(body) {
  // Validate the input (no existing row: every required field must be in the body).
  const c = validate(body);
  // Derive a readable id from the name ("SAP BTP (Cloud Foundry)" -> "sap-btp-cloud-foundry"): lower case,
  // every run of characters other than a-z / 0-9 becomes "-", leading/trailing "-" removed, at most 30
  // characters. If nothing is left (e.g. name only made of special characters), use 'erp'.
  let id = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'erp';
  // Make the id unique: as long as a connector with this id exists, remove a previous "-<number>" suffix and
  // append "-2", "-3", ... (the id is the primary key, so duplicates are not allowed).
  for (let i = 2; load(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
  // SQL: insert one row into erp_connectors with the given values for the nine columns. The nine "?"
  // placeholders are filled by .run() in the same order (prepared statement = safe against SQL injection).
  // created_at is not listed, so SQLite fills it with its default (the current time).
  db.prepare(`INSERT INTO erp_connectors (id, name, url, auth, username, password, key_file, auto_catalog, integration)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    // Execute the INSERT with the values in column order.
    .run(id, c.name, c.url, c.auth, c.username, c.password, c.keyFile, c.autoCatalog, c.integration);
  // Return the row as stored in the database.
  return load(id);
}

// Updates an existing connector (PUT /api/erp/connectors/:id) and returns the updated row.
export function updateConnector(id, body) {
  // Load the stored row (404 if the id does not exist).
  const existing = getConnector(id);
  // Validate the body; fields that are not sent keep their stored values.
  const c = validate(body, existing);
  // SQL: overwrite the eight editable columns of the row with this id (the id itself never changes, so
  // references from products/customers/orders stay valid). Placeholders are bound by .run() in order.
  db.prepare(`UPDATE erp_connectors SET name = ?, url = ?, auth = ?, username = ?, password = ?, key_file = ?, auto_catalog = ?,
              integration = ? WHERE id = ?`)
    // Execute the UPDATE: the eight new values, then the id for the WHERE clause.
    .run(c.name, c.url, c.auth, c.username, c.password, c.keyFile, c.autoCatalog, c.integration, id);
  // Return the updated row.
  return load(id);
}

// Deletes a connector - only if this does not break data that still depends on it.
export function deleteConnector(id) {
  // Make sure it exists (404 otherwise).
  getConnector(id);
  // 409 Conflict: the request is valid, but conflicts with the current state - the shop is using this ERP.
  if (getActiveConnector()?.id === id) throw httpError(409, 'The active connector cannot be deleted. Activate another one first.');
  // SQL: count the shop orders that were created in this connector's ERP (column erp_connector).
  // COUNT(*) AS n returns one row { n: <number> }; .n reads the number.
  const orders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE erp_connector = ?').get(id).n;
  // 409 Conflict if orders exist: they reference ERP orders (erp_order_id) of this ERP, which would be
  // orphaned if the connector disappeared.
  if (orders) throw httpError(409, `${orders} shop order(s) live in this ERP, so the connector cannot be deleted.`);
  // db.transaction(fn) wraps the three statements in ONE SQLite transaction: either all of them are applied
  // or none (atomic), so the database never ends up half-cleaned. The trailing "()" runs it immediately.
  db.transaction(() => {
    // the ERP keys of this ERP are meaningless without the connector
    // SQL: remove the ERP link (ERP product key + connector) from all products linked to this connector.
    db.prepare('UPDATE products SET erp_id = NULL, erp_connector = NULL WHERE erp_connector = ?').run(id);
    // SQL: the same for customers (their ERP customer id belongs to this ERP).
    db.prepare('UPDATE customers SET erp_customer_id = NULL, erp_connector = NULL WHERE erp_connector = ?').run(id);
    // SQL: finally delete the connector row itself.
    db.prepare('DELETE FROM erp_connectors WHERE id = ?').run(id);
  })();
}
