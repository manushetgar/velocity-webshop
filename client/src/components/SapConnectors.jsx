// SapConnectors.jsx - the tab Admin > SAP connectors (header comment below).
//
// React hooks: effect (loading), state.
import { useEffect, useState } from 'react';
// Router link.
import { Link } from 'react-router-dom';
// API calls and date formatting.
import { api, dateTime } from '../api.js';
// Notifications.
import { useToast } from './Toast.jsx';
// Dialog window (add / edit).
import Modal from './Modal.jsx';
// Icons.
import { DatabaseIcon, SyncIcon } from './Icons.jsx';

/*
 * Admin > SAP connectors: the ERP systems the shop can be connected to.
 * Exactly one connector (or none) is active; the shop shows the products of that ERP
 * and creates its orders there.
 */

// Ready-made settings for the two usual ERPs (buttons in the 'Add connector' dialog).
const PRESETS = {
  // Local Mini-ERP started with cds watch.
  local: {
    // Button title.
    label: 'Local SAP (cds watch)',
    // Button text.
    hint: 'Mini-ERP started on your computer with cds watch. Its data lives in memory and is reset on every restart.',
    // Values: localhost:4004, basic auth with the ERP's mocked service user, demo catalog on.
    values: { name: 'Local SAP (cds watch)', url: 'http://localhost:4004', auth: 'basic', username: 'service-user', password: 'service-user', keyFile: '', autoCatalog: true, integration: 'api' },
  },
  // Mini-ERP on SAP BTP.
  btp: {
    // Button title.
    label: 'SAP BTP (Cloud Foundry)',
    // Button text.
    hint: 'Mini-ERP deployed to SAP BTP. URL = route of simple-erp-srv, credentials = service key of simple-erp-auth-api.',
    // Values: OAuth with the service key file; the URL must be filled in.
    values: { name: 'SAP BTP (Cloud Foundry)', url: '', auth: 'oauth', username: '', password: '', keyFile: './xsuaa-key.json', autoCatalog: false, integration: 'api' },
  },
};

// An empty connector (dialog without a preset).
const EMPTY = { name: '', url: '', auth: 'basic', username: '', password: '', keyFile: '', autoCatalog: false, integration: 'api' };

// Readable name of the authentication method.
const authLabel = c => (c.auth === 'oauth' ? 'OAuth 2.0 client credentials (XSUAA)' : 'HTTP basic auth');
// Readable name of the integration style (API or file transfer).
const integrationLabel = c => (c.integration === 'file' ? 'File transfer (CSV files, Lab 2)' : 'API – REST/OData, live');
// Kind of ERP from auth and URL: SAP BTP, local or another remote ERP.
const kindLabel = c => (c.auth === 'oauth' || /hana\.ondemand\.com/.test(c.url) ? 'SAP BTP'
  : /localhost|127\.0\.0\.1/.test(c.url) ? 'Local ERP' : 'Remote ERP');

// Text of the last sync: time and number of products, or the error.
function syncText(last) {
  // Never synced.
  if (!last) return 'not synced yet';
  // Success: time, products received (and the file name in file mode); failure: time and error.
  return last.ok
    ? `${dateTime(last.at)} · ${last.result.received} products received${last.result.file ? ` (file ${last.result.file})` : ''}`
    : `${dateTime(last.at)} · failed: ${last.error}`;
}

// Toast text of a sync run: API sync (products + order statuses) or file transfer run (export + import).
// Returns [text, kind] for the toast.
function syncToast(r) {
  // File transfer: describe the export and the imports.
  if (r.mode === 'file') {
    // Export: new file, data unchanged, or failed.
    const exp = r.export?.written ? `export ${r.export.file}` : r.export?.ok ? 'ERP data unchanged' : `export failed: ${r.export?.error}`;
    // Imports: per file rejected or counted, or nothing to import.
    const imp = r.imports.length
      ? r.imports.map(i => (i.status === 'rejected' ? `${i.file} rejected` : `${i.rows} products imported (${i.created} new, ${i.updated} updated)`)).join(', ')
      : 'no file to import';
    // Error kind if a file was rejected or the export failed.
    return [`File transfer: ${exp} · ${imp}`, r.imports.some(i => i.status === 'rejected') || r.export?.ok === false ? 'error' : 'success'];
  }
  // API sync: products received / new / updated, demo products created and order status changes.
  return [`Synced: ${r.products.received} products (${r.products.created} new, ${r.products.updated} updated)` +
    (r.catalog?.created ? `, ${r.catalog.created} demo products created in the ERP` : '') +
    `, ${r.orders.updated} order status changes`, 'success'];
}

