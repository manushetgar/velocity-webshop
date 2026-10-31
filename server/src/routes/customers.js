// =====================================================================================================
// routes/customers.js - customer accounts: registration, login/logout and the own profile ("My account")
// -----------------------------------------------------------------------------------------------------
// Role in the architecture:
//  - This Express router is mounted in index.js under the prefix /api, so the paths below become e.g.
//    POST /api/auth/register, POST /api/auth/login, GET /api/me.
//  - Authentication: after a successful login or registration the server creates a random session token
//    (auth.js, stored in the `sessions` table). The React frontend sends it in every request as the header
//    "Authorization: Bearer <token>"; the optionalAuth middleware (index.js) then sets req.user, and
//    requireAuth rejects requests without a valid token (401).
//  - Integration with the Mini-ERP: every shop customer should also exist as a customer in the ERP
//    (OData entity /odata/v4/simple-erp/Customers), because ERP orders reference an ERP customer. The shop
//    creates/links the ERP customer at registration (best effort) or at the latest at the first checkout,
//    and forwards profile changes to the ERP.
//  - Passwords are never stored or returned in plain text: only bcrypt hashes are stored in SQLite.
//  - Errors are thrown as httpError(status, message) and turned into JSON responses by the error handler
//    in index.js (Express 5 also catches errors thrown inside async handlers).
// =====================================================================================================

// Router: Express factory function that creates a router (a group of related routes).
import { Router } from 'express';
// db: the shared better-sqlite3 connection to the shop's SQLite database.
import { db } from '../db.js';
// Security helpers from auth.js: hashPassword/verifyPassword (bcrypt), createSession/deleteSession (session
// tokens in the `sessions` table) and requireAuth (middleware that only lets logged-in users pass).
import { hashPassword, verifyPassword, createSession, deleteSession, requireAuth } from '../auth.js';
// httpError: creates an Error object carrying an HTTP status code for the central error handler.
import { httpError } from '../util.js';
// erpOrdersEnabled: true when an SAP connector is active (and ERP_ORDERS is not 'false');
// ensureErpCustomer: finds the shop customer in the ERP by e-mail or creates it, and stores the ERP key.
import { erpOrdersEnabled, ensureErpCustomer } from '../services/erpOrders.js';
// updateCustomerInErp: sends changed customer data to the ERP (OData PATCH /Customers(<id>)).
import { updateCustomerInErp } from '../services/erpMasterData.js';
// DEMO_ACCOUNTS: the demo admin and demo customer defined in db.js (values from .env or defaults).
import { DEMO_ACCOUNTS } from '../db.js';

// Create the router object; all routes of this file are registered on it.
const router = Router();

// Demo accounts for the login page (only in demo mode, which is the default for this lab project)
// DEMO_SHOW_ADMIN=false hides the admin account (e.g. when the shop runs on a public URL on SAP BTP)
// HTTP GET /api/demo-accounts - public (no login needed, the login page calls it before anyone is logged in).
// Returns a JSON array of { role, name, email, password } so the login page can offer one-click demo logins.
// The `_req` name with underscore signals that the request object is not used.
router.get('/demo-accounts', (_req, res) => {
  // Demo mode switched off via environment variable -> return an empty list (no credentials are exposed).
  // `return` ends the handler here, so the code below is not executed.
  if (process.env.DEMO_MODE === 'false') return res.json([]);
  // Otherwise send the demo accounts as JSON (200 OK).
  res.json(DEMO_ACCOUNTS
    // Keep every non-admin account; keep the admin account only if DEMO_SHOW_ADMIN is not 'false'.
    .filter(a => a.role !== 'admin' || process.env.DEMO_SHOW_ADMIN !== 'false')
    // Destructuring in the parameter list copies only the four listed fields into a new object, so other
    // fields of the account (e.g. the demo address) are not sent to the browser.
    .map(({ role, name, email, password }) => ({ role, name, email, password })));
});

// The address fields as they are named in the API / frontend (camelCase). Used in PUT /me as a whitelist:
// only these keys are copied from the request body.
const ADDRESS_FIELDS = ['street', 'houseNumber', 'postalCode', 'city', 'countryCode'];

// Converts a database row of the `customers` table (snake_case columns) into the JSON object sent to the
// frontend (camelCase). Important for security: password_hash is deliberately NOT included.
// Exported so that other modules can return customers in the same format.
export function customerToApi(c) {
  // Build and return a new plain object with only the public fields.
  return {
    // Technical primary key of the customer in the shop database.
    id: c.id,
    // Display name.
    name: c.name,
    // E-mail address (also the login name).
    email: c.email,
    // 'customer' or 'admin'; the frontend uses it to show or hide the admin area.
    role: c.role,
    // Optional phone number; empty string instead of null for easier rendering in the form.
    phone: c.phone || '',
    // Registration date (created_at is filled by SQLite with datetime('now') on insert).
    memberSince: c.created_at,
    // true when the customer is linked to a customer in the ERP (erp_customer_id holds the ERP key).
    // The account page uses this to say "Profile saved (also updated in the ERP)".
    erpCustomer: !!c.erp_customer_id,
    // The address is grouped into a nested object; missing values become '' for the form fields.
    address: {
      // Street name.
      street: c.street || '',
      // House number (stored separately, like in the ERP customer entity).
      houseNumber: c.house_number || '',
      // Postal code (ZIP).
      postalCode: c.postal_code || '',
      // City.
      city: c.city || '',
      // ISO country code; 'DE' (Germany) is the default.
      countryCode: c.country_code || 'DE',
    },
  };
}

