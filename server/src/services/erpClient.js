// =====================================================================================================
// erpClient.js - the ONLY place in the web shop backend that sends HTTP requests to the Mini-ERP.
//
// Role in the architecture:
//   React frontend  ->  Express routes (server/src/routes/*)  ->  services (productSync, erpOrders,
//   erpMasterData, erpSync)  ->  THIS FILE  ->  HTTP  ->  Mini-ERP (SAP CAP app from Lab 0)
//
// The ERP is the master (source of truth) for products, prices, stock and orders. All other services use
// the functions exported here (clientFor, testConnector, requireActiveConnector, ...) instead of calling
// fetch() themselves. This keeps the integration concerns in one file:
//   - which ERP to talk to: the active "SAP connector" (row of the SQLite table erp_connectors)
//   - authentication: HTTP basic auth (local `cds watch`) or OAuth 2.0 client credentials (XSUAA on BTP)
//   - robustness: timeout on every request, retries with exponential backoff for temporary errors
//   - error handling: ERP / network errors are translated into ErpError objects that carry the HTTP
//     status code the shop's own API should answer with (the central error handler in index.js sends it)
// =====================================================================================================

// Import the function that reads the currently active SAP connector (a row of erp_connectors) from SQLite.
// The connector tells us the ERP base URL and which authentication method + credentials to use.
import { getActiveConnector } from './connectors.js';
// Import the helper that loads the XSUAA OAuth credentials (url, clientid, clientsecret) of an OAuth
// connector, either from a service key JSON file or from the Cloud Foundry service binding (VCAP_SERVICES).
import { readServiceKey } from './serviceKey.js';

/**
 * Client for the Mini-ERP API.
 *
 * Talks to the active SAP connector (Admin > SAP connectors), e.g.
 *  - the local Mini-ERP (cds watch on :4004)  -> HTTP basic auth (service-user)
 *  - the Mini-ERP on SAP BTP (Cloud Foundry)  -> OAuth2 client credentials (XSUAA service key or service binding)
 *
 * Network errors and 5xx responses are retried with exponential backoff,
 * every call has a timeout, and the OAuth token is cached per connector until shortly before it expires.
 */

// Timeout for a single HTTP request to the ERP, in milliseconds (default 10000 ms = 10 s, configurable with
// the environment variable ERP_TIMEOUT_MS). It is a function and not a constant, so the environment variable
// is read at the moment of each call. Why a timeout at all: without it a hanging ERP (e.g. a Cloud Foundry
// app that is starting) would block the shop request forever; with it the user gets a clear error quickly.
const TIMEOUT_MS = () => Number(process.env.ERP_TIMEOUT_MS || 10000);
// In-memory cache for OAuth access tokens: key = connector id, value = { value: token string, expiresAt: ms }.
// Caching avoids requesting a new token from XSUAA before every single ERP call (saves one HTTP round trip
// per call and load on the XSUAA server). The cache lives only in RAM: after a server restart a new token
// is simply requested again. Tokens are never written to the database or to logs.
const tokens = new Map(); // connector id -> { value, expiresAt }

// Removes the cached OAuth token of one connector, so the next call requests a fresh token.
// Used when a connector is edited or activated (new credentials / URL) and below when the ERP answers 401.
export const clearToken = connectorId => tokens.delete(connectorId);

/** The active connection (no secrets). */
// Returns a small summary of the active connector that is safe to show (no password, no client secret).
export function erpConfig() {
  // Read the active connector row from SQLite (or null/undefined if the shop runs without an ERP).
  const c = getActiveConnector();
  // No active connector: report "not configured" with all fields set to null.
  if (!c) return { configured: false, url: null, mode: null, id: null, name: null };
  // Active connector: report its URL, authentication mode ('basic' or 'oauth'), id and display name.
  return { configured: true, url: c.url, mode: c.auth, id: c.id, name: c.name };
}

// Custom error class for everything that goes wrong while talking to the ERP. It extends the built-in Error
// and adds two fields, so callers and the central Express error handler know how to react.
export class ErpError extends Error {
  // message   = readable text shown to the user / admin
  // status    = HTTP status code the web shop API answers with (e.g. 503, 502, 409, 422)
  // retryable = true if the same request may succeed when it is simply repeated (temporary problem)
  constructor(message, status, retryable = false) {
    // Call the Error constructor so .message and the stack trace are set as usual.
    super(message);
    // Store the HTTP status; the central error handler in index.js uses err.status for the response.
    this.status = status;       // HTTP status the web shop API answers with
    // Store whether a retry makes sense; call() below only retries errors with retryable === true.
    this.retryable = retryable; // network problems and ERP 5xx are worth retrying, 4xx are not
  }
}