/* ---------- add / edit dialog ---------- */
// Dialog to add or edit a connector, with a connection test before saving.
function ConnectorForm({ initial, onClose, onSaved }) {
  // Notifications.
  const toast = useToast();
  // No id = new connector.
  const isNew = !initial.id;
  // Form values (the password field starts empty: the stored password is never sent to the browser).
  const [form, setForm] = useState({ password: '', ...initial });
  // Which button is running: 'test' or 'save'.
  const [busy, setBusy] = useState('');
  // Error message.
  const [error, setError] = useState('');
  // Result of the last test (cleared when a field changes).
  const [test, setTest] = useState(null);
  // Changes one field and clears the old test result.
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTest(null); };
  // Props for a text input bound to form[k].
  const input = k => ({ value: form[k] ?? '', onChange: e => set(k, e.target.value) });

  // The fields sent to the server.
  const body = () => ({
    // Name, URL, authentication and credentials.
    name: form.name, url: form.url, auth: form.auth, username: form.username, password: form.password,
    // Key file, demo catalog and integration style.
    keyFile: form.keyFile, autoCatalog: form.autoCatalog, integration: form.integration || 'api',
  });

  // Tests the settings in the form without saving them.
  const runTest = async () => {
    // Test button busy.
    setBusy('test');
    // Clear the old error.
    setError('');
    try {
      // POST /api/erp/connectors/test (id: to reuse the stored password when the field is empty).
      setTest(await api.testConnectorConfig({ ...body(), id: initial.id }));
    } catch (e) {
      // Show the error.
      setError(e.message);
    } finally {
      // Not busy any more.
      setBusy('');
    }
  };

  // Saves the connector.
  const save = async () => {
    // Save button busy.
    setBusy('save');
    // Clear the old error.
    setError('');
    try {
      // New: POST; existing: PUT.
      const saved = isNew ? await api.createConnector(body()) : await api.updateConnector(initial.id, body());
      // Confirmation.
      toast(`${saved.name} saved`, 'success');
      // Tell the parent (closes the dialog, reloads the list).
      onSaved(saved);
    } catch (e) {
      // Show the error (e.g. invalid URL).
      setError(e.message);
    } finally {
      // Not busy any more.
      setBusy('');
    }
  };

  // The dialog markup.
  return (
    // Dialog with a title; footer with the buttons.
    <Modal title={isNew ? 'Add SAP connector' : `Edit ${initial.name}`} onClose={onClose}
           footer={<>
             {/* Test the connection. */}
             <button onClick={runTest} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
             {/* Space between the buttons. */}
             <span className="spacer" />
             {/* Cancel. */}
             <button onClick={onClose}>Cancel</button>
             {/* Save. */}
             <button className="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
           </>}>
      {/* New connectors: preset buttons. */}
      {isNew && (
        // Preset row.
        <div className="preset-row">
          {/* One button per preset. */}
          {Object.entries(PRESETS).map(([k, p]) => (
            // Fills the form with the preset values.
            <button key={k} type="button" className="preset" onClick={() => { setForm(f => ({ ...f, ...p.values })); setTest(null); }}>
              {/* Title and hint of the preset. */}
              <strong>{p.label}</strong><span>{p.hint}</span>
            </button>
          ))}
        </div>
      )}
      {/* Form grid. */}
      <div className="form-grid">
        {/* Name. */}
        <label className="span-all">Name<input {...input('name')} placeholder="e.g. Local SAP (cds watch)" /></label>
        {/* ERP URL. */}
        <label className="span-all">ERP URL
          {/* URL input; the placeholder shows an example for the chosen authentication. */}
          <input {...input('url')} className="mono"
                 placeholder={form.auth === 'oauth' ? 'https://<org>-<space>-simple-erp-srv.cfapps.us10-001.hana.ondemand.com' : 'http://localhost:4004'} />
        </label>
        {/* Authentication method. */}
        <label className="span-all">Authentication
          {/* Select box. */}
          <select value={form.auth} onChange={e => set('auth', e.target.value)}>
            {/* Basic auth (local ERP). */}
            <option value="basic">HTTP basic auth (local ERP: mocked users)</option>
            {/* OAuth (SAP BTP). */}
            <option value="oauth">OAuth 2.0 client credentials (XSUAA on SAP BTP)</option>
          </select>
        </label>
        {/* Basic auth: user and password; OAuth: service key file. */}
        {form.auth === 'basic' ? (
          // Fragment with two fields.
          <>
            {/* User. */}
            <label>User<input {...input('username')} autoComplete="off" /></label>
            {/* Password. */}
            <label>Password
              {/* Password input ('unchanged' when a password is stored). */}
              <input type="password" {...input('password')} autoComplete="new-password"
                     placeholder={initial.hasPassword ? 'unchanged' : ''} />
            </label>
          </>
        ) : (
          // Service key file.
          <label className="span-all">Service key file
            {/* Path of the key file. */}
            <input {...input('keyFile')} className="mono" placeholder="./xsuaa-key.json" />
            {/* How to create the key file (and the binding on SAP BTP). */}
            <small className="muted">Path relative to the server folder. Create the key with <code>cf create-service-key simple-erp-auth-api shop-key</code> and
              save the output of <code>cf service-key simple-erp-auth-api shop-key</code> as JSON. Never commit it.
              On SAP BTP use the service binding instead: <code>vcap:simple-erp-auth-api</code>.</small>
          </label>
        )}
        {/* Integration style (Lab 2). */}
        <label className="span-all">Product data reaches the shop via
          {/* Select box. */}
          <select value={form.integration || 'api'} onChange={e => set('integration', e.target.value)}>
            {/* API: live, orders in the ERP. */}
            <option value="api">API – REST/OData, live (orders are created in the ERP)</option>
            {/* File transfer: CSV files through the transfer folder. */}
            <option value="file">File transfer – the ERP's CSV export via the transfer folder (Lab 2)</option>
          </select>
        </label>
        {/* Demo catalog option. */}
        <label className="check span-all">
          {/* Checkbox. */}
          <input type="checkbox" checked={!!form.autoCatalog} onChange={e => set('autoCatalog', e.target.checked)} />
          {/* Label text. */}
          Create the demo catalog in this ERP automatically (recommended for the local ERP)
        </label>
      </div>
      {/* Result of the last test. */}
      {test && (
        // Green or red result line.
        <p className={`test-result ${test.ok ? 'ok' : 'bad'}`}>
          {/* OK with products and response time, or the error. */}
          {test.ok ? `Connection OK · ${test.erpProducts} products in the ERP · ${test.ms} ms` : `Connection failed: ${test.error}`}
        </p>
      )}
      {/* Error message. */}
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}

