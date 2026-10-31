// ---------------------------------------------------------------------------------------------------------------
// auth.js - authentication (who is the user?) and authorization (what may the user do?) of the web shop.
//
// The shop has its own user accounts: table `customers` in SQLite with the role 'customer' or 'admin'. They are
// completely separate from the technical ERP user (basic auth `service-user` for the local Mini-ERP, or the OAuth
// client from the XSUAA service key on SAP BTP) that the shop uses to call the ERP. The ERP never sees the shop's
// end-user passwords; this file only protects the shop's own REST API (/api/...).
//
// Concept: random session tokens that are stored on the server (table `sessions`):
//  1. Registration / login (routes/customers.js) checks the password with bcrypt and calls createSession(), which
//     stores a random token in the database and returns it to the browser.
//  2. The React frontend keeps the token (localStorage) and sends it with every request in the HTTP header
//     `Authorization: Bearer <token>` (see client/src/api.js).
//  3. optionalAuth (registered for ALL requests in index.js) looks the token up and sets req.user.
//  4. requireAuth / requireAdmin are added to single routes or routers to protect them (HTTP 401 / 403).
//  5. Logout deletes the session row, so the token becomes invalid immediately. This is the reason for an
//     "opaque" server-side token instead of a self-contained JWT, which could not be revoked that easily.
// ---------------------------------------------------------------------------------------------------------------

// bcryptjs: pure-JavaScript implementation of the bcrypt password hashing algorithm (no native build step needed).
// bcrypt is deliberately slow and adds a random salt to every hash, which makes brute-forcing stolen hashes expensive.
import bcrypt from 'bcryptjs';
// randomBytes: Node.js' cryptographically secure random number generator, used to create unguessable session tokens
// (Math.random() is predictable and must never be used for security tokens).
import { randomBytes } from 'node:crypto';
// The shared SQLite connection (better-sqlite3) from db.js; the tables sessions and customers are accessed through it.
import { db } from './db.js';

// How long a login stays valid, in hours. Configurable with the environment variable SESSION_TTL_HOURS (server/.env),
// default 24. Environment variables are always strings, so Number(...) converts the value into a number.
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24);

// Hashes a plain-text password before it is stored in customers.password_hash - the shop never stores passwords in
// plain text. Used by registration and by the password change in the profile (routes/customers.js).
export function hashPassword(plain) {
  // hashSync(password, 10): 10 is the cost factor ("salt rounds" = 2^10 iterations). The result is a string such as
  // "$2b$10$<salt><hash>" that already contains the algorithm version, the cost and the random salt, so no separate
  // salt column is needed. The synchronous variant fits the synchronous style of the rest of the code (better-sqlite3).
  return bcrypt.hashSync(plain, 10);
}

// Checks a password: hashes `plain` again with the salt and cost stored inside `hash` and compares both results.
// Returns true or false. Used by POST /api/auth/login and for the "current password" check of a password change.
export function verifyPassword(plain, hash) {
  // compareSync does the whole comparison; the original password can never be recovered from the stored hash.
  return bcrypt.compareSync(plain, hash);
}

// Opaque random session token stored server-side (easy to revoke on logout).
// "Opaque" means that the token itself contains no information (unlike a JWT): it is only a random key that points to
// a row in the table sessions. Called after a successful login or registration; the token is returned to the client.
export function createSession(customerId) {
  // 32 random bytes = 256 bits of randomness, written as a 64-character hexadecimal string -> practically impossible
  // to guess, so nobody can take over another user's session by trying tokens.
  const token = randomBytes(32).toString('hex');
  // Expiry time = now + TTL_HOURS (hours * 3600 seconds * 1000 milliseconds, because Date.now() is in milliseconds),
  // stored as ISO 8601 text in UTC, e.g. "2026-10-18T12:00:00.000Z". ISO strings of the same format sort correctly as
  // text, which optionalAuth uses to compare it with the current time.
  const expires = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  // Stores the session: token, owner (customer id) and expiry time. The "?" placeholders are bound parameters:
  // better-sqlite3 passes the values separately from the SQL text, which prevents SQL injection.
  db.prepare('INSERT INTO sessions (token, customer_id, expires_at) VALUES (?, ?, ?)').run(token, customerId, expires);
  // The caller (routes/customers.js) sends the token to the browser in the JSON response.
  return token;
}

