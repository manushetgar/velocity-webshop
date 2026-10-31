// api.js - the only place where the React app talks to the shop's backend (REST API under /api), plus formatting
// helpers for money and dates. Every function returns a Promise with the parsed JSON (or throws an Error with the
// server's message, which the pages show in a toast or form).
//
// Key of the session token in localStorage.
const TOKEN_KEY = 'webshop.token';

// Reads and writes the session token (localStorage keeps it across page reloads).
export const tokenStore = {
  // The stored token, or null (also when the browser blocks storage, e.g. in some private modes).
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  // Store a token, or remove it when t is null (logout); a blocked storage is ignored.
  set: t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

// Authorization header of the logged-in user (session token), or none.
const authHeader = () => {
  // The current token.
  const token = tokenStore.get();
  // Bearer token header for fetch(), or an empty object (spread into the headers).
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Generic JSON request: method (GET/POST/...), path below /api, optional body. Used by all functions below.
async function request(method, path, body) {
  // The body is sent as JSON.
  const headers = { 'Content-Type': 'application/json' };
  // The session token, if somebody is logged in.
  const token = tokenStore.get();
  // The server identifies the user by this header (auth.js on the server).
  if (token) headers.Authorization = `Bearer ${token}`;
  // Send the request (the Vite dev server forwards /api to Express on port 3001).
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  // 204 No Content (e.g. logout, delete): nothing to parse.
  if (res.status === 204) return null;
  // Parse the JSON answer; a body that is not JSON becomes an empty object.
  const data = await res.json().catch(() => ({}));
  // HTTP error (4xx/5xx): throw with the server's message ({ error }) or a generic one.
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  // Success: the parsed data.
  return data;
}

// All API calls of the app, grouped by area. Each line maps one function to one endpoint of the server.
export const api = {
  // products
  // Product list; all=true also returns removed (inactive) products for the admin.
  products: (all = false) => request('GET', `/products${all ? '?all=true' : ''}`),
  // One product by id.
  product: id => request('GET', `/products/${id}`),
  // Admin: new product (written to the ERP first).
  addProduct: p => request('POST', '/products', p),
  // Admin: change a product.
  updateProduct: (id, p) => request('PUT', `/products/${id}`, p),
  // Admin: remove a product (soft delete; restore = updateProduct with active: true).
  removeProduct: id => request('DELETE', `/products/${id}`),
  // customers
  // Demo logins shown on the login page.
  demoAccounts: () => request('GET', '/demo-accounts'),
  // Create an account (and log in).
  register: data => request('POST', '/auth/register', data),
  // Log in with e-mail and password.
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  // End the session.
  logout: () => request('POST', '/auth/logout'),
  // The logged-in user's profile.
  me: () => request('GET', '/me'),
  // Change profile, address or password.
  updateMe: data => request('PUT', '/me', data),
  // orders
  // Checkout: [{ productId, quantity }] -> the new order (created in the ERP first).
  checkout: items => request('POST', '/orders', { items }),
  // Own orders; all=true = all orders (admin).
  orders: (all = false) => request('GET', `/orders${all ? '?all=true' : ''}`),
  // One order.
  order: id => request('GET', `/orders/${id}`),
  // Admin: new status (PICKED, SHIPPED, COMPLETED, CANCELED) - executed as an ERP action.
  setOrderStatus: (id, status) => request('PATCH', `/orders/${id}/status`, { status }),
  // Customer: cancel an own order while it is NEW.
  cancelOrder: id => request('POST', `/orders/${id}/cancel`),
  // admin
  // Admin dashboard: counters and revenue.
  stats: () => request('GET', '/admin/stats'),
  // Admin: all customer accounts with order statistics.
  customers: () => request('GET', '/admin/customers'),
  // ERP connection
  // State of the ERP connection (shown in the header and on the shop page).
  erpStatus: () => request('GET', '/erp/status'),
  // Synchronize products and order statuses from the ERP now.
  erpSync: () => request('POST', '/erp/sync'),
  // Check whether the active ERP answers.
  erpPing: () => request('GET', '/erp/ping'),
  // Load the demo catalog into the ERP.
  erpLoadCatalog: () => request('POST', '/erp/load-catalog'),
  // SAP connectors (admin)
  // All SAP connectors with their state.
  connectors: () => request('GET', '/erp/connectors'),
  // Add a connector.
  createConnector: c => request('POST', '/erp/connectors', c),
  // Change a connector.
  updateConnector: (id, c) => request('PUT', `/erp/connectors/${id}`, c),
  // Delete a connector.
  deleteConnector: id => request('DELETE', `/erp/connectors/${id}`),
  // Test a saved connector (REST + OData call).
  testConnector: id => request('POST', `/erp/connectors/${id}/test`),
  // Test connector settings before saving them.
  testConnectorConfig: c => request('POST', '/erp/connectors/test', c),
  // Make a connector the active ERP of the shop.
  activateConnector: id => request('POST', `/erp/connectors/${id}/activate`),
  // Run the shop without an ERP (standalone mode).
  disconnectErp: () => request('POST', '/erp/disconnect'),
  // Lab 2: file transfer (admin)
  // State of the file transfer: mode, folders, history.
  fileTransfer: () => request('GET', '/erp/files'),
  // Switch the active connector between 'api' and 'file'.
  setIntegration: integration => request('POST', '/erp/files/mode', { integration }),
  // Write an ERP export file now.
  fileExport: () => request('POST', '/erp/files/export'),
  // Import the inbox now.
  fileImport: () => request('POST', '/erp/files/import'),
  // The file itself is the request body (binary), its original name goes into the query string.
  // Upload a product file into the inbox (binary body, not JSON).
  fileUpload: async file => {
    // POST the file to the upload endpoint; the original name is passed in the query string.
    const res = await fetch(`/api/erp/files/upload?name=${encodeURIComponent(file.name)}`, {
      // Raw bytes plus the login token.
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...authHeader() }, body: file,
    });
    // Parse the JSON answer (the import result).
    const data = await res.json().catch(() => ({}));
    // Error answer: throw with the server's message.
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    // The import result.
    return data;
  },
  // Lab 2 extension: suppliers (admin)
  // Suppliers with profiles, logins, inbox and the target ERPs.
  suppliers: () => request('GET', '/suppliers'),
  // New supplier.
  createSupplier: s => request('POST', '/suppliers', s),
  // Change name, location, active flag or mapping profile.
  updateSupplier: (id, s) => request('PUT', `/suppliers/${id}`, s),
  // New portal/FTP login for a supplier.
  createSupplierUser: (id, u) => request('POST', `/suppliers/${id}/users`, u),
  // New password for a supplier login.
  resetSupplierPassword: (userId, password) => request('PUT', `/suppliers/users/${userId}/password`, { password }),
  // Delete a supplier login.
  deleteSupplierUser: userId => request('DELETE', `/suppliers/users/${userId}`),
  // Newest deliveries, of all suppliers or of one.
  supplierDeliveries: (supplier = '') => request('GET', `/suppliers/deliveries${supplier ? `?supplier=${encodeURIComponent(supplier)}` : ''}`),
  // Process all supplier inboxes now (also retries waiting files).
  processSuppliers: () => request('POST', '/suppliers/process'),
  // Where supplier data is written: { mode: 'active' | 'list' | 'all', ids }.
  // PUT the new setting; returns the resolved targets.
  setSupplierTargets: t => request('PUT', '/suppliers/targets', t),
  // The acknowledgement / error report of a delivery (plain text).
  // GET the report as text (not JSON).
  deliveryReport: async id => {
    // With the login token.
    const res = await fetch(`/api/suppliers/deliveries/${id}/report`, { headers: authHeader() });
    // Error: read the JSON error message if there is one.
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    // The report text.
    return res.text();
  },
  // Reads a file with a (possibly unsaved) mapping profile - nothing is imported.
  // POST the file with the profile in a header (the body is the file itself).
  previewSupplierFile: async (id, file, profile) => {
    // File name in the query string (the format is detected from it).
    const res = await fetch(`/api/suppliers/${id}/preview?name=${encodeURIComponent(file.name)}`, {
      // The file is the body.
      method: 'POST', body: file,
      // Binary body; the profile as URI-encoded JSON in X-Profile; the login token.
      headers: { 'Content-Type': 'application/octet-stream', 'X-Profile': encodeURIComponent(JSON.stringify(profile)), ...authHeader() },
    });
    // Parse the answer (how the file was read).
    const data = await res.json().catch(() => ({}));
    // Error: throw with the server's message.
    if (!res.ok) throw new Error(data.error || `Preview failed (${res.status})`);
    // Format, mapping, first products and problems.
    return data;
  },
  // Downloads a file of a transfer folder (fetch with the auth header, then save it via a temporary link).
  // folder = inbox / processed / error, name = file name.
  fileDownload: async (folder, name) => {
    // GET the file with the login token.
    const res = await fetch(`/api/erp/files/download/${folder}/${encodeURIComponent(name)}`, { headers: authHeader() });
    // Error: throw with the server's message.
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    // Temporary browser URL for the downloaded bytes.
    const url = URL.createObjectURL(await res.blob());
    // Invisible link with the download attribute (= save under this name).
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    // The link must be in the document for click() to work in every browser.
    document.body.appendChild(a);
    // Start the download.
    a.click();
    // Remove the link again.
    a.remove();
    // Free the temporary URL a moment later.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

// Formats an amount as money, e.g. 1.299,00 € (German number format, currency from the ERP).
export const money = (value, currency = 'EUR') =>
  // Intl.NumberFormat does the formatting (thousands separator, decimal comma, currency symbol).
  new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);

// SQLite returns UTC timestamps without a zone marker
// Turns '2026-10-26 15:42:00' into a Date in UTC (ISO strings with T are used as they are).
const parse = s => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
// Date and time for tables, e.g. 26.10.2026, 16:42 (local time of the browser).
export const dateTime = s => (s ? parse(s).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
// Date only, e.g. 26.10.2026.
export const dateOnly = s => (s ? parse(s).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : '');