/* ---------- one connector ---------- */
// One connector as a card with its facts and buttons.
function ConnectorCard({ c, busy, test, onTest, onActivate, onEdit, onDelete }) {
  // Last sync of the connector.
  const last = c.lastSync;
  // Dot color: only the active connector has a sync state.
  const state = c.active ? (last?.ok === false ? 'bad' : last?.ok ? 'good' : 'idle') : 'idle';
  // The card markup.
  return (
    // Card (highlighted when active).
    <article className={`connector ${c.active ? 'active' : ''}`}>
      {/* Head: icon, name, kind, active badge. */}
      <div className="connector-head">
        {/* Icon. */}
        <span className="connector-icon"><DatabaseIcon /></span>
        {/* Name and kind. */}
        <div className="connector-title">
          {/* Name. */}
          <strong>{c.name}</strong>
          {/* Kind and authentication. */}
          <span className="muted small">{kindLabel(c)} · {authLabel(c)}</span>
        </div>
        {/* Active badge with the sync dot. */}
        {c.active && <span className="active-badge"><span className={`dot ${state}`} /> Active</span>}
      </div>

      {/* Facts. */}
      <dl className="facts compact">
        {/* URL. */}
        <dt>URL</dt><dd className="mono">{c.url}</dd>
        {/* Basic auth: user; OAuth: key file and whether it exists. */}
        {c.auth === 'basic' ? (
          // User (and a hint when no password is stored).
          <><dt>User</dt><dd>{c.username} {c.hasPassword ? '' : <span className="tag">no password</span>}</dd></>
        ) : (
          // Key file path.
          <><dt>Service key</dt><dd><span className="mono">{c.keyFile}</span>{' '}
            {/* Found / missing label. */}
            {c.keyFileFound ? <span className="tag ok">found</span> : <span className="tag bad">file missing</span>}</dd></>
        )}
        {/* Integration style (link to the file transfer tab in file mode). */}
        <dt>Product data</dt><dd>{c.integration === 'file' ? <Link to="/admin/file-transfer">{integrationLabel(c)}</Link> : integrationLabel(c)}</dd>
        {/* Demo catalog setting. */}
        <dt>Demo catalog</dt><dd>{c.autoCatalog ? 'created automatically' : 'manual'}</dd>
        {/* Products and orders of this connector in the shop. */}
        <dt>In the shop</dt><dd>{c.products} products · {c.orders} orders</dd>
        {/* Active connector: last sync. */}
        {c.active && <><dt>Last sync</dt><dd className={last?.ok === false ? 'error' : ''}>{syncText(last)}</dd></>}
      </dl>

      {/* Test result of this card. */}
      {test && (
        // Result line.
        <p className={`test-result ${test.ok ? 'ok' : 'bad'}`}>
          {/* Reachable with products and response time, or the error. */}
          {test.ok ? `Reachable · ${test.erpProducts} products in the ERP · ${test.ms} ms` : test.error}
        </p>
      )}

      {/* Buttons. */}
      <div className="connector-actions">
        {/* Use this ERP (not on the active connector). */}
        {!c.active && (
          // Activates the connector and syncs at once.
          <button className="primary" disabled={!!busy} onClick={onActivate}>{busy === 'activate' ? 'Connecting…' : 'Use this ERP'}</button>
        )}
        {/* Test. */}
        <button disabled={!!busy} onClick={onTest}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        {/* Edit. */}
        <button className="link" onClick={onEdit}>Edit</button>
        {/* Delete (not the active connector). */}
        {!c.active && <button className="link danger" onClick={onDelete}>Delete</button>}
      </div>
    </article>
  );
}

