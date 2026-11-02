const TOKEN_KEY = 'webshop.token';

export const tokenStore = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} },
};

const authHeader = () => {
  const token = tokenStore.get();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  products: (all = false) => request('GET', `/products${all ? '?all=true' : ''}`),
  product: id => request('GET', `/products/${id}`),
  addProduct: p => request('POST', '/products', p),
  updateProduct: (id, p) => request('PUT', `/products/${id}`, p),
  removeProduct: id => request('DELETE', `/products/${id}`),
  demoAccounts: () => request('GET', '/demo-accounts'),
  register: data => request('POST', '/auth/register', data),
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/me'),
  updateMe: data => request('PUT', '/me', data),
  checkout: items => request('POST', '/orders', { items }),
  orders: (all = false) => request('GET', `/orders${all ? '?all=true' : ''}`),
  order: id => request('GET', `/orders/${id}`),
  setOrderStatus: (id, status) => request('PATCH', `/orders/${id}/status`, { status }),
  cancelOrder: id => request('POST', `/orders/${id}/cancel`),
  stats: () => request('GET', '/admin/stats'),
  customers: () => request('GET', '/admin/customers'),
  erpStatus: () => request('GET', '/erp/status'),
  erpSync: () => request('POST', '/erp/sync'),
  erpPing: () => request('GET', '/erp/ping'),
  erpLoadCatalog: () => request('POST', '/erp/load-catalog'),
  connectors: () => request('GET', '/erp/connectors'),
  createConnector: c => request('POST', '/erp/connectors', c),
  updateConnector: (id, c) => request('PUT', `/erp/connectors/${id}`, c),
  deleteConnector: id => request('DELETE', `/erp/connectors/${id}`),
  testConnector: id => request('POST', `/erp/connectors/${id}/test`),
  testConnectorConfig: c => request('POST', '/erp/connectors/test', c),
  activateConnector: id => request('POST', `/erp/connectors/${id}/activate`),
  disconnectErp: () => request('POST', '/erp/disconnect'),
  fileTransfer: () => request('GET', '/erp/files'),
  setIntegration: integration => request('POST', '/erp/files/mode', { integration }),
  fileExport: () => request('POST', '/erp/files/export'),
  fileImport: () => request('POST', '/erp/files/import'),
  fileUpload: async file => {
    const res = await fetch(`/api/erp/files/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...authHeader() }, body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    return data;
  },
  suppliers: () => request('GET', '/suppliers'),
  createSupplier: s => request('POST', '/suppliers', s),
  updateSupplier: (id, s) => request('PUT', `/suppliers/${id}`, s),
  createSupplierUser: (id, u) => request('POST', `/suppliers/${id}/users`, u),
  resetSupplierPassword: (userId, password) => request('PUT', `/suppliers/users/${userId}/password`, { password }),
  deleteSupplierUser: userId => request('DELETE', `/suppliers/users/${userId}`),
  supplierDeliveries: (supplier = '') => request('GET', `/suppliers/deliveries${supplier ? `?supplier=${encodeURIComponent(supplier)}` : ''}`),
  processSuppliers: () => request('POST', '/suppliers/process'),
  setSupplierTargets: t => request('PUT', '/suppliers/targets', t),
  deliveryReport: async id => {
    const res = await fetch(`/api/suppliers/deliveries/${id}/report`, { headers: authHeader() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    return res.text();
  },
  previewSupplierFile: async (id, file, profile) => {
    const res = await fetch(`/api/suppliers/${id}/preview?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Profile': encodeURIComponent(JSON.stringify(profile)), ...authHeader() },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Preview failed (${res.status})`);
    return data;
  },
  fileDownload: async (folder, name) => {
    const res = await fetch(`/api/erp/files/download/${folder}/${encodeURIComponent(name)}`, { headers: authHeader() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const money = (value, currency = 'EUR') =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);

const parse = s => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
export const dateTime = s => (s ? parse(s).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const dateOnly = s => (s ? parse(s).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : '');
