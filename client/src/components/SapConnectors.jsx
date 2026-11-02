import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateTime } from '../api.js';
import { useToast } from './Toast.jsx';
import Modal from './Modal.jsx';
import { DatabaseIcon, SyncIcon } from './Icons.jsx';

const PRESETS = {
  local: {
    label: 'Local SAP (cds watch)',
    hint: 'Mini-ERP started on your computer with cds watch. Its data lives in memory and is reset on every restart.',
    values: { name: 'Local SAP (cds watch)', url: 'http://localhost:4004', auth: 'basic', username: 'service-user', password: 'service-user', keyFile: '', autoCatalog: true, integration: 'api' },
  },
  btp: {
    label: 'SAP BTP (Cloud Foundry)',
    hint: 'Mini-ERP deployed to SAP BTP. URL = route of simple-erp-srv, credentials = service key of simple-erp-auth-api.',
    values: { name: 'SAP BTP (Cloud Foundry)', url: '', auth: 'oauth', username: '', password: '', keyFile: './xsuaa-key.json', autoCatalog: false, integration: 'api' },
  },
};

const EMPTY = { name: '', url: '', auth: 'basic', username: '', password: '', keyFile: '', autoCatalog: false, integration: 'api' };

const authLabel = c => (c.auth === 'oauth' ? 'OAuth 2.0 client credentials (XSUAA)' : 'HTTP basic auth');
const integrationLabel = c => (c.integration === 'file' ? 'File transfer (CSV files, Lab 2)' : 'API – REST/OData, live');
const kindLabel = c => (c.auth === 'oauth' || /hana\.ondemand\.com/.test(c.url) ? 'SAP BTP'
  : /localhost|127\.0\.0\.1/.test(c.url) ? 'Local ERP' : 'Remote ERP');

function syncText(last) {
  if (!last) return 'not synced yet';
  return last.ok
    ? `${dateTime(last.at)} · ${last.result.received} products received${last.result.file ? ` (file ${last.result.file})` : ''}`
    : `${dateTime(last.at)} · failed: ${last.error}`;
}

function syncToast(r) {
  if (r.mode === 'file') {
    const exp = r.export?.written ? `export ${r.export.file}` : r.export?.ok ? 'ERP data unchanged' : `export failed: ${r.export?.error}`;
    const imp = r.imports.length
      ? r.imports.map(i => (i.status === 'rejected' ? `${i.file} rejected` : `${i.rows} products imported (${i.created} new, ${i.updated} updated)`)).join(', ')
      : 'no file to import';
    return [`File transfer: ${exp} · ${imp}`, r.imports.some(i => i.status === 'rejected') || r.export?.ok === false ? 'error' : 'success'];
  }
  return [`Synced: ${r.products.received} products (${r.products.created} new, ${r.products.updated} updated)` +
    (r.catalog?.created ? `, ${r.catalog.created} demo products created in the ERP` : '') +
    `, ${r.orders.updated} order status changes`, 'success'];
}

