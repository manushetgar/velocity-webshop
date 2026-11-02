import { getActiveConnector } from './connectors.js';
import { readServiceKey } from './serviceKey.js';

const TIMEOUT_MS = () => Number(process.env.ERP_TIMEOUT_MS || 10000);
const tokens = new Map();

export const clearToken = connectorId => tokens.delete(connectorId);

export function erpConfig() {
  const c = getActiveConnector();
  if (!c) return { configured: false, url: null, mode: null, id: null, name: null };
  return { configured: true, url: c.url, mode: c.auth, id: c.id, name: c.name };
}

export class ErpError extends Error {
  constructor(message, status, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function fetchWithTimeout(url, opts) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS()) });
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS()} ms` : e.cause?.code || e.message;
    throw new ErpError(`ERP not reachable (${reason})`, 503, true);
  }
}

async function oauthToken(conn) {
  const cached = tokens.get(conn.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let c;
  try {
    c = readServiceKey(conn.key_file);
  } catch (e) {
    throw new ErpError(e.message, 503);
  }
  const res = await fetchWithTimeout(`${c.url}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${c.clientid}:${c.clientsecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new ErpError(`ERP token request failed (${res.status})`, 502);
  const data = await res.json();
  tokens.set(conn.id, { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

async function authHeader(conn) {
  if (conn.auth === 'oauth') return 'Bearer ' + (await oauthToken(conn));
  return 'Basic ' + Buffer.from(`${conn.username}:${conn.password || ''}`).toString('base64');
}

function describeHttpError(status, raw) {
  let message = raw.slice(0, 150).trim() || `HTTP ${status}`;
  try { message = JSON.parse(raw).error?.message || message; } catch {}
  if (status === 401 || status === 403) message = `access denied (${status}) - check user/password or service key`;
  if (status === 404 && /route|does not exist/i.test(raw)) message = 'app not found (404) - is the ERP app started?';
  return message;
}

async function call(conn, path, { method = 'GET', body, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout(conn.url + path, {
        method,
        headers: { Authorization: await authHeader(conn), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && conn.auth === 'oauth' && tokens.has(conn.id) && attempt === 0) {
        clearToken(conn.id);
        continue;
      }
      if (res.status >= 500) throw new ErpError(`ERP error ${res.status}`, 502, true);
      if (!res.ok) {
        const message = describeHttpError(res.status, await res.text());
        const status = res.status === 409 ? 409 : [400, 422].includes(res.status) ? 422 : 502;
        throw new ErpError(`ERP: ${message}`, status);
      }
      const text = await res.text();
      return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

const quote = s => `'${String(s).replace(/'/g, "''")}'`;

export function clientFor(conn) {
  const rest = (path, opts) => call(conn, path, opts);
  const odata = (path, opts) => call(conn, '/odata/v4/simple-erp' + path, opts);
  return {
    products: () => rest('/rest/api/products()'),
    productsCsv: () => rest('/rest/api/getProducts()'),
    customers: () => rest('/rest/api/customers()'),
    orders: () => rest('/rest/api/orders()'),

    // POSTs use retries: 0 because they are not idempotent (a retry could create a duplicate order).
    findCustomerByEmail: async email =>
      (await odata(`/Customers?$filter=email eq ${encodeURIComponent(quote(email))}&$top=1`)).value[0] || null,
    createCustomer: data => odata('/Customers', { method: 'POST', body: data, retries: 0 }),
    updateCustomer: (id, data) => odata(`/Customers(${id})`, { method: 'PATCH', body: data }),
    createProduct: data => odata('/Products', { method: 'POST', body: data, retries: 0 }),
    updateProduct: (id, data) => odata(`/Products(${id})`, { method: 'PATCH', body: data }),
    orderStatuses: async () => (await odata('/Orders?$select=ID,orderID,orderStatus_code')).value,
    productOrigins: async () => (await odata('/Products?$select=ID,createdBy')).value,
    createOrder: data => odata('/Orders', { method: 'POST', body: data, retries: 0 }),
    orderAction: (id, action) =>
      odata(`/Orders(${id})/SimpleERPService.${action}`, { method: 'POST', body: {}, retries: 0 }),
  };
}

export async function testConnector(conn) {
  const t0 = Date.now();
  try {
    const products = await call(conn, '/rest/api/products()', { retries: 0 });
    if (!Array.isArray(products)) throw new ErpError('Unexpected answer - is this the Mini-ERP?', 502);
    await call(conn, '/odata/v4/simple-erp/Orders?$select=ID&$top=1', { retries: 0 });
    return { ok: true, ms: Date.now() - t0, erpProducts: products.length };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

export function requireActiveConnector() {
  const c = getActiveConnector();
  if (!c) throw new ErpError('No SAP connector is active (Admin > SAP connectors).', 503);
  return c;
}
