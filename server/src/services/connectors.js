import { db, getSetting, setSetting } from '../db.js';
import { httpError } from '../util.js';
import { serviceKeyAvailable } from './serviceKey.js';

const load = id => db.prepare('SELECT * FROM erp_connectors WHERE id = ?').get(id);

export function getActiveConnector() {
  const id = getSetting('active_connector');
  return id ? load(id) || null : null;
}

export const listConnectors = () => db.prepare('SELECT * FROM erp_connectors ORDER BY rowid').all();

export function getConnector(id) {
  const c = load(id);
  if (!c) throw httpError(404, 'Connector not found.');
  return c;
}

export function setActiveConnector(id) {
  if (id) getConnector(id);
  setSetting('active_connector', id || '');
}

export function connectorToApi(c, extra = {}) {
  const active = getActiveConnector();
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    auth: c.auth,
    username: c.username || '',
    hasPassword: !!c.password,
    keyFile: c.key_file || '',
    keyFileFound: c.auth === 'oauth' ? serviceKeyAvailable(c.key_file) : null,
    autoCatalog: !!c.auto_catalog,
    integration: c.integration || 'api',
    active: active?.id === c.id,
    ...extra,
  };
}

function validate(body, existing) {
  const name = String(body.name ?? existing?.name ?? '').trim();
  const url = String(body.url ?? existing?.url ?? '').trim().replace(/\/$/, '');
  const auth = body.auth ?? existing?.auth;
  if (!name) throw httpError(400, 'Name is required.');
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw httpError(400, 'URL must start with http:// or https://');
  if (!['basic', 'oauth'].includes(auth)) throw httpError(400, 'Authentication must be "basic" or "oauth".');
  const username = body.username ?? existing?.username ?? null;
  const password = body.password ? body.password : existing?.password ?? null;
  const keyFile = body.keyFile ?? existing?.key_file ?? null;
  if (auth === 'basic' && !username) throw httpError(400, 'User is required for basic authentication.');
  if (auth === 'oauth' && !keyFile) throw httpError(400, 'Service key file is required for OAuth (XSUAA).');
  const autoCatalog = body.autoCatalog !== undefined ? (body.autoCatalog ? 1 : 0) : existing?.auto_catalog ?? 0;
  const integration = body.integration ?? existing?.integration ?? 'api';
  if (!['api', 'file'].includes(integration)) throw httpError(400, 'Integration must be "api" or "file".');
  return { name, url, auth, username: auth === 'basic' ? username : null, password: auth === 'basic' ? password : null,
           keyFile: auth === 'oauth' ? keyFile : null, autoCatalog, integration };
}

export function connectorFromBody(body) {
  const existing = body.id ? load(body.id) : undefined;
  return { id: body.id || '_test', ...toRow(validate(body, existing)) };
}
const toRow = c => ({ name: c.name, url: c.url, auth: c.auth, username: c.username, password: c.password,
                      key_file: c.keyFile, auto_catalog: c.autoCatalog, integration: c.integration });

export function createConnector(body) {
  const c = validate(body);
  let id = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'erp';
  for (let i = 2; load(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
  db.prepare(`INSERT INTO erp_connectors (id, name, url, auth, username, password, key_file, auto_catalog, integration)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.name, c.url, c.auth, c.username, c.password, c.keyFile, c.autoCatalog, c.integration);
  return load(id);
}

export function updateConnector(id, body) {
  const existing = getConnector(id);
  const c = validate(body, existing);
  db.prepare(`UPDATE erp_connectors SET name = ?, url = ?, auth = ?, username = ?, password = ?, key_file = ?, auto_catalog = ?,
              integration = ? WHERE id = ?`)
    .run(c.name, c.url, c.auth, c.username, c.password, c.keyFile, c.autoCatalog, c.integration, id);
  return load(id);
}

export function deleteConnector(id) {
  getConnector(id);
  if (getActiveConnector()?.id === id) throw httpError(409, 'The active connector cannot be deleted. Activate another one first.');
  const orders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE erp_connector = ?').get(id).n;
  if (orders) throw httpError(409, `${orders} shop order(s) live in this ERP, so the connector cannot be deleted.`);
  db.transaction(() => {
    db.prepare('UPDATE products SET erp_id = NULL, erp_connector = NULL WHERE erp_connector = ?').run(id);
    db.prepare('UPDATE customers SET erp_customer_id = NULL, erp_connector = NULL WHERE erp_connector = ?').run(id);
    db.prepare('DELETE FROM erp_connectors WHERE id = ?').run(id);
  })();
}