// Logout: removes the session row. From now on the token is unknown and optionalAuth no longer accepts it.
export function deleteSession(token) {
  // Deletes exactly the session with this token; other sessions of the same user (e.g. another device) stay valid.
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Reads the session token from the request header "Authorization: Bearer <token>" (the standard way to send a bearer
// token, RFC 6750). Not exported: it is only a helper for optionalAuth in this file.
function tokenFrom(req) {
  // req.get() reads a request header (header names are case-insensitive). If the header is missing, use '' so that
  // startsWith() below does not fail on undefined.
  const h = req.get('Authorization') || '';
  // If the header starts with the scheme "Bearer ", return the part after it (7 = length of "Bearer ");
  // any other value (missing header, other auth scheme) means "no token" -> null.
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Attaches req.user if a valid token is sent; never rejects.
// Express middleware with the signature (req, res, next). index.js registers it globally with app.use(optionalAuth),
// so it runs before every route. It only IDENTIFIES the user and does not block anonymous visitors, because public
// endpoints (product list, product details) work without login but may behave differently for admins
// (e.g. GET /api/products?all=true also returns removed products). The underscore in `_res` marks an unused parameter.
export function optionalAuth(req, _res, next) {
  // Extract the bearer token from the Authorization header (null if none was sent).
  const token = tokenFrom(req);
  // Only query the database when a token was actually sent (anonymous requests cost no database access).
  if (token) {
    // Looks up the session together with its customer in one query:
    //  - FROM sessions s JOIN customers c ON c.id = s.customer_id: combines the session with the customer it belongs to
    //    (s and c are short aliases for the two tables)
    //  - SELECT c.id, c.name, c.email, c.role: only the fields the routes need - never the password hash
    //  - WHERE s.token = ?: the session with this token (token is the primary key, so this lookup is fast)
    //  - AND s.expires_at > ?: only if it has not expired yet; the second parameter is the current time as ISO string.
    //    Both values are UTC ISO strings, so the text comparison gives the correct chronological order.
    //    Expired rows are not deleted here; they simply no longer match.
    // .get(...) binds the two parameters in order and returns the first matching row as an object, or undefined.
    const row = db.prepare(`
      SELECT c.id, c.name, c.email, c.role FROM sessions s JOIN customers c ON c.id = s.customer_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
    // A valid, non-expired session was found.
    if (row) {
      // Attach the logged-in user { id, name, email, role } to the request object, so all later middleware and route
      // handlers can use it (e.g. req.user.id for "my orders", req.user.role for the admin checks below).
      req.user = row;
      // Keep the raw token as well, so the logout route can delete exactly this session (deleteSession(req.token)).
      req.token = token;
    }
  }
  // Always continue with the next middleware / route: an invalid or expired token simply means "not logged in".
  next();
}

// Guard middleware for routes that need a logged-in user (checkout, purchase history, profile, logout).
// Used per route, e.g. router.post('/', requireAuth, handler). It relies on optionalAuth having set req.user before.
export function requireAuth(req, res, next) {
  // No user -> answer 401 Unauthorized (meaning "not authenticated - please log in"). `return` ends the middleware
  // without calling next(), so the protected route handler never runs. The frontend shows the text from the JSON body.
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  // Logged in -> continue with the actual route handler.
  next();
}

// Guard middleware for the admin area (product maintenance, SAP connectors, order status changes, statistics).
// routes/admin.js applies it to all of its routes with router.use(requireAdmin), other routers add it per route.
// The check runs on the server: hiding the admin menu in the React app alone would not be secure, because anyone
// can call the REST API directly (e.g. with curl or Postman).
export function requireAdmin(req, res, next) {
  // Not logged in at all -> 401 Unauthorized ("who are you?").
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  // Logged in, but the role is not 'admin' -> 403 Forbidden
  // ("we know who you are, but you are not allowed to do this").
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin rights required.' });
  // The user is an admin -> continue with the route handler.
  next();
}