function ConnectorForm({ initial, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !initial.id;
  const [form, setForm] = useState({ password: '', ...initial });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState(null);
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTest(null); };
  const input = k => ({ value: form[k] ?? '', onChange: e => set(k, e.target.value) });

  const body = () => ({
    name: form.name, url: form.url, auth: form.auth, username: form.username, password: form.password,
    keyFile: form.keyFile, autoCatalog: form.autoCatalog, integration: form.integration || 'api',
  });

  const runTest = async () => {
    setBusy('test');
    setError('');
    try {
      setTest(await api.testConnectorConfig({ ...body(), id: initial.id }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    setBusy('save');
    setError('');
    try {
      const saved = isNew ? await api.createConnector(body()) : await api.updateConnector(initial.id, body());
      toast(`${saved.name} saved`, 'success');
      onSaved(saved);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal title={isNew ? 'Add SAP connector' : `Edit ${initial.name}`} onClose={onClose}
           footer={<>
             <button onClick={runTest} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
             <span className="spacer" />
             <button onClick={onClose}>Cancel</button>
             <button className="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
           </>}>
      {isNew && (
        <div className="preset-row">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} type="button" className="preset" onClick={() => { setForm(f => ({ ...f, ...p.values })); setTest(null); }}>
              <strong>{p.label}</strong><span>{p.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div className="form-grid">
        <label className="span-all">Name<input {...input('name')} placeholder="e.g. Local SAP (cds watch)" /></label>
        <label className="span-all">ERP URL
          <input {...input('url')} className="mono"
                 placeholder={form.auth === 'oauth' ? 'https://<org>-<space>-simple-erp-srv.cfapps.us10-001.hana.ondemand.com' : 'http://localhost:4004'} />
        </label>
        <label className="span-all">Authentication
          <select value={form.auth} onChange={e => set('auth', e.target.value)}>
            <option value="basic">HTTP basic auth (local ERP: mocked users)</option>
            <option value="oauth">OAuth 2.0 client credentials (XSUAA on SAP BTP)</option>
          </select>
        </label>
        {form.auth === 'basic' ? (
          <>
            <label>User<input {...input('username')} autoComplete="off" /></label>
            <label>Password
              <input type="password" {...input('password')} autoComplete="new-password"
                     placeholder={initial.hasPassword ? 'unchanged' : ''} />
            </label>
          </>
        ) : (
          <label className="span-all">Service key file
            <input {...input('keyFile')} className="mono" placeholder="./xsuaa-key.json" />
            <small className="muted">Path relative to the server folder. Create the key with <code>cf create-service-key simple-erp-auth-api shop-key</code> and
              save the output of <code>cf service-key simple-erp-auth-api shop-key</code> as JSON. Never commit it.
              On SAP BTP use the service binding instead: <code>vcap:simple-erp-auth-api</code>.</small>
          </label>
        )}
        <label className="span-all">Product data reaches the shop via
          <select value={form.integration || 'api'} onChange={e => set('integration', e.target.value)}>
            <option value="api">API – REST/OData, live (orders are created in the ERP)</option>
            <option value="file">File transfer – the ERP's CSV export via the transfer folder (Lab 2)</option>
          </select>
        </label>
        <label className="check span-all">
          <input type="checkbox" checked={!!form.autoCatalog} onChange={e => set('autoCatalog', e.target.checked)} />
          Create the demo catalog in this ERP automatically (recommended for the local ERP)
        </label>
      </div>
      {test && (
        <p className={`test-result ${test.ok ? 'ok' : 'bad'}`}>
          {test.ok ? `Connection OK · ${test.erpProducts} products in the ERP · ${test.ms} ms` : `Connection failed: ${test.error}`}
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}

function ConnectorCard({ c, busy, test, onTest, onActivate, onEdit, onDelete }) {
  const last = c.lastSync;
  const state = c.active ? (last?.ok === false ? 'bad' : last?.ok ? 'good' : 'idle') : 'idle';
  return (
    <article className={`connector ${c.active ? 'active' : ''}`}>
      <div className="connector-head">
        <span className="connector-icon"><DatabaseIcon /></span>
        <div className="connector-title">
          <strong>{c.name}</strong>
          <span className="muted small">{kindLabel(c)} · {authLabel(c)}</span>
        </div>
        {c.active && <span className="active-badge"><span className={`dot ${state}`} /> Active</span>}
      </div>

      <dl className="facts compact">
        <dt>URL</dt><dd className="mono">{c.url}</dd>
        {c.auth === 'basic' ? (
          <><dt>User</dt><dd>{c.username} {c.hasPassword ? '' : <span className="tag">no password</span>}</dd></>
        ) : (
          <><dt>Service key</dt><dd><span className="mono">{c.keyFile}</span>{' '}
            {c.keyFileFound ? <span className="tag ok">found</span> : <span className="tag bad">file missing</span>}</dd></>
        )}
        <dt>Product data</dt><dd>{c.integration === 'file' ? <Link to="/admin/file-transfer">{integrationLabel(c)}</Link> : integrationLabel(c)}</dd>
        <dt>Demo catalog</dt><dd>{c.autoCatalog ? 'created automatically' : 'manual'}</dd>
        <dt>In the shop</dt><dd>{c.products} products · {c.orders} orders</dd>
        {c.active && <><dt>Last sync</dt><dd className={last?.ok === false ? 'error' : ''}>{syncText(last)}</dd></>}
      </dl>

      {test && (
        <p className={`test-result ${test.ok ? 'ok' : 'bad'}`}>
          {test.ok ? `Reachable · ${test.erpProducts} products in the ERP · ${test.ms} ms` : test.error}
        </p>
      )}

      <div className="connector-actions">
        {!c.active && (
          <button className="primary" disabled={!!busy} onClick={onActivate}>{busy === 'activate' ? 'Connecting…' : 'Use this ERP'}</button>
        )}
        <button disabled={!!busy} onClick={onTest}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        <button className="link" onClick={onEdit}>Edit</button>
        {!c.active && <button className="link danger" onClick={onDelete}>Delete</button>}
      </div>
    </article>
  );
}

export default function SapConnectors() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState({});
  const [tests, setTests] = useState({});
  const [editing, setEditing] = useState(null);

  const load = () => api.connectors().then(l => {
    setList(l);
    window.dispatchEvent(new Event('sap-connector-changed'));
  }).catch(e => toast(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const run = async (key, action, fn) => {
    setBusy(b => ({ ...b, [key]: action }));
    try {
      return await fn();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(b => ({ ...b, [key]: '' }));
      load();
    }
  };

  const test = c => run(c.id, 'test', async () => {
    const r = await api.testConnector(c.id);
    setTests(t => ({ ...t, [c.id]: r }));
  });

  const activate = c => run(c.id, 'activate', async () => {
    const r = await api.activateConnector(c.id);
    if (r.sync.ok && r.sync.mode === 'file') toast(`Shop now uses ${c.name} · ${syncToast(r.sync)[0]}`, syncToast(r.sync)[1]);
    else if (r.sync.ok) toast(`Shop now uses ${c.name}: ${r.sync.products.received} products synced`, 'success');
    else toast(`Switched to ${c.name}, but the ERP is not reachable: ${r.sync.error}`, 'error');
  });

  const remove = c => confirm(`Delete the connector "${c.name}"?`) && run(c.id, 'delete', async () => {
    await api.deleteConnector(c.id);
    toast(`${c.name} deleted`, 'info');
  });

  const active = list?.find(c => c.active);
  const fileMode = active?.integration === 'file';

  const sync = () => run('global', 'sync', async () => {
    const r = await api.erpSync();
    toast(...syncToast(r));
  });
  const loadCatalog = () => confirm(`Create the demo catalog (14 products) in ${active.name}? Only missing products are created.`) &&
    run('global', 'catalog', async () => {
      const r = await api.erpLoadCatalog();
      toast(`Demo catalog: ${r.created} products created in the ERP, ${r.completed} completed`, 'success');
    });
  const disconnect = () => confirm('Disconnect the shop from the ERP? It then runs standalone with its local products and stock.') &&
    run('global', 'disconnect', async () => {
      await api.disconnectErp();
      toast('Shop runs standalone (no SAP connector)', 'info');
    });

  if (!list) return <p className="muted">Loading…</p>;
  const g = busy.global;
  const last = active?.lastSync;

  return (
    <div className="stack">
      <section className={`card erp-status ${active ? (last?.ok === false ? 'bad' : 'on') : 'off'}`}>
        <div className="section-head">
          <h3>
            <span className={`dot ${active ? (last?.ok === false ? 'bad' : last?.ok ? 'good' : 'idle') : 'idle'}`} />
            {active ? `Shop is connected to ${active.name}` : 'No SAP connector active'}
          </h3>
          {active && (
            <div className="toolbar">
              <button className="primary" disabled={!!g} onClick={sync}><SyncIcon /> {g === 'sync' ? 'Syncing…' : 'Sync now'}</button>
              <button disabled={!!g} onClick={loadCatalog}>{g === 'catalog' ? 'Loading…' : 'Load demo catalog'}</button>
              <button className="link danger" disabled={!!g} onClick={disconnect}>Disconnect</button>
            </div>
          )}
        </div>
        {active ? (
          <>
            {fileMode ? (
              <p className="muted small">
                Products, prices and stock come from this ERP as <strong>files</strong> (Lab 2): the ERP's export is written into the
                transfer folder and imported by the shop. Orders stay in the shop. Details in <Link to="/admin/file-transfer">File transfer</Link>.
              </p>
            ) : (
              <p className="muted small">
                Products, prices and stock come from this ERP, every checkout creates an order there.
                Synced on start, after switching and every minute.
              </p>
            )}
            {last?.ok === false && (
              <p className="test-result bad">
                {active.name} is not reachable: {last.error}.{' '}
                {/localhost|127\.0\.0\.1/.test(active.url)
                  ? <>Start the Mini-ERP in its folder with <code>cds watch</code>.</>
                  : <>Start the ERP app (and HANA Cloud) in the SAP BTP cockpit.</>}
              </p>
            )}
          </>
        ) : (
          <p className="muted small">The shop runs standalone with its local products and stock. Choose an ERP below with “Use this ERP”.</p>
        )}
      </section>

      <section>
        <div className="section-head">
          <h3>SAP connectors <span className="muted">({list.length})</span></h3>
          <button className="primary" onClick={() => setEditing({ ...EMPTY })}>Add connector</button>
        </div>
        <div className="connector-grid">
          {list.map(c => (
            <ConnectorCard key={c.id} c={c} busy={busy[c.id]} test={tests[c.id]}
                           onTest={() => test(c)} onActivate={() => activate(c)}
                           onEdit={() => setEditing(c)} onDelete={() => remove(c)} />
          ))}
        </div>
      </section>

      <section className="card">
        <h3>What is managed where</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Data</th><th>Master system</th><th>How the shop gets it</th></tr></thead>
            <tbody>
              {fileMode ? (
                <>
                  <tr><td>Products, prices, stock</td><td><span className="tag erp">SAP ERP</span></td><td>CSV export <code>/rest/api/getProducts()</code> → file in <code>transfer/inbox</code> → import (Admin &gt; File transfer); changed only in the ERP</td></tr>
                  <tr><td>Orders</td><td><span className="tag">Shop</span></td><td>Kept in the shop, which reduces its own stock; the next file brings the ERP's stock again</td></tr>
                  <tr><td>Customers</td><td><span className="tag">Shop</span></td><td>Only in the shop while file transfer is used</td></tr>
                </>
              ) : (
                <>
                  <tr><td>Products, prices, stock</td><td><span className="tag erp">SAP ERP</span></td><td>REST <code>/rest/api/products()</code> of the active connector; admin changes are written to the ERP first (OData)</td></tr>
                  <tr><td>Orders</td><td><span className="tag erp">SAP ERP</span></td><td>OData <code>POST /Orders</code> at checkout (the ERP checks and reduces stock); status changes via ERP actions in the ERP the order was created in</td></tr>
                  <tr><td>Customers</td><td>Shop + ERP</td><td>Found by e-mail or created in the active ERP at registration or the first order</td></tr>
                </>
              )}
              <tr><td>Passwords, sessions, cart, categories</td><td><span className="tag">Shop</span></td><td>Only in the shop database (SQLite)</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {editing && <ConnectorForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