// Wrapper around the global fetch() of Node.js 22 that adds a timeout and turns low-level network errors
// (connection refused, DNS failure, timeout) into an ErpError with status 503 that may be retried.
async function fetchWithTimeout(url, opts) {
  // try/catch: fetch() rejects (throws) only when no HTTP response arrives at all; HTTP error statuses such as
  // 404 or 500 do NOT throw, they come back as a normal response object and are handled in call().
  try {
    // Send the request with all given options plus an abort signal: AbortSignal.timeout(ms) creates a signal
    // that aborts the request automatically after TIMEOUT_MS() milliseconds. `await` inside the try makes
    // sure a rejected promise is caught by the catch block below.
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS()) });
  } catch (e) {
    // Build a short reason for the error message:
    //  - e.name 'TimeoutError' -> the abort signal fired, i.e. the ERP did not answer in time
    //  - otherwise Node's fetch throws "fetch failed" with the real cause in e.cause.code, e.g. ECONNREFUSED
    //    (nothing listens on the port - local ERP not started) or ENOTFOUND (host name cannot be resolved)
    //  - fallback: the plain error message
    const reason = e.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS()} ms` : e.cause?.code || e.message;
    // 503 Service Unavailable: the ERP (a service the shop depends on) cannot be reached right now.
    // retryable = true because network problems are often temporary (e.g. the ERP app is restarting).
    throw new ErpError(`ERP not reachable (${reason})`, 503, true);
  }
}

// Returns an OAuth 2.0 access token for an OAuth connector (Mini-ERP on SAP BTP, protected by XSUAA).
// Flow used: "client credentials grant" - a machine-to-machine login without a human user. The shop proves
// its identity with the client id + client secret from the XSUAA service key / binding and receives a
// short-lived token, which is then sent to the ERP as "Authorization: Bearer <token>".
async function oauthToken(conn) {
  // Look up a cached token for this connector.
  const cached = tokens.get(conn.id);
  // Reuse the cached token as long as it is not expired (expiresAt already contains a safety margin, see below).
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // Will hold the XSUAA credentials { url, clientid, clientsecret }.
  let c;
  // Reading the credentials can fail (file missing, invalid JSON, service not bound) - see serviceKey.js.
  try {
    // key_file is either a path to a service key JSON file or "vcap:<instance>" for a Cloud Foundry binding.
    c = readServiceKey(conn.key_file);
  } catch (e) {
    // Without credentials the ERP cannot be used: 503 Service Unavailable with the readable message from
    // serviceKey.js. Not retryable: a missing/broken configuration does not fix itself by waiting.
    throw new ErpError(e.message, 503);
  }
  // Request the token from the XSUAA token endpoint "<XSUAA url>/oauth/token" (url from the service key).
  // The request goes through fetchWithTimeout, so it also has a timeout and network errors become ErpErrors.
  const res = await fetchWithTimeout(`${c.url}/oauth/token`, {
    // OAuth 2.0 requires POST for the token endpoint (credentials must not appear in the URL).
    method: 'POST',
    headers: {
      // Client authentication with HTTP basic auth: "Basic " + base64("clientid:clientsecret").
      // Base64 is only an encoding, not encryption - the connection to XSUAA is HTTPS, which protects it.
      Authorization: 'Basic ' + Buffer.from(`${c.clientid}:${c.clientsecret}`).toString('base64'),
      // The OAuth 2.0 standard expects the token request body as an HTML-form-encoded string.
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // grant_type=client_credentials selects the client credentials flow (no user name / password of a person).
    body: 'grant_type=client_credentials',
  });
  // Any non-2xx answer (e.g. 401 when the client secret is wrong) -> 502 Bad Gateway: the shop acts as a
  // gateway to the ERP side and got an invalid answer from the upstream system (XSUAA).
  if (!res.ok) throw new ErpError(`ERP token request failed (${res.status})`, 502);
  // Parse the JSON answer, e.g. { access_token: "...", token_type: "bearer", expires_in: 43199, ... }.
  const data = await res.json();
  // Cache the token. expires_in is the lifetime in SECONDS; we subtract 60 s as a safety margin, so a token is
  // never used in its very last minute (it could expire while a request is still on the way, and clocks of
  // different servers may differ slightly). * 1000 converts seconds to milliseconds for Date.now().
  tokens.set(conn.id, { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  // Return the token string to the caller (authHeader).
  return data.access_token;
}

// Builds the value of the HTTP "Authorization" header for a request to the ERP, depending on the connector.
async function authHeader(conn) {
  // OAuth connector (SAP BTP / XSUAA): "Bearer <access token>" - the token is fetched or taken from the cache.
  if (conn.auth === 'oauth') return 'Bearer ' + (await oauthToken(conn));
  // Otherwise basic auth (local `cds watch` ERP with the mocked user, e.g. service-user):
  // "Basic " + base64("username:password"). An empty password is allowed (|| '' avoids "null" in the string).
  return 'Basic ' + Buffer.from(`${conn.username}:${conn.password || ''}`).toString('base64');
}

// Turns an unsuccessful ERP response (status code + raw body text) into a short, human-readable message.
function describeHttpError(status, raw) {
  // Default message: the first 150 characters of the body (an HTML error page could be very long), with
  // whitespace trimmed; if the body is empty, use just "HTTP <status>".
  let message = raw.slice(0, 150).trim() || `HTTP ${status}`;
  // CAP / OData return errors as JSON: { "error": { "code": "...", "message": "..." } }. If the body is such
  // JSON, use error.message. If the body is not JSON, JSON.parse throws and we simply keep the default message.
  try { message = JSON.parse(raw).error?.message || message; } catch { /* not JSON */ }
  // 401 Unauthorized (wrong/missing credentials) or 403 Forbidden (authenticated, but missing role, e.g. the
  // system-integration role): replace the message with a hint the admin can act on.
  if (status === 401 || status === 403) message = `access denied (${status}) - check user/password or service key`;
  // 404 whose body mentions "route" / "does not exist": this is the Cloud Foundry router's answer when no
  // running app is mapped to the URL (e.g. the ERP app is stopped) - not a missing ERP entity.
  if (status === 404 && /route|does not exist/i.test(raw)) message = 'app not found (404) - is the ERP app started?';
  // Return the final message (used by call() inside an ErpError).
  return message;
}

// Central function that performs ONE logical ERP call (with possible retries) and returns the parsed result.
//   conn    = connector row (url, auth, credentials)
//   path    = path below the ERP base URL, e.g. '/rest/api/products()'
//   options = { method: HTTP method (default GET), body: object sent as JSON,
//               retries: how many times a retryable error is repeated (default 2 -> up to 3 attempts) }
async function call(conn, path, { method = 'GET', body, retries = 2 } = {}) {
  // Endless loop with an attempt counter (0 = first try). It is left by `return` (success) or `throw` (error).
  for (let attempt = 0; ; attempt++) {
    // Any error in this block is handled by the catch below, which decides about a retry.
    try {
      // Send the request: full URL = connector base URL + path, with timeout (fetchWithTimeout).
      const res = await fetchWithTimeout(conn.url + path, {
        // HTTP method: GET (read), POST (create / call an action) or PATCH (partial update).
        method,
        // Authorization is computed for every attempt, so a renewed OAuth token is used after a retry.
        // Content-Type tells the ERP that the body (if any) is JSON.
        headers: { Authorization: await authHeader(conn), 'Content-Type': 'application/json' },
        // Serialize the JavaScript object to a JSON string; GET requests have no body (undefined = none).
        body: body ? JSON.stringify(body) : undefined,
      });
      // 401 Unauthorized with an OAuth connector on the first attempt: the cached token was probably rejected
      // (e.g. expired early or revoked). Delete it and repeat the request once with a new token.
      // This is safe even for POST (which is otherwise never retried): a 401 means the ERP rejected the
      // request before processing it, so nothing was created yet. Because attempt === 0 is required, it
      // happens at most once - a second 401 is treated as a real "access denied" error below.
      if (res.status === 401 && conn.auth === 'oauth' && tokens.has(conn.id) && attempt === 0) {
        clearToken(conn.id); // expired token: renew once
        // Jump directly to the next loop iteration (attempt = 1) without waiting.
        continue;
      }
      // 5xx = server error in the ERP (500 Internal Server Error, 502/503/504 from the BTP router, ...).
      // The shop answers 502 Bad Gateway (upstream system failed). retryable = true: often temporary.
      if (res.status >= 500) throw new ErpError(`ERP error ${res.status}`, 502, true);
      // Any other non-2xx status (4xx): the ERP understood the request but refused it.
      if (!res.ok) {
        // business errors from the ERP (e.g. 409 "exceeds stock") are passed on to the shop user
        // Read the body and build a readable message out of it (see describeHttpError above).
        const message = describeHttpError(res.status, await res.text());
        // Map the ERP status to the status the shop answers with:
        //  - 409 Conflict (business rule violated, e.g. not enough stock) -> 409, shown to the customer
        //  - 400 Bad Request / 422 Unprocessable Entity (ERP rejected the data) -> 422 (invalid input)
        //  - everything else (401, 403, 404, ...) -> 502 Bad Gateway: a problem between shop and ERP that is
        //    not the shop user's fault (wrong credentials, missing role, wrong URL)
        const status = res.status === 409 ? 409 : [400, 422].includes(res.status) ? 422 : 502;
        // Not retryable (default false): the same request would get the same 4xx answer again.
        throw new ErpError(`ERP: ${message}`, status);
      }
      // Success (2xx): read the body as text first (works for every content type, also for an empty body).
      const text = await res.text();
      // If the ERP declares JSON (e.g. "application/json;odata.metadata=minimal"), parse it into an object or
      // array; otherwise return the raw text (e.g. CSV text or an empty body).
      return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
    } catch (e) {
      // Give up and pass the error on if it is not retryable (4xx, configuration error, other bugs) or if
      // all allowed retries are used up.
      if (!e.retryable || attempt >= retries) throw e;
      // Exponential backoff: wait 500 ms * 2^attempt before the next try (500 ms, then 1000 ms, ...). The
      // growing pause gives a struggling ERP time to recover and avoids flooding it with repeated requests.
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

// Turns any value into an OData string literal: wrap it in single quotes and double every single quote
// inside it (OData escaping rule, e.g. O'Brien -> 'O''Brien'). This keeps user input (an e-mail address)
// from breaking the $filter expression or injecting extra filter conditions.
const quote = s => `'${String(s).replace(/'/g, "''")}'`;