/* ---------- tab ---------- */
// The connectors tab.
export default function SapConnectors() {
  // Notifications.
  const toast = useToast();
  // Connector list (null while loading).
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState({});      // connector id (or 'global') -> action
  const [tests, setTests] = useState({});    // connector id -> test result
  // Connector in the dialog (null = closed).
  const [editing, setEditing] = useState(null);

  // Loads the connectors (GET /api/erp/connectors).
  const load = () => api.connectors().then(l => {
    // Show them.
    setList(l);
    window.dispatchEvent(new Event('sap-connector-changed')); // refreshes the connection chip in the admin header
  // Error message.
  }).catch(e => toast(e.message, 'error'));
  // Load once when the tab opens.
  useEffect(() => { load(); }, []);

  // Runs an action of a card (key = connector id or 'global'), shows errors and reloads the list afterwards.
  const run = async (key, action, fn) => {
    // Mark the button as busy.
    setBusy(b => ({ ...b, [key]: action }));
    try {
      // Run the action.
      return await fn();
    } catch (e) {
      // Error message.
      toast(e.message, 'error');
    } finally {
      // Not busy any more.
      setBusy(b => ({ ...b, [key]: '' }));
      // Reload the list (state, counters, last sync).
      load();
    }
  };

  // Tests a saved connector.
  const test = c => run(c.id, 'test', async () => {
    // POST /api/erp/connectors/:id/test.
    const r = await api.testConnector(c.id);
    // Show the result on the card.
    setTests(t => ({ ...t, [c.id]: r }));
  });

  // Makes a connector the active ERP.
  const activate = c => run(c.id, 'activate', async () => {
    // POST /api/erp/connectors/:id/activate (switches and syncs).
    const r = await api.activateConnector(c.id);
    // File mode: describe the file transfer run.
    if (r.sync.ok && r.sync.mode === 'file') toast(`Shop now uses ${c.name} · ${syncToast(r.sync)[0]}`, syncToast(r.sync)[1]);
    // API mode: number of synced products.
    else if (r.sync.ok) toast(`Shop now uses ${c.name}: ${r.sync.products.received} products synced`, 'success');
    // Switched, but the ERP did not answer.
    else toast(`Switched to ${c.name}, but the ERP is not reachable: ${r.sync.error}`, 'error');
  });

  // Deletes a connector after a confirmation.
  const remove = c => confirm(`Delete the connector "${c.name}"?`) && run(c.id, 'delete', async () => {
    // DELETE /api/erp/connectors/:id.
    await api.deleteConnector(c.id);
    // Message.
    toast(`${c.name} deleted`, 'info');
  });

  // The active connector.
  const active = list?.find(c => c.active);
  // The active connector uses file transfer.
  const fileMode = active?.integration === 'file';

  // Sync now: products and order statuses (or a file transfer run).
  const sync = () => run('global', 'sync', async () => {
    // POST /api/erp/sync.
    const r = await api.erpSync();
    // Result message.
    toast(...syncToast(r));
  });
  // Loads the demo catalog into the ERP after a confirmation.
  const loadCatalog = () => confirm(`Create the demo catalog (14 products) in ${active.name}? Only missing products are created.`) &&
    run('global', 'catalog', async () => {
      // POST /api/erp/load-catalog.
      const r = await api.erpLoadCatalog();
      // Result message.
      toast(`Demo catalog: ${r.created} products created in the ERP, ${r.completed} completed`, 'success');
    });
  // Disconnects the shop from the ERP after a confirmation (standalone mode).
  const disconnect = () => confirm('Disconnect the shop from the ERP? It then runs standalone with its local products and stock.') &&
    run('global', 'disconnect', async () => {
      // POST /api/erp/disconnect.
      await api.disconnectErp();
      // Message.
      toast('Shop runs standalone (no SAP connector)', 'info');
    });

  // Still loading.
  if (!list) return <p className="muted">Loading…</p>;
  // Busy state of the global buttons.
  const g = busy.global;
  // Last sync of the active connector.
  const last = active?.lastSync;

  // The tab markup.
  return (
    // Vertical stack.
    <div className="stack">
      {/* Status card (colored by state). */}
      <section className={`card erp-status ${active ? (last?.ok === false ? 'bad' : 'on') : 'off'}`}>
        {/* Head with the global buttons. */}
        <div className="section-head">
          {/* Title. */}
          <h3>
            {/* Dot. */}
            <span className={`dot ${active ? (last?.ok === false ? 'bad' : last?.ok ? 'good' : 'idle') : 'idle'}`} />
            {/* Connected to ... / none. */}
            {active ? `Shop is connected to ${active.name}` : 'No SAP connector active'}
          </h3>
          {/* Global buttons (only with an active connector). */}
          {active && (
            // Toolbar.
            <div className="toolbar">
              {/* Sync now. */}
              <button className="primary" disabled={!!g} onClick={sync}><SyncIcon /> {g === 'sync' ? 'Syncing…' : 'Sync now'}</button>
              {/* Load the demo catalog. */}
              <button disabled={!!g} onClick={loadCatalog}>{g === 'catalog' ? 'Loading…' : 'Load demo catalog'}</button>
              {/* Disconnect. */}
              <button className="link danger" disabled={!!g} onClick={disconnect}>Disconnect</button>
            </div>
          )}
        </div>
        {/* Explanation of the current mode. */}
        {active ? (
          // Fragment.
          <>
            {/* File transfer or API. */}
            {fileMode ? (
              // File transfer text.
              <p className="muted small">
                {/* Explanation. */}
                Products, prices and stock come from this ERP as <strong>files</strong> (Lab 2): the ERP's export is written into the
                transfer folder and imported by the shop. Orders stay in the shop. Details in <Link to="/admin/file-transfer">File transfer</Link>.
              </p>
            ) : (
              // API text.
              <p className="muted small">
                {/* Explanation. */}
                Products, prices and stock come from this ERP, every checkout creates an order there.
                Synced on start, after switching and every minute.
              </p>
            )}
            {/* The last sync failed: what to start. */}
            {last?.ok === false && (
              // Error line.
              <p className="test-result bad">
                {/* Name and error. */}
                {active.name} is not reachable: {last.error}.{' '}
                {/* Local ERP: cds watch; BTP: the app and HANA. */}
                {/localhost|127\.0\.0\.1/.test(active.url)
                  ? <>Start the Mini-ERP in its folder with <code>cds watch</code>.</>
                  : <>Start the ERP app (and HANA Cloud) in the SAP BTP cockpit.</>}
              </p>
            )}
          </>
        ) : (
          // No connector active.
          <p className="muted small">The shop runs standalone with its local products and stock. Choose an ERP below with “Use this ERP”.</p>
        )}
      </section>

      {/* Connector cards. */}
      <section>
        {/* Head. */}
        <div className="section-head">
          {/* Title with the number of connectors. */}
          <h3>SAP connectors <span className="muted">({list.length})</span></h3>
          {/* Add a connector. */}
          <button className="primary" onClick={() => setEditing({ ...EMPTY })}>Add connector</button>
        </div>
        {/* Grid of cards. */}
        <div className="connector-grid">
          {/* One card per connector. */}
          {list.map(c => (
            // Card with its busy state, test result and actions.
            <ConnectorCard key={c.id} c={c} busy={busy[c.id]} test={tests[c.id]}
                           onTest={() => test(c)} onActivate={() => activate(c)}
                           onEdit={() => setEditing(c)} onDelete={() => remove(c)} />
          ))}
        </div>
      </section>

      {/* Which system is the master of which data. */}
      <section className="card">
        {/* Title. */}
        <h3>What is managed where</h3>
        {/* Scrollable table. */}
        <div className="table-wrap">
          {/* Table. */}
          <table className="table">
            {/* Column titles. */}
            <thead><tr><th>Data</th><th>Master system</th><th>How the shop gets it</th></tr></thead>
            {/* Rows. */}
            <tbody>
              {/* File transfer mode or API mode. */}
              {fileMode ? (
                // File transfer rows.
                <>
                  {/* Products from the ERP's CSV export. */}
                  <tr><td>Products, prices, stock</td><td><span className="tag erp">SAP ERP</span></td><td>CSV export <code>/rest/api/getProducts()</code> → file in <code>transfer/inbox</code> → import (Admin &gt; File transfer); changed only in the ERP</td></tr>
                  {/* Orders stay in the shop. */}
                  <tr><td>Orders</td><td><span className="tag">Shop</span></td><td>Kept in the shop, which reduces its own stock; the next file brings the ERP's stock again</td></tr>
                  {/* Customers only in the shop. */}
                  <tr><td>Customers</td><td><span className="tag">Shop</span></td><td>Only in the shop while file transfer is used</td></tr>
                </>
              ) : (
                // API rows.
                <>
                  {/* Products live through REST. */}
                  <tr><td>Products, prices, stock</td><td><span className="tag erp">SAP ERP</span></td><td>REST <code>/rest/api/products()</code> of the active connector; admin changes are written to the ERP first (OData)</td></tr>
                  {/* Orders created in the ERP. */}
                  <tr><td>Orders</td><td><span className="tag erp">SAP ERP</span></td><td>OData <code>POST /Orders</code> at checkout (the ERP checks and reduces stock); status changes via ERP actions in the ERP the order was created in</td></tr>
                  {/* Customers in shop and ERP. */}
                  <tr><td>Customers</td><td>Shop + ERP</td><td>Found by e-mail or created in the active ERP at registration or the first order</td></tr>
                </>
              )}
              {/* Shop-only data. */}
              <tr><td>Passwords, sessions, cart, categories</td><td><span className="tag">Shop</span></td><td>Only in the shop database (SQLite)</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* The connector dialog, if open. */}
      {editing && <ConnectorForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