// Simple e-mail format check: returns true only for a string of the form "something@something.something".
function validEmail(email) {
  // typeof check: rejects non-strings (e.g. a number or object sent in the JSON body).
  // Regex: one or more characters that are neither whitespace nor '@', then '@', then the same again,
  // a dot, and the same again (e.g. max@example.de). It is a plausibility check, not a full RFC validation.
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Register a new customer account (also created as customer in the ERP when connected)
// HTTP POST /api/auth/register - public. Body: { name, email, password, phone, address: {...} }.
// Returns 201 Created with { token, user }: the new customer is logged in right away.
router.post('/auth/register', async (req, res) => {
  // Take the fields out of the JSON body; `address = {}` is a default value so that address.street etc.
  // can be read safely even if no address object was sent.
  const { name, email, password, phone, address = {} } = req.body;
  // Server-side validation (400 Bad Request for invalid input). `name?.trim()` returns undefined if no name
  // was sent and '' for a name of only spaces - both are rejected.
  if (!name?.trim()) throw httpError(400, 'Name is required.');
  // The e-mail must have a valid format (see validEmail above).
  if (!validEmail(email)) throw httpError(400, 'A valid e-mail is required.');
  // Minimum password length of 6 characters.
  if (!password || password.length < 6) throw httpError(400, 'Password must have at least 6 characters.');
  // Check whether the e-mail is already used. SELECT 1 only checks for existence (no columns are needed).
  // The email column is declared COLLATE NOCASE, so the comparison ignores upper/lower case.
  // 409 Conflict: the request conflicts with existing data (the e-mail must be unique).
  if (db.prepare('SELECT 1 FROM customers WHERE email = ?').get(email)) throw httpError(409, 'E-mail is already registered.');

  // SQL INSERT: create the customer row. The ? placeholders are bound in order by .run(...) below
  // (prepared statement -> no SQL injection possible). role and created_at get their default values.
  const info = db.prepare(`INSERT INTO customers (name, email, password_hash, phone, street, house_number, postal_code, city, country_code)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    // Values: trimmed name and e-mail, the bcrypt hash of the password (never the plain password),
    // phone or null, and the address fields (fields that were not sent are undefined -> stored as NULL) ...
    .run(name.trim(), email.trim(), hashPassword(password), phone || null, address.street, address.houseNumber,
         // ... postal code, city and the country code with 'DE' as default.
         address.postalCode, address.city, address.countryCode || 'DE');
  // Load the complete new row (info.lastInsertRowid = the id SQLite generated). `let` because it is
  // re-loaded below after the ERP link was stored.
  let customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);

  // best effort: create the customer in the ERP right away; if the ERP is down it happens at the first checkout
  // Only when an SAP connector is active (and ERP order handover is not switched off).
  if (erpOrdersEnabled()) {
    // try/catch: an ERP problem must not make the registration fail - the shop account already exists.
    try {
      // Look the customer up in the ERP by e-mail (OData $filter) or create it there (OData POST /Customers);
      // the ERP customer key is then stored in customers.erp_customer_id / erp_connector.
      await ensureErpCustomer(customer);
      // Re-load the row so the response includes the new ERP link (erpCustomer: true).
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
    // ERP unreachable or it rejected the request: only log a warning on the server console.
    } catch (e) {
      console.warn('[erp] customer not created in ERP yet:', e.message);
    }
  }
  // 201 Created. createSession() creates a new random session token for this customer (automatic login).
  res.status(201).json({ token: createSession(customer.id), user: customerToApi(customer) });
});

// HTTP POST /api/auth/login - public. Body: { email, password }.
// Returns { token, user } on success (200 OK) or 401 Unauthorized for wrong credentials.
router.post('/auth/login', (req, res) => {
  // Read the credentials from the JSON body.
  const { email, password } = req.body;
  // Find the customer by e-mail (case-insensitive because of COLLATE NOCASE). `email || ''` makes sure a
  // string is bound even if no e-mail was sent.
  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email || '');
  // verifyPassword compares the sent password with the stored bcrypt hash. Unknown e-mail and wrong password
  // get the SAME message on purpose, so an attacker cannot find out which e-mails are registered.
  if (!customer || !verifyPassword(password || '', customer.password_hash))
    // 401 Unauthorized: authentication failed.
    throw httpError(401, 'Wrong e-mail or password.');
  // Success: create a session token and return it together with the public customer data.
  res.json({ token: createSession(customer.id), user: customerToApi(customer) });
});

// HTTP POST /api/auth/logout - only for logged-in users (requireAuth answers 401 otherwise).
// Returns 204 No Content.
router.post('/auth/logout', requireAuth, (req, res) => {
  // Delete the session row on the server; the token becomes invalid immediately (server-side sessions are
  // easy to revoke). req.token was set by the optionalAuth middleware from the Authorization header.
  deleteSession(req.token);
  // 204 No Content: success without a response body.
  res.status(204).end();
});

// Current customer profile
// HTTP GET /api/me - only for logged-in users. Returns the profile of the logged-in customer as JSON.
router.get('/me', requireAuth, (req, res) => {
  // req.user.id comes from the validated session token, so a customer can only read their own profile.
  // The full row is loaded and converted with customerToApi (which leaves out the password hash).
  res.json(customerToApi(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.id)));
});

// Update personal information (name, e-mail, address, optional password change)
// HTTP PUT /api/me - only for logged-in users, changes only their own account.
// Body: any of { name, email, phone, address, currentPassword, newPassword }.
// Returns the updated profile plus an optional erpWarning if the ERP could not be updated.
router.put('/me', requireAuth, async (req, res) => {
  // Load the current row of the logged-in customer (needed for comparisons and as fallback values).
  const current = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.id);
  // Take the possible fields out of the body; a missing address object becomes {}.
  const { name, email, phone, address = {}, currentPassword, newPassword } = req.body;

  // If a name is sent, it must not be empty (400 Bad Request). Not sending it keeps the old name.
  if (name !== undefined && !name.trim()) throw httpError(400, 'Name cannot be empty.');
  // If an e-mail is sent, it must have a valid format.
  if (email !== undefined && !validEmail(email)) throw httpError(400, 'A valid e-mail is required.');
  // Uniqueness check only when the e-mail really changes (case-insensitive comparison, like the database):
  // if another customer already uses the new e-mail, answer 409 Conflict.
  if (email && email.toLowerCase() !== current.email.toLowerCase() &&
      db.prepare('SELECT 1 FROM customers WHERE email = ?').get(email))
    throw httpError(409, 'E-mail is already registered.');

  // By default the password hash stays the same.
  let passwordHash = current.password_hash;
  // Password change only if a new password was sent.
  if (newPassword) {
    // Security: the current password must be confirmed, so somebody using an unlocked, logged-in browser
    // cannot simply set a new password. 400 (not 401) because the user is logged in, but the input is wrong.
    if (!verifyPassword(currentPassword || '', current.password_hash)) throw httpError(400, 'Current password is wrong.');
    // Same minimum length rule as at registration.
    if (newPassword.length < 6) throw httpError(400, 'New password must have at least 6 characters.');
    // Store only the bcrypt hash of the new password.
    passwordHash = hashPassword(newPassword);
  }

  // Whitelist: build an object that contains exactly the known address fields from the request body
  // (e.g. { street: 'Bahnhofstraße', houseNumber: undefined, ... }); any other keys are ignored.
  // Object.fromEntries turns an array of [key, value] pairs into an object.
  const a = Object.fromEntries(ADDRESS_FIELDS.map(f => [f, address[f]]));
  // SQL UPDATE: overwrite all profile columns of this one customer (WHERE id = ?).
  db.prepare(`UPDATE customers SET name = ?, email = ?, password_hash = ?, phone = ?, street = ?, house_number = ?,
              postal_code = ?, city = ?, country_code = ? WHERE id = ?`)
    // The values are bound in the order of the ? placeholders. `x ?? current.x` keeps the current value for
    // every field that was not sent (partial update: the client only needs to send what changed).
    .run(
      // name, e-mail (both trimmed when sent), password hash (old or new) and phone ...
      name?.trim() ?? current.name, email?.trim() ?? current.email, passwordHash, phone ?? current.phone,
      // ... street, house number, postal code ...
      a.street ?? current.street, a.houseNumber ?? current.house_number, a.postalCode ?? current.postal_code,
      // ... city, country code, and finally the customer id for the WHERE clause.
      a.city ?? current.city, a.countryCode ?? current.country_code, current.id,
    );
  // Re-load the row so the response and the ERP update use the stored values.
  const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(current.id);

  // keep the ERP customer in sync (the shop change is kept even if the ERP is unreachable)
  // erpWarning stays undefined if everything worked.
  let erpWarning;
  try {
    // Sends name, e-mail and address to the ERP customer (OData PATCH /Customers(<erp id>)). The service does
    // nothing if no connector is active or this customer is not linked to the active connector's ERP.
    await updateCustomerInErp(updated);
  // The ERP call failed: the shop data stays saved, the user gets a warning text instead of an error.
  } catch (e) {
    erpWarning = `Saved in the shop, but the ERP could not be updated: ${e.message}`;
  }
  // Send the updated profile; the spread `...` copies all profile fields into the response object and adds
  // erpWarning (JSON.stringify leaves out undefined values, so the field is missing when there was no problem).
  // The account page shows the warning as an error toast.
  res.json({ ...customerToApi(updated), erpWarning });
});

// Export the router; index.js mounts it with app.use('/api', customerRoutes).
export default router;