/** API of one Mini-ERP, reached through the given connector. */
// Factory function: returns an object with one method per ERP operation, all bound to the given connector.
// Services call e.g. clientFor(conn).products() and never have to deal with URLs, auth or retries.
export function clientFor(conn) {
  // Helper for the REST API of the Mini-ERP: the path is used as it is (relative to the ERP base URL).
  const rest = (path, opts) => call(conn, path, opts);
  // Helper for the OData v4 API: prefixes the path with the service root of the CAP service SimpleERPService,
  // which CAP serves under /odata/v4/simple-erp.
  const odata = (path, opts) => call(conn, '/odata/v4/simple-erp' + path, opts);
  // The object returned to the caller. GET and PATCH use the default retries (2); every POST uses retries: 0.
  return {
    // REST API of the Mini-ERP (requires the system-integration role)
    // GET /rest/api/products() - all products as a JSON array (used by the product sync and the ping/test).
    products: () => rest('/rest/api/products()'),
    // GET /rest/api/getProducts() - the products via the ERP function getProducts(); per the method name the
    // answer is CSV, which call() returns as a plain string because it is not JSON.
    productsCsv: () => rest('/rest/api/getProducts()'),
    // GET /rest/api/customers() - all customers of the ERP.
    customers: () => rest('/rest/api/customers()'),
    // GET /rest/api/orders() - all orders of the ERP.
    orders: () => rest('/rest/api/orders()'),

    // OData API of the Mini-ERP (SimpleERPService)
    // GET /Customers?$filter=email eq '<email>'&$top=1 - search a customer by e-mail (the shared natural key
    // of shop and ERP customers). $top=1 limits the result to one row. The quoted literal is URL-encoded with
    // encodeURIComponent (spaces, '+', quotes ...). OData returns { value: [ ... ] }: take the first
    // entry, or null if the ERP has no customer with that e-mail.
    findCustomerByEmail: async email =>
      (await odata(`/Customers?$filter=email eq ${encodeURIComponent(quote(email))}&$top=1`)).value[0] || null,
    // POST /Customers - create a customer. retries: 0 because POST is not idempotent (a retry after a timeout
    // could create the same customer twice).
    createCustomer: data => odata('/Customers', { method: 'POST', body: data, retries: 0 }),
    // PATCH /Customers(<id>) - partial update of one customer, addressed by its key (UUID) in OData key syntax.
    // PATCH is idempotent (sending the same changes twice gives the same result), so default retries are fine.
    updateCustomer: (id, data) => odata(`/Customers(${id})`, { method: 'PATCH', body: data }),
    // POST /Products - create a product in the ERP (e.g. "Load demo catalog"); not retried (not idempotent).
    createProduct: data => odata('/Products', { method: 'POST', body: data, retries: 0 }),
    // PATCH /Products(<id>) - partial update of one product (idempotent, so retries are allowed).
    updateProduct: (id, data) => odata(`/Products(${id})`, { method: 'PATCH', body: data }),
    // GET /Orders?$select=ID,orderID,orderStatus_code - only the three fields needed to sync order statuses
    // ($select keeps the answer small): technical key, readable order number and the status code
    // (orderStatus_code is the foreign key CAP generates for the association orderStatus). Returns the array.
    orderStatuses: async () => (await odata('/Orders?$select=ID,orderID,orderStatus_code')).value,
    // who created each product (managed field createdBy): tells the ERP's initial data from products added via the API
    // GET /Products?$select=ID,createdBy - returns the array of { ID, createdBy }.
    productOrigins: async () => (await odata('/Products?$select=ID,createdBy')).value,
    // POST is not idempotent: never retried automatically, otherwise a timeout could create the order twice
    // POST /Orders - create an order in the ERP (the ERP checks and reduces the stock); retries: 0.
    createOrder: data => odata('/Orders', { method: 'POST', body: data, retries: 0 }),
    // POST /Orders(<id>)/SimpleERPService.<action> - call an OData v4 BOUND action on one order, e.g.
    // pickOrder, shipOrder, completeOrder or cancelOrder. Bound actions are addressed with the
    // namespace-qualified name and are always POST. Body {} = the actions take no parameters. Not retried,
    // because an action changes the order status (repeating it is not safe).
    orderAction: (id, action) =>
      odata(`/Orders(${id})/SimpleERPService.${action}`, { method: 'POST', body: {}, retries: 0 }),
  };
}

/** Connection test for the admin UI: REST (products) and OData (orders) with the connector's credentials. */
// Never throws: always returns a result object { ok, ms, ... } that the admin UI can display.
export async function testConnector(conn) {
  // Start time, to report how long the test took (a rough response-time indicator).
  const t0 = Date.now();
  // Any error of the two test calls below ends up in the catch block.
  try {
    // Test 1 - REST API: GET /rest/api/products(). retries: 0, so the admin gets the result immediately
    // instead of waiting for backoff pauses.
    const products = await call(conn, '/rest/api/products()', { retries: 0 });
    // The Mini-ERP answers with a JSON array. Anything else (e.g. an HTML page) means the URL points to a
    // different application -> 502 with a hint.
    if (!Array.isArray(products)) throw new ErpError('Unexpected answer - is this the Mini-ERP?', 502);
    // Test 2 - OData API: read at most one order ($top=1, only the ID). Checks that the second API and its
    // authorization also work, because the shop needs OData for customers and orders.
    await call(conn, '/odata/v4/simple-erp/Orders?$select=ID&$top=1', { retries: 0 });
    // Both calls worked: success, duration in milliseconds and the number of products in the ERP.
    return { ok: true, ms: Date.now() - t0, erpProducts: products.length };
  } catch (e) {
    // Failure: duration and the readable error message (e.g. "ERP not reachable (ECONNREFUSED)").
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

/** The active connector; throws 503 if none is active. */
// Guard used by routes/services that need an ERP: returns the active connector or throws.
export function requireActiveConnector() {
  // Read the active connector from SQLite.
  const c = getActiveConnector();
  // None active (shop runs standalone): 503 Service Unavailable - the ERP-dependent function cannot be used now.
  if (!c) throw new ErpError('No SAP connector is active (Admin > SAP connectors).', 503);
  // Return the connector row to the caller.
  return c;
}
